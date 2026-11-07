// Plan 7.3 step 5, the source rule R7: the author must write a top-level comment before the deadline (legacy A4).
import { redis } from '@devvit/web/server';
import type { T3 } from '@devvit/web/shared';
import { expect } from 'vitest';
import { app } from '../../src/server/app';
import { A4 } from '../core/appendix';
import { createSim, type Sim } from '../sim/sim';
import { BAD_RESOLUTION, comment, HOUR, MINUTE, recordOf, REMOVAL, SUB, test } from './helpers';

const source = { mode: 'enforce', sourceComment: true, sourceHours: 1 };
const queued = async () => (await redis.zRange('due', 0, -1, { by: 'rank' })).map(({ member }) => member);

test('an author comment before the deadline: no action', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, source);
  const post = await sim.submit({});
  await sim.advance('1m');
  expect(await queued()).toEqual([`src:${post.id}`]); // checked at createdAt + 1 hour
  await sim.comment(post.id, 'alice', 'Source: https://example.com/art');
  await sim.advance('61m');
  expect(sim.actions(post.id)).toEqual([]);
  expect(await sim.audit()).toContainEqual(expect.objectContaining({ postId: post.id, kind: 'src', evt: 'decision', action: 'none', rules: [] }));
  expect(await queued()).toEqual([]);
});

test('no comment: the post is removed at the deadline, within 2 minutes, with the legacy text (A4)', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, source);
  const post = await sim.submit({});
  const deadline = Date.now() + HOUR;
  await sim.advance('59m');
  expect(sim.actions(post.id)).toEqual([]);
  await sim.advance('2m');
  expect(sim.actions(post.id)).toEqual(REMOVAL(A4));
  const entry = (await sim.audit()).find((e) => (e as { kind: string }).kind === 'src') as { at: number; action: string; rules: string[] };
  expect(entry).toMatchObject({ action: 'remove', rules: ['sourceComment'] });
  expect(entry.at - deadline).toBeLessThanOrEqual(2 * MINUTE);
});

test('a comment of another user, or of a deleted account, is not a source', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, source);
  const post = await sim.submit({});
  await sim.comment(post.id, 'bob', 'nice');
  await sim.comment(post.id, '[deleted]', 'x');
  await sim.advance('61m');
  expect(sim.actions(post.id)).toEqual(REMOVAL(A4));
});

test('the deadline follows the setting: 0.5 hours', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { ...source, sourceHours: 0.5 });
  const post = await sim.submit({});
  await sim.advance('29m');
  expect(sim.actions(post.id)).toEqual([]);
  await sim.advance('2m');
  expect(sim.actions(post.id)).toEqual(REMOVAL(A4.replace('1 hour', '0.5 hours')));
});

const changes: [string, (sim: Sim, id: T3) => Promise<void>, string][] = [
  ['a mod approved the post', (sim, id) => sim.approve(id), 'approved'],
  ['a mod removed the post', (sim, id) => sim.modRemove(id), 'removed'],
  ['the author deleted the post', (sim, id) => sim.userDelete(id), 'deleted'],
];
for (const [name, change, reason] of changes) {
  test(`no action at the deadline when ${name}`, async (fx) => {
    const sim = createSim(app, fx);
    sim.install(SUB, source);
    const post = await sim.submit({});
    await sim.advance('1m');
    await change(sim, post.id);
    await sim.advance('61m');
    expect(sim.actions(post.id)).toEqual([]);
    expect(await sim.audit()).toContainEqual(expect.objectContaining({ postId: post.id, kind: 'src', evt: 'skip', reason }));
  });
}

test('no action at the deadline when the mode is off then (D6)', async (fx) => {
  const sim = createSim(app, fx);
  const inst = sim.install(SUB, source);
  const post = await sim.submit({});
  await sim.advance('1m');
  inst.set({ mode: 'off' });
  await sim.advance('61m');
  expect(sim.actions(post.id)).toEqual([]);
  expect(await sim.audit()).toContainEqual(expect.objectContaining({ postId: post.id, kind: 'src', evt: 'skip', reason: 'mode-off' }));
});

test('no action at the deadline when the source rule is off then', async (fx) => {
  const sim = createSim(app, fx);
  const inst = sim.install(SUB, source);
  const post = await sim.submit({});
  await sim.advance('1m');
  inst.set({ sourceComment: false });
  await sim.advance('61m');
  expect(sim.actions(post.id)).toEqual([]);
  expect(await sim.audit()).toContainEqual(expect.objectContaining({ postId: post.id, kind: 'src', evt: 'skip', reason: 'rule-off' }));
});

test('dry-run: the deadline gives a would-remove entry and no call', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { ...source, mode: 'dry-run' });
  const post = await sim.submit({});
  await sim.advance('61m');
  expect(sim.actions(post.id)).toEqual([]);
  expect(await sim.audit()).toContainEqual(expect.objectContaining({ postId: post.id, kind: 'src', mode: 'dry-run', action: 'would-remove', rules: ['sourceComment'] }));
});

test('firstMode: a post that was first seen in dry-run is not removed at the deadline after the mode changed to enforce', async (fx) => {
  const sim = createSim(app, fx);
  const inst = sim.install(SUB, { ...source, mode: 'dry-run' });
  const post = await sim.submit({});
  await sim.advance('1m');
  expect((await recordOf(sim, post.id))?.firstMode).toBe('dry-run');
  inst.set({ mode: 'enforce' });
  await sim.advance('61m');
  expect(sim.actions(post.id)).toEqual([]);
  expect(await sim.audit()).toContainEqual(expect.objectContaining({ postId: post.id, kind: 'src', mode: 'dry-run', action: 'would-remove' }));
});

test('a post that fails a quick rule is removed once and gets no source check', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { ...source, resolutionBad: true, minHorizontal: '1920x1080' });
  const post = await sim.submit({ images: [{ width: 1600, height: 1200, url: 'https://i.redd.it/abc123.png' }] });
  await sim.advance('1m');
  expect(await queued()).toEqual([]);
  await sim.advance('2h');
  expect(sim.actions(post.id)).toEqual(REMOVAL(comment(BAD_RESOLUTION)));
});

test('a deadline that is already past when the post is first checked: the source check follows at once', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, source);
  const post = await sim.submit({});
  await sim.advance('2h', { only: [] }); // no job ran: the first look comes late
  await sim.runJob('tick');
  expect(sim.actions(post.id)).toEqual(REMOVAL(A4));
});

test('the source rule off: no source item is queued', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce' });
  await sim.submit({});
  await sim.advance('1m');
  expect(await queued()).toEqual([]);
});

test('no action at the deadline when Reddit does not know the post any more', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, source);
  const post = await sim.submit({});
  await sim.advance('1m');
  sim.world.posts.delete(post.id); // the client then says "no post"
  await sim.advance('61m');
  expect(sim.actions(post.id)).toEqual([]);
  expect(await sim.audit()).toContainEqual(expect.objectContaining({ postId: post.id, kind: 'src', evt: 'skip', reason: 'deleted' }));
});

test('a source item whose post record is gone does nothing and says so', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, source);
  await redis.zAdd('due', { member: 'src:t3_ghost', score: Date.now() });
  await sim.runJob('tick');
  expect(await queued()).toEqual([]);
  expect(await sim.audit()).toEqual([{ at: Date.now(), postId: 't3_ghost', kind: 'src', evt: 'skip', mode: 'enforce', reason: 'no-record' }]);
});
