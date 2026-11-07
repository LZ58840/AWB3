import { describe, expect, it } from 'vitest';
import { REPORT_REASON, renderComment } from '../../src/core/messages';
import type { Failure } from '../../src/core/types';
import { A1, A2, A3, A4, A5 } from './appendix';
import {
  ASPECT_MIXED,
  BAD_RESOLUTION_ALL_ORIENTATIONS,
  FLAIR_MULTI,
  LIMIT_16_9_TO_4_3,
  LIMIT_BOTH,
  LIMIT_BOTH_INTEGER,
  LIMIT_LOWER_ONLY,
  LIMIT_UPPER_ONLY,
  MISMATCH_TWO_TAGS,
  TWO_REASONS_PHONE_SUB,
} from './legacyText';

const u = (name: string) => `https://i.redd.it/${name}.png`;
const image = (n: number, width: number, height: number, name: string) => ({ n, url: u(name), width, height });

describe('renderComment: flair', () => {
  it('renders L Appendix A2 (one reason, one vertical image)', () => {
    const image = { n: 1, url: 'https://i.redd.it/v1.jpg', width: 900, height: 1600 };
    const failures = [{ rule: 'flair' as const, flair: 'Desktop', sections: [{ orientation: 'vertical' as const, images: [image] }] }];
    expect(renderComment('Animewallpaper', failures)).toBe(A2);
  });
});

describe('renderComment: source comment', () => {
  it('renders L Appendix A4 (timeout 1 hour)', () => {
    expect(renderComment('Animewallpaper', [{ rule: 'sourceComment', hours: 1 }])).toBe(A4);
  });

  it('writes "hours" for any other number, as legacy (`many` is "s" when the number is not 1)', () => {
    const timeout = (hours: number) => renderComment('Animewallpaper', [{ rule: 'sourceComment', hours }]);
    expect(timeout(2)).toBe(A4.replace('Timeout after 1 hour.', 'Timeout after 2 hours.'));
    expect(timeout(0.5)).toBe(A4.replace('Timeout after 1 hour.', 'Timeout after 0.5 hours.'));
  });
});

describe('renderComment: rate limit', () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const T = Date.UTC(2024, 11, 4, 11, 35, 0);
  // Ages relative to the current post, as in L Appendix A3: just now, 1 h 1 min, 5 h, 20 h 15 min.
  const rate = (countDeleted: boolean, prefix = '') => ({
    rule: 'rateLimit' as const,
    posts: 4,
    hours: 24,
    countDeleted,
    createdAt: T,
    recent: [
      { id: `${prefix}p4`, createdAt: T - 30_000 },
      { id: `${prefix}p3`, createdAt: T - HOUR - MIN },
      { id: `${prefix}p2`, createdAt: T - 5 * HOUR },
      { id: `${prefix}p1`, createdAt: T - 20 * HOUR - 15 * MIN },
    ],
    nextAt: T - 20 * HOUR - 15 * MIN + 24 * HOUR, // 2024-12-04 15:20:00 UTC
  });

  it('renders L Appendix A3 (deleted posts count)', () => {
    expect(renderComment('Animewallpaper', [rate(true)])).toBe(A3);
  });

  // Devvit post ids are fullnames (t3_xxx). The link is https://redd.it/<id> and the link text is the id, both
  // without the prefix (L Appendix A3: "[p4](https://redd.it/p4)").
  it('writes a Devvit post id (t3_ prefix) as legacy wrote the id', () => {
    expect(renderComment('Animewallpaper', [rate(true, 't3_')])).toBe(A3);
  });

  it('ends the section with a space when deleted posts do not count (legacy `{incl_deleted}` is empty)', () => {
    const noDeleted = A3.replace('Deleted submissions will still be counted towards the rate limit.', '');
    expect(noDeleted).toContain('to submit again. \n\n*I am a bot');
    expect(renderComment('Animewallpaper', [rate(false)])).toBe(noDeleted);
  });
});

describe('renderComment: repost', () => {
  const T = Date.UTC(2024, 11, 4, 12, 0, 0);
  const repost = (months: number, similarity: number, matchPostId = '1abcde') => ({
    rule: 'repost' as const,
    months,
    createdAt: T,
    matches: [
      {
        n: 1,
        url: 'https://i.redd.it/new.png',
        matchPostId,
        matchUrl: 'https://i.redd.it/old.png',
        matchCreatedAt: Date.UTC(2024, 9, 4, 12, 0, 0), // two months before
        similarity,
      },
    ],
  });

  it('renders L Appendix A5 (6 months, one match)', () => {
    expect(renderComment('Animewallpaper', [repost(6, 87.65)])).toBe(A5);
  });

  it('writes the id of a matched Devvit post (t3_ prefix) as legacy wrote it (A5)', () => {
    expect(renderComment('Animewallpaper', [repost(6, 87.65, 't3_1abcde')])).toBe(A5);
  });

  it('writes "month" for 1 month', () => {
    const one = A5.replace('in the last 6 months.', 'in the last 1 month.');
    expect(renderComment('Animewallpaper', [repost(1, 87.65)])).toBe(one);
  });

  // D16: the certainty is the similarity percent (steps of 1.5625%), written with 2 decimals; a tie rounds up.
  it.each([
    [100, '100.00%'],
    [98.4375, '98.44%'],
    [96.875, '96.88%'],
    [93.75, '93.75%'],
  ])('writes a similarity of %f as %s', (similarity, text) => {
    expect(renderComment('Animewallpaper', [repost(6, similarity)])).toBe(
      A5.replace('87.65%', text),
    );
  });

  it('lists each match on its own line', () => {
    const two = repost(6, 87.65);
    two.matches.push({ ...two.matches[0]!, n: 2, matchPostId: '2fghij' });
    expect(renderComment('Animewallpaper', [two])).toContain(
      '\n\n\t\t- [Image #2](https://i.redd.it/new.png) matched submission [2fghij](https://redd.it/2fghij) (2 months ago, [87.65% certainty](https://i.redd.it/old.png))',
    );
  });
});

describe('renderComment: resolution and aspect ratio', () => {
  const image = { n: 1, url: 'https://i.redd.it/abc123.png', width: 1600, height: 1200 };

  it('renders L Appendix A1 (three reasons: mismatch, bad resolution, bad aspect ratio)', () => {
    const failures = [
      { rule: 'resolutionMismatch' as const, tagged: [{ width: 1920, height: 1080 }], mismatched: [{ width: 1600, height: 1200 }] },
      {
        rule: 'resolutionBad' as const,
        sections: [{ orientation: 'horizontal' as const, min: { width: 1920, height: 1080 }, images: [image] }],
      },
      {
        rule: 'aspectRatio' as const,
        sections: [
          {
            orientation: 'horizontal' as const,
            limits: { lower: { a: 16, b: 10, milli: 1600 } },
            tall: [image],
            wide: [],
          },
        ],
      },
    ];
    expect(renderComment('Animewallpaper', failures)).toBe(A1);
  });
});

// Expected texts: legacy output (see legacyText.ts).
describe('renderComment: variants of the legacy templates', () => {
  const one = (f: Failure) => renderComment('Animewallpaper', [f]);

  it('writes the plural forms of the mismatch text when the title has 2 tags', () => {
    const f: Failure = {
      rule: 'resolutionMismatch',
      tagged: [{ width: 1920, height: 1080 }, { width: 3840, height: 2160 }],
      mismatched: [{ width: 1600, height: 1200 }, { width: 1280, height: 720 }],
    };
    expect(one(f)).toContain(MISMATCH_TWO_TAGS);
  });

  it('writes a section for each orientation, with "are" for many images and "is" for one', () => {
    const f: Failure = {
      rule: 'resolutionBad',
      sections: [
        { orientation: 'horizontal', min: { width: 1920, height: 1080 }, images: [image(1, 1600, 1200, 'g1'), image(3, 1280, 720, 'g3')] },
        { orientation: 'vertical', min: { width: 900, height: 1600 }, images: [image(2, 800, 1500, 'g2')] },
        { orientation: 'square', min: { width: 1000, height: 1000 }, images: [image(4, 500, 500, 'g4')] },
      ],
    };
    expect(one(f)).toContain(BAD_RESOLUTION_ALL_ORIENTATIONS);
  });

  it('writes the tall and the wide images of each orientation, with the ratio of each image', () => {
    const f: Failure = {
      rule: 'aspectRatio',
      sections: [
        {
          orientation: 'horizontal',
          limits: { lower: { a: 16, b: 10, milli: 1600 }, upper: { a: 2, b: 1, milli: 2000 } },
          tall: [image(1, 1600, 1200, 'r1')],
          wide: [image(2, 2400, 1000, 'r2'), image(4, 2100, 1000, 'r4')],
        },
        {
          orientation: 'vertical',
          limits: { upper: { a: 10, b: 16, milli: 625 } },
          tall: [],
          wide: [image(3, 1080, 1440, 'r3')],
        },
      ],
    };
    expect(one(f)).toContain(ASPECT_MIXED);
  });

  // Legacy MySQL ROUND(5870 / 3670, 3) = 1.600 (4 decimals, then 3). Owner: confirm with `SELECT ROUND(5870/3670, 3);`.
  it('writes the ratio of an image as legacy MySQL rounds it (twice)', () => {
    const f: Failure = {
      rule: 'aspectRatio',
      sections: [{ orientation: 'horizontal', limits: { upper: { a: 3, b: 2, milli: 1500 } }, tall: [], wide: [image(1, 5870, 3670, 'w')] }],
    };
    expect(one(f)).toContain('[Image #1 (1.600:1)](https://i.redd.it/w.png) is too wide.');
  });

  it.each([
    [{ lower: { a: 16, b: 10, milli: 1600 } }, LIMIT_LOWER_ONLY],
    [{ upper: { a: 21, b: 9, milli: 2333 } }, LIMIT_UPPER_ONLY],
    [{ lower: { a: 9, b: 21, milli: 429 }, upper: { a: 10, b: 16, milli: 625 } }, LIMIT_BOTH],
    [{ lower: { a: 1, b: 1, milli: 1000 }, upper: { a: 2, b: 1, milli: 2000 } }, LIMIT_BOTH_INTEGER], // Python prints 1.0 and 2.0
    [{ lower: { a: 16, b: 9, milli: 1778 }, upper: { a: 4, b: 3, milli: 1333 } }, LIMIT_16_9_TO_4_3],
  ])('writes the limits %j as "%s"', (limits, text) => {
    const f: Failure = {
      rule: 'aspectRatio',
      sections: [{ orientation: 'horizontal', limits, tall: [image(1, 1000, 900, 'x')], wide: [] }],
    };
    expect(one(f)).toContain(`aspect ratio **${text}**.`);
  });

  it('writes a section for each orientation of the flair rule', () => {
    const f: Failure = {
      rule: 'flair',
      flair: 'Art',
      sections: [
        { orientation: 'horizontal', images: [image(1, 1920, 1080, 'f1'), image(2, 1600, 900, 'f2')] },
        { orientation: 'square', images: [image(3, 500, 500, 'f3')] },
      ],
    };
    expect(one(f)).toContain(FLAIR_MULTI);
  });

  it('counts the reasons: the flair rule is one reason, and "reasons" is plural for 2', () => {
    const flair: Failure = {
      rule: 'flair',
      flair: 'Art',
      sections: [
        { orientation: 'horizontal', images: [image(1, 1920, 1080, 'f1'), image(2, 1600, 900, 'f2')] },
        { orientation: 'square', images: [image(3, 500, 500, 'f3')] },
      ],
    };
    expect(renderComment('AnimePhoneWallpapers', [flair, { rule: 'sourceComment', hours: 2 }])).toBe(TWO_REASONS_PHONE_SUB);
  });
});

// D1 (the owner decides by 2026-11-13). Plan recommendation: an image is numbered by its gallery position.
// Legacy numbers only the failed images. Gallery: image 1 passes, images 2 and 3 are vertical under a horizontal flair.
// Legacy text: "[Image #1](...), [Image #2](...) are vertical." To revert D1, change `imageLink` in messages.ts and this test.
describe('renderComment: D1 image numbers', () => {
  it('numbers a failed image by its gallery position', () => {
    const f: Failure = {
      rule: 'flair',
      flair: 'Desktop',
      sections: [{ orientation: 'vertical', images: [image(2, 900, 1600, 'd2'), image(3, 900, 1600, 'd3')] }],
    };
    expect(renderComment('Animewallpaper', [f])).toContain(
      '\n\n- Vertical images are not allowed under the **Desktop** flair.\n\n\t- [Image #2](https://i.redd.it/d2.png), [Image #3](https://i.redd.it/d3.png) are vertical.',
    );
  });
});

// L§2.2 "Report reason (warning path)", moderator_worker/__init__.py:121.
describe('REPORT_REASON', () => {
  it('is the legacy report text', () => {
    expect(REPORT_REASON).toBe('Submission flagged for manual review (see comment)');
  });
});
