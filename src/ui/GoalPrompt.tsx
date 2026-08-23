import { useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { sanitizeTerminalText } from './sanitize.js';

export type GoalPromptMode = 'replay' | 'live';

export interface GoalPromptProps {
  mode: GoalPromptMode;
  initialValue?: string;
  suggestion?: string;
  interactive?: boolean;
  onSubmit: (goal: string) => void;
  onCancel?: () => void;
}

interface EditorState {
  value: string;
  cursor: number;
  error: string | undefined;
}

const MAX_GOAL_LENGTH = 4_000;

function cleanGoalInput(value: string): string {
  return sanitizeTerminalText(value, {
    maxLength: MAX_GOAL_LENGTH,
    preserveNewlines: false,
  });
}

function insertAt(value: string, cursor: number, input: string): EditorState {
  const current = Array.from(value);
  const inserted = Array.from(input);
  const room = Math.max(0, MAX_GOAL_LENGTH - current.length);
  const accepted = inserted.slice(0, room);
  const next = [...current.slice(0, cursor), ...accepted, ...current.slice(cursor)];
  return { value: next.join(''), cursor: cursor + accepted.length, error: undefined };
}

/**
 * Persistent kickoff editor shown before a demo starts. It deliberately owns
 * all unmodified keys, including q and the number row, so entering a goal can
 * never trigger dashboard navigation.
 */
export function GoalPrompt({
  mode,
  initialValue = '',
  suggestion,
  interactive = true,
  onSubmit,
  onCancel,
}: GoalPromptProps) {
  const initial = useMemo(() => cleanGoalInput(initialValue), [initialValue]);
  const [editor, setEditor] = useState<EditorState>(() => ({
    value: initial,
    cursor: Array.from(initial).length,
    error: undefined,
  }));
  const { stdout } = useStdout();
  const width = Math.max(48, stdout.columns ?? 92);
  const characters = Array.from(editor.value);
  const before = characters.slice(0, editor.cursor).join('');
  const cursorCharacter = characters[editor.cursor] ?? ' ';
  const after = characters.slice(editor.cursor + (editor.cursor < characters.length ? 1 : 0)).join('');

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === 'c') {
      onCancel?.();
      return;
    }
    if (key.escape) {
      onCancel?.();
      return;
    }
    if (key.return) {
      const goal = editor.value.trim();
      if (!goal) {
        setEditor(current => ({ ...current, error: 'A goal is required before kickoff.' }));
        return;
      }
      onSubmit(goal);
      return;
    }
    if (key.ctrl && input.toLowerCase() === 'u') {
      setEditor({ value: '', cursor: 0, error: undefined });
      return;
    }
    if (key.ctrl && input.toLowerCase() === 'a') {
      setEditor(current => ({ ...current, cursor: 0, error: undefined }));
      return;
    }
    if (key.ctrl && input.toLowerCase() === 'e') {
      setEditor(current => ({
        ...current,
        cursor: Array.from(current.value).length,
        error: undefined,
      }));
      return;
    }
    if (key.leftArrow) {
      setEditor(current => ({ ...current, cursor: Math.max(0, current.cursor - 1), error: undefined }));
      return;
    }
    if (key.rightArrow) {
      setEditor(current => ({
        ...current,
        cursor: Math.min(Array.from(current.value).length, current.cursor + 1),
        error: undefined,
      }));
      return;
    }
    if (key.backspace || key.delete) {
      setEditor(current => {
        const currentCharacters = Array.from(current.value);
        if (key.backspace && current.cursor > 0) {
          currentCharacters.splice(current.cursor - 1, 1);
          return { value: currentCharacters.join(''), cursor: current.cursor - 1, error: undefined };
        }
        if (key.delete && current.cursor < currentCharacters.length) {
          currentCharacters.splice(current.cursor, 1);
          return { value: currentCharacters.join(''), cursor: current.cursor, error: undefined };
        }
        return { ...current, error: undefined };
      });
      return;
    }
    if (key.ctrl || key.meta || key.tab || !input) return;
    const safe = cleanGoalInput(input);
    if (!safe) return;
    setEditor(current => insertAt(current.value, current.cursor, safe));
  }, { isActive: interactive });

  const live = mode === 'live';
  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">GOALIE // GAUNTLET KICKOFF</Text>
        <Text bold color={live ? 'green' : 'yellow'}>
          {live ? 'LIVE FIXTURE' : 'RECORDED REPLAY'}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>One goal. Manager → builders → fresh critic → verified finish.</Text>
        <Text color="gray">
          {live
            ? 'Enter starts active providers on a fresh Penalty Ledger repository.'
            : 'No agents run in standard demo mode. Your goal labels the board while a deterministic fixture replay demonstrates the full loop.'}
        </Text>
        {!live ? (
          <Text color="yellow">Use `pnpm dev demo --live --env-file .env` to execute this goal with active agents.</Text>
        ) : null}
      </Box>

      <Box
        marginTop={1}
        flexDirection="column"
        borderStyle="round"
        borderColor={editor.error ? 'red' : 'cyan'}
        paddingX={1}
      >
        <Text bold color="cyan">YOUR GOAL (EDITABLE)</Text>
        <Text wrap="wrap">
          {before}
          <Text inverse>{cursorCharacter}</Text>
          {after}
        </Text>
      </Box>

      {suggestion && !editor.value ? (
        <Text color="gray">Try: “{cleanGoalInput(suggestion)}”</Text>
      ) : null}

      <Box justifyContent="space-between">
        <Text color={editor.error ? 'red' : 'gray'}>
          {editor.error ?? 'Enter kick off  ·  Ctrl+U clear  ·  ←/→ edit  ·  Esc cancel'}
        </Text>
        <Text color="gray">{characters.length}/{MAX_GOAL_LENGTH}</Text>
      </Box>
    </Box>
  );
}

export default GoalPrompt;
