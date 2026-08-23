import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PlaybookEligibilityError,
  PlaybookIntegrityError,
  activatePlaybook,
  getPlaybookGuidance,
  loadActivatedPlaybook,
  loadPlaybookCandidate,
  quarantinePlaybookCandidate,
  recordPlaybookBenchmark,
  recordPlaybookReview,
  type PlaybookBenchmarkRecord,
  type PlaybookCandidateRecord,
  type PlaybookReviewRecord,
} from '../../src/playbooks/index.js';

const hash = (digit: string): string => digit.repeat(64);

describe('playbook lifecycle', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map(async (root) => {
        await rm(root, { recursive: true, force: true });
      }),
    );
  });

  async function roots(): Promise<{ storeRoot: string; projectRoot: string }> {
    const root = await mkdtemp(join(tmpdir(), 'goalie-playbooks-'));
    temporaryRoots.push(root);
    return {
      storeRoot: join(root, 'store'),
      projectRoot: join(root, 'project'),
    };
  }

  async function candidate(storeRoot: string): Promise<PlaybookCandidateRecord> {
    return quarantinePlaybookCandidate({
      storeRoot,
      createdAt: '2026-08-22T10:00:00.000Z',
      draft: {
        title: 'Crash-safe ingestion review',
        summary: 'A procedure for checking durable ingestion changes.',
        whenToUse: ['Use for changes that recover work after interruption.'],
        procedureSteps: [
          'Identify the durable boundary before proposing a repair.',
          'Compare replay output against independently recorded evidence.',
          'Recheck duplicate handling after the primary verifier passes.',
        ],
        cautions: ['Treat every stored operation with an unknown result as pending review.'],
        sourceSessionId: 'source-session',
        sourceBuilderProviderFamilies: ['codex'],
        sourceBuilderSessionIds: ['builder-session'],
        evidenceHashes: [hash('a')],
      },
    });
  }

  async function benchmark(
    storeRoot: string,
    playbook: PlaybookCandidateRecord,
    candidateScore = 0.9,
  ): Promise<PlaybookBenchmarkRecord> {
    return recordPlaybookBenchmark({
      storeRoot,
      benchmark: {
        candidateDigest: playbook.digest,
        benchmarkId: 'held-out-recovery-1',
        conditions: {
          heldOutTaskId: 'held-out-task',
          heldOutTaskDigest: hash('b'),
          baseArtifactDigest: hash('c'),
          builderProviderFamily: 'codex',
          builderModelId: 'gpt-5.6-codex',
          evaluatorIds: ['golden-output', 'crash-recovery'],
          maxTurns: 12,
          maxWallTimeMs: 120_000,
          maxReportableCostUsd: 2,
          seed: 'fixed-seed-1',
        },
        primaryMetric: {
          metricId: 'criteria-pass-rate',
          direction: 'higher',
          minimumDelta: 0.1,
        },
        baseline: {
          status: 'completed',
          playbookDigest: null,
          metrics: { 'criteria-pass-rate': 0.5 },
          passedCriteria: 2,
          failedCriteria: 2,
          turnsUsed: 8,
          wallTimeMs: 80_000,
          reportableCostUsd: 1.2,
          artifactDigest: hash('d'),
          evidenceHashes: [hash('e')],
        },
        candidate: {
          status: 'completed',
          playbookDigest: playbook.digest,
          metrics: { 'criteria-pass-rate': candidateScore },
          passedCriteria: candidateScore > 0.5 ? 4 : 2,
          failedCriteria: candidateScore > 0.5 ? 0 : 2,
          turnsUsed: 8,
          wallTimeMs: 80_000,
          reportableCostUsd: 1.2,
          artifactDigest: hash('f'),
          evidenceHashes: [hash('1')],
        },
        createdAt: '2026-08-22T10:01:00.000Z',
      },
    });
  }

  async function review(
    storeRoot: string,
    playbook: PlaybookCandidateRecord,
    result: PlaybookBenchmarkRecord,
  ): Promise<PlaybookReviewRecord> {
    return recordPlaybookReview({
      storeRoot,
      review: {
        candidateDigest: playbook.digest,
        benchmarkDigest: result.digest,
        reviewerProviderFamily: 'claude',
        reviewerModelId: 'claude-opus-review',
        reviewerSessionId: 'fresh-review-session',
        decision: 'pass',
        rationale: 'Evidence supports the measured improvement and safe procedure scope.',
        evidenceHashes: [hash('2')],
        createdAt: '2026-08-22T10:02:00.000Z',
      },
    });
  }

  it('quarantines, benchmarks, independently reviews, and explicitly activates an immutable playbook', async () => {
    const { storeRoot, projectRoot } = await roots();
    const playbook = await candidate(storeRoot);
    const result = await benchmark(storeRoot, playbook);
    const independentReview = await review(storeRoot, playbook, result);

    expect(result.payload.improved).toBe(true);
    expect(
      await loadPlaybookCandidate(storeRoot, playbook.digest),
    ).toEqual(playbook);

    const activated = await activatePlaybook({
      storeRoot,
      projectRoot,
      activation: {
        candidateDigest: playbook.digest,
        benchmarkDigest: result.digest,
        reviewDigest: independentReview.digest,
        confirmedByUserOrHost: true,
        activatedBy: 'user:joseph',
        activatedAt: '2026-08-22T10:03:00.000Z',
      },
    });
    const loaded = await loadActivatedPlaybook(projectRoot, playbook.digest);
    const guidance = getPlaybookGuidance(loaded);

    expect(loaded).toEqual(activated);
    expect(loaded.payload.authorizationDelta).toEqual({
      tools: [],
      commands: [],
      writeSets: [],
    });
    expect(guidance.policyScope).toBe('procedure_only');
    expect(guidance.procedureSteps).toHaveLength(3);
  });

  it('refuses promotion when the matched held-out benchmark did not improve', async () => {
    const { storeRoot, projectRoot } = await roots();
    const playbook = await candidate(storeRoot);
    const result = await benchmark(storeRoot, playbook, 0.55);
    const independentReview = await review(storeRoot, playbook, result);

    expect(result.payload.improved).toBe(false);
    await expect(
      activatePlaybook({
        storeRoot,
        projectRoot,
        activation: {
          candidateDigest: playbook.digest,
          benchmarkDigest: result.digest,
          reviewDigest: independentReview.digest,
          confirmedByUserOrHost: true,
          activatedBy: 'host',
          activatedAt: '2026-08-22T10:03:00.000Z',
        },
      }),
    ).rejects.toThrow(PlaybookEligibilityError);
  });

  it('refuses a review from the same provider family as a source builder', async () => {
    const { storeRoot } = await roots();
    const playbook = await candidate(storeRoot);
    const result = await benchmark(storeRoot, playbook);

    await expect(
      recordPlaybookReview({
        storeRoot,
        review: {
          candidateDigest: playbook.digest,
          benchmarkDigest: result.digest,
          reviewerProviderFamily: 'codex',
          reviewerModelId: 'another-codex-model',
          reviewerSessionId: 'different-session',
          decision: 'pass',
          rationale: 'This review is not independent by provider family.',
          evidenceHashes: [hash('3')],
          createdAt: '2026-08-22T10:02:00.000Z',
        },
      }),
    ).rejects.toThrow(/different from every source builder/u);
  });

  it('refuses activation without an explicit user or host confirmation', async () => {
    const { storeRoot, projectRoot } = await roots();
    const playbook = await candidate(storeRoot);
    const result = await benchmark(storeRoot, playbook);
    const independentReview = await review(storeRoot, playbook, result);

    await expect(
      activatePlaybook({
        storeRoot,
        projectRoot,
        activation: {
          candidateDigest: playbook.digest,
          benchmarkDigest: result.digest,
          reviewDigest: independentReview.digest,
          confirmedByUserOrHost: false,
          activatedBy: 'host',
          activatedAt: '2026-08-22T10:03:00.000Z',
        },
      }),
    ).rejects.toThrow(/confirmation is required/u);
  });

  it('detects tampering whenever an immutable candidate is loaded', async () => {
    const { storeRoot } = await roots();
    const playbook = await candidate(storeRoot);
    const path = join(
      storeRoot,
      'quarantine',
      playbook.digest,
      'candidate.json',
    );
    const stored = JSON.parse(await readFile(path, 'utf8')) as {
      payload: { title: string };
    };
    stored.payload.title = 'Tampered title';
    await writeFile(path, `${JSON.stringify(stored)}\n`, 'utf8');

    await expect(
      loadPlaybookCandidate(storeRoot, playbook.digest),
    ).rejects.toThrow(PlaybookIntegrityError);
  });

  it('rejects executable syntax and policy-widening fields at extraction', async () => {
    const { storeRoot } = await roots();
    await expect(
      quarantinePlaybookCandidate({
        storeRoot,
        draft: {
          title: 'Unsafe procedure',
          summary: 'An unsafe candidate.',
          whenToUse: ['Use during repair.'],
          procedureSteps: ['sudo chmod 777 the workspace'],
          cautions: [],
          sourceSessionId: 'source-session',
          sourceBuilderProviderFamilies: ['codex'],
          sourceBuilderSessionIds: ['builder-session'],
          evidenceHashes: [hash('4')],
          commands: ['arbitrary-shell'],
        },
      }),
    ).rejects.toThrow();
  });
});
