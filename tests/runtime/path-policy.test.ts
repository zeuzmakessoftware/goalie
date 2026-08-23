import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { PathPolicy, PathPolicyError, globMatches } from '../../src/runtime/path-policy.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(candidate => rm(candidate, { recursive: true, force: true })));
});

describe('PathPolicy', () => {
  test('enforces containment, write sets, and hidden verifier reads', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'goalie-path-'));
    cleanup.push(parent);
    const root = path.join(parent, 'workspace');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'verifiers'), { recursive: true });
    await writeFile(path.join(root, 'src', 'safe.ts'), 'safe');
    await writeFile(path.join(root, 'verifiers', 'secret.ts'), 'do not leak');
    await writeFile(path.join(parent, 'outside.txt'), 'outside');
    await symlink(path.join(parent, 'outside.txt'), path.join(root, 'escape'));
    await symlink(path.join(root, 'verifiers', 'secret.ts'), path.join(root, 'internal-alias'));

    const policy = new PathPolicy({
      root,
      writeSet: ['src/**'],
      protectedPaths: ['verifiers/**'],
    });

    await expect(policy.resolveForRead('src/safe.ts')).resolves.toMatchObject({ relative: 'src/safe.ts' });
    await expect(policy.resolveForRead('../outside.txt')).rejects.toBeInstanceOf(PathPolicyError);
    await expect(policy.resolveForRead('escape')).rejects.toBeInstanceOf(PathPolicyError);
    await expect(policy.resolveForRead('internal-alias')).rejects.toThrow('symlink');
    await expect(policy.resolveForRead('verifiers/secret.ts')).rejects.toThrow('cannot be read');
    await expect(policy.resolveForWrite('README.md')).rejects.toThrow('write set');
    await expect(policy.resolveForWrite('verifiers/new.ts')).rejects.toThrow('Protected path');
    await expect(policy.resolveForWrite('.env')).rejects.toThrow('Protected path');
    await expect(policy.resolveForWrite('src/.npmrc')).rejects.toThrow('Protected path');
    await expect(policy.resolveForWrite('src/new.ts')).resolves.toMatchObject({ relative: 'src/new.ts' });
    expect(policy.isReadableRelative('verifiers')).toBe(false);
  });

  test('hides arbitrary dotenv variants from providers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'goalie-path-secrets-'));
    cleanup.push(root);
    await writeFile(path.join(root, '.env.staging'), 'TOKEN=secret\n');
    await mkdir(path.join(root, 'service'));
    await writeFile(path.join(root, 'service', '.env.preview'), 'TOKEN=nested\n');
    const policy = new PathPolicy({ root });

    await expect(policy.resolveForRead('.env.staging')).rejects.toThrow('Protected path');
    await expect(policy.resolveForRead('service/.env.preview')).rejects.toThrow('Protected path');
  });

  test('matches the root of a recursive glob as well as descendants', () => {
    expect(globMatches('src/**', 'src')).toBe(true);
    expect(globMatches('src/**', 'src/deep/file.ts')).toBe(true);
    expect(globMatches('src/*', 'src/deep/file.ts')).toBe(false);
  });
});
