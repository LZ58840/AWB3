import { describe, expect, it } from 'vitest';
import type { PostState, RateCandidate } from '../../src/core/types';
import { checkRateLimit, formatDuration } from '../../src/core/rules/rateLimit';
import { state } from './helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;

// Legacy L§1.5 `format_duration(hours, minutes)`: both 0 gives "just now"; else hours, then minutes of the hour,
// then " ago", with a leading ", " removed. Expected values: the examples in L§1.5 and Appendix A3.
describe('formatDuration', () => {
  it.each([
    [0, 'just now'],
    [59_999, 'just now'],
    [MIN, '1 minute ago'],
    [2 * MIN, '2 minutes ago'],
    [59 * MIN, '59 minutes ago'],
    [HOUR, '1 hour ago'],
    [HOUR + MIN, '1 hour, 1 minute ago'],
    [90 * MIN, '1 hour, 30 minutes ago'],
    [5 * HOUR, '5 hours ago'],
    [2 * HOUR + 59 * MIN + 59_999, '2 hours, 59 minutes ago'],
    [20 * HOUR + 15 * MIN, '20 hours, 15 minutes ago'],
  ])('%i ms gives %j', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

// Legacy L§1.5 and L§4(b): the post fails when the number of counted other posts of the author in the window
// is >= the limit (limit 3 allows 3 posts and removes the 4th: AC9). Counted: not removed, and not deleted unless
// deleted posts count. Window: legacy `current - other < W`, so a post exactly W old is not counted (the message
// "wait until oldest + W" stays true). D2: only posts made before the current post count.
describe('checkRateLimit', () => {
  const T = Date.UTC(2024, 11, 4, 11, 35, 0);
  const rate = { hours: 24, posts: 3, countDeleted: false };
  const post = (id: string, before: number, over: Partial<PostState> = {}): RateCandidate => ({
    id,
    createdAt: T - before,
    ...state(over),
  });

  it('passes when fewer posts than the limit are counted', () => {
    expect(checkRateLimit(rate, T, [post('a', HOUR), post('b', 2 * HOUR)])).toBeUndefined();
  });

  it('passes when there are no other posts', () => {
    expect(checkRateLimit(rate, T, [])).toBeUndefined();
  });

  it('fails at the limit; lists the counted posts newest first; gives the time of the oldest post plus the window', () => {
    const result = checkRateLimit(rate, T, [post('c', 5 * HOUR), post('a', 30_000), post('b', HOUR + MIN)]);
    expect(result).toEqual({
      rule: 'rateLimit',
      posts: 3,
      hours: 24,
      countDeleted: false,
      createdAt: T,
      recent: [
        { id: 'a', createdAt: T - 30_000 },
        { id: 'b', createdAt: T - HOUR - MIN },
        { id: 'c', createdAt: T - 5 * HOUR },
      ],
      nextAt: T - 5 * HOUR + 24 * HOUR,
    });
  });

  it('counts a post that is just inside the window and not a post that is exactly one window old', () => {
    const inside = [post('a', HOUR), post('b', 2 * HOUR), post('c', 24 * HOUR - 1)];
    expect(checkRateLimit(rate, T, inside)).not.toBeUndefined();
    const edge = [post('a', HOUR), post('b', 2 * HOUR), post('c', 24 * HOUR)];
    expect(checkRateLimit(rate, T, edge)).toBeUndefined();
  });

  it('does not count a post made at the same time as, or after, the current post (D2)', () => {
    const others = [post('a', HOUR), post('b', 2 * HOUR), post('same', 0), post('later', -MIN)];
    expect(checkRateLimit(rate, T, others)).toBeUndefined();
  });

  it('does not count a removed post', () => {
    const others = [post('a', HOUR), post('b', 2 * HOUR), post('c', 3 * HOUR, { removed: true })];
    expect(checkRateLimit(rate, T, others)).toBeUndefined();
  });

  it('counts a deleted post only when deleted posts count', () => {
    const others = [post('a', HOUR), post('b', 2 * HOUR), post('c', 3 * HOUR, { removedByCategory: 'deleted' })];
    expect(checkRateLimit(rate, T, others)).toBeUndefined();
    expect(checkRateLimit({ ...rate, countDeleted: true }, T, others)).toMatchObject({ countDeleted: true });
  });
});
