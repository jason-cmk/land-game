// Canonical slot selection for "spend known copies first".
//
// When a player plays (or counters with) a land type, and their hand contains
// a card whose land type is already publicly known to both players, they MUST
// spend that public copy. Spending a hidden copy instead would reveal that the
// player holds a second copy of that land type.
//
// This lives in match/ (not board/) because both the acting client and the
// observing coordinator need the same canonical choice. The engine enforces
// the invariant independently on apply().

import type { CardId, CardSlot, Land } from '../engine/types.ts';

/**
 * Pick the slot to spend for `land`.
 * 1. If a publicly known copy (slot.land === land) exists in hand, use the
 *    first such slot in hand order.
 * 2. Otherwise use the first hidden slot privately known to be `land`
 *    (privateHand maps CardId -> Land for this seat's own hidden cards).
 * 3. Otherwise null: the player does not (knowingly) hold one.
 */
export function pickSpendFirstSlot(
  hand: readonly CardSlot[],
  land: Land,
  privateHand: ReadonlyMap<CardId, Land> | undefined,
): CardId | null {
  const publicCopy = hand.find((s) => s.land === land);
  if (publicCopy) return publicCopy.id;
  if (privateHand === undefined) return null;
  const hidden = hand.find((s) => s.land === null && privateHand.get(s.id) === land);
  return hidden === undefined ? null : hidden.id;
}
