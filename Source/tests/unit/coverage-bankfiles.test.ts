// Extra coverage for reading bank files (November 2026 test review). Made-up files only.
import { describe, expect, it } from 'vitest';
import { decodeBankFileBytes, guessCsvMapping, guessDelimiter, parseCsv, parseOfx, parseQif, splitCsv } from '../../src/import/bank';

/** Reads CSV text the way the import does when nothing was remembered for the account. */
function readCsv(text: string) {
  const mapping = guessCsvMapping(splitCsv(text), guessDelimiter(text));
  return { mapping, ...parseCsv(text, mapping) };
}

describe('QIF date orders', () => {
  it('reads year-first dates whatever the default order', () => {
    const p = parseQif('!Type:Bank\nD2026/01/02\nT-1.00\n^\nD2026/02/01\nT-2.00\n^\n', 'MDY');
    expect(p.dateOrderUsed).toBe('YMD');
    expect(p.txns.map((t) => t.date)).toEqual(['2026-01-02', '2026-02-01']);
  });

  it('settles the whole file from one date that can only be day first', () => {
    const p = parseQif('!Type:Bank\nD05/06/2026\nT-1.00\n^\nD13/06/2026\nT-2.00\n^\n', 'MDY');
    expect(p.dateOrderUsed).toBe('DMY');
    expect(p.txns.map((t) => t.date)).toEqual(['2026-06-05', '2026-06-13']);
  });

  it('falls back to the default when dates disagree, and skips the one that can’t be read that way', () => {
    const p = parseQif('!Type:Bank\nD13/01/2026\nT-1.00\n^\nD01/14/2026\nT-2.00\n^\n', 'DMY');
    expect(p.dateOrderUsed).toBe('DMY');
    expect(p.txns.map((t) => t.date)).toEqual(['2026-01-13']);
    expect(p.warnings.some((w) => w.includes('01/14/2026'))).toBe(true);
  });

  it('reads two-digit years before 70 as 20xx and from 70 as 19xx', () => {
    const p = parseQif('!Type:Bank\nD01/13/69\nT-1.00\n^\nD01/13/70\nT-2.00\n^\n');
    expect(p.txns.map((t) => t.date)).toEqual(['2069-01-13', '1970-01-13']);
  });

  it("reads Quicken's apostrophe year with a space after it", () => {
    const p = parseQif("!Type:Bank\nD1/13' 4\nT-1.00\n^\n");
    expect(p.txns[0].date).toBe('2004-01-13');
  });
});

describe('QIF fields', () => {
  it('uses the U amount when there is no T, and reads thousands commas', () => {
    const p = parseQif('!Type:Bank\nD13/01/2026\nU-1,234.56\nPRENT\n^\n');
    expect(p.txns[0]).toMatchObject({ amount: -123456, payee: 'RENT' });
  });

  it('marks X, * and R as cleared, and nothing else', () => {
    const recs = ['X', '*', 'R', 'c', ''].map((c, i) => `D1${i}/01/2026\nT-1.00\n${c ? 'C' + c + '\n' : ''}^`).join('\n');
    const p = parseQif('!Type:Bank\n' + recs + '\n');
    expect(p.txns.map((t) => t.cleared)).toEqual([true, true, true, undefined, undefined]);
  });

  it('reads CRLF files with blank lines between records', () => {
    const p = parseQif('!Type:Bank\r\n\r\nD13/01/2026\r\nT-1.00\r\nPONE\r\n^\r\n\r\n\r\nD14/01/2026\r\nT2.00\r\nPTWO\r\n^\r\n');
    expect(p.txns.map((t) => [t.date, t.amount, t.payee])).toEqual([
      ['2026-01-13', -100, 'ONE'],
      ['2026-01-14', 200, 'TWO'],
    ]);
    expect(p.warnings).toEqual([]);
  });

  it('drops a record with neither a date nor an amount without a warning', () => {
    const p = parseQif('!Type:Bank\nPJUST A NAME\n^\nD13/01/2026\nT-1.00\n^\n');
    expect(p.txns).toHaveLength(1);
    expect(p.warnings).toEqual([]);
  });

  it('keeps a numeric cheque number but not a word in the N field', () => {
    const p = parseQif('!Type:Bank\nD13/01/2026\nT-1.00\nN001234\n^\nD14/01/2026\nT-1.00\nNTXFR\n^\n');
    expect(p.txns.map((t) => t.check)).toEqual(['001234', undefined]);
  });
});

describe('OFX odd shapes', () => {
  const wrap = (body: string) => `OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>${body}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  it('uses DTUSER when DTPOSTED is missing', () => {
    const p = parseOfx(wrap('<STMTTRN><TRNAMT>-5.00<DTUSER>20260114<NAME>CAFE</STMTTRN>'));
    expect(p.txns[0]).toMatchObject({ date: '2026-01-14', amount: -500, payee: 'CAFE' });
  });

  it('skips a transaction without an amount, or with an impossible date, with a warning each', () => {
    const p = parseOfx(wrap('<STMTTRN><DTPOSTED>20260114<NAME>NO AMOUNT</STMTTRN><STMTTRN><DTPOSTED>20260230<TRNAMT>-1.00</STMTTRN><STMTTRN><DTPOSTED>20260115<TRNAMT>+2.50<NAME>OK</STMTTRN>'));
    expect(p.txns).toEqual([{ date: '2026-01-15', amount: 250, payee: 'OK', memo: '' }]);
    expect(p.warnings).toHaveLength(2);
  });

  it('leaves the memo blank when it only repeats the name', () => {
    const p = parseOfx(wrap('<STMTTRN><DTPOSTED>20260114<TRNAMT>-1.00<NAME>BAKERY<MEMO>BAKERY</STMTTRN>'));
    expect(p.txns[0]).toMatchObject({ payee: 'BAKERY', memo: '' });
  });

  it('reads lower-case tags, XML closing tags on the same line and a time with a zone', () => {
    const p = parseOfx(wrap('<stmttrn><dtposted>20260114093000.000[-5:EST]</dtposted><trnamt>-7.25</trnamt><fitid>abc-1</fitid><name>KIOSK</name></stmttrn>'));
    expect(p.txns[0]).toEqual({ date: '2026-01-14', amount: -725, payee: 'KIOSK', memo: '', fitid: 'abc-1' });
  });

  it('decodes entities and &nbsp; in names, but keeps CDATA text as it is', () => {
    const p = parseOfx(
      wrap('<STMTTRN><DTPOSTED>20260114<TRNAMT>-1.00<NAME>M&amp;S&nbsp;FOOD &#163;</STMTTRN><STMTTRN><DTPOSTED>20260114<TRNAMT>-2.00<NAME><![CDATA[A&amp;B <C>]]></STMTTRN>'),
    );
    expect(p.txns.map((t) => t.payee)).toEqual(['M&S FOOD £', 'A&amp;B <C>']);
  });

  it('reads a negative ledger balance with its date, and has no account key without an account block', () => {
    const p = parseOfx(wrap('') + '<LEDGERBAL><BALAMT>-1234.50<DTASOF>20260131120000</LEDGERBAL>');
    expect(p).toMatchObject({ balance: -123450, balanceDate: '2026-01-31' });
    expect(p.accountKey).toBeUndefined();
  });
});

describe('CSV edge cases', () => {
  it('reads payees and amounts with commas inside quotes', () => {
    const { txns } = readCsv('Date,Description,Amount\n13/01/2026,"SMITH, J & CO, LTD","-1,234.56"\n');
    expect(txns).toEqual([{ date: '2026-01-13', amount: -123456, payee: 'SMITH, J & CO, LTD', memo: '' }]);
  });

  it('reads a file with a byte order mark, blank lines and a line of empty cells', () => {
    const bytes = new TextEncoder().encode('﻿Date,Description,Amount\r\n\r\n13/01/2026,ONE,-1.00\r\n,,\r\n\r\n14/01/2026,TWO,2.00\r\n');
    const { mapping, txns, warnings } = readCsv(decodeBankFileBytes(bytes));
    expect(mapping).toMatchObject({ hasHeader: true, dateCol: 0, payeeCol: 1, amountCol: 2 });
    expect(txns.map((t) => [t.date, t.amount, t.payee])).toEqual([
      ['2026-01-13', -100, 'ONE'],
      ['2026-01-14', 200, 'TWO'],
    ]);
    expect(warnings).toEqual([]);
  });

  it('keeps a BOM from upsetting the first column when the text is passed in undecoded', () => {
    const { mapping, txns } = readCsv('﻿Date,Description,Amount\n13/01/2026,ONE,-1.00\n');
    expect(mapping.dateCol).toBe(0);
    expect(txns).toHaveLength(1);
  });

  it('reads signed amounts in every style in one column', () => {
    const { txns } = readCsv('Date,Description,Amount\n01/02/2026,A,-12.00\n02/02/2026,B,+3.00\n03/02/2026,C,12.00 DR\n04/02/2026,D,(5.00)\n05/02/2026,E,7.50 CR\n06/02/2026,F,£-1.25\n');
    expect(txns.map((t) => t.amount)).toEqual([-1200, 300, -1200, -500, 750, -125]);
  });

  it('skips a row whose amount is not an amount, with a warning, and keeps the rest', () => {
    const { txns, warnings } = readCsv('Date,Description,Amount\n01/02/2026,A,-12.00\n02/02/2026,B,REF 4471\n03/02/2026,C,1.00\n');
    expect(txns.map((t) => t.payee)).toEqual(['A', 'C']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('REF 4471');
  });

  it('takes the bank reference from a "Transaction ID" column, and a type column for the sign check', () => {
    const { txns } = readCsv('Date,Description,Type,Amount,Transaction ID\n01/02/2026,CARD CO,Payment,50.00,T-001\n');
    expect(txns[0]).toMatchObject({ fitid: 'T-001', amount: 5000 });
  });

  it('turns a zero in a money-out column into 0, not -0', () => {
    const { txns } = readCsv('Date,Description,Outflow\n01/02/2026,FREE,0.00\n02/02/2026,REFUND,-3.00\n');
    expect(Object.is(txns[0].amount, 0)).toBe(true);
    expect(txns[1].amount).toBe(300);
  });

  it('keeps a quoted cell with a line break in it as one row', () => {
    const rows = splitCsv('Date,Description,Amount\n01/02/2026,"TWO\nLINES",-1.00\n');
    expect(rows).toHaveLength(2);
    expect(rows[1][1]).toBe('TWO\nLINES');
  });

  // guessDelimiter used to count commas inside quoted cells too, so a semicolon file with
  // comma-heavy descriptions was split on commas (fixed in 1.5.11).
  it('finds the semicolon in a file whose descriptions are full of commas', () => {
    const text = 'Date;Description;Amount\n01/02/2026;"SHOP, HIGH ST, TOWN, UK";-1,50\n02/02/2026;"CAFE, STATION, TOWN";-2,00\n';
    expect(guessDelimiter(text)).toBe(';');
  });
});
