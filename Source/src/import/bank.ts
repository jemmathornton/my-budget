import { makeDate, MONTH_SHORT, pad2, parseLooseDate } from '../model/dates';
import { parseBankAmount } from '../model/money';
import type { CsvMapping, ISODate, Money } from '../model/types';

// Readers for files downloaded from a bank: QIF, OFX/QFX/QBO (SGML and XML) and CSV.
// Each returns the transactions it could read, plus a warning for every record it skipped.

/** One transaction as read from a bank file. Amounts are pence, inflows positive. */
export interface BankTxn {
  date: ISODate;
  amount: Money;
  payee: string;
  memo: string;
  /** The bank's own transaction id (OFX FITID, or a CSV "transaction id" column). */
  fitid?: string;
  check?: string;
  /** Set when a QIF file marks the transaction as cleared or reconciled. */
  cleared?: boolean;
  /** The amount as written in the file, when the amounts were reversed. Import ids use this. */
  fileAmount?: Money;
  /** The bank's own word for the row ("Purchase", "Payment"), from a CSV type column. Only the sign check reads it. */
  kind?: string;
}

/** The order of day, month and year in numeric dates. */
export type DateOrder = 'DMY' | 'MDY' | 'YMD';

export type BankFileKind = 'qif' | 'ofx' | 'csv';

export interface ParsedBankFile {
  kind: BankFileKind;
  txns: BankTxn[];
  warnings: string[];
  /** OFX only: "ofx:<bank id>:<account id>", remembered on the account to pick it next time. */
  accountKey?: string;
  /** OFX only: a short label such as "123456 …5678". */
  accountLabel?: string;
  /** OFX only: the ledger balance the bank reported, and its date. */
  balance?: Money;
  balanceDate?: ISODate;
  /** QIF only: the date order that was used. */
  dateOrderUsed?: DateOrder;
}

// ---- Text and amounts -------------------------------------------------------

// Windows-1252 differs from Latin-1 only in bytes 0x80-0x9F. The five unused bytes keep
// their Latin-1 meaning, as browsers' TextDecoder does.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d,
  0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d,
  0x017e, 0x0178,
];

/** Removes a byte order mark (U+FEFF) from the start of the text. */
const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * Turns the bytes of a bank file into text. UTF-8 is tried first (a byte order mark is
 * removed). If the bytes are not valid UTF-8 they are read as Windows-1252, which is what
 * UK bank CSVs with a "£" in them usually are.
 */
export function decodeBankFileBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  try {
    return stripBom(utf8.decode(bytes));
  } catch {
    // Not all UTF-8: decide line by line, so one Windows-1252 "£" doesn't garble the rest of
    // a UTF-8 file ("CAFÉ" turning into "CAFÃ‰").
    const cp1252 = (part: Uint8Array) => {
      const chars: string[] = [];
      for (const b of part) chars.push(String.fromCharCode(b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80] : b));
      return chars.join('');
    };
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i <= bytes.length; i++) {
      if (i < bytes.length && bytes[i] !== 0x0a) continue;
      const line = bytes.subarray(start, i);
      try {
        lines.push(utf8.decode(line));
      } catch {
        lines.push(cp1252(line));
      }
      start = i + 1;
    }
    return stripBom(lines.join('\n'));
  }
}

/**
 * True when "," is the decimal mark: "12,50", "-1.234,56", "£12,50". UK-style "1,234" and
 * "1,234.56" are not, because a thousands group always has three digits.
 */
function isCommaDecimal(text: string): boolean {
  return /^\D*(\d+|\d{1,3}(\.\d{3})+),\d{1,2}\D*$/.test(text.trim());
}

/** Reads a bank amount, working out the decimal mark from the text itself. */
function readAmount(text: string): Money | null {
  return parseBankAmount(text, isCommaDecimal(text));
}

// ---- File type --------------------------------------------------------------

/** Works out the file type from its name, or failing that from its first few lines. */
export function detectBankFileKind(fileName: string, text: string): BankFileKind {
  const name = fileName.toLowerCase();
  if (name.endsWith('.qif') || /^\s*!Type:/im.test(text.slice(0, 500))) return 'qif';
  if (/\.(ofx|qfx|qbo)$/.test(name) || /<OFX>|OFXHEADER/i.test(text.slice(0, 2000))) return 'ofx';
  return 'csv';
}

// ---- QIF --------------------------------------------------------------------

/** QIF dates come in many styles: "13/01/2024", "1/13'24", "2024-01-13". */
function dateParts(text: string): string[] {
  return text
    .replace(/'/g, '/')
    .split(/[/.\-\s]+/)
    .filter(Boolean);
}

/**
 * Guesses the date order from all the dates in a file: a first number over 12 means
 * day first, a second number over 12 means month first. If nothing decides it, `fallback`.
 */
function guessDateOrder(dates: string[], fallback: DateOrder): DateOrder {
  let dmy = 0;
  let mdy = 0;
  let ymd = 0;
  for (const text of dates) {
    const parts = dateParts(text);
    if (parts.length < 3) continue;
    if (parts[0].length === 4) {
      ymd++;
      continue;
    }
    const a = +parts[0];
    const b = +parts[1];
    if (a > 12 && b <= 12) dmy++;
    if (b > 12 && a <= 12) mdy++;
  }
  if (ymd > dmy && ymd > mdy) return 'YMD';
  if (dmy && !mdy) return 'DMY';
  if (mdy && !dmy) return 'MDY';
  return fallback;
}

/** Reads a QIF date in the given order. Two-digit years before 70 are 20xx, others 19xx. */
function parseQifDate(text: string, order: DateOrder): ISODate | null {
  const parts = text.trim().replace(/'\s*/g, '/').replace(/\s+/g, '').split(/[/.-]/).filter(Boolean);
  if (parts.length !== 3) return parseLooseDate(text);
  const n = parts.map(Number);
  let y: number, m: number, d: number;
  if (order === 'YMD' || parts[0].length === 4) [y, m, d] = n;
  else if (order === 'MDY') [m, d, y] = n;
  else [d, m, y] = n;
  if (y < 100) y += y < 70 ? 2000 : 1900;
  return makeDate(y, m, d);
}

const QIF_TXN_SECTION = /!type:(bank|ccard|cash|oth a|oth l)/;
const QIF_OTHER_SECTIONS = ['!option', '!account', '!type:cat', '!type:class', '!type:memorized'];

/** Splits a QIF file into records (field letter -> value), keeping only transaction sections. */
function readQifRecords(text: string, warnings: string[]): Record<string, string>[] {
  const records: Record<string, string>[] = [];
  let record: Record<string, string> = {};
  let inTxns = true;
  let investments = false;
  const flush = () => {
    if (inTxns && Object.keys(record).length) records.push(record);
    record = {};
  };
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('!')) {
      // A new section ends a record that is missing its "^".
      if (Object.keys(record).length) {
        if (inTxns) warnings.push('A record was not closed with "^" before a new section; it was read anyway.');
        flush();
      }
      // Account lists, categories, classes and memorised transactions are not transactions.
      const header = line.toLowerCase();
      inTxns = QIF_TXN_SECTION.test(header) || !QIF_OTHER_SECTIONS.some((s) => header.startsWith(s));
      if (header.startsWith('!account')) inTxns = false;
      // Investment records (buys, sells, dividends) can't be read as ordinary transactions.
      if (header.startsWith('!type:invst')) {
        inTxns = false;
        if (!investments) warnings.push('Skipped an investment section: those records are not supported.');
        investments = true;
      }
      continue;
    }
    if (line === '^') {
      flush();
      continue;
    }
    const code = line[0];
    // A second date in one record means the "^" between two records is missing.
    if (code === 'D' && 'D' in record) {
      if (inTxns) warnings.push(`A record was not closed with "^" (before the one dated ${line.slice(1).trim()}); both were read.`);
      flush();
    }
    // S, E and $ are split lines; only the first value of each field is kept.
    if (code === 'S' || code === 'E' || code === '$' || code in record) continue;
    record[code] = line.slice(1).trim();
  }
  flush();
  return records;
}

/** True when a cheque-number field is just the transaction's date (20240115 or 15012024). */
function isSameDate(n: string, date: ISODate): boolean {
  const [y, m, d] = date.split('-');
  return n === y + m + d || n === d + m + y;
}

/** Reads a QIF file. `defaultOrder` is used when the dates themselves don't show the order. */
export function parseQif(text: string, defaultOrder: DateOrder = 'DMY'): ParsedBankFile {
  const warnings: string[] = [];
  const records = readQifRecords(text, warnings);
  const order = guessDateOrder(
    records.map((r) => r.D || ''),
    defaultOrder,
  );
  const txns: BankTxn[] = [];
  for (const r of records) {
    const date = parseQifDate(r.D || '', order);
    const amount = readAmount(r.T ?? r.U ?? '');
    if (!date || amount === null) {
      if (r.D || r.T) warnings.push(`Skipped a record with an unreadable date or amount (${r.D ?? ''} ${r.T ?? ''})`);
      continue;
    }
    const txn: BankTxn = { date, amount, payee: (r.P || '').trim(), memo: (r.M || '').trim() };
    // Some banks (Amex) put the date in the cheque number field: that isn't a cheque number.
    if (r.N && /^\d+$/.test(r.N) && !isSameDate(r.N, date)) txn.check = r.N;
    if (r.C === 'X' || r.C === '*' || r.C === 'R') txn.cleared = true;
    txns.push(txn);
  }
  return { kind: 'qif', txns, warnings, dateOrderUsed: order };
}

// ---- OFX --------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (whole, name: string) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * The value of the first <TAG> in `block`. Works for SGML (no closing tags) and XML, including
 * a value on the line after its tag (pretty-printed XML) and a <![CDATA[...]]> value.
 */
function ofxTag(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<\\r\\n]*))`, 'i').exec(block);
  if (!m) return undefined;
  return m[1] !== undefined ? m[1].trim() : decodeEntities(m[2].trim()).replace(/&nbsp;/gi, ' ');
}

/** OFX dates start "YYYYMMDD" and may carry a time and zone: "20240115120000[0:GMT]". */
function ofxDate(text: string | undefined): ISODate | null {
  const m = text ? /^(\d{4})(\d{2})(\d{2})/.exec(text.trim()) : null;
  return m ? makeDate(+m[1], +m[2], +m[3]) : null;
}

function readOfxTxn(block: string): BankTxn | null {
  const date = ofxDate(ofxTag(block, 'DTPOSTED')) || ofxDate(ofxTag(block, 'DTUSER'));
  const amountText = ofxTag(block, 'TRNAMT');
  const amount = amountText !== undefined ? readAmount(amountText) : null;
  if (!date || amount === null) return null;
  // The payee is <NAME>, or <NAME> inside a <PAYEE> aggregate; failing both, <MEMO>.
  // The memo is left blank when it just repeats the payee.
  const name = ofxTag(block, 'NAME') || '';
  const payeeName = /<PAYEE>/i.test(block) ? ofxTag(block.split(/<PAYEE>/i)[1], 'NAME') : undefined;
  const memo = ofxTag(block, 'MEMO') || '';
  const payee = payeeName || name;
  const txn: BankTxn = {
    date,
    amount,
    payee: (payee || memo).trim(),
    memo: payee && memo !== payee ? memo.trim() : '',
  };
  const fitid = ofxTag(block, 'FITID');
  if (fitid) txn.fitid = fitid;
  const check = ofxTag(block, 'CHECKNUM');
  if (check) txn.check = check;
  return txn;
}

/** Reads an OFX, QFX or QBO file, in either the older SGML style or XML. */
export function parseOfx(text: string): ParsedBankFile {
  const warnings: string[] = [];
  const txns: BankTxn[] = [];
  for (const chunk of text.split(/<STMTTRN>/i).slice(1)) {
    const txn = readOfxTxn(chunk.split(/<\/STMTTRN>/i)[0]);
    if (txn) txns.push(txn);
    else warnings.push('Skipped a transaction with a missing date or amount');
  }
  const out: ParsedBankFile = { kind: 'ofx', txns, warnings };

  const acct = /<(BANKACCTFROM|CCACCTFROM)>([\s\S]*?)(<\/\1>|<BANKTRANLIST>|<STMTTRN>)/i.exec(text);
  if (acct) {
    const bankId = ofxTag(acct[2], 'BANKID') || '';
    const acctId = ofxTag(acct[2], 'ACCTID') || '';
    out.accountKey = `ofx:${bankId}:${acctId}`;
    out.accountLabel = (bankId ? bankId + ' ' : '') + (acctId ? '…' + acctId.slice(-4) : '');
  }

  const ledger = /<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|$)/i.exec(text);
  if (ledger) {
    const bal = ofxTag(ledger[1], 'BALAMT');
    const balance = bal ? readAmount(bal) : null;
    if (balance !== null) out.balance = balance;
    const asOf = ofxDate(ofxTag(ledger[1], 'DTASOF'));
    if (asOf) out.balanceDate = asOf;
  }
  return out;
}

// ---- CSV --------------------------------------------------------------------

/** Picks the delimiter that appears most often in the first 10 lines: , ; tab or |. */
export function guessDelimiter(text: string): string {
  const head = text.split(/\r?\n/).slice(0, 10).join('\n');
  // Quoted cells don't count: "SHOP, HIGH ST, TOWN" in a semicolon file isn't three commas (1.5.11).
  const bare = head.replace(/"(?:[^"]|"")*"/g, '');
  const counts = [',', ';', '\t', '|'].map((d) => [d, bare.split(d).length] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][0];
}

/**
 * Splits CSV text into rows of trimmed cells. Handles quoted cells (with "" for a quote,
 * and delimiters or line breaks inside). Blank rows are dropped.
 */
export function splitCsv(text: string, delimiter?: string): string[][] {
  const s = stripBom(text);
  const delim = delimiter || guessDelimiter(s);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    cell = '';
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (s[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && cell.trim() === '') quoted = true;
    // A quote in the middle of a cell (ACME 12" TV) is just text, as spreadsheet programs read it.
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      endRow();
    } else cell += ch;
  }
  endRow();
  return rows.map((r) => r.map((c) => c.trim()));
}

const includesAny = (text: string, ...words: string[]) => words.some((w) => text.includes(w));

/** A cell that starts like a date: "13/01/2024", "2024-01-13", "13 Jan 2024". */
const looksLikeDate = (cell: string) => /^\s*\d{1,4}[/.\-\s]([A-Za-z]{3,9}|\d{1,2})[/.\-\s]\d{2,4}/.test(cell || '');

/**
 * Finds the header row. UK banks often put a few lines (account name, balance) above it,
 * so the first of the top 20 rows that has 3+ cells, mentions a date and holds no dates is
 * taken. Failing that, the row just above the first data row, if it looks like a header.
 */
function findHeader(rows: string[][]): { headerRow: number; firstRow: number } {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = rows[i].map((c) => c.toLowerCase());
    const filled = cells.filter((c) => c).length;
    // Usually 3+ columns; a two-column file ("Date,Amount") counts if it names an amount too.
    const enough = filled >= 3 || (filled === 2 && cells.some((c) => /amount|value|paid|debit|credit/.test(c)));
    if (enough && cells.some((c) => /\bdate\b|posted/.test(c)) && !cells.some(looksLikeDate)) {
      return { headerRow: i, firstRow: i };
    }
  }
  let first = rows.findIndex((r) => r.length >= 3 && r.some(looksLikeDate));
  if (first < 0) first = 0;
  const prev = rows[first - 1];
  const isHeader =
    !!prev && prev.length === rows[first].length && prev.some((c) => /[a-z]/i.test(c)) && !prev.some(looksLikeDate);
  return { headerRow: isHeader ? first - 1 : -1, firstRow: first };
}

/** Fills in the columns that can be recognised from the header text. */
function mapHeaderColumns(mapping: CsvMapping, header: string[]): void {
  const find = (test: (h: string) => boolean, exclude: number[] = []) =>
    header.findIndex((h, i) => !exclude.includes(i) && test(h));

  mapping.dateCol = find((h) => /\bdate\b/.test(h) && !/value date/.test(h));
  if (mapping.dateCol < 0) mapping.dateCol = find((h) => includesAny(h, 'date', 'posted'));

  // "Payee" beats "Name" beats "Description"..., but not "Account name", "Payee ID" and so on.
  const notPayee = (h: string) =>
    /\b(id|number|no\.?|type|code|sort|account)\b/.test(h) || includesAny(h, 'balance', 'category', 'currency');
  for (const word of [
    'payee',
    'merchant',
    'name',
    'counter party',
    'counterparty',
    'description',
    'narrative',
    'details',
  ]) {
    const col = find((h) => h.includes(word) && !notPayee(h), [mapping.dateCol]);
    if (col >= 0) {
      mapping.payeeCol = col;
      break;
    }
  }
  mapping.memoCol = find(
    (h) => includesAny(h, 'memo', 'notes', 'reference', 'transaction type', 'type'),
    [mapping.dateCol, mapping.payeeCol],
  );
  // "Credit card" and "debit card" columns are not money in or out.
  mapping.inflowCol = find(
    (h) => includesAny(h, 'paid in', 'credit', 'money in', 'inflow', 'deposit') && !h.includes('card'),
  );
  mapping.outflowCol = find(
    (h) => includesAny(h, 'paid out', 'debit', 'money out', 'outflow', 'withdrawal') && !h.includes('card'),
  );
  mapping.amountCol = find(
    (h) =>
      includesAny(h, 'amount', 'value') &&
      // "Value date" is a date, and a balance isn't the transaction's amount.
      !includesAny(h, 'local', 'original', 'debit', 'credit', 'paid', 'money in', 'money out', 'date', 'balance'),
  );
  mapping.refCol = find((h) => includesAny(h, 'transaction id', 'fitid', 'unique id'));
}

/** Fills in whatever the header didn't settle by looking at the first 20 data rows. */
function mapColumnsFromData(mapping: CsvMapping, sample: string[][]): void {
  const width = Math.max(0, ...sample.map((r) => r.length));
  if (mapping.dateCol < 0) {
    for (let c = 0; c < width; c++) {
      if (sample.length && sample.every((r) => !r[c] || parseLooseDate(r[c]))) {
        mapping.dateCol = c;
        break;
      }
    }
  }
  if (
    mapping.inflowCol >= 0 &&
    mapping.outflowCol >= 0 &&
    mapping.inflowCol !== mapping.outflowCol &&
    mapping.amountCol < 0
  ) {
    mapping.amountMode = 'split';
  } else if (mapping.amountCol < 0 && mapping.outflowCol >= 0 && mapping.inflowCol < 0) {
    // Only a money-out column (e.g. Barclays' "Outflow"): its numbers are money out, so a refund
    // written as a negative number comes in as money in. (Split mode would make it spending.)
    mapping.amountCol = mapping.outflowCol;
    mapping.invert = true;
  } else if (mapping.amountCol < 0 && mapping.inflowCol >= 0 && mapping.outflowCol < 0) {
    mapping.amountCol = mapping.inflowCol;
  } else if (mapping.amountCol < 0) {
    // No header: two amount columns where every row fills exactly one (money in / money out),
    // as in Barclaycard's old CSV. The fuller column is money out: most rows are spending.
    for (let c1 = 0; c1 < width && mapping.amountMode !== 'split'; c1++) {
      for (let c2 = c1 + 1; c2 < width; c2++) {
        if (c1 === mapping.dateCol || c2 === mapping.dateCol) continue;
        const ok = sample.every(
          (r) => !!r[c1] !== !!r[c2] && (!r[c1] || readAmount(r[c1]) !== null) && (!r[c2] || readAmount(r[c2]) !== null),
        );
        const n1 = sample.filter((r) => r[c1]).length;
        const n2 = sample.filter((r) => r[c2]).length;
        if (ok && n1 && n2) {
          mapping.amountMode = 'split';
          [mapping.outflowCol, mapping.inflowCol] = n1 >= n2 ? [c1, c2] : [c2, c1];
          break;
        }
      }
    }
    // Otherwise the right-most column where every cell is an amount.
    for (let c = width - 1; c >= 0 && mapping.amountMode !== 'split'; c--) {
      if (c !== mapping.dateCol && sample.every((r) => r[c] && readAmount(r[c]) !== null)) {
        mapping.amountCol = c;
        break;
      }
    }
  }
  if (mapping.payeeCol < 0) {
    // The column with the most text in it.
    let best = -1;
    let most = 0;
    for (let c = 0; c < width; c++) {
      if (c === mapping.dateCol || c === mapping.amountCol) continue;
      const total = sample.reduce((n, r) => n + (r[c] && /[a-z]/i.test(r[c]) ? r[c].length : 0), 0);
      if (total > most) {
        most = total;
        best = c;
      }
    }
    mapping.payeeCol = best;
  }
}

/**
 * Works out a column mapping for CSV rows (from `splitCsv`): where the header is, and
 * which columns hold the date, payee, memo and amount (one column, or paid in/paid out).
 */
export function guessCsvMapping(rows: string[][], delimiter = ','): CsvMapping {
  const { headerRow, firstRow } = findHeader(rows);
  const hasHeader = headerRow >= 0;
  const skipRows = hasHeader ? headerRow : firstRow;
  const mapping: CsvMapping = {
    delimiter,
    hasHeader,
    skipRows,
    dateCol: -1,
    dateFormat: 'auto',
    payeeCol: -1,
    memoCol: -1,
    amountMode: 'single',
    amountCol: -1,
    inflowCol: -1,
    outflowCol: -1,
    invert: false,
    refCol: -1,
  };
  if (hasHeader)
    mapHeaderColumns(
      mapping,
      rows[headerRow].map((c) => c.toLowerCase().trim()),
    );
  const start = skipRows + (hasHeader ? 1 : 0);
  mapColumnsFromData(mapping, rows.slice(start, skipRows + 21));
  return mapping;
}

/** Date formats offered for CSV files. "auto" reads any common style. */
export const CSV_DATE_FORMATS: readonly string[] = [
  'auto',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'YYYY-MM-DD',
  'DD-MM-YYYY',
  'DD.MM.YYYY',
  'DD/MM/YY',
  'MM/DD/YY',
  'D MMM YYYY',
  'DD MMM YYYY',
  'YYYYMMDD',
];

const FORMAT_TOKENS = /YYYY|YY|MMM|MM|M|DD|D/g;

/**
 * Reads a date in one of `CSV_DATE_FORMATS`. A time after the date is ignored. If the text
 * doesn't fit the format it is read as a loose date instead. Two-digit years are 20xx.
 */
export function parseDateWithFormat(text: string, format: string): ISODate | null {
  const s = (text || '').trim();
  if (!s) return null;
  if (format === 'auto') return parseLooseDate(s);
  const tokens = format.match(FORMAT_TOKENS) || [];
  const pattern = format
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(FORMAT_TOKENS, (t) =>
      t === 'YYYY' ? '(\\d{4})' : t === 'YY' ? '(\\d{2})' : t === 'MMM' ? '([A-Za-z]{3,9})' : '(\\d{1,2})',
    );
  const m = new RegExp('^' + pattern + '(?:[ T].*)?$').exec(s);
  if (!m) return parseLooseDate(s);
  let y = 0;
  let mon = 0;
  let d = 0;
  tokens.forEach((t, i) => {
    const v = m[i + 1];
    if (t === 'YYYY') y = +v;
    else if (t === 'YY') y = 2000 + +v;
    else if (t === 'MMM') mon = MONTH_SHORT.findIndex((n) => n.toLowerCase() === v.slice(0, 3).toLowerCase()) + 1;
    else if (t === 'MM' || t === 'M') mon = +v;
    else d = +v;
  });
  return makeDate(y, mon, d);
}

/** The amount of one CSV row, or null if it can't be read. */
function csvRowAmount(row: string[], mapping: CsvMapping): Money | null {
  if (mapping.amountMode !== 'split') return readAmount(row[mapping.amountCol] || '');
  // Paid in and paid out are in separate columns; banks differ on whether paid out is negative.
  const paidIn = readAmount(row[mapping.inflowCol] || '');
  const paidOut = readAmount(row[mapping.outflowCol] || '');
  if (paidIn === null && paidOut === null) return null;
  return Math.abs(paidIn || 0) - Math.abs(paidOut || 0);
}

/** The header row of a CSV file as `mapping` reads it (lower case), or undefined if it has none. */
export function csvHeader(text: string, mapping: CsvMapping): string[] | undefined {
  if (!mapping.hasHeader) return undefined;
  return splitCsv(text, mapping.delimiter)[mapping.skipRows]?.map((c) => c.toLowerCase().trim());
}

/**
 * Whether a remembered column mapping still fits this file, so the column screen can be skipped.
 * Banks add, remove and reorder columns; reading such a file with the old columns would take
 * amounts from the wrong column.
 */
export function csvMappingFits(text: string, saved: CsvMapping): boolean {
  const rows = splitCsv(text, saved.delimiter);
  const fresh = guessCsvMapping(rows, saved.delimiter);
  if (fresh.hasHeader !== saved.hasHeader) return false;
  if (saved.header) {
    const now = csvHeader(text, saved);
    return !!now && now.length === saved.header.length && now.every((h, i) => h === saved.header![i]);
  }
  // Remembered before headers were saved: the columns must be where a fresh look finds them.
  const money = (m: CsvMapping) => (m.amountMode === 'split' ? `${m.inflowCol}/${m.outflowCol}` : String(m.amountCol));
  if (fresh.hasHeader) return fresh.dateCol === saved.dateCol && fresh.amountMode === saved.amountMode && money(fresh) === money(saved);
  const width = Math.max(0, ...rows.slice(saved.skipRows, saved.skipRows + 20).map((r) => r.length));
  return Math.max(saved.dateCol, saved.payeeCol, saved.amountCol, saved.inflowCol, saved.outflowCol) < width;
}

/**
 * The file with every amount (and the OFX balance) the other way round, for an account whose
 * bank shows spending as money in. Import ids still use the file's own amounts (`fileAmount`),
 * so transactions imported before the reversal are still recognised.
 */
export function reverseAmounts(p: ParsedBankFile): ParsedBankFile {
  return {
    ...p,
    balance: p.balance === undefined ? undefined : -p.balance || 0,
    txns: p.txns.map((t) => ({ ...t, fileAmount: t.fileAmount ?? t.amount, amount: -t.amount || 0 })),
  };
}

/**
 * Undoes the apostrophe a CSV export (My Budget's, or a spreadsheet's) puts before text Excel
 * would read as a formula, so "'-50 from Mum" comes back as "-50 from Mum".
 */
const unprotect = (s: string) => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s);

/** Reads CSV text with a column mapping (see `guessCsvMapping`). */
export function parseCsv(text: string, mapping: CsvMapping): ParsedBankFile {
  const all = splitCsv(text, mapping.delimiter);
  const rows = all.slice(mapping.skipRows + (mapping.hasHeader ? 1 : 0));
  // A type column nothing else uses, such as Barclaycard's "Subcategory" ("Purchase").
  const used = [mapping.dateCol, mapping.payeeCol, mapping.memoCol, mapping.amountCol, mapping.inflowCol, mapping.outflowCol, mapping.refCol];
  const kindCol = mapping.hasHeader
    ? (all[mapping.skipRows] ?? []).findIndex((h, i) => !used.includes(i) && /^\s*(sub ?category|(transaction )?type)\s*$/i.test(h))
    : -1;
  const warnings: string[] = [];
  const txns: BankTxn[] = [];
  for (const row of rows) {
    const date = mapping.dateCol >= 0 ? parseDateWithFormat(row[mapping.dateCol] || '', mapping.dateFormat) : null;
    let amount = csvRowAmount(row, mapping);
    if (!date || amount === null) {
      warnings.push(`Skipped row: ${row.join(' | ').slice(0, 80)}`);
      continue;
    }
    if (mapping.invert) amount = -amount || 0;
    const txn: BankTxn = {
      date,
      amount,
      payee: unprotect((mapping.payeeCol >= 0 && row[mapping.payeeCol]) || ''),
      memo: unprotect((mapping.memoCol >= 0 && row[mapping.memoCol]) || ''),
    };
    if (mapping.refCol >= 0 && row[mapping.refCol]) txn.fitid = row[mapping.refCol];
    if (kindCol >= 0 && row[kindCol]?.trim()) txn.kind = row[kindCol].trim();
    txns.push(txn);
  }
  return { kind: 'csv', txns, warnings };
}

// ---- Import ids ---------------------------------------------------------------

/** 123456 -> "1,234.56", -5 -> "-0.05": the amount style YNAB4 used in its import ids. */
function ynabAmount(amount: Money): string {
  const abs = Math.round(Math.abs(amount));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (amount < 0 ? '-' : '') + whole + '.' + pad2(abs % 100);
}

/**
 * The YNAB4-style import id for a bank transaction: "YNAB:-1,234.56:2024-01-05:2" is the
 * second transaction of -1,234.56 on that date in the file. Used to spot duplicates when a
 * bank file has no FITIDs, including against transactions imported by YNAB4 itself.
 */
export function ynabImportId(txn: Pick<BankTxn, 'amount' | 'date'>, occurrence: number): string {
  return `YNAB:${ynabAmount(txn.amount)}:${txn.date}:${occurrence}`;
}

/** Import ids are compared with the thousands commas taken out of YNAB-style ids. */
export function normalizeImportId(id: string): string {
  return id.startsWith('YNAB:') ? id.replace(/,/g, '') : id;
}
