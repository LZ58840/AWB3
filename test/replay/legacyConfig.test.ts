// The legacy `awb` wiki page (YAML) becomes the install settings of the replay. The inputs are the pages of the legacy requirements
// (Appendix B); the expected settings are written by hand from the setting names of plan 5.6.
import { expect, test } from 'vitest';
import { legacySettings, parseYaml } from './legacyConfig';

// Appendix B1: the default page (oyaml.safe_dump style: a list is not indented under its key).
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

// Appendix B2: the test configuration that is probably close to production (flow style for the rules).
const B2 = `enabled: true
flairs:
  Desktop: horizontal
  Mobile: vertical
  Collection: horizontal, vertical
  Other: skip
ResolutionMismatch: {enabled: true}
ResolutionBad: {enabled: true, horizontal: 1920x1080, vertical: 900x1600, square: null}
AspectRatioBad: {enabled: true, horizontal: "16:10 to none", vertical: "9:21 to 10:16"}
RateLimitAny: {enabled: true, interval_hours: 24, frequency: 4}
SourceCommentAny: {enabled: true, timeout_hrs: 0.017}
`;

test('the default page switches everything off and sets no threshold', () => {
  expect(legacySettings(parseYaml(B1))).toEqual({
    mode: 'off', resolutionMismatch: false, resolutionBad: false, aspectRatio: false, rateLimit: false, rateLimitCountDeleted: false, sourceComment: false,
  });
});

test('the production-like page maps every rule to its settings; a rate-limit section without incl_deleted counts deleted posts (L 1.5)', () => {
  expect(legacySettings(parseYaml(B2))).toEqual({
    mode: 'enforce',
    flairRules: 'Desktop: horizontal\nMobile: vertical\nCollection: horizontal, vertical\nOther: skip',
    resolutionMismatch: true,
    resolutionBad: true, minHorizontal: '1920x1080', minVertical: '900x1600',
    aspectRatio: true, aspectHorizontal: '16:10 to none', aspectVertical: '9:21 to 10:16',
    rateLimit: true, rateLimitHours: 24, rateLimitPosts: 4, rateLimitCountDeleted: true, // the Python default of a missing key is True
    sourceComment: true, sourceHours: 0.017,
  });
});

test('the YAML that the legacy bot writes: a list under its key, quoted keys and values, comments, and a trailing comment', () => {
  const page = `# edited by hand
enabled: true   # on
except_authors:
- alice
- 'bob_2'
flairs:
  'Art: Original': "horizontal, vertical"
  "It's mine": skip
RateLimitAny:
  enabled: true
  interval_hours: 24
  frequency: 3
  incl_deleted: no
`;
  expect(parseYaml(page)).toEqual({
    enabled: true,
    except_authors: ['alice', 'bob_2'],
    flairs: { 'Art: Original': 'horizontal, vertical', "It's mine": 'skip' },
    RateLimitAny: { enabled: true, interval_hours: 24, frequency: 3, incl_deleted: false },
  });
  expect(legacySettings(parseYaml(page))).toMatchObject({
    exceptAuthors: 'alice, bob_2',
    flairRules: "Art: Original: horizontal, vertical\nIt's mine: skip",
    rateLimitCountDeleted: false,
  });
});

test('flow lists and the scalars of YAML: null, ~, yes and no, numbers, quoted numbers', () => {
  expect(parseYaml('a: [x, "y z"]\nb: ~\nc: yes\nd: Off\ne: 1.5\nf: -3\ng: "7"\nh: []\ni: {}\n')).toEqual({
    a: ['x', 'y z'], b: null, c: true, d: false, e: 1.5, f: -3, g: '7', h: [], i: {},
  });
});

test('the inactive rules ResolutionAny and ImageLimitAny and the repost section are accepted and ignored (3.0 has no repost)', () => {
  const page = `enabled: true\nResolutionAny: {enabled: true}\nImageLimitAny: {enabled: true, limit: 3}\nRepostAny: {enabled: true, report_only: false}\n`;
  expect(legacySettings(parseYaml(page))).toEqual({ mode: 'enforce' });
});

test('a key that the legacy bot does not know is an error, so that a typo cannot switch a rule off without a word', () => {
  expect(() => legacySettings(parseYaml('enabled: true\nRateLimit:\n  enabled: true\n'))).toThrow('unknown key "RateLimit"');
  expect(() => legacySettings(parseYaml('RateLimitAny:\n  enabled: true\n  inc_deleted: true\n'))).toThrow('unknown key "RateLimitAny.inc_deleted"');
  expect(() => legacySettings(parseYaml('flairs: []\n'))).toThrow('"flairs" must be a map');
});

test('YAML that this reader does not know is an error with its line number', () => {
  expect(() => parseYaml('a: 1\n\tb: 2\n')).toThrow('line 2: a tab in the indent');
  expect(() => parseYaml('a: |\n  text\n')).toThrow('line 1: block text is not supported');
  expect(() => parseYaml('a: &x 1\n')).toThrow('line 1: anchors and aliases are not supported');
  expect(() => parseYaml('a: {b: [1, 2]}\n')).toThrow('line 1: a flow collection holds plain values only');
  expect(() => parseYaml('a: 1\na: 2\n')).toThrow('line 2: the key "a" is twice in the map');
  expect(() => parseYaml('a: 1\n b: 2\n')).toThrow('line 2: bad indent');
});
