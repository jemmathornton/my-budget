// Saving, conflicts, backups and leaving a budget, with a fake window.api (in-memory files).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newBudget, serializeBudget } from '../../src/model/budget';
import { setBudgeted } from '../../src/model/ops';
import type { Budget } from '../../src/model/types';
import type { BackupKind, FileStamp, MyBudgetApi, WriteResult } from '../../src/shared/api';
import type { LeaveQuestion } from '../../src/state/persistence';

type Persistence = typeof import('../../src/state/persistence');
type Store = typeof import('../../src/state/store')['store'];

interface FakeApi extends Partial<MyBudgetApi> {
  files: Map<string, { text: string; stamp: FileStamp }>;
  writes: { path: string; text: string; expected: FileStamp | null }[];
  backups: { kind: BackupKind; text: string }[];
  /** What the next write does instead of writing. */
  nextWrite: ('conflict' | 'error' | 'hang')[];
  failBackup: boolean;
  fileChanged?: (path: string) => void;
  closeRequested?: () => void;
  calls: string[];
  /** What the page told the main process about unsaved work, in order (1.5.4). */
  unsaved: boolean[];
}

function fakeApi(): FakeApi {
  let clock = 1000;
  const api: FakeApi = {
    files: new Map(),
    writes: [],
    backups: [],
    nextWrite: [],
    failBackup: false,
    calls: [],
    unsaved: [],
  };
  const put = (path: string, text: string) => {
    const stamp = { mtimeMs: ++clock, size: text.length, hash: 'h' + text.length + ':' + text };
    api.files.set(path, { text, stamp });
    return stamp;
  };
  Object.assign(api, {
    readBudget: async (path: string) => {
      const f = api.files.get(path);
      if (!f) throw new Error('ENOENT: no such file');
      return { text: f.text, stamp: f.stamp };
    },
    statBudget: async (path: string) => api.files.get(path)?.stamp ?? null,
    writeBudget: (path: string, text: string, expected: FileStamp | null): Promise<WriteResult> => {
      const mode = api.nextWrite.shift();
      if (mode === 'hang') return new Promise(() => {});
      api.writes.push({ path, text, expected });
      if (mode === 'conflict') return Promise.resolve({ ok: false, reason: 'conflict', stamp: null });
      if (mode === 'error') return Promise.resolve({ ok: false, reason: 'error', message: 'The file is in use' });
      const now = api.files.get(path)?.stamp;
      if (expected && now && (now.mtimeMs !== expected.mtimeMs || now.size !== expected.size)) {
        return Promise.resolve({ ok: false, reason: 'conflict', stamp: now });
      }
      return Promise.resolve({ ok: true, stamp: put(path, text) });
    },
    watchBudget: async () => {},
    addRecentBudget: async () => {},
    ensureDailyBackup: async () => {
      api.calls.push('ensureDailyBackup');
      return false;
    },
    createBackup: async (_id: string, _name: string, kind: BackupKind, text: string) => {
      if (api.failBackup) throw new Error('Disk full');
      api.backups.push({ kind, text });
      return { file: kind + '_x.budget.gz', kind, date: new Date().toISOString(), size: text.length };
    },
    readBackup: async () => serializeBudget(newBudget('Restored', false)),
    onBudgetFileChanged: (cb: (p: string) => void) => {
      api.fileChanged = cb;
      return () => {};
    },
    onCloseRequested: (cb: () => void) => {
      api.closeRequested = cb;
      return () => {};
    },
    onSessionEnding: () => () => {},
    closeAck: () => api.calls.push('closeAck'),
    confirmClose: () => api.calls.push('confirmClose'),
    closeCancelled: () => api.calls.push('closeCancelled'),
    setUnsaved: (v: boolean) => api.unsaved.push(v),
    saveBudgetDialog: async () => 'C:/copy.budget',
  });
  (api as unknown as { _put: typeof put })._put = put;
  return api;
}

let api: FakeApi;
let p: Persistence;
let store: Store;
let ask: ReturnType<typeof vi.fn<(q: LeaveQuestion) => Promise<boolean>>>;
let reloaded: ReturnType<typeof vi.fn<(msg: string) => void>>;
const PATH = 'C:/budgets/Test.budget';

beforeEach(async () => {
  vi.useFakeTimers();
  // Mid-morning, so an hour's wait never crosses midnight (that would make a new daily backup).
  vi.setSystemTime(new Date(2026, 9, 15, 10, 0));
  vi.resetModules(); // fresh module state: status, stamp, timers, drafts, and the store
  api = fakeApi();
  (globalThis as { window?: unknown }).window = { api };
  p = await import('../../src/state/persistence');
  store = (await import('../../src/state/store')).store;
  ask = vi.fn(async (_q: LeaveQuestion) => false);
  reloaded = vi.fn((_msg: string) => {});
  p.initPersistence({ onExternalReload: reloaded, askBeforeLeaving: ask });
  (api as unknown as { _put: (path: string, text: string) => FileStamp })._put(PATH, serializeBudget(newBudget('Test', true)));
  await p.openBudgetFile(PATH);
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
});

const b = () => store.budget as Budget;
const cat = () => Object.keys(b().categories)[0];
const change = (amount = 1234) => store.update('Budget', (d) => setBudgeted(d, '2026-10', cat(), amount));
const state = () => p.saveStatus.get().state;
const saved = () => JSON.parse(api.files.get(PATH)!.text) as Budget;

describe('autosave', () => {
  it('saves 700 ms after a change, with the last stamp, then makes the daily backup', async () => {
    change();
    expect(state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(699);
    expect(api.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0].expected).not.toBeNull();
    expect(state()).toBe('saved');
    expect(saved().months['2026-10'][cat()].budgeted).toBe(1234);
    expect(api.calls).toContain('ensureDailyBackup');
  });

  it('makes the daily backup once a day, and an hourly one while editing', async () => {
    const daily = () => api.calls.filter((c) => c === 'ensureDailyBackup').length;
    expect(daily()).toBe(1); // on opening
    change(1);
    await vi.advanceTimersByTimeAsync(700);
    change(2);
    await vi.advanceTimersByTimeAsync(700);
    expect(daily()).toBe(1);
    expect(api.backups.filter((x) => x.kind === 'hourly')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    change(3);
    await vi.advanceTimersByTimeAsync(700);
    const hourly = api.backups.filter((x) => x.kind === 'hourly');
    expect(hourly).toHaveLength(1);
    expect(JSON.parse(hourly[0].text).months['2026-10'][cat()].budgeted).toBe(3);
    change(4);
    await vi.advanceTimersByTimeAsync(700);
    expect(api.backups.filter((x) => x.kind === 'hourly')).toHaveLength(1);
  });

  it('saves several quick changes in one write', async () => {
    change(1);
    await vi.advanceTimersByTimeAsync(300);
    change(2);
    change(3);
    await vi.advanceTimersByTimeAsync(700);
    expect(api.writes).toHaveLength(1);
    expect(saved().months['2026-10'][cat()].budgeted).toBe(3);
  });

  it('stops saving after a conflict', async () => {
    api.nextWrite.push('conflict');
    change();
    await vi.advanceTimersByTimeAsync(700);
    expect(state()).toBe('conflict');
    change(5);
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.writes).toHaveLength(1);
  });

  it('retries after a save error and clears the error when it works', async () => {
    api.nextWrite.push('error');
    change();
    await vi.advanceTimersByTimeAsync(700);
    expect(state()).toBe('error');
    expect(p.saveStatus.get().error).toBe('The file is in use');
    await vi.advanceTimersByTimeAsync(5000);
    expect(state()).toBe('saved');
    expect(p.saveStatus.get().error).toBeUndefined();
  });

  it('reloads the file when another program changed it and nothing is unsaved here', async () => {
    const other = newBudget('Changed elsewhere', false);
    (api as unknown as { _put: (path: string, text: string) => FileStamp })._put(PATH, serializeBudget(other));
    await api.fileChanged!(PATH);
    await vi.advanceTimersByTimeAsync(0);
    expect(b().name).toBe('Changed elsewhere');
    expect(state()).toBe('saved');
  });

  it('ignores a file whose time changed but whose contents are the same', async () => {
    change();
    const f = api.files.get(PATH)!;
    // Before the autosave: another program only touched the file.
    api.files.set(PATH, { text: f.text, stamp: { ...f.stamp, mtimeMs: f.stamp.mtimeMs + 5000 } });
    await api.fileChanged!(PATH);
    await vi.advanceTimersByTimeAsync(0);
    expect(state()).toBe('pending');
    expect(reloaded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);
    expect(state()).toBe('saved');
  });

  it('shows a conflict instead when there are unsaved changes here', async () => {
    change();
    (api as unknown as { _put: (path: string, text: string) => FileStamp })._put(PATH, serializeBudget(newBudget('Other', false)));
    await api.fileChanged!(PATH);
    await vi.advanceTimersByTimeAsync(0);
    expect(state()).toBe('conflict');
    expect(b().name).toBe('Test');
  });
});

describe('resolving a conflict', () => {
  async function conflict() {
    api.nextWrite.push('conflict');
    change();
    await vi.advanceTimersByTimeAsync(700);
    expect(state()).toBe('conflict');
  }

  it('Keep this version backs up the file’s version, then overwrites it', async () => {
    await conflict();
    const theirs = api.files.get(PATH)!.text;
    await p.keepMine();
    expect(api.backups).toEqual([{ kind: 'before-conflict', text: theirs }]);
    expect(saved().months['2026-10'][cat()].budgeted).toBe(1234);
    expect(state()).toBe('saved');
  });

  it('Keep this version overwrites nothing when the backup fails', async () => {
    await conflict();
    const theirs = api.files.get(PATH)!.text;
    api.failBackup = true;
    const writes = api.writes.length;
    await expect(p.keepMine()).rejects.toThrow('Disk full');
    expect(api.writes).toHaveLength(writes);
    expect(api.files.get(PATH)!.text).toBe(theirs);
    expect(state()).toBe('conflict');
  });

  it('Keep this version writes the file when it has gone (nothing to lose)', async () => {
    await conflict();
    api.files.delete(PATH);
    await p.keepMine();
    expect(api.backups).toHaveLength(0);
    expect(api.writes.at(-1)!.expected).toBeNull();
    expect(state()).toBe('saved');
  });

  it("Use the file's version doesn't load it if this window's version can't be backed up", async () => {
    await conflict();
    api.failBackup = true;
    await expect(p.useFileVersion()).rejects.toThrow();
    expect(b().months['2026-10'][cat()].budgeted).toBe(1234);
  });

  it('refuses to restore a backup during a conflict', async () => {
    await conflict();
    await expect(p.restoreBackup('daily_x.budget.gz')).rejects.toThrow(/conflict/);
    expect(b().name).toBe('Test');
  });
});

describe('flush', () => {
  it('saves text still being typed before writing', async () => {
    p.registerDraft(() => store.update('Month note', (d) => ((d.monthNotes ??= {})['2026-10'] = 'typed')));
    await p.flush();
    expect(api.writes).toHaveLength(1);
    expect(saved().monthNotes?.['2026-10']).toBe('typed');
  });

  it('stops calling a draft once it has been unregistered', async () => {
    const draft = vi.fn();
    const off = p.registerDraft(draft);
    off();
    await p.flush();
    expect(draft).not.toHaveBeenCalled();
  });
});

describe('leaving a budget', () => {
  it('goes straight ahead when everything is saved', async () => {
    change();
    expect(await p.prepareToLeave('close')).toBe(true);
    expect(api.backups).toHaveLength(0);
    expect(ask).not.toHaveBeenCalled();
    expect(saved().months['2026-10'][cat()].budgeted).toBe(1234);
  });

  it("during a conflict, keeps this window's version as an 'unsaved' backup and asks", async () => {
    api.nextWrite.push('conflict');
    change();
    await vi.advanceTimersByTimeAsync(700);
    ask.mockResolvedValueOnce(true);
    expect(await p.prepareToLeave('close')).toBe(true);
    expect(api.backups).toEqual([{ kind: 'unsaved', text: serializeBudget(b()) }]);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ reason: 'close', state: 'conflict', backedUp: true }));
  });

  it('after a save error, tries again before asking', async () => {
    api.nextWrite.push('error');
    change();
    await vi.advanceTimersByTimeAsync(700);
    expect(state()).toBe('error');
    expect(await p.prepareToLeave('close')).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(state()).toBe('saved');
  });

  it('asks, saying no backup was made, when the backup fails too', async () => {
    api.nextWrite.push('error', 'error', 'error', 'error');
    api.failBackup = true;
    change();
    await vi.advanceTimersByTimeAsync(700);
    expect(await p.prepareToLeave('switch')).toBe(false);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ reason: 'switch', state: 'error', backedUp: false }));
  });

  it('asks after 10 seconds when a save never finishes', async () => {
    api.nextWrite.push('hang');
    change();
    const leaving = p.prepareToLeave('close');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await leaving).toBe(false);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ state: 'saving', backedUp: true }));
  });

  it("doesn't open another budget when the answer is no", async () => {
    api.nextWrite.push('conflict');
    change();
    await vi.advanceTimersByTimeAsync(700);
    (api as unknown as { _put: (path: string, text: string) => FileStamp })._put('C:/Other.budget', serializeBudget(newBudget('Other', false)));
    expect(await p.openBudgetFile('C:/Other.budget')).toBeNull();
    expect(b().name).toBe('Test');
    expect(p.saveStatus.get().path).toBe(PATH);
  });

  it("doesn't close the budget when the answer is no", async () => {
    api.nextWrite.push('conflict');
    change();
    await vi.advanceTimersByTimeAsync(700);
    expect(await p.closeBudget()).toBe(false);
    expect(store.budget).not.toBeNull();
  });

  it('closing the window acknowledges at once, then closes when everything is saved', async () => {
    change();
    await api.closeRequested!();
    expect(api.calls.filter((c) => c.startsWith('close') || c === 'confirmClose')).toEqual(['closeAck', 'confirmClose']);
    expect(saved().months['2026-10'][cat()].budgeted).toBe(1234);
  });

  it('closing the window during a conflict asks, and stays open if told to', async () => {
    api.nextWrite.push('conflict');
    change();
    await vi.advanceTimersByTimeAsync(700);
    await api.closeRequested!();
    expect(api.calls).toContain('closeCancelled');
    expect(api.calls).not.toContain('confirmClose');
    expect(api.backups.map((x) => x.kind)).toEqual(['unsaved']);
  });

  it('gives a saved copy its own budget id, and makes its own daily backup (1.4.5)', async () => {
    const before = b().id;
    change(3);
    await vi.advanceTimersByTimeAsync(700);
    expect(await p.saveBudgetAs()).toBe('C:/copy.budget');
    // Undo still works in the copy.
    expect(store.canUndo()).toBe(true);
    const copy = JSON.parse(api.files.get('C:/copy.budget')!.text) as Budget;
    expect(copy.id).not.toBe(before);
    expect(b().id).toBe(copy.id);
    // The original file keeps its id.
    expect(saved().id).toBe(before);
    const daily = api.calls.filter((c) => c === 'ensureDailyBackup').length;
    change(5);
    await vi.advanceTimersByTimeAsync(700);
    expect(api.writes.at(-1)!.path).toBe('C:/copy.budget');
    expect(api.calls.filter((c) => c === 'ensureDailyBackup').length).toBe(daily + 1);
  });
});

describe('telling Windows whether a shutdown should wait (1.5.4)', () => {
  const last = () => api.unsaved[api.unsaved.length - 1];

  it('says unsaved from a change until it is saved', async () => {
    expect(last()).toBe(false);
    change();
    expect(last()).toBe(true);
    await vi.advanceTimersByTimeAsync(800);
    await p.flush();
    expect(state()).toBe('saved');
    expect(last()).toBe(false);
  });

  it('says unsaved while a save is failing', async () => {
    api.nextWrite.push('error', 'error', 'error');
    change();
    await vi.advanceTimersByTimeAsync(800);
    expect(state()).toBe('error');
    expect(last()).toBe(true);
  });

  it('says unsaved until a backup after the save is finished', async () => {
    // An hour on, the next save makes an hourly backup; hold it half made.
    vi.setSystemTime(new Date(2026, 9, 15, 11, 5));
    let finish: () => void = () => {};
    api.createBackup = (_id, _name, kind) =>
      new Promise((resolve) => {
        finish = () => resolve({ file: kind + '_x.budget.gz', kind, date: new Date().toISOString(), size: 1 });
      });
    change();
    await vi.advanceTimersByTimeAsync(800);
    expect(state()).toBe('saved');
    expect(last()).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toBe(false);
  });

  it('says unsaved while a transaction is being entered, but not for a note box left open', () => {
    const offNote = p.registerDraft(() => {});
    expect(last()).toBe(false);
    const offTx = p.registerDraft(() => {}, { open: true });
    expect(last()).toBe(true);
    offTx();
    expect(last()).toBe(false);
    offNote();
    // Only changes are sent.
    expect(api.unsaved.filter((v, i, a) => i > 0 && v === a[i - 1])).toEqual([]);
  });
});
