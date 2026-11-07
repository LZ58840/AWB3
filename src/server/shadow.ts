// The shadow report (plan 5.4): for each post, what AWB decided next to what the legacy bot did. It only reads.
// 3.0 compares the quick rules and the source rule. The legacy repost decisions are not compared: they get the tag `repost`.
// 3.1 (AWB repost, in dry-run) compares them: there, the tag `repost` goes and a legacy report that AWB did not make is a difference.
import { context, reddit } from '@devvit/web/server';
import type { ModAction, Post } from '@devvit/web/server';
import type { T3 } from '@devvit/web/shared';
import { isAlive } from '../core/post';
import { getPost, inBatches } from './moderate';
import { readConfig } from './settings';
import { loadPosts, recentAudit, type AuditEntry } from './store';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The days of the report that the form offers first and that the daily numbers use. */
export const SHADOW_DAYS = 7;
/** Legacy comments that one report reads. */
export const COMMENT_READS = 20;
// shortcut: a read of the mod log gives 500 entries at most; a window with more legacy actions loses the oldest. Page by day if a subreddit gets close.
const LOG_LIMIT = 500;
const UNRESOLVED_MS = 48 * HOUR; // a legacy report that no mod touched for 48 hours

// shortcut: the legacy bot name is also in core/post.ts, where it is private; src/core is not open for edit now. Delete both after cut-over 2.
const LEGACY_BOT = 'AnimewallpaperBot';

type Decision = 'remove' | 'report' | 'none';

/** The sections of a legacy comment, by their marker text in the legacy templates (the order of the rules). */
const SECTIONS: [rule: string, marker: string][] = [
  ['flair', 'images are not allowed under the **'],
  ['resolutionMismatch', '**Mismatched resolution'],
  ['resolutionBad', '**Bad resolution.**'],
  ['aspectRatio', '**Bad aspect ratio.**'],
  ['rateLimit', '**Rate limit reached.**'],
  ['sourceComment', '**Missing source in comments.**'],
  ['repost', '**Repost detected.**'],
];
const RULES = SECTIONS.map(([rule]) => rule).filter((rule) => rule !== 'repost');

const IMAGE_LINK = /\[Image #\d+[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
const REDDIT_IMAGE_HOSTS = ['i.redd.it', 'preview.redd.it'];
const hostOf = (url: string) => /^https?:\/\/([^/?#:]+)/.exec(url)?.[1] ?? '';
/** D7: AWB does not check images on other hosts, so a legacy removal for such an image is a known difference. */
const hasExternalImage = (text: string) => [...text.matchAll(IMAGE_LINK)].some(([, url]) => !REDDIT_IMAGE_HOSTS.includes(hostOf(url!)));

const POST_IN_PERMALINK = /\/comments\/([a-z0-9]+)\//;

export interface ShadowReport {
  days: number;
  /** The posts that count were created from `from` to `to` (ms). */
  from: number;
  to: number;
  included: number;
  /** Differences that a tag explains: they stay out of the numbers below. */
  tags: [tag: string, count: number][];
  compared: number;
  agree: number;
  awbOnly: string[];
  legacyOnly: string[];
  /** Legacy-only removals whose comment this report did not read. */
  unread: number;
  /** The posts that a rule removed or would remove (by AWB, or by the legacy comment where it was read), and how many of them agree. */
  rules: { rule: string; posts: number; agree: number }[];
  /** The p95 time from submit to the action (or the would-action) of a quick rule. */
  p95Ms?: number;
}

interface Row {
  id: string;
  createdAt: number;
  awb: Decision;
  legacy: Decision;
  awbRules: string[];
  /** The time of the first quick-rule action or would-action of AWB. */
  actedAt?: number;
  /** The rules in the legacy comment, when it was read. */
  legacyRules: string[];
}

/** The p95 of times, by the nearest-rank method: the value at ceil(0.95 n) in the sorted list. Undefined for no time. */
export function p95(times: number[]): number | undefined {
  return [...times].sort((a, b) => a - b)[Math.ceil(0.95 * times.length) - 1];
}

/** The decision of a `new` item that removes, or would remove, its post: the action of a quick rule (plan AC14 measures the time to it). */
export const isQuickAction = (entry: AuditEntry): boolean => entry.evt === 'decision' && entry.kind === 'new' && (entry.action === 'remove' || entry.action === 'would-remove');

const byAge = (a: Row, b: Row) => a.createdAt - b.createdAt || a.id.length - b.id.length || (a.id < b.id ? -1 : 1);

/** What the mods did with a post after the legacy bot reported it (plan 5.4 step 4). `post` is undefined for a post that is gone. */
function reportTag(post: Post | undefined, reportedAt: number, now: number): string {
  if (post?.approved) return 'legacy-fp';
  return post && isAlive(post) && now - reportedAt > UNRESOLVED_MS ? 'unresolved' : 'repost';
}

async function legacyComment(postId: string): Promise<string | undefined> {
  const comments = await reddit.getComments({ postId: postId as T3, depth: 1, limit: 100 }).all();
  return comments.find((c) => c.authorName === LEGACY_BOT && c.body.startsWith('Thank you for contributing to r/'))?.body;
}

export async function buildReport(days: number, now: number): Promise<ShadowReport> {
  const { config } = await readConfig();
  const start = now - days * DAY;
  const from = start + HOUR;
  const to = now - ((config.sourceComment?.hours ?? 0) + 1) * HOUR;

  const subredditName = context.subredditName!;
  const legacyLog = (type: 'removelink' | 'removecomment') => reddit.getModerationLog({ subredditName, moderatorUsernames: [LEGACY_BOT], type, limit: LOG_LIMIT }).all();
  const [removalLog, commentLog, entries] = await Promise.all([legacyLog('removelink'), legacyLog('removecomment'), recentAudit(now, days + 1)]);

  // The legacy decision of each post from the mod log: a removed post is a removal; a removed legacy comment is a report.
  const timesOf = (actions: ModAction[], postOf: (action: ModAction) => string | undefined) => {
    const times = new Map<string, number>();
    for (const action of actions) {
      const id = postOf(action);
      if (id && action.createdAt.getTime() >= start) times.set(id, action.createdAt.getTime());
    }
    return times;
  };
  const legacyRemoved = timesOf(removalLog, (a) => (a.target?.id.startsWith('t3_') ? a.target.id : undefined));
  const legacyReported = timesOf(commentLog, (a) => {
    const id = POST_IN_PERMALINK.exec(a.target?.permalink ?? '')?.[1];
    return id ? `t3_${id}` : undefined;
  });

  // The decision of AWB: any removal or would-removal of the post.
  const awb = new Map<string, { remove: boolean; rules: Set<string>; actedAt?: number }>();
  for (const entry of entries) {
    if (entry.evt !== 'decision' && entry.evt !== 'skip') continue;
    const post = awb.get(entry.postId) ?? { remove: false, rules: new Set<string>() };
    if (entry.action === 'remove' || entry.action === 'would-remove') {
      post.remove = true;
      for (const rule of entry.rules ?? []) post.rules.add(rule);
      if (isQuickAction(entry)) post.actedAt ??= entry.at;
    }
    awb.set(entry.postId, post);
  }

  // The time of each post: from its record. A post that only the legacy bot acted on can have no record: Reddit gives its time (10 reads at a time).
  const ids = [...new Set([...awb.keys(), ...legacyRemoved.keys(), ...legacyReported.keys()])];
  const records = await loadPosts(ids);
  const created = new Map<string, number>();
  const unrecorded: string[] = [];
  ids.forEach((id, i) => {
    const known = records[i]?.createdAt;
    if (known !== undefined) created.set(id, known);
    else if (!awb.has(id)) unrecorded.push(id);
  });
  (await inBatches(unrecorded, getPost)).forEach((post, i) => post && created.set(unrecorded[i]!, post.createdAt.getTime()));
  const rows: Row[] = ids.flatMap((id) => {
    const createdAt = created.get(id);
    if (createdAt === undefined || createdAt < from || createdAt > to) return [];
    const mine = awb.get(id);
    return [{
      id, createdAt, awb: mine?.remove ? 'remove' : 'none', legacy: legacyRemoved.has(id) ? 'remove' : legacyReported.has(id) ? 'report' : 'none',
      awbRules: [...(mine?.rules ?? [])], actedAt: mine?.actedAt, legacyRules: [],
    } satisfies Row];
  });

  // Tags. A legacy report that AWB does not repeat is a repost report (3.0 has no repost). A legacy removal that AWB did not make is read:
  // a comment with a repost section only is a repost removal; an image on another host is D7; the rate limit alone is D2/D11. A removal of
  // AWB that legacy did not make gets no tag, also for the rate limit alone: D2 and D11 make AWB count fewer posts, not more.
  const tags = new Map<string, string>();
  const reports = rows.filter((r) => r.legacy === 'report' && r.awb === 'none');
  const notRepeated = rows.filter((r) => r.legacy === 'remove' && r.awb === 'none').sort(byAge);
  const toRead = notRepeated.slice(0, COMMENT_READS);
  const states = await inBatches(reports, (r) => getPost(r.id));
  const texts = await inBatches(toRead, (r) => legacyComment(r.id));
  reports.forEach((r, i) => tags.set(r.id, reportTag(states[i], legacyReported.get(r.id)!, now)));
  toRead.forEach((r, i) => {
    const text = texts[i] ?? '';
    const sections = SECTIONS.filter(([, marker]) => text.includes(marker)).map(([rule]) => rule);
    if (sections.length > 0 && sections.every((rule) => rule === 'repost')) tags.set(r.id, 'repost');
    else if (hasExternalImage(text)) tags.set(r.id, 'D7');
    // D2, D11: legacy also counted the later posts of the author and the posts that it had removed itself, so it removes where AWB does not.
    else if (sections.length === 1 && sections[0] === 'rateLimit') tags.set(r.id, 'D2/D11');
    r.legacyRules = sections.filter((rule) => rule !== 'repost');
  });

  const compared = rows.filter((r) => !tags.has(r.id));
  const counts = new Map<string, number>();
  for (const tag of tags.values()) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const latencies = rows.flatMap((r) => (r.actedAt === undefined ? [] : [r.actedAt - r.createdAt]));
  const rules = RULES.map((rule) => {
    const named = compared.filter((r) => (r.awb === 'remove' ? r.awbRules : []).includes(rule) || r.legacyRules.includes(rule));
    return { rule, posts: named.length, agree: named.filter((r) => r.awb === r.legacy).length };
  }).filter(({ posts }) => posts > 0);

  return {
    days,
    from,
    to,
    included: rows.length,
    tags: [...counts].sort(([a], [b]) => (a < b ? -1 : 1)),
    compared: compared.length,
    agree: compared.filter((r) => r.awb === r.legacy).length,
    awbOnly: compared.filter((r) => r.awb === 'remove' && r.legacy !== 'remove').sort(byAge).map((r) => r.id),
    legacyOnly: compared.filter((r) => r.legacy === 'remove' && r.awb === 'none').sort(byAge).map((r) => r.id),
    unread: notRepeated.length - toRead.length,
    rules,
    ...(latencies.length > 0 && { p95Ms: p95(latencies) }),
  };
}
