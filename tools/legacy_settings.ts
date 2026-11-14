/**
 * Converts a legacy `awb` wiki page (YAML) into the install settings of AWB3 (plan 11, Phase 5, cut-over 1, step 1).
 * Run: npx tsx tools/legacy_settings.ts <legacy-page.yaml>
 *
 * stdout  Each setting of devvit.json, in its order, as a mod enters it in the install form.
 * stderr  A warning for each legacy key that AWB3 does not map or reads in a different way. A problem for each value that AWB3 rejects.
 * Exit    0 all values are good. 1 AWB3 rejects a value (the checks of src/core/config.ts). 2 the file or the YAML is bad.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import devvit from '../devvit.json';
import { parseConfig, validateSetting } from '../src/core/config';

// js-yaml stays on 3.x (no types come with it): it reads YAML 1.1 octals (010 = 8) as PyYAML (legacy) does; 4+ reads 010 as 10.
// CORE_SCHEMA is safe. It reads a plain `true,` as a text, as PyYAML does.
const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string, options: { schema: unknown }): unknown; CORE_SCHEMA: unknown };

type Settings = Record<string, unknown>;
type Section = Record<string, unknown>;

export class InputError extends Error {}

const isMap = (value: unknown): value is Section => typeof value === 'object' && value !== null && !Array.isArray(value);

// The keys of the legacy page (legacy requirements 7.3).
const SECTIONS = {
  ResolutionMismatch: ['enabled'],
  ResolutionBad: ['enabled', 'horizontal', 'vertical', 'square'],
  AspectRatioBad: ['enabled', 'horizontal', 'vertical'],
  RateLimitAny: ['enabled', 'interval_hours', 'frequency', 'incl_deleted'],
  SourceCommentAny: ['enabled', 'timeout_hrs'],
  RepostAny: ['enabled', 'report_only', 'similarity_pct', 'threshold_months'],
};
const TOP = ['enabled', 'flairs', 'except_authors', ...Object.keys(SECTIONS)];

// Each setting of devvit.json with its default, in the order of the file.
const DEFAULTS: Settings = Object.fromEntries(Object.entries(devvit.settings.subreddit).map(([key, setting]) => [key, setting.defaultValue]));

// PyYAML reads the plain words yes, no, on and off as booleans. js-yaml does not.
// shortcut: a quoted "no" gives false here, and PyYAML reads it as a text (true). Change it when a real page has a quoted word.
const YES = /^(?:yes|Yes|YES|on|On|ON)$/;
const NO = /^(?:no|No|NO|off|Off|OFF)$/;

const text = (value: unknown) => (value == null ? '' : String(value)); // a null threshold is an empty setting; the core checks the text

export function convert(source: string): { settings: Settings; warnings: string[]; problems: string[] } {
  let page: unknown;
  try {
    page = yaml.load(source, { schema: yaml.CORE_SCHEMA });
  } catch (e) {
    throw new InputError(`The page is bad YAML: ${(e as Error).message}`);
  }
  if (!isMap(page)) throw new InputError('The page is not a map of legacy keys.');

  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);

  // A flag as Python reads it: a value that is not empty, not 0 and not null is true. So the text `true,` is true, and so is the text "false".
  const flag = (where: string, value: unknown): boolean => {
    if (typeof value === 'string' && YES.test(value)) return true;
    if (typeof value === 'string' && NO.test(value)) return false;
    const truth = Array.isArray(value) ? value.length > 0 : isMap(value) ? Object.keys(value).length > 0 : Boolean(value);
    if (typeof value !== 'boolean' && value != null) {
      warn(`${where} is ${JSON.stringify(value)}, not true or false. Legacy (Python) reads it as ${truth}. The tool does the same.`);
    }
    return truth;
  };

  for (const key of Object.keys(page)) {
    if (!TOP.includes(key)) warn(`${key}: not mapped. Legacy ignores a key that it does not know, and AWB3 has no setting for it.`);
  }
  const section = (name: keyof typeof SECTIONS): Section => {
    const value = page[name] ?? {};
    if (!isMap(value)) throw new InputError(`${name} must be a map.`);
    for (const key of Object.keys(value)) {
      if (!SECTIONS[name].includes(key)) warn(`${name}.${key}: not mapped. Legacy stops all moderation on a key that it does not know.`);
    }
    return value;
  };

  // `mode` is dry-run: the cut-over starts there. The 3.0 manifest has no repost settings but repostMonths: 3.0 has no repost check.
  const settings: Settings = { ...DEFAULTS, mode: 'dry-run' };

  const authors = page.except_authors ?? [];
  if (!Array.isArray(authors)) throw new InputError('except_authors must be a list of user names.');
  settings.exceptAuthors = authors.join(',');

  const flairs = page.flairs ?? {};
  if (!isMap(flairs)) throw new InputError('flairs must be a map of flair text to a value.');
  settings.flairRules = Object.entries(flairs)
    .map(([flair, value]) => `${flair}: ${value}`)
    .join('\n');

  settings.resolutionMismatch = flag('ResolutionMismatch.enabled', section('ResolutionMismatch').enabled);

  const size = section('ResolutionBad');
  settings.resolutionBad = flag('ResolutionBad.enabled', size.enabled);
  settings.minHorizontal = text(size.horizontal);
  settings.minVertical = text(size.vertical);
  settings.minSquare = text(size.square);

  const aspect = section('AspectRatioBad');
  settings.aspectRatio = flag('AspectRatioBad.enabled', aspect.enabled);
  settings.aspectHorizontal = text(aspect.horizontal);
  settings.aspectVertical = text(aspect.vertical);

  const rate = section('RateLimitAny');
  settings.rateLimit = flag('RateLimitAny.enabled', rate.enabled);
  settings.rateLimitHours = rate.interval_hours ?? settings.rateLimitHours;
  settings.rateLimitPosts = rate.frequency ?? settings.rateLimitPosts;
  if ('incl_deleted' in rate) settings.rateLimitCountDeleted = flag('RateLimitAny.incl_deleted', rate.incl_deleted);
  else if (page.RateLimitAny != null) {
    // A missing key gives the Python default of the rule (True). A missing section keeps the default page of legacy (false).
    settings.rateLimitCountDeleted = true;
    warn('RateLimitAny.incl_deleted is missing. Legacy then counts deleted posts, so rateLimitCountDeleted is true.');
  }

  const sourceComment = section('SourceCommentAny');
  settings.sourceComment = flag('SourceCommentAny.enabled', sourceComment.enabled);
  settings.sourceHours = sourceComment.timeout_hrs ?? settings.sourceHours;

  const repost = section('RepostAny');
  const repostOn = flag('RepostAny.enabled', repost.enabled);
  const reportOnly = 'report_only' in repost ? flag('RepostAny.report_only', repost.report_only) : true;
  settings.repostMonths = repost.threshold_months ?? settings.repostMonths;
  if (repostOn) {
    warn('RepostAny: not mapped in 3.0. AWB3 does not check reposts. Keep the legacy bot on repost checks until cut-over 2 (plan D13).');
    if (!reportOnly) {
      warn('RepostAny.report_only is false, so legacy removes reposts. AWB3 3.1 reports reposts first, and removes them only after its shadow (plan OD4, D14, D18).');
    }
    if (repost.similarity_pct != null) {
      warn(
        `RepostAny.similarity_pct (${repost.similarity_pct}) is a limit on the legacy SIFT score. It does not map to the similarity percent of AWB3 3.1 (plan D16).` +
          // The legacy test is `sigmoid(...) > similarity_pct` (acr_worker/__init__.py), and the sigmoid never goes above 1.
          (Number(repost.similarity_pct) >= 1 ? ' Legacy needs a score above this limit, and the score is never above 1, so legacy finds no repost with it.' : ''),
      );
    }
  }

  // The core takes a number or a text as the mod enters it. A bad value is a problem, and it stays in the output.
  const problems = [
    ...Object.entries(settings).flatMap(([key, value]) => {
      const message = validateSetting(key, value);
      return message === undefined ? [] : [`${key}: ${message}`];
    }),
    ...parseConfig(settings).problems,
  ];
  return { settings, warnings, problems };
}

const show = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

/** One line for each setting, as the mod enters it. The flair rules are one line for each rule, under their key. */
export function format(settings: Settings): string {
  const lines = Object.entries(settings).flatMap(([key, value]) =>
    key === 'flairRules' && value !== ''
      ? [`${key}:`, ...String(value).split('\n').map((line) => `  ${line}`)]
      : [`${key}: ${value === '' ? '(empty)' : show(value)}`],
  );
  return `${lines.join('\n')}\n`;
}

function main(argv: string[]): number {
  const [file, ...rest] = argv;
  if (file === undefined || rest.length > 0) {
    process.stderr.write('Usage: npx tsx tools/legacy_settings.ts <legacy-page.yaml>\n');
    return 2;
  }
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (e) {
    process.stderr.write(`legacy_settings: ${(e as Error).message}\n`);
    return 2;
  }
  try {
    const { settings, warnings, problems } = convert(source);
    process.stdout.write(format(settings));
    for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
    for (const problem of problems) process.stderr.write(`problem: ${problem}\n`);
    return problems.length > 0 ? 1 : 0;
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
    process.stderr.write(`legacy_settings: ${e.message}\n`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) process.exitCode = main(process.argv.slice(2));
