// Similarity calibration on the private S9 data (plan 7.4 "Similarity calibration", AC17, spike S9).
//
// It runs tools/calibrate.ts on test/fixtures/private and fails when an AC17 number is not met, or when a set is smaller than its S9
// minimum. The data is private (gitignored) and a run takes long, so vitest.config.ts leaves test/calibration/** out of the default
// run and CI. Run it on purpose, before each threshold change and before 3.1:
//
//   npx vitest run --config test/calibration/vitest.config.ts
//
// The same numbers, with the full report (per subreddit, the grid): npx tsx tools/calibrate.ts test/fixtures/private
// For OD8 = (b) (no real same-background pairs; the README says so) or a first run: CALIBRATE_ALLOW_SHORTFALL=1 excuses the sets
// that are below their S9 minimum, as `--allow-shortfall` does. A number that is not met always fails.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import type { Check, Report } from '../../tools/calibrate';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dir = join(root, 'test/fixtures/private');
const allowShortfall = process.env.CALIBRATE_ALLOW_SHORTFALL === '1';

/** Runs the tool in its own process, so that a long decode does not block the test runner. Progress goes to stderr. */
const run = (args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    const child = execFile(join(root, 'node_modules/.bin/tsx'), [join(root, 'tools/calibrate.ts'), ...args], { cwd: root, maxBuffer: 1 << 28 }, (err, stdout, stderr) =>
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }),
    );
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  });

const describeCheck = (c: Check) => `${c.name}: ${c.value ?? 'no data'} (needs ${c.rule}${c.detail ? `; ${c.detail}` : ''})`;

test('AC17: the similarity numbers and the set sizes on the private S9 data', { timeout: 6 * 60 * 60 * 1000 }, async () => {
  // A missing folder is a failure and not a skip: this suite is only run on purpose.
  if (!existsSync(dir)) {
    throw new Error(
      `S9 data is missing: ${dir} does not exist. Run tools/capture_fixtures.py (it writes legacy-repost-labels-<sub>.json there), ` +
        `put the image files in ${join(dir, 'images')}, and add calibration-pairs.jsonl for the OD8, random and desktop/phone pairs. ` +
        'Run "npx tsx tools/calibrate.ts --help" for the formats.',
    );
  }
  const r = await run([dir, '--json', ...(allowShortfall ? ['--allow-shortfall'] : [])]);
  if (r.code === 2 || r.stdout === '') throw new Error(`tools/calibrate.ts could not read ${dir} (exit code ${r.code}): ${r.stderr.trim().split('\n').pop()}`);

  const report: Report = JSON.parse(r.stdout);
  const unmet = report.checks.filter((c) => c.status === 'fail' || (c.status === 'short' && !allowShortfall));
  expect(unmet.map(describeCheck), 'AC17 numbers and S9 set sizes that are not met (npx tsx tools/calibrate.ts prints the full report)').toEqual([]);
  expect(r.code, 'the tool agrees with the checks').toBe(0);
});
