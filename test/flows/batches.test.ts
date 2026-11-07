// Reddit reads that depend on the data of one author or one window go in batches of 10: an author with many posts must not start many
// reads at once (the rate limit reads each earlier post of the author; the shadow report reads posts, comments and states).
import { reddit } from '@devvit/web/server';
import { expect, vi } from 'vitest';
import { app } from '../../src/server/app';
import { T0 } from '../sim/clock';
import { createSim } from '../sim/sim';
import { BAD_RESOLUTION, comment, HOUR, infoText, SUB, test } from './helpers';

/** Counts the calls of a read of the Reddit client and the most that are open at one time. A real timer (only Date is fake) gives them time to overlap. */
function overlap(read: 'getPostById' | 'getComments') {
  const stats = { calls: 0, open: 0, most: 0 };
  const original = (reddit[read] as (...args: unknown[]) => unknown).bind(reddit);
  const wait = () => new Promise((resolve) => setTimeout(resolve, 1));
  const enter = async <T>(work: () => Promise<T>) => {
    stats.calls += 1;
    stats.most = Math.max(stats.most, (stats.open += 1));
    await wait();
    try {
      return await work();
    } finally {
      stats.open -= 1;
    }
  };
  if (read === 'getPostById') vi.spyOn(reddit, read).mockImplementation(((...args: unknown[]) => enter(async () => original(...args))) as never);
  // getComments gives a listing at once; its all() is the read
  else {
    vi.spyOn(reddit, read).mockImplementation(((...args: unknown[]) => {
      const listing = original(...args) as { all: () => Promise<unknown> };
      return new Proxy(listing, { get: (target, name) => (name === 'all' ? () => enter(() => target.all()) : Reflect.get(target, name)) });
    }) as never);
  }
  return stats;
}

test('the rate limit reads the 25 earlier posts of the author 10 at a time', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'dry-run', rateLimit: true, rateLimitHours: 24, rateLimitPosts: 100 });
  for (let i = 0; i < 25; i++) await sim.submit({ author: 'alice' });
  await sim.advance('5m', { only: ['tick'] }); // 5 posts in a tick
  await sim.submit({ author: 'alice' });
  const reads = overlap('getPostById');
  await sim.advance('1m', { only: ['tick'] });
  expect(reads.calls).toBe(1 + 25); // the post itself, and each earlier post
  expect(reads.most).toBe(10);
});

test('the shadow report reads the posts that the legacy bot acted on, and their comments, 10 at a time', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'dry-run' });
  for (let i = 0; i < 25; i++) {
    const post = await sim.submit({ images: [{ width: 1920, height: 1080 }], delivery: 'drop' }); // AWB has no record: Reddit gives the time
    await sim.legacyAct(post.id, 'remove', { text: comment(BAD_RESOLUTION) });
  }
  vi.setSystemTime(T0 + 2 * HOUR);
  const posts = overlap('getPostById');
  const comments = overlap('getComments');
  const lines = infoText(await sim.form('shadowReport', { days: 7 })).split('\n');
  expect(lines).toContain('Posts compared: 25');
  expect([posts.calls, posts.most]).toEqual([25, 10]);
  expect([comments.calls, comments.most]).toEqual([20, 10]); // at most 20 comments are read
});
