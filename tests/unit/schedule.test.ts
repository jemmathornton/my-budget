import { describe, expect, it } from 'vitest';
import { nextScheduledDate, scheduledOccurrences } from '../../src/model/schedule';
import type { Frequency, ScheduledTransaction } from '../../src/model/types';

function sched(frequency: Frequency, startDate: string, extra: Partial<ScheduledTransaction> = {}): ScheduledTransaction {
  return { id: 's1', accountId: 'acc', date: startDate, startDate, frequency, categoryId: null, amount: -1000, ...extra };
}

/** The next `n` dates after the schedule's current date, following nextScheduledDate. */
function walk(s: ScheduledTransaction, n: number): (string | null)[] {
  const out: (string | null)[] = [];
  let d: string | null = s.date;
  for (let i = 0; i < n && d; i++) {
    d = nextScheduledDate(s, d);
    out.push(d);
  }
  return out;
}

describe('nextScheduledDate', () => {
  it('Once never repeats', () => {
    expect(nextScheduledDate(sched('Once', '2026-10-13'), '2026-10-13')).toBeNull();
  });

  it('Daily, Weekly, EveryOtherWeek and Every4Weeks step by days', () => {
    expect(walk(sched('Daily', '2026-12-30'), 3)).toEqual(['2026-12-31', '2027-01-01', '2027-01-02']);
    expect(walk(sched('Weekly', '2026-10-13'), 3)).toEqual(['2026-10-20', '2026-10-27', '2026-11-03']);
    expect(walk(sched('EveryOtherWeek', '2026-12-25'), 2)).toEqual(['2027-01-08', '2027-01-22']);
    expect(walk(sched('Every4Weeks', '2026-01-29'), 3)).toEqual(['2026-02-26', '2026-03-26', '2026-04-23']);
    expect(walk(sched('Weekly', '2028-02-26'), 1)).toEqual(['2028-03-04']);
  });

  it('Monthly on the 31st clamps to short months but returns to the 31st', () => {
    expect(walk(sched('Monthly', '2026-01-31'), 5)).toEqual([
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
    ]);
  });

  it('Monthly on the 30th lands on 29 Feb in a leap year', () => {
    expect(walk(sched('Monthly', '2028-01-30'), 2)).toEqual(['2028-02-29', '2028-03-30']);
  });

  it('EveryOtherMonth, Every3Months, Every4Months and TwiceAYear keep the anchor day', () => {
    expect(walk(sched('EveryOtherMonth', '2026-12-31'), 4)).toEqual([
      '2027-02-28',
      '2027-04-30',
      '2027-06-30',
      '2027-08-31',
    ]);
    expect(walk(sched('Every3Months', '2026-11-30'), 3)).toEqual(['2027-02-28', '2027-05-30', '2027-08-30']);
    expect(walk(sched('Every4Months', '2026-10-31'), 3)).toEqual(['2027-02-28', '2027-06-30', '2027-10-31']);
    expect(walk(sched('TwiceAYear', '2026-08-31'), 3)).toEqual(['2027-02-28', '2027-08-31', '2028-02-29']);
  });

  it('Yearly and EveryOtherYear from 29 February', () => {
    expect(walk(sched('Yearly', '2024-02-29'), 4)).toEqual(['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
    expect(walk(sched('EveryOtherYear', '2024-02-29'), 2)).toEqual(['2026-02-28', '2028-02-29']);
  });

  it('takes the anchor day from startDate, not the current date', () => {
    const s = sched('Monthly', '2026-01-31', { date: '2026-04-30' });
    expect(nextScheduledDate(s, '2026-04-30')).toBe('2026-05-31');
  });

  it('falls back to the date’s own day when there is no startDate', () => {
    const s = sched('Monthly', '2026-04-30', { startDate: '' });
    expect(nextScheduledDate(s, '2026-04-30')).toBe('2026-05-30');
  });

  describe('TwiceAMonth', () => {
    it('day2 = 0 means the last day of each month', () => {
      const s = sched('TwiceAMonth', '2026-01-15', { twiceMonthDay2: 0 });
      expect(walk(s, 6)).toEqual(['2026-01-31', '2026-02-15', '2026-02-28', '2026-03-15', '2026-03-31', '2026-04-15']);
      const leap = sched('TwiceAMonth', '2028-02-15', { twiceMonthDay2: 0 });
      expect(walk(leap, 2)).toEqual(['2028-02-29', '2028-03-15']);
    });

    it('a missing day2 also means the last day', () => {
      const s = sched('TwiceAMonth', '2026-04-15');
      expect(walk(s, 3)).toEqual(['2026-04-30', '2026-05-15', '2026-05-31']);
    });

    it('works with the 1st and 15th', () => {
      const s = sched('TwiceAMonth', '2026-11-01', { twiceMonthDay2: 15 });
      expect(walk(s, 4)).toEqual(['2026-11-15', '2026-12-01', '2026-12-15', '2027-01-01']);
    });

    it('works when the start day is after day2', () => {
      const s = sched('TwiceAMonth', '2026-01-20', { twiceMonthDay2: 5 });
      expect(walk(s, 4)).toEqual(['2026-02-05', '2026-02-20', '2026-03-05', '2026-03-20']);
    });

    it('clamps a 31st anchor in short months and returns to it', () => {
      const s = sched('TwiceAMonth', '2026-01-31', { twiceMonthDay2: 15 });
      expect(walk(s, 6)).toEqual(['2026-02-15', '2026-02-28', '2026-03-15', '2026-03-31', '2026-04-15', '2026-04-30']);
    });

    it('crosses the year end', () => {
      const s = sched('TwiceAMonth', '2026-12-31', { twiceMonthDay2: 15 });
      expect(walk(s, 2)).toEqual(['2027-01-15', '2027-01-31']);
    });

    it('finds the next date when the current date is on neither day', () => {
      const s = sched('TwiceAMonth', '2026-03-01', { twiceMonthDay2: 15, date: '2026-03-10' });
      expect(nextScheduledDate(s, '2026-03-10')).toBe('2026-03-15');
      expect(nextScheduledDate(s, '2026-03-20')).toBe('2026-04-01');
    });
  });

  describe('endDate', () => {
    it('stops after the end date, inclusive of the end date itself', () => {
      const s = sched('Monthly', '2026-01-15', { endDate: '2026-03-15' });
      expect(walk(s, 3)).toEqual(['2026-02-15', '2026-03-15', null]);
    });

    it('applies to every frequency', () => {
      expect(nextScheduledDate(sched('Weekly', '2026-01-01', { endDate: '2026-01-07' }), '2026-01-01')).toBeNull();
      expect(nextScheduledDate(sched('Daily', '2026-01-01', { endDate: '2026-01-02' }), '2026-01-01')).toBe('2026-01-02');
      expect(
        nextScheduledDate(sched('TwiceAMonth', '2026-01-01', { twiceMonthDay2: 15, endDate: '2026-01-14' }), '2026-01-01'),
      ).toBeNull();
      expect(nextScheduledDate(sched('Yearly', '2026-01-01', { endDate: '2026-12-31' }), '2026-01-01')).toBeNull();
    });
  });
});

describe('scheduledOccurrences', () => {
  it('lists dates from the next date up to and including `until`', () => {
    const s = sched('Monthly', '2026-01-31', { date: '2026-02-28' });
    expect(scheduledOccurrences(s, '2026-05-31')).toEqual(['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
    expect(scheduledOccurrences(s, '2026-05-30')).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('is empty when the next date is after `until`', () => {
    expect(scheduledOccurrences(sched('Weekly', '2026-10-13'), '2026-10-12')).toEqual([]);
  });

  it('gives a single date for Once', () => {
    expect(scheduledOccurrences(sched('Once', '2026-10-13'), '2027-12-31')).toEqual(['2026-10-13']);
  });

  it('stops at the end date', () => {
    const s = sched('Weekly', '2026-09-17', { endDate: '2026-10-01' });
    expect(scheduledOccurrences(s, '2026-12-31')).toEqual(['2026-09-17', '2026-09-24', '2026-10-01']);
    expect(scheduledOccurrences(sched('Weekly', '2026-10-13', { endDate: '2026-10-01' }), '2026-12-31')).toEqual([]);
  });

  it('caps the number of dates', () => {
    expect(scheduledOccurrences(sched('Daily', '2026-01-01'), '2030-01-01', 10)).toHaveLength(10);
    expect(scheduledOccurrences(sched('Daily', '2026-01-01'), '2030-01-01')).toHaveLength(400);
  });
});
