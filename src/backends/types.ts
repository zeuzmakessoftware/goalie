import type { ToolBroker } from '../runtime/tool-broker.js';

export type BackendKind = 'openrouter' | 'codex-app-server' | 'claude-agent-sdk' | 'scripted';
export type AgentRole = 'manager' | 'worker' | 'critic' | 'auditor';
export type BackendTerminalStatus =
  | 'completed'
  | 'blocked'
  | 'context_limit'
  | 'budget'
  | 'cancelled'
  | 'error';

export interface BackendCapabilities {
  streaming: boolean;
  resume: boolean;
  structuredOutput: boolean;
  hostApprovals: boolean;
  hostTools: boolean;
  costReporting: 'exact' | 'usage-only' | 'unknown';
}

export interface BackendAvailability {
  available: boolean;
  reason?: string;
  version?: string;
}

export interface BackendSessionRef {
  backend: BackendKind;
  id: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface BackendRunRequest {
  runId: string;
  actorId: string;
  role: AgentRole;
  prompt: string;
  cwd: string;
  model?: string;
  instructions?: string;
  session?: BackendSessionRef;
  outputSchema?: Readonly<Record<string, unknown>>;
  maxSteps?: number;
  /** @deprecated Pass the broker as the second argument to AgentBackend.run. */
  broker?: ToolBroker;
  /** @deprecated Pass the signal as the third argument to AgentBackend.run. */
  signal?: AbortSignal;
}

export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export type BackendEvent =
  | { type: 'session_started'; session: BackendSessionRef }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_requested'; callId: string; name: string; input: unknown }
  | { type: 'tool_completed'; callId: string; name: string; output: unknown; isError: boolean }
  | { type: 'usage'; usage: NormalizedUsage }
  | {
      type: 'terminal';
      status: BackendTerminalStatus;
      rawReason?: string;
      error?: string;
      structuredOutput?: unknown;
    };

export interface AgentBackend {
  /** Stable provider id used by orchestration and durable run records. */
  readonly id: BackendKind;
  readonly kind: BackendKind;
  readonly capabilities: BackendCapabilities;
  isAvailable(): Promise<boolean>;
  availability(): Promise<BackendAvailability>;
  run(request: BackendRunRequest, broker: ToolBroker, signal?: AbortSignal): AsyncIterable<BackendEvent>;
  resume?(
    request: BackendRunRequest,
    broker: ToolBroker,
    signal?: AbortSignal,
  ): AsyncIterable<BackendEvent>;
}

export class BackendUnavailableError extends Error {
  readonly code = 'BACKEND_UNAVAILABLE';

  constructor(
    readonly backend: BackendKind,
    message: string,
  ) {
    super(message);
    this.name = 'BackendUnavailableError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
