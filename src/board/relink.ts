// Reconnecting an online match. Both players rejoin a room named by the match
// id and link up on their own (see rooms.ts); if the relays are out of reach,
// they swap a fresh pair of codes instead. Either may make the invite; the
// codes carry the match id and the inviter's seat (see transport/signal.ts), so
// a code from another match, or your own code pasted back, is refused with a
// message instead of a broken link. Used in the lobby (after a reload) and over
// the table (after a drop).

import type { Message } from '../match/protocol.ts';
import type { Snapshot } from '../match/coordinator.ts';
import type { PeerTransport } from '../transport/types.ts';
import { createInvite, joinInvite } from '../transport/webrtc.ts';
import { ICE } from './ice.ts';
import type { Invite, Reconnect } from '../transport/webrtc.ts';
import type { Presence } from './presence.ts';
import { pageCourier } from './courier.ts';
import { linkByRoom, matchRoom } from './rooms.ts';
import type { RoomLink } from './rooms.ts';

type Link = PeerTransport<Message, Presence>;

/** The id both players derive for a match: the hash of its first log entry (the agreed decks). */
export function matchId(log: Snapshot['log']): string | null {
  return log[0]?.hash ?? null;
}

/**
 * Fill `host` with the code swap for `reconnect`; `onLink` gets the new link
 * once both channels are open. Returns a function that abandons the attempt.
 */
export function relinkPanel(host: HTMLElement, reconnect: Reconnect, onLink: (link: Link) => void): () => void {
  host.replaceChildren();
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] =>
    Object.assign(document.createElement(tag), props);

  const message = el('p', { className: 'hint' });
  message.setAttribute('role', 'status');
  const say = (text: string): void => {
    message.textContent = text;
  };
  const fail = (err: unknown): void => say((err as Error).message);
  const area = (placeholder: string, readOnly = false): HTMLTextAreaElement => el('textarea', { rows: 3, placeholder, readOnly });

  const make = el('button', { type: 'button', textContent: 'Make a reconnect code' });
  const theirs = area('…or paste their reconnect code here');
  const use = el('button', { type: 'button', textContent: 'Use their code' });
  const out = el('div', { hidden: true });
  const caption = el('p');
  const code = area('', true);
  const copy = el('button', { type: 'button', textContent: 'Copy', className: 'quiet' });
  const replyRow = el('div', { hidden: true });
  const reply = area('Paste their reply code');
  const connect = el('button', { type: 'button', textContent: 'Connect' });
  out.append(caption, code, copy);
  replyRow.append(reply, connect);
  const manual = [
    el('p', { textContent: 'Swap new codes to carry on. One of you makes a code and sends it; the other pastes it and sends back a reply.' }),
    make,
    theirs,
    use,
    out,
    replyRow,
  ];
  // Rejoin the match's room on our own; the code swap stays as a fallback.
  const courier = pageCourier();
  let room: RoomLink | null = null;
  if (courier === null) host.append(...manual, message);
  else {
    const auto = el('p', { textContent: 'Reconnecting… This happens on its own once the other player is back.' });
    const fallback = el('details');
    fallback.append(el('summary', { textContent: 'Not reconnecting? Swap codes instead' }), ...manual);
    host.append(auto, message, fallback);
    room = linkByRoom(courier, matchRoom(reconnect.match), reconnect.seat === 0 ? 'inviter' : 'joiner', { ...ICE, reconnect });
    room.link.then((link) => {
      invite?.cancel(); // a half-made code swap is not needed now
      finish(link);
    }, fail);
  }

  let invite: Invite<Message, Presence> | null = null;
  let done = false;
  const finish = (link: Link): void => {
    if (done) return link.close();
    done = true;
    room?.cancel();
    onLink(link);
  };
  const show = (text: string, value: string): void => {
    out.hidden = false;
    caption.textContent = text;
    code.value = value;
  };
  copy.onclick = () => void navigator.clipboard.writeText(code.value).then(() => say('Copied.'), fail);

  make.onclick = async () => {
    try {
      invite?.cancel();
      say('Making a code…');
      invite = await createInvite<Message, Presence>({ ...ICE, reconnect });
      show('Send this reconnect code to the other player:', invite.code);
      replyRow.hidden = false;
      say('Then paste their reply code below.');
      const pending = invite;
      connect.onclick = async () => {
        try {
          say('Connecting…');
          finish(await pending.accept(reply.value));
        } catch (err) {
          fail(err);
        }
      };
    } catch (err) {
      fail(err);
    }
  };

  use.onclick = async () => {
    try {
      say('Making a reply code…');
      const join = await joinInvite<Message, Presence>(theirs.value, { ...ICE, reconnect });
      invite?.cancel();
      replyRow.hidden = true;
      show('Send this reply code back:', join.code);
      say('Waiting for them to paste it…');
      finish(await join.transport);
    } catch (err) {
      fail(err);
    }
  };

  return () => {
    done = true;
    room?.cancel();
    invite?.cancel();
    host.replaceChildren();
  };
}
