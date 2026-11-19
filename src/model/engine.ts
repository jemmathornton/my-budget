import { addMonths, isMonthKey, monthOf, monthRange, thisMonth } from './dates';
import {
  CREDIT_ACCOUNT_TYPES,
  INCOME_NEXT,
  INCOME_NOW,
  SPLIT,
  type Budget,
  type Id,
  type Money,
  type MonthKey,
  type OverspendingHandling,
  type Transaction,
} from './types';

// The budget maths. Checked against the user's real YNAB4 history; see HANDOVER.md
// ("YNAB4 behaviour") before changing anything here.
//
// For each category and month:
//   balance = carried in from last month + budgeted + activity
// A positive balance always carries forward. A negative balance either carries forward
// (handling "carry") or is reset to zero, and the overspending is taken from next month's
// Available to Budget (handling "buffer", the default).
//
// For each month:
//   Available to Budget = last month's Available to Budget (not budgeted)
//                       - last month's overspending
//                       + this month's income
//                       - this month's budgeted
// and then any later month's shortfall is shown as "budgeted in future".

export interface CategoryMonthData {
  budgeted: Money;
  /** All activity: outflows are negative, refunds positive. */
  activity: Money;
  /** Activity in cash (non-credit) accounts. */
  cashActivity: Money;
  /** Activity in credit card and line of credit accounts. */
  creditActivity: Money;
  /** Balance carried in from the previous month. */
  carryIn: Money;
  balance: Money;
  handling: OverspendingHandling;
  /** The part of a negative balance caused by cash spending (red). */
  cashOver: Money;
  /** The part of a negative balance caused by credit spending (only treated differently with the card-debt setting). */
  creditOver: Money;
}

export interface MonthSummary {
  month: MonthKey;
  /** Last month's Available to Budget (negative = over budgeted last month). */
  notBudgetedPrev: Money;
  /** Last month's overspending, as a negative number. */
  overspentPrev: Money;
  income: Money;
  budgeted: Money;
  /** Money held back because a later month is over budgeted. */
  budgetedInFuture: Money;
  /** Available to Budget before "budgeted in future". */
  atbRaw: Money;
  /** Available to Budget. */
  atb: Money;
  /** Total category activity this month. */
  activity: Money;
  /** Total of all category balances at the end of the month. */
  balanceTotal: Money;
  cashOverspent: Money;
  creditOverspent: Money;
}

export interface AccountTotals {
  cleared: Money;
  uncleared: Money;
  working: Money;
  count: number;
  /** Imported transactions waiting to be approved. */
  unapproved: number;
}

export interface Computed {
  first: MonthKey;
  last: MonthKey;
  months: MonthKey[];
  cat: Map<MonthKey, Map<Id, CategoryMonthData>>;
  summary: Map<MonthKey, MonthSummary>;
  accounts: Map<Id, AccountTotals>;
  /** Budget-account transactions that need a category. */
  uncategorized: Id[];
  /** Working balance of all budget accounts. */
  budgetAccountsTotal: Money;
}

export function emptyCategoryMonth(handling: OverspendingHandling = 'buffer'): CategoryMonthData {
  return {
    budgeted: 0,
    activity: 0,
    cashActivity: 0,
    creditActivity: 0,
    carryIn: 0,
    balance: 0,
    handling,
    cashOver: 0,
    creditOver: 0,
  };
}

export interface CategoryLine {
  categoryId: Id | null;
  amount: Money;
  transferAccountId?: Id;
}

/** The category lines of a transaction: its splits, or the transaction itself. */
export function categoryLines(t: Transaction): CategoryLine[] {
  if (t.categoryId === SPLIT && t.splits && t.splits.length) {
    return t.splits.map((s) => ({ categoryId: s.categoryId, amount: s.amount, transferAccountId: s.transferAccountId }));
  }
  return [{ categoryId: t.categoryId, amount: t.amount, transferAccountId: t.transferAccountId }];
}

/**
 * Computes every month from the first month with data to one month past the later of
 * the last month with data and this month (or `until`, if later).
 */
export function compute(b: Budget, until?: MonthKey): Computed {
  const creditToDebt = !!b.settings?.creditOverspendingToDebt;
  const accounts = new Map<Id, AccountTotals>();
  for (const a of Object.values(b.accounts)) {
    accounts.set(a.id, { cleared: 0, uncleared: 0, working: 0, count: 0, unapproved: 0 });
  }

  // month -> category -> [cash activity, credit activity]
  const activity = new Map<MonthKey, Map<Id, [Money, Money]>>();
  const income = new Map<MonthKey, Money>();
  const uncategorized: Id[] = [];
  let first = '9999-99';
  let last = '0000-00';
  let budgetAccountsTotal = 0;

  for (const t of Object.values(b.transactions)) {
    const acc = b.accounts[t.accountId];
    if (!acc) continue;
    const tot = accounts.get(acc.id)!;
    tot.working += t.amount;
    if (t.cleared === 'U') tot.uncleared += t.amount;
    else tot.cleared += t.amount;
    tot.count++;
    if (!t.accepted) tot.unapproved++;
    if (!acc.onBudget) continue;

    budgetAccountsTotal += t.amount;
    const month = monthOf(t.date);
    if (month < first) first = month;
    if (month > last) last = month;
    const credit = CREDIT_ACCOUNT_TYPES.includes(acc.type) ? 1 : 0;
    for (const line of categoryLines(t)) {
      const cid = line.categoryId;
      if (cid === INCOME_NOW) {
        income.set(month, (income.get(month) || 0) + line.amount);
      } else if (cid === INCOME_NEXT) {
        const next = addMonths(month, 1);
        income.set(next, (income.get(next) || 0) + line.amount);
      } else if (cid && cid !== SPLIT && b.categories[cid]) {
        let m = activity.get(month);
        if (!m) activity.set(month, (m = new Map()));
        let pair = m.get(cid);
        if (!pair) m.set(cid, (pair = [0, 0]));
        pair[credit] += line.amount;
      } else {
        // No category. Fine for a transfer to another budget account; otherwise it needs one.
        const other = line.transferAccountId ? b.accounts[line.transferAccountId] : undefined;
        if ((other && other.onBudget) || line.amount === 0) continue;
        if (uncategorized[uncategorized.length - 1] !== t.id) uncategorized.push(t.id);
      }
    }
  }

  for (const [month, cats] of Object.entries(b.months)) {
    if (!isMonthKey(month)) continue;
    let used = false;
    for (const v of Object.values(cats)) {
      if (v.budgeted || v.handling || v.note) {
        used = true;
        break;
      }
    }
    if (used) {
      if (month < first) first = month;
      if (month > last) last = month;
    }
  }

  const now = thisMonth();
  if (first === '9999-99') first = now;
  let end = last > now ? last : now;
  end = addMonths(end, 1);
  if (until && until > end) end = until;
  const months = monthRange(first, end);
  const catIds = Object.keys(b.categories);

  const handlingNow = new Map<Id, OverspendingHandling>();
  const carry = new Map<Id, Money>();
  const cat = new Map<MonthKey, Map<Id, CategoryMonthData>>();
  const summary = new Map<MonthKey, MonthSummary>();
  let notBudgetedPrev = 0;
  let overspentPrev = 0;

  for (const month of months) {
    const budgetMonth = b.months[month] || {};
    const act = activity.get(month);
    const monthData = new Map<Id, CategoryMonthData>();
    let budgeted = 0;
    let activityTotal = 0;
    let balanceTotal = 0;
    let cashOverspent = 0;
    let creditOverspent = 0;

    for (const cid of catIds) {
      const entry = budgetMonth[cid];
      // The overspending setting carries on into later months until it is changed.
      if (entry?.handling) handlingNow.set(cid, entry.handling);
      const handling = handlingNow.get(cid) || 'buffer';
      const d = emptyCategoryMonth(handling);
      d.carryIn = carry.get(cid) || 0;
      d.budgeted = entry?.budgeted || 0;
      const pair = act?.get(cid);
      if (pair) {
        d.cashActivity = pair[0];
        d.creditActivity = pair[1];
        d.activity = pair[0] + pair[1];
      }
      d.balance = d.carryIn + d.budgeted + d.activity;
      if (d.balance < 0) {
        const over = -d.balance;
        const creditSpend = Math.max(0, -d.creditActivity);
        d.creditOver = Math.min(over, creditSpend);
        d.cashOver = over - d.creditOver;
      }
      if (d.balance >= 0 || handling === 'carry') {
        carry.set(cid, d.balance);
      } else {
        carry.set(cid, 0);
        cashOverspent += d.cashOver;
        creditOverspent += d.creditOver;
      }
      budgeted += d.budgeted;
      activityTotal += d.activity;
      balanceTotal += d.balance;
      monthData.set(cid, d);
    }
    cat.set(month, monthData);

    const inc = income.get(month) || 0;
    const atb = notBudgetedPrev - overspentPrev + inc - budgeted;
    summary.set(month, {
      month,
      notBudgetedPrev,
      overspentPrev: -overspentPrev,
      income: inc,
      budgeted,
      budgetedInFuture: 0,
      atbRaw: atb,
      atb,
      activity: activityTotal,
      balanceTotal,
      cashOverspent,
      creditOverspent,
    });
    notBudgetedPrev = atb;
    overspentPrev = cashOverspent + (creditToDebt ? 0 : creditOverspent);
  }

  // Money budgeted in a later month beyond that month's income is held back from earlier months.
  let shortfall = 0;
  for (let i = months.length - 1; i >= 0; i--) {
    const s = summary.get(months[i])!;
    const held = Math.min(Math.max(0, -shortfall), Math.max(0, s.atbRaw));
    s.budgetedInFuture = held;
    s.atb = s.atbRaw - held;
    shortfall = Math.min(0, s.income - s.budgeted + shortfall);
  }

  return { first, last: end, months, cat, summary, accounts, uncategorized, budgetAccountsTotal };
}

export function categoryMonth(c: Computed, month: MonthKey, categoryId: Id): CategoryMonthData {
  return c.cat.get(month)?.get(categoryId) || emptyCategoryMonth();
}

export function monthSummary(c: Computed, month: MonthKey): MonthSummary | undefined {
  return c.summary.get(month);
}
