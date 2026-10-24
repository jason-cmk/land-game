// The table: a PixiJS (WebGL) scene of both players' zones. Every card is a
// persistent sprite keyed by CardId that eases toward its laid-out position,
// so a card visibly travels between zones. The table knows no rules: it draws
// a GameState from one seat's point of view and reports card clicks and drags.

import { Application, Container, Graphics, Text } from 'pixi.js';
import type { CardId, CardSlot, GameState, Land, Seat } from '../engine/types.ts';
import { other } from '../engine/types.ts';
import { landName } from './controls.ts';
import type { Cue } from './effects.ts';
import { playCues } from './fx.ts';
import { nextHandOrder } from './presence.ts';
import type { FxHost } from './fx.ts';

export type Highlight = 'none' | 'playable' | 'target' | 'picked';

export interface TableView {
  readonly state: GameState;
  readonly seat: Seat;
  /** Lands this seat privately knows (its own hidden hand cards). */
  readonly privateHand: ReadonlyMap<CardId, Land>;
  readonly highlights: ReadonlyMap<CardId, Highlight>;
}

const LAND_COLOURS: Record<Land, { fill: number; ink: number }> = {
  forest: { fill: 0x3f7d4e, ink: 0xeaf5e4 },
  island: { fill: 0x3a6fb0, ink: 0xe8f1fb },
  mountain: { fill: 0xb5533c, ink: 0xfbece6 },
  plains: { fill: 0xe8dcae, ink: 0x4a3f22 },
  swamp: { fill: 0x4b3f56, ink: 0xeee6f3 },
};
const PEER_COLOUR = 0x7fdcff;
const HIGHLIGHT_COLOURS: Record<Exclude<Highlight, 'none'>, number> = { playable: 0xf4d35e, target: 0xe4572e, picked: 0xffffff };

const BASE_W = 80;
const BASE_H = 112;

interface Place {
  x: number;
  y: number;
  scale: number;
  face: Land | null; // null draws the card back
  revealed: boolean; // a hand card the opponent can see
  highlight: Highlight;
  /** The opponent is hovering this card. */
  peer: boolean;
  z: number;
}

class CardSprite extends Container {
  readonly id: CardId;
  target: Place | null = null;
  /** performance.now() until which an effect keeps this card where it is. */
  holdUntil = 0;
  private drawn = '';
  private readonly body = new Graphics();
  private readonly caption = new Text({ text: '', style: { fontFamily: 'Georgia, serif', fontSize: 13, fontWeight: 'bold', fill: 0xffffff } });

  constructor(id: CardId, onTap: (id: CardId) => void, onHover: (id: CardId | null) => void, onPress: (id: CardId, event: PointerEvent) => void) {
    super();
    this.id = id;
    this.addChild(this.body, this.caption);
    this.caption.anchor.set(0.5);
    this.eventMode = 'static';
    this.cursor = 'pointer';
    this.on('pointertap', () => onTap(this.id));
    this.on('pointerdown', (event) => onPress(this.id, event.nativeEvent as PointerEvent));
    this.on('pointerover', () => onHover(this.id));
    this.on('pointerout', () => onHover(null));
  }

  /** Redraw only when what the card shows changes. */
  paint(place: Place): void {
    const key = `${place.face}|${place.revealed}|${place.highlight}|${place.peer}`;
    if (key === this.drawn) return;
    this.drawn = key;
    const g = this.body.clear();
    const x = -BASE_W / 2;
    const y = -BASE_H / 2;
    if (place.peer) g.roundRect(x - 7, y - 7, BASE_W + 14, BASE_H + 14, 12).fill({ color: PEER_COLOUR, alpha: 0.35 });
    if (place.highlight !== 'none') {
      g.roundRect(x - 4, y - 4, BASE_W + 8, BASE_H + 8, 10).fill({ color: HIGHLIGHT_COLOURS[place.highlight], alpha: 0.9 });
    }
    if (place.face === null) {
      g.roundRect(x, y, BASE_W, BASE_H, 7).fill(0x2b2118).stroke({ width: 2, color: 0x8a6d3b });
      g.ellipse(0, 0, BASE_W * 0.3, BASE_H * 0.33).stroke({ width: 3, color: 0x8a6d3b });
      g.ellipse(0, 0, BASE_W * 0.16, BASE_H * 0.18).fill({ color: 0x8a6d3b, alpha: 0.6 });
      this.caption.text = '';
      return;
    }
    const colours = LAND_COLOURS[place.face];
    g.roundRect(x, y, BASE_W, BASE_H, 7).fill(0x1c1c1c);
    g.roundRect(x + 4, y + 4, BASE_W - 8, BASE_H - 8, 5).fill(colours.fill);
    g.circle(0, 8, 18).fill({ color: colours.ink, alpha: 0.25 });
    if (place.revealed) g.roundRect(x + 4, y + BASE_H - 18, BASE_W - 8, 14, 3).fill({ color: 0xffffff, alpha: 0.35 });
    this.caption.text = landName(place.face);
    this.caption.style.fill = colours.ink;
    this.caption.position.set(0, y + 16);
  }
}

export class Table {
  private readonly app = new Application();
  private readonly cards = new Map<CardId, CardSprite>();
  private readonly layer = new Container();
  private readonly labels = new Container();
  private readonly fxLayer = new Container();
  private readonly world = new Container(); // everything that shakes
  private readonly animations = new Set<{ start: number; frame: (elapsedMS: number) => boolean }>();
  private shake = { until: 0, amplitude: 0, duration: 1 };
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private view: TableView | null = null;
  private mounted = false;
  private onCard: (id: CardId) => void = () => {};
  private onHoverCard: (id: CardId | null) => void = () => {};
  private onPointerMove: (x: number, y: number) => void = () => {};
  private handOrders: [CardId[], CardId[]] = [[], []];
  private peerHover: CardId | null = null;
  private readonly peerCursor = new Graphics().circle(0, 0, 9).fill({ color: PEER_COLOUR, alpha: 0.35 }).circle(0, 0, 4).fill({ color: PEER_COLOUR, alpha: 0.9 });
  private peerCursorSeen = 0;
  /** A press on a draggable card; it becomes a drag once the pointer travels. */
  private press: { id: CardId; x: number; y: number; dragging: boolean } | null = null;
  /** Set when the current press turned into a drag, so its tap is ignored. */
  private pressDragged = false;
  private localDrag: { id: CardId; x: number; y: number } | null = null;
  private peerDrag: { id: CardId; x: number; y: number; seen: number } | null = null;
  private onDragStartCard: (id: CardId) => void = () => {};
  private onDragMoveCard: (id: CardId, x: number, y: number) => void = () => {};
  private onDropCard: (id: CardId, over: CardId | null, onTable: boolean) => void = () => {};

  async mount(host: HTMLElement): Promise<void> {
    await this.app.init({ resizeTo: host, background: 0x14261c, antialias: true, autoDensity: true, resolution: window.devicePixelRatio });
    host.appendChild(this.app.canvas);
    this.mounted = true;
    this.layer.sortableChildren = true;
    this.world.addChild(this.labels, this.layer, this.fxLayer);
    this.peerCursor.visible = false;
    this.app.stage.addChild(this.world, this.peerCursor);
    // Track the pointer on the canvas element itself, leaving Pixi's event tree to the cards.
    this.app.canvas.addEventListener('pointermove', (event) => {
      const box = this.app.canvas.getBoundingClientRect();
      this.onPointerMove((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
    });
    this.app.ticker.add((ticker) => this.step(ticker.deltaMS));
    this.app.renderer.on('resize', () => this.layout());
    this.layout();
  }

  onCardClick(handler: (id: CardId) => void): void {
    this.onCard = handler;
  }

  /** The local pointer entering (id) or leaving (null) a card. */
  onCardHover(handler: (id: CardId | null) => void): void {
    this.onHoverCard = handler;
  }

  /** A playable card picked up and moved past the drag threshold. */
  onDragStart(handler: (id: CardId) => void): void {
    this.onDragStartCard = handler;
  }

  /** The dragged card moving, normalised to 0-1 of the table. */
  onDragMove(handler: (id: CardId, x: number, y: number) => void): void {
    this.onDragMoveCard = handler;
  }

  /**
   * The dragged card released over `over` (the card under the pointer, if
   * any), on the table or back over the local hand row (`onTable` false).
   */
  onDrop(handler: (id: CardId, over: CardId | null, onTable: boolean) => void): void {
    this.onDropCard = handler;
  }

  /** The local pointer moving, normalised to 0-1 of the table. */
  onPointer(handler: (x: number, y: number) => void): void {
    this.onPointerMove = handler;
  }

  /** A seat's hand in the order this table shows it. */
  handOrder(seat: Seat): readonly CardId[] {
    return this.handOrders[seat];
  }

  /** What the opponent's presence currently shows (dev tooling). */
  peerPresence(): { hover: CardId | null; drag: CardId | null; cursor: { x: number; y: number } | null } {
    const c = this.peerCursor;
    return { hover: this.peerHover, drag: this.peerDrag?.id ?? null, cursor: c.visible && c.alpha > 0 ? { x: c.x, y: c.y } : null };
  }

  /** Move the card the opponent is dragging to a normalised position (null lets it go). */
  setPeerDrag(drag: { card: CardId; at: { x: number; y: number } } | null): void {
    if (drag === null) {
      this.peerDrag = null;
      return;
    }
    const { width, height } = this.app.screen;
    this.peerDrag = { id: drag.card, x: drag.at.x * width, y: drag.at.y * height, seen: performance.now() };
    this.setPeerCursor(drag.at);
  }

  /** Mark the card the opponent is hovering (null clears). */
  setPeerHover(id: CardId | null): void {
    if (id === this.peerHover) return;
    this.peerHover = id;
    this.layout();
  }

  /** Show the opponent's pointer at a normalised position (null hides it). */
  setPeerCursor(at: { x: number; y: number } | null): void {
    if (at === null) {
      this.peerCursor.visible = false;
      return;
    }
    this.peerCursor.position.set(at.x * this.app.screen.width, at.y * this.app.screen.height);
    this.peerCursor.visible = true;
    this.peerCursor.alpha = 1;
    this.peerCursorSeen = performance.now();
  }

  /** Draw `view`, then play the effects for whatever changed to get here. */
  show(view: TableView, cues: readonly Cue[] = []): void {
    this.view = view;
    this.layout();
    if (this.mounted && cues.length > 0 && !this.reducedMotion.matches) {
      playCues(this.fxHost(), cues, view.seat, view.state.pending?.card ?? null);
    }
  }

  /** Play cues against the current view without a state change (dev tooling). */
  playEffects(cues: readonly Cue[]): void {
    const view = this.view;
    if (this.mounted && view !== null) playCues(this.fxHost(), cues, view.seat, view.state.pending?.card ?? null);
  }

  private fxHost(): FxHost {
    return {
      layer: this.fxLayer,
      screen: this.app.screen,
      position: (id) => {
        const sprite = this.cards.get(id);
        return sprite === undefined ? null : { x: sprite.x, y: sprite.y };
      },
      destination: (id) => this.cardPosition(id),
      hold: (id, ms) => {
        const sprite = this.cards.get(id);
        if (sprite !== undefined) sprite.holdUntil = performance.now() + ms;
      },
      bump: (id, factor) => {
        const sprite = this.cards.get(id);
        if (sprite !== undefined) sprite.scale.set(sprite.scale.x * factor);
      },
      shake: (ms, amplitude) => {
        this.shake = { until: performance.now() + ms, amplitude, duration: ms };
      },
      animate: (frame) => {
        this.animations.add({ start: performance.now(), frame });
      },
    };
  }

  /**
   * How far the furthest card still is from where it is heading, in pixels
   * (dev tooling: clicks hit cards where they are drawn, so automation waits for 0).
   */
  settling(): number {
    let furthest = 0;
    for (const sprite of this.cards.values()) {
      if (sprite.target === null) continue;
      const at = this.rest(sprite.target);
      furthest = Math.max(furthest, Math.hypot(sprite.x - at.x, sprite.y - at.y));
    }
    return furthest;
  }

  /** Where a card is heading, in canvas CSS pixels; null if it is not on the table. */
  cardPosition(id: CardId): { x: number; y: number } | null {
    const place = this.cards.get(id)?.target;
    return place == null ? null : { x: place.x, y: place.y + (place.highlight === 'picked' ? -14 : 0) };
  }

  destroy(): void {
    this.app.destroy(true, { children: true });
  }

  private layout(): void {
    const view = this.view;
    if (view === null || !this.mounted) return; // mount() lays out the latest view once ready
    const width = this.app.screen.width;
    const height = this.app.screen.height;
    const scale = Math.max(0.5, Math.min(width / 1100, height / 860, 1.25));
    const cardW = BASE_W * scale;
    const rowH = height / 5;
    const me = view.seat;
    const them = other(me);
    const pendingCard = view.state.pending?.card ?? null;
    const places = new Map<CardId, Place>();
    this.labels.removeChildren().forEach((child) => child.destroy());

    const rowY = (row: number): number => rowH * row + rowH / 2;
    const highlight = (id: CardId): Highlight => view.highlights.get(id) ?? 'none';

    /** Lay out a row of cards centred in [left, right], overlapping when crowded. */
    const row = (slots: readonly CardSlot[], y: number, left: number, right: number, face: (s: CardSlot) => Land | null, revealed: (s: CardSlot) => boolean, small = 1): void => {
      const w = cardW * small;
      const step = slots.length <= 1 ? 0 : Math.min(w + 10 * scale, (right - left - w) / (slots.length - 1));
      const start = (left + right) / 2 - (step * (slots.length - 1)) / 2;
      slots.forEach((slot, i) => {
        places.set(slot.id, { x: start + step * i, y, scale: scale * small, face: face(slot), revealed: revealed(slot), highlight: highlight(slot.id), peer: false, z: i });
      });
    };

    const margin = 24 * scale;
    const sideW = cardW * 2.2;
    for (const seat of [them, me]) {
      const p = view.state.players[seat];
      const mine = seat === me;
      const handY = rowY(mine ? 4 : 0);
      const fieldY = rowY(mine ? 3 : 1);
      // Hands keep a local visual order that shuffles new cards in (see presence.ts).
      const inHand = p.hand.filter((s) => s.id !== pendingCard);
      this.handOrders[seat] = nextHandOrder(this.handOrders[seat], inHand.map((s) => s.id));
      const hand = this.handOrders[seat].map((id) => inHand.find((s) => s.id === id)!);
      const handFace = (s: CardSlot): Land | null => s.land ?? (mine ? (view.privateHand.get(s.id) ?? null) : null);
      row(hand, handY, sideW, width - sideW, handFace, (s) => s.land !== null);
      row(p.battlefield, fieldY, sideW, width - sideW, (s) => s.land, () => false);
      // Graveyard on the left of the field row, small and fanned; library on the right as a pile.
      row(p.graveyard, fieldY, margin, sideW - margin, (s) => s.land, () => false, 0.6);
      p.library.forEach((slot, i) => {
        const lift = Math.min(i, 12) * 0.6;
        places.set(slot.id, { x: width - sideW / 2, y: handY - lift, scale: scale * 0.8, face: null, revealed: false, highlight: 'none', peer: false, z: i });
      });
      // Label on the table side of the pile, so it never falls off the edge.
      this.text(`Deck ${p.library.length}`, width - sideW / 2, handY + (mine ? -1 : 1) * cardW * 0.85, scale);
      this.text(`Graveyard ${p.graveyard.length}`, sideW / 2, fieldY + cardW * 0.65, scale);
    }

    // The land being played sits in the middle until the counter chain ends.
    const pending = view.state.pending;
    if (pending !== null) {
      places.set(pending.card, {
        x: width / 2,
        y: rowY(2),
        scale: scale * 1.15,
        face: pending.land,
        revealed: false,
        highlight: highlight(pending.card),
        peer: false,
        z: 100,
      });
      if (pending.counters > 0) this.text(`${pending.counters} counter${pending.counters === 1 ? '' : 's'}`, width / 2 + cardW * 1.1, rowY(2), scale);
    }

    for (const [id, place] of places) {
      let sprite = this.cards.get(id);
      if (sprite === undefined) {
        sprite = new CardSprite(
          id,
          (cid) => {
            if (!this.pressDragged) this.onCard(cid);
          },
          (cid) => this.onHoverCard(cid),
          (cid, event) => this.startPress(cid, event),
        );
        sprite.position.set(place.x, place.y);
        sprite.scale.set(place.scale);
        this.cards.set(id, sprite);
        this.layer.addChild(sprite);
      }
      place.peer = id === this.peerHover;
      sprite.target = place;
      sprite.paint(place);
    }
  }

  /** Canvas CSS pixels of a DOM pointer event. */
  private local(event: PointerEvent): { x: number; y: number } {
    const box = this.app.canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  /** Playable and picked cards can be dragged; the rest only tapped. */
  private startPress(id: CardId, event: PointerEvent): void {
    this.pressDragged = false;
    const highlight = this.view?.highlights.get(id);
    if (this.press !== null || (highlight !== 'playable' && highlight !== 'picked')) return;
    this.press = { id, ...this.local(event), dragging: false };
    const move = (e: PointerEvent): void => {
      const press = this.press;
      if (press === null) return;
      const at = this.local(e);
      if (!press.dragging) {
        if (Math.hypot(at.x - press.x, at.y - press.y) < 6) return;
        press.dragging = true;
        this.pressDragged = true;
        this.onDragStartCard(press.id);
      }
      this.localDrag = { id: press.id, ...at };
      this.onDragMoveCard(press.id, at.x / this.app.screen.width, at.y / this.app.screen.height);
    };
    const end = (e: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      const press = this.press;
      this.press = null;
      this.localDrag = null;
      if (press === null || !press.dragging) return;
      const at = this.local(e);
      const dropped = e.type === 'pointerup';
      // The hand row is the bottom fifth; dropping back there puts the card back.
      const onTable = dropped && at.y < (this.app.screen.height / 5) * 4;
      this.onDropCard(press.id, dropped ? this.cardUnder(at, press.id) : null, onTable);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  /** The topmost card laid out under a point, ignoring `except`. */
  private cardUnder(at: { x: number; y: number }, except: CardId): CardId | null {
    let best: CardSprite | null = null;
    for (const sprite of this.cards.values()) {
      const place = sprite.target;
      if (place === null || sprite.id === except) continue;
      if (Math.abs(at.x - place.x) > (BASE_W * place.scale) / 2 || Math.abs(at.y - place.y) > (BASE_H * place.scale) / 2) continue;
      if (best === null || sprite.zIndex > best.zIndex) best = sprite;
    }
    return best?.id ?? null;
  }

  private text(content: string, x: number, y: number, scale: number): void {
    const label = new Text({ text: content, style: { fontFamily: 'system-ui, sans-serif', fontSize: 13 * scale, fill: 0xcfd8cf } });
    label.anchor.set(0.5);
    label.position.set(x, y);
    this.labels.addChild(label);
  }

  /** Where a card comes to rest: picked cards lift; a card the opponent is touching leans toward the middle of the table. */
  private rest(place: Place): { x: number; y: number } {
    const peerLift = place.peer ? (place.y < this.app.screen.height / 2 ? 12 : -12) : 0;
    return { x: place.x, y: place.y + (place.highlight === 'picked' ? -14 : 0) + peerLift };
  }

  /** Ease every card toward its target, run effects, shake; frame-rate independent. */
  private step(deltaMS: number): void {
    const now = performance.now();
    const t = 1 - Math.pow(0.001, deltaMS / 350); // ~350 ms to settle
    for (const animation of this.animations) {
      if (!animation.frame(now - animation.start)) this.animations.delete(animation);
    }
    if (this.peerCursor.visible) {
      const idle = now - this.peerCursorSeen;
      this.peerCursor.alpha = idle < 2000 ? 1 : Math.max(0, 1 - (idle - 2000) / 800);
    }
    const shaking = this.shake.until - now;
    if (shaking > 0) {
      const strength = this.shake.amplitude * (shaking / this.shake.duration);
      this.world.position.set((Math.random() - 0.5) * 2 * strength, (Math.random() - 0.5) * 2 * strength);
    } else {
      this.world.position.set(0, 0);
    }
    // An opponent drag that stops updating (its end lost on the unreliable channel) lets go.
    if (this.peerDrag !== null && now - this.peerDrag.seen > 600) this.peerDrag = null;
    for (const sprite of this.cards.values()) {
      const place = sprite.target;
      if (place === null) continue;
      const local = this.localDrag?.id === sprite.id ? this.localDrag : null;
      const peer = this.peerDrag?.id === sprite.id ? this.peerDrag : null;
      sprite.zIndex = local !== null || peer !== null ? 400 : place.z + (place.highlight === 'picked' ? 200 : 0);
      if (local !== null || peer !== null) {
        // A held card follows the pointer: tightly for ours, smoothed for theirs (~20 Hz updates).
        const follow = local !== null ? 1 - Math.pow(0.001, deltaMS / 60) : t;
        const to = (local ?? peer)!;
        sprite.x += (to.x - sprite.x) * follow;
        sprite.y += (to.y - sprite.y) * follow;
        sprite.scale.set(sprite.scale.x + (place.scale * 1.12 - sprite.scale.x) * follow);
        continue;
      }
      if (sprite.holdUntil > now) continue;
      const at = this.rest(place);
      sprite.x += (at.x - sprite.x) * t;
      sprite.y += (at.y - sprite.y) * t;
      const s = sprite.scale.x + (place.scale - sprite.scale.x) * t;
      sprite.scale.set(s);
    }
  }
}
