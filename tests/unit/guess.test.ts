import { describe, expect, it } from 'vitest';
import { newBudget } from '../../src/model/budget';
import { describeGuess, guessCategory, payeeKey, transferKey } from '../../src/model/guess';
import { planImport } from '../../src/import/match';
import { addAccount, ensurePayee, saveTransaction } from '../../src/model/ops';
import type { Budget, Id } from '../../src/model/types';

function setup() {
  const b = newBudget('Test', true);
  const current = addAccount(b, { name: 'Current', type: 'Checking', onBudget: true }, 100_000, '2026-01-01');
  const pension = addAccount(b, { name: 'Pension', type: 'InvestmentAccount', onBudget: false }, 0, '2026-01-01');
  const cat = (name: string) => Object.values(b.categories).find((c) => c.name === name)!.id;
  return { b, current, pension, groceries: cat('Groceries'), household: cat('Household Goods'), water: cat('Water'), fun: cat('Spending Money') };
}

function spend(b: Budget, accountId: Id, date: string, payee: string, amount: number, categoryId: Id | null) {
  return saveTransaction(b, { accountId, date, payeeName: payee, amount, categoryId, cleared: 'C' });
}

describe('guessCategory', () => {
  it("uses the payee's history even when YNAB4 left its remembered category blank", () => {
    const { b, current, water } = setup();
    for (const m of ['01', '02', '03']) spend(b, current, `2026-${m}-05`, 'Thames Water', -3500, water);
    const p = ensurePayee(b, 'Thames Water')!;
    b.payees[p].autoCategoryId = null; // as imported from YNAB4
    expect(guessCategory(b, payeeKey(p), -3500)).toEqual({ categoryId: water, uses: 3, of: 3 });
  });

  it('picks the most used category among recent transactions, a tie going to the most recent', () => {
    const { b, current, groceries, household } = setup();
    spend(b, current, '2026-01-01', 'Tesco', -1000, groceries);
    spend(b, current, '2026-01-08', 'Tesco', -2000, household);
    spend(b, current, '2026-01-15', 'Tesco', -1500, groceries);
    const p = ensurePayee(b, 'Tesco')!;
    expect(guessCategory(b, payeeKey(p), -999)?.categoryId).toBe(groceries);
    spend(b, current, '2026-01-22', 'Tesco', -1700, household);
    // 2 each: the most recent wins.
    expect(guessCategory(b, payeeKey(p), -999)?.categoryId).toBe(household);
  });

  it('prefers past transactions with the same amount', () => {
    const { b, current, groceries, fun } = setup();
    for (let i = 1; i <= 5; i++) spend(b, current, `2026-0${i}-01`, 'Amazon', -1234 * i, groceries);
    spend(b, current, '2026-06-01', 'Amazon', -799, fun);
    const p = ensurePayee(b, 'Amazon')!;
    expect(guessCategory(b, payeeKey(p), -799)?.categoryId).toBe(fun);
    expect(guessCategory(b, payeeKey(p), -5000)?.categoryId).toBe(groceries);
  });

  it('only learns from the last 10 and can look back from a date', () => {
    const { b, current, groceries, household } = setup();
    for (let i = 1; i <= 12; i++) spend(b, current, `2025-${String(i).padStart(2, '0')}-01`, 'Shop', -100 * i, groceries);
    for (let i = 1; i <= 6; i++) spend(b, current, `2026-0${i}-01`, 'Shop', -100 * i - 7, household);
    const p = ensurePayee(b, 'Shop')!;
    expect(guessCategory(b, payeeKey(p), -1)).toMatchObject({ categoryId: household, uses: 6, of: 10 });
    expect(guessCategory(b, payeeKey(p), -1, '2026-01-01')).toMatchObject({ categoryId: groceries, uses: 10, of: 10 });
    expect(guessCategory(b, payeeKey(p), -1, '2025-01-01')).toBeNull();
  });

  it('guesses categories for transfers to tracking accounts', () => {
    const { b, current, pension, fun } = setup();
    saveTransaction(b, { accountId: current, date: '2026-02-01', transferAccountId: pension, amount: -50_000, categoryId: fun, cleared: 'C' });
    expect(guessCategory(b, transferKey(pension), -50_000)?.categoryId).toBe(fun);
  });

  it('describes guesses for the import review', () => {
    expect(describeGuess({ categoryId: 'x', uses: 1, of: 1 })).toBe('used last time');
    expect(describeGuess({ categoryId: 'x', uses: 4, of: 4 })).toBe('all of the last 4');
    expect(describeGuess({ categoryId: 'x', uses: 8, of: 10 })).toBe('8 of the last 10');
  });
});

describe('planImport category guesses', () => {
  it('fills in the category for an exact payee match with no remembered category', () => {
    const { b, current, water } = setup();
    for (const m of ['01', '02']) spend(b, current, `2026-${m}-05`, 'THAMES WATER', -3500, water);
    b.payees[ensurePayee(b, 'THAMES WATER')!].autoCategoryId = null;
    const [row] = planImport(b, current, [{ date: '2026-03-05', amount: -3500, payee: 'THAMES WATER', memo: '' }]);
    expect(row).toMatchObject({ kind: 'new', categoryId: water, categoryHint: 'all of the last 2' });
  });

  it('does not suggest a category for an off-budget account', () => {
    const { b, current, pension, water } = setup();
    spend(b, current, '2026-01-05', 'Fund fee', -100, water);
    const [row] = planImport(b, pension, [{ date: '2026-03-05', amount: -100, payee: 'Fund fee', memo: '' }]);
    expect(row.payeeName).toBe('Fund fee');
    expect(row.categoryId).toBeUndefined();
  });
});
