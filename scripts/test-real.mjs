// Runs the tests that read your own budgets. They're kept with the budgets, outside the
// repository: ../Budgets/Tests next to this Source folder, or wherever MYBUDGET_REAL_TESTS points.
// They import the app as "@app/…" and the test helpers as "@fixtures" (see vitest.config.ts).
// Nothing to run is not an error.
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const dir = path.resolve(process.env.MYBUDGET_REAL_TESTS ?? path.join(import.meta.dirname, '..', '..', 'Budgets', 'Tests'));
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(dir, f)) : [];
if (!files.length) {
  console.log(`No real-budget tests in ${dir}.`);
  process.exit(0);
}
const r = spawnSync(process.execPath, [path.join('node_modules', 'vitest', 'vitest.mjs'), 'run', '--maxWorkers=2', ...files], {
  stdio: 'inherit',
  env: { ...process.env, MYBUDGET_REAL_TESTS: dir },
});
process.exit(r.status ?? 1);
