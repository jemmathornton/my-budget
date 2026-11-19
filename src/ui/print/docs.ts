import { addMonths, formatDate, monthLabel, monthName } from '../../model/dates';
import { categoryMonth, monthSummary, type Computed } from '../../model/engine';
import { categoriesOf, categoryLabel, payeeName, registerCategory, sortedMasters } from '../../model/queries';
import { SPLIT, type Budget, type Id, type MonthKey, type Transaction } from '../../model/types';
import {
  categoryName,
  formatShare,
  incomeExpenseReport,
  masterName,
  netWorthReport,
  payeeKeyName,
  spendingReport,
  trendsReport,
  type IveRow,
  type ReportFilters,
  type SpendingView,
} from '../reports/data';
import { fileName, money, type Cell, type DocColumn, type DocRow, type DocTable, type PrintDoc } from './doc';

// The printouts, after YNAB4's (BudgetPrint, RegisterPrint and the reports): each takes what its
// screen shows, with the same figures, and describes it as a PrintDoc.

// ---- The budget ------------------------------------------------------------------------------

/** One month of the budget: the heading's figures, then each master category and category. */
export function budgetDoc(b: Budget, c: Computed, month: MonthKey, showHidden: boolean): PrintDoc {
  const s = monthSummary(c, month);
  const prev = addMonths(month, -1);
  const rows: DocRow[] = [];
  const total = { budgeted: 0, activity: 0, balance: 0 };
  // As on screen: each master's shown categories, then (if shown) the hidden ones together at
  // the bottom, as YNAB4's "Hidden Categories". A master whose categories are all hidden isn't listed.
  const groups: { name: string; cats: ReturnType<typeof categoriesOf>; hidden?: boolean }[] = sortedMasters(b)
    .map((m) => ({ name: m.name, cats: categoriesOf(b, m.id) }))
    .filter((g) => g.cats.length > 0);
  if (showHidden) {
    const hidden = sortedMasters(b).flatMap((m) => categoriesOf(b, m.id, true).filter((x) => x.hidden));
    if (hidden.length) groups.push({ name: 'Hidden Categories', cats: hidden, hidden: true });
  }
  for (const m of groups) {
    const cats = m.cats;
    const sub = { budgeted: 0, activity: 0, balance: 0 };
    const catRows: DocRow[] = cats.map((cat) => {
      const d = categoryMonth(c, month, cat.id);
      sub.budgeted += d.budgeted;
      sub.activity += d.activity;
      sub.balance += d.balance;
      // In the hidden group, "Name · Master", as on screen.
      const name = m.hidden ? `${cat.name} · ${b.masters[cat.masterId]?.name ?? ''}` : cat.name;
      return { cells: [name, money(d.budgeted), money(d.activity), money(d.balance)] };
    });
    rows.push({ kind: 'group', cells: [m.name, money(sub.budgeted), money(sub.activity), money(sub.balance)] }, ...catRows);
    total.budgeted += sub.budgeted;
    total.activity += sub.activity;
    total.balance += sub.balance;
  }
  rows.push({ kind: 'total', cells: ['Total', money(total.budgeted), money(total.activity), money(total.balance)] });
  const summary: PrintDoc['summary'] = s
    ? [
        { label: (s.notBudgetedPrev < 0 ? 'Overbudgeted in ' : 'Not budgeted in ') + monthName(prev, true), value: money(s.notBudgetedPrev) },
        { label: 'Overspent in ' + monthName(prev, true), value: money(s.overspentPrev) },
        { label: 'Income for ' + monthName(month, true), value: money(s.income) },
        { label: 'Budgeted in ' + monthName(month, true), value: money(-s.budgeted) },
        ...(s.budgetedInFuture ? [{ label: 'Budgeted in future', value: money(-s.budgetedInFuture) }] : []),
        { label: s.atb < 0 ? 'Overbudgeted' : 'Available to Budget', value: money(s.atb), strong: true },
      ]
    : undefined;
  return {
    name: fileName(`${b.name} - Budget ${monthLabel(month)}`),
    title: `Budget: ${monthLabel(month)}`,
    lines: [b.name],
    summary,
    tables: [
      {
        columns: [{ label: 'Category' }, { label: 'Budgeted', money: true, plain: true }, { label: 'Outflows', money: true, plain: true }, { label: 'Balance', money: true }],
        rows,
      },
    ],
  };
}

// ---- A register ------------------------------------------------------------------------------

export interface RegisterPrint {
  accountId: Id | 'all';
  /** The transactions shown, in the order shown. */
  txs: Transaction[];
  /** Running balance after each transaction (in date order), if that column is on. */
  balances: Map<Id, number> | null;
  check: boolean;
  /** What's limiting the list: the date range, a search, a flag... */
  filters: string[];
  totals: { cleared: number; uncleared: number; working: number };
}

/** A register as shown, with YNAB4's footer figures: the total shown, cleared, uncleared. */
export function registerDoc(b: Budget, p: RegisterPrint): PrintDoc {
  const all = p.accountId === 'all';
  const accName = all ? 'All accounts' : (b.accounts[p.accountId]?.name ?? '');
  const columns: DocColumn[] = [
    { label: 'Date', narrow: true },
    ...(all ? [{ label: 'Account' }] : []),
    ...(p.check ? [{ label: 'Cheque', narrow: true }] : []),
    { label: 'Payee' },
    { label: 'Category' },
    { label: 'Memo' },
    { label: 'Outflow', money: true },
    { label: 'Inflow', money: true },
    ...(p.balances ? [{ label: 'Balance', money: true }] : []),
    { label: 'C', narrow: true },
  ];
  const amounts = (v: number): Cell[] => [v < 0 ? money(-v) : null, v > 0 ? money(v) : null];
  const rows: DocRow[] = [];
  let shown = 0;
  for (const t of p.txs) {
    shown += t.amount;
    rows.push({
      cells: [
        formatDate(t.date),
        ...(all ? [b.accounts[t.accountId]?.name ?? ''] : []),
        ...(p.check ? [t.check || ''] : []),
        payeeName(b, t) || t.importedPayee || '',
        registerCategory(b, t).text,
        t.memo || '',
        ...amounts(t.amount),
        ...(p.balances ? [money(p.balances.get(t.id) ?? 0)] : []),
        t.cleared === 'U' ? '' : t.cleared,
      ],
    });
    if (t.categoryId === SPLIT)
      for (const s of t.splits || [])
        rows.push({
          kind: 'sub',
          cells: [
            '',
            ...(all ? [''] : []),
            ...(p.check ? [''] : []),
            s.payeeId || s.transferAccountId ? payeeName(b, s) : '',
            categoryLabel(b, s.categoryId, t.date),
            s.memo || '',
            ...amounts(s.amount),
            ...(p.balances ? [null] : []),
            '',
          ],
        });
  }
  const n = p.txs.length;
  return {
    name: fileName(`${b.name} - ${accName} register`),
    title: `Register: ${accName}`,
    lines: [b.name, ...p.filters, `${n} transaction${n === 1 ? '' : 's'}`],
    summary: [
      { label: 'Total of the transactions shown', value: money(shown) },
      { label: 'Cleared balance', value: money(p.totals.cleared) },
      { label: 'Uncleared balance', value: money(p.totals.uncleared) },
      { label: 'Working balance', value: money(p.totals.working), strong: true },
    ],
    tables: [{ columns, rows }],
    landscape: true,
  };
}

// ---- Reports ---------------------------------------------------------------------------------

export type ReportKind = 'spending' | 'ive' | 'networth' | 'trends';

/** The report filters in words, for the lines under the title. */
export function filterLines(b: Budget, f: ReportFilters, rangeText: string, tab: ReportKind): string[] {
  const names = (ids: Id[], name: (id: Id) => string, plural: string) =>
    ids.length === 0 ? `No ${plural}` : ids.length <= 4 ? ids.map(name).join(', ') : `${ids.length} ${plural}`;
  const lines = [b.name, rangeText];
  lines.push(f.accounts ? 'Accounts: ' + names(f.accounts, (id) => b.accounts[id]?.name ?? '', 'accounts') : tab === 'networth' ? 'All accounts' : 'All budget accounts');
  if (tab === 'networth') return lines;
  if (f.categories) lines.push('Categories: ' + names(f.categories, (id) => categoryName(b, id), 'categories'));
  if (f.payees) lines.push((f.payees.except ? 'All payees but: ' : 'Payees: ') + names(f.payees.keys, (k) => payeeKeyName(b, k), 'payees'));
  if (f.includeHidden) lines.push('Including hidden categories');
  return lines;
}

/** Splits months into tables of at most 12, so a long range still fits across the page. */
function byYearish<T>(months: MonthKey[], build: (from: number, to: number) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < months.length; i += 12) out.push(build(i, Math.min(months.length, i + 12)));
  return out;
}

const monthCols = (months: MonthKey[]): DocColumn[] => months.map((m) => ({ label: monthLabel(m, true), money: true }));

export function reportDoc(
  b: Budget,
  tab: ReportKind,
  f: ReportFilters,
  rangeText: string,
  view: SpendingView,
  /** Spending Trends: the series switched off in the legend, left out as on screen. */
  hiddenSeries: ReadonlySet<string> = new Set(),
): PrintDoc {
  const lines = filterLines(b, f, rangeText, tab);
  const base = (title: string, tables: DocTable[], landscape = false): PrintDoc => ({
    name: fileName(`${b.name} - ${title} ${rangeText}`),
    title,
    lines,
    tables,
    landscape,
  });

  if (tab === 'spending') {
    const r = spendingReport(b, f, view);
    const what = view.by === 'payee' ? 'Payee' : view.masterId ? 'Category' : 'Master category';
    const title = view.masterId
      ? `Spending in ${masterName(b, view.masterId)} by ${view.by === 'payee' ? 'payee' : 'category'}`
      : `Spending by ${view.by === 'payee' ? 'payee' : 'category'}`;
    const rows: DocRow[] = r.rows.map((x) => ({ cells: [x.name + (x.hidden ? ' (hidden)' : ''), money(x.total), money(x.average), formatShare(x.share)] }));
    if (rows.length) rows.push({ kind: 'total', cells: ['Total', money(r.total), money(r.average), '100%'] });
    return base(title, [
      {
        columns: [{ label: what }, { label: 'Spent', money: true }, { label: r.months > 1 ? `Average a month (${r.months})` : 'Average a month', money: true }, { label: 'Share', money: true }],
        rows,
      },
    ]);
  }

  if (tab === 'ive') {
    const r = incomeExpenseReport(b, f);
    const one = r.months.length <= 12;
    const line = (x: IveRow, from: number, to: number, kind?: DocRow['kind'], name = x.name): DocRow => ({
      kind,
      cells: [name + (x.hidden ? ' (hidden)' : ''), ...x.values.slice(from, to).map(money), ...(one ? [money(x.total), money(x.average)] : [])],
    });
    const tables = byYearish(r.months, (from, to): DocTable => {
      const rows: DocRow[] = [{ kind: 'group', cells: ['Income'] }];
      for (const x of r.income) rows.push(line(x, from, to));
      rows.push(line(r.incomeTotal, from, to, 'total', 'Total income'));
      rows.push({ kind: 'group', cells: ['Expenses'] });
      for (const g of r.expenses) {
        rows.push(line(g, from, to, 'group'));
        for (const x of g.children) rows.push(line(x, from, to, 'sub'));
      }
      rows.push(line(r.expenseTotal, from, to, 'total', 'Total expenses'));
      rows.push(line(r.net, from, to, 'total', 'Net income'));
      return {
        heading: one ? undefined : rangeOf(r.months, from, to),
        columns: [{ label: '' }, ...monthCols(r.months.slice(from, to)), ...(one ? [{ label: 'Total', money: true }, { label: 'Average', money: true }] : [])],
        rows,
      };
    });
    if (!one) tables.push(totalsTable([...r.income, r.incomeTotal], r.expenses, r.expenseTotal, r.net));
    return base('Income v Expense', tables, r.months.length > 3);
  }

  if (tab === 'networth') {
    const r = netWorthReport(b, f);
    let before = r.opening.net;
    const rows: DocRow[] = r.points.map((p) => {
      const change = p.net - before;
      before = p.net;
      return { cells: [monthLabel(p.month), money(p.assets), money(p.debts), money(p.net), money(change)] };
    });
    return base('Net Worth', [
      {
        columns: [{ label: 'End of' }, { label: 'Assets', money: true }, { label: 'Debts', money: true }, { label: 'Net worth', money: true }, { label: 'Change', money: true }],
        rows,
      },
    ]);
  }

  const r = trendsReport(b, f);
  const shown = r.series.filter((s) => !hiddenSeries.has(s.key));
  const totals = r.months.map((_, i) => shown.reduce((x, s) => x + s.values[i], 0));
  const tables = byYearish(r.months, (from, to): DocTable => {
    const rows: DocRow[] = shown.map((s) => ({ cells: [s.name, ...s.values.slice(from, to).map(money)] }));
    rows.push({ kind: 'total', cells: [shown.length < r.series.length ? 'Total shown' : 'Total', ...totals.slice(from, to).map(money)] });
    return { heading: r.months.length > 12 ? rangeOf(r.months, from, to) : undefined, columns: [{ label: 'Master category' }, ...monthCols(r.months.slice(from, to))], rows };
  });
  return base('Spending Trends', tables, r.months.length > 3);
}

function rangeOf(months: MonthKey[], from: number, to: number): string {
  return from === to - 1 ? monthLabel(months[from]) : `${monthLabel(months[from], true)} – ${monthLabel(months[to - 1], true)}`;
}

/** Income v Expense over more than 12 months: the totals and averages on their own. */
function totalsTable(income: IveRow[], expenses: { name: string; total: number; average: number; children: IveRow[] }[], expenseTotal: IveRow, net: IveRow): DocTable {
  const row = (x: { name: string; total: number; average: number }, kind?: DocRow['kind']): DocRow => ({ kind, cells: [x.name, money(x.total), money(x.average)] });
  const incomeTotal = income[income.length - 1];
  const rows: DocRow[] = [{ kind: 'group', cells: ['Income'] }, ...income.slice(0, -1).map((x) => row(x)), row({ ...incomeTotal, name: 'Total income' }, 'total')];
  rows.push({ kind: 'group', cells: ['Expenses'] });
  for (const g of expenses) rows.push(row(g, 'group'), ...g.children.map((x) => row(x, 'sub')));
  rows.push(row({ ...expenseTotal, name: 'Total expenses' }, 'total'), row({ ...net, name: 'Net income' }, 'total'));
  return { heading: 'Totals', columns: [{ label: '' }, { label: 'Total', money: true }, { label: 'Average a month', money: true }], rows };
}
