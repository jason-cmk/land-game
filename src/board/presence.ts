// Presence: what the opponent is touching, sent on the unreliable channel.
// Cosmetic only; it never reaches the coordinator or the engine.
//
// Hidden hand cards are identified by their index among the sender's hidden
// hand cards, in the sender's local visual order. That order shuffles each new
// card in, so the index never reveals which slot (a fresh draw, an old card)
// is being touched. Public cards (battlefield, graveyard, the stack, revealed
// hand cards) are named by id, which leaks nothing.

import type { CardId, GameState, Seat } from '../engine/types.ts';

export type Presence =
  | { readonly t: 'hoverHand'; readonly index: number | null }
  | { readonly t: 'hoverBoard'; readonly card: CardId | null }
  /** Normalised 0-1 in the sender's view. */
  | { readonly t: 'cursor'; readonly x: number; readonly y: number }
  /**
   * A card being dragged, identified like a hover; x/y as for the cursor. With
   * `aim`, the card stays put and x/y is where its targeting arrow points.
   */
  | { readonly t: 'dragHand'; readonly index: number; readonly x: number; readonly y: number; readonly aim?: boolean }
  | { readonly t: 'dragBoard'; readonly card: CardId; readonly x: number; readonly y: number; readonly aim?: boolean }
  | { readonly t: 'dragEnd' };

/**
 * Keep a hand's visual order across state changes: cards that left are
 * dropped, cards that arrived are inserted at a random position.
 */
export function nextHandOrder(previous: readonly CardId[], hand: readonly CardId[], random: () => number = Math.random): CardId[] {
  const present = new Set(hand);
  const order = previous.filter((id) => present.has(id));
  const known = new Set(order);
  for (const id of hand) {
    if (known.has(id)) continue;
    order.splice(Math.floor(random() * (order.length + 1)), 0, id);
  }
  return order;
}

/** Is this card visible to both players right now? */
export function isPublic(state: GameState, id: CardId): boolean {
  if (state.pending?.card === id) return true;
  for (const player of state.players) {
    if (player.battlefield.some((s) => s.id === id) || player.graveyard.some((s) => s.id === id)) return true;
    const inHand = player.hand.find((s) => s.id === id);
    if (inHand !== undefined) return inHand.land !== null;
  }
  return false;
}

/** The hidden cards of a hand, in visual order. */
function hiddenInOrder(state: GameState, order: readonly CardId[]): CardId[] {
  return order.filter((id) => !isPublic(state, id));
}

/** What to send when the local player hovers `id` (or nothing). */
export function hoverMessage(state: GameState, me: Seat, myHandOrder: readonly CardId[], id: CardId | null): Presence {
  if (id === null) return { t: 'hoverBoard', card: null };
  if (isPublic(state, id)) return { t: 'hoverBoard', card: id };
  const index = hiddenInOrder(state, myHandOrder).indexOf(id);
  return index === -1 ? { t: 'hoverBoard', card: null } : { t: 'hoverHand', index };
}

/**
 * Which card on our table a peer hover points at, or null. `theirHandOrder` is
 * the order we display their hand in. Anything malformed or stale maps to null.
 */
export function hoveredCard(state: GameState, theirHandOrder: readonly CardId[], message: Presence): CardId | null {
  if (message.t === 'hoverBoard') {
    const card = message.card;
    return typeof card === 'string' && isPublic(state, card) ? card : null;
  }
  if (message.t === 'hoverHand') {
    const index = message.index;
    if (index === null || !Number.isInteger(index)) return null;
    return hiddenInOrder(state, theirHandOrder)[index] ?? null;
  }
  return null;
}

/** What to send while the local player drags `id` to normalised `at`. */
export function dragMessage(state: GameState, me: Seat, myHandOrder: readonly CardId[], id: CardId, at: { x: number; y: number }, aim = false): Presence {
  const hover = hoverMessage(state, me, myHandOrder, id);
  const aiming = aim ? { aim: true } : {};
  if (hover.t === 'hoverHand' && hover.index !== null) return { t: 'dragHand', index: hover.index, ...at, ...aiming };
  if (hover.t === 'hoverBoard' && hover.card !== null) return { t: 'dragBoard', card: hover.card, ...at, ...aiming };
  return { t: 'dragEnd' };
}

/** Which card a peer drag moves, and where to in our view; null for anything else. */
export function peerDrag(state: GameState, theirHandOrder: readonly CardId[], message: Presence): { card: CardId; at: { x: number; y: number }; aim: boolean } | null {
  let card: CardId | null = null;
  if (message.t === 'dragHand') card = hoveredCard(state, theirHandOrder, { t: 'hoverHand', index: message.index });
  else if (message.t === 'dragBoard') card = hoveredCard(state, theirHandOrder, { t: 'hoverBoard', card: message.card });
  else return null;
  const at = peerCursor({ t: 'cursor', x: message.x, y: message.y });
  return card === null || at === null ? null : { card, at, aim: message.aim === true };
}

/** A peer cursor in our view: clamped, and flipped because they sit opposite. */
export function peerCursor(message: Presence): { x: number; y: number } | null {
  if (message.t !== 'cursor' || typeof message.x !== 'number' || typeof message.y !== 'number') return null;
  if (!Number.isFinite(message.x) || !Number.isFinite(message.y)) return null;
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  return { x: clamp(message.x), y: 1 - clamp(message.y) };
}
