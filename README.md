# My Budget

A private, offline budgeting app for Windows in the style of YNAB4, the 2012–2019 desktop version
of You Need A Budget. Everything stays on your computer: there's no server, no account and no
subscription, and nothing is sent anywhere.

Built with Electron, React and TypeScript.

## What it does

- **Envelope budgeting as in YNAB4:** Available to Budget, monthly categories, overspending taken
  from next month, "carry overspending forward", income for next month, Quick Budget.
- **Accounts and registers:** transfers, split transactions, cleared and reconciled transactions,
  reconciling by statement date, scheduled transactions, search, flags, and approving imports.
- **Bank imports (QIF, OFX/QFX/QBO and CSV):** duplicate detection, matching to transactions you
  typed in, payee rules, category guessing from your history, and a review before anything is added.
  It knows a few UK banks' quirks (Nationwide, Santander, Barclaycard, American Express); any bank's
  files work through the column screen.
- **Opening YNAB4 budgets**, including the transactions you had deleted there.
- **Reports** (spending, trends, income v expense, net worth), printing, and Check budget.
- **Safety:** every change is saved within a second, atomically, with conflict detection if another
  program changes the file. Daily and hourly backups, restore from a backup, and undo/redo.

Budgets are plain `.budget` files (JSON) wherever you keep them.

## The folder

```
MyBudget/
  Source/     the app (this repository holds only this, and the README)
  Budgets/    your budgets, and anything about them: never committed (see .gitignore)
```

The app offers the budgets in `Documents\MyBudget\Budgets` on its start screen, and saves new ones there.

## Building it

Needs Node.js 22. In `Source`:

```
npm install
npm run dev          # run it while developing
npm run build        # build the app
node node_modules/electron-builder/cli.js --win --publish never   # the Windows installer, in release/
```

## Tests

In `Source`:

```
npm run typecheck
npm test             # unit tests (vitest)
npm run test:e2e     # the app itself, driven by Playwright (the window opens off-screen)
npm run test:real    # tests that read your own budgets, kept in Budgets/Tests
```

Tests that use your own budgets belong with them in `Budgets/Tests` (or set `MYBUDGET_REAL_TESTS`),
not in the repository. They import the app as `@app/…` and the test helpers as `@fixtures`.
