import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AsyncQueue } from './async-queue.js';
import type {
  AgentBackend,
  BackendAvailability,
  BackendCapabilities,
  BackendEvent,
  BackendRunRequest,
  BackendTerminalStatus,
} from './types.js';
import { BackendUnavailableError, errorMessage } from './types.js';
import {
  type BrokerToolName,
  type ToolBroker,
} from '../runtime/tool-broker.js';
import { brokerToolNamesForRole, isEvidenceOnlyReviewer } from './tool-policy.js';

interface ClosableAsyncIterable extends AsyncIterable<unknown> {
  close?: () => void;
}

interface ClaudeSdkLike {
  query(params: Readonly<Record<string, unknown>>): ClosableAsyncIterable;
  tool(
    name: string,
    description: string,
    inputShape: Readonly<Record<string, z.ZodType>>,
    handler: (input: Record<string, unknown>, extra?: unknown) => Promise<unknown>,
    extras?: Readonly<Record<string, unknown>>,
  ): unknown;
  createSdkMcpServer(options: Readonly<Record<string, unknown>>): unknown;
}

export type ClaudeSdkLoader = () => Promise<ClaudeSdkLike>;
export type ClaudeQueryFactory = (
  sdk: ClaudeSdkLike,
  params: Readonly<Record<string, unknown>>,
) => ClosableAsyncIterable;

export interface ClaudeBackendOptions {
  model?: string;
  sdkLoader?: ClaudeSdkLoader;
  queryFactory?: ClaudeQueryFactory;
}

const PATCH_OPERATION = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('write'),
    path: z.string().min(1),
    content: z.string(),
    expectedSha256: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal('replace'),
    path: z.string().min(1),
    oldText: z.string().min(1),
    newText: z.string(),
    expectedOccurrences: z.number().int().positive().optional(),
    expectedSha256: z.string().optional(),
  }),
  z.object({
    type: z.literal('delete'),
    path: z.string().min(1),
    expectedSha256: z.string().optional(),
  }),
]);

const TOOL_INPUTS: Readonly<Record<BrokerToolName, Readonly<Record<string, z.ZodType>>>> = {
  list_files: { path: z.string().optional(), glob: z.string().optional() },
  read_file: {
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  },
  search: {
    query: z.string().min(1),
    path: z.string().optional(),
    glob: z.string().optional(),
    caseSensitive: z.boolean().optional(),
  },
  apply_patch: {
    operationId: z.string().min(1).max(200),
    operations: z.array(PATCH_OPERATION).min(1).max(100),
  },
  git_diff: {},
  run_check: { checkId: z.string().min(1) },
  run_approved: {
    commandId: z.string().min(1),
    validatedArgs: z.array(z.string().max(4_096)).max(32).optional(),
  },
  report_progress: {
    summary: z.string().min(1).max(8_000),
    status: z.enum(['working', 'blocked', 'done']).optional(),
    percent: z.number().min(0).max(100).optional(),
  },
};

const TOOL_DESCRIPTIONS: Readonly<Record<BrokerToolName, string>> = {
  list_files: 'List bounded files inside the assigned Goalie worktree.',
  read_file: 'Read a bounded file or line range inside the assigned Goalie worktree.',
  search: 'Search literal text within bounded files in the assigned Goalie worktree.',
  apply_patch: 'Apply an idempotent structured patch inside the assigned write set.',
  git_diff: 'Inspect the current Git diff without changing repository state.',
  run_check: 'Run one exact verifier approved during kickoff.',
  run_approved: 'Run one exact kickoff-approved command with allowlisted arguments.',
  report_progress: 'Report a bounded progress summary to the Goalie control room.',
};

// The Agent SDK implements outputFormat through this SDK-owned, end-turn
// protocol tool. It has no filesystem, network, or process capability and is
// not part of Goalie's broker surface. Permit it only for a request that
// actually carries an output schema; every other native tool remains denied.
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function resultStatus(subtype: string): BackendTerminalStatus {
  if (subtype === 'success') return 'completed';
  if (subtype === 'error_max_turns') return 'context_limit';
  if (subtype === 'error_max_budget_usd') return 'budget';
  return 'error';
}

async function defaultSdkLoader(): Promise<ClaudeSdkLike> {
  // A computed specifier preserves an optional runtime integration: installing
  // Goalie without the Claude SDK still leaves every other backend usable.
  const specifier: string = '@anthropic-ai/claude-agent-sdk';
  return (await import(specifier)) as unknown as ClaudeSdkLike;
}

/** Claude Agent SDK adapter with no native tools and one in-process host MCP. */
export class ClaudeBackend implements AgentBackend {
  readonly id = 'claude-agent-sdk' as const;
  readonly kind = 'claude-agent-sdk' as const;
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    resume: true,
    structuredOutput: true,
    hostApprovals: true,
    hostTools: true,
    costReporting: 'exact',
  };

  private readonly options: ClaudeBackendOptions;
  private sdkPromise: Promise<ClaudeSdkLike> | undefined;

  constructor(options: ClaudeBackendOptions = {}) {
    this.options = options;
  }

  async availability(): Promise<BackendAvailability> {
    try {
      await this.getSdk();
      return { available: true, version: 'agent-sdk' };
    } catch (error) {
      return { available: false, reason: errorMessage(error) };
    }
  }

  async isAvailable(): Promise<boolean> {
    return (await this.availability()).available;
  }

  run(
    request: BackendRunRequest,
    broker: ToolBroker,
    signal?: AbortSignal,
  ): AsyncIterable<BackendEvent> {
    return this.execute(request, broker, signal);
  }

  resume(
    request: BackendRunRequest,
    broker: ToolBroker,
    signal?: AbortSignal,
  ): AsyncIterable<BackendEvent> {
    if (!request.session || request.session.backend !== this.kind) {
      throw new BackendUnavailableError(this.kind, 'A Claude Agent SDK session is required to resume.');
    }
    return this.execute(request, broker, signal);
  }

  private async *execute(
    request: BackendRunRequest,
    broker: ToolBroker,
    suppliedSignal?: AbortSignal,
  ): AsyncIterable<BackendEvent> {
    const signal = suppliedSignal ?? request.signal;
    const queue = new AsyncQueue<BackendEvent>();
    const abortController = new AbortController();
    let query: ClosableAsyncIterable | undefined;
    const abort = (): void => {
      abortController.abort(signal?.reason);
      query?.close?.();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    void (async () => {
      try {
        const sdk = await this.getSdk();
        const names = brokerToolNamesForRole(request.role);
        const mcpTools = names.map(name =>
          sdk.tool(
            name,
            TOOL_DESCRIPTIONS[name],
            TOOL_INPUTS[name],
            async (input, extra) => {
              const metadata = asRecord(extra);
              const providerCallId = metadata.toolUseID ?? metadata.toolUseId ?? metadata.tool_use_id;
              const callId =
                typeof providerCallId === 'string' ? providerCallId : `claude-mcp:${randomUUID()}`;
              queue.push({ type: 'tool_requested', callId, name, input });
              try {
                const output = await broker.invoke(name, input, signal);
                queue.push({ type: 'tool_completed', callId, name, output, isError: false });
                return {
                  content: [{ type: 'text', text: JSON.stringify(output) }],
                  structuredContent: asRecord(output),
                };
              } catch (error) {
                const output = { error: errorMessage(error) };
                queue.push({ type: 'tool_completed', callId, name, output, isError: true });
                return { isError: true, content: [{ type: 'text', text: JSON.stringify(output) }] };
              }
            },
            { annotations: { readOnlyHint: !['apply_patch', 'run_approved'].includes(name) } },
          ),
        );
        const server = sdk.createSdkMcpServer({
          name: 'goalie',
          version: '1.0.0',
          alwaysLoad: true,
          instructions: 'Only these host-controlled tools may access the workspace.',
          tools: mcpTools,
        });
        const brokerToolIds = names.map(name => `mcp__goalie__${name}`);
        const policyAllowedToolSet = new Set([
          ...brokerToolIds,
          ...(request.outputSchema ? [STRUCTURED_OUTPUT_TOOL] : []),
        ]);
        const systemPrompt = [
          'You are an actor inside a contained Goalie coding gauntlet.',
          ...(isEvidenceOnlyReviewer(request.role)
            ? ['This is an evidence-only review. Do not inspect the filesystem, repository, Git state, network, or environment. No workspace broker tool is available.']
            : ['Only the mcp__goalie tools are available. Do not ask for or attempt any native tool.']),
          ...(request.outputSchema
            ? [`${STRUCTURED_OUTPUT_TOOL} is an SDK-owned end-turn protocol sentinel, not a workspace tool. Use it only to submit the final schema-conforming response.`]
            : []),
          request.instructions,
        ]
          .filter(Boolean)
          .join('\n\n');
        const params = {
          prompt: request.prompt,
          options: {
            cwd: request.cwd,
            ...(request.model ?? this.options.model ? { model: request.model ?? this.options.model } : {}),
            ...(request.session ? { resume: request.session.id } : {}),
            ...(request.maxSteps ? { maxTurns: request.maxSteps } : {}),
            ...(request.outputSchema
              ? { outputFormat: { type: 'json_schema', schema: request.outputSchema } }
              : {}),
            abortController,
            includePartialMessages: true,
            tools: [],
            agents: {},
            plugins: [],
            skills: [],
            settingSources: [],
            strictMcpConfig: true,
            systemPrompt,
            mcpServers: { goalie: server },
            // Keep this empty so the SDK does not auto-approve MCP tools ahead
            // of canUseTool. Exact-name permission and the mandatory
            // PreToolUse hook below both have to agree before broker argument
            // validation is reached.
            allowedTools: [],
            hooks: {
              PreToolUse: [{
                hooks: [async (input: unknown) => {
                  const hook = asRecord(input);
                  const toolName = typeof hook.tool_name === 'string' ? hook.tool_name : '';
                  if (!policyAllowedToolSet.has(toolName)) {
                    return {
                      continue: false,
                      decision: 'block' as const,
                      stopReason: `Goalie blocked non-broker tool ${toolName || '(unknown)'}.`,
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse' as const,
                        permissionDecision: 'deny' as const,
                        permissionDecisionReason: 'Only host-broker MCP tools are permitted.',
                      },
                    };
                  }
                  return {
                    continue: true,
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse' as const,
                      permissionDecision: 'allow' as const,
                      permissionDecisionReason: toolName === STRUCTURED_OUTPUT_TOOL
                        ? 'Schema-bound SDK end-turn protocol sentinel; no host capability.'
                        : 'Exact Goalie broker tool; arguments remain broker-validated.',
                    },
                  };
                }],
              }],
            },
            permissionMode: 'default',
            canUseTool: async (toolName: string) =>
              policyAllowedToolSet.has(toolName)
                ? { behavior: 'allow' as const }
                : {
                  behavior: 'deny' as const,
                  message: `Goalie denied non-broker tool ${toolName}.`,
                  interrupt: false,
                },
          },
        } satisfies Readonly<Record<string, unknown>>;
        query = this.options.queryFactory
          ? this.options.queryFactory(sdk, params)
          : sdk.query(params);

        let sawPartialText = false;
        let terminal = false;
        for await (const rawMessage of query) {
          const message = asRecord(rawMessage);
          const type = String(message.type ?? '');
          if (type === 'system' && message.subtype === 'init' && typeof message.session_id === 'string') {
            queue.push({
              type: 'session_started',
              session: { backend: this.kind, id: message.session_id },
            });
            continue;
          }
          if (type === 'stream_event') {
            const event = asRecord(message.event);
            if (event.type !== 'content_block_delta') continue;
            const delta = asRecord(event.delta);
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              sawPartialText = true;
              queue.push({ type: 'text_delta', text: delta.text });
            } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              queue.push({ type: 'reasoning_delta', text: delta.thinking });
            }
            continue;
          }
          if (type === 'assistant' && !sawPartialText) {
            const content = asRecord(message.message).content;
            if (Array.isArray(content)) {
              for (const rawBlock of content) {
                const block = asRecord(rawBlock);
                if (block.type === 'text' && typeof block.text === 'string') {
                  queue.push({ type: 'text_delta', text: block.text });
                } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
                  queue.push({ type: 'reasoning_delta', text: block.thinking });
                }
              }
            }
            continue;
          }
          if (type !== 'result') continue;

          const usage = asRecord(message.usage);
          queue.push({
            type: 'usage',
            usage: {
              ...(typeof usage.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
              ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
              ...(typeof usage.cache_read_input_tokens === 'number'
                ? { cacheReadTokens: usage.cache_read_input_tokens }
                : {}),
              ...(typeof usage.cache_creation_input_tokens === 'number'
                ? { cacheWriteTokens: usage.cache_creation_input_tokens }
                : {}),
              ...(typeof message.total_cost_usd === 'number'
                ? { costUsd: message.total_cost_usd }
                : {}),
            },
          });
          const subtype = String(message.subtype ?? 'error_during_execution');
          const errors = Array.isArray(message.errors)
            ? message.errors.filter((value): value is string => typeof value === 'string')
            : [];
          terminal = true;
          queue.push({
            type: 'terminal',
            status: signal?.aborted ? 'cancelled' : resultStatus(subtype),
            rawReason: subtype,
            ...(errors.length > 0 ? { error: errors.join('\n') } : {}),
            ...(message.structured_output !== undefined
              ? { structuredOutput: message.structured_output }
              : {}),
          });
          break;
        }
        if (!terminal) {
          queue.push({
            type: 'terminal',
            status: signal?.aborted ? 'cancelled' : 'error',
            rawReason: signal?.aborted ? 'abort-signal' : 'sdk-stream-ended',
          });
        }
      } catch (error) {
        queue.push({
          type: 'terminal',
          status: signal?.aborted ? 'cancelled' : 'error',
          rawReason: signal?.aborted ? 'abort-signal' : 'claude-sdk-error',
          error: errorMessage(error),
        });
      } finally {
        queue.end();
      }
    })();

    try {
      for await (const event of queue) yield event;
    } finally {
      signal?.removeEventListener('abort', abort);
      query?.close?.();
    }
  }

  private getSdk(): Promise<ClaudeSdkLike> {
    this.sdkPromise ??= (this.options.sdkLoader ?? defaultSdkLoader)();
    return this.sdkPromise;
  }
}
