import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDays,
  addMonths,
  addMonthsToDate,
  daysBetween,
  daysInMonth,
  firstDayOfMonth,
  formatDate,
  formatDateShort,
  getDateFormat,
  lastDayOfMonth,
  makeDate,
  monthLabel,
  monthName,
  monthOf,
  monthRange,
  monthsBetween,
  parseDateInput,
  parseLooseDate,
  setDateFormat,
  thisMonth,
  today,
} from '../../src/model/dates';
import { setNow } from './fixtures';

afterEach(() => {
  setDateFormat('DD/MM/YYYY');
  vi.useRealTimers();
});

describe('month arithmetic', () => {
  it('adds and subtracts months across year boundaries', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-01', -13)).toBe('2024-12');
    expect(addMonths('2026-05', 0)).toBe('2026-05');
    expect(addMonths('2026-05', 24)).toBe('2028-05');
    expect(addMonths('2026-11', 14)).toBe('2028-01');
  });

  it('lists months inclusively, and nothing when the range is backwards', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthRange('2026-02', '2026-02')).toEqual(['2026-02']);
    expect(monthRange('2026-03', '2026-02')).toEqual([]);
  });

  it('counts months between two months, signed', () => {
    expect(monthsBetween('2025-11', '2026-02')).toBe(3);
    expect(monthsBetween('2026-02', '2025-11')).toBe(-3);
    expect(monthsBetween('2026-02', '2026-02')).toBe(0);
  });

  it('knows month lengths, including leap years and century rules', () => {
    expect(daysInMonth('2024-02')).toBe(29);
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2000-02')).toBe(29);
    expect(daysInMonth('2100-02')).toBe(28);
    expect(daysInMonth('2026-04')).toBe(30);
    expect(daysInMonth('2026-12')).toBe(31);
    expect(firstDayOfMonth('2026-02')).toBe('2026-02-01');
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28');
    expect(lastDayOfMonth('2028-02')).toBe('2028-02-29');
  });

  it('takes the month of a date', () => {
    expect(monthOf('2026-10-13')).toBe('2026-10');
  });
});

describe('day arithmetic', () => {
  it('adds days across months, years and leap days', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-01-01', 365)).toBe('2027-01-01');
  });

  it('is not shifted by daylight saving changes', () => {
    // UK clocks change on 29 Mar and 25 Oct 2026.
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
  });

  it('counts days between dates, signed', () => {
    expect(daysBetween('2026-01-01', '2026-12-31')).toBe(364);
    expect(daysBetween('2024-01-01', '2025-01-01')).toBe(366);
    expect(daysBetween('2026-01-10', '2026-01-05')).toBe(-5);
    expect(daysBetween('2026-01-10', '2026-01-10')).toBe(0);
  });
});

describe('addMonthsToDate', () => {
  it('clamps to the end of short months', () => {
    expect(addMonthsToDate('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsToDate('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonthsToDate('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonthsToDate('2026-05-31', 1)).toBe('2026-06-30');
  });

  it('uses the anchor day instead of the date’s own day when given', () => {
    expect(addMonthsToDate('2026-02-28', 1, 31)).toBe('2026-03-31');
    expect(addMonthsToDate('2026-02-28', 2, 30)).toBe('2026-04-30');
    expect(addMonthsToDate('2026-04-30', 1, 31)).toBe('2026-05-31');
  });

  it('moves whole years', () => {
    expect(addMonthsToDate('2026-01-15', 12)).toBe('2027-01-15');
    expect(addMonthsToDate('2024-02-29', 12)).toBe('2025-02-28');
    expect(addMonthsToDate('2025-02-28', 36, 29)).toBe('2028-02-29');
  });
});

describe('names and labels', () => {
  it('names months in full and short form', () => {
    expect(monthName('2026-01')).toBe('January');
    expect(monthName('2026-09', true)).toBe('Sep');
    expect(monthLabel('2026-10')).toBe('October 2026');
    expect(monthLabel('2026-10', true)).toBe('Oct 2026');
  });

  it('formats short dates with the weekday', () => {
    expect(formatDateShort('2026-10-13')).toBe('Tue 13 Oct');
    expect(formatDateShort('2026-03-01')).toBe('Sun 1 Mar');
    expect(formatDateShort('2024-02-29')).toBe('Thu 29 Feb');
  });
});

describe('today and thisMonth', () => {
  it('use the local calendar date', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 13, 23, 59, 0));
    expect(today()).toBe('2026-10-13');
    expect(thisMonth()).toBe('2026-10');
    vi.setSystemTime(new Date(2027, 0, 1, 0, 0, 1));
    expect(today()).toBe('2027-01-01');
    expect(thisMonth()).toBe('2027-01');
  });
});

describe('formatDate', () => {
  it('formats in each date format', () => {
    expect(getDateFormat()).toBe('DD/MM/YYYY');
    expect(formatDate('2026-10-03')).toBe('03/10/2026');
    setDateFormat('MM/DD/YYYY');
    expect(formatDate('2026-10-03')).toBe('10/03/2026');
    setDateFormat('YYYY-MM-DD');
    expect(formatDate('2026-10-03')).toBe('2026-10-03');
    setDateFormat('DD.MM.YYYY');
    expect(formatDate('2026-10-03')).toBe('03.10.2026');
  });

  it('shows nothing for a missing date', () => {
    expect(formatDate('')).toBe('');
    expect(formatDate(undefined)).toBe('');
    expect(formatDate(null)).toBe('');
  });
});

describe('makeDate', () => {
  it('accepts only real dates', () => {
    expect(makeDate(2026, 2, 28)).toBe('2026-02-28');
    expect(makeDate(2024, 2, 29)).toBe('2024-02-29');
    expect(makeDate(2026, 2, 29)).toBeNull();
    expect(makeDate(2026, 13, 1)).toBeNull();
    expect(makeDate(2026, 0, 1)).toBeNull();
    expect(makeDate(2026, 1, 0)).toBeNull();
    expect(makeDate(2026, 4, 31)).toBeNull();
  });
});

describe('parseDateInput', () => {
  const base = '2026-10-13';

  it('reads day-first dates and fills missing parts from the base date', () => {
    expect(parseDateInput('5', base)).toBe('2026-10-05');
    expect(parseDateInput('5/11', base)).toBe('2026-11-05');
    expect(parseDateInput('5/11/27', base)).toBe('2027-11-05');
    expect(parseDateInput('05.11.2027', base)).toBe('2027-11-05');
    expect(parseDateInput('5-11-2027', base)).toBe('2027-11-05');
    expect(parseDateInput(' 5 11 2027 ', base)).toBe('2027-11-05');
    // A four-digit first part is the year, whatever the separator.
    expect(parseDateInput('2027/11/05', base)).toBe('2027-11-05');
    expect(parseDateInput('2027.11.5', base)).toBe('2027-11-05');
  });

  it('always accepts ISO dates', () => {
    expect(parseDateInput('2027-11-05', base)).toBe('2027-11-05');
    expect(parseDateInput('2027-1-5', base)).toBe('2027-01-05');
    setDateFormat('MM/DD/YYYY');
    expect(parseDateInput('2027-11-05', base)).toBe('2027-11-05');
  });

  it('reads month-first dates in MM/DD/YYYY', () => {
    setDateFormat('MM/DD/YYYY');
    expect(parseDateInput('11/5', base)).toBe('2026-11-05');
    expect(parseDateInput('11/5/27', base)).toBe('2027-11-05');
    expect(parseDateInput('13/5', base)).toBeNull();
    expect(parseDateInput('7', base)).toBe('2026-10-07');
  });

  it('reads year-first dates in YYYY-MM-DD', () => {
    setDateFormat('YYYY-MM-DD');
    expect(parseDateInput('2027/11/5', base)).toBe('2027-11-05');
    expect(parseDateInput('11-5', base)).toBe('2026-11-05');
    expect(parseDateInput('7', base)).toBe('2026-10-07');
  });

  it('reads DD.MM.YYYY', () => {
    setDateFormat('DD.MM.YYYY');
    expect(parseDateInput('5.11.2027', base)).toBe('2027-11-05');
    expect(parseDateInput('5.11', base)).toBe('2026-11-05');
  });

  it('checks the day exists in that month and year', () => {
    expect(parseDateInput('29/2', '2024-06-01')).toBe('2024-02-29');
    expect(parseDateInput('29/2', base)).toBeNull();
    expect(parseDateInput('31/4', base)).toBeNull();
    expect(parseDateInput('32', base)).toBeNull();
    expect(parseDateInput('0', base)).toBeNull();
  });

  it('rejects nonsense', () => {
    expect(parseDateInput('', base)).toBeNull();
    expect(parseDateInput('   ', base)).toBeNull();
    expect(parseDateInput('abc', base)).toBeNull();
    expect(parseDateInput('1/2/3/4', base)).toBeNull();
    expect(parseDateInput('5/x', base)).toBeNull();
  });

  it('uses today as the default base', () => {
    setNow(2026, 10, 13);
    expect(parseDateInput('20')).toBe('2026-10-20');
  });
});

describe('parseLooseDate', () => {
  it('reads ISO and compact ISO dates, ignoring a time part', () => {
    expect(parseLooseDate('2026-10-13')).toBe('2026-10-13');
    expect(parseLooseDate('20261013')).toBe('2026-10-13');
    expect(parseLooseDate('2026-10-13T09:30:00')).toBe('2026-10-13');
    expect(parseLooseDate('20261013120000[0:GMT]')).toBe('2026-10-13');
  });

  it('reads dates with month names', () => {
    expect(parseLooseDate('13 Oct 2026')).toBe('2026-10-13');
    expect(parseLooseDate('13-OCT-26')).toBe('2026-10-13');
    expect(parseLooseDate('3 September 2026')).toBe('2026-09-03');
    expect(parseLooseDate('13 Sept 2026')).toBe('2026-09-13');
    expect(parseLooseDate('Oct 13, 2026')).toBe('2026-10-13');
    expect(parseLooseDate('October 13 2026')).toBe('2026-10-13');
    expect(parseLooseDate('13 Foo 2026')).toBeNull();
  });

  it('reads numeric dates day first unless that is impossible', () => {
    expect(parseLooseDate('13/10/2026')).toBe('2026-10-13');
    expect(parseLooseDate('10/13/2026')).toBe('2026-10-13');
    expect(parseLooseDate('05/11/2026')).toBe('2026-11-05');
    expect(parseLooseDate('5.11.26')).toBe('2026-11-05');
    expect(parseLooseDate('05/11/2026', true)).toBe('2026-05-11');
  });

  it('prefers month first when the budget uses MM/DD/YYYY', () => {
    setDateFormat('MM/DD/YYYY');
    expect(parseLooseDate('05/11/2026')).toBe('2026-05-11');
    expect(parseLooseDate('13/10/2026')).toBe('2026-10-13');
  });

  it('rejects impossible or unreadable dates', () => {
    expect(parseLooseDate('31/02/2026')).toBeNull();
    expect(parseLooseDate('2026-13-01')).toBeNull();
    expect(parseLooseDate('rubbish')).toBeNull();
    expect(parseLooseDate('')).toBeNull();
  });
});
