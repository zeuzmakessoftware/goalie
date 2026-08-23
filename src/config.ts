import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

export const providerIdSchema = z.enum(['openrouter', 'codex', 'claude', 'scripted']);
export type ProviderId = z.infer<typeof providerIdSchema>;

export const budgetSchema = z.object({
  maxMinutes: z.number().int().positive().default(240),
  maxTurns: z.number().int().positive().default(200),
  maxCostUsd: z.number().positive().default(25),
  concurrency: z.number().int().min(1).max(9).default(3),
  plateauCycles: z.number().int().min(2).max(10).default(3),
});

export const approvedCommandSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9:_-]*$/),
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  allowedArgs: z.array(z.string()).default([]),
  cwd: z.string().default('.'),
  timeoutMs: z.number().int().positive().max(3_600_000).default(120_000),
  network: z.boolean().default(false),
  mutating: z.boolean().default(false),
  env: z.record(z.string(), z.string()).default({}),
});

export const goalieConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  profile: z.string().default('standard-match'),
  providers: z.object({
    manager: providerIdSchema.default('openrouter'),
    builder: providerIdSchema.default('codex'),
    critic: providerIdSchema.default('claude'),
    integrator: providerIdSchema.default('codex'),
    fallback: z.array(providerIdSchema).default(['claude', 'openrouter']),
  }).prefault({}),
  models: z.object({
    openrouter: z.string().default('nvidia/nemotron-3-ultra-550b-a55b:free'),
    codex: z.string().optional(),
    claude: z.string().optional(),
  }).prefault({}),
  budget: budgetSchema.prefault({}),
  commands: z.array(approvedCommandSchema).default([
    { id: 'typecheck', executable: 'pnpm', args: ['typecheck'], allowedArgs: [], cwd: '.', timeoutMs: 120_000, network: false, mutating: false, env: {} },
    { id: 'test', executable: 'pnpm', args: ['test'], allowedArgs: [], cwd: '.', timeoutMs: 180_000, network: false, mutating: false, env: {} },
    { id: 'build', executable: 'pnpm', args: ['build'], allowedArgs: [], cwd: '.', timeoutMs: 180_000, network: false, mutating: false, env: {} },
  ]),
  protectedPaths: z.array(z.string()).default(['.git', '.goalie/playbooks']),
  /** Content-addressed, previously promoted procedure playbooks to propose at kickoff. */
  playbooks: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(20).default([]),
  motion: z.enum(['full', 'reduced', 'none']).default('full'),
  allowDegradedCritic: z.boolean().default(false),
});

export type GoalieConfig = z.infer<typeof goalieConfigSchema>;
export type ApprovedCommand = z.infer<typeof approvedCommandSchema>;

export interface ConfigOverrides {
  manager?: ProviderId;
  builder?: ProviderId;
  critic?: ProviderId;
  integrator?: ProviderId;
  fallback?: ProviderId[];
  openrouterModel?: string;
  allowDegradedCritic?: boolean;
  maxMinutes?: number;
  maxTurns?: number;
  maxCostUsd?: number;
  concurrency?: number;
  motion?: GoalieConfig['motion'];
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

export function getConfigDir(): string {
  const configured = process.env.GOALIE_CONFIG_DIR?.trim();
  if (configured) return resolve(expandHome(configured));
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return resolve(expandHome(xdg ? join(xdg, 'goalie') : join(homedir(), '.config', 'goalie')));
}

export function getDataDir(): string {
  const configured = process.env.GOALIE_DATA_DIR?.trim();
  if (configured) return resolve(expandHome(configured));
  const xdg = process.env.XDG_DATA_HOME?.trim();
  return resolve(expandHome(xdg ? join(xdg, 'goalie') : join(homedir(), '.local', 'share', 'goalie')));
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new Error(`Unable to read Goalie config at ${path}: ${(error as Error).message}`);
  }
}

function mergeConfig(base: GoalieConfig, value: unknown): GoalieConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
  const incoming = value as Record<string, unknown>;
  return goalieConfigSchema.parse({
    ...base,
    ...incoming,
    providers: { ...base.providers, ...(incoming.providers as object | undefined) },
    models: { ...base.models, ...(incoming.models as object | undefined) },
    budget: { ...base.budget, ...(incoming.budget as object | undefined) },
    commands: incoming.commands ?? base.commands,
  });
}

export async function loadConfig(cwd: string, overrides: ConfigOverrides = {}): Promise<GoalieConfig> {
  let config = goalieConfigSchema.parse({});
  const globalValue = await readJson(join(getConfigDir(), 'config.json'));
  config = mergeConfig(config, globalValue);
  const projectValue = await readJson(join(cwd, '.goalie', 'config.json'));
  config = mergeConfig(config, projectValue);

  config = goalieConfigSchema.parse({
    ...config,
    providers: {
      ...config.providers,
      ...(overrides.manager ? { manager: overrides.manager } : {}),
      ...(overrides.builder ? { builder: overrides.builder } : {}),
      ...(overrides.critic ? { critic: overrides.critic } : {}),
      ...(overrides.integrator ? { integrator: overrides.integrator } : {}),
      ...(overrides.fallback ? { fallback: overrides.fallback } : {}),
    },
    models: {
      ...config.models,
      openrouter: overrides.openrouterModel ?? (process.env.OPENROUTER_MODEL?.trim() || config.models.openrouter),
    },
    budget: {
      ...config.budget,
      ...(overrides.maxMinutes ? { maxMinutes: overrides.maxMinutes } : {}),
      ...(overrides.maxTurns ? { maxTurns: overrides.maxTurns } : {}),
      ...(overrides.maxCostUsd ? { maxCostUsd: overrides.maxCostUsd } : {}),
      ...(overrides.concurrency ? { concurrency: overrides.concurrency } : {}),
    },
    ...(overrides.allowDegradedCritic === undefined
      ? {}
      : { allowDegradedCritic: overrides.allowDegradedCritic }),
    ...(overrides.motion ? { motion: overrides.motion } : {}),
  });
  return config;
}

export async function writeProjectConfig(cwd: string, force = false): Promise<string> {
  const path = join(cwd, '.goalie', 'config.json');
  if (!force) {
    try {
      await access(path, constants.F_OK);
      throw new Error(`Config already exists at ${path}; pass --force to replace it.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(goalieConfigSchema.parse({}), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

export async function ensureGoalieDataDir(): Promise<string> {
  const path = getDataDir();
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}
