// Card art, drawn in code: simplified full-art MTG basic lands and an abstract
// card back. Each design is drawn once into a Container centred on (0, 0) at
// the base card size; the table bakes them into textures, so a full table of
// cards costs no more to draw than coloured rectangles did.

import { Container, Graphics, Text } from 'pixi.js';
import type { FillInput } from 'pixi.js';
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

type Point = readonly [number, number];

/** Points along a chain of quadratic curves: [x0, y0, then control x, y and end x, y for each curve]. */
function along(path: readonly number[], per = 8): Point[] {
  const points: Point[] = [[path[0]!, path[1]!]];
  for (let i = 2; i + 3 < path.length; i += 4) {
    const [x0, y0] = points[points.length - 1]!;
    const [cx, cy, x1, y1] = path.slice(i, i + 4) as [number, number, number, number];
    for (let k = 1; k <= per; k++) {
      const t = k / per;
      points.push([(1 - t) ** 2 * x0 + 2 * t * (1 - t) * cx + t * t * x1, (1 - t) ** 2 * y0 + 2 * t * (1 - t) * cy + t * t * y1]);
    }
  }
  return points;
}

/**
 * A brush stroke along `path` (see along), filled rather than stroked so its
 * width can change: swelling to `width` in the middle and thin at both ends,
 * or ('tip') full at the start and narrowing to a point, or (a number) narrowing
 * evenly to that fraction of its width.
 */
function brush(g: Graphics, path: readonly number[], width: number, fill: FillInput, shape: 'swell' | 'tip' | number = 'swell'): void {
  const points = along(path);
  const left: number[] = [];
  const right: number[] = [];
  points.forEach(([x, y], i) => {
    const t = i / (points.length - 1);
    const w = (width / 2) * (shape === 'swell' ? Math.sin(Math.PI * t) ** 0.7 : shape === 'tip' ? (1 - t) ** 0.8 : 1 - (1 - shape) * t);
    const [ax, ay] = points[Math.max(0, i - 1)]!;
    const [bx, by] = points[Math.min(points.length - 1, i + 1)]!;
    const d = Math.hypot(bx - ax, by - ay) || 1;
    const nx = (-(by - ay) / d) * w;
    const ny = ((bx - ax) / d) * w;
    left.push(x + nx, y + ny);
    right.unshift(x - nx, y - ny);
  });
  g.poly([...left, ...right]).fill(fill);
}

/** A straight path for brush. */
function line(x0: number, y0: number, x1: number, y1: number): number[] {
  return [x0, y0, (x0 + x1) / 2, (y0 + y1) / 2, x1, y1];
}

/** A deterministic random sequence, so the art comes out the same every time. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A dead branch: it sets off at `angle` and sags under its weight, more the
 * thinner it is. It forks `depth` more times into thinner limbs; the last
 * ones droop into a few hanging twigs.
 */
function limb(g: Graphics, x: number, y: number, angle: number, len: number, width: number, depth: number, colour: number, rand: () => number): void {
  const sag = len * (0.1 + 0.35 / (width + 0.4));
  const cx = x + Math.cos(angle) * len * 0.6;
  const cy = y + Math.sin(angle) * len * 0.6;
  const ex = x + Math.cos(angle) * len;
  const ey = y + Math.sin(angle) * len + sag;
  g.moveTo(x, y).quadraticCurveTo(cx, cy, ex, ey).stroke({ width, color: colour, cap: 'round' });
  const onward = Math.atan2(ey - cy, ex - cx);
  if (depth > 0) {
    // One fork part way along, heading up and out; the limb carries on from its tip.
    const t = 0.45 + rand() * 0.2;
    const fx = (1 - t) ** 2 * x + 2 * t * (1 - t) * cx + t * t * ex;
    const fy = (1 - t) ** 2 * y + 2 * t * (1 - t) * cy + t * t * ey;
    const side = Math.cos(angle) < 0 ? 1 : -1; // towards the sky on this limb's side
    limb(g, fx, fy, angle + side * (0.5 + rand() * 0.4), len * (0.55 + rand() * 0.15), width * 0.62, depth - 1, colour, rand);
    limb(g, ex, ey, onward - side * (0.2 + rand() * 0.3), len * (0.5 + rand() * 0.2), width * 0.65, depth - 1, colour, rand);
    return;
  }
  // Twigs hanging from the tip and the middle of the last limbs.
  for (const [hx, hy] of [[ex, ey], [cx * 0.5 + (x + ex) * 0.25, cy * 0.5 + (y + ey) * 0.25]] as const) {
    for (let i = 0; i < 1 + Math.round(rand()); i++) {
      const drop = 1.5 + rand() * 3.5;
      const drift = (rand() - 0.5) * 3;
      g.moveTo(hx, hy).quadraticCurveTo(hx + drift, hy + drop * 0.4, hx + drift * 0.4, hy + drop);
    }
  }
  g.stroke({ width: Math.max(0.35, width * 0.6), color: colour, cap: 'round', alpha: 0.85 });
}

/**
 * A bare branch in a few straight runs with a kink at each joint. It narrows
 * as it goes, and at each joint may fork `depth` more times into a thinner
 * kinked branch, mostly heading up.
 */
function kinked(g: Graphics, x: number, y: number, angle: number, len: number, width: number, depth: number, colour: number, rand: () => number): void {
  const runs = 3;
  for (let i = 0; i < runs; i++) {
    const last = i === runs - 1;
    const run = (len / runs) * (0.8 + rand() * 0.4);
    if (i > 0) angle += (rand() - 0.5) * 0.8;
    const nx = x + Math.cos(angle) * run;
    const ny = y + Math.sin(angle) * run;
    const next = last ? 0 : width * 0.72;
    brush(g, line(x, y, nx, ny), width, colour, last ? 'tip' : next / width);
    if (!last) g.circle(nx, ny, next / 2).fill(colour); // rounds off the kink
    if (depth > 0 && !last && rand() < 0.8) {
      const up = Math.cos(angle) < 0 ? 1 : -1; // turning this way heads towards the sky
      const side = rand() < 0.75 ? up : -up;
      kinked(g, nx, ny, angle + side * (0.5 + rand() * 0.4), len * (0.4 + rand() * 0.15), next * 0.8, depth - 1, colour, rand);
    }
    x = nx;
    y = ny;
    width = next;
  }
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
    // Wind ripples in the sand: each a shadowed trough under a sunlit crest,
    // smaller and finer towards the horizon. Scattered one by one, skipping
    // any that would crowd one already placed.
    const sand = seeded(11);
    const placed: [number, number, number, number][] = []; // x0, x1, y, room
    for (let tries = 0; tries < 200 && placed.length < 15; tries++) {
      const t = 0.08 + sand() * 0.92;
      const y = 4 + (BOTTOM - 7) * t ** 1.5;
      const len = (12 + sand() * 10) * (0.5 + 0.7 * t);
      const x = ART.x - len / 3 + sand() * (ART.w - len / 3);
      const room = 1.5 + 5 * t;
      if (placed.some(([a, b, py, r]) => x < b + 3 * r && x + len > a - 3 * r && Math.abs(y - py) < Math.max(r, room))) continue;
      placed.push([x, x + len, y, room]);
      const amp = (0.25 + 1.6 * t) * (0.7 + sand() * 0.5);
      const width = 0.2 + 0.8 * t;
      const ripple = [x, y, x + len / 4, y - amp, x + len / 2, y, x + (3 * len) / 4, y + amp, x + len, y];
      brush(g, ripple, width, { color: 0x8a5422, alpha: 0.5 });
      brush(g, ripple.map((v, i) => (i % 2 ? v - width * 0.9 : v + 0.6)), width * 0.6, { color: 0xffe9a8, alpha: 0.45 });
    }
  },
  island(g) {
    // Seen from the air: a green island in a deep blue sea.
    band(g, ART.y, -30, [[0, 0xf4f9fc], [1, 0xb5d6ec]]);
    band(g, -30, BOTTOM, [[0, 0x8cbfe3], [0.35, 0x3f86c8], [1, 0x1d4d9c]]);
    // Turned nearer the horizontal, smaller and a little flattened, so it sits out in the sea under the low horizon.
    g.save().translateTransform(4, -10).rotateTransform(0.4).scaleTransform(0.72, 0.6).translateTransform(-2, 14);
    const island = [-37, 32, -30, 18, -24, 10, -20, 0, -12, -6, -4, -12, 6, -16, 14, -14, 22, -12, 26, -6, 22, 0, 16, 2, 12, 8, 4, 12, -2, 18, -8, 22, -14, 30, -20, 32, -28, 34, -35, 34.5];
    g.poly(island).stroke({ width: 2.5, color: 0x9fd6c8, alpha: 0.55 });
    g.poly(island).fill(0x3f7a3a);
    g.poly([-30, 28, -20, 22, -10, 16, 0, 10, 10, 6, 16, 2, 8, 10, -2, 18, -10, 26, -20, 32, -30, 34]).fill(0x2a5a2c);
    g.poly([-22, 4, -12, -4, -2, -10, 8, -14, 16, -12, 12, -6, 2, -2, -8, 4, -16, 10]).fill(0x6aa14f);
    for (const [x, y] of [[-18, 14], [-10, 8], [-4, 2], [4, -4], [10, -8], [-14, 22], [-24, 20], [2, 6]] as const) g.circle(x, y, 1.1).fill(0x3a7436);
    g.restore();
    // Whitecaps: small curling strokes, smaller towards the horizon.
    for (const [x, y] of [
      [-22, -25], [6, -23], [-8, -17], [18, -14], [-27, -9], [28, 12], [26, -4],
      [-26, 29], [-8, 34], [9, 27], [23, 22], [-26, 41], [18, 39], [1, 42], [-15, 37], [27, 32],
    ] as const) {
      const k = 0.35 + (0.8 * (y + 30)) / 74;
      brush(g, [x, y, x + 2.5 * k, y - 0.7 * k, x + 6 * k, y - 0.1 * k], 0.8 * k, { color: 0xe4f1fb, alpha: 0.55 });
      brush(g, [x + 1.5 * k, y + 1 * k, x + 3.5 * k, y + 0.4 * k, x + 5 * k, y + 1 * k], 0.45 * k, { color: 0xcfe6f7, alpha: 0.4 });
    }
  },
  swamp(g) {
    // Grey mist, a pale sun low between dead trees, still black water.
    band(g, ART.y, 14, [[0, 0x6e6c74], [0.7, 0xb9b7be], [1, 0xd8d6dc]]);
    glow(g, 0, 8, 24, 20, 0xffffff, 0.9);
    band(g, 14, BOTTOM, [[0, 0x77757c], [1, 0x2c2a2f]]);
    // The sun's path on the water: a wedge widening from the horizon, a smooth
    // gradient brightest under the sun. The narrower layers stop shorter, so it
    // fades towards us as well as out to its edges.
    const steps = 16;
    for (let i = 0; i < steps; i++) {
      const k = 1 - i / steps;
      const end = 14 + (BOTTOM - 14) * (1 - 0.45 * (i / steps));
      const spread = (end - 14) / (BOTTOM - 14);
      g.poly([-2.5 * k, 14, 2.5 * k, 14, (2.5 + 18 * spread) * k, end, -(2.5 + 18 * spread) * k, end]).fill({ color: 0xffffff, alpha: 0.045 });
    }
    glow(g, 0, 15, 14, 3, 0xffffff, 0.7);
    // Faint trees in the mist.
    const mist = 0x96939c;
    const far = seeded(3);
    for (const x of [-20, -7, 9, 21]) {
      g.moveTo(x, 15).lineTo(x + 1, -30).stroke({ width: 0.9, color: mist });
      limb(g, x + 0.6, -10, -0.9, 6, 0.6, 1, mist, far);
      limb(g, x + 0.8, -20, -2.3, 6, 0.6, 1, mist, far);
    }
    // Twisted dead trees at both sides.
    const dark = 0x1e1c21;
    g.moveTo(-29, BOTTOM).bezierCurveTo(-27, 20, -31, 0, -25, -18).bezierCurveTo(-22, -26, -28, -32, -24, -40);
    g.moveTo(26, BOTTOM).bezierCurveTo(23, 14, 27, -4, 22, -20);
    g.stroke({ width: 3, color: dark, cap: 'round' });
    // Limbs reach out and sag, split into thinner ones and end in hanging twigs.
    const near = seeded(7);
    for (const [x, y, deg, len, width] of [
      [-26, -10, -40, 13, 1.7],
      [-25, -22, -130, 10, 1.5],
      [-28, 6, -25, 10, 1.3],
      [-24.5, -37, -80, 8, 1.3],
      [-25.5, -29, -20, 9, 1.2],
      [23, -6, -145, 12, 1.6],
      [23, -14, -50, 10, 1.4],
      [22, -19, -105, 8, 1.2],
      [24.5, 4, -160, 8, 1.1],
    ] as const) {
      limb(g, x, y, (deg * Math.PI) / 180, len, width, 3, dark, near);
    }
    // Ripples and reflections.
    for (const [x, y, len] of [[-15, 30, 9], [6, 36, 9], [-21, 39, 9], [-10, 22, 5], [9, 25, 6], [-4, 18, 3.5], [14, 42, 7]] as const) {
      brush(g, line(x, y, x + len, y), 0.3 + (y - 14) / 30, { color: 0x1a181c, alpha: 0.55 });
    }
  },
  mountain(g) {
    // Jagged red peaks under a red sky, dark cliffs framing a valley lake.
    band(g, ART.y, 30, [[0, 0xe8553f], [0.6, 0xf08a72], [1, 0xf6b8a6]]);
    g.poly([ART.x, 10, -10, -6, 4, -2, 14, -24, 20, -16, 26, -30, 34, -14, 34, 10]).fill(0xd98a80);
    g.poly([ART.x, 30, -26, -6, -20, -16, -14, -34, -8, -20, -2, -28, 6, -6, 12, 4, 20, -8, 28, 6, 34, 20, 34, 30]).fill(0xa9524b);
    g.poly([-14, -34, -11, -16, -6, -6, -2, -28, -8, -20]).fill(0xc0675e);
    g.poly([20, -8, 22, 4, 28, 6]).fill(0xc0675e);
    // Snow: a ragged cap on each peak, streaks running down the gullies below.
    const snow = { color: 0xf6e6ee, alpha: 0.9 };
    g.poly([-14, -34, -16, -27.5, -14.8, -28.6, -14, -25.5, -12.8, -28, -11, -26.8]).fill(snow);
    g.poly([-2, -28, -4.2, -23.5, -2.9, -24.3, -1.6, -21.5, -0.6, -24, 0, -22.4]).fill(snow);
    g.poly([20, -8, 18, -4.6, 19.2, -5.2, 20.4, -3, 21.3, -5, 22, -4.2]).fill(snow);
    g.poly([26, -30, 24.5, -26, 25.6, -26.9, 26.7, -25, 27.5, -27]).fill({ color: 0xf6e6ee, alpha: 0.6 });
    g.poly([14, -24, 12.5, -20.6, 13.6, -21.3, 14.8, -19.8, 15.9, -21.5]).fill({ color: 0xf6e6ee, alpha: 0.6 });
    for (const [x, y, dx, len, w] of [
      [-14, -27, 0.6, 7, 1.1], [-12.4, -27.5, 1.4, 5, 0.8], [-15.2, -28, -1.2, 5, 0.7],
      [-1.6, -22.5, 0.3, 5, 0.9], [-3.4, -23.6, -0.8, 3.5, 0.6], [20.4, -4, 0.4, 4, 0.8], [-20, -16, -0.6, 5, 0.7],
    ] as const) {
      brush(g, line(x, y, x + dx, y + len), w, snow, 'tip');
    }
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
    for (let x = ART.x + 1; x < 34; x += 1.6) {
      const h = 3 + ((x * 7) % 4);
      const base = 30 + ((x * 3) % 5);
      const lean = ((x * 5) % 3) - 1;
      brush(g, [x, base, x + lean * 0.3, base - h * 0.6, x + lean, base - h - 4], 0.8, { color: 0xe4dc7a, alpha: 0.8 }, 'tip');
    }
    for (const [x, w] of [[-34, 6], [25, 6], [-5, 5]] as const) g.rect(x, ART.y, w, ART.h).fill(0x1f3318);
    // Bare side branches, thick where they leave the trunk, and roots spreading from its foot.
    const bark = 0x1f3318;
    // Each starts inside its trunk, so the join has no gap.
    const twigs = seeded(5);
    for (const [x0, y0, x1, y1] of [
      [-29.5, -4, -10, -16], [-29.5, -22, -18, -30], [-3.5, -20, -15, -32],
      [-1.5, 6, 14, -7], [26.5, -14, 8, -28], [29.5, 10, 37, 4],
    ] as const) {
      kinked(g, x0, y0, Math.atan2(y1 - y0, x1 - x0), Math.hypot(x1 - x0, y1 - y0), 0.95, 2, bark, twigs);
    }
    // Roots flare out of the foot of each trunk.
    for (const root of [[-29.5, 33, -26, 39, -20, 44], [26.5, 34, 22, 40, 16, 44], [-1.5, 34, 3, 40, 8, 44], [-3.5, 35, -8, 40, -12, 44], [29.5, 35, 33, 40, 35, 43]]) {
      brush(g, root, 2.6, bark, 'tip');
    }
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
