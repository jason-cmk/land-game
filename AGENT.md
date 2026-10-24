# Land Game

Web implementation of the Basic Land Game, a homebrew two-player game using MTG land cards. Peer-to-peer with no server: lockstep rules engine, hash-chained action log, and Mental Poker (SRA) for hidden-deck fairness.

## Docs

Read these before changing behaviour. The spec is the source of truth; anything in `tech.md` that contradicts it is a bug.

- `docs/specs/spec.md`: game rules and product brief
- `docs/tech/tech.md`: engine, state/event model, cryptography, lockstep protocol, transport
- `docs/design/design.md`: UI/UX design: what's decided for the board, and open questions
- `docs/specs/progress.md`: what's done, what's next, open risks. Update it when work lands.

## Layout

- `src/engine/`: pure rules engine
- `src/match/`: hash chain log, SRA deck protocol, lockstep coordinator
- `src/transport/`: transport interface, in-memory pair, BroadcastChannel, WebRTC
- `src/bot/`: the computer opponent (a pure policy, and a runner driving one seat's coordinator)
- `test/`: `node:test` specs
- `src/board/`, `index.html`: the player board (PixiJS table, HTML chrome)
- `demo/demo.ts`: CLI demo of a scripted match

## Commands

Node 24+ (native TypeScript type stripping). Runtime dependency: PixiJS (board only). Vite for dev and build.

- `npm run dev`: board at http://localhost:5173 (play the computer, or open two tabs)
- `npm run build`
- `npm run typecheck`
- `npm test`
- `npm run demo`
- `npm run smoke`: headless-Chrome play-through of the board (two tabs, reload, real WebRTC, a touch phone, the computer); needs Chrome or Chromium (`CHROME_PATH` to override)
