import { z } from 'zod';

export const PlaybookDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export type PlaybookDigest = z.infer<typeof PlaybookDigestSchema>;

const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const isoDate = z.iso.datetime({ offset: true });
const providerFamily = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);

const plainText = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine(
      (value) => !/[\u0000-\u001f\u007f]/u.test(value),
      'Playbook prose must be a single plain-text line',
    );

/**
 * Playbook content is deliberately prose-only. This is a defense in depth
 * boundary, not a shell parser: callers must still treat the returned prose as
 * guidance and never as authorization.
 */
export const ProcedureTextSchema = plainText(2_000).superRefine(
  (value, context) => {
    const executablePatterns: Array<{ pattern: RegExp; message: string }> = [
      {
        pattern: /```|`|#!|\$|[;&|<>]/u,
        message: 'Executable syntax is not allowed in procedure-only playbooks',
      },
      {
        pattern:
          /(?:^|\s)(?:sudo|bash|sh|zsh|fish|powershell|cmd(?:\.exe)?|python(?:3)?|node|deno|bun|npm|pnpm|yarn|git|make|docker|gh|curl|wget|echo|printf|env|rm|chmod|chown)\s+/iu,
        message: 'Command invocations are not allowed in procedure-only playbooks',
      },
      {
        pattern:
          /\b(?:allow|grant|enable|expand|widen|bypass|disable|ignore|use|request|obtain)\b.{0,48}\b(?:tools?|commands?|shell|network|permissions?|write[- ]?sets?|sandbox|approvals?|safety)\b/iu,
        message: 'Playbooks cannot widen tools, permissions, or policy',
      },
    ];
    for (const { pattern, message } of executablePatterns) {
      if (pattern.test(value)) {
        context.addIssue({ code: 'custom', message });
      }
    }
  },
);

export const PlaybookCandidateDraftSchema = z
  .object({
    title: plainText(160),
    summary: ProcedureTextSchema,
    whenToUse: z.array(ProcedureTextSchema).min(1).max(20),
    procedureSteps: z.array(ProcedureTextSchema).min(1).max(50),
    cautions: z.array(ProcedureTextSchema).max(20).default([]),
    sourceSessionId: identifier,
    sourceBuilderProviderFamilies: z.array(providerFamily).min(1).max(20),
    sourceBuilderSessionIds: z.array(identifier).min(1).max(100),
    evidenceHashes: z.array(PlaybookDigestSchema).min(1).max(500),
  })
  .strict();
export type PlaybookCandidateDraft = z.infer<
  typeof PlaybookCandidateDraftSchema
>;

export const PlaybookCandidatePayloadSchema = PlaybookCandidateDraftSchema.extend(
  {
    schemaVersion: z.literal(1),
    kind: z.literal('playbook_candidate'),
    policyScope: z.literal('procedure_only'),
    createdAt: isoDate,
  },
).strict();
export type PlaybookCandidatePayload = z.infer<
  typeof PlaybookCandidatePayloadSchema
>;

export const PlaybookCandidateRecordSchema = z
  .object({
    payload: PlaybookCandidatePayloadSchema,
    digest: PlaybookDigestSchema,
  })
  .strict();
export type PlaybookCandidateRecord = z.infer<
  typeof PlaybookCandidateRecordSchema
>;

export const BenchmarkConditionsSchema = z
  .object({
    heldOutTaskId: identifier,
    heldOutTaskDigest: PlaybookDigestSchema,
    baseArtifactDigest: PlaybookDigestSchema,
    builderProviderFamily: providerFamily,
    builderModelId: z.string().min(1).max(240),
    evaluatorIds: z.array(identifier).min(1).max(100),
    maxTurns: z.number().int().positive(),
    maxWallTimeMs: z.number().int().positive(),
    maxReportableCostUsd: z.number().nonnegative().finite().nullable(),
    seed: z.string().min(1).max(240).optional(),
  })
  .strict();
export type BenchmarkConditions = z.infer<typeof BenchmarkConditionsSchema>;

export const BenchmarkRunSchema = z
  .object({
    status: z.enum(['completed', 'failed']),
    playbookDigest: PlaybookDigestSchema.nullable(),
    metrics: z.record(z.string().min(1).max(160), z.number().finite()),
    passedCriteria: z.number().int().nonnegative(),
    failedCriteria: z.number().int().nonnegative(),
    turnsUsed: z.number().int().nonnegative(),
    wallTimeMs: z.number().int().nonnegative(),
    reportableCostUsd: z.number().nonnegative().finite().nullable(),
    artifactDigest: PlaybookDigestSchema,
    evidenceHashes: z.array(PlaybookDigestSchema).min(1).max(1_000),
  })
  .strict();
export type BenchmarkRun = z.infer<typeof BenchmarkRunSchema>;

export const BenchmarkPrimaryMetricSchema = z
  .object({
    metricId: z.string().min(1).max(160),
    direction: z.enum(['higher', 'lower']),
    minimumDelta: z.number().positive().finite(),
  })
  .strict();
export type BenchmarkPrimaryMetric = z.infer<
  typeof BenchmarkPrimaryMetricSchema
>;

export const PlaybookBenchmarkInputSchema = z
  .object({
    candidateDigest: PlaybookDigestSchema,
    benchmarkId: identifier,
    conditions: BenchmarkConditionsSchema,
    primaryMetric: BenchmarkPrimaryMetricSchema,
    baseline: BenchmarkRunSchema,
    candidate: BenchmarkRunSchema,
    createdAt: isoDate.optional(),
  })
  .strict();
export type PlaybookBenchmarkInput = z.infer<
  typeof PlaybookBenchmarkInputSchema
>;

export const PlaybookBenchmarkPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('playbook_benchmark'),
    candidateDigest: PlaybookDigestSchema,
    benchmarkId: identifier,
    conditions: BenchmarkConditionsSchema,
    primaryMetric: BenchmarkPrimaryMetricSchema,
    baseline: BenchmarkRunSchema,
    candidate: BenchmarkRunSchema,
    improved: z.boolean(),
    createdAt: isoDate,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.baseline.playbookDigest !== null) {
      context.addIssue({
        code: 'custom',
        path: ['baseline', 'playbookDigest'],
        message: 'The baseline run cannot activate a playbook',
      });
    }
    if (value.candidate.playbookDigest !== value.candidateDigest) {
      context.addIssue({
        code: 'custom',
        path: ['candidate', 'playbookDigest'],
        message: 'Candidate run must use the benchmarked playbook digest',
      });
    }
    const metricId = value.primaryMetric.metricId;
    if (!(metricId in value.baseline.metrics)) {
      context.addIssue({
        code: 'custom',
        path: ['baseline', 'metrics'],
        message: `Missing primary metric ${metricId}`,
      });
    }
    if (!(metricId in value.candidate.metrics)) {
      context.addIssue({
        code: 'custom',
        path: ['candidate', 'metrics'],
        message: `Missing primary metric ${metricId}`,
      });
    }
  });
export type PlaybookBenchmarkPayload = z.infer<
  typeof PlaybookBenchmarkPayloadSchema
>;

export const PlaybookBenchmarkRecordSchema = z
  .object({
    payload: PlaybookBenchmarkPayloadSchema,
    digest: PlaybookDigestSchema,
  })
  .strict();
export type PlaybookBenchmarkRecord = z.infer<
  typeof PlaybookBenchmarkRecordSchema
>;

export const PlaybookReviewInputSchema = z
  .object({
    candidateDigest: PlaybookDigestSchema,
    benchmarkDigest: PlaybookDigestSchema,
    reviewerProviderFamily: providerFamily,
    reviewerModelId: z.string().min(1).max(240),
    reviewerSessionId: identifier,
    decision: z.enum(['pass', 'reject', 'uncertain']),
    rationale: plainText(8_000),
    evidenceHashes: z.array(PlaybookDigestSchema).min(1).max(1_000),
    createdAt: isoDate.optional(),
  })
  .strict();
export type PlaybookReviewInput = z.infer<typeof PlaybookReviewInputSchema>;

export const PlaybookReviewPayloadSchema = PlaybookReviewInputSchema.omit({
  createdAt: true,
})
  .extend({
    schemaVersion: z.literal(1),
    kind: z.literal('playbook_review'),
    independent: z.literal(true),
    createdAt: isoDate,
  })
  .strict();
export type PlaybookReviewPayload = z.infer<
  typeof PlaybookReviewPayloadSchema
>;

export const PlaybookReviewRecordSchema = z
  .object({
    payload: PlaybookReviewPayloadSchema,
    digest: PlaybookDigestSchema,
  })
  .strict();
export type PlaybookReviewRecord = z.infer<
  typeof PlaybookReviewRecordSchema
>;

export const PlaybookActivationInputSchema = z
  .object({
    candidateDigest: PlaybookDigestSchema,
    benchmarkDigest: PlaybookDigestSchema,
    reviewDigest: PlaybookDigestSchema,
    confirmedByUserOrHost: z.boolean(),
    activatedBy: z.string().min(1).max(240),
    activatedAt: isoDate.optional(),
  })
  .strict();
export type PlaybookActivationInput = z.infer<
  typeof PlaybookActivationInputSchema
>;

const EmptyAuthorizationDeltaSchema = z
  .object({
    tools: z.array(z.never()).max(0),
    commands: z.array(z.never()).max(0),
    writeSets: z.array(z.never()).max(0),
  })
  .strict();

export const ActivatedPlaybookPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('activated_playbook'),
    policyScope: z.literal('procedure_only'),
    candidateDigest: PlaybookDigestSchema,
    benchmarkDigest: PlaybookDigestSchema,
    reviewDigest: PlaybookDigestSchema,
    candidate: PlaybookCandidatePayloadSchema,
    authorizationDelta: EmptyAuthorizationDeltaSchema,
    activatedBy: z.string().min(1).max(240),
    activationConfirmed: z.literal(true),
    activatedAt: isoDate,
  })
  .strict();
export type ActivatedPlaybookPayload = z.infer<
  typeof ActivatedPlaybookPayloadSchema
>;

export const ActivatedPlaybookRecordSchema = z
  .object({
    payload: ActivatedPlaybookPayloadSchema,
    digest: PlaybookDigestSchema,
  })
  .strict();
export type ActivatedPlaybookRecord = z.infer<
  typeof ActivatedPlaybookRecordSchema
>;

export const PlaybookGuidanceSchema = z
  .object({
    playbookDigest: PlaybookDigestSchema,
    title: plainText(160),
    summary: ProcedureTextSchema,
    whenToUse: z.array(ProcedureTextSchema),
    procedureSteps: z.array(ProcedureTextSchema),
    cautions: z.array(ProcedureTextSchema),
    policyScope: z.literal('procedure_only'),
  })
  .strict();
export type PlaybookGuidance = z.infer<typeof PlaybookGuidanceSchema>;
