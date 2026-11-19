import type { Id, Money } from './types';

// Who a bank line is really from or to: the merchant (or person) inside the bank's text.
//
// Used to guess categories for bank texts never seen before (1.3), and later to suggest payee
// merges. The rules are a port of the research normaliser, unchanged, because the accuracy
// figures in docs/plans/1.3-smarter-import.md were measured with exactly these rules.

/** What kind of bank line it was. */
export type LineKind =
  | 'card'
  | 'dd'
  | 'so'
  | 'fpo'
  | 'fpi'
  | 'bgc'
  | 'tfr'
  | 'credit'
  | 'withdrawal'
  | 'atm'
  | 'acct'
  | 'interest'
  | 'cashback';

export interface Merchant {
  /** The first 2 merchant words ("tesco stores"); '' when there is no name. */
  key: string;
  /** All the merchant words. */
  words: string[];
  kind: LineKind;
  /** A foreign-currency line. */
  foreign: boolean;
  /** Two-letter country code at the end of a card line (Nationwide), if any. */
  country: string;
  /** The part of the text that names the merchant, lower case. */
  name: string;
}

/** A row's text ending with its own amount (Santander: "…, 12.34" or "…, 12.34GBP"). */
const OWN_AMOUNT = /,\s*(-?[\d,]+\.\d{2})\s*(GBP)?\s*$/i;

/** The text without the row's own amount on the end (any other number is left alone). */
export function withoutOwnAmount(text: string, amount: Money): string {
  const m = OWN_AMOUNT.exec(text);
  if (!m) return text;
  const v = Math.round(Math.abs(parseFloat(m[1].replace(/,/g, ''))) * 100);
  return v === Math.abs(amount) ? text.slice(0, m.index) : text;
}

/**
 * The bank text as a key for "seen before": tabs and runs of spaces tidied, lower case, and the
 * row's own amount taken off the end. Only the row's own amount, so Santander's texts repeat
 * month to month, while other numbers (references, foreign amounts) still tell texts apart.
 */
export function textKey(bankText: string, amount: Money): string {
  return withoutOwnAmount(bankText, amount).replace(/\t/g, ' ').replace(/\s{2,}/g, ' ').trim().toLowerCase();
}

/** Payment processors and card terminals whose name comes before the real merchant. */
const PROCESSOR =
  /^(paypal|pp|sq|sumup|iz|izettle|zettle_?|cko|dojo|3cpayment|merpago|otpmobl|lim|sp|sp\s|ccp|crv|lsp|wpy|tst|clp|bfi|pos|zpos|sagepay|stripe|vmw)\s*\*\s*/;

const CURRENCY =
  /(DOLLAR|EURO|POUND|YEN|KRONA|KRONE|PESO|REAL|FORINT|ZLOTY|KUNA|QUETZAL|FRANC|RAND|BAHT|RUPEE|DIRHAM|LIRA|SHEKEL|WON|DONG|RINGGIT|LEU|LEV|KORUNA|RUPIAH|SOL|COLON|DINAR|HRYVNIA|SHILLING|LARI|RIAL|DRAM)/;

/** Foreign spending shown in the memo: Barclaycard "6006/1.10 EURO SLOVAKIA", Amex "Foreign Spend Amount: ...". */
export function memoIsForeign(memo: string | undefined): boolean {
  if (!memo) return false;
  if (/Foreign Spend Amount/i.test(memo)) return true;
  const m = memo.match(/\d\/\s*[\d.,]+ ([A-Z][A-Z .']+?)\s*(Transaction Fee)?\s*$/);
  return !!m && !/^POUND STERLING (GREAT BRITAIN|UNITED KINGDOM)/.test(m[1]);
}

interface Extracted {
  merchant: string;
  kind: LineKind;
  fx: boolean;
  country: string;
}

function extract(raw: string, memo?: string): Extracted {
  let s = raw.replace(/&amp;/gi, '&').replace(/\t/g, '  ').replace(/\s*\*\s*/g, '*').trim();
  let kind: LineKind = 'card';
  let fx = memoIsForeign(memo);
  let m: RegExpMatchArray | null;

  // Foreign amounts glued on (Barclaycard: "Kyoto7777.00 YEN JAPAN"; Nationwide: "43.990000 EUR at 1.13905").
  if (/\d+\.\d{6} [A-Z]{3} at \d/.test(s)) {
    fx = true;
    s = s.replace(/\s*\d+\.\d{6} [A-Z]{3} at [\d.]+\s*$/, '');
  }
  m = s.match(/^(.*?)(\d[\d,]*\.\d{2}) ([A-Z][A-Z .'-]+)$/);
  if (m && CURRENCY.test(m[3])) {
    fx = fx || !/POUND STERLING (GREAT BRITAIN|UNITED KINGDOM)/.test(m[3]);
    s = m[1];
  }

  // Long bank descriptions (Santander style): keep only the other party.
  if ((m = s.match(/^DIRECT DEBIT PAYMENT TO (.+?) REF (.*?)(, MANDATE NO.*)?$/i))) {
    kind = 'dd';
    s = m[1];
  } else if ((m = s.match(/^(STANDING ORDER|BILL PAYMENT) VIA FASTER PAYMENT TO (.+?) REFERENCE (.*?)\s*, MANDATE NO.*$/i))) {
    kind = m[1].toLowerCase().startsWith('s') ? 'so' : 'fpo';
    s = m[2];
  } else if ((m = s.match(/^FASTER PAYMENTS RECEIPT REF\.?(.*?) FROM (.+?)(, [\d,]+\.\d{2})?$/i))) {
    kind = 'fpi';
    s = m[2];
  } else if ((m = s.match(/^BANK GIRO CREDIT REF (.+?)(, .*)?$/i))) {
    kind = 'bgc';
    s = m[1];
  } else if ((m = s.match(/^REGULAR TRANSFER PAYMENT TO ACCOUNT (.+?), MANDATE.*$/i))) {
    kind = 'tfr';
    s = 'regular transfer ' + m[1];
  } else if (/^\d+ DIRECT DEBIT PAYMENTS? .*CASHBACK/i.test(s)) {
    kind = 'cashback';
    s = 'direct debit cashback';
  } else if (/^INTEREST PAID AFTER TAX/i.test(s)) {
    kind = 'interest';
    s = 'interest paid';
  } else if ((m = s.match(/^CARD PAYMENT TO (.+?)(,| ON \d).*$/i))) {
    s = m[1];
  } else if ((m = s.match(/^(TRANSFER (FROM|TO)|BANK CREDIT|BANK DEBIT)\s+(.+)$/i))) {
    kind = m[1].toLowerCase().startsWith('bank c') ? 'credit' : 'tfr';
    s = m[3];
  } else if ((m = s.match(/^(\d{6}) (\d{8})(\s+(Credit|Withdrawal).*)?$/i))) {
    kind = 'acct';
    s = 'acct ' + m[1] + m[2];
  } else if ((m = s.match(/^(Credit|Withdrawal) \d{1,2} \w+ \d{4}$/i))) {
    kind = m[1].toLowerCase() as LineKind;
    s = m[1];
  } else if (/^ATM Withdrawal/i.test(s)) {
    kind = 'atm';
    s = 'atm withdrawal';
  }
  // A trailing amount ", 123.45" (Santander).
  s = s.replace(/,\s*[\d,]+\.\d{2}$/, '');
  // Nationwide's wallet suffix and country code: "... GB GOOGLE 1252", "... LU", "... GB 7872".
  s = s.replace(/\s+(ANDROID|GOOGLE|APPLE PAY|APPLE|FITBIT|GARMIN|SAMSUNG)\s+\d{4}$/i, '');
  s = s.replace(/(\s[A-Z]{2})\s+\d{4}$/, '$1');
  let country = '';
  if (kind === 'card') {
    const cc = s.match(/\s([A-Z]{2})$/);
    if (cc) {
      country = cc[1] === 'UK' ? 'GB' : cc[1];
      s = s.replace(/\s+[A-Z]{2}$/, '');
    }
  }
  // Card-statement layouts: "Merchant, Town" (Barclaycard), "MERCHANT<spaces>TOWN" (Amex, Barclaycard).
  if (kind === 'card') {
    const comma = s.lastIndexOf(', ');
    if (comma > 0) s = s.slice(0, comma);
    s = s.replace(/,$/, '');
    const gap = s.search(/\S\s{2,}\S/);
    if (gap > 0) s = s.slice(0, gap + 1);
  }
  let low = s.toLowerCase().replace(/[’`]/g, "'");
  // "X*REF" -> x; "UBER *EATS" -> "uber eats"; processors: "SQ *CAFE" -> "cafe".
  low = low.replace(PROCESSOR, '');
  low = low.replace(/^(paypal|pp)\s+\*?/, '').replace(/^sp\s+/, '');
  const star = low.indexOf('*');
  if (star >= 0) {
    const left = low.slice(0, star).trim();
    const right = low.slice(star + 1).trim();
    const firstRight = right.split(/\s+/)[0] || '';
    low = left && /\d/.test(firstRight) ? left : (left + ' ' + right).trim();
  }
  low = low.replace(/\b([a-z])\.([a-z])/g, '$1$2');
  return { merchant: low.replace(/\s+/g, ' ').trim(), kind, fx, country };
}

const STOP = new Set(
  'the and of at gb uk ltd limited plc llc inc co com www http https net org help ref payment payments via to from mr mrs ms miss dr'.split(' '),
);

/** A few spellings of the same big merchant. Kept tiny on purpose. */
const ALIAS: Record<string, string> = {
  amzn: 'amazon',
  amznmktplace: 'amazon',
  amazoncouk: 'amazon',
  amz: 'amazon',
  amzndigital: 'amazon',
  mcd: 'mcdonalds',
  sainsbury: 'sainsburys',
};

/** Words of the merchant part: web addresses trimmed, digits dropped, short and noise words dropped. */
function merchantWords(merchant: string): string[] {
  let s = merchant
    .replace(/https?:\/\//g, ' ')
    .replace(/\bwww\./g, ' ')
    .replace(/\.(co\.uk|com|net|org|co|uk|ie|de|fr|es|it|nl|eu|gov\.uk|org\.uk)\b/g, ' ')
    .replace(/'/g, '')
    .replace(/\s*&\s*/g, '&');
  // Split letters from digits ("dublin59" -> "dublin 59"), then drop anything with a digit.
  s = s.replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2');
  return s
    .split(/[^a-z0-9&]+/)
    .filter((w) => w.length > 1 && !/\d/.test(w) && !STOP.has(w))
    .map((w) => ALIAS[w] || w);
}

/** The merchant (or person) in a bank text. `memo` only helps spot foreign spending. */
export function merchantOf(bankText: string, memo?: string): Merchant {
  const e = extract(bankText, memo);
  const words = merchantWords(e.merchant);
  // Account-number lines keep their number; lines with no name use their kind (except card lines).
  const key = e.kind === 'acct' ? e.merchant : words.length ? words.slice(0, 2).join(' ') : e.kind === 'card' ? '' : e.kind;
  return { key, words, kind: e.kind, foreign: e.fx || memoIsForeign(memo), country: e.country, name: e.merchant };
}

/** Processor names that say nothing about the merchant on their own. */
const PROCESSOR_ONLY = new Set(['paypal', 'pp', 'sq', 'sumup', 'zettle', 'izettle', 'iz', 'sp', 'cko', 'dojo', 'stripe']);

/**
 * The key for treating two bank texts as the same payee (payee proposals on import, merge
 * suggestions), or null for "never": lines with no name, processor-only names. Person-to-person
 * lines need the whole name, never just a first name or surname. The bank's own lines (interest,
 * cashback) only group within one account.
 */
export function mergeKey(m: Merchant, accountId: Id): string | null {
  switch (m.kind) {
    case 'credit':
    case 'withdrawal':
    case 'atm':
      return null;
    case 'interest':
    case 'cashback':
      return `bank:${m.kind}:${accountId}`;
    case 'acct':
      return 'person:' + m.name;
    case 'fpi':
    case 'fpo':
    case 'so':
    case 'tfr':
      return m.words.length ? 'person:' + m.words.join(' ') : null;
    default:
      return m.key && !PROCESSOR_ONLY.has(m.key) ? m.key : null;
  }
}

/** The amount as a clue: in or out, and its size in powers of 2 (£1, £2-3, £4-7, ...). */
export function amountBand(amount: Money): string {
  const v = Math.abs(amount) / 100;
  return 'amt:' + (amount >= 0 ? 'in' : 'out') + ':' + (v < 1 ? 0 : Math.floor(Math.log2(v)) + 1);
}

/** Clues for the word model: merchant words, line kind, foreign, country, account and amount band. */
export function guessClues(m: Merchant, accountId: Id, amount: Money): string[] {
  const out = m.kind === 'acct' ? [m.name.replace(' ', ':')] : [...m.words];
  out.push('kind:' + m.kind);
  if (m.foreign) out.push('fx:1');
  if (m.country && m.country !== 'GB') out.push('cc:' + m.country.toLowerCase());
  out.push('account:' + accountId, amountBand(amount));
  return out;
}
