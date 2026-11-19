// Import checks added in 1.1.3: amounts that look reversed, CSV layouts that changed, strict
// amounts and dates. All made-up rows.
import { describe, expect, it } from 'vitest';
import {
  csvHeader,
  csvMappingFits,
  decodeBankFileBytes,
  guessCsvMapping,
  guessDelimiter,
  parseCsv,
  parseOfx,
  parseQif,
  reverseAmounts,
  splitCsv,
  type BankTxn,
} from '../../src/import/bank';
import { planImport, signWarning } from '../../src/import/match';
import { parseBudgetFile, serializeBudget, newBudget } from '../../src/model/budget';
import { isISODate, makeDate, monthRange, parseDateInput } from '../../src/model/dates';
import { compute } from '../../src/model/engine';
import { parseBankAmount } from '../../src/model/money';
import { addTx, standardBudget } from './fixtures';

const mapped = (text: string) => {
  const d = guessDelimiter(text);
  return guessCsvMapping(splitCsv(text, d), d);
};
const row = (date: string, amount: number, extra: Partial<BankTxn> = {}): BankTxn => ({ date, amount, payee: 'SHOP', memo: '', ...extra });

describe('CSV amount columns', () => {
  it('reads a lone "Outflow" column (Barclays Online Banking) as money out, and a negative one as a refund', () => {
    const text = '﻿Date,Account/Card No,Outflow,Subcategory,Memo\n01/09/2026,************1234,12.34,Shopping,SHOP ONE\n02/09/2026,************1234,5.00,Food,CAFE\n03/09/2026,************1234,-5.00,Refund,SHOP ONE\n';
    const m = mapped(text);
    expect(m).toMatchObject({ amountMode: 'single', amountCol: 2, invert: true });
    expect(parseCsv(text, m).txns.map((t) => t.amount)).toEqual([-1234, -500, 500]);
  });

  it('reads a lone "Paid in" column as money in', () => {
    const text = 'Date,Description,Paid in\n01/09/2026,SALARY,1000.00\n02/09/2026,INTEREST,1.23\n';
    const m = mapped(text);
    expect(parseCsv(text, m).txns.map((t) => t.amount)).toEqual([100000, 123]);
  });

  it('reads the old headerless Barclaycard layout: money in and out in separate columns', () => {
    const text = [
      '01 Sep 26,"SHOP ONE        LONDON",Visa,A N OTHER,Shopping,,12.34',
      '02 Sep 26,"PAYMENT, THANK YOU",Visa,A N OTHER,Payment,-50.00,',
      '03 Sep 26,"CAFE",Visa,A N OTHER,Food,,30.00',
      '04 Sep 26,"BOOKSHOP",Visa,A N OTHER,Shopping,,2.50',
    ].join('\n');
    const m = mapped(text);
    // Most rows are spending, so the fuller column is money out.
    expect(m).toMatchObject({ hasHeader: false, amountMode: 'split', outflowCol: 6, inflowCol: 5 });
    const p = parseCsv(text, m);
    expect(p.txns.map((t) => [t.date, t.amount])).toEqual([
      ['2026-09-01', -1234],
      ['2026-09-02', 5000],
      ['2026-09-03', -3000],
      ['2026-09-04', -250],
    ]);
  });

  it("doesn't take a \"Value date\" or a balance column as the amount", () => {
    const text = 'Date,Value Date,Description,Amount,Balance\n01/09/2026,02/09/2026,SHOP,-12.34,100.00\n02/09/2026,03/09/2026,CAFE,-5.00,95.00\n';
    expect(mapped(text).amountCol).toBe(3);
  });

  it('finds semicolon and tab separators', () => {
    for (const sep of [';', '\t']) {
      const text = ['Date', 'Description', 'Amount'].join(sep) + '\n' + ['01/09/2026', 'SHOP', '-12,34'].join(sep) + '\n';
      expect(parseCsv(text, mapped(text)).txns).toHaveLength(1);
    }
  });

  it('keeps a quote in the middle of a cell as text', () => {
    const text = 'Date,Description,Amount\n01/09/2026,ACME 12" TV,-99.00\n02/09/2026,CAFE,-4.00\n03/09/2026,SHOP,-1.00\n';
    const p = parseCsv(text, mapped(text));
    expect(p.txns.map((t) => [t.payee, t.amount])).toEqual([
      ['ACME 12" TV', -9900],
      ['CAFE', -400],
      ['SHOP', -100],
    ]);
  });
});

describe('remembered CSV layouts', () => {
  const v1 = 'Date,Description,Amount\n01/09/2026,SHOP,-12.34\n';
  const v2 = 'Date,Type,Description,Amount\n01/09/2026,POS,CORNER SHOP 4471,-12.34\n';

  it('fits a file with the same header, and not one whose columns changed', () => {
    const m = { ...mapped(v1), header: csvHeader(v1, mapped(v1)) };
    expect(m.header).toEqual(['date', 'description', 'amount']);
    expect(csvMappingFits(v1, m)).toBe(true);
    expect(csvMappingFits(v2, m)).toBe(false);
  });

  it('checks a layout remembered before headers were saved against a fresh look', () => {
    const old = mapped(v1);
    expect(csvMappingFits(v1, old)).toBe(true);
    expect(csvMappingFits(v2, old)).toBe(false);
  });
});

describe('more file shapes', () => {
  it('reads CSV dates written year first with slashes or dots', () => {
    for (const date of ['2026/01/15', '2026.01.15', '2026.1.15']) {
      const text = `Date,Description,Amount\n${date},SHOP,-1.00\n02/01/2026,CAFE,-2.00\n`;
      expect(parseCsv(text, mapped(text)).txns[0].date).toBe('2026-01-15');
    }
  });

  it('reads a two-column CSV (date and amount)', () => {
    const text = 'Date,Amount\n01/09/2026,-12.34\n02/09/2026,5.00\n';
    expect(parseCsv(text, mapped(text)).txns.map((t) => [t.date, t.amount])).toEqual([
      ['2026-09-01', -1234],
      ['2026-09-02', 500],
    ]);
  });

  it('decodes a mostly UTF-8 file with one Windows-1252 line, line by line', () => {
    const enc = new TextEncoder();
    const utf8Line = enc.encode('01/09/2026,CAFÉ,-1.00\n');
    const cp1252Line = new Uint8Array([...enc.encode('02/09/2026,TAXI '), 0xa3, ...enc.encode('5,-5.00\n')]);
    const text = decodeBankFileBytes(new Uint8Array([...enc.encode('Date,Description,Amount\n'), ...utf8Line, ...cp1252Line]));
    expect(text).toContain('CAFÉ');
    expect(text).toContain('TAXI £5');
  });

  it('reads OFX values on the line after their tag, and CDATA names', () => {
    const ofx = [
      '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>',
      '<STMTTRN>',
      '  <TRNTYPE>',
      '    DEBIT',
      '  </TRNTYPE>',
      '  <DTPOSTED>',
      '    20260115120000',
      '  </DTPOSTED>',
      '  <TRNAMT>',
      '    -12.34',
      '  </TRNAMT>',
      '  <FITID>A1</FITID>',
      '  <NAME><![CDATA[CORNER & SHOP]]></NAME>',
      '  <MEMO>CARD&nbsp;PAYMENT</MEMO>',
      '</STMTTRN>',
      '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    ].join('\n');
    const [t] = parseOfx(ofx).txns;
    expect(t).toMatchObject({ date: '2026-01-15', amount: -1234, fitid: 'A1', payee: 'CORNER & SHOP', memo: 'CARD PAYMENT' });
  });
});

describe('QIF', () => {
  it('reads a record that is missing its "^", and says so', () => {
    const p = parseQif('!Type:Bank\nD01/09/2026\nT-1.00\nPONE\nD02/09/2026\nT-2.00\nPTWO\n^\n');
    expect(p.txns.map((t) => t.payee)).toEqual(['ONE', 'TWO']);
    expect(p.warnings).toHaveLength(1);
  });

  it('reads old Mac line ends and indented lines', () => {
    expect(parseQif('!Type:Bank\r D01/09/2026\r T-1.00\r PONE\r^\r').txns).toHaveLength(1);
  });

  it('skips investment sections with a warning', () => {
    const p = parseQif('!Type:Invst\nD01/09/2026\nNBuy\nYSHARES\nT100.00\n^\n!Type:Bank\nD02/09/2026\nT-2.00\nPTWO\n^\n');
    expect(p.txns.map((t) => t.payee)).toEqual(['TWO']);
    expect(p.warnings.join()).toMatch(/investment/);
  });

  it("doesn't take a date in the cheque number field (Amex) as a cheque number", () => {
    const p = parseQif('!Type:CCard\nD15/01/2024\nN20240115\nT-1.00\nPSHOP\n^\nD16/01/2024\nN123\nT-2.00\nPCHEQUE\n^\n');
    expect(p.txns.map((t) => t.check)).toEqual([undefined, '123']);
  });
});

describe('reversed amounts', () => {
  it('reverses amounts and the balance, keeping the file amount for import ids', () => {
    const r = reverseAmounts({ kind: 'ofx', txns: [row('2026-09-01', 1234)], warnings: [], balance: 5000 });
    expect(r.txns[0]).toMatchObject({ amount: -1234, fileAmount: 1234 });
    expect(r.balance).toBe(-5000);
  });

  it('still recognises transactions imported before the reversal', () => {
    const { b, card } = standardBudget();
    // Imported by YNAB4 from the bank's (reversed) file, and fixed by hand afterwards.
    addTx(b, card, '2026-09-01', -1234, null, { importIds: ['YNAB:12.34:2026-09-01:1'] });
    const [r] = planImport(b, card, reverseAmounts({ kind: 'qif', txns: [row('2026-09-01', 1234)], warnings: [] }).txns);
    expect(r.kind).toBe('duplicate');
  });

  it('warns when most rows on a card are money in', () => {
    const { b, card, checking } = standardBudget();
    const txns = [1, 2, 3, 4, 5].map((i) => row(`2026-09-0${i}`, 100 * i));
    expect(signWarning(b, card, txns)).toMatch(/wrong way round/);
    expect(signWarning(b, checking, txns)).toBeNull();
    expect(signWarning(b, card, txns.slice(0, 4))).toBeNull();
  });

  it('warns when a card payment comes in as spending (1.5.3)', () => {
    const { b, card, checking } = standardBudget();
    const spending = [1, 2, 3, 4, 5].map((i) => row(`2026-09-0${i}`, -100 * i));
    expect(signWarning(b, card, [...spending, row('2026-09-06', -25000, { payee: 'PAYMENT, THANK YOU' })])).toMatch(/card payment comes in as spending/);
    expect(signWarning(b, card, [...spending, row('2026-09-06', -25000, { payee: 'DIRECT DEBIT PAYMENT' })])).toMatch(/card payment/);
    // Money in, as it should be; a shop called "… PAYMENTS"; and not on a current account.
    expect(signWarning(b, card, [...spending, row('2026-09-06', 25000, { payee: 'PAYMENT, THANK YOU' })])).toBeNull();
    expect(signWarning(b, card, [...spending, row('2026-09-06', -999, { payee: 'AMAZON PAYMENTS' })])).toBeNull();
    expect(signWarning(b, checking, [...spending, row('2026-09-06', -25000, { payee: 'PAYMENT, THANK YOU' })])).toBeNull();
  });

  it('warns when rows match the register only with the opposite sign', () => {
    const { b, checking } = standardBudget();
    for (let i = 1; i <= 4; i++) addTx(b, checking, `2026-09-0${i}`, -100 * i, null);
    const txns = [1, 2, 3, 4, 5].map((i) => row(`2026-09-0${i}`, 100 * i));
    expect(signWarning(b, checking, txns)).toMatch(/opposite sign/);
  });
});

describe('bank ids that are reused', () => {
  it('treats a row as new when its bank id belonged to a transaction with a different date and amount', () => {
    const { b, checking } = standardBudget();
    addTx(b, checking, '2026-01-05', -1234, null, { importIds: ['FITID:1', 'YNAB:-12.34:2026-01-05:1'] });
    const [r] = planImport(b, checking, [row('2026-02-05', -4500, { fitid: '1' })]);
    expect(r).toMatchObject({ kind: 'new', include: true, reusedBankId: true });
  });

  it('still recognises a transaction whose date or amount was changed after importing', () => {
    const { b, checking } = standardBudget();
    // Imported as -12.34 on 5 Jan, then both edited by hand: the stored id keeps the bank's values.
    addTx(b, checking, '2026-01-09', -999, null, { importIds: ['FITID:1', 'YNAB:-12.34:2026-01-05:1'] });
    expect(planImport(b, checking, [row('2026-01-05', -1234, { fitid: '1' })])[0].kind).toBe('duplicate');
    // Same id, same amount, new date (a bank re-dating a pending row): still the same transaction.
    expect(planImport(b, checking, [row('2026-01-07', -1234, { fitid: '1' })])[0].kind).toBe('duplicate');
  });

  it('keeps the plain rule for transactions with only a bank id (some from YNAB4)', () => {
    const { b, checking } = standardBudget();
    addTx(b, checking, '2026-01-05', -1234, null, { importIds: ['FITID:1'] });
    expect(planImport(b, checking, [row('2026-02-05', -4500, { fitid: '1' })])[0].kind).toBe('duplicate');
  });
});

describe('strict bank amounts', () => {
  it.each([
    ['DR 12.34', -1234],
    ['−12.34', -1234],
    ['–12.34', -1234],
    ['-£5.00', -500],
    ['£1,234.56', 123456],
    ['12.00 GBP', 1200],
    ['.50', 50],
    ['1 234.56', 123456],
  ])('%s -> %s', (text, expected) => {
    expect(parseBankAmount(text)).toBe(expected);
  });

  it.each(['REF 4471', '16/01/2026', '12.34.56', '1.5E+03', 'CORNER SHOP 4471', '99999999999999999999', '1,23,456'])(
    'refuses %s',
    (text) => {
      expect(parseBankAmount(text)).toBeNull();
    },
  );

  it('reads a space as a thousands mark in comma-decimal amounts', () => {
    expect(parseBankAmount('1 234,56', true)).toBe(123456);
  });
});

describe('dates', () => {
  it('refuses years outside 1900 to 2100', () => {
    expect(makeDate(20266, 10, 13)).toBeNull();
    expect(makeDate(1026, 10, 13)).toBeNull();
    expect(makeDate(2026, 10, 13)).toBe('2026-10-13');
    expect(parseDateInput('13/10/20266')).toBeNull();
    expect(isISODate('2026-02-30')).toBe(false);
    expect(isISODate('undefined')).toBe(false);
  });

  it("doesn't loop on a month that isn't a month", () => {
    expect(monthRange('2026-01', 'undefined')).toEqual([]);
    expect(monthRange('2026-01', '2026-03')).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('refuses to open a budget with an impossible transaction date, with a clear message', () => {
    const b = newBudget('Damaged', false);
    b.accounts.a = { id: 'a', name: 'A', type: 'Checking', onBudget: true, closed: false, sort: 0 };
    b.transactions.t = { id: 't', accountId: 'a', date: 'undefined', amount: -100, categoryId: null, cleared: 'U', accepted: true };
    expect(() => parseBudgetFile(serializeBudget(b))).toThrow(/damaged.*"undefined"/);
  });

  it('ignores budget entries for a month key that is not a month', () => {
    const b = newBudget('Odd', true);
    const cat = Object.keys(b.categories)[0];
    b.months['not-a-month'] = { [cat]: { budgeted: 100 } };
    const c = compute(parseBudgetFile(serializeBudget(b)));
    expect(c.months.every((m) => /^\d{4}-\d\d$/.test(m))).toBe(true);
  });
});
