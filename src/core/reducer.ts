import { createHash } from 'node:crypto';

import {
  GENESIS_HASH,
  GauntletSpecSchema,
  SessionEventSchema,
  SessionStateSchema,
  isCoreEventKind,
  parseCoreSessionEvent,
  type RecordedCriticVerdict,
  type GauntletSpec,
  type SessionEvent,
  type SessionState,
  type SessionStatus,
  type Task,
  type TaskProgress,
} from './schemas.js';

export class SessionReductionError extends Error {
  readonly eventId: string;

  constructor(message: string, event: SessionEvent) {
    super(`Cannot apply event ${event.id} (${event.kind}): ${message}`);
    this.name = 'SessionReductionError';
    this.eventId = event.id;
  }
}

const TERMINAL_STATUSES = new Set<SessionStatus>([
  'achieved',
  'safety_halt',
]);

const STATUS_TRANSITIONS: Readonly<Record<SessionStatus, ReadonlySet<SessionStatus>>> = {
  created: new Set([
    'created',
    'planning',
    'running',
    'blocked',
    'safety_halt',
    'user_stopped',
    'failed',
  ]),
  planning: new Set([
    'planning',
    'running',
    'paused_approval',
    'blocked',
    'safety_halt',
    'user_stopped',
    'failed',
  ]),
  running: new Set([
    'running',
    'achieved',
    'paused_budget',
    'paused_plateau',
    'paused_approval',
    'blocked',
    'safety_halt',
    'user_stopped',
    'failed',
  ]),
  achieved: new Set(['achieved']),
  paused_budget: new Set([
    'paused_budget',
    'running',
    'safety_halt',
    'user_stopped',
    'failed',
  ]),
  paused_plateau: new Set([
    'paused_plateau',
    'running',
    'paused_approval',
    'safety_halt',
    'user_stopped',
    'failed',
  ]),
  paused_approval: new Set([
    'paused_approval',
    'running',
    'blocked',
    'safety_halt',
    'user_stopped',
    'failed',
  ]),
  blocked: new Set([
    'blocked',
    'running',
    'paused_approval',
    'safety_halt',
    'user_stopped',
    'failed',
  ]),
  safety_halt: new Set(['safety_halt']),
  user_stopped: new Set(['user_stopped', 'running', 'safety_halt', 'failed']),
  failed: new Set(['failed', 'running', 'safety_halt', 'user_stopped']),
};

export function isTerminalSessionStatus(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function createInitialSessionState(
  sessionId: string,
  spec: GauntletSpec,
  createdAt = new Date().toISOString(),
): SessionState {
  const parsedSpec = GauntletSpecSchema.parse(spec);
  return SessionStateSchema.parse({
    sessionId,
    spec: parsedSpec,
    status: 'created',
    tasks: {},
    checks: {},
    evidence: {},
    verdicts: [],
    taskProgress: {},
    budget: {
      inputTokens: 0,
      outputTokens: 0,
      reportedCostUsd: 0,
      costKnown: true,
      unpricedUsageEvents: 0,
      wallTimeMs: 0,
      turns: 0,
    },
    errors: [],
    createdAt,
    updatedAt: createdAt,
    lastSequence: 0,
    lastHash: GENESIS_HASH,
  });
}

function assertEnvelope(state: SessionState, event: SessionEvent): void {
  if (event.sessionId !== state.sessionId) {
    throw new SessionReductionError(
      `session ID ${event.sessionId} does not match ${state.sessionId}`,
      event,
    );
  }
  if (event.sequence !== state.lastSequence + 1) {
    throw new SessionReductionError(
      `expected sequence ${state.lastSequence + 1}, got ${event.sequence}`,
      event,
    );
  }
  if (event.previousHash !== state.lastHash) {
    throw new SessionReductionError('previous hash does not match state tail', event);
  }
}

function requireTask(state: SessionState, taskId: string, event: SessionEvent): Task {
  const task = state.tasks[taskId];
  if (!task) {
    throw new SessionReductionError(`unknown task ${taskId}`, event);
  }
  return task;
}

function withTask(state: SessionState, task: Task): SessionState {
  return { ...state, tasks: { ...state.tasks, [task.id]: task } };
}

function assertCanStartTask(
  state: SessionState,
  task: Task,
  event: SessionEvent,
): void {
  if (isTerminalSessionStatus(state.status)) {
    throw new SessionReductionError(
      `session is terminal (${state.status})`,
      event,
    );
  }
  if (state.status !== 'running') {
    throw new SessionReductionError(
      `tasks can only start while the session is running (currently ${state.status})`,
      event,
    );
  }
  if (!['pending', 'ready', 'failed'].includes(task.status)) {
    throw new SessionReductionError(
      `task ${task.id} cannot start from ${task.status}`,
      event,
    );
  }
  if (task.maxAttempts !== undefined && task.attempts >= task.maxAttempts) {
    throw new SessionReductionError(
      `task ${task.id} has exhausted its attempt limit`,
      event,
    );
  }
  for (const dependencyId of task.dependencies) {
    const dependency = state.tasks[dependencyId];
    if (!dependency || dependency.status !== 'passed') {
      throw new SessionReductionError(
        `dependency ${dependencyId} has not passed`,
        event,
      );
    }
  }
}

function assertPassingCriteria(
  state: SessionState,
  task: Task,
  verdict: RecordedCriticVerdict,
  event: SessionEvent,
): void {
  if (verdict.verdict !== 'pass') return;
  const byId = new Map(
    verdict.criteria.map((criterion) => [criterion.criterionId, criterion]),
  );
  for (const criterion of state.spec.qualityBar.criteria) {
    if (!criterion.required) continue;
    const result = byId.get(criterion.id);
    if (!result || result.status !== 'passed') {
      throw new SessionReductionError(
        `passing verdict does not pass required criterion ${criterion.id}`,
        event,
      );
    }
  }
  for (const definitionId of task.checkIds) {
    const definition = state.spec.checks.find((check) => check.id === definitionId);
    if (!definition?.required) continue;
    const latest = Object.values(state.checks)
      .filter(
        (check) =>
          check.definitionId === definitionId && check.taskId === task.id,
      )
      .sort(
        (left, right) =>
          (right.completedAt ?? right.startedAt).localeCompare(
            left.completedAt ?? left.startedAt,
          ) || right.id.localeCompare(left.id),
      )[0];
    if (!latest || latest.status !== 'passed') {
      throw new SessionReductionError(
        `passing verdict does not have a passing required check ${definitionId}`,
        event,
      );
    }
  }
}

function updateTaskProgress(
  previous: TaskProgress | undefined,
  verdict: RecordedCriticVerdict,
  minImprovement: number,
  failureFingerprint: string | undefined,
): TaskProgress {
  const prior = previous ?? {
    nonImprovingVerdicts: 0,
    verdictCount: 0,
  };
  const bestScore = prior.bestScore;
  const passedCriteria = verdict.criteria.filter(
    (criterion) => criterion.status === 'passed',
  ).length;
  const scoreGain = bestScore === undefined ? 0 : verdict.score - bestScore;
  const scoreImproved =
    scoreGain > 1e-12 && scoreGain >= minImprovement - 1e-12;
  const criteriaImproved =
    prior.bestPassedCriteria !== undefined &&
    passedCriteria > prior.bestPassedCriteria;
  const meaningfulImprovement = scoreImproved || criteriaImproved;
  const sameFingerprint =
    failureFingerprint !== undefined &&
    failureFingerprint === prior.lastFailureFingerprint;

  let sameFailureCount = 0;
  if (verdict.verdict !== 'pass' && failureFingerprint !== undefined) {
    if (!sameFingerprint) {
      // The first occurrence establishes a new consecutive fingerprint run.
      sameFailureCount = 1;
    } else if (!meaningfulImprovement) {
      sameFailureCount = (prior.sameFailureCount ?? prior.nonImprovingVerdicts) + 1;
    }
  }

  return {
    bestScore:
      bestScore === undefined ? verdict.score : Math.max(bestScore, verdict.score),
    latestScore: verdict.score,
    bestPassedCriteria:
      prior.bestPassedCriteria === undefined
        ? passedCriteria
        : Math.max(prior.bestPassedCriteria, passedCriteria),
    ...(verdict.verdict === 'pass'
      ? {}
      : { lastFailureFingerprint: failureFingerprint }),
    sameFailureCount,
    nonImprovingVerdicts: sameFailureCount,
    verdictCount: prior.verdictCount + 1,
  };
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Build a host-owned fingerprint. Critic prose and attempt-scoped evidence IDs
 * are deliberately excluded; deterministic verifier evidence digests are not.
 */
function failureFingerprint(
  state: SessionState,
  task: Task,
  verdict: RecordedCriticVerdict,
): string | undefined {
  if (verdict.verdict === 'pass') return undefined;

  const criteria = verdict.criteria
    .filter(
      (criterion) =>
        criterion.status === 'failed' || criterion.status === 'uncertain',
    )
    .map((criterion) => criterion.criterionId)
    .sort();

  const verifiers = task.checkIds
    .slice()
    .sort()
    .map((definitionId) => {
      const latest = Object.values(state.checks)
        .filter(
          (check) =>
            check.definitionId === definitionId && check.taskId === task.id,
        )
        .sort(
          (left, right) =>
            (right.completedAt ?? right.startedAt).localeCompare(
              left.completedAt ?? left.startedAt,
            ) || right.id.localeCompare(left.id),
        )[0];
      if (!latest) return { definitionId, status: 'missing' as const, evidence: [] };
      if (latest.status === 'passed') return undefined;
      const evidence = latest.evidenceIds
        .map((evidenceId) => state.evidence[evidenceId])
        .filter((item) => item !== undefined)
        .map((item) => item.digest ?? digestText(item.summary))
        .sort();
      return {
        definitionId,
        status: latest.status,
        evidence:
          evidence.length > 0
            ? evidence
            : [digestText(latest.error ?? latest.summary)],
      };
    })
    .filter((item) => item !== undefined);

  return digestText(JSON.stringify({ criteria, verifiers }));
}

/**
 * Pure projection of one verified event onto session state. Unknown extension
 * kinds advance the event cursor but otherwise leave the projection untouched.
 */
export function reduceSession(
  current: SessionState,
  rawEvent: SessionEvent,
): SessionState {
  const state = SessionStateSchema.parse(current);
  const eventEnvelope = SessionEventSchema.parse(rawEvent) as SessionEvent;
  assertEnvelope(state, eventEnvelope);

  let next = state;
  if (isCoreEventKind(eventEnvelope.kind)) {
    const event = parseCoreSessionEvent(eventEnvelope);
    switch (event.kind) {
      case 'session.created': {
        if (state.lastSequence !== 0) {
          throw new SessionReductionError(
            'session.created must be the first event',
            event,
          );
        }
        next = {
          ...state,
          spec: event.payload.spec,
          createdAt: event.timestamp,
          status: 'created',
        };
        break;
      }
      case 'session.status_changed': {
        const target = event.payload.status;
        if (!STATUS_TRANSITIONS[state.status].has(target)) {
          throw new SessionReductionError(
            `invalid status transition ${state.status} -> ${target}`,
            event,
          );
        }
        next = {
          ...state,
          status: target,
          ...(event.payload.reason === undefined
            ? { statusReason: undefined }
            : { statusReason: event.payload.reason }),
        };
        break;
      }
      case 'task.upserted': {
        const task = event.payload.task;
        for (const checkId of task.checkIds) {
          if (!state.spec.checks.some((check) => check.id === checkId)) {
            throw new SessionReductionError(
              `task ${task.id} refers to unknown check ${checkId}`,
              event,
            );
          }
        }
        next = withTask(state, task);
        if (!state.taskProgress[task.id]) {
          next = {
            ...next,
            taskProgress: {
              ...state.taskProgress,
              [task.id]: {
                nonImprovingVerdicts: 0,
                verdictCount: 0,
              },
            },
          };
        }
        break;
      }
      case 'task.started': {
        const task = requireTask(state, event.payload.taskId, event);
        assertCanStartTask(state, task, event);
        next = withTask(state, {
          ...task,
          status: 'running',
          assignedAgentId: event.payload.agentId,
          attempts: task.attempts + 1,
          updatedAt: event.timestamp,
        });
        break;
      }
      case 'task.submitted': {
        const task = requireTask(state, event.payload.taskId, event);
        if (task.status !== 'running') {
          throw new SessionReductionError(
            `task ${task.id} cannot be submitted from ${task.status}`,
            event,
          );
        }
        for (const evidenceId of event.payload.evidenceIds) {
          if (!state.evidence[evidenceId]) {
            throw new SessionReductionError(
              `submission refers to unknown evidence ${evidenceId}`,
              event,
            );
          }
        }
        next = withTask(state, {
          ...task,
          status: 'awaiting_evaluation',
          updatedAt: event.timestamp,
        });
        break;
      }
      case 'task.blocked': {
        const task = requireTask(state, event.payload.taskId, event);
        next = withTask(state, {
          ...task,
          status: 'blocked',
          assignedAgentId: undefined,
          updatedAt: event.timestamp,
          metadata: { ...task.metadata, blockedReason: event.payload.reason },
        });
        break;
      }
      case 'task.cancelled': {
        const task = requireTask(state, event.payload.taskId, event);
        next = withTask(state, {
          ...task,
          status: 'cancelled',
          assignedAgentId: undefined,
          updatedAt: event.timestamp,
          metadata: { ...task.metadata, cancelledReason: event.payload.reason },
        });
        break;
      }
      case 'check.recorded': {
        const check = event.payload.check;
        if (state.checks[check.id]) {
          throw new SessionReductionError(`duplicate check result ${check.id}`, event);
        }
        if (!state.spec.checks.some((definition) => definition.id === check.definitionId)) {
          throw new SessionReductionError(
            `unknown check definition ${check.definitionId}`,
            event,
          );
        }
        if (check.taskId !== undefined) {
          requireTask(state, check.taskId, event);
        }
        for (const evidenceId of check.evidenceIds) {
          if (!state.evidence[evidenceId]) {
            throw new SessionReductionError(
              `check refers to unknown evidence ${evidenceId}`,
              event,
            );
          }
        }
        next = { ...state, checks: { ...state.checks, [check.id]: check } };
        break;
      }
      case 'evidence.recorded': {
        const evidence = event.payload.evidence;
        if (state.evidence[evidence.id]) {
          throw new SessionReductionError(`duplicate evidence ${evidence.id}`, event);
        }
        next = {
          ...state,
          evidence: { ...state.evidence, [evidence.id]: evidence },
        };
        break;
      }
      case 'critic.verdict_recorded': {
        const verdict = event.payload.verdict;
        if (verdict.sessionId !== state.sessionId) {
          throw new SessionReductionError(
            `verdict session ${verdict.sessionId} does not match`,
            event,
          );
        }
        if (state.verdicts.some((existing) => existing.id === verdict.id)) {
          throw new SessionReductionError(`duplicate verdict ${verdict.id}`, event);
        }
        const task = requireTask(state, verdict.taskId, event);
        if (task.status !== 'awaiting_evaluation') {
          throw new SessionReductionError(
            `task ${task.id} is not awaiting evaluation`,
            event,
          );
        }
        if (verdict.attempt !== task.attempts) {
          throw new SessionReductionError(
            `stale verdict attempt ${verdict.attempt}; current attempt is ${task.attempts}`,
            event,
          );
        }
        assertPassingCriteria(state, task, verdict, event);
        const progress = updateTaskProgress(
          state.taskProgress[task.id],
          verdict,
          state.spec.budget.plateau.minImprovement,
          failureFingerprint(state, task, verdict),
        );
        const attemptsExhausted =
          task.maxAttempts !== undefined && task.attempts >= task.maxAttempts;
        const status =
          verdict.verdict === 'pass'
            ? 'passed'
            : attemptsExhausted
              ? 'failed'
              : 'ready';
        next = {
          ...withTask(state, {
            ...task,
            status,
            assignedAgentId: undefined,
            updatedAt: event.timestamp,
          }),
          verdicts: [...state.verdicts, verdict],
          taskProgress: { ...state.taskProgress, [task.id]: progress },
        };
        break;
      }
      case 'budget.consumed': {
        const usage = event.payload.usage;
        const isUnpriced = usage.costStatus === 'unknown' || (
          usage.costStatus === undefined &&
          usage.costUsd === undefined &&
          (usage.inputTokens > 0 || usage.outputTokens > 0 || usage.turns > 0)
        );
        next = {
          ...state,
          budget: {
            inputTokens: state.budget.inputTokens + usage.inputTokens,
            outputTokens: state.budget.outputTokens + usage.outputTokens,
            reportedCostUsd:
              state.budget.reportedCostUsd + (usage.costUsd ?? 0),
            costKnown: state.budget.costKnown && !isUnpriced,
            unpricedUsageEvents:
              state.budget.unpricedUsageEvents + (isUnpriced ? 1 : 0),
            wallTimeMs: state.budget.wallTimeMs + usage.wallTimeMs,
            turns: state.budget.turns + usage.turns,
          },
        };
        break;
      }
      case 'session.budget_extended': {
        next = {
          ...state,
          spec: {
            ...state.spec,
            budget: event.payload.budget,
            metadata: {
              ...state.spec.metadata,
              budgetAmendmentVersion: event.payload.amendmentVersion,
              budgetAmendmentReason: event.payload.reason,
            },
          },
        };
        break;
      }
      case 'session.error_recorded': {
        next = {
          ...state,
          errors: [
            ...state.errors,
            {
              ...event.payload,
              sequence: event.sequence,
              timestamp: event.timestamp,
            },
          ],
        };
        break;
      }
    }
  }

  return SessionStateSchema.parse({
    ...next,
    updatedAt: eventEnvelope.timestamp,
    lastSequence: eventEnvelope.sequence,
    lastHash: eventEnvelope.hash,
  });
}

export function replaySession(
  initial: SessionState,
  events: readonly SessionEvent[],
): SessionState {
  return events.reduce(reduceSession, initial);
}
