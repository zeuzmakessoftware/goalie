import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { GitWorktreeManager } from '../../src/runtime/worktrees.js';

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(candidate => rm(candidate, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).stdout.trim();
}

async function repository(): Promise<{ parent: string; repo: string; head: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), 'goalie-worktree-'));
  cleanup.push(parent);
  const repo = path.join(parent, 'source');
  await execFileAsync('git', ['init', '-q', repo]);
  await writeFile(path.join(repo, 'README.md'), 'base\n');
  await git(repo, 'add', 'README.md');
  await git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-q', '-m', 'base');
  return { parent, repo, head: await git(repo, 'rev-parse', 'HEAD') };
}

describe('GitWorktreeManager', () => {
  test('isolates worker commits and squash-integrates without moving the user branch', async () => {
    const { parent, repo, head } = await repository();
    const manager = new GitWorktreeManager();
    const run = await manager.createRunWorktrees({
      repoRoot: repo,
      stateRoot: path.join(parent, 'state'),
      runId: 'demo-run',
      lanes: [{ id: 'worker-1', writeSet: ['src/**'] }],
    });
    const worker = run.workers[0];
    expect(worker).toBeDefined();
    if (!worker) throw new Error('worker missing');

    await import('node:fs/promises').then(fs => fs.mkdir(path.join(worker.path, 'src'), { recursive: true }));
    await writeFile(path.join(worker.path, 'src', 'feature.ts'), 'export const feature = true;\n');
    const checkpoint = await manager.checkpoint(worker, 'worker checkpoint');
    expect(checkpoint.changedPaths).toEqual(['src/feature.ts']);

    const integrated = await manager.squashIntoIntegration(run.integration, worker, 'integrate worker');
    expect(integrated.changedPaths).toContain('src/feature.ts');
    expect(await readFile(path.join(run.integration.path, 'src', 'feature.ts'), 'utf8')).toContain('true');
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(head);
    await expect(readFile(path.join(repo, 'src', 'feature.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(manager.verify(run.integration)).resolves.toMatchObject({ registered: true });
  });

  test('refuses to start a run from a dirty source worktree', async () => {
    const { parent, repo } = await repository();
    await writeFile(path.join(repo, 'dirty.txt'), 'uncommitted');
    const manager = new GitWorktreeManager();
    await expect(
      manager.createRunWorktrees({
        repoRoot: repo,
        stateRoot: path.join(parent, 'state'),
        runId: 'dirty-run',
        lanes: [],
      }),
    ).rejects.toMatchObject({ code: 'DIRTY_SOURCE' });
  });

  test('rejects ignored artifacts instead of verifying state that cannot be committed or landed', async () => {
    const { parent, repo } = await repository();
    await writeFile(path.join(repo, '.gitignore'), 'dist/\n');
    await git(repo, 'add', '.gitignore');
    await git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-q', '-m', 'ignore dist');
    const manager = new GitWorktreeManager();
    const run = await manager.createRunWorktrees({
      repoRoot: repo,
      stateRoot: path.join(parent, 'state'),
      runId: 'ignored-run',
      lanes: [{ id: 'worker-1', writeSet: ['**'] }],
    });
    const worker = run.workers[0];
    if (!worker) throw new Error('worker missing');

    await import('node:fs/promises').then(fs => fs.mkdir(path.join(worker.path, 'dist'), { recursive: true }));
    await writeFile(path.join(worker.path, 'dist', 'answer.txt'), 'only the ignored artifact passes\n');

    expect(await manager.changedPaths(worker)).toEqual(['dist/answer.txt']);
    await expect(manager.checkpoint(worker, 'must fail closed')).rejects.toMatchObject({
      code: 'IGNORED_PATH_MUTATION',
    });
    expect(await manager.changedPaths(worker)).toEqual(['dist/answer.txt']);
  });

  test('rejects colliding normalized lane ids before creating any worktree', async () => {
    const { parent, repo } = await repository();
    const stateRoot = path.join(parent, 'state');
    const manager = new GitWorktreeManager();
    await expect(
      manager.createRunWorktrees({
        repoRoot: repo,
        stateRoot,
        runId: 'collision-run',
        lanes: [{ id: 'task:a' }, { id: 'task-a' }],
      }),
    ).rejects.toMatchObject({ code: 'LANE_NAME_COLLISION' });

    await expect(access(stateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    const registered = (await git(repo, 'worktree', 'list', '--porcelain'))
      .split('\n')
      .filter(line => line.startsWith('worktree '));
    expect(registered).toHaveLength(1);
  });

  test('restores the verified integration head and clean tree after a squash conflict', async () => {
    const { parent, repo } = await repository();
    const manager = new GitWorktreeManager();
    const run = await manager.createRunWorktrees({
      repoRoot: repo,
      stateRoot: path.join(parent, 'state'),
      runId: 'conflict-run',
      lanes: [
        { id: 'worker-one', writeSet: ['README.md'] },
        { id: 'worker-two', writeSet: ['README.md'] },
      ],
    });
    const [first, second] = run.workers;
    if (!first || !second) throw new Error('workers missing');

    await writeFile(path.join(first.path, 'README.md'), 'first lane\n');
    await manager.checkpoint(first, 'first lane');
    await manager.squashIntoIntegration(run.integration, first, 'integrate first lane');
    const verifiedHead = await manager.head(run.integration);

    await writeFile(path.join(second.path, 'README.md'), 'second lane\n');
    await manager.checkpoint(second, 'second lane');
    await expect(
      manager.squashIntoIntegration(run.integration, second, 'integrate second lane'),
    ).rejects.toMatchObject({ code: 'INTEGRATION_CONFLICT', files: ['README.md'] });

    expect(await manager.head(run.integration)).toBe(verifiedHead);
    expect(await manager.changedPaths(run.integration)).toEqual([]);
    expect(await readFile(path.join(run.integration.path, 'README.md'), 'utf8')).toBe('first lane\n');
  });

  test('rejects repository-configured executable filters before checkout', async () => {
    const { parent, repo } = await repository();
    await git(repo, 'config', 'filter.evil.clean', 'sh -c "exit 0"');
    const manager = new GitWorktreeManager();
    await expect(
      manager.createRunWorktrees({
        repoRoot: repo,
        stateRoot: path.join(parent, 'state'),
        runId: 'unsafe-filter-run',
        lanes: [],
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_GIT_CONFIG' });
  });
});
