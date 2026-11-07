import type { Config, PostImage, PostState } from '../../src/core/types';

export const state = (o: Partial<PostState> = {}): PostState => ({ removed: false, spam: false, approved: false, ...o });

export const img = (width: number, height: number, n = 1, url = `https://i.redd.it/img${n}.png`): PostImage => ({
  n,
  url,
  width,
  height,
});

/** Every rule off, mode enforce. */
export const cfg = (o: Partial<Config> = {}): Config => ({
  mode: 'enforce',
  exceptAuthors: [],
  flairRules: new Map(),
  resolutionMismatch: false,
  canary: false,
  ...o,
});
