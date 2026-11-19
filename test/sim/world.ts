// In-memory Reddit. The world is a set of fake Reddit API services behind vi.spyOn(config, 'use'), so the real @devvit/reddit
// client and its models run unchanged: a client method and a model method (post.lock()) reach the same service (S1.11).
// A call that the world does not implement throws "not simulated", so a new API call cannot pass by accident (plan 7.2).
// S2 confirmed (2026-11-15): a mod or app removal gives `removed`, removedBy (the mod) and removedByCategory 'moderator'; a removal as
// spam gives `spam` (not `removed`) with the same two fields; an author delete gives author '[deleted]', no author id, url '' and
// an empty gallery, with no removal field set; /new hides removed and deleted posts; the mod queue does not hold removed posts.
// Still guesses: a filtered post is `removed` with removedBy 'AutoModerator' and removedByCategory 'automod_filtered', /new hides
// it and the mod queue holds it; absent removal fields are undefined (the harness addPost writes '' instead); which mod log
// entries exist (distinguish and sticky separately); a missing wiki page is a 404 error.
import type { DevvitFixtures } from '@devvit/test/server/vitest';
import type { T1, T2, T3, T5 } from '@devvit/web/shared';
import { FlairDefinition } from '@devvit/protos/types/devvit/plugin/redditapi/flair/flair_svc.js';
import { GraphQLDefinition } from '@devvit/protos/types/devvit/plugin/redditapi/graphql/graphql_svc.js';
import { LinksAndCommentsDefinition } from '@devvit/protos/types/devvit/plugin/redditapi/linksandcomments/linksandcomments_svc.js';
import { ListingsDefinition } from '@devvit/protos/types/devvit/plugin/redditapi/listings/listings_svc.js';
import { ModerationDefinition } from '@devvit/protos/types/devvit/plugin/redditapi/moderation/moderation_svc.js';
import { ModNoteDefinition } from '@devvit/protos/types/devvit/plugin/redditapi/modnote/modnote_svc.js';
import { NewModmailDefinition } from '@devvit/protos/types/devvit/plugin/redditapi/newmodmail/newmodmail_svc.js';
import { PrivateMessagesDefinition } from '@devvit/protos/types/devvit/plugin/redditapi/privatemessages/privatemessages_svc.js';
import { SubredditsDefinition } from '@devvit/protos/types/devvit/plugin/redditapi/subreddits/subreddits_svc.js';
import { UsersDefinition } from '@devvit/protos/types/devvit/plugin/redditapi/users/users_svc.js';
import { WidgetsDefinition } from '@devvit/protos/types/devvit/plugin/redditapi/widgets/widgets_svc.js';
import { WikiDefinition } from '@devvit/protos/types/devvit/plugin/redditapi/wiki/wiki_svc.js';
import { vi } from 'vitest';
import { commentCreate, commentPermalink, permalinkOf, postDelete, postFlairUpdate, postSubmit, TRIGGER, type TriggerBody } from './events';

export interface User {
  id: T2;
  name: string;
  /** The app account. */
  app?: true;
}

export interface Sub {
  id: T5;
  name: string;
  mods: string[];
}

export interface Image {
  url: string;
  width: number;
  height: number;
  /** GalleryMediaStatus: 0 unknown, 1 valid, 2 failed. */
  status: number;
}

export type PostKind = 'image' | 'gallery' | 'link' | 'video' | 'text' | 'crosspost';

export interface Post {
  id: T3;
  sub: string;
  author: string;
  authorId: T2;
  title: string;
  createdAt: number;
  kind: PostKind;
  url: string;
  flair?: string;
  gallery: Image[];
  crosspostParent?: T3;
  approved: boolean;
  removed: boolean;
  spam: boolean;
  removedBy?: string;
  removedByCategory?: string;
  deleted?: true; // the author deleted it; the API then shows the post as in postObject
  locked: boolean;
  reports: { reason: string; by: string }[];
}

export interface Comment {
  id: T1;
  postId: T3;
  sub: string;
  author: string;
  /** Empty for a deleted account. */
  authorId: T2 | '';
  body: string;
  createdAt: number;
  distinguished: boolean;
  stickied: boolean;
  removed: boolean;
  spam: boolean;
  approved: boolean;
}

export interface ModLogEntry {
  id: string;
  type: string;
  mod: string;
  sub: string;
  createdAt: number;
  target: { id: T1 | T3; author: string; title?: string; body?: string; permalink: string };
}

/** A call of the app that changed Reddit, in order. */
export type Action = { postId: string } & (
  | { type: 'comment'; commentId: string; text: string }
  | { type: 'distinguish'; commentId: string; sticky: boolean }
  | { type: 'lock' | 'unlock' | 'approve' }
  | { type: 'remove'; spam: boolean }
  | { type: 'removeComment'; commentId: string; spam: boolean }
  | { type: 'report'; reason: string }
);

/** A trigger that Reddit would send; `sub` is the installation that receives it. */
export interface WorldEvent {
  trigger: (typeof TRIGGER)[keyof typeof TRIGGER];
  sub: string;
  body: TriggerBody;
}

export interface NewPost {
  sub: string;
  author: string;
  title: string;
  flair?: string;
  images?: { width: number; height: number; url?: string; ext?: 'jpg' | 'png'; status?: number }[];
  /** One image is an image post, more is a gallery, none is a text post. */
  kind?: 'link' | 'video' | 'text';
  /** For a link post. */
  url?: string;
  /** The post is a crosspost of this post. */
  crosspostOf?: T3;
}

export const LEGACY_BOT = 'AnimewallpaperBot';

const notSimulated = (what: string) => new Error(`${what} not simulated`);

/** An RPC that the world does not implement throws; so do the RPCs of the services that it does not fake at all. */
const strict = (service: string, implemented: object): object =>
  new Proxy(implemented, {
    get: (target, rpc) =>
      rpc in target ? Reflect.get(target, rpc) : typeof rpc === 'symbol' || rpc === 'then' ? undefined : () => { throw notSimulated(`${service}.${rpc}`); },
  });

const listing = (children: { kind: string; data: object }[], after?: string) => ({ kind: 'Listing', data: { children, ...(after ? { after } : {}) } });

/** One page of a newest-first list: `after` is the id of the last item of the previous page. */
function page<T extends { id: string }>(items: T[], { after, limit }: { after?: string; limit?: number }) {
  const start = after ? items.findIndex((item) => item.id === after) + 1 : 0;
  const end = start + (limit ?? 25);
  return { items: items.slice(start, end), after: end < items.length ? items[end - 1]!.id : undefined };
}

export function createWorld({ appName }: { appName: string }) {
  const users = new Map<string, User>();
  const subs = new Map<string, Sub>();
  const posts = new Map<string, Post>();
  const comments = new Map<string, Comment>();
  const modLog: ModLogEntry[] = [];
  const modmail: { id: string; subredditId: string; subject: string; bodyMarkdown: string }[] = [];
  const wiki = new Map<string, string>();
  const actions: Action[] = [];
  let outbox: WorldEvent[] = [];
  const count = { p: 0, c: 0, m: 0, n: 0 };
  let seed: Pick<DevvitFixtures, 'mocks'> | undefined;

  const need = <T>(map: Map<string, T>, id: string): T => {
    const found = map.get(id);
    if (!found) throw new Error(`THING_NOT_FOUND ${id}`);
    return found;
  };
  const subOf = (name: string) => need(subs, name);
  const emit = (trigger: WorldEvent['trigger'], sub: string, body: TriggerBody) => void outbox.push({ trigger, sub, body });

  function addUser(name: string, app?: true): User {
    let user = users.get(name);
    if (!user) {
      user = { id: `t2_${name}`, name, ...(app ? { app } : {}) };
      users.set(name, user);
      seed?.mocks.reddit.users.addUser({ id: user.id, name });
    }
    return user;
  }

  function addSub(name: string, mods = ['mod1']): Sub {
    const sub: Sub = { id: `t5_${name}`, name, mods };
    subs.set(name, sub);
    seed?.mocks.reddit.subreddits.addSubreddit({ id: sub.id, displayName: name, title: name });
    for (const mod of mods) addUser(mod);
    return sub;
  }

  const app = addUser(appName, true);
  const legacy = addUser(LEGACY_BOT);

  function addPost(o: NewPost): Post {
    const author = addUser(o.author);
    const sub = subOf(o.sub);
    const id: T3 = `t3_p${++count.p}`;
    const short = id.slice(3);
    const images = (o.images ?? []).map((image, i) => ({
      url: image.url ?? `https://i.redd.it/${short}n${i + 1}.${image.ext ?? 'jpg'}`, width: image.width, height: image.height, status: image.status ?? 1,
    }));
    const kind: PostKind = o.crosspostOf ? 'crosspost' : (o.kind ?? (images.length > 1 ? 'gallery' : images.length === 1 ? 'image' : 'text'));
    // A link or video post has one preview image (the Post docs: "from the first preview image").
    const preview = [{ url: `https://preview.redd.it/${short}.jpg`, width: images[0]?.width ?? 640, height: images[0]?.height ?? 360, status: 1 }];
    const url = {
      image: () => images[0]!.url, gallery: () => `https://www.reddit.com/gallery/${short}`, link: () => o.url ?? `https://example.com/${short}.jpg`,
      video: () => `https://v.redd.it/${short}`, text: () => `https://www.reddit.com${permalinkOf({ id, sub: sub.name })}`, crosspost: () => `https://www.reddit.com${permalinkOf({ id, sub: sub.name })}`,
    }[kind]();
    const post: Post = {
      id, sub: sub.name, author: author.name, authorId: author.id, title: o.title, createdAt: Date.now(), kind, url,
      gallery: kind === 'image' || kind === 'gallery' ? images : kind === 'link' || kind === 'video' ? preview : [],
      ...(o.flair ? { flair: o.flair } : {}), ...(o.crosspostOf ? { crosspostParent: o.crosspostOf } : {}),
      approved: false, removed: false, spam: false, locked: false, reports: [],
    };
    posts.set(id, post);
    emit('onPostSubmit', sub.name, postSubmit(post, author, sub));
    return post;
  }

  function addComment({ postId, author, body }: { postId: T3; author: string; body: string }): Comment {
    const post = need(posts, postId);
    const user = author === '[deleted]' ? { id: '' as const, name: author } : addUser(author);
    const comment: Comment = {
      id: `t1_c${++count.c}`, postId, sub: post.sub, author, authorId: user.id, body, createdAt: Date.now(),
      distinguished: false, stickied: false, removed: false, spam: false, approved: false,
    };
    comments.set(comment.id, comment);
    emit('onCommentCreate', post.sub, commentCreate(comment, user, post, subOf(post.sub)));
    return comment;
  }

  const postTarget = (p: Post) => ({ id: p.id, author: p.author, title: p.title, permalink: permalinkOf(p) });
  const commentTarget = (c: Comment) => ({ id: c.id, author: c.author, body: c.body, permalink: commentPermalink(c) });
  function log(type: string, mod: string, sub: string, target: ModLogEntry['target']) {
    addUser(mod);
    modLog.push({ id: `ModAction_${++count.m}`, type, mod, sub, createdAt: Date.now(), target });
  }

  const isTop = (id: string): id is T3 => id.startsWith('t3_');

  function modRemove(id: string, by: string, { spam = false } = {}) {
    const post = need(posts, id);
    Object.assign(post, { removed: !spam, spam, approved: false, removedBy: by, removedByCategory: 'moderator' });
    log(spam ? 'spamlink' : 'removelink', by, post.sub, postTarget(post));
    emit('onPostDelete', post.sub, postDelete(post, addUser(post.author), subOf(post.sub), 'MODERATOR', Date.now()));
  }

  function removeComment(id: string, by: string, spam: boolean) {
    const comment = need(comments, id);
    Object.assign(comment, { removed: true, spam });
    log(spam ? 'spamcomment' : 'removecomment', by, comment.sub, commentTarget(comment));
  }

  function approve(id: string, by: string) {
    if (isTop(id)) {
      const post = need(posts, id);
      Object.assign(post, { approved: true, removed: false, spam: false, removedBy: undefined, removedByCategory: undefined });
      log('approvelink', by, post.sub, postTarget(post));
    } else {
      const comment = need(comments, id);
      Object.assign(comment, { approved: true, removed: false, spam: false });
      log('approvecomment', by, comment.sub, commentTarget(comment));
    }
  }

  function setLocked(id: string, by: string, locked: boolean) {
    const post = need(posts, id);
    post.locked = locked;
    log(locked ? 'lock' : 'unlock', by, post.sub, postTarget(post));
  }

  function distinguish(id: string, by: string, sticky: boolean) {
    const comment = need(comments, id);
    Object.assign(comment, { distinguished: true, stickied: sticky });
    log('distinguish', by, comment.sub, commentTarget(comment));
    if (sticky) log('sticky', by, comment.sub, commentTarget(comment));
  }

  function report(id: string, reason: string, by: string) {
    need(posts, id).reports.push({ reason, by });
  }

  function setFlair(id: string, flair: string | undefined, by: string) {
    const post = need(posts, id);
    post.flair = flair;
    emit('onPostFlairUpdate', post.sub, postFlairUpdate(post, addUser(by), subOf(post.sub)));
  }

  function userDelete(id: string) {
    const post = need(posts, id);
    post.deleted = true;
    emit('onPostDelete', post.sub, postDelete(post, addUser(post.author), subOf(post.sub), 'USER', Date.now()));
  }

  /** AutoModerator holds the post for review. It sends PostDelete only when `sendDelete` is set (S2 (g) tells if Reddit does). */
  function automodFilter(id: string, { sendDelete = false } = {}) {
    const post = need(posts, id);
    Object.assign(post, { removed: true, removedBy: 'AutoModerator', removedByCategory: 'automod_filtered' });
    if (sendDelete) emit('onPostDelete', post.sub, postDelete(post, addUser(post.author), subOf(post.sub), 'MODERATOR', Date.now()));
  }

  const visible = (p: Post) => !p.removed && !p.spam && p.removedByCategory === undefined && !p.deleted;
  const inQueue = (p: Post) => !p.approved && (p.removedByCategory === 'automod_filtered' || (p.reports.length > 0 && p.removedByCategory === undefined && !p.deleted));

  const postObject = (p: Post) => ({
    id: p.id.slice(3), name: p.id, title: p.title, createdUtc: p.createdAt / 1000, author: p.deleted ? '[deleted]' : p.author,
    ...(p.authorId && !p.deleted ? { authorFullname: p.authorId } : {}),
    subreddit: p.sub, subredditId: subOf(p.sub).id, url: p.deleted ? '' : p.url, permalink: permalinkOf(p), selftext: '', linkFlairText: p.flair,
    gallery: p.deleted ? [] : p.gallery, crosspostParent: p.crosspostParent, approved: p.approved, removed: p.removed, spam: p.spam, removedBy: p.removedBy,
    removedByCategory: p.removedByCategory, locked: p.locked, modReports: p.reports.map(({ reason, by }) => [reason, by]),
    numComments: [...comments.values()].filter((c) => c.postId === p.id).length,
  });
  const commentObject = (c: Comment) => ({
    id: c.id.slice(3), name: c.id, body: c.body, createdUtc: c.createdAt / 1000, author: c.author, ...(c.authorId ? { authorFullname: c.authorId } : {}),
    parentId: c.postId, linkId: c.postId, permalink: commentPermalink(c), subreddit: c.sub, subredditId: subOf(c.sub).id,
    distinguished: c.distinguished ? 'moderator' : undefined, stickied: c.stickied, removed: c.removed, spam: c.spam, approved: c.approved, depth: 0,
  });

  const newestFirst = <T>(items: Iterable<T>) => [...items].reverse();

  const linksAndComments = {
    async Info({ thingIds }: { thingIds: string[] }) {
      return listing(
        thingIds.flatMap((id): { kind: string; data: object }[] => {
          if (isTop(id)) return posts.has(id) ? [{ kind: 't3', data: postObject(posts.get(id)!) }] : [];
          if (id.startsWith('t1_')) return comments.has(id) ? [{ kind: 't1', data: commentObject(comments.get(id)!) }] : [];
          throw notSimulated(`LinksAndComments.Info of ${id}`);
        }),
      );
    },
    async Comment({ thingId, text }: { thingId: string; text: string }) {
      if (!isTop(thingId)) throw notSimulated('a reply to a comment');
      const comment = addComment({ postId: thingId, author: app.name, body: text });
      actions.push({ postId: thingId, type: 'comment', commentId: comment.id, text });
      return { json: { errors: [], data: { things: [{ kind: 't1', data: commentObject(comment) }] } } };
    },
    async Lock({ id }: { id: string }) {
      setLocked(id, app.name, true);
      actions.push({ postId: id, type: 'lock' });
      return {};
    },
    async Unlock({ id }: { id: string }) {
      setLocked(id, app.name, false);
      actions.push({ postId: id, type: 'unlock' });
      return {};
    },
    async Report({ thingId, reason }: { thingId: string; reason: string }) {
      if (!isTop(thingId)) throw notSimulated('a report on a comment');
      report(thingId, reason, app.name);
      actions.push({ postId: thingId, type: 'report', reason });
      return { json: { errors: [] } };
    },
  };

  const moderation = {
    async Remove({ id, spam }: { id: string; spam: boolean }) {
      if (isTop(id)) {
        modRemove(id, app.name, { spam });
        actions.push({ postId: id, type: 'remove', spam });
      } else {
        removeComment(id, app.name, spam);
        actions.push({ postId: need(comments, id).postId, type: 'removeComment', commentId: id, spam });
      }
      return {};
    },
    async Approve({ id }: { id: string }) {
      approve(id, app.name);
      actions.push({ postId: isTop(id) ? id : need(comments, id).postId, type: 'approve' });
      return {};
    },
    async Distinguish({ id, how, sticky }: { id: string; how: string; sticky: boolean }) {
      if (how !== 'yes' || isTop(id)) throw notSimulated(`distinguish ${how} of ${id}`);
      distinguish(id, app.name, sticky);
      actions.push({ postId: need(comments, id).postId, type: 'distinguish', commentId: id, sticky });
      return { json: { data: { things: [{ data: { distinguished: 'moderator', stickied: sticky } }] } } };
    },
    async AboutLocation({ subreddit, location, only, limit, after }: { subreddit: string; location: string; only?: string; limit?: number; after?: string }) {
      if (location !== 'modqueue') throw notSimulated(`the ${location} listing`);
      const queue = only === 'comments' ? [] : newestFirst([...posts.values()].filter((p) => p.sub === subreddit && inQueue(p)));
      const { items, after: next } = page(queue, { after, limit });
      return listing(items.map((p) => ({ kind: 't3', data: postObject(p) })), next);
    },
    async AboutLog({ subreddit, mod, type, limit, after }: { subreddit: string; mod?: string; type?: string; limit?: number; after?: string }) {
      const mods = mod?.split(',');
      const entries = newestFirst(modLog.filter((e) => e.sub === subreddit && (!mods || mods.includes(e.mod)) && (!type || e.type === type)));
      const { items, after: next } = page(entries, { after, limit });
      return {
        kind: 'Listing',
        data: {
          children: items.map((e) => ({
            kind: 'modaction',
            data: {
              id: e.id, mod: e.mod, modId36: addUser(e.mod).id.slice(3), createdUtc: e.createdAt / 1000, subreddit: e.sub, subredditNamePrefixed: `r/${e.sub}`,
              action: e.type, srId36: subOf(e.sub).id.slice(3), targetFullname: e.target.id, targetAuthor: e.target.author, targetTitle: e.target.title,
              targetBody: e.target.body, targetPermalink: e.target.permalink,
            },
          })),
          ...(next ? { after: next } : {}),
        },
      };
    },
  };

  const listings = {
    async New({ subreddit, limit, after }: { subreddit?: string; limit?: number; after?: string }) {
      const { items, after: next } = page(newestFirst([...posts.values()].filter((p) => p.sub === subreddit && visible(p))), { after, limit });
      return listing(items.map((p) => ({ kind: 't3', data: postObject(p) })), next);
    },
    // The top-level comments, oldest first. The world has no replies and no "more" pages, so `limit` and `depth` do not matter,
    // and the replies of a comment (`comment` is set) are always empty.
    async Comments({ article, comment }: { article: string; comment?: string }) {
      const post = need(posts, `t3_${article}`);
      const top = comment ? [] : [...comments.values()].filter((c) => c.postId === post.id);
      return { listings: [listing([{ kind: 't3', data: postObject(post) }]), listing(top.map((c) => ({ kind: 't1', data: commentObject(c) })))] };
    },
  };

  const services = new Map<string, object>([
    [LinksAndCommentsDefinition.fullName, strict('LinksAndComments', linksAndComments)],
    [ModerationDefinition.fullName, strict('Moderation', moderation)],
    [ListingsDefinition.fullName, strict('Listings', listings)],
    [
      WikiDefinition.fullName,
      strict('Wiki', {
        async GetWikiPage({ subreddit, page: name }: { subreddit: string; page: string }) {
          const content = wiki.get(`${subreddit}/${name}`);
          if (content === undefined) throw new Error('HTTP 404 Not Found');
          return { kind: 'wikipage', data: { contentMd: content, contentHtml: content, revisionId: 'r1', revisionDate: Date.now() / 1000, mayRevise: false } };
        },
      }),
    ],
    [
      NewModmailDefinition.fullName,
      strict('NewModmail', {
        async CreateModmailConversation({ subject, bodyMarkdown, subredditId }: { subject: string; bodyMarkdown: string; subredditId: string }) {
          const id = `mm${++count.n}`;
          modmail.push({ id, subredditId, subject, bodyMarkdown });
          return { conversationId: id };
        },
      }),
    ],
    ...[FlairDefinition, GraphQLDefinition, ModNoteDefinition, PrivateMessagesDefinition, WidgetsDefinition].map(
      (definition) => [definition.fullName, strict(definition.fullName.split('.').pop()!, {})] as [string, object],
    ),
  ]);

  return {
    app,
    legacy,
    subs,
    posts,
    comments,
    modLog,
    modmail,
    wiki,
    actions,
    addUser,
    addSub,
    addPost,
    addComment,
    modRemove,
    removeComment,
    approve,
    lock: (id: string, by: string) => setLocked(id, by, true),
    distinguish,
    report,
    setFlair,
    userDelete,
    automodFilter,
    /** The triggers that Reddit would send since the last call. */
    drain(): WorldEvent[] {
      const events = outbox;
      outbox = [];
      return events;
    },
    /**
     * Puts the world behind the Reddit API services of the test. Users and subreddits also go to the harness mocks, which
     * answer the three RPCs behind getUserByUsername, getUserById and getSubredditByName. `route` may answer other services
     * (Redis, settings); the harness answers the rest.
     */
    install(fixtures: Pick<DevvitFixtures, 'config' | 'mocks'>, route?: (definition: { fullName: string }) => object | undefined) {
      seed = fixtures;
      for (const user of users.values()) fixtures.mocks.reddit.users.addUser({ id: user.id, name: user.name });
      for (const sub of subs.values()) fixtures.mocks.reddit.subreddits.addSubreddit({ id: sub.id, displayName: sub.name, title: sub.name });
      const realUse = fixtures.config.use.bind(fixtures.config);
      type Rpc = (request: unknown, metadata: unknown) => unknown;
      const harness = (definition: typeof UsersDefinition | typeof SubredditsDefinition, rpcs: string[]) =>
        strict(definition.fullName.split('.').pop()!, Object.fromEntries(rpcs.map((rpc) => [rpc, (request: unknown, metadata: unknown) => (realUse(definition as never) as Record<string, Rpc>)[rpc]!(request, metadata)])));
      const delegated = new Map<string, object>([
        [UsersDefinition.fullName, harness(UsersDefinition, ['UserAbout', 'UserDataByAccountIds'])],
        [SubredditsDefinition.fullName, harness(SubredditsDefinition, ['SubredditAbout'])],
      ]);
      vi.spyOn(fixtures.config, 'use').mockImplementation(((definition: { fullName: string }) =>
        services.get(definition.fullName) ?? delegated.get(definition.fullName) ?? route?.(definition) ?? realUse(definition as never)) as never);
    },
  };
}

export type World = ReturnType<typeof createWorld>;
