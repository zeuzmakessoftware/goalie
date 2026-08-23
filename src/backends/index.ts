export * from './types.js';
export * from './scripted.js';
export * from './openrouter.js';
export * from './codex-app-server-client.js';
export * from './codex-app-server.js';
export * from './claude.js';

import { ClaudeBackend, type ClaudeBackendOptions } from './claude.js';
import {
  CodexAppServerBackend,
  type CodexAppServerBackendOptions,
} from './codex-app-server.js';
import { OpenRouterBackend, type OpenRouterBackendOptions } from './openrouter.js';
import { ScriptedBackend, type ScriptFactory } from './scripted.js';
import type { AgentBackend } from './types.js';

export type BackendProviderId =
  | 'openrouter'
  | 'codex'
  | 'codex-app-server'
  | 'claude'
  | 'claude-agent-sdk'
  | 'scripted';

export interface ScriptedBackendOptions {
  script: ScriptFactory;
}

export type CreateBackendOptions =
  | OpenRouterBackendOptions
  | CodexAppServerBackendOptions
  | ClaudeBackendOptions
  | ScriptedBackendOptions;

export function createBackend(providerId: 'openrouter', options: OpenRouterBackendOptions): AgentBackend;
export function createBackend(
  providerId: 'codex' | 'codex-app-server',
  options?: CodexAppServerBackendOptions,
): AgentBackend;
export function createBackend(
  providerId: 'claude' | 'claude-agent-sdk',
  options?: ClaudeBackendOptions,
): AgentBackend;
export function createBackend(providerId: 'scripted', options: ScriptedBackendOptions): AgentBackend;
export function createBackend(providerId: BackendProviderId, options: CreateBackendOptions = {}): AgentBackend {
  switch (providerId) {
    case 'openrouter': {
      const openRouter = options as Partial<OpenRouterBackendOptions>;
      if (!openRouter.model) throw new Error('OpenRouter backend requires a model.');
      return new OpenRouterBackend(openRouter as OpenRouterBackendOptions);
    }
    case 'codex':
    case 'codex-app-server':
      return new CodexAppServerBackend(options as CodexAppServerBackendOptions);
    case 'claude':
    case 'claude-agent-sdk':
      return new ClaudeBackend(options as ClaudeBackendOptions);
    case 'scripted': {
      const scripted = options as Partial<ScriptedBackendOptions>;
      if (!scripted.script) throw new Error('Scripted backend requires a script factory.');
      return new ScriptedBackend(scripted.script);
    }
  }
  throw new Error(`Unknown backend provider: ${String(providerId)}`);
}
