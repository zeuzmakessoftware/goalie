import type { SessionEvent, SessionState, SessionStatus as CoreSessionStatus } from '../core/schemas.js';
import type { AgentSnapshot, BroadcastSession, EvidenceItem, TranscriptEntry } from '../ui/types.js';
import { sanitizeTerminalText } from '../ui/sanitize.js';

const ROLE_NAMES: Record<string, string> = {
  manager: 'Manager',
  worker: 'Worker',
  critic: 'VAR Critic',
  auditor: 'Integrator',
  system: 'Evidence',
};

function uiStatus(status: CoreSessionStatus): BroadcastSession['status'] {
  if (status === 'achieved') return 'complete';
  if (status === 'failed' || status === 'safety_halt') return 'failed';
  if (status.startsWith('paused') || status === 'blocked') return 'paused';
  if (status === 'running') return 'running';
  return 'idle';
}

function phase(status: CoreSessionStatus): string {
  const labels: Partial<Record<CoreSessionStatus, string>> = {
    created: 'Team Sheet',
    planning: 'Tactical Briefing',
    running: 'Open Play',
    achieved: 'Clean Sheet',
    paused_budget: 'Full Time — Budget',
    paused_plateau: 'Stalemate Review',
    paused_approval: 'Referee Check',
    blocked: 'Injury Time',
    safety_halt: 'Red Card',
    user_stopped: 'Match Abandoned',
    failed: 'Final Whistle',
  };
  return labels[status] ?? status;
}

function ensureAgent(agents: readonly AgentSnapshot[], id: string, role: string): AgentSnapshot[] {
  if (agents.some(agent => agent.id === id)) return [...agents];
  return [...agents, { id, name: ROLE_NAMES[role] ?? role, role, status: 'idle', progress: 0 }];
}

function updateAgent(
  agents: readonly AgentSnapshot[],
  id: string,
  role: string,
  patch: Partial<AgentSnapshot>,
): AgentSnapshot[] {
  return ensureAgent(agents, id, role).map(agent => agent.id === id ? { ...agent, ...patch } : agent);
}

function transcript(event: SessionEvent, text: string, kind: TranscriptEntry['kind'], label: string): TranscriptEntry {
  return {
    id: `${event.id}:line`,
    text: sanitizeTerminalText(text, { maxLength: 8_000 }),
    kind,
    ...(event.actor ? { agentId: event.actor.id } : {}),
    timestamp: event.timestamp,
    label,
  };
}

export function createBroadcastSession(title: string, objective?: string): BroadcastSession {
  return {
    title,
    ...(objective ? { objective } : {}),
    status: 'idle',
    phase: 'Team Sheet',
    loop: 0,
    checkpoint: 0,
    budgetUsed: 0,
    score: { goals: 0, saves: 0, reviews: 0 },
    verdicts: [],
    agents: [
      { id: 'manager:goalie', name: 'Manager', role: 'manager', status: 'idle', progress: 0 },
      { id: 'worker:task:implementation', name: 'Worker 1', role: 'worker', status: 'idle', progress: 0 },
      { id: 'auditor:integration', name: 'Integrator', role: 'auditor', status: 'idle', progress: 0 },
      { id: 'critic:1', name: 'VAR Critic', role: 'critic', status: 'idle', progress: 0 },
      { id: 'system:evaluator', name: 'Evidence', role: 'system', status: 'idle', progress: 0 },
    ],
    transcript: [],
    tactics: [],
    evidence: [],
  };
}

export function reduceBroadcast(
  session: BroadcastSession,
  event: SessionEvent,
  state?: SessionState,
): BroadcastSession {
  let next: BroadcastSession = { ...session };
  let agents = [...session.agents];
  const transcriptEntries = [...session.transcript];
  const evidenceItems = [...(session.evidence ?? [])];
  const tactics = [...(session.tactics ?? [])];
  const actorId = event.actor?.id;
  const actorRole = event.actor?.role ?? 'system';

  if (actorId) agents = ensureAgent(agents, actorId, actorRole);

  if (event.kind === 'session.status_changed') {
    const payload = event.payload as { status?: CoreSessionStatus; reason?: string };
    if (payload.status) {
      next = { ...next, status: uiStatus(payload.status), phase: phase(payload.status) };
      if (payload.reason) {
        const label = payload.status === 'achieved'
          ? 'CLEAN SHEET'
          : payload.status === 'safety_halt'
            ? 'RED CARD'
            : 'MATCH';
        transcriptEntries.push(transcript(
          event,
          payload.reason,
          payload.status === 'achieved' ? 'result' : payload.status === 'safety_halt' ? 'error' : 'system',
          label,
        ));
      }
    }
  } else if (event.kind === 'task.started') {
    const payload = event.payload as { taskId: string; agentId: string };
    const iteration = state?.tasks[payload.taskId]?.attempts;
    agents = updateAgent(agents, payload.agentId, 'worker', {
      status: 'working',
      currentTask: payload.taskId,
      ...(iteration !== undefined ? { iteration } : {}),
      progress: 0.25,
    });
    next = { ...next, loop: Math.max(next.loop, state?.tasks[payload.taskId]?.attempts ?? next.loop + 1) };
    transcriptEntries.push(transcript(event, `Attacking ${payload.taskId}`, 'system', 'KICKOFF'));
  } else if (event.kind === 'workspace.checkpoint') {
    const payload = event.payload as { commitSha?: string; changedPaths?: string[] };
    next = { ...next, checkpoint: next.checkpoint + 1 };
    tactics.push({ id: event.id, label: 'HALFTIME', value: `${payload.commitSha?.slice(0, 8) ?? 'checkpoint'} · ${payload.changedPaths?.length ?? 0} files`, status: 'pass' });
    transcriptEntries.push(transcript(event, `Durable checkpoint ${payload.commitSha?.slice(0, 12) ?? ''}`, 'result', 'HALFTIME'));
  } else if (event.kind === 'check.recorded') {
    const payload = event.payload as { check?: { id: string; status: string; summary: string; taskId?: string } };
    if (payload.check) {
      const status: EvidenceItem['status'] = payload.check.status === 'passed' ? 'pass' : payload.check.status === 'running' ? 'running' : 'fail';
      evidenceItems.push({ id: payload.check.id, title: payload.check.id, detail: payload.check.summary, source: 'deterministic verifier', status });
      transcriptEntries.push(transcript(event, payload.check.summary, status === 'pass' ? 'result' : 'error', status === 'pass' ? 'CHECK ✓' : 'CHECK ×'));
    }
  } else if (event.kind === 'critic.verdict_recorded') {
    const payload = event.payload as { verdict?: { id: string; verdict: 'pass' | 'fail' | 'uncertain'; direction: 'positive' | 'negative' | 'neutral'; score: number; summary: string; attempt: number } };
    const verdict = payload.verdict;
    if (verdict) {
      const goals = session.score.goals + (verdict.direction === 'positive' ? 1 : 0);
      const saves = session.score.saves + (verdict.direction === 'negative' ? 1 : 0);
      const reviews = (session.score.reviews ?? 0) + (verdict.direction === 'neutral' ? 1 : 0);
      const latestVerdict = {
        id: verdict.id,
        overall: verdict.verdict,
        direction: verdict.direction,
        score: verdict.score,
        status: 'final' as const,
        summary: verdict.summary,
        revision: verdict.attempt,
      };
      next = {
        ...next,
        score: { goals, saves, reviews },
        latestVerdict,
        verdicts: [...(session.verdicts ?? []), latestVerdict],
      };
      transcriptEntries.push(transcript(event, verdict.summary, 'critic', verdict.direction === 'positive' ? 'GOAL' : verdict.direction === 'negative' ? 'SAVE' : 'VAR'));
      const recent = [...(session.verdicts ?? []), latestVerdict].slice(-3);
      if (recent.length === 3 && recent.every(item => item.overall === 'pass')) {
        transcriptEntries.push(transcript(event, 'Three consecutive task passes.', 'result', 'HAT TRICK'));
      }
      if (actorId) agents = updateAgent(agents, actorId, 'critic', { status: 'done', progress: 1, iteration: verdict.attempt });
    }
  } else if (event.kind.startsWith('backend.')) {
    const payload = event.payload as { backend?: string; item?: Record<string, unknown> };
    const item = payload.item ?? {};
    if (actorId) {
      const terminal = event.kind === 'backend.terminal';
      agents = updateAgent(agents, actorId, actorRole, {
        status: terminal ? (item.status === 'completed' ? 'done' : 'failed') : 'working',
        ...(payload.backend ? { model: payload.backend } : {}),
        progress: terminal ? 1 : 0.5,
      });
    }
    if (event.kind === 'backend.text_delta' && typeof item.text === 'string') {
      const prior = transcriptEntries.at(-1);
      if (prior?.id.endsWith(`:${actorId ?? 'agent'}:stream`)) {
        transcriptEntries[transcriptEntries.length - 1] = { ...prior, text: sanitizeTerminalText(`${prior.text}${item.text}`, { maxLength: 8_000 }) };
      } else {
        transcriptEntries.push({ ...transcript(event, item.text, actorRole === 'critic' ? 'critic' : 'agent', ROLE_NAMES[actorRole] ?? actorRole), id: `${event.id}:${actorId ?? 'agent'}:stream` });
      }
    } else if (event.kind === 'backend.tool_requested') {
      transcriptEntries.push(transcript(event, `${String(item.name ?? 'tool')} requested`, 'tool', 'TOOL'));
    } else if (event.kind === 'backend.tool_completed') {
      transcriptEntries.push(transcript(event, `${String(item.name ?? 'tool')} ${item.isError ? 'failed' : 'completed'}`, item.isError ? 'error' : 'tool', item.isError ? 'YELLOW' : 'TOOL'));
    }
  } else if (event.kind === 'audit.verdict') {
    const payload = event.payload as { overall?: string };
    transcriptEntries.push(transcript(event, `Integration audit: ${payload.overall ?? 'uncertain'}`, payload.overall === 'pass' ? 'result' : 'warning', 'VAR FINAL'));
  } else if (event.kind === 'provider.fallback') {
    transcriptEntries.push(transcript(event, 'Provider reassigned inside the confirmed fallback chain.', 'warning', 'TRANSFER WINDOW'));
  } else if (event.kind === 'session.budget_extended') {
    transcriptEntries.push(transcript(event, 'The user confirmed an explicit match-budget extension.', 'warning', 'EXTRA TIME'));
  } else if (event.kind === 'session.error_recorded') {
    const payload = event.payload as { message?: string };
    transcriptEntries.push(transcript(event, payload.message ?? 'Unknown runtime error', 'error', 'RED CARD'));
  }

  if (state) {
    const maxTurns = state.spec.budget.maxTurns;
    const checkpointLimit = state.spec.checks.length || undefined;
    next = {
      ...next,
      elapsedMs: state.budget.wallTimeMs,
      budgetUsed: state.budget.turns,
      ...(maxTurns !== undefined ? { budgetLimit: maxTurns } : {}),
      ...(checkpointLimit !== undefined ? { checkpointLimit } : {}),
    };
  }
  return {
    ...next,
    agents,
    transcript: transcriptEntries.slice(-800),
    evidence: evidenceItems.slice(-200),
    tactics: tactics.slice(-100),
  };
}

export function replayBroadcast(
  title: string,
  objective: string | undefined,
  events: readonly SessionEvent[],
): BroadcastSession {
  return events.reduce((session, event) => reduceBroadcast(session, event), createBroadcastSession(title, objective));
}
