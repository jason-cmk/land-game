// Plays the computer's levels against each other and prints win rates, to
// check each level is clearly stronger than the one below.
//
// Usage: npm run bench -- [games per pairing, default 200] [hard rounds, default 100] [only: hard vs normal]

import { chooseAction } from '../src/bot/policy.ts';
import { searchAction } from '../src/bot/search.ts';
import { deal, playOut } from '../src/bot/sim.ts';
import type { Chooser } from '../src/bot/sim.ts';
import type { Seat } from '../src/engine/types.ts';

const games = Number(process.argv[2] ?? 200);
const rounds = Number(process.argv[3] ?? 100);

let hardMoves = 0;
let hardMs = 0;
let hardSlowest = 0;
const levels: Record<string, Chooser> = {
  easy: (s, seat, priv, actions) => chooseAction(s, seat, priv, actions, Math.random, 'easy'),
  normal: (s, seat, priv, actions) => chooseAction(s, seat, priv, actions),
  hard: (s, seat, priv, actions) => {
    const start = performance.now();
    const action = searchAction(s, seat, priv, actions, { rounds });
    const ms = performance.now() - start;
    if (actions.length > 1) {
      hardMoves++;
      hardMs += ms;
      hardSlowest = Math.max(hardSlowest, ms);
    }
    return action;
  },
};

/** Win rate of `a` against `b`, each going first in half the games. */
function pairing(a: string, b: string): void {
  let aWins = 0;
  let unfinished = 0;
  const start = performance.now();
  for (let g = 0; g < games; g++) {
    const aSeat = (g % 2) as Seat;
    const world = deal((Math.floor(g / 2) % 2) as Seat, Math.random);
    const winner = playOut(world, (s, seat, priv, actions) => (seat === aSeat ? levels[a]! : levels[b]!)(s, seat, priv, actions));
    if (winner === null) unfinished++;
    else if (winner === aSeat) aWins++;
  }
  const rate = (100 * aWins) / (games - unfinished);
  const z = (aWins - (games - unfinished) / 2) / Math.sqrt((games - unfinished) / 4);
  console.log(`${a} vs ${b}: ${a} wins ${rate.toFixed(1)}% of ${games - unfinished} (z ${z.toFixed(1)})${unfinished ? `, ${unfinished} unfinished` : ''}, ${((performance.now() - start) / 1000).toFixed(1)}s`);
}

if (!process.argv[4]) pairing('normal', 'easy');
pairing('hard', 'normal');
if (!process.argv[4]) pairing('hard', 'easy');
if (hardMoves > 0) console.log(`hard: ${(hardMs / hardMoves).toFixed(0)} ms per choice on average, slowest ${hardSlowest.toFixed(0)} ms (${rounds} rounds)`);
