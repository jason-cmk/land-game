// Signalling codes, the WebRTC transport against a fake RTCPeerConnection, and
// a full match played over it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SignalError, decodeSignal, encodeSignal } from '../../src/transport/signal.ts';
import { createInvite, joinInvite } from '../../src/transport/webrtc.ts';
import type { WebRtcTransport } from '../../src/transport/webrtc.ts';
import { MatchCoordinator } from '../../src/match/coordinator.ts';
import type { Message } from '../../src/match/protocol.ts';
import { DEFAULT_PRIME } from '../../src/match/sra.ts';
import { FakePeerConnection, fakeFactory } from './fake-webrtc.ts';
import { playToEnd, until } from './helpers.ts';

const options = { createPeerConnection: fakeFactory };

/** A connected inviter/joiner pair, plus the fake connection behind each end. */
async function linkedPair<M, P>(): Promise<[WebRtcTransport<M, P>, WebRtcTransport<M, P>, FakePeerConnection, FakePeerConnection]> {
  const made: FakePeerConnection[] = [];
  const recording = { createPeerConnection: () => (made.push(new FakePeerConnection()), made.at(-1)!) };
  const invite = await createInvite<M, P>(recording);
  const join = await joinInvite<M, P>(invite.code, recording);
  const inviter = await invite.accept(join.code);
  return [inviter, await join.transport, made[0]!, made[1]!];
}

// ---------------------------------------------------------------------------
// Signalling codes
// ---------------------------------------------------------------------------

test('signal codes round-trip, are compact, and survive line wrapping', async () => {
  const sdp = `v=0\r\n${'a=candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host\r\n'.repeat(15)}`;
  const code = await encodeSignal({ type: 'offer', sdp });
  assert.match(code, /^LG1\.[A-Za-z0-9_-]+$/);
  assert.ok(code.length < sdp.length / 2, `code (${code.length}) should be well under the SDP (${sdp.length})`);
  const wrapped = code.replace(/(.{40})/g, '$1\n  ');
  assert.deepEqual(await decodeSignal(wrapped, 'offer'), { type: 'offer', sdp });
});

test('signal codes reject the wrong kind, foreign text and damage', async () => {
  const offer = await encodeSignal({ type: 'offer', sdp: 'v=0' });
  await assert.rejects(decodeSignal(offer, 'answer'), (err: unknown) => err instanceof SignalError && /invite code/.test(err.message));
  await assert.rejects(decodeSignal('hello there', 'offer'), /not a Land Game code/);
  await assert.rejects(decodeSignal(`${offer.slice(0, -6)}AAAAAA`, 'offer'), /damaged/);
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

test('invite, reply and accept open both channels; game messages arrive in order', async () => {
  const [a, b] = await linkedPair<{ n: number }, { x: number }>();
  assert.equal(a.seat, 0);
  assert.equal(b.seat, 1);

  const got: number[] = [];
  b.onMessage((m) => got.push(m.n));
  for (let n = 0; n < 20; n++) a.send({ n });
  const presence: number[] = [];
  a.onPresence((p) => presence.push(p.x));
  b.sendPresence({ x: 0.5 });
  await until(() => got.length === 20 && presence.length === 1);
  assert.deepEqual(got, [...Array(20).keys()]);
  assert.deepEqual(presence, [0.5]);
  a.close();
});

test('pasting the invite code back as the reply is refused', async () => {
  const invite = await createInvite(options);
  await assert.rejects(invite.accept(invite.code), /invite code/);
  invite.cancel();
});

test('a code is produced even if ICE gathering never completes', async () => {
  const invite = await createInvite({ createPeerConnection: () => new FakePeerConnection(false), gatherTimeoutMs: 10 });
  assert.match(invite.code, /^LG1\./);
  invite.cancel();
});

test('without RTCPeerConnection (e.g. Node) createInvite fails clearly', async () => {
  await assert.rejects(createInvite(), /WebRTC is not available/);
});

test('closing one end closes the other; a failed network closes both', async () => {
  const [a, b] = await linkedPair();
  const statuses: string[] = [];
  b.onStatus((s) => statuses.push(s));
  a.close();
  await until(() => statuses.includes('closed'));
  assert.ok(statuses.includes('disconnected') || statuses.includes('closed'));

  const [c, d, pcC] = await linkedPair();
  const closed: string[] = [];
  c.onStatus((s) => s === 'closed' && closed.push('c'));
  d.onStatus((s) => s === 'closed' && closed.push('d'));
  pcC.dropNetwork();
  await until(() => closed.length === 2);
});

test('peer data that is not JSON text is dropped, not delivered', async () => {
  const [a, b, pcA] = await linkedPair<{ ok: boolean }, never>();
  const got: unknown[] = [];
  b.onMessage((m) => got.push(m));
  const wire = pcA.channels.get(0) as unknown as { inject(data: unknown): void };
  wire.inject('{not json');
  wire.inject(new Uint8Array([1, 2, 3]));
  a.send({ ok: true });
  await until(() => got.length === 1);
  assert.deepEqual(got, [{ ok: true }]);
  a.close();
});

test('two coordinators play a full match over the WebRTC transport', async () => {
  const [a, b] = await linkedPair<Message, never>();
  const c0 = new MatchCoordinator({ seat: 0, prime: DEFAULT_PRIME, transport: a });
  const c1 = new MatchCoordinator({ seat: 1, prime: DEFAULT_PRIME, transport: b });
  c0.start();
  c1.start();
  await playToEnd(c0, c1);
  assert.equal(c0.outcome?.kind, 'win');
  assert.deepEqual(c0.outcome, c1.outcome);
  assert.equal(c0.log.at(-1)!.hash, c1.log.at(-1)!.hash);
  a.close();
});
