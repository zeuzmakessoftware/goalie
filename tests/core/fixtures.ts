import {
  GauntletSpecSchema,
  TaskSchema,
  type GauntletSpec,
  type SessionState,
  type Task,
} from '../../src/core/schemas.js';
import { createInitialSessionState } from '../../src/core/reducer.js';

export const NOW = '2026-08-22T12:00:00.000Z';

export function makeSpec(
  overrides: Partial<GauntletSpec> = {},
): GauntletSpec {
  return GauntletSpecSchema.parse({
    version: 1,
    goal: 'Build and verify the requested artifact',
    qualityBar: {
      description: 'Beat the inspectable reference',
      references: ['reference://golden'],
      criteria: [
        {
          id: 'correctness',
          description: 'Required checks pass',
          required: true,
          weight: 1,
        },
      ],
      blindComparison: true,
    },
    constraints: [],
    checks: [],
    budget: {
      maxConcurrency: 4,
      plateau: { window: 3, minImprovement: 0.02 },
    },
    workspaceRoot: '/tmp/goalie-workspace',
    metadata: {},
    ...overrides,
  });
}

export function makeTask(
  id: string,
  overrides: Partial<Task> = {},
): Task {
  return TaskSchema.parse({
    id,
    title: `Task ${id}`,
    objective: `Complete ${id}`,
    dependencies: [],
    writeSet: [`src/${id}`],
    checkIds: [],
    status: 'ready',
    priority: 0,
    required: true,
    attempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
    metadata: {},
    ...overrides,
  });
}

export function makeState(
  tasks: readonly Task[] = [],
  spec = makeSpec(),
): SessionState {
  const initial = createInitialSessionState('session:test', spec, NOW);
  return {
    ...initial,
    status: 'running',
    tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
    taskProgress: Object.fromEntries(
      tasks.map((task) => [
        task.id,
        { nonImprovingVerdicts: 0, verdictCount: 0 },
      ]),
    ),
  };
}
