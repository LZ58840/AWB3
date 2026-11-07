// Spies on the Redis plugin of one installation (S1.10: this sees client calls and transaction commands).
// It records the keys that a test writes, because the harness has no key scan, and counts the plugin calls of a block.
import { AsyncLocalStorage } from 'node:async_hooks';
import { RedisKeyScope } from '@devvit/protos/json/devvit/plugin/redis/redisapi.js';
import type { RedisMock } from '@devvit/redis/test';
import { vi } from 'vitest';

type Request = { key?: string | { key?: string; scope?: number }; kv?: { key: string }[]; newKey?: string; scope?: number };

const ONE_KEY = ['Set', 'IncrBy', 'HSet', 'HSetNX', 'HIncrBy', 'ZAdd', 'ZIncrBy', 'SetRange', 'Bitfield', 'Expire'];
const keysWritten = (method: string, request: Request): string[] =>
  ONE_KEY.includes(method) ? [request.key as string] : method === 'MSet' ? request.kv!.map(({ key }) => key) : method === 'Rename' ? [request.newKey!] : [];

const counters = new AsyncLocalStorage<{ calls: number }>();

export function spyRedis(mock: RedisMock) {
  const plugin = mock.plugin;
  const prototype = Object.getPrototypeOf(plugin) as Record<string, (...args: unknown[]) => unknown>;
  const written = new Set<string>();

  for (const method of Object.getOwnPropertyNames(prototype)) {
    if (method === 'constructor' || method.startsWith('_') || typeof prototype[method] !== 'function') continue;
    vi.spyOn(plugin as unknown as typeof prototype, method).mockImplementation(function (request: Request, ...rest: unknown[]) {
      const scope = request?.scope ?? (typeof request?.key === 'object' ? request.key.scope : undefined);
      if (scope === RedisKeyScope.GLOBAL) throw new Error(`redis.${method}: the global scope is not simulated; AWB data is per installation`);
      const counter = counters.getStore();
      if (counter) counter.calls += 1;
      for (const key of keysWritten(method, request)) written.add(key);
      return prototype[method]!.call(plugin, request, ...rest);
    } as never);
  }

  return {
    /** The keys that a write call named, in order of first write. */
    written: () => [...written],

    /** The written keys that still exist: type, whole content as text, and the epoch ms of the expiry (none without a TTL). */
    async keys(): Promise<{ key: string; type: string; text: string; expiresAt?: number }[]> {
      const out = [];
      for (const key of written) {
        const { value: expireTime } = await plugin.ExpireTime({ key }); // seconds; -1 no TTL; -2 no key
        if (expireTime === -2) continue;
        const type = (await plugin.Type({ key })).value;
        const text =
          type === 'string' ? (await plugin.Get({ key })).value
          : type === 'hash' ? JSON.stringify((await plugin.HGetAll({ key })).fieldValues)
          : JSON.stringify((await plugin.ZRange({ key: { key }, start: '0', stop: '-1', byScore: false, byLex: false, rev: false, offset: 0, count: 0 })).members);
        out.push({ key, type, text, ...(expireTime > 0 ? { expiresAt: expireTime * 1000 } : {}) });
      }
      return out;
    },

    /** Runs `block` and counts the plugin calls that it makes, also in the work that it awaits. */
    async measure<T>(block: () => Promise<T>): Promise<{ result: T; calls: number }> {
      const counter = { calls: 0 };
      const result = await counters.run(counter, block);
      return { result, calls: counter.calls };
    },
  };
}

export type RedisSpy = ReturnType<typeof spyRedis>;
