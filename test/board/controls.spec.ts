// Prompt derivation for the board: engine state + legal actions -> what the
// player is asked to do.

import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, createGame, legalActions } from '../../src/engine/game.ts';
import type { CardId, GameState, Land } from '../../src/engine/types.ts';
import { dropOutcome, promptFor } from '../../src/board/controls.ts';

function act(state: GameState, seat: 0 | 1, action: Parameters<typeof apply>[2]): GameState {
  return apply(state, seat, action);
}

test('waiting player gets a wait prompt; active player can pass or play', () => {
  const s = createGame(0);
  const priv = new Map<CardId, Land>([['p0-slot-00', 'island']]);
  const mine = promptFor(s, 0, legalActions(s, 0, priv));
  assert.equal(mine.kind, 'main');
  assert.ok(mine.kind === 'main' && mine.playable.has('p0-slot-00'));
  assert.equal(promptFor(s, 1, legalActions(s, 1)).kind, 'wait');
});

test('a card with several declared targets moves to a declare prompt when picked', () => {
  let s = createGame(0);
  // Seat 0 plays an Island; seat 1 allows; draws resolve; seat 1 plays a Forest and passes back.
  s = act(s, 0, { type: 'play', card: 'p0-slot-00', land: 'island' });
  s = act(s, 1, { type: 'allow' });
  s = act(s, 1, { type: 'grantDrawKey', card: 'p0-slot-05' });
  s = act(s, 0, { type: 'grantDrawKey', card: 'p1-slot-05' });
  s = act(s, 1, { type: 'play', card: 'p1-slot-00', land: 'forest' });
  s = act(s, 0, { type: 'allow' });
  s = act(s, 1, { type: 'grantDrawKey', card: 'p0-slot-06' });
  // Seat 0 holds a Mountain: one target (the Forest) still means a targeted play.
  const priv = new Map<CardId, Land>([['p0-slot-01', 'mountain']]);
  const actions = legalActions(s, 0, priv);
  const picked = promptFor(s, 0, actions, 'p0-slot-01');
  assert.equal(picked.kind, 'main', 'one target: playable directly');

  s = act(s, 0, { type: 'pass' });
  s = act(s, 0, { type: 'grantDrawKey', card: 'p1-slot-06' });
  s = act(s, 1, { type: 'play', card: 'p1-slot-01', land: 'island' });
  s = act(s, 0, { type: 'allow' });
  s = act(s, 0, { type: 'grantDrawKey', card: 'p1-slot-07' });
  s = act(s, 1, { type: 'grantDrawKey', card: 'p0-slot-07' });
  const declare = promptFor(s, 0, legalActions(s, 0, priv), 'p0-slot-01');
  assert.equal(declare.kind, 'declare');
  assert.ok(declare.kind === 'declare');
  assert.deepEqual([...declare.targets.keys()].sort(), ['p1-slot-00', 'p1-slot-01']);
});

test('respond prompt lists allow and every counter pair', () => {
  let s = createGame(0);
  s = act(s, 0, { type: 'play', card: 'p0-slot-00', land: 'swamp' });
  const priv = new Map<CardId, Land>([
    ['p1-slot-00', 'island'],
    ['p1-slot-01', 'forest'],
  ]);
  const prompt = promptFor(s, 1, legalActions(s, 1, priv));
  assert.equal(prompt.kind, 'respond');
  assert.ok(prompt.kind === 'respond');
  assert.deepEqual(prompt.buttons.map((b) => b.label), ['Let it resolve', 'Counter: Island + Forest']);
  assert.match(prompt.text, /Their Swamp\. Counter it\?/);
});

test('game over reads from the viewer’s side', () => {
  let s = createGame(0);
  s = act(s, 1, { type: 'resign' });
  assert.equal(promptFor(s, 0, []).text, 'You win by resignation.');
  assert.equal(promptFor(s, 1, []).text, 'You lose by resignation.');
});

test('dropping a dragged card: on the table plays it, on a target aims it, back on the hand cancels', () => {
  let s = createGame(0);
  const island = new Map<CardId, Land>([['p0-slot-00', 'island']]);
  const opening = promptFor(s, 0, legalActions(s, 0, island));
  assert.deepEqual(dropOutcome(opening, 'p0-slot-00', null, true), { kind: 'submit', action: { type: 'play', card: 'p0-slot-00', land: 'island' } });
  assert.deepEqual(dropOutcome(opening, 'p0-slot-00', null, false), { kind: 'cancel' });
  assert.deepEqual(dropOutcome(opening, 'p0-slot-01', null, true), { kind: 'cancel' }, 'not playable');

  // Seat 0 holds a Mountain facing two opponent lands (as in the declare test above).
  for (const [seat, action] of [
    [0, { type: 'play', card: 'p0-slot-00', land: 'island' }],
    [1, { type: 'allow' }],
    [1, { type: 'grantDrawKey', card: 'p0-slot-05' }],
    [0, { type: 'grantDrawKey', card: 'p1-slot-05' }],
    [1, { type: 'play', card: 'p1-slot-00', land: 'forest' }],
    [0, { type: 'allow' }],
    [1, { type: 'grantDrawKey', card: 'p0-slot-06' }],
    [0, { type: 'pass' }],
    [0, { type: 'grantDrawKey', card: 'p1-slot-06' }],
    [1, { type: 'play', card: 'p1-slot-01', land: 'island' }],
    [0, { type: 'allow' }],
    [0, { type: 'grantDrawKey', card: 'p1-slot-07' }],
    [1, { type: 'grantDrawKey', card: 'p0-slot-07' }],
  ] as const) s = act(s, seat, action);
  const priv = new Map<CardId, Land>([['p0-slot-01', 'mountain']]);
  const actions = legalActions(s, 0, priv);
  const main = promptFor(s, 0, actions);
  const aimed = { type: 'play', card: 'p0-slot-01', land: 'mountain', declaredTarget: 'p1-slot-01' };
  assert.deepEqual(dropOutcome(main, 'p0-slot-01', 'p1-slot-01', true), { kind: 'submit', action: aimed });
  assert.deepEqual(dropOutcome(main, 'p0-slot-01', null, true), { kind: 'pick' }, 'two targets: start targeting');
  assert.deepEqual(dropOutcome(main, 'p0-slot-01', 'p0-slot-00', true), { kind: 'pick' }, 'not a legal target');

  // Once picked (drag start does this), the drop resolves against the declare prompt.
  const declare = promptFor(s, 0, actions, 'p0-slot-01');
  assert.deepEqual(dropOutcome(declare, 'p0-slot-01', 'p1-slot-01', false), { kind: 'submit', action: aimed }, 'a target counts wherever it sits');
  assert.deepEqual(dropOutcome(declare, 'p0-slot-01', null, true), { kind: 'pick' });
  assert.deepEqual(dropOutcome(declare, 'p0-slot-01', null, false), { kind: 'cancel' });
});
