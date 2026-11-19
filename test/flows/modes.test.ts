// Plan 7.3 step 3: skip checks (R1), dry-run and firstMode, through the simulator.
import { expect } from 'vitest';
import { app } from '../../src/server/app';
import { createSim, type Sim } from '../sim/sim';
import { BAD_RESOLUTION, comment, recordOf, REMOVAL, SUB, test, type Fx } from './helpers';

const small = { width: 1600, height: 1200, url: 'https://i.redd.it/abc123.png' };
const rule = { resolutionBad: true, minHorizontal: '1920x1080' };

test('a post that a mod approved is not touched', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', ...rule });
  const post = await sim.submit({ images: [small] });
  await sim.approve(post.id);
  await sim.advance('2m');
  expect(sim.actions(post.id)).toEqual([]);
  expect((await recordOf(sim, post.id))?.status).toBe('skipped:approved');
});

test('a post that a mod removed, or that the spam filter removed, is not touched', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', ...rule });
  const removed = await sim.submit({ images: [small] });
  const spam = await sim.submit({ images: [small] });
  await sim.modRemove(removed.id);
  await sim.modRemove(spam.id, { spam: true });
  await sim.advance('2m');
  expect(sim.actions(removed.id)).toEqual([]);
  expect(sim.actions(spam.id)).toEqual([]);
  expect((await recordOf(sim, removed.id))?.status).toBe('skipped:removed');
  expect((await recordOf(sim, spam.id))?.status).toBe('skipped:removed');
});

test('a post that its author deleted is not touched', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', ...rule });
  const post = await sim.submit({ images: [small] });
  await sim.userDelete(post.id);
  await sim.advance('2m');
  expect(sim.actions(post.id)).toEqual([]);
  expect((await recordOf(sim, post.id))?.status).toBe('skipped:deleted');
});

test('a post that AutoModerator holds is checked, with or without a PostDelete event', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', ...rule });
  const quiet = await sim.automodFilter({ images: [small] });
  const loud = await sim.automodFilter({ images: [small], sendDelete: true });
  await sim.advance('2m');
  for (const post of [quiet, loud]) expect(sim.actions(post.id)).toEqual(REMOVAL(comment(BAD_RESOLUTION)));
});

test('mode off: nothing is done, and the post is not checked later when the mode changes (D6)', async (fx) => {
  const sim = createSim(app, fx);
  const inst = sim.install(SUB, { mode: 'off', ...rule });
  const post = await sim.submit({ images: [small] });
  await sim.advance('2m');
  inst.set({ mode: 'enforce' });
  await sim.advance('2m');
  expect(sim.actions(post.id)).toEqual([]);
  expect((await recordOf(sim, post.id))?.status).toBe('skipped:mode-off');
});

test('an exempt author and a skip flair are not checked', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', exceptAuthors: 'bob, carol', flairRules: 'Free: skip', ...rule });
  const exempt = await sim.submit({ author: 'carol', images: [small] });
  const free = await sim.submit({ flair: 'Free', images: [small] });
  const other = await sim.submit({ author: 'dave', images: [small] });
  await sim.advance('2m');
  expect(sim.actions(exempt.id)).toEqual([]);
  expect(sim.actions(free.id)).toEqual([]);
  expect(sim.actions(other.id).length).toBe(4);
  expect([(await recordOf(sim, exempt.id))?.status, (await recordOf(sim, free.id))?.status]).toEqual(['skipped:except-author', 'skipped:flair-skip']);
});

test('the posts of the app account are skipped, also a [canary] post: 3.0 has no canary setting (OD6)', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', ...rule });
  const appName = sim.world.app.name; // devvit.json: name
  const own = await sim.submit({ author: appName, title: 'plain', images: [small] });
  const canary = await sim.submit({ author: appName, title: '[canary] one', images: [small] });
  await sim.advance('2m');
  expect(sim.actions(own.id)).toEqual([]);
  expect(sim.actions(canary.id)).toEqual([]);
  expect((await recordOf(sim, own.id))?.status).toBe('skipped:app-post');
  expect((await recordOf(sim, canary.id))?.status).toBe('skipped:app-post');
});

test('dry-run: no call changes Reddit, and the audit says what the app would do', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'dry-run', ...rule });
  const bad = await sim.submit({ images: [small] });
  const good = await sim.submit({ images: [{ width: 1920, height: 1080 }] });
  await sim.advance('2m');
  expect(sim.actions(bad.id)).toEqual([]);
  const audit = await sim.audit();
  expect(audit).toHaveLength(2);
  expect(audit).toContainEqual(expect.objectContaining({ postId: bad.id, kind: 'new', evt: 'decision', mode: 'dry-run', action: 'would-remove', rules: ['resolutionBad'] }));
  expect(audit).toContainEqual(expect.objectContaining({ postId: good.id, kind: 'new', evt: 'decision', mode: 'dry-run', action: 'none', rules: [] }));
});

// The legacy bot removed the post before the app looked at it.
const legacyRemoved = async (fx: Fx, mode: string) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode, ...rule });
  const post = await sim.submit({ images: [small] });
  await sim.legacyAct(post.id, 'remove');
  await sim.advance('2m');
  expect(sim.actions(post.id)).toEqual([]); // the legacy bot acted, not the app
  return { status: (await recordOf(sim, post.id))?.status, audit: await sim.audit(), postId: post.id };
};

test('dry-run sees a post that the legacy bot removed as not removed, so the shadow sees what legacy saw', async (fx) => {
  const { status, audit, postId } = await legacyRemoved(fx, 'dry-run');
  expect(status).toBe('done');
  expect(audit).toEqual([expect.objectContaining({ postId, action: 'would-remove' })]);
});

test('enforce skips a post that the legacy bot removed', async (fx) => {
  expect((await legacyRemoved(fx, 'enforce')).status).toBe('skipped:removed');
});

test('an image that Reddit has not finished is awaited 5 times, then once more after 10 minutes, then the valid images are used (media-timeout)', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', ...rule });
  const post = await sim.submit({ images: [small, { width: 640, height: 480, status: 0 }] });
  await sim.advance('5m'); // the tick at minute 1 starts the wait; 5 waits of 1 minute end at minute 6
  expect(sim.actions(post.id)).toEqual([]);
  expect((await recordOf(sim, post.id))?.items.new?.mediaWaits).toBe(5);
  await sim.advance('1m'); // the 6th look: the timeout, and one more chance, 10 minutes later
  expect(sim.actions(post.id)).toEqual([]);
  expect((await recordOf(sim, post.id))?.items.new).toMatchObject({ mediaWaits: 5, mediaExtended: true });
  await sim.advance('9m'); // minute 15
  expect(sim.actions(post.id)).toEqual([]);
  await sim.advance('1m'); // minute 16: the final check, with the valid images only
  expect(sim.actions(post.id)).toHaveLength(4); // the second image is skipped, the first is too small
  const audit = (await sim.audit()).filter((entry) => (entry as { evt: string }).evt !== 'shadow');
  expect(audit).toHaveLength(2);
  expect(audit).toContainEqual(expect.objectContaining({ postId: post.id, evt: 'media-timeout' }));
  expect(audit).toContainEqual(expect.objectContaining({ postId: post.id, evt: 'decision', action: 'remove' }));
});

test('a gallery that Reddit finishes during the extra 10 minutes is checked with all its images', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', ...rule });
  const post = await sim.submit({ images: [small, { width: 800, height: 600, url: 'https://i.redd.it/slow2.png', status: 0 }] });
  await sim.advance('6m'); // the timeout: one more chance at minute 16
  sim.world.posts.get(post.id)!.gallery[1]!.status = 1; // the second image becomes valid at minute 6
  await sim.advance('10m');
  const [, , , remove] = sim.actions(post.id);
  expect(remove).toEqual({ type: 'remove', spam: false });
  const text = (sim.actions(post.id)[0] as { text: string }).text;
  expect(text).toContain('[Image #1 (1600x1200)](https://i.redd.it/abc123.png)');
  expect(text).toContain('[Image #2 (800x600)](https://i.redd.it/slow2.png)');
});

test('an image that becomes valid while the app waits is checked at once', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', ...rule });
  const post = await sim.submit({ images: [{ ...small, status: 0 }] });
  await sim.advance('1m');
  expect(sim.actions(post.id)).toEqual([]);
  sim.world.posts.get(post.id)!.gallery[0]!.status = 1;
  await sim.advance('1m');
  expect(sim.actions(post.id)).toEqual(REMOVAL(comment(BAD_RESOLUTION)));
  expect((await recordOf(sim, post.id))?.items.new?.mediaWaits).toBe(1);
});

// S2 (2026-11-15): Reddit gave an 8K PNG no image data at first; minutes later the data was complete. Two forms: a single image
// has a URL with no extension and no gallery entry; a gallery has entries with status 0 and no URL.
const UNFINISHED = [
  ['a single image with no gallery entry and no extension', (p: { url: string; gallery: unknown[] }) => Object.assign(p, { url: p.url.replace(/\.png$/, ''), gallery: [] })],
  ['a gallery with entries of status 0 and no URL', (p: { gallery: { url: string; width: number; height: number; status: number }[] }) =>
    Object.assign(p, { gallery: p.gallery.map((g) => ({ ...g, url: '', width: 0, height: 0, status: 0 })) })],
] as const;
for (const [name, unfinished] of UNFINISHED) test(`an image that Reddit has not started (${name}) is awaited, then checked`, async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', ...rule });
  const post = await sim.submit({ images: name.startsWith('a gallery') ? [small, { width: 1920, height: 1080 }] : [small] });
  const world = sim.world.posts.get(post.id)!;
  const done = { url: world.url, gallery: world.gallery };
  unfinished(world as never);
  await sim.advance('1m');
  expect(sim.actions(post.id)).toEqual([]);
  Object.assign(world, done);
  await sim.advance('1m');
  expect(sim.actions(post.id)).toEqual(REMOVAL(comment(BAD_RESOLUTION)));
});

test('a post that waits for its image counts at once for the rate limit of a later post of the author', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', rateLimit: true, rateLimitHours: 24, rateLimitPosts: 1 });
  const first = await sim.submit({ images: [{ ...small, status: 0 }] });
  await sim.advance('1m');
  const second = await sim.submit({ images: [small] });
  await sim.advance('2m');
  expect(sim.actions(first.id)).toEqual([]); // still waiting
  expect(sim.actions(second.id)).toContainEqual({ type: 'remove', spam: false });
});

test('a crosspost waits for an unstarted image of its parent; a GIF with no gallery entry does not wait', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', ...rule });
  const parent = await sim.submit({ images: [small] });
  Object.assign(sim.world.posts.get(parent.id)!, { url: 'https://i.redd.it/abc123', gallery: [] });
  const gif = await sim.submit({ images: [{ ...small, url: 'https://i.redd.it/x.gif' }] });
  sim.world.posts.get(gif.id)!.gallery = [];
  await sim.advance('1m');
  const cross = await sim.submit({ crosspostOf: parent.id });
  await sim.advance('2m');
  expect((await recordOf(sim, cross.id))?.items.new?.mediaWaits).toBeGreaterThan(0);
  expect((await recordOf(sim, gif.id))?.items.new?.mediaWaits ?? 0).toBe(0);
});

// Each post waits for its image, so that its first look and its decision happen in different modes.
const firstLook = async (sim: Sim, mode: string, then: Record<string, string>) => {
  const inst = sim.install(SUB, { mode, ...rule });
  const post = await sim.submit({ images: [{ ...small, status: 0 }] });
  await sim.advance('1m'); // the first tick: the post gets its record and waits
  inst.set(then);
  sim.world.posts.get(post.id)!.gallery[0]!.status = 1;
  await sim.advance('1m');
  return post;
};

test('firstMode: a post first seen in dry-run gets no action after the mode changes to enforce', async (fx) => {
  const sim = createSim(app, fx);
  const post = await firstLook(sim, 'dry-run', { mode: 'enforce' });
  expect(sim.actions(post.id)).toEqual([]);
  expect((await recordOf(sim, post.id))?.firstMode).toBe('dry-run');
  expect(await sim.audit()).toEqual([expect.objectContaining({ postId: post.id, mode: 'dry-run', action: 'would-remove' })]);
});

test('firstMode: a post first seen in enforce obeys a later dry-run', async (fx) => {
  const sim = createSim(app, fx);
  const post = await firstLook(sim, 'enforce', { mode: 'dry-run' });
  expect(sim.actions(post.id)).toEqual([]);
  expect(await sim.audit()).toEqual([expect.objectContaining({ postId: post.id, mode: 'dry-run', action: 'would-remove' })]);
});

test('firstMode: a post first seen in enforce obeys a later off', async (fx) => {
  const sim = createSim(app, fx);
  const post = await firstLook(sim, 'enforce', { mode: 'off' });
  expect(sim.actions(post.id)).toEqual([]);
  expect((await recordOf(sim, post.id))?.status).toBe('skipped:mode-off');
});

test('a post that Reddit does not know any more is skipped as deleted', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', ...rule });
  const post = await sim.submit({ images: [small] });
  sim.world.posts.delete(post.id); // the client then says "no post"
  await sim.advance('2m');
  expect(sim.actions(post.id)).toEqual([]);
  expect((await recordOf(sim, post.id))?.status).toBe('skipped:deleted');
});
