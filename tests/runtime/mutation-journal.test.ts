import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { FileMutationJournal, type JournalEntry } from '../../src/runtime/mutation-journal.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(candidate => rm(candidate, { recursive: true, force: true })));
});

async function journalPath(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'goalie-mutation-journal-'));
  cleanup.push(root);
  return path.join(root, 'mutations.jsonl');
}

function started(operationId: string): JournalEntry {
  return {
    operationId,
    fingerprint: `fingerprint-${operationId}`,
    status: 'started',
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

describe('FileMutationJournal', () => {
  test('durably removes a torn final record before appending', async () => {
    const file = await journalPath();
    const first: JournalEntry = {
      ...started('first'),
      status: 'completed',
      result: { ok: true },
    };
    await writeFile(file, `${JSON.stringify(first)}\n`, { mode: 0o600 });
    await appendFile(file, '{"operationId":"torn"', 'utf8');

    const journal = new FileMutationJournal(file);
    await expect(journal.lookup('first')).resolves.toEqual(first);
    await journal.append(started('second'));

    const records = (await readFile(file, 'utf8'))
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line) as JournalEntry);
    expect(records).toEqual([first, started('second')]);
  });

  test('separates a valid final record that lacked a newline', async () => {
    const file = await journalPath();
    await writeFile(file, JSON.stringify(started('first')), { mode: 0o600 });

    const journal = new FileMutationJournal(file);
    await journal.append(started('second'));

    const records = (await readFile(file, 'utf8'))
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line) as JournalEntry);
    expect(records.map(record => record.operationId)).toEqual(['first', 'second']);
  });

  test('atomically reserves an operation across same-path journal instances', async () => {
    const file = await journalPath();
    const left = new FileMutationJournal(file);
    const right = new FileMutationJournal(file);
    const entry = started('shared');

    const outcomes = await Promise.all([left.reserve(entry), right.reserve(entry)]);
    expect(outcomes.filter(outcome => outcome === undefined)).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome?.operationId === 'shared')).toHaveLength(1);

    const records = (await readFile(file, 'utf8'))
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line) as JournalEntry);
    expect(records).toEqual([entry]);
  });
});
