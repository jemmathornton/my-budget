import { useMemo, useRef, useState } from 'react';
import { decodeBankFileBytes, detectBankFileKind } from '../../import/bank';
import { applyLearnPlans, planLearnAccounts, type InboxFile, type LearnPlan } from '../../import/inbox';
import { serializeBudget } from '../../model/budget';
import type { Budget } from '../../model/types';
import type { BankFile } from '../../shared/api';
import { store, update, useBudget } from '../../state/store';
import { toast } from '../common/dialogs';
import { cx } from '../common/Money';
import { Modal } from '../common/overlay';
import * as actions from '../actions';
import { BANK_EXT, parseInboxFile } from './BankImportDialog';

// "Learn accounts from old bank files" (1.4.4): before the first import in a budget converted
// from YNAB4, old downloads teach each account its bank account or card number, from the files
// whose rows are already in it, so the first import picks the accounts by itself. Only the
// accounts' import keys change: no transaction is added, changed or removed.

/** A chosen file: read, or why it couldn't be. Told apart by name and size, as the inbox does. */
interface Chosen {
  key: string;
  fileName: string;
  file?: InboxFile;
  unread?: string;
}

type Row = LearnPlan & { key: string };

/** Every chosen file planned together, so two files can't teach one number to two accounts. */
function planAll(b: Budget, chosen: Chosen[]): Row[] {
  const read = chosen.filter((c) => c.file);
  const plans = planLearnAccounts(b, read.map((c) => c.file!));
  const rows: Row[] = [
    ...plans.map((p, i) => ({ ...p, key: read[i].key })),
    ...chosen.filter((c) => !c.file).map((c) => ({ key: c.key, fileName: c.fileName, reason: c.unread!, keys: [] })),
  ];
  const name = (r: Row) => (r.accountId ? (b.accounts[r.accountId]?.name ?? '') : '');
  return rows.sort((x, y) => +!x.keys.length - +!y.keys.length || name(x).localeCompare(name(y)) || x.fileName.localeCompare(y.fileName));
}

export function LearnAccountsDialog({ onClose }: { onClose: () => void }) {
  const b = useBudget();
  const [chosen, setChosen] = useState<Chosen[]>([]);
  /** Files unticked by hand; every other file that has something to teach is ticked. */
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const budgetId = useRef(store.budget?.id);
  const rows = useMemo(() => planAll(b, chosen), [b, chosen]);
  const learning = rows.filter((r) => r.keys.length && !unticked.has(r.key));
  const accounts = new Set(learning.map((r) => r.accountId)).size;

  const choose = async () => {
    const files: BankFile[] = await window.api.openBankFiles('Choose old bank downloads to learn accounts from');
    const known = new Set(chosen.map((c) => c.key));
    const fresh: Chosen[] = [];
    for (const f of files) {
      const key = f.name + ':' + f.bytes.length;
      if (known.has(key)) continue;
      known.add(key);
      if (!BANK_EXT.test(f.name)) {
        fresh.push({ key, fileName: f.name, unread: 'not a bank file' });
        continue;
      }
      const text = decodeBankFileBytes(f.bytes);
      try {
        fresh.push({ key, fileName: f.name, file: { fileName: f.name, text, parsed: parseInboxFile(store.budget!, detectBankFileKind(f.name, text), text) } });
      } catch {
        fresh.push({ key, fileName: f.name, unread: "couldn't be read" });
      }
    }
    if (fresh.length) setChosen([...chosen, ...fresh]);
  };

  const learn = async () => {
    if (!learning.length || busy) return;
    if (!store.budget || store.budget.id !== budgetId.current) {
      toast('A different budget is open now. Close this and start again.', 'error');
      return;
    }
    // Planned again on the budget as it is now, in case it changed while the dialog was open.
    const planNow = () => planAll(store.budget!, chosen).filter((r) => r.keys.length && !unticked.has(r.key));
    if (!planNow().length) {
      toast('Nothing new to learn: the accounts know these files already.', 'info');
      onClose();
      return;
    }
    setBusy(true);
    const before = store.budget;
    try {
      await window.api.createBackup(before.id, before.name, 'before-learn', serializeBudget(before));
    } catch (e) {
      setBusy(false);
      toast("Couldn't make a backup first, so nothing was learned: " + (e instanceof Error ? e.message : String(e)), 'error');
      return;
    }
    const now = planNow();
    let n = 0;
    const topBefore = store.undoTop();
    update('Learn accounts from old bank files', (d) => {
      n = applyLearnPlans(d, now);
    });
    const a = new Set(now.map((r) => r.accountId)).size;
    // Numbers it already had change nothing, and then there's nothing of its own to undo.
    const undo = store.undoTop() !== topBefore ? { label: 'Undo', fn: actions.undoThis() } : undefined;
    toast(`Learned the numbers of ${a} account${a === 1 ? '' : 's'} from ${n} file${n === 1 ? '' : 's'}.`, 'ok', undo);
    onClose();
  };

  return (
    <Modal
      title="Learn accounts from old bank files"
      onClose={busy ? () => {} : onClose}
      width={780}
      footer={
        <>
          <button className="btn" onClick={() => void choose()} disabled={busy}>
            {chosen.length ? 'Add more files…' : 'Choose files…'}
          </button>
          <span className="grow" />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void learn()} disabled={!learning.length || busy}>
            Learn from {learning.length || ''} file{learning.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        Choose bank files you downloaded before, from Downloads. Each file whose transactions are already in one account here teaches that account
        its bank account or card number, so your next import picks the account by itself.
      </p>
      <p className="hint">
        Nothing else changes: no transaction is added, changed or removed, and your payee rules stay as they are. Files from your other budget
        aren't in this one, so they're left out. A backup is made first, and Ctrl+Z undoes it.
      </p>
      {rows.length > 0 && (
        <>
          <p>
            {learning.length
              ? `${learning.length} file${learning.length === 1 ? '' : 's'} would teach ${accounts} account${accounts === 1 ? '' : 's'}.`
              : 'None of the ticked files has anything to teach.'}
          </p>
          <div className="learn-list">
            <table className="simple-table">
              <thead>
                <tr>
                  <th style={{ width: 28 }}></th>
                  <th>File</th>
                  <th>Account</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className={cx(!r.keys.length && 'muted')}>
                    <td>
                      {r.keys.length > 0 && (
                        <input
                          type="checkbox"
                          checked={!unticked.has(r.key)}
                          aria-label={`Learn from ${r.fileName}`}
                          onChange={() => {
                            const n = new Set(unticked);
                            if (n.has(r.key)) n.delete(r.key);
                            else n.add(r.key);
                            setUnticked(n);
                          }}
                        />
                      )}
                    </td>
                    <td>{r.fileName}</td>
                    <td>{r.accountId ? b.accounts[r.accountId]?.name : ''}</td>
                    <td>{r.reason}</td>
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
