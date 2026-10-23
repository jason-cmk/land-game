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
