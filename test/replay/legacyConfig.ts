// The legacy `awb` wiki page (YAML) as install settings, for the replay. The reader below knows the YAML that the legacy bot writes (oyaml
// block style) and that mods write into the page: maps, lists, flow maps and lists of plain values, quoted text, comments. Anything else is
// an error with its line number: a guess could give the replay wrong settings without a word.
export type Settings = Record<string, string | number | boolean>;

interface Line {
  n: number;
  indent: number;
  text: string;
}

/** The line without its `#` comment. A quote opens only where a value starts, so an apostrophe in a name is not a quote. */
function withoutComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) quote = c === quote ? '' : quote;
    else if ((c === '"' || c === "'") && (i === 0 || /[\s:[{,-]/.test(line[i - 1]!))) quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function scalar(text: string): unknown {
  const double = /^"((?:[^"\\]|\\.)*)"$/.exec(text);
  const single = /^'((?:[^']|'')*)'$/.exec(text);
  if (double) return double[1]!.replace(/\\(.)/g, '$1');
  if (single) return single[1]!.replace(/''/g, "'");
  if (text === '' || text === '~' || /^null$/i.test(text)) return null;
  if (/^(true|yes|on)$/i.test(text)) return true;
  if (/^(false|no|off)$/i.test(text)) return false;
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
}

/** A value on the line of its key or of its `-`: a scalar, or a flow map or list of scalars on one line. */
function value(text: string, n: number): unknown {
  if (/^[|>][+-]?$/.test(text)) throw new Error(`line ${n}: block text is not supported`);
  if (/^[&*]/.test(text)) throw new Error(`line ${n}: anchors and aliases are not supported`);
  const flow = /^([{[])(.*)([}\]])$/.exec(text);
  if (!flow) return scalar(text);
  if (/[{[]/.test(flow[2]!)) throw new Error(`line ${n}: a flow collection holds plain values only`);
  const parts = flow[2]!.trim() === '' ? [] : flow[2]!.split(/,(?=(?:[^"']|"[^"]*"|'[^']*')*$)/).map((part) => part.trim());
  if (flow[1] === '[') return parts.map(scalar);
  return Object.fromEntries(parts.map((part) => {
    const [key, rest] = entry({ n, text: part });
    return [key, scalar(rest)];
  }));
}

/** `key: rest`, with a quoted key or a bare one. */
function entry({ n, text }: Pick<Line, 'n' | 'text'>): [string, string] {
  const quoted = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)')\s*:(?:\s+(.*))?$/.exec(text);
  if (quoted) return [(quoted[1] ?? quoted[2]!.replace(/''/g, "'")).replace(/\\(.)/g, '$1'), (quoted[3] ?? '').trim()];
  const at = text.search(/:(\s|$)/);
  if (at < 0) throw new Error(`line ${n}: a map entry needs a colon: ${text}`);
  return [text.slice(0, at).trim(), text.slice(at + 1).trim()];
}

function block(lines: Line[], at: { i: number }, indent: number): unknown {
  const list = lines[at.i]!.text.startsWith('-');
  const items: unknown[] = [];
  const map: Record<string, unknown> = {};
  for (let line = lines[at.i]; line && line.indent === indent && line.text.startsWith('-') === list; line = lines[at.i]) {
    at.i += 1;
    if (list) {
      items.push(value(line.text.slice(1).trim(), line.n));
      continue;
    }
    const [key, rest] = entry(line);
    if (Object.hasOwn(map, key)) throw new Error(`line ${line.n}: the key "${key}" is twice in the map`);
    const next = lines[at.i];
    // The value is on the line, or in the block below it; a list may stand at the indent of its key.
    map[key] = rest !== '' ? value(rest, line.n) : next && (next.indent > indent || (next.indent === indent && next.text.startsWith('-'))) ? block(lines, at, next.indent) : null;
  }
  return list ? items : map;
}

export function parseYaml(text: string): unknown {
  const lines = text.split('\n').flatMap((raw, i): Line[] => {
    if (/^ *\t/.test(raw)) throw new Error(`line ${i + 1}: a tab in the indent`);
    const body = withoutComment(raw).trimEnd();
    return body.trim() === '' ? [] : [{ n: i + 1, indent: body.length - body.trimStart().length, text: body.trimStart() }];
  });
  if (lines.length === 0) return {};
  const at = { i: 0 };
  const result = block(lines, at, lines[0]!.indent);
  if (at.i < lines.length) throw new Error(`line ${lines[at.i]!.n}: bad indent`);
  return result;
}

// The keys of each rule section of the legacy page (legacy requirements 7.3). ResolutionAny and ImageLimitAny are inactive rules (1.8).
const SECTIONS: Record<string, string[]> = {
  ResolutionMismatch: ['enabled'],
  ResolutionBad: ['enabled', 'horizontal', 'vertical', 'square'],
  AspectRatioBad: ['enabled', 'horizontal', 'vertical'],
  RateLimitAny: ['enabled', 'interval_hours', 'frequency', 'incl_deleted'],
  SourceCommentAny: ['enabled', 'timeout_hrs'],
  RepostAny: ['enabled', 'report_only', 'similarity_pct', 'threshold_months'],
};
const INACTIVE = ['ResolutionAny', 'ImageLimitAny'];

const map = (v: unknown, name: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`legacy config: "${name}" must be a map`);
  return v as Record<string, unknown>;
};

/**
 * The install settings (plan 5.6) of a legacy page. The page is on (`enabled`) = mode enforce. A rule that the page has gets its switch and
 * its thresholds; RepostAny is not mapped in 3.0. A key that the legacy bot does not read is an error.
 */
export function legacySettings(page: unknown): Settings {
  const top = map(page, 'the page');
  for (const key of Object.keys(top)) {
    if (!['enabled', 'flairs', 'except_authors', ...Object.keys(SECTIONS), ...INACTIVE].includes(key)) throw new Error(`legacy config: unknown key "${key}"`);
  }
  const settings: Settings = { mode: top.enabled === true ? 'enforce' : 'off' };
  const flairs = Object.entries(map(top.flairs ?? {}, 'flairs'));
  if (flairs.length > 0) settings.flairRules = flairs.map(([flair, rule]) => `${flair}: ${rule}`).join('\n');
  const except = top.except_authors ?? [];
  if (!Array.isArray(except)) throw new Error('legacy config: "except_authors" must be a list');
  if (except.length > 0) settings.exceptAuthors = except.join(', ');

  const section = (name: string) => {
    const rule = map(top[name], name);
    for (const key of Object.keys(rule)) if (!SECTIONS[name]!.includes(key)) throw new Error(`legacy config: unknown key "${name}.${key}"`);
    return rule;
  };
  const text = (rule: Record<string, unknown>, from: string, to: string) => {
    if (typeof rule[from] === 'string') settings[to] = rule[from];
  };
  const number = (rule: Record<string, unknown>, name: string, from: string, to: string) => {
    if (rule[from] === undefined || rule[from] === null) return;
    if (typeof rule[from] !== 'number') throw new Error(`legacy config: "${name}.${from}" must be a number`);
    settings[to] = rule[from];
  };
  if (top.ResolutionMismatch !== undefined) settings.resolutionMismatch = section('ResolutionMismatch').enabled === true;
  if (top.ResolutionBad !== undefined) {
    const rule = section('ResolutionBad');
    settings.resolutionBad = rule.enabled === true;
    text(rule, 'horizontal', 'minHorizontal');
    text(rule, 'vertical', 'minVertical');
    text(rule, 'square', 'minSquare');
  }
  if (top.AspectRatioBad !== undefined) {
    const rule = section('AspectRatioBad');
    settings.aspectRatio = rule.enabled === true;
    text(rule, 'horizontal', 'aspectHorizontal');
    text(rule, 'vertical', 'aspectVertical');
  }
  if (top.RateLimitAny !== undefined) {
    const rule = section('RateLimitAny');
    settings.rateLimit = rule.enabled === true;
    number(rule, 'RateLimitAny', 'interval_hours', 'rateLimitHours');
    number(rule, 'RateLimitAny', 'frequency', 'rateLimitPosts');
    settings.rateLimitCountDeleted = (rule.incl_deleted ?? true) === true; // a section without the key: the Python default of the rule is True (L 1.5)
  }
  if (top.SourceCommentAny !== undefined) {
    const rule = section('SourceCommentAny');
    settings.sourceComment = rule.enabled === true;
    number(rule, 'SourceCommentAny', 'timeout_hrs', 'sourceHours');
  }
  if (top.RepostAny !== undefined) section('RepostAny');
  return settings;
}
