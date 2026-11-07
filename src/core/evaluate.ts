import { effectiveMode, isDeleted, skipsAsRemoved } from './post';
import { checkAspect } from './rules/aspectRatio';
import { checkFlair } from './rules/flair';
import { checkRateLimit } from './rules/rateLimit';
import { checkMismatch, checkResolutionBad } from './rules/resolution';
import type { Config, Failure, Mode, PostSnapshot, PostState, RateCandidate } from './types';

export interface SkipInput extends PostState {
  /** Undefined for a deleted account. */
  authorId?: string;
  authorName: string;
  title: string;
  flair?: string;
}

export type SkipReason =
  | 'app-post'
  | 'approved'
  | 'removed'
  | 'deleted'
  | 'mode-off'
  | 'except-author'
  | 'flair-skip';

/** The skip checks of the `new:` flow in plan order. `firstMode`: the mode that the post had at its first lease. */
export function skipReason(cfg: Config, firstMode: Mode, post: SkipInput, appUserId: string): SkipReason | undefined {
  const mode = effectiveMode(cfg, firstMode);
  const canary = cfg.canary && post.title.startsWith('[canary]'); // OD6
  if (post.authorId === appUserId && !canary) return 'app-post';
  if (post.approved) return 'approved';
  if (skipsAsRemoved(post, mode)) return 'removed';
  if (isDeleted(post)) return 'deleted';
  if (mode === 'off') return 'mode-off';
  if (cfg.exceptAuthors.includes(post.authorName)) return 'except-author';
  if (post.flair !== undefined && cfg.flairRules.get(post.flair) === 'skip') return 'flair-skip';
  return undefined;
}

/**
 * The quick rules R2 to R6 in legacy order. `history`: the other posts of the author that are near the post in time;
 * it is needed only when the rate-limit rule is on.
 */
export function evaluateQuick(cfg: Config, post: PostSnapshot, history: RateCandidate[]): Failure[] {
  return [
    checkFlair(cfg.flairRules, post.flair, post.images),
    cfg.resolutionMismatch ? checkMismatch(post.title, post.images) : undefined,
    cfg.resolutionBad && checkResolutionBad(cfg.resolutionBad, post.images),
    cfg.aspectRatio && checkAspect(cfg.aspectRatio, post.images),
    cfg.rateLimit && checkRateLimit(cfg.rateLimit, post.createdAt, history),
  ].filter((f) => f !== undefined);
}
