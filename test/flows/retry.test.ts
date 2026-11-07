// Plan 5.3 counters and 5.4 health, after the review of the 3.0 server: what a failing Reddit or Redis call does to an item and to the tick.
// An error retries after 1 minute, then after 15 minutes (a Reddit outage of a few minutes must not drop a post); only the SDK's "no post"
// means that a post is gone; a failing modmail or a failing item does not stop the tick; health.lastError says what failed last.
import { reddit, redis } from '@devvit/web/server';
import { expect, vi } from 'vitest';
import { app } from '../../src/server/app';
import { T0 } from '../sim/clock';
import { createSim } from '../sim/sim';
import { BAD_RESOLUTION, comment, infoText, MINUTE, recordOf, REMOVAL, SUB, test } from './helpers';

const small = { width: 1600, height: 1200, url: 'https://i.redd.it/abc123.png' };
const rule = { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080' };
const removal = REMOVAL(comment(BAD_RESOLUTION));
const queuedAt = (id: string) => redis.zScore('due', `new:${id}`);

test('an outage of 4 minutes does not drop a post: the retries wait 1 minute, then 15 minutes', async (fx) => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  const outage = vi.spyOn(reddit, 'getPostById').mockRejectedValue(new Error('HTTP 503'));
  await sim.advance('4m'); // the attempts of minute 1 and 2 fail; the next one is due 15 minutes after minute 2
  expect(await recordOf(sim, post.id)).toMatchObject({ status: 'pending', items: { new: { errors: 2 } } });
  expect(await queuedAt(post.id)).toBe(T0 + 17 * MINUTE);
  outage.mockRestore();
  await sim.advance('13m');
  expect(sim.actions(post.id)).toEqual(removal);
  expect(await recordOf(sim, post.id)).toMatchObject({ status: 'done', items: { new: { errors: 2 } } });
  expect(sim.modmail()).toEqual([]);
  expect((await sim.audit()).filter((entry) => (entry as { evt: string }).evt !== 'shadow')).toEqual([expect.objectContaining({ evt: 'decision', action: 'remove' })]); // no error entry
});

test('3 errors in a row still stop the post, 17 minutes after the first: status error, an audit entry and one alert', async (fx) => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  vi.spyOn(reddit, 'getPostById').mockRejectedValue(new Error('HTTP 503'));
  await sim.advance('16m');
  expect((await recordOf(sim, post.id))?.status).toBe('pending');
  await sim.advance('1m');
  expect(await recordOf(sim, post.id)).toMatchObject({ status: 'error', items: { new: { errors: 3 } } });
  expect(sim.modmail()).toEqual([expect.objectContaining({ subject: expect.stringContaining('errors') })]);
});

test('only "no post" of the SDK means that a post is gone: another error of getPostById is retried, whatever its text says', async (fx) => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  vi.spyOn(reddit, 'getPostById').mockRejectedValueOnce(new Error('HTTP 404 Not Found'));
  await sim.advance('1m');
  expect(await recordOf(sim, post.id)).toMatchObject({ status: 'pending', items: { new: { errors: 1 } } }); // not skipped:deleted
  await sim.advance('1m');
  expect(sim.actions(post.id)).toEqual(removal);
});

test('a candidate of the rate limit that Reddit fails to read is a retry of the post, not a deleted candidate', async (fx) => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', rateLimit: true, rateLimitHours: 24, rateLimitPosts: 1 });
  const first = await sim.submit({ author: 'alice' });
  await sim.advance('1m');
  const second = await sim.submit({ author: 'alice' });
  const original = reddit.getPostById.bind(reddit);
  vi.spyOn(reddit, 'getPostById').mockImplementation(async (id) => {
    if (id === first.id) throw new Error('HTTP 404 Not Found');
    return original(id);
  });
  await sim.advance('1m');
  expect(sim.actions(second.id)).toEqual([]);
  expect(await recordOf(sim, second.id)).toMatchObject({ status: 'pending', items: { new: { errors: 1 } } });
});

test('a modmail that fails does not stop the health job: the error goes to the log, the alert is tried again at the next run', async (fx) => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'dry-run', resolutionBad: true }); // the rule has no size: the config alert is due
  const failing = vi.spyOn(reddit.modMail, 'createModNotification').mockRejectedValue(new Error('HTTP 500 at https://oauth.reddit.com/api/mod'));
  await sim.advance('1m');
  expect(await sim.runJob('health')).toEqual({}); // no error reaches Devvit
  expect(sim.modmail()).toEqual([]);
  expect(error.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('alert'))[0]).toContain('HTTP 500 at <url>');
  expect((await sim.audit()).filter((entry) => (entry as { evt: string }).evt === 'shadow')).toHaveLength(1); // the rest of health ran
  failing.mockRestore();
  await sim.runJob('health');
  expect(sim.modmail()).toEqual([expect.objectContaining({ subject: expect.stringContaining('config') })]);
});

test('an item that fails outside its attempt (Redis fails on its record) does not stop the tick: the next item is done, the item comes back in a minute', async (fx) => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const [a, b] = [await sim.submit({ images: [small] }), await sim.submit({ images: [small] })];
  const original = redis.get.bind(redis);
  let failed = false;
  vi.spyOn(redis, 'get').mockImplementation(async (key: string) => {
    if (key === `post:${a.id}` && !failed) {
      failed = true;
      throw new Error('Redis is down');
    }
    return original(key);
  });
  await sim.runJob('tick');
  expect(sim.actions(a.id)).toEqual([]);
  expect(sim.actions(b.id)).toEqual(removal);
  const health = JSON.parse((await sim.keys()).find(({ key }) => key === 'health')!.text) as { lastTickAt?: string; lastError?: string };
  expect(health).toHaveProperty('lastTickAt'); // the tick ended
  expect(health.lastError).toBe(`2026-12-08 10:00 new:${a.id}: Redis is down`);
  await sim.advance('1m');
  expect(sim.actions(a.id)).toEqual(removal);
});

test('health.lastError names the item and the reason of the last error, with no URL; AWB: status shows it', async (fx) => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  vi.spyOn(reddit, 'submitComment').mockRejectedValueOnce(new Error('HTTP 500 at https://oauth.reddit.com/api/comment'));
  await sim.advance('1m');
  const health = JSON.parse((await sim.keys()).find(({ key }) => key === 'health')!.text) as { lastError: string };
  expect(health.lastError).toBe(`2026-12-08 10:01 new:${post.id}: HTTP 500 at <url>`);
  expect(infoText(await sim.menu('AWB: status')).split('\n')).toContain(`Last error: 2026-12-08 10:01 new:${post.id}: HTTP 500 at <url>`);
});
