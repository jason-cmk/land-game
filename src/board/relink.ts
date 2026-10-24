// Reconnecting an online match: both players swap a fresh pair of codes.
// Either may make the invite; the codes carry the match id and the inviter's
// seat (see transport/signal.ts), so a code from another match, or your own
// code pasted back, is refused with a message instead of a broken link.
// Used in the lobby (after a reload) and over the table (after a drop).

import type { Message } from '../match/protocol.ts';
import type { Snapshot } from '../match/coordinator.ts';
import type { PeerTransport } from '../transport/types.ts';
import { createInvite, joinInvite } from '../transport/webrtc.ts';
import type { Invite, Reconnect } from '../transport/webrtc.ts';
import type { Presence } from './presence.ts';

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
  host.append(
    el('p', { textContent: 'Swap new codes to carry on. One of you makes a code and sends it; the other pastes it and sends back a reply.' }),
    make,
    theirs,
    use,
    out,
    replyRow,
    message,
  );

  let invite: Invite<Message, Presence> | null = null;
  let done = false;
  const finish = (link: Link): void => {
    if (done) return link.close();
    done = true;
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
      invite = await createInvite<Message, Presence>({ reconnect });
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
      const join = await joinInvite<Message, Presence>(theirs.value, { reconnect });
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
    invite?.cancel();
    host.replaceChildren();
  };
}
