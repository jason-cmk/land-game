// Effect animations, one per cue. Each effect draws on the table's fx layer
// and may hold a card where it is (so a meteor lands before the card leaves)
// or bump its scale. Effects only decorate: the card always ends where the
// layout put it, so a skipped or interrupted effect can never desync the view.

import { Container, Graphics, Text } from 'pixi.js';
import type { CardId } from '../engine/types.ts';
import type { Cue } from './effects.ts';

/** What an effect may do to the table. */
export interface FxHost {
  readonly layer: Container;
  /** The card's on-screen position right now (before it eases anywhere). */
  position(id: CardId): { x: number; y: number } | null;
  /** Where the card is heading in the current layout. */
  destination(id: CardId): { x: number; y: number } | null;
  /** Keep the card where it is for `ms` before it eases to its new place. */
  hold(id: CardId, ms: number): void;
  /** Multiply the card's current scale; it eases back on its own. */
  bump(id: CardId, factor: number): void;
  shake(ms: number, amplitude: number): void;
  /** Run `frame` every tick until it returns false. */
  animate(frame: (elapsedMS: number) => boolean): void;
  readonly screen: { readonly width: number; readonly height: number };
}

interface ParticleOptions {
  readonly x: number;
  readonly y: number;
  readonly count: number;
  readonly colours: readonly number[];
  readonly speed: [number, number]; // px per second
  readonly size: [number, number];
  readonly life: [number, number]; // ms
  readonly gravity?: number; // px per second^2, positive is down
  readonly angle?: [number, number]; // radians; default all around
  readonly spread?: number; // spawn radius
  readonly grow?: number; // size multiplier at end of life
}

const between = ([lo, hi]: [number, number]): number => lo + Math.random() * (hi - lo);

/** A burst of fading dots. */
function particles(host: FxHost, o: ParticleOptions): void {
  const dots = Array.from({ length: o.count }, () => {
    const angle = o.angle ? between(o.angle) : Math.random() * Math.PI * 2;
    const speed = between(o.speed);
    const r = o.spread ? Math.random() * o.spread : 0;
    const g = new Graphics().circle(0, 0, between(o.size)).fill(o.colours[Math.floor(Math.random() * o.colours.length)]!);
    g.position.set(o.x + Math.cos(angle) * r, o.y + Math.sin(angle) * r);
    host.layer.addChild(g);
    return { g, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: between(o.life) };
  });
  let last = 0;
  host.animate((elapsed) => {
    const dt = (elapsed - last) / 1000;
    last = elapsed;
    let alive = 0;
    for (const d of dots) {
      if (d.g.destroyed) continue;
      const t = elapsed / d.life;
      if (t >= 1) {
        d.g.destroy();
        continue;
      }
      alive++;
      d.vy += (o.gravity ?? 0) * dt;
      d.g.x += d.vx * dt;
      d.g.y += d.vy * dt;
      d.g.alpha = 1 - t;
      d.g.scale.set(1 + ((o.grow ?? 1) - 1) * t);
    }
    return alive > 0;
  });
}

/** An expanding, fading ring. */
function ring(host: FxHost, x: number, y: number, colour: number, from: number, to: number, ms: number, width = 4, delay = 0): void {
  const g = new Graphics();
  g.position.set(x, y);
  host.layer.addChild(g);
  host.animate((elapsed) => {
    const t = (elapsed - delay) / ms;
    if (t < 0) return true;
    if (t >= 1) {
      g.destroy();
      return false;
    }
    const eased = 1 - (1 - t) * (1 - t);
    g.clear()
      .circle(0, 0, from + (to - from) * eased)
      .stroke({ width: width * (1 - t) + 1, color: colour, alpha: 1 - t });
    return true;
  });
}

/** Mountain: a meteor falls on the land, then it goes to the graveyard. */
function meteor(host: FxHost, card: CardId): void {
  const at = host.position(card);
  if (at === null) return;
  const flight = 550;
  host.hold(card, flight + 250);
  const start = { x: at.x + host.screen.width * 0.35, y: -80 };
  const rock = new Graphics();
  for (const [r, c, a] of [[30, 0xff6a00, 0.25], [20, 0xffa040, 0.5], [12, 0xffe08a, 1]] as const) rock.circle(0, 0, r).fill({ color: c, alpha: a });
  rock.position.set(start.x, start.y);
  host.layer.addChild(rock);
  host.animate((elapsed) => {
    const t = Math.min(elapsed / flight, 1);
    const eased = t * t; // accelerating fall
    rock.position.set(start.x + (at.x - start.x) * eased, start.y + (at.y - start.y) * eased);
    rock.rotation += 0.2;
    particles(host, { x: rock.x, y: rock.y, count: 2, colours: [0xffb347, 0xff6a00, 0x7a3b1d], speed: [10, 40], size: [2, 5], life: [200, 400], spread: 10 });
    if (t < 1) return true;
    rock.destroy();
    ring(host, at.x, at.y, 0xffd27a, 10, 140, 400, 10);
    particles(host, { x: at.x, y: at.y, count: 46, colours: [0x6b4a2f, 0x8c6239, 0xff7b2e, 0xffc15e], speed: [120, 420], size: [2, 6], life: [400, 900], gravity: 600, angle: [Math.PI, Math.PI * 2] });
    host.shake(320, 10);
    host.bump(card, 0.8);
    return false;
  });
}

/** Island counter: blue waves on the stack; the paying cards splash. */
function counter(host: FxHost, cards: readonly CardId[], stackCard: CardId | null): void {
  for (const id of cards) {
    const at = host.position(id);
    if (at !== null) particles(host, { x: at.x, y: at.y, count: 16, colours: [0x6fb7ff, 0xbfe3ff], speed: [60, 180], size: [2, 4], life: [300, 600], gravity: 200 });
  }
  const target = stackCard === null ? null : host.destination(stackCard); // it may still be gliding there
  if (target !== null) {
    for (let i = 0; i < 3; i++) ring(host, target.x, target.y, 0x5fa8ff, 30, 110, 600, 6, i * 140);
  }
}

/** Countered: the play shatters into blue shards on its way to the graveyard. */
function countered(host: FxHost, card: CardId): void {
  const at = host.position(card);
  if (at === null) return;
  host.hold(card, 260);
  ring(host, at.x, at.y, 0x9fd0ff, 20, 90, 300, 8);
  particles(host, { x: at.x, y: at.y, count: 24, colours: [0xbfe3ff, 0x6fb7ff, 0xffffff], speed: [80, 260], size: [2, 4], life: [300, 700], spread: 20 });
  host.bump(card, 0.85);
}

/** A land enters the battlefield: lands with a thump and a puff of dust. */
function enter(host: FxHost, card: CardId): void {
  host.bump(card, 1.25);
  host.animate((elapsed) => {
    if (elapsed < 280) return true;
    const at = host.position(card);
    if (at !== null) {
      particles(host, { x: at.x, y: at.y + 40, count: 14, colours: [0xc9c2b0, 0x9c9480], speed: [30, 110], size: [2, 4], life: [300, 600], angle: [Math.PI * 0.9, Math.PI * 2.1], grow: 1.8 });
    }
    return false;
  });
}

/** Forest: leaves rise as the land returns to hand. */
function regrowth(host: FxHost, card: CardId): void {
  const at = host.position(card);
  if (at === null) return;
  host.hold(card, 300);
  particles(host, { x: at.x, y: at.y, count: 28, colours: [0x6fcf6f, 0x3f9d4e, 0xc8f29a], speed: [30, 120], size: [2, 5], life: [600, 1100], gravity: -80, spread: 30, angle: [Math.PI, Math.PI * 2] });
}

/** Swamp: the discarded card dissolves into smoke. */
function discard(host: FxHost, card: CardId): void {
  const at = host.position(card);
  if (at === null) return;
  host.hold(card, 420);
  particles(host, { x: at.x, y: at.y, count: 30, colours: [0x3b2f45, 0x5c4a6b, 0x1e1726], speed: [10, 60], size: [6, 12], life: [700, 1300], gravity: -40, spread: 30, grow: 2.2 });
}

/** Plains: a golden halo around the land being reused. */
function reuse(host: FxHost, card: CardId): void {
  const at = host.position(card);
  if (at === null) return;
  for (let i = 0; i < 2; i++) ring(host, at.x, at.y, 0xffe9a8, 40, 90, 700, 5, i * 250);
  particles(host, { x: at.x, y: at.y, count: 18, colours: [0xfff3c4, 0xffd56b], speed: [20, 70], size: [1.5, 3], life: [500, 900], gravity: -60, spread: 40 });
}

/** Swamp reveal: each revealed card flashes. */
function reveal(host: FxHost, cards: readonly CardId[]): void {
  cards.forEach((id, i) => {
    const at = host.position(id);
    if (at !== null) ring(host, at.x, at.y, 0xffffff, 20, 70, 450, 5, i * 90);
  });
}

/** The win: a fountain of gold and a banner. */
function win(host: FxHost, text: string): void {
  const { width, height } = host.screen;
  for (let i = 0; i < 4; i++) {
    host.animate((elapsed) => {
      if (elapsed < i * 250) return true;
      particles(host, { x: width * (0.2 + 0.2 * i), y: height, count: 60, colours: [0xffd56b, 0xfff3c4, 0xf4d35e, 0xffffff], speed: [350, 700], size: [2, 5], life: [1200, 2000], gravity: 500, angle: [Math.PI * 1.35, Math.PI * 1.65] });
      return false;
    });
  }
  const banner = new Text({ text, style: { fontFamily: 'Georgia, serif', fontSize: 54, fontWeight: 'bold', fill: 0xffe9a8, stroke: { color: 0x2b2118, width: 6 } } });
  banner.anchor.set(0.5);
  banner.position.set(width / 2, height / 2);
  banner.alpha = 0;
  host.layer.addChild(banner);
  host.animate((elapsed) => {
    const t = Math.min(elapsed / 600, 1);
    banner.alpha = t;
    banner.scale.set(0.6 + 0.4 * (1 - (1 - t) * (1 - t)));
    return t < 1;
  });
}

/** Play every cue from one state change. `viewer` decides the win banner text. */
export function playCues(host: FxHost, cues: readonly Cue[], viewer: 0 | 1, stackCard: CardId | null): void {
  for (const cue of cues) {
    switch (cue.kind) {
      case 'meteor':
        meteor(host, cue.card);
        break;
      case 'counter':
        counter(host, cue.cards, stackCard);
        break;
      case 'countered':
        countered(host, cue.card);
        break;
      case 'enter':
        enter(host, cue.card);
        break;
      case 'regrowth':
        regrowth(host, cue.card);
        break;
      case 'discard':
        discard(host, cue.card);
        break;
      case 'reuse':
        reuse(host, cue.card);
        break;
      case 'reveal':
        reveal(host, cue.cards);
        break;
      case 'win':
        win(host, cue.seat === viewer ? 'Victory' : 'Defeat');
        break;
      case 'announce':
      case 'draw':
        break; // the glide to the stack or the hand is the animation
    }
  }
}
