import { defineConfig } from 'vitest/config';

// The calibration suite needs private data, so the main config excludes it. Run it on purpose:
//   npx vitest run --config test/calibration/vitest.config.ts
export default defineConfig({
  test: { include: ['test/calibration/**/*.test.ts'] },
});
