// Extra coverage for imports and transfer peers (November 2026 test review). Made-up budgets only.
//
// Some of these tests pin down what the app does NOW in cases that are still open design
// questions (marked "CURRENT BEHAVIOUR"). If the design changes, change the test with it: it is
// here so that a change is made on purpose, not by accident.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BankTxn } from '../../src/import/bank';
import { applyImport, matchTransactions, planImport, unmatchTransaction } from '../../src/import/match';
import { checkBudget } from '../../src/model/check';
import { categoryMonth, compute } from '../../src/model/engine';
import { deleteTransactions, ensurePayee, saveTransaction, setPayeeRules } from '../../src/model/ops';
import { transferPayeeId } from '../../src/model/queries';
import { INCOME_NOW, SPLIT, type Budget } from '../../src/model/types';
import { addTx, setNow, standardBudget } from './fixtures';

afterEach(() => vi.useRealTimers());

const row = (date: string, amount: number, payee = 'SHOP', extra: Partial<BankTxn> = {}): BankTxn => ({ date, amount, payee, memo: '', ...extra });
const txs = (b: Budget) => Object.values(b.transactions);

describe('transfer pairing on import against an existing row (CURRENT BEHAVIOUR, open design question)', () => {
  // Checking's file has "TFR TO SAVINGS", which a rule turns into a transfer to Savings. Savings'
  // own file was imported first, so its side is already there. applyImport (match.ts, the
  // "pair with it instead of creating a second copy" loop) pairs with any imported row in the
  // other account with the opposite amount within 3 days that isn't a transfer or a split: it
  // doesn't look at whether that row was categorised, approved or reconciled.
  function pairing(otherExtra: Parameters<typeof addTx>[5] = {}, otherDate = '2026-01-11') {
    const f = standardBudget();
    const { b, checking, savings } = f;
    setPayeeRules(b, transferPayeeId(savings), [{ op: 'contains', text: 'TO SAVINGS' }]);
    const other = addTx(b, savings, otherDate, 5000, null, {
      payeeId: ensurePayee(b, 'FROM CURRENT AC'),
      cleared: 'C',
      importIds: ['FITID:S1'],
      importedPayee: 'FROM CURRENT AC',
      ...otherExtra,
    });
    const plan = planImport(b, checking, [row('2026-01-10', -5000, 'TFR TO SAVINGS', { fitid: 'C1' })]);
    return { ...f, other, plan };
  }

  it('turns an approved, categorised row into the transfer, dropping its category and payee', () => {
    setNow(2026, 2, 1);
    const { b, checking, savings, other, plan, groceries } = pairing();
    b.transactions[other].categoryId = groceries;
    expect(categoryMonth(compute(b), '2026-01', groceries).activity).toBe(5000);
    expect(plan[0].transferAccountId).toBe(savings);

    expect(applyImport(b, checking, plan)).toEqual({ added: 1, matched: 0 });
    // CURRENT BEHAVIOUR: the user's category and payee on the Savings row are replaced without a
    // question, because a transfer between two budget accounts has no category.
    expect(b.transactions[other]).toMatchObject({
      transferAccountId: checking,
      payeeId: transferPayeeId(checking),
      categoryId: null,
      accepted: true,
      importIds: ['FITID:S1'],
      importedPayee: 'FROM CURRENT AC',
    });
    expect(categoryMonth(compute(b), '2026-01', groceries).activity).toBe(0);
    expect(checkBudget(b)).toEqual([]);
  });

  it('leaves a reconciled row on its own date and gives the new side that date too', () => {
    // The bank's date (10th) is earlier, which would normally win, but a reconciled side keeps its date.
    const { b, checking, other, plan } = pairing({ cleared: 'R' });
    applyImport(b, checking, plan);
    const mine = txs(b).find((t) => t.accountId === checking)!;
    expect(b.transactions[other]).toMatchObject({ date: '2026-01-11', cleared: 'R', amount: 5000, transferTxId: mine.id });
    // CURRENT BEHAVIOUR: the reconciled row is still paired (its payee changes, its amount doesn't).
    expect(b.transactions[other].payeeId).toBe(transferPayeeId(checking));
    expect(mine).toMatchObject({ date: '2026-01-11', amount: -5000, cleared: 'C', transferTxId: other });
    expect(checkBudget(b)).toEqual([]);
  });

  it("doesn't approve a row that was waiting for approval, even when the import approves its own", () => {
    const { b, checking, other, plan } = pairing({ accepted: false });
    applyImport(b, checking, plan, true);
    const mine = txs(b).find((t) => t.accountId === checking)!;
    expect(mine.accepted).toBe(true);
    // CURRENT BEHAVIOUR: the Savings side still waits for its own approval.
    expect(b.transactions[other].accepted).toBe(false);
  });

  it('removes the side saveTransaction made first without remembering it as a deleted import', () => {
    const { b, checking, savings, plan } = pairing();
    applyImport(b, checking, plan);
    expect(txs(b)).toHaveLength(2);
    expect(txs(b).filter((t) => t.accountId === savings)).toHaveLength(1);
    expect(b.accounts[savings].deletedImports).toBeUndefined();
  });

  it('pairs with a tracking account row, and the budget side then needs a category', () => {
    setNow(2026, 2, 1);
    const { b, checking, mortgage } = standardBudget();
    setPayeeRules(b, transferPayeeId(mortgage), [{ op: 'contains', text: 'MORTGAGE' }]);
    const other = addTx(b, mortgage, '2026-01-10', 80000, null, { cleared: 'C', importIds: ['FITID:M1'], importedPayee: 'PAYMENT RECEIVED' });
    const plan = planImport(b, checking, [row('2026-01-10', -80000, 'MORTGAGE PAYMENT', { fitid: 'C1' })]);
    applyImport(b, checking, plan);
    const mine = txs(b).find((t) => t.accountId === checking)!;
    expect(b.transactions[other]).toMatchObject({ transferAccountId: checking, transferTxId: mine.id, categoryId: null });
    expect(mine.transferAccountId).toBe(mortgage);
    expect(compute(b).uncategorized).toEqual([mine.id]);
  });

  it("doesn't pair a row whose amount is the same sign (money out on both sides)", () => {
    const { b, checking, savings } = standardBudget();
    setPayeeRules(b, transferPayeeId(savings), [{ op: 'contains', text: 'TO SAVINGS' }]);
    const other = addTx(b, savings, '2026-01-10', -5000, null, { cleared: 'C', importIds: ['FITID:S1'] });
    applyImport(b, checking, planImport(b, checking, [row('2026-01-10', -5000, 'TFR TO SAVINGS')]));
    expect(b.transactions[other].transferAccountId).toBeUndefined();
    expect(txs(b).filter((t) => t.accountId === savings)).toHaveLength(2);
  });
});

describe('import match re-dating transfer peers', () => {
  // A split in Checking with one line a transfer to Savings, typed by hand. Its far side in
  // Savings is what the Savings import matches.
  function splitWithFarSide(parentExtra: { cleared?: 'U' | 'C' | 'R'; importIds?: string[] } = {}) {
    const f = standardBudget();
    const { b, checking, savings, groceries } = f;
    const parent = saveTransaction(b, {
      accountId: checking,
      date: '2026-01-10',
      categoryId: SPLIT,
      amount: -3000,
      cleared: 'U',
      splits: [
        { id: 'a', categoryId: groceries, amount: -1000 },
        { id: 'b', categoryId: null, amount: -2000, transferAccountId: savings },
      ],
    });
    Object.assign(b.transactions[parent], parentExtra);
    const far = b.transactions[parent].splits![1].transferTxId!;
    return { ...f, parent, far };
  }

  it("moves a typed split's date when the import matches its far side", () => {
    const { b, savings, parent, far } = splitWithFarSide();
    const plan = planImport(b, savings, [row('2026-01-12', 2000, 'FROM CURRENT')]);
    expect(plan[0]).toMatchObject({ kind: 'match', matchId: far });
    applyImport(b, savings, plan);
    expect(b.transactions[far]).toMatchObject({ date: '2026-01-12', cleared: 'C' });
    expect(b.transactions[parent].date).toBe('2026-01-12');
    expect(checkBudget(b)).toEqual([]);
  });

  it("leaves both on their date when the split is reconciled", () => {
    const { b, savings, parent, far } = splitWithFarSide({ cleared: 'R' });
    applyImport(b, savings, planImport(b, savings, [row('2026-01-12', 2000, 'FROM CURRENT')]));
    expect(b.transactions[far].date).toBe('2026-01-10');
    expect(b.transactions[parent].date).toBe('2026-01-10');
  });

  it("leaves both on their date when the split came from Checking's own bank file", () => {
    const { b, savings, parent, far } = splitWithFarSide({ cleared: 'C', importIds: ['FITID:C9'] });
    applyImport(b, savings, planImport(b, savings, [row('2026-01-12', 2000, 'FROM CURRENT')]));
    expect(b.transactions[far].date).toBe('2026-01-10');
    expect(b.transactions[parent].date).toBe('2026-01-10');
  });

  it('keeps a typed transfer on its date when its other side is reconciled (import, as for Match)', () => {
    const { b, checking, savings } = standardBudget();
    const typed = saveTransaction(b, { accountId: checking, date: '2026-01-10', transferAccountId: savings, amount: -5000, cleared: 'U' });
    const peer = b.transactions[typed].transferTxId!;
    b.transactions[peer].cleared = 'R';
    applyImport(b, checking, planImport(b, checking, [row('2026-01-12', -5000)]));
    expect(b.transactions[typed]).toMatchObject({ date: '2026-01-10', cleared: 'C' });
    expect(b.transactions[peer].date).toBe('2026-01-10');
  });

  it('still moves a typed transfer and its other side when approving straight away', () => {
    const { b, checking, savings } = standardBudget();
    const typed = saveTransaction(b, { accountId: checking, date: '2026-01-10', transferAccountId: savings, amount: -5000, cleared: 'U' });
    applyImport(b, checking, planImport(b, checking, [row('2026-01-13', -5000)]), true);
    expect(b.transactions[typed]).toMatchObject({ date: '2026-01-13', accepted: true });
    expect(b.transactions[typed].matched).toBeUndefined();
    expect(b.transactions[b.transactions[typed].transferTxId!].date).toBe('2026-01-13');
  });

  it("Match by hand on a split's far side moves the split, and Unmatch moves it all back", () => {
    const { b, savings, parent, far } = splitWithFarSide();
    const bank = addTx(b, savings, '2026-01-12', 2000, null, { cleared: 'C', accepted: false, importIds: ['YNAB:20.00:2026-01-12:1'], importedPayee: 'FROM CURRENT' });
    expect(matchTransactions(b, far, bank)).toBeNull();
    expect(b.transactions[far].date).toBe('2026-01-12');
    expect(b.transactions[parent].date).toBe('2026-01-12');
    unmatchTransaction(b, far);
    expect(b.transactions[far].date).toBe('2026-01-10');
    expect(b.transactions[parent].date).toBe('2026-01-10');
  });

  it("Match by hand leaves a transfer's date alone when its other side came from that account's bank", () => {
    const { b, checking, savings } = standardBudget();
    const typed = saveTransaction(b, { accountId: checking, date: '2026-01-10', transferAccountId: savings, amount: -5000, cleared: 'U' });
    const peer = b.transactions[typed].transferTxId!;
    b.transactions[peer].importIds = ['FITID:S1'];
    const bank = addTx(b, checking, '2026-01-12', -5000, null, { cleared: 'C', accepted: false, importIds: ['YNAB:-50.00:2026-01-12:1'], importedPayee: 'TFR' });
    expect(matchTransactions(b, typed, bank)).toBeNull();
    expect(b.transactions[typed].date).toBe('2026-01-10');
    expect(b.transactions[peer].date).toBe('2026-01-10');
  });
});

describe("deleting a split line's far side", () => {
  function bankSplit() {
    setNow(2026, 2, 1);
    const f = standardBudget();
    const { b, checking, savings, groceries } = f;
    addTx(b, checking, '2026-01-01', 100000, INCOME_NOW, { cleared: 'C' });
    // The bank's row, split afterwards into shopping and money put by.
    const parent = saveTransaction(b, {
      accountId: checking,
      date: '2026-01-10',
      categoryId: SPLIT,
      amount: -3000,
      cleared: 'C',
      importIds: ['FITID:C1', 'YNAB:-30.00:2026-01-10:1'],
      importedPayee: 'SUPERSTORE',
      splits: [
        { id: 'a', categoryId: groceries, amount: -1000 },
        { id: 'b', categoryId: null, amount: -2000, transferAccountId: savings },
      ],
    });
    const far = b.transactions[parent].splits![1].transferTxId!;
    return { ...f, parent, far };
  }

  it('takes the line off the bank-imported split, so the split no longer equals the bank amount (CURRENT BEHAVIOUR)', () => {
    const { b, checking, savings, parent, far } = bankSplit();
    const before = compute(b).accounts.get(checking)!.working;
    deleteTransactions(b, [far]);
    expect(b.transactions[far]).toBeUndefined();
    expect(b.transactions[parent]).toMatchObject({ amount: -1000, categoryId: SPLIT, importIds: ['FITID:C1', 'YNAB:-30.00:2026-01-10:1'] });
    expect(b.transactions[parent].splits!.map((s) => s.id)).toEqual(['a']);
    // Checking's balance moves by the line's amount, away from what the bank says.
    expect(compute(b).accounts.get(checking)!.working - before).toBe(2000);
    // The far side was typed (no import ids), so nothing is remembered on Savings.
    expect(b.accounts[savings].deletedImports).toBeUndefined();
    expect(checkBudget(b)).toEqual([]);
  });

  it('is not put right by importing the same file again: the row is still a duplicate', () => {
    const { b, checking, parent, far } = bankSplit();
    deleteTransactions(b, [far]);
    const plan = planImport(b, checking, [row('2026-01-10', -3000, 'SUPERSTORE', { fitid: 'C1' })]);
    expect(plan[0]).toMatchObject({ kind: 'duplicate', matchId: parent, include: false });
  });

  it('turns a split whose only line was the transfer into an uncategorised zero', () => {
    const { b, checking, savings } = standardBudget();
    const parent = saveTransaction(b, {
      accountId: checking,
      date: '2026-01-10',
      categoryId: SPLIT,
      amount: -2000,
      cleared: 'C',
      importIds: ['FITID:C1'],
      splits: [{ id: 'only', categoryId: null, amount: -2000, transferAccountId: savings }],
    });
    deleteTransactions(b, [b.transactions[parent].splits![0].transferTxId!]);
    expect(b.transactions[parent]).toMatchObject({ amount: 0, categoryId: null });
    expect(b.transactions[parent].splits).toBeUndefined();
    expect(checkBudget(b)).toEqual([]);
  });

  it("remembers the far side's own import ids on its account", () => {
    const { b, savings, far } = bankSplit();
    b.transactions[far].importIds = ['FITID:S7'];
    deleteTransactions(b, [far]);
    expect(b.accounts[savings].deletedImports?.map((d) => d.ids)).toEqual([['FITID:S7']]);
  });

  it('leaves nothing behind whichever order the split and its far side are deleted in', () => {
    for (const order of ['parent first', 'far side first']) {
      const { b, parent, far } = bankSplit();
      const ids = order === 'parent first' ? [parent, far] : [far, parent];
      deleteTransactions(b, ids);
      expect(b.transactions[parent]).toBeUndefined();
      expect(b.transactions[far]).toBeUndefined();
      expect(checkBudget(b)).toEqual([]);
    }
  });
});
