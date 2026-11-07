import { describe, expect, it } from 'vitest';
import { checkMismatch, checkResolutionBad, parseSize, titleTags } from '../../src/core/rules/resolution';
import { img } from './helpers';

// Expected values: legacy L§1.2 description of the regex
// [(\[]\s?([0-9]{3,})\s?[Xx×]\s?([0-9]{3,})\s?[)\]]  (one optional whitespace at each position).
describe('titleTags', () => {
  it('reads a tag in brackets', () => {
    expect(titleTags('Nice wallpaper [1920x1080]')).toEqual([{ width: 1920, height: 1080 }]);
  });

  it('accepts mixed brackets, X, the multiplication sign and one space at each position', () => {
    expect(titleTags('(1920x1080]')).toEqual([{ width: 1920, height: 1080 }]);
    expect(titleTags('[1920X1080)')).toEqual([{ width: 1920, height: 1080 }]);
    expect(titleTags('[ 1920 × 1080 ]')).toEqual([{ width: 1920, height: 1080 }]);
  });

  it('rejects two spaces, two-digit sizes and a missing bracket', () => {
    expect(titleTags('[1920  x 1080]')).toEqual([]);
    expect(titleTags('[19x10]')).toEqual([]);
    expect(titleTags('1920x1080')).toEqual([]);
    expect(titleTags('[1920x1080')).toEqual([]);
  });

  it.each([
    ['[1920x10]', 'a two-digit height'],
    ['[19x1080]', 'a two-digit width'],
    ['[  1920x1080]', 'two spaces after the bracket'],
    ['[1920  x1080]', 'two spaces before the x'],
    ['[1920x  1080]', 'two spaces after the x'],
    ['[1920x1080  ]', 'two spaces before the closing bracket'],
  ])('does not read %s (%s)', (title) => {
    expect(titleTags(title)).toEqual([]);
  });

  // Review LOW-8: 3 to 6 digits. A longer number is not a tag (Number() of 400 digits is Infinity and would
  // make a false "Mismatched resolution" removal).
  it('reads a number of up to 6 digits and does not read a longer one', () => {
    expect(titleTags('[999999x1080]')).toEqual([{ width: 999999, height: 1080 }]);
    expect(titleTags('[1234567x1080]')).toEqual([]);
    expect(titleTags('[1080x1234567]')).toEqual([]);
    expect(titleTags(`[${'9'.repeat(400)}x1080]`)).toEqual([]);
  });

  it('keeps all tags in order, also duplicates', () => {
    expect(titleTags('A [3840x2160] B (1920x1080) C [3840x2160]')).toEqual([
      { width: 3840, height: 2160 },
      { width: 1920, height: 1080 },
      { width: 3840, height: 2160 },
    ]);
  });
});

// Legacy L§1.2: no tag passes; an image whose size equals no tag fails; a tag with no image is no failure;
// duplicates stay; no images pass.
describe('checkMismatch', () => {
  const tagged = [{ width: 1920, height: 1080 }];

  it('does not fail an image because of a tag with a 400-digit number', () => {
    expect(checkMismatch(`[${'9'.repeat(400)}x1080]`, [img(1920, 1080)])).toBeUndefined();
  });

  it('passes a title with no tag', () => {
    expect(checkMismatch('Nice wallpaper', [img(1600, 1200)])).toBeUndefined();
  });

  it('passes when every image has a tagged size', () => {
    expect(checkMismatch('[1920x1080]', [img(1920, 1080)])).toBeUndefined();
  });

  it('fails with the tagged sizes and the real sizes of the images that match no tag', () => {
    expect(checkMismatch('[1920x1080]', [img(1600, 1200)])).toEqual({
      rule: 'resolutionMismatch',
      tagged,
      mismatched: [{ width: 1600, height: 1200 }],
    });
  });

  it('lists only the failing images of a gallery, in gallery order, with duplicates', () => {
    const images = [img(1920, 1080, 1), img(1600, 1200, 2), img(1280, 720, 3), img(1600, 1200, 4)];
    expect(checkMismatch('[1920x1080]', images)).toMatchObject({
      mismatched: [
        { width: 1600, height: 1200 },
        { width: 1280, height: 720 },
        { width: 1600, height: 1200 },
      ],
    });
  });

  it('does not fail because a tag has no image, or because there are no images', () => {
    expect(checkMismatch('[1920x1080] [3840x2160]', [img(1920, 1080)])).toBeUndefined();
    expect(checkMismatch('[1920x1080]', [])).toBeUndefined();
  });
});

// Legacy L§1.3: per orientation, an image fails when width < W or height < H (strict, so the exact minimum passes).
// An orientation with no threshold is not checked. Sections come in the order horizontal, vertical, square.
describe('checkResolutionBad', () => {
  const min = {
    horizontal: { width: 1920, height: 1080 },
    vertical: { width: 900, height: 1600 },
  };

  it('passes the exact minimum and larger images', () => {
    expect(checkResolutionBad(min, [img(1920, 1080), img(3840, 2160, 2)])).toBeUndefined();
  });

  it('fails an image with a width or a height below the minimum', () => {
    const small = img(1600, 1200);
    const short = img(1920, 1000, 2);
    expect(checkResolutionBad(min, [small, short])).toEqual({
      rule: 'resolutionBad',
      sections: [{ orientation: 'horizontal', min: min.horizontal, images: [small, short] }],
    });
  });

  it('uses the threshold of the orientation of each image', () => {
    const tall = img(800, 1600); // vertical, width below 900
    const wide = img(1000, 600, 2); // horizontal, below 1920x1080
    const ok = img(900, 1600, 3);
    expect(checkResolutionBad(min, [ok, tall])).toMatchObject({ sections: [{ orientation: 'vertical', images: [tall] }] });
    expect(checkResolutionBad({ vertical: min.vertical }, [wide])).toBeUndefined();
  });

  it('orders the sections horizontal, vertical, square, and checks square only with a square threshold', () => {
    const square = img(500, 500, 1);
    const vertical = img(800, 1600, 2);
    const horizontal = img(1000, 600, 3);
    const all = { ...min, square: { width: 1000, height: 1000 } };
    expect(checkResolutionBad(all, [square, vertical, horizontal])).toMatchObject({
      sections: [
        { orientation: 'horizontal', images: [horizontal] },
        { orientation: 'vertical', images: [vertical] },
        { orientation: 'square', min: all.square, images: [square] },
      ],
    });
    expect(checkResolutionBad(min, [square])).toBeUndefined();
  });

  it('passes a post with no images', () => {
    expect(checkResolutionBad(min, [])).toBeUndefined();
  });
});

// Settings minHorizontal, minVertical, minSquare: `WxH` (legacy L§1.3, split on x). An empty value means "not set".
describe('parseSize', () => {
  it('reads WxH', () => {
    expect(parseSize('1920x1080')).toEqual({ width: 1920, height: 1080 });
    expect(parseSize(' 900 X 1600 ')).toEqual({ width: 900, height: 1600 });
  });

  it('accepts up to 6 digits and rejects more', () => {
    expect(parseSize('999999x999999')).toEqual({ width: 999999, height: 999999 });
    for (const text of ['1234567x1080', '1920x1234567', `${'9'.repeat(400)}x1080`]) {
      expect(() => parseSize(text)).toThrow('Write the size as WxH, for example 1920x1080.');
    }
  });

  it('gives undefined for an empty value', () => {
    expect(parseSize('')).toBeUndefined();
    expect(parseSize('   ')).toBeUndefined();
  });

  it.each(['1920', '1920x', 'x1080', '1920x1080x3', 'abc', '1920*1080', '19.2x10', '-1x5'])(
    'rejects %j',
    (text) => {
      expect(() => parseSize(text)).toThrow('Write the size as WxH, for example 1920x1080.');
    },
  );
});
