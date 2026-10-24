# Progress

Status of the web Land Game against `spec.md` and `../tech/tech.md`. Last updated: 2026-10-24 (mobile, card info, history, effect polish, layer enforcement, turn indicator, targeting arrow, tilt).

## Picking up on another machine

Paused on 2026-10-24 with everything merged to `main` and pushed to `github.com/jason-cmk/land-game` (private). There are no open branches or uncommitted work.

1. **Set up.** Node 24 or newer (the code runs as TypeScript through Node's type stripping, no build step for tests). Then:
   ```sh
   git clone https://github.com/jason-cmk/land-game.git
   cd land-game
   npm install
   ```
2. **Check it works.** All four should pass:
   - `npm run typecheck`
   - `npm test`: 124 tests
   - `npm run demo`
   - `npm run smoke`: drives the board in headless Chrome (a two-tab match, a reload, then WebRTC with a forced drop and a reload, then a phone-sized touch tab against a desktop tab). It needs Google Chrome or Chromium; the default path is the macOS one, so elsewhere set `CHROME_PATH` (e.g. `/usr/bin/chromium` on the Arch server). It picks two free ports per run (so runs in parallel worktrees don't collide) and writes screenshots to `smoke-output/` (gitignored).
3. **Play it.** `npm run dev`, then open http://localhost:5173 in two tabs, enter the same room in both and take seat 1 and seat 2. For online play, one player clicks *Create an invite*, the other pastes it and sends back the reply code.
4. **Read before changing behaviour:** `AGENT.md`, then `spec.md` (source of truth), `tech.md`, `design.md`.

Working notes:

- **Dev hook.** In `npm run dev`, `window.__landGame` exposes the coordinator plus `clickables()`, `cardAt(id)`, `settling()`, `cardInfo()`, `history()`, `peerPresence()`, `playEffects(cues)` and `dropLink()`; `scripts/smoke-browser.mjs` shows how to drive the board with it over the Chrome DevTools protocol (no Playwright).
- **Browser automation must wait for `settling()` to reach 0** before clicking, then re-read card positions: Pixi hit-tests cards where they are drawn, new hand cards make their neighbours slide, and on a phone a re-wrapping status bar resizes the table. Bring the tab to the front first (`Page.bringToFront`): headless Chrome throttles animation frames in background tabs, so a background table can look stuck.
- **Touch is emulated over CDP** with `Emulation.setTouchEmulationEnabled` and `Input.dispatchTouchEvent`; see `tab.click`/`drag`/`longPress` in the smoke script.
- **Board code is DOM-typed separately**: `tsconfig.board.json` covers `src/board/`; the base config keeps DOM types out of the engine, match and transport layers.
- **Next on the list:** online play by room code, and single-player mode (see Not done). Beyond that, the open items and risks at the end, and the open design questions in `design.md`.

## Summary

Rules engine, Mental Poker primitives and the lockstep coordinator are done and tested; WebRTC and two-tab BroadcastChannel transports are built, and two coordinators play full games over each. A playable board (PixiJS table, HTML chrome, Vite) runs full matches in two tabs and over real WebRTC, checked in headless Chrome: code-drawn card art, effect animations, live presence (hover, cursor, drag), drag-to-play, and a visible counter chain. A dropped or reloaded online match reconnects with fresh codes. It works on phones (compact portrait layout, tap and finger drag), hovering or long-pressing a card shows what it does, and a 📜 panel tells the match so far.

| Layer | Path | Status |
| --- | --- | --- |
| Engine (pure rules) | `src/engine/` | Done |
| Match: hash chain / canonical JSON / SHA-256 | `src/match/log.ts` | Done |
| Match: Mental Poker (SRA) + reveal verify + audit | `src/match/sra.ts` | Done |
| Match: spend-known-first helper | `src/match/spend-known-first.ts` | Done |
| Match: wire protocol (messages, keyed actions) | `src/match/protocol.ts` | Done |
| Match: coordinator (setup, lockstep, audit, reconnect) | `src/match/coordinator.ts` | Done |
| Transport: interface + in-memory pair | `src/transport/` | Done |
| Transport: BroadcastChannel (two tabs) | `src/transport/broadcast.ts` | Done |
| Transport: WebRTC (copy-paste codes, two data channels) | `src/transport/webrtc.ts`, `signal.ts` | Done |
| Board: first slice (PixiJS table, HTML chrome, lobby) | `src/board/`, `index.html` | Done |
| Board: effect animations (incl. tuned counter / Forest / Swamp, Swamp reveal moment) | `src/board/effects.ts`, `fx.ts`, `table.ts` | Done |
| Board: presence (hover, cursor, drag) | `src/board/presence.ts` | Done |
| Board: drag-to-play | `src/board/table.ts`, `controls.ts` | Done |
| Board: card art (code-drawn, baked textures) | `src/board/art.ts` | First pass |
| Board: counter-chain display | `src/board/chain.ts`, `table.ts` | Done |
| Board: online reconnect (drop and reload) | `src/board/relink.ts`, `transport/webrtc.ts` | Done |
| Board: phones and touch (compact layout, tap, finger drag) | `src/board/table.ts`, `style.css` | Done |
| Board: card info on hover / long press | `src/board/cardinfo.ts`, `table.ts`, `main.ts` | Done |
| Board: history log | `src/board/history.ts`, `main.ts` | Done |
| Layer enforcement | `test/layers.spec.ts` | Done |
| Board: turn indicator (edge light, badge) | `src/board/table.ts`, `overlay.ts`, `controls.ts` | Done |
| Board: targeting arrow (local and opponent) | `src/board/table.ts`, `overlay.ts`, `presence.ts` | Done |
| Board: hover tilt and shine | `src/board/table.ts` | Done |
| Design doc | `docs/design/design.md` | First pass |

## Done

- **Spec and tech docs**, including the corrected SRA 4-step deck setup (A owner bulk-lock + shuffle, B other bulk-lock + shuffle, C owner per-slot keys in place, D other per-slot keys in place), the blindness argument, sha256-derived canonical card values, and removal of `revealedToOpponent` (hidden is `land === null`).
- **Engine**: `createGame`, `apply`, `legalActions`, `counterResponder`, `winReason`. Phases `main / respond / revealHand / target / drawKey / over`. Illegal actions throw `IllegalActionError`. Enforces spend-known-first, counter chains (parity decides resolution), win checked on entry before the effect, empty-deck draw loss.
- **Match crypto**: pure-TS SHA-256 (standard vectors), canonical JSON, hash-chained log, SRA primitives, deck protocol, play-time reveal verification, end-of-game audit.
- **Coordinator**: coin flip, parallel 4-step shuffle of both decks, opening-hand keys, log entry 0 and `ready` hash check, keyed actions, automatic forced moves (draw-key grants, Swamp reveals), end-of-game audit. Failure policy: hash/sequence mismatch voids the match; any failed verification (keys, reveals, engine-illegal action, audit) forfeits the peer, overriding any declared winner. Reconnect replays the log from a snapshot and resends missing actions. Details in `tech.md` § Coordinator.
- **Crypto hardening**: card values are squares (quadratic residues) and the modulus is a safe prime (`DEFAULT_PRIME`, 256-bit), closing a leak where each hidden card's quadratic-residue bit was public and correlated with its land. The coordinator refuses non-safe moduli. Also fixed `generatePrime` looping forever on bit lengths that are not a multiple of 8.
- **Engine fix**: the land being played could be spent to pay for its controller's own counter-counter, crashing the later `allow`. Found by coordinator random play.
- **Transports**: WebRTC with copy-paste invite/reply codes (non-trickle ICE, pre-negotiated `game` and `presence` channels), BroadcastChannel for two tabs (reload-safe hello/ack), and a `PeerTransport` interface adding presence and status. Details in `tech.md` § Transport interface.
- **Board, first slice**: Vite + PixiJS. Lobby for two tabs (room + seat) or online (invite/reply codes); status bar with prompt and choice buttons; table with all zones, gliding cards, gold/red highlights for playable cards and targets, tab-reload resume via `sessionStorage`. Prompts come from a pure `src/board/controls.ts` (unit-tested). Checked in headless Chrome by clicking through: a full two-tab match to a Domain win, a mid-game tab reload, and a real WebRTC connection between two tabs, with no console errors.
- **Effect animations**: board-side cues derived by diffing consecutive states (unit-tested), played by a small PixiJS effects layer: meteor, counter ripples and shatter, landing dust, regrowth leaves, Swamp smoke and reveal flash, Plains halo, win fountain and banner; skipped under `prefers-reduced-motion`. Verified frame by frame in headless Chrome.
- **Presence**: hovering a card shows it to the opponent (cyan glow, card leans in) and your pointer appears on their side. Hidden hand cards travel as an index into a locally shuffled hand order, never a slot id; incoming presence is validated. Verified between two headless Chrome tabs.
- **Drag-to-play**: playable cards can be dragged as well as clicked. Drop on a target, on the table, or back on the hand; what a drop does comes from a pure, unit-tested `dropOutcome` in `controls.ts`. The opponent sees the dragged card follow your pointer (`dragHand`/`dragBoard` presence). `npm run smoke` now plays about a third of its cards by real mouse drags and fails if the opponent never sees one; a separate headless check confirmed a drag dropped straight onto a Forest target, and a drop back on the hand changing nothing.
- **Card art**: MTG-style basic land faces (name bar, landscape, type line, mana symbol) and an abstract card back with the five land colours, drawn in code (`src/board/art.ts`) and baked into textures at mount. Revealed hand cards get a rim and an eye badge.
- **Counter chain**: paid pairs stay beside the play, numbered and labelled by payer, with what allowing would do now; rebuilt from the log (`chain.ts`, unit-tested) so it survives reloads. Checked in headless Chrome with a two-counter chain.
- **Coordinator fix found in the browser**: an exception in an `onChange` listener was caught by the message handler and treated as the peer failing verification, so a UI bug forfeited the match. Listener errors now go to `onListenerError` (default: rethrown on a fresh task).
- **Phones and touch**: below 720 px wide the table uses a compact layout (cards sized by row height, hands overlapping across the full width, slim deck and graveyard columns); the status bar keeps room for a two-line prompt. A finger drag needs 12 px of travel and holds the card above the fingertip; the drop lands where the card is drawn. The canvas now follows its container's size (`ResizeObserver`), fixing the bottom row being cut off when the status bar wrapped. Long-press callouts and menus are suppressed on the canvas. `npm run smoke` has a phone phase (390×844, touch emulation) that plays by taps and finger drags against a desktop tab.
- **Card info**: a panel above a face-up card says what it does (spec wording; `cardinfo.ts`, unit-tested placement): after a 0.3 s mouse hover, or while a finger long-presses (0.45 s). A long press never plays the card. Checked in the smoke test on both the phone and the desktop tab.
- **History log**: a 📜 button opens a panel with the match turn by turn in plain words, rebuilt from the log by replaying it through the engine and reading each step with `cuesBetween` (`history.ts`), so it survives reloads. The opponent's draws stay "a card"; the viewer's own are named from its private hand. Unit-tested on a hand-built log from both seats and on random full matches through the real coordinators (a line per play, no named opponent draws, both seats the same length, ends with the result); the smoke test checks both seats' panels after the two-tab match and that the panel fits on the phone.
- **Effect polish**: the counter (water bolts arcing from the paying cards into the play), countered (cracks, then spinning shards), Forest (a vine growing along the card's path home) and Swamp discard (tendrils, darkening, smoke) now read as clearly as the meteor; impact flashes are additive. The Swamp reveal is a moment: the revealed hand fans out large in the middle over a darkened table, labelled for both seats, while the discard is chosen. Checked frame by frame in headless Chrome on desktop and phone, from both seats.
- **Layer enforcement**: `test/layers.spec.ts` (run by `npm test`) checks every import under `src/` against `tech.md` § Layering (engine and transport import only themselves, match never imports board, only board uses npm packages) and that the engine uses no timers, clock, randomness, DOM or BigInt. Dependency-free instead of dependency-cruiser; it also checks it catches each kind of violation.
- **Design questions settled** (`design.md` § Resolved): a turn indicator (light along the side of whoever the game is waiting on, from a unit-tested `actingSeat`, plus a turn badge); a targeting arrow (a card that needs a target stays lifted and aims a dashed arrow that turns red and rings a valid target; the opponent sees it through an `aim` flag on drag presence); a tilt and light streak on mouse hover. Hidden-information display and WebAssembly (no) recorded as decided. Checked in headless Chrome on desktop and phone, from both seats; an aimed drop plays at its target. Also fixed: a second `stroke()` on a used-up PixiJS path drew nothing, which had left the Forest vine and Swamp tendrils without their highlight.
- **Smoke test ports**: `npm run smoke` picks free ports per run; with fixed ones, two runs at once (e.g. another worktree's) attached to each other's browser and failed in confusing ways. It closes each phase's tabs before the next (leftover boards kept rendering and starved the last, phone, phase into stalling), allows a minute for setup and logs how long it took, and waits for a reloaded page to load before clicking (a click before the module runs submits the bare lobby form). New `vite.config.ts`: the file watcher ignores `.claude/` (other worktrees live inside this folder) and `smoke-output/`, whose changes were full-reloading open pages mid-match, in the dev server as well as in smoke runs; the smoke test now reports any such reload as an error.
- **Tests**: 124 passing (`npm test`): the above plus coordinator setup, random full games in lockstep, every failure-policy branch, reconnect (reload, lost in-flight action, live transport swap, drop mid-audit), signalling codes, and full matches over the fake-WebRTC and BroadcastChannel transports.
- **Demo**: `npm run demo` plays a scripted 13-turn match through two peer states, asserting lockstep hash equality on every action, then runs an SRA epilogue.
- **Online reconnect**: reconnect codes carry the match id (hash of log entry 0) and the inviter's seat, so either player can make one and mismatched codes are refused with a clear message. A dropped link opens a code-swap panel over the table and pauses play; a reloaded tab resumes from the lobby (`sessionStorage` snapshot) or can abandon the match. Tested at the transport level (a match survives its link dying, either seat inviting) and in `npm run smoke` over real WebRTC: a forced drop, then a reload, each followed by more moves in lockstep.
- **Smoke test reliability**: the rare lost click in `npm run smoke` was the test clicking while a neighbouring card was still gliding over its target (new cards shuffle into the hand). The board exposes `settling()` to dev tooling and the test waits for the whole table to come to rest.
- **Tooling**: `npm run dev` (Vite), `npm run build`, `npm run typecheck` (two configs: no-DOM layers, DOM board), `npm test`, `npm run demo`, `npm run smoke` (headless-Chrome play-through of the board). Node 24 type stripping; one runtime dependency (PixiJS).

## Not done

- **Online play by room code.** One player gets a short code (e.g. `K7QX`), the other types it, and the match starts: no copy-paste codes. Works anywhere with internet, not just on one Wi-Fi network. Decided 2026-10-24: online only (offline play dropped); `tech.md` principle 1 is now "no trusted server", so the two connection messages may travel through public relays found with [Trystero](https://github.com/dmotz/trystero), while the game itself stays peer-to-peer and verified by both sides.
  - **Trystero as courier only.** Recommended: use a Trystero room just to swap the existing invite and reply codes, then connect with our own `transport/webrtc.ts` as today. That keeps the two data channels, the reconnect logic and the tests, and puts the npm package in `src/board/`, the only layer allowed one. (The alternative, a `PeerTransport` over Trystero's own connection, would replace tested code for no gain.)
  - **Room names.** The typed code maps to a Trystero room under the game's app id. Public relays are shared, so a short code can collide with strangers: the room takes two players, a third is refused, and codes expire once both have joined. Encrypt what passes through the relays with a key derived from the code (check Trystero's room password option).
  - **Matching code.** Both screens show a short emoji string built from both sides' DTLS fingerprints (read from the SDP), so players can see that nothing sits in the middle of the connection. Without it a dishonest relay could read the draw keys sent to you, which reveals your hand.
  - **Reconnect.** A dropped or reloaded online match rejoins a room derived from the match id and re-swaps codes automatically; the code-swap panel becomes a fallback.
  - **Fallbacks.** The copy-paste codes stay, behind a "Use codes instead" link, for when the relays are down.
  - *Open question:* which Trystero strategy (Nostr, MQTT, BitTorrent trackers): pick by reliability and speed of finding the other player; possibly more than one.
  - **ICE.** Still the public STUN server (players are on different networks now); no TURN, so strict NATs still fail, as today.
  - **Lobby:** "Play online" leads with "Create a room" and "Join with a code". Tests: the courier behind a small interface, with a fake in unit tests; the smoke test uses a local fake relay rather than public ones, so it doesn't depend on the internet.
- **Single-player mode.** Play against a computer opponent in one tab.
  - Run the bot as a real second peer: its own coordinator over `createMemoryPair` (`src/transport/memory.ts`), so the Mental Poker setup, reveals and audit run unchanged and the bot only ever knows what its seat may know. No engine or match changes expected.
  - Bot policy picks from `legalActions` using only its own state and private hand: start simple (random legal move, with sensible counter and target choices), keep it pure and unit-tested like `controls.ts`, and add a small think delay so plays read on the board.
  - Decide where it lives against `tech.md` § Layering (probably `src/board/` or a new `src/bot/` layer that imports engine and match), and update `test/layers.spec.ts` to match.
  - Lobby: a "Play the computer" option; reload resumes from `sessionStorage` like a two-tab match (both seats' snapshots). Presence from the bot can be skipped or faked lightly.
  - Tests: random full matches bot-vs-bot through real coordinators; a smoke-test phase playing a match against the bot.

## Next step

The two items above: single-player is in progress on the `single-player` branch; local Wi-Fi play is designed, with the hosting question still open. Other candidates: the open items and risks below (a player who never returns, the STUN server, real-device testing on iOS), and real card art (the one open question left in `design.md`).

## Open items and risks

- SRA is malleable and not IND-CPA; accepted for a homebrew game (see `tech.md`).
- The modulus is a fixed 256-bit safe prime by choice (homebrew game, fast setup); a larger one can be swapped in later.
- A player who disconnects and never returns is unresolved (no arbiter).
- The default STUN server is Google's public one: third-party, sees connection metadata only. Still to be confirmed that this fits "no server at all".
- Known quirk: when a hand mixes revealed and hidden cards, the opponent's view of a hovered hand card can sit one position off (see `design.md` § Presence).
- An online match's saved state lives in `sessionStorage`: it survives a reload, not closing the tab.
- The table renders every frame even when nothing moves (PixiJS's ticker runs continuously), so an idle board still costs CPU/GPU and, on phones, battery. Several open boards in one headless browser starve each other badly (setup went 4 s → 31 s → 101 s with each extra pair of tabs). Worth rendering on demand: only while cards are moving, effects or the turn pulse play, or the pointer moves.
- Phones are checked only under Chrome's mobile emulation, not on a real device; iOS Safari (long-press callout, `100dvh`, vibration unsupported) in particular is untested. A phone held sideways gets small cards (about 40×56 px), limited by its height.
- Presence on touch: a finger shows the opponent which card it touches only while it is down; there is no idle cursor.
- The lobby's copy-paste codes are long; pasting them on a phone works in emulation, but sharing them from a phone (e.g. via a chat app) is untested.
