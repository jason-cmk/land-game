// Pure game rules. apply() is the only writer of GameState; every transition is
// deterministic. Cryptographic verification of reveals happens in match/, which
// throws before reaching here if a proof is bad.

import { IllegalActionError, LANDS, other } from './types.ts';
import type {
  Action,
  CardId,
  CardSlot,
  GameState,
  Land,
  PendingPlay,
  PlayerState,
  Seat,
} from './types.ts';

export const CARDS_PER_TYPE = 10;
export const OPENING_HAND_SIZE = 5;
export const DECK_SIZE = CARDS_PER_TYPE * LANDS.length;

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function slotIds(seat: Seat): CardId[] {
  const tag = seat === 0 ? 'p0' : 'p1';
  return Array.from({ length: DECK_SIZE }, (_, k) => `${tag}-slot-${String(k).padStart(2, '0')}`);
}

function hiddenSlots(ids: CardId[]): CardSlot[] {
  return ids.map((id) => ({ id, land: null }));
}

export function createGame(activeSeat: Seat): GameState {
  const p0 = dealSeat(0 as Seat);
  const p1 = dealSeat(1 as Seat);
  // Turn 1: the player on the play skips their first draw.
  return {
    turn: 1,
    activeSeat: activeSeat,
    phase: 'main',
    players: [p0, p1],
    pending: null,
    awaitingDraw: null,
    winner: null,
  };
}

function dealSeat(seat: Seat): PlayerState {
  const all = hiddenSlots(slotIds(seat));
  return {
    library: all.slice(OPENING_HAND_SIZE),
    hand: all.slice(0, OPENING_HAND_SIZE),
    battlefield: [],
    graveyard: [],
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function findSlot(list: readonly CardSlot[], id: CardId): CardSlot | undefined {
  return list.find((s) => s.id === id);
}

/** True when the seat's battlefield satisfies either win condition. */
export function hasWon(player: PlayerState): boolean {
  return winReason(player) !== null;
}

/** Which win condition a battlefield satisfies; null when none. */
export function winReason(player: PlayerState): 'domain' | 'mono' | null {
  const lands = player.battlefield.flatMap((s) => (s.land !== null ? [s.land] : []));
  const distinct = new Set(lands);
  if (distinct.size === LANDS.length) return 'domain';
  for (const land of LANDS) {
    let n = 0;
    for (const l of lands) if (l === land) n++;
    if (n >= 5) return 'mono';
  }
  return null;
}

/** The seat entitled to act on the pending counter chain right now. */
export function counterResponder(pending: PendingPlay): Seat {
  return pending.counters % 2 === 0 ? other(pending.controller) : pending.controller;
}

// ---------------------------------------------------------------------------
// Shared structural helpers
// ---------------------------------------------------------------------------

function assertPublicLandMatches(slot: CardSlot, claimed: Land, what: string): void {
  if (slot.land !== null && slot.land !== claimed) {
    throw new IllegalActionError(`${what}: slot ${slot.id} is publicly ${slot.land}, not ${claimed}`);
  }
}

/**
 * A hidden slot must not be spent for a land type while a publicly known copy
 * of that type sits in the hand: playing it would leak that the player holds a
 * second copy. Playing any already-public copy is always fine.
 */
function spendKnownFirst(slot: CardSlot, hand: readonly CardSlot[], land: Land): void {
  if (slot.land === null && hand.some((s) => s.id !== slot.id && s.land === land)) {
    throw new IllegalActionError(`spend known copies first: a public ${land} copy is already in hand`);
  }
}

function withPlayer(state: GameState, seat: Seat, patch: (p: PlayerState) => PlayerState): GameState {
  const players: readonly [PlayerState, PlayerState] =
    seat === 0 ? [patch(state.players[0]), state.players[1]] : [state.players[0], patch(state.players[1])];
  return { ...state, players };
}

type Zone = 'library' | 'hand' | 'battlefield' | 'graveyard';

/** Move one card between zones of one seat, setting or keeping its public land. */
function moveTo(state: GameState, seat: Seat, from: Zone, to: 'hand' | 'battlefield' | 'graveyard', card: CardId, land: Land | null): GameState {
  return withPlayer(state, seat, (p) => {
    const source = p[from] as readonly CardSlot[];
    const slot = findSlot(source, card);
    if (!slot) throw new IllegalActionError(`card ${card} is not in ${from} of seat ${seat}`);
    const moved: CardSlot = { ...slot, land: land ?? slot.land };
    const rest = source.filter((s) => s.id !== card);
    if (rest.length !== source.length - 1) throw new IllegalActionError(`duplicate card entries for ${card} in ${from}`);
    return {
      ...p,
      [from]: rest,
      [to]: [...p[to], moved],
    } as PlayerState;
  });
}

/** Remove the top card of a seat's library into their hand. Null if empty. */
function popTop(state: GameState, seat: Seat): { state: GameState; card: CardSlot } | null {
  const player = state.players[seat];
  if (player.library.length === 0) return null;
  const top = player.library[0]!;
  const rest = player.library.slice(1);
  return {
    state: withPlayer(state, seat, (p) => ({ ...p, library: rest, hand: [...p.hand, top] })),
    card: top,
  };
}

/** End the current turn: flip seats, then run the start-of-turn draw. */
function endTurn(state: GameState): GameState {
  const nextSeat = other(state.activeSeat);
  const turn = state.turn + 1;
  const drawn = popTop(state, nextSeat);
  if (drawn === null) {
    return {
      ...state,
      activeSeat: nextSeat,
      turn,
      pending: null,
      awaitingDraw: null,
      phase: 'over',
      winner: { seat: other(nextSeat), reason: 'decked' },
    };
  }
  return {
    ...drawn.state,
    activeSeat: nextSeat,
    turn,
    pending: null,
    awaitingDraw: { seat: nextSeat, card: drawn.card.id, purpose: 'turnStart' },
    phase: 'drawKey',
  };
}

/** A draw inside a turn (Island resolution). Drawing from an empty deck loses. */
function drawFor(state: GameState, seat: Seat, purpose: 'islandDraw'): GameState {
  const drawn = popTop(state, seat);
  if (drawn === null) {
    return { ...state, pending: null, awaitingDraw: null, phase: 'over', winner: { seat: other(seat), reason: 'decked' } };
  }
  return { ...drawn.state, pending: null, awaitingDraw: { seat, card: drawn.card.id, purpose }, phase: 'drawKey' };
}

// ---------------------------------------------------------------------------
// Action application
// ---------------------------------------------------------------------------

export function apply(state: GameState, seat: Seat, action: Action): GameState {
  if (state.phase === 'over') throw new IllegalActionError('the game is over');

  switch (action.type) {
    case 'resign':
      return { ...state, phase: 'over', pending: null, awaitingDraw: null, winner: { seat: other(seat), reason: 'resign' } };

    case 'grantDrawKey':
      return applyGrantDrawKey(state, seat, action.card);

    case 'play':
      return applyPlay(state, seat, action.card, action.land, action.declaredTarget ?? null);

    case 'pass':
      return applyPass(state, seat);

    case 'counter':
      return applyCounter(state, seat, action.island, action.islandLand, action.other, action.otherLand);

    case 'allow':
      return applyAllow(state, seat);

    case 'revealHandForSwamp':
      return applyRevealHandForSwamp(state, seat, action.cards);

    case 'resolveTarget':
      return applyResolveTarget(state, seat, action.target);
  }
}

// --- grantDrawKey -----------------------------------------------------------

function applyGrantDrawKey(state: GameState, seat: Seat, card: CardId): GameState {
  const draw = state.awaitingDraw;
  if (state.phase !== 'drawKey' || draw === null) {
    throw new IllegalActionError('no card is waiting for a draw key');
  }
  if (seat !== other(draw.seat)) {
    throw new IllegalActionError(`seat ${other(draw.seat)} holds the other half of the lock on ${draw.card}`);
  }
  if (card !== draw.card) {
    throw new IllegalActionError(`expected a draw key for ${draw.card}, got ${card}`);
  }
  // Effect-free on state: the match layer decrypts the drawn card privately.
  const unlocked: GameState = { ...state, phase: 'main', awaitingDraw: null };
  return draw.purpose === 'turnStart' ? unlocked : endTurn(unlocked);
}

// --- play -------------------------------------------------------------------

function applyPlay(state: GameState, seat: Seat, card: CardId, land: Land, declaredTarget: CardId | null): GameState {
  if (state.phase !== 'main') throw new IllegalActionError('cannot play a land outside the main phase');
  if (seat !== state.activeSeat) throw new IllegalActionError('only the active player plays a land');

  const slot = findSlot(state.players[seat].hand, card);
  if (!slot) throw new IllegalActionError(`card ${card} is not in seat ${seat}'s hand`);
  assertPublicLandMatches(slot, land, 'play');
  spendKnownFirst(slot, state.players[seat].hand, land);

  let reuseLand: Land | null = null;
  switch (land) {
    case 'island':
    case 'swamp':
      if (declaredTarget !== null) throw new IllegalActionError(`${land} takes no declared target`);
      break;
    case 'mountain':
      if (declaredTarget !== null) {
        const target = findSlot(state.players[other(seat)].battlefield, declaredTarget);
        if (!target) throw new IllegalActionError(`declared target ${declaredTarget} is not an opponent battlefield land`);
      }
      break;
    case 'forest':
      if (declaredTarget !== null) {
        const target = findSlot(state.players[seat].graveyard, declaredTarget);
        if (!target) throw new IllegalActionError(`declared target ${declaredTarget} is not in your graveyard`);
      }
      break;
    case 'plains': {
      const candidates = state.players[seat].battlefield.filter((s) => s.land !== 'plains');
      if (candidates.length === 0) {
        if (declaredTarget !== null) throw new IllegalActionError('no non-Plains land to reuse');
      } else {
        if (declaredTarget === null) throw new IllegalActionError('plains must declare which land to reuse');
        const target = candidates.find((s) => s.id === declaredTarget);
        if (!target) throw new IllegalActionError(`declared target ${declaredTarget} is not a non-Plains land you control`);
        if (target.land === null) throw new IllegalActionError('battlefield lands are always public');
        reuseLand = target.land;
      }
      break;
    }
  }

  const pending: PendingPlay = { card, land, controller: seat, declaredTarget, reuseLand, counters: 0 };
  return { ...state, phase: 'respond', pending };
}

// --- counter ----------------------------------------------------------------

function applyCounter(state: GameState, seat: Seat, island: CardId, islandLand: Land, otherCard: CardId, otherLand: Land): GameState {
  const pending = state.pending;
  if (state.phase !== 'respond' || pending === null) {
    throw new IllegalActionError('no land play is waiting for a response');
  }
  const responder = counterResponder(pending);
  if (seat !== responder) throw new IllegalActionError(`seat ${responder} decides on this land play`);

  const hand = state.players[seat].hand;
  const islandSlot = findSlot(hand, island);
  const otherSlot = findSlot(hand, otherCard);
  if (!islandSlot) throw new IllegalActionError(`counter card ${island} is not in seat ${seat}'s hand`);
  if (!otherSlot) throw new IllegalActionError(`counter card ${otherCard} is not in seat ${seat}'s hand`);
  if (island === otherCard) throw new IllegalActionError('the two counter cards must be different slots');
  if (islandLand !== 'island') throw new IllegalActionError('the first counter card must be an Island');
  assertPublicLandMatches(islandSlot, islandLand, 'counter');
  assertPublicLandMatches(otherSlot, otherLand, 'counter');
  spendKnownFirst(islandSlot, hand, islandLand);
  spendKnownFirst(otherSlot, hand, otherLand);

  return {
    ...moveTo(moveTo(state, seat, 'hand', 'graveyard', island, islandLand), seat, 'hand', 'graveyard', otherCard, otherLand),
    pending: { ...pending, counters: pending.counters + 1 },
  };
}

// --- allow ------------------------------------------------------------------

function applyAllow(state: GameState, seat: Seat): GameState {
  const pending = state.pending;
  if (state.phase !== 'respond' || pending === null) {
    throw new IllegalActionError('no land play is waiting for a response');
  }
  const responder = counterResponder(pending);
  if (seat !== responder) throw new IllegalActionError(`seat ${responder} decides on this land play`);

  if (pending.counters % 2 === 1) {
    // Odd number of counters: the play is countered and never enters play.
    return endTurn(moveTo(state, pending.controller, 'hand', 'graveyard', pending.card, pending.land));
  }

  // Even (possibly zero): the land resolves and enters the battlefield.
  const entered = moveTo(state, pending.controller, 'hand', 'battlefield', pending.card, pending.land);
  const reason = winReason(entered.players[pending.controller]);
  if (reason !== null) {
    // The win is checked as the land enters, before its effect resolves.
    return { ...entered, pending: null, phase: 'over', winner: { seat: pending.controller, reason } };
  }
  return resolveEffect(entered, pending);
}

function resolveEffect(state: GameState, pending: PendingPlay): GameState {
  const controller = pending.controller;

  if (pending.land === 'island') return drawFor(state, controller, 'islandDraw');

  if (pending.land === 'mountain') {
    // Target was declared before the counter window; apply it now.
    if (pending.declaredTarget === null) return endTurn(state); // opponent has no lands: no effect
    return endTurn(moveTo(state, other(controller), 'battlefield', 'graveyard', pending.declaredTarget, null));
  }

  if (pending.land === 'forest') {
    if (pending.declaredTarget === null) return endTurn(state); // empty graveyard: no effect
    return endTurn(moveTo(state, controller, 'graveyard', 'hand', pending.declaredTarget, null));
  }

  // Swamp and Plains-reused effects decide their actions at resolution.
  if (pending.land === 'swamp') {
    if (state.players[other(controller)].hand.length === 0) return endTurn(state); // nothing to reveal or discard
    return { ...state, phase: 'revealHand' };
  }

  // pending.land === 'plains': reuse the declared land's effect.
  if (pending.reuseLand === null) return endTurn(state); // no non-Plains land to reuse: no effect
  if (pending.reuseLand === 'island') return drawFor(state, controller, 'islandDraw');
  if (pending.reuseLand === 'mountain' || pending.reuseLand === 'forest') {
    const kind = pending.reuseLand === 'mountain' ? 'opponentBattlefield' : 'ownGraveyard';
    if (validTargets(state, pending.controller, kind).length === 0) return endTurn(state); // nothing to act on
    return { ...state, pending: { ...pending, land: 'plains', reuseLand: pending.reuseLand }, phase: 'target' };
  }
  // pending.reuseLand === 'swamp'
  if (state.players[other(controller)].hand.length === 0) return endTurn(state); // nothing to reveal or discard
  return { ...state, pending: { ...pending, reuseLand: 'swamp' }, phase: 'revealHand' };
}

// --- revealHandForSwamp -----------------------------------------------------

function applyRevealHandForSwamp(state: GameState, seat: Seat, cards: ReadonlyArray<{ card: CardId; land: Land }>): GameState {
  const pending = state.pending;
  if (state.phase !== 'revealHand' || pending === null) {
    throw new IllegalActionError('no Swamp is waiting for a hand reveal');
  }
  if (seat !== other(pending.controller)) {
    throw new IllegalActionError(`seat ${other(pending.controller)} must reveal their hand`);
  }

  const hand = state.players[seat].hand;
  const claimed = new Map<CardId, Land>();
  for (const entry of cards) {
    if (!hand.some((s) => s.id === entry.card)) {
      throw new IllegalActionError(`revealed card ${entry.card} is not in the hand`);
    }
    if (claimed.has(entry.card)) {
      throw new IllegalActionError(`card ${entry.card} was revealed twice`);
    }
    claimed.set(entry.card, entry.land);
  }
  if (claimed.size !== hand.length) {
    throw new IllegalActionError('the whole hand must be revealed');
  }

  const revealedHand: CardSlot[] = hand.map((slot) => {
    const land = claimed.get(slot.id) ?? null;
    if (land === null) throw new IllegalActionError(`card ${slot.id} was not revealed (and is not public)`);
    assertPublicLandMatches(slot, land, 'swamp reveal');
    return { id: slot.id, land };
  });

  const next = withPlayer(state, seat, (p) => ({ ...p, hand: revealedHand }));
  return { ...next, phase: 'target' };
}

// --- resolveTarget ----------------------------------------------------------

type TargetKind = 'opponentHand' | 'opponentBattlefield' | 'ownGraveyard' | 'none';

function targetKind(pending: PendingPlay): TargetKind {
  if (pending.land === 'swamp' || (pending.land === 'plains' && pending.reuseLand === 'swamp')) {
    return 'opponentHand';
  }
  if (pending.land === 'plains') {
    if (pending.reuseLand === 'mountain') return 'opponentBattlefield';
    if (pending.reuseLand === 'forest') return 'ownGraveyard';
  }
  return 'none';
}

function validTargets(state: GameState, controller: Seat, kind: 'opponentHand' | 'opponentBattlefield' | 'ownGraveyard'): CardId[] {
  const owner = kind === 'ownGraveyard' ? controller : other(controller);
  const zone: Zone = kind === 'opponentHand' ? 'hand' : kind === 'opponentBattlefield' ? 'battlefield' : 'graveyard';
  return state.players[owner][zone].map((s) => s.id);
}

function applyResolveTarget(state: GameState, seat: Seat, target: CardId): GameState {
  const pending = state.pending;
  if (state.phase !== 'target' || pending === null) {
    throw new IllegalActionError('no effect is waiting for a target');
  }
  if (seat !== pending.controller) throw new IllegalActionError(`seat ${pending.controller} resolves the effect`);

  const kind = targetKind(pending);
  if (kind === 'none') throw new IllegalActionError('no target is needed for this effect');
  const targets = validTargets(state, pending.controller, kind);
  if (!targets.includes(target)) {
    const owner = kind === 'ownGraveyard' ? pending.controller : other(pending.controller);
    const zone = kind === 'opponentHand' ? 'hand' : kind === 'opponentBattlefield' ? "battlefield" : "graveyard";
    throw new IllegalActionError(`target ${target} is not in the ${zone} of seat ${owner}`);
  }

  const owner = kind === 'ownGraveyard' ? pending.controller : other(pending.controller);
  switch (kind) {
    case 'opponentBattlefield':
      return endTurn(moveTo(state, owner, 'battlefield', 'graveyard', target, null));
    case 'opponentHand':
      return endTurn(moveTo(state, owner, 'hand', 'graveyard', target, null));
    case 'ownGraveyard':
      return endTurn(moveTo(state, owner, 'graveyard', 'hand', target, null));
  }
}

// --- pass -------------------------------------------------------------------

function applyPass(state: GameState, seat: Seat): GameState {
  if (state.phase !== 'main') throw new IllegalActionError('pass is only legal in the main phase');
  if (seat !== state.activeSeat) throw new IllegalActionError('only the active player may pass');
  return endTurn(state);
}

// ---------------------------------------------------------------------------
// Legal actions (UI affordances).
//
// Hidden slots only become actions when the caller supplies that seat's private
// knowledge, so this is safe to call for a remote view: without priv it will
// never invent land claims it cannot see.
// ---------------------------------------------------------------------------

function pickSpendFirstSlot(hand: readonly CardSlot[], land: Land, priv: ReadonlyMap<CardId, Land> | undefined): CardId | undefined {
  const publicCopy = hand.find((s) => s.land === land);
  if (publicCopy) return publicCopy.id;
  return hand.find((s) => s.land === null && priv?.get(s.id) === land)?.id;
}

export function legalActions(state: GameState, seat: Seat, priv?: ReadonlyMap<CardId, Land>): Action[] {
  if (state.phase === 'over' || state.winner !== null) return [];

  switch (state.phase) {
    case 'drawKey': {
      const draw = state.awaitingDraw;
      if (draw !== undefined && draw !== null && seat === other(draw.seat)) {
        return [{ type: 'grantDrawKey', card: draw.card }];
      }
      return [];
    }

    case 'main': {
      if (seat !== state.activeSeat) return [];
      const draft: Action[] = [{ type: 'pass' }];
      for (const land of LANDS) {
        const card = pickSpendFirstSlot(state.players[seat].hand, land, priv);
        if (card === undefined) continue;
        switch (land) {
          case 'island':
          case 'swamp':
            draft.push({ type: 'play', card, land });
            break;
          case 'mountain':
          case 'forest': {
            const targets =
              land === 'mountain' ? state.players[other(seat)].battlefield : state.players[seat].graveyard;
            if (targets.length === 0) {
              draft.push({ type: 'play', card, land });
            } else {
              for (const target of targets) draft.push({ type: 'play', card, land, declaredTarget: target.id });
            }
            break;
          }
          case 'plains': {
            const reuseCandidates = state.players[seat].battlefield.filter((s) => s.land !== 'plains');
            if (reuseCandidates.length === 0) {
              draft.push({ type: 'play', card, land });
            } else {
              for (const target of reuseCandidates) {
                draft.push({ type: 'play', card, land, declaredTarget: target.id });
              }
            }
            break;
          }
        }
      }
      return draft;
    }

    case 'respond': {
      const pending = state.pending;
      if (pending === null || seat !== counterResponder(pending)) return [];
      const draft: Action[] = [{ type: 'allow' }];
      const island = pickSpendFirstSlot(state.players[seat].hand, 'island', priv);
      if (island !== undefined) {
        for (const land of LANDS) {
          const otherCard = pickSpendFirstSlot(state.players[seat].hand, land, priv);
          if (otherCard !== undefined && otherCard !== island) {
            draft.push({ type: 'counter', island, islandLand: 'island', other: otherCard, otherLand: land });
          }
        }
      }
      return draft;
    }

    case 'revealHand': {
      const pending = state.pending;
      if (pending === null || seat !== other(pending.controller)) return [];
      const hand = state.players[seat].hand;
      const cards: Array<{ card: CardId; land: Land }> = [];
      for (const slot of hand) {
        const land = slot.land ?? priv?.get(slot.id) ?? null;
        if (land !== null) cards.push({ card: slot.id, land: land });
      }
      if (cards.length !== hand.length) return []; // need every card; wait for full private knowledge
      return [{ type: 'revealHandForSwamp', cards }];
    }

    case 'target': {
      const pending = state.pending;
      if (pending === null || seat !== pending.controller) return [];
      const kind = targetKind(pending);
      if (kind === 'none') return [];
      return validTargets(state, pending.controller, kind).map((id) => ({ type: 'resolveTarget', target: id }) as Action);
    }
  }
}
