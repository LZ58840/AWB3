// Fake image host: URL -> bytes, with fault modes. Replaces fetch for the test (without a spy, the harness fetch throws).
import { crc32 } from 'node:zlib';
import { onTestFinished, vi } from 'vitest';

/** The hosts that plan 5.7 asks Reddit to approve for fetch. */
const HOSTS = new Set(['i.redd.it', 'preview.redd.it']);
const HUGE = 20_000; // 400 megapixels, far over the 16 megapixel guard of plan 5.4

export type Fault = 'notFound' | 'timeout' | 'webp' | 'huge' | 'badLength';

const u16 = (n: number) => Buffer.from([n >> 8, n & 255]);
const u32 = (n: number) => Buffer.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
};

/** A PNG with only the signature, IHDR and IEND chunks: the header declares the size, there are no pixels. */
const hugePng = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.concat([u32(HUGE), u32(HUGE), Buffer.from([8, 2, 0, 0, 0])])),
    chunk('IEND', Buffer.alloc(0)),
  ]);

/** A JPEG with only SOI, a baseline SOF0 with three components, and EOI. */
const hugeJpeg = () =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8]), u16(HUGE), u16(HUGE), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9])]);

const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([12, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.from([0, 0, 0, 0])]);

const typeOf = (bytes: Uint8Array) =>
  bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : bytes[8] === 0x57 ? 'image/webp' : 'application/octet-stream';

export function createCdn() {
  const files = new Map<string, Uint8Array>();
  const faults = new Map<string, Fault>();
  const requests: { url: string; accept: string }[] = [];
  const key = (url: string) => new URL(url).href;

  const respond = (status: number, body: Uint8Array | string, headers: Record<string, string> = {}) => new Response(body as BodyInit, { status, headers }); // Uint8Array<ArrayBufferLike> is not a BodyInit in the newer lib types

  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({ url: request.url, accept: request.headers.get('accept') ?? '*/*' });
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname)) throw new TypeError(`fetch failed: ${request.url} is not an allowed domain`);
    const bytes = files.get(request.url);
    switch (faults.get(request.url)) {
      case 'timeout':
        throw new Error('context deadline exceeded');
      case 'webp':
        return respond(200, WEBP, { 'content-type': 'image/webp', 'content-length': String(WEBP.length) });
      case 'huge': {
        const header = /\.jpe?g$/.test(url.pathname) ? hugeJpeg() : hugePng();
        return respond(200, header, { 'content-type': typeOf(header), 'content-length': String(header.length) });
      }
      case 'badLength':
        return respond(200, bytes!, { 'content-type': typeOf(bytes!), 'content-length': String(bytes!.length + 1000) });
      case 'notFound':
        return respond(404, 'not found');
      default:
        return bytes ? respond(200, bytes, { 'content-type': typeOf(bytes), 'content-length': String(bytes.length) }) : respond(404, 'not found');
    }
  });
  onTestFinished(() => spy.mockRestore());

  return {
    requests,
    serve(url: string, bytes: Uint8Array) {
      files.set(key(url), bytes);
      faults.delete(key(url));
    },
    /** `badLength` needs the bytes of a served URL. */
    fail(url: string, fault: Fault) {
      if (fault === 'badLength' && !files.has(key(url))) throw new Error(`serve the URL first: ${url}`);
      faults.set(key(url), fault);
    },
  };
}

export type Cdn = ReturnType<typeof createCdn>;
