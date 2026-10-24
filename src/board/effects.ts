// What just happened, as animation cues. The engine returns states, not
// events, so the board compares consecutive states: every card that changed
// zone (or became public) is a cue, labelled by the pending play that caused
// it. Pure and rule-free: it observes zone changes, it never decides them.

import type { CardId, GameState, Land, Seat, WinReason } from '../engine/types.ts';

export type Cue =
  /** A land was played and sits on the stack waiting for responses. */
  | { readonly kind: 'announce'; readonly card: CardId; readonly land: Land; readonly seat: Seat }
  /** Plains declared which land it reuses. */
  | { readonly kind: 'reuse'; readonly card: CardId; readonly seat: Seat }
  /** Island + another land paid to counter. */
  | { readonly kind: 'counter'; readonly cards: readonly CardId[]; readonly seat: Seat }
  /** The pending play was countered and goes to the graveyard. */
  | { readonly kind: 'countered'; readonly card: CardId }
  /** The pending play resolved onto the battlefield. */
  | { readonly kind: 'enter'; readonly card: CardId; readonly land: Land; readonly seat: Seat }
  /** A battlefield land destroyed (Mountain, or Plains reusing Mountain). */
  | { readonly kind: 'meteor'; readonly card: CardId; readonly seat: Seat }
  /** A land returned from graveyard to hand (Forest). */
  | { readonly kind: 'regrowth'; readonly card: CardId; readonly seat: Seat }
  /** A hand card discarded by Swamp. */
  | { readonly kind: 'discard'; readonly card: CardId; readonly seat: Seat }
  /** Hand cards made public by a Swamp reveal. */
  | { readonly kind: 'reveal'; readonly cards: readonly CardId[]; readonly seat: Seat }
  | { readonly kind: 'draw'; readonly card: CardId; readonly seat: Seat }
  | { readonly kind: 'win'; readonly seat: Seat; readonly reason: WinReason };

type Zone = 'library' | 'hand' | 'battlefield' | 'graveyard';
const ZONES: readonly Zone[] = ['library', 'hand', 'battlefield', 'graveyard'];

interface Where {
  readonly owner: Seat;
  readonly zone: Zone;
  readonly land: Land | null;
}

function locate(state: GameState): Map<CardId, Where> {
  const map = new Map<CardId, Where>();
  for (const owner of [0, 1] as const) {
    for (const zone of ZONES) {
      for (const slot of state.players[owner][zone]) map.set(slot.id, { owner, zone, land: slot.land });
    }
  }
  return map;
}

export function cuesBetween(prev: GameState, next: GameState): Cue[] {
  const before = locate(prev);
  const after = locate(next);
  const cues: Cue[] = [];
  const pending = prev.pending;

  if (pending === null && next.pending !== null) {
    cues.push({ kind: 'announce', card: next.pending.card, land: next.pending.land, seat: next.pending.controller });
    if (next.pending.land === 'plains' && next.pending.declaredTarget !== null) {
      cues.push({ kind: 'reuse', card: next.pending.declaredTarget, seat: next.pending.controller });
    }
  }

  const paid: CardId[] = [];
  const revealed: CardId[] = [];
  for (const [card, was] of before) {
    const now = after.get(card);
    if (now === undefined) continue;
    if (was.zone === now.zone) {
      if (was.zone === 'hand' && was.land === null && now.land !== null) revealed.push(card);
      continue;
    }
    const move = `${was.zone}>${now.zone}`;
    if (move === 'library>hand') cues.push({ kind: 'draw', card, seat: now.owner });
    else if (move === 'graveyard>hand') cues.push({ kind: 'regrowth', card, seat: now.owner });
    else if (move === 'battlefield>graveyard') cues.push({ kind: 'meteor', card, seat: now.owner });
    else if (move === 'hand>battlefield') cues.push({ kind: 'enter', card, land: now.land!, seat: now.owner });
    else if (move === 'hand>graveyard') {
      if (pending !== null && card === pending.card) cues.push({ kind: 'countered', card });
      else if (pending !== null && next.pending !== null && next.pending.counters > pending.counters) paid.push(card);
      else cues.push({ kind: 'discard', card, seat: now.owner });
    }
  }
  if (paid.length > 0) cues.push({ kind: 'counter', cards: paid, seat: after.get(paid[0]!)!.owner });
  if (revealed.length > 0) cues.push({ kind: 'reveal', cards: revealed, seat: after.get(revealed[0]!)!.owner });
  if (prev.winner === null && next.winner !== null) cues.push({ kind: 'win', seat: next.winner.seat, reason: next.winner.reason });
  return cues;
}
