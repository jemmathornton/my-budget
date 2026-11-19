// YNAB4's Quick Budget (1.2).
import { describe, expect, it } from 'vitest';
import { compute } from '../../src/model/engine';
import { saveScheduled, setBudgeted } from '../../src/model/ops';
import { monthsOfHistory, quickBudgetChoices, quickFill } from '../../src/model/quickBudget';
import { INCOME_NOW } from '../../src/model/types';
import { addTx, standardBudget } from './fixtures';

function setup() {
  const s = standardBudget();
  const { b, checking, groceries, rent, fun } = s;
  addTx(b, checking, '2026-07-01', 500000, INCOME_NOW);
  // Groceries: £300, £200, £100 spent in Jul, Aug, Sep; budgeted £250 in Sep.
  addTx(b, checking, '2026-07-10', -30000, groceries);
  addTx(b, checking, '2026-08-10', -20000, groceries);
  addTx(b, checking, '2026-09-10', -10000, groceries);
  setBudgeted(b, '2026-09', groceries, 25000);
  setBudgeted(b, '2026-09', rent, 80000);
  setBudgeted(b, '2026-10', rent, 90000);
  // Fun had a refund larger than its spending in September.
  addTx(b, checking, '2026-09-12', 1500, fun);
  return s;
}

const pick = (qs: ReturnType<typeof quickBudgetChoices>, kind: string) => qs.find((q) => q.kind === kind)!;

describe('Quick Budget choices', () => {
  it('works out the YNAB4 amounts, in YNAB4 order and wording', () => {
    const { b, groceries } = setup();
    const c = compute(b, '2026-10');
    const qs = quickBudgetChoices(b, c, [groceries], '2026-10');
    expect(qs.map((q) => q.label)).toEqual([
      'Budget values used last month',
      'Outflows last month',
      'Total scheduled outflows this month',
      'Average outflows for the last 3 months',
      'Average outflows for the last year (only 3 months available)',
      'Balance to 0.00',
    ]);
    expect(pick(qs, 'budgetedLastMonth').amounts[groceries]).toBe(25000);
    expect(pick(qs, 'outflowsLastMonth').amounts[groceries]).toBe(10000);
    expect(pick(qs, 'average3').amounts[groceries]).toBe(20000);
    expect(pick(qs, 'averageYear').amounts[groceries]).toBe(20000);
  });

  it('uses the months available, and leaves averages out with under two months', () => {
    const { b, groceries } = setup();
    const c = compute(b, '2026-10');
    expect(monthsOfHistory(c, '2026-10', 12)).toBe(3);
    expect(monthsOfHistory(c, '2026-08', 3)).toBe(1);
    const aug = quickBudgetChoices(b, compute(b, '2026-08'), [groceries], '2026-08');
    expect(aug.some((q) => q.kind === 'average3' || q.kind === 'averageYear')).toBe(false);
    const sep = quickBudgetChoices(b, compute(b, '2026-09'), [groceries], '2026-09');
    expect(pick(sep, 'average3').label).toBe('Average outflows for the last 2 months');
    expect(pick(sep, 'average3').amounts[groceries]).toBe(25000);
  });

  it('counts refunds as nothing spent, not a negative budget', () => {
    const { b, fun } = setup();
    const qs = quickBudgetChoices(b, compute(b, '2026-10'), [fun], '2026-10');
    expect(pick(qs, 'outflowsLastMonth').amounts[fun]).toBe(0);
    expect(pick(qs, 'average3').amounts[fun]).toBe(0);
  });

  it('balances to zero, and totals the scheduled outflows due this month', () => {
    const { b, checking, groceries, power } = setup();
    saveScheduled(b, { accountId: checking, date: '2026-10-03', startDate: '2026-10-03', frequency: 'Weekly', categoryId: power, amount: -1000 });
    const c = compute(b, '2026-10');
    const qs = quickBudgetChoices(b, c, [groceries, power], '2026-10');
    // Groceries carries £150 into October, so balancing to zero budgets -£150.
    expect(pick(qs, 'balanceToZero').amounts[groceries]).toBe(-15000);
    // Weekly from the 3rd: the 3rd, 10th, 17th, 24th and 31st.
    expect(pick(qs, 'scheduled').amounts[power]).toBe(5000);
  });
});

describe('filling a month', () => {
  it('fills only the empty cells, unless overwriting', () => {
    const { b, groceries, rent } = setup();
    const c = compute(b, '2026-10');
    const last = pick(quickBudgetChoices(b, c, [groceries, rent], '2026-10'), 'budgetedLastMonth');
    expect(quickFill(b, last, '2026-10')).toEqual({ [groceries]: 25000 });
    expect(quickFill(b, last, '2026-10', true)).toEqual({ [groceries]: 25000, [rent]: 80000 });
  });
});
