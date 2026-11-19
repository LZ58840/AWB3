// The flows of plan 5.4: what the app does with one post.
import { context, reddit } from '@devvit/web/server';
import type { Comment, Post } from '@devvit/web/server';
import type { T1, T3 } from '@devvit/web/shared';
import { NUMBER_SETTINGS } from '../core/config';
import { evaluateQuick, skipReason, type SkipInput } from '../core/evaluate';
import { renderComment } from '../core/messages';
import { effectiveMode, isAlive, isDeleted, isRemoved, postImages, skipsAsRemoved, type ImageSource } from '../core/post';
import { checkSource } from '../core/rules/sourceComment';
import type { Config, Failure, Mode, PostImage, RateCandidate } from '../core/types';
import { alert, reasonOf } from './alert';
import { audit, enqueue, rateHistory, recordRate, type AuditEntry, type Item, type ItemState, type Kind, type PostRecord } from './store';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const MEDIA_WAITS = 5;
const MEDIA_EXTRA_MS = 10 * MINUTE; // one more chance for a slow gallery, after its 5 waits
const READS = 10; // Reddit reads at one time

/** One attempt at an item. The flow changes `rec` and `state` and calls `save` after each step that must not be done twice. */
export interface Run {
  item: Item;
  cfg: Config;
  appUserId: string;
  /** When the tick took the item (ms): the `ms` of the log line. */
  startedAt: number;
  rec: PostRecord;
  state: ItemState;
  save: () => Promise<unknown>;
}

interface LogFields {
  evt: string;
  postId: string;
  kind: Kind;
  mode: Mode;
  rules?: string[];
  action?: string;
  reason?: string;
  error?: string;
  stack?: string;
}

/** One JSON line in the app log (plan 9). It has no title and no URL. */
export function logLine(startedAt: number, { evt, postId, kind, mode, rules = [], action = 'none', ...more }: LogFields): void {
  const line = JSON.stringify({ evt, sub: context.subredditName, postId, kind, mode, rules, action, ms: Date.now() - startedAt, ...more });
  if (evt === 'error') console.error(line);
  else console.log(line);
}

/** What a flow gives back to the tick: nothing, or the time to try the item again. */
interface Outcome {
  retryAt?: number;
}

// A post that Reddit does not know any more: the client throws Error("no post <id>") (Post.getById in @devvit/reddit). Any other error is a
// failure of Reddit or of the network, and the item tries again.
const GONE = /^Error: no post /;
export async function getPost(id: string): Promise<Post | undefined> {
  try {
    return await reddit.getPostById(id as T3);
  } catch (error) {
    if (GONE.test(String(error))) return undefined;
    throw error;
  }
}

/** `work` for each item, `READS` at one time: an author with many posts, or a long list of posts, does not start many reads at once. */
export async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += READS) results.push(...(await Promise.all(items.slice(i, i + READS).map(work))));
  return results;
}

// The other posts of the author in the rate window, each with its state now (plan 5.4 step 4). A post that is gone counts as deleted.
// The message of the rule lists every counted post, and the oldest gives the time to wait: all of them are read.
async function rateCandidates(post: Post, hours: number): Promise<RateCandidate[]> {
  const entries = await rateHistory(post.authorId!, post.createdAt.getTime(), hours * HOUR);
  return inBatches(
    entries.filter(({ member }) => member !== post.id),
    async ({ member, score }): Promise<RateCandidate> => {
      const other = await getPost(member);
      return other
        ? { id: member, createdAt: score, removed: other.removed, spam: other.spam, approved: other.approved, removedBy: other.removedBy, removedByCategory: other.removedByCategory, authorName: other.authorName }
        : { id: member, createdAt: score, removed: false, spam: false, approved: false, removedByCategory: 'deleted' };
    },
  );
}

// An image that is not valid yet: it would count if its status were valid (GalleryMediaStatus.VALID is 1).
function hasPendingImages(post: Post, parent: Post | undefined, images: PostImage[]): boolean {
  // S2 (2026-11-15): an 8K PNG had, for some minutes, no gallery entry (single image) or entries with status 0 and no URL (gallery).
  const source = post.crosspostParentId ? parent : post;
  if (source && IMAGE_POST.test(source.url) && !NOT_PNG_OR_JPG.test(source.url) && (source.gallery.length === 0 || source.gallery.some((g) => g.status !== 1))) return true;
  const asValid = (p: Post): ImageSource => ({ url: p.url, crosspostParentId: p.crosspostParentId, gallery: p.gallery.map((g) => ({ ...g, status: 1 })) });
  return postImages(asValid(post), parent && asValid(parent)).length > images.length;
}

const skipInput = (post: Post): SkipInput => ({
  removed: post.removed,
  spam: post.spam,
  approved: post.approved,
  removedBy: post.removedBy,
  removedByCategory: post.removedByCategory,
  authorId: post.authorId,
  authorName: post.authorName,
  title: post.title,
  flair: post.flair?.text,
});

// The comment of an earlier attempt that was killed before it could write down the comment id.
async function ownComment(post: Post, appUserId: string): Promise<Comment | undefined> {
  const comments = await reddit.getComments({ postId: post.id, depth: 1, sort: 'new', limit: 100 }).all();
  return comments.find((c) => c.authorId === appUserId);
}

/** R9: comment, distinguish and sticky, lock, remove. A marker follows each call, so a retry does only what is left. */
async function remove({ state, save }: Run, post: Post, failures: Failure[]): Promise<void> {
  let reply: Comment | undefined;
  if (state.commentId === undefined) {
    state.replyingAt = Date.now();
    await save(); // before the call: a kill can leave a comment of which the app has no id
    reply = await reddit.submitComment({ id: post.id, text: renderComment(context.subredditName!, failures) });
    state.commentId = reply.id;
    await save();
  }
  if (!state.distinguished) {
    await (reply ?? (await reddit.getCommentById(state.commentId as T1))).distinguish(true);
    state.distinguished = true;
    await save();
  }
  if (!state.locked) {
    await post.lock();
    state.locked = true;
    await save();
  }
  if (!state.removed) {
    state.removing = true;
    await save(); // before the call: a kill after it leaves a removal that the app did not write down (see `removedBefore`)
    await post.remove(false);
    state.removed = true;
    await save();
  }
}

/** Writes an audit entry and a log line for it, in the effective mode of the post. */
async function record({ item, cfg, rec, startedAt }: Pick<Run, 'item' | 'cfg' | 'rec' | 'startedAt'>, more: Pick<AuditEntry, 'evt'> & Partial<AuditEntry>): Promise<void> {
  const entry: AuditEntry = { at: Date.now(), postId: item.postId, kind: item.kind, mode: effectiveMode(cfg, rec.firstMode), ...more };
  await audit(entry);
  logLine(startedAt, { evt: entry.evt, postId: entry.postId, kind: entry.kind, mode: entry.mode, rules: entry.rules, action: entry.action, reason: entry.reason });
}

/** The app removed the post, and a kill came before it wrote that down: the post is removed, and the removal is the app's. */
function removedBefore({ state }: Run, post: Post): void {
  if (state.removing && isRemoved(post)) state.removed = true;
}

/**
 * The end of both flows. A removal that an earlier attempt began (its comment is on the post) is finished as it was decided then: the rules,
 * the mode and the flair at the retry do not matter, because the comment is public, and a comment that says "removed" must have a removal.
 * Otherwise the failures go to Reddit in enforce mode, and in dry-run only to the audit. The action in the audit is what Reddit shows.
 */
async function decide(run: Run, post: Post, mode: Mode, failures: Failure[]): Promise<void> {
  const { state, appUserId, save } = run;
  if (state.replyingAt !== undefined && state.commentId === undefined) {
    const found = await ownComment(post, appUserId); // an attempt was killed in the comment call: its comment may be on the post
    if (found) {
      state.commentId = found.id;
      await save();
    }
  }
  const began = state.commentId !== undefined;
  const rules = began ? (state.rules ?? []) : failures.map((f) => f.rule);
  state.rules = rules;
  if (began || (failures.length > 0 && mode === 'enforce')) await remove(run, post, failures);
  state.action = state.removed ? 'remove' : rules.length === 0 ? 'none' : mode === 'enforce' ? 'remove' : 'would-remove';
  await record(run, { evt: 'decision', rules, action: state.action });
}

/**
 * The item is given up with a comment of the app on the post: one last try at the removal, so that the comment is true. A post that a mod
 * approved, or that is gone or removed, is left alone. An error only goes to the log: the item is given up anyway.
 */
export async function completeRemoval(run: Pick<Run, 'item' | 'cfg' | 'rec' | 'state' | 'startedAt'>): Promise<void> {
  const { item, cfg, rec, state, startedAt } = run;
  if (state.commentId === undefined || state.removed) return;
  try {
    const post = await getPost(item.postId);
    if (!post || post.approved || !isAlive(post)) return;
    await post.remove(false);
    state.removed = true;
    state.action = 'remove';
    await record(run, { evt: 'decision', rules: state.rules, action: 'remove' });
  } catch (error) {
    logLine(startedAt, { evt: 'error', postId: item.postId, kind: item.kind, mode: effectiveMode(cfg, rec.firstMode), reason: 'the last try at the removal failed', error: reasonOf(error) });
  }
}

// The post URL of images and galleries of Reddit, as src/core/post.ts reads it (the pattern is private there), and the types that the rules do not read.
const IMAGE_POST = /^https?:\/\/(?:(?:i|preview)\.redd\.it|(?:www\.)?reddit\.com\/gallery)\//;
const NOT_PNG_OR_JPG = /\.(?:gif|gifv|webp|mp4)(?:[?#]|$)/i;

/** A skip reason that a mod, the author or the platform gives. Another reason is a setting, and a removal that was begun does not ask the settings again. */
const CLOSED = ['approved', 'removed', 'deleted'];

/** A removal that an earlier attempt began is finished, unless the post is closed since (approved, deleted, or removed by someone else). */
async function finishRemoval(run: Run, post: Post, mode: Mode): Promise<Outcome> {
  const { cfg, appUserId, rec, state } = run;
  const reason = skipReason(cfg, rec.firstMode, skipInput(post), appUserId);
  if (reason && CLOSED.includes(reason) && !state.removed) {
    rec.status = `skipped:${reason}`;
    await record(run, { evt: 'skip', reason });
    return {};
  }
  await decide(run, post, mode, []);
  rec.status = 'done';
  return {};
}

/** The `new:` flow (plan 5.4). */
async function moderateNew(run: Run): Promise<Outcome> {
  const { item, cfg, appUserId, rec, state } = run;
  if (rec.status === 'done' || rec.status === 'error') return {};
  const mode = effectiveMode(cfg, rec.firstMode);

  const post = await getPost(item.postId);
  if (!post) {
    rec.status = 'skipped:deleted';
    await record(run, { evt: 'skip', reason: 'deleted' });
    return {};
  }
  rec.createdAt = post.createdAt.getTime();
  removedBefore(run, post);
  if (state.commentId !== undefined) return finishRemoval(run, post, mode);
  if (mode === 'off') {
    // "Off: the app does nothing" (TERMS): no data about the post or its author, no audit entry, no log line, no wait for its images. The post
    // record keeps the status, so that the sweep does not queue the post again and a later switch to enforce does not check it (D6).
    rec.status = 'skipped:mode-off';
    return {};
  }
  // Legacy counted all the posts of an author, also when the rule was off; the rule can be switched on later. Before the image wait, so that a later post counts this one.
  // The trigger writes it too; this write is for a post that only the sweep finds.
  if (post.authorId) await recordRate(post.authorId, post.id, rec.createdAt, (cfg.rateLimit?.hours ?? NUMBER_SETTINGS.rateLimitHours.def) * HOUR);
  const parent = post.crosspostParentId ? await getPost(post.crosspostParentId) : undefined;
  const images = postImages(post, parent);
  if (hasPendingImages(post, parent, images)) {
    if (state.mediaWaits < MEDIA_WAITS) {
      state.mediaWaits += 1;
      return { retryAt: Date.now() + MINUTE };
    }
    if (!state.mediaExtended) {
      // One more chance for a slow gallery: the post is not checked with partial images before this.
      state.mediaExtended = true;
      await record(run, { evt: 'media-timeout' });
      return { retryAt: Date.now() + MEDIA_EXTRA_MS };
    }
  } else if (images.length === 0) {
    const source = post.crosspostParentId ? parent : post;
    if (source && IMAGE_POST.test(source.url) && !NOT_PNG_OR_JPG.test(source.url)) {
      await alert(
        'no-images',
        `A post looks like an image post of Reddit, but AWB found no usable image in it: ${post.id}. AWB cannot check the images of such a post, so it passes the image rules. ` +
          'Reddit may give the data of the images in a form that AWB does not expect.',
      );
    }
  }

  const reason = skipReason(cfg, rec.firstMode, skipInput(post), appUserId);
  if (reason) {
    rec.status = `skipped:${reason}`;
    await record(run, { evt: 'skip', reason });
    return {};
  }

  const history = cfg.rateLimit && post.authorId ? await rateCandidates(post, cfg.rateLimit.hours) : [];
  const failures = evaluateQuick(cfg, { id: post.id, createdAt: rec.createdAt, title: post.title, flair: post.flair?.text, images }, history);
  // A post that passed waits for the source check at its deadline (a deadline in the past is due at once).
  if (failures.length === 0 && cfg.sourceComment) await enqueue({ kind: 'src', postId: post.id }, rec.createdAt + cfg.sourceComment.hours * HOUR);
  await decide(run, post, mode, failures);
  rec.status = 'done';
  return {};
}

/** The `src:` flow at the deadline of the source rule (plan 5.4). It decides once. */
async function moderateSrc(run: Run): Promise<Outcome> {
  const { item, cfg, rec, state } = run;
  if (state.action !== undefined) return {}; // a second run (the release of the first failed) adds no second decision
  const mode = effectiveMode(cfg, rec.firstMode);
  const post = await getPost(item.postId);
  if (post) removedBefore(run, post);
  const began = state.commentId !== undefined; // a removal that an earlier attempt began is finished, whatever the mode and the settings are now
  const stop = !post ? 'deleted'
    : post.approved ? 'approved'
    : skipsAsRemoved(post, mode) && !state.removed ? 'removed'
    : isDeleted(post) ? 'deleted'
    : began ? undefined
    : mode === 'off' ? 'mode-off'
    : !cfg.sourceComment ? 'rule-off'
    : undefined;
  if (stop || !post) {
    await record(run, { evt: 'skip', reason: stop });
    return {};
  }
  let failures: Failure[] = [];
  if (!began) {
    const comments = await reddit.getComments({ postId: post.id, depth: 1, limit: 1000 }).all();
    const failure = checkSource(cfg.sourceComment!.hours, post.authorName, comments.map((c) => c.authorName));
    failures = failure ? [failure] : [];
  }
  await decide(run, post, mode, failures);
  return {};
}

export const moderate = (run: Run): Promise<Outcome> => (run.item.kind === 'new' ? moderateNew(run) : moderateSrc(run));
