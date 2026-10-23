# The land game

## The ask
I want to create a web version of the "Land Game". The Land Game is a homebrew game using MTG land cards.

This spec covers the game rules and the high-level shape of the product. Detailed technical and design decisions live in `docs/tech/tech.md` and `docs/design/design.md`, which are created as those decisions are made.

## Product shape
The product is two parts, deliberately kept separate:

1. **The game engine.** Everything about game state, legal actions and who may act. No rendering, no animation, no networking knowledge.
2. **The player board.** Everything the player sees and does: the table, cards, interaction, animation, and the real-time "feel" of playing against a person.

The boundary is a state contract. The engine exposes the current state plus the actions available to each player, and accepts actions back. The board never contains rules logic, and the engine never knows what a card looks like.

### Game engine
- **Scope:** the state of the game, the actions taken so far, and whose action it is. Nothing else.
- **Deterministic:** the same starting state plus the same ordered actions always produce the same state. This is what makes replays, verification and an authoritative copy possible.
- **Event-sourced:** state is derived by applying an ordered log of events. The log is the record of the game; the current state is a projection of it. This gives us history for free: replays, step-through, and a verifiable transcript of a match.
- **Turn and response model:** the engine must model the moments where a player has a chance to respond, not just an alternating turn order. Playing a land is announced, the opponent may counter, and the original player may counter that counter, and so on. The engine decides who may act at each such moment and refuses anything else.
- **Hidden information:** neither browser holds the full plaintext state during play. Hidden cards (libraries and unrevealed hand cards) stay cryptographically locked under Mental Poker until a game rule reveals or plays them. When a player holds both a known copy and a hidden copy of the same land type, playing or discarding that land type always spends the known copy first so the hidden card stays secret, matching a shuffled hand in paper play.
- **Interface:** a small set of operations to read state, read legal actions, and submit an action. Transport-agnostic, so it can run in a browser tab, in two tabs talking to each other, or in tests.

### Player board
- **Goal:** playing it should feel like sitting across a table from a person, not like using a website.
- **Physical feel:** cards should feel like objects. Hovering a card shows your opponent you are considering it, in real time. Dragging a card shows your opponent the movement as it happens. These presence signals are cosmetic: they are outside the engine and must never affect state.
- **Performance and modularity:** smooth under animation, and built so features can be added or replaced without touching the core. The reference points are the webOS project (deep modularity, native-program feel) and Hearthstone (cards as physical objects).
- **Rendering:** free choice of approach, including WebAssembly where it earns its place. The board is also expected to draw at least some non-card graphics, so a real rendering layer is likely rather than plain DOM only.
- **Animation:** effects should be expressive, for example a Mountain becoming a meteor that crushes the targeted land. Effects are driven by engine events, but how they look and how long they take is entirely the board's business.
- **Art direction:** simple for now, and open to change. Cards should read as simplified MTG basic lands; card backs as an abstract MTG card.
- **What the board does not own:** whose turn it is, what is legal, what a card does. It reflects the engine and asks the engine what it may do next.

## Rules of the game

Source: [The Basic Land Game: Rules, Gameplay & Strategy](https://ultimateguard.com/en/blog/basic-land-game-rules-gameplay-strategy-magic-the-gathering-skura) (Skura, Ultimate Guard, 10.10.2024)

### Premise
The game is played using only the five basic lands: Plains, Island, Swamp, Mountain and Forest.

### Goal
You win as soon as you have either of the following on the battlefield:
- **Domain:** one of each of the five basic lands.
- **Mono:** five copies of a single basic land.

You can meet either condition at any point. For example, with 3 Island, 3 Mountain, 3 Swamp and 4 Forest in play, you are one Plains (Domain) or one Forest (Mono) away from winning.

### Deck composition
- Each player's deck has 10 of each basic land, for 50 cards in total.

### Starting the game
- Each player draws an opening hand of 5 cards.
- There are no mulligans.

### Turn structure
- Each player draws one card at the start of their turn. The player who goes first skips the draw on their first turn.
- Each player gets one land drop per turn.
- There is no maximum hand size.

### Land abilities
Each basic land triggers an effect when it is played.

| Land | Based on | Effect when played |
|------|----------|--------------------|
| **Forest** | Regrowth | Choose a land in your graveyard and return it to your hand. |
| **Swamp** | Thoughtseize | Look at your opponent's hand and choose a land from it for them to discard. |
| **Mountain** | Stone Rain | Choose a land your opponent controls and destroy it. |
| **Island** | Draw / Force of Will | **When played:** draw a card. **From hand (counter):** see below. |
| **Plains** | Cloudshift | Choose one of your other lands that is not a Plains and reuse its effect. |

#### Island counter
- When your opponent plays a land, you can discard an Island from your hand along with one other land to counter it.
- A countered land does not enter play, and its effect does not happen. It goes to its owner's graveyard, where a Forest can later return it.
- Any land play can be countered, including an Island being played for its draw.
- **Countering a counter:** the player whose land is being countered can respond with their own Island counter (Island plus one other land). This can go back and forth as long as players have the cards. Whoever makes the last counter wins the exchange. An odd number of counters means the land is countered. An even number means it resolves.
- **What can be countered:** only a land being played from hand. When a Plains reuses another land's effect, that reused effect is not a separate play and cannot be countered by itself. To stop it, counter the Plains when it is played.

#### What each player knows before deciding to counter
The rules follow normal Magic stack behaviour: a target chosen when the spell is cast is known, but a choice made when the spell resolves is not.

| Land played | Revealed before a counter decision? |
|-------------|-------------------------------------|
| Mountain | Yes. The targeted land is known. |
| Forest | Yes. The land chosen from the graveyard is known. |
| Swamp | No. The land to discard is chosen as the effect resolves. |
| Plains | The land being reused is known. Choices made by that land's effect are not. For example, if Plains reuses a Forest, the opponent knows it is a Forest but not which land will be returned. |

#### Plains clarifications
- Plains can only reuse a land that is not a Plains, so two Plains cannot reuse each other forever to force a draw.

### Clarifications and house rules
The Ultimate Guard article does not cover the rules below. They come from our decisions, from normal Magic rules, and from other published versions of the game:
- MTG Wiki: https://mtg.wiki/page/Basic_land_game
- Robopenguins' open-source digital version, which also follows the Ultimate Guard rules: https://github.com/axlan/basic-land-game
- YesTCG's "Vegas Rules": https://yestcg.com/basic-land-game

#### Passing
- A player may choose not to play a land on their turn.

#### Forest
- Forest only returns a land from **your own** graveyard, not your opponent's.

#### Lands with nothing to act on
- A land with nothing to act on can still be played. It enters play and its effect does nothing. This matches normal Magic rules.
  - **Forest** with an empty graveyard: no effect.
  - **Mountain** when the opponent has no lands in play: no effect.
  - **Swamp** when the opponent's hand is empty: no effect.
  - **Plains** with no other non-Plains land in play: no effect.
  - **Plains** reusing a land whose effect has nothing to act on: no effect.

#### When a win happens
- Win conditions are checked as soon as a land enters play. If that land completes Domain or Mono, the player wins straight away, before the land's own effect resolves.
- **A counter cancels the win.** If the land that would complete Domain or Mono is countered, it never enters play and the player does not win.
- A player can only play lands on their own turn, and Island counters are the only action allowed on the opponent's turn. So once a winning land enters play, the opponent has no way to take the win back.

#### Running out of cards
- If a player has to draw a card and their deck is empty, that player loses the game. This is the normal Magic rule, and it is what YesTCG uses in their rules. Robopenguins' version instead lets the game continue without drawing, but we are not using that.
- The same applies to a card drawn by an effect, such as an Island being played.

### Historical and community variants (not in use)
- Island used to be "Scry 2". It was dropped because it was too weak.
- Plains used to have an Opt effect. Cloudshift replaced it.
- Swamp is the most house-ruled card across playgroups (random discard, opponent chooses, or "Blackmail" where the opponent reveals 3 and you pick 1). We use the Ultimate Guard **Thoughtseize** rule (look at the opponent's full hand and choose 1 to discard) because it gives Swamp a strategic role scouting for Island counters, and the digital board tracks revealed cards automatically so it never slows the game down.

## Technical direction
- **No server at all.** Not just no game server: nothing is hosted except static client assets. Both browsers run the game engine and talk directly to each other. This is a hard goal for the project, not a preference.
- **Player-to-player communication is WebRTC.** Two browsers connect directly over data channels. There is no relay, no matchmaking service and no signalling service.
- **Starting a match is manual.** One player generates an invite code, the other pastes it in and returns a reply code. Two copy-pastes, no infrastructure. We are deliberately stopping here rather than adding a signalling service.
- **Two data channels.** A reliable, ordered channel for game messages, and an unreliable, unordered channel for cosmetic presence (hover, drag). Presence can never delay a game action or block on a dropped packet.
- **Peer-to-peer lockstep with Mental Poker.** Both browsers run the same deterministic engine in lockstep — neither player is a privileged host. Decks are shuffled and double-locked together using commutative encryption (Mental Poker / SRA), so neither player can see the opponent's hand *or* their own future draws until a card is actually drawn or revealed.
- **Deterministic engine.** The engine is a pure function from state plus action to new state, with no ambient randomness or clock. Both peers apply the exact same action log and verify every state hash and card reveal.
- **Stack:** TypeScript, and otherwise as close to vanilla as practical. WebAssembly is allowed where it clearly pays for itself, such as heavy rendering or simulation.
- **Shared state:** the game state as a single object is the intent. How that object is held, projected and synchronised is a `tech.md` decision, not a spec-level one.
- **Deferred:** recorded games, ranking, spectators, matchmaking at scale. The event log and deterministic engine are chosen partly so these stay cheap to add later.

## Anti-tampering
With no server, the two clients police each other through cryptography and deterministic lockstep.

- **Mental Poker prevents peeking.** Every card in both libraries is encrypted by both players during the shuffle handshake. Drawing a card requires the opponent to send their per-card decryption key for that slot, leaving it locked only by the drawing player's key. Neither player can peek at the opponent's hand or at upcoming cards in either library.
- **Every reveal is cryptographically verified.** When a card is played, discarded for an Island counter, or revealed by a Swamp, its decryption key is shared and checked against the encrypted deck committed at setup. A player cannot lie about what card was in a slot.
- **Spend known copies first ("hand shuffle").** If a card in hand is already known to the opponent (returned from the graveyard by Forest, or seen earlier via Swamp) and the player holds another hidden copy of the same land type, playing or discarding that land type automatically spends the already-known copy. On the presence channel, hand hovers and drags send visual hand index rather than card slot ID. Together, this preserves the exact information hiding of shuffling your hand in paper Magic.
- **Hash chain over the action log.** Every action is appended to a SHA-256 hash chain that both engines step through identically. If the two sides ever disagree on a hash, the match is void: nobody can tell who diverged. If a key or reveal fails verification, or the end-of-game audit fails, the peer that sent it forfeits, even if the game had already declared a winner.
- **End-of-game deck audit.** When a match ends, both players reveal their remaining keys so both clients can verify that each 50-card deck contained the legal 10 copies of each basic land.
- **Unverifiable claims (disconnects) still need an arbiter.** If a losing player simply closes their tab, proving *who* unplugged requires a third-party witness, which belongs with the deferred recorded-games and ranking work.

## Documentation map
- `docs/specs/spec.md` (this file): product shape, game rules, high-level architecture and constraints.
- `docs/tech/tech.md`: engine design, state and event model, Mental Poker protocol, sync and transport, verification mechanics, build and testing.
- `docs/design/design.md`: board layout, interaction, animation, art direction, the presence signals, rendering approach.

## Open questions
- **Abandonment.** A dropped connection can be resumed by replaying the action log once both players reconnect. A player who never comes back is still unresolved.
- **NAT failures.** Direct connections fail on some networks, and with no relay those matches simply cannot happen. Needs a clear failure message at minimum.
- **The cost of the invite flow.** Two copy-pastes is fine for a friend match and friction for anything wider. Deliberately accepted for now.

