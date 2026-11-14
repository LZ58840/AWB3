// Tests of tools/legacy_settings.ts (plan 11, Phase 5, cut-over 1, step 1: copy the values of the legacy wiki page into the install settings).
// The expected settings are written by hand from the two real legacy pages (test/fixtures/legacy-config-*.yaml) and from the defaults of
// plan 5.6, not computed by the tool. The legacy rules that the small cases follow: legacy requirements 1.1-1.10 and 7.3, and the legacy code
// (PyYAML safe_load, Python truth of a flag, `incl_deleted: bool = True`).
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { convert, format, InputError } from '../../tools/legacy_settings';

const root = fileURLToPath(new URL('../../', import.meta.url));
const page = (name: string) => readFileSync(join(root, 'test/fixtures', `legacy-config-${name}.yaml`), 'utf8');

// The command line cases start tsx.
vi.setConfig({ testTimeout: 30_000 });

// The 18 settings of devvit.json (3.0) in its order. They are written here again on purpose: a new setting needs a decision in the tool.
const KEYS = [
  'mode',
  'exceptAuthors',
  'flairRules',
  'resolutionMismatch',
  'resolutionBad',
  'minHorizontal',
  'minVertical',
  'minSquare',
  'aspectRatio',
  'aspectHorizontal',
  'aspectVertical',
  'rateLimit',
  'rateLimitHours',
  'rateLimitPosts',
  'rateLimitCountDeleted',
  'sourceComment',
  'sourceHours',
  'repostMonths',
];

// What the tool prints for a setting that the legacy page does not set: the defaults of plan 5.6, and `mode` dry-run (cut-over starts there).
const DEFAULTS = {
  mode: 'dry-run',
  exceptAuthors: '',
  flairRules: '',
  resolutionMismatch: false,
  resolutionBad: false,
  minHorizontal: '',
  minVertical: '',
  minSquare: '',
  aspectRatio: false,
  aspectHorizontal: '',
  aspectVertical: '',
  rateLimit: false,
  rateLimitHours: 24,
  rateLimitPosts: 4,
  rateLimitCountDeleted: false,
  sourceComment: false,
  sourceHours: 1,
  repostMonths: 6,
};

// legacy-config-animewallpaper.yaml
const ANIMEWALLPAPER = {
  mode: 'dry-run',
  exceptAuthors: 'AutoModerator,user00001,user00002',
  flairRules: 'Mobile: vertical\nDesktop: horizontal\nAnimated: skip\nMisc: skip',
  resolutionMismatch: true,
  resolutionBad: true,
  minHorizontal: '1920x1080',
  minVertical: '900x1600',
  minSquare: '',
  aspectRatio: true,
  aspectHorizontal: '16:10 to none',
  aspectVertical: '9:21 to 10:16',
  rateLimit: true,
  rateLimitHours: 24,
  rateLimitPosts: 4,
  rateLimitCountDeleted: true,
  sourceComment: true,
  sourceHours: 1,
  repostMonths: 6, // 3.0 has no repost check: only the history length of `seen:` is a setting
};

// legacy-config-animephonewallpapers.yaml: no horizontal sizes (null), one author, other flairs, vertical aspect 9:21 to 9:16.
const ANIMEPHONEWALLPAPERS = {
  ...ANIMEWALLPAPER,
  exceptAuthors: 'AutoModerator',
  flairRules: 'Wallpaper: vertical\nRequest: skip\nFulfilled: skip\nMisc: skip',
  minHorizontal: '',
  aspectHorizontal: '',
  aspectVertical: '9:21 to 9:16',
};

// The stdout of the command line for the first page, as a mod reads it.
const ANIMEWALLPAPER_STDOUT = `mode: dry-run
exceptAuthors: AutoModerator,user00001,user00002
flairRules:
  Mobile: vertical
  Desktop: horizontal
  Animated: skip
  Misc: skip
resolutionMismatch: true
resolutionBad: true
minHorizontal: 1920x1080
minVertical: 900x1600
minSquare: (empty)
aspectRatio: true
aspectHorizontal: 16:10 to none
aspectVertical: 9:21 to 10:16
rateLimit: true
rateLimitHours: 24
rateLimitPosts: 4
rateLimitCountDeleted: true
sourceComment: true
sourceHours: 1
repostMonths: 6
`;

// The default page of the legacy bot (legacy requirements, Appendix B1): every rule off, no threshold.
const B1 = `enabled: false
flairs: {}
except_authors: []
ResolutionMismatch:
  enabled: false
ResolutionBad:
  enabled: false
  horizontal: null
  vertical: null
  square: null
AspectRatioBad:
  enabled: false
  horizontal: null
  vertical: null
RateLimitAny:
  enabled: false
  interval_hours: null
  frequency: null
  incl_deleted: false
SourceCommentAny:
  enabled: false
  timeout_hrs: null
RepostAny:
  enabled: false
  report_only: true
  similarity_pct: 0.75
  threshold_months: 6
`;

/** The warnings that match `re`. */
const matching = (warnings: string[], re: RegExp) => warnings.filter((w) => re.test(w));

describe('the two real legacy pages', () => {
  it('r/Animewallpaper gives these settings, with no problem', () => {
    const { settings, problems } = convert(page('animewallpaper'));
    expect(settings).toEqual(ANIMEWALLPAPER);
    expect(problems).toEqual([]);
  });

  it('r/AnimePhoneWallpapers gives these settings, with no problem', () => {
    const { settings, problems } = convert(page('animephonewallpapers'));
    expect(settings).toEqual(ANIMEPHONEWALLPAPERS);
    expect(problems).toEqual([]);
  });

  it.each(['animewallpaper', 'animephonewallpapers'])('%s: all 18 settings, in the order of devvit.json', (name) => {
    expect(Object.keys(convert(page(name)).settings)).toEqual(KEYS);
  });

  it('r/Animewallpaper warns about the repost keys and nothing else', () => {
    const { warnings } = convert(page('animewallpaper'));
    expect(warnings).toHaveLength(3);
    expect(matching(warnings, /^RepostAny: not mapped in 3\.0\. AWB3 does not check reposts/)).toHaveLength(1);
    // legacy report_only is false: the tool says that 3.1 reports first (OD4, D18)
    expect(matching(warnings, /^RepostAny\.report_only is false.*3\.1 reports reposts first/)).toHaveLength(1);
    // similarity_pct 1.0 never fires in legacy: the score is `sigmoid(...) > similarity_pct` and the sigmoid is at most 1
    expect(matching(warnings, /^RepostAny\.similarity_pct \(1\).*similarity percent of AWB3 3\.1.*finds no repost/)).toHaveLength(1);
  });

  it('r/AnimePhoneWallpapers reads `report_only: true,` as true, like legacy, and warns', () => {
    const { warnings, settings } = convert(page('animephonewallpapers'));
    expect(settings).not.toHaveProperty('repostReportOnly'); // 3.0 has no such setting
    expect(warnings).toHaveLength(3);
    expect(matching(warnings, /^RepostAny\.report_only is "true,", not true or false\. Legacy \(Python\) reads it as true/)).toHaveLength(1);
    expect(matching(warnings, /^RepostAny: not mapped in 3\.0/)).toHaveLength(1);
    const similarity = matching(warnings, /^RepostAny\.similarity_pct \(0\.75\).*similarity percent of AWB3 3\.1/);
    expect(similarity).toHaveLength(1);
    expect(similarity[0]).not.toMatch(/finds no repost/); // 0.75 is a score that legacy can reach
    expect(matching(warnings, /report_only is false/)).toEqual([]); // legacy reports only here
  });
});

describe('legacy keys and defaults', () => {
  it('the default page of the legacy bot gives the AWB3 defaults, with no warning', () => {
    const { settings, warnings, problems } = convert(B1);
    expect(settings).toEqual(DEFAULTS);
    expect(warnings).toEqual([]);
    expect(problems).toEqual([]);
  });

  it('a page with only a switch has no rule on', () => {
    expect(convert('enabled: true\n').settings).toEqual(DEFAULTS);
  });

  it('mode is dry-run whatever the legacy switch says, and the 3.0 settings have no repost mode', () => {
    for (const enabled of ['true', 'false']) {
      const { settings } = convert(`enabled: ${enabled}\nRepostAny:\n  enabled: true\n  report_only: true\n  similarity_pct: 0.75\n  threshold_months: 6\n`);
      expect(settings.mode).toBe('dry-run');
      expect(settings).not.toHaveProperty('repostMode');
    }
  });

  it('keeps the thresholds of a rule that is off', () => {
    const { settings, problems } = convert(`enabled: true
ResolutionBad:
  enabled: false
  horizontal: 1280x720
RateLimitAny:
  enabled: false
  interval_hours: 12
  frequency: 2
  incl_deleted: false
SourceCommentAny:
  enabled: false
  timeout_hrs: 0.5
`);
    expect(settings).toEqual({
      ...DEFAULTS,
      minHorizontal: '1280x720',
      rateLimitHours: 12,
      rateLimitPosts: 2,
      sourceHours: 0.5,
    });
    expect(problems).toEqual([]);
  });

  it('a null threshold is empty, a null number is the default, and a flair name can hold a colon', () => {
    const { settings, problems } = convert(`flairs:
  "Art: Original": horizontal, vertical
ResolutionBad:
  enabled: true
  horizontal: null
  vertical: 900x1600
RateLimitAny:
  enabled: true
  interval_hours: null
  frequency: 3
  incl_deleted: true
`);
    expect(settings.flairRules).toBe('Art: Original: horizontal, vertical');
    expect([settings.minHorizontal, settings.minVertical]).toEqual(['', '900x1600']);
    expect([settings.rateLimitHours, settings.rateLimitPosts]).toEqual([24, 3]);
    expect(problems).toEqual([]);
  });

  it('a rate limit section without incl_deleted counts deleted posts, like the Python default of legacy, and warns', () => {
    const { settings, warnings } = convert('RateLimitAny:\n  enabled: true\n  interval_hours: 12\n  frequency: 3\n');
    expect(settings.rateLimitCountDeleted).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^RateLimitAny\.incl_deleted is missing.*rateLimitCountDeleted is true/);
  });

  it('a missing rate limit section keeps the default, and incl_deleted false stays false', () => {
    expect(convert('enabled: true\n').settings.rateLimitCountDeleted).toBe(false);
    const { settings, warnings } = convert('RateLimitAny:\n  enabled: true\n  interval_hours: 12\n  frequency: 3\n  incl_deleted: false\n');
    expect(settings.rateLimitCountDeleted).toBe(false);
    expect(warnings).toEqual([]);
  });
});

describe('a flag is read like the legacy Python code reads it', () => {
  it('reads the plain YAML 1.1 words yes, no, on and off as booleans, with no warning', () => {
    const { settings, warnings } = convert('ResolutionMismatch:\n  enabled: yes\nRateLimitAny:\n  enabled: on\n  incl_deleted: no\nSourceCommentAny:\n  enabled: Off\n');
    expect([settings.resolutionMismatch, settings.rateLimit, settings.rateLimitCountDeleted, settings.sourceComment]).toEqual([true, true, false, false]);
    expect(warnings).toEqual([]);
  });

  it('reads a text that is not empty as true, also the text "false", and warns for each', () => {
    const { settings, warnings } = convert(`ResolutionMismatch:
  enabled: "false"
AspectRatioBad:
  enabled: "true,"
  vertical: 9:21 to 10:16
`);
    expect([settings.resolutionMismatch, settings.aspectRatio]).toEqual([true, true]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^ResolutionMismatch\.enabled is "false", not true or false\. Legacy \(Python\) reads it as true/);
    expect(warnings[1]).toMatch(/^AspectRatioBad\.enabled is "true,", not true or false\. Legacy \(Python\) reads it as true/);
  });

  // Each row is the answer of the legacy reader: `bool(yaml.safe_load(...))` with PyYAML 6.0.3 (the legacy bot uses yaml.safe_load).
  // The third column says whether the tool warns: it does not for a boolean, for null and for the plain words yes, no, on and off.
  it.each([
    ['true', true, false],
    ['False', false, false],
    ['yes', true, false],
    ['No', false, false],
    ['ON', true, false],
    ['off', false, false],
    ['~', false, false],
    ['null', false, false],
    ['y', true, true],
    ['n', true, true],
    ['oFf', true, true],
    ['true,', true, true],
    ['"false"', true, true],
    ['""', false, true],
    ['0', false, true],
    ['0.0', false, true],
    ['1', true, true],
    ['[]', false, true],
    ['{}', false, true],
    ['[a]', true, true],
    ['{a: 1}', true, true],
  ])('enabled: %s is read as %s (warns: %s)', (value, expected, warns) => {
    const { settings, warnings } = convert(`ResolutionMismatch:\n  enabled: ${value}\n`);
    expect(settings.resolutionMismatch).toBe(expected);
    expect(warnings).toHaveLength(warns ? 1 : 0);
  });
});

describe('keys that are not mapped', () => {
  it('warns for a top-level key that legacy ignores (ResolutionAny is dropped, plan Q5) and for an unknown key of a rule section', () => {
    const { settings, warnings } = convert(`ResolutionAny:
  enabled: true
RateLimitAny:
  enabled: true
  interval_hours: 24
  frequency: 4
  inc_deleted: false
`);
    expect(warnings).toHaveLength(3);
    expect(matching(warnings, /^ResolutionAny: not mapped\. Legacy ignores a key that it does not know, and AWB3 has no setting for it\./)).toHaveLength(1);
    expect(matching(warnings, /^RateLimitAny\.inc_deleted: not mapped\. Legacy stops all moderation on a key that it does not know/)).toHaveLength(1);
    expect(matching(warnings, /^RateLimitAny\.incl_deleted is missing/)).toHaveLength(1); // the typo left the real key out
    expect(settings.resolutionMismatch).toBe(false); // a section that is not mapped switches nothing on
  });
});

describe('a value that AWB3 rejects is a problem, and the value is still printed', () => {
  const bad = `enabled: true
flairs:
  Mobile: Vertical
except_authors:
  - u/foo
ResolutionBad:
  enabled: true
  horizontal: 1920*1080
AspectRatioBad:
  enabled: true
  horizontal: 16:10 to 9:21
  vertical: 16:10
RateLimitAny:
  enabled: true
  interval_hours: 1.5
  frequency: 4
  incl_deleted: true
SourceCommentAny:
  enabled: true
  timeout_hrs: 0.001
RepostAny:
  enabled: true
  report_only: true
  similarity_pct: 0.75
  threshold_months: 12
`;
  const prefixes = (problems: string[]) => problems.map((p) => p.split(':')[0]);

  it('names each setting, from validateSetting', () => {
    const { settings, problems } = convert(bad);
    // legacy reads `Vertical` as a name that matches no orientation; `16:10` alone is the number 970 in YAML 1.1
    for (const key of ['flairRules', 'exceptAuthors', 'minHorizontal', 'aspectHorizontal', 'aspectVertical', 'rateLimitHours', 'sourceHours', 'repostMonths']) {
      expect(prefixes(problems), key).toContain(key);
    }
    expect(settings).toMatchObject({ flairRules: 'Mobile: Vertical', exceptAuthors: 'u/foo', minHorizontal: '1920*1080', aspectVertical: '970', rateLimitHours: 1.5, repostMonths: 12 });
  });

  it('adds the cross-field problem of parseConfig: a rule that is on needs a threshold', () => {
    const { problems } = convert('ResolutionBad:\n  enabled: true\n  horizontal: null\nAspectRatioBad:\n  enabled: true\n  horizontal: none to none\n');
    expect(problems).toEqual(['resolutionBad: Set at least one minimum size.', 'aspectRatio: Set at least one limit.']);
  });

  it('adds the parseConfig problems of a bad value, with the rule name', () => {
    const { problems } = convert(bad);
    expect(problems).toContain('resolutionBad: minHorizontal: Write the size as WxH, for example 1920x1080.');
  });
});

describe('a page that is not a map of legacy keys is an input error', () => {
  it.each([
    ['empty', '', /not a map/],
    ['a comment only', '# nothing\n', /not a map/],
    ['a list', '- a\n- b\n', /not a map/],
    ['a text', 'just text\n', /not a map/],
    ['bad YAML', 'a: [1\nb: 2\n', /bad YAML/],
    ['a key twice', 'enabled: true\nenabled: false\n', /bad YAML.*duplicated mapping key/],
    ['flairs as a list', 'flairs:\n  - a\n', /flairs must be a map/],
    ['except_authors as a text', 'except_authors: AutoModerator\n', /except_authors must be a list/],
    ['a rule section as a number', 'RateLimitAny: 5\n', /RateLimitAny must be a map/],
  ])('%s', (_name, text, message) => {
    expect(() => convert(text)).toThrow(InputError);
    expect(() => convert(text)).toThrow(message);
  });
});

describe('format', () => {
  it('writes an empty value as (empty) and the flair rules as an indented block', () => {
    const out = format(convert('flairs:\n  Misc: skip\n').settings);
    expect(out).toContain('\nflairRules:\n  Misc: skip\nresolutionMismatch: false\n');
    expect(out).toContain('\nexceptAuthors: (empty)\n');
    expect(format(convert('enabled: true\n').settings)).toContain('\nflairRules: (empty)\n');
  });
});

describe('the command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-settings-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const tsx = join(root, 'node_modules/.bin/tsx');
  const run = (...args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
      execFile(tsx, [join(root, 'tools/legacy_settings.ts'), ...args], { cwd: root, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) =>
        done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }),
      ),
    );

  it('prints the settings on stdout and the warnings on stderr, and exits 0', async () => {
    const r = await run(join(root, 'test/fixtures/legacy-config-animewallpaper.yaml'));
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(ANIMEWALLPAPER_STDOUT);
    const lines = r.stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.startsWith('warning: RepostAny'))).toBe(true);
  });

  it('prints the second page, with its flair rules and its warning about the text "true,"', async () => {
    const r = await run(join(root, 'test/fixtures/legacy-config-animephonewallpapers.yaml'));
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('exceptAuthors: AutoModerator\nflairRules:\n  Wallpaper: vertical\n  Request: skip\n  Fulfilled: skip\n  Misc: skip\n');
    expect(r.stdout).toContain('minHorizontal: (empty)\nminVertical: 900x1600\nminSquare: (empty)\n');
    expect(r.stdout).toContain('aspectHorizontal: (empty)\naspectVertical: 9:21 to 9:16\n');
    expect(r.stderr).toContain('warning: RepostAny.report_only is "true,"');
    expect(r.stderr).not.toContain('problem:');
  });

  it('exits 1 and names the setting when AWB3 rejects a value, and still prints the settings', async () => {
    const r = await run(file('bad.yaml', 'ResolutionBad:\n  enabled: true\n  horizontal: big\n'));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('\nminHorizontal: big\n');
    expect(r.stderr).toContain('problem: minHorizontal: Write the size as WxH, for example 1920x1080.');
  });

  it('exits 2 with a message for no file, a missing file, bad YAML and a page that is not a map', async () => {
    const cases = [
      { args: [], message: /^Usage: npx tsx tools\/legacy_settings\.ts <legacy-page\.yaml>/ },
      { args: [join(dir, 'missing.yaml')], message: /ENOENT/ },
      { args: [file('syntax.yaml', 'a: [1\n')], message: /bad YAML/ },
      { args: [file('list.yaml', '- a\n')], message: /not a map/ },
    ];
    for (const { args, message } of cases) {
      const r = await run(...args);
      expect(r.code, r.stderr).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(message);
    }
  });
});
