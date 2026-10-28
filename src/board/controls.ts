// What the player can do right now, derived from the coordinator's legal
// actions. Pure: no DOM, no rendering, so it is unit-tested in Node. The table
// and the chrome both read a Prompt; neither knows any rules.

import { counterResponder } from '../engine/game.ts';
import type { Action, CardId, GameState, Land, Seat } from '../engine/types.ts';
import { other } from '../engine/types.ts';

export interface Choice {
  readonly label: string;
  readonly action: Action;
}

export type Prompt =
  /** Nothing to do: the opponent (or the protocol) is acting. */
  | { readonly kind: 'wait'; readonly text: string }
  /**
   * Main phase. Clicking a card in `playable` either plays it at once (one
   * action) or starts targeting (several actions, one per declared target).
   * Dragging a card with a declared target always targets, snapping to a lone one.
   */
  | { readonly kind: 'main'; readonly text: string; readonly playable: ReadonlyMap<CardId, readonly Action[]>; readonly buttons: readonly Choice[] }
  /** Main phase, a card is picked and needs its declared target: click one of `targets`. */
  | { readonly kind: 'declare'; readonly text: string; readonly card: CardId; readonly targets: ReadonlyMap<CardId, Action>; readonly buttons: readonly Choice[] }
  /** Counter window: allow, or counter with one of the listed pairs. */
  | { readonly kind: 'respond'; readonly text: string; readonly buttons: readonly Choice[] }
  /** An effect is resolving and needs a target: click one of `targets`. */
  | { readonly kind: 'resolve'; readonly text: string; readonly targets: ReadonlyMap<CardId, Action> }
  | { readonly kind: 'over'; readonly text: string };

const NAMES: Record<Land, string> = { forest: 'Forest', island: 'Island', mountain: 'Mountain', plains: 'Plains', swamp: 'Swamp' };

export function landName(land: Land): string {
  return NAMES[land];
}

/**
 * A land's mana symbol inside text, as `{forest}`: descriptions name lands by
 * symbol, as MTG card text does (the chrome draws the token as an icon, see mana.ts).
 * Only a card's own title spells its name out.
 */
export function landIcon(land: Land): string {
  return `{${land}}`;
}

/** The prompt for `seat`, given the state, its legal actions, and an optional card picked for targeting. */
export function promptFor(state: GameState, seat: Seat, actions: readonly Action[], picked: CardId | null = null): Prompt {
  if (state.phase === 'over' && state.winner !== null) {
    const reason = { domain: 'Domain', mono: 'Mono', decked: 'the opponent drew from an empty deck', resign: 'resignation' }[state.winner.reason];
    return { kind: 'over', text: `${state.winner.seat === seat ? 'You win' : 'You lose'} by ${reason}.` };
  }
  if (actions.length === 0) return { kind: 'wait', text: waitingText(state, seat) };

  switch (state.phase) {
    case 'main': {
      const playable = new Map<CardId, Action[]>();
      for (const action of actions) {
        if (action.type !== 'play') continue;
        playable.set(action.card, [...(playable.get(action.card) ?? []), action]);
      }
      const pass: Choice = { label: 'Pass turn', action: { type: 'pass' } };
      const options = picked === null ? undefined : playable.get(picked);
      if (options !== undefined && hasTarget(options)) {
        const targets = new Map<CardId, Action>();
        for (const action of options) if (action.type === 'play' && action.declaredTarget !== undefined) targets.set(action.declaredTarget, action);
        const first = options[0]!;
        const land = first.type === 'play' ? first.land : 'forest';
        return { kind: 'declare', text: declareText(land), card: picked!, targets, buttons: [] };
      }
      return { kind: 'main', text: 'Your turn: play a land, or pass.', playable, buttons: [pass] };
    }
    case 'respond': {
      const buttons: Choice[] = [];
      for (const action of actions) {
        if (action.type === 'allow') buttons.push({ label: 'Let it resolve', action });
        if (action.type === 'counter') buttons.push({ label: `Counter: ${landIcon('island')} + ${landIcon(action.otherLand)}`, action });
      }
      return { kind: 'respond', text: respondText(state, seat), buttons };
    }
    case 'target': {
      const targets = new Map<CardId, Action>();
      for (const action of actions) if (action.type === 'resolveTarget') targets.set(action.target, action);
      return { kind: 'resolve', text: resolveText(), targets };
    }
    default:
      return { kind: 'wait', text: waitingText(state, seat) };
  }
}

/** Whether a card's plays aim at something (a Mountain or Forest with a land to choose). */
export function hasTarget(plays: readonly Action[]): boolean {
  return plays.some((a) => a.type === 'play' && a.declaredTarget !== undefined);
}

function declareText(land: Land): string {
  if (land === 'mountain') return `${landIcon('mountain')}: choose an opponent land to destroy.`;
  return `${landIcon('forest')}: choose a land in your graveyard to return.`;
}

function respondText(state: GameState, seat: Seat): string {
  const pending = state.pending!;
  const who = pending.controller === seat ? 'Your' : 'Their';
  const chain = pending.counters === 0 ? '' : ` (${pending.counters} counter${pending.counters === 1 ? '' : 's'} so far)`;
  const verb = pending.counters % 2 === 0 ? 'Counter it?' : 'Counter the counter?';
  return `${who} ${landIcon(pending.land)}${targetSuffix(state)}${chain}. ${verb}`;
}

function resolveText(): string {
  return `${landIcon('swamp')}: choose a card from their hand to discard.`;
}

function targetSuffix(state: GameState): string {
  const pending = state.pending;
  if (pending === null || pending.declaredTarget === null) return '';
  const target = [...state.players[0].battlefield, ...state.players[1].battlefield, ...state.players[0].graveyard, ...state.players[1].graveyard].find(
    (s) => s.id === pending.declaredTarget,
  );
  const verb = pending.land === 'mountain' ? 'destroying' : 'returning';
  return target?.land ? `, ${verb} ${landIcon(target.land)}` : '';
}

function waitingText(state: GameState, seat: Seat): string {
  switch (state.phase) {
    case 'respond': {
      const pending = state.pending!;
      return pending.controller === seat ? `Your ${landIcon(pending.land)}: waiting for their response…` : 'Waiting for their response…';
    }
    case 'target':
    case 'revealHand':
      return 'Their effect is resolving…';
    case 'drawKey':
      return state.awaitingDraw?.seat === seat ? 'Drawing…' : 'They are drawing…';
    default:
      return state.activeSeat === other(seat) ? 'Their turn.' : 'Waiting…';
  }
}

/**
 * Whose move the game is waiting on: the responder in a counter window, the
 * controller choosing an effect's target, otherwise the turn's player (forced
 * moves included). Null once the game is over.
 */
export function actingSeat(state: GameState): Seat | null {
  if (state.phase === 'over') return null;
  if (state.phase === 'respond' && state.pending !== null) return counterResponder(state.pending);
  if (state.phase === 'target' && state.pending !== null) return state.pending.controller;
  return state.activeSeat;
}

/** What dropping a dragged card does: play it, keep it picked for targeting, or put it back. */
export type Drop = { readonly kind: 'submit'; readonly action: Action } | { readonly kind: 'pick' } | { readonly kind: 'cancel' };

/**
 * Dropping `card` onto `over` (the card under the drop point, if any), on the
 * table (`onTable`) or back over the hand. A drop on a target plays at it; a
 * drop on the table plays a card with one option or a lone target, or starts targeting.
 */
export function dropOutcome(prompt: Prompt | null, card: CardId, over: CardId | null, onTable: boolean): Drop {
  if (prompt?.kind === 'declare' && prompt.card === card) {
    const lone = onTable && prompt.targets.size === 1 ? [...prompt.targets.values()][0] : undefined;
    const action = (over === null ? undefined : prompt.targets.get(over)) ?? lone;
    if (action !== undefined) return { kind: 'submit', action };
    return onTable ? { kind: 'pick' } : { kind: 'cancel' };
  }
  if (prompt?.kind !== 'main') return { kind: 'cancel' };
  const actions = prompt.playable.get(card);
  if (actions === undefined) return { kind: 'cancel' };
  const aimed = actions.find((a) => a.type === 'play' && a.declaredTarget !== undefined && a.declaredTarget === over);
  if (aimed !== undefined) return { kind: 'submit', action: aimed };
  if (!onTable) return { kind: 'cancel' };
  return actions.length === 1 ? { kind: 'submit', action: actions[0]! } : { kind: 'pick' };
}
