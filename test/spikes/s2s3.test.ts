// Spikes S2 and S3 (plan section 2), S5 and the local part of S6: the playtest app in spikes/s2s3 writes what Reddit sends, and what
// the API answers, to the log with console.log. The harness of @devvit/test drives each route here; the test reads the JSON lines back.
// extract.test.ts tests the script that reads the real log.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Header } from '@devvit/shared-types/Header.js';
import { parseAppConfigJson } from '@devvit/shared-types/schemas/config-file.v1.js';
import { createDevvitTest, type DevvitFixtures } from '@devvit/test/server/vitest';
import { context, reddit } from '@devvit/web/server';
import { afterAll, expect, vi } from 'vitest';
import devvit from '../../spikes/s2s3/devvit.json';
import { app, probeDecode } from '../../spikes/s2s3/src/app';

const test = createDevvitTest(); // subreddit testsub (t5_testsub), user testuser

type Line = Record<string, any>;
type Mocks = DevvitFixtures['mocks'];

/** Collects the JSON lines of console.log from now on. The harness undoes the spy after the test. */
const capture = () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return () => log.mock.calls.map(([line]) => JSON.parse(line as string) as Line);
};
const send = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const trigger = (name: keyof typeof devvit.triggers, body: unknown, headers?: Record<string, string>) => send(devvit.triggers[name], body, headers);
const menu = (endpoint: string, body: unknown) => send(endpoint, body);
const endpointOf = (label: string) => devvit.menu.items.find((item) => item.label === label)!.endpoint;

const PNG = 'https://i.redd.it/abc123.png';
/** The Post class is not exported at run time: spy on the prototype of an instance (the post t3_p1 must exist). */
const enrichedThumbnail = async (image: { url: string; width: number; height: number }) =>
  vi.spyOn(Object.getPrototypeOf(await reddit.getPostById('t3_p1')), 'getEnrichedThumbnail').mockResolvedValue({ image, isObfuscatedDefault: false });
const addPost = (mocks: Mocks, over: Record<string, unknown> = {}) =>
  mocks.reddit.linksAndComments.addPost({
    id: 't3_p1', title: 'S2-01 png 1920x1080 single', author: 'alice', authorFullname: 't2_alice', createdUtc: 1_780_000_000, linkFlairText: 'Desktop',
    url: PNG, gallery: [{ url: PNG, width: 1920, height: 1080, status: 1 }], ...over,
  });

test('devvit.json: the app that the owner registered, with Reddit, Redis and the two fetch domains', () => {
  const config = parseAppConfigJson(devvit as never, false);
  expect(config.name).toBe('animewallpaperbotv3'); // Reddit approves a fetch domain for one app, so this build must be that app
  expect(config.permissions.reddit).toMatchObject({ enable: true, scope: 'moderator' });
  expect(config.permissions.redis).toBe(true);
  expect(config.permissions.http).toEqual({ enable: true, domains: ['i.redd.it', 'preview.redd.it'] });
});

test('devvit.json: six triggers, six moderator menu items, a fetch switch and a select setting', () => {
  expect(Object.keys(devvit.triggers)).toEqual([
    'onPostSubmit', 'onPostFlairUpdate', 'onPostDelete', 'onCommentCreate', 'onAutomoderatorFilterPost', 'onModAction',
  ]);
  expect(devvit.menu.items.map(({ label, location, forUserType }) => [label, location, forUserType])).toEqual([
    ['S2: dump post', 'post', 'moderator'],
    ['S3: app comments and removes this post', 'post', 'moderator'],
    ['S2: dump listings', 'subreddit', 'moderator'],
    ['S3: probe platform', 'subreddit', 'moderator'],
    ['S4: probe limits', 'subreddit', 'moderator'],
    ['S4: decode 8K', 'subreddit', 'moderator'],
  ]);
  expect(devvit.settings.subreddit).toMatchObject({ fetchProbe: { type: 'boolean', defaultValue: false }, probeSelect: { type: 'select' } });
});

test('the build script writes the server entry of devvit.json; the dev script is the same command in watch mode', () => {
  const { server, scripts } = devvit;
  expect(scripts.build).toMatch(/^esbuild src\/index\.ts /);
  expect(scripts.build).toContain(`--outfile=${server.dir}/${server.entry}`);
  expect(scripts.dev).toBe(`${scripts.build} --watch=forever`);
});

for (const [name, path] of Object.entries(devvit.triggers)) {
  test(`${name}: the endpoint of devvit.json answers {} and logs the trigger name`, async () => {
    const lines = capture();
    const res = await send(path, { type: name });
    expect([res.status, await res.json(), lines().map((line) => line.s3)]).toEqual([200, {}, [name]]);
  });
}

test('a trigger logs the s3 line: the devvit headers without tokens, the whole body, the time', async () => {
  const lines = capture();
  const body = { type: 'CommentCreate', comment: { id: 't1_c1', body: 'hi', createdAt: 1_780_000_000_000 }, author: { id: 't2_a', name: 'alice', accountType: 1 }, post: { id: 't3_p1' } };
  // devvit-context is a signed JWT (BaseContextFromMetadata in @devvit/shared-types): it is a token, although its name does not say so.
  const headers = { 'devvit-app': 'x', 'devvit-subreddit-name': 'testsub', authorization: 'Bearer secret', cookie: 'a=b', 'devvit-auth-token': 'secret', 'devvit-context': 'a.b.c', 'x-other': '1' };
  const before = Date.now();
  await trigger('onCommentCreate', body, headers);
  expect(lines()).toEqual([{ s3: 'onCommentCreate', at: expect.any(Number), headers: { 'devvit-app': 'x', 'devvit-subreddit-name': 'testsub' }, body }]); // no post lookup
  expect(lines()[0]!.at).toBeGreaterThanOrEqual(before);
});

// The allow-list of the logged headers. It is the Header enum of @devvit/shared-types without devvit-context (a signed JWT), devvit-post-data
// (developer data of a custom post), traceparent and tracestate. A header that is not in this list is not logged, whatever its name is.
const LOGGED_HEADERS = [
  'devvit-accept-language', 'devvit-accept-timezone', 'devvit-actor', 'devvit-app', 'devvit-app-user', 'devvit-canary', 'devvit-comment', 'devvit-debug',
  'devvit-featured-games', 'devvit-gql-host', 'devvit-installation', 'devvit-mod-permissions', 'devvit-post', 'devvit-post-author', 'devvit-remote-hostname',
  'devvit-stream-id', 'devvit-subreddit', 'devvit-subreddit-name', 'devvit-user', 'devvit-user-agent', 'devvit-user-name', 'devvit-user-snoovatar-url', 'devvit-version',
];

test('only the allow-listed devvit headers are logged: a header that the list does not name is not, even a new devvit header', async () => {
  const lines = capture();
  const names = [...Object.values(Header), 'devvit-some-new-header', 'devvit-api-key', 'x-other', 'authorization', 'cookie'];
  await trigger('onCommentCreate', { type: 'CommentCreate' }, Object.fromEntries(names.map((name) => [name, 'value'])));
  expect(Object.keys(lines()[0]!.headers).sort()).toEqual(LOGGED_HEADERS);
});

test('a post trigger then logs the post as the API shows it: the S2 fields, the URL rule, the enriched thumbnail', async ({ mocks }) => {
  const lines = capture();
  addPost(mocks, {
    gallery: [{ url: PNG, width: 1920, height: 1080, status: 1 }, { url: 'https://preview.redd.it/def456.jpg?width=640&format=pjpg', width: 640, height: 360, status: 1 }],
  });
  await trigger('onPostSubmit', { type: 'PostSubmit', post: { id: 't3_p1' } });
  const [s3, s2, ...rest] = lines();
  expect([s3!.s3, rest]).toEqual(['onPostSubmit', []]); // the trigger line comes first; no fetch while fetchProbe is off
  expect(s2).toMatchObject({
    s2: 'post', via: 'onPostSubmit', at: expect.any(Number), id: 't3_p1', title: 'S2-01 png 1920x1080 single', url: PNG, permalink: '/r/testsub/comments/p1/',
    createdAt: { type: 'Date', value: '2026-05-28T20:26:40.000Z', ms: 1_780_000_000_000 }, removed: false, spam: false, approved: false,
    authorName: 'alice', authorId: 't2_alice', flair: expect.objectContaining({ text: 'Desktop' }),
    gallery: [
      { url: PNG, width: 1920, height: 1080, status: 1, normalized: PNG },
      { url: 'https://preview.redd.it/def456.jpg?width=640&format=pjpg', width: 640, height: 360, status: 1, normalized: 'https://i.redd.it/def456.jpg' },
    ],
  });
  expect(s2!.enriched.error).toMatch(/not implemented/); // the harness does not fake it; the app logs the error instead of failing
});

test('the enriched thumbnail is logged; the URL rule gives null for a host or a type that it does not accept', async ({ mocks }) => {
  const lines = capture();
  addPost(mocks, { url: 'https://example.com/a.jpg', gallery: [{ url: 'https://external-preview.redd.it/a.jpg?s=1', width: 600, height: 400, status: 1 }, { url: 'https://i.redd.it/anim.gif', width: 100, height: 100, status: 1 }] });
  await enrichedThumbnail({ url: 'https://preview.redd.it/e.jpg', width: 640, height: 360 });
  await trigger('onPostFlairUpdate', { type: 'PostFlairUpdate', post: { id: 't3_p1' } });
  const s2 = lines()[1]!;
  expect(s2.gallery.map((entry: Line) => entry.normalized)).toEqual([null, null]);
  expect(s2.enriched).toEqual({ ok: { image: { url: 'https://preview.redd.it/e.jpg', width: 640, height: 360 }, isObfuscatedDefault: false } });
});

test('a value that is undefined is logged as [undefined], so that it differs from an empty string', async ({ mocks }) => {
  const lines = capture();
  addPost(mocks, { removedBy: '', removedByCategory: 'moderator' });
  await trigger('onPostDelete', { type: 'PostDelete', postId: 't3_p1' });
  expect(lines()[1]).toMatchObject({ via: 'onPostDelete', removedBy: '', crosspostParentId: '[undefined]', removedByCategory: 'moderator' });
});

test('a post id without the t3_ prefix in the body still finds the post', async ({ mocks }) => {
  const lines = capture();
  addPost(mocks);
  await trigger('onPostSubmit', { type: 'PostSubmit', post: { id: 'p1' } });
  expect(lines()[1]).toMatchObject({ s2: 'post', id: 't3_p1', title: 'S2-01 png 1920x1080 single' });
});

test('a crosspost also logs its parent post: the S2 (b) images come from there', async ({ mocks }) => {
  const lines = capture();
  addPost(mocks, { id: 't3_parent', title: 'parent', gallery: [{ url: PNG, width: 3840, height: 2160, status: 1 }] });
  addPost(mocks, { id: 't3_x1', title: 'S2-10 crosspost single', url: 'https://www.reddit.com/r/testsub/comments/x1/', gallery: [], crosspostParent: 't3_parent' });
  await trigger('onPostSubmit', { type: 'PostSubmit', post: { id: 't3_x1' } });
  const s2 = lines()[1]!;
  expect(s2).toMatchObject({ id: 't3_x1', crosspostParentId: 't3_parent', gallery: [] });
  expect(s2.parent.ok).toMatchObject({ id: 't3_parent', url: PNG, gallery: [{ width: 3840, height: 2160, normalized: PNG }] });
});

test('a post that the API cannot give logs the error; the route still answers, and the trigger line came first', async () => {
  const lines = capture();
  const res = await trigger('onPostDelete', { type: 'PostDelete', postId: 't3_gone', source: 1 });
  expect(res.status).toBe(200);
  expect(lines().map((line) => [line.s3 ?? line.s2, line.error ? 'error' : 'ok'])).toEqual([['onPostDelete', 'ok'], ['post', 'error']]);
  expect(lines()[1]).toMatchObject({ s2: 'post', via: 'onPostDelete', id: 't3_gone', error: expect.stringMatching(/\S/) });
});

test('onModAction looks up the target post and names the action; an action without a target post logs only the trigger', async ({ mocks }) => {
  const lines = capture();
  addPost(mocks, { removed: true, removedBy: 'mod1', removedByCategory: 'moderator' });
  await trigger('onModAction', { type: 'ModAction', action: 'removelink', targetPost: { id: 't3_p1' } });
  await trigger('onModAction', { type: 'ModAction', action: 'lock', targetComment: { id: 't1_c1' } });
  expect(lines().map((line) => line.s3 ?? `${line.s2}:${line.via}`)).toEqual(['onModAction', 'post:onModAction:removelink', 'onModAction']);
});

test('onAutomoderatorFilterPost looks up the post in body.post', async ({ mocks }) => {
  const lines = capture();
  addPost(mocks, { removed: true, removedBy: 'AutoModerator', removedByCategory: 'automod_filtered' });
  await trigger('onAutomoderatorFilterPost', { type: 'AutomoderatorFilterPost', post: { id: 't3_p1' }, author: 't2_alice', reason: 'title word' });
  expect(lines()[1]).toMatchObject({ s2: 'post', via: 'onAutomoderatorFilterPost', removed: true, removedBy: 'AutoModerator', removedByCategory: 'automod_filtered' });
});

// S6 (local part of the plan): one fetch of the smallest image URL on a host that the domain request names.
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01];
const SMALL = 'https://preview.redd.it/small.jpg?width=320&format=pjpg';
const fetchPost = (mocks: Mocks) =>
  addPost(mocks, {
    gallery: [{ url: PNG, width: 1920, height: 1080, status: 1 }, { url: SMALL, width: 320, height: 180, status: 1 }],
    thumbnail: 'https://b.thumbs.redditmedia.com/t.jpg', thumbnailWidth: 140, thumbnailHeight: 78, // the smallest, but not a host of the request
  });

test('S6: with fetchProbe off the app does not fetch', async ({ mocks }) => {
  capture();
  const fetch = vi.spyOn(globalThis, 'fetch');
  fetchPost(mocks);
  await trigger('onPostSubmit', { type: 'PostSubmit', post: { id: 't3_p1' } });
  expect(fetch).not.toHaveBeenCalled();
});

test('S6: with fetchProbe on the app fetches the smallest i.redd.it or preview.redd.it URL once, as image/jpeg, and logs the answer', async ({ mocks }) => {
  const lines = capture();
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([...JPEG_HEAD, 0xaa, 0xbb]), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '18' } }));
  mocks.settings.put('fetchProbe', true);
  fetchPost(mocks);
  await enrichedThumbnail({ url: 'https://preview.redd.it/e.jpg', width: 640, height: 360 }); // larger than the gallery image that is chosen
  await trigger('onPostSubmit', { type: 'PostSubmit', post: { id: 't3_p1' } });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(SMALL, { headers: { Accept: 'image/jpeg' }, redirect: 'error' }); // a redirect is an error, not a second fetch
  expect(lines()[2]).toEqual({
    s6: 'fetch', at: expect.any(Number), id: 't3_p1', from: 'gallery', url: SMALL, width: 320, height: 180,
    ok: { status: 200, contentType: 'image/jpeg', contentLength: '18', bytes: 18, first16: 'ffd8ffe000104a464946000101000001' },
  });
});

// A body of 64 MiB in chunks of 1 MiB. `cancelled` tells that the app stopped reading.
const MIB = 1024 * 1024;
const bigBody = () => {
  const state = { pulls: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++state.pulls > 64) controller.close();
      else controller.enqueue(new Uint8Array(MIB));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { state, body };
};
const fetchWith = async (mocks: Mocks, response: Response) => {
  const lines = capture();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  mocks.settings.put('fetchProbe', true);
  fetchPost(mocks);
  await trigger('onPostSubmit', { type: 'PostSubmit', post: { id: 't3_p1' } });
  return lines().find((line) => line.s6)!;
};

test('S6: the app reads at most 20 MiB of a body: it stops, cancels the stream, and logs that the body was cut', async ({ mocks }) => {
  const { state, body } = bigBody();
  const s6 = await fetchWith(mocks, new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg' } }));
  expect(s6.ok).toEqual({ status: 200, contentType: 'image/jpeg', contentLength: null, bytes: 21 * MIB, truncated: true, first16: '00'.repeat(16) }); // the chunk that crosses the cap is the last
  expect(state.cancelled).toBe(true);
  expect(state.pulls).toBeLessThan(25);
});

test('S6: a content-length over 20 MiB is checked first: the app does not read the body and cancels it', async ({ mocks }) => {
  const { state, body } = bigBody();
  const s6 = await fetchWith(mocks, new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(20 * MIB + 1) } }));
  expect(s6.ok).toEqual({ status: 200, contentType: 'image/jpeg', contentLength: String(20 * MIB + 1), skipped: 'content-length is over 20 MiB' });
  expect(state.cancelled).toBe(true);
  expect(state.pulls).toBeLessThanOrEqual(2); // only the read-ahead of the stream itself
});

test('S6: the first 16 bytes are right when the chunks of the stream are shorter than 16 bytes', async ({ mocks }) => {
  const parts = [JPEG_HEAD.slice(0, 5), JPEG_HEAD.slice(5, 9), [...JPEG_HEAD.slice(9), 0xaa, 0xbb]]; // 5, 4 and 9 bytes
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new Uint8Array(part));
      controller.close();
    },
  });
  const s6 = await fetchWith(mocks, new Response(body, { status: 200 }));
  expect(s6.ok).toMatchObject({ bytes: 18, first16: 'ffd8ffe000104a464946000101000001' });
});

test('S6: a content-length of exactly 20 MiB is read', async ({ mocks }) => {
  const s6 = await fetchWith(mocks, new Response(new Uint8Array(JPEG_HEAD), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(20 * MIB) } }));
  expect(s6.ok).toMatchObject({ bytes: 16, first16: 'ffd8ffe000104a464946000101000001' });
  expect(s6.ok.truncated).toBeUndefined();
});

test('S6: a failed fetch (domain not approved yet) is logged; a post without such a URL is logged as skipped', async ({ mocks }) => {
  const lines = capture();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('domain not allowed'));
  mocks.settings.put('fetchProbe', true);
  fetchPost(mocks);
  addPost(mocks, { id: 't3_p2', url: 'https://example.com/a.jpg', gallery: [] });
  const [first, second] = [await trigger('onPostSubmit', { type: 'PostSubmit', post: { id: 't3_p1' } }), await trigger('onPostSubmit', { type: 'PostSubmit', post: { id: 't3_p2' } })];
  expect([first.status, second.status]).toEqual([200, 200]);
  expect(lines().filter((line) => line.s6).map((line) => [line.id, line.error ?? line.skipped, line.ok])).toEqual([
    ['t3_p1', 'Error: domain not allowed', undefined],
    ['t3_p2', 'no i.redd.it or preview.redd.it URL', undefined],
  ]);
});

test('menu "S2: dump post" logs the post of the menu target and shows a toast', async ({ mocks }) => {
  const lines = capture();
  addPost(mocks);
  const res = await menu(endpointOf('S2: dump post'), { location: 'post', targetId: 't3_p1' });
  expect(await res.json()).toEqual({ showToast: expect.stringContaining('t3_p1') });
  expect(lines()).toEqual([expect.objectContaining({ s2: 'post', via: 'menu', id: 't3_p1' })]);
});

test('menu "S2: dump listings" logs id, removed, spam and category of /new and the mod queue (limit 25)', async () => {
  const lines = capture();
  const rows = (...posts: object[]) => ({ all: async () => posts }) as never;
  const getNew = vi.spyOn(reddit, 'getNewPosts').mockReturnValue(rows({ id: 't3_a', removed: false, spam: false, removedByCategory: undefined, title: 'x' }));
  const getQueue = vi.spyOn(reddit, 'getModQueue').mockReturnValue(rows({ id: 't3_b', removed: true, spam: false, removedByCategory: 'automod_filtered' }));
  await menu(endpointOf('S2: dump listings'), { location: 'subreddit', targetId: 't5_testsub' });
  expect(getNew).toHaveBeenCalledExactlyOnceWith({ subredditName: 'testsub', limit: 25 });
  expect(getQueue).toHaveBeenCalledExactlyOnceWith({ subreddit: 'testsub', type: 'post', limit: 25 });
  expect(lines()).toEqual([{
    s2: 'listings', at: expect.any(Number), subreddit: 'testsub',
    new: { ok: [{ id: 't3_a', removed: false, spam: false, removedByCategory: '[undefined]' }] },
    modQueue: { ok: [{ id: 't3_b', removed: true, spam: false, removedByCategory: 'automod_filtered' }] },
  }]);
});

test('menu "S2: dump listings" logs an API error instead of failing', async () => {
  const lines = capture();
  vi.spyOn(reddit, 'getNewPosts').mockImplementation(() => { throw new Error('boom'); });
  vi.spyOn(reddit, 'getModQueue').mockReturnValue({ all: async () => [] } as never);
  expect((await menu(endpointOf('S2: dump listings'), { location: 'subreddit', targetId: 't5_testsub' })).status).toBe(200);
  expect(lines()[0]).toMatchObject({ new: { error: 'Error: boom' }, modQueue: { ok: [] } });
});

test('menu "S3: probe platform" logs headers, context, two nx sets, the settings and the app user', async ({ mocks, headers }) => {
  const lines = capture();
  mocks.settings.put('probeSelect', ['b']);
  mocks.settings.put('fetchProbe', false);
  mocks.reddit.users.addUser({ id: 't2_app', name: context.appName }); // getAppUser reads the user that is named like the app
  const set = vi.spyOn(mocks.redis.plugin, 'Set');
  const res = await send(endpointOf('S3: probe platform'), { location: 'subreddit', targetId: 't5_testsub' }, headers);
  expect(res.status).toBe(200);
  const [probe] = lines();
  expect(probe).toMatchObject({
    s3: 'probe', at: expect.any(Number), body: { location: 'subreddit', targetId: 't5_testsub' },
    context: { appSlug: context.appSlug, appVersion: expect.any(String), subredditId: 't5_testsub', subredditName: 'testsub', userId: 't2_testuser', username: 'testuser' },
    settings: { ok: { fetchProbe: 'boolean', probeSelect: 'array[1] of string' } }, // the keys and the types, not the values
    appUser: { ok: { id: 't2_app', username: context.appName } },
  });
  expect(probe!.headers).toMatchObject({ 'devvit-user': 't2_testuser', 'devvit-user-name': 'testuser' }); // a menu request carries the user, a trigger does not
  expect(probe!.redisNx).toHaveLength(2);
  const calls = set.mock.calls.map(([request]) => request);
  expect(calls.map(({ value, nx }) => [value, nx])).toEqual([['1', true], ['2', true]]); // the second set asks for nx too ...
  expect(calls[0]!.key).toBe(calls[1]!.key); // ... on the same key, with an expiration
  expect(calls[0]!.expiration).toBeGreaterThan(0);
  expect(await mocks.redis.plugin.Get({ key: calls[0]!.key })).toMatchObject({ value: '1' }); // the second set did not overwrite
});

test('menu "S3: probe platform" logs the type of each setting and never a value: a secret setting stays out of the log', async ({ mocks }) => {
  const lines = capture();
  for (const [key, value] of Object.entries({ apiKey: 'sk-secret-123', retries: 3, enabled: true, mode: 'dry-run', modes: ['a', 'b'], none: [] })) mocks.settings.put(key, value);
  await menu(endpointOf('S3: probe platform'), { location: 'subreddit', targetId: 't5_testsub' });
  const probe = lines()[0]!;
  expect(probe.settings).toEqual({ ok: { apiKey: 'string', retries: 'number', enabled: 'boolean', mode: 'string', modes: 'array[2] of string', none: 'array[0]' } });
  for (const secret of ['sk-secret-123', 'dry-run']) expect(JSON.stringify(probe), secret).not.toContain(secret);
});

test('menu "S3: app comments and removes this post": the app comments, removes, and logs the post after', async ({ mocks }) => {
  const lines = capture();
  addPost(mocks);
  const comment = vi.spyOn(reddit, 'submitComment').mockResolvedValue({ id: 't1_app' } as never);
  const remove = vi.spyOn(reddit, 'remove').mockResolvedValue(undefined);
  const res = await menu(endpointOf('S3: app comments and removes this post'), { location: 'post', targetId: 't3_p1' });
  expect(res.status).toBe(200);
  expect(comment).toHaveBeenCalledExactlyOnceWith({ id: 't3_p1', text: expect.stringContaining('S3') });
  expect(remove).toHaveBeenCalledExactlyOnceWith('t3_p1', false);
  expect(lines().map((line) => line.s3 ?? `${line.s2}:${line.via}`)).toEqual(['app-acts', 'post:menu:app-acts']);
  expect(lines()[0]).toMatchObject({ postId: 't3_p1', commentId: 't1_app' });
});

test('a route that throws answers 500 with the message', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(reddit, 'submitComment').mockRejectedValue(new Error('no permission'));
  const res = await menu(endpointOf('S3: app comments and removes this post'), { location: 'post', targetId: 't3_p1' });
  expect([res.status, await res.json()]).toEqual([500, { error: 'no permission' }]);
});

// The two halves of the spike: extract.mjs must read the keys that this app writes (extract.test.ts has a sample that is made by hand).
const work = mkdtempSync(join(tmpdir(), 's2s3-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

test('extract.mjs reads what the app writes: a post trigger, the listings, the probe and the fetch', async ({ mocks }) => {
  const lines = capture();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array(JPEG_HEAD), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
  mocks.settings.put('fetchProbe', true);
  addPost(mocks, { title: 'S2-99 contract', gallery: [{ url: PNG, width: 1920, height: 1080, status: 1 }, { url: SMALL, width: 320, height: 180, status: 1 }] });
  vi.spyOn(reddit, 'getNewPosts').mockReturnValue({ all: async () => [{ id: 't3_p1', removed: false, spam: false }] } as never);
  vi.spyOn(reddit, 'getModQueue').mockReturnValue({ all: async () => [] } as never);
  const body = { type: 'PostSubmit', post: { id: 't3_p1', title: 'S2-99 contract', createdAt: 1_780_000_000_000 }, author: { id: 't2_alice', name: 'alice' } };
  await trigger('onPostSubmit', body, { 'devvit-app': 'x' });
  await menu(endpointOf('S2: dump listings'), { location: 'subreddit', targetId: 't5_testsub' });
  await menu(endpointOf('S3: probe platform'), { location: 'subreddit', targetId: 't5_testsub' });

  const log = join(work, 'app.jsonl');
  writeFileSync(log, lines().map((line) => JSON.stringify({ severity: 1, message: JSON.stringify(line) })).join('\n'));
  const script = fileURLToPath(new URL('../../spikes/s2s3/extract.mjs', import.meta.url));
  const text = execFileSync(process.execPath, [script, log, join(work, 'out')], { encoding: 'utf8' });
  expect(text).toContain('wrote 1 fixtures');
  expect(text).toMatch(/\| S2-99 contract \| onPostSubmit \| false \| false \| false \|/);
  expect(text).toContain('| S2-99 contract | https://i.redd.it/abc123.png | 1920x1080/1 320x180/1 | - | https://i.redd.it/abc123.png https://i.redd.it/small.jpg | 2 | [undefined] |');
  expect(text).toMatch(/\| S2-99 contract \| onPostSubmit \+0\.0s \(delay [\d.]+s\) \|/);
  expect(text).toContain('dump 1 new: S2-99 contract (removed=false spam=false category=[undefined])');
  expect(text).toContain('- headers on triggers: devvit-app; user headers: none');
  expect(text).toMatch(/- probe redisNx: \[\{"ok":/);
  expect(text).toContain('- fetch probe S2-99 contract: gallery 320x180 {"status":200,"contentType":"image/jpeg","contentLength":null,"bytes":16,"first16":"ffd8ffe000104a464946000101000001"}');
});

// S4: the 4K decode runs for real here (a few seconds); the 8K item calls the same function with other sizes.
test('menu "S4: probe limits" logs WebAssembly, the 4K encode and decode, then the Redis write and each read step, each step on its own line', { timeout: 60_000 }, async ({ mocks }) => {
  const lines = capture();
  const hGetAll = vi.spyOn(mocks.redis.plugin, 'HGetAll');
  const res = await menu(endpointOf('S4: probe limits'), { location: 'subreddit', targetId: 't5_testsub' });
  expect(res.status).toBe(200);
  const got = lines();
  expect(got.map((l) => [l.s4, l.format ?? l.step ?? null])).toEqual([
    ['wasm', null], ['encode', null], ['encode', null], ['decode', 'jpeg'], ['decode', 'png'], ['redis-write', null],
    ['redis', 'hGetAllSequential'], ['redis', 'hGetAllParallel'], ['redis', 'getSequential'], ['redis', 'getParallel'], ['redis', 'mGet'],
  ]);
  for (const line of got) expect(line, JSON.stringify(line)).not.toHaveProperty('error');
  for (const line of got) expect(line.ms ?? line.jpeg?.ms ?? line.png?.ms, JSON.stringify(line)).toEqual(expect.any(Number));
  for (const line of got.slice(3, 5)) expect(line).toMatchObject({ size: '3840x2160', bytes: expect.any(Number), rssMbBefore: expect.any(Number), rssMbAfter: expect.any(Number) });
  expect(hGetAll).toHaveBeenCalledTimes(70); // 35 one after the other, 35 at once
  const hash = await mocks.redis.plugin.HGetAll({ key: 'spike:s4:h0' });
  expect(Object.keys(hash.fieldValues)).toHaveLength(50);
  expect(Object.values(hash.fieldValues).join('').length).toBe(600 * 1024); // 600 KB a hash
  expect(new Set(Object.values(hash.fieldValues)).size).toBe(50); // no repeated values
  for (const key of ['spike:s4:h0', 'spike:s4:h34', 'spike:s4:s49']) expect((await mocks.redis.plugin.ExpireTime({ key })).value, key).toBeGreaterThan(0); // every key expires
});

test('menu "S4: decode 8K" is the route of its devvit.json item; a failure in the decode setup still writes an s4 line', async () => {
  expect(app.routes.some((r) => r.method === 'POST' && r.path === endpointOf('S4: decode 8K'))).toBe(true);
  const lines = capture();
  await probeDecode(-1, 1); // a negative size: the Uint8Array cannot be made
  expect(lines()).toEqual([{ s4: 'decode', at: expect.any(Number), size: '-1x1', error: expect.stringContaining('RangeError') }]);
});
