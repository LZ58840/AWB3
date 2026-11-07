// `npm run lint` (plan 7.8, AC1): the rule "a request handler keeps no state in a module variable" (plan 5.3). The scan is in noModuleState.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { moduleState } from './noModuleState';

test('the scan finds a top-level let and var, with or without export, and not a variable inside a function', () => {
  const text = ['let cache;', 'export var last = 1;', 'const ok = 1;', '  let inside = 2;', 'function f() {', '  let local = 3;', '}'].join('\n');
  expect(moduleState('a.ts', text)).toEqual(['a.ts:1: top-level let cache', 'a.ts:2: top-level var last']);
});

test('the scan finds a top-level Map, Set, array or object that the file changes, and leaves one that the file only reads', () => {
  const text = [
    'const seen = new Map<string, number>();',
    'export const queue: string[] = [];',
    'const config = {};',
    'const names = new Set();',
    'const EMPTY: string[] = [];',
    'const TABLE = { a: 1 };',
    'const $cache = new WeakMap();',
    'export function f(k: string) {',
    '  seen.set(k, 1); queue.push(k); config.x = 1; $cache.set({}, 1);',
    '  return names.has(k) && EMPTY.length && TABLE.a;',
    '}',
  ].join('\n');
  expect(moduleState('b.ts', text)).toEqual([
    'b.ts:1: top-level container seen that the file changes',
    'b.ts:2: top-level container queue that the file changes',
    'b.ts:3: top-level container config that the file changes',
    'b.ts:7: top-level container $cache that the file changes',
  ]);
});

test('a change by index or by Object.assign counts; a comparison and a longer name do not', () => {
  expect(moduleState('c.ts', 'const a = {};\nconst b = {};\nObject.assign(a, { x: 1 });\nb["k"] = 1;')).toEqual([
    'c.ts:1: top-level container a that the file changes',
    'c.ts:2: top-level container b that the file changes',
  ]);
  expect(moduleState('d.ts', 'const out = [];\nfunction f(x) { return out === x && outer.push(1) && out.length == 0; }')).toEqual([]);
});

test('src/server and src/core hold no module state', () => {
  const root = fileURLToPath(new URL('../../src/', import.meta.url));
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.ts') && /^(?:server|core)\//.test(file));
  expect(files.length).toBeGreaterThan(20); // the scan reads the files that exist
  expect(files.flatMap((file) => moduleState(`src/${file}`, readFileSync(root + file, 'utf8')))).toEqual([]);
});
