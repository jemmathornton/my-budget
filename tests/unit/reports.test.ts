import { describe, expect, it } from 'vitest';
import { newBudget } from '../../src/model/budget';
import { addAccount, saveTransaction, setCategoryHidden, updateAccount } from '../../src/model/ops';
import { INCOME_NEXT, INCOME_NOW, SPLIT, type Budget, type Id } from '../../src/model/types';
import {
  assignSlots,
  dataBounds,
  formatCompact,
  formatShare,
  incomeExpenseReport,
  monthAxisLabels,
  netWorthReport,
  niceTicks,
  OTHER,
  payeesInRange,
  pieSegments,
  rangeLabel,
  resolveRange,
  selectTransactionIds,
  spendingRank,
  spendingReport,
  trendsReport,
  UNCATEGORISED,
  type ReportFilters,
} from '../../src/ui/reports/data';

// A small budget, January to March 2026:
//   Current (budget)  starting balance £1,000 (income), salary, groceries, a split, a refund,
//                     a transfer to Savings (not spending), a transfer to the ISA categorised
//                     as Holiday (spending), and splits mixing income, spending and a transfer.
//   Card (budget)     a restaurant meal.
//   Savings (budget)  only transfers in.
//   ISA (off-budget)  starting balance £5,000, a fee (never spending).
//   Car Loan (off-budget, closed)  -£300 from Dec 2025, paid off in Feb 2026.
function fixture() {
  const b = newBudget('Test');
  const cat = (name: string): Id => Object.values(b.categories).find((c) => c.name === name)!.id;
  const master = (name: string): Id => Object.values(b.masters).find((m) => m.name === name)!.id;
  const current = addAccount(b, { name: 'Current', type: 'Checking', onBudget: true }, 100000, '2026-01-01');
  const card = addAccount(b, { name: 'Card', type: 'CreditCard', onBudget: true }, 0, '2026-01-01');
  const savings = addAccount(b, { name: 'Savings', type: 'Savings', onBudget: true }, 0, '2026-01-01');
  const isa = addAccount(b, { name: 'ISA', type: 'InvestmentAccount', onBudget: false }, 500000, '2026-01-01');
  const loan = addAccount(b, { name: 'Car Loan', type: 'OtherLiability', onBudget: false }, -30000, '2025-12-15');

  const tx = (input: Parameters<typeof saveTransaction>[1]) => saveTransaction(b, input);
  const ids = {
    tesco: tx({ accountId: current, date: '2026-01-05', payeeName: 'Tesco', categoryId: cat('Groceries'), amount: -5000, cleared: 'C' }),
    pizza: tx({ accountId: card, date: '2026-01-10', payeeName: 'Pizza Place', categoryId: cat('Restaurants'), amount: -2000, cleared: 'C' }),
    salaryJan: tx({ accountId: current, date: '2026-01-25', payeeName: 'Employer', categoryId: INCOME_NOW, amount: 300000, cleared: 'C' }),
    bonusJan: tx({ accountId: current, date: '2026-01-28', payeeName: 'Employer', categoryId: INCOME_NEXT, amount: 200000, cleared: 'C' }),
    split: tx({
      accountId: current,
      date: '2026-02-03',
      payeeName: 'Supermarket',
      categoryId: SPLIT,
      amount: -10000,
      cleared: 'C',
      splits: [
        { id: '', categoryId: cat('Groceries'), amount: -3000 },
        { id: '', categoryId: cat('Fuel'), amount: -7000 },
      ],
    }),
    refund: tx({ accountId: current, date: '2026-02-08', payeeName: 'Tesco', categoryId: cat('Groceries'), amount: 1000, cleared: 'C' }),
    toSavings: tx({ accountId: current, date: '2026-02-15', transferAccountId: savings, amount: -20000, cleared: 'C' }),
    payoff: tx({ accountId: loan, date: '2026-02-20', payeeName: 'Payoff', amount: 30000, cleared: 'C' }),
    salaryFeb: tx({ accountId: current, date: '2026-02-25', payeeName: 'Employer', categoryId: INCOME_NOW, amount: 300000, cleared: 'C' }),
    toIsa: tx({
      accountId: current,
      date: '2026-03-01',
      transferAccountId: isa,
      categoryId: cat('Holiday'),
      amount: -15000,
      cleared: 'C',
    }),
    fee: tx({ accountId: isa, date: '2026-03-02', payeeName: 'Fees', categoryId: null, amount: -500, cleared: 'C' }),
    mixed: tx({
      accountId: current,
      date: '2026-03-05',
      payeeName: 'Mixed',
      categoryId: SPLIT,
      amount: 3000,
      cleared: 'C',
      splits: [
        { id: '', categoryId: INCOME_NOW, amount: 5000 },
        { id: '', categoryId: cat('Groceries'), amount: -2000 },
      ],
    }),
    splitTransfer: tx({
      accountId: current,
      date: '2026-03-10',
      payeeName: 'Bank',
      categoryId: SPLIT,
      amount: -5000,
      cleared: 'C',
      splits: [
        { id: '', categoryId: cat('Groceries'), amount: -1000 },
        { id: '', categoryId: null, amount: -4000, transferAccountId: savings },
      ],
    }),
  };
  updateAccount(b, loan, { closed: true });
  return { b, cat, master, current, card, savings, isa, loan, ids };
}

const Q1: ReportFilters = { from: '2026-01', to: '2026-03', accounts: null, includeHidden: true };

describe('date range presets', () => {
  const today = '2026-10-13';
  it('resolves each preset against today', () => {
    expect(resolveRange('this-month', today)).toEqual({ from: '2026-10', to: '2026-10' });
    expect(resolveRange('last-month', today)).toEqual({ from: '2026-09', to: '2026-09' });
    expect(resolveRange('latest-3', today)).toEqual({ from: '2026-08', to: '2026-10' });
    expect(resolveRange('this-year', today)).toEqual({ from: '2026-01', to: '2026-10' });
    expect(resolveRange('last-year', today)).toEqual({ from: '2025-01', to: '2025-12' });
    expect(resolveRange('last-12', today)).toEqual({ from: '2025-11', to: '2026-10' });
  });

  it('crosses year boundaries in January', () => {
    expect(resolveRange('last-month', '2026-01-05')).toEqual({ from: '2025-12', to: '2025-12' });
    expect(resolveRange('latest-3', '2026-01-05')).toEqual({ from: '2025-11', to: '2026-01' });
    expect(resolveRange('last-12', '2026-01-31')).toEqual({ from: '2025-02', to: '2026-01' });
  });

  it('uses the data bounds for All dates and orders a custom range', () => {
    const { b } = fixture();
    expect(dataBounds(b)).toEqual({ from: '2025-12', to: '2026-03' });
    expect(resolveRange('all', today, { bounds: dataBounds(b) })).toEqual({ from: '2025-12', to: '2026-03' });
    expect(resolveRange('all', today, { bounds: null })).toEqual({ from: '2026-10', to: '2026-10' });
    expect(resolveRange('custom', today, { custom: { from: '2026-05', to: '2026-02' } })).toEqual({
      from: '2026-02',
      to: '2026-05',
    });
  });

  it('labels ranges', () => {
    expect(rangeLabel('2026-03', '2026-03')).toBe('Mar 2026');
    expect(rangeLabel('2026-01', '2026-03')).toBe('Jan–Mar 2026');
    expect(rangeLabel('2025-11', '2026-10')).toBe('Nov 2025 – Oct 2026');
  });
});

describe('spending', () => {
  it('totals outflows minus refunds by master category, with splits and categorised transfers', () => {
    const { b, master } = fixture();
    const r = spendingReport(b, Q1, { by: 'category', masterId: null });
    // Groceries 50 + 30 - 10 + 20 + 10, Fuel 70, Restaurants 20; Holiday 150 (transfer to the ISA).
    expect(r.rows.map((x) => [x.name, x.total])).toEqual([
      ['Everyday Expenses', 19000],
      ['Savings Goals', 15000],
    ]);
    expect(r.total).toBe(34000);
    expect(r.months).toBe(3);
    expect(r.average).toBe(11333);
    expect(r.rows[0].share).toBeCloseTo(19000 / 34000);
    expect(r.rows[0].drillable).toBe(true);
    expect(r.rows[0].key).toBe(master('Everyday Expenses'));
  });

  it('leaves out transfers between budget accounts, income and off-budget accounts', () => {
    const { b } = fixture();
    const r = spendingReport(b, Q1, { by: 'payee', masterId: null });
    const names = r.rows.map((x) => x.name);
    expect(names).not.toContain('Transfer : Savings');
    expect(names).not.toContain('Fees');
    expect(names).not.toContain('Employer');
    expect(names).not.toContain('Payoff');
    expect(r.rows.find((x) => x.key === UNCATEGORISED)).toBeUndefined();
    expect(Object.fromEntries(r.rows.map((x) => [x.name, x.total]))).toEqual({
      'Transfer : ISA': 15000,
      Supermarket: 10000,
      Tesco: 4000,
      'Pizza Place': 2000,
      Mixed: 2000,
      Bank: 1000,
    });
    expect(r.total).toBe(34000);
  });

  it('drills into a master category', () => {
    const { b, master, cat } = fixture();
    const r = spendingReport(b, Q1, { by: 'category', masterId: master('Everyday Expenses') });
    expect(r.rows.map((x) => [x.name, x.total, x.drillable])).toEqual([
      ['Groceries', 10000, false],
      ['Fuel', 7000, false],
      ['Restaurants', 2000, false],
    ]);
    expect(r.total).toBe(19000);
    const byPayee = spendingReport(b, Q1, { by: 'payee', masterId: master('Savings Goals') });
    expect(byPayee.rows.map((x) => x.name)).toEqual(['Transfer : ISA']);
    expect(r.rows[0].key).toBe(cat('Groceries'));
  });

  it('counts only the chosen categories, never filtering out income (1.4)', () => {
    const { b, master, cat } = fixture();
    const only = { ...Q1, categories: [cat('Groceries'), cat('Fuel')] };
    const r = spendingReport(b, only, { by: 'category', masterId: master('Everyday Expenses') });
    expect(r.rows.map((x) => [x.name, x.total])).toEqual([
      ['Groceries', 10000],
      ['Fuel', 7000],
    ]);
    const ive = incomeExpenseReport(b, only);
    expect(ive.incomeTotal.total).toBe(incomeExpenseReport(b, Q1).incomeTotal.total);
    expect(ive.expenseTotal.total).toBe(17000);
    expect(spendingReport(b, { ...Q1, categories: [] }, { by: 'category', masterId: null }).total).toBe(0);
  });

  it("counts only the chosen payees, income too, and lists the range's payees most spent first (1.5)", () => {
    const { b, ids, current, card, cat } = fixture();
    // £7 of groceries with no payee.
    saveTransaction(b, { accountId: current, date: '2026-03-20', categoryId: cat('Groceries'), amount: -700, cleared: 'U' });
    const payee = (id: Id) => b.transactions[id].payeeId!;
    const only = { ...Q1, payees: { keys: [payee(ids.tesco), payee(ids.salaryJan)], except: false } };
    // Tesco: £50 in January, less a £10 refund in February.
    expect(spendingReport(b, only, { by: 'category', masterId: null }).total).toBe(4000);
    expect(incomeExpenseReport(b, only).incomeTotal.total).toBe(800000);
    const none = { ...Q1, payees: { keys: [], except: false } };
    expect(spendingReport(b, none, { by: 'category', masterId: null }).total).toBe(0);
    // All but Tesco, whichever range it was chosen in: everyone else still counts.
    const allBut = { ...Q1, payees: { keys: [payee(ids.tesco)], except: true } };
    expect(spendingReport(b, allBut, { by: 'category', masterId: null }).total).toBe(34700 - 4000);
    // "None" and "only (No payee)" aren't confused in the cache.
    const noPayee = { ...Q1, payees: { keys: [''], except: false } };
    expect(spendingReport(b, noPayee, { by: 'category', masterId: null }).total).toBe(700);
    expect(spendingReport(b, none, { by: 'category', masterId: null }).total).toBe(0);
    const jan = payeesInRange(b, '2026-01', '2026-01');
    expect(jan).toEqual(expect.arrayContaining([payee(ids.tesco), payee(ids.pizza), payee(ids.salaryJan)]));
    expect(jan).not.toContain(payee(ids.split));
    expect(jan.indexOf(payee(ids.tesco))).toBeLessThan(jan.indexOf(payee(ids.pizza)));
    // With an Accounts filter, only those accounts' payees are listed (1.5.1).
    expect(payeesInRange(b, '2026-01', '2026-01', [card])).toEqual([payee(ids.pizza)]);
    expect(payeesInRange(b, '2026-01', '2026-01', [])).toEqual([]);
  });

  it('respects the date range, the accounts filter and hidden categories', () => {
    const { b, cat, card } = fixture();
    const feb = spendingReport(b, { ...Q1, from: '2026-02', to: '2026-02' }, { by: 'category', masterId: null });
    expect(feb.total).toBe(9000);
    expect(feb.average).toBe(9000);

    const cardOnly = spendingReport(b, { ...Q1, accounts: [card] }, { by: 'category', masterId: null });
    expect(cardOnly.total).toBe(2000);

    setCategoryHidden(b, cat('Restaurants'), true);
    // The cache is per budget object; use a copy as the store would after a change.
    const b2: Budget = { ...b };
    expect(spendingReport(b2, { ...Q1, includeHidden: false }, { by: 'category', masterId: null }).total).toBe(32000);
    expect(spendingReport(b2, Q1, { by: 'category', masterId: null }).total).toBe(34000);
  });

  it('counts uncategorised spending separately', () => {
    const { b, current } = fixture();
    saveTransaction(b, { accountId: current, date: '2026-03-20', payeeName: 'Mystery', amount: -700, cleared: 'U' });
    const r = spendingReport({ ...b }, Q1, { by: 'category', masterId: null });
    const row = r.rows.find((x) => x.key === UNCATEGORISED)!;
    expect(row.name).toBe('Uncategorised');
    expect(row.total).toBe(700);
    expect(row.drillable).toBe(false);
  });

  it('finds the transactions behind a row, split transactions once', () => {
    const { b, cat, ids } = fixture();
    const got = selectTransactionIds(b, Q1, { categoryId: cat('Groceries') });
    expect(new Set(got)).toEqual(new Set([ids.tesco, ids.split, ids.refund, ids.mixed, ids.splitTransfer]));
    expect(selectTransactionIds(b, Q1, { categoryId: cat('Groceries'), month: '2026-02' }).sort()).toEqual(
      [ids.split, ids.refund].sort(),
    );
    expect(selectTransactionIds(b, Q1, { income: true, payeeKey: b.transactions[ids.salaryJan].payeeId! }).sort()).toEqual(
      [ids.salaryJan, ids.bonusJan, ids.salaryFeb].sort(),
    );
  });
});

describe('income v expense', () => {
  it('shows income by payee in the month received, including income for next month', () => {
    const { b } = fixture();
    const r = incomeExpenseReport(b, Q1);
    expect(r.months).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(r.income.map((x) => [x.name, x.values])).toEqual([
      ['Employer', [500000, 300000, 0]],
      ['Starting Balance', [100000, 0, 0]],
      ['Mixed', [0, 0, 5000]],
    ]);
    expect(r.incomeTotal.values).toEqual([600000, 300000, 5000]);
    expect(r.incomeTotal.total).toBe(905000);
    expect(r.incomeTotal.average).toBe(301667);
  });

  it('groups expenses by master category with sub-category rows and a net income row', () => {
    const { b } = fixture();
    const r = incomeExpenseReport(b, Q1);
    expect(r.expenses.map((g) => [g.name, g.values])).toEqual([
      ['Everyday Expenses', [7000, 9000, 3000]],
      ['Savings Goals', [0, 0, 15000]],
    ]);
    expect(r.expenses[0].children.map((c) => [c.name, c.values])).toEqual([
      ['Groceries', [5000, 2000, 3000]],
      ['Fuel', [0, 7000, 0]],
      ['Restaurants', [2000, 0, 0]],
    ]);
    expect(r.expenseTotal.values).toEqual([7000, 9000, 18000]);
    expect(r.net.values).toEqual([593000, 291000, -13000]);
    expect(r.net.total).toBe(905000 - 34000);
  });
});

describe('net worth', () => {
  it('uses month-end balances of every account, including off-budget and closed ones', () => {
    const { b } = fixture();
    const r = netWorthReport(b, Q1);
    expect(r.opening).toEqual({ month: '2025-12', assets: 0, debts: -30000, net: -30000 });
    expect(r.points).toEqual([
      // Current 5,950 + ISA 5,000; Card -20 and Car Loan -300.
      { month: '2026-01', assets: 1095000, debts: -32000, net: 1063000 },
      // Current 8,660 + Savings 200 + ISA 5,000; Card -20 (the loan is paid off).
      { month: '2026-02', assets: 1386000, debts: -2000, net: 1384000 },
      // Current 8,490 + Savings 240 + ISA 5,145.
      { month: '2026-03', assets: 1387500, debts: -2000, net: 1385500 },
    ]);
  });

  it('can be limited to some accounts', () => {
    const { b, current, loan } = fixture();
    const r = netWorthReport(b, { ...Q1, accounts: [current, loan] });
    expect(r.points.map((p) => [p.assets, p.debts])).toEqual([
      [595000, -30000],
      [866000, 0],
      [849000, 0],
    ]);
  });

  it('carries balances into months with no transactions', () => {
    const { b } = fixture();
    const r = netWorthReport(b, { ...Q1, from: '2026-05', to: '2026-06' });
    expect(r.opening.net).toBe(1385500);
    expect(r.points.map((p) => p.net)).toEqual([1385500, 1385500]);
  });
});

describe('spending trends', () => {
  it('stacks spending by master category, folding the rest into Other', () => {
    const { b, master } = fixture();
    const r = trendsReport(b, Q1, 1);
    expect(r.series.map((s) => [s.name, s.values, s.slot])).toEqual([
      ['Everyday Expenses', [7000, 9000, 3000], 0],
      ['Other', [0, 0, 15000], -1],
    ]);
    expect(r.series[1].key).toBe(OTHER);
    expect(r.series[1].members).toEqual([master('Savings Goals')]);
    expect(r.totals).toEqual([7000, 9000, 18000]);
  });

  it('keeps each master category in its all-dates colour slot', () => {
    const { b, master } = fixture();
    // In March alone Savings Goals is the biggest, but it keeps slot 1 (it is second over all dates).
    const r = trendsReport(b, { ...Q1, from: '2026-03', to: '2026-03' });
    expect(r.series.map((s) => [s.name, s.slot])).toEqual([
      ['Everyday Expenses', 0],
      ['Savings Goals', 1],
    ]);
    expect(spendingRank(b, 'master').get(master('Everyday Expenses'))).toBe(0);
  });

  it('ranks categories within their own master category', () => {
    const { b, cat } = fixture();
    const rank = spendingRank(b, 'category');
    expect([rank.get(cat('Groceries')), rank.get(cat('Fuel')), rank.get(cat('Restaurants'))]).toEqual([0, 1, 2]);
    expect(rank.get(cat('Holiday'))).toBe(0);
  });
});

describe('helpers', () => {
  it('assigns colour slots by rank, filling gaps in order', () => {
    const rank = new Map([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['x', 12],
    ]);
    const s = assignSlots(['c', 'a', 'x', 'new'], rank);
    expect(Object.fromEntries(s)).toEqual({ a: 0, c: 2, x: 1, new: 3 });
    expect(assignSlots(['a', 'b', 'c'], rank, 2).size).toBe(2);
  });

  it('builds donut segments with an Other segment', () => {
    const rank = new Map([
      ['b', 0],
      ['a', 1],
    ]);
    const segs = pieSegments(
      [
        { key: 'a', name: 'A', total: 500 },
        { key: 'b', name: 'B', total: 300 },
        { key: 'c', name: 'C', total: 100 },
        { key: 'd', name: 'D', total: 50 },
        { key: 'e', name: 'E', total: -40 },
      ],
      rank,
      2,
    );
    expect(segs.map((s) => [s.key, s.value, s.slot])).toEqual([
      ['b', 300, 0],
      ['a', 500, 1],
      [OTHER, 150, -1],
    ]);
    expect(segs[2].keys).toEqual(['c', 'd']);
    expect(segs[2].name).toBe('Other (2)');
  });

  it('makes round axis ticks that include zero', () => {
    expect(niceTicks(0, 123456, 5, 100)).toEqual({ lo: 0, hi: 150000, step: 50000, ticks: [0, 50000, 100000, 150000] });
    const t = niceTicks(-32000, 1095000, 5, 100);
    expect(t.ticks).toContain(0);
    expect(t.lo).toBeLessThanOrEqual(-32000);
    expect(t.hi).toBeGreaterThanOrEqual(1095000);
    expect(niceTicks(0, 0, 4, 100).ticks).toEqual([0, 100, 200, 300, 400]);
    // Small debts beside large assets get a little room below zero, not a whole empty step.
    const small = niceTicks(-1866, 1020000, 6, 100);
    expect(small.lo).toBeLessThanOrEqual(-1866);
    expect(small.lo).toBeGreaterThan(-small.step / 2);
    expect(small.ticks[0]).toBe(0);
  });

  it('formats compact amounts for axes', () => {
    expect(formatCompact(0)).toBe('£0');
    expect(formatCompact(85000)).toBe('£850');
    expect(formatCompact(123456)).toBe('£1.2k');
    expect(formatCompact(4500000)).toBe('£45k');
    expect(formatCompact(-350000000)).toBe('-£3.5m');
    expect(formatShare(0.2345)).toBe('23.5%');
  });

  it('thins month labels to fit', () => {
    const months = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
    const wide = monthAxisLabels(months, 60);
    expect(wide).toHaveLength(12);
    expect(wide[0]).toEqual({ i: 0, label: 'Jan', sub: '2026' });
    expect(wide[1].sub).toBeUndefined();
    const narrow = monthAxisLabels(months, 10);
    expect(narrow.map((l) => l.label)).toEqual(['Jan', 'May', 'Sep']);
    const years = Array.from({ length: 120 }, (_, i) => {
      const y = 2016 + Math.floor(i / 12);
      return `${y}-${String((i % 12) + 1).padStart(2, '0')}`;
    });
    expect(monthAxisLabels(years, 2).map((l) => l.label)).toEqual(['2016', '2018', '2020', '2022', '2024']);
    expect(monthAxisLabels(years, 3).map((l) => l.label)).toEqual([
      '2016',
      '2017',
      '2018',
      '2019',
      '2020',
      '2021',
      '2022',
      '2023',
      '2024',
      '2025',
    ]);
  });
});
