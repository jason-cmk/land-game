// Full rules matrix for the engine, driven by an omniscient test harness:
// the harness plays the referee role the match layer performs in production,
// claiming the plaintext land of every drawn card as it installs keys.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, apply, counterResponder, legalActions } from '../../src/engine/game.ts';
import { stateHashOf } from '../../src/match/log.ts';
import type { Action, CardId, GameState, Land, Seat } from '../../src/engine/types.ts';
import { IllegalActionError, other } from '../../src/engine/types.ts';

// ---------------------------------------------------------------------------
// Omniscient driver
// ---------------------------------------------------------------------------

class Game {
  s: GameState;
  /** Test-side claims: what each hidden slot "really is". */
  known = new Map<CardId, Land>();

  constructor(active: Seat = 0) {
    this.s = createGame(active);
  }

  act(seat: Seat, action: Action): void {
    this.s = apply(this.s, seat, action);
  }

  expectError(seat: Seat, action: Action, part?: string): void {
    assert.throws(
      () => apply(this.s, seat, action),
      (err: unknown) => {
        assert.ok(err instanceof IllegalActionError, `expected IllegalActionError, got ${String(err)}`);
        if (part) assert.match(err.message, new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
      },
    );
  }

  claim(card: CardId, land: Land): void {
    this.known.set(card, land);
  }

  /** Private knowledge of a seat as the board would supply it. */
  privOf(seat: Seat): Map<CardId, Land> {
    const priv = new Map<CardId, Land>();
    for (const slot of this.s.players[seat].hand) {
      const land = slot.land ?? this.known.get(slot.id);
      if (land !== undefined) priv.set(slot.id, land);
    }
    return priv;
  }

  /** Grant the pending draw key; optionally claim the drawn card's land. Returns the drawn card id. */
  grantDraw(land?: Land): CardId {
    assert.equal(this.s.phase, 'drawKey', 'grantDraw called when no draw is pending');
    const draw = this.s.awaitingDraw!;
    if (land !== undefined) this.claim(draw.card, land);
    this.act(other(draw.seat), { type: 'grantDrawKey', card: draw.card });
    return draw.card;
  }

  play(seat: Seat, card: CardId, land: Land, declaredTarget?: CardId): void {
    this.act(seat, { type: 'play', card, land, ...(declaredTarget !== undefined ? { declaredTarget } : {}) });
  }
}

/** Play one Island through an empty chain; ends with the next turn's start draw granted. */
function turnIsland(g: Game, seat: Seat, card: CardId): [CardId, CardId] {
  g.play(seat, card, 'island');
  g.act(other(seat), { type: 'allow' });
  const islandDrawn = g.grantDraw('island'); // the island's draw for the acting player
  const nextStart = g.grantDraw('island'); // start-of-turn draw for the next player
  return [islandDrawn, nextStart];
}

/** Pass the current turn (start draw already granted). */
function passTurn(g: Game): void {
  g.act(g.s.activeSeat, { type: 'pass' });
  g.grantDraw();
}

// ---------------------------------------------------------------------------
// Opening state
// ---------------------------------------------------------------------------

test('opening state: 45-card library, 5-card hand, turn 1 in main, everything hidden', () => {
  const g = new Game(0);
  const [p0, p1] = g.s.players;
  assert.equal(g.s.turn, 1);
  assert.equal(g.s.phase, 'main');
  assert.equal(g.s.activeSeat, 0);
  assert.equal(g.s.winner, null);
  assert.equal(g.s.pending, null);
  assert.equal(g.s.awaitingDraw, null);

  for (const player of [p0!, p1!]) {
    assert.equal(player.library.length, 45);
    assert.equal(player.hand.length, 5);
    assert.equal(player.battlefield.length, 0);
    assert.equal(player.graveyard.length, 0);
    for (const slot of [...player.library, ...player.hand]) {
      assert.equal(slot.land, null);
    }
  }
  assert.equal(p0!.library[0]!.id, 'p0-slot-05');
  assert.equal(p0!.hand.map((s) => s.id).join(','), 'p0-slot-00,p0-slot-01,p0-slot-02,p0-slot-03,p0-slot-04');
  assert.equal(p1!.hand[0]!.id, 'p1-slot-00');
});

// ---------------------------------------------------------------------------
// Island cycle and turn structure
// ---------------------------------------------------------------------------

test('island resolves after allow: battlefield, chained draw keys, next turn', () => {
  const g = new Game(0);
  turnIsland(g, 0, 'p0-slot-00');

  const [p0, p1] = g.s.players;
  assert.equal(g.s.turn, 2);
  assert.equal(g.s.activeSeat, 1);
  assert.equal(g.s.phase, 'main');
  assert.deepEqual(p0!.battlefield.map((s) => s.land), ['island']);
  assert.equal(p0!.hand.some((s) => s.id === 'p0-slot-00'), false);
  // p0: opening 5 - 1 played + 1 island draw = 5
  assert.equal(p0!.hand.length, 5);
  // p1: opening 5 + 1 start-of-turn draw = 6
  assert.equal(p1!.hand.length, 6);
  // drawn cards are still hidden in the shared state
  assert.equal(g.s.players[0].hand[4]!.land, null);
});

test('turn 1 has no start-of-turn draw: after playing, only the island draw is pending', () => {
  const g = new Game(0);
  g.play(0, 'p0-slot-00', 'island');
  g.act(1, { type: 'allow' });

  // the island draw popped the top card into p0's hand already
  assert.equal(g.s.players[0].hand.length, 5);
  const draw = g.s.awaitingDraw!;
  assert.equal(draw.seat, 0);
  assert.equal(draw.purpose, 'effectDraw');
});

test('grantDrawKey by the drawer or for the wrong card is illegal', () => {
  const g = new Game(0);
  g.play(0, 'p0-slot-00', 'island');
  g.act(1, { type: 'allow' });
  const draw = g.s.awaitingDraw!;
  g.expectError(0, { type: 'grantDrawKey', card: draw.card });
  g.expectError(1, { type: 'grantDrawKey', card: 'p1-slot-00' });
});

test('allow by the wrong seat, and playing while not the active player, are illegal', () => {
  const g = new Game(0);
  g.play(0, 'p0-slot-00', 'island');
  g.expectError(0, { type: 'allow' });
  g.expectError(1, { type: 'play', card: 'p1-slot-00', land: 'island' });
});

// ---------------------------------------------------------------------------
// Counter chain
// ---------------------------------------------------------------------------

test('single counter: pair paid immediately, play countered on allow, turn advances', () => {
  const g = new Game(0);
  g.claim('p1-slot-00', 'island');
  g.claim('p1-slot-01', 'swamp');

  g.play(0, 'p0-slot-00', 'island');
  g.act(1, { type: 'counter', island: 'p1-slot-00', islandLand: 'island', other: 'p1-slot-01', otherLand: 'swamp' });

  assert.equal(g.s.phase, 'respond');
  assert.equal(g.s.pending?.counters, 1);
  assert.deepEqual(g.s.players[1].graveyard.map((s) => s.id), ['p1-slot-00', 'p1-slot-01']);
  assert.equal(g.s.players[1].hand.some((s) => s.id === 'p1-slot-00'), false);

  g.act(0, { type: 'allow' }); // odd -> countered
  assert.deepEqual(g.s.players[0].graveyard.map((s) => s.id), ['p0-slot-00']);
  assert.equal(g.s.players[0].battlefield.length, 0);
  assert.equal(g.s.turn, 2);
  assert.equal(g.s.activeSeat, 1);
  assert.equal(g.s.phase, 'drawKey');
  assert.equal(g.s.winner, null);
});

test('two counters then allow: the play resolves', () => {
  const g = new Game(0);
  g.claim('p1-slot-00', 'island');
  g.claim('p1-slot-01', 'forest');
  g.claim('p0-slot-01', 'island');
  g.claim('p0-slot-02', 'mountain');

  g.play(0, 'p0-slot-00', 'island');
  g.act(1, { type: 'counter', island: 'p1-slot-00', islandLand: 'island', other: 'p1-slot-01', otherLand: 'forest' });
  assert.equal(counterResponder(g.s.pending!), 0);
  g.act(0, { type: 'counter', island: 'p0-slot-01', islandLand: 'island', other: 'p0-slot-02', otherLand: 'mountain' });
  assert.equal(counterResponder(g.s.pending!), 1);
  g.act(1, { type: 'allow' }); // even -> resolves

  assert.deepEqual(g.s.players[0].battlefield.map((s) => s.land), ['island']);
  assert.equal(g.s.players[0].graveyard.length, 2);
  assert.equal(g.s.players[1].graveyard.length, 2);
  // the island draw is pending; the turn advances only once its key is granted
  assert.equal(g.s.turn, 1);
  assert.equal(g.s.phase, 'drawKey');
  g.grantDraw('island');
  g.grantDraw('island');
  assert.equal(g.s.turn, 2);
  assert.equal(g.s.activeSeat, 1);
});

test('three counters then allow: the play is countered', () => {
  const g = new Game(0);
  g.claim('p1-slot-00', 'island');
  g.claim('p1-slot-01', 'forest');
  g.claim('p1-slot-02', 'plains');
  g.claim('p1-slot-03', 'swamp');
  g.claim('p0-slot-01', 'island');
  g.claim('p0-slot-02', 'mountain');

  g.play(0, 'p0-slot-00', 'island');
  g.act(1, { type: 'counter', island: 'p1-slot-00', islandLand: 'island', other: 'p1-slot-01', otherLand: 'forest' });
  g.act(0, { type: 'counter', island: 'p0-slot-01', islandLand: 'island', other: 'p0-slot-02', otherLand: 'mountain' });
  g.act(1, { type: 'counter', island: 'p1-slot-02', islandLand: 'island', other: 'p1-slot-03', otherLand: 'swamp' });
  g.act(0, { type: 'allow' }); // odd -> countered

  assert.equal(g.s.players[0].battlefield.length, 0);
  assert.equal(g.s.players[1].graveyard.length, 4);
  // the countered play lands after the counter pair was already paid
  assert.deepEqual(g.s.players[0].graveyard.map((s) => s.id), ['p0-slot-01', 'p0-slot-02', 'p0-slot-00']);
});

test('counter validation: non-Island lead, duplicated slot, unknown card', () => {
  const g = new Game(0);
  g.claim('p1-slot-00', 'island');
  g.play(0, 'p0-slot-00', 'island');

  g.expectError(1, { type: 'counter', island: 'p1-slot-01', islandLand: 'swamp', other: 'p1-slot-02', otherLand: 'forest' });
  g.expectError(1, { type: 'counter', island: 'p1-slot-00', islandLand: 'island', other: 'p1-slot-00', otherLand: 'island' });
  g.expectError(1, { type: 'counter', island: 'p1-slot-00', islandLand: 'island', other: 'not-a-card', otherLand: 'island' });
});

test('the land being played cannot pay for a counter-counter', () => {
  const g = new Game(0);
  g.claim('p1-slot-00', 'island');
  g.claim('p1-slot-01', 'forest');
  g.claim('p0-slot-01', 'island');

  g.play(0, 'p0-slot-00', 'island');
  g.act(1, { type: 'counter', island: 'p1-slot-00', islandLand: 'island', other: 'p1-slot-01', otherLand: 'forest' });
  g.expectError(0, { type: 'counter', island: 'p0-slot-01', islandLand: 'island', other: 'p0-slot-00', otherLand: 'island' }, 'not in seat 0');
  g.expectError(0, { type: 'counter', island: 'p0-slot-00', islandLand: 'island', other: 'p0-slot-01', otherLand: 'island' }, 'not in seat 0');

  const priv = new Map(g.known);
  const offered = legalActions(g.s, 0, priv).filter((a) => a.type === 'counter');
  assert.ok(offered.every((a) => a.type === 'counter' && a.island !== 'p0-slot-00' && a.other !== 'p0-slot-00'));
});

test('play during the respond chain, and cards not in hand, are illegal', () => {
  const g = new Game(0);
  g.claim('p0-slot-01', 'island');
  g.play(0, 'p0-slot-00', 'island');
  g.expectError(0, { type: 'play', card: 'p0-slot-01', land: 'island' });
  g.act(1, { type: 'allow' });
  g.grantDraw();
  g.grantDraw(); // turn 2, p1 to act
  g.expectError(1, { type: 'play', card: 'p0-slot-02', land: 'island' }); // p0's card
  g.expectError(1, { type: 'play', card: 'p1-slot-40', land: 'island' }); // still in library
});

test('playing a card already played this turn is illegal (it left the hand)', () => {
  const g = new Game(0);
  g.play(0, 'p0-slot-00', 'island');
  g.act(1, { type: 'allow' });
  g.grantDraw('island'); // island draw for p0
  // p0's turn is over: they may not play again
  g.expectError(0, { type: 'play', card: 'p0-slot-01', land: 'island' });
});

// ---------------------------------------------------------------------------
// Mountain
// ---------------------------------------------------------------------------

test('mountain destroys its declared opponent land when it resolves', () => {
  const g = new Game(0);
  turnIsland(g, 0, 'p0-slot-00'); // t1: p0 island
  turnIsland(g, 1, 'p1-slot-00'); // t2: p1 island -> t3
  g.claim('p0-slot-01', 'mountain');
  g.play(0, 'p0-slot-01', 'mountain', 'p1-slot-00');
  g.act(1, { type: 'allow' });

  assert.deepEqual(g.s.players[1].battlefield, []);
  assert.deepEqual(g.s.players[1].graveyard.map((s) => s.id), ['p1-slot-00']);
  assert.deepEqual(g.s.players[0].battlefield.map((s) => s.land), ['island', 'mountain']);
  assert.equal(g.s.phase, 'drawKey');
  assert.equal(g.s.awaitingDraw?.seat, 1);
});

test('mountain with no opponent lands in play: no target needed, no effect', () => {
  const g = new Game(0);
  g.claim('p0-slot-00', 'mountain');
  g.play(0, 'p0-slot-00', 'mountain');
  g.act(1, { type: 'allow' });
  assert.deepEqual(g.s.players[0].battlefield.map((s) => s.land), ['mountain']);
  assert.equal(g.s.phase, 'drawKey');
});

test('mountain target must be an opponent battlefield land', () => {
  const g = new Game(0);
  g.claim('p0-slot-00', 'mountain');
  g.expectError(0, { type: 'play', card: 'p0-slot-00', land: 'mountain', declaredTarget: 'p1-slot-00' }); // p1 hand
  g.expectError(0, { type: 'play', card: 'p0-slot-00', land: 'mountain', declaredTarget: 'p0-slot-02' }); // own hand
});

// ---------------------------------------------------------------------------
// Forest
// ---------------------------------------------------------------------------

test('forest returns a graveyard land to hand, still publicly known', () => {
  const g = new Game(0);
  turnIsland(g, 0, 'p0-slot-00'); // t1 -> t2
  g.claim('p1-slot-00', 'island');
  g.claim('p0-slot-01', 'island');
  g.claim('p0-slot-02', 'forest');
  g.play(1, 'p1-slot-00', 'island'); // t2: p1 island
  g.act(0, { type: 'counter', island: 'p0-slot-01', islandLand: 'island', other: 'p0-slot-02', otherLand: 'forest' });
  g.act(1, { type: 'allow' }); // countered; p1's island buried -> t3
  g.grantDraw('island'); // t3 start draw for p0
  g.act(0, { type: 'pass' }); // t3 -> t4
  g.grantDraw('forest'); // t4 start draw for p1
  g.play(1, 'p1-slot-01', 'forest', 'p1-slot-00'); // return the buried island
  g.act(0, { type: 'allow' });

  const p1 = g.s.players[1];
  assert.equal(p1.graveyard.length, 0);
  assert.deepEqual(p1.hand.find((s) => s.id === 'p1-slot-00'), { id: 'p1-slot-00', land: 'island' });
  assert.equal(g.s.phase, 'drawKey');
});

test('forest with an empty graveyard: no target needed, no effect', () => {
  const g = new Game(0);
  g.claim('p0-slot-00', 'forest');
  g.play(0, 'p0-slot-00', 'forest');
  g.act(1, { type: 'allow' });
  assert.equal(g.s.phase, 'drawKey');
});

// ---------------------------------------------------------------------------
// Swamp
// ---------------------------------------------------------------------------

test('swamp: opponent reveals the whole hand, controller picks the discard', () => {
  const g = new Game(0);
  g.claim('p0-slot-00', 'swamp');
  for (const id of ['p1-slot-00', 'p1-slot-01', 'p1-slot-02', 'p1-slot-03', 'p1-slot-04']) g.claim(id, 'island');

  g.play(0, 'p0-slot-00', 'swamp');
  g.act(1, { type: 'allow' });
  assert.equal(g.s.phase, 'revealHand');

  const reveal = g.s.players[1].hand.map((slot) => ({ card: slot.id, land: 'island' as Land }));
  g.act(1, { type: 'revealHandForSwamp', cards: reveal });
  assert.equal(g.s.phase, 'target');

  g.act(0, { type: 'resolveTarget', target: 'p1-slot-02' });
  assert.deepEqual(g.s.players[1].graveyard.map((s) => s.id), ['p1-slot-02']);
  assert.deepEqual(g.s.players[1].hand.find((s) => s.id === 'p1-slot-01'), { id: 'p1-slot-01', land: 'island' });
  assert.equal(g.s.phase, 'drawKey');
});

test('swamp reveal must cover exactly the whole hand, only by the hand owner', () => {
  const g = new Game(0);
  g.claim('p0-slot-00', 'swamp');
  for (const id of ['p1-slot-00', 'p1-slot-01', 'p1-slot-02', 'p1-slot-03', 'p1-slot-04']) g.claim(id, 'island');
  g.play(0, 'p0-slot-00', 'swamp');
  g.act(1, { type: 'allow' });

  const full = g.s.players[1].hand.map((slot) => ({ card: slot.id, land: 'island' as Land }));
  const [first, ...rest] = full;
  g.expectError(1, { type: 'revealHandForSwamp', cards: rest }); // incomplete
  g.expectError(1, { type: 'revealHandForSwamp', cards: [first!, ...full] }); // duplicate
  g.expectError(1, { type: 'revealHandForSwamp', cards: [{ card: 'p9-slot-99', land: 'island' }] }); // foreign
  g.expectError(0, { type: 'revealHandForSwamp', cards: full }); // wrong seat
});

// ---------------------------------------------------------------------------
// Plains
// ---------------------------------------------------------------------------

test('plains: draw a card, then the turn ends', () => {
  const g = new Game(0);
  g.claim('p0-slot-00', 'plains');
  g.play(0, 'p0-slot-00', 'plains');
  g.act(1, { type: 'allow' });
  assert.deepEqual(g.s.players[0].battlefield.map((s) => s.land), ['plains']);
  assert.equal(g.s.phase, 'drawKey');
  assert.equal(g.s.awaitingDraw?.seat, 0);
  assert.equal(g.s.awaitingDraw?.purpose, 'effectDraw');
  assert.equal(g.s.players[0].hand.length, 5); // four left after the play, plus the draw
  g.grantDraw('island');
  assert.equal(g.s.turn, 2);
  assert.equal(g.s.activeSeat, 1);
});

test('plains takes no declared target, and is offered as a single play', () => {
  const g = new Game(0);
  g.claim('p0-slot-00', 'island');
  g.claim('p0-slot-01', 'plains');
  turnIsland(g, 0, 'p0-slot-00'); // t1: island
  passTurn(g); // t2 -> t3
  g.expectError(0, { type: 'play', card: 'p0-slot-01', land: 'plains', declaredTarget: 'p0-slot-00' }, 'takes no declared target');
  const plays = legalActions(g.s, 0, g.privOf(0)).filter((a) => a.type === 'play' && a.land === 'plains');
  assert.deepEqual(plays, [{ type: 'play', card: 'p0-slot-01', land: 'plains' }]);
});

test('plains drawing from an empty deck loses', () => {
  const g = new Game(0);
  g.claim('p0-slot-00', 'plains');
  g.s = { ...g.s, players: [{ ...g.s.players[0], library: [] }, g.s.players[1]] };
  g.play(0, 'p0-slot-00', 'plains');
  g.act(1, { type: 'allow' });
  assert.deepEqual(g.s.winner, { seat: 1, reason: 'decked' });
});

// ---------------------------------------------------------------------------
// Spend known copies first (engine-enforced)
// ---------------------------------------------------------------------------

test('playing a hidden copy while a public copy of that land sits in hand is illegal; the public copy is fine', () => {
  const g = new Game(0);
  turnIsland(g, 0, 'p0-slot-00'); // t1
  g.claim('p1-slot-00', 'island');
  g.claim('p0-slot-01', 'island');
  g.claim('p0-slot-02', 'forest');
  g.play(1, 'p1-slot-00', 'island'); // t2
  g.act(0, { type: 'counter', island: 'p0-slot-01', islandLand: 'island', other: 'p0-slot-02', otherLand: 'forest' });
  g.act(1, { type: 'allow' }); // countered -> t3
  g.grantDraw('island');
  g.act(0, { type: 'pass' }); // t3 -> t4
  g.grantDraw('forest');
  g.play(1, 'p1-slot-01', 'forest', 'p1-slot-00'); // island returns to p1's hand publicly
  g.act(0, { type: 'allow' }); // -> t5
  g.grantDraw('island');
  g.act(0, { type: 'pass' }); // t5 -> t6
  g.grantDraw('island'); // p1's t6 start draw: a hidden island copy

  // p1 hand: p1-slot-00 (public island), p1-slot-07 (hidden island), others hidden
  g.expectError(1, { type: 'play', card: 'p1-slot-07', land: 'island' }, 'spend known copies first');
  g.play(1, 'p1-slot-00', 'island'); // the public copy: fine
  g.act(0, { type: 'allow' });
  assert.equal(g.s.phase, 'drawKey');
});

test('countering with a hidden Island while a public Island is in hand is illegal; the public copy is fine', () => {
  const g = new Game(0);
  const [islandDrawn0] = turnIsland(g, 0, 'p0-slot-00'); // t1 -> t2
  g.claim('p1-slot-00', 'island');
  g.claim('p0-slot-01', 'island');
  g.claim('p0-slot-02', 'forest');
  g.play(1, 'p1-slot-00', 'island'); // t2: p1 island
  g.act(0, { type: 'counter', island: 'p0-slot-01', islandLand: 'island', other: 'p0-slot-02', otherLand: 'forest' });
  g.act(1, { type: 'allow' }); // countered -> t3
  g.grantDraw('island'); // t3 start draw for p0
  g.act(0, { type: 'pass' }); // -> t4
  g.grantDraw('forest'); // t4 draw for p1
  g.play(1, 'p1-slot-01', 'forest', 'p1-slot-00'); // returns the island publicly into p1's hand
  g.act(0, { type: 'allow' }); // -> t5
  g.grantDraw('forest'); // t5 draw for p0
  g.claim('p1-slot-05', 'island'); // p1's hidden island (their t2 start draw, never revealed)
  g.play(0, islandDrawn0, 'island'); // t5: p0 island (their t1 island-draw card), p1 responds
  g.expectError(
    1,
    { type: 'counter', island: 'p1-slot-05', islandLand: 'island', other: 'p1-slot-02', otherLand: 'mountain' },
    'spend known copies first',
  );
  g.act(1, { type: 'counter', island: 'p1-slot-00', islandLand: 'island', other: 'p1-slot-02', otherLand: 'mountain' });
  g.act(0, { type: 'allow' }); // odd -> countered
  assert.equal(g.s.winner, null);
});

// ---------------------------------------------------------------------------
// Winning
// ---------------------------------------------------------------------------

test('mono: the fifth same land wins as it enters, before its effect resolves', () => {
  const g = new Game(0);
  turnIsland(g, 0, 'p0-slot-00'); // 1
  passTurn(g);
  turnIsland(g, 0, 'p0-slot-01'); // 2
  passTurn(g);
  turnIsland(g, 0, 'p0-slot-02'); // 3
  passTurn(g);
  turnIsland(g, 0, 'p0-slot-03'); // 4
  assert.equal(g.s.winner, null);
  passTurn(g);
  g.play(0, 'p0-slot-04', 'island'); // 5
  g.act(1, { type: 'allow' });

  assert.equal(g.s.phase, 'over');
  assert.deepEqual(g.s.winner, { seat: 0, reason: 'mono' });
  assert.equal(g.s.awaitingDraw, null); // no draw struck
});

test('a counter cancels the winning play: no win, game continues', () => {
  const g = new Game(0);
  turnIsland(g, 0, 'p0-slot-00');
  passTurn(g);
  turnIsland(g, 0, 'p0-slot-01');
  passTurn(g);
  turnIsland(g, 0, 'p0-slot-02');
  passTurn(g);
  turnIsland(g, 0, 'p0-slot-03');
  passTurn(g);
  g.claim('p1-slot-00', 'island');
  g.claim('p1-slot-01', 'forest');
  g.play(0, 'p0-slot-04', 'island'); // would be the fifth
  g.act(1, { type: 'counter', island: 'p1-slot-00', islandLand: 'island', other: 'p1-slot-01', otherLand: 'forest' });
  g.act(0, { type: 'allow' });

  assert.equal(g.s.winner, null);
  assert.equal(g.s.players[0].battlefield.length, 4);
  assert.deepEqual(g.s.players[0].graveyard.map((s) => s.id), ['p0-slot-04']); // only the countered island is buried
  assert.equal(g.s.phase, 'drawKey'); // turn 10 starting
});

test('domain: one of each land type wins', () => {
  const g = new Game(0);
  g.claim('p0-slot-00', 'island');
  g.claim('p0-slot-01', 'forest');
  g.claim('p0-slot-02', 'swamp');
  g.claim('p0-slot-03', 'plains');

  turnIsland(g, 0, 'p0-slot-00'); // t1: island
  passTurn(g); // t2 -> t3
  g.play(0, 'p0-slot-01', 'forest'); // t3: forest, no effect
  g.act(1, { type: 'allow' });
  g.grantDraw('forest'); // t4 draw for p1
  g.act(1, { type: 'pass' }); // -> t5
  g.grantDraw('swamp'); // t5 draw for p0
  g.play(0, 'p0-slot-02', 'swamp'); // t5: swamp; p1 hand nonempty
  g.act(1, { type: 'allow' });
  const reveal = g.s.players[1].hand.map((slot) => ({ card: slot.id, land: 'island' as Land }));
  g.act(1, { type: 'revealHandForSwamp', cards: reveal });
  g.act(0, { type: 'resolveTarget', target: 'p1-slot-01' });
  g.grantDraw('plains'); // t6 draw for p1
  g.act(1, { type: 'pass' }); // -> t7
  g.grantDraw('plains'); // t7 draw for p0
  g.play(0, 'p0-slot-03', 'plains'); // t7: plains draws
  g.act(1, { type: 'allow' });
  g.grantDraw('island'); // the plains draw for p0
  g.grantDraw('forest'); // t8 draw for p1
  g.act(1, { type: 'pass' }); // -> t9
  const mountainCard = g.grantDraw('mountain'); // t9 draw for p0
  g.play(0, mountainCard, 'mountain'); // fifth distinct land
  g.act(1, { type: 'allow' });

  assert.equal(g.s.phase, 'over');
  assert.deepEqual(g.s.winner, { seat: 0, reason: 'domain' });
});

// ---------------------------------------------------------------------------
// Decking out
// ---------------------------------------------------------------------------

test('a player required to draw from an empty deck loses at turn start', () => {
  const g = new Game(0);
  let guard = 0;
  while (g.s.phase !== 'over' && guard++ < 500) {
    if (g.s.phase === 'drawKey') {
      g.grantDraw();
    } else {
      g.act(g.s.activeSeat, { type: 'pass' });
    }
  }
  assert.equal(g.s.phase, 'over');
  assert.equal(g.s.winner?.reason, 'decked');
  const loser = g.s.winner!.seat === 0 ? 1 : 0;
  assert.equal(g.s.players[loser].library.length, 0);
  const total = g.s.players[loser].hand.length + g.s.players[loser].battlefield.length + g.s.players[loser].graveyard.length + g.s.players[loser].library.length;
  assert.equal(total, 50);
});

test('playing an Island with an empty deck decks the Island player out on the spot', () => {
  const g = new Game(0);
  // drive until the start of a p1 turn where p1 just drew their last library card
  let guard = 0;
  for (;;) {
    assert.ok(guard++ < 500, 'did not reach the endgame scenario');
    if (g.s.phase === 'over') assert.fail('game ended before reaching scenario');
    if (g.s.phase === 'drawKey') {
      const draw = g.s.awaitingDraw!;
      g.grantDraw();
      if (draw.seat === 1 && g.s.players[1].library.length === 0) {
        // below: after grant, phase is main and p1 to act on an empty library
        break;
      }
      continue;
    }
    g.act(g.s.activeSeat, { type: 'pass' });
  }
  assert.equal(g.s.phase, 'main');
  assert.equal(g.s.activeSeat, 1);
  const lastDrawn = g.s.players[1].hand[g.s.players[1].hand.length - 1]!.id;
  g.claim(lastDrawn, 'island');
  g.play(1, lastDrawn, 'island');
  g.act(0, { type: 'allow' });

  assert.equal(g.s.phase, 'over');
  assert.deepEqual(g.s.winner, { seat: 0, reason: 'decked' });
});

// ---------------------------------------------------------------------------
// Resign, misc
// ---------------------------------------------------------------------------

test('resign at any phase ends the game; later actions are illegal', () => {
  const g = new Game(0);
  g.play(0, 'p0-slot-00', 'island');
  g.act(1, { type: 'resign' });
  assert.deepEqual(g.s.winner, { seat: 0, reason: 'resign' });
  assert.equal(g.s.phase, 'over');
  assert.throws(() => apply(g.s, 0, { type: 'pass' }), IllegalActionError);
});

test('identical action streams produce identical state hashes; different setup does not', () => {
  const run = (): string => {
    const g = new Game(0);
    g.play(0, 'p0-slot-00', 'island');
    g.act(1, { type: 'counter', island: 'p1-slot-01', islandLand: 'island', other: 'p1-slot-02', otherLand: 'swamp' });
    g.act(0, { type: 'allow' });
    g.grantDraw('island'); // t2 start draw for p1
    return stateHashOf(g.s);
  };
  assert.equal(run(), run());
  assert.notEqual(stateHashOf(createGame(0)), stateHashOf(createGame(1)));
});

test('legalActions: main-phase drafts respect private knowledge and spend-known-first', () => {
  const g = new Game(0);
  g.claim('p0-slot-00', 'island');
  const priv = g.privOf(0);

  const forP1 = legalActions(g.s, 1, g.privOf(1));
  assert.deepEqual(forP1, []); // not the active seat

  const acts = legalActions(g.s, 0, priv);
  assert.ok(acts.some((a) => a.type === 'pass'));
  const islandPlays = acts.filter((a) => a.type === 'play' && a.card === 'p0-slot-00');
  assert.equal(islandPlays.length, 1);
  assert.deepEqual(islandPlays[0], { type: 'play', card: 'p0-slot-00', land: 'island' });
  // no other land has claims, so no other play drafts
  const otherPlays = acts.filter((a) => a.type === 'play' && a.card !== 'p0-slot-00');
  assert.deepEqual(otherPlays, []);

  // without private knowledge no hidden slot turns into an action
  const blind = legalActions(g.s, 0);
  assert.ok(blind.some((a) => a.type === 'pass'));
  assert.equal(blind.some((a) => a.type === 'play'), false);
});

test('legalActions: drawKey grants, and respond offers allow plus counter drafts', () => {
  const g = new Game(0);
  g.play(0, 'p0-slot-00', 'island');
  const priv = g.privOf(1);
  priv.set('p1-slot-00', 'island');
  priv.set('p1-slot-01', 'swamp');
  const response = legalActions(g.s, 1, priv);
  assert.deepEqual(response.filter((a) => a.type === 'allow'), [{ type: 'allow' }]);
  const counter = response.find((a) => a.type === 'counter');
  assert.deepEqual(counter, { type: 'counter', island: 'p1-slot-00', islandLand: 'island', other: 'p1-slot-01', otherLand: 'swamp' });

  g.act(1, { type: 'allow' });
  // p0 drew the island, so p1 holds the other half of the lock and must grant
  const grant = legalActions(g.s, 1);
  assert.deepEqual(grant, [{ type: 'grantDrawKey', card: g.s.awaitingDraw!.card }]);
  const forDrawer = legalActions(g.s, 0);
  assert.deepEqual(forDrawer, []);
});
