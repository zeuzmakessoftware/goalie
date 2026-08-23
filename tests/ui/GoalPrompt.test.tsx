import { render } from 'ink-testing-library';
import { afterEach, expect, test } from 'vitest';
import { GoalPrompt } from '../../src/ui/GoalPrompt.js';

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const unmount of cleanup.splice(0)) unmount();
});

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

test('holds on an editable kickoff prompt until Enter submits the goal', async () => {
  const submitted: string[] = [];
  const screen = render(
    <GoalPrompt
      mode="live"
      initialValue="fixture goal"
      onSubmit={goal => submitted.push(goal)}
    />,
  );
  cleanup.push(screen.unmount);

  expect(screen.lastFrame() ?? '').toContain('GOALIE // GAUNTLET KICKOFF');
  expect(screen.lastFrame() ?? '').toContain('LIVE FIXTURE');
  expect(screen.lastFrame() ?? '').toContain('fixture goal');
  expect(submitted).toEqual([]);

  screen.stdin.write('\u0015');
  screen.stdin.write('repair q1 replay');
  await settle();
  expect(screen.lastFrame() ?? '').toContain('repair q1 replay');
  expect(submitted).toEqual([]);

  screen.stdin.write('\r');
  await settle();
  expect(submitted).toEqual(['repair q1 replay']);
});

test('standard demo discloses that it is a recorded fixture before starting', () => {
  const screen = render(
    <GoalPrompt
      mode="replay"
      initialValue="Repair the Penalty Ledger"
      onSubmit={() => undefined}
    />,
  );
  cleanup.push(screen.unmount);

  const frame = screen.lastFrame() ?? '';
  expect(frame).toContain('RECORDED REPLAY');
  expect(frame).toContain('No agents run in standard demo mode.');
  expect(frame).toContain('demo --live --env-file .env');
});

test('empty input stays on the kickoff screen with a validation message', async () => {
  const submitted: string[] = [];
  const screen = render(
    <GoalPrompt
      mode="live"
      onSubmit={goal => submitted.push(goal)}
    />,
  );
  cleanup.push(screen.unmount);

  screen.stdin.write('\r');
  await settle();
  expect(submitted).toEqual([]);
  expect(screen.lastFrame() ?? '').toContain('A goal is required before kickoff.');
});

test('Ctrl+C cancels without interpreting q as quit', async () => {
  let cancelled = 0;
  const screen = render(
    <GoalPrompt
      mode="live"
      onSubmit={() => undefined}
      onCancel={() => { cancelled += 1; }}
    />,
  );
  cleanup.push(screen.unmount);

  screen.stdin.write('q');
  await settle();
  expect(cancelled).toBe(0);
  screen.stdin.write('\u0003');
  await settle();
  expect(cancelled).toBe(1);
});
