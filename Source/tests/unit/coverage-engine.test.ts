// Extra coverage for the budget maths (November 2026 test review). Made-up budgets only.
// The rules are in engine.ts's header comment; HANDOVER.md "YNAB4 behaviour" has the evidence.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { categoryMonth, compute } from '../../src/model/engine';
import { deleteCategory, saveTransaction, setBudgeted, setCategoryHidden, setOverspendingHandling } from '../../src/model/ops';
import { INCOME_NEXT, INCOME_NOW, SPLIT, type Budget } from '../../src/model/types';
import { addTx, noNegZero, setNow, standardBudget } from './fixtures';

afterEach(() => vi.useRealTimers());

/**
 * Category balances + Available to Budget (before "budgeted in future") = money in budget
 * accounts, in the last month computed (after every transaction).
 */
function expectBalanced(b: Budget) {
  const c = compute(b);
  const s = c.summary.get(c.months[c.months.length - 1])!;
  expect(s.balanceTotal + s.atbRaw).toBe(c.budgetAccountsTotal);
}

describe('overspending carried into the next month', () => {
  it("takes December's overspending from January's Available to Budget, across the year end", () => {
    setNow(2027, 1, 15);
    const { b, checking, groceries } = standardBudget();
    addTx(b, checking, '2026-12-01', 50000, INCOME_NOW);
    setBudgeted(b, '2026-12', groceries, 10000);
    addTx(b, checking, '2026-12-20', -13000, groceries);
    const c = compute(b);
    expect(categoryMonth(c, '2026-12', groceries).balance).toBe(-3000);
    expect(noNegZero(c.summary.get('2027-01')!)).toMatchObject({ notBudgetedPrev: 40000, overspentPrev: -3000, atb: 37000 });
    expect(categoryMonth(c, '2027-01', groceries)).toMatchObject({ carryIn: 0, balance: 0 });
  });

  it('takes each month’s overspending only once, from the month after it', () => {
    // Overspent by 10.00 in January and again by 10.00 in February: 20.00 in all, never 30.00.
    setNow(2026, 4, 15);
    const { b, checking, groceries } = standardBudget();
    addTx(b, checking, '2026-01-01', 50000, INCOME_NOW);
    addTx(b, checking, '2026-01-20', -1000, groceries);
    addTx(b, checking, '2026-02-20', -1000, groceries);
    const c = compute(b);
    expect(noNegZero(c.summary.get('2026-02')!)).toMatchObject({ overspentPrev: -1000, atb: 49000 });
    expect(noNegZero(c.summary.get('2026-03')!)).toMatchObject({ overspentPrev: -1000, atb: 48000 });
    expect(noNegZero(c.summary.get('2026-04')!)).toMatchObject({ overspentPrev: 0, atb: 48000 });
    expectBalanced(b);
  });

  it('charges a carried negative balance to Available to Budget once the category goes back to the default', () => {
    // January: "carry overspending forward", so -30.00 stays in the category. February: back to
    // the default, so February's balance (still -30.00) is taken from March.
    setNow(2026, 4, 15);
    const { b, checking, fun } = standardBudget();
    addTx(b, checking, '2026-01-01', 50000, INCOME_NOW);
    addTx(b, checking, '2026-01-20', -3000, fun);
    setOverspendingHandling(b, '2026-01', fun, 'carry');
    setOverspendingHandling(b, '2026-02', fun, 'buffer');
    const c = compute(b);
    expect(noNegZero(c.summary.get('2026-02')!)).toMatchObject({ overspentPrev: 0, atb: 50000 });
    expect(categoryMonth(c, '2026-02', fun)).toMatchObject({ carryIn: -3000, balance: -3000, handling: 'buffer' });
    expect(noNegZero(c.summary.get('2026-03')!)).toMatchObject({ overspentPrev: -3000, atb: 47000 });
    expect(categoryMonth(c, '2026-03', fun)).toMatchObject({ carryIn: 0, balance: 0 });
    expectBalanced(b);
  });

  it('with "carry", card overspending stays in the category too and nothing is taken from Available to Budget', () => {
    setNow(2026, 3, 15);
    const { b, checking, card, fun } = standardBudget();
    addTx(b, checking, '2026-01-01', 50000, INCOME_NOW);
    addTx(b, card, '2026-01-20', -4000, fun);
    setOverspendingHandling(b, '2026-01', fun, 'carry');
    const c = compute(b);
    expect(categoryMonth(c, '2026-01', fun)).toMatchObject({ balance: -4000, creditOver: 4000, cashOver: 0 });
    // Not counted as overspending in the month summary: it was carried, not reset.
    expect(noNegZero(c.summary.get('2026-01')!)).toMatchObject({ creditOverspent: 0, cashOverspent: 0 });
    expect(noNegZero(c.summary.get('2026-02')!)).toMatchObject({ overspentPrev: 0, atb: 50000 });
    expect(categoryMonth(c, '2026-02', fun).carryIn).toBe(-4000);
  });

  it('a refund in the next month does not undo overspending already taken from Available to Budget', () => {
    setNow(2026, 3, 15);
    const { b, checking, groceries } = standardBudget();
    addTx(b, checking, '2026-01-01', 50000, INCOME_NOW);
    addTx(b, checking, '2026-01-20', -2000, groceries);
    addTx(b, checking, '2026-02-03', 2000, groceries);
    const c = compute(b);
    expect(c.summary.get('2026-02')!.atb).toBe(48000);
    // The refund lands in February's category balance instead.
    expect(categoryMonth(c, '2026-02', groceries).balance).toBe(2000);
    expectBalanced(b);
  });
});

describe('credit card overspending', () => {
  it('with the card-debt setting, only the cash part of mixed overspending comes off next month', () => {
    setNow(2026, 3, 15);
    const { b, checking, card, groceries, fun } = standardBudget();
    b.settings.creditOverspendingToDebt = true;
    addTx(b, checking, '2026-01-01', 50000, INCOME_NOW);
    // Groceries: 5.00 over in cash. Fun: 7.00 over on the card.
    addTx(b, checking, '2026-01-10', -500, groceries);
    addTx(b, card, '2026-01-11', -700, fun);
    const c = compute(b);
    expect(noNegZero(c.summary.get('2026-01')!)).toMatchObject({ cashOverspent: 500, creditOverspent: 700 });
    expect(noNegZero(c.summary.get('2026-02')!)).toMatchObject({ overspentPrev: -500, atb: 49500 });
  });

  it('counts card spending as covered first by what was budgeted (credit overspending only beyond it)', () => {
    setNow(2026, 3, 15);
    const { b, checking, card, fun } = standardBudget();
    addTx(b, checking, '2026-01-01', 50000, INCOME_NOW);
    setBudgeted(b, '2026-01', fun, 1000);
    addTx(b, card, '2026-01-11', -1500, fun);
    const c = compute(b);
    expect(categoryMonth(c, '2026-01', fun)).toMatchObject({ balance: -500, creditOver: 500, cashOver: 0 });
  });

  it('a card refund in the same month reduces the credit overspending', () => {
    setNow(2026, 3, 15);
    const { b, checking, card, fun } = standardBudget();
    addTx(b, checking, '2026-01-01', 50000, INCOME_NOW);
    addTx(b, card, '2026-01-11', -1500, fun);
    addTx(b, card, '2026-01-12', 500, fun);
    const c = compute(b);
    // creditActivity is the net -10.00, so that is the most that can be credit overspending.
    expect(categoryMonth(c, '2026-01', fun)).toMatchObject({ creditActivity: -1000, balance: -1000, creditOver: 1000, cashOver: 0 });
  });
});

describe('income', () => {
  it('counts income for next month paid in December in January of the next year', () => {
    setNow(2027, 1, 15);
    const { b, checking } = standardBudget();
    addTx(b, checking, '2026-12-28', 200000, INCOME_NEXT);
    const c = compute(b);
    expect(c.summary.get('2026-12')!.income).toBe(0);
    expect(noNegZero(c.summary.get('2027-01')!)).toMatchObject({ income: 200000, atb: 200000 });
  });

  it('counts income lines of a split, and their other lines as spending', () => {
    setNow(2026, 3, 15);
    const { b, checking, fun } = standardBudget();
    addTx(b, checking, '2026-01-15', 90000, SPLIT, {
      splits: [
        { id: 'pay', categoryId: INCOME_NOW, amount: 100000 },
        { id: 'next', categoryId: INCOME_NEXT, amount: 5000 },
        { id: 'lunch', categoryId: fun, amount: -15000 },
      ],
    });
    const c = compute(b);
    expect(c.summary.get('2026-01')!.income).toBe(100000);
    expect(c.summary.get('2026-02')!.income).toBe(5000);
    expect(categoryMonth(c, '2026-01', fun).activity).toBe(-15000);
    expectBalanced(b);
  });

  it('takes negative income (money paid back) off Available to Budget', () => {
    setNow(2026, 3, 15);
    const { b, checking } = standardBudget();
    addTx(b, checking, '2026-01-01', 100000, INCOME_NOW);
    addTx(b, checking, '2026-01-25', -20000, INCOME_NOW);
    expect(compute(b).summary.get('2026-01')).toMatchObject({ income: 80000, atb: 80000 });
  });

  it('ignores income in a tracking account', () => {
    setNow(2026, 3, 15);
    const { b, checking, mortgage } = standardBudget();
    addTx(b, checking, '2026-01-01', 100000, INCOME_NOW);
    addTx(b, mortgage, '2026-01-02', 999999, INCOME_NOW);
    const c = compute(b);
    expect(c.summary.get('2026-01')!.income).toBe(100000);
    expect(c.budgetAccountsTotal).toBe(100000);
  });
});

describe('transfers', () => {
  it('moves no money in the budget between two budget accounts', () => {
    setNow(2026, 3, 15);
    const { b, checking, savings } = standardBudget();
    addTx(b, checking, '2026-01-01', 100000, INCOME_NOW);
    saveTransaction(b, { accountId: checking, transferAccountId: savings, date: '2026-01-05', amount: -30000, cleared: 'C' });
    const c = compute(b);
    expect(noNegZero(c.summary.get('2026-01')!)).toMatchObject({ atb: 100000, activity: 0 });
    expect(c.uncategorized).toEqual([]);
    expectBalanced(b);
  });

  it('counts a categorised payment to a tracking account as spending', () => {
    setNow(2026, 3, 15);
    const { b, checking, mortgage, rent } = standardBudget();
    addTx(b, checking, '2026-01-01', 100000, INCOME_NOW);
    setBudgeted(b, '2026-01', rent, 60000);
    saveTransaction(b, { accountId: checking, transferAccountId: mortgage, date: '2026-01-05', amount: -60000, categoryId: rent, cleared: 'C' });
    const c = compute(b);
    expect(categoryMonth(c, '2026-01', rent)).toMatchObject({ activity: -60000, balance: 0 });
    expect(c.uncategorized).toEqual([]);
    expectBalanced(b);
  });
});

describe('hidden and deleted categories with balances', () => {
  it('keeps carrying a hidden category’s money forward, so Available to Budget is unchanged by hiding it', () => {
    setNow(2026, 4, 15);
    const { b, checking, fun } = standardBudget();
    addTx(b, checking, '2026-01-01', 50000, INCOME_NOW);
    setBudgeted(b, '2026-01', fun, 8000);
    const before = compute(b).summary.get('2026-04')!.atb;
    setCategoryHidden(b, fun, true);
    const c = compute(b);
    expect(c.summary.get('2026-04')!.atb).toBe(before);
    expect(categoryMonth(c, '2026-04', fun).balance).toBe(8000);
  });

  it('deleting a category into another moves its budgeted amounts and spending, keeping the totals', () => {
    setNow(2026, 3, 15);
    const { b, checking, fun, groceries } = standardBudget();
    addTx(b, checking, '2026-01-01', 50000, INCOME_NOW);
    setBudgeted(b, '2026-01', fun, 5000);
    setBudgeted(b, '2026-01', groceries, 1000);
    addTx(b, checking, '2026-01-10', -2000, fun);
    const atb = compute(b).summary.get('2026-03')!.atb;
    deleteCategory(b, fun, groceries);
    const c = compute(b);
    expect(categoryMonth(c, '2026-01', groceries)).toMatchObject({ budgeted: 6000, activity: -2000, balance: 4000 });
    expect(c.summary.get('2026-03')!.atb).toBe(atb);
    expectBalanced(b);
  });

  it('deleting a category without a replacement gives its budgeted money back and leaves its spending uncategorised', () => {
    setNow(2026, 3, 15);
    const { b, checking, fun } = standardBudget();
    addTx(b, checking, '2026-01-01', 50000, INCOME_NOW);
    setBudgeted(b, '2026-01', fun, 5000);
    const spend = addTx(b, checking, '2026-01-10', -2000, fun);
    deleteCategory(b, fun, null);
    const c = compute(b);
    expect(noNegZero(c.summary.get('2026-01')!)).toMatchObject({ budgeted: 0, atb: 50000 });
    expect(c.uncategorized).toEqual([spend]);
  });

  it('treats spending in a category that no longer exists (damaged data) as uncategorised, and ignores its budget cells', () => {
    setNow(2026, 3, 15);
    const { b, checking } = standardBudget();
    addTx(b, checking, '2026-01-01', 50000, INCOME_NOW);
    const t = addTx(b, checking, '2026-01-10', -2000, 'gone-category');
    b.months['2026-01'] = { 'gone-category': { budgeted: 7000 } };
    const c = compute(b);
    expect(c.uncategorized).toEqual([t]);
    expect(noNegZero(c.summary.get('2026-01')!)).toMatchObject({ budgeted: 0, activity: 0, atb: 50000 });
  });
});
