import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ANIMATION_SEQUENCES,
  VerdictAnimationQueue,
  advanceAnimation,
  animationEventFromVerdict,
  classifyCriticVerdict,
  createAnimationQueueState,
  enqueueAnimation,
} from '../../src/ui/animation.js';

test('classifies critic direction and score into broadcast outcomes', () => {
  assert.equal(classifyCriticVerdict({ id: 'a', direction: 'positive' }), 'goal');
  assert.equal(classifyCriticVerdict({ id: 'b', direction: 'negative' }), 'save');
  assert.equal(classifyCriticVerdict({ id: 'c', direction: 'neutral' }), 'var');
  assert.equal(classifyCriticVerdict({ id: 'd', score: 0.8 }), 'goal');
  assert.equal(classifyCriticVerdict({ id: 'e', score: -0.8 }), 'save');
  assert.equal(classifyCriticVerdict({ id: 'f', score: 0.05 }), 'var');
});

test('explicit direction wins over a contradictory numeric score', () => {
  assert.equal(
    classifyCriticVerdict({ id: 'a', direction: 'positive', score: -1 }),
    'goal',
  );
});

test('a materially improved failure celebrates progress without claiming completion', () => {
  const event = animationEventFromVerdict({
    id: 'repair-progress',
    overall: 'fail',
    direction: 'positive',
    status: 'final',
  });
  assert.equal(event.kind, 'goal');
  assert.equal(event.label, 'GOAL — progress, revision still required');
});

test('queue preserves FIFO verdict order and coalesces only duplicate keys', () => {
  let state = createAnimationQueueState();
  const first = animationEventFromVerdict({ id: 'v1', direction: 'positive' });
  const second = animationEventFromVerdict({ id: 'v2', direction: 'negative' });
  const third = animationEventFromVerdict({ id: 'v3', direction: 'positive' });

  state = enqueueAnimation(state, first);
  state = enqueueAnimation(state, second);
  state = enqueueAnimation(state, third);
  const duplicateState = enqueueAnimation(state, second);

  assert.equal(duplicateState, state);
  assert.equal(state.active?.verdictId, 'v1');
  assert.deepEqual(state.pending.map(event => event.verdictId), ['v2', 'v3']);

  state = advanceAnimation(state);
  assert.equal(state.active?.verdictId, 'v2');
  state = advanceAnimation(state);
  assert.equal(state.active?.verdictId, 'v3');
});

test('default queue holds a full run of 32 pending verdicts', () => {
  let state = createAnimationQueueState();
  for (let index = 0; index < 33; index += 1) {
    state = enqueueAnimation(
      state,
      animationEventFromVerdict({
        id: `v${index}`,
        direction: index % 2 === 0 ? 'positive' : 'negative',
      }),
    );
  }
  assert.equal(state.active?.verdictId, 'v0');
  assert.equal(state.pending.length, 32);
  assert.equal(state.pending[0]?.verdictId, 'v1');
  assert.equal(state.pending[31]?.verdictId, 'v32');
});

test('queue remembers duplicate verdict keys beyond 100 finalized decisions', () => {
  let state = createAnimationQueueState();
  const events = Array.from({ length: 125 }, (_, index) =>
    animationEventFromVerdict({
      id: `long-run-${index}`,
      direction: index % 2 === 0 ? 'positive' : 'negative',
    }),
  );

  for (const event of events) state = enqueueAnimation(state, event, 128);

  assert.equal(state.seenKeys.length, 125);
  assert.equal(enqueueAnimation(state, events[0]!, 128), state);
  assert.equal(enqueueAnimation(state, events[24]!, 128), state);
});

test('imperative queue ignores streaming updates and accepts final verdicts', () => {
  const queue = new VerdictAnimationQueue();
  assert.equal(
    queue.enqueue({ id: 'v1', direction: 'positive', status: 'streaming' }),
    null,
  );
  assert.ok(queue.enqueue({ id: 'v1', direction: 'positive', status: 'final' }));
  assert.equal(queue.current()?.kind, 'goal');
});

test('every frame in a sequence has stable dimensions', () => {
  for (const sequence of Object.values(ANIMATION_SEQUENCES)) {
    for (const frames of [sequence.frames, sequence.compactFrames]) {
      const dimensions = frames.map(frame => {
        const lines = frame.split('\n');
        return [lines.length, ...new Set(lines.map(line => line.length))];
      });
      assert.ok(dimensions.every(dimension => dimension.length === 2));
      assert.ok(
        dimensions.every(
          dimension =>
            dimension[0] === dimensions[0]?.[0] &&
            dimension[1] === dimensions[0]?.[1],
        ),
      );
    }
  }
});
