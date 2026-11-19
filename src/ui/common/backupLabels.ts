import type { BackupKind } from '../../shared/api';

/** How each kind of backup is described in Settings and the restore dialog. */
export const BACKUP_KIND_LABEL: Record<BackupKind, string> = {
  daily: 'Daily backup',
  hourly: 'Hourly while editing',
  'before-import': 'Before importing a bank file',
  'before-restore': 'Before restoring a backup',
  'before-conflict': 'Before resolving a file conflict',
  'before-reload': 'Before reloading a file another program changed',
  'before-fresh-start': 'Before Fresh Start',
  'before-merge': 'Before merging payees',
  'before-learn': 'Before learning accounts from bank files',
  'before-replace': 'Before its file was replaced',
  manual: 'Saved by you',
  unsaved: 'Unsaved changes when closing',
};
