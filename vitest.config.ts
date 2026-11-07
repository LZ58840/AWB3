import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/calibration/**', 'node_modules/**'],
    coverage: { include: ['src/core/**'] },
  },
});
