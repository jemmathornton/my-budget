import { isISODate, isMonthKey } from './dates';
import { INCOME_NEXT, INCOME_NOW, SPLIT, type Budget, type Id } from './types';

// Budget › Check budget: looks for anything inconsistent in the data (a broken transfer pair, a
// split that doesn't add up, a link to something that no longer exists). It only reports; it
// never changes the budget. Both of the user's budgets passed every check in October 2026.

export interface BudgetProblem {
  /** A short description of the kind of problem, shown as a heading. */
  kind: string;
  /** How many records have it. */
  count: number;
  /** A few of the transactions involved, to look at in the register. */
  examples: Id[];
}

export function checkBudget(b: Budget): BudgetProblem[] {
  const found = new Map<string, Id[]>();
  const add = (kind: string, id: Id) => {
    const list = found.get(kind);
    if (list) list.push(id);
    else found.set(kind, [id]);
  };
  const validCategory = (c: Id | null | undefined) =>
    c == null || c === INCOME_NOW || c === INCOME_NEXT || c === SPLIT || Object.hasOwn(b.categories, c);

  for (const t of Object.values(b.transactions)) {
    if (!Object.hasOwn(b.accounts, t.accountId)) add('Transactions in an account that no longer exists', t.id);
    if (!isISODate(t.date)) add('Transactions with an impossible date', t.id);
    if (!Number.isSafeInteger(t.amount)) add('Amounts that are not whole pence', t.id);
    if (t.payeeId && !Object.hasOwn(b.payees, t.payeeId)) add('Transactions with a payee that no longer exists', t.id);
    if (!validCategory(t.categoryId)) add('Transactions with a category that no longer exists', t.id);
    if (t.categoryId === SPLIT) {
      const lines = t.splits ?? [];
      if (!lines.length) add('Split transactions with no lines', t.id);
      else if (lines.reduce((s, l) => s + l.amount, 0) !== t.amount) add("Split transactions whose lines don't add up", t.id);
      for (const l of lines) {
        if (!validCategory(l.categoryId)) add('Split lines with a category that no longer exists', t.id);
        if (l.transferTxId) {
          const p = b.transactions[l.transferTxId];
          if (!p || p.amount !== -l.amount || p.transferSplitParentId !== t.id) add('Transfers on split lines that are not paired correctly', t.id);
        }
      }
    } else if (t.splits?.length) add('Split lines on a transaction that is not a split', t.id);
    if (t.transferTxId) {
      const p = b.transactions[t.transferTxId];
      if (!p) add('Transfers whose other side is missing', t.id);
      else if (t.transferSplitParentId) {
        // The far side of a split line: its line points back at it, from the far side's account.
        const line = p.splits?.find((l) => l.transferTxId === t.id);
        if (!line || line.transferAccountId !== t.accountId || t.transferAccountId !== p.accountId)
          add('Transfers on split lines that are not paired correctly', t.id);
      } else if (p.transferTxId !== t.id || p.amount !== -t.amount || p.date !== t.date) {
        add("Transfers whose two sides don't match", t.id);
      }
    }
  }
  for (const s of Object.values(b.scheduled)) {
    if (!Object.hasOwn(b.accounts, s.accountId)) add('Scheduled transactions in an account that no longer exists', s.id);
    if (!validCategory(s.categoryId)) add('Scheduled transactions with a category that no longer exists', s.id);
  }
  for (const c of Object.values(b.categories)) {
    if (!Object.hasOwn(b.masters, c.masterId)) add('Categories in a group that no longer exists', c.id);
  }
  for (const [month, cells] of Object.entries(b.months)) {
    if (!isMonthKey(month)) add('Budget entries for a month that is not a month', month);
    for (const id of Object.keys(cells)) if (!Object.hasOwn(b.categories, id)) add('Budget entries for a category that no longer exists', month + '/' + id);
  }
  return [...found].map(([kind, ids]) => ({ kind, count: ids.length, examples: ids.slice(0, 5) }));
}
