import { describe, expect, it, vi } from 'vitest';
import { type Gray, type Hash, type QueryVariant, type Signature, transform } from '../../src/core/image/features';
import { align, type Candidate, compare, decide, gate, hamming, tileCheck } from '../../src/core/image/match';
import { defaults, rng } from './helpers';

/** Two 64x64 images (8x8 px per tile) that differ in exactly the given tiles: b is a with those tiles inverted. */
function pair(changedTiles: number[]): { a: Gray; b: Gray } {
  const random = rng(12345);
  const noise = Uint8Array.from({ length: 64 * 64 }, () => Math.floor(random() * 256));
  const inverted = Uint8Array.from(noise);
  for (const t of changedTiles) {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const i = (Math.floor(t / 8) * 8 + y) * 64 + (t % 8) * 8 + x;
        inverted[i] = 255 - noise[i]!;
      }
    }
  }
  return { a: { width: 64, height: 64, data: noise }, b: { width: 64, height: 64, data: inverted } };
}

const tile = (row: number, col: number) => row * 8 + col;

describe('tileCheck: changed tiles of two aligned images on an 8x8 grid', () => {
  it.each([
    ['no changed tile', [], 0, 0],
    ['one tile', [tile(3, 3)], 1, 1],
    ['two tiles side by side', [tile(3, 3), tile(3, 4)], 2, 2],
    ['two tiles that touch only at a corner (4-connected: two blocks)', [tile(3, 3), tile(4, 4)], 2, 1],
    ['an L of three tiles', [tile(1, 1), tile(2, 1), tile(2, 2)], 3, 3],
    ['a 2x2 square', [tile(5, 5), tile(5, 6), tile(6, 5), tile(6, 6)], 4, 4],
    ['two blocks: the larger one counts', [tile(0, 0), tile(0, 1), tile(0, 2), tile(7, 7), tile(7, 6)], 5, 3],
    ['tiles at the border', [tile(0, 7), tile(7, 0)], 2, 1],
  ])('%s', (_name, changed, count, block) => {
    const { a, b } = pair(changed);
    expect(tileCheck(a, b)).toEqual({ changed: count, block });
  });
});

describe('tileCheck: a tile is changed when its mean difference is more than 0.5 standard deviations', () => {
  // b is a with one tile shifted up or down by a number of standard deviations of a (floats: no clipping)
  function shifted(sigmas: number): { a: Gray; b: Gray } {
    const { a } = pair([]);
    const values = Array.from(a.data);
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const sd = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
    const b = Float32Array.from(a.data);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) b[(24 + y) * 64 + 32 + x]! += sigmas * sd; // tile (3, 4)
    return { a, b: { width: 64, height: 64, data: b } };
  }

  it.each([
    [0.4, 0],
    [0.48, 0],
    [0.52, 1],
    [0.6, 1],
    [-0.48, 0],
    [-0.52, 1],
  ])('a shift of %f standard deviations changes %i tiles', (sigmas, changed) => {
    const { a, b } = shifted(sigmas);
    expect(tileCheck(a, b)).toEqual({ changed, block: changed });
  });
});

describe('decide: the stage-3 limits of the plan (OD4b)', () => {
  const ncc = 0.95;
  // largest block of changed tiles -> similarity 100 - block / 64 * 100 (plan section 1, OD4b), and the action at 98 / 94
  it.each([
    [0, 100, 'remove'],
    [1, 98.4375, 'remove'],
    [2, 96.875, 'report'],
    [3, 95.3125, 'report'],
    [4, 93.75, 'none'],
  ] as const)('a largest block of %i tiles gives similarity %f and the action %s', (block, similarity, action) => {
    const d = decide(ncc, { changed: block, block }, defaults);
    expect(d.similarity).toBe(similarity);
    expect(d.action).toBe(action);
  });

  it('turns a block of 3 tiles into "none" when reportAt is 96, and a block of 1 into "report" when removeAt is 100', () => {
    expect(decide(ncc, { changed: 3, block: 3 }, { ...defaults, reportAt: 96 }).action).toBe('none');
    expect(decide(ncc, { changed: 1, block: 1 }, { ...defaults, removeAt: 100 }).action).toBe('report');
    expect(decide(ncc, { changed: 0, block: 0 }, { ...defaults, removeAt: 100 }).action).toBe('remove');
  });

  it('keeps 9 scattered changed tiles (85.9% match) and drops 10 (84.4%) at minTiles 85', () => {
    // scattered single tiles give a largest block of 1: similarity 98.4375, so a kept match is removal-eligible
    const nine = decide(ncc, { changed: 9, block: 1 }, defaults);
    const ten = decide(ncc, { changed: 10, block: 1 }, defaults);
    expect(nine.matchedPercent).toBe(85.9375);
    expect(nine.action).toBe('remove');
    expect(ten.matchedPercent).toBe(84.375);
    expect(ten.action).toBe('none');
    expect(decide(ncc, { changed: 10, block: 1 }, { ...defaults, minTiles: 84 }).action).toBe('remove');
  });

  it('accepts a value that is exactly on a limit: reportAt, removeAt and minTiles are "at least"', () => {
    const [four, one, nine] = [{ changed: 4, block: 4 }, { changed: 1, block: 1 }, { changed: 9, block: 1 }];
    expect(decide(ncc, four, { ...defaults, reportAt: 93.75 }).action).toBe('report');
    expect(decide(ncc, four, { ...defaults, reportAt: 93.76 }).action).toBe('none');
    expect(decide(ncc, one, { ...defaults, removeAt: 98.4375 }).action).toBe('remove');
    expect(decide(ncc, one, { ...defaults, removeAt: 98.44 }).action).toBe('report');
    expect(decide(ncc, nine, { ...defaults, minTiles: 85.9375 }).action).toBe('remove');
    expect(decide(ncc, nine, { ...defaults, minTiles: 85.94 }).action).toBe('none');
  });

  it('needs an aligned NCC of at least ncc', () => {
    const t = { changed: 0, block: 0 };
    expect(decide(0.8, t, defaults).action).toBe('remove');
    expect(decide(0.79, t, defaults).action).toBe('none');
    expect(decide(0.79, t, { ...defaults, ncc: 0.7 }).action).toBe('remove');
  });

  it('reports every number that it decided on', () => {
    expect(decide(0.9, { changed: 5, block: 3 }, defaults)).toEqual({
      ncc: 0.9,
      changedTiles: 5,
      largestBlock: 3,
      matchedPercent: 92.1875,
      similarity: 95.3125,
      action: 'report',
    });
  });
});

describe('tileCheck + decide on image pairs: 9 and 10 scattered changed tiles', () => {
  it.each([
    [9, 'remove'],
    [10, 'none'],
  ] as const)('%i changed tiles, none next to another: %s', (n, action) => {
    const tiles = [tile(0, 0), tile(0, 2), tile(0, 4), tile(0, 6), tile(2, 1), tile(2, 3), tile(2, 5), tile(2, 7), tile(4, 0), tile(4, 2)].slice(0, n);
    const { a, b } = pair(tiles);
    const t = tileCheck(a, b);
    expect(t).toEqual({ changed: n, block: 1 });
    expect(decide(0.9, t, defaults).action).toBe(action);
  });
});

// ---- gate ----

const hash = (hex: string): Hash => [parseInt(hex.slice(0, 8), 16), parseInt(hex.slice(8), 16)];
// Eight hashes that are 32 or 64 bits apart from each other (checked below).
const [A, B, C, D, E, F, G, H] = [
  '0000000000000000',
  'ffffffffffffffff',
  'ffffffff00000000',
  '00000000ffffffff',
  'ffff0000ffff0000',
  '0000ffff0000ffff',
  'ff00ff00ff00ff00',
  '00ff00ff00ff00ff',
].map(hash) as [Hash, Hash, Hash, Hash, Hash, Hash, Hash, Hash];

/** A hash that differs from `h` in exactly `n` bits (the lowest ones). */
const apart = (h: Hash, n: number): Hash => [(h[0] ^ (n > 32 ? 2 ** (n - 32) - 1 : 0)) >>> 0, (h[1] ^ (n >= 32 ? 0xffffffff : 2 ** n - 1)) >>> 0];

type Shape = 'landscape' | 'portrait' | 'square';
const SIZES: Record<Shape, [number, number]> = { landscape: [640, 360], portrait: [360, 640], square: [360, 360] };
const sig = (shape: Shape, phash: Hash, windows: Hash[] = []): Signature => ({
  width: SIZES[shape][0],
  height: SIZES[shape][1],
  phash,
  windows,
});

/** The six variants of a query. Identity is `A`, mirror `B`, the rotations `C` to `F`; a rotation turns the orientation. */
function query(shape: 'landscape' | 'portrait', windows: { identity?: Hash[]; mirror?: Hash[] } = {}): QueryVariant[] {
  const turned = (name: QueryVariant['name'], phash: Hash) => ({ name, sig: sig(shape === 'landscape' ? 'portrait' : 'landscape', phash) });
  return [
    { name: 'identity', sig: sig(shape, A, windows.identity) },
    { name: 'mirror', sig: sig(shape, B, windows.mirror) },
    turned('rot90', C),
    turned('rot90-mirror', D),
    turned('rot270', E),
    turned('rot270-mirror', F),
  ];
}

const candidate = (id: string, s: Signature): Candidate => ({ id, sig: s });

describe('hamming', () => {
  it('counts the differing bits of both halves', () => {
    expect(hamming(A, A)).toBe(0);
    expect(hamming(A, B)).toBe(64);
    expect(hamming(C, D)).toBe(64);
    expect(hamming(hash('f0f0f0f00f0f0f0f'), hash('0f0f0f0ff0f0f0f0'))).toBe(64);
    expect(hamming(hash('0000000000000001'), hash('0000000000000000'))).toBe(1);
    expect(hamming(hash('8000000000000000'), hash('0000000000000000'))).toBe(1);
    expect(hamming(hash('0123456789abcdef'), hash('0123456789abcdee'))).toBe(1);
  });
});

describe('gate: hashes against the stored signatures', () => {
  it('uses test hashes that are far enough apart', () => {
    const all = [A, B, C, D, E, F, G, H];
    for (const x of all) for (const y of all) if (x !== y) expect(hamming(x, y)).toBeGreaterThan(22);
    expect(hamming(apart(A, 22), A)).toBe(22);
    expect(hamming(apart(A, 40), A)).toBe(40);
  });

  it('passes a pHash within the gate and stops at the next bit', () => {
    const hits = gate(query('landscape'), [candidate('at-22', sig('landscape', apart(A, 22))), candidate('at-23', sig('landscape', apart(A, 23)))], 22);
    expect(hits).toEqual([{ id: 'at-22', distance: 22, variant: 'identity' }]);
    expect(gate(query('landscape'), [candidate('at-23', sig('landscape', apart(A, 23)))], 23)).toHaveLength(1); // the gate is a parameter
  });

  it('takes the mirrored query when it is closer', () => {
    expect(gate(query('landscape'), [candidate('m', sig('landscape', apart(B, 5)))], 22)).toEqual([{ id: 'm', distance: 5, variant: 'mirror' }]);
  });

  it('prefers identity when identity and mirror are equally close', () => {
    const symmetric = query('landscape').map((v) => (v.name === 'mirror' ? { ...v, sig: { ...v.sig, phash: A } } : v));
    expect(gate(symmetric, [candidate('s', sig('landscape', A))], 22)).toEqual([{ id: 's', distance: 0, variant: 'identity' }]);
  });

  it('lists the nearest first and keeps 50', () => {
    // candidate k is floor(k * 23 / 60) bits from A: distances 0 to 22, about 2.6 candidates each
    const distances = Array.from({ length: 60 }, (_, k) => Math.floor((k * 23) / 60));
    const all = distances.map((d, k) => candidate(`c${k}`, sig('landscape', apart(A, d))));
    const hits = gate(query('landscape'), all, 22);
    const expected = distances
      .map((d, k) => ({ id: `c${k}`, d }))
      .sort((x, y) => x.d - y.d) // stable: ties keep the order of the candidates
      .slice(0, 50);
    expect(hits.map((h) => h.id)).toEqual(expected.map((e) => e.id));
    expect(hits.map((h) => h.distance)).toEqual(expected.map((e) => e.d));
    expect(gate(query('landscape'), all, 22, 3).map((h) => h.id)).toEqual(['c0', 'c1', 'c2']);
  });

  describe('phone windows: a portrait image against a landscape one', () => {
    const windows = [...Array.from({ length: 17 }, () => H), apart(A, 10)]; // one window is close to the identity hash A
    const landscapeCandidate = candidate('wide', sig('landscape', G, windows));

    it('compares a portrait query with the windows of a landscape candidate', () => {
      expect(gate(query('portrait'), [landscapeCandidate], 22)).toEqual([{ id: 'wide', distance: 10, variant: 'identity' }]);
    });

    it('does not compare windows when the query is landscape too', () => {
      expect(gate(query('landscape'), [landscapeCandidate], 22)).toEqual([]);
    });

    it('compares the windows of a landscape query, identity and mirror, with a portrait candidate', () => {
      const q = query('landscape', { identity: [...Array.from({ length: 17 }, () => H), apart(G, 8)], mirror: [apart(G, 4), ...Array.from({ length: 17 }, () => H)] });
      expect(gate(q, [candidate('tall', sig('portrait', G))], 22)).toEqual([{ id: 'tall', distance: 4, variant: 'mirror' }]);
      expect(gate(q.slice(0, 1), [candidate('tall', sig('portrait', G))], 22)).toEqual([{ id: 'tall', distance: 8, variant: 'identity' }]);
      expect(gate(q, [candidate('wide', sig('landscape', G))], 22)).toEqual([]); // not against a landscape candidate
    });

    it('does not use windows against a square candidate', () => {
      const q = query('landscape', { identity: [apart(G, 3)] });
      expect(gate(q, [candidate('sq', sig('square', G))], 22)).toEqual([]);
    });
  });

  describe('rotations: only a portrait image against a landscape one', () => {
    it('compares the rotated variants of a landscape query with a portrait candidate', () => {
      expect(gate(query('landscape'), [candidate('t', sig('portrait', apart(C, 3)))], 22)).toEqual([{ id: 't', distance: 3, variant: 'rot90' }]);
      expect(gate(query('landscape'), [candidate('t', sig('portrait', apart(F, 2)))], 22)).toEqual([{ id: 't', distance: 2, variant: 'rot270-mirror' }]);
    });

    it('compares the rotated variants of a portrait query with a landscape candidate', () => {
      expect(gate(query('portrait'), [candidate('w', sig('landscape', apart(E, 3)))], 22)).toEqual([{ id: 'w', distance: 3, variant: 'rot270' }]);
    });

    it('does not rotate when both images have the same orientation', () => {
      expect(gate(query('landscape'), [candidate('w', sig('landscape', apart(C, 3)))], 22)).toEqual([]);
      expect(gate(query('portrait'), [candidate('t', sig('portrait', apart(C, 3)))], 22)).toEqual([]);
      expect(gate(query('landscape'), [candidate('sq', sig('square', apart(C, 3)))], 22)).toEqual([]);
    });
  });
});

// ---- aligned comparison ----

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

const WHOLE: Region = { x: 0, y: 0, w: 1, h: 1 };

/**
 * A smooth random scene on the unit square, sampled at width x height over a region of it. The same seed gives the
 * same scene, so a crop or a phone window is an exact sample of it, with no resampling error.
 */
function scene(width: number, height: number, seed: number, region: Region = WHOLE, detail = 1): Gray {
  const random = rng(seed);
  const waves = Array.from({ length: 14 }, () => ({ fx: random() * 7 * detail, fy: random() * 5 * detail, phase: random() * 2 * Math.PI, amp: 12 + random() * 30 }));
  const data = new Uint8Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const u = region.x + ((i + 0.5) / width) * region.w;
      const v = region.y + ((j + 0.5) / height) * region.h;
      const value = waves.reduce((sum, k) => sum + k.amp * Math.sin(2 * Math.PI * (k.fx * u + k.fy * v) + k.phase), 128);
      data[j * width + i] = Math.min(255, Math.max(0, Math.round(value)));
    }
  }
  return { width, height, data };
}

/** The thumbnail (128 px on the long side) of a crop of the 16:9 scene `seed`. The unit square stands for 16 x 9 units. */
function cropThumbnail(seed: number, region: Region, detail = 1): Gray {
  const [w, h] = [region.w * 16, region.h * 9];
  return w >= h ? scene(128, Math.round((128 * h) / w), seed, region, detail) : scene(Math.round((128 * w) / h), 128, seed, region, detail);
}

describe('align: NCC of two thumbnails, with the best offset and scale', () => {
  const candidate = cropThumbnail(1, WHOLE); // 128 x 72

  it('gives NCC 1 and no changed tile for the same image', () => {
    const a = align(cropThumbnail(1, WHOLE), candidate)!;
    expect(a.ncc).toBeGreaterThan(0.99);
    expect(tileCheck(a.a, a.b)).toEqual({ changed: 0, block: 0 });
  });

  it('ignores brightness and contrast', () => {
    const edited = { ...candidate, data: Uint8Array.from(candidate.data, (v) => Math.round(v * 0.7 + 45)) };
    expect(align(edited, candidate)!.ncc).toBeGreaterThan(0.99);
  });

  it.each([
    ['85% of the scene, from the top left', { x: 0, y: 0, w: 0.85, h: 0.85 }],
    ['85% of the scene, from the middle', { x: 0.1, y: 0.07, w: 0.85, h: 0.85 }],
    ['82% of the scene, which is between two coarse scales', { x: 0.12, y: 0.1, w: 0.82, h: 0.82 }],
    ['a 9:16 phone window of full height', { x: 0.3, y: 0, w: 0.3164, h: 1 }],
    ['a 9:19.5 phone window of full height', { x: 0.55, y: 0, w: 0.2596, h: 1 }],
  ])('finds %s of the candidate', (_name, region) => {
    expect(align(cropThumbnail(1, region), candidate)!.ncc).toBeGreaterThan(0.9);
  });

  it.each([
    ['83% of the scene at an odd offset', { x: 0.1234, y: 0.0871, w: 0.83, h: 0.83 }],
    ['90% of the scene at an odd offset', { x: 0.0371, y: 0.0413, w: 0.9, h: 0.9 }],
    ['a phone window at an odd offset', { x: 0.3071, y: 0, w: 0.3164, h: 1 }],
  ])('refines the alignment in a detailed scene: %s', (_name, region) => {
    // fine detail (wavelengths of 5 px) needs the 72 px refinement: a coarse 36 px search alone gives NCC 0.5 to 0.9 here
    expect(align(cropThumbnail(1, region, 3), cropThumbnail(1, WHOLE, 3))!.ncc).toBeGreaterThan(0.95);
  });

  it.each([
    ['the whole scene (scale 1.0)', { x: 0, y: 0, w: 1, h: 1 }],
    ['95% of the scene', { x: 0.0371, y: 0.0213, w: 0.95, h: 0.95 }],
    ['90% of the scene', { x: 0.0371, y: 0.0713, w: 0.9, h: 0.9 }],
    ['85% of the scene', { x: 0.1071, y: 0.0413, w: 0.85, h: 0.85 }],
    ['80% of the scene', { x: 0.1371, y: 0.0913, w: 0.8, h: 0.8 }],
  ])('aligns %s in a detailed scene (each coarse scale is needed: the refinement reaches only 0.02 away)', (_name, region) => {
    expect(align(cropThumbnail(1, region, 3), cropThumbnail(1, WHOLE, 3))!.ncc).toBeGreaterThan(0.95);
  });

  it('finds the candidate in a larger query (the candidate is the crop)', () => {
    expect(align(candidate, cropThumbnail(1, { x: 0.1, y: 0.07, w: 0.85, h: 0.85 }))!.ncc).toBeGreaterThan(0.9);
  });

  it('gives a low NCC for an unrelated scene', () => {
    expect(align(cropThumbnail(2, WHOLE), candidate)!.ncc).toBeLessThan(0.8);
    expect(align(cropThumbnail(3, WHOLE), candidate)!.ncc).toBeLessThan(0.8);
  });

  describe('thumbnails that are more than 8:1', () => {
    const random = rng(3);
    const strip = (width: number, height: number): Gray => ({ width, height, data: Uint8Array.from({ length: width * height }, () => Math.floor(random() * 256)) });
    // Pixels that throw when they are read: `align` must say "no" from the size alone, before any work (128x3 took 2.4 s and 128x1 took 20 s).
    const untouchable = (width: number, height: number): Gray => ({
      width,
      height,
      data: new Proxy(new Uint8Array(width * height), {
        get() {
          throw new Error('a pixel was read');
        },
      }),
    });
    /** `align` takes one Math.sqrt for each offset that it tries (and one for each image that it normalizes), so this counts the work without a clock. */
    function sqrtCalls(f: () => unknown): number {
      const spy = vi.spyOn(Math, 'sqrt');
      try {
        f();
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    }

    it('are not aligned: align answers from the size, before it reads a pixel', () => {
      expect(align(untouchable(128, 3), untouchable(128, 3))).toBeUndefined();
      expect(align(untouchable(3, 128), untouchable(3, 128))).toBeUndefined();
      expect(align(untouchable(128, 1), cropThumbnail(1, WHOLE))).toBeUndefined(); // one of the two is enough
      expect(align(cropThumbnail(1, WHOLE), untouchable(1, 128))).toBeUndefined();
    });

    it('stop at 8:1: 128x16 is aligned and 128x15 is not (a 21:9 or 48:9 wallpaper is far below the limit)', () => {
      expect(align(strip(128, 16), strip(128, 16))).toBeDefined();
      expect(align(strip(16, 128), strip(16, 128))).toBeDefined();
      expect(align(untouchable(128, 15), untouchable(128, 15))).toBeUndefined();
      expect(align(untouchable(15, 128), untouchable(15, 128))).toBeUndefined();
    });

    it('cost about 2,800 offsets at 8:1, and the coarse search at 36 px keeps it so', () => {
      // Coarse search, for each direction: the offsets (cw - qw + 1) * (ch - 35) at the five scales are 1, 51, 165, 343 and 730,
      // so 1,290 for each direction and 2,580 together. The refinement tries at most 5 * 49 = 245 offsets. A search at 72 px would be about 10,000.
      const calls = sqrtCalls(() => align(strip(128, 16), strip(128, 16)));
      expect(calls).toBeGreaterThan(2000); // the count measures the search
      expect(calls).toBeLessThan(4000);
    });

    it('give "none" in compare', () => {
      expect(compare(untouchable(128, 3), untouchable(128, 3), 'identity', defaults)).toMatchObject({ ncc: 0, action: 'none' });
    });
  });
});

describe('compare: align, check the tiles and decide', () => {
  const candidate = cropThumbnail(1, WHOLE);

  it('does nothing for an unrelated image, and flags an identical one for removal', () => {
    expect(compare(cropThumbnail(2, WHOLE), candidate, 'identity', defaults).action).toBe('none');
    const same = compare(cropThumbnail(1, WHOLE), candidate, 'identity', defaults);
    expect(same.action).toBe('remove');
    expect(same.similarity).toBe(100);
  });

  it('un-mirrors the query by the variant that the gate chose', () => {
    const mirrored = transform(candidate, 'mirror');
    expect(compare(mirrored, candidate, 'mirror', defaults).action).toBe('remove');
    expect(compare(mirrored, candidate, 'identity', defaults).action).toBe('none');
  });

  it('turns the query back by a rotation variant (a portrait image against a landscape one)', () => {
    const portrait = transform(candidate, 'rot90'); // 72 x 128
    expect(compare(portrait, candidate, 'rot270', defaults).action).toBe('remove');
  });

});
