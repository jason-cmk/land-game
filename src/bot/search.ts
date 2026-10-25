// The hard computer: plays each option out to the end of the game many times
// and keeps the one that wins most often. Every playout starts from a fresh
// guess at the hidden cards (guessTruth), drawn only from what this seat
// knows, so it counts cards but never peeks. Both sides of a playout use the
// normal greedy policy. All options share each guess, so luck in the deal
// affects them alike and the comparison stays fair.

import { chooseAction } from './policy.ts';
import { act, guessTruth, playOut } from './sim.ts';
import type { Chooser } from './sim.ts';
import type { Action, CardId, GameState, Land, Seat } from '../engine/types.ts';

export interface SearchOptions {
  /** Guesses to play every option out against. */
  readonly rounds?: number;
  /** Stop starting new rounds after this long, in ms (at least one round always runs). */
  readonly budgetMs?: number;
  readonly rand?: () => number;
}

/** Pick the option that wins the most playouts for `seat`. */
export function searchAction(state: GameState, seat: Seat, priv: ReadonlyMap<CardId, Land>, actions: readonly Action[], options: SearchOptions = {}): Action {
  const steps = search(state, seat, priv, actions, options);
  for (let step = steps.next(); ; step = steps.next()) if (step.done) return step.value;
}

/** The same, giving the page its turn every `sliceMs` so a long think does not freeze it. */
export async function searchActionSliced(
  state: GameState,
  seat: Seat,
  priv: ReadonlyMap<CardId, Land>,
  actions: readonly Action[],
  options: SearchOptions & { readonly sliceMs?: number } = {},
): Promise<Action> {
  const { sliceMs = 15 } = options;
  const steps = search(state, seat, priv, actions, options);
  let slice = performance.now();
  for (let step = steps.next(); ; step = steps.next()) {
    if (step.done) return step.value;
    if (performance.now() - slice > sliceMs) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      slice = performance.now();
    }
  }
}

/** Yields after each round of playouts; returns the choice. */
function* search(state: GameState, seat: Seat, priv: ReadonlyMap<CardId, Land>, actions: readonly Action[], options: SearchOptions): Generator<void, Action> {
  const { rounds = 100, budgetMs = Infinity, rand = Math.random } = options;
  const candidates = actions.filter((a) => a.type !== 'resign');
  if (candidates.length <= 1) return candidates[0] ?? actions[0]!;
  const rollout: Chooser = (s, who, p, acts) => chooseAction(s, who, p, acts, rand);
  const wins = candidates.map(() => 0);
  const deadline = performance.now() + budgetMs;
  for (let round = 0; round < rounds && (round === 0 || performance.now() < deadline); round++) {
    const world = { state, truth: guessTruth(state, seat, priv, rand) };
    candidates.forEach((action, i) => {
      if (playOut(act(world, seat, action), rollout) === seat) wins[i]!++;
    });
    yield;
  }
  // Equal win counts fall back on the greedy policy's preference among them.
  const top = Math.max(...wins);
  const best = candidates.filter((_, i) => wins[i] === top);
  return best.length === 1 ? best[0]! : chooseAction(state, seat, priv, best, rand);
}
