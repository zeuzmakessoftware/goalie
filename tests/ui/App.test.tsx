import { render } from 'ink-testing-library';
import { afterEach, expect, test } from 'vitest';
import { App } from '../../src/ui/App.js';
import type { BroadcastSession } from '../../src/ui/types.js';

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const unmount of cleanup.splice(0)) unmount();
});

const session: BroadcastSession = {
  title: 'Long Horizon Cup',
  status: 'running',
  phase: 'critic review',
  loop: 3,
  loopLimit: 12,
  checkpoint: 7,
  checkpointLimit: 20,
  elapsedMs: 3_723_000,
  score: { goals: 4, saves: 2 },
  agents: [
    {
      id: 'captain',
      name: 'Captain',
      role: 'orchestrator',
      status: 'working',
      currentTask: 'Coordinate the next checkpoint',
      progress: 0.62,
    },
    {
      id: 'critic',
      name: 'Hard Press',
      role: 'critic',
      status: 'waiting',
    },
  ],
  transcript: [
    {
      id: 'line-1',
      kind: 'agent',
      agentId: 'captain',
      label: 'Captain',
      text: '\u001b[31mBuilding evidence without terminal injection.\u001b[0m',
      timestamp: '2026-08-22T19:20:21.000Z',
    },
  ],
  tactics: [{ id: 't1', label: 'Formation', value: '1–2–1 reviewer press' }],
  evidence: [{ id: 'e1', title: 'Unit tests', status: 'pass' }],
};

test('renders the broadcast dashboard without a real terminal', () => {
  const screen = render(
    <App
      session={session}
      interactive={false}
      terminalSize={{ columns: 132, rows: 36 }}
      colorMode="none"
      motionMode="reduced"
      env={{ NO_COLOR: '', LANG: 'en_US.UTF-8' }}
    />,
  );
  cleanup.push(screen.unmount);

  const frame = screen.lastFrame() ?? '';
  expect(frame).toContain('GOALIE // Long Horizon Cup');
  expect(frame).toContain('GOALS 4 : 2 SAVES');
  expect(frame).toContain('OFFENSE // ● CAPTAIN');
  expect(frame).toContain('DEFENSE // ◌ HARD PRESS');
  expect(frame).toContain('HANDOFF');
  expect(frame).toContain('[1] ● OFF CAPTAIN');
  expect(frame).toContain('LIVE FEED // TOUCHLINE');
  expect(frame).toContain('TACTICAL BOARD // FORMATION');
  expect(frame).toContain('EVIDENCE LOCKER // RECEIPTS');
  expect(frame).toContain('Building evidence without terminal injection.');
  expect(frame).not.toContain('\u001b[31m');
});

test('minimal layout remains usable and exposes persistent controls', () => {
  const screen = render(
    <App
      session={session}
      interactive={false}
      terminalSize={{ columns: 54, rows: 16 }}
      colorMode="none"
      env={{ TERM: 'dumb' }}
    />,
  );
  cleanup.push(screen.unmount);

  const frame = screen.lastFrame() ?? '';
  expect(frame).toContain('OFFENSE // * CAPTAIN');
  expect(frame).toContain('DEFENSE // . HARD PRESS');
  expect(frame).toContain('[1] * OFF CAPTAIN');
  expect(frame).toContain('[T] FEED');
  expect(frame).toContain('SPECTATOR MODE');
});

test('final verdict enters an accessible reduced-motion replay', async () => {
  const screen = render(
    <App
      session={{
        ...session,
        latestVerdict: {
          id: 'verdict-1',
          direction: 'positive',
          status: 'final',
          summary: 'All required checks cleared.',
        },
      }}
      interactive={false}
      terminalSize={{ columns: 132, rows: 36 }}
      colorMode="none"
      motionMode="reduced"
      env={{ NO_COLOR: '', LANG: 'en_US.UTF-8' }}
    />,
  );
  cleanup.push(screen.unmount);

  await new Promise(resolve => setTimeout(resolve, 20));
  const frame = screen.lastFrame() ?? '';
  expect(frame).toContain('REPLAY // REDUCED MOTION // GOAL');
  expect(frame).toContain('GOAL — critic approves');
  expect(frame).toContain('All required checks cleared.');
  expect(frame).toContain('APPROVED');
});

test('the offense and defense matchup stays visible when a detail tab changes', async () => {
  const screen = render(
    <App
      session={{
        ...session,
        latestVerdict: {
          id: 'verdict-score',
          direction: 'negative',
          overall: 'fail',
          status: 'final',
          score: 72,
          summary: 'Concurrency evidence is still incomplete.',
        },
      }}
      terminalSize={{ columns: 100, rows: 28 }}
      colorMode="none"
      motionMode="none"
      env={{ GOALIE_ASCII: '1' }}
    />,
  );
  cleanup.push(screen.unmount);

  screen.stdin.write('2');
  await new Promise(resolve => setTimeout(resolve, 10));
  const frame = screen.lastFrame() ?? '';
  expect(frame).toContain('OFFENSE // * CAPTAIN');
  expect(frame).toContain('DEFENSE // . HARD PRESS');
  expect(frame).toContain('REVISION 72/100');
  expect(frame).toContain('Concurrency evidence is still incomp');
});

test('follow-output mode selects the agent with a new line and pauses while composing', async () => {
  const screen = render(
    <App
      session={session}
      terminalSize={{ columns: 100, rows: 28 }}
      colorMode="none"
      followAgentOutput
    />,
  );
  cleanup.push(screen.unmount);

  const criticLine = {
    id: 'line-2',
    kind: 'critic' as const,
    agentId: 'critic',
    label: 'Hard Press',
    text: 'Reviewing the latest checkpoint.',
    timestamp: '2026-08-22T19:20:22.000Z',
  };
  screen.rerender(
    <App
      session={{ ...session, transcript: [...session.transcript, criticLine] }}
      terminalSize={{ columns: 100, rows: 28 }}
      colorMode="none"
      followAgentOutput
    />,
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(screen.lastFrame() ?? '').toContain('>[2]');

  screen.stdin.write('i');
  await new Promise(resolve => setTimeout(resolve, 10));
  const composingFrame = screen.lastFrame() ?? '';
  expect(composingFrame).toContain('COACH>');
  screen.rerender(
    <App
      session={{
        ...session,
        transcript: [
          ...session.transcript,
          criticLine,
          {
            id: 'line-3',
            kind: 'agent',
            agentId: 'captain',
            label: 'Captain',
            text: 'Coordinating the next lane.',
            timestamp: '2026-08-22T19:20:23.000Z',
          },
        ],
      }}
      terminalSize={{ columns: 100, rows: 28 }}
      colorMode="none"
      followAgentOutput
    />,
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(screen.lastFrame() ?? '').toContain('>[2]');
});

test('no-motion mode renders a text-only verdict without ASCII frames', async () => {
  const screen = render(
    <App
      session={{
        ...session,
        latestVerdict: {
          id: 'verdict-text-only',
          direction: 'negative',
          status: 'final',
          summary: 'A required verifier still fails.',
        },
      }}
      interactive={false}
      terminalSize={{ columns: 132, rows: 36 }}
      colorMode="none"
      motionMode="none"
      env={{ NO_COLOR: '', LANG: 'en_US.UTF-8' }}
    />,
  );
  cleanup.push(screen.unmount);

  await new Promise(resolve => setTimeout(resolve, 20));
  const frame = screen.lastFrame() ?? '';
  expect(frame).toContain('VERDICT // TEXT ONLY // SAVE');
  expect(frame).toContain('SAVE — revision required');
  expect(frame).toContain('A required verifier still fails.');
  expect(frame).not.toContain('_(o)_');
});

test('more than 100 preloaded live verdicts stay quiet while an append plays once', async () => {
  const historicalVerdicts = Array.from({ length: 125 }, (_, index) => ({
    id: `verdict-before-mount-${index}`,
    direction: (index % 2 === 0 ? 'positive' : 'negative') as 'positive' | 'negative',
    status: 'final' as const,
    summary: `Historical decision ${index} from before resume.`,
  }));
  const screen = render(
    <App
      session={{ ...session, verdicts: historicalVerdicts }}
      interactive={false}
      terminalSize={{ columns: 132, rows: 36 }}
      colorMode="none"
      motionMode="reduced"
      env={{ NO_COLOR: '', LANG: 'en_US.UTF-8' }}
    />,
  );
  cleanup.push(screen.unmount);

  await new Promise(resolve => setTimeout(resolve, 20));
  expect(screen.lastFrame() ?? '').not.toContain('REPLAY // REDUCED MOTION');

  const appendedVerdict = {
    id: 'verdict-after-mount',
    direction: 'positive' as const,
    status: 'final' as const,
    summary: 'Fresh goal after resume.',
  };
  screen.rerender(
    <App
      session={{ ...session, verdicts: [...historicalVerdicts, appendedVerdict] }}
      interactive={false}
      terminalSize={{ columns: 132, rows: 36 }}
      colorMode="none"
      motionMode="reduced"
      env={{ NO_COLOR: '', LANG: 'en_US.UTF-8' }}
    />,
  );

  await new Promise(resolve => setTimeout(resolve, 20));
  const frame = screen.lastFrame() ?? '';
  expect(frame).toContain('REPLAY // REDUCED MOTION // GOAL');
  expect(frame).toContain('Fresh goal after resume.');
  expect(frame).not.toContain('Historical decision');
});

test('incrementally appended replay history remains eligible from an empty mount', async () => {
  const screen = render(
    <App
      session={{ ...session, verdicts: [] }}
      interactive={false}
      terminalSize={{ columns: 132, rows: 36 }}
      colorMode="none"
      motionMode="reduced"
      env={{ NO_COLOR: '', LANG: 'en_US.UTF-8' }}
    />,
  );
  cleanup.push(screen.unmount);

  screen.rerender(
    <App
      session={{
        ...session,
        verdicts: [{
          id: 'replay-verdict-1',
          direction: 'negative',
          status: 'final',
          summary: 'Replay appended this decision.',
        }],
      }}
      interactive={false}
      terminalSize={{ columns: 132, rows: 36 }}
      colorMode="none"
      motionMode="reduced"
      env={{ NO_COLOR: '', LANG: 'en_US.UTF-8' }}
    />,
  );

  await new Promise(resolve => setTimeout(resolve, 20));
  const frame = screen.lastFrame() ?? '';
  expect(frame).toContain('REPLAY // REDUCED MOTION // SAVE');
  expect(frame).toContain('Replay appended this decision.');
});

test('typing mode keeps navigation letters and digits inside the prompt', async () => {
  const submitted: string[] = [];
  const screen = render(
    <App
      session={session}
      terminalSize={{ columns: 76, rows: 22 }}
      colorMode="none"
      onSubmitPrompt={prompt => submitted.push(prompt)}
    />,
  );
  cleanup.push(screen.unmount);

  screen.stdin.write('i');
  await new Promise(resolve => setTimeout(resolve, 10));
  screen.stdin.write('test agent 1 tactic');
  await new Promise(resolve => setTimeout(resolve, 10));

  const composingFrame = screen.lastFrame() ?? '';
  expect(composingFrame).toContain('COACH> test agent 1 tactic');
  expect(composingFrame).toContain('LIVE FEED // TOUCHLINE');

  screen.stdin.write('\r');
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(submitted).toEqual(['test agent 1 tactic']);
});

test('Ctrl+C requests immediate graceful interruption while q remains a separate exit intent', async () => {
  let interrupts = 0;
  let exits = 0;
  const screen = render(
    <App
      session={session}
      terminalSize={{ columns: 76, rows: 22 }}
      colorMode="none"
      onInterrupt={() => { interrupts += 1; }}
      onExit={() => { exits += 1; }}
    />,
  );
  cleanup.push(screen.unmount);

  screen.stdin.write('\u0003');
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(interrupts).toBe(1);
  expect(exits).toBe(0);

  screen.stdin.write('q');
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(exits).toBe(1);
});

test('p requests a pause and paused sessions advertise the same key to resume', async () => {
  let pauses = 0;
  const screen = render(
    <App
      session={session}
      terminalSize={{ columns: 100, rows: 24 }}
      colorMode="none"
      onPause={() => { pauses += 1; }}
    />,
  );
  cleanup.push(screen.unmount);

  expect(screen.lastFrame() ?? '').toContain('[P] PAUSE');
  screen.stdin.write('p');
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(pauses).toBe(1);

  screen.rerender(
    <App
      session={{ ...session, status: 'paused', phase: 'HALFTIME // PRESS P TO RESUME' }}
      terminalSize={{ columns: 100, rows: 24 }}
      colorMode="none"
      onPause={() => { pauses += 1; }}
    />,
  );
  expect(screen.lastFrame() ?? '').toContain('[P] RESUME');
  expect(screen.lastFrame() ?? '').toContain('HALFTIME');
});
