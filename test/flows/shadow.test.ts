// Plan 5.4 "Shadow report", AC13, AC14: "AWB: shadow report" compares what AWB decided with what the legacy bot did (a simulated mod log:
// sim.legacyAct), with tags, a rate for each rule and the p95 time from submit to action. The health job writes the numbers into the
// audit once a day. Every expected number below is counted by hand from the posts of the test.
import { reddit } from '@devvit/web/server';
import { expect, vi } from 'vitest';
import { app } from '../../src/server/app';
import { A3, A5 } from '../core/appendix';
import { T0 } from '../sim/clock';
import { createSim, type Sim } from '../sim/sim';
import { BAD_RESOLUTION, comment, DAY, HOUR, infoText, MINUTE, SUB, test } from './helpers';

const small = { width: 1600, height: 1200 }; // fails resolutionBad and aspectRatio below
const big = { width: 1920, height: 1080 };
const rules = { mode: 'dry-run', resolutionBad: true, minHorizontal: '1920x1080', aspectRatio: true, aspectHorizontal: '16:10 to none' };

const report = async (sim: Sim, days = 7) => infoText(await sim.form('shadowReport', { days })).split('\n');
const at = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

test('the form takes whole days from 1 to 7 and nothing else', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rules);
  for (const days of [0, 8, 1.5, '7', undefined, null]) {
    expect(await sim.form('shadowReport', { days }), String(days)).toEqual({ showToast: 'Write a whole number of days from 1 to 7.' });
  }
  expect((await report(sim, 1))[0]).toBe(`Shadow report: the last 1 day, posts created from ${at(T0 - DAY + HOUR)} to ${at(T0 - HOUR)} UTC`);
  expect((await report(sim, 3))[0]).toBe(`Shadow report: the last 3 days, posts created from ${at(T0 - 3 * DAY + HOUR)} to ${at(T0 - HOUR)} UTC`);
});

/**
 * Six posts at T0 in dry-run, all checked by T0 + 2 minutes; the report is read at T0 + 2 hours.
 * A small, legacy removed: both remove. B big, none: both none. C small, legacy none: AWB only. D big, legacy removed: legacy only.
 * E small, legacy removed: both remove. F small, approved by a mod: AWB skips it, legacy did nothing.
 */
async function sixPosts(sim: Sim) {
  const [a, b, c, d, e, f] = [
    await sim.submit({ images: [small] }),
    await sim.submit({ images: [big] }),
    await sim.submit({ images: [small] }),
    await sim.submit({ images: [big] }),
    await sim.submit({ images: [small] }),
    await sim.submit({ images: [small] }),
  ];
  await sim.legacyAct(a.id, 'remove');
  await sim.legacyAct(d.id, 'remove', { text: comment(BAD_RESOLUTION) }); // the legacy comment names its rule
  await sim.legacyAct(e.id, 'remove');
  await sim.approve(f.id);
  await sim.advance('2m', { only: ['tick'] }); // 5 posts in the first tick, F in the second
  vi.setSystemTime(T0 + 2 * HOUR);
  return { a, b, c, d, e, f };
}

test('the population, the agreement, the AWB-only and legacy-only removals, a rate for each rule and the p95 time', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rules);
  const { c, d } = await sixPosts(sim);
  expect(await report(sim)).toEqual([
    `Shadow report: the last 7 days, posts created from ${at(T0 - 7 * DAY + 2 * HOUR + HOUR)} to ${at(T0 + HOUR)} UTC`,
    'Posts in the report: 6',
    'Left out because a tag explains the difference: 0',
    'Posts compared: 6',
    'Agreement: 66.7% (4 of 6)',
    'Share of AWB-only removals: 16.7% (1 of 6)',
    'Rule resolutionBad: 4 posts, agreement 50.0%', // A, C, E by AWB and D by the legacy comment; A and E agree
    'Rule aspectRatio: 3 posts, agreement 66.7%', // A, C, E; A and E agree
    'p95 time from submit to action, quick rules: 60 seconds',
    `AWB-only removals (1): ${c.id}`,
    `Legacy-only removals (1): ${d.id}`,
    'Daily numbers from the audit: none yet',
  ]);
});

test('the report only reads: no write to Redis, no call that changes Reddit', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rules);
  const { a } = await sixPosts(sim);
  const keys = async () => (await sim.keys()).map(({ key, text, expiresAt }) => [key, text, expiresAt]);
  const [before, actions, mail] = [await keys(), sim.actions(a.id), sim.modmail()];
  await report(sim);
  await sim.menu('AWB: shadow report');
  expect(await keys()).toEqual(before);
  expect(sim.actions(a.id)).toEqual(actions);
  expect(sim.modmail()).toEqual(mail);
});

test('tags: a legacy repost report that mods approved is legacy-fp; one that nobody touched for 48 hours is unresolved; a legacy repost removal is repost; an external image is D7', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rules);
  // R3: reported by the legacy bot at T0, and nobody touched it since.
  const r3 = await sim.submit({ images: [big] });
  await sim.legacyAct(r3.id, 'report');
  await sim.advance('1m', { only: ['tick'] });
  vi.setSystemTime(T0 + 40 * HOUR);
  const r1 = await sim.submit({ images: [big] }); // reported, then a mod approved it
  const r2 = await sim.submit({ images: [big] }); // reported, then a mod removed it: the report was right
  const r4 = await sim.submit({ images: [big] }); // reported 12 hours before the report: too early to tell
  const x1 = await sim.submit({ images: [big] }); // removed by the legacy bot for a repost only
  const x2 = await sim.submit({ images: [big] }); // removed by the legacy bot for an image on another host
  const x3 = await sim.submit({ images: [big] }); // removed by the legacy bot for a size: a real difference
  for (const post of [r1, r2, r4]) await sim.legacyAct(post.id, 'report');
  await sim.approve(r1.id);
  await sim.modRemove(r2.id);
  await sim.legacyAct(x1.id, 'remove', { text: A5 });
  await sim.legacyAct(x2.id, 'remove', { text: comment(BAD_RESOLUTION).replace('https://i.redd.it/abc123.png', 'https://i.imgur.com/abc123.png') });
  await sim.legacyAct(x3.id, 'remove', { text: comment(BAD_RESOLUTION) });
  await sim.advance('2m', { only: ['tick'] });
  vi.setSystemTime(T0 + 52 * HOUR);
  expect(await report(sim)).toEqual([
    `Shadow report: the last 7 days, posts created from ${at(T0 + 52 * HOUR - 7 * DAY + HOUR)} to ${at(T0 + 51 * HOUR)} UTC`,
    'Posts in the report: 7',
    'Left out because a tag explains the difference: 6 (D7 1, legacy-fp 1, repost 3, unresolved 1)', // repost: r2, r4, x1
    'Posts compared: 1',
    'Agreement: 0.0% (0 of 1)',
    'Share of AWB-only removals: 0.0% (0 of 1)',
    'Rule resolutionBad: 1 post, agreement 0.0%',
    'p95 time from submit to action, quick rules: no action',
    'AWB-only removals (0): none',
    `Legacy-only removals (1): ${x3.id}`,
    'Daily numbers from the audit: none yet',
  ]);
});

test('tags: a legacy removal for the rate limit only is D2/D11 (legacy also counted later posts and posts that it had removed); an AWB removal for the rate limit only is not tagged', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'dry-run', rateLimit: true, rateLimitHours: 24, rateLimitPosts: 2 });
  const x = await sim.submit({ author: 'alice', images: [big] }); // legacy removed it for the rate limit; AWB counts no earlier post
  await sim.legacyAct(x.id, 'remove', { text: A3 });
  await sim.submit({ author: 'bob', images: [big] });
  vi.setSystemTime(T0 + MINUTE);
  await sim.submit({ author: 'bob', images: [big] });
  vi.setSystemTime(T0 + 2 * MINUTE);
  const b3 = await sim.submit({ author: 'bob', images: [big] }); // AWB counts 2 earlier posts and would remove it; legacy did nothing
  await sim.advance('3m', { only: ['tick'] });
  vi.setSystemTime(T0 + 2 * HOUR);
  expect(await report(sim)).toEqual([
    `Shadow report: the last 7 days, posts created from ${at(T0 - 7 * DAY + 3 * HOUR)} to ${at(T0 + HOUR)} UTC`,
    'Posts in the report: 4',
    'Left out because a tag explains the difference: 1 (D2/D11 1)',
    'Posts compared: 3',
    'Agreement: 66.7% (2 of 3)',
    'Share of AWB-only removals: 33.3% (1 of 3)',
    'Rule rateLimit: 1 post, agreement 0.0%',
    'p95 time from submit to action, quick rules: 60 seconds',
    `AWB-only removals (1): ${b3.id}`,
    'Legacy-only removals (0): none',
    'Daily numbers from the audit: none yet',
  ]);
});

test('AWB reads at most 20 legacy comments in a report, and a list names at most 50 posts; the removals that were not read stay in the numbers, with no rule', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, rules);
  const posts: Awaited<ReturnType<Sim['submit']>>[] = [];
  for (let i = 0; i < 52; i++) posts.push(await sim.submit({ images: [big] }));
  for (const post of posts) await sim.legacyAct(post.id, 'remove', { text: comment(BAD_RESOLUTION) });
  await sim.advance('11m', { only: ['tick'] });
  vi.setSystemTime(T0 + 2 * HOUR);
  const read = vi.spyOn(reddit, 'getComments');
  const lines = await report(sim);
  const ids = (from: number, to: number) => posts.slice(from, to).map(({ id }) => id);
  expect(read.mock.calls.map(([options]) => options.postId).sort()).toEqual(ids(0, 20).sort()); // the oldest 20
  expect(lines.slice(1)).toEqual([
    'Posts in the report: 52',
    'Left out because a tag explains the difference: 0',
    'Posts compared: 52',
    'Agreement: 0.0% (0 of 52)',
    'Share of AWB-only removals: 0.0% (0 of 52)',
    'Rule resolutionBad: 20 posts, agreement 0.0%',
    'p95 time from submit to action, quick rules: no action',
    'AWB-only removals (0): none',
    `Legacy-only removals (52): ${ids(0, 50).join(', ')} and 2 more`,
    'Legacy-only removals whose comment was not read: 32 (AWB reads at most 20)',
    'Daily numbers from the audit: none yet',
  ]);
});

test('the window: createdAt from the start + 1 hour to now - 1 hour; a legacy-acted post with no record is read from Reddit', async (fx) => {
  const N = T0 + 2 * DAY;
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'dry-run' });
  const made = async (when: number, options: Parameters<Sim['submit']>[0] = {}) => {
    vi.setSystemTime(when);
    const post = await sim.submit({ images: [big], ...options });
    await sim.runJob('tick');
    return post;
  };
  // days = 1: the start is N - 24 h, so the posts count from N - 23 h to N - 1 h.
  const l2 = await made(N - 25 * HOUR - MINUTE, { delivery: 'drop' }); // an old post that the legacy bot acts on inside the window
  await made(N - 25 * HOUR); // before the start
  vi.setSystemTime(N - 23 * HOUR - 10 * MINUTE);
  await sim.legacyAct(l2.id, 'remove');
  await made(N - 23 * HOUR - MINUTE); // after the start, before start + 1 hour
  const first = await made(N - 23 * HOUR);
  const l1 = await made(N - 10 * HOUR, { delivery: 'drop' }); // no trigger: AWB has no record of it
  await sim.legacyAct(l1.id, 'remove', { text: comment(BAD_RESOLUTION) });
  const last = await made(N - HOUR);
  await made(N - HOUR + MINUTE); // too new
  vi.setSystemTime(N);
  const lines = await report(sim, 1);
  expect(lines.slice(1, 4)).toEqual(['Posts in the report: 3', 'Left out because a tag explains the difference: 0', 'Posts compared: 3']);
  expect(lines).toContain(`Legacy-only removals (1): ${l1.id}`);
  expect([first.id, last.id]).not.toContain(l1.id);
});

test('with the source rule on, the end of the window moves by its hours: now - (sourceHours + 1 hour)', async (fx) => {
  const N = T0 + 2 * DAY;
  const sim = createSim(app, fx);
  sim.install(SUB, { mode: 'dry-run', sourceComment: true, sourceHours: 2 });
  for (const when of [N - 3 * HOUR, N - 3 * HOUR + MINUTE]) {
    vi.setSystemTime(when);
    await sim.submit({ images: [big] });
    await sim.runJob('tick');
  }
  vi.setSystemTime(N);
  const lines = await report(sim, 1);
  expect(lines[0]).toBe(`Shadow report: the last 1 day, posts created from ${at(N - DAY + HOUR)} to ${at(N - 3 * HOUR)} UTC`);
  expect(lines[1]).toBe('Posts in the report: 1');
});

test('p95 counts the quick-rule actions only (not the source rule), nearest rank: 20 removals of 10 to 200 seconds give 190 seconds', async (fx) => {
  const sim = createSim(app, fx);
  sim.install(SUB, { ...rules, sourceComment: true, sourceHours: 1 });
  await sim.submit({ images: [big] }); // its source check at T0 + 1 hour would remove it, 62 minutes after it was made: not a quick-rule action
  await sim.advance('1m', { only: ['tick'] });
  for (let i = 1; i <= 20; i++) {
    vi.setSystemTime(T0 + i * 5 * MINUTE);
    await sim.submit({ images: [small] });
    vi.setSystemTime(T0 + i * 5 * MINUTE + i * 10_000);
    await sim.runJob('tick');
  }
  vi.setSystemTime(T0 + 4 * HOUR);
  expect(await report(sim)).toContain('p95 time from submit to action, quick rules: 190 seconds');
});

test('the health job writes the numbers of the report into the audit once a day, and the report shows them', async (fx) => {
  const sim = createSim(app, fx);
  const inst = sim.install(SUB, rules);
  await sixPosts(sim);
  const stored = async () => (await sim.audit()).filter((entry) => (entry as { evt: string }).evt === 'shadow');
  await sim.runJob('health');
  expect(await stored()).toEqual([
    { at: T0 + 2 * HOUR, evt: 'shadow', days: 7, included: 6, tagged: 0, compared: 6, agree: 4, awbOnly: 1, legacyOnly: 1, p95Ms: 60_000 },
  ]);
  vi.setSystemTime(T0 + 3 * HOUR);
  await sim.runJob('health');
  expect(await stored()).toHaveLength(1); // the same UTC day
  vi.setSystemTime(T0 + DAY + 2 * HOUR);
  await sim.runJob('health');
  expect((await stored()).map((entry) => (entry as { at: number }).at)).toEqual([T0 + 2 * HOUR, T0 + DAY + 2 * HOUR]);
  inst.set({ mode: 'off' });
  vi.setSystemTime(T0 + 2 * DAY + 2 * HOUR);
  await sim.runJob('health');
  expect(await stored()).toHaveLength(2); // nothing to compare while the mode is off
  const lines = await report(sim);
  expect(lines.slice(-3)).toEqual([
    'Daily numbers from the audit:',
    '- 2026-12-08: 6 posts compared, agreement 66.7%, AWB-only removals 16.7%, p95 60 seconds',
    '- 2026-12-09: 6 posts compared, agreement 66.7%, AWB-only removals 16.7%, p95 60 seconds',
  ]);
  expect(JSON.stringify(await stored())).not.toMatch(/https?:|t3_/); // numbers only
});
