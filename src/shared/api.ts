// The API the Electron main process gives the app window (see electron/preload.ts).
// The window has no direct access to Node or the file system; everything goes through this.

export interface FileStamp {
  mtimeMs: number;
  size: number;
  /** SHA-256 of the contents, when the file was read or written (not from statBudget). */
  hash?: string;
}

export interface ReadResult {
  text: string;
  stamp: FileStamp;
}

export type WriteResult =
  | { ok: true; stamp: FileStamp }
  /** The file changed on disk since `expected` (e.g. synced from another computer). Nothing was written. */
  | { ok: false; reason: 'conflict'; stamp: FileStamp | null }
  | { ok: false; reason: 'error'; message: string };

/** "unsaved": this window's version when it couldn't be saved on closing or switching budget. */
export type BackupKind =
  | 'daily'
  | 'hourly'
  | 'before-import'
  | 'before-restore'
  | 'before-conflict'
  /** This window's version, before reloading a file another program changed (1.5.11). */
  | 'before-reload'
  | 'before-fresh-start'
  | 'before-merge'
  | 'before-learn'
  /** A budget file overwritten by "Save a copy as…", Fresh Start or a YNAB4 import (1.5.3). */
  | 'before-replace'
  | 'manual'
  | 'unsaved';

export interface BackupInfo {
  file: string;
  kind: BackupKind;
  /** ISO timestamp. */
  date: string;
  size: number;
}

/** A budget's backup folder. */
export interface BackupFolder {
  /** The budget id (the folder's name). */
  id: string;
  name: string;
  count: number;
  /** ISO time of the newest backup. */
  latest: string;
}

export interface BackupCopyInfo {
  folder: string | null;
  /** ISO time of the last successful copy. */
  lastCopied: string | null;
  /** Why the last copy failed (e.g. the USB stick wasn't plugged in). */
  lastError: string | null;
}

export interface RecentBudget {
  path: string;
  name: string;
  openedAt: string;
}

export interface BankFile {
  name: string;
  bytes: Uint8Array;
  /** When the file was last changed (to import oldest first). */
  modifiedMs?: number;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface MyBudgetApi {
  version(): Promise<string>;
  /** Where backups are kept (shown in Settings). */
  backupsRoot(): Promise<string>;

  openBudgetDialog(): Promise<string | null>;
  saveBudgetDialog(suggestedName: string): Promise<string | null>;
  /** .budget files in Documents\MyBudget, for the start screen. */
  findBudgetsInDocuments(): Promise<string[]>;
  readBudget(path: string): Promise<ReadResult>;
  statBudget(path: string): Promise<FileStamp | null>;
  /** Writes atomically. With `expected`, refuses (conflict) if the file changed since then. */
  writeBudget(path: string, text: string, expected: FileStamp | null): Promise<WriteResult>;
  /** Watches one budget file for changes made by other programs. Pass null to stop. */
  watchBudget(path: string | null): Promise<void>;
  onBudgetFileChanged(cb: (path: string) => void): () => void;

  createBackup(budgetId: string, budgetName: string, kind: BackupKind, text: string): Promise<BackupInfo>;
  /** Makes today's daily backup if there isn't one yet. Keeps 30 days. */
  ensureDailyBackup(budgetId: string, budgetName: string, text: string): Promise<boolean>;
  listBackups(budgetId: string): Promise<BackupInfo[]>;
  /** Every budget that has backups, newest first (for restoring one that won't open). */
  backupFolders(): Promise<BackupFolder[]>;
  /** Where daily backups are also copied (a USB stick, another drive), set on this computer. */
  backupCopy(): Promise<BackupCopyInfo>;
  /** Asks for the folder, saves it and copies the newest backups there straight away. */
  chooseBackupCopyFolder(): Promise<BackupCopyInfo>;
  stopBackupCopy(): Promise<BackupCopyInfo>;
  readBackup(budgetId: string, file: string): Promise<string>;
  openBackupsFolder(budgetId: string): Promise<void>;

  recentBudgets(): Promise<RecentBudget[]>;
  addRecentBudget(path: string, name: string): Promise<void>;
  removeRecentBudget(path: string): Promise<void>;

  pickYnab4Folder(): Promise<string | null>;
  listYnab4Files(dir: string): Promise<string[]>;
  readYnab4File(dir: string, relPath: string): Promise<string>;

  /** Asks for bank files (in Downloads to begin with); `title` names the file picker. */
  openBankFiles(title?: string): Promise<BankFile[]>;
  saveTextFile(suggestedName: string, filters: FileFilter[], text: string): Promise<string | null>;
  /** Asks for a folder and writes several text files into it. Returns the folder, or null if cancelled. */
  saveTextFilesToFolder(files: { name: string; text: string }[]): Promise<string | null>;
  showInFolder(path: string): void;
  /** Opens Windows' print dialog for a printout (a page without scripts), on A4. "cancelled" if so. */
  printPage(html: string, landscape: boolean): Promise<{ ok: boolean; reason?: string }>;
  /** Asks where, and saves a printout as a PDF. Returns the file, or null if cancelled. */
  savePdf(html: string, suggestedName: string): Promise<string | null>;

  setTitleBarColors(background: string, symbols: string): void;
  setZoom(factor: number): void;
  toggleDevTools(): void;
  quit(): void;

  /**
   * The window is about to close: call closeAck() straight away, then save (asking if needed),
   * then confirmClose() or closeCancelled(). Without an ack the window closes after 8 s anyway.
   */
  onCloseRequested(cb: () => void): () => void;
  closeAck(): void;
  confirmClose(): void;
  closeCancelled(): void;
  /** Windows is shutting down, restarting or logging off; there are only a few seconds. */
  onSessionEnding(cb: () => void): () => void;
  /** Whether anything may not be in the budget file yet, so Windows shutting down should wait (1.5.4). */
  setUnsaved(unsaved: boolean): void;
  /** A .budget file was opened from Explorer while the app was running. */
  onOpenFile(cb: (path: string) => void): () => void;
  /** The .budget file the app was started with (from Explorer), if any. */
  startupFile(): Promise<string | null>;
}

declare global {
  interface Window {
    api: MyBudgetApi;
  }
}
