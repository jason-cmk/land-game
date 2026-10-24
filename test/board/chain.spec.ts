// The counter chain rebuilt from the log, checked against the state.

import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, createGame } from '../../src/engine/game.ts';
import type { Action, GameState, Seat } from '../../src/engine/types.ts';
import { chainOutcome, counterChain } from '../../src/board/chain.ts';
import type { ChainStep } from '../../src/board/chain.ts';

/** Apply actions, logging them as chain steps the way the board does. */
function run(steps: ReadonlyArray<[Seat, Action]>): { state: GameState; log: ChainStep[] } {
  let state = createGame(0);
  const log: ChainStep[] = [];
  for (const [seat, action] of steps) {
    state = apply(state, seat, action);
    if (action.type === 'play') log.push({ kind: 'play' });
    else if (action.type === 'counter') log.push({ kind: 'counter', link: { seat, cards: [action.island, action.other] } });
    else log.push({ kind: 'other' });
  }
  return { state, log };
}

const PLAY: [Seat, Action] = [0, { type: 'play', card: 'p0-slot-00', land: 'swamp' }];
const COUNTER: [Seat, Action] = [1, { type: 'counter', island: 'p1-slot-00', islandLand: 'island', other: 'p1-slot-01', otherLand: 'forest' }];
const COUNTER_BACK: [Seat, Action] = [0, { type: 'counter', island: 'p0-slot-01', islandLand: 'island', other: 'p0-slot-02', otherLand: 'plains' }];

test('a fresh play has no chain and would resolve', () => {
  const { state, log } = run([PLAY]);
  assert.deepEqual(counterChain(state, log), []);
  assert.equal(chainOutcome(state), 'resolves');
});

test('counters stack oldest first, and parity decides the outcome', () => {
  const one = run([PLAY, COUNTER]);
  assert.deepEqual(counterChain(one.state, one.log), [{ seat: 1, cards: ['p1-slot-00', 'p1-slot-01'] }]);
  assert.equal(chainOutcome(one.state), 'countered');

  const two = run([PLAY, COUNTER, COUNTER_BACK]);
  assert.deepEqual(
    counterChain(two.state, two.log).map((l) => l.seat),
    [1, 0],
  );
  assert.equal(chainOutcome(two.state), 'resolves');
});

test('only steps since the last play count; a log that disagrees with the state shows nothing', () => {
  const { state, log } = run([PLAY, COUNTER]);
  const stale: ChainStep[] = [{ kind: 'counter', link: { seat: 0, cards: ['p0-slot-03', 'p0-slot-04'] } }, ...log];
  assert.equal(counterChain(state, stale).length, 1, 'counters before the play belong to an older chain');
  assert.deepEqual(counterChain(state, [{ kind: 'play' }]), [], 'count mismatch');
  assert.deepEqual(counterChain(state, [{ kind: 'play' }, { kind: 'counter', link: { seat: 1, cards: ['p1-slot-02', 'p1-slot-03'] } }]), [], 'cards not in the graveyard');
  const resolved = run([PLAY, COUNTER, [0, { type: 'allow' }]]);
  assert.deepEqual(counterChain(resolved.state, resolved.log), []);
  assert.equal(chainOutcome(resolved.state), null);
});
