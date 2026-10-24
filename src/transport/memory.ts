// In-memory transport pair for tests and local simulation. Delivery is
// asynchronous (one microtask per message) so a receiver never runs inside the
// sender's call stack, matching a real network. Messages are structured-cloned
// so neither side can share object references with the other. localPeer wraps
// an end as a PeerTransport for a peer in the same tab (the computer).

import type { PeerTransport, Transport } from './types.ts';

class MemoryEnd<Message> implements Transport<Message> {
  peer: MemoryEnd<Message> | null = null;
  closed = false;
  private readonly listeners = new Set<(message: Message) => void>();

  send(message: Message): void {
    if (this.closed) return;
    const copy = structuredClone(message);
    queueMicrotask(() => this.peer?.deliver(copy));
  }

  onMessage(listener: (message: Message) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    if (this.peer !== null) this.peer.closed = true;
  }

  private deliver(message: Message): void {
    if (this.closed) return;
    for (const listener of [...this.listeners]) listener(message);
  }
}

/**
 * A PeerTransport over a plain Transport, for a peer in the same tab (the
 * computer opponent): no presence channel, and the link never drops.
 */
export function localPeer<Message, Presence>(transport: Transport<Message>, seat: 0 | 1): PeerTransport<Message, Presence> {
  return {
    seat,
    send: (message) => transport.send(message),
    onMessage: (listener) => transport.onMessage(listener),
    close: () => transport.close(),
    sendPresence: () => {},
    onPresence: () => () => {},
    onStatus: () => () => {},
  };
}

/** Two connected transport ends. Closing either end closes both. */
export function createMemoryPair<Message>(): [Transport<Message>, Transport<Message>] {
  const a = new MemoryEnd<Message>();
  const b = new MemoryEnd<Message>();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
