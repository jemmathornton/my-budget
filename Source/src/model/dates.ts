import type { DateFormat, ISODate, MonthKey } from './types';

// Dates are handled as "YYYY-MM-DD" strings. Arithmetic uses UTC so that
// daylight saving changes can never shift a date.

export function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** Today's date on this computer's clock. */
export function today(): ISODate {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function monthOf(date: ISODate): MonthKey {
  return date.slice(0, 7);
}

export function thisMonth(): MonthKey {
  return monthOf(today());
}

export function addMonths(month: MonthKey, n: number): MonthKey {
  const y = +month.slice(0, 4);
  const m = +month.slice(5, 7) - 1 + n;
  const year = y + Math.floor(m / 12);
  const mon = ((m % 12) + 12) % 12;
  return `${year}-${pad2(mon + 1)}`;
}

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/** True for a month key like "2026-10". */
export function isMonthKey(m: unknown): m is MonthKey {
  return typeof m === 'string' && MONTH_KEY.test(m);
}

/** True for a real date like "2026-10-15" (years 1900 to 2100). */
export function isISODate(d: unknown): d is ISODate {
  return typeof d === 'string' && /^\d{4}-\d\d-\d\d$/.test(d) && makeDate(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10)) === d;
}

/** Inclusive list of months from `from` to `to`. Empty if either isn't a month key. */
export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  if (!isMonthKey(from) || !isMonthKey(to)) return out;
  // Never more than 200 years, whatever the input.
  for (let m = from; m <= to && out.length < 2400; m = addMonths(m, 1)) out.push(m);
  return out;
}

export function monthsBetween(from: MonthKey, to: MonthKey): number {
  return (+to.slice(0, 4) - +from.slice(0, 4)) * 12 + (+to.slice(5, 7) - +from.slice(5, 7));
}

export function daysInMonth(month: MonthKey): number {
  return new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
}

function toUTC(date: ISODate): Date {
  return new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)));
}

function fromUTC(d: Date): ISODate {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function addDays(date: ISODate, n: number): ISODate {
  const d = toUTC(date);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUTC(d);
}

export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((toUTC(b).getTime() - toUTC(a).getTime()) / 86_400_000);
}

/**
 * Moves a date by whole months. The day is `anchorDay` (or the date's own day),
 * clamped to the length of the target month, so 31 Jan + 1 month = 28/29 Feb and
 * the next step still lands on 31 Mar.
 */
export function addMonthsToDate(date: ISODate, n: number, anchorDay?: number): ISODate {
  const month = addMonths(monthOf(date), n);
  const day = Math.min(anchorDay ?? +date.slice(8, 10), daysInMonth(month));
  return `${month}-${pad2(day)}`;
}

export function lastDayOfMonth(month: MonthKey): ISODate {
  return `${month}-${pad2(daysInMonth(month))}`;
}

export function firstDayOfMonth(month: MonthKey): ISODate {
  return `${month}-01`;
}

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
export const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));

export function monthName(month: MonthKey, short = false): string {
  return (short ? MONTH_SHORT : MONTH_NAMES)[+month.slice(5, 7) - 1];
}

/** "October 2026" or "Oct 2026". */
export function monthLabel(month: MonthKey, short = false): string {
  return `${monthName(month, short)} ${month.slice(0, 4)}`;
}

// ---- Display format ---------------------------------------------------------

let dateFormat: DateFormat = 'DD/MM/YYYY';

export function setDateFormat(f: DateFormat): void {
  dateFormat = f;
}

export function getDateFormat(): DateFormat {
  return dateFormat;
}

export function formatDate(date: ISODate | undefined | null): string {
  if (!date) return '';
  const y = date.slice(0, 4);
  const m = date.slice(5, 7);
  const d = date.slice(8, 10);
  switch (dateFormat) {
    case 'MM/DD/YYYY':
      return `${m}/${d}/${y}`;
    case 'YYYY-MM-DD':
      return date;
    case 'DD.MM.YYYY':
      return `${d}.${m}.${y}`;
    default:
      return `${d}/${m}/${y}`;
  }
}

/** "Mon 13 Oct" style label, used in compact lists. */
export function formatDateShort(date: ISODate): string {
  const d = toUTC(date);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  return `${wd} ${+date.slice(8, 10)} ${MONTH_SHORT[+date.slice(5, 7) - 1]}`;
}

/** A date from its parts, or null if there's no such date. Years 1900 to 2100 only, so a typo like 20266 is refused. */
export function makeDate(y: number, m: number, d: number): ISODate | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2100 || !(m >= 1 && m <= 12)) return null;
  const month = `${y}-${pad2(m)}`;
  return d >= 1 && d <= daysInMonth(month) ? `${month}-${pad2(d)}` : null;
}

/**
 * Parses what someone typed into a date box, in the budget's date format.
 * Missing parts come from `base`: "5" is the 5th of base's month, "5/11" is 5 Nov in base's year.
 * Two-digit years are 20xx.
 */
export function parseDateInput(text: string, base: ISODate = today()): ISODate | null {
  const s = text.trim();
  if (!s) return null;
  // A four-digit first part is always year-first, whatever the separator: 2026-10-13, 2026/10/13.
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split(/[-/.]/).map(Number);
    return makeDate(y, m, d);
  }
  const parts = s
    .split(/[/.\-\s]+/)
    .filter(Boolean)
    .map(Number);
  if (!parts.length || parts.length > 3 || parts.some((p) => isNaN(p))) return null;
  const by = +base.slice(0, 4);
  const bm = +base.slice(5, 7);
  let y = by;
  let m = bm;
  let d: number;
  if (dateFormat === 'YYYY-MM-DD') {
    if (parts.length === 3) [y, m, d] = parts;
    else if (parts.length === 2) [m, d] = parts;
    else d = parts[0];
  } else if (dateFormat === 'MM/DD/YYYY') {
    if (parts.length === 3) [m, d, y] = parts;
    else if (parts.length === 2) [m, d] = parts;
    else d = parts[0];
  } else {
    if (parts.length === 3) [d, m, y] = parts;
    else if (parts.length === 2) [d, m] = parts;
    else d = parts[0];
  }
  if (y < 100) y += 2000;
  return makeDate(y, m, d);
}

/**
 * Reads a date in an unknown format, as found in bank files: ISO (2026-10-13, 20261013),
 * "13 Oct 2026", or numeric with "/", "." or "-" (day first unless that is impossible,
 * or `preferMonthFirst` is set).
 */
export function parseLooseDate(text: string, preferMonthFirst = dateFormat === 'MM/DD/YYYY'): ISODate | null {
  const e = text.trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(e);
  if (m) return makeDate(+m[1], +m[2], +m[3]);
  // Year first with slashes or dots: 2026/01/15, 2026.1.15.
  m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})/.exec(e);
  if (m) return makeDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[\s\-/.]([A-Za-z]{3,9})[\s\-/.,]*(\d{2,4})/.exec(e);
  if (m) {
    const mon = MONTH_SHORT.findIndex((s) => s.toLowerCase() === m![2].slice(0, 3).toLowerCase()) + 1;
    let y = +m[3];
    if (y < 100) y += 2000;
    return makeDate(y, mon, +m[1]);
  }
  m = /^([A-Za-z]{3,9})[\s\-/.]+(\d{1,2}),?[\s\-/.]+(\d{2,4})/.exec(e);
  if (m) {
    const mon = MONTH_SHORT.findIndex((s) => s.toLowerCase() === m![1].slice(0, 3).toLowerCase()) + 1;
    let y = +m[3];
    if (y < 100) y += 2000;
    return makeDate(y, mon, +m[2]);
  }
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/.exec(e);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    const a = +m[1];
    const b = +m[2];
    if (b > 12) return makeDate(y, a, b);
    if (a > 12) return makeDate(y, b, a);
    return preferMonthFirst ? makeDate(y, a, b) : makeDate(y, b, a);
  }
  return null;
}
