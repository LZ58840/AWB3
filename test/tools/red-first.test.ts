// Self-test of tools/red-first.sh (plan 7.5). Each case builds a throwaway git repo with a base commit on `main`. The "pull request"
// is a set of uncommitted edits: red-first takes the working tree as head. Then the case runs the real script in that repo.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = join(root, 'tools/red-first.sh');

// GIT_* is removed: a git hook that runs `npm test` would point the child git at the real repo. VITEST*, TEST and FORCE_COLOR are
// removed so the vitest inside each case does not think it runs in a worker. NODE_V8_COVERAGE is removed so that it does not
// write into the coverage data of the outer run (CI runs this file with coverage on).
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|VITEST|TEST$|FORCE_COLOR$|NODE_V8_COVERAGE$)/.test(key))),
  NO_COLOR: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const exec = (cwd: string, cmd: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
  new Promise<{ code: number; out: string }>((done) =>
    execFile(cmd, args, { cwd, env: { ...env, ...extra }, maxBuffer: 1 << 26 }, (err, stdout, stderr) =>
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: stdout + stderr }),
    ),
  );

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) {
    rmSync(join(dir, 'node_modules'), { force: true }); // a link to the real node_modules: remove the link first, then the tree
    rmSync(dir, { recursive: true, force: true });
  }
});

const IMPORT = "import { expect, test } from 'vitest';\nimport { label } from '../src/calc';\n\n";
const CALC = "export const label = (n: number): string => (n < 0 ? 'neg' : 'pos');\n";
const CALC_ZERO = "export const label = (n: number): string => (n < 0 ? 'neg' : n === 0 ? 'zero' : 'pos');\n";
const t = (name: string, body: string) => `test('${name}', () => {\n  ${body}\n});\n`;
const NEGATIVE = t('negative', "expect(label(-1)).toBe('neg');");
const ZERO = t('zero', "expect(label(0)).toBe('zero');"); // new behavior: red on base
const POSITIVE = t('positive', "expect(label(1)).toBe('pos');"); // old behavior: green on base
const importing = (name: string, from: string, actual = name, expected = '1') =>
  `import { expect, test } from 'vitest';\nimport { ${name} } from '${from}';\n\n${t(name, `expect(${actual}).toBe(${expected});`)}`;

/** A repo with the base commit on `main`; `head` files are then written over it, uncommitted. */
async function pullRequest(head: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'red-first-'));
  dirs.push(dir);
  const put = (files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
  };
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  put({ '.gitignore': 'node_modules\n', 'package.json': '{"type":"module"}\n', 'src/calc.ts': CALC, 'test/calc.test.ts': IMPORT + NEGATIVE });
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-qm', 'base']]) {
    const r = await exec(dir, 'git', args);
    expect(r.code, r.out).toBe(0);
  }
  put(head);
  return { dir, run: (extra: NodeJS.ProcessEnv = {}, base = 'main') => exec(dir, 'bash', [script, '--base', base], extra) };
}

const slow = { timeout: 120_000 };

test.concurrent('(a) a new test that fails on base by assertion is accepted', slow, async () => {
  const { dir, run } = await pullRequest({ 'src/calc.ts': CALC_ZERO, 'test/calc.test.ts': IMPORT + NEGATIVE + ZERO });
  const r = await run();
  expect(r.code, r.out).toBe(0);
  expect(r.out).toMatch(/ok .*test\/calc\.test\.ts > zero/);
  expect(r.out).not.toMatch(/negative/); // an old test is not new
  const worktrees = (await exec(dir, 'git', ['worktree', 'list', '--porcelain'])).out;
  expect((worktrees.match(/^worktree /gm) ?? []).length, worktrees).toBe(1); // the temporary worktree is gone
});

test.concurrent('(b) a new test that passes on base fails the job and is listed; a red one next to it is not', slow, async () => {
  const { run } = await pullRequest({ 'src/calc.ts': CALC_ZERO, 'test/calc.test.ts': IMPORT + NEGATIVE + ZERO + POSITIVE });
  const r = await run();
  expect(r.code, r.out).toBe(1);
  expect(r.out).toMatch(/FAIL .*test\/calc\.test\.ts > positive: passes on base/);
  expect(r.out).not.toMatch(/FAIL .*> zero/);
});

test.concurrent('(c) a new test whose import of a new src module fails on base is accepted', slow, async () => {
  const { run } = await pullRequest({ 'src/extra.ts': 'export const extra = 1;\n', 'test/extra.test.ts': importing('extra', '../src/extra') });
  const r = await run();
  expect(r.code, r.out).toBe(0);
  expect(r.out).toMatch(/ok .*test\/extra\.test\.ts > extra/);
});

test.concurrent('(d) a test file with a syntax error fails the job', slow, async () => {
  const { run } = await pullRequest({ 'test/broken.test.ts': "import { test } from 'vitest';\ntest('broken', () => {\n  expect(1 +).toBe(1);\n});\n" });
  const r = await run();
  expect(r.code, r.out).toBe(1);
  expect(r.out).toMatch(/test\/broken\.test\.ts/);
});

test.concurrent('(d2) a test that imports a new file outside src/ (not copied to base) fails the job', slow, async () => {
  const { run } = await pullRequest({ 'tools/helper.ts': 'export const helper = 1;\n', 'test/helper.test.ts': importing('helper', '../tools/helper') });
  const r = await run();
  expect(r.code, r.out).toBe(1);
  expect(r.out).toMatch(/FAIL .*test\/helper\.test\.ts > helper: .*tools\/helper/);
});

test.concurrent('(e) a new fast-check property that fails on base is accepted', slow, async () => {
  const property = t('zero for every input', "fc.assert(fc.property(fc.constant(0), (n) => expect(label(n)).toBe('zero')));");
  const { run } = await pullRequest({ 'src/calc.ts': CALC_ZERO, 'test/prop.test.ts': `import fc from 'fast-check';\n${IMPORT}${property}` });
  const r = await run();
  expect(r.code, r.out).toBe(0);
  expect(r.out).toMatch(/ok .*test\/prop\.test\.ts > zero for every input/);
});

test.concurrent('(f) a new test that fails on base with a TypeError (missing export of an existing module) fails the job', slow, async () => {
  const calc = `${CALC}export const twice = (n: number): number => n * 2;\n`;
  const { run } = await pullRequest({ 'src/calc.ts': calc, 'test/twice.test.ts': importing('twice', '../src/calc', 'twice(2)', '4') });
  const r = await run();
  expect(r.code, r.out).toBe(1);
  expect(r.out).toMatch(/FAIL .*test\/twice\.test\.ts > twice: /);
});

test.concurrent('(g) RED_FIRST_SKIP=1 skips the check (label no-behavior)', slow, async () => {
  const { run } = await pullRequest({ 'test/calc.test.ts': IMPORT + NEGATIVE + POSITIVE }); // would fail without the skip
  const r = await run({ RED_FIRST_SKIP: '1' }, 'no-such-ref');
  expect(r.code, r.out).toBe(0);
  expect(r.out).toMatch(/skipped/);
});

test.concurrent('(h) a pull request with no new test passes with a notice', slow, async () => {
  const { run } = await pullRequest({ 'src/calc.ts': CALC_ZERO });
  const r = await run();
  expect(r.code, r.out).toBe(0);
  expect(r.out).toMatch(/no new tests/);
});

test.concurrent('(i) an unknown base ref is an error', slow, async () => {
  const { run } = await pullRequest({});
  const r = await run({}, 'no-such-ref');
  expect(r.code, r.out).toBe(2);
  expect(r.out).toMatch(/unknown ref/);
});
