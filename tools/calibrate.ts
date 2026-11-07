/**
 * Similarity calibration of the repost cascade (plan 2 S9, 7.4 and AC17). Run: npx tsx tools/calibrate.ts --help
 *
 * It reads labeled image pairs, runs the real cascade of src/core/image on each pair, and prints the S9 numbers at the default
 * settings and over a small grid. The exit code says whether the AC17 numbers are met, so a release can wait for it.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NUMBER_SETTINGS } from '../src/core/config';
import { decodeGray } from '../src/core/image/decode';
import { type Gray, prepare, type QueryVariant, type Signature, signature, thumbnail, transform, type Variant, variants as queryVariants } from '../src/core/image/features';
import { align, type Candidate, decide, type Decision, type GateHit, gate, type MatchSettings, tileCheck, type Tiles } from '../src/core/image/match';

// The decoder's own cap (src/core/image/decode.ts). A larger file is left out before it is read, and the download command in --help stops at it.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// The label files hold URLs from outside, so the download command in --help keeps only https URLs of the Reddit image hosts.
const DOWNLOAD_FILTER = '^https://(i|preview)\\.redd\\.it/';

const HELP = `Similarity calibration of the AWB3 repost cascade (plan S9, 7.4 and AC17).

Usage: npx tsx tools/calibrate.ts [DIR] [--json] [--allow-shortfall]

DIR is the calibration folder. Default: test/fixtures/private (it is gitignored, because it holds real data).
The tool reads labeled image pairs from DIR. For each pair it runs the real cascade of src/core/image: the gate over all images
of the folder (the 50 nearest), then aligned NCC, the 8x8 tile check and the decision. It does this at the default settings and for
a grid of 243 settings (gate, ncc, minTiles, reportAt and removeAt: the default and one step each way). It prints, per subreddit
and in total: set sizes with the shortfall against the S9 minimums, precision at removeAt and at reportAt, recall on set (a), the
share of same-background (OD8) pairs that are flagged, top-50 recall with and without the 90/270 degree rotation variants, recall
on the desktop/phone pairs, and the recall loss of the re-fetch path.

Options
  --json             Print one JSON report (all numbers, all pairs and the grid) on stdout, not text.
  --allow-shortfall  Do not fail on a set that is smaller than its S9 minimum, or on the same-background number when there are no
                     OD8 pairs (OD8 = (b)). The shortfall is still printed. A number that is not met still fails.
  -h, --help         Print this text.

Exit code
  0  every AC17 number is met at the default settings
  1  not met: a number fails, or data is short and --allow-shortfall is not given
  2  bad arguments, a missing folder, no pairs, or a bad label or manifest file
Progress goes to stderr. A run decodes every image again. Measured: about 0.8 s for a 4K JPEG, and about 0.02 s for each pair.

Folder layout
  DIR/images/<name>
      One file per image: JPEG or PNG. The tool leaves out WebP, files over 16 megapixels and files over 20 MiB (the app has the same
      limits). <name> is the last part of the image URL: https://i.redd.it/abc123.jpg is images/abc123.jpg.
      To download the images of the label files, run this in the repository root. The label files hold URLs from outside. So grep keeps
      only https URLs of i.redd.it and preview.redd.it, curl takes only https, curl follows no redirect (a redirect could leave
      these hosts), and curl stops at 20 MiB:
        DIR=test/fixtures/private; mkdir -p "$DIR/images"
        jq -r '.[] | .imageUrl, .matchedImageUrl' "$DIR"/legacy-repost-labels-*.json | grep -E '${DOWNLOAD_FILTER}' | sort -u |
          tr '\\n' '\\0' |
          xargs -0 -n1 -P4 curl --proto '=https' --max-filesize ${MAX_IMAGE_BYTES} --fail --silent --show-error --remote-name --output-dir "$DIR/images"
      Download the images of the manifest with the same grep and the same curl options.
  DIR/legacy-repost-labels-<sub>.json
      The files that tools/capture_fixtures.py writes. All of them are read. A record has "subreddit", "imageUrl" (the new image),
      "matchedImageUrl" (the older image), "age" (the legacy age text, for example "2 months ago") and "outcome":
        "kept"      the post is still removed: a positive, set (a)
        "reversed"  a mod approved the post: a hard negative, set (b)
        "unknown"   not used
      The other keys of a record are not read.
  DIR/calibration-pairs.jsonl   (optional)
      The manifest. One JSON object per line. Empty lines and lines that start with # are ignored. Keys:
        "kind"       od8      a same-background complaint pair (OD8): not a repost, part of set (b)
                     random   two unrelated images: not a repost, set (c)
                     phone    the same picture as a desktop image and as a phone image: a repost, set (e)
                     kept, reversed   as in the label files (use them if you have no label file)
        "subreddit"  the subreddit name
        "query"      the new image: a name in images/ (a URL also works: its last part is the name)
        "candidate"  the older image, the same way
        "source"     optional: where the label came from, for example "OD8 message of 2026-11-12"
        "age"        optional: the legacy age text. "N months ago" marks the older image as more than 30 days older (set (f)).
      Example:
        {"kind":"od8","subreddit":"Animewallpaper","query":"abc123.jpg","candidate":"def456.jpg","source":"OD8 message"}
      A kept or reversed pair is dropped when an od8 line names the same two images: the OD8 list wins (S9 set (a)).

What the numbers mean (at the settings of the row)
  A pair is "flagged" when the 50 nearest gate hits of the new image hold the older image, and stages 2 and 3 give a match: NCC and
  the share of matching tiles pass, and the similarity is at least reportAt. It is "removed" when the similarity is at least
  removeAt. Only the older image of the pair is compared (not the other 49 hits), so a flag against another image of the folder is
  not counted. The images of all pairs, in both roles and from both subreddits, are the candidate pool of the gate.
  precision at removeAt   removed positives (set (a)) / (removed positives + removed negatives). Negatives are sets (b) and (c).
  precision at reportAt   the same, with flags.
  recall on set (a)       flagged positives / positives.
  same-background pairs   flagged OD8 pairs / OD8 pairs.
  top-50 recall           positives whose older image is among the 50 nearest, at a gate distance of at most the gate setting.
  re-fetch loss           flagged positives whose older image is more than 30 days older (the age text is in months) and is not among
                          the 5 nearest gate hits, divided by the positives. Every other image of the folder counts as old, so this
                          is an upper limit.
  AC17 limits: precision at removeAt >= 0.97; precision at reportAt >= 0.85; recall >= 0.85; same-background <= 0.10; top-50 recall
  > 0.99; re-fetch loss <= 0.03; sizes: (a) >= 200, (b) >= 200 of which OD8 >= 20, (c) >= 1,000. The minimum of 30 per subreddit
  (sets (a), (b), (c)) and the 30 of set (e) are printed as shortfalls only.
`;

// ---- constants of the plan ----

const TOP = 50; // plan 5.4 step 4: the 50 nearest gate hits go to stage 2
const REFETCH_TOP = 5; // plan 5.4: a candidate without a thumbnail (older than 30 days) is fetched again only when it is among the 5 nearest
const PER_SUBREDDIT_MIN = 30;

// The install defaults (plan 5.6) come from the config, so that this tool and the app cannot differ.
const DEFAULTS: MatchSettings = {
  gate: NUMBER_SETTINGS.repostGate.def,
  ncc: NUMBER_SETTINGS.repostNcc.def,
  minTiles: NUMBER_SETTINGS.repostMinTiles.def,
  reportAt: NUMBER_SETTINGS.repostReportAt.def,
  removeAt: NUMBER_SETTINGS.repostRemoveAt.def,
};

const around = (value: number, step: number) => [value - step, value, value + step].map((v) => Number(v.toFixed(4)));
const GRID: MatchSettings[] = around(DEFAULTS.gate, 4).flatMap((gate) =>
  around(DEFAULTS.ncc, 0.05).flatMap((ncc) =>
    around(DEFAULTS.minTiles, 5).flatMap((minTiles) =>
      around(DEFAULTS.reportAt, 2).flatMap((reportAt) => around(DEFAULTS.removeAt, 2).map((removeAt) => ({ gate, ncc, minTiles, reportAt, removeAt }))),
    ),
  ),
).filter((s) => s.removeAt >= s.reportAt); // the config rejects a removeAt below reportAt
const WIDEST_GATE = Math.max(...GRID.map((s) => s.gate));

// ---- pairs ----

/** `kept`, `reversed`: legacy label outcomes (sets a and b). `od8`: complaint pairs (part of b). `random`: set c. `phone`: set e. */
export type Kind = 'kept' | 'reversed' | 'od8' | 'random' | 'phone';
const KINDS: Kind[] = ['kept', 'reversed', 'od8', 'random', 'phone'];

export interface Pair {
  kind: Kind;
  /** Where the label came from: `<label file>:<record number>`, or the "source" of the manifest line. */
  source: string;
  /** Lower case. */
  subreddit: string;
  /** The new image and the older image: file names in images/. */
  query: string;
  candidate: string;
  /** The legacy age text of the match ("2 months ago"). Only set (f) reads it. */
  age?: string;
}

/** A problem of the input files. The command line prints it and exits with 2. */
class InputError extends Error {}

const MANIFEST = 'calibration-pairs.jsonl';
const imageName = (ref: string) => ref.split('?')[0]!.split('/').pop()!;

function text(record: unknown, key: string, at: string): string {
  const value = (record as Record<string, unknown> | null)?.[key];
  if (typeof value !== 'string' || value === '') throw new InputError(`${at}: "${key}" must be a text`);
  return value;
}
const optionalText = (record: unknown, key: string) => {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
};

/** The labeled pairs of a folder: the label files of tools/capture_fixtures.py, then the manifest. `skipped` counts what is left out, and why. */
export function readPairs(dir: string): { pairs: Pair[]; skipped: Record<string, number> } {
  const skipped: Record<string, number> = {};
  const skip = (why: string) => void (skipped[why] = (skipped[why] ?? 0) + 1);
  const all: Pair[] = [];
  for (const file of readdirSync(dir).filter((f) => /^legacy-repost-labels-.+\.json$/.test(f)).sort()) {
    let records: unknown;
    try {
      records = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch {
      throw new InputError(`${file}: not valid JSON`);
    }
    if (!Array.isArray(records)) throw new InputError(`${file}: expected a JSON array of label records`);
    records.forEach((record, i) => {
      const at = `${file} record ${i + 1}`;
      const outcome = text(record, 'outcome', at);
      if (outcome === 'unknown') return skip('outcome unknown');
      if (outcome !== 'kept' && outcome !== 'reversed') throw new InputError(`${at}: outcome must be kept, reversed or unknown`);
      all.push({
        kind: outcome,
        source: `${file}:${i + 1}`,
        subreddit: text(record, 'subreddit', at).toLowerCase(),
        query: imageName(text(record, 'imageUrl', at)),
        candidate: imageName(text(record, 'matchedImageUrl', at)),
        age: optionalText(record, 'age'),
      });
    });
  }
  if (existsSync(join(dir, MANIFEST))) {
    readFileSync(join(dir, MANIFEST), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (line.trim() === '' || line.startsWith('#')) return;
        const at = `${MANIFEST} line ${i + 1}`;
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          throw new InputError(`${at}: not valid JSON`);
        }
        const kind = text(record, 'kind', at) as Kind;
        if (!KINDS.includes(kind)) throw new InputError(`${at}: "kind" must be one of ${KINDS.join(', ')}`);
        all.push({
          kind,
          source: optionalText(record, 'source') ?? `${MANIFEST}:${i + 1}`,
          subreddit: text(record, 'subreddit', at).toLowerCase(),
          query: imageName(text(record, 'query', at)),
          candidate: imageName(text(record, 'candidate', at)),
          age: optionalText(record, 'age'),
        });
      });
  }
  const unordered = (p: Pair) => [p.query, p.candidate].sort().join('/');
  const od8 = new Set(all.filter((p) => p.kind === 'od8').map(unordered));
  const pairs: Pair[] = [];
  for (const p of all) {
    if (p.query === p.candidate) skip('same image on both sides');
    else if ((p.kind === 'kept' || p.kind === 'reversed') && od8.has(unordered(p))) skip('in the OD8 list');
    else pairs.push(p);
  }
  return { pairs, skipped };
}

// ---- outcomes and metrics ----

export interface Outcome {
  pair: Pair;
  /**
   * The older image of the pair, when it is among the 50 nearest gate hits of the new image at the widest gate of the grid: its
   * gate distance, its place among the hits (0 = nearest), and the NCC and tiles of stages 2 and 3. Undefined: not found.
   */
  hit?: { distance: number; rank: number; ncc: number; tiles: Tiles };
  /** Its gate distance when the 90 and 270 degree variants are left out of the query (undefined: not among the 50 nearest). */
  distanceNoRotation?: number;
}

/** k of n; no value when n is 0. */
export interface Ratio {
  k: number;
  n: number;
  value: number | null;
}
const ratio = (k: number, n: number): Ratio => ({ k, n, value: n === 0 ? null : k / n });

export interface Metrics {
  /** Pairs per kind. */
  n: Record<Kind, number>;
  /** Removed positives (set a) of all removed pairs, positives and negatives (sets b and c). */
  precisionRemove: Ratio;
  /** The same for flagged pairs (report or removal). */
  precisionReport: Ratio;
  /** Flagged positives of set (a). */
  recall: Ratio;
  /** Removed positives of set (a). */
  recallRemove: Ratio;
  /** OD8 pairs that are flagged. */
  sameBackground: Ratio;
  /** Positives whose older image is among the 50 nearest, with all gate variants and without the rotation variants. */
  top50: Ratio;
  top50NoRotation: Ratio;
  /** Set (e): flagged pairs. */
  phoneRecall: Ratio;
  /** Flagged positives that the re-fetch path would lose (set f), of all positives. */
  refetchLoss: Ratio;
  /** Positives whose older image is more than 30 days older (set f). */
  old: number;
}

const actionOf = (o: Outcome, s: MatchSettings): Decision['action'] =>
  o.hit && o.hit.distance <= s.gate ? decide(o.hit.ncc, o.hit.tiles, s).action : 'none';

// shortcut: the age text is in months ("1 month ago" can be 29 days), so the 30-day limit is read as "a month or more". Use dates if the labels get them.
const isOld = (o: Outcome) => /\bmonths?\b/.test(o.pair.age ?? '');

/** The S9 rates for one list of outcomes at one setting. */
export function summarize(outcomes: Outcome[], s: MatchSettings): Metrics {
  const rows = outcomes.map((o) => ({ o, action: actionOf(o, s) }));
  const of = (...kinds: Kind[]) => rows.filter((r) => kinds.includes(r.o.pair.kind));
  const flagged = (rs: typeof rows) => rs.filter((r) => r.action !== 'none').length;
  const removed = (rs: typeof rows) => rs.filter((r) => r.action === 'remove').length;
  const near = (rs: typeof rows, distance: (o: Outcome) => number | undefined) => rs.filter((r) => (distance(r.o) ?? Infinity) <= s.gate).length;
  const positives = of('kept'); // set (e) is a positive too, but it only has its own recall
  const negatives = of('reversed', 'od8', 'random');
  const od8 = of('od8');
  const phone = of('phone');
  const lost = positives.filter((r) => r.action !== 'none' && isOld(r.o) && r.o.hit!.rank >= REFETCH_TOP).length;
  return {
    n: Object.fromEntries(KINDS.map((k) => [k, of(k).length])) as Record<Kind, number>,
    precisionRemove: ratio(removed(positives), removed(positives) + removed(negatives)),
    precisionReport: ratio(flagged(positives), flagged(positives) + flagged(negatives)),
    recall: ratio(flagged(positives), positives.length),
    recallRemove: ratio(removed(positives), positives.length),
    sameBackground: ratio(flagged(od8), od8.length),
    top50: ratio(near(positives, (o) => o.hit?.distance), positives.length),
    top50NoRotation: ratio(near(positives, (o) => o.distanceNoRotation), positives.length),
    phoneRecall: ratio(flagged(phone), phone.length),
    refetchLoss: ratio(lost, positives.length),
    old: positives.filter((r) => isOld(r.o)).length,
  };
}

// ---- the AC17 limits and the S9 set sizes ----

export interface Check {
  id: string;
  name: string;
  value: number | null;
  rule: string;
  detail: string;
  /** `short`: not enough data to judge. `--allow-shortfall` excuses it; `fail` is never excused. */
  status: 'pass' | 'fail' | 'short';
}

// `noData`: the status of a limit that has nothing to measure. A precision with no flags has no false flag, so it passes.
const LIMITS = [
  { id: 'precisionRemove', name: 'precision at removeAt', rule: '>= 0.97', get: (m: Metrics) => m.precisionRemove, met: (v: number) => v >= 0.97, noData: 'pass' },
  { id: 'precisionReport', name: 'precision at reportAt', rule: '>= 0.85', get: (m: Metrics) => m.precisionReport, met: (v: number) => v >= 0.85, noData: 'pass' },
  { id: 'recall', name: 'recall on set (a)', rule: '>= 0.85', get: (m: Metrics) => m.recall, met: (v: number) => v >= 0.85, noData: 'fail' },
  { id: 'sameBackground', name: 'same-background pairs flagged', rule: '<= 0.10', get: (m: Metrics) => m.sameBackground, met: (v: number) => v <= 0.1, noData: 'short' },
  { id: 'top50', name: 'top-50 recall on set (a)', rule: '> 0.99', get: (m: Metrics) => m.top50, met: (v: number) => v > 0.99, noData: 'fail' },
  { id: 'refetchLoss', name: 'recall loss of the re-fetch path', rule: '<= 0.03', get: (m: Metrics) => m.refetchLoss, met: (v: number) => v <= 0.03, noData: 'fail' },
] as const;

type Counts = Metrics['n'];
const SETS = [
  { id: 'a', check: 'sizeA', name: 'set (a) size', label: '(a) positives (legacy kept)', min: 200, count: (n: Counts) => n.kept },
  { id: 'b', check: 'sizeB', name: 'set (b) size', label: '(b) hard negatives (legacy reversed + OD8)', min: 200, count: (n: Counts) => n.reversed + n.od8 },
  { id: 'od8', check: 'sizeOd8', name: 'OD8 pairs', label: '    of which OD8 pairs', min: 20, count: (n: Counts) => n.od8 },
  { id: 'c', check: 'sizeC', name: 'set (c) size', label: '(c) random pairs', min: 1000, count: (n: Counts) => n.random },
  { id: 'e', check: undefined, name: 'set (e) size', label: '(e) desktop/phone pairs (if found)', min: 30, count: (n: Counts) => n.phone },
] as const;

const numericChecks = (m: Metrics): Check[] =>
  LIMITS.map(({ id, name, rule, get, met, noData }) => {
    const r = get(m);
    const status = r.value === null ? noData : met(r.value) ? 'pass' : 'fail';
    return { id, name, value: r.value, rule, detail: r.value === null ? 'no data' : `${r.k} of ${r.n}`, status };
  });

/** The AC17 numbers and the S9 set sizes against their limits. `ok`: every one passes, or is `short` and excused. */
export function judge(total: Metrics, allowShortfall: boolean): { checks: Check[]; ok: boolean } {
  const sizeChecks = SETS.flatMap(({ check, name, min, count }) => {
    const n = count(total.n);
    return check ? [{ id: check, name, value: n, rule: `>= ${min}`, detail: n < min ? `short by ${min - n}` : '', status: n < min ? 'short' : 'pass' } as Check] : [];
  });
  const checks = [...numericChecks(total), ...sizeChecks];
  return { checks, ok: checks.every((c) => c.status === 'pass' || (c.status === 'short' && allowShortfall)) };
}

// ---- the cascade over a folder ----

export interface Size {
  id: string;
  label: string;
  n: number;
  min: number;
  short: number;
}

export interface PairResult {
  kind: Kind;
  source: string;
  subreddit: string;
  query: string;
  candidate: string;
  /** Null when the older image is not among the 50 nearest at the widest gate of the grid. */
  distance: number | null;
  rank: number | null;
  ncc: number | null;
  changedTiles: number | null;
  largestBlock: number | null;
  similarity: number | null;
  action: Decision['action'];
}

export interface GridRow {
  settings: MatchSettings;
  /** The six numbers of the AC17 limits, by check id. */
  values: Record<string, number | null>;
  /** How many of the six are not met. */
  failing: number;
}

export interface Report {
  dir: string;
  settings: MatchSettings;
  allowShortfall: boolean;
  /** Pairs that were left out, by reason. */
  skipped: Record<string, number>;
  /** Files and pairs that could not be used. */
  problems: string[];
  sizes: Size[];
  /** Subreddits under 30 pairs in set (a), (b) or (c). */
  shortfalls: { subreddit: string; set: 'a' | 'b' | 'c'; n: number; short: number }[];
  total: Metrics;
  subreddits: Record<string, Metrics>;
  checks: Check[];
  ok: boolean;
  grid: GridRow[];
  pairs: PairResult[];
}

interface Loaded {
  sig: Signature;
  thumb: Gray;
  /** Only for an image that is the new image of a pair. */
  variants?: QueryVariant[];
}

/** Stages 2 and 3 of `compare`, kept apart from `decide`, so that one alignment serves every setting of the grid. */
function stages(query: Gray, candidate: Gray, variant: Variant): { ncc: number; tiles: Tiles } {
  const aligned = align(transform(query, variant), candidate);
  return aligned ? { ncc: aligned.ncc, tiles: tileCheck(aligned.a, aligned.b) } : { ncc: 0, tiles: { changed: 64, block: 64 } }; // 64 = 8x8 tiles, as compare()
}

export function calibrate(dir: string, opts: { allowShortfall?: boolean; log?: (line: string) => void } = {}): Report {
  const log = opts.log ?? (() => {});
  const allowShortfall = opts.allowShortfall ?? false;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new InputError(`folder not found: ${dir}`);
  const { pairs: labeled, skipped } = readPairs(dir);
  if (labeled.length === 0) throw new InputError(`no label pairs in ${dir}: it needs legacy-repost-labels-<sub>.json files or ${MANIFEST} (see --help)`);
  const skip = (why: string) => void (skipped[why] = (skipped[why] ?? 0) + 1);
  const problems: string[] = [];

  // Every image once: gray, bars trimmed, hashes, thumbnail. A new image also gets its gate variants.
  const asQuery = new Set(labeled.map((p) => p.query));
  const names = [...new Set(labeled.flatMap((p) => [p.query, p.candidate]))];
  const images = new Map<string, Loaded>();
  const bad = new Map<string, string>(); // file name -> the reason that counts the pairs that need it
  names.forEach((name, i) => {
    if (i % 100 === 0) log(`reading images: ${i} of ${names.length}`);
    try {
      const file = join(dir, 'images', name);
      const info = statSync(file);
      if (!info.isFile()) throw new Error('not a regular file');
      if (info.size > MAX_IMAGE_BYTES) {
        bad.set(name, 'image file too large');
        problems.push(`image file too large: images/${name} (${info.size} bytes, the limit is ${MAX_IMAGE_BYTES})`);
        return;
      }
      const gray = prepare(decodeGray(new Uint8Array(readFileSync(file))));
      const variants = asQuery.has(name) ? queryVariants(gray) : undefined;
      images.set(name, { sig: variants ? variants[0]!.sig : signature(gray), thumb: thumbnail(gray), variants });
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
      bad.set(name, missing ? 'image file missing' : 'image unreadable');
      problems.push(missing ? `image file missing: images/${name}` : `image unreadable: images/${name} (${(e as Error).message})`);
    }
  });
  const pairs = labeled.filter((p) => {
    const why = bad.get(p.query) ?? bad.get(p.candidate);
    if (why) skip(why);
    return !why;
  });

  // The gate runs once for each new image over all other images, at the widest gate; a narrower gate keeps the first hits of the list.
  const pool: Candidate[] = [...images].map(([id, image]) => ({ id, sig: image.sig }));
  const memo = { rotations: new Map<string, GateHit[]>(), flat: new Map<string, GateHit[]>() };
  const nearest = (name: string, rotations: boolean) => {
    const cache = rotations ? memo.rotations : memo.flat;
    if (!cache.has(name)) {
      const query = images.get(name)!.variants!.filter((v) => rotations || !v.name.startsWith('rot'));
      cache.set(name, gate(query, pool.filter((c) => c.id !== name), WIDEST_GATE, TOP));
    }
    return cache.get(name)!;
  };
  const outcomes: Outcome[] = [];
  pairs.forEach((pair, i) => {
    if (i % 100 === 0) log(`comparing pairs: ${i} of ${pairs.length}`);
    try {
      const hits = nearest(pair.query, true);
      const rank = hits.findIndex((h) => h.id === pair.candidate);
      const found = hits[rank];
      outcomes.push({
        pair,
        hit: found && { distance: found.distance, rank, ...stages(images.get(pair.query)!.thumb, images.get(pair.candidate)!.thumb, found.variant) },
        distanceNoRotation: nearest(pair.query, false).find((h) => h.id === pair.candidate)?.distance,
      });
    } catch (e) {
      skip('comparison failed');
      problems.push(`comparison failed: ${pair.query} against ${pair.candidate} (${(e as Error).message})`);
    }
  });

  const total = summarize(outcomes, DEFAULTS);
  const subNames = [...new Set(outcomes.map((o) => o.pair.subreddit))].sort();
  const subreddits = Object.fromEntries(subNames.map((s) => [s, summarize(outcomes.filter((o) => o.pair.subreddit === s), DEFAULTS)]));
  const { checks, ok } = judge(total, allowShortfall);
  return {
    dir,
    settings: DEFAULTS,
    allowShortfall,
    skipped,
    problems,
    sizes: SETS.map(({ id, label, min, count }) => ({ id, label, n: count(total.n), min, short: Math.max(0, min - count(total.n)) })),
    shortfalls: subNames.flatMap((subreddit) =>
      SETS.filter((s) => s.id === 'a' || s.id === 'b' || s.id === 'c').flatMap(({ id, count }) => {
        const n = count(subreddits[subreddit]!.n);
        return n < PER_SUBREDDIT_MIN ? [{ subreddit, set: id as 'a' | 'b' | 'c', n, short: PER_SUBREDDIT_MIN - n }] : [];
      }),
    ),
    total,
    subreddits,
    checks,
    ok,
    grid: GRID.map((settings) => {
      const numbers = numericChecks(summarize(outcomes, settings));
      return { settings, values: Object.fromEntries(numbers.map((c) => [c.id, c.value])), failing: numbers.filter((c) => c.status === 'fail').length };
    }),
    pairs: outcomes.map((o) => {
      const d = o.hit && decide(o.hit.ncc, o.hit.tiles, DEFAULTS);
      return {
        kind: o.pair.kind,
        source: o.pair.source,
        subreddit: o.pair.subreddit,
        query: o.pair.query,
        candidate: o.pair.candidate,
        distance: o.hit?.distance ?? null,
        rank: o.hit?.rank ?? null,
        ncc: d?.ncc ?? null,
        changedTiles: d?.changedTiles ?? null,
        largestBlock: d?.largestBlock ?? null,
        similarity: d?.similarity ?? null,
        action: actionOf(o, DEFAULTS),
      };
    }),
  };
}

// ---- text report ----

/** Columns with a space of 2 between them; `align` has one letter for each column: l (left) or r (right). */
function table(rows: string[][], align: string): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((row) => row[c]!.length)));
  return rows
    .map((row) => row.map((v, c) => (align[c] === 'l' ? v.padEnd(widths[c]!) : v.padStart(widths[c]!))).join('  ').trimEnd())
    .join('\n');
}

const fixed = (v: number | null) => (v === null ? 'n/a' : v.toFixed(3));
const cell = (r: Ratio) => (r.value === null ? 'n/a' : `${fixed(r.value)} (${r.k}/${r.n})`);

export function format(r: Report): string {
  const s = r.settings;
  const subs = Object.keys(r.subreddits);
  const used = Object.values(r.total.n).reduce((a, b) => a + b, 0);
  const skipped = Object.entries(r.skipped).map(([why, n]) => `${n} ${why}`);
  const out: string[] = [
    'Similarity calibration (plan S9, AC17)',
    `Folder: ${r.dir}`,
    `Default settings: gate ${s.gate}, ncc ${s.ncc}, minTiles ${s.minTiles}, reportAt ${s.reportAt}, removeAt ${s.removeAt}`,
    `Pairs used: ${used}.${skipped.length ? ` Pairs left out: ${skipped.join(', ')}.` : ''}`,
  ];
  if (r.problems.length) {
    out.push(...r.problems.slice(0, 5).map((p) => `  ${p}`));
    if (r.problems.length > 5) out.push(`  ... and ${r.problems.length - 5} more problems (see --json)`);
  }

  out.push('', 'SET SIZES (S9 minimum and shortfall)');
  out.push(
    table(
      [
        ['set', 'total', 'minimum', 'shortfall', ...subs],
        ...r.sizes.map((z) => [z.label, String(z.n), String(z.min), String(z.short), ...subs.map((sub) => String(SETS.find((x) => x.id === z.id)!.count(r.subreddits[sub]!.n)))]),
      ],
      `lrrr${'r'.repeat(subs.length)}`,
    ),
  );
  const short = new Map<string, string[]>();
  for (const z of r.shortfalls) short.set(z.subreddit, [...(short.get(z.subreddit) ?? []), `(${z.set}) has ${z.n}, short by ${z.short}`]);
  if (short.size) out.push(`Under ${PER_SUBREDDIT_MIN} pairs in a subreddit (recorded, not a check):`);
  else if (subs.length) out.push(`Every subreddit has at least ${PER_SUBREDDIT_MIN} pairs in sets (a), (b) and (c).`);
  for (const [sub, parts] of short) out.push(`  ${sub}: set ${parts.join('; set ')}`);

  const rows: [string, (m: Metrics) => string][] = [
    [`precision at removeAt (${s.removeAt})`, (m) => cell(m.precisionRemove)],
    [`precision at reportAt (${s.reportAt})`, (m) => cell(m.precisionReport)],
    ['recall on set (a): flagged', (m) => cell(m.recall)],
    ['recall on set (a): removed', (m) => cell(m.recallRemove)],
    ['same-background pairs flagged (OD8)', (m) => cell(m.sameBackground)],
    ['top-50 recall, with rotation variants', (m) => cell(m.top50)],
    ['top-50 recall, without rotation variants', (m) => cell(m.top50NoRotation)],
    ['recall on set (e): desktop/phone pairs', (m) => cell(m.phoneRecall)],
    ['recall loss of the re-fetch path', (m) => cell(m.refetchLoss)],
  ];
  out.push('', 'RESULTS AT THE DEFAULT SETTINGS');
  out.push(table([['', 'total', ...subs], ...rows.map(([name, f]) => [name, f(r.total), ...subs.map((sub) => f(r.subreddits[sub]!))])], `l${'r'.repeat(subs.length + 1)}`));
  const [withRotations, without] = [r.total.top50, r.total.top50NoRotation];
  if (withRotations.value !== null && without.value !== null) {
    out.push(
      withRotations.value >= without.value
        ? 'S9 (g): the rotation variants do not lower top-50 recall: keep them.'
        : 'S9 (g): the rotation variants LOWER top-50 recall: take them out of the gate.',
    );
  }
  out.push(`S9 (f): ${r.total.old} of ${r.total.n.kept} positives have an original more than 30 days older (age text).`);

  out.push('', 'AC17 AT THE DEFAULT SETTINGS');
  const shown = (c: Check) => (c.id.startsWith('size') ? String(c.value) : fixed(c.value));
  out.push(table(r.checks.map((c) => [c.status.toUpperCase(), c.name, shown(c), c.rule, c.detail]), 'llrll'));

  const meeting = r.grid.filter((g) => g.failing === 0);
  const moved = (g: GridRow) => (Object.keys(s) as (keyof MatchSettings)[]).filter((key) => g.settings[key] !== s[key]).length; // settings that differ from the defaults
  const order = (a: GridRow, b: GridRow) =>
    a.failing - b.failing || (b.values.recall ?? 0) - (a.values.recall ?? 0) || (b.values.precisionReport ?? 0) - (a.values.precisionReport ?? 0) || moved(a) - moved(b);
  out.push('', `GRID (${r.grid.length} settings: gate, ncc, minTiles, reportAt, removeAt, the default and one step each way)`);
  out.push(meeting.length ? `${meeting.length} settings meet all six numbers. Best by recall:` : 'No setting meets all six numbers. Fewest failures:');
  for (const g of [...(meeting.length ? meeting : r.grid)].sort(order).slice(0, 5)) {
    const v = g.values;
    out.push(
      `  gate ${g.settings.gate}, ncc ${g.settings.ncc}, minTiles ${g.settings.minTiles}, reportAt ${g.settings.reportAt}, removeAt ${g.settings.removeAt}: ` +
        `precision ${fixed(v.precisionRemove ?? null)} / ${fixed(v.precisionReport ?? null)}, recall ${fixed(v.recall ?? null)}, same-background ${fixed(v.sameBackground ?? null)}, ` +
        `top-50 ${fixed(v.top50 ?? null)}, re-fetch loss ${fixed(v.refetchLoss ?? null)}, ${g.failing} not met`,
    );
  }

  const named = (cs: Check[]) => cs.map((c) => c.name).join(', ');
  const failed = r.checks.filter((c) => c.status === 'fail');
  const gaps = r.checks.filter((c) => c.status === 'short');
  out.push('');
  if (r.ok) out.push(gaps.length ? `RESULT: PASS (short, excused by --allow-shortfall: ${named(gaps)})` : 'RESULT: PASS');
  else {
    const why = [failed.length ? `not met: ${named(failed)}` : '', gaps.length && !r.allowShortfall ? `data short: ${named(gaps)} (--allow-shortfall excuses this)` : ''];
    out.push(`RESULT: FAIL (${why.filter(Boolean).join('; ')})`);
  }
  return out.join('\n');
}

// ---- command line ----

function main(argv: string[]): number {
  let dir = join(import.meta.dirname, '../test/fixtures/private');
  let given = false;
  let json = false;
  let allowShortfall = false;
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(HELP);
      return 0;
    }
    if (arg === '--json') json = true;
    else if (arg === '--allow-shortfall') allowShortfall = true;
    else if (arg.startsWith('-') || given) {
      process.stderr.write(`calibrate: unexpected argument "${arg}". Try --help.\n`);
      return 2;
    } else [dir, given] = [resolve(arg), true];
  }
  try {
    const report = calibrate(dir, { allowShortfall, log: (line) => process.stderr.write(`${line}\n`) });
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${format(report)}\n`);
    return report.ok ? 0 : 1;
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
    process.stderr.write(`calibrate: ${e.message}\n`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) process.exitCode = main(process.argv.slice(2));
