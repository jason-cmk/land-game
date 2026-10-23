// SHA-256 vectors, canonical JSON, and the action-log hash chain.

import test from 'node:test';
import assert from 'node:assert/strict';

import { sha256Hex, canonicalJson, appendEntry, verifyChain } from '../../src/match/log.ts';

test('sha256 against standard vectors', () => {
  assert.equal(
    sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
});

test('sha256 handles multiple 64-byte blocks', () => {
  // one million 'a' characters is the standard long-vector test
  assert.equal(
    sha256Hex('a'.repeat(1_000_000)),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  );
});

test('canonical JSON sorts keys recursively with no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { y: null, x: true }] }), '{"a":[2,{"x":true,"y":null}],"b":1}');
  assert.equal(canonicalJson({ outer: { c: 1, b: [{ q: 1, p: 'quote\\"' }] } }), '{"outer":{"b":[{"p":"quote\\\\\\"","q":1}],"c":1}}');
  assert.equal(canonicalJson('hello'), '"hello"');
  assert.equal(canonicalJson(42), '42');
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson([]), '[]');
  assert.equal(canonicalJson({}), '{}');
});

test('canonical JSON drops undefined object values', () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
});

test('canonical JSON rejects bigints', () => {
  assert.throws(() => canonicalJson({ big: 1n }));
});

test('hash chain verifies when intact and fails under tampering', () => {
  type A = { readonly kind: string };
  let log: Array<ReturnType<typeof appendEntry<A>>> = [];
  log = [...log, appendEntry(log, 0, { kind: 'play' }, 'h1')];
  log = [...log, appendEntry(log, 1, { kind: 'allow' }, 'h2')];
  log = [...log, appendEntry(log, 0, { kind: 'pass' }, 'h3')];

  assert.equal(verifyChain(log), true);

  // tamper with an action deep in the chain
  const tampered = log.map((e, i) => (i === 1 ? { ...e, action: { kind: 'counter' } } : e));
  assert.equal(verifyChain(tampered), false);

  // tamper with a state hash
  const tampered2 = log.map((e, i) => (i === 2 ? { ...e, stateHash: 'deadbeef' } : e));
  assert.equal(verifyChain(tampered2), false);

  // reordered entries fail as well
  assert.equal(verifyChain([...log].reverse()), false);
  assert.equal(verifyChain([]), true);
});
