import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ScriptedBackend } from '../../src/backends/scripted.js';
import type { AgentBackend } from '../../src/backends/types.js';
import { goalieConfigSchema } from '../../src/config.js';
import { ToolBroker } from '../../src/runtime/tool-broker.js';
import { createKickoffProposal } from '../../src/session/kickoff.js';
import { refineKickoffWithManager } from '../../src/session/planner.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'goalie-planner-'));
  cleanup.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const config = goalieConfigSchema.parse({
    commands: [{ id: 'test', executable: 'node', args: ['--test'], allowedArgs: [], cwd: '.', timeoutMs: 1_000, network: false, mutating: false, env: {} }],
  });
  return {
    root,
    proposal: await createKickoffProposal('Repair ingestion and ranking.', root, config),
    broker: new ToolBroker({ root, actorId: 'manager:kickoff', writeSet: [], protectedPaths: config.protectedPaths }),
  };
}

describe('kickoff manager planner', () => {
  it('turns a goal into a validated immutable dependency DAG', async () => {
    const { root, proposal, broker } = await fixture();
    const backend = new ScriptedBackend(() => [{
      type: 'event',
      event: {
        type: 'terminal',
        status: 'completed',
        structuredOutput: {
          summary: 'Repair storage first, then deterministic output.',
          tasks: [
            { id: 'task:storage', title: 'Storage', objective: 'Repair ingestion.', dependencies: [], writeSet: ['src/storage/**'], checkIds: ['check:test'] },
            { id: 'task:ranking', title: 'Ranking', objective: 'Repair ties.', dependencies: ['task:storage'], writeSet: ['src/ranking/**'], checkIds: ['check:test'] },
          ],
        },
      },
    }]);

    const planned = await refineKickoffWithManager({
      proposal,
      backend,
      provider: 'scripted',
      model: 'planner-test',
      version: '1',
      broker,
      cwd: root,
    });

    expect(planned.tasks.map(task => [task.id, task.status])).toEqual([
      ['task:storage', 'ready'],
      ['task:ranking', 'pending'],
    ]);
    expect(planned.spec.metadata.taskDag).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task:ranking', dependencies: ['task:storage'] }),
    ]));
    expect(planned.planning.planHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('uses exactly one repair attempt for malformed structured output', async () => {
    const { root, proposal, broker } = await fixture();
    let calls = 0;
    const backend = new ScriptedBackend(() => {
      calls += 1;
      return [{
        type: 'event',
        event: calls === 1
          ? { type: 'terminal', status: 'completed', structuredOutput: { tasks: [] } }
          : {
              type: 'terminal',
              status: 'completed',
              structuredOutput: {
                summary: 'Safe fallback plan.',
                tasks: [{ id: 'task:repair', title: 'Repair', objective: 'Repair safely.', dependencies: [], writeSet: ['src/**'], checkIds: ['check:test'] }],
              },
            },
      }];
    });

    const planned = await refineKickoffWithManager({ proposal, backend, provider: 'scripted', broker, cwd: root });
    expect(calls).toBe(2);
    expect(planned.planning.turns).toBe(2);
  });

  it('rejects cycles, unknown checks, and protected write sets', async () => {
    const { root, proposal, broker } = await fixture();
    const backend = new ScriptedBackend(() => [{
      type: 'event',
      event: {
        type: 'terminal',
        status: 'completed',
        structuredOutput: {
          summary: 'Unsafe plan.',
          tasks: [
            { id: 'task:a', title: 'A', objective: 'A', dependencies: ['task:b'], writeSet: ['.git/**'], checkIds: ['unknown'] },
            { id: 'task:b', title: 'B', objective: 'B', dependencies: ['task:a'], writeSet: ['src/**'], checkIds: [] },
          ],
        },
      },
    }]);

    await expect(refineKickoffWithManager({ proposal, backend, provider: 'scripted', broker, cwd: root })).rejects.toThrow();
  });

  it('rejects a DAG that drops a required immutable check', async () => {
    const { root, proposal, broker } = await fixture();
    const backend = new ScriptedBackend(() => [{
      type: 'event',
      event: {
        type: 'terminal',
        status: 'completed',
        structuredOutput: {
          summary: 'A superficially valid plan that omits the hard gate.',
          tasks: [{
            id: 'task:repair',
            title: 'Repair',
            objective: 'Repair without assigning the required verifier.',
            dependencies: [],
            writeSet: ['src/**'],
            checkIds: [],
          }],
        },
      },
    }]);

    await expect(
      refineKickoffWithManager({ proposal, backend, provider: 'scripted', broker, cwd: root }),
    ).rejects.toThrow('Manager plan omits required immutable check: check:test');
  });

  it('honors the host deadline even when a provider iterator never settles', async () => {
    const { root, proposal, broker } = await fixture();
    const backend: AgentBackend = {
      id: 'scripted',
      kind: 'scripted',
      capabilities: {
        streaming: true,
        resume: false,
        structuredOutput: true,
        hostApprovals: true,
        hostTools: true,
        costReporting: 'unknown',
      },
      availability: async () => ({ available: true }),
      isAvailable: async () => true,
      run: async function* () {
        yield { type: 'session_started', session: { backend: 'scripted', id: 'wedged' } } as const;
        await new Promise<never>(() => undefined);
      },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('host planning deadline')), 25);
    const startedAt = Date.now();

    try {
      await expect(refineKickoffWithManager({
        proposal,
        backend,
        provider: 'scripted',
        broker,
        cwd: root,
        signal: controller.signal,
      })).rejects.toThrow('host planning deadline');
    } finally {
      clearTimeout(timer);
    }
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
