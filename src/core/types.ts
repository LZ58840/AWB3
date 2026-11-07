// Plain data shapes of the pure core. No Devvit imports. All times are epoch milliseconds.

export type Mode = 'off' | 'dry-run' | 'enforce';
export type Orientation = 'horizontal' | 'vertical' | 'square';

export interface Size {
  width: number;
  height: number;
}

/** The removal fields of a Reddit post. The Devvit `Post` object satisfies this type. An empty `removedBy` or `removedByCategory` means "not set". */
export interface PostState {
  removed: boolean;
  spam: boolean;
  approved: boolean;
  removedBy?: string;
  removedByCategory?: string;
}

/** One checked image. `n` is its 1-based position in the gallery. */
export interface PostImage extends Size {
  n: number;
  url: string;
}

export interface PostSnapshot {
  id: string;
  createdAt: number;
  title: string;
  flair?: string;
  images: PostImage[];
}

/** A post of the same author, read for the rate limit. `id` can be a Devvit fullname (t3_xxx); the message writes the bare id. */
export interface RateCandidate extends PostState {
  id: string;
  createdAt: number;
}

export type FlairRules = Map<string, 'skip' | Orientation[]>;

/** The ratio limit `a:b`. `milli` is a/b rounded half up to 3 decimals, times 1000. */
export interface Ratio {
  a: number;
  b: number;
  milli: number;
}

/** `lower`: a smaller ratio is too tall. `upper`: a larger ratio is too wide. */
export interface AspectLimits {
  lower?: Ratio;
  upper?: Ratio;
}

export interface RateLimitConfig {
  hours: number;
  posts: number;
  countDeleted: boolean;
}

/** Percent values: a match needs similarity >= `reportAt`; a removal needs similarity >= `removeAt`. */
export interface RepostConfig {
  mode: Mode;
  reportOnly: boolean;
  months: number;
  reportAt: number;
  removeAt: number;
  gate: number;
  ncc: number;
  minTiles: number;
}

/** The parsed install settings. A rule that is off has no entry. */
export interface Config {
  mode: Mode;
  exceptAuthors: string[];
  flairRules: FlairRules;
  resolutionMismatch: boolean;
  resolutionBad?: Partial<Record<Orientation, Size>>;
  aspectRatio?: Partial<Record<'horizontal' | 'vertical', AspectLimits>>;
  rateLimit?: RateLimitConfig;
  sourceComment?: { hours: number };
  repost?: RepostConfig;
  canary: boolean;
}

export interface RepostMatch {
  /** Gallery position of the new image. */
  n: number;
  url: string;
  /** Can be a Devvit fullname (t3_xxx); the message writes the bare id. */
  matchPostId: string;
  matchUrl: string;
  matchCreatedAt: number;
  /** Percent, 0 to 100. */
  similarity: number;
}

/** One failed rule with the facts that the message needs. Section lists hold only non-empty entries. */
export type Failure =
  | { rule: 'flair'; flair: string; sections: { orientation: Orientation; images: PostImage[] }[] }
  | { rule: 'resolutionMismatch'; tagged: Size[]; mismatched: Size[] }
  | { rule: 'resolutionBad'; sections: { orientation: Orientation; min: Size; images: PostImage[] }[] }
  | {
      rule: 'aspectRatio';
      sections: {
        orientation: 'horizontal' | 'vertical';
        limits: AspectLimits;
        tall: PostImage[];
        wide: PostImage[];
      }[];
    }
  | {
      rule: 'rateLimit';
      posts: number;
      hours: number;
      countDeleted: boolean;
      createdAt: number;
      /** Counted posts, newest first. */
      recent: { id: string; createdAt: number }[];
      nextAt: number;
    }
  | { rule: 'sourceComment'; hours: number }
  | { rule: 'repost'; months: number; createdAt: number; matches: RepostMatch[] };
