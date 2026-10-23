// Mental Poker primitives: SRA commutative encryption over a prime modulus.
//
// One deck is set up as follows (owner = the seat whose deck it is):
//   Step A  owner:  bulk-encrypt the 50 canonical card values with keypair
//                   (e_A, d_A), shuffle, send.                    [m^e_A]
//   Step B  other:  bulk-encrypt with (e_B, d_B) in place, shuffle, send back.
//                                                          [m^(e_A*e_B)]
//   Step C  owner:  remove own bulk lock (d_A), then attach per-slot secrets
//                   d_{A,i} (random e_{A,i} per slot, keep d_{A,i}) in place.
//                   No shuffle.                                   [m^(e_{A,i}*e_B)]
//   Step D  other:  remove own bulk lock (d_B), attach per-slot secrets
//                   d_{B,i} in place. NO SHUFFLE — a shuffle here would sever
//                   the owner's slot-key attachment.              [m^(e_{A,i}*e_{B,i})]
//
// Why neither party knows the deck contents:
//   - The other player shuffled at step B while the cards were locked by the
//     owner's key, so they track a permutation of unreadable cards.
//   - The owner can follow the cards through their own step A shuffle but not
//     through the other player's step B shuffle.
//   - Neither ever holds both halves needed to read a slot at rest.
//
// Drawing slot i: the other player grants d_{B,i}; both sides compute
//   S = D[i]^d_{B,i} = m^{e_{A,i}}  (unreadable to the other player).
// The owner applies d_{A,i} and reads m privately.
//
// Reveal proof (owner): publishes { slot i, land, d_{A,i} }. The other player
// verifies m = D[i]^(d_{B,i} * d_{A,i}) is one of the canonical values and that
// its land matches the claim.
//
// End-of-game audit: both players broadcast ALL of their per-slot secrets; each
// side decrypts all 50 slots and checks the multiset equals the canonical deck
// (exactly 10 of each land). A tampered deck (e.g. 11 Islands) fails here even
// if every individual reveal was consistent.
//
// Security note: SRA is malleable and not IND-CPA secure; the deck composition
// (10 of each land) bounds what an adversary can learn. This is accepted for a
// pencil-and-paper-strength homebrew game.

import type { Land } from '../engine/types.ts';
import { sha256Hex } from './log.ts';

export type RandomBytes = (n: number) => Uint8Array;

/** Cryptography-quality default; injectable for deterministic tests. */
export const defaultRandomBytes: RandomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// ---------------------------------------------------------------------------
// BigInt arithmetic
// ---------------------------------------------------------------------------

export function modPow(base: bigint, exponent: bigint, mod: bigint): bigint {
  if (mod <= 1n) throw new Error('modulus must be > 1');
  let result = 1n;
  let b = base % mod;
  let e = exponent;
  if (e < 0n) throw new Error('negative exponents are not supported');
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

export function modInverse(a: bigint, m: bigint): bigint {
  if (m <= 0n) throw new Error('modulus must be positive');
  let [old_r, r] = [a % m, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error(`${a} has no inverse mod ${m} (gcd = ${old_r})`);
  return ((old_s % m) + m) % m;
}

export function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** Near-uniform integer in [0, bound); slight bias accepted, bound is astronomically large. */
export function randomBelow(bound: bigint, rand: RandomBytes): bigint {
  if (bound <= 1n) return 0n;
  const byteLen = Math.ceil(bound.toString(16).length / 2) + 8; // +8 bytes: negligible bias, simple
  return bytesToBigInt(rand(byteLen)) % bound;
}

/**
 * A distinct random integer in [1, bound) that is coprime to `coprimeWith`.
 * Loops until gcd(value, coprimeWith) === 1 — expected O(log log) trials for
 * p-1 with few factors.
 */
export function randomCoprime(bound: bigint, coprimeWith: bigint, rand: RandomBytes): bigint {
  for (;;) {
    const value = randomBelow(bound, rand) + 1n; // [1, bound)
    if (value < bound && gcd(value, coprimeWith) === 1n) return value;
  }
}

export interface KeyPair {
  readonly e: bigint;
  readonly d: bigint;
}

/** SRA keypair for modulus p: e coprime to p-1, d = e^-1 mod (p-1). */
export function makeKeyPair(p: bigint, rand: RandomBytes): KeyPair {
  const e = randomCoprime(p - 1n, p - 1n, rand);
  return { e, d: modInverse(e, p - 1n) };
}

// ---------------------------------------------------------------------------
// Primes
// ---------------------------------------------------------------------------

function isProbablePrime(n: bigint, rounds: number, rand: RandomBytes): boolean {
  if (n < 2n) return false;
  for (const small of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
    if (n === small) return true;
    if (n % small === 0n) return false;
  }
  let d = n - 1n;
  let r = 0;
  while (d % 2n === 0n) {
    d >>= 1n;
    r++;
  }
  for (let i = 0; i < rounds; i++) {
    const a = randomBelow(n - 2n, rand) + 2n; // [2, n-1]
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let composite = true;
    for (let j = 0; j < r - 1; j++) {
      x = (x * x) % n;
      if (x === n - 1n) {
        composite = false;
        break;
      }
    }
    if (composite) return false;
  }
  return true;
}

/**
 * Miller-Rabin probable prime with the top two bits set (so e_{A,i} * e_{B,i}
 * style products stay far below p later — not required, just tidy).
 * Any prime works for SRA; a safe prime is NOT needed because e is drawn
 * coprime to p-1 directly.
 */
export function generatePrime(bits: number, rand: RandomBytes): bigint {
  const bytes = Math.ceil(bits / 8);
  for (;;) {
    const buf = rand(bytes);
    // force top two bits and the low bit
    buf[0]! = (buf[0]! | 0b1100_0000) & 0b1111_1111;
    buf[bytes - 1]! = buf[bytes - 1]! | 1;
    const candidate = bytesToBigInt(buf);
    if (candidate >> BigInt(bits) !== 0n) continue; // overshoot when bits % 8 !== 0
    if (isProbablePrime(candidate, 16, rand)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Canonical card values
// // The deck composition and canonical value derivation are public; only the
// // mapping from encrypted slot values to cards is secret.
// ---------------------------------------------------------------------------

export const CARDS_PER_LAND = 10;
export const DECK_SIZE = 50;

/**
 * Deterministic plaintext value for (seat, index k). k 0-9 are Forests,
 * 10-19 Islands, and so on. Distinct by construction (salted rehash on the
 * astronomically unlikely collision).
 */
export function canonicalDeckValues(seat: 0 | 1, p: bigint): bigint[] {
  const modulusHex = p.toString(16);
  const values: bigint[] = [];
  const seen = new Set<bigint>();
  for (let k = 0; k < DECK_SIZE; k++) {
    for (let salt = 0; ; salt++) {
      const digest = sha256Hex(`land-game/card/v1|deck ${seat}|slot ${k}|salt ${salt}|p ${modulusHex}`);
      const value = BigInt(`0x${digest}`) % p;
      if (value !== 0n && !seen.has(value)) {
        seen.add(value);
        values.push(value);
        break;
      }
    }
  }
  return values;
}

export function landForIndex(k: number): Land {
  const lands: readonly Land[] = ['forest', 'island', 'mountain', 'plains', 'swamp'];
  return lands[Math.floor(k / CARDS_PER_LAND)]!;
}

export function landOfPlaintext(seat: 0 | 1, p: bigint, value: bigint): Land | null {
  const values = canonicalDeckValues(seat, p);
  const k = values.indexOf(value);
  return k === -1 ? null : landForIndex(k);
}

// ---------------------------------------------------------------------------
// Protocol steps
// ---------------------------------------------------------------------------

/** Fisher-Yates over a copy. */
export function shuffled<T>(items: readonly T[], rand: RandomBytes): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Number(randomBelow(BigInt(i + 1), rand));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/** Encrypt every card with one bulk keypair. */
export function bulkEncrypt(cards: readonly bigint[], p: bigint, rand: RandomBytes): { cards: bigint[]; key: KeyPair } {
  const key = makeKeyPair(p, rand);
  return { cards: cards.map((m) => modPow(m, key.e, p)), key };
}

/** Strip a bulk lock (the caller still cannot read the contents). */
export function bulkDecrypt(cards: readonly bigint[], p: bigint, d: bigint): bigint[] {
  return cards.map((c) => modPow(c, d, p));
}

/**
 * Attach per-slot locks in place. Keeps each slot's secret d_i (the matching
 * e_i is discarded: once locked, D[i] = m^{e_i} and reading later is
 * m = D[i]^{d_i} composed with the other party's unlock).
 */
export function applyPerSlotLocks(cards: readonly bigint[], p: bigint, rand: RandomBytes): { cards: bigint[]; secrets: bigint[] } {
  const secrets: bigint[] = [];
  const out = cards.map((c) => {
    const key = makeKeyPair(p, rand);
    secrets.push(key.d);
    return modPow(c, key.e, p);
  });
  return { cards: out, secrets };
}

// ---------------------------------------------------------------------------
// Verification of play-time reveals
// ---------------------------------------------------------------------------

export interface RevealProof {
  readonly slot: number;
  readonly land: Land;
  /** The owner's per-slot secret for this slot, now public. */
  readonly ownerSecret: bigint;
}

/**
 * The other player verifies a played card: with their own d_{B,i} and the
 * owner's broadcast d_{A,i}, decrypt and check the canonical mapping.
 * Returns the verified land, or null if the proof is bad.
 */
export function verifyReveal(
  seat: 0 | 1,
  p: bigint,
  slotValue: bigint,
  ownSecret: bigint,
  proof: RevealProof,
): Land | null {
  const holderSecret = modPow(slotValue, ownSecret, p); // = m^{e_{A,i}}
  const plaintext = modPow(holderSecret, proof.ownerSecret, p);
  const actualLand = landOfPlaintext(seat, p, plaintext);
  if (actualLand === null || actualLand !== proof.land) return null;
  return actualLand;
}

// ---------------------------------------------------------------------------
// End-of-game audit
// ---------------------------------------------------------------------------

/**
 * Decrypt every final slot to a plaintext and confirm the multiset is exactly
 * the canonical deck. Both players run this on both key broadcasts; it catches
 * a deck with e.g. 11 Islands even when every play was revealed consistently.
 */
export function auditDeck(
  seat: 0 | 1,
  p: bigint,
  finalDeck: readonly bigint[],
  ownerSecrets: readonly bigint[],
  otherSecrets: readonly bigint[],
): { ok: true; lands: Land[] } | { ok: false; reason: string } {
  if (finalDeck.length !== DECK_SIZE) return { ok: false, reason: `deck has ${finalDeck.length} cards` };
  if (ownerSecrets.length !== DECK_SIZE || otherSecrets.length !== DECK_SIZE) {
    return { ok: false, reason: 'key broadcast is incomplete' };
  }
  const plaintexts: bigint[] = [];
  for (let i = 0; i < DECK_SIZE; i++) {
    const holder = modPow(finalDeck[i]!, otherSecrets[i]!, p); // m^{e_{A,i}}
    plaintexts.push(modPow(holder, ownerSecrets[i]!, p)); // m
  }
  const canonical = canonicalDeckValues(seat, p);
  const remaining = [...canonical];
  for (const plaintext of plaintexts) {
    const idx = remaining.indexOf(plaintext);
    if (idx === -1) return { ok: false, reason: `plaintext ${plaintext} is not part of the canonical deck (tampered composition)` };
    remaining.splice(idx, 1);
  }
  const lands = plaintexts.map((m) => landOfPlaintext(seat, p, m) ?? 'forest');
  return { ok: true, lands };
}

/** Decrypt one drawn slot to its plaintext, given both sides' key halves. */
export function decryptSlot(
  p: bigint,
  slotValue: bigint,
  otherSecret: bigint,
  ownerSecret: bigint,
): bigint {
  return modPow(modPow(slotValue, otherSecret, p), ownerSecret, p);
}
