import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { goalieConfigSchema } from '../src/config.js';
import { createKickoffProposal, formatKickoffProposal, resolvedPolicyFingerprint } from '../src/session/kickoff.js';

describe('kickoff proposal', () => {
  it('discovers project checks and snapshots the safety constraints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goalie-kickoff-'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', build: 'tsc' } }));
    const proposal = await createKickoffProposal('Repair the ledger', root, goalieConfigSchema.parse({}));
    expect(proposal.spec.goal).toBe('Repair the ledger');
    expect(proposal.spec.checks.map(check => check.id)).toEqual(['check:test', 'check:build']);
    expect(proposal.tasks[0]?.writeSet).toEqual(['**']);
    expect(proposal.spec.constraints.join(' ')).toContain('untrusted data');
    expect(proposal.spec.metadata.policyFingerprint).toBe(resolvedPolicyFingerprint(goalieConfigSchema.parse({})));
    expect(formatKickoffProposal(proposal)).toContain('env={}');
    expect(formatKickoffProposal(proposal)).toContain('Fallback chain:');
  });

  it('fingerprints command environments and immutable provider policy', () => {
    const baseline = goalieConfigSchema.parse({});
    const changed = goalieConfigSchema.parse({
      ...baseline,
      commands: baseline.commands.map((command, index) => index === 0
        ? { ...command, env: { GOALIE_FIXTURE_MODE: 'strict' } }
        : command),
    });
    expect(resolvedPolicyFingerprint(changed)).not.toBe(resolvedPolicyFingerprint(baseline));
    expect(resolvedPolicyFingerprint({ ...baseline, budget: { ...baseline.budget, maxTurns: 999 } })).toBe(resolvedPolicyFingerprint(baseline));
  });
});
