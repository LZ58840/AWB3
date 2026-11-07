import { expect, test, vi } from 'vitest';
import { createCdn } from './cdn';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const A = 'https://i.redd.it/a.jpg';
const get = async (url: string, init?: RequestInit) => {
  const res = await fetch(url, init);
  return { status: res.status, type: res.headers.get('content-type'), length: res.headers.get('content-length'), bytes: new Uint8Array(await res.arrayBuffer()) };
};

test('a served URL gives its bytes with the content type of the bytes and the true length', async () => {
  const cdn = createCdn();
  cdn.serve(A, JPEG);
  cdn.serve('https://preview.redd.it/b.png', PNG);
  expect(await get(A)).toEqual({ status: 200, type: 'image/jpeg', length: '10', bytes: JPEG });
  expect(await get('https://preview.redd.it/b.png')).toMatchObject({ status: 200, type: 'image/png', bytes: PNG });
});

test('an unknown file is a 404; other hosts and plain http are refused like the Devvit fetch policy', async () => {
  createCdn();
  expect((await get(A)).status).toBe(404);
  await expect(fetch('https://example.com/a.jpg')).rejects.toThrow(/not an allowed domain/);
  await expect(fetch('http://i.redd.it/a.jpg')).rejects.toThrow(/not an allowed domain/);
});

test('every request is recorded with its Accept header', async () => {
  const cdn = createCdn();
  cdn.serve(A, JPEG);
  await get(A, { headers: { Accept: 'image/jpeg' } });
  await fetch(new Request(A));
  expect(cdn.requests).toEqual([{ url: A, accept: 'image/jpeg' }, { url: A, accept: '*/*' }]);
});

test('notFound and timeout', async () => {
  const cdn = createCdn();
  cdn.serve(A, JPEG);
  cdn.fail(A, 'notFound');
  expect((await get(A)).status).toBe(404);
  cdn.fail(A, 'timeout');
  await expect(fetch(A)).rejects.toThrow('context deadline exceeded');
});

test('webp serves WebP bytes with the WebP content type', async () => {
  const cdn = createCdn();
  cdn.serve(A, JPEG);
  cdn.fail(A, 'webp');
  const { type, bytes } = await get(A);
  expect(type).toBe('image/webp');
  expect([String.fromCharCode(...bytes.slice(0, 4)), String.fromCharCode(...bytes.slice(8, 12))]).toEqual(['RIFF', 'WEBP']);
});

test('huge serves only a header that declares 20000x20000: a PNG header for .png and a JPEG header for .jpg', async () => {
  const cdn = createCdn();
  cdn.fail('https://i.redd.it/big.png', 'huge');
  cdn.fail('https://i.redd.it/big.jpg', 'huge');
  const png = (await get('https://i.redd.it/big.png')).bytes;
  const view = new DataView(png.buffer, png.byteOffset);
  expect([String.fromCharCode(...png.slice(1, 4)), String.fromCharCode(...png.slice(12, 16)), view.getUint32(16), view.getUint32(20)]).toEqual(['PNG', 'IHDR', 20000, 20000]);
  const jpg = (await get('https://i.redd.it/big.jpg')).bytes;
  const sof = jpg.findIndex((byte, i) => byte === 0xff && jpg[i + 1] === 0xc0);
  const jview = new DataView(jpg.buffer, jpg.byteOffset);
  expect([jpg[0], jpg[1], jview.getUint16(sof + 5), jview.getUint16(sof + 7)]).toEqual([0xff, 0xd8, 20000, 20000]);
});

test('badLength claims 1000 bytes more than it sends', async () => {
  const cdn = createCdn();
  cdn.serve(A, JPEG);
  cdn.fail(A, 'badLength');
  const { length, bytes } = await get(A);
  expect([length, bytes.length]).toEqual(['1010', 10]);
  expect(() => cdn.fail('https://i.redd.it/none.jpg', 'badLength')).toThrow(/serve the URL first/);
});

let spied = false;
test('S1.3a the fetch spy lives inside the test ...', () => {
  createCdn();
  spied = vi.isMockFunction(globalThis.fetch);
  expect(spied).toBe(true);
});
test('S1.3b ... and the real fetch is back in the next test', () => {
  expect(spied).toBe(true); // S1.3a ran before this test
  expect(vi.isMockFunction(globalThis.fetch)).toBe(false);
});
