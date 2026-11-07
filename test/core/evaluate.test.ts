import { describe, expect, it } from 'vitest';
import { evaluateQuick, skipReason } from '../../src/core/evaluate';
import { renderComment } from '../../src/core/messages';
import { parseAspect } from '../../src/core/rules/aspectRatio';
import type { SkipInput } from '../../src/core/evaluate';
import type { Orientation, PostSnapshot, RateCandidate } from '../../src/core/types';
import { A1, A2, A3 } from './appendix';
import { cfg, img, state } from './helpers';

const APP = 't2_app';
const post = (o: Partial<SkipInput> = {}): SkipInput => ({
  ...state(),
  authorId: 't2_user',
  authorName: 'Artist',
  title: 'Nice wallpaper',
  flair: 'Desktop',
  ...o,
});

// Plan 5.4 step 3 (R1). The order of the checks: app-account post, approved, skip "removed", skip "deleted",
// effective mode off, except author, flair skip. The result is saved as the status `skipped:{reason}`.
describe('skipReason', () => {
  it('does not skip an ordinary post', () => {
    expect(skipReason(cfg(), 'enforce', post(), APP)).toBeUndefined();
    expect(skipReason(cfg({ mode: 'dry-run' }), 'dry-run', post(), APP)).toBeUndefined();
  });

  it('skips a post of the app account', () => {
    expect(skipReason(cfg(), 'enforce', post({ authorId: APP }), APP)).toBe('app-post');
  });

  // OD6: an app-account post is not skipped only when the canary setting is on AND the title starts with [canary].
  it.each([
    ['both', true, '[canary] fixture', undefined],
    ['the setting is off', false, '[canary] fixture', 'app-post'],
    ['the title has no prefix', true, 'fixture [canary]', 'app-post'],
    ['neither', false, 'fixture', 'app-post'],
  ])('canary exception: %s', (_name, canary, title, expected) => {
    expect(skipReason(cfg({ canary }), 'enforce', post({ authorId: APP, title }), APP)).toBe(expected);
  });

  it('does not take a post with an unknown author for a post of the app', () => {
    expect(skipReason(cfg(), 'enforce', post({ authorId: undefined }), APP)).toBeUndefined();
  });

  it('does not skip a post whose removedBy and removedByCategory are empty texts', () => {
    expect(skipReason(cfg(), 'enforce', post({ removedBy: '', removedByCategory: '' }), APP)).toBeUndefined();
  });

  it('skips an approved post', () => {
    expect(skipReason(cfg(), 'enforce', post({ approved: true }), APP)).toBe('approved');
  });

  it('skips a removed post, but not an AutoMod-filtered one (AC6)', () => {
    const byMod = post({ removed: true, removedByCategory: 'moderator', removedBy: 'SomeMod' });
    const filtered = post({ removed: true, removedByCategory: 'automod_filtered' });
    expect(skipReason(cfg(), 'enforce', byMod, APP)).toBe('removed');
    expect(skipReason(cfg(), 'enforce', filtered, APP)).toBeUndefined();
  });

  it('does not skip a removal by the legacy bot while the effective mode is dry-run (plan 5.2)', () => {
    const byLegacy = post({ removed: true, removedByCategory: 'moderator', removedBy: 'AnimewallpaperBot' });
    expect(skipReason(cfg({ mode: 'dry-run' }), 'dry-run', byLegacy, APP)).toBeUndefined();
    expect(skipReason(cfg({ mode: 'enforce' }), 'dry-run', byLegacy, APP)).toBeUndefined(); // first mode dry-run
    expect(skipReason(cfg({ mode: 'enforce' }), 'enforce', byLegacy, APP)).toBe('removed');
  });

  it('gives "removed", not "deleted", when the removed flag is set and the category is deleted', () => {
    // Plan 5.2: isRemoved = removed || ...; the skip "removed" check comes before the skip "deleted" check.
    expect(skipReason(cfg(), 'enforce', post({ removed: true, removedByCategory: 'deleted' }), APP)).toBe('removed');
  });

  it('skips a deleted post', () => {
    expect(skipReason(cfg(), 'enforce', post({ removedByCategory: 'deleted' }), APP)).toBe('deleted');
    expect(skipReason(cfg(), 'enforce', post({ removedByCategory: 'author' }), APP)).toBe('deleted');
  });

  it('skips when the effective mode is off: the mode now, or the mode at the first lease', () => {
    expect(skipReason(cfg({ mode: 'off' }), 'enforce', post(), APP)).toBe('mode-off');
    expect(skipReason(cfg({ mode: 'enforce' }), 'off', post(), APP)).toBe('mode-off');
  });

  it('skips an author in exceptAuthors, by exact name (legacy L§1.9)', () => {
    const c = cfg({ exceptAuthors: ['AutoModerator', 'Artist'] });
    expect(skipReason(c, 'enforce', post(), APP)).toBe('except-author');
    expect(skipReason(c, 'enforce', post({ authorName: 'artist' }), APP)).toBeUndefined();
  });

  it('skips a skip flair, and only that flair', () => {
    const flairRules = new Map<string, 'skip' | Orientation[]>([
      ['Other', 'skip'],
      ['Desktop', ['horizontal']],
    ]);
    const c = cfg({ flairRules });
    expect(skipReason(c, 'enforce', post({ flair: 'Other' }), APP)).toBe('flair-skip');
    expect(skipReason(c, 'enforce', post({ flair: 'Desktop' }), APP)).toBeUndefined();
    expect(skipReason(c, 'enforce', post({ flair: undefined }), APP)).toBeUndefined();
  });

  it('gives the first reason in the order of the plan', () => {
    const all = post({ authorId: APP, approved: true, removed: true, removedByCategory: 'moderator', authorName: 'Artist', flair: 'Other' });
    const c = cfg({ mode: 'off', exceptAuthors: ['Artist'], flairRules: new Map([['Other', 'skip' as const]]) });
    expect(skipReason(c, 'off', all, APP)).toBe('app-post');
    expect(skipReason(c, 'off', { ...all, authorId: 't2_user' }, APP)).toBe('approved');
    expect(skipReason(c, 'off', { ...all, authorId: 't2_user', approved: false }, APP)).toBe('removed');
    expect(skipReason(c, 'off', { ...all, authorId: 't2_user', approved: false, removed: false, removedByCategory: 'deleted' }, APP)).toBe('deleted');
    expect(skipReason(c, 'off', { ...all, authorId: 't2_user', approved: false, removed: false, removedByCategory: undefined }, APP)).toBe('mode-off');
    expect(skipReason({ ...c, mode: 'enforce' }, 'enforce', { ...all, authorId: 't2_user', approved: false, removed: false, removedByCategory: undefined }, APP)).toBe('except-author');
    expect(skipReason({ ...c, mode: 'enforce', exceptAuthors: [] }, 'enforce', { ...all, authorId: 't2_user', approved: false, removed: false, removedByCategory: undefined }, APP)).toBe('flair-skip');
  });
});

// R2 to R6 in legacy order (flair, mismatch, bad resolution, aspect ratio, rate limit), then the comment text.
describe('evaluateQuick', () => {
  const T = Date.UTC(2024, 11, 4, 11, 35, 0);
  const snapshot = (o: Partial<PostSnapshot> = {}): PostSnapshot => ({ id: 'cur', createdAt: T, title: 'Nice art', images: [], ...o });
  const SUB = 'Animewallpaper';

  it('gives no failure when every rule is off', () => {
    expect(evaluateQuick(cfg(), snapshot({ images: [img(100, 100)] }), [])).toEqual([]);
  });

  it('renders L Appendix A1: a Desktop post, one 1600x1200 image, tag [1920x1080]', () => {
    const config = cfg({
      resolutionMismatch: true,
      resolutionBad: { horizontal: { width: 1920, height: 1080 } },
      aspectRatio: { horizontal: parseAspect('16:10 to none') },
      flairRules: new Map([['Desktop', ['horizontal' as const]]]),
    });
    const post = snapshot({
      title: 'Nice wallpaper [1920x1080]',
      flair: 'Desktop',
      images: [{ n: 1, url: 'https://i.redd.it/abc123.png', width: 1600, height: 1200 }],
    });
    expect(renderComment(SUB, evaluateQuick(config, post, []))).toBe(A1);
  });

  it('renders L Appendix A2: a vertical image under the Desktop flair', () => {
    const config = cfg({ flairRules: new Map([['Desktop', ['horizontal' as const]]]) });
    const post = snapshot({ flair: 'Desktop', images: [{ n: 1, url: 'https://i.redd.it/v1.jpg', width: 900, height: 1600 }] });
    expect(renderComment(SUB, evaluateQuick(config, post, []))).toBe(A2);
  });

  it('renders L Appendix A3: the fifth post in 24 hours with a limit of 4 (deleted posts count)', () => {
    const MIN = 60_000;
    const HOUR = 60 * MIN;
    const earlier = (id: string, before: number): RateCandidate => ({ id, createdAt: T - before, ...state() });
    const history = [earlier('p1', 20 * HOUR + 15 * MIN), earlier('p2', 5 * HOUR), earlier('p3', HOUR + MIN), earlier('p4', 30_000)];
    const config = cfg({ rateLimit: { hours: 24, posts: 4, countDeleted: true } });
    expect(renderComment(SUB, evaluateQuick(config, snapshot(), history))).toBe(A3);
  });

  it('runs the rules in legacy order: flair, mismatch, bad resolution, aspect ratio, rate limit', () => {
    const config = cfg({
      flairRules: new Map([['Desktop', ['horizontal' as const]]]),
      resolutionMismatch: true,
      resolutionBad: { vertical: { width: 900, height: 1600 } },
      aspectRatio: { vertical: parseAspect('9:21 to 10:16') },
      rateLimit: { hours: 24, posts: 1, countDeleted: false },
    });
    const post = snapshot({ title: '[1920x1080]', flair: 'Desktop', images: [img(800, 1000)] });
    const history = [{ id: 'old', createdAt: T - 60_000, ...state() }];
    expect(evaluateQuick(config, post, history).map((f) => f.rule)).toEqual([
      'flair',
      'resolutionMismatch',
      'resolutionBad',
      'aspectRatio',
      'rateLimit',
    ]);
  });

  it('does not run the mismatch rule when it is off, although the title has a tag that no image matches', () => {
    const post = snapshot({ title: '[1920x1080]', images: [img(800, 600)] });
    expect(evaluateQuick(cfg({ resolutionMismatch: false }), post, [])).toEqual([]);
  });

  it('does not run a rule that is off, also when its input would fail', () => {
    const config = cfg({ resolutionMismatch: true });
    const post = snapshot({ title: '[1920x1080]', images: [img(800, 600)] });
    expect(evaluateQuick(config, post, []).map((f) => f.rule)).toEqual(['resolutionMismatch']);
  });

  // D1: the number is the gallery position. Legacy would write "#1, #2" here.
  it('numbers failed images by gallery position (D1)', () => {
    const config = cfg({ flairRules: new Map([['Desktop', ['horizontal' as const]]]) });
    const post = snapshot({
      flair: 'Desktop',
      images: [img(1920, 1080, 1), img(900, 1600, 2, 'https://i.redd.it/b.png'), img(800, 1500, 3, 'https://i.redd.it/c.png')],
    });
    expect(renderComment(SUB, evaluateQuick(config, post, []))).toContain(
      '\t- [Image #2](https://i.redd.it/b.png), [Image #3](https://i.redd.it/c.png) are vertical.',
    );
  });
});
