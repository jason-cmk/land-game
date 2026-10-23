// BroadcastChannel transport, on Node's real BroadcastChannel (same-process
// channels with the same name reach each other, like two tabs).

import test from 'node:test';
import assert from 'node:assert/strict';

import { BroadcastTransport, connectBroadcast } from '../../src/transport/broadcast.ts';
import { MatchCoordinator } from '../../src/match/coordinator.ts';
import type { Message } from '../../src/match/protocol.ts';
import { DEFAULT_PRIME } from '../../src/match/sra.ts';
import { playToEnd, until } from './helpers.ts';

let room = 0;
const freshRoom = (): string => `test-${process.pid}-${room++}`;

test('the second tab to arrive still connects, and both channels flow', async () => {
  const name = freshRoom();
  const first = connectBroadcast<{ n: number }, { x: number }>(name, 0);
  await new Promise((resolve) => setTimeout(resolve, 20)); // seat 0's hello goes unheard
  const [a, b] = await Promise.all([first, connectBroadcast<{ n: number }, { x: number }>(name, 1)]);

  const got: number[] = [];
  b.onMessage((m) => got.push(m.n));
  for (let n = 0; n < 10; n++) a.send({ n });
  const presence: number[] = [];
  a.onPresence((p) => presence.push(p.x));
  b.sendPresence({ x: 0.25 });
  await until(() => got.length === 10 && presence.length === 1);
  assert.deepEqual(got, [...Array(10).keys()]);
  assert.deepEqual(presence, [0.25]);
  a.close();
  b.close();
});

test('closing one tab closes the other', async () => {
  const name = freshRoom();
  const [a, b] = await Promise.all([connectBroadcast(name, 0), connectBroadcast(name, 1)]);
  const statuses: string[] = [];
  b.onStatus((s) => statuses.push(s));
  a.close();
  await until(() => statuses.includes('closed'));
});

test('a tab that reloads without saying goodbye can rejoin', async () => {
  const name = freshRoom();
  const [a, b] = await Promise.all([connectBroadcast<{ n: number }, never>(name, 0), connectBroadcast<{ n: number }, never>(name, 1)]);
  (b as unknown as { channel: BroadcastChannel }).channel.close(); // the tab vanished: no bye

  const reloaded = await connectBroadcast<{ n: number }, never>(name, 1);
  const got: number[] = [];
  reloaded.onMessage((m) => got.push(m.n));
  a.send({ n: 7 });
  await until(() => got.length === 1);
  assert.deepEqual(got, [7]);
  a.close();
  reloaded.close();
});

test('two coordinators play a full match across two "tabs"', async () => {
  const name = freshRoom();
  const [a, b] = await Promise.all([connectBroadcast<Message, never>(name, 0), connectBroadcast<Message, never>(name, 1)]);
  assert.ok(a instanceof BroadcastTransport);
  const c0 = new MatchCoordinator({ seat: 0, prime: DEFAULT_PRIME, transport: a });
  const c1 = new MatchCoordinator({ seat: 1, prime: DEFAULT_PRIME, transport: b });
  c0.start();
  c1.start();
  await playToEnd(c0, c1);
  assert.equal(c0.outcome?.kind, 'win');
  assert.deepEqual(c0.outcome, c1.outcome);
  a.close();
  b.close();
});
