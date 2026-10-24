// The match so far in plain words, for the history panel. Rebuilt from the
// action log (which carries only public information) by replaying it through
// the engine and reading each step's zone changes with cuesBetween, so it
// survives reloads and never says more than the viewer may know: the
// opponent's draws stay "a card"; the viewer's own draws are named only from
// what the viewer's board already knows. Pure: no DOM, no rendering.

import { apply, createGame } from '../engine/game.ts';
import type { CardId, GameState, Land, Seat } from '../engine/types.ts';
import { toEngineAction } from '../match/protocol.ts';
import type { LoggedAction } from '../match/protocol.ts';
import { landName } from './controls.ts';
import { cuesBetween } from './effects.ts';

/** One line of history; `seat` is who acted (null for outcomes nobody chose). */
export interface HistoryLine {
  readonly seat: Seat | null;
  readonly text: string;
}

/** A turn's lines, under whose turn it was. */
export interface HistoryTurn {
  readonly turn: number;
  readonly seat: Seat;
  readonly lines: readonly HistoryLine[];
}

/** A logged action and who took it (entry 0 is the start record). */
export interface HistoryStep {
  readonly seat: number;
  readonly action: LoggedAction;
}

/**
 * The match as turns of lines, from `viewer`'s seat. `known` names the
 * viewer's own cards that are still hidden from the opponent (its private hand).
 */
export function matchHistory(log: readonly HistoryStep[], viewer: Seat, known: (id: CardId) => Land | null = () => null): HistoryTurn[] {
  const start = log[0]?.action;
  if (start === undefined || start.type !== 'start') return [];
  const turns: { turn: number; seat: Seat; lines: HistoryLine[] }[] = [];
  let state = createGame(start.first);
  const say = (at: GameState, seat: Seat | null, text: string): void => {
    let current = turns.at(-1);
    if (current === undefined || current.turn !== at.turn) {
      current = { turn: at.turn, seat: at.activeSeat, lines: [] };
      turns.push(current);
    }
    current.lines.push({ seat, text });
  };

  const you = (seat: Seat): boolean => seat === viewer;
  const subject = (seat: Seat): string => (you(seat) ? 'You' : 'They');
  const possessive = (seat: Seat): string => (you(seat) ? 'your' : 'their');
  const landOf = (s: GameState, id: CardId): Land | null => {
    for (const p of s.players) for (const zone of [p.library, p.hand, p.battlefield, p.graveyard]) for (const slot of zone) if (slot.id === id) return slot.land;
    return null;
  };
  const ownerOf = (id: CardId): Seat => (id.startsWith('p0-') ? 0 : 1);
  /** "your Forest", or "their land" if somehow not public. */
  const cardName = (s: GameState, id: CardId): string => {
    const land = landOf(s, id);
    return `${possessive(ownerOf(id))} ${land === null ? 'land' : landName(land)}`;
  };

  for (const entry of log.slice(1)) {
    if (entry.action.type === 'start') continue;
    const seat = entry.seat as Seat;
    const action = entry.action;
    const before = state;
    try {
      state = apply(before, seat, toEngineAction(action));
    } catch {
      break; // a log the engine refuses cannot be described past this point
    }
    const pending = before.pending;
    /** The play an effect belongs to, e.g. "Your Mountain" or "Their Plains (as Forest)". */
    const source = (): string => {
      if (pending === null) return 'It';
      const reused = pending.land === 'plains' && pending.reuseLand !== null ? ` (as ${landName(pending.reuseLand)})` : '';
      return `${you(pending.controller) ? 'Your' : 'Their'} ${landName(pending.land)}${reused}`;
    };

    switch (action.type) {
      case 'play': {
        const land = action.reveal.land;
        const target = action.declaredTarget;
        let text = `${subject(seat)} played ${landName(land)}`;
        if (target !== undefined) {
          const verb = land === 'mountain' ? 'aiming at' : land === 'forest' ? 'to return' : 'reusing';
          text += `, ${verb} ${cardName(before, target)}`;
        }
        say(before, seat, `${text}.`);
        break;
      }
      case 'counter':
        say(before, seat, `${subject(seat)} countered with Island + ${landName(action.other.land)}.`);
        break;
      case 'allow':
        say(before, seat, `${subject(seat)} let it resolve.`);
        break;
      case 'pass':
        say(before, seat, `${subject(seat)} passed the turn.`);
        break;
      case 'resign':
        say(before, seat, `${subject(seat)} resigned.`);
        break;
      case 'revealHandForSwamp': {
        const lands = action.cards.map((c) => landName(c.land));
        say(before, seat, `${subject(seat)} revealed ${possessive(seat)} hand: ${lands.length === 0 ? 'empty' : lands.join(', ')}.`);
        break;
      }
      case 'grantDrawKey':
      case 'resolveTarget':
        break; // described by what they change, below
    }

    // The play enters (or is countered), then its effect, then any draw it causes, and the result comes last.
    const order = (kind: string): number => ({ enter: 0, countered: 0, draw: 2, win: 3 })[kind] ?? 1;
    const cues = cuesBetween(before, state).sort((a, b) => order(a.kind) - order(b.kind));
    for (const cue of cues) {
      switch (cue.kind) {
        case 'draw': {
          // A draw that starts a turn belongs to that turn, so it is filed under the state after it.
          const land = you(cue.seat) ? (landOf(state, cue.card) ?? known(cue.card)) : null;
          say(state, cue.seat, `${subject(cue.seat)} drew ${land === null ? 'a card' : landName(land)}.`);
          break;
        }
        case 'countered':
          say(before, null, `${source()} was countered.`);
          break;
        case 'enter':
          say(before, null, `${source()} entered play.`);
          break;
        case 'meteor':
          say(before, null, `${source()} destroyed ${cardName(state, cue.card)}.`);
          break;
        case 'regrowth':
          say(before, null, `${source()} returned ${cardName(state, cue.card)} to ${possessive(cue.seat)} hand.`);
          break;
        case 'discard': {
          const land = landOf(state, cue.card);
          say(before, null, `${source()} made ${you(cue.seat) ? 'you' : 'them'} discard ${land === null ? 'a card' : landName(land)}.`);
          break;
        }
        case 'win': {
          const reason = { domain: 'Domain', mono: 'Mono', decked: 'the opponent drawing from an empty deck', resign: 'resignation' }[cue.reason];
          say(before, null, `${you(cue.seat) ? 'You win' : 'They win'} by ${reason}.`);
          break;
        }
        default:
          break; // announce, reuse, counter and reveal are already said by the action line
      }
    }
  }
  return turns;
}
