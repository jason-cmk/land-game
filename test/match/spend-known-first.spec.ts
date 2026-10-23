// Canonical spend-known-first slot picking (match layer).

import test from 'node:test';
import assert from 'node:assert/strict';

import { pickSpendFirstSlot } from '../../src/match/spend-known-first.ts';
import type { CardId, CardSlot, Land } from '../../src/engine/types.ts';

function hand(entries: Array<[string, Land | null]>): CardSlot[] {
  return entries.map(([id, land]) => ({ id, land }));
}

test('a publicly known copy always wins over a privately known hidden copy', () => {
  const h = hand([
    ['a', null],
    ['b', 'island'],
    ['c', null],
  ]);
  const priv = new Map<CardId, Land>([
    ['a', 'island'],
    ['c', 'island'],
  ]);
  assert.equal(pickSpendFirstSlot(h, 'island', priv), 'b');
});

test('with no public copy, the first privately known hidden copy is picked', () => {
  const h = hand([
    ['a', null],
    ['b', null],
  ]);
  const priv = new Map<CardId, Land>([
    ['a', 'forest'],
    ['b', 'forest'],
  ]);
  assert.equal(pickSpendFirstSlot(h, 'forest', priv), 'a');
});

test('unknown slot types are never picked', () => {
  const h = hand([['a', null], ['b', 'mountain']]);
  const priv = new Map<CardId, Land>([['a', 'plains']]);
  assert.equal(pickSpendFirstSlot(h, 'swamp', priv), null);
});

test('without private knowledge only public copies are visible', () => {
  const h = hand([['a', null]]);
  assert.equal(pickSpendFirstSlot(h, 'island', undefined), null);
});

test('choice is deterministic: earlier hand order wins among equal candidates', () => {
  const h = hand([
    ['z', null],
    ['y', null],
  ]);
  const priv = new Map<CardId, Land>([
    ['z', 'swamp'],
    ['y', 'swamp'],
  ]);
  assert.equal(pickSpendFirstSlot(h, 'swamp', priv), 'z');
});
