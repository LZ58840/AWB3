// The world drives the real @devvit/reddit client: these tests call reddit.* and the model methods, as the app does.
import { createDevvitTest, type DevvitFixtures } from '@devvit/test/server/vitest';
import { reddit } from '@devvit/web/server';
import { expect } from 'vitest';
import { isAlive, isCounted, isDeleted, isRemoved, postImages, skipsAsRemoved } from '../../src/core/post';
import { createClock, T0 } from './clock';
import { createWorld, LEGACY_BOT, type Post } from './world';

const test = createDevvitTest(); // the harness app is named test-app
const APP = 'test-app';

/** A world with one subreddit, installed in the test, at a fake time. */
const setup = ({ config, mocks }: Pick<DevvitFixtures, 'config' | 'mocks'>) => {
  createClock({ tasks: [], run: async () => undefined });
  const world = createWorld({ appName: APP });
  world.install({ config, mocks });
  world.addSub('wallpapers');
  const image = (width: number, height: number) => ({ width, height });
  const post = (over: Partial<Parameters<typeof world.addPost>[0]> = {}) =>
    world.addPost({ sub: 'wallpapers', author: 'alice', title: 'Sunset', flair: 'Desktop', images: [image(1920, 1080)], ...over });
  return { world, post, image };
};

test('getPostById gives a real Post with the world values; absent removal fields stay undefined', async ({ config, mocks }) => {
  const { world, post, image } = setup({ config, mocks });
  const single = post();
  const gallery = post({ title: 'Many', images: [image(900, 1600), image(1000, 1000)] });
  const p = await reddit.getPostById(single.id);
  expect(p).toMatchObject({
    id: single.id, title: 'Sunset', authorName: 'alice', authorId: 't2_alice', subredditName: 'wallpapers', subredditId: 't5_wallpapers',
    flair: { text: 'Desktop' }, url: single.gallery[0]!.url, removed: false, spam: false, approved: false, locked: false,
    removedBy: undefined, removedByCategory: undefined, crosspostParentId: undefined,
  });
  expect(p.createdAt).toEqual(new Date(T0));
  expect(p.gallery).toEqual([{ url: single.gallery[0]!.url, width: 1920, height: 1080, status: 1 }]);
  expect((await reddit.getPostById(gallery.id)).gallery.map(({ width, height }) => [width, height])).toEqual([[900, 1600], [1000, 1000]]);
  expect((await reddit.getPostById(gallery.id)).url).toMatch(/^https:\/\/www\.reddit\.com\/gallery\//);
  expect(world.posts.size).toBe(2);
  await expect(reddit.getPostById('t3_nope')).rejects.toThrow('no post t3_nope');
});

test('post kinds: crosspost has no images and a parent; link and video have only a preview; no flair gives none', async ({ config, mocks }) => {
  const { post } = setup({ config, mocks });
  const parent = post();
  const cross = await reddit.getPostById(post({ images: [], crosspostOf: parent.id, flair: undefined }).id);
  expect([cross.crosspostParentId, cross.gallery, cross.flair]).toEqual([parent.id, [], undefined]);
  const link = await reddit.getPostById(post({ kind: 'link', url: 'https://imgur.com/a.jpg' }).id);
  expect([link.url, link.gallery.map((g) => new URL(g.url).host)]).toEqual(['https://imgur.com/a.jpg', ['preview.redd.it']]);
  const video = await reddit.getPostById(post({ kind: 'video' }).id);
  expect(video.url).toMatch(/^https:\/\/v\.redd\.it\//);
});

test('lock, comment and distinguish change the world; actions keep the order of the calls', async ({ config, mocks }) => {
  const { world, post } = setup({ config, mocks });
  const { id } = post();
  const p = await reddit.getPostById(id);
  const comment = await reddit.submitComment({ id, text: 'Removed.' });
  await comment.distinguish(true);
  await p.lock();
  const again = await reddit.getPostById(id);
  const stored = await reddit.getCommentById(comment.id);
  expect([again.locked, stored.authorName, stored.body, stored.distinguishedBy, stored.stickied, stored.postId, stored.parentId]).toEqual([true, APP, 'Removed.', 'moderator', true, id, id]);
  expect(world.actions).toEqual([
    { postId: id, type: 'comment', commentId: comment.id, text: 'Removed.' },
    { postId: id, type: 'distinguish', commentId: comment.id, sticky: true },
    { postId: id, type: 'lock' },
  ]);
  expect(world.modLog.map(({ type, mod }) => [type, mod])).toEqual([['distinguish', APP], ['sticky', APP], ['lock', APP]]);
});

test('remove by the post, by the client and as spam; removing a comment; each logs and sends PostDelete', async ({ config, mocks }) => {
  const { world, post } = setup({ config, mocks });
  const [a, b, c] = [post(), post(), post()];
  await (await reddit.getPostById(a.id)).remove();
  await reddit.remove(b.id, false);
  await reddit.remove(c.id, true);
  expect(await reddit.getPostById(a.id)).toMatchObject({ removed: true, spam: false, removedBy: APP, removedByCategory: 'moderator' });
  expect(await reddit.getPostById(c.id)).toMatchObject({ removed: true, spam: true });
  const comment = await reddit.submitComment({ id: a.id, text: 'x' });
  await reddit.remove(comment.id, false);
  expect((await reddit.getCommentById(comment.id)).removed).toBe(true);
  expect(world.actions.map(({ type }) => type)).toEqual(['remove', 'remove', 'remove', 'comment', 'removeComment']);
  expect(world.modLog.map(({ type, mod, target }) => [type, mod, target.id])).toEqual([
    ['removelink', APP, a.id], ['removelink', APP, b.id], ['spamlink', APP, c.id], ['removecomment', APP, comment.id],
  ]);
  const deletes = world.drain().filter(({ body }) => body.type === 'PostDelete');
  expect(deletes.map(({ body }) => body)).toMatchObject([{ postId: a.id, source: 3 }, { postId: b.id, source: 3 }, { postId: c.id, source: 3 }]);
});

test('approve clears the removal fields; report puts a visible post in the mod queue', async ({ config, mocks }) => {
  const { world, post } = setup({ config, mocks });
  const removed = post();
  await reddit.remove(removed.id, false);
  await reddit.approve(removed.id);
  expect(await reddit.getPostById(removed.id)).toMatchObject({ approved: true, removed: false, spam: false, removedBy: undefined, removedByCategory: undefined });
  const reported = post();
  await reddit.report(await reddit.getPostById(reported.id), { reason: 'Repost' });
  expect((await reddit.getPostById(reported.id)).modReports).toEqual([{ reason: 'Repost', author: APP }]);
  expect((await reddit.getModQueue({ subreddit: 'wallpapers', type: 'post' }).all()).map((p) => p.id)).toEqual([reported.id]);
  expect(world.actions.map(({ type }) => type)).toEqual(['remove', 'approve', 'report']);
});

test('getNewPosts lists the visible posts of the subreddit, newest first, over several pages', async ({ config, mocks }) => {
  const { world, post } = setup({ config, mocks });
  world.addSub('other');
  const ids = Array.from({ length: 5 }, (_, i) => post({ title: `P${i}` }).id);
  post({ sub: 'other' });
  world.automodFilter(ids[1]!);
  world.userDelete(ids[2]!);
  world.modRemove(ids[3]!, 'mod1');
  expect((await reddit.getNewPosts({ subredditName: 'wallpapers', limit: 100 }).all()).map((p) => p.id)).toEqual([ids[4], ids[0]]);
  expect((await reddit.getNewPosts({ subredditName: 'wallpapers', limit: 100, pageSize: 1 }).all()).map((p) => p.id)).toEqual([ids[4], ids[0]]);
  expect((await reddit.getModQueue({ subreddit: 'wallpapers', type: 'post' }).all()).map((p) => p.id)).toEqual([ids[1]]);
});

test('the mod log lists the actions newest first and filters by moderator and type', async ({ config, mocks }) => {
  const { world, post } = setup({ config, mocks });
  const [a, b, c] = [post(), post(), post()];
  world.modRemove(a.id, 'mod1');
  await reddit.remove(b.id, false);
  world.modRemove(c.id, 'AnimewallpaperBot');
  const log = (options: Record<string, unknown> = {}) => reddit.getModerationLog({ subredditName: 'wallpapers', ...options }).all();
  expect((await log()).map((e) => [e.type, e.moderatorName, e.target?.id])).toEqual([
    ['removelink', 'AnimewallpaperBot', c.id], ['removelink', APP, b.id], ['removelink', 'mod1', a.id],
  ]);
  expect((await log({ moderatorUsernames: ['AnimewallpaperBot', 'mod1'] })).map((e) => e.target?.id)).toEqual([c.id, a.id]);
  expect(await log({ type: 'approvelink' })).toEqual([]);
  expect((await log({ limit: 2, pageSize: 1 })).length).toBe(2);
  expect((await log())[0]).toMatchObject({ moderatorId: 't2_AnimewallpaperBot', subredditName: 'wallpapers', subredditId: 't5_wallpapers', createdAt: new Date(T0), target: { author: 'alice', title: 'Sunset', permalink: expect.stringContaining(c.id.slice(3)) } });
});

test('getComments gives the top-level comments of the post in order, with their authors', async ({ config, mocks }) => {
  const { world, post } = setup({ config, mocks });
  const { id } = post();
  world.addComment({ postId: id, author: 'alice', body: 'source: x' });
  world.addComment({ postId: id, author: '[deleted]', body: 'gone' });
  await reddit.submitComment({ id, text: 'bot' });
  const comments = await reddit.getComments({ postId: id, depth: 1, limit: 1000 }).all();
  expect(comments.map((c) => [c.authorName, c.body, c.distinguishedBy])).toEqual([['alice', 'source: x', undefined], ['[deleted]', 'gone', undefined], [APP, 'bot', undefined]]);
  expect(comments[1]!.authorId).toBeUndefined();
  expect(await comments[0]!.replies.all()).toEqual([]); // the world has no replies
});

test('wiki pages and mod notifications', async ({ config, mocks }) => {
  const { world } = setup({ config, mocks });
  world.wiki.set('wallpapers/awb-backfill-1', '# until: 2026-12-08T00:00:00Z\nabc123');
  expect((await reddit.getWikiPage('wallpapers', 'awb-backfill-1')).content).toBe('# until: 2026-12-08T00:00:00Z\nabc123');
  await expect(reddit.getWikiPage('wallpapers', 'missing')).rejects.toThrow('404');
  const id = await reddit.modMail.createModNotification({ subject: 'tick-stalled', bodyMarkdown: 'no tick', subredditId: 't5_wallpapers' });
  expect(world.modmail).toEqual([{ id, subredditId: 't5_wallpapers', subject: '[notification] tick-stalled', bodyMarkdown: 'no tick' }]); // the client adds the prefix
});

test('users and subreddits reach the harness: getUserByUsername works for authors and the app user', async ({ config, mocks }) => {
  const { world, post } = setup({ config, mocks });
  post({ author: 'bob' });
  expect((await reddit.getUserByUsername('bob'))?.id).toBe('t2_bob');
  expect((await reddit.getAppUser())?.id).toBe(world.app.id); // the harness context names the app test-app
  expect((await reddit.getSubredditByName('wallpapers')).id).toBe('t5_wallpapers');
});

test('what the world does not simulate throws, for client methods and for model methods', async ({ config, mocks }) => {
  const { post } = setup({ config, mocks });
  const p = await reddit.getPostById(post().id);
  const calls: Record<string, () => unknown> = {
    submitPost: () => reddit.submitPost({ subredditName: 'wallpapers', title: 't', text: 'b' }),
    setPostFlair: () => reddit.setPostFlair({ subredditName: 'wallpapers', postId: p.id, flairTemplateId: 'f' }),
    banUser: () => reddit.banUser({ subredditName: 'wallpapers', username: 'alice' }),
    sendPrivateMessage: () => reddit.sendPrivateMessage({ to: 'alice', subject: 's', text: 't' }),
    addModNote: () => reddit.addModNote({ subreddit: 'wallpapers', user: 'alice', note: 'n' }),
    'modMail.reply': () => reddit.modMail.reply({ conversationId: 'c', body: 'b' }),
    'post.hide': () => p.hide(),
    'post.sticky': () => p.sticky(),
    'post.getEnrichedThumbnail': () => p.getEnrichedThumbnail(),
  };
  for (const [name, call] of Object.entries(calls)) await expect(Promise.resolve().then(call), name).rejects.toThrow(/not simulated/);
});

test('the actors of the world: author delete, AutoMod filter, flair change, user comment; each sends its event', async ({ config, mocks }) => {
  const { world, post } = setup({ config, mocks });
  const { id } = post();
  world.drain();
  world.setFlair(id, 'Mobile', 'alice');
  expect((await reddit.getPostById(id)).flair?.text).toBe('Mobile');
  world.addComment({ postId: id, author: 'alice', body: 'src' });
  world.userDelete(id);
  expect(await reddit.getPostById(id)).toMatchObject({ removedByCategory: 'deleted', removed: false, spam: false });
  const filtered = post().id;
  world.automodFilter(filtered);
  expect(await reddit.getPostById(filtered)).toMatchObject({ removed: true, removedBy: 'AutoModerator', removedByCategory: 'automod_filtered', approved: false });
  expect(world.drain().map(({ trigger, sub }) => [trigger, sub])).toEqual([
    ['onPostFlairUpdate', 'wallpapers'], ['onCommentCreate', 'wallpapers'], ['onPostDelete', 'wallpapers'], ['onPostSubmit', 'wallpapers'],
  ]);
  expect(world.drain()).toEqual([]);
  expect(world.actions).toEqual([]); // the app did nothing
});

test('an app comment sends CommentCreate from the app user; the app removal sends PostDelete from a moderator', async ({ config, mocks }) => {
  const { world, post } = setup({ config, mocks });
  const { id } = post();
  world.drain();
  const comment = await reddit.submitComment({ id, text: 'x' });
  await reddit.remove(id, false);
  const [created, deleted] = world.drain().map(({ body }) => body);
  expect(created).toMatchObject({ type: 'CommentCreate', comment: { id: comment.id, author: APP }, author: { id: world.app.id, accountType: 3 } });
  expect(deleted).toMatchObject({ type: 'PostDelete', postId: id, source: 3, author: { id: 't2_alice' } });
});

test('the core predicates read the posts of the world as the plan says', async ({ config, mocks }) => {
  const { world, post } = setup({ config, mocks });
  const read = (id: Post['id']) => reddit.getPostById(id);
  const state = async (id: Post['id']) => {
    const p = await read(id);
    return [isRemoved(p), isDeleted(p), isAlive(p), isCounted(p, false), isCounted(p, true), skipsAsRemoved(p, 'enforce'), skipsAsRemoved(p, 'dry-run')];
  };
  const [fresh, removed, deleted, filtered, legacy, approved] = [post(), post(), post(), post(), post(), post()];
  world.modRemove(removed.id, 'mod1');
  world.userDelete(deleted.id);
  world.automodFilter(filtered.id);
  world.modRemove(legacy.id, LEGACY_BOT);
  world.modRemove(approved.id, 'mod1');
  world.approve(approved.id, 'mod1');
  //                                           removed deleted alive counted counted(+deleted) skip(enforce) skip(dry-run)
  expect(await state(fresh.id)).toEqual([false, false, true, true, true, false, false]);
  expect(await state(removed.id)).toEqual([true, false, false, false, false, true, true]);
  expect(await state(deleted.id)).toEqual([false, true, false, false, true, false, false]);
  expect(await state(filtered.id)).toEqual([true, false, false, false, false, false, false]); // AutoMod filtered posts are still checked
  expect(await state(legacy.id)).toEqual([true, false, false, false, false, true, false]); // the shadow ignores a removal by the legacy bot
  expect(await state(approved.id)).toEqual([false, false, true, true, true, false, false]);
});

test('postImages finds the images of image, gallery and crosspost posts, and none of link and video posts', async ({ config, mocks }) => {
  const { post, image } = setup({ config, mocks });
  const sizes = async (id: Post['id']) => {
    const p = await reddit.getPostById(id);
    return postImages(p, p.crosspostParentId ? await reddit.getPostById(p.crosspostParentId) : undefined).map(({ n, width, height, url }) => [n, width, height, /^https:\/\/i\.redd\.it\/\w+\.jpg$/.test(url)]);
  };
  const gallery = post({ images: [image(900, 1600), image(1000, 1000)] });
  expect(await sizes(post().id)).toEqual([[1, 1920, 1080, true]]);
  expect(await sizes(gallery.id)).toEqual([[1, 900, 1600, true], [2, 1000, 1000, true]]);
  expect(await sizes(post({ images: [], crosspostOf: gallery.id }).id)).toEqual([[1, 900, 1600, true], [2, 1000, 1000, true]]);
  expect(await sizes(post({ kind: 'link', url: 'https://imgur.com/a.jpg' }).id)).toEqual([]);
  expect(await sizes(post({ kind: 'video' }).id)).toEqual([]);
  expect(await sizes(post({ images: [], kind: 'text' }).id)).toEqual([]);
});
