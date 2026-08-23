import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { describe, expect, test } from 'vitest';
import {
  CodexAppServerClient,
  type JsonLineTransport,
} from '../../src/backends/codex-app-server-client.js';

function harness(): {
  client: CodexAppServerClient;
  inbound: PassThrough;
  lines: AsyncIterator<string>;
  wasClosed: () => boolean;
} {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  let closed = false;
  const transport: JsonLineTransport = {
    readable: inbound,
    writable: outbound,
    close: () => {
      closed = true;
    },
  };
  const lines = createInterface({ input: outbound })[Symbol.asyncIterator]();
  return {
    client: new CodexAppServerClient({ transport }),
    inbound,
    lines,
    wasClosed: () => closed,
  };
}

async function nextJson(lines: AsyncIterator<string>): Promise<Record<string, unknown>> {
  const line = await lines.next();
  if (line.done) throw new Error('transport ended');
  return JSON.parse(line.value) as Record<string, unknown>;
}

async function initialize(
  client: CodexAppServerClient,
  inbound: PassThrough,
  lines: AsyncIterator<string>,
): Promise<void> {
  const pending = client.initialize('test');
  const request = await nextJson(lines);
  expect(request).toMatchObject({
    method: 'initialize',
    params: {
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
      },
    },
  });
  inbound.write(`${JSON.stringify({ id: request.id, result: { userAgent: 'test' } })}\n`);
  await pending;
  expect(await nextJson(lines)).toMatchObject({ method: 'initialized' });
}

describe('CodexAppServerClient', () => {
  test('validates and answers server-initiated dynamic tool calls', async () => {
    const { client, inbound, lines } = harness();
    await initialize(client, inbound, lines);
    client.setRequestHandler(async request => ({ echoed: request.params }));
    inbound.write(
      `${JSON.stringify({
        id: 'server-1',
        method: 'item/tool/call',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'call-1',
          tool: 'read_file',
          arguments: { path: 'README.md' },
        },
      })}\n`,
    );
    expect(await nextJson(lines)).toMatchObject({ id: 'server-1', result: { echoed: { callId: 'call-1' } } });
    client.close();
  });

  test('ignores a known late response after local abort but fails closed on unknown events', async () => {
    const { client, inbound, lines, wasClosed } = harness();
    await initialize(client, inbound, lines);
    const controller = new AbortController();
    const pending = client.request('thread/read', { threadId: 'thread-1' }, controller.signal);
    const request = await nextJson(lines);
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    inbound.write(`${JSON.stringify({ id: request.id, result: { thread: {} } })}\n`);

    const protocolError = new Promise<unknown>(resolve => client.onError(resolve));
    inbound.write(`${JSON.stringify({ method: 'future/unsafe/event', params: {} })}\n`);
    await expect(protocolError).resolves.toMatchObject({ code: 'CODEX_PROTOCOL_ERROR' });
    expect(wasClosed()).toBe(true);
  });
});
