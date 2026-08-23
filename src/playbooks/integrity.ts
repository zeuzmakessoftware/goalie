import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export class PlaybookIntegrityError extends Error {
  override readonly name = 'PlaybookIntegrityError';
}

export class PlaybookEligibilityError extends Error {
  override readonly name = 'PlaybookEligibilityError';
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Cannot hash a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== undefined) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`Cannot hash ${typeof value}`);
}

export function digestCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureContainedDirectory(
  root: string,
  segments: readonly string[],
): Promise<string> {
  const absoluteRoot = resolve(root);
  const createdRoot = await mkdir(absoluteRoot, {
    recursive: true,
    mode: 0o700,
  });
  if (createdRoot !== undefined) {
    await syncDirectory(dirname(createdRoot));
  }
  const canonicalRoot = await realpath(absoluteRoot);
  let current = canonicalRoot;

  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.includes(sep)) {
      throw new PlaybookIntegrityError(`Unsafe playbook path segment: ${segment}`);
    }
    const next = join(current, segment);
    try {
      const status = await lstat(next);
      if (status.isSymbolicLink()) {
        throw new PlaybookIntegrityError(
          `Refusing symbolic link in playbook storage path: ${next}`,
        );
      }
      if (!status.isDirectory()) {
        throw new PlaybookIntegrityError(
          `Expected playbook storage directory at ${next}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(next, { mode: 0o700 });
      await syncDirectory(current);
    }
    current = await realpath(next);
    const fromRoot = relative(canonicalRoot, current);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
      throw new PlaybookIntegrityError('Playbook storage path escaped its root');
    }
  }
  return current;
}

export async function resolveContainedDirectory(
  root: string,
  segments: readonly string[],
): Promise<string> {
  return ensureContainedDirectory(root, segments);
}

export async function resolveExistingContainedDirectory(
  root: string,
  segments: readonly string[],
): Promise<string> {
  const canonicalRoot = await realpath(resolve(root));
  let current = canonicalRoot;
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.includes(sep)) {
      throw new PlaybookIntegrityError(`Unsafe playbook path segment: ${segment}`);
    }
    const next = join(current, segment);
    const status = await lstat(next);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new PlaybookIntegrityError(
        `Invalid playbook storage directory at ${next}`,
      );
    }
    current = await realpath(next);
    const fromRoot = relative(canonicalRoot, current);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
      throw new PlaybookIntegrityError('Playbook storage path escaped its root');
    }
  }
  return current;
}

/**
 * Publishes a fully fsynced file with link(2), so an immutable record is never
 * visible partially and an existing record is never overwritten.
 */
export async function writeImmutableJson(
  directory: string,
  filename: string,
  value: unknown,
): Promise<string> {
  if (!filename || filename.includes(sep) || filename === '.' || filename === '..') {
    throw new PlaybookIntegrityError(`Unsafe playbook filename: ${filename}`);
  }
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const target = join(directory, filename);
  const temporary = join(
    directory,
    `.${basename(filename)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await link(temporary, target);
    await unlink(temporary);
    await syncDirectory(directory);
    return target;
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const status = await lstat(target);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new PlaybookIntegrityError(
        `Invalid immutable playbook record at ${target}`,
      );
    }
    const existing = await readFile(target, 'utf8');
    if (existing !== serialized) {
      throw new PlaybookIntegrityError(
        `Immutable playbook record already exists with different content: ${target}`,
      );
    }
    return target;
  }
}

export async function readJsonFile(path: string): Promise<unknown> {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new PlaybookIntegrityError(`Invalid playbook record at ${path}`);
    }
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new PlaybookIntegrityError(`Malformed playbook JSON at ${path}`);
    }
    throw error;
  }
}
