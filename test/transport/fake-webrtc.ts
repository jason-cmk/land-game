// Minimal in-process stand-in for RTCPeerConnection: enough of the API for
// WebRtcTransport (negotiated data channels, offer/answer, ICE gathering
// state). Two fake connections link up once each holds the other's
// description, the way a real pair does once signalling completes.

import type { DataChannelLike, PeerConnectionFactory, PeerConnectionLike, SessionDescriptionLike } from '../../src/transport/webrtc.ts';

class FakeChannel implements DataChannelLike {
  readyState: DataChannelLike['readyState'] = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  peer: FakeChannel | null = null;
  /** Raw payloads this end sent, for tests that inspect the wire. */
  readonly sent: unknown[] = [];

  send(data: string): void {
    if (this.readyState !== 'open') throw new Error('InvalidStateError: channel is not open');
    this.sent.push(data);
    this.inject(data);
  }

  /** Deliver an arbitrary payload to the peer, as if this end had sent it. */
  inject(data: unknown): void {
    const peer = this.peer;
    queueMicrotask(() => {
      if (peer !== null && peer.readyState === 'open') peer.onmessage?.({ data });
    });
  }

  open(): void {
    this.readyState = 'open';
    queueMicrotask(() => this.onopen?.());
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    queueMicrotask(() => this.onclose?.());
    this.peer?.close();
  }
}

let nextId = 0;

/** A plausible-size SDP so the signalling codec has something to compress. */
function fakeSdp(id: number, type: string): string {
  const lines = [`v=0`, `o=fake ${id} 2 IN IP4 127.0.0.1`, `s=${type}`, `a=fingerprint:sha-256 ${'AB:'.repeat(31)}AB`];
  for (let i = 0; i < 12; i++) lines.push(`a=candidate:${i} 1 udp ${2122260223 - i} 192.168.1.${i + 10} ${50000 + i} typ host`);
  return `${lines.join('\r\n')}\r\n`;
}

export class FakePeerConnection implements PeerConnectionLike {
  static all = new Map<number, FakePeerConnection>();
  readonly id = nextId++;
  localDescription: SessionDescriptionLike | null = null;
  iceGatheringState: PeerConnectionLike['iceGatheringState'] = 'new';
  connectionState = 'new';
  onicegatheringstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly channels = new Map<number, FakeChannel>();
  private remoteId: number | null = null;
  private linked: FakePeerConnection | null = null;

  private readonly gathers: boolean;

  constructor(gathers = true) {
    this.gathers = gathers;
    FakePeerConnection.all.set(this.id, this);
  }

  createDataChannel(_label: string, init: { readonly id: number }): DataChannelLike {
    const channel = new FakeChannel();
    this.channels.set(init.id, channel);
    return channel;
  }

  async createOffer(): Promise<SessionDescriptionLike> {
    return { type: 'offer', sdp: fakeSdp(this.id, 'offer') };
  }

  async createAnswer(): Promise<SessionDescriptionLike> {
    return { type: 'answer', sdp: fakeSdp(this.id, 'answer') };
  }

  async setLocalDescription(description: SessionDescriptionLike): Promise<void> {
    this.localDescription = description;
    this.iceGatheringState = 'gathering';
    if (this.gathers) {
      setTimeout(() => {
        this.iceGatheringState = 'complete';
        this.onicegatheringstatechange?.();
      }, 1);
    }
    this.tryLink();
  }

  async setRemoteDescription(description: SessionDescriptionLike): Promise<void> {
    this.remoteId = Number(/^o=fake (\d+)/m.exec(description.sdp)![1]);
    this.tryLink();
  }

  close(): void {
    if (this.connectionState === 'closed') return;
    this.connectionState = 'closed';
    for (const channel of this.channels.values()) channel.close();
    const peer = this.linked;
    if (peer !== null && peer.connectionState !== 'closed') {
      peer.connectionState = 'disconnected';
      queueMicrotask(() => peer.onconnectionstatechange?.());
    }
  }

  /** Simulate the network dropping without either side closing. */
  dropNetwork(): void {
    for (const pc of [this, this.linked!]) {
      pc.connectionState = 'failed';
      queueMicrotask(() => pc.onconnectionstatechange?.());
    }
  }

  private tryLink(): void {
    if (this.linked !== null || this.remoteId === null || this.localDescription === null) return;
    const peer = FakePeerConnection.all.get(this.remoteId);
    if (peer === undefined || peer.remoteId !== this.id || peer.localDescription === null) return;
    this.linked = peer;
    peer.linked = this;
    for (const [id, channel] of this.channels) {
      const other = peer.channels.get(id)!;
      channel.peer = other;
      other.peer = channel;
      channel.open();
      other.open();
    }
    for (const pc of [this, peer]) {
      pc.connectionState = 'connected';
      queueMicrotask(() => pc.onconnectionstatechange?.());
    }
  }
}

export const fakeFactory: PeerConnectionFactory = () => new FakePeerConnection();
