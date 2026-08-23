import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { createPenaltyLedgerFixture } from '../src/demo/fixture.js';

describe('Penalty Ledger fixture', () => {
  it('passes shallow tests while the protected verifier catches the real gaps', async () => {
    const root = await createPenaltyLedgerFixture();
    const shallow = await execa('node', ['--test', 'tests/ledger.test.ts'], { cwd: root, reject: false });
    const protectedRun = await execa('node', ['--test', 'tests/ledger.test.ts', 'verifiers/crash-and-concurrency.test.ts'], { cwd: root, reject: false });
    expect(shallow.exitCode).toBe(0);
    expect(protectedRun.exitCode).not.toBe(0);
    expect(protectedRun.stdout).toContain('fail 4');
  });
});
