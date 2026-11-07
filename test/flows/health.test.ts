// Plan 5.4 "Health" and AC12: the health job sends tick-stalled, queue-stalled and audit-mismatch, each at most once in 6 hours.
// `config` and `errors` have their tests in settings.test.ts and queue.test.ts; `lastTickAt` at the end of a tick, in queue.test.ts.
import { reddit } from '@devvit/web/server';
import { expect, vi } from 'vitest';
import { app } from '../../src/server/app';
import { createSim, type Sim } from '../sim/sim';
import { HOUR, killAt, MINUTE, SUB, test } from './helpers';

const small = { width: 1600, height: 1200, url: 'https://i.redd.it/abc123.png' };
const big = { width: 1920, height: 1080 };
const rule = { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080' };
// Devvit puts "[notification] " before the subject of a mod notification.
const subjects = (sim: Sim) => sim.modmail().map(({ subject }) => subject.replace('[notification] ', ''));
const mail = (reason: string, text: string) =>
  expect.objectContaining({ subject: expect.stringContaining(`AWB: ${reason}`), bodyMarkdown: expect.stringContaining(text) });

// ---- tick-stalled

test('tick-stalled: the last tick ended more than 5 minutes ago', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  await sim.advance('1m'); // a tick ends at minute 1
  const tickEnd = Date.now();
  vi.setSystemTime(tickEnd + 5 * MINUTE);
  await sim.runJob('health');
  expect(sim.modmail()).toEqual([]); // exactly 5 minutes is not stalled
  vi.setSystemTime(tickEnd + 5 * MINUTE + 1000);
  await sim.runJob('health');
  expect(sim.modmail()).toEqual([mail('tick-stalled', 'ended 5 minutes ago')]);
});

test('tick-stalled: no tick has ended since the install', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  await sim.runJob('health');
  expect(sim.modmail()).toEqual([mail('tick-stalled', 'No tick of AWB has ended yet')]);
});

test('tick-stalled: a tick that was killed does not count as a tick that ended', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  await sim.advance('1m'); // a tick ends at minute 1
  await sim.submit({ images: [small] });
  const killed = killAt(reddit, 'getPostById');
  void sim.runJob('tick');
  await killed;
  await sim.advance('6m', { only: [] });
  await sim.runJob('health');
  expect(sim.modmail()).toEqual([mail('tick-stalled', 'ended 6 minutes ago')]);
});

// ---- queue-stalled

test('queue-stalled: the oldest item is more than 10 minutes late, while the ticks still end', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'dry-run' });
  for (let i = 0; i < 61; i++) await sim.submit({}); // a tick takes 5 items: after 10 ticks, 11 of the 61 wait
  await sim.advance('10m', { only: ['tick'] });
  await sim.runJob('health');
  expect(sim.modmail()).toEqual([]); // the oldest item is exactly 10 minutes late
  vi.setSystemTime(Date.now() + 1000);
  await sim.runJob('health');
  expect(sim.modmail()).toEqual([
    mail('queue-stalled', 'is 10 minutes late (11 items wait)'),
  ]);
});

test('queue-stalled: an item that waits for its time (the source deadline) is not late', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'dry-run', sourceComment: true, sourceHours: 5 });
  await sim.submit({});
  await sim.advance('2h', { only: ['tick', 'health'] });
  expect(sim.modmail()).toEqual([]);
});

// ---- audit-mismatch

/** A removal by the app that its audit does not know: the mod log has the removal, the audit has no entry. */
async function unauditedRemoval(sim: Sim) {
  const post = await sim.submit({ images: [big] });
  await sim.advance('2m');
  sim.world.modRemove(post.id, sim.world.app.name);
  return post;
}

test('audit-mismatch: a removal by the app in the mod log with no audit entry; a removal that is younger than 10 minutes waits', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await unauditedRemoval(sim);
  await sim.advance('9m', { only: ['tick'] }); // 9 minutes after the removal
  await sim.runJob('health');
  expect(sim.modmail()).toEqual([]);
  await sim.advance('2m', { only: ['tick'] });
  await sim.runJob('health');
  expect(sim.modmail()).toEqual([
    mail('audit-mismatch', `Removed by AWB with no audit entry: ${post.id}`),
  ]);
});

test('audit-mismatch: an audit entry for a removal that the mod log does not have', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rule);
  const post = await sim.submit({ images: [small] });
  await sim.advance('2m');
  expect(sim.actions(post.id).map(({ type }) => type)).toContain('remove');
  sim.world.modLog.splice(0, sim.world.modLog.length, ...sim.world.modLog.filter(({ type }) => type !== 'removelink'));
  await sim.advance('11m', { only: ['tick'] });
  await sim.runJob('health');
  expect(sim.modmail()).toEqual([
    mail('audit-mismatch', `Audit entry with no removal in the mod log: ${post.id}`),
  ]);
});

test('audit-mismatch: removals that the audit and the mod log both have are fine; so are dry-run, a legacy removal and a removal by a mod', async (fx) => {
  const sim = createSim(app, fx);
  const inst = sim.install(SUB, rule);
  const removed = await sim.submit({ images: [small] }); // removed by the app
  const legacy = await sim.submit({ images: [small] });
  const mod = await sim.submit({ images: [small] });
  await sim.legacyAct(legacy.id, 'remove');
  await sim.modRemove(mod.id);
  await sim.advance('2m');
  inst.set({ mode: 'dry-run' });
  await sim.submit({ images: [small] }); // would be removed: no removal, an audit entry with would-remove
  await sim.advance('61m');
  expect(sim.actions(removed.id).map(({ type }) => type)).toContain('remove');
  expect(sim.modmail()).toEqual([]);
});

for (const [minutes, alerted] of [[24 * 60 - 1, true], [24 * 60 + 1, false]] as const) {
  test(`audit-mismatch: a removal that is ${minutes} minutes old is ${alerted ? 'in' : 'out of'} the last 24 hours`, async (fx) => {
    const sim = createSim(app, fx);
    sim.install(SUB, rule);
    await unauditedRemoval(sim);
    await sim.advance(`${minutes}m`, { only: [] });
    await sim.runJob('health');
    expect(subjects(sim).includes('AWB: audit-mismatch')).toBe(alerted);
  });
}

// ---- the limit of 6 hours

/** Each function makes the condition of one reason true now, and true for the next 6 hours. */
const stuck: Record<string, (sim: Sim) => Promise<void>> = {
  'tick-stalled': async (sim) => {
    await sim.advance('1m');
    await sim.advance('6m', { only: [] });
  },
  'queue-stalled': async (sim) => {
    for (let i = 0; i < 61; i++) await sim.submit({});
    await sim.advance('10m', { only: ['tick'] });
    await sim.advance('1m', { only: [] });
  },
  'audit-mismatch': async (sim) => {
    await unauditedRemoval(sim);
    await sim.advance('11m', { only: ['tick'] });
  },
};
for (const [reason, makeTrue] of Object.entries(stuck)) {
  test(`${reason}: sent when true, not again within 6 hours, again after 6 hours`, async (fx) => {
    const sim = createSim(app, fx);
    sim.install(SUB, rule);
    await makeTrue(sim);
    const count = () => subjects(sim).filter((subject) => subject === `AWB: ${reason}`).length;
    await sim.runJob('health');
    expect(count()).toBe(1);
    await sim.advance(`${5 * 60 + 59}m`, { only: [] });
    await sim.runJob('health');
    expect(count()).toBe(1);
    await sim.advance('1m', { only: [] });
    await sim.runJob('health');
    expect(count()).toBe(2);
  });
}

test('the reasons do not hold each other back, and each alert is one mod notification with its own subject', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'dry-run' });
  for (let i = 0; i < 61; i++) await sim.submit({});
  await sim.advance('10m', { only: ['tick'] });
  await sim.advance(`${HOUR / MINUTE}m`, { only: [] }); // no more ticks: the last one ended an hour ago, the queue is late
  await sim.runJob('health');
  expect(subjects(sim).sort()).toEqual(['AWB: queue-stalled', 'AWB: tick-stalled']);
});

test('good state: with ticks that end, a short queue and a matching audit, the health job sends nothing', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { ...rule, sourceComment: true, sourceHours: 1 });
  await sim.submit({ images: [small] });
  await sim.submit({ images: [big] });
  await sim.advance('2h');
  expect(sim.modmail()).toEqual([]);
});
