// The Land Game — end-to-end demo of the engine + match layers.
//
// Every code path shown already exists in the layers; the demo adds none:
//  - an omniscient referee plays a scripted match through engine apply()
//    ON TWO SEPARATE PEER STATES, asserting lockstep state hashes agree after
//    every single action, appending each move to a hash-chained log,
//  - the hidden-card discipline is visible: hand slots print as '···' until the
//    shared state knows a land,
//  - an epilogue runs the real SRA implementation: deck build, private draw,
//    reveal verification, honest audit — then catches a rigged deck and a
//    lying reveal.

import { apply, counterResponder, createGame } from '../src/engine/game.ts';
import { appendEntry, canonicalJson, sha256Hex, stateHashOf, verifyChain } from '../src/match/log.ts';
import type { LogEntry } from '../src/match/log.ts';
import {
  applyPerSlotLocks,
  auditDeck,
  bulkDecrypt,
  bulkEncrypt,
  canonicalDeckValues,
  decryptSlot,
  DEFAULT_PRIME,
  landOfPlaintext,
  shuffled,
  verifyReveal,
  type RandomBytes,
} from '../src/match/sra.ts';
import type { Action, CardId, GameState, Land, Seat } from '../src/engine/types.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bytesOf(rand: () => number): RandomBytes {
  return (n) => {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = Math.floor(rand() * 256);
    return bytes;
  };
}

const line = '─'.repeat(72);
const header = (t: string): void => {
  console.log();
  console.log(line);
  console.log(`  ${t}`);
  console.log(line);
};

// ---------------------------------------------------------------------------
// Match narrative: two peers, one shared log, per-action hash agreement
// ---------------------------------------------------------------------------

class Referee {
  p0: GameState;
  p1: GameState;
  log: LogEntry<Action>[] = [];
  claims = new Map<CardId, Land>(); // omniscient private knowledge, for sidebars
  private lastTurn = 0;

  constructor() {
    this.p0 = createGame(0);
    this.p1 = createGame(0);
  }

  claim(card: CardId, land: Land): void {
    const known = this.claims.get(card);
    if (known !== undefined && known !== land) {
      throw new Error(`inconsistent demo claim: ${card} was ${known}, now ${land}`);
    }
    this.claims.set(card, land);
  }

  /** Apply on both peers; they must agree on the resulting state hash. */
  act(seat: Seat, action: Action): void {
    const next0 = apply(this.p0, seat, action);
    const next1 = apply(this.p1, seat, action);
    const hash0 = stateHashOf(next0);
    const hash1 = stateHashOf(next1);
    if (hash0 !== hash1) throw new Error('lockstep desync!');

    this.log = [...this.log, appendEntry(this.log, seat, action, hash0)];
    this.p0 = next0;
    this.p1 = next1;

    if (this.p0.turn !== this.lastTurn) {
      this.lastTurn = this.p0.turn;
      console.log(`  ── turn ${this.p0.turn} ──`);
    }
    console.log(`  #${String(this.log.length).padStart(2, ' ')} ${describe(action, seat)}  ·  ${hash0.slice(0, 8)}`);
  }

  handOf(seat: Seat): string {
    const state = seat === 0 ? this.p0 : this.p1;
    return state.players[seat].hand
      .map((slot) => (slot.land !== null ? abbrev(slot.land) : '···'))
      .join(' ');
  }

  board(): void {
    const s = this.p0;
    const row = (seat: Seat): string => {
      const p = s.players[seat];
      const bf = p.battlefield.map((x) => (x.land === null ? '???' : abbrev(x.land))).join(' ') || '—';
      const grave = p.graveyard.map((x) => (x.land === null ? '???' : abbrev(x.land))).join(' ') || '—';
      return `P${seat}  bf [${bf}]  hand [${this.handOf(seat)}]  grave [${grave}]  lib ${p.library.length}`;
    };
    console.log('');
    console.log(`  ${row(0)}`);
    console.log(`  ${row(1)}`);
  }

  /**
   * Grant the pending draw key: the granting seat sends their half-key, the
   * drawer privately learns the land. The granting seat learns nothing — the
   * state transition is effect-free except phase/awaitingDraw bookkeeping.
   */
  grant(drawnLand: Land): void {
    const draw = this.p0.awaitingDraw;
    if (!draw) throw new Error('no draw is pending');
    this.claim(draw.card, drawnLand);
    const from = draw.seat === 0 ? 1 : 0;
    this.act(from, { type: 'grantDrawKey', card: draw.card });
    console.log(`       ↳ P${draw.seat} privately unlocks ${draw.card} = ${drawnLand}`);
  }

  /** The revealed hand demanded by a resolving Swamp: every slot, with land. */
  revealCardsFor(seat: Seat): Array<{ card: CardId; land: Land }> {
    const state = seat === 0 ? this.p0 : this.p1;
    return state.players[seat].hand.map((slot) => {
      const land = slot.land ?? this.claims.get(slot.id);
      if (land === undefined) throw new Error(`demo has no knowledge of ${slot.id}`);
      return { card: slot.id, land };
    });
  }
}

function abbrev(land: Land): string {
  return land.slice(0, 3);
}

function describe(action: Action, seat: Seat): string {
  const who = `P${seat}`;
  switch (action.type) {
    case 'play':
      return `${who} plays ${action.card} → ${action.land}${action.declaredTarget ? ` (target ${action.declaredTarget})` : ''}`;
    case 'counter':
      return `${who} COUNTERS ${action.island} (island) + ${action.other} (${action.otherLand})`;
    case 'allow':
      return `${who} lets it resolve`;
    case 'pass':
      return `${who} passes`;
    case 'grantDrawKey':
      return `${who} grants the draw key for ${action.card}`;
    case 'revealHandForSwamp':
      return `${who} reveals their whole hand`;
    case 'resolveTarget':
      return `${who} chooses ${action.target} for the effect`;
    case 'resign':
      return `${who} resigns`;
  }
}

// ---------------------------------------------------------------------------
// The scripted match — every draw claim below follows the engine's own draw
// ordering (turns alternate strictly, so P0 owns odd turns), and grant()
// claims the id of awaitingDraw, so the ledger cannot stretch.
// ---------------------------------------------------------------------------

header('THE LAND GAME — engine + mental poker demo');
console.log('  Two peers receive the identical action stream; each line prints the');
console.log("  shared state hash, asserted equal on both copies. '···' = still hidden.");

const r = new Referee();
r.claim('p0-slot-00', 'island');
r.claim('p0-slot-01', 'island');
r.claim('p0-slot-02', 'swamp');
r.claim('p0-slot-03', 'forest');
r.claim('p0-slot-04', 'plains');
r.claim('p1-slot-00', 'island');
r.claim('p1-slot-01', 'island');
r.claim('p1-slot-02', 'mountain');
r.claim('p1-slot-03', 'forest');
r.claim('p1-slot-04', 'forest');
r.board();

// --- t1 ----------------------------------------------------------------------
header('t1  P0 opens with an Island; P1 lets it in');
r.act(0, { type: 'play', card: 'p0-slot-00', land: 'island' });
r.act(1, { type: 'allow' });
r.grant('island'); // island effect draw → p0-slot-05 (played back on t3)
r.grant('island'); // t2 start draw    → p1-slot-05 (lost to the Swamp on t5)
r.board();

// --- t2: counter war, round one -----------------------------------------------
header('t2  P1 plays an Island — P0 counters — P1 counters the counter');
r.act(1, { type: 'play', card: 'p1-slot-00', land: 'island' });
r.act(0, { type: 'counter', island: 'p0-slot-01', islandLand: 'island', other: 'p0-slot-02', otherLand: 'swamp' });
console.log(`  (responder is P${counterResponder(r.p0.pending!)} — the controller may counter the counter)`);
r.act(1, { type: 'counter', island: 'p1-slot-01', islandLand: 'island', other: 'p1-slot-02', otherLand: 'mountain' });
r.act(0, { type: 'allow' }); // two counters = even → the Island resolves
r.grant('island'); // P1's island-effect draw → p1-slot-06 (played on t6)
// the turn flips here: t3's start draw is P0's — granted in the t3 section below
r.board();

// --- t3 -------------------------------------------------------------------------
header('t3  P0 rides their first draw: a second Island');
r.grant('swamp'); // t3 start draw → p0-slot-06 (the coming Thoughtseize)
r.act(0, { type: 'play', card: 'p0-slot-05', land: 'island' });
r.act(1, { type: 'allow' });
r.grant('island'); // island draw → p0-slot-07 (banked for the counter war)
r.grant('mountain'); // t4 start draw → p1-slot-07
r.board();

// --- t4: mountain kill -------------------------------------------------------------
header('t4  P1 finally acts: Mountain → destroys P0\u2019s first Island');
r.act(1, { type: 'play', card: 'p1-slot-07', land: 'mountain', declaredTarget: 'p0-slot-00' });
r.act(0, { type: 'allow' });
r.board();

// --- t5: Thoughtseize ------------------------------------------------------------------
header('t5  P0 plays the Swamp — full hand reveal, then pick the discard');
r.grant('island'); // t5 start draw → p0-slot-08
r.act(0, { type: 'play', card: 'p0-slot-06', land: 'swamp' });
r.act(1, { type: 'allow' });
r.act(1, { type: 'revealHandForSwamp', cards: r.revealCardsFor(1) });
console.log('  (P1\u2019s hand is now public to both peers — watch the board)');
r.board();
r.act(0, { type: 'resolveTarget', target: 'p1-slot-05' }); // strip an Island from P1
r.board();

// --- t6 -------------------------------------------------------------------------------
header('t6  P1 starts the Island race with a publicly revealed Island');
r.grant('mountain'); // t6 start draw → p1-slot-08 (banked: it pays for the t12 counter)
r.act(1, { type: 'play', card: 'p1-slot-06', land: 'island' });
r.act(0, { type: 'allow' });
r.grant('island'); // island draw → p1-slot-09
r.board();

// --- t7/t8/t9/t10/t11: the parallel floods ----------------------------------------------
header('t7–t11  Both players ride their draws; Islands pile up');
r.grant('island'); // t7 start draw → p0-slot-09
r.act(0, { type: 'play', card: 'p0-slot-08', land: 'island' });
r.act(1, { type: 'allow' });
r.grant('island'); // island draw → p0-slot-10

r.grant('forest'); // t8 start draw → p1-slot-10
r.act(1, { type: 'play', card: 'p1-slot-09', land: 'island' });
r.act(0, { type: 'allow' });
r.grant('island'); // island draw → p1-slot-11

r.grant('forest'); // t9 start draw → p0-slot-11
r.act(0, { type: 'play', card: 'p0-slot-09', land: 'island' });
r.act(1, { type: 'allow' });
r.grant('plains'); // island draw → p0-slot-12

r.grant('island'); // t10 start draw → p1-slot-12
r.act(1, { type: 'play', card: 'p1-slot-11', land: 'island' });
r.act(0, { type: 'allow' });
r.grant('plains'); // island draw → p1-slot-13

r.grant('island'); // t11 start draw → p0-slot-13
r.act(0, { type: 'play', card: 'p0-slot-10', land: 'island' });
r.act(1, { type: 'allow' });
r.grant('plains'); // island draw → p0-slot-14

console.log('  (P0 sits on four Islands + a Swamp; P1 also on four Islands)');
r.board();

// --- t12: counter war, round two -----------------------------------------------------------
header('t12  P1\u2019s FIFTH Island hits the stack — P0 goes to war over it');
r.grant('island'); // t12 start draw → p1-slot-14 (P1\u2019s last Island)
r.act(1, { type: 'play', card: 'p1-slot-12', land: 'island' }); // would win next allow
r.act(0, { type: 'counter', island: 'p0-slot-07', islandLand: 'island', other: 'p0-slot-03', otherLand: 'forest' });
console.log('  (P1 still has a draw in hand — counters the counter)');
r.act(1, { type: 'counter', island: 'p1-slot-14', islandLand: 'island', other: 'p1-slot-08', otherLand: 'mountain' });
console.log('  (P0 can counter a counter, and does)');
r.act(0, { type: 'counter', island: 'p0-slot-13', islandLand: 'island', other: 'p0-slot-04', otherLand: 'plains' });
console.log('  (three counters in; responder is P1 again — no Islands left to pay with)');
r.act(1, { type: 'allow' }); // odd → the fifth Island never enters play
r.board();

// --- t13: the win, checked before the effect -----------------------------------------------
header('t13  P0\u2019s start draw is an Island — the FIFTH Island wins');
r.grant('island'); // t13 start draw → p0-slot-15
r.act(0, { type: 'play', card: 'p0-slot-15', land: 'island' });
console.log('  (P1\u2019s hand: no Islands left to counter with)');
r.act(1, { type: 'allow' }); // win is checked as the land enters, BEFORE its draw effect
r.board();

// --- wrap-up ----------------------------------------------------------------------------------
header('Rigour');
console.log(`  log entries:            ${r.log.length}`);
console.log(`  hash chain verified:    ${verifyChain(r.log)}`);
console.log(`  final state hash:       ${stateHashOf(r.p0).slice(0, 12)}…`);
console.log(`  identical on both peers: ${stateHashOf(r.p0) === stateHashOf(r.p1)}`);
console.log(`  winner:                 P${r.p0.winner?.seat} by ${r.p0.winner?.reason}`);

await cryptoEpilogue();

// ---------------------------------------------------------------------------
// Mental poker epilogue — the real SRA implementation, seeded for determinism.
// Seat 0 is the deck owner; P1 is the other player.
// ---------------------------------------------------------------------------

async function cryptoEpilogue(): Promise<void> {
  header('Mental poker epilogue — building P0\u2019s deck with real SRA');
  const rand = bytesOf(mulberry32(4242));
  const p = DEFAULT_PRIME;
  const truth = canonicalDeckValues(0, p); // the referee's ground truth
  console.log(`  modulus: ${p.toString(16).slice(0, 14)}… (${p.toString(16).length * 4} bits)`);
  console.log('  canonical deck: 50 distinct SHA-256-derived values, 10 of each land');

  const stepA = bulkEncrypt(truth, p, rand);
  const sentA = shuffled(stepA.cards, rand);
  console.log('  step A  P0 bulk-locks the deck and shuffles  → sends 50 × m^e_A       (P0 knows this permutation, not P1)');

  const stepB = bulkEncrypt(sentA, p, rand);
  const sentB = shuffled(stepB.cards, rand);
  console.log('  step B  P1 bulk-locks and shuffles           → sends 50 × m^(e_A·e_B) (readable by neither)');

  const strippedC = bulkDecrypt(sentB, p, stepA.key.d);
  const stepC = applyPerSlotLocks(strippedC, p, rand);
  console.log('  step C  P0 strips own lock, per-slot-locks   → 50 × m^(e_A,i·e_B)     (IN PLACE — keys attach to slots)');

  const strippedD = bulkDecrypt(stepC.cards, p, stepB.key.d);
  const stepD = applyPerSlotLocks(strippedD, p, rand);
  console.log('  step D  P1 strips own lock, per-slot-locks   → 50 × m^(e_A,i·e_B,i)   (IN PLACE — no shuffle, on purpose)');

  // A draw: P1 grants their per-slot key; P0 unlocks and reads in private.
  const slot = 17;
  const plaintext = decryptSlot(p, stepD.cards[slot]!, stepD.secrets[slot]!, stepC.secrets[slot]!);
  const land = landOfPlaintext(0, p, plaintext);
  console.log(`  draw:    P1 grants d_B,${slot}; P0 unlocks privately → card = ${land} (P1 cannot read it)`);

  // A play: P0 reveals {land, ownerSecret}; P1 verifies against their own key.
  const proofLand = land!;
  const verified = verifyReveal(0, p, stepD.cards[slot]!, stepD.secrets[slot]!, {
    slot,
    land: proofLand,
    ownerSecret: stepC.secrets[slot]!,
  });
  console.log(`  reveal:  P0 plays the card with proof {land, d_A,${slot}} → P1 verifies: ${verified === proofLand ? 'OK ✅' : 'hang on, that failed'}`);

  // End-of-game audit: all per-slot keys broadcast, every slot decrypted.
  const audit = auditDeck(0, p, stepD.cards, stepC.secrets, stepD.secrets);
  console.log(`  audit:   honest deck → ${audit.ok ? 'PASS — exactly 10 of each land' : audit.reason}`);

  // The cheat: same protocol, but the deck was built with 11 Islands.
  console.log('');
  console.log('  Now the cheat: the owner built a deck with 11 Islands and 9 Forests…');
  const rigged = [...truth];
  rigged[0] = truth[11]!; // duplicate an Island, drop a Forest
  const rA = bulkEncrypt(rigged, p, rand);
  const rSentA = shuffled(rA.cards, rand);
  const rB = bulkEncrypt(rSentA, p, rand);
  const rSentB = shuffled(rB.cards, rand);
  const rC = applyPerSlotLocks(bulkDecrypt(rSentB, p, rA.key.d), p, rand);
  const rD = applyPerSlotLocks(bulkDecrypt(rC.cards, p, rB.key.d), p, rand);
  const caught = auditDeck(0, p, rD.cards, rC.secrets, rD.secrets);
  console.log(`  audit:   rigged deck → ${caught.ok ? 'missed it, bug!' : `CAUGHT: ${caught.reason}`}`);

  // The lie: claim Island, actually reveal whatever it truthfully is.
  const lie: Land = proofLand === 'island' ? 'forest' : 'island';
  const rejected = verifyReveal(0, p, stepD.cards[slot]!, stepD.secrets[slot]!, {
    slot,
    land: lie,
    ownerSecret: stepC.secrets[slot]!,
  });
  console.log(`  reveal:  lying proof (claims ${lie}, card is ${proofLand}) → ${rejected === null ? 'REJECTED ✅' : 'missed it, bug!'}`);

  console.log('');
  console.log(`  canonical JSON: ${canonicalJson({ b: 2, a: 1 })}`);
  console.log(`  sha256('land-game'): ${sha256Hex('land-game').slice(0, 16)}…`);
  console.log('');
  console.log('  Demo complete. Next steps: WebRTC transport, board.');
}
