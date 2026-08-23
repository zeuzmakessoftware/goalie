import { posix } from 'node:path';

import type {
  SessionState,
  SessionStatus,
  Task,
} from './schemas.js';
import { isTerminalSessionStatus } from './reducer.js';

export type BudgetLimit = 'tokens' | 'reported_cost' | 'wall_time' | 'turns';

export interface BudgetGate {
  readonly exceeded: readonly BudgetLimit[];
  readonly totalTokens: number;
  readonly reportedCostUsd: number;
  readonly costKnown: boolean;
  readonly unpricedUsageEvents: number;
}

/**
 * Limits are inclusive: a counter equal to its configured maximum is exhausted.
 * Unknown provider cost is never treated as zero; only reported cost can trip the
 * cost limit, and `costKnown` tells callers when the total is merely a lower bound.
 */
export function evaluateBudget(state: SessionState): BudgetGate {
  const policy = state.spec.budget;
  const totalTokens = state.budget.inputTokens + state.budget.outputTokens;
  const exceeded: BudgetLimit[] = [];
  if (policy.maxTokens !== undefined && totalTokens >= policy.maxTokens) {
    exceeded.push('tokens');
  }
  if (
    policy.maxCostUsd !== undefined &&
    state.budget.reportedCostUsd >= policy.maxCostUsd
  ) {
    exceeded.push('reported_cost');
  }
  if (
    policy.maxWallTimeMs !== undefined &&
    state.budget.wallTimeMs >= policy.maxWallTimeMs
  ) {
    exceeded.push('wall_time');
  }
  if (policy.maxTurns !== undefined && state.budget.turns >= policy.maxTurns) {
    exceeded.push('turns');
  }
  return {
    exceeded,
    totalTokens,
    reportedCostUsd: state.budget.reportedCostUsd,
    costKnown: state.budget.costKnown,
    unpricedUsageEvents: state.budget.unpricedUsageEvents,
  };
}

/**
 * A task plateaus only after `window` consecutive cycles with one unchanged
 * host-derived failure fingerprint and no meaningful score/criteria gain.
 */
export function getPlateauedTaskIds(state: SessionState): string[] {
  const window = state.spec.budget.plateau.window;
  return Object.values(state.tasks)
    .filter((task) => {
      if (['passed', 'cancelled'].includes(task.status)) return false;
      return (
        (state.taskProgress[task.id]?.sameFailureCount ??
          state.taskProgress[task.id]?.nonImprovingVerdicts ??
          0) >= window
      );
    })
    .map((task) => task.id)
    .sort();
}

function normalizeWriteTarget(target: string): string {
  const slashed = target.replaceAll('\\', '/');
  const normalized = posix.normalize(slashed);
  if (normalized === '.') return '';
  return normalized.replace(/\/$/u, '');
}

function containsGlob(target: string): boolean {
  return /[*?[\]{}!]/u.test(target);
}

export function writeTargetsConflict(left: string, right: string): boolean {
  const a = normalizeWriteTarget(left);
  const b = normalizeWriteTarget(right);
  if (a === '*' || b === '*') return true;
  // Unknown glob semantics are conservatively exclusive.
  if (containsGlob(a) || containsGlob(b)) return true;
  if (a === '' || b === '') return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function writeSetsConflict(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.some((a) => right.some((b) => writeTargetsConflict(a, b)));
}

export interface DependencyGraphAnalysis {
  readonly valid: boolean;
  readonly unknownDependencies: Readonly<Record<string, readonly string[]>>;
  readonly cycles: readonly (readonly string[])[];
}

/** Deterministic DFS analysis; each cycle is reported once in sorted order. */
export function analyzeDependencyGraph(
  tasks: Readonly<Record<string, Task>>,
): DependencyGraphAnalysis {
  const unknownDependencies: Record<string, string[]> = {};
  for (const task of Object.values(tasks)) {
    const unknown = task.dependencies.filter((id) => !tasks[id]).sort();
    if (unknown.length > 0) unknownDependencies[task.id] = unknown;
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycleKeys = new Set<string>();
  const cycles: string[][] = [];

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      const members = [...new Set(cycle)].sort();
      const key = members.join('\0');
      if (!cycleKeys.has(key)) {
        cycleKeys.add(key);
        cycles.push(members);
      }
      return;
    }
    visiting.add(id);
    stack.push(id);
    for (const dependency of tasks[id]?.dependencies ?? []) {
      if (tasks[dependency]) visit(dependency);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of Object.keys(tasks).sort()) visit(id);
  cycles.sort((a, b) => a.join('\0').localeCompare(b.join('\0')));
  return {
    valid:
      Object.keys(unknownDependencies).length === 0 && cycles.length === 0,
    unknownDependencies,
    cycles,
  };
}

export type TaskBlockReason =
  | 'unknown_dependency'
  | 'unmet_dependency'
  | 'terminal_dependency'
  | 'write_conflict'
  | 'plateau'
  | 'attempts_exhausted'
  | 'not_runnable';

export interface BlockedTask {
  readonly taskId: string;
  readonly reason: TaskBlockReason;
  readonly relatedIds: readonly string[];
}

export type ScheduleDecision =
  | {
      readonly kind: 'schedule';
      readonly taskIds: readonly string[];
      readonly blocked: readonly BlockedTask[];
      readonly budget: BudgetGate;
    }
  | {
      readonly kind: 'wait';
      readonly reason: 'not_running' | 'workers_active' | 'dependencies';
      readonly blocked: readonly BlockedTask[];
      readonly budget: BudgetGate;
    }
  | {
      readonly kind: 'transition';
      readonly status: Extract<
        SessionStatus,
        'achieved' | 'paused_budget' | 'paused_plateau' | 'blocked'
      >;
      readonly reason: string;
      readonly blocked: readonly BlockedTask[];
      readonly budget: BudgetGate;
    }
  | {
      readonly kind: 'terminal';
      readonly status: SessionStatus;
      readonly reason?: string;
      readonly blocked: readonly BlockedTask[];
      readonly budget: BudgetGate;
    };

function taskOrder(left: Task, right: Task): number {
  return (
    right.priority - left.priority ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function blockedTask(
  taskId: string,
  reason: TaskBlockReason,
  relatedIds: readonly string[] = [],
): BlockedTask {
  return { taskId, reason, relatedIds: [...relatedIds].sort() };
}

/**
 * Selects a deterministic maximal set under the priority ordering. This is not
 * a maximum-cardinality packing: higher-priority work intentionally wins.
 */
export function decideSchedule(state: SessionState): ScheduleDecision {
  const budget = evaluateBudget(state);
  const blocked: BlockedTask[] = [];
  const tasks = Object.values(state.tasks);
  const required = tasks.filter((task) => task.required);

  if (isTerminalSessionStatus(state.status)) {
    return {
      kind: 'terminal',
      status: state.status,
      ...(state.statusReason === undefined ? {} : { reason: state.statusReason }),
      blocked,
      budget,
    };
  }

  // Success takes precedence when the final passing verdict and a budget event
  // coexist in a replayed batch: no more work is needed, so no pause is useful.
  if (required.length > 0 && required.every((task) => task.status === 'passed')) {
    return {
      kind: 'transition',
      status: 'achieved',
      reason: 'All required tasks passed',
      blocked,
      budget,
    };
  }

  if (budget.exceeded.length > 0) {
    return {
      kind: 'transition',
      status: 'paused_budget',
      reason: `Budget limit reached: ${budget.exceeded.join(', ')}`,
      blocked,
      budget,
    };
  }

  const plateaued = new Set(getPlateauedTaskIds(state));
  const requiredPlateaus = required
    .filter((task) => plateaued.has(task.id))
    .map((task) => task.id)
    .sort();
  if (requiredPlateaus.length > 0) {
    for (const taskId of requiredPlateaus) {
      blocked.push(blockedTask(taskId, 'plateau'));
    }
    return {
      kind: 'transition',
      status: 'paused_plateau',
      reason: `Required task plateaued: ${requiredPlateaus.join(', ')}`,
      blocked,
      budget,
    };
  }

  if (state.status !== 'running') {
    return {
      kind: 'wait',
      reason: 'not_running',
      blocked,
      budget,
    };
  }

  const graph = analyzeDependencyGraph(state.tasks);
  if (!graph.valid) {
    for (const [taskId, ids] of Object.entries(graph.unknownDependencies)) {
      blocked.push(blockedTask(taskId, 'unknown_dependency', ids));
    }
    for (const cycle of graph.cycles) {
      for (const taskId of cycle) {
        if (!blocked.some((entry) => entry.taskId === taskId)) {
          blocked.push(blockedTask(taskId, 'unmet_dependency', cycle));
        }
      }
    }
    return {
      kind: 'transition',
      status: 'blocked',
      reason: 'Task dependency graph is invalid',
      blocked: blocked.sort((a, b) => a.taskId.localeCompare(b.taskId)),
      budget,
    };
  }

  const running = tasks.filter((task) => task.status === 'running');
  const availableSlots = Math.max(
    0,
    state.spec.budget.maxConcurrency - running.length,
  );
  const selected: Task[] = [];
  const candidates = tasks
    .filter((task) => ['pending', 'ready'].includes(task.status))
    .sort(taskOrder);

  for (const task of candidates) {
    if (plateaued.has(task.id)) {
      blocked.push(blockedTask(task.id, 'plateau'));
      continue;
    }
    if (task.maxAttempts !== undefined && task.attempts >= task.maxAttempts) {
      blocked.push(blockedTask(task.id, 'attempts_exhausted'));
      continue;
    }
    const terminalDependencies = task.dependencies.filter((dependencyId) => {
      const status = state.tasks[dependencyId]?.status;
      return status !== undefined && ['failed', 'blocked', 'cancelled'].includes(status);
    });
    if (terminalDependencies.length > 0) {
      blocked.push(
        blockedTask(task.id, 'terminal_dependency', terminalDependencies),
      );
      continue;
    }
    const unmet = task.dependencies.filter(
      (dependencyId) => state.tasks[dependencyId]?.status !== 'passed',
    );
    if (unmet.length > 0) {
      blocked.push(blockedTask(task.id, 'unmet_dependency', unmet));
      continue;
    }
    const conflicting = [...running, ...selected]
      .filter((other) => writeSetsConflict(task.writeSet, other.writeSet))
      .map((other) => other.id);
    if (conflicting.length > 0) {
      blocked.push(blockedTask(task.id, 'write_conflict', conflicting));
      continue;
    }
    if (selected.length < availableSlots) selected.push(task);
  }

  if (selected.length > 0) {
    return {
      kind: 'schedule',
      taskIds: selected.map((task) => task.id),
      blocked: blocked.sort((a, b) => a.taskId.localeCompare(b.taskId)),
      budget,
    };
  }
  if (running.length > 0) {
    return { kind: 'wait', reason: 'workers_active', blocked, budget };
  }
  const requiredTerminalFailure = required.some((task) =>
    ['failed', 'blocked', 'cancelled'].includes(task.status),
  );
  const requiredCannotContinue = blocked.some(
    (entry) =>
      state.tasks[entry.taskId]?.required === true &&
      ['attempts_exhausted', 'terminal_dependency'].includes(entry.reason),
  );
  if (requiredTerminalFailure || requiredCannotContinue) {
    return {
      kind: 'transition',
      status: 'blocked',
      reason: 'A required task cannot continue',
      blocked,
      budget,
    };
  }
  return { kind: 'wait', reason: 'dependencies', blocked, budget };
}
