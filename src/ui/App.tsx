import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, useInput, useStdout } from 'ink';
import {
  ANIMATION_SEQUENCES,
  advanceAnimation,
  animationEventFromVerdict,
  createAnimationQueueState,
  enqueueAnimation,
} from './animation.js';
import type { AnimationEvent, AnimationQueueState } from './animation.js';
import {
  AgentTabs,
  BroadcastBody,
  HelpPane,
  PaneTabs,
  PromptBar,
  Scoreboard,
} from './components.js';
import {
  createInitialUiState,
  reduceUiState,
  resolveDisplayPreferences,
  resolveLayout,
  resolveNavigationIntent,
  selectAgent,
} from './model.js';
import { sanitizeTerminalText } from './sanitize.js';
import type { AppProps, CriticVerdict, TerminalSize } from './types.js';

interface Playback {
  event: AnimationEvent | null;
  frame: number;
  replay: () => void;
}

function normalizeTerminalSize(size: Partial<TerminalSize>): TerminalSize {
  const columns = Number.isFinite(size.columns) ? Math.floor(size.columns ?? 100) : 100;
  const rows = Number.isFinite(size.rows) ? Math.floor(size.rows ?? 30) : 30;
  return { columns: Math.max(1, columns), rows: Math.max(1, rows) };
}

function useTerminalSize(override: TerminalSize | undefined): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() =>
    normalizeTerminalSize(
      override ?? { columns: stdout.columns ?? 100, rows: stdout.rows ?? 30 },
    ),
  );

  useEffect(() => {
    if (override) {
      setSize(normalizeTerminalSize(override));
      return;
    }

    const update = () => {
      setSize(
        normalizeTerminalSize({
          columns: stdout.columns ?? 100,
          rows: stdout.rows ?? 30,
        }),
      );
    };
    update();
    stdout.on('resize', update);
    return () => {
      stdout.off('resize', update);
    };
  }, [override?.columns, override?.rows, stdout]);

  return size;
}

function useVerdictPlayback(
  verdicts: readonly CriticVerdict[],
  treatInitialVerdictsAsHistory: boolean,
  reducedMotion: boolean,
  frameMs: number,
): Playback {
  const [queue, setQueue] = useState<AnimationQueueState>(createAnimationQueueState);
  const [frame, setFrame] = useState(0);
  const [lastEvent, setLastEvent] = useState<AnimationEvent | null>(null);
  const replayCount = useRef(0);

  const verdictEvents = useMemo(
    () =>
      verdicts
        .filter(verdict => verdict.status !== 'streaming')
        .map(verdict => animationEventFromVerdict(verdict)),
    [verdicts],
  );

  // A live resume mounts with a reconstructed verdict history. Those entries
  // are already part of the broadcast and must not all fire again. Replay, on
  // the other hand, mounts with an empty history and appends entries over time,
  // so every appended key remains eligible. Hosts that use latestVerdict are
  // signalling a single new result rather than supplying reconstructed history.
  const processedEventKeys = useRef<Set<string> | null>(null);
  if (processedEventKeys.current === null) {
    processedEventKeys.current = new Set(
      treatInitialVerdictsAsHistory
        ? verdictEvents.map(event => event.key)
        : [],
    );
  }

  useEffect(() => {
    const processed = processedEventKeys.current;
    if (!processed || verdictEvents.length === 0) return;
    const appended = verdictEvents.filter(event => !processed.has(event.key));
    if (appended.length === 0) return;
    for (const event of appended) processed.add(event.key);
    setQueue(current =>
      appended.reduce(
        (next, event) => enqueueAnimation(next, event, 32),
        current,
      ),
    );
  }, [verdictEvents]);

  const active = queue.active;
  useEffect(() => {
    if (!active) {
      setFrame(0);
      return;
    }

    const frames = ANIMATION_SEQUENCES[active.kind].frames;
    let cursor = reducedMotion ? frames.length - 1 : 0;
    setFrame(cursor);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      if (!reducedMotion && cursor < frames.length - 1) {
        cursor += 1;
        setFrame(cursor);
        timer = setTimeout(tick, frameMs);
        return;
      }

      setLastEvent(active);
      setQueue(current =>
        current.active?.key === active.key ? advanceAnimation(current) : current,
      );
    };

    timer = setTimeout(tick, reducedMotion ? Math.max(650, frameMs) : frameMs);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active?.key, frameMs, reducedMotion]);

  const replay = useCallback(() => {
    const source = lastEvent ?? queue.active;
    if (!source) return;
    replayCount.current += 1;
    const replayEvent: AnimationEvent = {
      ...source,
      key: `${source.key}:replay:${replayCount.current}`,
    };
    setQueue(current => enqueueAnimation(current, replayEvent, 32));
  }, [lastEvent, queue.active]);

  return { event: active, frame, replay };
}

/** Programmatic Ink root. It never calls process.exit; the host owns lifecycle. */
export function App({
  session,
  interactive = true,
  terminalSize,
  colorMode = 'auto',
  motionMode = 'auto',
  env = process.env,
  animationFrameMs = 110,
  onSubmitPrompt,
  onExit,
  onInterrupt,
  onPause,
  onAgentChange,
}: AppProps) {
  const size = useTerminalSize(terminalSize);
  const preferences = useMemo(
    () => resolveDisplayPreferences(env, colorMode, motionMode),
    [colorMode, env, motionMode],
  );
  const layout = resolveLayout(size);
  const [ui, dispatch] = useReducer(
    reduceUiState,
    session.agents,
    createInitialUiState,
  );
  const [draft, setDraft] = useState('');
  const verdicts = useMemo<readonly CriticVerdict[]>(
    () =>
      session.verdicts ??
      (session.latestVerdict === undefined ? [] : [session.latestVerdict]),
    [session.latestVerdict, session.verdicts],
  );
  const playback = useVerdictPlayback(
    verdicts,
    session.verdicts !== undefined,
    preferences.reducedMotion,
    Math.max(40, animationFrameMs),
  );

  useEffect(() => {
    dispatch({ type: 'reconcile-agents', agents: session.agents });
  }, [session.agents]);

  useEffect(() => {
    if (ui.selectedAgentId) onAgentChange?.(ui.selectedAgentId);
  }, [onAgentChange, ui.selectedAgentId]);

  const applyIntent = useCallback(
    (intent: ReturnType<typeof resolveNavigationIntent>) => {
      switch (intent.type) {
        case 'none':
          return false;
        case 'next-agent':
          dispatch({ type: 'cycle-agent', direction: 1, agents: session.agents });
          return true;
        case 'previous-agent':
          dispatch({ type: 'cycle-agent', direction: -1, agents: session.agents });
          return true;
        case 'select-agent-index': {
          const agent = session.agents[intent.index];
          if (agent) dispatch({ type: 'select-agent', agentId: agent.id });
          return true;
        }
        case 'select-pane':
          dispatch({ type: 'select-pane', pane: intent.pane });
          return true;
        case 'compose':
          dispatch({ type: 'set-input-mode', mode: 'compose' });
          return true;
        case 'stop-compose':
          dispatch({ type: 'set-input-mode', mode: 'navigation' });
          return true;
        case 'toggle-help':
          dispatch({ type: 'toggle-help' });
          return true;
        case 'replay':
          playback.replay();
          return true;
        case 'pause':
          onPause?.();
          return true;
        case 'interrupt':
          onInterrupt?.();
          return true;
        case 'exit':
          onExit?.();
          return true;
      }
    },
    [onExit, onInterrupt, onPause, playback.replay, session.agents],
  );

  useInput(
    (input, key) => {
      const intent = resolveNavigationIntent(input, key, ui.inputMode);
      if (applyIntent(intent)) return;
      if (ui.inputMode !== 'compose') return;

      if (key.return) {
        const prompt = draft.trim();
        if (prompt) onSubmitPrompt?.(prompt);
        setDraft('');
        dispatch({ type: 'set-input-mode', mode: 'navigation' });
        return;
      }
      if (key.backspace || key.delete) {
        setDraft(current => Array.from(current).slice(0, -1).join(''));
        return;
      }
      if (key.ctrl || key.meta || key.tab || !input) return;
      const safeInput = sanitizeTerminalText(input, {
        maxLength: 1_000,
        preserveNewlines: false,
      });
      setDraft(current => `${current}${safeInput}`.slice(0, 4_000));
    },
    { isActive: interactive },
  );

  const selectedAgent = selectAgent(session, ui.selectedAgentId);
  const replay = playback.event
    ? { event: playback.event, frame: playback.frame }
    : null;

  return (
    <Box flexDirection="column" width={size.columns}>
      <Scoreboard session={session} preferences={preferences} layout={layout} />
      <AgentTabs
        agents={session.agents}
        selectedAgentId={ui.selectedAgentId}
        width={size.columns}
        preferences={preferences}
      />
      <PaneTabs
        activePane={ui.activePane}
        preferences={preferences}
        compact={layout === 'minimal'}
      />
      {ui.helpVisible ? (
        <HelpPane preferences={preferences} />
      ) : (
        <BroadcastBody
          session={session}
          selectedAgent={selectedAgent}
          selectedAgentId={ui.selectedAgentId}
          activePane={ui.activePane}
          layout={layout}
          size={size}
          preferences={preferences}
          replay={replay}
        />
      )}
      <PromptBar
        draft={draft}
        composing={ui.inputMode === 'compose'}
        interactive={interactive}
        paused={session.status === 'paused'}
        preferences={preferences}
      />
    </Box>
  );
}

export default App;
