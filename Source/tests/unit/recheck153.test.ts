// 1.5.3: the full recheck's fixes in the model and the backups (docs/research/recheck-2026-11-01.md).
// Made-up budgets and temporary folders only.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyBackup, copyDir, createBackup, listBackups, backupDir } from '../../electron/files';
import { parseBudgetFile, serializeBudget } from '../../src/model/budget';
import { compute } from '../../src/model/engine';
import { exportBudgetCsv } from '../../src/model/exportCsv';
import { parseMoneyInput } from '../../src/model/money';
import { enterDueScheduled, saveScheduled, saveTransaction } from '../../src/model/ops';
import { reconciledAffected } from '../../src/model/queries';
import { scheduledForCategory } from '../../src/model/quickBudget';
import { addTx, standardBudget } from './fixtures';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mybudget-153-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the model', () => {
  it("leaves a transfer converted without its other side one-sided when it's edited (M4)", () => {
    const { b, checking, savings } = standardBudget();
    // As the YNAB4 converter leaves it: a transfer account, but no other side.
    const id = addTx(b, checking, '2026-10-01', -5000, null, { transferAccountId: savings });
    const before = compute(b).accounts.get(savings)?.working ?? 0;
    saveTransaction(b, { id, accountId: checking, date: '2026-10-01', transferAccountId: savings, amount: -5000, memo: 'a note', cleared: 'U' });
    expect(Object.values(b.transactions).filter((t) => t.accountId === savings)).toHaveLength(0);
    expect(compute(b).accounts.get(savings)?.working ?? 0).toBe(before);
    expect(b.transactions[id].memo).toBe('a note');
    // A new transfer still gets its other side.
    saveTransaction(b, { accountId: checking, date: '2026-10-02', transferAccountId: savings, amount: -100, cleared: 'U' });
    expect(Object.values(b.transactions).filter((t) => t.accountId === savings)).toHaveLength(1);
  });

  it('repairs damaged schedule dates on opening, and never writes an impossible date (M5)', () => {
    const { b, checking, groceries } = standardBudget();
    const sid = saveScheduled(b, { accountId: checking, date: '2026-10-15', startDate: '2026-10-15', frequency: 'Monthly', categoryId: groceries, amount: -100 });
    const text = serializeBudget(b).replace('"startDate":"2026-10-15"', '"startDate":"2026-10"');
    const again = parseBudgetFile(text);
    expect(again.scheduled[sid].startDate).toBe('2026-10-15');
    enterDueScheduled(again, '2026-12-31');
    expect(Object.values(again.transactions).every((t) => /^\d{4}-\d\d-\d\d$/.test(t.date) && !t.date.endsWith('-00'))).toBe(true);
    expect(() => parseBudgetFile(serializeBudget(again))).not.toThrow();
  });

  it('counts a daily schedule in Quick Budget for a month years ahead (M7)', () => {
    const { b, checking, groceries } = standardBudget();
    saveScheduled(b, { accountId: checking, date: '2026-11-01', startDate: '2026-11-01', frequency: 'Daily', categoryId: groceries, amount: -100 });
    expect(scheduledForCategory(b, groceries, '2027-12')).toBe(-3100);
  });

  it('reads "12 50" as nothing rather than £1,250, but "1 250" as £1,250 (M8)', () => {
    expect(parseMoneyInput('12 50')).toBeNull();
    expect(parseMoneyInput('1 250')).toBe(125000);
    expect(parseMoneyInput('12.50')).toBe(1250);
    expect(parseMoneyInput('120 / 4')).toBe(3000);
  });

  it("keeps same-day rows in the Register CSV in the order they were entered (M9)", () => {
    const { b, checking, groceries } = standardBudget();
    for (const [id, amount] of [['zz', -100], ['aa', -200], ['mm', -300]] as const) addTx(b, checking, '2026-10-01', amount, groceries, { id });
    const reg = exportBudgetCsv(b)[1].text.split('\r\n').filter((l) => l.includes('01/10/2026'));
    expect(reg.map((l) => l.split(',').at(-1))).toEqual(['-1.00', '-3.00', '-6.00']);
  });

  it('counts reconciled other sides of transfers among what a change touches (M1)', () => {
    const { b, checking, savings } = standardBudget();
    const id = saveTransaction(b, { accountId: checking, date: '2026-10-01', transferAccountId: savings, amount: -20000, cleared: 'U' });
    const far = b.transactions[id].transferTxId!;
    expect(reconciledAffected(b, [id]).others.size).toBe(0);
    b.transactions[far].cleared = 'R';
    expect(reconciledAffected(b, [id])).toEqual({ own: 0, others: new Set(['Savings']) });
    // Both sides chosen: it's counted once, as one of the rows.
    expect(reconciledAffected(b, [id, far])).toEqual({ own: 1, others: new Set() });
  });
});

describe('backups', () => {
  it('makes two backups of one kind in the same moment, both kept (B10)', async () => {
    const [x, y] = await Promise.all([createBackup(dir, 'b1', 'Joint', 'manual', '{"a":1}'), createBackup(dir, 'b1', 'Joint', 'manual', '{"a":2}')]);
    expect(x.file).not.toBe(y.file);
    const files = readdirSync(backupDir(dir, 'b1'));
    expect(files.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect((await listBackups(dir, 'b1')).filter((i) => i.kind === 'manual')).toHaveLength(2);
  });

  it("keeps the copy folder's daily backups however many saved-by-you copies there are (B4)", async () => {
    const dest = path.join(dir, 'usb');
    const to = copyDir(dest, 'b1', 'Joint');
    mkdirSync(to, { recursive: true });
    for (let i = 1; i <= 30; i++) writeFileSync(path.join(to, `manual_2026-08-${String((i % 28) + 1).padStart(2, '0')}_1200${String(i).padStart(2, '0')}.budget.gz`), 'x');
    const daily = await createBackup(dir, 'b1', 'Joint', 'daily', '{"a":1}');
    await copyBackup(dir, 'b1', 'Joint', daily.file, dest);
    const names = readdirSync(to);
    expect(names).toContain(daily.file);
    expect(names.filter((n) => n.startsWith('manual_'))).toHaveLength(10);
  });
});
