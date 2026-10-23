// Two tabs on one machine (same origin) over BroadcastChannel: development and
// hotseat play without WebRTC. Messages sent before the other tab is listening
// would be lost, so connectBroadcast() resolves only once each side has heard
// the other's hello. A fresh hello is always acknowledged, even by a tab that is
// already open, so a reloaded tab can rejoin; acks are never answered, so the
// two tabs cannot ping-pong.

import type { PeerTransport, TransportStatus } from './types.ts';

type Envelope =
  | { readonly kind: 'hello'; readonly from: 0 | 1; readonly ack: boolean }
  | { readonly kind: 'game'; readonly from: 0 | 1; readonly body: unknown }
  | { readonly kind: 'presence'; readonly from: 0 | 1; readonly body: unknown }
  | { readonly kind: 'bye'; readonly from: 0 | 1 };

/** Open seat `seat` of room `room`; resolves when the other seat's tab is present. */
export function connectBroadcast<Message, Presence>(room: string, seat: 0 | 1): Promise<BroadcastTransport<Message, Presence>> {
  const transport = new BroadcastTransport<Message, Presence>(room, seat);
  return transport.opened.then(() => transport);
}

export class BroadcastTransport<Message, Presence> implements PeerTransport<Message, Presence> {
  readonly opened: Promise<void>;
  private readonly channel: BroadcastChannel;
  private readonly messageListeners = new Set<(message: Message) => void>();
  private readonly presenceListeners = new Set<(presence: Presence) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private open = false;
  private closed = false;
  readonly seat: 0 | 1;

  constructor(room: string, seat: 0 | 1) {
    this.seat = seat;
    this.channel = new BroadcastChannel(`land-game/${room}`);
    let markOpen = (): void => {};
    this.opened = new Promise((resolve) => (markOpen = resolve));

    this.channel.onmessage = (event: MessageEvent) => {
      const envelope = event.data as Envelope;
      if (this.closed || envelope.from === this.seat) return;
      switch (envelope.kind) {
        case 'hello':
          if (!envelope.ack) this.post({ kind: 'hello', from: this.seat, ack: true });
          if (this.open) return;
          this.open = true;
          markOpen();
          this.emitStatus('open');
          return;
        case 'game':
          for (const listener of [...this.messageListeners]) listener(envelope.body as Message);
          return;
        case 'presence':
          for (const listener of [...this.presenceListeners]) listener(envelope.body as Presence);
          return;
        case 'bye':
          this.close();
          return;
      }
    };
    this.post({ kind: 'hello', from: this.seat, ack: false });
  }

  send(message: Message): void {
    if (this.open && !this.closed) this.post({ kind: 'game', from: this.seat, body: message });
  }

  onMessage(listener: (message: Message) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  sendPresence(presence: Presence): void {
    if (this.open && !this.closed) this.post({ kind: 'presence', from: this.seat, body: presence });
  }

  onPresence(listener: (presence: Presence) => void): () => void {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  }

  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.post({ kind: 'bye', from: this.seat });
    this.closed = true;
    this.channel.close();
    this.emitStatus('closed');
  }

  private post(envelope: Envelope): void {
    this.channel.postMessage(envelope);
  }

  private emitStatus(status: TransportStatus): void {
    for (const listener of [...this.statusListeners]) listener(status);
  }
}
