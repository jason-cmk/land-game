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
  /** The card's size where it is heading, in pixels, and its tilt in radians. */
  size(id: CardId): { width: number; height: number; angle: number } | null;
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

/** A point on the quadratic curve from `a` through control `c` to `b`. */
function curve(a: { x: number; y: number }, c: { x: number; y: number }, b: { x: number; y: number }, t: number): { x: number; y: number } {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

/** A filled disc that swells and fades: the flash of an impact. */
function flash(host: FxHost, x: number, y: number, colour: number, radius: number, ms: number, delay = 0): void {
  const g = new Graphics().circle(0, 0, radius).fill(colour);
  g.position.set(x, y);
  g.alpha = 0;
  g.blendMode = 'add'; // light, not paint: fading never leaves a muddy disc
  host.layer.addChild(g);
  host.animate((elapsed) => {
    const t = (elapsed - delay) / ms;
    if (t < 0) return true;
    if (t >= 1) {
      g.destroy();
      return false;
    }
    g.alpha = 0.8 * (1 - t) * (1 - t);
    g.scale.set(0.5 + t);
    return true;
  });
}

/**
 * Island counter: the paying cards splash and hold a beat, then a bolt of
 * water arcs from each into the play on the stack, which takes the hit.
 */
function counter(host: FxHost, cards: readonly CardId[], stackCard: CardId | null): void {
  const target = stackCard === null ? null : host.destination(stackCard); // it may still be gliding there
  cards.forEach((id, i) => {
    const from = host.position(id);
    if (from === null) return;
    host.hold(id, 450);
    host.bump(id, 1.15);
    particles(host, { x: from.x, y: from.y, count: 22, colours: [0x6fb7ff, 0xbfe3ff, 0xffffff], speed: [80, 220], size: [2, 4], life: [300, 650], gravity: 260, angle: [Math.PI, Math.PI * 2] });
    if (target === null) return;
    const control = { x: (from.x + target.x) / 2, y: Math.min(from.y, target.y) - host.screen.height * 0.18 };
    const bolt = new Graphics();
    for (const [r, c, a] of [[16, 0x2f7fff, 0.3], [10, 0x6fb7ff, 0.6], [5, 0xe8f5ff, 1]] as const) bolt.circle(0, 0, r).fill({ color: c, alpha: a });
    bolt.visible = false;
    host.layer.addChild(bolt);
    const delay = 120 + i * 110;
    const flight = 380;
    host.animate((elapsed) => {
      const t = (elapsed - delay) / flight;
      if (t < 0) return true;
      bolt.visible = true;
      const at = curve(from, control, target, Math.min(t, 1));
      bolt.position.set(at.x, at.y);
      particles(host, { x: at.x, y: at.y, count: 2, colours: [0x9fd0ff, 0xffffff], speed: [5, 30], size: [1.5, 3.5], life: [200, 400], gravity: 120, spread: 6 });
      if (t < 1) return true;
      bolt.destroy();
      if (i === cards.length - 1) {
        flash(host, target.x, target.y, 0x9fd0ff, 60, 350);
        for (let k = 0; k < 3; k++) ring(host, target.x, target.y, 0x5fa8ff, 30, 170, 650, 7, k * 120);
        particles(host, { x: target.x, y: target.y, count: 36, colours: [0x6fb7ff, 0xbfe3ff, 0xffffff], speed: [120, 360], size: [2, 4], life: [400, 800], gravity: 500, angle: [Math.PI * 1.1, Math.PI * 1.9] });
        if (stackCard !== null) host.bump(stackCard, 0.9);
        host.shake(200, 5);
      }
      return false;
    });
  });
}

/** Countered: the play cracks, then bursts into spinning blue shards on its way to the graveyard. */
function countered(host: FxHost, card: CardId): void {
  const at = host.position(card);
  const size = host.size(card);
  if (at === null || size === null) return;
  const crackMS = 260;
  host.hold(card, crackMS + 220);
  host.bump(card, 1.08);
  // Jagged cracks run out from the middle of the card.
  const rays = Array.from({ length: 7 }, (_, k) => {
    const angle = (k / 7) * Math.PI * 2 + Math.random() * 0.5;
    const points = [{ x: 0, y: 0 }];
    for (let j = 1; j <= 4; j++) {
      const r = (j / 4) * Math.hypot(size.width, size.height) * 0.5;
      const wobble = (Math.random() - 0.5) * 0.5;
      points.push({ x: Math.cos(angle + wobble) * r, y: Math.sin(angle + wobble) * r });
    }
    return points;
  });
  const cracks = new Graphics();
  cracks.position.set(at.x, at.y);
  host.layer.addChild(cracks);
  const mask = new Graphics().rect(-size.width / 2, -size.height / 2, size.width, size.height).fill(0xffffff);
  mask.position.set(at.x, at.y);
  mask.rotation = size.angle;
  host.layer.addChild(mask);
  cracks.mask = mask;
  host.animate((elapsed) => {
    const t = Math.min(elapsed / crackMS, 1);
    cracks.clear();
    for (const points of rays) {
      const shown = Math.max(1, Math.round(t * (points.length - 1)));
      cracks.moveTo(points[0]!.x, points[0]!.y);
      for (let j = 1; j <= shown; j++) cracks.lineTo(points[j]!.x, points[j]!.y);
    }
    cracks.stroke({ width: 2.5, color: 0xe8f5ff, alpha: 0.95 });
    if (t < 1) return true;
    cracks.destroy();
    mask.destroy();
    flash(host, at.x, at.y, 0xbfe3ff, size.width * 0.7, 260);
    ring(host, at.x, at.y, 0x9fd0ff, 20, 130, 380, 8);
    shards(host, at, size);
    host.bump(card, 0.8);
    host.shake(160, 4);
    return false;
  });
}

/** Triangular shards that fly out, spin and fall. */
function shards(host: FxHost, at: { x: number; y: number }, size: { width: number; height: number }): void {
  const pieces = Array.from({ length: 16 }, () => {
    const r = 4 + Math.random() * 9;
    const g = new Graphics()
      .poly([0, -r, r * 0.8, r * 0.6, -r * 0.7, r * 0.5])
      .fill({ color: [0xbfe3ff, 0x6fb7ff, 0xffffff][Math.floor(Math.random() * 3)]!, alpha: 0.95 });
    g.position.set(at.x + (Math.random() - 0.5) * size.width * 0.8, at.y + (Math.random() - 0.5) * size.height * 0.8);
    host.layer.addChild(g);
    const angle = Math.atan2(g.y - at.y, g.x - at.x);
    const speed = 140 + Math.random() * 260;
    return { g, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 120, spin: (Math.random() - 0.5) * 14, life: 600 + Math.random() * 400 };
  });
  let last = 0;
  host.animate((elapsed) => {
    const dt = (elapsed - last) / 1000;
    last = elapsed;
    let alive = 0;
    for (const p of pieces) {
      if (p.g.destroyed) continue;
      const t = elapsed / p.life;
      if (t >= 1) {
        p.g.destroy();
        continue;
      }
      alive++;
      p.vy += 700 * dt;
      p.g.x += p.vx * dt;
      p.g.y += p.vy * dt;
      p.g.rotation += p.spin * dt;
      p.g.alpha = 1 - t * t;
    }
    return alive > 0;
  });
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

/**
 * Forest: a green glow in the graveyard, then a vine grows along the path the
 * card will take to its owner's hand, sprouting leaves; leaves burst where it lands.
 */
function regrowth(host: FxHost, card: CardId): void {
  const from = host.position(card);
  const to = host.destination(card);
  if (from === null || to === null) return;
  const holdMS = 520;
  host.hold(card, holdMS);
  host.bump(card, 1.2);
  flash(host, from.x, from.y, 0x7ddf7d, 40, 450);
  ring(host, from.x, from.y, 0x9be89b, 15, 70, 500, 5);
  const bend = (to.x >= from.x ? 1 : -1) * host.screen.width * 0.12;
  const control = { x: (from.x + to.x) / 2 - bend, y: (from.y + to.y) / 2 };
  const samples = 40;
  const path = Array.from({ length: samples + 1 }, (_, k) => {
    const t = k / samples;
    const p = curve(from, control, to, t);
    // A slow wiggle across the path, so it reads as a growing stem rather than a line.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const sway = Math.sin(t * Math.PI * 3) * 10 * (1 - t);
    return { x: p.x + (-dy / len) * sway, y: p.y + (dx / len) * sway };
  });
  const vine = new Graphics();
  host.layer.addChild(vine);
  const leaves: Graphics[] = [];
  const growMS = 600;
  const fadeMS = 450;
  host.animate((elapsed) => {
    const grown = Math.min(elapsed / growMS, 1);
    const shown = Math.max(1, Math.round(grown * samples));
    // A stroke uses its path up, so the stem is traced once for its dark body and again for its highlight.
    const stem = (): void => {
      vine.moveTo(path[0]!.x, path[0]!.y);
      for (let k = 1; k <= shown; k++) vine.lineTo(path[k]!.x, path[k]!.y);
    };
    vine.clear();
    stem();
    vine.stroke({ width: 4, color: 0x3f9d4e, alpha: 1 });
    stem();
    vine.stroke({ width: 1.5, color: 0xa6e88f, alpha: 0.9 });
    // A leaf every few samples as the tip passes.
    while (leaves.length < Math.floor(shown / 5)) {
      const k = (leaves.length + 1) * 5;
      const p = path[Math.min(k, samples)]!;
      const leaf = new Graphics().ellipse(0, -6, 4, 8).fill(leaves.length % 2 === 0 ? 0x6fcf6f : 0x3f9d4e);
      leaf.position.set(p.x, p.y);
      leaf.rotation = (leaves.length % 2 === 0 ? 1 : -1) * 0.9;
      leaf.scale.set(0);
      host.layer.addChild(leaf);
      leaves.push(leaf);
    }
    for (const leaf of leaves) leaf.scale.set(Math.min(1, leaf.scale.x + 0.12));
    const fading = (elapsed - growMS) / fadeMS;
    if (fading > 0) {
      vine.alpha = 1 - fading;
      for (const leaf of leaves) leaf.alpha = 1 - fading;
    }
    if (fading < 1) return true;
    vine.destroy();
    for (const leaf of leaves) leaf.destroy();
    return false;
  });
  host.animate((elapsed) => {
    if (elapsed < holdMS + 380) return true; // the card has nearly glided home
    particles(host, { x: to.x, y: to.y, count: 26, colours: [0x6fcf6f, 0x3f9d4e, 0xc8f29a], speed: [40, 150], size: [2, 5], life: [600, 1100], gravity: -60, spread: 20 });
    ring(host, to.x, to.y, 0x9be89b, 20, 80, 450, 4);
    return false;
  });
}

/**
 * Swamp: dark tendrils reach in and grab the discarded card, which darkens,
 * then it bursts into smoke and slinks off to the graveyard.
 */
function discard(host: FxHost, card: CardId): void {
  const at = host.position(card);
  const size = host.size(card);
  if (at === null || size === null) return;
  const grabMS = 380;
  host.hold(card, grabMS + 300);
  const reach = Math.max(size.width, size.height) * 1.1;
  const tendrils = Array.from({ length: 6 }, (_, k) => {
    const angle = Math.PI * 0.15 + (k / 5) * Math.PI * 0.7 + (Math.random() - 0.5) * 0.3; // from below
    const from = { x: at.x + Math.cos(angle) * reach, y: at.y + Math.sin(angle) * reach };
    const control = { x: (from.x + at.x) / 2 + (Math.random() - 0.5) * reach * 0.8, y: (from.y + at.y) / 2 };
    return { from, control };
  });
  const g = new Graphics();
  host.layer.addChild(g);
  const shadow = new Graphics().roundRect(-size.width / 2, -size.height / 2, size.width, size.height, 6).fill(0x1a1022);
  shadow.position.set(at.x, at.y);
  shadow.rotation = size.angle; // a card fanned out by the reveal is tilted
  shadow.alpha = 0;
  host.layer.addChild(shadow);
  host.animate((elapsed) => {
    const t = Math.min(elapsed / grabMS, 1);
    // Traced once per stroke: a stroke uses its path up.
    const trace = (): void => {
      for (const { from, control } of tendrils) {
        g.moveTo(from.x, from.y);
        for (let k = 1; k <= 12; k++) {
          const p = curve(from, control, at, (k / 12) * t);
          g.lineTo(p.x, p.y);
        }
      }
    };
    g.clear();
    trace();
    g.stroke({ width: 7, color: 0x241830, alpha: 0.85 });
    trace();
    g.stroke({ width: 2.5, color: 0x6b4a8a, alpha: 0.9 });
    shadow.alpha = 0.65 * t;
    if (t < 1) return true;
    g.destroy();
    flash(host, at.x, at.y, 0x3b2f45, size.width * 0.8, 400);
    ring(host, at.x, at.y, 0x8a6bb0, 20, 120, 450, 6);
    particles(host, { x: at.x, y: at.y, count: 40, colours: [0x3b2f45, 0x5c4a6b, 0x1e1726, 0x6b4a8a], speed: [15, 80], size: [6, 13], life: [800, 1400], gravity: -40, spread: 30, grow: 2.4 });
    host.bump(card, 0.85);
    host.shake(180, 4);
    host.animate((later) => {
      shadow.alpha = 0.65 * Math.max(0, 1 - later / 300);
      if (later < 300) return true;
      shadow.destroy();
      return false;
    });
    return false;
  });
}

/** Plains: a golden halo around the land being reused. */
function reuse(host: FxHost, card: CardId): void {
  const at = host.position(card);
  if (at === null) return;
  for (let i = 0; i < 2; i++) ring(host, at.x, at.y, 0xffe9a8, 40, 90, 700, 5, i * 250);
  particles(host, { x: at.x, y: at.y, count: 18, colours: [0xfff3c4, 0xffd56b], speed: [20, 70], size: [1.5, 3], life: [500, 900], gravity: -60, spread: 40 });
}

/** Swamp reveal: the hand fans out into the middle; each card flashes as it arrives, one after another. */
function reveal(host: FxHost, cards: readonly CardId[]): void {
  cards.forEach((id, i) => {
    const at = host.destination(id); // where the fan puts it
    if (at === null) return;
    const delay = 320 + i * 110;
    ring(host, at.x, at.y, 0xe9dcff, 25, 90, 480, 5, delay);
    flash(host, at.x, at.y, 0xffffff, 34, 320, delay);
    host.animate((elapsed) => {
      if (elapsed < delay) return true;
      particles(host, { x: at.x, y: at.y, count: 10, colours: [0xffffff, 0xe9dcff], speed: [40, 120], size: [1.5, 3], life: [300, 600], spread: 20 });
      return false;
    });
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
