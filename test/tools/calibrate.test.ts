// Tests of tools/calibrate.ts (plan S9, AC17). Three groups: the metric math on outcomes that are built by hand, the AC17 limits, and
// the whole tool on the public fixtures (test/fixtures/images: T1-T6 and the edit set) arranged as a small labeled sample in a temp
// folder. Every expected number is computed by hand from the labels in this file, not by the tool.
import { execFile, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { decodeGray } from '../../src/core/image/decode';
import { prepare, signature, thumbnail, variants } from '../../src/core/image/features';
import { compare, gate } from '../../src/core/image/match';
import { calibrate, format, judge, type Kind, type Metrics, type Outcome, readPairs, type Report, summarize } from '../../tools/calibrate';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = join(root, 'test/fixtures/images');

// The folder cases decode real images and run the cascade: some seconds each.
vi.setConfig({ testTimeout: 120_000 });

// The plan's defaults (section 5.6), written here again on purpose: the tool must not change them by accident.
const defaults = { gate: 22, ncc: 0.8, minTiles: 85, reportAt: 94, removeAt: 98 };

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A calibration folder with the given text files and the given public fixtures (name, or [name in the folder, fixture]) in images/. */
function folder(files: Record<string, unknown>, images: (string | [string, string])[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'calibrate-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'images'));
  for (const image of images) {
    const [name, from] = typeof image === 'string' ? [image, image] : image;
    copyFileSync(join(fixtures, from), join(dir, 'images', name));
  }
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

/** One record of legacy-repost-labels-<sub>.json, with the keys that tools/capture_fixtures.py writes. */
const label = (subreddit: string, image: string, matched: string, outcome: string, age = '2 months ago') => ({
  subreddit,
  postId: 'p00001',
  createdUtc: 1_700_000_000,
  imageIndex: 1,
  imageUrl: `https://i.redd.it/${image}`,
  matchedPostId: 'p00002',
  matchedImageUrl: `https://i.redd.it/${matched}`,
  certainty: 87.65,
  age,
  outcome,
});

const manifest = (...records: object[]) => records.map((r) => JSON.stringify(r)).join('\n');

describe('readPairs: the label files of capture_fixtures.py and the manifest', () => {
  it('turns the outcome and the manifest kind into the S9 set, and keeps where each label came from', () => {
    const dir = folder({
      'legacy-repost-labels-animewallpaper.json': [
        label('Animewallpaper', 'new1.jpg', 'old1.jpg', 'kept'),
        label('Animewallpaper', 'new2.jpg', 'old2.jpg', 'reversed'),
        label('Animewallpaper', 'new3.jpg', 'old3.jpg', 'unknown'),
        label('Animewallpaper', 'new4.jpg', 'old4.jpg', 'kept', '3 days ago'), // the OD8 list names this pair too
      ],
      'calibration-pairs.jsonl': [
        '# OD8: complaints of the mods',
        manifest({ kind: 'od8', subreddit: 'Animewallpaper', query: 'old4.jpg', candidate: 'new4.jpg', source: 'OD8 message of 2026-11-12' }),
        '',
        manifest({ kind: 'random', subreddit: 'AnimePhoneWallpapers', query: 'r1.jpg', candidate: 'r2.jpg' }),
        manifest({ kind: 'phone', subreddit: 'AnimePhoneWallpapers', query: 'https://i.redd.it/ph.jpg?width=640', candidate: 'desk.png' }),
      ].join('\n'),
    });
    const { pairs, skipped } = readPairs(dir);
    expect(pairs.map((p) => [p.kind, p.subreddit, p.query, p.candidate, p.source, p.age])).toEqual([
      ['kept', 'animewallpaper', 'new1.jpg', 'old1.jpg', 'legacy-repost-labels-animewallpaper.json:1', '2 months ago'],
      ['reversed', 'animewallpaper', 'new2.jpg', 'old2.jpg', 'legacy-repost-labels-animewallpaper.json:2', '2 months ago'],
      ['od8', 'animewallpaper', 'old4.jpg', 'new4.jpg', 'OD8 message of 2026-11-12', undefined],
      ['random', 'animephonewallpapers', 'r1.jpg', 'r2.jpg', 'calibration-pairs.jsonl:4', undefined],
      ['phone', 'animephonewallpapers', 'ph.jpg', 'desk.png', 'calibration-pairs.jsonl:5', undefined],
    ]);
    expect(skipped).toEqual({ 'outcome unknown': 1, 'in the OD8 list': 1 });
  });

  it('reads every legacy-repost-labels file of the folder, in name order', () => {
    const dir = folder({
      'legacy-repost-labels-b.json': [label('B', 'b1.jpg', 'b0.jpg', 'kept')],
      'legacy-repost-labels-a.json': [label('A', 'a1.jpg', 'a0.jpg', 'kept')],
      'legacy-corpus-a.json': { subreddit: 'A', posts: [] }, // another file of the same tool: not read
    });
    expect(readPairs(dir).pairs.map((p) => p.subreddit)).toEqual(['a', 'b']);
  });

  it('stops with the file and the record number for a bad label record', () => {
    const dir = folder({ 'legacy-repost-labels-x.json': [label('X', 'a.jpg', 'b.jpg', 'kept'), { subreddit: 'X', outcome: 'kept' }] });
    expect(() => readPairs(dir)).toThrow('legacy-repost-labels-x.json record 2: "imageUrl" must be a text');
    const other = folder({ 'legacy-repost-labels-x.json': [label('X', 'a.jpg', 'b.jpg', 'maybe')] });
    expect(() => readPairs(other)).toThrow('legacy-repost-labels-x.json record 1: outcome must be kept, reversed or unknown');
  });

  it('stops with the line number for a bad manifest line', () => {
    const ok = manifest({ kind: 'od8', subreddit: 'x', query: 'a.jpg', candidate: 'b.jpg' });
    expect(() => readPairs(folder({ 'calibration-pairs.jsonl': `${ok}\n{not json` }))).toThrow('calibration-pairs.jsonl line 2: not valid JSON');
    const unknown = manifest({ kind: 'sky', subreddit: 'x', query: 'a.jpg', candidate: 'b.jpg' });
    expect(() => readPairs(folder({ 'calibration-pairs.jsonl': `${ok}\n${unknown}` }))).toThrow(
      'calibration-pairs.jsonl line 2: "kind" must be one of kept, reversed, od8, random, phone',
    );
  });

  it('drops a pair that has the same image on both sides', () => {
    const dir = folder({ 'legacy-repost-labels-x.json': [label('X', 'same.jpg', 'same.jpg', 'kept'), label('X', 'a.jpg', 'b.jpg', 'kept')] });
    const { pairs, skipped } = readPairs(dir);
    expect(pairs.map((p) => p.query)).toEqual(['a.jpg']);
    expect(skipped).toEqual({ 'same image on both sides': 1 });
  });
});

// ---- the metric math ----

// What the cascade found for the labeled candidate: its gate distance, its place among the gate hits (0 = nearest), the NCC and the
// tiles. Similarity = 100 - largest block / 64 * 100. At the default settings each shape means:
const hit = (distance: number, rank: number, ncc: number, changed: number, block: number) => ({ distance, rank, ncc, tiles: { changed, block } });
const REMOVE = hit(2, 0, 0.99, 0, 0); // similarity 100: remove
const REPORT = hit(8, 1, 0.9, 3, 3); // 95.3125: report, no removal
const BELOW = hit(12, 2, 0.85, 4, 4); // 93.75: under reportAt 94, so no match
// No shape: the candidate is not among the 50 nearest.

let serial = 0;
function outcome(kind: Kind, found?: Outcome['hit'], extra: { age?: string; noRotation?: number | null } = {}): Outcome {
  const id = serial++;
  return {
    pair: { kind, source: 'test', subreddit: 'x', query: `q${id}`, candidate: `c${id}`, age: extra.age },
    hit: found,
    // without the rotation variants the same distance, unless the test says that only a rotation found it
    distanceNoRotation: extra.noRotation === null ? undefined : (extra.noRotation ?? found?.distance),
  };
}
const times = <T>(n: number, make: () => T): T[] => Array.from({ length: n }, make);

describe('summarize: precision, recall and the other rates, computed by hand', () => {
  const sample: Outcome[] = [
    // set (a), 10 positives
    outcome('kept', REMOVE, { age: '2 months ago' }), // p1: older than 30 days, the nearest hit
    outcome('kept', { ...REMOVE, rank: 7 }, { age: '3 months ago' }), // p2: older than 30 days, 8th nearest: the re-fetch path (top 5) loses it
    outcome('kept', REMOVE, { noRotation: null }), // p3: only a rotation variant finds it
    ...times(2, () => outcome('kept', REMOVE)), // p4, p5
    ...times(2, () => outcome('kept', REPORT)), // p6, p7
    outcome('kept', { ...REPORT, distance: 25, rank: 9 }, { age: '5 months ago' }), // p8: outside gate 22, inside gate 26; older than 30 days
    outcome('kept', BELOW), // p9
    outcome('kept'), // p10
    // set (b), 4 + 5: hard negatives; the 5 are the OD8 pairs
    outcome('reversed', REMOVE), // r1
    outcome('reversed', REPORT), // r2
    outcome('reversed', BELOW), // r3
    outcome('reversed'), // r4
    outcome('od8', REPORT), // d1
    outcome('od8', BELOW), // d2
    ...times(3, () => outcome('od8')), // d3, d4, d5
    // set (c), 10 random pairs
    ...times(9, () => outcome('random')),
    outcome('random', BELOW),
    // set (e), 4 desktop/phone pairs
    outcome('phone', REMOVE),
    ...times(2, () => outcome('phone', REPORT)),
    outcome('phone'),
  ];

  it('at the default settings', () => {
    const m = summarize(sample, defaults);
    expect(m.n).toEqual({ kept: 10, reversed: 4, od8: 5, random: 10, phone: 4 });
    // (a) removals: p1-p5 (5). Flags (report or removal): p1-p7 (7); p8 is outside the gate, p9 is below reportAt, p10 was not found.
    // Negatives removed: r1 (1). Negatives flagged: r1, r2, d1 (3).
    expect(m.precisionRemove).toEqual({ k: 5, n: 6, value: 5 / 6 });
    expect(m.precisionReport).toEqual({ k: 7, n: 10, value: 0.7 });
    expect(m.recall).toEqual({ k: 7, n: 10, value: 0.7 });
    expect(m.recallRemove).toEqual({ k: 5, n: 10, value: 0.5 });
    expect(m.sameBackground).toEqual({ k: 1, n: 5, value: 0.2 }); // d1
    // In the top 50 at gate 22: p1-p7 and p9 (8). Without rotation variants: p3 drops out (7).
    expect(m.top50).toEqual({ k: 8, n: 10, value: 0.8 });
    expect(m.top50NoRotation).toEqual({ k: 7, n: 10, value: 0.7 });
    expect(m.phoneRecall).toEqual({ k: 3, n: 4, value: 0.75 });
    // Older than 30 days: p1, p2, p8 (3). Flagged and not among the first 5 hits: p2 (1); p8 is not flagged at gate 22.
    expect(m.old).toBe(3);
    expect(m.refetchLoss).toEqual({ k: 1, n: 10, value: 0.1 });
  });

  // For each changed setting the shapes change as the stage rules say. The numbers are [k, n] of each rate.
  it.each([
    {
      change: { gate: 26 }, // p8 is a hit now (a report); loss: p2 and p8
      precisionRemove: [5, 6], precisionReport: [8, 11], recall: [8, 10], sameBackground: [1, 5], top50: [9, 10], refetchLoss: 2,
    },
    {
      change: { reportAt: 93 }, // BELOW (93.75) is a report: p9, r3, d2 and the random one
      precisionRemove: [5, 6], precisionReport: [8, 14], recall: [8, 10], sameBackground: [2, 5], top50: [8, 10], refetchLoss: 1,
    },
    {
      change: { removeAt: 95 }, // REPORT (95.3125) is a removal: p6, p7 and the negatives r2, d1
      precisionRemove: [7, 10], precisionReport: [7, 10], recall: [7, 10], sameBackground: [1, 5], top50: [8, 10], refetchLoss: 1,
    },
    {
      change: { ncc: 0.95 }, // REPORT (NCC 0.9) is no match
      precisionRemove: [5, 6], precisionReport: [5, 6], recall: [5, 10], sameBackground: [0, 5], top50: [8, 10], refetchLoss: 1,
    },
    {
      change: { minTiles: 96 }, // REPORT (95.3125% of the tiles match) is no match
      precisionRemove: [5, 6], precisionReport: [5, 6], recall: [5, 10], sameBackground: [0, 5], top50: [8, 10], refetchLoss: 1,
    },
  ])('with $change', ({ change, refetchLoss, ...rates }) => {
    const m = summarize(sample, { ...defaults, ...change });
    const got = (r: { k: number; n: number }) => [r.k, r.n];
    expect({
      precisionRemove: got(m.precisionRemove),
      precisionReport: got(m.precisionReport),
      recall: got(m.recall),
      sameBackground: got(m.sameBackground),
      top50: got(m.top50),
    }).toEqual(rates);
    expect(m.refetchLoss.k).toBe(refetchLoss);
  });

  it('a gate distance equal to the gate setting passes; one bit more does not', () => {
    const m = summarize([outcome('kept', { ...REMOVE, distance: 22 }), outcome('kept', { ...REMOVE, distance: 23 })], defaults);
    expect(m.recall).toEqual({ k: 1, n: 2, value: 0.5 });
    expect(m.top50).toEqual({ k: 1, n: 2, value: 0.5 });
    expect(summarize([outcome('kept', { ...REMOVE, distance: 23 })], { ...defaults, gate: 23 }).recall.k).toBe(1);
  });

  it('the re-fetch path keeps the 5 nearest hits of an old original, and loses the others; a recent original is never lost', () => {
    const m = summarize(
      [
        outcome('kept', { ...REMOVE, rank: 4 }, { age: '2 months ago' }), // 5th nearest: kept
        outcome('kept', { ...REMOVE, rank: 5 }, { age: '2 months ago' }), // 6th nearest: lost
        outcome('kept', { ...REMOVE, rank: 9 }, { age: '3 days ago' }), // recent: has a thumbnail, no re-fetch
        outcome('kept', { ...REMOVE, rank: 9 }), // no age text: not old
      ],
      defaults,
    );
    expect(m.old).toBe(2);
    expect(m.refetchLoss).toEqual({ k: 1, n: 4, value: 0.25 });
  });

  it('gives no value for a rate without data, and counts nothing for an empty list', () => {
    const m = summarize([], defaults);
    expect(m.n).toEqual({ kept: 0, reversed: 0, od8: 0, random: 0, phone: 0 });
    expect(m.precisionRemove).toEqual({ k: 0, n: 0, value: null });
    expect(m.recall).toEqual({ k: 0, n: 0, value: null });
    expect(m.sameBackground.value).toBeNull();
  });
});

// ---- the AC17 limits ----

/** Metrics of 200 positives, 200 hard negatives with 20 OD8 pairs, 1,000 random pairs and 30 phone pairs, then one thing changed. */
function totals(over: { missed?: number; below?: number; lost?: number; falseRemove?: number; falseReport?: number; od8Flagged?: number; kept?: number; od8?: number } = {}): Metrics {
  const { missed = 0, below = 0, lost = 0, falseRemove = 0, falseReport = 0, od8Flagged = 0, kept = 200, od8 = 20 } = over;
  return summarize(
    [
      ...times(kept - missed - below - lost, () => outcome('kept', REMOVE)),
      ...times(missed, () => outcome('kept')),
      ...times(below, () => outcome('kept', BELOW)),
      ...times(lost, () => outcome('kept', { ...REMOVE, rank: 9 }, { age: '2 months ago' })), // flagged, old, only the 10th hit
      ...times(180, () => outcome('reversed')),
      ...times(falseRemove, () => outcome('reversed', REMOVE)),
      ...times(falseReport, () => outcome('reversed', REPORT)),
      ...times(od8 - od8Flagged, () => outcome('od8')),
      ...times(od8Flagged, () => outcome('od8', REPORT)),
      ...times(1000, () => outcome('random')),
      ...times(30, () => outcome('phone', REMOVE)),
    ],
    defaults,
  );
}
const statusOf = (m: Metrics, id: string, allow = false) => judge(m, allow).checks.find((c) => c.id === id)?.status;

describe('judge: the AC17 limits and the S9 set sizes', () => {
  it('passes when every number is met and every set has its minimum size', () => {
    const { checks, ok } = judge(totals(), false);
    expect(ok).toBe(true);
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['precisionRemove', 'pass'], ['precisionReport', 'pass'], ['recall', 'pass'], ['sameBackground', 'pass'], ['top50', 'pass'], ['refetchLoss', 'pass'],
      ['sizeA', 'pass'], ['sizeB', 'pass'], ['sizeOd8', 'pass'], ['sizeC', 'pass'],
    ]);
  });

  // Each limit at its edge, computed by hand. A false removal is also a false flag, so the removal case checks both rates.
  it.each([
    ['precisionRemove', { falseRemove: 6 }, 'pass'], // 200 / 206 = 0.9709 >= 0.97
    ['precisionRemove', { falseRemove: 7 }, 'fail'], // 200 / 207 = 0.9662
    ['precisionRemove', { kept: 194, falseRemove: 6 }, 'pass'], // 194 / 200 = 0.97 exactly
    ['precisionReport', { falseReport: 35 }, 'pass'], // 200 / 235 = 0.8511 >= 0.85
    ['precisionReport', { falseReport: 36 }, 'fail'], // 200 / 236 = 0.8475
    ['precisionReport', { kept: 170, falseReport: 30 }, 'pass'], // 170 / 200 = 0.85 exactly
    ['recall', { below: 30 }, 'pass'], // 170 / 200 = 0.85 >= 0.85
    ['recall', { below: 31 }, 'fail'], // 169 / 200 = 0.845
    ['sameBackground', { od8Flagged: 2 }, 'pass'], // 2 / 20 = 0.10 <= 0.10
    ['sameBackground', { od8Flagged: 3 }, 'fail'], // 3 / 20 = 0.15
    ['top50', { missed: 1 }, 'pass'], // 199 / 200 = 0.995 > 0.99
    ['top50', { missed: 2 }, 'fail'], // 198 / 200 = 0.99 is not more than 0.99
    ['refetchLoss', { lost: 6 }, 'pass'], // 6 / 200 = 0.03 <= 0.03
    ['refetchLoss', { lost: 7 }, 'fail'], // 7 / 200 = 0.035
  ] as const)('%s with %j: %s', (id, over, status) => {
    expect(statusOf(totals(over), id)).toBe(status);
  });

  it('passes a precision that has no flags to measure, and fails a recall that has no positives', () => {
    const none = summarize([...times(300, () => outcome('reversed')), ...times(1000, () => outcome('random')), ...times(20, () => outcome('od8'))], defaults);
    expect(statusOf(none, 'precisionRemove')).toBe('pass'); // nothing flagged: no false flag
    expect(statusOf(none, 'recall')).toBe('fail');
    expect(statusOf(none, 'recall', true)).toBe('fail'); // --allow-shortfall does not excuse missing positives
  });

  it('marks a set below its S9 minimum as short; --allow-shortfall excuses it, and a failed number is never excused', () => {
    const noOd8 = totals({ od8: 0 }); // OD8 = (b): no real complaint pairs
    expect(statusOf(noOd8, 'sameBackground')).toBe('short');
    expect(statusOf(noOd8, 'sizeOd8')).toBe('short');
    expect(judge(noOd8, false).ok).toBe(false);
    expect(judge(noOd8, true).ok).toBe(true);
    const small = totals({ kept: 150 }); // 150 positives: all numbers fine, set (a) is 50 short
    expect(statusOf(small, 'sizeA')).toBe('short');
    expect(judge(small, true).ok).toBe(true);
    expect(judge(totals({ falseRemove: 7 }), true).ok).toBe(false);
  });
});

// ---- the tool on real image files ----

const AW = 'Animewallpaper';
const AP = 'AnimePhoneWallpapers';
const IMAGES = [
  'base-valley.jpg', 'edit-recompress.jpg', 'edit-resize.png', 'edit-crop15.jpg', 'edit-hue.jpg', 't3-phone.jpg', 't4-mirror-up-crop-letterbox.jpg',
  'base-shrine-a.jpg', 'base-shrine-b.jpg', 't1-a.jpg', 't1-b.jpg', 't1b-a.jpg', 't1b-b.jpg', 't6-a.jpg', 't6-b.jpg',
  ['shrine-copy.jpg', 'base-shrine-a.jpg'], // the same bytes under another name: an exact repost
] satisfies (string | [string, string])[];

// Labels by how the pairs were built (plan 7.4). All of them are decided by the AC16 tests of test/image/cascade.test.ts, except the
// exact copy, which has distance 0 and similarity 100 by definition.
const legacyAW = [
  label(AW, 'edit-recompress.jpg', 'base-valley.jpg', 'kept', '2 months ago'), // recompressed: a repost
  label(AW, 'edit-resize.png', 'base-valley.jpg', 'kept', '3 days ago'), // halved in size: a repost
  label(AW, 'shrine-copy.jpg', 'base-shrine-a.jpg', 'kept', '1 month ago'), // an exact copy: a repost
  label(AW, 't1b-b.jpg', 't1b-a.jpg', 'reversed'), // T1b: the OD8 list has it too (below), so it counts once, as OD8
  label(AW, 'edit-hue.jpg', 'base-valley.jpg', 'unknown'), // no mod decision: not used
];
const legacyAP = [
  label(AP, 't3-phone.jpg', 'base-valley.jpg', 'kept', '1 day ago'), // 9:19.5 phone crop: a repost
  label(AP, 't4-mirror-up-crop-letterbox.jpg', 'base-valley.jpg', 'kept', '5 hours ago'), // mirrored, upscaled, cropped, letterboxed: a repost
  label(AP, 'base-shrine-a.jpg', 'base-shrine-b.jpg', 'reversed'), // T5: two pictures with one palette
];
const pairsFile = manifest(
  { kind: 'od8', subreddit: AW, query: 't1-a.jpg', candidate: 't1-b.jpg', source: 'OD8 message' }, // T1
  { kind: 'od8', subreddit: AP, query: 't1b-a.jpg', candidate: 't1b-b.jpg', source: 'OD8 message' }, // T1b
  { kind: 'random', subreddit: AW, query: 'base-valley.jpg', candidate: 'base-shrine-a.jpg' }, // two unrelated pictures
  { kind: 'random', subreddit: AP, query: 't1-a.jpg', candidate: 'base-valley.jpg' },
  { kind: 'phone', subreddit: AP, query: 'edit-crop15.jpg', candidate: 'base-valley.jpg' }, // a crop of the picture
);
const sampleFiles = {
  'legacy-repost-labels-animewallpaper.json': legacyAW,
  'legacy-repost-labels-animephonewallpapers.json': legacyAP,
  'calibration-pairs.jsonl': pairsFile,
};

// One run serves the checks of the first describe block (about 2 s).
let cached: Report | undefined;
const sample = () => (cached ??= calibrate(folder(sampleFiles, IMAGES)));
const wrongLabel = {
  ...sampleFiles,
  // The mods "approved" a post that is a recompressed copy of an older one: a mislabeled repost.
  'legacy-repost-labels-animephonewallpapers.json': [...legacyAP, label(AP, 'edit-hue.jpg', 'base-valley.jpg', 'reversed')],
};

describe('calibrate on public fixtures', () => {
  it('uses the plan defaults', () => {
    expect(sample().settings).toEqual(defaults);
  });

  it('counts the sets: a legacy pair that the OD8 list names counts once, an unknown outcome counts not at all', () => {
    const report = sample();
    // (a) 3 + 2 kept; (b) 1 reversed (T5) + 2 OD8; (c) 2 random; (e) 1 phone. Skipped: 1 unknown, 1 reversed that is in the OD8 list.
    expect(report.total.n).toEqual({ kept: 5, reversed: 1, od8: 2, random: 2, phone: 1 });
    expect(report.subreddits[AW.toLowerCase()]?.n).toEqual({ kept: 3, reversed: 0, od8: 1, random: 1, phone: 0 });
    expect(report.subreddits[AP.toLowerCase()]?.n).toEqual({ kept: 2, reversed: 1, od8: 1, random: 1, phone: 1 });
    expect(report.skipped).toEqual({ 'outcome unknown': 1, 'in the OD8 list': 1 });
    expect(report.problems).toEqual([]);
  });

  it('gives each set size, its S9 minimum and the shortfall', () => {
    const report = sample();
    expect(report.sizes.map((s) => [s.id, s.n, s.min, s.short])).toEqual([
      ['a', 5, 200, 195],
      ['b', 3, 200, 197],
      ['od8', 2, 20, 18],
      ['c', 2, 1000, 998],
      ['e', 1, 30, 29],
    ]);
    // 30 per subreddit for sets (a), (b) and (c): Animewallpaper has 3, 1 (OD8) and 1; AnimePhoneWallpapers has 2, 2 (T5 and OD8) and 1.
    expect(report.shortfalls.map((s) => [s.subreddit, s.set, s.n, s.short])).toEqual([
      ['animephonewallpapers', 'a', 2, 28],
      ['animephonewallpapers', 'b', 2, 28],
      ['animephonewallpapers', 'c', 1, 29],
      ['animewallpaper', 'a', 3, 27],
      ['animewallpaper', 'b', 1, 29],
      ['animewallpaper', 'c', 1, 29],
    ]);
  });

  it('finds the reposts and flags none of the others', () => {
    const report = sample();
    // All 5 positives have similarity 100 (the edits, the exact copy, the phone crop and the mirrored crop): 5 removals. T5, T1 and
    // T1b are no match (AC16); the random pairs are far apart (gate distance 28 and 30, over the widest gate of the grid).
    const t = report.total;
    expect(t.precisionRemove).toEqual({ k: 5, n: 5, value: 1 });
    expect(t.precisionReport).toEqual({ k: 5, n: 5, value: 1 });
    expect(t.recall).toEqual({ k: 5, n: 5, value: 1 });
    expect(t.recallRemove).toEqual({ k: 5, n: 5, value: 1 });
    expect(t.sameBackground).toEqual({ k: 0, n: 2, value: 0 });
    expect(t.top50).toEqual({ k: 5, n: 5, value: 1 });
    expect(t.top50NoRotation).toEqual({ k: 5, n: 5, value: 1 });
    expect(t.phoneRecall).toEqual({ k: 1, n: 1, value: 1 });
    // Older than 30 days by the age text: the recompressed picture (2 months) and the exact copy (1 month). Both are the nearest hit.
    expect(t.old).toBe(2);
    expect(t.refetchLoss).toEqual({ k: 0, n: 5, value: 0 });
  });

  it('computes the same rates for each subreddit', () => {
    const report = sample();
    const aw = report.subreddits[AW.toLowerCase()]!;
    expect(aw.precisionRemove).toEqual({ k: 3, n: 3, value: 1 });
    expect(aw.sameBackground).toEqual({ k: 0, n: 1, value: 0 });
    expect(aw.top50).toEqual({ k: 3, n: 3, value: 1 });
    expect(aw.phoneRecall.value).toBeNull(); // no desktop/phone pairs in this subreddit
    const ap = report.subreddits[AP.toLowerCase()]!;
    expect(ap.recall).toEqual({ k: 2, n: 2, value: 1 });
    expect(ap.precisionReport).toEqual({ k: 2, n: 2, value: 1 });
    expect(ap.phoneRecall).toEqual({ k: 1, n: 1, value: 1 });
  });

  it('records the label source and the stage numbers of each pair', () => {
    const report = sample();
    const exact = report.pairs.find((p) => p.query === 'shrine-copy.jpg')!;
    expect(exact).toMatchObject({
      kind: 'kept', subreddit: 'animewallpaper', candidate: 'base-shrine-a.jpg', source: 'legacy-repost-labels-animewallpaper.json:3',
      distance: 0, rank: 0, largestBlock: 0, similarity: 100, action: 'remove',
    });
    expect(report.pairs.find((p) => p.kind === 'od8' && p.query === 't1-a.jpg')).toMatchObject({ source: 'OD8 message', action: 'none' });
    expect(report.pairs.find((p) => p.kind === 'random' && p.query === 'base-valley.jpg')).toMatchObject({ distance: null, rank: null, action: 'none' });
  });

  it('gives the same decision as compare() of the image core for the same pair', () => {
    // T6 is the pair where the decision is not obvious (a report at the defaults). The expected value comes from the image core.
    const solo = folder({ 'legacy-repost-labels-x.json': [label('X', 't6-a.jpg', 't6-b.jpg', 'kept')] }, ['t6-a.jpg', 't6-b.jpg']);
    const pair = calibrate(solo, { allowShortfall: true }).pairs[0]!;
    const load = (name: string) => prepare(decodeGray(new Uint8Array(readFileSync(join(fixtures, name)))));
    const [q, c] = [load('t6-a.jpg'), load('t6-b.jpg')];
    const [found] = gate(variants(q), [{ id: 'c', sig: signature(c) }], defaults.gate);
    const expected = compare(thumbnail(q), thumbnail(c), found!.variant, defaults);
    expect(pair).toMatchObject({
      distance: found!.distance,
      ncc: expected.ncc,
      changedTiles: expected.changedTiles,
      largestBlock: expected.largestBlock,
      similarity: expected.similarity,
      action: expected.action,
    });
  });

  it('lists the grid: 243 settings around the defaults, each with its numbers', () => {
    const report = sample();
    expect(report.grid).toHaveLength(243);
    const row = report.grid.find((g) => Object.entries(defaults).every(([key, value]) => g.settings[key as keyof typeof defaults] === value));
    expect(row?.failing).toBe(0);
    expect(new Set(report.grid.map((g) => g.settings.gate))).toEqual(new Set([18, 22, 26]));
    expect(new Set(report.grid.map((g) => g.settings.ncc))).toEqual(new Set([0.75, 0.8, 0.85]));
  });

  it('fails on the set sizes only, and --allow-shortfall excuses that', () => {
    const report = sample();
    expect(report.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(report.checks.filter((c) => c.status === 'short').map((c) => c.id)).toEqual(['sizeA', 'sizeB', 'sizeOd8', 'sizeC']);
    expect(report.ok).toBe(false);
    expect(judge(report.total, true).ok).toBe(true);
  });

  it('prints the sets, the shortfall, the numbers and the verdict', () => {
    const report = sample();
    const text = format(report);
    expect(text).toMatch(/\(a\) positives[^\n]*\b5\b[^\n]*\b200\b[^\n]*\b195\b/);
    expect(text).toMatch(/OD8 pairs[^\n]*\b2\b[^\n]*\b20\b[^\n]*\b18\b/);
    expect(text).toMatch(/precision at removeAt[^\n]*1\.000 \(5\/5\)/);
    expect(text).toMatch(/animephonewallpapers/);
    expect(text).toMatch(/RESULT: FAIL.*short/);
    expect(format({ ...report, ok: true, allowShortfall: true })).toMatch(/RESULT: PASS \(short, excused by --allow-shortfall: set \(a\) size/);
  });

  it('counts a missing image file and an unreadable one, and says which', () => {
    const files = {
      'legacy-repost-labels-x.json': [
        label('X', 'edit-recompress.jpg', 'base-valley.jpg', 'kept'),
        label('X', 'gone.jpg', 'base-valley.jpg', 'kept'), // no such file
        label('X', 'broken.jpg', 'base-valley.jpg', 'kept'), // not an image
      ],
    };
    const dir2 = folder(files, ['edit-recompress.jpg', 'base-valley.jpg']);
    writeFileSync(join(dir2, 'images', 'broken.jpg'), 'this is not a JPEG');
    const r = calibrate(dir2, { allowShortfall: true });
    expect(r.total.n.kept).toBe(1);
    expect(r.skipped).toEqual({ 'image file missing': 1, 'image unreadable': 1 });
    expect(r.problems).toHaveLength(2);
    expect(r.problems.join('\n')).toMatch(/gone\.jpg/);
    expect(r.problems.join('\n')).toMatch(/broken\.jpg/);
  });

  it('leaves out an image file over 20 MiB before it is read, and counts the pair', () => {
    const MiB20 = 20 * 1024 * 1024;
    const dir2 = folder(
      {
        'legacy-repost-labels-x.json': [
          label('X', 'edit-recompress.jpg', 'base-valley.jpg', 'kept'),
          label('X', 'huge.jpg', 'base-valley.jpg', 'kept'), // 20 MiB and 1 byte
          label('X', 'limit.jpg', 'base-valley.jpg', 'kept'), // exactly 20 MiB: inside the limit, so it is read, and it is not an image
          label('X', 'folder.jpg', 'base-valley.jpg', 'kept'), // a folder: its size says nothing
        ],
      },
      ['edit-recompress.jpg', 'base-valley.jpg'],
    );
    for (const [name, size] of [['huge.jpg', MiB20 + 1], ['limit.jpg', MiB20]] as const) {
      writeFileSync(join(dir2, 'images', name), '');
      truncateSync(join(dir2, 'images', name), size); // a sparse file: nothing is written
    }
    mkdirSync(join(dir2, 'images', 'folder.jpg'));
    const r = calibrate(dir2, { allowShortfall: true });
    expect(r.total.n.kept).toBe(1);
    expect(r.skipped).toEqual({ 'image file too large': 1, 'image unreadable': 2 });
    expect(r.problems).toContain(`image file too large: images/huge.jpg (${MiB20 + 1} bytes, the limit is ${MiB20})`);
    expect(r.problems.join('\n')).toMatch(/image unreadable: images\/limit\.jpg/);
    expect(r.problems.join('\n')).toMatch(/image unreadable: images\/folder\.jpg \(not a regular file\)/);
  });
});

describe('calibrate on a sample with a wrong label', () => {
  it('fails the precision numbers when a true repost is labeled as approved', () => {
    // The wrong label is flagged, so it is a false flag: removals 5 true + 1 false = 5/6 = 0.833 (limit 0.97); flags 5/6 = 0.833 (limit 0.85).
    const r = calibrate(folder(wrongLabel, IMAGES), { allowShortfall: true });
    expect(r.total.precisionRemove).toEqual({ k: 5, n: 6, value: 5 / 6 });
    expect(r.total.precisionReport).toEqual({ k: 5, n: 6, value: 5 / 6 });
    expect(r.checks.filter((c) => c.status === 'fail').map((c) => c.id)).toEqual(['precisionRemove', 'precisionReport']);
    expect(r.ok).toBe(false); // an excused shortfall does not excuse a failed number
  });
});

// ---- the command line ----

const tsx = join(root, 'node_modules/.bin/tsx');
const run = (args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
    execFile(tsx, [join(root, 'tools/calibrate.ts'), ...args], { cwd: root, env: { ...process.env, NO_COLOR: '1' }, maxBuffer: 1 << 26 }, (err, stdout, stderr) =>
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }),
    ),
  );

describe('the command line', () => {
  it('exits 0 and prints one JSON report when the numbers are met (--json --allow-shortfall)', async () => {
    const r = await run([folder(sampleFiles, IMAGES), '--json', '--allow-shortfall']);
    expect(r.code, r.stderr).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.ok).toBe(true);
    expect(json.total.recall).toEqual({ k: 5, n: 5, value: 1 });
    expect(json.pairs).toHaveLength(11); // 5 kept + 1 reversed + 2 od8 + 2 random + 1 phone
  });

  it('exits 1 and says why when a number is not met', async () => {
    const r = await run([folder(wrongLabel, IMAGES), '--allow-shortfall']);
    expect(r.code, r.stderr).toBe(1);
    expect(r.stdout).toMatch(/FAIL\s+precision at removeAt/);
    expect(r.stdout).toMatch(/RESULT: FAIL \(not met: precision at removeAt, precision at reportAt\)/);
  });

  it('exits 1 for a shortfall when --allow-shortfall is not given', async () => {
    const r = await run([folder(sampleFiles, IMAGES)]);
    expect(r.code, r.stderr).toBe(1);
    expect(r.stdout).toMatch(/SHORT\s+set \(a\) size/);
  });

  it('exits 2 for a folder that does not exist, for an empty one, and for a bad option', async () => {
    const missing = await run([join(tmpdir(), 'calibrate-no-such-folder')]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/not found/);
    const empty = await run([folder({})]);
    expect(empty.code).toBe(2);
    expect(empty.stderr).toMatch(/no label pairs/);
    const bad = await run(['--bogus']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/--help/);
  });

  it('--help describes the folder layout, the label format, the manifest and the exit codes', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    for (const word of ['legacy-repost-labels-', 'calibration-pairs.jsonl', 'images/', '"kind"', 'od8', 'random', 'phone', 'Exit code', '--allow-shortfall', '--json']) {
      expect(r.stdout, word).toContain(word);
    }
  });

  it('--help gives a download command that keeps only https URLs of the Reddit image hosts, and limits curl', async () => {
    const help = (await run(['--help'])).stdout;
    expect(help).toContain("--proto '=https'");
    expect(help).toContain('--max-filesize 20971520'); // 20 MiB: the limit of the tool itself
    expect(help).toContain('--fail');
    expect(help).not.toMatch(/\bcurl\b[^\n]*(\s-L\b|--location)/); // a redirect could leave the Reddit hosts
    const pattern = /grep -E '([^']+)'/.exec(help)?.[1];
    expect(pattern, 'the command filters the URLs with grep -E').toBeDefined();
    const urls = [
      'https://i.redd.it/abc123.jpg', // kept
      'https://preview.redd.it/abc123.jpg?width=640&s=x', // kept
      'http://i.redd.it/abc123.jpg', // not https
      'https://i.redd.it.evil.example/abc123.jpg', // another host that starts the same
      'https://i.redd.it@evil.example/abc123.jpg', // a user name, then another host
      'https://i.redd.it:8443/abc123.jpg', // a port
      'https://evil.example/?u=https://i.redd.it/abc123.jpg', // the Reddit URL is not at the start
      'https://external-preview.redd.it/abc123.jpg', // another Reddit host
      'https://redd.it/abc123',
      'https://169.254.169.254/latest/meta-data/',
      'file:///etc/passwd',
      ' https://i.redd.it/abc123.jpg', // a space first
      'null', // what jq prints for a key that is not there
    ];
    const kept = spawnSync('grep', ['-E', pattern!], { input: `${urls.join('\n')}\n`, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    expect(kept).toEqual(urls.slice(0, 2));
  });
});
