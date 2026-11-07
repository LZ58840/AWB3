import { describe, expect, it } from 'vitest';
import type { RepostConfig } from '../../src/core/types';
import { maxBlockTiles, repostAction, repostAgeText } from '../../src/core/rules/repost';

// Plan OD4b: similarity = 100% - (largest block of changed tiles / 64), in steps of 1.5625%:
// block 0 -> 100, 1 -> 98.4375, 2 -> 96.875, 3 -> 95.3125, 4 -> 93.75.
// A percent setting allows the largest block whose similarity is >= the setting.
describe('maxBlockTiles', () => {
  it.each([
    [100, 0],
    [98, 1], // repostRemoveAt default: the original "< 2%"
    [94, 3], // repostReportAt default: the original "<= 6%"
  ])('%i percent allows a block of %i tiles (plan OD4b)', (percent, tiles) => {
    expect(maxBlockTiles(percent)).toBe(tiles);
  });

  it.each([
    [98.4375, 1],
    [96.875, 2],
    [95.3125, 3],
    [93.75, 4],
    [85, 9], // lowest repostReportAt
    [90, 6], // lowest repostRemoveAt
  ])('%f percent allows a block of %i tiles (OD4b table)', (percent, tiles) => {
    expect(maxBlockTiles(percent)).toBe(tiles);
  });

  it('allows one tile less when the setting is just above a step', () => {
    expect(maxBlockTiles(98.44)).toBe(0); // 98.4375 < 98.44
    expect(maxBlockTiles(98.43)).toBe(1);
  });
});

// Legacy L§1.7 `get_time_since`: months, then days, hours, minutes; the first non-zero unit wins; else "just now".
// It measures from the matched post to the current post. Months follow MonthDelta 0.9.1 `monthmod`
// (monthdelta.py:151-154): 12*(end.year - start.year) + end.month - start.month - (start.day > end.day ? 1 : 0).
// That count uses the date only (not the time of day) and does not clamp a missing day.
// Expected values: hand computation with that formula, confirmed by running the legacy `get_time_since`
// (6,007 pairs, 0 differences; see the report).
describe('repostAgeText', () => {
  const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);

  it.each([
    [at(2024, 10, 4, 12), at(2024, 12, 4, 12), '2 months ago'], // Appendix A5
    [at(2024, 11, 4, 12), at(2024, 12, 4, 12), '1 month ago'],
    [at(2024, 10, 4, 12), at(2024, 12, 4, 11, 59, 59), '2 months ago'], // same day of the month: the time of day does not count
    [at(2024, 6, 15), at(2024, 12, 15), '6 months ago'],
    [at(2023, 12, 20), at(2024, 1, 20), '1 month ago'], // over a year change
  ])('months: %i to %i gives %j', (from, to, text) => {
    expect(repostAgeText(from, to)).toBe(text);
  });

  it('takes one month off when the start day is after the end day, and does not clamp a missing day', () => {
    expect(repostAgeText(at(2024, 1, 31, 10), at(2024, 2, 29, 10))).toBe('29 days ago'); // 31 > 29: 0 months
    expect(repostAgeText(at(2024, 1, 31, 10), at(2024, 2, 29, 9))).toBe('28 days ago'); // 28 days 23 hours
    expect(repostAgeText(at(2024, 1, 31), at(2024, 3, 1))).toBe('1 month ago'); // 2 - 1 months (30 days)
    expect(repostAgeText(at(2024, 10, 5), at(2024, 12, 4))).toBe('1 month ago'); // 2 - 1 months (60 days)
    expect(repostAgeText(at(2023, 12, 31), at(2024, 1, 30))).toBe('30 days ago'); // over a year change: 1 - 1 months
  });

  it.each([
    [at(2024, 11, 5), at(2024, 12, 4), '29 days ago'], // Nov 5 + 1 month = Dec 5, after Dec 4
    [at(2024, 12, 1), at(2024, 12, 2), '1 day ago'],
    [at(2024, 12, 1, 8), at(2024, 12, 6, 20), '5 days ago'],
    [at(2024, 12, 4, 9), at(2024, 12, 4, 12), '3 hours ago'],
    [at(2024, 12, 4, 11), at(2024, 12, 4, 12), '1 hour ago'],
    [at(2024, 12, 4, 11, 15), at(2024, 12, 4, 12), '45 minutes ago'],
    [at(2024, 12, 4, 11, 59), at(2024, 12, 4, 12), '1 minute ago'],
    [at(2024, 12, 4, 11, 59, 1), at(2024, 12, 4, 12), 'just now'],
  ])('days and less: %i to %i gives %j', (from, to, text) => {
    expect(repostAgeText(from, to)).toBe(text);
  });

  it('gives "just now" when the matched post is not older', () => {
    expect(repostAgeText(at(2024, 12, 5), at(2024, 12, 4))).toBe('just now');
  });
});

// Plan 5.4 `rp:` step 7 and D14: removal only when repostReportOnly is false and the best similarity is
// >= repostRemoveAt; every other match gives a report. Similarity steps: 100, 98.4375, 96.875, 95.3125, 93.75.
describe('repostAction', () => {
  const repost: RepostConfig = {
    mode: 'enforce',
    reportOnly: true,
    months: 6,
    reportAt: 94,
    removeAt: 98,
    gate: 22,
    ncc: 0.8,
    minTiles: 85,
  };
  const removing = { ...repost, reportOnly: false };

  it('always reports in report-only mode, also for an identical image', () => {
    expect(repostAction(repost, 100)).toBe('report');
  });

  it('removes when report-only is off and the similarity reaches repostRemoveAt', () => {
    expect(repostAction(removing, 100)).toBe('remove');
    expect(repostAction(removing, 98.4375)).toBe('remove');
  });

  it('removes when the similarity is equal to repostRemoveAt', () => {
    expect(repostAction(removing, 98)).toBe('remove');
    expect(repostAction({ ...removing, removeAt: 98.4375 }, 98.4375)).toBe('remove');
    expect(repostAction({ ...removing, removeAt: 100 }, 100)).toBe('remove');
  });

  it('reports a match below repostRemoveAt (D14)', () => {
    expect(repostAction(removing, 96.875)).toBe('report');
    expect(repostAction(removing, 95.3125)).toBe('report');
    expect(repostAction({ ...removing, removeAt: 100 }, 98.4375)).toBe('report');
  });
});
