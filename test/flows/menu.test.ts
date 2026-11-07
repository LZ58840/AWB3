// Plan 9 and 7.3 step 6: the mod menus "AWB: status" and "AWB: explain" show facts from Redis in the info form; every
// endpoint of devvit.json has a route that answers JSON.
import { reddit } from '@devvit/web/server';
import { expect, vi } from 'vitest';
import { app } from '../../src/server/app';
import { createSim, type Sim } from '../sim/sim';
import { infoText, SUB, test } from './helpers';

const small = { width: 1600, height: 1200, url: 'https://i.redd.it/abc123.png' };
const rule = { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080', flairRules: 'Art: vertical' };

test('every endpoint of devvit.json has a route', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB);
  expect(sim.unrouted()).toEqual([]);
});

test('every job, trigger and form of devvit.json answers JSON', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB);
  for (const job of ['tick', 'sweep', 'health']) expect(await sim.runJob(job), job).toEqual({});
  const post = await sim.submit({});
  await sim.setFlair(post.id, 'Desktop');
  expect(await sim.form('info', {})).toEqual({});
});

test('a trigger body that is not a post event is an error with a JSON body', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB);
  const res = await app.request('/internal/triggers/post-submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: 'PostSubmit has no post' });
});

async function busy(sim: Sim) {
  const removed = await sim.submit({ images: [small] });
  const passed = await sim.submit({ images: [{ width: 1920, height: 1080 }] });
  const skipped = await sim.submit({ images: [small] });
  await sim.approve(skipped.id);
  await sim.advance('2m');
  return { removed, passed, skipped };
}

test('AWB: status shows the mode, the last tick, the queue, the errors and the decisions from the audit', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { ...rule, sourceComment: true, sourceHours: 1 });
  await busy(sim);
  expect(infoText(await sim.menu('AWB: status')).split('\n')).toEqual([
    'Mode: enforce',
    'Last tick: less than a minute ago',
    'Queue: 1 item; the oldest is due in 58 minutes',
    'Errors in a row: 0',
    'Last error: none',
    'p95 time from submit to action, quick rules, 7 days: 60 seconds', // the removal came at the tick of minute 1
    'Decisions today: 2 (1 remove, 0 would remove, 1 no action); skipped: 1',
    'Decisions in 7 days: 2 (1 remove, 0 would remove, 1 no action); skipped: 1',
    'Rules that removed or would remove today: resolutionBad 1',
    'Rules that removed or would remove in 7 days: resolutionBad 1',
  ]);
});

test('AWB: status shows a late queue, an old tick, and counts the day and the 7 days apart', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { ...rule, mode: 'dry-run', sourceComment: true, sourceHours: 1 });
  await busy(sim);
  await sim.advance('3d', { only: [] });
  await sim.submit({ images: [small] });
  await sim.advance('2m', { only: [] }); // no job runs: the source item of the passed post and the new post are late
  expect(infoText(await sim.menu('AWB: status')).split('\n')).toEqual([
    'Mode: dry-run',
    'Last tick: 3 days ago',
    'Queue: 2 items; the oldest is 71 hours late',
    'Errors in a row: 0',
    'Last error: none',
    'p95 time from submit to action, quick rules, 7 days: 60 seconds',
    'Decisions today: 0 (0 remove, 0 would remove, 0 no action); skipped: 0',
    'Decisions in 7 days: 2 (0 remove, 1 would remove, 1 no action); skipped: 1',
    'Rules that removed or would remove today: none',
    'Rules that removed or would remove in 7 days: resolutionBad 1',
  ]);
});

test('AWB: status shows the errors in a row and the last error', async (fx) => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  vi.spyOn(reddit, 'submitComment').mockRejectedValue(new Error('HTTP 500'));
  await sim.advance('17m'); // the 3 attempts are at minutes 1, 2 and 17
  const lines = infoText(await sim.menu('AWB: status')).split('\n');
  expect(lines).toContain('Errors in a row: 1');
  expect(lines).toContain(`Last error: 2026-12-08 10:17 new:${post.id}: HTTP 500`);
  expect(lines).toContain('p95 time from submit to action, quick rules, 7 days: no action');
});

test('AWB: explain shows the decision and the counters of one post', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const { removed, skipped } = await busy(sim);
  expect(infoText(await sim.menu('AWB: explain', { postId: removed.id })).split('\n')).toEqual([
    `Post ${removed.id}`,
    'Status: done',
    'First mode: enforce',
    'Created: 2026-12-08 10:00:00 UTC',
    'new: remove; rules resolutionBad; 1 lease, 0 kills, 0 errors, 0 media waits; comment, distinguish, lock and removal done',
  ]);
  expect(infoText(await sim.menu('AWB: explain', { postId: skipped.id }))).toContain('Status: skipped:approved');
});

test('AWB: explain on a post that the app does not know says so', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ delivery: 'drop' });
  expect(infoText(await sim.menu('AWB: explain', { postId: post.id }))).toBe(`Post ${post.id}\nAWB has no record of this post: it did not see the post yet, or the record is older than 30 days.`);
});

test('AWB: shadow report asks for the number of days in a form; the form answers with the report (shadow.test.ts has the numbers)', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB);
  expect(await sim.menu('AWB: shadow report')).toMatchObject({
    showForm: { name: 'shadowReport', form: { fields: [{ type: 'number', name: 'days', defaultValue: 7, required: true }] } },
  });
  expect(infoText(await sim.form('shadowReport', { days: 7 }))).toContain('Shadow report: the last 7 days');
});
