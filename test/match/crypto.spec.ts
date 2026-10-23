// Mental Poker primitives: SRA commutative encryption, the 4-step deck
// protocol, draw grants, reveal verification, tamper detection, and audit.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalDeckValues,
  landForIndex,
  landOfPlaintext,
  auditDeck,
  bulkDecrypt,
  bulkEncrypt,
  applyPerSlotLocks,
  decryptSlot,
  modInverse,
  modPow,
  generatePrime,
  makeKeyPair,
  shuffled,
  verifyReveal,
  type RandomBytes,
} from '../../src/match/sra.ts';

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

function seededRandomBytes(seed: number): RandomBytes {
  const next = mulberry32(seed);
  return (n) => {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = Math.floor(next() * 256);
    return bytes;
  };
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

test('modPow / modInverse basics', () => {
  const p = 101n;
  assert.equal(modPow(2n, 10n, p), 14n); // 1024 mod 101
  assert.equal(modPow(5n, 3n, 13n), 8n); // 125 mod 13
  const { e, d } = makeKeyPair(101n, seededRandomBytes(7));
  assert.equal((e * d) % (p - 1n), 1n); // keypair inverses mod p-1
  assert.equal(modInverse(3n, p - 1n), 67n); // 3*67 = 201 = 1 mod 100
  assert.throws(() => modInverse(2n, 100n)); // gcd(2, 100) != 1
});

test('encryption order does not matter (commutativity)', () => {
  const rand = seededRandomBytes(42);
  const p = generatePrime(256, rand);
  const m = 123456789n;
  const ka = makeKeyPair(p, rand);
  const kb = makeKeyPair(p, rand);
  const ab = modPow(modPow(m, ka.e, p), kb.e, p);
  const ba = modPow(modPow(m, kb.e, p), ka.e, p);
  assert.equal(ab, ba);
  // and decrypting in either order returns m
  assert.equal(modPow(ab, kb.d, p), modPow(m, ka.e, p));
  assert.equal(modPow(modPow(ab, ka.d, p), kb.d, p), m);
});

test('generatePrime produces odd probable primes of the requested size', () => {
  const rand = seededRandomBytes(1);
  const p = generatePrime(256, rand);
  assert.equal(p % 2n, 1n);
  assert.ok(p >> 254n >= 2n); // top two bits set
  assert.equal(generatePrime(256, seededRandomBytes(1)), p); // deterministic rerun
});

// ---------------------------------------------------------------------------
// Canonical deck
// ---------------------------------------------------------------------------

test('canonical deck: 10 of each land, deterministic, distinct values', () => {
  const p = generatePrime(256, seededRandomBytes(3));
  const values = canonicalDeckValues(0, p);
  assert.equal(values.length, 50);
  assert.equal(new Set(values).size, 50);
  const lands = values.map((_, k) => landForIndex(k));
  for (const land of ['forest', 'island', 'mountain', 'plains', 'swamp']) {
    assert.equal(lands.filter((l) => l === land).length, 10);
  }
  assert.deepEqual(canonicalDeckValues(0, p), values);
  assert.notDeepEqual(canonicalDeckValues(1, p), values);
  // lookup matches
  for (let k = 0; k < 50; k++) {
    assert.equal(landOfPlaintext(0, p, values[k]!), landForIndex(k));
  }
});

// ---------------------------------------------------------------------------
// The 4-step protocol
// ---------------------------------------------------------------------------

interface DeckTransaction {
  final: bigint[];
  ownerSecrets: bigint[];
  otherSecrets: bigint[];
  p: bigint;
}

/** Runs the full protocol, as two separate parties would, sharing only messages. */
function runDeckProtocol(seed: number, seat: 0 | 1): DeckTransaction {
  const rand = seededRandomBytes(seed);
  const p = generatePrime(256, rand);
  const plaintexts = canonicalDeckValues(seat, p);

  // Step A: owner bulk-encrypts and shuffles
  const stepA = bulkEncrypt(plaintexts, p, rand);
  const sentA = shuffled(stepA.cards, rand);

  // Step B: other bulk-encrypts (in place) and shuffles the unreadable list
  const stepB = bulkEncrypt(sentA, p, rand);
  const sentB = shuffled(stepB.cards, rand);

  // Step C: owner strips bulk, attaches per-slot secrets; no shuffle
  const strippedC = bulkDecrypt(sentB, p, stepA.key.d);
  const stepC = applyPerSlotLocks(strippedC, p, rand);

  // Step D: other strips bulk, attaches per-slot secrets; NO shuffle
  const strippedD = bulkDecrypt(stepC.cards, p, stepB.key.d);
  const stepD = applyPerSlotLocks(strippedD, p, rand);

  return { final: stepD.cards, ownerSecrets: stepC.secrets, otherSecrets: stepD.secrets, p };
}

test('the full protocol: every slot is decryptable only with both halves', () => {
  const t = runDeckProtocol(11, 0);
  const canonical = canonicalDeckValues(0, t.p);
  const decryptedMultiset = t.final.map((_, i) => decryptSlot(t.p, t.final[i]!, t.otherSecrets[i]!, t.ownerSecrets[i]!));
  // the multiset of plaintexts equals the canonical deck (order is hidden)
  const remaining = [...canonical];
  for (const m of decryptedMultiset) {
    const idx = remaining.indexOf(m);
    assert.ok(idx >= 0, 'decrypted to a non-canonical plaintext');
    remaining.splice(idx, 1);
  }
  // with only one half, decryption yields ciphertext of the other lock — not m
  const half = t.final.map((c) => modPow(c, t.otherSecrets[0]!, t.p));
  assert.notEqual(half[5], canonical[5]);
});

test('draw grant: the other player unlocks for the owner, who reads privately', () => {
  const t = runDeckProtocol(12, 0);
  const canonical = canonicalDeckValues(0, t.p);
  for (let i = 0; i < 50; i += 7) {
    const plaintext = decryptSlot(t.p, t.final[i]!, t.otherSecrets[i]!, t.ownerSecrets[i]!);
    assert.ok(canonical.includes(plaintext));
    assert.equal(landOfPlaintext(0, t.p, plaintext), landForIndex(canonical.indexOf(plaintext)));
  }
});

test('reveal proof verification accepts honest proofs and rejects tampering', () => {
  const t = runDeckProtocol(13, 0);
  const canonical = canonicalDeckValues(0, t.p);
  const slot = 3;
  const plaintext = decryptSlot(t.p, t.final[slot]!, t.otherSecrets[slot]!, t.ownerSecrets[slot]!);
  const land = landForIndex(canonical.indexOf(plaintext));

  const rand = seededRandomBytes(999);
  const foreignKey = makeKeyPair(t.p, rand);
  assert.equal(verifyReveal(0, t.p, t.final[slot]!, t.otherSecrets[slot]!, { slot, land, ownerSecret: t.ownerSecrets[slot]! }), land);
  assert.equal(verifyReveal(0, t.p, t.final[slot]!, t.otherSecrets[slot]!, { slot, land: land === 'forest' ? 'island' : 'forest', ownerSecret: t.ownerSecrets[slot]! }), null);
  assert.equal(verifyReveal(0, t.p, t.final[slot]!, t.otherSecrets[slot]!, { slot, land, ownerSecret: foreignKey.d }), null);
});

test('end-of-game audit passes an honest deck and catches an 11-island cheat', () => {
  const t = runDeckProtocol(14, 0);
  const honest = auditDeck(0, t.p, t.final, t.ownerSecrets, t.otherSecrets);
  assert.deepEqual(honest, { ok: true, lands: honest.ok ? honest.lands : [] });
  assert.ok(honest.ok && honest.lands.filter((l) => l === 'island').length === 10);

  // Cheater swaps a Forest for a second copy of the first Island plaintext.
  const rand = seededRandomBytes(15);
  const p = generatePrime(256, rand);
  const canonical = canonicalDeckValues(0, p);
  const rigged = [...canonical];
  rigged[0] = canonical[11]!; // duplicate an Island; drop a Forest
  const riggedState = runDeckProtocolOn(rigged, p, rand);
  const audit = auditDeck(0, p, riggedState.final, riggedState.ownerSecrets, riggedState.otherSecrets);
  assert.ok(!audit.ok && /canonical deck/.test(audit.reason));
});

/** Same as runDeckProtocol but with a rigged canonical list (cheating harness). */
function runDeckProtocolOn(plaintexts: bigint[], p: bigint, rand: RandomBytes): DeckTransaction {
  const stepA = bulkEncrypt(plaintexts, p, rand);
  const sentA = shuffled(stepA.cards, rand);
  const stepB = bulkEncrypt(sentA, p, rand);
  const sentB = shuffled(stepB.cards, rand);
  const strippedC = bulkDecrypt(sentB, p, stepA.key.d);
  const stepC = applyPerSlotLocks(strippedC, p, rand);
  const strippedD = bulkDecrypt(stepC.cards, p, stepB.key.d);
  const stepD = applyPerSlotLocks(strippedD, p, rand);
  return { final: stepD.cards, ownerSecrets: stepC.secrets, otherSecrets: stepD.secrets, p };
}

test('audit detects an incomplete key broadcast', () => {
  const t = runDeckProtocol(16, 0);
  assert.ok(!auditDeck(0, t.p, t.final, t.ownerSecrets.slice(0, 49), t.otherSecrets).ok);
  assert.ok(!auditDeck(0, t.p, t.final.slice(0, 49), t.ownerSecrets, t.otherSecrets).ok);
});

test('the protocol transcript is deterministic for a fixed seed and different otherwise', () => {
  const a = runDeckProtocol(17, 0);
  const b = runDeckProtocol(17, 0);
  assert.deepEqual(a.final, b.final);
  assert.deepEqual(a.ownerSecrets, b.ownerSecrets);
  const c = runDeckProtocol(18, 0);
  assert.notDeepEqual(a.final, c.final);
});

test('shuffled preserves multisets', () => {
  const rand = seededRandomBytes(19);
  const items = [1, 2, 3, 4, 5, 6];
  const out = shuffled(items, rand);
  assert.deepEqual([...out].sort(), items);
});
