import { createOpenAI } from '@ai-sdk/openai';
import { jsonSchema, Output, stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';
import type {
  AgentBackend,
  BackendAvailability,
  BackendCapabilities,
  BackendEvent,
  BackendRunRequest,
  BackendTerminalStatus,
} from './types.js';
import { BackendUnavailableError, errorMessage } from './types.js';
import type { BrokerToolName, ToolBroker } from '../runtime/tool-broker.js';
import { brokerToolNamesForRole } from './tool-policy.js';

export interface OpenRouterBackendOptions {
  apiKey?: string;
  model: string;
  baseURL?: string;
  title?: string;
  siteUrl?: string;
  headers?: Readonly<Record<string, string>>;
}

const patchOperationSchema = z.discriminatedUnion('type', [
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

function finishStatus(reason: string): BackendTerminalStatus {
  switch (reason) {
    case 'stop':
      return 'completed';
    case 'length':
      return 'context_limit';
    case 'content-filter':
      return 'blocked';
    case 'error':
      return 'error';
    default:
      return 'completed';
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export class OpenRouterBackend implements AgentBackend {
  readonly id = 'openrouter' as const;
  readonly kind = 'openrouter' as const;
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    resume: false,
    structuredOutput: true,
    hostApprovals: true,
    hostTools: true,
    costReporting: 'usage-only',
  };

  private readonly apiKey: string | undefined;
  private readonly provider: ReturnType<typeof createOpenAI>;
  private readonly model: string;

  constructor(options: OpenRouterBackendOptions) {
    this.apiKey = options.apiKey?.trim();
    this.model = options.model;
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.title) headers['X-OpenRouter-Title'] = options.title;
    if (options.siteUrl) headers['HTTP-Referer'] = options.siteUrl;
    this.provider = createOpenAI({
      baseURL: options.baseURL ?? 'https://openrouter.ai/api/v1',
      apiKey: this.apiKey ?? '',
      headers,
    });
  }

  async availability(): Promise<BackendAvailability> {
    return this.apiKey
      ? { available: true, version: 'ai-sdk-v7' }
      : { available: false, reason: 'OPENROUTER_API_KEY is missing.' };
  }

  async isAvailable(): Promise<boolean> {
    return (await this.availability()).available;
  }

  async *run(
    request: BackendRunRequest,
    suppliedBroker: ToolBroker,
    suppliedSignal?: AbortSignal,
  ): AsyncIterable<BackendEvent> {
    if (!this.apiKey) throw new BackendUnavailableError(this.kind, 'OpenRouter API key is missing.');
    if (request.session) {
      throw new BackendUnavailableError(this.kind, 'OpenRouter native runs do not support provider session resume.');
    }

    yield {
      type: 'session_started',
      session: {
        backend: this.kind,
        id: `openrouter:${request.runId}:${request.actorId}`,
        metadata: { resumable: 'false' },
      },
    };

    const broker = suppliedBroker ?? request.broker;
    const signal = suppliedSignal ?? request.signal;
    const invoke = async (name: BrokerToolName, input: unknown) => {
      if (!broker) throw new Error('This run has no ToolBroker.');
      return await broker.invoke(name, input, signal);
    };
    const allTools = broker
      ? {
          list_files: tool({
            description: 'List bounded files inside this actor workspace.',
            inputSchema: z.object({ path: z.string().optional(), glob: z.string().optional() }),
            execute: async input => await invoke('list_files', input),
          }),
          read_file: tool({
            description: 'Read a bounded workspace file, optionally by line range.',
            inputSchema: z.object({
              path: z.string().min(1),
              startLine: z.number().int().positive().optional(),
              endLine: z.number().int().positive().optional(),
            }),
            execute: async input => await invoke('read_file', input),
          }),
          search: tool({
            description: 'Search literal text within bounded workspace files.',
            inputSchema: z.object({
              query: z.string().min(1),
              path: z.string().optional(),
              glob: z.string().optional(),
              caseSensitive: z.boolean().optional(),
            }),
            execute: async input => await invoke('search', input),
          }),
          apply_patch: tool({
            description: 'Apply an idempotent structured patch inside the assigned write set.',
            inputSchema: z.object({
              operationId: z.string().min(1).max(200),
              operations: z.array(patchOperationSchema).min(1).max(100),
            }),
            execute: async input => await invoke('apply_patch', input),
          }),
          git_diff: tool({
            description: 'Inspect the current workspace git diff.',
            inputSchema: z.object({}),
            execute: async input => await invoke('git_diff', input),
          }),
          run_check: tool({
            description: 'Run one kickoff-approved verifier by id.',
            inputSchema: z.object({ checkId: z.string().min(1) }),
            execute: async input => await invoke('run_check', input),
          }),
          run_approved: tool({
            description: 'Run one exact kickoff-approved command with allowlisted arguments.',
            inputSchema: z.object({
              commandId: z.string().min(1),
              validatedArgs: z.array(z.string().max(4_096)).max(32).optional(),
            }),
            execute: async input => await invoke('run_approved', input),
          }),
          report_progress: tool({
            description: 'Report a bounded progress summary to the Goalie control room.',
            inputSchema: z.object({
              summary: z.string().min(1).max(8_000),
              status: z.enum(['working', 'blocked', 'done']).optional(),
              percent: z.number().min(0).max(100).optional(),
            }),
            execute: async input => await invoke('report_progress', input),
          }),
        }
      : undefined;
    const roleToolNames = brokerToolNamesForRole(request.role);
    const tools = !allTools || roleToolNames.length === 0
      ? undefined
      : request.role === 'manager'
        ? {
          list_files: allTools.list_files,
          read_file: allTools.read_file,
          search: allTools.search,
          git_diff: allTools.git_diff,
          run_check: allTools.run_check,
          report_progress: allTools.report_progress,
        }
        : allTools;

    const baseOptions = {
      model: this.provider.chat(request.model ?? this.model),
      prompt: request.prompt,
      ...(request.instructions ? { instructions: request.instructions } : {}),
      ...(tools ? { tools } : {}),
      stopWhen: stepCountIs(request.maxSteps ?? 24),
      ...(signal ? { abortSignal: signal } : {}),
    };
    let terminal = false;
    try {
      const result = await streamText(
        request.outputSchema
          ? {
              ...baseOptions,
              output: Output.object({
                schema: jsonSchema(request.outputSchema as never),
                name: 'goalie_result',
              }),
            }
          : baseOptions,
      );

      for await (const part of result.fullStream) {
      const value = record(part);
      switch (part.type) {
        case 'text-delta':
          yield { type: 'text_delta', text: part.text };
          break;
        case 'reasoning-delta':
          yield { type: 'reasoning_delta', text: part.text };
          break;
        case 'tool-call':
          yield {
            type: 'tool_requested',
            callId: String(value.toolCallId ?? value.id ?? ''),
            name: String(value.toolName ?? ''),
            input: value.input,
          };
          break;
        case 'tool-result':
          yield {
            type: 'tool_completed',
            callId: String(value.toolCallId ?? value.id ?? ''),
            name: String(value.toolName ?? ''),
            output: value.output,
            isError: false,
          };
          break;
        case 'tool-error':
          yield {
            type: 'tool_completed',
            callId: String(value.toolCallId ?? value.id ?? ''),
            name: String(value.toolName ?? ''),
            output: { error: errorMessage(value.error) },
            isError: true,
          };
          break;
        case 'finish': {
          const usage = part.totalUsage;
          yield {
            type: 'usage',
            usage: {
              ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
              ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
              ...(usage.inputTokenDetails.cacheReadTokens !== undefined
                ? { cacheReadTokens: usage.inputTokenDetails.cacheReadTokens }
                : {}),
              ...(usage.inputTokenDetails.cacheWriteTokens !== undefined
                ? { cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens }
                : {}),
            },
          };
          let structuredOutput: unknown;
          let structuredOutputError: string | undefined;
          if (request.outputSchema) {
            try {
              structuredOutput = await result.output;
            } catch (error) {
              // Preserve the streamed text so the orchestrator can perform its
              // one explicit repair attempt. Treating an SDK parse failure as a
              // transport failure would discard the candidate JSON entirely.
              structuredOutputError = errorMessage(error);
            }
          }
          terminal = true;
          yield {
            type: 'terminal',
            status: finishStatus(part.finishReason),
            ...(part.rawFinishReason ? { rawReason: part.rawFinishReason } : {}),
            ...(structuredOutput !== undefined ? { structuredOutput } : {}),
            ...(structuredOutputError ? { error: `Structured output unavailable: ${structuredOutputError}` } : {}),
          };
          break;
        }
        case 'abort':
          terminal = true;
          yield { type: 'terminal', status: 'cancelled', rawReason: part.reason ?? 'aborted' };
          break;
        case 'error':
          terminal = true;
          yield { type: 'terminal', status: 'error', rawReason: 'stream-error', error: errorMessage(part.error) };
          break;
      }
      }
    } catch (error) {
      if (!terminal) {
        terminal = true;
        yield {
          type: 'terminal',
          status: signal?.aborted ? 'cancelled' : 'error',
          rawReason: signal?.aborted ? 'abort-signal' : 'openrouter-error',
          error: errorMessage(error),
        };
      }
    }
    if (!terminal) yield { type: 'terminal', status: 'error', rawReason: 'stream-ended-without-finish' };
  }
}
