# Technical design

Companion to `docs/specs/spec.md`. This file holds the decisions that are too detailed for the spec: engine shape, state and event model, Mental Poker cryptography, lockstep protocol, transport and verification.

Anything in here can change. Anything that contradicts the spec is a bug in this file.

## Constraints that shape everything

1. **No server.** Static assets only. Every hosted-service-shaped solution is out.
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
- Enforce this with `dependency-cruiser` or ESLint's `import/no-restricted-paths`.

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

We use the classic **SRA commutative cipher** over a shared 2048-bit safe prime $p$ (where $q = (p - 1) / 2$ is also prime, standard RFC 3526 MODP group), implemented in ~120 lines of vanilla TypeScript using native `BigInt`.

Because modular exponentiation commutes:

$$(m^e \bmod p)^d \equiv m^{e \cdot d \bmod (p-1)} \equiv m \pmod p$$

two players can lock and unlock cards in any order:

$$E_A(E_B(m)) = E_B(E_A(m))$$

### 1. Card encoding

Before shuffling, a player's 50-card deck consists of 50 distinct plaintext integers $m_0 \dots m_{49}$, where each $m_k$ encodes `(landType, copyIndex, fixedDomainPadding)` and is derived deterministically as `sha256("land-game/card/v1|deck <seat>|slot <k>|salt <n>|p <prime>")`, taking the first non-zero, non-duplicate result. Because $p$ is prime and $0 < m_k < p$, every value is invertible under the Fermat-based SRA arithmetic — the quadratic-residue construction originally considered here is unnecessary. Having 50 distinct canonical values ensures neither player can stack 11 Islands into their initial deck without being caught at the end-of-game audit.

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
3. If the check fails, the peer cheated and the match aborts immediately.

### 5. End-of-game deck audit

When the game enters `phase: 'over'`, both players broadcast all 50 of their per-slot keys $(d_{0,0..49}, d_{1,0..49})$. Both clients unlock every remaining card in both decks and verify that the 50 unlocked plaintexts in each deck are an exact permutation of the 50 canonical cards (10 of each basic land).

## Event log and hash chain

```ts
interface LogEntry {
  seq: number;                       // 0-based, contiguous
  actor: Seat | 'system';
  action: Action | { type: 'start'; deckHash0: string; deckHash1: string };
  stateHash: string;                 // sha256(canonicalJson(state))
  prevHash: string;                  // hex, 64 chars; '' for seq 0
  hash: string;                      // sha256(canonicalJson({ seq, actor, action, stateHash, prevHash }))
}
```

- Canonical encoding: sorted keys, no whitespace, integers as integers, UTF-8.
- Because both browsers run the identical `GameState`, every action message includes the sender's new `headHash`. The receiver applies the action locally and compares `headHash`. Any mismatch immediately halts the match as void.

## Protocol

### Messages

Reliable, ordered channel:

```ts
type Reliable =
  | { t: 'hello'; protocol: 1; rules: 1; turnCommit: string }
  | { t: 'helloAck'; protocol: 1; rules: 1; turnCommit: string }
  | { t: 'turnReveal'; seed: string }
  | { t: 'shuffleStep'; deckOwner: Seat; step: 'A' | 'B' | 'C' | 'D'; cards: string[] }
  | { t: 'action'; seq: number; action: Action; headHash: string }
  | { t: 'audit'; keys: string[] }
  | { t: 'bye'; reason: 'closed' | 'void' | 'done'; detail?: string };
```

- Who goes first (`activeSeat` on turn 1) is decided before the shuffle by a simple 2-party coin flip (`turnCommit` / `turnReveal`: XOR of two committed random bits).
- After the 4-step shuffle completes for both decks, the opening 5 draws per player run through `grantDrawKey` actions (`seq: 1..10`), and Turn 1 begins.

Ephemeral, unordered, drop-tolerant channel:

```ts
type Ephemeral =
  | { t: 'hoverHand'; index: number | null }          // visual index 0..handCount-1, NEVER CardId!
  | { t: 'hoverBoard'; card: CardId | null }          // battlefield or graveyard card (already public)
  | { t: 'dragHand'; index: number; x: number; y: number }
  | { t: 'cursor'; x: number; y: number };
```

- **Why `hoverHand` and `dragHand` use `index` instead of `CardId`:** each player's board visually shuffles their hand whenever a card is added to it, and keeps the mapping from visual index to `CardId` local. Sending only the visual index `0 .. hand.length - 1` lets the opponent see *which physical card in your hand you are hovering or dragging* (the Hearthstone feel) without ever revealing whether you are hovering a newly drawn card or a card returned from the graveyard by Forest.
- Coordinates are normalised 0–1 relative to the board, throttled to ~20 Hz.

### Transport interface

```ts
interface MatchTransport {
  readonly seat: Seat; // 0 for inviter, 1 for joiner
  open(): Promise<void>;
  send(msg: Reliable): void;
  sendEphemeral(msg: Ephemeral): void;
  onMessage(cb: (m: Reliable) => void): () => void;
  onEphemeral(cb: (m: Ephemeral) => void): () => void;
  onStatus(cb: (s: TransportStatus) => void): () => void;
  close(): void;
}
```

Two implementations, chosen at match start:

- **`BroadcastChannelTransport`** — two tabs on one machine, same origin. Development and hotseat testing.
- **`WebRtcTransport`** — direct peer connection with manual copy/paste SDP signalling (compressed with `CompressionStream('deflate-raw')` and base64url-encoded), using two data channels: `game` (ordered, reliable) and `presence` (`{ ordered: false, maxRetransmits: 0 }`).

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

- **Reconnect.** A dropped peer connection currently means a lost match. Resuming would require re-establishing the WebRTC channel and replaying the log (both peers can keep their keys and log in `sessionStorage`).
- **Presence abuse.** Ephemeral messages are unvalidated by nature; clamp coordinates to `0..1` and `index` to `0..hand.length - 1`.
