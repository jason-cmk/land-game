// Board entry point: the lobby (the computer, two tabs, or online by room code
// or copy-paste codes), the status bar, and the wiring from the coordinator to
// the prompt and the table.

import './style.css';
import { MatchCoordinator } from '../match/coordinator.ts';
import type { Snapshot } from '../match/coordinator.ts';
import type { Message } from '../match/protocol.ts';
import { DEFAULT_PRIME } from '../match/sra.ts';
import type { Action, CardId, GameState, Seat } from '../engine/types.ts';
import { runBot } from '../bot/bot.ts';
import { connectBroadcast } from '../transport/broadcast.ts';
import { createMemoryPair, localPeer } from '../transport/memory.ts';
import { WebRtcTransport, createInvite, joinInvite } from '../transport/webrtc.ts';
import { matchId, relinkPanel } from './relink.ts';
import { pageCourier } from './courier.ts';
import { freshRoom, linkByRoom, matchingCode, newRoomCode, parseRoomCode } from './rooms.ts';
import type { RoomLink } from './rooms.ts';
import type { PeerTransport, TransportStatus } from '../transport/types.ts';
import { dropOutcome, promptFor } from './controls.ts';
import { counterChain } from './chain.ts';
import type { ChainStep } from './chain.ts';
import { cuesBetween } from './effects.ts';
import { CARD_INFO, infoPlacement } from './cardinfo.ts';
import { richText, setRichText } from './mana.ts';
import { matchHistory } from './history.ts';
import { dragMessage, hoverMessage, hoveredCard, peerCursor, peerDrag } from './presence.ts';
import type { Presence } from './presence.ts';
import { other } from '../engine/types.ts';
import type { Prompt } from './controls.ts';
import { Table } from './table.ts';
import type { Highlight } from './table.ts';

type Link = PeerTransport<Message, Presence>;

/** Who is across the table: the computer, another tab, or someone online. */
type Mode = 'computer' | 'tabs' | 'online';

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
  const key = `land-game/snapshot/${room}/${seat}`;
  void connectBroadcast<Message, Presence>(room, seat).then((link) => play(link, key, loadSnapshot(key), 'tabs'));
});

// Room codes: one player creates a room, the other types its code.
const courier = pageCourier();
let roomAttempt: RoomLink | null = null;
if (courier === null) {
  ($('rooms') as HTMLElement).hidden = true;
  ($('manual-codes') as HTMLDetailsElement).open = true;
}

function meet(code: string, role: 'inviter' | 'joiner'): void {
  if (courier === null) return;
  roomAttempt?.cancel();
  const attempt = linkByRoom(courier, freshRoom(code), role);
  roomAttempt = attempt;
  // Finding each other through the relays can take a while; say so rather than look stuck.
  const slow = setTimeout(() => {
    if (roomAttempt === attempt) {
      setLobbyMessage(
        role === 'inviter' ? 'Still waiting. Check they typed the code right.' : `Still looking for room ${code}. Check the code, and that the other player has the room open.`,
      );
    }
  }, 20000);
  attempt.link.then(
    (link) => {
      clearTimeout(slow);
      startOnline(link);
    },
    (err: Error) => {
      clearTimeout(slow);
      if (roomAttempt === attempt) setLobbyMessage(`Could not join: ${err.message}.`);
    },
  );
}

$('create-room').addEventListener('click', () => {
  const code = newRoomCode();
  ($('room-out') as HTMLElement).hidden = false;
  $('room-code-out').textContent = code;
  setLobbyMessage('Waiting for the other player to join…');
  meet(code, 'inviter');
});

$('join-room-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = parseRoomCode(($('room-code') as HTMLInputElement).value);
  if (code === null) return setLobbyMessage('Room codes are four letters and digits, like K7QX.');
  ($('room-out') as HTMLElement).hidden = true;
  setLobbyMessage(`Looking for room ${code}…`);
  meet(code, 'joiner');
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
        startOnline(link);
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
    startOnline(await join.transport);
  } catch (err) {
    setLobbyMessage(String((err as Error).message));
  }
});

/** An online match keeps a snapshot per tab, so a reload can reconnect to it. */
const ONLINE_KEY = 'land-game/snapshot/online';

let started = false;

function startOnline(link: Link): void {
  if (started) return link.close(); // a room and a code swap both came through
  started = true;
  roomAttempt?.cancel();
  saveSnapshot(ONLINE_KEY, null); // a new match replaces any abandoned one
  play(link, ONLINE_KEY, null, 'online');
}

// After a reload mid-match: offer to reconnect with fresh codes.
const unfinished = loadSnapshot(ONLINE_KEY);
const unfinishedId = unfinished === null ? null : matchId(unfinished.log);
if (unfinished !== null && unfinishedId !== null) {
  ($('resume') as HTMLElement).hidden = false;
  $('resume-caption').textContent = `You are seat ${unfinished.seat + 1}, ${unfinished.log.length - 1} moves in.`;
  const stop = relinkPanel($('resume-panel'), { match: unfinishedId, seat: unfinished.seat }, (link) => {
    if (started) return link.close();
    started = true;
    roomAttempt?.cancel();
    play(link, ONLINE_KEY, unfinished, 'online');
  });
  $('abandon').addEventListener('click', () => {
    if (!confirm('Abandon this match? It cannot be resumed afterwards.')) return;
    stop();
    saveSnapshot(ONLINE_KEY, null);
    ($('resume') as HTMLElement).hidden = true;
  });
}

// Against the computer: both seats run in this tab, the computer's coordinator
// over an in-memory link. Each seat keeps its own snapshot, so a reload resumes.
const COMPUTER_KEYS = ['land-game/snapshot/computer/you', 'land-game/snapshot/computer/bot'] as const;

function playComputer(saved: readonly [Snapshot | null, Snapshot | null]): void {
  const [mine, theirs] = createMemoryPair<Message>();
  const persist = (snapshot: Snapshot): void => saveSnapshot(COMPUTER_KEYS[1], snapshot);
  const bot = saved[1] !== null ? MatchCoordinator.resume(saved[1], theirs, { persist }) : new MatchCoordinator({ seat: 1, prime: DEFAULT_PRIME, transport: theirs, persist });
  if (saved[1] === null) bot.start();
  // Save after every change, not only before the computer's own moves: a reload must find both seats.
  bot.onChange(() => {
    const snapshot = bot.snapshot();
    if (bot.status === 'over') saveSnapshot(COMPUTER_KEYS[1], null);
    else if (snapshot !== null) persist(snapshot);
  });
  const table = play(localPeer(mine, 0), COMPUTER_KEYS[0], saved[0], 'computer');
  // Wait for cards to come to rest, so each move can be seen landing before the next.
  runBot(bot, { busy: () => table.settling() > 1 });
}

{
  const saved = [loadSnapshot(COMPUTER_KEYS[0]), loadSnapshot(COMPUTER_KEYS[1])] as const;
  let resumable = saved[0] !== null && saved[1] !== null;
  if (resumable) {
    $('computer').textContent = 'Carry on';
    $('computer-hint').textContent = `Your match against the computer is still going, ${saved[0]!.log.length - 1} moves in.`;
    ($('computer-new') as HTMLElement).hidden = false;
  }
  const fresh = (): void => {
    for (const key of COMPUTER_KEYS) saveSnapshot(key, null);
    playComputer([null, null]);
  };
  $('computer').addEventListener('click', () => {
    if (!resumable) return fresh();
    try {
      playComputer(saved);
    } catch (err) {
      // A snapshot that no longer replays (say, from an older version) cannot be carried on.
      for (const key of COMPUTER_KEYS) saveSnapshot(key, null);
      resumable = false;
      $('computer').textContent = 'Play the computer';
      setLobbyMessage(`That match could not be resumed (${(err as Error).message}). Start a new one.`);
    }
  });
  $('computer-new').addEventListener('click', fresh);
}

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

/**
 * Play a match over `link`, resuming `saved` if it is this seat's. Online
 * matches offer a code swap when the link drops; two tabs just reload.
 */
function play(firstLink: Link, snapshotKey: string, saved: Snapshot | null, mode: Mode): Table {
  roomAttempt?.cancel(); // a room still searching must not start a second match
  const online = mode === 'online';
  $('lobby').hidden = true;
  $('game').hidden = false;
  let link = firstLink;

  const persist = (snapshot: Snapshot): void => saveSnapshot(snapshotKey, snapshot);
  let coordinator: MatchCoordinator;
  if (saved !== null && saved.seat === link.seat) {
    coordinator = MatchCoordinator.resume(saved, link, { persist });
  } else {
    coordinator = new MatchCoordinator({ seat: link.seat, prime: DEFAULT_PRIME, transport: link, persist });
    coordinator.start();
  }
  if (mode === 'computer') {
    // Both seats live in this tab, so save on every change: a reload must find this seat even before its first move.
    coordinator.onChange(() => {
      const snapshot = coordinator.snapshot();
      if (snapshot !== null && coordinator.status !== 'over') persist(snapshot);
    });
  }

  const table = new Table();
  let picked: CardId | null = null;
  let connection: TransportStatus = 'open'; // play pauses while the link is down
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
    if (state === null || coordinator.status === 'over' || connection !== 'open') return null;
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

  // History: the match so far in words, rebuilt from the log while the panel is open.
  const historyPanel = $('history');
  const historyToggle = $('history-toggle');
  const setHistoryOpen = (open: boolean): void => {
    historyPanel.hidden = !open;
    historyToggle.setAttribute('aria-expanded', String(open));
    if (open) renderHistory(true);
  };
  historyToggle.onclick = () => setHistoryOpen(historyPanel.hidden);
  $('history-close').onclick = () => setHistoryOpen(false);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !historyPanel.hidden) setHistoryOpen(false);
  });
  function renderHistory(toEnd = false): void {
    if (historyPanel.hidden) return;
    const list = $('history-list');
    // Follow new lines only if the reader is already at the end, not scrolled back.
    const atEnd = toEnd || historyPanel.scrollTop + historyPanel.clientHeight >= historyPanel.scrollHeight - 8;
    const turns = matchHistory(coordinator.log, coordinator.seat, (id) => coordinator.privateHand.get(id) ?? null);
    list.replaceChildren(
      ...turns.map((turn) => {
        const item = document.createElement('li');
        const heading = document.createElement('h3');
        heading.textContent = `Turn ${turn.turn} · ${turn.seat === coordinator.seat ? 'yours' : 'theirs'}`;
        const lines = document.createElement('ul');
        lines.append(
          ...turn.lines.map((line) => {
            const row = document.createElement('li');
            row.replaceChildren(...richText(line.text));
            row.className = line.seat === null ? 'outcome' : line.seat === coordinator.seat ? 'you' : 'them';
            return row;
          }),
        );
        item.append(heading, lines);
        return item;
      }),
    );
    if (turns.length === 0) list.replaceChildren(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'Nothing has happened yet.' }));
    if (atEnd) historyPanel.scrollTop = historyPanel.scrollHeight;
  }

  // Card info: what a face-up land does, beside it.
  table.onInspect((info) => {
    const panel = $('card-info');
    panel.hidden = info === null;
    if (info === null) return;
    const { name, lines } = CARD_INFO[info.land];
    const heading = document.createElement('strong');
    heading.textContent = name;
    panel.replaceChildren(
      heading,
      ...lines.map((line) => {
        const p = document.createElement('p');
        p.append(...richText(line));
        return p;
      }),
    );
    const host = $('table');
    const at = infoPlacement(info.box, { width: panel.offsetWidth, height: panel.offsetHeight }, { width: host.clientWidth, height: host.clientHeight });
    panel.style.transform = `translate(${at.x}px, ${at.y}px)`;
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
    const steps = coordinator.log.map((entry): ChainStep => {
      const action = entry.action;
      if (action.type === 'play') return { kind: 'play' };
      if (action.type === 'counter') return { kind: 'counter', link: { seat: entry.seat as Seat, cards: [action.island.card, action.other.card] } };
      return { kind: 'other' };
    });
    const chain = counterChain(state, steps);
    table.show({ state, seat: coordinator.seat, privateHand: coordinator.privateHand, highlights, chain }, cues);
    renderHistory();

    setRichText(status, (connection === 'open' || coordinator.status === 'over' ? statusText(prompt) : connectionText()) + (error ? ` (${error})` : ''));
    const addButton = (label: string, onClick: () => void, quiet = false, into = buttons): void => {
      const button = document.createElement('button');
      button.append(...richText(label));
      if (quiet) button.className = 'quiet';
      button.onclick = onClick;
      into.append(button);
    };
    // A counter decision is a popup in the middle of the table, with the land it is about.
    const choice = $('choice');
    const deciding = prompt?.kind === 'respond';
    choice.hidden = !deciding;
    if (prompt?.kind === 'respond') {
      const land = state.pending?.land;
      const image = land === undefined ? null : table.faceImage(land);
      const card = $<HTMLImageElement>('choice-card');
      card.hidden = image === null;
      if (image !== null) card.src = image;
      setRichText($('choice-text'), prompt.text);
      const choiceButtons = $('choice-buttons');
      choiceButtons.replaceChildren();
      for (const option of prompt.buttons) addButton(option.label, () => submit(option.action), option.action.type === 'allow', choiceButtons);
    } else if (prompt !== null && 'buttons' in prompt) for (const option of prompt.buttons) addButton(option.label, () => submit(option.action));
    if (prompt?.kind === 'declare') addButton('Cancel', () => ((picked = null), render()), true);
    if (coordinator.status === 'playing' && connection === 'open') addButton('Resign', () => confirm('Resign this match?') && submit({ type: 'resign' }), true);
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

  // Connection: an online link that drops is replaced by a fresh code swap.
  let stopRelink: (() => void) | null = null;
  const connectionText = (): string => {
    if (connection === 'disconnected') return 'The connection is interrupted; waiting for it to recover…';
    if (!online) return 'The other tab closed. Reload both tabs to carry on.';
    if (coordinator.log.length === 0) return 'The connection dropped while shuffling. Start a new match.';
    return 'The connection dropped. Swap new codes to carry on.';
  };
  const onStatus = (status: TransportStatus): void => {
    connection = status;
    const relink = online && status === 'closed' && coordinator.status !== 'over' && coordinator.log.length > 0;
    ($('reconnect') as HTMLElement).hidden = !relink;
    if (relink && stopRelink === null) {
      const id = matchId(coordinator.log)!;
      stopRelink = relinkPanel($('reconnect-panel'), { match: id, seat: coordinator.seat }, (fresh) => {
        stopRelink = null;
        ($('reconnect') as HTMLElement).hidden = true;
        attach(fresh);
        coordinator.reconnect(fresh);
        onStatus('open');
      });
    }
    render();
  };
  // Matching code: both players should see the same symbols for their link.
  const matching = $('matching');
  const matchingInfo = $('matching-info');
  const showMatching = (open: boolean): void => {
    matchingInfo.hidden = !open;
    matching.setAttribute('aria-expanded', String(open));
  };
  matching.onclick = () => showMatching(matchingInfo.hidden);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') showMatching(false);
  });
  /** Listen to `next` instead of the current link (which is closed if still open). */
  let unhook: Array<() => void> = [];
  const attach = (next: Link): void => {
    for (const off of unhook) off();
    const previous = link;
    link = next;
    unhook = [next.onStatus(onStatus), next.onPresence(onPresence)];
    if (previous !== next) previous.close();
    const session = next instanceof WebRtcTransport ? next.session : null;
    matching.hidden = session === null;
    if (session !== null) {
      matching.textContent = matchingCode(session.offer, session.answer);
      matching.setAttribute('aria-label', `Matching code ${matching.textContent}: check the other player sees the same`);
    }
  };
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
  table.onDragMove((id, x, y, aim) => {
    const state = coordinator.state;
    if (state !== null && throttled()) link.sendPresence(dragMessage(state, coordinator.seat, table.handOrder(coordinator.seat), id, { x, y }, aim));
  });
  let peerDragging: Presence | null = null;
  const showPeerDrag = (): void => {
    const state = coordinator.state;
    table.setPeerDrag(state === null || peerDragging === null ? null : peerDrag(state, table.handOrder(other(coordinator.seat)), peerDragging));
  };
  function onPresence(message: Presence): void {
    if (typeof message !== 'object' || message === null) return;
    if (message.t === 'cursor') table.setPeerCursor(peerCursor(message));
    else if (message.t === 'hoverHand' || message.t === 'hoverBoard') {
      peerHover = message;
      showPeerHover();
    } else if (message.t === 'dragHand' || message.t === 'dragBoard' || message.t === 'dragEnd') {
      peerDragging = message.t === 'dragEnd' ? null : message;
      showPeerDrag();
    }
  }
  attach(link);

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
          const at = table.visiblePoint(id);
          return at === null ? [] : [{ id, x: canvas.left + at.x, y: canvas.top + at.y }];
        });
        const buttons = [...document.querySelectorAll('#buttons button, #choice:not([hidden]) button')].map((b) => b.textContent ?? '');
        return { kind: prompt?.kind ?? null, cards, buttons, cues: lastCues };
      },
      playEffects: (cues: Parameters<Table['playEffects']>[0]) => table.playEffects(cues),
      peerPresence: () => table.peerPresence(),
      settling: () => table.settling(),
      /** The history panel's lines (opening it if needed). */
      history: () => {
        if (historyPanel.hidden) setHistoryOpen(true);
        return [...$('history-list').querySelectorAll('ul > li')].map((li) => li.textContent ?? '');
      },
      /** The matching code in the status bar, or null if this link has none. */
      matchingCode: () => (matching.hidden ? null : matching.textContent),
      /** The card info panel's text, or null while it is hidden. */
      cardInfo: () => ($('card-info').hidden ? null : $('card-info').textContent),
      /** Simulate the network dropping (this end closes; the peer sees its channels close). */
      dropLink: () => link.close(),
      cardAt: (id: CardId) => {
        const at = table.visiblePoint(id);
        const canvas = $('table').getBoundingClientRect();
        return at === null ? null : { x: canvas.left + at.x, y: canvas.top + at.y };
      },
    };
  }
  return table;
}
