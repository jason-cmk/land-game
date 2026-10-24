// The couriers that carry codes between players in a room (see rooms.ts):
// Trystero over public Nostr relays, and, for browser tests in dev, a
// BroadcastChannel stand-in that links tabs in one browser without the internet.

import { joinRoom } from 'trystero/nostr';
import { DEFAULT_ICE_SERVERS } from '../transport/webrtc.ts';
import type { Courier, CourierRoom } from './rooms.ts';

const APP_ID = 'land-game.jason-cmk';

/** Trystero meets peers through public Nostr relays, encrypting what it posts there with the password. */
export const trysteroCourier: Courier = (id, password) => {
  const iceServers = DEFAULT_ICE_SERVERS.map((server) => ({ urls: server.urls as string | string[] }));
  const room = joinRoom({ appId: APP_ID, password, rtcConfig: { iceServers } }, id);
  const action = room.makeAction<string>('codes');
  const handle: CourierRoom = {
    onPeerJoin: null,
    onPeerLeave: null,
    onMessage: null,
    send: (text, to) => void action.send(text, { target: to }).catch(() => {}),
    leave: () => void room.leave(),
  };
  room.onPeerJoin = (peer) => handle.onPeerJoin?.(peer);
  room.onPeerLeave = (peer) => handle.onPeerLeave?.(peer);
  action.onMessage = (data, { peerId }) => {
    if (typeof data === 'string') handle.onMessage?.(data, peerId);
  };
  return handle;
};

type LocalNote =
  | { readonly t: 'hello' | 'here' | 'bye'; readonly from: string }
  | { readonly t: 'text'; readonly from: string; readonly to: string; readonly text: string };

/** Dev only: rooms between tabs of one browser, over BroadcastChannel. */
export const localCourier: Courier = (id) => {
  const self = Math.random().toString(36).slice(2);
  const channel = new BroadcastChannel(`land-game/courier/${id}`);
  const peers = new Set<string>();
  const post = (note: LocalNote): void => channel.postMessage(note);
  const bye = (): void => post({ t: 'bye', from: self });
  const handle: CourierRoom = {
    onPeerJoin: null,
    onPeerLeave: null,
    onMessage: null,
    send: (text, to) => post({ t: 'text', from: self, to, text }),
    leave: () => {
      bye();
      channel.close();
      removeEventListener('pagehide', bye);
    },
  };
  channel.onmessage = ({ data }: MessageEvent<LocalNote>) => {
    if (data.from === self) return;
    if (data.t === 'hello' || data.t === 'here') {
      if (data.t === 'hello') post({ t: 'here', from: self });
      if (!peers.has(data.from)) {
        peers.add(data.from);
        handle.onPeerJoin?.(data.from);
      }
    } else if (data.t === 'bye') {
      if (peers.delete(data.from)) handle.onPeerLeave?.(data.from);
    } else if (data.t === 'text' && data.to === self) {
      handle.onMessage?.(data.text, data.from);
    }
  };
  addEventListener('pagehide', bye);
  queueMicrotask(() => post({ t: 'hello', from: self })); // once the caller has set its handlers
  return handle;
};

/**
 * The courier this page uses. In dev, `?courier=local` swaps in the
 * BroadcastChannel one and `?courier=off` turns rooms off (the smoke test's
 * code-swap checks), so nothing depends on public relays.
 */
export function pageCourier(): Courier | null {
  if (import.meta.env.DEV) {
    const choice = new URLSearchParams(location.search).get('courier');
    if (choice === 'local') return localCourier;
    if (choice === 'off') return null;
  }
  return trysteroCourier;
}
