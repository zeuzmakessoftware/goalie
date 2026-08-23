import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createInitialUiState,
  reduceUiState,
  resolveDisplayPreferences,
  resolveLayout,
  resolveNavigationIntent,
  visibleAgentTabs,
} from '../../src/ui/model.js';
import type { AgentSnapshot } from '../../src/ui/types.js';

const agents: readonly AgentSnapshot[] = [
  { id: 'captain', name: 'Captain', role: 'orchestrator', status: 'working' },
  { id: 'builder', name: 'Builder', role: 'worker', status: 'working' },
  { id: 'critic', name: 'Critic', role: 'critic', status: 'waiting' },
];

test('layout selector covers broadcast, split, compact, and minimal terminals', () => {
  assert.equal(resolveLayout({ columns: 140, rows: 40 }), 'wide');
  assert.equal(resolveLayout({ columns: 100, rows: 28 }), 'standard');
  assert.equal(resolveLayout({ columns: 70, rows: 20 }), 'compact');
  assert.equal(resolveLayout({ columns: 50, rows: 15 }), 'minimal');
});

test('agent reducer wraps tabs and repairs a vanished selection', () => {
  let state = createInitialUiState(agents);
  state = reduceUiState(state, {
    type: 'cycle-agent',
    direction: -1,
    agents,
  });
  assert.equal(state.selectedAgentId, 'critic');

  state = reduceUiState(state, {
    type: 'reconcile-agents',
    agents: agents.slice(0, 2),
  });
  assert.equal(state.selectedAgentId, 'captain');
});

test('prompt composition protects unmodified navigation characters', () => {
  assert.deepEqual(resolveNavigationIntent('1', {}, 'compose'), { type: 'none' });
  assert.deepEqual(resolveNavigationIntent('t', {}, 'compose'), { type: 'none' });
  assert.deepEqual(resolveNavigationIntent('n', { ctrl: true }, 'compose'), {
    type: 'next-agent',
  });
  assert.deepEqual(resolveNavigationIntent('', { escape: true }, 'compose'), {
    type: 'stop-compose',
  });
});

test('navigation mode exposes direct tabs and panes', () => {
  assert.deepEqual(resolveNavigationIntent('2', {}, 'navigation'), {
    type: 'select-agent-index',
    index: 1,
  });
  assert.deepEqual(resolveNavigationIntent('e', {}, 'navigation'), {
    type: 'select-pane',
    pane: 'evidence',
  });
  assert.deepEqual(resolveNavigationIntent('c', { ctrl: true }, 'navigation'), {
    type: 'interrupt',
  });
  assert.deepEqual(resolveNavigationIntent('q', {}, 'navigation'), {
    type: 'exit',
  });
});

test('tab window retains the selected agent without changing shortcut order', () => {
  const many = Array.from({ length: 8 }, (_, index): AgentSnapshot => ({
    id: `a${index}`,
    name: `Agent ${index}`,
    role: 'worker',
    status: 'working',
  }));
  const result = visibleAgentTabs(many, 'a6', 3);
  assert.deepEqual(result.agents.map(agent => agent.id), ['a5', 'a6', 'a7']);
  assert.equal(result.hidden, 5);
});

test('NO_COLOR and motion environment switches resolve independently', () => {
  assert.deepEqual(
    resolveDisplayPreferences(
      { NO_COLOR: '', GOALIE_NO_ANIMATION: '1', LANG: 'en_US.UTF-8' },
      'auto',
      'auto',
    ),
    { color: false, reducedMotion: true, textOnly: true, asciiOnly: false },
  );
  assert.deepEqual(
    resolveDisplayPreferences({ TERM: 'dumb' }, 'color', 'full'),
    { color: true, reducedMotion: false, textOnly: false, asciiOnly: true },
  );
});
