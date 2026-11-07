// Plan 5.5, "A change of repostMonths" (3.0: the `seen:` keys): the tick compares health.repostMonthsApplied with the setting
// and sets new TTLs on the week keys. A week key lives until the end of its ISO week + repostMonths + 1 month; a key that is
// already past that point is deleted. The expected dates below come from Python's isocalendar, not from the app.
import { expect, vi } from 'vitest';
import { app } from '../../src/server/app';
import { createSim, type Sim } from '../sim/sim';
import { SUB, test } from './helpers';

/** One image post at `iso`; the tick checks it and writes its `seen:` key. */
async function postAt(sim: Sim, iso: string) {
  vi.setSystemTime(Date.parse(iso));
  await sim.submit({ images: [{ width: 1920, height: 1080 }] });
  await sim.advance('2m');
}

const seenTtls = async (sim: Sim) =>
  Object.fromEntries((await sim.keys()).filter(({ key }) => key.startsWith('seen:')).map(({ key, expiresAt }) => [key, expiresAt]));

const applied = async (sim: Sim) => (JSON.parse((await sim.keys()).find(({ key }) => key === 'health')!.text) as Record<string, string>).repostMonthsApplied;

test('a smaller repostMonths shortens the TTL of each week key and deletes the weeks outside the window', async (fx) => {
  const sim = createSim(app, fx);
  const inst = sim.install(SUB, { mode: 'dry-run' }); // repostMonths 6: a key lives 7 months from its last write
  await postAt(sim, '2026-12-08T10:00:00Z'); // week 2026-50
  await postAt(sim, '2027-02-02T10:00:00Z'); // week 2027-05
  await postAt(sim, '2027-05-04T10:00:00Z'); // week 2027-18
  expect(await seenTtls(sim)).toEqual({
    'seen:2026-50': Date.parse('2027-07-08T10:01:00Z'),
    'seen:2027-05': Date.parse('2027-09-02T10:01:00Z'),
    'seen:2027-18': Date.parse('2027-12-04T10:01:00Z'),
  });
  expect(await applied(sim)).toBeUndefined();
  inst.set({ repostMonths: 2 });
  await sim.advance('1m');
  // Week end + 3 months. Week 2026-50 ended on 2026-12-14, so its key ended on 2027-03-14: it is gone.
  expect(await seenTtls(sim)).toEqual({
    'seen:2027-05': Date.parse('2027-05-08T00:00:00Z'),
    'seen:2027-18': Date.parse('2027-08-10T00:00:00Z'),
  });
  expect(await applied(sim)).toBe('2');
});

test('a larger repostMonths lengthens the TTL of the week keys that still exist', async (fx) => {
  const sim = createSim(app, fx);
  const inst = sim.install(SUB, { mode: 'dry-run', repostMonths: 2 });
  await postAt(sim, '2026-12-08T10:00:00Z');
  expect(await seenTtls(sim)).toEqual({ 'seen:2026-50': Date.parse('2027-03-08T10:01:00Z') });
  vi.setSystemTime(Date.parse('2027-02-01T10:00:00Z'));
  inst.set({ repostMonths: 8 });
  await sim.advance('1m');
  expect(await seenTtls(sim)).toEqual({ 'seen:2026-50': Date.parse('2027-09-14T00:00:00Z') }); // 2026-12-14 + 9 months
  expect(await applied(sim)).toBe('8');
});

test('an unchanged setting leaves the TTLs alone, and a change back is applied again', async (fx) => {
  const sim = createSim(app, fx);
  const inst = sim.install(SUB, { mode: 'dry-run' });
  await postAt(sim, '2026-12-08T10:00:00Z');
  const before = await seenTtls(sim);
  await sim.advance('10m');
  expect(await seenTtls(sim)).toEqual(before);
  inst.set({ repostMonths: 1 });
  await sim.advance('1m');
  expect(await seenTtls(sim)).toEqual({ 'seen:2026-50': Date.parse('2027-02-14T00:00:00Z') }); // 2026-12-14 + 2 months
  inst.set({ repostMonths: 6 });
  await sim.advance('1m');
  expect(await seenTtls(sim)).toEqual({ 'seen:2026-50': Date.parse('2027-07-14T00:00:00Z') });
  expect(await applied(sim)).toBe('6');
});
