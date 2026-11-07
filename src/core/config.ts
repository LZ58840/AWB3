import { parseAspect } from './rules/aspectRatio';
import { parseFlairRules } from './rules/flair';
import { parseSize } from './rules/resolution';
import type { AspectLimits, Config, FlairRules, Mode, RepostConfig, Size } from './types';

export type RawSettings = Record<string, unknown>;

// Number settings: default (plan 5.6) and range. Hours are at most 30 days, the lifetime of a post record (plan 5.5). The source deadline
// stays 24 hours inside that: the check at the deadline needs the record, which lives 30 days from the first look.
export const NUMBER_SETTINGS = {
  rateLimitHours: { def: 24, min: 1, max: 720, whole: true },
  rateLimitPosts: { def: 4, min: 1, max: 1000, whole: true },
  sourceHours: { def: 1, min: 0.01, max: 696, whole: false },
  repostMonths: { def: 6, min: 1, max: 8, whole: true },
  repostReportAt: { def: 94, min: 85, max: 100, whole: false },
  repostRemoveAt: { def: 98, min: 90, max: 100, whole: false },
  repostGate: { def: 22, min: 10, max: 30, whole: false },
  repostNcc: { def: 0.8, min: 0.5, max: 0.99, whole: false },
  repostMinTiles: { def: 85, min: 70, max: 100, whole: false },
};
type NumberKey = keyof typeof NUMBER_SETTINGS;

function parseNumber(key: NumberKey, v: unknown): number {
  const { def, min, max, whole } = NUMBER_SETTINGS[key];
  if (v === undefined || v === null || v === '') return def;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (whole && !Number.isInteger(v))) {
    throw new Error(`Write ${whole ? 'a whole number' : 'a number'} from ${min} to ${max}.`);
  }
  return v;
}

// An unset string setting is an empty text.
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function parseExceptAuthors(value: string): string[] {
  const names = value.split(',').map((n) => n.trim()).filter((n) => n !== '');
  const bad = names.find((n) => !/^[\w-]+$/.test(n));
  if (bad !== undefined) throw new Error(`Bad user name "${bad}". Write names without u/, separated by commas.`);
  return names;
}

// Devvit gives a select setting as an array (['enforce']) once a mod has set it, and as the default string ('off') before.
function parseMode(v: unknown = 'off'): Mode {
  const value = Array.isArray(v) && v.length === 1 ? v[0] : v;
  if (value === 'off' || value === 'dry-run' || value === 'enforce') return value;
  throw new Error('Choose off, dry-run or enforce.');
}

export function parseConfig(raw: RawSettings): { config: Config; problems: string[] } {
  const problems: string[] = [];
  // Records a problem and gives `fallback`, so that a bad setting turns only its own rule off.
  const guard = <T>(name: string, fallback: T, f: () => T): T => {
    try {
      return f();
    } catch (e) {
      problems.push(`${name}: ${(e as Error).message}`);
      return fallback;
    }
  };
  // A rule is on only when its switch is on and all its settings are good.
  const rule = <T>(name: string, f: () => T): T | undefined =>
    raw[name] === true ? guard<T | undefined>(name, undefined, f) : undefined;
  // Names the setting in the message.
  const field = <T>(key: string, f: () => T): T => {
    try {
      return f();
    } catch (e) {
      throw new Error(`${key}: ${(e as Error).message}`);
    }
  };
  const num = (key: NumberKey) => field(key, () => parseNumber(key, raw[key]));
  const problemsBefore = problems.length;
  const exceptAuthors = guard<string[]>('exceptAuthors', [], () => parseExceptAuthors(text(raw.exceptAuthors)));
  const flairRules = guard<FlairRules>('flairRules', new Map(), () => parseFlairRules(text(raw.flairRules)));
  const exemptionsLost = problems.length > problemsBefore;
  const config: Config = {
    mode: guard<Mode>('mode', 'off', () => parseMode(raw.mode)),
    exceptAuthors,
    flairRules,
    resolutionMismatch: raw.resolutionMismatch === true,
    resolutionBad: rule('resolutionBad', () => {
      const min: Partial<Record<'horizontal' | 'vertical' | 'square', Size>> = {};
      for (const [orientation, key] of [
        ['horizontal', 'minHorizontal'],
        ['vertical', 'minVertical'],
        ['square', 'minSquare'],
      ] as const) {
        const size = field(key, () => parseSize(text(raw[key])));
        if (size) min[orientation] = size;
      }
      if (Object.keys(min).length === 0) throw new Error('Set at least one minimum size.');
      return min;
    }),
    aspectRatio: rule('aspectRatio', () => {
      const limits: Partial<Record<'horizontal' | 'vertical', AspectLimits>> = {};
      for (const [orientation, key] of [
        ['horizontal', 'aspectHorizontal'],
        ['vertical', 'aspectVertical'],
      ] as const) {
        const l = field(key, () => parseAspect(text(raw[key])));
        if (l) limits[orientation] = l;
      }
      if (Object.keys(limits).length === 0) throw new Error('Set at least one limit.');
      return limits;
    }),
    rateLimit: rule('rateLimit', () => ({
      hours: num('rateLimitHours'),
      posts: num('rateLimitPosts'),
      countDeleted: raw.rateLimitCountDeleted === true,
    })),
    sourceComment: rule('sourceComment', () => ({ hours: num('sourceHours') })),
    repost: guard<RepostConfig | undefined>('repostMode', undefined, () => {
      const mode = parseMode(raw.repostMode);
      if (mode === 'off') return undefined;
      const reportAt = num('repostReportAt');
      const removeAt = num('repostRemoveAt');
      if (removeAt < reportAt) throw new Error('repostRemoveAt must not be below repostReportAt.');
      return {
        mode,
        reportOnly: raw.repostReportOnly !== false,
        months: num('repostMonths'),
        reportAt,
        removeAt,
        gate: num('repostGate'),
        ncc: num('repostNcc'),
        minTiles: num('repostMinTiles'),
      };
    }),
    canary: raw.canary === true,
  };
  // Legacy stopped all moderation on a config error (L§1.10). A lost exemption or skip flair must never cause a removal.
  if (exemptionsLost) {
    config.mode = 'off';
    config.repost = undefined;
  }
  return { config, problems };
}

const STRING_PARSERS: Record<string, (value: string) => unknown> = {
  exceptAuthors: parseExceptAuthors,
  flairRules: parseFlairRules,
  minHorizontal: parseSize,
  minVertical: parseSize,
  minSquare: parseSize,
  aspectHorizontal: parseAspect,
  aspectVertical: parseAspect,
};

/** For the validation routes. Gives the message for the mod, or undefined when the value is good. One setting at a time. */
export function validateSetting(key: string, value: unknown): string | undefined {
  try {
    if (Object.hasOwn(NUMBER_SETTINGS, key)) parseNumber(key as NumberKey, value);
    else if (Object.hasOwn(STRING_PARSERS, key)) STRING_PARSERS[key]?.(text(value));
  } catch (e) {
    return (e as Error).message;
  }
  return undefined;
}
