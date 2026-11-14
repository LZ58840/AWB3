// Spikes S2 and S3: spikes/s2s3/extract.mjs reads the log of the spike app (`devvit logs ... --json > spike-logs.jsonl`), writes the
// trigger bodies as fixtures with anonymous ids and names, and prints the S2 tables and the S3 checks. The sample below is made by
// hand: the lines that the CLI writes (the record is the `message` of a log line) and the keys that spikes/s2s3/src/app.ts logs.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';

const script = fileURLToPath(new URL('../../spikes/s2s3/extract.mjs', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'extract-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const run = (...args: string[]) => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });

// Reddit data of the sample: the poster, a moderator, the app, and the test subreddit.
const POSTER = { id: 't2_1a2b3c', name: 'LZ58842' };
const MOD = { id: 't2_4d5e6f', name: 'LZ58841' };
const APP = { id: 't2_7g8h9i', name: 'animewallpaperbotv3' };
const SUB = { id: 't5_9q8w7e', name: 'LZ58840' };
const T0 = 1_790_000_000_000; // creation of the first post, in ms
const SUBMIT1 = T0 + 2100;
const iso = (ms: number) => new Date(ms).toISOString();

const user = ({ id, name }: { id: string; name: string }, accountType = 1) => ({ id, name, url: `/user/${name}/`, accountType, karma: 3 });
const subreddit = { id: SUB.id, name: SUB.name, permalink: `/r/${SUB.name}/`, type: 1, rating: 0 };
const postV2 = (id: string, title: string, over: object = {}) => ({
  id, title, authorId: POSTER.id, subredditId: SUB.id, createdAt: T0, url: 'https://i.redd.it/m4g1c0n1.png', crowdControlLevel: 0, distinguished: 0,
  permalink: `/r/${SUB.name}/comments/${id.slice(3)}/${title.toLowerCase().replace(/\W+/g, '_')}/`, ...over,
});
const P1 = postV2('t3_1abcd2', 'S2-01 png 1920x1080 single');
const P2 = postV2('t3_3automd', 'S2-09 automod title');
const P3 = 't3_2zzzz9'; // made before the install: only PostDelete arrives
const P4 = postV2('t3_5size00', 'S2-05 jpg 3840x2160 single');
const P5 = postV2('t3_6xpost', 'S2-10 crosspost single', { url: `https://www.reddit.com/r/${SUB.name.toLowerCase()}/comments/6xpost/`, crosspostParentId: P1.id }); // Reddit names are not case sensitive
const P6 = postV2('t3_7ext000', 'S2-11 external image link', { url: 'https://example.com/a.jpg' });
const P7 = postV2('t3_8video0', 'S2-12 video', { url: 'https://v.redd.it/vid000' });

const png = { url: 'https://i.redd.it/m4g1c0n1.png', width: 1920, height: 1080, status: 1, normalized: 'https://i.redd.it/m4g1c0n1.png' };
const headers = { 'devvit-app': APP.name, 'devvit-subreddit': SUB.id, 'devvit-subreddit-name': SUB.name };
const on = (name: string, at: number, body: object) => ({ s3: name, at, headers, body });
// The post record of the app. An undefined value is written as '[undefined]'.
const snap = (post: { id: string; title: string; url: string }, via: string, at: number, over: object = {}) => ({
  s2: 'post', via, at, id: post.id, title: post.title, url: post.url, permalink: `/r/${SUB.name}/comments/${post.id.slice(3)}/`,
  createdAt: { type: 'Date', value: iso(T0), ms: T0 }, removed: false, spam: false, approved: false, removedBy: '[undefined]', removedByCategory: '[undefined]',
  crosspostParentId: '[undefined]', gallery: [png], thumbnail: '[undefined]', flair: { text: 'Desktop' }, authorName: POSTER.name, authorId: POSTER.id,
  enriched: { ok: { image: { url: 'https://preview.redd.it/e.jpg', width: 640, height: 360 }, isObfuscatedDefault: false } }, ...over,
});

const submit1 = { type: 'PostSubmit', post: P1, author: user(POSTER), subreddit };
const comment = {
  type: 'CommentCreate', comment: { id: 't1_c0mm3n', author: APP.name, body: 'S3 probe', createdAt: T0 + 29_000, postId: P1.id, subredditId: SUB.id },
  author: user(APP, 3), post: P1, subreddit,
};
const automod = { type: 'AutomoderatorFilterPost', post: P2, author: POSTER.id, reason: 'title word', subreddit };
const removal = { type: 'ModAction', action: 'removelink', actionedAt: iso(SUBMIT1 + 59_000), moderator: user(MOD), targetUser: user(POSTER), targetPost: P1, subreddit };
const delete1 = { type: 'PostDelete', postId: P1.id, deletedAt: iso(SUBMIT1 + 61_000), author: user(POSTER), createdAt: iso(T0), source: 3, reason: 0, subreddit };
const delete3 = { type: 'PostDelete', postId: P3, deletedAt: iso(T0 + 90_000), author: user(POSTER), createdAt: iso(T0 - 86_400_000), source: 1, reason: 0, subreddit };

const records: object[] = [
  on('onPostSubmit', SUBMIT1, submit1),
  snap(P1, 'onPostSubmit', SUBMIT1 + 200),
  on('onPostSubmit', T0 + 1500, { type: 'PostSubmit', post: P2, author: user(POSTER), subreddit }),
  snap(P2, 'onPostSubmit', T0 + 1700),
  on('onAutomoderatorFilterPost', T0 + 2500, automod),
  snap(P2, 'onAutomoderatorFilterPost', T0 + 2700, { removed: true, removedBy: 'AutoModerator', removedByCategory: 'automod_filtered' }),
  on('onCommentCreate', SUBMIT1 + 30_000, comment),
  on('onPostDelete', SUBMIT1 + 61_000, delete1), // logged before the removal that came first: events of one post can arrive in any order
  on('onModAction', SUBMIT1 + 60_000, removal),
  snap(P1, 'onModAction:removelink', SUBMIT1 + 60_200, { removed: true, removedBy: MOD.name, removedByCategory: 'moderator' }),
  on('onPostDelete', T0 + 90_000, delete3),
  { s2: 'post', via: 'onPostDelete', at: T0 + 90_300, id: P3, error: 'Error: THING_NOT_FOUND' },
  snap(P4, 'menu', T0 + 100_000, { gallery: [{ ...png, width: 3840, height: 2159 }] }),
  snap(P5, 'onPostSubmit', T0 + 110_000, { gallery: [], crosspostParentId: P1.id, parent: { ok: { id: P1.id, title: P1.title, url: P1.url, gallery: [png] } } }),
  // A link or a video post has one preview image in gallery; under 5.2 the post has no image.
  snap(P6, 'menu', T0 + 120_000, { gallery: [{ url: 'https://preview.redd.it/x1y2.jpg?width=640', width: 640, height: 360, status: 1, normalized: 'https://i.redd.it/x1y2.jpg' }] }),
  snap(P7, 'menu', T0 + 125_000, { gallery: [{ url: 'https://external-preview.redd.it/x.jpg?s=1', width: 640, height: 360, status: 1, normalized: null }] }),
  {
    s2: 'listings', at: T0 + 130_000, subreddit: SUB.name,
    new: { ok: [{ id: P1.id, removed: false, spam: false, removedByCategory: '[undefined]' }] },
    modQueue: { ok: [{ id: P2.id, removed: true, spam: false, removedByCategory: 'automod_filtered' }] },
  },
  {
    s3: 'probe', at: T0 + 140_000, headers: { ...headers, 'devvit-user': MOD.id, 'devvit-user-name': MOD.name }, body: { location: 'subreddit', targetId: SUB.id },
    context: { appName: APP.name, subredditName: SUB.name }, redisNx: [{ ok: 'OK' }, { ok: '' }],
    settings: { ok: { fetchProbe: 'boolean', probeSelect: 'array[1] of string' } }, appUser: { ok: { id: APP.id, username: APP.name } },
  },
  { s4: 'redis', at: T0 + 145_000, step: 'hGetAllSequential', ms: 900 },
  { s4: 'decode', at: T0 + 146_000, size: '7680x4320', format: 'jpeg', error: 'Error: maxMemoryUsageInMB limit exceeded' },
  {
    s6: 'fetch', at: T0 + 150_000, id: P1.id, from: 'gallery', url: 'https://preview.redd.it/m4g1c0n1.jpg?width=320', width: 320, height: 180,
    ok: { status: 200, contentType: 'image/jpeg', contentLength: '12345', bytes: 12345, first16: 'ffd8ffe000104a464946000101000001' },
  },
];

/** What `devvit logs --json` writes for a console.log line. */
const cli = (record: object) => JSON.stringify({ severity: 1, message: JSON.stringify(record), timestamp: '2026-09-21T14:14:00.000Z' });
const out = join(work, 'payloads');
let stdout = '';
beforeAll(() => {
  const log = [
    'npm notice run devvit', // not JSON
    '',
    ...records.slice(0, -1).map(cli),
    JSON.stringify({ severity: 3, message: 'route error; Error: a plain log line', timestamp: '2026-09-21T14:14:00.000Z' }), // JSON, but the message is not a record
    JSON.stringify(records.at(-1)), // a line that is the record itself
  ];
  writeFileSync(join(work, 'spike-logs.jsonl'), log.join('\n'));
  stdout = run(join(work, 'spike-logs.jsonl'), out);
});

const files = (dir = '') => readdirSync(join(out, dir)).filter((name) => name.endsWith('.json')).sort();
const read = (path: string) => JSON.parse(readFileSync(join(out, path), 'utf8')) as Record<string, any>;

test('trigger bodies become fixtures, numbered for each trigger; the types that the simulator has no builder for go to unmodeled/', () => {
  expect(files()).toEqual(['onCommentCreate-1.json', 'onPostDelete-1.json', 'onPostDelete-2.json', 'onPostSubmit-1.json', 'onPostSubmit-2.json']);
  expect(files('unmodeled')).toEqual(['onAutomoderatorFilterPost-1.json', 'onModAction-1.json']);
  expect(stdout).toContain(`wrote 5 fixtures to ${out}\n`);
  expect(stdout).toContain(`wrote 2 fixtures to ${join(out, 'unmodeled')}`);
});

const paths = (value: unknown, path = '$'): string[] => (value && typeof value === 'object' ? Object.entries(value).flatMap(([key, v]) => paths(v, `${path}.${key}`)) : [`${path}: ${typeof value}`]);

test('a fixture has the keys and value types of the body that Reddit sent, and its values apart from ids and names', () => {
  expect(paths(read('onPostSubmit-1.json'))).toEqual(paths(submit1));
  expect(paths(read('onCommentCreate-1.json'))).toEqual(paths(comment));
  expect(paths(read('unmodeled/onModAction-1.json'))).toEqual(paths(removal));
  expect(read('onPostDelete-1.json')).toMatchObject({ type: 'PostDelete', source: 3, reason: 0, deletedAt: iso(SUBMIT1 + 61_000), createdAt: iso(T0) });
  expect(read('onPostSubmit-1.json').post).toMatchObject({ title: P1.title, createdAt: T0, crowdControlLevel: 0 });
});

test('ids and names are replaced in every fixture and in the printed tables, and the original is left nowhere', () => {
  const texts = [...files().map((name) => join(out, name)), ...files('unmodeled').map((name) => join(out, 'unmodeled', name))].map((path) => readFileSync(path, 'utf8'));
  const everything = [...texts, stdout.replaceAll(work, '')].join('\n').toLowerCase();
  for (const secret of ['LZ58840', 'LZ58841', 'LZ58842', 'animewallpaperbotv3', '1abcd2', '3automd', '2zzzz9', '1a2b3c', '4d5e6f', '7g8h9i', '9q8w7e', 'c0mm3n']) {
    expect(everything, secret).not.toContain(secret.toLowerCase());
  }
  expect(everything).toContain('automoderator'); // the Reddit account that filters posts keeps its name
});

test('the same id or name gets the same alias in every file, with the prefix of its kind', () => {
  const submit = read('onPostSubmit-1.json');
  const mod = read('unmodeled/onModAction-1.json');
  const created = read('onCommentCreate-1.json');
  expect(submit.post.id).toBe('t3_post1');
  expect([mod.targetPost.id, read('onPostDelete-1.json').postId, created.post.id]).toEqual(['t3_post1', 't3_post1', 't3_post1']);
  expect(submit.post.permalink).toBe('/r/subname1/comments/post1/s2_01_png_1920x1080_single/'); // the short id and the subreddit name inside a path
  expect(submit.subreddit.id).toBe(read('onPostDelete-2.json').subreddit.id);
  expect([submit.author.id, submit.post.authorId, mod.targetUser.id]).toEqual(['t2_user1', 't2_user1', 't2_user1']);
  expect(submit.author.url).toBe(`/user/${submit.author.name}/`);
  expect(submit.author.name).toBe(mod.targetUser.name);
  expect(created.comment.author).toBe(created.author.name); // a name as a plain string value
  expect(read('unmodeled/onAutomoderatorFilterPost-1.json').author).toBe('t2_user1'); // in this body the author is a user id
});

test('S2 states: one row for each post lookup; [undefined] differs from an empty value; an error is text', () => {
  expect(stdout).toContain('| S2-01 png 1920x1080 single | onPostSubmit | false | false | false | [undefined] | [undefined] |');
  expect(stdout).toContain('| S2-09 automod title | onAutomoderatorFilterPost | true | false | false | AutoModerator | automod_filtered |');
  expect(stdout).toMatch(/\| S2-01 png 1920x1080 single \| onModAction:removelink \| true \| false \| false \| name\d+ \| moderator \|/);
  expect(stdout).toMatch(/\| t3_post\d+ \| onPostDelete \| error: Error: THING_NOT_FOUND \|/);
});

test('S2 images: size against the title, the URL rule, images under 5.2 (a crosspost counts the images of its parent)', () => {
  expect(stdout).toContain('| S2-01 png 1920x1080 single | https://i.redd.it/m4g1c0n1.png | 1920x1080/1 | ok | https://i.redd.it/m4g1c0n1.png | 1 | [undefined] |');
  expect(stdout).toMatch(/\| S2-05 jpg 3840x2160 single \| \S+ \| 3840x2159\/1 \| DIFF \|/);
  expect(stdout).toMatch(/\| S2-10 crosspost single \| \S+ \| \(none\) \| - \| \(none\) \| 1 \| t3_post1 \|/);
  expect(stdout).toContain('| S2-11 external image link | https://example.com/a.jpg | 640x360/1 | - | https://i.redd.it/x1y2.jpg | 0 | [undefined] |');
  expect(stdout).toContain('| S2-12 video | https://v.redd.it/vid000 | 640x360/1 | - | null | 0 | [undefined] |');
});

test('S2 events: the triggers of each post in time order, the delay of the post trigger, a mark for a post that has no onPostSubmit', () => {
  expect(stdout).toContain('| S2-01 png 1920x1080 single | onPostSubmit +0.0s (delay 2.1s), onCommentCreate +30.0s, onModAction:removelink +60.0s, onPostDelete source=3 +61.0s |');
  expect(stdout).toContain('| S2-09 automod title | onPostSubmit +0.0s (delay 1.5s), onAutomoderatorFilterPost +1.0s |');
  expect(stdout).toMatch(/\| t3_post\d+ \| onPostDelete source=1 \+0\.0s \[no onPostSubmit\] \|/);
});

test('S2 listings: what /new and the mod queue showed, with the state of each post', () => {
  expect(stdout).toContain('dump 1 new: S2-01 png 1920x1080 single (removed=false spam=false category=[undefined])');
  expect(stdout).toContain('dump 1 modQueue: S2-09 automod title (removed=true spam=false category=automod_filtered)');
});

test('S3 checks: time units, enums, PostDelete times, the account type of the app, headers, the probe and the fetch', () => {
  expect(stdout).toContain(`- PostSubmit post.createdAt: number ${T0} (ms)`);
  expect(stdout).toContain(`- CommentCreate comment.createdAt: number ${T0 + 29_000} (ms)`);
  expect(stdout).toContain('- PostSubmit post.crowdControlLevel: number 0');
  expect(stdout).toContain(`- PostDelete deletedAt: string "${iso(SUBMIT1 + 61_000)}"`);
  expect(stdout).toContain('- PostDelete source: number 3');
  expect(stdout).toMatch(/- CommentCreate by name\d+: author\.accountType number 3/);
  expect(stdout).toContain('- headers on triggers: devvit-app, devvit-subreddit, devvit-subreddit-name; user headers: none');
  expect(stdout).toContain('- probe redisNx: [{"ok":"OK"},{"ok":""}]');
  expect(stdout).toContain('- probe settings: {"ok":{"fetchProbe":"boolean","probeSelect":"array[1] of string"}}');
  expect(stdout).toMatch(/- probe appUser: \{"ok":\{"id":"t2_user\d+","username":"name\d+"\}\}/);
  expect(stdout).toContain('- fetch probe S2-01 png 1920x1080 single: gallery 320x180 {"status":200,"contentType":"image/jpeg","contentLength":"12345","bytes":12345,"first16":"ffd8ffe000104a464946000101000001"}');
});

test('user headers on a trigger are reported: the three that set the user of the context, not devvit-user-agent', () => {
  const log = join(work, 'user-headers.jsonl');
  const headers = { 'devvit-user': 't2_x', 'devvit-user-name': 'x', 'devvit-user-snoovatar-url': 'https://i.redd.it/s.png', 'devvit-user-agent': 'ua' };
  writeFileSync(log, cli({ s3: 'onPostSubmit', at: T0, headers, body: { type: 'PostSubmit' } }));
  expect(run(log, join(work, 'user-headers-out'))).toContain(
    '- headers on triggers: devvit-user, devvit-user-agent, devvit-user-name, devvit-user-snoovatar-url; user headers: devvit-user, devvit-user-name, devvit-user-snoovatar-url',
  );
});

test('a post time in seconds is recognized; the delay is computed in milliseconds', () => {
  const log = join(work, 'seconds.jsonl');
  writeFileSync(log, cli(on('onPostSubmit', 1_790_000_002_100, { type: 'PostSubmit', post: { id: 't3_x', title: 'T', createdAt: 1_790_000_000 } })));
  const text = run(log, join(work, 'seconds-out'));
  expect(text).toContain('- PostSubmit post.createdAt: number 1790000000 (s)');
  expect(text).toContain('| T | onPostSubmit +0.0s (delay 2.1s) |');
});

test('an id or a name is replaced as a whole token only, so that a longer word stays', () => {
  const log = join(work, 'tokens.jsonl');
  writeFileSync(log, cli(on('onPostSubmit', T0, { type: 'PostSubmit', post: { id: 't3_abc12', title: 'xabc12 abc12x abc12 x-LZ58842 LZ58842-x' }, author: user(POSTER) })));
  run(log, join(work, 'tokens-out'));
  const { post } = JSON.parse(readFileSync(join(work, 'tokens-out', 'onPostSubmit-1.json'), 'utf8'));
  expect(post.title).toBe('xabc12 abc12x post1 x-LZ58842 LZ58842-x');
});

test('a log with no records writes nothing and says so', () => {
  const empty = join(work, 'empty.jsonl');
  writeFileSync(empty, 'npm notice\n');
  expect(run(empty, join(work, 'none'))).toContain('no records');
  expect(() => readdirSync(join(work, 'none'))).toThrow();
});

test('without an output directory the script writes to test/fixtures/payloads of the repo that it is in', () => {
  const repo = join(work, 'repo');
  mkdirSync(join(repo, 'spikes', 's2s3'), { recursive: true });
  copyFileSync(script, join(repo, 'spikes', 's2s3', 'extract.mjs'));
  execFileSync(process.execPath, [join(repo, 'spikes', 's2s3', 'extract.mjs'), join(work, 'spike-logs.jsonl')]);
  expect(readdirSync(join(repo, 'test', 'fixtures', 'payloads')).filter((name) => name.endsWith('.json'))).toHaveLength(5);
});

test('S4: each line is printed as it is, without its time', () => {
  expect(stdout).toContain('## S4 (times in ms)\n- {"s4":"redis","step":"hGetAllSequential","ms":900}\n- {"s4":"decode","size":"7680x4320","format":"jpeg","error":"Error: maxMemoryUsageInMB limit exceeded"}');
});
