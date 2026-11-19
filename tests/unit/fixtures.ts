// Small synthetic budgets for the model tests. Made-up names and amounts only.
import { vi } from 'vitest';
import { newBudget } from '../../src/model/budget';
import { addCategory, addMaster, ensureTransferPayee } from '../../src/model/ops';
import type { AccountType, Budget, Id, Transaction } from '../../src/model/types';

/** Pins "now" (local time) so that compute() and today() are deterministic. */
export function setNow(y: number, m: number, d: number): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(y, m - 1, d, 12, 0, 0));
}

export function emptyBudget(name = 'Test Budget'): Budget {
  return newBudget(name, false);
}

/** Adds an account directly (no starting balance transaction). */
export function addTestAccount(b: Budget, name: string, type: AccountType = 'Checking', onBudget = true): Id {
  const id = 'acc-' + name.toLowerCase().replace(/\W+/g, '-');
  const sort = Object.keys(b.accounts).length;
  b.accounts[id] = { id, name, type, onBudget, closed: false, sort };
  ensureTransferPayee(b, id);
  return id;
}

let txCounter = 0;

/** Adds a transaction directly, bypassing saveTransaction. */
export function addTx(
  b: Budget,
  accountId: Id,
  date: string,
  amount: number,
  categoryId: Id | null,
  extra: Partial<Transaction> = {},
): Id {
  const id = extra.id ?? `tx-${++txCounter}`;
  b.transactions[id] = { id, accountId, date, amount, categoryId, cleared: 'U', accepted: true, ...extra };
  return id;
}

/**
 * Checking, Savings and Card (budget accounts), Mortgage (tracking), and two groups:
 * Bills (Rent, Power) and Everyday (Groceries, Fun).
 */
export function standardBudget() {
  const b = emptyBudget();
  const checking = addTestAccount(b, 'Checking', 'Checking');
  const savings = addTestAccount(b, 'Savings', 'Savings');
  const card = addTestAccount(b, 'Card', 'CreditCard');
  const mortgage = addTestAccount(b, 'Mortgage', 'Mortgage', false);
  const bills = addMaster(b, 'Bills');
  const everyday = addMaster(b, 'Everyday');
  const rent = addCategory(b, bills, 'Rent');
  const power = addCategory(b, bills, 'Power');
  const groceries = addCategory(b, everyday, 'Groceries');
  const fun = addCategory(b, everyday, 'Fun');
  return { b, checking, savings, card, mortgage, bills, everyday, rent, power, groceries, fun };
}

/** Replaces -0 with 0 in an object's number fields, so toEqual doesn't trip over it. */
export function noNegZero<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? v + 0 : v])) as T;
}
