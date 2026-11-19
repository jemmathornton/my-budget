// Runs tests kept outside the repository (for example ones that read your own budgets), from
// MYBUDGET_PRIVATE_TESTS or ../MyBudget-private/tests. They import the app as "@app/…" and the
// test helpers as "@fixtures" (see vitest.config.ts). Nothing to run is not an error.
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const dir = path.resolve(process.env.MYBUDGET_PRIVATE_TESTS ?? path.join(import.meta.dirname, '..', '..', 'MyBudget-private', 'tests'));
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(dir, f)) : [];
if (!files.length) {
  console.log(`No private tests in ${dir}.`);
  process.exit(0);
}
const r = spawnSync(process.execPath, [path.join('node_modules', 'vitest', 'vitest.mjs'), 'run', '--maxWorkers=2', ...files], {
  stdio: 'inherit',
  env: { ...process.env, MYBUDGET_PRIVATE_TESTS: dir },
});
process.exit(r.status ?? 1);
