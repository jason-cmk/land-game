// A fast, plaintext stand-in for a match: the engine plus the true land of
// every slot, with no cryptography. The hard computer plays out guesses at the
// hidden cards with it, and the bot benchmark plays whole games with it.

import { apply, createGame, legalActions, CARDS_PER_TYPE } from '../engine/game.ts';
import { LANDS } from '../engine/types.ts';
import type { Action, CardId, CardSlot, GameState, Land, Seat } from '../engine/types.ts';

export interface World {
  readonly state: GameState;
  /** The land in every slot of both decks, hidden or not. */
  readonly truth: ReadonlyMap<CardId, Land>;
}

/** Picks one of `actions` for `seat`, knowing only what that seat may know. */
export type Chooser = (state: GameState, seat: Seat, priv: ReadonlyMap<CardId, Land>, actions: readonly Action[]) => Action;

/** Shuffle `items` in place with `rand`. */
export function shuffle<T>(items: T[], rand: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

function allSlots(state: GameState, seat: Seat): CardSlot[] {
  const p = state.players[seat];
  return [...p.library, ...p.hand, ...p.battlefield, ...p.graveyard];
}

/** A new game with both decks shuffled. */
export function deal(first: Seat, rand: () => number): World {
  const state = createGame(first);
  const truth = new Map<CardId, Land>();
  for (const seat of [0, 1] as const) {
    const lands = shuffle(LANDS.flatMap((land) => Array<Land>(CARDS_PER_TYPE).fill(land)), rand);
    allSlots(state, seat).forEach((slot, i) => truth.set(slot.id, lands[i]!));
  }
  return { state, truth };
}

/** What `seat` privately knows: the lands of its own hidden hand cards. */
export function privateView(world: World, seat: Seat): Map<CardId, Land> {
  const priv = new Map<CardId, Land>();
  for (const slot of world.state.players[seat].hand) if (slot.land === null) priv.set(slot.id, world.truth.get(slot.id)!);
  return priv;
}

/** The seat with a choice to make now, with its options; null once the game is over. */
export function toMove(world: World): { seat: Seat; actions: Action[] } | null {
  for (const seat of [0, 1] as const) {
    const actions = legalActions(world.state, seat, privateView(world, seat));
    if (actions.length > 0) return { seat, actions };
  }
  return null;
}

const forced = (action: Action): boolean => action.type === 'grantDrawKey' || action.type === 'revealHandForSwamp';

/** Apply `action`, then the forced moves (draw keys, Swamp reveals) that follow it. */
export function act(world: World, seat: Seat, action: Action): World {
  let next: World = { state: apply(world.state, seat, action), truth: world.truth };
  for (let move = toMove(next); move !== null && move.actions.length === 1 && forced(move.actions[0]!); move = toMove(next)) {
    next = { state: apply(next.state, move.seat, move.actions[0]!), truth: next.truth };
  }
  return next;
}

/** Play on with `choose` for both seats; returns the winner, or null if `maxMoves` runs out first. */
export function playOut(world: World, choose: Chooser, maxMoves = 400): Seat | null {
  let current = world;
  for (let n = 0; n < maxMoves; n++) {
    if (current.state.winner !== null) return current.state.winner.seat;
    const move = toMove(current);
    if (move === null) return null;
    current = act(current, move.seat, choose(current.state, move.seat, privateView(current, move.seat), move.actions));
  }
  return current.state.winner?.seat ?? null;
}

/**
 * One guess at every hidden card, consistent with what `seat` knows: each deck
 * holds ten of each land, less the cards already seen (public ones, its own
 * hand, and the land on the stack). The rest are dealt at random.
 */
export function guessTruth(state: GameState, seat: Seat, priv: ReadonlyMap<CardId, Land>, rand: () => number): Map<CardId, Land> {
  const truth = new Map<CardId, Land>();
  for (const owner of [0, 1] as const) {
    const left = new Map<Land, number>(LANDS.map((land) => [land, CARDS_PER_TYPE]));
    const hidden: CardId[] = [];
    for (const slot of allSlots(state, owner)) {
      const known = slot.land ?? priv.get(slot.id) ?? (state.pending?.card === slot.id ? state.pending.land : null);
      if (known === null) hidden.push(slot.id);
      else {
        truth.set(slot.id, known);
        left.set(known, left.get(known)! - 1);
      }
    }
    const pool = shuffle(LANDS.flatMap((land) => Array<Land>(Math.max(0, left.get(land)!)).fill(land)), rand);
    hidden.forEach((id, i) => truth.set(id, pool[i] ?? 'plains'));
  }
  return truth;
}
