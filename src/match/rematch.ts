// Rematch: both players agree to a new match over the link the last one used.
// Each side sends one 'rematch' message when its player asks, and begins the
// new match once it has asked and heard the peer ask. The link is ordered, so
// the peer's first setup message always arrives after its 'rematch', by which
// time this side has begun and its new coordinator is listening.

import type { Message } from './protocol.ts';
import type { Transport } from '../transport/types.ts';

export interface Rematch {
  /** This player asks for a rematch. Begins at once if the peer already asked. */
  request(): void;
  readonly asked: boolean;
  readonly peerAsked: boolean;
  /** Stop listening for the peer's request. */
  dispose(): void;
}

/**
 * Listen on `transport` for the peer's request. `begin` runs once, when both
 * have asked; `changed` runs whenever either side asks.
 */
export function rematch(transport: Transport<Message>, begin: () => void, changed: () => void = () => {}): Rematch {
  let asked = false;
  let peerAsked = false;
  let begun = false;
  const maybeBegin = (): void => {
    if (!asked || !peerAsked || begun) return;
    begun = true;
    off();
    begin();
  };
  const off = transport.onMessage((message) => {
    if (message.t !== 'rematch' || peerAsked) return;
    peerAsked = true;
    changed();
    maybeBegin();
  });
  return {
    request() {
      if (asked) return;
      asked = true;
      transport.send({ t: 'rematch' });
      changed();
      maybeBegin();
    },
    get asked() {
      return asked;
    },
    get peerAsked() {
      return peerAsked;
    },
    dispose: off,
  };
}
