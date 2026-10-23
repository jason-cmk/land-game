// In-memory transport pair for tests and local simulation. Delivery is
// asynchronous (one microtask per message) so a receiver never runs inside the
// sender's call stack, matching a real network. Messages are structured-cloned
// so neither side can share object references with the other.

import type { Transport } from './types.ts';

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

/** Two connected transport ends. Closing either end closes both. */
export function createMemoryPair<Message>(): [Transport<Message>, Transport<Message>] {
  const a = new MemoryEnd<Message>();
  const b = new MemoryEnd<Message>();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
