import { join } from 'node:path';
import {
  ActivatedPlaybookPayloadSchema,
  ActivatedPlaybookRecordSchema,
  BenchmarkRunSchema,
  PlaybookActivationInputSchema,
  PlaybookBenchmarkInputSchema,
  PlaybookBenchmarkPayloadSchema,
  PlaybookBenchmarkRecordSchema,
  PlaybookCandidateDraftSchema,
  PlaybookCandidatePayloadSchema,
  PlaybookCandidateRecordSchema,
  PlaybookDigestSchema,
  PlaybookGuidanceSchema,
  PlaybookReviewInputSchema,
  PlaybookReviewPayloadSchema,
  PlaybookReviewRecordSchema,
  type ActivatedPlaybookRecord,
  type BenchmarkPrimaryMetric,
  type BenchmarkRun,
  type PlaybookActivationInput,
  type PlaybookBenchmarkInput,
  type PlaybookBenchmarkRecord,
  type PlaybookCandidateDraft,
  type PlaybookCandidatePayload,
  type PlaybookCandidateRecord,
  type PlaybookGuidance,
  type PlaybookReviewInput,
  type PlaybookReviewRecord,
} from './schemas.js';
import {
  PlaybookEligibilityError,
  PlaybookIntegrityError,
  digestCanonical,
  readJsonFile,
  resolveContainedDirectory,
  resolveExistingContainedDirectory,
  writeImmutableJson,
} from './integrity.js';

export interface QuarantineCandidateOptions {
  storeRoot: string;
  draft: unknown;
  createdAt?: string;
}

export interface RecordBenchmarkOptions {
  storeRoot: string;
  benchmark: unknown;
}

export interface RecordReviewOptions {
  storeRoot: string;
  review: unknown;
}

export interface ActivatePlaybookOptions {
  storeRoot: string;
  projectRoot: string;
  activation: unknown;
}

function nowIso(): string {
  return new Date().toISOString();
}

function timestampAfter(requested: string | undefined, after: string): string {
  if (requested !== undefined) {
    if (Date.parse(requested) <= Date.parse(after)) {
      throw new PlaybookEligibilityError(
        'Lifecycle evidence must be recorded after the artifact it reviews',
      );
    }
    return requested;
  }
  const now = Date.now();
  const afterMs = Date.parse(after);
  return new Date(Math.max(now, afterMs + 1)).toISOString();
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeDraft(
  draft: PlaybookCandidateDraft,
  createdAt: string,
): PlaybookCandidatePayload {
  return PlaybookCandidatePayloadSchema.parse({
    schemaVersion: 1,
    kind: 'playbook_candidate',
    policyScope: 'procedure_only',
    ...draft,
    sourceBuilderProviderFamilies: sortedUnique(
      draft.sourceBuilderProviderFamilies,
    ),
    sourceBuilderSessionIds: sortedUnique(draft.sourceBuilderSessionIds),
    evidenceHashes: sortedUnique(draft.evidenceHashes),
    createdAt,
  });
}

function candidateDirectorySegments(candidateDigest: string): string[] {
  return ['quarantine', PlaybookDigestSchema.parse(candidateDigest)];
}

function benchmarkDirectorySegments(candidateDigest: string): string[] {
  return [...candidateDirectorySegments(candidateDigest), 'benchmarks'];
}

function reviewDirectorySegments(candidateDigest: string): string[] {
  return [...candidateDirectorySegments(candidateDigest), 'reviews'];
}

export function benchmarkShowsImprovement(
  baseline: BenchmarkRun,
  candidate: BenchmarkRun,
  primaryMetric: BenchmarkPrimaryMetric,
): boolean {
  if (baseline.status !== 'completed' || candidate.status !== 'completed') {
    return false;
  }
  const baselineValue = baseline.metrics[primaryMetric.metricId];
  const candidateValue = candidate.metrics[primaryMetric.metricId];
  if (baselineValue === undefined || candidateValue === undefined) return false;
  const delta =
    primaryMetric.direction === 'higher'
      ? candidateValue - baselineValue
      : baselineValue - candidateValue;
  return delta >= primaryMetric.minimumDelta;
}

export async function quarantinePlaybookCandidate(
  options: QuarantineCandidateOptions,
): Promise<PlaybookCandidateRecord> {
  const draft = PlaybookCandidateDraftSchema.parse(options.draft);
  const createdAt = options.createdAt ?? nowIso();
  const payload = normalizeDraft(draft, createdAt);
  const record = PlaybookCandidateRecordSchema.parse({
    payload,
    digest: digestCanonical(payload),
  });
  const directory = await resolveContainedDirectory(
    options.storeRoot,
    candidateDirectorySegments(record.digest),
  );
  await writeImmutableJson(directory, 'candidate.json', record);
  return record;
}

export async function loadPlaybookCandidate(
  storeRoot: string,
  candidateDigest: string,
): Promise<PlaybookCandidateRecord> {
  const requestedDigest = PlaybookDigestSchema.parse(candidateDigest);
  const directory = await resolveExistingContainedDirectory(
    storeRoot,
    candidateDirectorySegments(requestedDigest),
  );
  const record = PlaybookCandidateRecordSchema.parse(
    await readJsonFile(join(directory, 'candidate.json')),
  );
  const actual = digestCanonical(record.payload);
  if (record.digest !== requestedDigest || record.digest !== actual) {
    throw new PlaybookIntegrityError('Playbook candidate digest mismatch');
  }
  return record;
}

export async function recordPlaybookBenchmark(
  options: RecordBenchmarkOptions,
): Promise<PlaybookBenchmarkRecord> {
  const input = PlaybookBenchmarkInputSchema.parse(options.benchmark);
  const candidateRecord = await loadPlaybookCandidate(
    options.storeRoot,
    input.candidateDigest,
  );
  const createdAt = timestampAfter(input.createdAt, candidateRecord.payload.createdAt);
  const baseline = BenchmarkRunSchema.parse({
    ...input.baseline,
    evidenceHashes: sortedUnique(input.baseline.evidenceHashes),
  });
  const candidate = BenchmarkRunSchema.parse({
    ...input.candidate,
    evidenceHashes: sortedUnique(input.candidate.evidenceHashes),
  });
  const payload = PlaybookBenchmarkPayloadSchema.parse({
    schemaVersion: 1,
    kind: 'playbook_benchmark',
    candidateDigest: input.candidateDigest,
    benchmarkId: input.benchmarkId,
    conditions: {
      ...input.conditions,
      evaluatorIds: sortedUnique(input.conditions.evaluatorIds),
    },
    primaryMetric: input.primaryMetric,
    baseline,
    candidate,
    improved: benchmarkShowsImprovement(
      baseline,
      candidate,
      input.primaryMetric,
    ),
    createdAt,
  });
  const record = PlaybookBenchmarkRecordSchema.parse({
    payload,
    digest: digestCanonical(payload),
  });
  const directory = await resolveContainedDirectory(
    options.storeRoot,
    benchmarkDirectorySegments(input.candidateDigest),
  );
  await writeImmutableJson(directory, `${record.digest}.json`, record);
  return record;
}

export async function loadPlaybookBenchmark(
  storeRoot: string,
  candidateDigest: string,
  benchmarkDigest: string,
): Promise<PlaybookBenchmarkRecord> {
  const requestedDigest = PlaybookDigestSchema.parse(benchmarkDigest);
  const directory = await resolveExistingContainedDirectory(
    storeRoot,
    benchmarkDirectorySegments(candidateDigest),
  );
  const record = PlaybookBenchmarkRecordSchema.parse(
    await readJsonFile(join(directory, `${requestedDigest}.json`)),
  );
  const actual = digestCanonical(record.payload);
  const recalculatedImprovement = benchmarkShowsImprovement(
    record.payload.baseline,
    record.payload.candidate,
    record.payload.primaryMetric,
  );
  if (
    record.digest !== requestedDigest ||
    record.digest !== actual ||
    record.payload.candidateDigest !== candidateDigest ||
    record.payload.improved !== recalculatedImprovement
  ) {
    throw new PlaybookIntegrityError('Playbook benchmark digest or result mismatch');
  }
  return record;
}

export async function recordPlaybookReview(
  options: RecordReviewOptions,
): Promise<PlaybookReviewRecord> {
  const input = PlaybookReviewInputSchema.parse(options.review);
  const candidate = await loadPlaybookCandidate(
    options.storeRoot,
    input.candidateDigest,
  );
  const benchmark = await loadPlaybookBenchmark(
    options.storeRoot,
    input.candidateDigest,
    input.benchmarkDigest,
  );

  if (
    candidate.payload.sourceBuilderProviderFamilies.includes(
      input.reviewerProviderFamily,
    )
  ) {
    throw new PlaybookEligibilityError(
      'Playbook review must use a provider family different from every source builder',
    );
  }
  if (
    candidate.payload.sourceBuilderSessionIds.includes(input.reviewerSessionId)
  ) {
    throw new PlaybookEligibilityError(
      'Playbook review must use a fresh provider session',
    );
  }

  const createdAt = timestampAfter(input.createdAt, benchmark.payload.createdAt);
  const payload = PlaybookReviewPayloadSchema.parse({
    schemaVersion: 1,
    kind: 'playbook_review',
    independent: true,
    ...input,
    evidenceHashes: sortedUnique(input.evidenceHashes),
    createdAt,
  });
  const record = PlaybookReviewRecordSchema.parse({
    payload,
    digest: digestCanonical(payload),
  });
  const directory = await resolveContainedDirectory(
    options.storeRoot,
    reviewDirectorySegments(input.candidateDigest),
  );
  await writeImmutableJson(directory, `${record.digest}.json`, record);
  return record;
}

export async function loadPlaybookReview(
  storeRoot: string,
  candidateDigest: string,
  reviewDigest: string,
): Promise<PlaybookReviewRecord> {
  const requestedDigest = PlaybookDigestSchema.parse(reviewDigest);
  const directory = await resolveExistingContainedDirectory(
    storeRoot,
    reviewDirectorySegments(candidateDigest),
  );
  const record = PlaybookReviewRecordSchema.parse(
    await readJsonFile(join(directory, `${requestedDigest}.json`)),
  );
  const actual = digestCanonical(record.payload);
  if (
    record.digest !== requestedDigest ||
    record.digest !== actual ||
    record.payload.candidateDigest !== candidateDigest
  ) {
    throw new PlaybookIntegrityError('Playbook review digest mismatch');
  }
  return record;
}

function assertPromotionEligible(
  activation: PlaybookActivationInput,
  candidate: PlaybookCandidateRecord,
  benchmark: PlaybookBenchmarkRecord,
  review: PlaybookReviewRecord,
): void {
  if (!activation.confirmedByUserOrHost) {
    throw new PlaybookEligibilityError(
      'Explicit user or host activation confirmation is required',
    );
  }
  if (!benchmark.payload.improved) {
    throw new PlaybookEligibilityError(
      'Playbook candidate did not improve the matched held-out benchmark',
    );
  }
  if (review.payload.decision !== 'pass') {
    throw new PlaybookEligibilityError(
      'Independent playbook review did not pass',
    );
  }
  if (review.payload.benchmarkDigest !== benchmark.digest) {
    throw new PlaybookEligibilityError(
      'Independent review does not cover the selected benchmark',
    );
  }
  if (
    candidate.payload.sourceBuilderProviderFamilies.includes(
      review.payload.reviewerProviderFamily,
    )
  ) {
    throw new PlaybookEligibilityError(
      'Independent review provider overlaps a source builder provider',
    );
  }
  if (
    candidate.payload.sourceBuilderSessionIds.includes(
      review.payload.reviewerSessionId,
    )
  ) {
    throw new PlaybookEligibilityError('Independent review session is not fresh');
  }
}

export async function activatePlaybook(
  options: ActivatePlaybookOptions,
): Promise<ActivatedPlaybookRecord> {
  const activation = PlaybookActivationInputSchema.parse(options.activation);
  const candidate = await loadPlaybookCandidate(
    options.storeRoot,
    activation.candidateDigest,
  );
  const benchmark = await loadPlaybookBenchmark(
    options.storeRoot,
    activation.candidateDigest,
    activation.benchmarkDigest,
  );
  const review = await loadPlaybookReview(
    options.storeRoot,
    activation.candidateDigest,
    activation.reviewDigest,
  );
  assertPromotionEligible(activation, candidate, benchmark, review);
  const activatedAt = timestampAfter(
    activation.activatedAt,
    review.payload.createdAt,
  );
  const payload = ActivatedPlaybookPayloadSchema.parse({
    schemaVersion: 1,
    kind: 'activated_playbook',
    policyScope: 'procedure_only',
    candidateDigest: candidate.digest,
    benchmarkDigest: benchmark.digest,
    reviewDigest: review.digest,
    candidate: candidate.payload,
    authorizationDelta: { tools: [], commands: [], writeSets: [] },
    activatedBy: activation.activatedBy,
    activationConfirmed: true,
    activatedAt,
  });
  const record = ActivatedPlaybookRecordSchema.parse({
    payload,
    digest: digestCanonical(payload),
  });
  const directory = await resolveContainedDirectory(options.projectRoot, [
    '.goalie',
    'playbooks',
  ]);
  await writeImmutableJson(directory, `${candidate.digest}.json`, record);
  return record;
}

export async function loadActivatedPlaybook(
  projectRoot: string,
  candidateDigest: string,
): Promise<ActivatedPlaybookRecord> {
  const requestedDigest = PlaybookDigestSchema.parse(candidateDigest);
  const directory = await resolveExistingContainedDirectory(projectRoot, [
    '.goalie',
    'playbooks',
  ]);
  const record = ActivatedPlaybookRecordSchema.parse(
    await readJsonFile(join(directory, `${requestedDigest}.json`)),
  );
  assertActivatedRecordIntegrity(record, requestedDigest);
  return record;
}

function assertActivatedRecordIntegrity(
  record: ActivatedPlaybookRecord,
  expectedCandidateDigest = record.payload.candidateDigest,
): void {
  const candidateActual = digestCanonical(record.payload.candidate);
  const activationActual = digestCanonical(record.payload);
  if (
    record.payload.candidateDigest !== expectedCandidateDigest ||
    candidateActual !== expectedCandidateDigest ||
    record.digest !== activationActual
  ) {
    throw new PlaybookIntegrityError('Activated playbook digest mismatch');
  }
}

/** Returns prose guidance only; it never returns or modifies a policy profile. */
export function getPlaybookGuidance(
  playbook: ActivatedPlaybookRecord,
): PlaybookGuidance {
  const verified = ActivatedPlaybookRecordSchema.parse(playbook);
  assertActivatedRecordIntegrity(verified);
  return PlaybookGuidanceSchema.parse({
    playbookDigest: verified.payload.candidateDigest,
    title: verified.payload.candidate.title,
    summary: verified.payload.candidate.summary,
    whenToUse: verified.payload.candidate.whenToUse,
    procedureSteps: verified.payload.candidate.procedureSteps,
    cautions: verified.payload.candidate.cautions,
    policyScope: 'procedure_only',
  });
}
