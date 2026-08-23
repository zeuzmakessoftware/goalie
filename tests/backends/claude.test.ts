import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ClaudeBackend, type ClaudeSdkLoader } from '../../src/backends/claude.js';
import type { BackendEvent, BackendRunRequest } from '../../src/backends/types.js';
import { ToolBroker } from '../../src/runtime/tool-broker.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(candidate => rm(candidate, { recursive: true, force: true })));
});

async function collect(iterable: AsyncIterable<BackendEvent>): Promise<BackendEvent[]> {
  const events: BackendEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('ClaudeBackend', () => {
  test('is a robust availability stub when the optional SDK cannot load', async () => {
    const backend = new ClaudeBackend({ sdkLoader: async () => await Promise.reject(new Error('SDK absent')) });
    await expect(backend.availability()).resolves.toMatchObject({ available: false, reason: 'SDK absent' });
  });

  test('removes native tools and invokes the host broker through SDK MCP', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'goalie-claude-'));
    cleanup.push(root);
    const broker = new ToolBroker({ root, actorId: 'worker' });
    const handlers = new Map<string, (input: Record<string, unknown>, extra?: unknown) => Promise<unknown>>();
    let queryParams: Record<string, unknown> | undefined;
    const sdkLoader: ClaudeSdkLoader = async () => ({
      tool: (name, _description, _input, handler) => {
        handlers.set(name, handler);
        return { name };
      },
      createSdkMcpServer: options => ({ type: 'sdk', options }),
      query: params => {
        queryParams = params as Record<string, unknown>;
        return (async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'claude-session' };
          const patch = handlers.get('apply_patch');
          if (!patch) throw new Error('patch handler missing');
          await patch(
            {
              operationId: 'claude-patch',
              operations: [{ type: 'write', path: 'claude.ts', content: 'export const ok = true;\n' }],
            },
            { toolUseID: 'provider-tool-id' },
          );
          yield {
            type: 'stream_event',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'implemented' } },
          };
          yield {
            type: 'result',
            subtype: 'success',
            session_id: 'claude-session',
            usage: { input_tokens: 10, output_tokens: 3 },
            total_cost_usd: 0.01,
            structured_output: { verdict: 'ok' },
          };
        })();
      },
    });
    const backend = new ClaudeBackend({ sdkLoader });
    const request: BackendRunRequest = {
      runId: 'run',
      actorId: 'worker',
      role: 'worker',
      prompt: 'code',
      cwd: root,
      outputSchema: { type: 'object' },
    };

    const events = await collect(backend.run(request, broker));
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool_requested', callId: 'provider-tool-id', name: 'apply_patch' }),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'terminal',
      status: 'completed',
      structuredOutput: { verdict: 'ok' },
    });
    expect(await readFile(path.join(root, 'claude.ts'), 'utf8')).toContain('ok = true');

    const options = queryParams?.options as Record<string, unknown>;
    expect(options.tools).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settingSources).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.allowedTools).not.toContain('StructuredOutput');
    expect(handlers.has('StructuredOutput')).toBe(false);
    const hooks = options.hooks as { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<Record<string, unknown>>> }> };
    const preToolUse = hooks.PreToolUse[0]!.hooks[0]!;
    await expect(preToolUse({ tool_name: 'mcp__goalie__read_file' })).resolves.toMatchObject({
      continue: true,
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
    await expect(preToolUse({ tool_name: 'Bash' })).resolves.toMatchObject({
      continue: false,
      decision: 'block',
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await expect(preToolUse({ tool_name: 'StructuredOutput' })).resolves.toMatchObject({
      continue: true,
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
    const canUseTool = options.canUseTool as (toolName: string) => Promise<Record<string, unknown>>;
    await expect(canUseTool('mcp__goalie__apply_patch')).resolves.toEqual({ behavior: 'allow' });
    await expect(canUseTool('StructuredOutput')).resolves.toEqual({ behavior: 'allow' });
  });

  test('does not authorize the SDK structured-output sentinel without an output schema', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'goalie-claude-'));
    cleanup.push(root);
    const broker = new ToolBroker({ root, actorId: 'critic' });
    let queryParams: Record<string, unknown> | undefined;
    const sdkLoader: ClaudeSdkLoader = async () => ({
      tool: name => ({ name }),
      createSdkMcpServer: options => ({ type: 'sdk', options }),
      query: params => {
        queryParams = params as Record<string, unknown>;
        return (async function* () {
          yield { type: 'result', subtype: 'success', usage: {}, total_cost_usd: 0 };
        })();
      },
    });
    const backend = new ClaudeBackend({ sdkLoader });

    await collect(backend.run({
      runId: 'run',
      actorId: 'critic',
      role: 'critic',
      prompt: 'audit',
      cwd: root,
    }, broker));

    const options = queryParams?.options as Record<string, unknown>;
    expect(options.allowedTools).toEqual([]);
    expect(options.allowedTools).not.toContain('StructuredOutput');
    const hooks = options.hooks as { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<Record<string, unknown>>> }> };
    await expect(hooks.PreToolUse[0]!.hooks[0]!({ tool_name: 'StructuredOutput' })).resolves.toMatchObject({
      continue: false,
      decision: 'block',
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    const canUseTool = options.canUseTool as (toolName: string) => Promise<Record<string, unknown>>;
    await expect(canUseTool('StructuredOutput')).resolves.toMatchObject({
      behavior: 'deny',
      interrupt: false,
    });
  });

  test('gives a schema-bound critic only the SDK verdict sentinel and no workspace tools', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'goalie-claude-'));
    cleanup.push(root);
    const broker = new ToolBroker({ root, actorId: 'critic', allowedTools: [] });
    const registeredTools: string[] = [];
    let queryParams: Record<string, unknown> | undefined;
    const sdkLoader: ClaudeSdkLoader = async () => ({
      tool: name => {
        registeredTools.push(name);
        return { name };
      },
      createSdkMcpServer: options => ({ type: 'sdk', options }),
      query: params => {
        queryParams = params as Record<string, unknown>;
        return (async function* () {
          yield {
            type: 'result',
            subtype: 'success',
            usage: {},
            total_cost_usd: 0,
            structured_output: {
              overall: 'pass',
              score: 100,
              confidence: 1,
              criteria: [{ id: 'correctness', status: 'passed', evidenceIds: [], rationale: 'Evidence passes.' }],
            },
          };
        })();
      },
    });
    const backend = new ClaudeBackend({ sdkLoader });

    await collect(backend.run({
      runId: 'review',
      actorId: 'critic',
      role: 'critic',
      prompt: 'Judge only this evidence.',
      cwd: root,
      outputSchema: { type: 'object' },
    }, broker));

    const options = queryParams?.options as Record<string, unknown>;
    expect(registeredTools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(String(options.systemPrompt)).toContain('evidence-only review');
    const hooks = options.hooks as { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<Record<string, unknown>>> }> };
    await expect(hooks.PreToolUse[0]!.hooks[0]!({ tool_name: 'mcp__goalie__read_file' })).resolves.toMatchObject({
      continue: false,
      decision: 'block',
    });
    await expect(hooks.PreToolUse[0]!.hooks[0]!({ tool_name: 'StructuredOutput' })).resolves.toMatchObject({
      continue: true,
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
  });
});
