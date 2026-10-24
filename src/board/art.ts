// Card art, drawn in code: simplified MTG-style basic lands and an abstract
// card back. Each design is drawn once into a Container centred on (0, 0) at
// the base card size; the table bakes them into textures, so a full table of
// cards costs no more to draw than coloured rectangles did.

import { Container, Graphics, Text } from 'pixi.js';
import type { Land } from '../engine/types.ts';
import { landName } from './controls.ts';

export const CARD_W = 80;
export const CARD_H = 112;

interface Palette {
  readonly frame: number; // the coloured frame around everything
  readonly bar: number; // name bar and text box
  readonly ink: number; // name text
  readonly sky: readonly [number, number]; // top and bottom of the art's sky
  readonly symbol: number; // mana symbol disc
  readonly glyph: number; // the drawing on the disc
}

export const PALETTES: Record<Land, Palette> = {
  plains: { frame: 0xe9dfb8, bar: 0xf6f0d8, ink: 0x3d331c, sky: [0xfff3c4, 0xf2d58a], symbol: 0xf8f1c8, glyph: 0x6b5a2e },
  island: { frame: 0x3c78b8, bar: 0xd7e6f5, ink: 0x14304f, sky: [0xbfe0ff, 0x7fb6e8], symbol: 0xaad4f5, glyph: 0x163d66 },
  swamp: { frame: 0x4a3d55, bar: 0xd6cfdb, ink: 0x2a2030, sky: [0x5b4a6b, 0x9a7f8f], symbol: 0xc9bfcf, glyph: 0x231b28 },
  mountain: { frame: 0xb9543a, bar: 0xf3d9cf, ink: 0x4a1a0e, sky: [0xffb37a, 0xf47b4f], symbol: 0xf3a58c, glyph: 0x4a1a0e },
  forest: { frame: 0x3f7d4e, bar: 0xd4e8cf, ink: 0x183a20, sky: [0xcfe8b0, 0x8cc78a], symbol: 0x9fd39a, glyph: 0x183a20 },
};

// Art window, in card coordinates.
const ART = { x: -33, y: -34, w: 66, h: 50 };

/** A vertical two-colour sky as horizontal bands (cheap gradient). */
function sky(g: Graphics, [top, bottom]: readonly [number, number]): void {
  const bands = 8;
  for (let i = 0; i < bands; i++) {
    g.rect(ART.x, ART.y + (ART.h * i) / bands, ART.w, ART.h / bands + 0.5).fill(mix(top, bottom, i / (bands - 1)));
  }
}

function mix(a: number, b: number, t: number): number {
  const channel = (shift: number): number => Math.round(((a >> shift) & 0xff) * (1 - t) + ((b >> shift) & 0xff) * t) << shift;
  return channel(16) | channel(8) | channel(0);
}

const SCENES: Record<Land, (g: Graphics) => void> = {
  plains(g) {
    // Sun over rolling fields.
    const sun = { x: 10, y: ART.y + 16 };
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      g.moveTo(sun.x + Math.cos(a) * 9, sun.y + Math.sin(a) * 9).lineTo(sun.x + Math.cos(a) * 14, sun.y + Math.sin(a) * 14);
    }
    g.stroke({ width: 1.5, color: 0xf7c948, alpha: 0.8 });
    g.circle(sun.x, sun.y, 7).fill(0xfff6d5);
    g.ellipse(-14, ART.y + ART.h + 2, 34, 14).fill(0xc9b458);
    g.ellipse(18, ART.y + ART.h + 4, 30, 12).fill(0xb39b3e);
    g.ellipse(0, ART.y + ART.h + 10, 40, 10).fill(0xa38a33);
  },
  island(g) {
    // An islet with a palm-less hump, sea with waves.
    const sea = ART.y + 30;
    g.ellipse(-8, sea, 16, 7).fill(0x4f7a5c);
    g.rect(ART.x, sea, ART.w, ART.y + ART.h - sea).fill(0x2f6fae);
    for (let row = 0; row < 3; row++) {
      const y = sea + 5 + row * 6;
      for (let x = ART.x + 4 + (row % 2) * 6; x < ART.x + ART.w - 4; x += 12) {
        g.moveTo(x, y).quadraticCurveTo(x + 3, y - 3, x + 6, y);
      }
    }
    g.stroke({ width: 1.2, color: 0xd7ecff, alpha: 0.85 });
    g.circle(18, ART.y + 10, 3).fill({ color: 0xffffff, alpha: 0.7 });
  },
  swamp(g) {
    // Moon, bog, and a dead tree.
    g.circle(16, ART.y + 11, 6).fill(0xe8e0c8);
    const [top, bottom] = PALETTES.swamp.sky;
    g.circle(19, ART.y + 9, 5).fill(mix(top, bottom, 1 / 7)); // the crescent's bite, in the sky band behind it
    const bog = ART.y + 34;
    g.rect(ART.x, bog, ART.w, ART.y + ART.h - bog).fill(0x2f2a2a);
    g.ellipse(6, bog + 8, 18, 3).fill({ color: 0x6b8a5a, alpha: 0.5 });
    const trunk = { x: -14, y: bog + 2 };
    g.moveTo(trunk.x, trunk.y)
      .lineTo(trunk.x + 1, trunk.y - 18)
      .lineTo(trunk.x - 7, trunk.y - 26)
      .moveTo(trunk.x + 1, trunk.y - 14)
      .lineTo(trunk.x + 9, trunk.y - 22)
      .moveTo(trunk.x + 1, trunk.y - 20)
      .lineTo(trunk.x + 4, trunk.y - 28);
    g.stroke({ width: 2, color: 0x1c1720, cap: 'round' });
  },
  mountain(g) {
    // Two ranges of peaks with snow caps.
    const base = ART.y + ART.h;
    g.poly([ART.x, base, ART.x + 14, ART.y + 18, ART.x + 30, base]).fill(0x8a4a3a);
    g.poly([ART.x + 18, base, ART.x + 40, ART.y + 8, ART.x + 62, base]).fill(0x5e2f26);
    g.poly([ART.x + 40, base, ART.x + 56, ART.y + 22, ART.x + ART.w, base - 10, ART.x + ART.w, base]).fill(0x733a2e);
    g.poly([ART.x + 40, ART.y + 8, ART.x + 35, ART.y + 16, ART.x + 39, ART.y + 14, ART.x + 42, ART.y + 17, ART.x + 45, ART.y + 15]).fill(0xfbe9e0);
    g.poly([ART.x + 14, ART.y + 18, ART.x + 10, ART.y + 24, ART.x + 15, ART.y + 23, ART.x + 18, ART.y + 24]).fill(0xfbe9e0);
  },
  forest(g) {
    // Layered pines.
    const base = ART.y + ART.h;
    const pine = (x: number, height: number, colour: number): void => {
      for (let tier = 0; tier < 3; tier++) {
        const top = base - height + tier * (height / 4);
        const half = 5 + tier * 2.5 * (height / 30);
        g.poly([x, top, x - half, top + height / 3, x + half, top + height / 3]).fill(colour);
      }
      g.rect(x - 1, base - height / 4, 2, height / 4).fill(0x3a2a1a);
    };
    pine(-20, 30, 0x2f6b3a);
    pine(16, 34, 0x2f6b3a);
    pine(-4, 40, 0x1f4f2a);
    pine(28, 24, 0x24592f);
    pine(-30, 22, 0x24592f);
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

/** A basic land face. */
export function drawFace(land: Land): Container {
  const p = PALETTES[land];
  const card = new Container();
  const g = new Graphics();
  const x = -CARD_W / 2;
  const y = -CARD_H / 2;
  g.roundRect(x, y, CARD_W, CARD_H, 6).fill(0x161616);
  g.roundRect(x + 3, y + 3, CARD_W - 6, CARD_H - 6, 4).fill(p.frame);
  // Name bar.
  g.roundRect(-35, y + 6, 70, 13, 3).fill(p.bar).stroke({ width: 1, color: 0x1c1c1c, alpha: 0.6 });
  // Art window: the scene is clipped to it.
  g.rect(ART.x - 1, ART.y - 1, ART.w + 2, ART.h + 2).fill(0x1c1c1c);
  // Type line and text box with the big mana symbol, as on a basic land.
  g.roundRect(-35, ART.y + ART.h + 3, 70, 9, 2).fill(p.bar).stroke({ width: 1, color: 0x1c1c1c, alpha: 0.6 });
  g.roundRect(-33, ART.y + ART.h + 14, 66, CARD_H / 2 - (ART.y + ART.h + 14) - 6, 3).fill({ color: p.bar, alpha: 0.9 });
  symbol(g, land, 0, (ART.y + ART.h + 14 + CARD_H / 2 - 6) / 2, 9);
  const scene = new Graphics();
  sky(scene, p.sky);
  SCENES[land](scene);
  const clip = new Graphics().rect(ART.x, ART.y, ART.w, ART.h).fill(0xffffff);
  scene.mask = clip;
  card.addChild(g, scene, clip);

  const name = new Text({ text: landName(land), style: { fontFamily: 'Georgia, serif', fontSize: 9, fontWeight: 'bold', fill: p.ink } });
  name.position.set(-31, y + 7.5);
  const type = new Text({ text: 'Basic Land', style: { fontFamily: 'Georgia, serif', fontSize: 6, fill: p.ink } });
  type.position.set(-31, ART.y + ART.h + 4);
  card.addChild(name, type);
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
