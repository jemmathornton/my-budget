import { useMemo, useState } from 'react';
import { formatDate, today } from '../../model/dates';
import { deleteScheduled, enterScheduled, skipScheduled } from '../../model/ops';
import { categoryLabel, payeeName } from '../../model/queries';
import { FREQUENCY_LABELS, SPLIT, type ScheduledTransaction } from '../../model/types';
import { update, useBudget } from '../../state/store';
import * as actions from '../actions';
import { confirm, toast } from '../common/dialogs';
import { PlusIcon } from '../common/icons';
import { Money, cx } from '../common/Money';
import { ScheduledEditor } from './ScheduledEditor';

// Every scheduled (repeating or future) transaction. They're entered automatically when
// due (when the budget is opened), or can be entered early or skipped here.

export function Scheduled() {
  const b = useBudget();
  const [editing, setEditing] = useState<ScheduledTransaction | 'new' | null>(null);
  const list = useMemo(
    () =>
      Object.values(b.scheduled).sort((x, y) =>
        x.date < y.date ? -1 : x.date > y.date ? 1 : payeeName(b, x).localeCompare(payeeName(b, y)),
      ),
    [b],
  );
  const now = today();
  const due = list.filter((s) => s.date <= now).length;

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Scheduled transactions</h1>
        <button className="btn small primary" onClick={() => setEditing('new')}>
          <PlusIcon size={12} /> Add scheduled transaction
        </button>
        {due > 0 && (
          <button className="btn small" onClick={() => void actions.enterDueNow()}>
            Enter {due} due now
          </button>
        )}
        <span className="hint">Due transactions are entered automatically each time you open the budget.</span>
      </div>
      <div className="screen-body">
        <div className="card flush">
          {list.length === 0 ? (
            <div className="empty">
              No scheduled transactions. Add one here, or tick "Repeat" when adding a transaction. A transaction dated
              in the future can be sent here with "Move to Scheduler" from its menu.
            </div>
          ) : (
            <table className="simple-table">
              <thead>
                <tr>
                  <th>Next date</th>
                  <th>Frequency</th>
                  <th>Account</th>
                  <th>Payee</th>
                  <th>Category</th>
                  <th>Memo</th>
                  <th className="r">Outflow</th>
                  <th className="r">Inflow</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr
                    key={s.id}
                    className={cx('clickable', s.date <= now && 'sel')}
                    onDoubleClick={() => setEditing(s)}
                  >
                    <td className="nowrap">
                      {formatDate(s.date)}
                      {s.date <= now && (
                        <span className="badge warn" style={{ marginLeft: 6 }}>
                          Due
                        </span>
                      )}
                    </td>
                    <td className="nowrap">
                      {FREQUENCY_LABELS[s.frequency]}
                      {s.endDate && <span className="hint"> until {formatDate(s.endDate)}</span>}
                    </td>
                    <td>{b.accounts[s.accountId]?.name}</td>
                    <td>{payeeName(b, s)}</td>
                    <td>
                      {s.categoryId === SPLIT
                        ? `Split (${s.splits?.length ?? 0})`
                        : categoryLabel(b, s.categoryId, s.date)}
                    </td>
                    <td className="muted">{s.memo}</td>
                    <td className="r">{s.amount < 0 && <Money v={-s.amount} />}</td>
                    <td className="r">{s.amount > 0 && <Money v={s.amount} />}</td>
                    <td className="r nowrap" onDoubleClick={(e) => e.stopPropagation()}>
                      <button className="link" onClick={() => setEditing(s)}>
                        Edit
                      </button>
                      <button
                        className="link"
                        title="Enter the next one now"
                        onClick={(e) => {
                      // A double-click mustn't enter two (1.5.11).
                      if (e.detail > 1) return;
                          update(
                            'Enter scheduled transaction',
                            (d) => void enterScheduled(d, s.id, s.date <= now ? undefined : now, true),
                          );
                          toast('Entered', 'ok');
                        }}
                      >
                        Enter now
                      </button>
                      <button
                        className="link"
                        title="Skip the next one"
                        onClick={(e) => e.detail <= 1 && update('Skip scheduled transaction', (d) => skipScheduled(d, s.id))}
                      >
                        Skip
                      </button>
                      <button
                        className="link danger"
                        onClick={async () => {
                          if (
                            await confirm(
                              'Delete scheduled transaction',
                              `Stop "${payeeName(b, s)}" from repeating? Transactions already entered are kept.`,
                              'Delete',
                              true,
                            )
                          )
                            update('Delete scheduled transaction', (d) => deleteScheduled(d, s.id));
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {editing && <ScheduledEditor scheduled={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
