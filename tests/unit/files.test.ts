// The main process's file code: atomic budget writes, conflict detection, backups and the
// recent list. Uses real files in a fresh temporary folder.
import { existsSync, mkdirSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addRecent,
  backupDir,
  copyBackup,
  copyDir,
  createBackup,
  ensureDailyBackup,
  listBackupFolders,
  listBackups,
  readBackup,
  readRecent,
  removeRecent,
  stat,
  watchFile,
  writeBudgetFile,
} from '../../electron/files';
import type { BackupKind } from '../../src/shared/api';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mybudget-files-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** Pins "now" for backup names; timers stay real. */
function setNow(d: Date): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(d);
}

/** Puts a backup file in place directly, as an older version of the app would have. */
function seed(root: string, id: string, name: string, text = '{}'): void {
  const d = backupDir(root, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, name), name.endsWith('.gz') ? gzipSync(text) : text);
}

const names = (root: string, id: string) => readdirSync(backupDir(root, id)).filter((n) => n !== 'budget-name.txt').sort();

describe('writeBudgetFile', () => {
  it('writes the text and returns the file stamp, leaving no temporary file', async () => {
    const f = path.join(dir, 'a.budget');
    const r = await writeBudgetFile(f, 'hello', null);
    expect(r.ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('hello');
    expect(r.ok && r.stamp).toMatchObject((await stat(f))!);
    expect(existsSync(f + '.tmp')).toBe(false);
  });

  it('writes when the file still matches the expected stamp', async () => {
    const f = path.join(dir, 'a.budget');
    const first = await writeBudgetFile(f, 'one', null);
    const r = await writeBudgetFile(f, 'two', first.ok ? first.stamp : null);
    expect(r.ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('two');
  });

  it('refuses, and leaves the file alone, when its size changed', async () => {
    const f = path.join(dir, 'a.budget');
    const first = await writeBudgetFile(f, 'one', null);
    writeFileSync(f, 'changed elsewhere');
    const r = await writeBudgetFile(f, 'two', first.ok ? first.stamp : null);
    expect(r).toMatchObject({ ok: false, reason: 'conflict' });
    expect(readFileSync(f, 'utf8')).toBe('changed elsewhere');
  });

  it('without a content hash, refuses when only its modified time changed', async () => {
    const f = path.join(dir, 'a.budget');
    const first = await writeBudgetFile(f, 'one', null);
    utimesSync(f, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const old = first.ok ? { mtimeMs: first.stamp.mtimeMs, size: first.stamp.size } : null;
    const r = await writeBudgetFile(f, 'two', old);
    expect(r).toMatchObject({ ok: false, reason: 'conflict' });
    expect(readFileSync(f, 'utf8')).toBe('one');
  });

  it('with a content hash, writes when only the time changed (OneDrive or antivirus touched it)', async () => {
    const f = path.join(dir, 'a.budget');
    const first = await writeBudgetFile(f, 'one', null);
    expect(first.ok && first.stamp.hash).toMatch(/^[0-9a-f]{64}$/);
    utimesSync(f, new Date(2020, 0, 1), new Date(2020, 0, 1));
    expect((await writeBudgetFile(f, 'two', first.ok ? first.stamp : null)).ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('two');
  });

  it('with a content hash, refuses a real change that kept the same time and size', async () => {
    const f = path.join(dir, 'a.budget');
    const first = await writeBudgetFile(f, 'one', null);
    const t = new Date(first.ok ? first.stamp.mtimeMs : 0);
    writeFileSync(f, 'two');
    utimesSync(f, t, t);
    const r = await writeBudgetFile(f, 'six', first.ok ? first.stamp : null);
    expect(r).toMatchObject({ ok: false, reason: 'conflict' });
    expect(readFileSync(f, 'utf8')).toBe('two');
  });

  it('writes a missing file even when a stamp is expected', async () => {
    const f = path.join(dir, 'gone.budget');
    const r = await writeBudgetFile(f, 'new', { mtimeMs: 1, size: 1 });
    expect(r.ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('new');
  });

  it('reports an error with a message when the folder is missing', async () => {
    const r = await writeBudgetFile(path.join(dir, 'no', 'such', 'a.budget'), 'x', null);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('error');
    expect(!r.ok && r.reason === 'error' && r.message).toBeTruthy();
  });

  it("leaves the budget file alone if the new copy doesn't read back correctly", async () => {
    const f = path.join(dir, 'a.budget');
    await writeBudgetFile(f, 'good', null);
    const real = fsp.readFile.bind(fsp) as (...a: unknown[]) => Promise<Buffer>;
    vi.spyOn(fsp, 'readFile').mockImplementation(((p: unknown, ...rest: unknown[]) =>
      String(p).endsWith('.tmp') ? Promise.resolve(Buffer.from('garbled')) : real(p, ...rest)) as typeof fsp.readFile);
    const r = await writeBudgetFile(f, 'newer', null);
    expect(r).toMatchObject({ ok: false, reason: 'error' });
    expect(readFileSync(f, 'utf8')).toBe('good');
    expect(existsSync(f + '.tmp')).toBe(false);
  });

  it('retries a rename that fails while another program has the file open', async () => {
    const real = fsp.rename.bind(fsp);
    let fails = 2;
    vi.spyOn(fsp, 'rename').mockImplementation(async (a, b) => {
      if (fails-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return real(a, b);
    });
    const f = path.join(dir, 'a.budget');
    expect((await writeBudgetFile(f, 'x', null)).ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('x');
  });

  it('gives up when the file stays busy, and at once for other errors', async () => {
    const spy = vi.spyOn(fsp, 'rename').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EPERM' }));
    const started = Date.now();
    expect((await writeBudgetFile(path.join(dir, 'a.budget'), 'x', null, 400)).ok).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(spy.mock.calls.length).toBeGreaterThan(3);
    spy.mockClear();
    spy.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    expect((await writeBudgetFile(path.join(dir, 'b.budget'), 'x', null)).ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps trying to read the budget for the change check while it is busy', async () => {
    const f = path.join(dir, 'a.budget');
    const first = await writeBudgetFile(f, 'one', null);
    if (!first.ok) throw new Error('setup');
    const real = fsp.readFile.bind(fsp) as (...a: unknown[]) => Promise<Buffer>;
    let fails = 3;
    vi.spyOn(fsp, 'readFile').mockImplementation(((p: unknown, ...rest: unknown[]) =>
      String(p) === f && fails-- > 0
        ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' }))
        : real(p, ...rest)) as typeof fsp.readFile);
    expect((await writeBudgetFile(f, 'two', first.stamp)).ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('two');
  });

  it("doesn't replace a version another program wrote while the rename waited (1.4.4)", async () => {
    const f = path.join(dir, 'a.budget');
    const first = await writeBudgetFile(f, 'one', null);
    if (!first.ok) throw new Error('setup');
    const real = fsp.rename.bind(fsp);
    let fails = 2;
    vi.spyOn(fsp, 'rename').mockImplementation(async (a, b) => {
      if (fails-- > 0) {
        // A sync program writes its own version while the file is busy.
        if (fails === 1) writeFileSync(f, 'theirs');
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      return real(a, b);
    });
    const r = await writeBudgetFile(f, 'mine', first.stamp);
    expect(r).toMatchObject({ ok: false, reason: 'conflict' });
    expect(readFileSync(f, 'utf8')).toBe('theirs');
    expect(existsSync(f + '.tmp')).toBe(false);
  });

  it('still renames after a busy wait when nothing changed, or the file has gone (1.4.4)', async () => {
    const f = path.join(dir, 'a.budget');
    const first = await writeBudgetFile(f, 'one', null);
    if (!first.ok) throw new Error('setup');
    const real = fsp.rename.bind(fsp);
    let fails = 2;
    vi.spyOn(fsp, 'rename').mockImplementation(async (a, b) => {
      if (fails-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return real(a, b);
    });
    expect((await writeBudgetFile(f, 'two', first.stamp)).ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('two');
    const second = await writeBudgetFile(f, 'three', null);
    if (!second.ok) throw new Error('setup');
    fails = 2;
    vi.mocked(fsp.rename).mockImplementation(async (a, b) => {
      if (fails-- > 0) {
        if (fails === 1) rmSync(f);
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      return real(a, b);
    });
    expect((await writeBudgetFile(f, 'four', second.stamp)).ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('four');
  });
});

describe('backups', () => {
  it('stores a compressed copy that reads back as the same text, with the budget name', async () => {
    const info = await createBackup(dir, 'b1', 'Joint', 'manual', '{"a":1}');
    expect(info.kind).toBe('manual');
    expect(info.file).toMatch(/^manual_\d{4}-\d\d-\d\d_\d{6}\.budget\.gz$/);
    expect(gunzipSync(readFileSync(path.join(backupDir(dir, 'b1'), info.file))).toString()).toBe('{"a":1}');
    expect(await readBackup(dir, 'b1', info.file)).toBe('{"a":1}');
    expect(readFileSync(path.join(backupDir(dir, 'b1'), 'budget-name.txt'), 'utf8')).toBe('Joint');
    expect(readdirSync(backupDir(dir, 'b1')).some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('refuses a kind of backup it does not know (the kind is part of the file name)', async () => {
    await expect(createBackup(dir, 'b1', 'Joint', '../escape' as BackupKind, '{}')).rejects.toThrow(/Unknown kind/);
    const info = await createBackup(dir, 'b1', 'Joint', 'before-merge', '{"a":1}');
    expect(info.kind).toBe('before-merge');
  });

  it("refuses to keep a backup that doesn't read back correctly", async () => {
    const real = fsp.readFile.bind(fsp) as (...a: unknown[]) => Promise<Buffer>;
    vi.spyOn(fsp, 'readFile').mockImplementation(((p: unknown, ...rest: unknown[]) =>
      /.budget.gz..*.tmp$/.test(String(p)) ? Promise.resolve(gzipSync('something else')) : real(p, ...rest)) as typeof fsp.readFile);
    await expect(createBackup(dir, 'b1', 'Joint', 'manual', '{"a":1}')).rejects.toThrow(/read back/);
    expect(readdirSync(backupDir(dir, 'b1')).filter((n) => n.includes('.budget.gz'))).toEqual([]);
  });

  it('reads old uncompressed backups, and refuses anything that is not a backup', async () => {
    seed(dir, 'b1', 'manual_2025-01-01_120000.budget', '{"old":true}');
    expect(await readBackup(dir, 'b1', 'manual_2025-01-01_120000.budget')).toBe('{"old":true}');
    await expect(readBackup(dir, 'b1', '../recent-budgets.json')).rejects.toThrow();
    await expect(readBackup(dir, 'b1', 'manual_x\\..\\a.budget')).rejects.toThrow();
    await expect(readBackup(dir, 'b1', 'budget-name.txt')).rejects.toThrow();
  });

  it('keeps a new before-conflict backup when 15 older manual backups exist', async () => {
    for (let i = 1; i <= 15; i++) seed(dir, 'b1', `manual_2025-01-${String(i).padStart(2, '0')}_120000.budget.gz`);
    const info = await createBackup(dir, 'b1', 'Joint', 'before-conflict', '{"theirs":1}');
    expect(names(dir, 'b1')).toContain(info.file);
    expect(await readBackup(dir, 'b1', info.file)).toBe('{"theirs":1}');
  });

  it('keeps the newest of each kind by date, whatever the kind is called', async () => {
    for (let i = 1; i <= 20; i++) seed(dir, 'b1', `manual_2025-02-${String(i).padStart(2, '0')}_120000.budget.gz`);
    seed(dir, 'b1', 'before-restore_2026-03-01_120000.budget.gz');
    await createBackup(dir, 'b1', 'Joint', 'manual', '{}');
    const left = names(dir, 'b1');
    expect(left).toContain('before-restore_2026-03-01_120000.budget.gz');
    expect(left.filter((n) => n.startsWith('manual_'))).toHaveLength(10);
    // The oldest manual backups went first.
    expect(left).not.toContain('manual_2025-02-01_120000.budget.gz');
    expect(left).toContain('manual_2025-02-20_120000.budget.gz');
  });

  it('applies a quota per kind and leaves daily backups alone', async () => {
    for (let i = 1; i <= 12; i++) seed(dir, 'b1', `manual_2025-03-${String(i).padStart(2, '0')}_120000.budget.gz`);
    for (let i = 1; i <= 7; i++) seed(dir, 'b1', `before-conflict_2025-04-0${i}_120000.budget.gz`);
    for (let i = 1; i <= 3; i++) seed(dir, 'b1', `daily_2025-05-0${i}.budget.gz`);
    await createBackup(dir, 'b1', 'Joint', 'unsaved', '{}');
    const left = names(dir, 'b1');
    expect(left.filter((n) => n.startsWith('manual_'))).toHaveLength(10);
    expect(left.filter((n) => n.startsWith('before-conflict_'))).toHaveLength(5);
    expect(left.filter((n) => n.startsWith('daily_'))).toHaveLength(3);
    expect(left.filter((n) => n.startsWith('unsaved_'))).toHaveLength(1);
  });

  it('gives two backups of the same kind made in the same second different names', async () => {
    setNow(new Date(2026, 9, 15, 14, 22, 33));
    const a = await createBackup(dir, 'b1', 'Joint', 'before-conflict', '{"a":1}');
    const b = await createBackup(dir, 'b1', 'Joint', 'before-conflict', '{"b":2}');
    expect(a.file).toBe('before-conflict_2026-10-15_142233.budget.gz');
    expect(b.file).toBe('before-conflict_2026-10-15_142233-2.budget.gz');
    expect(await readBackup(dir, 'b1', a.file)).toBe('{"a":1}');
    expect(await readBackup(dir, 'b1', b.file)).toBe('{"b":2}');
  });

  it('counts a same-second backup as the newer one when pruning', async () => {
    setNow(new Date(2026, 9, 15, 14, 22, 33));
    for (let i = 0; i < 5; i++) await createBackup(dir, 'b1', 'Joint', 'before-conflict', `{"n":${i}}`);
    const last = await createBackup(dir, 'b1', 'Joint', 'before-conflict', '{"n":5}');
    expect(names(dir, 'b1')).toHaveLength(5);
    expect(names(dir, 'b1')).toContain(last.file);
    expect(names(dir, 'b1')).not.toContain('before-conflict_2026-10-15_142233.budget.gz');
  });

  it('makes one daily backup per day and keeps 30 of them', async () => {
    for (let i = 1; i <= 30; i++) seed(dir, 'b1', `daily_2026-09-${String(i).padStart(2, '0')}.budget.gz`);
    setNow(new Date(2026, 9, 15, 9, 0, 0));
    expect(await ensureDailyBackup(dir, 'b1', 'Joint', '{"d":1}')).toBe(true);
    expect(await ensureDailyBackup(dir, 'b1', 'Joint', '{"d":2}')).toBe(false);
    expect(await readBackup(dir, 'b1', 'daily_2026-10-15.budget.gz')).toBe('{"d":1}');
    setNow(new Date(2026, 9, 16, 9, 0, 0));
    expect(await ensureDailyBackup(dir, 'b1', 'Joint', '{"d":3}')).toBe(true);
    const daily = names(dir, 'b1').filter((n) => n.startsWith('daily_'));
    expect(daily).toHaveLength(30);
    expect(daily).not.toContain('daily_2026-09-01.budget.gz');
    expect(daily).not.toContain('daily_2026-09-02.budget.gz');
  });

  it('lists backups newest first and ignores other files', async () => {
    seed(dir, 'b1', 'manual_2025-01-01_120000.budget.gz');
    seed(dir, 'b1', 'daily_2025-01-02.budget.gz');
    seed(dir, 'b1', 'notes.txt');
    const d = backupDir(dir, 'b1');
    utimesSync(path.join(d, 'manual_2025-01-01_120000.budget.gz'), new Date(2025, 0, 1), new Date(2025, 0, 1));
    utimesSync(path.join(d, 'daily_2025-01-02.budget.gz'), new Date(2025, 0, 2), new Date(2025, 0, 2));
    const list = await listBackups(dir, 'b1');
    expect(list.map((x) => x.file)).toEqual(['daily_2025-01-02.budget.gz', 'manual_2025-01-01_120000.budget.gz']);
    expect(list[0].kind).toBe('daily');
    expect(list[0].size).toBe(statSync(path.join(d, 'daily_2025-01-02.budget.gz')).size);
    expect(await listBackups(dir, 'nobody')).toEqual([]);
  });

  it('lists the budgets that have backups, with their names, newest first', async () => {
    seed(dir, 'old-id', 'daily_2025-01-01.budget.gz');
    writeFileSync(path.join(backupDir(dir, 'old-id'), 'budget-name.txt'), 'Old Budget');
    utimesSync(path.join(backupDir(dir, 'old-id'), 'daily_2025-01-01.budget.gz'), new Date(2025, 0, 1), new Date(2025, 0, 1));
    await createBackup(dir, 'new-id', 'Joint', 'manual', '{}');
    mkdirSync(path.join(dir, 'empty-id'));
    const folders = await listBackupFolders(dir);
    expect(folders.map((f) => [f.id, f.name, f.count])).toEqual([
      ['new-id', 'Joint', 1],
      ['old-id', 'Old Budget', 1],
    ]);
    expect(await listBackupFolders(path.join(dir, 'missing'))).toEqual([]);
  });

  it('copies backups to another folder by budget name, once each, keeping 30', async () => {
    const dest = path.join(dir, 'usb');
    for (let i = 1; i <= 31; i++) seed(dir, 'b1', `daily_2026-08-${String(i).padStart(2, '0')}.budget.gz`, `{"n":${i}}`);
    for (let i = 1; i <= 31; i++) await copyBackup(dir, 'b1', 'Household: Budget', `daily_2026-08-${String(i).padStart(2, '0')}.budget.gz`, dest);
    const to = copyDir(dest, 'b1', 'Household: Budget');
    expect(path.basename(to)).toBe('Household Budget (b1)');
    const copied = readdirSync(to).sort();
    expect(copied).toHaveLength(30);
    expect(copied[0]).toBe('daily_2026-08-02.budget.gz');
    expect(gunzipSync(readFileSync(path.join(to, 'daily_2026-08-31.budget.gz'))).toString()).toBe('{"n":31}');
    // Copying again leaves the copy alone.
    writeFileSync(path.join(to, 'daily_2026-08-31.budget.gz'), 'kept');
    await copyBackup(dir, 'b1', 'Household: Budget', 'daily_2026-08-31.budget.gz', dest);
    expect(readFileSync(path.join(to, 'daily_2026-08-31.budget.gz'), 'utf8')).toBe('kept');
    await expect(copyBackup(dir, 'b1', 'Joint', '../recent-budgets.json', dest)).rejects.toThrow();
  });

  it('keeps budget ids that are not safe file names inside the backups folder', () => {
    expect(path.dirname(backupDir(dir, '../../evil'))).toBe(dir);
  });
});

describe('recent budgets', () => {
  it('puts the newest first, without duplicates (ignoring case), and keeps 12', async () => {
    const f = path.join(dir, 'recent.json');
    for (let i = 1; i <= 13; i++) await addRecent(f, `C:\\b${i}.budget`, `B${i}`);
    await addRecent(f, 'c:\\B5.BUDGET', 'B5 again');
    const list = await readRecent(f);
    expect(list).toHaveLength(12);
    expect(list[0]).toMatchObject({ path: 'c:\\B5.BUDGET', name: 'B5 again' });
    expect(list.filter((r) => r.path.toLowerCase() === 'c:\\b5.budget')).toHaveLength(1);
    await removeRecent(f, 'C:\\B13.budget');
    expect((await readRecent(f)).some((r) => r.name === 'B13')).toBe(false);
  });

  it('reads a missing or damaged list as empty', async () => {
    const f = path.join(dir, 'recent.json');
    expect(await readRecent(f)).toEqual([]);
    writeFileSync(f, '{not json');
    expect(await readRecent(f)).toEqual([]);
    writeFileSync(f, '{"a":1}');
    expect(await readRecent(f)).toEqual([]);
  });
});

describe('watching the budget folder (1.5.4)', () => {
  it('keeps trying while the folder is missing, and notices changes once it is back', async () => {
    const sub = path.join(dir, 'usb');
    const file = path.join(sub, 'Joint.budget');
    const seen: string[] = [];
    try {
      // The folder isn't there yet: 1.5.3 tried once more after 5 s and then gave up.
      watchFile(file, (f) => seen.push(f), 50);
      await new Promise((r) => setTimeout(r, 400));
      mkdirSync(sub);
      // Write until it's noticed, with time between writes for the 400 ms settle, so a slow
      // retry on a busy PC doesn't fail the test.
      let n = 0;
      await vi.waitFor(
        () => {
          if (!seen.length) writeFileSync(file, String(n++));
          expect(seen.length).toBeGreaterThan(0);
        },
        { timeout: 8000, interval: 700 },
      );
      expect(seen[0]).toBe(file);
      // 1.5.3 retried once, 5 s after it failed; the backoff got there well before that.
      expect(n).toBeLessThan(6);
    } finally {
      watchFile(null, () => {});
    }
  });
});
