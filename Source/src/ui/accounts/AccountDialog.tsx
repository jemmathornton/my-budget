import { useState } from 'react';
import { today } from '../../model/dates';
import { addAccount, updateAccount } from '../../model/ops';
import {
  ACCOUNT_TYPE_LABELS,
  BUDGET_ACCOUNT_TYPES,
  TRACKING_ACCOUNT_TYPES,
  type AccountType,
} from '../../model/types';
import { update, useBudget } from '../../state/store';
import { ui } from '../../state/ui';
import * as actions from '../actions';
import { toast } from '../common/dialogs';
import { DateInput, MoneyInput } from '../common/inputs';
import { Modal } from '../common/overlay';

const DEBT_TYPES: AccountType[] = ['CreditCard', 'LineOfCredit', 'Mortgage', 'OtherLiability'];

/** Adds a new account, or (with accountId) edits one. */
export function AccountDialog({ accountId, onClose }: { accountId?: string; onClose: () => void }) {
  const b = useBudget();
  const existing = accountId ? b.accounts[accountId] : undefined;
  const [name, setName] = useState(existing?.name ?? '');
  const [type, setType] = useState<AccountType>(existing?.type ?? 'Checking');
  const [onBudget, setOnBudget] = useState(existing?.onBudget ?? true);
  const [balance, setBalance] = useState(0);
  // The balance box holds something it can't read ("12,5"): saving waits until it's corrected.
  const [unreadable, setUnreadable] = useState(false);
  const [badDate, setBadDate] = useState(false);
  const [owed, setOwed] = useState(false);
  const [date, setDate] = useState(today());
  const [note, setNote] = useState(existing?.note ?? '');
  const [error, setError] = useState('');
  const txCount = existing ? Object.values(b.transactions).filter((t) => t.accountId === existing.id).length : 0;

  const pickType = (t: AccountType) => {
    setType(t);
    if (!existing) {
      setOnBudget(BUDGET_ACCOUNT_TYPES.includes(t));
      setOwed(DEBT_TYPES.includes(t));
    }
  };

  /** Saves and closes. Returns false (and stays open) if something needs fixing. */
  const save = (): boolean => {
    if (!name.trim()) {
      setError('Give the account a name.');
      return false;
    }
    if (unreadable) {
      setError("The balance couldn't be read: correct the box in red.");
      return false;
    }
    // The opening date too, rather than using the last good one (1.5.11).
    if (badDate) {
      setError("The date couldn't be read: correct the box in red.");
      return false;
    }
    if (Object.values(b.accounts).some((a) => a.id !== accountId && a.name.toLowerCase() === name.trim().toLowerCase())) {
      setError('There is already an account with that name.');
      return false;
    }
    if (existing) {
      const a = existing;
      const changed = name.trim() !== a.name || type !== a.type || note !== (a.note ?? '') || onBudget !== a.onBudget;
      if (changed) update('Edit account', (d) => updateAccount(d, a.id, { name, type, note, onBudget }));
      onClose();
      return true;
    }
    const amount = owed ? -Math.abs(balance) : balance;
    let id = '';
    update('Add account', (d) => {
      id = addAccount(d, { name, type, onBudget, note }, amount, date);
    });
    toast(`Added ${name.trim()}`, 'ok');
    onClose();
    ui.go({ view: 'account', id });
    return true;
  };

  return (
    <Modal
      title={existing ? `Edit account: ${existing.name}` : 'Add an account'}
      onClose={onClose}
      width={480}
      footer={
        <>
          {existing && (
            <button
              className="btn danger"
              style={{ marginRight: 'auto' }}
              onClick={() => {
                onClose();
                void actions.deleteAccountFlow(existing.id);
              }}
            >
              Delete…
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            {existing ? 'Save' : 'Add account'}
          </button>
        </>
      }
    >
      {error && <div className="err-box" style={{ marginBottom: 10 }}>{error}</div>}
      <label className="field">
        <span className="field-label">Account name</span>
        <input value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      </label>
      <div className="row2">
        <label className="field">
          <span className="field-label">Type</span>
          <select value={type} onChange={(e) => pickType(e.target.value as AccountType)}>
            <optgroup label="Usually on budget">
              {BUDGET_ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ACCOUNT_TYPE_LABELS[t]}
                </option>
              ))}
            </optgroup>
            <optgroup label="Usually off budget (tracking)">
              {TRACKING_ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ACCOUNT_TYPE_LABELS[t]}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Budget</span>
          <select
            value={onBudget ? 'on' : 'off'}
            onChange={(e) => setOnBudget(e.target.value === 'on')}
          >
            <option value="on">On budget</option>
            <option value="off">Off budget (tracking only)</option>
          </select>
        </label>
      </div>
      {existing && onBudget !== existing.onBudget && txCount > 0 && (
        <div className="warn-box" style={{ marginTop: -6, marginBottom: 10 }}>
          {onBudget
            ? `Its ${txCount} transaction${txCount === 1 ? '' : 's'} will count in the budget, and any without a category will need one (the budget screen lists them).`
            : 'Its transactions will stop counting in the budget, and transfers between it and your budget accounts will need a category.'}{' '}
          Undo puts it back.
        </div>
      )}
      {!existing && (
        <>
          <div className="row2">
            <label className="field">
              <span className="field-label">Current balance</span>
              <MoneyInput value={balance} onCommit={(v) => setBalance(v)} onInput={(v) => setUnreadable(v === null)} ariaLabel="Current balance" />
            </label>
            <label className="field">
              <span className="field-label">As of</span>
              <DateInput value={date} onChange={setDate} onBad={setBadDate} />
            </label>
          </div>
          <label className="check" style={{ marginBottom: 10 }}>
            <input type="checkbox" checked={owed} onChange={(e) => setOwed(e.target.checked)} />
            This balance is money I owe (a debt)
          </label>
          {onBudget && owed && balance !== 0 && (
            <div className="hint" style={{ marginBottom: 10 }}>
              Like YNAB4, an existing debt gets its own category under "Pre-YNAB Debt", so you can budget to pay it off.
            </div>
          )}
        </>
      )}
      <label className="field">
        <span className="field-label">Note</span>
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {existing && (
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <button
            className="btn small"
            onClick={() => save() && actions.adjustBalanceFlow(existing.id)}
          >
            Adjust balance…
          </button>
        </div>
      )}
      {existing && (
        <label className="check">
          <input
            type="checkbox"
            checked={existing.closed}
            onChange={(e) => void actions.setAccountClosedFlow(existing.id, e.target.checked)}
          />
          Closed (kept for its history, hidden from lists)
        </label>
      )}
    </Modal>
  );
}
