import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { PenaltyLedger } from '../src/ledger.ts';

const execFileAsync = promisify(execFile);

test('accepts a shot id exactly once under concurrency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'penalty-concurrent-'));
  const path = join(root, 'shots.jsonl');
  const ledgers = Array.from({ length: 24 }, () => new PenaltyLedger(path));
  const shot = { id: 'pk-7', player: 'Henry', outcome: 'save' as const, takenAt: 7 };
  const results = await Promise.all(ledgers.map(ledger => ledger.record(shot)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await new PenaltyLedger(path).replay()).filter(value => value.id === shot.id).length, 1);
});

test('recovers from an interrupted final append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'penalty-crash-'));
  const path = join(root, 'shots.jsonl');
  const ledger = new PenaltyLedger(path);
  await ledger.record({ id: 'valid', player: 'Keller', outcome: 'save', takenAt: 1 });
  await appendFile(path, '{"id":"torn"', 'utf8');
  const replayed = await new PenaltyLedger(path).replay();
  assert.deepEqual(replayed.map(shot => shot.id), ['valid']);
});

test('standings are deterministic under tied scores', async () => {
  const root = await mkdtemp(join(tmpdir(), 'penalty-ranking-'));
  const ledger = new PenaltyLedger(join(root, 'shots.jsonl'));
  await ledger.record({ id: 'b', player: 'Bravo', outcome: 'goal', takenAt: 2 });
  await ledger.record({ id: 'a', player: 'Alpha', outcome: 'goal', takenAt: 1 });
  assert.deepEqual((await ledger.standings()).map(row => row.player), ['Alpha', 'Bravo']);
});

test('CLI output matches the protected golden replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'penalty-golden-'));
  const path = join(root, 'shots.jsonl');
  const ledger = new PenaltyLedger(path);
  await ledger.record({ id: 'b', player: 'Bravo', outcome: 'goal', takenAt: 2 });
  await ledger.record({ id: 'a', player: 'Alpha', outcome: 'goal', takenAt: 1 });
  await ledger.record({ id: 'c', player: 'Keller', outcome: 'save', takenAt: 3 });

  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-strip-types',
    cli,
    path,
  ]);
  assert.equal(
    stdout,
    '[{"player":"Alpha","goals":1,"attempts":1},{"player":"Bravo","goals":1,"attempts":1},{"player":"Keller","goals":0,"attempts":1}]\n',
  );
});
