// Table overlays drawn every frame or every layout: the glow along the side of
// whoever the game is waiting on, and the targeting arrow. Drawing only; the
// table decides when and where.

import type { Graphics } from 'pixi.js';

/** A soft band of light along the top or bottom edge, fading toward the middle. */
export function drawEdgeGlow(g: Graphics, at: { width: number; height: number; side: 'top' | 'bottom'; depth: number; colour: number }): void {
  const { width, height, side, depth, colour } = at;
  const bands = 12;
  g.clear();
  for (let k = 0; k < bands; k++) {
    const t = k / bands;
    const h = depth / bands;
    const y = side === 'bottom' ? height - (k + 1) * h : k * h;
    g.rect(0, y, width, h + 0.5).fill({ color: colour, alpha: 0.22 * (1 - t) * (1 - t) });
  }
}

/**
 * A curved arrow from `from` to `to`, bowing upward. `locked` (pointing at a
 * valid target) draws it solid red with a ring around the tip; otherwise pale
 * and dashed. `ring` is the target ring's radius.
 */
export function drawAim(g: Graphics, from: { x: number; y: number }, to: { x: number; y: number }, at: { locked: boolean; scale: number; ring: number; dash: number }): void {
  const { locked, scale, ring, dash } = at;
  g.clear();
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 24 * scale) return;
  // Bow perpendicular to the line, toward the top of the screen.
  const nx = -dy / length;
  const ny = dx / length;
  const bow = Math.min(length * 0.25, 90 * scale) * (ny < 0 ? 1 : -1);
  const c = { x: (from.x + to.x) / 2 + nx * bow, y: (from.y + to.y) / 2 + ny * bow };
  const point = (t: number): { x: number; y: number } => {
    const u = 1 - t;
    return { x: u * u * from.x + 2 * u * t * c.x + t * t * to.x, y: u * u * from.y + 2 * u * t * c.y + t * t * to.y };
  };
  const colour = locked ? 0xff5a3c : 0xfff1c9;
  const width = (locked ? 7 : 5) * scale;
  const headLength = 22 * scale;
  // Stop the shaft where the head starts.
  const end = Math.max(0, 1 - headLength / length);
  const samples = 32;
  // Dashes march along the shaft (`dash` is a phase in px) while not locked.
  const segment = 14 * scale;
  /** Trace the shaft as a path; a stroke uses the path up, so it is traced once per stroke. */
  const shaft = (): void => {
    let travelled = 0;
    let prev = point(0);
    for (let k = 1; k <= samples; k++) {
      const p = point((k / samples) * end);
      const on = locked || Math.floor((travelled + dash) / segment) % 2 === 0;
      if (on) g.moveTo(prev.x, prev.y).lineTo(p.x, p.y);
      travelled += Math.hypot(p.x - prev.x, p.y - prev.y);
      prev = p;
    }
  };
  shaft();
  g.stroke({ width: width + 4 * scale, color: 0x1a1410, alpha: 0.5, cap: 'round' });
  shaft();
  g.stroke({ width, color: colour, alpha: 0.95, cap: 'round' });
  // The head points along the curve's last stretch.
  const tail = point(end);
  const angle = Math.atan2(to.y - tail.y, to.x - tail.x);
  const spread = 0.5;
  g.poly([
    to.x, to.y,
    to.x - Math.cos(angle - spread) * headLength, to.y - Math.sin(angle - spread) * headLength,
    to.x - Math.cos(angle + spread) * headLength, to.y - Math.sin(angle + spread) * headLength,
  ])
    .fill(colour)
    .stroke({ width: 2 * scale, color: 0x1a1410, alpha: 0.5 });
  if (locked) g.circle(to.x, to.y, ring).stroke({ width: 3 * scale, color: colour, alpha: 0.9 });
}
