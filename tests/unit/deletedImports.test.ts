// Remembering imported transactions that were deleted, so importing the same bank file again
// doesn't bring them back (YNAB4 did the same with its deleted records).
import { describe, expect, it } from 'vitest';
import type { BankTxn } from '../../src/import/bank';
import { applyImport, planImport } from '../../src/import/match';
import { addDeletedImports, deleteTransactions, saveTransaction } from '../../src/model/ops';
import type { Budget } from '../../src/model/types';
import { store, update } from '../../src/state/store';
import { addTx, standardBudget } from './fixtures';

const row = (date: string, amount: number, payee = 'SHOP', extra: Partial<BankTxn> = {}): BankTxn => ({
  date,
  amount,
  payee,
  memo: '',
  ...extra,
});

describe('deleting imported transactions', () => {
  it('remembers an imported transaction’s ids on its account, with the time', () => {
    const { b, checking } = standardBudget();
    const id = addTx(b, checking, '2026-01-05', -1000, null, { importIds: ['FITID:A1', 'YNAB:-10.00:2026-01-05:1'] });
    deleteTransactions(b, [id]);
    expect(b.transactions[id]).toBeUndefined();
    expect(b.accounts[checking].deletedImports).toEqual([
      { ids: ['FITID:A1', 'YNAB:-10.00:2026-01-05:1'], deletedAt: expect.any(String) },
    ]);
  });

  it('remembers nothing for a transaction typed in by hand', () => {
    const { b, checking } = standardBudget();
    const id = addTx(b, checking, '2026-01-05', -1000, null);
    deleteTransactions(b, [id]);
    expect(b.accounts[checking].deletedImports).toBeUndefined();
  });

  it('remembers the other side of a transfer on its own account when that side was imported', () => {
    const { b, checking, savings } = standardBudget();
    const id = saveTransaction(b, { accountId: checking, date: '2026-01-05', transferAccountId: savings, amount: -5000, cleared: 'U' });
    const peer = b.transactions[id].transferTxId!;
    b.transactions[peer].importIds = ['FITID:SAV1'];
    deleteTransactions(b, [id]);
    expect(b.accounts[savings].deletedImports?.[0].ids).toEqual(['FITID:SAV1']);
    expect(b.accounts[checking].deletedImports).toBeUndefined();
  });

  it('remembers an imported transfer peer removed by turning the transfer into an ordinary transaction', () => {
    const { b, checking, savings, groceries } = standardBudget();
    const id = saveTransaction(b, { accountId: checking, date: '2026-01-05', transferAccountId: savings, amount: -5000, cleared: 'U' });
    const peer = b.transactions[id].transferTxId!;
    b.transactions[peer].importIds = ['FITID:SAV2'];
    saveTransaction(b, { id, accountId: checking, date: '2026-01-05', categoryId: groceries, payeeName: 'Shop', amount: -5000, cleared: 'U' });
    expect(b.transactions[peer]).toBeUndefined();
    expect(b.accounts[savings].deletedImports?.[0].ids).toEqual(['FITID:SAV2']);
  });

  it('undoing the delete forgets the record; undoing an import leaves none', () => {
    const { b, checking } = standardBudget();
    const id = addTx(b, checking, '2026-01-05', -1000, null, { importIds: ['FITID:U1'] });
    store.load(b);
    update('Delete', (d) => deleteTransactions(d, [id]));
    expect(store.budget!.accounts[checking].deletedImports).toHaveLength(1);
    store.undo();
    expect(store.budget!.accounts[checking].deletedImports).toBeUndefined();
    update('Import', (d) => applyImport(d, checking, planImport(d, checking, [row('2026-01-06', -200, 'X', { fitid: 'N1' })])));
    store.undo();
    expect(store.budget!.accounts[checking].deletedImports).toBeUndefined();
    store.load(null);
  });
});

describe('addDeletedImports', () => {
  it('skips unknown accounts, ids already remembered and ids still on a transaction, and can run twice', () => {
    const { b, checking } = standardBudget();
    addTx(b, checking, '2026-01-05', -1000, null, { importIds: ['YNAB:-1234.56:2026-01-05:1'] });
    const records = new Map([
      [checking, [{ ids: ['FITID:D1'] }, { ids: ['YNAB:-1,234.56:2026-01-05:1'] }, { ids: ['FITID:D2', 'YNAB:-1.00:2026-01-07:1'] }]],
      ['no-such-account', [{ ids: ['FITID:Z'] }]],
    ]);
    expect(addDeletedImports(b, records)).toBe(2);
    expect(b.accounts[checking].deletedImports!.map((d) => d.ids)).toEqual([['FITID:D1'], ['FITID:D2', 'YNAB:-1.00:2026-01-07:1']]);
    expect(addDeletedImports(b, records)).toBe(0);
  });
});

describe('planImport: previously deleted', () => {
  function withDeleted(ids: string[][]): { b: Budget; checking: string } {
    const { b, checking } = standardBudget();
    b.accounts[checking].deletedImports = ids.map((x) => ({ ids: x }));
    return { b, checking };
  }

  it('leaves out a row whose FITID was deleted', () => {
    const { b, checking } = withDeleted([['FITID:F1']]);
    const [r] = planImport(b, checking, [row('2026-01-05', -1000, 'SHOP', { fitid: 'F1' })]);
    expect(r).toMatchObject({ kind: 'deleted', include: false });
  });

  it('leaves out a row whose YNAB-style id was deleted, ignoring thousands commas', () => {
    const { b, checking } = withDeleted([['YNAB:-1,234.56:2026-01-05:1']]);
    const [r] = planImport(b, checking, [row('2026-01-05', -123456)]);
    expect(r.kind).toBe('deleted');
  });

  it('only uses a YNAB-style id when the deleted record had no FITID of its own', () => {
    const { b, checking } = withDeleted([['FITID:OTHER', 'YNAB:-10.00:2026-01-05:1']]);
    const [r] = planImport(b, checking, [row('2026-01-05', -1000, 'SHOP', { fitid: 'NEW' })]);
    expect(r.kind).toBe('new');
  });

  it('prefers "already imported" to "previously deleted"', () => {
    const { b, checking } = withDeleted([['FITID:F1']]);
    addTx(b, checking, '2026-01-05', -1000, null, { importIds: ['FITID:F1'] });
    const [r] = planImport(b, checking, [row('2026-01-05', -1000, 'SHOP', { fitid: 'F1' })]);
    expect(r.kind).toBe('duplicate');
  });

  it("doesn't match a deleted row to a transaction typed in by hand", () => {
    const { b, checking } = withDeleted([['FITID:F1']]);
    addTx(b, checking, '2026-01-04', -1000, null);
    const [r] = planImport(b, checking, [row('2026-01-05', -1000, 'SHOP', { fitid: 'F1' })]);
    expect(r.kind).toBe('deleted');
    expect(r.matchId).toBeUndefined();
  });

  it('ignores records in other accounts', () => {
    const { b, checking, savings } = standardBudget();
    b.accounts[savings].deletedImports = [{ ids: ['FITID:F1'] }];
    const [r] = planImport(b, checking, [row('2026-01-05', -1000, 'SHOP', { fitid: 'F1' })]);
    expect(r.kind).toBe('new');
  });

  it('imports a ticked deleted row again and forgets that it was deleted', () => {
    const { b, checking } = withDeleted([['FITID:F1'], ['FITID:F2']]);
    const plan = planImport(b, checking, [row('2026-01-05', -1000, 'SHOP', { fitid: 'F1' })]);
    plan[0].include = true;
    expect(applyImport(b, checking, plan).added).toBe(1);
    expect(Object.values(b.transactions).some((t) => t.importIds?.includes('FITID:F1'))).toBe(true);
    expect(b.accounts[checking].deletedImports).toEqual([{ ids: ['FITID:F2'] }]);
  });

  it('a deleted row that stays unticked changes nothing', () => {
    const { b, checking } = withDeleted([['FITID:F1']]);
    const plan = planImport(b, checking, [row('2026-01-05', -1000, 'SHOP', { fitid: 'F1' })]);
    expect(applyImport(b, checking, plan).added).toBe(0);
    expect(b.accounts[checking].deletedImports).toHaveLength(1);
  });
});
