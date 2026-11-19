// The register's search (1.5): plain text, amounts, and YNAB4's "Payee:", "Category:", "Memo:" and
// "Account:" fields. Made-up transactions.
import { describe, expect, it } from 'vitest';
import { saveTransaction } from '../../src/model/ops';
import { matchesSearch, parseSearch, searchAmount } from '../../src/model/search';
import { SPLIT } from '../../src/model/types';
import { standardBudget } from './fixtures';

function setup() {
  const { b, checking, card, groceries, fun } = standardBudget();
  const tx = (input: Parameters<typeof saveTransaction>[1]) => b.transactions[saveTransaction(b, input)];
  const milk = tx({ accountId: checking, date: '2026-10-01', payeeName: 'Tesco', categoryId: groceries, memo: 'milk', amount: -250, cleared: 'C' });
  const film = tx({ accountId: card, date: '2026-10-02', payeeName: 'Cinema', categoryId: fun, memo: 'Tesco voucher', amount: -1200, cleared: 'C' });
  const split = tx({
    accountId: checking,
    date: '2026-10-03',
    payeeName: 'Market',
    categoryId: SPLIT,
    amount: -1500,
    cleared: 'C',
    splits: [
      { id: '', categoryId: groceries, amount: -1000, memo: 'bread' },
      { id: '', categoryId: fun, amount: -500 },
    ],
  });
  const find = (q: string) => {
    const s = parseSearch(q);
    return [milk, film, split].filter((t) => matchesSearch(b, t, s, searchAmount(s.text))).map((t) => b.payees[t.payeeId!].name);
  };
  return { find };
}

describe('register search', () => {
  it('reads fields, case-insensitively, with any text before them', () => {
    expect(parseSearch('Payee: Tesco')).toEqual({ text: '', fields: [{ field: 'payee', text: 'tesco' }] });
    expect(parseSearch('weekly payee:tesco extra MEMO: milk')).toEqual({
      text: 'weekly',
      fields: [
        { field: 'payee', text: 'tesco extra' },
        { field: 'memo', text: 'milk' },
      ],
    });
    // A colon in plain text isn't a field.
    expect(parseSearch('ref:123')).toEqual({ text: 'ref:123', fields: [] });
    expect(parseSearch('payee:')).toEqual({ text: '', fields: [] });
  });

  it('finds plain text in any field, and amounts', () => {
    const { find } = setup();
    expect(find('tesco')).toEqual(['Tesco', 'Cinema']);
    expect(find('12.00')).toEqual(['Cinema']);
    expect(find('10')).toEqual(['Market']);
  });

  it('looks in one field only, and combines fields', () => {
    const { find } = setup();
    expect(find('payee: tesco')).toEqual(['Tesco']);
    expect(find('memo: tesco')).toEqual(['Cinema']);
    expect(find('category: groceries')).toEqual(['Tesco', 'Market']);
    expect(find('memo: bread')).toEqual(['Market']);
    expect(find('category: groceries memo: milk')).toEqual(['Tesco']);
    expect(find('account: card')).toEqual(['Cinema']);
  });

  it("finds a split line's own payee in a plain search, as \"payee:\" does (1.5.1)", () => {
    const { b, checking, groceries, fun } = standardBudget();
    const id = saveTransaction(b, {
      accountId: checking,
      date: '2026-10-04',
      payeeName: 'Market',
      categoryId: SPLIT,
      amount: -1500,
      cleared: 'C',
      splits: [
        { id: '', categoryId: groceries, amount: -1000 },
        { id: '', categoryId: fun, amount: -500 },
      ],
    });
    const t = b.transactions[id];
    const other = saveTransaction(b, { accountId: checking, date: '2026-10-05', payeeName: 'Bakery', categoryId: groceries, amount: -100, cleared: 'C' });
    t.splits![1].payeeId = b.transactions[other].payeeId;
    for (const q of ['bakery', 'payee: bakery']) {
      const s = parseSearch(q);
      expect(matchesSearch(b, t, s, searchAmount(s.text))).toBe(true);
    }
  });

  it("reads YNAB4's other filters: Is:, Inflow:, Outflow:, Before:, After:, On:, Check: (1.5.2)", () => {
    const { b, checking, groceries } = standardBudget();
    const tx = (input: Parameters<typeof saveTransaction>[1]) => b.transactions[saveTransaction(b, input)];
    const a = tx({ accountId: checking, date: '2026-10-01', payeeName: 'A', categoryId: groceries, amount: -250, cleared: 'U', check: '1001' });
    const c = tx({ accountId: checking, date: '2026-10-05', payeeName: 'C', categoryId: groceries, amount: -1250, cleared: 'C' });
    const r = tx({ accountId: checking, date: '2026-10-09', payeeName: 'R', categoryId: groceries, amount: 5000, cleared: 'R' });
    a.accepted = false;
    c.flag = 'red';
    const find = (q: string) => {
      const s = parseSearch(q);
      return [a, c, r].filter((t) => matchesSearch(b, t, s, searchAmount(s.text))).map((t) => b.payees[t.payeeId!].name).join('');
    };
    expect(find('is: uncleared')).toBe('A');
    expect(find('is: un')).toBe('A');
    expect(find('is: cleared')).toBe('CR');
    expect(find('is: reconciled')).toBe('R');
    expect(find('is: unreconciled')).toBe('AC');
    expect(find('is: unapproved')).toBe('A');
    expect(find('is: flagged')).toBe('C');
    expect(find('is: cleared unflagged')).toBe('R');
    expect(find('is: nonsense')).toBe('');
    expect(find('outflow:')).toBe('AC');
    expect(find('inflow:')).toBe('R');
    expect(find('outflow: 12.50')).toBe('C');
    expect(find('before: 05/10/2026')).toBe('A');
    expect(find('after: 5/10/2026')).toBe('R');
    expect(find('on: 05/10/2026')).toBe('C');
    expect(find('check: 1001')).toBe('A');
    expect(find('payee: a is: uncleared')).toBe('A');
  });

  it('keeps a field it can\'t read as plain text, and "Is:" takes only its own words (1.5.2)', () => {
    expect(parseSearch('paid on: friday')).toEqual({ text: 'paid on: friday', fields: [] });
    expect(parseSearch('what is: this')).toEqual({ text: 'what is: this', fields: [] });
    expect(parseSearch('is: uncleared tesco')).toEqual({ text: 'tesco', fields: [{ field: 'is', text: 'uncleared' }] });
    expect(parseSearch('memo: paid on: friday')).toEqual({ text: 'on: friday', fields: [{ field: 'memo', text: 'paid' }] });
    expect(parseSearch('outflow: lots')).toEqual({ text: 'outflow: lots', fields: [] });
    expect(parseSearch('outflow:')).toEqual({ text: '', fields: [{ field: 'outflow', text: '' }] });
    const { b, checking, groceries } = standardBudget();
    const t = b.transactions[saveTransaction(b, { accountId: checking, date: '2026-10-01', payeeName: 'Tesco', categoryId: groceries, memo: 'paid on: friday', amount: -250, cleared: 'U' })];
    for (const q of ['paid on: friday', 'is: uncleared tesco', 'tesco is: uncleared']) {
      const s = parseSearch(q);
      expect(matchesSearch(b, t, s, searchAmount(s.text))).toBe(true);
    }
  });
});
