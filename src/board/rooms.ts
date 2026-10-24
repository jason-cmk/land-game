// Linking by room code. Both players join a room named by a short code (or,
// to reconnect, by the match id), and a courier carries the usual invite and
// reply codes between them; the match then runs over our own WebRTC link, as
// with pasted codes. The courier is untrusted (Trystero over public relays):
// it could swap the codes, so both screens show a matching code made from the
// link's DTLS fingerprints, and the players can see they agree.
//
// Roles are fixed so the two never both invite: whoever created the room
// invites, and to reconnect, seat 1 waits for seat 0's invite.

import { sha256Hex } from '../match/log.ts';
import type { Message } from '../match/protocol.ts';
import { SignalError } from '../transport/signal.ts';
import type { PeerTransport } from '../transport/types.ts';
import { createInvite, joinInvite } from '../transport/webrtc.ts';
import type { Invite, Reconnect, WebRtcOptions } from '../transport/webrtc.ts';
import type { Presence } from './presence.ts';

type Link = PeerTransport<Message, Presence>;

/** A room on the courier: whoever else is in it, and text messages to one of them. */
export interface CourierRoom {
  onPeerJoin: ((peer: string) => void) | null;
  onPeerLeave: ((peer: string) => void) | null;
  onMessage: ((text: string, from: string) => void) | null;
  send(text: string, to: string): void;
  leave(): void;
}

/** Join `room`; `password` keeps what passes through the relays unreadable to others. */
export type Courier = (room: string, password: string) => CourierRoom;

// ---------------------------------------------------------------------------
// Room codes
// ---------------------------------------------------------------------------

/** No 0/O, 1/I/L: easy to read out and type. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;

export function newRoomCode(randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let code = '';
  while (code.length < ROOM_CODE_LENGTH) {
    for (const byte of randomBytes(8)) {
      // Rejection sampling keeps every letter equally likely.
      if (byte < 256 - (256 % ALPHABET.length) && code.length < ROOM_CODE_LENGTH) code += ALPHABET[byte % ALPHABET.length];
    }
  }
  return code;
}

/** A typed code, tidied (case, spaces, dashes); null if it cannot be one. */
export function parseRoomCode(text: string): string | null {
  const code = text.toUpperCase().replace(/[\s-]+/g, '');
  if (code.length !== ROOM_CODE_LENGTH) return null;
  return [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

export interface RoomName {
  readonly id: string;
  readonly password: string;
}

export const freshRoom = (code: string): RoomName => ({ id: `room/${code}`, password: code });
/** The match id is a hash nobody else knows, so it makes a strong password too. */
export const matchRoom = (match: string): RoomName => ({ id: `match/${match}`, password: match });

// ---------------------------------------------------------------------------
// Linking through a room
// ---------------------------------------------------------------------------

type Note = { readonly t: 'invite'; readonly code: string } | { readonly t: 'reply'; readonly code: string } | { readonly t: 'full' };

function readNote(text: string): Note | null {
  try {
    const note = JSON.parse(text) as Partial<Record<string, unknown>>;
    if ((note.t === 'invite' || note.t === 'reply') && typeof note.code === 'string') return { t: note.t, code: note.code };
    if (note.t === 'full') return { t: 'full' };
  } catch {
    // not ours: ignore
  }
  return null;
}

export interface RoomLink {
  /** Resolves with the open link; rejects if the attempt fails for good. */
  readonly link: Promise<Link>;
  /** Abandon the attempt and leave the room. */
  cancel(): void;
}

/**
 * Meet the other player in `room` and link up. The inviter answers the first
 * peer to arrive (and tells any later one the room is full); the joiner takes
 * the first invite it gets.
 */
export function linkByRoom(
  courier: Courier,
  room: RoomName,
  role: 'inviter' | 'joiner',
  options: WebRtcOptions & { readonly reconnect?: Reconnect } = {},
): RoomLink {
  const joined = courier(room.id, room.password);
  let partner: string | null = null;
  let invite: Invite<Message, Presence> | null = null;
  let answering = false; // a reply is on its way in or out: the partner may leave the room now
  let done = false;
  let resolve!: (link: Link) => void;
  let reject!: (err: Error) => void;
  const link = new Promise<Link>((ok, fail) => ((resolve = ok), (reject = fail)));
  link.catch(() => {}); // callers that cancel never see the rejection

  const finish = (outcome: Link | Error): void => {
    if (done) {
      if (!(outcome instanceof Error)) outcome.close();
      return;
    }
    done = true;
    joined.leave();
    if (outcome instanceof Error) reject(outcome);
    else resolve(outcome);
  };
  const send = (note: Note, to: string): void => joined.send(JSON.stringify(note), to);

  if (role === 'inviter') {
    joined.onPeerJoin = (peer) => {
      if (done || peer === partner) return;
      if (partner !== null) return send({ t: 'full' }, peer);
      partner = peer;
      void createInvite<Message, Presence>(options).then(
        (made) => {
          if (done || partner !== peer) return made.cancel();
          invite = made;
          send({ t: 'invite', code: made.code }, peer);
        },
        (err: Error) => finish(err),
      );
    };
    joined.onMessage = (text, from) => {
      const note = readNote(text);
      if (done || note?.t !== 'reply' || from !== partner || invite === null || answering) return;
      answering = true;
      invite.accept(note.code).then(finish, finish);
    };
    joined.onPeerLeave = (peer) => {
      if (peer !== partner || answering) return;
      // They left before replying: wait for someone else.
      invite?.cancel();
      invite = null;
      partner = null;
    };
  } else {
    joined.onMessage = (text, from) => {
      const note = readNote(text);
      if (done || note === null) return;
      if (note.t === 'full') {
        if (partner === null) finish(new SignalError('that room already has two players'));
        return;
      }
      if (note.t !== 'invite' || partner !== null) return;
      partner = from;
      answering = true;
      joinInvite<Message, Presence>(note.code, options)
        .then((join) => {
          send({ t: 'reply', code: join.code }, from);
          return join.transport;
        })
        .then(finish, finish);
    };
  }

  return {
    link,
    cancel: () => {
      if (done) return;
      done = true;
      invite?.cancel();
      joined.leave();
    },
  };
}

// ---------------------------------------------------------------------------
// Matching code
// ---------------------------------------------------------------------------

/** 64 symbols that are easy to name and render the same everywhere. */
export const SYMBOLS = [
  '🍎', '🍌', '🍇', '🍉', '🍒', '🍋', '🥕', '🌽',
  '🍄', '🌵', '🌲', '🌻', '🌹', '🍀', '🍁', '🌙',
  '⭐', '🔥', '🌊', '⚡', '⛄', '🌈', '🌞', '☔',
  '🐶', '🐱', '🐭', '🐰', '🦊', '🐻', '🐼', '🐨',
  '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧',
  '🦉', '🐢', '🐍', '🐙', '🦀', '🐟', '🐬', '🐳',
  '🦋', '🐝', '🐞', '🚗', '🚲', '⛵', '🚀', '⚓',
  '🔑', '🔔', '🎈', '🎁', '🎸', '⚽', '🎲', '👑',
] as const;

const fingerprint = (sdp: string): string => /^a=fingerprint:(.+)$/m.exec(sdp)?.[1]?.trim().toUpperCase() ?? '';

/**
 * Four symbols from the DTLS fingerprints in a link's offer and answer. Both
 * ends compute the same ones; anyone relaying a swapped pair of codes would
 * leave each player with a different set.
 */
export function matchingCode(offer: string, answer: string): string {
  const bits = parseInt(sha256Hex(`${fingerprint(offer)}|${fingerprint(answer)}`).slice(0, 6), 16);
  return [18, 12, 6, 0].map((shift) => SYMBOLS[(bits >> shift) & 63]).join(' ');
}
