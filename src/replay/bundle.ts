import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ensureGoalieDataDir } from '../config.js';
import {
  sha256Hex,
  stableStringify,
  verifyEventChain,
} from '../core/event-store.js';
import { SessionEventSchema } from '../core/schemas.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const base64Schema = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);

export const ReplaySignatureSchema = z
  .object({
    algorithm: z.literal('Ed25519'),
    publicKey: base64Schema,
    keyFingerprint: sha256Schema,
    signature: base64Schema,
  })
  .strict();

const ReplayProvenanceSchema = z
  .object({
    source: z.enum(['recorded_live', 'simulated_fixture']),
    edited: z.boolean(),
    recordedAt: z.iso.datetime({ offset: true }),
    harnessVersion: z.string(),
    backendVersions: z.record(z.string(), z.string()),
    baseSha: z.string(),
    finalSha: z.string(),
    redaction: z.enum(['redacted', 'unredacted']),
    fixture: z.string(),
  })
  .strict();

export const ReplayBundleContentSchema = z
  .object({
    kind: z.literal('goalie.replay.v1'),
    provenance: ReplayProvenanceSchema,
    eventLogHash: sha256Schema,
    artifactHashes: z.record(z.string(), sha256Schema),
    events: z.array(SessionEventSchema).min(1),
  })
  .strict();

export const ReplayBundleSchema = ReplayBundleContentSchema.extend({
  /** SHA-256 over canonical bundle content, excluding this field. */
  bundleHash: sha256Schema,
  /** Optional self-contained signature added by live export. */
  signature: ReplaySignatureSchema.optional(),
}).strict();

export type ReplayBundleContent = z.infer<typeof ReplayBundleContentSchema>;
export type ReplayBundle = z.infer<typeof ReplayBundleSchema>;
type ReplaySignatureDescriptor = Omit<z.infer<typeof ReplaySignatureSchema>, 'signature'>;

export interface LoadedReplayBundle extends ReplayBundle {
  verified: boolean;
  eventChainVerified: boolean;
  eventLogHashVerified: boolean;
  bundleHashVerified: boolean;
  signatureStatus: 'authenticated' | 'unsigned' | 'invalid';
  signatureVerified: boolean | null;
}

export function hashReplayEvents(events: readonly unknown[]): string {
  return sha256Hex(stableStringify(events));
}

function contentWithoutBundleHash(bundle: ReplayBundle): ReplayBundleContent {
  const { bundleHash: _bundleHash, signature: _signature, ...content } = bundle;
  return ReplayBundleContentSchema.parse(content);
}

function publicKeyDer(privateKey: KeyObject): Buffer {
  return createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
}

function signingDescriptor(privateKey: KeyObject): ReplaySignatureDescriptor {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Replay signing requires an Ed25519 private key.');
  }
  const publicKey = publicKeyDer(privateKey);
  return {
    algorithm: 'Ed25519',
    publicKey: publicKey.toString('base64'),
    keyFingerprint: createHash('sha256').update(publicKey).digest('hex'),
  };
}

/**
 * Canonical bytes authenticated by a replay signature. The domain separator,
 * complete unsigned bundle (including bundleHash), and public-key descriptor
 * are signed; only the signature bytes themselves are excluded.
 */
export function canonicalReplaySignaturePayload(
  bundle: ReplayBundle,
  descriptor: ReplaySignatureDescriptor,
): Buffer {
  const parsed = ReplayBundleSchema.parse(bundle);
  const { signature: _signature, ...signedBundle } = parsed;
  return Buffer.from(stableStringify({
    domain: 'goalie.replay.v1.signature.v1',
    bundle: signedBundle,
    signer: descriptor,
  }), 'utf8');
}

/** Add or replace an Ed25519 signature and bind its public descriptor into bundleHash. */
export function signReplayBundle(bundle: ReplayBundle, privateKey: KeyObject): ReplayBundle {
  const parsed = ReplayBundleSchema.parse(bundle);
  const descriptor = signingDescriptor(privateKey);
  const content = contentWithoutBundleHash(parsed);
  const bundleHash = hashReplayBundleWithDescriptor(content, descriptor);
  const signable = ReplayBundleSchema.parse({ ...content, bundleHash });
  const signature = sign(
    null,
    canonicalReplaySignaturePayload(signable, descriptor),
    privateKey,
  ).toString('base64');
  return ReplayBundleSchema.parse({
    ...signable,
    signature: { ...descriptor, signature },
  });
}

/** Authenticate a signed bundle against its embedded key and fingerprint. */
export function verifyReplaySignature(bundle: ReplayBundle): boolean {
  const parsed = ReplayBundleSchema.parse(bundle);
  if (!parsed.signature) return false;
  try {
    const publicKeyDer = Buffer.from(parsed.signature.publicKey, 'base64');
    const fingerprint = createHash('sha256').update(publicKeyDer).digest('hex');
    if (fingerprint !== parsed.signature.keyFingerprint) return false;
    const publicKey = createPublicKey({ key: publicKeyDer, type: 'spki', format: 'der' });
    if (publicKey.asymmetricKeyType !== 'ed25519') return false;
    const { signature, ...descriptor } = parsed.signature;
    return verify(
      null,
      canonicalReplaySignaturePayload(parsed, descriptor),
      publicKey,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

async function readPrivateKey(path: string): Promise<KeyObject> {
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Replay signing key is not a regular file: ${path}`);
    if ((stat.mode & 0o077) !== 0) await handle.chmod(0o600);
    const key = createPrivateKey({
      key: await handle.readFile(),
      type: 'pkcs8',
      format: 'der',
    });
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error(`Replay signing key is not Ed25519: ${path}`);
    }
    return key;
  } finally {
    await handle.close();
  }
}

/**
 * Load the per-install replay key, creating it atomically on first export.
 * The keys directory is mode 0700 and the PKCS#8 private key is mode 0600.
 */
export async function loadOrCreateReplaySigningKey(
  dataDirectory?: string,
): Promise<KeyObject> {
  const root = dataDirectory ?? await ensureGoalieDataDir();
  const keysDirectory = join(root, 'keys');
  const keyPath = join(keysDirectory, 'replay-signing-ed25519.pk8');
  await mkdir(keysDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(keysDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`Replay signing-key path is not a real directory: ${keysDirectory}`);
  }
  await chmod(keysDirectory, 0o700);
  try {
    const key = await readPrivateKey(keyPath);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const generated = generateKeyPairSync('ed25519').privateKey;
  const encoded = generated.export({ type: 'pkcs8', format: 'der' });
  try {
    const handle = await open(keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await handle.writeFile(encoded);
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return readPrivateKey(keyPath);
  }
}

function hashReplayBundleWithDescriptor(
  content: ReplayBundleContent,
  descriptor?: ReplaySignatureDescriptor,
): string {
  return sha256Hex(stableStringify(descriptor ? { ...content, signature: descriptor } : content));
}

/**
 * Hash canonical full-bundle content. `bundleHash` and signature bytes are
 * excluded; a signed bundle's algorithm, public key, and fingerprint are
 * included so its stored hash cannot silently lose or swap that descriptor.
 */
export function hashReplayBundle(
  bundle: ReplayBundleContent | ReplayBundle,
): string {
  if ('bundleHash' in bundle) {
    const parsed = ReplayBundleSchema.parse(bundle);
    const descriptor = parsed.signature
      ? {
          algorithm: parsed.signature.algorithm,
          publicKey: parsed.signature.publicKey,
          keyFingerprint: parsed.signature.keyFingerprint,
        }
      : undefined;
    return hashReplayBundleWithDescriptor(contentWithoutBundleHash(parsed), descriptor);
  }
  return hashReplayBundleWithDescriptor(ReplayBundleContentSchema.parse(bundle));
}

function requireValidEventChain(events: readonly unknown[]): ReplayBundle['events'] {
  const parsed = z.array(SessionEventSchema).min(1).parse(events);
  if (parsed[0]?.kind !== 'session.created') {
    throw new Error('A replay event chain must begin with session.created.');
  }
  verifyEventChain(parsed, parsed[0].sessionId);
  return parsed;
}

function eventChainIsValid(events: ReplayBundle['events']): boolean {
  try {
    requireValidEventChain(events);
    return true;
  } catch {
    return false;
  }
}

export function createReplayBundle(
  provenance: ReplayBundle['provenance'],
  events: readonly unknown[],
  artifactHashes: Record<string, string> = {},
): ReplayBundle {
  const verifiedEvents = requireValidEventChain(events);
  const content = ReplayBundleContentSchema.parse({
    kind: 'goalie.replay.v1',
    provenance,
    eventLogHash: hashReplayEvents(verifiedEvents),
    artifactHashes,
    events: verifiedEvents,
  });
  return ReplayBundleSchema.parse({
    ...content,
    bundleHash: hashReplayBundle(content),
  });
}

export async function writeReplayBundle(path: string, bundle: ReplayBundle): Promise<void> {
  const verified = ReplayBundleSchema.parse(bundle);
  requireValidEventChain(verified.events);
  if (hashReplayEvents(verified.events) !== verified.eventLogHash) {
    throw new Error('Cannot write replay bundle with an invalid event-log hash.');
  }
  if (hashReplayBundle(verified) !== verified.bundleHash) {
    throw new Error('Cannot write replay bundle with an invalid full-bundle hash.');
  }
  if (verified.signature && !verifyReplaySignature(verified)) {
    throw new Error('Cannot write replay bundle with an invalid Ed25519 signature.');
  }
  await writeFile(path, `${JSON.stringify(verified, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function readReplayBundle(path: string): Promise<LoadedReplayBundle> {
  const bundle = ReplayBundleSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
  const eventChainVerified = eventChainIsValid(bundle.events);
  const eventLogHashVerified = hashReplayEvents(bundle.events) === bundle.eventLogHash;
  const bundleHashVerified = hashReplayBundle(bundle) === bundle.bundleHash;
  const signatureVerified = bundle.signature ? verifyReplaySignature(bundle) : null;
  const signatureStatus = signatureVerified === null
    ? 'unsigned' as const
    : signatureVerified
      ? 'authenticated' as const
      : 'invalid' as const;
  return {
    ...bundle,
    verified: eventChainVerified
      && eventLogHashVerified
      && bundleHashVerified
      && signatureStatus !== 'invalid',
    eventChainVerified,
    eventLogHashVerified,
    bundleHashVerified,
    signatureStatus,
    signatureVerified,
  };
}

export function replayBanner(bundle: ReplayBundle | LoadedReplayBundle, verified = true): string {
  if (!verified) return 'UNVERIFIED REPLAY — INTEGRITY OR SIGNATURE FAILURE';
  const signatureStatus: LoadedReplayBundle['signatureStatus'] | 'present' = 'signatureStatus' in bundle
    ? bundle.signatureStatus
    : bundle.signature
      ? 'present'
      : 'unsigned';
  const authentication = signatureStatus === 'authenticated'
    ? ` — AUTHENTICATED KEY ${bundle.signature!.keyFingerprint.slice(0, 12)}`
    : signatureStatus === 'present'
      ? ` — SIGNATURE PRESENT, NOT VERIFIED ${bundle.signature!.keyFingerprint.slice(0, 12)}`
    : ' — LEGACY UNSIGNED';
  if (bundle.provenance.source === 'simulated_fixture') {
    return `SIMULATED FIXTURE — NO ACTIVE AGENTS${authentication}`;
  }
  return `REPLAY — RECORDED LIVE RUN — NO ACTIVE AGENTS${bundle.provenance.edited ? ' — EDITED' : ''}${authentication}`;
}
