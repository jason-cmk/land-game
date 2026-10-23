// Shared helpers for transport tests, whose delivery runs on real event-loop
// turns (timers, BroadcastChannel) rather than microtasks alone.

import type { MatchCoordinator } from '../../src/match/coordinator.ts';

/** Wait until `condition` holds, failing after `timeoutMs`. */
export async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Play deterministic pseudo-random legal moves until both coordinators finish. */
export async function playToEnd(c0: MatchCoordinator, c1: MatchCoordinator): Promise<void> {
  let seed = 1;
  const next = (): number => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  await until(() => c0.status !== 'setup' && c1.status !== 'setup');
  for (let actions = 0; actions < 5000 && (c0.status !== 'over' || c1.status !== 'over'); actions++) {
    const actor = [c0, c1].find((c) => c.legalActions().length > 0);
    if (actor !== undefined) {
      const options = actor.legalActions();
      const before = actor.log.length;
      actor.submit(options[Math.floor(next() * options.length)]!);
      // wait for the peer to catch up before choosing the next move
      const peer = actor === c0 ? c1 : c0;
      await until(() => peer.log.length >= before + 1 || peer.status === 'over');
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
}
