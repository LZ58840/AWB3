// Plan 7.3 step 6: settings validation routes, and a rule with a bad setting that turns itself off with an alert (AC10).
import { expect } from 'vitest';
import { parseConfig } from '../../src/core/config';
import { app } from '../../src/server/app';
import devvit from '../../devvit.json';
import { createSim } from '../sim/sim';
import { HOUR, MINUTE, SUB, test } from './helpers';

const small = { width: 1600, height: 1200, url: 'https://i.redd.it/abc123.png' };

test('every setting that devvit.json lets Devvit validate has a route that answers success when the value is empty', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB);
  const names = Object.entries(devvit.settings.subreddit).flatMap(([name, setting]) => ('validationEndpoint' in setting ? [name] : []));
  expect(names.length).toBeGreaterThanOrEqual(10);
  for (const name of names) expect(await sim.validate(name, undefined), name).toEqual({ success: true });
});

const bad: [string, unknown, string][] = [
  ['minHorizontal', '800x', 'Write the size as WxH, for example 1920x1080.'],
  ['minVertical', 'big', 'Write the size as WxH, for example 1920x1080.'],
  ['aspectHorizontal', '16:10', 'Write the limits as A:B to C:D, for example 16:10 to none.'],
  ['aspectVertical', '10:16 to 9:21', 'The first limit must not be larger than the second limit, for example 9:21 to 10:16.'],
  ['exceptAuthors', 'alice, u/bob', 'Bad user name "u/bob". Write names without u/, separated by commas.'],
  ['flairRules', 'Desktop horizontal', 'Bad line "Desktop horizontal". Write Flair: skip, or Flair: horizontal, vertical, square.'],
  ['rateLimitHours', 0, 'Write a whole number from 1 to 720.'],
  ['rateLimitHours', 1.5, 'Write a whole number from 1 to 720.'],
  ['rateLimitPosts', 'many', 'Write a whole number from 1 to 1000.'],
  ['sourceHours', 0, 'Write a number from 0.01 to 696.'],
  ['sourceHours', 697, 'Write a number from 0.01 to 696.'],
];
for (const [name, value, error] of bad) {
  test(`validation: ${name} = ${JSON.stringify(value)} is rejected with a message for the mod`, async (fx) => {
    const sim = createSim(app, fx);
    sim.install(SUB);
    expect(await sim.validate(name, value)).toEqual({ success: false, error });
  });
}

test('validation: good values are accepted', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB);
  const good: [string, unknown][] = [
    ['minHorizontal', '1920x1080'], ['minSquare', '1000 X 1000'], ['aspectHorizontal', '16:10 to none'], ['aspectVertical', 'none to 10:16'],
    ['exceptAuthors', 'alice, bob_2, carol-3'], ['flairRules', 'Desktop: horizontal\nOther: skip'], ['rateLimitHours', 24], ['rateLimitPosts', 4],
    ['sourceHours', 0.5], ['sourceHours', 696],
  ];
  for (const [name, value] of good) expect(await sim.validate(name, value), name).toEqual({ success: true });
});

test('a rule that is on with an empty threshold is off, and the health job tells the mods once in 6 hours', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', resolutionBad: true }); // no minimum size
  const post = await sim.submit({ images: [small] });
  await sim.advance('2m');
  expect(sim.actions(post.id)).toEqual([]); // the rule is off, nothing else is
  expect(sim.modmail()).toEqual([]);
  await sim.advance('15m'); // the health job runs at minute 15
  expect(sim.modmail()).toEqual([
    expect.objectContaining({ subject: expect.stringContaining('config'), bodyMarkdown: expect.stringContaining('resolutionBad: Set at least one minimum size.') }),
  ]);
  await sim.advance('15m');
  expect(sim.modmail()).toHaveLength(1);
  await sim.advance(`${6 * HOUR / MINUTE}m`);
  expect(sim.modmail()).toHaveLength(2);
});

test('the alert lists each rule that is off: size, aspect, rate limit and source', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', resolutionBad: true, aspectRatio: true, rateLimit: true, rateLimitHours: 0, sourceComment: true, sourceHours: 0 });
  await sim.runJob('health');
  const [mail] = sim.modmail();
  for (const problem of ['resolutionBad: ', 'aspectRatio: ', 'rateLimit: rateLimitHours: ', 'sourceComment: sourceHours: ']) expect(mail?.bodyMarkdown).toContain(problem);
});

test('a bad list of exempt authors stops all checks (an exemption must never be lost) and tells the mods', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', exceptAuthors: 'alice, u/bob', resolutionBad: true, minHorizontal: '1920x1080' });
  const post = await sim.submit({ images: [small] });
  await sim.advance('15m');
  expect(sim.actions(post.id)).toEqual([]);
  expect(sim.modmail()).toEqual([expect.objectContaining({ bodyMarkdown: expect.stringContaining('exceptAuthors: Bad user name "u/bob"') })]);
});

test('good settings: the health job sends nothing', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'enforce', resolutionBad: true, minHorizontal: '1920x1080' });
  await sim.advance('30m');
  expect(sim.modmail()).toEqual([]);
});

test('the install settings of 3.0 have no repost and canary settings: the config reads repost as off and canary as off', () => {
  const defaults = Object.fromEntries(Object.entries(devvit.settings.subreddit).map(([name, setting]) => [name, (setting as { defaultValue?: unknown }).defaultValue]));
  const { config, problems } = parseConfig(defaults);
  expect(problems).toEqual([]);
  expect(config.repost).toBeUndefined();
  expect(config.canary).toBe(false);
});
