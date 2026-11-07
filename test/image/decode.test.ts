import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from 'fast-png';
import { describe, expect, it } from 'vitest';
import { decodeGray, ImageRejected, readHeader } from '../../src/core/image/decode';

const dir = join(import.meta.dirname, '../fixtures/images/decoder');
// The expected gray images are what Pillow decodes from each file (tools/gen_phash_vectors.py).
const expected: Record<string, { width: number; height: number; gray: number[] }> = JSON.parse(
  readFileSync(join(dir, 'expected.json'), 'utf8'),
);
const load = (name: string) => new Uint8Array(readFileSync(join(dir, name)));

/** The 33 bytes of a PNG that start a file of the given size: signature and IHDR, no pixel data. */
function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  b.set([8, 2], 24); // 8 bit RGB
  return b;
}

/** A JPEG that stops after its frame header: SOI, the given segments, then SOF with the given marker and size. */
function jpegHeader(width: number, height: number, sof = 0xc0, segments: number[][] = []): Uint8Array {
  const frame = [0xff, sof, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Uint8Array.from([0xff, 0xd8, ...segments.flat(), ...frame]);
}

const reasonOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof ImageRejected ? e.reason : `other: ${(e as Error).message}`;
  }
  return 'no error';
};

describe('decodeGray', () => {
  it.each(['rgb.png', 'rgba.png', 'gray.png', 'palette.png', 'gray16.png', 'gray16-varied.png', 'gray-alpha.png', 'palette-alpha.png'])(
    'decodes %s to exactly the gray image that Pillow decodes (PNG is lossless)',
    (name) => {
      const g = decodeGray(load(name));
      expect([g.width, g.height]).toEqual([expected[name]!.width, expected[name]!.height]);
      expect(Array.from(g.data)).toEqual(expected[name]!.gray);
    },
  );

  it('decodes a 16 bit RGB PNG by the high byte of each sample (every sample has a high byte that differs from its low byte)', () => {
    const samples = [[0x1234, 0xabcd, 0x7f01], [0xff00, 0x00ff, 0x8080], [0x0a0b, 0xf0e1, 0x55aa], [0x0001, 0x0100, 0xfffe]];
    const png = encode({ width: 4, height: 1, data: Uint16Array.from(samples.flat()), depth: 16, channels: 3 });
    // gray = 0.299 R + 0.587 G + 0.114 B of the high bytes (ITU-R 601, rounded)
    const gray = samples.map(([r, g, b]) => Math.round(0.299 * (r! >> 8) + 0.587 * (g! >> 8) + 0.114 * (b! >> 8)));
    expect(Array.from(decodeGray(png).data)).toEqual(gray);
  });

  // Two JPEG decoders round differently, so the match is close, not exact.
  it.each(['baseline.jpg', 'progressive.jpg'])('decodes %s close to the gray image that Pillow decodes', (name) => {
    const g = decodeGray(load(name));
    expect([g.width, g.height]).toEqual([expected[name]!.width, expected[name]!.height]);
    const sum = expected[name]!.gray.reduce((s, v, i) => s + Math.abs(v - g.data[i]!), 0);
    expect(sum / g.data.length).toBeLessThanOrEqual(1);
  });

  it.each(['baseline.jpg', 'progressive.jpg', 'rgb.png'])('throws on a truncated file: %s', (name) => {
    const bytes = load(name);
    expect(() => decodeGray(bytes.subarray(0, Math.floor(bytes.length / 2)))).toThrow();
  });
});

describe('readHeader: the size from the file header, before any decode', () => {
  it.each(['baseline.jpg', 'progressive.jpg'])('reads the SOF of %s (32x24)', (name) => {
    expect(readHeader(load(name))).toEqual({ format: 'jpeg', width: 32, height: 24 });
  });

  it.each(['rgb.png', 'palette.png', 'gray16.png'])('reads the IHDR of %s (32x24)', (name) => {
    expect(readHeader(load(name))).toEqual({ format: 'png', width: 32, height: 24 });
  });

  it('skips other JPEG segments and fill bytes before a progressive frame header', () => {
    const exif = [0xff, 0xe1, 0, 10, 69, 120, 105, 102, 0, 0, 1, 2];
    const comment = [0xff, 0xfe, 0, 6, 1, 2, 3, 4];
    const bytes = jpegHeader(6000, 4000, 0xc2, [exif, [0xff, 0xff], comment]);
    expect(readHeader(bytes)).toEqual({ format: 'jpeg', width: 6000, height: 4000 });
  });

  it('reads a PNG header of any size', () => {
    expect(readHeader(pngHeader(20000, 30000))).toEqual({ format: 'png', width: 20000, height: 30000 });
  });
});

describe('decodeGray: what it rejects', () => {
  it('rejects an image over 16 megapixels from its header alone (a PNG and a JPEG with no pixel data)', () => {
    expect(reasonOf(() => decodeGray(pngHeader(20000, 20000)))).toBe('too-large');
    expect(reasonOf(() => decodeGray(jpegHeader(8000, 6000)))).toBe('too-large');
  });

  it('puts the 16 megapixel limit between 4000x4000 and 4001x4000', () => {
    expect(reasonOf(() => decodeGray(pngHeader(4001, 4000)))).toBe('too-large');
    expect(reasonOf(() => decodeGray(pngHeader(4000, 4000)))).toMatch(/^other:/); // it passes the guard, then fails: no pixels
  });

  it('takes the limit in megapixels as a parameter', () => {
    const bytes = load('baseline.jpg'); // 768 pixels
    expect(reasonOf(() => decodeGray(bytes, 0.0005))).toBe('too-large');
    expect(decodeGray(bytes, 0.001).width).toBe(32);
  });

  it('rejects WebP', () => {
    expect(reasonOf(() => decodeGray(load('image.webp')))).toBe('webp');
  });

  it('rejects other formats, empty input and text as unsupported', () => {
    const gif = Uint8Array.from([...'GIF89a'].map((c) => c.charCodeAt(0)).concat(new Array<number>(30).fill(0)));
    expect(reasonOf(() => decodeGray(gif))).toBe('unsupported');
    expect(reasonOf(() => decodeGray(new Uint8Array(0)))).toBe('unsupported');
    expect(reasonOf(() => decodeGray(new TextEncoder().encode('<html>not an image</html>')))).toBe('unsupported');
  });

  it('rejects an image with no pixels (width or height 0), which would give empty features', () => {
    expect(reasonOf(() => decodeGray(pngHeader(0, 10)))).toBe('unsupported');
    expect(reasonOf(() => decodeGray(pngHeader(10, 0)))).toBe('unsupported');
    expect(reasonOf(() => decodeGray(jpegHeader(0, 100)))).toBe('unsupported');
  });

  it('rejects a JPEG that has no frame header', () => {
    expect(reasonOf(() => decodeGray(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0])))).toBe('unsupported');
  });

  it('rejects a 1 bit gray PNG: its pixels are packed and an image like that is no wallpaper', () => {
    expect(reasonOf(() => decodeGray(load('bilevel.png')))).toBe('unsupported');
  });
});
