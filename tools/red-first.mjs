// Decision step of tools/red-first.sh (plan 7.5). Reads three vitest JSON reports; run it through the shell script.
//   node red-first.mjs <head dir> <base dir> <head names.json> <base names.json> <cross run.json> <base ref>
// head names:  the tests of the head, collected without running them (vitest -t '(?!)')
// base names:  the tests of the base with its own test/ (same way)
// cross run:   the tests of the head, run on the base's src/
// A test is NEW when its file and full name are in the head but not in the base. Each new test must fail in the cross run, and the
// failure must be an assertion error, or a missing module that the head adds under src/. Exit 0: all new tests are red. 1: they are not.
// 2: this script failed.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

process.on('uncaughtException', (error) => {
  console.error(`red-first: ${error.stack ?? error}`);
  process.exit(2);
});

const [headArg, baseArg, headReport, baseReport, crossReport, baseRef] = process.argv.slice(2);
const headDir = realpathSync(headArg);
const baseDir = realpathSync(baseArg);

const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, ''); // the transform errors of vite carry colors
const brief = (text) => {
  const lines = plain(text).split('\n').map((line) => line.trim()).filter(Boolean);
  return (lines[0]?.endsWith(':') ? `${lines[0]} ${lines[1] ?? ''}` : (lines[0] ?? '')).slice(0, 200);
};
const key = (file, test) => `${file} > ${[...test.ancestorTitles, test.title].join(' > ')}`;
const load = (report, dir) =>
  JSON.parse(readFileSync(report, 'utf8')).testResults.map((f) => ({ file: relative(dir, f.name), failed: f.status === 'failed', message: f.message, tests: f.assertionResults }));
const srcFiles = (dir) =>
  existsSync(join(dir, 'src'))
    ? readdirSync(join(dir, 'src'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)))
    : [];
const stem = (path) => path.replace(/(\/index)?\.[cm]?[jt]sx?$/, ''); // './x', './x.js' and './dir' all find src/x.ts and src/dir/index.ts

const head = load(headReport, headDir);
const unloaded = head.filter((f) => f.failed && f.tests.length === 0);
if (unloaded.length > 0) {
  console.error('red-first: FAILED, a test file of this checkout does not load, so its tests cannot be checked:');
  for (const f of unloaded) console.error(`  ${f.file}: ${brief(f.message)}`);
  process.exit(1);
}

const baseNames = new Set(load(baseReport, baseDir).flatMap((f) => f.tests.map((t) => key(f.file, t))));
const added = head.flatMap((f) => f.tests.map((t) => ({ file: f.file, name: key(f.file, t) }))).filter((t) => !baseNames.has(t.name));
if (added.length === 0) {
  console.log(`red-first: no new tests against ${baseRef}, nothing to check. A pull request with a behavior change adds a test; one without is labeled no-behavior.`);
  process.exit(0);
}

const baseSrc = new Set(srcFiles(baseDir));
const addedStems = new Set(srcFiles(headDir).filter((f) => !baseSrc.has(f)).map(stem)); // the head adds these; the base lacks them

const ASSERTION = /^(AssertionError|Error: Property failed after \d+ tests?)\b/; // fast-check keeps the original error in `cause`, not in the text
const MISSING = /Cannot find module '([^']+)' imported from ([^\n]+)/; // a module; "Cannot find package" is a dependency and does not match

/** Is this error text a valid red? */
function judge(error) {
  const text = plain(error);
  if (ASSERTION.test(text)) return { ok: true, why: 'assertion error' };
  const missing = MISSING.exec(text);
  if (!missing) return { ok: false, why: `fails with ${brief(text)}, not an assertion error` };
  const [, spec, importer] = missing; // a static import names the specifier as written; a dynamic import names it from the root
  const target = spec.startsWith('.') ? resolve(dirname(importer), spec) : spec.startsWith(baseDir) ? spec : spec.startsWith('/') ? join(baseDir, spec) : null;
  const rel = target && relative(baseDir, target);
  return rel !== null && addedStems.has(stem(rel))
    ? { ok: true, why: `imports the new module ${rel}` }
    : { ok: false, why: `imports ${spec}, which this pull request does not add under src/` };
}

const cross = new Map(load(crossReport, baseDir).map((f) => [f.file, f]));
function check({ file, name }) {
  const f = cross.get(file);
  const runs = f ? f.tests.filter((t) => key(file, t) === name) : [];
  if (runs.length === 0) return f?.failed && f.tests.length === 0 ? judge(f.message) : { ok: false, why: 'did not run on base (its name differs there)' };
  let verdict;
  for (const run of runs) {
    if (run.status === 'passed') return { ok: false, why: 'passes on base' };
    if (run.status !== 'failed') return { ok: false, why: `is ${run.status} on base, not failing` };
    verdict = judge(run.failureMessages[0] ?? '');
    if (!verdict.ok) return verdict;
  }
  return verdict;
}

const rows = added.map((t) => ({ ...t, ...check(t) }));
console.log(`red-first: ${rows.length} new test(s) against ${baseRef}`);
for (const r of rows.filter((r) => r.ok)) console.log(`  ok    ${r.name}  (${r.why})`);
const bad = rows.filter((r) => !r.ok);
if (bad.length === 0) {
  console.log('red-first: OK, each new test fails on the base for the right reason');
  process.exit(0);
}
console.error(`red-first: FAILED, ${bad.length} of ${rows.length} new test(s) are not red on ${baseRef}:`);
for (const r of bad) console.error(`  FAIL  ${r.name}: ${r.why}`);
console.error('red-first: a new test must fail on the base by an assertion, or by importing a module that this pull request adds under src/.');
console.error('red-first: a pull request with no behavior change gets the label no-behavior and skips this check.');
process.exit(1);
