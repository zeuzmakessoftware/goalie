import { resolve } from 'node:path';
import process from 'node:process';

import { PenaltyLedger } from './ledger.ts';

const ledgerPath = process.argv[2];
if (!ledgerPath) {
  process.stderr.write('Usage: penalty-ledger <shots.jsonl>\n');
  process.exitCode = 1;
} else {
  const standings = await new PenaltyLedger(resolve(ledgerPath)).standings();
  process.stdout.write(`${JSON.stringify(standings)}\n`);
}
