import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execa } from 'execa';
import type { ProviderId } from './config.js';
import { commandContainmentPreflight } from './runtime/tool-broker.js';

export interface DoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

export interface DoctorOptions {
  /** Called as soon as each bounded check finishes. */
  onCheck?: (check: DoctorCheck) => void;
}

const COMMAND_TIMEOUT_MS = 10_000;

function report(check: DoctorCheck, options: DoctorOptions): DoctorCheck {
  options.onCheck?.(check);
  return check;
}

async function executableCheck(id: ProviderId | 'git', command: string, args: string[], required: boolean): Promise<DoctorCheck> {
  try {
    const result = await execa(command, args, {
      reject: false,
      timeout: COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    const detail = (result.stdout || result.stderr || `${command} available`).trim().split('\n')[0] ?? `${command} available`;
    return { id, label: command, ok: result.exitCode === 0, detail, required };
  } catch (error) {
    return { id, label: command, ok: false, detail: (error as Error).message, required };
  }
}

export async function runDoctor(cwd: string, options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  const node = report({
    id: 'node',
    label: 'Node.js',
    ok: major >= 22,
    detail: `${process.version} (requires >=22)`,
    required: true,
  }, options);

  const hasOpenRouter = Boolean(process.env.OPENROUTER_API_KEY?.trim());
  const openrouter = report({
    id: 'openrouter',
    label: 'OpenRouter',
    ok: hasOpenRouter,
    detail: hasOpenRouter ? 'OPENROUTER_API_KEY is set' : 'OPENROUTER_API_KEY is not set',
    required: false,
  }, options);

  // Provider CLIs are independent probes. Run them concurrently so one slow or
  // broken executable cannot make the command look frozen for 30 seconds.
  const gitPromise = executableCheck('git', 'git', ['--version'], true).then(check => report(check, options));
  const codexPromise = executableCheck('codex', 'codex', ['--version'], false).then(check => report(check, options));
  const claudePromise = executableCheck('claude', 'claude', ['--version'], false).then(check => report(check, options));
  const containmentPromise = commandContainmentPreflight({ refresh: true }).then(containment => report({
    id: 'containment',
    label: 'Command containment',
    ok: containment.available,
    detail: containment.available ? containment.mechanism : `${containment.mechanism}: ${containment.reason ?? 'unavailable'}`,
    required: true,
  }, options));
  const workspacePromise = access(cwd, constants.R_OK | constants.W_OK)
    .then(() => report({ id: 'workspace', label: 'Workspace', ok: true, detail: cwd, required: true }, options))
    .catch((error: unknown) => report({ id: 'workspace', label: 'Workspace', ok: false, detail: error instanceof Error ? error.message : String(error), required: true }, options));

  const [git, codex, claude, containment, workspace] = await Promise.all([
    gitPromise,
    codexPromise,
    claudePromise,
    containmentPromise,
    workspacePromise,
  ]);

  // Preserve stable summary ordering even though progress is streamed as each
  // check completes.
  const checks = [node, git, codex, claude, containment, openrouter, workspace];

  const providerCount = checks.filter(check => ['openrouter', 'codex', 'claude'].includes(check.id) && check.ok).length;
  checks.push(report({
    id: 'independence',
    label: 'Cross-provider critics',
    ok: providerCount >= 2,
    detail: providerCount >= 2 ? `${providerCount} provider families available` : 'Only one provider family detected; independent verdicts will be degraded',
    required: false,
  }, options));
  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks.map(check => `${check.ok ? '✓' : check.required ? '✗' : '!'} ${check.label.padEnd(24)} ${check.detail}`).join('\n');
}
