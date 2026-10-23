// Engine types. Zero dependencies, no DOM, no crypto, no clock.
// Hidden cards are CardSlots with land === null: both peers hold the identical
// shared state, and the match layer fills in land values via verified reveals.

export type Seat = 0 | 1;

export function other(seat: Seat): Seat {
  return seat === 0 ? 1 : 0;
}

export type Land = 'forest' | 'island' | 'mountain' | 'plains' | 'swamp';

export const LANDS: readonly Land[] = [
  'forest',
  'island',
  'mountain',
  'plains',
  'swamp',
];

export type CardId = string; // deterministic slot id, e.g. 'p0-slot-07'

/** A card slot in the shared state. land === null means both peers see it hidden. */
export interface CardSlot {
  readonly id: CardId;
  readonly land: Land | null;
}

export interface PlayerState {
  /** Index 0 is the top of the deck. */
  readonly library: readonly CardSlot[];
  readonly hand: readonly CardSlot[];
  readonly battlefield: readonly CardSlot[];
  readonly graveyard: readonly CardSlot[];
}

export type WinReason = 'domain' | 'mono' | 'decked' | 'resign';

export type PendingStep =
  | 'swampReveal' // opponent must reveal their whole hand
  | 'chooseTarget'; // controller must choose a target for the pending effect

export interface PendingPlay {
  readonly card: CardId;
  readonly land: Land;
  readonly controller: Seat;
  /** Target declared at announcement (Mountain / Forest / Plains-reuse). */
  readonly declaredTarget: CardId | null;
  /** For Plains only: the land type being reused. */
  readonly reuseLand: Land | null;
  /** Counters played so far in the response chain. */
  readonly counters: number;
}

export type Phase =
  | 'main' // active player: play or pass; opponent: nothing
  | 'respond' // counter chain; responder derived from pending.counters parity
  | 'revealHand' // opponent of a resolving Swamp must reveal their hand
  | 'target' // controller of a resolving Plains-reused effect picks a target
  | 'drawKey' // a card was drawn; the other seat must grant the key
  | 'over';

export interface DrawRequest {
  /** The player who drew the card (and who needs the key privately). */
  readonly seat: Seat;
  readonly card: CardId;
  /** What happens once the key is granted. */
  readonly purpose: 'turnStart' | 'islandDraw';
}

export interface GameState {
  readonly turn: number; // 1-based
  readonly activeSeat: Seat;
  readonly phase: Phase;
  readonly players: readonly [PlayerState, PlayerState];
  readonly pending: PendingPlay | null;
  readonly awaitingDraw: DrawRequest | null;
  readonly winner: null | { seat: Seat; reason: WinReason };
}

export type Action =
  /** The other seat unlocks the drawn card for the drawer. Effect-free on state. */
  | { readonly type: 'grantDrawKey'; readonly card: CardId }
  /** Play a land. land is the (verified by match/) plaintext land of the slot. */
  | { readonly type: 'play'; readonly card: CardId; readonly land: Land; readonly declaredTarget?: CardId }
  | { readonly type: 'pass' }
  /** Counter: pay Island + one other land. Reveals both. */
  | { readonly type: 'counter'; readonly island: CardId; readonly islandLand: Land; readonly other: CardId; readonly otherLand: Land }
  | { readonly type: 'allow' }
  /** Thoughtseize reveal: the opponent reveals their entire hand. */
  | { readonly type: 'revealHandForSwamp'; readonly cards: ReadonlyArray<{ readonly card: CardId; readonly land: Land }> }
  /** Choose a target during 'target' phase (Plains-reused Mountain/Forest, or Swamp discard). */
  | { readonly type: 'resolveTarget'; readonly target: CardId }
  | { readonly type: 'resign' };

export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalActionError';
  }
}
