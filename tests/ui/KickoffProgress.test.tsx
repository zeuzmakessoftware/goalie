import { render } from 'ink-testing-library';
import { expect, test } from 'vitest';

import { KickoffProgress } from '../../src/ui/KickoffProgress.js';

test('keeps provider, stage, elapsed time, and hard deadline visible during planning', () => {
  const screen = render(
    <KickoffProgress
      goal="Repair crash-safe ingestion"
      providerTimeoutMs={12_000}
      totalTimeoutMs={24_000}
      progress={[
        {
          stage: 'attempt_started',
          provider: 'openrouter',
          model: 'demo-model',
          elapsedMs: 0,
          message: 'OpenRouter is inspecting the clean repository read-only.',
        },
        {
          stage: 'heartbeat',
          provider: 'openrouter',
          model: 'demo-model',
          elapsedMs: 3_100,
          message: 'OpenRouter is still planning; hard fallback in 9s.',
        },
      ]}
    />,
  );

  const frame = screen.lastFrame() ?? '';
  expect(frame).toContain('GOALIE // TACTICAL BRIEFING');
  expect(frame).toContain('PLANNING · 3s');
  expect(frame).toContain('openrouter/demo-model');
  expect(frame).toContain('at most 12s');
  expect(frame).toContain('capped at 24s');
  expect(frame).toContain('Repair crash-safe ingestion');
  screen.unmount();
});
