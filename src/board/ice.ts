// The ICE servers for every link the board makes: public STUN, plus a TURN
// relay when the build names one (VITE_TURN_URLS, VITE_TURN_USERNAME and
// VITE_TURN_CREDENTIAL, e.g. in .env.local). A relay carries only DTLS-encrypted
// traffic and only when a direct path fails (carrier NAT, strict firewalls), so
// it needs no trust; the matching code still catches anyone in the middle.

import { DEFAULT_ICE_SERVERS } from '../transport/webrtc.ts';
import type { IceServer } from '../transport/webrtc.ts';

const env = import.meta.env;
const turnUrls = String(env.VITE_TURN_URLS ?? '')
  .split(',')
  .map((url) => url.trim())
  .filter((url) => url !== '');

export const ICE_SERVERS: readonly IceServer[] = [
  ...DEFAULT_ICE_SERVERS,
  ...(turnUrls.length > 0 ? [{ urls: turnUrls, username: String(env.VITE_TURN_USERNAME ?? ''), credential: String(env.VITE_TURN_CREDENTIAL ?? '') }] : []),
];

/** Options to spread into each createInvite, joinInvite and linkByRoom call. */
export const ICE = { iceServers: ICE_SERVERS } as const;
