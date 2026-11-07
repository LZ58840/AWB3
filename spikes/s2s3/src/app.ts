// Spikes S2 and S3 of the AWB3 plan (section 2), S5 and the local part of S6. This app only writes JSON lines to its log (read them
// with `devvit logs`, see ../README.md). Each line has the key s2, s3 or s6. The script extract.mjs reads the lines.
// Only the menu item "S3: app comments and removes this post" changes the subreddit.
import { context, reddit, redis, settings, type Post } from '@devvit/web/server';
import type { MenuItemRequest, T3, UiResponse } from '@devvit/web/shared';
import { Hono, type Context } from 'hono';

export const app = new Hono();

// An undefined value must not vanish from the line: for the S2 question, undefined differs from an empty string.
const log = (record: object) => console.log(JSON.stringify(record, (_key, value) => (value === undefined ? '[undefined]' : value)));
const attempt = async <T>(fn: () => Promise<T> | T): Promise<{ ok: T } | { error: string }> => {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: String(error) };
  }
};
// An allow-list: a header that is not named here is not logged. The names come from the Header enum of @devvit/shared-types, without
// devvit-context (a signed JWT), devvit-post-data (developer data of a custom post), traceparent and tracestate.
const LOGGED_HEADERS = new Set([
  'devvit-accept-language', 'devvit-accept-timezone', 'devvit-actor', 'devvit-app', 'devvit-app-user', 'devvit-canary', 'devvit-comment', 'devvit-debug',
  'devvit-featured-games', 'devvit-gql-host', 'devvit-installation', 'devvit-mod-permissions', 'devvit-post', 'devvit-post-author', 'devvit-remote-hostname',
  'devvit-stream-id', 'devvit-subreddit', 'devvit-subreddit-name', 'devvit-user', 'devvit-user-agent', 'devvit-user-name', 'devvit-user-snoovatar-url', 'devvit-version',
]);
const headersOf = (c: Context) => Object.fromEntries(Object.entries(c.req.header()).filter(([name]) => LOGGED_HEADERS.has(name)));
// The shape of a setting value, never the value: a setting can be a secret. A select setting shows as an array, as in array[1] of string.
const kind = (value: unknown): string =>
  Array.isArray(value) ? `array[${value.length}]${value.length ? ` of ${[...new Set(value.map(kind))].join('|')}` : ''}` : value === null ? 'null' : typeof value;
const typed = (value: unknown) => (value instanceof Date ? { type: 'Date', value: value.toISOString(), ms: value.getTime() } : { type: typeof value, value });

// The URL rule of plan 5.2 (IMAGE_URL in src/core/post.ts): png, jpg and jpeg on the two Reddit image hosts, without the query.
// shortcut: a copy, so that this spike builds without the main app; copy the rule again if src/core/post.ts changes it.
const normalize = (url: string) => {
  const file = /^https?:\/\/(?:i|preview)\.redd\.it\/(\w+\.(?:png|jpg|jpeg))(?:\?.*)?$/.exec(url)?.[1];
  return file ? `https://i.redd.it/${file}` : null;
};
const FETCH_HOST = /^https:\/\/(?:i|preview)\.redd\.it\//;
const MAX_BODY = 20 * 1024 * 1024; // the probe reads at most 20 MiB of a body

const describe = (p: Post) => ({
  id: p.id, title: p.title, url: p.url, permalink: p.permalink, createdAt: typed(p.createdAt), removed: p.removed, spam: p.spam, approved: p.approved,
  removedBy: p.removedBy, removedByCategory: p.removedByCategory, crosspostParentId: p.crosspostParentId,
  gallery: p.gallery.map((entry) => ({ ...entry, normalized: normalize(entry.url) })), thumbnail: p.thumbnail, flair: p.flair, authorName: p.authorName, authorId: p.authorId,
});

/** S6: one fetch of the smallest image URL on a host of the domain request. */
async function probeFetch(id: string, urls: { from: string; url: string; width: number; height: number }[]) {
  const smallest = urls.filter(({ url }) => FETCH_HOST.test(url)).sort((a, b) => a.width * a.height - b.width * b.height)[0];
  if (!smallest) return log({ s6: 'fetch', at: Date.now(), id, skipped: 'no i.redd.it or preview.redd.it URL' });
  const result = await attempt(async () => {
    const res = await fetch(smallest.url, { headers: { Accept: 'image/jpeg' }, redirect: 'error' });
    const answer = { status: res.status, contentType: res.headers.get('content-type'), contentLength: res.headers.get('content-length') };
    if (Number(answer.contentLength) > MAX_BODY) {
      await res.body?.cancel();
      return { ...answer, skipped: 'content-length is over 20 MiB' };
    }
    let bytes = 0;
    let head = Buffer.alloc(0);
    let truncated = false;
    for await (const chunk of res.body ?? []) { // the body is a stream: stop at the cap, and the loop cancels the rest
      head = Buffer.concat([head, chunk.subarray(0, 16)]).subarray(0, 16);
      bytes += chunk.byteLength;
      if (bytes > MAX_BODY) {
        truncated = true;
        break;
      }
    }
    return { ...answer, bytes, ...(truncated ? { truncated } : {}), first16: head.toString('hex') };
  });
  log({ s6: 'fetch', at: Date.now(), id, ...smallest, ...result });
}

/** S2: the post as the API shows it now, with the parent of a crosspost, the enriched thumbnail, and (S6) the fetch of the smallest image. */
async function dumpPost(id: T3, via: string) {
  const at = Date.now();
  try {
    const post = await reddit.getPostById(id);
    const enriched = await attempt(() => post.getEnrichedThumbnail());
    const parentId = post.crosspostParentId;
    const parent = parentId ? await attempt(async () => describe(await reddit.getPostById(parentId))) : undefined;
    log({ s2: 'post', via, at, ...describe(post), enriched, parent });
    if (await settings.get('fetchProbe')) {
      await probeFetch(id, [
        ...post.gallery.map(({ url, width, height }) => ({ from: 'gallery', url, width, height })),
        ...(post.thumbnail ? [{ from: 'thumbnail', ...post.thumbnail }] : []),
        ...('ok' in enriched && enriched.ok ? [{ from: 'enriched', ...enriched.ok.image }] : []),
      ]);
    }
  } catch (error) {
    log({ s2: 'post', via, at, id, error: String(error) });
  }
}

// S3: every trigger writes the whole request. The name of the trigger is the last part of the path (devvit.json).
app.post('/internal/triggers/:name', async (c) => {
  const name = c.req.param('name');
  const body = await c.req.json().catch(() => null);
  log({ s3: name, at: Date.now(), headers: headersOf(c), body });
  // The comment trigger has a post too, but the lookup is for the post triggers only. getPostById also takes an id without the t3_ prefix.
  const id = name === 'onCommentCreate' ? undefined : (body?.post?.id ?? body?.postId ?? body?.targetPost?.id);
  if (id) await dumpPost(id, body.action ? `${name}:${body.action}` : name);
  return c.json({});
});

const menu = (path: string, handler: (request: MenuItemRequest, c: Context) => Promise<string>) =>
  app.post(path, async (c) => c.json<UiResponse>({ showToast: await handler(await c.req.json<MenuItemRequest>(), c) }));

menu('/internal/menu/dump-post', async ({ targetId }) => {
  await dumpPost(targetId as T3, 'menu');
  return `S2: logged ${targetId}`;
});

// S2 (h): does the app see filtered and removed posts in /new and in the mod queue?
menu('/internal/menu/dump-listings', async () => {
  const subreddit = context.subredditName;
  const row = (p: Post) => ({ id: p.id, removed: p.removed, spam: p.spam, removedByCategory: p.removedByCategory });
  log({
    s2: 'listings', at: Date.now(), subreddit,
    new: await attempt(async () => (await reddit.getNewPosts({ subredditName: subreddit, limit: 25 }).all()).map(row)),
    modQueue: await attempt(async () => (await reddit.getModQueue({ subreddit, type: 'post', limit: 25 }).all()).map(row)),
  });
  return 'S2: logged the listings';
});

// S3: the guesses of the plan that no trigger shows. Redis key: a new one for each click, so that the first set is not held by the last click.
menu('/internal/menu/probe-platform', async (request, c) => {
  const key = `spike:nx:${Date.now()}`;
  const expiration = new Date(Date.now() + 60_000);
  log({
    s3: 'probe', at: Date.now(), headers: headersOf(c), body: request,
    context: {
      appSlug: context.appSlug, appVersion: context.appVersion, subredditId: context.subredditId, subredditName: context.subredditName, userId: context.userId, username: context.username,
    },
    redisNx: [await attempt(() => redis.set(key, '1', { nx: true, expiration })), await attempt(() => redis.set(key, '2', { nx: true, expiration }))],
    settings: await attempt(async () => Object.fromEntries(Object.entries(await settings.getAll()).map(([key, value]) => [key, kind(value)]))),
    appUser: await attempt(async () => {
      const user = await reddit.getAppUser();
      return { id: user?.id, username: user?.username };
    }),
  });
  return 'S3: logged the probe';
});

// S3: the app account writes a comment (its own onCommentCreate) and removes the post (onPostDelete and onModAction of the app).
menu('/internal/menu/app-acts', async ({ targetId }) => {
  const id = targetId as T3;
  const comment = await reddit.submitComment({ id, text: 'S3 probe: the app account wrote this comment.' });
  await reddit.remove(id, false);
  log({ s3: 'app-acts', at: Date.now(), postId: id, commentId: comment.id });
  await dumpPost(id, 'menu:app-acts');
  return 'S3: the app commented and removed this post';
});

app.onError((error, c) => {
  console.error(`route error; ${error.stack}`);
  return c.json({ error: error.message }, 500);
});
