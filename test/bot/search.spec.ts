// The difficulty levels: the plaintext simulator, its guesses at hidden cards,
// the easy style's blunders and the hard computer's playouts.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CARDS_PER_TYPE, legalActions } from '../../src/engine/game.ts';
import { LANDS } from '../../src/engine/types.ts';
import type { Action, CardId, CardSlot, GameState, Land, PendingPlay, PlayerState, Seat } from '../../src/engine/types.ts';
import { chooseAction } from '../../src/bot/policy.ts';
import { searchAction } from '../../src/bot/search.ts';
import { act, deal, guessTruth, playOut, privateView, toMove } from '../../src/bot/sim.ts';
import type { World } from '../../src/bot/sim.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const normal = (rand: () => number) => (s: GameState, seat: Seat, priv: ReadonlyMap<CardId, Land>, actions: readonly Action[]) => chooseAction(s, seat, priv, actions, rand);

/** Play `moves` choices of a normal-vs-normal game from a fresh deal. */
function midGame(seed: number, moves: number): World {
  const rand = mulberry32(seed);
  let world = deal(0, rand);
  for (let n = 0; n < moves && world.state.winner === null; n++) {
    const move = toMove(world)!;
    world = act(world, move.seat, normal(rand)(world.state, move.seat, privateView(world, move.seat), move.actions));
  }
  return world;
}

interface Side {
  hand?: Land[];
  battlefield?: Land[];
  graveyard?: Land[];
}

/** A hand-built table with seat 0 to decide; each library is filled out to a 50-card deck. */
function table(bot: Side, them: Side, extra: { phase?: GameState['phase']; activeSeat?: Seat; pending?: PendingPlay | null } = {}): { state: GameState; priv: Map<CardId, Land> } {
  const priv = new Map<CardId, Land>();
  const player = (seat: Seat, side: Side): PlayerState => {
    let n = 0;
    const slot = (land: Land | null): CardSlot => ({ id: `p${seat}-slot-${String(n++).padStart(2, '0')}`, land });
    const hand = (side.hand ?? []).map((land) => {
      const s = slot(null);
      if (seat === 0) priv.set(s.id, land);
      return s;
    });
    const battlefield = (side.battlefield ?? []).map(slot);
    const graveyard = (side.graveyard ?? []).map(slot);
    const library = Array.from({ length: 50 - hand.length - battlefield.length - graveyard.length }, () => slot(null));
    return { hand, battlefield, graveyard, library };
  };
  const state: GameState = {
    turn: 9,
    activeSeat: extra.activeSeat ?? 0,
    phase: extra.phase ?? 'main',
    players: [player(0, bot), player(1, them)],
    pending: extra.pending ?? null,
    awaitingDraw: null,
    winner: null,
  };
  return { state, priv };
}

test('simulated games between two normal players finish with a winner', () => {
  const rand = mulberry32(1);
  for (let g = 0; g < 50; g++) assert.notEqual(playOut(deal((g % 2) as Seat, rand), normal(rand)), null, `game ${g}`);
});

test('a guess keeps every card the seat knows and ten of each land per deck', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const world = midGame(seed, 30);
    const seat = 0;
    const priv = privateView(world, seat);
    const guess = guessTruth(world.state, seat, priv, mulberry32(seed + 100));
    for (const owner of [0, 1] as const) {
      const p = world.state.players[owner];
      const slots = [...p.library, ...p.hand, ...p.battlefield, ...p.graveyard];
      assert.equal(slots.length, 50);
      for (const slot of slots) {
        const known = slot.land ?? priv.get(slot.id);
        if (known !== undefined && known !== null) assert.equal(guess.get(slot.id), known, `seed ${seed}: ${slot.id}`);
      }
      for (const land of LANDS) assert.equal(slots.filter((s) => guess.get(s.id) === land).length, CARDS_PER_TYPE, `seed ${seed}: deck ${owner} ${land}`);
    }
  }
});

test('a guess never copies the opponent\'s hidden hand from the truth', () => {
  // Over many guesses the opponent's hidden hand comes out different from the real one.
  const world = midGame(3, 20);
  const theirs = world.state.players[1].hand.filter((s) => s.land === null).map((s) => s.id);
  assert.ok(theirs.length > 0);
  const priv = privateView(world, 0);
  const rand = mulberry32(7);
  let same = 0;
  for (let k = 0; k < 50; k++) {
    const guess = guessTruth(world.state, 0, priv, rand);
    if (theirs.every((id) => guess.get(id) === world.truth.get(id))) same++;
  }
  assert.ok(same < 25, `guessed the real hand ${same} of 50 times`);
});

test('easy lets about half the winning lands through; normal stops them all', () => {
  const pending: PendingPlay = { card: 'p1-slot-00', land: 'plains', controller: 1, declaredTarget: null, counters: 0 };
  const { state, priv } = table(
    { hand: ['island', 'mountain', 'forest'], battlefield: ['forest', 'forest'] },
    { hand: ['plains'], battlefield: ['forest', 'island', 'mountain', 'swamp'] },
    { phase: 'respond', activeSeat: 1, pending },
  );
  const actions = legalActions(state, 0, priv);
  const rand = mulberry32(5);
  let easy = 0;
  let normalCounters = 0;
  for (let k = 0; k < 200; k++) {
    if (chooseAction(state, 0, priv, actions, rand, 'easy').type === 'counter') easy++;
    if (chooseAction(state, 0, priv, actions, rand).type === 'counter') normalCounters++;
  }
  assert.ok(easy > 60 && easy < 140, `easy countered ${easy} of 200`);
  assert.equal(normalCounters, 200);
});

test('hard plays the land that wins', () => {
  const { state, priv } = table({ hand: ['mountain', 'plains', 'island'], battlefield: ['forest', 'island', 'mountain', 'swamp'] }, { battlefield: ['forest'] });
  const action = searchAction(state, 0, priv, legalActions(state, 0, priv), { rounds: 20, rand: mulberry32(2) });
  assert.ok(action.type === 'play' && action.land === 'plains', JSON.stringify(action));
});

test('hard counters a land that would win', () => {
  const pending: PendingPlay = { card: 'p1-slot-00', land: 'plains', controller: 1, declaredTarget: null, counters: 0 };
  const { state, priv } = table(
    { hand: ['island', 'mountain', 'forest'], battlefield: ['forest', 'forest'] },
    { hand: ['plains'], battlefield: ['forest', 'island', 'mountain', 'swamp'] },
    { phase: 'respond', activeSeat: 1, pending },
  );
  const action = searchAction(state, 0, priv, legalActions(state, 0, priv), { rounds: 20, rand: mulberry32(3) });
  assert.equal(action.type, 'counter');
});
