import { useState } from 'react';
import { monthLabel, monthOf, today } from '../../model/dates';
import { formatMoney } from '../../model/money';
import { adjustBalance } from '../../model/ops';
import { update, useBudget, useComputed } from '../../state/store';
import { toast } from '../common/dialogs';
import { DateInput, MoneyInput } from '../common/inputs';
import { Modal } from '../common/overlay';

/** YNAB4's Adjust Balance: type the real balance and the difference is entered for you. */
export function AdjustBalanceDialog({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const b = useBudget();
  const c = useComputed();
  const acc = b.accounts[accountId];
  const working = c.accounts.get(accountId)?.working ?? 0;
  const [balance, setBalance] = useState(working);
  // The box holds something it can't read ("12,5"): nothing happens until it's corrected.
  const [unreadable, setUnreadable] = useState(false);
  // A date that can't be read stops the adjustment rather than using the last good one (1.5.11).
  const [badDate, setBadDate] = useState(false);
  const [date, setDate] = useState(today());
  if (!acc) return null;
  const diff = balance - working;

  const save = () => {
    if (diff !== 0) {
      update('Adjust balance', (d) => void adjustBalance(d, accountId, balance, date));
      toast(`Entered an adjustment of ${formatMoney(diff)}`, 'ok');
    }
    onClose();
  };

  return (
    <Modal
      title={`Adjust balance for '${acc.name}'`}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={unreadable || badDate} onClick={save}>
            {diff === 0 ? 'Done' : 'Adjust balance'}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        Enter a new working balance for {acc.name} and My Budget will enter an adjustment transaction so everything
        balances.
      </p>
      <div className="row2">
        <label className="field">
          <span className="field-label">Current working balance</span>
          <input value={formatMoney(working)} readOnly tabIndex={-1} />
        </label>
        <label className="field">
          <span className="field-label">New working balance</span>
          <MoneyInput value={balance} onCommit={setBalance} onInput={(v) => setUnreadable(v === null)} ariaLabel="New working balance" autoFocus />
        </label>
      </div>
      <label className="field">
        <span className="field-label">Date of the adjustment</span>
        <DateInput value={date} onChange={setDate} onBad={setBadDate} />
      </label>
      <div className="hint">
        {diff === 0
          ? 'The balance is already right.'
          : `Adds "Manual Balance Adjustment" of ${formatMoney(diff)}${
              acc.onBudget ? `, as income for ${monthLabel(monthOf(date))}` : ''
            }.`}
      </div>
    </Modal>
  );
}
