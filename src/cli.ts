#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { render, type Instance as InkInstance } from 'ink';
import { execa } from 'execa';
import { config as loadDotenv } from 'dotenv';

import { createBackend, type AgentBackend, type BackendAvailability } from './backends/index.js';
import {
  goalieConfigSchema,
  loadConfig,
  writeProjectConfig,
  type ConfigOverrides,
  type GoalieConfig,
  type ProviderId,
} from './config.js';
import { JsonlEventStore } from './core/event-store.js';
import { SessionEventSchema, type SessionEvent, type SessionState } from './core/schemas.js';
import { createPenaltyLedgerFixture, PENALTY_LEDGER_GOAL } from './demo/fixture.js';
import { formatDoctor, runDoctor } from './doctor.js';
import {
  createReplayBundle,
  loadOrCreateReplaySigningKey,
  readReplayBundle,
  replayBanner,
  signReplayBundle,
  writeReplayBundle,
  type ReplayBundle,
} from './replay/bundle.js';
import { GitWorktreeManager } from './runtime/worktrees.js';
import { commandContainmentPreflight, ToolBroker } from './runtime/tool-broker.js';
import { createBroadcastSession, reduceBroadcast, replayBroadcast } from './session/broadcast.js';
import {
  createSession,
  createSessionId,
  listSessions,
  readSessionMetadata,
  removeSession,
  resolveSessionId,
  sessionDir,
  writeSessionMetadata,
  type SessionMetadata,
} from './session/catalog.js';
import { confirmKickoff } from './session/confirm.js';
import { createKickoffProposal, formatKickoffProposal, resolvedPolicyFingerprint, type KickoffProposal } from './session/kickoff.js';
import {
  refineKickoffWithManager,
  type ManagerPlanningProgress,
} from './session/planner.js';
import { GauntletRunner, type GauntletRunResult, type RunnerBackends } from './session/orchestrator.js';
import {
  App,
  DEFAULT_ANIMATION_DURATION_MS,
  GoalPrompt,
  KickoffProgress,
  type BroadcastSession,
  type GoalPromptMode,
} from './ui/index.js';

const VERSION = '1.0.0';
const DEFAULT_GC_STATUSES = new Set(['achieved', 'safety_halt']);
const DELETABLE_STATUSES = new Set(['achieved', 'failed', 'safety_halt', 'user_stopped']);

interface ParsedArguments {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set([
  'prompt-file',
  'cwd',
  'manager',
  'builder',
  'critic',
  'max-minutes',
  'max-turns',
  'max-cost',
  'concurrency',
  'speed',
  'openrouter-model',
  'output',
  'env-file',
]);

function parseArguments(argv: readonly string[]): ParsedArguments {
  const forwarded = argv[0] === '--' ? argv.slice(1) : argv;
  const normalized = forwarded.map(value => value === '-h' ? '--help' : value === '-v' ? '--version' : value);
  const command = normalized[0]?.startsWith('-') ? 'help' : normalized[0] ?? 'help';
  const rest = normalized[0]?.startsWith('-') ? normalized : normalized.slice(1);
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]!;
    if (value === '--') {
      positional.push(...rest.slice(index + 1));
      break;
    }
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const equal = value.indexOf('=');
    const name = value.slice(2, equal >= 0 ? equal : undefined);
    if (!name) throw new Error('Empty CLI flag.');
    if (equal >= 0) {
      flags.set(name, value.slice(equal + 1));
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      const next = rest[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`--${name} requires a value.`);
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { command, positional, flags };
}

function flag(args: ParsedArguments, name: string): boolean {
  return args.flags.get(name) === true;
}

function stringFlag(args: ParsedArguments, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveNumberFlag(args: ParsedArguments, name: string): number | undefined {
  const raw = stringFlag(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number.`);
  return value;
}

function providerFlag(args: ParsedArguments, name: string): ProviderId | undefined {
  const value = stringFlag(args, name);
  if (value === undefined) return undefined;
  if (!['openrouter', 'codex', 'claude'].includes(value)) {
    throw new Error(`--${name} must be openrouter, codex, or claude.`);
  }
  return value as ProviderId;
}

function configOverrides(args: ParsedArguments): ConfigOverrides {
  const openrouterOnly = flag(args, 'openrouter-only');
  const manager = openrouterOnly ? 'openrouter' : providerFlag(args, 'manager');
  const builder = openrouterOnly ? 'openrouter' : providerFlag(args, 'builder');
  const critic = openrouterOnly ? 'openrouter' : providerFlag(args, 'critic');
  const openrouterModel = stringFlag(args, 'openrouter-model');
  const maxMinutes = positiveNumberFlag(args, 'max-minutes');
  const maxTurns = positiveNumberFlag(args, 'max-turns');
  const maxCostUsd = positiveNumberFlag(args, 'max-cost');
  const concurrency = positiveNumberFlag(args, 'concurrency');
  return {
    ...(manager ? { manager } : {}),
    ...(builder ? { builder } : {}),
    ...(critic ? { critic } : {}),
    ...(openrouterOnly
      ? {
          integrator: 'openrouter' as const,
          fallback: ['openrouter' as const],
          allowDegradedCritic: true,
        }
      : {}),
    ...(openrouterModel ? { openrouterModel } : {}),
    ...(maxMinutes ? { maxMinutes: Math.floor(maxMinutes) } : {}),
    ...(maxTurns ? { maxTurns: Math.floor(maxTurns) } : {}),
    ...(maxCostUsd ? { maxCostUsd } : {}),
    ...(concurrency ? { concurrency: Math.floor(concurrency) } : {}),
    ...(flag(args, 'no-motion') ? { motion: 'none' as const } : {}),
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function resolveGoal(args: ParsedArguments): Promise<string> {
  const promptFile = stringFlag(args, 'prompt-file');
  if (promptFile) return (await readFile(resolve(promptFile), 'utf8')).trim();
  const positional = args.positional.join(' ').trim();
  if (positional) return positional;
  if (!process.stdin.isTTY) return await readStdin();
  throw new Error('Provide a goal, --prompt-file FILE, or pipe a prompt on stdin.');
}

function createBackends(config: GoalieConfig): RunnerBackends {
  return {
    openrouter: createBackend('openrouter', {
      model: config.models.openrouter,
      ...(process.env.OPENROUTER_API_KEY?.trim() ? { apiKey: process.env.OPENROUTER_API_KEY.trim() } : {}),
      title: process.env.OPENROUTER_TITLE?.trim() || 'Goalie CLI',
      ...(process.env.OPENROUTER_SITE_URL?.trim() ? { siteUrl: process.env.OPENROUTER_SITE_URL.trim() } : {}),
    }),
    codex: createBackend('codex', {
      ...(config.models.codex ? { model: config.models.codex } : {}),
    }),
    claude: createBackend('claude', {
      ...(config.models.claude ? { model: config.models.claude } : {}),
    }),
  };
}

function closeBackends(backends: RunnerBackends): void {
  for (const backend of Object.values(backends)) {
    const closable = backend as AgentBackend & { close?: () => void };
    closable.close?.();
  }
}

function configuredModel(config: GoalieConfig, provider: ProviderId): string | undefined {
  if (provider === 'openrouter') return config.models.openrouter;
  if (provider === 'codex') return config.models.codex;
  if (provider === 'claude') return config.models.claude;
  return 'deterministic-script';
}

export interface KickoffManagerProgress {
  stage:
    | 'attempt_started'
    | 'heartbeat'
    | 'backend'
    | 'attempt_failed'
    | 'transfer_window'
    | 'completed'
    | 'deterministic_fallback';
  provider: string;
  model: string;
  elapsedMs: number;
  message: string;
  backend?: ManagerPlanningProgress;
}

interface KickoffManagerOptions {
  /** Hard total wall-clock bound across every configured provider. */
  totalTimeoutMs?: number;
  /** Hard wall-clock bound for one provider, including its repair turn. */
  providerTimeoutMs?: number;
  onProgress?: (progress: KickoffManagerProgress) => void;
}

export async function createManagerPlannedProposal(
  initial: KickoffProposal,
  config: GoalieConfig,
  cwd: string,
  options: KickoffManagerOptions = {},
): Promise<KickoffProposal> {
  const backends = createBackends(config);
  const failures: string[] = [];
  const startedAt = Date.now();
  const totalTimeoutMs = Math.max(1_000, options.totalTimeoutMs ?? 90_000);
  const providerTimeoutMs = Math.max(1_000, options.providerTimeoutMs ?? 45_000);
  const emit = (
    progress: Omit<KickoffManagerProgress, 'elapsedMs'>,
  ): void => options.onProgress?.({ ...progress, elapsedMs: Date.now() - startedAt });
  try {
    const candidates = [...new Set([config.providers.manager, ...config.providers.fallback])];
    for (const provider of candidates) {
      const remainingMs = totalTimeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        failures.push(`kickoff: total ${Math.round(totalTimeoutMs / 1_000)}s planning deadline expired`);
        break;
      }
      const backend = provider === 'scripted' ? undefined : backends[provider];
      if (!backend) {
        failures.push(`${provider}: backend unavailable in this CLI process`);
        continue;
      }
      const availability: BackendAvailability = await backend.availability().catch(error => ({
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      }));
      if (!availability.available) {
        failures.push(`${provider}: ${availability.reason ?? 'unavailable'}`);
        continue;
      }
      const model = configuredModel(config, provider);
      const resolvedModel = model ?? 'provider-default-unresolved';
      if (provider !== config.providers.manager) {
        emit({
          stage: 'transfer_window',
          provider,
          model: resolvedModel,
          message: `TRANSFER WINDOW: trying ${provider} after the configured manager did not produce a valid plan.`,
        });
      }
      emit({
        stage: 'attempt_started',
        provider,
        model: resolvedModel,
        message: `${provider}/${resolvedModel} is inspecting the clean repository read-only.`,
      });
      const controller = new AbortController();
      const attemptTimeoutMs = Math.min(providerTimeoutMs, remainingMs);
      const attemptStartedAt = Date.now();
      const timeout = setTimeout(
        () => controller.abort(new Error(`${provider} kickoff planning exceeded ${Math.round(attemptTimeoutMs / 1_000)}s.`)),
        attemptTimeoutMs,
      );
      const heartbeat = setInterval(() => {
        emit({
          stage: 'heartbeat',
          provider,
          model: resolvedModel,
          message: `${provider} is still planning; hard fallback in ${Math.max(0, Math.ceil((attemptTimeoutMs - (Date.now() - attemptStartedAt)) / 1_000))}s.`,
        });
      }, 1_000);
      try {
        const planned = await refineKickoffWithManager({
          proposal: initial,
          backend,
          provider,
          ...(model !== undefined ? { model } : {}),
          ...(availability.version !== undefined ? { version: availability.version } : {}),
          broker: new ToolBroker({
            root: cwd,
            actorId: 'manager:kickoff',
            writeSet: [],
            protectedPaths: config.protectedPaths,
          }),
          cwd,
          signal: controller.signal,
          onProgress: backendProgress => emit({
            stage: 'backend',
            provider,
            model: resolvedModel,
            message: backendProgress.message,
            backend: backendProgress,
          }),
        });
        emit({
          stage: 'completed',
          provider,
          model: resolvedModel,
          message: `Kickoff DAG ready from ${provider}.`,
        });
        return {
          ...planned,
          warnings: [
            ...planned.warnings,
            ...(provider !== config.providers.manager
              ? [`TRANSFER WINDOW: kickoff manager fell back from ${config.providers.manager} to ${provider}; this provider is frozen in the confirmed plan.`]
              : []),
          ],
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(`${provider}: ${reason}`);
        emit({
          stage: 'attempt_failed',
          provider,
          model: resolvedModel,
          message: `${provider} did not produce a valid plan: ${reason}`,
        });
      } finally {
        clearTimeout(timeout);
        clearInterval(heartbeat);
      }
    }
  } finally {
    closeBackends(backends);
  }
  emit({
    stage: 'deterministic_fallback',
    provider: 'scripted',
    model: 'safe-single-lane',
    message: 'Using the deterministic safe single-lane kickoff so the match can start.',
  });
  return {
    ...initial,
    warnings: [
      ...initial.warnings,
      `YELLOW CARD: no configured manager produced a valid kickoff DAG; using the safe single-lane proposal. ${failures.join(' | ')}`.slice(0, 4_000),
    ],
  };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'string' && /(key|token|secret|password)=/iu.test(item)) return '[REDACTED]';
    return item;
  });
}

async function loadSessionEvents(id: string): Promise<{ events: SessionEvent[]; state: SessionState }> {
  const store = await JsonlEventStore.open({ directory: await sessionDir(id), sessionId: id });
  try {
    const [events, state] = await Promise.all([store.readEvents(), store.loadState()]);
    return { events, state };
  } finally {
    await store.close();
  }
}

interface LiveRunOptions {
  args: ParsedArguments;
  metadata: SessionMetadata;
  directory: string;
  proposal: KickoffProposal;
  config: GoalieConfig;
  resume?: boolean;
  initialEvents?: readonly SessionEvent[];
}

async function executeLiveRun(options: LiveRunOptions): Promise<GauntletRunResult> {
  const headless = flag(options.args, 'headless') || !process.stdout.isTTY;
  const noMotion = flag(options.args, 'no-motion') || options.config.motion === 'none';
  const motionMode = noMotion
    ? 'none' as const
    : options.config.motion === 'reduced'
      ? 'reduced' as const
      : 'auto' as const;
  const controller = new AbortController();
  const restoredBroadcast = options.initialEvents?.length
    ? replayBroadcast('Goalie Control Room', options.proposal.spec.goal, options.initialEvents)
    : undefined;
  const broadcastWithoutHistoricalAnimations = restoredBroadcast
    ? (({ verdicts: _verdicts, latestVerdict: _latest, ...rest }) => ({ ...rest, verdicts: [] }))(restoredBroadcast)
    : undefined;
  let broadcast = broadcastWithoutHistoricalAnimations ?? createBroadcastSession('Goalie Control Room', options.proposal.spec.goal);
  let ink: InkInstance | undefined;
  let quitArmedUntil = 0;
  let runner!: GauntletRunner;
  let durableMetadata = options.metadata;
  const backends = createBackends(options.config);
  const followAgentOutput = flag(options.args, 'follow-agent-output');

  const renderApp = (): void => {
    if (!ink) return;
    ink.rerender(createElement(App, {
      session: broadcast,
      interactive: true,
      motionMode,
      followAgentOutput,
      onSubmitPrompt: (prompt: string) => { void runner.recordSteering(prompt); },
      onPause: () => controller.abort(new Error('Paused by user')),
      onInterrupt: () => controller.abort(new Error('Interrupt requested')),
      onExit: () => {
        const now = Date.now();
        if (now <= quitArmedUntil) {
          controller.abort(new Error('Quit confirmed'));
          return;
        }
        quitArmedUntil = now + 4_000;
        broadcast = {
          ...broadcast,
          transcript: [...broadcast.transcript, {
            id: `quit:${now}`,
            kind: 'warning' as const,
            label: 'FULL TIME?',
            text: 'Press q again within four seconds to checkpoint and stop.',
            timestamp: new Date().toISOString(),
          }].slice(-800),
        };
        renderApp();
      },
    }));
  };

  runner = new GauntletRunner({
    sessionId: options.metadata.id,
    sessionDirectory: options.directory,
    sourceWorkspace: options.metadata.workspace,
    proposal: options.proposal,
    config: options.config,
    backends,
    ...(options.metadata.baseSha ? { baseSha: options.metadata.baseSha } : {}),
    ...(options.resume ? { resume: true } : {}),
    signal: controller.signal,
    onEvent: async ({ event, state }) => {
      broadcast = reduceBroadcast(broadcast, event, state);
      if (event.kind === 'session.status_changed') {
        durableMetadata = {
          ...durableMetadata,
          status: state.status,
          updatedAt: event.timestamp,
        };
        await writeSessionMetadata(durableMetadata);
      }
      if (
        options.args.command === 'demo' &&
        flag(options.args, 'crash-after-checkpoint') &&
        !options.resume &&
        event.kind === 'workspace.checkpoint'
      ) {
        // This opt-in demo fault is deliberately a real, uncatchable process
        // death. The checkpoint event and Git commit have already fsynced;
        // `goalie resume <session>` must recover from those durable facts.
        writeSync(2, `\nDECLARED FAULT INJECTION — SIGKILL after durable checkpoint ${event.sequence}. Resume session ${options.metadata.id}.\n`);
        process.kill(process.pid, 'SIGKILL');
      }
      if (headless) {
        if (event.kind !== 'backend.text_delta' && event.kind !== 'backend.reasoning_delta') {
          process.stdout.write(`${safeJson({ sequence: event.sequence, kind: event.kind, status: state.status })}\n`);
        }
      } else {
        renderApp();
      }
    },
  });

  const signalHandler = (): void => controller.abort(new Error('Interrupt requested'));
  process.once('SIGINT', signalHandler);
  if (!headless) {
    ink = render(createElement(App, {
      session: broadcast,
      interactive: true,
      motionMode,
      followAgentOutput,
      onSubmitPrompt: (prompt: string) => { void runner.recordSteering(prompt); },
      onPause: () => controller.abort(new Error('Paused by user')),
      onInterrupt: () => controller.abort(new Error('Interrupt requested')),
      onExit: () => {
        if (Date.now() <= quitArmedUntil) controller.abort(new Error('Quit confirmed'));
        else {
          quitArmedUntil = Date.now() + 4_000;
          broadcast = { ...broadcast, transcript: [...broadcast.transcript, { id: `quit:${Date.now()}`, kind: 'warning' as const, text: 'Press q again within four seconds to checkpoint and stop.', label: 'FULL TIME?' }] };
          renderApp();
        }
      },
    }), { exitOnCtrlC: false, patchConsole: false });
  }

  try {
    const result = await runner.run();
    if (!headless) {
      renderApp();
      const finalReplayMs = noMotion
        ? 150
        : motionMode === 'reduced'
          ? 750
          : DEFAULT_ANIMATION_DURATION_MS + 100;
      await new Promise(resolveDelay => setTimeout(resolveDelay, finalReplayMs));
    }
    return result;
  } finally {
    process.removeListener('SIGINT', signalHandler);
    ink?.unmount();
    closeBackends(backends);
  }
}

async function persistResolvedSession(directory: string, config: GoalieConfig, proposal: KickoffProposal): Promise<void> {
  await writeFile(join(directory, 'resolved-config.json'), `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await writeFile(join(directory, 'gauntlet-spec.json'), `${JSON.stringify(proposal, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

interface SuppliedRun {
  cwd: string;
  goal: string;
  config: GoalieConfig;
  onKickoffProgress?: (progress: KickoffManagerProgress) => void;
}

async function runCommand(args: ParsedArguments, supplied?: SuppliedRun): Promise<void> {
  const cwd = supplied?.cwd ?? resolve(stringFlag(args, 'cwd') ?? process.cwd());
  const goal = supplied?.goal ?? await resolveGoal(args);
  if (!goal) throw new Error('The goal is empty.');
  const config = supplied?.config ?? await loadConfig(cwd, configOverrides(args));
  if (config.commands.length > 0) {
    const containment = await commandContainmentPreflight();
    if (!containment.available) {
      throw new Error(`Required ${containment.mechanism} command containment is unavailable: ${containment.reason ?? 'unknown reason'}. Run goalie doctor for details.`);
    }
  }
  const repository = await new GitWorktreeManager().requireClean(cwd);
  const initialProposal = await createKickoffProposal(goal, repository.root, config);
  const providerPlanningTimeoutMs = args.command === 'demo' ? 12_000 : 45_000;
  const totalPlanningTimeoutMs = args.command === 'demo' ? 24_000 : 90_000;
  let lastPrintedHeartbeatSecond = -1;
  const kickoffUpdates: KickoffManagerProgress[] = [];
  const showKickoffTui = !flag(args, 'headless') && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let kickoffInk: InkInstance | undefined;
  const kickoffView = () => createElement(KickoffProgress, {
    goal,
    progress: kickoffUpdates,
    providerTimeoutMs: providerPlanningTimeoutMs,
    totalTimeoutMs: totalPlanningTimeoutMs,
  });
  if (showKickoffTui) kickoffInk = render(kickoffView(), { exitOnCtrlC: false, patchConsole: false });

  const onKickoffProgress = (progress: KickoffManagerProgress): void => {
    kickoffUpdates.push(progress);
    if (kickoffUpdates.length > 100) kickoffUpdates.splice(0, kickoffUpdates.length - 100);
    supplied?.onKickoffProgress?.(progress);
    if (kickoffInk) {
      kickoffInk.rerender(kickoffView());
      return;
    }
    const elapsedSeconds = Math.floor(progress.elapsedMs / 1_000);
    if (progress.stage === 'heartbeat') {
      if (elapsedSeconds === lastPrintedHeartbeatSecond || elapsedSeconds % 3 !== 0) return;
      lastPrintedHeartbeatSecond = elapsedSeconds;
    }
    process.stdout.write(`KICKOFF · ${progress.message}\n`);
  };

  let proposal: KickoffProposal;
  try {
    proposal = await createManagerPlannedProposal(initialProposal, config, repository.root, {
      providerTimeoutMs: providerPlanningTimeoutMs,
      totalTimeoutMs: totalPlanningTimeoutMs,
      onProgress: onKickoffProgress,
    });
  } finally {
    kickoffInk?.unmount();
  }
  if (!(await confirmKickoff(formatKickoffProposal(proposal), flag(args, 'yes')))) {
    process.stdout.write('Kickoff cancelled; no session was created.\n');
    return;
  }

  const now = new Date().toISOString();
  const id = createSessionId();
  const metadata: SessionMetadata = {
    schemaVersion: 1,
    id,
    goal,
    workspace: repository.root,
    status: 'created',
    createdAt: now,
    updatedAt: now,
    baseSha: repository.headSha,
  };
  const directory = await createSession(metadata);
  await persistResolvedSession(directory, config, proposal);
  process.stdout.write(`Session ${id} · durable state ${directory}\n`);

  try {
    const result = await executeLiveRun({ args, metadata, directory, proposal, config });
    const finalSha = await new GitWorktreeManager().head(result.integration);
    await writeSessionMetadata({
      ...metadata,
      status: result.state.status,
      updatedAt: new Date().toISOString(),
      integrationBranch: result.integration.branch,
      finalSha,
    });
    process.stdout.write(`\n${result.state.status.toUpperCase()} · ${id}\n`);
    if (result.state.status !== 'achieved') process.exitCode = 2;
  } catch (error) {
    await writeSessionMetadata({ ...metadata, status: 'failed', updatedAt: new Date().toISOString() }).catch(() => undefined);
    throw error;
  }
}

function applySavedOverrides(config: GoalieConfig, args: ParsedArguments): GoalieConfig {
  const overrides = configOverrides(args);
  return goalieConfigSchema.parse({
    ...config,
    providers: {
      ...config.providers,
      ...(overrides.manager ? { manager: overrides.manager } : {}),
      ...(overrides.builder ? { builder: overrides.builder } : {}),
      ...(overrides.critic ? { critic: overrides.critic } : {}),
    },
    budget: {
      ...config.budget,
      ...(overrides.maxMinutes ? { maxMinutes: overrides.maxMinutes } : {}),
      ...(overrides.maxTurns ? { maxTurns: overrides.maxTurns } : {}),
      ...(overrides.maxCostUsd ? { maxCostUsd: overrides.maxCostUsd } : {}),
      ...(overrides.concurrency ? { concurrency: overrides.concurrency } : {}),
    },
    ...(overrides.motion ? { motion: overrides.motion } : {}),
  });
}

async function resumeCommand(args: ParsedArguments): Promise<void> {
  const requested = args.positional[0] ?? (await listSessions())[0]?.id;
  if (!requested) throw new Error('There are no sessions to resume.');
  const id = await resolveSessionId(requested);
  const metadata = await readSessionMetadata(id);
  const directory = await sessionDir(id);
  const loaded = await loadSessionEvents(id);
  if (['achieved', 'safety_halt'].includes(loaded.state.status)) {
    throw new Error(`Session ${id} is terminal (${loaded.state.status}).`);
  }
  const saved = goalieConfigSchema.parse(JSON.parse(await readFile(join(directory, 'resolved-config.json'), 'utf8')) as unknown);
  const durablePolicyFingerprint = loaded.state.spec.metadata.policyFingerprint;
  if (typeof durablePolicyFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(durablePolicyFingerprint)) {
    throw new Error('Session does not contain a durable resolved-policy fingerprint; refusing an unauthenticated resume.');
  }
  if (resolvedPolicyFingerprint(saved) !== durablePolicyFingerprint) {
    throw new Error('Resolved execution policy differs from the hash-chained kickoff contract; refusing resume.');
  }
  if (['manager', 'builder', 'critic', 'concurrency', 'openrouter-model', 'openrouter-only'].some(name => args.flags.has(name))) {
    throw new Error('Provider lineup and concurrency are immutable after kickoff; only explicit time/turn/cost extensions are accepted on resume.');
  }
  const config = applySavedOverrides(saved, args);
  if (loaded.state.status === 'paused_budget' && !['max-minutes', 'max-turns', 'max-cost'].some(name => args.flags.has(name))) {
    throw new Error('This session exhausted its budget; explicitly extend --max-minutes, --max-turns, or --max-cost.');
  }
  const proposal: KickoffProposal = {
    spec: {
      ...loaded.state.spec,
      budget: {
        ...loaded.state.spec.budget,
        maxWallTimeMs: config.budget.maxMinutes * 60_000,
        maxTurns: config.budget.maxTurns,
        maxCostUsd: config.budget.maxCostUsd,
        maxConcurrency: config.budget.concurrency,
      },
      metadata: { ...loaded.state.spec.metadata, resumedAt: new Date().toISOString() },
    },
    tasks: Object.values(loaded.state.tasks),
    providerSummary: `${config.providers.manager} manager · ${config.providers.builder} builder · ${config.providers.critic} critic · ${config.providers.integrator} integrator`,
    warnings: ['Resume will fail closed unless the hash chain, lane heads, registrations, and clean worktrees match the last durable checkpoints.'],
  };
  const amendmentPath = join(directory, `resolved-config.resume-${Date.now()}.json`);
  await writeFile(amendmentPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    const result = await executeLiveRun({ args, metadata, directory, proposal, config, resume: true, initialEvents: loaded.events });
    const finalSha = await new GitWorktreeManager().head(result.integration);
    await writeSessionMetadata({ ...metadata, status: result.state.status, updatedAt: new Date().toISOString(), integrationBranch: result.integration.branch, finalSha });
    process.stdout.write(`\n${result.state.status.toUpperCase()} · ${id}\n`);
    if (result.state.status !== 'achieved') process.exitCode = 2;
  } catch (error) {
    const recovered = await loadSessionEvents(id).catch(() => undefined);
    await writeSessionMetadata({ ...metadata, status: recovered?.state.status ?? 'failed', updatedAt: new Date().toISOString() }).catch(() => undefined);
    throw error;
  }
}

async function listCommand(): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    process.stdout.write('No Goalie sessions.\n');
    return;
  }
  process.stdout.write(`${'SESSION'.padEnd(23)} ${'STATUS'.padEnd(18)} ${'UPDATED'.padEnd(25)} GOAL\n`);
  for (const session of sessions) {
    process.stdout.write(`${session.id.padEnd(23)} ${session.status.padEnd(18)} ${session.updatedAt.padEnd(25)} ${session.goal.replaceAll(/\s+/g, ' ').slice(0, 70)}\n`);
  }
}

async function resolveReplayInput(input: string): Promise<{ banner: string; events: SessionEvent[]; goal?: string; bundle?: ReplayBundle }> {
  try {
    await access(resolve(input), constants.R_OK);
    const bundle = await readReplayBundle(resolve(input));
    if (!bundle.verified) throw new Error('Replay bundle integrity or signature verification failed.');
    return {
      banner: replayBanner(bundle, true),
      events: bundle.events.map(event => SessionEventSchema.parse(event)),
      bundle,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const id = await resolveSessionId(input);
  const metadata = await readSessionMetadata(id);
  const loaded = await loadSessionEvents(id);
  return { banner: 'REPLAY — DURABLE SESSION — NO ACTIVE AGENTS', events: loaded.events, goal: metadata.goal };
}

async function replayCommand(
  args: ParsedArguments,
  forcedInput?: string,
  objectiveOverride?: string,
  persistAfterReplay = false,
  targetDurationMs?: number,
): Promise<void> {
  const input = forcedInput ?? args.positional[0];
  if (!input) throw new Error('Usage: goalie replay <session|bundle> [--speed N]');
  const source = await resolveReplayInput(input);
  const speed = positiveNumberFlag(args, 'speed') ?? 1;
  process.stdout.write(`${source.banner} · ${speed}×\n`);
  if (flag(args, 'headless') || !process.stdout.isTTY) {
    const session = replayBroadcast(source.banner, objectiveOverride ?? source.goal, source.events);
    process.stdout.write(`${JSON.stringify({ status: session.status, phase: session.phase, loops: session.loop, checkpoints: session.checkpoint, score: session.score, eventCount: source.events.length }, null, 2)}\n`);
    return;
  }
  let session: BroadcastSession = createBroadcastSession(source.banner, objectiveOverride ?? source.goal);
  const noMotion = flag(args, 'no-motion');
  const verdictAnimationDurationMs = noMotion
    ? 120
    : Math.max(1, Math.round(DEFAULT_ANIMATION_DURATION_MS / speed));
  const playbackDurationMs = targetDurationMs === undefined
    ? undefined
    : Math.max(1_000, targetDurationMs / speed);
  const playbackStartedAt = Date.now();
  let stopped = false;
  let paused = false;
  let pausedAt: number | undefined;
  let accumulatedPausedMs = 0;
  let lastClockSecond = -1;
  let ink!: InkInstance;
  const activeElapsedMs = (): number => {
    const currentPauseMs = pausedAt === undefined ? 0 : Date.now() - pausedAt;
    return Math.max(0, Date.now() - playbackStartedAt - accumulatedPausedMs - currentPauseMs);
  };
  const displaySession = (): BroadcastSession => ({
    ...session,
    ...(playbackDurationMs === undefined
      ? {}
      : { elapsedMs: Math.min(playbackDurationMs, activeElapsedMs()) }),
    ...(paused
      ? { status: 'paused' as const, phase: 'HALFTIME' }
      : {}),
  });
  const replayApp = () => createElement(App, {
    session: displaySession(),
    interactive: true,
    motionMode: noMotion ? 'none' as const : 'auto' as const,
    animationDurationMs: verdictAnimationDurationMs,
    followAgentOutput: flag(args, 'follow-agent-output'),
    onExit: () => { stopped = true; ink.unmount(); },
    onInterrupt: () => { stopped = true; ink.unmount(); },
    onPause: () => {
      if (session.status === 'complete') return;
      if (paused) {
        accumulatedPausedMs += Date.now() - (pausedAt ?? Date.now());
        pausedAt = undefined;
        paused = false;
      } else {
        paused = true;
        pausedAt = Date.now();
      }
      ink.rerender(replayApp());
    },
  });
  ink = render(replayApp(), { patchConsole: false });
  const waitForActiveTime = async (targetMs: number): Promise<void> => {
    while (!stopped && activeElapsedMs() < targetMs) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
      const clockSecond = Math.floor(activeElapsedMs() / 1_000);
      if (clockSecond !== lastClockSecond) {
        lastClockSecond = clockSecond;
        ink.rerender(replayApp());
      }
    }
  };
  let previousTimestamp: number | undefined;
  for (const [index, event] of source.events.entries()) {
    if (stopped) break;
    const timestamp = Date.parse(event.timestamp);
    if (playbackDurationMs !== undefined) {
      const denominator = Math.max(1, source.events.length - 1);
      await waitForActiveTime((index / denominator) * playbackDurationMs);
    } else if (previousTimestamp !== undefined) {
      const delay = Math.min(350, Math.max(0, timestamp - previousTimestamp)) / speed;
      if (delay > 1) await waitForActiveTime(activeElapsedMs() + delay);
    }
    if (stopped) break;
    session = reduceBroadcast(session, event);
    ink.rerender(replayApp());
    if (event.kind === 'critic.verdict_recorded') {
      await new Promise(resolveDelay => setTimeout(
        resolveDelay,
        noMotion ? 120 : verdictAnimationDurationMs + 80,
      ));
    }
    previousTimestamp = timestamp;
  }
  if (stopped) return;
  if (persistAfterReplay) {
    await ink.waitUntilExit();
    return;
  }
  await new Promise(resolveDelay => setTimeout(resolveDelay, noMotion ? 150 : 1_250));
  if (!stopped) ink.unmount();
}

async function promptForDemoGoal(args: ParsedArguments, mode: GoalPromptMode): Promise<string | undefined> {
  const promptFile = stringFlag(args, 'prompt-file');
  const fromFile = promptFile ? (await readFile(resolve(promptFile), 'utf8')).trim() : undefined;
  const positional = args.positional.join(' ').trim();
  const providedGoal = fromFile || positional || undefined;

  // CI, piping, and explicit headless mode cannot host an interactive Ink
  // editor. They still receive the same concrete fixture goal deterministically.
  if (flag(args, 'headless') || !process.stdin.isTTY || !process.stdout.isTTY) {
    return providedGoal ?? PENALTY_LEDGER_GOAL;
  }

  return await new Promise<string | undefined>(resolveGoal => {
    let settled = false;
    let ink: InkInstance | undefined;
    const finish = (goal: string | undefined): void => {
      if (settled) return;
      settled = true;
      ink?.unmount();
      resolveGoal(goal);
    };
    ink = render(createElement(GoalPrompt, {
      mode,
      initialValue: providedGoal ?? '',
      suggestion: 'Repair the Penalty Ledger so shot ingestion is exactly-once and replay is crash-safe and deterministic.',
      onSubmit: (goal: string) => finish(goal),
      onCancel: () => finish(undefined),
    }), { exitOnCtrlC: false, patchConsole: false });
  });
}

async function demoCommand(args: ParsedArguments): Promise<void> {
  const live = flag(args, 'live');
  const goal = await promptForDemoGoal(args, live ? 'live' : 'replay');
  if (!goal) {
    process.stdout.write('Demo kickoff cancelled.\n');
    return;
  }
  if (!live) {
    const candidate = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'demo', 'penalty-ledger.replay.json');
    try {
      await access(candidate, constants.R_OK);
    } catch {
      throw new Error('The recorded demo bundle is not installed. Use `goalie demo --live` to run the genuine fixture.');
    }
    await replayCommand(args, candidate, goal, true, 5 * 60_000);
    return;
  }
  const cwd = await createPenaltyLedgerFixture();
  const base = await loadConfig(cwd, configOverrides(args));
  const demoConfig = goalieConfigSchema.parse({
    ...base,
    commands: [
      { id: 'test', executable: process.execPath, args: ['--experimental-strip-types', '--test', 'tests/ledger.test.ts'], cwd: '.', timeoutMs: 60_000, network: false, mutating: false, env: {} },
      { id: 'verify', executable: process.execPath, args: ['--experimental-strip-types', '--test', 'tests/ledger.test.ts', 'verifiers/crash-and-concurrency.test.ts'], cwd: '.', timeoutMs: 60_000, network: false, mutating: false, env: {} },
    ],
    protectedPaths: [...base.protectedPaths, 'verifiers/**'],
  });
  const liveArgs: ParsedArguments = { ...args, flags: new Map(args.flags) };
  await runCommand(liveArgs, { cwd, goal, config: demoConfig });
}

async function doctorCommand(args: ParsedArguments): Promise<void> {
  const cwd = resolve(stringFlag(args, 'cwd') ?? process.cwd());
  process.stdout.write('Goalie doctor — running bounded local checks…\n');
  const checks = await runDoctor(cwd, {
    onCheck: check => process.stdout.write(`${formatDoctor([check])}\n`),
  });
  const requiredFailures = checks.filter(check => check.required && !check.ok).length;
  process.stdout.write(requiredFailures === 0
    ? 'Ready: all required checks passed.\n'
    : `Not ready: ${requiredFailures} required check${requiredFailures === 1 ? '' : 's'} failed.\n`);
  if (checks.some(check => check.required && !check.ok)) process.exitCode = 1;
}

async function initCommand(args: ParsedArguments): Promise<void> {
  const cwd = resolve(stringFlag(args, 'cwd') ?? process.cwd());
  const path = await writeProjectConfig(cwd, flag(args, 'force'));
  process.stdout.write(`Initialized ${path}\n`);
}

async function landCommand(args: ParsedArguments): Promise<void> {
  const requested = args.positional[0];
  if (!requested) throw new Error('Usage: goalie land <session> [--yes]');
  const id = await resolveSessionId(requested);
  const metadata = await readSessionMetadata(id);
  const loaded = await loadSessionEvents(id);
  if (loaded.state.status !== 'achieved') throw new Error(`Only verified achieved sessions can land; ${id} is ${loaded.state.status}.`);
  if (!metadata.integrationBranch || !metadata.baseSha || !metadata.finalSha) throw new Error('Session metadata does not contain an integration branch/base/final SHA.');
  const repository = await new GitWorktreeManager().requireClean(metadata.workspace);
  if (repository.headSha !== metadata.baseSha) {
    throw new Error(`User branch diverged from ${metadata.baseSha.slice(0, 12)}; export a replay/patch instead of landing.`);
  }
  const branchHead = (await execa('git', ['rev-parse', metadata.integrationBranch], { cwd: repository.root })).stdout.trim();
  const durableFinal = [...loaded.events].reverse().find(event => event.kind === 'workspace.integration_checkpoint');
  const durableSha = durableFinal?.payload && typeof durableFinal.payload === 'object'
    ? (durableFinal.payload as { commitSha?: unknown }).commitSha
    : undefined;
  if (branchHead !== metadata.finalSha || durableSha !== metadata.finalSha) {
    throw new Error('Integration branch no longer matches the independently audited durable checkpoint.');
  }
  const summary = (await execa('git', ['diff', '--stat', `${metadata.baseSha}..${metadata.finalSha}`], { cwd: repository.root })).stdout.trim();
  if (!(await confirmKickoff(`LAND PREVIEW\n${metadata.integrationBranch} → ${repository.branch ?? '(detached)'}\n${metadata.baseSha.slice(0, 12)}..${metadata.finalSha.slice(0, 12)}\n${summary || 'No file changes'}`, flag(args, 'yes')))) {
    process.stdout.write('Land cancelled.\n');
    return;
  }
  await execa('git', ['merge', '--ff-only', metadata.integrationBranch], { cwd: repository.root });
  process.stdout.write(`Landed ${id} on ${repository.branch ?? 'detached HEAD'}.\n`);
}

async function exportCommand(args: ParsedArguments): Promise<void> {
  const requested = args.positional[0];
  if (!requested) throw new Error('Usage: goalie export <session> [--output FILE]');
  const id = await resolveSessionId(requested);
  const metadata = await readSessionMetadata(id);
  const loaded = await loadSessionEvents(id);
  const finalSha = metadata.finalSha ?? metadata.baseSha ?? 'unknown';
  if (metadata.integrationBranch && metadata.finalSha) {
    const branchHead = (await execa('git', ['rev-parse', metadata.integrationBranch], { cwd: metadata.workspace })).stdout.trim();
    if (branchHead !== metadata.finalSha) throw new Error('Integration branch moved after the durable run; refusing export.');
  }
  const backendVersions: Record<string, string> = {};
  for (const event of loaded.events) {
    if (event.kind === 'provider.resolved' && event.payload && typeof event.payload === 'object') {
      const payload = event.payload as { backend?: unknown; version?: unknown };
      if (typeof payload.backend === 'string' && typeof payload.version === 'string') {
        backendVersions[payload.backend] = payload.version;
      }
      continue;
    }
    if (event.kind.startsWith('backend.') && event.payload && typeof event.payload === 'object') {
      const backend = (event.payload as { backend?: unknown }).backend;
      if (typeof backend === 'string' && backendVersions[backend] === undefined) {
        backendVersions[backend] = 'unreported-at-run';
      }
    }
  }
  const artifactHashes: Record<string, string> = {};
  if (/^[a-f0-9]{40,64}$/u.test(finalSha)) {
    const tree = await execa('git', ['ls-tree', '-r', '--full-tree', '-z', finalSha], {
      cwd: metadata.workspace,
      maxBuffer: 64 * 1024 * 1024,
    });
    artifactHashes['git-tree'] = createHash('sha256').update(tree.stdout).digest('hex');
  }
  const unsignedBundle = createReplayBundle({
    source: 'recorded_live',
    edited: false,
    recordedAt: metadata.updatedAt,
    harnessVersion: VERSION,
    backendVersions,
    baseSha: metadata.baseSha ?? 'unknown',
    finalSha,
    redaction: 'redacted',
    fixture: basename(metadata.workspace),
  }, loaded.events, artifactHashes);
  const bundle = signReplayBundle(unsignedBundle, await loadOrCreateReplaySigningKey());
  const output = resolve(stringFlag(args, 'output') ?? `goalie-${id}.replay.json`);
  await mkdir(dirname(output), { recursive: true });
  await writeReplayBundle(output, bundle);
  await writeSessionMetadata({ ...metadata, replayBundle: output, updatedAt: new Date().toISOString() });
  process.stdout.write(`Exported signed replay bundle to ${output} (Ed25519 key ${bundle.signature!.keyFingerprint.slice(0, 12)}; no identity or time attestation).\n`);
}

async function gcOne(id: string): Promise<void> {
  const metadata = await readSessionMetadata(id);
  if (!DELETABLE_STATUSES.has(metadata.status)) throw new Error(`Session ${id} is ${metadata.status}; stop it before cleanup.`);
  const directory = await sessionDir(id);
  const worktreeList = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: metadata.workspace });
  const paths = worktreeList.stdout.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
  for (const path of paths.filter(path => resolve(path).startsWith(`${resolve(directory)}${process.platform === 'win32' ? '\\' : '/'}`))) {
    await execa('git', ['worktree', 'remove', '--force', path], { cwd: metadata.workspace });
  }
  const branches = (await execa('git', ['for-each-ref', '--format=%(refname:short)', `refs/heads/goalie/${id}/`], { cwd: metadata.workspace })).stdout.split('\n').filter(Boolean);
  for (const branch of branches) await execa('git', ['branch', '-D', branch], { cwd: metadata.workspace });
  await removeSession(id);
}

async function gcCommand(args: ParsedArguments): Promise<void> {
  const candidates = args.positional[0]
    ? [await resolveSessionId(args.positional[0])]
    : (await listSessions()).filter(session => DEFAULT_GC_STATUSES.has(session.status)).map(session => session.id);
  if (candidates.length === 0) {
    process.stdout.write('No terminal sessions to clean.\n');
    return;
  }
  if (!(await confirmKickoff(`CLEANUP PREVIEW\n${candidates.join('\n')}\nSession worktrees, branches, and durable logs will be permanently removed.`, flag(args, 'yes')))) {
    process.stdout.write('Cleanup cancelled.\n');
    return;
  }
  for (const id of candidates) await gcOne(id);
  process.stdout.write(`Removed ${candidates.length} session(s); this cannot be recovered except from prior exports.\n`);
}

function help(): string {
  return `Goalie v${VERSION} — evidence-driven long-horizon gauntlets

Usage:
  goalie run [goal] [--prompt-file FILE] [--yes] [--headless]
             [--openrouter-model ID] [--openrouter-only] [--follow-agent-output]
  goalie resume [session] [--max-turns N|--max-minutes N|--max-cost USD]
                [--follow-agent-output]
  goalie list
  goalie replay <session|bundle> [--speed N] [--headless] [--follow-agent-output]
  goalie demo [--live] [--crash-after-checkpoint] [--headless]
              [--openrouter-model ID] [--openrouter-only] [--follow-agent-output]
  goalie doctor
  goalie init [--force]
  goalie land <session> [--yes]
  goalie export <session> [--output FILE]
  goalie gc [session] [--yes]

Lineup/budget flags:
  --manager PROVIDER  --builder PROVIDER  --critic PROVIDER
  --max-minutes N     --max-turns N       --max-cost USD
  --concurrency N     --no-motion         --cwd PATH
  --follow-agent-output  show the tab producing the newest transcript line
  --env-file FILE     explicitly load trusted provider secrets (never implicit)

References and repository content are untrusted evidence. Only the kickoff
contract, versioned user steering, and host policy can direct a run.`;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArguments(argv);
  const environmentFile = stringFlag(args, 'env-file');
  if (environmentFile) {
    const loaded = loadDotenv({ path: resolve(environmentFile), override: false, quiet: true });
    if (loaded.error) throw new Error(`Unable to load explicit --env-file: ${loaded.error.message}`);
  }
  if (flag(args, 'version') || args.command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (flag(args, 'help') || args.command === 'help') {
    process.stdout.write(`${help()}\n`);
    return;
  }
  switch (args.command) {
    case 'run': await runCommand(args); break;
    case 'resume': await resumeCommand(args); break;
    case 'list': await listCommand(); break;
    case 'replay': await replayCommand(args); break;
    case 'demo': await demoCommand(args); break;
    case 'doctor': await doctorCommand(args); break;
    case 'init': await initCommand(args); break;
    case 'land': await landCommand(args); break;
    case 'export': await exportCommand(args); break;
    case 'gc': await gcCommand(args); break;
    default: throw new Error(`Unknown command: ${args.command}\n\n${help()}`);
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === resolve(fileURLToPath(import.meta.url))) {
  void main().catch(error => {
    process.stderr.write(`Goalie: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
