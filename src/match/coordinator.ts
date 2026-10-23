// Lockstep match coordinator: runs one seat's side of the two-party protocol
// over a Transport. It owns the Mental Poker secrets, verifies every key and
// reveal the peer sends, feeds verified actions to the engine, and keeps the
// hash-chained log both peers must agree on.
//
// Lifecycle:
//   setup     hello (version, prime, coin commit) -> turnReveal -> the 4-step
//             SRA shuffle for both decks (A/B/C/D) -> opening-hand keys ->
//             log entry 0 ('start') -> ready (head hashes compared)
//   playing   'action' messages, each carrying the sender's new head hash.
//             Draw-key grants and Swamp hand reveals are forced moves, so the
//             coordinator sends them itself.
//   auditing  the game is over; both sides broadcast every per-slot key and
//             audit both decks
//   over      outcome is final
//
// Failure policy:
//   - Head hash or sequence mismatch: the match is void. Nobody can tell which
//     side diverged, so there is no result.
//   - Anything that fails verification (bad draw key, bad reveal proof, an
//     action the engine rejects, a failed audit, a malformed message): the
//     peer forfeits, even if the game had already declared a winner. The
//     detail is kept so a bug in our own code is easy to spot.
//
// Reconnect: snapshot() holds the log and this seat's secrets. resume() replays
// the log through the engine (re-verifying everything) and then exchanges
// 'resume' with the peer; whichever side is ahead resends the actions the
// other is missing. The persist hook runs before every action is sent, so a
// seat's saved log always contains everything it sent. Setup is not resumable.

import { apply, createGame, legalActions, OPENING_HAND_SIZE } from '../engine/game.ts';
import { IllegalActionError, other } from '../engine/types.ts';
import type { Action, CardId, GameState, Land, Seat, WinReason } from '../engine/types.ts';
import type { Transport } from '../transport/types.ts';
import { appendEntry, sha256Hex, stateHashOf, verifyChain } from './log.ts';
import type { LogEntry } from './log.ts';
import {
  PROTOCOL_VERSION,
  ProtocolError,
  RULES_VERSION,
  fromHex,
  slotOf,
  toEngineAction,
  toHex,
} from './protocol.ts';
import type { LoggedAction, MatchAction, Message, Reveal, StartRecord } from './protocol.ts';
import {
  applyPerSlotLocks,
  auditDeck,
  bulkDecrypt,
  bulkEncrypt,
  canonicalDeckValues,
  decryptSlot,
  defaultRandomBytes,
  DECK_SIZE,
  landForIndex,
  shuffled,
  verifyReveal,
} from './sra.ts';
import type { KeyPair, RandomBytes } from './sra.ts';

export type MatchStatus = 'setup' | 'playing' | 'auditing' | 'over';

export type Outcome =
  | { readonly kind: 'win'; readonly winner: Seat; readonly reason: WinReason }
  | { readonly kind: 'forfeit'; readonly winner: Seat; readonly detail: string }
  | { readonly kind: 'void'; readonly detail: string };

/** Everything needed to rebuild this seat's side of the match. Contains secrets. */
export interface Snapshot {
  readonly version: 1;
  readonly seat: Seat;
  readonly prime: string;
  /** Per-slot keys this seat attached to its own deck (step C). */
  readonly ownDeckKeys: readonly string[];
  /** Per-slot keys this seat attached to the opponent's deck (step D). */
  readonly otherDeckKeys: readonly string[];
  readonly log: ReadonlyArray<LogEntry<LoggedAction>>;
}

export interface CoordinatorOptions {
  readonly seat: Seat;
  /** SRA modulus; both peers must use the same one. */
  readonly prime: bigint;
  readonly transport: Transport<Message>;
  readonly rand?: RandomBytes;
  /** Called synchronously with a fresh snapshot before each action is sent. */
  readonly persist?: (snapshot: Snapshot) => void;
}

/** The two logs disagree; the match cannot continue and has no result. */
class DesyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesyncError';
  }
}

/** Log entry 0 is written by neither seat. */
const SYSTEM_SEAT = -1;

function cardId(owner: Seat, slot: number): CardId {
  return `p${owner}-slot-${String(slot).padStart(2, '0')}`;
}

export class MatchCoordinator {
  readonly seat: Seat;
  private readonly peer: Seat;
  private readonly p: bigint;
  private readonly rand: RandomBytes;
  private readonly persist: ((snapshot: Snapshot) => void) | undefined;
  private transport: Transport<Message>;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();

  private _status: MatchStatus = 'setup';
  private _outcome: Outcome | null = null;

  // Setup
  private readonly mySeed: string;
  private peerCommit: string | null = null;
  private first: Seat | null = null;
  private readonly stepsSeen = new Set<string>();
  private ownBulk: KeyPair | null = null;
  private otherBulk: KeyPair | null = null;
  private myOpeningKeys: string[] | null = null;
  private peerOpeningKeys: string[] | null = null;
  private peerReadyHash: string | null = null;

  // Secrets and the public decks, indexed by owner seat
  private ownKeys: bigint[] = [];
  private otherKeys: bigint[] = [];
  private decks: [bigint[] | null, bigint[] | null] = [null, null];
  private readonly canonical: [Map<bigint, number>, Map<bigint, number>];

  // Game
  private _state: GameState | null = null;
  private _log: LogEntry<LoggedAction>[] = [];
  private readonly priv = new Map<CardId, Land>();
  private readonly drawnPlaintexts = new Set<bigint>();

  constructor(options: CoordinatorOptions) {
    this.seat = options.seat;
    this.peer = other(options.seat);
    this.p = options.prime;
    this.rand = options.rand ?? defaultRandomBytes;
    this.persist = options.persist;
    this.transport = options.transport;
    this.mySeed = Array.from(this.rand(16), (b) => b.toString(16).padStart(2, '0')).join('');
    this.canonical = [this.canonicalIndex(0), this.canonicalIndex(1)];
  }

  /** Rebuild a coordinator from a snapshot and reconnect it to the peer. */
  static resume(snapshot: Snapshot, transport: Transport<Message>, options: Pick<CoordinatorOptions, 'rand' | 'persist'> = {}): MatchCoordinator {
    const coordinator = new MatchCoordinator({ ...options, seat: snapshot.seat, prime: fromHex(snapshot.prime), transport });
    coordinator.replay(snapshot);
    coordinator.reconnect(transport);
    return coordinator;
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  get status(): MatchStatus {
    return this._status;
  }

  /** Final once status is 'over'. */
  get outcome(): Outcome | null {
    return this._outcome;
  }

  /** The shared game state; null during setup. */
  get state(): GameState | null {
    return this._state;
  }

  /** This seat's privately known hidden cards. */
  get privateHand(): ReadonlyMap<CardId, Land> {
    return this.priv;
  }

  get log(): ReadonlyArray<LogEntry<LoggedAction>> {
    return this._log;
  }

  /** Begin setup with the peer. */
  start(): void {
    this.listen();
    this.transport.send({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      rules: RULES_VERSION,
      prime: toHex(this.p),
      turnCommit: sha256Hex(this.mySeed),
    });
  }

  /** Swap in a new transport after a disconnect and resynchronise logs with the peer. */
  reconnect(transport: Transport<Message>): void {
    if (this._log.length === 0) throw new Error('setup cannot be resumed; start a new match');
    this.unsubscribe?.();
    this.transport = transport;
    this.listen();
    const head = this._log[this._log.length - 1]!;
    this.transport.send({ t: 'resume', length: this._log.length, headHash: head.hash });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Actions this seat may submit now. Forced moves are sent automatically and never appear here. */
  legalActions(): Action[] {
    if (this._status !== 'playing' || this._state === null) return [];
    return legalActions(this._state, this.seat, this.priv);
  }

  /** Submit an action for this seat. Throws IllegalActionError, and sends nothing, if it is not legal. */
  submit(action: Action): void {
    if (this._status !== 'playing') throw new IllegalActionError(`cannot act while the match is ${this._status}`);
    const matchAction = this.withProofs(action);
    this.step(this.seat, matchAction);
    const entry = this._log[this._log.length - 1]!;
    this.persist?.(this.snapshot()!);
    this.transport.send({ t: 'action', seq: entry.seq, action: matchAction, headHash: entry.hash });
    this.afterAction();
  }

  snapshot(): Snapshot | null {
    if (this._log.length === 0) return null;
    return {
      version: 1,
      seat: this.seat,
      prime: toHex(this.p),
      ownDeckKeys: this.ownKeys.map(toHex),
      otherDeckKeys: this.otherKeys.map(toHex),
      log: this._log,
    };
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.transport.close();
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private listen(): void {
    this.unsubscribe = this.transport.onMessage((message) => this.receive(message));
  }

  private receive(message: Message): void {
    // A finished match still answers a resume, so a peer that dropped mid-audit can finish too.
    if (this._status === 'over' && !(message.t === 'resume' && this._outcome?.kind === 'win')) return;
    try {
      this.handle(message);
    } catch (err) {
      this.fail(err);
    }
  }

  private handle(message: Message): void {
    switch (message.t) {
      case 'hello':
        return this.onHello(message);
      case 'turnReveal':
        return this.onTurnReveal(message.seed);
      case 'shuffleStep':
        return this.onShuffleStep(message.deckOwner, message.step, message.cards);
      case 'openingKeys':
        return this.onOpeningKeys(message.keys);
      case 'ready':
        return this.onReady(message.headHash);
      case 'action':
        return this.onAction(message.seq, message.action, message.headHash);
      case 'resume':
        return this.onResume(message.length, message.headHash);
      case 'audit':
        return this.onAudit(message.ownDeck, message.otherDeck);
      case 'bye':
        return this.end({ kind: 'void', detail: `peer ended the match (${message.reason}): ${message.detail}` }, false);
      default:
        throw new ProtocolError(`unknown message type ${(message as { t?: unknown }).t}`);
    }
  }

  private fail(err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof DesyncError) {
      this.end({ kind: 'void', detail: `out of sync: ${detail}` }, true);
    } else {
      this.end({ kind: 'forfeit', winner: this.seat, detail: `verification failed: ${detail}` }, true);
    }
  }

  private end(outcome: Outcome, notifyPeer: boolean): void {
    this._status = 'over';
    this._outcome = outcome;
    if (notifyPeer && outcome.kind !== 'win') {
      this.transport.send({ t: 'bye', reason: outcome.kind, detail: outcome.detail });
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  private requireSetup(what: string): void {
    if (this._status !== 'setup' || this._log.length > 0) throw new ProtocolError(`${what} after setup finished`);
  }

  private onHello(message: Extract<Message, { t: 'hello' }>): void {
    this.requireSetup('hello');
    if (this.peerCommit !== null) throw new ProtocolError('duplicate hello');
    if (message.protocol !== PROTOCOL_VERSION || message.rules !== RULES_VERSION) {
      throw new DesyncError(`incompatible versions: peer protocol ${message.protocol} rules ${message.rules}`);
    }
    if (message.prime !== toHex(this.p)) throw new DesyncError('peer uses a different SRA modulus');
    if (typeof message.turnCommit !== 'string' || !/^[0-9a-f]{64}$/.test(message.turnCommit)) {
      throw new ProtocolError('malformed turn commitment');
    }
    this.peerCommit = message.turnCommit;
    this.transport.send({ t: 'turnReveal', seed: this.mySeed });

    // Step A for our own deck: bulk-lock the canonical cards and shuffle.
    const stepA = bulkEncrypt(canonicalDeckValues(this.seat, this.p), this.p, this.rand);
    this.ownBulk = stepA.key;
    this.sendStep(this.seat, 'A', shuffled(stepA.cards, this.rand));
  }

  private onTurnReveal(seed: string): void {
    this.requireSetup('turnReveal');
    if (this.peerCommit === null) throw new ProtocolError('turn reveal before hello');
    if (this.first !== null) throw new ProtocolError('duplicate turn reveal');
    if (typeof seed !== 'string' || !/^[0-9a-f]{32}$/.test(seed)) throw new ProtocolError('malformed turn seed');
    if (sha256Hex(seed) !== this.peerCommit) throw new ProtocolError('turn seed does not match its commitment');
    const bit = (text: string): number => Number.parseInt(text.slice(-1), 16) & 1;
    this.first = (bit(this.mySeed) ^ bit(seed)) as Seat;
    this.tryStart();
  }

  private onShuffleStep(owner: Seat, step: string, cards: readonly string[]): void {
    this.requireSetup('shuffle step');
    if (this.peerCommit === null) throw new ProtocolError('shuffle step before hello');
    const key = `${owner}${step}`;
    if (this.stepsSeen.has(key)) throw new ProtocolError(`duplicate shuffle step ${step} for deck ${owner}`);
    this.stepsSeen.add(key);
    const values = this.parseDeck(cards);

    if (owner === this.peer && step === 'A') {
      // We lock the opponent's deck in bulk and shuffle it again.
      const stepB = bulkEncrypt(values, this.p, this.rand);
      this.otherBulk = stepB.key;
      this.sendStep(this.peer, 'B', shuffled(stepB.cards, this.rand));
    } else if (owner === this.seat && step === 'B' && this.ownBulk !== null) {
      // Remove our bulk lock, attach per-slot keys in place.
      const stepC = applyPerSlotLocks(bulkDecrypt(values, this.p, this.ownBulk.d), this.p, this.rand);
      this.ownKeys = stepC.secrets;
      this.sendStep(this.seat, 'C', stepC.cards);
    } else if (owner === this.peer && step === 'C' && this.otherBulk !== null) {
      // Remove our bulk lock, attach per-slot keys in place: the opponent's deck is final.
      const stepD = applyPerSlotLocks(bulkDecrypt(values, this.p, this.otherBulk.d), this.p, this.rand);
      this.otherKeys = stepD.secrets;
      this.decks[this.peer] = stepD.cards;
      this.sendStep(this.peer, 'D', stepD.cards);
      this.myOpeningKeys = this.otherKeys.slice(0, OPENING_HAND_SIZE).map(toHex);
      this.transport.send({ t: 'openingKeys', keys: this.myOpeningKeys });
      this.tryStart();
    } else if (owner === this.seat && step === 'D' && this.ownKeys.length === DECK_SIZE) {
      this.decks[this.seat] = values;
      this.tryStart();
    } else {
      throw new ProtocolError(`unexpected shuffle step ${step} for deck ${owner}`);
    }
  }

  private sendStep(owner: Seat, step: 'A' | 'B' | 'C' | 'D', cards: readonly bigint[]): void {
    this.transport.send({ t: 'shuffleStep', deckOwner: owner, step, cards: cards.map(toHex) });
  }

  private parseDeck(cards: readonly string[]): bigint[] {
    if (!Array.isArray(cards) || cards.length !== DECK_SIZE) throw new ProtocolError('a deck must have 50 cards');
    const values = cards.map(fromHex);
    if (values.some((v) => v <= 1n || v >= this.p)) throw new ProtocolError('deck value out of range');
    if (new Set(values).size !== DECK_SIZE) throw new ProtocolError('deck contains duplicate values');
    return values;
  }

  private onOpeningKeys(keys: readonly string[]): void {
    this.requireSetup('opening keys');
    if (this.peerOpeningKeys !== null) throw new ProtocolError('duplicate opening keys');
    if (this.decks[this.seat] === null) throw new ProtocolError('opening keys before our deck was final');
    if (!Array.isArray(keys) || keys.length !== OPENING_HAND_SIZE) throw new ProtocolError('wrong number of opening keys');
    keys.forEach((key, slot) => this.learnDraw(slot, fromHex(key)));
    this.peerOpeningKeys = [...keys];
    this.tryStart();
  }

  /** Entry 0 once every setup input is in; then tell the peer our head hash. */
  private tryStart(): void {
    if (this._log.length > 0) return;
    if (this.first === null || this.decks[0] === null || this.decks[1] === null) return;
    if (this.myOpeningKeys === null || this.peerOpeningKeys === null) return;

    const openingKeys: [string[], string[]] = [[], []];
    openingKeys[this.seat] = this.myOpeningKeys;
    openingKeys[this.peer] = this.peerOpeningKeys;
    const start: StartRecord = {
      type: 'start',
      first: this.first,
      decks: [this.decks[0].map(toHex), this.decks[1].map(toHex)],
      openingKeys,
    };
    this._state = createGame(this.first);
    this._log = [appendEntry([], SYSTEM_SEAT, start, stateHashOf(this._state))];
    this.transport.send({ t: 'ready', headHash: this._log[0]!.hash });
    this.checkReady();
  }

  private onReady(headHash: string): void {
    if (this.peerReadyHash !== null) throw new ProtocolError('duplicate ready');
    this.peerReadyHash = headHash;
    this.checkReady();
  }

  private checkReady(): void {
    if (this._status !== 'setup' || this._log.length === 0 || this.peerReadyHash === null) return;
    if (this.peerReadyHash !== this._log[0]!.hash) throw new DesyncError('peers disagree on the starting decks');
    this._status = 'playing';
    this.emit();
    this.runForcedMoves();
  }

  // -------------------------------------------------------------------------
  // Play
  // -------------------------------------------------------------------------

  private onAction(seq: number, action: MatchAction, headHash: string): void {
    if (this._status !== 'playing') throw new ProtocolError(`action received while the match is ${this._status}`);
    if (seq !== this._log.length) throw new DesyncError(`expected action ${this._log.length}, got ${seq}`);
    this.step(this.peer, action);
    const head = this._log[this._log.length - 1]!;
    if (head.hash !== headHash) throw new DesyncError(`head hash differs after action ${seq}`);
    this.afterAction();
  }

  /** Verify, apply to the engine, append to the log. Throws before changing anything. */
  private step(actor: Seat, action: MatchAction): void {
    const state = this._state!;
    const next = apply(state, actor, toEngineAction(action));
    this.verify(state, actor, action);
    this._state = next;
    this._log = [...this._log, appendEntry(this._log, actor, action, stateHashOf(next))];
  }

  private afterAction(): void {
    this.emit();
    if (this._state!.phase === 'over') this.beginAudit();
    else this.runForcedMoves();
  }

  /** Draw-key grants and Swamp reveals have exactly one legal move; make it. */
  private runForcedMoves(): void {
    const state = this._state;
    if (this._status !== 'playing' || state === null) return;
    if (state.phase !== 'drawKey' && state.phase !== 'revealHand') return;
    const forced = legalActions(state, this.seat, this.priv);
    if (forced.length === 1) this.submit(forced[0]!);
  }

  /** Attach this seat's keys to an engine action. */
  private withProofs(action: Action): MatchAction {
    const state = this._state!;
    const reveal = (card: CardId, land: Land): Reveal => {
      const slot = state.players[this.seat].hand.find((s) => s.id === card);
      if (slot === undefined || slot.land !== null) return { card, land };
      if (this.priv.get(card) !== land) throw new IllegalActionError(`card ${card} is not a ${land}`);
      return { card, land, ownerKey: toHex(this.ownKeys[slotOf(card).slot]!) };
    };
    switch (action.type) {
      case 'grantDrawKey': {
        const { owner, slot } = slotOf(action.card);
        if (owner !== this.peer) throw new IllegalActionError(`card ${action.card} is not in the opponent's deck`);
        return { type: 'grantDrawKey', card: action.card, key: toHex(this.otherKeys[slot]!) };
      }
      case 'play':
        return action.declaredTarget === undefined
          ? { type: 'play', reveal: reveal(action.card, action.land) }
          : { type: 'play', reveal: reveal(action.card, action.land), declaredTarget: action.declaredTarget };
      case 'counter':
        return { type: 'counter', island: reveal(action.island, action.islandLand), other: reveal(action.other, action.otherLand) };
      case 'revealHandForSwamp':
        return { type: 'revealHandForSwamp', cards: action.cards.map((c) => reveal(c.card, c.land)) };
      case 'pass':
      case 'allow':
      case 'resolveTarget':
      case 'resign':
        return action;
    }
  }

  /**
   * Cryptographic checks on an action the engine has already accepted:
   * every hidden card it reveals must carry a key that decrypts to the
   * claimed land, and a draw key granted to us must unlock a canonical card.
   */
  private verify(state: GameState, actor: Seat, action: MatchAction): void {
    const reveals: Reveal[] =
      action.type === 'play'
        ? [action.reveal]
        : action.type === 'counter'
          ? [action.island, action.other]
          : action.type === 'revealHandForSwamp'
            ? [...action.cards]
            : [];

    for (const reveal of reveals) {
      const { owner, slot } = slotOf(reveal.card);
      if (owner !== actor) throw new ProtocolError(`seat ${actor} revealed ${reveal.card}, which it does not own`);
      const hidden = state.players[actor].hand.some((s) => s.id === reveal.card && s.land === null);
      if (!hidden) continue;
      if (reveal.ownerKey === undefined) throw new ProtocolError(`no key for hidden card ${reveal.card}`);
      const ownerKey = fromHex(reveal.ownerKey);
      if (actor === this.seat) {
        if (ownerKey !== this.ownKeys[slot] || this.priv.get(reveal.card) !== reveal.land) {
          throw new ProtocolError(`our own reveal of ${reveal.card} does not match our keys`);
        }
        continue;
      }
      const verified = verifyReveal(owner, this.p, this.decks[owner]![slot]!, this.otherKeys[slot]!, {
        slot,
        land: reveal.land,
        ownerSecret: ownerKey,
      });
      if (verified === null) throw new ProtocolError(`reveal proof for ${reveal.card} failed (claimed ${reveal.land})`);
    }

    if (action.type === 'grantDrawKey') {
      const { owner, slot } = slotOf(action.card);
      if (owner === this.seat) this.learnDraw(slot, fromHex(action.key));
      else if (fromHex(action.key) !== this.otherKeys[slot]) {
        throw new ProtocolError(`draw key for ${action.card} is not ours`);
      }
    }
  }

  /** Unlock one of our own deck slots with the peer's key and record the land privately. */
  private learnDraw(slot: number, peerKey: bigint): void {
    const plaintext = decryptSlot(this.p, this.decks[this.seat]![slot]!, peerKey, this.ownKeys[slot]!);
    const index = this.canonical[this.seat].get(plaintext);
    if (index === undefined) throw new ProtocolError(`draw key for slot ${slot} does not unlock a valid card`);
    if (this.drawnPlaintexts.has(plaintext)) throw new ProtocolError(`slot ${slot} unlocked a card already drawn`);
    this.drawnPlaintexts.add(plaintext);
    this.priv.set(cardId(this.seat, slot), landForIndex(index));
  }

  private canonicalIndex(seat: Seat): Map<bigint, number> {
    return new Map(canonicalDeckValues(seat, this.p).map((value, k) => [value, k]));
  }

  // -------------------------------------------------------------------------
  // End-of-game audit
  // -------------------------------------------------------------------------

  private beginAudit(): void {
    this._status = 'auditing';
    this.sendAudit();
    this.emit();
  }

  private sendAudit(): void {
    this.transport.send({ t: 'audit', ownDeck: this.ownKeys.map(toHex), otherDeck: this.otherKeys.map(toHex) });
  }

  private onAudit(ownDeck: readonly string[], otherDeck: readonly string[]): void {
    if (this._status !== 'auditing') throw new ProtocolError(`audit received while the match is ${this._status}`);
    if (!Array.isArray(ownDeck) || !Array.isArray(otherDeck)) throw new ProtocolError('malformed audit');
    const peerOwn = ownDeck.map(fromHex);
    const peerOther = otherDeck.map(fromHex);
    const checks = [
      auditDeck(this.seat, this.p, this.decks[this.seat]!, this.ownKeys, peerOther),
      auditDeck(this.peer, this.p, this.decks[this.peer]!, peerOwn, this.otherKeys),
    ];
    for (const check of checks) {
      if (!check.ok) throw new ProtocolError(`deck audit failed: ${check.reason}`);
    }
    const winner = this._state!.winner!;
    this.end({ kind: 'win', winner: winner.seat, reason: winner.reason }, false);
  }

  // -------------------------------------------------------------------------
  // Reconnect
  // -------------------------------------------------------------------------

  /** Rebuild state from a snapshot, re-verifying every entry. */
  private replay(snapshot: Snapshot): void {
    const log = snapshot.log;
    if (!verifyChain(log)) throw new Error('snapshot log fails its hash chain');
    const start = log[0]?.action;
    if (start === undefined || start.type !== 'start') throw new Error('snapshot log does not begin with a start entry');

    this.ownKeys = snapshot.ownDeckKeys.map(fromHex);
    this.otherKeys = snapshot.otherDeckKeys.map(fromHex);
    this.decks = [start.decks[0].map(fromHex), start.decks[1].map(fromHex)];
    this.first = start.first;
    this.myOpeningKeys = [...start.openingKeys[this.seat]];
    this.peerOpeningKeys = [...start.openingKeys[this.peer]];
    this.peerOpeningKeys.forEach((key, slot) => this.learnDraw(slot, fromHex(key)));

    this._state = createGame(start.first);
    this._log = [appendEntry([], SYSTEM_SEAT, start, stateHashOf(this._state))];
    for (const entry of log.slice(1)) {
      this.step(entry.seat as Seat, entry.action as MatchAction);
    }
    if (this._log[this._log.length - 1]!.hash !== log[log.length - 1]!.hash) {
      throw new Error('replaying the snapshot log produced a different head hash');
    }
    this._status = this._state.phase === 'over' ? 'auditing' : 'playing';
  }

  private onResume(length: number, headHash: string): void {
    if (this._log.length === 0) throw new DesyncError('peer resumed a match we never started');
    if (!Number.isInteger(length) || length < 1) throw new ProtocolError('malformed resume');
    if (length <= this._log.length) {
      if (this._log[length - 1]!.hash !== headHash) throw new DesyncError(`logs diverge at entry ${length - 1}`);
      // Resend what the peer is missing. Our persist-before-send rule means those entries are all ours.
      for (const entry of this._log.slice(length)) {
        if (entry.seat !== this.seat) throw new DesyncError(`peer is missing its own action ${entry.seq}`);
        this.transport.send({ t: 'action', seq: entry.seq, action: entry.action as MatchAction, headHash: entry.hash });
      }
    }
    // If the peer is ahead, it resends its actions after our own resume message.
    if (this._status === 'playing') this.runForcedMoves();
    else this.sendAudit();
  }
}
