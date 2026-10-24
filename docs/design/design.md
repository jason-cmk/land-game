# Design

Companion to `docs/specs/spec.md`. Status: **first slice built**. The decisions below are what the first playable board does; everything under *Questions to resolve here* is still open.

Direction from the brief, to be developed here:

- Playing should feel like sitting across from a person, not using a website.
- Cards as physical objects: hover and drag are visible to the opponent in real time.
- Simple art for now: lands that read as simplified MTG basics, abstract MTG-style card backs.
- Expressive effect animations, e.g. a Mountain becoming a meteor that crushes the targeted land.
- Performance is a feature. Deep modularity so features can be added or replaced without touching the core.
- Reference points: the webOS project (native-program feel, modularity) and Hearthstone (physicality of cards).

Presence signals (hover, drag, cursor) are cosmetic. They travel on their own throwaway channel and never touch game state. Technically, see the ephemeral channel in `docs/tech/tech.md`.

## Decided so far

- **Rendering:** the table is a PixiJS (WebGL) canvas; everything around it (lobby, invite codes, status line, buttons) is plain HTML. HTML gives text input, copy-paste and screen readers for free; WebGL is where card tilt, glow and particle effects will live. Board state and input logic stay separate from drawing, so the renderer can change without touching the rest.
- **Layout (from the viewer's seat):** five rows top to bottom: their hand, their battlefield, the middle (the land being played sits here during a counter chain), your battlefield, your hand. Graveyards are small fanned piles left of each battlefield; decks are piles on the right with a count.
- **Cards glide between zones.** Every card is one persistent sprite that eases toward its new position, so plays, counters and destroys read as movement before any bespoke animation exists.
- **Interaction is click-first.** Playable hand cards glow gold. Clicking one plays it, or, if it needs a declared target, lifts it and makes the valid targets glow red; click a target to play, anything else to cancel. Counter-chain choices (allow, or each Island + other pair) and Pass are buttons in the status bar. Resign asks for confirmation.
- **Forced moves are invisible.** Granting draw keys and revealing a hand to Swamp happen automatically.
- **Hidden information:** opponent hand cards are backs until revealed; a revealed card stays face-up in their hand with a light strip along the bottom.
- **Placeholder art:** coloured card faces with the land name; a brown abstract card back.

## Questions to resolve here

- Board layout: battlefield, hand, graveyards, deck counts, turn and phase indicators.
- Interaction model: drag versus click-to-play, targeting, cancelling a target, how a counter chain is presented so it reads clearly.
- How hidden information is shown: what a reveal looks like, whether revealed cards stay marked.
- Animation vocabulary per land effect, and how they stay in sync with engine events.
- Whether WebAssembly earns a place.
- Drag-to-play in addition to click, and the presence signals that go with it.
- Card and card-back visual design.
- How presence signals look on the receiving side without being distracting.
