import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, test } from 'vitest';
import { CodexAppServerBackend } from '../../src/backends/codex-app-server.js';
import {
  CodexAppServerClient,
  type JsonLineTransport,
} from '../../src/backends/codex-app-server-client.js';
import type { BackendEvent, BackendRunRequest } from '../../src/backends/types.js';
import { ToolBroker } from '../../src/runtime/tool-broker.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(candidate => rm(candidate, { recursive: true, force: true })));
});

async function nextJson(lines: AsyncIterator<string>): Promise<Record<string, unknown>> {
  const line = await lines.next();
  if (line.done) throw new Error('transport ended');
  return JSON.parse(line.value) as Record<string, unknown>;
}

async function collect(iterable: AsyncIterable<BackendEvent>): Promise<BackendEvent[]> {
  const events: BackendEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('CodexAppServerBackend', () => {
  test('starts evidence-only reviewers with no dynamic tools and rejects broker calls', async () => {
    const inbound = new PassThrough();
    const outbound = new PassThrough();
    const transport: JsonLineTransport = {
      readable: inbound,
      writable: outbound,
      close: () => undefined,
    };
    const client = new CodexAppServerClient({ transport });
    const lines = createInterface({ input: outbound })[Symbol.asyncIterator]();
    const root = await mkdtemp(path.join(tmpdir(), 'goalie-codex-review-'));
    cleanup.push(root);
    const broker = new ToolBroker({ root, actorId: 'critic', allowedTools: [] });
    const backend = new CodexAppServerBackend({ clientFactory: async () => client });
    const eventsPromise = collect(backend.run({
      runId: 'review-1',
      actorId: 'critic',
      role: 'critic',
      prompt: 'Judge only the supplied evidence.',
      cwd: root,
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    }, broker));

    const initialize = await nextJson(lines);
    inbound.write(`${JSON.stringify({ id: initialize.id, result: { serverInfo: {} } })}\n`);
    expect(await nextJson(lines)).toMatchObject({ method: 'initialized' });

    const threadStart = await nextJson(lines);
    expect(threadStart).toMatchObject({
      method: 'thread/start',
      params: {
        cwd: root,
        runtimeWorkspaceRoots: [root],
        dynamicTools: [],
      },
    });
    expect(String((threadStart.params as Record<string, unknown>).developerInstructions)).toContain('evidence-only review');
    inbound.write(`${JSON.stringify({ id: threadStart.id, result: { thread: { id: 'review-thread' } } })}\n`);

    const turnStart = await nextJson(lines);
    inbound.write(`${JSON.stringify({
      id: turnStart.id,
      result: { turn: { id: 'review-turn', status: 'inProgress', items: [] } },
    })}\n`);
    await new Promise<void>(resolve => setImmediate(resolve));

    inbound.write(`${JSON.stringify({
      id: 'forbidden-read',
      method: 'item/tool/call',
      params: {
        threadId: 'review-thread',
        turnId: 'review-turn',
        callId: 'read-1',
        tool: 'read_file',
        arguments: { path: 'anything' },
      },
    })}\n`);
    expect(await nextJson(lines)).toMatchObject({
      id: 'forbidden-read',
      error: { code: -32001, message: expect.stringContaining('not allowed') },
    });

    inbound.write(`${JSON.stringify({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'review-thread',
        turnId: 'review-turn',
        itemId: 'message-1',
        delta: '{"ok":true}',
      },
    })}\n`);
    inbound.write(`${JSON.stringify({
      method: 'turn/completed',
      params: {
        threadId: 'review-thread',
        turn: { id: 'review-turn', status: 'completed', items: [] },
      },
    })}\n`);

    expect((await eventsPromise).at(-1)).toMatchObject({
      type: 'terminal',
      status: 'completed',
      structuredOutput: { ok: true },
    });
    backend.close();
  });

  test('declines native mutations and executes only host-broker dynamic tools', async () => {
    const inbound = new PassThrough();
    const outbound = new PassThrough();
    const transport: JsonLineTransport = {
      readable: inbound,
      writable: outbound,
      close: () => undefined,
    };
    const client = new CodexAppServerClient({ transport });
    const lines = createInterface({ input: outbound })[Symbol.asyncIterator]();
    const root = await mkdtemp(path.join(tmpdir(), 'goalie-codex-'));
    cleanup.push(root);
    const broker = new ToolBroker({ root, actorId: 'worker' });
    const backend = new CodexAppServerBackend({ clientFactory: async () => client });
    const request: BackendRunRequest = {
      runId: 'run-1',
      actorId: 'worker',
      role: 'worker',
      prompt: 'implement safely',
      cwd: root,
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    };
    const eventsPromise = collect(backend.run(request, broker));

    const initialize = await nextJson(lines);
    expect(initialize).toMatchObject({
      method: 'initialize',
      params: { capabilities: { experimentalApi: true, requestAttestation: false } },
    });
    inbound.write(`${JSON.stringify({ id: initialize.id, result: { serverInfo: {} } })}\n`);
    expect(await nextJson(lines)).toMatchObject({ method: 'initialized' });

    const threadStart = await nextJson(lines);
    expect(threadStart).toMatchObject({
      method: 'thread/start',
      params: {
        sandbox: 'read-only',
        allowProviderModelFallback: false,
        dynamicTools: expect.arrayContaining([expect.objectContaining({ name: 'apply_patch' })]),
      },
    });
    inbound.write(
      `${JSON.stringify({
        method: 'remoteControl/status/changed',
        params: {
          status: 'disabled',
          serverName: 'local',
          installationId: 'test-installation',
          environmentId: null,
        },
      })}\n`,
    );
    inbound.write(
      `${JSON.stringify({
        method: 'mcpServer/startupStatus/updated',
        params: {
          threadId: null,
          name: 'disabled-test-server',
          status: 'cancelled',
          error: null,
          failureReason: null,
        },
      })}\n`,
    );
    inbound.write(
      `${JSON.stringify({
        method: 'account/rateLimits/updated',
        params: {
          rateLimits: {
            limitId: null,
            limitName: null,
            primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null },
            secondary: null,
            credits: null,
            individualLimit: null,
            spendControlReached: null,
            planType: 'plus',
            rateLimitReachedType: null,
          },
        },
      })}\n`,
    );
    inbound.write(
      `${JSON.stringify({ id: threadStart.id, result: { thread: { id: 'thread-1' } } })}\n`,
    );

    const turnStart = await nextJson(lines);
    expect(turnStart).toMatchObject({ method: 'turn/start', params: { threadId: 'thread-1' } });
    inbound.write(
      `${JSON.stringify({
        id: turnStart.id,
        result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } },
      })}\n`,
    );
    await new Promise<void>(resolve => setImmediate(resolve));

    inbound.write(
      `${JSON.stringify({
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'native-command',
          startedAtMs: Date.now(),
        },
      })}\n`,
    );
    expect(await nextJson(lines)).toMatchObject({ id: 'approval-1', result: { decision: 'decline' } });

    inbound.write(
      `${JSON.stringify({
        id: 'tool-request-1',
        method: 'item/tool/call',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'patch-1',
          tool: 'apply_patch',
          arguments: {
            operationId: 'codex-patch',
            operations: [{ type: 'write', path: 'codex.ts', content: 'export const safe = true;\n' }],
          },
        },
      })}\n`,
    );
    expect(await nextJson(lines)).toMatchObject({
      id: 'tool-request-1',
      result: { success: true },
    });

    inbound.write(
      `${JSON.stringify({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'message-1',
          delta: '{"ok":true}',
        },
      })}\n`,
    );
    inbound.write(
      `${JSON.stringify({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', items: [] },
        },
      })}\n`,
    );

    const events = await eventsPromise;
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_completed',
        callId: 'native-command',
        isError: true,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool_completed', callId: 'patch-1', isError: false }),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'terminal',
      status: 'completed',
      structuredOutput: { ok: true },
    });
    expect(await readFile(path.join(root, 'codex.ts'), 'utf8')).toContain('safe = true');
    backend.close();
  });
});
