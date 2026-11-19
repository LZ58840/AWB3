// Plan 7.3 step 2: each quick rule R2 to R6 through the simulator. The expected comments are cut from the legacy texts
// (test/core/appendix.ts, test/core/legacyText.ts), never produced by the app code.
import { expect } from 'vitest';
import { app } from '../../src/server/app';
import { A3 } from '../core/appendix';
import { ASPECT_MIXED, BAD_RESOLUTION_ALL_ORIENTATIONS, FLAIR_MULTI } from '../core/legacyText';
import { createSim } from '../sim/sim';
import { ASPECT, BAD_RESOLUTION, comment, FLAIR, MISMATCH, REMOVAL, SUB, test, type Fx } from './helpers';

const names = (calls: { type: string }[]) => calls.map(({ type }) => type);
const desktop = { flairRules: 'Desktop: horizontal' };

test('R2 flair: a vertical image under a horizontal-only flair is removed (legacy A2)', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', ...desktop });
  const post = await sim.submit({ flair: 'Desktop', images: [{ width: 900, height: 1600, url: 'https://i.redd.it/v1.jpg' }] });
  await sim.advance('2m');
  expect(sim.actions(post.id)).toEqual(REMOVAL(comment(FLAIR)));
});

test('R2 flair: a horizontal image, a flair with no rule and a post with no flair pass', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', ...desktop });
  const ok = await sim.submit({ flair: 'Desktop', images: [{ width: 1920, height: 1080 }] });
  const other = await sim.submit({ flair: 'Other', images: [{ width: 900, height: 1600 }] });
  const none = await sim.submit({ images: [{ width: 900, height: 1600 }] });
  await sim.advance('2m');
  for (const post of [ok, other, none]) expect(sim.actions(post.id)).toEqual([]);
});

test('R2 flair: a gallery gives one section for each forbidden orientation, in the legacy order', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', flairRules: 'Art: vertical' });
  const image = (width: number, height: number, n: number) => ({ width, height, url: `https://i.redd.it/f${n}.png` });
  const post = await sim.submit({ flair: 'Art', images: [image(1600, 900, 1), image(1920, 1080, 2), image(1000, 1000, 3), image(900, 1600, 4)] });
  await sim.advance('2m');
  expect(sim.actions(post.id)).toEqual(REMOVAL(comment(FLAIR_MULTI)));
});

test('R3 title tag: a title size that no image has is removed (legacy A1 section)', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', resolutionMismatch: true });
  const bad = await sim.submit({ title: '[1920x1080] Sunset', images: [{ width: 1600, height: 1200, url: 'https://i.redd.it/abc123.png' }] });
  const ok = await sim.submit({ title: '[1920x1080] Sunset', images: [{ width: 1920, height: 1080 }] });
  const untagged = await sim.submit({ title: 'Sunset', images: [{ width: 1600, height: 1200 }] });
  await sim.advance('2m');
  expect(sim.actions(bad.id)).toEqual(REMOVAL(comment(MISMATCH)));
  expect(sim.actions(ok.id)).toEqual([]);
  expect(sim.actions(untagged.id)).toEqual([]);
});

test('R4 minimum size: a gallery gets one section for each orientation, numbered by gallery position (legacy)', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080', minVertical: '900x1600', minSquare: '1000x1000' });
  const image = (width: number, height: number, n: number) => ({ width, height, url: `https://i.redd.it/g${n}.png` });
  const post = await sim.submit({ images: [image(1600, 1200, 1), image(800, 1500, 2), image(1280, 720, 3), image(500, 500, 4)] });
  await sim.advance('2m');
  expect(sim.actions(post.id)).toEqual(REMOVAL(comment(BAD_RESOLUTION_ALL_ORIENTATIONS)));
});

test('R4 minimum size: an image that is exactly the minimum passes; an orientation with no minimum is not checked', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080' });
  const exact = await sim.submit({ images: [{ width: 1920, height: 1080 }] });
  const vertical = await sim.submit({ images: [{ width: 100, height: 200 }] });
  await sim.advance('2m');
  expect(sim.actions(exact.id)).toEqual([]);
  expect(sim.actions(vertical.id)).toEqual([]);
});

test('R5 aspect ratio: too tall and too wide images in a gallery (legacy ASPECT_MIXED)', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', aspectRatio: true, aspectHorizontal: '16:10 to 2:1', aspectVertical: 'none to 10:16' });
  const image = (width: number, height: number, n: number) => ({ width, height, url: `https://i.redd.it/r${n}.png` });
  const post = await sim.submit({ images: [image(1600, 1200, 1), image(2400, 1000, 2), image(900, 1200, 3), image(2100, 1000, 4)] });
  await sim.advance('2m');
  expect(sim.actions(post.id)).toEqual(REMOVAL(comment(ASPECT_MIXED)));
});

test('R3, R4 and R5 together give the three sections of legacy A1, in order', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, {
    mode: 'enforce', resolutionMismatch: true, resolutionBad: true, minHorizontal: '1920x1080', aspectRatio: true, aspectHorizontal: '16:10 to none',
  });
  const post = await sim.submit({ title: '[1920x1080] Sunset', images: [{ width: 1600, height: 1200, url: 'https://i.redd.it/abc123.png' }] });
  await sim.advance('2m');
  expect(sim.actions(post.id)).toEqual(REMOVAL(comment(MISMATCH, BAD_RESOLUTION, ASPECT)));
});

test('R6 rate limit: the 5th post in 24 hours is removed and the comment lists the 4 earlier posts (legacy A3)', async (fx) => {
  // Legacy A3: the 4 earlier posts are 20 h 15 min, 5 h, 1 h 1 min and 30 s old when the new post arrives at 2024-12-04 11:35 UTC.
  const sim = createSim(app, fx, { start: Date.parse('2024-12-03T15:20:00Z') });
  sim.install(SUB, { mode: 'enforce', rateLimit: true, rateLimitHours: 24, rateLimitPosts: 4, rateLimitCountDeleted: true });
  const pause = (duration: string) => sim.advance(duration, { only: [] }); // the time passes, no job runs
  const earlier = [await sim.submit({})]; // 15:20
  await pause('915m');
  earlier.push(await sim.submit({})); // 06:35
  await pause('239m');
  earlier.push(await sim.submit({})); // 10:34
  await pause('3630s');
  earlier.push(await sim.submit({})); // 11:34:30
  await pause('30s');
  const post = await sim.submit({}); // 11:35
  await sim.runJob('tick');
  expect(sim.actions(post.id)).toEqual(REMOVAL(A3));
  for (const p of earlier) expect(sim.actions(p.id)).toEqual([]);
});

// Three earlier posts, then the second one is removed by a mod or deleted by its author, then a 4th post with a limit of 3.
const fourthPost = async (fx: Fx, more: Record<string, boolean>, change: 'remove' | 'delete') => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', rateLimit: true, rateLimitHours: 24, rateLimitPosts: 3, ...more });
  const earlier = [await sim.submit({}), await sim.submit({}), await sim.submit({})];
  await sim.advance('1m');
  if (change === 'remove') await sim.modRemove(earlier[1]!.id);
  else await sim.userDelete(earlier[1]!.id);
  const post = await sim.submit({});
  await sim.advance('2m');
  return names(sim.actions(post.id));
};

test('R6 rate limit: a post that a mod removed does not count', async (fx) => {
  expect(await fourthPost(fx, {}, 'remove')).toEqual([]);
});

test('R6 rate limit: a deleted post does not count by default', async (fx) => {
  expect(await fourthPost(fx, { rateLimitCountDeleted: false }, 'delete')).toEqual([]);
});

test('R6 rate limit: a deleted post counts with rateLimitCountDeleted', async (fx) => {
  expect(await fourthPost(fx, { rateLimitCountDeleted: true }, 'delete')).toEqual(['comment', 'distinguish', 'lock', 'remove']);
});

test('R6 rate limit: a post that its author deletes before the first tick counts with rateLimitCountDeleted', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', rateLimit: true, rateLimitHours: 24, rateLimitPosts: 3, rateLimitCountDeleted: true });
  const earlier = [await sim.submit({}), await sim.submit({}), await sim.submit({})];
  await sim.userDelete(earlier[1]!.id); // no tick has read the post yet: only its trigger has seen it
  await sim.advance('1m', { only: [] }); // the time passes, no job runs
  const post = await sim.submit({});
  await sim.advance('2m');
  expect(names(sim.actions(post.id))).toEqual(['comment', 'distinguish', 'lock', 'remove']);
});

// Three earlier posts, then Reddit forgets the second one, then a 4th post with a limit of 3.
const forgotten = async (fx: Fx, rateLimitCountDeleted: boolean) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', rateLimit: true, rateLimitHours: 24, rateLimitPosts: 3, rateLimitCountDeleted });
  const earlier = [await sim.submit({}), await sim.submit({}), await sim.submit({})];
  await sim.advance('1m');
  sim.world.posts.delete(earlier[1]!.id);
  const post = await sim.submit({});
  await sim.advance('2m');
  return names(sim.actions(post.id));
};

test('R6 rate limit: an earlier post that Reddit does not know any more is a deleted post: not counted by default', async (fx) => {
  expect(await forgotten(fx, false)).toEqual([]);
});

test('R6 rate limit: an earlier post that Reddit does not know any more is counted with rateLimitCountDeleted', async (fx) => {
  expect(await forgotten(fx, true)).toEqual(['comment', 'distinguish', 'lock', 'remove']);
});

test('R6 rate limit: posts of another author and posts outside the window do not count', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', rateLimit: true, rateLimitHours: 2, rateLimitPosts: 2 });
  await sim.submit({ author: 'alice' });
  await sim.submit({ author: 'bob' });
  await sim.submit({ author: 'bob' });
  await sim.advance('1m');
  const second = await sim.submit({ author: 'alice' }); // 3 posts of others and 1 of alice: only alice counts
  await sim.advance('2m');
  expect(sim.actions(second.id)).toEqual([]);
  await sim.advance('3h');
  const third = await sim.submit({ author: 'alice' }); // alice's 2 earlier posts are older than 2 hours
  await sim.advance('2m');
  expect(sim.actions(third.id)).toEqual([]);
});

test('a crosspost is checked with the images of its parent, also a gallery', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080' });
  const single = await sim.submit({ images: [{ width: 1600, height: 1200, url: 'https://i.redd.it/abc123.png' }], delivery: 'drop' });
  const gallery = await sim.submit({
    images: [{ width: 1920, height: 1080, url: 'https://i.redd.it/g1.png' }, { width: 1280, height: 720, url: 'https://i.redd.it/g2.png' }],
    delivery: 'drop',
  });
  const first = await sim.submit({ crosspostOf: single.id });
  const second = await sim.submit({ crosspostOf: gallery.id });
  await sim.advance('2m');
  expect(sim.actions(first.id)).toEqual(REMOVAL(comment(BAD_RESOLUTION)));
  const [text] = sim.actions(second.id).flatMap((action) => (action.type === 'comment' ? [action.text] : []));
  expect(text).toContain('[Image #2 (1280x720)](https://i.redd.it/g2.png) is too small.');
  expect(text).not.toContain('Image #1');
});

test('link, video and text posts pass the image rules', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080', resolutionMismatch: true });
  const posts = [
    await sim.submit({ kind: 'link', url: 'https://example.com/small.jpg', title: '[1920x1080] link' }),
    await sim.submit({ kind: 'video', title: '[1920x1080] video' }),
    await sim.submit({ kind: 'text', title: '[1920x1080] text' }),
  ];
  await sim.advance('2m');
  for (const post of posts) expect(sim.actions(post.id)).toEqual([]);
});
