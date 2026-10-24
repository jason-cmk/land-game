// The computer opponent's policy: which of the legal actions it picks, from
// hand-built tables where the right choice is clear.

import test from 'node:test';
import assert from 'node:assert/strict';

import { legalActions } from '../../src/engine/game.ts';
import type { Action, CardId, CardSlot, GameState, Land, PendingPlay, Phase, PlayerState, Seat } from '../../src/engine/types.ts';
import { chooseAction, distance, gain } from '../../src/bot/policy.ts';

interface Side {
  hand?: Land[];
  battlefield?: Land[];
  graveyard?: Land[];
}

/**
 * A table with seat 0 as the bot. Hand cards are hidden in the shared state;
 * the bot's are in its private hand, the opponent's are unknown to it.
 */
function table(bot: Side, them: Side, extra: { phase?: Phase; activeSeat?: Seat; pending?: PendingPlay | null } = {}): { state: GameState; priv: Map<CardId, Land> } {
  const priv = new Map<CardId, Land>();
  const player = (seat: Seat, side: Side): PlayerState => {
    let n = 0;
    const slot = (land: Land | null): CardSlot => ({ id: `p${seat}-slot-${String(n++).padStart(2, '0')}`, land });
    const hand = (side.hand ?? []).map((land) => {
      const s = slot(null);
      if (seat === 0) priv.set(s.id, land);
      return s;
    });
    return {
      hand,
      battlefield: (side.battlefield ?? []).map(slot),
      graveyard: (side.graveyard ?? []).map(slot),
      library: Array.from({ length: 20 }, () => slot(null)),
    };
  };
  const state: GameState = {
    turn: 5,
    activeSeat: extra.activeSeat ?? 0,
    phase: extra.phase ?? 'main',
    players: [player(0, bot), player(1, them)],
    pending: extra.pending ?? null,
    awaitingDraw: null,
    winner: null,
  };
  return { state, priv };
}

const choose = (state: GameState, priv: Map<CardId, Land>, rand = () => 0.5): Action => chooseAction(state, 0, priv, legalActions(state, 0, priv), rand);

const landOf = (state: GameState, id: CardId): Land | null => {
  for (const p of state.players) for (const s of [...p.battlefield, ...p.graveyard, ...p.hand]) if (s.id === id) return s.land;
  return null;
};

test('distance and gain count lands still needed for Domain or Mono', () => {
  assert.equal(distance([]), 5);
  assert.equal(distance(['forest', 'forest', 'forest', 'island']), 2);
  assert.equal(distance(['forest', 'island', 'mountain', 'plains']), 1);
  assert.equal(distance(['swamp', 'swamp', 'swamp', 'swamp', 'swamp']), 0);
  assert.equal(gain(['forest', 'island', 'mountain', 'plains'], 'swamp'), 1);
  assert.equal(gain(['forest', 'island', 'mountain', 'plains'], 'forest'), 0);
});

test('plays the land that wins', () => {
  const { state, priv } = table({ hand: ['mountain', 'plains', 'island'], battlefield: ['forest', 'island', 'mountain', 'swamp'] }, { battlefield: ['forest'] });
  const action = choose(state, priv);
  assert.equal(action.type, 'play');
  assert.equal(action.type === 'play' && action.land, 'plains');
});

test('a Mountain destroys the land that sets the opponent back most', () => {
  const { state, priv } = table({ hand: ['mountain'] }, { battlefield: ['island', 'forest', 'forest', 'forest', 'forest'] });
  const action = choose(state, priv);
  assert.ok(action.type === 'play' && action.land === 'mountain');
  assert.equal(landOf(state, action.declaredTarget!), 'forest');
});

test('plays rather than passes when it has a useful land', () => {
  for (let k = 0; k < 20; k++) {
    const { state, priv } = table({ hand: ['forest', 'island'], battlefield: ['forest'] }, {});
    assert.notEqual(choose(state, priv, Math.random).type, 'pass');
  }
});

test('counters a winning play, paying with the least useful card', () => {
  const pending: PendingPlay = { card: 'p1-slot-00', land: 'plains', controller: 1, declaredTarget: null, counters: 0 };
  const { state, priv } = table(
    { hand: ['island', 'mountain', 'forest'], battlefield: ['forest', 'forest'] },
    { hand: ['plains'], battlefield: ['forest', 'island', 'mountain', 'swamp'] },
    { phase: 'respond', activeSeat: 1, pending },
  );
  const action = choose(state, priv);
  assert.equal(action.type, 'counter');
  assert.equal(action.type === 'counter' && action.otherLand, 'mountain', 'the Forest builds toward Mono; the Mountain does not');
});

test('lets a harmless play through rather than spend a small hand', () => {
  const pending: PendingPlay = { card: 'p1-slot-00', land: 'island', controller: 1, declaredTarget: null, counters: 0 };
  const { state, priv } = table({ hand: ['island', 'mountain', 'forest'] }, { hand: ['island'], battlefield: ['forest'] }, { phase: 'respond', activeSeat: 1, pending });
  assert.equal(choose(state, priv).type, 'allow');
});

test('counters back to save its own winning play', () => {
  const pending: PendingPlay = { card: 'p0-slot-02', land: 'swamp', controller: 0, declaredTarget: null, counters: 1 };
  const { state, priv } = table(
    { hand: ['island', 'plains', 'swamp'], battlefield: ['forest', 'island', 'mountain', 'plains'] },
    { battlefield: ['forest'] },
    { phase: 'respond', activeSeat: 0, pending },
  );
  assert.equal(choose(state, priv).type, 'counter');
});

test('a Swamp discard takes the card that helps the opponent most', () => {
  const pending: PendingPlay = { card: 'p0-slot-09', land: 'swamp', controller: 0, declaredTarget: null, counters: 0 };
  const { state, priv } = table({}, { hand: ['forest', 'plains'], battlefield: ['forest', 'island', 'mountain', 'swamp'] }, { phase: 'target', pending });
  // The reveal makes the opponent's hand public.
  const revealed: GameState = {
    ...state,
    players: [state.players[0], { ...state.players[1], hand: [{ id: 'p1-slot-00', land: 'forest' }, { id: 'p1-slot-01', land: 'plains' }] }],
  };
  const action = choose(revealed, priv);
  assert.ok(action.type === 'resolveTarget');
  assert.equal(landOf(revealed, action.target), 'plains');
});

test('never resigns and always picks a listed action', () => {
  const { state, priv } = table({ hand: ['swamp'] }, {});
  const actions: Action[] = [{ type: 'resign' }, { type: 'pass' }];
  assert.equal(chooseAction(state, 0, priv, actions).type, 'pass');
  assert.throws(() => chooseAction(state, 0, priv, []));
});
