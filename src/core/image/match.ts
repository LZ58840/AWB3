import { crop, type Gray, type Hash, type QueryVariant, resize, type Signature, transform, type Variant } from './features';

/** The repost thresholds (install settings). Percent values: a match needs similarity >= `reportAt`, a removal >= `removeAt`. */
export interface MatchSettings {
  /** Largest Hamming distance (bits) between pHashes that passes the gate. */
  gate: number;
  /** Smallest aligned NCC. */
  ncc: number;
  /** Smallest share of matching tiles, in percent. */
  minTiles: number;
  reportAt: number;
  removeAt: number;
}

const popcount = (x: number) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
};

export const hamming = (a: Hash, b: Hash): number => popcount(a[0] ^ b[0]) + popcount(a[1] ^ b[1]);

export interface Candidate {
  id: string;
  sig: Signature;
}

export interface GateHit {
  id: string;
  /** The smallest Hamming distance of any compared pair of hashes. */
  distance: number;
  /** The variant of the query that gave it. */
  variant: Variant;
}

/** +1 landscape, -1 portrait, 0 square. */
const orientation = (s: Signature) => Math.sign(s.width - s.height);

/**
 * Stage 1: the candidates within `maxBits` of the query, nearest first, at most `top`. The query is compared, as
 * identity and mirror, with the candidate's pHash; a portrait query also with the phone windows of a landscape
 * candidate, and the windows of a landscape query with a portrait candidate. The rotated variants are compared only
 * for a portrait image against a landscape one.
 */
export function gate(query: QueryVariant[], candidates: Iterable<Candidate>, maxBits: number, top = 50): GateHit[] {
  const queryOrientation = orientation(query[0]!.sig); // identity comes first
  const hits: GateHit[] = [];
  for (const c of candidates) {
    const o = orientation(c.sig);
    let best: GateHit = { id: c.id, distance: Infinity, variant: 'identity' };
    for (const v of query) {
      const turned = v.name.startsWith('rot');
      if (turned && queryOrientation * o >= 0) continue;
      let d = hamming(v.sig.phash, c.sig.phash);
      if (!turned && orientation(v.sig) < 0) for (const w of c.sig.windows) d = Math.min(d, hamming(v.sig.phash, w));
      if (!turned && o < 0) for (const w of v.sig.windows) d = Math.min(d, hamming(w, c.sig.phash));
      if (d < best.distance) best = { id: c.id, distance: d, variant: v.name };
    }
    if (best.distance <= maxBits) hits.push(best);
  }
  return hits.sort((a, b) => a.distance - b.distance).slice(0, top);
}

const GRID = 8; // 8x8 tiles
const CHANGED_TILE = 0.5; // a tile is changed when its mean absolute difference exceeds this many standard deviations

/** Mean 0, standard deviation 1. */
function normalize(data: ArrayLike<number>): Float64Array {
  const n = data.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += data[i]!;
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (data[i]! - mean) ** 2;
  const sd = Math.sqrt(variance / n) + 1e-6;
  return Float64Array.from(data, (v) => (v - mean) / sd);
}

export interface Tiles {
  /** Number of changed tiles (of 64). */
  changed: number;
  /** Size of the largest 4-connected block of changed tiles. */
  block: number;
}

/** Stage 3: compare two aligned images of the same size on an 8x8 grid of tiles. */
export function tileCheck(a: Gray, b: Gray): Tiles {
  const [za, zb] = [normalize(a.data), normalize(b.data)];
  const { width: w, height: h } = a;
  const changed = Array.from({ length: GRID * GRID }, (_, t) => {
    const [x0, x1] = [Math.floor(((t % GRID) * w) / GRID), Math.floor((((t % GRID) + 1) * w) / GRID)];
    const [y0, y1] = [Math.floor((Math.floor(t / GRID) * h) / GRID), Math.floor(((Math.floor(t / GRID) + 1) * h) / GRID)];
    let sum = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += Math.abs(za[y * w + x]! - zb[y * w + x]!);
    return sum / ((x1 - x0) * (y1 - y0)) > CHANGED_TILE;
  });
  const seen = new Set<number>();
  let block = 0;
  changed.forEach((on, start) => {
    if (!on || seen.has(start)) return;
    const stack = [start];
    seen.add(start);
    let size = 0;
    while (stack.length) {
      const t = stack.pop()!;
      size++;
      for (const n of [t - GRID, t + GRID, t % GRID ? t - 1 : -1, t % GRID < GRID - 1 ? t + 1 : -1]) {
        if (n >= 0 && n < GRID * GRID && changed[n] && !seen.has(n)) (seen.add(n), stack.push(n));
      }
    }
    block = Math.max(block, size);
  });
  return { changed: changed.filter(Boolean).length, block };
}

export interface Decision {
  ncc: number;
  changedTiles: number;
  largestBlock: number;
  /** Share of matching tiles, in percent. */
  matchedPercent: number;
  /** 100 - largest block / 64 * 100, in percent (steps of 1.5625). */
  similarity: number;
  /** `remove` means that the similarity reaches `removeAt`; the caller still applies "report only". */
  action: 'none' | 'report' | 'remove';
}

/** Stages 2 and 3 together: NCC, share of matching tiles and similarity against the thresholds. */
export function decide(ncc: number, t: Tiles, s: MatchSettings): Decision {
  const matchedPercent = (100 * (GRID * GRID - t.changed)) / (GRID * GRID);
  const similarity = 100 - (100 * t.block) / (GRID * GRID);
  const match = ncc >= s.ncc && matchedPercent >= s.minTiles && similarity >= s.reportAt;
  return {
    ncc,
    changedTiles: t.changed,
    largestBlock: t.block,
    matchedPercent,
    similarity,
    action: !match ? 'none' : similarity >= s.removeAt ? 'remove' : 'report',
  };
}

// The search cost grows with the square of the aspect ratio (128x16 takes 0.1 s, 128x3 2.4 s, 128x1 20 s) and a thumbnail that
// is more elongated has fewer than 16 rows to align. Up to 8:1 a window always fits (checked for all sizes up to 128 px).
const MAX_ASPECT = 8;
const COARSE_HEIGHT = 36; // the smaller image is 36 px high in the coarse search and 72 px high in the refinement
const REFINE_HEIGHT = 72;
const SCALES = [1, 0.95, 0.9, 0.85, 0.8]; // the smaller image covers this share of the larger one's height

type Offsets = [x0: number, x1: number, y0: number, y1: number];

/** The best NCC of the normalized image `q` (qw x qh) at the given offsets of the container `c` (cw wide). */
function slide(q: Float64Array, qw: number, qh: number, c: ArrayLike<number>, cw: number, [x0, x1, y0, y1]: Offsets) {
  const n = qw * qh;
  let best = { ncc: -Infinity, x: x0, y: y0 };
  for (let oy = y0; oy <= y1; oy++) {
    for (let ox = x0; ox <= x1; ox++) {
      let sum = 0;
      let sumSquares = 0;
      let dot = 0;
      for (let y = 0; y < qh; y++) {
        const row = (oy + y) * cw + ox;
        for (let x = 0; x < qw; x++) {
          const v = c[row + x]!;
          sum += v;
          sumSquares += v * v;
          dot += v * q[y * qw + x]!;
        }
      }
      const ncc = dot / n / (Math.sqrt(Math.max(0, sumSquares / n - (sum / n) ** 2)) + 1e-6);
      if (ncc > best.ncc) best = { ncc, x: ox, y: oy };
    }
  }
  return best;
}

export interface Alignment {
  /** NCC of the refined alignment. */
  ncc: number;
  /** The two aligned images, same size, ready for `tileCheck`. */
  a: Gray;
  b: Gray;
}

/**
 * Stage 2: align two thumbnails, where one may be a crop (or a phone window) of the other, and give the NCC of the
 * best alignment. Coarse search at 36 px height over offset and five scales, in both directions; then a refinement
 * at 72 px height around the best result (scale +-0.02, offset +-3 px). Undefined when an image is more than 8:1.
 */
export function align(a: Gray, b: Gray): Alignment | undefined {
  if ([a, b].some((g) => Math.max(g.width, g.height) > MAX_ASPECT * Math.min(g.width, g.height))) return undefined;
  let best: { q: Gray; c: Gray; scale: number; x: number; y: number; ncc: number } | undefined;
  for (const [q, c] of [[a, b], [b, a]] as const) {
    const qw = Math.max(4, Math.round((q.width * COARSE_HEIGHT) / q.height));
    const small = normalize(resize(q, qw, COARSE_HEIGHT).data);
    for (const scale of SCALES) {
      const ch = Math.round(COARSE_HEIGHT / scale);
      const cw = Math.round((c.width * ch) / c.height);
      if (cw < qw || ch < COARSE_HEIGHT) continue;
      const r = slide(small, qw, COARSE_HEIGHT, resize(c, cw, ch).data, cw, [0, cw - qw, 0, ch - COARSE_HEIGHT]);
      if (!best || r.ncc > best.ncc) best = { q, c, scale, x: r.x / cw, y: r.y / ch, ncc: r.ncc };
    }
  }
  const found = best!; // set: within 8:1 one direction and scale always fits
  const qw = Math.max(8, Math.round((found.q.width * REFINE_HEIGHT) / found.q.height));
  const query = resize(found.q, qw, REFINE_HEIGHT);
  const normalized = normalize(query.data);
  let fine: { ncc: number; window: Gray } | undefined;
  const searched = new Set<number>(); // near scale 1 several steps give the same height, and so the same search
  for (const delta of [-0.02, -0.01, 0, 0.01, 0.02]) {
    const ch = Math.max(REFINE_HEIGHT, Math.round(REFINE_HEIGHT / Math.min(found.scale + delta, 1)));
    if (searched.has(ch)) continue;
    searched.add(ch);
    const cw = Math.max(qw, Math.round((found.c.width * ch) / found.c.height));
    const container = resize(found.c, cw, ch);
    const cx = Math.min(Math.round(found.x * cw), cw - qw);
    const cy = Math.min(Math.round(found.y * ch), ch - REFINE_HEIGHT);
    const r = slide(normalized, qw, REFINE_HEIGHT, container.data, cw, [
      Math.max(0, cx - 3),
      Math.min(cw - qw, cx + 3),
      Math.max(0, cy - 3),
      Math.min(ch - REFINE_HEIGHT, cy + 3),
    ]);
    if (!fine || r.ncc > fine.ncc) fine = { ncc: r.ncc, window: crop(container, r.x, r.y, qw, REFINE_HEIGHT) };
  }
  return { ncc: fine!.ncc, a: query, b: fine!.window };
}

/**
 * Stages 2 and 3 for one gate hit: turn the query thumbnail by the variant that the gate chose, align it with the
 * candidate thumbnail, check the tiles, and decide.
 */
export function compare(query: Gray, candidate: Gray, variant: Variant, settings: MatchSettings): Decision {
  const aligned = align(transform(query, variant), candidate);
  return aligned
    ? decide(aligned.ncc, tileCheck(aligned.a, aligned.b), settings)
    : decide(0, { changed: GRID * GRID, block: GRID * GRID }, settings);
}
