import { useEffect, useState } from 'react';
import { newId } from '../../model/ids';
import { parseBudgetFile } from '../../model/budget';
import type { BackupFolder, BackupInfo } from '../../shared/api';
import { saveNewBudgetAndOpen } from '../../state/persistence';
import { BACKUP_KIND_LABEL } from '../common/backupLabels';
import { toast } from '../common/dialogs';
import { cx } from '../common/Money';
import { Modal } from '../common/overlay';

// Restores a budget from its automatic backups without opening it first: for a budget file
// that is damaged, deleted or won't open. The restored copy is saved as a new file, so the
// damaged one is left as it is.

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

export function RestoreBackupDialog({ onClose }: { onClose: () => void }) {
  const [folders, setFolders] = useState<BackupFolder[] | null>(null);
  const [folder, setFolder] = useState<string>('');
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [file, setFile] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.api.backupFolders().then((f) => {
      setFolders(f);
      if (f.length) setFolder(f[0].id);
    });
  }, []);
  useEffect(() => {
    if (!folder) return;
    setFile('');
    window.api.listBackups(folder).then((list) => {
      setBackups(list);
      if (list.length) setFile(list[0].file);
    });
  }, [folder]);

  const restore = async () => {
    if (!folder || !file) return;
    setBusy(true);
    try {
      const b = parseBudgetFile(await window.api.readBackup(folder, file));
      // A new file is a new budget: with the original's id it would share its backup folder, and
      // the two would overwrite each other's daily backups (1.5.3).
      b.id = newId();
      const date = backups.find((x) => x.file === file)?.date.slice(0, 10) ?? '';
      if (await saveNewBudgetAndOpen(b, `${b.name} (restored ${date})`)) {
        toast('Restored. This is now the budget you are working in.', 'ok');
        onClose();
      }
    } catch (e) {
      toast("Couldn't restore that backup: " + (e instanceof Error ? e.message : String(e)), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Restore a budget from a backup"
      onClose={onClose}
      width={620}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!file || busy} onClick={() => void restore()}>
            Save as a new budget file…
          </button>
        </>
      }
    >
      {folders === null ? (
        <div className="hint">Looking for backups…</div>
      ) : folders.length === 0 ? (
        <div className="hint">There are no backups on this computer yet.</div>
      ) : (
        <>
          <p style={{ marginTop: 0 }}>
            Pick a budget and a backup. It is saved as a new file and opened; the budget file you have now is not changed.
          </p>
          <label className="field">
            <span className="field-label">Budget</span>
            <select value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Budget">
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} (newest backup {when(f.latest)})
                </option>
              ))}
            </select>
          </label>
          <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 4 }}>
            <table className="simple-table small">
              <thead>
                <tr>
                  <th style={{ width: 28 }} />
                  <th>When</th>
                  <th>Kind</th>
                  <th className="r">Size</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((x) => (
                  <tr key={x.file} className={cx(x.file === file && 'sel')} onClick={() => setFile(x.file)} style={{ cursor: 'pointer' }}>
                    <td>
                      <input type="radio" name="backup" checked={x.file === file} onChange={() => setFile(x.file)} aria-label={when(x.date)} />
                    </td>
                    <td>{when(x.date)}</td>
                    <td>{BACKUP_KIND_LABEL[x.kind]}</td>
                    <td className="r muted">{Math.round(x.size / 1024).toLocaleString()} KB</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
