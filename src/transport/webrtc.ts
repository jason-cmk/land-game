// Direct browser-to-browser transport over WebRTC data channels, with manual
// copy-paste signalling and no signalling server:
//
//   inviter: createInvite()      -> invite code  ──paste──▶  joiner: joinInvite(code)
//   inviter: invite.accept(code) ◀──paste── reply code       joiner: awaits transport
//
// ICE candidates are not trickled: each side waits for gathering to finish so
// its code carries every candidate, and one paste in each direction is enough.
//
// Two pre-negotiated channels (same ids on both sides, no in-band handshake):
//   game      id 0, ordered and reliable      -> Transport.send / onMessage
//   presence  id 1, unordered, no retransmits -> sendPresence / onPresence
//
// RTCPeerConnection is reached through the small structural types below, so
// the module typechecks without DOM types and tests can inject a fake.

import { decodeSignal, encodeSignal } from './signal.ts';
import type { PeerTransport, TransportStatus } from './types.ts';

export interface IceServer {
  readonly urls: string | readonly string[];
}

/**
 * Public STUN lets peers behind ordinary home NATs find their public address.
 * It sees only connection metadata, never game traffic. There is no TURN
 * relay, so matches across strict NATs fail (see spec: NAT failures).
 */
export const DEFAULT_ICE_SERVERS: readonly IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export interface DataChannelLike {
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}

export interface SessionDescriptionLike {
  readonly type: 'offer' | 'answer';
  readonly sdp: string;
}

export interface PeerConnectionLike {
  readonly localDescription: SessionDescriptionLike | null;
  readonly iceGatheringState: 'new' | 'gathering' | 'complete';
  readonly connectionState: string;
  onicegatheringstatechange: (() => void) | null;
  onconnectionstatechange: (() => void) | null;
  createDataChannel(
    label: string,
    init: { readonly negotiated: true; readonly id: number; readonly ordered: boolean; readonly maxRetransmits?: number },
  ): DataChannelLike;
  createOffer(): Promise<SessionDescriptionLike>;
  createAnswer(): Promise<SessionDescriptionLike>;
  setLocalDescription(description: SessionDescriptionLike): Promise<void>;
  setRemoteDescription(description: SessionDescriptionLike): Promise<void>;
  close(): void;
}

export type PeerConnectionFactory = (config: { readonly iceServers: readonly IceServer[] }) => PeerConnectionLike;

export interface WebRtcOptions {
  readonly iceServers?: readonly IceServer[];
  /** Defaults to the browser's RTCPeerConnection. */
  readonly createPeerConnection?: PeerConnectionFactory;
  /** Stop waiting for more ICE candidates after this long and use what we have. */
  readonly gatherTimeoutMs?: number;
}

export interface Invite<Message, Presence> {
  /** Give this to the other player. */
  readonly code: string;
  /** Paste the other player's reply code; resolves once the channels are open. */
  accept(replyCode: string): Promise<WebRtcTransport<Message, Presence>>;
  /** Abandon the invite. */
  cancel(): void;
}

export interface Join<Message, Presence> {
  /** Give this reply code back to the inviter. */
  readonly code: string;
  /** Resolves once the inviter has pasted the reply and the channels are open. */
  readonly transport: Promise<WebRtcTransport<Message, Presence>>;
}

const defaultFactory: PeerConnectionFactory = (config) => {
  const Ctor = (globalThis as { RTCPeerConnection?: new (c: unknown) => PeerConnectionLike }).RTCPeerConnection;
  if (Ctor === undefined) throw new Error('WebRTC is not available in this environment');
  return new Ctor(config);
};

/** Seat 0: make an invite code. */
export async function createInvite<Message, Presence>(options: WebRtcOptions = {}): Promise<Invite<Message, Presence>> {
  const pc = connect(options);
  const transport = new WebRtcTransport<Message, Presence>(0, pc);
  try {
    await pc.setLocalDescription(await pc.createOffer());
    const code = await encodeSignal(await gathered(pc, options));
    return {
      code,
      accept: async (replyCode) => {
        await pc.setRemoteDescription(await decodeSignal(replyCode, 'answer'));
        await transport.opened;
        return transport;
      },
      cancel: () => transport.close(),
    };
  } catch (err) {
    transport.close();
    throw err;
  }
}

/** Seat 1: answer an invite code with a reply code. */
export async function joinInvite<Message, Presence>(inviteCode: string, options: WebRtcOptions = {}): Promise<Join<Message, Presence>> {
  const offer = await decodeSignal(inviteCode, 'offer');
  const pc = connect(options);
  const transport = new WebRtcTransport<Message, Presence>(1, pc);
  try {
    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
    const code = await encodeSignal(await gathered(pc, options));
    return { code, transport: transport.opened.then(() => transport) };
  } catch (err) {
    transport.close();
    throw err;
  }
}

function connect(options: WebRtcOptions): PeerConnectionLike {
  return (options.createPeerConnection ?? defaultFactory)({ iceServers: options.iceServers ?? DEFAULT_ICE_SERVERS });
}

/** The local description once ICE gathering is complete (or the timeout passes). */
function gathered(pc: PeerConnectionLike, options: WebRtcOptions): Promise<SessionDescriptionLike> {
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      pc.onicegatheringstatechange = null;
      const description = pc.localDescription;
      if (description === null) reject(new Error('no local session description'));
      else resolve({ type: description.type, sdp: description.sdp });
    };
    const timer = setTimeout(finish, options.gatherTimeoutMs ?? 5000);
    if (pc.iceGatheringState === 'complete') return finish();
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
  });
}

export class WebRtcTransport<Message, Presence> implements PeerTransport<Message, Presence> {
  /** Resolves when both channels are open; rejects if the link closes first. */
  readonly opened: Promise<void>;
  private readonly game: DataChannelLike;
  private readonly presence: DataChannelLike;
  private readonly messageListeners = new Set<(message: Message) => void>();
  private readonly presenceListeners = new Set<(presence: Presence) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private closed = false;
  readonly seat: 0 | 1;
  private readonly pc: PeerConnectionLike;

  constructor(seat: 0 | 1, pc: PeerConnectionLike) {
    this.seat = seat;
    this.pc = pc;
    this.game = pc.createDataChannel('game', { negotiated: true, id: 0, ordered: true });
    this.presence = pc.createDataChannel('presence', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });

    this.opened = new Promise((resolve, reject) => {
      const check = (): void => {
        if (this.game.readyState === 'open' && this.presence.readyState === 'open') {
          resolve();
          this.emitStatus('open');
        }
      };
      this.game.onopen = check;
      this.presence.onopen = check;
      this.game.onclose = () => {
        reject(new Error('the connection closed before it opened'));
        this.close();
      };
    });
    this.opened.catch(() => {}); // callers that never await it should not see an unhandled rejection

    this.game.onmessage = (event) => this.deliver(event.data, this.messageListeners);
    this.presence.onmessage = (event) => this.deliver(event.data, this.presenceListeners);
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'disconnected') this.emitStatus('disconnected');
      else if (state === 'connected') this.emitStatus('open');
      else if (state === 'failed' || state === 'closed') this.close();
    };
  }

  send(message: Message): void {
    if (this.closed || this.game.readyState !== 'open') return;
    this.game.send(JSON.stringify(message));
  }

  onMessage(listener: (message: Message) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  sendPresence(presence: Presence): void {
    if (this.closed || this.presence.readyState !== 'open') return;
    this.presence.send(JSON.stringify(presence));
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
    this.closed = true;
    this.game.close();
    this.presence.close();
    this.pc.close();
    this.emitStatus('closed');
  }

  /** Peer data is untrusted: anything that is not JSON text is dropped. */
  private deliver<T>(data: unknown, listeners: Set<(value: T) => void>): void {
    if (this.closed || typeof data !== 'string') return;
    let value: T;
    try {
      value = JSON.parse(data) as T;
    } catch {
      return;
    }
    for (const listener of [...listeners]) listener(value);
  }

  private emitStatus(status: TransportStatus): void {
    for (const listener of [...this.statusListeners]) listener(status);
  }
}
