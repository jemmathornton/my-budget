import { useRef, useState } from 'react';
import { formatDate, today } from '../../model/dates';
import { formatMoney } from '../../model/money';
import { clearedBalance, reconcileAccount } from '../../model/ops';
import type { Id } from '../../model/types';
import { update, useBudget } from '../../state/store';
import { toast } from '../common/dialogs';
import { DateInput, MoneyInput } from '../common/inputs';
import { Modal } from '../common/overlay';

// YNAB4's reconcile: confirm the cleared balance matches the bank, or enter the
// statement balance and either find the difference or add an adjustment. As in YNAB4, the
// statement's date decides which cleared transactions count (1.5).

export function ReconcileDialog({ accountId, onClose }: { accountId: Id; onClose: () => void }) {
  const b = useBudget();
  const account = b.accounts[accountId];
  const clearedToday = clearedBalance(b, accountId, today());
  // The register's header counts every cleared row, including ones dated after today.
  const clearedLater = clearedBalance(b, accountId, '9999-12-31') - clearedToday;
  const [step, setStep] = useState<'ask' | 'enter'>('ask');
  // Until a statement balance is entered, it follows the cleared balance at the statement's date.
  const [statement, setStatement] = useState<number | null>(null);
  const edited = useRef(false);
  // What's typed in the box so far: the difference and the button follow the typing, so a click
  // straight after typing does what the button said.
  const [typed, setTyped] = useState<number | null>(null);
  // The box holds something it can't read ("12,5"): no reconciling until it's corrected.
  const [unreadable, setUnreadable] = useState(false);
  const [date, setDateState] = useState(today());
  // The date box holds a date it can't read: the dialog still shows the last good date, so
  // finishing would reconcile to the wrong date.
  const [badDate, setBadDate] = useState(false);
  const lastShown = useRef<number | null>(null);
  // A date box applies its date when it loses the focus, and that can be the mouse-down of a
  // click on the button, whose label then changes under the click. Such a click does nothing,
  // so the new difference is seen before anything is added.
  const dateChangedAt = useRef(0);
  const setDate = (d: string) => {
    dateChangedAt.current = performance.now();
    setDateState(d);
  };
  if (!account) return null;
  const cleared = clearedBalance(b, accountId, date);
  const balance = typed ?? statement ?? cleared;
  const diff = balance - cleared;
  // A new date gives the balance box a new figure when nothing was entered, and that replaces
  // whatever it couldn't read.
  const shown = statement ?? cleared;
  if (lastShown.current === null) lastShown.current = shown;
  else if (lastShown.current !== shown) {
    lastShown.current = shown;
    if (unreadable || typed !== null) edited.current = statement !== null;
    if (unreadable) setUnreadable(false);
    if (typed !== null) setTyped(null);
  }

  // `mouse`: a click, not Enter or Space, which can't land under a changing label.
  const finish = (balance: number, asOf: string, mouse: boolean) => {
    if (mouse && performance.now() - dateChangedAt.current < 400) return;
    let adj = 0;
    update('Reconcile ' + account.name, (d) => {
      adj = reconcileAccount(d, accountId, balance, asOf);
    });
    toast(
      adj
        ? `Reconciled, with an adjustment of ${formatMoney(adj)}.`
        : `Reconciled. Cleared transactions up to ${formatDate(asOf)} are now locked.`,
      'ok',
    );
    onClose();
  };

  return (
    <Modal
      title={`Reconcile ${account.name}`}
      onClose={onClose}
      width={470}
      footer={
        step === 'ask' ? (
          <>
            <button className="btn" onClick={() => setStep('enter')}>
              No
            </button>
            <button className="btn primary" autoFocus onClick={(e) => finish(clearedToday, today(), e.detail > 0)}>
              Yes, it matches
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={onClose} title="Close this and mark the transactions that have cleared">
              I'll find the difference
            </button>
            <button className="btn primary" disabled={unreadable || badDate} onClick={(e) => finish(balance, date, e.detail > 0)}>
              {diff !== 0 ? `Add ${formatMoney(diff)} adjustment and finish` : 'Finish reconciling'}
            </button>
          </>
        )
      }
    >
      {step === 'ask' ? (
        <p style={{ margin: 0, fontSize: 14 }}>
          Is your current cleared balance <b>{formatMoney(clearedToday)}</b>, as your bank shows today?
          {clearedLater !== 0 && (
            <span className="muted">
              {' '}
              (The register's Cleared figure also counts {formatMoney(clearedLater)} marked cleared but dated
              after today.)
            </span>
          )}
        </p>
      ) : (
        <>
          <div className="row2">
            <label className="field">
              <span className="field-label">Statement / bank balance</span>
              <MoneyInput
                value={statement ?? cleared}
                autoFocus
                onCommit={(v) => {
                  // Only a typed balance stays put. The box starts with the keyboard in it, so
                  // leaving it for the date box mustn't fix the balance it showed.
                  if (edited.current) setStatement(v);
                  setTyped(null);
                }}
                onInput={(v) => {
                  edited.current = true;
                  setTyped(v);
                  setUnreadable(v === null);
                }}
                ariaLabel="Statement balance"
              />
            </label>
            <label className="field">
              <span className="field-label">Statement date</span>
              <DateInput value={date} onChange={setDate} onBad={setBadDate} />
            </label>
          </div>
          <div className="insp-stats">
            <div>
              <span className="muted">Cleared in My Budget up to {formatDate(date)}</span>
              <span className="money">{formatMoney(cleared)}</span>
            </div>
            <div className="tot">
              <span>Difference</span>
              <span className={'money' + (diff ? ' neg' : '')}>{formatMoney(diff)}</span>
            </div>
          </div>
          <p className="hint" style={{ marginBottom: 0 }}>
            {badDate
              ? "The statement date can't be read. Type it as day/month/year, or pick it from the calendar."
              : diff === 0
              ? `Everything matches as of ${formatDate(date)}.`
              : 'Mark any transactions that have cleared at the bank (the C column) and the difference updates here. Or add an adjustment transaction for the difference.'}
          </p>
        </>
      )}
    </Modal>
  );
}
