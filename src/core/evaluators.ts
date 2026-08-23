import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  EvaluationRequestSchema,
  EvaluationResultSchema,
  EvaluatorDefinitionSchema,
  type Evidence,
  type EvaluationRequest,
  type EvaluationResult,
  type EvaluationResultInput,
  type EvaluatorDefinition,
} from './schemas.js';
import { resolveWithinWorkspace, sanitizeTerminalText } from './sanitize.js';

export type Evaluator = (
  request: EvaluationRequest,
) => EvaluationResultInput | Promise<EvaluationResultInput>;

export interface RegisteredEvaluator {
  readonly definition: Readonly<EvaluatorDefinition>;
  readonly evaluate: Evaluator;
}

export class EvaluatorRegistryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EvaluatorRegistryError';
  }
}

export class EvaluatorNotFoundError extends EvaluatorRegistryError {
  constructor(selector: string) {
    super(`Evaluator not found: ${selector}`);
    this.name = 'EvaluatorNotFoundError';
  }
}

function evaluatorKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function copyRequestWithSignal(
  request: EvaluationRequest,
  signal: AbortSignal,
): EvaluationRequest {
  return { ...request, signal };
}

/** Version-aware registry with deterministic resolution and failure results. */
export class EvaluatorRegistry {
  private readonly evaluators = new Map<string, RegisteredEvaluator>();

  register(
    definitionInput: EvaluatorDefinition,
    evaluator: Evaluator,
  ): () => void {
    const definition = Object.freeze(
      EvaluatorDefinitionSchema.parse(definitionInput),
    );
    const key = evaluatorKey(definition.id, definition.version);
    if (this.evaluators.has(key)) {
      throw new EvaluatorRegistryError(`Evaluator already registered: ${key}`);
    }
    const registered = Object.freeze({ definition, evaluate: evaluator });
    this.evaluators.set(key, registered);
    return () => {
      if (this.evaluators.get(key) === registered) this.evaluators.delete(key);
    };
  }

  has(id: string, version?: string): boolean {
    try {
      this.resolve(id, version);
      return true;
    } catch {
      return false;
    }
  }

  resolve(id: string, version?: string): RegisteredEvaluator {
    if (version !== undefined) {
      const exact = this.evaluators.get(evaluatorKey(id, version));
      if (!exact) throw new EvaluatorNotFoundError(evaluatorKey(id, version));
      return exact;
    }

    // An exact `id@version` selector is convenient in persisted check specs.
    const exactSelector = this.evaluators.get(id);
    if (exactSelector) return exactSelector;

    const matches = [...this.evaluators.values()].filter(
      (entry) => entry.definition.id === id,
    );
    if (matches.length === 0) throw new EvaluatorNotFoundError(id);
    if (matches.length > 1) {
      throw new EvaluatorRegistryError(
        `Evaluator ${id} has multiple versions; select one explicitly`,
      );
    }
    return matches[0]!;
  }

  list(): readonly Readonly<EvaluatorDefinition>[] {
    return [...this.evaluators.values()]
      .map((entry) => entry.definition)
      .sort(
        (left, right) =>
          left.id.localeCompare(right.id) ||
          left.version.localeCompare(right.version),
      );
  }

  async evaluate(
    selector: string,
    requestInput: EvaluationRequest,
    version?: string,
  ): Promise<EvaluationResult> {
    let registered: RegisteredEvaluator;
    try {
      registered = this.resolve(selector, version);
    } catch (error) {
      return EvaluationResultSchema.parse({
        status: 'error',
        summary: 'Evaluator resolution failed',
        error: errorMessage(error),
      });
    }

    let request: EvaluationRequest;
    try {
      request = EvaluationRequestSchema.parse(requestInput);
    } catch (error) {
      return EvaluationResultSchema.parse({
        status: 'error',
        summary: 'Evaluation request validation failed',
        error: errorMessage(error),
      });
    }

    const timeoutMs = request.check.timeoutMs;
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (request.signal?.aborted) forwardAbort();
    let timeout: NodeJS.Timeout | undefined;
    if (timeoutMs !== undefined) {
      timeout = setTimeout(
        () => controller.abort(new Error(`Evaluator timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timeout.unref?.();
    }

    try {
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? new Error('Evaluation aborted');
      }
      const evaluationPromise = Promise.resolve(
        registered.evaluate(copyRequestWithSignal(request, controller.signal)),
      );
      const result =
        timeoutMs === undefined && request.signal === undefined
          ? await evaluationPromise
          : await Promise.race([
              evaluationPromise,
              new Promise<never>((_resolve, reject) => {
                controller.signal.addEventListener(
                  'abort',
                  () =>
                    reject(
                      controller.signal.reason ?? new Error('Evaluation aborted'),
                    ),
                  { once: true },
                );
              }),
            ]);
      return EvaluationResultSchema.parse(result);
    } catch (error) {
      return EvaluationResultSchema.parse({
        status: 'error',
        summary: `Evaluator ${registered.definition.name} failed`,
        error: errorMessage(error),
        metadata: {
          evaluatorId: registered.definition.id,
          evaluatorVersion: registered.definition.version,
        },
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      request.signal?.removeEventListener('abort', forwardAbort);
    }
  }
}

export const CODING_EVALUATOR_VERSION = '1' as const;

/**
 * A command evaluator can select only an immutable kickoff command id and an
 * optional subset of arguments which the host has already allowlisted. It
 * deliberately has no executable, shell string, cwd, or environment field.
 */
export interface SafeCommandRunRequest {
  readonly commandId: string;
  readonly validatedArgs: readonly string[];
  readonly sessionId: string;
  readonly taskId: string;
  readonly checkId: string;
  readonly workspaceRoot: string;
  readonly signal: AbortSignal;
}

export interface SafeCommandRunResult {
  readonly commandId: string;
  readonly exitCode: number | null;
  readonly signal?: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs?: number;
  readonly timedOut?: boolean;
  readonly outputTruncated?: boolean;
}

export type SafeCommandRunner = (
  request: SafeCommandRunRequest,
) => SafeCommandRunResult | Promise<SafeCommandRunResult>;

export interface SafeGitDiffRequest {
  readonly sessionId: string;
  readonly taskId: string;
  readonly checkId: string;
  readonly workspaceRoot: string;
  readonly signal: AbortSignal;
}

export interface SafeGitDiffResult {
  readonly diff: string;
  readonly changedFiles?: readonly string[];
  readonly baseSha?: string;
  readonly headSha?: string;
}

/** A host callback such as ToolBroker.gitDiff; it receives no Git argv. */
export type SafeGitDiffProvider = (
  request: SafeGitDiffRequest,
) => SafeGitDiffResult | Promise<SafeGitDiffResult>;

export interface CodingEvaluatorOptions {
  readonly commandRunner?: SafeCommandRunner;
  readonly gitDiffProvider?: SafeGitDiffProvider;
  readonly now?: () => string;
  readonly maxArtifactBytes?: number;
  readonly maxTreeFiles?: number;
  readonly maxDiffBytes?: number;
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(value => !value.includes('\0'), 'Path cannot contain NUL bytes')
  .refine(value => !path.isAbsolute(value), 'Artifact paths must be workspace-relative')
  .refine(
    value => !value.split(/[\\/]+/u).includes('..'),
    'Artifact paths cannot traverse above the workspace',
  );

const commandConfigSchema = z
  .object({
    commandId: z.string().min(1).max(160).optional(),
    validatedArgs: z.array(z.string().max(1_024)).max(100).default([]),
    expectedExitCode: z.number().int().min(0).max(255).default(0),
    requireCompleteOutput: z.boolean().default(true),
  })
  .strict();

const gitDiffConfigSchema = z
  .object({
    expectedSha256: sha256Schema.optional(),
    allowEmpty: z.boolean().default(true),
    maxFiles: z.number().int().positive().optional(),
    maxAddedLines: z.number().int().nonnegative().optional(),
    maxDeletedLines: z.number().int().nonnegative().optional(),
  })
  .strict();

const artifactHashConfigSchema = z
  .object({
    path: boundedRelativePathSchema,
    mode: z.enum(['auto', 'file', 'tree']).default('auto'),
    expectedSha256: sha256Schema.optional(),
    exclude: z.array(boundedRelativePathSchema).max(1_000).default([]),
  })
  .strict();

const goldenOutputConfigSchema = z
  .object({
    actualPath: boundedRelativePathSchema.optional(),
    goldenPath: boundedRelativePathSchema.optional(),
    expected: z.string().max(2_000_000).optional(),
    normalizeLineEndings: z.boolean().default(false),
    trimFinalNewline: z.boolean().default(false),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.goldenPath !== undefined && config.expected !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['expected'],
        message: 'goldenPath and expected are mutually exclusive',
      });
    }
  });

const commandResultSchema = z
  .object({
    commandId: z.string().min(1).max(160),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable().optional(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().nonnegative().finite().optional(),
    timedOut: z.boolean().default(false),
    outputTruncated: z.boolean().default(false),
  })
  .strict();

const gitDiffResultSchema = z
  .object({
    diff: z.string(),
    changedFiles: z.array(boundedRelativePathSchema).max(100_000).optional(),
    baseSha: z.string().min(1).max(160).optional(),
    headSha: z.string().min(1).max(160).optional(),
  })
  .strict();

interface ArtifactHash {
  readonly digest: string;
  readonly files: number;
  readonly bytes: number;
  readonly mode: 'file' | 'tree';
}

interface DiffSummary {
  readonly files: readonly string[];
  readonly additions: number;
  readonly deletions: number;
}

interface GoldenCandidate {
  readonly actual?: string | Uint8Array;
  readonly expected?: string | Uint8Array;
}

const CODING_DEFINITIONS = [
  {
    id: 'approved-command',
    version: CODING_EVALUATOR_VERSION,
    name: 'Approved command',
    description: 'Runs one kickoff-approved command id through the host command runner.',
    deterministic: true,
  },
  {
    id: 'test',
    version: CODING_EVALUATOR_VERSION,
    name: 'Test suite',
    description: 'Runs the approved test command and records test evidence.',
    deterministic: true,
  },
  {
    id: 'build',
    version: CODING_EVALUATOR_VERSION,
    name: 'Build',
    description: 'Runs the approved build command and records build evidence.',
    deterministic: true,
  },
  {
    id: 'typecheck',
    version: CODING_EVALUATOR_VERSION,
    name: 'Type check',
    description: 'Runs the approved typecheck command and records type-check evidence.',
    deterministic: true,
  },
  {
    id: 'git-diff',
    version: CODING_EVALUATOR_VERSION,
    name: 'Git diff',
    description: 'Hashes and summarizes a diff supplied by the bounded host Git reader.',
    deterministic: true,
  },
  {
    id: 'artifact-hash',
    version: CODING_EVALUATOR_VERSION,
    name: 'Artifact hash',
    description: 'Computes a deterministic SHA-256 for a workspace file or tree.',
    deterministic: true,
  },
  {
    id: 'file-hash',
    version: CODING_EVALUATOR_VERSION,
    name: 'File hash',
    description: 'Computes a deterministic SHA-256 for one workspace file.',
    deterministic: true,
  },
  {
    id: 'tree-hash',
    version: CODING_EVALUATOR_VERSION,
    name: 'Tree hash',
    description: 'Computes a deterministic, path-sensitive SHA-256 for a workspace tree.',
    deterministic: true,
  },
  {
    id: 'golden-output',
    version: CODING_EVALUATOR_VERSION,
    name: 'Golden output',
    description: 'Compares an artifact or candidate output with an immutable golden value.',
    deterministic: true,
  },
] as const satisfies readonly EvaluatorDefinition[];

export const CODING_EVALUATOR_DEFINITIONS: readonly Readonly<EvaluatorDefinition>[] =
  Object.freeze(CODING_DEFINITIONS.map(definition => Object.freeze({ ...definition })));

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function compactText(value: string, limit = 7_900): string {
  return sanitizeTerminalText(value, limit) || '(no output)';
}

function stableStringList(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function evidenceId(request: EvaluationRequest, source: string, digest: string): string {
  const key = sha256(
    `${request.sessionId}\0${request.task.id}\0${request.check.id}\0${source}\0${digest}`,
  );
  return `evidence:${key.slice(0, 32)}`;
}

function makeEvidence(
  request: EvaluationRequest,
  options: CodingEvaluatorOptions,
  input: {
    kind: Evidence['kind'];
    source: string;
    summary: string;
    digest: string;
    content?: unknown;
    metadata?: Record<string, unknown>;
  },
): Evidence {
  return {
    id: evidenceId(request, input.source, input.digest),
    taskId: request.task.id,
    checkId: request.check.id,
    kind: input.kind,
    source: input.source,
    summary: compactText(input.summary),
    ...(input.content === undefined ? {} : { content: input.content }),
    digest: input.digest,
    metadata: input.metadata ?? {},
    createdAt: options.now?.() ?? new Date().toISOString(),
  };
}

function verdictCriteria(
  request: EvaluationRequest,
  passed: boolean,
  rationale: string,
  evidence: Evidence,
): EvaluationResultInput['criteria'] {
  return request.check.criterionIds.map(criterionId => ({
    criterionId,
    status: passed ? 'passed' as const : 'failed' as const,
    score: passed ? 1 : 0,
    rationale: compactText(rationale),
    evidenceIds: [evidence.id],
  }));
}

function checkedAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new Error('Evaluation aborted');
  }
}

function commandEvaluator(
  options: CodingEvaluatorOptions,
  defaultCommandId?: string,
  kind: Evidence['kind'] = 'command',
): Evaluator {
  return async request => {
    const config = commandConfigSchema.parse(request.check.config);
    const commandId = config.commandId ?? defaultCommandId;
    if (!commandId) {
      throw new Error('check.config.commandId is required');
    }
    if (!options.commandRunner) {
      throw new Error('The host did not configure a safe approved-command runner');
    }
    const signal = request.signal ?? new AbortController().signal;
    checkedAbort(signal);
    const result = commandResultSchema.parse(
      await options.commandRunner({
        commandId,
        validatedArgs: config.validatedArgs,
        sessionId: request.sessionId,
        taskId: request.task.id,
        checkId: request.check.id,
        workspaceRoot: request.spec.workspaceRoot,
        signal,
      }),
    );
    if (result.commandId !== commandId) {
      throw new Error(
        `Safe command runner returned ${result.commandId} for requested command ${commandId}`,
      );
    }
    const complete = !result.timedOut && (!config.requireCompleteOutput || !result.outputTruncated);
    const passed = result.exitCode === config.expectedExitCode && complete;
    const digest = sha256(
      JSON.stringify({
        commandId,
        exitCode: result.exitCode,
        signal: result.signal ?? null,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        outputTruncated: result.outputTruncated,
      }),
    );
    const output = compactText(
      [result.stdout, result.stderr].filter(Boolean).join('\n'),
      7_400,
    );
    const stdout = sanitizeTerminalText(result.stdout, 32_000);
    const stderr = sanitizeTerminalText(result.stderr, 16_000);
    const summary = passed
      ? `${commandId} passed with exit code ${result.exitCode}.`
      : `${commandId} failed: exit=${String(result.exitCode)}, timedOut=${String(result.timedOut)}, outputTruncated=${String(result.outputTruncated)}.`;
    const evidence = makeEvidence(request, options, {
      kind,
      source: `approved-command:${commandId}`,
      summary: `${summary}\n${output}`,
      digest,
      content: { stdout, stderr },
      metadata: {
        commandId,
        exitCode: result.exitCode,
        signal: result.signal ?? null,
        durationMs: result.durationMs ?? null,
        timedOut: result.timedOut,
        outputTruncated: result.outputTruncated,
      },
    });
    return {
      status: passed ? 'passed' : 'failed',
      score: passed ? 1 : 0,
      summary,
      criteria: verdictCriteria(request, passed, summary, evidence),
      evidence: [evidence],
      metadata: {
        evaluatorVersion: CODING_EVALUATOR_VERSION,
        commandId,
        resultDigest: digest,
      },
    };
  };
}

function diffSummary(diff: string, suppliedFiles?: readonly string[]): DiffSummary {
  let additions = 0;
  let deletions = 0;
  const derivedFiles: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
    if (line.startsWith('+++ b/')) derivedFiles.push(line.slice(6));
    if (line.startsWith('--- a/')) derivedFiles.push(line.slice(6));
    if (line.startsWith('rename to ')) derivedFiles.push(line.slice('rename to '.length));
    const header = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (header?.[2]) derivedFiles.push(header[2]);
  }
  return {
    files: stableStringList(suppliedFiles ?? derivedFiles),
    additions,
    deletions,
  };
}

function gitDiffEvaluator(options: CodingEvaluatorOptions): Evaluator {
  return async request => {
    const config = gitDiffConfigSchema.parse(request.check.config);
    if (!options.gitDiffProvider) {
      throw new Error('The host did not configure a safe Git diff provider');
    }
    const signal = request.signal ?? new AbortController().signal;
    checkedAbort(signal);
    const result = gitDiffResultSchema.parse(
      await options.gitDiffProvider({
        sessionId: request.sessionId,
        taskId: request.task.id,
        checkId: request.check.id,
        workspaceRoot: request.spec.workspaceRoot,
        signal,
      }),
    );
    const maxDiffBytes = options.maxDiffBytes ?? 2_000_000;
    const bytes = Buffer.byteLength(result.diff);
    if (bytes > maxDiffBytes) {
      throw new Error(`Git diff exceeds evaluator byte limit (${bytes} > ${maxDiffBytes})`);
    }
    const digest = sha256(result.diff);
    const summary = diffSummary(result.diff, result.changedFiles);
    const violations: string[] = [];
    if (!config.allowEmpty && bytes === 0) violations.push('diff is empty');
    if (config.expectedSha256 && config.expectedSha256 !== digest) {
      violations.push('diff hash does not match expectedSha256');
    }
    if (config.maxFiles !== undefined && summary.files.length > config.maxFiles) {
      violations.push(`${summary.files.length} files exceeds maxFiles ${config.maxFiles}`);
    }
    if (config.maxAddedLines !== undefined && summary.additions > config.maxAddedLines) {
      violations.push(`${summary.additions} additions exceeds ${config.maxAddedLines}`);
    }
    if (config.maxDeletedLines !== undefined && summary.deletions > config.maxDeletedLines) {
      violations.push(`${summary.deletions} deletions exceeds ${config.maxDeletedLines}`);
    }
    const passed = violations.length === 0;
    const resultSummary = passed
      ? `Diff verified: ${summary.files.length} file(s), +${summary.additions}/-${summary.deletions}, sha256 ${digest}.`
      : `Diff verification failed: ${violations.join('; ')}.`;
    const evidence = makeEvidence(request, options, {
      kind: 'diff',
      source: 'host-git-diff',
      summary: resultSummary,
      digest,
      content: {
        files: summary.files.slice(0, 1_000),
        omittedFiles: Math.max(0, summary.files.length - 1_000),
        additions: summary.additions,
        deletions: summary.deletions,
      },
      metadata: {
        bytes,
        baseSha: result.baseSha ?? null,
        headSha: result.headSha ?? null,
      },
    });
    return {
      status: passed ? 'passed' : 'failed',
      score: passed ? 1 : 0,
      summary: resultSummary,
      criteria: verdictCriteria(request, passed, resultSummary, evidence),
      evidence: [evidence],
      metadata: { evaluatorVersion: CODING_EVALUATOR_VERSION, diffDigest: digest },
    };
  };
}

function relativeToRealRoot(rootReal: string, candidateReal: string): string {
  const fromRoot = path.relative(rootReal, candidateReal);
  if (
    fromRoot === '..' ||
    fromRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(fromRoot)
  ) {
    throw new Error('Artifact path resolves outside the workspace');
  }
  return fromRoot;
}

function isSensitiveArtifactPath(workspaceRelative: string): boolean {
  const segments = workspaceRelative.split(path.sep).filter(Boolean);
  if (segments.includes('.git')) return true;
  if (segments[0] === '.goalie') return true;
  return segments.some(segment => segment === '.env' || segment.startsWith('.env.'));
}

async function resolveArtifactPath(
  workspaceRoot: string,
  requestedPath: string,
): Promise<{ rootReal: string; absolute: string; relative: string }> {
  const lexical = resolveWithinWorkspace(workspaceRoot, requestedPath);
  const rootReal = await realpath(workspaceRoot);
  const targetReal = await realpath(lexical);
  const relative = relativeToRealRoot(rootReal, targetReal);
  if (isSensitiveArtifactPath(relative)) {
    throw new Error(`Artifact path is protected: ${requestedPath}`);
  }

  // A symlink can redirect an apparently safe lexical path. Evaluator evidence
  // rejects every symlink component rather than hashing the redirected target.
  const lexicalRelative = path.relative(path.resolve(workspaceRoot), lexical);
  let cursor = path.resolve(workspaceRoot);
  for (const segment of lexicalRelative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if ((await lstat(cursor)).isSymbolicLink()) {
      throw new Error(`Artifact paths cannot contain symlinks: ${requestedPath}`);
    }
  }
  return { rootReal, absolute: targetReal, relative };
}

function pathIsExcluded(relative: string, excludes: readonly string[]): boolean {
  return excludes.some(excluded => {
    const normalized = path.normalize(excluded);
    return relative === normalized || relative.startsWith(`${normalized}${path.sep}`);
  });
}

async function hashFile(
  absolute: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<ArtifactHash> {
  checkedAbort(signal);
  const info = await lstat(absolute);
  if (!info.isFile()) throw new Error('Artifact is not a regular file');
  if (info.size > maxBytes) {
    throw new Error(`Artifact exceeds evaluator byte limit (${info.size} > ${maxBytes})`);
  }
  const bytes = await readFile(absolute);
  checkedAbort(signal);
  return { digest: sha256(bytes), files: 1, bytes: bytes.byteLength, mode: 'file' };
}

async function hashTree(
  rootReal: string,
  treeRoot: string,
  excludes: readonly string[],
  maxBytes: number,
  maxFiles: number,
  signal: AbortSignal,
): Promise<ArtifactHash> {
  const entries: Array<{ path: string; digest: string; bytes: number }> = [];
  let totalBytes = 0;

  const visit = async (directory: string): Promise<void> => {
    checkedAbort(signal);
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const child of children) {
      checkedAbort(signal);
      const absolute = path.join(directory, child.name);
      const workspaceRelative = relativeToRealRoot(rootReal, absolute);
      const treeRelative = path.relative(treeRoot, absolute);
      if (
        isSensitiveArtifactPath(workspaceRelative) ||
        pathIsExcluded(workspaceRelative, excludes) ||
        pathIsExcluded(treeRelative, excludes)
      ) continue;
      if (child.isSymbolicLink()) {
        throw new Error(`Artifact trees cannot contain symlinks: ${workspaceRelative}`);
      }
      if (child.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!child.isFile()) {
        throw new Error(`Artifact trees cannot contain special files: ${workspaceRelative}`);
      }
      if (entries.length >= maxFiles) {
        throw new Error(`Artifact tree exceeds file limit (${maxFiles})`);
      }
      const info = await lstat(absolute);
      totalBytes += info.size;
      if (totalBytes > maxBytes) {
        throw new Error(`Artifact tree exceeds byte limit (${totalBytes} > ${maxBytes})`);
      }
      const bytes = await readFile(absolute);
      entries.push({
        path: treeRelative.split(path.sep).join('/'),
        digest: sha256(bytes),
        bytes: bytes.byteLength,
      });
    }
  };

  await visit(treeRoot);
  const hash = createHash('sha256');
  hash.update('goalie-artifact-tree-v1\0');
  for (const entry of entries) {
    hash.update(`file\0${entry.path}\0${entry.bytes}\0${entry.digest}\0`);
  }
  return {
    digest: hash.digest('hex'),
    files: entries.length,
    bytes: totalBytes,
    mode: 'tree',
  };
}

function artifactHashEvaluator(
  options: CodingEvaluatorOptions,
  forcedMode?: 'file' | 'tree',
): Evaluator {
  return async request => {
    const config = artifactHashConfigSchema.parse(request.check.config);
    const resolved = await resolveArtifactPath(request.spec.workspaceRoot, config.path);
    const signal = request.signal ?? new AbortController().signal;
    checkedAbort(signal);
    const info = await lstat(resolved.absolute);
    const mode = forcedMode ?? (config.mode === 'auto' ? (info.isDirectory() ? 'tree' : 'file') : config.mode);
    if (forcedMode && config.mode !== 'auto' && config.mode !== forcedMode) {
      throw new Error(`${forcedMode}-hash cannot evaluate mode ${config.mode}`);
    }
    const maxBytes = options.maxArtifactBytes ?? 64 * 1024 * 1024;
    const artifact = mode === 'file'
      ? await hashFile(resolved.absolute, maxBytes, signal)
      : await hashTree(
          resolved.rootReal,
          resolved.absolute,
          config.exclude.map(item => path.normalize(item)),
          maxBytes,
          options.maxTreeFiles ?? 10_000,
          signal,
        );
    const passed = config.expectedSha256 === undefined || config.expectedSha256 === artifact.digest;
    const resultSummary = passed
      ? `${artifact.mode} artifact ${config.path}: ${artifact.files} file(s), ${artifact.bytes} byte(s), sha256 ${artifact.digest}.`
      : `${artifact.mode} artifact ${config.path} hash mismatch: expected ${config.expectedSha256}, received ${artifact.digest}.`;
    const evidence = makeEvidence(request, options, {
      kind: 'file',
      source: `${artifact.mode}-hash:${sha256(config.path).slice(0, 24)}`,
      summary: resultSummary,
      digest: artifact.digest,
      content: { path: config.path, mode: artifact.mode, files: artifact.files, bytes: artifact.bytes },
      metadata: {
        expectedSha256: config.expectedSha256 ?? null,
        matchesExpected: passed,
      },
    });
    return {
      status: passed ? 'passed' : 'failed',
      score: passed ? 1 : 0,
      summary: resultSummary,
      criteria: verdictCriteria(request, passed, resultSummary, evidence),
      evidence: [evidence],
      metadata: {
        evaluatorVersion: CODING_EVALUATOR_VERSION,
        artifactDigest: artifact.digest,
        mode: artifact.mode,
      },
    };
  };
}

async function readGoldenSource(
  request: EvaluationRequest,
  requestedPath: string,
  options: CodingEvaluatorOptions,
): Promise<Buffer> {
  const resolved = await resolveArtifactPath(request.spec.workspaceRoot, requestedPath);
  const info = await lstat(resolved.absolute);
  const maxBytes = options.maxArtifactBytes ?? 64 * 1024 * 1024;
  if (!info.isFile()) throw new Error(`Golden comparison source is not a file: ${requestedPath}`);
  if (info.size > maxBytes) {
    throw new Error(`Golden comparison source exceeds byte limit (${info.size} > ${maxBytes})`);
  }
  return await readFile(resolved.absolute);
}

function bytesFromCandidate(value: unknown, field: keyof GoldenCandidate): Buffer | undefined {
  const selected =
    value && typeof value === 'object' && !ArrayBuffer.isView(value)
      ? (value as GoldenCandidate)[field]
      : field === 'actual'
        ? value
        : undefined;
  if (typeof selected === 'string') return Buffer.from(selected);
  if (selected instanceof Uint8Array) return Buffer.from(selected);
  return undefined;
}

function normalizeGoldenBytes(
  value: Buffer,
  config: z.infer<typeof goldenOutputConfigSchema>,
): Buffer {
  if (!config.normalizeLineEndings && !config.trimFinalNewline) return value;
  let text = value.toString('utf8');
  if (config.normalizeLineEndings) text = text.replace(/\r\n?/gu, '\n');
  if (config.trimFinalNewline) text = text.replace(/\n$/u, '');
  return Buffer.from(text);
}

function firstMismatch(left: Uint8Array, right: Uint8Array): number | null {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return left.byteLength === right.byteLength ? null : length;
}

function goldenOutputEvaluator(options: CodingEvaluatorOptions): Evaluator {
  return async request => {
    const config = goldenOutputConfigSchema.parse(request.check.config);
    const signal = request.signal ?? new AbortController().signal;
    checkedAbort(signal);
    const actualRaw = config.actualPath
      ? await readGoldenSource(request, config.actualPath, options)
      : bytesFromCandidate(request.candidate, 'actual');
    const expectedRaw = config.goldenPath
      ? await readGoldenSource(request, config.goldenPath, options)
      : config.expected !== undefined
        ? Buffer.from(config.expected)
        : bytesFromCandidate(request.candidate, 'expected');
    if (!actualRaw) {
      throw new Error('Golden comparison requires check.config.actualPath or a string/byte candidate');
    }
    if (!expectedRaw) throw new Error('Golden comparison expected output is unavailable');
    const maxBytes = options.maxArtifactBytes ?? 64 * 1024 * 1024;
    if (actualRaw.byteLength > maxBytes || expectedRaw.byteLength > maxBytes) {
      throw new Error(`Golden comparison exceeds evaluator byte limit (${maxBytes})`);
    }
    checkedAbort(signal);
    const actual = normalizeGoldenBytes(actualRaw, config);
    const expected = normalizeGoldenBytes(expectedRaw, config);
    const actualDigest = sha256(actual);
    const expectedDigest = sha256(expected);
    const mismatchAt = firstMismatch(actual, expected);
    const passed = mismatchAt === null;
    const resultSummary = passed
      ? `Golden output matched (${actual.byteLength} byte(s), sha256 ${actualDigest}).`
      : `Golden output mismatch at byte ${mismatchAt}: actual ${actual.byteLength} byte(s) sha256 ${actualDigest}; expected ${expected.byteLength} byte(s) sha256 ${expectedDigest}.`;
    const evidenceDigest = sha256(`${actualDigest}\0${expectedDigest}`);
    const evidence = makeEvidence(request, options, {
      kind: 'file',
      source: 'golden-output',
      summary: resultSummary,
      digest: evidenceDigest,
      content: {
        actualDigest,
        expectedDigest,
        actualBytes: actual.byteLength,
        expectedBytes: expected.byteLength,
        mismatchAt,
      },
      metadata: {
        normalizeLineEndings: config.normalizeLineEndings,
        trimFinalNewline: config.trimFinalNewline,
      },
    });
    return {
      status: passed ? 'passed' : 'failed',
      score: passed ? 1 : 0,
      summary: resultSummary,
      criteria: verdictCriteria(request, passed, resultSummary, evidence),
      evidence: [evidence],
      metadata: {
        evaluatorVersion: CODING_EVALUATOR_VERSION,
        actualDigest,
        expectedDigest,
      },
    };
  };
}

/** Register the complete V1 coding evaluator set into an existing registry. */
export function registerCodingEvaluators(
  registry: EvaluatorRegistry,
  options: CodingEvaluatorOptions = {},
): () => void {
  const registrations: readonly [EvaluatorDefinition, Evaluator][] = [
    [CODING_DEFINITIONS[0], commandEvaluator(options)],
    [CODING_DEFINITIONS[1], commandEvaluator(options, 'test', 'test')],
    [CODING_DEFINITIONS[2], commandEvaluator(options, 'build')],
    [CODING_DEFINITIONS[3], commandEvaluator(options, 'typecheck')],
    [CODING_DEFINITIONS[4], gitDiffEvaluator(options)],
    [CODING_DEFINITIONS[5], artifactHashEvaluator(options)],
    [CODING_DEFINITIONS[6], artifactHashEvaluator(options, 'file')],
    [CODING_DEFINITIONS[7], artifactHashEvaluator(options, 'tree')],
    [CODING_DEFINITIONS[8], goldenOutputEvaluator(options)],
  ];
  const disposers: Array<() => void> = [];
  try {
    for (const [definition, evaluator] of registrations) {
      disposers.push(registry.register(definition, evaluator));
    }
  } catch (error) {
    for (const dispose of [...disposers].reverse()) dispose();
    throw error;
  }
  return () => {
    for (const dispose of [...disposers].reverse()) dispose();
  };
}

/** Create a ready-to-use registry with every concrete V1 coding evaluator. */
export function createCodingEvaluatorRegistry(
  options: CodingEvaluatorOptions = {},
): EvaluatorRegistry {
  const registry = new EvaluatorRegistry();
  registerCodingEvaluators(registry, options);
  return registry;
}
