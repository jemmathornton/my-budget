import { addDays, addMonths, addMonthsToDate, daysInMonth, monthOf, pad2 } from './dates';
import type { ISODate, ScheduledTransaction } from './types';

/**
 * The date after `date` for a scheduled transaction, or null if it doesn't repeat
 * (or has passed its end date). Monthly frequencies keep the start date's day of the
 * month, clamped to short months, so a schedule on the 31st stays on the last day.
 */
export function nextScheduledDate(s: ScheduledTransaction, date: ISODate): ISODate | null {
  const anchor = s.startDate ? +s.startDate.slice(8, 10) : +date.slice(8, 10);
  let next: ISODate | null = null;
  switch (s.frequency) {
    case 'Once':
      return null;
    case 'Daily':
      next = addDays(date, 1);
      break;
    case 'Weekly':
      next = addDays(date, 7);
      break;
    case 'EveryOtherWeek':
      next = addDays(date, 14);
      break;
    case 'Every4Weeks':
      next = addDays(date, 28);
      break;
    case 'Monthly':
      next = addMonthsToDate(date, 1, anchor);
      break;
    case 'EveryOtherMonth':
      next = addMonthsToDate(date, 2, anchor);
      break;
    case 'Every3Months':
      next = addMonthsToDate(date, 3, anchor);
      break;
    case 'Every4Months':
      next = addMonthsToDate(date, 4, anchor);
      break;
    case 'TwiceAYear':
      next = addMonthsToDate(date, 6, anchor);
      break;
    case 'Yearly':
      next = addMonthsToDate(date, 12, anchor);
      break;
    case 'EveryOtherYear':
      next = addMonthsToDate(date, 24, anchor);
      break;
    case 'TwiceAMonth': {
      // Two days each month: the start date's day and twiceMonthDay2 (0 = last day).
      const month = monthOf(date);
      const day2 = s.twiceMonthDay2 ?? 0;
      const on = (m: string, d: number) => `${m}-${pad2(d === 0 ? daysInMonth(m) : Math.min(d, daysInMonth(m)))}`;
      const nextMonth = addMonths(month, 1);
      next = [on(month, anchor), on(month, day2), on(nextMonth, anchor), on(nextMonth, day2)]
        .filter((d) => d > date)
        .sort()[0];
      break;
    }
  }
  if (next && s.endDate && next > s.endDate) return null;
  return next;
}

/** The dates a scheduled transaction falls on, from its next date up to `until` (inclusive). */
export function scheduledOccurrences(s: ScheduledTransaction, until: ISODate, max = 400): ISODate[] {
  const out: ISODate[] = [];
  let d: ISODate | null = s.date;
  while (d && d <= until && out.length < max) {
    if (s.endDate && d > s.endDate) break;
    out.push(d);
    d = nextScheduledDate(s, d);
  }
  return out;
}
