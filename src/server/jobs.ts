// The scheduled jobs (plan 5.3): the tick works through the queue.
import { context, reddit } from '@devvit/web/server';
import { NUMBER_SETTINGS } from '../core/config';
import { effectiveMode } from '../core/post';
import type { Config } from '../core/types';
import { alert, reasonOf } from './alert';
import { plural, span } from './menu';
import { completeRemoval, logLine, moderate } from './moderate';
import { readConfig } from './settings';
import { buildReport, SHADOW_DAYS } from './shadow';
import {
  audit, countError, enqueue, enqueueUnknown, lease, loadPost, lockTick, newItemState, nextDue, queueStats, readHealth, recentAudit, release, retimeSeen, savePost,
  unlockTick, writeHealth, type Item, type PostRecord,
} from './store';

const MINUTE = 60_000;
const MAX_ITEMS = 5; // items in one tick
const BUDGET_MS = 15_000; // a new item starts only while at least 15 of the 30 seconds of a request remain
const MAX_KILLS = 3;
const MAX_ERRORS = 3;
const FRESH_MS = 48 * 60 * MINUTE; // the sweep looks at posts of the last 48 hours
const TICK_STALLED_MS = 5 * MINUTE;
const QUEUE_STALLED_MS = 10 * MINUTE;
const MISMATCH_WINDOW_MS = 24 * 60 * MINUTE;
// A removal and its audit entry come from one attempt, and a retry of a killed attempt follows in 2 to 3 minutes: a newer difference is not final.
const MISMATCH_GRACE_MS = 10 * MINUTE;

// The id of the app account does not change: ask once.
async function appUserId(): Promise<string> {
  const known = await readHealth('appUserId');
  if (known) return known;
  const { id } = (await reddit.getAppUser())!;
  await writeHealth({ appUserId: id });
  return id;
}

/** What failed last, for "AWB: status": the time, the item and the reason (no URL). */
const writeLastError = (item: Item, reason: string) =>
  writeHealth({ lastError: `${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${item.kind}:${item.postId}: ${reason}` });

/** The item cannot be done: it gets status error, the mods get an alert, and the tick forgets it. A comment of the app on the post gets its removal first. */
async function giveUp(item: Item, cfg: Config, rec: PostRecord, reason: string, leased: number, startedAt: number): Promise<false> {
  const state = rec.items[item.kind]!;
  state.open = false;
  state.error = reason;
  if (item.kind === 'new') rec.status = 'error';
  await completeRemoval({ item, cfg, rec, state, startedAt });
  await savePost(item.postId, rec);
  await audit({ at: Date.now(), postId: item.postId, kind: item.kind, evt: 'error', mode: effectiveMode(cfg, rec.firstMode), reason });
  await writeLastError(item, reason);
  await countError();
  await release(item, leased);
  await alert('errors', `AWB stopped work on ${item.kind}:${item.postId} (${reason}). Check the post with "AWB: explain".`);
  return false;
}

/** One attempt at one item (plan 5.3 lease). Gives true when the item is finished or waits; false when it failed or another tick has it. */
async function runItem(item: Item, cfg: Config, appUser: string, repostMonths: number): Promise<boolean> {
  const startedAt = Date.now();
  const leased = await lease(item, startedAt);
  if (leased === undefined) return false; // another tick took the item first
  const rec = (await loadPost(item.postId)) ?? (item.kind === 'new' ? { firstMode: cfg.mode, status: 'pending', items: {} } satisfies PostRecord : undefined);
  if (!rec) {
    // A `src:` item of a post whose record is gone: the first mode is unknown, so the app does nothing.
    await audit({ at: Date.now(), postId: item.postId, kind: item.kind, evt: 'skip', mode: cfg.mode, reason: 'no-record' });
    await release(item, leased);
    return true;
  }
  const state = (rec.items[item.kind] ??= newItemState());
  if (state.open) state.kills += 1; // the last attempt did not end
  state.leases += 1;
  state.open = true;
  const save = () => savePost(item.postId, rec);
  await save();
  const mode = effectiveMode(cfg, rec.firstMode);
  if (state.kills >= MAX_KILLS) {
    logLine(startedAt, { evt: 'error', postId: item.postId, kind: item.kind, mode, reason: 'killed' });
    return giveUp(item, cfg, rec, 'killed', leased, startedAt);
  }
  try {
    const { retryAt } = await moderate({ item, cfg, appUserId: appUser, repostMonths, startedAt, rec, state, save });
    state.open = false;
    await save();
    await release(item, leased, retryAt);
    return true;
  } catch (error) {
    state.open = false;
    state.errors += 1;
    logLine(startedAt, { evt: 'error', postId: item.postId, kind: item.kind, mode, error: reasonOf(error), stack: (error as Error).stack });
    if (state.errors >= MAX_ERRORS) return giveUp(item, cfg, rec, reasonOf(error), leased, startedAt);
    await writeLastError(item, reasonOf(error));
    await save();
    // 1 minute, then 15 minutes: a Reddit outage of a few minutes does not use up the 3 errors.
    await release(item, leased, Date.now() + MINUTE * 15 ** (state.errors - 1));
    return false;
  }
}

/** A new `repostMonths` gives the keys that depend on it new TTLs (plan 5.5). A setting that was never applied is the default. */
async function applyRepostMonths(months: number): Promise<void> {
  const before = Number((await readHealth('repostMonthsApplied')) ?? NUMBER_SETTINGS.repostMonths.def);
  if (before === months) return;
  await retimeSeen(months, before, Date.now());
  await writeHealth({ repostMonthsApplied: String(months) });
}

export async function tick(): Promise<void> {
  const lock = await lockTick();
  if (lock === undefined) return;
  try {
    const started = Date.now();
    const { config: cfg, repostMonths } = await readConfig();
    await applyRepostMonths(repostMonths);
    let appUser: string | undefined;
    let worked = 0;
    let succeeded = false;
    while (worked < MAX_ITEMS && Date.now() - started <= BUDGET_MS) {
      const item = await nextDue(Date.now());
      if (!item) break;
      worked += 1;
      try {
        appUser ??= await appUserId();
        succeeded = (await runItem(item, cfg, appUser, repostMonths)) || succeeded;
      } catch (error) {
        // The attempt did not even start or end (Redis or Reddit failed outside it): the tick goes on, and the item comes back in a minute.
        console.error(JSON.stringify({ evt: 'error', sub: context.subredditName, postId: item.postId, kind: item.kind, error: reasonOf(error), stack: (error as Error).stack }));
        await Promise.all([enqueue(item, Date.now() + MINUTE), writeLastError(item, reasonOf(error))]).catch(() => undefined);
      }
    }
    // At the end of the tick, so that a killed tick does not look healthy.
    await writeHealth({ lastTickAt: String(Date.now()), ...(succeeded && { errorStreak: '0' }) });
  } finally {
    await unlockTick(lock);
  }
}

/** Every 5 minutes: puts the posts of /new and of the mod queue that the app does not know into the queue (a trigger can be lost). */
export async function sweep(): Promise<void> {
  const subreddit = context.subredditName!;
  const [fresh, held] = await Promise.all([
    reddit.getNewPosts({ subredditName: subreddit, limit: 100 }).all(),
    reddit.getModQueue({ subreddit, type: 'post', limit: 100 }).all(),
  ]);
  const posts = [...new Map([...fresh, ...held].map((post) => [post.id, post])).values()]
    .filter((post) => Date.now() - post.createdAt.getTime() < FRESH_MS)
    .map((post) => ({ id: post.id, createdAt: post.createdAt.getTime() }));
  if (posts.length > 0) await enqueueUnknown(posts);
}

/**
 * The removals of the app in the last 24 hours: the mod log and the audit must name the same posts (plan 5.4 health, `audit-mismatch`).
 * A removal that is younger than 10 minutes is not final yet.
 */
async function checkAuditMismatch(now: number): Promise<void> {
  const [appUser, entries] = await Promise.all([reddit.getAppUser(), recentAudit(now, 2)]);
  const log = await reddit.getModerationLog({ subredditName: context.subredditName!, moderatorUsernames: [appUser!.username], type: 'removelink', limit: 500 }).all();
  const logged = new Map(log.flatMap(({ target, createdAt }) => (target ? [[target.id, createdAt.getTime()] as const] : [])));
  const audited = new Map(entries.flatMap((e) => (e.evt === 'decision' && e.action === 'remove' ? [[e.postId, e.at] as const] : [])));
  const settled = (at: number) => at >= now - MISMATCH_WINDOW_MS && at <= now - MISMATCH_GRACE_MS;
  const withoutAudit = [...logged].filter(([id, at]) => settled(at) && !audited.has(id)).map(([id]) => id);
  const withoutLog = [...audited].filter(([id, at]) => settled(at) && !logged.has(id)).map(([id]) => id);
  if (withoutAudit.length === 0 && withoutLog.length === 0) return;
  await alert(
    'audit-mismatch',
    [
      'The mod log and the audit of AWB do not agree about the removals of the last 24 hours.',
      ...(withoutAudit.length > 0 ? [`- Removed by AWB with no audit entry: ${withoutAudit.join(', ')}`] : []),
      ...(withoutLog.length > 0 ? [`- Audit entry with no removal in the mod log: ${withoutLog.join(', ')}`] : []),
    ].join('\n\n'),
  );
}

/** The first health run of a UTC day writes the numbers of the shadow report into the audit (plan 5.4), so that each day stays readable for 30 days. */
async function writeDailyShadow(cfg: Config, now: number): Promise<void> {
  const day = new Date(now).toISOString().slice(0, 10);
  if (cfg.mode === 'off' || (await readHealth('shadowDay')) === day) return; // nothing to compare while the mode is off
  const report = await buildReport(SHADOW_DAYS, now);
  await audit({
    at: now,
    evt: 'shadow',
    days: SHADOW_DAYS,
    included: report.included,
    tagged: report.included - report.compared,
    compared: report.compared,
    agree: report.agree,
    awbOnly: report.awbOnly.length,
    legacyOnly: report.legacyOnly.length,
    ...(report.p95Ms !== undefined && { p95Ms: report.p95Ms }),
  });
  await writeHealth({ shadowDay: day });
}

/** Every 15 minutes: tells the mods about a stopped tick or queue, a mod log that does not agree with the audit, and settings that turn a rule off (plan 5.4 health). */
export async function health(): Promise<void> {
  const now = Date.now();
  const [{ config, problems }, lastTick, queue] = await Promise.all([readConfig(), readHealth('lastTickAt'), queueStats()]);
  if (problems.length > 0) await alert('config', `AWB does not use these settings, because their values are not valid:\n\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
  if (lastTick === undefined) await alert('tick-stalled', 'No tick of AWB has ended yet. AWB checks no post until the ticks run.');
  else if (now - Number(lastTick) > TICK_STALLED_MS) await alert('tick-stalled', `The last tick of AWB ended ${span(now - Number(lastTick))} ago. AWB checks no post while the ticks do not end.`);
  if (queue.oldest !== undefined && now - queue.oldest > QUEUE_STALLED_MS) {
    await alert('queue-stalled', `The oldest item in the queue of AWB is ${span(now - queue.oldest)} late (${plural(queue.size, 'item')} wait). AWB checks posts slower than they arrive.`);
  }
  await checkAuditMismatch(now);
  await writeDailyShadow(config, now);
}
