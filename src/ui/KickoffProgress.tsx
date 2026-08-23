import { Box, Text, useStdout } from 'ink';

import { sanitizeTerminalText, singleLine } from './sanitize.js';

export interface KickoffProgressItem {
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
  backend?: { stage: string };
}

export interface KickoffProgressProps {
  goal: string;
  progress: readonly KickoffProgressItem[];
  providerTimeoutMs: number;
  totalTimeoutMs: number;
}

const SPINNER = ['◐', '◓', '◑', '◒'] as const;

function phaseLabel(progress: KickoffProgressItem | undefined): string {
  if (!progress) return 'FORMING UP';
  switch (progress.stage) {
    case 'attempt_started': return 'SCOUTING';
    case 'heartbeat': return 'PLANNING';
    case 'backend': return progress.backend?.stage === 'tool_requested' ? 'INSPECTING' : 'PLANNING';
    case 'attempt_failed': return 'YELLOW CARD';
    case 'transfer_window': return 'TRANSFER WINDOW';
    case 'completed': return 'PLAN READY';
    case 'deterministic_fallback': return 'SAFE FORMATION';
  }
}

/** Small pre-session dashboard: planning happens before an immutable spec exists. */
export function KickoffProgress({
  goal,
  progress,
  providerTimeoutMs,
  totalTimeoutMs,
}: KickoffProgressProps) {
  const { stdout } = useStdout();
  const width = Math.max(48, stdout.columns ?? 92);
  const latest = progress.at(-1);
  const frame = SPINNER[Math.floor((latest?.elapsedMs ?? 0) / 250) % SPINNER.length];
  const seconds = Math.floor((latest?.elapsedMs ?? 0) / 1_000);
  const history = progress
    .filter((item, index) => item.stage !== 'heartbeat' || index === progress.length - 1)
    .slice(-7);

  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">GOALIE // TACTICAL BRIEFING</Text>
        <Text bold color={latest?.stage === 'attempt_failed' ? 'yellow' : 'green'}>
          {frame} {phaseLabel(latest)} · {seconds}s
        </Text>
      </Box>

      <Box marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text bold>IMMUTABLE GOAL</Text>
        <Text>{sanitizeTerminalText(goal, { maxLength: 500, preserveNewlines: false })}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold color="green">MANAGER TOUCHLINE</Text>
        <Text>
          {latest ? `${latest.provider}/${latest.model}` : 'Selecting configured manager…'}
        </Text>
        <Text color="gray">
          Each provider gets at most {Math.round(providerTimeoutMs / 1_000)}s; total planning is capped at {Math.round(totalTimeoutMs / 1_000)}s. A safe deterministic formation starts if providers stall.
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {history.length === 0 ? <Text color="gray">Preparing read-only repository inspection…</Text> : null}
        {history.map((item, index) => (
          <Text
            key={`${item.elapsedMs}:${item.stage}:${index}`}
            color={item.stage === 'attempt_failed'
              ? 'yellow'
              : item.stage === 'completed' || item.stage === 'deterministic_fallback'
                ? 'green'
                : 'white'}
          >
            {String(Math.floor(item.elapsedMs / 1_000)).padStart(3, ' ')}s  {singleLine(item.message, Math.max(30, width - 10))}
          </Text>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text color="gray">Repository access is read-only until you confirm the resolved kickoff contract.</Text>
      </Box>
    </Box>
  );
}

export default KickoffProgress;
