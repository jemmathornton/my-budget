// The 1.3 import guesser: remembered bank texts, merchant keys, the word model, tiers, and
// learning only from approved rows. Made-up bank texts.
import { describe, expect, it } from 'vitest';
import { newBudget } from '../../src/model/budget';
import { GuessIndex, guessIndex, payeeKey, tierOf } from '../../src/model/guess';
import { merchantOf, textKey } from '../../src/model/merchant';
import { addAccount, approveTransactions, ensurePayee, saveTransaction } from '../../src/model/ops';
import type { Budget, Id } from '../../src/model/types';

function setup() {
  const b = newBudget('Test', true);
  const current = addAccount(b, { name: 'Current', type: 'Checking', onBudget: true }, 100_000, '2026-01-01');
  const cat = (name: string) => Object.values(b.categories).find((c) => c.name === name)!.id;
  return { b, current, groceries: cat('Groceries'), household: cat('Household Goods'), fun: cat('Spending Money'), water: cat('Water') };
}

let n = 0;
/** An imported transaction: bank text `text`, payee named after it unless `payee` is given. */
function imported(b: Budget, accountId: Id, date: string, text: string, amount: number, categoryId: Id | null, extra: { payee?: string; accepted?: boolean } = {}) {
  return saveTransaction(b, {
    accountId,
    date,
    payeeName: extra.payee ?? text,
    amount,
    categoryId,
    cleared: 'C',
    importedPayee: text,
    importIds: ['YNAB:test:' + ++n],
    accepted: extra.accepted ?? true,
  });
}

const facts = (accountId: Id, text: string, amount: number) => ({ accountId, amount, textKey: textKey(text, amount), merchant: merchantOf(text) });

describe('tiers', () => {
  it('is confident for all of 3+ or 80% of 5+, otherwise suggested; words are always suggested', () => {
    expect(tierOf('payee', { uses: 3, of: 3 })).toBe('confident');
    expect(tierOf('payee', { uses: 2, of: 2 })).toBe('suggested');
    expect(tierOf('text', { uses: 4, of: 5 })).toBe('confident');
    expect(tierOf('merchant', { uses: 3, of: 4 })).toBe('suggested');
    expect(tierOf('words', { uses: 9, of: 9 })).toBe('suggested');
  });
});

describe('the guess cascade', () => {
  it("uses a recognised payee's history first", () => {
    const { b, current, water } = setup();
    for (const m of ['01', '02', '03']) imported(b, current, `2026-${m}-05`, 'DIRECT DEBIT PAYMENT TO RIVER WATER REF 1, MANDATE NO 1', -3500, water, { payee: 'River Water' });
    const p = ensurePayee(b, 'River Water')!;
    const g = guessIndex(b).guess(facts(current, 'anything', -3500), payeeKey(p))!;
    expect(g).toMatchObject({ categoryId: water, source: 'payee', tier: 'confident', reason: 'all of the last 3' });
  });

  it('then the same bank text, with the row’s own amount taken off', () => {
    const { b, current, household } = setup();
    imported(b, current, '2026-01-05', 'DIRECT DEBIT PAYMENT TO ACME ENERGY REF 9, MANDATE NO 2, 56.78', -5678, household, { payee: 'Acme' });
    imported(b, current, '2026-02-05', 'DIRECT DEBIT PAYMENT TO ACME ENERGY REF 9, MANDATE NO 2, 61.00', -6100, household, { payee: 'Acme' });
    const text = 'DIRECT DEBIT PAYMENT TO ACME ENERGY REF 9, MANDATE NO 2, 70.10GBP';
    const g = guessIndex(b).guess(facts(current, text, -7010))!;
    expect(g).toMatchObject({ categoryId: household, source: 'text', tier: 'suggested', reason: 'same bank text as 2 earlier' });
  });

  it('then the merchant, only with at least 60% of its pool', () => {
    const { b, current, groceries, household } = setup();
    imported(b, current, '2026-01-02', 'TESCO STORES 1111 TOWNA GB', -1000, groceries);
    imported(b, current, '2026-01-09', 'TESCO STORES 2222 TOWNB GB', -2000, groceries);
    imported(b, current, '2026-01-16', 'TESCO STORES 3333 TOWNC GB', -3000, household);
    const g = guessIndex(b).guess(facts(current, 'TESCO STORES 4444 TOWND GB', -999))!;
    expect(g).toMatchObject({ categoryId: groceries, source: 'merchant', uses: 2, of: 3, reason: '2 of 3 like "tesco stores"' });
    expect(g.alternatives).toEqual([household]);
    // 2 of 4 is under 60%: no merchant guess (the word model may still have a go).
    imported(b, current, '2026-01-23', 'TESCO STORES 5555 TOWNE GB', -4000, household);
    const g2 = guessIndex(b).guess(facts(current, 'TESCO STORES 6666 TOWNF GB', -999));
    expect(g2?.source).not.toBe('merchant');
  });

  it('then the words, always as a suggestion, and never without a known clue', () => {
    const { b, current, fun } = setup();
    for (let i = 1; i <= 8; i++) imported(b, current, `2026-0${1 + (i % 8)}-1${i % 9}`, `CORNER CAFE NUMBER${i}`, -400 - i, fun, { payee: 'Cafe ' + i });
    for (let i = 1; i <= 3; i++) imported(b, current, `2026-02-0${i}`, `VILLAGE CAFE OUTLET${i}`, -350, fun, { payee: 'Village ' + i });
    const idx = guessIndex(b, '2026-10-01');
    const g = idx.guess(facts(current, 'HARBOUR CAFE ESPRESSO', -420))!;
    expect(g).toMatchObject({ categoryId: fun, source: 'words', tier: 'suggested' });
    expect(g.reason).toMatch(/^words: /);
    // Nothing it has seen: no guess.
    const other = new GuessIndex(b);
    expect(other.guess(facts(current, 'ZZZ QQQ', -1))).toBeNull();
  });
});

describe('learning', () => {
  it('ignores unapproved rows until they are approved', () => {
    const { b, current, groceries } = setup();
    const ids = ['01', '02', '03'].map((m) => imported(b, current, `2026-${m}-02`, 'GREEN GROCER SOMETOWN', -900, groceries, { accepted: false }));
    expect(guessIndex(b).guess(facts(current, 'GREEN GROCER SOMETOWN', -900))).toBeNull();
    approveTransactions(b, ids);
    // approveTransactions changes the transactions in place here; the count is the same, so
    // a fresh object (as the app's store makes) is what refreshes the index.
    b.transactions = { ...b.transactions };
    expect(guessIndex(b).guess(facts(current, 'GREEN GROCER SOMETOWN', -900))?.categoryId).toBe(groceries);
  });

  it('notices a transaction added in place', () => {
    const { b, current, groceries } = setup();
    expect(guessIndex(b).guess(facts(current, 'MARKET STALL', -500))).toBeNull();
    imported(b, current, '2026-03-02', 'MARKET STALL', -500, groceries);
    expect(guessIndex(b).guess(facts(current, 'MARKET STALL', -500))?.categoryId).toBe(groceries);
  });
});

describe('payee proposals', () => {
  it('offers the payee of the same bank text, then of the same merchant, never for nameless lines', () => {
    const { b, current, groceries } = setup();
    imported(b, current, '2026-01-02', 'TESCO STORES 1111 TOWNA GB', -1000, groceries, { payee: 'Tesco' });
    imported(b, current, '2026-01-03', 'Credit 03 Jan 2026', 5000, null, { payee: 'Mystery money' });
    const idx = guessIndex(b);
    const tesco = ensurePayee(b, 'Tesco');
    expect(idx.proposePayee(facts(current, 'TESCO STORES 1111 TOWNA GB', -1))).toEqual({ payeeId: tesco, via: 'text' });
    expect(idx.proposePayee(facts(current, 'TESCO STORES 9999 TOWNZ GB', -1))).toEqual({ payeeId: tesco, via: 'merchant' });
    expect(idx.proposePayee(facts(current, 'Credit 09 Feb 2026', 5000))).toBeNull();
  });
});
