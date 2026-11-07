import type { RepostConfig } from '../types';

/** The largest block of changed tiles (of 64) that a similarity percent allows. */
export const maxBlockTiles = (percent: number): number => Math.floor(((100 - percent) * 64) / 100);

/** The months of MonthDelta 0.9.1 `monthmod`: dates only (UTC), no clamp of a missing day. */
function wholeMonths(from: number, to: number): number {
  const a = new Date(from);
  const b = new Date(to);
  return (
    12 * (b.getUTCFullYear() - a.getUTCFullYear()) + b.getUTCMonth() - a.getUTCMonth() - (a.getUTCDate() > b.getUTCDate() ? 1 : 0)
  );
}

/** The age text of a match, as legacy `get_time_since`: the first non-zero unit of month, day, hour, minute. */
export function repostAgeText(from: number, to: number): string {
  const seconds = Math.floor((to - from) / 1000);
  const units: [number, string][] = [
    [wholeMonths(from, to), 'month'],
    [Math.floor(seconds / 86_400), 'day'],
    [Math.floor(seconds / 3600), 'hour'],
    [Math.floor(seconds / 60), 'minute'],
  ];
  const unit = units.find(([n]) => n > 0);
  return unit ? `${unit[0]} ${unit[1]}${unit[0] === 1 ? '' : 's'} ago` : 'just now';
}

/** What to do with a match (the best similarity, in percent). D14: below `removeAt`, only a report. */
export const repostAction = (cfg: RepostConfig, similarity: number): 'remove' | 'report' =>
  !cfg.reportOnly && similarity >= cfg.removeAt ? 'remove' : 'report';
