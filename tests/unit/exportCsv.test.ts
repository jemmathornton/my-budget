import { afterEach, describe, expect, it, vi } from 'vitest';
import { setDateFormat } from '../../src/model/dates';
import { exportBudgetCsv } from '../../src/model/exportCsv';
import { addCategory, saveTransaction, setBudgeted } from '../../src/model/ops';
import { INCOME_NOW, SPLIT } from '../../src/model/types';
import { setNow, standardBudget } from './fixtures';

afterEach(() => {
  setDateFormat('DD/MM/YYYY');
  vi.useRealTimers();
});

/** A small CSV reader: quoted fields, doubled quotes, CRLF rows, leading BOM. */
function parseCsv(text: string): string[][] {
  expect(text.charCodeAt(0)).toBe(0xfeff);
  const s = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && s[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else field += ch;
  }
  expect(field).toBe('');
  expect(row).toEqual([]);
  return rows;
}

function setup() {
  setNow(2026, 10, 13);
  const f = standardBudget();
  const { b, bills, checking, savings, card, groceries, fun } = f;
  b.name = 'House/Hold: "2026"';
  b.categories[fun].hidden = true;
  const carIns = addCategory(b, bills, 'Car: Insurance');
  setBudgeted(b, '2026-09', groceries, 5000);
  setBudgeted(b, '2026-09', carIns, 2000);
  setBudgeted(b, '2026-09', fun, 1000);
  const save = (x: Partial<Parameters<typeof saveTransaction>[1]>) =>
    saveTransaction(b, { accountId: checking, date: '2026-09-01', amount: 0, cleared: 'U', ...x });
  save({ date: '2026-09-01', amount: 200000, payeeName: 'Employer', categoryId: INCOME_NOW, memo: 'Pay, September', cleared: 'R' });
  save({ date: '2026-09-05', amount: -1000, payeeName: 'Shop', categoryId: groceries, memo: 'He said "hi"', flag: 'red', check: '101', cleared: 'C' });
  save({
    date: '2026-09-06',
    amount: -3000,
    payeeName: 'Market',
    categoryId: SPLIT,
    memo: 'Split memo',
    splits: [
      { id: 'a', categoryId: groceries, amount: -1000, memo: 'food' },
      { id: 'b', categoryId: carIns, amount: -2000 },
    ],
  });
  save({ date: '2026-09-07', amount: -5000, transferAccountId: savings });
  save({ date: '2026-09-08', amount: -500, categoryId: null, memo: 'line1\nline2' });
  saveTransaction(b, { accountId: card, date: '2026-09-10', amount: -2500, payeeName: 'Shop', categoryId: groceries, cleared: 'U' });
  return { ...f, carIns };
}

describe('exportBudgetCsv', () => {
  it('names the two files after the budget, without characters Windows can’t use', () => {
    const { b } = setup();
    const files = exportBudgetCsv(b);
    expect(files.map((f) => f.name)).toEqual([
      'HouseHold 2026 as of 2026-10-13 - Budget.csv',
      'HouseHold 2026 as of 2026-10-13 - Register.csv',
    ]);
    for (const f of files) expect(f.text.endsWith('\r\n')).toBe(true);
  });

  it('writes every month and category, hidden ones included, in budget order', () => {
    const { b } = setup();
    const rows = parseCsv(exportBudgetCsv(b)[0].text);
    expect(rows[0]).toEqual(['Month', 'Category Group', 'Category', 'Budgeted', 'Outflows', 'Category Balance']);
    const body = rows.slice(1);
    // September to November (one past this month) x 5 categories.
    expect(body).toHaveLength(15);
    expect(body.slice(0, 5)).toEqual([
      ['Sep 2026', 'Bills', 'Rent', '0.00', '0.00', '0.00'],
      ['Sep 2026', 'Bills', 'Power', '0.00', '0.00', '0.00'],
      ['Sep 2026', 'Bills', 'Car: Insurance', '20.00', '-20.00', '0.00'],
      ['Sep 2026', 'Everyday', 'Groceries', '50.00', '-45.00', '5.00'],
      ['Sep 2026', 'Everyday', 'Fun', '10.00', '0.00', '10.00'],
    ]);
    expect(body[8]).toEqual(['Oct 2026', 'Everyday', 'Groceries', '0.00', '0.00', '5.00']);
    expect(body[14]).toEqual(['Nov 2026', 'Everyday', 'Fun', '0.00', '0.00', '10.00']);
  });

  it('writes every transaction with split lines on their own rows and a running balance', () => {
    const { b } = setup();
    const rows = parseCsv(exportBudgetCsv(b)[1].text);
    expect(rows[0]).toEqual([
      'Account', 'Flag', 'Check Number', 'Date', 'Payee', 'Category Group/Category', 'Category Group', 'Category',
      'Memo', 'Outflow', 'Inflow', 'Cleared', 'Running Balance',
    ]);
    expect(rows.slice(1)).toEqual([
      ['Checking', '', '', '01/09/2026', 'Employer', 'Income for Sep 2026', '', 'Income for Sep 2026', 'Pay, September', '0.00', '2000.00', 'Reconciled', '2000.00'],
      ['Checking', 'red', '101', '05/09/2026', 'Shop', 'Everyday: Groceries', 'Everyday', 'Groceries', 'He said "hi"', '10.00', '0.00', 'Cleared', '1990.00'],
      ['Checking', '', '', '06/09/2026', 'Market', 'Everyday: Groceries', 'Everyday', 'Groceries', '(Split 1/2) food', '10.00', '0.00', 'Uncleared', ''],
      ['Checking', '', '', '06/09/2026', 'Market', 'Bills: Car: Insurance', 'Bills', 'Car: Insurance', '(Split 2/2) Split memo', '20.00', '0.00', 'Uncleared', '1960.00'],
      ['Checking', '', '', '07/09/2026', 'Transfer : Savings', '', '', '', '', '50.00', '0.00', 'Uncleared', '1910.00'],
      ['Checking', '', '', '08/09/2026', '', '', '', '', 'line1\nline2', '5.00', '0.00', 'Uncleared', '1905.00'],
      ['Savings', '', '', '07/09/2026', 'Transfer : Checking', '', '', '', '', '0.00', '50.00', 'Uncleared', '50.00'],
      ['Card', '', '', '10/09/2026', 'Shop', 'Everyday: Groceries', 'Everyday', 'Groceries', '', '25.00', '0.00', 'Uncleared', '-25.00'],
    ]);
  });

  it('keeps text that a spreadsheet would read as a formula as text, and names split-line transfers (1.4.5)', () => {
    const { b, checking, savings, groceries } = setup();
    saveTransaction(b, { accountId: checking, date: '2026-09-20', amount: -700, payeeName: '=SUM(A1)', categoryId: groceries, memo: '-50 from Mum', cleared: 'U' });
    saveTransaction(b, {
      accountId: checking,
      date: '2026-09-21',
      amount: -3000,
      payeeName: 'Market',
      categoryId: SPLIT,
      cleared: 'U',
      splits: [
        { id: 'x', categoryId: groceries, amount: -1000 },
        { id: 'y', categoryId: null, amount: -2000, transferAccountId: savings },
      ],
    });
    const rows = parseCsv(exportBudgetCsv(b)[1].text);
    const odd = rows.find((r) => r[3] === '20/09/2026')!;
    expect(odd[4]).toBe("'=SUM(A1)");
    expect(odd[8]).toBe("'-50 from Mum");
    // Amounts are never changed.
    expect(odd[9]).toBe('7.00');
    const lines = rows.filter((r) => r[0] === 'Checking' && r[3] === '21/09/2026');
    expect(lines.map((r) => r[4])).toEqual(['Market', 'Transfer : Savings']);
    // The far side, in Savings, as before.
    expect(rows.find((r) => r[0] === 'Savings' && r[3] === '21/09/2026')?.[4]).toBe('Transfer : Checking');
  });

  it('uses the budget’s date format', () => {
    const { b } = setup();
    setDateFormat('YYYY-MM-DD');
    const rows = parseCsv(exportBudgetCsv(b)[1].text);
    expect(rows[1][3]).toBe('2026-09-01');
  });

  it('exports an empty budget with just the headers and empty category list', () => {
    setNow(2026, 10, 13);
    const { b } = standardBudget();
    const [budget, register] = exportBudgetCsv(b).map((f) => parseCsv(f.text));
    expect(budget).toHaveLength(1 + 2 * 4);
    expect(register).toHaveLength(1);
  });
});
