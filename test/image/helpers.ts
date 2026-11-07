import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Gray } from '../../src/core/image/features';
import type { MatchSettings } from '../../src/core/image/match';

// The plan's defaults (section 5.6): gate 22 bits, NCC 0.80, 85% of tiles, report at 94%, remove at 98%.
export const defaults: MatchSettings = { gate: 22, ncc: 0.8, minTiles: 85, reportAt: 94, removeAt: 98 };

/** A deterministic image with a large spread in every row and column. */
export const textured = (width: number, height: number): Gray => ({
  width,
  height,
  data: Uint8Array.from({ length: width * height }, (_, i) => (i * 97 + ((i / width) | 0) * 31) % 251),
});

/** A seeded random generator (mulberry32): numbers in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(import.meta.dirname, '../fixtures/images', name)));
