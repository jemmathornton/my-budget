import { addMonths, monthLabel, monthOf } from '../../model/dates';
import { categoryMonth, type Computed } from '../../model/engine';
import { formatMoney } from '../../model/money';
import { categoriesOf, payeeUsage, sortedAccounts, sortedMasters, transferPayeeId } from '../../model/queries';
import { INCOME_NEXT, INCOME_NOW, SPLIT, type Budget, type Id, type ISODate } from '../../model/types';
import type { Option } from './inputs';

// Option lists for the autocomplete boxes.

/**
 * Categories grouped by master category. With `computed` and a date, each shows its
 * balance for that month as a hint, like YNAB4.
 */
export function categoryOptions(
  b: Budget,
  opts: {
    date?: ISODate;
    computed?: Computed | null;
    income?: boolean;
    split?: boolean;
    includeHidden?: boolean;
    uncategorized?: boolean;
  } = {},
): Option[] {
  const out: Option[] = [];
  const month = opts.date ? monthOf(opts.date) : undefined;
  if (opts.uncategorized) out.push({ value: '', label: '(No category)', group: 'Other' });
  if (opts.income !== false) {
    out.push({
      value: INCOME_NOW,
      label: month ? `Income for ${monthLabel(month, true)}` : 'Income for this month',
      group: 'Income',
    });
    out.push({
      value: INCOME_NEXT,
      label: month ? `Income for ${monthLabel(addMonths(month, 1), true)}` : 'Income for next month',
      group: 'Income',
    });
  }
  for (const m of sortedMasters(b)) {
    for (const c of categoriesOf(b, m.id, opts.includeHidden)) {
      let hint: string | undefined;
      let hintNeg = false;
      if (opts.computed && month) {
        const bal = categoryMonth(opts.computed, month, c.id).balance;
        hint = formatMoney(bal);
        hintNeg = bal < 0;
      }
      out.push({ value: c.id, label: c.name + (c.hidden ? ' (hidden)' : ''), group: m.name, hint, hintNeg });
    }
  }
  if (opts.split) out.push({ value: SPLIT, label: 'Split (multiple categories)…', group: 'Other' });
  return out;
}

/** Payees plus "Transfer : <account>" entries for the other open accounts. */
export function payeeOptions(b: Budget, currentAccountId?: Id): Option[] {
  const out: Option[] = [];
  // Ranked by use, so typing "te" offers the Tesco used every week before one used once.
  const uses = payeeUsage(b);
  for (const a of sortedAccounts(b)) {
    if (a.closed || a.id === currentAccountId) continue;
    out.push({ value: 'transfer:' + a.id, label: 'Transfer : ' + a.name, group: 'Transfer to/from account', rank: uses.get(transferPayeeId(a.id)) || 0 });
  }
  const payees = Object.values(b.payees)
    .filter((p) => !p.transferAccountId && !p.hidden)
    .sort((x, y) => x.name.localeCompare(y.name));
  for (const p of payees) out.push({ value: p.id, label: p.name, group: 'Payees', rank: uses.get(p.id) || 0 });
  return out;
}

export function accountOptions(b: Budget, opts: { includeClosed?: boolean; exclude?: Id } = {}): Option[] {
  return sortedAccounts(b)
    .filter((a) => (opts.includeClosed || !a.closed) && a.id !== opts.exclude)
    .map((a) => ({ value: a.id, label: a.name, group: a.onBudget ? 'Budget accounts' : 'Off-budget accounts' }));
}
