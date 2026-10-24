// The computer opponent: drives one seat's MatchCoordinator with the policy.
// The coordinator is a real peer over a transport, so the bot goes through
// the same setup, reveals and audit as a person, and only ever knows what its
// seat may know. Forced moves (draw keys, Swamp reveals) the coordinator makes
// itself; the bot only chooses plays, counters and targets.

import type { MatchCoordinator } from '../match/coordinator.ts';
import { IllegalActionError } from '../engine/types.ts';
import { chooseAction } from './policy.ts';

export interface BotOptions {
  /** How long the bot appears to think before each move, in ms. */
  readonly thinkMs?: number;
  /** Tie-breaking randomness for the policy. */
  readonly rand?: () => number;
  /** While true (the board is still animating), the bot waits before thinking. */
  readonly busy?: () => boolean;
}

/** How often a waiting bot checks whether the board has settled. */
const BUSY_POLL_MS = 100;

/** Play `coordinator`'s seat until stopped or the match ends. Returns a stop function. */
export function runBot(coordinator: MatchCoordinator, options: BotOptions = {}): () => void {
  const { thinkMs = 700, rand = Math.random, busy = () => false } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const schedule = (ms: number): void => {
    if (timer === null && !stopped) timer = setTimeout(move, ms);
  };
  const wake = (): void => {
    if (coordinator.legalActions().length > 0) schedule(thinkMs);
  };
  function move(): void {
    timer = null;
    if (stopped) return;
    if (busy()) return schedule(BUSY_POLL_MS);
    const state = coordinator.state;
    const actions = coordinator.legalActions();
    if (state === null || actions.length === 0) return;
    try {
      coordinator.submit(chooseAction(state, coordinator.seat, coordinator.privateHand, actions, rand));
    } catch (err) {
      // The state moved on under us (a race with the peer); think again.
      if (!(err instanceof IllegalActionError)) throw err;
      wake();
    }
  }

  const off = coordinator.onChange(wake);
  wake();
  return () => {
    stopped = true;
    off();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
