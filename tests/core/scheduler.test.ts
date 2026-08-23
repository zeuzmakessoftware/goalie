import { describe, expect, it } from 'vitest';

import {
  analyzeDependencyGraph,
  decideSchedule,
  evaluateBudget,
  writeSetsConflict,
} from '../../src/core/scheduler.js';
import { makeSpec, makeState, makeTask } from './fixtures.js';

describe('dependency scheduler', () => {
  it('runs disjoint write sets concurrently and gives priority first choice', () => {
    const a = makeTask('a', { priority: 100, writeSet: ['src/shared'] });
    const b = makeTask('b', { priority: 10, writeSet: ['src/independent'] });
    const c = makeTask('c', { priority: 50, writeSet: ['src/shared/nested'] });
    const decision = decideSchedule(makeState([a, b, c]));

    expect(decision.kind).toBe('schedule');
    if (decision.kind !== 'schedule') throw new Error('Expected schedule');
    expect(decision.taskIds).toEqual(['a', 'b']);
    expect(decision.blocked).toContainEqual({
      taskId: 'c',
      reason: 'write_conflict',
      relatedIds: ['a'],
    });
  });

  it('treats glob write sets conservatively and empty sets as read-only', () => {
    expect(writeSetsConflict(['**'], ['src/a'])).toBe(true);
    expect(writeSetsConflict([], ['src/a'])).toBe(false);
    expect(writeSetsConflict(['src/a'], ['src/ab'])).toBe(false);
  });

  it('detects cycles and unknown dependencies deterministically', () => {
    const tasks = {
      a: makeTask('a', { dependencies: ['b'] }),
      b: makeTask('b', { dependencies: ['a'] }),
      c: makeTask('c', { dependencies: ['missing'] }),
    };
    expect(analyzeDependencyGraph(tasks)).toEqual({
      valid: false,
      unknownDependencies: { c: ['missing'] },
      cycles: [['a', 'b']],
    });
  });

  it('pauses at inclusive budget limits without pretending unknown cost is zero', () => {
    const spec = makeSpec({
      budget: {
        maxTokens: 100,
        maxCostUsd: 5,
        maxTurns: 10,
        maxConcurrency: 2,
        plateau: { window: 3, minImprovement: 0.02 },
      },
    });
    const state = makeState([makeTask('a')], spec);
    state.budget.inputTokens = 60;
    state.budget.outputTokens = 40;
    state.budget.reportedCostUsd = 1;
    state.budget.costKnown = false;
    state.budget.unpricedUsageEvents = 1;

    expect(evaluateBudget(state)).toMatchObject({
      exceeded: ['tokens'],
      totalTokens: 100,
      reportedCostUsd: 1,
      costKnown: false,
    });
    expect(decideSchedule(state)).toMatchObject({
      kind: 'transition',
      status: 'paused_budget',
    });
  });

  it('pauses exactly when a required task reaches the plateau window', () => {
    const task = makeTask('a');
    const state = makeState([task]);
    state.taskProgress[task.id] = {
      bestScore: 0.5,
      latestScore: 0.51,
      nonImprovingVerdicts: 3,
      verdictCount: 4,
    };
    expect(decideSchedule(state)).toMatchObject({
      kind: 'transition',
      status: 'paused_plateau',
    });
  });

  it('prefers the fingerprint streak while accepting legacy snapshots', () => {
    const task = makeTask('a');
    const state = makeState([task]);
    state.taskProgress[task.id] = {
      bestScore: 0.5,
      latestScore: 0.5,
      sameFailureCount: 1,
      nonImprovingVerdicts: 99,
      verdictCount: 99,
    };
    expect(decideSchedule(state)).toMatchObject({
      kind: 'schedule',
      taskIds: ['a'],
    });

    state.taskProgress[task.id] = {
      bestScore: 0.5,
      latestScore: 0.5,
      nonImprovingVerdicts: 3,
      verdictCount: 3,
    };
    expect(decideSchedule(state)).toMatchObject({
      kind: 'transition',
      status: 'paused_plateau',
    });
  });
});
