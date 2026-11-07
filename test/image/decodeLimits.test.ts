import { constants, crc32, deflateRawSync, deflateSync, inflateSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeGray, ImageRejected, readHeader } from '../../src/core/image/decode';
import { fixture } from './helpers';

// Crafted inputs for the decoder limits. Everything is built here, from the PNG and JPEG formats.
//
// The tests count what the decoder does and never time it: a clock gives other numbers on a slow or busy machine, and under
// coverage. `inflated` is what the PNG check of decode.ts inflates (its own fflate stream; fast-png has its own copy of
// fflate and is not counted). `decodes` and `jpegDecodes` are the numbers of calls to fast-png and to jpeg-js: a rejected
// file must not reach them.
const work = vi.hoisted(() => ({ inflated: 0, decodes: 0, jpegDecodes: 0 }));
vi.mock('fflate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fflate')>();
  return {
    ...actual,
    Unzlib: class extends actual.Unzlib {
      constructor(callback: (chunk: Uint8Array, final: boolean) => void) {
        super((chunk, final) => {
          work.inflated += chunk.length;
          callback(chunk, final);
        });
      }
    },
  };
});
vi.mock('fast-png', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fast-png')>();
  return {
    ...actual,
    decode: (...args: Parameters<typeof actual.decode>) => {
      work.decodes++;
      return actual.decode(...args);
    },
  };
});
vi.mock('jpeg-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jpeg-js')>();
  return {
    ...actual,
    decode: (...args: Parameters<typeof actual.decode>) => {
      work.jpegDecodes++;
      return actual.decode(...args);
    },
  };
});
beforeEach(() => {
  work.inflated = work.decodes = work.jpegDecodes = 0;
});

const MIB = 2 ** 20;
// The check gives the inflater 16 KiB at a time and deflate expands at most 1032 times, so it stops at most this far past a limit.
const MOST_PAST_LIMIT = 16 * 1024 * 1032;

/** A PNG chunk: length, type, data and CRC. */
function chunk(type: string, data: Uint8Array = new Uint8Array(0)): Buffer {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, 'latin1');
  b.set(data, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}

function ihdr(width: number, height: number, { depth = 8, colorType = 0, interlace = 0 } = {}): Buffer {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0);
  b.writeUInt32BE(height, 4);
  b.set([depth, colorType, 0, 0, interlace], 8);
  return chunk('IHDR', b);
}

/** A PNG file from chunks. The signature and IEND are added. */
const png = (...chunks: Buffer[]): Uint8Array =>
  new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks, chunk('IEND')]));

/**
 * A valid zlib stream that inflates to `mebibytes` MiB of zeros, made from 1 MiB blocks that end with a sync flush.
 * It takes about 1 KiB of file for each MiB of output.
 */
function zeros(mebibytes: number): Buffer {
  const block = deflateRawSync(Buffer.alloc(MIB), { level: 9, finishFlush: constants.Z_SYNC_FLUSH });
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE((((((mebibytes * MIB) % 65521) << 16) | 1) >>> 0)); // Adler-32 of zeros: a = 1, b = length
  return Buffer.concat([Buffer.from([0x78, 0x9c]), ...Array.from({ length: mebibytes }, () => block), Buffer.from([1, 0, 0, 0xff, 0xff]), adler]);
}

/** The error that `f` throws (undefined when it returns). */
function thrown(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  return undefined;
}

const reason = (error: unknown) => (error instanceof ImageRejected ? error.reason : `not rejected: ${String(error)}`);
const message = (error: unknown) => (error instanceof Error ? error.message : '');

describe('PNG: the data must not inflate to more than the header allows', () => {
  it('uses a zero stream that is valid (Node zlib inflates it)', () => {
    expect(inflateSync(zeros(3)).equals(Buffer.alloc(3 * MIB))).toBe(true);
  });

  it('rejects a 1 MB file with a 100x100 header that inflates to 1 GiB, and stops one slice after the limit', () => {
    const bomb = png(ihdr(100, 100), chunk('IDAT', zeros(1024)));
    expect(bomb.length).toBeLessThan(2 * MIB);
    const error = thrown(() => decodeGray(bomb));
    expect(reason(error)).toBe('too-large');
    expect(message(error)).toContain('more than 10100 bytes'); // 100 rows of 1 filter byte and 100 pixels
    expect(work.decodes).toBe(0); // fast-png never runs
    expect(work.inflated).toBeGreaterThan(10_100); // the check inflated up to the first slice over the limit, not 1 GiB
    expect(work.inflated).toBeLessThanOrEqual(10_100 + MOST_PAST_LIMIT);
  });

  it('inflates a stream that stays within the limit completely, and one that is 1 byte over it as far as the next slice', () => {
    const idat = (bytes: number) => png(ihdr(100, 100), chunk('IDAT', deflateSync(Buffer.alloc(bytes))));
    expect(decodeGray(idat(100 * 101)).width).toBe(100);
    expect(work.inflated).toBe(100 * 101); // the whole stream, and then fast-png
    expect(work.decodes).toBe(1);
    work.inflated = work.decodes = 0;
    expect(reason(thrown(() => decodeGray(idat(100 * 101 + 1))))).toBe('too-large');
    expect(work.decodes).toBe(0);
  });

  it('rejects data that is split over several IDAT chunks and is 1 byte over the size of the header', () => {
    const rows = (bytes: number) => deflateSync(Buffer.alloc(bytes));
    const split = (z: Buffer) => [chunk('IDAT', z.subarray(0, 10)), chunk('IDAT', z.subarray(10))];
    // 100x100 gray: 100 rows of 1 filter byte and 100 pixels
    expect(decodeGray(png(ihdr(100, 100), ...split(rows(100 * 101)))).width).toBe(100);
    work.decodes = 0;
    expect(reason(thrown(() => decodeGray(png(ihdr(100, 100), ...split(rows(100 * 101 + 1))))))).toBe('too-large');
    expect(work.decodes).toBe(0);
  });

  it('accepts a zlib stream that is split into tiny IDAT chunks, also with an empty first one', () => {
    const z = deflateSync(Buffer.concat(Array.from({ length: 100 }, () => Buffer.from([0, ...new Array<number>(100).fill(9)])))); // filter 0, pixels 9
    for (const sizes of [[0], [1], [1, 1], [2], [1, 3, 5]]) {
      let at = 0;
      const parts = [...sizes.map((n) => chunk('IDAT', z.subarray(at, (at += n)))), chunk('IDAT', z.subarray(at))];
      expect(Array.from(decodeGray(png(ihdr(100, 100), ...parts)).data.subarray(0, 3))).toEqual([9, 9, 9]);
    }
  });

  it('rejects a color type that does not exist', () => {
    expect(reason(thrown(() => decodeGray(png(ihdr(10, 10, { colorType: 5 }), chunk('IDAT', deflateSync(Buffer.alloc(110)))))))).toBe('unsupported');
    expect(work.decodes).toBe(0);
  });

  it('rejects a bit depth that the color type does not allow, before it inflates anything (depth 255 gave a limit of 2 GB)', () => {
    // the PNG standard, table of color types and bit depths
    const allowed: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
    for (const colorType of [0, 2, 3, 4, 6]) {
      for (const depth of [0, 1, 2, 3, 4, 8, 16, 32, 255]) {
        work.inflated = work.decodes = 0;
        const error = thrown(() => decodeGray(png(ihdr(10, 10, { depth, colorType }), chunk('IDAT', deflateSync(Buffer.alloc(1))))));
        if (allowed[colorType]!.includes(depth)) {
          expect(work.decodes, `color type ${colorType}, depth ${depth}`).toBe(1); // it reaches fast-png (which may still refuse the data)
        } else {
          expect([colorType, depth, reason(error), work.decodes, work.inflated]).toEqual([colorType, depth, 'unsupported', 0, 0]);
        }
      }
    }
    const bomb = png(ihdr(4000, 4000, { depth: 255, colorType: 6 }), chunk('IDAT', zeros(64)));
    expect(reason(thrown(() => decodeGray(bomb)))).toBe('unsupported');
    expect(work.inflated).toBe(0);
  });

  it.each(['iCCP', 'tRNS', 'PLTE'])('rejects a second %s chunk: the PNG standard allows one, and fast-png does work for each copy', (type) => {
    const idat = chunk('IDAT', deflateSync(Buffer.alloc(10 * 11)));
    const copy = {
      iCCP: chunk('iCCP', Buffer.concat([Buffer.from('p\0\0', 'latin1'), deflateSync(Buffer.alloc(3000, 7))])),
      tRNS: chunk('tRNS', Buffer.from([0, 255, 0])),
      PLTE: chunk('PLTE', Buffer.alloc(48)),
    }[type as 'iCCP' | 'tRNS' | 'PLTE'];
    const others = type === 'PLTE' ? [] : [chunk('PLTE', Buffer.alloc(48))]; // a palette image: tRNS needs a PLTE before it
    const file = (copies: number) => png(ihdr(10, 10, { colorType: 3 }), ...others, ...new Array<Buffer>(copies).fill(copy), idat);
    expect(decodeGray(file(1)).width).toBe(10);
    work.inflated = work.decodes = 0;
    const error = thrown(() => decodeGray(file(2)));
    expect(reason(error)).toBe('unsupported');
    expect(message(error)).toContain(`second ${type}`);
    expect(work.decodes).toBe(0);
    expect(work.inflated).toBeLessThanOrEqual(3000); // at most the first profile
  });

  it('inflates the first of many iCCP chunks and no more (2000 chunks of 1 MiB took 10 s)', () => {
    const one = chunk('iCCP', Buffer.concat([Buffer.from('p\0\0', 'latin1'), zeros(1)]));
    const file = png(ihdr(100, 100), ...new Array<Buffer>(2000).fill(one), chunk('IDAT', deflateSync(Buffer.alloc(100 * 101))));
    expect(reason(thrown(() => decodeGray(file)))).toBe('unsupported');
    expect(work.inflated).toBe(MIB); // the first profile, exactly 1 MiB
    expect(work.decodes).toBe(0);
  });

  it('rejects a second IHDR: the decoder would use the last one, the guard reads the first', () => {
    const big = chunk('IDAT', deflateSync(Buffer.alloc(3000 * 3001)));
    expect(readHeader(png(ihdr(8, 8), ihdr(3000, 3000), big))).toMatchObject({ width: 8, height: 8 });
    const error = thrown(() => decodeGray(png(ihdr(8, 8), ihdr(3000, 3000), big)));
    expect(reason(error)).toBe('unsupported');
    expect(message(error)).toContain('second IHDR');
    expect(work.decodes).toBe(0);
  });

  it('rejects an iCCP profile that inflates to more than 1 MiB, and accepts a normal one', () => {
    const idat = chunk('IDAT', deflateSync(Buffer.alloc(100 * 101)));
    const profile = (z: Buffer) => chunk('iCCP', Buffer.concat([Buffer.from('profile\0\0', 'latin1'), z]));
    const error = thrown(() => decodeGray(png(ihdr(100, 100), profile(zeros(256)), idat)));
    expect(reason(error)).toBe('too-large');
    expect(message(error)).toContain('iCCP');
    expect(work.decodes).toBe(0);
    expect(work.inflated).toBeGreaterThan(MIB); // the profile only: it stops one slice past 1 MiB, and the IDAT data is not inflated
    expect(work.inflated).toBeLessThanOrEqual(MIB + MOST_PAST_LIMIT);
    expect(decodeGray(png(ihdr(100, 100), profile(deflateSync(Buffer.alloc(3000, 7))), idat)).width).toBe(100);
    expect(decodeGray(png(ihdr(100, 100), profile(zeros(1)), idat)).width).toBe(100); // exactly 1 MiB
    expect(reason(thrown(() => decodeGray(png(ihdr(100, 100), profile(zeros(2)), idat))))).toBe('too-large');
  });

  it('accepts interlaced (Adam7) PNG files of any size: the limit counts the pixels of each pass', () => {
    const PASSES = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]; // x0, y0, dx, dy
    for (const [w, h] of [[1, 1], [2, 3], [8, 8], [13, 9], [33, 17]] as const) {
      const pixels = Array.from({ length: w * h }, (_, i) => (i * 37 + 11) % 256);
      const data: number[] = [];
      for (const [x0, y0, dx, dy] of PASSES as [number, number, number, number][]) {
        if (x0 >= w) continue;
        for (let y = y0; y < h; y += dy) {
          data.push(0); // filter type none
          for (let x = x0; x < w; x += dx) data.push(pixels[y * w + x]!);
        }
      }
      const g = decodeGray(png(ihdr(w, h, { interlace: 1 }), chunk('IDAT', deflateSync(Buffer.from(data)))));
      expect([g.width, g.height, Array.from(g.data)]).toEqual([w, h, pixels]);
    }
  });

  it('rejects a PLTE chunk of more than 256 entries (fast-png makes one array for each entry: 15 MB took 0.5 GB)', () => {
    const idat = chunk('IDAT', deflateSync(Buffer.alloc(10 * 11)));
    const palette = (bytes: number) => png(ihdr(10, 10, { colorType: 3 }), chunk('PLTE', Buffer.alloc(bytes)), idat);
    expect(decodeGray(palette(768)).width).toBe(10); // 256 entries
    work.decodes = 0;
    const error = thrown(() => decodeGray(palette(15 * MIB)));
    expect(reason(error)).toBe('unsupported');
    expect(message(error)).toContain('PLTE');
    expect(reason(thrown(() => decodeGray(palette(771))))).toBe('unsupported'); // 257 entries
    expect(work.decodes).toBe(0);
  });

  it('rejects a file over 20 MiB (the Devvit media upload limit) before it looks inside', () => {
    expect(reason(thrown(() => decodeGray(new Uint8Array(20 * MIB + 1))))).toBe('too-large');
    expect(reason(thrown(() => decodeGray(new Uint8Array(20 * MIB))))).toBe('unsupported'); // within the limit, but not an image
    expect(work.decodes + work.inflated).toBe(0);
  });
});

describe('JPEG: the number of scans', () => {
  // A progressive JPEG has about 10 scans. jpeg-js has no limit and each scan costs a pass over all blocks: 300 scans in a 106 KB
  // file took 31 s at 16 MP. The check counts the byte pairs FF DA in the whole file: no walk of the segments can be trusted,
  // because a wrong segment length hides segments from a walk but not from jpeg-js.
  const frame = (w: number, h: number) => [0xff, 0xc2, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]; // SOF2
  const scans = (n: number) => Array.from({ length: n }, () => [0xff, 0xda, 0, 2]).flat();
  const jpegWithScans = (n: number) => Uint8Array.from([0xff, 0xd8, ...frame(16, 16), ...scans(n), 0xff, 0xd9]);

  it('rejects more than 64 scans without decoding', () => {
    const error = thrown(() => decodeGray(jpegWithScans(65)));
    expect(reason(error)).toBe('too-large');
    expect(message(error)).toContain('scans');
    expect(work.jpegDecodes).toBe(0);
  });

  it('lets 64 scans through to jpeg-js (the limit is "more than 64")', () => {
    thrown(() => decodeGray(jpegWithScans(64))); // jpeg-js fails on this file; what counts is that it was called
    expect(work.jpegDecodes).toBe(1);
  });

  it('counts bytes, not segments: scans that a walk of the segments does not reach are counted', () => {
    // A DQT of length 3 hides the real frame header and the scans: a walk sees the fake frame header and then no marker.
    const fake = frame(16, 16);
    const hidden = (n: number) =>
      Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0, 3, 0, ...fake, ...new Array<number>(64 - fake.length).fill(0), ...frame(16, 16), ...scans(n), 0xff, 0xd9]);
    expect(readHeader(hidden(65))).toMatchObject({ width: 16, height: 16 });
    expect(reason(thrown(() => decodeGray(hidden(65))))).toBe('too-large');
    expect(work.jpegDecodes).toBe(0);
  });

  it('accepts a normal progressive JPEG (10 scans)', () => {
    expect(decodeGray(fixture('decoder/progressive.jpg')).width).toBe(32);
    expect(work.jpegDecodes).toBe(1);
  });
});

describe('JPEG: jpeg-js and readHeader must agree on the size', () => {
  /** A DQT of length 3 hides a fake 16x16 frame header from jpeg-js, which reads the table as 64 bytes and finds the real header. */
  function hiddenFrame(realWidth = 9999, realHeight = 9999): Uint8Array {
    const frame = (w: number, h: number) => [0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1];
    const fake = frame(16, 16);
    return Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0, 3, 0, ...fake, ...new Array<number>(64 - fake.length).fill(0), ...frame(realWidth, realHeight), 0xff, 0xd9]);
  }

  it('rejects the 92 byte file whose real frame is 100 megapixels, at the frame header of jpeg-js', () => {
    const bytes = hiddenFrame();
    expect(bytes.length).toBe(92);
    expect(readHeader(bytes)).toMatchObject({ width: 16, height: 16 }); // what the guard sees
    const error = thrown(() => decodeGray(bytes));
    expect(reason(error)).toBe('too-large');
    // Without the limit jpeg-js accepts 99.98 MP (its default is 100 MP), allocates, and fails later on its memory limit.
    expect(message(error)).toMatch(/^maxResolutionInMP limit exceeded/);
  });

  it('gives jpeg-js the same megapixel limit that the guard uses (the real frame is 0.01 MP, the header says 0.000256 MP)', () => {
    const bytes = hiddenFrame(100, 100);
    expect(reason(thrown(() => decodeGray(bytes, 0.005)))).toBe('too-large'); // jpeg-js stops at its frame header
    expect(reason(thrown(() => decodeGray(bytes, 0.02)))).toMatch(/^not rejected: /); // the frame fits; the file has no scan data
  });
});
