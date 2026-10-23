# Design

Companion to `docs/specs/spec.md`. Status: **stub**. Nothing here is decided beyond what the spec already states; it exists so the open design questions have a home.

Direction from the brief, to be developed here:

- Playing should feel like sitting across from a person, not using a website.
- Cards as physical objects: hover and drag are visible to the opponent in real time.
- Simple art for now: lands that read as simplified MTG basics, abstract MTG-style card backs.
- Expressive effect animations, e.g. a Mountain becoming a meteor that crushes the targeted land.
- Performance is a feature. Deep modularity so features can be added or replaced without touching the core.
- Reference points: the webOS project (native-program feel, modularity) and Hearthstone (physicality of cards).

Presence signals (hover, drag, cursor) are cosmetic. They travel on their own throwaway channel and never touch game state. Technically, see the ephemeral channel in `docs/tech/tech.md`.

## Questions to resolve here

- Board layout: battlefield, hand, graveyards, deck counts, turn and phase indicators.
- Interaction model: drag versus click-to-play, targeting, cancelling a target, how a counter chain is presented so it reads clearly.
- How hidden information is shown: what a reveal looks like, whether revealed cards stay marked.
- Animation vocabulary per land effect, and how they stay in sync with engine events.
- Rendering approach and whether WebAssembly earns a place.
- Card and card-back visual design.
- How presence signals look on the receiving side without being distracting.
