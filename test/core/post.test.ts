import { describe, expect, it } from 'vitest';
import {
  effectiveMode,
  effectiveRepostMode,
  isAlive,
  isCounted,
  isDeleted,
  isRemoved,
  orientationOf,
  postImages,
  skipsAsRemoved,
} from '../../src/core/post';
import type { Mode, RepostConfig } from '../../src/core/types';
import { cfg, state } from './helpers';

// Expected values: plan 5.2 "Shared definitions".
describe('isDeleted', () => {
  it('is true for removedByCategory deleted and author', () => {
    expect(isDeleted(state({ removedByCategory: 'deleted' }))).toBe(true);
    expect(isDeleted(state({ removedByCategory: 'author' }))).toBe(true);
    expect(isDeleted(state({ authorName: '[deleted]' }))).toBe(true); // Devvit (S2)
    expect(isDeleted(state({ authorName: 'alice' }))).toBe(false);
  });

  it('is false for other categories and for none', () => {
    expect(isDeleted(state({ removedByCategory: 'moderator' }))).toBe(false);
    expect(isDeleted(state())).toBe(false);
  });
});

// isRemoved(p) = p.removed || p.spam || (removedByCategory set and not deleted). Legacy: banned_by is not None (L§4(b)).
describe('isRemoved', () => {
  it('is true for the removed flag, the spam flag and any remover category', () => {
    expect(isRemoved(state({ removed: true }))).toBe(true);
    expect(isRemoved(state({ spam: true }))).toBe(true);
    expect(isRemoved(state({ removedByCategory: 'moderator' }))).toBe(true);
    expect(isRemoved(state({ removedByCategory: 'automod_filtered' }))).toBe(true);
  });

  it('is true when the removed flag is set, whatever the category (also deleted)', () => {
    expect(isRemoved(state({ removed: true, removedByCategory: 'deleted' }))).toBe(true);
    expect(isRemoved(state({ removed: true, removedByCategory: 'author' }))).toBe(true);
  });

  it('is false for a live post and for an author delete', () => {
    expect(isRemoved(state())).toBe(false);
    expect(isRemoved(state({ removedByCategory: 'deleted' }))).toBe(false);
    expect(isRemoved(state({ removedByCategory: 'author' }))).toBe(false);
  });
});

// The harness, and possibly real Reddit, give "" for removedBy and removedByCategory on a normal post. "" means "not set".
describe('an empty removedBy and removedByCategory', () => {
  const normal = state({ removedBy: '', removedByCategory: '' });

  it('is not a removal and not a delete', () => {
    expect(isRemoved(normal)).toBe(false);
    expect(isDeleted(normal)).toBe(false);
  });

  it('gives a live post for every predicate', () => {
    expect(isAlive(normal)).toBe(true);
    expect(isCounted(normal, false)).toBe(true);
    expect(skipsAsRemoved(normal, 'enforce')).toBe(false);
    expect(skipsAsRemoved(normal, 'dry-run')).toBe(false);
  });

  it('is still removed when the removed flag or the spam flag is set, or the category is set', () => {
    expect(isRemoved(state({ removed: true, removedBy: '', removedByCategory: '' }))).toBe(true);
    expect(isRemoved(state({ spam: true, removedBy: '', removedByCategory: '' }))).toBe(true);
    expect(isRemoved(state({ removedBy: '', removedByCategory: 'moderator' }))).toBe(true);
    expect(isDeleted(state({ removedBy: '', removedByCategory: 'deleted' }))).toBe(true);
  });
});

// Plan 5.2: skip "removed" = isRemoved && category != automod_filtered. While the effective mode is dry-run,
// a removal by AnimewallpaperBot counts as not removed, so the shadow sees the same posts as legacy.
describe('skipsAsRemoved', () => {
  it('skips a post that a moderator removed', () => {
    expect(skipsAsRemoved(state({ removed: true, removedByCategory: 'moderator', removedBy: 'SomeMod' }), 'enforce')).toBe(true);
  });

  it('does not skip a live post', () => {
    expect(skipsAsRemoved(state(), 'enforce')).toBe(false);
  });

  it('does not skip an AutoMod-filtered post (AC6)', () => {
    expect(skipsAsRemoved(state({ removed: true, removedByCategory: 'automod_filtered' }), 'enforce')).toBe(false);
  });

  it('does not skip a legacy-bot removal in dry-run, but skips it in enforce', () => {
    const byLegacy = state({ removed: true, removedByCategory: 'moderator', removedBy: 'AnimewallpaperBot' });
    expect(skipsAsRemoved(byLegacy, 'dry-run')).toBe(false);
    expect(skipsAsRemoved(byLegacy, 'enforce')).toBe(true);
    expect(skipsAsRemoved(byLegacy, 'off')).toBe(true); // the exception is for dry-run only
  });

  it('skips another remover in dry-run', () => {
    expect(skipsAsRemoved(state({ removed: true, removedByCategory: 'moderator', removedBy: 'SomeMod' }), 'dry-run')).toBe(true);
  });
});

// Plan 5.2: alive = !isRemoved && !isDeleted. Legacy: a removed (AutoModerator included) or deleted match is dropped (L§1.7).
describe('isAlive', () => {
  it('is true only for a post that is neither removed nor deleted', () => {
    expect(isAlive(state())).toBe(true);
    expect(isAlive(state({ removed: true }))).toBe(false);
    expect(isAlive(state({ removedByCategory: 'automod_filtered' }))).toBe(false);
    expect(isAlive(state({ removedByCategory: 'deleted' }))).toBe(false);
  });
});

// Plan 5.2: counted in the rate limit = !isRemoved && (!isDeleted || rateLimitCountDeleted). Legacy: L§1.5.
describe('isCounted', () => {
  it('counts a live post', () => {
    expect(isCounted(state(), false)).toBe(true);
  });

  it('does not count a removed post, also when deleted posts count', () => {
    expect(isCounted(state({ removed: true }), false)).toBe(false);
    expect(isCounted(state({ removed: true }), true)).toBe(false);
  });

  it('counts a deleted post only when deleted posts count', () => {
    const deleted = state({ removedByCategory: 'deleted' });
    expect(isCounted(deleted, false)).toBe(false);
    expect(isCounted(deleted, true)).toBe(true);
  });
});

// Legacy L§1.1: width > height is horizontal, width < height is vertical, equal is square.
describe('orientationOf', () => {
  it('compares width with height', () => {
    expect(orientationOf({ width: 1920, height: 1080 })).toBe('horizontal');
    expect(orientationOf({ width: 900, height: 1600 })).toBe('vertical');
    expect(orientationOf({ width: 1000, height: 1000 })).toBe('square');
  });
});

// Plan 5.2: effective mode = the lower of post.firstMode and the current mode (off < dry-run < enforce).
describe('effectiveMode', () => {
  it.each<[Mode, Mode, Mode]>([
    ['enforce', 'enforce', 'enforce'],
    ['dry-run', 'enforce', 'dry-run'], // first seen in dry-run, enforce later: still no action (AC7)
    ['enforce', 'dry-run', 'dry-run'],
    ['off', 'enforce', 'off'],
    ['enforce', 'off', 'off'],
  ])('first %s, current %s gives %s', (first, mode, expected) => {
    expect(effectiveMode(cfg({ mode }), first)).toBe(expected);
  });
});

// Plan 5.2: effective repost mode = the lower of mode, repostMode and post.firstRepostMode.
describe('effectiveRepostMode', () => {
  const repost = (mode: Mode): RepostConfig => ({
    mode,
    reportOnly: true,
    months: 6,
    reportAt: 94,
    removeAt: 98,
    gate: 22,
    ncc: 0.8,
    minTiles: 85,
  });

  it.each<[Mode, Mode | undefined, Mode, Mode]>([
    ['enforce', 'enforce', 'enforce', 'enforce'],
    ['enforce', 'dry-run', 'enforce', 'dry-run'], // repostMode dry-run while mode is enforce (AC7)
    ['enforce', 'enforce', 'dry-run', 'dry-run'], // firstRepostMode dry-run
    ['dry-run', 'enforce', 'enforce', 'dry-run'],
    ['off', 'enforce', 'enforce', 'off'],
    ['enforce', undefined, 'enforce', 'off'], // repost rule off
  ])('mode %s, repostMode %s, first %s gives %s', (mode, repostMode, first, expected) => {
    expect(effectiveRepostMode(cfg({ mode, repost: repostMode && repost(repostMode) }), first)).toBe(expected);
  });
});

// Plan 5.2 "Image post": a Reddit image post or gallery; a crosspost uses the parent's images; only png, jpg, jpeg;
// URLs normalized to https://i.redd.it/<id>.<ext>. Legacy: L§5.1 (url regexes) and L§5.2 (extension filter).
describe('postImages', () => {
  const VALID = 1;
  const entry = (url: string, width = 1920, height = 1080, status = VALID) => ({ url, width, height, status });

  it('gives the image of a Reddit image post, with the preview URL normalized to i.redd.it', () => {
    const post = {
      url: 'https://i.redd.it/abc123.png',
      gallery: [entry('https://preview.redd.it/abc123.png?width=640&crop=smart&auto=webp&s=0f')],
    };
    expect(postImages(post)).toEqual([{ n: 1, url: 'https://i.redd.it/abc123.png', width: 1920, height: 1080 }]);
  });
  const gallery = 'https://www.reddit.com/gallery/xyz789';

  it('numbers the images of a gallery by position and keeps the position when it skips an entry', () => {
    const post = {
      url: gallery,
      gallery: [
        entry('https://i.redd.it/a1.png', 1920, 1080),
        entry('https://i.redd.it/a2.gif', 500, 500),
        entry('https://i.redd.it/a3.jpg', 900, 1600),
        entry('https://i.redd.it/a4.webp', 900, 1600),
        entry('https://i.redd.it/a5.jpeg', 1600, 900),
      ],
    };
    expect(postImages(post)).toEqual([
      { n: 1, url: 'https://i.redd.it/a1.png', width: 1920, height: 1080 },
      { n: 3, url: 'https://i.redd.it/a3.jpg', width: 900, height: 1600 },
      { n: 5, url: 'https://i.redd.it/a5.jpeg', width: 1600, height: 900 },
    ]);
  });

  it('skips an entry that is not VALID (UNKNOWN 0, FAILED 2) or has no size', () => {
    const post = {
      url: gallery,
      gallery: [
        entry('https://i.redd.it/b1.png', 1920, 1080, 0),
        entry('https://i.redd.it/b2.png', 1920, 1080, 2),
        entry('https://i.redd.it/b3.png', 0, 1080),
        entry('https://i.redd.it/b4.png', 1920, 0),
        entry('https://i.redd.it/b5.png', 1920, 1080),
      ],
    };
    expect(postImages(post).map((i) => i.n)).toEqual([5]);
  });
  // S2 (c): the gallery of a link or video post holds only a preview of the link or video. It is not a checked image.
  it('gives no images for a link post or a video post', () => {
    const preview = [entry('https://preview.redd.it/zzz.jpg?width=640&auto=webp&s=ab')];
    expect(postImages({ url: 'https://imgur.com/a/Ab3dE', gallery: preview })).toEqual([]);
    expect(postImages({ url: 'https://v.redd.it/vid123', gallery: preview })).toEqual([]);
    expect(postImages({ url: 'https://www.reddit.com/r/Animewallpaper/comments/abc/title/', gallery: [] })).toEqual([]);
  });
  // R15, AC19: a crosspost uses the images of its parent post (legacy PR #20, #26).
  it('uses the images of the parent for a crosspost, for a single image and for a gallery', () => {
    const single = { url: 'https://i.redd.it/p1.png', gallery: [entry('https://i.redd.it/p1.png', 3840, 2160)] };
    const multi = {
      url: gallery,
      gallery: [entry('https://i.redd.it/q1.png', 900, 1600), entry('https://i.redd.it/q2.png', 900, 1600)],
    };
    // The crosspost holds a preview of its own that must not be checked.
    const cross = { url: gallery, gallery: [entry('https://i.redd.it/own.png', 100, 100)], crosspostParentId: 't3_par' };
    expect(postImages(cross, single)).toEqual([{ n: 1, url: 'https://i.redd.it/p1.png', width: 3840, height: 2160 }]);
    expect(postImages(cross, multi).map((i) => i.url)).toEqual(['https://i.redd.it/q1.png', 'https://i.redd.it/q2.png']);
  });

  it('gives no images for a crosspost whose parent is not available', () => {
    const cross = { url: gallery, gallery: [entry('https://i.redd.it/own.png')], crosspostParentId: 't3_par' };
    expect(postImages(cross)).toEqual([]);
  });
});
