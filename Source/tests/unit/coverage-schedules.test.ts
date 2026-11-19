// Extra coverage for the scheduler (November 2026 test review): what enterDueScheduled does when
// the app hasn't been opened for weeks or months. Made-up budgets only.
import { describe, expect, it } from 'vitest';
import { enterDueScheduled, saveScheduled } from '../../src/model/ops';
import { checkBudget } from '../../src/model/check';
import type { Budget, Frequency } from '../../src/model/types';
import { standardBudget } from './fixtures';

/** A schedule in Checking for Rent, starting on `start`. */
function schedule(frequency: Frequency, start: string, extra: { endDate?: string; twiceMonthDay2?: number; amount?: number } = {}) {
  const f = standardBudget();
  const sid = saveScheduled(f.b, { accountId: f.checking, date: start, startDate: start, frequency, categoryId: f.rent, amount: extra.amount ?? -1000, ...extra });
  return { ...f, sid };
}

/** The dates entered from schedule `sid`, oldest first. */
const entered = (b: Budget, sid: string) =>
  Object.values(b.transactions)
    .filter((t) => t.scheduleId === sid)
    .map((t) => t.date)
    .sort();

describe('enterDueScheduled after the app was closed for a while', () => {
  it('enters every missed month of a schedule on the 31st, on the last day of short months', () => {
    const { b, sid } = schedule('Monthly', '2026-01-31');
    expect(enterDueScheduled(b, '2026-06-15')).toBe(5);
    expect(entered(b, sid)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
    // The next one is the last day of June, not the 28th it passed through in February.
    expect(b.scheduled[sid].date).toBe('2026-06-30');
  });

  it('lands on 29 February in a leap year', () => {
    const { b, sid } = schedule('Monthly', '2028-01-31');
    enterDueScheduled(b, '2028-03-31');
    expect(entered(b, sid)).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
  });

  it('keeps a yearly 29 February schedule on 28 February in other years, and back on the 29th in a leap year', () => {
    const { b, sid } = schedule('Yearly', '2024-02-29');
    expect(enterDueScheduled(b, '2028-03-01')).toBe(5);
    expect(entered(b, sid)).toEqual(['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
  });

  it('enters both days of a twice-a-month schedule (the 15th and the last day) for each missed month', () => {
    const { b, sid } = schedule('TwiceAMonth', '2026-01-15', { twiceMonthDay2: 0 });
    expect(enterDueScheduled(b, '2026-03-20')).toBe(5);
    expect(entered(b, sid)).toEqual(['2026-01-15', '2026-01-31', '2026-02-15', '2026-02-28', '2026-03-15']);
    expect(b.scheduled[sid].date).toBe('2026-03-31');
  });

  it('enters a twice-a-month schedule whose second day comes before the first (20th and 5th)', () => {
    const { b, sid } = schedule('TwiceAMonth', '2026-01-20', { twiceMonthDay2: 5 });
    enterDueScheduled(b, '2026-03-10');
    expect(entered(b, sid)).toEqual(['2026-01-20', '2026-02-05', '2026-02-20', '2026-03-05']);
    expect(b.scheduled[sid].date).toBe('2026-03-20');
  });

  it('clamps a twice-a-month second day of 31 to short months', () => {
    const { b, sid } = schedule('TwiceAMonth', '2026-02-10', { twiceMonthDay2: 31 });
    enterDueScheduled(b, '2026-04-30');
    expect(entered(b, sid)).toEqual(['2026-02-10', '2026-02-28', '2026-03-10', '2026-03-31', '2026-04-10', '2026-04-30']);
  });

  it('steps every four weeks over a long gap without drifting', () => {
    const { b, sid } = schedule('Every4Weeks', '2026-01-02');
    enterDueScheduled(b, '2026-06-30');
    expect(entered(b, sid)).toEqual(['2026-01-02', '2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24', '2026-05-22', '2026-06-19']);
  });

  it('stops at the end date during the gap and removes the schedule', () => {
    const { b, sid } = schedule('Weekly', '2026-03-02', { endDate: '2026-03-20' });
    expect(enterDueScheduled(b, '2026-05-01')).toBe(3);
    expect(entered(b, sid)).toEqual(['2026-03-02', '2026-03-09', '2026-03-16']);
    expect(b.scheduled[sid]).toBeUndefined();
  });

  it('enters an occurrence that falls on the end date itself', () => {
    const { b, sid } = schedule('Monthly', '2026-01-15', { endDate: '2026-03-15' });
    enterDueScheduled(b, '2026-12-31');
    expect(entered(b, sid)).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
    expect(b.scheduled[sid]).toBeUndefined();
  });

  it('keeps a schedule whose end date is still ahead, on its next date', () => {
    const { b, sid } = schedule('Monthly', '2026-01-15', { endDate: '2026-12-15' });
    enterDueScheduled(b, '2026-03-20');
    expect(entered(b, sid)).toHaveLength(3);
    expect(b.scheduled[sid].date).toBe('2026-04-15');
  });

  it('enters a one-off once, however long ago, and removes it', () => {
    const { b, sid } = schedule('Once', '2026-01-05');
    expect(enterDueScheduled(b, '2026-09-01')).toBe(1);
    expect(entered(b, sid)).toEqual(['2026-01-05']);
    expect(b.scheduled[sid]).toBeUndefined();
  });

  it('leaves a one-off in the future alone', () => {
    const { b, sid } = schedule('Once', '2026-12-25');
    expect(enterDueScheduled(b, '2026-12-24')).toBe(0);
    expect(b.scheduled[sid].date).toBe('2026-12-25');
    expect(enterDueScheduled(b, '2026-12-25')).toBe(1);
  });

  it('never enters anything twice when run again on the same day or the next', () => {
    const { b, sid } = schedule('Monthly', '2026-01-31');
    enterDueScheduled(b, '2026-04-10');
    const count = Object.keys(b.transactions).length;
    expect(enterDueScheduled(b, '2026-04-10')).toBe(0);
    expect(enterDueScheduled(b, '2026-04-11')).toBe(0);
    expect(Object.keys(b.transactions)).toHaveLength(count);
    expect(entered(b, sid)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  it('enters a missed scheduled transfer as a pair each time, both sides waiting for approval', () => {
    const f = standardBudget();
    const sid = saveScheduled(f.b, { accountId: f.checking, transferAccountId: f.savings, date: '2026-01-28', startDate: '2026-01-28', frequency: 'Monthly', categoryId: null, amount: -2500 });
    expect(enterDueScheduled(f.b, '2026-04-01')).toBe(3);
    const mine = Object.values(f.b.transactions).filter((t) => t.scheduleId === sid);
    expect(mine).toHaveLength(3);
    for (const t of mine) {
      const far = f.b.transactions[t.transferTxId!];
      expect(far).toMatchObject({ accountId: f.savings, amount: 2500, date: t.date, accepted: false });
      expect(t.accepted).toBe(false);
    }
    expect(Object.values(f.b.transactions)).toHaveLength(6);
    expect(checkBudget(f.b)).toEqual([]);
  });

  it('enters several schedules in one run, each its own number of times', () => {
    const f = standardBudget();
    const weekly = saveScheduled(f.b, { accountId: f.checking, date: '2026-02-02', startDate: '2026-02-02', frequency: 'Weekly', categoryId: f.groceries, amount: -500 });
    const monthly = saveScheduled(f.b, { accountId: f.card, date: '2026-02-10', startDate: '2026-02-10', frequency: 'Monthly', categoryId: f.fun, amount: -900 });
    expect(enterDueScheduled(f.b, '2026-03-01')).toBe(4 + 1);
    expect(entered(f.b, weekly)).toEqual(['2026-02-02', '2026-02-09', '2026-02-16', '2026-02-23']);
    expect(entered(f.b, monthly)).toEqual(['2026-02-10']);
    expect(Object.values(f.b.transactions).find((t) => t.scheduleId === monthly)!.accountId).toBe(f.card);
  });

  it('skips a schedule whose date is damaged instead of looping', () => {
    const { b, sid } = schedule('Monthly', '2026-01-15');
    b.scheduled[sid].date = '2026-02-30';
    expect(enterDueScheduled(b, '2026-12-31')).toBe(0);
    expect(b.scheduled[sid].date).toBe('2026-02-30');
  });

  it('enters at most 500 of one schedule per run; the next run carries on (CURRENT BEHAVIOUR)', () => {
    // A daily schedule left for two years. The guard in enterDueScheduled stops each schedule
    // after 500 so a damaged one can't hang the app; the app runs it on every opening.
    const { b, sid } = schedule('Daily', '2025-01-01');
    expect(enterDueScheduled(b, '2026-12-31')).toBe(500);
    expect(enterDueScheduled(b, '2026-12-31')).toBe(730 - 500);
    expect(entered(b, sid)).toHaveLength(730);
    expect(entered(b, sid).at(-1)).toBe('2026-12-31');
    expect(b.scheduled[sid].date).toBe('2027-01-01');
  });
});
