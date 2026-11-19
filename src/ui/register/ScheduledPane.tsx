import { useRef, useState } from 'react';
import { formatDate, today } from '../../model/dates';
import { formatMoney } from '../../model/money';
import { enterScheduled, skipScheduled } from '../../model/ops';
import { categoryLabel, payeeName } from '../../model/queries';
import { FREQUENCY_LABELS, SPLIT, type Budget, type Id, type ScheduledTransaction } from '../../model/types';
import { update } from '../../state/store';
import { toast } from '../common/dialogs';
import { PlusIcon } from '../common/icons';
import { cx } from '../common/Money';

// YNAB4's "Scheduled Transactions" pane under a register: the account's scheduled transactions,
// kept apart from the real ones, opened from the register's footer.

export interface PaneItem {
  s: ScheduledTransaction;
  /** As seen from this register (a transfer into this account is money in). */
  amount: number;
  /** The account it shows under: the register's own, for transfers into it. */
  accountId: Id;
}

/** The scheduled transactions a register shows, soonest first. */
export function scheduledForRegister(b: Budget, accountId: Id | 'all'): PaneItem[] {
  const out: PaneItem[] = [];
  for (const s of Object.values(b.scheduled)) {
    if (accountId === 'all' || s.accountId === accountId) out.push({ s, amount: s.amount, accountId: s.accountId });
    else if (s.transferAccountId === accountId) out.push({ s, amount: -s.amount, accountId });
  }
  return out.sort((x, y) => (x.s.date < y.s.date ? -1 : x.s.date > y.s.date ? 1 : 0));
}

export function ScheduledPane({
  b,
  accountId,
  items,
  onEdit,
  onAdd,
}: {
  b: Budget;
  accountId: Id | 'all';
  items: PaneItem[];
  onEdit: (s: ScheduledTransaction) => void;
  onAdd: () => void;
}) {
  const now = today();
  const all = accountId === 'all';
  const ref = useRef<HTMLDivElement>(null);
  // Its height, dragged from the top edge as in YNAB4, and remembered (a convenience only).
  const [height, setHeight] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem('registerScheduledPaneHeight'));
      return v > 0 ? v : null;
    } catch {
      return null;
    }
  });
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const start = ref.current?.offsetHeight ?? 150;
    const max = Math.max(120, (ref.current?.parentElement?.offsetHeight ?? 600) * 0.7);
    let last = start;
    const move = (ev: MouseEvent) => {
      last = Math.round(Math.min(max, Math.max(70, start + startY - ev.clientY)));
      setHeight(last);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      try {
        localStorage.setItem('registerScheduledPaneHeight', String(last));
      } catch {
        // Only a convenience.
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <div
      ref={ref}
      className={cx('sched-pane', all && 'all')}
      aria-label="Scheduled transactions"
      style={height ? { height, maxHeight: 'none' } : undefined}
    >
      <div
        className="sp-resize"
        title="Drag to make the pane taller or shorter (double-click to reset)"
        onMouseDown={startResize}
        onDoubleClick={() => {
          setHeight(null);
          try {
            localStorage.removeItem('registerScheduledPaneHeight');
          } catch {
            // Only a convenience.
          }
        }}
      />
      <div className="sp-head">
        <b>Scheduled transactions</b>
        <span className="grow" />
        <button className="btn small" onClick={onAdd}>
          <PlusIcon size={11} /> Schedule a new transaction
        </button>
      </div>
      {items.length === 0 ? (
        <div className="sp-empty">Nothing scheduled{all ? '' : ' for this account'}.</div>
      ) : (
        <div className="sp-list">
          <div className="sp-row sp-cols">
            <span>Date</span>
            <span>Frequency</span>
            {all && <span>Account</span>}
            <span>Payee</span>
            <span>Category</span>
            <span>Memo</span>
            <span className="r">Outflow</span>
            <span className="r">Inflow</span>
            <span />
          </div>
          {items.map(({ s, amount, accountId: shownIn }) => {
            const due = s.date <= now;
            const payee = shownIn === s.accountId ? payeeName(b, s) : 'Transfer : ' + (b.accounts[s.accountId]?.name || '?');
            return (
              <div
                key={s.id}
                className={cx('sp-row', due && 'due')}
                onDoubleClick={() => onEdit(s)}
                title="Double-click to edit"
              >
                <span>
                  {formatDate(s.date)}
                  {due && <span className="badge warn">Due</span>}
                </span>
                <span>{FREQUENCY_LABELS[s.frequency]}</span>
                {all && <span>{b.accounts[s.accountId]?.name}</span>}
                <span>{payee}</span>
                <span>{s.categoryId === SPLIT ? `Split (${s.splits?.length ?? 0})` : categoryLabel(b, s.categoryId, s.date)}</span>
                <span className="muted">{s.memo}</span>
                <span className="r">{amount < 0 ? formatMoney(-amount) : ''}</span>
                <span className="r">{amount > 0 ? formatMoney(amount) : ''}</span>
                <span className="r sp-actions" onDoubleClick={(e) => e.stopPropagation()}>
                  <button
                    className="link small"
                    title="Enter the next one now"
                    onClick={(e) => {
                      // A double-click mustn't enter two (1.5.11).
                      if (e.detail > 1) return;
                      update('Enter scheduled transaction', (d) => void enterScheduled(d, s.id, due ? undefined : now, true));
                      toast('Entered', 'ok');
                    }}
                  >
                    Enter now
                  </button>
                  <button
                    className="link small"
                    title="Skip the next one"
                    onClick={(e) => e.detail <= 1 && update('Skip scheduled transaction', (d) => skipScheduled(d, s.id))}
                  >
                    Skip
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
