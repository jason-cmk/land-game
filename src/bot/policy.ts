// The computer opponent's choices. Pure: given what one seat may know (the
// shared state, its own private hand and its legal actions) it picks one action.
// It never sees the opponent's hidden cards, because nothing passes them in.
//
// A small greedy scorer, not a search: play toward Domain or Mono, knock back
// the opponent's progress, counter a land that would win (or a costly one
// while the hand can spare two cards), and pay counters with the least useful
// cards. Ties and near-ties break randomly so matches vary. The easy style
// blurs the scores, spends its last Island freely and lets half the winning
// lands through; the hard computer (search.ts) plays games out with this one.

import { counterResponder } from '../engine/game.ts';
import { LANDS, other } from '../engine/types.ts';
import type { Action, CardId, CardSlot, GameState, Land, Seat } from '../engine/types.ts';

/** Lands needed to win from these lands on the battlefield: 0 means won. */
export function distance(lands: readonly Land[]): number {
  const counts = LANDS.map((land) => lands.filter((l) => l === land).length);
  const distinct = counts.filter((n) => n > 0).length;
  return Math.max(0, Math.min(5 - distinct, 5 - Math.max(...counts)));
}

/** How much one more `land` on this battlefield brings its controller closer to winning. */
export function gain(battlefield: readonly Land[], land: Land): number {
  return distance(battlefield) - distance([...battlefield, land]);
}

/** How much losing `card` from this battlefield sets its controller back. */
export function loss(battlefield: readonly CardSlot[], card: CardId): number {
  const lands = battlefield.map((s) => s.land!);
  const without = battlefield.filter((s) => s.id !== card).map((s) => s.land!);
  return distance(without) - distance(lands);
}

/** Hand size at which the computer counters a merely costly play, not just a winning one. */
const SPARE_HAND = 6;

export type Style = 'easy' | 'normal';

interface Tuning {
  /** Random spread added to every score: 0.5 only breaks ties, more makes mistakes. */
  readonly noise: number;
  /** Hold back the last Island in hand for countering. */
  readonly keepIsland: boolean;
  /** Counter costly plays as well as winning ones. */
  readonly costlyCounters: boolean;
  /** Chance of countering a land that would win. */
  readonly winCounters: number;
}

const TUNING: Record<Style, Tuning> = {
  easy: { noise: 12, keepIsland: false, costlyCounters: false, winCounters: 0.5 },
  normal: { noise: 0.5, keepIsland: true, costlyCounters: true, winCounters: 1 },
};

/**
 * Pick one of `actions` for `seat`. `rand` returns [0, 1) and only breaks
 * ties, so a seeded one makes the choice reproducible.
 */
export function chooseAction(
  state: GameState,
  seat: Seat,
  priv: ReadonlyMap<CardId, Land>,
  actions: readonly Action[],
  rand: () => number = Math.random,
  style: Style = 'normal',
): Action {
  if (actions.length === 0) throw new Error('chooseAction needs at least one legal action');
  if (actions.length === 1) return actions[0]!;
  const tuning = TUNING[style];
  const view = new View(state, seat, priv, tuning, tuning.winCounters >= 1 || rand() < tuning.winCounters);
  let best: Action = actions[0]!;
  let bestScore = -Infinity;
  for (const action of actions) {
    const score = view.score(action) + rand() * tuning.noise;
    if (score > bestScore) {
      best = action;
      bestScore = score;
    }
  }
  return best;
}

/** One seat's view of the table, with the scoring rules. */
class View {
  private readonly state: GameState;
  private readonly seat: Seat;
  private readonly priv: ReadonlyMap<CardId, Land>;
  private readonly opponent: Seat;
  private readonly tuning: Tuning;
  /** Whether a winning land gets countered this time (always, except for the easy style). */
  private readonly stopWins: boolean;

  constructor(state: GameState, seat: Seat, priv: ReadonlyMap<CardId, Land>, tuning: Tuning = TUNING.normal, stopWins = true) {
    this.state = state;
    this.seat = seat;
    this.priv = priv;
    this.opponent = other(seat);
    this.tuning = tuning;
    this.stopWins = stopWins;
  }

  score(action: Action): number {
    switch (action.type) {
      case 'pass':
        return 0;
      case 'play':
        return this.playScore(action.land, action.declaredTarget);
      case 'allow':
        return 0;
      case 'counter':
        return this.counterScore(action.otherLand);
      case 'resolveTarget':
        return this.targetScore(action.target);
      // Forced moves: the coordinator makes them, but score them sensibly anyway.
      case 'grantDrawKey':
      case 'revealHandForSwamp':
        return 0;
      case 'resign':
        return -Infinity;
    }
  }

  private lands(seat: Seat): Land[] {
    return this.state.players[seat].battlefield.map((s) => s.land!);
  }

  /** What a card in this seat's own hand is, if it knows. */
  private ownLand(slot: CardSlot): Land | null {
    return slot.land ?? this.priv.get(slot.id) ?? null;
  }

  private landOf(card: CardId): Land | null {
    for (const player of this.state.players) {
      for (const zone of [player.hand, player.battlefield, player.graveyard]) {
        const slot = zone.find((s) => s.id === card);
        if (slot !== undefined) return slot.land ?? this.priv.get(card) ?? null;
      }
    }
    return null;
  }

  private playScore(land: Land, target: CardId | undefined): number {
    const mine = this.lands(this.seat);
    if (distance([...mine, land]) === 0) return 1000; // wins on entry
    let score = 1 + 10 * gain(mine, land);
    // Keep the last Island for countering unless the play is worth more.
    const islands = this.state.players[this.seat].hand.filter((s) => this.ownLand(s) === 'island').length;
    if (this.tuning.keepIsland && land === 'island' && islands === 1) score -= 2;
    return score + this.effectScore(land, target);
  }

  /** What a land's effect is worth now, with its declared target. */
  private effectScore(land: Land, target: CardId | undefined): number {
    const opponent = this.state.players[this.opponent];
    switch (land) {
      case 'island':
        return 0;
      case 'plains':
        return 3;
      case 'swamp':
        return opponent.hand.length > 0 ? 3 : 0;
      case 'mountain':
        return target === undefined ? 0 : 2 + 8 * loss(opponent.battlefield, target);
      case 'forest': {
        const back = target === undefined ? null : this.landOf(target);
        return back === null ? 0 : 1 + 5 * gain(this.lands(this.seat), back);
      }
    }
  }

  /** How much the land on the stack matters to whoever played it: a win, or roughly how costly. */
  private stake(): { wins: boolean; value: number } {
    const pending = this.state.pending!;
    const lands = this.lands(pending.controller);
    const wins = distance([...lands, pending.land]) === 0;
    let value = gain(lands, pending.land);
    if (pending.land === 'mountain' && pending.declaredTarget !== null) {
      value += loss(this.state.players[other(pending.controller)].battlefield, pending.declaredTarget);
    }
    if (pending.land === 'swamp') value += 1;
    return { wins, value };
  }

  /** Should this seat counter now? Positive means yes. */
  private wantCounter(): number {
    const pending = this.state.pending;
    if (pending === null || counterResponder(pending) !== this.seat) return -1;
    const { wins, value } = this.stake();
    const handSize = this.state.players[this.seat].hand.length;
    if (wins) return this.stopWins ? 100 : -1;
    return this.tuning.costlyCounters && handSize >= SPARE_HAND && value >= 2 ? value : -1;
  }

  /** Countering is worth what the play is, less the card it costs besides the Island. */
  private counterScore(otherLand: Land): number {
    const want = this.wantCounter();
    if (want < 0) return -10;
    // Pay with what helps least on the battlefield, and with what is plentiful in hand.
    const spare = this.state.players[this.seat].hand.filter((s) => this.ownLand(s) === otherLand).length;
    return want - 3 * gain(this.lands(this.seat), otherLand) + 0.2 * spare;
  }

  /** A resolving effect's choice: the opponent's best land to destroy or discard, or our best land back. */
  private targetScore(target: CardId): number {
    const opponent = this.state.players[this.opponent];
    if (opponent.battlefield.some((s) => s.id === target)) return loss(opponent.battlefield, target);
    const land = this.landOf(target);
    if (land === null) return 0;
    if (opponent.hand.some((s) => s.id === target)) return gain(this.lands(this.opponent), land) + (land === 'island' ? 0.6 : 0);
    return gain(this.lands(this.seat), land);
  }
}
