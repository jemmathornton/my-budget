import { contextBridge, ipcRenderer } from 'electron';
import type { MyBudgetApi } from '../src/shared/api';

// Exposes a small, fixed API to the app window. See src/shared/api.ts.

function listen<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const fn = (_e: unknown, ...args: unknown[]) => cb(...(args as T));
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

const api: MyBudgetApi = {
  version: () => ipcRenderer.invoke('app:version'),
  backupsRoot: () => ipcRenderer.invoke('app:backupsRoot'),

  openBudgetDialog: () => ipcRenderer.invoke('budget:openDialog'),
  saveBudgetDialog: (name) => ipcRenderer.invoke('budget:saveDialog', name),
  findBudgetsInDocuments: () => ipcRenderer.invoke('budget:findInDocuments'),
  readBudget: (p) => ipcRenderer.invoke('budget:read', p),
  statBudget: (p) => ipcRenderer.invoke('budget:stat', p),
  writeBudget: (p, text, expected) => ipcRenderer.invoke('budget:write', p, text, expected),
  watchBudget: (p) => ipcRenderer.invoke('budget:watch', p),
  onBudgetFileChanged: (cb) => listen<[string]>('budget:fileChanged', cb),

  createBackup: (id, name, kind, text) => ipcRenderer.invoke('backup:create', id, name, kind, text),
  ensureDailyBackup: (id, name, text) => ipcRenderer.invoke('backup:ensureDaily', id, name, text),
  listBackups: (id) => ipcRenderer.invoke('backup:list', id),
  backupFolders: () => ipcRenderer.invoke('backup:folders'),
  backupCopy: () => ipcRenderer.invoke('backupCopy:get'),
  chooseBackupCopyFolder: () => ipcRenderer.invoke('backupCopy:choose'),
  stopBackupCopy: () => ipcRenderer.invoke('backupCopy:stop'),
  readBackup: (id, file) => ipcRenderer.invoke('backup:read', id, file),
  openBackupsFolder: (id) => ipcRenderer.invoke('backup:openFolder', id),

  recentBudgets: () => ipcRenderer.invoke('recent:list'),
  addRecentBudget: (p, name) => ipcRenderer.invoke('recent:add', p, name),
  removeRecentBudget: (p) => ipcRenderer.invoke('recent:remove', p),

  pickYnab4Folder: () => ipcRenderer.invoke('ynab4:pickFolder'),
  listYnab4Files: (dir) => ipcRenderer.invoke('ynab4:list', dir),
  readYnab4File: (dir, rel) => ipcRenderer.invoke('ynab4:read', dir, rel),

  openBankFiles: (title) => ipcRenderer.invoke('bank:open', title),
  saveTextFile: (name, filters, text) => ipcRenderer.invoke('file:saveText', name, filters, text),
  saveTextFilesToFolder: (files) => ipcRenderer.invoke('file:saveTextsToFolder', files),
  showInFolder: (p) => ipcRenderer.send('file:showInFolder', p),
  printPage: (html, landscape) => ipcRenderer.invoke('print:print', html, landscape),
  savePdf: (html, name) => ipcRenderer.invoke('print:pdf', html, name),

  setTitleBarColors: (bg, fg) => ipcRenderer.send('win:titleBarColors', bg, fg),
  setZoom: (f) => ipcRenderer.send('win:zoom', f),
  toggleDevTools: () => ipcRenderer.send('win:devtools'),
  quit: () => ipcRenderer.send('app:quit'),

  onCloseRequested: (cb) => listen('app:closeRequested', cb),
  closeAck: () => ipcRenderer.send('app:closeAck'),
  confirmClose: () => ipcRenderer.send('app:confirmClose'),
  closeCancelled: () => ipcRenderer.send('app:closeCancelled'),
  onSessionEnding: (cb) => listen('app:sessionEnding', cb),
  setUnsaved: (unsaved) => ipcRenderer.send('app:unsaved', unsaved),
  onOpenFile: (cb) => listen<[string]>('app:openFile', cb),
  startupFile: () => ipcRenderer.invoke('app:startupFile'),
};

contextBridge.exposeInMainWorld('api', api);
