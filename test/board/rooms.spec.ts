// Room codes: making and reading them, linking two players through a courier
// room (fresh and reconnecting), a full room, a partner who leaves early, and
// the matching code both ends show.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SYMBOLS, freshRoom, linkByRoom, matchRoom, matchingCode, newRoomCode, parseRoomCode } from '../../src/board/rooms.ts';
import type { Courier, CourierRoom } from '../../src/board/rooms.ts';
import { WebRtcTransport } from '../../src/transport/webrtc.ts';
import { fakeFactory } from '../transport/fake-webrtc.ts';
import { until } from '../transport/helpers.ts';

const options = { createPeerConnection: fakeFactory, gatherTimeoutMs: 50 };

/** An in-memory courier: rooms keyed by name and password, every note recorded. */
function fakeCourier(): { courier: Courier; notes: string[]; members: (room: string) => number } {
  const rooms = new Map<string, Map<string, CourierRoom>>();
  const notes: string[] = [];
  let next = 0;
  const courier: Courier = (id, password) => {
    const key = `${id}|${password}`;
    const members = rooms.get(key) ?? new Map<string, CourierRoom>();
    rooms.set(key, members);
    const self = `peer-${next++}`;
    const handle: CourierRoom = {
      onPeerJoin: null,
      onPeerLeave: null,
      onMessage: null,
      send: (text, to) => {
        notes.push(text);
        queueMicrotask(() => members.get(to)?.onMessage?.(text, self));
      },
      leave: () => {
        if (!members.delete(self)) return;
        for (const member of members.values()) queueMicrotask(() => member.onPeerLeave?.(self));
      },
    };
    // Both sides hear of each other once, after the caller has set its handlers, as with Trystero.
    const already = [...members];
    queueMicrotask(() => {
      for (const [peer, member] of already) {
        if (!members.has(peer) || !members.has(self)) continue;
        member.onPeerJoin?.(self);
        handle.onPeerJoin?.(peer);
      }
    });
    members.set(self, handle);
    return handle;
  };
  return { courier, notes, members: (id) => [...rooms].filter(([key]) => key.startsWith(`${id}|`)).reduce((n, [, m]) => n + m.size, 0) };
}

test('room codes are four easy letters and digits, and typed codes are tidied', () => {
  for (let i = 0; i < 50; i++) assert.match(newRoomCode(), /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/);
  assert.equal(newRoomCode(() => new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])), 'ABCD');
  // Bytes past the last whole run of the alphabet are skipped, not wrapped (no bias).
  assert.equal(newRoomCode(() => new Uint8Array([255, 254, 253, 248, 30, 30, 30, 30])), '9999');
  assert.equal(parseRoomCode(' k7qx '), 'K7QX');
  assert.equal(parseRoomCode('k7-qx'), 'K7QX');
  assert.equal(parseRoomCode('K0QX'), null, 'no zero: it reads as an O');
  assert.equal(parseRoomCode('K7Q'), null);
  assert.equal(parseRoomCode('K7QXY'), null);
});

test('two players link up through a room, and both leave it', async () => {
  const { courier, notes, members } = fakeCourier();
  const room = freshRoom('K7QX');
  const inviter = linkByRoom(courier, room, 'inviter', options);
  const joiner = linkByRoom(courier, room, 'joiner', options);
  const [a, b] = await Promise.all([inviter.link, joiner.link]);
  assert.deepEqual([a.seat, b.seat], [0, 1]);
  const got: unknown[] = [];
  b.onMessage((m) => got.push(m));
  a.send({ hello: 1 } as never);
  await until(() => got.length === 1);
  assert.deepEqual(got, [{ hello: 1 }]);
  await until(() => members(room.id) === 0);
  // The courier carried just an invite and a reply.
  assert.deepEqual(notes.map((n) => (JSON.parse(n) as { t: string }).t), ['invite', 'reply']);
});

test('the joiner may arrive first', async () => {
  const { courier } = fakeCourier();
  const room = freshRoom('ABCD');
  const joiner = linkByRoom(courier, room, 'joiner', options);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const inviter = linkByRoom(courier, room, 'inviter', options);
  const [a, b] = await Promise.all([inviter.link, joiner.link]);
  assert.deepEqual([a.seat, b.seat], [0, 1]);
});

test('a third player is told the room is full', async () => {
  const { courier } = fakeCourier();
  const room = freshRoom('FULL');
  const inviter = linkByRoom(courier, room, 'inviter', options);
  const first = linkByRoom(courier, room, 'joiner', options);
  const second = linkByRoom(courier, room, 'joiner', options);
  const settled = await Promise.allSettled([first.link, second.link]);
  const refused = settled.filter((s) => s.status === 'rejected');
  assert.equal(refused.length, 1);
  assert.match(String((refused[0] as PromiseRejectedResult).reason), /already has two players/);
  assert.equal((await inviter.link).seat, 0);
});

test('a joiner who leaves before replying frees the room for the next', async () => {
  const { courier } = fakeCourier();
  const room = freshRoom('BACK');
  const inviter = linkByRoom(courier, room, 'inviter', options);
  // A peer that never answers the invite, then goes.
  const silent = courier(room.id, room.password);
  await new Promise((resolve) => setTimeout(resolve, 20));
  silent.leave();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const joiner = linkByRoom(courier, room, 'joiner', options);
  const [a, b] = await Promise.all([inviter.link, joiner.link]);
  assert.deepEqual([a.seat, b.seat], [0, 1]);
});

test('to reconnect, both seats meet in the match room and keep their seats', async () => {
  const { courier } = fakeCourier();
  const match = 'f'.repeat(64);
  const room = matchRoom(match);
  assert.notEqual(room.id, freshRoom(match.slice(0, 4)).id);
  const seat0 = linkByRoom(courier, room, 'inviter', { ...options, reconnect: { match, seat: 0 } });
  const seat1 = linkByRoom(courier, room, 'joiner', { ...options, reconnect: { match, seat: 1 } });
  const [a, b] = await Promise.all([seat0.link, seat1.link]);
  assert.deepEqual([a.seat, b.seat], [0, 1]);
});

test('cancelling leaves the room and never resolves', async () => {
  const { courier, members } = fakeCourier();
  const room = freshRoom('GONE');
  const attempt = linkByRoom(courier, room, 'inviter', options);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(members(room.id), 1);
  attempt.cancel();
  assert.equal(members(room.id), 0);
});

test('both ends of a link show the same matching code; another pair of fingerprints does not', async () => {
  assert.equal(new Set(SYMBOLS).size, 64);
  const { courier } = fakeCourier();
  const room = freshRoom('SAME');
  const [a, b] = await Promise.all([linkByRoom(courier, room, 'inviter', options).link, linkByRoom(courier, room, 'joiner', options).link]);
  assert.ok(a instanceof WebRtcTransport && b instanceof WebRtcTransport);
  assert.ok(a.session !== null && b.session !== null);
  assert.equal(matchingCode(a.session.offer, a.session.answer), matchingCode(b.session.offer, b.session.answer));

  const sdp = (fp: string): string => `v=0\r\na=fingerprint:sha-256 ${fp}\r\n`;
  const offer = sdp('AA:BB:CC');
  const code = matchingCode(offer, sdp('11:22:33'));
  assert.equal(code.split(' ').length, 4);
  assert.ok(code.split(' ').every((s) => (SYMBOLS as readonly string[]).includes(s)));
  assert.equal(matchingCode(sdp('aa:bb:cc'), sdp('11:22:33')), code, 'fingerprint case does not matter');
  // Someone relaying their own answer in place of the real one changes the code.
  assert.notEqual(matchingCode(offer, sdp('11:22:34')), code);
  assert.notEqual(matchingCode(sdp('11:22:33'), sdp('AA:BB:CC')), code, 'offer and answer are not interchangeable');
});
