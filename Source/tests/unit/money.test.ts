import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENCY_PRESETS,
  DEFAULT_CURRENCY,
  evaluateExpression,
  formatMoney,
  getCurrency,
  moneyToInput,
  parseBankAmount,
  parseMoneyInput,
  setCurrency,
  toMinor,
  unit,
} from '../../src/model/money';

const NBSP = ' ';
const EUR_DE = CURRENCY_PRESETS.find((c) => c.locale === 'de-DE')!;
const JPY = CURRENCY_PRESETS.find((c) => c.code === 'JPY')!;

afterEach(() => setCurrency(DEFAULT_CURRENCY));

describe('formatMoney', () => {
  it('formats pence as pounds with grouping', () => {
    expect(getCurrency()).toBe(DEFAULT_CURRENCY);
    expect(formatMoney(123456)).toBe('£1,234.56');
    expect(formatMoney(5)).toBe('£0.05');
    expect(formatMoney(0)).toBe('£0.00');
    expect(formatMoney(123456789012)).toBe('£1,234,567,890.12');
  });

  it('puts the minus sign before the symbol', () => {
    expect(formatMoney(-500)).toBe('-£5.00');
    expect(formatMoney(-1)).toBe('-£0.01');
  });

  it('supports blank zero, no symbol and a plus sign', () => {
    expect(formatMoney(0, { blankZero: true })).toBe('');
    expect(formatMoney(-1, { blankZero: true })).toBe('-£0.01');
    expect(formatMoney(123456, { symbol: false })).toBe('1,234.56');
    expect(formatMoney(-123456, { symbol: false })).toBe('-1,234.56');
    expect(formatMoney(500, { plus: true })).toBe('+£5.00');
    expect(formatMoney(0, { plus: true })).toBe('£0.00');
    expect(formatMoney(-500, { plus: true })).toBe('-£5.00');
  });

  it('puts the symbol after the number for currencies that do that', () => {
    setCurrency(EUR_DE);
    expect(formatMoney(123456)).toBe(`1.234,56${NBSP}€`);
    expect(formatMoney(-123456)).toBe(`-1.234,56${NBSP}€`);
    expect(formatMoney(123456, { symbol: false })).toBe('1.234,56');
  });

  it('handles currencies without minor units', () => {
    setCurrency(JPY);
    expect(unit()).toBe(1);
    expect(formatMoney(1234)).toBe('¥1,234');
    expect(moneyToInput(1234)).toBe('1234');
  });

  it('picks up a currency change straight away (number format cache)', () => {
    expect(formatMoney(100000)).toBe('£1,000.00');
    setCurrency(EUR_DE);
    expect(formatMoney(100000)).toBe(`1.000,00${NBSP}€`);
    setCurrency(DEFAULT_CURRENCY);
    expect(formatMoney(100000)).toBe('£1,000.00');
  });
});

describe('moneyToInput', () => {
  it('gives the plain number for an edit box', () => {
    expect(moneyToInput(123456)).toBe('1234.56');
    expect(moneyToInput(-500)).toBe('-5.00');
    expect(moneyToInput(5)).toBe('0.05');
    expect(moneyToInput(0)).toBe('');
  });
});

describe('evaluateExpression', () => {
  it.each([
    ['1+2*3', 7],
    ['(1+2)*3', 9],
    ['10/4', 2.5],
    ['10-2-3', 5],
    ['2^0', NaN],
    ['2x3', 6],
    ['2X3', 6],
    ['2×3', 6],
    ['6÷2', 3],
    ['£1,234.50', 1234.5],
    [' 12 . 5 ', 12.5],
    ['.5', 0.5],
    ['5.', 5],
    ['--5', 5],
    ['-(2+3)', -5],
    ['+4', 4],
    ['((1+1)*(2+2))', 8],
    ['', 0],
    ['1+', NaN],
    ['1/0', NaN],
    ['(1+2', NaN],
    ['1+2)', NaN],
    ['1..2', NaN],
    ['2(3)', NaN],
    ['abc', NaN],
  ])('%s = %s', (text, expected) => {
    const v = evaluateExpression(text);
    if (isNaN(expected)) expect(v).toBeNaN();
    else expect(v).toBeCloseTo(expected, 10);
  });
});

describe('parseMoneyInput', () => {
  it('reads plain amounts in pence', () => {
    expect(parseMoneyInput('12.50')).toBe(1250);
    expect(parseMoneyInput('£1,234.56')).toBe(123456);
    expect(parseMoneyInput('  7 ')).toBe(700);
    expect(parseMoneyInput('')).toBe(0);
    expect(parseMoneyInput('0.29')).toBe(29);
    expect(parseMoneyInput('0.1+0.2')).toBe(30);
  });

  it('reads accounting negatives', () => {
    expect(parseMoneyInput('-5')).toBe(-500);
    expect(parseMoneyInput('(5.00)')).toBe(-500);
    expect(parseMoneyInput('5.00-')).toBe(-500);
    // The sign applies to the whole amount, not just its first term.
    expect(parseMoneyInput('(2+3)')).toBe(-500);
    expect(parseMoneyInput('2+3-')).toBe(-500);
    expect(parseMoneyInput('(5)', 1000)).toBe(-500);
  });

  it('evaluates maths, including brackets that are not one outer pair', () => {
    expect(parseMoneyInput('120/4')).toBe(3000);
    expect(parseMoneyInput('3*12.99')).toBe(3897);
    // Starts with "(" and ends with ")" but is not "(...)": not an accounting negative.
    expect(parseMoneyInput('(1+2)*(3+4)')).toBe(2100);
    expect(parseMoneyInput('(10)+(5)')).toBe(1500);
    expect(parseMoneyInput('((5))')).toBe(-500);
  });

  it('applies relative edits to the previous amount', () => {
    expect(parseMoneyInput('+25', 1000)).toBe(3500);
    expect(parseMoneyInput('*2', 1050)).toBe(2100);
    expect(parseMoneyInput('/4', 1000)).toBe(250);
    expect(parseMoneyInput('+25', -500)).toBe(2000);
    expect(parseMoneyInput('+0.01', 29)).toBe(30);
    // A leading minus takes it off too (1.5.7, the owner's choice: 100, then "-20", is 80)...
    expect(parseMoneyInput('-20', 10000)).toBe(8000);
    expect(parseMoneyInput('-25', 1000)).toBe(-1500);
    expect(parseMoneyInput('-0.50+1', 1000)).toBe(1050);
    // ...while "(20)" and "0-20" still set a negative amount, and so does "-20" on its own.
    expect(parseMoneyInput('(20)', 10000)).toBe(-2000);
    expect(parseMoneyInput('0-20', 10000)).toBe(-2000);
    expect(parseMoneyInput('-20')).toBe(-2000);
    // Without a previous amount, "+25" is just 25.
    expect(parseMoneyInput('+25')).toBe(2500);
  });

  it('returns null for text it cannot read', () => {
    expect(parseMoneyInput('abc')).toBeNull();
    expect(parseMoneyInput('1+')).toBeNull();
    expect(parseMoneyInput('-')).toBeNull();
    expect(parseMoneyInput('*2')).toBeNull();
  });

  it('reads a comma with two digits after it as the pence, refuses other unclear commas and amounts over a billion (1.4.4)', () => {
    expect(parseMoneyInput('12,50')).toBe(1250);
    expect(parseMoneyInput('1,25')).toBe(125);
    expect(parseMoneyInput('1250,00')).toBe(125000);
    expect(parseMoneyInput('£12,50')).toBe(1250);
    expect(parseMoneyInput('(12,50)')).toBe(-1250);
    expect(parseMoneyInput('12,50-')).toBe(-1250);
    expect(parseMoneyInput('12,50+1,25')).toBe(1375);
    expect(parseMoneyInput('+2,50', 1000)).toBe(1250);
    expect(parseMoneyInput('12,5')).toBeNull();
    expect(parseMoneyInput('1,2345')).toBeNull();
    expect(parseMoneyInput('1,250,50')).toBeNull();
    expect(parseMoneyInput('1.234,50')).toBeNull();
    expect(parseMoneyInput('12,50.5')).toBeNull();
    expect(parseMoneyInput('1,250')).toBe(125000);
    expect(parseMoneyInput('1,250.50')).toBe(125050);
    expect(parseMoneyInput('12,500,000')).toBe(1250000000);
    expect(parseMoneyInput('1,250+5')).toBe(125500);
    expect(parseMoneyInput('1234567890123456')).toBeNull();
    expect(parseMoneyInput('-1000000001')).toBeNull();
    expect(parseMoneyInput('1000000000')).toBe(100000000000);
  });

  it('uses a comma as the decimal mark for currencies that do', () => {
    setCurrency(EUR_DE);
    expect(parseMoneyInput('12,50')).toBe(1250);
    expect(parseMoneyInput('1.234,56')).toBe(123456);
    expect(parseMoneyInput('+1,5', 1050)).toBe(1200);
    expect(parseMoneyInput('(3,00)')).toBe(-300);
  });

  it('rounds to whole units for currencies without minor units', () => {
    setCurrency(JPY);
    expect(parseMoneyInput('1234')).toBe(1234);
    expect(parseMoneyInput('12.6')).toBe(13);
    expect(parseMoneyInput('+100', 1234)).toBe(1334);
    // No pence, so "12,50" isn't ¥12.50: an unclear comma, refused (1.4.4).
    expect(parseMoneyInput('12,50')).toBeNull();
    expect(parseMoneyInput('1,250')).toBe(1250);
  });
});

describe('toMinor', () => {
  it('converts decimal amounts to minor units', () => {
    expect(toMinor(12.34)).toBe(1234);
    expect(toMinor(-0.29)).toBe(-29);
    expect(toMinor('1234.5')).toBe(123450);
    expect(toMinor(1234, 0)).toBe(1234);
    expect(toMinor(1.5, 3)).toBe(1500);
  });

  it('treats missing or unreadable values as zero', () => {
    expect(toMinor(null)).toBe(0);
    expect(toMinor(undefined)).toBe(0);
    expect(toMinor('')).toBe(0);
    expect(toMinor('abc')).toBe(0);
    expect(toMinor(Infinity)).toBe(0);
  });
});

describe('parseBankAmount', () => {
  it.each([
    ['1,234.56', 123456],
    ['-12.00', -1200],
    ['+12.00', 1200],
    ['(12.00)', -1200],
    ['12.00 DR', -1200],
    ['12.00dr', -1200],
    ['12.00 CR', 1200],
    ['12.00-', -1200],
    ['£-5.00', -500],
    ['GBP 7.5', 750],
    ['  3 ', 300],
    ['0.29', 29],
  ])('%s -> %s', (text, expected) => {
    expect(parseBankAmount(text)).toBe(expected);
  });

  it('reads comma-decimal amounts when asked', () => {
    expect(parseBankAmount('1.234,56', true)).toBe(123456);
    expect(parseBankAmount('-12,50', true)).toBe(-1250);
    expect(parseBankAmount('1.234.567,89', true)).toBe(123456789);
  });

  it('returns null when there is no number', () => {
    expect(parseBankAmount('')).toBeNull();
    expect(parseBankAmount('   ')).toBeNull();
    expect(parseBankAmount('abc')).toBeNull();
    expect(parseBankAmount('-')).toBeNull();
    expect(parseBankAmount(undefined as unknown as string)).toBeNull();
  });
});
