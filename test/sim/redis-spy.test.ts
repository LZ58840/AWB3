import { createDevvitTest } from '@devvit/test/server/vitest';
import { redis } from '@devvit/web/server';
import { expect } from 'vitest';
import { createClock, T0 } from './clock';
import { spyRedis } from './redis-spy';

const test = createDevvitTest();

test('written lists each key that a write creates, in order and once; reads and deletes add none', async ({ mocks }) => {
  const spy = spyRedis(mocks.redis);
  await redis.set('s', '1');
  await redis.set('s', '2');
  await redis.hSet('h', { f: 'v' });
  await redis.zAdd('z', { member: 'm', score: 1 });
  await redis.incrBy('n', 1);
  await redis.mSet({ m1: 'x', m2: 'y' });
  await redis.hIncrBy('hn', 'f', 1);
  await redis.zIncrBy('zn', 'm', 1);
  await redis.rename('s', 'renamed');
  await redis.get('read-only');
  await redis.del('h');
  await redis.expire('e', 10);
  expect(spy.written()).toEqual(['s', 'h', 'z', 'n', 'm1', 'm2', 'hn', 'zn', 'renamed', 'e']);
});

test('a write inside a transaction is recorded too', async ({ mocks }) => {
  const spy = spyRedis(mocks.redis);
  const tx = await redis.watch('lock');
  await tx.multi();
  await tx.set('lock', '1');
  await tx.expire('lock', 60);
  await tx.exec();
  expect(spy.written()).toEqual(['lock']);
});

test('keys gives the type, the content and the expiry time of each written key that still exists', async ({ mocks }) => {
  createClock({ tasks: [], run: async () => undefined });
  const spy = spyRedis(mocks.redis);
  await redis.set('post:t3_a', '{"status":"done"}', { expiration: new Date(T0 + 30_000) });
  await redis.hSet('health', { lastTickAt: '5' });
  await redis.zAdd('due', { member: 'new:t3_a', score: 7 });
  await redis.expire('due', 90);
  await redis.set('gone', 'x');
  await redis.del('gone');
  expect(await spy.keys()).toEqual([
    { key: 'post:t3_a', type: 'string', text: '{"status":"done"}', expiresAt: T0 + 30_000 },
    { key: 'health', type: 'hash', text: '{"lastTickAt":"5"}' },
    { key: 'due', type: 'zset', text: '[{"member":"new:t3_a","score":7}]', expiresAt: T0 + 90_000 },
  ]);
});

test('measure counts the calls of one block, also when blocks run at the same time', async ({ mocks }) => {
  const spy = spyRedis(mocks.redis);
  await redis.get('outside'); // not counted
  const alone = await spy.measure(async () => {
    await redis.get('a');
    await redis.set('b', '1');
    return 'done';
  });
  expect(alone).toEqual({ result: 'done', calls: 2 });
  const [first, second] = await Promise.all([
    spy.measure(async () => void (await redis.get('a'), await redis.get('b'), await redis.get('c'))),
    spy.measure(async () => void (await redis.get('d'))),
  ]);
  expect([first.calls, second.calls]).toEqual([3, 1]);
  const tx = await spy.measure(async () => {
    const t = await redis.watch('k'); // watch, multi, set, expire and exec are five calls to the plugin
    await t.multi();
    await t.set('k', '1');
    await t.expire('k', 10);
    await t.exec();
  });
  expect(tx.calls).toBe(5);
});

test('the global scope is refused: AWB data is per installation', async ({ mocks }) => {
  spyRedis(mocks.redis);
  await expect(redis.global.set('g', '1')).rejects.toThrow(/global scope is not simulated/);
  await expect(redis.global.get('g')).rejects.toThrow(/global scope is not simulated/);
});
