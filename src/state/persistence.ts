import { useSyncExternalStore } from 'react';
import { parseBudgetFile, serializeBudget } from '../model/budget';
import { categoryHistory, guessIndex } from '../model/guess';
import { newId } from '../model/ids';
import { enterDueScheduled } from '../model/ops';
import type { Budget } from '../model/types';
import type { FileStamp } from '../shared/api';
import { store } from './store';
import { prefStore, ui } from './ui';

// Saving. The open budget lives in a .budget file. Every change is written to it
// shortly afterwards (atomically, by the main process), and a copy is kept in the daily
// backups. If the file is changed by something else (for example OneDrive syncing a
// change made on another computer), the user is asked which version to keep and the
// other one is backed up.

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';

export interface SaveStatus {
  state: SaveState;
  path: string | null;
  savedAt?: string;
  error?: string;
}

const SAVE_DELAY_MS = 700;
/** While editing, a backup at most once an hour (on top of the daily one). */
const HOURLY_MS = 60 * 60 * 1000;
/** How long to wait for a save when closing or switching budget before asking. */
const LEAVE_WAIT_MS = 10_000;

let status: SaveStatus = { state: 'idle', path: null };
let stamp: FileStamp | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();
/** Backups started after a save, so closing can wait for them (1.5.3). */
const pendingBackups = new Set<Promise<void>>();

function startBackup(b: Budget, text: string): void {
  const p: Promise<void> = backupAfterSave(b, text)
    .catch(() => {})
    .finally(() => {
      pendingBackups.delete(p);
      reportUnsaved();
    });
  pendingBackups.add(p);
  reportUnsaved();
}
const listeners = new Set<() => void>();
/** The day of the last daily backup of the open budget, and when its last backup of any kind was made. */
let dailyDoneOn = '';
let lastBackupAt = 0;

export type LeaveReason = 'close' | 'switch';

/** Why the budget can't be left safely, for the question shown to the user. */
export interface LeaveQuestion {
  reason: LeaveReason;
  /** 'draft': a transaction still being entered can't be saved (error says why). */
  state: 'conflict' | 'error' | 'saving' | 'draft';
  error?: string;
  savedAt?: string;
  /** True if this window's version was kept as an "unsaved" backup. */
  backedUp: boolean;
}

export interface PersistenceHooks {
  /** A message to show when the file was reloaded because another program changed it. */
  onExternalReload: (msg: string) => void;
  /** A daily or hourly backup couldn't be made (said at most once a day, 1.5.11). */
  onBackupFailed?: (msg: string) => void;
  /** Asks whether to close or switch anyway. Resolves true to go ahead. */
  askBeforeLeaving: (q: LeaveQuestion) => Promise<boolean>;
}

let hooks: PersistenceHooks = { onExternalReload: () => {}, askBeforeLeaving: async () => true };

/**
 * Text being typed that isn't in the budget yet (notes, a transaction). flush() saves it first.
 * A draft that can't be saved (an amount that can't be read, say) returns why.
 */
const drafts = new Set<() => string | void>();
/** Drafts open even when no box has the keyboard (a transaction being entered). */
const openDrafts = new Set<() => string | void>();

export function registerDraft(flushDraft: () => string | void, opts?: { open?: boolean }): () => void {
  drafts.add(flushDraft);
  if (opts?.open) openDrafts.add(flushDraft);
  reportUnsaved();
  return () => {
    drafts.delete(flushDraft);
    openDrafts.delete(flushDraft);
    reportUnsaved();
  };
}

function setStatus(patch: Partial<SaveStatus>): void {
  status = { ...status, ...patch };
  listeners.forEach((l) => l());
  reportUnsaved();
}

/** The box with the keyboard, if it's one that's typed into. */
function editingBox(): HTMLElement | null {
  const el = typeof document === 'undefined' ? null : document.activeElement;
  return el && el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) ? el : null;
}

/**
 * Whether anything here may not be in the budget file yet: a save waiting or failed, a backup
 * being made, a box being typed in, or a transaction being entered. Windows shutting down is held
 * only then (1.5.4).
 */
export function hasUnsaved(): boolean {
  if (!status.path) return false;
  return (status.state !== 'saved' && status.state !== 'idle') || pendingBackups.size > 0 || openDrafts.size > 0 || typingIn(editingBox());
}

/** A box whose text goes into the budget when it's left. Lists, ticks and the register search don't. */
function typingIn(el: HTMLElement | null): boolean {
  if (!el || el.tagName === 'SELECT') return false;
  if (el instanceof HTMLInputElement) {
    return !el.classList.contains('search') && !['checkbox', 'radio', 'range', 'button', 'submit', 'file', 'color'].includes(el.type);
  }
  return true;
}

let reported: boolean | null = null;
function reportUnsaved(): void {
  const now = hasUnsaved();
  if (now === reported || typeof window === 'undefined' || !window.api?.setUnsaved) return;
  reported = now;
  window.api.setUnsaved(now);
}

export const saveStatus = {
  get: (): SaveStatus => status,
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useSaveStatus(): SaveStatus {
  return useSyncExternalStore(saveStatus.subscribe, saveStatus.get);
}

/** Called once at start-up. */
export function initPersistence(h: PersistenceHooks): void {
  hooks = h;
  // The keyboard moving in or out of a box changes hasUnsaved(); look once focus has settled.
  const focusMoved = () => setTimeout(reportUnsaved, 0);
  if (typeof document !== 'undefined') {
    document.addEventListener('focusin', focusMoved);
    document.addEventListener('focusout', focusMoved);
  }
  reportUnsaved();
  store.onChange(() => {
    if (!status.path) return;
    if (status.state !== 'conflict') setStatus({ state: 'pending' });
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void saveNow(), SAVE_DELAY_MS);
  });

  // One check at a time: the watcher and the window's focus can both ask at once, and two
  // checks of the same change made a false conflict after the first reloaded (1.5.11).
  let checking: Promise<void> = Promise.resolve();
  window.api.onBudgetFileChanged((path) => {
    checking = checking.then(() => fileChanged(path)).catch(() => {});
  });
  const fileChanged = async (path: string) => {
    if (path !== status.path || !stamp) return;
    const now = await window.api.statBudget(path);
    if (!now || (now.mtimeMs === stamp.mtimeMs && now.size === stamp.size)) return;
    let read: { text: string; stamp: FileStamp };
    try {
      read = await window.api.readBudget(path);
    } catch {
      return; // A half-synced file; the next change event will try again.
    }
    // Only the file's time changed (OneDrive or antivirus touched it): nothing to do.
    if (stamp.hash && read.stamp.hash === stamp.hash) {
      stamp = read.stamp;
      return;
    }
    if (status.state === 'saved' || status.state === 'idle') {
      // No unsaved changes here: just load the newer file.
      try {
        const b = parseBudgetFile(read.text);
        // Keep this window's version first: the reload can't be undone, and the newer file may
        // be an older copy put back by a sync (1.5.11).
        const mine = store.budget;
        if (!mine) return;
        try {
          // Its own kind, so reloads don't push out the backups made when resolving a conflict.
          await window.api.createBackup(mine.id, mine.name, 'before-reload', serializeBudget(mine));
        } catch {
          setStatus({ state: 'conflict' });
          return;
        }
        // Something changed while the backup was made: that's a conflict now, not a reload.
        if (path !== status.path || store.budget !== mine || (status.state !== 'saved' && status.state !== 'idle')) {
          if (path === status.path) setStatus({ state: 'conflict' });
          return;
        }
        stamp = read.stamp;
        store.replace(b);
        hooks.onExternalReload('The budget file was changed by another program, so it has been reloaded.');
      } catch {
        // A half-synced file; the next change event will try again.
      }
    } else if (path === status.path) {
      setStatus({ state: 'conflict' });
    }
  };

  let leaving = false;
  window.api.onCloseRequested(async () => {
    // Tell the main process the page is handling it, so it doesn't close on its own.
    window.api.closeAck();
    if (leaving) return; // already asking
    leaving = true;
    try {
      if (await prepareToLeave('close')) window.api.confirmClose();
      else window.api.closeCancelled();
    } catch (e) {
      // Something unexpected: keep this window's version, stay open and say so, rather than
      // leaving the close half done (1.5.3).
      await backupUnsaved();
      window.api.closeCancelled();
      hooks.onExternalReload(`Couldn't finish saving before closing (${e instanceof Error ? e.message : String(e)}). A copy was kept in the backups; try closing again.`);
    } finally {
      leaving = false;
    }
  });

  // Windows is shutting down or restarting: there's no time to ask, so save what can be saved.
  window.api.onSessionEnding(async () => {
    try {
      await flush();
      if (status.state !== 'saved' && status.state !== 'idle') await backupUnsaved();
    } finally {
      // Lets Windows carry on shutting down (the main process held it for this), 1.5.3.
      window.api.confirmClose();
    }
  });
}

/**
 * Saves anything waiting to be saved, including text still being typed: a box with the keyboard
 * (a budget cell saves when it loses it, which closing the window, Windows shutting down or
 * Ctrl+O never do, 1.5.3), then drafts (notes, a transaction half entered). Resolves with why
 * any draft couldn't be saved.
 */
export async function flush(): Promise<string[]> {
  const unsaved = await flushDrafts();
  // A change can arrive while a save is running; go round a few times until nothing is waiting.
  for (let round = 0; round < 3; round++) {
    if (!timer) break;
    clearTimeout(timer);
    timer = null;
    await saveNow();
  }
  await chain;
  // A backup started by the last save (an hourly one, a daily one after midnight) finishes before
  // the app closes, or it could be lost half made (1.5.3).
  await Promise.all([...pendingBackups]);
  return unsaved;
}

/** The first half of flush(): the box with the keyboard, then the drafts, into the budget (not yet saved). */
async function flushDrafts(): Promise<string[]> {
  const el = editingBox();
  if (el) {
    el.blur();
    await new Promise((r) => setTimeout(r, 0));
  }
  const unsaved: string[] = [];
  for (const f of [...drafts]) {
    const why = f();
    if (why) unsaved.push(why);
  }
  return unsaved;
}

/** Saves; if that isn't possible, keeps this window's version as an "unsaved" backup. Never asks. */
export async function saveOrBackUp(): Promise<void> {
  await flush();
  if (status.path && status.state !== 'saved' && status.state !== 'idle') await backupUnsaved();
}

/** Keeps this window's version as an "unsaved" backup. Resolves false if that fails too. */
async function backupUnsaved(): Promise<boolean> {
  const b = store.budget;
  if (!b) return false;
  try {
    await window.api.createBackup(b.id, b.name, 'unsaved', serializeBudget(b));
    return true;
  } catch {
    return false;
  }
}

/**
 * Before closing the window or opening another budget. Saves; if that isn't possible (a conflict,
 * a save error, or a save taking too long), keeps this window's version as an "unsaved" backup
 * and asks. Resolves true if it's all right to go ahead.
 */
export async function prepareToLeave(reason: LeaveReason): Promise<boolean> {
  if (!status.path || !store.budget) return true;
  // A transaction still being entered that can't be saved: ask first, rather than lose it
  // (night seven). The drafts don't wait for the file, so this comes before any slow save.
  const unsaved = await flushDrafts();
  if (unsaved.length && !(await hooks.askBeforeLeaving({ reason, state: 'draft', error: unsaved.join(' '), backedUp: false }))) return false;
  let waited: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([
    flush().then(() => true),
    new Promise<boolean>((r) => (waited = setTimeout(() => r(false), LEAVE_WAIT_MS))),
  ]);
  clearTimeout(waited);
  if (done && (status.state === 'saved' || status.state === 'idle')) return true;
  const state = done && (status.state === 'conflict' || status.state === 'error') ? status.state : 'saving';
  const backedUp = await backupUnsaved();
  return hooks.askBeforeLeaving({ reason, state, error: status.error, savedAt: status.savedAt, backedUp });
}

/** Writes the budget to its file now. */
export function saveNow(force = false): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  chain = chain.then(async () => {
    const b = store.budget;
    const path = status.path;
    if (!b || !path) return;
    if (status.state === 'conflict' && !force) return;
    setStatus({ state: 'saving' });
    const text = serializeBudget(b);
    const r = await window.api.writeBudget(path, text, force ? null : stamp);
    // Another budget was opened while this save was running ("Leave this budget anyway"): its
    // result belongs to the old file, and its stamp would make the new one's next save look like
    // a conflict (1.5.3).
    if (status.path !== path) return;
    if (r.ok) {
      stamp = r.stamp;
      // Another change may have arrived while saving.
      setStatus({
        state: store.budget === b ? 'saved' : 'pending',
        savedAt: new Date().toISOString(),
        error: undefined,
      });
      if (store.budget !== b && !timer) timer = setTimeout(() => void saveNow(), SAVE_DELAY_MS);
      startBackup(b, text);
    } else if (r.reason === 'conflict') {
      setStatus({ state: 'conflict' });
    } else {
      setStatus({ state: 'error', error: r.message });
      // Try again shortly (e.g. the disk was busy).
      if (!timer) timer = setTimeout(() => void saveNow(), 5000);
    }
  }).catch((e) => {
    // A save that throws (rather than failing) mustn't leave the queue broken, which would stop
    // every later save without a word (1.5.3).
    setStatus({ state: 'error', error: e instanceof Error ? e.message : String(e) });
    if (!timer) timer = setTimeout(() => void saveNow(), 5000);
  });
  return chain;
}

/** The daily backup if today's isn't made yet; otherwise an hourly one while editing. */
async function backupAfterSave(b: Budget, text: string): Promise<void> {
  try {
    const day = new Date().toDateString();
    if (dailyDoneOn !== day) {
      await window.api.ensureDailyBackup(b.id, b.name, text);
      dailyDoneOn = day;
      lastBackupAt = Date.now();
    } else if (Date.now() - lastBackupAt >= HOURLY_MS) {
      lastBackupAt = Date.now();
      await window.api.createBackup(b.id, b.name, 'hourly', text);
    }
  } catch (e) {
    // A failed backup must never stop saving; the next save tries again. Said once a day, so a
    // backup folder that can't be written (a full disk, say) isn't missed for weeks (1.5.11).
    dailyDoneOn = '';
    const day = new Date().toDateString();
    if (backupWarnedOn !== day) {
      backupWarnedOn = day;
      hooks.onBackupFailed?.(
        `Your budget is saved, but its backup couldn't be made (${e instanceof Error ? e.message : String(e)}). Check there's space on the disk; the app will keep trying.`,
      );
    }
  }
}
let backupWarnedOn = '';

/**
 * Opens a budget file. Scheduled transactions that have come due are entered.
 * Throws with a readable message if the file can't be used. Resolves null if the user chose
 * not to leave the budget that is open now (its changes couldn't be saved).
 */
export async function openBudgetFile(path: string): Promise<{ entered: number } | null> {
  if (!(await prepareToLeave('switch'))) return null;
  const { text, stamp: s } = await window.api.readBudget(path);
  const b = parseBudgetFile(text);
  stamp = s;
  status = { state: 'saved', path };
  reportUnsaved();
  store.load(b);
  ui.go({ view: 'budget' });
  // The budget is open now: a failure here (antivirus holding the recent list, say) mustn't turn
  // into "Could not open the budget", or stop scheduled transactions being entered (1.5.3).
  await window.api.watchBudget(path).catch(() => {});
  await window.api.addRecentBudget(path, b.name).catch(() => {});
  prefStore.set({ lastBudgetPath: path });
  dailyDoneOn = '';
  lastBackupAt = Date.now();
  startBackup(b, text);
  let entered = 0;
  store.update('Enter scheduled transactions', (d) => {
    entered = enterDueScheduled(d);
  });
  // Build the category-guessing history and the import guesser's index while the app is idle,
  // so the first register or import doesn't wait for them.
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => {
      if (store.budget) {
        categoryHistory(store.budget);
        guessIndex(store.budget);
      }
    });
  }
  listeners.forEach((l) => l());
  return { entered };
}

/** Saves a budget that isn't in a file yet (new, imported or Fresh Start) and opens it. */
export async function saveNewBudgetAndOpen(b: Budget, suggestedName = b.name): Promise<boolean> {
  const path = await window.api.saveBudgetDialog(suggestedName);
  if (!path) return false;
  const r = await window.api.writeBudget(path, serializeBudget(b), null);
  if (!r.ok) throw new Error(r.reason === 'error' ? r.message : 'Could not save the file.');
  return (await openBudgetFile(path)) !== null;
}

/** "Save a copy as…": writes the budget to a new file and switches to it. */
export async function saveBudgetAs(): Promise<string | null> {
  const b = store.budget;
  if (!b) return null;
  const unsaved = await flush();
  // The copy would be made without it (night seven).
  if (unsaved.length) throw new Error(`${unsaved.join(' ')} Correct it or cancel it first.`);
  const path = await window.api.saveBudgetDialog(b.name);
  if (!path || !store.budget) return null;
  // The copy is a budget of its own, with its own backups (a shared id would share one daily
  // backup). It's made from the budget as it is after the dialog, and undo still works in it.
  const id = newId();
  const r = await window.api.writeBudget(path, serializeBudget({ ...store.budget, id }), null);
  if (!r.ok) throw new Error(r.reason === 'error' ? r.message : 'Could not save the file.');
  store.setId(id);
  dailyDoneOn = '';
  stamp = r.stamp;
  setStatus({ path, state: 'saved', savedAt: new Date().toISOString() });
  await window.api.watchBudget(path);
  await window.api.addRecentBudget(path, b.name);
  prefStore.set({ lastBudgetPath: path });
  return path;
}

/** Closes the open budget. Resolves false if the user chose to keep it open (it couldn't be saved). */
export async function closeBudget(): Promise<boolean> {
  if (!(await prepareToLeave('switch'))) return false;
  await window.api.watchBudget(null);
  stamp = null;
  status = { state: 'idle', path: null };
  reportUnsaved();
  store.load(null);
  prefStore.set({ lastBudgetPath: undefined });
  listeners.forEach((l) => l());
  return true;
}

/**
 * Resolves a conflict by keeping the version in this window. The file's version is backed up
 * first; if that backup fails, nothing is overwritten and this throws.
 */
export async function keepMine(): Promise<void> {
  const path = status.path;
  const b = store.budget;
  if (!path || !b) return;
  let other: string | null = null;
  try {
    other = (await window.api.readBudget(path)).text;
  } catch (e) {
    // Deleted or moved: there's no other version to lose. Anything else (locked by OneDrive or
    // antivirus, say) mustn't be taken for that: overwriting without its backup would lose it (1.5.3).
    if (!/ENOENT|no such file/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }
  if (other !== null) await window.api.createBackup(b.id, b.name, 'before-conflict', other);
  await saveNow(true);
}

/** Resolves a conflict by loading the file's version. This window's version is backed up (throws if it can't be). */
export async function useFileVersion(): Promise<void> {
  const path = status.path;
  const b = store.budget;
  if (!path || !b) return;
  await window.api.createBackup(b.id, b.name, 'before-conflict', serializeBudget(b));
  const { text, stamp: s } = await window.api.readBudget(path);
  stamp = s;
  store.replace(parseBudgetFile(text));
  setStatus({ state: 'saved', savedAt: new Date().toISOString() });
}

/** Replaces the open budget with a backup. The current version is backed up first. */
export async function restoreBackup(file: string): Promise<void> {
  if (!store.budget) return;
  // Restoring force-writes the file, which would throw away the other program's version.
  if (status.state === 'conflict') throw new Error('Resolve the file conflict first (the red bar at the top), then restore.');
  const unsaved = await flush();
  if (unsaved.length) throw new Error(`${unsaved.join(' ')} Correct it or cancel it first.`);
  // As flushed: the safety copy below includes a transaction that was still open (night seven).
  const b = store.budget;
  if (!b) return;
  // Read first: the safety copy below can prune the oldest "before restoring" backup, which may
  // be the very one being restored (1.5.3).
  const restored = parseBudgetFile(await window.api.readBackup(b.id, file));
  await window.api.createBackup(b.id, b.name, 'before-restore', serializeBudget(b));
  restored.id = b.id;
  restored.modifiedAt = new Date().toISOString();
  store.load(restored);
  await saveNow(true);
}
