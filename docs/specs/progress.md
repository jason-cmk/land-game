# Progress

Status of the web Land Game against `spec.md` and `../tech/tech.md`. Last updated: 2026-10-24.

## Summary

Rules engine, Mental Poker primitives and the lockstep coordinator are done and tested; WebRTC and two-tab BroadcastChannel transports are built, and two coordinators play full games over each. The WebRTC path is tested against a fake `RTCPeerConnection` only. No visuals yet.

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
| Transport: WebRTC (copy-paste codes, two data channels) | `src/transport/webrtc.ts`, `signal.ts` | Done; untested in a real browser |
| Board (DOM UI) | `src/board/` | Not started |
| Design doc | `docs/design/design.md` | Stub |

## Done

- **Spec and tech docs**, including the corrected SRA 4-step deck setup (A owner bulk-lock + shuffle, B other bulk-lock + shuffle, C owner per-slot keys in place, D other per-slot keys in place), the blindness argument, sha256-derived canonical card values, and removal of `revealedToOpponent` (hidden is `land === null`).
- **Engine**: `createGame`, `apply`, `legalActions`, `counterResponder`, `winReason`. Phases `main / respond / revealHand / target / drawKey / over`. Illegal actions throw `IllegalActionError`. Enforces spend-known-first, counter chains (parity decides resolution), win checked on entry before the effect, empty-deck draw loss.
- **Match crypto**: pure-TS SHA-256 (standard vectors), canonical JSON, hash-chained log, SRA primitives, deck protocol, play-time reveal verification, end-of-game audit.
- **Coordinator**: coin flip, parallel 4-step shuffle of both decks, opening-hand keys, log entry 0 and `ready` hash check, keyed actions, automatic forced moves (draw-key grants, Swamp reveals), end-of-game audit. Failure policy: hash/sequence mismatch voids the match; any failed verification (keys, reveals, engine-illegal action, audit) forfeits the peer, overriding any declared winner. Reconnect replays the log from a snapshot and resends missing actions. Details in `tech.md` § Coordinator.
- **Crypto hardening**: card values are squares (quadratic residues) and the modulus is a safe prime (`DEFAULT_PRIME`, 256-bit), closing a leak where each hidden card's quadratic-residue bit was public and correlated with its land. The coordinator refuses non-safe moduli. Also fixed `generatePrime` looping forever on bit lengths that are not a multiple of 8.
- **Engine fix**: the land being played could be spent to pay for its controller's own counter-counter, crashing the later `allow`. Found by coordinator random play.
- **Transports**: WebRTC with copy-paste invite/reply codes (non-trickle ICE, pre-negotiated `game` and `presence` channels), BroadcastChannel for two tabs (reload-safe hello/ack), and a `PeerTransport` interface adding presence and status. Details in `tech.md` § Transport interface.
- **Tests**: 91 passing (`npm test`): the above plus coordinator setup, random full games in lockstep, every failure-policy branch, reconnect (reload, lost in-flight action, live transport swap, drop mid-audit), signalling codes, and full matches over the fake-WebRTC and BroadcastChannel transports.
- **Demo**: `npm run demo` plays a scripted 13-turn match through two peer states, asserting lockstep hash equality on every action, then runs an SRA epilogue.
- **Tooling**: `npm run typecheck`, `npm test`, `npm run demo`. Node 24 type stripping, no runtime dependencies.

## Not done

1. **Real-browser WebRTC check**: needs a page; do it with the first board build.
2. **`src/board/`**: DOM rendering of hand, battlefield, graveyard, counter and target prompts, Swamp reveal view, signalling UI, snapshot storage for reconnect.
3. **`docs/design/design.md`**: UI/UX design is still a stub.

## Next step

The board, starting with the design doc (still a stub) and a minimal page that runs a match over the BroadcastChannel transport, then WebRTC.

## Open items and risks

- SRA is malleable and not IND-CPA; accepted for a homebrew game (see `tech.md`).
- The modulus is a fixed 256-bit safe prime by choice (homebrew game, fast setup); a larger one can be swapped in later.
- A player who disconnects and never returns is unresolved (no arbiter).
- Presence messages travel but nothing produces or validates them yet (clamping is a board job).
- The default STUN server is Google's public one: third-party, sees connection metadata only. Confirm this fits "no server at all".
