import { describe, expect, it } from 'vitest';
import {
  decodeSignature,
  decodeThumbnail,
  encodeSignature,
  encodeThumbnail,
  type Gray,
  hashHex,
  phash,
  prepare,
  resize,
  type Signature,
  signature,
  thumbnail,
  transform,
  trimBars,
  variants,
  windowBoxes,
} from '../../src/core/image/features';
import { textured } from './helpers';

const gray = (width: number, height: number, data: number[]): Gray => ({ width, height, data: Float32Array.from(data) });

describe('resize: each output pixel is the mean of the source area it covers', () => {
  // expected values are computed by hand
  it('averages whole blocks (4x4 to 2x2)', () => {
    const g = gray(4, 4, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const r = resize(g, 2, 2);
    expect([r.width, r.height]).toEqual([2, 2]);
    expect(Array.from(r.data)).toEqual([3.5, 5.5, 11.5, 13.5]);
  });

  it('weights partly covered pixels (3x1 to 2x1: each output covers 1.5 pixels)', () => {
    const r = resize(gray(3, 1, [0, 30, 60]), 2, 1);
    expect(Array.from(r.data)).toEqual([10, 50]); // (0*1 + 30*0.5)/1.5 and (30*0.5 + 60*1)/1.5
  });

  it('weights partly covered pixels on both axes (3x3 to 2x2)', () => {
    const r = resize(gray(3, 3, [0, 30, 60, 90, 120, 150, 180, 210, 240]), 2, 2);
    expect(Array.from(r.data).map((v) => Math.round(v * 1e4) / 1e4)).toEqual([40, 80, 160, 200]);
  });

  it('repeats pixels when it enlarges by a whole factor (2x1 to 4x1)', () => {
    expect(Array.from(resize(gray(2, 1, [10, 20]), 4, 1).data)).toEqual([10, 10, 20, 20]);
  });
});

describe('trimBars: remove uniform edge rows and columns', () => {
  // Content with a large spread in every row and column; bars are built around it.
  const content = (w: number, h: number) => Array.from({ length: w * h }, (_, i) => 20 + ((i * 97) % 200));
  function framed(w: number, h: number, bar: { top?: number; bottom?: number; left?: number; right?: number }, value = 0) {
    const [top, bottom, left, right] = [bar.top ?? 0, bar.bottom ?? 0, bar.left ?? 0, bar.right ?? 0];
    const c = content(w, h);
    const [fw, fh] = [left + w + right, top + h + bottom];
    const data = new Array<number>(fw * fh).fill(value);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[(top + y) * fw + left + x] = c[y * w + x]!;
    return { image: gray(fw, fh, data), content: c };
  }

  it('removes bars on all four sides and keeps the content exactly', () => {
    const { image, content: c } = framed(20, 12, { top: 5, bottom: 3, left: 4, right: 6 });
    const t = trimBars(image);
    expect([t.width, t.height]).toEqual([20, 12]);
    expect(Array.from(t.data)).toEqual(c);
  });

  it('leaves an image without bars as it is', () => {
    const { image } = framed(20, 12, {});
    expect([trimBars(image).width, trimBars(image).height]).toEqual([20, 12]);
  });

  it('treats a row as a bar while max - min is at most 12 gray levels', () => {
    // top bar rows alternate between 100 and 100 + spread
    const top = (spread: number) => {
      const { image } = framed(20, 12, { top: 4 });
      for (let y = 0; y < 4; y++) for (let x = 0; x < 20; x++) image.data[y * 20 + x] = x % 2 ? 100 + spread : 100;
      return trimBars(image).height;
    };
    expect(top(12)).toBe(12); // a spread of 12 is a bar
    expect(top(13)).toBe(16); // a spread of 13 is content
  });

  it.each(['top', 'bottom'] as const)('trims a flat %s band that side bars hide in the first pass, as it does without the side bars', (side) => {
    // picture: 36 columns, a flat band of 10 rows (white) at the top or bottom, 54 rows of content
    const [w, h, band, bar] = [36, 64, 10, 10];
    const content = (x: number, y: number) => 20 + (((y * w + x) * 97) % 200);
    const bandRows = (y: number) => (side === 'top' ? y < band : y >= h - band);
    const picture = (x: number, y: number) => (bandRows(y) ? 250 : content(x, y));
    const plain = gray(w, h, Array.from({ length: w * h }, (_, i) => picture(i % w, (i / w) | 0)));
    const pillarbox = gray(w + 2 * bar, h, Array.from({ length: (w + 2 * bar) * h }, (_, i) => {
      const x = (i % (w + 2 * bar)) - bar;
      return x < 0 || x >= w ? 0 : picture(x, (i / (w + 2 * bar)) | 0);
    }));
    const [a, b] = [trimBars(plain), trimBars(pillarbox)];
    expect([a.width, a.height]).toEqual([36, 54]);
    expect([b.width, b.height]).toEqual([36, 54]);
    expect(Array.from(b.data)).toEqual(Array.from(a.data));
  });

  it('keeps at least 8 rows and 8 columns of a blank image', () => {
    const t = trimBars(gray(40, 30, new Array<number>(1200).fill(0)));
    expect([t.width, t.height]).toEqual([8, 8]);
  });
});

describe('transform: mirror and 90 degree rotations', () => {
  // expected values follow numpy: mirror = fliplr, rot90 = counter-clockwise np.rot90(m, 1), rot270 = np.rot90(m, 3)
  const g = gray(3, 2, [1, 2, 3, 4, 5, 6]); // rows [1 2 3] and [4 5 6]
  it.each([
    ['identity', 3, 2, [1, 2, 3, 4, 5, 6]],
    ['mirror', 3, 2, [3, 2, 1, 6, 5, 4]],
    ['rot90', 2, 3, [3, 6, 2, 5, 1, 4]],
    ['rot90-mirror', 2, 3, [6, 3, 5, 2, 4, 1]],
    ['rot270', 2, 3, [4, 1, 5, 2, 6, 3]],
    ['rot270-mirror', 2, 3, [1, 4, 2, 5, 3, 6]],
  ] as const)('%s', (name, width, height, data) => {
    const t = transform(g, name);
    expect([t.width, t.height]).toEqual([width, height]);
    expect(Array.from(t.data)).toEqual(data);
  });
});

describe('windowBoxes: the nine positions of a full-height 9:16 and 9:19.5 window', () => {
  it('lists 18 boxes for a 640x360 image (computed by hand: x = floor((width - w) * i / 8))', () => {
    // w = floor(360 * 9 / 16) = 202 and floor(360 * 9 / 19.5) = 166
    expect(windowBoxes(640, 360)).toEqual([
      ...[0, 54, 109, 164, 219, 273, 328, 383, 438].map((x) => ({ x, w: 202 })),
      ...[0, 59, 118, 177, 237, 296, 355, 414, 474].map((x) => ({ x, w: 166 })),
    ]);
  });

  it('lists no box for a portrait or square image', () => {
    expect(windowBoxes(360, 640)).toEqual([]);
    expect(windowBoxes(500, 500)).toEqual([]);
  });

  it('drops a window that is narrower than 8 px (heights 14 to 18: 9:16 gives 7, 8, 9, 9 and 10 px, 9:19.5 gives 6, 6, 7, 7 and 8 px)', () => {
    expect(windowBoxes(100, 14)).toEqual([]);
    expect(windowBoxes(100, 15).map((b) => b.w)).toEqual(new Array<number>(9).fill(8));
    expect(windowBoxes(100, 16).map((b) => b.w)).toEqual(new Array<number>(9).fill(9));
    expect(windowBoxes(100, 17).map((b) => b.w)).toEqual(new Array<number>(9).fill(9));
    expect(windowBoxes(100, 18).map((b) => b.w)).toEqual([...new Array<number>(9).fill(10), ...new Array<number>(9).fill(8)]);
  });

  it('gives no all-zero window hash for a tiny image (such hashes would match each other)', () => {
    for (const [w, h] of [[2, 1], [3, 2], [20, 10], [640, 2], [100, 14]] as const) {
      for (const hash of signature(textured(w, h)).windows) expect(hashHex(hash)).not.toBe('0000000000000000');
    }
  });
});

describe('thumbnail: 128 px on the long side', () => {
  const blank = (width: number, height: number, value = 0): Gray => ({ width, height, data: new Uint8Array(width * height).fill(value) });

  it.each([
    [640, 360, 128, 72],
    [360, 640, 72, 128],
    [1920, 1080, 128, 72],
    [640, 640, 128, 128],
    [1000, 333, 128, 43], // 333 * 0.128 = 42.6
    [100, 60, 100, 60], // never enlarged
  ])('%i x %i gives %i x %i', (w, h, tw, th) => {
    const t = thumbnail(blank(w, h));
    expect([t.width, t.height]).toEqual([tw, th]);
  });

  it('rounds to the nearest gray level (a mean of 10.75 is 11, a mean of 10.25 is 10)', () => {
    // 256x256 in blocks of 2x2: the left half has [10 11; 11 11] (mean 10.75), the right half [10 10; 10 11] (mean 10.25)
    const data = new Uint8Array(256 * 256);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) data[y * 256 + x] = x % 2 === 0 && y % 2 === 0 ? 10 : x < 128 || (x % 2 && y % 2) ? 11 : 10;
    const t = thumbnail({ width: 256, height: 256, data });
    expect([t.width, t.height]).toEqual([128, 128]);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) expect(t.data[y * 128 + x]).toBe(x < 64 ? 11 : 10);
  });

  it('holds whole gray levels (it is stored as bytes)', () => {
    const t = thumbnail(blank(640, 360, 200));
    expect(t.data).toBeInstanceOf(Uint8Array);
    expect(new Set(t.data)).toEqual(new Set([200]));
  });
});

describe('prepare: trim bars, then at most 640 px on the long side', () => {
  const blank = (width: number, height: number): Gray => ({ width, height, data: new Uint8Array(width * height).map((_, i) => (i * 97) % 251) });

  it('scales a 4K image to 640x360', () => {
    const p = prepare(blank(3840, 2160));
    expect([p.width, p.height]).toEqual([640, 360]);
  });

  it('keeps a smaller image as it is', () => {
    const g = blank(400, 300);
    expect(prepare(g)).toBe(g);
  });

  it('trims the bars first: a 4:3 frame with 180 px bars on top and bottom is a 16:9 image', () => {
    const framed = blank(1920, 1440);
    framed.data.fill(0, 0, 180 * 1920);
    framed.data.fill(0, 1260 * 1920);
    const p = prepare(framed);
    expect([p.width, p.height]).toEqual([640, 360]);
  });
});

describe('signature and thumbnail encoding', () => {
  it('round-trips the signature of a landscape image (pHash and 18 windows)', () => {
    const s = signature(textured(640, 360));
    expect(s.windows).toHaveLength(18);
    expect(decodeSignature(encodeSignature(s))).toEqual(s);
  });

  it('round-trips the signature of a portrait image (no windows)', () => {
    const s = signature(textured(360, 640));
    expect(s.windows).toHaveLength(0);
    expect(decodeSignature(encodeSignature(s))).toEqual(s);
  });

  // Format pin: these strings are stored in Redis, so the bytes must not change. Expected values are written by hand.
  it('writes a signature as width u16, height u16, window count u8, pHash and windows (8 bytes each), big-endian, in base64', () => {
    const landscape: Signature = { width: 640, height: 360, phash: [0x01234567, 0x89abcdef], windows: [[0xffffffff, 0], [0xdeadbeef, 0x01020304]] };
    // 0280 0168 02 | 0123456789abcdef | ffffffff00000000 | deadbeef01020304
    expect(encodeSignature(landscape)).toBe('AoABaAIBI0VniavN7/////8AAAAA3q2+7wECAwQ=');
    expect(decodeSignature('AoABaAIBI0VniavN7/////8AAAAA3q2+7wECAwQ=')).toEqual(landscape);
    const portrait: Signature = { width: 360, height: 640, phash: [0x80000000, 1], windows: [] }; // 0168 0280 00 | 8000000000000001
    expect(encodeSignature(portrait)).toBe('AWgCgACAAAAAAAAAAQ==');
    expect(decodeSignature('AWgCgACAAAAAAAAAAQ==')).toEqual(portrait);
  });

  it('writes a thumbnail as width u8, height u8 and the gray levels, in base64', () => {
    const t = { width: 3, height: 2, data: Uint8Array.from([0, 1, 2, 254, 255, 128]) }; // 03 02 | 00 01 02 fe ff 80
    expect(encodeThumbnail(t)).toBe('AwIAAQL+/4A=');
    const back = decodeThumbnail('AwIAAQL+/4A=');
    expect([back.width, back.height, Array.from(back.data)]).toEqual([3, 2, [0, 1, 2, 254, 255, 128]]);
  });

  it('stays within the 170 bytes that the plan budgets for one signature', () => {
    expect(Buffer.from(encodeSignature(signature(textured(640, 360))), 'base64').length).toBeLessThanOrEqual(170);
  });

  it('rejects a signature that is cut short or has extra bytes', () => {
    const text = encodeSignature(signature(textured(640, 360)));
    const longer = Buffer.concat([Buffer.from(text, 'base64'), Buffer.from([0, 0, 0])]).toString('base64');
    expect(() => decodeSignature(text.slice(0, 100))).toThrow('bad signature');
    expect(() => decodeSignature(longer)).toThrow('bad signature');
    expect(() => decodeSignature('')).toThrow('bad signature');
  });

  it('round-trips a thumbnail: same size, same bytes', () => {
    const t = thumbnail(textured(640, 360));
    const back = decodeThumbnail(encodeThumbnail(t));
    expect([back.width, back.height]).toEqual([128, 72]);
    expect(Array.from(back.data)).toEqual(Array.from(t.data));
  });

  it('stores a 128x72 thumbnail in about 12 KB of text', () => {
    expect(encodeThumbnail(thumbnail(textured(640, 360))).length).toBeLessThanOrEqual(12_400);
  });

  it('rejects a thumbnail whose size does not match its bytes', () => {
    const header128x72 = (extra: number) => Buffer.from([128, 72, ...new Array<number>(extra).fill(7)]).toString('base64');
    expect(decodeThumbnail(header128x72(128 * 72)).data).toHaveLength(128 * 72); // control: a complete thumbnail
    expect(() => decodeThumbnail(header128x72(10))).toThrow('bad thumbnail');
    expect(() => decodeThumbnail(header128x72(128 * 72 + 1))).toThrow('bad thumbnail');
    expect(() => decodeThumbnail('')).toThrow('bad thumbnail');
  });
});

describe('variants: the query signatures for the gate', () => {
  it('lists identity, mirror and the four rotations, in this order', () => {
    expect(variants(textured(64, 36)).map((v) => v.name)).toEqual(['identity', 'mirror', 'rot90', 'rot90-mirror', 'rot270', 'rot270-mirror']);
  });

  it('takes identity and mirror with their windows, and the rotations with the pHash only', () => {
    const g = textured(640, 360);
    const [identity, mirror, ...rotations] = variants(g);
    expect(identity!.sig).toEqual(signature(g));
    expect(mirror!.sig).toEqual(signature(transform(g, 'mirror')));
    expect(mirror!.sig.windows).toHaveLength(18);
    for (const r of rotations) {
      expect([r.sig.width, r.sig.height]).toEqual([360, 640]); // a landscape image turned by 90 degrees is portrait
      expect(r.sig.windows).toHaveLength(0);
      expect(r.sig.phash).toEqual(phash(transform(g, r.name)));
    }
  });
});
