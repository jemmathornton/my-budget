// Report data: pure functions over a Budget (no React). Amounts are integer minor units.
//
// Every transaction in a budget account is broken into its category lines once per budget
// object (see `index`), sorted by date, so each report is a quick pass over the lines in its
// date range. Results are cached per (budget object, report, range, filters): the budget is
// immutable (immer), so a new object means the data changed.

import { addMonths, monthLabel, monthName, monthOf, monthRange } from '../../model/dates';
import { categoryLines } from '../../model/engine';
import { getCurrency } from '../../model/money';
import { transferPayeeName } from '../../model/queries';
import { INCOME_NEXT, INCOME_NOW, SPLIT, type Budget, type Id, type ISODate, type Money, type MonthKey } from '../../model/types';

// ---- Date ranges ---------------------------------------------------------------------------

export type RangePreset =
  | 'this-month'
  | 'last-month'
  | 'latest-3'
  | 'this-year'
  | 'last-year'
  | 'last-12'
  | 'all'
  | 'custom';

export const RANGE_PRESETS: { id: RangePreset; label: string }[] = [
  { id: 'this-month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'latest-3', label: 'Latest 3 months' },
  { id: 'this-year', label: 'This year' },
  { id: 'last-year', label: 'Last year' },
  { id: 'last-12', label: 'Last 12 months' },
  { id: 'all', label: 'All dates' },
  { id: 'custom', label: 'Custom' },
];

export function isRangePreset(v: unknown): v is RangePreset {
  return RANGE_PRESETS.some((p) => p.id === v);
}

/** An inclusive range of months. */
export interface MonthSpan {
  from: MonthKey;
  to: MonthKey;
}

/**
 * The months a preset covers on `today`. "Latest 3 months", "This year" and "Last 12 months"
 * end with the current month. "All dates" is `bounds` (the first to the last month with
 * transactions); "Custom" is `custom`, put in order.
 */
export function resolveRange(
  preset: RangePreset,
  today: ISODate,
  opts: { bounds?: MonthSpan | null; custom?: MonthSpan | null } = {},
): MonthSpan {
  const now = monthOf(today);
  const year = +now.slice(0, 4);
  switch (preset) {
    case 'this-month':
      return { from: now, to: now };
    case 'last-month': {
      const m = addMonths(now, -1);
      return { from: m, to: m };
    }
    case 'latest-3':
      return { from: addMonths(now, -2), to: now };
    case 'this-year':
      return { from: `${year}-01`, to: now };
    case 'last-year':
      return { from: `${year - 1}-01`, to: `${year - 1}-12` };
    case 'last-12':
      return { from: addMonths(now, -11), to: now };
    case 'all':
      return opts.bounds ? { from: opts.bounds.from, to: opts.bounds.to } : { from: now, to: now };
    case 'custom': {
      const c = opts.custom;
      if (!c) return { from: now, to: now };
      return c.from <= c.to ? { from: c.from, to: c.to } : { from: c.to, to: c.from };
    }
  }
}

/** "Oct 2026", "Jan–Mar 2026" or "Nov 2025 – Oct 2026". */
export function rangeLabel(from: MonthKey, to: MonthKey): string {
  if (from === to) return monthLabel(from, true);
  if (from.slice(0, 4) === to.slice(0, 4)) return `${monthName(from, true)}–${monthName(to, true)} ${to.slice(0, 4)}`;
  return `${monthLabel(from, true)} – ${monthLabel(to, true)}`;
}

// ---- Filters -------------------------------------------------------------------------------

export interface ReportFilters {
  from: MonthKey;
  to: MonthKey;
  /**
   * Accounts to include; null = all. Spending, Income v Expense and Spending Trends only ever
   * use budget accounts, so null means "all budget accounts" there and "all accounts" in Net Worth.
   */
  accounts: Id[] | null;
  /** Count spending in hidden categories. */
  includeHidden: boolean;
  /**
   * Spending categories to include (UNCATEGORISED for uncategorised spending); null or missing =
   * all. Income is never filtered out. YNAB4's "Selected Categories" filter.
   */
  categories?: Id[] | null;
  /**
   * Payees, as `ReportLine.payeeKey`s ("" for no payee, "transfer:<account>" for a transfer):
   * only these, or all but these (`except`); null or missing = all. Unlike categories, it applies
   * to income too (1.5). "All but" keeps payees the date range didn't show when it was chosen.
   */
  payees?: PayeeFilter | null;
}

export interface PayeeFilter {
  keys: string[];
  except: boolean;
}

/** Whether a payee is counted under a Payees filter. */
export function payeeCounted(f: PayeeFilter | null | undefined, key: string): boolean {
  return !f || f.keys.includes(key) !== f.except;
}

function filterKey(f: ReportFilters): string {
  const acc = f.accounts ? [...f.accounts].sort().join(',') : '*';
  const cats = f.categories ? [...f.categories].sort().join(',') : '*';
  // JSON, so "none" and "only (No payee)" ([] and [""]) differ.
  const payees = f.payees ? JSON.stringify([f.payees.except, [...f.payees.keys].sort()]) : '*';
  return `${f.from}|${f.to}|${acc}|${f.includeHidden ? 1 : 0}|${cats}|${payees}`;
}

// ---- The line index ------------------------------------------------------------------------

/** The pseudo category and master category of uncategorised spending. */
export const UNCATEGORISED = '__uncategorised__';
/** The key of the folded "Other" series or segment. */
export const OTHER = '__other__';

/** One category line of a transaction in a budget account. */
export interface ReportLine {
  txId: Id;
  accountId: Id;
  date: ISODate;
  month: MonthKey;
  /** An "Income for this month" or "Income for next month" line. */
  income: boolean;
  /** The category: a real one, INCOME_NOW / INCOME_NEXT, or UNCATEGORISED. */
  categoryId: Id;
  /** The category's master category; UNCATEGORISED for uncategorised lines, '' for income. */
  masterId: Id;
  /** In a hidden category. */
  hidden: boolean;
  /** The payee id, "transfer:<accountId>" for transfers, or '' for none. */
  payeeKey: string;
  /** As entered: outflows negative. */
  amount: Money;
}

interface BudgetIndex {
  /** Lines of budget-account transactions, sorted by date. */
  lines: ReportLine[];
  /** First and last month with any transaction (any account). */
  bounds: MonthSpan | null;
  /** Account -> month -> total of that month's transactions (all accounts). */
  accountMonths: Map<Id, Map<MonthKey, Money>>;
  /** Spending rank (0 = biggest, all dates) of each master category, category (within its master) and payee. */
  rank: { master: Map<string, number>; category: Map<string, number>; payee: Map<string, number> };
}

const indexes = new WeakMap<Budget, BudgetIndex>();
const results = new WeakMap<Budget, Map<string, unknown>>();

function memo<T>(b: Budget, key: string, fn: () => T): T {
  let m = results.get(b);
  if (!m) results.set(b, (m = new Map()));
  if (m.has(key)) return m.get(key) as T;
  const v = fn();
  m.set(key, v);
  if (m.size > 80) m.delete(m.keys().next().value!);
  return v;
}

function index(b: Budget): BudgetIndex {
  let idx = indexes.get(b);
  if (!idx) indexes.set(b, (idx = buildIndex(b)));
  return idx;
}

function buildIndex(b: Budget): BudgetIndex {
  const lines: ReportLine[] = [];
  const accountMonths = new Map<Id, Map<MonthKey, Money>>();
  let first = '';
  let last = '';
  for (const t of Object.values(b.transactions)) {
    const acc = b.accounts[t.accountId];
    if (!acc) continue;
    const month = monthOf(t.date);
    if (!first || month < first) first = month;
    if (!last || month > last) last = month;
    let am = accountMonths.get(acc.id);
    if (!am) accountMonths.set(acc.id, (am = new Map()));
    am.set(month, (am.get(month) || 0) + t.amount);
    if (!acc.onBudget) continue;

    const isSplit = t.categoryId === SPLIT && !!t.splits?.length;
    categoryLines(t).forEach((line, i) => {
      if (!line.amount) return;
      const split = isSplit ? t.splits![i] : undefined;
      const transferTo = line.transferAccountId;
      const payeeKey = transferTo ? 'transfer:' + transferTo : split?.payeeId || t.payeeId || '';
      const cid = line.categoryId;
      const base = { txId: t.id, accountId: acc.id, date: t.date, month, payeeKey, amount: line.amount };
      if (cid === INCOME_NOW || cid === INCOME_NEXT) {
        lines.push({ ...base, income: true, categoryId: cid, masterId: '', hidden: false });
        return;
      }
      const cat = cid ? b.categories[cid] : undefined;
      if (cat) {
        lines.push({ ...base, income: false, categoryId: cat.id, masterId: cat.masterId, hidden: !!cat.hidden });
        return;
      }
      // No category: fine for a transfer to another budget account (not spending at all).
      const other = transferTo ? b.accounts[transferTo] : undefined;
      if (other && other.onBudget) return;
      lines.push({ ...base, income: false, categoryId: UNCATEGORISED, masterId: UNCATEGORISED, hidden: false });
    });
  }
  lines.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));

  const spend = { master: new Map<string, number>(), category: new Map<string, number>(), payee: new Map<string, number>() };
  const catMaster = new Map<Id, Id>();
  for (const l of lines) {
    if (l.income) continue;
    spend.master.set(l.masterId, (spend.master.get(l.masterId) || 0) - l.amount);
    spend.category.set(l.categoryId, (spend.category.get(l.categoryId) || 0) - l.amount);
    spend.payee.set(l.payeeKey, (spend.payee.get(l.payeeKey) || 0) - l.amount);
    catMaster.set(l.categoryId, l.masterId);
  }
  const ordered = (m: Map<string, number>) => [...m.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  const toRank = (m: Map<string, number>) => new Map(ordered(m).map(([k], i) => [k, i] as [string, number]));
  // Categories are only ever shown within their master category, so rank them there.
  const category = new Map<string, number>();
  const seen = new Map<Id, number>();
  for (const [cid] of ordered(spend.category)) {
    const mid = catMaster.get(cid)!;
    const i = seen.get(mid) || 0;
    category.set(cid, i);
    seen.set(mid, i + 1);
  }
  return {
    lines,
    bounds: first ? { from: first, to: last } : null,
    accountMonths,
    rank: { master: toRank(spend.master), category, payee: toRank(spend.payee) },
  };
}

/** The first and last month with transactions, or null for an empty budget. */
export function dataBounds(b: Budget): MonthSpan | null {
  return index(b).bounds;
}

/**
 * Spending rank over all dates (0 = most spent), used to give things the same colour everywhere.
 * Categories are ranked within their master category.
 */
export function spendingRank(b: Budget, kind: 'master' | 'category' | 'payee'): Map<string, number> {
  return index(b).rank[kind];
}

/**
 * The payees with lines from one month to another in the chosen accounts (null = all), for the
 * Payees filter: most spent first, then by name.
 */
export function payeesInRange(b: Budget, from: MonthKey, to: MonthKey, accounts: Id[] | null = null): string[] {
  const accKey = accounts ? [...accounts].sort().join(',') : '*';
  return memo(b, `payees|${from}|${to}|${accKey}`, () => {
    const all = index(b).lines;
    const end = lowerBound(all, addMonths(to, 1));
    const only = accounts ? new Set(accounts) : null;
    const keys = new Set<string>();
    for (let i = lowerBound(all, from); i < end; i++) if (!only || only.has(all[i].accountId)) keys.add(all[i].payeeKey);
    const rank = index(b).rank.payee;
    return [...keys].sort((x, y) => (rank.get(x) ?? Infinity) - (rank.get(y) ?? Infinity) || payeeKeyName(b, x).localeCompare(payeeKeyName(b, y)));
  });
}

/** Index of the first line in or after `month`. */
function lowerBound(lines: ReportLine[], month: MonthKey): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].month < month) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The lines in the filters' range and accounts; hidden-category spending only if included. */
function linesFor(b: Budget, f: ReportFilters): ReportLine[] {
  return memo(b, 'lines|' + filterKey(f), () => {
    const all = index(b).lines;
    const end = lowerBound(all, addMonths(f.to, 1));
    const acc = f.accounts ? new Set(f.accounts) : null;
    const cats = f.categories ? new Set(f.categories) : null;
    const payees = f.payees ? { keys: new Set(f.payees.keys), except: f.payees.except } : null;
    const out: ReportLine[] = [];
    for (let i = lowerBound(all, f.from); i < end; i++) {
      const l = all[i];
      if (acc && !acc.has(l.accountId)) continue;
      if (l.hidden && !f.includeHidden) continue;
      if (cats && !l.income && !cats.has(l.categoryId)) continue;
      if (payees && payees.keys.has(l.payeeKey) === payees.except) continue;
      out.push(l);
    }
    return out;
  });
}

// ---- Names ---------------------------------------------------------------------------------

export function masterName(b: Budget, id: Id): string {
  if (id === UNCATEGORISED) return 'Uncategorised';
  return b.masters[id]?.name ?? '(No group)';
}

export function categoryName(b: Budget, id: Id): string {
  if (id === UNCATEGORISED) return 'Uncategorised';
  return b.categories[id]?.name ?? '(Deleted category)';
}

export function payeeKeyName(b: Budget, key: string): string {
  if (!key) return '(No payee)';
  if (key.startsWith('transfer:')) return transferPayeeName(b, key.slice(9));
  return b.payees[key]?.name ?? '(Deleted payee)';
}

// ---- Selecting transactions ----------------------------------------------------------------

/** Picks report lines; every field given must match. */
export interface LineSelector {
  income?: boolean;
  masterId?: Id;
  categoryId?: Id;
  payeeKey?: string;
  month?: MonthKey;
}

/** The ids of the transactions behind a report row or cell (split transactions once). */
export function selectTransactionIds(b: Budget, f: ReportFilters, sel: LineSelector): Id[] {
  const seen = new Set<Id>();
  const income = !!sel.income;
  for (const l of linesFor(b, f)) {
    if (l.income !== income) continue;
    if (sel.masterId !== undefined && l.masterId !== sel.masterId) continue;
    if (sel.categoryId !== undefined && l.categoryId !== sel.categoryId) continue;
    if (sel.payeeKey !== undefined && l.payeeKey !== sel.payeeKey) continue;
    if (sel.month !== undefined && l.month !== sel.month) continue;
    seen.add(l.txId);
  }
  return [...seen];
}

// ---- Spending ------------------------------------------------------------------------------

export type SpendingBy = 'category' | 'payee';

export interface SpendingView {
  by: SpendingBy;
  /** Drilled into this master category (null = all spending). */
  masterId: Id | null;
}

export interface SpendingRow {
  key: string;
  name: string;
  /** Outflows minus refunds. */
  total: Money;
  average: Money;
  /** Fraction of the report total (0-1). */
  share: number;
  /** Clicking shows its sub-categories (a master category in the category view). */
  drillable: boolean;
  hidden?: boolean;
}

export interface SpendingReport {
  months: number;
  total: Money;
  average: Money;
  /** Biggest first. Rows that net to zero are left out. */
  rows: SpendingRow[];
}

/**
 * Spending (outflows minus refunds on category lines of budget accounts, leaving out income and
 * transfers between budget accounts) by master category, by the categories of one master
 * category, or by payee (optionally within one master category).
 */
export function spendingReport(b: Budget, f: ReportFilters, view: SpendingView): SpendingReport {
  const masterId = view.masterId || null;
  return memo(b, `spend|${view.by}|${masterId ?? ''}|${filterKey(f)}`, () => {
    const months = monthRange(f.from, f.to).length;
    const totals = new Map<string, Money>();
    for (const l of linesFor(b, f)) {
      if (l.income) continue;
      if (masterId && l.masterId !== masterId) continue;
      const key = view.by === 'payee' ? l.payeeKey : masterId ? l.categoryId : l.masterId;
      totals.set(key, (totals.get(key) || 0) - l.amount);
    }
    let total = 0;
    for (const v of totals.values()) total += v;
    const rows: SpendingRow[] = [];
    for (const [key, v] of totals) {
      if (!v) continue;
      let name: string;
      let drillable = false;
      let hidden: boolean | undefined;
      if (view.by === 'payee') name = payeeKeyName(b, key);
      else if (masterId) {
        name = categoryName(b, key);
        hidden = !!b.categories[key]?.hidden;
      } else {
        name = masterName(b, key);
        drillable = key !== UNCATEGORISED;
      }
      rows.push({ key, name, total: v, average: Math.round(v / months), share: total ? v / total : 0, drillable, hidden });
    }
    rows.sort((x, y) => y.total - x.total || x.name.localeCompare(y.name));
    return { months, total, average: Math.round(total / months), rows };
  });
}

// ---- Colour slots --------------------------------------------------------------------------

/** The number of categorical colours. */
export const SLOT_COUNT = 8;

/**
 * Gives each key one of `count` colour slots. A key keeps the slot of its all-dates `rank`
 * where it can, so the same category is the same colour in every report and date range;
 * the rest take the free slots in order.
 */
export function assignSlots(keys: string[], rank: Map<string, number>, count = SLOT_COUNT): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  for (const k of keys) {
    const r = rank.get(k);
    if (r !== undefined && r < count && !used.has(r)) {
      out.set(k, r);
      used.add(r);
    }
  }
  let next = 0;
  for (const k of keys) {
    if (out.has(k)) continue;
    while (used.has(next)) next++;
    if (next >= count) break;
    out.set(k, next);
    used.add(next);
  }
  return out;
}

export interface Segment {
  key: string;
  name: string;
  value: Money;
  /** Colour slot; -1 for "Other". */
  slot: number;
  /** The row keys it covers (several for "Other"). */
  keys: string[];
}

/**
 * Donut segments: the biggest `max` positive rows, each with its colour slot, in slot order,
 * then "Other" for the rest. Negative rows (net refunds) can't be drawn and are left out.
 */
export function pieSegments(
  rows: { key: string; name: string; total: Money }[],
  rank: Map<string, number>,
  max = SLOT_COUNT,
): Segment[] {
  const pos = rows.filter((r) => r.total > 0).sort((x, y) => y.total - x.total);
  const shown = pos.slice(0, max);
  const rest = pos.slice(max);
  const slots = assignSlots(
    shown.map((r) => r.key),
    rank,
    max,
  );
  const segs: Segment[] = shown
    .map((r) => ({ key: r.key, name: r.name, value: r.total, slot: slots.get(r.key) ?? -1, keys: [r.key] }))
    .sort((x, y) => x.slot - y.slot);
  if (rest.length) {
    segs.push({
      key: OTHER,
      name: `Other (${rest.length})`,
      value: rest.reduce((s, r) => s + r.total, 0),
      slot: -1,
      keys: rest.map((r) => r.key),
    });
  }
  return segs;
}

// ---- Income v Expense ----------------------------------------------------------------------

export interface IveRow {
  key: string;
  name: string;
  /** One value per month of the report. */
  values: Money[];
  total: Money;
  average: Money;
  hidden?: boolean;
}

export interface IveGroup extends IveRow {
  /** Its categories, in budget order. */
  children: IveRow[];
}

export interface IncomeExpenseReport {
  months: MonthKey[];
  /** By payee, biggest first. Income for next month counts in the month it was received. */
  income: IveRow[];
  incomeTotal: IveRow;
  /** By master category (budget order), expenses positive. */
  expenses: IveGroup[];
  expenseTotal: IveRow;
  /** Income minus expenses. */
  net: IveRow;
}

function makeRow(key: string, name: string, values: Money[], extra: Partial<IveRow> = {}): IveRow {
  const total = values.reduce((s, v) => s + v, 0);
  return { key, name, values, total, average: Math.round(total / Math.max(1, values.length)), ...extra };
}

export function incomeExpenseReport(b: Budget, f: ReportFilters): IncomeExpenseReport {
  return memo(b, 'ive|' + filterKey(f), () => {
    const months = monthRange(f.from, f.to);
    const at = new Map(months.map((m, i) => [m, i]));
    const n = months.length;
    const income = new Map<string, Money[]>();
    const cats = new Map<string, Money[]>();
    for (const l of linesFor(b, f)) {
      const i = at.get(l.month)!;
      if (l.income) {
        let v = income.get(l.payeeKey);
        if (!v) income.set(l.payeeKey, (v = new Array(n).fill(0)));
        v[i] += l.amount;
      } else {
        let v = cats.get(l.categoryId);
        if (!v) cats.set(l.categoryId, (v = new Array(n).fill(0)));
        v[i] -= l.amount;
      }
    }
    const nonZero = (v: Money[]) => v.some((x) => x !== 0);

    const incomeRows = [...income.entries()]
      .filter(([, v]) => nonZero(v))
      .map(([k, v]) => makeRow(k, payeeKeyName(b, k), v))
      .sort((x, y) => y.total - x.total || x.name.localeCompare(y.name));

    // Group categories by master, in budget order (uncategorised last).
    const byMaster = new Map<Id, Id[]>();
    for (const [cid, v] of cats) {
      if (!nonZero(v)) continue;
      const mid = cid === UNCATEGORISED ? UNCATEGORISED : b.categories[cid]?.masterId ?? UNCATEGORISED;
      let list = byMaster.get(mid);
      if (!list) byMaster.set(mid, (list = []));
      list.push(cid);
    }
    const masterSort = (id: Id) => (id === UNCATEGORISED ? Infinity : b.masters[id]?.sort ?? 1e9);
    const groups: IveGroup[] = [...byMaster.entries()]
      .sort((x, y) => masterSort(x[0]) - masterSort(y[0]) || masterName(b, x[0]).localeCompare(masterName(b, y[0])))
      .map(([mid, cids]) => {
        const children = cids
          .sort((x, y) => (b.categories[x]?.sort ?? 1e9) - (b.categories[y]?.sort ?? 1e9))
          .map((cid) => makeRow(cid, categoryName(b, cid), cats.get(cid)!, { hidden: !!b.categories[cid]?.hidden }));
        const sum = new Array(n).fill(0);
        for (const c of children) c.values.forEach((v, i) => (sum[i] += v));
        return { ...makeRow(mid, masterName(b, mid), sum), children };
      });

    const sumRows = (rows: IveRow[]) => {
      const s = new Array(n).fill(0);
      for (const r of rows) r.values.forEach((v, i) => (s[i] += v));
      return s;
    };
    const incomeTotal = makeRow('income', 'Total income', sumRows(incomeRows));
    const expenseTotal = makeRow('expenses', 'Total expenses', sumRows(groups));
    const net = makeRow(
      'net',
      'Net income',
      incomeTotal.values.map((v, i) => v - expenseTotal.values[i]),
    );
    return { months, income: incomeRows, incomeTotal, expenses: groups, expenseTotal, net };
  });
}

// ---- Net Worth -----------------------------------------------------------------------------

export interface NetWorthPoint {
  month: MonthKey;
  /** Total of the accounts with a positive balance at the end of the month. */
  assets: Money;
  /** Total of the accounts with a negative balance (a negative number). */
  debts: Money;
  net: Money;
}

export interface NetWorthReport {
  points: NetWorthPoint[];
  /** At the end of the month before the range: the starting point for "change". */
  opening: NetWorthPoint;
}

/**
 * Month-end balances of every account (budget, off-budget and closed ones, as they were then),
 * or of `f.accounts`.
 */
export function netWorthReport(b: Budget, f: ReportFilters): NetWorthReport {
  const acc = f.accounts ? [...f.accounts].sort().join(',') : '*';
  return memo(b, `nw|${f.from}|${f.to}|${acc}`, () => {
    const idx = index(b);
    const ids = (f.accounts ?? Object.keys(b.accounts)).filter((id) => b.accounts[id]);
    const openMonth = addMonths(f.from, -1);
    const months = monthRange(f.from, f.to);
    const balances = ids.map((id) => {
      const am = idx.accountMonths.get(id);
      let bal = 0;
      if (am) for (const [m, v] of am) if (m <= openMonth) bal += v;
      return { am, bal };
    });
    const point = (month: MonthKey): NetWorthPoint => {
      let assets = 0;
      let debts = 0;
      for (const a of balances) {
        if (a.bal > 0) assets += a.bal;
        else debts += a.bal;
      }
      return { month, assets, debts, net: assets + debts };
    };
    const opening = point(openMonth);
    const points = months.map((m) => {
      for (const a of balances) a.bal += a.am?.get(m) || 0;
      return point(m);
    });
    return { points, opening };
  });
}

// ---- Spending Trends -----------------------------------------------------------------------

export interface TrendSeries {
  key: string;
  name: string;
  /** Colour slot; -1 for "Other". */
  slot: number;
  values: Money[];
  total: Money;
  /** The master categories it covers (several for "Other"). */
  members: string[];
}

export interface TrendsReport {
  months: MonthKey[];
  /** The biggest `top` master categories in slot order, then "Other". */
  series: TrendSeries[];
  /** All spending per month. */
  totals: Money[];
}

export function trendsReport(b: Budget, f: ReportFilters, top = SLOT_COUNT): TrendsReport {
  return memo(b, `trends|${top}|${filterKey(f)}`, () => {
    const months = monthRange(f.from, f.to);
    const at = new Map(months.map((m, i) => [m, i]));
    const n = months.length;
    const byMaster = new Map<string, Money[]>();
    for (const l of linesFor(b, f)) {
      if (l.income) continue;
      let v = byMaster.get(l.masterId);
      if (!v) byMaster.set(l.masterId, (v = new Array(n).fill(0)));
      v[at.get(l.month)!] -= l.amount;
    }
    const all = [...byMaster.entries()]
      .map(([key, values]) => ({ key, values, total: values.reduce((s, v) => s + v, 0) }))
      .filter((s) => s.values.some((v) => v !== 0))
      .sort((x, y) => y.total - x.total || (x.key < y.key ? -1 : 1));
    const shown = all.filter((s) => s.total > 0).slice(0, top);
    const shownKeys = new Set(shown.map((s) => s.key));
    const rest = all.filter((s) => !shownKeys.has(s.key));
    const slots = assignSlots(
      shown.map((s) => s.key),
      spendingRank(b, 'master'),
      Math.min(top, SLOT_COUNT),
    );
    const series: TrendSeries[] = shown
      .map((s) => ({
        key: s.key,
        name: masterName(b, s.key),
        slot: slots.get(s.key) ?? -1,
        values: s.values,
        total: s.total,
        members: [s.key],
      }))
      .sort((x, y) => x.slot - y.slot);
    if (rest.length) {
      const values = new Array(n).fill(0);
      for (const s of rest) s.values.forEach((v, i) => (values[i] += v));
      series.push({
        key: OTHER,
        name: 'Other',
        slot: -1,
        values,
        total: values.reduce((s, v) => s + v, 0),
        members: rest.map((s) => s.key),
      });
    }
    const totals = new Array(n).fill(0);
    for (const s of series) s.values.forEach((v, i) => (totals[i] += v));
    return { months, series, totals };
  });
}

// ---- Chart helpers -------------------------------------------------------------------------

/**
 * Round axis ticks covering [min, max] (always including 0), about `target` steps of
 * 1, 2 or 5 x 10^n, and never smaller than `minStep`. The domain [lo, hi] ends on a tick,
 * except that a side much smaller than one step (e.g. small debts beside large assets) gets
 * just a little room instead of a whole empty step.
 */
export function niceTicks(
  min: number,
  max: number,
  target = 5,
  minStep = 1,
): { lo: number; hi: number; step: number; ticks: number[] } {
  const a = Math.min(0, min);
  let z = Math.max(0, max);
  if (a === z) z = a + minStep * target;
  const raw = (z - a) / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = Math.max(minStep, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag);
  const small = step * 0.3;
  const lo = a < 0 && -a < small ? a * 1.2 : Math.floor(a / step) * step;
  const hi = z > 0 && z < small ? z * 1.2 : Math.ceil(z / step) * step;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step / 1e6; v += step) ticks.push(Math.round(v) || 0);
  return { lo, hi, step, ticks };
}

const compactFormats = new Map<string, Intl.NumberFormat>();

/** A short amount for chart axes: "£850", "£1.2k", "£45k", "-£3.5m". */
export function formatCompact(amount: Money): string {
  const c = getCurrency();
  const n = Math.abs(amount) / Math.pow(10, c.decimals);
  let num = n;
  let suffix = '';
  if (n >= 999_500) {
    num = n / 1e6;
    suffix = 'm';
  } else if (n >= 999.5) {
    num = n / 1e3;
    suffix = 'k';
  }
  const digits = suffix && num < 99.95 ? 1 : 0;
  const key = (c.locale || 'en-GB') + digits;
  let nf = compactFormats.get(key);
  if (!nf) compactFormats.set(key, (nf = new Intl.NumberFormat(c.locale || 'en-GB', { maximumFractionDigits: digits })));
  const text = nf.format(num) + suffix;
  const body = c.symbolFirst ? c.symbol + text : text + ' ' + c.symbol;
  return amount < 0 && text !== '0' ? '-' + body : body;
}

/** Percentage with one decimal: 0.2345 -> "23.5%". */
export function formatShare(share: number): string {
  if (!isFinite(share)) return '';
  return (Math.round(share * 1000) / 10).toFixed(1) + '%';
}

/**
 * Which months of a chart get an x-axis label, given the width of one month in pixels.
 * Wide enough: every month ("Oct", with the year under the first month and each January).
 * Otherwise every 2nd, 3rd, 4th, 6th or 12th calendar month; at 12, just the year.
 */
export function monthAxisLabels(months: MonthKey[], band: number): { i: number; label: string; sub?: string }[] {
  const out: { i: number; label: string; sub?: string }[] = [];
  if (band >= 30) {
    months.forEach((m, i) => {
      out.push({ i, label: monthName(m, true), sub: i === 0 || m.endsWith('-01') ? m.slice(0, 4) : undefined });
    });
    return out;
  }
  const step = [2, 3, 4, 6, 12].find((s) => s * band >= 34) ?? 24;
  months.forEach((m, i) => {
    const mi = +m.slice(5, 7) - 1;
    const yr = +m.slice(0, 4);
    if (step >= 12) {
      if (mi === 0 && (step === 12 || yr % 2 === 0)) out.push({ i, label: m.slice(0, 4) });
    } else if (mi % step === 0) {
      out.push({ i, label: monthName(m, true), sub: mi === 0 || out.length === 0 ? m.slice(0, 4) : undefined });
    }
  });
  return out;
}
