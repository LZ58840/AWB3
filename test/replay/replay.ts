// The replay runner (plan 7.4 "Replay"). It submits each post of a legacy corpus to the simulator at its legacy time, with the legacy
// settings, and compares what the app did with what the legacy bot did. The corpus is the file of tools/capture_fixtures.py.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { redis } from '@devvit/web/server';
import { vi } from 'vitest';
import { app } from '../../src/server/app';
import type { Fx } from '../flows/helpers';
import { createSim } from '../sim/sim';
import { legacySettings, parseYaml, type Settings } from './legacyConfig';

export interface CorpusPost {
  id: string;
  author: string;
  createdUtc: number;
  /** Only the size tags of the title. */
  title: string;
  flair: string | null;
  images: { url: string; width: number; height: number }[];
  /** The first top-level comment of the author. */
  sourceCommentUtc: number | null;
  legacy: {
    action: 'remove' | 'report' | 'none';
    comment: string | null;
    moderated: boolean;
    removedBy: 'awb' | 'automod' | 'mod' | null;
    approved: boolean;
    deleted: boolean;
  };
}
export interface Corpus {
  subreddit: string;
  posts: CorpusPost[];
}

export interface Outcome {
  id: string;
  /** The legacy removal comment, and the comment of the app (undefined: no removal). */
  legacy?: string;
  awb?: string;
  verdict: 'equal' | 'explained' | 'differs';
  /** The D-codes that explain the difference. */
  codes: string[];
}

const REDDIT_IMAGE_HOSTS = ['i.redd.it', 'preview.redd.it'];
const isExternal = ({ images }: CorpusPost) => images.some(({ url }) => !REDDIT_IMAGE_HOSTS.includes(new URL(url).hostname));

// The legacy templates by their marker text: the rule of each top-level item of a comment (the same markers as capture_fixtures.py).
const MARKERS: [rule: string, marker: string][] = [
  ['flair', 'images are not allowed under the **'],
  ['resolutionMismatch', '**Mismatched resolution'],
  ['resolutionBad', '**Bad resolution.**'],
  ['aspectRatio', '**Bad aspect ratio.**'],
  ['rateLimit', '**Rate limit reached.**'],
  ['sourceComment', '**Missing source in comments.**'],
  ['repost', '**Repost detected.**'],
];
const IMAGE_RULES = ['flair', 'resolutionMismatch', 'resolutionBad', 'aspectRatio']; // the rules that read the images

interface Item {
  rule: string;
  text: string;
}

/** The items of a removal comment: its top-level `- ` bullets. The bullets of the flair rule (one for each orientation) are one item. */
function items(comment: string | undefined): Item[] {
  if (!comment) return [];
  const bullets = comment.slice(0, comment.indexOf('\n\n*I am a bot')).split(/\n\n(?=- )/).slice(1); // the first piece is the header
  return bullets.reduce<Item[]>((list, text) => {
    const rule = MARKERS.find(([, marker]) => text.includes(marker))?.[0] ?? 'unknown';
    const last = list.at(-1);
    if (rule === 'flair' && last?.rule === 'flair') last.text += `\n\n${text}`;
    else list.push({ rule, text });
    return list;
  }, []);
}

const same = (a: Item[], b: Item[]) => JSON.stringify(a) === JSON.stringify(b);
const numbered = (list: Item[]) => list.map((item) => ({ ...item, text: item.text.replace(/\[Image #\d+/g, '[Image #') }));

/**
 * Do the items of the legacy comment and of the app agree, with the approved differences?
 * D2, D11: legacy has a rate-limit item that AWB does not have, and the author has another post in the window (legacy also counted later
 * posts and posts that it had removed itself; AWB counts earlier posts that are not removed now). Two rate-limit items that differ, and a
 * rate-limit item that only AWB has (a removal that legacy did not make), are not explained.
 * D7: AWB does not see the images on other hosts, so the legacy items of the image rules are dropped; and when nothing else is left of the
 * legacy removal, the source check of AWB goes too (the legacy removal flag had stopped that check, AWB runs it on the post that passes).
 * D1: the image numbers. Nothing else is explained.
 */
function reconcile(legacy: Item[], awb: Item[], { peers, external }: { peers: boolean; external: boolean }): string[] | undefined {
  const codes: string[] = [];
  let [l, a] = [legacy, awb];
  const hasRate = (list: Item[]) => list.some(({ rule }) => rule === 'rateLimit');
  if (!same(l, a) && peers && hasRate(l) && !hasRate(a)) {
    codes.push('D2/D11');
    l = l.filter(({ rule }) => rule !== 'rateLimit');
  }
  if (!same(l, a) && external && l.some(({ rule }) => IMAGE_RULES.includes(rule))) {
    codes.push('D7');
    l = l.filter(({ rule }) => !IMAGE_RULES.includes(rule));
    if (l.length === 0) a = a.filter(({ rule }) => rule !== 'sourceComment');
  }
  if (!same(l, a) && same(numbered(l), numbered(a))) codes.push('D1');
  return same(l, a) || same(numbered(l), numbered(a)) ? codes : undefined;
}

/** The posts in the order of their legacy time, each at that time; the source checks and the work of the queue run when they are due. */
export async function replay(fx: Fx, corpus: Corpus, settings: Settings): Promise<Outcome[]> {
  const posts = [...corpus.posts].sort((a, b) => a.createdUtc - b.createdUtc || (a.id < b.id ? -1 : 1));
  vi.spyOn(console, 'log').mockImplementation(() => undefined); // the app writes a log line for each decision
  const sim = createSim(app, fx, { start: posts[0]!.createdUtc * 1000 });
  sim.install(corpus.subreddit, settings);
  const sourceSeconds = settings.sourceComment === true && typeof settings.sourceHours === 'number' ? settings.sourceHours * 3600 : 0;
  const windowSeconds = settings.rateLimit === true && typeof settings.rateLimitHours === 'number' ? settings.rateLimitHours * 3600 : 0;
  const worldId = new Map<string, string>(); // corpus id to the id of the post in the simulator

  const drain = async () => {
    for (let ticks = 0; (await redis.zRange('due', 0, Date.now(), { by: 'score', limit: { offset: 0, count: 1 } })).length > 0; ticks++) {
      if (ticks >= 50) throw new Error('the queue of the app does not drain');
      await sim.runJob('tick');
    }
  };
  // What the mods did with the post: approved, deleted by the author, removed by a mod or by AutoModerator. The legacy bot removes a post
  // itself (removedBy awb): that state comes from the decision of the app.
  const state = async ({ id, legacy }: CorpusPost) => {
    const post = sim.world.posts.get(worldId.get(id) as never)!;
    if (legacy.approved && !post.approved) await sim.approve(post.id);
    if (legacy.deleted) await sim.userDelete(post.id);
    if (legacy.removedBy !== null && legacy.removedBy !== 'awb' && !post.removed) await sim.modRemove(post.id, legacy.removedBy === 'automod' ? { mod: 'AutoModerator' } : {});
  };
  // The legacy bot that did not run the rules (moderated false, no action) saw such a state, or had a setting that skips the post: the state
  // comes before the first look. Otherwise the mods acted later: after the decision, which for a source rule is its deadline.
  const sawState = ({ legacy }: CorpusPost) => !legacy.moderated && legacy.action === 'none';

  const events = posts.flatMap((post) => [
    { at: post.createdUtc, post, kind: 'submit' as const },
    { at: post.createdUtc + (sourceSeconds > 0 ? sourceSeconds + 120 : 0), post, kind: 'later' as const },
  ]).sort((a, b) => a.at - b.at); // stable: the submit of a post is before its later actions
  for (const { at, post, kind } of events) {
    vi.setSystemTime(at * 1000);
    await drain();
    if (kind === 'submit') {
      const created = await sim.submit({
        author: post.author, title: post.title, flair: post.flair ?? undefined,
        ...(isExternal(post) ? { kind: 'link' as const, url: post.images[0]!.url } : { images: post.images }),
      });
      worldId.set(post.id, created.id);
      if (sawState(post)) await state(post);
      // A source comment before the deadline is there at the deadline; one after the deadline is too late for the legacy bot and for the app.
      if (sourceSeconds > 0 && post.sourceCommentUtc !== null && post.sourceCommentUtc <= post.createdUtc + sourceSeconds) await sim.comment(created.id, post.author, 'Source: the artist');
    } else if (!sawState(post)) await state(post);
    await drain();
  }

  // The simulator names posts t3_p1, p2, ...; the corpus names them with pseudonyms, as the legacy comments do.
  const corpusId = new Map([...worldId].map(([id, world]) => [world.slice(3), id]));
  const named = (text: string) => text.replace(/\[(\w+)\]\(https:\/\/redd\.it\/\1\)/g, (link, id: string) => (corpusId.has(id) ? `[${corpusId.get(id)}](https://redd.it/${corpusId.get(id)})` : link));
  return posts.map((post): Outcome => {
    const sent = sim.actions(worldId.get(post.id)!).find((call) => call.type === 'comment') as { text: string } | undefined;
    const awb = sent && named(sent.text);
    const legacy = post.legacy.action === 'none' ? undefined : (post.legacy.comment ?? undefined);
    // 3.0 has no repost: the repost item of a legacy comment is not compared, the other items are.
    const legacyAll = items(legacy);
    const legacyItems = legacyAll.filter(({ rule }) => rule !== 'repost');
    const repost = legacyAll.length > legacyItems.length ? ['repost'] : [];
    if (repost.length === 0 && legacy === awb) return { id: post.id, legacy, awb, verdict: 'equal', codes: [] };
    const peers = windowSeconds > 0 && posts.some((other) => other !== post && other.author === post.author && Math.abs(other.createdUtc - post.createdUtc) < windowSeconds);
    const explained = reconcile(legacyItems, items(awb), { peers, external: isExternal(post) });
    const codes = explained && [...repost, ...explained];
    return { id: post.id, legacy, awb, verdict: codes === undefined ? 'differs' : codes.length === 0 ? 'equal' : 'explained', codes: codes ?? [] };
  });
}

/** How many posts each case has: equal, each D-code, the repost item that is not compared, differs. */
export function tally(outcomes: Outcome[]): Record<string, number> {
  const counts: Record<string, number> = { equal: 0, D1: 0, 'D2/D11': 0, D7: 0, repost: 0, differs: 0 };
  for (const { verdict, codes } of outcomes) {
    if (verdict === 'explained') for (const code of codes) counts[code] = (counts[code] ?? 0) + 1;
    else counts[verdict] = (counts[verdict] ?? 0) + 1;
  }
  return counts;
}

/** One number for the whole result, so that the replay of the rc build and of the 3.0 build can be compared: equal digests, equal results. */
export const digest = (outcomes: Outcome[]): string =>
  createHash('sha256').update(JSON.stringify(outcomes.map(({ id, awb, verdict, codes }) => [id, awb ?? null, verdict, codes]))).digest('hex').slice(0, 12);

/** The corpora that a release needs (AC3, 7.6): at least 200 posts of r/Animewallpaper and, until OD11 is decided, 10 of r/AnimePhoneWallpapers. */
export const RELEASE_CORPORA: Record<string, number> = { animewallpaper: 200, animephonewallpapers: 10 };

/** What is wrong with the real corpora: `posts` gives the number of posts of each corpus file, undefined for a file that is missing. */
export const corpusProblems = (posts: Record<string, number | undefined>): string[] =>
  Object.entries(RELEASE_CORPORA).flatMap(([name, least]) => {
    const count = posts[name];
    return count === undefined ? [`legacy-corpus-${name}.json is missing`] : count < least ? [`legacy-corpus-${name}.json has ${count} posts; the release needs ${least}`] : [];
  });

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** The names of the corpora in test/fixtures: legacy-corpus-<name>.json. */
export const corpusNames = (): string[] => readdirSync(FIXTURES).flatMap((file) => /^legacy-corpus-(.+)\.json$/.exec(file)?.slice(1) ?? []);

/** A corpus and its legacy settings (legacy-config-<name>.yaml). A file that is missing is an error: a corpus without its settings is not replayed by guess. */
export function loadCorpus(name: string): { corpus: Corpus; settings: Settings } {
  const read = (file: string) => readFileSync(FIXTURES + file, 'utf8');
  return { corpus: JSON.parse(read(`legacy-corpus-${name}.json`)) as Corpus, settings: legacySettings(parseYaml(read(`legacy-config-${name}.yaml`))) };
}
