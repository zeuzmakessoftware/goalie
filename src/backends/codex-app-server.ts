import { spawn } from 'node:child_process';
import { z } from 'zod';
import { AsyncQueue } from './async-queue.js';
import {
  CodexAppServerClient,
  DEFAULT_CODEX_APP_SERVER_ARGS,
  type CodexNotification,
  type CodexServerRequest,
  spawnCodexAppServer,
} from './codex-app-server-client.js';
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
  BROKER_TOOL_NAMES,
  type BrokerToolName,
  type ToolBroker,
} from '../runtime/tool-broker.js';
import { brokerToolNamesForRole, isEvidenceOnlyReviewer } from './tool-policy.js';

export interface CodexAppServerBackendOptions {
  command?: string;
  args?: readonly string[];
  model?: string;
  clientVersion?: string;
  clientFactory?: () => CodexAppServerClient | Promise<CodexAppServerClient>;
}

interface ActiveRun {
  broker: ToolBroker;
  queue: AsyncQueue<BackendEvent>;
  request: BackendRunRequest;
  text: string;
  terminal: boolean;
  signal?: AbortSignal;
  turnId?: string;
}

const threadResponseSchema = z
  .object({ thread: z.object({ id: z.string() }).passthrough() })
  .passthrough();
const turnResponseSchema = z
  .object({ turn: z.object({ id: z.string(), status: z.string() }).passthrough() })
  .passthrough();
const dynamicToolParamsSchema = z
  .object({
    threadId: z.string(),
    turnId: z.string(),
    callId: z.string(),
    tool: z.string(),
    arguments: z.unknown(),
  })
  .passthrough();

const TOOL_DESCRIPTIONS: Readonly<Record<BrokerToolName, string>> = {
  list_files: 'List bounded files in the assigned Goalie worktree.',
  read_file: 'Read a bounded file or line range in the assigned Goalie worktree.',
  search: 'Search literal text within bounded files in the assigned Goalie worktree.',
  apply_patch: 'Apply an idempotent structured patch inside the assigned write set.',
  git_diff: 'Read the current Git diff without changing repository state.',
  run_check: 'Run one exact verifier approved during kickoff.',
  run_approved: 'Run one exact kickoff-approved command with allowlisted arguments.',
  report_progress: 'Report a bounded progress summary to the Goalie control room.',
};

const TOOL_SCHEMAS: Readonly<Record<BrokerToolName, Readonly<Record<string, unknown>>>> = {
  list_files: {
    type: 'object',
    properties: { path: { type: 'string' }, glob: { type: 'string' } },
    additionalProperties: false,
  },
  read_file: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string' },
      startLine: { type: 'integer', minimum: 1 },
      endLine: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  },
  search: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', minLength: 1 },
      path: { type: 'string' },
      glob: { type: 'string' },
      caseSensitive: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  apply_patch: {
    type: 'object',
    required: ['operationId', 'operations'],
    properties: {
      operationId: { type: 'string', minLength: 1, maxLength: 200 },
      operations: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          oneOf: [
            {
              type: 'object',
              required: ['type', 'path', 'content'],
              properties: {
                type: { const: 'write' },
                path: { type: 'string' },
                content: { type: 'string' },
                expectedSha256: { type: ['string', 'null'] },
              },
              additionalProperties: false,
            },
            {
              type: 'object',
              required: ['type', 'path', 'oldText', 'newText'],
              properties: {
                type: { const: 'replace' },
                path: { type: 'string' },
                oldText: { type: 'string', minLength: 1 },
                newText: { type: 'string' },
                expectedOccurrences: { type: 'integer', minimum: 1 },
                expectedSha256: { type: 'string' },
              },
              additionalProperties: false,
            },
            {
              type: 'object',
              required: ['type', 'path'],
              properties: {
                type: { const: 'delete' },
                path: { type: 'string' },
                expectedSha256: { type: 'string' },
              },
              additionalProperties: false,
            },
          ],
        },
      },
      additionalProperties: false,
    },
    additionalProperties: false,
  },
  git_diff: { type: 'object', properties: {}, additionalProperties: false },
  run_check: {
    type: 'object',
    required: ['checkId'],
    properties: { checkId: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  },
  run_approved: {
    type: 'object',
    required: ['commandId'],
    properties: {
      commandId: { type: 'string', minLength: 1 },
      validatedArgs: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 4096 } },
    },
    additionalProperties: false,
  },
  report_progress: {
    type: 'object',
    required: ['summary'],
    properties: {
      summary: { type: 'string', minLength: 1, maxLength: 8000 },
      status: { type: 'string', enum: ['working', 'blocked', 'done'] },
      percent: { type: 'number', minimum: 0, maximum: 100 },
    },
    additionalProperties: false,
  },
};

function isBrokerToolName(name: string): name is BrokerToolName {
  return (BROKER_TOOL_NAMES as readonly string[]).includes(name);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function terminalStatus(status: string): BackendTerminalStatus {
  if (status === 'completed') return 'completed';
  if (status === 'interrupted') return 'cancelled';
  return 'error';
}

async function commandVersion(command: string): Promise<BackendAvailability> {
  return await new Promise(resolve => {
    const child = spawn(command, ['--version'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const output: Buffer[] = [];
    const timeout = setTimeout(() => child.kill('SIGTERM'), 3_000);
    timeout.unref();
    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk));
    child.once('error', error => {
      clearTimeout(timeout);
      resolve({ available: false, reason: errorMessage(error) });
    });
    child.once('close', code => {
      clearTimeout(timeout);
      resolve(
        code === 0
          ? { available: true, version: Buffer.concat(output).toString('utf8').trim() }
          : { available: false, reason: `${command} --version exited with ${code ?? 'signal'}.` },
      );
    });
  });
}

/**
 * Codex adapter over the durable App Server protocol. Native write/exec approvals
 * are always declined: mutations and approved commands must come through the
 * host-owned dynamic ToolBroker tools.
 */
export class CodexAppServerBackend implements AgentBackend {
  readonly id = 'codex-app-server' as const;
  readonly kind = 'codex-app-server' as const;
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    resume: true,
    structuredOutput: true,
    hostApprovals: true,
    hostTools: true,
    costReporting: 'usage-only',
  };

  private readonly command: string;
  private readonly args: readonly string[];
  private readonly options: CodexAppServerBackendOptions;
  private clientPromise: Promise<CodexAppServerClient> | undefined;
  private readonly active = new Map<string, ActiveRun>();

  constructor(options: CodexAppServerBackendOptions = {}) {
    this.options = options;
    this.command = options.command ?? 'codex';
    this.args = options.args ?? DEFAULT_CODEX_APP_SERVER_ARGS;
  }

  async availability(): Promise<BackendAvailability> {
    if (this.options.clientFactory) return { available: true, version: 'injected-app-server' };
    return await commandVersion(this.command);
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
      throw new BackendUnavailableError(this.kind, 'A Codex App Server session is required to resume.');
    }
    return this.execute(request, broker, signal);
  }

  close(): void {
    void this.clientPromise?.then(client => client.close()).catch(() => undefined);
    this.clientPromise = undefined;
  }

  private async *execute(
    request: BackendRunRequest,
    broker: ToolBroker,
    suppliedSignal?: AbortSignal,
  ): AsyncIterable<BackendEvent> {
    const signal = suppliedSignal ?? request.signal;
    let threadId: string | undefined;
    let active: ActiveRun | undefined;
    let abort: (() => void) | undefined;
    try {
      const client = await this.getClient();
      const tools = brokerToolNamesForRole(request.role);
      const dynamicTools = tools.map(name => ({
        type: 'function',
        name,
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: TOOL_SCHEMAS[name],
      }));
      const safetyInstructions = [
        'This run is contained by the Goalie host.',
        ...(isEvidenceOnlyReviewer(request.role)
          ? ['This is an evidence-only review. Do not inspect the filesystem, repository, Git state, network, or environment. Use only the evidence embedded in the prompt and return the requested verdict.']
          : ['Use only the provided dynamic Goalie tools for files, search, patches, diffs, and commands.']),
        'Never use native command, file-change, MCP, web, or user-input tools.',
        request.instructions,
      ]
        .filter(Boolean)
        .join('\n\n');

      const session = request.session;
      const rawThread = session
        ? await client.request(
            'thread/resume',
            {
              threadId: session.id,
              cwd: request.cwd,
              runtimeWorkspaceRoots: [request.cwd],
              sandbox: 'read-only',
              approvalPolicy: 'on-request',
              approvalsReviewer: 'user',
              model: request.model ?? this.options.model ?? null,
              developerInstructions: safetyInstructions,
            },
            signal,
          )
        : await client.request(
            'thread/start',
            {
              cwd: request.cwd,
              runtimeWorkspaceRoots: [request.cwd],
              sandbox: 'read-only',
              approvalPolicy: 'on-request',
              approvalsReviewer: 'user',
              allowProviderModelFallback: false,
              environments: [],
              model: request.model ?? this.options.model ?? null,
              developerInstructions: safetyInstructions,
              dynamicTools,
            },
            signal,
          );
      threadId = threadResponseSchema.parse(rawThread).thread.id;
      if (this.active.has(threadId)) {
        throw new Error(`Codex thread ${threadId} already has an active Goalie turn.`);
      }
      active = {
        broker,
        queue: new AsyncQueue<BackendEvent>(),
        request,
        text: '',
        terminal: false,
        ...(signal ? { signal } : {}),
      };
      this.active.set(threadId, active);
      yield {
        type: 'session_started',
        session: { backend: this.kind, id: threadId },
      };

      const rawTurn = await client.request(
        'turn/start',
        {
          threadId,
          input: [{ type: 'text', text: request.prompt }],
          cwd: request.cwd,
          runtimeWorkspaceRoots: [request.cwd],
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          environments: [],
          ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
        },
        signal,
      );
      active.turnId = turnResponseSchema.parse(rawTurn).turn.id;

      abort = (): void => {
        if (!threadId || !active?.turnId) return;
        void client
          .request('turn/interrupt', { threadId, turnId: active.turnId })
          .catch(() => undefined);
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();

      for await (const event of active.queue) yield event;
      if (!active.terminal) {
        yield { type: 'terminal', status: 'error', rawReason: 'app-server-stream-ended' };
      }
    } catch (error) {
      yield {
        type: 'terminal',
        status: signal?.aborted ? 'cancelled' : 'error',
        rawReason: signal?.aborted ? 'abort-signal' : 'app-server-error',
        error: errorMessage(error),
      };
    } finally {
      if (abort) signal?.removeEventListener('abort', abort);
      if (threadId) this.active.delete(threadId);
    }
  }

  private getClient(): Promise<CodexAppServerClient> {
    if (!this.clientPromise) {
      const creating = this.createClient();
      let tracked: Promise<CodexAppServerClient>;
      tracked = creating.catch(error => {
        if (this.clientPromise === tracked) this.clientPromise = undefined;
        throw error;
      });
      this.clientPromise = tracked;
    }
    return this.clientPromise;
  }

  private async createClient(): Promise<CodexAppServerClient> {
    const client = this.options.clientFactory
      ? await this.options.clientFactory()
      : new CodexAppServerClient({
          transport: spawnCodexAppServer(this.command, this.args),
        });
    client.setRequestHandler(async request => await this.handleServerRequest(request));
    client.onNotification(notification => this.handleNotification(notification));
    client.onError(error => {
      this.clientPromise = undefined;
      for (const run of this.active.values()) {
        if (run.terminal) continue;
        run.terminal = true;
        run.queue.push({
          type: 'terminal',
          status: 'error',
          rawReason: 'app-server-protocol-error',
          error: errorMessage(error),
        });
        run.queue.end();
      }
    });
    await client.initialize(this.options.clientVersion ?? '0.1.0');
    return client;
  }

  private async handleServerRequest(request: CodexServerRequest): Promise<unknown> {
    if (
      request.method === 'item/commandExecution/requestApproval' ||
      request.method === 'item/fileChange/requestApproval'
    ) {
      // Native side effects never inherit kickoff approval. Only broker command
      // ids and structured patches can mutate the worktree.
      const params = asRecord(request.params);
      const run = typeof params.threadId === 'string' ? this.active.get(params.threadId) : undefined;
      const callId = typeof params.itemId === 'string' ? params.itemId : `native:${String(request.id)}`;
      if (run) {
        run.queue.push({
          type: 'tool_requested',
          callId,
          name: request.method,
          input: request.params,
        });
        run.queue.push({
          type: 'tool_completed',
          callId,
          name: request.method,
          output: { decision: 'decline', reason: 'native-side-effect-denied' },
          isError: true,
        });
      }
      return { decision: 'decline' };
    }
    if (request.method !== 'item/tool/call') {
      throw new Error(`Goalie denied unsupported Codex request ${request.method}.`);
    }

    const params = dynamicToolParamsSchema.parse(request.params);
    const run = this.active.get(params.threadId);
    if (!run || run.turnId !== params.turnId) {
      throw new Error('Dynamic tool call does not belong to the active Goalie turn.');
    }
    if (!isBrokerToolName(params.tool) || !brokerToolNamesForRole(run.request.role).includes(params.tool)) {
      throw new Error(`Dynamic tool is not allowed for this actor: ${params.tool}`);
    }

    run.queue.push({
      type: 'tool_requested',
      callId: params.callId,
      name: params.tool,
      input: params.arguments,
    });
    try {
      const output = await run.broker.invoke(params.tool, params.arguments, run.signal);
      run.queue.push({
        type: 'tool_completed',
        callId: params.callId,
        name: params.tool,
        output,
        isError: false,
      });
      return {
        success: true,
        contentItems: [{ type: 'inputText', text: JSON.stringify(output) }],
      };
    } catch (error) {
      const output = { error: errorMessage(error) };
      run.queue.push({
        type: 'tool_completed',
        callId: params.callId,
        name: params.tool,
        output,
        isError: true,
      });
      return {
        success: false,
        contentItems: [{ type: 'inputText', text: JSON.stringify(output) }],
      };
    }
  }

  private handleNotification(notification: CodexNotification): void {
    const params = asRecord(notification.params);
    const threadId =
      typeof params.threadId === 'string'
        ? params.threadId
        : typeof asRecord(params.thread).id === 'string'
          ? String(asRecord(params.thread).id)
          : undefined;
    if (!threadId) return;
    const run = this.active.get(threadId);
    if (!run || run.terminal) return;

    switch (notification.method) {
      case 'turn/started': {
        const turn = asRecord(params.turn);
        if (typeof turn.id === 'string') run.turnId = turn.id;
        return;
      }
      case 'item/agentMessage/delta': {
        const delta = String(params.delta ?? '');
        run.text += delta;
        run.queue.push({ type: 'text_delta', text: delta });
        return;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        run.queue.push({ type: 'reasoning_delta', text: String(params.delta ?? '') });
        return;
      case 'thread/tokenUsage/updated': {
        const last = asRecord(asRecord(params.tokenUsage).last);
        run.queue.push({
          type: 'usage',
          usage: {
            ...(typeof last.inputTokens === 'number' ? { inputTokens: last.inputTokens } : {}),
            ...(typeof last.outputTokens === 'number' ? { outputTokens: last.outputTokens } : {}),
            ...(typeof last.cachedInputTokens === 'number'
              ? { cacheReadTokens: last.cachedInputTokens }
              : {}),
            ...(typeof last.cacheWriteInputTokens === 'number'
              ? { cacheWriteTokens: last.cacheWriteInputTokens }
              : {}),
          },
        });
        return;
      }
      case 'turn/completed': {
        const turn = asRecord(params.turn);
        const status = String(turn.status ?? 'failed');
        const providerError = asRecord(turn.error);
        let structuredOutput: unknown;
        if (run.request.outputSchema && run.text.trim()) {
          try {
            structuredOutput = JSON.parse(run.text);
          } catch (error) {
            run.terminal = true;
            run.queue.push({
              type: 'terminal',
              status: 'error',
              rawReason: 'invalid-structured-output',
              error: errorMessage(error),
            });
            run.queue.end();
            return;
          }
        }
        run.terminal = true;
        run.queue.push({
          type: 'terminal',
          status: terminalStatus(status),
          rawReason: status,
          ...(typeof providerError.message === 'string' ? { error: providerError.message } : {}),
          ...(structuredOutput !== undefined ? { structuredOutput } : {}),
        });
        run.queue.end();
      }
    }
  }
}
