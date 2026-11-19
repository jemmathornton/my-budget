// The merchant inside a bank text (1.3). Made-up texts in the style of each bank's format.
import { describe, expect, it } from 'vitest';
import { amountBand, guessClues, memoIsForeign, mergeKey, merchantOf } from '../../src/model/merchant';

describe('merchantOf', () => {
  it.each([
    // [bank text, key, kind]
    ['DIRECT DEBIT PAYMENT TO ACME ENERGY REF 1234567, MANDATE NO 12, 56.78', 'acme energy', 'dd'],
    ['STANDING ORDER VIA FASTER PAYMENT TO JANE Q SMITH REFERENCE RENT , MANDATE NO 3, 500.00', 'jane smith', 'so'],
    ['BILL PAYMENT VIA FASTER PAYMENT TO BOB JONES REFERENCE TICKETS , MANDATE NO 0, 20.00', 'bob jones', 'fpo'],
    ['FASTER PAYMENTS RECEIPT REF.SALARY FROM WIDGET CO LTD, 1,234.56', 'widget', 'fpi'],
    ['BANK GIRO CREDIT REF COUNCIL REFUND, 12.00', 'council refund', 'bgc'],
    ['INTEREST PAID AFTER TAX 0.00 DEDUCTED, 0.42', 'interest paid', 'interest'],
    ['3 DIRECT DEBIT PAYMENTS AT 1,00% CASHBACK, 1.23', 'direct debit', 'cashback'],
    ['CARD PAYMENT TO CORNER CAFE ON 12-01-2026, 4.20', 'corner cafe', 'card'],
    ['TRANSFER FROM J SMITH', 'smith', 'tfr'],
    ['Bank credit WIDGET CO', 'widget', 'credit'],
    ['Credit 12 Jan 2026', 'credit', 'credit'],
    ['ATM Withdrawal BIG BANK HIGH ST', 'atm withdrawal', 'atm'],
    ['TESCO STORES 1234 SOMETOWN GB GOOGLE 5678', 'tesco stores', 'card'],
    ['Corner Bakery, Sometown', 'corner bakery', 'card'],
    ['GREEN GROCER         SOMETOWN', 'green grocer', 'card'],
    ['PAYPAL *ACMEGAMES', 'acmegames', 'card'],
    ['SQ *THE COFFEE CART', 'coffee cart', 'card'],
    ['AMZN Mktp UK*AB12CD34E', 'amazon mktp', 'card'],
    ['UBER *EATS', 'uber eats', 'card'],
    ['WWW.EXAMPLESHOP.CO.UK', 'exampleshop', 'card'],
  ])('%s -> %s (%s)', (text, key, kind) => {
    const m = merchantOf(text);
    expect(m.key).toBe(key);
    expect(m.kind).toBe(kind);
  });

  it('keeps an account-number line whole', () => {
    expect(merchantOf('123456 12345678 Withdrawal').key).toBe('acct 12345612345678');
  });

  it('spots foreign spending in the text or the memo, and the country of a card line', () => {
    expect(merchantOf('Petit Cafe, Paris7.50 EURO FRANCE').foreign).toBe(true);
    expect(merchantOf('Petit Cafe, Paris7.50 EURO FRANCE').key).toBe('petit cafe');
    expect(merchantOf('BOULANGERIE 43.990000 EUR at 1.13905').foreign).toBe(true);
    expect(merchantOf('Shop', '1234/ 9.99 U.S. DOLLAR USA').foreign).toBe(true);
    expect(merchantOf('Shop', 'Foreign Spend Amount: 10.00 EUROS').foreign).toBe(true);
    expect(merchantOf('Shop', '1234/ 9.99 POUND STERLING UNITED KINGDOM').foreign).toBe(false);
    expect(merchantOf('BAR TABAC LYON FR').country).toBe('FR');
    expect(merchantOf('TESCO STORES 1234 SOMETOWN GB').country).toBe('GB');
    expect(memoIsForeign(undefined)).toBe(false);
  });
});

describe('mergeKey', () => {
  it('never joins lines with no name or only a processor', () => {
    expect(mergeKey(merchantOf('Credit 12 Jan 2026'), 'a')).toBeNull();
    expect(mergeKey(merchantOf('ATM Withdrawal BIG BANK'), 'a')).toBeNull();
    expect(mergeKey(merchantOf('PAYPAL'), 'a')).toBeNull();
    expect(mergeKey(merchantOf('Petit Cafe, Paris'), 'a')).toBe('petit cafe');
  });

  it('needs the whole name for person-to-person lines', () => {
    const k = mergeKey(merchantOf('STANDING ORDER VIA FASTER PAYMENT TO JANE Q SMITH REFERENCE RENT , MANDATE NO 3, 500.00'), 'a');
    expect(k).toBe('person:jane smith');
    expect(mergeKey(merchantOf('TRANSFER FROM JANE SMITH'), 'a')).toBe('person:jane smith');
    expect(mergeKey(merchantOf('TRANSFER FROM JANE SMITH'), 'a')).not.toBe(mergeKey(merchantOf('TRANSFER FROM JOHN SMITH'), 'a'));
  });

  it("keeps the bank's own lines to one account", () => {
    expect(mergeKey(merchantOf('INTEREST PAID AFTER TAX 0.00 DEDUCTED, 0.42'), 'acc1')).toBe('bank:interest:acc1');
  });
});

describe('clues for the word model', () => {
  it('has the words, the kind, foreign and country, the account and an amount band', () => {
    expect(guessClues(merchantOf('BAR TABAC LYON FR'), 'acc1', -1250)).toEqual([
      'bar',
      'tabac',
      'lyon',
      'kind:card',
      'cc:fr',
      'account:acc1',
      'amt:out:4',
    ]);
    expect(amountBand(50)).toBe('amt:in:0');
    expect(amountBand(-100)).toBe('amt:out:1');
  });
});
