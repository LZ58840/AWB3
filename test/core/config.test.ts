import { describe, expect, it } from 'vitest';
import { parseConfig, validateSetting } from '../../src/core/config';

// Expected values: plan 5.6 "Install settings" (types, defaults, ranges) and 5.2 (a rule that is off has no entry).
describe('parseConfig: defaults', () => {
  it('turns everything off for empty settings', () => {
    const { config, problems } = parseConfig({});
    expect(config).toEqual({
      mode: 'off',
      exceptAuthors: [],
      flairRules: new Map(),
      resolutionMismatch: false,
      canary: false,
    });
    expect(problems).toEqual([]);
  });
});

describe('parseConfig: mode', () => {
  it.each(['off', 'dry-run', 'enforce'] as const)('reads %s', (mode) => {
    expect(parseConfig({ mode }).config.mode).toBe(mode);
  });

  // Real Devvit: a select setting is an array once a mod has set it (['enforce']), and the plain default string
  // ('off') while it was never set.
  it.each(['off', 'dry-run', 'enforce'] as const)('reads the array form [%j]', (mode) => {
    expect(parseConfig({ mode: [mode] })).toMatchObject({ config: { mode }, problems: [] });
  });

  // Each case is wrapped in one more array, because `it.each` spreads the arrays of a row into arguments.
  it.each([[['banana']], [[]], [['enforce', 'off']], [['']], [[['enforce']]]])('turns the app off for the array %j', (mode) => {
    const { config, problems } = parseConfig({ mode });
    expect(config.mode).toBe('off');
    expect(problems).toEqual(['mode: Choose off, dry-run or enforce.']);
  });

  it.each(['banana', '', null, 5, {}, true])('turns the app off and reports a problem for %j', (mode) => {
    const { config, problems } = parseConfig({ mode });
    expect(config.mode).toBe('off');
    expect(problems).toEqual(['mode: Choose off, dry-run or enforce.']);
  });
});

// Legacy except_authors: exact user names (L§1.9). A user name holds letters, digits, "_" and "-" (no "u/").
describe('parseConfig: exceptAuthors', () => {
  it('reads a comma list and drops empty items', () => {
    expect(parseConfig({ exceptAuthors: 'AutoModerator, Some_User ,,Third-One' }).config.exceptAuthors).toEqual([
      'AutoModerator',
      'Some_User',
      'Third-One',
    ]);
    expect(parseConfig({ exceptAuthors: ' , ' }).config.exceptAuthors).toEqual([]);
  });

  // Legacy stopped all moderation on a config error (L§1.10). A lost exemption must never cause a removal, so the
  // app stops (mode off, repost off) and the problem goes to the `config` alert.
  it.each(['u/Foo', '/u/Foo', 'Foo Bar', 'Foo;Bar'])('reports a problem for %j and stops all moderation', (text) => {
    const { config, problems } = parseConfig({ mode: 'enforce', repostMode: 'enforce', exceptAuthors: text });
    expect(config.exceptAuthors).toEqual([]);
    expect(config.mode).toBe('off');
    expect(config.repost).toBeUndefined();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^exceptAuthors: Bad user name "/);
  });
});

describe('parseConfig: flairRules', () => {
  it('parses the lines', () => {
    const { config, problems } = parseConfig({ flairRules: 'Desktop: horizontal\nOther: skip' });
    expect([...config.flairRules]).toEqual([
      ['Desktop', ['horizontal']],
      ['Other', 'skip'],
    ]);
    expect(problems).toEqual([]);
  });

  // A lost skip flair must never cause a removal: a bad line stops all moderation (mode off, repost off).
  it('reports a problem for a bad line and stops all moderation', () => {
    const { config, problems } = parseConfig({ mode: 'enforce', repostMode: 'enforce', flairRules: 'Desktop: horizontal\nOther skip' });
    expect(config.flairRules.size).toBe(0);
    expect(config.mode).toBe('off');
    expect(config.repost).toBeUndefined();
    expect(problems).toEqual(['flairRules: Bad line "Other skip". Write Flair: skip, or Flair: horizontal, vertical, square.']);
  });

  it('keeps the mode when the exemptions are good', () => {
    const { config, problems } = parseConfig({
      mode: 'enforce',
      repostMode: 'dry-run',
      exceptAuthors: 'AutoModerator',
      flairRules: 'Other: skip',
    });
    expect(config.mode).toBe('enforce');
    expect(config.repost?.mode).toBe('dry-run');
    expect(problems).toEqual([]);
  });
});

// Plan 5.6 and AC10: a rule that is on with no threshold, or with a bad value, is off, and a problem is reported.
describe('parseConfig: resolutionBad', () => {
  it('keeps only the orientations that have a size (legacy: an empty size is null and is not checked)', () => {
    const { config, problems } = parseConfig({
      resolutionBad: true,
      minHorizontal: '1920x1080',
      minVertical: '900x1600',
      minSquare: '',
    });
    expect(config.resolutionBad).toEqual({
      horizontal: { width: 1920, height: 1080 },
      vertical: { width: 900, height: 1600 },
    });
    expect(problems).toEqual([]);
  });

  it('is off when the switch is off, whatever the sizes', () => {
    const { config, problems } = parseConfig({ resolutionBad: false, minHorizontal: '1920x1080' });
    expect(config.resolutionBad).toBeUndefined();
    expect(problems).toEqual([]);
  });

  it('is off, with a problem, when it is on and no size is set', () => {
    const { config, problems } = parseConfig({ resolutionBad: true, minHorizontal: '', minVertical: '  ' });
    expect(config.resolutionBad).toBeUndefined();
    expect(problems).toEqual(['resolutionBad: Set at least one minimum size.']);
  });

  it('is off, with a problem that names the setting, when a size is bad', () => {
    const { config, problems } = parseConfig({ resolutionBad: true, minHorizontal: '1920x1080', minVertical: 'big' });
    expect(config.resolutionBad).toBeUndefined();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^resolutionBad: minVertical: .*WxH/);
  });
});

describe('parseConfig: aspectRatio', () => {
  it('keeps only the orientations that have a limit', () => {
    const { config, problems } = parseConfig({
      aspectRatio: true,
      aspectHorizontal: '16:10 to none',
      aspectVertical: '',
    });
    expect(config.aspectRatio).toEqual({ horizontal: { lower: { a: 16, b: 10, milli: 1600 } } });
    expect(problems).toEqual([]);
  });

  it('is off, with a problem, when it is on and no limit is set (also "none to none")', () => {
    for (const aspectHorizontal of ['', 'none to none']) {
      const { config, problems } = parseConfig({ aspectRatio: true, aspectHorizontal });
      expect(config.aspectRatio).toBeUndefined();
      expect(problems).toEqual(['aspectRatio: Set at least one limit.']);
    }
  });

  it('is off, with a problem that names the setting, when a value is bad', () => {
    const { config, problems } = parseConfig({ aspectRatio: true, aspectHorizontal: '16:10', aspectVertical: '9:21 to 10:16' });
    expect(config.aspectRatio).toBeUndefined();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^aspectRatio: aspectHorizontal: .*A:B to C:D/);
  });

  it('is off when the switch is off', () => {
    expect(parseConfig({ aspectRatio: false, aspectHorizontal: '16:10 to none' }).config.aspectRatio).toBeUndefined();
  });
});

// Plan 5.6 defaults: rateLimitHours 24, rateLimitPosts 4, rateLimitCountDeleted false, sourceHours 1.
// Ranges (own choice, plan 5.5 "rate window max 30 days"): hours 1 to 720, posts 1 to 1000. sourceHours 0.01 to 696: the post record lives
// 30 days (720 hours), and the source check at its deadline needs it, so the deadline stays 24 hours inside that.
describe('parseConfig: rateLimit', () => {
  it('uses the defaults when the switch is on and the numbers are not set', () => {
    expect(parseConfig({ rateLimit: true }).config.rateLimit).toEqual({ hours: 24, posts: 4, countDeleted: false });
    expect(parseConfig({ rateLimit: true, rateLimitHours: null, rateLimitPosts: undefined }).config.rateLimit).toEqual({
      hours: 24,
      posts: 4,
      countDeleted: false,
    });
  });

  it('uses the defaults for an empty text', () => {
    expect(parseConfig({ rateLimit: true, rateLimitHours: '', rateLimitPosts: '' }).config.rateLimit).toEqual({
      hours: 24,
      posts: 4,
      countDeleted: false,
    });
    expect(validateSetting('rateLimitHours', '')).toBeUndefined();
  });

  it('reads the numbers and the deleted-posts switch', () => {
    const { config, problems } = parseConfig({
      rateLimit: true,
      rateLimitHours: 12,
      rateLimitPosts: 3,
      rateLimitCountDeleted: true,
    });
    expect(config.rateLimit).toEqual({ hours: 12, posts: 3, countDeleted: true });
    expect(problems).toEqual([]);
  });

  it.each([
    ['rateLimitHours', 0],
    ['rateLimitHours', 721],
    ['rateLimitHours', 1.5],
    ['rateLimitHours', '24'],
    ['rateLimitPosts', 0],
    ['rateLimitPosts', 1001],
    ['rateLimitPosts', 2.5],
    ['rateLimitPosts', Number.NaN],
  ])('is off, with a problem that names the setting, for %s = %j', (key, value) => {
    const { config, problems } = parseConfig({ rateLimit: true, [key]: value });
    expect(config.rateLimit).toBeUndefined();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^rateLimit: ${key}: Write a whole number from 1 to `));
  });

  it('is off when the switch is off', () => {
    expect(parseConfig({ rateLimit: false }).config.rateLimit).toBeUndefined();
  });
});

describe('parseConfig: sourceComment', () => {
  it('uses 1 hour by default and reads a fraction', () => {
    expect(parseConfig({ sourceComment: true }).config.sourceComment).toEqual({ hours: 1 });
    expect(parseConfig({ sourceComment: true, sourceHours: 0.5 }).config.sourceComment).toEqual({ hours: 0.5 });
    expect(parseConfig({ sourceComment: true, sourceHours: 0.01 }).config.sourceComment).toEqual({ hours: 0.01 });
    expect(parseConfig({ sourceComment: true, sourceHours: 696 }).config.sourceComment).toEqual({ hours: 696 });
  });

  it.each([0, 0.009, 696.5, 697, 721, -1, 'one'])('is off, with a problem, for sourceHours = %j', (value) => {
    const { config, problems } = parseConfig({ sourceComment: true, sourceHours: value });
    expect(config.sourceComment).toBeUndefined();
    expect(problems).toEqual(['sourceComment: sourceHours: Write a number from 0.01 to 696.']);
  });

  it('is off when the switch is off', () => {
    expect(parseConfig({ sourceComment: false, sourceHours: 2 }).config.sourceComment).toBeUndefined();
  });
});

// Plan 5.6 (3.1): repostMode off, repostReportOnly true, repostMonths 6 (1 to 8, OD3), repostReportAt 94 (85 to 100),
// repostRemoveAt 98 (90 to 100), repostGate 22 (10 to 30), repostNcc 0.80 (0.5 to 0.99), repostMinTiles 85 (70 to 100).
describe('parseConfig: repost', () => {
  const defaults = { reportOnly: true, months: 6, reportAt: 94, removeAt: 98, gate: 22, ncc: 0.8, minTiles: 85 };

  it('is off when repostMode is off or not set', () => {
    expect(parseConfig({}).config.repost).toBeUndefined();
    expect(parseConfig({ repostMode: 'off', repostMonths: 99 })).toMatchObject({ config: { repost: undefined }, problems: [] });
  });

  it('reads repostMode as an array, as real Devvit gives a select setting that a mod has set', () => {
    expect(parseConfig({ repostMode: ['dry-run'] }).config.repost).toEqual({ mode: 'dry-run', ...defaults });
    expect(parseConfig({ repostMode: ['enforce'] }).config.repost).toEqual({ mode: 'enforce', ...defaults });
    expect(parseConfig({ repostMode: ['off'] })).toMatchObject({ config: { repost: undefined }, problems: [] });
  });

  it.each([[['banana']], [[]], [['enforce', 'off']]])('is off, with a problem, for the repostMode array %j', (repostMode) => {
    const { config, problems } = parseConfig({ repostMode });
    expect(config.repost).toBeUndefined();
    expect(problems).toEqual(['repostMode: Choose off, dry-run or enforce.']);
  });

  it('uses the defaults for dry-run and enforce', () => {
    expect(parseConfig({ repostMode: 'dry-run' }).config.repost).toEqual({ mode: 'dry-run', ...defaults });
    expect(parseConfig({ repostMode: 'enforce' }).config.repost).toEqual({ mode: 'enforce', ...defaults });
  });

  it('reads all values', () => {
    const { config, problems } = parseConfig({
      repostMode: 'enforce',
      repostReportOnly: false,
      repostMonths: 8,
      repostReportAt: 90,
      repostRemoveAt: 100,
      repostGate: 18,
      repostNcc: 0.9,
      repostMinTiles: 80,
    });
    expect(config.repost).toEqual({
      mode: 'enforce',
      reportOnly: false,
      months: 8,
      reportAt: 90,
      removeAt: 100,
      gate: 18,
      ncc: 0.9,
      minTiles: 80,
    });
    expect(problems).toEqual([]);
  });

  it.each([
    ['repostMonths', 0],
    ['repostMonths', 9],
    ['repostMonths', 6.5],
    ['repostReportAt', 84.9],
    ['repostReportAt', 100.1],
    ['repostRemoveAt', 89.9],
    ['repostGate', 9],
    ['repostGate', 31],
    ['repostNcc', 0.49],
    ['repostNcc', 1],
    ['repostMinTiles', 69],
    ['repostMinTiles', 101],
  ])('is off, with a problem that names the setting, for %s = %j', (key, value) => {
    const { config, problems } = parseConfig({ repostMode: 'dry-run', [key]: value });
    expect(config.repost).toBeUndefined();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^repostMode: ${key}: Write a (whole )?number from `));
  });

  it('is off, with a problem, when the remove threshold is below the report threshold', () => {
    const { config, problems } = parseConfig({ repostMode: 'enforce', repostReportAt: 99, repostRemoveAt: 95 });
    expect(config.repost).toBeUndefined();
    expect(problems).toEqual(['repostMode: repostRemoveAt must not be below repostReportAt.']);
  });

  it('accepts equal report and remove thresholds', () => {
    const { config, problems } = parseConfig({ repostMode: 'enforce', repostReportAt: 95, repostRemoveAt: 95 });
    expect(config.repost).toMatchObject({ reportAt: 95, removeAt: 95 });
    expect(problems).toEqual([]);
  });

  it('is off, with a problem, for an unknown repostMode', () => {
    const { config, problems } = parseConfig({ repostMode: 'banana' });
    expect(config.repost).toBeUndefined();
    expect(problems).toEqual(['repostMode: Choose off, dry-run or enforce.']);
  });
});

describe('parseConfig: switches', () => {
  it('reads resolutionMismatch and canary as on only for true', () => {
    expect(parseConfig({ resolutionMismatch: true, canary: true }).config).toMatchObject({ resolutionMismatch: true, canary: true });
    expect(parseConfig({ resolutionMismatch: false, canary: false }).config).toMatchObject({ resolutionMismatch: false, canary: false });
    expect(parseConfig({ resolutionMismatch: 'true', canary: 1 }).config).toMatchObject({ resolutionMismatch: false, canary: false });
  });

  it('collects the problems of several settings and keeps the good ones', () => {
    const { config, problems } = parseConfig({
      mode: 'enforce',
      resolutionBad: true,
      minHorizontal: 'big',
      rateLimit: true,
      rateLimitHours: 0,
      sourceComment: true,
    });
    expect(config.mode).toBe('enforce');
    expect(config.sourceComment).toEqual({ hours: 1 });
    expect(config.resolutionBad).toBeUndefined();
    expect(config.rateLimit).toBeUndefined();
    expect(problems.map((p) => p.split(':')[0]).sort()).toEqual(['rateLimit', 'resolutionBad']);
  });
});

// The validation routes (plan 5.6 and AC10, D8) check one setting at a time. They give the message for the mod,
// or undefined when the value is good. An empty size or limit is good: it means "not set".
describe('validateSetting', () => {
  it.each([
    ['minHorizontal', '1920x1080'],
    ['minVertical', ''],
    ['minSquare', undefined],
    ['aspectHorizontal', '16:10 to none'],
    ['aspectVertical', '9:21 to 10:16'],
    ['exceptAuthors', 'AutoModerator, Foo'],
    ['flairRules', 'Desktop: horizontal\nOther: skip'],
    ['rateLimitHours', 24],
    ['rateLimitPosts', undefined],
    ['sourceHours', 0.5],
    ['repostMonths', 8],
    ['repostNcc', 0.99],
    ['mode', 'anything'], // selects and switches are not checked here
    ['unknownSetting', 'x'],
    ['constructor', 'x'],
  ])('accepts %s = %j', (key, value) => {
    expect(validateSetting(key, value)).toBeUndefined();
  });

  it.each([
    ['minHorizontal', 'big', 'Write the size as WxH, for example 1920x1080.'],
    ['minSquare', '1000', 'Write the size as WxH, for example 1920x1080.'],
    ['aspectHorizontal', '16:10', 'Write the limits as A:B to C:D, for example 16:10 to none.'],
    ['aspectVertical', 'a:b to c:d', 'Write the limits as A:B to C:D, for example 16:10 to none.'],
    ['aspectVertical', '10:16 to 9:21', 'The first limit must not be larger than the second limit, for example 9:21 to 10:16.'],
    ['exceptAuthors', 'u/Foo', 'Bad user name "u/Foo". Write names without u/, separated by commas.'],
    ['flairRules', 'Desktop horizontal', 'Bad line "Desktop horizontal". Write Flair: skip, or Flair: horizontal, vertical, square.'],
    ['rateLimitHours', 0, 'Write a whole number from 1 to 720.'],
    ['rateLimitPosts', 1.5, 'Write a whole number from 1 to 1000.'],
    ['sourceHours', 697, 'Write a number from 0.01 to 696.'],
    ['repostMonths', 9, 'Write a whole number from 1 to 8.'],
    ['repostReportAt', 80, 'Write a number from 85 to 100.'],
    ['repostRemoveAt', 89, 'Write a number from 90 to 100.'],
    ['repostGate', 40, 'Write a number from 10 to 30.'],
    ['repostNcc', 1, 'Write a number from 0.5 to 0.99.'],
    ['repostMinTiles', 50, 'Write a number from 70 to 100.'],
  ])('rejects %s = %j with a message', (key, value, message) => {
    expect(validateSetting(key, value)).toBe(message);
  });
});
