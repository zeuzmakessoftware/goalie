import { z } from 'zod';

const isoDate = z.iso.datetime({ offset: true });
const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const eventPayload = z
  .unknown()
  .refine((value) => value !== undefined, 'Event payload must not be undefined');
const workspacePath = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.includes('\0'), 'Path cannot contain NUL bytes')
  .refine(
    (value) => !value.split(/[\\/]+/u).includes('..'),
    'Path cannot traverse above the workspace',
  );

export const AgentRoleSchema = z.enum([
  'manager',
  'worker',
  'critic',
  'auditor',
  'system',
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const SessionStatusSchema = z.enum([
  'created',
  'planning',
  'running',
  'achieved',
  'paused_budget',
  'paused_plateau',
  'paused_approval',
  'failed',
  'blocked',
  'safety_halt',
  'user_stopped',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const TaskStatusSchema = z.enum([
  'pending',
  'ready',
  'running',
  'awaiting_evaluation',
  'passed',
  'failed',
  'blocked',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const CheckStatusSchema = z.enum([
  'pending',
  'running',
  'passed',
  'failed',
  'error',
  'skipped',
]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const EvidenceKindSchema = z.enum([
  'text',
  'command',
  'test',
  'file',
  'diff',
  'metric',
  'image',
  'video',
  'url',
  'json',
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EvidenceSchema = z
  .object({
    id: identifier,
    taskId: identifier.optional(),
    checkId: identifier.optional(),
    kind: EvidenceKindSchema,
    source: z.string().min(1).max(240),
    summary: z.string().min(1).max(8_000),
    uri: z.string().max(4_096).optional(),
    content: z.unknown().optional(),
    digest: sha256.optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    createdAt: isoDate,
  })
  .strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

export const CriterionSchema = z
  .object({
    id: identifier,
    description: z.string().min(1).max(4_000),
    weight: z.number().positive().finite().default(1),
    required: z.boolean().default(true),
    evaluatorId: identifier.optional(),
  })
  .strict();
export type Criterion = z.infer<typeof CriterionSchema>;

export const CheckDefinitionSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(240),
    description: z.string().max(4_000).default(''),
    evaluatorId: identifier,
    criterionIds: z.array(identifier).default([]),
    required: z.boolean().default(true),
    timeoutMs: z.number().int().positive().optional(),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type CheckDefinition = z.infer<typeof CheckDefinitionSchema>;

export const CheckResultSchema = z
  .object({
    id: identifier,
    definitionId: identifier,
    taskId: identifier.optional(),
    evaluatorId: identifier,
    evaluatorVersion: z.string().min(1).max(120),
    status: CheckStatusSchema,
    score: z.number().min(0).max(1).finite().optional(),
    summary: z.string().max(8_000).default(''),
    evidenceIds: z.array(identifier).default([]),
    startedAt: isoDate,
    completedAt: isoDate.optional(),
    error: z.string().max(8_000).optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const TaskSchema = z
  .object({
    id: identifier,
    title: z.string().min(1).max(240),
    objective: z.string().min(1).max(12_000),
    dependencies: z.array(identifier).default([]),
    writeSet: z.array(workspacePath).default([]),
    checkIds: z.array(identifier).default([]),
    status: TaskStatusSchema.default('pending'),
    priority: z.number().int().min(-1_000).max(1_000).default(0),
    required: z.boolean().default(true),
    attempts: z.number().int().nonnegative().default(0),
    maxAttempts: z.number().int().positive().optional(),
    assignedAgentId: identifier.optional(),
    createdAt: isoDate,
    updatedAt: isoDate,
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((task, context) => {
    if (task.dependencies.includes(task.id)) {
      context.addIssue({
        code: 'custom',
        path: ['dependencies'],
        message: 'A task cannot depend on itself',
      });
    }
    if (new Set(task.dependencies).size !== task.dependencies.length) {
      context.addIssue({
        code: 'custom',
        path: ['dependencies'],
        message: 'Task dependencies must be unique',
      });
    }
  });
export type Task = z.infer<typeof TaskSchema>;

export const CriterionVerdictStatusSchema = z.enum([
  'passed',
  'failed',
  'uncertain',
  'not_applicable',
]);
export type CriterionVerdictStatus = z.infer<
  typeof CriterionVerdictStatusSchema
>;

export const CriterionVerdictSchema = z
  .object({
    criterionId: identifier,
    status: CriterionVerdictStatusSchema,
    score: z.number().min(0).max(1).finite(),
    rationale: z.string().min(1).max(8_000),
    evidenceIds: z.array(identifier).default([]),
  })
  .strict();
export type CriterionVerdict = z.infer<typeof CriterionVerdictSchema>;

/** Provider-facing critic contract. Durable verdict events enrich this shape. */
export const CriticVerdictSchema = z
  .object({
    overall: z.enum(['pass', 'fail', 'uncertain']),
    score: z.number().min(0).max(100).finite(),
    criteria: z.array(z.object({
      id: identifier,
      status: CriterionVerdictStatusSchema,
      score: z.number().min(0).max(100).finite().optional(),
      evidenceIds: z.array(identifier),
      rationale: z.string().min(1).max(8_000),
    }).strict()).min(1),
    blockingGap: z.string().min(1).max(8_000).optional(),
    nextExperiment: z.string().min(1).max(4_000).optional(),
    confidence: z.number().min(0).max(1).finite(),
    summary: z.string().min(1).max(8_000).optional(),
  })
  .strict();
export type CriticVerdict = z.infer<typeof CriticVerdictSchema>;

export const RecordedCriticVerdictSchema = z
  .object({
    id: identifier,
    sessionId: identifier,
    taskId: identifier,
    criticId: identifier,
    attempt: z.number().int().positive(),
    verdict: z.enum(['pass', 'fail', 'uncertain']),
    direction: z.enum(['positive', 'negative', 'neutral']),
    score: z.number().min(0).max(1).finite(),
    confidence: z.number().min(0).max(1).finite(),
    comparatorWinner: z
      .enum(['candidate', 'reference', 'tie', 'not_applicable'])
      .default('not_applicable'),
    criteria: z.array(CriterionVerdictSchema).min(1),
    summary: z.string().min(1).max(8_000),
    biggestGap: z.string().min(1).max(8_000).optional(),
    recommendations: z.array(z.string().min(1).max(4_000)).default([]),
    evidenceIds: z.array(identifier).default([]),
    createdAt: isoDate,
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((verdict, context) => {
    if (verdict.verdict !== 'pass' && !verdict.biggestGap) {
      context.addIssue({
        code: 'custom',
        path: ['biggestGap'],
        message: 'A non-passing verdict must identify the biggest gap',
      });
    }
    const ids = verdict.criteria.map((criterion) => criterion.criterionId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        path: ['criteria'],
        message: 'Criterion verdicts must be unique',
      });
    }
  });
export type RecordedCriticVerdict = z.infer<typeof RecordedCriticVerdictSchema>;

export const PlateauPolicySchema = z
  .object({
    window: z.number().int().positive().default(3),
    minImprovement: z.number().min(0).max(1).finite().default(0.02),
  })
  .strict()
  .default({ window: 3, minImprovement: 0.02 });
export type PlateauPolicy = z.infer<typeof PlateauPolicySchema>;

export const BudgetPolicySchema = z
  .object({
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive().finite().optional(),
    maxWallTimeMs: z.number().int().positive().optional(),
    maxTurns: z.number().int().positive().optional(),
    maxConcurrency: z.number().int().positive().default(4),
    plateau: PlateauPolicySchema,
  })
  .strict()
  .default({ maxConcurrency: 4, plateau: { window: 3, minImprovement: 0.02 } });
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;

export const QualityBarSchema = z
  .object({
    description: z.string().min(1).max(12_000),
    references: z.array(z.string().min(1).max(4_096)).default([]),
    criteria: z.array(CriterionSchema).min(1),
    blindComparison: z.boolean().default(false),
  })
  .strict();
export type QualityBar = z.infer<typeof QualityBarSchema>;

export const GauntletSpecSchema = z
  .object({
    version: z.literal(1).default(1),
    goal: z.string().min(1).max(24_000),
    qualityBar: QualityBarSchema,
    constraints: z.array(z.string().min(1).max(8_000)).default([]),
    checks: z.array(CheckDefinitionSchema).default([]),
    budget: BudgetPolicySchema,
    workspaceRoot: z.string().min(1).max(4_096),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((spec, context) => {
    const criterionIds = spec.qualityBar.criteria.map((criterion) => criterion.id);
    if (new Set(criterionIds).size !== criterionIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['qualityBar', 'criteria'],
        message: 'Quality-bar criterion IDs must be unique',
      });
    }
    const checkIds = spec.checks.map((check) => check.id);
    if (new Set(checkIds).size !== checkIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['checks'],
        message: 'Check IDs must be unique',
      });
    }
    const knownCriteria = new Set(criterionIds);
    for (const [index, check] of spec.checks.entries()) {
      for (const criterionId of check.criterionIds) {
        if (!knownCriteria.has(criterionId)) {
          context.addIssue({
            code: 'custom',
            path: ['checks', index, 'criterionIds'],
            message: `Unknown criterion ID: ${criterionId}`,
          });
        }
      }
    }
  });
export type GauntletSpec = z.infer<typeof GauntletSpecSchema>;

export const BackendMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().max(1_000_000),
    name: z.string().min(1).max(160).optional(),
    toolCallId: z.string().min(1).max(240).optional(),
  })
  .strict();
export type BackendMessage = z.infer<typeof BackendMessageSchema>;

export const BackendRequestSchema = z
  .object({
    actorId: identifier,
    role: AgentRoleSchema,
    cwd: workspacePath,
    prompt: z.string().min(1).max(1_000_000),
    sessionRef: z
      .object({
        backend: z.string().min(1).max(120),
        id: z.string().min(1).max(1_024),
        metadata: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
    outputSchema: z.record(z.string(), z.unknown()),
    policyProfile: z
      .object({
        id: identifier,
        tools: z.array(z.string().min(1).max(240)),
        readOnly: z.boolean(),
        network: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type BackendRequest = z.infer<typeof BackendRequestSchema>;

const BackendSessionRefSchema = z
  .object({
    backend: z.string().min(1).max(120),
    id: z.string().min(1).max(1_024),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const BackendEventSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('session_started'), session: BackendSessionRefSchema })
    .strict(),
  z
    .object({ type: z.literal('text_delta'), text: z.string() })
    .strict(),
  z
    .object({
      type: z.literal('tool_requested'),
      callId: z.string().min(1).max(1_024),
      name: z.string().min(1).max(240),
      input: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool_completed'),
      callId: z.string().min(1).max(1_024),
      name: z.string().min(1).max(240),
      output: z.unknown(),
      isError: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('usage'),
      usage: z
        .object({
          inputTokens: z.number().int().nonnegative().optional(),
          outputTokens: z.number().int().nonnegative().optional(),
          cacheReadTokens: z.number().int().nonnegative().optional(),
          cacheWriteTokens: z.number().int().nonnegative().optional(),
          costUsd: z.number().nonnegative().finite().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('terminal'),
      status: z.enum(['completed', 'blocked', 'context_limit', 'budget', 'cancelled', 'error']),
      rawReason: z.string().max(8_000).optional(),
      error: z.string().max(8_000).optional(),
      structuredOutput: z.unknown().optional(),
    })
    .strict(),
]);
export type BackendEvent = z.infer<typeof BackendEventSchema>;

export const SessionEventActorSchema = z
  .object({
    role: AgentRoleSchema,
    id: identifier,
  })
  .strict();
export type SessionEventActor = z.infer<typeof SessionEventActorSchema>;

/**
 * Generic event envelope. Payload intentionally remains unknown so backends and
 * UI adapters can persist extension events without importing reducer internals.
 */
export const SessionEventSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    id: identifier,
    sessionId: identifier,
    sequence: z.number().int().positive(),
    timestamp: isoDate,
    causationId: identifier.optional(),
    taskId: identifier.optional(),
    kind: z.string().min(1).max(240),
    payload: eventPayload,
    artifactHashes: z.record(z.string(), sha256).optional(),
    actor: SessionEventActorSchema.optional(),
    previousHash: sha256,
    hash: sha256,
  })
  .strict();
type ParsedSessionEvent = z.infer<typeof SessionEventSchema>;
export type SessionEvent = Omit<ParsedSessionEvent, 'payload'> & {
  payload: unknown;
};

export const SessionEventInputSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    id: identifier.optional(),
    timestamp: isoDate.optional(),
    causationId: identifier.optional(),
    taskId: identifier.optional(),
    kind: z.string().min(1).max(240),
    payload: eventPayload,
    artifactHashes: z.record(z.string(), sha256).optional(),
    actor: SessionEventActorSchema.optional(),
  })
  .strict();
type ParsedSessionEventInput = z.infer<typeof SessionEventInputSchema>;
export type SessionEventInput = Omit<ParsedSessionEventInput, 'payload'> & {
  payload: unknown;
};

export const BudgetUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    costUsd: z.number().nonnegative().finite().optional(),
    /** Pending reservations do not claim pricing; completed unknown usage does. */
    costStatus: z.enum(['pending', 'reported', 'unknown']).optional(),
    wallTimeMs: z.number().int().nonnegative().default(0),
    turns: z.number().int().nonnegative().default(0),
  })
  .strict();
export type BudgetUsage = z.infer<typeof BudgetUsageSchema>;

const coreEventPayloadSchemas = {
  'session.created': z.object({ spec: GauntletSpecSchema }).strict(),
  'session.status_changed': z
    .object({ status: SessionStatusSchema, reason: z.string().max(8_000).optional() })
    .strict(),
  'task.upserted': z.object({ task: TaskSchema }).strict(),
  'task.started': z
    .object({ taskId: identifier, agentId: identifier, startedAt: isoDate })
    .strict(),
  'task.submitted': z
    .object({ taskId: identifier, evidenceIds: z.array(identifier).default([]) })
    .strict(),
  'task.blocked': z
    .object({ taskId: identifier, reason: z.string().min(1).max(8_000) })
    .strict(),
  'task.cancelled': z
    .object({ taskId: identifier, reason: z.string().min(1).max(8_000) })
    .strict(),
  'check.recorded': z.object({ check: CheckResultSchema }).strict(),
  'evidence.recorded': z.object({ evidence: EvidenceSchema }).strict(),
  'critic.verdict_recorded': z.object({ verdict: RecordedCriticVerdictSchema }).strict(),
  'budget.consumed': z.object({ usage: BudgetUsageSchema }).strict(),
  'session.budget_extended': z
    .object({
      budget: BudgetPolicySchema,
      amendmentVersion: z.number().int().positive(),
      reason: z.string().min(1).max(8_000),
    })
    .strict(),
  'session.error_recorded': z
    .object({ code: identifier, message: z.string().min(1).max(8_000), retryable: z.boolean() })
    .strict(),
} as const;

export const CORE_EVENT_KINDS = Object.freeze(
  Object.keys(coreEventPayloadSchemas) as Array<keyof typeof coreEventPayloadSchemas>,
);
export type CoreEventKind = (typeof CORE_EVENT_KINDS)[number];

export type CoreEventPayloadMap = {
  [Kind in CoreEventKind]: z.infer<(typeof coreEventPayloadSchemas)[Kind]>;
};

export type CoreSessionEvent<Kind extends CoreEventKind = CoreEventKind> =
  Kind extends CoreEventKind
    ? SessionEvent & {
        kind: Kind;
        payload: CoreEventPayloadMap[Kind];
      }
    : never;

export type CoreSessionEventInput<Kind extends CoreEventKind = CoreEventKind> =
  Kind extends CoreEventKind
    ? Omit<SessionEventInput, 'kind' | 'payload'> & {
        kind: Kind;
        payload: CoreEventPayloadMap[Kind];
      }
    : never;

export function isCoreEventKind(kind: string): kind is CoreEventKind {
  return Object.hasOwn(coreEventPayloadSchemas, kind);
}

export function parseCoreSessionEvent(event: SessionEvent): CoreSessionEvent {
  if (!isCoreEventKind(event.kind)) {
    throw new Error(`Unsupported core session event kind: ${event.kind}`);
  }
  const payloadSchema = coreEventPayloadSchemas[event.kind];
  const payload = payloadSchema.parse(event.payload);
  return { ...event, kind: event.kind, payload } as CoreSessionEvent;
}

export function parseCoreSessionEventInput<Kind extends CoreEventKind>(
  input: CoreSessionEventInput<Kind>,
): CoreSessionEventInput<Kind> {
  const base = SessionEventInputSchema.parse(input);
  const payload = coreEventPayloadSchemas[input.kind].parse(input.payload);
  return { ...base, kind: input.kind, payload } as CoreSessionEventInput<Kind>;
}

export const TaskProgressSchema = z
  .object({
    bestScore: z.number().min(0).max(1).finite().optional(),
    latestScore: z.number().min(0).max(1).finite().optional(),
    /** Highest number of criteria passed in a single critic verdict. */
    bestPassedCriteria: z.number().int().nonnegative().optional(),
    /** Host-derived digest of the current failing criteria and verifiers. */
    lastFailureFingerprint: sha256.optional(),
    /** Consecutive cycles with that fingerprint and no meaningful gain. */
    sameFailureCount: z.number().int().nonnegative().optional(),
    /**
     * Compatibility alias consumed by older schedulers and snapshots. New
     * reducers keep it equal to `sameFailureCount`.
     */
    nonImprovingVerdicts: z.number().int().nonnegative().default(0),
    verdictCount: z.number().int().nonnegative().default(0),
  })
  .strict();
export type TaskProgress = z.infer<typeof TaskProgressSchema>;

export const SessionBudgetStateSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    reportedCostUsd: z.number().nonnegative().finite().default(0),
    costKnown: z.boolean().default(true),
    unpricedUsageEvents: z.number().int().nonnegative().default(0),
    wallTimeMs: z.number().int().nonnegative().default(0),
    turns: z.number().int().nonnegative().default(0),
  })
  .strict();
export type SessionBudgetState = z.infer<typeof SessionBudgetStateSchema>;

export const SessionErrorSchema = z
  .object({
    code: identifier,
    message: z.string().min(1).max(8_000),
    retryable: z.boolean(),
    sequence: z.number().int().positive(),
    timestamp: isoDate,
  })
  .strict();

export const SessionStateSchema = z
  .object({
    sessionId: identifier,
    spec: GauntletSpecSchema,
    status: SessionStatusSchema,
    statusReason: z.string().max(8_000).optional(),
    tasks: z.record(z.string(), TaskSchema),
    checks: z.record(z.string(), CheckResultSchema),
    evidence: z.record(z.string(), EvidenceSchema),
    verdicts: z.array(RecordedCriticVerdictSchema),
    taskProgress: z.record(z.string(), TaskProgressSchema),
    budget: SessionBudgetStateSchema,
    errors: z.array(SessionErrorSchema),
    createdAt: isoDate,
    updatedAt: isoDate,
    lastSequence: z.number().int().nonnegative(),
    lastHash: sha256,
  })
  .strict();
export type SessionState = z.infer<typeof SessionStateSchema>;

export const GENESIS_HASH = '0'.repeat(64);

export const SessionSnapshotSchema = z
  .object({
    version: z.literal(1),
    sessionId: identifier,
    lastSequence: z.number().int().nonnegative(),
    lastHash: sha256,
    createdAt: isoDate,
    state: SessionStateSchema,
    checksum: sha256,
  })
  .strict();
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

export const EvaluatorDefinitionSchema = z
  .object({
    id: identifier,
    version: z.string().min(1).max(120),
    name: z.string().min(1).max(240),
    description: z.string().max(4_000).default(''),
    deterministic: z.boolean().default(false),
  })
  .strict();
export type EvaluatorDefinition = z.infer<typeof EvaluatorDefinitionSchema>;

export const EvaluationRequestSchema = z
  .object({
    sessionId: identifier,
    task: TaskSchema,
    check: CheckDefinitionSchema,
    spec: GauntletSpecSchema,
    evidence: z.array(EvidenceSchema).default([]),
    candidate: z.unknown(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();
export type EvaluationRequest = z.infer<typeof EvaluationRequestSchema>;

export const EvaluationResultSchema = z
  .object({
    status: z.enum(['passed', 'failed', 'error', 'skipped']),
    score: z.number().min(0).max(1).finite().optional(),
    summary: z.string().max(8_000).default(''),
    criteria: z.array(CriterionVerdictSchema).default([]),
    evidence: z.array(EvidenceSchema).default([]),
    error: z.string().max(8_000).optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === 'error' && !result.error) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'An error evaluation must include an error message',
      });
    }
  });
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;
export type EvaluationResultInput = z.input<typeof EvaluationResultSchema>;
