import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMonths, formatDate, setDateFormat, thisMonth } from '../../src/model/dates';
import { DEFAULT_CURRENCY, formatMoney, setCurrency } from '../../src/model/money';
import { saveTransaction, setBudgeted, setCleared } from '../../src/model/ops';
import { INCOME_NOW, type Budget } from '../../src/model/types';
import { store, update } from '../../src/state/store';
import { addTx, setNow, standardBudget } from './fixtures';

let f: ReturnType<typeof standardBudget>;
const b = () => store.budget as Budget;

beforeEach(() => {
  setNow(2026, 10, 13);
  f = standardBudget();
  addTx(f.b, f.checking, '2026-10-01', 100000, INCOME_NOW, { id: 'pay', cleared: 'C' });
  store.load(f.b);
});

afterEach(() => {
  vi.useRealTimers();
  setDateFormat('DD/MM/YYYY');
  setCurrency(DEFAULT_CURRENCY);
});

describe('undo and redo', () => {
  it('records each change with its label, without changing the previous budget object', () => {
    const before = b();
    expect(store.canUndo()).toBe(false);
    update('Budget groceries', (d) => setBudgeted(d, '2026-10', f.groceries, 2500));
    expect(store.canUndo()).toBe(true);
    expect(store.undoLabel()).toBe('Budget groceries');
    expect(b()).not.toBe(before);
    expect(b().months['2026-10'][f.groceries].budgeted).toBe(2500);
    expect(before.months['2026-10']).toBeUndefined();
  });

  it('undoes and redoes in order, returning the labels', () => {
    update('First', (d) => setBudgeted(d, '2026-10', f.groceries, 1000));
    update('Second', (d) => setBudgeted(d, '2026-10', f.groceries, 3000));
    expect(store.undo()).toBe('Second');
    expect(b().months['2026-10'][f.groceries].budgeted).toBe(1000);
    expect(store.redoLabel()).toBe('Second');
    expect(store.undoLabel()).toBe('First');
    expect(store.undo()).toBe('First');
    expect(b().months['2026-10']).toBeUndefined();
    expect(store.canUndo()).toBe(false);
    expect(store.undo()).toBeUndefined();
    expect(store.redo()).toBe('First');
    expect(store.redo()).toBe('Second');
    expect(b().months['2026-10'][f.groceries].budgeted).toBe(3000);
    expect(store.canRedo()).toBe(false);
    expect(store.redo()).toBeUndefined();
  });

  it('forgets what could be redone after a new change', () => {
    update('First', (d) => setBudgeted(d, '2026-10', f.groceries, 1000));
    store.undo();
    expect(store.canRedo()).toBe(true);
    update('Other', (d) => setBudgeted(d, '2026-10', f.rent, 1000));
    expect(store.canRedo()).toBe(false);
    expect(store.undoLabel()).toBe('Other');
  });

  it('undoes both sides of a transfer at once', () => {
    let id = '';
    update('Add transaction', (d) => {
      id = saveTransaction(d, { accountId: f.checking, transferAccountId: f.savings, date: '2026-10-02', amount: -5000, cleared: 'U' });
    });
    const peer = b().transactions[id].transferTxId!;
    expect(Object.keys(b().transactions)).toHaveLength(3);
    store.undo();
    expect(b().transactions[id]).toBeUndefined();
    expect(b().transactions[peer]).toBeUndefined();
    store.redo();
    expect(b().transactions[peer]).toMatchObject({ accountId: f.savings, amount: 5000, transferTxId: id });
  });

  it('keeps at most 300 undo steps', () => {
    for (let i = 1; i <= 305; i++) update(`Step ${i}`, (d) => setBudgeted(d, '2026-10', f.groceries, i));
    let n = 0;
    while (store.undo()) n++;
    expect(n).toBe(300);
    expect(b().months['2026-10'][f.groceries].budgeted).toBe(5);
  });

  it('does not record a change that changes nothing', () => {
    let notified = 0;
    let changed = 0;
    const unsub = store.subscribe(() => notified++);
    const unsubChange = store.onChange(() => changed++);
    const before = b();
    const version = store.version;
    update('Nothing', () => {});
    update('Same value', (d) => setCleared(d, ['pay'], 'C'));
    update('Zero budget', (d) => setBudgeted(d, '2026-10', f.groceries, 0));
    expect(store.canUndo()).toBe(false);
    expect(b()).toBe(before);
    expect(store.version).toBe(version);
    expect([notified, changed]).toEqual([0, 0]);
    unsub();
    unsubChange();
  });

  it('leaves the budget alone if a change throws', () => {
    const before = b();
    expect(() =>
      update('Broken', (d) => {
        setBudgeted(d, '2026-10', f.groceries, 1000);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(b()).toBe(before);
    expect(store.canUndo()).toBe(false);
  });

  it('does nothing without a budget', () => {
    store.load(null);
    update('Nothing open', (d) => setBudgeted(d, '2026-10', 'x', 1));
    expect(store.budget).toBeNull();
    expect(store.computed()).toBeNull();
    expect(store.undo()).toBeUndefined();
  });

  it('starts with no history after load or replace', () => {
    update('First', (d) => setBudgeted(d, '2026-10', f.groceries, 1000));
    store.replace(standardBudget().b);
    expect(store.canUndo()).toBe(false);
    update('Second', (d) => setBudgeted(d, '2026-10', f.groceries, 1000));
    store.undo();
    store.load(standardBudget().b);
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
  });
});

describe('notifications', () => {
  it('tells subscribers about everything, and change listeners only about user changes', () => {
    const seen: string[] = [];
    const unsub = store.subscribe(() => seen.push('render'));
    const unsubChange = store.onChange((x) => seen.push('save:' + (x === store.budget)));
    update('First', (d) => setBudgeted(d, '2026-10', f.groceries, 1000));
    store.undo();
    store.redo();
    store.load(standardBudget().b);
    store.replace(standardBudget().b);
    expect(seen).toEqual(['render', 'save:true', 'render', 'save:true', 'render', 'save:true', 'render', 'render']);
    unsub();
    unsubChange();
    update('After unsubscribe', (d) => setBudgeted(d, '2026-10', f.groceries, 1));
    expect(seen).toHaveLength(8);
  });

  it('stamps modifiedAt on changes, undo and redo', () => {
    const original = b().modifiedAt;
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 13, 15, 0, 0)));
    update('First', (d) => setBudgeted(d, '2026-10', f.groceries, 1000));
    expect(b().modifiedAt).toBe('2026-10-13T15:00:00.000Z');
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 13, 16, 0, 0)));
    store.undo();
    expect(b().modifiedAt).toBe('2026-10-13T16:00:00.000Z');
    expect(b().modifiedAt).not.toBe(original);
  });

  it('applies the budget’s currency and date format', () => {
    const x = standardBudget().b;
    x.dateFormat = 'YYYY-MM-DD';
    x.currency = { code: 'USD', symbol: '$', locale: 'en-US', decimals: 2, symbolFirst: true };
    store.load(x);
    expect(formatDate('2026-10-13')).toBe('2026-10-13');
    expect(formatMoney(150)).toBe('$1.50');
  });
});

describe('computed cache', () => {
  it('reuses one result until the budget changes', () => {
    const c1 = store.computed()!;
    expect(store.computed()).toBe(c1);
    expect(store.computed('2026-12')).toBe(c1);
    expect(c1.summary.get('2026-10')!.atb).toBe(100000);

    update('Budget', (d) => setBudgeted(d, '2026-10', f.groceries, 2500));
    const c2 = store.computed()!;
    expect(c2).not.toBe(c1);
    expect(c2.summary.get('2026-10')!.atb).toBe(97500);

    store.undo();
    const c3 = store.computed()!;
    expect(c3).not.toBe(c2);
    expect(c3.summary.get('2026-10')!.atb).toBe(100000);

    store.redo();
    expect(store.computed()!.summary.get('2026-10')!.atb).toBe(97500);
  });

  it('always reaches at least six months past this month', () => {
    const c = store.computed()!;
    expect(c.last).toBe(addMonths(thisMonth(), 6));
    expect(c.last).toBe('2027-04');
    expect(store.computed('2027-01')).toBe(c);
  });

  it('recomputes further ahead when asked, and reuses the longer result', () => {
    const c1 = store.computed()!;
    const c2 = store.computed('2027-09')!;
    expect(c2).not.toBe(c1);
    expect(c2.last).toBe('2027-09');
    expect(c2.months.at(-1)).toBe('2027-09');
    expect(store.computed()).toBe(c2);
    expect(store.computed('2027-05')).toBe(c2);
  });

  it('is cleared when a budget is loaded or replaced', () => {
    const c1 = store.computed()!;
    store.replace(standardBudget().b);
    const c2 = store.computed()!;
    expect(c2).not.toBe(c1);
    expect(c2.summary.get('2026-10')!.atb).toBe(0);
    store.load(f.b);
    expect(store.computed()!.summary.get('2026-10')!.atb).toBe(100000);
  });
});

describe('merged undo steps', () => {
  const note = (text: string, mergeKey?: string) =>
    update('Month note', (d) => ((d.monthNotes ??= {})['2026-10'] = text), mergeKey ? { mergeKey } : undefined);

  it('undoes a note typed in several bursts in one step, and redoes it in one', () => {
    note('Hol', 'k');
    note('Holiday', 'k');
    note('Holiday fund', 'k');
    expect(store.undoLabel()).toBe('Month note');
    store.undo();
    expect(b().monthNotes?.['2026-10']).toBeUndefined();
    expect(store.canUndo()).toBe(false);
    store.redo();
    expect(b().monthNotes?.['2026-10']).toBe('Holiday fund');
  });

  it('starts a new step for a different key, or no key', () => {
    note('a', 'k1');
    note('b', 'k2');
    note('c');
    note('d');
    store.undo();
    expect(b().monthNotes?.['2026-10']).toBe('c');
    store.undo();
    expect(b().monthNotes?.['2026-10']).toBe('b');
    store.undo();
    expect(b().monthNotes?.['2026-10']).toBe('a');
  });

  it("doesn't merge into a step that was undone and redone over", () => {
    note('a', 'k');
    store.undo();
    note('b', 'k');
    store.undo();
    expect(b().monthNotes?.['2026-10']).toBeUndefined();
  });
});
