import type { Currency, Money } from './types';

export const DEFAULT_CURRENCY: Currency = {
  code: 'GBP',
  symbol: '£',
  locale: 'en-GB',
  decimals: 2,
  symbolFirst: true,
};

/** Currencies offered in Settings. Any other can be set up by hand. */
export const CURRENCY_PRESETS: Currency[] = [
  DEFAULT_CURRENCY,
  { code: 'EUR', symbol: '€', locale: 'en-IE', decimals: 2, symbolFirst: true },
  { code: 'EUR', symbol: '€', locale: 'de-DE', decimals: 2, symbolFirst: false },
  { code: 'USD', symbol: '$', locale: 'en-US', decimals: 2, symbolFirst: true },
  { code: 'CAD', symbol: '$', locale: 'en-CA', decimals: 2, symbolFirst: true },
  { code: 'AUD', symbol: '$', locale: 'en-AU', decimals: 2, symbolFirst: true },
  { code: 'NZD', symbol: '$', locale: 'en-NZ', decimals: 2, symbolFirst: true },
  { code: 'CHF', symbol: 'CHF', locale: 'de-CH', decimals: 2, symbolFirst: true },
  { code: 'SEK', symbol: 'kr', locale: 'sv-SE', decimals: 2, symbolFirst: false },
  { code: 'JPY', symbol: '¥', locale: 'ja-JP', decimals: 0, symbolFirst: true },
];

const NBSP = String.fromCharCode(0xa0);

let currency: Currency = DEFAULT_CURRENCY;
let nf: Intl.NumberFormat | null = null;
let nfKey = '';

export function setCurrency(c: Currency): void {
  currency = c;
}

export function getCurrency(): Currency {
  return currency;
}

function numberFormat(): Intl.NumberFormat {
  const key = currency.locale + '|' + currency.decimals;
  if (!nf || nfKey !== key) {
    nf = new Intl.NumberFormat(currency.locale || 'en-GB', {
      minimumFractionDigits: currency.decimals,
      maximumFractionDigits: currency.decimals,
    });
    nfKey = key;
  }
  return nf;
}

export function unit(): number {
  return Math.pow(10, currency.decimals);
}

export interface FormatOptions {
  /** Show nothing for zero. */
  blankZero?: boolean;
  /** Leave out the currency symbol. */
  symbol?: boolean;
  /** Put a "+" in front of positive amounts. */
  plus?: boolean;
}

/** Formats minor units as money: 123456 -> "£1,234.56", -500 -> "-£5.00". */
export function formatMoney(amount: Money, opts: FormatOptions = {}): string {
  if (opts.blankZero && amount === 0) return '';
  const n = numberFormat().format(Math.abs(amount) / unit());
  const sym = opts.symbol === false ? '' : currency.symbol;
  const body = currency.symbolFirst ? sym + n : n + (sym ? NBSP + sym : '');
  if (amount < 0) return '-' + body;
  if (opts.plus && amount > 0) return '+' + body;
  return body;
}

/** The plain number for an edit box: 123456 -> "1234.56", 0 -> "". */
export function moneyToInput(amount: Money): string {
  return amount ? (amount / unit()).toFixed(currency.decimals) : '';
}

/**
 * Evaluates a small arithmetic expression: + - * / and brackets.
 * Currency symbols, spaces and thousands commas are ignored; "x" and "×" mean multiply.
 * Returns NaN if the text is not a valid expression.
 */
export function evaluateExpression(text: string): number {
  // A space between digits is only a thousands gap ("1 250"); "12 50" is more likely £12.50
  // than £1,250, so it isn't read at all, as "12,50" once wasn't (1.5.3).
  // Every group is checked, "1 250 50" too (the lookahead leaves each group for the next match).
  for (const m of text.matchAll(/\d\s+(?=(\d+))/g)) if (!/^\d{3}$/.test(m[1])) return NaN;
  const s = text
    .replace(/[£$€¥\s,]/g, '')
    .replace(/[x×]/gi, '*')
    .replace(/÷/g, '/');
  if (!s) return 0;
  let i = 0;
  const peek = () => s[i];
  const num = (): number => {
    const m = /^\d+\.?\d*|^\.\d+/.exec(s.slice(i));
    if (!m) throw new Error('number expected');
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const factor = (): number => {
    const c = peek();
    if (c === '-') {
      i++;
      return -factor();
    }
    if (c === '+') {
      i++;
      return factor();
    }
    if (c === '(') {
      i++;
      const v = expr();
      if (peek() !== ')') throw new Error(') expected');
      i++;
      return v;
    }
    return num();
  };
  const term = (): number => {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = s[i++];
      const r = factor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  function expr(): number {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  try {
    const v = expr();
    return i !== s.length || !isFinite(v) ? NaN : v;
  } catch {
    return NaN;
  }
}

/**
 * Parses what was typed into a money box. Supports maths ("120/4"), "(5.00)" and "5.00-" for
 * negatives, and, when `previous` is given, relative edits that start with an operator
 * ("+25" adds 25 to the previous amount, "-20" takes 20 off it, "*2" doubles it). With a previous
 * amount, a negative is "(20)" or "0-20" (1.5.7: "-20" used to mean -20).
 * Returns null when the text cannot be understood.
 */
export function parseMoneyInput(text: string, previous?: Money): Money | null {
  let s = text.trim();
  if (s === '') return 0;
  // Use "." as the decimal mark if the currency uses ",": "12,50" -> "12.50".
  if (decimalMarkIsComma()) s = s.replace(/\./g, '').replace(/,/g, '.');
  // Otherwise a comma groups thousands ("1,250"), except that a number's only comma with exactly
  // two digits after it, and no point, is the pence: "12,50" is £12.50 (the owner's choice, 1.4.4).
  // Only in a currency with pence: in yen it can't be. Any other comma that isn't a thousands
  // group ("12,5", "1,2345") is refused rather than guessed.
  else {
    if (unit() === 100) s = s.replace(/(?<![\d.,])(\d+),(\d{2})(?![\d.,])/g, '$1.$2');
    if (/,(?!\d{3}(\D|$))/.test(s)) return null;
  }
  // Relative to the previous amount if it starts with an operator as typed (not the "-" that
  // "(5)" becomes below).
  const relative = previous !== undefined && /^[-+*/]/.test(s);
  // The minus applies to the whole bracket ("(2+3)" is -5), and only when the first bracket closes at the end.
  if (wrappedInBrackets(s)) s = '-' + s;
  if (/^[^-]+-$/.test(s)) s = '-(' + s.slice(0, -1) + ')';
  if (relative) s = '(' + previous! / unit() + ')' + s;
  const v = evaluateExpression(s);
  // Nothing over a billion: a pasted card number isn't an amount.
  return isNaN(v) || Math.abs(v) > 1e9 ? null : Math.round(v * unit());
}

/** "(5+3)" but not "(5)+(3)": the opening bracket is the one that closes the text. */
function wrappedInBrackets(s: string): boolean {
  if (!/^\(.*\)$/.test(s)) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i === s.length - 1;
  }
  return false;
}

function decimalMarkIsComma(): boolean {
  return numberFormat().format(1.5).includes(',');
}

/** A decimal amount (e.g. from YNAB4 JSON) to minor units. */
export function toMinor(value: unknown, decimals = 2): Money {
  if (value == null || value === '') return 0;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  return isFinite(n) ? Math.round(n * Math.pow(10, decimals)) : 0;
}

/**
 * Reads an amount as written in a bank file: "1,234.56", "-12.00", "(12.00)", "12.00 DR",
 * "DR 12.00", "12.00-", "£-5.00", "GBP 7.5", "−12.34" (a Unicode minus or dash). With
 * `commaDecimal`, "1.234,56" style is read instead. Returns null for anything that isn't just
 * an amount ("REF 4471", "16/01/2026", "12.34.56", "1.5E+03"), so the row is skipped with a
 * warning instead of being imported with a made-up amount.
 */
export function parseBankAmount(text: string, commaDecimal = false): Money | null {
  let s = (text || '').trim().replace(/[−‒–—]/g, '-');
  if (!s) return null;
  let neg = false;
  const flip = () => (neg = !neg);
  if (/^\(.*\)$/.test(s)) {
    flip();
    s = s.slice(1, -1).trim();
  }
  let m = /^(CR|DR)\.?\s*/i.exec(s);
  if (m) {
    if (/DR/i.test(m[1])) flip();
    s = s.slice(m[0].length);
  }
  m = /\s*(CR|DR)\.?$/i.exec(s);
  if (m) {
    if (/DR/i.test(m[1])) flip();
    s = s.slice(0, m.index);
  }
  if (s.endsWith('-')) {
    flip();
    s = s.slice(0, -1).trim();
  }
  // A sign and a currency symbol or code, in either order: "-£5.00", "£-5.00", "GBP -5.00".
  const currencyRe = /^(£|\$|€|GBP|EUR|USD)\s*/i;
  for (let i = 0; i < 2; i++) {
    if (/^[+-]/.test(s)) {
      if (s[0] === '-') flip();
      s = s.slice(1).trim();
    }
    s = s.replace(currencyRe, '');
  }
  s = s.replace(/\s*(£|\$|€|GBP|EUR|USD)$/i, '');
  // Digits with thousands groups (",", or "." when the decimal mark is a comma, or a space),
  // then optional decimals. Nothing else is allowed.
  const [group, decimal] = commaDecimal ? ['.', ','] : [',', '.'];
  const shape = new RegExp(`^(\\d{1,3}([${group} ]\\d{3})+|\\d*)(\\${decimal}\\d+)?$`);
  if (!/\d/.test(s) || !shape.test(s)) return null;
  const [whole, frac = ''] = s.split(decimal);
  const digits = whole.replace(/[^\d]/g, '');
  if (digits.length > 12) return null;
  const v = parseFloat(digits + '.' + (frac || '0'));
  const minor = Math.round(v * 100);
  return neg ? -minor || 0 : minor;
}
