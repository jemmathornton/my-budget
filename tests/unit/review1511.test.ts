// Fixes from the 15 November 2026 review (1.5.11). Made-up budgets only.
import { describe, expect, it } from 'vitest';
import { applyImport, matchTransactions, planImport, transferPairs } from '../../src/import/match';
import { approveTransactions, ensurePayee, moveToScheduler, saveTransaction } from '../../src/model/ops';
import { SPLIT } from '../../src/model/types';
import { addTx, standardBudget } from './fixtures';

describe('1.5.11 review fixes', () => {
  it('a second identical row after a duplicate is new, not a "possible" copy of it', () => {
    const { b, checking } = standardBudget();
    addTx(b, checking, '2026-11-02', -250, null, {
      cleared: 'C',
      importIds: ['YNAB:-2.50:2026-11-02:1'],
      importedPayee: 'BUS FARE',
      payeeId: ensurePayee(b, 'BUS FARE'),
    });
    const plan = planImport(b, checking, [
      { date: '2026-11-02', amount: -250, payee: 'BUS FARE', memo: '' },
      { date: '2026-11-02', amount: -250, payee: 'BUS FARE', memo: '' },
    ]);
    expect(plan.map((r) => r.kind)).toEqual(['duplicate', 'new']);
    expect(plan[1].include).toBe(true);
  });

  it('matching a typed transfer leaves its reconciled other side on its date', () => {
    const { b, checking, savings } = standardBudget();
    const typed = saveTransaction(b, { accountId: checking, date: '2026-11-01', transferAccountId: savings, amount: -10000, cleared: 'U', accepted: true });
    const peer = b.transactions[typed].transferTxId!;
    b.transactions[peer].cleared = 'R';
    const bank = addTx(b, checking, '2026-11-03', -10000, null, {
      cleared: 'C',
      accepted: false,
      importIds: ['YNAB:-100.00:2026-11-03:1'],
      importedPayee: 'TFR SAVINGS',
    });
    expect(matchTransactions(b, bank, typed)).toBeNull();
    expect(b.transactions[peer].date).toBe('2026-11-01');
    expect(b.transactions[typed].date).toBe('2026-11-01');
  });

  it('an import waiting for approval does not teach the payee its category until approved', () => {
    const { b, checking, fun } = standardBudget();
    const acme = ensurePayee(b, 'ACME CAFE')!;
    const id = saveTransaction(b, {
      accountId: checking,
      date: '2026-11-02',
      payeeId: acme,
      categoryId: fun,
      amount: -450,
      cleared: 'C',
      accepted: false,
      importIds: ['YNAB:-4.50:2026-11-02:1'],
    });
    expect(b.payees[acme].autoCategoryId ?? null).toBeNull();
    approveTransactions(b, [id]);
    expect(b.payees[acme].autoCategoryId).toBe(fun);
    // Typed by hand: learned straight away, as before.
    const shop = ensurePayee(b, 'Shop')!;
    saveTransaction(b, { accountId: checking, date: '2026-11-02', payeeId: shop, categoryId: fun, amount: -100, cleared: 'U', accepted: true });
    expect(b.payees[shop].autoCategoryId).toBe(fun);
  });

  it('Move to Scheduler keeps the cheque number', () => {
    const { b, checking, rent } = standardBudget();
    const id = addTx(b, checking, '2026-12-01', -60000, rent, { check: '001234' });
    const sid = moveToScheduler(b, id)!;
    expect(b.scheduled[sid].check).toBe('001234');
  });

  it('an approved import still learns straight away', () => {
    const { b, checking, groceries } = standardBudget();
    const plan = planImport(b, checking, [{ date: '2026-11-02', amount: -999, payee: 'GROCER', memo: '' }]);
    plan[0].categoryId = groceries;
    plan[0].userSet = true;
    applyImport(b, checking, plan, true);
    const p = Object.values(b.payees).find((x) => x.name.toUpperCase().includes('GROCER'));
    expect(p?.autoCategoryId).toBe(groceries);
  });

  it("matching a typed split leaves a reconciled split line's other side on its date", () => {
    const { b, checking, savings, groceries } = standardBudget();
    const split = saveTransaction(b, {
      accountId: checking,
      date: '2026-11-01',
      categoryId: SPLIT,
      amount: -50000,
      cleared: 'U',
      accepted: true,
      splits: [
        { id: 'a', categoryId: null, amount: -30000, transferAccountId: savings },
        { id: 'g', categoryId: groceries, amount: -20000 },
      ],
    });
    const far = b.transactions[split].splits!.find((x) => x.id === 'a')!.transferTxId!;
    b.transactions[far].cleared = 'R';
    const bank = addTx(b, checking, '2026-11-04', -50000, null, {
      cleared: 'C',
      accepted: false,
      importIds: ['YNAB:-500.00:2026-11-04:1'],
      importedPayee: 'SHOP',
    });
    expect(matchTransactions(b, bank, split)).toBeNull();
    expect(b.transactions[far].date).toBe('2026-11-01');
    expect(b.transactions[split].date).toBe('2026-11-01');
  });

});

describe('1.5.11: transfer pairing shown in the review', () => {
  /** Savings already has its own bank row of +100 on 2 Nov, approved in Fun. */
  function setup() {
    const { b, checking, savings, fun } = standardBudget();
    const theirs = addTx(b, savings, '2026-11-02', 10000, fun, {
      cleared: 'C',
      accepted: true,
      importIds: ['YNAB:100.00:2026-11-02:1'],
      importedPayee: 'J SMITH GIFT',
      payeeId: ensurePayee(b, 'J SMITH GIFT'),
    });
    const plan = planImport(b, checking, [
      { date: '2026-11-03', amount: -10000, payee: 'TFR SAVINGS', memo: '' },
      { date: '2026-11-03', amount: -10000, payee: 'TFR SAVINGS AGAIN', memo: '' },
    ]);
    for (const r of plan) Object.assign(r, { transferAccountId: savings, payeeName: 'Transfer : Savings', payeeId: undefined, categoryId: null });
    return { b, checking, savings, theirs, plan };
  }

  it('the review is told which row each transfer will take over, once only', () => {
    const { b, theirs, plan } = setup();
    const pairs = transferPairs(b, plan);
    expect(pairs.get(plan[0].key)?.id).toBe(theirs);
    expect(pairs.has(plan[1].key)).toBe(false);
  });

  it("what the review shows is what the import does", () => {
    const { b, checking, theirs, plan } = setup();
    plan[1].include = false;
    applyImport(b, checking, plan);
    expect(b.transactions[theirs].transferAccountId).toBe(checking);
  });

  it("\"Don't pair\" leaves the other account's row as it was and makes the transfer's own other side", () => {
    const { b, checking, savings, theirs, plan } = setup();
    plan[0].noPair = true;
    plan[1].include = false;
    expect(transferPairs(b, plan).size).toBe(0);
    applyImport(b, checking, plan);
    expect(b.transactions[theirs].transferAccountId).toBeUndefined();
    const made = Object.values(b.transactions).find((t) => t.accountId === checking && t.transferAccountId === savings)!;
    expect(made.transferTxId).toBeDefined();
    expect(made.transferTxId).not.toBe(theirs);
  });
});
