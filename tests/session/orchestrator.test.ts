import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';

import { ScriptedBackend, type ScriptedStep } from '../../src/backends/scripted.js';
import type { AgentBackend, BackendKind, BackendRunRequest } from '../../src/backends/types.js';
import { goalieConfigSchema, type GoalieConfig } from '../../src/config.js';
import { GauntletSpecSchema, TaskSchema } from '../../src/core/schemas.js';
import { ToolBroker } from '../../src/runtime/tool-broker.js';
import { GauntletRunner } from '../../src/session/orchestrator.js';
import type { KickoffProposal } from '../../src/session/kickoff.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function repository(): Promise<{ parent: string; repo: string; session: string; baseSha: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'goalie-orchestrator-'));
  cleanup.push(parent);
  const repo = join(parent, 'repo');
  const session = join(parent, 'session');
  await mkdir(repo);
  await mkdir(session);
  await writeFile(join(repo, 'README.md'), 'base\n');
  await execa('git', ['init', '-q'], { cwd: repo });
  await execa('git', ['config', 'user.email', 'goalie-test@example.invalid'], { cwd: repo });
  await execa('git', ['config', 'user.name', 'Goalie Test'], { cwd: repo });
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['commit', '-qm', 'base'], { cwd: repo });
  const baseSha = (await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  return { parent, repo, session, baseSha };
}

function proposal(repo: string, maxTurns = 20, maxWallTimeMs?: number): KickoffProposal {
  const now = new Date().toISOString();
  const spec = GauntletSpecSchema.parse({
    version: 1,
    goal: 'Create feature.txt with verified content.',
    qualityBar: {
      description: 'The requested file is present and reviewable.',
      criteria: [{ id: 'correctness', description: 'The implementation is correct.', required: true, weight: 1 }],
      references: [],
      blindComparison: false,
    },
    constraints: ['Use only brokered tools.'],
    checks: [],
    budget: {
      maxTurns,
      ...(maxWallTimeMs !== undefined ? { maxWallTimeMs } : {}),
      maxConcurrency: 3,
      plateau: { window: 3, minImprovement: 0.02 },
    },
    workspaceRoot: repo,
    metadata: {},
  });
  const task = TaskSchema.parse({
    id: 'task:feature',
    title: 'Feature',
    objective: 'Create feature.txt.',
    dependencies: [],
    writeSet: ['feature.txt'],
    checkIds: [],
    status: 'ready',
    priority: 1,
    required: true,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    metadata: {},
  });
  return { spec, tasks: [task], providerSummary: 'scripted test lineup', warnings: [] };
}

function managerPlannedProposal(repo: string, maxTurns: number): KickoffProposal {
  const base = proposal(repo, maxTurns);
  return {
    ...base,
    spec: GauntletSpecSchema.parse({
      ...base.spec,
      metadata: {
        ...base.spec.metadata,
        managerPlanSummary: 'Use the confirmed kickoff DAG and keep feature.txt narrowly scoped.',
        taskDag: base.tasks.map(task => ({
          id: task.id,
          dependencies: task.dependencies,
          writeSet: task.writeSet,
        })),
        kickoffPlanning: {
          provider: 'scripted',
          backend: 'scripted',
          model: 'deterministic-script',
          version: 'test',
          turns: 2,
          inputTokens: 11,
          outputTokens: 7,
          reportableCostUsd: 0.42,
          costKnown: true,
          sessionRefs: ['kickoff-plan:1', 'kickoff-plan:2'],
          planHash: 'a'.repeat(64),
        },
      },
    }),
  };
}

function multiLaneProposal(repo: string, maxTurns = 40): KickoffProposal {
  const now = new Date().toISOString();
  const spec = GauntletSpecSchema.parse({
    version: 1,
    goal: 'Complete three dependency-aware feature lanes.',
    qualityBar: {
      description: 'Every scheduled lane produces its committed artifact.',
      criteria: [{ id: 'correctness', description: 'The implementation is correct.', required: true, weight: 1 }],
      references: [],
      blindComparison: false,
    },
    constraints: ['Use only brokered tools.'],
    checks: [],
    budget: { maxTurns, maxConcurrency: 3, plateau: { window: 3, minImprovement: 0.02 } },
    workspaceRoot: repo,
    metadata: {},
  });
  const task = (id: string, priority: number, writeSet: string[]) => TaskSchema.parse({
    id,
    title: id,
    objective: `Produce the artifact for ${id}.`,
    dependencies: [],
    writeSet,
    checkIds: [],
    status: 'ready',
    priority,
    required: true,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    metadata: {},
  });
  return {
    spec,
    tasks: [
      task('task:a', 30, ['shared/a.txt', 'shared/c.txt']),
      task('task:b', 20, ['other/b.txt']),
      // This is independent in the DAG but overlaps task:a's write set, so it
      // must wait for the next deterministic wave.
      task('task:c', 10, ['shared/c.txt']),
    ],
    providerSummary: 'scripted multi-lane lineup',
    warnings: [],
  };
}

function integrationRegressionProposal(repo: string): KickoffProposal {
  const now = new Date().toISOString();
  const checkId = 'integration-contract';
  const spec = GauntletSpecSchema.parse({
    version: 1,
    goal: 'Produce two lane artifacts that remain valid when integrated.',
    qualityBar: {
      description: 'The combined artifact passes its mandatory integration contract.',
      criteria: [{ id: 'correctness', description: 'The implementation is correct.', required: true, weight: 1 }],
      references: [],
      blindComparison: false,
    },
    constraints: ['Use only brokered tools.'],
    checks: [{
      id: checkId,
      name: 'Integration contract',
      description: 'When both lane artifacts exist, the integration marker must exist too.',
      evaluatorId: 'approved-command',
      criterionIds: ['correctness'],
      required: true,
      config: { commandId: checkId },
    }],
    budget: { maxTurns: 30, maxConcurrency: 2, plateau: { window: 3, minImprovement: 0.02 } },
    workspaceRoot: repo,
    metadata: {},
  });
  const task = (id: string, path: string) => TaskSchema.parse({
    id,
    title: id,
    objective: `Create ${path}.`,
    dependencies: [],
    writeSet: [path],
    checkIds: [checkId],
    status: 'ready',
    priority: 1,
    required: true,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    metadata: {},
  });
  return {
    spec,
    tasks: [task('task:left', 'left.txt'), task('task:right', 'right.txt')],
    providerSummary: 'scripted integration-regression lineup',
    warnings: [],
  };
}

function omittedRequiredCheckProposal(repo: string): KickoffProposal {
  const base = proposal(repo, 3);
  return {
    ...base,
    spec: GauntletSpecSchema.parse({
      ...base.spec,
      checks: [{
        id: 'omitted-contract',
        name: 'Omitted integration contract',
        description: 'A required immutable check that no task is allowed to erase.',
        evaluatorId: 'approved-command',
        criterionIds: ['correctness'],
        required: true,
        config: { commandId: 'omitted-contract' },
      }],
      budget: { ...base.spec.budget, maxTurns: 3 },
      metadata: {
        ...base.spec.metadata,
        managerPlanSummary: 'Use the already-confirmed test DAG.',
      },
    }),
    // Deliberately leave the required spec check out of every task. The final
    // integration gate must still execute it.
    tasks: base.tasks.map(task => TaskSchema.parse({ ...task, checkIds: [] })),
  };
}

function lowerBoundCostProposal(repo: string): KickoffProposal {
  const base = proposal(repo, 20);
  return {
    ...base,
    spec: GauntletSpecSchema.parse({
      ...base.spec,
      budget: { ...base.spec.budget, maxCostUsd: 1 },
      metadata: {
        ...base.spec.metadata,
        managerPlanSummary: 'Use the already-confirmed cost-bound test DAG.',
      },
    }),
  };
}

function config(maxTurns = 20): GoalieConfig {
  return goalieConfigSchema.parse({
    providers: { manager: 'scripted', builder: 'scripted', critic: 'scripted', integrator: 'scripted', fallback: ['scripted'] },
    budget: { maxMinutes: 10, maxTurns, maxCostUsd: 10, concurrency: 3, plateauCycles: 3 },
    commands: [],
    allowDegradedCritic: true,
  });
}

function backend(): ScriptedBackend {
  let patched = false;
  return new ScriptedBackend(request => {
    if (request.role === 'worker') {
      const steps: ScriptedStep[] = [];
      if (!patched) {
        patched = true;
        steps.push({
          type: 'tool',
          callId: 'patch-feature',
          name: 'apply_patch',
          input: {
            operationId: 'create-feature',
            operations: [{ type: 'write', path: 'feature.txt', content: 'clean sheet\n', expectedSha256: null }],
          },
        });
      }
      steps.push({ type: 'event', event: { type: 'terminal', status: 'completed', rawReason: 'scripted-worker' } });
      return steps;
    }
    if (request.role === 'critic' || request.role === 'auditor') {
      return [{
        type: 'event',
        event: {
          type: 'terminal',
          status: 'completed',
          rawReason: 'scripted-review',
          structuredOutput: {
            overall: 'pass',
            score: 100,
            confidence: 1,
            criteria: [{ id: 'correctness', status: 'passed', evidenceIds: [], rationale: 'The committed diff satisfies the contract.' }],
            summary: 'Pass.',
          },
        },
      }];
    }
    return [{ type: 'event', event: { type: 'terminal', status: 'completed', rawReason: 'scripted-manager' } }];
  });
}

function remappedBackend(
  kind: BackendKind,
  createScript: (request: BackendRunRequest) => readonly ScriptedStep[] | Promise<readonly ScriptedStep[]>,
): AgentBackend {
  const delegate = new ScriptedBackend(createScript);
  return {
    id: kind,
    kind,
    capabilities: delegate.capabilities,
    availability: () => delegate.availability(),
    isAvailable: () => delegate.isAvailable(),
    run: (request, broker, signal) => delegate.run(request, broker, signal),
  };
}

function observingBackend(delegate: AgentBackend, requests: BackendRunRequest[]): AgentBackend {
  return {
    id: delegate.id,
    kind: delegate.kind,
    capabilities: delegate.capabilities,
    availability: () => delegate.availability(),
    isAvailable: () => delegate.isAvailable(),
    run(request, broker, signal) {
      requests.push(request);
      return delegate.run(request, broker, signal);
    },
  };
}

describe('GauntletRunner integration', () => {
  it('builds evidence-only review context from only the applicable immutable criterion subset', async () => {
    const fixture = await repository();
    const base = proposal(fixture.repo);
    const spec = GauntletSpecSchema.parse({
      ...base.spec,
      goal: 'A global goal that must not leak into the blinded reviewer prompt.',
      qualityBar: {
        description: 'Scoped review bar.',
        references: ['reference://untrusted-fixture'],
        blindComparison: true,
        criteria: [
          { id: 'correctness', description: 'Correct observable behavior.', required: true, weight: 2 },
          { id: 'aesthetics', description: 'Visual polish for a different lane.', required: true, weight: 1 },
          { id: 'scope', description: 'No authority expansion.', required: true, weight: 1 },
        ],
      },
      checks: [
        { id: 'check:correctness', name: 'Correctness', evaluatorId: 'approved-command', criterionIds: ['correctness'], required: true, config: {} },
        { id: 'check:aesthetics', name: 'Aesthetics', evaluatorId: 'approved-command', criterionIds: ['aesthetics'], required: true, config: {} },
      ],
    });
    const task = TaskSchema.parse({ ...base.tasks[0]!, checkIds: ['check:correctness'] });
    const runner = new GauntletRunner({
      sessionId: 'review-isolation',
      sessionDirectory: fixture.session,
      sourceWorkspace: fixture.repo,
      baseSha: fixture.baseSha,
      proposal: { ...base, spec, tasks: [task] },
      config: config(),
      backends: {},
    });
    const internals = runner as unknown as {
      criterionSubset(candidate: typeof task): Array<{ id: string }>;
      criticPrompt(candidate: typeof task, evidence: unknown[], diff: string): string;
      reviewContextPath(actorId: string): Promise<string>;
    };

    expect(internals.criterionSubset(task).map(item => item.id)).toEqual(['correctness', 'scope']);
    const prompt = internals.criticPrompt(task, [], 'diff --git a/a.ts b/a.ts\n+untrusted');
    expect(prompt).toContain('reference://untrusted-fixture');
    expect(prompt).toContain('Anonymous candidate diff SHA-256:');
    expect(prompt).toContain('Correct observable behavior.');
    expect(prompt).toContain('No authority expansion.');
    expect(prompt).not.toContain('Visual polish for a different lane.');
    expect(prompt).not.toContain(spec.goal);
    expect(prompt).toContain('You have no repository, filesystem, network, mutation, or command authority.');

    const context = await internals.reviewContextPath('critic:task:1');
    expect(context.startsWith(join(fixture.session, 'review-contexts'))).toBe(true);
    expect(context.startsWith(fixture.repo)).toBe(false);
    expect(await readdir(context)).toEqual([]);
  });

  it('redacts and terminal-sanitizes verifier output before it can become critic evidence', async () => {
    const fixture = await repository();
    const base = proposal(fixture.repo);
    const checkId = 'check:redaction';
    const spec = GauntletSpecSchema.parse({
      ...base.spec,
      checks: [{
        id: checkId,
        name: 'Redaction probe',
        description: 'Verifier output remains safe for downstream review.',
        evaluatorId: 'approved-command',
        criterionIds: ['correctness'],
        required: true,
        config: { commandId: 'redaction-probe' },
      }],
    });
    const task = TaskSchema.parse({ ...base.tasks[0]!, checkIds: [checkId] });
    const configuredSecret = 'literal-command-secret';
    const runner = new GauntletRunner({
      sessionId: 'evidence-redaction',
      sessionDirectory: fixture.session,
      sourceWorkspace: fixture.repo,
      baseSha: fixture.baseSha,
      proposal: { ...base, spec, tasks: [task] },
      config: goalieConfigSchema.parse({
        ...config(),
        commands: [{
          id: 'redaction-probe',
          executable: process.execPath,
          args: [],
          allowedArgs: [],
          cwd: '.',
          timeoutMs: 1_000,
          network: false,
          mutating: false,
          env: { GOALIE_TEST_SECRET: configuredSecret },
        }],
      }),
      backends: {},
    });
    const appended: Array<{ kind: string; payload: unknown }> = [];
    const internals = runner as unknown as {
      append(input: { kind: string; payload: unknown }): Promise<unknown>;
      runChecks(candidate: typeof task, broker: ToolBroker): Promise<{
        allPassed: boolean;
        evidence: Array<{ summary: string }>;
      }>;
    };
    internals.append = async input => {
      appended.push(input);
      return {};
    };
    const broker = {
      runCheck: vi.fn().mockResolvedValue({
        commandId: 'redaction-probe',
        exitCode: 0,
        signal: null,
        stdout: `ok ${configuredSecret} sk-testtoken123456789 \u001b]8;;https://attacker.invalid\u0007link`,
        stderr: '',
        durationMs: 1,
        timedOut: false,
        outputTruncated: false,
      }),
    } as unknown as ToolBroker;

    const checked = await internals.runChecks(task, broker);
    expect(checked.allPassed).toBe(true);
    expect(checked.evidence[0]?.summary).toContain('[REDACTED]');
    expect(checked.evidence[0]?.summary).not.toContain(configuredSecret);
    expect(checked.evidence[0]?.summary).not.toContain('sk-testtoken123456789');
    expect(checked.evidence[0]?.summary).not.toContain('\u001b');
    expect(JSON.stringify(appended)).not.toContain(configuredSecret);
    expect(JSON.stringify(appended)).not.toContain('sk-testtoken123456789');
  });

  it('achieves only after a brokered patch, checkpoint, verdict, integration, and audit', async () => {
    const fixture = await repository();
    const scripted = backend();
    const runner = new GauntletRunner({
      sessionId: 'integration-test',
      sessionDirectory: fixture.session,
      sourceWorkspace: fixture.repo,
      baseSha: fixture.baseSha,
      proposal: proposal(fixture.repo),
      config: config(),
      backends: { scripted },
    });

    const result = await runner.run();
    expect(result.state.status).toBe('achieved');
    expect(await readFile(join(result.integration.path, 'feature.txt'), 'utf8')).toBe('clean sheet\n');
    expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: fixture.repo })).stdout.trim()).toBe(fixture.baseSha);
    const events = (await readFile(result.eventsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string });
    expect(events.map(event => event.kind)).toEqual(expect.arrayContaining([
      'workspace.checkpoint',
      'critic.verdict_recorded',
      'workspace.integration_checkpoint',
      'audit.verdict',
    ]));
  });

  it('resumes from exact durable worktree heads after a budget pause', async () => {
    const fixture = await repository();
    const firstBackend = backend();
    const first = await new GauntletRunner({
      sessionId: 'resume-test',
      sessionDirectory: fixture.session,
      sourceWorkspace: fixture.repo,
      baseSha: fixture.baseSha,
      proposal: proposal(fixture.repo, 3),
      config: config(3),
      backends: { scripted: firstBackend },
    }).run();
    expect(first.state.status).toBe('paused_budget');

    const resumed = await new GauntletRunner({
      sessionId: 'resume-test',
      sessionDirectory: fixture.session,
      sourceWorkspace: fixture.repo,
      baseSha: fixture.baseSha,
      proposal: proposal(fixture.repo, 20),
      config: config(20),
      backends: { scripted: backend() },
      resume: true,
    }).run();
    expect(resumed.state.status).toBe('achieved');
    expect(resumed.state.spec.budget.maxTurns).toBe(20);
    expect(await readFile(join(resumed.integration.path, 'feature.txt'), 'utf8')).toBe('clean sheet\n');
    const resumedEvents = (await readFile(resumed.eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
    expect(resumedEvents).toContainEqual(expect.objectContaining({
      kind: 'independence.degraded',
      payload: expect.objectContaining({ phase: 'integration', builders: ['scripted'], auditor: 'scripted' }),
    }));
  });

  it('accounts the kickoff manager receipt once and reuses its strategy across resume', async () => {
    const fixture = await repository();
    const firstRequests: BackendRunRequest[] = [];
    const first = await new GauntletRunner({
      sessionId: 'manager-planning-receipt-test',
      sessionDirectory: fixture.session,
      sourceWorkspace: fixture.repo,
      baseSha: fixture.baseSha,
      proposal: managerPlannedProposal(fixture.repo, 4),
      config: config(4),
      backends: { scripted: observingBackend(backend(), firstRequests) },
    }).run();

    expect(first.state.status).toBe('paused_budget');
    expect(firstRequests.map(request => request.role)).toEqual(['worker', 'critic']);
    expect(firstRequests[0]?.prompt).toContain('Use the confirmed kickoff DAG');
    expect(first.state.budget).toMatchObject({
      turns: 4,
      inputTokens: 11,
      outputTokens: 7,
      reportedCostUsd: 0.42,
      // The kickoff price is known, but the two scripted runtime turns did
      // not report price data and therefore cannot be represented as $0.
      costKnown: false,
    });

    const resumedRequests: BackendRunRequest[] = [];
    const resumed = await new GauntletRunner({
      sessionId: 'manager-planning-receipt-test',
      sessionDirectory: fixture.session,
      sourceWorkspace: fixture.repo,
      baseSha: fixture.baseSha,
      proposal: managerPlannedProposal(fixture.repo, 10),
      config: config(10),
      backends: { scripted: observingBackend(backend(), resumedRequests) },
      resume: true,
    }).run();

    expect(resumed.state.status).toBe('achieved');
    expect(resumedRequests.map(request => request.role)).toEqual(['auditor']);
    expect(resumed.state.budget).toMatchObject({
      turns: 5,
      inputTokens: 11,
      outputTokens: 7,
      reportedCostUsd: 0.42,
      costKnown: false,
    });
    const events = (await readFile(resumed.eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
    expect(events.filter(event => event.kind === 'kickoff.planning_accounted')).toHaveLength(1);
    expect(events.filter(event => event.kind === 'provider.turn_reserved')).toHaveLength(3);
  });

  it('checkpoints a dirty lane on wall expiry and resumes from the clean checkpoint', async () => {
    const fixture = await repository();
    let notifyMutation!: () => void;
    const mutationFinished = new Promise<void>(resolve => {
      notifyMutation = resolve;
    });
    const interrupting: AgentBackend = {
      id: 'scripted',
      kind: 'scripted',
      capabilities: new ScriptedBackend(() => []).capabilities,
      availability: async () => ({ available: true, version: 'interrupting-test' }),
      isAvailable: async () => true,
      async *run(request, broker, signal) {
        yield {
          type: 'session_started',
          session: { backend: 'scripted', id: `interrupting:${request.runId}` },
        };
        if (request.role !== 'worker') {
          yield { type: 'terminal', status: 'completed' };
          return;
        }
        const input = {
          operationId: 'wall-expiry-mutation',
          operations: [{
            type: 'write' as const,
            path: 'feature.txt',
            content: 'interrupted clean sheet\n',
            expectedSha256: null,
          }],
        };
        yield { type: 'tool_requested', callId: 'wall-patch', name: 'apply_patch', input };
        const output = await broker.invoke('apply_patch', input, signal);
        yield { type: 'tool_completed', callId: 'wall-patch', name: 'apply_patch', output, isError: false };
        notifyMutation();
        await new Promise<void>(resolve => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'terminal', status: 'cancelled', rawReason: 'wall-expired' };
      },
    };

    vi.useFakeTimers();
    let interrupted: Awaited<ReturnType<GauntletRunner['run']>>;
    try {
      const running = new GauntletRunner({
        sessionId: 'wall-expiry-resume-test',
        sessionDirectory: fixture.session,
        sourceWorkspace: fixture.repo,
        baseSha: fixture.baseSha,
        proposal: proposal(fixture.repo, 20, 1_000),
        config: config(20),
        backends: { scripted: interrupting },
      }).run();
      await mutationFinished;
      await vi.advanceTimersByTimeAsync(1_000);
      interrupted = await running;
    } finally {
      vi.useRealTimers();
    }

    expect(interrupted.state.status).toBe('paused_budget');
    const interruptedEvents = (await readFile(interrupted.eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
    expect(interruptedEvents).toContainEqual(expect.objectContaining({
      kind: 'workspace.checkpoint',
      payload: expect.objectContaining({
        taskId: 'task:feature',
        interrupted: true,
        interruptionReason: 'wall_budget',
        changedPaths: ['feature.txt'],
      }),
    }));

    const resumed = await new GauntletRunner({
      sessionId: 'wall-expiry-resume-test',
      sessionDirectory: fixture.session,
      sourceWorkspace: fixture.repo,
      baseSha: fixture.baseSha,
      proposal: proposal(fixture.repo, 30),
      config: config(30),
      backends: { scripted: backend() },
      resume: true,
    }).run();
    expect(resumed.state.status).toBe('achieved');
    expect(await readFile(join(resumed.integration.path, 'feature.txt'), 'utf8')).toBe('interrupted clean sheet\n');
  });

  it('overlaps disjoint lanes and serializes an overlapping lane into the next wave', async () => {
    const fixture = await repository();
    let activeWorkers = 0;
    let maximumActiveWorkers = 0;
    let releaseConcurrentWorkers!: () => void;
    const concurrentWorkersStarted = new Promise<void>(resolve => {
      releaseConcurrentWorkers = resolve;
    });
    const scripted = new ScriptedBackend(async request => {
      if (request.role === 'worker') {
        activeWorkers += 1;
        maximumActiveWorkers = Math.max(maximumActiveWorkers, activeWorkers);
        if (activeWorkers === 2) releaseConcurrentWorkers();
        // A barrier proves overlap without relying on a 100 ms sleep that can
        // elapse while durable fsyncs contend under a parallel CI run.
        await Promise.race([
          concurrentWorkersStarted,
          new Promise(resolve => setTimeout(resolve, 3_000)),
        ]);
        activeWorkers -= 1;
        const taskId = request.actorId.replace(/^worker:/u, '');
        const path = taskId === 'task:a'
          ? 'shared/a.txt'
          : taskId === 'task:b'
            ? 'other/b.txt'
            : 'shared/c.txt';
        return [
          {
            type: 'tool',
            callId: `patch-${taskId}`,
            name: 'apply_patch',
            input: {
              operationId: `create-${taskId}`,
              operations: [{ type: 'write', path, content: `${taskId}\n`, expectedSha256: null }],
            },
          },
          { type: 'event', event: { type: 'terminal', status: 'completed', rawReason: 'scripted-worker' } },
        ];
      }
      if (request.role === 'critic' || request.role === 'auditor') {
        return [{
          type: 'event',
          event: {
            type: 'terminal',
            status: 'completed',
            rawReason: 'scripted-review',
            structuredOutput: {
              overall: 'pass',
              score: 100,
              confidence: 1,
              criteria: [{ id: 'correctness', status: 'passed', evidenceIds: [], rationale: 'The lane artifact is present.' }],
              summary: 'Pass.',
            },
          },
        }];
      }
      return [{ type: 'event', event: { type: 'terminal', status: 'completed', rawReason: 'scripted-manager' } }];
    });
    const runner = new GauntletRunner({
      sessionId: 'multi-lane-test',
      sessionDirectory: fixture.session,
      sourceWorkspace: fixture.repo,
      baseSha: fixture.baseSha,
      proposal: multiLaneProposal(fixture.repo),
      config: config(40),
      backends: { scripted },
    });

    const result = await runner.run();
    expect(result.state.status).toBe('achieved');
    expect(maximumActiveWorkers).toBe(2);
    expect(await readFile(join(result.integration.path, 'shared/a.txt'), 'utf8')).toBe('task:a\n');
    expect(await readFile(join(result.integration.path, 'other/b.txt'), 'utf8')).toBe('task:b\n');
    expect(await readFile(join(result.integration.path, 'shared/c.txt'), 'utf8')).toBe('task:c\n');
    const events = (await readFile(result.eventsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
    const waves = events
      .filter(event => event.kind === 'workspace.wave_started')
      .map(event => event.payload.taskIds);
    expect(waves).toEqual([['task:a', 'task:b'], ['task:c']]);
  });

  it('normalizes a contradictory final pass, repairs, and plateaus without ever achieving', async () => {
    const fixture = await repository();
    let patched = false;
    const scripted = new ScriptedBackend(request => {
      if (request.role === 'worker') {
        const steps: ScriptedStep[] = [];
        if (!patched) {
          patched = true;
          steps.push({
            type: 'tool',
            callId: 'patch-adversarial',
            name: 'apply_patch',
            input: {
              operationId: 'create-adversarial-feature',
              operations: [{ type: 'write', path: 'feature.txt', content: 'clean sheet\n', expectedSha256: null }],
            },
          });
        }
        steps.push({ type: 'event', event: { type: 'terminal', status: 'completed' } });
        return steps;
      }
      if (request.role === 'critic') {
        return [{
          type: 'event',
          event: {
            type: 'terminal',
            status: 'completed',
            structuredOutput: {
              overall: 'pass',
              score: 100,
              confidence: 1,
              criteria: [{ id: 'correctness', status: 'passed', evidenceIds: [], rationale: 'The lane passes.' }],
            },
          },
        }];
      }
      if (request.role === 'auditor') {
        return [{
          type: 'event',
          event: {
            type: 'terminal',
            status: 'completed',
            structuredOutput: {
              overall: 'pass',
              score: 100,
              confidence: 1,
              criteria: [{ id: 'correctness', status: 'failed', evidenceIds: [], rationale: 'A required gap remains.' }],
              summary: 'Contradictory top-level pass.',
            },
          },
        }];
      }
      return [{ type: 'event', event: { type: 'terminal', status: 'completed' } }];
    });
    const result = await new GauntletRunner({
      sessionId: 'adversarial-audit-test',
      sessionDirectory: fixture.session,
      sourceWorkspace: fixture.repo,
      baseSha: fixture.baseSha,
      proposal: proposal(fixture.repo),
      config: config(),
      backends: { scripted },
    }).run();

    expect(result.state.status).toBe('paused_plateau');
    const events = (await readFile(result.eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
    const audit = events.find(event => event.kind === 'audit.verdict');
    expect(audit?.payload).toMatchObject({
      overall: 'fail',
      hardChecksPassed: true,
      raw: { overall: 'pass' },
      normalized: {
        overall: 'fail',
        metadata: { requiredCriteriaPassed: false },
      },
    });
    expect(events).not.toContainEqual(expect.objectContaining({
      kind: 'session.status_changed',
      payload: expect.objectContaining({ status: 'achieved' }),
    }));
    expect(events.filter(event => event.kind === 'integration.repair_started')).toHaveLength(2);
    expect(events.filter(event => event.kind === 'audit.verdict')).toHaveLength(3);
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'workspace.integration_checkpoint',
      payload: expect.objectContaining({ taskId: 'integration:repair:1', phase: 'completed' }),
    }));
  });

  it('checkpoints an integration repair and requires a fresh passing audit', async () => {
    const fixture = await repository();
    const requests: BackendRunRequest[] = [];
    let lanePatched = false;
    let auditCount = 0;
    const scripted = new ScriptedBackend(request => {
      requests.push(request);
      if (request.role === 'worker' && request.actorId.startsWith('integrator:')) {
        return [
          {
            type: 'tool',
            callId: 'patch-integration-audit-gap',
            name: 'apply_patch',
            input: {
              operationId: 'close-integration-audit-gap',
              operations: [{ type: 'write', path: 'audit-marker.txt', content: 'independently reviewable\n', expectedSha256: null }],
            },
          },
          { type: 'event', event: { type: 'terminal', status: 'completed' } },
        ];
      }
      if (request.role === 'worker') {
        const steps: ScriptedStep[] = [];
        if (!lanePatched) {
          lanePatched = true;
          steps.push({
            type: 'tool',
            callId: 'patch-feature-before-integration-repair',
            name: 'apply_patch',
            input: {
              operationId: 'create-feature-before-integration-repair',
              operations: [{ type: 'write', path: 'feature.txt', content: 'clean sheet\n', expectedSha256: null }],
            },
          });
        }
        steps.push({ type: 'event', event: { type: 'terminal', status: 'completed' } });
        return steps;
      }
      if (request.role === 'critic') {
        return [{
          type: 'event',
          event: {
            type: 'terminal',
            status: 'completed',
            structuredOutput: {
              overall: 'pass',
              score: 100,
              confidence: 1,
              criteria: [{ id: 'correctness', status: 'passed', evidenceIds: [], rationale: 'The lane passes.' }],
            },
          },
        }];
      }
      if (request.role === 'auditor') {
        auditCount += 1;
        const passed = auditCount > 1;
        return [{
          type: 'event',
          event: {
            type: 'terminal',
            status: 'completed',
            structuredOutput: {
              overall: passed ? 'pass' : 'fail',
              score: passed ? 100 : 40,
              confidence: 1,
              criteria: [{
                id: 'correctness',
                status: passed ? 'passed' : 'failed',
                evidenceIds: [],
                rationale: passed ? 'The repair closes the gap.' : 'The final artifact needs an audit marker.',
              }],
              ...(passed ? {} : { blockingGap: 'Add an audit marker to the integrated artifact.' }),
            },
          },
        }];
      }
      return [{ type: 'event', event: { type: 'terminal', status: 'completed' } }];
    });

    const result = await new GauntletRunner({
      sessionId: 'integration-repair-test',
      sessionDirectory: fixture.session,
      sourceWorkspace: fixture.repo,
      baseSha: fixture.baseSha,
      proposal: proposal(fixture.repo),
      config: config(),
      backends: { scripted },
    }).run();

    expect(result.state.status).toBe('achieved');
    expect(await readFile(join(result.integration.path, 'audit-marker.txt'), 'utf8')).toBe('independently reviewable\n');
    expect(requests.filter(request => request.actorId.startsWith('integrator:'))).toHaveLength(1);
    const events = (await readFile(result.eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
    expect(events.filter(event => event.kind === 'audit.verdict')).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'workspace.integration_checkpoint',
      payload: expect.objectContaining({
        taskId: 'integration:repair:1',
        phase: 'completed',
        changedPaths: ['audit-marker.txt'],
      }),
    }));
    const finalAudit = events.filter(event => event.kind === 'audit.verdict').at(-1);
    expect(finalAudit?.payload).toMatchObject({ overall: 'pass', hardChecksPassed: true, final: true });
  });

  it('repairs a mandatory verifier regression before accepting an auditor pass', async () => {
    const fixture = await repository();
    const scripted = new ScriptedBackend(request => {
      if (request.role === 'worker' && request.actorId.startsWith('integrator:')) {
        return [
          {
            type: 'tool',
            callId: 'repair-hard-integration-check',
            name: 'apply_patch',
            input: {
              operationId: 'repair-hard-integration-check',
              operations: [{ type: 'write', path: 'integration-ok.txt', content: 'verified\n', expectedSha256: null }],
            },
          },
          { type: 'event', event: { type: 'terminal', status: 'completed' } },
        ];
      }
      if (request.role === 'worker') {
        const path = request.actorId.endsWith('task:left') ? 'left.txt' : 'right.txt';
        return [
          {
            type: 'tool',
            callId: `create-${path}`,
            name: 'apply_patch',
            input: {
              operationId: `create-${path}`,
              operations: [{ type: 'write', path, content: `${path}\n`, expectedSha256: null }],
            },
          },
          { type: 'event', event: { type: 'terminal', status: 'completed' } },
        ];
      }
      if (request.role === 'critic' || request.role === 'auditor') {
        return [{
          type: 'event',
          event: {
            type: 'terminal',
            status: 'completed',
            structuredOutput: {
              overall: 'pass',
              score: 100,
              confidence: 1,
              criteria: [{ id: 'correctness', status: 'passed', evidenceIds: [], rationale: 'The reviewed artifact satisfies the criterion.' }],
            },
          },
        }];
      }
      return [{ type: 'event', event: { type: 'terminal', status: 'completed' } }];
    });
    const regressionConfig = goalieConfigSchema.parse({
      ...config(30),
      commands: [{
        id: 'integration-contract',
        executable: '/usr/bin/true',
        args: [],
        cwd: '.',
        timeoutMs: 5_000,
        network: false,
        mutating: false,
        env: {},
      }],
    });
    const checkSpy = vi.spyOn(ToolBroker.prototype, 'runCheck').mockImplementation(async function(this: ToolBroker, checkId) {
      const root = (this as unknown as { policy: { root: string } }).policy.root;
      const exists = async (path: string): Promise<boolean> => {
        try {
          await readFile(join(root, path));
          return true;
        } catch {
          return false;
        }
      };
      const bothLanes = await exists('left.txt') && await exists('right.txt');
      const passed = !bothLanes || await exists('integration-ok.txt');
      return {
        commandId: checkId,
        exitCode: passed ? 0 : 1,
        signal: null,
        stdout: passed ? 'integration contract passed' : '',
        stderr: passed ? '' : 'combined lanes require integration-ok.txt',
        durationMs: 1,
        timedOut: false,
        outputTruncated: false,
      };
    });
    let result: Awaited<ReturnType<GauntletRunner['run']>>;
    try {
      result = await new GauntletRunner({
        sessionId: 'hard-integration-repair-test',
        sessionDirectory: fixture.session,
        sourceWorkspace: fixture.repo,
        baseSha: fixture.baseSha,
        proposal: integrationRegressionProposal(fixture.repo),
        config: regressionConfig,
        backends: { scripted },
      }).run();
    } finally {
      checkSpy.mockRestore();
    }

    const events = (await readFile(result.eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
    const audits = events.filter(event => event.kind === 'audit.verdict');
    expect(result.state.status, JSON.stringify(audits.map(event => event.payload), null, 2)).toBe('achieved');
    expect(await readFile(join(result.integration.path, 'integration-ok.txt'), 'utf8')).toBe('verified\n');
    expect(audits[0]?.payload).toMatchObject({ overall: 'fail', hardChecksPassed: false, final: true });
    expect(audits.at(-1)?.payload).toMatchObject({ overall: 'pass', hardChecksPassed: true, final: true });
    expect(events.filter(event => event.kind === 'integration.repair_started')).toHaveLength(1);
  });

  it('runs required spec checks in the final audit even when every task omits them', async () => {
    const fixture = await repository();
    const observedCheckIds: string[] = [];
    const checkSpy = vi.spyOn(ToolBroker.prototype, 'runCheck').mockImplementation(async checkId => {
      observedCheckIds.push(checkId);
      return {
        commandId: checkId,
        exitCode: 1,
        signal: null,
        stdout: '',
        stderr: 'required integration contract failed',
        durationMs: 1,
        timedOut: false,
        outputTruncated: false,
      };
    });
    let result: Awaited<ReturnType<GauntletRunner['run']>>;
    try {
      result = await new GauntletRunner({
        sessionId: 'omitted-required-check-test',
        sessionDirectory: fixture.session,
        sourceWorkspace: fixture.repo,
        baseSha: fixture.baseSha,
        proposal: omittedRequiredCheckProposal(fixture.repo),
        config: config(3),
        backends: { scripted: backend() },
      }).run();
    } finally {
      checkSpy.mockRestore();
    }

    expect(result.state.status).not.toBe('achieved');
    expect(result.state.status).toBe('paused_budget');
    expect(observedCheckIds).toEqual(['omitted-contract']);
    const events = (await readFile(result.eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'audit.verdict',
      payload: expect.objectContaining({ overall: 'fail', hardChecksPassed: false, final: true }),
    }));
  });

  it('pauses when reported spend reaches the cap even though total cost is a lower bound', async () => {
    const fixture = await repository();
    const scripted = new ScriptedBackend(request => {
      if (request.role === 'worker') {
        return [
          {
            type: 'tool',
            callId: 'patch-cost-bound-feature',
            name: 'apply_patch',
            input: {
              operationId: 'create-cost-bound-feature',
              operations: [{ type: 'write', path: 'feature.txt', content: 'clean sheet\n', expectedSha256: null }],
            },
          },
          { type: 'event', event: { type: 'usage', usage: { costUsd: 1.25, inputTokens: 10, outputTokens: 5 } } },
          { type: 'event', event: { type: 'terminal', status: 'completed' } },
        ];
      }
      if (request.role === 'critic' || request.role === 'auditor') {
        return [{
          type: 'event',
          event: {
            type: 'terminal',
            status: 'completed',
            structuredOutput: {
              overall: 'pass',
              score: 100,
              confidence: 1,
              criteria: [{ id: 'correctness', status: 'passed', evidenceIds: [], rationale: 'The artifact is correct.' }],
            },
          },
        }];
      }
      return [{ type: 'event', event: { type: 'terminal', status: 'completed' } }];
    });
    const boundedConfig = goalieConfigSchema.parse({
      ...config(20),
      budget: { ...config(20).budget, maxCostUsd: 1 },
    });
    const result = await new GauntletRunner({
      sessionId: 'reported-cost-lower-bound-test',
      sessionDirectory: fixture.session,
      sourceWorkspace: fixture.repo,
      baseSha: fixture.baseSha,
      proposal: lowerBoundCostProposal(fixture.repo),
      config: boundedConfig,
      backends: { scripted },
    }).run();

    expect(result.state.status).toBe('paused_budget');
    expect(result.state.budget).toMatchObject({
      reportedCostUsd: 1.25,
      costKnown: false,
      unpricedUsageEvents: 1,
    });
  });

  it('reserves provider turns atomically across concurrent lanes', async () => {
    const fixture = await repository();
    const launchedRoles: string[] = [];
    const scripted = new ScriptedBackend(async request => {
      launchedRoles.push(request.role);
      if (request.role === 'worker') await new Promise(resolve => setTimeout(resolve, 75));
      return [{ type: 'event', event: { type: 'terminal', status: 'completed' } }];
    });
    const result = await new GauntletRunner({
      sessionId: 'atomic-turn-budget-test',
      sessionDirectory: fixture.session,
      sourceWorkspace: fixture.repo,
      baseSha: fixture.baseSha,
      proposal: multiLaneProposal(fixture.repo, 2),
      config: config(2),
      backends: { scripted },
    }).run();

    expect(result.state.status).toBe('paused_budget');
    expect(result.state.budget.turns).toBe(2);
    expect(launchedRoles).toEqual(['manager', 'worker']);
    const events = (await readFile(result.eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
    const durableTurns = events
      .filter(event => event.kind === 'budget.consumed')
      .reduce((total, event) => total + Number((event.payload.usage as { turns?: unknown }).turns ?? 0), 0);
    expect(durableTurns).toBe(2);
    expect(events.filter(event => event.kind === 'provider.turn_reserved')).toHaveLength(2);
  });

  it('rebuilds fallback requests with the selected provider model and records provider family', async () => {
    const fixture = await repository();
    const observedModels: Array<{ backend: string; model: string | undefined }> = [];
    const openrouter = remappedBackend('openrouter', request => {
      if (request.role === 'worker') observedModels.push({ backend: 'openrouter', model: request.model });
      return [{ type: 'event', event: { type: 'terminal', status: 'error', error: 'primary failed' } }];
    });
    const codex = remappedBackend('codex-app-server', request => {
      if (request.role === 'worker') observedModels.push({ backend: 'codex', model: request.model });
      return [
        {
          type: 'tool',
          callId: 'patch-fallback',
          name: 'apply_patch',
          input: {
            operationId: 'create-fallback-feature',
            operations: [{ type: 'write', path: 'feature.txt', content: 'fallback clean sheet\n', expectedSha256: null }],
          },
        },
        { type: 'event', event: { type: 'terminal', status: 'completed' } },
      ];
    });
    const scripted = backend();
    const fallbackConfig = goalieConfigSchema.parse({
      providers: {
        manager: 'scripted',
        builder: 'openrouter',
        critic: 'scripted',
        integrator: 'scripted',
        fallback: ['codex', 'scripted'],
      },
      models: { openrouter: 'openrouter/demo-model', codex: 'codex-demo-model' },
      budget: { maxMinutes: 10, maxTurns: 20, maxCostUsd: 10, concurrency: 3, plateauCycles: 3 },
      commands: [],
      allowDegradedCritic: true,
    });
    const result = await new GauntletRunner({
      sessionId: 'fallback-model-test',
      sessionDirectory: fixture.session,
      sourceWorkspace: fixture.repo,
      baseSha: fixture.baseSha,
      proposal: proposal(fixture.repo),
      config: fallbackConfig,
      backends: { openrouter, codex, scripted },
    }).run();

    expect(result.state.status).toBe('achieved');
    expect(observedModels).toEqual([
      { backend: 'openrouter', model: 'openrouter/demo-model' },
      { backend: 'codex', model: 'codex-demo-model' },
    ]);
    const events = (await readFile(result.eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'provider.turn_reserved',
      payload: expect.objectContaining({ provider: 'codex', backend: 'codex-app-server', role: 'worker' }),
    }));
  });

  it('rebuilds integration repair requests with the fallback provider model before re-auditing', async () => {
    const fixture = await repository();
    let lanePatched = false;
    const scripted = new ScriptedBackend(request => {
      if (request.role === 'worker') {
        const steps: ScriptedStep[] = [];
        if (!lanePatched) {
          lanePatched = true;
          steps.push({
            type: 'tool',
            callId: 'patch-integration-fallback-lane',
            name: 'apply_patch',
            input: {
              operationId: 'patch-integration-fallback-lane',
              operations: [{ type: 'write', path: 'feature.txt', content: 'clean sheet\n', expectedSha256: null }],
            },
          });
        }
        steps.push({ type: 'event', event: { type: 'terminal', status: 'completed' } });
        return steps;
      }
      return [{ type: 'event', event: { type: 'terminal', status: 'completed' } }];
    });
    let auditCount = 0;
    const claude = remappedBackend('claude-agent-sdk', request => {
      const passed = request.role === 'critic' || ++auditCount > 1;
      return [{
        type: 'event',
        event: {
          type: 'terminal',
          status: 'completed',
          structuredOutput: {
            overall: passed ? 'pass' : 'fail',
            score: passed ? 100 : 35,
            confidence: 1,
            criteria: [{
              id: 'correctness',
              status: passed ? 'passed' : 'failed',
              evidenceIds: [],
              rationale: passed ? 'The artifact passes.' : 'An integration marker is required.',
            }],
            ...(passed ? {} : { blockingGap: 'Add integration-fallback.txt.' }),
          },
        },
      }];
    });
    const observedModels: Array<{ provider: string; model: string | undefined }> = [];
    const openrouter = remappedBackend('openrouter', request => {
      observedModels.push({ provider: 'openrouter', model: request.model });
      return [{ type: 'event', event: { type: 'terminal', status: 'error', error: 'integrator primary failed' } }];
    });
    const codex = remappedBackend('codex-app-server', request => {
      observedModels.push({ provider: 'codex', model: request.model });
      return [
        {
          type: 'tool',
          callId: 'patch-integration-fallback',
          name: 'apply_patch',
          input: {
            operationId: 'patch-integration-fallback',
            operations: [{ type: 'write', path: 'integration-fallback.txt', content: 'transfer complete\n', expectedSha256: null }],
          },
        },
        { type: 'event', event: { type: 'terminal', status: 'completed' } },
      ];
    });
    const fallbackConfig = goalieConfigSchema.parse({
      providers: {
        manager: 'scripted',
        builder: 'scripted',
        critic: 'claude',
        integrator: 'openrouter',
        fallback: ['codex', 'scripted'],
      },
      models: {
        openrouter: 'openrouter/integrator-primary',
        codex: 'codex-integrator-fallback',
        claude: 'claude-auditor',
      },
      budget: { maxMinutes: 10, maxTurns: 20, maxCostUsd: 10, concurrency: 3, plateauCycles: 3 },
      commands: [],
      allowDegradedCritic: false,
    });
    const result = await new GauntletRunner({
      sessionId: 'integration-fallback-model-test',
      sessionDirectory: fixture.session,
      sourceWorkspace: fixture.repo,
      baseSha: fixture.baseSha,
      proposal: proposal(fixture.repo),
      config: fallbackConfig,
      backends: { scripted, claude, openrouter, codex },
    }).run();

    expect(result.state.status).toBe('achieved');
    expect(observedModels).toEqual([
      { provider: 'openrouter', model: 'openrouter/integrator-primary' },
      { provider: 'codex', model: 'codex-integrator-fallback' },
    ]);
    expect(await readFile(join(result.integration.path, 'integration-fallback.txt'), 'utf8')).toBe('transfer complete\n');
    const events = (await readFile(result.eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'workspace.integration_checkpoint',
      payload: expect.objectContaining({ provider: 'openrouter', phase: 'provider_failed' }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'workspace.integration_checkpoint',
      payload: expect.objectContaining({ provider: 'codex', phase: 'completed' }),
    }));
    expect(events.filter(event => event.kind === 'audit.verdict')).toHaveLength(2);
  });
});
