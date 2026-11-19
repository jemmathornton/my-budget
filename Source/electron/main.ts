import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BackupKind, FileFilter, FileStamp } from '../src/shared/api';
import {
  addRecent,
  backupDir,
  copyBackup,
  createBackup,
  ensureDailyBackup,
  listBackupFolders,
  listBackups,
  readBackup,
  readBudgetFile,
  readRecent,
  removeRecent,
  stat,
  watchFile,
  writeBudgetFile,
  writeTextAtomic,
} from './files';
import { listYnab4Files, readYnab4File } from './ynab4Files';

// The main process: one window, a custom title bar (the app draws its own menus), and
// the file access the window is allowed to ask for. Nothing is ever sent over the network.

const isDev = !!process.env.VITE_DEV_SERVER_URL;
// Tests run with their own settings folder so they never touch the real recent list or backups.
// Only in development and tests (the unpackaged app): in the installed app it would also change
// the single-instance lock, so two copies could open one budget (1.5.3).
if (!app.isPackaged && process.env.MYBUDGET_USER_DATA) app.setPath('userData', process.env.MYBUDGET_USER_DATA);
const userData = app.getPath('userData');
// Tests can answer the file dialogs in advance: { open, save, ynab4, bank, saveText, folder }.
// Only in development and tests (the unpackaged app), never in the installed app.
const testDialogs: Record<string, string | string[] | null> | null = (() => {
  if (app.isPackaged || !process.env.MYBUDGET_TEST_DIALOGS) return null;
  try {
    return JSON.parse(process.env.MYBUDGET_TEST_DIALOGS);
  } catch {
    return null;
  }
})();
// Tests can keep the window off-screen and out of the taskbar, without taking the focus, so
// a test run doesn't keep flashing the app up. Only in the unpackaged app.
const offscreen = !app.isPackaged && process.env.MYBUDGET_TEST_OFFSCREEN === '1';
const canned = (kind: string): string | string[] | null | undefined => (testDialogs && kind in testDialogs ? testDialogs[kind] : undefined);
const backupsRoot = path.join(userData, 'backups');
const recentFile = path.join(userData, 'recent-budgets.json');
const windowStateFile = path.join(userData, 'window-state.json');
/** Settings for this computer (not part of any budget): where to copy backups. */
const settingsFile = path.join(userData, 'settings.json');

interface ComputerSettings {
  backupCopyFolder?: string;
  lastCopied?: string;
  lastCopyError?: string;
}

async function readSettings(): Promise<ComputerSettings> {
  try {
    const s = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

async function writeSettings(s: ComputerSettings): Promise<void> {
  await writeTextAtomic(settingsFile, JSON.stringify(s, null, 2));
}

const backupCopyInfo = (s: ComputerSettings) => ({
  folder: s.backupCopyFolder ?? null,
  lastCopied: s.lastCopied ?? null,
  lastError: s.lastCopyError ?? null,
});

/**
 * Copies the newest daily (and given) backups of a budget to the chosen folder, if one is set.
 * A missing USB stick is noted, never an error for the backup itself.
 */
async function copyBackups(budgetId: string, budgetName: string, files: string[]): Promise<void> {
  const s = await readSettings();
  if (!s.backupCopyFolder || !files.length) return;
  try {
    for (const f of files) await copyBackup(backupsRoot, budgetId, budgetName, f, s.backupCopyFolder);
    s.lastCopied = new Date().toISOString();
    delete s.lastCopyError;
  } catch (e) {
    s.lastCopyError = e instanceof Error ? e.message : String(e);
  }
  // Read again just before writing: "Stop copying" may have been chosen while this copy ran, and
  // must stay chosen (1.5.3).
  const now = await readSettings();
  if (now.backupCopyFolder !== s.backupCopyFolder) return;
  await writeSettings({ ...now, lastCopied: s.lastCopied, lastCopyError: s.lastCopyError });
}

/** The newest daily backup of a budget, if any. */
async function newestDaily(budgetId: string): Promise<string[]> {
  const d = (await listBackups(backupsRoot, budgetId)).find((b) => b.kind === 'daily');
  return d ? [d.file] : [];
}

// ---- What the window may touch ---------------------------------------------------------------
// The window can only ask for budget files the user has opened or chosen here (dialogs, the
// recent list, Documents\MyBudget\Budgets, Explorer), and YNAB4 folders picked in the dialog. So a bug
// in the window can never be used to read or write other files.

const approvedBudgets = new Set<string>();
const approvedYnab4Dirs = new Set<string>();
const pathKey = (p: string) => path.resolve(p).toLowerCase();

function isBudgetPath(p: unknown): p is string {
  return typeof p === 'string' && path.isAbsolute(p) && /\.budget$/i.test(p) && !/^[\\/]{2}[?.][\\/]/.test(p);
}

/** Lets the window use this budget file. Returns it, for chaining. */
function approve<T extends string | null | undefined>(p: T): T {
  if (isBudgetPath(p)) approvedBudgets.add(pathKey(p));
  return p;
}

function isApproved(p: unknown): p is string {
  return isBudgetPath(p) && approvedBudgets.has(pathKey(p));
}

function checkBudget(p: unknown): string {
  if (!isApproved(p)) throw new Error('My Budget can only open budget files you have chosen.');
  return p;
}

function checkYnab4Dir(dir: unknown): string {
  if (typeof dir !== 'string' || !approvedYnab4Dirs.has(pathKey(dir))) throw new Error('Choose the YNAB4 folder first.');
  return dir;
}

let win: BrowserWindow | null = null;
/** The open budget's file, watched for changes by other programs. */
let watchedBudget: string | null = null;
let allowClose = false;
/** Closes the window if the page doesn't acknowledge a close request (it has frozen). */
let closeTimer: NodeJS.Timeout | null = null;
let rendererGone = false;
/** Whether the page has anything that may not be in the budget file yet (it says as that changes), 1.5.4. */
let pageUnsaved = true;
let startupFile: string | null = approve(findBudgetArg(process.argv));

app.setAppUserModelId('com.jemma.mybudget');
// The app draws its own menus; set this before "ready" so the default menu is never built.
Menu.setApplicationMenu(null);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const file = approve(findBudgetArg(argv));
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (file) win.webContents.send('app:openFile', file);
    }
  });
  app.whenReady().then(async () => {
    lockDownSession();
    for (const r of await readRecent(recentFile)) approve(r.path);
    registerIpc();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

/** No permissions (camera, notifications...) and, in the built app, no network requests at all. */
function lockDownSession(): void {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  if (!isDev) {
    s.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !/^(file|devtools|data|blob):/i.test(details.url) });
    });
  }
}

function findBudgetArg(argv: string[]): string | null {
  const arg = argv.slice(1).find((a) => /\.budget$/i.test(a) && !a.startsWith('-'));
  return arg ? path.resolve(arg) : null;
}

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

async function loadWindowState(): Promise<WindowState> {
  try {
    const s = JSON.parse(await fs.readFile(windowStateFile, 'utf8')) as WindowState;
    // Ignore a saved position that is no longer on any screen.
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return s.x !== undefined && s.y !== undefined && s.x >= a.x - 50 && s.y >= a.y - 50 && s.x < a.x + a.width && s.y < a.y + a.height;
    });
    if (!onScreen) {
      delete s.x;
      delete s.y;
    }
    return s;
  } catch {
    // First run: fill the screen. The layout is tuned for a maximised window on a 1600x1000 (200%) display.
    const a = screen.getPrimaryDisplay().workAreaSize;
    return { width: Math.min(1600, a.width), height: Math.min(952, a.height), maximized: true };
  }
}

function saveWindowState(): void {
  if (!win) return;
  const b = win.getNormalBounds();
  const s: WindowState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
  fs.mkdir(userData, { recursive: true })
    .then(() => fs.writeFile(windowStateFile, JSON.stringify(s), 'utf8'))
    .catch(() => {});
}

async function createWindow(): Promise<void> {
  const state = await loadWindowState();
  win = new BrowserWindow({
    x: offscreen ? -30000 : state.x,
    y: offscreen ? -30000 : state.y,
    skipTaskbar: offscreen,
    width: state.width,
    height: state.height,
    minWidth: 980,
    minHeight: 600,
    show: false,
    title: 'My Budget',
    backgroundColor: '#1d3955',
    icon: path.join(__dirname, '../../build/icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1d3955', symbolColor: '#dce7f2', height: 34 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (state.maximized && !offscreen) win.maximize();
  win.once('ready-to-show', () => (offscreen ? win?.showInactive() : win?.show()));

  // The app never navigates away or opens other windows (it has no links).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!isDev || !url.startsWith(process.env.VITE_DEV_SERVER_URL!)) e.preventDefault();
  });

  win.webContents.on('render-process-gone', () => {
    rendererGone = true;
  });
  win.on('close', (e) => {
    saveWindowState();
    if (allowClose || !win || rendererGone) return;
    // Let the app finish saving first (and ask, if it can't); it sends app:confirmClose when done.
    e.preventDefault();
    win.webContents.send('app:closeRequested');
    if (!closeTimer) {
      closeTimer = setTimeout(() => {
        closeTimer = null;
        // Never trap the user: close anyway if the app doesn't even acknowledge (it has frozen).
        if (!allowClose && win && !win.isDestroyed()) {
          allowClose = true;
          win.close();
        }
      }, 8000);
    }
  });
  // Windows shutdown, restart or log-off: before-quit isn't sent, so tell the page to save now.
  win.on('query-session-end', (e) => {
    // Windows is shutting down: hold it a moment while the page saves (it closes the window when
    // done), at most 5 seconds, so the last changes aren't cut off (1.5.3). Only when there's
    // something to save: holding it shows Windows' "preventing shutdown" screen (1.5.4).
    // Settings kept by the page (the last budget, the register's range) are written to disk a
    // moment late; make sure they are, as the window may not be closed properly now.
    void session.defaultSession.flushStorageData();
    if (!pageUnsaved || rendererGone) return;
    e.preventDefault();
    win?.webContents.send('app:sessionEnding');
    setTimeout(() => {
      allowClose = true;
      if (win && !win.isDestroyed()) win.close();
    }, 5000);
  });
  // Coming back to the window: look at the budget file again, in case a change was missed while
  // the folder couldn't be watched (the page compares it with what it saved), 1.5.3.
  win.on('focus', () => {
    if (watchedBudget) win?.webContents.send('budget:fileChanged', watchedBudget);
  });
  win.on('resize', debounce(saveWindowState, 500));
  win.on('move', debounce(saveWindowState, 500));
  win.on('closed', () => {
    win = null;
  });

  if (isDev) await win.loadURL(process.env.VITE_DEV_SERVER_URL!);
  else await win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

function debounce(fn: () => void, ms: number): () => void {
  let t: NodeJS.Timeout | null = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

const BUDGET_FILTERS = [{ name: 'Budget files', extensions: ['budget'] }];

/**
 * A printout (1.5.1), loaded in a hidden window of its own to print or save as a PDF. The page is
 * built by the app from the budget; it runs no scripts and can't reach anything else. It goes
 * through a temporary file, as a long register is too big for a data: address.
 */
async function loadPrintPage(html: string): Promise<BrowserWindow> {
  const dir = await fs.mkdtemp(path.join(app.getPath('temp'), 'mybudget-print-'));
  const page = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  page.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  page.webContents.on('will-navigate', (e) => e.preventDefault());
  const file = path.join(dir, 'printout.html');
  try {
    await fs.writeFile(file, html, 'utf8');
    await page.loadFile(file);
  } catch (e) {
    page.destroy();
    throw e;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  return page;
}

/** Only the app's own page, in its main frame, may use the IPC channels. */
function fromAppWindow(e: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return !!win && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame;
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, (e: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!fromAppWindow(e)) throw new Error('Not allowed');
    return fn(...(args as A));
  });
}

function on<A extends unknown[]>(channel: string, fn: (...args: A) => void): void {
  ipcMain.on(channel, (e: IpcMainEvent, ...args: unknown[]) => {
    if (fromAppWindow(e)) fn(...(args as A));
  });
}

function registerIpc(): void {
  handle('app:version', () => app.getVersion());
  handle('app:backupsRoot', () => backupsRoot);
  handle('app:startupFile', () => {
    const f = startupFile;
    startupFile = null;
    return f;
  });

  handle('budget:openDialog', async () => {
    if (canned('open') !== undefined) return approve(canned('open') as string | null);
    const r = await dialog.showOpenDialog(win!, {
      title: 'Open a budget',
      filters: BUDGET_FILTERS,
      properties: ['openFile'],
      defaultPath: app.getPath('documents'),
    });
    return r.canceled ? null : approve(r.filePaths[0]);
  });
  /** Where new budgets are saved by default: Documents\MyBudget\Budgets (made if it isn't there). */
  const budgetsFolder = async () => {
    const dir = path.join(app.getPath('documents'), 'MyBudget', 'Budgets');
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    return dir;
  };
  handle('budget:saveDialog', async (suggestedName: string) => {
    if (canned('save') !== undefined) return approve(canned('save') as string | null);
    const r = await dialog.showSaveDialog(win!, {
      title: 'Save budget as',
      filters: BUDGET_FILTERS,
      defaultPath: path.join(await budgetsFolder(), suggestedName.replace(/[\\/:*?"<>|]/g, '') + '.budget'),
    });
    return r.canceled || !r.filePath ? null : approve(r.filePath);
  });
  handle('budget:findInDocuments', async () => {
    // Budgets saved in the usual place, offered on the start screen: Documents\MyBudget\Budgets,
    // and Documents\MyBudget itself, where they were kept before 1.5.12.
    const root = path.join(app.getPath('documents'), 'MyBudget');
    const found: string[] = [];
    for (const dir of [path.join(root, 'Budgets'), root]) {
      try {
        const names = await fs.readdir(dir);
        for (const n of names) if (/\.budget$/i.test(n)) found.push(approve(path.join(dir, n)));
      } catch {
        // Not there: nothing to offer from it.
      }
    }
    return found;
  });
  handle('budget:read', (file: string) => readBudgetFile(checkBudget(file)));
  // A file that wasn't chosen here is treated as missing (e.g. a remembered path from long ago).
  handle('budget:stat', (file: string) => (isApproved(file) ? stat(file) : null));
  handle('budget:write', async (file: string, text: string, expected: FileStamp | null) => {
    const target = checkBudget(file);
    // Written without a stamp ("Save a copy as…", Fresh Start, a YNAB4 import, a forced save) over
    // an existing budget, after Windows asked "Replace?": a copy of what it replaces goes to that
    // budget's own backups first. Its changes since the last daily or hourly backup were otherwise
    // lost (1.5.3).
    if (!expected) {
      let old: string | null = null;
      try {
        old = await fs.readFile(target, 'utf8');
      } catch (e) {
        // Nothing there yet is fine; a file that's there but can't be read (locked by OneDrive or
        // antivirus) isn't replaced without its copy.
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT')
          return { ok: false, reason: 'error', message: "The file being replaced couldn't be read to back it up first, so it was left as it was. Try again in a moment." };
      }
      const idOf = (s: string) => {
        try {
          const j = JSON.parse(s.replace(/^﻿/, ''));
          return { id: typeof j?.id === 'string' ? (j.id as string) : '', name: typeof j?.name === 'string' ? (j.name as string) : '' };
        } catch {
          return { id: '', name: '' }; // Not a budget we can read: kept under the file's name.
        }
      };
      // The open budget saved over its own file (restoring a backup, "Keep this version"): those
      // make their own safety copies, which this one would only crowd out.
      const was = old !== null && old !== String(text) ? idOf(old) : null;
      const own = !!was?.id && target === watchedBudget && was.id === idOf(String(text)).id;
      if (old !== null && was && !own) {
        const id = was.id;
        const name = was.name || path.basename(target, path.extname(target));
        try {
          await createBackup(backupsRoot, id || 'replaced-' + name, name, 'before-replace', old);
        } catch (e) {
          return { ok: false, reason: 'error', message: "The file being replaced couldn't be backed up first, so it was left as it was: " + (e instanceof Error ? e.message : String(e)) };
        }
      }
    }
    return writeBudgetFile(target, String(text), expected);
  });
  handle('budget:watch', (file: string | null) => {
    watchedBudget = file === null ? null : checkBudget(file);
    watchFile(watchedBudget, (f) => win?.webContents.send('budget:fileChanged', f));
  });

  handle('backup:create', async (id: string, name: string, kind: BackupKind, text: string) => {
    const info = await createBackup(backupsRoot, id, name, kind, text);
    // Backups you make yourself are copied too.
    if (kind === 'manual') void copyBackups(id, name, [info.file]).catch(() => {}); // recorded by copyBackups
    return info;
  });
  handle('backup:ensureDaily', async (id: string, name: string, text: string) => {
    const made = await ensureDailyBackup(backupsRoot, id, name, text);
    // Also catches up a day the copy folder (a USB stick) wasn't there.
    void newestDaily(id)
      .then((files) => copyBackups(id, name, files))
      .catch(() => {}); // A copy that fails is recorded by copyBackups; nothing else to do (1.5.3).
    return made;
  });
  handle('backupCopy:get', async () => backupCopyInfo(await readSettings()));
  handle('backupCopy:choose', async () => {
    const testDir = canned('backupCopy');
    const r =
      testDir !== undefined
        ? { canceled: !testDir, filePaths: [testDir as string] }
        : await dialog.showOpenDialog(win!, {
            title: 'Choose where to copy backups (a USB stick or another drive)',
            properties: ['openDirectory', 'createDirectory'],
          });
    const s = await readSettings();
    if (r.canceled || !r.filePaths[0]) return backupCopyInfo(s);
    s.backupCopyFolder = r.filePaths[0];
    delete s.lastCopyError;
    await writeSettings(s);
    // Copy every budget's newest daily backup straight away.
    for (const f of await listBackupFolders(backupsRoot)) await copyBackups(f.id, f.name, await newestDaily(f.id));
    return backupCopyInfo(await readSettings());
  });
  handle('backupCopy:stop', async () => {
    const s = await readSettings();
    delete s.backupCopyFolder;
    delete s.lastCopyError;
    await writeSettings(s);
    return backupCopyInfo(s);
  });
  handle('backup:list', (id: string) => listBackups(backupsRoot, id));
  handle('backup:folders', () => listBackupFolders(backupsRoot));
  handle('backup:read', (id: string, file: string) => readBackup(backupsRoot, id, file));
  handle('backup:openFolder', async (id: string) => {
    const dir = backupDir(backupsRoot, id);
    await fs.mkdir(dir, { recursive: true });
    await shell.openPath(dir);
  });

  handle('recent:list', () => readRecent(recentFile));
  handle('recent:add', (file: string, name: string) => (isApproved(file) ? addRecent(recentFile, file, String(name)) : undefined));
  handle('recent:remove', (file: string) => removeRecent(recentFile, file));

  handle('ynab4:pickFolder', async () => {
    const pick = (dir: string | null) => {
      if (dir) approvedYnab4Dirs.add(pathKey(dir));
      return dir;
    };
    if (canned('ynab4') !== undefined) return pick(canned('ynab4') as string | null);
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose your YNAB folder (or a .ynab4 budget inside it)',
      properties: ['openDirectory'],
      defaultPath: path.join(app.getPath('documents'), 'YNAB'),
    });
    return r.canceled ? null : pick(r.filePaths[0]);
  });
  handle('ynab4:list', (dir: string) => listYnab4Files(checkYnab4Dir(dir)));
  handle('ynab4:read', (dir: string, rel: string) => readYnab4File(checkYnab4Dir(dir), rel));

  handle('bank:open', async (title?: unknown) => {
    const testFiles = canned('bank');
    const r = testFiles !== undefined ? { canceled: !testFiles, filePaths: ([] as string[]).concat(testFiles || []) } : await dialog.showOpenDialog(win!, {
      title: typeof title === 'string' && title ? title.slice(0, 100) : 'Import transactions from your bank',
      filters: [
        { name: 'Bank files', extensions: ['qif', 'ofx', 'qfx', 'qbo', 'csv', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
      defaultPath: app.getPath('downloads'),
    });
    if (r.canceled) return [];
    const out: { name: string; bytes: Uint8Array; modifiedMs: number }[] = [];
    for (const f of r.filePaths) {
      const s = await fs.stat(f);
      if (s.size > 20 * 1024 * 1024) continue;
      out.push({ name: path.basename(f), bytes: new Uint8Array(await fs.readFile(f)), modifiedMs: s.mtimeMs });
    }
    return out;
  });

  handle('file:saveText', async (suggestedName: string, filters: FileFilter[], text: string) => {
    const testPath = canned('saveText');
    const r = testPath !== undefined ? { canceled: !testPath, filePath: testPath as string } : await dialog.showSaveDialog(win!, {
      defaultPath: path.join(app.getPath('documents'), suggestedName),
      filters,
    });
    if (r.canceled || !r.filePath) return null;
    await fs.writeFile(r.filePath, text, 'utf8');
    return r.filePath;
  });
  handle('file:saveTextsToFolder', async (files: { name: string; text: string }[]) => {
    const testDir = canned('folder');
    const r = testDir !== undefined ? { canceled: !testDir, filePaths: [testDir as string] } : await dialog.showOpenDialog(win!, {
      title: 'Choose a folder to save the files in',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: app.getPath('documents'),
    });
    if (r.canceled) return null;
    const dir = r.filePaths[0];
    for (const f of files) await fs.writeFile(path.join(dir, path.basename(f.name)), f.text, 'utf8');
    return dir;
  });

  handle('print:print', async (html: string, landscape: boolean) => {
    const page = await loadPrintPage(String(html));
    try {
      return await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
        // If the hidden page dies, the print never reports back.
        page.webContents.once('render-process-gone', () => resolve({ ok: false, reason: 'the printout stopped' }));
        page.webContents.print({ silent: false, printBackground: true, pageSize: 'A4', landscape: !!landscape }, (ok, reason) =>
          resolve({ ok, reason: ok ? undefined : reason }),
        );
      });
    } finally {
      if (!page.isDestroyed()) page.destroy();
    }
  });
  handle('print:pdf', async (html: string, suggestedName: string) => {
    const name = path.basename(String(suggestedName)).replace(/[\\/:*?"<>|]/g, '') || 'My Budget.pdf';
    const testPath = canned('pdf');
    const r = testPath !== undefined ? { canceled: !testPath, filePath: testPath as string } : await dialog.showSaveDialog(win!, {
      defaultPath: path.join(app.getPath('documents'), name),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const page = await loadPrintPage(String(html));
    try {
      await fs.writeFile(r.filePath, await page.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true }));
    } finally {
      page.destroy();
    }
    return r.filePath;
  });

  on('file:showInFolder', (file: string) => {
    if (isApproved(file)) shell.showItemInFolder(file);
  });
  on('win:titleBarColors', (bg: string, fg: string) => {
    try {
      win?.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 34 });
      win?.setBackgroundColor(bg);
    } catch {
      // Not supported on this platform.
    }
  });
  on('win:zoom', (factor: number) => win?.webContents.setZoomFactor(Math.min(2, Math.max(0.6, Number(factor) || 1))));
  on('win:devtools', () => win?.webContents.toggleDevTools());
  on('app:quit', () => win?.close());
  const stopCloseTimer = () => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
  };
  // The page is handling the close (saving, or asking the user), so don't close on a timer.
  on('app:closeAck', stopCloseTimer);
  on<[unknown]>('app:unsaved', (v) => {
    pageUnsaved = v === true;
  });
  on('app:closeCancelled', stopCloseTimer);
  on('app:confirmClose', () => {
    stopCloseTimer();
    allowClose = true;
    win?.close();
  });
}
