import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { newBudget, serializeBudget } from '../../src/model/budget';
import { addDays, addMonths, formatDate, monthLabel, thisMonth, today } from '../../src/model/dates';
import { addAccount, ensurePayee, saveScheduled, saveTransaction, setBudgeted, setCategoryHidden } from '../../src/model/ops';
import type { Budget } from '../../src/model/types';

// Drives the real app on synthetic budgets in a temporary folder. Nothing here touches
// the user's own budgets, settings or backups.

interface Fixture {
  dir: string;
  file: string;
  budget: Budget;
  ids: { current: string; savings: string; card: string; pension: string; groceries: string; rent: string };
}

// Each test's temporary folder (a made-up budget, its settings and backups), removed afterwards.
const fixtureDirs: string[] = [];
test.afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) {
    try {
      // Retries for a few seconds: the app can still be letting go of its files as it closes.
      rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
    } catch {
      // A test that failed may have left the app holding a file; the next run's clean-up is not affected.
    }
  }
});

function makeFixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'mybudget-e2e-'));
  fixtureDirs.push(dir);
  const b = newBudget('Test Budget', true);
  const d = `${thisMonth()}-01`;
  const current = addAccount(b, { name: 'Current Account', type: 'Checking', onBudget: true }, 100_000, d);
  const savings = addAccount(b, { name: 'Savings', type: 'Savings', onBudget: true }, 50_000, d);
  const card = addAccount(b, { name: 'Credit Card', type: 'CreditCard', onBudget: true }, -20_000, d);
  const pension = addAccount(b, { name: 'Pension', type: 'InvestmentAccount', onBudget: false }, 1_000_000, d);
  const cat = (name: string) => Object.values(b.categories).find((c) => c.name === name)!.id;
  const groceries = cat('Groceries');
  const rent = cat('Rent/Mortgage');
  setBudgeted(b, thisMonth(), rent, 60_000);
  const file = path.join(dir, 'Test Budget.budget');
  writeFileSync(file, serializeBudget(b));
  return { dir, file, budget: b, ids: { current, savings, card, pension, groceries, rent } };
}

async function launch(fx: Fixture, dialogs: Record<string, unknown> = {}): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: ['.', fx.file],
    env: {
      ...process.env,
      MYBUDGET_USER_DATA: path.join(fx.dir, 'userdata'),
      MYBUDGET_TEST_DIALOGS: JSON.stringify(dialogs),
      // Off-screen, so the run doesn't keep popping the app up (set MYBUDGET_TEST_SHOW=1 to watch).
      MYBUDGET_TEST_OFFSCREEN: process.env.MYBUDGET_TEST_SHOW ? '' : '1',
    },
  });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.unmaximize();
    w.setContentSize(1600, 952);
  });
  await win.waitForSelector('.bgrid');
  return { app, win };
}

async function savedBudget(fx: Fixture, win: Page): Promise<Budget> {
  await expect(win.locator('.tb-save')).toHaveText(/Saved/, { timeout: 10_000 });
  return JSON.parse(readFileSync(fx.file, 'utf8'));
}

test('shows three months side by side with no sideways scrolling at 1600px', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  await expect(win.locator('.msum')).toHaveCount(3);
  // Measured once the layout has settled after the window was resized.
  await expect
    .poll(() => win.locator('.budget-scroll').evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBeLessThanOrEqual(0);
  // Available to Budget: 1,000 + 500 income, 600 budgeted.
  await expect(win.locator('.msum').first().locator('.atb-amt')).toHaveText('= £900.00');
  await app.close();
});

test('budgets with maths, undoes and redoes, and saves to the file', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  const row = win.locator(`.brow:has([data-cat="${fx.ids.groceries}"])`);
  await row.locator('.cell.budgeted').first().click();
  await win.keyboard.type('120/4');
  await win.keyboard.press('Enter');
  await expect(row.locator('.cell.budgeted').first()).toHaveText('£30.00');
  await expect(win.locator('.msum').first().locator('.atb-amt')).toHaveText('= £870.00');
  await win.locator('.budget-scroll').click({ position: { x: 5, y: 5 } });
  await win.keyboard.press('Control+z');
  await expect(row.locator('.cell.budgeted').first()).toHaveText('£0.00');
  await win.keyboard.press('Control+y');
  await expect(row.locator('.cell.budgeted').first()).toHaveText('£30.00');
  const saved = await savedBudget(fx, win);
  expect(saved.months[thisMonth()][fx.ids.groceries].budgeted).toBe(3000);
  await app.close();
});

test('adds a transaction, a transfer and a split in the register', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await expect(win.locator('.reg-title h1')).toContainText('Current Account');

  // A normal transaction.
  await win.getByRole('button', { name: 'Add a new transaction' }).click();
  await win.getByLabel('Payee').fill('Corner Shop');
  await win.keyboard.press('Tab');
  await win.getByLabel('Category').fill('Groc');
  await win.keyboard.press('Enter');
  await win.getByLabel('Outflow').fill('12.34');
  await win.getByLabel('Outflow').press('Enter');
  await expect(win.locator('.rrow', { hasText: 'Corner Shop' })).toContainText('Everyday Expenses: Groceries');
  await expect(win.locator('.rb.working')).toContainText('£987.66');

  // A transfer to Savings creates the other side.
  await win.getByRole('button', { name: 'Add a new transaction' }).click();
  await win.getByLabel('Payee').fill('Transfer : Sav');
  await win.keyboard.press('Enter');
  await win.getByLabel('Outflow').fill('100');
  await win.getByLabel('Outflow').press('Enter');
  await expect(win.locator('.rrow', { hasText: 'Transfer : Savings' })).toBeVisible();

  // A split.
  await win.getByRole('button', { name: 'Add a new transaction' }).click();
  await win.getByLabel('Payee').fill('Supermarket');
  await win.keyboard.press('Tab');
  await win.getByLabel('Outflow').fill('50');
  await win.getByLabel('Outflow').press('Tab');
  await win.getByLabel('Category').fill('Split');
  await win.keyboard.press('Enter');
  await win.getByLabel('Split 1 category').fill('Groc');
  await win.keyboard.press('Enter');
  await win.getByLabel('Split 1 outflow').fill('30');
  await win.getByLabel('Split 1 outflow').press('Tab');
  await win.getByLabel('Split 2 category').fill('Household');
  await win.keyboard.press('Enter');
  await win.getByLabel('Split 2 outflow').fill('20');
  await win.getByLabel('Split 2 outflow').press('Tab');
  await expect(win.locator('.remaining')).toHaveText('Fully assigned');
  await win.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(win.locator('.rrow', { hasText: 'Supermarket' })).toContainText('Split (2 categories)');

  // Oldest first, newest at the bottom (YNAB4's order): the starting balance is the first row.
  await expect(win.locator('.rrow').first()).toContainText('Starting Balance');
  await expect(win.locator('.rrow:not(.splitline)').last()).toContainText('Supermarket');

  await win.locator('.sidebar .acc-row', { hasText: 'Savings' }).click();
  await expect(win.locator('.rrow', { hasText: 'Transfer : Current Account' })).toContainText('£100.00');

  const saved = await savedBudget(fx, win);
  const txs = Object.values(saved.transactions);
  const transfer = txs.find((t) => t.accountId === fx.ids.current && t.transferAccountId === fx.ids.savings)!;
  expect(transfer.amount).toBe(-10000);
  expect(saved.transactions[transfer.transferTxId!].amount).toBe(10000);
  const split = txs.find((t) => t.splits?.length === 2)!;
  expect(split.splits!.map((s) => s.amount).sort((a, b) => a - b)).toEqual([-3000, -2000]);
  await app.close();
});

test('reconciles an account', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Reconcile' }).click();
  await win.getByRole('button', { name: 'No' }).click();
  await win.getByLabel('Statement balance').fill('990');
  await win.getByLabel('Statement balance').press('Tab');
  await win.getByRole('button', { name: /Add -£10.00 adjustment/ }).click();
  await expect(win.locator('.rrow', { hasText: 'Reconciliation Balance Adjustment' })).toBeVisible();
  await expect(win.locator('.rb').first()).toContainText('£990.00');
  const saved = await savedBudget(fx, win);
  expect(saved.accounts[fx.ids.current].lastReconciledBalance).toBe(99000);
  await app.close();
});

test('imports a QIF file, matching a typed-in transaction and skipping duplicates', async () => {
  const fx = makeFixture();
  const d = today();
  const [y, m, dd] = d.split('-');
  const qif = path.join(fx.dir, 'statement.qif');
  writeFileSync(
    qif,
    ['!Type:Bank', `D${dd}/${m}/${y}`, 'T-25.00', 'PCOFFEE SHOP LONDON', '^', `D${dd}/${m}/${y}`, 'T-9.99', 'PNETFLIX.COM', '^', ''].join('\r\n'),
  );
  // A coffee typed in by hand two days earlier should be matched, not duplicated.
  saveTransaction(fx.budget, {
    accountId: fx.ids.current,
    date: addDays(d, -2),
    payeeName: 'Coffee',
    categoryId: fx.ids.groceries,
    amount: -2500,
    cleared: 'U',
  });
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const { app, win } = await launch(fx, { bank: [qif] });
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(win.locator('.modal')).toContainText('1 new');
  await expect(win.locator('.modal')).toContainText('1 matched');
  await win.getByRole('button', { name: /^Import 1 new, match 1/ }).click();
  await expect(win.locator('.rrow', { hasText: 'NETFLIX.COM' })).toBeVisible();
  // The match waits for approval, shown as YNAB4 did: the bank's row and yours.
  await expect(win.locator('.rrow.unapproved')).toHaveCount(2);
  await expect(win.locator('.rrow.matchline.bank')).toContainText('Bank: COFFEE SHOP LONDON');
  await expect(win.locator('.rrow.matchline.yours')).toContainText('Yours: Coffee');
  // YNAB4's notice: "1 needs a category", which shows just that one.
  await win.getByRole('button', { name: '1 needs a category' }).click();
  await expect(win.locator('.rrow')).toHaveCount(1);
  await expect(win.locator('.rrow')).toContainText('NETFLIX.COM');
  await win.getByLabel('Clear filter').click();
  const saved = await savedBudget(fx, win);
  const coffee = Object.values(saved.transactions).find((t) => t.importedPayee === 'COFFEE SHOP LONDON')!;
  expect(coffee.date).toBe(d);
  expect(coffee.cleared).toBe('C');
  expect(saved.payees[coffee.payeeId!].name).toBe('Coffee');
  // Importing the same file again finds nothing new.
  await win.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(win.locator('.modal')).toContainText('2 already imported');
  await win.getByRole('button', { name: 'Cancel' }).click();
  // Unmatch keeps them apart: yours goes back as it was, the bank's is added on its own.
  await win.locator('.rrow.matchline.bank').getByRole('button', { name: 'Unmatch' }).click();
  await expect(win.locator('.rrow.matchline')).toHaveCount(0);
  await expect(win.locator('.rrow.unapproved', { hasText: 'COFFEE SHOP LONDON' })).toBeVisible();
  await expect(win.locator('.rrow:not(.unapproved)', { hasText: 'Coffee' })).toContainText(formatDate(addDays(d, -2)));
  await win.keyboard.press('Control+z');
  await expect(win.locator('.rrow.matchline')).toHaveCount(2);
  await win.getByRole('button', { name: /^Approve 2/ }).click();
  await expect(win.locator('.rrow.unapproved')).toHaveCount(0);
  await expect(win.locator('.rrow.matchline')).toHaveCount(0);
  await app.close();
});

test('makes a daily backup and lists it in Settings', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  await win.locator('.sb-nav-btn', { hasText: 'Settings' }).click();
  await expect(win.locator('.settings')).toContainText('Daily backup');
  const backupDirs = readdirSync(path.join(fx.dir, 'userdata', 'backups'));
  expect(backupDirs.length).toBe(1);
  await app.close();
});

test('every screen opens without errors, in light and dark themes', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  for (const theme of ['light', 'dark']) {
    await win.locator('.tb-menu-btn', { hasText: 'View' }).click();
    await win.getByRole('menuitem', { name: theme === 'light' ? 'Light theme' : 'Dark theme' }).click();
    for (const screen of ['Reports', 'Scheduled', 'Payees', 'Settings', 'Budget']) {
      await win.locator('.sb-nav-btn', { hasText: screen }).click();
      await win.waitForTimeout(200);
    }
    await win.locator('.sb-nav-btn', { hasText: 'All accounts' }).click();
    await expect(win.locator('.reg-title h1')).toHaveText(/All accounts/);
  }
  expect(errors).toEqual([]);
  expect(existsSync(fx.file)).toBe(true);
  await app.close();
});

test('keeps notes however the box is closed', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  const popNote = win.locator('.popover textarea');
  // Month note: Esc, then clicking elsewhere.
  await win.locator('.mt-note').first().click();
  await popNote.fill('Esc note');
  await win.keyboard.press('Escape');
  await win.locator('.mt-note').first().click();
  await expect(popNote).toHaveValue('Esc note');
  await popNote.fill('Click-away note');
  await win.locator('.bcolhead.cat').click();
  await win.locator('.mt-note').first().click();
  await expect(popNote).toHaveValue('Click-away note');
  await win.keyboard.press('Escape');
  // Category notes dialog: Esc, then the backdrop.
  const openNotes = async () => {
    await win.locator(`.crow.cat[data-cat="${fx.ids.groceries}"]`).click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Notes…' }).click();
  };
  await openNotes();
  await win.locator('.modal textarea').first().fill('This month');
  await win.keyboard.press('Escape');
  await expect(win.locator('.modal')).toHaveCount(0);
  await openNotes();
  await expect(win.locator('.modal textarea').first()).toHaveValue('This month');
  await win.locator('.modal textarea').nth(1).fill('Every month');
  await win.locator('.modal-back').click({ position: { x: 5, y: 5 } });
  await expect(win.locator('.modal')).toHaveCount(0);
  const saved = await savedBudget(fx, win);
  expect(saved.monthNotes?.[thisMonth()]).toBe('Click-away note');
  expect(saved.months[thisMonth()][fx.ids.groceries].note).toBe('This month');
  expect(saved.categories[fx.ids.groceries].note).toBe('Every month');
  await app.close();
});

test('Esc works from amount boxes', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  // Add account: Esc in the balance box closes the dialog and adds nothing.
  await win.locator('.sb-add').click();
  await win.getByLabel('Current balance').fill('50');
  await win.getByLabel('Current balance').press('Escape');
  await expect(win.locator('.modal')).toHaveCount(0);
  await expect(win.locator('.sidebar .acc-row')).toHaveCount(4);
  // Reconcile: Esc in the statement box closes it.
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Reconcile' }).click();
  await win.getByRole('button', { name: 'No' }).click();
  await win.getByLabel('Statement balance').fill('12');
  await win.getByLabel('Statement balance').press('Escape');
  await expect(win.locator('.modal')).toHaveCount(0);
  // The transaction editor: Esc in Outflow cancels the edit.
  await win.locator('.rrow:not(.sched):not(.splitline)').first().dblclick();
  await win.getByLabel('Outflow').fill('999');
  await win.getByLabel('Outflow').press('Escape');
  await expect(win.locator('.tx-editor')).toHaveCount(0);
  // The budget grid: Esc cancels just the cell.
  await win.locator('.sb-nav-btn', { hasText: 'Budget' }).click();
  const cell = win.locator(`.brow:has([data-cat="${fx.ids.groceries}"]) .cell.budgeted`).first();
  await cell.click();
  await win.keyboard.type('5');
  await win.keyboard.press('Escape');
  await expect(cell).toHaveText('£0.00');
  const saved = await savedBudget(fx, win);
  expect(Object.keys(saved.accounts)).toHaveLength(4);
  expect(Object.values(saved.transactions).some((t) => t.amount === -99900)).toBe(false);
  await app.close();
});

test('opens the edit row on the transaction being edited', async () => {
  const fx = makeFixture();
  for (let i = 0; i < 60; i++) {
    saveTransaction(fx.budget, {
      accountId: fx.ids.current,
      date: addDays(today(), -60 + i),
      payeeName: `Shop ${i}`,
      categoryId: fx.ids.groceries,
      amount: -(100 + i),
      cleared: 'C',
    });
  }
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await expect(win.locator('.rrow', { hasText: 'Shop 59' })).toBeVisible();
  for (const name of ['Shop 57', 'Shop 45']) {
    const row = win.locator('.rrow', { has: win.getByText(name, { exact: true }) }).first();
    await row.scrollIntoViewIfNeeded();
    const rowBox = (await row.boundingBox())!;
    await row.dblclick();
    const editor = win.locator('.tx-editor');
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel('Payee')).toHaveValue(name);
    const edBox = (await editor.boundingBox())!;
    const scrollBox = (await win.locator('.reg-scroll').boundingBox())!;
    expect(Math.abs(edBox.y - rowBox.y)).toBeLessThanOrEqual(30);
    expect(edBox.y + edBox.height).toBeLessThanOrEqual(scrollBox.y + scrollBox.height + 1);
    await win.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
  }
  await app.close();
});

test('asks before closing or switching during a conflict, and keeps a backup', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  const cell = win.locator(`.brow:has([data-cat="${fx.ids.groceries}"]) .cell.budgeted`).first();
  await cell.click();
  await win.keyboard.type('42');
  await win.keyboard.press('Enter');
  // Another program changes the file before the autosave.
  const other = JSON.parse(readFileSync(fx.file, 'utf8')) as Budget;
  other.name = 'Changed elsewhere';
  writeFileSync(fx.file, serializeBudget(other));
  await expect(win.locator('.banner.error')).toContainText('changed by another program', { timeout: 10_000 });

  const closeWindow = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const question = win.locator('.modal', { hasText: "Your latest changes aren't saved" });
  await closeWindow();
  await expect(question).toBeVisible();
  await question.getByRole('button', { name: 'Keep the app open' }).click();
  // The old 8-second fallback would have closed the window by now.
  await win.waitForTimeout(9000);
  expect(win.isClosed()).toBe(false);

  // File > Close budget asks too.
  await win.locator('.tb-menu-btn', { hasText: 'File' }).click();
  await win.getByRole('menuitem', { name: 'Close budget' }).click();
  await expect(question).toBeVisible();
  await question.getByRole('button', { name: 'Stay in this budget' }).click();
  await expect(win.locator('.bgrid')).toBeVisible();

  const closed = app.waitForEvent('close');
  await closeWindow();
  // The click closes the window, so the click itself may report that its page has gone.
  await Promise.all([closed, question.getByRole('button', { name: 'Close anyway' }).click().catch(() => {})]);
  // The file keeps the other program's version; this window's version is in an "unsaved" backup.
  expect((JSON.parse(readFileSync(fx.file, 'utf8')) as Budget).name).toBe('Changed elsewhere');
  const root = path.join(fx.dir, 'userdata', 'backups');
  const folder = path.join(root, readdirSync(root)[0]);
  const unsaved = readdirSync(folder).filter((n) => n.startsWith('unsaved_'));
  expect(unsaved.length).toBeGreaterThanOrEqual(1);
  const kept = JSON.parse(gunzipSync(readFileSync(path.join(folder, unsaved.sort().at(-1)!))).toString()) as Budget;
  expect(kept.months[thisMonth()][fx.ids.groceries].budgeted).toBe(4200);
});

test('Keep this version keeps a backup even with many manual backups', async () => {
  const fx = makeFixture();
  const folder = path.join(fx.dir, 'userdata', 'backups', fx.budget.id);
  mkdirSync(folder, { recursive: true });
  for (let i = 1; i <= 15; i++) {
    writeFileSync(path.join(folder, `manual_2025-01-${String(i).padStart(2, '0')}_120000.budget.gz`), gzipSync('{}'));
  }
  const { app, win } = await launch(fx);
  const cell = win.locator(`.brow:has([data-cat="${fx.ids.groceries}"]) .cell.budgeted`).first();
  await cell.click();
  await win.keyboard.type('7');
  await win.keyboard.press('Enter');
  const other = JSON.parse(readFileSync(fx.file, 'utf8')) as Budget;
  other.name = 'Theirs';
  writeFileSync(fx.file, serializeBudget(other));
  await expect(win.locator('.banner.error')).toBeVisible({ timeout: 10_000 });
  await win.getByRole('button', { name: 'Keep this version' }).click();
  await expect(win.locator('.banner.error')).toHaveCount(0);
  const backups = readdirSync(folder).filter((n) => n.startsWith('before-conflict_'));
  expect(backups).toHaveLength(1);
  expect((JSON.parse(gunzipSync(readFileSync(path.join(folder, backups[0]))).toString()) as Budget).name).toBe('Theirs');
  const saved = await savedBudget(fx, win);
  expect(saved.name).toBe('Test Budget');
  expect(saved.months[thisMonth()][fx.ids.groceries].budgeted).toBe(700);
  await app.close();
});

test("the window can't read or write files the user didn't choose", async () => {
  const fx = makeFixture();
  const other = path.join(fx.dir, 'not-chosen.budget');
  writeFileSync(other, serializeBudget(newBudget('Other', false)));
  const { app, win } = await launch(fx);
  const tryIt = (code: string) =>
    win.evaluate(async (c) => {
      try {
        await new Function('api', `return (async () => { ${c} })()`)(window.api);
        return 'allowed';
      } catch {
        return 'refused';
      }
    }, code);
  expect(await tryIt(`await api.readBudget(${JSON.stringify(other)})`)).toBe('refused');
  expect(await tryIt(`await api.writeBudget(${JSON.stringify(path.join(fx.dir, 'evil.budget'))}, '{}', null)`)).toBe('refused');
  expect(await tryIt(`await api.writeBudget(${JSON.stringify(path.join(fx.dir, 'evil.txt'))}, '{}', null)`)).toBe('refused');
  expect(await tryIt(`await api.listYnab4Files(${JSON.stringify(fx.dir)})`)).toBe('refused');
  expect(await win.evaluate((p) => window.api.statBudget(p), other)).toBeNull();
  // The budget it was opened with is fine.
  expect(await tryIt(`await api.readBudget(${JSON.stringify(fx.file)})`)).toBe('allowed');
  expect(existsSync(path.join(fx.dir, 'evil.budget'))).toBe(false);
  await app.close();
});

test('small fixes: payee order, empty outflows, quick budget heading, selection bar', async () => {
  const fx = makeFixture();
  for (const name of ['Bank credit BRITISH TELECOM', 'Tesco']) {
    saveTransaction(fx.budget, { accountId: fx.ids.current, date: addDays(today(), -70), payeeName: name, categoryId: fx.ids.rent, amount: -100, cleared: 'C' });
  }
  for (let i = 0; i < 40; i++) {
    saveTransaction(fx.budget, { accountId: fx.ids.current, date: addDays(today(), -40 + i), payeeName: `Shop ${i}`, categoryId: fx.ids.rent, amount: -(100 + i), cleared: 'C' });
  }
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const { app, win } = await launch(fx);
  // A £0.00 outflow isn't a button (it would open an empty list).
  const groceries = win.locator(`.brow:has([data-cat="${fx.ids.groceries}"])`);
  await expect(groceries.locator('.cell.outflows').first()).toHaveText('£0.00');
  await expect(groceries.locator('.cell.outflows button')).toHaveCount(0);
  // The right-click menu says which category it will quick-budget.
  await win.locator(`.crow.cat[data-cat="${fx.ids.groceries}"]`).click({ button: 'right' });
  await expect(win.locator('.menu')).toContainText('Quick budget: Groceries,');
  await win.keyboard.press('Escape');
  // Payees that start with what's typed come first.
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Add a new transaction' }).click();
  await win.getByLabel('Payee').fill('te');
  await expect(win.locator('.ac-item').first()).toHaveText('Tesco');
  await win.getByRole('button', { name: 'Cancel' }).click();
  // Selecting the newest rows: the selection bar doesn't hide them.
  const rows = win.locator('.rrow:not(.sched):not(.splitline)');
  await rows.last().click();
  await rows.nth((await rows.count()) - 2).click({ modifiers: ['Shift'] });
  const bar = win.locator('.bulk-bar');
  await expect(bar).toBeVisible();
  await expect
    .poll(async () => (await rows.last().boundingBox())!.y + 26 <= (await bar.boundingBox())!.y)
    .toBe(true);
  // A new scheduled transaction starts as Monthly.
  await win.keyboard.press('Escape');
  await win.locator('.sb-nav-btn', { hasText: 'Scheduled' }).click();
  await win.getByRole('button', { name: /Add scheduled/ }).click();
  await expect(win.locator('.modal').getByLabel('Repeat')).toHaveValue('Monthly');
  await app.close();
});

test('opens and moves through the menus from the keyboard', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  const menu = win.locator('.popover .menu');
  // Alt on its own opens File, with the first item focused; the arrows move.
  await win.keyboard.press('Alt');
  await expect(menu).toBeVisible();
  await expect(win.locator('.tb-menu-btn.open')).toHaveText('File');
  const focused = () => win.evaluate(() => document.activeElement?.textContent ?? '');
  const first = await focused();
  await win.keyboard.press('ArrowDown');
  expect(await focused()).not.toBe(first);
  await win.keyboard.press('ArrowRight');
  await expect(win.locator('.tb-menu-btn.open')).toHaveText('Edit');
  await win.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  // Alt+V opens View, and Enter chooses an item.
  await win.keyboard.press('Alt+v');
  await expect(win.locator('.tb-menu-btn.open')).toHaveText('View');
  await win.keyboard.press('Escape');
  await win.keyboard.press('F10');
  await expect(win.locator('.tb-menu-btn.open')).toHaveText('File');
  await win.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  // YNAB4's screen keys.
  await win.keyboard.press('Control+r');
  await expect(win.locator('.sb-nav-btn.active, .sb-nav-btn[aria-current="page"]', { hasText: 'Reports' })).toHaveCount(1);
  await win.keyboard.press('Control+t');
  await expect(win.locator('.reg-title h1')).toHaveText(/All accounts/);
  await win.keyboard.press('Control+b');
  await expect(win.locator('.bgrid')).toBeVisible();
  // YNAB4's date keys in a new transaction's date box.
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Add a new transaction' }).click();
  const date = win.locator('.tx-editor').getByLabel('Date');
  await date.focus();
  await win.keyboard.press('m');
  await expect(date).toHaveValue(/^01\//);
  await win.keyboard.press('Shift+Y');
  await expect(date).toHaveValue(/^31\/12\//);
  await win.keyboard.press('t');
  const [y, mo, d] = today().split('-');
  await expect(date).toHaveValue(`${d}/${mo}/${y}`);
  await app.close();
});

test('copies daily backups to another folder when one is chosen', async () => {
  const fx = makeFixture();
  const usb = path.join(fx.dir, 'usb');
  mkdirSync(usb);
  const { app, win } = await launch(fx, { backupCopy: usb });
  await win.locator('.sb-nav-btn', { hasText: 'Settings' }).click();
  await expect(win.locator('.settings')).toContainText('Not set up');
  await win.getByRole('button', { name: 'Choose a folder…' }).click();
  await expect(win.locator('.settings')).toContainText('Copying to');
  await expect(win.locator('.settings')).toContainText('last copied');
  const copies = path.join(usb, 'MyBudgetBackups');
  const folder = readdirSync(copies)[0];
  expect(folder).toMatch(/^Test Budget \(/);
  expect(readdirSync(path.join(copies, folder)).some((n) => n.startsWith('daily_'))).toBe(true);
  await win.getByRole('button', { name: 'Stop copying' }).click();
  await expect(win.locator('.settings')).toContainText('Not set up');
  await app.close();
});

test('restores a damaged budget from a backup, as a new file', async () => {
  const fx = makeFixture();
  // A backup from earlier, then the file gets damaged.
  const folder = path.join(fx.dir, 'userdata', 'backups', fx.budget.id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'budget-name.txt'), 'Test Budget');
  writeFileSync(path.join(folder, 'daily_2026-10-01.budget.gz'), gzipSync(serializeBudget(fx.budget)));
  writeFileSync(fx.file, '{"format": "ynab-clone", "half a file');
  const restored = path.join(fx.dir, 'Restored.budget');
  const app = await electron.launch({
    args: ['.', fx.file],
    env: {
      ...process.env,
      MYBUDGET_USER_DATA: path.join(fx.dir, 'userdata'),
      MYBUDGET_TEST_DIALOGS: JSON.stringify({ save: restored }),
      MYBUDGET_TEST_OFFSCREEN: process.env.MYBUDGET_TEST_SHOW ? '' : '1',
    },
  });
  const win = await app.firstWindow();
  const failed = win.locator('.modal', { hasText: 'Could not open the budget' });
  await expect(failed).toBeVisible({ timeout: 15_000 });
  await failed.getByRole('button', { name: 'Restore from a backup…' }).click();
  const dialog = win.locator('.modal', { hasText: 'Restore a budget from a backup' });
  await expect(dialog).toContainText('Test Budget');
  await expect(dialog).toContainText('Daily backup');
  await dialog.getByRole('button', { name: 'Save as a new budget file…' }).click();
  await win.waitForSelector('.bgrid');
  await expect(win.locator('.tb-save')).toHaveText(/Saved/, { timeout: 10_000 });
  const saved = JSON.parse(readFileSync(restored, 'utf8')) as Budget;
  expect(Object.keys(saved.accounts)).toHaveLength(4);
  expect(saved.months[thisMonth()][fx.ids.rent].budgeted).toBe(60_000);
  // The damaged file is left as it was.
  expect(readFileSync(fx.file, 'utf8')).toBe('{"format": "ynab-clone", "half a file');
  await app.close();
});

/** A QIF file with one transaction per [payee, amount], all dated today. */
function writeQif(fx: Fixture, name: string, type: string, rows: [string, string][]): string {
  const [y, m, d] = today().split('-');
  const file = path.join(fx.dir, name);
  const lines = [`!Type:${type}`];
  for (const [payee, amount] of rows) lines.push(`D${d}/${m}/${y}`, `T${amount}`, `P${payee}`, '^');
  writeFileSync(file, lines.join('\r\n') + '\r\n');
  return file;
}

test("doesn't bring back a deleted import", async () => {
  const fx = makeFixture();
  const qif = writeQif(fx, 'statement.qif', 'Bank', [['TAKEAWAY', '-18.50']]);
  const { app, win } = await launch(fx, { bank: [qif] });
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Import', exact: true }).click();
  await win.getByRole('button', { name: /^Import 1 new/ }).click();
  // A backup was made before importing.
  const backups = path.join(fx.dir, 'userdata', 'backups', fx.budget.id);
  await expect.poll(() => readdirSync(backups).filter((n) => n.startsWith('before-import_')).length).toBe(1);
  const row = win.locator('.rrow', { hasText: 'TAKEAWAY' });
  await row.click();
  await win.keyboard.press('Delete');
  await expect(row).toHaveCount(0);
  // Importing the same file again leaves it out, unticked.
  await win.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(win.locator('.modal')).toContainText('1 previously deleted');
  await expect(win.locator('.modal').getByLabel('Include')).not.toBeChecked();
  await expect(win.getByRole('button', { name: /^Import 0 new/ })).toBeVisible();
  // Ticking it brings it back, and it is forgotten as deleted.
  await win.locator('.modal').getByLabel('Include').check();
  await win.getByRole('button', { name: /^Import 1 new/ }).click();
  await expect(row).toHaveCount(1);
  const saved = await savedBudget(fx, win);
  expect(saved.accounts[fx.ids.current].deletedImports).toBeUndefined();
  await app.close();
});

test('reverses a card file that shows spending as money in, and remembers it', async () => {
  const fx = makeFixture();
  const qif = writeQif(fx, 'card.qif', 'CCard', [
    ['SHOP ONE', '10.00'],
    ['SHOP TWO', '20.00'],
    ['CAFE', '3.50'],
    ['BOOKS', '7.25'],
    ['FUEL', '40.00'],
  ]);
  const { app, win } = await launch(fx, { bank: [qif] });
  await win.locator('.sidebar .acc-row', { hasText: 'Credit Card' }).click();
  await win.getByRole('button', { name: 'Import', exact: true }).click();
  const modal = win.locator('.modal');
  await expect(modal).toContainText('wrong way round');
  await modal.getByRole('button', { name: 'Reverse the amounts' }).click();
  await expect(modal.getByLabel('Amounts in this file are the wrong way round', { exact: false })).toBeChecked();
  await expect(modal.locator('tbody tr').first()).toContainText('-£10.00');
  await win.getByRole('button', { name: /^Import 5 new/ }).click();
  await expect(win.locator('.rrow', { hasText: 'FUEL' })).toContainText('£40.00');
  // Next time it's already reversed, and the same rows are recognised as imported.
  await win.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(modal.getByLabel('Amounts in this file are the wrong way round', { exact: false })).toBeChecked();
  await expect(modal).toContainText('5 already imported');
  await win.getByRole('button', { name: 'Cancel' }).click();
  const saved = await savedBudget(fx, win);
  const card = Object.values(saved.transactions).filter((t) => t.accountId === fx.ids.card && t.importIds?.length);
  expect(card.map((t) => t.amount).sort((a, b) => a - b)).toEqual([-4000, -2000, -1000, -725, -350]);
  expect(saved.accounts[fx.ids.card].importReverse).toEqual({ qif: true });
  await app.close();
});

test('asks for the columns again when a bank changes its CSV layout', async () => {
  const fx = makeFixture();
  const [y, m, d] = today().split('-');
  const csv = path.join(fx.dir, 'bank.csv');
  writeFileSync(csv, `Date,Description,Amount\n${d}/${m}/${y},CORNER SHOP,-12.34\n`);
  const { app, win } = await launch(fx, { bank: [csv] });
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Import', exact: true }).click();
  await win.getByRole('button', { name: 'Next' }).click();
  await win.getByRole('button', { name: /^Import 1 new/ }).click();
  await expect(win.locator('.rrow', { hasText: 'CORNER SHOP' })).toBeVisible();
  // The same layout goes straight to the review next time...
  writeFileSync(csv, `Date,Description,Amount\n${d}/${m}/${y},CAFE,-2.00\n`);
  await win.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(win.getByRole('button', { name: /^Import 1 new/ })).toBeVisible();
  await win.getByRole('button', { name: 'Cancel' }).click();
  // ...but a new column brings the column screen back instead of reading the wrong one.
  writeFileSync(csv, `Date,Type,Description,Amount\n${d}/${m}/${y},POS,CORNER SHOP 4471,-5.00\n`);
  await win.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(win.locator('.modal')).toContainText("This file's columns are different from last time");
  await expect(win.getByRole('button', { name: 'Next' })).toBeVisible();
  await win.getByRole('button', { name: 'Cancel' }).click();
  await app.close();
});

test("choosing a payee fills in only its category, unless memo and amount are switched on", async () => {
  const fx = makeFixture();
  saveTransaction(fx.budget, { accountId: fx.ids.current, date: today(), payeeName: 'Corner Shop', categoryId: fx.ids.groceries, amount: -1234, memo: 'milk', cleared: 'U' });
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Add a new transaction' }).click();
  await win.getByLabel('Payee').fill('Corner Sh');
  await win.keyboard.press('Enter');
  await expect(win.getByLabel('Category')).toHaveValue(/Groceries/);
  await expect(win.getByLabel('Outflow')).toHaveValue('');
  await expect(win.getByLabel('Memo')).toHaveValue('');
  await win.getByLabel('Outflow').fill('1');
  await win.getByLabel('Outflow').press('Enter');

  await win.locator('.sb-nav-btn', { hasText: 'Settings' }).click();
  await win.getByLabel('Memo').check();
  await win.getByLabel('Amount').check();
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Add a new transaction' }).click();
  await win.getByLabel('Payee').fill('Corner Sh');
  await win.keyboard.press('Enter');
  await expect(win.getByLabel('Outflow')).toHaveValue('1.00');
  const saved = await savedBudget(fx, win);
  expect(saved.settings.autoFill).toEqual({ category: true, memo: true, amount: true });
  await app.close();
});

test('adjusts a balance and switches an account on budget from the account menu', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Adjust balance…' }).click();
  await win.getByLabel('New working balance').fill('1200');
  await win.getByLabel('New working balance').press('Tab');
  await expect(win.locator('.modal')).toContainText('Manual Balance Adjustment');
  await win.getByRole('button', { name: 'Adjust balance', exact: true }).click();
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await expect(win.locator('.rb.working')).toContainText('£1,200.00');
  await expect(win.locator('.rrow', { hasText: 'Manual Balance Adjustment' })).toContainText('Income for');

  await win.locator('.sidebar .acc-row', { hasText: 'Pension' }).click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Make this a budget account…' }).click();
  await win.getByRole('button', { name: 'Make it a budget account' }).click();
  const saved = await savedBudget(fx, win);
  expect(saved.accounts[fx.ids.pension].onBudget).toBe(true);
  await app.close();
});

test('Quick Budget: the month bolt fills empty cells, and a cell has its own drop-down', async () => {
  const fx = makeFixture();
  saveTransaction(fx.budget, { accountId: fx.ids.current, date: today(), payeeName: 'Corner Shop', categoryId: fx.ids.groceries, amount: -1234, cleared: 'U' });
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const { app, win } = await launch(fx);
  const next = addMonths(thisMonth(), 1);
  const rent = win.locator(`.brow:has([data-cat="${fx.ids.rent}"])`);
  const groceries = win.locator(`.brow:has([data-cat="${fx.ids.groceries}"])`);

  // Next month: fill the empty cells with last month's budget.
  await win.getByRole('button', { name: `Quick budget for ${monthLabel(next)}` }).click();
  await expect(win.locator('.menu')).toContainText('Fill in all empty budget cells');
  await win.getByRole('menuitem', { name: /Budget values used last month/ }).click();
  await expect(rent.locator('.cell.budgeted').nth(1)).toHaveText('£600.00');

  // An existing amount is kept unless "Overwrite all" is chosen.
  await rent.locator('.cell.budgeted').nth(1).click();
  await win.keyboard.type('5');
  await win.keyboard.press('Enter');
  await win.getByRole('button', { name: `Quick budget for ${monthLabel(next)}` }).click();
  await expect(win.getByRole('menuitem', { name: /Budget values used last month/ })).toBeDisabled();
  await win.getByRole('menuitem', { name: 'Overwrite all budget cells with…' }).click();
  await win.getByRole('menuitem', { name: /Budget values used last month/ }).click();
  await win.getByRole('button', { name: 'Overwrite', exact: true }).click();
  await expect(rent.locator('.cell.budgeted').nth(1)).toHaveText('£600.00');

  // This month's Groceries cell: the drop-down offers "Balance to 0.00", by mouse or Alt+Down.
  await groceries.locator('.cell.budgeted').first().click();
  await win.keyboard.press('Alt+ArrowDown');
  await expect(win.getByRole('option', { name: /Balance to 0\.00/ })).toContainText('£12.34');
  await win.getByRole('option', { name: /Balance to 0\.00/ }).click();
  await expect(groceries.locator('.cell.budgeted').first()).toHaveText('£12.34');
  const saved = await savedBudget(fx, win);
  expect(saved.months[thisMonth()][fx.ids.groceries].budgeted).toBe(1234);
  expect(saved.months[next][fx.ids.rent].budgeted).toBe(60000);
  await app.close();
});

test('scheduled transactions sit in their own pane under the register, as in YNAB4', async () => {
  const fx = makeFixture();
  const next = addDays(today(), 7);
  saveScheduled(fx.budget, { accountId: fx.ids.current, date: next, startDate: next, frequency: 'Monthly', payeeId: ensurePayee(fx.budget, 'Landlord'), categoryId: fx.ids.rent, amount: -60000 });
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  // Not mixed in with the transactions.
  await expect(win.locator('.rrow', { hasText: 'Landlord' })).toHaveCount(0);
  const pane = win.getByLabel('Scheduled transactions');
  await expect(pane.locator('.sp-row', { hasText: 'Landlord' })).toContainText('Monthly');
  // Dragging its top edge makes it taller.
  const before = (await pane.boundingBox())!.height;
  const edge = (await pane.locator('.sp-resize').boundingBox())!;
  await win.mouse.move(edge.x + 200, edge.y + 3);
  await win.mouse.down();
  await win.mouse.move(edge.x + 200, edge.y - 120, { steps: 5 });
  await win.mouse.up();
  expect((await pane.boundingBox())!.height).toBeGreaterThan(before + 100);
  const toggle = win.getByRole('button', { name: /Scheduled Transactions \(1\)/ });
  await toggle.click();
  await expect(pane).toHaveCount(0);
  await toggle.click();
  await pane.getByRole('button', { name: 'Enter now' }).click();
  await expect(win.locator('.rrow', { hasText: 'Landlord' })).toHaveCount(1);
  // A new one from the pane opens the scheduled transaction box.
  await pane.getByRole('button', { name: /Schedule a new transaction/ }).click();
  await expect(win.locator('.modal').getByLabel('Repeat')).toHaveValue('Monthly');
  await win.keyboard.press('Escape');
  await app.close();
});

test('the import review shows confident and suggested guesses, and sets similar rows', async () => {
  const fx = makeFixture();
  const cat = (name: string) => Object.values(fx.budget.categories).find((c) => c.name === name)!.id;
  const restaurants = cat('Restaurants');
  const transport = cat('Transport');
  let n = 0;
  const earlier = (text: string, amount: number, categoryId: string, daysAgo: number) =>
    saveTransaction(fx.budget, {
      accountId: fx.ids.current,
      date: addDays(today(), -daysAgo),
      payeeName: text,
      importedPayee: text,
      importIds: ['YNAB:e2e:' + ++n],
      amount,
      categoryId,
      cleared: 'C',
    });
  for (const d of [40, 33, 26]) earlier('GREEN GROCER SOMETOWN', -900, fx.ids.groceries, d);
  earlier('CORNER CAFE NORTH', -450, restaurants, 30);
  earlier('CORNER CAFE SOUTH', -380, restaurants, 20);
  earlier('CORNER CAFE EAST', -1200, fx.ids.groceries, 10);
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const [y, m, d] = today().split('-');
  const qif = path.join(fx.dir, 'statement.qif');
  const rec = (payee: string, amount: string) => [`D${d}/${m}/${y}`, `T${amount}`, `P${payee}`, '^'];
  writeFileSync(
    qif,
    ['!Type:Bank', ...rec('GREEN GROCER SOMETOWN', '-9.00'), ...rec('CORNER CAFE WEST', '-4.10'), ...rec('BUSCO TRIP 111', '-2.10'), ...rec('BUSCO TRIP 222', '-2.20'), ...rec('BUSCO TRIP 333', '-2.30'), ''].join('\r\n'),
  );
  const { app, win } = await launch(fx, { bank: [qif] });
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Import', exact: true }).click();
  const modal = win.locator('.modal');
  const rowOf = (text: string) => modal.locator('tr', { hasText: text });
  // Confident: the payee's last 3. Suggested: 2 of 3 like "corner cafe", with a "?".
  await expect(rowOf('GREEN GROCER')).toContainText('all of the last 3');
  await expect(rowOf('GREEN GROCER').locator('.sugg-mark')).toHaveCount(0);
  // (Proposed as the existing payee of the same merchant, so found by its amount.)
  await expect(rowOf('£4.10')).toContainText('looks like CORNER CAFE');
  await expect(rowOf('£4.10')).toContainText('2 of 3 like "corner cafe"');
  await expect(rowOf('£4.10').locator('.sugg-mark')).toHaveCount(1);
  // From the keyboard: Space unticks and ticks a row, Enter accepts its suggestion.
  await rowOf('£4.10').locator('td').nth(2).click();
  await win.keyboard.press(' ');
  await expect(rowOf('£4.10').getByLabel('Include')).not.toBeChecked();
  await win.keyboard.press(' ');
  await expect(rowOf('£4.10').getByLabel('Include')).toBeChecked();
  await win.keyboard.press('Enter');
  await expect(rowOf('£4.10').locator('.sugg-mark')).toHaveCount(0);
  await modal.getByLabel(/Suggested \(/).check();
  await expect(rowOf('GREEN GROCER')).toHaveCount(0);
  await modal.getByRole('radio', { name: 'All' }).check();
  // Setting one bus row offers to set the other two like it.
  await rowOf('BUSCO TRIP 111').getByLabel('Category').fill('Transport');
  await win.keyboard.press('Enter');
  await expect(modal.locator('.similar-bar')).toContainText('Also set the 2 other rows like "busco trip"');
  await modal.getByRole('button', { name: 'Set 2' }).click();
  await expect(rowOf('BUSCO TRIP 333').getByLabel('Category')).toHaveValue(/Transport/);
  await win.keyboard.press('Control+Enter');
  await expect(modal).toHaveCount(0);
  const saved = await savedBudget(fx, win);
  const bus = Object.values(saved.transactions).filter((t) => t.importedPayee?.startsWith('BUSCO TRIP'));
  expect(bus.map((t) => t.categoryId)).toEqual([transport, transport, transport]);
  await app.close();
});

test('suggests merging payees of the same shop, and merges them with a backup', async () => {
  const fx = makeFixture();
  let n = 0;
  for (const text of ['TESCO STORES 1111 TOWNA GB', 'TESCO STORES 2222 TOWNB GB', 'TESCO STORES 3333 TOWNC GB']) {
    saveTransaction(fx.budget, {
      accountId: fx.ids.current,
      date: addDays(today(), -10 + n),
      payeeName: text,
      importedPayee: text,
      importIds: ['YNAB:m:' + ++n],
      amount: -1000 * n,
      categoryId: fx.ids.groceries,
      cleared: 'C',
    });
  }
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const { app, win } = await launch(fx);
  await win.locator('.sb-nav-btn', { hasText: 'Payees' }).click();
  await win.getByRole('tab', { name: 'Suggested merges (1)' }).click();
  await expect(win.locator('.merge-card')).toContainText('"tesco stores"');
  await expect(win.locator('.merge-card')).toContainText('3 payees');
  await win.getByLabel('Name for "tesco stores"').fill('Tesco Stores');
  await win.getByLabel('Merge "tesco stores"').check();
  await win.getByRole('button', { name: /Merge 1 ticked/ }).click();
  await win.locator('.modal').getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(win.getByRole('tab', { name: 'Suggested merges (0)' })).toBeVisible();
  const saved = await savedBudget(fx, win);
  const tesco = Object.values(saved.payees).filter((p) => p.name.startsWith('Tesco') || p.name.startsWith('TESCO'));
  expect(tesco.map((p) => p.name)).toEqual(['Tesco Stores']);
  expect(tesco[0].bankTexts).toHaveLength(2);
  const backups = readdirSync(path.join(fx.dir, 'userdata', 'backups', fx.budget.id));
  expect(backups.some((f) => f.startsWith('before-merge_'))).toBe(true);
  await app.close();
});

test('imports several files through the inbox, one account each, with a summary', async () => {
  const fx = makeFixture();
  const [y, m, d] = today().split('-');
  const q = (name: string, rows: [string, string][]) => writeQif(fx, name, 'Bank', rows.map(([p, t]) => [p, t]));
  const a = q('first.qif', [
    ['CORNER SHOP', '-1.00'],
    ['BAKERY', '-2.00'],
  ]);
  const b2 = q('second.qif', [['INTEREST', '0.50']]);
  const { app, win } = await launch(fx, { bank: [a, b2] });
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Import', exact: true }).click();
  const inbox = win.locator('.modal', { hasText: 'Accounts by last import' });
  await expect(inbox).toContainText('first.qif');
  // Several files: the register they were opened from isn't a guess for any of them (1.4.4), and
  // a budget that has learned no accounts yet says so.
  await expect(inbox).not.toContainText('opened from this account');
  await expect(inbox).toContainText('first import here: choose the account');
  await inbox.getByLabel('Account for first.qif').fill('Current Account');
  await win.keyboard.press('Enter');
  await inbox.getByLabel('Account for second.qif').fill('Savings');
  await win.keyboard.press('Enter');
  await inbox.getByRole('button', { name: 'Review 2 files →' }).click();
  await expect(win.locator('.modal-title')).toContainText('first.qif (1 of 2)');
  await win.getByRole('button', { name: /^Import 2 new/ }).click();
  await expect(win.locator('.modal-title')).toContainText('second.qif (2 of 2)');
  await win.getByRole('button', { name: /^Import 1 new/ }).click();
  const summary = win.locator('.modal', { hasText: 'Import finished' });
  await expect(summary).toContainText('Current Account');
  await expect(summary).toContainText('Savings');
  await expect(summary).toContainText('2 added');
  await summary.getByRole('button', { name: 'Done' }).click();
  const saved = await savedBudget(fx, win);
  expect(saved.accounts[fx.ids.current].lastImport?.to).toBe(`${y}-${m}-${d}`);
  expect(saved.accounts[fx.ids.savings].lastImport?.to).toBe(`${y}-${m}-${d}`);
  expect(Object.values(saved.transactions).filter((t) => t.accountId === fx.ids.savings && t.importIds?.length)).toHaveLength(1);
  await app.close();
});

test('a bank file dropped on the window opens the import', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  const [y, m, d] = today().split('-');
  const text = ['!Type:Bank', `D${d}/${m}/${y}`, 'T-3.00', 'PDROPPED SHOP', '^', ''].join('\r\n');
  await win.evaluate((t) => {
    const dt = new DataTransfer();
    dt.items.add(new File([t], 'dropped.qif', { type: 'text/plain' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, text);
  await expect(win.locator('.modal-title')).toContainText('dropped.qif');
  await win.getByRole('button', { name: /^Import 1 new/ }).click();
  await expect(win.locator('.rrow', { hasText: 'DROPPED SHOP' })).toBeVisible();
  await app.close();
});

test('1.4: hidden categories at the bottom, a running balance per account, a categories filter on reports', async () => {
  const fx = makeFixture();
  const water = Object.values(fx.budget.categories).find((c) => c.name === 'Water')!.id;
  setCategoryHidden(fx.budget, water, true);
  saveTransaction(fx.budget, { accountId: fx.ids.current, date: today(), payeeName: 'Shop', categoryId: fx.ids.groceries, amount: -2000, cleared: 'C' });
  saveTransaction(fx.budget, { accountId: fx.ids.current, date: today(), payeeName: 'Landlord', categoryId: fx.ids.rent, amount: -60000, cleared: 'C' });
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const { app, win } = await launch(fx);

  // Hidden categories are listed together at the bottom, each with its own group's name.
  await win.getByTitle('Show hidden categories').first().click();
  const last = win.locator('.mrow.cat').last();
  await expect(last).toContainText('Hidden Categories');
  await expect(win.locator(`.crow.cat[data-cat="${water}"]`)).toContainText('Water · Monthly Bills');

  // The running balance can be off in one account and on in another.
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await expect(win.locator('.rh', { hasText: 'BALANCE' })).toHaveCount(1);
  await win.getByRole('button', { name: 'View ▾' }).click();
  await win.getByRole('menuitem', { name: /Running balance column \(this account\)/ }).click();
  await expect(win.locator('.rh', { hasText: 'BALANCE' })).toHaveCount(0);
  await win.locator('.sidebar .acc-row', { hasText: 'Savings' }).click();
  await expect(win.locator('.rh', { hasText: 'BALANCE' })).toHaveCount(1);

  // Reports: only the chosen categories count.
  await win.locator('.sb-nav-btn', { hasText: 'Reports' }).click();
  await win.getByRole('tab', { name: 'Spending', exact: true }).click();
  // Groceries £20, rent £600 and the card's starting debt £200.
  await expect(win.locator('.rp-dc-value')).toContainText('£820.00');
  await win.getByRole('button', { name: /All categories/ }).click();
  const pop = win.locator('.rp-cat-pop');
  await pop.getByRole('button', { name: 'None' }).first().click();
  await pop.getByLabel('Groceries').check();
  await pop.getByRole('button', { name: 'Done' }).click();
  await expect(win.getByRole('button', { name: /^Groceries/ })).toBeVisible();
  await expect(win.locator('.rp-dc-value')).toContainText('£20.00');
  await app.close();
});

test('1.4.3: Shift+F10 and the Menu key open right-click menus, popovers take the focus, the scheduled form is labelled', async () => {
  const fx = makeFixture();
  saveTransaction(fx.budget, { accountId: fx.ids.current, date: today(), payeeName: 'Shop', categoryId: fx.ids.groceries, amount: -2000, cleared: 'C' });
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const { app, win } = await launch(fx);
  const menu = win.getByRole('menu');
  const focusInPopover = () => win.evaluate(() => !!document.activeElement?.closest('.popover'));

  // Budget: the Menu key opens the current category's menu, with the focus on its first item.
  await win.locator(`.crow.cat[data-cat="${fx.ids.groceries}"]`).click();
  await win.keyboard.press('ContextMenu');
  await expect(menu).toContainText('Rename');
  await expect(win.getByRole('menuitem').first()).toBeFocused();
  await win.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(win.locator('.budget-scroll')).toBeFocused();

  // A popover takes the focus, keeps Tab inside, and gives the focus back when it closes.
  const pill = win.locator('.brow', { has: win.locator(`[data-cat="${fx.ids.groceries}"]`) }).locator('button.pill').first();
  await pill.click();
  await expect(win.locator('.popover')).toContainText('Move money');
  expect(await focusInPopover()).toBe(true);
  for (let i = 0; i < 6; i++) await win.keyboard.press('Tab');
  expect(await focusInPopover()).toBe(true);
  await win.keyboard.press('Escape');
  await expect(win.locator('.popover')).toHaveCount(0);
  await expect(pill).toBeFocused();

  // Register: Shift+F10 opens the selected row's menu; in a text box it does nothing.
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.locator('.rrow', { hasText: 'Shop' }).click();
  await win.keyboard.press('Shift+F10');
  await expect(menu).toContainText('Edit');
  await win.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await win.getByPlaceholder(/Search payee/).focus();
  await win.keyboard.press('Shift+F10');
  await win.waitForTimeout(200);
  await expect(menu).toHaveCount(0);

  // Sidebar: Tab reaches the accounts, Shift+F10 opens an account's menu, Enter opens it.
  const savings = win.locator('.sidebar .acc-row', { hasText: 'Savings' });
  await savings.focus();
  await win.keyboard.press('Shift+F10');
  await expect(menu).toContainText('Adjust balance');
  await win.keyboard.press('Escape');
  await expect(savings).toBeFocused();
  await win.keyboard.press('Enter');
  await expect(win.locator('.reg-title, h1').first()).toContainText('Savings');

  // The scheduled transaction dialog names its boxes.
  await win.locator('.sb-nav-btn', { hasText: 'Scheduled' }).click();
  await win.getByRole('button', { name: 'Add scheduled transaction' }).click();
  await expect(win.locator('.sched-labels')).toContainText('Next date');
  await expect(win.locator('.sched-labels')).toContainText('Payee');
  await expect(win.locator('.sched-labels')).toContainText('Outflow');
  await app.close();
});

test("1.4.4: the app's shortcuts wait while an import is open", async () => {
  const fx = makeFixture();
  const other = makeFixture(); // a second budget, with its own id
  const otherBefore = readFileSync(other.file, 'utf8');
  const a = writeQif(fx, 'first.qif', 'Bank', [['CORNER SHOP', '-1.00'], ['BAKERY', '-2.00']]);
  const b2 = writeQif(fx, 'second.qif', 'Bank', [['INTEREST', '0.50']]);
  const { app, win } = await launch(fx, { bank: [a, b2], open: other.file });
  await win.keyboard.press('Control+I');
  const inbox = win.locator('.modal', { hasText: 'Accounts by last import' });
  await inbox.getByLabel('Account for first.qif').fill('Current Account');
  await win.keyboard.press('Enter');
  await inbox.getByLabel('Account for second.qif').fill('Savings');
  await win.keyboard.press('Enter');
  await inbox.getByRole('button', { name: 'Review 2 files →' }).click();
  await win.getByRole('button', { name: /^Import 2 new/ }).click();
  await expect(win.locator('.modal-title')).toContainText('second.qif (2 of 2)');
  await win.locator('.review-table tbody tr').first().click();
  await win.keyboard.press('Control+z'); // mustn't undo first.qif
  await win.keyboard.press('Control+i'); // no second import
  await win.keyboard.press('Control+o'); // no other budget under the review
  await win.waitForTimeout(500);
  await expect(win.locator('.modal')).toHaveCount(1);
  // F1 opens on top; Esc closes it, not the import.
  await win.keyboard.press('F1');
  await expect(win.locator('.modal')).toHaveCount(2);
  await win.keyboard.press('Escape');
  await expect(win.locator('.modal')).toHaveCount(1);
  await expect(win.locator('.modal-title')).toContainText('second.qif (2 of 2)');
  await win.getByRole('button', { name: /^Import 1 new/ }).click();
  await win.locator('.modal', { hasText: 'Import finished' }).getByRole('button', { name: 'Done' }).click();
  const saved = await savedBudget(fx, win);
  expect(Object.values(saved.transactions).filter((t) => t.importIds?.length)).toHaveLength(3);
  expect(readFileSync(other.file, 'utf8')).toBe(otherBefore);
  await app.close();
});

test("1.4.4: keys in a register's menus and dialogs stay there", async () => {
  const fx = makeFixture();
  saveTransaction(fx.budget, { accountId: fx.ids.current, date: today(), payeeName: 'Shop', categoryId: fx.ids.groceries, amount: -2000, cleared: 'U' });
  saveTransaction(fx.budget, { accountId: fx.ids.current, date: today(), payeeName: 'Bakery', categoryId: fx.ids.groceries, amount: -300, cleared: 'U' });
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const qif = writeQif(fx, 'one.qif', 'Bank', [['CORNER SHOP', '-1.00']]);
  const qif2 = writeQif(fx, 'two.qif', 'Bank', [['BAKERY', '-2.00']]);
  const { app, win } = await launch(fx, { bank: [qif, qif2] });
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  const count = async () => Object.keys((await savedBudget(fx, win)).transactions).length;

  // The row menu: ↓ moves in the menu only, and Enter chooses the item.
  await win.locator('.rrow', { hasText: 'Shop' }).click();
  await win.keyboard.press('Shift+F10');
  await win.keyboard.press('ArrowDown');
  await expect(win.getByRole('menuitem', { name: 'Mark cleared' })).toBeFocused();
  await expect(win.locator('.rrow.selected')).toContainText('Shop');
  await win.keyboard.press('Enter');
  await expect(win.getByRole('menu')).toHaveCount(0);
  await expect(win.locator('.tx-editor')).toHaveCount(0);
  expect(Object.values((await savedBudget(fx, win)).transactions).find((t) => t.amount === -2000)?.cleared).toBe('C');

  // Delete on a button in the Scheduled dialog doesn't delete the selected row.
  const n = await count();
  await win.locator('.rrow', { hasText: 'Bakery' }).click();
  await win.getByRole('button', { name: /Schedule a new transaction/ }).click();
  await win.locator('.modal').getByRole('button', { name: 'Cancel' }).focus();
  await win.keyboard.press('Delete');
  await win.locator('.modal').getByRole('button', { name: 'Cancel' }).click();
  expect(await count()).toBe(n);

  // Nor does Delete on one of the register's own buttons.
  await win.locator('.rrow', { hasText: 'Bakery' }).click();
  await win.getByRole('button', { name: /Reconcile Account/ }).focus();
  await win.keyboard.press('Delete');
  await win.waitForTimeout(300);
  expect(await count()).toBe(n);

  // But a row's own C button, clicked, leaves the keyboard on the rows: Enter edits the selected
  // row, rather than pressing that C again.
  const shopCleared = async () => Object.values((await savedBudget(fx, win)).transactions).find((t) => t.amount === -2000)?.cleared;
  await win.locator('.rrow', { hasText: 'Bakery' }).click();
  await win.locator('.rrow', { hasText: 'Shop' }).locator('button.cleared').click();
  await expect.poll(shopCleared).toBe('U');
  await expect(win.locator('.reg-scroll')).toBeFocused();
  await win.keyboard.press('Enter');
  await expect(win.locator('.tx-editor')).toHaveCount(1);
  await expect(win.locator('.tx-editor').getByLabel('Payee')).toHaveValue('Bakery');
  await win.keyboard.press('Escape');
  await expect(win.locator('.tx-editor')).toHaveCount(0);
  expect(await shopCleared()).toBe('U');

  // A dialog opened over the register takes the focus, so Delete doesn't reach the register.
  await win.locator('.rrow', { hasText: 'Bakery' }).click();
  await win.keyboard.press('Control+I');
  await expect(win.locator('.modal', { hasText: 'Accounts by last import' })).toBeVisible();
  expect(await win.evaluate(() => !!document.activeElement?.closest('.modal'))).toBe(true);
  await win.keyboard.press('Delete');
  await win.keyboard.press('Escape');
  await expect(win.locator('.modal')).toHaveCount(0);
  expect(await count()).toBe(n);
  await expect(win.locator('.reg-scroll')).toBeFocused();

  // After a whole import (inbox, two reviews, summary), the focus is back on the register.
  await win.keyboard.press('Control+I');
  const inbox = win.locator('.modal', { hasText: 'Accounts by last import' });
  await inbox.getByLabel('Account for one.qif').fill('Current Account');
  await win.keyboard.press('Enter');
  await inbox.getByLabel('Account for two.qif').fill('Current Account');
  await win.keyboard.press('Enter');
  await inbox.getByRole('button', { name: 'Review 2 files →' }).click();
  await win.getByRole('button', { name: /^Import 1 new/ }).click();
  await expect(win.locator('.modal-title')).toContainText('two.qif (2 of 2)');
  // The clicked button has gone, but the keyboard stays in the dialog.
  await expect.poll(() => win.evaluate(() => !!document.activeElement?.closest('.modal'))).toBe(true);
  await win.getByRole('button', { name: /^Import 1 new/ }).click();
  await win.locator('.modal', { hasText: 'Import finished' }).getByRole('button', { name: 'Done' }).click();
  await expect(win.locator('.modal')).toHaveCount(0);
  await expect(win.locator('.reg-scroll')).toBeFocused();
  await app.close();
});

test("1.4.4: the budget grid leaves its menus' keys alone and keeps the focus after an edit", async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  const selected = win.locator('.crow.cat.sel');

  // A category's ⋯ menu: ↓ ↓ to Hide, then Enter hides it; the selection doesn't move.
  const groceries = win.locator(`.crow.cat[data-cat="${fx.ids.groceries}"]`);
  await groceries.hover();
  await groceries.locator('.row-btn').click();
  await win.keyboard.press('ArrowDown');
  await win.keyboard.press('ArrowDown');
  await expect(win.getByRole('menuitem', { name: 'Hide' })).toBeFocused();
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveAttribute('data-cat', fx.ids.groceries);
  await win.keyboard.press('Enter');
  await expect(win.getByRole('menu')).toHaveCount(0);
  expect(await win.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
  expect((await savedBudget(fx, win)).categories[fx.ids.groceries].hidden).toBe(true);

  // After Enter in a budget cell, the keyboard is still on the grid.
  await win.locator(`.crow.cat[data-cat="${fx.ids.rent}"]`).click();
  await win.keyboard.press('Enter');
  await win.keyboard.type('40');
  await win.keyboard.press('Enter');
  await expect(win.locator('.budget-scroll')).toBeFocused();
  await win.keyboard.press('ArrowDown');
  await expect(selected).not.toHaveAttribute('data-cat', fx.ids.rent);

  // On one of the grid's own buttons the arrows still move the selection.
  await win.locator(`.crow.cat[data-cat="${fx.ids.rent}"]`).click();
  await win.getByRole('button', { name: 'Next month' }).focus();
  await win.keyboard.press('ArrowDown');
  await expect(selected).not.toHaveAttribute('data-cat', fx.ids.rent);
  // ...and take the keyboard back to the grid, so Enter edits the new row instead of pressing the button.
  await expect(win.locator('.budget-scroll')).toBeFocused();
  await win.keyboard.press('Enter');
  expect(await win.evaluate(() => document.activeElement?.tagName)).toBe('INPUT');
  await win.keyboard.press('Escape');

  // A dialog opened from a right-click menu gives the focus back to the grid.
  await win.locator(`.crow.cat[data-cat="${fx.ids.rent}"]`).click();
  await win.keyboard.press('Shift+F10');
  await win.getByRole('menuitem', { name: 'Notes…' }).focus();
  await win.keyboard.press('Enter');
  await expect(win.locator('.modal')).toHaveCount(1);
  await win.keyboard.press('Escape');
  await expect(win.locator('.modal')).toHaveCount(0);
  await expect(win.locator('.budget-scroll')).toBeFocused();

  // So does one from a title-bar menu opened with the mouse (not the title bar's button).
  await win.locator('.tb-menu-btn[data-menu="Budget"]').click();
  await win.getByRole('menuitem', { name: 'Check budget…' }).click();
  await win.locator('.modal').getByRole('button', { name: 'OK' }).click();
  await expect(win.locator('.modal')).toHaveCount(0);
  await expect(win.locator('.budget-scroll')).toBeFocused();

  // And one opened while a budget cell is being edited (F1 here), though the cell's box has gone by then.
  await win.locator(`.crow.cat[data-cat="${fx.ids.rent}"]`).click();
  await win.keyboard.press('Enter');
  expect(await win.evaluate(() => document.activeElement?.tagName)).toBe('INPUT');
  await win.keyboard.press('F1');
  await expect(win.locator('.modal')).toHaveCount(1);
  await win.keyboard.press('Escape');
  await expect(win.locator('.modal')).toHaveCount(0);
  await expect(win.locator('.budget-scroll')).toBeFocused();
  await app.close();
});

test('1.4.4: removing a payee rule leaves the others as they were', async () => {
  const fx = makeFixture();
  saveTransaction(fx.budget, { accountId: fx.ids.current, date: today(), payeeName: 'Shop', categoryId: fx.ids.groceries, amount: -2000, cleared: 'U' });
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const { app, win } = await launch(fx);
  await win.locator('.sb-nav-btn', { hasText: 'Payees' }).first().click();
  await win.locator('.plist-row', { hasText: 'Shop' }).click();
  const boxes = win.getByLabel('Rule text');
  await win.getByRole('button', { name: '+ Add rule' }).click();
  await boxes.nth(0).fill('SHOP ONE');
  await win.keyboard.press('Tab');
  await win.getByRole('button', { name: '+ Add rule' }).click();
  await boxes.nth(1).fill('SHOP TWO');
  await win.keyboard.press('Tab');
  await boxes.nth(0).fill('SHOP ONEX');
  await win.keyboard.press('Tab');
  await win.getByTitle('Remove rule').nth(0).click();
  await expect(boxes).toHaveCount(1);
  await expect(boxes.nth(0)).toHaveValue('SHOP TWO');
  await boxes.nth(0).click();
  await win.keyboard.press('Tab');
  const shop = Object.values((await savedBudget(fx, win)).payees).find((p) => p.name === 'Shop');
  expect(shop?.rules.map((r) => r.text)).toEqual(['SHOP TWO']);
  await app.close();
});

test("1.4.4: Space or Enter after the column screen's Next doesn't skip the file, and skipped files are listed", async () => {
  const fx = makeFixture();
  const [y, m, d] = today().split('-');
  const csv = path.join(fx.dir, 'card.csv');
  writeFileSync(csv, `Date,Description,Amount\n${d}/${m}/${y},CORNER SHOP,-4.00\n`);
  const qif = writeQif(fx, 'bank.qif', 'Bank', [['BAKERY', '-2.00']]);
  const { app, win } = await launch(fx, { bank: [csv, qif] });
  await win.keyboard.press('Control+I');
  const inbox = win.locator('.modal', { hasText: 'Accounts by last import' });
  await inbox.getByLabel('Account for card.csv').fill('Credit Card');
  await win.keyboard.press('Enter');
  await inbox.getByLabel('Account for bank.qif').fill('Current Account');
  await win.keyboard.press('Enter');
  await inbox.getByRole('button', { name: 'Review 2 files →' }).click();
  const title = win.locator('.modal-title');
  // Whichever comes first: skip the QIF, and take the CSV through its column screen.
  for (let i = 0; i < 2; i++) {
    await expect(title).toContainText(`(${i + 1} of 2)`);
    if ((await title.innerText()).includes('bank.qif')) {
      await win.getByRole('button', { name: 'Skip this file' }).click();
      continue;
    }
    await win.locator('.modal').getByRole('button', { name: 'Next', exact: true }).click();
    await expect(win.getByRole('button', { name: /^Import 1 new/ })).toBeVisible();
    await win.keyboard.press('Space');
    await win.keyboard.press('Enter');
    await win.waitForTimeout(300);
    await expect(title).toContainText('card.csv');
    await win.getByRole('button', { name: /^Import 1 new/ }).click();
  }
  const summary = win.locator('.modal', { hasText: 'Import finished' });
  await expect(summary).toContainText('card.csv');
  await expect(summary).toContainText('Skipped, nothing imported from it: bank.qif');
  await app.close();
});

test('1.4.4: message boxes close with Esc, Split keeps the keyboard, Reconcile takes one click', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);

  // A one-button message box (Check budget's "No problems found") closes with Esc.
  await win.locator('.tb-menu-btn[data-menu="Budget"]').click();
  await win.getByRole('menuitem', { name: /Check budget/ }).click();
  await expect(win.locator('.modal', { hasText: 'No problems found' })).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(win.locator('.modal')).toHaveCount(0);

  // Choosing Split moves the keyboard to the first line. Esc then works as in any box: the first
  // closes its drop-down, the second the editor.
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: /Add a new transaction/ }).click();
  const category = win.locator('.tx-editor').getByLabel('Category', { exact: true });
  await category.fill('Split');
  await win.keyboard.press('Enter');
  await expect(win.getByLabel('Split 1 category')).toBeFocused();
  await win.keyboard.press('Escape');
  await win.keyboard.press('Escape');
  await expect(win.locator('.tx-editor')).toHaveCount(0);

  // Reconcile: the button follows the typing, so one click adds the adjustment and finishes.
  await win.getByRole('button', { name: /Reconcile Account/ }).click();
  await win.locator('.modal').getByRole('button', { name: 'No' }).click();
  await win.getByLabel('Statement balance').fill('990');
  await win.locator('.modal').getByRole('button', { name: /Add .*10\.00 adjustment and finish/ }).click();
  await expect(win.locator('.modal')).toHaveCount(0);
  const saved = await savedBudget(fx, win);
  const adj = Object.values(saved.transactions).find((t) => saved.payees[t.payeeId ?? '']?.name === 'Reconciliation Balance Adjustment');
  expect(adj?.amount).toBe(-1000);
  await app.close();
});

test("1.4.4: one file from a register isn't put in that account when it names another card", async () => {
  const fx = makeFixture();
  fx.budget.accounts[fx.ids.card].importKeys = ['card:1111'];
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const file = path.join(fx.dir, 'statement.qif');
  const [y, m, d] = today().split('-');
  writeFileSync(file, ['!Type:CCard', `D${d}/${m}/${y}`, 'T-4.00', 'PCAFE', 'M2222/ CAFE', '^', `D${d}/${m}/${y}`, 'T-5.00', 'PSHOP', 'M2222/ SHOP', '^', ''].join('\r\n'));
  const { app, win } = await launch(fx, { bank: [file] });
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(win.locator('.modal-title')).toContainText('statement.qif');
  await expect(win.locator('.modal').getByLabel('Account', { exact: true })).toHaveValue('');
  await app.close();
});

test('1.4.4: a rule transfer whose bank text went elsewhere last time asks, and "Use it" switches', async () => {
  const fx = makeFixture();
  const b = fx.budget;
  const saverPayee = Object.values(b.payees).find((p) => p.transferAccountId === fx.ids.savings)!;
  saverPayee.rules = [{ op: 'contains', text: 'REGULAR SAVER' }];
  // Last month the same bank text was a transfer to the card.
  saveTransaction(b, { accountId: fx.ids.current, transferAccountId: fx.ids.card, date: addDays(today(), -30), amount: -10000, cleared: 'C', importedPayee: 'REGULAR SAVER 1', importIds: ['YNAB:old:1'] });
  writeFileSync(fx.file, serializeBudget(b));
  const qif = writeQif(fx, 'saver.qif', 'Bank', [['REGULAR SAVER 1', '-100.00']]);
  const { app, win } = await launch(fx, { bank: [qif] });
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Import', exact: true }).click();
  const review = win.locator('.review-table');
  await expect(review).toContainText('Transfer : Savings');
  await expect(review).toContainText('last time a transfer to Credit Card');
  await review.getByRole('button', { name: 'Use it' }).click();
  await expect(review).toContainText('Transfer : Credit Card');
  await win.getByRole('button', { name: /^Import 1 new/ }).click();
  const saved = await savedBudget(fx, win);
  const t = Object.values(saved.transactions).find((x) => x.importedPayee === 'REGULAR SAVER 1' && x.date === today());
  expect(t?.transferAccountId).toBe(fx.ids.card);
  await app.close();
});

test('1.4.4: "12,50" is £12.50, an unclear comma is refused, and the editor waits for an amount it can read', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: /Add a new transaction/ }).click();
  const editor = win.locator('.tx-editor');
  await editor.getByLabel('Payee').fill('Comma Shop');
  const outflow = editor.getByLabel('Outflow');
  await outflow.fill('12,5');
  await win.keyboard.press('Enter');
  await expect(outflow).toHaveClass(/bad/);
  await expect(editor).toHaveCount(1);
  await outflow.fill('12,50');
  await win.keyboard.press('Enter');
  await expect(editor).toHaveCount(0);
  const saved = await savedBudget(fx, win);
  const t = Object.values(saved.transactions).find((x) => saved.payees[x.payeeId ?? '']?.name === 'Comma Shop');
  expect(t?.amount).toBe(-1250);

  // Reconcile waits for a statement balance it can read, rather than finishing without one.
  await win.getByRole('button', { name: /Reconcile Account/ }).click();
  await win.locator('.modal').getByRole('button', { name: 'No' }).click();
  await win.getByLabel('Statement balance').fill('12,5');
  await expect(win.locator('.modal .btn.primary')).toBeDisabled();
  await win.getByLabel('Statement balance').fill('987.50');
  await expect(win.locator('.modal .btn.primary')).toBeEnabled();
  await win.keyboard.press('Escape');
  await expect(win.locator('.modal')).toHaveCount(0);
  await app.close();
});

test('1.4.4: old bank files teach accounts their numbers, and the next import picks the account', async () => {
  const fx = makeFixture();
  const b = fx.budget;
  b.importedFrom = 'YNAB4';
  // Four rows of an old download, imported in YNAB4's day.
  const dates = [-40, -39, -38, -37].map((n) => addDays(today(), n));
  dates.forEach((date, i) => saveTransaction(b, { accountId: fx.ids.current, date, amount: -(i + 1) * 100, cleared: 'C', importIds: [`FITID:OLD${i}`] }));
  writeFileSync(fx.file, serializeBudget(b));
  const ofx = (name: string, rows: [string, string][]) => {
    const file = path.join(fx.dir, name);
    const trn = rows.map(([date, id], i) => `<STMTTRN><DTPOSTED>${date.replace(/-/g, '')}<TRNAMT>-${i + 1}.00<FITID>${id}<NAME>SHOP</STMTTRN>`).join('');
    writeFileSync(file, `<OFX><BANKACCTFROM><BANKID>0<ACCTID>****12345</BANKACCTFROM>${trn}</OFX>`);
    return file;
  };
  const old = ofx('old download.ofx', dates.map((d, i) => [d, `OLD${i}`]));
  const other = writeQif(fx, 'other budget.qif', 'Bank', [['ELSEWHERE', '-9.00']]);
  const fresh = ofx('new download.ofx', [[today(), 'NEW0']]);
  const { app, win } = await launch(fx, { bank: [old, other] });
  await win.locator('.sb-nav-btn', { hasText: 'Settings' }).click();
  await win.getByRole('button', { name: 'Learn accounts from old bank files…' }).click();
  const modal = win.locator('.modal');
  await modal.getByRole('button', { name: 'Choose files…' }).click();
  await expect(modal).toContainText('4 of 4 rows already imported here');
  await expect(modal).toContainText('none of its rows are in this budget');
  await expect(modal.getByLabel('Learn from old download.ofx')).toBeChecked();
  await modal.getByRole('button', { name: 'Learn from 1 file' }).click();
  await expect(modal).toHaveCount(0);
  const saved = await savedBudget(fx, win);
  expect(saved.accounts[fx.ids.current].importKeys).toContain('ofx:0:****12345');
  // Nothing but the keys changed.
  expect(Object.keys(saved.transactions).length).toBe(Object.keys(b.transactions).length);
  expect(readdirSync(path.join(fx.dir, 'userdata', 'backups'), { recursive: true }).some((n) => String(n).includes('before-learn_'))).toBe(true);
  await app.close();

  // The next download from that account goes to it by itself, even opened from another register.
  const again = await launch(fx, { bank: [fresh] });
  await again.win.locator('.sidebar .acc-row', { hasText: 'Savings' }).click();
  await again.win.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(again.win.locator('.modal-title')).toContainText('new download.ofx');
  await expect(again.win.locator('.modal').getByLabel('Account', { exact: true })).toHaveValue('Current Account');
  await again.app.close();
});

test('1.4.5: deleting a category with history asks where it goes, with no default', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  // Rent has a budgeted amount this month.
  const rent = win.locator(`.crow.cat[data-cat="${fx.ids.rent}"]`);
  await rent.hover();
  await rent.locator('.row-btn').click();
  await win.getByRole('menuitem', { name: 'Delete…' }).click();
  const dialog = win.locator('.modal', { hasText: 'Where should they go?' });
  const del = dialog.getByRole('button', { name: 'Delete category' });
  await expect(del).toBeDisabled();
  await expect(dialog.locator('select option', { hasText: 'Income for' })).toHaveCount(0);
  await dialog.locator('select').selectOption({ label: '(No category)' });
  await expect(del).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect((await savedBudget(fx, win)).categories[fx.ids.rent]).toBeDefined();
  await app.close();
});

test('1.4.5: reaching the budget grid with Tab selects its first category', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  await expect(win.locator('.crow.cat.sel')).toHaveCount(0);
  for (let i = 0; i < 25 && !(await win.evaluate(() => document.activeElement?.classList.contains('budget-scroll'))); i++) await win.keyboard.press('Tab');
  await expect(win.locator('.budget-scroll')).toBeFocused();
  await expect(win.locator('.crow.cat.sel')).toHaveCount(1);
  await win.keyboard.press('ArrowDown');
  await expect(win.locator('.crow.cat.sel')).toHaveCount(1);
  await app.close();
});

test('1.5: Available to Budget collapses the month headings, and "Income for" lists that income', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  const head = win.locator('.msum').first();
  await expect(head.locator('.msum-lines')).toBeVisible();
  // Nothing is budgeted in a later month, so that line isn't shown.
  await expect(head).not.toContainText('Budgeted in future');
  await head.locator('button.msum-atb').click();
  await expect(win.locator('.msum-lines')).toHaveCount(0);
  await expect(head.locator('.atb-amt')).toHaveText('= £900.00');
  await head.locator('button.msum-atb').click();
  await expect(head.locator('.msum-lines')).toBeVisible();
  // The starting balances of Current Account and Savings are this month's income.
  await head.getByRole('button', { name: /^Income for/ }).click();
  const pop = win.locator('.popover');
  await expect(pop).toContainText('Income for');
  await expect(pop.locator('tfoot')).toContainText('£1,500.00');
  await pop.getByRole('button', { name: 'Open in register' }).click();
  await expect(win.locator('.rrow')).toHaveCount(2);
  await app.close();
});

test('1.5: the register search looks in one field with "Payee:" or "Memo:"', async () => {
  const fx = makeFixture();
  const b = fx.budget;
  saveTransaction(b, { accountId: fx.ids.current, date: today(), payeeName: 'Tesco', memo: 'milk', amount: -250, cleared: 'C' });
  saveTransaction(b, { accountId: fx.ids.current, date: today(), payeeName: 'Cinema', memo: 'Tesco voucher', amount: -1200, cleared: 'C' });
  writeFileSync(fx.file, serializeBudget(b));
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  const search = win.getByLabel('Search transactions');
  await search.fill('tesco');
  await expect(win.locator('.rrow')).toHaveCount(2);
  await search.fill('payee: tesco');
  await expect(win.locator('.rrow')).toHaveCount(1);
  await expect(win.locator('.rrow')).toContainText('Tesco');
  await search.fill('memo: tesco');
  await expect(win.locator('.rrow')).toHaveCount(1);
  await expect(win.locator('.rrow')).toContainText('Cinema');
  await app.close();
});

test('1.5: Reconcile counts and locks only what cleared by the statement date', async () => {
  const fx = makeFixture();
  const b = fx.budget;
  const early = saveTransaction(b, { accountId: fx.ids.current, date: addDays(today(), -20), payeeName: 'Before', amount: -10000, cleared: 'C' });
  const late = saveTransaction(b, { accountId: fx.ids.current, date: today(), payeeName: 'After', amount: -5000, cleared: 'C' });
  writeFileSync(fx.file, serializeBudget(b));
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: /Reconcile Account/ }).click();
  await win.getByRole('button', { name: 'No' }).click();
  // The statement box has the keyboard; moving to the date box without typing a balance leaves
  // the balance following the cleared balance at the statement date.
  const statementDate = addDays(today(), -10);
  const date = win.locator('.modal').getByLabel('Date', { exact: true });
  await date.click();
  await date.fill(formatDate(statementDate));
  await date.press('Tab');
  await expect(win.locator('.modal .insp-stats')).toContainText(`up to ${formatDate(statementDate)}`);
  await expect(win.locator('.modal .btn.primary')).toHaveText('Finish reconciling');
  await win.waitForTimeout(500);
  await win.locator('.modal .btn.primary').click();
  await expect(win.locator('.modal')).toHaveCount(0);
  const saved = await savedBudget(fx, win);
  expect(saved.transactions[early].cleared).toBe('R');
  expect(saved.transactions[late].cleared).toBe('C');
  expect(Object.values(saved.transactions).some((t) => t.memo === 'Entered automatically by reconciliation')).toBe(false);
  expect(saved.accounts[fx.ids.current].lastReconciledDate).toBe(statementDate);
  await app.close();
});
test('1.5.1: Reconcile waits for a statement date it can read, and explains a future-dated cleared row', async () => {
  const fx = makeFixture();
  const b = fx.budget;
  // A post-dated cheque already marked cleared: the register's header counts it, the question doesn't.
  saveTransaction(b, { accountId: fx.ids.current, date: addDays(today(), 5), payeeName: 'Later', amount: -2000, cleared: 'C' });
  writeFileSync(fx.file, serializeBudget(b));
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: /Reconcile Account/ }).click();
  await expect(win.locator('.modal')).toContainText('also counts -£20.00 marked cleared but dated after today');
  await win.getByRole('button', { name: 'No' }).click();
  const date = win.locator('.modal').getByLabel('Date', { exact: true });
  const finish = win.locator('.modal .btn.primary');
  await date.click();
  await date.fill('31/09/2026');
  await date.press('Tab');
  await expect(finish).toBeDisabled();
  await expect(win.locator('.modal .hint')).toContainText("can't be read");
  await date.fill(formatDate(today()));
  await date.press('Tab');
  await expect(finish).toBeEnabled();
  // Enter on the button straight after the date change isn't swallowed by the click guard.
  await finish.focus();
  await win.keyboard.press('Enter');
  await expect(win.locator('.modal')).toHaveCount(0);
  await app.close();
});

test('1.5.1: Print previews what is on screen, saves a PDF with page numbers, and Ctrl+E saves a CSV', async () => {
  const fx = makeFixture();
  const pdf = path.join(fx.dir, 'printout.pdf');
  const csvFile = path.join(fx.dir, 'register.csv');
  const { app, win } = await launch(fx, { pdf, saveText: csvFile });
  // The budget: the month the Inspector shows.
  await win.keyboard.press('Control+p');
  const preview = win.locator('.modal.print-preview');
  await expect(preview).toContainText(`Print: Budget: ${monthLabel(thisMonth())}`);
  const page = win.frameLocator('.print-frame');
  await expect(page.locator('h1')).toHaveText(`Budget: ${monthLabel(thisMonth())}`);
  await expect(page.locator('.summary tr.strong')).toContainText('Available to Budget');
  await preview.getByRole('button', { name: 'Save as PDF…' }).click();
  await expect(preview).toHaveCount(0);
  await expect.poll(() => existsSync(pdf)).toBe(true);
  expect(readFileSync(pdf).subarray(0, 5).toString()).toBe('%PDF-');
  // A register, by Ctrl+E: the rows as shown, amounts as numbers.
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.locator('.rrow').first().waitFor();
  await win.keyboard.press('Control+e');
  // The file appears before its text is written: wait for the text.
  await expect.poll(() => (existsSync(csvFile) ? readFileSync(csvFile, 'utf8') : '')).toContain('Register: Current Account');
  const csv = readFileSync(csvFile, 'utf8');
  expect(csv).toContain('Register: Current Account');
  expect(csv).toContain('Date,Payee,Category,Memo,Outflow,Inflow,Balance,C');
  // The menus offer both, and a report prints as its table.
  await win.locator('.sidebar').getByText('Reports').click();
  await win.locator('.tb-menu-btn[data-menu="File"]').click();
  await win.getByRole('menuitem', { name: /Print…/ }).click();
  await expect(win.frameLocator('.print-frame').locator('h1')).toHaveText(/Spending|Income v Expense|Net Worth|Spending Trends/);
  await win.keyboard.press('Escape');
  await expect(win.locator('.modal')).toHaveCount(0);
  await app.close();
});

test('1.5.2: Ctrl+P while a budget cell is being typed in prints the typed figure', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  const row = win.locator(`.brow:has([data-cat="${fx.ids.groceries}"])`);
  await row.locator('.cell.budgeted').first().click();
  await win.keyboard.type('77');
  await win.keyboard.press('Control+p');
  const groceries = win.frameLocator('.print-frame').locator('table.t tr', { hasText: 'Groceries' });
  await expect(groceries).toContainText('£77.00');
  await win.keyboard.press('Escape');
  await expect(row.locator('.cell.budgeted').first()).toHaveText('£77.00');
  await app.close();
});

test('1.5.2 draft: a report prints with its chart, in light colours', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  // The app's own dark theme (View > Theme), which the reports' colours follow on screen.
  await win.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await win.locator('.sidebar').getByText('Reports').click();
  await win.getByRole('tab', { name: 'Income v Expense', exact: true }).click();
  await win.locator('.rp-body svg.rp-svg').waitFor();
  // On screen, the dark palette.
  expect(await win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--rp-c1').trim())).toBe('#3987e5');
  await win.keyboard.press('Control+p');
  const page = win.frameLocator('.print-frame');
  await expect(page.locator('.chart svg path').first()).toBeAttached();
  await expect(page.locator('.legend')).toContainText('Income');
  // The page's own palette, not the dark theme's.
  const fill = await page.locator('.legend .sw').first().evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(fill).toBe('rgb(42, 120, 214)');
  await win.keyboard.press('Escape');
  await app.close();
});

test('1.5.2 draft: Shift+A approves and moves to the next unapproved row; the search box clears with its button', async () => {
  const fx = makeFixture();
  const b = fx.budget;
  const ids = ['First', 'Second', 'Third'].map((p, i) =>
    saveTransaction(b, { accountId: fx.ids.current, date: addDays(today(), -10 + i), payeeName: p, amount: -100 * (i + 1), cleared: 'U' }),
  );
  for (const id of [ids[0], ids[2]]) b.transactions[id].accepted = false;
  writeFileSync(fx.file, serializeBudget(b));
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.locator('.rrow', { hasText: 'First' }).click();
  await win.keyboard.press('Shift+A');
  // "Second" is approved already, so the selection jumps to "Third".
  await expect(win.locator('.rrow.selected')).toContainText('Third');
  await win.keyboard.press('Shift+A');
  await expect(win.locator('.toast')).toContainText('Nothing else here is waiting for approval');
  const saved = await savedBudget(fx, win);
  expect(ids.map((id) => saved.transactions[id].accepted)).toEqual([true, true, true]);
  const search = win.getByLabel('Search transactions');
  await search.fill('is: uncleared outflow:');
  await expect(win.locator('.rrow', { hasText: 'Second' })).toBeVisible();
  await win.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toHaveValue('');
  await app.close();
});

test('1.5.2 draft: a chart is redrawn at page width for printing, then given its size back', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  await win.locator('.sidebar').getByText('Reports').click();
  await win.getByRole('tab', { name: 'Net Worth', exact: true }).click();
  const screen = win.locator('.rp-body svg.rp-svg');
  await screen.waitFor();
  const before = await screen.getAttribute('width');
  await win.keyboard.press('Control+p');
  // Net Worth prints upright: 700 wide.
  await expect(win.frameLocator('.print-frame').locator('.chart svg')).toHaveAttribute('width', '700');
  await win.keyboard.press('Escape');
  await expect(win.locator('body')).not.toHaveClass(/print-sizing/);
  await expect(screen).toHaveAttribute('width', before!);
  await app.close();
});

test('1.5.2 draft: after Ctrl+E the register keeps the keyboard; a hovered month isn\'t printed', async () => {
  const fx = makeFixture();
  for (const p of ['One', 'Two']) saveTransaction(fx.budget, { accountId: fx.ids.current, date: addDays(today(), -3), payeeName: p, amount: -500, cleared: 'U' });
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const csvFile = path.join(fx.dir, 'r.csv');
  const { app, win } = await launch(fx, { saveText: csvFile });
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  const rows = win.locator('.rrow');
  await rows.first().click();
  await win.keyboard.press('Control+e');
  await expect.poll(() => (existsSync(csvFile) ? readFileSync(csvFile, 'utf8') : '')).toContain('Register');
  // The arrow keys still move the selection.
  const before = await win.locator('.rrow.selected').textContent();
  await win.keyboard.press('ArrowDown');
  await expect(win.locator('.rrow.selected')).not.toHaveText(before!);
  // Net Worth with the pointer over a month: that month's band is drawn on screen, not on paper.
  await win.locator('.sidebar').getByText('Reports').click();
  await win.getByRole('tab', { name: 'Net Worth', exact: true }).click();
  const svg = win.locator('.rp-body svg.rp-svg');
  await svg.hover();
  await expect(win.locator('.rp-body .rp-band')).toHaveCount(1);
  await win.keyboard.press('Control+p');
  const page = win.frameLocator('.print-frame');
  await expect(page.locator('.chart svg')).toBeAttached();
  await expect(page.locator('.chart .rp-band')).toHaveCount(0);
  const radii = await page.locator('.chart circle').evaluateAll((cs) => [...new Set(cs.map((c) => c.getAttribute('r')))]);
  expect(radii.length).toBeLessThanOrEqual(1);
  await win.keyboard.press('Escape');
  await app.close();
});

test('1.5.3: an unreadable date stops the save, a cleared box stays empty, and Move waits for a choice', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Add a new transaction' }).click();
  const editor = win.locator('.tx-editor');
  // S2: typed, cleared, then Tab: the payee stays empty instead of "Transfer : …".
  const payee = win.getByLabel('Payee');
  await payee.fill('Shop');
  await payee.fill('');
  await win.keyboard.press('Tab');
  await expect(payee).toHaveValue('');
  // S1: an unreadable date stops the save and says so.
  await payee.fill('Date Check Shop');
  await win.keyboard.press('Tab');
  await win.getByLabel('Outflow').fill('5');
  const date = editor.getByLabel('Date', { exact: true });
  await date.fill('31/9');
  await date.press('Enter');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("A date couldn't be read");
  await expect(win.locator('.rrow', { hasText: 'Date Check Shop' })).toHaveCount(0);
  await date.fill(formatDate(today()));
  await date.press('Enter');
  await expect(win.locator('.rrow', { hasText: 'Date Check Shop' })).toHaveCount(1);
  // S3: Move: typing part of a name, then closing, moves nothing.
  await win.locator('.rrow', { hasText: 'Date Check Shop' }).click();
  await win.locator('.rrow', { hasText: 'Starting Balance' }).click({ modifiers: ['Control'] });
  await win.getByRole('button', { name: 'More ▾' }).click();
  await win.getByRole('menuitem', { name: 'Move to another account…' }).click();
  await win.locator('.modal').getByPlaceholder('Choose an account').fill('s');
  await win.locator('.modal .modal-title').getByRole('button').click();
  await expect(win.locator('.modal')).toHaveCount(0);
  await expect(win.locator('.rrow', { hasText: 'Date Check Shop' })).toHaveCount(1);
  await app.close();
});

test('1.5.3: leaving a register mid-entry saves the transaction; Ctrl+T in a budget cell keeps the figure', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  // S6: a figure typed in a budget cell, then Ctrl+T straight away.
  const row = win.locator(`.brow:has([data-cat="${fx.ids.groceries}"])`);
  await row.locator('.cell.budgeted').first().click();
  await win.keyboard.type('42');
  await win.keyboard.press('Control+t');
  await expect(win.locator('.reg-title h1')).toContainText('All accounts');
  // S7: a transaction half entered, then the Budget screen from the sidebar.
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Add a new transaction' }).click();
  await win.getByLabel('Payee').fill('Left Behind Cafe');
  await win.keyboard.press('Tab');
  await win.getByLabel('Outflow').fill('3.20');
  await win.locator('.sidebar').getByText('Budget').first().click();
  await expect(win.locator('.toast')).toContainText('was saved when you left it');
  const saved = await savedBudget(fx, win);
  expect(Object.values(saved.transactions).some((t) => t.amount === -320)).toBe(true);
  const month = (saved.months as Record<string, Record<string, { budgeted: number }>>)[thisMonth()];
  expect(month?.[fx.ids.groceries]?.budgeted).toBe(4200);
  await app.close();
});

test('1.5.3: a budget file replaced by "Save a copy as…" is backed up first', async () => {
  const fx = makeFixture();
  // Another budget already at the place the copy is saved to.
  const other = path.join(fx.dir, 'Other.budget');
  const otherBudget = newBudget('Other');
  writeFileSync(other, serializeBudget(otherBudget));
  const { app, win } = await launch(fx, { save: other });
  await win.locator('.tb-menu-btn[data-menu="File"]').click();
  await win.getByRole('menuitem', { name: 'Save a copy as…' }).click();
  const backups = path.join(fx.dir, 'userdata', 'backups', otherBudget.id);
  await expect.poll(() => (existsSync(backups) ? readdirSync(backups).filter((n) => n.startsWith('before-replace_')).length : 0)).toBe(1);
  await app.close();
});

test("night seven: leaving the editor doesn't save past a box in red, an empty new row, or over a changed transaction", async () => {
  const fx = makeFixture();
  saveTransaction(fx.budget, { accountId: fx.ids.current, date: today(), transferAccountId: fx.ids.savings, amount: -7000, memo: 'Pair', cleared: 'U' });
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const { app, win } = await launch(fx);
  const budgetScreen = () => win.locator('.sidebar').getByText('Budget').first().click();
  // An amount in red, then the Budget screen: nothing saved, and it says why.
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Add a new transaction' }).click();
  await win.getByLabel('Payee').fill('Red Box Shop');
  await win.keyboard.press('Tab');
  await win.getByLabel('Outflow').fill('12,5');
  await budgetScreen();
  await expect(win.locator('.toast').last()).toContainText("wasn't saved: an amount couldn't be read");
  // A payee typed halfway, with no amount: not saved, so no new payee either.
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Add a new transaction' }).click();
  await win.getByLabel('Payee').fill('Half Typ');
  await budgetScreen();
  await expect(win.locator('.toast').last()).toContainText('it had no amount');
  // A transfer edited, then its other side opened without saving: the other side shows the
  // change, and saving it doesn't put the old amount back.
  await win.keyboard.press('Control+t');
  await expect(win.locator('.reg-title h1')).toContainText('All accounts');
  await win.locator('.rrow', { hasText: 'Transfer : Savings' }).first().dblclick();
  await win.locator('.tx-editor').getByLabel('Outflow').fill('80');
  await win.locator('.rrow', { hasText: 'Transfer : Current Account' }).first().dblclick();
  await expect(win.locator('.toast').last()).toContainText('saved when you left it');
  const other = win.locator('.tx-editor');
  await expect(other.getByLabel('Inflow')).toHaveValue(/^80(\.00)?$/);
  await other.getByLabel('Memo').fill('Pair, checked');
  await other.getByLabel('Memo').press('Enter');
  await expect(win.locator('.tx-editor')).toHaveCount(0);
  const saved = await savedBudget(fx, win);
  const pair = Object.values(saved.transactions).filter((t) => t.transferAccountId && (t.accountId === fx.ids.current || t.accountId === fx.ids.savings));
  expect(pair.map((t) => t.amount).sort((x, y) => x - y)).toEqual([-8000, 8000]);
  expect(Object.values(saved.payees).some((p) => /Red Box|Half Typ/.test(p.name))).toBe(false);
  expect(Object.values(saved.transactions).some((t) => t.amount === -1250 || t.amount === -125000)).toBe(false);
  await app.close();
});

test('night seven: closing with a transaction that can\'t be saved asks; Approve while editing still saves the edit', async () => {
  const fx = makeFixture();
  saveTransaction(fx.budget, { accountId: fx.ids.current, date: today(), payeeName: 'Waiting Shop', amount: -1500, cleared: 'C', accepted: false });
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  // Approving all while one row's editor has a change: leaving still saves that change.
  await win.locator('.rrow', { hasText: 'Waiting Shop' }).dblclick();
  await win.locator('.tx-editor').getByLabel('Memo').fill('Edited before approving');
  await win.getByRole('button', { name: /^Approve 1/ }).click();
  await win.locator('.sidebar').getByText('Budget').first().click();
  await expect(win.locator('.toast').last()).toContainText('saved when you left it');
  // Closing with an amount that can't be read: asked, and staying keeps the editor.
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Add a new transaction' }).click();
  await win.getByLabel('Payee').fill('Close Test Shop');
  await win.keyboard.press('Tab');
  await win.getByLabel('Outflow').fill('12,5');
  const closeWindow = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const question = win.locator('.modal', { hasText: "A transaction you were entering isn't saved" });
  await closeWindow();
  await expect(question).toBeVisible();
  await expect(question).toContainText("an amount couldn't be read");
  await question.getByRole('button', { name: 'Keep the app open' }).click();
  await expect(win.locator('.tx-editor')).toBeVisible();
  const saved = await savedBudget(fx, win);
  const row = Object.values(saved.transactions).find((t) => t.amount === -1500)!;
  expect(row.memo).toBe('Edited before approving');
  expect(row.accepted).toBe(true);
  const closed = app.waitForEvent('close');
  await closeWindow();
  await Promise.all([closed, question.getByRole('button', { name: 'Close without it' }).click().catch(() => {})]);
});

test('night seven: a red amount typed over an otherwise unchanged row is reported, not dropped', async () => {
  const fx = makeFixture();
  saveTransaction(fx.budget, { accountId: fx.ids.current, date: today(), payeeName: 'Only Amount Shop', amount: -1000, cleared: 'C' });
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.locator('.rrow', { hasText: 'Only Amount Shop' }).dblclick();
  await win.locator('.tx-editor').getByLabel('Outflow').fill('12,5');
  await win.locator('.sidebar').getByText('Budget').first().click();
  await expect(win.locator('.toast').last()).toContainText("weren't saved: an amount couldn't be read");
  const saved = await savedBudget(fx, win);
  expect(Object.values(saved.transactions).find((t) => t.amount === -1000)).toBeTruthy();
  await app.close();
});

/**
 * Asks the app's window, as Windows does at shutdown, whether the session may end. Only the window
 * is asked: nothing else on the computer is shut down. Answers true if it may end now.
 */
async function askToEndSession(app: ElectronApplication): Promise<boolean> {
  const hwnd = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE(0).toString());
  const ps =
    "Add-Type -Namespace W -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'; " +
    `[W.U]::SendMessage([IntPtr]([long]${hwnd}), 0x11, [IntPtr]::Zero, [IntPtr]::Zero)`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  return Number(out.trim()) !== 0;
}

test('night seven: Windows shutting down waits only when something is unsaved', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  await expect(win.locator('.tb-save')).toHaveText(/Saved/, { timeout: 10_000 });
  // Everything saved: Windows may carry on straight away (1.5.3 always held it).
  expect(await askToEndSession(app)).toBe(true);
  expect(win.isClosed()).toBe(false);

  // A budget cell being typed in: Windows is held while it's saved, and then the app closes.
  const row = win.locator(`.brow:has([data-cat="${fx.ids.groceries}"])`);
  await row.locator('.cell.budgeted').first().click();
  await win.keyboard.type('45');
  await win.waitForTimeout(300);
  const closed = app.waitForEvent('close');
  expect(await askToEndSession(app)).toBe(false);
  await closed;
  expect((JSON.parse(readFileSync(fx.file, 'utf8')) as Budget).months[thisMonth()][fx.ids.groceries].budgeted).toBe(4500);
});

test('night seven: a transaction being entered is saved when Windows shuts down', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Add a new transaction' }).click();
  await win.getByLabel('Payee').fill('Shutdown Shop');
  await win.keyboard.press('Tab');
  await win.getByLabel('Outflow').fill('7.25');
  await win.waitForTimeout(300);
  const closed = app.waitForEvent('close');
  expect(await askToEndSession(app)).toBe(false);
  await closed;
  const saved = JSON.parse(readFileSync(fx.file, 'utf8')) as Budget;
  expect(Object.values(saved.transactions).find((t) => t.amount === -725)).toBeTruthy();
});

test('1.5.6: Match, as in YNAB4: a typed row and a bank row become one, and Unmatch splits them', async () => {
  const fx = makeFixture();
  const d = today();
  saveTransaction(fx.budget, { accountId: fx.ids.current, date: d, payeeName: 'Alex', amount: -70000, categoryId: fx.ids.rent, cleared: 'U' });
  saveTransaction(fx.budget, { accountId: fx.ids.current, date: d, payeeName: 'A N OTHER', importedPayee: 'A N OTHER', amount: -70000, categoryId: fx.ids.groceries, cleared: 'C', accepted: false, importIds: [`YNAB:-700.00:${d}:1`] });
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.locator('.rrow', { hasText: 'Alex' }).click();
  await win.locator('.rrow', { hasText: 'A N OTHER' }).click({ modifiers: ['Control'] });
  await win.locator('.rrow', { hasText: 'A N OTHER' }).click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Match', exact: true }).click();
  await expect(win.locator('.toast').last()).toContainText('Matched');
  // One transaction, shown with its "Bank:" and "Yours:" lines until it's approved (YNAB4).
  await expect(win.locator('.rrow:not(.matchline)', { hasText: '700.00' })).toHaveCount(1);
  await expect(win.locator('.rrow.matchline.bank')).toContainText('A N OTHER');
  await expect(win.locator('.rrow.matchline.yours')).toContainText('Alex');
  const saved = await savedBudget(fx, win);
  const rows = Object.values(saved.transactions).filter((t) => t.amount === -70000);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ categoryId: fx.ids.rent, cleared: 'C', accepted: false, importIds: [`YNAB:-700.00:${d}:1`] });
  // Unmatch puts the bank's row back as its own transaction.
  await win.locator('.rrow:not(.matchline)', { hasText: 'Alex' }).click({ button: 'right' });
  await win.getByRole('menuitem', { name: 'Unmatch' }).click();
  await expect(win.locator('.rrow:not(.matchline)', { hasText: '700.00' })).toHaveCount(2);
  await expect(win.locator('.rrow.matchline')).toHaveCount(0);
  await app.close();
});

test('1.5.7: "Save, next without category" (Shift+Enter) opens the next row that needs one', async () => {
  const fx = makeFixture();
  const d = today();
  for (const [name, amount] of [['First Shop', -1100], ['Second Shop', -2200], ['Third Shop', -3300]] as const) {
    saveTransaction(fx.budget, { accountId: fx.ids.current, date: d, payeeName: name, amount, categoryId: null, cleared: 'C' });
  }
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.locator('.rrow', { hasText: 'First Shop' }).dblclick();
  const editor = win.locator('.tx-editor');
  await expect(editor.getByRole('button', { name: 'Save, next without category' })).toBeVisible();
  await editor.getByLabel('Category').fill('Groc');
  await win.keyboard.press('Enter');
  await win.keyboard.press('Shift+Enter');
  // The first is saved, and the editor is open on another row still without a category.
  await expect(win.locator('.rrow', { hasText: 'First Shop' })).toContainText('Groceries');
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('Payee')).toHaveValue(/Second Shop|Third Shop/);
  await editor.getByLabel('Category').fill('Groc');
  await win.keyboard.press('Enter');
  await editor.getByRole('button', { name: 'Save, next without category' }).click();
  await expect(editor.getByLabel('Payee')).toHaveValue(/Second Shop|Third Shop/);
  // The last one: no "next" left to offer.
  await expect(editor.getByRole('button', { name: 'Save, next without category' })).toHaveCount(0);
  await app.close();
});

test('1.5.7: an "Already imported" row in the review says where it is and can\'t be ticked', async () => {
  const fx = makeFixture();
  const d = today();
  saveTransaction(fx.budget, { accountId: fx.ids.current, date: d, payeeName: 'Bank Shop', amount: -4200, categoryId: fx.ids.groceries, cleared: 'C', importIds: [`YNAB:-42.00:${d}:1`] });
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const qif = path.join(fx.dir, 'again.qif');
  const [y, m, dd] = d.split('-');
  writeFileSync(qif, `!Type:Bank\nD${dd}/${m}/${y}\nT-42.00\nPBank Shop\n^\n`);
  const { app, win } = await launch(fx, { bank: qif });
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.keyboard.press('Control+i');
  const review = win.locator('.modal');
  await review.getByRole('checkbox', { name: 'Show already imported' }).check().catch(async () => {
    await review.getByText('Show already imported').click();
  });
  const row = review.locator('tr', { hasText: 'Already imported' });
  await expect(row).toContainText(formatDate(d));
  await expect(row.getByRole('checkbox', { name: 'Include' })).toBeDisabled();
  await app.close();
});

test('1.5.7: an existing transaction can be made to repeat; its schedule starts after today', async () => {
  const fx = makeFixture();
  const old = addMonths(thisMonth(), -2) + '-15';
  saveTransaction(fx.budget, { accountId: fx.ids.current, date: old, payeeName: 'Gym', amount: -3000, categoryId: fx.ids.groceries, cleared: 'C' });
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.locator('.rrow', { hasText: 'Gym' }).dblclick();
  const editor = win.locator('.tx-editor');
  await editor.getByLabel('Repeat').selectOption('Monthly');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(win.locator('.toast').last()).toContainText('Scheduled: it repeats from');
  const saved = await savedBudget(fx, win);
  const sched = Object.values(saved.scheduled);
  expect(sched).toHaveLength(1);
  expect(sched[0]).toMatchObject({ amount: -3000, frequency: 'Monthly', categoryId: fx.ids.groceries });
  // The first 15th after today: this month's if it's still to come (1.5.9: it skipped a month).
  expect(sched[0].date).toBe(today() < thisMonth() + '-15' ? thisMonth() + '-15' : addMonths(thisMonth(), 1) + '-15');
  // The transaction is still there, and nothing was entered for the months in between.
  expect(Object.values(saved.transactions).filter((t) => t.amount === -3000)).toHaveLength(1);
  // Doing it again warns that there's a schedule like it already (1.5.9).
  await win.locator('.rrow', { hasText: 'Gym' }).dblclick();
  await editor.getByLabel('Repeat').selectOption('Monthly');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(win.locator('.toast').last()).toContainText('there was already a schedule like it');
  await app.close();
});

test('1.5.10: a scheduled transfer, seen from its other account, can’t be repeated twice unawares', async () => {
  const fx = makeFixture();
  const day6 = (m: string) => m + '-06';
  // A monthly transfer scheduled in Current Account, and last month's, entered by it.
  const sid = saveScheduled(fx.budget, { accountId: fx.ids.current, date: day6(addMonths(thisMonth(), 1)), startDate: day6(addMonths(thisMonth(), -1)), frequency: 'Monthly', transferAccountId: fx.ids.savings, categoryId: null, amount: -40000 });
  saveTransaction(fx.budget, { accountId: fx.ids.current, transferAccountId: fx.ids.savings, date: day6(addMonths(thisMonth(), -1)), amount: -40000, cleared: 'C', memo: 'entered', scheduleId: sid });
  // The same transfer typed in Savings by hand, before the schedule was made.
  saveTransaction(fx.budget, { accountId: fx.ids.savings, transferAccountId: fx.ids.current, date: day6(addMonths(thisMonth(), -2)), amount: 40000, cleared: 'C', memo: 'typed' });
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Savings' }).click();
  const editor = win.locator('.tx-editor');
  // The scheduler's own transfer: its Savings side has no Repeat, as its schedule is there.
  await win.locator('.rrow:not(.matchline)', { hasText: 'entered' }).dblclick();
  await expect(editor.getByLabel('Payee')).toBeVisible();
  await expect(editor.getByLabel('Repeat')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Cancel' }).click();
  // The typed one can repeat, but it says there's a schedule like it in Current Account.
  await win.locator('.rrow:not(.matchline)', { hasText: 'typed' }).dblclick();
  await editor.getByLabel('Repeat').selectOption('Monthly');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(win.locator('.toast').last()).toContainText('there was already a schedule like it');
  await app.close();
});

test('1.5.7: in a budget cell, "-20" takes 20 off what is there', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  const row = win.locator(`.brow:has([data-cat="${fx.ids.rent}"])`);
  await expect(row.locator('.cell.budgeted').first()).toHaveText('£600.00');
  await row.locator('.cell.budgeted').first().click();
  await win.keyboard.type('-20');
  await win.keyboard.press('Enter');
  await expect(row.locator('.cell.budgeted').first()).toHaveText('£580.00');
  // 1.5.10: a negative amount shows as "(50.00)", so going in and out of it leaves it alone, and
  // changing the number in it sets that number (it used to take it off again).
  await row.locator('.cell.budgeted').first().click();
  await win.keyboard.type('(50)');
  await win.keyboard.press('Enter');
  await expect(row.locator('.cell.budgeted').first()).toHaveText(/^[-−]£50\.00$/);
  await row.locator('.cell.budgeted').first().click();
  await expect(row.locator('.cell.budgeted input')).toHaveValue('(50.00)');
  await win.keyboard.press('Enter');
  await expect(row.locator('.cell.budgeted').first()).toHaveText(/^[-−]£50\.00$/);
  await row.locator('.cell.budgeted').first().click();
  await win.keyboard.press('Tab');
  await expect(row.locator('.cell.budgeted').first()).toHaveText(/^[-−]£50\.00$/);
  // 1.5.11: adding on to the end of "(50.00)" works on the amount there: -50 + 10 is -40.
  await row.locator('.cell.budgeted').first().click();
  await win.keyboard.press('End');
  await win.keyboard.type('+10');
  await win.keyboard.press('Enter');
  await expect(row.locator('.cell.budgeted').first()).toHaveText(/^[-−]£40\.00$/);
  await app.close();
});

test('1.5.8: "Save and add another" starts the next transaction on the same date', async () => {
  const fx = makeFixture();
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Add a new transaction' }).click();
  const editor = win.locator('.tx-editor');
  const day = addDays(today(), -3);
  const date = editor.getByLabel('Date', { exact: true });
  await date.fill(formatDate(day));
  await date.press('Tab');
  await editor.getByLabel('Payee').fill('Market Stall');
  await win.keyboard.press('Tab');
  await editor.getByLabel('Outflow').fill('4');
  await editor.getByRole('button', { name: 'Save and add another' }).click();
  await expect(win.locator('.rrow', { hasText: 'Market Stall' })).toHaveCount(1);
  await expect(editor.getByLabel('Date', { exact: true })).toHaveValue(formatDate(day));
  // And again with Ctrl+Enter.
  await editor.getByLabel('Payee').fill('Second Stall');
  await win.keyboard.press('Tab');
  await editor.getByLabel('Outflow').fill('5');
  await editor.getByLabel('Outflow').press('Control+Enter');
  await expect(win.locator('.rrow', { hasText: 'Second Stall' })).toContainText(formatDate(day));
  await expect(editor.getByLabel('Date', { exact: true })).toHaveValue(formatDate(day));
  await app.close();
});

test('1.5.11: the import review says which row a transfer takes over, and "Don\'t pair" keeps it', async () => {
  const fx = makeFixture();
  const b = fx.budget;
  const saverPayee = Object.values(b.payees).find((p) => p.transferAccountId === fx.ids.savings)!;
  saverPayee.rules = [{ op: 'contains', text: 'TFR SAVINGS' }];
  // Savings' own bank row, already approved in Groceries.
  saveTransaction(b, { accountId: fx.ids.savings, date: today(), payeeName: 'J SMITH GIFT', categoryId: fx.ids.groceries, amount: 2500, cleared: 'C', accepted: true, importedPayee: 'J SMITH GIFT', importIds: ['YNAB:25.00:x:1'] });
  writeFileSync(fx.file, serializeBudget(b));
  const qif = writeQif(fx, 'tfr.qif', 'Bank', [['TFR SAVINGS', '-25.00']]);
  const { app, win } = await launch(fx, { bank: [qif] });
  await win.locator('.sidebar .acc-row', { hasText: 'Current Account' }).click();
  await win.getByRole('button', { name: 'Import', exact: true }).click();
  const review = win.locator('.review-table');
  await expect(review.locator('.pair-note')).toContainText('pairs with Savings');
  await expect(review.locator('.pair-note')).toContainText('J SMITH GIFT');
  await expect(review.locator('.pair-note .sugg-mark')).toHaveCount(1);
  await review.getByRole('button', { name: "Don't pair" }).click();
  await expect(review).toContainText('makes its own transfer in Savings');
  await win.getByRole('button', { name: /^Import 1 new/ }).click();
  const saved = await savedBudget(fx, win);
  const gift = Object.values(saved.transactions).find((x) => x.importedPayee === 'J SMITH GIFT')!;
  expect(gift.transferAccountId).toBeUndefined();
  expect(gift.categoryId).toBe(fx.ids.groceries);
  await app.close();
});

test('1.5.11: closing an account with schedules asks, and can delete them', async () => {
  const fx = makeFixture();
  const next = addDays(today(), 10);
  saveScheduled(fx.budget, { accountId: fx.ids.current, date: next, startDate: next, frequency: 'Monthly', transferAccountId: fx.ids.savings, categoryId: null, amount: -40000 });
  writeFileSync(fx.file, serializeBudget(fx.budget));
  const { app, win } = await launch(fx);
  await win.locator('.sidebar .acc-row', { hasText: 'Savings' }).click({ button: 'right' });
  await win.locator('.menu').getByText('Close account').click();
  // It still has money in it: asked first, as before.
  await win.locator('.modal').getByRole('button', { name: 'Close account' }).click();
  const ask = win.locator('.modal', { hasText: "doesn't stop it" });
  await expect(ask).toContainText('Current Account: Transfer : Savings');
  await ask.getByRole('button', { name: 'Delete it and close' }).click();
  const saved = await savedBudget(fx, win);
  expect(saved.accounts[fx.ids.savings].closed).toBe(true);
  expect(Object.keys(saved.scheduled)).toHaveLength(0);
  await app.close();
});
