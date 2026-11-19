import { describe, expect, it } from 'vitest';
import {
  CSV_DATE_FORMATS,
  decodeBankFileBytes,
  detectBankFileKind,
  guessCsvMapping,
  guessDelimiter,
  normalizeImportId,
  parseCsv,
  parseDateWithFormat,
  parseOfx,
  parseQif,
  splitCsv,
  ynabImportId,
} from '../../src/import/bank';

// All data here is made up.

const lines = (...l: string[]) => l.join('\r\n');

describe('detectBankFileKind', () => {
  it('goes by the file name, then by the content', () => {
    expect(detectBankFileKind('Statement.QIF', '')).toBe('qif');
    expect(detectBankFileKind('download.txt', '\n!Type:Bank\nD01/01/2024')).toBe('qif');
    expect(detectBankFileKind('statement.qfx', '')).toBe('ofx');
    expect(detectBankFileKind('statement.QBO', '')).toBe('ofx');
    expect(detectBankFileKind('download.dat', 'OFXHEADER:100\nDATA:OFXSGML')).toBe('ofx');
    expect(detectBankFileKind('download', '<?xml version="1.0"?><OFX>')).toBe('ofx');
    expect(detectBankFileKind('statement.csv', 'Date,Description,Amount')).toBe('csv');
  });
});

describe('parseQif', () => {
  it('works out DD/MM dates from a day over 12, whatever the default', () => {
    const text = lines(
      '!Type:Bank',
      'D13/01/2024',
      'T-12.50',
      'PCorner Shop',
      'MMilk and bread',
      'N123',
      'CX',
      '^',
      'D02/03/2024',
      'T1,000.00',
      'PEmployer',
      'NTXFR',
      '^',
    );
    expect(parseQif(text, 'MDY')).toEqual({
      kind: 'qif',
      dateOrderUsed: 'DMY',
      warnings: [],
      txns: [
        {
          date: '2024-01-13',
          amount: -1250,
          payee: 'Corner Shop',
          memo: 'Milk and bread',
          check: '123',
          cleared: true,
        },
        { date: '2024-03-02', amount: 100000, payee: 'Employer', memo: '' },
      ],
    });
  });

  it('works out MM/DD dates from a second number over 12', () => {
    const text = lines('!Type:Bank', 'D01/13/2024', 'T-1.00', '^', 'D03/02/2024', 'T-2.00', 'C*', '^');
    const r = parseQif(text, 'DMY');
    expect(r.dateOrderUsed).toBe('MDY');
    expect(r.txns.map((t) => [t.date, t.cleared])).toEqual([
      ['2024-01-13', undefined],
      ['2024-03-02', true],
    ]);
  });

  it('uses the default order when the dates could be either', () => {
    const text = lines('!Type:Bank', 'D02/03/2024', 'T-1.00', '^');
    expect(parseQif(text, 'DMY').txns[0].date).toBe('2024-03-02');
    expect(parseQif(text, 'MDY').txns[0].date).toBe('2024-02-03');
    expect(parseQif(text).dateOrderUsed).toBe('DMY');
  });

  it("reads Quicken's apostrophe years and ISO dates", () => {
    expect(parseQif(lines('!Type:Bank', "D1/ 5'24", 'T-1.00', '^')).txns[0].date).toBe('2024-05-01');
    expect(parseQif(lines('!Type:Bank', "D12/31'99", 'T-1.00', '^')).txns[0].date).toBe('1999-12-31');
    const iso = parseQif(lines('!Type:Bank', 'D2024-01-13', 'T-1.00', '^', 'D2024-02-01', 'T-1.00', '^'));
    expect(iso.dateOrderUsed).toBe('YMD');
    expect(iso.txns.map((t) => t.date)).toEqual(['2024-01-13', '2024-02-01']);
  });

  it('ignores split lines and keeps the first value of each field', () => {
    const text = lines(
      '!Type:CCard',
      'D15/01/2024',
      'T-30.00',
      'PSupermarket',
      'LGroceries',
      'SGroceries',
      '$-20.00',
      'EFood',
      'SHousehold',
      '$-10.00',
      'PSecond payee line',
      '^',
    );
    expect(parseQif(text).txns).toEqual([{ date: '2024-01-15', amount: -3000, payee: 'Supermarket', memo: '' }]);
  });

  it('skips account lists, categories and other non-transaction sections', () => {
    const text = lines(
      '!Option:AutoSwitch',
      '!Account',
      'NCurrent Account',
      'TBank',
      '^',
      'NCredit Card',
      'TCCard',
      '^',
      '!Clear:AutoSwitch',
      '!Account',
      'NCurrent Account',
      'TBank',
      '^',
      '!Type:Bank',
      'D15/01/2024',
      'T-5.00',
      'PCafe',
      '^',
      '!Type:Cat',
      'NFood',
      'DFood and drink',
      'E',
      '^',
      '!Type:Memorized',
      'D16/01/2024',
      'T-9.00',
      'PMemorised',
      '^',
    );
    expect(parseQif(text).txns).toEqual([{ date: '2024-01-15', amount: -500, payee: 'Cafe', memo: '' }]);
  });

  it('reads comma decimals and warns about unreadable records', () => {
    const text = lines('!Type:Bank', 'D15/01/2024', 'T-12,50', '^', 'D99/99/2024', 'T-1.00', 'PBroken', '^');
    const r = parseQif(text);
    expect(r.txns.map((t) => t.amount)).toEqual([-1250]);
    expect(r.warnings).toEqual(['Skipped a record with an unreadable date or amount (99/99/2024 -1.00)']);
  });
});

describe('parseOfx', () => {
  const SGML = lines(
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'SECURITY:NONE',
    'ENCODING:USASCII',
    'CHARSET:1252',
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    '',
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20240201120000<LANGUAGE>ENG</SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1>',
    '<STMTTRNRS>',
    '<TRNUID>1',
    '<STMTRS>',
    '<CURDEF>GBP',
    '<BANKACCTFROM>',
    '<BANKID>123456',
    '<ACCTID>12345678',
    '<ACCTTYPE>CHECKING',
    '</BANKACCTFROM>',
    '<BANKTRANLIST>',
    '<DTSTART>20240101',
    '<DTEND>20240131',
    '<STMTTRN>',
    '<TRNTYPE>DEBIT',
    '<DTPOSTED>20240115120000[0:GMT]',
    '<TRNAMT>-12.34',
    '<FITID>202401150001',
    '<NAME>CORNER SHOP',
    '<MEMO>CARD 1234',
    '</STMTTRN>',
    '<STMTTRN>',
    '<TRNTYPE>CHECK',
    '<DTPOSTED>20240116',
    '<TRNAMT>-100.00',
    '<FITID>202401160001',
    '<CHECKNUM>000123',
    '<MEMO>CHEQUE 000123',
    '</STMTTRN>',
    '<STMTTRN>',
    '<TRNTYPE>CREDIT',
    '<DTPOSTED>20240125',
    '<TRNAMT>+2000.00',
    '<FITID>202401250001',
    '<NAME>EMPLOYER LTD',
    '<MEMO>EMPLOYER LTD',
    '</STMTTRN>',
    '<STMTTRN>',
    '<TRNTYPE>DEBIT',
    '<DTPOSTED>',
    '<TRNAMT>-1.00',
    '<FITID>NODATE',
    '</STMTTRN>',
    '</BANKTRANLIST>',
    '<LEDGERBAL>',
    '<BALAMT>1234.56',
    '<DTASOF>20240131',
    '</LEDGERBAL>',
    '<AVAILBAL>',
    '<BALAMT>1000.00',
    '<DTASOF>20240131',
    '</AVAILBAL>',
    '</STMTRS>',
    '</STMTTRNRS>',
    '</BANKMSGSRSV1>',
    '</OFX>',
  );

  it('reads SGML files: FITID, payee from NAME or MEMO, cheque numbers, balance and account', () => {
    expect(parseOfx(SGML)).toEqual({
      kind: 'ofx',
      txns: [
        { date: '2024-01-15', amount: -1234, payee: 'CORNER SHOP', memo: 'CARD 1234', fitid: '202401150001' },
        {
          date: '2024-01-16',
          amount: -10000,
          payee: 'CHEQUE 000123',
          memo: '',
          fitid: '202401160001',
          check: '000123',
        },
        // The memo is dropped when it only repeats the payee.
        { date: '2024-01-25', amount: 200000, payee: 'EMPLOYER LTD', memo: '', fitid: '202401250001' },
      ],
      warnings: ['Skipped a transaction with a missing date or amount'],
      accountKey: 'ofx:123456:12345678',
      accountLabel: '123456 …5678',
      balance: 123456,
      balanceDate: '2024-01-31',
    });
  });

  const XML = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <CREDITCARDMSGSRSV1>
    <CCSTMTTRNRS>
      <CCSTMTRS>
        <CURDEF>EUR</CURDEF>
        <CCACCTFROM>
          <ACCTID>4000001234567899</ACCTID>
        </CCACCTFROM>
        <BANKTRANLIST>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE>
            <DTPOSTED>20240201</DTPOSTED>
            <TRNAMT>-25,50</TRNAMT>
            <FITID>X1</FITID>
            <NAME>M&amp;S</NAME>
            <MEMO>Food &amp;lt;hall&amp;gt; &#163;5</MEMO>
          </STMTTRN>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE>
            <DTUSER>20240203</DTUSER>
            <TRNAMT>-1.234,56</TRNAMT>
            <FITID>X2</FITID>
            <NAME>SHORT NAME</NAME>
            <PAYEE><NAME>Full Payee Name Ltd</NAME><ADDR1>1 High Street</ADDR1></PAYEE>
            <MEMO>Ref 99</MEMO>
          </STMTTRN>
        </BANKTRANLIST>
        <LEDGERBAL><BALAMT>-1.260,06</BALAMT><DTASOF>20240205120000</DTASOF></LEDGERBAL>
      </CCSTMTRS>
    </CCSTMTTRNRS>
  </CREDITCARDMSGSRSV1>
</OFX>`;

  it('reads XML files: entities, comma decimals, PAYEE aggregates and card accounts', () => {
    expect(parseOfx(XML)).toEqual({
      kind: 'ofx',
      txns: [
        // "&amp;lt;" is decoded once, to "&lt;", not twice.
        { date: '2024-02-01', amount: -2550, payee: 'M&S', memo: 'Food &lt;hall&gt; £5', fitid: 'X1' },
        // No DTPOSTED, so DTUSER; the <PAYEE> name beats the short <NAME>.
        { date: '2024-02-03', amount: -123456, payee: 'Full Payee Name Ltd', memo: 'Ref 99', fitid: 'X2' },
      ],
      warnings: [],
      accountKey: 'ofx::4000001234567899',
      accountLabel: '…7899',
      balance: -126006,
      balanceDate: '2024-02-05',
    });
  });

  it('rejects impossible dates', () => {
    const text = '<OFX><STMTTRN><DTPOSTED>20241345<TRNAMT>-1.00</STMTTRN></OFX>';
    expect(parseOfx(text).txns).toEqual([]);
    expect(parseOfx(text).warnings).toHaveLength(1);
  });
});

describe('splitCsv and guessDelimiter', () => {
  it('handles quotes, escaped quotes, line breaks in cells, CRLF, a BOM and blank rows', () => {
    const text = String.fromCharCode(0xfeff) + 'a,"b, with comma","say ""hi"""\r\n\r\n , ,\r\n1,"two\nlines", 3 \n';
    expect(splitCsv(text)).toEqual([
      ['a', 'b, with comma', 'say "hi"'],
      ['1', 'two\nlines', '3'],
    ]);
  });

  it('picks the most common delimiter', () => {
    expect(guessDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(guessDelimiter('a;b;c\n1,5;2;3')).toBe(';');
    expect(guessDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(guessDelimiter('a|b|c\n1|2|3')).toBe('|');
    expect(splitCsv('a|b|c\n1|2|3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });
});

describe('CSV import', () => {
  it('finds the header below account details and uses Paid in / Paid out columns', () => {
    const text = lines(
      '"Account Name:","FlexAccount ****1234"',
      '"Account Balance:","£2,218.86"',
      '"Available Balance: ","£2,218.86"',
      '',
      '"Date","Transaction type","Description","Paid out","Paid in","Balance"',
      '"13 Jan 2024","Payment to","CORNER SHOP","£12.50","","£1,222.06"',
      '"14 Jan 2024","Bank credit","EMPLOYER LTD","","£1,000.00","£2,222.06"',
      '"15 Jan 2024","Visa purchase","CAFE, HIGH ST","£3.20","","£2,218.86"',
    );
    const mapping = guessCsvMapping(splitCsv(text), guessDelimiter(text));
    expect(mapping).toEqual({
      delimiter: ',',
      hasHeader: true,
      skipRows: 3,
      dateCol: 0,
      dateFormat: 'auto',
      payeeCol: 2,
      memoCol: 1,
      amountMode: 'split',
      amountCol: -1,
      inflowCol: 4,
      outflowCol: 3,
      invert: false,
      refCol: -1,
    });
    expect(parseCsv(text, mapping)).toEqual({
      kind: 'csv',
      warnings: [],
      txns: [
        { date: '2024-01-13', amount: -1250, payee: 'CORNER SHOP', memo: 'Payment to' },
        { date: '2024-01-14', amount: 100000, payee: 'EMPLOYER LTD', memo: 'Bank credit' },
        { date: '2024-01-15', amount: -320, payee: 'CAFE, HIGH ST', memo: 'Visa purchase' },
      ],
    });
  });

  it('treats paid out as money out whether or not the bank writes it as negative', () => {
    const text = lines(
      'Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance',
      '05/02/2024,DEB,12-34-56,12345678,CORNER SHOP,-4.99,,95.01',
      '06/02/2024,FPI,12-34-56,12345678,EMPLOYER,,250.00,345.01',
    );
    const mapping = guessCsvMapping(splitCsv(text));
    expect(mapping).toMatchObject({
      dateCol: 0,
      payeeCol: 4,
      memoCol: 1,
      amountMode: 'split',
      inflowCol: 6,
      outflowCol: 5,
    });
    expect(parseCsv(text, mapping).txns.map((t) => [t.date, t.amount, t.payee])).toEqual([
      ['2024-02-05', -499, 'CORNER SHOP'],
      ['2024-02-06', 25000, 'EMPLOYER'],
    ]);
  });

  it('reads a single Amount column with quoted amounts and payees containing commas', () => {
    const text = lines(
      'Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP),Transaction ID',
      '01/02/2024,Corner Shop,CARD 1234,CARD,-2.50,97.50,tx_0001',
      '02/02/2024,"Smith, J",RENT,FASTER PAYMENT,"1,234.56","1,332.06",tx_0002',
    );
    const mapping = guessCsvMapping(splitCsv(text));
    expect(mapping).toMatchObject({ amountMode: 'single', amountCol: 4, payeeCol: 1, memoCol: 2, refCol: 6 });
    expect(parseCsv(text, mapping).txns).toEqual([
      { date: '2024-02-01', amount: -250, payee: 'Corner Shop', memo: 'CARD 1234', fitid: 'tx_0001', kind: 'CARD' },
      { date: '2024-02-02', amount: 123456, payee: 'Smith, J', memo: 'RENT', fitid: 'tx_0002', kind: 'FASTER PAYMENT' },
    ]);
  });

  it('works out the columns of a file with no header', () => {
    const text = lines('15/01/2024,Corner Shop,-12.50', '16/01/2024,Employer,"1,000.00"');
    const mapping = guessCsvMapping(splitCsv(text));
    expect(mapping).toMatchObject({ hasHeader: false, skipRows: 0, dateCol: 0, payeeCol: 1, amountCol: 2 });
    expect(parseCsv(text, mapping).txns.map((t) => t.amount)).toEqual([-1250, 100000]);
  });

  it('reads semicolon-delimited files with comma decimals', () => {
    const text = lines(
      'Date;Payee;Memo;Amount',
      '15.01.2024;Bakery;Bread;-3,50',
      '16.01.2024;Employer;Salary;1.234,56',
    );
    const delimiter = guessDelimiter(text);
    expect(delimiter).toBe(';');
    const mapping = guessCsvMapping(splitCsv(text, delimiter), delimiter);
    expect(mapping).toMatchObject({ delimiter: ';', dateCol: 0, payeeCol: 1, memoCol: 2, amountCol: 3 });
    expect(parseCsv(text, mapping).txns).toEqual([
      { date: '2024-01-15', amount: -350, payee: 'Bakery', memo: 'Bread' },
      { date: '2024-01-16', amount: 123456, payee: 'Employer', memo: 'Salary' },
    ]);
  });

  it('applies a chosen date format and sign, and warns about rows it cannot read', () => {
    const text = lines('Posted,Description,Amount', '01/13/2024,Shop,12.50', '01/14/2024,Refund,-2.00', 'Total,,10.50');
    const mapping = { ...guessCsvMapping(splitCsv(text)), dateFormat: 'MM/DD/YYYY', invert: true };
    const r = parseCsv(text, mapping);
    expect(r.txns.map((t) => [t.date, t.amount])).toEqual([
      ['2024-01-13', -1250],
      ['2024-01-14', 200],
    ]);
    expect(r.warnings).toEqual(['Skipped row: Total |  | 10.50']);
  });
});

describe('CSV export round trip (1.5.1)', () => {
  it("takes off the apostrophe that keeps \"-50 from Mum\" from being read as a formula", () => {
    // A tab or carriage return at the start is protected too (1.5.2).
    expect(parseCsv(lines('Date,Payee,Amount', "01/02/2024,'\tTab payee,1.00"), guessCsvMapping(splitCsv(lines('Date,Payee,Amount', "01/02/2024,'\tTab payee,1.00")))).txns[0].payee).toBe('\tTab payee');
    const text = lines('Date,Payee,Memo,Amount', "01/02/2024,'-50 from Mum,'=sum,50.00", "02/02/2024,Bob's,'quoted',1.00");
    const t = parseCsv(text, guessCsvMapping(splitCsv(text))).txns;
    expect(t.map((x) => [x.payee, x.memo])).toEqual([
      ['-50 from Mum', '=sum'],
      ["Bob's", "'quoted'"],
    ]);
  });
});

describe('parseDateWithFormat', () => {
  it('reads each offered format', () => {
    expect(CSV_DATE_FORMATS[0]).toBe('auto');
    const cases: [string, string, string | null][] = [
      ['13/01/2024', 'auto', '2024-01-13'],
      ['13/01/2024', 'DD/MM/YYYY', '2024-01-13'],
      ['01/13/2024', 'MM/DD/YYYY', '2024-01-13'],
      ['2024-01-13', 'YYYY-MM-DD', '2024-01-13'],
      ['2024-01-13T10:22:00', 'YYYY-MM-DD', '2024-01-13'],
      ['13-01-2024', 'DD-MM-YYYY', '2024-01-13'],
      ['13.01.2024 10:22', 'DD.MM.YYYY', '2024-01-13'],
      ['13/01/24', 'DD/MM/YY', '2024-01-13'],
      ['01/13/24', 'MM/DD/YY', '2024-01-13'],
      ['5 Jan 2024', 'D MMM YYYY', '2024-01-05'],
      ['05 September 2024', 'DD MMM YYYY', '2024-09-05'],
      ['20240113', 'YYYYMMDD', '2024-01-13'],
    ];
    for (const [text, format, want] of cases)
      expect([text, format, parseDateWithFormat(text, format)]).toEqual([text, format, want]);
  });

  it('falls back to a loose reading, and rejects impossible dates', () => {
    expect(parseDateWithFormat('2024-01-13', 'DD/MM/YYYY')).toBe('2024-01-13');
    expect(parseDateWithFormat('31/02/2024', 'DD/MM/YYYY')).toBeNull();
    expect(parseDateWithFormat('  ', 'auto')).toBeNull();
  });
});

describe('decodeBankFileBytes', () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

  it('reads Windows-1252 when the bytes are not UTF-8', () => {
    // "Café £10 €5" in Windows-1252.
    const text = decodeBankFileBytes(bytes(...ascii('Caf'), 0xe9, 0x20, 0xa3, ...ascii('10 '), 0x80, 0x35));
    expect(text).toBe('Café £10 €5');
  });

  it('matches the standard Windows-1252 decoder for every byte', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(decodeBankFileBytes(all)).toBe(new TextDecoder('windows-1252').decode(all));
  });

  it('reads UTF-8, removing a byte order mark', () => {
    expect(decodeBankFileBytes(bytes(0xef, 0xbb, 0xbf, ...ascii('Date,'), 0xc2, 0xa3))).toBe('Date,£');
    expect(decodeBankFileBytes(new TextEncoder().encode('Plain £5'))).toBe('Plain £5');
  });

  it('reads UTF-16 with a byte order mark', () => {
    expect(decodeBankFileBytes(bytes(0xff, 0xfe, 0x41, 0x00, 0xa3, 0x00))).toBe('A£');
  });
});

describe('import ids', () => {
  it('formats YNAB4-style ids like YNAB4 did', () => {
    expect(ynabImportId({ amount: -123456, date: '2024-01-05' }, 1)).toBe('YNAB:-1,234.56:2024-01-05:1');
    expect(ynabImportId({ amount: 5, date: '2024-01-05' }, 2)).toBe('YNAB:0.05:2024-01-05:2');
    expect(ynabImportId({ amount: -5, date: '2024-01-05' }, 1)).toBe('YNAB:-0.05:2024-01-05:1');
    expect(ynabImportId({ amount: 0, date: '2024-01-05' }, 1)).toBe('YNAB:0.00:2024-01-05:1');
    for (const amount of [1, -99, 100, 99999, -100000, 123456789, -100000000]) {
      const want = (amount / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      expect(ynabImportId({ amount, date: '2024-01-05' }, 1)).toBe(`YNAB:${want}:2024-01-05:1`);
    }
  });

  it('compares YNAB-style ids without thousands commas', () => {
    expect(normalizeImportId('YNAB:-1,234.56:2024-01-05:1')).toBe('YNAB:-1234.56:2024-01-05:1');
    expect(normalizeImportId('FITID:1,234')).toBe('FITID:1,234');
  });
});
