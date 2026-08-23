import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  access,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryMutationJournal, MutationInDoubtError, stableFingerprint } from './mutation-journal.js';
import type { JournalEntry, MutationJournal } from './mutation-journal.js';
import { globMatches, PathPolicy, SECRET_PATH_PATTERNS } from './path-policy.js';

export const BROKER_TOOL_NAMES = [
  'list_files',
  'read_file',
  'search',
  'apply_patch',
  'git_diff',
  'run_check',
  'run_approved',
  'report_progress',
] as const;

export type BrokerToolName = (typeof BROKER_TOOL_NAMES)[number];

export interface ApprovedCommand {
  id: string;
  argv: readonly [string, ...string[]];
  kind: 'check' | 'command';
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowedExitCodes?: readonly number[];
  env?: Readonly<Record<string, string>>;
  /** Whether the command requests network access. Defaults to false. */
  network?: boolean;
  /** Extra argv tokens that a provider may select explicitly. */
  allowedArgs?: readonly string[];
}

export type PatchOperation =
  | {
      type: 'write';
      path: string;
      content: string;
      expectedSha256?: string | null;
    }
  | {
      type: 'replace';
      path: string;
      oldText: string;
      newText: string;
      expectedOccurrences?: number;
      expectedSha256?: string;
    }
  | {
      type: 'delete';
      path: string;
      expectedSha256?: string;
    };

export interface ApplyPatchRequest {
  operationId: string;
  operations: readonly PatchOperation[];
}

export interface ToolBrokerOptions {
  root: string;
  actorId: string;
  writeSet?: readonly string[];
  protectedPaths?: readonly string[];
  readProtectedPaths?: readonly string[];
  approvedCommands?: readonly ApprovedCommand[];
  journal?: MutationJournal;
  maxReadBytes?: number;
  maxPatchBytes?: number;
  maxFileScanBytes?: number;
  maxSearchBytes?: number;
  maxListEntries?: number;
  maxSearchMatches?: number;
  /** Network commands remain denied unless their exact id was approved at kickoff. */
  approvedNetworkCommandIds?: readonly string[];
  /** Optional actor-specific capability ceiling. Defaults to all eight tools. */
  allowedTools?: readonly BrokerToolName[];
  recoverMutation?: (
    entry: JournalEntry,
    request: ApplyPatchRequest,
  ) => Promise<unknown | undefined>;
}

export interface CommandResult {
  commandId: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
}

export class ToolBrokerError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ToolBrokerError';
  }
}

const COMMAND_WRAPPER_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/bin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
});

const FORBIDDEN_COMMAND_ENVIRONMENT_KEYS = new Set([
  'BASH_ENV',
  'BASHOPTS',
  'CLASSPATH',
  'CODEX_HOME',
  'CORECLR_ENABLE_PROFILING',
  'CORECLR_PROFILER',
  'CORECLR_PROFILER_PATH',
  'DOTNET_ADDITIONAL_DEPS',
  'DOTNET_STARTUP_HOOKS',
  'ENV',
  'GCONV_PATH',
  'GIT_ASKPASS',
  'GIT_CONFIG_PARAMETERS',
  'GIT_EXEC_PATH',
  'GIT_EXTERNAL_DIFF',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_TEMPLATE_DIR',
  'HOME',
  'JDK_JAVA_OPTIONS',
  'JAVA_TOOL_OPTIONS',
  'LUA_CPATH',
  'LUA_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NPM_CONFIG_NODE_OPTIONS',
  'NPM_CONFIG_SCRIPT_SHELL',
  'PATH',
  'PERL5LIB',
  'PERL5OPT',
  'PYTHONHOME',
  'PYTHONINSPECT',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYLIB',
  'RUBYOPT',
  'SHELLOPTS',
  'SSH_ASKPASS',
  'TEMP',
  'TMP',
  'TMPDIR',
  'ZDOTDIR',
  '_JAVA_OPTIONS',
]);

function isForbiddenCommandEnvironmentKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return (
    FORBIDDEN_COMMAND_ENVIRONMENT_KEYS.has(normalized) ||
    normalized.startsWith('LD_') ||
    normalized.startsWith('DYLD_') ||
    normalized.startsWith('GIT_CONFIG_KEY_') ||
    normalized.startsWith('GIT_CONFIG_VALUE_')
  );
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function atomicWrite(filePath: string, content: string | Buffer, mode: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.goalie-${randomUUID()}-${path.basename(filePath)}.tmp`,
  );
  try {
    await writeFile(temporary, content, { mode, flag: 'wx' });
    await rename(temporary, filePath);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AggregateError([error, cleanupError], `Failed to write and clean up ${filePath}.`);
      }
    }
    throw error;
  }
}

async function readPrefix(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ToolBrokerError('Tool input must be an object.', 'INVALID_INPUT');
  }
  return input as Record<string, unknown>;
}

function boundedString(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes) {
    throw new ToolBrokerError(`${field} must be a bounded string.`, 'INVALID_INPUT');
  }
  return value;
}

function optionalBoundedString(value: unknown, field: string, maxBytes: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, field, maxBytes);
}

function validSha(value: unknown, nullable = false): boolean {
  return (nullable && value === null) || (typeof value === 'string' && /^[a-f\d]{64}$/iu.test(value));
}

async function executable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(name: string): Promise<string | undefined> {
  if (path.isAbsolute(name)) return (await executable(name)) ? name : undefined;
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

async function resolveCommandExecutable(name: string, cwd: string): Promise<string | undefined> {
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    const candidate = path.resolve(cwd, name);
    return (await executable(candidate)) ? candidate : undefined;
  }
  return await findOnPath(name);
}

async function canonicalIfPresent(candidate: string): Promise<string | undefined> {
  try {
    return await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function sbpl(value: string): string {
  return JSON.stringify(value);
}

export interface CommandContainmentStatus {
  available: boolean;
  platform: NodeJS.Platform;
  mechanism: 'sandbox-exec' | 'bubblewrap' | 'unsupported';
  reason?: string;
}

let containmentPreflightPromise: Promise<CommandContainmentStatus> | undefined;

async function probe(argv: readonly [string, ...string[]]): Promise<{ code: number | null; stderr: string }> {
  return await new Promise(resolve => {
    const [binary, ...args] = argv;
    const child = spawn(binary, args, {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, stderr: Buffer.concat(stderr).toString('utf8').slice(0, 4_000) });
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.reduce((total, item) => total + item.length, 0) < 4_000) stderr.push(chunk);
    });
    child.once('error', error => {
      stderr.push(Buffer.from(error instanceof Error ? error.message : String(error)));
      finish(null);
    });
    child.once('close', finish);
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, 3_000);
    timeout.unref();
  });
}

/** Reusable doctor/preflight for the fail-closed OS command boundary. */
export async function commandContainmentPreflight(options: { refresh?: boolean } = {}): Promise<CommandContainmentStatus> {
  if (options.refresh) containmentPreflightPromise = undefined;
  containmentPreflightPromise ??= (async () => {
    if (process.platform === 'darwin') {
      if (!(await executable('/usr/bin/sandbox-exec'))) {
        return {
          available: false,
          platform: process.platform,
          mechanism: 'sandbox-exec',
          reason: 'sandbox-exec is not installed.',
        };
      }
      const result = await probe([
        '/usr/bin/sandbox-exec',
        '-p',
        '(version 1) (allow default)',
        '/usr/bin/true',
      ]);
      return result.code === 0
        ? { available: true, platform: process.platform, mechanism: 'sandbox-exec' }
        : {
            available: false,
            platform: process.platform,
            mechanism: 'sandbox-exec',
            reason: result.stderr.trim() || `sandbox-exec probe exited ${result.code ?? 'by signal'}.`,
          };
    }
    if (process.platform === 'linux') {
      const bubblewrap = await findOnPath('bwrap');
      if (!bubblewrap) {
        return {
          available: false,
          platform: process.platform,
          mechanism: 'bubblewrap',
          reason: 'bwrap is not installed.',
        };
      }
      const trueBinary = (await findOnPath('true')) ?? '/usr/bin/true';
      const result = await probe([
        bubblewrap,
        '--die-with-parent',
        '--new-session',
        '--unshare-user',
        '--unshare-pid',
        '--unshare-net',
        '--ro-bind',
        '/usr',
        '/usr',
        '--dev',
        '/dev',
        '--proc',
        '/proc',
        '--',
        trueBinary,
      ]);
      return result.code === 0
        ? { available: true, platform: process.platform, mechanism: 'bubblewrap' }
        : {
            available: false,
            platform: process.platform,
            mechanism: 'bubblewrap',
            reason: result.stderr.trim() || `bwrap probe exited ${result.code ?? 'by signal'}.`,
          };
    }
    return {
      available: false,
      platform: process.platform,
      mechanism: 'unsupported',
      reason: `No command sandbox is implemented for ${process.platform}.`,
    };
  })();
  return await containmentPreflightPromise;
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export interface CommandWriteScope {
  writable: ReadonlyArray<{ path: string; recursive: boolean }>;
  protected: readonly string[];
}

function relativePolicyPath(root: string, pattern: string): string {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (!normalized || path.isAbsolute(normalized) || normalized.includes('\0')) {
    throw new ToolBrokerError(`Unsafe write-set pattern: ${pattern}`, 'UNREPRESENTABLE_WRITE_SET');
  }
  const candidate = path.resolve(root, normalized);
  if (!within(root, candidate)) {
    throw new ToolBrokerError(`Write-set pattern escapes the workspace: ${pattern}`, 'UNREPRESENTABLE_WRITE_SET');
  }
  return candidate;
}

function patternsOverlap(target: { path: string; recursive: boolean }, candidate: string): boolean {
  return candidate === target.path || (target.recursive && within(target.path, candidate)) || within(candidate, target.path);
}

/**
 * Converts actor write-set globs into OS-sandbox mounts/filters without
 * widening them. Only `**`, `path/**`, and existing exact files are portable
 * across sandbox-exec and bubblewrap; other shapes fail closed.
 */
export async function resolveCommandWriteScope(options: {
  root: string;
  kind: ApprovedCommand['kind'];
  writeSet: readonly string[];
  protectedPaths: readonly string[];
}): Promise<CommandWriteScope> {
  const root = await realpath(options.root);
  if (options.kind === 'check') return { writable: [], protected: [] };

  const writable: Array<{ path: string; recursive: boolean }> = [];
  for (const rawPattern of options.writeSet) {
    const pattern = rawPattern.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
    if (pattern === '**') {
      writable.push({ path: root, recursive: true });
      continue;
    }
    const recursive = pattern.endsWith('/**');
    const relative = recursive ? pattern.slice(0, -3) : pattern;
    if (!relative || /[?*]/u.test(relative) || (!recursive && /[?*]/u.test(pattern))) {
      throw new ToolBrokerError(
        `Write-set pattern cannot be represented by the OS sandbox: ${rawPattern}`,
        'UNREPRESENTABLE_WRITE_SET',
      );
    }
    const expected = relativePolicyPath(root, relative);
    const canonical = await canonicalIfPresent(expected);
    if (!canonical || canonical !== expected) {
      throw new ToolBrokerError(
        `Write-set target must exist canonically before command execution: ${rawPattern}`,
        'UNREPRESENTABLE_WRITE_SET',
      );
    }
    const details = await stat(canonical);
    if (!details.isFile() && !details.isDirectory()) {
      throw new ToolBrokerError(`Write-set target is not a regular file or directory: ${rawPattern}`, 'UNREPRESENTABLE_WRITE_SET');
    }
    if (!recursive && details.isDirectory()) {
      throw new ToolBrokerError(
        `An exact directory pattern would widen command writes; use ${relative}/** explicitly.`,
        'UNREPRESENTABLE_WRITE_SET',
      );
    }
    writable.push({ path: canonical, recursive: recursive && details.isDirectory() });
  }

  writable.sort((left, right) => left.path.length - right.path.length);
  const minimalWritable = writable.filter(
    (candidate, index, all) =>
      !all.slice(0, index).some(parent => parent.recursive && within(parent.path, candidate.path)),
  );

  const protectedTargets = new Set<string>();
  for (const rawPattern of options.protectedPaths) {
    const pattern = rawPattern.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
    const recursive = pattern.endsWith('/**');
    const relative = recursive ? pattern.slice(0, -3) : pattern;
    const staticPrefix = relative.replace(/[?*].*$/u, '').replace(/\/+$/u, '');
    const prospective = relativePolicyPath(root, staticPrefix || '.');
    if (!minimalWritable.some(target => patternsOverlap(target, prospective))) continue;
    if (!relative || /[?*]/u.test(relative)) {
      throw new ToolBrokerError(
        `Protected pattern overlapping command writes is not representable: ${rawPattern}`,
        'UNREPRESENTABLE_WRITE_SET',
      );
    }
    const expected = relativePolicyPath(root, relative);
    const canonical = await canonicalIfPresent(expected);
    if (!canonical || canonical !== expected) {
      throw new ToolBrokerError(
        `Protected target overlapping command writes must exist canonically: ${rawPattern}`,
        'UNREPRESENTABLE_WRITE_SET',
      );
    }
    if (minimalWritable.some(target => within(canonical, target.path))) {
      throw new ToolBrokerError(
        `Write-set target is inside protected path: ${rawPattern}`,
        'UNREPRESENTABLE_WRITE_SET',
      );
    }
    protectedTargets.add(canonical);
  }

  return { writable: minimalWritable, protected: [...protectedTargets] };
}

function packageRuntimeRoot(executablePath: string): string {
  const nodeModule = executablePath.match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)/u)?.[1];
  if (nodeModule) return nodeModule;
  const homebrew = executablePath.match(/^(.*\/Cellar\/[^/]+\/[^/]+)/u)?.[1];
  if (homebrew) return homebrew;
  const nix = executablePath.match(/^(\/nix\/store\/[^/]+)/u)?.[1];
  if (nix) return nix;
  return executablePath;
}

const DARWIN_SYSTEM_RUNTIME_ROOTS = [
  '/System/Library',
  '/System/Cryptexes',
  '/usr/lib',
  '/usr/libexec',
  '/Library/Apple',
] as const;

const MACH_O_MAGICS = new Set([
  'cafebabe',
  'cafebabf',
  'cefaedfe',
  'cffaedfe',
  'feedface',
  'feedfacf',
  'bebafeca',
  'bfbafeca',
]);

function isDarwinSystemRuntimePath(candidate: string): boolean {
  const absolute = path.resolve(candidate);
  return DARWIN_SYSTEM_RUNTIME_ROOTS.some(root => within(root, absolute));
}

function homebrewPackageRoot(candidate: string): string | undefined {
  const absolute = path.resolve(candidate);
  return (
    absolute.match(/^(\/opt\/homebrew\/opt\/[^/]+)(?:\/|$)/u)?.[1] ??
    absolute.match(/^(\/usr\/local\/opt\/[^/]+)(?:\/|$)/u)?.[1] ??
    absolute.match(/^(.*\/Cellar\/[^/]+\/[^/]+)(?:\/|$)/u)?.[1]
  );
}

function homebrewRuntimeConfigurationFiles(packageRoot: string): string[] {
  const match = /^(\/opt\/homebrew|\/usr\/local)\/opt\/(openssl(?:@[^/]+)?)$/u.exec(packageRoot);
  if (!match?.[1] || !match[2]) return [];
  const configurationRoot = path.join(match[1], 'etc', match[2]);
  return [path.join(configurationRoot, 'openssl.cnf'), path.join(configurationRoot, 'cert.pem')];
}

async function pinDarwinDataFile(roots: Set<string>, candidate: string): Promise<void> {
  const absolute = path.resolve(candidate);
  const canonical = await canonicalIfPresent(absolute);
  if (!canonical) return;
  const details = await stat(canonical);
  if (!details.isFile()) {
    throw new ToolBrokerError('A Darwin runtime data dependency is not a regular file.', 'COMMAND_RUNTIME_UNAVAILABLE');
  }
  roots.add(absolute);
  roots.add(canonical);
}

async function isMachO(candidate: string): Promise<boolean> {
  const header = await readPrefix(candidate, 4);
  return header.length === 4 && MACH_O_MAGICS.has(header.toString('hex'));
}

async function darwinToolOutput(
  args: readonly string[],
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxOutputBytes = options.maxOutputBytes ?? 512_000;
  if (args.some(argument => argument.includes('\0') || argument.includes('\n') || argument.includes('\r'))) {
    throw new ToolBrokerError('A Darwin runtime path cannot contain a line break.', 'COMMAND_RUNTIME_UNAVAILABLE');
  }
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('/usr/bin/otool', [...args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(Buffer.concat(stdout).toString('utf8'));
    };
    const capture = (target: Buffer[], chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const used = stream === 'stdout' ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, maxOutputBytes - used);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      if (stream === 'stdout') stdoutBytes += Math.min(chunk.length, remaining);
      else stderrBytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) {
        child.kill('SIGKILL');
        finish(new ToolBrokerError('otool output exceeded its safety bound.', 'COMMAND_RUNTIME_UNAVAILABLE'));
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => capture(stdout, chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk, 'stderr'));
    child.once('error', error => finish(error));
    child.once('close', code => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 2_000);
        finish(
          new ToolBrokerError(
            `otool could not inspect the approved runtime${detail ? `: ${detail}` : ''}`,
            'COMMAND_RUNTIME_UNAVAILABLE',
          ),
        );
        return;
      }
      finish();
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new ToolBrokerError('otool inspection timed out.', 'COMMAND_RUNTIME_UNAVAILABLE'));
    }, timeoutMs);
    timeout.unref();
  });
}

function parseDarwinLibraries(output: string): string[] {
  const libraries: string[] = [];
  for (const line of output.split(/\r?\n/u).slice(1)) {
    const match = /^\s+(.+?) \((?:compatibility|current) version /u.exec(line);
    if (match?.[1]) libraries.push(match[1]);
  }
  return libraries;
}

function parseDarwinRunpaths(output: string): string[] {
  const lines = output.split(/\r?\n/u);
  const runpaths: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== 'cmd LC_RPATH') continue;
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 8); cursor += 1) {
      const match = /^\s*path (.+?) \(offset \d+\)$/u.exec(lines[cursor] ?? '');
      if (match?.[1]) {
        runpaths.push(match[1]);
        break;
      }
    }
  }
  return runpaths;
}

function expandDarwinLoaderPath(
  reference: string,
  loaderPath: string,
  executablePath: string,
): string | undefined {
  const loaderDirectory = path.dirname(loaderPath);
  const executableDirectory = path.dirname(executablePath);
  if (reference === '@loader_path') return loaderDirectory;
  if (reference.startsWith('@loader_path/')) {
    return path.resolve(loaderDirectory, reference.slice('@loader_path/'.length));
  }
  if (reference === '@executable_path') return executableDirectory;
  if (reference.startsWith('@executable_path/')) {
    return path.resolve(executableDirectory, reference.slice('@executable_path/'.length));
  }
  if (path.isAbsolute(reference)) return path.normalize(reference);
  if (!reference.startsWith('@')) return path.resolve(loaderDirectory, reference);
  return undefined;
}

async function pinDarwinRuntimePath(
  roots: Set<string>,
  lexicalPath: string,
): Promise<{ canonical: string; isSystem: boolean } | undefined> {
  const absolute = path.resolve(lexicalPath);
  const canonical = await canonicalIfPresent(absolute);
  if (!canonical) return undefined;
  const details = await stat(canonical);
  if (!details.isFile()) {
    throw new ToolBrokerError('A Darwin runtime dependency is not a regular file.', 'COMMAND_RUNTIME_UNAVAILABLE');
  }
  if (isDarwinSystemRuntimePath(absolute) || isDarwinSystemRuntimePath(canonical)) {
    return { canonical, isSystem: true };
  }
  roots.add(absolute);
  roots.add(canonical);
  for (const candidate of [absolute, canonical]) {
    const packageRoot = homebrewPackageRoot(candidate);
    if (!packageRoot) continue;
    roots.add(packageRoot);
    const canonicalPackageRoot = await canonicalIfPresent(packageRoot);
    if (canonicalPackageRoot) roots.add(canonicalPackageRoot);
    for (const configurationFile of homebrewRuntimeConfigurationFiles(packageRoot)) {
      await pinDarwinDataFile(roots, configurationFile);
    }
  }
  return { canonical, isSystem: false };
}

/**
 * Pins the non-system Mach-O dependency closure used by an approved command.
 * This is deliberately bounded and uses only Apple's fixed otool binary; it
 * never executes metadata or hooks from the inspected workspace.
 */
async function darwinDynamicRuntimeRoots(entrypoints: readonly string[]): Promise<string[]> {
  if (process.platform !== 'darwin') return [];
  const roots = new Set<string>();
  const queue: Array<{
    lexical: string;
    executable: string;
    inheritedRunpaths: readonly string[];
    depth: number;
  }> = entrypoints.map(lexical => ({ lexical, executable: lexical, inheritedRunpaths: [], depth: 0 }));
  const visited = new Set<string>();
  const maximumImages = 192;
  const maximumDepth = 12;

  while (queue.length > 0) {
    if (visited.size >= maximumImages) {
      throw new ToolBrokerError('Darwin runtime dependency closure exceeded its image bound.', 'COMMAND_RUNTIME_UNAVAILABLE');
    }
    const item = queue.shift();
    if (!item) break;
    if (item.depth > maximumDepth) {
      throw new ToolBrokerError('Darwin runtime dependency closure exceeded its depth bound.', 'COMMAND_RUNTIME_UNAVAILABLE');
    }
    const pinned = await pinDarwinRuntimePath(roots, item.lexical);
    if (!pinned || pinned.isSystem || visited.has(pinned.canonical)) continue;
    visited.add(pinned.canonical);
    if (!(await isMachO(pinned.canonical))) continue;
    const executablePath = item.depth === 0 ? pinned.canonical : item.executable;

    const libraries = parseDarwinLibraries(await darwinToolOutput(['-L', pinned.canonical]));
    if (libraries.length > 192) {
      throw new ToolBrokerError('A Darwin runtime image exceeded its dependency bound.', 'COMMAND_RUNTIME_UNAVAILABLE');
    }
    const rawRunpaths = libraries.some(reference => reference.startsWith('@rpath/'))
      ? parseDarwinRunpaths(await darwinToolOutput(['-l', pinned.canonical]))
      : [];
    if (rawRunpaths.length > 32) {
      throw new ToolBrokerError('A Darwin runtime image exceeded its runpath bound.', 'COMMAND_RUNTIME_UNAVAILABLE');
    }
    const localRunpaths = rawRunpaths
      .map(reference => expandDarwinLoaderPath(reference, pinned.canonical, executablePath))
      .filter((candidate): candidate is string => candidate !== undefined);
    const activeRunpaths = [...new Set([...localRunpaths, ...item.inheritedRunpaths])];
    if (activeRunpaths.length > 64) {
      throw new ToolBrokerError('Darwin runtime runpath inheritance exceeded its bound.', 'COMMAND_RUNTIME_UNAVAILABLE');
    }

    for (const reference of libraries) {
      const candidates = reference.startsWith('@rpath/')
        ? activeRunpaths.map(runpath => path.join(runpath, reference.slice('@rpath/'.length)))
        : [expandDarwinLoaderPath(reference, pinned.canonical, executablePath)].filter(
            (candidate): candidate is string => candidate !== undefined,
          );
      let resolved = false;
      for (const candidate of candidates) {
        const dependency = await pinDarwinRuntimePath(roots, candidate);
        if (!dependency) continue;
        resolved = true;
        if (!dependency.isSystem) {
          if (queue.length >= maximumImages) {
            throw new ToolBrokerError('Darwin runtime dependency queue exceeded its bound.', 'COMMAND_RUNTIME_UNAVAILABLE');
          }
          queue.push({
            lexical: candidate,
            executable: executablePath,
            inheritedRunpaths: activeRunpaths,
            depth: item.depth + 1,
          });
        }
      }
      if (!resolved && !(path.isAbsolute(reference) && isDarwinSystemRuntimePath(reference))) {
        throw new ToolBrokerError(
          `Darwin runtime dependency could not be resolved: ${reference}`,
          'COMMAND_RUNTIME_UNAVAILABLE',
        );
      }
    }
  }

  return [...roots];
}

async function shebangInterpreter(executablePath: string): Promise<string | undefined> {
  const handle = await open(executablePath, 'r');
  try {
    const buffer = Buffer.alloc(4_096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/u, 1)[0] ?? '';
    if (!firstLine.startsWith('#!')) return undefined;
    const words = firstLine.slice(2).trim().split(/\s+/u);
    const interpreter = words[0];
    if (!interpreter) return undefined;
    if (path.basename(interpreter) === 'env') {
      const name = words.slice(1).find(word => !word.startsWith('-'));
      return name ? await findOnPath(name) : undefined;
    }
    return interpreter;
  } finally {
    await handle.close();
  }
}

async function commandRuntime(command: ApprovedCommand, workspaceRoot: string, cwd: string): Promise<{
  executable: string;
  readRoots: string[];
  pathValue: string;
}> {
  const initial = await resolveCommandExecutable(command.argv[0], cwd);
  if (!initial) throw new ToolBrokerError(`Executable not found: ${command.argv[0]}`, 'COMMAND_NOT_FOUND');
  const initialStats = await stat(initial);
  if (!initialStats.isFile()) {
    throw new ToolBrokerError(`Executable is not a regular file: ${command.argv[0]}`, 'COMMAND_NOT_FOUND');
  }
  const queue = [initial];
  const executables = new Set<string>();
  const originalPaths = new Set<string>();
  const originalDirectories = new Set<string>();
  while (queue.length > 0 && executables.size < 4) {
    const unresolved = queue.shift();
    if (!unresolved) break;
    const original = path.resolve(unresolved);
    originalPaths.add(original);
    originalDirectories.add(path.dirname(original));
    const canonical = await realpath(unresolved);
    if (executables.has(canonical)) continue;
    executables.add(canonical);
    const interpreter = await shebangInterpreter(canonical);
    if (interpreter) queue.push(interpreter);
  }
  const executablePath = await realpath(initial);
  const darwinRuntimeRoots = await darwinDynamicRuntimeRoots([
    ...new Set([...originalPaths, ...executables]),
  ]);
  const runtimeRoots = [...executables]
    .map(candidate => packageRuntimeRoot(candidate))
    .filter(candidate => !within(workspaceRoot, candidate));
  const pathDirectories = [
    path.dirname(executablePath),
    ...originalDirectories,
    path.join(workspaceRoot, 'node_modules', '.bin'),
    '/usr/bin',
    '/bin',
  ];
  return {
    executable: executablePath,
    readRoots: [...new Set([...runtimeRoots, ...originalPaths, ...darwinRuntimeRoots])],
    pathValue: [...new Set(pathDirectories)].join(path.delimiter),
  };
}

async function existingPaths(candidates: readonly string[]): Promise<string[]> {
  const results = await Promise.all(
    candidates.map(async candidate => ((await canonicalIfPresent(candidate)) ? path.resolve(candidate) : undefined)),
  );
  return [...new Set(results.filter((value): value is string => value !== undefined))];
}

/**
 * Resolve existing workspace secrets before entering the OS sandbox. Broker
 * read protection alone is insufficient because an approved verifier executes
 * repository code that could call the filesystem directly.
 */
async function resolveCommandReadDeniedTargets(
  root: string,
  patterns: readonly string[],
): Promise<string[]> {
  const canonicalRoot = await realpath(root);
  const stack = [canonicalRoot];
  const targets = new Set<string>();
  let visited = 0;
  const maximumEntries = 50_000;

  while (stack.length > 0) {
    const directory = stack.pop();
    if (!directory) break;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > maximumEntries) {
        throw new ToolBrokerError(
          'Workspace secret-path scan exceeded its safety bound.',
          'COMMAND_RUNTIME_UNAVAILABLE',
        );
      }
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(canonicalRoot, absolute).replaceAll(path.sep, '/');
      if (patterns.some(pattern => globMatches(pattern, relative))) {
        const canonical = await realpath(absolute);
        if (!within(canonicalRoot, canonical) || canonical !== absolute) {
          throw new ToolBrokerError(
            `Protected command-read path is not canonical: ${relative}`,
            'COMMAND_RUNTIME_UNAVAILABLE',
          );
        }
        targets.add(canonical);
        // Masking a directory masks all descendants; do not scan beneath it.
        continue;
      }
      if (entry.isDirectory() && entry.name !== '.git') stack.push(absolute);
    }
  }
  return [...targets].sort();
}

async function sbplPathFilter(candidate: string): Promise<string> {
  const details = await stat(candidate);
  return details.isDirectory()
    ? `(literal ${sbpl(candidate)}) (subpath ${sbpl(candidate)})`
    : `(literal ${sbpl(candidate)})`;
}

function literalNamespaceAncestors(candidates: readonly string[]): string[] {
  const ancestors = new Set<string>();
  for (const candidate of candidates) {
    let current = path.dirname(path.resolve(candidate));
    while (true) {
      ancestors.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...ancestors].sort((left, right) => left.length - right.length);
}

async function namespaceDirectories(candidates: readonly string[]): Promise<string[]> {
  const directories = new Set<string>();
  for (const candidate of candidates) {
    const details = await stat(candidate);
    let current = details.isDirectory() ? path.resolve(candidate) : path.dirname(path.resolve(candidate));
    while (current !== path.parse(current).root) {
      directories.add(current);
      current = path.dirname(current);
    }
  }
  return [...directories].sort((left, right) => left.length - right.length);
}

async function containedCommand(
  command: ApprovedCommand,
  root: string,
  cwd: string,
  writeSet: readonly string[],
  protectedPatterns: readonly string[],
  readDeniedPatterns: readonly string[],
  networkAllowed: boolean,
  privateTemp: string,
): Promise<ApprovedCommand> {
  const canonicalRoot = await realpath(root);
  const writeScope = await resolveCommandWriteScope({
    root: canonicalRoot,
    kind: command.kind,
    writeSet,
    protectedPaths: protectedPatterns,
  });
  const preflight = await commandContainmentPreflight();
  if (!preflight.available) {
    throw new ToolBrokerError(
      `OS command containment is unavailable: ${preflight.reason ?? 'preflight failed'}`,
      'CONTAINMENT_UNAVAILABLE',
    );
  }
  const canonicalTemp = await realpath(privateTemp);
  const readDeniedTargets = await resolveCommandReadDeniedTargets(canonicalRoot, readDeniedPatterns);
  const runtime = await commandRuntime(command, canonicalRoot, cwd);
  const sharedSystemRoots = await existingPaths(
    process.platform === 'darwin'
      ? [
          '/System/Library',
          '/System/Cryptexes',
          '/usr/bin',
          '/usr/lib',
          '/usr/libexec',
          '/usr/share',
          '/bin',
          '/sbin',
          '/Library/Apple',
        ]
      : ['/usr/bin', '/usr/lib', '/usr/lib64', '/usr/libexec', '/usr/share', '/bin', '/sbin', '/lib', '/lib64'],
  );
  const safeSystemFiles = await existingPaths([
    '/etc/ld.so.cache',
    '/etc/localtime',
    '/etc/gitconfig',
    '/private/etc/localtime',
    ...(networkAllowed
      ? [
          '/etc/hosts',
          '/etc/resolv.conf',
          '/etc/nsswitch.conf',
          '/etc/ssl/certs',
          '/etc/pki/tls/certs',
          '/etc/pki/ca-trust/extracted',
          '/private/etc/hosts',
          '/private/etc/resolv.conf',
          '/private/etc/ssl/cert.pem',
          '/private/etc/ssl/certs',
        ]
      : []),
  ]);
  const readPaths = [
    ...new Set([canonicalRoot, canonicalTemp, ...sharedSystemRoots, ...safeSystemFiles, ...runtime.readRoots]),
  ];
  const isolatedEnvironment: Record<string, string> = {
    ...(command.env ?? {}),
    PATH: runtime.pathValue,
    TMPDIR: canonicalTemp,
    TMP: canonicalTemp,
    TEMP: canonicalTemp,
  };
  const innerArgv = [runtime.executable, ...command.argv.slice(1)] as [string, ...string[]];

  if (process.platform === 'darwin') {
    const sandboxExec = '/usr/bin/sandbox-exec';
    const readTargets = (await Promise.all(readPaths.map(sbplPathFilter))).join(' ');
    const traversalTargets = literalNamespaceAncestors(readPaths)
      .map(candidate => `(literal ${sbpl(candidate)})`)
      .join(' ');
    const writeTargets = [
      `(subpath ${sbpl(canonicalTemp)})`,
      ...writeScope.writable.map(candidate =>
        candidate.recursive ? `(subpath ${sbpl(candidate.path)})` : `(literal ${sbpl(candidate.path)})`,
      ),
    ].join(' ');
    const protectedRules = writeScope.protected
      .map(candidate => `(deny file-write* (subpath ${sbpl(candidate)}))`)
      .join('\n');
    const protectedReadRules = (await Promise.all(readDeniedTargets.map(async candidate => {
      const details = await stat(candidate);
      return details.isDirectory()
        ? `(deny file-read* (literal ${sbpl(candidate)}) (subpath ${sbpl(candidate)}))`
        : `(deny file-read* (literal ${sbpl(candidate)}))`;
    }))).join('\n');
    const profile = [
      '(version 1)',
      '(deny default)',
      '(allow process-exec)',
      '(allow process-fork)',
      '(allow signal (target self))',
      '(allow sysctl-read)',
      `(allow file-read* (literal "/dev/null") (literal "/dev/urandom") ${traversalTargets} ${readTargets})`,
      `(allow file-write* (literal "/dev/null") ${writeTargets})`,
      protectedRules,
      protectedReadRules,
      networkAllowed ? '(allow network*)' : '',
    ]
      .filter(Boolean)
      .join('\n');
    return {
      ...command,
      argv: [
        sandboxExec,
        '-p',
        profile,
        '/usr/bin/env',
        '-i',
        ...Object.entries(isolatedEnvironment)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => `${key}=${value}`),
        ...innerArgv,
      ] as [string, ...string[]],
      // Provider-controlled environment never reaches sandbox-exec itself.
      env: COMMAND_WRAPPER_ENVIRONMENT,
    };
  }

  if (process.platform === 'linux') {
    const bubblewrap = await findOnPath('bwrap');
    if (!bubblewrap) throw new ToolBrokerError('Linux bubblewrap is unavailable.', 'CONTAINMENT_UNAVAILABLE');
    const args: string[] = [
      '--die-with-parent',
      '--new-session',
      '--unshare-user',
      '--unshare-ipc',
      '--unshare-pid',
      '--unshare-uts',
    ];
    for (const directory of await namespaceDirectories(readPaths)) args.push('--dir', directory);
    args.push(
      '--clearenv',
      '--setenv',
      'PATH',
      runtime.pathValue,
      '--setenv',
      'TMPDIR',
      canonicalTemp,
      '--setenv',
      'TMP',
      canonicalTemp,
      '--setenv',
      'TEMP',
      canonicalTemp,
      '--dev',
      '/dev',
      '--proc',
      '/proc',
    );
    for (const [key, value] of Object.entries(command.env ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      args.push('--setenv', key, value);
    }
    for (const readPath of readPaths.filter(candidate => candidate !== canonicalRoot && candidate !== canonicalTemp)) {
      args.push('--ro-bind', readPath, readPath);
    }
    args.push('--ro-bind', canonicalRoot, canonicalRoot);
    for (const [index, protectedPath] of readDeniedTargets.entries()) {
      const details = await stat(protectedPath);
      const mask = path.join(canonicalTemp, 'read-masks', String(index));
      if (details.isDirectory()) await mkdir(mask, { recursive: true });
      else {
        await mkdir(path.dirname(mask), { recursive: true });
        await writeFile(mask, '', { mode: 0o400 });
      }
      args.push('--ro-bind', mask, protectedPath);
    }
    args.push('--bind', canonicalTemp, canonicalTemp);
    for (const writablePath of writeScope.writable) {
      args.push('--bind', writablePath.path, writablePath.path);
    }
    for (const protectedPath of writeScope.protected) args.push('--ro-bind', protectedPath, protectedPath);
    if (!networkAllowed) args.push('--unshare-net');
    args.push('--chdir', cwd, '--', ...innerArgv);
    return {
      ...command,
      argv: [bubblewrap, ...args] as [string, ...string[]],
      // Provider-controlled environment is installed only after bwrap has
      // entered containment; it can never influence the wrapper loader.
      env: COMMAND_WRAPPER_ENVIRONMENT,
    };
  }

  throw new ToolBrokerError(
    `No OS command sandbox is implemented for ${process.platform}.`,
    'CONTAINMENT_UNAVAILABLE',
  );
}

async function runArgv(
  command: ApprovedCommand,
  cwd: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const timeoutMs = command.timeoutMs ?? 120_000;
  const maxOutputBytes = command.maxOutputBytes ?? 1_000_000;
  const started = Date.now();
  const environment: NodeJS.ProcessEnv = command.env ? { ...command.env } : {};
  if (!command.env) {
    for (const key of ['PATH', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP'] as const) {
      const value = process.env[key];
      if (value !== undefined) environment[key] = value;
    }
  }

  return await new Promise<CommandResult>((resolve, reject) => {
    const [binary, ...args] = command.argv;
    const child = spawn(binary, args, {
      cwd,
      env: environment,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;

    const sendSignal = (processSignal: NodeJS.Signals): void => {
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, processSignal);
          return;
        } catch {
          // Fall back to the direct child when its process group is already gone.
        }
      }
      child.kill(processSignal);
    };
    const terminate = (): void => {
      sendSignal('SIGTERM');
      forceKill ??= setTimeout(() => sendSignal('SIGKILL'), 1_500);
      forceKill.unref();
    };

    const capture = (target: Buffer[], chunk: Buffer): void => {
      const remaining = Math.max(0, maxOutputBytes - capturedBytes);
      if (remaining > 0) {
        const portion = chunk.subarray(0, remaining);
        target.push(portion);
        capturedBytes += portion.length;
      }
      if (chunk.length > remaining) {
        outputTruncated = true;
        terminate();
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk));

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref();

    const abort = (): void => {
      terminate();
    };
    signal?.addEventListener('abort', abort, { once: true });

    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', (exitCode, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      signal?.removeEventListener('abort', abort);
      resolve({
        commandId: command.id,
        exitCode,
        signal: closeSignal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - started,
        timedOut,
        outputTruncated,
      });
    });
  });
}

export class ToolBroker {
  readonly policy: PathPolicy;
  readonly actorId: string;
  readonly journal: MutationJournal;

  private readonly commands = new Map<string, ApprovedCommand>();
  private readonly maxReadBytes: number;
  private readonly maxPatchBytes: number;
  private readonly maxFileScanBytes: number;
  private readonly maxSearchBytes: number;
  private readonly maxListEntries: number;
  private readonly maxSearchMatches: number;
  private readonly recoverMutation?: ToolBrokerOptions['recoverMutation'];
  private readonly approvedNetworkCommandIds: ReadonlySet<string>;
  private readonly allowedTools: ReadonlySet<BrokerToolName>;
  private readonly activeMutations = new Map<
    string,
    { fingerprint: string; done: Promise<void>; release: () => void }
  >();

  constructor(options: ToolBrokerOptions) {
    this.actorId = options.actorId;
    this.policy = new PathPolicy({
      root: options.root,
      ...(options.writeSet ? { writeSet: options.writeSet } : {}),
      ...(options.protectedPaths ? { protectedPaths: options.protectedPaths } : {}),
      ...(options.readProtectedPaths ? { readProtectedPaths: options.readProtectedPaths } : {}),
    });
    this.journal = options.journal ?? new InMemoryMutationJournal();
    this.maxReadBytes = options.maxReadBytes ?? 512_000;
    this.maxPatchBytes = options.maxPatchBytes ?? 2_000_000;
    this.maxFileScanBytes = options.maxFileScanBytes ?? 16_000_000;
    this.maxSearchBytes = options.maxSearchBytes ?? 16_000_000;
    this.maxListEntries = options.maxListEntries ?? 5_000;
    this.maxSearchMatches = options.maxSearchMatches ?? 500;
    this.recoverMutation = options.recoverMutation;
    this.approvedNetworkCommandIds = new Set(options.approvedNetworkCommandIds ?? []);
    this.allowedTools = new Set(options.allowedTools ?? BROKER_TOOL_NAMES);

    for (const name of this.allowedTools) {
      if (!(BROKER_TOOL_NAMES as readonly string[]).includes(name)) {
        throw new ToolBrokerError(`Unknown allowed broker tool: ${String(name)}`, 'INVALID_CONFIG');
      }
    }

    for (const [name, bound] of Object.entries({
      maxReadBytes: this.maxReadBytes,
      maxPatchBytes: this.maxPatchBytes,
      maxFileScanBytes: this.maxFileScanBytes,
      maxSearchBytes: this.maxSearchBytes,
      maxListEntries: this.maxListEntries,
      maxSearchMatches: this.maxSearchMatches,
    })) {
      if (!Number.isSafeInteger(bound) || bound <= 0) {
        throw new ToolBrokerError(`${name} must be a positive safe integer.`, 'INVALID_CONFIG');
      }
    }

    for (const command of options.approvedCommands ?? []) {
      if (this.commands.has(command.id)) {
        throw new ToolBrokerError(`Duplicate approved command id: ${command.id}`, 'INVALID_CONFIG');
      }
      if (command.argv.some(argument => argument.includes('\0'))) {
        throw new ToolBrokerError(`Command ${command.id} contains a NUL byte.`, 'INVALID_CONFIG');
      }
      if (command.network !== undefined && typeof command.network !== 'boolean') {
        throw new ToolBrokerError(`Command ${command.id} has an invalid network flag.`, 'INVALID_CONFIG');
      }
      const environmentEntries = Object.entries(command.env ?? {});
      if (environmentEntries.length > 128) {
        throw new ToolBrokerError(`Command ${command.id} environment exceeds a configured bound.`, 'INVALID_CONFIG');
      }
      let environmentBytes = 0;
      for (const [key, value] of environmentEntries) {
        if (
          !/^[A-Z_][A-Z\d_]*$/iu.test(key) ||
          isForbiddenCommandEnvironmentKey(key) ||
          typeof value !== 'string' ||
          value.includes('\0') ||
          Buffer.byteLength(value) > 16_384
        ) {
          throw new ToolBrokerError(`Command ${command.id} has an unsafe environment entry.`, 'INVALID_CONFIG');
        }
        environmentBytes += Buffer.byteLength(key) + Buffer.byteLength(value);
        if (environmentBytes > 131_072) {
          throw new ToolBrokerError(`Command ${command.id} environment exceeds a configured bound.`, 'INVALID_CONFIG');
        }
      }
      if (
        command.argv.length > 128 ||
        command.argv.some(argument => Buffer.byteLength(argument) > 16_384) ||
        (command.timeoutMs !== undefined && (!Number.isFinite(command.timeoutMs) || command.timeoutMs <= 0)) ||
        (command.maxOutputBytes !== undefined &&
          (!Number.isSafeInteger(command.maxOutputBytes) || command.maxOutputBytes <= 0))
      ) {
        throw new ToolBrokerError(`Command ${command.id} exceeds a configured bound.`, 'INVALID_CONFIG');
      }
      this.commands.set(command.id, command);
    }
    for (const commandId of this.approvedNetworkCommandIds) {
      const command = this.commands.get(commandId);
      if (!command || command.network !== true) {
        throw new ToolBrokerError(
          `Network approval does not identify a network command: ${commandId}`,
          'INVALID_CONFIG',
        );
      }
    }
  }

  private async acquireMutationReservation(
    operationId: string,
    fingerprint: string,
  ): Promise<() => void> {
    while (true) {
      const active = this.activeMutations.get(operationId);
      if (active) {
        if (active.fingerprint !== fingerprint) {
          throw new ToolBrokerError(
            'Operation id was reused with different input.',
            'IDEMPOTENCY_CONFLICT',
          );
        }
        await active.done;
        continue;
      }

      let releaseGate!: () => void;
      const done = new Promise<void>(resolve => {
        releaseGate = resolve;
      });
      const reservation = { fingerprint, done, release: releaseGate };
      this.activeMutations.set(operationId, reservation);
      return () => {
        if (this.activeMutations.get(operationId) === reservation) {
          this.activeMutations.delete(operationId);
        }
        reservation.release();
      };
    }
  }

  private async replayExistingMutation(
    existing: JournalEntry,
    fingerprint: string,
    request: ApplyPatchRequest,
  ): Promise<unknown> {
    if (existing.fingerprint !== fingerprint) {
      throw new ToolBrokerError(
        'Operation id was reused with different input.',
        'IDEMPOTENCY_CONFLICT',
      );
    }
    if (existing.status === 'completed') return existing.result;
    if (existing.status === 'failed') {
      throw new ToolBrokerError(
        existing.error ?? 'Previous attempt failed.',
        'PREVIOUSLY_FAILED',
      );
    }
    const recovered = await this.recoverMutation?.(existing, request);
    if (recovered !== undefined) {
      await this.journal.append({
        operationId: request.operationId,
        fingerprint,
        status: 'completed',
        timestamp: new Date().toISOString(),
        result: recovered,
      });
      return recovered;
    }
    throw new MutationInDoubtError(request.operationId);
  }

  async invoke(name: BrokerToolName, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.allowedTools.has(name)) {
      throw new ToolBrokerError(
        `Broker tool is not allowed for actor ${this.actorId}: ${name}`,
        'TOOL_NOT_ALLOWED',
      );
    }
    const value = inputRecord(input);
    switch (name) {
      case 'list_files': {
        const requestedPath = optionalBoundedString(value.path, 'path', 4_096);
        const glob = optionalBoundedString(value.glob, 'glob', 1_024);
        return await this.listFiles({
          path: requestedPath ?? '.',
          ...(glob !== undefined ? { glob } : {}),
        });
      }
      case 'read_file': {
        const requestedPath = boundedString(value.path, 'path', 4_096);
        for (const field of ['startLine', 'endLine'] as const) {
          const candidate = value[field];
          if (
            candidate !== undefined &&
            (typeof candidate !== 'number' ||
              !Number.isSafeInteger(candidate) ||
              candidate < 1 ||
              candidate > 10_000_000)
          ) {
            throw new ToolBrokerError(`${field} must be a bounded positive integer.`, 'INVALID_INPUT');
          }
        }
        return await this.readFile(requestedPath, {
          ...(typeof value.startLine === 'number' ? { startLine: value.startLine } : {}),
          ...(typeof value.endLine === 'number' ? { endLine: value.endLine } : {}),
        });
      }
      case 'search': {
        const query = boundedString(value.query, 'query', 8_192);
        const requestedPath = optionalBoundedString(value.path, 'path', 4_096);
        const glob = optionalBoundedString(value.glob, 'glob', 1_024);
        if (value.caseSensitive !== undefined && typeof value.caseSensitive !== 'boolean') {
          throw new ToolBrokerError('caseSensitive must be a boolean.', 'INVALID_INPUT');
        }
        return await this.search({
          query,
          path: requestedPath ?? '.',
          ...(glob !== undefined ? { glob } : {}),
          caseSensitive: value.caseSensitive === true,
        });
      }
      case 'apply_patch':
        if (typeof value.operationId !== 'string' || !Array.isArray(value.operations)) {
          throw new ToolBrokerError('operationId and operations are required', 'INVALID_INPUT');
        }
        return await this.applyPatch({
          operationId: value.operationId,
          operations: value.operations as PatchOperation[],
        });
      case 'git_diff':
        return await this.gitDiff(signal);
      case 'run_check':
        return await this.runCheck(boundedString(value.checkId, 'checkId', 256), signal);
      case 'run_approved': {
        const validatedArgs = value.validatedArgs;
        if (
          validatedArgs !== undefined &&
          (!Array.isArray(validatedArgs) ||
            validatedArgs.length > 32 ||
            validatedArgs.some(item => typeof item !== 'string' || Buffer.byteLength(item) > 4_096))
        ) {
          throw new ToolBrokerError('validatedArgs must be an array of at most 32 bounded strings.', 'INVALID_INPUT');
        }
        return await this.runApprovedCommand(
          boundedString(value.commandId, 'commandId', 256),
          (validatedArgs ?? []) as string[],
          signal,
        );
      }
      case 'report_progress': {
        const summary = boundedString(value.summary, 'summary', 8_000).trim();
        if (!summary) throw new ToolBrokerError('summary cannot be empty.', 'INVALID_INPUT');
        const status = value.status === undefined ? 'working' : value.status;
        if (!['working', 'blocked', 'done'].includes(String(status))) {
          throw new ToolBrokerError('status must be working, blocked, or done.', 'INVALID_INPUT');
        }
        if (
          value.percent !== undefined &&
          (typeof value.percent !== 'number' || !Number.isFinite(value.percent) || value.percent < 0 || value.percent > 100)
        ) {
          throw new ToolBrokerError('percent must be between 0 and 100.', 'INVALID_INPUT');
        }
        return {
          accepted: true,
          actorId: this.actorId,
          status,
          summary,
          ...(typeof value.percent === 'number' ? { percent: value.percent } : {}),
        };
      }
      default:
        throw new ToolBrokerError(`Unknown broker tool: ${String(name)}`, 'UNKNOWN_TOOL');
    }
  }

  async listFiles(options: { path?: string; glob?: string } = {}): Promise<{ files: string[]; truncated: boolean }> {
    const start = await this.policy.resolveForRead(options.path ?? '.');
    const startStat = await stat(start.absolute);
    if (!startStat.isDirectory()) throw new ToolBrokerError('list_files path must be a directory', 'INVALID_INPUT');
    const files: string[] = [];
    const stack = [start.absolute];
    let truncated = false;
    let visitedEntries = 0;

    while (stack.length > 0) {
      const directory = stack.pop();
      if (!directory) break;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        visitedEntries += 1;
        if (visitedEntries > this.maxListEntries) {
          return { files: files.sort(), truncated: true };
        }
        if (entry.name === '.git') continue;
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(this.policy.root, absolute).replaceAll(path.sep, '/');
        if (!this.policy.isReadableRelative(relative)) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          stack.push(absolute);
        } else if (!options.glob || globMatches(options.glob, relative)) {
          files.push(relative);
          if (files.length >= this.maxListEntries) {
            truncated = true;
            return { files, truncated };
          }
        }
      }
    }
    files.sort();
    return { files, truncated };
  }

  async readFile(
    input: string,
    range: { startLine?: number; endLine?: number } = {},
  ): Promise<{ path: string; content: string; sha256: string; truncated: boolean }> {
    const resolved = await this.policy.resolveForRead(input);
    const details = await stat(resolved.absolute);
    if (!details.isFile()) throw new ToolBrokerError('read_file path must be a regular file.', 'INVALID_INPUT');
    if (details.size > this.maxFileScanBytes) {
      throw new ToolBrokerError(`File exceeds scan limit: ${resolved.relative}`, 'FILE_LIMIT');
    }
    const data = await readFile(resolved.absolute);
    const truncated = data.length > this.maxReadBytes;
    const bounded = data.subarray(0, this.maxReadBytes).toString('utf8');
    const lines = bounded.split('\n');
    const start = Math.max(1, Math.floor(range.startLine ?? 1));
    const end = Math.max(start, Math.floor(range.endLine ?? lines.length));
    return {
      path: resolved.relative,
      content: lines.slice(start - 1, end).join('\n'),
      sha256: sha256(data),
      truncated,
    };
  }

  async search(options: {
    query: string;
    path?: string;
    glob?: string;
    caseSensitive?: boolean;
  }): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
    if (!options.query) throw new ToolBrokerError('Search query cannot be empty.', 'INVALID_INPUT');
    const listed = await this.listFiles({
      ...(options.path !== undefined ? { path: options.path } : {}),
      ...(options.glob !== undefined ? { glob: options.glob } : {}),
    });
    const needle = options.caseSensitive ? options.query : options.query.toLocaleLowerCase();
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let scannedBytes = 0;
    let contentTruncated = false;

    for (const file of listed.files) {
      const resolved = await this.policy.resolveForRead(file);
      const details = await stat(resolved.absolute);
      if (!details.isFile()) continue;
      const bytesToRead = Math.min(details.size, this.maxReadBytes);
      if (scannedBytes + bytesToRead > this.maxSearchBytes) {
        return { matches, truncated: true };
      }
      scannedBytes += bytesToRead;
      if (details.size > bytesToRead) contentTruncated = true;
      const data = await readPrefix(resolved.absolute, bytesToRead);
      if (data.includes(0)) continue;
      const text = data.toString('utf8');
      for (const [index, line] of text.split('\n').entries()) {
        const candidate = options.caseSensitive ? line : line.toLocaleLowerCase();
        if (!candidate.includes(needle)) continue;
        matches.push({ path: file, line: index + 1, text: line.slice(0, 2_000) });
        if (matches.length >= this.maxSearchMatches) {
          return { matches, truncated: true };
        }
      }
    }
    return { matches, truncated: listed.truncated || contentTruncated };
  }

  async applyPatch(request: ApplyPatchRequest): Promise<unknown> {
    if (!request.operationId || request.operationId.length > 200) {
      throw new ToolBrokerError('A bounded operationId is required.', 'INVALID_INPUT');
    }
    if (request.operations.length === 0 || request.operations.length > 100) {
      throw new ToolBrokerError('Patch must contain 1-100 operations.', 'INVALID_INPUT');
    }
    let requestedBytes = 0;
    for (const rawOperation of request.operations) {
      const operation = rawOperation as unknown as Record<string, unknown>;
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
        throw new ToolBrokerError('Patch operations must be objects.', 'INVALID_INPUT');
      }
      boundedString(operation.path, 'operation.path', 4_096);
      if (operation.type === 'write') {
        requestedBytes += Buffer.byteLength(boundedString(operation.content, 'operation.content', this.maxPatchBytes));
        if (operation.expectedSha256 !== undefined && !validSha(operation.expectedSha256, true)) {
          throw new ToolBrokerError('expectedSha256 must be a SHA-256 hex digest or null.', 'INVALID_INPUT');
        }
      } else if (operation.type === 'replace') {
        const oldText = boundedString(operation.oldText, 'operation.oldText', this.maxPatchBytes);
        if (!oldText) throw new ToolBrokerError('operation.oldText cannot be empty.', 'INVALID_INPUT');
        requestedBytes +=
          Buffer.byteLength(oldText) +
          Buffer.byteLength(boundedString(operation.newText, 'operation.newText', this.maxPatchBytes));
        if (
          operation.expectedOccurrences !== undefined &&
          (typeof operation.expectedOccurrences !== 'number' ||
            !Number.isSafeInteger(operation.expectedOccurrences) ||
            operation.expectedOccurrences < 1 ||
            operation.expectedOccurrences > 1_000_000)
        ) {
          throw new ToolBrokerError('expectedOccurrences must be a bounded positive integer.', 'INVALID_INPUT');
        }
        if (operation.expectedSha256 !== undefined && !validSha(operation.expectedSha256)) {
          throw new ToolBrokerError('expectedSha256 must be a SHA-256 hex digest.', 'INVALID_INPUT');
        }
      } else if (operation.type === 'delete') {
        if (operation.expectedSha256 !== undefined && !validSha(operation.expectedSha256)) {
          throw new ToolBrokerError('expectedSha256 must be a SHA-256 hex digest.', 'INVALID_INPUT');
        }
      } else {
        throw new ToolBrokerError('Unsupported patch operation.', 'INVALID_INPUT');
      }
      if (requestedBytes > this.maxPatchBytes) {
        throw new ToolBrokerError('Patch exceeds the configured byte limit.', 'PATCH_LIMIT');
      }
    }
    const fingerprint = stableFingerprint({ actorId: this.actorId, request });
    const releaseReservation = await this.acquireMutationReservation(
      request.operationId,
      fingerprint,
    );
    try {
      const existing = await this.journal.lookup(request.operationId);
      if (existing) {
        return await this.replayExistingMutation(existing, fingerprint, request);
      }

      const prepared: Array<{
        operation: PatchOperation;
        absolute: string;
        relative: string;
        before?: Buffer;
        beforeMode?: number;
      }> = [];
      const resolvedPaths = new Set<string>();
      for (const operation of request.operations) {
        if (!operation || !['write', 'replace', 'delete'].includes(operation.type)) {
          throw new ToolBrokerError('Unsupported patch operation.', 'INVALID_INPUT');
        }
        const resolved = await this.policy.resolveForWrite(operation.path);
        if (resolvedPaths.has(resolved.relative)) {
          throw new ToolBrokerError(`Patch contains duplicate path: ${resolved.relative}`, 'INVALID_INPUT');
        }
        resolvedPaths.add(resolved.relative);
        let beforeStats: Stats | undefined;
        try {
          beforeStats = await stat(resolved.absolute);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (beforeStats && (!beforeStats.isFile() || beforeStats.size > this.maxPatchBytes)) {
          throw new ToolBrokerError(`Mutation target is not a bounded regular file: ${resolved.relative}`, 'PATCH_LIMIT');
        }
        const before = beforeStats ? await readFile(resolved.absolute) : undefined;
        const beforeMode = beforeStats ? beforeStats.mode & 0o777 : undefined;
        const expected = operation.expectedSha256;
        if (expected !== undefined) {
          const actual = before ? sha256(before) : null;
          if (actual !== expected) {
            throw new ToolBrokerError(`Precondition failed for ${resolved.relative}.`, 'PRECONDITION_FAILED');
          }
        }
        if (operation.type !== 'write' && !before) {
          throw new ToolBrokerError(`File does not exist: ${resolved.relative}`, 'PRECONDITION_FAILED');
        }
        prepared.push({
          operation,
          ...resolved,
          ...(before ? { before } : {}),
          ...(beforeMode !== undefined ? { beforeMode } : {}),
        });
      }

      const started: JournalEntry = {
        operationId: request.operationId,
        fingerprint,
        status: 'started',
        timestamp: new Date().toISOString(),
        request,
      };
      if (this.journal.reserve) {
        const reservationConflict = await this.journal.reserve(started);
        if (reservationConflict) {
          return await this.replayExistingMutation(
            reservationConflict,
            fingerprint,
            request,
          );
        }
      } else {
        await this.journal.append(started);
      }

      const applied: typeof prepared = [];
      try {
        const changed: Array<{ path: string; sha256: string | null }> = [];
        for (const item of prepared) {
          const { operation } = item;
          if (operation.type === 'delete') {
            await unlink(item.absolute);
            applied.push(item);
            changed.push({ path: item.relative, sha256: null });
            continue;
          }

          let content = operation.type === 'write' ? operation.content : '';
          if (operation.type === 'replace') {
            const previous = item.before?.toString('utf8') ?? '';
            const occurrences = countOccurrences(previous, operation.oldText);
            const expectedOccurrences = operation.expectedOccurrences ?? 1;
            if (occurrences !== expectedOccurrences) {
              throw new ToolBrokerError(
                `Expected ${expectedOccurrences} replacement target(s) in ${item.relative}, found ${occurrences}.`,
                'PRECONDITION_FAILED',
              );
            }
            content = previous.split(operation.oldText).join(operation.newText);
          }

          if (Buffer.byteLength(content) > this.maxPatchBytes) {
            throw new ToolBrokerError(`Patched file exceeds the byte limit: ${item.relative}`, 'PATCH_LIMIT');
          }

          await atomicWrite(item.absolute, content, item.beforeMode ?? 0o600);
          applied.push(item);
          changed.push({ path: item.relative, sha256: sha256(content) });
        }

        const result = { operationId: request.operationId, changed };
        await this.journal.append({
          operationId: request.operationId,
          fingerprint,
          status: 'completed',
          timestamp: new Date().toISOString(),
          result,
        });
        return result;
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        for (const item of [...applied].reverse()) {
          try {
            if (item.before) {
              await atomicWrite(item.absolute, item.before, item.beforeMode ?? 0o600);
            } else {
              try {
                await unlink(item.absolute);
              } catch (unlinkError) {
                if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
              }
            }
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        const failure =
          rollbackErrors.length > 0
            ? new AggregateError([error, ...rollbackErrors], 'Patch failed and could not be fully rolled back.')
            : error;
        try {
          await this.journal.append({
            operationId: request.operationId,
            fingerprint,
            status: 'failed',
            timestamp: new Date().toISOString(),
            error: failure instanceof Error ? failure.message : String(failure),
          });
        } catch (journalError) {
          throw new AggregateError([failure, journalError], 'Patch failed and its journal could not be finalized.');
        }
        throw failure;
      }
    } finally {
      releaseReservation();
    }
  }

  async gitDiff(signal?: AbortSignal): Promise<CommandResult> {
    return await runArgv(
      {
        id: '__git_diff',
        kind: 'check',
        argv: ['git', '--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--binary', '--'],
        timeoutMs: 30_000,
        maxOutputBytes: 2_000_000,
        allowedExitCodes: [0],
      },
      this.policy.root,
      signal,
    );
  }

  async runCheck(checkId: string, signal?: AbortSignal): Promise<CommandResult> {
    const command = this.commands.get(checkId);
    if (!command || command.kind !== 'check') {
      throw new ToolBrokerError(`Unknown approved check: ${checkId}`, 'COMMAND_NOT_APPROVED');
    }
    return await this.executeCommand(command, signal);
  }

  async runApprovedCommand(
    commandId: string,
    validatedArgs: readonly string[] = [],
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    const command = this.commands.get(commandId);
    if (!command || command.kind !== 'command') {
      throw new ToolBrokerError(`Unknown approved command: ${commandId}`, 'COMMAND_NOT_APPROVED');
    }
    const allowed = new Set(command.allowedArgs ?? []);
    if (validatedArgs.some(argument => !allowed.has(argument))) {
      throw new ToolBrokerError(
        `Command ${commandId} received an argument outside its kickoff allowlist.`,
        'COMMAND_ARGUMENT_NOT_APPROVED',
      );
    }
    return await this.executeCommand({
      ...command,
      argv: [...command.argv, ...validatedArgs] as [string, ...string[]],
    }, signal);
  }

  private async executeCommand(command: ApprovedCommand, signal?: AbortSignal): Promise<CommandResult> {
    let cwd = this.policy.root;
    if (command.cwd && command.cwd !== '.') {
      const resolved = await this.policy.resolveForRead(command.cwd);
      const cwdStat = await stat(resolved.absolute);
      if (!cwdStat.isDirectory()) throw new ToolBrokerError('Command cwd is not a directory.', 'INVALID_CONFIG');
      cwd = resolved.absolute;
    }
    if (command.network === true && !this.approvedNetworkCommandIds.has(command.id)) {
      throw new ToolBrokerError(
        `Network access for ${command.id} is pending explicit kickoff approval.`,
        'NETWORK_APPROVAL_REQUIRED',
      );
    }
    const privateTemp = await mkdtemp(path.join(tmpdir(), 'goalie-command-'));
    let sandboxed: ApprovedCommand;
    let result: CommandResult;
    try {
      sandboxed = await containedCommand(
        command,
        this.policy.root,
        cwd,
        this.policy.writeSet,
        this.policy.protectedPaths,
        [...SECRET_PATH_PATTERNS, ...this.policy.readProtectedPaths.filter(pattern => !this.policy.protectedPaths.includes(pattern))],
        command.network === true,
        privateTemp,
      );
      result = await runArgv(sandboxed, cwd, signal);
    } finally {
      await rm(privateTemp, { recursive: true, force: true });
    }
    const allowed = command.allowedExitCodes ?? [0];
    if (result.timedOut) throw new ToolBrokerError(`Command timed out: ${command.id}`, 'COMMAND_TIMEOUT');
    if (result.outputTruncated) {
      throw new ToolBrokerError(`Command exceeded output limit: ${command.id}`, 'OUTPUT_LIMIT');
    }
    if (result.exitCode === null || !allowed.includes(result.exitCode)) {
      if (
        (sandboxed.argv[0] === '/usr/bin/sandbox-exec' && result.stderr.includes('sandbox_apply')) ||
        (path.basename(sandboxed.argv[0]) === 'bwrap' && /^bwrap:/mu.test(result.stderr))
      ) {
        throw new ToolBrokerError(
          `OS command containment could not initialize for ${command.id}: ${result.stderr.trim()}`,
          'CONTAINMENT_UNAVAILABLE',
        );
      }
      throw new ToolBrokerError(
        `Command ${command.id} exited with ${result.exitCode ?? result.signal ?? 'unknown'}${
          result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 2_000)}` : ''
        }.`,
        'COMMAND_FAILED',
      );
    }
    return result;
  }
}
