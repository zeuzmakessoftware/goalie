import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ScriptedBackend } from '../../src/backends/scripted.js';
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

describe('ScriptedBackend', () => {
  test('deterministically drives broker patches and checks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'goalie-scripted-'));
    cleanup.push(root);
    const broker = new ToolBroker({
      root,
      actorId: 'worker',
      approvedCommands: [
        {
          id: 'unit',
          kind: 'check',
          argv: [process.execPath, '-e', 'process.stdout.write("pass")'],
        },
      ],
    });
    const backend = new ScriptedBackend(() => [
      {
        type: 'tool',
        callId: 'patch-call',
        name: 'apply_patch',
        input: {
          operationId: 'fixture-patch',
          operations: [{ type: 'write', path: 'feature.ts', content: 'export const score = 1;\n' }],
        },
      },
      { type: 'tool', callId: 'check-call', name: 'run_check', input: { checkId: 'unit' } },
      { type: 'event', event: { type: 'text_delta', text: 'done' } },
    ]);
    const request: BackendRunRequest = {
      runId: 'run-1',
      actorId: 'worker',
      role: 'worker',
      prompt: 'implement',
      cwd: root,
    };

    const events = await collect(backend.run(request, broker));
    expect(events.filter(event => event.type === 'tool_completed')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'terminal', status: 'completed' });
    expect(await readFile(path.join(root, 'feature.ts'), 'utf8')).toContain('score = 1');
  });
});
