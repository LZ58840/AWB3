import type { Failure } from '../types';

const DELETED = '[deleted]';

/** Run at the deadline. `commentAuthors`: the authors of the top-level comments of the post. */
export function checkSource(hours: number, postAuthor: string, commentAuthors: string[]): Failure | undefined {
  return commentAuthors.some((a) => a === postAuthor && a !== DELETED) ? undefined : { rule: 'sourceComment', hours };
}
