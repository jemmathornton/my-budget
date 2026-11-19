import { addMonths, lastDayOfMonth } from './dates';
import { categoryMonth, type Computed } from './engine';
import { scheduledOccurrences } from './schedule';
import { SPLIT, type Budget, type Id, type Money, type MonthKey } from './types';

// YNAB4's Quick Budget: amounts worked out from a category's history, offered for one budget
// cell (its drop-down) or a whole month (the lightning bolt in the month heading).

export type QuickKind = 'budgetedLastMonth' | 'outflowsLastMonth' | 'scheduled' | 'average3' | 'averageYear' | 'balanceToZero';

export interface QuickChoice {
  kind: QuickKind;
  /** YNAB4's wording, as in its month menu. */
  label: string;
  /** The budgeted amount each category would get. */
  amounts: Record<Id, Money>;
}

/** How many whole months of budget history there are before `month` (at most `max`). */
export function monthsOfHistory(c: Computed, month: MonthKey, max: number): number {
  let n = 0;
  for (let m = addMonths(month, -1); n < max && m >= c.first; m = addMonths(m, -1)) n++;
  return n;
}

/**
 * The Quick Budget choices for some categories in a month, in YNAB4's order. The averages use
 * the months available (YNAB4 said "only N months available"), and are left out with less than
 * two months of history, when they would just repeat last month.
 */
export function quickBudgetChoices(b: Budget, c: Computed, ids: Id[], month: MonthKey): QuickChoice[] {
  const prev = addMonths(month, -1);
  const make = (kind: QuickKind, label: string, f: (id: Id) => Money): QuickChoice => {
    const amounts: Record<Id, Money> = {};
    for (const id of ids) amounts[id] = f(id);
    return { kind, label, amounts };
  };
  // Outflows are spending: a month with more refunds than spending counts as nothing spent.
  const averageOutflows = (n: number) => (id: Id) => {
    let total = 0;
    for (let i = 1; i <= n; i++) total += categoryMonth(c, addMonths(month, -i), id).activity;
    return Math.max(0, Math.round(-total / n));
  };
  const out: QuickChoice[] = [
    make('budgetedLastMonth', 'Budget values used last month', (id) => categoryMonth(c, prev, id).budgeted),
    make('outflowsLastMonth', 'Outflows last month', (id) => Math.max(0, -categoryMonth(c, prev, id).activity)),
    make('scheduled', 'Total scheduled outflows this month', (id) => Math.max(0, -scheduledForCategory(b, id, month))),
  ];
  const n3 = monthsOfHistory(c, month, 3);
  if (n3 >= 2) out.push(make('average3', `Average outflows for the last ${n3} months`, averageOutflows(n3)));
  const n12 = monthsOfHistory(c, month, 12);
  if (n12 >= 2) {
    const label = 'Average outflows for the last year' + (n12 < 12 ? ` (only ${n12} months available)` : '');
    out.push(make('averageYear', label, averageOutflows(n12)));
  }
  out.push(
    make('balanceToZero', 'Balance to 0.00', (id) => {
      const d = categoryMonth(c, month, id);
      return d.budgeted - d.balance;
    }),
  );
  return out;
}

/** Scheduled transactions due in `month` in a category, on budget accounts (negative = out). */
export function scheduledForCategory(b: Budget, catId: Id, month: MonthKey): Money {
  let total = 0;
  for (const s of Object.values(b.scheduled)) {
    if (!b.accounts[s.accountId]?.onBudget) continue;
    // Enough steps to reach a month years ahead, even for a daily schedule (1.5.3).
    const n = scheduledOccurrences(s, lastDayOfMonth(month), 20000).filter((d) => d.startsWith(month)).length;
    if (!n) continue;
    if (s.categoryId === SPLIT) for (const sp of s.splits || []) total += sp.categoryId === catId ? sp.amount * n : 0;
    else if (s.categoryId === catId) total += s.amount * n;
  }
  return total;
}

/**
 * The amounts a whole-month fill would set: only the empty cells (YNAB4's way), or every cell
 * with `overwrite`. Cells that wouldn't change are left out.
 */
export function quickFill(b: Budget, choice: QuickChoice, month: MonthKey, overwrite = false): Record<Id, Money> {
  const out: Record<Id, Money> = {};
  for (const [id, amount] of Object.entries(choice.amounts)) {
    const now = b.months[month]?.[id]?.budgeted || 0;
    if ((overwrite || now === 0) && amount !== now) out[id] = amount;
  }
  return out;
}
