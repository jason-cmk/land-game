// Layer enforcement (tech.md § Layering): which layers may import which, which
// may use npm packages, and what the engine must never touch. A dependency-free
// stand-in for dependency-cruiser, run with the rest of `npm test`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

type Layer = 'engine' | 'match' | 'transport' | 'bot' | 'board';

/** The other layers each layer may import. */
const MAY_IMPORT: Record<Layer, readonly Layer[]> = {
  engine: [],
  transport: [],
  match: ['engine', 'transport'],
  bot: ['engine', 'match'],
  board: ['engine', 'match', 'transport', 'bot'],
};

/** Only the board may use npm packages (PixiJS) and non-code imports (its stylesheet). */
const MAY_USE_PACKAGES: readonly Layer[] = ['board'];

/** What the engine must never reach for: it stays pure and deterministic, so both peers compute the same states. */
const ENGINE_FORBIDDEN: readonly [RegExp, string][] = [
  [/\b(setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame)\b/, 'timers'],
  [/\b(document|window|globalThis|navigator)\b/, 'the DOM or globals'],
  [/\bMath\.random\b|\bcrypto\b/, 'randomness'],
  [/\bDate\b|\bperformance\b/, 'the clock'],
  [/\bBigInt\b|\b\d+n\b/, 'BigInt crypto math'],
];

/** Every module specifier in a source file: import/export ... from, side-effect imports, dynamic import(). */
function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) found.push(m[1]!);
  return found;
}

/** Source with comments and string contents removed, so prose never trips the checks. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, "''");
}

/** Layer violations in `files` (path relative to src/ → source). */
function layerViolations(files: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const [path, source] of files) {
    const layer = path.split('/')[0] as Layer;
    if (!(layer in MAY_IMPORT)) continue;
    for (const spec of specifiers(source)) {
      if (!spec.startsWith('.')) {
        if (!MAY_USE_PACKAGES.includes(layer)) problems.push(`${path}: ${layer}/ may not use the package '${spec}'`);
        continue;
      }
      const target = join(path, '..', spec).split('/')[0] as Layer;
      if (!(target in MAY_IMPORT)) problems.push(`${path}: '${spec}' leaves src/`);
      else if (target !== layer && !MAY_IMPORT[layer].includes(target)) problems.push(`${path}: ${layer}/ may not import ${target}/ ('${spec}')`);
      else if (!/\.ts$/.test(spec) && !MAY_USE_PACKAGES.includes(layer)) problems.push(`${path}: ${layer}/ may only import .ts modules ('${spec}')`);
    }
    if (layer === 'engine') {
      const body = code(source);
      for (const [pattern, what] of ENGINE_FORBIDDEN) if (pattern.test(body)) problems.push(`${path}: engine/ may not use ${what} (${body.match(pattern)![0]})`);
    }
  }
  return problems;
}

function sourceTree(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.set(relative(root, full), readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return files;
}

test('src/ follows the layer rules', () => {
  const files = sourceTree(new URL('../src', import.meta.url).pathname);
  assert.ok(files.size > 10, 'found the source tree');
  assert.deepEqual(layerViolations(files), []);
});

test('the check catches each kind of violation', () => {
  const cases: [string, string, RegExp][] = [
    ['engine/game.ts', "import { MatchCoordinator } from '../match/coordinator.ts';", /engine\/ may not import match\//],
    ['transport/webrtc.ts', "import type { GameState } from '../engine/types.ts';", /transport\/ may not import engine\//],
    ['match/log.ts', "export { Table } from '../board/table.ts';", /match\/ may not import board\//],
    ['bot/policy.ts', "import { Table } from '../board/table.ts';", /bot\/ may not import board\//],
    ['match/coordinator.ts', "import { runBot } from '../bot/bot.ts';", /match\/ may not import bot\//],
    ['match/sra.ts', "import { x } from 'some-package';", /may not use the package/],
    ['engine/game.ts', "const later = () => import('../board/main.ts');", /engine\/ may not import board\//],
    ['engine/game.ts', 'export const roll = () => Math.random();', /randomness/],
    ['engine/game.ts', 'setTimeout(() => {}, 0);', /timers/],
    ['engine/game.ts', 'const big = 2n ** 64n;', /BigInt/],
    ['engine/game.ts', 'const at = Date.now();', /the clock/],
  ];
  for (const [path, source, expected] of cases) {
    const problems = layerViolations(new Map([[path, source]]));
    assert.equal(problems.length, 1, `${path}: ${source} -> ${JSON.stringify(problems)}`);
    assert.match(problems[0]!, expected);
  }
});

test('allowed imports and prose pass', () => {
  const ok = new Map([
    ['match/coordinator.ts', "import { apply } from '../engine/game.ts';\nimport type { Transport } from '../transport/types.ts';"],
    ['board/table.ts', "import { Application } from 'pixi.js';\nimport { other } from '../engine/types.ts';\nimport './style.css';"],
    ['engine/game.ts', "// no timers, no Date, no Math.random here\nimport type { Land } from './types.ts';\nconst msg = 'window';"],
  ]);
  assert.deepEqual(layerViolations(ok), []);
});
