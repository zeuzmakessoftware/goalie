import { access, cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const moduleDir = dirname(fileURLToPath(import.meta.url));

export const PENALTY_LEDGER_GOAL = `Repair the Penalty Ledger so that a shot ID is accepted exactly once under concurrent writers, replay recovers safely from a torn final JSONL record, and tied standings plus CLI output are deterministic. Preserve the public API. Ordinary tests are a baseline; completion requires every protected verifier.`;

export async function createPenaltyLedgerFixture(): Promise<string> {
  const destination = await mkdtemp(join(tmpdir(), 'goalie-penalty-ledger-'));
  const candidates = [
    join(moduleDir, '..', '..', 'fixtures', 'penalty-ledger'),
    join(moduleDir, '..', 'fixtures', 'penalty-ledger'),
  ];
  let source: string | undefined;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      source = candidate;
      break;
    } catch {
      // Try the source-tree and built-package layouts.
    }
  }
  if (!source) throw new Error('The Penalty Ledger fixture is missing from this Goalie installation.');
  await cp(source, destination, { recursive: true });
  await execa('git', ['init', '-q'], { cwd: destination });
  await execa('git', ['config', 'user.email', 'goalie@example.invalid'], { cwd: destination });
  await execa('git', ['config', 'user.name', 'Goalie Demo'], { cwd: destination });
  await execa('git', ['add', '.'], { cwd: destination });
  await execa('git', ['commit', '-qm', 'fixture: broken penalty ledger'], { cwd: destination });
  return destination;
}
