// The computer opponent as a real peer: two bots play full matches through
// real coordinators over the in-memory transport, and a match resumes from
// both seats' snapshots as it does after a reload.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runBot } from '../../src/bot/bot.ts';
import { MatchCoordinator } from '../../src/match/coordinator.ts';
import type { Snapshot } from '../../src/match/coordinator.ts';
import { verifyChain } from '../../src/match/log.ts';
import type { Message } from '../../src/match/protocol.ts';
import { DEFAULT_PRIME } from '../../src/match/sra.ts';
import { createMemoryPair } from '../../src/transport/memory.ts';
import type { Seat } from '../../src/engine/types.ts';

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

/** Wait until `done()` holds, giving timers and messages a turn each time. */
async function until(done: () => boolean, what: string, limitMs = 20_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

type Pair = [MatchCoordinator, MatchCoordinator];

function startBots(seed: number): { coordinators: Pair; stops: Array<() => void> } {
  const [t0, t1] = createMemoryPair<Message>();
  const coordinators: Pair = [
    new MatchCoordinator({ seat: 0, prime: DEFAULT_PRIME, transport: t0 }),
    new MatchCoordinator({ seat: 1, prime: DEFAULT_PRIME, transport: t1 }),
  ];
  for (const c of coordinators) c.start();
  const stops = coordinators.map((c) => runBot(c, { thinkMs: 0, rand: mulberry32(seed * 2 + c.seat) }));
  return { coordinators, stops };
}

const over = (coordinators: Pair) => (): boolean => coordinators.every((c) => c.status === 'over');

test('two bots play full matches to an agreed, audited win', async () => {
  for (let seed = 1; seed <= 4; seed++) {
    const { coordinators } = startBots(seed);
    await until(over(coordinators), `match ${seed} to finish`);
    const [c0, c1] = coordinators;
    assert.equal(c0.outcome?.kind, 'win', `seed ${seed}: ${JSON.stringify(c0.outcome)}`);
    assert.deepEqual(c0.outcome, c1.outcome);
    assert.equal(c0.log.at(-1)!.hash, c1.log.at(-1)!.hash);
    assert.ok(verifyChain(c0.log));
    assert.ok(!c0.log.some((e) => e.action.type === 'resign'), 'bots never resign');
  }
});

test('a bot match resumes from both snapshots and finishes', async () => {
  const { coordinators, stops } = startBots(7);
  await until(() => coordinators[0].log.length > 25, 'some moves');
  for (const stop of stops) stop();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const saved = coordinators.map((c) => c.snapshot()!) as [Snapshot, Snapshot];
  for (const c of coordinators) c.close();

  const [t0, t1] = createMemoryPair<Message>();
  const resumed: Pair = [MatchCoordinator.resume(saved[0], t0), MatchCoordinator.resume(saved[1], t1)];
  resumed.forEach((c) => runBot(c, { thinkMs: 0, rand: mulberry32(70 + c.seat) }));
  await until(over(resumed), 'the resumed match to finish');
  assert.equal(resumed[0].outcome?.kind, 'win');
  assert.deepEqual(resumed[0].outcome, resumed[1].outcome);
});

test('the bot waits while the board is busy, then moves', async () => {
  const [t0, t1] = createMemoryPair<Message>();
  const coordinators: Pair = [
    new MatchCoordinator({ seat: 0, prime: DEFAULT_PRIME, transport: t0 }),
    new MatchCoordinator({ seat: 1, prime: DEFAULT_PRIME, transport: t1 }),
  ];
  for (const c of coordinators) c.start();
  await until(() => coordinators.every((c) => c.status === 'playing'), 'setup');
  const first = coordinators[0].state!.activeSeat as Seat;
  let busy = true;
  runBot(coordinators[first], { thinkMs: 0, busy: () => busy });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(coordinators[first].log.length, 1, 'no move while busy');
  busy = false;
  await until(() => coordinators[first].log.length > 1, 'the first move');
});

test('a hard bot plays a full match against a normal one', async () => {
  const [t0, t1] = createMemoryPair<Message>();
  const coordinators: Pair = [
    new MatchCoordinator({ seat: 0, prime: DEFAULT_PRIME, transport: t0 }),
    new MatchCoordinator({ seat: 1, prime: DEFAULT_PRIME, transport: t1 }),
  ];
  for (const c of coordinators) c.start();
  runBot(coordinators[0], { thinkMs: 0, level: 'hard', rand: mulberry32(21) });
  runBot(coordinators[1], { thinkMs: 0, level: 'normal', rand: mulberry32(22) });
  await until(over(coordinators), 'the hard match to finish', 60_000);
  assert.equal(coordinators[0].outcome?.kind, 'win', JSON.stringify(coordinators[0].outcome));
  assert.deepEqual(coordinators[0].outcome, coordinators[1].outcome);
});
