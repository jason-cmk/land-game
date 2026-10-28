// What each land does, shown when a face-up card is hovered (mouse) or
// long-pressed (touch). Wording follows spec.md § Land abilities; lands are
// named by their mana symbol ({island}, see controls.ts landIcon), the card's title aside.

import type { Land } from '../engine/types.ts';

export interface CardInfo {
  readonly name: string;
  readonly lines: readonly string[];
}

export const CARD_INFO: Record<Land, CardInfo> = {
  forest: { name: 'Forest', lines: ['When played: choose a land in your graveyard and return it to your hand.'] },
  island: {
    name: 'Island',
    lines: [
      'When played: no effect.',
      "From hand: when your opponent plays a land, discard this {island} and one other land to counter it. The player being countered can counter back the same way.",
    ],
  },
  mountain: { name: 'Mountain', lines: ['When played: choose a land your opponent controls and destroy it.'] },
  plains: { name: 'Plains', lines: ['When played: draw a card.'] },
  swamp: { name: 'Swamp', lines: ["When played: look at your opponent's hand and choose a land for them to discard."] },
};

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where to put the info panel for a card: above it if there is room (a finger
 * or the pointer sits on and below the card), otherwise below, kept inside the table.
 * `card` is the card's bounding box, `panel` only needs width and height.
 */
export function infoPlacement(card: Box, panel: { width: number; height: number }, table: { width: number; height: number }, gap = 8): { x: number; y: number } {
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  const x = clamp(card.x + card.width / 2 - panel.width / 2, gap, Math.max(gap, table.width - panel.width - gap));
  const above = card.y - gap - panel.height;
  const below = card.y + card.height + gap;
  const y = above >= gap ? above : below + panel.height <= table.height - gap ? below : gap;
  return { x, y };
}
