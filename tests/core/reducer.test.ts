import { describe, expect, it } from 'vitest';

import { calculateEventHash } from '../../src/core/event-store.js';
import { createInitialSessionState, reduceSession } from '../../src/core/reducer.js';
import {
  GENESIS_HASH,
  SessionEventSchema,
  type SessionEvent,
} from '../../src/core/schemas.js';
import { NOW, makeSpec, makeTask } from './fixtures.js';

function eventFactory(sessionId = 'session:test') {
  let sequence = 0;
  let previousHash = GENESIS_HASH;
  return (kind: string, payload: unknown): SessionEvent => {
    sequence += 1;
    const unsigned = {
      id: `event:${sequence}`,
      sessionId,
      sequence,
      timestamp: new Date(Date.parse(NOW) + sequence * 1_000).toISOString(),
      kind,
      payload,
      previousHash,
    };
    const event = SessionEventSchema.parse({
      ...unsigned,
      hash: calculateEventHash(unsigned),
    });
    previousHash = event.hash;
    return event;
  };
}

function failedVerdict(taskId: string, attempt: number, score: number) {
  return {
    id: `verdict:${attempt}`,
    sessionId: 'session:test',
    taskId,
    criticId: 'critic:test',
    attempt,
    verdict: 'fail' as const,
    direction: 'negative' as const,
    score,
    confidence: 0.9,
    comparatorWinner: 'reference' as const,
    criteria: [
      {
        criterionId: 'correctness',
        status: 'failed' as const,
        score,
        rationale: 'The deterministic check still fails.',
        evidenceIds: [],
      },
    ],
    summary: 'Not at the bar yet.',
    biggestGap: 'Fix the failing check.',
    recommendations: ['Run the verifier again.'],
    evidenceIds: [],
    createdAt: NOW,
    metadata: {},
  };
}

describe('session reducer', () => {
  it('projects typed events and safely advances unknown extension events', () => {
    const spec = makeSpec();
    const makeEvent = eventFactory();
    let state = createInitialSessionState('session:test', spec, NOW);
    state = reduceSession(
      state,
      makeEvent('session.created', { spec }),
    );
    state = reduceSession(
      state,
      makeEvent('backend.text_delta', { text: 'hello' }),
    );

    expect(state.status).toBe('created');
    expect(state.lastSequence).toBe(2);
    expect(state.lastHash).not.toBe(GENESIS_HASH);
  });

  it('pauses on the third unchanged failure fingerprint without improvement', () => {
    const spec = makeSpec();
    const task = makeTask('task:a');
    const makeEvent = eventFactory();
    let state = createInitialSessionState('session:test', spec, NOW);
    state = reduceSession(state, makeEvent('session.created', { spec }));
    state = reduceSession(state, makeEvent('task.upserted', { task }));
    state = reduceSession(
      state,
      makeEvent('session.status_changed', { status: 'running' }),
    );

    for (const [index, score] of [0.5, 0.51, 0.52].entries()) {
      const attempt = index + 1;
      state = reduceSession(
        state,
        makeEvent('task.started', {
          taskId: task.id,
          agentId: `worker:${attempt}`,
          startedAt: NOW,
        }),
      );
      state = reduceSession(
        state,
        makeEvent('task.submitted', { taskId: task.id, evidenceIds: [] }),
      );
      state = reduceSession(
        state,
        makeEvent('critic.verdict_recorded', {
          verdict: failedVerdict(task.id, attempt, score),
        }),
      );
    }

    expect(state.taskProgress[task.id]).toMatchObject({
      bestScore: 0.52,
      latestScore: 0.52,
      bestPassedCriteria: 0,
      sameFailureCount: 3,
      nonImprovingVerdicts: 3,
      verdictCount: 3,
    });
    expect(state.taskProgress[task.id]?.lastFailureFingerprint).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(state.tasks[task.id]?.attempts).toBe(3);
    expect(state.tasks[task.id]?.status).toBe('ready');
  });

  it('starts a new consecutive run when the failing criterion changes', () => {
    const spec = makeSpec({
      qualityBar: {
        description: 'Both criteria matter',
        references: [],
        blindComparison: true,
        criteria: [
          {
            id: 'correctness',
            description: 'The implementation is correct',
            required: true,
            weight: 1,
          },
          {
            id: 'robustness',
            description: 'The implementation is robust',
            required: true,
            weight: 1,
          },
        ],
      },
    });
    const task = makeTask('task:a');
    const makeEvent = eventFactory();
    let state = createInitialSessionState('session:test', spec, NOW);
    state = reduceSession(state, makeEvent('session.created', { spec }));
    state = reduceSession(state, makeEvent('task.upserted', { task }));
    state = reduceSession(
      state,
      makeEvent('session.status_changed', { status: 'running' }),
    );

    const criteriaByAttempt = [
      [
        {
          criterionId: 'correctness',
          status: 'failed' as const,
          score: 0.5,
          rationale: 'Correctness fails.',
          evidenceIds: [],
        },
        {
          criterionId: 'robustness',
          status: 'passed' as const,
          score: 1,
          rationale: 'Robustness passes.',
          evidenceIds: [],
        },
      ],
      [
        {
          criterionId: 'correctness',
          status: 'passed' as const,
          score: 1,
          rationale: 'Correctness passes.',
          evidenceIds: [],
        },
        {
          criterionId: 'robustness',
          status: 'failed' as const,
          score: 0.5,
          rationale: 'Robustness fails.',
          evidenceIds: [],
        },
      ],
    ];
    const fingerprints: string[] = [];
    for (const [index, criteria] of criteriaByAttempt.entries()) {
      const attempt = index + 1;
      state = reduceSession(
        state,
        makeEvent('task.started', {
          taskId: task.id,
          agentId: `worker:${attempt}`,
          startedAt: NOW,
        }),
      );
      state = reduceSession(
        state,
        makeEvent('task.submitted', { taskId: task.id, evidenceIds: [] }),
      );
      state = reduceSession(
        state,
        makeEvent('critic.verdict_recorded', {
          verdict: {
            ...failedVerdict(task.id, attempt, 0.5),
            criteria,
          },
        }),
      );
      fingerprints.push(state.taskProgress[task.id]?.lastFailureFingerprint ?? '');
    }

    expect(fingerprints[1]).not.toBe(fingerprints[0]);
    expect(state.taskProgress[task.id]).toMatchObject({
      sameFailureCount: 1,
      nonImprovingVerdicts: 1,
      verdictCount: 2,
    });
  });

  it('breaks an unchanged-fingerprint streak on a meaningful metric gain', () => {
    const spec = makeSpec();
    const task = makeTask('task:a');
    const makeEvent = eventFactory();
    let state = createInitialSessionState('session:test', spec, NOW);
    state = reduceSession(state, makeEvent('session.created', { spec }));
    state = reduceSession(state, makeEvent('task.upserted', { task }));
    state = reduceSession(
      state,
      makeEvent('session.status_changed', { status: 'running' }),
    );

    for (const [index, score] of [0.4, 0.45, 0.45].entries()) {
      const attempt = index + 1;
      state = reduceSession(
        state,
        makeEvent('task.started', {
          taskId: task.id,
          agentId: `worker:${attempt}`,
          startedAt: NOW,
        }),
      );
      state = reduceSession(
        state,
        makeEvent('task.submitted', { taskId: task.id, evidenceIds: [] }),
      );
      state = reduceSession(
        state,
        makeEvent('critic.verdict_recorded', {
          verdict: failedVerdict(task.id, attempt, score),
        }),
      );
    }

    expect(state.taskProgress[task.id]).toMatchObject({
      bestScore: 0.45,
      sameFailureCount: 1,
      nonImprovingVerdicts: 1,
      verdictCount: 3,
    });
  });

  it('breaks an unchanged-fingerprint streak when another criterion passes', () => {
    const spec = makeSpec({
      qualityBar: {
        description: 'Correctness is blocking while polish can improve',
        references: [],
        blindComparison: true,
        criteria: [
          {
            id: 'correctness',
            description: 'The implementation is correct',
            required: true,
            weight: 1,
          },
          {
            id: 'polish',
            description: 'The implementation is polished',
            required: false,
            weight: 1,
          },
        ],
      },
    });
    const task = makeTask('task:a');
    const makeEvent = eventFactory();
    let state = createInitialSessionState('session:test', spec, NOW);
    state = reduceSession(state, makeEvent('session.created', { spec }));
    state = reduceSession(state, makeEvent('task.upserted', { task }));
    state = reduceSession(
      state,
      makeEvent('session.status_changed', { status: 'running' }),
    );

    for (const attempt of [1, 2]) {
      state = reduceSession(
        state,
        makeEvent('task.started', {
          taskId: task.id,
          agentId: `worker:${attempt}`,
          startedAt: NOW,
        }),
      );
      state = reduceSession(
        state,
        makeEvent('task.submitted', { taskId: task.id, evidenceIds: [] }),
      );
      state = reduceSession(
        state,
        makeEvent('critic.verdict_recorded', {
          verdict: {
            ...failedVerdict(task.id, attempt, 0.5),
            criteria: [
              {
                criterionId: 'correctness',
                status: 'failed',
                score: 0.5,
                rationale: 'Correctness remains blocked.',
                evidenceIds: [],
              },
              {
                criterionId: 'polish',
                status: attempt === 1 ? 'not_applicable' : 'passed',
                score: attempt === 1 ? 0 : 1,
                rationale:
                  attempt === 1 ? 'Polish was not evaluated.' : 'Polish now passes.',
                evidenceIds: [],
              },
            ],
          },
        }),
      );
    }

    expect(state.taskProgress[task.id]).toMatchObject({
      bestPassedCriteria: 1,
      sameFailureCount: 0,
      nonImprovingVerdicts: 0,
      verdictCount: 2,
    });
  });

  it('includes deterministic verifier evidence in the failure fingerprint', () => {
    const spec = makeSpec({
      checks: [
        {
          id: 'check:unit',
          name: 'Unit tests',
          description: 'Run the deterministic unit-test verifier',
          evaluatorId: 'command',
          criterionIds: ['correctness'],
          required: true,
          config: {},
        },
      ],
    });
    const task = makeTask('task:a', { checkIds: ['check:unit'] });
    const makeEvent = eventFactory();
    let state = createInitialSessionState('session:test', spec, NOW);
    state = reduceSession(state, makeEvent('session.created', { spec }));
    state = reduceSession(state, makeEvent('task.upserted', { task }));
    state = reduceSession(
      state,
      makeEvent('session.status_changed', { status: 'running' }),
    );

    const fingerprints: string[] = [];
    for (const [index, summary] of [
      'assertion alpha failed',
      'assertion beta failed',
      'assertion beta failed',
    ].entries()) {
      const attempt = index + 1;
      const evidenceId = `evidence:${attempt}`;
      state = reduceSession(
        state,
        makeEvent('task.started', {
          taskId: task.id,
          agentId: `worker:${attempt}`,
          startedAt: NOW,
        }),
      );
      state = reduceSession(
        state,
        makeEvent('evidence.recorded', {
          evidence: {
            id: evidenceId,
            taskId: task.id,
            checkId: 'check:unit',
            kind: 'test',
            source: 'test-harness',
            summary,
            createdAt: new Date(Date.parse(NOW) + attempt * 1_000).toISOString(),
          },
        }),
      );
      state = reduceSession(
        state,
        makeEvent('check.recorded', {
          check: {
            id: `result:${attempt}`,
            definitionId: 'check:unit',
            taskId: task.id,
            evaluatorId: 'command',
            evaluatorVersion: '1',
            status: 'failed',
            score: 0,
            summary,
            evidenceIds: [evidenceId],
            startedAt: new Date(Date.parse(NOW) + attempt * 1_000).toISOString(),
            completedAt: new Date(
              Date.parse(NOW) + attempt * 1_000 + 100,
            ).toISOString(),
          },
        }),
      );
      state = reduceSession(
        state,
        makeEvent('task.submitted', { taskId: task.id, evidenceIds: [evidenceId] }),
      );
      state = reduceSession(
        state,
        makeEvent('critic.verdict_recorded', {
          verdict: failedVerdict(task.id, attempt, 0.5),
        }),
      );
      fingerprints.push(state.taskProgress[task.id]?.lastFailureFingerprint ?? '');
    }

    expect(fingerprints[1]).not.toBe(fingerprints[0]);
    expect(fingerprints[2]).toBe(fingerprints[1]);
    expect(state.taskProgress[task.id]).toMatchObject({
      sameFailureCount: 2,
      nonImprovingVerdicts: 2,
    });
  });

  it('does not infer zero cost when provider usage is unpriced', () => {
    const spec = makeSpec();
    const makeEvent = eventFactory();
    let state = createInitialSessionState('session:test', spec, NOW);
    state = reduceSession(state, makeEvent('session.created', { spec }));
    state = reduceSession(
      state,
      makeEvent('budget.consumed', {
        usage: { inputTokens: 100, outputTokens: 25, wallTimeMs: 10, turns: 1 },
      }),
    );
    state = reduceSession(
      state,
      makeEvent('budget.consumed', {
        usage: {
          inputTokens: 20,
          outputTokens: 5,
          costUsd: 1.25,
          wallTimeMs: 5,
          turns: 1,
        },
      }),
    );

    expect(state.budget).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      reportedCostUsd: 1.25,
      costKnown: false,
      unpricedUsageEvents: 1,
      turns: 2,
    });
  });

  it('separates a pending turn reservation from its eventual pricing result', () => {
    const spec = makeSpec();
    const makeEvent = eventFactory();
    let state = createInitialSessionState('session:test', spec, NOW);
    state = reduceSession(state, makeEvent('session.created', { spec }));

    state = reduceSession(
      state,
      makeEvent('budget.consumed', {
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          costStatus: 'pending',
          wallTimeMs: 0,
          turns: 1,
        },
      }),
    );

    expect(state.budget).toMatchObject({
      turns: 1,
      costKnown: true,
      unpricedUsageEvents: 0,
    });

    state = reduceSession(
      state,
      makeEvent('budget.consumed', {
        usage: {
          inputTokens: 12,
          outputTokens: 4,
          costStatus: 'unknown',
          wallTimeMs: 9,
          turns: 0,
        },
      }),
    );

    expect(state.budget).toMatchObject({
      inputTokens: 12,
      outputTokens: 4,
      turns: 1,
      costKnown: false,
      unpricedUsageEvents: 1,
    });
  });

  it('keeps cost known when a reserved turn completes with reported pricing', () => {
    const spec = makeSpec();
    const makeEvent = eventFactory();
    let state = createInitialSessionState('session:test', spec, NOW);
    state = reduceSession(state, makeEvent('session.created', { spec }));
    state = reduceSession(
      state,
      makeEvent('budget.consumed', {
        usage: { costStatus: 'pending', wallTimeMs: 0, turns: 1 },
      }),
    );
    state = reduceSession(
      state,
      makeEvent('budget.consumed', {
        usage: {
          inputTokens: 8,
          outputTokens: 2,
          costUsd: 0.25,
          costStatus: 'reported',
          wallTimeMs: 5,
          turns: 0,
        },
      }),
    );

    expect(state.budget).toMatchObject({
      reportedCostUsd: 0.25,
      turns: 1,
      costKnown: true,
      unpricedUsageEvents: 0,
    });
  });

  it('rejects a pass that omits a required criterion', () => {
    const spec = makeSpec();
    const task = makeTask('task:a');
    const makeEvent = eventFactory();
    let state = createInitialSessionState('session:test', spec, NOW);
    state = reduceSession(state, makeEvent('session.created', { spec }));
    state = reduceSession(state, makeEvent('task.upserted', { task }));
    state = reduceSession(
      state,
      makeEvent('session.status_changed', { status: 'running' }),
    );
    state = reduceSession(
      state,
      makeEvent('task.started', {
        taskId: task.id,
        agentId: 'worker:1',
        startedAt: NOW,
      }),
    );
    state = reduceSession(
      state,
      makeEvent('task.submitted', { taskId: task.id, evidenceIds: [] }),
    );

    expect(() =>
      reduceSession(
        state,
        makeEvent('critic.verdict_recorded', {
          verdict: {
            ...failedVerdict(task.id, 1, 1),
            verdict: 'pass',
            direction: 'positive',
            comparatorWinner: 'candidate',
            criteria: [
              {
                criterionId: 'different',
                status: 'passed',
                score: 1,
                rationale: 'Wrong criterion.',
                evidenceIds: [],
              },
            ],
            biggestGap: undefined,
          },
        }),
      ),
    ).toThrow(/required criterion correctness/u);
  });
});
