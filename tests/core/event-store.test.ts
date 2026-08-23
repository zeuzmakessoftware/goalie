import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EventLogCorruptionError,
  EventStoreWriterLockedError,
  JsonlEventStore,
} from '../../src/core/event-store.js';
import { createInitialSessionState, reduceSession } from '../../src/core/reducer.js';
import { NOW, makeSpec } from './fixtures.js';

const temporaryDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'goalie-core-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('JsonlEventStore', () => {
  it('serializes concurrent appends into a verified hash chain', async () => {
    const directory = await tempDirectory();
    const store = await JsonlEventStore.open({
      directory,
      sessionId: 'session:test',
      writer: true,
      clock: () => new Date(NOW),
    });
    try {
      const spec = makeSpec();
      await store.append({ kind: 'session.created', payload: { spec } });
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          store.append({ kind: 'adapter.observed', payload: { index } }),
        ),
      );
      const events = await store.readEvents();
      expect(events.map((event) => event.sequence)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]);
      expect((await store.verify()).eventCount).toBe(9);
    } finally {
      await store.close();
    }
  });

  it('persists versioned, causally linked, redacted event envelopes', async () => {
    const directory = await tempDirectory();
    const store = await JsonlEventStore.open({
      directory,
      sessionId: 'session:test',
      writer: true,
      clock: () => new Date(NOW),
    });
    try {
      const event = await store.append({
        kind: 'adapter.observed',
        payload: { taskId: 'task:one', apiKey: 'sk-super-secret-value' },
      });
      expect(event).toMatchObject({
        schemaVersion: 1,
        causationId: event.id,
        taskId: 'task:one',
        artifactHashes: {},
        payload: { apiKey: '[REDACTED]', taskId: 'task:one' },
      });
      expect((await store.verify()).eventCount).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('enforces a cross-instance single-writer lease', async () => {
    const directory = await tempDirectory();
    const writer = await JsonlEventStore.open({
      directory,
      sessionId: 'session:test',
      writer: true,
    });
    await expect(
      JsonlEventStore.open({
        directory,
        sessionId: 'session:test',
        writer: true,
      }),
    ).rejects.toBeInstanceOf(EventStoreWriterLockedError);
    await writer.close();
  });

  it('uses a snapshot as a cache and replays its verified tail', async () => {
    const directory = await tempDirectory();
    const spec = makeSpec();
    const writer = await JsonlEventStore.open({
      directory,
      sessionId: 'session:test',
      writer: true,
      clock: () => new Date(NOW),
    });
    let state = createInitialSessionState('session:test', spec, NOW);
    const created = await writer.append({
      kind: 'session.created',
      payload: { spec },
    });
    state = reduceSession(state, created);
    await writer.writeSnapshot(state);
    const extension = await writer.append({
      kind: 'ui.tab_opened',
      payload: { tab: 'critic' },
    });
    state = reduceSession(state, extension);
    await writer.close();

    const reader = await JsonlEventStore.open({
      directory,
      sessionId: 'session:test',
    });
    const restored = await reader.loadState();
    expect(restored.lastSequence).toBe(state.lastSequence);
    expect(restored.lastHash).toBe(state.lastHash);
    expect(restored.spec.goal).toBe(spec.goal);
    await reader.close();
  });

  it('fails closed when an event line is modified', async () => {
    const directory = await tempDirectory();
    const writer = await JsonlEventStore.open({
      directory,
      sessionId: 'session:test',
      writer: true,
    });
    await writer.append({
      kind: 'session.created',
      payload: { spec: makeSpec() },
    });
    const path = writer.eventsPath;
    await writer.close();
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('Build and verify', 'Tampered goal'));

    await expect(
      JsonlEventStore.open({ directory, sessionId: 'session:test' }),
    ).rejects.toBeInstanceOf(EventLogCorruptionError);
  });

  it('ignores a corrupt snapshot cache and replays the verified log', async () => {
    const directory = await tempDirectory();
    const spec = makeSpec();
    const writer = await JsonlEventStore.open({
      directory,
      sessionId: 'session:test',
      writer: true,
      clock: () => new Date(NOW),
    });
    let state = createInitialSessionState('session:test', spec, NOW);
    const created = await writer.append({
      kind: 'session.created',
      payload: { spec },
    });
    state = reduceSession(state, created);
    await writer.writeSnapshot(state);
    await writer.close();
    const snapshotPath = join(directory, 'snapshot.json');
    const snapshot = await readFile(snapshotPath, 'utf8');
    await writeFile(snapshotPath, snapshot.replace(spec.goal, 'Corrupt cached goal'));

    const reader = await JsonlEventStore.open({
      directory,
      sessionId: 'session:test',
    });
    const restored = await reader.loadState();
    expect(restored.spec.goal).toBe(spec.goal);
    await reader.close();
  });

  it('durably truncates a torn final record before the next append', async () => {
    const directory = await tempDirectory();
    const first = await JsonlEventStore.open({ directory, sessionId: 'session:test', writer: true });
    await first.append({ kind: 'session.created', payload: { spec: makeSpec() } });
    const path = first.eventsPath;
    await first.close();
    await appendFile(path, '{"id":"torn"', 'utf8');

    const recovered = await JsonlEventStore.open({ directory, sessionId: 'session:test', writer: true });
    await recovered.append({ kind: 'session.recovered', payload: { ok: true } });
    await recovered.close();

    const reopened = await JsonlEventStore.open({ directory, sessionId: 'session:test' });
    expect((await reopened.verify()).eventCount).toBe(2);
    expect((await reopened.readEvents()).map(event => event.kind)).toEqual(['session.created', 'session.recovered']);
    await reopened.close();
  });

  it('recovers a writer lease whose process no longer exists', async () => {
    const directory = await tempDirectory();
    await writeFile(join(directory, 'writer.lock'), JSON.stringify({ token: 'stale', pid: 2_147_483_647 }));
    const writer = await JsonlEventStore.open({ directory, sessionId: 'session:test', writer: true });
    await writer.append({ kind: 'session.created', payload: { spec: makeSpec() } });
    await writer.close();
  });
});
