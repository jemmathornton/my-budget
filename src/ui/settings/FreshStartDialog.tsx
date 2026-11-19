import { useState } from 'react';
import { serializeBudget } from '../../model/budget';
import { today } from '../../model/dates';
import { freshStart } from '../../model/freshStart';
import { flush, saveNewBudgetAndOpen } from '../../state/persistence';
import { store, useBudget } from '../../state/store';
import { toast } from '../common/dialogs';
import { Modal } from '../common/overlay';

export function FreshStartDialog({ onClose }: { onClose: () => void }) {
  const b = useBudget();
  const [name, setName] = useState(`${b.name} (from ${today().slice(0, 4)})`);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const unsaved = await flush();
      if (unsaved.length) {
        toast(`${unsaved.join(' ')} Correct it or cancel it first.`, 'error');
        return;
      }
      // As flushed: a transaction still open in a register was saved just now.
      const now = store.budget ?? b;
      await window.api.createBackup(now.id, now.name, 'before-fresh-start', serializeBudget(now));
      const nb = freshStart(now, name.trim() || now.name);
      if (await saveNewBudgetAndOpen(nb)) {
        toast('Fresh Start done. Your old budget is unchanged and still in File > Open recent.', 'ok');
        onClose();
      }
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Fresh Start"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void go()}>
            Choose where to save the new budget…
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        A Fresh Start makes a <b>new budget</b> with your open accounts at today's balances, your categories, payees,
        rename rules and scheduled transactions, but none of the history. All the money in your budget accounts starts in
        Available to Budget, ready to budget again.
      </p>
      <p>Your current budget isn't changed; it stays in its own file so you can look back at it.</p>
      <label className="field">
        <span className="field-label">Name for the new budget</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
    </Modal>
  );
}
