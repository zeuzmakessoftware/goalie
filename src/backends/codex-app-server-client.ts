import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import type { InitializeCapabilities } from './generated/codex-0.145/InitializeCapabilities.js';
import type { AccountRateLimitsUpdatedNotification } from './generated/codex-0.145/v2/AccountRateLimitsUpdatedNotification.js';
import type { AccountUpdatedNotification } from './generated/codex-0.145/v2/AccountUpdatedNotification.js';
import type { McpServerStatusUpdatedNotification } from './generated/codex-0.145/v2/McpServerStatusUpdatedNotification.js';
import type { RemoteControlStatusChangedNotification } from './generated/codex-0.145/v2/RemoteControlStatusChangedNotification.js';

export interface JsonLineTransport {
  readable: Readable;
  writable: Writable;
  close(): void;
}

export interface CodexNotification {
  method: string;
  params: unknown;
}

export interface CodexServerRequest {
  id: string | number;
  method: string;
  params: unknown;
}

export type CodexServerRequestHandler = (request: CodexServerRequest) => Promise<unknown>;

export interface CodexAppServerClientOptions {
  transport: JsonLineTransport;
  requestHandler?: CodexServerRequestHandler;
  maxLineBytes?: number;
}

export class CodexProtocolError extends Error {
  readonly code = 'CODEX_PROTOCOL_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'CodexProtocolError';
  }
}

const responseSchema = z.union([
  z.object({ id: z.union([z.string(), z.number()]), result: z.unknown() }).passthrough(),
  z
    .object({
      id: z.union([z.string(), z.number()]),
      error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).passthrough(),
    })
    .passthrough(),
]);
const inboundRequestSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    method: z.string(),
    params: z.unknown().optional(),
  })
  .passthrough();
const notificationSchema = z
  .object({
    method: z.string(),
    params: z.unknown().optional(),
  })
  .passthrough();

export const CODEX_CLIENT_METHODS = new Set([
  'initialize',
  'thread/start',
  'thread/resume',
  'thread/read',
  'turn/start',
  'turn/interrupt',
]);

export const CODEX_SERVER_REQUEST_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'item/tool/call',
  'mcpServer/elicitation/request',
]);

export const CODEX_NOTIFICATION_METHODS = new Set([
  'error',
  'warning',
  'guardianWarning',
  'deprecationNotice',
  'configWarning',
  'thread/started',
  'thread/status/changed',
  'thread/closed',
  'thread/tokenUsage/updated',
  'turn/started',
  'turn/completed',
  'turn/diff/updated',
  'turn/plan/updated',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/mcpToolCall/progress',
  'mcpServer/startupStatus/updated',
  'account/updated',
  'account/rateLimits/updated',
  'serverRequest/resolved',
  'thread/compacted',
  'model/rerouted',
  'model/verification',
  'model/safetyBuffering/updated',
  'remoteControl/status/changed',
]);

const dynamicToolRequestSchema = z
  .object({
    threadId: z.string(),
    turnId: z.string(),
    callId: z.string(),
    tool: z.string(),
    arguments: z.unknown(),
    namespace: z.string().nullable().optional(),
  })
  .passthrough();
const approvalRequestSchema = z
  .object({
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    startedAtMs: z.number(),
  })
  .passthrough();
const threadBoundSchema = z.object({ threadId: z.string() }).passthrough();
const turnBoundSchema = z
  .object({ threadId: z.string(), turnId: z.string() })
  .passthrough();
const deltaNotificationSchema = z
  .object({ threadId: z.string(), turnId: z.string(), itemId: z.string(), delta: z.string() })
  .passthrough();
const turnNotificationSchema = z
  .object({
    threadId: z.string(),
    turn: z.object({ id: z.string(), status: z.string() }).passthrough(),
  })
  .passthrough();
const itemNotificationSchema = z
  .object({
    threadId: z.string(),
    turnId: z.string(),
    item: z.object({ id: z.string(), type: z.string() }).passthrough(),
  })
  .passthrough();
const remoteControlStatusChangedSchema: z.ZodType<RemoteControlStatusChangedNotification> = z
  .object({
    status: z.enum(['disabled', 'connecting', 'connected', 'errored']),
    serverName: z.string(),
    installationId: z.string(),
    environmentId: z.string().nullable(),
  })
  .strict();
const mcpServerStatusUpdatedSchema: z.ZodType<McpServerStatusUpdatedNotification> = z
  .object({
    threadId: z.string().nullable(),
    name: z.string(),
    status: z.enum(['starting', 'ready', 'failed', 'cancelled']),
    error: z.string().nullable(),
    failureReason: z.enum(['reauthenticationRequired']).nullable(),
  })
  .strict();
const planTypeSchema = z.enum([
  'free',
  'go',
  'plus',
  'pro',
  'prolite',
  'team',
  'self_serve_business_usage_based',
  'business',
  'enterprise_cbp_usage_based',
  'enterprise',
  'edu',
  'unknown',
]);
const accountUpdatedSchema: z.ZodType<AccountUpdatedNotification> = z
  .object({
    authMode: z.enum(['apikey', 'chatgpt', 'chatgptAuthTokens', 'headers', 'agentIdentity', 'personalAccessToken', 'bedrockApiKey']).nullable(),
    planType: planTypeSchema.nullable(),
  })
  .strict();
const rateLimitWindowSchema = z
  .object({ usedPercent: z.number(), windowDurationMins: z.number().nullable(), resetsAt: z.number().nullable() })
  .strict();
const accountRateLimitsUpdatedSchema: z.ZodType<AccountRateLimitsUpdatedNotification> = z
  .object({
    rateLimits: z.object({
      limitId: z.string().nullable(),
      limitName: z.string().nullable(),
      primary: rateLimitWindowSchema.nullable(),
      secondary: rateLimitWindowSchema.nullable(),
      credits: z.object({ hasCredits: z.boolean(), unlimited: z.boolean(), balance: z.string().nullable() }).strict().nullable(),
      individualLimit: z.object({ limit: z.string(), used: z.string(), remainingPercent: z.number(), resetsAt: z.number() }).strict().nullable(),
      spendControlReached: z.boolean().nullable(),
      planType: planTypeSchema.nullable(),
      rateLimitReachedType: z.enum([
        'rate_limit_reached',
        'workspace_owner_credits_depleted',
        'workspace_member_credits_depleted',
        'workspace_owner_usage_limit_reached',
        'workspace_member_usage_limit_reached',
      ]).nullable(),
    }).strict(),
  })
  .strict();

function validateServerRequest(method: string, params: unknown): unknown {
  switch (method) {
    case 'item/tool/call':
      return dynamicToolRequestSchema.parse(params);
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'item/permissions/requestApproval':
      return approvalRequestSchema.parse(params);
    case 'item/tool/requestUserInput':
    case 'mcpServer/elicitation/request':
      return z.object({ threadId: z.string() }).passthrough().parse(params);
    default:
      throw new CodexProtocolError(`Unsupported server request method: ${method}`);
  }
}

function validateNotification(method: string, params: unknown): unknown {
  switch (method) {
    case 'thread/started':
      return z.object({ thread: z.object({ id: z.string() }).passthrough() }).passthrough().parse(params);
    case 'thread/status/changed':
    case 'thread/closed':
      return threadBoundSchema.parse(params);
    case 'thread/tokenUsage/updated':
      return turnBoundSchema.extend({ tokenUsage: z.record(z.string(), z.unknown()) }).parse(params);
    case 'turn/started':
    case 'turn/completed':
      return turnNotificationSchema.parse(params);
    case 'item/started':
    case 'item/completed':
      return itemNotificationSchema.parse(params);
    case 'item/agentMessage/delta':
    case 'item/plan/delta':
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta':
      return deltaNotificationSchema.parse(params);
    case 'turn/diff/updated':
      return turnBoundSchema.extend({ diff: z.string() }).parse(params);
    case 'turn/plan/updated':
    case 'item/reasoning/summaryPartAdded':
    case 'item/commandExecution/outputDelta':
    case 'item/commandExecution/terminalInteraction':
    case 'item/fileChange/outputDelta':
    case 'item/fileChange/patchUpdated':
    case 'item/mcpToolCall/progress':
    case 'thread/compacted':
    case 'model/rerouted':
    case 'model/verification':
    case 'model/safetyBuffering/updated':
      return turnBoundSchema.parse(params);
    case 'serverRequest/resolved':
      return threadBoundSchema.extend({ requestId: z.union([z.string(), z.number()]) }).parse(params);
    case 'remoteControl/status/changed':
      return remoteControlStatusChangedSchema.parse(params);
    case 'mcpServer/startupStatus/updated':
      return mcpServerStatusUpdatedSchema.parse(params);
    case 'account/updated':
      return accountUpdatedSchema.parse(params);
    case 'account/rateLimits/updated':
      return accountRateLimitsUpdatedSchema.parse(params);
    case 'error':
    case 'warning':
    case 'guardianWarning':
    case 'deprecationNotice':
    case 'configWarning':
      return z.record(z.string(), z.unknown()).parse(params);
    default:
      throw new CodexProtocolError(`Unknown Codex notification: ${method}`);
  }
}

export function childProcessTransport(child: ChildProcessWithoutNullStreams): JsonLineTransport {
  return {
    readable: child.stdout,
    writable: child.stdin,
    close: () => child.kill('SIGTERM'),
  };
}

/**
 * Defense in depth: dynamic Goalie tools are the only intended tool surface.
 * Disabling native execution, integrations, hooks, and delegation prevents a
 * model from using read-only native tools to inspect credentials outside the
 * broker's path policy. Unsupported flags make startup fail closed.
 */
export const DEFAULT_CODEX_APP_SERVER_ARGS: readonly string[] = [
  'app-server',
  '--stdio',
  '--disable',
  'shell_tool',
  '--disable',
  'unified_exec',
  '--disable',
  'shell_snapshot',
  '--disable',
  'hooks',
  '--disable',
  'apps',
  '--disable',
  'plugins',
  '--disable',
  'browser_use',
  '--disable',
  'browser_use_external',
  '--disable',
  'browser_use_full_cdp_access',
  '--disable',
  'in_app_browser',
  '--disable',
  'computer_use',
  '--disable',
  'image_generation',
  '--disable',
  'code_mode_host',
  '--disable',
  'workspace_dependencies',
  '--disable',
  'multi_agent',
  '--disable',
  'multi_agent_v2',
  '--disable',
  'tool_call_mcp_elicitation',
  '--disable',
  'auth_elicitation',
  '--disable',
  'skill_mcp_dependency_install',
];

export function spawnCodexAppServer(
  command = 'codex',
  args: readonly string[] = DEFAULT_CODEX_APP_SERVER_ARGS,
): JsonLineTransport {
  const child = spawn(command, [...args], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  // App Server diagnostics are intentionally not part of the JSONL protocol, but
  // must still be drained so a full stderr pipe cannot deadlock the child.
  child.stderr.resume();
  return childProcessTransport(child);
}

export class CodexAppServerClient {
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private readonly maxLineBytes: number;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  private readonly abandonedResponseIds = new Set<string>();
  private readonly notificationListeners = new Set<(notification: CodexNotification) => void>();
  private readonly errorListeners = new Set<(error: unknown) => void>();
  private requestHandler: CodexServerRequestHandler | undefined;

  constructor(private readonly options: CodexAppServerClientOptions) {
    this.maxLineBytes = options.maxLineBytes ?? 8_000_000;
    this.requestHandler = options.requestHandler;
    options.transport.readable.on('data', this.onData);
    options.transport.readable.on('end', () => this.fail(new CodexProtocolError('Codex App Server stream ended.')));
    options.transport.readable.on('error', error => this.fail(error));
    options.transport.writable.on('error', error => this.fail(error));
  }

  setRequestHandler(handler: CodexServerRequestHandler): void {
    this.requestHandler = handler;
  }

  onNotification(listener: (notification: CodexNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onError(listener: (error: unknown) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  async initialize(clientVersion = '0.1.0'): Promise<unknown> {
    const capabilities = {
      // runtimeWorkspaceRoots and dynamic tools are currently part of the
      // App Server experimental surface. This opts into those exact fields;
      // every inbound method is still checked by the fail-closed allowlist.
      experimentalApi: true,
      requestAttestation: false,
      mcpServerOpenaiFormElicitation: false,
      optOutNotificationMethods: [],
    } satisfies InitializeCapabilities;
    const result = await this.request('initialize', {
      clientInfo: { name: 'goalie-cli', title: 'Goalie CLI', version: clientVersion },
      capabilities,
    });
    this.notify('initialized', {});
    return result;
  }

  async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!CODEX_CLIENT_METHODS.has(method)) {
      throw new CodexProtocolError(`Client method is not allowlisted: ${method}`);
    }
    if (this.closed) throw new CodexProtocolError('Codex App Server client is closed.');
    const id = this.nextId++;
    const key = String(id);
    const response = new Promise<unknown>((resolve, reject) => this.pending.set(key, { resolve, reject }));
    const abort = (): void => {
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      this.abandonedResponseIds.add(key);
      if (this.abandonedResponseIds.size > 1_000) {
        const oldest = this.abandonedResponseIds.values().next().value as string | undefined;
        if (oldest) this.abandonedResponseIds.delete(oldest);
      }
      pending.reject(signal?.reason ?? new Error('Request aborted.'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      this.write({ id, method, params });
    } catch (error) {
      this.pending.delete(key);
      signal?.removeEventListener('abort', abort);
      throw error;
    }
    try {
      return await response;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  notify(method: 'initialized', params: unknown): void {
    if (this.closed) throw new CodexProtocolError('Codex App Server client is closed.');
    this.write({ method, params });
  }

  close(): void {
    this.fail(new CodexProtocolError('Codex App Server client closed.'));
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.closed) return;
    this.buffer += chunk.toString();
    if (Buffer.byteLength(this.buffer) > this.maxLineBytes && !this.buffer.includes('\n')) {
      this.fail(new CodexProtocolError('Codex App Server emitted an oversized JSONL record.'));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > this.maxLineBytes) {
        this.fail(new CodexProtocolError('Codex App Server emitted an oversized JSONL record.'));
        return;
      }
      void this.handleLine(line).catch(error => this.fail(error));
    }
  };

  private async handleLine(line: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      throw new CodexProtocolError(`Codex App Server emitted invalid JSON: ${String(error)}`);
    }
    const object = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
    if (!object) throw new CodexProtocolError('Codex App Server emitted a non-object message.');

    if ('id' in object && 'method' in object) {
      const parsed = inboundRequestSchema.parse(object);
      if (!CODEX_SERVER_REQUEST_METHODS.has(parsed.method)) {
        await this.writeError(parsed.id, -32601, `Unsupported server request: ${parsed.method}`);
        throw new CodexProtocolError(`Unsupported server request: ${parsed.method}`);
      }
      const params = validateServerRequest(parsed.method, parsed.params);
      try {
        if (!this.requestHandler) throw new CodexProtocolError('No server request handler is installed.');
        const result = await this.requestHandler({ id: parsed.id, method: parsed.method, params });
        this.write({ id: parsed.id, result });
      } catch (error) {
        await this.writeError(parsed.id, -32001, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if ('id' in object && ('result' in object || 'error' in object)) {
      const parsed = responseSchema.parse(object);
      const pending = this.pending.get(String(parsed.id));
      if (!pending) {
        const key = String(parsed.id);
        if (this.abandonedResponseIds.delete(key)) return;
        throw new CodexProtocolError(`Response has unknown id: ${key}`);
      }
      this.pending.delete(String(parsed.id));
      if ('error' in parsed) {
        const responseError = parsed.error as { code: number; message: string };
        pending.reject(
          new CodexProtocolError(`Codex request failed ${responseError.code}: ${responseError.message}`),
        );
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    if ('method' in object) {
      const parsed = notificationSchema.parse(object);
      if (!CODEX_NOTIFICATION_METHODS.has(parsed.method)) {
        throw new CodexProtocolError(`Unknown Codex notification: ${parsed.method}`);
      }
      const notification = { method: parsed.method, params: validateNotification(parsed.method, parsed.params) };
      for (const listener of this.notificationListeners) listener(notification);
      return;
    }
    throw new CodexProtocolError('Unrecognized Codex App Server message shape.');
  }

  private async writeError(id: string | number, code: number, message: string): Promise<void> {
    this.write({ id, error: { code, message } });
  }

  private write(message: unknown): void {
    if (this.closed) throw new CodexProtocolError('Codex App Server client is closed.');
    const line = `${JSON.stringify(message)}\n`;
    if (!this.options.transport.writable.write(line)) {
      // Node buffers the write; JSON-RPC ordering is still preserved.
    }
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.options.transport.readable.off('data', this.onData);
    this.options.transport.close();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const listener of this.errorListeners) listener(error);
  }
}
