// The mod menus (plan 9): "AWB: status" and "AWB: explain" show facts from Redis in the info form of devvit.json; "AWB: shadow report" asks
// for the days in a form and shows the report of shadow.ts in the same info form.
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import type { AuditEntry, ItemState, ShadowEntry } from './store';
import { isShadow, loadPost, loadPosts, queueStats, readHealth, recentAudit } from './store';
import { readConfig } from './settings';
import { buildReport, COMMENT_READS, isQuickAction, p95, SHADOW_DAYS, type ShadowReport } from './shadow';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The info form, with one read-only text. */
const info = (title: string, lines: string[]): UiResponse => ({
  showForm: {
    name: 'info',
    form: { title, acceptLabel: 'Close', fields: [{ type: 'paragraph', name: 'text', label: title, defaultValue: lines.join('\n'), disabled: true }] },
  },
});

export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** Minutes below 1 hour, hours below 3 days, then days. */
export function span(ms: number): string {
  if (ms < MINUTE) return 'less than a minute';
  return ms < HOUR ? plural(Math.floor(ms / MINUTE), 'minute') : ms < 3 * DAY ? plural(Math.floor(ms / HOUR), 'hour') : plural(Math.floor(ms / DAY), 'day');
}

function decisions(label: string, entries: AuditEntry[]): string[] {
  const made = entries.filter((e) => e.evt === 'decision');
  const count = (action: string) => made.filter((e) => e.action === action).length;
  const rules = new Map<string, number>();
  for (const e of made) if (e.action !== 'none') for (const rule of e.rules ?? []) rules.set(rule, (rules.get(rule) ?? 0) + 1);
  const top = [...rules].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([rule, n]) => `${rule} ${n}`);
  return [
    `Decisions ${label}: ${made.length} (${count('remove')} remove, ${count('would-remove')} would remove, ${count('none')} no action); skipped: ${entries.filter((e) => e.evt === 'skip').length}`,
    `Rules that removed or would remove ${label}: ${top.join(', ') || 'none'}`,
  ];
}

export async function status(): Promise<UiResponse> {
  const now = Date.now();
  const [{ config }, queue, lastTick, streak, lastError, week] = await Promise.all([
    readConfig(), queueStats(), readHealth('lastTickAt'), readHealth('errorStreak'), readHealth('lastError'),
    recentAudit(now, 7).then((entries) => entries.filter((e): e is AuditEntry => !isShadow(e))),
  ]);
  // The time from submit to the action of a quick rule, as the shadow report counts it.
  const acted = new Map(week.filter(isQuickAction).map((e) => [e.postId, e.at]));
  const created = await loadPosts([...acted.keys()]);
  const latency = p95([...acted].flatMap(([, at], i) => (created[i]?.createdAt === undefined ? [] : [at - created[i]!.createdAt!])));
  const today = new Date(now).toISOString().slice(0, 10);
  const [todayDecisions, todayRules] = decisions('today', week.filter((e) => new Date(e.at).toISOString().slice(0, 10) === today));
  const [weekDecisions, weekRules] = decisions('in 7 days', week);
  return info('AWB status', [
    `Mode: ${config.mode}`,
    `Last tick: ${lastTick === undefined ? 'never' : `${span(now - Number(lastTick))} ago`}`,
    `Queue: ${queue.size === 0 || queue.oldest === undefined ? 'empty' : `${plural(queue.size, 'item')}; the oldest is ${queue.oldest > now ? `due in ${span(queue.oldest - now)}` : `${span(now - queue.oldest)} late`}`}`,
    `Errors in a row: ${streak ?? 0}`,
    `Last error: ${lastError ?? 'none'}`,
    `p95 time from submit to action, quick rules, 7 days: ${seconds(latency, 'no action')}`,
    todayDecisions!, weekDecisions!, todayRules!, weekRules!,
  ]);
}

function itemLine(kind: string, s: ItemState): string {
  const decision = [s.action, s.rules?.length ? `rules ${s.rules.join(', ')}` : undefined].filter(Boolean).join('; ');
  const steps = [s.commentId && 'comment', s.distinguished && 'distinguish', s.locked && 'lock', s.removed && 'removal'].filter((step) => typeof step === 'string');
  const counters = [plural(s.leases, 'lease'), plural(s.kills, 'kill'), plural(s.errors, 'error'), plural(s.mediaWaits, 'media wait')].join(', ');
  return `${kind}: ${[decision, counters, steps.length > 0 ? `${list(steps)} done` : '', s.error ? `error: ${s.error}` : ''].filter(Boolean).join('; ')}`;
}

export async function explain({ targetId }: MenuItemRequest): Promise<UiResponse> {
  const rec = await loadPost(targetId);
  if (!rec) return info('AWB explain', [`Post ${targetId}`, 'AWB has no record of this post: it did not see the post yet, or the record is older than 30 days.']);
  return info('AWB explain', [
    `Post ${targetId}`,
    `Status: ${rec.status}`,
    `First mode: ${rec.firstMode}`,
    ...(rec.createdAt === undefined ? [] : [`Created: ${new Date(rec.createdAt).toISOString().slice(0, 19).replace('T', ' ')} UTC`]),
    ...Object.entries(rec.items).map(([kind, state]) => itemLine(kind, state)),
  ]);
}

const LIST_MAX = 50;

const pct = (part: number, whole: number) => (whole === 0 ? 'none' : `${((100 * part) / whole).toFixed(1)}%`);
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const seconds = (ms: number | undefined, none: string) => (ms === undefined ? none : plural(Math.round(ms / 1000), 'second'));
const posts = (ids: string[]) => `(${ids.length}): ${ids.length === 0 ? 'none' : ids.slice(0, LIST_MAX).join(', ') + (ids.length > LIST_MAX ? ` and ${ids.length - LIST_MAX} more` : '')}`;

function shadowLines(r: ShadowReport, daily: ShadowEntry[]): string[] {
  const tagged = r.tags.reduce((sum, [, count]) => sum + count, 0);
  return [
    `Shadow report: the last ${plural(r.days, 'day')}, posts created from ${stamp(r.from)} to ${stamp(r.to)} UTC`,
    `Posts in the report: ${r.included}`,
    `Left out because a tag explains the difference: ${tagged}${tagged > 0 ? ` (${r.tags.map(([tag, count]) => `${tag} ${count}`).join(', ')})` : ''}`,
    `Posts compared: ${r.compared}`,
    `Agreement: ${pct(r.agree, r.compared)} (${r.agree} of ${r.compared})`,
    `Share of AWB-only removals: ${pct(r.awbOnly.length, r.compared)} (${r.awbOnly.length} of ${r.compared})`,
    ...r.rules.map(({ rule, posts: n, agree }) => `Rule ${rule}: ${plural(n, 'post')}, agreement ${pct(agree, n)}`),
    `p95 time from submit to action, quick rules: ${seconds(r.p95Ms, 'no action')}`,
    `AWB-only removals ${posts(r.awbOnly)}`,
    `Legacy-only removals ${posts(r.legacyOnly)}`,
    ...(r.unread > 0 ? [`Legacy-only removals whose comment was not read: ${r.unread} (AWB reads at most ${COMMENT_READS})`] : []),
    ...(daily.length === 0
      ? ['Daily numbers from the audit: none yet']
      : [
          'Daily numbers from the audit:',
          ...daily.map((e) => `- ${new Date(e.at).toISOString().slice(0, 10)}: ${plural(e.compared, 'post')} compared, agreement ${pct(e.agree, e.compared)}, AWB-only removals ${pct(e.awbOnly, e.compared)}, p95 ${seconds(e.p95Ms, 'none')}`),
        ]),
  ];
}

/** The menu item asks for the number of days; the form answers with the report. */
export const shadowReportMenu = async (): Promise<UiResponse> => ({
  showForm: {
    name: 'shadowReport',
    form: {
      title: 'AWB shadow report',
      description: 'Compares the decisions of AWB with the actions of the legacy bot.',
      acceptLabel: 'Show the report',
      fields: [{ type: 'number', name: 'days', label: 'Days to compare (1 to 7)', defaultValue: SHADOW_DAYS, required: true }],
    },
  },
});

export async function shadowReport(form?: { days?: unknown }): Promise<UiResponse> {
  const days = form?.days;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 7) return { showToast: 'Write a whole number of days from 1 to 7.' };
  const now = Date.now();
  const [report, entries] = await Promise.all([buildReport(days, now), recentAudit(now, 8)]);
  return info('AWB shadow report', shadowLines(report, entries.filter(isShadow).slice(-7)));
}
