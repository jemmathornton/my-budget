// Extra coverage for undo and redo (November 2026 test review): bigger edits made through the
// store, undone and redone in several steps. store.test.ts covers the basics. Made-up budgets only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyImport, matchTransactions, planImport } from '../../src/import/match';
import { compute } from '../../src/model/engine';
import { deleteTransactions, enterDueScheduled, saveScheduled, saveTransaction, setBudgeted } from '../../src/model/ops';
import { INCOME_NOW, SPLIT, type Budget } from '../../src/model/types';
import { store, update } from '../../src/state/store';
import { addTx, setNow, standardBudget } from './fixtures';

let f: ReturnType<typeof standardBudget>;
const b = () => store.budget as Budget;
/** The budget without its modified time, which every change, undo and redo stamps. */
const content = (x: Budget) => JSON.parse(JSON.stringify({ ...x, modifiedAt: undefined }));

beforeEach(() => {
  setNow(2026, 10, 13);
  f = standardBudget();
  addTx(f.b, f.checking, '2026-10-01', 100000, INCOME_NOW, { id: 'pay', cleared: 'C' });
  store.load(f.b);
});

afterEach(() => vi.useRealTimers());

describe('undo and redo over several kinds of edit', () => {
  it('undoes five different edits back to exactly the budget that was opened, and redoes them all', () => {
    const start = content(b());
    let split = '';
    update('Budget', (d) => setBudgeted(d, '2026-10', f.groceries, 30000));
    update('Transfer', (d) => void saveTransaction(d, { accountId: f.checking, transferAccountId: f.savings, date: '2026-10-02', amount: -5000, cleared: 'U' }));
    update('Split', (d) => {
      split = saveTransaction(d, {
        accountId: f.checking,
        date: '2026-10-03',
        categoryId: SPLIT,
        amount: -3000,
        cleared: 'U',
        splits: [
          { id: 'a', categoryId: f.groceries, amount: -1000 },
          { id: 'b', categoryId: null, amount: -2000, transferAccountId: f.savings },
        ],
      });
    });
    update('Delete far side', (d) => deleteTransactions(d, [d.transactions[split].splits![1].transferTxId!]));
    update('Schedule', (d) => void saveScheduled(d, { accountId: f.checking, date: '2026-10-05', startDate: '2026-10-05', frequency: 'Weekly', categoryId: f.fun, amount: -700 }));
    const end = content(b());

    for (let i = 0; i < 5; i++) expect(store.undo()).toBeDefined();
    expect(store.canUndo()).toBe(false);
    expect(content(b())).toEqual(start);
    for (let i = 0; i < 5; i++) expect(store.redo()).toBeDefined();
    expect(content(b())).toEqual(end);
  });

  it("puts a split back together when deleting its far side is undone", () => {
    let split = '';
    update('Split', (d) => {
      split = saveTransaction(d, {
        accountId: f.checking,
        date: '2026-10-03',
        categoryId: SPLIT,
        amount: -3000,
        cleared: 'C',
        importIds: ['FITID:X1'],
        splits: [
          { id: 'a', categoryId: f.groceries, amount: -1000 },
          { id: 'b', categoryId: null, amount: -2000, transferAccountId: f.savings },
        ],
      });
    });
    const far = b().transactions[split].splits![1].transferTxId!;
    update('Delete', (d) => deleteTransactions(d, [far]));
    expect(b().transactions[split].amount).toBe(-1000);
    store.undo();
    expect(b().transactions[split]).toMatchObject({ amount: -3000 });
    expect(b().transactions[split].splits!.map((s) => s.transferTxId)).toEqual([undefined, far]);
    expect(b().transactions[far]).toMatchObject({ amount: 2000, transferSplitParentId: split });
  });

  it('undoes a whole import in one step, including a transfer it paired with an existing row', () => {
    const before = content(b());
    const other = 'savings-row';
    update('Savings import', (d) => void addTx(d, f.savings, '2026-10-06', 5000, null, { id: other, cleared: 'C', importIds: ['FITID:S1'] }));
    const afterSavings = content(b());
    update('Import', (d) => {
      const plan = planImport(d, f.checking, [
        { date: '2026-10-06', amount: -5000, payee: 'TFR', memo: '' },
        { date: '2026-10-07', amount: -1234, payee: 'BAKERY', memo: '' },
      ]);
      plan[0].transferAccountId = f.savings;
      applyImport(d, f.checking, plan);
    });
    expect(b().transactions[other].transferAccountId).toBe(f.checking);
    expect(Object.keys(b().transactions)).toHaveLength(4);

    expect(store.undo()).toBe('Import');
    expect(content(b())).toEqual(afterSavings);
    expect(b().transactions[other].transferAccountId).toBeUndefined();
    store.undo();
    expect(content(b())).toEqual(before);
  });

  it('undoes a Match by hand, bringing the bank row back and the typed date', () => {
    let mine = '';
    update('Typed', (d) => {
      mine = saveTransaction(d, { accountId: f.checking, date: '2026-10-04', amount: -800, categoryId: f.fun, cleared: 'U' });
    });
    update('Bank', (d) => void addTx(d, f.checking, '2026-10-06', -800, null, { id: 'bank', cleared: 'C', accepted: false, importIds: ['YNAB:-8.00:2026-10-06:1'], importedPayee: 'CINEMA' }));
    const before = content(b());
    update('Match', (d) => expect(matchTransactions(d, mine, 'bank')).toBeNull());
    expect(b().transactions.bank).toBeUndefined();
    expect(b().transactions[mine].date).toBe('2026-10-06');
    store.undo();
    expect(content(b())).toEqual(before);
    store.redo();
    expect(b().transactions.bank).toBeUndefined();
    expect(b().transactions[mine].matched).toBeDefined();
  });

  it('undoes the scheduler entering missed transactions, putting the schedule back on its old date', () => {
    let sid = '';
    update('Schedule', (d) => {
      sid = saveScheduled(d, { accountId: f.checking, date: '2026-08-31', startDate: '2026-08-31', frequency: 'Monthly', categoryId: f.rent, amount: -50000 });
    });
    update('Enter scheduled', (d) => expect(enterDueScheduled(d, '2026-10-13')).toBe(2));
    expect(b().scheduled[sid].date).toBe('2026-10-31');
    store.undo();
    expect(b().scheduled[sid].date).toBe('2026-08-31');
    expect(Object.values(b().transactions).filter((t) => t.scheduleId === sid)).toEqual([]);
  });

  it('never changes an older budget object when later edits are made (the snapshot an undo returns to)', () => {
    update('Typed', (d) => void saveTransaction(d, { id: undefined, accountId: f.checking, date: '2026-10-04', amount: -800, categoryId: f.fun, cleared: 'U' }));
    const snapshot = b();
    const frozen = content(snapshot);
    update('Clear all', (d) => {
      for (const t of Object.values(d.transactions)) t.cleared = 'R';
    });
    update('Budget', (d) => setBudgeted(d, '2026-10', f.fun, 100));
    expect(content(snapshot)).toEqual(frozen);
  });

  it('gives figures for the restored budget after an undo, not the cached ones', () => {
    update('Spend', (d) => void addTx(d, f.checking, '2026-10-05', -2000, f.fun));
    expect(store.computed()!.accounts.get(f.checking)!.working).toBe(98000);
    store.undo();
    expect(store.computed()!.accounts.get(f.checking)!.working).toBe(100000);
    expect(store.computed()!.accounts.get(f.checking)).toEqual(compute(b()).accounts.get(f.checking));
    store.redo();
    expect(store.computed()!.accounts.get(f.checking)!.working).toBe(98000);
  });

  it('keeps notes typed in bursts as one step only while nothing else happens in between', () => {
    update('Note', (d) => (d.accounts[f.checking].note = 'a'), { mergeKey: 'note' });
    update('Note', (d) => (d.accounts[f.checking].note = 'ab'), { mergeKey: 'note' });
    update('Budget', (d) => setBudgeted(d, '2026-10', f.fun, 100));
    update('Note', (d) => (d.accounts[f.checking].note = 'abc'), { mergeKey: 'note' });
    store.undo();
    expect(b().accounts[f.checking].note).toBe('ab');
    store.undo();
    expect(b().months['2026-10']).toBeUndefined();
    store.undo();
    expect(b().accounts[f.checking].note).toBeUndefined();
    expect(store.canUndo()).toBe(false);
  });

  it('keeps undo and redo working after "Save a copy as" gives the budget a new id', () => {
    update('Budget', (d) => setBudgeted(d, '2026-10', f.fun, 100));
    store.setId('copy-id');
    expect(store.undo()).toBe('Budget');
    expect(b().id).toBe('copy-id');
    expect(b().months['2026-10']).toBeUndefined();
    store.redo();
    expect(b()).toMatchObject({ id: 'copy-id' });
    expect(b().months['2026-10'][f.fun].budgeted).toBe(100);
  });
});
