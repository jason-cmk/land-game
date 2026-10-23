// Wire format between two coordinators. Engine actions never carry keys; the
// match layer wraps them with the Mental Poker secrets that make each reveal
// and draw verifiable, and strips them again before calling engine apply().
// Every BigInt travels as a lowercase hex string.

import type { Action, CardId, Land, Seat } from '../engine/types.ts';

export const PROTOCOL_VERSION = 1;
export const RULES_VERSION = 1;

/** A card made public by an action. ownerKey is required while the slot is still hidden. */
export interface Reveal {
  readonly card: CardId;
  readonly land: Land;
  readonly ownerKey?: string;
}

export type MatchAction =
  | { readonly type: 'grantDrawKey'; readonly card: CardId; readonly key: string }
  | { readonly type: 'play'; readonly reveal: Reveal; readonly declaredTarget?: CardId }
  | { readonly type: 'pass' }
  | { readonly type: 'counter'; readonly island: Reveal; readonly other: Reveal }
  | { readonly type: 'allow' }
  | { readonly type: 'revealHandForSwamp'; readonly cards: readonly Reveal[] }
  | { readonly type: 'resolveTarget'; readonly target: CardId }
  | { readonly type: 'resign' };

/** Log entry 0: everything both peers agreed on before turn 1. */
export interface StartRecord {
  readonly type: 'start';
  readonly first: Seat;
  /** Final double-locked decks, indexed by owner seat. */
  readonly decks: readonly [readonly string[], readonly string[]];
  /** openingKeys[s]: seat s's per-slot keys for its opponent's opening hand (slots 0-4). */
  readonly openingKeys: readonly [readonly string[], readonly string[]];
}

export type LoggedAction = StartRecord | MatchAction;

export type ShuffleStep = 'A' | 'B' | 'C' | 'D';

export type Message =
  | { readonly t: 'hello'; readonly protocol: number; readonly rules: number; readonly prime: string; readonly turnCommit: string }
  | { readonly t: 'turnReveal'; readonly seed: string }
  | { readonly t: 'shuffleStep'; readonly deckOwner: Seat; readonly step: ShuffleStep; readonly cards: readonly string[] }
  | { readonly t: 'openingKeys'; readonly keys: readonly string[] }
  | { readonly t: 'ready'; readonly headHash: string }
  | { readonly t: 'action'; readonly seq: number; readonly action: MatchAction; readonly headHash: string }
  /** Sent after a reconnect: the sender's log length and head hash. */
  | { readonly t: 'resume'; readonly length: number; readonly headHash: string }
  /** End-of-game: all of the sender's per-slot keys, for its own deck and for the opponent's. */
  | { readonly t: 'audit'; readonly ownDeck: readonly string[]; readonly otherDeck: readonly string[] }
  | { readonly t: 'bye'; readonly reason: 'void' | 'forfeit'; readonly detail: string };

/** The engine view of a match action: same shape, keys removed. */
export function toEngineAction(action: MatchAction): Action {
  switch (action.type) {
    case 'grantDrawKey':
      return { type: 'grantDrawKey', card: action.card };
    case 'play':
      return action.declaredTarget === undefined
        ? { type: 'play', card: action.reveal.card, land: action.reveal.land }
        : { type: 'play', card: action.reveal.card, land: action.reveal.land, declaredTarget: action.declaredTarget };
    case 'counter':
      return {
        type: 'counter',
        island: action.island.card,
        islandLand: action.island.land,
        other: action.other.card,
        otherLand: action.other.land,
      };
    case 'revealHandForSwamp':
      return { type: 'revealHandForSwamp', cards: action.cards.map((r) => ({ card: r.card, land: r.land })) };
    case 'pass':
    case 'allow':
    case 'resolveTarget':
    case 'resign':
      return action;
  }
}

export function toHex(value: bigint): string {
  return value.toString(16);
}

/** Parse a hex BigInt from the wire. Throws on anything that is not plain lowercase hex. */
export function fromHex(text: unknown): bigint {
  if (typeof text !== 'string' || !/^[0-9a-f]{1,2048}$/.test(text)) {
    throw new ProtocolError(`not a hex value: ${String(text).slice(0, 40)}`);
  }
  return BigInt(`0x${text}`);
}

/** Card id to its post-shuffle deck slot: 'p1-slot-07' -> { owner: 1, slot: 7 }. */
export function slotOf(card: CardId): { owner: Seat; slot: number } {
  const match = /^p([01])-slot-(\d{2})$/.exec(card);
  if (match === null) throw new ProtocolError(`not a card id: ${card}`);
  return { owner: Number(match[1]) as Seat, slot: Number(match[2]) };
}

/** A peer message broke the protocol (malformed, out of order, or failed a check). */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}
