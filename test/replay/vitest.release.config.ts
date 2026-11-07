import { defineConfig } from 'vitest/config';

// The release check needs the real corpora, which the owner makes with tools/capture_fixtures.py. The default run does not include it (its file
// is not a *.test.ts), as it does not include test/calibration. Run it on purpose, before a release:
//   npm run test:release
export default defineConfig({
  test: { include: ['test/replay/release.check.ts'] },
});
