// Presence encoding: hidden hand cards travel as a visual index, public cards
// by id, cursors clamped and flipped; malformed input maps to nothing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, createGame } from '../../src/engine/game.ts';
import { hoverMessage, hoveredCard, isPublic, nextHandOrder, peerCursor } from '../../src/board/presence.ts';
import type { Presence } from '../../src/board/presence.ts';

test('hand order keeps old positions and shuffles new cards in', () => {
  const first = nextHandOrder([], ['a', 'b', 'c'], () => 0);
  assert.deepEqual(first, ['c', 'b', 'a']); // each new card inserted at the front
  const next = nextHandOrder(first, ['a', 'c', 'd'], () => 0.99);
  assert.deepEqual(next, ['c', 'a', 'd']); // b left, d appended at the end
});

test('hidden hand cards travel as an index into the sender’s visual order', () => {
  const s = createGame(0);
  const mine = ['p0-slot-03', 'p0-slot-00', 'p0-slot-04', 'p0-slot-01', 'p0-slot-02'];
  const message = hoverMessage(s, 0, mine, 'p0-slot-04');
  assert.deepEqual(message, { t: 'hoverHand', index: 2 });
  // The receiver shows the same hand in its own order; the index picks its third hidden card.
  const theirs = ['p0-slot-00', 'p0-slot-01', 'p0-slot-02', 'p0-slot-03', 'p0-slot-04'];
  assert.equal(hoveredCard(s, theirs, message), 'p0-slot-02');
});

test('public cards travel by id: the stack, battlefield, revealed hand cards', () => {
  let s = createGame(0);
  s = apply(s, 0, { type: 'play', card: 'p0-slot-00', land: 'island' });
  assert.ok(isPublic(s, 'p0-slot-00'), 'the land on the stack is public');
  assert.deepEqual(hoverMessage(s, 0, [], 'p0-slot-00'), { t: 'hoverBoard', card: 'p0-slot-00' });
  assert.equal(hoveredCard(s, [], { t: 'hoverBoard', card: 'p0-slot-00' }), 'p0-slot-00');
  // A peer cannot point at a hidden card by id.
  assert.equal(hoveredCard(s, [], { t: 'hoverBoard', card: 'p0-slot-01' }), null);
});

test('malformed presence maps to nothing; cursors clamp and flip', () => {
  const s = createGame(0);
  const order = ['p1-slot-00', 'p1-slot-01'];
  for (const bad of [{ t: 'hoverHand', index: 9 }, { t: 'hoverHand', index: 0.5 }, { t: 'hoverHand', index: -1 }, { t: 'hoverBoard', card: 42 }] as unknown as Presence[]) {
    assert.equal(hoveredCard(s, order, bad), null);
  }
  assert.deepEqual(peerCursor({ t: 'cursor', x: 0.25, y: 0.1 }), { x: 0.25, y: 0.9 });
  assert.deepEqual(peerCursor({ t: 'cursor', x: -3, y: 7 }), { x: 0, y: 0 });
  assert.equal(peerCursor({ t: 'cursor', x: Number.NaN, y: 0 }), null);
  assert.equal(peerCursor({ t: 'hoverHand', index: 1 }), null);
});
