import type {
  AgentSnapshot,
  BroadcastSession,
  DisplayPreferences,
  LayoutMode,
  PaneId,
  TerminalSize,
  TranscriptEntry,
} from './types.js';

export interface UiState {
  selectedAgentId: string | null;
  activePane: PaneId;
  inputMode: 'navigation' | 'compose';
  helpVisible: boolean;
}

export type UiAction =
  | { type: 'select-agent'; agentId: string }
  | { type: 'cycle-agent'; direction: 1 | -1; agents: readonly AgentSnapshot[] }
  | { type: 'select-pane'; pane: PaneId }
  | { type: 'cycle-pane'; direction: 1 | -1 }
  | { type: 'set-input-mode'; mode: UiState['inputMode'] }
  | { type: 'toggle-help' }
  | { type: 'reconcile-agents'; agents: readonly AgentSnapshot[] };

export interface NavigationKey {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  tab?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  escape?: boolean;
  return?: boolean;
}

export type NavigationIntent =
  | { type: 'none' }
  | { type: 'next-agent' }
  | { type: 'previous-agent' }
  | { type: 'select-agent-index'; index: number }
  | { type: 'select-pane'; pane: PaneId }
  | { type: 'compose' }
  | { type: 'stop-compose' }
  | { type: 'toggle-help' }
  | { type: 'replay' }
  | { type: 'pause' }
  | { type: 'interrupt' }
  | { type: 'exit' };

export function createInitialUiState(
  agents: readonly AgentSnapshot[],
): UiState {
  return {
    selectedAgentId: agents[0]?.id ?? null,
    activePane: 'transcript',
    inputMode: 'navigation',
    helpVisible: false,
  };
}

export function reduceUiState(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'select-agent':
      return { ...state, selectedAgentId: action.agentId };
    case 'cycle-agent': {
      if (action.agents.length === 0) return { ...state, selectedAgentId: null };
      const selectedIndex = action.agents.findIndex(
        agent => agent.id === state.selectedAgentId,
      );
      const currentIndex = selectedIndex < 0 ? 0 : selectedIndex;
      const nextIndex =
        (currentIndex + action.direction + action.agents.length) %
        action.agents.length;
      return {
        ...state,
        selectedAgentId: action.agents[nextIndex]?.id ?? null,
      };
    }
    case 'select-pane':
      return { ...state, activePane: action.pane };
    case 'cycle-pane': {
      const panes: readonly PaneId[] = ['transcript', 'tactics', 'evidence'];
      const index = panes.indexOf(state.activePane);
      const nextIndex = (index + action.direction + panes.length) % panes.length;
      return { ...state, activePane: panes[nextIndex] ?? 'transcript' };
    }
    case 'set-input-mode':
      return { ...state, inputMode: action.mode };
    case 'toggle-help':
      return { ...state, helpVisible: !state.helpVisible };
    case 'reconcile-agents': {
      if (action.agents.some(agent => agent.id === state.selectedAgentId)) {
        return state;
      }
      return { ...state, selectedAgentId: action.agents[0]?.id ?? null };
    }
  }
}

/**
 * Global navigation is deliberately limited to modified keys while composing,
 * so normal prompt text can never unexpectedly switch tabs or panes.
 */
export function resolveNavigationIntent(
  input: string,
  key: NavigationKey,
  inputMode: UiState['inputMode'],
): NavigationIntent {
  const normalized = input.toLowerCase();

  if (key.ctrl && (key.rightArrow || normalized === 'n')) {
    return { type: 'next-agent' };
  }
  if (key.ctrl && (key.leftArrow || normalized === 'p')) {
    return { type: 'previous-agent' };
  }
  if (key.meta && /^[1-9]$/.test(normalized)) {
    return { type: 'select-agent-index', index: Number(normalized) - 1 };
  }
  if (key.ctrl && normalized === 'r') return { type: 'replay' };
  if (key.ctrl && normalized === 'c') return { type: 'interrupt' };

  if (inputMode === 'compose') {
    return key.escape ? { type: 'stop-compose' } : { type: 'none' };
  }

  if (key.tab) {
    return key.shift ? { type: 'previous-agent' } : { type: 'next-agent' };
  }
  if (/^[1-9]$/.test(normalized)) {
    return { type: 'select-agent-index', index: Number(normalized) - 1 };
  }
  if (normalized === 't') return { type: 'select-pane', pane: 'transcript' };
  if (normalized === 'a') return { type: 'select-pane', pane: 'tactics' };
  if (normalized === 'e') return { type: 'select-pane', pane: 'evidence' };
  if (normalized === 'i' || normalized === '/') return { type: 'compose' };
  if (normalized === '?') return { type: 'toggle-help' };
  if (normalized === 'r') return { type: 'replay' };
  if (normalized === 'p') return { type: 'pause' };
  if (normalized === 'q') return { type: 'exit' };
  return { type: 'none' };
}

export function resolveLayout(size: TerminalSize): LayoutMode {
  if (size.columns >= 118 && size.rows >= 30) return 'wide';
  if (size.columns >= 88 && size.rows >= 24) return 'standard';
  if (size.columns >= 62 && size.rows >= 18) return 'compact';
  return 'minimal';
}

export function resolveDisplayPreferences(
  env: Readonly<Record<string, string | undefined>>,
  colorMode: 'auto' | 'color' | 'none' = 'auto',
  motionMode: 'auto' | 'full' | 'reduced' | 'none' = 'auto',
): DisplayPreferences {
  const noColor = Object.prototype.hasOwnProperty.call(env, 'NO_COLOR');
  const color = colorMode === 'color' || (colorMode === 'auto' && !noColor);
  const truthy = (value: string | undefined) =>
    value !== undefined && !['', '0', 'false', 'no'].includes(value.toLowerCase());
  const textOnly =
    motionMode === 'none' ||
    (motionMode === 'auto' && truthy(env.GOALIE_NO_ANIMATION));
  const reducedMotion =
    textOnly ||
    motionMode === 'reduced' ||
    (motionMode === 'auto' &&
      (truthy(env.GOALIE_REDUCED_MOTION) ||
        env.TERM === 'dumb'));
  const locale = `${env.LC_ALL ?? ''}${env.LC_CTYPE ?? ''}${env.LANG ?? ''}`;
  const asciiOnly =
    truthy(env.GOALIE_ASCII) || env.TERM === 'dumb' || (!!locale && !/utf-?8/i.test(locale));

  return { color, reducedMotion, textOnly, asciiOnly };
}

export function selectAgent(
  session: BroadcastSession,
  selectedAgentId: string | null,
): AgentSnapshot | undefined {
  return (
    session.agents.find(agent => agent.id === selectedAgentId) ?? session.agents[0]
  );
}

export function selectTranscript(
  entries: readonly TranscriptEntry[],
  selectedAgentId: string | null,
): readonly TranscriptEntry[] {
  return entries.filter(
    entry => entry.agentId === undefined || entry.agentId === selectedAgentId,
  );
}

export function tail<T>(items: readonly T[], count: number): readonly T[] {
  if (count <= 0) return [];
  return items.slice(Math.max(0, items.length - count));
}

export function visibleAgentTabs(
  agents: readonly AgentSnapshot[],
  selectedAgentId: string | null,
  capacity: number,
): { agents: readonly AgentSnapshot[]; hidden: number } {
  if (agents.length <= capacity) return { agents, hidden: 0 };
  const safeCapacity = Math.max(1, capacity);
  const selectedIndex = Math.max(
    0,
    agents.findIndex(agent => agent.id === selectedAgentId),
  );
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(safeCapacity / 2)),
    Math.max(0, agents.length - safeCapacity),
  );
  const visible = agents.slice(start, start + safeCapacity);
  return { agents: visible, hidden: agents.length - visible.length };
}
