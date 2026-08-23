import type { CriticVerdict } from './types.js';

export type AnimationKind = 'goal' | 'save' | 'var';

export interface AnimationEvent {
  key: string;
  verdictId: string;
  kind: AnimationKind;
  label: string;
  summary?: string;
}

export interface AnimationQueueState {
  active: AnimationEvent | null;
  pending: readonly AnimationEvent[];
  seenKeys: readonly string[];
}

type RawFrame = readonly string[];

export interface AnimationSequence {
  kind: AnimationKind;
  label: string;
  accent: 'green' | 'red' | 'yellow';
  frames: readonly string[];
  compactFrames: readonly string[];
}

function normalizeFrames(frames: readonly RawFrame[]): readonly string[] {
  const height = Math.max(...frames.map(frame => frame.length));
  const width = Math.max(
    ...frames.flatMap(frame => frame.map(line => Array.from(line).length)),
  );

  return frames.map(frame => {
    const padded = [...frame];
    while (padded.length < height) padded.push('');
    return padded
      .map(line => line.padEnd(width, ' '))
      .join('\n');
  });
}

// Hand-authored terminal choreography based only on the observed motion beats:
// set, strike, dive, decisive contact, and result. No media is embedded.
const GOAL_FRAMES = normalizeFrames([
  [
    '                               +-------------+',
    '    O                          |      O      |',
    '   /|\\                         |     /|\\     |',
    '   / \\   o                     |     / \\     |',
    '-----------.-------------------+-------------+',
  ],
  [
    '                               +-------------+',
    '      O                        |      O      |',
    '     /|\\                       |     /|\\     |',
    '    _/ \\ o                     |     / \\     |',
    '-----------.-------------------+-------------+',
  ],
  [
    '                               +-------------+',
    '       O                       |      O      |',
    '      /|_   o .                |     /|\\     |',
    '      / \\                     |     / \\     |',
    '-------------------------------+-------------+',
  ],
  [
    '                               +-------------+',
    '        O                      |        __O  |',
    '       /|\\       . . o         |     __/     |',
    '       / \\                    |   _/        |',
    '-------------------------------+-------------+',
  ],
  [
    '                               +-------------+',
    '        O                      |             |',
    '       /|\\                    |  __O     o  |',
    '       / \\                    |_/           |',
    '-------------------------------+-------------+',
  ],
  [
    '                               +~~~~~~~~~~~~~+',
    '       \\O/                     |     GOAL! o |',
    '        |                      |  __O        |',
    '       / \\                     |_/           |',
    '-------------------------------+~~~~~~~~~~~~~+',
  ],
]);

const GOAL_COMPACT_FRAMES = normalizeFrames([
  [' O          +--------+', '/|\\  o      |   O    |', '/ \\---------+--------+'],
  ['  O         +--------+', ' /|_ o .   |   O    |', ' / \\--------+--------+'],
  ['  O         +--------+', ' /|\\  . .o |  __O   |', ' / \\--------+_/------+'],
  [' \\O/        +~~~~~~~~+', '  |         | GOAL o |', ' / \\--------+___O____+'],
]);

const SAVE_FRAMES = normalizeFrames([
  [
    '                               +-------------+',
    '    O                          |      O      |',
    '   /|\\                         |     /|\\     |',
    '   / \\   o                     |     / \\     |',
    '-----------.-------------------+-------------+',
  ],
  [
    '                               +-------------+',
    '      O                        |      O      |',
    '     /|\\                       |     /|\\     |',
    '    _/ \\ o                     |     / \\     |',
    '-----------.-------------------+-------------+',
  ],
  [
    '                               +-------------+',
    '       O                       |      O      |',
    '      /|_   o . .              |     /|\\     |',
    '      / \\                     |     / \\     |',
    '-------------------------------+-------------+',
  ],
  [
    '                               +-------------+',
    '       O                       |   __O--*    |',
    '      /|\\          . . o      | _/          |',
    '      / \\                     |/            |',
    '-------------------------------+-------------+',
  ],
  [
    '                               +-------------+',
    '       O                 o     |             |',
    '      /|\\             .       | __O         |',
    '      / \\                     |/            |',
    '-------------------------------+-------------+',
  ],
  [
    '                               +-------------+',
    '       O                       |             |',
    '      /|\\                      |    O        |',
    '      / \\                     |  _(o)_      |',
    '-------------------------------+---/ \\-------+',
    '                                    SAVE!',
  ],
]);

const SAVE_COMPACT_FRAMES = normalizeFrames([
  [' O          +--------+', '/|\\  o      |   O    |', '/ \\---------+--------+'],
  ['  O         +--------+', ' /|_ o .   |   O    |', ' / \\--------+--------+'],
  ['  O      o  +--------+', ' /|\\   .    | __O--* |', ' / \\--------+_/------+'],
  ['  O         +--------+', ' /|\\        |  _(o)_ |', ' / \\--------+--/ \\---+', '              SAVE!'],
]);

const VAR_FRAMES = normalizeFrames([
  [
    '+-------------------------------------------+',
    '|                 V A R                     |',
    '| > checking critic trajectory             |',
    '|   [.................]                     |',
    '+-------------------------------------------+',
  ],
  [
    '+-------------------------------------------+',
    '|                 V A R                     |',
    '|   checking critic trajectory             |',
    '|   [######...........]                     |',
    '+-------------------------------------------+',
  ],
  [
    '+-------------------------------------------+',
    '|                 V A R                     |',
    '|          decision still level            |',
    '|   [#################]                     |',
    '+-------------------------------------------+',
  ],
]);

const VAR_COMPACT_FRAMES = normalizeFrames([
  ['+----------------------+', '| VAR > checking...    |', '+----------------------+'],
  ['+----------------------+', '| VAR [######......]   |', '+----------------------+'],
  ['+----------------------+', '| VAR: DECISION LEVEL  |', '+----------------------+'],
]);

export const ANIMATION_SEQUENCES: Readonly<Record<AnimationKind, AnimationSequence>> = {
  goal: {
    kind: 'goal',
    label: 'GOAL — critic approves',
    accent: 'green',
    frames: GOAL_FRAMES,
    compactFrames: GOAL_COMPACT_FRAMES,
  },
  save: {
    kind: 'save',
    label: 'SAVE — revision required',
    accent: 'red',
    frames: SAVE_FRAMES,
    compactFrames: SAVE_COMPACT_FRAMES,
  },
  var: {
    kind: 'var',
    label: 'VAR — critic is undecided',
    accent: 'yellow',
    frames: VAR_FRAMES,
    compactFrames: VAR_COMPACT_FRAMES,
  },
};

export function classifyCriticVerdict(
  verdict: CriticVerdict,
  threshold = 0.15,
): AnimationKind {
  if (verdict.direction === 'positive') return 'goal';
  if (verdict.direction === 'negative') return 'save';
  if (verdict.direction === 'neutral' || verdict.direction === 'pending') {
    return 'var';
  }
  if (typeof verdict.score === 'number' && Number.isFinite(verdict.score)) {
    if (verdict.score >= Math.abs(threshold)) return 'goal';
    if (verdict.score <= -Math.abs(threshold)) return 'save';
  }
  return 'var';
}

export function animationEventFromVerdict(
  verdict: CriticVerdict,
  threshold?: number,
): AnimationEvent {
  const kind = classifyCriticVerdict(verdict, threshold);
  const revision = verdict.revision ?? 0;
  const event: AnimationEvent = {
    key: `${verdict.id}:${kind}:${revision}`,
    verdictId: verdict.id,
    kind,
    label:
      kind === 'goal' && verdict.overall !== undefined && verdict.overall !== 'pass'
        ? 'GOAL — progress, revision still required'
        : ANIMATION_SEQUENCES[kind].label,
  };
  if (verdict.summary !== undefined) event.summary = verdict.summary;
  return event;
}

export function createAnimationQueueState(): AnimationQueueState {
  return { active: null, pending: [], seenKeys: [] };
}

export function enqueueAnimation(
  state: AnimationQueueState,
  event: AnimationEvent,
  maxPending = 32,
): AnimationQueueState {
  if (state.seenKeys.includes(event.key)) return state;
  // Verdict counts are already bounded by the session budget. Keeping every
  // key for the lifetime of this queue prevents an old verdict from becoming
  // eligible again after an arbitrary rollover point in a long run.
  const seenKeys = [...state.seenKeys, event.key];
  if (state.active === null) return { active: event, pending: [], seenKeys };
  if (maxPending <= 0) return { ...state, seenKeys };
  const pending = [...state.pending, event].slice(-maxPending);
  return { active: state.active, pending, seenKeys };
}

export function advanceAnimation(state: AnimationQueueState): AnimationQueueState {
  const [next, ...rest] = state.pending;
  return { ...state, active: next ?? null, pending: rest };
}

/** A small imperative shell for hosts that do not use the React playback hook. */
export class VerdictAnimationQueue {
  private state: AnimationQueueState = createAnimationQueueState();
  private replayCount = 0;

  constructor(private readonly maxPending = 32) {}

  enqueue(verdict: CriticVerdict): AnimationEvent | null {
    if (verdict.status === 'streaming') return null;
    const event = animationEventFromVerdict(verdict);
    const before = this.state;
    this.state = enqueueAnimation(this.state, event, this.maxPending);
    return before === this.state ? null : event;
  }

  enqueueEvent(event: AnimationEvent): boolean {
    const before = this.state;
    this.state = enqueueAnimation(this.state, event, this.maxPending);
    return before !== this.state;
  }

  current(): AnimationEvent | null {
    return this.state.active;
  }

  advance(): AnimationEvent | null {
    const finished = this.state.active;
    this.state = advanceAnimation(this.state);
    return finished;
  }

  replay(event: AnimationEvent): AnimationEvent {
    this.replayCount += 1;
    const replayEvent = { ...event, key: `${event.key}:replay:${this.replayCount}` };
    this.state = enqueueAnimation(this.state, replayEvent, this.maxPending);
    return replayEvent;
  }

  snapshot(): AnimationQueueState {
    return {
      active: this.state.active,
      pending: [...this.state.pending],
      seenKeys: [...this.state.seenKeys],
    };
  }

  clear(): void {
    this.state = createAnimationQueueState();
  }
}
