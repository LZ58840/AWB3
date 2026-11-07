// Features of one image for repost detection (plan 5.4 step 3): prepare the gray image, hash it, hash its phone
// windows and its mirrored and rotated variants, and make the 128 px thumbnail. Pure functions, no Devvit imports.

/** A gray image, row-major, one value per pixel (0-255). */
export interface Gray {
  width: number;
  height: number;
  data: Uint8Array | Float32Array;
}

/** A 64-bit hash as two unsigned 32-bit halves. Bit 0 of the flattened 8x8 array (as imagehash) is the top bit of `hi`. */
export type Hash = readonly [hi: number, lo: number];

export interface Signature {
  /** Size of the image that the hashes come from. */
  width: number;
  height: number;
  phash: Hash;
  /** pHash of each window of `windowBoxes` (18 for a landscape image that is at least 18 px high; fewer or none for a tiny one, none for a portrait one). */
  windows: Hash[];
}

export type Variant = 'identity' | 'mirror' | 'rot90' | 'rot90-mirror' | 'rot270' | 'rot270-mirror';

export interface QueryVariant {
  name: Variant;
  sig: Signature;
}

// ---- image operations ----

/** One axis of `resize`: every row of `w` samples becomes `nw` area means. The result is transposed (nw rows of h samples). */
function pass(src: ArrayLike<number>, w: number, h: number, nw: number): Float32Array {
  const out = new Float32Array(nw * h);
  const k = w / nw;
  const sum = new Float64Array(w + 1); // sum[i] = total of the first i samples of the row
  for (let y = 0; y < h; y++) {
    for (let i = 0; i < w; i++) sum[i + 1] = sum[i]! + src[y * w + i]!;
    const upTo = (t: number) => {
      const i = Math.min(Math.floor(t), w - 1);
      return sum[i]! + src[y * w + i]! * (t - i);
    };
    for (let x = 0; x < nw; x++) out[x * h + y] = (upTo((x + 1) * k) - upTo(x * k)) / k;
  }
  return out;
}

/** Area resize: each output pixel is the mean of the source area it covers (a box filter, any ratio). */
export function resize(g: Gray, w: number, h: number): Gray {
  return { width: w, height: h, data: pass(pass(g.data, g.width, g.height, w), g.height, w, h) };
}

export function crop(g: Gray, x: number, y: number, w: number, h: number): Gray {
  const data = g.data instanceof Uint8Array ? new Uint8Array(w * h) : new Float32Array(w * h);
  for (let r = 0; r < h; r++) data.set(g.data.subarray((y + r) * g.width + x, (y + r) * g.width + x + w), r * w);
  return { width: w, height: h, data };
}

/** Mirror (left-right) and 90 degree rotations (rot90 is counter-clockwise, as np.rot90); "-mirror" mirrors the rotated image. */
export function transform(g: Gray, v: Variant): Gray {
  if (v === 'identity') return g;
  const { width: w, height: h } = g;
  const [nw, nh] = v === 'mirror' ? [w, h] : [h, w];
  const data = g.data instanceof Uint8Array ? new Uint8Array(w * h) : new Float32Array(w * h);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      // index of the source pixel of output pixel (x, y)
      const from =
        v === 'mirror'
          ? y * w + (w - 1 - x)
          : v === 'rot90'
            ? x * w + (w - 1 - y)
            : v === 'rot270'
              ? (h - 1 - x) * w + y
              : v === 'rot90-mirror'
                ? (h - 1 - x) * w + (w - 1 - y)
                : x * w + y; // rot270-mirror
      data[y * nw + x] = g.data[from]!;
    }
  }
  return { width: nw, height: nh, data };
}

const BAR_SPREAD = 12; // an edge row or column is a bar while max - min <= 12 gray levels
const MIN_SIDE = 8; // trimming keeps at least this many rows and columns

/** Remove uniform bars (letterbox, pillarbox) from the four edges, until no edge moves (side bars can hide a band at the top). */
export function trimBars(g: Gray): Gray {
  const { width: w, height: h, data: d } = g;
  const flat = (start: number, step: number, n: number) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0, i = start; k < n; k++, i += step) {
      lo = Math.min(lo, d[i]!);
      hi = Math.max(hi, d[i]!);
    }
    return hi - lo <= BAR_SPREAD;
  };
  let [t, b, l, r] = [0, h, 0, w];
  for (let moved = true; moved; ) {
    const area = (b - t) * (r - l); // it gets smaller with every step
    while (t < b - MIN_SIDE && flat(t * w + l, 1, r - l)) t++;
    while (b > t + MIN_SIDE && flat((b - 1) * w + l, 1, r - l)) b--;
    while (l < r - MIN_SIDE && flat(t * w + l, w, b - t)) l++;
    while (r > l + MIN_SIDE && flat(t * w + r - 1, w, b - t)) r--;
    moved = (b - t) * (r - l) !== area;
  }
  return t === 0 && l === 0 && b === h && r === w ? g : crop(g, l, t, r - l, b - t);
}

const WORKING_SIDE = 640; // features come from at most this many pixels on the long side, so a 4K original and a 640 px copy agree
const THUMBNAIL_SIDE = 128;

/** Shrink so that the long side is at most `side` pixels (never enlarge). */
function fit(g: Gray, side: number): Gray {
  const scale = Math.min(1, side / Math.max(g.width, g.height));
  return scale === 1 ? g : resize(g, Math.max(1, Math.round(g.width * scale)), Math.max(1, Math.round(g.height * scale)));
}

/** The image that all features come from: bars trimmed, at most 640 px on the long side. */
export function prepare(g: Gray): Gray {
  return fit(trimBars(g), WORKING_SIDE);
}

/** Gray thumbnail for the aligned comparison: 128 px on the long side, whole gray levels. */
export function thumbnail(g: Gray): Gray {
  const t = fit(g, THUMBNAIL_SIDE);
  return { width: t.width, height: t.height, data: Uint8Array.from(t.data, Math.round) };
}

// ---- hashes ----

export function hashHex(h: Hash): string {
  return h[0].toString(16).padStart(8, '0') + h[1].toString(16).padStart(8, '0');
}

const N = 32;
// COS[u * N + x]: basis of the 32-point DCT-II, only the 8 lowest frequencies
const COS = new Float64Array(8 * N).map((_, i) => Math.cos(((2 * (i % N) + 1) * Math.floor(i / N) * Math.PI) / (2 * N)));

/** pHash of a 32x32 gray matrix (row-major): 8x8 low-frequency DCT block, bit = coefficient > median (DC included, as imagehash). */
export function phash32(m: ArrayLike<number>): Hash {
  // t[u * N + y]: horizontal frequency u of row y
  const t = new Float64Array(8 * N);
  for (let u = 0; u < 8; u++) {
    for (let y = 0; y < N; y++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += COS[u * N + x]! * m[y * N + x]!;
      t[u * N + y] = s;
    }
  }
  // d[v * 8 + u]: vertical frequency v of horizontal frequency u
  const d = new Float64Array(64);
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += COS[v * N + y]! * t[u * N + y]!;
      d[v * 8 + u] = s;
    }
  }
  const sorted = Float64Array.from(d).sort();
  const median = (sorted[31]! + sorted[32]!) / 2;
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < 32; i++) {
    if (d[i]! > median) hi |= 1 << (31 - i);
    if (d[i + 32]! > median) lo |= 1 << (31 - i);
  }
  return [hi >>> 0, lo >>> 0];
}

/** pHash of an image: area resize to 32x32, then `phash32`. */
export function phash(g: Gray): Hash {
  return phash32(resize(g, N, N).data);
}

const MIN_WINDOW = 8; // a narrower window gives an all-zero hash, and such hashes match each other

/**
 * The nine positions of a full-height window, for each of the aspect ratios 9:16 and 9:19.5 (phone wallpapers), of a
 * landscape image. A ratio whose window is narrower than 8 px gives none.
 */
export function windowBoxes(width: number, height: number): { x: number; w: number }[] {
  if (width <= height) return [];
  return [(height * 9) / 16, (height * 18) / 39]
    .map(Math.floor)
    .filter((w) => w >= MIN_WINDOW)
    .flatMap((w) => Array.from({ length: 9 }, (_, i) => ({ x: Math.floor(((width - w) * i) / 8), w })));
}

export function signature(g: Gray): Signature {
  return {
    width: g.width,
    height: g.height,
    phash: phash(g),
    windows: windowBoxes(g.width, g.height).map((b) => phash(crop(g, b.x, 0, b.w, g.height))),
  };
}

/** The query as the gate sees it: identity and mirror (with windows), and four rotations (pHash only). */
export function variants(g: Gray): QueryVariant[] {
  const turned = (name: Variant): QueryVariant => {
    const t = transform(g, name);
    return { name, sig: { width: t.width, height: t.height, phash: phash(t), windows: [] } };
  };
  return [
    { name: 'identity', sig: signature(g) },
    { name: 'mirror', sig: signature(transform(g, 'mirror')) },
    turned('rot90'),
    turned('rot90-mirror'),
    turned('rot270'),
    turned('rot270-mirror'),
  ];
}

// ---- storage format (Redis holds strings, so bytes go as base64) ----

// Signature bytes: width u16, height u16, window count u8, then pHash and windows as 8 bytes each (big-endian).
export function encodeSignature(s: Signature): string {
  const b = Buffer.alloc(5 + 8 * (1 + s.windows.length));
  b.writeUInt16BE(s.width, 0);
  b.writeUInt16BE(s.height, 2);
  b[4] = s.windows.length;
  [s.phash, ...s.windows].forEach(([hi, lo], i) => {
    b.writeUInt32BE(hi, 5 + 8 * i);
    b.writeUInt32BE(lo, 9 + 8 * i);
  });
  return b.toString('base64');
}

export function decodeSignature(text: string): Signature {
  const b = Buffer.from(text, 'base64');
  if (b.length < 13 || b.length !== 5 + 8 * (1 + b[4]!)) throw new Error('bad signature');
  const hash = (i: number): Hash => [b.readUInt32BE(5 + 8 * i), b.readUInt32BE(9 + 8 * i)];
  return {
    width: b.readUInt16BE(0),
    height: b.readUInt16BE(2),
    phash: hash(0),
    windows: Array.from({ length: b[4]! }, (_, i) => hash(i + 1)),
  };
}

// Thumbnail bytes: width u8, height u8, then the gray levels.
export function encodeThumbnail(t: Gray): string {
  return Buffer.concat([Buffer.from([t.width, t.height]), Uint8Array.from(t.data)]).toString('base64');
}

export function decodeThumbnail(text: string): Gray {
  const b = Buffer.from(text, 'base64');
  if (b.length < 2 || b.length !== 2 + b[0]! * b[1]!) throw new Error('bad thumbnail');
  return { width: b[0]!, height: b[1]!, data: new Uint8Array(b.subarray(2)) };
}
