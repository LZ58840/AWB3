// Spike S1 (plan section 2): proves that @devvit/test supports the simulator design of plan 7.1-7.2.
// The tiny Hono app below stands for src/server/app.ts. Real routes sit under /internal/*.
import { reddit as redditPackage } from '@devvit/reddit';
import { RedisMock } from '@devvit/redis/test';
import { createDevvitTest } from '@devvit/test/server/vitest';
import { Context, context, reddit, redis, runWithContext, scheduler, settings } from '@devvit/web/server';
import { Hono } from 'hono';
import Redis from 'ioredis-mock';
import { afterEach, expect, vi } from 'vitest';

const test = createDevvitTest(); // user testuser (t2_testuser), subreddit testsub (t5_testsub)
const notSimulated = /not implemented in the test harness/;
const T0 = Date.parse('2026-12-08T10:00:00Z');

const app = new Hono();
app.post('/internal/probe', async (c) => {
  const seed = await redis.get('seed');
  await redis.set('probe', 'written-by-route');
  const sub = await reddit.getCurrentSubreddit();
  const seeded = await reddit.getPostById('t3_seeded');
  return c.json({ seed, sub: sub.name, title: seeded.title });
});
app.post('/internal/whoami', async (c) => {
  await redis.get('hop'); // the context must survive an await on a harness mock
  const { userId, username, subredditName, postId } = context;
  return c.json({ userId, username, subredditName, postId: postId ?? null });
});
app.post('/internal/act', async (c) => {
  await reddit.remove('t3_abc', false);
  await reddit.modMail.createModNotification({ subject: 'AWB', bodyMarkdown: 'alert', subredditId: context.subredditId });
  return c.json({ ok: true });
});
const post = async (path: string) => app.request(path, { method: 'POST' });

afterEach(() => {
  vi.useRealTimers(); // fake timers are global; the harness does not undo them
});

test('S1.1 app.request() sees the harness Redis and Reddit world', async ({ mocks }) => {
  await redis.set('seed', 'from-test');
  mocks.reddit.linksAndComments.addPost({ id: 't3_seeded', title: 'Seeded title' });
  const res = await post('/internal/probe');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ seed: 'from-test', sub: 'testsub', title: 'Seeded title' });
  expect(await redis.get('probe')).toBe('written-by-route');
});

test('S1.2 vi.spyOn(reddit, ...) in the test reaches app code (one copy of @devvit/reddit)', async () => {
  expect(redditPackage).toBe(reddit); // @devvit/web/server re-exports the top-level @devvit/reddit instance
  const remove = vi.spyOn(reddit, 'remove').mockResolvedValue(undefined);
  const alert = vi.spyOn(reddit.modMail, 'createModNotification').mockResolvedValue('conversation-1');
  expect((await post('/internal/act')).status).toBe(200);
  expect(remove).toHaveBeenCalledExactlyOnceWith('t3_abc', false);
  expect(alert).toHaveBeenCalledExactlyOnceWith({ subject: 'AWB', bodyMarkdown: 'alert', subredditId: 't5_testsub' });
});

// S1.3a and S1.3b depend on file order (vitest default: no shuffle).
let spyOfPreviousTest: object | undefined;
test('S1.3a a spy and a Redis key from this test ...', async () => {
  spyOfPreviousTest = vi.spyOn(reddit, 'remove').mockResolvedValue(undefined);
  await redis.set('leak', '1');
  await reddit.remove('t3_abc', false);
  expect(spyOfPreviousTest).toHaveBeenCalledTimes(1);
});
test('S1.3b ... are gone in the next test', async () => {
  expect(spyOfPreviousTest).toBeDefined(); // S1.3a ran before this test
  expect(vi.isMockFunction(reddit.remove)).toBe(false);
  await expect(reddit.remove('t3_abc', false)).rejects.toThrow(notSimulated);
  expect(await redis.get('leak')).toBeUndefined();
});

test('S1.4 runWithContext sets user, subreddit and post per request', async ({ headers }) => {
  const mod = { 'devvit-user': 't2_mod', 'devvit-user-name': 'mod1', 'devvit-subreddit': 't5_other', 'devvit-subreddit-name': 'othersub', 'devvit-post': 't3_abc' };
  const user2 = { 'devvit-user': 't2_user2', 'devvit-user-name': 'user2' };
  const whoami = (override?: Record<string, string>) => {
    const run = () => post('/internal/whoami').then((res) => res.json());
    return override ? runWithContext(Context({ ...headers, ...override }), run) : run();
  };
  expect(await whoami()).toEqual({ userId: 't2_testuser', username: 'testuser', subredditName: 'testsub', postId: null });
  expect(await whoami(mod)).toEqual({ userId: 't2_mod', username: 'mod1', subredditName: 'othersub', postId: 't3_abc' });
  const both = await Promise.all([whoami(mod), whoami(user2)]); // two requests at the same time
  expect(both.map((who) => who.username)).toEqual(['mod1', 'user2']);
  expect((await whoami()).username).toBe('testuser'); // the default context is back
});

test('S1.4b a context override is not a second installation: Redis and settings stay shared', async ({ headers, mocks }) => {
  await redis.set('shared', 'from-default-context');
  mocks.settings.put('flag', 'on');
  const other = Context({ ...headers, 'devvit-subreddit': 't5_other', 'devvit-subreddit-name': 'othersub' });
  const seen = await runWithContext(other, async () => ({ redis: await redis.get('shared'), flag: await settings.get('flag') }));
  expect(seen).toEqual({ redis: 'from-default-context', flag: 'on' });
});

test('S1.5 faking only Date does not stop the async harness mocks', async ({ mocks }) => {
  // RedisMock waits on setImmediate imported from node:timers; vitest 5 fakes that import only with fakeTimers.fakeNodeBuiltins: true.
  mocks.reddit.linksAndComments.addPost({ id: 't3_seeded', title: 'Seeded title' });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  expect((await post('/internal/probe')).status).toBe(200); // Redis and Reddit mocks answer
  expect(await redis.get('probe')).toBe('written-by-route');
  expect(Date.now()).toBe(T0); // the clock stayed frozen while the mocks ran
  vi.setSystemTime(T0 + 3_600_000);
  expect((await reddit.getCurrentSubreddit()).name).toBe('testsub');
  expect(Date.now()).toBe(T0 + 3_600_000);
});

test('S1.6 Redis TTLs follow the faked Date, and expireTime shows them', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  await redis.set('by-date', 'v', { expiration: new Date(T0 + 60_000) });
  await redis.set('by-expire', 'v');
  await redis.expire('by-expire', 30);
  expect(await redis.expireTime('by-date')).toBe(T0 / 1000 + 60);
  expect(await redis.expireTime('by-expire')).toBe(T0 / 1000 + 30);
  vi.setSystemTime(T0 + 45_000);
  expect(await redis.get('by-expire')).toBeUndefined();
  expect(await redis.get('by-date')).toBe('v');
  vi.setSystemTime(T0 + 61_000);
  expect(await redis.get('by-date')).toBeUndefined();
});

test('S1.7 reddit methods that the harness does not fake throw', async ({ mocks }) => {
  mocks.reddit.users.addUser({ id: 't2_app', name: 'test-app' }); // modMail first looks up the user named context.appName
  const p = await reddit.submitPost({ subredditName: 'testsub', title: 't', text: 'b' }); // this one works
  const calls: Record<string, () => Promise<unknown>> = {
    remove: () => reddit.remove(p.id, false),
    approve: () => reddit.approve(p.id),
    submitComment: () => reddit.submitComment({ id: p.id, text: 'x' }),
    report: () => reddit.report(p, { reason: 'r' }),
    setPostFlair: () => reddit.setPostFlair({ subredditName: 'testsub', postId: p.id, flairTemplateId: 'f' }),
    getModerationLog: () => reddit.getModerationLog({ subredditName: 'testsub' }).all(), // a Listing throws when read
    getWikiPage: () => reddit.getWikiPage('testsub', 'awb'),
    'modMail.createModNotification': () => reddit.modMail.createModNotification({ subject: 's', bodyMarkdown: 'b', subredditId: context.subredditId }),
    'modMail.reply': () => reddit.modMail.reply({ conversationId: 'c', body: 'b', isInternal: true }),
    getNewPosts: () => reddit.getNewPosts({ subredditName: 'testsub', limit: 1 }).all(),
    getModQueue: () => reddit.getModQueue({ subreddit: 'testsub', type: 'post' }).all(),
    getPostsByUser: () => reddit.getPostsByUser({ username: 'u', limit: 1 }).all(),
    'post.lock': () => p.lock(),
    'post.remove': () => p.remove(),
    'post.addComment': () => p.addComment({ text: 'x' }),
    'post.getEnrichedThumbnail': () => p.getEnrichedThumbnail(),
  };
  for (const [name, call] of Object.entries(calls)) await expect(Promise.resolve().then(call), name).rejects.toThrow(notSimulated);
});

test('S1.8 the scheduler only records jobs; due jobs do not run and devvit.json crons are absent', async ({ mocks }) => {
  expect(mocks.scheduler.getScheduledActions()).toEqual([]);
  const runAt = new Date(Date.now() - 1000); // already due
  const id = await scheduler.runJob({ name: 'tick', runAt, data: { n: 1 } });
  await scheduler.runJob({ name: 'sweep', cron: '*/5 * * * *' });
  expect(await scheduler.listJobs()).toEqual([
    { id, name: 'tick', runAt, data: { n: 1 } },
    { id: expect.any(String), name: 'sweep', cron: '*/5 * * * *' },
  ]);
  expect(mocks.scheduler.getScheduledActions()).toHaveLength(2);
});

test('S1.9 fetch throws unless a test spies on it', async () => {
  await expect(fetch('https://i.redd.it/a.jpg')).rejects.toThrow('HTTP requests are not allowed in tests');
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bytes'));
  expect(await (await fetch('https://i.redd.it/a.jpg')).text()).toBe('bytes');
});

test('S1.10 spies on mocks.redis.plugin see every write: client, global scope, transaction', async ({ mocks }) => {
  const set = vi.spyOn(mocks.redis.plugin, 'Set');
  const expire = vi.spyOn(mocks.redis.plugin, 'Expire');
  await redis.set('a', '1');
  await redis.global.set('g', '1');
  const tx = await redis.watch('a');
  await tx.multi();
  await tx.set('t', '1');
  await tx.expire('t', 10);
  await tx.exec();
  expect(set.mock.calls.map(([req]) => req.key)).toEqual(['a', 'g', 't']);
  expect(expire.mock.calls.map(([req]) => [req.key, req.seconds])).toEqual([['t', 10]]);
});

test('S1.11 instance methods bypass vi.spyOn(reddit, ...); vi.spyOn(config, "use") fakes a whole plugin service', async ({ config, mocks }) => {
  mocks.reddit.linksAndComments.addPost({ id: 't3_p', title: 'p' });
  const p = await reddit.getPostById('t3_p');
  const clientRemove = vi.spyOn(reddit, 'remove').mockResolvedValue(undefined);
  const removes: unknown[] = [];
  const realUse = config.use.bind(config);
  // shortcut: match the service by fullName suffix, import the proto Definition in test/sim/.
  vi.spyOn(config, 'use').mockImplementation(((def: { fullName: string }) =>
    def.fullName.endsWith('.Moderation') ? { Remove: async (req: unknown) => (removes.push(req), {}) } : realUse(def as never)) as never);
  await p.remove();
  expect(clientRemove).not.toHaveBeenCalled();
  expect(removes).toEqual([{ id: 't3_p', spam: false }]);
});

test('S1.12 addPost fields reach the Post model', async ({ mocks }) => {
  mocks.reddit.linksAndComments.addPost({
    id: 't3_g',
    title: 'T',
    author: 'alice',
    authorFullname: 't2_alice',
    createdUtc: 1_700_000_000,
    linkFlairText: 'Desktop',
    crosspostParent: 't3_parent',
    gallery: [{ url: 'https://i.redd.it/a.jpg', width: 1920, height: 1080, status: 1 }],
    removed: true,
    removedBy: 'automoderator',
    removedByCategory: 'automod_filtered',
  });
  const p = await reddit.getPostById('t3_g');
  expect({
    authorName: p.authorName,
    authorId: p.authorId,
    createdAt: p.createdAt.toISOString(),
    flair: p.flair?.text,
    crosspostParentId: p.crosspostParentId,
    gallery: p.gallery,
    removed: p.removed,
    removedBy: p.removedBy,
    removedByCategory: p.removedByCategory,
  }).toEqual({
    authorName: 'alice',
    authorId: 't2_alice',
    createdAt: '2023-11-14T22:13:20.000Z',
    flair: 'Desktop',
    crosspostParentId: 't3_parent',
    gallery: [{ url: 'https://i.redd.it/a.jpg', width: 1920, height: 1080, status: 1 }],
    removed: true,
    removedBy: 'automoderator',
    removedByCategory: 'automod_filtered',
  });
});

test('S1.13 two installations in one test: route a Redis plugin per request through vi.spyOn(config, "use")', async ({ config, headers }) => {
  const other = new RedisMock(new Redis(), crypto.randomUUID()); // the second installation's Redis
  const realUse = config.use.bind(config);
  // shortcut: match the service by fullName suffix, import the proto Definition in test/sim/.
  vi.spyOn(config, 'use').mockImplementation(((def: { fullName: string }) =>
    def.fullName.endsWith('.RedisAPI') && context.subredditName === 'othersub' ? other.plugin : realUse(def as never)) as never);
  await redis.set('k', 'default');
  const asOther = Context({ ...headers, 'devvit-subreddit': 't5_other', 'devvit-subreddit-name': 'othersub' });
  const seen = await runWithContext(asOther, async () => {
    const before = await redis.get('k');
    await redis.set('k', 'other');
    return { before, after: await redis.get('k') };
  });
  expect(seen).toEqual({ before: undefined, after: 'other' });
  expect(await redis.get('k')).toBe('default');
  await other.clear();
});
