// Board entry point: the lobby (two tabs, or online via copy-paste codes), the
// status bar, and the wiring from the coordinator to the prompt and the table.

import './style.css';
import { MatchCoordinator } from '../match/coordinator.ts';
import type { Snapshot } from '../match/coordinator.ts';
import type { Message } from '../match/protocol.ts';
import { DEFAULT_PRIME } from '../match/sra.ts';
import type { Action, CardId, GameState, Seat } from '../engine/types.ts';
import { connectBroadcast } from '../transport/broadcast.ts';
import { createInvite, joinInvite } from '../transport/webrtc.ts';
import type { PeerTransport } from '../transport/types.ts';
import { dropOutcome, promptFor } from './controls.ts';
import { cuesBetween } from './effects.ts';
import { dragMessage, hoverMessage, hoveredCard, peerCursor, peerDrag } from './presence.ts';
import type { Presence } from './presence.ts';
import { other } from '../engine/types.ts';
import type { Prompt } from './controls.ts';
import { Table } from './table.ts';
import type { Highlight } from './table.ts';

type Link = PeerTransport<Message, Presence>;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------------------------------------------------------------------------
// Snapshot storage (per tab): lets a reloaded tab resume its match.
// ---------------------------------------------------------------------------

function loadSnapshot(key: string): Snapshot | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as Snapshot);
  } catch {
    return null;
  }
}

function saveSnapshot(key: string, snapshot: Snapshot | null): void {
  try {
    if (snapshot === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(snapshot));
  } catch {
    // storage unavailable (private mode, quota): resume just won't work
  }
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

function setLobbyMessage(text: string): void {
  $('lobby-message').textContent = text;
}

$('tabs-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const submitter = (event as SubmitEvent).submitter as HTMLButtonElement;
  const seat = Number(submitter.value) as Seat;
  const room = ($('room') as HTMLInputElement).value.trim() || 'table';
  setLobbyMessage(`Waiting for the other tab to open seat ${seat === 0 ? 2 : 1} in room "${room}"…`);
  void connectBroadcast<Message, Presence>(room, seat).then((link) => play(link, `land-game/snapshot/${room}/${seat}`));
});

$('invite').addEventListener('click', async () => {
  try {
    setLobbyMessage('Making an invite code…');
    const invite = await createInvite<Message, Presence>();
    showCode('Send this invite code to the other player:', invite.code);
    ($('reply-row') as HTMLElement).hidden = false;
    setLobbyMessage('Then paste their reply code below.');
    $('accept').onclick = async () => {
      try {
        setLobbyMessage('Connecting…');
        const link = await invite.accept(($('reply-code') as HTMLTextAreaElement).value);
        play(link, null);
      } catch (err) {
        setLobbyMessage(String((err as Error).message));
      }
    };
  } catch (err) {
    setLobbyMessage(String((err as Error).message));
  }
});

$('join').addEventListener('click', async () => {
  try {
    setLobbyMessage('Making a reply code…');
    const join = await joinInvite<Message, Presence>(($('invite-code') as HTMLTextAreaElement).value);
    showCode('Send this reply code back to the inviter:', join.code);
    setLobbyMessage('Waiting for them to paste it…');
    play(await join.transport, null);
  } catch (err) {
    setLobbyMessage(String((err as Error).message));
  }
});

function showCode(caption: string, code: string): void {
  ($('code-out') as HTMLElement).hidden = false;
  $('code-caption').textContent = caption;
  ($('code') as HTMLTextAreaElement).value = code;
}

$('copy-code').addEventListener('click', () => {
  void navigator.clipboard.writeText(($('code') as HTMLTextAreaElement).value).then(() => setLobbyMessage('Copied.'));
});

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------

function play(link: Link, snapshotKey: string | null): void {
  $('lobby').hidden = true;
  $('game').hidden = false;

  const persist = (snapshot: Snapshot): void => {
    if (snapshotKey !== null) saveSnapshot(snapshotKey, snapshot);
  };
  const saved = snapshotKey === null ? null : loadSnapshot(snapshotKey);
  let coordinator: MatchCoordinator;
  if (saved !== null && saved.seat === link.seat) {
    coordinator = MatchCoordinator.resume(saved, link, { persist });
  } else {
    coordinator = new MatchCoordinator({ seat: link.seat, prime: DEFAULT_PRIME, transport: link, persist });
    coordinator.start();
  }

  const table = new Table();
  let picked: CardId | null = null;
  let error = '';
  let shown: GameState | null = null; // the last state drawn, to derive effect cues
  let lastCues: string[] = []; // for the dev automation hook

  const submit = (action: Action): void => {
    picked = null;
    try {
      coordinator.submit(action);
      error = '';
    } catch (err) {
      error = (err as Error).message;
      render();
    }
  };

  const currentPrompt = (): Prompt | null => {
    const state = coordinator.state;
    if (state === null || coordinator.status === 'over') return null;
    return promptFor(state, coordinator.seat, coordinator.legalActions(), picked);
  };

  table.onCardClick((id) => {
    const prompt = currentPrompt();
    if (prompt === null) return;
    if (prompt.kind === 'main') {
      const actions = prompt.playable.get(id);
      if (actions === undefined) return;
      if (actions.length === 1) submit(actions[0]!);
      else {
        picked = id;
        render();
      }
    } else if (prompt.kind === 'declare') {
      const action = prompt.targets.get(id);
      if (action !== undefined) submit(action);
      else {
        picked = null; // clicking anything else cancels
        render();
      }
    } else if (prompt.kind === 'resolve') {
      const action = prompt.targets.get(id);
      if (action !== undefined) submit(action);
    }
  });

  // Drag-to-play: the same outcomes as clicking, decided by where the card lands.
  let dragging: CardId | null = null;
  table.onDragStart((id) => {
    dragging = id;
    const prompt = currentPrompt();
    // A card with several targets starts targeting as it lifts, so the targets light up.
    if (prompt?.kind === 'main' && (prompt.playable.get(id)?.length ?? 0) > 1) {
      picked = id;
      render();
    }
  });
  table.onDrop((id, over, onTable) => {
    dragging = null;
    link.sendPresence({ t: 'dragEnd' });
    const outcome = dropOutcome(currentPrompt(), id, over, onTable);
    if (outcome.kind === 'submit') submit(outcome.action);
    else {
      picked = outcome.kind === 'pick' ? id : null;
      render();
    }
  });

  function render(): void {
    const state = coordinator.state;
    const buttons = $('buttons');
    buttons.replaceChildren();
    const status = $('prompt');
    if (state === null) {
      status.textContent = 'Shuffling the decks together…';
      return;
    }

    const prompt = currentPrompt();
    const highlights = new Map<CardId, Highlight>();
    if (prompt?.kind === 'main') for (const id of prompt.playable.keys()) highlights.set(id, 'playable');
    if (prompt?.kind === 'declare') {
      highlights.set(prompt.card, 'picked');
      for (const id of prompt.targets.keys()) highlights.set(id, 'target');
    }
    if (prompt?.kind === 'resolve') for (const id of prompt.targets.keys()) highlights.set(id, 'target');
    const cues = shown === null || shown === state ? [] : cuesBetween(shown, state);
    shown = state;
    if (cues.length > 0) lastCues = cues.map((c) => c.kind);
    table.show({ state, seat: coordinator.seat, privateHand: coordinator.privateHand, highlights }, cues);

    status.textContent = statusText(prompt) + (error ? ` (${error})` : '');
    const addButton = (label: string, onClick: () => void, quiet = false): void => {
      const button = document.createElement('button');
      button.textContent = label;
      if (quiet) button.className = 'quiet';
      button.onclick = onClick;
      buttons.append(button);
    };
    if (prompt !== null && 'buttons' in prompt) for (const choice of prompt.buttons) addButton(choice.label, () => submit(choice.action));
    if (prompt?.kind === 'declare') addButton('Cancel', () => ((picked = null), render()), true);
    if (coordinator.status === 'playing') addButton('Resign', () => confirm('Resign this match?') && submit({ type: 'resign' }), true);
    if (coordinator.status === 'over') {
      if (snapshotKey !== null) saveSnapshot(snapshotKey, null);
      addButton('New match', () => location.reload());
    }
  }

  function statusText(prompt: Prompt | null): string {
    const outcome = coordinator.outcome;
    if (outcome?.kind === 'void') return `Match void: ${outcome.detail}`;
    if (outcome?.kind === 'forfeit') return `You win: the other player failed verification (${outcome.detail}).`;
    if (outcome?.kind === 'win') return promptFor(coordinator.state!, coordinator.seat, []).text;
    if (coordinator.status === 'auditing') return 'Game over. Checking both decks…';
    return prompt?.text ?? '';
  }

  link.onStatus((status) => {
    if (status === 'closed' && coordinator.status !== 'over') $('prompt').textContent = 'The connection closed.';
  });
  // Presence: cosmetic, best effort, never touches the coordinator.
  let peerHover: Presence | null = null;
  const showPeerHover = (): void => {
    const state = coordinator.state;
    table.setPeerHover(state === null || peerHover === null ? null : hoveredCard(state, table.handOrder(other(coordinator.seat)), peerHover));
  };
  table.onCardHover((id) => {
    const state = coordinator.state;
    if (state !== null) link.sendPresence(hoverMessage(state, coordinator.seat, table.handOrder(coordinator.seat), id));
  });
  let lastPointer = 0;
  const throttled = (): boolean => {
    const now = performance.now();
    if (now - lastPointer < 50) return false; // ~20 Hz
    lastPointer = now;
    return true;
  };
  table.onPointer((x, y) => {
    if (dragging === null && throttled()) link.sendPresence({ t: 'cursor', x, y });
  });
  table.onDragMove((id, x, y) => {
    const state = coordinator.state;
    if (state !== null && throttled()) link.sendPresence(dragMessage(state, coordinator.seat, table.handOrder(coordinator.seat), id, { x, y }));
  });
  let peerDragging: Presence | null = null;
  const showPeerDrag = (): void => {
    const state = coordinator.state;
    table.setPeerDrag(state === null || peerDragging === null ? null : peerDrag(state, table.handOrder(other(coordinator.seat)), peerDragging));
  };
  link.onPresence((message) => {
    if (typeof message !== 'object' || message === null) return;
    if (message.t === 'cursor') table.setPeerCursor(peerCursor(message));
    else if (message.t === 'hoverHand' || message.t === 'hoverBoard') {
      peerHover = message;
      showPeerHover();
    } else if (message.t === 'dragHand' || message.t === 'dragBoard' || message.t === 'dragEnd') {
      peerDragging = message.t === 'dragEnd' ? null : message;
      showPeerDrag();
    }
  });

  coordinator.onChange(() => {
    render();
    showPeerHover(); // the hovered card may have moved or gone
    // A play can overtake its own dragEnd (separate channels); a hand index may now name another card.
    peerDragging = null;
    showPeerDrag();
  });
  void table.mount($('table')).then(render);

  if (import.meta.env.DEV) {
    // Test hook for browser automation: what can be clicked right now, and where.
    (window as unknown as { __landGame: unknown }).__landGame = {
      coordinator,
      clickables: () => {
        const prompt = currentPrompt();
        const ids =
          prompt?.kind === 'main' ? [...prompt.playable.keys()] : prompt?.kind === 'declare' || prompt?.kind === 'resolve' ? [...prompt.targets.keys()] : [];
        const canvas = $('table').getBoundingClientRect();
        const cards = ids.flatMap((id) => {
          const at = table.cardPosition(id);
          return at === null ? [] : [{ id, x: canvas.left + at.x, y: canvas.top + at.y }];
        });
        const buttons = [...$('buttons').querySelectorAll('button')].map((b) => b.textContent ?? '');
        return { kind: prompt?.kind ?? null, cards, buttons, cues: lastCues };
      },
      playEffects: (cues: Parameters<Table['playEffects']>[0]) => table.playEffects(cues),
      peerPresence: () => table.peerPresence(),
      settling: () => table.settling(),
      cardAt: (id: CardId) => {
        const at = table.cardPosition(id);
        const canvas = $('table').getBoundingClientRect();
        return at === null ? null : { x: canvas.left + at.x, y: canvas.top + at.y };
      },
    };
  }
}
