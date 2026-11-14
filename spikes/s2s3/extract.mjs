// Reads the log of the S2/S3 spike app, writes the trigger bodies as fixtures (ids and names replaced), prints the S2 tables and the S3 checks.
// Usage: node spikes/s2s3/extract.mjs spike-logs.jsonl [outDir]     (outDir is test/fixtures/payloads of this repo by default)
// The log comes from `devvit logs r/<sub> animewallpaperbotv3 --since 1d --json > spike-logs.jsonl` (README.md). A line is the JSON of a log
// message; the message is a record of src/app.ts with the key s2, s3, s4 or s6. A line that is the record itself is read too; other lines are skipped.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [logFile, outDir = fileURLToPath(new URL('../../test/fixtures/payloads/', import.meta.url))] = process.argv.slice(2);
if (!logFile) {
  console.error('usage: node spikes/s2s3/extract.mjs spike-logs.jsonl [outDir]');
  process.exit(1);
}

// app.ts writes an undefined value as '[undefined]'. Here it is undefined again; it prints as [undefined], an empty string prints as nothing.
const revive = (_key, value) => (value === '[undefined]' ? undefined : value);
const json = (value) => JSON.stringify(value, (_key, v) => (v === undefined ? '[undefined]' : v));
const records = readFileSync(logFile, 'utf8').split('\n').flatMap((line) => {
  try {
    const outer = JSON.parse(line);
    const record = typeof outer.message === 'string' ? JSON.parse(outer.message, revive) : JSON.parse(line, revive);
    return record.s2 || record.s3 || record.s4 || record.s6 ? [record] : [];
  } catch {
    return [];
  }
});
if (!records.length) {
  console.log(`no records in ${logFile}: is it the output of devvit logs --json?`);
  process.exit(0);
}

// Ids and names: each original gets one alias for the whole run, so that the fixtures and the tables agree. The match is by whole token and
// ignores case (Reddit names do). Not replaced: Reddit's own account names. Short ids (the part after t3_) are replaced inside paths too.
const KEEP = new Set(['AutoModerator', '[deleted]', 'reddit']);
const KIND = { t1: 'comment', t2: 'user', t3: 'post', t5: 'sub' };
const alias = new Map();
const count = {};
const give = (original, stem) => {
  if (original && !KEEP.has(original) && !alias.has(original.toLowerCase())) alias.set(original.toLowerCase(), `${stem}${(count[stem] = (count[stem] ?? 0) + 1)}`);
};
const walk = function* (value) {
  if (value && typeof value === 'object') {
    yield value;
    for (const v of Object.values(value)) yield* walk(v);
  }
};
for (const o of walk(records)) {
  for (const text of Object.values(o).filter((v) => typeof v === 'string')) {
    for (const [id, prefix, short] of text.matchAll(/(?<!\w)(t[1-5])_([a-z0-9]+)(?!\w)/g)) {
      if (alias.has(id)) continue;
      give(id, `${prefix}_${KIND[prefix]}`);
      if (prefix === 't1' || prefix === 't3') alias.set(short, alias.get(id).slice(3)); // post1 for t3_post1
    }
  }
}
for (const o of walk(records)) {
  if (/^t2_/.test(o.id) && typeof o.name === 'string') give(o.name, 'name');
  if (/^t5_/.test(o.id) && typeof o.name === 'string') give(o.name, 'subname');
  for (const key of ['author', 'authorName', 'removedBy', 'username']) if (typeof o[key] === 'string') give(o[key], 'name');
  for (const key of ['subreddit', 'subredditName']) if (typeof o[key] === 'string') give(o[key], 'subname');
}
const names = new RegExp(`(?<![\\w-])(?:${[...alias.keys()].sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`, 'gi');
const anon = (value) =>
  typeof value === 'string' ? (alias.size ? value.replace(names, (m) => alias.get(m.toLowerCase())) : value)
  : Array.isArray(value) ? value.map(anon)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, anon(v)]))
  : value;
const data = anon(records);

// Fixtures: the body of each trigger. A type without a builder in test/sim/events.ts goes to a subfolder, so that the fidelity hook of
// test/sim/events.test.ts (it reads the top folder only) does not fail on it. Move a file up when the simulator gets its builder.
const BUILDERS = new Set(['PostSubmit', 'PostFlairUpdate', 'PostDelete', 'CommentCreate']);
const trigger = (r) => /^on[A-Z]/.test(r.s3 ?? '') && r.body;
const number = {};
const written = { [outDir]: 0, [join(outDir, 'unmodeled')]: 0 };
for (const r of data.filter(trigger)) {
  const dir = BUILDERS.has(r.body.type) ? outDir : join(outDir, 'unmodeled');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${r.s3}-${(number[r.s3] = (number[r.s3] ?? 0) + 1)}.json`), `${JSON.stringify(r.body, null, 2)}\n`);
  written[dir]++;
}
for (const [dir, n] of Object.entries(written)) if (n) console.log(`wrote ${n} fixtures to ${dir}${dir === outDir ? '' : ' (test/sim/events.test.ts has no builder for these types)'}`);

// Tables. A case is the title of the post (the README gives each post a title that names its case), else its id.
const titles = new Map();
for (const r of data) for (const p of [r, r.body?.post, r.body?.targetPost, r.parent?.ok]) if (p?.id && p.title) titles.set(p.id, p.title);
const label = (id) => titles.get(id) ?? id;
const cell = (v) => (v === undefined ? '[undefined]' : v !== null && typeof v === 'object' ? json(v) : String(v));
const row = (...cells) => `| ${cells.map(cell).join(' | ')} |`;
const table = (title, head, rows) => console.log(`\n## ${title}\n${row(...head)}\n${row(...head.map(() => '---'))}\n${rows.join('\n')}`);

const lookups = data.filter((r) => r.s2 === 'post');
table('S2 states, f (one row for each post lookup; via is the trigger or menu that caused it)', ['case', 'via', 'removed', 'spam', 'approved', 'removedBy', 'removedByCategory'],
  lookups.map((r) => (r.error ? row(label(r.id), r.via, `error: ${r.error}`) : row(label(r.id), r.via, r.removed, r.spam, r.approved, r.removedBy, r.removedByCategory))));

// Images under 5.2: the rule of src/core/post.ts, from the logged post (a crosspost: from its parent).
const IMAGE_POST_URL = /^https?:\/\/(?:(?:i|preview)\.redd\.it\/|(?:www\.)?reddit\.com\/gallery\/)/;
const images = (p) => {
  const source = p.crosspostParentId ? p.parent?.ok : p;
  return source && IMAGE_POST_URL.test(source.url) ? source.gallery.filter((g) => g.normalized && g.status === 1 && g.width > 0 && g.height > 0).length : 0;
};
const sizeInTitle = (p) => {
  const [, w, h] = /(\d+)x(\d+)/.exec(p.title ?? '') ?? [];
  return w && p.gallery.length ? (p.gallery.every((g) => g.width === +w && g.height === +h) ? 'ok' : 'DIFF') : '-';
};
const firstLookup = new Map();
for (const r of lookups) if (!r.error && !firstLookup.has(r.id)) firstLookup.set(r.id, r);
table('S2 images, a to d (a: size against the title; b: a crosspost counts its parent; c: 0 for a link or video; d: the URL and its rule)',
  ['case', 'post.url', 'gallery (WxH/status)', 'size as in title', 'normalized', 'images under 5.2', 'crosspostParentId'],
  [...firstLookup.values()].map((p) =>
    row(label(p.id), p.url, p.gallery.map((g) => `${g.width}x${g.height}/${g.status}`).join(' ') || '(none)', sizeInTitle(p), p.gallery.map((g) => g.normalized ?? 'null').join(' ') || '(none)', images(p), p.crosspostParentId)));

// Events of each post in time order. The time is in seconds after the first event of the post; delay = the time of the trigger minus post.createdAt.
const idOf = (body) => body.post?.id ?? body.postId ?? body.targetPost?.id;
const ms = (time) => (time < 1e11 ? time * 1000 : time); // seconds or milliseconds
const perPost = new Map();
for (const r of data.filter((r) => trigger(r) && idOf(r.body)).sort((a, b) => a.at - b.at)) perPost.set(idOf(r.body), [...(perPost.get(idOf(r.body)) ?? []), r]);
const describeEvent = (r, start) => {
  const detail = r.s3 === 'onModAction' ? `:${r.body.action}` : r.s3 === 'onPostDelete' ? ` source=${r.body.source}` : '';
  const created = r.body.post?.createdAt;
  const delay = r.s3 === 'onPostSubmit' && typeof created === 'number' ? ` (delay ${((r.at - ms(created)) / 1000).toFixed(1)}s)` : '';
  return `${r.s3}${detail} +${((r.at - start.at) / 1000).toFixed(1)}s${delay}`;
};
table('S2 events, e g i j (e: PostSubmit for a filtered post; g: what a removal or a filter sends; i: the delay; j: a post from before the install)', ['case', 'events'],
  [...perPost].map(([id, list]) => row(label(id), list.map((r) => describeEvent(r, list[0])).join(', ') + (list.some((r) => r.s3 === 'onPostSubmit') ? '' : ' [no onPostSubmit]'))));

console.log('\n## S2 listings, h (the 25 newest posts and the mod queue, as the app saw them)');
for (const [i, r] of data.filter((r) => r.s2 === 'listings').entries()) {
  for (const list of ['new', 'modQueue']) {
    const shown = r[list].ok?.map((p) => `${label(p.id)} (removed=${cell(p.removed)} spam=${cell(p.spam)} category=${cell(p.removedByCategory)})`).join('; ');
    console.log(`dump ${i + 1} ${list}: ${r[list].ok ? shown || '(empty)' : `error: ${r[list].error}`}`);
  }
}

console.log('\n## S3 checks (the keys and types of each body are checked by the fidelity hook of test/sim/events.test.ts)');
const first = (type) => data.find((r) => r.body?.type === type)?.body;
const show = (v) => (v === undefined ? 'missing' : `${typeof v} ${json(v)}`);
const CHECKS = [
  ['PostSubmit', 'post.createdAt'], ['CommentCreate', 'comment.createdAt'], ['PostSubmit', 'post.crowdControlLevel'], ['PostSubmit', 'post.distinguished'],
  ['PostSubmit', 'subreddit.type'], ['PostSubmit', 'subreddit.rating'], ['PostSubmit', 'author.accountType'],
  ['PostDelete', 'deletedAt'], ['PostDelete', 'createdAt'], ['PostDelete', 'source'], ['PostDelete', 'reason'],
];
for (const [type, path] of CHECKS) {
  const value = path.split('.').reduce((o, key) => o?.[key], first(type));
  console.log(`- ${type} ${path}: ${show(value)}${typeof value === 'number' && path.endsWith('createdAt') ? (value < 1e11 ? ' (s)' : ' (ms)') : ''}`);
}
for (const r of data.filter((r) => r.body?.type === 'CommentCreate')) console.log(`- CommentCreate by ${r.body.comment?.author}: author.accountType ${show(r.body.author?.accountType)}`);
const sent = [...new Set(data.filter(trigger).flatMap((r) => Object.keys(r.headers ?? {})))].sort();
const USER_HEADER = /^devvit-user(-name|-snoovatar-url)?$/; // the three that set userId, username and snoovatar of the context (not devvit-user-agent)
console.log(`- headers on triggers: ${sent.join(', ') || 'none'}; user headers: ${sent.filter((name) => USER_HEADER.test(name)).join(', ') || 'none'}`);
const probes = data.filter((r) => r.s3 === 'probe');
for (const [i, r] of probes.entries()) for (const key of ['redisNx', 'settings', 'appUser']) console.log(`- probe${probes.length > 1 ? ` ${i + 1}` : ''} ${key}: ${json(r[key])}`);
for (const r of data.filter((r) => r.s6)) console.log(`- fetch probe ${label(r.id)}: ${r.from ? `${r.from} ${r.width}x${r.height} ` : ''}${json(r.ok ?? (r.error ? { error: r.error } : { skipped: r.skipped }))}`);

// S4 lines hold only times, sizes and errors: print them as they are.
const limits = data.filter((r) => r.s4);
if (limits.length) console.log(`\n## S4 (times in ms)\n${limits.map(({ at, ...r }) => `- ${json(r)}`).join('\n')}`);
