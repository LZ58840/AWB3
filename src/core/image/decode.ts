import { convertIndexedToRgb, decode as decodePng } from 'fast-png';
import { Unzlib } from 'fflate';
import { decode as decodeJpeg } from 'jpeg-js';
import type { Gray } from './features';

/** Decoded pixels, 3 bytes (R, G, B) per pixel, row-major. Alpha is ignored. */
export interface Rgb {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * `too-large`: over a size limit (megapixels, file size, or the size that a PNG may inflate to). `webp`: no pure-JS
 * decoder for lossy WebP. `unsupported`: anything else that is not a decodable JPEG or PNG.
 */
export type RejectReason = 'too-large' | 'webp' | 'unsupported';

export class ImageRejected extends Error {
  constructor(
    readonly reason: RejectReason,
    message: string,
  ) {
    super(message);
    this.name = 'ImageRejected';
  }
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const u16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32 = (b: Uint8Array, i: number) => u16(b, i) * 65536 + u16(b, i + 2);
const text = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** The format and size from the first bytes of the file (JPEG frame header or PNG IHDR), without any decode. */
export function readHeader(b: Uint8Array): { format: 'jpeg' | 'png'; width: number; height: number } {
  if (b.length >= 24 && PNG_SIGNATURE.every((v, i) => b[i] === v) && text(b, 12, 16) === 'IHDR') {
    return { format: 'png', width: u32(b, 16), height: u32(b, 20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 4 <= b.length; ) {
      const marker = b[i + 1]!;
      if (b[i] !== 0xff) break;
      if (marker === 0xff) i++; // fill byte
      else if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) i += 2; // no length
      else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (i + 9 > b.length) break;
        return { format: 'jpeg', width: u16(b, i + 7), height: u16(b, i + 5) };
      } else if (marker === 0xda) break; // the scan starts and there was no frame header
      else i += 2 + u16(b, i + 2);
    }
    throw new ImageRejected('unsupported', 'JPEG without a frame header');
  }
  if (b.length >= 12 && text(b, 0, 4) === 'RIFF' && text(b, 8, 12) === 'WEBP') throw new ImageRejected('webp', 'WebP');
  throw new ImageRejected('unsupported', 'not a JPEG or PNG image');
}

/** The plan's limit (5.4). Measured peak memory of a 16 MP JPEG in Node: about 450 MB (4:2:0) and 730 MB (4:4:4). Raise it only after spike S4. */
const MAX_MEGAPIXELS = 16;

/**
 * The Devvit media upload limit (docs/capabilities/server/media-uploads.mdx): a Reddit image file is not larger, so no real
 * image is rejected. The cap also bounds the work that a hostile file can cost before the first check.
 */
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ICC_BYTES = 1024 * 1024; // what an iCCP profile may inflate to; real profiles are a few KB to a few hundred KB
const SLICE = 16 * 1024; // input per push into the inflater: deflate expands at most 1032 times, so one push gives at most 16 MB
// jpeg-js default; a 16 MP JPEG without chroma subsampling stays under it
const JPEG_MEMORY_MB = 512;

/** Adam7 passes: x start, y start, x step, y step. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;
// The PNG standard: the channels of each color type and the bit depths that it allows
const PNG_FORMATS: Record<number, { channels: number; depths: number[] }> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};
// The standard allows these chunks once, and fast-png does work for each copy: an inflate (iCCP), an alpha value for each
// palette entry (tRNS: 20,000 empty chunks took 340 MB), an array for each entry (PLTE), the last IHDR (it replaces the first).
const PNG_ONCE = ['IHDR', 'PLTE', 'tRNS', 'iCCP'];
const MAX_SCANS = 64; // a progressive JPEG has about 10; jpeg-js has no limit and each scan costs a pass over all blocks

/** Does the zlib data inflate to at most `limit` bytes? It stops at the first slice that goes over. */
function inflatesWithin(parts: Uint8Array[], limit: number): boolean {
  let produced = 0;
  const stream = new Unzlib((chunk) => {
    produced += chunk.length;
  });
  for (const part of parts) {
    for (let i = 0; i < part.length; i += SLICE) {
      stream.push(part.subarray(i, i + SLICE));
      if (produced > limit) return false;
    }
  }
  return true;
}

/**
 * More than 64 byte pairs FF DA (start of scan) in the file? It counts raw bytes and not segments: a wrong segment length hides
 * segments from a walk of the segments, but not from jpeg-js.
 */
function tooManyScans(b: Uint8Array): boolean {
  let scans = 0;
  for (let i = b.indexOf(0xff); i >= 0; i = b.indexOf(0xff, i + 1)) if (b[i + 1] === 0xda && ++scans > MAX_SCANS) return true;
  return false;
}

/**
 * Before fast-png runs: it has no limit on the size that it inflates to, and it uses the last IHDR where readHeader read the
 * first. So the file must have a color type and bit depth that the standard allows (they give the limit below), one each of
 * IHDR, PLTE, tRNS and iCCP, an IDAT stream that inflates to no more than the header says (one filter byte and the packed
 * pixels for each row of each pass), an iCCP profile of at most 1 MiB, and a palette of at most 256 entries.
 */
function checkPng(b: Uint8Array, width: number, height: number): void {
  const format = PNG_FORMATS[b[25]!];
  if (!format?.depths.includes(b[24]!)) throw new ImageRejected('unsupported', `PNG color type ${b[25]} with bit depth ${b[24]}`);
  const bits = format.channels * b[24]!;
  let limit = 0;
  for (const [x0, y0, dx, dy] of b[28] === 1 ? ADAM7 : [[0, 0, 1, 1]]) {
    const [w, h] = [Math.ceil((width - x0!) / dx!), Math.ceil((height - y0!) / dy!)];
    if (w > 0 && h > 0) limit += h * (1 + Math.ceil((w * bits) / 8));
  }
  const idat: Uint8Array[] = [];
  const seen = new Set<string>();
  for (let i = 8; i + 12 <= b.length; ) {
    const length = u32(b, i);
    const type = text(b, i + 4, i + 8);
    const data = b.subarray(i + 8, i + 8 + length);
    if (type === 'IEND') break;
    if (PNG_ONCE.includes(type)) {
      if (seen.has(type)) throw new ImageRejected('unsupported', `second ${type}`);
      seen.add(type);
    }
    if (type === 'PLTE' && length > 3 * 256) throw new ImageRejected('unsupported', 'PLTE over 256 entries'); // fast-png makes an array per entry
    if (type === 'IDAT') idat.push(data);
    // iCCP: keyword, 0, compression method, then the zlib data
    if (type === 'iCCP' && !inflatesWithin([data.subarray(data.indexOf(0) + 2)], MAX_ICC_BYTES)) {
      throw new ImageRejected('too-large', 'iCCP profile over 1 MiB');
    }
    i += 12 + length;
  }
  if (!inflatesWithin(idat, limit)) throw new ImageRejected('too-large', `PNG data inflates to more than ${limit} bytes`);
}

/** Decode a JPEG or PNG. Header checks run first, so a rejected image costs no decode. */
export function decodeRgb(bytes: Uint8Array, maxMegapixels = MAX_MEGAPIXELS): Rgb {
  if (bytes.length > MAX_BYTES) throw new ImageRejected('too-large', `${bytes.length} bytes is over ${MAX_BYTES}`);
  const { format, width, height } = readHeader(bytes);
  if (!width || !height) throw new ImageRejected('unsupported', 'image without pixels');
  if (width * height > maxMegapixels * 1_000_000) {
    throw new ImageRejected('too-large', `${width}x${height} is over ${maxMegapixels} megapixels`);
  }
  if (format === 'jpeg') {
    if (tooManyScans(bytes)) throw new ImageRejected('too-large', `JPEG with more than ${MAX_SCANS} scans`);
    // jpeg-js can read another frame header than readHeader, so it gets the same limit and checks its own header
    try {
      const jpeg = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: false, maxResolutionInMP: maxMegapixels, maxMemoryUsageInMB: JPEG_MEMORY_MB });
      return { width: jpeg.width, height: jpeg.height, data: jpeg.data };
    } catch (e) {
      if (e instanceof Error && /^max(ResolutionInMP|MemoryUsageInMB) limit exceeded/.test(e.message)) throw new ImageRejected('too-large', e.message);
      throw e;
    }
  }
  checkPng(bytes, width, height);
  const png = decodePng(bytes);
  if (!png.palette && png.depth < 8) throw new ImageRejected('unsupported', `${png.depth} bit gray PNG`);
  const data = png.palette ? convertIndexedToRgb(png) : png.data;
  const channels = png.palette ? png.palette[0]!.length : png.channels;
  const shift = png.depth === 16 ? 8 : 0; // 16 bit: keep the high byte
  const out = new Uint8Array(png.width * png.height * 3);
  for (let i = 0, p = 0; i < out.length; i += 3, p += channels) {
    const color = channels < 3; // gray or gray + alpha
    out[i] = data[p]! >> shift;
    out[i + 1] = data[color ? p : p + 1]! >> shift;
    out[i + 2] = data[color ? p : p + 2]! >> shift;
  }
  return { width: png.width, height: png.height, data: out };
}

/** Gray = ITU-R 601 luma, rounded, the same formula as Pillow `convert('L')`. */
export function decodeGray(bytes: Uint8Array, maxMegapixels = MAX_MEGAPIXELS): Gray {
  const { width, height, data } = decodeRgb(bytes, maxMegapixels);
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 3) {
    gray[i] = (data[p]! * 19595 + data[p + 1]! * 38470 + data[p + 2]! * 7471 + 32768) >> 16;
  }
  return { width, height, data: gray };
}
