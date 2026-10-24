// Card art, drawn in code: simplified full-art MTG basic lands and an abstract
// card back. Each design is drawn once into a Container centred on (0, 0) at
// the base card size; the table bakes them into textures, so a full table of
// cards costs no more to draw than coloured rectangles did.

import { Container, Graphics, Text } from 'pixi.js';
import type { Land } from '../engine/types.ts';
import { landName } from './controls.ts';

export const CARD_W = 80;
export const CARD_H = 112;

interface Palette {
  readonly rule: number; // the thin coloured line around the art
  readonly bar: number; // name bar
  readonly ink: number; // name text
  readonly symbol: number; // mana symbol disc
  readonly glyph: number; // the drawing on the disc
}

export const PALETTES: Record<Land, Palette> = {
  plains: { rule: 0xf4efe0, bar: 0xf6f0d8, ink: 0x3d331c, symbol: 0xf8f1c8, glyph: 0x6b5a2e },
  island: { rule: 0x2d6fc0, bar: 0xd7e6f5, ink: 0x14304f, symbol: 0xaad4f5, glyph: 0x163d66 },
  swamp: { rule: 0x77727c, bar: 0xd6cfdb, ink: 0x2a2030, symbol: 0xc9bfcf, glyph: 0x231b28 },
  mountain: { rule: 0xd2432c, bar: 0xf3d9cf, ink: 0x4a1a0e, symbol: 0xf3a58c, glyph: 0x4a1a0e },
  forest: { rule: 0x2f8a3e, bar: 0xd4e8cf, ink: 0x183a20, symbol: 0x9fd39a, glyph: 0x183a20 },
};

// Art window, in card coordinates: full art, nearly the whole card.
const ART = { x: -34, y: -48, w: 68, h: 92 };
const BOTTOM = ART.y + ART.h;

type Stops = readonly (readonly [number, number])[]; // [position 0..1, colour]

/** A vertical gradient across the art's width, as thin horizontal bands. */
function band(g: Graphics, y0: number, y1: number, stops: Stops): void {
  const n = Math.ceil((y1 - y0) / 1.5);
  for (let i = 0; i < n; i++) {
    g.rect(ART.x, y0 + ((y1 - y0) * i) / n, ART.w, (y1 - y0) / n + 0.5).fill(at(stops, (i + 0.5) / n));
  }
}

function at(stops: Stops, t: number): number {
  for (let i = 1; i < stops.length; i++) {
    const [t0, c0] = stops[i - 1]!;
    const [t1, c1] = stops[i]!;
    if (t <= t1) return mix(c0, c1, t1 === t0 ? 1 : Math.max(0, (t - t0) / (t1 - t0)));
  }
  return stops[stops.length - 1]![1];
}

/** A soft light: stacked translucent ellipses, brightest in the middle. */
function glow(g: Graphics, x: number, y: number, rx: number, ry: number, colour: number, alpha: number): void {
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    const k = 1 - i / steps;
    g.ellipse(x, y, rx * k, ry * k).fill({ color: colour, alpha: alpha / steps });
  }
}

function mix(a: number, b: number, t: number): number {
  const channel = (shift: number): number => Math.round(((a >> shift) & 0xff) * (1 - t) + ((b >> shift) & 0xff) * t) << shift;
  return channel(16) | channel(8) | channel(0);
}

// Full-art scenes after John Avon's Unhinged basics, reduced to flat shapes.
const SCENES: Record<Land, (g: Graphics) => void> = {
  plains(g) {
    // Sunset over a wide sandy plain with wind ripples.
    band(g, ART.y, -2, [[0, 0xd2741e], [0.6, 0xf0b440], [1, 0xfff2b0]]);
    glow(g, 0, -4, 28, 9, 0xffffff, 0.8);
    g.poly([ART.x, -2, -20, -6, -6, -4, 8, -7, 22, -4, 34, -6, 34, 3, ART.x, 3]).fill(0xd6a454);
    band(g, 2, BOTTOM, [[0, 0xe8b860], [0.4, 0xd09440], [1, 0x9a5e24]]);
    g.poly([ART.x, 3, -28, 1.5, -20, 2.5, -12, 1.2, -4, 2.4, 4, 1, 12, 2.2, 20, 1.4, 28, 2.6, 34, 1.8, 34, 4, ART.x, 4]).fill(0x7a5226);
    g.poly([-3, 3, 3, 3, 14, BOTTOM, -10, BOTTOM]).fill({ color: 0xf6d27a, alpha: 0.3 });
    g.moveTo(ART.x, 20).quadraticCurveTo(-10, 14, 6, 21).quadraticCurveTo(20, 27, 34, 22);
    g.moveTo(ART.x, 31).quadraticCurveTo(-14, 25, 2, 32).quadraticCurveTo(18, 38, 34, 33);
    g.moveTo(-20, 41).quadraticCurveTo(0, 36, 34, 42);
    g.ellipse(14, 11, 9, 2);
    g.stroke({ width: 0.9, color: 0x8a5422, alpha: 0.55 });
  },
  island(g) {
    // Seen from the air: a green island in a deep blue sea, an islet on the horizon.
    band(g, ART.y, -30, [[0, 0xf4f9fc], [1, 0xb5d6ec]]);
    band(g, -30, BOTTOM, [[0, 0x8cbfe3], [0.35, 0x3f86c8], [1, 0x1d4d9c]]);
    g.ellipse(6, -27, 7, 1.2).fill(0x4d6b5a);
    const island = [ART.x, 30, -30, 18, -24, 10, -20, 0, -12, -6, -4, -12, 6, -16, 14, -14, 22, -12, 26, -6, 22, 0, 16, 2, 12, 8, 4, 12, -2, 18, -8, 22, -14, 30, -20, 32, -28, 34, ART.x, 36];
    g.poly(island).stroke({ width: 2.5, color: 0x9fd6c8, alpha: 0.55 });
    g.poly(island).fill(0x3f7a3a);
    g.poly([-30, 28, -20, 22, -10, 16, 0, 10, 10, 6, 16, 2, 8, 10, -2, 18, -10, 26, -20, 32, -30, 34]).fill(0x2a5a2c);
    g.poly([-22, 4, -12, -4, -2, -10, 8, -14, 16, -12, 12, -6, 2, -2, -8, 4, -16, 10]).fill(0x6aa14f);
    for (const [x, y] of [[-18, 14], [-10, 8], [-4, 2], [4, -4], [10, -8], [-14, 22], [-24, 20], [2, 6]] as const) g.circle(x, y, 1.1).fill(0x3a7436);
    for (const [x, y] of [[18, 12], [-6, 34], [10, 26], [24, 20], [-26, 41], [20, 38]] as const) g.moveTo(x, y).lineTo(x + 5, y - 0.6);
    g.stroke({ width: 0.8, color: 0xcfe6f7, alpha: 0.5 });
  },
  swamp(g) {
    // Grey mist, a pale sun low between dead trees, still black water.
    band(g, ART.y, 14, [[0, 0x6e6c74], [0.7, 0xb9b7be], [1, 0xd8d6dc]]);
    glow(g, 0, 8, 24, 20, 0xffffff, 0.9);
    band(g, 14, BOTTOM, [[0, 0x77757c], [1, 0x2c2a2f]]);
    glow(g, 0, 24, 6, 18, 0xffffff, 0.6);
    // Faint trees in the mist.
    for (const x of [-20, -7, 9, 21]) g.moveTo(x, 15).lineTo(x + 1, -30).moveTo(x + 0.6, -10).lineTo(x + 5, -17).moveTo(x + 0.8, -20).lineTo(x - 4, -26);
    g.stroke({ width: 0.9, color: 0x8a8790, alpha: 0.8 });
    // Twisted dead trees at both sides.
    const dark = 0x1e1c21;
    g.moveTo(-29, BOTTOM).bezierCurveTo(-27, 20, -31, 0, -25, -18).bezierCurveTo(-22, -26, -28, -32, -24, -40);
    g.moveTo(26, BOTTOM).bezierCurveTo(23, 14, 27, -4, 22, -20);
    g.stroke({ width: 3, color: dark, cap: 'round' });
    g.moveTo(-26, -10).quadraticCurveTo(-16, -14, -12, -24).moveTo(-25, -22).quadraticCurveTo(-34, -28, -32, -38);
    g.moveTo(-13, -23).lineTo(-8, -28).moveTo(23, -6).quadraticCurveTo(14, -10, 12, -20).moveTo(23, -14).quadraticCurveTo(30, -22, 28, -30);
    g.moveTo(12, -19).lineTo(16, -26).moveTo(-28, 6).quadraticCurveTo(-20, 4, -17, -2);
    g.stroke({ width: 1.3, color: dark, cap: 'round' });
    // Ripples and reflections.
    g.moveTo(-14, 30).lineTo(-6, 30).moveTo(6, 36).lineTo(14, 36).moveTo(-20, 39).lineTo(-12, 39);
    g.stroke({ width: 0.7, color: 0x1a181c, alpha: 0.6 });
  },
  mountain(g) {
    // Jagged red peaks under a red sky, dark cliffs framing a valley lake.
    band(g, ART.y, 30, [[0, 0xe8553f], [0.6, 0xf08a72], [1, 0xf6b8a6]]);
    g.poly([ART.x, 10, -10, -6, 4, -2, 14, -24, 20, -16, 26, -30, 34, -14, 34, 10]).fill(0xd98a80);
    g.poly([ART.x, 30, -26, -6, -20, -16, -14, -34, -8, -20, -2, -28, 6, -6, 12, 4, 20, -8, 28, 6, 34, 20, 34, 30]).fill(0xa9524b);
    g.poly([-14, -34, -11, -16, -6, -6, -2, -28, -8, -20]).fill(0xc0675e);
    g.poly([20, -8, 22, 4, 28, 6]).fill(0xc0675e);
    g.moveTo(-14, -34).lineTo(-12, -27).lineTo(-13, -21).moveTo(-2, -28).lineTo(-1, -20).moveTo(20, -8).lineTo(21, -2);
    g.moveTo(-20, -16).lineTo(-21, -10);
    g.stroke({ width: 0.8, color: 0xf6e6ee, alpha: 0.85 });
    g.poly([ART.x, -4, -26, 4, -18, 18, -10, 30, ART.x, 30]).fill(0x4f2622);
    g.poly([34, 0, 28, 10, 20, 22, 12, 30, 34, 30]).fill(0x45201d);
    for (const [x, h] of [[-11, 3], [-8.5, 4.5], [-6, 2.5], [-3, 5], [0, 3.5], [2, 2], [4.5, 4], [7, 3], [9.5, 5], [12, 2.5]] as const) {
      g.poly([x - 0.8, 30, x, 30 - h, x + 0.8, 30]).fill(0x2a1210);
    }
    band(g, 30, BOTTOM, [[0, 0x5a2c28], [1, 0x2e1614]]);
    g.ellipse(0, 32.5, 14, 1.3).fill({ color: 0xd98a80, alpha: 0.35 });
  },
  forest(g) {
    // Tall straight trunks fading into green light, golden grass below.
    band(g, ART.y, BOTTOM, [[0, 0x5f8f3a], [0.5, 0xb7d77a], [0.78, 0xd9e79a], [1, 0x6f8a2c]]);
    for (const [x, w] of [[-26, 3], [-13, 2.5], [3, 2], [19, 3]] as const) g.rect(x, ART.y, w, 78).fill({ color: 0x6f9a4f, alpha: 0.7 });
    glow(g, 0, 24, 34, 10, 0xf6f8c8, 0.7);
    for (const [x, w] of [[-20, 4], [9, 4.5]] as const) g.rect(x, ART.y, w, 80).fill(0x3d5e2a);
    band(g, 28, BOTTOM, [[0, 0xc9c45a], [1, 0x6a6a20]]);
    for (let x = ART.x + 1; x < 34; x += 2.2) {
      const h = 3 + ((x * 7) % 4);
      g.moveTo(x, 30 + ((x * 3) % 5)).lineTo(x + 0.8, 26 + ((x * 3) % 5) - h);
    }
    g.stroke({ width: 0.7, color: 0xe4dc7a, alpha: 0.8 });
    for (const [x, w] of [[-34, 6], [25, 6], [-5, 5]] as const) g.rect(x, ART.y, w, ART.h).fill(0x1f3318);
    g.moveTo(-28, -4).quadraticCurveTo(-22, -10, -14, -12).moveTo(25, -14).quadraticCurveTo(18, -18, 12, -26);
    g.moveTo(0, 6).quadraticCurveTo(6, 2, 10, -4).moveTo(-5, -20).lineTo(-12, -28).moveTo(31, 10).lineTo(34, 6);
    g.moveTo(-26, 36).quadraticCurveTo(-16, 30, -8, 38).moveTo(4, 40).quadraticCurveTo(14, 32, 22, 40);
    g.stroke({ width: 0.9, color: 0x1f3318, cap: 'round' });
    for (const [x, y] of [[4, 8], [6, 12], [8, 9], [5, 15], [9, 14], [7, 18], [3, 12], [10, 17]] as const) g.circle(x, y, 0.6).fill(0xf2e05a);
  },
};

/** The mana symbol: a disc with a small glyph. */
function symbol(g: Graphics, land: Land, x: number, y: number, r: number): void {
  const p = PALETTES[land];
  g.circle(x, y, r + 1).fill(0x1c1c1c);
  g.circle(x, y, r).fill(p.symbol);
  const s = r / 10;
  switch (land) {
    case 'plains':
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        g.moveTo(x + Math.cos(a) * 3.5 * s, y + Math.sin(a) * 3.5 * s).lineTo(x + Math.cos(a) * 7 * s, y + Math.sin(a) * 7 * s);
      }
      g.stroke({ width: 1.4 * s, color: p.glyph, cap: 'round' });
      g.circle(x, y, 3 * s).fill(p.glyph);
      break;
    case 'island':
      g.moveTo(x, y - 7 * s)
        .bezierCurveTo(x + 6 * s, y, x + 5 * s, y + 6 * s, x, y + 6 * s)
        .bezierCurveTo(x - 5 * s, y + 6 * s, x - 6 * s, y, x, y - 7 * s)
        .fill(p.glyph);
      break;
    case 'swamp':
      g.circle(x, y - 1.5 * s, 5 * s).fill(p.glyph);
      g.rect(x - 3 * s, y + 2 * s, 6 * s, 4 * s).fill(p.glyph);
      g.circle(x - 2 * s, y - 1.5 * s, 1.4 * s).fill(p.symbol);
      g.circle(x + 2 * s, y - 1.5 * s, 1.4 * s).fill(p.symbol);
      break;
    case 'mountain':
      g.moveTo(x, y - 7 * s)
        .bezierCurveTo(x + 7 * s, y - 1 * s, x + 6 * s, y + 6 * s, x, y + 6 * s)
        .bezierCurveTo(x - 6 * s, y + 6 * s, x - 6 * s, y, x - 2 * s, y - 3 * s)
        .bezierCurveTo(x - 1 * s, y, x, y - 2 * s, x, y - 7 * s)
        .fill(p.glyph);
      break;
    case 'forest':
      g.poly([x, y - 7 * s, x - 6 * s, y + 3 * s, x + 6 * s, y + 3 * s]).fill(p.glyph);
      g.rect(x - 1.2 * s, y + 3 * s, 2.4 * s, 4 * s).fill(p.glyph);
      break;
  }
}

/** A basic land face: full art, the name bar over its top edge, a small symbol below. */
export function drawFace(land: Land): Container {
  const p = PALETTES[land];
  const card = new Container();
  const g = new Graphics();
  const x = -CARD_W / 2;
  const y = -CARD_H / 2;
  g.roundRect(x, y, CARD_W, CARD_H, 6).fill(0x161616);
  // A brown stone frame, flecked.
  g.roundRect(x + 3, y + 3, CARD_W - 6, CARD_H - 6, 3).fill(0x5b4734);
  for (let i = 0; i < 60; i++) {
    const fx = x + 3 + ((i * 37.3) % (CARD_W - 7));
    const fy = y + 3 + ((i * 53.7) % (CARD_H - 7));
    g.rect(fx, fy, 1.4, 0.8).fill({ color: i % 2 ? 0x8a7358 : 0x3a2c20, alpha: 0.7 });
  }
  g.rect(ART.x - 1, ART.y - 1, ART.w + 2, ART.h + 2).fill(p.rule);
  symbol(g, land, 31, (BOTTOM + 1 + CARD_H / 2 - 3) / 2, 3.2);
  const scene = new Graphics();
  SCENES[land](scene);
  const clip = new Graphics().rect(ART.x, ART.y, ART.w, ART.h).fill(0xffffff);
  scene.mask = clip;
  const bar = new Graphics().roundRect(-22, y + 3.5, 44, 11, 3).fill(p.bar).stroke({ width: 1, color: 0x1c1c1c, alpha: 0.7 });
  card.addChild(g, scene, clip, bar);

  const name = new Text({ text: landName(land), style: { fontFamily: 'Georgia, serif', fontSize: 8.5, fontWeight: 'bold', fill: p.ink } });
  name.anchor.set(0.5);
  name.position.set(0, y + 9);
  card.addChild(name);
  return card;
}

/** The card back: dark leather, an oval, and the five land colours. */
export function drawBack(): Container {
  const g = new Graphics();
  const x = -CARD_W / 2;
  const y = -CARD_H / 2;
  g.roundRect(x, y, CARD_W, CARD_H, 6).fill(0x161616);
  g.roundRect(x + 3, y + 3, CARD_W - 6, CARD_H - 6, 4).fill(0x4a2d18);
  g.roundRect(x + 6, y + 6, CARD_W - 12, CARD_H - 12, 3).fill(0x36200f);
  for (const [rx, ry, colour] of [
    [30, 42, 0x8a6d3b],
    [27, 39, 0x5c3a1c],
    [24, 35, 0x7a5230],
    [19, 28, 0x9c6b3c],
    [8, 11, 0x7a5230],
  ] as const) {
    g.ellipse(0, 0, rx, ry).fill(colour);
  }
  // Five land colours in a ring, like the mana pentagon.
  const lands: Land[] = ['plains', 'island', 'swamp', 'mountain', 'forest'];
  lands.forEach((land, i) => {
    const a = -Math.PI / 2 + (i / 5) * Math.PI * 2;
    const px = Math.cos(a) * 12;
    const py = Math.sin(a) * 16 + 1;
    g.circle(px, py, 4.6).fill(0x1c1c1c);
    g.circle(px, py, 4).fill(PALETTES[land].symbol);
  });
  const back = new Container();
  back.addChild(g);
  return back;
}
