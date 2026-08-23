import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ensureGoalieDataDir } from '../config.js';

export const SessionMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  goal: z.string(),
  workspace: z.string(),
  status: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  baseSha: z.string().optional(),
  integrationBranch: z.string().optional(),
  finalSha: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  replayBundle: z.string().optional(),
});

export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;

export function createSessionId(now = new Date()): string {
  const stamp = now.toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14);
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

export async function sessionsRoot(): Promise<string> {
  const data = await ensureGoalieDataDir();
  const path = join(data, 'sessions');
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

export async function sessionDir(id: string): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Invalid session ID: ${id}`);
  return join(await sessionsRoot(), id);
}

export async function createSession(metadata: SessionMetadata): Promise<string> {
  const path = await sessionDir(metadata.id);
  await mkdir(join(path, 'artifacts'), { recursive: true, mode: 0o700 });
  await mkdir(join(path, 'worktrees'), { recursive: true, mode: 0o700 });
  await writeSessionMetadata(metadata);
  return path;
}

export async function writeSessionMetadata(metadata: SessionMetadata): Promise<void> {
  const verified = SessionMetadataSchema.parse(metadata);
  const directory = await sessionDir(verified.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, 'metadata.json');
  const temporary = join(directory, `.metadata-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(verified, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  const handle = await open(temporary, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

export async function readSessionMetadata(id: string): Promise<SessionMetadata> {
  const path = join(await sessionDir(id), 'metadata.json');
  return SessionMetadataSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

export async function listSessions(): Promise<SessionMetadata[]> {
  const root = await sessionsRoot();
  const entries = await readdir(root, { withFileTypes: true });
  const result: SessionMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      result.push(await readSessionMetadata(entry.name));
    } catch {
      // A partially-created or future-version session is intentionally skipped.
    }
  }
  return result.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function resolveSessionId(prefix: string): Promise<string> {
  const sessions = await listSessions();
  const matches = sessions.filter(session => session.id === prefix || session.id.startsWith(prefix));
  if (matches.length === 0) throw new Error(`No Goalie session matches ${prefix}.`);
  if (matches.length > 1) throw new Error(`Session prefix ${prefix} is ambiguous.`);
  return matches[0]!.id;
}

export async function removeSession(id: string): Promise<void> {
  const metadata = await readSessionMetadata(id);
  const terminal = new Set(['achieved', 'failed', 'safety_halt', 'user_stopped']);
  if (!terminal.has(metadata.status)) {
    throw new Error(`Session ${id} is ${metadata.status}; only terminal sessions can be cleaned.`);
  }
  await rm(await sessionDir(id), { recursive: true, force: false });
}
