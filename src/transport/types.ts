// The transport contract the match layer runs over. Messages are opaque to the
// transport: it moves them reliably and in order, and knows nothing about the
// game. The presence channel (unreliable, unordered) arrives with WebRTC.

export interface Transport<Message> {
  /** Queue a message for the peer. Silently dropped once the transport is closed. */
  send(message: Message): void;
  /** Subscribe to peer messages, in send order. Returns an unsubscribe function. */
  onMessage(listener: (message: Message) => void): () => void;
  /** Stop sending and delivering, in both directions. */
  close(): void;
}

export type TransportStatus = 'open' | 'disconnected' | 'closed';

/**
 * A real peer link: the reliable game channel plus an unreliable, unordered
 * presence channel for cosmetic signals (hover, drag). Presence messages may
 * be dropped and never delay game messages.
 */
export interface PeerTransport<Message, Presence> extends Transport<Message> {
  /** 0 for the inviter, 1 for the joiner. */
  readonly seat: 0 | 1;
  /** Best effort: dropped while the link is not open. */
  sendPresence(presence: Presence): void;
  onPresence(listener: (presence: Presence) => void): () => void;
  /** 'disconnected' may recover on its own; 'closed' is final. */
  onStatus(listener: (status: TransportStatus) => void): () => void;
}
