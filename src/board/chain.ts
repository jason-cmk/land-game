// The counter chain on the stack: which cards paid for each counter, in order.
// The engine keeps only the count (the paid cards are already in graveyards),
// so the board rebuilds the chain from the action log since the last play.
// Pure: no DOM, no rendering.

import type { CardId, GameState, Seat } from '../engine/types.ts';

/** One counter: who paid, with the Island first. */
export interface ChainLink {
  readonly seat: Seat;
  readonly cards: readonly [CardId, CardId];
}

/** A logged action, reduced to what the chain needs. */
export type ChainStep = { readonly kind: 'play' } | { readonly kind: 'counter'; readonly link: ChainLink } | { readonly kind: 'other' };

/**
 * The counters paid against the pending play, oldest first. Empty when nothing
 * is pending, or when the log does not match the state (the table then falls
 * back to showing the cards in their graveyards).
 */
export function counterChain(state: GameState, steps: readonly ChainStep[]): ChainLink[] {
  const pending = state.pending;
  if (pending === null || pending.counters === 0) return [];
  const chain: ChainLink[] = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.kind === 'play') break;
    if (step.kind === 'counter') chain.unshift(step.link);
  }
  if (chain.length !== pending.counters) return [];
  const paid = chain.every((link) => link.cards.every((id) => state.players[link.seat].graveyard.some((s) => s.id === id)));
  return paid ? chain : [];
}

/** What letting the pending play resolve right now would do. */
export function chainOutcome(state: GameState): 'resolves' | 'countered' | null {
  const pending = state.pending;
  if (pending === null) return null;
  return pending.counters % 2 === 0 ? 'resolves' : 'countered';
}
