# Land Game

Web implementation of the Basic Land Game, a homebrew two-player game using MTG land cards. Peer-to-peer with no server: lockstep rules engine, hash-chained action log, and Mental Poker (SRA) for hidden-deck fairness.

## Docs

Read these before changing behaviour. The spec is the source of truth; anything in `tech.md` that contradicts it is a bug.

- `docs/specs/spec.md`: game rules and product brief
- `docs/tech/tech.md`: engine, state/event model, cryptography, lockstep protocol, transport
- `docs/design/design.md`: UI/UX design (stub)
- `docs/specs/progress.md`: what's done, what's next, open risks. Update it when work lands.

## Layout

- `src/engine/`: pure rules engine
- `src/match/`: hash chain log, SRA deck protocol, match helpers
- `test/`: `node:test` specs
- `demo/demo.ts`: CLI demo of a scripted match

## Commands

Node 24+ (native TypeScript type stripping), no runtime dependencies.

- `npm run typecheck`
- `npm test`
- `npm run demo`
