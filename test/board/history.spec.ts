// Match history: the log replayed into plain-words lines, from each seat.

import test from 'node:test';
import assert from 'node:assert/strict';

import { matchHistory } from '../../src/board/history.ts';
import type { HistoryStep, HistoryTurn } from '../../src/board/history.ts';
import { MatchCoordinator } from '../../src/match/coordinator.ts';
import type { Message } from '../../src/match/protocol.ts';
import { DEFAULT_PRIME } from '../../src/match/sra.ts';
import { createMemoryPair } from '../../src/transport/memory.ts';
import type { CardId, Land, Seat } from '../../src/engine/types.ts';

const start: HistoryStep = { seat: 0, action: { type: 'start', first: 0, decks: [[], []], openingKeys: [[], []] } };
const reveal = (card: CardId, land: Land) => ({ card, land });

/** Seat 0 plays Island (which ends its turn); seat 1 Mountains it, seat 0 counters, it is countered. */
const LOG: HistoryStep[] = [
  start,
  { seat: 0, action: { type: 'play', reveal: reveal('p0-slot-00', 'island') } },
  { seat: 1, action: { type: 'allow' } },
  { seat: 0, action: { type: 'grantDrawKey', card: 'p1-slot-05', key: '0' } },
  { seat: 1, action: { type: 'play', reveal: reveal('p1-slot-00', 'mountain'), declaredTarget: 'p0-slot-00' } },
  { seat: 0, action: { type: 'counter', island: reveal('p0-slot-01', 'island'), other: reveal('p0-slot-02', 'forest') } },
  { seat: 1, action: { type: 'allow' } },
];

const text = (turns: HistoryTurn[]): string[] => turns.flatMap((t) => t.lines.map((l) => `${t.turn}: ${l.text}`));

test('the history reads from the viewer seat, naming only its own draws', () => {
  const known = (id: CardId): Land | null => (id === 'p0-slot-05' ? 'swamp' : null);
  assert.deepEqual(text(matchHistory(LOG, 0, known)), [
    '1: You played {island}.',
    '1: They let it resolve.',
    '1: Your {island} entered play.',
    '2: They drew a card.',
    '2: They played {mountain}, aiming at your {island}.',
    '2: You countered with {island} + {forest}.',
    '2: They let it resolve.',
    '2: Their {mountain} was countered.',
    '3: You drew {swamp}.',
  ]);
  assert.deepEqual(text(matchHistory(LOG, 1, () => 'plains')), [
    '1: They played {island}.',
    '1: You let it resolve.',
    '1: Their {island} entered play.',
    '2: You drew {plains}.',
    '2: You played {mountain}, aiming at their {island}.',
    '2: They countered with {island} + {forest}.',
    '2: You let it resolve.',
    '2: Your {mountain} was countered.',
    '3: They drew a card.',
  ]);
});

test('turns are grouped under whose turn it was', () => {
  const turns = matchHistory(LOG, 0);
  assert.deepEqual(
    turns.map((t) => [t.turn, t.seat]),
    [
      [1, 0],
      [2, 1],
      [3, 0],
    ],
  );
});

test('no start record, no history', () => {
  assert.deepEqual(matchHistory([], 0), []);
});

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('random full matches: both seats get a line per action, and never see the other side draw a named card', async () => {
  for (const seed of [3, 11, 29]) {
    const [t0, t1] = createMemoryPair<Message>();
    let x = seed;
    const rand = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => (x = (x * 1103515245 + 12345) >>> 0) >>> 24);
    const cs = [0, 1].map((seat) => new MatchCoordinator({ seat: seat as Seat, prime: DEFAULT_PRIME, transport: seat === 0 ? t0 : t1, rand })) as [MatchCoordinator, MatchCoordinator];
    for (const c of cs) c.start();
    await settle();
    let pick = seed;
    for (let n = 0; n < 3000 && cs.every((c) => c.status === 'playing'); n++) {
      const actor = cs.find((c) => c.legalActions().length > 0)!;
      const options = actor.legalActions();
      pick = (pick * 69069 + 1) >>> 0;
      actor.submit(options[pick % options.length]!);
      await settle();
    }
    const histories = cs.map((c) => matchHistory(c.log, c.seat, (id) => c.privateHand.get(id) ?? null));
    const plays = cs[0].log.filter((e) => e.action.type === 'play').length;
    for (const [seat, turns] of histories.entries()) {
      const lines = turns.flatMap((t) => t.lines.map((l) => l.text));
      assert.equal(lines.filter((l) => / played /.test(l)).length, plays, `seed ${seed} seat ${seat}: one line per play`);
      for (const l of lines.filter((l) => l.startsWith('They drew'))) assert.equal(l, 'They drew a card.');
      assert.match(lines.at(-1)!, /win by|resigned/, `seed ${seed} seat ${seat}: ends with the result`);
      assert.ok(turns.every((t, i) => i === 0 || t.turn > turns[i - 1]!.turn), 'turns in order');
    }
    assert.equal(histories[0]!.flatMap((t) => t.lines).length, histories[1]!.flatMap((t) => t.lines).length, 'both seats tell the same story');
  }
});
