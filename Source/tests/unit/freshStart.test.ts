import { afterEach, describe, expect, it, vi } from 'vitest';
import { categoryMonth, compute } from '../../src/model/engine';
import { freshStart } from '../../src/model/freshStart';
import { addCategory, addMaster, ensurePayee, saveScheduled, setBudgeted, setPayeeRules } from '../../src/model/ops';
import { categoriesOf, sortedAccounts, transferPayeeId } from '../../src/model/queries';
import { INCOME_NOW, SPLIT } from '../../src/model/types';
import { addTestAccount, addTx, setNow, standardBudget } from './fixtures';

afterEach(() => vi.useRealTimers());

function oldBudget() {
  const f = standardBudget();
  const { b, checking, savings, card, mortgage, rent, groceries, fun } = f;
  b.name = 'Household';
  b.currency = { code: 'EUR', symbol: '€', locale: 'en-IE', decimals: 2, symbolFirst: true };
  b.dateFormat = 'YYYY-MM-DD';
  b.settings = { creditOverspendingToDebt: true, matchDays: 5 };
  b.categories[fun].hidden = true;
  const isa = addTestAccount(b, 'Old ISA', 'Savings');
  b.accounts[isa].closed = true;
  // A closed account with nothing left in it.
  const emptyClosed = addTestAccount(b, 'Old Current', 'Checking');
  b.accounts[emptyClosed].closed = true;
  b.accounts[checking].importKeys = ['ofx:1:2'];
  b.accounts[checking].bankProfile = 'santander';
  b.accounts[checking].csvMapping = {
    delimiter: ',', hasHeader: true, skipRows: 0, dateCol: 0, dateFormat: 'DMY', payeeCol: 1, memoCol: 2,
    amountMode: 'single', amountCol: 3, inflowCol: -1, outflowCol: -1, invert: false, refCol: -1,
  };

  const oldDebtMaster = addMaster(b, 'Pre-YNAB Debt');
  const oldDebtCat = addCategory(b, oldDebtMaster, 'Store Card');

  addTx(b, checking, '2025-01-01', 200000, INCOME_NOW);
  addTx(b, checking, '2025-02-01', -80000, rent);
  addTx(b, savings, '2025-01-01', 30000, INCOME_NOW);
  addTx(b, card, '2025-03-01', -45000, groceries);
  addTx(b, mortgage, '2025-01-01', -9000000, null);
  addTx(b, isa, '2025-01-01', 5000, INCOME_NOW);
  setBudgeted(b, '2025-01', rent, 80000);

  const landlord = ensurePayee(b, 'Landlord')!;
  b.payees[landlord].autoCategoryId = rent;
  setPayeeRules(b, landlord, [{ op: 'contains', text: 'LETTINGS' }]);
  const payday = ensurePayee(b, 'Payday')!;
  b.payees[payday].autoCategoryId = INCOME_NOW;
  const debtPayee = ensurePayee(b, 'Store')!;
  b.payees[debtPayee].autoCategoryId = oldDebtCat;
  setPayeeRules(b, transferPayeeId(savings), [{ op: 'contains', text: 'TO SAVINGS' }]);
  setPayeeRules(b, transferPayeeId(mortgage), [{ op: 'contains', text: 'MORTGAGE' }]);
  b.payees[transferPayeeId(mortgage)].autoCategoryId = rent;

  const sched = (x: Partial<Parameters<typeof saveScheduled>[1]>) =>
    saveScheduled(b, { accountId: checking, date: '2026-11-01', startDate: '2026-11-01', frequency: 'Monthly', categoryId: rent, amount: -1000, ...x });
  const s = {
    plain: sched({ payeeId: landlord }),
    toClosed: sched({ transferAccountId: isa, categoryId: null }),
    oldDebt: sched({ categoryId: oldDebtCat }),
    split: sched({
      categoryId: SPLIT,
      splits: [
        { id: 'a', categoryId: rent, amount: -600 },
        { id: 'b', categoryId: groceries, amount: -400 },
      ],
    }),
    splitToClosed: sched({
      categoryId: SPLIT,
      splits: [
        { id: 'a', categoryId: rent, amount: -600 },
        { id: 'b', categoryId: null, amount: -400, transferAccountId: isa },
      ],
    }),
    inClosed: sched({ accountId: isa }),
    transfer: sched({ transferAccountId: savings, categoryId: null }),
  };
  return { ...f, isa, emptyClosed, oldDebtMaster, oldDebtCat, landlord, payday, debtPayee, s };
}

describe('freshStart', () => {
  it('leaves the old budget untouched', () => {
    setNow(2026, 10, 13);
    const { b } = oldBudget();
    const before = JSON.stringify(b);
    const nb = freshStart(b, 'Fresh', '2026-10-13');
    expect(JSON.stringify(b)).toBe(before);
    // Nothing is shared by reference either.
    nb.payees[transferPayeeId(Object.keys(nb.accounts)[1])].rules.push({ op: 'is', text: 'changed' });
    nb.currency.symbol = 'X';
    nb.settings.matchDays = 99;
    Object.values(nb.accounts).forEach((a) => a.importKeys?.push('changed'));
    Object.values(nb.scheduled).forEach((s) => s.splits?.forEach((l) => (l.amount = 1)));
    expect(JSON.stringify(b)).toBe(before);
  });

  it('copies settings and names where it came from', () => {
    const { b } = oldBudget();
    const nb = freshStart(b, 'Fresh', '2026-10-13');
    expect(nb.name).toBe('Fresh');
    expect(nb.id).not.toBe(b.id);
    expect(nb.freshStartFrom).toBe('Household');
    expect(nb.currency).toEqual(b.currency);
    expect(nb.dateFormat).toBe('YYYY-MM-DD');
    expect(nb.settings).toEqual({ creditOverspendingToDebt: true, matchDays: 5 });
    // No budget history: only the new debt category's "carry" setting.
    expect(Object.keys(nb.months)).toEqual(['2026-10']);
  });

  it('keeps open accounts, and closed ones that still hold money, with the same ids, order and balances', () => {
    setNow(2026, 10, 13);
    const { b, checking, savings, card, mortgage, isa, emptyClosed } = oldBudget();
    const nb = freshStart(b, 'Fresh', '2026-10-13');
    expect(sortedAccounts(nb).map((a) => a.id)).toEqual([checking, savings, card, mortgage, isa]);
    expect(nb.accounts[isa].closed).toBe(true);
    expect(nb.accounts[emptyClosed]).toBeUndefined();
    expect(nb.accounts[checking]).toMatchObject({ importKeys: ['ofx:1:2'], csvMapping: b.accounts[checking].csvMapping, bankProfile: 'santander' });
    const oldC = compute(b);
    const newC = compute(nb);
    for (const id of [checking, savings, card, mortgage, isa]) {
      expect(newC.accounts.get(id)!.working).toBe(oldC.accounts.get(id)!.working);
      const starting = Object.values(nb.transactions).filter((t) => t.accountId === id);
      expect(starting).toHaveLength(1);
      expect(starting[0]).toMatchObject({ date: '2026-10-13', cleared: 'C' });
      expect(nb.payees[starting[0].payeeId!].name).toBe('Starting Balance');
    }
  });

  it('copies groups, categories and payees, dropping the old Pre-YNAB Debt group', () => {
    const { b, bills, everyday, rent, fun, oldDebtMaster, oldDebtCat, landlord, payday, debtPayee } = oldBudget();
    const nb = freshStart(b, 'Fresh', '2026-10-13');
    expect(nb.masters[bills]).toEqual(b.masters[bills]);
    expect(nb.masters[everyday]).toEqual(b.masters[everyday]);
    expect(nb.masters[oldDebtMaster]).toBeUndefined();
    expect(nb.categories[oldDebtCat]).toBeUndefined();
    expect(nb.categories[fun].hidden).toBe(true);
    expect(nb.payees[landlord]).toMatchObject({ name: 'Landlord', autoCategoryId: rent, rules: [{ op: 'contains', text: 'LETTINGS' }] });
    expect(nb.payees[payday].autoCategoryId).toBe(INCOME_NOW);
    expect(nb.payees[debtPayee].autoCategoryId).toBeNull();
  });

  it('keeps transfer rename rules, and their category if it still exists', () => {
    const { b, savings, mortgage, rent } = oldBudget();
    const nb = freshStart(b, 'Fresh', '2026-10-13');
    expect(nb.payees[transferPayeeId(savings)]).toMatchObject({ transferAccountId: savings, rules: [{ op: 'contains', text: 'TO SAVINGS' }] });
    expect(nb.payees[transferPayeeId(mortgage)]).toMatchObject({ rules: [{ op: 'contains', text: 'MORTGAGE' }], autoCategoryId: rent });
  });

  it('puts all budget-account money into Available to Budget and gives debts a carrying Pre-YNAB Debt category', () => {
    setNow(2026, 10, 13);
    const { b, checking, card, mortgage } = oldBudget();
    const nb = freshStart(b, 'Fresh', '2026-10-13');
    const debtMasters = Object.values(nb.masters).filter((m) => m.name === 'Pre-YNAB Debt');
    expect(debtMasters).toHaveLength(1);
    const [cardCat] = categoriesOf(nb, debtMasters[0].id);
    expect(cardCat.name).toBe('Card');
    const startOf = (id: string) => Object.values(nb.transactions).find((t) => t.accountId === id)!;
    expect(startOf(checking)).toMatchObject({ amount: 120000, categoryId: INCOME_NOW });
    expect(startOf(card)).toMatchObject({ amount: -45000, categoryId: cardCat.id });
    expect(startOf(mortgage)).toMatchObject({ amount: -9000000, categoryId: null });

    const c = compute(nb);
    expect(c.first).toBe('2026-10');
    // Checking 1,200 + savings 300 + the closed ISA's 50.
    expect(c.summary.get('2026-10')!.atb).toBe(155000);
    expect(c.summary.get('2026-11')!.atb).toBe(155000);
    expect(categoryMonth(c, '2026-11', cardCat.id)).toMatchObject({ carryIn: -45000, handling: 'carry' });
    expect(c.uncategorized).toEqual([]);
  });

  it('keeps scheduled transactions whose accounts and categories still exist', () => {
    const { b, s } = oldBudget();
    const nb = freshStart(b, 'Fresh', '2026-10-13');
    // The ISA is kept (it still holds money), so its schedules are too; the old debt category is gone.
    expect(Object.keys(nb.scheduled).sort()).toEqual([s.plain, s.split, s.transfer, s.toClosed, s.splitToClosed, s.inClosed].sort());
    expect(nb.scheduled[s.split]).toEqual(b.scheduled[s.split]);
    expect(nb.scheduled[s.split].splits).not.toBe(b.scheduled[s.split].splits);
  });

  it('makes no Pre-YNAB Debt group when no budget account is in debt', () => {
    const f = standardBudget();
    addTx(f.b, f.checking, '2026-01-01', 1000, INCOME_NOW);
    addTx(f.b, f.mortgage, '2026-01-01', -1000, null);
    const nb = freshStart(f.b, 'Fresh', '2026-10-13');
    expect(Object.values(nb.masters).map((m) => m.name)).toEqual(['Bills', 'Everyday']);
  });
});
