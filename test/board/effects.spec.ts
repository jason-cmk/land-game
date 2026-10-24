// Animation cues derived from consecutive engine states.

import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, createGame } from '../../src/engine/game.ts';
import type { Action, GameState, Seat } from '../../src/engine/types.ts';
import { cuesBetween } from '../../src/board/effects.ts';
import type { Cue } from '../../src/board/effects.ts';

/** Apply actions in turn, collecting the cues each step produces. */
function run(start: GameState, steps: ReadonlyArray<[Seat, Action]>): { state: GameState; cues: Cue[][] } {
  let state = start;
  const cues: Cue[][] = [];
  for (const [seat, action] of steps) {
    const next = apply(state, seat, action);
    cues.push(cuesBetween(state, next));
    state = next;
  }
  return { state, cues };
}

const kinds = (cues: readonly Cue[]): string[] => cues.map((c) => c.kind);

/** Seat 0 resolves an Island (drawing), seat 1 starts turn 2 with a draw. */
const OPENING: ReadonlyArray<[Seat, Action]> = [
  [0, { type: 'play', card: 'p0-slot-00', land: 'island' }],
  [1, { type: 'allow' }],
  [1, { type: 'grantDrawKey', card: 'p0-slot-05' }],
  [0, { type: 'grantDrawKey', card: 'p1-slot-05' }],
];

test('play, resolve and the draws that follow', () => {
  const { cues } = run(createGame(0), OPENING);
  assert.deepEqual(cues[0], [{ kind: 'announce', card: 'p0-slot-00', land: 'island', seat: 0 }]);
  assert.deepEqual(kinds(cues[1]!), ['draw', 'enter']);
  // The next turn's draw moves the card as the turn ends; granting its key moves nothing.
  assert.deepEqual(cues[2], [{ kind: 'draw', card: 'p1-slot-05', seat: 1 }]);
  assert.deepEqual(cues[3], []);
});

test('counter pays two cards; an odd chain counters the play', () => {
  const { cues } = run(createGame(0), [
    [0, { type: 'play', card: 'p0-slot-00', land: 'swamp' }],
    [1, { type: 'counter', island: 'p1-slot-00', islandLand: 'island', other: 'p1-slot-01', otherLand: 'forest' }],
    [0, { type: 'allow' }],
  ]);
  assert.deepEqual(cues[1], [{ kind: 'counter', cards: ['p1-slot-00', 'p1-slot-01'], seat: 1 }]);
  assert.ok(cues[2]!.some((c) => c.kind === 'countered' && c.card === 'p0-slot-00'));
});

test('Mountain destroys with a meteor; Forest regrows; Swamp reveals then discards', () => {
  const after = run(createGame(0), OPENING).state;
  // Seat 1 lays a Mountain on the Island.
  const mountain = run(after, [
    [1, { type: 'play', card: 'p1-slot-00', land: 'mountain', declaredTarget: 'p0-slot-00' }],
    [0, { type: 'allow' }],
  ]);
  assert.ok(mountain.cues[1]!.some((c) => c.kind === 'meteor' && c.card === 'p0-slot-00' && c.seat === 0));

  // Seat 0 draws, then Forest returns the destroyed Island.
  const forest = run(mountain.state, [
    [1, { type: 'grantDrawKey', card: 'p0-slot-06' }],
    [0, { type: 'play', card: 'p0-slot-01', land: 'forest', declaredTarget: 'p0-slot-00' }],
    [1, { type: 'allow' }],
  ]);
  assert.ok(forest.cues[2]!.some((c) => c.kind === 'regrowth' && c.card === 'p0-slot-00'));

  // Seat 1 draws, then Swamp: seat 0 reveals, seat 1 picks the discard.
  const hand0 = forest.state.players[0].hand;
  const swamp = run(forest.state, [
    [0, { type: 'grantDrawKey', card: 'p1-slot-06' }],
    [1, { type: 'play', card: 'p1-slot-01', land: 'swamp' }],
    [0, { type: 'allow' }],
    [0, { type: 'revealHandForSwamp', cards: hand0.map((s, i) => ({ card: s.id, land: s.land ?? (i % 2 === 0 ? 'plains' : 'forest') })) }],
    [1, { type: 'resolveTarget', target: hand0[1]!.id }],
  ]);
  const reveal = swamp.cues[3]!.find((c) => c.kind === 'reveal');
  assert.ok(reveal && reveal.kind === 'reveal' && reveal.seat === 0);
  assert.ok(swamp.cues[4]!.some((c) => c.kind === 'discard' && c.card === hand0[1]!.id && c.seat === 0));
});

test('Plains announces the land it reuses; a win is its own cue', () => {
  const after = run(createGame(0), OPENING).state;
  const { cues } = run(after, [
    [1, { type: 'pass' }],
    [1, { type: 'grantDrawKey', card: 'p0-slot-06' }],
    [0, { type: 'play', card: 'p0-slot-01', land: 'plains', declaredTarget: 'p0-slot-00' }],
    [1, { type: 'resign' }],
  ]);
  assert.deepEqual(kinds(cues[2]!), ['announce', 'reuse']);
  assert.deepEqual(cues[3]!.at(-1), { kind: 'win', seat: 0, reason: 'resign' });
});
