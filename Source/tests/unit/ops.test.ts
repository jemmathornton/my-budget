import { afterEach, describe, expect, it, vi } from 'vitest';
import { compute, categoryMonth } from '../../src/model/engine';
import {
  addAccount,
  addCategory,
  addMaster,
  approveTransactions,
  categorizeTransactions,
  deleteAccount,
  deleteCategory,
  deleteMaster,
  deleteTransactions,
  deleteUnusedPayees,
  enterDueScheduled,
  enterScheduled,
  ensurePayee,
  mergePayees,
  moveAccount,
  moveCategory,
  moveMaster,
  moveMoney,
  moveTransactions,
  reconcileAccount,
  clearedBalance,
  renamePayee,
  saveScheduled,
  saveTransaction,
  scheduleFromTransaction,
  setBudgeted,
  setBudgetedMany,
  setCategoryMonthNote,
  setCleared,
  setFlag,
  setMonthNote,
  setPayeeAutoFill,
  setPayeeHidden,
  setPayeeRules,
  setTransactionsDate,
  setTransactionsPayee,
  skipScheduled,
  toggleCleared,
  updateAccount,
  type TransactionInput,
} from '../../src/model/ops';
import { categoriesOf, findPayeeByName, sortedAccounts, sortedMasters, transferNeedsCategory, transferPayeeId } from '../../src/model/queries';
import { INCOME_NOW, SPLIT, type Budget, type Split } from '../../src/model/types';
import { checkBudget } from '../../src/model/check';
import { addTx, emptyBudget, setNow, standardBudget } from './fixtures';

afterEach(() => vi.useRealTimers());

const txs = (b: Budget) => Object.values(b.transactions);
const inAccount = (b: Budget, accountId: string) => txs(b).filter((t) => t.accountId === accountId);

describe('transfers', () => {
  function transfer(b: Budget, from: string, to: string, extra: Partial<TransactionInput> = {}) {
    return saveTransaction(b, { accountId: from, transferAccountId: to, date: '2026-02-01', amount: -5000, cleared: 'C', ...extra });
  }

  it('creates both sides, without categories between budget accounts', () => {
    const { b, checking, savings, groceries } = standardBudget();
    const id = transfer(b, checking, savings, { categoryId: groceries, memo: 'Top up' });
    const t = b.transactions[id];
    const peer = b.transactions[t.transferTxId!];
    expect(t).toMatchObject({ accountId: checking, transferAccountId: savings, categoryId: null, payeeId: transferPayeeId(savings), cleared: 'C', amount: -5000 });
    expect(peer).toMatchObject({
      accountId: savings,
      transferAccountId: checking,
      transferTxId: id,
      amount: 5000,
      date: '2026-02-01',
      memo: 'Top up',
      categoryId: null,
      payeeId: transferPayeeId(checking),
      cleared: 'U',
      accepted: true,
    });
    expect(peer.transferSplitParentId).toBeUndefined();
    expect(txs(b)).toHaveLength(2);
    expect(compute(b).uncategorized).toEqual([]);
  });

  it('updates the other side when either side is edited, keeping each side’s cleared state', () => {
    const { b, checking, savings } = standardBudget();
    const id = transfer(b, checking, savings);
    const peerId = b.transactions[id].transferTxId!;
    setCleared(b, [peerId], 'R');

    saveTransaction(b, { id, accountId: checking, transferAccountId: savings, date: '2026-02-03', amount: -7000, cleared: 'C', memo: 'More' });
    expect(b.transactions[peerId]).toMatchObject({ amount: 7000, date: '2026-02-03', memo: 'More', cleared: 'R' });

    saveTransaction(b, { id: peerId, accountId: savings, transferAccountId: checking, date: '2026-02-04', amount: 8000, cleared: 'R' });
    expect(b.transactions[id]).toMatchObject({ amount: -8000, date: '2026-02-04', cleared: 'C', transferTxId: peerId });
    expect(b.transactions[id].memo).toBeUndefined();
    expect(txs(b)).toHaveLength(2);
  });

  it('moves the far side when the transfer account changes', () => {
    const { b, checking, savings, card } = standardBudget();
    const id = transfer(b, checking, savings);
    const oldPeer = b.transactions[id].transferTxId!;
    transfer(b, checking, card, { id });
    const t = b.transactions[id];
    expect(b.transactions[oldPeer]).toBeUndefined();
    expect(t.transferAccountId).toBe(card);
    expect(t.payeeId).toBe(transferPayeeId(card));
    expect(b.transactions[t.transferTxId!]).toMatchObject({ accountId: card, amount: 5000, transferTxId: id });
    expect(txs(b)).toHaveLength(2);
    expect(inAccount(b, savings)).toEqual([]);
  });

  it('removes the far side when a transfer becomes an ordinary transaction', () => {
    const { b, checking, savings, groceries } = standardBudget();
    const id = transfer(b, checking, savings);
    const peerId = b.transactions[id].transferTxId!;
    saveTransaction(b, { id, accountId: checking, payeeName: 'Corner Shop', categoryId: groceries, date: '2026-02-01', amount: -5000, cleared: 'C' });
    const t = b.transactions[id];
    expect(b.transactions[peerId]).toBeUndefined();
    expect(t.transferAccountId).toBeUndefined();
    expect(t.transferTxId).toBeUndefined();
    expect(t.categoryId).toBe(groceries);
    expect(b.payees[t.payeeId!].name).toBe('Corner Shop');
    expect(txs(b)).toHaveLength(1);
  });

  it('adds a far side when an ordinary transaction becomes a transfer', () => {
    const { b, checking, savings, groceries } = standardBudget();
    const id = saveTransaction(b, { accountId: checking, payeeName: 'Shop', categoryId: groceries, date: '2026-02-01', amount: -5000, cleared: 'U' });
    transfer(b, checking, savings, { id, categoryId: groceries });
    const t = b.transactions[id];
    expect(t.categoryId).toBeNull();
    expect(b.transactions[t.transferTxId!]).toMatchObject({ accountId: savings, amount: 5000 });
  });

  it('treats a "transfer" to the same account as an ordinary transaction', () => {
    const { b, checking } = standardBudget();
    const id = transfer(b, checking, checking);
    expect(b.transactions[id].transferAccountId).toBeUndefined();
    expect(txs(b)).toHaveLength(1);
  });

  it('keeps a category on the budget side of a budget -> tracking transfer only', () => {
    const { b, checking, mortgage, rent, groceries } = standardBudget();
    const id = transfer(b, checking, mortgage, { categoryId: rent });
    const peerId = b.transactions[id].transferTxId!;
    expect(b.transactions[id].categoryId).toBe(rent);
    expect(b.transactions[peerId].categoryId).toBeNull();
    expect(categoryMonth(compute(b), '2026-02', rent).activity).toBe(-5000);

    // Editing the tracking side keeps the budget side's category.
    saveTransaction(b, { id: peerId, accountId: mortgage, transferAccountId: checking, categoryId: groceries, date: '2026-02-01', amount: 6000, cleared: 'U' });
    expect(b.transactions[id]).toMatchObject({ amount: -6000, categoryId: rent });
    expect(b.transactions[peerId].categoryId).toBeNull();
  });

  it('leaves the budget side uncategorised when a tracking -> budget transfer is entered from the tracking side', () => {
    const { b, checking, mortgage, rent } = standardBudget();
    const id = transfer(b, mortgage, checking, { categoryId: rent, amount: -2000 });
    const peer = b.transactions[b.transactions[id].transferTxId!];
    expect(b.transactions[id].categoryId).toBeNull();
    expect(peer).toMatchObject({ accountId: checking, amount: 2000, categoryId: null });
    expect(compute(b).uncategorized).toEqual([peer.id]);
  });

  it('deletes both sides from either side', () => {
    const { b, checking, savings } = standardBudget();
    const a = transfer(b, checking, savings);
    deleteTransactions(b, [b.transactions[a].transferTxId!]);
    expect(txs(b)).toEqual([]);
    const c = transfer(b, checking, savings);
    deleteTransactions(b, [c, b.transactions[c].transferTxId!, 'not-there']);
    expect(txs(b)).toEqual([]);
  });

  it('knows which transfers need a category', () => {
    const { b, checking, savings, mortgage } = standardBudget();
    expect(transferNeedsCategory(b, checking, savings)).toBe(false);
    expect(transferNeedsCategory(b, checking, mortgage)).toBe(true);
    expect(transferNeedsCategory(b, mortgage, checking)).toBe(false);
    expect(transferNeedsCategory(b, checking, undefined)).toBe(true);
  });
});

describe('split transactions with transfer lines', () => {
  function splitTx(b: Budget, accountId: string, lines: Split[], extra: Partial<TransactionInput> = {}) {
    return saveTransaction(b, {
      accountId,
      date: '2026-02-10',
      payeeName: 'Market',
      categoryId: SPLIT,
      amount: lines.reduce((s, l) => s + l.amount, 0),
      cleared: 'U',
      splits: lines,
      ...extra,
    });
  }

  function setup() {
    const f = standardBudget();
    const { b, checking, savings, mortgage, groceries, rent } = f;
    const id = splitTx(b, checking, [
      { id: 'l1', categoryId: groceries, amount: -3000 },
      { id: 'l2', categoryId: groceries, amount: -2000, transferAccountId: savings },
      { id: 'l3', categoryId: rent, amount: -1000, transferAccountId: mortgage },
    ]);
    const line = (lineId: string) => b.transactions[id].splits!.find((s) => s.id === lineId)!;
    return { ...f, id, line };
  }

  it('creates a peer for each transfer line', () => {
    const { b, id, line, checking, savings, mortgage, rent } = setup();
    const t = b.transactions[id];
    expect(t).toMatchObject({ categoryId: SPLIT, amount: -6000 });
    expect(line('l1').transferTxId).toBeUndefined();
    // Budget -> budget: no category. Budget -> tracking: the line keeps its category.
    expect(line('l2').categoryId).toBeNull();
    expect(line('l3').categoryId).toBe(rent);
    expect(b.transactions[line('l2').transferTxId!]).toMatchObject({
      accountId: savings,
      amount: 2000,
      transferAccountId: checking,
      transferTxId: id,
      transferSplitParentId: id,
      payeeId: transferPayeeId(checking),
      categoryId: null,
      date: '2026-02-10',
    });
    expect(b.transactions[line('l3').transferTxId!]).toMatchObject({ accountId: mortgage, amount: 1000, categoryId: null });
    expect(txs(b)).toHaveLength(3);
    expect(compute(b).uncategorized).toEqual([]);
  });

  it('updates the same peers when the parent is edited', () => {
    const { b, id, line, checking, savings, mortgage, groceries, rent } = setup();
    const p2 = line('l2').transferTxId!;
    const p3 = line('l3').transferTxId!;
    splitTx(b, checking, [
      { id: 'l1', categoryId: groceries, amount: -3000 },
      { id: 'l2', categoryId: null, amount: -2500, transferAccountId: savings, transferTxId: p2 },
      { id: 'l3', categoryId: rent, amount: -1000, transferAccountId: mortgage, transferTxId: p3 },
    ], { id, date: '2026-02-12' });
    expect(line('l2').transferTxId).toBe(p2);
    expect(b.transactions[p2]).toMatchObject({ amount: 2500, date: '2026-02-12' });
    expect(b.transactions[p3].date).toBe('2026-02-12');
    expect(txs(b)).toHaveLength(3);
  });

  it('removes a peer when its line stops being a transfer', () => {
    const { b, id, line, checking, groceries, rent, mortgage } = setup();
    const p2 = line('l2').transferTxId!;
    const p3 = line('l3').transferTxId!;
    splitTx(b, checking, [
      { id: 'l1', categoryId: groceries, amount: -3000 },
      { id: 'l2', categoryId: groceries, amount: -2000, transferTxId: p2 },
      { id: 'l3', categoryId: rent, amount: -1000, transferAccountId: mortgage, transferTxId: p3 },
    ], { id });
    expect(b.transactions[p2]).toBeUndefined();
    expect(line('l2')).toEqual({ id: 'l2', categoryId: groceries, amount: -2000 });
    expect(b.transactions[p3]).toBeDefined();
    expect(txs(b)).toHaveLength(2);
  });

  it('moves a peer when its line’s transfer account changes', () => {
    const { b, id, line, checking, card, groceries, rent, mortgage } = setup();
    const p2 = line('l2').transferTxId!;
    const p3 = line('l3').transferTxId!;
    splitTx(b, checking, [
      { id: 'l1', categoryId: groceries, amount: -3000 },
      { id: 'l2', categoryId: null, amount: -2000, transferAccountId: card, transferTxId: p2 },
      { id: 'l3', categoryId: rent, amount: -1000, transferAccountId: mortgage, transferTxId: p3 },
    ], { id });
    expect(b.transactions[p2]).toBeUndefined();
    expect(b.transactions[line('l2').transferTxId!]).toMatchObject({ accountId: card, amount: 2000, transferSplitParentId: id });
    expect(txs(b)).toHaveLength(3);
  });

  it('removes every peer when the split becomes an ordinary transaction', () => {
    const { b, id, checking, groceries } = setup();
    saveTransaction(b, { id, accountId: checking, payeeName: 'Market', categoryId: groceries, date: '2026-02-10', amount: -6000, cleared: 'U' });
    expect(b.transactions[id].splits).toBeUndefined();
    expect(b.transactions[id].categoryId).toBe(groceries);
    expect(txs(b)).toHaveLength(1);
  });

  it('editing the far side updates the parent’s line, total and date, and the other peers’ dates', () => {
    const { b, id, line, checking, savings } = setup();
    const p2 = line('l2').transferTxId!;
    const p3 = line('l3').transferTxId!;
    saveTransaction(b, { id: p2, accountId: savings, transferAccountId: checking, date: '2026-02-15', amount: 2500, cleared: 'C' });
    expect(line('l2').amount).toBe(-2500);
    expect(b.transactions[id]).toMatchObject({ amount: -6500, date: '2026-02-15' });
    expect(b.transactions[p3].date).toBe('2026-02-15');
    expect(b.transactions[p2]).toMatchObject({ amount: 2500, cleared: 'C', transferSplitParentId: id, transferTxId: id });
    // The parent itself is not deleted or duplicated.
    expect(txs(b)).toHaveLength(3);
  });

  it('deleting a peer removes that line from the parent', () => {
    const { b, id, line } = setup();
    const p2 = line('l2').transferTxId!;
    deleteTransactions(b, [p2]);
    const t = b.transactions[id];
    expect(t.splits!.map((s) => s.id)).toEqual(['l1', 'l3']);
    expect(t.amount).toBe(-4000);
    expect(t.categoryId).toBe(SPLIT);
    expect(txs(b)).toHaveLength(2);
  });

  it('deleting the last line’s peer leaves an empty, uncategorised parent', () => {
    const { b, checking, savings } = standardBudget();
    const id = splitTx(b, checking, [{ id: 'only', categoryId: null, amount: -2000, transferAccountId: savings }]);
    deleteTransactions(b, [b.transactions[id].splits![0].transferTxId!]);
    expect(b.transactions[id]).toMatchObject({ categoryId: null, amount: 0 });
    expect(b.transactions[id].splits).toBeUndefined();
  });

  it('deleting the parent deletes its peers', () => {
    const { b, id } = setup();
    deleteTransactions(b, [id]);
    expect(txs(b)).toEqual([]);
  });

  it('the far side keeps its account and stays a transfer, whatever the editor sends (1.4.4)', () => {
    const { b, id, line, checking, savings, card } = setup();
    const p2 = line('l2').transferTxId!;
    saveTransaction(b, { id: p2, accountId: card, payeeName: 'Somewhere', date: '2026-02-10', amount: 2000, cleared: 'U' });
    expect(b.transactions[p2]).toMatchObject({ accountId: savings, transferAccountId: checking, transferSplitParentId: id, transferTxId: id });
    expect(b.transactions[p2].payeeId).toBe(transferPayeeId(checking));
    expect(line('l2')).toMatchObject({ transferAccountId: savings, transferTxId: p2, amount: -2000 });
    expect(checkBudget(b)).toEqual([]);
  });

  it("Check budget reports a far side in an account its line doesn't name (1.4.4)", () => {
    const { b, line, card } = setup();
    b.transactions[line('l2').transferTxId!].accountId = card;
    expect(checkBudget(b).map((p) => p.kind)).toContain('Transfers on split lines that are not paired correctly');
  });

  it('moving a split into a budget account clears the categories its transfer lines no longer need (1.4.4)', () => {
    const { b, checking, savings, mortgage, groceries } = standardBudget();
    // From the off-budget mortgage account, £15 goes to savings: savings' side needs a category.
    const id = splitTx(b, mortgage, [
      { id: 'a', categoryId: null, amount: -1500, transferAccountId: savings },
      { id: 'b', categoryId: null, amount: -500 },
    ]);
    const farId = b.transactions[id].splits![0].transferTxId!;
    saveTransaction(b, { id: farId, accountId: savings, transferAccountId: mortgage, categoryId: groceries, date: '2026-02-10', amount: 1500, cleared: 'U' });
    expect(b.transactions[farId].categoryId).toBe(groceries);
    // Into checking, it's a transfer between two budget accounts: no category on either side.
    expect(moveTransactions(b, [id], checking)).toBe(1);
    expect(b.transactions[farId]).toMatchObject({ transferAccountId: checking, categoryId: null });
    expect(b.transactions[id].splits![0].categoryId).toBeNull();
    expect(checkBudget(b)).toEqual([]);
  });

  it('deleting a parent and its peer together is fine in either order', () => {
    const { b, id, line } = setup();
    deleteTransactions(b, [line('l2').transferTxId!, id]);
    expect(txs(b)).toEqual([]);
  });
});

describe('bulk transaction changes', () => {
  it('sets, toggles and clears flags and cleared state', () => {
    const { b, checking } = standardBudget();
    const a = addTx(b, checking, '2026-01-01', -100, null);
    const r = addTx(b, checking, '2026-01-01', -100, null, { cleared: 'R' });
    toggleCleared(b, a);
    expect(b.transactions[a].cleared).toBe('C');
    toggleCleared(b, a);
    expect(b.transactions[a].cleared).toBe('U');
    // As documented: a reconciled transaction becomes cleared.
    toggleCleared(b, r);
    expect(b.transactions[r].cleared).toBe('C');
    setCleared(b, [a, r, 'missing'], 'R');
    expect([b.transactions[a].cleared, b.transactions[r].cleared]).toEqual(['R', 'R']);
    setFlag(b, [a], 'red');
    expect(b.transactions[a].flag).toBe('red');
    setFlag(b, [a], undefined);
    expect('flag' in b.transactions[a]).toBe(false);
  });

  it('approves transactions', () => {
    const { b, checking } = standardBudget();
    const a = addTx(b, checking, '2026-01-01', -100, null, { accepted: false });
    approveTransactions(b, [a]);
    expect(b.transactions[a].accepted).toBe(true);
  });

  it('categorises everything except splits and budget -> budget transfers, and remembers the payee’s category', () => {
    const { b, checking, savings, mortgage, groceries } = standardBudget();
    const p = ensurePayee(b, 'Baker')!;
    const plain = addTx(b, checking, '2026-01-01', -100, null, { payeeId: p });
    const split = addTx(b, checking, '2026-01-01', -100, SPLIT, { splits: [{ id: 's', categoryId: null, amount: -100 }] });
    const bb = addTx(b, checking, '2026-01-01', -100, null, { transferAccountId: savings });
    const bt = addTx(b, checking, '2026-01-01', -100, null, { transferAccountId: mortgage, payeeId: transferPayeeId(mortgage) });
    expect(categorizeTransactions(b, [plain, split, bb, bt, 'missing'], groceries)).toBe(2);
    expect(b.transactions[plain].categoryId).toBe(groceries);
    expect(b.transactions[split].categoryId).toBe(SPLIT);
    expect(b.transactions[bb].categoryId).toBeNull();
    expect(b.transactions[bt].categoryId).toBe(groceries);
    expect(b.payees[p].autoCategoryId).toBe(groceries);
    // Transfer payees don't learn a category this way.
    expect(b.payees[transferPayeeId(mortgage)].autoCategoryId).toBeUndefined();
  });

  it('changes the date of transfer peers along with the transaction', () => {
    const { b, checking, savings, card } = standardBudget();
    const t = saveTransaction(b, { accountId: checking, transferAccountId: savings, date: '2026-01-01', amount: -100, cleared: 'U' });
    setTransactionsDate(b, [t], '2026-01-09');
    expect(b.transactions[b.transactions[t].transferTxId!].date).toBe('2026-01-09');

    const parent = saveTransaction(b, {
      accountId: checking,
      date: '2026-01-01',
      categoryId: SPLIT,
      amount: -300,
      cleared: 'U',
      splits: [
        { id: 'a', categoryId: null, amount: -100, transferAccountId: savings },
        { id: 'b', categoryId: null, amount: -200, transferAccountId: card },
      ],
    });
    setTransactionsDate(b, [parent], '2026-01-05');
    const [pa, pb] = b.transactions[parent].splits!.map((s) => b.transactions[s.transferTxId!]);
    expect([pa.date, pb.date]).toEqual(['2026-01-05', '2026-01-05']);

    // Changing the far side of one split line moves the parent and the other line's peer too.
    setTransactionsDate(b, [pa.id], '2026-01-20');
    expect(b.transactions[parent].date).toBe('2026-01-20');
    expect(b.transactions[pb.id].date).toBe('2026-01-20');
  });

  it('sets the payee of everything except transfers', () => {
    const { b, checking, savings } = standardBudget();
    const a = addTx(b, checking, '2026-01-01', -100, null);
    const tr = addTx(b, checking, '2026-01-01', -100, null, { transferAccountId: savings, payeeId: transferPayeeId(savings) });
    setTransactionsPayee(b, [a, tr], ' Florist ');
    expect(b.payees[b.transactions[a].payeeId!].name).toBe('Florist');
    expect(b.transactions[tr].payeeId).toBe(transferPayeeId(savings));
  });

  it('moves transactions between accounts, re-pointing transfer peers', () => {
    const { b, checking, savings, card, mortgage, rent } = standardBudget();
    const plain = addTx(b, checking, '2026-01-01', -100, rent);
    const tr = saveTransaction(b, { accountId: checking, transferAccountId: savings, date: '2026-01-01', amount: -100, cleared: 'U' });
    const peer = b.transactions[tr].transferTxId!;
    const toMortgage = saveTransaction(b, { accountId: checking, transferAccountId: mortgage, categoryId: rent, date: '2026-01-01', amount: -100, cleared: 'U' });
    expect(moveTransactions(b, [plain, tr, toMortgage, peer], card)).toBe(3);
    expect(b.transactions[plain].accountId).toBe(card);
    expect(b.transactions[tr].accountId).toBe(card);
    expect(b.transactions[peer]).toMatchObject({ transferAccountId: card, payeeId: transferPayeeId(card), accountId: savings });
    expect(b.transactions[toMortgage]).toMatchObject({ accountId: card, categoryId: rent });
    // Can't move a transfer into the account it transfers to.
    expect(moveTransactions(b, [tr], savings)).toBe(0);
    // Split peers move with their parent only.
    const parent = saveTransaction(b, {
      accountId: checking,
      date: '2026-01-01',
      categoryId: SPLIT,
      amount: -100,
      cleared: 'U',
      splits: [{ id: 'a', categoryId: null, amount: -100, transferAccountId: savings }],
    });
    const splitPeer = b.transactions[parent].splits![0].transferTxId!;
    expect(moveTransactions(b, [splitPeer], card)).toBe(0);
    expect(moveTransactions(b, [parent], savings)).toBe(0);
    expect(moveTransactions(b, [parent], card)).toBe(1);
    expect(b.transactions[splitPeer]).toMatchObject({ transferAccountId: card, payeeId: transferPayeeId(card) });
  });

  it("settles a waiting bank match when its transaction is moved, so Unmatch can't put the bank row in the wrong account (1.4.5)", () => {
    const { b, checking, card, rent } = standardBudget();
    const t = addTx(b, checking, '2026-01-01', -100, rent, {
      importIds: ['FITID:Z1'],
      matched: { bank: { date: '2026-01-02', amount: -100, payee: 'SHOP' }, importIds: ['FITID:Z1'], yours: { date: '2026-01-01', cleared: 'U', accepted: true } },
    });
    expect(moveTransactions(b, [t], card)).toBe(1);
    expect(b.transactions[t]).toMatchObject({ accountId: card, importIds: ['FITID:Z1'] });
    expect(b.transactions[t].matched).toBeUndefined();
    // The same when the editor changes its account.
    const u = addTx(b, checking, '2026-01-03', -200, rent, {
      accepted: false,
      importIds: ['FITID:Z2'],
      matched: { bank: { date: '2026-01-03', amount: -200, payee: 'SHOP' }, importIds: ['FITID:Z2'], yours: { date: '2026-01-03', cleared: 'U', accepted: true } },
    });
    saveTransaction(b, { id: u, accountId: card, date: '2026-01-03', amount: -200, categoryId: rent, cleared: 'U' });
    expect(b.transactions[u].accountId).toBe(card);
    expect(b.transactions[u].matched).toBeUndefined();
  });
});

describe('payees', () => {
  it('ensurePayee reuses a payee case-insensitively, trims, and unhides', () => {
    const b = emptyBudget();
    const a = ensurePayee(b, '  Corner Shop ')!;
    expect(b.payees[a].name).toBe('Corner Shop');
    setPayeeHidden(b, a, true);
    expect(ensurePayee(b, 'corner shop')).toBe(a);
    expect(b.payees[a].hidden).toBeUndefined();
    expect(ensurePayee(b, '   ')).toBeUndefined();
    expect(Object.keys(b.payees)).toHaveLength(1);
  });

  it('renamePayee ignores blanks and transfer payees', () => {
    const { b, savings } = standardBudget();
    const a = ensurePayee(b, 'Old')!;
    renamePayee(b, a, '  New ');
    renamePayee(b, a, '  ');
    expect(b.payees[a].name).toBe('New');
    renamePayee(b, transferPayeeId(savings), 'Hacked');
    expect(b.payees[transferPayeeId(savings)].name).toBe('Transfer : Savings');
  });

  it('setPayeeRules trims and drops blank rules', () => {
    const b = emptyBudget();
    const a = ensurePayee(b, 'Shop')!;
    setPayeeRules(b, a, [
      { op: 'contains', text: '  SHOP 12 ' },
      { op: 'is', text: '   ' },
    ]);
    expect(b.payees[a].rules).toEqual([{ op: 'contains', text: 'SHOP 12' }]);
  });

  it('remembers category, amount and memo from the last transaction (auto-fill)', () => {
    const { b, checking, savings, groceries, fun } = standardBudget();
    saveTransaction(b, { accountId: checking, payeeName: 'Cafe', categoryId: groceries, memo: 'Lunch', date: '2026-01-01', amount: -850, cleared: 'U' });
    const p = findPayeeByName(b, 'cafe')!;
    expect(p).toMatchObject({ autoCategoryId: groceries, autoAmount: -850, autoMemo: 'Lunch' });

    // A split doesn't change the remembered category, but does change the amount; no memo clears it.
    saveTransaction(b, {
      accountId: checking,
      payeeId: p.id,
      categoryId: SPLIT,
      date: '2026-01-02',
      amount: -1000,
      cleared: 'U',
      splits: [
        { id: 'a', categoryId: fun, amount: -400 },
        { id: 'b', categoryId: groceries, amount: -600 },
      ],
    });
    expect(b.payees[p.id]).toMatchObject({ autoCategoryId: groceries, autoAmount: -1000, autoMemo: null });

    // Transfers don't touch the transfer payee's memory.
    saveTransaction(b, { accountId: checking, transferAccountId: savings, date: '2026-01-03', amount: -999, cleared: 'U' });
    expect(b.payees[transferPayeeId(savings)].autoAmount).toBeUndefined();

    setPayeeAutoFill(b, p.id, { categoryId: undefined, memo: '' });
    expect(b.payees[p.id]).toMatchObject({ autoCategoryId: null, autoMemo: null, autoAmount: -1000 });
    setPayeeAutoFill(b, p.id, { amount: 123 });
    expect(b.payees[p.id]).toMatchObject({ autoCategoryId: null, autoAmount: 123 });
  });

  it('deleteUnusedPayees keeps payees in use and transfer payees', () => {
    const { b, checking, savings } = standardBudget();
    const used = ensurePayee(b, 'Used')!;
    const inSplit = ensurePayee(b, 'In split')!;
    const inSched = ensurePayee(b, 'Scheduled')!;
    const unused = ensurePayee(b, 'Unused')!;
    addTx(b, checking, '2026-01-01', -1, null, { payeeId: used });
    addTx(b, checking, '2026-01-01', -1, SPLIT, { splits: [{ id: 's', categoryId: null, amount: -1, payeeId: inSplit }] });
    saveScheduled(b, { accountId: checking, date: '2026-05-01', startDate: '2026-05-01', frequency: 'Monthly', payeeId: inSched, categoryId: null, amount: -1 });
    const n = deleteUnusedPayees(b, [used, inSplit, inSched, unused, transferPayeeId(savings), 'missing']);
    expect(n).toBe(1);
    expect(b.payees[unused]).toBeUndefined();
    expect(b.payees[used] && b.payees[inSplit] && b.payees[inSched] && b.payees[transferPayeeId(savings)]).toBeTruthy();
  });

  describe('mergePayees', () => {
    function setup() {
      const f = standardBudget();
      const { b, checking, groceries } = f;
      const target = ensurePayee(b, 'Tesco')!;
      setPayeeRules(b, target, [{ op: 'contains', text: 'tesco' }]);
      const a = ensurePayee(b, 'TESCO STORES 1234')!;
      const bb = ensurePayee(b, 'Tesco Express')!;
      setPayeeRules(b, bb, [
        { op: 'startsWith', text: 'TESCO EXP' },
        { op: 'contains', text: 'TESCO' },
      ]);
      b.payees[bb].autoCategoryId = groceries;
      const tx1 = addTx(b, checking, '2026-01-01', -100, null, { payeeId: a });
      const tx2 = addTx(b, checking, '2026-01-01', -100, SPLIT, { payeeId: bb, splits: [{ id: 's', categoryId: null, amount: -100, payeeId: a }] });
      const s = saveScheduled(b, { accountId: checking, date: '2026-05-01', startDate: '2026-05-01', frequency: 'Monthly', payeeId: bb, categoryId: null, amount: -1 });
      return { ...f, target, a, bb, tx1, tx2, s };
    }

    it('moves transactions, split lines and scheduled transactions to the target and deletes the others', () => {
      const { b, target, a, bb, tx1, tx2, s, savings } = setup();
      mergePayees(b, [a, bb, target, transferPayeeId(savings)], target);
      expect(b.payees[a]).toBeUndefined();
      expect(b.payees[bb]).toBeUndefined();
      expect(b.payees[transferPayeeId(savings)]).toBeDefined();
      expect(b.transactions[tx1].payeeId).toBe(target);
      expect(b.transactions[tx2].payeeId).toBe(target);
      expect(b.transactions[tx2].splits![0].payeeId).toBe(target);
      expect(b.scheduled[s].payeeId).toBe(target);
    });

    it('turns the old names into "is" rename rules, keeps their rules, and removes duplicates', () => {
      const { b, target, a, bb } = setup();
      mergePayees(b, [a, bb], target);
      expect(b.payees[target].rules).toEqual([
        // The target's own "contains" rule must survive even though its text equals the name.
        { op: 'contains', text: 'tesco' },
        { op: 'is', text: 'TESCO STORES 1234' },
        { op: 'is', text: 'Tesco Express' },
        { op: 'startsWith', text: 'TESCO EXP' },
      ]);
    });

    it('drops an "is" rule for the target’s own name', () => {
      const b = emptyBudget();
      const target = ensurePayee(b, 'Tesco')!;
      const lower = (b.payees['dupe'] = { id: 'dupe', name: 'TESCO', rules: [] }).id;
      mergePayees(b, [lower], target);
      expect(b.payees[target].rules).toEqual([]);
    });

    it('inherits a default category only when the target has none', () => {
      const { b, target, a, bb, groceries, fun } = setup();
      mergePayees(b, [a, bb], target);
      expect(b.payees[target].autoCategoryId).toBe(groceries);
      const other = ensurePayee(b, 'Other')!;
      b.payees[other].autoCategoryId = fun;
      mergePayees(b, [other], target);
      expect(b.payees[target].autoCategoryId).toBe(groceries);
    });

    it('does nothing for a missing target', () => {
      const { b, a } = setup();
      mergePayees(b, [a], 'missing');
      expect(b.payees[a]).toBeDefined();
    });
  });
});

describe('scheduled transactions', () => {
  it('saveScheduled defaults the start date and tidies transfers and splits', () => {
    const { b, checking, savings, mortgage, groceries, rent } = standardBudget();
    const a = saveScheduled(b, { accountId: checking, date: '2026-05-31', startDate: '', frequency: 'Monthly', categoryId: groceries, amount: -1, splits: [{ id: 'x', categoryId: rent, amount: -1 }] });
    expect(b.scheduled[a].startDate).toBe('2026-05-31');
    expect(b.scheduled[a].splits).toBeUndefined();
    const bb = saveScheduled(b, { accountId: checking, transferAccountId: savings, date: '2026-05-01', startDate: '2026-05-01', frequency: 'Monthly', categoryId: groceries, amount: -1 });
    expect(b.scheduled[bb]).toMatchObject({ categoryId: null, payeeId: transferPayeeId(savings) });
    const bt = saveScheduled(b, { accountId: checking, transferAccountId: mortgage, date: '2026-05-01', startDate: '2026-05-01', frequency: 'Monthly', categoryId: rent, amount: -1 });
    expect(b.scheduled[bt]).toMatchObject({ categoryId: rent, payeeId: transferPayeeId(mortgage) });
  });

  it('enterDueScheduled enters every due occurrence and advances or deletes each schedule', () => {
    const { b, checking, savings, rent } = standardBudget();
    const payee = ensurePayee(b, 'Landlord')!;
    const monthly = saveScheduled(b, { accountId: checking, date: '2026-07-31', startDate: '2026-07-31', frequency: 'Monthly', payeeId: payee, categoryId: rent, amount: -50000, memo: 'Rent' });
    const once = saveScheduled(b, { accountId: checking, date: '2026-10-01', startDate: '2026-10-01', frequency: 'Once', categoryId: rent, amount: -100 });
    const weekly = saveScheduled(b, { accountId: checking, date: '2026-09-17', startDate: '2026-09-17', frequency: 'Weekly', endDate: '2026-10-01', categoryId: rent, amount: -200 });
    const future = saveScheduled(b, { accountId: checking, date: '2026-11-01', startDate: '2026-11-01', frequency: 'Monthly', categoryId: rent, amount: -300 });
    const tr = saveScheduled(b, { accountId: checking, transferAccountId: savings, date: '2026-10-05', startDate: '2026-10-05', frequency: 'Monthly', categoryId: null, amount: -10000 });
    const ended = saveScheduled(b, { accountId: checking, date: '2026-10-10', startDate: '2026-01-10', frequency: 'Monthly', endDate: '2026-09-30', categoryId: rent, amount: -400 });

    expect(enterDueScheduled(b, '2026-10-13')).toBe(3 + 1 + 3 + 1);
    const datesFor = (sid: string) => txs(b).filter((t) => t.scheduleId === sid).map((t) => t.date).sort();
    expect(datesFor(monthly)).toEqual(['2026-07-31', '2026-08-31', '2026-09-30']);
    expect(b.scheduled[monthly].date).toBe('2026-10-31');
    expect(txs(b).find((t) => t.scheduleId === monthly)).toMatchObject({ payeeId: payee, categoryId: rent, amount: -50000, memo: 'Rent', cleared: 'U', accepted: false });
    expect(datesFor(once)).toEqual(['2026-10-01']);
    expect(b.scheduled[once]).toBeUndefined();
    expect(datesFor(weekly)).toEqual(['2026-09-17', '2026-09-24', '2026-10-01']);
    expect(b.scheduled[weekly]).toBeUndefined();
    expect(datesFor(future)).toEqual([]);
    expect(b.scheduled[future].date).toBe('2026-11-01');
    // A schedule already past its end date is removed without entering anything.
    expect(datesFor(ended)).toEqual([]);
    expect(b.scheduled[ended]).toBeUndefined();
    // The transfer was entered as a pair.
    const trTx = txs(b).find((t) => t.scheduleId === tr)!;
    expect(b.transactions[trTx.transferTxId!]).toMatchObject({ accountId: savings, amount: 10000 });
    expect(b.scheduled[tr].date).toBe('2026-11-05');

    expect(enterDueScheduled(b, '2026-10-13')).toBe(0);
  });

  it('enters split schedules with fresh line ids and separate transfer peers each time', () => {
    const { b, checking, savings, groceries } = standardBudget();
    const s = saveScheduled(b, {
      accountId: checking,
      date: '2026-09-01',
      startDate: '2026-09-01',
      frequency: 'Monthly',
      categoryId: SPLIT,
      amount: -3000,
      splits: [
        { id: 'line-a', categoryId: groceries, amount: -1000 },
        { id: 'line-b', categoryId: null, amount: -2000, transferAccountId: savings },
      ],
    });
    expect(enterDueScheduled(b, '2026-10-01')).toBe(2);
    const parents = txs(b).filter((t) => t.scheduleId === s);
    expect(parents).toHaveLength(2);
    const peers = parents.map((p) => p.splits![1].transferTxId!);
    expect(new Set(peers).size).toBe(2);
    expect(peers.map((id) => b.transactions[id].date).sort()).toEqual(['2026-09-01', '2026-10-01']);
    for (const p of parents) expect(p.splits!.map((l) => l.id)).not.toContain('line-a');
    // The schedule itself is untouched apart from its date.
    expect(b.scheduled[s].splits![1].transferTxId).toBeUndefined();
    expect(b.scheduled[s].date).toBe('2026-11-01');
  });

  it('enterScheduled can use another date; the schedule still moves on from its own date', () => {
    const { b, checking, rent } = standardBudget();
    const s = saveScheduled(b, { accountId: checking, date: '2026-01-31', startDate: '2026-01-31', frequency: 'Monthly', categoryId: rent, amount: -1 });
    const id = enterScheduled(b, s, '2026-01-29')!;
    expect(b.transactions[id]).toMatchObject({ date: '2026-01-29', scheduleId: s });
    expect(b.scheduled[s].date).toBe('2026-02-28');
    expect(enterScheduled(b, 'missing')).toBeNull();
  });

  it('skipScheduled advances, keeping the anchor day, and deletes a one-off', () => {
    const { b, checking } = standardBudget();
    const s = saveScheduled(b, { accountId: checking, date: '2026-01-31', startDate: '2026-01-31', frequency: 'Monthly', categoryId: null, amount: -1 });
    skipScheduled(b, s);
    skipScheduled(b, s);
    expect(b.scheduled[s].date).toBe('2026-03-31');
    const once = saveScheduled(b, { accountId: checking, date: '2026-01-31', startDate: '2026-01-31', frequency: 'Once', categoryId: null, amount: -1 });
    skipScheduled(b, once);
    expect(b.scheduled[once]).toBeUndefined();
    expect(txs(b)).toEqual([]);
  });

  it('scheduleFromTransaction copies a transaction, a transfer or a split', () => {
    const { b, checking, savings, groceries } = standardBudget();
    const plain = saveTransaction(b, { accountId: checking, payeeName: 'Gym', categoryId: groceries, memo: 'Fee', flag: 'blue', date: '2026-01-15', amount: -2500, cleared: 'C' });
    const s1 = scheduleFromTransaction(b, plain, 'Monthly', '2026-02-15')!;
    expect(b.scheduled[s1]).toMatchObject({ accountId: checking, date: '2026-02-15', startDate: '2026-02-15', frequency: 'Monthly', payeeId: b.transactions[plain].payeeId, categoryId: groceries, memo: 'Fee', flag: 'blue', amount: -2500 });

    const tr = saveTransaction(b, { accountId: checking, transferAccountId: savings, date: '2026-01-15', amount: -100, cleared: 'C' });
    const s2 = scheduleFromTransaction(b, tr, 'Weekly', '2026-01-22')!;
    expect(b.scheduled[s2]).toMatchObject({ transferAccountId: savings, payeeId: transferPayeeId(savings), categoryId: null });

    const parent = saveTransaction(b, {
      accountId: checking,
      date: '2026-01-15',
      categoryId: SPLIT,
      amount: -300,
      cleared: 'U',
      splits: [
        { id: 'a', categoryId: groceries, amount: -100 },
        { id: 'b', categoryId: null, amount: -200, transferAccountId: savings },
      ],
    });
    const s3 = scheduleFromTransaction(b, parent, 'Monthly', '2026-02-15')!;
    const lines = b.scheduled[s3].splits!;
    expect(lines.map((l) => l.amount)).toEqual([-100, -200]);
    expect(lines[1]).toMatchObject({ transferAccountId: savings, transferTxId: undefined });
    expect(lines.map((l) => l.id)).not.toContain('a');

    // The far side of a split-line transfer can't be a transfer schedule on its own.
    const peer = b.transactions[parent].splits![1].transferTxId!;
    const s4 = scheduleFromTransaction(b, peer, 'Monthly', '2026-02-15')!;
    expect(b.scheduled[s4].transferAccountId).toBeUndefined();
    expect(scheduleFromTransaction(b, 'missing', 'Monthly', '2026-02-15')).toBeNull();
  });
});

describe('budget cells', () => {
  it('setBudgeted removes empty cells and months', () => {
    const { b, groceries } = standardBudget();
    setBudgeted(b, '2026-01', groceries, 1000);
    expect(b.months['2026-01'][groceries]).toEqual({ budgeted: 1000 });
    setBudgeted(b, '2026-01', groceries, 0);
    expect(b.months['2026-01']).toBeUndefined();
  });

  it('keeps a zero cell that still has a note or handling', () => {
    const { b, groceries, rent } = standardBudget();
    setCategoryMonthNote(b, '2026-01', groceries, 'Birthday');
    setBudgeted(b, '2026-01', groceries, 0);
    expect(b.months['2026-01'][groceries]).toEqual({ budgeted: 0, note: 'Birthday' });
    setCategoryMonthNote(b, '2026-01', groceries, '  ');
    expect(b.months['2026-01']).toBeUndefined();
    setBudgetedMany(b, '2026-02', { [groceries]: 100, [rent]: 200 });
    expect(b.months['2026-02']).toEqual({ [groceries]: { budgeted: 100 }, [rent]: { budgeted: 200 } });
  });

  it('moveMoney moves a budgeted amount between categories', () => {
    const { b, groceries, rent } = standardBudget();
    setBudgeted(b, '2026-01', groceries, 1000);
    moveMoney(b, '2026-01', groceries, rent, 400);
    expect(b.months['2026-01']).toEqual({ [groceries]: { budgeted: 600 }, [rent]: { budgeted: 400 } });
    moveMoney(b, '2026-01', groceries, rent, 600);
    expect(b.months['2026-01']).toEqual({ [rent]: { budgeted: 1000 } });
    // More than is budgeted makes the source negative.
    moveMoney(b, '2026-01', groceries, rent, 50);
    expect(b.months['2026-01'][groceries].budgeted).toBe(-50);
    const before = JSON.stringify(b.months);
    moveMoney(b, '2026-01', rent, rent, 10);
    moveMoney(b, '2026-01', rent, groceries, 0);
    expect(JSON.stringify(b.months)).toBe(before);
  });

  it('setMonthNote sets and clears month notes', () => {
    const b = emptyBudget();
    setMonthNote(b, '2026-01', 'Tight month');
    expect(b.monthNotes).toEqual({ '2026-01': 'Tight month' });
    setMonthNote(b, '2026-01', ' ');
    expect(b.monthNotes).toEqual({});
  });
});

describe('categories', () => {
  it('deleteCategory reassigns transactions, splits, scheduled, payee defaults and budgeted amounts', () => {
    setNow(2026, 3, 15);
    const { b, checking, groceries, rent, fun } = standardBudget();
    addTx(b, checking, '2026-01-01', 200000, INCOME_NOW);
    setBudgeted(b, '2026-01', groceries, 10000);
    setBudgeted(b, '2026-01', rent, 50000);
    setBudgeted(b, '2026-02', groceries, 7000);
    setCategoryMonthNote(b, '2026-03', groceries, 'note only');
    const t1 = addTx(b, checking, '2026-01-05', -3000, groceries);
    const t2 = addTx(b, checking, '2026-02-05', -1500, SPLIT, {
      splits: [
        { id: 'a', categoryId: groceries, amount: -1000 },
        { id: 'b', categoryId: fun, amount: -500 },
      ],
    });
    const s1 = saveScheduled(b, { accountId: checking, date: '2026-04-01', startDate: '2026-04-01', frequency: 'Monthly', categoryId: groceries, amount: -1 });
    const s2 = saveScheduled(b, {
      accountId: checking,
      date: '2026-04-01',
      startDate: '2026-04-01',
      frequency: 'Monthly',
      categoryId: SPLIT,
      amount: -2,
      splits: [
        { id: 'a', categoryId: groceries, amount: -1 },
        { id: 'b', categoryId: fun, amount: -1 },
      ],
    });
    const p = ensurePayee(b, 'Grocer')!;
    b.payees[p].autoCategoryId = groceries;
    const before = compute(b).summary.get('2026-03')!;

    deleteCategory(b, groceries, rent);

    expect(b.categories[groceries]).toBeUndefined();
    expect(b.transactions[t1].categoryId).toBe(rent);
    expect(b.transactions[t2].splits!.map((s) => s.categoryId)).toEqual([rent, fun]);
    expect(b.scheduled[s1].categoryId).toBe(rent);
    expect(b.scheduled[s2].splits!.map((s) => s.categoryId)).toEqual([rent, fun]);
    expect(b.payees[p].autoCategoryId).toBe(rent);
    expect(b.months['2026-01'][rent].budgeted).toBe(60000);
    expect(b.months['2026-02'][rent].budgeted).toBe(7000);
    for (const m of Object.values(b.months)) expect(m[groceries]).toBeUndefined();

    // Nothing is lost: totals are the same, now all in Rent.
    const c = compute(b);
    const after = c.summary.get('2026-03')!;
    expect(after.atb).toBe(before.atb);
    expect(after.balanceTotal).toBe(before.balanceTotal);
    expect(categoryMonth(c, '2026-03', rent).balance).toBe(60000 + 7000 - 3000 - 1000);
  });

  it('deleteCategory with no target leaves transactions uncategorised and drops budgeted amounts', () => {
    setNow(2026, 3, 15);
    const { b, checking, groceries } = standardBudget();
    setBudgeted(b, '2026-01', groceries, 10000);
    const t = addTx(b, checking, '2026-01-05', -3000, groceries);
    const p = ensurePayee(b, 'Grocer')!;
    b.payees[p].autoCategoryId = groceries;
    deleteCategory(b, groceries, null);
    expect(b.transactions[t].categoryId).toBeNull();
    expect(b.payees[p].autoCategoryId).toBeNull();
    expect(b.months['2026-01']?.[groceries]).toBeUndefined();
    expect(compute(b).uncategorized).toEqual([t]);
  });

  it('deleteCategory into income moves transactions but not budgeted amounts', () => {
    const { b, checking, groceries } = standardBudget();
    setBudgeted(b, '2026-01', groceries, 10000);
    const t = addTx(b, checking, '2026-01-05', 3000, groceries);
    deleteCategory(b, groceries, INCOME_NOW);
    expect(b.transactions[t].categoryId).toBe(INCOME_NOW);
    expect(b.months['2026-01']?.[INCOME_NOW]).toBeUndefined();
  });

  it('deleteMaster deletes the group and reassigns all of its categories', () => {
    const { b, checking, bills, everyday, rent, power, groceries } = standardBudget();
    setBudgeted(b, '2026-01', rent, 100);
    setBudgeted(b, '2026-01', power, 50);
    const t1 = addTx(b, checking, '2026-01-05', -1, rent);
    const t2 = addTx(b, checking, '2026-01-05', -1, power);
    deleteMaster(b, bills, groceries);
    expect(b.masters[bills]).toBeUndefined();
    expect(b.categories[rent]).toBeUndefined();
    expect(b.categories[power]).toBeUndefined();
    expect(b.masters[everyday]).toBeDefined();
    expect(b.transactions[t1].categoryId).toBe(groceries);
    expect(b.transactions[t2].categoryId).toBe(groceries);
    expect(b.months['2026-01']).toEqual({ [groceries]: { budgeted: 150 } });
  });

  it('moveCategory reorders within a group and moves between groups', () => {
    const { b, bills, everyday, power, groceries, fun } = standardBudget();
    const names = (m: string) => categoriesOf(b, m, true).map((c) => c.name);
    const eating = addCategory(b, everyday, 'Eating Out');
    expect(names(everyday)).toEqual(['Groceries', 'Fun', 'Eating Out']);
    moveCategory(b, eating, everyday, 0);
    expect(names(everyday)).toEqual(['Eating Out', 'Groceries', 'Fun']);
    expect(categoriesOf(b, everyday, true).map((c) => c.sort)).toEqual([0, 1, 2]);

    moveCategory(b, groceries, bills, 1);
    expect(b.categories[groceries].masterId).toBe(bills);
    expect(names(bills)).toEqual(['Rent', 'Groceries', 'Power']);
    expect(names(everyday)).toEqual(['Eating Out', 'Fun']);

    moveCategory(b, fun, bills, 99);
    expect(names(bills)).toEqual(['Rent', 'Groceries', 'Power', 'Fun']);
    moveCategory(b, power, bills, -5);
    expect(names(bills)).toEqual(['Power', 'Rent', 'Groceries', 'Fun']);
    expect(categoriesOf(b, bills, true).map((c) => c.sort)).toEqual([0, 1, 2, 3]);

    const water = addCategory(b, bills, '  ', 1);
    expect(b.categories[water].name).toBe('New Category');
    expect(names(bills)[1]).toBe('New Category');
    moveCategory(b, 'missing', bills, 0);
    expect(names(bills)).toHaveLength(5);
  });

  it('includes hidden categories in the order, and categoriesOf can leave them out', () => {
    const { b, everyday, fun } = standardBudget();
    b.categories[fun].hidden = true;
    expect(categoriesOf(b, everyday).map((c) => c.name)).toEqual(['Groceries']);
    expect(categoriesOf(b, everyday, true).map((c) => c.name)).toEqual(['Groceries', 'Fun']);
  });

  it('addMaster and moveMaster keep group order', () => {
    const { b, bills } = standardBudget();
    const names = () => sortedMasters(b).map((m) => m.name);
    addMaster(b, 'Goals', 0);
    expect(names()).toEqual(['Goals', 'Bills', 'Everyday']);
    moveMaster(b, bills, 99);
    expect(names()).toEqual(['Goals', 'Everyday', 'Bills']);
    moveMaster(b, bills, 1);
    expect(names()).toEqual(['Goals', 'Bills', 'Everyday']);
    expect(sortedMasters(b).map((m) => m.sort)).toEqual([0, 1, 2]);
    expect(b.masters[addMaster(b, ' ')].name).toBe('New Group');
  });
});

describe('accounts', () => {
  it('addAccount with a positive balance makes "income for this month"', () => {
    const b = emptyBudget();
    const id = addAccount(b, { name: ' Current ', type: 'Checking', onBudget: true, note: 'Main' }, 150000, '2026-03-01');
    expect(b.accounts[id]).toMatchObject({ name: 'Current', type: 'Checking', onBudget: true, closed: false, sort: 0, note: 'Main' });
    const [t] = inAccount(b, id);
    expect(t).toMatchObject({ amount: 150000, categoryId: INCOME_NOW, cleared: 'C', accepted: true, date: '2026-03-01' });
    expect(b.payees[t.payeeId!].name).toBe('Starting Balance');
    expect(b.payees[transferPayeeId(id)]).toMatchObject({ name: 'Transfer : Current', transferAccountId: id });
  });

  it('addAccount with a negative balance makes a Pre-YNAB Debt category that carries overspending', () => {
    setNow(2026, 3, 15);
    const b = emptyBudget();
    addAccount(b, { name: 'Current', type: 'Checking', onBudget: true }, 150000, '2026-03-01');
    const visa = addAccount(b, { name: 'Visa', type: 'CreditCard', onBudget: true }, -45000, '2026-03-01');
    const loan = addAccount(b, { name: 'Loan', type: 'LineOfCredit', onBudget: true }, -1000, '2026-04-10');
    const masters = Object.values(b.masters).filter((m) => m.name === 'Pre-YNAB Debt');
    expect(masters).toHaveLength(1);
    const debtCats = categoriesOf(b, masters[0].id);
    expect(debtCats.map((c) => c.name)).toEqual(['Visa', 'Loan']);
    const [visaCat, loanCat] = debtCats.map((c) => c.id);
    expect(inAccount(b, visa)[0].categoryId).toBe(visaCat);
    expect(inAccount(b, loan)[0].categoryId).toBe(loanCat);
    expect(b.months['2026-03'][visaCat]).toEqual({ budgeted: 0, handling: 'carry' });
    expect(b.months['2026-04'][loanCat]).toEqual({ budgeted: 0, handling: 'carry' });
    // One "Starting Balance" payee shared by all.
    expect(Object.values(b.payees).filter((p) => p.name === 'Starting Balance')).toHaveLength(1);
    expect(sortedAccounts(b).map((a) => a.name)).toEqual(['Current', 'Visa', 'Loan']);

    const c = compute(b);
    expect(categoryMonth(c, '2026-03', visaCat).balance).toBe(-45000);
    expect(categoryMonth(c, '2026-05', visaCat)).toMatchObject({ carryIn: -45000, balance: -45000, handling: 'carry' });
    expect(categoryMonth(c, '2026-05', loanCat).balance).toBe(-1000);
    // The debt doesn't touch Available to Budget.
    expect(c.summary.get('2026-03')!.atb).toBe(150000);
    expect(c.summary.get('2026-05')!.atb).toBe(150000);
  });

  it('addAccount off budget never uses a category, and can keep a given id', () => {
    const b = emptyBudget();
    const id = addAccount(b, { id: 'acc-house', name: 'House', type: 'OtherAsset', onBudget: false }, -5000, '2026-03-01');
    expect(id).toBe('acc-house');
    expect(inAccount(b, id)[0].categoryId).toBeNull();
    expect(Object.keys(b.categories)).toEqual([]);
    expect(Object.keys(b.masters)).toEqual([]);
  });

  it('updateAccount renames the transfer payee too', () => {
    const { b, savings } = standardBudget();
    updateAccount(b, savings, { name: ' Rainy Day ', note: 'x', closed: true, onBudget: false, type: 'OtherAsset' });
    expect(b.accounts[savings]).toMatchObject({ name: 'Rainy Day', note: 'x', closed: true, onBudget: false, type: 'OtherAsset' });
    expect(b.payees[transferPayeeId(savings)].name).toBe('Transfer : Rainy Day');
    updateAccount(b, savings, { name: '   ', note: '  ' });
    expect(b.accounts[savings].name).toBe('Rainy Day');
    expect(b.accounts[savings].note).toBeUndefined();
  });

  it('moveAccount reorders accounts', () => {
    const { b, mortgage } = standardBudget();
    moveAccount(b, mortgage, 0);
    expect(sortedAccounts(b).map((a) => a.name)).toEqual(['Mortgage', 'Checking', 'Savings', 'Card']);
    expect(sortedAccounts(b).map((a) => a.sort)).toEqual([0, 1, 2, 3]);
  });

  it('deleteAccount turns transfers to it into ordinary transactions and removes its data', () => {
    const { b, checking, savings, card, groceries } = standardBudget();
    const tr = saveTransaction(b, { accountId: checking, transferAccountId: savings, date: '2026-01-01', amount: -100, cleared: 'U' });
    // A split in Checking with a line to Savings.
    const parent = saveTransaction(b, {
      accountId: checking,
      date: '2026-01-02',
      categoryId: SPLIT,
      amount: -300,
      cleared: 'U',
      splits: [
        { id: 'a', categoryId: groceries, amount: -100 },
        { id: 'b', categoryId: null, amount: -200, transferAccountId: savings },
      ],
    });
    // A split in Savings with a line to Card: its peer in Card must survive as an ordinary transaction.
    const savingsParent = saveTransaction(b, {
      accountId: savings,
      date: '2026-01-03',
      categoryId: SPLIT,
      amount: -50,
      cleared: 'U',
      splits: [{ id: 'c', categoryId: null, amount: -50, transferAccountId: card }],
    });
    const cardPeer = b.transactions[savingsParent].splits![0].transferTxId!;
    const keep = saveScheduled(b, { accountId: checking, date: '2026-05-01', startDate: '2026-05-01', frequency: 'Monthly', categoryId: groceries, amount: -1 });
    const from = saveScheduled(b, { accountId: savings, date: '2026-05-01', startDate: '2026-05-01', frequency: 'Monthly', categoryId: null, amount: -1 });
    const to = saveScheduled(b, { accountId: checking, transferAccountId: savings, date: '2026-05-01', startDate: '2026-05-01', frequency: 'Monthly', categoryId: null, amount: -1 });
    const splitSched = saveScheduled(b, {
      accountId: checking,
      date: '2026-05-01',
      startDate: '2026-05-01',
      frequency: 'Monthly',
      categoryId: SPLIT,
      amount: -2,
      splits: [
        { id: 'x', categoryId: groceries, amount: -1 },
        { id: 'y', categoryId: null, amount: -1, transferAccountId: savings },
      ],
    });

    deleteAccount(b, savings);

    expect(b.accounts[savings]).toBeUndefined();
    expect(b.payees[transferPayeeId(savings)]).toBeUndefined();
    expect(inAccount(b, savings)).toEqual([]);
    const t = b.transactions[tr];
    expect(t.transferAccountId).toBeUndefined();
    expect(t.transferTxId).toBeUndefined();
    expect(b.payees[t.payeeId!].name).toBe('Transfer : Savings (deleted)');
    const line = b.transactions[parent].splits![1];
    expect(line.transferAccountId).toBeUndefined();
    expect(line.transferTxId).toBeUndefined();
    expect(b.transactions[cardPeer]).toBeDefined();
    expect(b.transactions[cardPeer].transferSplitParentId).toBeUndefined();
    expect(b.transactions[cardPeer].transferAccountId).toBeUndefined();
    expect(b.scheduled[keep]).toBeDefined();
    expect(b.scheduled[from]).toBeUndefined();
    expect(b.scheduled[to]).toBeUndefined();
    // A scheduled split line must not point at the deleted account any more.
    expect(b.scheduled[splitSched].splits![1].transferAccountId).toBeUndefined();
    // Every remaining transaction is in an account that exists.
    for (const x of txs(b)) expect(b.accounts[x.accountId]).toBeDefined();
    enterScheduled(b, splitSched);
    for (const x of txs(b)) expect(b.accounts[x.accountId]).toBeDefined();
  });

  describe('reconcileAccount', () => {
    it('reconciles cleared transactions without an adjustment when the balance agrees', () => {
      const { b, checking } = standardBudget();
      const c1 = addTx(b, checking, '2026-01-01', 10000, INCOME_NOW, { cleared: 'C' });
      const r1 = addTx(b, checking, '2026-01-01', 5000, INCOME_NOW, { cleared: 'R' });
      const u1 = addTx(b, checking, '2026-01-02', -700, null, { cleared: 'U' });
      expect(reconcileAccount(b, checking, 15000, '2026-01-31')).toBe(0);
      expect(b.transactions[c1].cleared).toBe('R');
      expect(b.transactions[r1].cleared).toBe('R');
      expect(b.transactions[u1].cleared).toBe('U');
      expect(txs(b)).toHaveLength(3);
      expect(b.accounts[checking]).toMatchObject({ lastReconciledDate: '2026-01-31', lastReconciledBalance: 15000 });
    });

    it('adds an adjustment for the difference', () => {
      const { b, checking, mortgage } = standardBudget();
      addTx(b, checking, '2026-01-01', 10000, INCOME_NOW, { cleared: 'C' });
      expect(reconcileAccount(b, checking, 9750, '2026-01-31')).toBe(-250);
      const adj = txs(b).find((t) => t.memo === 'Entered automatically by reconciliation')!;
      expect(adj).toMatchObject({ amount: -250, categoryId: INCOME_NOW, cleared: 'R', date: '2026-01-31' });
      expect(b.payees[adj.payeeId!].name).toBe('Reconciliation Balance Adjustment');
      expect(compute(b).accounts.get(checking)!.cleared).toBe(9750);

      // Off budget: no category.
      expect(reconcileAccount(b, mortgage, -100, '2026-01-31')).toBe(-100);
      expect(inAccount(b, mortgage)[0]).toMatchObject({ categoryId: null, amount: -100, cleared: 'R' });
    });

    it("compares and locks only what had cleared by the statement's date, as YNAB4 did (1.5)", () => {
      const { b, checking } = standardBudget();
      const before = addTx(b, checking, '2026-01-20', 10000, INCOME_NOW, { cleared: 'C' });
      const after = addTx(b, checking, '2026-02-03', -2500, null, { cleared: 'C' });
      expect(clearedBalance(b, checking, '2026-01-31')).toBe(10000);
      expect(reconcileAccount(b, checking, 10000, '2026-01-31')).toBe(0);
      expect(b.transactions[before].cleared).toBe('R');
      expect(b.transactions[after].cleared).toBe('C');
      expect(txs(b)).toHaveLength(2);
      // An older statement afterwards doesn't move "last reconciled" back.
      expect(reconcileAccount(b, checking, 10000, '2026-01-25')).toBe(0);
      expect(b.accounts[checking].lastReconciledDate).toBe('2026-01-31');
    });
  });
});
