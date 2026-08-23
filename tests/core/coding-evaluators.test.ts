import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CODING_EVALUATOR_DEFINITIONS,
  createCodingEvaluatorRegistry,
  type CodingEvaluatorOptions,
} from '../../src/core/evaluators.js';
import {
  CheckDefinitionSchema,
  type EvaluationRequest,
} from '../../src/core/schemas.js';
import { makeSpec, makeTask } from './fixtures.js';

const FIXED_NOW = '2026-08-22T14:00:00.000Z';
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'goalie-evaluators-'));
  temporaryRoots.push(root);
  return root;
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function request(
  workspaceRoot: string,
  evaluatorId: string,
  config: Record<string, unknown> = {},
  candidate: unknown = null,
): EvaluationRequest {
  return {
    sessionId: 'session:evaluators',
    task: makeTask('task:evaluators', { writeSet: ['**'] }),
    check: CheckDefinitionSchema.parse({
      id: `check:${evaluatorId}`,
      name: evaluatorId,
      evaluatorId,
      criterionIds: ['correctness'],
      config,
    }),
    spec: makeSpec({ workspaceRoot }),
    evidence: [],
    candidate,
  };
}

function options(
  overrides: Partial<CodingEvaluatorOptions> = {},
): CodingEvaluatorOptions {
  return { now: () => FIXED_NOW, ...overrides };
}

describe('V1 coding evaluator registry', () => {
  it('registers an explicit, versioned evaluator for every V1 coding check', () => {
    const registry = createCodingEvaluatorRegistry();
    expect(registry.list()).toEqual(
      [...CODING_EVALUATOR_DEFINITIONS].sort(
        (left, right) => left.id.localeCompare(right.id),
      ),
    );
    expect(registry.list().every(definition => definition.version === '1')).toBe(true);
    expect(registry.has('approved-command@1')).toBe(true);
    expect(registry.has('test@1')).toBe(true);
    expect(registry.has('build@1')).toBe(true);
    expect(registry.has('typecheck@1')).toBe(true);
    expect(registry.has('git-diff@1')).toBe(true);
    expect(registry.has('artifact-hash@1')).toBe(true);
    expect(registry.has('file-hash@1')).toBe(true);
    expect(registry.has('tree-hash@1')).toBe(true);
    expect(registry.has('golden-output@1')).toBe(true);
  });

  it('runs command ids through the safe host callback and emits test evidence', async () => {
    const runner = vi.fn(async input => ({
      commandId: input.commandId,
      exitCode: 0,
      signal: null,
      stdout: '12 tests passed',
      stderr: '',
      durationMs: 42,
      timedOut: false,
      outputTruncated: false,
    }));
    const registry = createCodingEvaluatorRegistry(options({ commandRunner: runner }));
    const evaluation = await registry.evaluate(
      'test@1',
      request('/tmp/goalie-evaluator-command', 'test'),
    );

    expect(evaluation).toMatchObject({ status: 'passed', score: 1 });
    expect(evaluation.criteria).toEqual([
      expect.objectContaining({
        criterionId: 'correctness',
        status: 'passed',
        evidenceIds: [evaluation.evidence[0]?.id],
      }),
    ]);
    expect(evaluation.evidence[0]).toMatchObject({
      kind: 'test',
      source: 'approved-command:test',
      createdAt: FIXED_NOW,
      metadata: { commandId: 'test', exitCode: 0 },
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]?.[0]).toMatchObject({
      commandId: 'test',
      validatedArgs: [],
      workspaceRoot: '/tmp/goalie-evaluator-command',
    });
    expect(runner.mock.calls[0]?.[0]).not.toHaveProperty('executable');
    expect(runner.mock.calls[0]?.[0]).not.toHaveProperty('shell');
  });

  it('fails closed on incomplete command evidence and rejects shell-shaped config', async () => {
    const runner = vi.fn(async input => ({
      commandId: input.commandId,
      exitCode: 0,
      stdout: 'partial',
      stderr: '',
      timedOut: false,
      outputTruncated: true,
    }));
    const registry = createCodingEvaluatorRegistry(options({ commandRunner: runner }));

    const incomplete = await registry.evaluate(
      'build@1',
      request('/tmp/goalie-evaluator-command', 'build'),
    );
    expect(incomplete.status).toBe('failed');
    expect(incomplete.summary).toContain('outputTruncated=true');

    const shellConfig = await registry.evaluate(
      'approved-command@1',
      request('/tmp/goalie-evaluator-command', 'approved-command', {
        commandId: 'build',
        executable: '/bin/sh',
      }),
    );
    expect(shellConfig.status).toBe('error');
    expect(shellConfig.error).toMatch(/unrecognized key|executable/iu);
    expect(runner).toHaveBeenCalledOnce();
  });

  it('hashes and summarizes only the diff returned by the bounded Git provider', async () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1,2 @@',
      '-old',
      '+new',
      '+again',
      '',
    ].join('\n');
    const provider = vi.fn(async () => ({
      diff,
      baseSha: 'base',
      headSha: 'head',
    }));
    const registry = createCodingEvaluatorRegistry(options({ gitDiffProvider: provider }));
    const evaluation = await registry.evaluate(
      'git-diff@1',
      request('/tmp/goalie-evaluator-diff', 'git-diff', {
        expectedSha256: digest(diff),
        allowEmpty: false,
        maxFiles: 1,
        maxAddedLines: 2,
        maxDeletedLines: 1,
      }),
    );

    expect(evaluation.status).toBe('passed');
    expect(evaluation.evidence[0]).toMatchObject({
      kind: 'diff',
      digest: digest(diff),
      content: { files: ['src/a.ts'], additions: 2, deletions: 1 },
    });
    expect(provider).toHaveBeenCalledOnce();

    const overLimit = await registry.evaluate(
      'git-diff@1',
      request('/tmp/goalie-evaluator-diff', 'git-diff', { maxAddedLines: 1 }),
    );
    expect(overLimit.status).toBe('failed');
    expect(overLimit.summary).toContain('2 additions exceeds 1');
  });

  it('computes file and path-sensitive tree hashes without including secrets', async () => {
    const root = await temporaryWorkspace();
    await mkdir(join(root, 'tree', 'nested'), { recursive: true });
    await writeFile(join(root, 'artifact.txt'), 'hello');
    await writeFile(join(root, 'tree', 'a.txt'), 'A');
    await writeFile(join(root, 'tree', 'nested', 'b.txt'), 'B');
    await writeFile(join(root, 'tree', '.env'), 'SECRET=first');

    const registry = createCodingEvaluatorRegistry(options());
    const file = await registry.evaluate(
      'file-hash@1',
      request(root, 'file-hash', {
        path: 'artifact.txt',
        expectedSha256: digest('hello'),
      }),
    );
    expect(file).toMatchObject({
      status: 'passed',
      metadata: { artifactDigest: digest('hello'), mode: 'file' },
    });

    const firstTree = await registry.evaluate(
      'tree-hash@1',
      request(root, 'tree-hash', { path: 'tree' }),
    );
    expect(firstTree.status).toBe('passed');
    expect(firstTree.evidence[0]?.content).toMatchObject({ files: 2, bytes: 2 });

    await writeFile(join(root, 'tree', '.env'), 'SECRET=second-and-longer');
    const secretChanged = await registry.evaluate(
      'tree-hash@1',
      request(root, 'tree-hash', { path: 'tree' }),
    );
    expect(secretChanged.metadata.artifactDigest).toBe(firstTree.metadata.artifactDigest);

    await writeFile(join(root, 'tree', 'nested', 'b.txt'), 'changed');
    const artifactChanged = await registry.evaluate(
      'tree-hash@1',
      request(root, 'tree-hash', { path: 'tree' }),
    );
    expect(artifactChanged.metadata.artifactDigest).not.toBe(firstTree.metadata.artifactDigest);
  });

  it('rejects symlinked artifacts instead of following them', async () => {
    const root = await temporaryWorkspace();
    await mkdir(join(root, 'tree'), { recursive: true });
    await writeFile(join(root, 'outside.txt'), 'outside');
    await symlink(join(root, 'outside.txt'), join(root, 'tree', 'link.txt'));
    const registry = createCodingEvaluatorRegistry(options());
    const evaluation = await registry.evaluate(
      'tree-hash@1',
      request(root, 'tree-hash', { path: 'tree' }),
    );
    expect(evaluation.status).toBe('error');
    expect(evaluation.error).toMatch(/cannot contain symlinks/iu);
  });

  it('performs exact or explicitly normalized golden-output comparisons', async () => {
    const root = await temporaryWorkspace();
    await writeFile(join(root, 'actual.txt'), 'one\r\ntwo\r\n');
    await writeFile(join(root, 'golden.txt'), 'one\ntwo\n');
    const registry = createCodingEvaluatorRegistry(options());

    const exact = await registry.evaluate(
      'golden-output@1',
      request(root, 'golden-output', {
        actualPath: 'actual.txt',
        goldenPath: 'golden.txt',
      }),
    );
    expect(exact.status).toBe('failed');
    expect(exact.summary).toMatch(/mismatch at byte/iu);
    expect(exact.evidence[0]?.content).not.toHaveProperty('actual');
    expect(exact.evidence[0]?.content).not.toHaveProperty('expected');

    const normalized = await registry.evaluate(
      'golden-output@1',
      request(root, 'golden-output', {
        actualPath: 'actual.txt',
        goldenPath: 'golden.txt',
        normalizeLineEndings: true,
      }),
    );
    expect(normalized.status).toBe('passed');

    const candidate = await registry.evaluate(
      'golden-output@1',
      request(root, 'golden-output', {}, { actual: 'score\n', expected: 'score\n' }),
    );
    expect(candidate.status).toBe('passed');
  });
});
