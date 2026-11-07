// Plan 5.3 "Lease" and "Finish", after the review of the 3.0 server: the lease is a compare-and-set on the score of the item (two ticks
// cannot both take it), a release or a lease that EXEC aborts is not taken as done, a transaction that does not run is ended, and a tick
// gives back only its own lock. The harness has no WATCH semantics (RedisMock.Exec ignores the watched keys), so an aborted EXEC is made by
// answering `{ response: [] }`, as Redis answers nil.
import { reddit, redis } from '@devvit/web/server';
import { expect, vi } from 'vitest';
import { app } from '../../src/server/app';
import { lease, release } from '../../src/server/store';
import { A4 } from '../core/appendix';
import { createSim } from '../sim/sim';
import { BAD_RESOLUTION, comment, deferred, holdAt, REMOVAL, SUB, test, type Fx } from './helpers';

const small = { width: 1600, height: 1200, url: 'https://i.redd.it/abc123.png' };
const rule = { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080', sourceComment: true, sourceHours: 1 };
const removal = REMOVAL(comment(BAD_RESOLUTION));
const queued = async () => (await redis.zRange('due', 0, -1, { by: 'rank' })).map(({ member }) => member);

/** The first call of redis.hGet for `field` waits until `release()`; the promise settles when the call starts. */
function holdHGet(field: string) {
  const reached = deferred();
  const gate = deferred();
  const original = redis.hGet.bind(redis);
  let held = false;
  vi.spyOn(redis, 'hGet').mockImplementation(((key: string, name: string) => {
    if (name !== field || held) return original(key, name);
    held = true;
    reached.resolve();
    return gate.promise.then(() => original(key, name));
  }) as never);
  return { reached: reached.promise, release: gate.resolve };
}

/** The next EXECs of the transactions of the first installation: `pass` of them run, then `abort` of them answer like an aborted EXEC. */
function abortExec(fx: Fx, pass: number, abort: number) {
  const plugin = fx.mocks.redis.plugin as unknown as Record<string, (...args: unknown[]) => unknown>;
  const spy = vi.spyOn(plugin, 'Exec');
  const run = spy.getMockImplementation() ?? plugin.Exec!.bind(plugin);
  for (let i = 0; i < pass; i++) spy.mockImplementationOnce(run);
  for (let i = 0; i < abort; i++) spy.mockImplementationOnce((async () => ({ response: [] })) as never);
}

/**
 * Tick A has read the item and stops before it leases it. Its lock has run out, so tick B starts, leases the item, and stops before its
 * first comment. Then A goes on, and the test lets B finish.
 */
async function interleave(fx: Fx) {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  const holdA = holdHGet('appUserId'); // the first call of tick A after it has read the item
  const a = sim.runJob('tick');
  await holdA.reached;
  await redis.del('lock:tick'); // the lock of A ran out
  const holdB = holdAt(reddit, 'submitComment');
  const b = sim.runJob('tick');
  await holdB.reached;
  return { sim, post, holdA, holdB, a, b };
}

test('two ticks that read the same item: the one that leases first does the work, the other finds the lease taken (compare-and-set)', async (fx) => {
  const { sim, post, holdA, holdB, a, b } = await interleave(fx);
  holdA.release();
  await a; // the lease of A fails: A has nothing to do
  holdB.release();
  await b;
  expect(sim.actions(post.id)).toEqual(removal); // 1 comment, 1 distinguish, 1 lock, 1 removal
  expect(await queued()).toEqual([]);
});

test('a tick that ends after its lock ran out does not delete the lock of the tick that took over', async (fx) => {
  const { holdA, holdB, a, b } = await interleave(fx);
  holdA.release();
  await a;
  expect(await redis.get('lock:tick')).toBeDefined(); // the lock of B
  holdB.release();
  await b;
  expect(await redis.get('lock:tick')).toBeUndefined(); // B gave it back
});

test('a lease whose EXEC aborts (another client changed the queue) is not taken: the item is leased by the next try of the same tick', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  abortExec(fx, 0, 1);
  await sim.runJob('tick');
  expect(sim.actions(post.id)).toEqual(removal);
  expect(await queued()).toEqual([]);
});

test('a release whose EXEC aborts is tried again: the finished item leaves the queue', async (fx) => {
  const item = { kind: 'new', postId: 't3_x' } as const;
  await redis.zAdd('due', { member: 'new:t3_x', score: 1 });
  const leased = (await lease(item, 10))!;
  abortExec(fx, 0, 2); // the first two tries abort
  await release(item, leased);
  expect(await queued()).toEqual([]);
  await redis.zAdd('due', { member: 'new:t3_x', score: 1 });
  const again = (await lease(item, 10))!;
  abortExec(fx, 0, 5); // all the tries abort: the item stays, and its lease ends by itself
  await release(item, again, 100);
  expect(await queued()).toEqual(['new:t3_x']);
  expect(await redis.zScore('due', 'new:t3_x')).toBe(10 + 2 * 60_000);
});

test('lease takes an item that is due; an item that is leased, not due yet or unknown is refused', async () => {
  const item = { kind: 'src', postId: 't3_x' } as const;
  expect(await lease(item, 1000)).toBeUndefined(); // unknown
  await redis.zAdd('due', { member: 'src:t3_x', score: 5000 });
  expect(await lease(item, 1000)).toBeUndefined(); // not due yet
  expect(await redis.zScore('due', 'src:t3_x')).toBe(5000);
  expect(await lease(item, 5000)).toBe(5000 + 120_000);
  expect(await lease(item, 5000)).toBeUndefined(); // leased
  expect(await redis.zScore('due', 'src:t3_x')).toBe(5000 + 120_000);
});

test('a transaction that does not run is ended: when a read fails between WATCH and EXEC, the transaction is discarded', async (fx) => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  await sim.submit({ images: [small] });
  const discard = vi.spyOn(fx.mocks.redis.plugin, 'Discard');
  vi.spyOn(redis, 'zScore').mockRejectedValueOnce(new Error('Redis timed out'));
  await sim.runJob('tick'); // the tick goes on: the lease failed, the item comes back
  expect(discard).toHaveBeenCalledTimes(1);
  await sim.advance('1m');
  expect(await queued()).toEqual([]);
});

test('a source check decides once: when its release fails and the lease runs out, the second run adds no decision', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [{ width: 1920, height: 1080 }] });
  await sim.advance('1m'); // the `new:` item passes; the `src:` item is due at 1 hour
  await sim.advance('59m', { only: [] });
  abortExec(fx, 1, 5); // the lease runs; all 5 tries of the release abort
  await sim.runJob('tick');
  expect(sim.actions(post.id)).toEqual(REMOVAL(A4));
  expect(await queued()).toEqual([`src:${post.id}`]);
  await sim.advance('3m'); // the lease of 2 minutes runs out
  expect(await queued()).toEqual([]);
  const decisions = (await sim.audit()).filter((entry) => (entry as { kind: string; evt: string }).kind === 'src' && (entry as { evt: string }).evt === 'decision');
  expect(decisions).toHaveLength(1);
});
