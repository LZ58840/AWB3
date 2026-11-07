// Plan 7.3 step 7 and 7.4 "Redis": every key has its TTL (5.5), no value holds a title, a body or a URL, and each request
// stays within its Redis call budget. `seen:` holds the ids of image posts by week (backfill input in 3.1).
import { reddit } from '@devvit/web/server';
import { expect, vi } from 'vitest';
import { app } from '../../src/server/app';
import { isoWeek } from '../../src/server/store';
import { T0 } from '../sim/clock';
import { createSim } from '../sim/sim';
import { DAY, HOUR, killAt, MINUTE, recordOf, SUB, test, type Fx } from './helpers';

const small = { width: 1600, height: 1200, url: 'https://i.redd.it/abc123.png' };
const all = {
  mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080', rateLimit: true, rateLimitHours: 24, rateLimitPosts: 4, sourceComment: true, sourceHours: 1,
};
const TITLE = 'SECRET-TITLE-OF-A-POST';

/** A tick has removed one post, passed one and passed a text post. */
async function busyTick(fx: Fx) {
  const sim = createSim(app, fx);
  sim.install(SUB, all);
  const removed = await sim.submit({ title: TITLE, author: 'alice', images: [small] });
  const passed = await sim.submit({ title: TITLE, author: 'bob', images: [{ width: 1920, height: 1080, url: 'https://i.redd.it/big1.png' }] });
  const text = await sim.submit({ title: TITLE, author: 'carol' });
  await sim.advance('2m');
  return { sim, removed, passed, text };
}

test('every key has the TTL of plan 5.5, except the queue and the health hash', async (fx) => {
  const { sim, removed, passed, text } = await busyTick(fx);
  const write = T0 + MINUTE; // the tick that wrote the keys
  const keys = Object.fromEntries((await sim.keys()).map(({ key, expiresAt }) => [key, expiresAt]));
  expect(keys).toEqual({
    due: undefined,
    health: undefined,
    [`post:${removed.id}`]: write + 30 * DAY,
    [`post:${passed.id}`]: write + 30 * DAY,
    [`post:${text.id}`]: write + 30 * DAY,
    'rl:t2_alice': write + 24 * HOUR,
    'rl:t2_bob': write + 24 * HOUR,
    'rl:t2_carol': write + 24 * HOUR,
    'audit:2026-12-08': write + 30 * DAY,
    'seen:2026-50': Date.parse('2027-07-08T10:01:00Z'), // repostMonths 6 and 1 month
  });
});

test('the tick lock ends by itself within a minute, so that a killed tick does not stop the next one for long', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, all);
  await sim.submit({ images: [small] });
  const killed = killAt(reddit, 'getPostById');
  void sim.runJob('tick');
  await killed;
  const lock = (await sim.keys()).find(({ key }) => key === 'lock:tick');
  expect(lock?.expiresAt).toBeGreaterThan(Date.now());
  expect(lock?.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
});

test('no value holds a title, a body or a URL', async (fx) => {
  const { sim } = await busyTick(fx);
  await sim.advance('2h'); // the source checks run too
  const values = (await sim.keys()).map(({ text }) => text).join('\n');
  expect(values).not.toContain(TITLE);
  expect(values).not.toMatch(/https?:|redd\.it|reddit\.com|Thank you for contributing|too small/);
});

test('a tick with 5 posts that are removed uses at most 250 Redis calls; an idle tick, a trigger and a sweep use a few', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { ...all, rateLimitPosts: 1 });
  const seeded = [];
  for (let i = 0; i < 4; i++) seeded.push(await sim.submit({ author: 'alice', images: [small], delivery: 'drop' })); // 4 posts of one author in the history
  await sim.runJob('sweep');
  await sim.runJob('tick'); // the 4 earlier posts
  const before = sim.redisCalls('tick').length;
  for (let i = 0; i < 5; i++) await sim.submit({ author: 'alice', images: [small], title: `${i}` });
  await sim.runJob('tick');
  const [busy] = sim.redisCalls('tick').slice(before);
  expect(busy).toBeLessThanOrEqual(250);
  await sim.runJob('tick');
  const idle = sim.redisCalls('tick').at(-1);
  expect(idle).toBeLessThanOrEqual(9); // the lock (1), the applied repostMonths (1), the queue (1), lastTickAt (1), and the unlock, a transaction (5)
  expect(Math.max(...sim.redisCalls('/internal/triggers/post-submit'))).toBe(1);
  expect(Math.max(...sim.redisCalls('sweep'))).toBeLessThanOrEqual(10);
  expect(seeded).toHaveLength(4);
});

test('seen: holds the ids of image posts by week and by creation time; text and link posts are not in it', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'dry-run' });
  const image = await sim.submit({ images: [{ width: 1920, height: 1080 }] });
  await sim.submit({ kind: 'link', url: 'https://example.com/a.jpg' });
  await sim.submit({});
  const gallery = await sim.submit({ images: [{ width: 1920, height: 1080 }, { width: 900, height: 1600 }] });
  await sim.advance('2m');
  const seen = (await sim.keys()).find(({ key }) => key === 'seen:2026-50');
  expect(JSON.parse(seen!.text)).toEqual([
    { member: image.id, score: T0 },
    { member: gallery.id, score: T0 },
  ]);
});

test('seen: the TTL follows the repostMonths setting: 8 months and 1 month', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'dry-run', repostMonths: 8 });
  await sim.submit({ images: [{ width: 1920, height: 1080 }] });
  await sim.advance('2m');
  expect((await sim.keys()).find(({ key }) => key === 'seen:2026-50')?.expiresAt).toBe(Date.parse('2027-09-08T10:01:00Z'));
});

test('rl: an entry that is older than the window leaves the history at the next write', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', rateLimit: true, rateLimitHours: 24, rateLimitPosts: 5 });
  const first = await sim.submit({ author: 'alice' });
  await sim.advance('2m');
  await sim.advance('23h', { only: [] });
  const second = await sim.submit({ author: 'alice' });
  await sim.advance('2m');
  await sim.advance('2h', { only: [] }); // the first post is now 25 hours old, and the key lives on
  const third = await sim.submit({ author: 'alice' });
  await sim.advance('2m');
  const rl = (await sim.keys()).find(({ key }) => key === 'rl:t2_alice');
  expect((JSON.parse(rl!.text) as { member: string }[]).map(({ member }) => member)).toEqual([second.id, third.id]);
  expect(first.id).not.toBe(second.id);
});

test('the ISO week of a time: the week of Thursday decides the year', () => {
  const cases: [string, string][] = [
    ['2026-12-08T10:00:00Z', '2026-50'],
    ['2026-12-31T23:59:59Z', '2026-53'],
    ['2027-01-03T12:00:00Z', '2026-53'],
    ['2027-01-04T00:00:00Z', '2027-01'],
    ['2024-12-30T08:00:00Z', '2025-01'],
    ['2021-01-03T08:00:00Z', '2020-53'],
    ['2026-01-01T00:00:00Z', '2026-01'],
  ];
  for (const [time, week] of cases) expect(isoWeek(Date.parse(time)), time).toBe(week);
});

test('rl: is written for every post that has an author, also when the rate rule is off: the default window of 24 hours; a rule of 12 hours sets 12 hours', async (fx) => {
  const sim = createSim(app, fx);
  const inst = sim.install(SUB, { mode: 'dry-run' });
  await sim.submit({ author: 'alice' });
  await sim.advance('1m');
  const ttl = async (name: string) => (await sim.keys()).find(({ key }) => key === `rl:t2_${name}`)?.expiresAt;
  expect(await ttl('alice')).toBe(T0 + MINUTE + 24 * HOUR); // legacy counted all posts of an author: the rule can be switched on later
  inst.set({ rateLimit: true, rateLimitHours: 12 });
  await sim.submit({ author: 'bob' });
  await sim.advance('1m');
  expect(await ttl('bob')).toBe(T0 + 2 * MINUTE + 12 * HOUR);
});

test('mode off does nothing for a post: no `seen:`, `rl:` or audit key, no log line; the post record stays, because it is what D6 needs', async (fx) => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'off', rateLimit: true, rateLimitHours: 24 });
  const post = await sim.submit({ author: 'alice', images: [{ width: 1920, height: 1080 }] });
  await sim.advance('2m');
  // Besides the queue and the health hash only the record of the post: its status keeps the sweep from queueing the post again, so that a
  // later switch to enforce does not check the posts of the last 48 hours (D6). The record holds an id, a status and a time, no user data.
  expect((await sim.keys()).map(({ key }) => key).sort()).toEqual(['due', 'health', `post:${post.id}`]);
  expect(await recordOf(sim, post.id)).toMatchObject({ status: 'skipped:mode-off', firstMode: 'off' });
  expect(await sim.audit()).toEqual([]);
  expect(log).not.toHaveBeenCalled();
});
