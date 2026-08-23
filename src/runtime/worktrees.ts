import { spawn } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { PathPolicy } from './path-policy.js';

export class WorktreeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

export class WorktreeConflictError extends WorktreeError {
  constructor(readonly files: readonly string[]) {
    super(`Integration conflict in: ${files.join(', ') || 'unknown files'}`, 'INTEGRATION_CONFLICT');
    this.name = 'WorktreeConflictError';
  }
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function execArgv(
  argv: readonly [string, ...string[]],
  cwd: string,
  allowedExitCodes: readonly number[] = [0],
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const [binary, ...args] = argv;
    const environment: NodeJS.ProcessEnv = {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    };
    for (const key of ['PATH', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL'] as const) {
      const value = process.env[key];
      if (value !== undefined) environment[key] = value;
    }
    const child = spawn(binary, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', exitCode => {
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
      };
      if (exitCode === null || !allowedExitCodes.includes(exitCode)) {
        reject(
          new WorktreeError(
            `${argv.join(' ')} failed (${exitCode ?? 'signal'}): ${result.stderr.trim()}`,
            'GIT_COMMAND_FAILED',
          ),
        );
      } else {
        resolve(result);
      }
    });
  });
}

async function git(cwd: string, args: readonly string[], allowed: readonly number[] = [0]): Promise<ProcessResult> {
  return await execArgv(
    [
      'git',
      '--no-pager',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'protocol.file.allow=never',
      ...args,
    ],
    cwd,
    allowed,
  );
}

async function assertSafeGitConfig(cwd: string): Promise<void> {
  const result = await execArgv(
    [
      'git',
      'config',
      '--local',
      '--includes',
      '--name-only',
      '--get-regexp',
      '^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver|include(if)?\\..*)$',
    ],
    cwd,
    [0, 1],
  );
  const unsafeKeys = result.stdout.split('\n').filter(Boolean);
  if (unsafeKeys.length > 0) {
    throw new WorktreeError(
      `Repository defines executable Git filters, merge drivers, or local includes: ${unsafeKeys.join(', ')}`,
      'UNSAFE_GIT_CONFIG',
    );
  }
}

function safeSegment(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) throw new WorktreeError('Run and lane names must contain safe characters.', 'INVALID_NAME');
  return normalized.slice(0, 80);
}

function assertDistinctLaneSegments(laneIds: readonly string[]): void {
  const owners = new Map<string, string>();
  for (const laneId of ['integration', ...laneIds]) {
    const segment = safeSegment(laneId);
    const existing = owners.get(segment);
    if (existing !== undefined) {
      throw new WorktreeError(
        `Lane ids ${JSON.stringify(existing)} and ${JSON.stringify(laneId)} map to the same durable name ${JSON.stringify(segment)}.`,
        'LANE_NAME_COLLISION',
      );
    }
    owners.set(segment, laneId);
  }
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function canonicalProspectivePath(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  let ancestor = absolute;
  while (true) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      return path.resolve(canonicalAncestor, path.relative(ancestor, absolute));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

export interface RepositorySnapshot {
  root: string;
  commonGitDir: string;
  headSha: string;
  branch: string | null;
  clean: boolean;
  dirtyEntries: string[];
}

export interface WorktreeHandle {
  runId: string;
  laneId: string;
  path: string;
  branch: string;
  baseSha: string;
  repoRoot: string;
  writeSet: readonly string[];
}

export interface CreateWorktreeOptions {
  repoRoot: string;
  stateRoot: string;
  runId: string;
  laneId: string;
  baseSha: string;
  writeSet?: readonly string[];
}

export class GitWorktreeManager {
  async inspectRepository(input: string): Promise<RepositorySnapshot> {
    const root = await realpath((await git(input, ['rev-parse', '--show-toplevel'])).stdout.trim());
    await assertSafeGitConfig(root);
    const commonRaw = (await git(root, ['rev-parse', '--git-common-dir'])).stdout.trim();
    const commonGitDir = await realpath(path.resolve(root, commonRaw));
    const headSha = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    const branchResult = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1]);
    const statusOutput = (await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
    const dirtyEntries = statusOutput
      .split('\n')
      .map(line => line.trimEnd())
      .filter(Boolean);
    return {
      root,
      commonGitDir,
      headSha,
      branch: branchResult.exitCode === 0 ? branchResult.stdout.trim() : null,
      clean: dirtyEntries.length === 0,
      dirtyEntries,
    };
  }

  async requireClean(input: string): Promise<RepositorySnapshot> {
    const snapshot = await this.inspectRepository(input);
    if (!snapshot.clean) {
      throw new WorktreeError(
        `Source worktree is dirty; commit or stash first:\n${snapshot.dirtyEntries.join('\n')}`,
        'DIRTY_SOURCE',
      );
    }
    return snapshot;
  }

  async createWorktree(options: CreateWorktreeOptions): Promise<WorktreeHandle> {
    const repository = await this.inspectRepository(options.repoRoot);
    const stateRoot = await canonicalProspectivePath(options.stateRoot);
    const relativeState = path.relative(repository.root, stateRoot);
    if (relativeState === '' || (!relativeState.startsWith(`..${path.sep}`) && relativeState !== '..')) {
      throw new WorktreeError('Durable worktrees must live outside the source repository.', 'INVALID_STATE_ROOT');
    }

    const runId = safeSegment(options.runId);
    const laneId = safeSegment(options.laneId);
    const worktreePath = path.join(stateRoot, runId, laneId);
    const branch = `goalie/${runId}/${laneId}`;
    const handle: WorktreeHandle = {
      runId,
      laneId,
      path: worktreePath,
      branch,
      baseSha: options.baseSha,
      repoRoot: repository.root,
      writeSet: options.writeSet ?? ['**'],
    };

    if (await exists(worktreePath)) {
      const actualRoot = await realpath((await git(worktreePath, ['rev-parse', '--show-toplevel'])).stdout.trim());
      const actualCommonRaw = (await git(worktreePath, ['rev-parse', '--git-common-dir'])).stdout.trim();
      const actualCommon = await realpath(path.resolve(worktreePath, actualCommonRaw));
      const actualBranch = (await git(worktreePath, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
      if (
        actualRoot !== (await realpath(worktreePath)) ||
        actualCommon !== repository.commonGitDir ||
        actualBranch !== branch
      ) {
        throw new WorktreeError(`Existing path is not the expected Goalie worktree: ${worktreePath}`, 'WORKTREE_MISMATCH');
      }
      return handle;
    }

    await mkdir(path.dirname(worktreePath), { recursive: true });
    const branchExists = (await git(repository.root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], [0, 1])).exitCode === 0;
    if (branchExists) {
      throw new WorktreeError(`Branch already exists without its expected worktree: ${branch}`, 'ORPHAN_BRANCH');
    }
    await git(repository.root, ['worktree', 'add', '-b', branch, worktreePath, options.baseSha]);
    return handle;
  }

  async createRunWorktrees(options: {
    repoRoot: string;
    stateRoot: string;
    runId: string;
    baseSha?: string;
    lanes: ReadonlyArray<{ id: string; writeSet?: readonly string[] }>;
  }): Promise<{ integration: WorktreeHandle; workers: WorktreeHandle[] }> {
    // Reject lossy normalization before creating the integration worktree so a
    // failed kickoff cannot leave a partial durable run behind.
    assertDistinctLaneSegments(options.lanes.map(lane => lane.id));
    const snapshot = await this.requireClean(options.repoRoot);
    const baseSha = options.baseSha ?? snapshot.headSha;
    const integration = await this.createWorktree({
      repoRoot: snapshot.root,
      stateRoot: options.stateRoot,
      runId: options.runId,
      laneId: 'integration',
      baseSha,
      writeSet: ['**'],
    });
    const workers: WorktreeHandle[] = [];
    for (const lane of options.lanes) {
      workers.push(
        await this.createWorktree({
          repoRoot: snapshot.root,
          stateRoot: options.stateRoot,
          runId: options.runId,
          laneId: lane.id,
          baseSha,
          ...(lane.writeSet ? { writeSet: lane.writeSet } : {}),
        }),
      );
    }
    return { integration, workers };
  }

  async head(handle: WorktreeHandle): Promise<string> {
    return (await git(handle.path, ['rev-parse', 'HEAD'])).stdout.trim();
  }

  async changedPaths(handle: WorktreeHandle, base = 'HEAD'): Promise<string[]> {
    const outputs = await Promise.all([
      git(handle.path, ['diff', '--name-only', '-z', base, '--']),
      git(handle.path, ['diff', '--cached', '--name-only', '-z', '--']),
      git(handle.path, ['ls-files', '--others', '--exclude-standard', '-z']),
      // Ignored files are deliberately included in the dirty-state inventory.
      // They cannot be committed by the normal `git add --all` checkpoint and
      // therefore must never be allowed to influence verification invisibly.
      git(handle.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']),
    ]);
    return [...new Set(outputs.flatMap(output => output.stdout.split('\0').filter(Boolean)))].sort();
  }

  private async ignoredPaths(handle: WorktreeHandle): Promise<string[]> {
    const result = await git(handle.path, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '-z',
    ]);
    return [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
  }

  async diffBetween(handle: WorktreeHandle, fromSha: string, toSha = 'HEAD'): Promise<string> {
    return (await git(handle.path, ['diff', '--no-ext-diff', '--binary', fromSha, toSha, '--'])).stdout;
  }

  async checkpoint(handle: WorktreeHandle, message: string): Promise<{ commitSha: string; changedPaths: string[] }> {
    const changedPaths = await this.changedPaths(handle);
    if (changedPaths.length === 0) return { commitSha: await this.head(handle), changedPaths };

    const ignoredPaths = await this.ignoredPaths(handle);
    if (ignoredPaths.length > 0) {
      throw new WorktreeError(
        `Worker created or modified ignored paths that cannot enter the durable checkpoint: ${ignoredPaths.join(', ')}`,
        'IGNORED_PATH_MUTATION',
      );
    }

    const policy = new PathPolicy({ root: handle.path, writeSet: handle.writeSet });
    const violations = changedPaths.filter(candidate => !policy.isWritableRelative(candidate));
    if (violations.length > 0) {
      throw new WorktreeError(`Worker modified paths outside its write set: ${violations.join(', ')}`, 'WRITE_SET_VIOLATION');
    }

    await git(handle.path, ['add', '--all', '--', '.']);
    await git(handle.path, [
      '-c',
      'user.name=Goalie Harness',
      '-c',
      'user.email=goalie@localhost',
      'commit',
      '--no-gpg-sign',
      '-m',
      message.slice(0, 240),
    ]);
    return { commitSha: await this.head(handle), changedPaths };
  }

  /**
   * Bring an untouched/clean lane up to the durable integration head before it
   * begins dependent or overlapping work. `--ff-only` makes this a monotonic
   * operation: a lane with its own divergent attempt history is never silently
   * rewritten.
   */
  async fastForwardFrom(
    worker: WorktreeHandle,
    integration: WorktreeHandle,
  ): Promise<{ fromSha: string; toSha: string; advanced: boolean }> {
    const dirty = await this.changedPaths(worker);
    if (dirty.length > 0) {
      throw new WorktreeError(
        `Worker must be clean before synchronization: ${dirty.join(', ')}`,
        'DIRTY_WORKER',
      );
    }
    const fromSha = await this.head(worker);
    const toSha = await this.head(integration);
    if (fromSha === toSha) return { fromSha, toSha, advanced: false };
    await git(worker.path, ['merge', '--ff-only', integration.branch]);
    return { fromSha, toSha: await this.head(worker), advanced: true };
  }

  async squashIntoIntegration(
    integration: WorktreeHandle,
    worker: WorktreeHandle,
    message: string,
  ): Promise<{ commitSha: string; changedPaths: string[] }> {
    const verifiedIntegration = await this.verify(integration);
    if (!verifiedIntegration.registered) {
      throw new WorktreeError('Integration worktree is no longer registered.', 'WORKTREE_MISMATCH');
    }
    const integrationChanges = await this.changedPaths(integration);
    if (integrationChanges.length > 0) {
      throw new WorktreeError('Integration worktree must be clean before merging a lane.', 'DIRTY_INTEGRATION');
    }
    const preMergeHead = verifiedIntegration.headSha;
    try {
      await git(integration.path, ['merge', '--squash', '--no-commit', worker.branch]);
    } catch (error) {
      const conflicts = (
        await git(integration.path, ['diff', '--name-only', '--diff-filter=U', '--'], [0, 1])
      ).stdout
        .split('\n')
        .filter(Boolean);
      const mergeFailure = conflicts.length > 0 ? new WorktreeConflictError(conflicts) : error;
      try {
        await this.restoreFailedIntegration(integration, preMergeHead);
      } catch (cleanupError) {
        throw new WorktreeError(
          `Failed to restore integration after ${mergeFailure instanceof Error ? mergeFailure.message : String(mergeFailure)}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          'INTEGRATION_CLEANUP_FAILED',
        );
      }
      throw mergeFailure;
    }
    try {
      return await this.checkpoint(integration, message);
    } catch (error) {
      try {
        await this.restoreFailedIntegration(integration, preMergeHead);
      } catch (cleanupError) {
        throw new WorktreeError(
          `Failed to restore integration after checkpoint failure (${error instanceof Error ? error.message : String(error)}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          'INTEGRATION_CLEANUP_FAILED',
        );
      }
      throw error;
    }
  }

  private async restoreFailedIntegration(integration: WorktreeHandle, preMergeHead: string): Promise<void> {
    // The target is the exact, verified integration worktree and SHA captured
    // immediately before merge. Avoid `git clean`: squash merges should only
    // affect tracked/index entries, and unexpected untracked state must fail
    // closed rather than be deleted.
    await git(integration.path, ['reset', '--hard', preMergeHead]);
    const [headSha, changes] = await Promise.all([
      this.head(integration),
      this.changedPaths(integration),
    ]);
    if (headSha !== preMergeHead || changes.length > 0) {
      throw new WorktreeError(
        `Integration cleanup did not restore ${preMergeHead}; head=${headSha}, changes=${changes.join(', ') || 'none'}.`,
        'INTEGRATION_CLEANUP_FAILED',
      );
    }
  }

  async verify(handle: WorktreeHandle): Promise<{ headSha: string; branch: string; registered: boolean }> {
    const branch = (await git(handle.path, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
    const registeredPaths = (await git(handle.repoRoot, ['worktree', 'list', '--porcelain'])).stdout
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length));
    const expectedPath = await realpath(handle.path);
    const registered = (
      await Promise.all(
        registeredPaths.map(async candidate => {
          try {
            return await realpath(candidate);
          } catch {
            return path.resolve(candidate);
          }
        }),
      )
    ).includes(expectedPath);
    if (branch !== handle.branch) {
      throw new WorktreeError(`Expected ${handle.branch}, found ${branch}.`, 'WORKTREE_MISMATCH');
    }
    return { headSha: await this.head(handle), branch, registered };
  }
}
