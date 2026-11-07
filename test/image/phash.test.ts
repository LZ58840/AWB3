import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeGray } from '../../src/core/image/decode';
import { hashHex, phash, phash32, signature, transform, type Variant } from '../../src/core/image/features';

const fixtures = join(import.meta.dirname, '../fixtures');
// Every expected value in this file comes from Python imagehash (tools/gen_phash_vectors.py).
const reference: {
  vectors: { name: string; matrix: number[]; hash: string; variants: Record<string, string> }[];
  images: { file: string; hash: string }[];
  windows: { file: string; hashes: string[] }[];
} = JSON.parse(readFileSync(join(fixtures, 'phash-vectors.json'), 'utf8'));

const bitsApart = (a: string, b: string) => (BigInt(`0x${a}`) ^ BigInt(`0x${b}`)).toString(2).replaceAll('0', '').length;

describe('phash32: DCT + median on a 32x32 gray matrix', () => {
  it.each(reference.vectors.map((v) => [v.name, v] as const))('equals imagehash exactly: %s', (_name, v) => {
    expect(hashHex(phash32(v.matrix))).toBe(v.hash);
  });
});

describe('transform + phash32: the hash of a mirrored or rotated matrix', () => {
  const names: Variant[] = ['mirror', 'rot90', 'rot90-mirror', 'rot270', 'rot270-mirror'];
  it.each(reference.vectors.map((v) => [v.name, v] as const))('equals imagehash of the transformed matrix: %s', (_name, v) => {
    const g = { width: 32, height: 32, data: Float32Array.from(v.matrix) };
    for (const name of names) expect(hashHex(phash32(transform(g, name).data))).toBe(v.variants[name]);
  });
});

describe('phash: decode + resize + pHash of a fixture image', () => {
  // A box filter cannot equal Pillow's Lanczos filter bit for bit; the plan allows 2 bits.
  it.each(reference.images.map((i) => [i.file, i] as const))('is within 2 bits of imagehash: %s', (_file, i) => {
    const g = decodeGray(new Uint8Array(readFileSync(join(fixtures, 'images', i.file))));
    expect(bitsApart(hashHex(phash(g)), i.hash)).toBeLessThanOrEqual(2);
  });
});

describe('signature: the 18 window hashes of a landscape image', () => {
  it.each(reference.windows.map((w) => [w.file, w] as const))('are within 2 bits of imagehash on the same crops: %s', (_file, w) => {
    const g = decodeGray(new Uint8Array(readFileSync(join(fixtures, 'images', w.file))));
    const windows = signature(g).windows;
    expect(windows).toHaveLength(18);
    windows.forEach((h, i) => expect(bitsApart(hashHex(h), w.hashes[i]!)).toBeLessThanOrEqual(2));
  });
});
