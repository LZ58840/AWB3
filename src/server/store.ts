// Redis keys and what they hold (plan 5.5). Only this file names a key.
import { redis } from '@devvit/web/server';
import type { Mode } from '../core/types';

const DAY = 86_400_000;

export type Kind = 'new' | 'src';
export interface Item {
  kind: Kind;
  postId: string;
}

// ---- The queue: a sorted set of `kind:postId` members, scored by the time at which they are due (ms).
const DUE = 'due';
const LEASE_MS = 2 * 60_000;
const memberOf = ({ kind, postId }: Item): string => `${kind}:${postId}`;
const itemOf = (member: string): Item => ({
  kind: member.slice(0, member.indexOf(':')) as Kind,
  postId: member.slice(member.indexOf(':') + 1),
});

export const enqueue = (item: Item, score: number): Promise<number> => redis.zAdd(DUE, { member: memberOf(item), score });

/** The item that is due first, if one is due at `now`. */
export async function nextDue(now: number): Promise<Item | undefined> {
  const [first] = await redis.zRange(DUE, 0, now, { by: 'score', limit: { offset: 0, count: 1 } });
  return first && itemOf(first.member);
}

/** The sweep: adds `new:` for each post that has no record and does not wait in the queue yet. */
export async function enqueueUnknown(posts: { id: string; createdAt: number }[]): Promise<number> {
  const [records, waiting] = await Promise.all([redis.mGet(posts.map(({ id }) => `post:${id}`)), redis.zRange(DUE, 0, -1, { by: 'rank' })]);
  const queued = new Set(waiting.map(({ member }) => member));
  const members = posts
    .filter(({ id }, i) => records[i] === null && !queued.has(`new:${id}`))
    .map(({ id, createdAt }) => ({ member: `new:${id}`, score: createdAt }));
  if (members.length > 0) await redis.zAdd(DUE, ...members);
  return members.length;
}

type Tx = Awaited<ReturnType<typeof redis.watch>>;

/**
 * One transaction on `key`: WATCH, then `check`; if it says yes, MULTI, `queue`, EXEC. Gives 'ran' when EXEC committed, 'no' when `check` said no,
 * and 'raced' when another client changed `key` after the WATCH (EXEC then commits nothing). A transaction that does not reach EXEC is
 * discarded, also when `check` throws: Redis has few transactions for an installation, and an open one holds a place.
 * A committed EXEC gives one result for each queued command; an aborted one gives none (Redis answers nil; the tests answer `[]`, because the
 * harness has no WATCH semantics).
 */
async function guarded(key: string, check: () => Promise<boolean>, queue: (tx: Tx) => Promise<unknown>): Promise<'ran' | 'no' | 'raced'> {
  const tx = await redis.watch(key);
  let executed = false;
  try {
    if (!(await check())) return 'no';
    await tx.multi();
    await queue(tx);
    executed = true; // EXEC ends the transaction, also when it aborts
    const results = await tx.exec();
    return Array.isArray(results) && results.length > 0 ? 'ran' : 'raced';
  } finally {
    if (!executed) await tx.discard();
  }
}

/**
 * Takes an item for 2 minutes: until then no tick sees it as due. Gives the lease score, or nothing when the item is not due any more
 * (another tick leased or finished it) or when another client changed the queue at the same time. A compare-and-set on the score: two
 * ticks that read the same item cannot both take it.
 */
export async function lease(item: Item, now: number): Promise<number | undefined> {
  const member = memberOf(item);
  const taken = await guarded(
    DUE,
    async () => {
      const score = await redis.zScore(DUE, member);
      return score !== undefined && score <= now;
    },
    (tx) => tx.zAdd(DUE, { member, score: now + LEASE_MS }),
  );
  return taken === 'ran' ? now + LEASE_MS : undefined;
}

/**
 * Ends a lease: removes the item, or, with `retryAt`, makes it due again then. Only if its score is still the lease score:
 * another score means that a trigger put the item back during the work, and the item stays for another look. A transaction that
 * another client aborts is tried again; after 5 tries the lease ends by itself, and the guards of the flows (`status` done, `action`) see to it that the second run changes nothing.
 */
export async function release(item: Item, leased: number, retryAt?: number): Promise<void> {
  const member = memberOf(item);
  for (let attempt = 0; attempt < 5; attempt++) {
    const done = await guarded(
      DUE,
      async () => (await redis.zScore(DUE, member)) === leased,
      (tx) => (retryAt === undefined ? tx.zRem(DUE, [member]) : tx.zAdd(DUE, { member, score: retryAt })),
    );
    if (done !== 'raced') return;
  }
}

// ---- The tick lock. It ends by itself after 45 s, so a killed tick does not hold up the tick of the next minute.
const LOCK = 'lock:tick';

/** Takes the lock. Gives its value (the time at which it ends and a random part), or nothing when another tick holds it. */
export async function lockTick(): Promise<string | undefined> {
  const value = `${Date.now() + 45_000}:${crypto.randomUUID()}`;
  return (await redis.set(LOCK, value, { nx: true, expiration: new Date(Date.now() + 45_000) })) === 'OK' ? value : undefined;
}

/** Gives the lock back, if it is still the lock of this tick: after 45 s another tick may hold it, and that lock stays. */
export async function unlockTick(value: string): Promise<void> {
  await guarded(LOCK, async () => (await redis.get(LOCK)) === value, (tx) => tx.del(LOCK));
}

/** How many items wait, and the due time of the first one. */
export async function queueStats(): Promise<{ size: number; oldest?: number }> {
  const [size, [first]] = await Promise.all([redis.zCard(DUE), redis.zRange(DUE, 0, 0, { by: 'rank' })]);
  return { size, oldest: first?.score };
}

// ---- Health: facts of the app itself. No TTL.
const HEALTH = 'health';
export const readHealth = (field: string): Promise<string | undefined> => redis.hGet(HEALTH, field);
export const writeHealth = (fields: Record<string, string>): Promise<number> => redis.hSet(HEALTH, fields);
export const countError = (): Promise<number> => redis.hIncrBy(HEALTH, 'errorStreak', 1);

// ---- The rate history of an author: a sorted set of post ids by creation time. It lives as long as the rate window.
export async function recordRate(authorId: string, postId: string, createdAt: number, windowMs: number): Promise<void> {
  const key = `rl:${authorId}`;
  await redis.zAdd(key, { member: postId, score: createdAt });
  await redis.zRemRangeByScore(key, 0, createdAt - windowMs);
  await redis.expire(key, Math.ceil(windowMs / 1000));
}

/** The posts of the author in the window around `createdAt`; the rule decides the edges. */
export const rateHistory = (authorId: string, createdAt: number, windowMs: number) =>
  redis.zRange(`rl:${authorId}`, createdAt - windowMs, createdAt, { by: 'score' });

// ---- The post record: what the app decided about a post and where it stands. No title, body or URL (plan 5.5).
/** The state of one item of a post. `open`: an attempt runs, or was killed. The rest are the step markers of an action. */
export interface ItemState {
  open: boolean;
  leases: number;
  kills: number;
  errors: number;
  mediaWaits: number;
  error?: string;
  /** The decision of the item: the rules that failed, and what the app did or would do. */
  rules?: string[];
  action?: 'none' | 'remove' | 'would-remove';
  replyingAt?: number;
  commentId?: string;
  distinguished?: boolean;
  locked?: boolean;
  /** Written before `post.remove()`: a kill after the call leaves a removal that the app did not write down. */
  removing?: boolean;
  removed?: boolean;
  /** The one extra wait after `media-timeout` (10 minutes) has been given. */
  mediaExtended?: boolean;
}
export const newItemState = (): ItemState => ({ open: false, leases: 0, kills: 0, errors: 0, mediaWaits: 0 });

export interface PostRecord {
  /** The mode at the first look at the post (plan 5.2 "effective mode"). */
  firstMode: Mode;
  status: 'pending' | 'done' | 'error' | `skipped:${string}`;
  createdAt?: number;
  items: Partial<Record<Kind, ItemState>>;
}

export async function loadPost(postId: string): Promise<PostRecord | undefined> {
  const text = await redis.get(`post:${postId}`);
  return text === undefined ? undefined : (JSON.parse(text) as PostRecord);
}

/** The records of many posts, in the order of `postIds`; undefined for a post with no record. */
export async function loadPosts(postIds: string[]): Promise<(PostRecord | undefined)[]> {
  if (postIds.length === 0) return [];
  return (await redis.mGet(postIds.map((id) => `post:${id}`))).map((text) => (text ? (JSON.parse(text) as PostRecord) : undefined));
}

export const savePost = (postId: string, record: PostRecord): Promise<string> =>
  redis.set(`post:${postId}`, JSON.stringify(record), { expiration: new Date(Date.now() + 30 * DAY) });

// ---- The audit: one entry for each decision and each error, in the sorted set of its day.
export interface AuditEntry {
  at: number;
  postId: string;
  kind: Kind;
  evt: 'decision' | 'skip' | 'media-timeout' | 'error';
  mode: Mode;
  rules?: string[];
  action?: 'none' | 'remove' | 'would-remove';
  reason?: string;
}

/** The numbers of the shadow report, written once a day (plan 5.4): counts and times, no post and no title. */
export interface ShadowEntry {
  at: number;
  evt: 'shadow';
  days: number;
  included: number;
  tagged: number;
  compared: number;
  agree: number;
  awbOnly: number;
  legacyOnly: number;
  p95Ms?: number;
}

type AuditRecord = AuditEntry | ShadowEntry;
export const isShadow = (entry: AuditRecord): entry is ShadowEntry => entry.evt === 'shadow';

export async function audit(entry: AuditRecord): Promise<void> {
  const key = `audit:${new Date(entry.at).toISOString().slice(0, 10)}`;
  await redis.zAdd(key, { member: JSON.stringify(entry), score: entry.at });
  await redis.expire(key, 30 * (DAY / 1000));
}

/** The audit entries of the UTC day of `now` and of the days before it, `days` days in all, oldest first. */
export async function recentAudit(now: number, days: number): Promise<AuditRecord[]> {
  const keys = Array.from({ length: days }, (_, i) => `audit:${new Date(now - (days - 1 - i) * DAY).toISOString().slice(0, 10)}`);
  const lists = await Promise.all(keys.map((key) => redis.zRange(key, 0, -1, { by: 'rank' })));
  return lists.flat().map(({ member }) => JSON.parse(member) as AuditRecord);
}
