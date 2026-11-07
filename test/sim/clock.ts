// Fake clock and cron runner. Only `Date` is fake: a fake setTimeout would stop the async harness mocks (S1.5).
import { onTestFinished, vi } from 'vitest';

/** A Tuesday at the start of a minute (plan 10: Tue Dec 8). */
export const T0 = Date.parse('2026-12-08T10:00:00Z');

const MINUTE = 60_000;
const UNIT = { s: 1000, m: MINUTE, h: 3_600_000, d: 86_400_000 } as const;

/** Whole seconds only: 90s, 5m, 2h, 1d. */
export function parseDuration(text: string): number {
  const match = /^(\d+)([smhd])$/.exec(text);
  if (!match) throw new Error(`bad duration "${text}": use whole numbers, for example 90s, 5m, 2h, 1d`);
  return Number(match[1]) * UNIT[match[2] as keyof typeof UNIT];
}

const FIELDS = [
  { min: 0, value: (d: Date) => d.getUTCMinutes() },
  { min: 0, value: (d: Date) => d.getUTCHours() },
  { min: 1, value: (d: Date) => d.getUTCDate() },
  { min: 1, value: (d: Date) => d.getUTCMonth() + 1 },
  { min: 0, value: (d: Date) => d.getUTCDay() },
];

const fieldMatches = (spec: string, value: number, min: number, cron: string): boolean =>
  spec.split(',').some((part) => {
    const [range = '', step = '1'] = part.split('/');
    const [lo, hi] = range === '*' ? [min, Infinity] : range.split('-').map(Number);
    const to = hi ?? (part.includes('/') ? Infinity : lo);
    if (lo === undefined || to === undefined || [lo, to, Number(step)].some(Number.isNaN)) throw new Error(`bad cron "${cron}"`);
    return value >= lo && value <= to && (value - lo) % Number(step) === 0;
  });

// shortcut: day of month and day of week are ANDed (Vixie cron ORs them when both are set); upgrade if a cron sets both.
/** Is the 5-field cron due at the minute that contains `at`? Supports *, n, a-b, a,b and the step /n. */
export function cronDue(cron: string, at: number): boolean {
  const specs = cron.trim().split(/\s+/);
  if (specs.length !== 5) throw new Error(`cron "${cron}": only 5 fields are simulated`);
  const date = new Date(at);
  return specs.every((spec, i) => fieldMatches(spec, FIELDS[i]!.value(date), FIELDS[i]!.min, cron));
}

export interface Task {
  name: string;
  endpoint: string;
  cron: string;
  data?: unknown;
}

type TaskSpec = string | { endpoint: string; cron?: string; data?: unknown };

/** The cron tasks of devvit.json, in file order. A task with no cron only starts with scheduler.runJob. */
export function scheduleOf(devvit: { scheduler: { tasks: Record<string, TaskSpec> } }): Task[] {
  return Object.entries(devvit.scheduler.tasks).flatMap(([name, spec]) =>
    typeof spec === 'string' || !spec.cron ? [] : [{ name, endpoint: spec.endpoint, cron: spec.cron, ...(spec.data ? { data: spec.data } : {}) }],
  );
}

export interface ClockOptions {
  start?: number;
  tasks: Task[];
  run: (task: Task) => Promise<void>;
}

export function createClock({ start = T0, tasks, run }: ClockOptions) {
  if (start % 1000) throw new Error(`start ${start} is not a whole second`);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
  onTestFinished(() => void vi.useRealTimers()); // fake timers are global; the harness does not undo them
  return {
    /** Moves the time to `now + duration`. At each minute on the way, runs the jobs that are due (only the `only` jobs, if given). */
    async advance(duration: string, { only }: { only?: string[] } = {}): Promise<void> {
      for (const name of only ?? []) if (!tasks.some((task) => task.name === name)) throw new Error(`unknown job "${name}"`);
      const end = Date.now() + parseDuration(duration);
      for (let minute = (Math.floor(Date.now() / MINUTE) + 1) * MINUTE; minute <= end; minute += MINUTE) {
        vi.setSystemTime(minute);
        for (const task of tasks) if ((!only || only.includes(task.name)) && cronDue(task.cron, minute)) await run(task);
      }
      vi.setSystemTime(end);
    },
  };
}
