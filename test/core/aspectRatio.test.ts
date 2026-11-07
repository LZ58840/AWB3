import { describe, expect, it } from 'vitest';
import { checkAspect, imageRatioMilli, parseAspect, ratioMilli } from '../../src/core/rules/aspectRatio';
import { img } from './helpers';

// Round half up to 3 decimals, as thousandths (legacy `normal_round(a / b, 3)`, utils.py:160, and MySQL ROUND(w / h, 3)).
// Expected values: hand computation.
describe('ratioMilli', () => {
  it.each([
    [1600, 1200, 1333], // 1.33333
    [1920, 1080, 1778], // 1.77777
    [16, 10, 1600], // 1.6
    [9, 21, 429], // 0.428571
    [10, 16, 625], // 0.625
    [1000, 1000, 1000],
  ])('%i/%i gives %i', (a, b, milli) => {
    expect(ratioMilli(a, b)).toBe(milli);
  });

  it('rounds a tie up', () => {
    expect(ratioMilli(17, 16)).toBe(1063); // 1.0625 -> 1.063 (round half to even would give 1.062)
    expect(ratioMilli(2001, 2000)).toBe(1001); // 1.0005 -> 1.001
    expect(ratioMilli(323, 80)).toBe(4038); // 4.0375 exactly -> 4.038 (a float formula gives 4.037)
  });
});

// Legacy computes the ratio of an IMAGE in MySQL: ROUND(width / height, 3). INT / INT is a DECIMAL with 4 decimals
// (rounded half up), and ROUND rounds that again. Expected values: Python decimal arithmetic with the same two
// roundings (checked for all 399 x 399 pairs), and the review examples 5870x3670, 587x367 and 167x105.
describe('imageRatioMilli', () => {
  it.each([
    [5870, 3670, 1600], // 1.599455 -> 1.5995 -> 1.600 (one rounding would give 1.599)
    [587, 367, 1600],
    [167, 105, 1591], // 1.590476 -> 1.5905 -> 1.591 (one rounding would give 1.590)
    [1600, 1200, 1333],
    [1920, 1080, 1778],
    [17, 16, 1063], // 1.0625 is a tie at 3 decimals
    [323, 80, 4038], // 4.0375 is a tie at 3 decimals
    [1000, 1600, 625],
  ])('%ix%i gives %i', (width, height, milli) => {
    expect(imageRatioMilli(width, height)).toBe(milli);
  });
});

// Settings aspectHorizontal, aspectVertical: `A:B to C:D`. The first ratio is the lower limit of width/height,
// the second the upper limit; `none` means no limit on that side (legacy L§1.4). An empty value means "not set".
describe('parseAspect', () => {
  it('reads the legacy production values', () => {
    expect(parseAspect('16:10 to none')).toEqual({ lower: { a: 16, b: 10, milli: 1600 } });
    expect(parseAspect('9:21 to 10:16')).toEqual({
      lower: { a: 9, b: 21, milli: 429 },
      upper: { a: 10, b: 16, milli: 625 },
    });
  });

  it('reads an upper limit only', () => {
    expect(parseAspect('none to 21:9')).toEqual({ upper: { a: 21, b: 9, milli: 2333 } });
  });

  it('accepts up to 6 digits in a ratio and rejects more', () => {
    expect(parseAspect('999999:1 to none')).toEqual({ lower: { a: 999999, b: 1, milli: 999999000 } });
    for (const text of ['1234567:1 to none', '1:1234567 to none', `${'9'.repeat(400)}:10 to none`, `none to 10:${'9'.repeat(400)}`]) {
      expect(() => parseAspect(text)).toThrow('Write the limits as A:B to C:D, for example 16:10 to none.');
    }
  });

  it('accepts none in any letter case, and more than one space around "to"', () => {
    expect(parseAspect('16:10 to None')).toEqual({ lower: { a: 16, b: 10, milli: 1600 } });
    expect(parseAspect('NONE to 21:9')).toEqual({ upper: { a: 21, b: 9, milli: 2333 } });
    expect(parseAspect('16:10   to   none')).toEqual({ lower: { a: 16, b: 10, milli: 1600 } });
  });

  it('gives undefined when nothing is limited', () => {
    expect(parseAspect('')).toBeUndefined();
    expect(parseAspect('  ')).toBeUndefined();
    expect(parseAspect('none to none')).toBeUndefined();
  });

  // The first ratio is the lower limit. A lower limit above the upper limit would make every image fail.
  it('rejects a lower limit that is above the upper limit, and accepts equal limits', () => {
    const message = 'The first limit must not be larger than the second limit, for example 9:21 to 10:16.';
    expect(() => parseAspect('10:16 to 9:21')).toThrow(message);
    expect(() => parseAspect('16:10 to 3:2')).toThrow(message); // 1.6 > 1.5
    expect(parseAspect('3:2 to 6:4')).toEqual({ lower: { a: 3, b: 2, milli: 1500 }, upper: { a: 6, b: 4, milli: 1500 } });
  });

  it.each(['0:10 to none', '10:0 to none', 'none to 0:5', '16:10', '16:10 to', '16:10 to abc', '16:0 to none', '16-10 to none', '16:10 to 2:1 to 3:1', '1.5:1 to none'])(
    'rejects %j',
    (text) => {
      expect(() => parseAspect(text)).toThrow('Write the limits as A:B to C:D, for example 16:10 to none.');
    },
  );
});

// Legacy L§1.4: horizontal and vertical images only. An image fails as "tall" when its ratio is below the lower
// limit and as "wide" when it is above the upper limit. A ratio equal to a limit passes. Ratios are rounded to 3 decimals.
describe('checkAspect', () => {
  const limits = {
    horizontal: parseAspect('16:10 to none')!, // width/height >= 1.6
    vertical: parseAspect('9:21 to 10:16')!, // 0.429 .. 0.625
  };

  it('passes ratios inside the limits, also exactly on a limit', () => {
    expect(checkAspect(limits, [img(1920, 1080), img(1600, 1000, 2), img(900, 1600, 3), img(1000, 1600, 4)])).toBeUndefined();
    expect(checkAspect(limits, [img(429, 1000)])).toBeUndefined(); // 0.429 = lower limit
  });

  it('fails a horizontal image below the lower limit as tall', () => {
    const tall = img(1600, 1200); // 1.333
    expect(checkAspect(limits, [tall, img(1920, 1080, 2)])).toEqual({
      rule: 'aspectRatio',
      sections: [{ orientation: 'horizontal', limits: limits.horizontal, tall: [tall], wide: [] }],
    });
    expect(checkAspect(limits, [img(1599, 1000)])).not.toBeUndefined(); // 1.599 < 1.6
  });

  it('fails a vertical image outside the limits as tall or wide, in gallery order', () => {
    const wide = img(1080, 1440); // 0.75 > 0.625
    const tall = img(1000, 3000, 2); // 0.333 < 0.429
    expect(checkAspect(limits, [wide, tall])).toMatchObject({
      sections: [{ orientation: 'vertical', tall: [tall], wide: [wide] }],
    });
  });

  it('rounds the ratio before it compares', () => {
    expect(checkAspect(limits, [img(3000, 7000)])).toBeUndefined(); // 0.42857 -> 0.429 = lower limit
    expect(checkAspect(limits, [img(1599500, 1000000)])).toBeUndefined(); // 1.5995 -> 1.600 = lower limit
  });

  it('compares the ratio of an image as legacy MySQL rounds it (twice)', () => {
    expect(checkAspect(limits, [img(5870, 3670)])).toBeUndefined(); // 1.600 passes 16:10; one rounding gives 1.599 and fails
    const limit1591 = { horizontal: parseAspect('1591:1000 to none')! };
    expect(checkAspect(limit1591, [img(167, 105)])).toBeUndefined(); // 1.591 = limit; one rounding gives 1.590 and fails
    expect(checkAspect(limit1591, [img(1590, 1000)])).not.toBeUndefined(); // 1.590 < 1.591
  });

  it('does not check square images or an orientation with no limits', () => {
    expect(checkAspect(limits, [img(1000, 1000)])).toBeUndefined();
    expect(checkAspect({ vertical: limits.vertical }, [img(1600, 1200)])).toBeUndefined();
  });

  it('puts the horizontal section before the vertical one', () => {
    const tall = img(1600, 1200, 2);
    const wide = img(1080, 1440, 1);
    expect(checkAspect(limits, [wide, tall])).toMatchObject({
      sections: [{ orientation: 'horizontal' }, { orientation: 'vertical' }],
    });
  });
});
