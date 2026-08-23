import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export class PathPolicyError extends Error {
  readonly code = 'PATH_POLICY_VIOLATION';

  constructor(message: string) {
    super(message);
    this.name = 'PathPolicyError';
  }
}

export interface PathPolicyOptions {
  root: string;
  writeSet?: readonly string[];
  protectedPaths?: readonly string[];
  /** Paths hidden from agent reads/listing/search (checks still run out-of-band). */
  readProtectedPaths?: readonly string[];
}

function normalizePattern(pattern: string): string {
  return pattern.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export const SECRET_PATH_PATTERNS = [
  '.env',
  '.env.*',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '**/.env',
  '**/.env.*',
  '**/.env.local',
  '**/.env.development',
  '**/.env.production',
  '**/.env.test',
  '.npmrc',
  '**/.npmrc',
  '.pypirc',
  '**/.pypirc',
  '.netrc',
  '**/.netrc',
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

/** A deliberately small gitignore-like matcher: `*`, `?`, and `**` only. */
export function globMatches(pattern: string, relativePath: string): boolean {
  const normalized = normalizePattern(pattern);
  const candidate = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.endsWith('/**') && candidate === normalized.slice(0, -3)) return true;
  let expression = '';

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*') {
      if (normalized[index + 1] === '*') {
        expression += '.*';
        index += 1;
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += escapeRegExp(character ?? '');
    }
  }

  return new RegExp(`^${expression}$`, 'u').test(candidate);
}

async function existingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export class PathPolicy {
  readonly root: string;
  readonly writeSet: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly readProtectedPaths: readonly string[];

  private canonicalRoot: string | undefined;

  constructor(options: PathPolicyOptions) {
    if (!path.isAbsolute(options.root)) {
      throw new PathPolicyError('Workspace root must be absolute.');
    }
    this.root = path.resolve(options.root);
    this.writeSet = (options.writeSet ?? ['**']).map(normalizePattern);
    const configuredProtected = options.protectedPaths ?? [];
    this.protectedPaths = [
      '.git',
      '.git/**',
      '.goalie/playbooks/**',
      '.goalie/verifiers/**',
      ...configuredProtected,
    ].map(normalizePattern);
    this.readProtectedPaths = [
      '.git',
      '.git/**',
      '.goalie/verifiers/**',
      ...SECRET_PATH_PATTERNS,
      ...configuredProtected,
      ...(options.readProtectedPaths ?? []),
    ].map(normalizePattern);
  }

  async resolveForRead(input: string): Promise<{ absolute: string; relative: string }> {
    const resolved = await this.resolveContained(input, false);
    if (!this.isReadableRelative(resolved.relative)) {
      throw new PathPolicyError(`Protected path cannot be read: ${resolved.relative}`);
    }
    return resolved;
  }

  async resolveForWrite(input: string): Promise<{ absolute: string; relative: string }> {
    const resolved = await this.resolveContained(input, true);
    if ([...this.protectedPaths, ...SECRET_PATH_PATTERNS].some(pattern => globMatches(pattern, resolved.relative))) {
      throw new PathPolicyError(`Protected path cannot be modified: ${resolved.relative}`);
    }
    if (!this.writeSet.some(pattern => globMatches(pattern, resolved.relative))) {
      throw new PathPolicyError(`Path is outside this actor's write set: ${resolved.relative}`);
    }
    return resolved;
  }

  isWritableRelative(relativePath: string): boolean {
    const normalized = normalizePattern(relativePath);
    return (
      ![...this.protectedPaths, ...SECRET_PATH_PATTERNS].some(pattern => globMatches(pattern, normalized)) &&
      this.writeSet.some(pattern => globMatches(pattern, normalized))
    );
  }

  isReadableRelative(relativePath: string): boolean {
    const normalized = normalizePattern(relativePath);
    return !this.readProtectedPaths.some(pattern => globMatches(pattern, normalized));
  }

  private async resolveContained(
    input: string,
    allowMissing: boolean,
  ): Promise<{ absolute: string; relative: string }> {
    if (!input || input.includes('\0') || path.isAbsolute(input)) {
      throw new PathPolicyError('Paths must be non-empty, relative workspace paths.');
    }

    const normalizedInput = input.replaceAll('\\', '/');
    const lexical = path.resolve(this.root, normalizedInput);
    const lexicalRelative = path.relative(this.root, lexical);
    if (
      lexicalRelative === '..' ||
      lexicalRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(lexicalRelative)
    ) {
      throw new PathPolicyError(`Path escapes workspace: ${input}`);
    }

    const root = await this.getCanonicalRoot();
    let canonical: string;
    try {
      canonical = await realpath(lexical);
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const ancestor = await existingAncestor(lexical);
      const canonicalAncestor = await realpath(ancestor);
      const tail = path.relative(ancestor, lexical);
      canonical = path.resolve(canonicalAncestor, tail);
    }

    const canonicalRelative = path.relative(root, canonical);
    if (
      canonicalRelative === '..' ||
      canonicalRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(canonicalRelative)
    ) {
      throw new PathPolicyError(`Path resolves outside workspace through a symlink: ${input}`);
    }

    // Reject internal symlink aliases and non-canonical casing as well. Without
    // this, `safe-link -> verifiers/secret` or `.Git/config` on a
    // case-insensitive filesystem could bypass relative-path protection.
    const expectedCanonical = path.resolve(root, lexicalRelative);
    if (canonical !== expectedCanonical) {
      throw new PathPolicyError(`Path uses a symlink or non-canonical casing: ${input}`);
    }

    return {
      absolute: lexical,
      relative: lexicalRelative.replaceAll(path.sep, '/'),
    };
  }

  private async getCanonicalRoot(): Promise<string> {
    this.canonicalRoot ??= await realpath(this.root);
    return this.canonicalRoot;
  }
}
