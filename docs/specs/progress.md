# Progress

Status of the web Land Game against `spec.md` and `../tech/tech.md`. Last updated: 2026-10-24.

## Summary

Rules engine and the cryptographic match primitives are done and tested. Nothing networked or visual exists yet. A CLI demo exercises engine + match layers end to end.

| Layer | Path | Status |
| --- | --- | --- |
| Engine (pure rules) | `src/engine/` | Done |
| Match: hash chain / canonical JSON / SHA-256 | `src/match/log.ts` | Done |
| Match: Mental Poker (SRA) + reveal verify + audit | `src/match/sra.ts` | Done |
| Match: spend-known-first helper | `src/match/spend-known-first.ts` | Done |
| Match: coordinator (lockstep, protocol over messages) | `src/match/coordinator.ts` | Not started |
| Transport (WebRTC, manual SDP, two data channels) | `src/transport/` | Not started |
| Board (DOM UI) | `src/board/` | Not started |
| Design doc | `docs/design/design.md` | Stub |

## Done

- **Spec and tech docs**, including the corrected SRA 4-step deck setup (A owner bulk-lock + shuffle, B other bulk-lock + shuffle, C owner per-slot keys in place, D other per-slot keys in place), the blindness argument, sha256-derived canonical card values, and removal of `revealedToOpponent` (hidden is `land === null`).
- **Engine**: `createGame`, `apply`, `legalActions`, `counterResponder`, `winReason`. Phases `main / respond / revealHand / target / drawKey / over`. Illegal actions throw `IllegalActionError`. Enforces spend-known-first, counter chains (parity decides resolution), win checked on entry before the effect, empty-deck draw loss.
- **Match crypto**: pure-TS SHA-256 (standard vectors), canonical JSON, hash-chained log, SRA primitives, deck protocol, play-time reveal verification, end-of-game audit.
- **Tests**: 56 passing (`npm test`), covering the rules matrix, spend-known-first, log/hash, and crypto (including rigged deck and lying proof).
- **Demo**: `npm run demo` plays a scripted 13-turn match through two peer states, asserting lockstep hash equality on every action, then runs an SRA epilogue.
- **Tooling**: `npm run typecheck`, `npm test`, `npm run demo`. Node 24 type stripping, no runtime dependencies.

## Not done

1. **`src/match/coordinator.ts`**: orchestrate the two-party protocol over real messages (deck setup steps, draw-key grants, reveal proofs, action broadcast, hash comparison, desync/cheat handling, end-of-game audit).
2. **`src/transport/`**: WebRTC peer connection with manual SDP signalling, a reliable ordered channel for game traffic and an unreliable channel for presence; a transport interface so tests can use an in-memory pair.
3. **`src/board/`**: DOM rendering of hand, battlefield, graveyard, counter and target prompts, Swamp reveal view, signalling UI.
4. **`docs/design/design.md`**: UI/UX design is still a stub.

## Next step

Build the coordinator against an in-memory transport so the full two-peer game can be tested without a browser, then add the WebRTC transport, then the board.

## Open items and risks

- SRA is malleable and not IND-CPA; accepted for a homebrew game (see `tech.md`).
- Coordinator must decide behaviour on hash mismatch, bad reveal proof, and peer disconnect/reconnect.
- Presence channel semantics are specified but unimplemented.
- Everything so far is on `main`, committed once (`1d27684`).
