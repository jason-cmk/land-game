// What the player can do right now, derived from the coordinator's legal
// actions. Pure: no DOM, no rendering, so it is unit-tested in Node. The table
// and the chrome both read a Prompt; neither knows any rules.

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
      if (options !== undefined && options.length > 1) {
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
        if (action.type === 'counter') buttons.push({ label: `Counter: Island + ${landName(action.otherLand)}`, action });
      }
      return { kind: 'respond', text: respondText(state, seat), buttons };
    }
    case 'target': {
      const targets = new Map<CardId, Action>();
      for (const action of actions) if (action.type === 'resolveTarget') targets.set(action.target, action);
      return { kind: 'resolve', text: resolveText(state), targets };
    }
    default:
      return { kind: 'wait', text: waitingText(state, seat) };
  }
}

function declareText(land: Land): string {
  if (land === 'mountain') return 'Mountain: choose an opponent land to destroy.';
  if (land === 'forest') return 'Forest: choose a land in your graveyard to return.';
  return 'Plains: choose one of your other lands to reuse.';
}

function respondText(state: GameState, seat: Seat): string {
  const pending = state.pending!;
  const who = pending.controller === seat ? 'Your' : 'Their';
  const chain = pending.counters === 0 ? '' : ` (${pending.counters} counter${pending.counters === 1 ? '' : 's'} so far)`;
  const verb = pending.counters % 2 === 0 ? 'Counter it?' : 'Counter the counter?';
  return `${who} ${landName(pending.land)}${targetSuffix(state)}${chain}. ${verb}`;
}

function resolveText(state: GameState): string {
  const pending = state.pending!;
  const effect = pending.land === 'plains' ? pending.reuseLand! : pending.land;
  if (effect === 'swamp') return 'Swamp: choose a card from their hand to discard.';
  if (effect === 'mountain') return 'Choose an opponent land to destroy.';
  return 'Choose a land in your graveyard to return.';
}

function targetSuffix(state: GameState): string {
  const pending = state.pending;
  if (pending === null || pending.declaredTarget === null) return '';
  const target = [...state.players[0].battlefield, ...state.players[1].battlefield, ...state.players[0].graveyard, ...state.players[1].graveyard].find(
    (s) => s.id === pending.declaredTarget,
  );
  const verb = pending.land === 'mountain' ? 'destroying' : pending.land === 'forest' ? 'returning' : 'reusing';
  return target?.land ? `, ${verb} ${landName(target.land)}` : '';
}

function waitingText(state: GameState, seat: Seat): string {
  switch (state.phase) {
    case 'respond': {
      const pending = state.pending!;
      return pending.controller === seat ? `Your ${landName(pending.land)}: waiting for their response…` : 'Waiting for their response…';
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
