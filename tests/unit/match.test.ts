import { describe, expect, it } from 'vitest';
import type { BankTxn } from '../../src/import/bank';
import { applyImport, planImport, unconfirmedGuess } from '../../src/import/match';
import { compute } from '../../src/model/engine';
import { deleteTransactions, ensurePayee, saveTransaction, setPayeeRules } from '../../src/model/ops';
import { matchPayeeRules, transferPayeeId } from '../../src/model/queries';
import { SPLIT, type Budget } from '../../src/model/types';
import { addTx, standardBudget } from './fixtures';

const row = (date: string, amount: number, payee = 'SHOP', extra: Partial<BankTxn> = {}): BankTxn => ({
  date,
  amount,
  payee,
  memo: '',
  ...extra,
});

const txs = (b: Budget) => Object.values(b.transactions);

describe('planImport: duplicates', () => {
  it('spots a row whose FITID is already in the account, whatever its amount or date', () => {
    const { b, checking, savings } = standardBudget();
    const existing = addTx(b, checking, '2026-01-05', -1000, null, { importIds: ['FITID:ABC'] });
    addTx(b, savings, '2026-01-05', -1000, null, { importIds: ['FITID:XYZ'] });
    const plan = planImport(b, checking, [row('2026-01-20', -999, 'X', { fitid: 'ABC' }), row('2026-01-20', -999, 'X', { fitid: 'XYZ' })]);
    expect(plan[0]).toMatchObject({ kind: 'duplicate', include: false, matchId: existing, importIds: ['FITID:ABC', 'YNAB:-9.99:2026-01-20:1'] });
    // The same FITID in another account doesn't count.
    expect(plan[1].kind).toBe('new');
  });

  it('spots YNAB-style ids with thousands commas, numbering repeats within the file', () => {
    const { b, checking } = standardBudget();
    const withCommas = addTx(b, checking, '2026-01-05', -123456, null, { importIds: ['YNAB:-1,234.56:2026-01-05:1'] });
    const withoutCommas = addTx(b, checking, '2026-01-06', 123456, null, { importIds: ['YNAB:1234.56:2026-01-06:1'] });
    const plan = planImport(b, checking, [row('2026-01-05', -123456), row('2026-01-05', -123456), row('2026-01-06', 123456)]);
    expect(plan[0]).toMatchObject({ kind: 'duplicate', matchId: withCommas, importIds: ['YNAB:-1,234.56:2026-01-05:1'] });
    expect(plan[1]).toMatchObject({ kind: 'new', importIds: ['YNAB:-1,234.56:2026-01-05:2'] });
    expect(plan[2]).toMatchObject({ kind: 'duplicate', matchId: withoutCommas });
  });

  it('falls back to the YNAB-style id only for transactions that have no FITID of their own', () => {
    const { b, checking } = standardBudget();
    const ynabOnly = addTx(b, checking, '2026-01-05', -1000, null, { importIds: ['YNAB:-10.00:2026-01-05:1'] });
    addTx(b, checking, '2026-01-06', -2000, null, { importIds: ['FITID:OLD', 'YNAB:-20.00:2026-01-06:1'] });
    const plan = planImport(b, checking, [row('2026-01-05', -1000, 'A', { fitid: 'NEW1' }), row('2026-01-06', -2000, 'B', { fitid: 'OTHER' })]);
    expect(plan[0]).toMatchObject({ kind: 'duplicate', matchId: ynabOnly });
    expect(plan[1].kind).toBe('new');
  });

  it('never imports a duplicate, even when it is ticked', () => {
    const { b, checking } = standardBudget();
    addTx(b, checking, '2026-01-05', -1000, null, { importIds: ['FITID:ABC'] });
    const plan = planImport(b, checking, [row('2026-01-05', -1000, 'X', { fitid: 'ABC' })]);
    plan[0].include = true;
    expect(applyImport(b, checking, plan)).toEqual({ added: 0, matched: 0 });
    expect(txs(b)).toHaveLength(1);
  });
});

describe('planImport: matching hand-entered transactions', () => {
  function setup() {
    const f = standardBudget();
    const { b, checking, groceries } = f;
    const h1 = addTx(b, checking, '2026-01-10', -2500, groceries);
    const h2 = addTx(b, checking, '2026-01-16', -2500, groceries);
    return { ...f, h1, h2 };
  }

  it('matches the closest transaction with the same amount within the window', () => {
    const { b, checking, h2 } = setup();
    expect(planImport(b, checking, [row('2026-01-15', -2500)])[0]).toMatchObject({ kind: 'match', matchId: h2, include: true });
  });

  it('uses each hand-entered transaction once', () => {
    const { b, checking, h1, h2 } = setup();
    const plan = planImport(b, checking, [row('2026-01-15', -2500), row('2026-01-12', -2500), row('2026-01-12', -2500)]);
    expect(plan.map((r) => [r.kind, r.matchId])).toEqual([
      ['match', h2],
      ['match', h1],
      ['new', undefined],
    ]);
  });

  it('respects the number of days', () => {
    const { b, checking, h2 } = setup();
    expect(planImport(b, checking, [row('2026-01-27', -2500)])[0].kind).toBe('new');
    expect(planImport(b, checking, [row('2026-01-27', -2500)], 11)[0]).toMatchObject({ kind: 'match', matchId: h2 });
    expect(planImport(b, checking, [row('2026-01-16', -2500)], 0)[0]).toMatchObject({ kind: 'match', matchId: h2 });
  });

  it('skips reconciled, already imported, other-account and different-amount transactions', () => {
    const { b, checking, savings, h1, h2 } = setup();
    b.transactions[h1].cleared = 'R';
    b.transactions[h2].importIds = ['FITID:Z'];
    addTx(b, savings, '2026-01-15', -2500, null);
    addTx(b, checking, '2026-01-15', -2501, null);
    expect(planImport(b, checking, [row('2026-01-15', -2500)])[0].kind).toBe('new');
  });
});

describe('applyImport: matches', () => {
  it('marks the matched transaction as imported and cleared, and takes the bank date', () => {
    const { b, checking, groceries } = standardBudget();
    const h = addTx(b, checking, '2026-01-10', -2500, groceries, { importIds: undefined, memo: 'typed' });
    const plan = planImport(b, checking, [row('2026-01-12', -2500, 'TESCO STORES', { fitid: 'F1' })]);
    expect(applyImport(b, checking, plan)).toEqual({ added: 0, matched: 1 });
    expect(b.transactions[h]).toMatchObject({
      date: '2026-01-12',
      cleared: 'C',
      importIds: ['FITID:F1', 'YNAB:-25.00:2026-01-12:1'],
      importedPayee: 'TESCO STORES',
      categoryId: groceries,
      memo: 'typed',
    });
    expect(txs(b)).toHaveLength(1);
  });

  it('keeps the date of a cleared matched transfer, and its other side (1.3: re-imports mustn’t move transfers)', () => {
    const { b, checking, savings } = standardBudget();
    const t = saveTransaction(b, { accountId: checking, transferAccountId: savings, date: '2026-01-10', amount: -5000, cleared: 'C' });
    const plan = planImport(b, checking, [row('2026-01-13', -5000)]);
    applyImport(b, checking, plan);
    expect(b.transactions[t]).toMatchObject({ date: '2026-01-10', cleared: 'C' });
    expect(b.transactions[b.transactions[t].transferTxId!].date).toBe('2026-01-10');
  });

  it('still moves an uncleared matched transfer to the bank date, with its other side', () => {
    const { b, checking, savings } = standardBudget();
    const t = saveTransaction(b, { accountId: checking, transferAccountId: savings, date: '2026-01-10', amount: -5000, cleared: 'U' });
    applyImport(b, checking, planImport(b, checking, [row('2026-01-13', -5000)]));
    expect(b.transactions[t]).toMatchObject({ date: '2026-01-13', cleared: 'C' });
    expect(b.transactions[b.transactions[t].transferTxId!].date).toBe('2026-01-13');
  });

  it('moves the dates of a matched split’s transfer peers', () => {
    const { b, checking, savings, groceries } = standardBudget();
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
    applyImport(b, checking, planImport(b, checking, [row('2026-01-13', -3000)]));
    expect(b.transactions[parent].date).toBe('2026-01-13');
    expect(b.transactions[b.transactions[parent].splits![1].transferTxId!].date).toBe('2026-01-13');
  });
});

describe('payee rules', () => {
  function setup() {
    const f = standardBudget();
    const { b, groceries, fun } = f;
    const tesco = ensurePayee(b, 'Tesco')!;
    setPayeeRules(b, tesco, [{ op: 'contains', text: 'tesco' }]);
    b.payees[tesco].autoCategoryId = groceries;
    const petrol = ensurePayee(b, 'Tesco Petrol')!;
    setPayeeRules(b, petrol, [{ op: 'is', text: 'TESCO PETROL 123' }]);
    const shop = ensurePayee(b, 'Corner Shop')!;
    b.payees[shop].autoCategoryId = fun;
    const amazon = ensurePayee(b, 'Amazon')!;
    setPayeeRules(b, amazon, [{ op: 'startsWith', text: 'amazon' }]);
    const prime = ensurePayee(b, 'Amazon Prime')!;
    setPayeeRules(b, prime, [{ op: 'startsWith', text: 'amazon prime' }]);
    const gym = ensurePayee(b, 'Gym')!;
    setPayeeRules(b, gym, [{ op: 'endsWith', text: ' gym ltd' }]);
    return { ...f, tesco, petrol, shop, amazon, prime, gym };
  }

  it('picks an exact rule first, then the longest matching text', () => {
    const { b, tesco, petrol, amazon, prime, gym } = setup();
    expect(matchPayeeRules(b, 'TESCO STORES 3051')).toEqual({ payeeId: tesco });
    expect(matchPayeeRules(b, ' tesco petrol 123 ')).toEqual({ payeeId: petrol });
    expect(matchPayeeRules(b, 'AMAZON PRIME*123')).toEqual({ payeeId: prime });
    expect(matchPayeeRules(b, 'AMAZON MKTPLACE')).toEqual({ payeeId: amazon });
    expect(matchPayeeRules(b, 'PUREBODY GYM LTD')).toEqual({ payeeId: gym });
    expect(matchPayeeRules(b, 'SAINSBURYS')).toBeNull();
    expect(matchPayeeRules(b, '  ')).toBeNull();
  });

  it('renames payees and fills in their usual category on new rows', () => {
    const { b, checking, groceries, fun, tesco, petrol, shop } = setup();
    const plan = planImport(b, checking, [
      row('2026-02-01', -1000, 'TESCO STORES 3051'),
      row('2026-02-02', -1100, 'TESCO PETROL 123'),
      row('2026-02-03', -1200, 'corner  shop'),
      row('2026-02-04', -1300, 'CARD PAYMENT', { memo: 'TESCO 99' }),
      row('2026-02-05', -1400, 'Unknown   Place', { check: '000123' }),
    ]);
    expect(plan.map((r) => [r.payeeName, r.payeeId, r.categoryId])).toEqual([
      ['Tesco', tesco, groceries],
      ['Tesco Petrol', petrol, undefined],
      ['Corner Shop', shop, fun],
      ['Tesco', tesco, groceries],
      ['Unknown Place', undefined, undefined],
    ]);

    expect(applyImport(b, checking, plan)).toEqual({ added: 5, matched: 0 });
    const byDate = Object.fromEntries(txs(b).map((t) => [t.date, t]));
    expect(byDate['2026-02-01']).toMatchObject({ payeeId: tesco, categoryId: groceries, cleared: 'C', accepted: false, importedPayee: 'TESCO STORES 3051' });
    expect(byDate['2026-02-02'].categoryId).toBeNull();
    const unknown = byDate['2026-02-05'];
    expect(b.payees[unknown.payeeId!].name).toBe('Unknown Place');
    expect(unknown).toMatchObject({ check: '000123', importIds: ['YNAB:-14.00:2026-02-05:1'], importedPayee: 'Unknown   Place' });
  });

  it('approves imports when asked, and leaves out unticked rows', () => {
    const { b, checking } = setup();
    const plan = planImport(b, checking, [row('2026-02-01', -1000, 'A'), row('2026-02-02', -1000, 'B')]);
    plan[1].include = false;
    expect(applyImport(b, checking, plan, true)).toEqual({ added: 1, matched: 0 });
    expect(txs(b)).toHaveLength(1);
    expect(txs(b)[0].accepted).toBe(true);
  });

  it('turns rows into transfers with a rule on a transfer payee', () => {
    const { b, checking, savings, mortgage, rent } = setup();
    setPayeeRules(b, transferPayeeId(savings), [{ op: 'contains', text: 'TO SAVINGS' }]);
    setPayeeRules(b, transferPayeeId(mortgage), [{ op: 'contains', text: 'MORTGAGE' }]);
    b.payees[transferPayeeId(mortgage)].autoCategoryId = rent;
    const plan = planImport(b, checking, [row('2026-02-01', -5000, 'TFR TO SAVINGS 01'), row('2026-02-02', -70000, 'BIG BANK MORTGAGE')]);
    expect(plan[0]).toMatchObject({ kind: 'new', transferAccountId: savings, payeeName: 'Transfer : Savings' });
    expect(plan[0].categoryId).toBeUndefined();
    expect(plan[1]).toMatchObject({ transferAccountId: mortgage, payeeName: 'Transfer : Mortgage', categoryId: rent });

    applyImport(b, checking, plan);
    const t1 = txs(b).find((t) => t.date === '2026-02-01' && t.accountId === checking)!;
    expect(t1).toMatchObject({ transferAccountId: savings, payeeId: transferPayeeId(savings), cleared: 'C', categoryId: null });
    expect(b.transactions[t1.transferTxId!]).toMatchObject({ accountId: savings, amount: 5000, cleared: 'U' });
    const t2 = txs(b).find((t) => t.date === '2026-02-02' && t.accountId === checking)!;
    expect(t2).toMatchObject({ transferAccountId: mortgage, categoryId: rent });
    expect(compute(b).uncategorized).toEqual([]);
  });

  it('ignores a transfer rule that points at the account being imported into', () => {
    const { b, savings } = setup();
    setPayeeRules(b, transferPayeeId(savings), [{ op: 'contains', text: 'TO SAVINGS' }]);
    const [r] = planImport(b, savings, [row('2026-02-01', 5000, 'TFR TO SAVINGS 01')]);
    expect(r.transferAccountId).toBeUndefined();
    expect(r.payeeName).toBe('TFR TO SAVINGS 01');
  });
});

describe('transfer pairing on import', () => {
  function setup(otherExtra: Parameters<typeof addTx>[5] = { importIds: ['FITID:S1'] }, otherDate = '2026-01-11') {
    const f = standardBudget();
    const { b, checking, savings } = f;
    setPayeeRules(b, transferPayeeId(savings), [{ op: 'contains', text: 'TO SAVINGS' }]);
    const other = addTx(b, savings, otherDate, 5000, null, { payeeId: ensurePayee(b, 'FROM CURRENT AC'), cleared: 'C', ...otherExtra });
    const plan = planImport(b, checking, [row('2026-01-10', -5000, 'TFR TO SAVINGS', { fitid: 'C1' })]);
    return { ...f, other, plan, checking };
  }

  it('pairs with the other side when it was already imported from its own bank file', () => {
    const { b, checking, savings, other, plan } = setup();
    expect(applyImport(b, checking, plan)).toEqual({ added: 1, matched: 0 });
    expect(txs(b)).toHaveLength(2);
    const t = txs(b).find((x) => x.accountId === checking)!;
    expect(t).toMatchObject({ transferAccountId: savings, transferTxId: other, cleared: 'C', importIds: ['FITID:C1', 'YNAB:-50.00:2026-01-10:1'] });
    expect(b.transactions[other]).toMatchObject({
      transferAccountId: checking,
      transferTxId: t.id,
      payeeId: transferPayeeId(checking),
      categoryId: null,
      date: '2026-01-10',
      importIds: ['FITID:S1'],
    });
    expect(b.payees[transferPayeeId(checking)]).toBeDefined();
    expect(compute(b).uncategorized).toEqual([]);
    // The pair behaves like any other transfer.
    deleteTransactions(b, [t.id]);
    expect(txs(b)).toEqual([]);
  });

  it('does not pair with a hand-entered transaction or one more than 3 days away', () => {
    let s = setup({ importIds: undefined });
    applyImport(s.b, s.checking, s.plan);
    expect(txs(s.b)).toHaveLength(3);
    expect(s.b.transactions[s.other].transferAccountId).toBeUndefined();

    s = setup({ importIds: ['FITID:S1'] }, '2026-01-14');
    applyImport(s.b, s.checking, s.plan);
    expect(txs(s.b)).toHaveLength(3);
    expect(s.b.transactions[s.other].transferAccountId).toBeUndefined();
  });

  it('does not pair the same other side twice', () => {
    const { b, checking, savings } = setup();
    const plan = planImport(b, checking, [row('2026-01-10', -5000, 'TFR TO SAVINGS', { fitid: 'C1' }), row('2026-01-10', -5000, 'TFR TO SAVINGS', { fitid: 'C2' })]);
    applyImport(b, checking, plan);
    expect(txs(b).filter((t) => t.accountId === savings)).toHaveLength(2);
    expect(txs(b).filter((t) => t.accountId === checking)).toHaveLength(2);
  });

  it('pairs with the nearest row in date, never a split or a match waiting for approval (1.4.5)', () => {
    // A row 3 days away comes first (setup's), then the real other side, 1 day away.
    const { b, checking, savings, other: far, groceries } = setup({ importIds: ['FITID:S0'] }, '2026-01-13');
    const near = addTx(b, savings, '2026-01-11', 5000, null, { importIds: ['FITID:S1'], cleared: 'C' });
    const plan = planImport(b, checking, [row('2026-01-10', -5000, 'TFR TO SAVINGS', { fitid: 'C1' })]);
    applyImport(b, checking, plan);
    expect(b.transactions[near].transferAccountId).toBe(checking);
    expect(b.transactions[far].transferAccountId).toBeUndefined();

    // A split and a waiting match aren't turned into transfers.
    const s = setup({ importIds: ['FITID:S1'], categoryId: SPLIT, splits: [{ id: 'l', categoryId: groceries, amount: 5000 }] });
    applyImport(s.b, s.checking, s.plan);
    expect(s.b.transactions[s.other]).toMatchObject({ categoryId: SPLIT });
    expect(s.b.transactions[s.other].transferAccountId).toBeUndefined();
    // A match waiting for approval (a payment typed by hand, then matched by its own file) is
    // paired too, and its match settled: otherwise the payment would be there twice (1.5.3).
    const m = setup();
    m.b.transactions[m.other].matched = { bank: { date: '2026-01-11', amount: 5000, payee: 'X' }, importIds: ['FITID:S1'], yours: { date: '2026-01-11', cleared: 'C', accepted: true } };
    applyImport(m.b, m.checking, m.plan);
    expect(m.b.transactions[m.other].transferAccountId).toBe(m.checking);
    expect(m.b.transactions[m.other].matched).toBeUndefined();
    expect(txs(m.b).filter((t) => t.accountId === savings)).toHaveLength(1);
  });

  it('gives both sides one date, the earlier of the two bank dates (night seven), so Check budget stays clean (1.5.3)', async () => {
    const { checkBudget } = await import('../../src/model/check');
    const { b, checking, other, plan } = setup();
    applyImport(b, checking, plan);
    const t = txs(b).find((x) => x.accountId === checking)!;
    expect(t.date).toBe('2026-01-10');
    expect(b.transactions[other].date).toBe('2026-01-10');
    expect(checkBudget(b)).toEqual([]);
  });
});

describe('importing the second account of a transfer (1.5.3)', () => {
  it("leaves the first account's imported row on its bank date", () => {
    const { b, checking, savings } = standardBudget();
    setPayeeRules(b, transferPayeeId(savings), [{ op: 'contains', text: 'TO SAVINGS' }]);
    // The current account's file first: its rule makes a transfer, whose savings side is new.
    applyImport(b, checking, planImport(b, checking, [row('2026-01-10', -5000, 'TFR TO SAVINGS', { fitid: 'C1' })]));
    const far = txs(b).find((t) => t.accountId === savings)!;
    expect(far.cleared).toBe('U');
    // Then the savings file, whose row is dated 2 days later: it matches that side, and no date moves.
    const plan = planImport(b, savings, [row('2026-01-12', 5000, 'FROM CURRENT', { fitid: 'S1' })]);
    expect(plan[0]).toMatchObject({ kind: 'match', matchId: far.id });
    applyImport(b, savings, plan);
    expect(txs(b).map((t) => [t.accountId === checking ? 'current' : 'savings', t.date, t.cleared]).sort()).toEqual([
      ['current', '2026-01-10', 'C'],
      ['savings', '2026-01-10', 'C'],
    ]);
  });

  it('approves a match straight away when the import is approved automatically', () => {
    const { b, checking, groceries } = standardBudget();
    // A scheduled transaction arrives unapproved.
    const id = addTx(b, checking, '2026-01-10', -1500, groceries, { accepted: false });
    applyImport(b, checking, planImport(b, checking, [row('2026-01-11', -1500, 'GYM', { fitid: 'G1' })]), true);
    expect(b.transactions[id]).toMatchObject({ accepted: true, cleared: 'C' });
    expect(b.transactions[id].matched).toBeUndefined();
  });
});

describe('re-importing', () => {
  it('finds everything already there the second time', () => {
    const { b, checking, groceries, savings } = standardBudget();
    setPayeeRules(b, transferPayeeId(savings), [{ op: 'contains', text: 'TO SAVINGS' }]);
    addTx(b, checking, '2026-03-02', -1999, groceries);
    const file = [
      row('2026-03-01', -1000, 'CAFE', { fitid: 'A' }),
      row('2026-03-03', -1999, 'MARKET', { fitid: 'B' }),
      row('2026-03-04', -5000, 'TFR TO SAVINGS', { fitid: 'C' }),
      row('2026-03-05', -700, 'NO FITID'),
      row('2026-03-05', -700, 'NO FITID'),
    ];
    const first = planImport(b, checking, file);
    expect(first.map((r) => r.kind)).toEqual(['new', 'match', 'new', 'new', 'new']);
    applyImport(b, checking, first);
    const count = txs(b).length;
    const second = planImport(b, checking, file);
    expect(second.map((r) => r.kind)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
    expect(applyImport(b, checking, second)).toEqual({ added: 0, matched: 0 });
    expect(txs(b)).toHaveLength(count);
  });
});

describe('matches waiting for approval (Bank: / Yours:) and Unmatch', () => {
  it('keeps the bank row and your values until approved', async () => {
    const { approveTransactions } = await import('../../src/model/ops');
    const { b, checking, groceries } = standardBudget();
    const h = addTx(b, checking, '2026-01-10', -2500, groceries, { importIds: undefined });
    applyImport(b, checking, planImport(b, checking, [row('2026-01-12', -2500, 'TESCO STORES', { memo: 'card 1234', fitid: 'F1' })]));
    expect(b.transactions[h].accepted).toBe(false);
    expect(b.transactions[h].matched).toEqual({
      bank: { date: '2026-01-12', amount: -2500, payee: 'TESCO STORES', memo: 'card 1234' },
      importIds: ['FITID:F1', 'YNAB:-25.00:2026-01-12:1'],
      yours: { date: '2026-01-10', cleared: 'U', accepted: true },
    });
    approveTransactions(b, [h]);
    expect(b.transactions[h].matched).toBeUndefined();
  });

  it('keeps no record when imports are approved automatically', () => {
    const { b, checking } = standardBudget();
    const h = addTx(b, checking, '2026-01-10', -2500, null);
    applyImport(b, checking, planImport(b, checking, [row('2026-01-12', -2500)]), true);
    expect(b.transactions[h].accepted).toBe(true);
    expect(b.transactions[h].matched).toBeUndefined();
  });

  it('Unmatch puts yours back and adds the bank row as a new import', async () => {
    const { unmatchTransaction } = await import('../../src/import/match');
    const { b, checking, groceries, fun } = standardBudget();
    const tesco = ensurePayee(b, 'Tesco')!;
    addTx(b, checking, '2025-12-01', -900, fun, { payeeId: tesco, importIds: ['YNAB:-9.00:2025-12-01:1'] });
    setPayeeRules(b, tesco, [{ op: 'contains', text: 'TESCO' }]);
    const h = addTx(b, checking, '2026-01-10', -2500, groceries, { importIds: undefined, memo: 'typed', accepted: false });
    applyImport(b, checking, planImport(b, checking, [row('2026-01-12', -2500, 'TESCO STORES', { fitid: 'F1' })]));
    const id = unmatchTransaction(b, h)!;
    expect(b.transactions[h]).toMatchObject({ date: '2026-01-10', cleared: 'U', accepted: false, memo: 'typed' });
    expect(b.transactions[h].importIds).toBeUndefined();
    expect(b.transactions[h].importedPayee).toBeUndefined();
    expect(b.transactions[h].matched).toBeUndefined();
    expect(b.transactions[id]).toMatchObject({
      date: '2026-01-12',
      amount: -2500,
      payeeId: tesco,
      categoryId: fun,
      cleared: 'C',
      accepted: false,
      importIds: ['FITID:F1', 'YNAB:-25.00:2026-01-12:1'],
      importedPayee: 'TESCO STORES',
    });
    // Importing the same file again finds the bank row, not a new match.
    const again = planImport(b, checking, [row('2026-01-12', -2500, 'TESCO STORES', { fitid: 'F1' })]);
    expect(again[0]).toMatchObject({ kind: 'duplicate', matchId: id });
  });

  it('Unmatch moves a transfer’s other side back too', async () => {
    const { unmatchTransaction } = await import('../../src/import/match');
    const { b, checking, savings } = standardBudget();
    const t = saveTransaction(b, { accountId: checking, transferAccountId: savings, date: '2026-01-10', amount: -5000, cleared: 'U' });
    const peer = b.transactions[t].transferTxId!;
    applyImport(b, checking, planImport(b, checking, [row('2026-01-13', -5000)]));
    expect(b.transactions[peer].date).toBe('2026-01-13');
    unmatchTransaction(b, t);
    expect(b.transactions[t].date).toBe('2026-01-10');
    expect(b.transactions[peer].date).toBe('2026-01-10');
  });
});

describe('1.3 planning: possible duplicates, payee proposals, suggestions', () => {
  const imp = (b: Budget, accountId: string, date: string, text: string, amount: number, categoryId: string | null, ids: string[]) =>
    saveTransaction(b, { accountId, date, payeeName: text, importedPayee: text, importIds: ids, amount, categoryId, cleared: 'C' });

  it('flags a row like one imported from another file, unticked, within 3 days and the same text', () => {
    const { b, checking } = standardBudget();
    const t = imp(b, checking, '2026-01-10', 'INTEREST PAID AFTER TAX 0.00 DEDUCTED, 0.42', 42, null, ['YNAB:0.42:2026-01-10:1']);
    const plan = planImport(b, checking, [row('2026-01-12', 42, 'INTEREST PAID AFTER TAX 0.00 DEDUCTED, 0.42')]);
    expect(plan[0]).toMatchObject({ kind: 'possible', include: false, matchId: t });
    // Too far apart, or a different amount: new.
    expect(planImport(b, checking, [row('2026-01-14', 42, 'INTEREST PAID AFTER TAX 0.00 DEDUCTED, 0.42')])[0].kind).toBe('new');
    expect(planImport(b, checking, [row('2026-01-12', 43, 'INTEREST PAID AFTER TAX 0.00 DEDUCTED, 0.43')])[0].kind).toBe('new');
  });

  it('never flags two rows with different bank ids, and imports a flagged row when ticked', () => {
    const { b, checking } = standardBudget();
    imp(b, checking, '2026-01-10', 'BUS FARE', -250, null, ['FITID:A1', 'YNAB:-2.50:2026-01-10:1']);
    expect(planImport(b, checking, [row('2026-01-11', -250, 'BUS FARE', { fitid: 'A2' })])[0].kind).toBe('new');
    const plan = planImport(b, checking, [row('2026-01-11', -250, 'BUS FARE')]);
    expect(plan[0].kind).toBe('possible');
    plan[0].include = true;
    expect(applyImport(b, checking, plan).added).toBe(1);
  });

  it('proposes the payee of the same bank text, and names a new payee with the tidied text', () => {
    const { b, checking, groceries } = standardBudget();
    const tesco = ensurePayee(b, 'Tesco')!;
    saveTransaction(b, { accountId: checking, date: '2026-01-02', payeeId: tesco, importedPayee: 'TESCO STORES 1111 TOWNA GB', importIds: ['x'], amount: -1000, categoryId: groceries, cleared: 'C' });
    const plan = planImport(b, checking, [
      row('2026-02-02', -1200, 'TESCO STORES 1111 TOWNA GB'),
      row('2026-02-03', -500, 'DIRECT DEBIT PAYMENT TO NEWCO REF 1, MANDATE NO 2, 5.00'),
    ]);
    expect(plan[0]).toMatchObject({ payeeId: tesco, payeeName: 'Tesco', payeeVia: 'text', categoryId: groceries });
    expect(plan[0].guess).toMatchObject({ source: 'text' });
    expect(plan[1].payeeName).toBe('DIRECT DEBIT PAYMENT TO NEWCO REF 1, MANDATE NO 2');
    expect(plan[1].payeeId).toBeUndefined();
  });

  it("doesn't guess for a payee set to never be guessed", () => {
    const { b, checking, groceries } = standardBudget();
    const atm = ensurePayee(b, 'Cash')!;
    b.payees[atm].noGuess = true;
    saveTransaction(b, { accountId: checking, date: '2026-01-02', payeeId: atm, amount: -1000, categoryId: groceries, cleared: 'C' });
    const plan = planImport(b, checking, [row('2026-02-02', -1000, 'Cash')]);
    expect(plan[0].payeeId).toBe(atm);
    expect(plan[0].categoryId).toBeUndefined();
  });

  it('leaves suggested guesses unapproved even when approving automatically', () => {
    const { b, checking, groceries } = standardBudget();
    for (const d of ['01', '02', '03']) imp(b, checking, `2026-01-${d}`, 'GREEN GROCER TOWNA', -900, groceries, ['g' + d]);
    imp(b, checking, '2026-01-04', 'FARM SHOP TOWNB', -700, groceries, ['f1']);
    const plan = planImport(b, checking, [row('2026-02-02', -900, 'GREEN GROCER TOWNA'), row('2026-02-03', -700, 'FARM SHOP TOWNB')]);
    expect(plan[0].guess?.tier).toBe('confident');
    expect(plan[1].guess?.tier).toBe('suggested');
    applyImport(b, checking, plan, true);
    const byText = (s: string) => Object.values(b.transactions).find((t) => t.importedPayee === s && t.date >= '2026-02-01')!;
    expect(byText('GREEN GROCER TOWNA').accepted).toBe(true);
    expect(byText('FARM SHOP TOWNB').accepted).toBe(false);
  });

  it('offers a transfer when the same bank text was one last time, without filling it in', () => {
    const { b, checking, savings } = standardBudget();
    const id = saveTransaction(b, { accountId: checking, date: '2026-01-02', transferAccountId: savings, amount: -5000, cleared: 'C' });
    b.transactions[id].importedPayee = 'TRANSFER TO 12345678';
    b.transactions[id].importIds = ['t1'];
    const plan = planImport(b, checking, [row('2026-02-02', -5000, 'TRANSFER TO 12345678')]);
    expect(plan[0].transferHint).toBe(savings);
    expect(plan[0].transferAccountId).toBeUndefined();
  });
});

describe('rule transfers that went elsewhere last time (1.4.4)', () => {
  it("keeps the rule's account but asks, when the same bank text went to another account last time", () => {
    const { b, checking, savings, card } = standardBudget();
    setPayeeRules(b, transferPayeeId(savings), [{ op: 'contains', text: 'REGULAR SAVER' }]);
    // Last month the same bank text was a transfer to the card account.
    saveTransaction(b, { accountId: checking, transferAccountId: card, date: '2026-01-05', amount: -10000, cleared: 'C', importedPayee: 'REGULAR SAVER 123', importIds: ['YNAB:x:1'] });
    const [r] = planImport(b, checking, [row('2026-02-05', -10000, 'REGULAR SAVER 123')]);
    expect(r).toMatchObject({ transferAccountId: savings, transferCheck: card });
    expect(unconfirmedGuess(r)).toBe(true);
    // Changing something else on the row (its category, say) doesn't confirm the account.
    expect(unconfirmedGuess({ ...r, userSet: true })).toBe(true);
    // Even with "Approve automatically" it waits for approval.
    applyImport(b, checking, [r], true);
    expect(txs(b).find((t) => t.date === '2026-02-05' && t.accountId === checking)).toMatchObject({ transferAccountId: savings, accepted: false });
  });

  it('still follows a rule to a closed account, but flags it and waits for approval', () => {
    const { b, checking, savings } = standardBudget();
    setPayeeRules(b, transferPayeeId(savings), [{ op: 'contains', text: 'OLD SAVER' }]);
    // The same bank text went to that account before it was closed.
    saveTransaction(b, { accountId: checking, transferAccountId: savings, date: '2026-01-05', amount: -10000, cleared: 'C', importedPayee: 'OLD SAVER 9', importIds: ['YNAB:y:1'] });
    b.accounts[savings].closed = true;
    const [r] = planImport(b, checking, [row('2026-02-05', -10000, 'OLD SAVER 9')]);
    expect(r).toMatchObject({ transferAccountId: savings, transferClosed: true });
    expect(r.payeeName).toMatch(/^Transfer/);
    // "Last time" never offers a closed account.
    expect(r.transferCheck).toBeUndefined();
    expect(unconfirmedGuess(r)).toBe(true);
    applyImport(b, checking, [r], true);
    expect(txs(b).find((t) => t.date === '2026-02-05' && t.accountId === checking)).toMatchObject({ transferAccountId: savings, accepted: false });
  });

  it("doesn't flag a rule again once its account was kept, and never changes the rule", () => {
    const { b, checking, savings, card } = standardBudget();
    setPayeeRules(b, transferPayeeId(savings), [{ op: 'contains', text: 'REGULAR SAVER' }]);
    const rulesBefore = JSON.stringify(b.payees[transferPayeeId(savings)].rules);
    saveTransaction(b, { accountId: checking, transferAccountId: card, date: '2026-01-05', amount: -10000, cleared: 'C', importedPayee: 'REGULAR SAVER 123', importIds: ['YNAB:x:1'] });
    const [r] = planImport(b, checking, [row('2026-02-05', -10000, 'REGULAR SAVER 123')]);
    expect(r.transferCheck).toBe(card);
    // Kept as the rule says (Enter on the row), then approved.
    applyImport(b, checking, [{ ...r, userSet: true, transferCheck: undefined }], true);
    const [next] = planImport(b, checking, [row('2026-03-05', -10000, 'REGULAR SAVER 123')]);
    expect(next).toMatchObject({ transferAccountId: savings });
    expect(next.transferCheck).toBeUndefined();
    expect(JSON.stringify(b.payees[transferPayeeId(savings)].rules)).toBe(rulesBefore);
  });
});
