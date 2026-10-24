// Mana symbols in the chrome's text: a `{forest}` token (controls.ts landIcon)
// becomes a small inline SVG of the land's symbol, drawn like the one on the
// card (art.ts), with the land's name kept as hidden text for screen readers
// and for textContent.

import type { Land } from '../engine/types.ts';
import { LANDS } from '../engine/types.ts';
import { PALETTES } from './art.ts';
import { landName } from './controls.ts';

const hex = (colour: number): string => `#${colour.toString(16).padStart(6, '0')}`;

/** Each glyph in a viewBox of -11..11, as art.ts symbol() draws it at radius 10. */
function glyph(land: Land, ink: string, disc: string): string {
  switch (land) {
    case 'plains': {
      const rays = Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2;
        const [c, s] = [Math.cos(a), Math.sin(a)];
        return `M${(c * 3.5).toFixed(2)} ${(s * 3.5).toFixed(2)}L${(c * 7).toFixed(2)} ${(s * 7).toFixed(2)}`;
      }).join('');
      return `<path d="${rays}" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"/><circle r="3" fill="${ink}"/>`;
    }
    case 'island':
      return `<path d="M0-7C6 0 5 6 0 6C-5 6-6 0 0-7Z" fill="${ink}"/>`;
    case 'swamp':
      return `<circle cy="-1.5" r="5" fill="${ink}"/><rect x="-3" y="2" width="6" height="4" fill="${ink}"/><circle cx="-2" cy="-1.5" r="1.4" fill="${disc}"/><circle cx="2" cy="-1.5" r="1.4" fill="${disc}"/>`;
    case 'mountain':
      return `<path d="M0-7C7-1 6 6 0 6C-6 6-6 0-2-3C-1 0 0-2 0-7Z" fill="${ink}"/>`;
    case 'forest':
      return `<path d="M0-7L-6 3H6Z" fill="${ink}"/><rect x="-1.2" y="3" width="2.4" height="4" fill="${ink}"/>`;
  }
}

const SVGS = Object.fromEntries(
  LANDS.map((land) => {
    const p = PALETTES[land];
    const disc = hex(p.symbol);
    return [land, `<svg viewBox="-11 -11 22 22" aria-hidden="true"><circle r="11" fill="#1c1c1c"/><circle r="10" fill="${disc}"/>${glyph(land, hex(p.glyph), disc)}</svg>`];
  }),
) as Record<Land, string>;

/** One land's symbol, as an inline element. */
export function manaIcon(land: Land): HTMLElement {
  const icon = document.createElement('span');
  icon.className = `mana mana-${land}`;
  icon.innerHTML = SVGS[land]; // built above from constants only
  const name = document.createElement('span');
  name.className = 'sr-only';
  name.textContent = landName(land);
  icon.append(name);
  return icon;
}

/** Text with `{land}` tokens, as nodes: plain text, and a symbol for each token. */
export function richText(text: string): Node[] {
  return text.split(/(\{[a-z]+\})/).flatMap((part): Node[] => {
    const land = /^\{([a-z]+)\}$/.exec(part)?.[1];
    if (land !== undefined && (LANDS as readonly string[]).includes(land)) return [manaIcon(land as Land)];
    return part === '' ? [] : [document.createTextNode(part)];
  });
}

/** Set an element's contents to rich text. */
export function setRichText(element: HTMLElement, text: string): void {
  element.replaceChildren(...richText(text));
}
