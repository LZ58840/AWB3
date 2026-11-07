import { orientationOf } from '../post';
import type { AspectLimits, Failure, PostImage, Ratio } from '../types';

// A limit a:b rounded half up to 3 decimals, as thousandths (legacy `normal_round`). Integer math, so a tie is exact.
export const ratioMilli = (a: number, b: number): number => Math.floor((2000 * a + b) / (2 * b));

// An image ratio as legacy MySQL `ROUND(width / height, 3)` gives it: INT / INT is a DECIMAL with 4 decimals (half up), then ROUND again.
// Owner: confirm with `SELECT ROUND(5870/3670, 3);` on MySQL 8 (expect 1.600).
export const imageRatioMilli = (width: number, height: number): number =>
  Math.floor((Math.floor((20000 * width + height) / (2 * height)) + 5) / 10);

const BAD_LIMITS = 'Write the limits as A:B to C:D, for example 16:10 to none.';
const RATIO = /^([1-9]\d{0,5})\s*:\s*([1-9]\d{0,5})$/;

function parseRatio(text: string): Ratio | undefined {
  if (text.toLowerCase() === 'none') return undefined;
  const m = RATIO.exec(text);
  if (!m) throw new Error(BAD_LIMITS);
  const [a, b] = [Number(m[1]), Number(m[2])];
  return { a, b, milli: ratioMilli(a, b) };
}

/** Parses an aspect setting. Empty, or `none to none`, gives undefined. Throws a message for the mod when the value is bad. */
export function parseAspect(text: string): AspectLimits | undefined {
  if (text.trim() === '') return undefined;
  const sides = text.trim().split(/\s+to\s+/);
  if (sides.length !== 2) throw new Error(BAD_LIMITS);
  const lower = parseRatio(sides[0] ?? '');
  const upper = parseRatio(sides[1] ?? '');
  if (lower && upper && lower.milli > upper.milli) {
    throw new Error('The first limit must not be larger than the second limit, for example 9:21 to 10:16.');
  }
  return lower || upper ? { ...(lower && { lower }), ...(upper && { upper }) } : undefined;
}

const CHECKED = ['horizontal', 'vertical'] as const; // square images are never checked

export function checkAspect(
  limits: Partial<Record<(typeof CHECKED)[number], AspectLimits>>,
  images: PostImage[],
): Failure | undefined {
  const sections = CHECKED.flatMap((orientation) => {
    const l = limits[orientation] ?? {};
    const { lower, upper } = l;
    const ratios = images
      .filter((i) => orientationOf(i) === orientation)
      .map((i) => [i, imageRatioMilli(i.width, i.height)] as const);
    const tall = lower ? ratios.filter(([, r]) => r < lower.milli).map(([i]) => i) : [];
    const wide = upper ? ratios.filter(([, r]) => r > upper.milli).map(([i]) => i) : [];
    return tall.length + wide.length > 0 ? [{ orientation, limits: l, tall, wide }] : [];
  });
  return sections.length > 0 ? { rule: 'aspectRatio', sections } : undefined;
}
