import { afterEach, describe, expect, it, vi } from 'vitest';
import { categoryLines, categoryMonth, compute, emptyCategoryMonth, monthSummary } from '../../src/model/engine';
import { setBudgeted, setCategoryHidden, setCategoryMonthNote, setOverspendingHandling } from '../../src/model/ops';
import { INCOME_NEXT, INCOME_NOW, SPLIT } from '../../src/model/types';
import { addTestAccount, addTx, emptyBudget, noNegZero, setNow, standardBudget } from './fixtures';

afterEach(() => vi.useRealTimers());

describe('Available to Budget across months', () => {
  function scenario() {
    setNow(2026, 3, 15);
    const f = standardBudget();
    const { b, checking, groceries, rent } = f;
    addTx(b, checking, '2026-01-01', 300000, INCOME_NOW);
    setBudgeted(b, '2026-01', groceries, 40000);
    setBudgeted(b, '2026-01', rent, 100000);
    addTx(b, checking, '2026-01-10', -30000, groceries);
    setBudgeted(b, '2026-02', groceries, 40000);
    // Paid in February, but for March.
    addTx(b, checking, '2026-02-20', 200000, INCOME_NEXT);
    setBudgeted(b, '2026-03', rent, 100000);
    return { ...f, c: compute(b) };
  }

  it('covers the first month with data to one month past this month', () => {
    const { c } = scenario();
    expect(c.first).toBe('2026-01');
    expect(c.last).toBe('2026-04');
    expect(c.months).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
  });

  it('rolls Available to Budget forward, counting "income for next month" in the next month', () => {
    const { c } = scenario();
    expect(noNegZero(c.summary.get('2026-01')!)).toEqual({
      month: '2026-01',
      notBudgetedPrev: 0,
      overspentPrev: 0,
      income: 300000,
      budgeted: 140000,
      // February budgets 400.00 with no income of its own, so January holds it back.
      budgetedInFuture: 40000,
      atbRaw: 160000,
      atb: 120000,
      activity: -30000,
      balanceTotal: 110000,
      cashOverspent: 0,
      creditOverspent: 0,
    });
    expect(c.summary.get('2026-02')).toMatchObject({ notBudgetedPrev: 160000, income: 0, budgeted: 40000, atbRaw: 120000, atb: 120000, budgetedInFuture: 0 });
    expect(c.summary.get('2026-03')).toMatchObject({ notBudgetedPrev: 120000, income: 200000, budgeted: 100000, atb: 220000 });
    expect(c.summary.get('2026-04')).toMatchObject({ notBudgetedPrev: 220000, income: 0, budgeted: 0, atb: 220000 });
  });

  it('carries positive category balances forward', () => {
    const { c, groceries, rent } = scenario();
    expect(categoryMonth(c, '2026-01', groceries)).toMatchObject({ budgeted: 40000, activity: -30000, carryIn: 0, balance: 10000 });
    expect(categoryMonth(c, '2026-02', groceries)).toMatchObject({ budgeted: 40000, carryIn: 10000, balance: 50000 });
    expect(categoryMonth(c, '2026-04', groceries)).toMatchObject({ carryIn: 50000, balance: 50000 });
    expect(categoryMonth(c, '2026-03', rent).balance).toBe(200000);
  });

  it('keeps category balances + Available to Budget equal to the money in budget accounts', () => {
    const { c } = scenario();
    expect(c.budgetAccountsTotal).toBe(470000);
    for (const m of ['2026-03', '2026-04']) {
      const s = c.summary.get(m)!;
      expect(s.balanceTotal + s.atbRaw).toBe(c.budgetAccountsTotal);
    }
  });

  it('returns an empty category month for months or categories it has no data for', () => {
    const { c, groceries } = scenario();
    expect(categoryMonth(c, '1999-01', groceries)).toEqual(emptyCategoryMonth());
    expect(categoryMonth(c, '2026-01', 'no-such-category')).toEqual(emptyCategoryMonth());
    expect(monthSummary(c, '1999-01')).toBeUndefined();
  });
});

describe('overspending', () => {
  function overspent(handling?: 'carry') {
    setNow(2026, 3, 15);
    const f = standardBudget();
    const { b, checking, groceries } = f;
    addTx(b, checking, '2026-01-01', 100000, INCOME_NOW);
    setBudgeted(b, '2026-01', groceries, 10000);
    addTx(b, checking, '2026-01-10', -15000, groceries);
    if (handling) setOverspendingHandling(b, '2026-01', groceries, handling);
    return f;
  }

  it('by default ("buffer") resets the category to zero and takes it from next month’s Available to Budget', () => {
    const { b, groceries } = overspent();
    const c = compute(b);
    expect(categoryMonth(c, '2026-01', groceries)).toMatchObject({ balance: -5000, cashOver: 5000, creditOver: 0, handling: 'buffer' });
    expect(c.summary.get('2026-01')).toMatchObject({ atb: 90000, cashOverspent: 5000 });
    expect(categoryMonth(c, '2026-02', groceries)).toMatchObject({ carryIn: 0, balance: 0 });
    expect(c.summary.get('2026-02')).toMatchObject({ overspentPrev: -5000, atb: 85000 });
    expect(c.summary.get('2026-03')!.overspentPrev + 0).toBe(0);
    expect(c.summary.get('2026-03')!.atb).toBe(85000);
    for (const m of c.months) {
      const s = c.summary.get(m)!;
      expect(s.balanceTotal + s.atbRaw).toBe(c.budgetAccountsTotal);
    }
  });

  it('with "carry" keeps the negative balance in the category and leaves Available to Budget alone', () => {
    const { b, groceries } = overspent('carry');
    const c = compute(b);
    expect(categoryMonth(c, '2026-01', groceries)).toMatchObject({ balance: -5000, cashOver: 5000, handling: 'carry' });
    expect(c.summary.get('2026-01')!.cashOverspent).toBe(0);
    expect(categoryMonth(c, '2026-02', groceries)).toMatchObject({ carryIn: -5000, balance: -5000 });
    expect(c.summary.get('2026-02')!.overspentPrev + 0).toBe(0);
    expect(c.summary.get('2026-02')!.atb).toBe(90000);
  });

  it('keeps "carry" in later months until it is changed', () => {
    const { b, checking, groceries } = overspent('carry');
    addTx(b, checking, '2026-02-10', -1000, groceries);
    let c = compute(b);
    // February has no entry of its own, but still carries.
    expect(b.months['2026-02']?.[groceries]).toBeUndefined();
    expect(categoryMonth(c, '2026-02', groceries)).toMatchObject({ handling: 'carry', carryIn: -5000, balance: -6000 });
    expect(categoryMonth(c, '2026-03', groceries)).toMatchObject({ handling: 'carry', carryIn: -6000, balance: -6000 });
    expect(categoryMonth(c, '2026-04', groceries)).toMatchObject({ handling: 'carry', carryIn: -6000 });
    expect(c.summary.get('2026-04')!.atb).toBe(90000);

    // Switching back to buffer in March takes the whole carried amount from April.
    setOverspendingHandling(b, '2026-03', groceries, 'buffer');
    c = compute(b);
    expect(categoryMonth(c, '2026-02', groceries).handling).toBe('carry');
    expect(categoryMonth(c, '2026-03', groceries)).toMatchObject({ handling: 'buffer', balance: -6000, cashOver: 6000 });
    expect(c.summary.get('2026-03')!.cashOverspent).toBe(6000);
    expect(c.summary.get('2026-04')).toMatchObject({ overspentPrev: -6000, atb: 84000 });
    expect(categoryMonth(c, '2026-04', groceries)).toMatchObject({ handling: 'buffer', carryIn: 0, balance: 0 });
  });

  it('budgeting to cover a carried balance clears it', () => {
    const { b, groceries } = overspent('carry');
    setBudgeted(b, '2026-02', groceries, 5000);
    const c = compute(b);
    expect(categoryMonth(c, '2026-02', groceries).balance).toBe(0);
    expect(c.summary.get('2026-02')!.atb).toBe(85000);
  });

  describe('credit and cash', () => {
    function mixed(creditToDebt: boolean) {
      setNow(2026, 3, 15);
      const f = standardBudget();
      const { b, checking, card, groceries } = f;
      b.settings.creditOverspendingToDebt = creditToDebt;
      addTx(b, checking, '2026-01-01', 100000, INCOME_NOW);
      setBudgeted(b, '2026-01', groceries, 10000);
      addTx(b, checking, '2026-01-10', -12000, groceries);
      addTx(b, card, '2026-01-12', -3000, groceries);
      return { ...f, c: compute(b) };
    }

    it('splits the overspending into credit (up to the credit spending) and cash', () => {
      const { c, groceries } = mixed(false);
      expect(categoryMonth(c, '2026-01', groceries)).toMatchObject({
        activity: -15000,
        cashActivity: -12000,
        creditActivity: -3000,
        balance: -5000,
        creditOver: 3000,
        cashOver: 2000,
      });
      expect(c.summary.get('2026-01')).toMatchObject({ cashOverspent: 2000, creditOverspent: 3000 });
    });

    it('takes credit overspending from next month as well by default (YNAB4 behaviour)', () => {
      const { c, groceries } = mixed(false);
      expect(c.summary.get('2026-02')).toMatchObject({ overspentPrev: -5000, atb: 85000 });
      expect(categoryMonth(c, '2026-02', groceries).carryIn).toBe(0);
      for (const m of c.months) {
        const s = c.summary.get(m)!;
        expect(s.balanceTotal + s.atbRaw).toBe(c.budgetAccountsTotal);
      }
    });

    it('with creditOverspendingToDebt leaves credit overspending as card debt', () => {
      const { c, groceries } = mixed(true);
      expect(c.summary.get('2026-02')).toMatchObject({ overspentPrev: -2000, atb: 88000 });
      expect(categoryMonth(c, '2026-02', groceries).carryIn).toBe(0);
      // The uncovered card debt is the gap between the budget and the accounts.
      const s = c.summary.get('2026-03')!;
      expect(s.balanceTotal + s.atbRaw - c.budgetAccountsTotal).toBe(3000);
    });

    it('treats overspending from a credit card only as credit overspending', () => {
      setNow(2026, 3, 15);
      const { b, card, checking, groceries } = standardBudget();
      addTx(b, checking, '2026-01-01', 100000, INCOME_NOW);
      addTx(b, card, '2026-01-12', -4000, groceries);
      let c = compute(b);
      expect(categoryMonth(c, '2026-01', groceries)).toMatchObject({ creditOver: 4000, cashOver: 0 });
      expect(c.summary.get('2026-02')!.atb).toBe(96000);
      b.settings.creditOverspendingToDebt = true;
      c = compute(b);
      expect(c.summary.get('2026-02')!.atb).toBe(100000);
    });

    it('counts line of credit spending as credit', () => {
      setNow(2026, 3, 15);
      const { b, groceries } = standardBudget();
      const loc = addTestAccount(b, 'Overdraft line', 'LineOfCredit');
      addTx(b, loc, '2026-01-12', -4000, groceries);
      expect(categoryMonth(compute(b), '2026-01', groceries)).toMatchObject({ creditActivity: -4000, creditOver: 4000 });
    });
  });
});

describe('budgeted in future', () => {
  function setup() {
    setNow(2026, 1, 15);
    const f = standardBudget();
    addTx(f.b, f.checking, '2026-01-05', 100000, INCOME_NOW);
    return f;
  }

  it('holds back money that a later month budgets beyond its income', () => {
    const { b, groceries } = setup();
    setBudgeted(b, '2026-02', groceries, 30000);
    const c = compute(b);
    expect(c.summary.get('2026-01')).toMatchObject({ atbRaw: 100000, budgetedInFuture: 30000, atb: 70000 });
    expect(c.summary.get('2026-02')).toMatchObject({ atbRaw: 70000, budgetedInFuture: 0, atb: 70000 });
    expect(c.summary.get('2026-03')!.atb).toBe(70000);
  });

  it('never holds back more than is available, so the over-budgeted month shows negative', () => {
    const { b, groceries } = setup();
    setBudgeted(b, '2026-02', groceries, 150000);
    const c = compute(b);
    expect(c.summary.get('2026-01')).toMatchObject({ budgetedInFuture: 100000, atb: 0 });
    expect(c.summary.get('2026-02')!.atb).toBe(-50000);
  });

  it('holds nothing back when the later month’s own income covers it', () => {
    const { b, checking, groceries } = setup();
    addTx(b, checking, '2026-02-01', 50000, INCOME_NOW);
    setBudgeted(b, '2026-02', groceries, 30000);
    const c = compute(b);
    expect(c.summary.get('2026-01')).toMatchObject({ budgetedInFuture: 0, atb: 100000 });
  });

  it('counts income for next month as the later month’s income', () => {
    const { b, checking, groceries } = setup();
    addTx(b, checking, '2026-01-28', 40000, INCOME_NEXT);
    setBudgeted(b, '2026-02', groceries, 30000);
    const c = compute(b);
    expect(c.summary.get('2026-01')).toMatchObject({ income: 100000, budgetedInFuture: 0, atb: 100000 });
    expect(c.summary.get('2026-02')).toMatchObject({ income: 40000, atb: 110000 });
  });

  it('takes the worst of several later months', () => {
    const { b, checking, groceries } = setup();
    setBudgeted(b, '2026-02', groceries, 30000);
    addTx(b, checking, '2026-03-01', 50000, INCOME_NOW);
    setBudgeted(b, '2026-04', groceries, 60000);
    const c = compute(b);
    // Lowest later balance: April, 100000 - 30000 + 50000 - 60000 = 60000.
    expect(c.summary.get('2026-01')).toMatchObject({ budgetedInFuture: 40000, atb: 60000 });
    expect(c.summary.get('2026-02')).toMatchObject({ budgetedInFuture: 10000, atb: 60000 });
    expect(c.summary.get('2026-03')).toMatchObject({ atbRaw: 120000, budgetedInFuture: 60000, atb: 60000 });
    expect(c.summary.get('2026-04')).toMatchObject({ budgetedInFuture: 0, atb: 60000 });
  });

  it('does not hold anything back from a month that is already negative', () => {
    const { b, groceries } = setup();
    setBudgeted(b, '2026-01', groceries, 110000);
    setBudgeted(b, '2026-02', groceries, 5000);
    const c = compute(b);
    expect(c.summary.get('2026-01')).toMatchObject({ atbRaw: -10000, budgetedInFuture: 0, atb: -10000 });
  });
});

describe('uncategorised transactions', () => {
  it('lists budget-account transactions that need a category, once each', () => {
    setNow(2026, 3, 15);
    const { b, checking, savings, mortgage, groceries, rent } = standardBudget();
    const d = '2026-02-10';
    const need: string[] = [];
    need.push(addTx(b, checking, d, -1000, null));
    need.push(addTx(b, checking, d, -1000, 'deleted-category'));
    addTx(b, checking, d, 0, null);
    addTx(b, checking, d, 100, INCOME_NOW);
    // Budget <-> budget transfers need no category.
    addTx(b, checking, d, -2000, null, { transferAccountId: savings });
    addTx(b, savings, d, 2000, null, { transferAccountId: checking });
    // Budget -> tracking transfers do, on the budget side only.
    need.push(addTx(b, checking, d, -3000, null, { transferAccountId: mortgage }));
    addTx(b, mortgage, d, 3000, null, { transferAccountId: checking });
    addTx(b, checking, d, -3000, rent, { transferAccountId: mortgage });
    need.push(addTx(b, checking, d, 4000, null, { transferAccountId: mortgage }));
    // A transfer to an account that no longer exists needs one too.
    need.push(addTx(b, checking, d, -500, null, { transferAccountId: 'acc-gone' }));
    // Splits.
    need.push(
      addTx(b, checking, d, -1200, SPLIT, {
        splits: [
          { id: 'a', categoryId: groceries, amount: -500 },
          { id: 'b', categoryId: null, amount: -500 },
          { id: 'c', categoryId: null, amount: -200 },
        ],
      }),
    );
    addTx(b, checking, d, -1000, SPLIT, {
      splits: [
        { id: 'a', categoryId: groceries, amount: -500 },
        { id: 'b', categoryId: null, amount: -500, transferAccountId: savings },
      ],
    });
    need.push(
      addTx(b, checking, d, -1000, SPLIT, {
        splits: [
          { id: 'a', categoryId: groceries, amount: -500 },
          { id: 'b', categoryId: null, amount: -500, transferAccountId: mortgage },
        ],
      }),
    );
    addTx(b, checking, d, -1000, SPLIT, {
      splits: [
        { id: 'a', categoryId: groceries, amount: -500 },
        { id: 'b', categoryId: rent, amount: -500, transferAccountId: mortgage },
      ],
    });
    // A split with no lines.
    need.push(addTx(b, checking, d, -100, SPLIT));
    // Off budget, or in an unknown account: never listed.
    addTx(b, mortgage, d, -100, null);
    addTx(b, 'acc-unknown', d, -100, null);

    const c = compute(b);
    expect([...c.uncategorized].sort()).toEqual([...need].sort());
    expect(categoryMonth(c, '2026-02', rent).activity).toBe(-3500);
    expect(categoryMonth(c, '2026-02', groceries).activity).toBe(-2000);
  });
});

describe('hidden categories', () => {
  it('still count towards budgeted, balances and overspending', () => {
    setNow(2026, 3, 15);
    const { b, checking, fun } = standardBudget();
    setCategoryHidden(b, fun, true);
    addTx(b, checking, '2026-01-01', 100000, INCOME_NOW);
    setBudgeted(b, '2026-01', fun, 5000);
    addTx(b, checking, '2026-01-10', -2000, fun);
    addTx(b, checking, '2026-02-10', -4000, fun);
    const c = compute(b);
    expect(c.summary.get('2026-01')).toMatchObject({ budgeted: 5000, balanceTotal: 3000, atb: 95000 });
    expect(categoryMonth(c, '2026-02', fun)).toMatchObject({ carryIn: 3000, balance: -1000, cashOver: 1000 });
    expect(c.summary.get('2026-03')).toMatchObject({ overspentPrev: -1000, atb: 94000 });
  });
});

describe('account totals', () => {
  it('adds up cleared, uncleared, working, count and unapproved per account', () => {
    setNow(2026, 3, 15);
    const { b, checking, savings, mortgage, groceries } = standardBudget();
    addTx(b, checking, '2026-01-01', 100000, INCOME_NOW, { cleared: 'C' });
    addTx(b, checking, '2026-01-02', -20000, groceries, { cleared: 'U' });
    addTx(b, checking, '2026-01-03', 5000, INCOME_NOW, { cleared: 'R' });
    addTx(b, checking, '2026-01-04', -3000, groceries, { cleared: 'U', accepted: false });
    addTx(b, mortgage, '2026-01-04', -9000000, null, { cleared: 'C' });
    b.accounts[savings].closed = true;
    addTx(b, savings, '2026-01-05', 700, INCOME_NOW, { cleared: 'C' });
    const c = compute(b);
    expect(c.accounts.get(checking)).toEqual({ cleared: 105000, uncleared: -23000, working: 82000, count: 4, unapproved: 1 });
    expect(c.accounts.get(mortgage)).toEqual({ cleared: -9000000, uncleared: 0, working: -9000000, count: 1, unapproved: 0 });
    expect(c.accounts.get(savings)!.working).toBe(700);
    // Tracking accounts are not budget money.
    expect(c.budgetAccountsTotal).toBe(82700);
  });

  it('has a zero entry for accounts without transactions', () => {
    setNow(2026, 3, 15);
    const { b, card } = standardBudget();
    expect(compute(b).accounts.get(card)).toEqual({ cleared: 0, uncleared: 0, working: 0, count: 0, unapproved: 0 });
  });
});

describe('month range', () => {
  it('starts at this month for an empty budget', () => {
    setNow(2026, 3, 15);
    const c = compute(emptyBudget());
    expect(c.months).toEqual(['2026-03', '2026-04']);
    expect(c.uncategorized).toEqual([]);
    expect(c.summary.get('2026-03')!.atb).toBe(0);
  });

  it('ignores tracking-account transactions and empty budget cells when finding the first month', () => {
    setNow(2026, 3, 15);
    const { b, mortgage, groceries } = standardBudget();
    addTx(b, mortgage, '2025-06-01', -100, null);
    b.months['2025-08'] = { [groceries]: { budgeted: 0 } };
    expect(compute(b).first).toBe('2026-03');
  });

  it('starts at the first month with a budgeted amount, handling or note', () => {
    setNow(2026, 3, 15);
    const { b, groceries, rent, fun } = standardBudget();
    setCategoryMonthNote(b, '2025-11', groceries, 'a note');
    expect(compute(b).first).toBe('2025-11');
    setOverspendingHandling(b, '2025-09', rent, 'carry');
    expect(compute(b).first).toBe('2025-09');
    setBudgeted(b, '2025-07', fun, 100);
    expect(compute(b).first).toBe('2025-07');
  });

  it('extends to one month past future-dated data, and to `until`', () => {
    setNow(2026, 3, 15);
    const { b, checking } = standardBudget();
    addTx(b, checking, '2026-08-01', 100, INCOME_NOW);
    expect(compute(b).last).toBe('2026-09');
    expect(compute(b, '2027-01').months.at(-1)).toBe('2027-01');
    expect(compute(b, '2026-05').last).toBe('2026-09');
  });

  it('counts income for next month from the last month of data', () => {
    setNow(2026, 3, 15);
    const { b, checking } = standardBudget();
    addTx(b, checking, '2026-08-31', 5000, INCOME_NEXT);
    const c = compute(b);
    expect(c.summary.get('2026-09')!.income).toBe(5000);
    expect(c.summary.get('2026-09')!.atb).toBe(5000);
  });
});

describe('categoryLines', () => {
  it('returns the split lines of a split, or the transaction itself', () => {
    const base = { id: 't', accountId: 'a', date: '2026-01-01', cleared: 'U' as const, accepted: true };
    expect(categoryLines({ ...base, categoryId: 'c1', amount: -5, transferAccountId: 'x' })).toEqual([
      { categoryId: 'c1', amount: -5, transferAccountId: 'x' },
    ]);
    expect(
      categoryLines({
        ...base,
        categoryId: SPLIT,
        amount: -5,
        splits: [
          { id: '1', categoryId: 'c1', amount: -2 },
          { id: '2', categoryId: null, amount: -3, transferAccountId: 'y' },
        ],
      }),
    ).toEqual([
      { categoryId: 'c1', amount: -2, transferAccountId: undefined },
      { categoryId: null, amount: -3, transferAccountId: 'y' },
    ]);
    expect(categoryLines({ ...base, categoryId: SPLIT, amount: -5, splits: [] })).toEqual([
      { categoryId: SPLIT, amount: -5, transferAccountId: undefined },
    ]);
  });
});
