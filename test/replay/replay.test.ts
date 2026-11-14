// Plan 7.4 "Replay" and AC3: each post of the anonymized legacy corpus (test/fixtures/legacy-corpus-<name>.json, written by
// tools/capture_fixtures.py) is submitted to the simulator with the legacy settings of its subreddit (legacy-config-<name>.yaml);
// the decision and the comment text must equal the legacy ones, except for the approved differences of plan section 6 that replay.ts
// applies: D1 (image numbers), D2 and D11 (legacy has a rate-limit item that AWB does not have: it also counted later posts and posts that
// it had removed itself), D7 (images on other hosts). The repost item of a legacy comment is not compared: 3.0 has no repost (D3, D12 to
// D18 belong to 3.1); the other items of that comment are. D4 (a source removal up to 2 minutes late), D6 and D8 to D10 change nothing in
// a replay: the mode is enforce, the settings are valid, and no post is deleted before its first look.
// With only the sample fixture present, the replay runs on the sample.
import { expect, vi } from 'vitest';
import { test } from '../flows/helpers';
import { beforeDeadline, corpusNames, corpusProblems, type CorpusPost, digest, KNOWN_UNKNOWN, legacyDidNotLook, loadCorpus as load, replay, tally, type Corpus } from './replay';

for (const name of corpusNames()) {
  test(`replay of the corpus "${name}": every decision and comment equals the legacy one, except the approved D-codes; the posts it cannot compare are the known ones`, async (fx) => {
    const { corpus, settings } = load(name);
    const outcomes = await replay(fx, corpus, settings);
    const differing = outcomes.filter(({ verdict }) => verdict === 'differs').map(({ id, legacy, awb }) => ({ id, legacy, awb }));
    process.stderr.write(`replay ${name}: ${corpus.posts.length} posts; ${JSON.stringify(tally(outcomes))}; digest ${digest(outcomes)}\n`);
    expect(differing).toEqual([]);
    expect(outcomes.filter(({ verdict }) => verdict === 'unknown').map(({ id }) => id), 'posts that the replay cannot compare (KNOWN_UNKNOWN)').toEqual(KNOWN_UNKNOWN[name] ?? []);
  });
}

test('the sample corpus covers every case of the replay: equal comments, D1, D2 and D11, D7, and the repost item that 3.0 does not compare', async (fx) => {
  const { corpus, settings } = load('sample');
  expect(corpus.posts).toHaveLength(21);
  const outcomes = await replay(fx, corpus, settings);
  expect(tally(outcomes)).toEqual({ equal: 15, D1: 1, 'D2/D11': 2, D7: 1, repost: 2, differs: 0 });
  const byAuthor = (author: string) => outcomes.filter(({ id }) => corpus.posts.find((p) => p.id === id)!.author === author);
  // The removals that the replay checks word for word: size and aspect, flair, the rate limit, the source rule at its deadline.
  const removed = outcomes.filter(({ verdict, awb }) => verdict === 'equal' && awb !== undefined);
  expect(removed).toHaveLength(6);
  expect(removed.map(({ awb }) => (awb ?? '').match(/\*\*(Mismatched|Bad resolution|Bad aspect|Rate limit|Missing source)|images are not allowed/)?.[0])).toEqual([
    '**Mismatched', 'images are not allowed', '**Rate limit', '**Rate limit', '**Missing source', '**Missing source',
  ]);
  expect(byAuthor('user00006').map(({ codes }) => codes)).toEqual([['D2/D11'], ['D2/D11'], []]); // the third post of the burst is removed by both
});

test('the replay is deterministic: the same corpus gives the same digest', async (fx) => {
  const { corpus, settings } = load('sample');
  const first = digest(await replay(fx, corpus, settings));
  await fx.mocks.redis.clear(); // a second world in one test: no state of the first is left
  vi.restoreAllMocks();
  expect(digest(await replay(fx, corpus, settings))).toBe(first);
});

test('the replay sees a difference that no D-code explains: a changed threshold, a decision, and a rate-limit post that hides another rule', async (fx) => {
  const { corpus, settings } = load('sample');
  const posts = corpus.posts;
  const change = (id: string, edit: (comment: string) => string) => {
    const post = posts.find((p) => p.id === id)!;
    post.legacy.comment = edit(post.legacy.comment!);
  };
  change('p00002', (comment) => comment.replace('at least **1920x1080**', 'at least **1920x1000**')); // the text of a removal differs
  posts.find((p) => p.id === 'p00001')!.legacy.comment = posts.find((p) => p.id === 'p00011')!.legacy.comment; // legacy removed a post that AWB passes
  posts.find((p) => p.id === 'p00001')!.legacy.action = 'remove';
  change('p00008', (comment) => comment.replace('\n\n*I am a bot', '\n\n- **Bad resolution.**\n\n\t- Horizontal images must be at least **1920x1080**.\n\n*I am a bot')); // D2 must not hide it
  const differing = (await replay(fx, corpus, settings)).filter(({ verdict }) => verdict === 'differs').map(({ id }) => id);
  expect(differing).toEqual(['p00001', 'p00002', 'p00008']);
});

const comment = (corpus: Corpus, id: string) => corpus.posts.find((post) => post.id === id)!.legacy;
const REPOST_ITEM = '\n\n- **Repost detected.**\n\n\t- Please avoid reposting images submitted in the last 6 months.\n\n\t\t- [Image #1](https://i.redd.it/i00001.jpg) matched submission [p00001](https://redd.it/p00001) (2 months ago, [87.65% certainty](https://i.redd.it/i00001.jpg))';
const FOOTER = '\n\n*I am a bot';

test('a legacy comment with a repost item and another item is compared on the other item; a repost item alone leaves nothing to compare', async (fx) => {
  const { corpus, settings } = load('sample');
  // p00011 was removed for the source (legacy requirements A4); legacy also found a repost (the case of D3): the comment has both items.
  const legacy = comment(corpus, 'p00011');
  legacy.comment = legacy.comment!.replace('reason:', 'reasons:').replace(FOOTER, `${REPOST_ITEM}${FOOTER}`);
  const outcomes = await replay(fx, corpus, settings);
  expect(outcomes.find(({ id }) => id === 'p00011')).toMatchObject({ verdict: 'explained', codes: ['repost'] });
  expect(outcomes.filter(({ verdict }) => verdict === 'differs')).toEqual([]);
  await fx.mocks.redis.clear();
  vi.restoreAllMocks();
  // the same comment, but its other item is not the one that AWB makes: the post is not left out, it differs
  legacy.comment = legacy.comment!.replace('**Missing source in comments.**', '**Bad resolution.**');
  expect((await replay(fx, corpus, settings)).filter(({ verdict }) => verdict === 'differs').map(({ id }) => id)).toEqual(['p00011']);
});

test('D2 and D11 explain a rate-limit item that only legacy has; two rate-limit items that differ, or a rate-limit item that only AWB has, are differences', async (fx) => {
  const { corpus, settings } = load('sample');
  // p00009 is the third post of a burst: legacy and AWB both remove it for the rate limit, with the same list. Its author has other posts.
  const burst = comment(corpus, 'p00009');
  burst.comment = burst.comment!.replace('(10 minutes ago)', '(11 minutes ago)'); // the lists differ in a number
  const asLegacyNone = comment(corpus, 'p00007'); // legacy did not remove the third post of the other author; AWB does
  asLegacyNone.action = 'none';
  asLegacyNone.comment = null;
  const differing = (await replay(fx, corpus, settings)).filter(({ verdict }) => verdict === 'differs').map(({ id }) => id);
  expect(differing).toEqual(['p00007', 'p00009']);
});

test('the release needs the real corpora: 200 posts of r/Animewallpaper and 10 of r/AnimePhoneWallpapers (OD11 is open), each present', () => {
  expect(corpusProblems({ animewallpaper: 200, animephonewallpapers: 10 })).toEqual([]);
  expect(corpusProblems({ animewallpaper: 199, animephonewallpapers: 9 })).toEqual([
    'legacy-corpus-animewallpaper.json has 199 posts; the release needs 200',
    'legacy-corpus-animephonewallpapers.json has 9 posts; the release needs 10',
  ]);
  expect(corpusProblems({ animewallpaper: 300 })).toEqual(['legacy-corpus-animephonewallpapers.json is missing']);
  expect(corpusProblems({})).toHaveLength(2);
});

const reset = async (fx: { mocks: { redis: { clear(): Promise<void> } } }) => {
  await fx.mocks.redis.clear();
  vi.restoreAllMocks();
};

test('legacy did not look: only when legacy did nothing, no mod acted, and today\'s config does not skip the post', () => {
  const settings = { exceptAuthors: 'AutoModerator, user00002', flairRules: 'Desktop: horizontal\nAnimated: skip' };
  const post = (legacy: Partial<CorpusPost['legacy']>, rest: Partial<CorpusPost> = {}): CorpusPost => ({
    id: 'p1', author: 'user00009', createdUtc: 0, title: '', flair: 'Desktop', images: [], sourceCommentUtc: null,
    legacy: { action: 'none', comment: null, moderated: false, removedBy: null, approved: false, deleted: false, ...legacy }, ...rest,
  });
  expect(legacyDidNotLook(post({}), settings)).toBe(true);
  for (const legacy of [{ moderated: true }, { action: 'remove' as const }, { removedBy: 'mod' as const }, { approved: true }, { deleted: true }]) {
    expect(legacyDidNotLook(post(legacy), settings), JSON.stringify(legacy)).toBe(false);
  }
  expect(legacyDidNotLook(post({}, { author: 'user00002' }), settings), 'an excepted author').toBe(false);
  expect(legacyDidNotLook(post({}, { flair: 'Animated' }), settings), 'a skip flair').toBe(false);

  expect(beforeDeadline(post({ moderated: true, removedBy: 'mod' }))).toBe(true);
  for (const legacy of [{ moderated: false, removedBy: 'mod' as const }, { moderated: true, removedBy: 'mod' as const, action: 'remove' as const }, { moderated: true, removedBy: 'automod' as const }]) {
    expect(beforeDeadline(post(legacy)), JSON.stringify(legacy)).toBe(false);
  }
});

test('the corpus cannot show the post: legacy did not look, or an AutoModerator removal at an unknown time; legacy passed it: a difference', async (fx) => {
  const { corpus, settings } = load('sample');
  // p00011: AWB removes it for the source at the deadline. Legacy did not remove it in each case below.
  const legacy = comment(corpus, 'p00011');
  const verdict = async () => (await replay(fx, corpus, settings)).find(({ id }) => id === 'p00011')!;
  Object.assign(legacy, { action: 'none', comment: null, moderated: false, removedBy: null });
  expect(await verdict()).toMatchObject({ verdict: 'unknown', codes: ['legacy did not look'] });
  await reset(fx);
  Object.assign(legacy, { moderated: true, removedBy: 'automod' });
  expect(await verdict()).toMatchObject({ verdict: 'unknown', codes: ['AutoModerator removal time not in the corpus'] });
  await reset(fx);
  Object.assign(legacy, { moderated: true, removedBy: null }); // legacy looked and passed it, AWB removes it
  expect(await verdict()).toMatchObject({ verdict: 'differs' });
});

test('a mod removal after legacy looked and did nothing comes before the source deadline, so the app does not act', async (fx) => {
  const { corpus, settings } = load('sample');
  Object.assign(comment(corpus, 'p00011'), { action: 'none', comment: null, moderated: true, removedBy: 'mod' });
  expect((await replay(fx, corpus, settings)).find(({ id }) => id === 'p00011')).toMatchObject({ verdict: 'equal', awb: undefined });
});

test('title lost: a Reddit removal with no size tag left drops only the legacy mismatch item; a post that kept its tag is compared', async (fx) => {
  const { corpus, settings } = load('sample');
  const post = corpus.posts.find(({ id }) => id === 'p00011')!; // AWB removes it for the source
  const mismatch = '\n\n- **Mismatched resolution in title.** Please ensure the resolution tagged in the title exactly matches the resolution of your submitted image.\n\n\t- Tagged resolution in title: 941x1673\n\n\t- Mismatched resolution: 941x1672';
  const legacyText = post.legacy.comment!.replace(/\n\n- \*\*Missing source[\s\S]*?(?=\n\n\*I am a bot)/, mismatch);
  Object.assign(post.legacy, { comment: legacyText, removedBy: 'reddit' });
  post.title = '';
  expect((await replay(fx, corpus, settings)).find(({ id }) => id === 'p00011')).toMatchObject({ verdict: 'explained', codes: ['title lost'] });
  await reset(fx);
  post.title = '(941x1673)'; // the tag is there: the corpus shows what legacy saw, so the items are compared
  expect((await replay(fx, corpus, settings)).find(({ id }) => id === 'p00011')).toMatchObject({ verdict: 'differs' });
});
