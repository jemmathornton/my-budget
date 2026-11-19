import { useState } from 'react';
import { findYnab4Budgets, importYnab4, type Ynab4BudgetRef } from '../../import/ynab4';
import type { Budget } from '../../model/types';
import { saveNewBudgetAndOpen } from '../../state/persistence';
import { toast } from '../common/dialogs';
import { Modal } from '../common/overlay';

// Brings a YNAB4 budget across. The YNAB4 files are only read, never changed.

export function Ynab4ImportDialog({ onClose }: { onClose: () => void }) {
  const [folder, setFolder] = useState<string | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [budgets, setBudgets] = useState<Ynab4BudgetRef[]>([]);
  const [chosen, setChosen] = useState<Ynab4BudgetRef | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ budget: Budget; messages: string[] } | null>(null);

  const pick = async () => {
    setError('');
    const dir = await window.api.pickYnab4Folder();
    if (!dir) return;
    setBusy(true);
    try {
      const list = await window.api.listYnab4Files(dir);
      const found = findYnab4Budgets(list, dir.split(/[\\/]/).pop());
      setFolder(dir);
      setPaths(list);
      setBudgets(found);
      setChosen(found[0] || null);
      if (!found.length) setError('No YNAB4 budgets were found in that folder. Pick your YNAB folder (usually Documents\\YNAB) or a .ynab4 folder inside it.');
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const load = async () => {
    if (!folder || !chosen) return;
    setBusy(true);
    setError('');
    try {
      const r = await importYnab4({ paths, read: (p) => window.api.readYnab4File(folder, p) }, chosen);
      setResult(r);
    } catch (e) {
      setError('Could not import this budget: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!result) return;
    try {
      if (await saveNewBudgetAndOpen(result.budget)) {
        toast(`Imported ${result.budget.name}.`, 'ok');
        onClose();
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const b = result?.budget;
  return (
    <Modal
      title="Import a YNAB4 budget"
      onClose={onClose}
      width={600}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {!result ? (
            <button className="btn primary" disabled={!chosen || busy} onClick={() => void load()}>
              {busy ? 'Reading…' : 'Read budget'}
            </button>
          ) : (
            <button className="btn primary" onClick={() => void save()}>
              Choose where to save it…
            </button>
          )}
        </>
      }
    >
      {error && <div className="err-box" style={{ marginBottom: 10 }}>{error}</div>}
      {!result && (
        <>
          <p style={{ marginTop: 0 }}>
            Choose your YNAB folder (usually <b>Documents\YNAB</b>). Your YNAB4 files are only read, never changed.
          </p>
          <button className="btn" onClick={() => void pick()} disabled={busy}>
            Choose YNAB folder…
          </button>
          {folder && <div className="hint" style={{ marginTop: 6 }}>{folder}</div>}
          {budgets.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="field-label" style={{ marginBottom: 4 }}>
                Budget to import
              </div>
              {budgets.map((x) => (
                <label key={x.root} className="check" style={{ display: 'flex', margin: '4px 0' }}>
                  <input type="radio" name="ynab4" checked={chosen?.root === x.root} onChange={() => setChosen(x)} />
                  {x.name}
                </label>
              ))}
            </div>
          )}
        </>
      )}
      {b && result && (
        <>
          <p style={{ marginTop: 0 }}>
            <b>{b.name}</b> is ready: {Object.keys(b.accounts).length} accounts, {Object.keys(b.categories).length} categories,{' '}
            {Object.keys(b.transactions).length.toLocaleString()} transactions, {Object.keys(b.scheduled).length} scheduled,{' '}
            {Object.keys(b.payees).length.toLocaleString()} payees.
          </p>
          <details>
            <summary className="hint">Details</summary>
            <ul className="hint" style={{ paddingLeft: 18 }}>
              {result.messages.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </details>
          <p className="hint">
            Next, choose where to save it, for example <b>Documents\MyBudget\{b.name}.budget</b>. Every change is then saved to that file automatically.
          </p>
        </>
      )}
    </Modal>
  );
}
