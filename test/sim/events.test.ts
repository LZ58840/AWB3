import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import devvit from '../../devvit.json';
import { commentCreate, postDelete, postFlairUpdate, postSubmit, TRIGGER } from './events';
import type { Comment, Post, Sub, User } from './world';

const T = Date.parse('2026-12-08T10:00:00Z');
const alice: User = { id: 't2_alice', name: 'alice' };
const app: User = { id: `t2_${devvit.name}`, name: devvit.name, app: true };
const sub: Sub = { id: 't5_wallpapers', name: 'wallpapers', mods: ['mod1'] };
const url = (n: number) => `https://i.redd.it/p1img${n}.jpg`;
const image = (n: number, width = 1920, height = 1080) => ({ url: url(n), width, height, status: 1 });
const post = (over: Partial<Post> = {}): Post => ({
  id: 't3_p1', sub: sub.name, author: alice.name, authorId: alice.id, title: 'Sunset [1920x1080]', createdAt: T, kind: 'image', url: url(1), flair: 'Desktop',
  gallery: [image(1)], approved: false, removed: false, spam: false, locked: false, reports: [], ...over,
});
const comment: Comment = {
  id: 't1_c1', postId: 't3_p1', sub: sub.name, author: app.name, authorId: app.id, body: 'removed', createdAt: T + 1000,
  distinguished: false, stickied: false, removed: false, spam: false, approved: false,
};

test('PostSubmit of an image post: ids with prefixes, ms times, image URLs and flair', () => {
  const event = postSubmit(post(), alice, sub);
  expect(event).toMatchObject({
    type: 'PostSubmit',
    post: {
      id: 't3_p1', title: 'Sunset [1920x1080]', authorId: 't2_alice', subredditId: 't5_wallpapers', createdAt: T,
      url: url(1), isImage: true, isGallery: false, isVideo: false, isSelf: false, isLocked: false, isApproved: false, spam: false, deleted: false,
      galleryImages: [], mediaUrls: [url(1)], crosspostParentId: '', linkFlair: { text: 'Desktop' },
      permalink: '/r/wallpapers/comments/p1/post/',
    },
    author: { id: 't2_alice', name: 'alice', accountType: 1 },
    subreddit: { id: 't5_wallpapers', name: 'wallpapers' },
  });
});

test('gallery, link and crosspost posts set their flags', () => {
  const gallery = postSubmit(post({ kind: 'gallery', gallery: [image(1), image(2)] }), alice, sub).post!;
  expect([gallery.isGallery, gallery.galleryImages]).toEqual([true, [url(1), url(2)]]);
  const link = postSubmit(post({ kind: 'link', url: 'https://example.com/a.jpg', gallery: [] }), alice, sub).post!;
  expect([link.isImage, link.isGallery, link.url]).toEqual([false, false, 'https://example.com/a.jpg']);
  expect(postSubmit(post({ kind: 'crosspost', crosspostParent: 't3_p0', gallery: [] }), alice, sub).post!.crosspostParentId).toBe('t3_p0');
  expect(postSubmit(post({ flair: undefined }), alice, sub).post!.linkFlair).toBeUndefined();
});

test('PostFlairUpdate carries the updater as author', () => {
  expect(postFlairUpdate(post(), { id: 't2_mod1', name: 'mod1' }, sub)).toMatchObject({ type: 'PostFlairUpdate', post: { id: 't3_p1' }, author: { name: 'mod1' } });
});

test('PostDelete: numeric source enum, ISO times, no body, author is the post author', () => {
  const event = postDelete(post(), alice, sub, 'MODERATOR', T + 60_000);
  expect(event).toEqual({
    type: 'PostDelete', postId: 't3_p1', source: 3, reason: 0,
    deletedAt: '2026-12-08T10:01:00.000Z', createdAt: '2026-12-08T10:00:00.000Z',
    author: expect.objectContaining({ id: 't2_alice' }), subreddit: expect.objectContaining({ id: 't5_wallpapers' }),
  });
  expect(postDelete(post(), alice, sub, 'USER', T).source).toBe(1);
});

test('CommentCreate from the app user: the comment author is a name, the app account type is 3', () => {
  expect(commentCreate(comment, app, post(), sub)).toMatchObject({
    type: 'CommentCreate',
    comment: { id: 't1_c1', parentId: 't3_p1', postId: 't3_p1', body: 'removed', author: app.name, createdAt: T + 1000, subredditId: 't5_wallpapers' },
    author: { id: app.id, name: app.name, accountType: 3 },
    post: { id: 't3_p1' },
  });
});

test('each body survives JSON, and each event has a trigger name of devvit.json', () => {
  for (const body of [postSubmit(post(), alice, sub), postFlairUpdate(post(), alice, sub), postDelete(post(), alice, sub, 'USER', T), commentCreate(comment, app, post(), sub)]) {
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
    expect(TRIGGER[body.type]).toMatch(/^on[A-Z]/);
  }
});

// Fidelity hook (plan 7.2). S3 replaces the guessed shapes of events.ts with captured trigger bodies: put one JSON file per
// body in test/fixtures/payloads/ and each file then gets a test that compares keys and value types with the builder.
const shape = (value: unknown, path = '$'): Record<string, string> => {
  if (Array.isArray(value)) return { [path]: 'array' }; // the elements are not compared: a sample can have none
  if (value && typeof value === 'object') return Object.assign({}, ...Object.entries(value).map(([key, v]) => shape(v, `${path}.${key}`)), { [path]: 'object' });
  return { [path]: value === null ? 'null' : typeof value };
};
const sameShape = (real: unknown, built: unknown) => {
  const [r, b] = [shape(real), shape(built)];
  return Object.keys({ ...r, ...b }).filter((path) => r[path] !== b[path]).map((path) => `${path}: captured ${r[path] ?? 'missing'}, built ${b[path] ?? 'missing'}`);
};

test('sameShape reports a missing key, an extra key and a changed type', () => {
  expect(sameShape({ a: 1, b: { c: 'x' }, d: [1] }, { a: 2, b: { c: 'y' }, d: [] })).toEqual([]);
  expect(sameShape({ a: 1, b: 'x' }, { a: '1', c: 1 })).toEqual(['$.a: captured number, built string', '$.b: captured string, built missing', '$.c: captured missing, built number']);
});

const SAMPLE = {
  PostSubmit: () => postSubmit(post(), alice, sub),
  PostFlairUpdate: () => postFlairUpdate(post(), alice, sub),
  PostDelete: () => postDelete(post(), alice, sub, 'MODERATOR', T),
  CommentCreate: () => commentCreate(comment, app, post(), sub),
};
const dir = new URL('../fixtures/payloads/', import.meta.url);
for (const file of existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : []) {
  test(`the builder has the keys and types of the captured payload ${file}`, () => {
    const real = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as { type: keyof typeof SAMPLE };
    expect(SAMPLE[real.type], `no builder for type ${real.type}`).toBeDefined();
    expect(sameShape(real, SAMPLE[real.type]())).toEqual([]);
  });
}
