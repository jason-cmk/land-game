# Progress

Status of the web Land Game against `spec.md` and `../tech/tech.md`. Last updated: 2026-10-24.

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
   - `npm test`: 111 tests
   - `npm run demo`
   - `npm run smoke`: drives the board in headless Chrome (a two-tab match, a reload, then WebRTC with a forced drop and a reload). It needs Google Chrome; the default path is the macOS one, so elsewhere set `CHROME_PATH` (e.g. `/usr/bin/google-chrome`). It uses ports 5199 and 9333 and writes screenshots to `smoke-output/` (gitignored).
3. **Play it.** `npm run dev`, then open http://localhost:5173 in two tabs, enter the same room in both and take seat 1 and seat 2. For online play, one player clicks *Create an invite*, the other pastes it and sends back the reply code.
4. **Read before changing behaviour:** `AGENT.md`, then `spec.md` (source of truth), `tech.md`, `design.md`.

Working notes:

- **Dev hook.** In `npm run dev`, `window.__landGame` exposes the coordinator plus `clickables()`, `cardAt(id)`, `settling()`, `peerPresence()`, `playEffects(cues)` and `dropLink()`; `scripts/smoke-browser.mjs` shows how to drive the board with it over the Chrome DevTools protocol (no Playwright).
- **Browser automation must wait for `settling()` to reach 0** before clicking: Pixi hit-tests cards where they are drawn, and new hand cards make their neighbours slide.
- **Board code is DOM-typed separately**: `tsconfig.board.json` covers `src/board/`; the base config keeps DOM types out of the engine, match and transport layers.
- **The next step is below**: the effect tuning and Swamp reveal moment are self-contained board work in `src/board/fx.ts` and `effects.ts`.

## Summary

Rules engine, Mental Poker primitives and the lockstep coordinator are done and tested; WebRTC and two-tab BroadcastChannel transports are built, and two coordinators play full games over each. A playable board (PixiJS table, HTML chrome, Vite) runs full matches in two tabs and over real WebRTC, checked in headless Chrome: code-drawn card art, effect animations, live presence (hover, cursor, drag), drag-to-play, and a visible counter chain. A dropped or reloaded online match reconnects with fresh codes.

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
| Board: effect animations | `src/board/effects.ts`, `fx.ts` | Done |
| Board: presence (hover, cursor, drag) | `src/board/presence.ts` | Done |
| Board: drag-to-play | `src/board/table.ts`, `controls.ts` | Done |
| Board: card art (code-drawn, baked textures) | `src/board/art.ts` | First pass |
| Board: counter-chain display | `src/board/chain.ts`, `table.ts` | Done |
| Board: online reconnect (drop and reload) | `src/board/relink.ts`, `transport/webrtc.ts` | Done |
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
- **Tests**: 111 passing (`npm test`): the above plus coordinator setup, random full games in lockstep, every failure-policy branch, reconnect (reload, lost in-flight action, live transport swap, drop mid-audit), signalling codes, and full matches over the fake-WebRTC and BroadcastChannel transports.
- **Demo**: `npm run demo` plays a scripted 13-turn match through two peer states, asserting lockstep hash equality on every action, then runs an SRA epilogue.
- **Online reconnect**: reconnect codes carry the match id (hash of log entry 0) and the inviter's seat, so either player can make one and mismatched codes are refused with a clear message. A dropped link opens a code-swap panel over the table and pauses play; a reloaded tab resumes from the lobby (`sessionStorage` snapshot) or can abandon the match. Tested at the transport level (a match survives its link dying, either seat inviting) and in `npm run smoke` over real WebRTC: a forced drop, then a reload, each followed by more moves in lockstep.
- **Smoke test reliability**: the rare lost click in `npm run smoke` was the test clicking while a neighbouring card was still gliding over its target (new cards shuffle into the hand). The board exposes `settling()` to dev tooling and the test waits for the whole table to come to rest.
- **Tooling**: `npm run dev` (Vite), `npm run build`, `npm run typecheck` (two configs: no-DOM layers, DOM board), `npm test`, `npm run demo`, `npm run smoke` (headless-Chrome play-through of the board). Node 24 type stripping; one runtime dependency (PixiJS).

## Not done

1. **Board polish**: effect tuning, Swamp reveal moment.
2. **Layer enforcement**: `tech.md` asks for dependency-cruiser or ESLint rules for the import directions; currently only the separate DOM-typed `tsconfig.board.json` keeps DOM out of the other layers.

## Next step

Board polish, then layer enforcement:

- **Effect tuning**: the counter (`fx.ts` `counter`/`countered`), Forest regrowth and Swamp discard effects are subtle next to the meteor; make them as readable.
- **Swamp reveal moment**: when a Swamp makes a player reveal their hand, the revealed cards only flash in place. Give it a moment (e.g. fan the revealed hand toward the middle while the opponent picks the discard).
- **Layer enforcement**: see *Not done* above.

## Open items and risks

- SRA is malleable and not IND-CPA; accepted for a homebrew game (see `tech.md`).
- The modulus is a fixed 256-bit safe prime by choice (homebrew game, fast setup); a larger one can be swapped in later.
- A player who disconnects and never returns is unresolved (no arbiter).
- The default STUN server is Google's public one: third-party, sees connection metadata only. Still to be confirmed that this fits "no server at all".
- Known quirk: when a hand mixes revealed and hidden cards, the opponent's view of a hovered hand card can sit one position off (see `design.md` § Presence).
- An online match's saved state lives in `sessionStorage`: it survives a reload, not closing the tab.
