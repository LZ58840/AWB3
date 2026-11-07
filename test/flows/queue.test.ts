// Plan 7.3 step 4: queue safety. Duplicates, two ticks at once, a request that Devvit kills, errors, and the budget of a tick.
// A kill is a call that never returns: the request is abandoned, and nothing of the app runs afterwards.
import { reddit, redis } from '@devvit/web/server';
import { expect, vi } from 'vitest';
import { app } from '../../src/server/app';
import { postSubmit } from '../sim/events';
import { createSim, type Sim } from '../sim/sim';
import { BAD_RESOLUTION, comment, deferred, HOUR, holdAt, killAt, recordOf, REMOVAL, SUB, test } from './helpers';

const small = { width: 1600, height: 1200, url: 'https://i.redd.it/abc123.png' };
const rule = { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080' };
const removal = REMOVAL(comment(BAD_RESOLUTION));
const queued = async () => (await redis.zRange('due', 0, -1, { by: 'rank' })).map(({ member }) => member);

/** Reddit sends the PostSubmit trigger of a post again. */
const resend = (sim: Sim, postId: string) =>
  app.request('/internal/triggers/post-submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(postSubmit(sim.world.posts.get(postId)!, sim.world.addUser('alice'), sim.world.subs.get(SUB)!)),
  });

test('the same trigger twice gives one comment, one lock and one removal', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small], delivery: 'duplicate' });
  await sim.advance('3m');
  expect(sim.actions(post.id)).toEqual(removal);
});

test('a trigger queues the post at the time that it arrives, whatever createdAt of the payload says (its unit is checked by S3)', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small], delivery: 'drop' });
  const body = postSubmit(sim.world.posts.get(post.id)!, sim.world.addUser('alice'), sim.world.subs.get(SUB)!);
  for (const createdAt of [0, 1_796_719_200 /* seconds */, Date.now() + 86_400_000 /* tomorrow */]) {
    await app.request('/internal/triggers/post-submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, post: { ...body.post, createdAt } }),
    });
    expect(await redis.zScore('due', `new:${post.id}`), String(createdAt)).toBe(Date.now());
  }
});

test('a trigger that arrives after the work is done changes nothing', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  await sim.advance('2m');
  await resend(sim, post.id);
  expect(await queued()).toEqual([`new:${post.id}`]);
  await sim.advance('2m');
  expect(sim.actions(post.id)).toEqual(removal);
  expect(await queued()).toEqual([]);
});

test('two ticks at the same time work on each post once', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const posts = [await sim.submit({ images: [small] }), await sim.submit({ images: [small] }), await sim.submit({ images: [small] })];
  await Promise.all([sim.runJob('tick'), sim.runJob('tick')]);
  for (const post of posts) expect(sim.actions(post.id)).toEqual(removal);
});

test('a tick that finds the lock taken stops after one Redis call', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  const hold = holdAt(reddit, 'getPostById');
  const first = sim.runJob('tick');
  await hold.reached;
  await sim.runJob('tick');
  expect(sim.redisCalls('tick')).toEqual([1]); // the second tick asked for the lock and stopped
  hold.release();
  await first;
  expect(sim.actions(post.id)).toEqual(removal);
});

test('a second tick that starts while the lock is lost does not touch a post that the first tick works on (lease)', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  const hold = holdAt(reddit, 'getPostById');
  const first = sim.runJob('tick');
  await hold.reached;
  await redis.del('lock:tick'); // the lock of the first tick ran out
  await sim.runJob('tick');
  expect(sim.actions(post.id)).toEqual([]);
  hold.release();
  await first;
  expect(sim.actions(post.id)).toEqual(removal);
});

test('a request that is killed counts as a kill; the post is checked again after the lease of 2 minutes', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  const killed = killAt(reddit, 'getPostById');
  void sim.runJob('tick');
  await killed;
  await sim.advance('1m'); // the lock (45 s) is gone, the lease (2 min) is not
  expect(sim.actions(post.id)).toEqual([]);
  expect(await queued()).toEqual([`new:${post.id}`]);
  await sim.advance('1m');
  expect(sim.actions(post.id)).toEqual(removal);
  expect((await recordOf(sim, post.id))?.items.new).toMatchObject({ leases: 2, kills: 1, open: false });
  expect(await queued()).toEqual([]);
});

test('3 kills stop the post: status error, an audit entry and one alert to the mods; no action', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  for (let attempt = 0; attempt < 3; attempt++) {
    const killed = killAt(reddit, 'getPostById');
    void sim.runJob('tick');
    await killed;
    await sim.advance('2m', { only: [] }); // lock and lease run out
  }
  expect(sim.modmail()).toEqual([]);
  await sim.runJob('tick'); // this lease finds the 3rd kill
  expect(sim.actions(post.id)).toEqual([]);
  expect(await recordOf(sim, post.id)).toMatchObject({ status: 'error', items: { new: { kills: 3, leases: 4 } } });
  expect(await sim.audit()).toEqual([expect.objectContaining({ postId: post.id, kind: 'new', evt: 'error', reason: 'killed' })]);
  expect(sim.modmail()).toEqual([expect.objectContaining({ subject: expect.stringContaining('errors'), bodyMarkdown: expect.stringContaining(post.id) })]);
  expect(await queued()).toEqual([]);
  await sim.advance('5m');
  expect(sim.actions(post.id)).toEqual([]);
});

test('a kill after the comment and the distinguish: the retry does the lock and the removal, and no call twice', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  const original = reddit.getPostById.bind(reddit);
  vi.spyOn(reddit, 'getPostById').mockImplementationOnce(async (id) => {
    const found = await original(id);
    found.lock = () => new Promise(() => undefined); // the request dies in the lock call
    return found;
  });
  void sim.runJob('tick');
  await vi.waitFor(() => expect(sim.actions(post.id).map(({ type }) => type)).toEqual(['comment', 'distinguish']));
  await sim.advance('3m');
  expect(sim.actions(post.id)).toEqual(removal);
});

test('a kill after Reddit made the comment, before the app saved it: the retry finds the comment and posts no second one', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  const submit = reddit.submitComment.bind(reddit);
  const reached = new Promise<void>((resolve) => {
    vi.spyOn(reddit, 'submitComment').mockImplementationOnce(async (options) => {
      await submit(options); // the comment exists; the answer never arrives
      resolve();
      return new Promise(() => undefined);
    });
  });
  void sim.runJob('tick');
  await reached;
  await sim.advance('3m');
  expect(sim.actions(post.id)).toEqual(removal);
});

test('a kill after the removal, before the audit entry: the retry writes the decision and does not skip its own removal', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  const zAdd = redis.zAdd.bind(redis);
  const reached = deferred();
  vi.spyOn(redis, 'zAdd').mockImplementation(((key: string, ...members: never[]) => {
    if (!key.startsWith('audit:')) return zAdd(key, ...members);
    reached.resolve();
    return new Promise(() => undefined); // the request dies when it writes the audit entry
  }) as never);
  void sim.runJob('tick');
  await reached.promise;
  vi.mocked(redis.zAdd).mockRestore();
  expect(sim.actions(post.id)).toEqual(removal);
  expect(await sim.audit()).toEqual([]);
  await sim.advance('3m');
  expect(sim.actions(post.id)).toEqual(removal); // no second call
  expect(await sim.audit()).toEqual([expect.objectContaining({ postId: post.id, evt: 'decision', action: 'remove', rules: ['resolutionBad'] })]);
  expect(await recordOf(sim, post.id)).toMatchObject({ status: 'done', items: { new: { kills: 1, removed: true } } });
});

test('a trigger that re-queues a post during the work is kept: the post is looked at again (re-queue, lease)', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  const hold = holdAt(reddit, 'getPostById');
  const tick = sim.runJob('tick');
  await hold.reached;
  await resend(sim, post.id);
  hold.release();
  await tick;
  expect(sim.actions(post.id)).toEqual(removal);
  expect((await recordOf(sim, post.id))?.items.new).toMatchObject({ leases: 2, kills: 0 }); // the second look found the work done
  expect(await queued()).toEqual([]);
});

test('a failing Reddit call is tried again after a minute', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(reddit, 'submitComment').mockRejectedValueOnce(new Error('HTTP 500'));
  await sim.advance('1m');
  expect(sim.actions(post.id)).toEqual([]);
  expect(await queued()).toEqual([`new:${post.id}`]);
  await sim.advance('1m');
  expect(sim.actions(post.id)).toEqual(removal);
  expect((await recordOf(sim, post.id))?.items.new).toMatchObject({ errors: 1, leases: 2, open: false });
  expect(sim.modmail()).toEqual([]);
});

test('3 failures stop the post: status error and an alert; a later success resets the error streak', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(reddit, 'submitComment').mockRejectedValue(new Error('HTTP 500 at https://oauth.reddit.com/api/comment'));
  await sim.advance('17m'); // the attempts are at minutes 1, 2 and 17 (retries after 1 and 15 minutes)
  expect(await recordOf(sim, post.id)).toMatchObject({ status: 'error', items: { new: { errors: 3 } } });
  const [entry] = ((await sim.audit()) as { evt: string; reason: string }[]).filter(({ evt }) => evt === 'error');
  expect(entry).toMatchObject({ evt: 'error' });
  expect(entry!.reason).not.toContain('https://'); // no URL in a stored value
  expect(sim.modmail()).toHaveLength(1);
  expect((await sim.keys()).find(({ key }) => key === 'health')?.text).toContain('"errorStreak":"1"');
  vi.mocked(reddit.submitComment).mockRestore();
  const next = await sim.submit({ images: [small] });
  await sim.advance('1m');
  expect(sim.actions(next.id)).toEqual(removal);
  expect((await sim.keys()).find(({ key }) => key === 'health')?.text).toContain('"errorStreak":"0"');
});

test('an alert is sent once for each reason in 6 hours', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(reddit, 'submitComment').mockRejectedValue(new Error('HTTP 500'));
  await sim.submit({ images: [small] });
  await sim.submit({ images: [small] });
  await sim.advance('17m'); // each post has its 3rd error at minute 17
  expect(sim.modmail()).toHaveLength(1); // two posts stopped, one alert
  await sim.advance(`${5 * 60}m`, { only: [] });
  await sim.submit({ images: [small] });
  await sim.advance('17m');
  expect(sim.modmail()).toHaveLength(1); // the 3rd post stopped 5 hours and 17 minutes after the alert
  await sim.advance(`${HOUR / 60_000}m`, { only: [] });
  await sim.submit({ images: [small] });
  await sim.advance('17m');
  expect(sim.modmail()).toHaveLength(2);
});

test('the last tick time is written when a tick ends, not when it starts', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  await sim.submit({ images: [small] });
  const killed = killAt(reddit, 'getPostById');
  void sim.runJob('tick');
  await killed;
  expect((await sim.keys()).find(({ key }) => key === 'health')?.text ?? '').not.toContain('lastTickAt');
  await sim.advance('3m');
  const health = JSON.parse((await sim.keys()).find(({ key }) => key === 'health')!.text) as { lastTickAt: string };
  expect(Number(health.lastTickAt)).toBe(Date.now());
});

test('a tick works on at most 5 posts', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const posts = [];
  for (let i = 0; i < 7; i++) posts.push(await sim.submit({ images: [small] }));
  await sim.runJob('tick');
  expect(posts.map((post) => sim.actions(post.id).length > 0)).toEqual([true, true, true, true, true, false, false]);
  await sim.runJob('tick');
  expect(posts.map((post) => sim.actions(post.id).length > 0)).toEqual(Array(7).fill(true));
});

test('a tick starts no new post when 15 seconds of its 30 are gone', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const [first, second] = [await sim.submit({ images: [small] }), await sim.submit({ images: [small] })];
  const original = reddit.getPostById.bind(reddit);
  vi.spyOn(reddit, 'getPostById').mockImplementationOnce(async (id) => {
    vi.setSystemTime(Date.now() + 20_000); // a slow call
    return original(id);
  });
  await sim.runJob('tick');
  expect(sim.actions(first.id)).toEqual(removal);
  expect(sim.actions(second.id)).toEqual([]);
  await sim.runJob('tick');
  expect(sim.actions(second.id)).toEqual(removal);
});
