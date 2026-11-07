import { ORIENTATIONS, orientationOf } from '../post';
import type { Failure, Orientation, PostImage, Size } from '../types';

// The pattern of legacy `ResolutionMismatch` (rules.py:42), with at most 6 digits: Number() of a very long text is Infinity.
const TAG = /[(\[]\s?([0-9]{3,6})\s?[Xx×]\s?([0-9]{3,6})\s?[)\]]/g;

export const titleTags = (title: string): Size[] =>
  [...title.matchAll(TAG)].map((m) => ({ width: Number(m[1]), height: Number(m[2]) }));

export function checkMismatch(title: string, images: PostImage[]): Failure | undefined {
  const tagged = titleTags(title);
  const mismatched = images
    .filter((i) => !tagged.some((t) => t.width === i.width && t.height === i.height))
    .map(({ width, height }) => ({ width, height }));
  return tagged.length > 0 && mismatched.length > 0 ? { rule: 'resolutionMismatch', tagged, mismatched } : undefined;
}

export function checkResolutionBad(min: Partial<Record<Orientation, Size>>, images: PostImage[]): Failure | undefined {
  const sections = ORIENTATIONS.flatMap((orientation) => {
    const m = min[orientation];
    const bad = m ? images.filter((i) => orientationOf(i) === orientation && (i.width < m.width || i.height < m.height)) : [];
    return m && bad.length > 0 ? [{ orientation, min: m, images: bad }] : [];
  });
  return sections.length > 0 ? { rule: 'resolutionBad', sections } : undefined;
}

const SIZE = /^(\d{1,6})\s*[xX×]\s*(\d{1,6})$/;

/** Parses a minimum-size setting. An empty value gives undefined. Throws a message for the mod when the value is bad. */
export function parseSize(text: string): Size | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  const m = SIZE.exec(t);
  if (!m) throw new Error('Write the size as WxH, for example 1920x1080.');
  return { width: Number(m[1]), height: Number(m[2]) };
}
