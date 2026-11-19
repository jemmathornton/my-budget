// Budget › Check budget.
import { describe, expect, it } from 'vitest';
import { checkBudget } from '../../src/model/check';
import { saveTransaction } from '../../src/model/ops';
import { SPLIT } from '../../src/model/types';
import { addTx, standardBudget } from './fixtures';

describe('checkBudget', () => {
  it('finds nothing wrong in a consistent budget', () => {
    const { b, checking, savings, groceries } = standardBudget();
    saveTransaction(b, { accountId: checking, date: '2026-10-01', transferAccountId: savings, amount: -5000, cleared: 'U' });
    saveTransaction(b, {
      accountId: checking,
      date: '2026-10-02',
      categoryId: SPLIT,
      amount: -300,
      cleared: 'U',
      splits: [
        { id: 's1', categoryId: groceries, amount: -100 },
        { id: 's2', categoryId: null, transferAccountId: savings, amount: -200 },
      ],
    });
    expect(checkBudget(b)).toEqual([]);
  });

  it('reports broken transfers, splits and links, with examples', () => {
    const { b, checking, savings, groceries } = standardBudget();
    const t = saveTransaction(b, { accountId: checking, date: '2026-10-01', transferAccountId: savings, amount: -5000, cleared: 'U' });
    b.transactions[b.transactions[t].transferTxId!].amount = 4999;
    addTx(b, checking, '2026-10-02', -300, SPLIT, { id: 'bad-split', splits: [{ id: 'x', categoryId: groceries, amount: -100 }] });
    addTx(b, checking, '2026-10-03', -1, 'no-such-category', { id: 'lost-cat' });
    addTx(b, 'no-such-account', '2026-10-04', -1, null, { id: 'lost-acc' });
    const kinds = Object.fromEntries(checkBudget(b).map((p) => [p.kind, p]));
    expect(kinds["Transfers whose two sides don't match"].count).toBe(2);
    expect(kinds["Split transactions whose lines don't add up"].examples).toEqual(['bad-split']);
    expect(kinds['Transactions with a category that no longer exists'].examples).toEqual(['lost-cat']);
    expect(kinds['Transactions in an account that no longer exists'].examples).toEqual(['lost-acc']);
  });
});

