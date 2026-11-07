// Plan 7.3 step 5: the sweep finds a post whose trigger never came, and the flair update gives a skipped post a second look.
// 3.0 registers no trigger for a delete or a comment: it stores nothing that a delete must remove (3.1 adds onPostDelete).
import { redis } from '@devvit/web/server';
import { expect } from 'vitest';
import { app } from '../../src/server/app';
import { createSim } from '../sim/sim';
import { BAD_RESOLUTION, comment, FLAIR, recordOf, REMOVAL, SUB, test } from './helpers';

const small = { width: 1600, height: 1200, url: 'https://i.redd.it/abc123.png' };
const rule = { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080' };
const queued = async () => (await redis.zRange('due', 0, -1, { by: 'rank' })).map(({ member }) => member);

test('the sweep finds a post whose trigger never came, in /new', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small], delivery: 'drop' });
  await sim.advance('5m'); // the sweep runs at minute 5 after the tick of that minute
  expect(sim.actions(post.id)).toEqual([]);
  expect(await queued()).toEqual([`new:${post.id}`]);
  await sim.advance('1m');
  expect(sim.actions(post.id)).toEqual(REMOVAL(comment(BAD_RESOLUTION)));
});

test('the sweep finds a post that AutoModerator holds, in the mod queue', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.automodFilter({ images: [small], delivery: 'drop' });
  await sim.advance('6m');
  expect(sim.actions(post.id)).toEqual(REMOVAL(comment(BAD_RESOLUTION)));
});

test('the sweep adds nothing for a post that the app knows or that waits in the queue', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const known = await sim.submit({ images: [{ width: 1920, height: 1080 }] });
  await sim.advance('4m');
  const waiting = await sim.submit({ images: [small] }); // its tick has not run yet
  await sim.runJob('sweep');
  expect(await queued()).toEqual([`new:${waiting.id}`]);
  expect((await recordOf(sim, known.id))?.items.new?.leases).toBe(1);
});

test('the sweep does not queue a post that is 48 hours old or older', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  await sim.submit({ images: [small], delivery: 'drop' });
  await sim.advance(`${48 * 60}m`, { only: [] });
  await sim.runJob('sweep');
  expect(await queued()).toEqual([]);
});

test('a flair change gives a skipped post a second look', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', flairRules: 'Free: skip\nDesktop: horizontal' });
  const post = await sim.submit({ flair: 'Free', images: [{ width: 900, height: 1600, url: 'https://i.redd.it/v1.jpg' }] });
  await sim.advance('2m');
  expect((await recordOf(sim, post.id))?.status).toBe('skipped:flair-skip');
  await sim.setFlair(post.id, 'Desktop');
  expect(await queued()).toEqual([`new:${post.id}`]);
  await sim.advance('1m');
  expect(sim.actions(post.id)).toEqual(REMOVAL(comment(FLAIR)));
  expect((await recordOf(sim, post.id))?.status).toBe('done');
});

test('a flair change is ignored for a post of 48 hours or more, for a post that was checked, and for an unknown post', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', flairRules: 'Free: skip\nDesktop: horizontal' });
  const old = await sim.submit({ flair: 'Free', images: [{ width: 900, height: 1600 }] });
  const checked = await sim.submit({ flair: 'Desktop', images: [{ width: 1920, height: 1080 }] });
  await sim.advance('2m');
  await sim.advance(`${48 * 60}m`, { only: [] });
  await sim.setFlair(old.id, 'Desktop');
  await sim.setFlair(checked.id, 'Free');
  const unknown = await sim.submit({ flair: 'Desktop', images: [{ width: 900, height: 1600 }], delivery: 'drop' });
  await sim.setFlair(unknown.id, 'Desktop');
  expect(await queued()).toEqual([]);
  await sim.advance('2m');
  for (const post of [old, checked, unknown]) expect(sim.actions(post.id)).toEqual([]);
});

test('triggers that arrive in another order are handled once: the flair update first, then the post', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', flairRules: 'Free: skip\nDesktop: horizontal' });
  const post = await sim.submit({ flair: 'Free', images: [{ width: 900, height: 1600, url: 'https://i.redd.it/v1.jpg' }], delivery: 'reorder' });
  await sim.setFlair(post.id, 'Desktop'); // arrives before the PostSubmit of the post: the app knows no post yet
  expect(await queued()).toEqual([`new:${post.id}`]);
  await sim.advance('2m');
  expect(sim.actions(post.id)).toEqual(REMOVAL(comment(FLAIR))); // checked with the flair that it has now
});

test('the removal of a post starts no more work', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  await sim.advance('5m');
  expect(sim.actions(post.id)).toEqual(REMOVAL(comment(BAD_RESOLUTION)));
  expect(await queued()).toEqual([]);
  expect(await sim.audit()).toHaveLength(1);
});
