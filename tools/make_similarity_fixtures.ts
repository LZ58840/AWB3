/**
 * One-off generator of the image fixtures in test/fixtures/images/ (plan 7.4 and 7.6): base images at 640 px, the
 * synthetic pairs T1-T6 and the edit set. The labels of the pairs come from how they are built (see
 * test/image/cascade.test.ts), not from the matcher.
 *
 * Run:  npx tsx tools/make_similarity_fixtures.ts <dir>
 * <dir> holds the five public-domain or CC0 images of SOURCES (Wikimedia Commons), each saved under its file name as the
 * 1920 px rendition: https://commons.wikimedia.org/wiki/Special:FilePath/<file>?width=1920
 * The output is deterministic. Commit the result; do not run this tool again unless a recipe changes.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode as encodePng } from 'fast-png';
import { encode as encodeJpeg } from 'jpeg-js';
import { decodeRgb, type Rgb } from '../src/core/image/decode';
import { resize } from '../src/core/image/features';

// Licenses as the Commons file pages state them (checked 2026-11-07): Cc-zero is CC0; PD-algorithm is "public domain: made by a
// computer algorithm, no human author".
const SOURCES = {
  valley: { file: 'Scenic_Valley_in_the_Afternoon_(SD1.5).jpg', author: 'VulcanSphere', license: 'CC0 (Cc-zero) and public domain (PD-algorithm)' },
  shrineA: {
    file: 'Algorithmically-generated_landscape_artwork_of_forest_with_Shinto_shrine.png',
    author: 'Benlisquare',
    license: 'Public domain (PD-algorithm)',
  },
  shrineB: {
    file: 'Algorithmically-generated_landscape_artwork_of_forest_with_Shinto_shrine_using_negative_prompt_for_round_stones.png',
    author: 'Benlisquare',
    license: 'Public domain (PD-algorithm)',
  },
  charX: { file: 'Red_suit_anime_girl.png', author: 'jsks', license: 'CC0 (Cc-zero)' },
  charY: { file: 'Red_suit_anime_girl_temple.png', author: 'jsks', license: 'CC0 (Cc-zero)' },
};
type SourceId = keyof typeof SOURCES;

const W = 640;
const H = 360;
const outDir = join(import.meta.dirname, '../test/fixtures/images');
const srcDir = process.argv[2];
if (!srcDir) throw new Error('usage: npx tsx tools/make_similarity_fixtures.ts <dir with the source images>');

// ---- image operations (RGB, 3 bytes per pixel) ----

const load = (id: SourceId): Rgb => decodeRgb(new Uint8Array(readFileSync(join(srcDir, SOURCES[id].file))));

function crop(img: Rgb, x: number, y: number, w: number, h: number): Rgb {
  const data = new Uint8Array(w * h * 3);
  for (let r = 0; r < h; r++) data.set(img.data.subarray(((y + r) * img.width + x) * 3, ((y + r) * img.width + x + w) * 3), r * w * 3);
  return { width: w, height: h, data };
}

/** Area average: shrinks, and repeats pixels when it enlarges. */
function area(img: Rgb, w: number, h: number): Rgb {
  const data = new Uint8Array(w * h * 3);
  for (let c = 0; c < 3; c++) {
    const plane = new Uint8Array(img.width * img.height);
    for (let i = 0; i < plane.length; i++) plane[i] = img.data[i * 3 + c]!;
    const small = resize({ width: img.width, height: img.height, data: plane }, w, h).data;
    for (let i = 0; i < small.length; i++) data[i * 3 + c] = Math.round(small[i]!);
  }
  return { width: w, height: h, data };
}

/** Smooth enlargement (a stand-in for an AI or Lanczos upscaler). */
function bilinear(img: Rgb, w: number, h: number): Rgb {
  const data = new Uint8Array(w * h * 3);
  const px = (x: number, y: number, c: number) =>
    img.data[(Math.min(Math.max(y, 0), img.height - 1) * img.width + Math.min(Math.max(x, 0), img.width - 1)) * 3 + c]!;
  for (let y = 0; y < h; y++) {
    const sy = ((y + 0.5) * img.height) / h - 0.5;
    const y0 = Math.floor(sy);
    for (let x = 0; x < w; x++) {
      const sx = ((x + 0.5) * img.width) / w - 0.5;
      const x0 = Math.floor(sx);
      for (let c = 0; c < 3; c++) {
        const top = px(x0, y0, c) * (1 - (sx - x0)) + px(x0 + 1, y0, c) * (sx - x0);
        const bottom = px(x0, y0 + 1, c) * (1 - (sx - x0)) + px(x0 + 1, y0 + 1, c) * (sx - x0);
        data[(y * w + x) * 3 + c] = Math.round(top * (1 - (sy - y0)) + bottom * (sy - y0));
      }
    }
  }
  return { width: w, height: h, data };
}

function mirror(img: Rgb): Rgb {
  const data = new Uint8Array(img.data.length);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) data.set(img.data.subarray((y * img.width + x) * 3, (y * img.width + x) * 3 + 3), (y * img.width + img.width - 1 - x) * 3);
  }
  return { ...img, data };
}

/** A turn by 90 degrees counter-clockwise (as np.rot90). */
function rotate90(img: Rgb): Rgb {
  const { width: w, height: h } = img;
  const data = new Uint8Array(img.data.length);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < h; x++) data.set(img.data.subarray((x * w + (w - 1 - y)) * 3, (x * w + (w - 1 - y)) * 3 + 3), (y * h + x) * 3);
  }
  return { width: h, height: w, data };
}

/** Black bars, the image centered. */
function letterbox(img: Rgb, w: number, h: number): Rgb {
  const data = new Uint8Array(w * h * 3);
  const x = Math.floor((w - img.width) / 2);
  const y = Math.floor((h - img.height) / 2);
  for (let r = 0; r < img.height; r++) data.set(img.data.subarray(r * img.width * 3, (r + 1) * img.width * 3), ((y + r) * w + x) * 3);
  return { width: w, height: h, data };
}

const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));

/** Brightness factor, then contrast factor around the mean gray (as Pillow ImageEnhance). */
function brightnessContrast(img: Rgb, brightness: number, contrast: number): Rgb {
  const bright = Array.from(img.data, (v) => v * brightness);
  let mean = 0;
  for (let i = 0; i < bright.length; i += 3) mean += 0.299 * bright[i]! + 0.587 * bright[i + 1]! + 0.114 * bright[i + 2]!;
  mean /= bright.length / 3;
  return { ...img, data: Uint8Array.from(bright, (v) => clamp(mean + (v - mean) * contrast)) };
}

/** Hue rotation (the SVG feColorMatrix hueRotate matrix). */
function hue(img: Rgb, degrees: number): Rgb {
  const cos = Math.cos((degrees * Math.PI) / 180);
  const sin = Math.sin((degrees * Math.PI) / 180);
  const m = [
    [0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928],
    [0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283],
    [0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072],
  ];
  const data = new Uint8Array(img.data.length);
  for (let i = 0; i < data.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      data[i + c] = clamp(m[c]![0]! * img.data[i]! + m[c]![1]! * img.data[i + 1]! + m[c]![2]! * img.data[i + 2]!);
    }
  }
  return { ...img, data };
}

// 5x7 glyphs of "@artist": one byte per row, bit 4 is the left column
const GLYPHS: Record<string, number[]> = {
  '@': [0x0e, 0x11, 0x17, 0x15, 0x17, 0x10, 0x0e],
  a: [0x00, 0x00, 0x0e, 0x01, 0x0f, 0x11, 0x0f],
  r: [0x00, 0x00, 0x16, 0x19, 0x10, 0x10, 0x10],
  t: [0x08, 0x08, 0x1e, 0x08, 0x08, 0x09, 0x06],
  i: [0x04, 0x00, 0x0c, 0x04, 0x04, 0x04, 0x0e],
  s: [0x00, 0x00, 0x0f, 0x10, 0x0e, 0x01, 0x1e],
};

/** A watermark: dark box (alpha 0.5) with white text, bottom right, 120x38 px = 2% of 640x360. */
function watermark(img: Rgb): Rgb {
  const data = Uint8Array.from(img.data);
  const blend = (x: number, y: number, value: number, alpha: number) => {
    for (let c = 0; c < 3; c++) data[(y * img.width + x) * 3 + c] = clamp(data[(y * img.width + x) * 3 + c]! * (1 - alpha) + value * alpha);
  };
  const [x0, y0, w, h] = [img.width - 132, img.height - 48, 120, 38] as const;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) blend(x, y, 0, 0.5);
  [...'@artist'].forEach((ch, n) => {
    GLYPHS[ch]!.forEach((row, r) => {
      for (let bit = 0; bit < 5; bit++) {
        if (!(row & (0x10 >> bit))) continue;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) blend(x0 + 18 + n * 12 + bit * 2 + dx, y0 + 12 + r * 2 + dy, 255, 0.9);
      }
    });
  });
  return { ...img, data };
}

// ---- characters (ellipse cut-outs) ----

interface Ellipse {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An ellipse at the bottom center that covers `fraction` of the 640x360 image. */
function ellipseOf(fraction: number): Ellipse {
  const h = Math.min(H, Math.floor(H * Math.sqrt(fraction * 1.9)));
  const w = Math.floor((fraction * W * H) / (h * 0.785));
  return { x: Math.floor((W - w) / 2), y: H - h, w, h };
}

const inside = (e: Ellipse, x: number, y: number) =>
  ((x + 0.5 - e.x - e.w / 2) / (e.w / 2)) ** 2 + ((y + 0.5 - e.y - e.h / 2) / (e.h / 2)) ** 2 <= 1;

/** Another image, squeezed into the ellipse, pasted on the background. */
function character(background: Rgb, source: Rgb, e: Ellipse): Rgb {
  const patch = area(source, e.w, e.h);
  const data = Uint8Array.from(background.data);
  for (let y = 0; y < e.h; y++) {
    for (let x = 0; x < e.w; x++) {
      if (inside(e, e.x + x, e.y + y)) data.set(patch.data.subarray((y * e.w + x) * 3, (y * e.w + x) * 3 + 3), ((e.y + y) * W + e.x + x) * 3);
    }
  }
  return { ...background, data };
}

/** Size of the largest 4-connected group of 8x8-grid tiles that the ellipse covers by at least half (geometry only). */
function coveredBlock(e: Ellipse): number {
  const covered: boolean[] = [];
  for (let t = 0; t < 64; t++) {
    const [x0, y0] = [(t % 8) * (W / 8), Math.floor(t / 8) * (H / 8)];
    let n = 0;
    for (let y = y0; y < y0 + H / 8; y++) for (let x = x0; x < x0 + W / 8; x++) n += inside(e, x, y) ? 1 : 0;
    covered.push(n >= (W / 8) * (H / 8) * 0.5);
  }
  const seen = new Set<number>();
  let best = 0;
  covered.forEach((on, start) => {
    if (!on || seen.has(start)) return;
    const stack = [start];
    seen.add(start);
    let size = 0;
    while (stack.length) {
      const t = stack.pop()!;
      size++;
      for (const n of [t - 8, t + 8, t % 8 ? t - 1 : -1, t % 8 < 7 ? t + 1 : -1]) {
        if (n >= 0 && n < 64 && covered[n] && !seen.has(n)) (seen.add(n), stack.push(n));
      }
    }
    best = Math.max(best, size);
  });
  return best;
}

// ---- output ----

const rgba = (img: Rgb) => {
  const out = new Uint8Array(img.width * img.height * 4).fill(255);
  for (let i = 0; i < img.width * img.height; i++) out.set(img.data.subarray(i * 3, i * 3 + 3), i * 4);
  return out;
};
const jpeg = (img: Rgb, quality: number): Uint8Array => encodeJpeg({ data: rgba(img), width: img.width, height: img.height }, quality).data;

const written: Record<string, { bytes: number; from: SourceId[] }> = {};
function save(name: string, bytes: Uint8Array, from: SourceId[]) {
  writeFileSync(join(outDir, name), bytes);
  written[name] = { bytes: bytes.length, from };
}

/** The largest 16:9 area in the middle of the image, at 640x360. */
function base(id: SourceId): Rgb {
  const src = load(id);
  const w = Math.min(src.width, Math.floor((src.height * 16) / 9));
  const h = Math.min(src.height, Math.floor((src.width * 9) / 16));
  return area(crop(src, Math.floor((src.width - w) / 2), Math.floor((src.height - h) / 2), w, h), W, H);
}

mkdirSync(outDir, { recursive: true });

const valley = base('valley');
const shrineA = base('shrineA');
save('base-valley.jpg', jpeg(valley, 85), ['valley']);
save('base-shrine-a.jpg', jpeg(shrineA, 85), ['shrineA']);
save('base-shrine-b.jpg', jpeg(base('shrineB'), 85), ['shrineB']); // T5: another image, same palette

// T1: same background, different character, 15% of the area
const big = ellipseOf(0.15);
if (coveredBlock(big) < 4) throw new Error('T1: the character must cover a block of at least 4 tiles');
save('t1-a.jpg', jpeg(character(shrineA, load('charX'), big), 90), ['shrineA', 'charX']);
save('t1-b.jpg', jpeg(character(shrineA, load('charY'), big), 90), ['shrineA', 'charY']);

// T1b: the same with an 8% character. The cascade test shows that only stage 3 (the block of changed tiles) rejects this pair:
// the character covers a block of at least 4 tiles, but it is small enough for NCC and for the share of matching tiles to pass.
const middle = ellipseOf(0.08);
if (coveredBlock(middle) < 4) throw new Error('T1b: the character must cover a block of at least 4 tiles');
save('t1b-a.jpg', jpeg(character(shrineA, load('charX'), middle), 90), ['shrineA', 'charX']);
save('t1b-b.jpg', jpeg(character(shrineA, load('charY'), middle), 90), ['shrineA', 'charY']);

// T6: same background, different character, 5% of the area; it must cover at least 2 tiles, so a removal is wrong
const small = ellipseOf(0.05);
if (coveredBlock(small) < 2) throw new Error('T6: the character must cover at least 2 tiles');
save('t6-a.jpg', jpeg(character(shrineA, load('charX'), small), 90), ['shrineA', 'charX']);
save('t6-b.jpg', jpeg(character(shrineA, load('charY'), small), 90), ['shrineA', 'charY']);

// T2: watermark, recompressed
save('t2-watermark.jpg', jpeg(watermark(valley), 75), ['valley']);

// T3: phone crop 9:19.5 at x = 30% of the width, cut from the 16:9 original and scaled to 640 px high
const wide = (() => {
  const src = load('valley');
  const h = Math.min(src.height, Math.floor((src.width * 9) / 16));
  return crop(src, 0, Math.floor((src.height - h) / 2), src.width, h);
})();
const phoneW = Math.floor((wide.height * 9) / 19.5);
save('t3-phone.jpg', jpeg(area(crop(wide, Math.floor(wide.width * 0.3), 0, phoneW, wide.height), Math.round((phoneW * 640) / wide.height), 640), 85), ['valley']);

// T4: mirror + 2x upscale + 4% crop at the left and top + letterbox to 4:3
const upscaled = mirror(bilinear(area(valley, W / 2, H / 2), W, H));
const cropped = crop(upscaled, Math.round(W * 0.04), Math.round(H * 0.04), W - Math.round(W * 0.04), H - Math.round(H * 0.04));
save('t4-mirror-up-crop-letterbox.jpg', jpeg(letterbox(cropped, cropped.width, Math.round((cropped.width * 3) / 4)), 85), ['valley']);

// edit set, all from the valley image
save('edit-recompress.jpg', jpeg(valley, 60), ['valley']);
save('edit-resize.png', encodePng({ width: W / 2, height: H / 2, data: area(valley, W / 2, H / 2).data, channels: 3, depth: 8 }), ['valley']);
save('edit-brightness.jpg', jpeg(brightnessContrast(valley, 1.15, 0.85), 85), ['valley']);
save('edit-hue.jpg', jpeg(hue(valley, 17), 85), ['valley']);
save('edit-crop5.jpg', jpeg(crop(valley, 32, 18, W - 32, H - 18), 85), ['valley']);
save('edit-crop15.jpg', jpeg(crop(valley, 50, 27, 560, 306), 85), ['valley']);
save('edit-rotate90.jpg', jpeg(rotate90(valley), 85), ['valley']); // portrait: the rotated repost

const used = new Set(Object.values(written).flatMap((w) => w.from));
writeFileSync(
  join(outDir, 'sources.json'),
  JSON.stringify(
    {
      note: 'Every image here is made from the Wikimedia Commons originals below (public domain or CC0), by tools/make_similarity_fixtures.ts.',
      sources: Object.fromEntries(
        [...used].map((id) => [id, { ...SOURCES[id], page: `https://commons.wikimedia.org/wiki/File:${SOURCES[id].file}` }]),
      ),
      fixtures: Object.fromEntries(Object.entries(written).map(([name, w]) => [name, w.from])),
    },
    null,
    2,
  ) + '\n',
);

let total = 0;
for (const [name, w] of Object.entries(written)) {
  total += w.bytes;
  console.log(name.padEnd(36), String(w.bytes).padStart(8));
}
console.log('total'.padEnd(36), String(total).padStart(8));
