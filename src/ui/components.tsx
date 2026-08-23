import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { ANIMATION_SEQUENCES } from './animation.js';
import type { AnimationEvent } from './animation.js';
import { selectTranscript, tail, visibleAgentTabs } from './model.js';
import { clipText, singleLine } from './sanitize.js';
import type {
  AgentSnapshot,
  BroadcastSession,
  DisplayPreferences,
  EvidenceItem,
  LayoutMode,
  PaneId,
  TacticalItem,
  TerminalSize,
  TranscriptEntry,
} from './types.js';

type Accent =
  | 'blue'
  | 'cyan'
  | 'gray'
  | 'green'
  | 'magenta'
  | 'red'
  | 'white'
  | 'yellow';

function textColor(
  preferences: DisplayPreferences,
  color: Accent,
): { color?: Accent } {
  return preferences.color ? { color } : {};
}

function borderColor(
  preferences: DisplayPreferences,
  color: Accent,
): { borderColor?: Accent } {
  return preferences.color ? { borderColor: color } : {};
}

function statusColor(status: AgentSnapshot['status']): Accent {
  switch (status) {
    case 'working':
      return 'cyan';
    case 'done':
      return 'green';
    case 'blocked':
      return 'yellow';
    case 'failed':
      return 'red';
    case 'waiting':
      return 'magenta';
    case 'idle':
      return 'gray';
  }
}

function statusGlyph(
  status: AgentSnapshot['status'],
  asciiOnly: boolean,
): string {
  const ascii: Record<AgentSnapshot['status'], string> = {
    idle: 'o',
    working: '*',
    waiting: '.',
    done: '+',
    blocked: '!',
    failed: 'x',
  };
  const unicode: Record<AgentSnapshot['status'], string> = {
    idle: '○',
    working: '●',
    waiting: '◌',
    done: '✓',
    blocked: '!',
    failed: '×',
  };
  return (asciiOnly ? ascii : unicode)[status];
}

function evidenceGlyph(
  status: EvidenceItem['status'],
  asciiOnly: boolean,
): string {
  const ascii: Record<EvidenceItem['status'], string> = {
    pass: '+',
    fail: 'x',
    running: '*',
    pending: '.',
  };
  const unicode: Record<EvidenceItem['status'], string> = {
    pass: '✓',
    fail: '×',
    running: '●',
    pending: '○',
  };
  return (asciiOnly ? ascii : unicode)[status];
}

function evidenceColor(status: EvidenceItem['status']): Accent {
  switch (status) {
    case 'pass':
      return 'green';
    case 'fail':
      return 'red';
    case 'running':
      return 'cyan';
    case 'pending':
      return 'gray';
  }
}

function formatElapsed(elapsedMs: number | undefined): string {
  const totalSeconds = Math.max(0, Math.floor((elapsedMs ?? 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map(part => String(part).padStart(2, '0')).join(':');
}

function ratio(current: number, limit: number | undefined): string {
  return limit === undefined ? String(current) : `${current}/${limit}`;
}

function isDefenseAgent(agent: AgentSnapshot): boolean {
  return /critic|auditor|review|defen|var/i.test(
    `${agent.role} ${agent.id} ${agent.name}`,
  );
}

function agentPriority(agent: AgentSnapshot): number {
  const statusPriority: Record<AgentSnapshot['status'], number> = {
    working: 6,
    waiting: 5,
    blocked: 4,
    failed: 3,
    done: 2,
    idle: 1,
  };
  return statusPriority[agent.status];
}

function representativeAgent(
  agents: readonly AgentSnapshot[],
  side: 'offense' | 'defense',
): AgentSnapshot | undefined {
  const candidates = agents.filter(agent =>
    side === 'defense'
      ? isDefenseAgent(agent)
      : !isDefenseAgent(agent) && agent.role !== 'system',
  );
  const sideAffinity = (agent: AgentSnapshot) => {
    if (side === 'defense') return /critic|var/i.test(`${agent.role} ${agent.name}`) ? 3 : 1;
    return agent.role === 'worker' ? 3 : 1;
  };
  return [...candidates].sort(
    (left, right) =>
      agentPriority(right) * 10 + sideAffinity(right) -
      (agentPriority(left) * 10 + sideAffinity(left)),
  )[0];
}

function reviewScore(score: number | undefined): string {
  if (score === undefined || !Number.isFinite(score)) return 'PENDING';
  const normalized = Math.abs(score) <= 1 ? Math.abs(score) * 100 : Math.abs(score);
  return `${Math.min(100, Math.round(normalized))}/100`;
}

function sideLabel(
  side: 'offense' | 'defense',
  agent: AgentSnapshot | undefined,
  preferences: DisplayPreferences,
): ReactNode {
  const color: Accent = side === 'offense' ? 'cyan' : 'yellow';
  return (
    <Text>
      <Text bold {...textColor(preferences, color)}>{side.toUpperCase()}</Text>
      <Text {...textColor(preferences, 'gray')}> // </Text>
      {agent ? (
        <Text bold {...textColor(preferences, statusColor(agent.status))}>
          {statusGlyph(agent.status, preferences.asciiOnly)} {clipText(agent.name.toUpperCase(), 18)}
        </Text>
      ) : (
        <Text {...textColor(preferences, 'gray')}>WAITING FOR LINEUP</Text>
      )}
    </Text>
  );
}

/** Keeps the core offense/defense loop visible while a detailed agent tab is selected. */
export function AgentMatchup({
  session,
  preferences,
  layout,
}: {
  session: BroadcastSession;
  preferences: DisplayPreferences;
  layout: LayoutMode;
}) {
  const offense = representativeAgent(session.agents, 'offense');
  const defense = representativeAgent(session.agents, 'defense');
  const verdict = session.latestVerdict ?? session.verdicts?.at(-1);
  const verdictLabel = verdict?.status === 'streaming'
    ? 'REVIEWING'
    : verdict?.overall === 'pass' || verdict?.direction === 'positive'
      ? 'APPROVED'
      : verdict?.overall === 'fail' || verdict?.direction === 'negative'
        ? 'REVISION'
        : 'PENDING';
  const arrow = preferences.asciiOnly ? '>>' : '▶';

  if (layout === 'minimal' || layout === 'compact') {
    return (
      <Box justifyContent="space-between">
        <Text>
          {sideLabel('offense', offense, preferences)}{' '}
          <Text bold {...textColor(preferences, 'green')}>{arrow}</Text>{' '}
          {sideLabel('defense', defense, preferences)}
        </Text>
        {layout === 'compact' ? (
          <Text bold {...textColor(preferences, verdictLabel === 'APPROVED' ? 'green' : 'yellow')}>
            {verdictLabel} {reviewScore(verdict?.score)}
          </Text>
        ) : null}
      </Box>
    );
  }

  const offenseTask = singleLine(offense?.currentTask ?? 'Preparing the best attempt', 50);
  const defenseTask = singleLine(
    defense?.currentTask ?? verdict?.summary ?? 'Scrutinizing evidence and output',
    50,
  );

  return (
    <Box
      borderStyle={preferences.asciiOnly ? 'classic' : 'single'}
      {...borderColor(preferences, 'cyan')}
      paddingX={1}
    >
      <Box width="45%" flexDirection="column">
        {sideLabel('offense', offense, preferences)}
        <Text wrap="truncate-end">
          <Text {...textColor(preferences, 'gray')}>ATTACK </Text>{offenseTask}
        </Text>
      </Box>
      <Box width="10%" alignItems="center" justifyContent="center" flexDirection="column">
        <Text bold {...textColor(preferences, 'green')}>{arrow}</Text>
        <Text {...textColor(preferences, 'gray')}>HANDOFF</Text>
      </Box>
      <Box width="45%" flexDirection="column">
        <Box justifyContent="space-between">
          {sideLabel('defense', defense, preferences)}
          <Text bold {...textColor(preferences, verdictLabel === 'APPROVED' ? 'green' : 'yellow')}>
            {verdictLabel} {reviewScore(verdict?.score)}
          </Text>
        </Box>
        <Text wrap="truncate-end">
          <Text {...textColor(preferences, 'gray')}>REVIEW </Text>{defenseTask}
        </Text>
      </Box>
    </Box>
  );
}

export interface PanelProps {
  title: string;
  preferences: DisplayPreferences;
  active?: boolean;
  children: ReactNode;
  width?: number | string;
  height?: number | string;
  flexGrow?: number;
}

export function Panel({
  title,
  preferences,
  active = false,
  children,
  width,
  height,
  flexGrow,
}: PanelProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle={preferences.asciiOnly ? 'classic' : 'single'}
      {...borderColor(preferences, active ? 'cyan' : 'gray')}
      paddingX={1}
      width={width}
      height={height}
      flexGrow={flexGrow}
    >
      <Text bold {...textColor(preferences, active ? 'cyan' : 'white')}>
        {singleLine(title, 80)}
      </Text>
      {children}
    </Box>
  );
}

export function Scoreboard({
  session,
  preferences,
  layout,
}: {
  session: BroadcastSession;
  preferences: DisplayPreferences;
  layout: LayoutMode;
}) {
  const budget =
    session.budgetUsed === undefined
      ? 'OPEN'
      : ratio(session.budgetUsed, session.budgetLimit);
  const heading = `GOALIE // ${singleLine(session.title || 'GAUNTLET CUP', 44)}`;
  const status = session.status.toUpperCase();
  const score = `GOALS ${session.score.goals} : ${session.score.saves} SAVES${
    session.score.reviews ? ` : ${session.score.reviews} VAR` : ''
  }`;
  const details = [
    `LOOP ${ratio(session.loop, session.loopLimit)}`,
    `CHECK ${ratio(session.checkpoint, session.checkpointLimit)}`,
    `TIME ${formatElapsed(session.elapsedMs)}`,
    `BUDGET ${budget}`,
  ];

  if (layout === 'minimal') {
    return (
      <Box justifyContent="space-between">
        <Text bold {...textColor(preferences, 'cyan')}>
          {clipText(heading, 30)}
        </Text>
        <Text {...textColor(preferences, session.status === 'failed' ? 'red' : 'green')}>
          {score}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle={preferences.asciiOnly ? 'classic' : 'double'}
      {...borderColor(preferences, 'green')}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text bold {...textColor(preferences, 'green')}>
          {heading}
        </Text>
        <Text bold {...textColor(preferences, session.status === 'failed' ? 'red' : 'cyan')}>
          {status} // {singleLine(session.phase, 24).toUpperCase()}
        </Text>
      </Box>
      {session.objective ? (
        <Text {...textColor(preferences, 'gray')} wrap="truncate-end">
          <Text bold {...textColor(preferences, 'cyan')}>MISSION // </Text>
          {singleLine(session.objective, layout === 'wide' ? 180 : 100)}
        </Text>
      ) : null}
      <Box justifyContent="space-between">
        <Text bold {...textColor(preferences, 'white')}>
          {score}
        </Text>
        <Text>{details.join('  |  ')}</Text>
      </Box>
    </Box>
  );
}

export function AgentTabs({
  agents,
  selectedAgentId,
  width,
  preferences,
}: {
  agents: readonly AgentSnapshot[];
  selectedAgentId: string | null;
  width: number;
  preferences: DisplayPreferences;
}) {
  const capacity = Math.max(1, Math.floor((width - 10) / 19));
  const visible = visibleAgentTabs(agents, selectedAgentId, capacity);

  return (
    <Box>
      {visible.agents.map(agent => {
        const globalIndex = agents.findIndex(candidate => candidate.id === agent.id);
        const selected = agent.id === selectedAgentId;
        const shortcut = globalIndex >= 0 && globalIndex < 9 ? String(globalIndex + 1) : '-';
        return (
          <Box key={agent.id} marginRight={1}>
            <Text
              bold={selected}
              {...textColor(preferences, selected ? 'cyan' : statusColor(agent.status))}
            >
              {selected ? '>' : ' '}[{shortcut}] {statusGlyph(agent.status, preferences.asciiOnly)}{' '}
              {isDefenseAgent(agent) ? 'DEF' : agent.role === 'system' ? 'SYS' : 'OFF'}{' '}
              {clipText(agent.name.toUpperCase(), 8)}
            </Text>
          </Box>
        );
      })}
      {visible.hidden > 0 ? (
        <Text {...textColor(preferences, 'gray')}>+{visible.hidden} BENCH</Text>
      ) : null}
    </Box>
  );
}

function transcriptColor(kind: TranscriptEntry['kind']): Accent {
  switch (kind) {
    case 'critic':
      return 'yellow';
    case 'tool':
      return 'magenta';
    case 'result':
      return 'green';
    case 'warning':
      return 'yellow';
    case 'error':
      return 'red';
    case 'system':
      return 'gray';
    case 'agent':
      return 'cyan';
  }
}

function timestamp(value: TranscriptEntry['timestamp']): string {
  if (value === undefined) return '--:--:--';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toISOString().slice(11, 19);
}

export function TranscriptPane({
  session,
  selectedAgentId,
  rows,
  width,
  preferences,
  active,
}: {
  session: BroadcastSession;
  selectedAgentId: string | null;
  rows: number;
  width: number;
  preferences: DisplayPreferences;
  active: boolean;
}) {
  const entries = tail(
    selectTranscript(session.transcript, selectedAgentId),
    Math.max(1, rows - 3),
  );
  return (
    <Panel title="LIVE FEED // TOUCHLINE" preferences={preferences} active={active} flexGrow={1}>
      {entries.length === 0 ? (
        <Text {...textColor(preferences, 'gray')}>Quiet on the touchline. Agents are taking shape.</Text>
      ) : (
        entries.map(entry => (
          <Text key={entry.id} wrap="truncate-end">
            <Text {...textColor(preferences, 'gray')}>{timestamp(entry.timestamp)} </Text>
            <Text bold {...textColor(preferences, transcriptColor(entry.kind))}>
              {clipText(entry.label ?? entry.kind, 10).toUpperCase().padEnd(10)}
            </Text>{' '}
            {clipText(entry.text, Math.max(16, width - 24))}
          </Text>
        ))
      )}
    </Panel>
  );
}

function meter(progress: number | undefined, width: number, asciiOnly: boolean): string {
  const safeProgress = Math.min(1, Math.max(0, progress ?? 0));
  const filled = Math.round(safeProgress * width);
  const fill = asciiOnly ? '#' : '━';
  const empty = asciiOnly ? '.' : '─';
  return `${fill.repeat(filled)}${empty.repeat(Math.max(0, width - filled))}`;
}

export function TacticalPane({
  agent,
  tactics,
  preferences,
  active,
}: {
  agent: AgentSnapshot | undefined;
  tactics: readonly TacticalItem[];
  preferences: DisplayPreferences;
  active: boolean;
}) {
  return (
    <Panel title="TACTICAL BOARD // FORMATION" preferences={preferences} active={active} flexGrow={1}>
      {agent ? (
        <>
          <Text>
            <Text {...textColor(preferences, 'gray')}>PLAYER </Text>
            <Text bold {...textColor(preferences, statusColor(agent.status))}>
              {singleLine(agent.name, 30)} // {singleLine(agent.role, 24)}
            </Text>
          </Text>
          <Text>
            <Text {...textColor(preferences, 'gray')}>PRESS  </Text>
            <Text {...textColor(preferences, statusColor(agent.status))}>
              {meter(agent.progress, 16, preferences.asciiOnly)}{' '}
              {Math.round(Math.min(1, Math.max(0, agent.progress ?? 0)) * 100)}%
            </Text>
          </Text>
          <Text wrap="truncate-end">
            <Text {...textColor(preferences, 'gray')}>MARK   </Text>
            {singleLine(agent.currentTask ?? 'Awaiting the next ball', 60)}
          </Text>
        </>
      ) : (
        <Text {...textColor(preferences, 'gray')}>No agents have entered the pitch.</Text>
      )}
      {tail(tactics, 5).map(item => (
        <Text key={item.id} wrap="truncate-end">
          <Text {...textColor(preferences, 'yellow')}>
            {clipText(item.label, 14).padEnd(14)}
          </Text>{' '}
          {clipText(item.value, 54)}
        </Text>
      ))}
    </Panel>
  );
}

export function EvidencePane({
  evidence,
  selectedAgentId,
  rows,
  preferences,
  active,
}: {
  evidence: readonly EvidenceItem[];
  selectedAgentId: string | null;
  rows: number;
  preferences: DisplayPreferences;
  active: boolean;
}) {
  const relevant = evidence.filter(
    item => item.agentId === undefined || item.agentId === selectedAgentId,
  );
  return (
    <Panel title="EVIDENCE LOCKER // RECEIPTS" preferences={preferences} active={active} flexGrow={1}>
      {relevant.length === 0 ? (
        <Text {...textColor(preferences, 'gray')}>No receipts filed yet.</Text>
      ) : (
        tail(relevant, Math.max(1, rows - 3)).map(item => (
          <Text key={item.id} wrap="truncate-end">
            <Text bold {...textColor(preferences, evidenceColor(item.status))}>
              {evidenceGlyph(item.status, preferences.asciiOnly)} {clipText(item.title, 28)}
            </Text>
            {item.detail ? ` — ${clipText(item.detail, 52)}` : ''}
            {item.source ? (
              <Text {...textColor(preferences, 'gray')}> [{clipText(item.source, 24)}]</Text>
            ) : null}
          </Text>
        ))
      )}
    </Panel>
  );
}

export function ReplayPane({
  event,
  frame,
  compact,
  reducedMotion,
  preferences,
}: {
  event: AnimationEvent;
  frame: number;
  compact: boolean;
  reducedMotion: boolean;
  preferences: DisplayPreferences;
}) {
  const sequence = ANIMATION_SEQUENCES[event.kind];
  const frames = compact ? sequence.compactFrames : sequence.frames;
  const safeFrame = Math.min(Math.max(0, frame), frames.length - 1);
  const replayLabel = preferences.textOnly
    ? 'VERDICT // TEXT ONLY'
    : reducedMotion
      ? 'REPLAY // REDUCED MOTION'
      : 'REPLAY';
  return (
    <Panel title={`${replayLabel} // ${event.kind.toUpperCase()}`} preferences={preferences} active flexGrow={1}>
      {preferences.textOnly ? null : (
        <Text bold {...textColor(preferences, sequence.accent)}>
          {frames[safeFrame]}
        </Text>
      )}
      <Text bold {...textColor(preferences, sequence.accent)}>
        {event.label}
      </Text>
      {event.summary ? (
        <Text wrap="truncate-end">{clipText(event.summary, compact ? 48 : 84)}</Text>
      ) : null}
    </Panel>
  );
}

export function PaneTabs({
  activePane,
  preferences,
  compact = false,
}: {
  activePane: PaneId;
  preferences: DisplayPreferences;
  compact?: boolean;
}) {
  if (compact) {
    const compactPanes: readonly [PaneId, string][] = [
      ['transcript', '[T] FEED'],
      ['tactics', '[A] PLAN'],
      ['evidence', '[E] PROOF'],
    ];
    return (
      <Box justifyContent="space-between">
        <Box>
          {compactPanes.map(([id, label]) => (
            <Box key={id} marginRight={1}>
              <Text
                bold={activePane === id}
                {...textColor(preferences, activePane === id ? 'cyan' : 'gray')}
              >
                {label}
              </Text>
            </Box>
          ))}
        </Box>
        <Text {...textColor(preferences, 'gray')}>^P/^N [?]</Text>
      </Box>
    );
  }
  const panes: readonly [PaneId, string, string][] = [
    ['transcript', 'T', 'LIVE FEED'],
    ['tactics', 'A', 'TACTICS'],
    ['evidence', 'E', 'EVIDENCE'],
  ];
  return (
    <Box justifyContent="space-between">
      <Box>
        {panes.map(([id, key, label]) => (
          <Box key={id} marginRight={2}>
            <Text bold={activePane === id} {...textColor(preferences, activePane === id ? 'cyan' : 'gray')}>
              [{key}] {label}
            </Text>
          </Box>
        ))}
      </Box>
      <Text {...textColor(preferences, 'gray')}>
        ^P/^N AGENT  {preferences.asciiOnly ? '[?] HELP' : '[?] HELP ⚽'}
      </Text>
    </Box>
  );
}

export function HelpPane({
  preferences,
}: {
  preferences: DisplayPreferences;
}) {
  const lines = [
    ['1–9 / Option+1–9', 'jump to an agent tab'],
    ['Tab / Shift+Tab', 'cycle agents while not typing'],
    ['Ctrl+N / Ctrl+P', 'cycle agents from anywhere'],
    ['T / A / E', 'live feed / tactics / evidence'],
    ['I or /', 'enter prompt mode; Esc returns to navigation'],
    ['R / Ctrl+R', 'replay the last critic decision'],
    ['P', 'pause/resume replay; checkpoint live work'],
    ['Q (twice)', 'confirm a checkpointed quit from the host'],
    ['Ctrl+C', 'checkpoint and interrupt immediately'],
  ] as const;
  return (
    <Panel title="MATCH PROGRAMME // SHORTCUTS" preferences={preferences} active flexGrow={1}>
      {lines.map(([shortcut, description]) => (
        <Text key={shortcut}>
          <Text bold {...textColor(preferences, 'cyan')}>
            {shortcut.padEnd(22)}
          </Text>
          {description}
        </Text>
      ))}
      <Text {...textColor(preferences, 'gray')}>
        Unmodified navigation keys are disabled while composing, so your prompt stays intact.
      </Text>
    </Panel>
  );
}

export function PromptBar({
  draft,
  composing,
  interactive,
  paused,
  preferences,
}: {
  draft: string;
  composing: boolean;
  interactive: boolean;
  paused: boolean;
  preferences: DisplayPreferences;
}) {
  if (!interactive) {
    return (
      <Text {...textColor(preferences, 'gray')}>
        SPECTATOR MODE // programmatic controls active
      </Text>
    );
  }
  return (
    <Box
      borderStyle={preferences.asciiOnly ? 'classic' : 'single'}
      {...borderColor(preferences, composing ? 'cyan' : 'gray')}
      paddingX={1}
    >
      {composing ? (
        <Text>
          <Text bold {...textColor(preferences, 'cyan')}>
            COACH&gt;{' '}
          </Text>
          {clipText(draft, 2_000)}
          <Text {...textColor(preferences, 'cyan')}>{preferences.asciiOnly ? '_' : '▌'}</Text>
        </Text>
      ) : (
        <Text {...textColor(preferences, 'gray')}>
          [Tab/Shift+Tab] AGENT  [Alt+1–9] DIRECT  [/] STEER  [E] EVIDENCE  [P] {paused ? 'RESUME' : 'PAUSE'}  [?] HELP  [Q] QUIT
        </Text>
      )}
    </Box>
  );
}

export function CompactActivePane({
  activePane,
  session,
  selectedAgent,
  selectedAgentId,
  rows,
  width,
  preferences,
}: {
  activePane: PaneId;
  session: BroadcastSession;
  selectedAgent: AgentSnapshot | undefined;
  selectedAgentId: string | null;
  rows: number;
  width: number;
  preferences: DisplayPreferences;
}) {
  if (activePane === 'tactics') {
    return (
      <TacticalPane
        agent={selectedAgent}
        tactics={session.tactics ?? []}
        preferences={preferences}
        active
      />
    );
  }
  if (activePane === 'evidence') {
    return (
      <EvidencePane
        evidence={session.evidence ?? []}
        selectedAgentId={selectedAgentId}
        rows={rows}
        preferences={preferences}
        active
      />
    );
  }
  return (
    <TranscriptPane
      session={session}
      selectedAgentId={selectedAgentId}
      rows={rows}
      width={width}
      preferences={preferences}
      active
    />
  );
}

export function BroadcastBody({
  session,
  selectedAgent,
  selectedAgentId,
  activePane,
  layout,
  size,
  preferences,
  replay,
}: {
  session: BroadcastSession;
  selectedAgent: AgentSnapshot | undefined;
  selectedAgentId: string | null;
  activePane: PaneId;
  layout: LayoutMode;
  size: TerminalSize;
  preferences: DisplayPreferences;
  replay: { event: AnimationEvent; frame: number } | null;
}) {
  const matchupRows = layout === 'minimal' || layout === 'compact' ? 1 : 4;
  const bodyRows = Math.max(7, size.rows - (layout === 'minimal' ? 6 : 10) - matchupRows);
  const transcriptWidth = Math.max(28, Math.floor(size.columns * 0.6));

  if (replay && (layout === 'compact' || layout === 'minimal')) {
    return (
      <ReplayPane
        event={replay.event}
        frame={replay.frame}
        compact
        reducedMotion={preferences.reducedMotion}
        preferences={preferences}
      />
    );
  }

  if (layout === 'compact' || layout === 'minimal') {
    return (
      <CompactActivePane
        activePane={activePane}
        session={session}
        selectedAgent={selectedAgent}
        selectedAgentId={selectedAgentId}
        rows={bodyRows}
        width={size.columns}
        preferences={preferences}
      />
    );
  }

  if (layout === 'standard') {
    return (
      <Box height={bodyRows}>
        <Box width="60%" marginRight={1}>
          <TranscriptPane
            session={session}
            selectedAgentId={selectedAgentId}
            rows={bodyRows}
            width={transcriptWidth}
            preferences={preferences}
            active={activePane === 'transcript'}
          />
        </Box>
        <Box width="40%">
          {replay ? (
            <ReplayPane
              event={replay.event}
              frame={replay.frame}
              compact
              reducedMotion={preferences.reducedMotion}
              preferences={preferences}
            />
          ) : activePane === 'evidence' ? (
            <EvidencePane
              evidence={session.evidence ?? []}
              selectedAgentId={selectedAgentId}
              rows={bodyRows}
              preferences={preferences}
              active
            />
          ) : (
            <TacticalPane
              agent={selectedAgent}
              tactics={session.tactics ?? []}
              preferences={preferences}
              active={activePane === 'tactics'}
            />
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box height={bodyRows}>
      <Box width="58%" marginRight={1}>
        <TranscriptPane
          session={session}
          selectedAgentId={selectedAgentId}
          rows={bodyRows}
          width={transcriptWidth}
          preferences={preferences}
          active={activePane === 'transcript'}
        />
      </Box>
      <Box width="42%" flexDirection="column">
        <Box height={replay ? '60%' : '50%'}>
          {replay ? (
            <ReplayPane
              event={replay.event}
              frame={replay.frame}
              compact={false}
              reducedMotion={preferences.reducedMotion}
              preferences={preferences}
            />
          ) : (
            <TacticalPane
              agent={selectedAgent}
              tactics={session.tactics ?? []}
              preferences={preferences}
              active={activePane === 'tactics'}
            />
          )}
        </Box>
        <Box height={replay ? '40%' : '50%'}>
          <EvidencePane
            evidence={session.evidence ?? []}
            selectedAgentId={selectedAgentId}
            rows={Math.floor(bodyRows * (replay ? 0.4 : 0.5))}
            preferences={preferences}
            active={activePane === 'evidence'}
          />
        </Box>
      </Box>
    </Box>
  );
}
