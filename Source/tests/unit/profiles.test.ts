// Bank profiles and clean-up (1.3). Made-up file snippets in each bank's layout.
import { describe, expect, it } from 'vitest';
import { parseCsv, parseOfx, parseQif, guessCsvMapping, splitCsv, type BankTxn } from '../../src/import/bank';
import { cleanTxn, detectProfile } from '../../src/import/profiles';
import { textKey } from '../../src/model/merchant';

const qif = (type: string, rows: string[][]) => ['!Type:' + type, ...rows.flatMap((r) => [...r, '^'])].join('\n');
const facts = (fileName: string, text: string, parsed: ReturnType<typeof parseQif>) => ({ fileName, text, parsed });

describe('detecting the bank', () => {
  it('knows each bank from its file, and falls back to the account’s, then generic', () => {
    const sant = qif('Oth L', [
      ['D01/10/2026', 'T-12.34', 'PCARD PAYMENT TO SHOP ON 01-10-2026, 12.34'],
      ['D02/10/2026', 'T-5.00', 'PDIRECT DEBIT PAYMENT TO ACME REF 1, MANDATE NO 2, 5.00'],
    ]);
    expect(detectProfile(facts('download.qif', sant, parseQif(sant)))).toBe('santander');
    const bcard = qif('CCard', [
      ['D01/10/2026', 'T-9.99', 'P Corner Shop, Town ', 'M1234/ Corner Shop, Town'],
      ['D02/10/2026', 'T-1.00', 'P Cafe ', 'M1234/ Cafe'],
    ]);
    expect(detectProfile(facts('x.qif', bcard, parseQif(bcard)))).toBe('barclaycard');
    const ofx = '<OFX><BANKACCTFROM><BANKID>0<ACCTID>****12345</BANKACCTFROM><STMTTRN><DTPOSTED>20261001<TRNAMT>-1.00<NAME>SHOP</STMTTRN></OFX>';
    expect(detectProfile(facts('x.ofx', ofx, parseOfx(ofx)))).toBe('nationwide');
    const amex = '<OFX><FI><ORG>AMEX</ORG></FI><CCACCTFROM><ACCTID>ab|12345</CCACCTFROM><STMTTRN><DTPOSTED>20261001<TRNAMT>-1.00<NAME>SHOP</STMTTRN></OFX>';
    expect(detectProfile(facts('activity.qfx', amex, parseOfx(amex)))).toBe('amex');
    const csv = '﻿Date,Account/Card No,Outflow,Subcategory,Memo\n01/10/2026,************1234,9.99,Shopping,CORNER SHOP           CORNER SHOP TOWN\n';
    const rows = splitCsv(csv);
    expect(detectProfile(facts('Transactions - 2026.csv', csv, parseCsv(csv, guessCsvMapping(rows))))).toBe('barclays-csv');
    const halifax = qif('CCard', [['D01/10/2026', 'T9.99', 'PCORNER SHOP          ']]);
    expect(detectProfile(facts('1234567812345678_20261001_1200.qif', halifax, parseQif(halifax)))).toBe('halifax');
    const plain = qif('Bank', [['D01/10/2026', 'T-1.00', 'PSHOP']]);
    expect(detectProfile(facts('x.qif', plain, parseQif(plain)))).toBe('generic');
    expect(detectProfile(facts('x.qif', plain, parseQif(plain)), 'santander')).toBe('santander');
  });
});

const row = (payee: string, amount: number, memo = ''): BankTxn => ({ date: '2026-10-01', amount, payee, memo });

describe('tidying rows', () => {
  it('takes only the row’s own amount off the end (with or without GBP), for any bank', () => {
    expect(cleanTxn(row('DIRECT DEBIT PAYMENT TO ACME REF 1, MANDATE NO 2, 12.34', -1234), 'generic').displayPayee).toBe(
      'DIRECT DEBIT PAYMENT TO ACME REF 1, MANDATE NO 2',
    );
    expect(cleanTxn(row('DIRECT DEBIT PAYMENT TO ACME, 12.34GBP', -1234), 'santander').displayPayee).toBe('DIRECT DEBIT PAYMENT TO ACME');
    // A different number is a reference, not the amount: kept.
    expect(cleanTxn(row('PAYMENT TO ACME, 99.00', -1234), 'generic').displayPayee).toBe('PAYMENT TO ACME, 99.00');
    expect(textKey('ACME  \tLTD, 12.34', -1234)).toBe('acme ltd');
  });

  it('tidies Barclaycard memos and moves a foreign amount off the payee', () => {
    expect(cleanTxn(row('Corner Shop, Town', -999, '1234/ Corner Shop, Town'), 'barclaycard').memo).toBe('');
    expect(cleanTxn(row('Shop', -999, 'Visa'), 'barclaycard').memo).toBe('');
    expect(cleanTxn(row('Shop', -999, '1234'), 'barclaycard').memo).toBe('');
    expect(cleanTxn(row('Shop', -999, '1234/ Gift for Sam'), 'barclaycard').memo).toBe('Gift for Sam');
    const f = cleanTxn(row('Petit Cafe, Paris7.50 EURO FRANCE', -650, '1234/ Petit Cafe, Paris7.50 EURO FRANCE'), 'barclaycard');
    expect(f.displayPayee).toBe('Petit Cafe, Paris');
    expect(f.memo).toBe('7.50 EURO FRANCE');
    // The bank's own text is never changed.
    expect(f.payee).toBe('Petit Cafe, Paris7.50 EURO FRANCE');
  });

  it('splits the Barclays CSV memo into the payee and any foreign amount', () => {
    const text = 'CORNER SHOP           CORNER SHOP TOWN\t9.99 U.S. DOLLAR USA';
    const c = cleanTxn(row(text, -800, text), 'barclays-csv');
    expect(c.displayPayee).toBe('CORNER SHOP');
    expect(c.memo).toBe('9.99 U.S. DOLLAR USA');
    expect(cleanTxn(row('CAFE           CAFE TOWN', -100, 'CAFE           CAFE TOWN'), 'barclays-csv').memo).toBe('');
  });

  it('ends a Barclays CSV merchant where its name starts again, and drops cut-off foreign amounts (1.4.4)', () => {
    const clean = (text: string) => cleanTxn(row(text, -800, text), 'barclays-csv');
    // A merchant of 21 characters leaves a single space before the name again.
    expect(clean('FOODHALL DELIVERY SUB Foodhall Delivery, Leeds').displayPayee).toBe('FOODHALL DELIVERY SUB');
    // The bank cuts the foreign amount short; such a memo says nothing.
    expect(clean('CAFE ROMA          Cafe Roma, Milano\t12.3').memo).toBe('');
    expect(clean('CAFE ROMA          Cafe Roma, Milano\t9.05 E').memo).toBe('');
    expect(clean('CAFE ROMA          Cafe Roma, Milano\t9.05 E').displayPayee).toBe('CAFE ROMA');
    // Two spaces inside a name aren't the padding; the name starting again is.
    expect(clean('HTTPS:  SHOP.EXAMPLE.IT Https:  Shop.example.it, Milano').displayPayee).toBe('HTTPS: SHOP.EXAMPLE.IT');
    expect(clean('FERRY  TICKETS ONLINE   Ferry Tickets Online, Town').displayPayee).toBe('FERRY TICKETS ONLINE');
    // The first word must come again as a whole word, not as the start of another.
    expect(clean('THE THEATRE ROYAL     The Theatre Royal, Bath').displayPayee).toBe('THE THEATRE ROYAL');
    expect(clean('SP SPILLER & TAIT   Sp Spiller & Tait, Budleigh').displayPayee).toBe('SP SPILLER & TAIT');
    expect(clean('SP Spiller & Tait, Budleigh Salt').displayPayee).toBe('SP Spiller & Tait, Budleigh Salt');
    // When the name doesn't start again, two spaces before "Name, Town" are the padding.
    expect(clean('WWW.SHOP.CO.UK  Shop Online, Leeds').displayPayee).toBe('WWW.SHOP.CO.UK');
  });

  it('collapses tabs and runs of spaces in memos', () => {
    expect(cleanTxn(row('Shop', -1, 'a\t b    c'), 'generic').memo).toBe('a b c');
  });
});
