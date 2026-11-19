import path from 'node:path';
import { defineConfig } from 'vitest/config';

const here = import.meta.dirname;
// Tests kept outside the repository (e.g. ones that read your own budgets): `npm run test:private`
// sets MYBUDGET_PRIVATE_TESTS to their folder. They import the app as "@app/…" and the test
// helpers as "@fixtures".
const privateTests = process.env.MYBUDGET_PRIVATE_TESTS;

export default defineConfig({
  resolve: {
    alias: {
      '@app': path.resolve(here, 'src'),
      '@electron': path.resolve(here, 'electron'),
      '@fixtures': path.resolve(here, 'tests/unit/fixtures.ts'),
    },
  },
  test: {
    include: privateTests ? [path.resolve(privateTests).split(path.sep).join('/') + '/**/*.test.ts'] : ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
