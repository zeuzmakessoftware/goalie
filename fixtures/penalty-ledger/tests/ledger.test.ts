import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PenaltyLedger } from '../src/ledger.ts';

test('records and replays a shot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'penalty-ledger-'));
  const ledger = new PenaltyLedger(join(root, 'shots.jsonl'));
  assert.equal(await ledger.record({ id: '1', player: 'Keller', outcome: 'save', takenAt: 1 }), true);
  assert.equal((await ledger.replay()).length, 1);
});

test('rejects a sequential duplicate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'penalty-ledger-'));
  const ledger = new PenaltyLedger(join(root, 'shots.jsonl'));
  const shot = { id: '1', player: 'Henry', outcome: 'goal' as const, takenAt: 1 };
  assert.equal(await ledger.record(shot), true);
  assert.equal(await ledger.record(shot), false);
});
