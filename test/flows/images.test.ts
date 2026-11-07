// A post whose URL says "image post of Reddit" but gives no usable image is a sign that a guess about the post data is wrong (plan S2): it
// would pass all the image rules without a word. The health alert `no-images` (once in 6 hours) says so.
import { expect } from 'vitest';
import { app } from '../../src/server/app';
import { createSim } from '../sim/sim';
import { HOUR, MINUTE, SUB, test } from './helpers';

const rule = { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080' };
const unreadable = { width: 0, height: 0 }; // Reddit gives the post, and AWB cannot read the size of its image
const noImages = (mail: { subject: string }) => mail.subject.includes('no-images');

test('an image post with no usable image passes the image rules and sends the alert no-images, once in 6 hours', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [unreadable] });
  await sim.advance('2m');
  expect(sim.actions(post.id)).toEqual([]);
  expect(sim.modmail().filter(noImages)).toEqual([expect.objectContaining({ bodyMarkdown: expect.stringContaining(post.id) })]);
  await sim.submit({ images: [unreadable] });
  await sim.advance('2m');
  expect(sim.modmail().filter(noImages)).toHaveLength(1);
  await sim.advance(`${(6 * HOUR) / MINUTE}m`, { only: [] });
  await sim.submit({ images: [unreadable] });
  await sim.advance('2m');
  expect(sim.modmail().filter(noImages)).toHaveLength(2);
});

test('a gallery of Reddit with no usable image sends the alert too; dry-run also', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { ...rule, mode: 'dry-run' });
  await sim.submit({ images: [unreadable, unreadable] });
  await sim.advance('2m');
  expect(sim.modmail().filter(noImages)).toHaveLength(1);
});

test('no alert for a text post, a link post, a GIF, a post with a usable image, a crosspost of such a post, or an image that Reddit has not finished', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  await sim.submit({});
  await sim.submit({ kind: 'link', url: 'https://example.com/a.jpg' });
  await sim.submit({ images: [{ width: 800, height: 600, url: 'https://i.redd.it/x.gif' }] });
  const parent = await sim.submit({ images: [{ width: 1920, height: 1080 }] });
  await sim.submit({ crosspostOf: parent.id });
  await sim.submit({ images: [{ width: 1920, height: 1080, status: 0 }] });
  await sim.advance('17m'); // the last one waits 5 minutes and 10 more, then it is checked without its image (media-timeout)
  expect(sim.modmail()).toEqual([]);
});

test('mode off sends no alert about images', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'off' });
  await sim.submit({ images: [unreadable] });
  await sim.advance('2m');
  expect(sim.modmail()).toEqual([]);
});
