import { ORIENTATIONS, orientationOf } from '../post';
import type { Failure, FlairRules, Orientation, PostImage } from '../types';

/** Parses the flairRules setting. Throws a message for the mod when a line is bad. */
export function parseFlairRules(text: string): FlairRules {
  const rules: FlairRules = new Map();
  for (const line of text.split('\n').map((l) => l.trim())) {
    if (line === '') continue;
    const colon = line.lastIndexOf(':');
    const flair = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    const items = value.split(',').map((v) => v.trim());
    if (colon < 0 || flair === '' || !(value === 'skip' || items.every((v) => ORIENTATIONS.some((o) => o === v)))) {
      throw new Error(`Bad line "${line}". Write Flair: skip, or Flair: horizontal, vertical, square.`);
    }
    rules.set(flair, value === 'skip' ? 'skip' : (items as Orientation[]));
  }
  return rules;
}

/** A `skip` flair is not a failure: the skip check handles it before the rules run. */
export function checkFlair(rules: FlairRules, flair: string | undefined, images: PostImage[]): Failure | undefined {
  if (flair === undefined) return undefined;
  const allowed = rules.get(flair);
  if (allowed === undefined || allowed === 'skip') return undefined;
  const sections = ORIENTATIONS.filter((o) => !allowed.includes(o))
    .map((orientation) => ({ orientation, images: images.filter((i) => orientationOf(i) === orientation) }))
    .filter((s) => s.images.length > 0);
  return sections.length > 0 ? { rule: 'flair', flair, sections } : undefined;
}
