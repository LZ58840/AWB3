import { describe, expect, it } from 'vitest';
import { checkFlair, parseFlairRules } from '../../src/core/rules/flair';
import { img } from './helpers';

// Setting flairRules: one `Flair: value` per line. Legacy L§1.1 and Appendix B2: the value is `skip` or a
// comma-separated list of horizontal, vertical, square. The flair text is matched exactly (case-sensitive).
describe('parseFlairRules', () => {
  it('reads the legacy production example', () => {
    const rules = parseFlairRules('Desktop: horizontal\nMobile: vertical\nCollection: horizontal, vertical\nOther: skip');
    expect([...rules]).toEqual([
      ['Desktop', ['horizontal']],
      ['Mobile', ['vertical']],
      ['Collection', ['horizontal', 'vertical']],
      ['Other', 'skip'],
    ]);
  });

  it('ignores blank lines and spaces, and accepts CRLF', () => {
    const rules = parseFlairRules('\r\n  Desktop :  horizontal ,square \r\n\r\n');
    expect([...rules]).toEqual([['Desktop', ['horizontal', 'square']]]);
  });

  it('splits at the last colon, so a flair text can hold a colon', () => {
    expect([...parseFlairRules('Art: Digital: vertical')]).toEqual([['Art: Digital', ['vertical']]]);
  });

  it('gives an empty map for an empty value, and the last line wins for a repeated flair', () => {
    expect(parseFlairRules('').size).toBe(0);
    expect([...parseFlairRules('Desktop: horizontal\nDesktop: skip')]).toEqual([['Desktop', 'skip']]);
  });

  it.each([
    ['Desktop horizontal', 'no colon'],
    [': horizontal', 'no flair'],
    ['Desktop:', 'no value'],
    ['Desktop: diagonal', 'unknown orientation'],
    ['Desktop: Horizontal', 'upper case'],
    ['Desktop: skip, horizontal', 'skip with a list'],
    ['Desktop: horizontal,,vertical', 'empty item'],
  ])('rejects %j (%s)', (text) => {
    expect(() => parseFlairRules(text)).toThrow(`Bad line "${text}". Write Flair: skip, or Flair: horizontal, vertical, square.`);
  });
});

// Legacy L§1.1: a flair that is not in the map gets no check. An image fails when its orientation is not in the list;
// square images fail unless `square` is in the list. A post with no images passes. Sections: horizontal, vertical, square.
describe('checkFlair', () => {
  const rules = parseFlairRules('Desktop: horizontal\nMobile: vertical\nCollection: horizontal, vertical\nOther: skip');

  it('passes an unmapped flair, no flair and a skip flair', () => {
    expect(checkFlair(rules, 'Art', [img(900, 1600)])).toBeUndefined();
    expect(checkFlair(rules, undefined, [img(900, 1600)])).toBeUndefined();
    expect(checkFlair(rules, 'Other', [img(900, 1600)])).toBeUndefined(); // skip is decided before the rules run
  });

  it('matches the flair text exactly, with case', () => {
    expect(checkFlair(rules, 'desktop', [img(900, 1600)])).toBeUndefined();
  });

  it('passes images of an allowed orientation and a post with no images', () => {
    expect(checkFlair(rules, 'Desktop', [img(1920, 1080)])).toBeUndefined();
    expect(checkFlair(rules, 'Collection', [img(1920, 1080), img(900, 1600, 2)])).toBeUndefined();
    expect(checkFlair(rules, 'Desktop', [])).toBeUndefined();
  });

  it('fails a vertical image under a horizontal flair', () => {
    const vertical = img(900, 1600);
    expect(checkFlair(rules, 'Desktop', [vertical])).toEqual({
      rule: 'flair',
      flair: 'Desktop',
      sections: [{ orientation: 'vertical', images: [vertical] }],
    });
  });

  it('fails a square image unless square is allowed', () => {
    const square = img(1000, 1000);
    expect(checkFlair(rules, 'Collection', [square])).toMatchObject({ sections: [{ orientation: 'square', images: [square] }] });
    expect(checkFlair(parseFlairRules('Art: square'), 'Art', [square])).toBeUndefined();
  });

  it('groups the failed images by orientation in the order horizontal, vertical, square', () => {
    const [h1, s1, v1, h2] = [img(1920, 1080, 1), img(500, 500, 2), img(900, 1600, 3), img(1600, 900, 4)];
    const result = checkFlair(parseFlairRules('Art: horizontal, vertical'), 'Art', [h1, s1, v1, h2]);
    expect(result).toMatchObject({ sections: [{ orientation: 'square', images: [s1] }] });
    const only = checkFlair(parseFlairRules('Art: square'), 'Art', [v1, h2, h1, s1]);
    expect(only).toMatchObject({
      sections: [
        { orientation: 'horizontal', images: [h2, h1] },
        { orientation: 'vertical', images: [v1] },
      ],
    });
  });
});
