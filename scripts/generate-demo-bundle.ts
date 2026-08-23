import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { JsonlEventStore } from '../src/core/event-store.js';
import { CheckResultSchema, CriticVerdictSchema, EvidenceSchema, GauntletSpecSchema, TaskSchema } from '../src/core/schemas.js';
import { createReplayBundle, writeReplayBundle } from '../src/replay/bundle.js';
import { PENALTY_LEDGER_GOAL } from '../src/demo/fixture.js';

const sessionId = 'demo-penalty-ledger';
const timestamp = '2026-08-22T19:00:00.000Z';
const temporary = await mkdtemp(join(tmpdir(), 'goalie-demo-bundle-'));
const output = resolve('demo', 'penalty-ledger.replay.json');

try {
  const store = await JsonlEventStore.open({ directory: temporary, sessionId, writer: true });
  const spec = GauntletSpecSchema.parse({
    version: 1,
    goal: PENALTY_LEDGER_GOAL,
    qualityBar: {
      description: 'Crash-safe, exactly-once penalty ingestion with deterministic ranking.',
      references: ['fixture://penalty-ledger'],
      criteria: [{ id: 'correctness', description: 'Every protected deterministic verifier passes.', required: true, weight: 1 }],
      blindComparison: false,
    },
    constraints: ['Replay fixture only; no active agents or tools.'],
    checks: [{ id: 'check:verify', name: 'protected verifier', evaluatorId: 'approved-command', criterionIds: ['correctness'], required: true, config: { commandId: 'verify' } }],
    budget: { maxTurns: 20, maxWallTimeMs: 900_000, maxConcurrency: 3, plateau: { window: 3, minImprovement: 0.02 } },
    workspaceRoot: '/recorded/penalty-ledger',
    metadata: { fixture: true, simulation: true },
  });
  const task = TaskSchema.parse({
    id: 'task:ledger', title: 'Repair Penalty Ledger', objective: PENALTY_LEDGER_GOAL,
    dependencies: [], writeSet: ['src/ledger.ts'], checkIds: ['check:verify'], status: 'ready', priority: 100,
    required: true, attempts: 0, createdAt: timestamp, updatedAt: timestamp, metadata: { lane: 'primary' },
  });
  await store.append({ kind: 'session.created', payload: { spec } });
  await store.append({ kind: 'task.upserted', payload: { task } });
  await store.append({ kind: 'session.status_changed', payload: { status: 'running' } });

  const appendAttempt = async (attempt: number, passed: boolean): Promise<void> => {
    await store.append({ kind: 'task.started', payload: { taskId: task.id, agentId: 'worker:ledger', startedAt: timestamp } });
    await store.append({ kind: 'workspace.checkpoint', payload: { taskId: task.id, attempt, commitSha: passed ? 'f'.repeat(40) : 'e'.repeat(40), changedPaths: ['src/ledger.ts'] } });
    const evidence = EvidenceSchema.parse({
      id: `evidence:verify:${attempt}`, taskId: task.id, checkId: 'check:verify', kind: 'test', source: 'protected-fixture',
      summary: passed ? '3/3 protected checks passed: concurrent exactly-once ingestion, torn-tail recovery, deterministic tied ranking.' : '3 protected failures: duplicate ingestion, torn-tail replay, tie ordering.',
      digest: createHash('sha256').update(`attempt:${attempt}:${passed}`).digest('hex'), createdAt: timestamp,
    });
    await store.append({ kind: 'evidence.recorded', payload: { evidence } });
    const check = CheckResultSchema.parse({
      id: `result:verify:${attempt}`, definitionId: 'check:verify', taskId: task.id, evaluatorId: 'approved-command', evaluatorVersion: '1',
      status: passed ? 'passed' : 'failed', score: passed ? 1 : 0.4, summary: evidence.summary, evidenceIds: [evidence.id], startedAt: timestamp, completedAt: timestamp,
    });
    await store.append({ kind: 'check.recorded', payload: { check } });
    await store.append({ kind: 'task.submitted', payload: { taskId: task.id, evidenceIds: [evidence.id] } });
    const verdict = CriticVerdictSchema.parse({
      id: `verdict:ledger:${attempt}`, sessionId, taskId: task.id, criticId: `critic:fresh:${attempt}`, attempt,
      verdict: passed ? 'pass' : 'fail', direction: passed ? 'positive' : 'negative', score: passed ? 0.98 : 0.42, confidence: 0.99,
      comparatorWinner: passed ? 'candidate' : 'reference',
      criteria: [{ criterionId: 'correctness', status: passed ? 'passed' : 'failed', score: passed ? 0.98 : 0.42, rationale: passed ? 'All protected evidence passes.' : 'Exactly-once and recovery invariants fail.', evidenceIds: [evidence.id] }],
      summary: passed ? 'Clean sheet: the durable ledger now satisfies every invariant.' : 'SAVE: deterministic evidence rejects this attempt.',
      ...(passed ? {} : { biggestGap: 'Use an atomic lock/claim and ignore only a torn final JSONL record.' }),
      recommendations: passed ? [] : ['Repair the invariant and replay the verifier.'], evidenceIds: [evidence.id], createdAt: timestamp,
    });
    await store.append({ kind: 'critic.verdict_recorded', payload: { verdict } });
  };

  await appendAttempt(1, false);
  await store.append({ kind: 'session.restarted', payload: { declaredKill: true, recoveredFromSequence: 8 } });
  await appendAttempt(2, true);
  await store.append({ kind: 'workspace.integration_checkpoint', payload: { taskId: task.id, commitSha: 'f'.repeat(40), changedPaths: ['src/ledger.ts'] } });
  await store.append({ kind: 'audit.verdict', payload: { overall: 'pass', evidenceIds: ['evidence:verify:2'], fresh: true } });
  await store.append({ kind: 'playbook.benchmark', payload: { heldOutTask: 'ranking-replay', baseline: 0.5, candidate: 1, independentlyReviewed: true } });
  await store.append({ kind: 'session.status_changed', payload: { status: 'achieved', reason: 'Clean sheet: hard gates and the fresh audit passed.' } });
  const events = await store.readEvents();
  await store.close();

  const bundle = createReplayBundle({
    source: 'simulated_fixture', edited: false, recordedAt: timestamp, harnessVersion: '1.0.0',
    backendVersions: { scripted: 'deterministic-v1' }, baseSha: 'd'.repeat(40), finalSha: 'f'.repeat(40),
    redaction: 'redacted', fixture: 'penalty-ledger',
  }, events, { 'src/ledger.ts': createHash('sha256').update('simulated-fixed-ledger').digest('hex') });
  await mkdir(resolve('demo'), { recursive: true });
  await writeReplayBundle(output, bundle);
  process.stdout.write(`Wrote ${output} with ${events.length} verified events.\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
