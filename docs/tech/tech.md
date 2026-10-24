# Technical design

Companion to `docs/specs/spec.md`. This file holds the decisions that are too detailed for the spec: engine shape, state and event model, Mental Poker cryptography, lockstep protocol, transport and verification.

Anything in here can change. Anything that contradicts the spec is a bug in this file.

## Constraints that shape everything

1. **No trusted server.** The game is static assets; nothing we run or rely on has authority over a match. Players may find each other through untrusted public relays (Trystero), which only carry the two connection messages; everything that decides a match is verified by both peers.
2. **Symmetric peer-to-peer lockstep.** Both browsers run the exact same deterministic engine over the same shared state. Neither peer is a trusted authority.
3. **Mental Poker for hidden information.** Decks are shuffled and locked together using commutative encryption (SRA). Unrevealed cards live inside the shared engine state as locked slots (`land: null`) until the rules call for them to be unlocked.
4. **Strict layer separation.** The engine knows nothing about the board or cryptography; the board knows no rules; the transport knows no game.
5. **TypeScript, close to vanilla.** No framework by default. Add a library only where it clearly pays for itself.

## Layering

```
board/       rendering, input, animation, presence      knows: match, transport
   │
match/       lockstep coordinator, Mental Poker crypto, action log, hashing
   │
engine/      pure rules: state, actions, events         knows: nothing
   │
transport/   peer connection, message channels          knows: nothing
```

Rules about direction:

- `engine/` imports nothing from the other three. It has no DOM access, no timers, and no BigInt crypto math — it only sees card slots that are either still hidden (`land: null`) or revealed (`land: Land`).
- `transport/` imports nothing from `engine/` or `board/`. Messages are opaque payloads to it.
- `board/` may import everything. It is the only layer allowed to touch the DOM, canvas, WebGL or `requestAnimationFrame`.
- `match/` may import `engine/` and `transport/`, never `board/`. Only `board/` may use npm packages (PixiJS).
- `engine/` also never touches timers, the clock, randomness or BigInt: both peers must compute identical states.
- Enforced by `test/layers.spec.ts` (part of `npm test`), a dependency-free stand-in for `dependency-cruiser`: it reads every module specifier under `src/` and scans the engine's code (comments and strings stripped) for those globals. The separate DOM-typed `tsconfig.board.json` keeps DOM types out of the other layers at compile time.

## Engine

### State and card slots

In a lockstep Mental Poker game, both peers hold the **identical** public `GameState`. A card slot starts with `land: null` while in the library or unrevealed in a hand, and transitions to `land: Land` the moment it is publicly revealed (played, discarded for an Island counter, or revealed by Swamp).

Each player also holds a local `PrivateKnowledge` map (`Map<CardId, Land>`) for their own decrypted hand cards, which `match/` maintains as draw keys arrive.

```ts
type Seat = 0 | 1;
type Land = 'forest' | 'island' | 'mountain' | 'plains' | 'swamp';
type CardId = string; // deterministic slot ID: e.g. 'p0-slot-07'

interface CardSlot {
  readonly id: CardId;
  readonly land: Land | null; // null until publicly revealed to both peers; null IS the hidden flag
}

interface PlayerState {
  library: CardSlot[];      // index 0 is the top of the deck
  hand: CardSlot[];
  battlefield: CardSlot[];  // always has land !== null
  graveyard: CardSlot[];    // always has land !== null
}

type Phase = 'drawKey' | 'main' | 'respond' | 'target' | 'revealHand' | 'over';

interface GameState {
  readonly rulesVersion: 1;
  readonly turn: number;
  readonly activeSeat: Seat;
  readonly phase: Phase;
  readonly players: readonly [PlayerState, PlayerState];
  readonly pending: PendingPlay | null;
  readonly winner: { seat: Seat; reason: 'domain' | 'mono' | 'decked' | 'resign' } | null;
}
```

- Card slot IDs are deterministic by seat and post-shuffle deck index: `p0-slot-00` through `p0-slot-49`.
- `GameState` is immutable. Every action applied by both peers produces the exact same next `GameState`.
- Whenever a card is needed in `phase: 'drawKey'` (start-of-turn draw, opening hand, or Island resolution), the non-drawing player must supply their per-card decryption key for that slot before play proceeds.

### "Hand shuffle": spend known copies first

A card's land type is publicly known exactly when `land !== null` (e.g. it was returned from the graveyard by **Forest**, or revealed earlier by **Swamp**).

If that player also holds a hidden copy (`land === null`) of the **same** `Land` type in their hand, playing or discarding the hidden copy would leak to the opponent that the player held *two* copies of that land.

To match the exact mathematics of shuffling your hand in paper Magic without needing an extra cryptographic re-encryption round:

1. **Canonical slot selection:** When a player chooses to play or discard a land of type `L` from hand, if their hand contains both a public slot (`land === L`) and a hidden slot (`land === null`, privately known to be `L`), `match/` **always selects the public slot**. The engine enforces this independently on `apply()`.
2. **Result:** The already-known slot moves to the battlefield or graveyard, and the hidden slot remains cryptographically locked (`land: null`) in hand. The opponent learns zero additional information.

### Turn and response model

With counters chaining back and forth, the responder is derived from counter parity:

```
responder = counters % 2 === 0 ? other(activeSeat) : activeSeat
```

`pending.counters` counts counters played so far. Even means the non-active player is deciding; odd means the active player is deciding whether to counter the counter. A declared target cannot change during the chain.

| Phase | Who acts | Legal actions |
|---|---|---|
| `drawKey` | opponent of the drawing player | `grantDrawKey`, `resign` |
| `main` | active seat | `play`, `pass`, `resign` |
| `respond` | `responder` above | `counter`, `allow`, `resign` |
| `revealHand` | opponent of Swamp controller | `revealHandForSwamp`, `resign` |
| `target` | controller of the pending play | `resolveTarget`, `resign` |
| `over` | nobody | — |

### Pending play and target declaration

What is declared at announcement versus chosen at resolution is a rules requirement:

| Land | Declared at announcement | Chosen at resolution |
|---|---|---|
| Mountain | the opponent's battlefield land to destroy | — |
| Forest | the graveyard land to return | — |
| Plains | which non-Plains land on your battlefield it reuses | whatever that land's effect needs (`revealHand` → `target` for Swamp, `drawKey` for Island, or `target` for Mountain/Forest) |
| Swamp | — | first opponent runs `revealHandForSwamp`, then Swamp controller runs `resolveTarget` |
| Island | — | opponent grants draw key (`grantDrawKey`) for the top card of library |

### Actions and events

Every action that makes a hidden card public carries the card's plaintext `land` and the owner's decryption key (`ownerKey`) so `match/` can verify it against the Mental Poker deck before passing the action to `engine.apply()`.

```ts
interface CardRevealProof {
  card: CardId;
  land: Land;
  ownerKey: string; // hex BigInt decryption exponent for this slot
}

type Action =
  | { type: 'grantDrawKey'; card: CardId; lockKey: string }
  | { type: 'play'; reveal: CardRevealProof; declaredTarget?: CardId }
  | { type: 'pass' }
  | { type: 'counter'; island: CardRevealProof; other: CardRevealProof }
  | { type: 'allow' }
  | { type: 'revealHandForSwamp'; hand: CardRevealProof[] }
  | { type: 'resolveTarget'; target: CardId }
  | { type: 'resign' };

interface Event {
  type: string; // e.g. 'landPlayed', 'countered', 'landDestroyed', 'cardDrawn', 'handRevealed'
  seat: Seat;
  card?: CardId;
  target?: CardId;
}

function legalActions(state: GameState, seat: Seat, privateHand?: ReadonlyMap<CardId, Land>): Action[];
function apply(state: GameState, action: Action): { state: GameState; events: Event[] };
```

### Determinism rules

Non-negotiable inside `engine/`:

- No `Math.random`, no `Date.now`, no `crypto.randomUUID`, no `performance.now`.
- No floating point arithmetic. Integers only.
- No iteration over object keys. Arrays only.
- Every sort has an explicit comparator.
- Time is never read. Turn and counter counts are the clock.

## Mental Poker cryptography (`match/crypto`)

We use the classic **SRA commutative cipher** over a shared 256-bit safe prime $p$ (where $q = (p - 1) / 2$ is also prime; `DEFAULT_PRIME` in `src/match/sra.ts`), implemented in ~120 lines of vanilla TypeScript using native `BigInt`.

Because modular exponentiation commutes:

$$(m^e \bmod p)^d \equiv m^{e \cdot d \bmod (p-1)} \equiv m \pmod p$$

two players can lock and unlock cards in any order:

$$E_A(E_B(m)) = E_B(E_A(m))$$

### 1. Card encoding

Before shuffling, a player's 50-card deck consists of 50 distinct plaintext integers $m_0 \dots m_{49}$, where each $m_k$ encodes `(landType, copyIndex, fixedDomainPadding)` and is derived deterministically as $h^2 \bmod p$ with $h$ = `sha256("land-game/card/v2|deck <seat>|slot <k>|salt <n>|p <prime>")`, taking the first result that is greater than 1 and not a duplicate (1 is excluded because it encrypts to itself). Because $p$ is prime and $0 < m_k < p$, every value is invertible under the Fermat-based SRA arithmetic.

**Why squares and a safe prime.** Encrypting with an odd exponent preserves the Legendre symbol, so if card values were a mix of quadratic residues and non-residues, anyone could read that bit off a hidden slot, and it correlates with the land. Squaring makes every card a residue, and with a safe prime the residues form a subgroup of prime order $q$, so no other small-subgroup character leaks either. The coordinator refuses a modulus that is not a safe prime.

**Key size.** 256 bits is a deliberate choice for a homebrew game: setup is about 600 modular exponentiations in pure-BigInt JS, and a 2048-bit modulus would make it noticeably slow. A larger safe prime can replace `DEFAULT_PRIME` later without protocol changes. Having 50 distinct canonical values ensures neither player can stack 11 Islands into their initial deck without being caught at the end-of-game audit.

### 2. Two-party shuffle and double-lock (per deck)

To prepare Seat 0's 50-card library (and symmetrically Seat 1's library):

1. **Seat 0 bulk-encrypts and shuffles:** Seat 0 generates a single random bulk key pair $(e_0, d_0)$ with $\gcd(e_0, p-1) = 1$ and $e_0 \cdot d_0 \equiv 1 \pmod{p-1}$, computes $c_k = m_k^{e_0} \bmod p$ for all 50 cards, shuffles the list of 50 values, and sends it to Seat 1.
2. **The 4-message SRA shuffle** for Seat 0's deck is:
   - **Step A (Seat 0 → Seat 1):** Seat 0 encrypts all 50 canonical cards under bulk key $e_0$, shuffles, and sends `[m^e0]`.
   - **Step B (Seat 1 → Seat 0):** Seat 1 shuffles that list and encrypts all 50 under bulk key $e_1$, sending `[m^(e0*e1)]`.
   - **Step C (Seat 0 → Seat 1):** Seat 0 decrypts every slot with $d_0$ (leaving `m^e1`) and applies a fresh per-slot key $e_{0,i}$ to each slot $i \in 0..49$ **in place, with no shuffle**, sending `[m^(e1 * e0,i)]`.
   - **Step D (Seat 1 → Seat 0):** Seat 1 decrypts every slot with $d_1$ and applies a fresh per-slot key $e_{1,i}$ to each slot **in place, with no shuffle**, publishing the final double-locked deck $D_0[i] = m_{\pi(i)}^{e_{0,i} \cdot e_{1,i}} \bmod p$.

**Why neither player learns the contents/order** (this is why C and D must not shuffle):

- Seat 1's Step B shuffle operates on a list locked by Seat 0's key, so Seat 1 can track the permutation but not the plaintext behind any position.
- Seat 0 can follow its own Step A shuffle, but cannot see through Seat 1's Step B shuffle, so Seat 0 cannot map plaintexts to final slots.
- C and D attach per-slot keys in place so that each side's secret for final slot $i$ stays aligned with final slot $i$; any further shuffle would sever that alignment.

At the end of Step D:
- Both peers hold the identical 50 double-locked ciphertexts $D_0[0..49]$ (and $D_1[0..49]$ for Seat 1's deck).
- Neither player knows the permutation $\pi$.
- Slot $i$ is locked by both Seat 0's key $d_{0,i}$ and Seat 1's key $d_{1,i}$.

### 3. Drawing a card (private to the drawer)

When Seat 0 draws slot $i$ (`p0-slot-i`):
1. Seat 1 sends `grantDrawKey` with $d_{1,i}$.
2. Both peers compute the single-locked value $S_0[i] = D_0[i]^{d_{1,i}} \bmod p = m_{\pi(i)}^{e_{0,i}} \bmod p$ and store it for slot $i$.
3. Seat 0 privately applies their own key $d_{0,i}$ locally: $m = S_0[i]^{d_{0,i}} \bmod p$, looks up $m$ in the canonical 50-card table, and records the `Land` in their local `PrivateKnowledge`.
4. Seat 1 cannot read $S_0[i]$ because Seat 0 has not revealed $d_{0,i}$.

### 4. Playing, discarding, or revealing a card (public verification)

When Seat 0 plays slot $i$, discards it for an Island counter, or reveals it to a Swamp:
1. Seat 0 includes `CardRevealProof { card: 'p0-slot-i', land, ownerKey: d_{0,i} }` in the action.
2. Both peers compute $S_0[i]^{d_{0,i}} \bmod p$ and verify that it equals one of the 50 valid canonical card encodings and matches `land`.
3. If the check fails, the peer forfeits (see *Coordinator* below).

### 5. End-of-game deck audit

When the game enters `phase: 'over'`, both players broadcast all 50 of their per-slot keys $(d_{0,0..49}, d_{1,0..49})$. Both clients unlock every remaining card in both decks and verify that the 50 unlocked plaintexts in each deck are an exact permutation of the 50 canonical cards (10 of each basic land).

## Event log and hash chain

```ts
interface LogEntry {
  seq: number;                       // 0-based, contiguous
  seat: number;                      // acting seat; -1 for the start entry
  action: MatchAction | StartRecord; // wire actions, keys included (src/match/protocol.ts)
  stateHash: string;                 // sha256(canonicalJson(state)) after the action
  prevHash: string;                  // 'genesis' for seq 0
  hash: string;                      // sha256(canonicalJson({ seq, seat, action, stateHash, prevHash }))
}
```

Entry 0 is the `start` record: who goes first, both final double-locked decks, and both seats' opening-hand keys. Logging the keys with the actions means the log alone, plus a seat's own secrets, rebuilds that seat's full view.

- Canonical encoding: sorted keys, no whitespace, integers as integers, UTF-8.
- Because both browsers run the identical `GameState`, every action message includes the sender's new `headHash`. The receiver applies the action locally and compares `headHash`. Any mismatch voids the match.

## Protocol

### Messages

Reliable, ordered channel:

```ts
type Message = // src/match/protocol.ts
  | { t: 'hello'; protocol: 1; rules: 1; prime: string; turnCommit: string }
  | { t: 'turnReveal'; seed: string }
  | { t: 'shuffleStep'; deckOwner: Seat; step: 'A' | 'B' | 'C' | 'D'; cards: string[] }
  | { t: 'openingKeys'; keys: string[] }               // our keys for the opponent's slots 0-4
  | { t: 'ready'; headHash: string }                   // hash of log entry 0
  | { t: 'action'; seq: number; action: MatchAction; headHash: string }
  | { t: 'resume'; length: number; headHash: string }  // after a reconnect
  | { t: 'audit'; ownDeck: string[]; otherDeck: string[] }
  | { t: 'bye'; reason: 'void' | 'forfeit'; detail: string };
```

- Both seats send `hello` at once; there is no ack. Both must use the same SRA modulus.
- Who goes first (`activeSeat` on turn 1) is a 2-party coin flip: `turnCommit = sha256(seed)` in `hello`, then `turnReveal`; first seat is the XOR of the seeds' low bits.
- Each seat starts step A of its own deck as soon as it has the peer's `hello`; both decks shuffle in parallel.
- The opening hands are dealt by the engine at `createGame`; their keys travel as `openingKeys` during setup, not as `grantDrawKey` actions, and are recorded in log entry 0.
- `MatchAction` is the engine `Action` plus keys: `grantDrawKey` carries the granter's per-slot key, and every hidden card a `play`, `counter` or `revealHandForSwamp` makes public carries `{ card, land, ownerKey }`.

Ephemeral, unordered, drop-tolerant channel:

```ts
type Presence = // src/board/presence.ts
  | { t: 'hoverHand'; index: number | null }          // index among the sender's HIDDEN hand cards, in its visual order. Never a CardId.
  | { t: 'hoverBoard'; card: CardId | null }          // any public card: battlefield, graveyard, the stack, revealed hand cards
  | { t: 'cursor'; x: number; y: number }             // 0-1 in the sender's view; the receiver flips y
  | { t: 'dragHand'; index: number; x: number; y: number } // a hidden hand card being dragged, indexed as for hoverHand
  | { t: 'dragBoard'; card: CardId; x: number; y: number } // a public card being dragged (a revealed hand card)
  | { t: 'dragEnd' };                                 // best effort; the receiver also lets go after 0.6 s without updates
```

- **Why `hoverHand` and `dragHand` use `index` instead of `CardId`:** each player's board visually shuffles their hand whenever a card is added to it, and keeps the mapping from visual index to `CardId` local. Sending only the visual index `0 .. hand.length - 1` lets the opponent see *which physical card in your hand you are hovering or dragging* (the Hearthstone feel) without ever revealing whether you are hovering a newly drawn card or a card returned from the graveyard by Forest.
- Coordinates are normalised 0–1 relative to the board, throttled to ~20 Hz.
- A drag replaces cursor messages while it lasts (its x/y move the cursor dot too). The receiver forgets a drag whenever the game state changes, because the play can overtake its own `dragEnd` on the other channel and a hand index may then name a different card.
- The receiver validates everything: an out-of-range index, a hidden card named by id, or a non-finite coordinate maps to nothing.

### Transport interface

`src/transport/types.ts`. The coordinator needs only the reliable channel; real links add presence and status:

```ts
interface Transport<Message> {
  send(message: Message): void;                                   // dropped once closed
  onMessage(listener: (message: Message) => void): () => void;    // in send order
  close(): void;
}

interface PeerTransport<Message, Presence> extends Transport<Message> {
  readonly seat: 0 | 1;                                           // fresh match: 0 inviter, 1 joiner; reconnect: as before
  sendPresence(presence: Presence): void;                         // best effort
  onPresence(listener: (presence: Presence) => void): () => void;
  onStatus(listener: (status: 'open' | 'disconnected' | 'closed') => void): () => void;
}
```

Implementations:

- **`createMemoryPair`** (`memory.ts`): `Transport` only, for tests. Async delivery, structured-cloned messages.
- **`connectBroadcast(room, seat)`** (`broadcast.ts`): two tabs on one machine, same origin, over `BroadcastChannel`. Development and hotseat play. Resolves once each tab has heard the other's hello; an open tab always acknowledges a fresh hello, so a reloaded tab can rejoin. Closing a tab sends `bye`, which closes the other end.
- **`createInvite()` / `joinInvite(code)`** (`webrtc.ts`): direct WebRTC with manual copy-paste signalling. The inviter's invite code goes to the joiner, whose reply code comes back to `invite.accept(code)`. ICE is not trickled: each side waits for gathering to finish (5 s cap) so one paste each way carries every candidate. Two pre-negotiated channels (ids 0 and 1, so no in-band channel handshake): `game` (ordered, reliable) and `presence` (`{ ordered: false, maxRetransmits: 0 }`). Payloads are JSON; anything else from the peer is dropped. `failed` or `closed` connection states close the transport; `disconnected` is reported and may recover.
- **Signalling codes** (`signal.ts`): `LG1.` + base64url of `deflate-raw`-compressed JSON `{ type, sdp, seat?, match? }`. `seat` is the inviter's seat (offers); `match` is set only when reconnecting. Whitespace is ignored on paste; pasting the wrong kind of code gets a specific message.
- **ICE servers:** default is one public STUN server (`stun:stun.l.google.com:19302`), configurable. STUN sees connection metadata only, never game traffic. There is no TURN relay, so strict NATs still fail.
- **Reconnect over WebRTC**: a fresh invite/reply exchange with `createInvite({ reconnect: { match, seat } })` / `joinInvite(code, { reconnect })`, then `coordinator.reconnect(newTransport)`. Either player may invite: the code carries the inviter's seat and the joiner takes the other. `match` is the hash of log entry 0 (the agreed decks), which both sides hold; a code from another match, a fresh-match code, or your own code pasted back is refused with a `SignalError` before any connection is attempted.

`RTCPeerConnection` is reached through small structural types, so the module typechecks without DOM types and tests inject a fake (`test/transport/fake-webrtc.ts`). Node has no WebRTC, so the real browser path is still unverified.

## Coordinator (`src/match/coordinator.ts`)

One `MatchCoordinator` per seat runs setup, play and audit over a `Transport`. The board calls `legalActions()` and `submit(action)` with plain engine actions; the coordinator attaches keys, verifies everything the peer sends, and keeps the log.

- **Listener errors are ours, not the peer's.** An exception thrown by an `onChange` listener goes to `onListenerError` (default: rethrown on a fresh task), never into the failure policy.
- **Forced moves are automatic.** Granting a draw key and revealing a hand to Swamp have exactly one legal move, so the coordinator sends them itself.
- **Failure policy:**
  - Head hash or sequence mismatch, version or modulus mismatch: **void**. Nobody can tell which side diverged, so there is no result.
  - Anything that fails verification (bad draw key, bad reveal proof, an action the engine rejects, a duplicate or out-of-range deck value, a failed audit, a malformed message): **the peer forfeits**, even when the game already had a winner. The outcome keeps the failure detail, because a bug in our own code looks the same as tampering.
  - Either way the coordinator sends `bye`; the receiving side records a void, since it cannot check the claim.
  - Only the honest browser enforces a forfeit; with no server, a cheating client can display whatever it likes.
- **Outcome:** a normal finish is final only after the audit passes on both decks.
- **Reconnect:** `snapshot()` returns the log plus this seat's secrets; the `persist` hook receives one before every action is sent, so a seat's saved log always contains everything it sent. `MatchCoordinator.resume(snapshot, transport)` replays the log through the engine, re-verifying every entry, and `reconnect(transport)` swaps the transport on a live coordinator. Both then send `resume`; the side that is ahead resends the actions the other is missing, and a finished match resends its audit. Setup is not resumable: a drop before log entry 0 means starting again.

## Migrating to an authoritative server later

Even though we use peer-to-peer lockstep with Mental Poker now, `engine/` has zero cryptography inside it: it only consumes `Action` objects and updates `CardSlot` values from `land: null` to `land: Land`. If you ever introduce an authoritative server later, the server simply holds the plaintext deck and emits the exact same `Action` stream without the SRA exponentiation wrapper in `match/crypto`.

## Testing

- **Mental Poker crypto tests.** Encrypt 50 cards through steps A→B→C→D, unlock individual slots, verify commutative property, verify tampered keys and tampered decks (e.g. 11 Islands) are caught.
- **Rules matrix.** One test per land per edge case: counter chains of length 1–4, Plains reusing each land, effects with no legal target, decking out, and the win-before-effect-resolution rule.
- **"Spend known copies first" test.** Player holds 1 revealed Island (from Forest or Swamp) and 1 unrevealed Island (from deck); playing or countering with an Island must always consume the revealed slot and leave the unrevealed slot `land: null`.
- **Lockstep determinism.** Two `MatchCoordinator` instances wired in memory play full random games; their `stateHash` and `headHash` must match after every single action.

## Proposed layout

```
docs/
  specs/spec.md
  tech/tech.md
  design/design.md
src/
  engine/        state, actions, rules per land                   (no deps, no DOM, no crypto)
  match/         lockstep coordinator, SRA mental poker, log/hash (no DOM)
  transport/     interface, broadcast-channel, webrtc, signalling
  board/         rendering, input, animation, presence, chrome
test/
index.html
```

## Open questions

- **Reconnect storage.** The board keeps each tab's snapshot in `sessionStorage` (two tabs: per room and seat; online: one key, replaced by a new match and cleared when a match ends). It survives a reload but not closing the tab. Snapshots contain secrets; `sessionStorage` keeps them per tab and per origin.
- **Presence abuse.** Ephemeral messages are unvalidated by nature; clamp coordinates to `0..1` and `index` to `0..hand.length - 1`.
