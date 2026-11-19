import path from 'node:path';
import { defineConfig } from 'vitest/config';

const here = import.meta.dirname;
// The tests that read your own budgets are kept with them, outside the repository:
// `npm run test:real` sets MYBUDGET_REAL_TESTS to their folder. They import the app as "@app/…"
// and the test helpers as "@fixtures".
const realTests = process.env.MYBUDGET_REAL_TESTS;

export default defineConfig({
  resolve: {
    alias: {
      '@app': path.resolve(here, 'src'),
      '@electron': path.resolve(here, 'electron'),
      '@fixtures': path.resolve(here, 'tests/unit/fixtures.ts'),
    },
  },
  test: {
    include: realTests ? [path.resolve(realTests).split(path.sep).join('/') + '/**/*.test.ts'] : ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
