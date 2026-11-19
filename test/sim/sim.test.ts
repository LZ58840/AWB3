// Self-tests of the simulator. The Hono app below stands for src/server/app.ts; each test adds the routes that it needs.
import { createDevvitTest } from '@devvit/test/server/vitest';
import { context, reddit, redis, settings } from '@devvit/web/server';
import { Hono } from 'hono';
import { expect, vi } from 'vitest';
import devvit from '../../devvit.json';
import { createCdn } from './cdn';
import { T0 } from './clock';
import { createSim } from './sim';

const test = createDevvitTest();
const MINUTE = 60_000;
const DAY = 86_400_000;
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const route = (app: Hono, path: string, handler: (body: Body) => unknown) =>
  app.post(path, async (c) => c.json(((await handler(await c.req.json())) ?? {}) as object));

// The world sends four events. The 3.0 manifest registers two triggers; these tests of the simulator need the other two too.
Object.assign(devvit.triggers, { onPostDelete: '/internal/triggers/post-delete', onCommentCreate: '/internal/triggers/comment-create' });

/** The app answers every trigger of devvit.json; a registered trigger without a route is an error of the simulator. */
const done = (app: Hono) => {
  for (const path of Object.values(devvit.triggers)) if (!app.routes.some((r) => r.path === path)) route(app, path, () => undefined);
  return app;
};

test('a trigger route that calls the Reddit API changes the world, and actions() lists the calls in order', async (fx) => {
  const received: string[] = [];
  const app = new Hono();
  route(app, '/internal/triggers/post-submit', async (body) => {
    received.push(`submit by ${body.author.name}`);
    const post = await reddit.getPostById(body.post.id);
    const comment = await reddit.submitComment({ id: post.id, text: 'Removed.' });
    await comment.distinguish(true);
    await post.lock();
  });
  route(app, '/internal/triggers/comment-create', (body) => void received.push(`comment by ${body.author.name} ${body.author.id}`));
  const sim = createSim(done(app), fx);
  sim.install('wallpapers');
  const post = await sim.submit({ title: 'Sunset', images: [{ width: 800, height: 600 }] });
  expect(sim.actions(post.id)).toEqual([
    { type: 'comment', commentId: expect.any(String), text: 'Removed.' },
    { type: 'distinguish', commentId: expect.any(String), sticky: true },
    { type: 'lock' },
  ]);
  expect((await reddit.getPostById(post.id)).locked).toBe(true);
  // the app comment came back as a CommentCreate from the app user, after the request that made it
  expect(received).toEqual(['submit by alice', `comment by ${devvit.name} t2_${devvit.name}`]);
});

test('what the app sees: a fresh context of the installation; a user only on menus, forms and validation', async (fx) => {
  const app = new Hono();
  const seen = async (what: string) => ({
    what, app: context.appName, sub: context.subredditName, subId: context.subredditId, user: context.username, userId: context.userId, post: context.postId,
    currentSubreddit: (await reddit.getCurrentSubreddit()).name, appUserId: (await reddit.getAppUser())?.id,
  });
  route(app, '/internal/cron/tick', () => seen('cron'));
  route(app, '/internal/menu/explain', () => seen('menu'));
  route(app, '/internal/settings/validate/minHorizontal', () => seen('validate'));
  const sim = createSim(done(app), fx);
  sim.install('wallpapers');
  const post = await sim.submit({});
  const base = { app: devvit.name, sub: 'wallpapers', subId: 't5_wallpapers', currentSubreddit: 'wallpapers', appUserId: `t2_${devvit.name}` };
  expect(await sim.runJob('tick')).toEqual({ ...base, what: 'cron' });
  expect(await sim.menu('AWB: explain', { postId: post.id })).toEqual({ ...base, what: 'menu', user: 'mod1', userId: 't2_mod1', post: post.id });
  expect(await sim.validate('minHorizontal', '800x')).toEqual({ ...base, what: 'validate', user: 'mod1', userId: 't2_mod1' });
});

test('advance runs the cron jobs of devvit.json at their minutes; only limits them; the Date is the minute', async (fx) => {
  const runs: [string, number, unknown][] = [];
  const app = new Hono();
  for (const name of ['tick', 'sweep', 'health']) route(app, `/internal/cron/${name}`, (body) => void runs.push([name, (Date.now() - T0) / MINUTE, body]));
  const sim = createSim(done(app), fx);
  sim.install('wallpapers');
  await sim.advance('15m');
  const count = (name: string) => runs.filter(([n]) => n === name).length;
  expect([count('tick'), count('sweep'), count('health')]).toEqual([15, 3, 1]);
  expect(runs.find(([n]) => n === 'health')).toEqual(['health', 15, { name: 'health' }]);
  runs.length = 0;
  await sim.advance('15m', { only: ['health'] });
  expect(runs.map(([name]) => name)).toEqual(['health']);
  expect(Date.now()).toBe(T0 + 30 * MINUTE);
});

test('two installations: each has its own Redis and settings; jobs run in both', async (fx) => {
  const app = new Hono();
  route(app, '/internal/cron/tick', async () => {
    await redis.incrBy('ticks', 1);
    await redis.set('mode', JSON.stringify(await settings.get('mode')));
  });
  const sim = createSim(done(app), fx);
  sim.install('animewallpaper', { mode: 'enforce' });
  sim.install('animephonewallpapers', { mode: 'dry-run' });
  await sim.advance('2m', { only: ['tick'] });
  const texts = async (sub: string) => Object.fromEntries((await sim.keys(sub)).map(({ key, text }) => [key, text]));
  expect(await texts('animewallpaper')).toEqual({ ticks: '2', mode: '["enforce"]' });
  expect(await texts('animephonewallpapers')).toEqual({ ticks: '2', mode: '["dry-run"]' });
  expect(await redis.get('mode')).toBe('["enforce"]'); // the first installation is the harness world
  expect(() => sim.install('animephonewallpapers')).toThrow(/already installed/);
});

test('install settings: devvit.json defaults, a select as an array, and errors for a wrong name, type or option', async (fx) => {
  const sim = createSim(done(new Hono()), fx);
  const inst = sim.install('wallpapers', { mode: 'enforce', minHorizontal: '1920x1080', rateLimitHours: 12 });
  const get = async () =>
    Object.fromEntries(await Promise.all(['mode', 'minHorizontal', 'rateLimitHours', 'rateLimitPosts', 'exceptAuthors', 'sourceComment'].map(async (key) => [key, await settings.get(key)])));
  expect(await get()).toEqual({ mode: ['enforce'], minHorizontal: '1920x1080', rateLimitHours: 12, rateLimitPosts: 4, exceptAuthors: '', sourceComment: false });
  inst.set({ mode: 'dry-run', rateLimitPosts: 3, sourceComment: true });
  expect(await get()).toMatchObject({ mode: ['dry-run'], rateLimitPosts: 3, sourceComment: true, minHorizontal: '1920x1080' });
  expect(() => sim.install('x', { modee: 'off' })).toThrow('unknown setting "modee"');
  expect(() => sim.install('x', { mode: 'enforc' })).toThrow('"mode": "enforc" is not one of off, dry-run, enforce');
  expect(() => sim.install('x', { rateLimitHours: '12' })).toThrow('"rateLimitHours" must be a number');
  expect(() => sim.install('x', { rateLimit: 'yes' })).toThrow('"rateLimit" must be a boolean');
  expect(() => sim.install('x', { minHorizontal: 5 })).toThrow('"minHorizontal" must be a string');
});

test('delivery: duplicate sends a trigger twice, drop never, reorder after the next event or the next advance', async (fx) => {
  const log: string[] = [];
  const app = new Hono();
  route(app, '/internal/triggers/post-submit', (body) => void log.push(`submit ${body.post.id}`));
  route(app, '/internal/triggers/post-flair-update', (body) => void log.push(`flair ${body.post.id}`));
  route(app, '/internal/cron/tick', () => void log.push('tick'));
  const sim = createSim(done(app), fx);
  sim.install('wallpapers');
  const a = await sim.submit({ delivery: 'duplicate' });
  const dropped = await sim.submit({ delivery: 'drop' });
  const c = await sim.submit({ delivery: 'reorder' });
  log.push('--');
  await sim.setFlair(a.id, 'Mobile');
  expect(log).toEqual([`submit ${a.id}`, `submit ${a.id}`, '--', `flair ${a.id}`, `submit ${c.id}`]);
  expect((await reddit.getNewPosts({ subredditName: 'wallpapers' }).all()).map((post) => post.id)).toContain(dropped.id); // a sweep can find it
  log.length = 0;
  const d = await sim.submit({ delivery: 'reorder' });
  await sim.advance('1m', { only: ['tick'] });
  expect(log).toEqual([`submit ${d.id}`, 'tick']);
});

test('an app that answers its own events in a loop is caught', async (fx) => {
  const app = new Hono();
  route(app, '/internal/triggers/post-submit', (body) => reddit.submitComment({ id: body.post.id, text: 'first' }).then(() => undefined));
  route(app, '/internal/triggers/comment-create', (body) => reddit.submitComment({ id: body.post.id, text: 'again' }).then(() => undefined));
  const sim = createSim(done(app), fx);
  sim.install('wallpapers');
  await expect(sim.submit({})).rejects.toThrow(/events keep coming/);
});

test('menu, form and validation requests use the routes, locations and form names of devvit.json', async (fx) => {
  const app = new Hono();
  route(app, '/internal/menu/status', () => ({ showForm: { name: 'info', form: { fields: [] } } }));
  route(app, '/internal/menu/explain', (body) => ({ body }));
  route(app, '/internal/menu/shadow-report', () => ({ showForm: { name: 'nope', form: { fields: [] } } }));
  route(app, '/internal/settings/validate/minHorizontal', (body) => ({ success: /^\d+x\d+$/.test(body.value), body }));
  route(app, '/internal/forms/shadow-report', (body) => ({ showToast: `days ${body.days}` }));
  const sim = createSim(done(app), fx);
  sim.install('wallpapers');
  const post = await sim.submit({});
  expect(await sim.menu('AWB: status')).toEqual({ showForm: { name: 'info', form: { fields: [] } } });
  expect(await sim.menu('AWB: explain', { postId: post.id })).toEqual({ body: { location: 'post', targetId: post.id } });
  await expect(sim.menu('AWB: shadow report')).rejects.toThrow('form "nope" is not in devvit.json');
  await expect(sim.menu('AWB: explain')).rejects.toThrow('needs a postId');
  await expect(sim.menu('AWB: other')).rejects.toThrow('no menu item "AWB: other"');
  expect(await sim.validate('minHorizontal', '800x')).toMatchObject({ success: false, body: { value: '800x', isEditing: false } });
  expect(await sim.validate('minHorizontal', '800x600')).toMatchObject({ success: true });
  await expect(sim.validate('mode', 'enforce')).rejects.toThrow('"mode" has no validation route');
  expect(await sim.form('shadowReport', { days: 3 })).toEqual({ showToast: 'days 3' });
  await expect(sim.form('nope', {})).rejects.toThrow('no form "nope"');
});

test('keys give each written key with its expiry; audit parses the audit entries; modmail lists the alerts; redisCalls counts per request', async (fx) => {
  const app = new Hono();
  route(app, '/internal/cron/tick', async () => {
    await redis.set('post:t3_p1', '{}', { expiration: new Date(Date.now() + 30 * DAY) });
    await redis.zAdd('audit:2026-12-08', { member: JSON.stringify({ evt: 'done' }), score: Date.now() });
    await redis.hSet('health', { lastTickAt: String(Date.now()) });
    await reddit.modMail.createModNotification({ subject: 'tick-stalled', bodyMarkdown: 'x', subredditId: context.subredditId });
  });
  const sim = createSim(done(app), fx);
  sim.install('wallpapers');
  await sim.advance('1m', { only: ['tick'] });
  const keys = await sim.keys();
  expect(keys.map(({ key, type, expiresAt }) => [key, type, expiresAt])).toEqual([
    ['post:t3_p1', 'string', T0 + MINUTE + 30 * DAY], ['audit:2026-12-08', 'zset', undefined], ['health', 'hash', undefined],
  ]);
  expect(await sim.audit()).toEqual([{ evt: 'done' }]);
  expect(sim.modmail()).toEqual([{ id: expect.any(String), subredditId: 't5_wallpapers', subject: '[notification] tick-stalled', bodyMarkdown: 'x' }]);
  expect(sim.redisCalls('tick')).toEqual([3]);
  expect(sim.redisCalls('/internal/cron/tick')).toEqual([3]);
  expect(sim.redisCalls('sweep')).toEqual([]);
});

test('requests that run at the same time are counted apart', async (fx) => {
  const app = new Hono();
  route(app, '/internal/cron/tick', async () => {
    await redis.get('a');
    await redis.get('b');
  });
  const sim = createSim(done(app), fx);
  sim.install('wallpapers');
  await Promise.all([sim.runJob('tick'), sim.runJob('tick')]);
  expect(sim.redisCalls('tick')).toEqual([2, 2]);
});

test('legacyAct: the legacy bot comments, locks and removes, or comments, removes its comment and reports', async (fx) => {
  const deletes: unknown[] = [];
  const app = new Hono();
  route(app, '/internal/triggers/post-delete', (body) => void deletes.push([body.postId, body.source]));
  const sim = createSim(done(app), fx);
  sim.install('wallpapers');
  const [removed, reported] = [await sim.submit({}), await sim.submit({})];
  await sim.legacyAct(removed.id, 'remove', { text: 'Removed for a bad size.' });
  await sim.legacyAct(reported.id, 'report');
  const log = (await reddit.getModerationLog({ subredditName: 'wallpapers', moderatorUsernames: ['AnimewallpaperBot'] }).all()).map((e) => [e.type, e.target?.permalink]);
  const [comment] = await reddit.getComments({ postId: removed.id, depth: 1 }).all();
  expect(await reddit.getPostById(removed.id)).toMatchObject({ removed: true, locked: true, removedBy: 'AnimewallpaperBot', removedByCategory: 'moderator' });
  expect([comment!.body, comment!.authorName, comment!.distinguishedBy, comment!.stickied]).toEqual(['Removed for a bad size.', 'AnimewallpaperBot', 'moderator', true]);
  expect(log.map(([type]) => type)).toEqual(['removecomment', 'sticky', 'distinguish', 'removelink', 'lock', 'sticky', 'distinguish']);
  expect(log[0]![1]).toContain(reported.id.slice(3)); // the shadow report finds the legacy report by the post id in the permalink
  expect(await reddit.getPostById(reported.id)).toMatchObject({ removed: false, modReports: [{ reason: expect.any(String), author: 'AnimewallpaperBot' }] });
  expect(deletes).toEqual([[removed.id, 3]]);
  expect(sim.actions(removed.id)).toEqual([]); // the app did nothing
});

test('modRemove, userDelete and automodFilter send PostDelete with their source; a filter sends it only on request', async (fx) => {
  const deletes: unknown[] = [];
  const app = new Hono();
  route(app, '/internal/triggers/post-delete', (body) => void deletes.push([body.postId, body.source]));
  const sim = createSim(done(app), fx);
  sim.install('wallpapers');
  const [a, b] = [await sim.submit({}), await sim.submit({})];
  await sim.modRemove(a.id);
  await sim.userDelete(b.id);
  const quiet = await sim.automodFilter({ title: 'quiet' });
  const loud = await sim.automodFilter({ title: 'loud', sendDelete: true });
  expect(deletes).toEqual([[a.id, 3], [b.id, 1], [loud.id, 3]]);
  expect(await reddit.getPostById(quiet.id)).toMatchObject({ removed: true, removedByCategory: 'automod_filtered' });
  expect(await reddit.getPostById(a.id)).toMatchObject({ removedBy: 'mod1', removedByCategory: 'moderator' });
  expect(await reddit.getPostById(b.id)).toMatchObject({ authorName: '[deleted]', authorId: undefined, removedByCategory: undefined }); // S2
  await sim.approve(a.id);
  expect(await reddit.getPostById(a.id)).toMatchObject({ approved: true, removed: false, removedByCategory: undefined });
});

test('comment sends CommentCreate with the author; submit with bytes serves them from the fake CDN', async (fx) => {
  const created: unknown[] = [];
  const fetched: number[] = [];
  const app = new Hono();
  route(app, '/internal/triggers/comment-create', (body) => void created.push([body.comment.author, body.comment.body, body.post.id]));
  route(app, '/internal/triggers/post-submit', async (body) => {
    const post = await reddit.getPostById(body.post.id);
    for (const { url } of post.gallery) fetched.push((await (await fetch(url, { headers: { Accept: 'image/jpeg' } })).arrayBuffer()).byteLength);
  });
  const cdn = createCdn();
  const sim = createSim(done(app), fx, { cdn });
  sim.install('wallpapers');
  const post = await sim.submit({ images: [{ width: 1920, height: 1080, bytes: JPEG }, { width: 900, height: 1600, bytes: JPEG }] });
  await sim.comment(post.id, 'alice', 'source: pixiv');
  expect(created).toEqual([['alice', 'source: pixiv', post.id]]);
  expect(fetched).toEqual([10, 10]);
  expect(cdn.requests).toEqual(post.gallery.map(({ url }) => ({ url, accept: 'image/jpeg' })));
});

test('image bytes need the fake CDN', async (fx) => {
  const sim = createSim(done(new Hono()), fx);
  sim.install('wallpapers');
  await expect(sim.submit({ images: [{ width: 1, height: 1, bytes: JPEG }] })).rejects.toThrow('pass { cdn } to createSim');
});

test('a route that fails is an error of the request; the not-simulated message of the world reaches the app', async (fx) => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined); // Hono logs the error of a failed route
  const app = new Hono();
  route(app, '/internal/cron/tick', () => {
    throw new Error('boom');
  });
  route(app, '/internal/cron/sweep', async () => {
    try {
      await reddit.banUser({ subredditName: 'wallpapers', username: 'alice' });
    } catch (error) {
      return { message: String(error) };
    }
  });
  const sim = createSim(done(app), fx);
  sim.install('wallpapers');
  await expect(sim.runJob('tick')).rejects.toThrow('POST /internal/cron/tick gave 500');
  expect(await sim.runJob('sweep')).toEqual({ message: expect.stringContaining('Users.Friend not simulated') });
  await expect(sim.runJob('nope')).rejects.toThrow('no scheduler task "nope"');
});

test('a response that is not JSON is an error: Devvit needs JSON', async (fx) => {
  const app = new Hono();
  app.post('/internal/cron/tick', (c) => c.text('ok'));
  const sim = createSim(done(app), fx);
  sim.install('wallpapers');
  await expect(sim.runJob('tick')).rejects.toThrow('POST /internal/cron/tick: the response is not JSON');
});

test('a registered trigger without a route is an error', async (fx) => {
  const sim = createSim(new Hono(), fx);
  sim.install('wallpapers');
  await expect(sim.submit({})).rejects.toThrow(/POST \/internal\/triggers\/post-submit gave 404.*sim\.unrouted\(\)/);
});

test('unrouted lists the endpoints of devvit.json that the app does not serve', async (fx) => {
  const app = new Hono();
  route(app, '/internal/cron/tick', () => undefined);
  route(app, '/internal/settings/validate/:name', () => ({ success: true }));
  const unrouted = createSim(app, fx).unrouted();
  expect(unrouted).toContain('/internal/triggers/post-submit');
  expect(unrouted).toContain('/internal/menu/status');
  expect(unrouted).toContain('/internal/forms/info');
  expect(unrouted).not.toContain('/internal/cron/tick');
  expect(unrouted.some((path) => path.startsWith('/internal/settings/validate/'))).toBe(false);
});
