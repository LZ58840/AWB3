// Plan 5.4 steps 5 and 8, after the review of the 3.0 server: a removal that an attempt began is finished as it was decided (the comment is
// public, so the post must be removed), whatever the rules, the mode or the flair are at the retry; the audit says what Reddit shows.
import { reddit, redis } from '@devvit/web/server';
import { expect, vi } from 'vitest';
import { app } from '../../src/server/app';
import { createSim } from '../sim/sim';
import { comment, deferred, FLAIR, recordOf, REMOVAL, SUB, test } from './helpers';

const vertical = { width: 900, height: 1600, url: 'https://i.redd.it/v1.jpg' };
const flairRule = { mode: 'enforce', flairRules: 'Desktop: horizontal' }; // a vertical image under the flair Desktop fails
const small = { width: 1600, height: 1200, url: 'https://i.redd.it/abc123.png' };
const sizeRule = { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080' };
const types = (calls: { type: string }[]) => calls.map(({ type }) => type);
const decisions = async (sim: ReturnType<typeof createSim>) =>
  ((await sim.audit()) as { evt: string; kind: string; action?: string; rules?: string[] }[]).filter(({ evt }) => evt === 'decision');

test('a kill in the distinguish call, then the flair changes so that no rule fails: the retry finishes the removal that was begun', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, flairRule);
  const post = await sim.submit({ flair: 'Desktop', images: [vertical] });
  const submit = reddit.submitComment.bind(reddit);
  const dying = deferred();
  vi.spyOn(reddit, 'submitComment').mockImplementationOnce(async (options) => {
    const reply = await submit(options);
    reply.distinguish = () => {
      dying.resolve();
      return new Promise(() => undefined); // the request dies in the distinguish call
    };
    return reply;
  });
  const lookup = vi.spyOn(reddit, 'getCommentById');
  void sim.runJob('tick');
  await dying.promise;
  expect(types(sim.actions(post.id))).toEqual(['comment']);
  await sim.setFlair(post.id, 'Other'); // the author fixed the flair: no rule fails any more
  await sim.advance('3m'); // the lease of 2 minutes runs out
  expect(sim.actions(post.id)).toEqual(REMOVAL(comment(FLAIR)));
  expect(lookup).toHaveBeenCalledTimes(1); // the retry took its own comment from Reddit by its id
  expect(await decisions(sim)).toEqual([{ at: expect.any(Number), postId: post.id, kind: 'new', mode: 'enforce', evt: 'decision', rules: ['flair'], action: 'remove' }]);
  expect(await recordOf(sim, post.id)).toMatchObject({ status: 'done', items: { new: { removed: true, rules: ['flair'], action: 'remove' } } });
});

test('a kill after the removal, then the mode changes to dry-run: the audit says remove, as Reddit shows', async (fx) => {
  const sim = createSim(app, fx);
  const inst = sim.install(SUB, sizeRule);
  const post = await sim.submit({ images: [small] });
  const reached = new Promise<void>((resolve) => {
    const zAdd = redis.zAdd.bind(redis);
    vi.spyOn(redis, 'zAdd').mockImplementation(((key: string, ...members: never[]) => {
      if (!key.startsWith('audit:')) return zAdd(key, ...members);
      resolve();
      return new Promise(() => undefined); // the request dies when it writes the audit entry
    }) as never);
  });
  void sim.runJob('tick');
  await reached;
  vi.mocked(redis.zAdd).mockRestore();
  expect(types(sim.actions(post.id))).toEqual(['comment', 'distinguish', 'lock', 'remove']);
  inst.set({ mode: 'dry-run' });
  await sim.advance('3m');
  expect(types(sim.actions(post.id))).toEqual(['comment', 'distinguish', 'lock', 'remove']); // no second call
  expect(await decisions(sim)).toEqual([expect.objectContaining({ action: 'remove', rules: ['resolutionBad'] })]);
});

test('a kill after Reddit removed the post, before the app wrote it down: the retry sees its own removal as done, and the audit says remove', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, sizeRule);
  const post = await sim.submit({ images: [small] });
  const original = reddit.getPostById.bind(reddit);
  const dying = deferred();
  vi.spyOn(reddit, 'getPostById').mockImplementationOnce(async (id) => {
    const found = await original(id);
    const remove = found.remove.bind(found);
    found.remove = async (...args: Parameters<typeof remove>) => {
      await remove(...args);
      dying.resolve();
      return new Promise<void>(() => undefined); // Reddit removed the post; the answer never comes
    };
    return found;
  });
  void sim.runJob('tick');
  await dying.promise;
  expect(types(sim.actions(post.id))).toEqual(['comment', 'distinguish', 'lock', 'remove']);
  await sim.advance('3m');
  expect(types(sim.actions(post.id))).toEqual(['comment', 'distinguish', 'lock', 'remove']); // the removal is not made twice
  expect(await recordOf(sim, post.id)).toMatchObject({ status: 'done', items: { new: { removing: true, removed: true, action: 'remove' } } });
  expect(await decisions(sim)).toEqual([expect.objectContaining({ action: 'remove' })]);
  expect((await sim.audit()).some((entry) => (entry as { evt: string }).evt === 'skip')).toBe(false);
});

test('the distinguish call fails every time: after 3 errors the app removes the post, so that its comment is true; the audit shows the removal and the error', async (fx) => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sim = createSim(app, fx);
  sim.install(SUB, sizeRule);
  const post = await sim.submit({ images: [small] });
  const [submit, lookup] = [reddit.submitComment.bind(reddit), reddit.getCommentById.bind(reddit)];
  vi.spyOn(reddit, 'submitComment').mockImplementation(async (options) => {
    const reply = await submit(options);
    reply.distinguish = () => Promise.reject(new Error('HTTP 500'));
    return reply;
  });
  vi.spyOn(reddit, 'getCommentById').mockImplementation(async (id) => {
    const reply = await lookup(id);
    reply.distinguish = () => Promise.reject(new Error('HTTP 500'));
    return reply;
  });
  await sim.advance('17m'); // the attempts are at minutes 1, 2 and 17
  expect(types(sim.actions(post.id))).toEqual(['comment', 'remove']);
  expect(await recordOf(sim, post.id)).toMatchObject({ status: 'error', items: { new: { errors: 3, removed: true, action: 'remove' } } });
  const audit = (await sim.audit()) as { evt: string; action?: string; reason?: string }[];
  expect(audit).toContainEqual(expect.objectContaining({ evt: 'decision', action: 'remove', rules: ['resolutionBad'] }));
  expect(audit).toContainEqual(expect.objectContaining({ evt: 'error', reason: 'HTTP 500' }));
  expect(sim.modmail()).toEqual([expect.objectContaining({ subject: expect.stringContaining('errors') })]);
});

test('3 kills after the comment: the app removes the post before it gives up', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, sizeRule);
  const post = await sim.submit({ images: [small] });
  let dying = deferred();
  const hang = (reply: Awaited<ReturnType<typeof reddit.submitComment>>) => {
    reply.distinguish = () => {
      dying.resolve();
      return new Promise(() => undefined);
    };
    return reply;
  };
  const submit = reddit.submitComment.bind(reddit);
  const lookup = reddit.getCommentById.bind(reddit);
  vi.spyOn(reddit, 'submitComment').mockImplementationOnce(async (options) => hang(await submit(options)));
  vi.spyOn(reddit, 'getCommentById').mockImplementation(async (id) => hang(await lookup(id)));
  for (let attempt = 0; attempt < 3; attempt++) {
    dying = deferred();
    void sim.runJob('tick');
    await dying.promise;
    await sim.advance('2m', { only: [] }); // the lock and the lease run out
  }
  await sim.runJob('tick'); // this lease finds the 3rd kill
  expect(types(sim.actions(post.id))).toEqual(['comment', 'remove']);
  expect(await recordOf(sim, post.id)).toMatchObject({ status: 'error', items: { new: { kills: 3, removed: true } } });
});
