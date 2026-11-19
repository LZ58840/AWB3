import type { Config, Mode, Orientation, PostImage, PostState, Size } from './types';

// Devvit shows an author delete as authorName '[deleted]' with no removal field (S2, 2026-11-15); the categories are the legacy (PRAW) form.
// shortcut: a live post of a deleted account also counts as deleted (skipped, as the legacy hotfix of 2026-11-14); split them if Reddit gives a field for it.
export const isDeleted = (p: PostState): boolean =>
  p.authorName === '[deleted]' || p.removedByCategory === 'deleted' || p.removedByCategory === 'author';

// Equals legacy `banned_by is not None` (L§4(b)). An empty category ("") means "not set".
export const isRemoved = (p: PostState): boolean => p.removed || p.spam || (!!p.removedByCategory && !isDeleted(p));

// Delete this exception after cut-over 2: the username then belongs to the app (plan 5.2).
const LEGACY_BOT = 'AnimewallpaperBot';

export const skipsAsRemoved = (p: PostState, mode: Mode): boolean =>
  isRemoved(p) &&
  p.removedByCategory !== 'automod_filtered' &&
  !(mode === 'dry-run' && p.removedBy === LEGACY_BOT);

export const isAlive = (p: PostState): boolean => !isRemoved(p) && !isDeleted(p);

export const isCounted = (p: PostState, countDeleted: boolean): boolean =>
  !isRemoved(p) && (!isDeleted(p) || countDeleted);

/** The order of the sections in a message (legacy). */
export const ORIENTATIONS: Orientation[] = ['horizontal', 'vertical', 'square'];

export const orientationOf = ({ width, height }: Size): Orientation =>
  width > height ? 'horizontal' : width < height ? 'vertical' : 'square';

const RANK: Record<Mode, number> = { off: 0, 'dry-run': 1, enforce: 2 };
const lowest = (...modes: Mode[]): Mode => modes.reduce((a, b) => (RANK[b] < RANK[a] ? b : a));

/** For the quick rules and the source rule. `first` is the mode that the post had at its first lease. */
export const effectiveMode = (cfg: Config, first: Mode): Mode => lowest(first, cfg.mode);

export const effectiveRepostMode = (cfg: Config, first: Mode): Mode =>
  lowest(cfg.mode, cfg.repost?.mode ?? 'off', first);

export interface ImageSource {
  url: string;
  crosspostParentId?: string;
  gallery: { url: string; width: number; height: number; status: number }[];
}

const GALLERY_VALID = 1; // GalleryMediaStatus.VALID

// The post URL of a Reddit-hosted image or gallery (legacy L§5.1). Other URLs (links, videos) give no images.
const IMAGE_POST_URL = /^https?:\/\/(?:(?:i|preview)\.redd\.it\/|(?:www\.)?reddit\.com\/gallery\/)/;

const IMAGE_URL = /^https?:\/\/(?:i|preview)\.redd\.it\/(\w+\.(?:png|jpg|jpeg))(?:\?.*)?$/;

/** `parent` is the loaded parent post of a crosspost. A crosspost uses the images of its parent. */
export function postImages(post: ImageSource, parent?: ImageSource): PostImage[] {
  const source = post.crosspostParentId ? parent : post;
  if (!source || !IMAGE_POST_URL.test(source.url)) return [];
  return source.gallery.flatMap((g, i) => {
    const id = IMAGE_URL.exec(g.url)?.[1];
    return id && g.status === GALLERY_VALID && g.width > 0 && g.height > 0
      ? [{ n: i + 1, url: `https://i.redd.it/${id}`, width: g.width, height: g.height }]
      : [];
  });
}
