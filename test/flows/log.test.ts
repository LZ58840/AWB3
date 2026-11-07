// Plan section 9 and 7.4 "Log lines": each item writes one JSON line {evt, sub, postId, kind, mode, rules, action, ms} to the
// app log (`devvit logs` shows it for 7 days); an error line also has the stack. The canary reads these lines.
import { reddit } from '@devvit/web/server';
import { expect, vi } from 'vitest';
import { app } from '../../src/server/app';
import { createSim } from '../sim/sim';
import { killAt, SUB, test } from './helpers';

const small = { width: 1600, height: 1200, url: 'https://i.redd.it/abc123.png' };

/** The JSON lines that the app wrote to the console. */
const lines = (...spies: { mock: { calls: unknown[][] } }[]) =>
  spies.flatMap((spy) => spy.mock.calls.map(([line]) => line)).flatMap((line) => {
    try {
      return typeof line === 'string' && line.startsWith('{') ? [JSON.parse(line) as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });

test('each decision, skip and media timeout writes one line with the fields of section 9', async (fx) => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const sim = createSim(app, fx);
  const inst = sim.install(SUB, { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080', sourceComment: true, sourceHours: 1 });
  const removed = await sim.submit({ title: 'SECRET-TITLE', images: [small] });
  const passed = await sim.submit({ images: [{ width: 1920, height: 1080 }] });
  const approved = await sim.submit({ images: [small] });
  await sim.approve(approved.id);
  await sim.advance('2m');
  inst.set({ mode: 'dry-run' });
  const dry = await sim.submit({ images: [small] });
  await sim.advance('61m');
  const base = { sub: SUB, ms: 0 };
  // Exactly these lines, in this order: one for each decision and each skip, none for anything else.
  expect(lines(log)).toEqual([
    { ...base, evt: 'decision', postId: removed.id, kind: 'new', mode: 'enforce', rules: ['resolutionBad'], action: 'remove' },
    { ...base, evt: 'decision', postId: passed.id, kind: 'new', mode: 'enforce', rules: [], action: 'none' },
    { ...base, evt: 'skip', postId: approved.id, kind: 'new', mode: 'enforce', rules: [], action: 'none', reason: 'approved' },
    { ...base, evt: 'decision', postId: dry.id, kind: 'new', mode: 'dry-run', rules: ['resolutionBad'], action: 'would-remove' },
    // the mode was changed to dry-run before the deadline: the effective mode of the source item is the lower one
    { ...base, evt: 'decision', postId: passed.id, kind: 'src', mode: 'dry-run', rules: ['sourceComment'], action: 'would-remove' },
  ]);
  for (const line of lines(log)) {
    expect(Object.keys(line).sort(), JSON.stringify(line)).toEqual(expect.arrayContaining(['action', 'evt', 'kind', 'mode', 'ms', 'postId', 'rules', 'sub']));
    expect(JSON.stringify(line)).not.toMatch(/SECRET-TITLE|https?:/);
  }
});

test('ms is the time that the work on the item took', async (fx) => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080' });
  await sim.submit({ images: [small] });
  const original = reddit.getPostById.bind(reddit);
  vi.spyOn(reddit, 'getPostById').mockImplementationOnce(async (id) => {
    vi.setSystemTime(Date.now() + 1234);
    return original(id);
  });
  await sim.runJob('tick');
  expect(lines(log)).toEqual([expect.objectContaining({ evt: 'decision', ms: 1234 })]);
});

test('an error writes a line with the message and the stack', async (fx) => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080' });
  const post = await sim.submit({ images: [small] });
  vi.spyOn(reddit, 'submitComment').mockRejectedValueOnce(new Error('HTTP 500 at https://oauth.reddit.com/x'));
  await sim.advance('2m');
  const [line] = lines(error);
  expect(line).toMatchObject({ evt: 'error', sub: SUB, postId: post.id, kind: 'new', mode: 'enforce', rules: [], action: 'none', ms: 0, error: 'HTTP 500 at <url>' });
  expect(line?.stack).toEqual(expect.stringContaining('Error: HTTP 500'));
  expect(lines(log)).toEqual([expect.objectContaining({ evt: 'decision', action: 'remove' })]);
});

test('3 kills write one error line when the item is given up', async (fx) => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080' });
  const post = await sim.submit({ images: [small] });
  for (let attempt = 0; attempt < 3; attempt++) {
    const killed = killAt(reddit, 'getPostById');
    void sim.runJob('tick');
    await killed;
    await sim.advance('2m', { only: [] });
  }
  await sim.runJob('tick');
  expect(lines(error)).toEqual([{ evt: 'error', sub: SUB, postId: post.id, kind: 'new', mode: 'enforce', rules: [], action: 'none', ms: 0, reason: 'killed' }]);
});
