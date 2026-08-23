import { mkdir, open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export type JournalStatus = 'started' | 'completed' | 'failed';

export interface JournalEntry {
  operationId: string;
  fingerprint: string;
  status: JournalStatus;
  timestamp: string;
  request?: unknown;
  result?: unknown;
  error?: string;
}

export interface MutationJournal {
  lookup(operationId: string): Promise<JournalEntry | undefined>;
  append(entry: JournalEntry): Promise<void>;
  /**
   * Atomically records a new operation boundary when the id is unused. Returns
   * the durable existing entry when another caller already reserved that id.
   */
  reserve?(entry: JournalEntry): Promise<JournalEntry | undefined>;
}

export class MutationInDoubtError extends Error {
  readonly code = 'MUTATION_IN_DOUBT';

  constructor(operationId: string) {
    super(`Mutation ${operationId} started previously but has no durable result.`);
    this.name = 'MutationInDoubtError';
  }
}

export function stableFingerprint(value: unknown): string {
  const seen = new WeakSet<object>();
  const stable = JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object') {
      if (seen.has(item)) throw new TypeError('Cannot fingerprint cyclic values.');
      seen.add(item);
      if (!Array.isArray(item)) {
        return Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        );
      }
    }
    return item;
  });
  return createHash('sha256').update(stable ?? 'undefined').digest('hex');
}

export class InMemoryMutationJournal implements MutationJournal {
  private readonly entries = new Map<string, JournalEntry>();

  async lookup(operationId: string): Promise<JournalEntry | undefined> {
    const entry = this.entries.get(operationId);
    return entry ? structuredClone(entry) : undefined;
  }

  async append(entry: JournalEntry): Promise<void> {
    this.entries.set(entry.operationId, structuredClone(entry));
  }

  async reserve(entry: JournalEntry): Promise<JournalEntry | undefined> {
    const existing = this.entries.get(entry.operationId);
    if (existing) return structuredClone(existing);
    this.entries.set(entry.operationId, structuredClone(entry));
    return undefined;
  }
}

interface SharedFileJournalState {
  readonly entries: Map<string, JournalEntry>;
  loadPromise: Promise<void> | undefined;
  writeTail: Promise<void>;
  truncateTo: number | undefined;
  needsSeparator: boolean;
}

// Multiple brokers for one actor can coexist during provider/tool concurrency.
// Sharing the queue and cache by canonical journal path keeps reservation atomic
// inside the single Goalie host process.
const sharedFileJournals = new Map<string, SharedFileJournalState>();

/** Append-only JSONL journal. Each boundary write is fsynced before returning. */
export class FileMutationJournal implements MutationJournal {
  readonly path: string;
  private readonly state: SharedFileJournalState;

  constructor(inputPath: string) {
    this.path = path.resolve(inputPath);
    const existing = sharedFileJournals.get(this.path);
    if (existing) {
      this.state = existing;
    } else {
      this.state = {
        entries: new Map<string, JournalEntry>(),
        loadPromise: undefined,
        writeTail: Promise.resolve(),
        truncateTo: undefined,
        needsSeparator: false,
      };
      sharedFileJournals.set(this.path, this.state);
    }
  }

  async lookup(operationId: string): Promise<JournalEntry | undefined> {
    await this.load();
    const entry = this.state.entries.get(operationId);
    return entry ? structuredClone(entry) : undefined;
  }

  async append(entry: JournalEntry): Promise<void> {
    await this.load();
    const task = this.enqueueWrite(async () => {
      await this.appendEntry(entry);
      this.state.entries.set(entry.operationId, structuredClone(entry));
    });
    await task;
  }

  async reserve(entry: JournalEntry): Promise<JournalEntry | undefined> {
    await this.load();
    if (entry.status !== 'started') {
      throw new TypeError('Only a started mutation can reserve an operation id.');
    }
    return await this.enqueueWrite(async () => {
      const existing = this.state.entries.get(entry.operationId);
      if (existing) return structuredClone(existing);
      await this.appendEntry(entry);
      this.state.entries.set(entry.operationId, structuredClone(entry));
      return undefined;
    });
  }

  private enqueueWrite<Result>(operation: () => Promise<Result>): Promise<Result> {
    const task = this.state.writeTail.then(operation);
    this.state.writeTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async appendEntry(entry: JournalEntry): Promise<void> {
    await mkdir(path.dirname(this.path), { recursive: true });
    await this.repairTailBeforeAppend();
    const handle = await open(this.path, 'a', 0o600);
    try {
      await handle.chmod(0o600);
      const prefix = this.state.needsSeparator ? '\n' : '';
      await handle.writeFile(`${prefix}${JSON.stringify(entry)}\n`);
      await handle.sync();
      this.state.needsSeparator = false;
    } finally {
      await handle.close();
    }
  }

  private async repairTailBeforeAppend(): Promise<void> {
    const truncateTo = this.state.truncateTo;
    if (truncateTo === undefined) return;
    const handle = await open(this.path, 'r+');
    try {
      await handle.truncate(truncateTo);
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.state.truncateTo = undefined;
    this.state.needsSeparator = false;
  }

  private async load(): Promise<void> {
    if (!this.state.loadPromise) {
      const loading = this.loadFromDisk();
      let tracked: Promise<void>;
      tracked = loading.catch(error => {
        if (this.state.loadPromise === tracked) this.state.loadPromise = undefined;
        throw error;
      });
      this.state.loadPromise = tracked;
    }
    await this.state.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    let contents: Buffer;
    try {
      contents = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    this.state.entries.clear();
    this.state.truncateTo = undefined;
    this.state.needsSeparator = false;
    let lineNumber = 0;
    let offset = 0;
    while (offset < contents.length) {
      lineNumber += 1;
      const newline = contents.indexOf(0x0a, offset);
      const finalWithoutNewline = newline === -1;
      const end = finalWithoutNewline ? contents.length : newline;
      const line = contents.subarray(offset, end).toString('utf8');
      const nextOffset = finalWithoutNewline ? contents.length : end + 1;
      if (!line.trim()) {
        if (finalWithoutNewline) this.state.truncateTo = offset;
        offset = nextOffset;
        continue;
      }
      try {
        const entry = JSON.parse(line) as JournalEntry;
        if (!entry.operationId || !entry.fingerprint || !entry.status) {
          throw new Error('missing required fields');
        }
        this.state.entries.set(entry.operationId, entry);
        if (finalWithoutNewline) this.state.needsSeparator = true;
      } catch (error) {
        if (finalWithoutNewline) {
          this.state.truncateTo = offset;
          return;
        }
        throw new Error(`Mutation journal is corrupt at line ${lineNumber}.`, { cause: error });
      }
      offset = nextOffset;
    }
  }
}
