// Two coordinators wired over the in-memory transport: setup, full random
// games in lockstep, the failure policy (void on desync, forfeit on failed
// verification), and reconnect by log replay.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MatchCoordinator } from '../../src/match/coordinator.ts';
import type { Snapshot } from '../../src/match/coordinator.ts';
import type { Message } from '../../src/match/protocol.ts';
import { verifyChain, stateHashOf } from '../../src/match/log.ts';
import { DEFAULT_PRIME, generatePrime } from '../../src/match/sra.ts';
import type { RandomBytes } from '../../src/match/sra.ts';
import { createMemoryPair } from '../../src/transport/memory.ts';
import type { Transport } from '../../src/transport/types.ts';
import { IllegalActionError } from '../../src/engine/types.ts';
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

function seededRandomBytes(seed: number): RandomBytes {
  const next = mulberry32(seed);
  return (n) => {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = Math.floor(next() * 256);
    return bytes;
  };
}

const PRIME = DEFAULT_PRIME;

/** Let every queued message (and the replies it triggers) be delivered. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Rewrite (or drop, by returning null) messages a transport end sends. */
function tamper(transport: Transport<Message>, edit: (m: Message) => Message | null): Transport<Message> {
  return {
    send: (m) => {
      const edited = edit(m);
      if (edited !== null) transport.send(edited);
    },
    onMessage: (listener) => transport.onMessage(listener),
    close: () => transport.close(),
  };
}

interface Match {
  coordinators: [MatchCoordinator, MatchCoordinator];
  snapshots: [Snapshot | null, Snapshot | null];
  transports: [Transport<Message>, Transport<Message>];
}

async function startMatch(seed: number, wrap: (seat: Seat, t: Transport<Message>) => Transport<Message> = (_, t) => t): Promise<Match> {
  const [t0, t1] = createMemoryPair<Message>();
  const snapshots: Match['snapshots'] = [null, null];
  const make = (seat: Seat, transport: Transport<Message>): MatchCoordinator =>
    new MatchCoordinator({
      seat,
      prime: PRIME,
      transport: wrap(seat, transport),
      rand: seededRandomBytes(seed * 10 + seat),
      persist: (s) => (snapshots[seat] = s),
    });
  const coordinators: Match['coordinators'] = [make(0, t0), make(1, t1)];
  coordinators[0].start();
  coordinators[1].start();
  await settle();
  return { coordinators, snapshots, transports: [t0, t1] };
}

function assertLockstep([c0, c1]: readonly [MatchCoordinator, MatchCoordinator]): void {
  assert.equal(c0.log.length, c1.log.length);
  assert.equal(c0.log.at(-1)!.hash, c1.log.at(-1)!.hash);
  assert.equal(stateHashOf(c0.state), stateHashOf(c1.state));
}

/** Play random legal moves until the match leaves 'playing' or maxActions is reached. */
async function playRandomly(coordinators: readonly [MatchCoordinator, MatchCoordinator], rng: () => number, maxActions = 5000): Promise<number> {
  let actions = 0;
  while (actions < maxActions && coordinators.every((c) => c.status === 'playing')) {
    const actor = coordinators.find((c) => c.legalActions().length > 0);
    assert.ok(actor, 'somebody must be able to act while playing');
    const options = actor.legalActions();
    actor.submit(options[Math.floor(rng() * options.length)]!);
    actions++;
    await settle();
    // A void or forfeit stops the honest side mid-action, so the logs legitimately differ.
    if (coordinators.every((c) => c.outcome === null || c.outcome.kind === 'win')) assertLockstep(coordinators);
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

test('setup: both seats agree on entry 0 and privately know their own opening hand', async () => {
  const { coordinators } = await startMatch(1);
  const [c0, c1] = coordinators;
  assert.equal(c0.status, 'playing');
  assert.equal(c1.status, 'playing');
  assertLockstep(coordinators);
  assert.equal(c0.log.length, 1);
  assert.equal(c0.log[0]!.action.type, 'start');

  for (const c of coordinators) {
    const hand = c.state!.players[c.seat].hand;
    assert.equal(hand.length, 5);
    assert.ok(hand.every((s) => s.land === null), 'the shared state keeps hands hidden');
    assert.deepEqual([...c.privateHand.keys()].sort(), hand.map((s) => s.id).sort());
  }
});

test('setup: the coin flip is not always the same seat', async () => {
  const firsts = new Set<Seat>();
  for (let seed = 1; seed <= 8; seed++) {
    const { coordinators } = await startMatch(seed);
    firsts.add(coordinators[0].state!.activeSeat);
  }
  assert.equal(firsts.size, 2);
});

// ---------------------------------------------------------------------------
// Full games
// ---------------------------------------------------------------------------

test('random full games stay in lockstep and finish with an agreed, audited result', async () => {
  for (let seed = 1; seed <= 6; seed++) {
    const { coordinators } = await startMatch(seed);
    await playRandomly(coordinators, mulberry32(seed));
    const [c0, c1] = coordinators;
    assert.equal(c0.status, 'over', `seed ${seed}: match finished`);
    assert.equal(c0.outcome?.kind, 'win');
    assert.deepEqual(c0.outcome, c1.outcome);
    assert.ok(verifyChain(c0.log));
  }
});

test('resign ends the match and still runs the audit', async () => {
  const { coordinators } = await startMatch(2);
  const mover = coordinators.find((c) => c.legalActions().length > 0)!;
  mover.submit({ type: 'resign' });
  await settle();
  for (const c of coordinators) {
    assert.deepEqual(c.outcome, { kind: 'win', winner: 1 - mover.seat, reason: 'resign' });
  }
});

test('an illegal local submit throws and sends nothing', async () => {
  const { coordinators } = await startMatch(3);
  const waiting = coordinators.find((c) => c.legalActions().length === 0)!;
  const before = waiting.log.length;
  assert.throws(() => waiting.submit({ type: 'pass' }), IllegalActionError);
  await settle();
  assert.equal(waiting.log.length, before);
  assertLockstep(coordinators);
});

// ---------------------------------------------------------------------------
// Failure policy
// ---------------------------------------------------------------------------

test('a head hash mismatch voids the match on both sides', async () => {
  let armed = false;
  const { coordinators } = await startMatch(4, (seat, t) =>
    seat === 1 ? tamper(t, (m) => (armed && m.t === 'action' ? { ...m, headHash: '0'.repeat(64) } : m)) : t,
  );
  armed = true;
  await playRandomly(coordinators, mulberry32(4), 50);
  for (const c of coordinators) assert.equal(c.outcome?.kind, 'void');
  assert.match((coordinators[0].outcome as { detail: string }).detail, /out of sync/);
});

test('a lying reveal (wrong land for the key) forfeits the liar', async () => {
  const { coordinators } = await startMatch(5, (seat, t) =>
    seat === 1
      ? tamper(t, (m) => {
          if (m.t !== 'action' || m.action.type !== 'play' || m.action.reveal.ownerKey === undefined) return m;
          const lie = m.action.reveal.land === 'island' ? 'forest' : 'island';
          return { ...m, action: { ...m.action, reveal: { ...m.action.reveal, land: lie } } };
        })
      : t,
  );
  await playRandomly(coordinators, mulberry32(5), 300);
  const [c0, c1] = coordinators;
  assert.equal(c0.outcome?.kind, 'forfeit');
  assert.equal((c0.outcome as { winner: Seat }).winner, 0);
  assert.match((c0.outcome as { detail: string }).detail, /verification failed: .*reveal proof/);
  assert.equal(c1.outcome?.kind, 'void', 'the liar only hears that the peer ended the match');
});

test('a bad draw key forfeits the granter', async () => {
  const { coordinators } = await startMatch(6, (seat, t) =>
    seat === 1 ? tamper(t, (m) => (m.t === 'action' && m.action.type === 'grantDrawKey' ? { ...m, action: { ...m.action, key: '3' } } : m)) : t,
  );
  await playRandomly(coordinators, mulberry32(6), 300);
  assert.deepEqual(
    { kind: coordinators[0].outcome?.kind, winner: (coordinators[0].outcome as { winner?: Seat }).winner },
    { kind: 'forfeit', winner: 0 },
  );
});

test('a bad opening-hand key is caught during setup', async () => {
  const { coordinators } = await startMatch(7, (seat, t) =>
    seat === 1 ? tamper(t, (m) => (m.t === 'openingKeys' ? { ...m, keys: ['5', ...m.keys.slice(1)] } : m)) : t,
  );
  assert.equal(coordinators[0].outcome?.kind, 'forfeit');
  assert.match((coordinators[0].outcome as { detail: string }).detail, /does not unlock a valid card/);
});

test('a duplicated card in a shuffle step is rejected', async () => {
  const { coordinators } = await startMatch(8, (seat, t) =>
    seat === 1 ? tamper(t, (m) => (m.t === 'shuffleStep' && m.step === 'A' ? { ...m, cards: [m.cards[1]!, ...m.cards.slice(1)] } : m)) : t,
  );
  assert.equal(coordinators[0].outcome?.kind, 'forfeit');
  assert.match((coordinators[0].outcome as { detail: string }).detail, /duplicate/);
});

test('an action the engine rejects forfeits the sender', async () => {
  const { coordinators } = await startMatch(9, (seat, t) =>
    seat === 1 ? tamper(t, (m) => (m.t === 'action' && m.action.type === 'pass' ? { ...m, action: { type: 'allow' } } : m)) : t,
  );
  await playRandomly(coordinators, mulberry32(9), 500);
  assert.equal(coordinators[0].outcome?.kind, 'forfeit');
});

test('a failed audit overrides the declared winner', async () => {
  const { coordinators } = await startMatch(10, (seat, t) =>
    seat === 1 ? tamper(t, (m) => (m.t === 'audit' ? { ...m, ownDeck: ['7', ...m.ownDeck.slice(1)] } : m)) : t,
  );
  await playRandomly(coordinators, mulberry32(10));
  const [c0] = coordinators;
  assert.equal(c0.state!.phase, 'over');
  assert.equal(c0.outcome?.kind, 'forfeit');
  assert.equal((c0.outcome as { winner: Seat }).winner, 0);
  assert.match((c0.outcome as { detail: string }).detail, /deck audit failed/);
});

// ---------------------------------------------------------------------------
// Reconnect
// ---------------------------------------------------------------------------

async function resumeBoth(match: Match): Promise<[MatchCoordinator, MatchCoordinator]> {
  for (const c of match.coordinators) c.close();
  const [t0, t1] = createMemoryPair<Message>();
  const resumed: [MatchCoordinator, MatchCoordinator] = [
    MatchCoordinator.resume(match.snapshots[0]!, t0, { rand: seededRandomBytes(90), persist: (s) => (match.snapshots[0] = s) }),
    MatchCoordinator.resume(match.snapshots[1]!, t1, { rand: seededRandomBytes(91), persist: (s) => (match.snapshots[1] = s) }),
  ];
  await settle();
  return resumed;
}

test('both seats reload from snapshots mid-game and finish the match', async () => {
  const match = await startMatch(11);
  const rng = mulberry32(11);
  await playRandomly(match.coordinators, rng, 40);
  const resumed = await resumeBoth(match);
  assertLockstep(resumed);
  assert.deepEqual(resumed[0].privateHand, match.coordinators[0].privateHand);
  await playRandomly(resumed, rng);
  assert.equal(resumed[0].outcome?.kind, 'win');
  assert.deepEqual(resumed[0].outcome, resumed[1].outcome);
});

test('an action lost in flight is resent after reconnect', async () => {
  const match = await startMatch(12);
  const rng = mulberry32(12);
  await playRandomly(match.coordinators, rng, 25);
  const actor = match.coordinators.find((c) => c.legalActions().length > 0)!;
  const options = actor.legalActions();
  actor.submit(options[Math.floor(rng() * options.length)]!);
  match.transports[0].close(); // before delivery: the peer never sees it
  await settle();
  assert.equal(Math.abs(match.coordinators[0].log.length - match.coordinators[1].log.length), 1);

  const resumed = await resumeBoth(match);
  assertLockstep(resumed);
  await playRandomly(resumed, rng);
  assert.equal(resumed[0].outcome?.kind, 'win');
  assert.deepEqual(resumed[0].outcome, resumed[1].outcome);
});

test('a live coordinator reconnects over a new transport without reloading', async () => {
  const match = await startMatch(13);
  const rng = mulberry32(13);
  await playRandomly(match.coordinators, rng, 30);
  match.transports[0].close();
  const [t0, t1] = createMemoryPair<Message>();
  match.coordinators[0].reconnect(t0);
  match.coordinators[1].reconnect(t1);
  await settle();
  assertLockstep(match.coordinators);
  await playRandomly(match.coordinators, rng);
  assert.equal(match.coordinators[0].outcome?.kind, 'win');
});

test('a peer that drops mid-audit can still finish after reconnecting', async () => {
  let dropAudit = true;
  const match = await startMatch(14, (seat, t) => (seat === 1 ? tamper(t, (m) => (dropAudit && m.t === 'audit' ? null : m)) : t));
  await playRandomly(match.coordinators, mulberry32(14));
  const [c0, c1] = match.coordinators;
  assert.equal(c0.status, 'auditing', 'seat 0 never got the audit');
  assert.equal(c1.status, 'over');

  dropAudit = false;
  const [t0, t1] = createMemoryPair<Message>();
  c0.reconnect(t0);
  c1.reconnect(t1);
  await settle();
  assert.equal(c0.outcome?.kind, 'win');
  assert.deepEqual(c0.outcome, c1.outcome);
});

test('a modulus that is not a safe prime is refused', () => {
  const [t0] = createMemoryPair<Message>();
  assert.throws(
    () => new MatchCoordinator({ seat: 0, prime: generatePrime(256, seededRandomBytes(1)), transport: t0 }),
    /safe prime/,
  );
});

test('setup cannot be resumed', async () => {
  const [t0] = createMemoryPair<Message>();
  const c = new MatchCoordinator({ seat: 0, prime: PRIME, transport: t0 });
  assert.throws(() => c.reconnect(t0), /setup cannot be resumed/);
});
