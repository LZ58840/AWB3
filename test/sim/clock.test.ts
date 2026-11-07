import { expect, test, vi } from 'vitest';
import devvit from '../../devvit.json';
import { createClock, cronDue, parseDuration, scheduleOf, T0, type Task } from './clock';

const MIN = 60_000;

test('parseDuration accepts whole seconds, minutes, hours and days only', () => {
  expect(['90s', '5m', '2h', '1d'].map(parseDuration)).toEqual([90_000, 300_000, 7_200_000, 86_400_000]);
  for (const bad of ['1.5m', '5', 'm', '5 min', '-1m', '']) expect(() => parseDuration(bad), bad).toThrow(/bad duration/);
});

test('cronDue follows the 5-field cron rules that devvit.json uses', () => {
  const at = (minute: number, hour = 10) => Date.UTC(2026, 11, 8, hour, minute);
  expect(cronDue('* * * * *', at(7))).toBe(true);
  expect([0, 3, 5, 10, 15].map((m) => cronDue('*/5 * * * *', at(m)))).toEqual([true, false, true, true, true]);
  expect([0, 5, 15, 30, 45].map((m) => cronDue('*/15 * * * *', at(m)))).toEqual([true, false, true, true, true]);
  expect([0, 1].map((m) => cronDue('0 * * * *', at(m)))).toEqual([true, false]);
  expect([4, 5, 10, 11].map((m) => cronDue('5,10 * * * *', at(m)))).toEqual([false, true, true, false]);
  expect([0, 1, 3, 4].map((m) => cronDue('1-3 * * * *', at(m)))).toEqual([false, true, true, false]);
  expect([9, 10].map((h) => cronDue('0 10 * * *', at(0, h)))).toEqual([false, true]);
  expect(cronDue('0 10 8 12 2', at(0))).toBe(true); // 2026-12-08 is a Tuesday
  expect(() => cronDue('*/30 * * * * *', at(0))).toThrow(/5 fields/);
  expect(() => cronDue('x * * * *', at(0))).toThrow(/bad cron/);
});

test('scheduleOf lists the cron tasks of devvit.json in order', () => {
  expect(scheduleOf(devvit).map(({ name, endpoint, cron }) => [name, endpoint, cron])).toEqual([
    ['tick', '/internal/cron/tick', '* * * * *'],
    ['sweep', '/internal/cron/sweep', '*/5 * * * *'],
    ['health', '/internal/cron/health', '*/15 * * * *'],
  ]);
  const tasks = { manual: '/internal/cron/manual', timed: { endpoint: '/internal/cron/timed', cron: '0 * * * *', data: { a: 1 } } };
  expect(scheduleOf({ scheduler: { tasks } })).toEqual([{ name: 'timed', endpoint: '/internal/cron/timed', cron: '0 * * * *', data: { a: 1 } }]); // no cron: only runJob starts it
});

const clockWith = (start?: number) => {
  const runs: [number, string][] = [];
  const clock = createClock({ start, tasks: scheduleOf(devvit), run: async (task: Task) => void runs.push([Date.now(), task.name]) });
  const at = (minutes: number) => runs.filter(([t]) => t === T0 + minutes * MIN).map(([, name]) => name);
  return { clock, runs, at };
};

test('advance steps minute by minute and runs each due job in devvit.json order, with Date at that minute', async () => {
  const { clock, runs, at } = clockWith();
  expect(Date.now()).toBe(T0);
  await clock.advance('5m');
  expect(runs.filter(([, name]) => name === 'tick')).toHaveLength(5);
  expect([1, 2, 3, 4].map(at)).toEqual(Array(4).fill(['tick']));
  expect(at(5)).toEqual(['tick', 'sweep']);
  expect(Date.now()).toBe(T0 + 5 * MIN);
  await clock.advance('10m');
  expect(at(15)).toEqual(['tick', 'sweep', 'health']);
});

test('a start that is not on a minute runs the jobs at the next minutes, and the time ends at the exact end', async () => {
  const { clock, runs } = clockWith(T0 + 30_000);
  await clock.advance('2m');
  expect([...new Set(runs.map(([t]) => (t - T0) / MIN))]).toEqual([1, 2]);
  expect(Date.now()).toBe(T0 + 2.5 * MIN);
});

test('only limits the jobs that run, so a test can stall the tick; a wrong name is an error', async () => {
  const { clock, runs } = clockWith();
  await clock.advance('15m', { only: ['health'] });
  expect(runs.map(([, name]) => name)).toEqual(['health']);
  await expect(clock.advance('1m', { only: ['tik'] })).rejects.toThrow(/unknown job "tik"/);
});

test('a start that is not a whole second is an error, and no fake timers stay on', () => {
  expect(() => clockWith(T0 + 500)).toThrow('is not a whole second');
  expect(vi.isFakeTimers()).toBe(false);
});

test('only Date is fake: real timers and the clock of an awaited job stay usable', async () => {
  const { clock } = clockWith();
  await new Promise((resolve) => setTimeout(resolve, 5)); // a faked setTimeout would never fire
  await clock.advance('1m');
  expect(Date.now()).toBe(T0 + MIN);
});

let started = false;
test('S1.3a a clock is made inside a test ...', () => {
  clockWith();
  started = vi.isFakeTimers();
  expect(started).toBe(true);
});
test('S1.3b ... and the real clock is back in the next test', () => {
  expect(started).toBe(true); // S1.3a ran before this test
  expect(vi.isFakeTimers()).toBe(false);
});
