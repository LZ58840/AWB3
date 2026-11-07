import { isCounted } from '../post';
import type { Failure, RateCandidate, RateLimitConfig } from '../types';

/** The age text of a counted post, as legacy `format_duration`. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes === 0) return 'just now';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const h = hours > 1 ? `${hours} hours` : hours === 1 ? '1 hour' : '';
  const m = rest > 1 ? `, ${rest} minutes` : rest === 1 ? ', 1 minute' : '';
  return `${h}${m} ago`.replace(/^[, ]+/, '');
}

/** `candidates`: other posts of the author, in any order. `createdAt`: the time of the current post. */
export function checkRateLimit(cfg: RateLimitConfig, createdAt: number, candidates: RateCandidate[]): Failure | undefined {
  const window = cfg.hours * 3_600_000;
  const recent = candidates
    .filter((c) => c.createdAt < createdAt && createdAt - c.createdAt < window && isCounted(c, cfg.countDeleted))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ id, createdAt }) => ({ id, createdAt }));
  const oldest = recent.at(-1); // the list is sorted newest first
  if (!oldest || recent.length < cfg.posts) return undefined;
  return { rule: 'rateLimit', posts: cfg.posts, hours: cfg.hours, countDeleted: cfg.countDeleted, createdAt, recent, nextAt: oldest.createdAt + window };
}
