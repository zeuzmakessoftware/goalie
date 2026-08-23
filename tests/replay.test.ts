import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { calculateEventHash } from '../src/core/event-store.js';
import {
  GENESIS_HASH,
  SessionEventSchema,
  type SessionEvent,
} from '../src/core/schemas.js';
import {
  ReplayBundleSchema,
  createReplayBundle,
  hashReplayBundle,
  hashReplayEvents,
  loadOrCreateReplaySigningKey,
  readReplayBundle,
  replayBanner,
  signReplayBundle,
  verifyReplaySignature,
  writeReplayBundle,
  type ReplayBundle,
} from '../src/replay/bundle.js';
import { NOW, makeSpec } from './core/fixtures.js';

const provenance = {
  source: 'recorded_live' as const,
  edited: false,
  recordedAt: NOW,
  harnessVersion: '1.0.0',
  backendVersions: { scripted: '1' },
  baseSha: 'base',
  finalSha: 'final',
  redaction: 'redacted' as const,
  fixture: 'penalty-ledger',
};

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  );
});

async function bundlePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'goalie-replay-'));
  temporaryRoots.push(root);
  return join(root, 'run.json');
}

function validEvents(): SessionEvent[] {
  let sequence = 0;
  let previousHash = GENESIS_HASH;
  const makeEvent = (kind: string, payload: unknown): SessionEvent => {
    sequence += 1;
    const unsigned = {
      schemaVersion: 1 as const,
      id: `event:${sequence}`,
      sessionId: 'session:replay',
      sequence,
      timestamp: new Date(Date.parse(NOW) + sequence * 1_000).toISOString(),
      causationId: `event:${sequence}`,
      kind,
      payload,
      artifactHashes: {},
      previousHash,
    };
    const event = SessionEventSchema.parse({
      ...unsigned,
      hash: calculateEventHash(unsigned),
    });
    previousHash = event.hash;
    return event;
  };
  return [
    makeEvent('session.created', { spec: makeSpec() }),
    makeEvent('session.status_changed', { status: 'running' }),
  ];
}

async function writeRaw(path: string, bundle: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
}

async function persistedBundle(
  artifactHashes: Record<string, string> = { 'git-tree': '1'.repeat(64) },
): Promise<{ path: string; bundle: ReplayBundle }> {
  const path = await bundlePath();
  const bundle = createReplayBundle(provenance, validEvents(), artifactHashes);
  await writeReplayBundle(path, bundle);
  return { path, bundle };
}

describe('replay bundle', () => {
  it('round-trips a nonempty verified event chain and full-bundle digest', async () => {
    const { path, bundle } = await persistedBundle();
    const loaded = await readReplayBundle(path);

    expect(bundle.bundleHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(loaded).toMatchObject({
      verified: true,
      eventChainVerified: true,
      eventLogHashVerified: true,
      bundleHashVerified: true,
      signatureStatus: 'unsigned',
      signatureVerified: null,
    });
    expect(replayBanner(loaded, loaded.verified)).toContain('RECORDED LIVE');
    expect(replayBanner(loaded, loaded.verified)).toContain('LEGACY UNSIGNED');
  });

  it('authenticates all replay fields with an Ed25519 install key', async () => {
    const path = await bundlePath();
    const privateKey = generateKeyPairSync('ed25519').privateKey;
    const bundle = signReplayBundle(
      createReplayBundle(provenance, validEvents(), { 'git-tree': '1'.repeat(64) }),
      privateKey,
    );
    await writeReplayBundle(path, bundle);

    const loaded = await readReplayBundle(path);
    expect(verifyReplaySignature(bundle)).toBe(true);
    expect(loaded).toMatchObject({
      verified: true,
      eventChainVerified: true,
      eventLogHashVerified: true,
      bundleHashVerified: true,
      signatureStatus: 'authenticated',
      signatureVerified: true,
    });
    expect(loaded.signature?.keyFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(replayBanner(loaded, loaded.verified)).toContain('AUTHENTICATED KEY');
  });

  it('rejects a stale signature even when tampered content has a repaired bundle hash', async () => {
    const path = await bundlePath();
    const signed = signReplayBundle(
      createReplayBundle(provenance, validEvents()),
      generateKeyPairSync('ed25519').privateKey,
    );
    signed.provenance.fixture = 'forged-after-signing';
    signed.bundleHash = hashReplayBundle(signed);
    await writeRaw(path, signed);

    const loaded = await readReplayBundle(path);
    expect(loaded.eventChainVerified).toBe(true);
    expect(loaded.bundleHashVerified).toBe(true);
    expect(loaded.signatureStatus).toBe('invalid');
    expect(loaded.signatureVerified).toBe(false);
    expect(loaded.verified).toBe(false);
  });

  it('detects signature stripping unless the result is explicitly reissued as unsigned', async () => {
    const path = await bundlePath();
    const signed = signReplayBundle(
      createReplayBundle(provenance, validEvents()),
      generateKeyPairSync('ed25519').privateKey,
    );
    const stripped = structuredClone(signed);
    delete stripped.signature;
    await writeRaw(path, stripped);

    const loaded = await readReplayBundle(path);
    expect(loaded.signatureStatus).toBe('unsigned');
    expect(loaded.bundleHashVerified).toBe(false);
    expect(loaded.verified).toBe(false);
  });

  it('persists and reuses a mode-0600 per-install signing key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goalie-signing-key-'));
    temporaryRoots.push(root);
    const first = await loadOrCreateReplaySigningKey(root);
    const second = await loadOrCreateReplaySigningKey(root);
    const firstSigned = signReplayBundle(createReplayBundle(provenance, validEvents()), first);
    const secondSigned = signReplayBundle(createReplayBundle(provenance, validEvents()), second);
    const keyStat = await stat(join(root, 'keys', 'replay-signing-ed25519.pk8'));
    const directoryStat = await stat(join(root, 'keys'));

    expect(firstSigned.signature?.keyFingerprint).toBe(secondSigned.signature?.keyFingerprint);
    expect(keyStat.mode & 0o777).toBe(0o600);
    expect(directoryStat.mode & 0o777).toBe(0o700);
  });

  it('detects event tampering even when the attacker repairs the event chain and event hash', async () => {
    const { path } = await persistedBundle();
    const parsed = ReplayBundleSchema.parse(
      JSON.parse(await readFile(path, 'utf8')) as unknown,
    );
    const event = parsed.events[1]!;
    event.payload = { status: 'achieved', forged: true };
    const { hash: _oldHash, ...unsigned } = event;
    event.hash = calculateEventHash(unsigned);
    parsed.eventLogHash = hashReplayEvents(parsed.events);
    await writeRaw(path, parsed);

    const loaded = await readReplayBundle(path);
    expect(loaded.eventChainVerified).toBe(true);
    expect(loaded.eventLogHashVerified).toBe(true);
    expect(loaded.bundleHashVerified).toBe(false);
    expect(loaded.verified).toBe(false);
    expect(replayBanner(loaded, loaded.verified)).toContain('UNVERIFIED');
  });

  it('detects provenance tampering while the event evidence remains intact', async () => {
    const { path } = await persistedBundle();
    const parsed = ReplayBundleSchema.parse(
      JSON.parse(await readFile(path, 'utf8')) as unknown,
    );
    parsed.provenance.fixture = 'forged-fixture';
    await writeRaw(path, parsed);

    const loaded = await readReplayBundle(path);
    expect(loaded.eventChainVerified).toBe(true);
    expect(loaded.eventLogHashVerified).toBe(true);
    expect(loaded.bundleHashVerified).toBe(false);
    expect(loaded.verified).toBe(false);
  });

  it('detects artifact-hash tampering while the event evidence remains intact', async () => {
    const { path } = await persistedBundle();
    const parsed = ReplayBundleSchema.parse(
      JSON.parse(await readFile(path, 'utf8')) as unknown,
    );
    parsed.artifactHashes['git-tree'] = '2'.repeat(64);
    await writeRaw(path, parsed);

    const loaded = await readReplayBundle(path);
    expect(loaded.eventChainVerified).toBe(true);
    expect(loaded.eventLogHashVerified).toBe(true);
    expect(loaded.bundleHashVerified).toBe(false);
    expect(loaded.verified).toBe(false);
  });

  it('refuses to create or write empty, corrupt, or outer-hash-invalid bundles', async () => {
    expect(() => createReplayBundle(provenance, [])).toThrow();

    const corrupt = validEvents();
    corrupt[0]!.hash = '0'.repeat(64);
    expect(() => createReplayBundle(provenance, corrupt)).toThrow(/hash mismatch/u);

    const { path, bundle } = await persistedBundle();
    const altered = structuredClone(bundle);
    altered.provenance.fixture = 'changed-before-write';
    await expect(writeReplayBundle(path, altered)).rejects.toThrow(
      /invalid full-bundle hash/u,
    );

    const signed = signReplayBundle(bundle, generateKeyPairSync('ed25519').privateKey);
    signed.signature!.signature = Buffer.alloc(64).toString('base64');
    await expect(writeReplayBundle(path, signed)).rejects.toThrow(
      /invalid Ed25519 signature/u,
    );
  });

  it('fails closed on legacy bundles that do not cover provenance and artifacts', async () => {
    const { path, bundle } = await persistedBundle();
    const legacy = { ...bundle } as Partial<ReplayBundle>;
    delete legacy.bundleHash;
    await writeRaw(path, legacy);

    await expect(readReplayBundle(path)).rejects.toThrow();
  });
});
