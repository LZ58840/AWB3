// Plan 7.3 step 1, the walking skeleton: one post goes through the trigger, the queue, the tick, the rules and the Reddit calls.
import { expect } from 'vitest';
import { app } from '../../src/server/app';
import { createSim } from '../sim/sim';
import { BAD_RESOLUTION, comment, REMOVAL, SUB, test } from './helpers';

test('a small image is removed within 2 minutes: comment with the legacy text, distinguish and sticky, lock, remove', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080' });
  const post = await sim.submit({ title: 'Sunset', images: [{ width: 1600, height: 1200, url: 'https://i.redd.it/abc123.png' }] });
  expect(sim.actions(post.id)).toEqual([]); // a trigger only queues the post
  await sim.advance('2m');
  expect(sim.actions(post.id)).toEqual(REMOVAL(comment(BAD_RESOLUTION)));
});

test('a big image is left alone', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080' });
  const post = await sim.submit({ images: [{ width: 1920, height: 1080 }] });
  await sim.advance('2m');
  expect(sim.actions(post.id)).toEqual([]);
});
