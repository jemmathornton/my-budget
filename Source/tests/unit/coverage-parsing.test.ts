// Extra coverage for typed money and dates (November 2026 test review). The main cases are in
// money.test.ts and dates.test.ts; these are the edges around them. "(50.00)+10" in a budget cell
// is handled by MoneyInput in the UI, so it isn't tested here.
import { afterEach, describe, expect, it } from 'vitest';
import { parseDateWithFormat } from '../../src/import/bank';
import { addMonthsToDate, daysBetween, parseDateInput, parseLooseDate, setDateFormat } from '../../src/model/dates';
import { DEFAULT_CURRENCY, parseMoneyInput, setCurrency } from '../../src/model/money';

afterEach(() => {
  setDateFormat('DD/MM/YYYY');
  setCurrency(DEFAULT_CURRENCY);
});

describe('parseMoneyInput: relative edits (1.5.7)', () => {
  it('works from a previous amount of zero, so "-20" in an empty cell is -20', () => {
    expect(parseMoneyInput('-20', 0)).toBe(-2000);
    expect(parseMoneyInput('+5', 0)).toBe(500);
  });

  it('ignores spaces around the text and after the operator', () => {
    expect(parseMoneyInput('  -20 ', 10000)).toBe(8000);
    expect(parseMoneyInput('- 20', 10000)).toBe(8000);
  });

  it('reads a pence comma in a relative edit', () => {
    expect(parseMoneyInput('-12,50', 10000)).toBe(8750);
  });

  it('multiplies and divides a negative previous amount', () => {
    expect(parseMoneyInput('*2', -500)).toBe(-1000);
    expect(parseMoneyInput('/4', -1000)).toBe(-250);
  });

  it('is absolute when the text starts with a currency sign, even "£-5"', () => {
    // Only an operator typed first makes it relative.
    expect(parseMoneyInput('£-5', 10000)).toBe(-500);
    expect(parseMoneyInput('£5', 10000)).toBe(500);
  });

  it('refuses dividing by zero and results over a billion', () => {
    expect(parseMoneyInput('/0', 1000)).toBeNull();
    expect(parseMoneyInput('*1000000', 100000000)).toBeNull();
  });

  it('refuses a trailing minus after a relative edit, and exponents', () => {
    expect(parseMoneyInput('-20-', 10000)).toBeNull();
    expect(parseMoneyInput('1e3')).toBeNull();
  });

  it('rounds to the nearest penny', () => {
    expect(parseMoneyInput('10/3')).toBe(333);
    expect(parseMoneyInput('0.005')).toBe(1);
    expect(parseMoneyInput('+0.004', 100)).toBe(100);
  });
});

describe('dates around 29 February', () => {
  it('accepts 29 February typed in a leap year, including 2000, and refuses it otherwise', () => {
    expect(parseDateInput('29/2/28', '2026-10-13')).toBe('2028-02-29');
    expect(parseDateInput('29/02/2000', '2026-10-13')).toBe('2000-02-29');
    expect(parseDateInput('29/02/2100', '2026-10-13')).toBeNull();
    expect(parseDateInput('2027-02-29', '2026-10-13')).toBeNull();
  });

  it('reads 29 February month first in MM/DD/YYYY', () => {
    setDateFormat('MM/DD/YYYY');
    expect(parseDateInput('2/29/2024', '2026-10-13')).toBe('2024-02-29');
    expect(parseDateInput('29/2/2024', '2026-10-13')).toBeNull();
  });

  it('reads 29 February in bank files in every style, and refuses it in other years', () => {
    expect(parseLooseDate('29/02/2024')).toBe('2024-02-29');
    expect(parseLooseDate('02/29/2024')).toBe('2024-02-29');
    expect(parseLooseDate('20240229')).toBe('2024-02-29');
    expect(parseLooseDate('29 Feb 2024')).toBe('2024-02-29');
    expect(parseLooseDate('29 Feb 2023')).toBeNull();
    expect(parseLooseDate('20230229')).toBeNull();
  });

  it('moves a year on from 29 February to 28 February, and counts the leap day', () => {
    expect(addMonthsToDate('2024-02-29', 12)).toBe('2025-02-28');
    expect(addMonthsToDate('2024-02-29', 48)).toBe('2028-02-29');
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2);
    expect(daysBetween('2023-02-28', '2023-03-01')).toBe(1);
  });
});

describe('DD/MM against YYYY-MM-DD', () => {
  it('reads two-digit year-first dates in YYYY-MM-DD as 20xx', () => {
    setDateFormat('YYYY-MM-DD');
    expect(parseDateInput('27-11-5', '2026-10-13')).toBe('2027-11-05');
  });

  it('reads an ISO date the same whatever the date format', () => {
    for (const f of ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD.MM.YYYY'] as const) {
      setDateFormat(f);
      expect(parseDateInput('2026-03-04', '2026-10-13'), f).toBe('2026-03-04');
      expect(parseLooseDate('2026-03-04'), f).toBe('2026-03-04');
    }
  });

  it('reads 04/03 as 4 March in DD/MM/YYYY and 3 April in MM/DD/YYYY', () => {
    expect(parseDateInput('04/03/2026', '2026-10-13')).toBe('2026-03-04');
    setDateFormat('MM/DD/YYYY');
    expect(parseDateInput('04/03/2026', '2026-10-13')).toBe('2026-04-03');
  });

  it('reads a CSV date with a chosen format strictly: a date that does not exist is refused, not guessed', () => {
    expect(parseDateWithFormat('29/02/2023', 'DD/MM/YYYY')).toBeNull();
    // Month first by mistake: month 13 is refused rather than swapped round.
    expect(parseDateWithFormat('13/01/2026', 'MM/DD/YYYY')).toBeNull();
    expect(parseDateWithFormat('01/13/2026', 'MM/DD/YYYY')).toBe('2026-01-13');
    expect(parseDateWithFormat('2026-01-13 08:15:00', 'YYYY-MM-DD')).toBe('2026-01-13');
  });

  it('reads two-digit years in bank files as 20xx (unlike QIF, where 70-99 are 19xx)', () => {
    expect(parseLooseDate('05/11/99')).toBe('2099-11-05');
    expect(parseDateWithFormat('05/11/99', 'DD/MM/YY')).toBe('2099-11-05');
  });
});
