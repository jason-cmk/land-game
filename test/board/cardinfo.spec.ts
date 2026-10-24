// Card info: the effect text for each land, and where its panel goes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CARD_INFO, infoPlacement } from '../../src/board/cardinfo.ts';

test('every land has a name and effect text', () => {
  for (const land of ['forest', 'island', 'mountain', 'plains', 'swamp'] as const) {
    assert.ok(CARD_INFO[land].name.length > 0);
    assert.ok(CARD_INFO[land].lines.some((line) => line.startsWith('When played:')));
  }
});

test('the panel sits above the card, centred, when there is room', () => {
  const at = infoPlacement({ x: 200, y: 300, width: 80, height: 112 }, { width: 120, height: 60 }, { width: 800, height: 600 });
  assert.deepEqual(at, { x: 180, y: 232 });
});

test('a card at the top edge gets the panel below it', () => {
  const at = infoPlacement({ x: 200, y: 10, width: 80, height: 112 }, { width: 120, height: 60 }, { width: 800, height: 600 });
  assert.deepEqual(at, { x: 180, y: 130 });
});

test('the panel is kept inside the table at the sides', () => {
  assert.equal(infoPlacement({ x: 0, y: 300, width: 80, height: 112 }, { width: 200, height: 60 }, { width: 400, height: 600 }).x, 8);
  assert.equal(infoPlacement({ x: 360, y: 300, width: 40, height: 56 }, { width: 200, height: 60 }, { width: 400, height: 600 }).x, 192);
});

test('effect text names lands by symbol, never by word (the title aside)', () => {
  for (const info of Object.values(CARD_INFO)) {
    for (const line of info.lines) assert.doesNotMatch(line, /\b(Forest|Island|Mountain|Plains|Swamp)s?\b/, line);
  }
  assert.match(CARD_INFO.island.lines.join(' '), /discard this \{island\}/);
  assert.deepEqual(CARD_INFO.plains.lines, ['When played: draw a card.']);
});
