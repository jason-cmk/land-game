// The table: a PixiJS (WebGL) scene of both players' zones. Every card is a
// persistent sprite keyed by CardId that eases toward its laid-out position,
// so a card visibly travels between zones. The table knows no rules: it draws
// a GameState from one seat's point of view and reports card clicks and drags.

import { Application, Container, Graphics, Rectangle, Sprite, Text } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { CardId, CardSlot, GameState, Land, Seat } from '../engine/types.ts';
import { LANDS, other } from '../engine/types.ts';
import { CARD_H, CARD_W, drawBack, drawFace } from './art.ts';
import type { ChainLink } from './chain.ts';
import { chainOutcome } from './chain.ts';
import type { Cue } from './effects.ts';
import { actingSeat } from './controls.ts';
import { playCues } from './fx.ts';
import { drawAim, drawEdgeGlow } from './overlay.ts';
import { nextHandOrder } from './presence.ts';
import type { FxHost } from './fx.ts';

export type Highlight = 'none' | 'playable' | 'target' | 'picked';

export interface TableView {
  readonly state: GameState;
  readonly seat: Seat;
  /** Lands this seat privately knows (its own hidden hand cards). */
  readonly privateHand: ReadonlyMap<CardId, Land>;
  readonly highlights: ReadonlyMap<CardId, Highlight>;
  /** Counters paid against the pending play, oldest first (see chain.ts). */
  readonly chain: readonly ChainLink[];
}

const PEER_COLOUR = 0x7fdcff;
const HIGHLIGHT_COLOURS: Record<Exclude<Highlight, 'none'>, number> = { playable: 0xf4d35e, target: 0xe4572e, picked: 0xffffff };

const BASE_W = CARD_W;
const BASE_H = CARD_H;

/** The baked card textures: one per land face, and the back. */
interface CardTextures {
  readonly faces: Record<Land, Texture>;
  readonly back: Texture;
}

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
  /** Tilt in radians (the fanned hand of a Swamp reveal); 0 if absent. */
  angle?: number;
  /** A card in a fan of choices (the graveyard), which pulls out when hovered. */
  fan?: boolean;
}

/** The middle row of the table, where plays, chains and fans go. */
interface MiddleRow {
  readonly width: number;
  readonly y: number;
  readonly rowH: number;
  readonly cardW: number;
  readonly scale: number;
}

/** How long the last hovered card of a fan stays pulled out after the pointer leaves it. */
const PULL_LINGER_MS = 3000;
/** How long a finger rests on a card before it shows the card's info instead of tapping it. */
const LONG_PRESS_MS = 450;
/** Battlefield piles show at most this many cards; a badge counts the rest. */
const PILE_DEPTH = 4;

class CardSprite extends Container {
  readonly id: CardId;
  target: Place | null = null;
  /** performance.now() until which an effect keeps this card where it is. */
  holdUntil = 0;
  private drawn = '';
  private readonly glow = new Graphics();
  private readonly art: Sprite;
  private readonly marks = new Graphics();
  /** A light streak across the face, following the mouse (see Table.step). */
  readonly shine = new Graphics();
  /** 0-1: how far the card has eased into its mouse-hover tilt. */
  hover = 0;
  /** Whether the hit area currently reaches down to cover a pulled-out card's old spot. */
  pulledHit = false;
  private readonly textures: CardTextures;

  constructor(id: CardId, textures: CardTextures, onTap: (id: CardId, event: PointerEvent) => void, onHover: (id: CardId | null, pointerType: string) => void, onPress: (id: CardId, event: PointerEvent) => void) {
    super();
    this.id = id;
    this.textures = textures;
    this.art = new Sprite(textures.back);
    this.art.anchor.set(0.5);
    this.art.setSize(BASE_W, BASE_H);
    const shineMask = new Graphics().roundRect(-BASE_W / 2, -BASE_H / 2, BASE_W, BASE_H, 6).fill(0xffffff);
    for (const [offset, width, alpha] of [[0, 30, 0.12], [0, 16, 0.18], [0, 6, 0.3]] as const) {
      this.shine.poly([offset - width / 2 + 30, -BASE_H, offset + width / 2 + 30, -BASE_H, offset + width / 2 - 30, BASE_H, offset - width / 2 - 30, BASE_H]).fill({ color: 0xffffff, alpha });
    }
    this.shine.mask = shineMask;
    this.shine.alpha = 0;
    this.addChild(this.glow, this.art, this.shine, shineMask, this.marks);
    this.eventMode = 'static';
    this.cursor = 'pointer';
    this.on('pointertap', (event) => onTap(this.id, event.nativeEvent as PointerEvent));
    this.on('pointerdown', (event) => onPress(this.id, event.nativeEvent as PointerEvent));
    // Pixi follows the pointer across the whole page: a card under a panel (the counter popup,
    // the history) is not hovered.
    this.on('pointerover', (event) => onHover(event.nativeEvent.target instanceof HTMLCanvasElement ? this.id : null, event.pointerType));
    this.on('pointerout', (event) => onHover(null, event.pointerType));
  }

  /** Redraw only when what the card shows changes. */
  paint(place: Place): void {
    const key = `${place.face}|${place.revealed}|${place.highlight}|${place.peer}`;
    if (key === this.drawn) return;
    this.drawn = key;
    const g = this.glow.clear();
    const x = -BASE_W / 2;
    const y = -BASE_H / 2;
    if (place.peer) g.roundRect(x - 7, y - 7, BASE_W + 14, BASE_H + 14, 12).fill({ color: PEER_COLOUR, alpha: 0.35 });
    if (place.highlight !== 'none') {
      g.roundRect(x - 4, y - 4, BASE_W + 8, BASE_H + 8, 10).fill({ color: HIGHLIGHT_COLOURS[place.highlight], alpha: 0.9 });
    }
    this.art.texture = place.face === null ? this.textures.back : this.textures.faces[place.face];
    this.art.setSize(BASE_W, BASE_H);
    // A hand card the opponent has seen: a pale rim and an eye in the corner.
    const m = this.marks.clear();
    if (place.revealed) {
      m.roundRect(x + 1, y + 1, BASE_W - 2, BASE_H - 2, 6).stroke({ width: 2, color: 0xffffff, alpha: 0.7 });
      const ex = x + BASE_W - 10;
      const ey = y + 10;
      m.circle(ex, ey, 7).fill({ color: 0x161616, alpha: 0.85 });
      m.ellipse(ex, ey, 5, 3).fill(0xffffff);
      m.circle(ex, ey, 1.8).fill(0x161616);
    }
  }
}

export class Table {
  private readonly app = new Application();
  private readonly cards = new Map<CardId, CardSprite>();
  private readonly layer = new Container();
  private readonly labels = new Container();
  private readonly fxLayer = new Container();
  private readonly world = new Container(); // everything that shakes
  /** Darkens the table behind a Swamp-revealed hand, fanned in the middle (see swampMoment). */
  private readonly scrim = new Graphics();
  private scrimTarget = 0;
  private readonly layerLabels: Container[] = [];
  /** Light along the side of whoever the game is waiting on; it breathes when that is us. */
  private readonly turnGlow = new Graphics();
  private turnPulse = false;
  /** The targeting arrow: ours while aiming a card, or the opponent's. */
  private readonly aim = new Graphics();
  /** Where our aiming drag points (canvas px); null unless aiming. */
  private aimTip: { x: number; y: number } | null = null;
  /** The mouse over the canvas (canvas px), for click-targeting arrows and tilt. */
  private pointer: { x: number; y: number } | null = null;
  /** The card under the mouse, which tilts toward it. */
  private hovered: CardId | null = null;
  /** The fan card pulled out by the last hover, until `until` (Infinity while still hovered). */
  private pulled: { id: CardId; until: number } | null = null;
  private readonly animations = new Set<{ start: number; frame: (elapsedMS: number) => boolean }>();
  private shake = { until: 0, amplitude: 0, duration: 1 };
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private view: TableView | null = null;
  private mounted = false;
  private textures: CardTextures | null = null;
  private readonly faceUrls = new Map<Land, string>();
  private onCard: (id: CardId) => void = () => {};
  private onHoverCard: (id: CardId | null) => void = () => {};
  private onPointerMove: (x: number, y: number) => void = () => {};
  private handOrders: [CardId[], CardId[]] = [[], []];
  private peerHover: CardId | null = null;
  private readonly peerCursor = new Graphics().circle(0, 0, 9).fill({ color: PEER_COLOUR, alpha: 0.35 }).circle(0, 0, 4).fill({ color: PEER_COLOUR, alpha: 0.9 });
  private peerCursorSeen = 0;
  /**
   * A press on a draggable card; it becomes a drag once the pointer travels
   * `threshold` pixels. A finger holds the card `lift` pixels above itself, so it stays in sight.
   */
  private press: { id: CardId; x: number; y: number; dragging: boolean; threshold: number; lift: number; aiming: boolean } | null = null;
  /** Set when the current press turned into a drag, so its tap is ignored. */
  private pressDragged = false;
  /** Set when the current press was a long press that showed card info, so its tap is ignored. */
  private longPressed = false;
  /** The timestamp of the current press's pointerdown event. */
  private pressedAt = 0;
  private inspectTimer: ReturnType<typeof setTimeout> | undefined;
  private inspecting: CardId | null = null;
  private onInspectCard: (info: { land: Land; box: { x: number; y: number; width: number; height: number } } | null) => void = () => {};
  private localDrag: { id: CardId; x: number; y: number } | null = null;
  private peerDrag: { id: CardId; x: number; y: number; seen: number; aim: boolean } | null = null;
  private onDragStartCard: (id: CardId) => void = () => {};
  private onDragMoveCard: (id: CardId, x: number, y: number, aim: boolean) => void = () => {};
  private onDropCard: (id: CardId, over: CardId | null, onTable: boolean) => void = () => {};

  async mount(host: HTMLElement): Promise<void> {
    await this.app.init({ resizeTo: host, background: 0x14261c, antialias: true, autoDensity: true, resolution: window.devicePixelRatio });
    host.appendChild(this.app.canvas);
    this.textures = this.bakeTextures();
    this.mounted = true;
    this.layer.sortableChildren = true;
    this.scrim.zIndex = 150; // above the table's cards, below the fanned hand (z 160+)
    this.scrim.alpha = 0;
    this.layer.addChild(this.scrim);
    this.world.addChild(this.turnGlow, this.labels, this.layer, this.fxLayer);
    this.aim.zIndex = 300; // over the table's cards, under a dragged one
    this.layer.addChild(this.aim);
    this.peerCursor.visible = false;
    this.app.stage.addChild(this.world, this.peerCursor);
    // A long press shows card info; the browser must not open its own menu or callout over it.
    this.app.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    // Track the pointer on the canvas element itself, leaving Pixi's event tree to the cards.
    this.app.canvas.addEventListener('pointerleave', () => (this.pointer = null));
    window.addEventListener('pointerup', this.liftFinger);
    this.app.canvas.addEventListener('pointermove', (event) => {
      const box = this.app.canvas.getBoundingClientRect();
      this.pointer = event.pointerType === 'mouse' ? this.local(event) : null;
      // A finger sliding across a fan pulls out the card under it (Pixi's over/out do not follow a moving touch).
      if (event.pointerType !== 'mouse' && event.buttons !== 0 && this.press?.aiming !== true) this.pull(this.cardUnder(this.local(event), null));
      this.onPointerMove((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
    });
    this.app.ticker.add((ticker) => this.step(ticker.deltaMS));
    this.app.renderer.on('resize', () => this.layout());
    // resizeTo only follows the window; the host also changes size when the status bar wraps (phones).
    new ResizeObserver(() => this.app.queueResize()).observe(host);
    this.layout();
  }

  /** Draw each card design once into a texture, sharp at the largest on-screen size. */
  private bakeTextures(): CardTextures {
    const bake = (art: Container): Texture => {
      const texture = this.app.renderer.generateTexture({ target: art, resolution: 2 * Math.max(2, window.devicePixelRatio), antialias: true });
      art.destroy({ children: true });
      return texture;
    };
    const lands: Land[] = ['forest', 'island', 'mountain', 'plains', 'swamp'];
    return { faces: Object.fromEntries(lands.map((land) => [land, bake(drawFace(land))])) as Record<Land, Texture>, back: bake(drawBack()) };
  }

  /** A land's card face as an image URL, for the chrome (the choice popup). */
  faceImage(land: Land): string | null {
    if (this.textures === null) return null;
    let url = this.faceUrls.get(land);
    if (url === undefined) {
      url = this.app.renderer.extract.canvas(this.textures.faces[land]).toDataURL!();
      this.faceUrls.set(land, url);
    }
    return url;
  }

  onCardClick(handler: (id: CardId) => void): void {
    this.onCard = handler;
  }

  /**
   * Show (with the land and the card's box in canvas CSS pixels) or hide (null)
   * what a face-up card does: after a short mouse hover, or while a finger long-presses it.
   */
  onInspect(handler: (info: { land: Land; box: { x: number; y: number; width: number; height: number } } | null) => void): void {
    this.onInspectCard = handler;
  }

  /** The local pointer entering (id) or leaving (null) a card. */
  onCardHover(handler: (id: CardId | null) => void): void {
    this.onHoverCard = handler;
  }

  /** A playable card picked up and moved past the drag threshold. */
  onDragStart(handler: (id: CardId) => void): void {
    this.onDragStartCard = handler;
  }

  /** The dragged card moving, normalised to 0-1 of the table; with `aim`, its targeting arrow points there instead. */
  onDragMove(handler: (id: CardId, x: number, y: number, aim: boolean) => void): void {
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
  setPeerDrag(drag: { card: CardId; at: { x: number; y: number }; aim?: boolean } | null): void {
    if (drag === null) {
      this.peerDrag = null;
      return;
    }
    const { width, height } = this.app.screen;
    this.peerDrag = { id: drag.card, x: drag.at.x * width, y: drag.at.y * height, seen: performance.now(), aim: drag.aim === true };
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
    this.stopInspect(); // cards may move or turn over
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
      size: (id) => {
        const place = this.cards.get(id)?.target;
        return place == null ? null : { width: BASE_W * place.scale, height: BASE_H * place.scale, angle: place.angle ?? 0 };
      },
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
      const at = this.rest(sprite.target, sprite);
      furthest = Math.max(furthest, Math.hypot(sprite.x - at.x, sprite.y - at.y));
    }
    return furthest;
  }

  /**
   * A point on a card that no other card covers, in canvas CSS pixels (dev tooling: in an
   * overlapping hand or fan the middle of a card is often under its neighbour). Falls back
   * to where the card is heading.
   */
  visiblePoint(id: CardId): { x: number; y: number } | null {
    const sprite = this.cards.get(id);
    const place = sprite?.target;
    if (place == null) return null;
    const centre = this.rest(place, sprite);
    const half = { x: (BASE_W * place.scale) / 2, y: (BASE_H * place.scale) / 2 };
    for (const fy of [0, -0.3, 0.3, -0.6, 0.6]) {
      for (const fx of [0, -0.25, -0.5, -0.75, 0.25, 0.5, 0.75]) {
        const at = { x: centre.x + fx * half.x, y: centre.y + fy * half.y };
        if (this.cardUnder(at, null) === id) return at;
      }
    }
    return centre;
  }

  /** Where a card is heading, in canvas CSS pixels; null if it is not on the table. */
  cardPosition(id: CardId): { x: number; y: number } | null {
    const sprite = this.cards.get(id);
    const place = sprite?.target;
    return place == null ? null : { x: place.x, y: place.y + (place.highlight === 'picked' ? -14 : 0) - this.pullLift(sprite) };
  }

  /** Lifting a finger leaves the last fan card it pulled out there for a while, to tap. */
  private readonly liftFinger = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse') this.pull(null);
  };

  destroy(): void {
    window.removeEventListener('pointerup', this.liftFinger);
    this.app.destroy(true, { children: true });
  }

  private layout(): void {
    const view = this.view;
    if (view === null || !this.mounted) return; // mount() lays out the latest view once ready
    const width = this.app.screen.width;
    const height = this.app.screen.height;
    const rowH = height / 5;
    // Narrow screens (phones held upright): cards sized by row height, hands overlapping
    // across the full width, and slim side columns for the deck and graveyard.
    const compact = width < 720;
    const scale = compact ? Math.max(0.5, Math.min((rowH * 0.8) / BASE_H, width / (BASE_W * 5.2), 1.1)) : Math.max(0.5, Math.min(width / 1100, height / 860, 1.25));
    const cardW = BASE_W * scale;
    const me = view.seat;
    const them = other(me);
    const pendingCard = view.state.pending?.card ?? null;
    const places = new Map<CardId, Place>();
    this.labels.removeChildren().forEach((child) => child.destroy());
    for (const label of this.layerLabels.splice(0)) label.destroy();

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

    /**
     * A battlefield as piles by land type, in a fixed order: each pile cascades
     * diagonally, newest on top, at most PILE_DEPTH cards deep; a badge counts a deeper pile.
     */
    const pile = (slots: readonly CardSlot[], y: number, left: number, right: number): void => {
      const piles = LANDS.map((land) => slots.filter((s) => s.land === land)).filter((cards) => cards.length > 0);
      const unknown = slots.filter((s) => s.land === null); // never on a battlefield, but drawn if it were
      if (unknown.length > 0) piles.push(unknown);
      const dx = cardW * (compact ? 0.13 : 0.17);
      const dy = BASE_H * scale * 0.07;
      const pileW = cardW + dx * (PILE_DEPTH - 1);
      const n = piles.length;
      const step = n <= 1 ? 0 : Math.min(pileW + 14 * scale, (right - left - pileW) / (n - 1));
      const start = (left + right) / 2 - (step * (n - 1)) / 2;
      piles.forEach((cards, i) => {
        const shown = Math.min(cards.length, PILE_DEPTH);
        const x0 = start + step * i - (dx * (shown - 1)) / 2;
        const y0 = y - (dy * (shown - 1)) / 2;
        cards.forEach((slot, j) => {
          const at = Math.max(0, j - (cards.length - shown)); // the oldest hide under the bottom card
          places.set(slot.id, { x: x0 + dx * at, y: y0 + dy * at, scale, face: slot.land, revealed: false, highlight: highlight(slot.id), peer: false, z: i * 10 + j });
        });
        if (cards.length > PILE_DEPTH) this.badge(cards.length, x0 + dx * (shown - 1) + cardW / 2, y0 + dy * (shown - 1) - (BASE_H * scale) / 2, scale);
      });
    };

    let fanned: readonly CardSlot[] = [];
    const onStack = new Set(view.chain.flatMap((link) => link.cards));
    const margin = (compact ? 6 : 24) * scale;
    const sideW = cardW * (compact ? 1.2 : 2.2);
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
      // Compact rows only keep clear of their own side column: the deck beside the hand, the graveyard beside the field.
      row(hand, handY, compact ? margin : sideW, width - sideW, handFace, (s) => s.land !== null);
      pile(p.battlefield, fieldY, sideW, compact ? width - margin : width - sideW);
      // Graveyard on the left of the field row, small and fanned; library on the right as a pile.
      // Cards paying for a counter sit in the middle until the chain ends, not in the graveyard yet.
      const graveyard = p.graveyard.filter((s) => !onStack.has(s.id));
      // Choosing from the graveyard (a Forest): it fans out large in the middle instead.
      if (mine && graveyard.some((s) => highlight(s.id) === 'target')) fanned = graveyard;
      else row(graveyard, fieldY, margin, sideW - margin, (s) => s.land, () => false, 0.6);
      p.library.forEach((slot, i) => {
        const lift = Math.min(i, 12) * 0.6;
        places.set(slot.id, { x: width - sideW / 2, y: handY - lift, scale: scale * 0.8, face: null, revealed: false, highlight: 'none', peer: false, z: i });
      });
      // Label on the table side of the pile, so it never falls off the edge.
      this.text(`Deck ${p.library.length}`, width - sideW / 2, handY + (mine ? -1 : 1) * cardW * 0.85, scale);
      this.text(`Graveyard ${graveyard.length}`, sideW / 2, fieldY + cardW * 0.65, scale);
    }

    // The land being played sits in the middle until the counter chain ends,
    // except during a Swamp's discard choice, when the revealed hand takes the middle.
    const pending = view.state.pending;
    const middle = { width, y: rowY(2), rowH, cardW, scale };
    const moment = this.swampMoment(view, places, middle) || this.graveyardFan(view, fanned, places, middle);
    if (pending !== null && !moment) {
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
      this.chainLayout(view, places, { width, y: rowY(2), rowH, cardW, scale });
    }

    this.turnLayout(view, { width, height, rowH, sideW, scale });
    this.scrimTarget = moment ? 0.6 : 0;
    this.scrim.clear().rect(0, 0, width, height).fill(0x050b07);

    for (const [id, place] of places) {
      let sprite = this.cards.get(id);
      if (sprite === undefined) {
        sprite = new CardSprite(
          id,
          this.textures!,
          (cid, event) => {
            // A busy page can run the long-press timer before it handles a quick tap's release:
            // the events' own timestamps say how long the finger was really down.
            const held = event.timeStamp - this.pressedAt;
            if (!this.pressDragged && !(this.longPressed && held >= LONG_PRESS_MS)) this.onCard(cid);
          },
          (cid, pointerType) => {
            this.onHoverCard(cid);
            if (pointerType === 'mouse') {
              this.pull(cid ?? null); // a finger pulls fan cards from the canvas's own events (see mount)
              this.hovered = cid;
              this.hoverInspect(cid);
            }
          },
          (cid, event) => this.pointerDown(cid, event),
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

  private pointerDown(id: CardId, event: PointerEvent): void {
    this.pressDragged = false;
    this.longPressed = false;
    this.pressedAt = event.timeStamp;
    this.stopInspect();
    if (event.pointerType !== 'mouse') {
      this.pull(id); // the card the finger landed on, as Pixi hit it, so a tap stays on the same card
      this.startLongPress(id, event);
    }
    this.startPress(id, event);
  }

  /** Card info for the card under the mouse, after it rests there a moment (null stops). */
  private hoverInspect(id: CardId | null): void {
    this.stopInspect();
    if (id !== null && this.press === null) this.inspectTimer = setTimeout(() => this.inspect(id), 300);
  }

  /** A finger held still on a face-up card shows its info until it lifts or starts a drag. */
  private startLongPress(id: CardId, event: PointerEvent): void {
    const start = this.local(event);
    const done = (): void => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    const move = (e: PointerEvent): void => {
      const at = this.local(e);
      if (!this.longPressed && Math.hypot(at.x - start.x, at.y - start.y) > 10) done();
    };
    const up = (): void => {
      done();
      this.stopInspect();
    };
    const timer = setTimeout(() => {
      if (this.press?.dragging || !this.inspect(id)) return;
      this.longPressed = true;
      navigator.vibrate?.(10);
    }, LONG_PRESS_MS);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /** Report a face-up card's info; false if the card shows its back. */
  private inspect(id: CardId): boolean {
    const sprite = this.cards.get(id);
    const place = sprite?.target;
    if (place == null || place.face === null) return false;
    const at = this.rest(place, sprite);
    const width = BASE_W * place.scale;
    const height = BASE_H * place.scale;
    this.inspecting = id;
    this.onInspectCard({ land: place.face, box: { x: at.x - width / 2, y: at.y - height / 2, width, height } });
    return true;
  }

  private stopInspect(): void {
    clearTimeout(this.inspectTimer);
    if (this.inspecting === null) return;
    this.inspecting = null;
    this.onInspectCard(null);
  }

  /** Playable and picked cards can be dragged; the rest only tapped. */
  private startPress(id: CardId, event: PointerEvent): void {
    const highlight = this.view?.highlights.get(id);
    const place = this.cards.get(id)?.target;
    if (this.press !== null || place == null || (highlight !== 'playable' && highlight !== 'picked')) return;
    // A finger wobbles more than a mouse, and would hide the card it drags.
    const touch = event.pointerType !== 'mouse';
    this.press = { id, ...this.local(event), dragging: false, threshold: touch ? 12 : 6, lift: touch ? -BASE_H * place.scale * 0.6 : 0, aiming: false };
    const move = (e: PointerEvent): void => {
      const press = this.press;
      if (press === null) return;
      const pointer = this.local(e);
      if (!press.dragging) {
        if (Math.hypot(pointer.x - press.x, pointer.y - press.y) < press.threshold) return;
        press.dragging = true;
        this.pressDragged = true;
        this.stopInspect();
        this.onDragStartCard(press.id);
        // A card that needs a target stays put once lifted (picked) and aims an arrow instead.
        press.aiming = this.aimable(press.id);
      }
      // An aiming finger points the arrow itself; a dragged card is held above the finger.
      const at = press.aiming ? pointer : { x: pointer.x, y: pointer.y + press.lift };
      if (press.aiming) {
        this.aimTip = at;
        this.pull(this.cardUnder(at, press.id)); // a finger aiming across a fan pulls out the card it points at
      }
      else this.localDrag = { id: press.id, ...at };
      this.onDragMoveCard(press.id, at.x / this.app.screen.width, at.y / this.app.screen.height, press.aiming);
    };
    const end = (e: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      const press = this.press;
      this.press = null;
      this.localDrag = null;
      this.aimTip = null;
      if (press === null || !press.dragging) return;
      // The drop lands where the card is drawn (above a finger), or where the arrow points.
      const pointer = this.local(e);
      const at = press.aiming ? pointer : { x: pointer.x, y: pointer.y + press.lift };
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
  private cardUnder(at: { x: number; y: number }, except: CardId | null): CardId | null {
    let best: CardSprite | null = null;
    for (const sprite of this.cards.values()) {
      const place = sprite.target;
      if (place === null || sprite.id === except) continue;
      // A pulled-out card still covers the spot it rose from.
      const lift = this.pullLift(sprite);
      const top = place.y - lift - (BASE_H * place.scale) / 2;
      if (Math.abs(at.x - place.x) > (BASE_W * place.scale) / 2 || at.y < top || at.y > place.y + (BASE_H * place.scale) / 2) continue;
      if (best === null || sprite.zIndex > best.zIndex) best = sprite;
    }
    return best?.id ?? null;
  }

  /** Whether `id` is our card picked for targeting, with targets lit (so it aims rather than moves). */
  private aimable(id: CardId): boolean {
    const highlights = this.view?.highlights;
    return highlights?.get(id) === 'picked' && [...highlights.values()].includes('target');
  }

  /**
   * Whose move it is, at a glance: light along the side of whoever the game is
   * waiting on (breathing when it is us), and a turn badge left of the middle row.
   */
  private turnLayout(view: TableView, at: { width: number; height: number; rowH: number; sideW: number; scale: number }): void {
    const { width, height, rowH, sideW, scale } = at;
    const acting = actingSeat(view.state);
    if (acting === null) this.turnGlow.clear();
    else drawEdgeGlow(this.turnGlow, { width, height, side: acting === view.seat ? 'bottom' : 'top', depth: rowH * 0.9, colour: acting === view.seat ? 0xf4d35e : 0xff8a6b });
    this.turnPulse = acting === view.seat;
    const over = view.state.phase === 'over';
    const mine = view.state.activeSeat === view.seat;
    const lines = over ? ['Game over'] : [`Turn ${view.state.turn}`, mine ? 'Your turn' : 'Their turn'];
    const y = rowH * 2.5;
    const texts = lines.map((line, i) => {
      const label = new Text({ text: line, style: { fontFamily: 'system-ui, sans-serif', fontSize: (i === 0 ? 12 : 14) * scale, fontWeight: i === 0 ? 'normal' : 'bold', fill: i === 0 ? 0xcfd8cf : over ? 0xcfd8cf : mine ? 0xf4d35e : 0xffb199 } });
      label.anchor.set(0.5);
      return label;
    });
    const lineH = 18 * scale;
    const boxW = Math.max(...texts.map((t) => t.width)) + 20 * scale;
    const x = Math.max(sideW / 2, boxW / 2 + 6 * scale); // centred in the side column, but never off the edge (phones)
    const boxH = lineH * texts.length + 10 * scale;
    const pill = new Graphics()
      .roundRect(x - boxW / 2, y - boxH / 2, boxW, boxH, 8 * scale)
      .fill({ color: 0x0f1d15, alpha: 0.85 })
      .stroke({ width: 1.5, color: over ? 0x355a43 : mine ? 0xf4d35e : 0xff8a6b, alpha: 0.8 });
    this.labels.addChild(pill);
    texts.forEach((label, i) => {
      label.position.set(x, y - ((texts.length - 1) * lineH) / 2 + i * lineH);
      this.labels.addChild(label);
    });
  }

  /** Draw the targeting arrow for this frame: ours (a drag, or a click-picked card following the mouse), else the opponent's. */
  private drawAimNow(now: number): void {
    const view = this.view;
    const scale = this.cardScale();
    const dash = -now * 0.06;
    const restOf = (id: CardId): { x: number; y: number } | null => {
      const sprite = this.cards.get(id);
      return sprite?.target == null ? null : this.rest(sprite.target, sprite);
    };
    const lockOn = (from: CardId, tip: { x: number; y: number }, valid: (id: CardId) => boolean): void => {
      const origin = restOf(from);
      if (origin === null) return void this.aim.clear();
      const under = this.cardUnder(tip, from);
      const target = under !== null && valid(under) ? under : null;
      const to = target === null ? tip : (restOf(target) ?? tip);
      const ring = target === null ? 0 : (BASE_W * (this.cards.get(target)?.target?.scale ?? scale)) * 0.62;
      drawAim(this.aim, origin, to, { locked: target !== null, scale, ring, dash });
    };
    const isTarget = (id: CardId): boolean => view?.highlights.get(id) === 'target';
    if (this.press?.aiming && this.aimTip !== null) return lockOn(this.press.id, this.aimTip, isTarget);
    const picked = view === null ? undefined : [...view.highlights].find(([, h]) => h === 'picked')?.[0];
    if (picked !== undefined && this.press === null && this.pointer !== null && this.aimable(picked)) return lockOn(picked, this.pointer, isTarget);
    const peer = this.peerDrag;
    if (peer?.aim && view !== null) {
      // Their legal targets are not ours to know; lock onto any public card on the table.
      const onTable = (id: CardId): boolean => view.state.players.some((p) => p.battlefield.some((s) => s.id === id) || p.graveyard.some((s) => s.id === id));
      return lockOn(peer.id, peer, onTable);
    }
    this.aim.clear();
  }

  /** The table's card scale (cards in hand and on the battlefield). */
  private cardScale(): number {
    for (const sprite of this.cards.values()) if (sprite.target !== null) return sprite.target.scale;
    return 1;
  }

  /**
   * A Swamp waiting for its controller to pick the discard: the revealed hand
   * fans out large in the middle over a darkened table, labelled for whoever
   * is looking. Returns whether the moment is on.
   */
  private swampMoment(view: TableView, places: Map<CardId, Place>, at: MiddleRow): boolean {
    const { state, seat } = view;
    const pending = state.pending;
    if (state.phase !== 'target' || pending === null || pending.land !== 'swamp') return false;
    const victim = other(pending.controller);
    const order = this.handOrders[victim];
    const hand = order.map((id) => state.players[victim].hand.find((s) => s.id === id)).filter((s): s is CardSlot => s !== undefined);
    if (hand.length === 0 || hand.some((s) => s.land === null)) return false;
    const picking = pending.controller === seat;
    this.fan(view, hand, places, at, picking ? 'Their hand, revealed: choose one to discard' : 'Your hand, revealed: they choose one to discard');
    return true;
  }

  /** Our graveyard while we choose a land from it (a Forest): fanned large in the middle, like a revealed hand. */
  private graveyardFan(view: TableView, graveyard: readonly CardSlot[], places: Map<CardId, Place>, at: MiddleRow): boolean {
    if (graveyard.length === 0) return false;
    this.fan(view, graveyard, places, at, 'Your graveyard: choose a land');
    return true;
  }

  /**
   * Cards fanned large and slightly tilted across the middle row, over the scrim,
   * with a label above. A hovered card pulls out of the fan (see pull).
   */
  private fan(view: TableView, cards: readonly CardSlot[], places: Map<CardId, Place>, at: MiddleRow, label: string): void {
    const { width, y, rowH, cardW, scale } = at;
    const big = Math.min(1.25, (rowH * 0.95) / BASE_H / scale); // as large as the middle row allows
    const w = cardW * big;
    const n = cards.length;
    const step = n <= 1 ? 0 : Math.min(w * 0.9, (width * 0.9 - w) / (n - 1));
    cards.forEach((slot, i) => {
      const offset = i - (n - 1) / 2;
      places.set(slot.id, {
        x: width / 2 + offset * step,
        y: y + offset * offset * Math.min(4, 40 / n) * scale, // a gentle arc: outer cards sit lower
        scale: scale * big,
        face: slot.land,
        revealed: false,
        highlight: view.highlights.get(slot.id) ?? 'none',
        peer: false,
        z: 160 + i,
        angle: offset * Math.min(0.09, 0.5 / n),
        fan: true,
      });
    });
    // Clear of the tilted corners and of a card pulled up out of the fan.
    this.text(label, width / 2, y - (BASE_H * scale * big) * (0.5 + 0.22) - 16 * scale, scale, 0xe9dcff, this.layer, 170);
  }

  /** Hovering a fan card pulls it out; leaving it starts the linger, so it is still there to click or tap. */
  private pull(id: CardId | null): void {
    if (id !== null && this.cards.get(id)?.target?.fan) this.pulled = { id, until: Infinity };
    else if (this.pulled !== null && this.pulled.until === Infinity) this.pulled = { ...this.pulled, until: performance.now() + PULL_LINGER_MS };
  }

  /** How far a pulled-out fan card rises (canvas px); 0 for any other card. */
  private pullLift(sprite: CardSprite | undefined): number {
    const place = sprite?.target;
    if (sprite === undefined || place == null || !place.fan || this.pulled?.id !== sprite.id) return 0;
    return BASE_H * place.scale * 0.22;
  }

  /** A count on a battlefield pile deeper than it shows, at its top card's corner. */
  private badge(count: number, x: number, y: number, scale: number): void {
    // In the cards' layer, over its pile (pile cards sit below z 100, under the scrim at 150).
    const disc = new Graphics().circle(x, y, 11 * scale).fill(0xf4d35e).stroke({ width: 2 * scale, color: 0x0f1d15 });
    disc.zIndex = 98;
    this.layerLabels.push(disc);
    this.layer.addChild(disc);
    this.text(String(count), x, y, scale, 0x1a1a1a, this.layer, 99);
  }

  /**
   * The counter chain beside the pending play: each paid pair alternates right
   * and left of it (first counter on the right), leaning toward the payer's
   * side, numbered and labelled by who paid. Under the play: what allowing it now would do.
   */
  private chainLayout(view: TableView, places: Map<CardId, Place>, at: MiddleRow): void {
    const { width, y, rowH, cardW, scale } = at;
    const centre = width / 2;
    const small = 0.85;
    const w = cardW * small;
    const pairW = w * 1.55;
    const gap = 24 * scale;
    const slots = Math.ceil(view.chain.length / 2);
    const room = centre - cardW * 0.6 - gap - 24 * scale; // from the play's edge to the screen edge
    const step = slots <= 1 ? 0 : Math.max(0, Math.min(pairW + gap, (room - pairW) / (slots - 1)));
    view.chain.forEach((link, i) => {
      const side = i % 2 === 0 ? 1 : -1;
      const x = centre + side * (cardW * 0.6 + gap + pairW / 2 + Math.floor(i / 2) * step);
      const py = y + (link.seat === view.seat ? 1 : -1) * rowH * 0.1;
      link.cards.forEach((id, j) => {
        const slot = view.state.players[link.seat].graveyard.find((s) => s.id === id);
        places.set(id, {
          x: x + (j === 0 ? -1 : 1) * w * 0.28,
          y: py + (j === 0 ? -1 : 1) * 3 * scale,
          scale: scale * small,
          face: slot?.land ?? null,
          revealed: false,
          highlight: 'none',
          peer: false,
          z: 50 + i * 2 + j,
        });
      });
      const labelY = py + (link.seat === view.seat ? 1 : -1) * (cardW * small * 0.85 + 4 * scale);
      this.text(`${i + 1}. ${link.seat === view.seat ? 'Your' : 'Their'} counter`, x, labelY, scale, link.seat === view.seat ? 0xbfe3ff : 0xffc9b8);
    });
    const outcome = chainOutcome(view.state);
    if (outcome !== null && view.state.pending!.counters > 0) {
      const text = outcome === 'resolves' ? 'Resolves if allowed' : 'Countered if allowed';
      this.text(text, centre, y + cardW * 1.15 * 0.85 + 6 * scale, scale, outcome === 'resolves' ? 0xa8e6a1 : 0x8cc4ff);
    }
  }

  /** A label on the table; one in `into` other than the labels layer (zIndex z) is cleared by the next layout too. */
  private text(content: string, x: number, y: number, scale: number, colour = 0xcfd8cf, into: Container = this.labels, z = 0): void {
    const label = new Text({ text: content, style: { fontFamily: 'system-ui, sans-serif', fontSize: 13 * scale, fill: colour } });
    label.anchor.set(0.5);
    label.position.set(x, y);
    label.zIndex = z;
    if (into !== this.labels) this.layerLabels.push(label);
    into.addChild(label);
  }

  /** Where a card comes to rest: picked cards lift; a card the opponent is touching leans toward the middle of the table. */
  private rest(place: Place, sprite?: CardSprite): { x: number; y: number } {
    const peerLift = place.peer ? (place.y < this.app.screen.height / 2 ? 12 : -12) : 0;
    return { x: place.x, y: place.y + (place.highlight === 'picked' ? -14 : 0) + peerLift - this.pullLift(sprite) };
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
    this.scrim.alpha += (this.scrimTarget - this.scrim.alpha) * t;
    this.turnGlow.alpha = this.turnPulse ? 0.75 + 0.25 * Math.sin(now / 420) : 1;
    if (this.pulled !== null && this.pulled.until < now) this.pulled = null;
    this.drawAimNow(now);
    // An opponent drag that stops updating (its end lost on the unreliable channel) lets go.
    if (this.peerDrag !== null && now - this.peerDrag.seen > 600) this.peerDrag = null;
    for (const sprite of this.cards.values()) {
      const place = sprite.target;
      if (place === null) continue;
      const local = this.localDrag?.id === sprite.id ? this.localDrag : null;
      const peer = this.peerDrag?.id === sprite.id && !this.peerDrag.aim ? this.peerDrag : null; // an aiming card stays put
      // A face under the mouse tilts toward it and catches the light; a drag or press lets go.
      const tilting = sprite.id === this.hovered && this.pointer !== null && this.press === null && local === null;
      sprite.hover += ((tilting ? 1 : 0) - sprite.hover) * (1 - Math.pow(0.001, deltaMS / 150));
      if (sprite.hover > 0.01 && this.pointer !== null) {
        const half = { x: (BASE_W * sprite.scale.x) / 2, y: (BASE_H * sprite.scale.y) / 2 };
        const rx = Math.max(-1, Math.min(1, (this.pointer.x - sprite.x) / half.x));
        const ry = Math.max(-1, Math.min(1, (this.pointer.y - sprite.y) / half.y));
        sprite.skew.set(-ry * 0.045 * sprite.hover, rx * 0.045 * sprite.hover);
        sprite.shine.x = rx * BASE_W * 0.55;
        sprite.shine.alpha = 0.9 * sprite.hover;
      } else if (sprite.hover <= 0.01 && sprite.shine.alpha !== 0) {
        sprite.skew.set(0, 0);
        sprite.shine.alpha = 0;
      }
      const lift = this.pullLift(sprite);
      sprite.zIndex = local !== null || peer !== null ? 400 : place.z + (place.highlight === 'picked' ? 200 : 0) + (lift > 0 ? 30 : 0);
      if (sprite.pulledHit !== lift > 0) {
        // Reach down over the spot the card rose from, so the pointer that pulled it stays on it.
        sprite.pulledHit = lift > 0;
        sprite.hitArea = lift > 0 ? new Rectangle(-BASE_W / 2, -BASE_H / 2, BASE_W, BASE_H + lift / place.scale) : null;
      }
      if (local !== null || peer !== null) {
        // A held card follows the pointer: tightly for ours, smoothed for theirs (~20 Hz updates).
        const follow = local !== null ? 1 - Math.pow(0.001, deltaMS / 60) : t;
        const to = (local ?? peer)!;
        sprite.x += (to.x - sprite.x) * follow;
        sprite.y += (to.y - sprite.y) * follow;
        sprite.scale.set(sprite.scale.x + (place.scale * 1.12 - sprite.scale.x) * follow);
        sprite.rotation += (0 - sprite.rotation) * follow;
        continue;
      }
      if (sprite.holdUntil > now) continue;
      const at = this.rest(place, sprite);
      sprite.x += (at.x - sprite.x) * t;
      sprite.y += (at.y - sprite.y) * t;
      const s = sprite.scale.x + (place.scale * (1 + 0.06 * sprite.hover) - sprite.scale.x) * t;
      sprite.scale.set(s);
      sprite.rotation += ((place.angle ?? 0) - sprite.rotation) * t;
    }
  }
}
