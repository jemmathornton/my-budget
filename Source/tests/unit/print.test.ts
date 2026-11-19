// Printing and Ctrl+E (1.5.1): the printouts carry the screens' figures, the page escapes what
// it shows, and the CSV keeps amounts as numbers. Made-up budgets.
import { describe, expect, it } from 'vitest';
import { compute, monthSummary } from '../../src/model/engine';
import { saveTransaction, setBudgeted } from '../../src/model/ops';
import { categoryLabel } from '../../src/model/queries';
import { INCOME_NOW, SPLIT } from '../../src/model/types';
import { docCsv, docHtml, money, type PrintDoc } from '../../src/ui/print/doc';
import { budgetDoc, registerDoc, reportDoc } from '../../src/ui/print/docs';
import type { ReportFilters } from '../../src/ui/reports/data';
import { trendsReport } from '../../src/ui/reports/data';
const trendsKey = (b: Parameters<typeof trendsReport>[0], f: ReportFilters) => trendsReport(b, f).series[0].key;
import { standardBudget } from './fixtures';

const BY_CATEGORY = { by: 'category' as const, masterId: null };

function setup() {
  const s = standardBudget();
  const { b, checking, card, groceries, fun, rent } = s;
  const tx = (input: Parameters<typeof saveTransaction>[1]) => saveTransaction(b, input);
  tx({ accountId: checking, date: '2026-01-02', payeeName: 'Employer', categoryId: INCOME_NOW, amount: 200000, cleared: 'C' });
  setBudgeted(b, '2026-01', rent, 80000);
  setBudgeted(b, '2026-01', groceries, 30000);
  tx({ accountId: checking, date: '2026-01-05', payeeName: 'Landlord', categoryId: rent, amount: -80000, cleared: 'C' });
  tx({ accountId: card, date: '2026-01-09', payeeName: '=cmd|"/c calc"', categoryId: groceries, amount: -1250, cleared: 'U', memo: '<b>milk</b>' });
  tx({
    accountId: checking,
    date: '2026-02-03',
    payeeName: 'Market',
    categoryId: SPLIT,
    amount: -1500,
    cleared: 'R',
    splits: [
      { id: '', categoryId: groceries, amount: -1000, memo: 'bread' },
      { id: '', categoryId: fun, amount: -500 },
    ],
  });
  return s;
}

describe('printouts', () => {
  it("print the budget month with the heading's figures and each category", () => {
    const { b } = setup();
    const c = compute(b);
    const d = budgetDoc(b, c, '2026-01', false);
    const s = monthSummary(c, '2026-01')!;
    expect(d.title).toBe('Budget: January 2026');
    expect(d.summary!.at(-1)).toEqual({ label: 'Available to Budget', value: money(s.atb), strong: true });
    const rows = d.tables[0].rows;
    expect(rows.find((r) => r.cells[0] === 'Rent')!.cells).toEqual(['Rent', money(80000), money(-80000), money(0)]);
    expect(rows.find((r) => r.cells[0] === 'Bills')!.kind).toBe('group');
    expect(rows.at(-1)!.cells).toEqual(['Total', money(s.budgeted), money(s.activity), money(s.balanceTotal)]);
  });

  it('print a register as shown, with split lines and the balances', () => {
    const { b, checking, groceries } = setup();
    const txs = Object.values(b.transactions).filter((t) => t.accountId === checking);
    const d = registerDoc(b, { accountId: checking, txs, balances: null, check: false, filters: ['All dates'], totals: { cleared: 1, uncleared: 2, working: 3 } });
    expect(d.landscape).toBe(true);
    expect(d.lines).toEqual([b.name, 'All dates', '3 transactions']);
    const rows = d.tables[0].rows;
    expect(rows.map((r) => r.kind ?? '')).toEqual(['', '', '', 'sub', 'sub']);
    expect(rows[3].cells.slice(1, 6)).toEqual(['', categoryLabel(b, groceries), 'bread', money(1000), null]);
    expect(rows[2].cells.at(-1)).toBe('R');
    expect(d.summary![0]).toEqual({ label: 'Total of the transactions shown', value: money(200000 - 80000 - 1500) });
  });

  it('print every report, splitting more than 12 months into tables a page wide', () => {
    const { b } = setup();
    const f: ReportFilters = { from: '2026-01', to: '2026-02', accounts: null, includeHidden: false };
    const spending = reportDoc(b, 'spending', f, 'Jan–Feb 2026', BY_CATEGORY);
    expect(spending.title).toBe('Spending by category');
    expect(spending.tables[0].rows.at(-1)!.cells.slice(0, 2)).toEqual(['Total', money(80000 + 1250 + 1500)]);
    const ive = reportDoc(b, 'ive', f, 'Jan–Feb 2026', BY_CATEGORY);
    expect(ive.tables).toHaveLength(1);
    expect(ive.tables[0].columns.map((c) => c.label)).toEqual(['', 'Jan 2026', 'Feb 2026', 'Total', 'Average']);
    expect(reportDoc(b, 'networth', f, 'Jan–Feb 2026', BY_CATEGORY).tables[0].rows).toHaveLength(2);
    expect(reportDoc(b, 'trends', f, 'Jan–Feb 2026', BY_CATEGORY).tables[0].rows.at(-1)!.cells[0]).toBe('Total');
    // Two years: two tables of 12 months and the totals.
    const long = reportDoc(b, 'ive', { ...f, from: '2025-03', to: '2027-02' }, '', BY_CATEGORY);
    expect(long.tables.map((t) => t.columns.length)).toEqual([13, 13, 3]);
    expect(long.tables.map((t) => t.heading)).toEqual(['Mar 2025 – Feb 2026', 'Mar 2026 – Feb 2027', 'Totals']);
    const trends = reportDoc(b, 'trends', { ...f, from: '2025-03', to: '2027-02' }, '', BY_CATEGORY);
    expect(trends.tables).toHaveLength(2);
  });

  it('escape names in the page, and keep formulas out of the CSV', () => {
    const { b, card } = setup();
    const txs = Object.values(b.transactions).filter((t) => t.accountId === card);
    const d = registerDoc(b, { accountId: card, txs, balances: null, check: false, filters: [], totals: { cleared: 0, uncleared: -1250, working: -1250 } });
    const html = docHtml(d, '2026-02-01');
    expect(html).toContain('&lt;b&gt;milk&lt;/b&gt;');
    expect(html).not.toContain('<b>milk');
    expect(html).toContain('Page " counter(page) " of " counter(pages)');
    expect(html).not.toMatch(/<script/i);
    const csv = docCsv(d);
    expect(csv).toContain(`"'=cmd|""/c calc"""`);
    expect(csv).toContain(',12.50,');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("can't be broken out of its style block by a name", () => {
    const d: PrintDoc = { name: 'x', title: 'A </style><script>x</script> "budget"', lines: [], tables: [] };
    const html = docHtml(d);
    expect(html.indexOf('</style>')).toBe(html.lastIndexOf('</style>'));
    expect(html).not.toContain('<script>');
  });

  it('group hidden categories as the screen does, and leave the legend\'s hidden series out of Trends (1.5.2)', async () => {
    const { b, power, bills } = setup();
    const { setCategoryHidden } = await import('../../src/model/ops');
    setBudgeted(b, '2026-01', power, 5000);
    setCategoryHidden(b, power, true);
    const c = compute(b);
    const shown = budgetDoc(b, c, '2026-01', true).tables[0].rows;
    const names = shown.map((r) => r.cells[0]);
    expect(names.slice(-3)).toEqual(['Hidden Categories', 'Power · Bills', 'Total']);
    expect(shown.find((r) => r.cells[0] === 'Bills')!.cells[1]).toEqual(money(80000));
    expect(budgetDoc(b, c, '2026-01', false).tables[0].rows.map((r) => r.cells[0])).not.toContain('Power');
    void bills;
    const f: ReportFilters = { from: '2026-01', to: '2026-02', accounts: null, includeHidden: false };
    const all = reportDoc(b, 'trends', f, '', BY_CATEGORY);
    const first = all.tables[0].rows[0];
    const less = reportDoc(b, 'trends', f, '', BY_CATEGORY, new Set([trendsKey(b, f)]));
    expect(less.tables[0].rows.map((r) => r.cells[0])).not.toContain(first.cells[0]);
    expect(less.tables[0].rows.at(-1)!.cells[0]).toBe('Total shown');
  });

  it('print the register\'s own category text, and survive "$\'" in a name (1.5.2)', () => {
    const { b, checking, mortgage } = setup();
    b.accounts[checking].name = "Joint $' acct";
    saveTransaction(b, { accountId: checking, date: '2026-02-09', payeeName: 'Shop', categoryId: null, amount: -100, cleared: 'U' });
    saveTransaction(b, { accountId: mortgage, date: '2026-02-09', payeeName: 'Bank', categoryId: null, amount: -100, cleared: 'U' });
    const txs = Object.values(b.transactions).filter((t) => t.accountId === checking);
    const d = registerDoc(b, { accountId: checking, txs, balances: null, check: false, filters: [], totals: { cleared: 0, uncleared: 0, working: 0 } });
    const cats = d.tables[0].rows.filter((r) => !r.kind).map((r) => r.cells[2]);
    expect(cats).toContain('Needs a category');
    expect(cats).toContain('Split (2 categories)');
    const html = docHtml(d);
    expect(html).toContain("Register: Joint $' acct · printed");
    expect(html).toContain('Content-Security-Policy');
    const off = Object.values(b.transactions).filter((t) => t.accountId === mortgage);
    expect(registerDoc(b, { accountId: mortgage, txs: off, balances: null, check: false, filters: [], totals: { cleared: 0, uncleared: 0, working: 0 } }).tables[0].rows[0].cells[2]).toBe('');
  });

  it("put a report's chart above its tables, with its legend escaped and only plain colours (1.5.2 draft)", () => {
    const d: PrintDoc = {
      name: 'x', title: 'Spending', lines: [], tables: [],
      chart: { svg: '<svg viewBox="0 0 10 10"><path d="M0 0" style="fill: var(--rp-c1)"/></svg>', caption: 'Total <b>', legend: [{ label: 'A & <B>', color: 'var(--rp-c2)' }, { label: 'C', color: 'red;background:url(x)' }] },
    };
    const html = docHtml(d);
    expect(html).toContain('<div class="chart"><svg viewBox');
    expect(html).toContain('A &amp; &lt;B&gt;');
    expect(html).toContain('Total &lt;b&gt;');
    expect(html).toContain('background:var(--rp-c2)');
    expect(html).not.toContain('url(x)');
    expect(docCsv(d)).not.toContain('svg');
  });
});
