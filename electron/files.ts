import { createHash } from 'node:crypto';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { BackupFolder, BackupInfo, BackupKind, FileStamp, RecentBudget, WriteResult } from '../src/shared/api';

// File handling for the main process: atomic budget writes with conflict detection,
// backups and the recent-budgets list. Nothing here talks to the network.

export async function stat(file: string): Promise<FileStamp | null> {
  try {
    const s = await fs.stat(file);
    return { mtimeMs: Math.floor(s.mtimeMs), size: s.size };
  } catch {
    return null;
  }
}

/** SHA-256 of a file's contents, to tell a real change from a timestamp that merely moved. */
function hashOf(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Reads a budget, waiting out a sync program or antivirus holding it open. The time and size come
 * from the same open file as the contents, so a change in between can't pair one version's time
 * with another's contents (1.5.3).
 */
export async function readBudgetFile(file: string): Promise<{ text: string; stamp: FileStamp }> {
  return retryWhileBusy(async () => {
    const handle = await fs.open(file, 'r');
    try {
      const s = await handle.stat();
      const data = await handle.readFile();
      return { text: data.toString('utf8'), stamp: { mtimeMs: Math.floor(s.mtimeMs), size: s.size, hash: hashOf(data) } };
    } finally {
      await handle.close();
    }
  });
}

/**
 * Writes the budget so that a crash or power cut can never leave a half-written file:
 * the text goes to a temporary file first, which then replaces the real one.
 * If `expected` is given and the file on disk no longer matches it, nothing is written.
 * With a content hash in `expected`, the contents decide: OneDrive or antivirus can change a
 * file's time without changing it, and on some drives a real change keeps the same time and size.
 */
export async function writeBudgetFile(
  file: string,
  text: string,
  expected: FileStamp | null,
  busyRetryMs = BUSY_RETRY_MS,
): Promise<WriteResult> {
  try {
    if (expected) {
      const now = await stat(file);
      if (now) {
        if (expected.hash) {
          const current = hashOf(await retryWhileBusy(() => fs.readFile(file), busyRetryMs));
          if (current !== expected.hash) return { ok: false, reason: 'conflict', stamp: { ...now, hash: current } };
        } else if (now.mtimeMs !== expected.mtimeMs || now.size !== expected.size) {
          return { ok: false, reason: 'conflict', stamp: now };
        }
      }
    }
    const tmp = file + '.tmp';
    try {
      const handle = await fs.open(tmp, 'w');
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (e) {
      // A disk full or locked mustn't leave a half-written copy beside the budget (1.5.3).
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
    // Read it back before it replaces the budget: a disk or driver fault must never put a bad
    // file in place of a good one.
    const hash = hashOf(text);
    if (hashOf(await fs.readFile(tmp)) !== hash) {
      await fs.rm(tmp, { force: true });
      throw new Error('The saved copy did not read back correctly, so the budget file was left as it was.');
    }
    // While the rename waits for a busy file, another program (a sync program, say) may write its
    // own version. Look again before each new try, so that version is never replaced unseen.
    const lookAgain = expected?.hash
      ? async () => {
          let data: Buffer;
          try {
            data = await fs.readFile(file);
          } catch (e) {
            // Gone: nothing to protect. Busy: just another busy try.
            const code = (e as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return;
            throw e;
          }
          const current = hashOf(data);
          if (current !== expected.hash) throw new ChangedMeanwhile({ ...((await stat(file)) ?? { mtimeMs: 0, size: 0 }), hash: current });
        }
      : undefined;
    try {
      // Once before the first try too: writing and reading back a large budget takes a moment,
      // and another program may have saved its version meanwhile (1.5.3).
      await lookAgain?.();
      await retryWhileBusy(() => fs.rename(tmp, file), busyRetryMs, lookAgain);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      if (!(e instanceof ChangedMeanwhile)) throw e;
      return { ok: false, reason: 'conflict', stamp: e.stamp };
    }
    return { ok: true, stamp: { ...(await stat(file))!, hash } };
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** The budget file changed on disk while a save was waiting to replace it. */
class ChangedMeanwhile extends Error {
  constructor(readonly stamp: FileStamp) {
    super('The budget file was changed by another program.');
  }
}

/** How long to keep trying while another program has a file open. */
const BUSY_RETRY_MS = 8000;

/**
 * On Windows, antivirus, OneDrive or a backup program can hold a file open for a few seconds,
 * and a rename or read then fails. Keep trying (more slowly as it goes on) for up to `forMs`.
 * The app's own retry after a failed save starts after that, and closing waits 10 s.
 * `beforeRetry` runs before each new try, and can stop them by throwing.
 */
async function retryWhileBusy<T>(fn: () => Promise<T>, forMs = BUSY_RETRY_MS, beforeRetry?: () => Promise<void>): Promise<T> {
  const until = Date.now() + forMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (Date.now() >= until || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      await new Promise((r) => setTimeout(r, Math.min(50 * (attempt + 1), 500)));
      await beforeRetry?.();
    }
  }
}

function renameWithRetry(from: string, to: string): Promise<void> {
  return retryWhileBusy(() => fs.rename(from, to));
}

// ---- Watching the open budget file --------------------------------------------------------

let watcher: FSWatcher | null = null;
let watchTimer: NodeJS.Timeout | null = null;
/** The next try at watching again, while the folder can't be watched. */
let retryTimer: NodeJS.Timeout | null = null;

/** The budget being watched, if any. */
let watchedFile: string | null = null;

export function watchFile(file: string | null, onChange: (file: string) => void, retryMs = 5000): void {
  watcher?.close();
  watcher = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  watchedFile = file;
  if (!file) return;
  // A drive that went away (a USB stick, a network folder) can come back: watch again shortly,
  // or later changes by other programs would go unnoticed until the budget was reopened (1.5.3).
  // Until it's back, try again less often, up to once a minute (1.5.4).
  const again = (ms: number) => {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!watcher && watchedFile === file) watchFile(file, onChange, Math.min(ms * 2, 60_000));
    }, ms);
  };
  try {
    // Watch the folder rather than the file: atomic saves replace the file, which ends a file watch.
    const dir = path.dirname(file);
    const base = path.basename(file).toLowerCase();
    watcher = watch(dir, (_event, name) => {
      if (!name || name.toString().toLowerCase() !== base) return;
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => onChange(file), 400);
    });
    watcher.on('error', () => {
      watcher?.close();
      watcher = null;
      again(5000);
    });
  } catch {
    watcher = null;
    again(retryMs);
  }
}

// ---- Backups ----------------------------------------------------------------------------------

/** How many of each kind to keep. Worst case about 97 files (about 53 MB for a 4 MB budget). */
const KEEP: Record<BackupKind, number> = {
  daily: 30,
  hourly: 24,
  'before-import': 10,
  manual: 10,
  'before-restore': 5,
  'before-conflict': 5,
  'before-reload': 5,
  'before-fresh-start': 3,
  'before-merge': 5,
  'before-learn': 3,
  'before-replace': 5,
  unsaved: 5,
};

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'budget';
}

export function backupDir(root: string, budgetId: string): string {
  return path.join(root, safeId(budgetId));
}

function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function stampForName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${localDate(d)}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const KINDS: BackupKind[] = [
  'daily',
  'hourly',
  'before-import',
  'before-restore',
  'before-conflict',
  'before-reload',
  'before-fresh-start',
  'before-merge',
  'before-learn',
  'before-replace',
  'manual',
  'unsaved',
];

// Backups are gzip-compressed copies of the budget file (a 4 MB budget becomes about 400 KB).
// Older uncompressed ".budget" backups are still listed and restored.
// Names are "<kind>_<local date and time>.budget.gz", so within a kind they sort by time.
function parseBackupName(file: string): { kind: BackupKind } | null {
  const kind = KINDS.find((k) => file.startsWith(k + '_'));
  return kind && (file.endsWith('.budget.gz') || file.endsWith('.budget')) ? { kind } : null;
}

/** "before-conflict_2026-10-15_142233-2.budget.gz" -> "2026-10-15_142233-2", which sorts by time. */
function stampOf(file: string, kind: BackupKind): string {
  return file.slice(kind.length + 1).replace(/\.budget(\.gz)?$/, '');
}

/**
 * A name not used yet: "<base>.budget.gz", then "<base>-2.budget.gz" and so on (two backups in one
 * second). Taken there and then (an empty file, replaced by the backup), so two backups made at
 * the same moment can't both choose it (1.5.3).
 */
async function freeName(dir: string, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const name = `${base}${n === 1 ? '' : '-' + n}.budget.gz`;
    try {
      await (await fs.open(path.join(dir, name), 'wx')).close();
      return name;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

export async function createBackup(
  root: string,
  budgetId: string,
  budgetName: string,
  kind: BackupKind,
  text: string,
): Promise<BackupInfo> {
  // The kind becomes part of the file name, so only known kinds are allowed.
  if (!KINDS.includes(kind)) throw new Error('Unknown kind of backup.');
  const dir = backupDir(root, budgetId);
  await fs.mkdir(dir, { recursive: true });
  const name = kind === 'daily' ? `daily_${localDate()}.budget.gz` : await freeName(dir, `${kind}_${stampForName()}`);
  const file = path.join(dir, name);
  // Like the budget itself: write to a temporary file, then put it in place. Its own temporary
  // name, as two backups can be made at once (the daily one on opening and after the first save).
  const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(tmp, gzipSync(Buffer.from(text, 'utf8')));
    // A backup that can't be read back is worse than none (it looks safe): check it first.
    if (gunzipSync(await fs.readFile(tmp)).toString('utf8') !== text) throw new Error('The backup did not read back correctly.');
    await renameWithRetry(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    // The name taken for it, still empty.
    if (kind !== 'daily') await fs.rm(file, { force: true }).catch(() => {});
    throw e;
  }
  await fs.writeFile(path.join(dir, 'budget-name.txt'), budgetName, 'utf8');
  await prune(dir, name);
  const s = await fs.stat(file);
  return { file: name, kind, date: s.mtime.toISOString(), size: s.size };
}

export async function ensureDailyBackup(root: string, budgetId: string, budgetName: string, text: string): Promise<boolean> {
  const dir = backupDir(root, budgetId);
  try {
    await fs.access(path.join(dir, `daily_${localDate()}.budget.gz`));
    return false;
  } catch {
    await createBackup(root, budgetId, budgetName, 'daily', text);
    return true;
  }
}

export async function listBackups(root: string, budgetId: string): Promise<BackupInfo[]> {
  const dir = backupDir(root, budgetId);
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const file of names) {
    const info = parseBackupName(file);
    if (!info) continue;
    // A backup pruned while listing is skipped, not the whole list (1.5.11).
    const s = await fs.stat(path.join(dir, file)).catch(() => null);
    if (!s) continue;
    // An empty file is a name taken for a backup still being written (freeName).
    if (s.size === 0) continue;
    out.push({ file, kind: info.kind, date: s.mtime.toISOString(), size: s.size });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

// ---- A copy of the backups somewhere else (a USB stick, another drive) ---------------------

const KEEP_COPIES = 30;

/** The folder in `dest` that holds one budget's copied backups: "<name> (<id>)". */
export function copyDir(dest: string, budgetId: string, budgetName: string): string {
  const name = budgetName.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60) || 'Budget';
  return path.join(dest, 'MyBudgetBackups', `${name} (${safeId(budgetId).slice(0, 8)})`);
}

/**
 * Copies one backup to `dest` (keeping the 30 newest daily ones there, and 10 of each other kind), so a copy survives if this
 * laptop's disk fails. Written via a temporary file, like every backup.
 */
export async function copyBackup(root: string, budgetId: string, budgetName: string, file: string, dest: string): Promise<void> {
  if (!parseBackupName(file) || file.includes('/') || file.includes('\\')) throw new Error('Not a backup file');
  const to = copyDir(dest, budgetId, budgetName);
  await fs.mkdir(to, { recursive: true });
  try {
    await fs.access(path.join(to, file));
    return; // already copied
  } catch {
    // Not there yet.
  }
  await fs.copyFile(path.join(backupDir(root, budgetId), file), path.join(to, file + '.tmp'));
  await renameWithRetry(path.join(to, file + '.tmp'), path.join(to, file));
  // Each kind kept apart, newest first by the time in the name: sorted by whole name, "manual_…"
  // came after "daily_…", and a run of saved-by-you copies pushed out every daily one (1.5.3).
  const byKind = new Map<BackupKind, string[]>();
  for (const n of await fs.readdir(to)) {
    const p = parseBackupName(n);
    if (p) byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), n]);
  }
  for (const [kind, names] of byKind) {
    names.sort((x, y) => (stampOf(x, kind) < stampOf(y, kind) ? 1 : -1));
    for (const n of names.slice(kind === 'daily' ? KEEP_COPIES : 10)) if (n !== file) await fs.rm(path.join(to, n), { force: true });
  }
}

/** Every budget that has backups, newest first: for restoring a budget that won't open. */
export async function listBackupFolders(root: string): Promise<BackupFolder[]> {
  let dirs: string[] = [];
  try {
    dirs = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: BackupFolder[] = [];
  for (const id of dirs) {
    const backups = await listBackups(root, id);
    if (!backups.length) continue;
    let name = id;
    try {
      name = (await fs.readFile(path.join(root, id, 'budget-name.txt'), 'utf8')).trim() || id;
    } catch {
      // An older folder without its name.
    }
    out.push({ id, name, count: backups.length, latest: backups[0].date });
  }
  return out.sort((a, b) => (a.latest < b.latest ? 1 : -1));
}

export async function readBackup(root: string, budgetId: string, file: string): Promise<string> {
  if (!parseBackupName(file) || file.includes('/') || file.includes('\\')) throw new Error('Not a backup file');
  const data = await fs.readFile(path.join(backupDir(root, budgetId), file));
  return (file.endsWith('.gz') ? gunzipSync(data) : data).toString('utf8');
}

/** Keeps the newest KEEP[kind] backups of each kind, by the time in the name. Never deletes `keep`. */
async function prune(dir: string, keep: string): Promise<void> {
  const byKind = new Map<BackupKind, string[]>();
  for (const n of await fs.readdir(dir)) {
    const kind = parseBackupName(n)?.kind;
    if (kind) byKind.set(kind, [...(byKind.get(kind) ?? []), n]);
  }
  for (const [kind, names] of byKind) {
    names.sort((a, b) => (stampOf(a, kind) < stampOf(b, kind) ? 1 : -1)); // newest first
    for (const n of names.slice(KEEP[kind])) if (n !== keep) await fs.rm(path.join(dir, n), { force: true });
  }
}

// ---- Recent budgets --------------------------------------------------------------------------

export async function readRecent(file: string): Promise<RecentBudget[]> {
  try {
    const list = JSON.parse(await fs.readFile(file, 'utf8')) as RecentBudget[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Writes a small settings file whole or not at all (a temporary file, then a rename), so a
 * crash can't leave it half written (1.5.3).
 */
export async function writeTextAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(tmp, text, 'utf8');
    await renameWithRetry(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export async function addRecent(file: string, budgetPath: string, name: string): Promise<void> {
  const list = (await readRecent(file)).filter((r) => r.path.toLowerCase() !== budgetPath.toLowerCase());
  list.unshift({ path: budgetPath, name, openedAt: new Date().toISOString() });
  await writeTextAtomic(file, JSON.stringify(list.slice(0, 12), null, 2));
}

export async function removeRecent(file: string, budgetPath: string): Promise<void> {
  const list = (await readRecent(file)).filter((r) => r.path.toLowerCase() !== budgetPath.toLowerCase());
  await writeTextAtomic(file, JSON.stringify(list, null, 2));
}
