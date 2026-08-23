import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  GENESIS_HASH,
  SessionEventInputSchema,
  SessionEventSchema,
  SessionSnapshotSchema,
  type CoreEventKind,
  type CoreSessionEvent,
  type CoreSessionEventInput,
  type SessionEvent,
  type SessionEventInput,
  type SessionSnapshot,
  type SessionState,
} from './schemas.js';
import {
  createInitialSessionState,
  reduceSession,
} from './reducer.js';
import { parseCoreSessionEvent } from './schemas.js';
import { sanitizeForPersistence } from './sanitize.js';

export class EventStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EventStoreError';
  }
}

export class EventStoreWriterLockedError extends EventStoreError {
  constructor(lockPath: string) {
    super(`A writer already owns the event store lock: ${lockPath}`);
    this.name = 'EventStoreWriterLockedError';
  }
}

export class EventLogCorruptionError extends EventStoreError {
  readonly line: number | undefined;

  constructor(message: string, line?: number, options?: ErrorOptions) {
    super(
      line === undefined ? message : `Event log line ${line}: ${message}`,
      options,
    );
    this.name = 'EventLogCorruptionError';
    this.line = line;
  }
}

export class SnapshotCorruptionError extends EventStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SnapshotCorruptionError';
  }
}

type Canonical =
  | null
  | boolean
  | number
  | string
  | Canonical[]
  | { [key: string]: Canonical };

function canonicalize(value: unknown, seen: Set<object>): Canonical | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Event data cannot contain non-finite numbers');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'bigint') {
    throw new TypeError('Event data cannot contain bigint values');
  }
  if (
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    throw new TypeError(`Event data cannot contain ${typeof value} values`);
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    return { type: 'Buffer', data: value.toString('base64') };
  }
  if (typeof value !== 'object') {
    throw new TypeError('Unsupported event value');
  }
  if (seen.has(value)) {
    throw new TypeError('Event data cannot contain circular references');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, seen) ?? null);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        `Event data must be plain JSON, got ${value.constructor?.name ?? 'object'}`,
      );
    }
    const output: Record<string, Canonical> = {};
    for (const key of Object.keys(value).sort()) {
      const child = canonicalize((value as Record<string, unknown>)[key], seen);
      if (child !== undefined) output[key] = child;
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

/** Stable JSON encoding used by both the hash chain and snapshot checksums. */
export function stableStringify(value: unknown): string {
  const canonical = canonicalize(value, new Set());
  if (canonical === undefined) {
    throw new TypeError('Top-level event data cannot be undefined');
  }
  return JSON.stringify(canonical);
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export type HashableSessionEvent = Omit<SessionEvent, 'hash' | 'payload'> & {
  payload: unknown;
};

export function calculateEventHash(event: HashableSessionEvent): string {
  return sha256Hex(stableStringify(event));
}

function eventWithoutHash(event: SessionEvent): Omit<SessionEvent, 'hash'> {
  const { hash: _hash, ...unsigned } = event;
  return unsigned;
}

export interface EventLogVerification {
  readonly valid: true;
  readonly eventCount: number;
  readonly lastSequence: number;
  readonly lastHash: string;
}

export function verifyEventChain(
  events: readonly SessionEvent[],
  expectedSessionId?: string,
): EventLogVerification {
  let previousHash = GENESIS_HASH;
  let sequence = 0;
  let sessionId = expectedSessionId;

  for (const event of events) {
    sequence += 1;
    if (event.sequence !== sequence) {
      throw new EventLogCorruptionError(
        `expected sequence ${sequence}, got ${event.sequence}`,
        sequence,
      );
    }
    sessionId ??= event.sessionId;
    if (event.sessionId !== sessionId) {
      throw new EventLogCorruptionError(
        `session changed from ${sessionId} to ${event.sessionId}`,
        sequence,
      );
    }
    if (event.previousHash !== previousHash) {
      throw new EventLogCorruptionError(
        'previousHash does not match the preceding event',
        sequence,
      );
    }
    const calculated = calculateEventHash(eventWithoutHash(event));
    if (event.hash !== calculated) {
      throw new EventLogCorruptionError(
        `hash mismatch (expected ${calculated}, got ${event.hash})`,
        sequence,
      );
    }
    previousHash = event.hash;
  }

  return {
    valid: true,
    eventCount: events.length,
    lastSequence: sequence,
    lastHash: previousHash,
  };
}

export interface JsonlEventStoreOptions {
  directory: string;
  sessionId: string;
  writer?: boolean;
  clock?: () => Date;
}

interface WriterLease {
  readonly handle: FileHandle;
  readonly token: string;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}

async function clearStaleWriterLock(lockPath: string): Promise<boolean> {
  let original: string;
  try {
    original = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return true;
    throw error;
  }
  let pid: number;
  try {
    const value = JSON.parse(original) as { pid?: unknown };
    if (typeof value.pid !== 'number') return false;
    pid = value.pid;
  } catch {
    return false;
  }
  if (processIsAlive(pid)) return false;
  // Avoid unlinking a replacement lease if another recovery won the race.
  if ((await readFile(lockPath, 'utf8').catch(() => '')) !== original) return true;
  await unlink(lockPath).catch(error => {
    if (!isNodeError(error, 'ENOENT')) throw error;
  });
  return true;
}

/**
 * A killed append may leave one unterminated tail. A writer must durably remove
 * that tail (or terminate a complete record) before appending, otherwise the
 * next JSON object would be concatenated onto corrupt bytes.
 */
async function repairWriterTail(path: string): Promise<void> {
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  if (data.length === 0 || data.at(-1) === 0x0a) return;
  const lastNewline = data.lastIndexOf(0x0a);
  const tailStart = lastNewline + 1;
  let complete = false;
  try {
    SessionEventSchema.parse(JSON.parse(data.subarray(tailStart).toString('utf8')));
    complete = true;
  } catch {
    complete = false;
  }
  const handle = await open(path, 'r+');
  try {
    if (complete) {
      await handle.write(Buffer.from('\n'), 0, 1, data.length);
    } else {
      await handle.truncate(tailStart);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Append-only session event store. A writer lease is held for the lifetime of a
 * writer instance, while an in-process promise queue preserves call order.
 */
export class JsonlEventStore {
  readonly directory: string;
  readonly sessionId: string;
  readonly eventsPath: string;
  readonly snapshotPath: string;
  readonly lockPath: string;

  private readonly clock: () => Date;
  private readonly writerLease: WriterLease | undefined;
  private tailSequence: number;
  private tailHash: string;
  private appendQueue: Promise<void> = Promise.resolve();
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  private constructor(
    options: JsonlEventStoreOptions,
    writerLease: WriterLease | undefined,
    tailSequence: number,
    tailHash: string,
  ) {
    this.directory = resolve(options.directory);
    this.sessionId = options.sessionId;
    this.eventsPath = join(this.directory, 'events.jsonl');
    this.snapshotPath = join(this.directory, 'snapshot.json');
    this.lockPath = join(this.directory, 'writer.lock');
    this.clock = options.clock ?? (() => new Date());
    this.writerLease = writerLease;
    this.tailSequence = tailSequence;
    this.tailHash = tailHash;
  }

  static async open(options: JsonlEventStoreOptions): Promise<JsonlEventStore> {
    const directory = resolve(options.directory);
    const eventsPath = join(directory, 'events.jsonl');
    const lockPath = join(directory, 'writer.lock');
    let lease: WriterLease | undefined;

    if (options.writer) {
      await mkdir(directory, { recursive: true });
      for (let attempt = 0; attempt < 2 && !lease; attempt += 1) {
        const token = randomUUID();
        let handle: FileHandle | undefined;
        try {
          handle = await open(lockPath, 'wx', 0o600);
          await handle.writeFile(
            stableStringify({ token, pid: process.pid, createdAt: new Date().toISOString() }),
            'utf8',
          );
          await handle.sync();
          lease = { handle, token };
        } catch (error) {
          await handle?.close().catch(() => undefined);
          if (handle) await unlink(lockPath).catch(() => undefined);
          if (isNodeError(error, 'EEXIST') && attempt === 0 && await clearStaleWriterLock(lockPath)) {
            continue;
          }
          if (isNodeError(error, 'EEXIST')) throw new EventStoreWriterLockedError(lockPath);
          throw error;
        }
      }
    }

    try {
      if (lease) await repairWriterTail(eventsPath);
      const events = await readJsonlEvents(eventsPath);
      const verified = verifyEventChain(events, options.sessionId);
      return new JsonlEventStore(
        { ...options, directory },
        lease,
        verified.lastSequence,
        verified.lastHash,
      );
    } catch (error) {
      if (lease) {
        await lease.handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
      throw error;
    }
  }

  get writable(): boolean {
    return this.writerLease !== undefined;
  }

  get lastSequence(): number {
    return this.tailSequence;
  }

  get lastHash(): string {
    return this.tailHash;
  }

  async append<Kind extends CoreEventKind>(
    input: CoreSessionEventInput<Kind>,
  ): Promise<CoreSessionEvent<Kind>>;
  async append(input: SessionEventInput): Promise<SessionEvent>;
  async append(input: SessionEventInput): Promise<SessionEvent> {
    if (!this.writerLease) {
      throw new EventStoreError('This event store was opened read-only');
    }
    if (this.closing || this.closed) {
      throw new EventStoreError('Event store is closing or closed');
    }
    const parsed = SessionEventInputSchema.parse(input);

    let resolveResult!: (event: SessionEvent) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<SessionEvent>((resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise;
      rejectResult = rejectPromise;
    });

    this.appendQueue = this.appendQueue.then(async () => {
      try {
        if (this.closed) throw new EventStoreError('Event store is closed');
        const sequence = this.tailSequence + 1;
        const id = parsed.id ?? randomUUID();
        const payload = sanitizeForPersistence(parsed.payload);
        const payloadTaskId = payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as { taskId?: unknown }).taskId
          : undefined;
        const unsigned = {
          schemaVersion: 1 as const,
          id,
          sessionId: this.sessionId,
          sequence,
          timestamp: parsed.timestamp ?? this.clock().toISOString(),
          causationId: parsed.causationId ?? id,
          ...(parsed.taskId ?? (typeof payloadTaskId === 'string' ? payloadTaskId : undefined)
            ? { taskId: parsed.taskId ?? String(payloadTaskId) }
            : {}),
          kind: parsed.kind,
          payload,
          artifactHashes: parsed.artifactHashes ?? {},
          ...(parsed.actor === undefined ? {} : { actor: parsed.actor }),
          previousHash: this.tailHash,
        } satisfies Omit<SessionEvent, 'hash'>;
        const event = SessionEventSchema.parse({
          ...unsigned,
          hash: calculateEventHash(unsigned),
        });
        const handle = await open(this.eventsPath, 'a', 0o600);
        try {
          await handle.writeFile(`${stableStringify(event)}\n`, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.tailSequence = event.sequence;
        this.tailHash = event.hash;
        resolveResult(event);
      } catch (error) {
        rejectResult(error);
      }
    });

    return result;
  }

  async readEvents(): Promise<SessionEvent[]> {
    const events = await readJsonlEvents(this.eventsPath);
    verifyEventChain(events, this.sessionId);
    return events;
  }

  async verify(): Promise<EventLogVerification> {
    const events = await readJsonlEvents(this.eventsPath);
    return verifyEventChain(events, this.sessionId);
  }

  async writeSnapshot(state: SessionState): Promise<SessionSnapshot> {
    if (!this.writerLease) {
      throw new EventStoreError('This event store was opened read-only');
    }
    if (this.closed) throw new EventStoreError('Event store is closed');
    if (state.sessionId !== this.sessionId) {
      throw new EventStoreError('Snapshot session does not match event store');
    }
    if (
      state.lastSequence !== this.tailSequence ||
      state.lastHash !== this.tailHash
    ) {
      throw new EventStoreError(
        'Snapshot must represent the current verified event-log tail',
      );
    }

    const unsigned = {
      version: 1 as const,
      sessionId: this.sessionId,
      lastSequence: state.lastSequence,
      lastHash: state.lastHash,
      createdAt: this.clock().toISOString(),
      state,
    };
    const snapshot = SessionSnapshotSchema.parse({
      ...unsigned,
      checksum: sha256Hex(stableStringify(unsigned)),
    });
    const temporaryPath = join(
      dirname(this.snapshotPath),
      `.snapshot.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${stableStringify(snapshot)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.snapshotPath);
      const directoryHandle = await open(this.directory, 'r');
      try {
        await directoryHandle.sync().catch((error: unknown) => {
          if (
            !isNodeError(error, 'EINVAL') &&
            !isNodeError(error, 'EBADF') &&
            !isNodeError(error, 'ENOTSUP')
          ) {
            throw error;
          }
        });
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return snapshot;
  }

  async readSnapshot(): Promise<SessionSnapshot | null> {
    let text: string;
    try {
      text = await readFile(this.snapshotPath, 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }

    try {
      const snapshot = SessionSnapshotSchema.parse(JSON.parse(text));
      if (snapshot.sessionId !== this.sessionId) {
        throw new SnapshotCorruptionError('Snapshot session ID does not match');
      }
      const { checksum, ...unsigned } = snapshot;
      const calculated = sha256Hex(stableStringify(unsigned));
      if (checksum !== calculated) {
        throw new SnapshotCorruptionError('Snapshot checksum does not match');
      }
      if (
        snapshot.state.lastSequence !== snapshot.lastSequence ||
        snapshot.state.lastHash !== snapshot.lastHash
      ) {
        throw new SnapshotCorruptionError(
          'Snapshot state cursor does not match its header',
        );
      }
      return snapshot;
    } catch (error) {
      if (error instanceof SnapshotCorruptionError) throw error;
      throw new SnapshotCorruptionError('Snapshot is not valid JSON or schema data', {
        cause: error,
      });
    }
  }

  /**
   * Restore from a verified snapshot when possible, otherwise replay the log.
   * A corrupt/stale snapshot is ignored because it is only a cache; corruption
   * in the JSONL source of truth always fails closed.
   */
  async loadState(): Promise<SessionState> {
    const events = await this.readEvents();
    let snapshot: SessionSnapshot | null = null;
    try {
      snapshot = await this.readSnapshot();
    } catch (error) {
      if (!(error instanceof SnapshotCorruptionError)) throw error;
    }

    if (snapshot && snapshot.lastSequence <= events.length) {
      const eventAtSnapshot =
        snapshot.lastSequence === 0
          ? undefined
          : events[snapshot.lastSequence - 1];
      const matchesChain =
        snapshot.lastSequence === 0
          ? snapshot.lastHash === GENESIS_HASH
          : eventAtSnapshot?.hash === snapshot.lastHash;
      if (matchesChain) {
        return events
          .slice(snapshot.lastSequence)
          .reduce(reduceSession, snapshot.state);
      }
    }

    const first = events[0];
    if (!first) {
      throw new EventStoreError(
        'Cannot reconstruct an empty session without an initial specification',
      );
    }
    let created;
    try {
      created = parseCoreSessionEvent(first);
    } catch (error) {
      throw new EventLogCorruptionError(
        'first event must be a typed session.created event',
        1,
        { cause: error },
      );
    }
    if (created.kind !== 'session.created') {
      throw new EventLogCorruptionError(
        'first event must be session.created',
        1,
      );
    }
    const initial = createInitialSessionState(
      this.sessionId,
      created.payload.spec,
      created.timestamp,
    );
    return events.reduce(reduceSession, initial);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await this.appendQueue;
      this.closed = true;
      const lease = this.writerLease;
      if (!lease) return;
      await lease.handle.close();
      try {
        const lock = JSON.parse(await readFile(this.lockPath, 'utf8')) as {
          token?: unknown;
        };
        if (lock.token === lease.token) await unlink(this.lockPath);
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
    })();
    return this.closePromise;
  }
}

async function readJsonlEvents(path: string): Promise<SessionEvent[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw error;
  }
  if (text.length === 0) return [];
  const hasTrailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const events: SessionEvent[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      throw new EventLogCorruptionError('unexpected blank line', index + 1);
    }
    try {
      events.push(SessionEventSchema.parse(JSON.parse(line)));
    } catch (error) {
      // append()+fsync writes one complete JSONL record. A process kill can leave
      // only the final record torn; every earlier malformed record is tampering.
      if (!hasTrailingNewline && index === lines.length - 1) break;
      throw new EventLogCorruptionError(
        'invalid JSON or event envelope',
        index + 1,
        { cause: error },
      );
    }
  }
  return events;
}
