export type AgentStatus =
  | 'idle'
  | 'working'
  | 'waiting'
  | 'done'
  | 'blocked'
  | 'failed';

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'complete'
  | 'failed';

export type TranscriptKind =
  | 'agent'
  | 'critic'
  | 'system'
  | 'tool'
  | 'result'
  | 'warning'
  | 'error';

export type EvidenceStatus = 'pass' | 'fail' | 'running' | 'pending';

export type CriticDirection = 'positive' | 'negative' | 'neutral' | 'pending';

export type CriticVerdictStatus = 'streaming' | 'final';

export interface AgentSnapshot {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  currentTask?: string;
  model?: string;
  iteration?: number;
  progress?: number;
  tokenCount?: number;
}

export interface TranscriptEntry {
  id: string;
  text: string;
  kind: TranscriptKind;
  agentId?: string;
  timestamp?: number | string;
  label?: string;
}

export interface TacticalItem {
  id: string;
  label: string;
  value: string;
  status?: EvidenceStatus;
}

export interface EvidenceItem {
  id: string;
  title: string;
  detail?: string;
  source?: string;
  status: EvidenceStatus;
  agentId?: string;
}

export interface CriticVerdict {
  id: string;
  overall?: 'pass' | 'fail' | 'uncertain';
  direction?: CriticDirection;
  score?: number;
  status?: CriticVerdictStatus;
  summary?: string;
  revision?: number;
}

export interface BroadcastScore {
  goals: number;
  saves: number;
  reviews?: number;
}

export interface BroadcastSession {
  title: string;
  objective?: string;
  status: SessionStatus;
  phase: string;
  loop: number;
  loopLimit?: number;
  checkpoint: number;
  checkpointLimit?: number;
  elapsedMs?: number;
  budgetUsed?: number;
  budgetLimit?: number;
  score: BroadcastScore;
  agents: readonly AgentSnapshot[];
  transcript: readonly TranscriptEntry[];
  tactics?: readonly TacticalItem[];
  evidence?: readonly EvidenceItem[];
  /** Full finalized history, in occurrence order, for lossless replay queuing. */
  verdicts?: readonly CriticVerdict[];
  /** Convenience for streaming hosts that emit one verdict at a time. */
  latestVerdict?: CriticVerdict;
}

export type PaneId = 'transcript' | 'tactics' | 'evidence';

export type LayoutMode = 'wide' | 'standard' | 'compact' | 'minimal';

export type ColorMode = 'auto' | 'color' | 'none';

export type MotionMode = 'auto' | 'full' | 'reduced' | 'none';

export interface TerminalSize {
  columns: number;
  rows: number;
}

export interface DisplayPreferences {
  color: boolean;
  reducedMotion: boolean;
  textOnly: boolean;
  asciiOnly: boolean;
}

export interface AppProps {
  session: BroadcastSession;
  interactive?: boolean;
  terminalSize?: TerminalSize;
  colorMode?: ColorMode;
  motionMode?: MotionMode;
  env?: Readonly<Record<string, string | undefined>>;
  animationFrameMs?: number;
  onSubmitPrompt?: (prompt: string) => void;
  onExit?: () => void;
  /** Immediate graceful checkpoint/cancel, distinct from q confirmation. */
  onInterrupt?: () => void;
  onPause?: () => void;
  onAgentChange?: (agentId: string) => void;
}
