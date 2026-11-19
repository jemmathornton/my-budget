// YNAB4's Match (1.5.6): a transaction you entered and a bank row, matched by hand. Made-up budgets only.
import { describe, expect, it } from 'vitest';
import { applyImport, matchTransactions, planImport, unmatchTransaction } from '../../src/import/match';
import { approveTransactions, enterDueScheduled, ensurePayee, saveScheduled, saveTransaction } from '../../src/model/ops';
import { compute } from '../../src/model/engine';
import { addTx, standardBudget } from './fixtures';

/** A transaction the import added: cleared, unapproved, with the bank's reference. */
function bankRow(b: ReturnType<typeof standardBudget>['b'], accountId: string, date: string, amount: number, categoryId: string | null, text = 'A N OTHER') {
  return addTx(b, accountId, date, amount, categoryId, {
    cleared: 'C',
    accepted: false,
    importIds: [`YNAB:${(amount / 100).toFixed(2)}:${date}:1`],
    importedPayee: text,
    payeeId: ensurePayee(b, text),
  });
}

describe('Match (YNAB4), by hand', () => {
  it('makes one transaction: your payee, category and memo, the bank’s reference and date, waiting to approve', () => {
    const { b, checking, groceries, fun } = standardBudget();
    const alex = ensurePayee(b, 'Alex')!;
    const mine = addTx(b, checking, '2026-11-01', -70000, groceries, { payeeId: alex, memo: 'mine', accepted: true });
    const bank = bankRow(b, checking, '2026-11-02', -70000, fun);
    const before = compute(b).budgetAccountsTotal;
    expect(matchTransactions(b, bank, mine)).toBeNull();
    expect(b.transactions[bank]).toBeUndefined();
    expect(b.transactions[mine]).toMatchObject({
      payeeId: alex,
      categoryId: groceries,
      memo: 'mine',
      amount: -70000,
      date: '2026-11-02',
      cleared: 'C',
      accepted: false,
      importIds: ['YNAB:-700.00:2026-11-02:1'],
      importedPayee: 'A N OTHER',
    });
    expect(b.transactions[mine].matched?.bank).toMatchObject({ date: '2026-11-02', amount: -70000, payee: 'A N OTHER' });
    // One payment, not two; and the bank's row isn't remembered as deleted.
    expect(compute(b).budgetAccountsTotal).toBe(before + 70000);
    expect(b.accounts[checking].deletedImports).toBeUndefined();
    approveTransactions(b, [mine]);
    expect(b.transactions[mine].accepted).toBe(true);
    expect(b.transactions[mine].matched).toBeUndefined();
  });

  it('is found again when the same file is imported again', () => {
    const { b, checking, groceries } = standardBudget();
    const mine = addTx(b, checking, '2026-11-01', -70000, groceries);
    const bank = bankRow(b, checking, '2026-11-02', -70000, null);
    matchTransactions(b, mine, bank);
    const again = planImport(b, checking, [{ date: '2026-11-02', amount: -70000, payee: 'A N OTHER', memo: '' }]);
    expect(again[0]).toMatchObject({ kind: 'duplicate', matchId: mine });
  });

  it('takes the bank’s amount when they differ, and Unmatch puts both back', () => {
    const { b, checking, groceries } = standardBudget();
    const mine = addTx(b, checking, '2026-11-01', -1000, groceries, { memo: 'typed' });
    const bank = bankRow(b, checking, '2026-11-03', -1050, null, 'CAFE ABROAD');
    expect(matchTransactions(b, mine, bank)).toBeNull();
    expect(b.transactions[mine]).toMatchObject({ amount: -1050, date: '2026-11-03' });
    const back = unmatchTransaction(b, mine)!;
    expect(b.transactions[mine]).toMatchObject({ amount: -1000, date: '2026-11-01', cleared: 'U', accepted: true, memo: 'typed' });
    expect(b.transactions[mine].importIds).toBeUndefined();
    expect(b.transactions[back]).toMatchObject({ amount: -1050, date: '2026-11-03', importIds: ['YNAB:-10.50:2026-11-03:1'], accepted: false });
  });

  it('keeps a reconciled or cleared date, as an import does', () => {
    const { b, checking } = standardBudget();
    const mine = addTx(b, checking, '2026-11-01', -500, null, { cleared: 'C' });
    const bank = bankRow(b, checking, '2026-11-04', -500, null);
    matchTransactions(b, mine, bank);
    expect(b.transactions[mine].date).toBe('2026-11-01');
  });

  it('a scheduled transfer to a saver: matched, then approved with its saver side (M10)', () => {
    const { b, checking, savings } = standardBudget();
    const sid = saveScheduled(b, { accountId: checking, date: '2026-11-01', startDate: '2026-11-01', frequency: 'Monthly', transferAccountId: savings, categoryId: null, amount: -20000 });
    enterDueScheduled(b, '2026-11-01');
    const mine = Object.values(b.transactions).find((t) => t.scheduleId === sid)!;
    const far = mine.transferTxId!;
    const bank = bankRow(b, checking, '2026-11-02', -20000, null, 'FLEX REGULAR SAVER');
    expect(matchTransactions(b, mine.id, bank)).toBeNull();
    // Its saver side moves with it, and waits too.
    expect(b.transactions[far]).toMatchObject({ date: '2026-11-02', amount: 20000, accepted: false });
    approveTransactions(b, [mine.id]);
    expect([b.transactions[mine.id].accepted, b.transactions[far].accepted]).toEqual([true, true]);
  });

  it('a bank row the import made into a transfer goes with its far side', () => {
    const { b, checking, savings } = standardBudget();
    const mine = addTx(b, checking, '2026-11-01', -20000, null);
    applyImport(b, checking, [
      { key: 0, src: { date: '2026-11-02', amount: -20000, payee: 'FLEX REGULAR SAVER', memo: '' }, kind: 'new', include: true, importIds: ['YNAB:-200.00:2026-11-02:1'], transferAccountId: savings, payeeName: 'x' },
    ]);
    const bank = Object.values(b.transactions).find((t) => t.importIds?.length && t.accountId === checking)!;
    expect(Object.values(b.transactions).filter((t) => t.accountId === savings)).toHaveLength(1);
    expect(matchTransactions(b, mine, bank.id)).toBeNull();
    expect(Object.values(b.transactions).filter((t) => t.accountId === savings)).toHaveLength(0);
  });

  it('says why when two rows can’t be matched, changing nothing', () => {
    const { b, checking, savings } = standardBudget();
    const typed = addTx(b, checking, '2026-11-01', -500, null);
    const typed2 = addTx(b, checking, '2026-11-01', -500, null);
    const elsewhere = bankRow(b, savings, '2026-11-01', -500, null);
    const bank = bankRow(b, checking, '2026-11-01', -500, null);
    const bank2 = bankRow(b, checking, '2026-11-01', -600, null, 'OTHER');
    const snapshot = JSON.stringify(b);
    expect(matchTransactions(b, typed, elsewhere)).toMatch(/same account/);
    expect(matchTransactions(b, typed, typed2)).toMatch(/one transaction you entered and one from the bank/);
    expect(matchTransactions(b, bank, bank2)).toMatch(/one transaction you entered and one from the bank/);
    expect(JSON.stringify(b)).toBe(snapshot);
    // A bank row paired with the other account's own bank row would take that row with it.
    const t = saveTransaction(b, { accountId: checking, transferAccountId: savings, date: '2026-11-05', amount: -900, cleared: 'C', importIds: ['YNAB:-9.00:2026-11-05:1'] });
    b.transactions[b.transactions[t].transferTxId!].importIds = ['YNAB:9.00:2026-11-05:1'];
    const typed3 = addTx(b, checking, '2026-11-04', -900, null);
    expect(matchTransactions(b, typed3, t)).toMatch(/paired with Savings/);
  });

  it('1.5.10: leaves reconciled amounts alone', () => {
    const { b, checking, savings } = standardBudget();
    // A reconciled bank row would go, changing the reconciled balance.
    const typed = addTx(b, checking, '2026-11-01', -500, null);
    const bankR = addTx(b, checking, '2026-11-01', -500, null, { cleared: 'R', importIds: ['YNAB:-5.00:2026-11-01:1'] });
    // Yours reconciled, with a different amount: it would change.
    const typedR = addTx(b, checking, '2026-11-02', -700, null, { cleared: 'R' });
    const bank = bankRow(b, checking, '2026-11-02', -750, null);
    // A transfer whose other side came from the other bank, with a different amount.
    const tr = saveTransaction(b, { accountId: checking, transferAccountId: savings, date: '2026-11-03', amount: -900, cleared: 'U' });
    b.transactions[b.transactions[tr].transferTxId!].importIds = ['YNAB:9.00:2026-11-03:1'];
    const bank2 = bankRow(b, checking, '2026-11-03', -950, null, 'OTHER');
    const snapshot = JSON.stringify(b);
    expect(matchTransactions(b, typed, bankR)).toMatch(/reconciled/);
    expect(matchTransactions(b, typedR, bank)).toMatch(/reconciled/);
    expect(matchTransactions(b, tr, bank2)).toMatch(/Savings's bank/);
    expect(JSON.stringify(b)).toBe(snapshot);
    // The same amount, reconciled on your side: fine, nothing about it changes.
    const bank3 = bankRow(b, checking, '2026-11-02', -700, null, 'SAME');
    expect(matchTransactions(b, typedR, bank3)).toBeNull();
    expect(b.transactions[typedR]).toMatchObject({ amount: -700, cleared: 'R', date: '2026-11-02' });
  });
});
