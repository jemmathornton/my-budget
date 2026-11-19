import type { Id, ScheduledTransaction } from '../../model/types';
import { cx } from '../common/Money';
import { Modal } from '../common/overlay';
import { columnKeys, gridTemplate, type ColKey, type RegisterColumns } from '../register/columns';
import { TxEditor } from '../register/TxEditor';

const COLUMNS: RegisterColumns = { account: true, check: false, balance: false };
const LABELS: Partial<Record<ColKey, string>> = {
  account: 'Account',
  date: 'Next date',
  payee: 'Payee',
  category: 'Category',
  memo: 'Memo',
  outflow: 'Outflow',
  inflow: 'Inflow',
};

/** Adds or edits a scheduled transaction in a dialog (the Scheduled screen and the register's pane). */
export function ScheduledEditor({
  scheduled,
  accountId = 'all',
  onClose,
}: {
  /** The one to edit, or undefined for a new one. */
  scheduled?: ScheduledTransaction;
  /** The account a new one starts in, or 'all'. */
  accountId?: Id | 'all';
  onClose: () => void;
}) {
  return (
    <Modal title={scheduled ? 'Edit scheduled transaction' : 'Add a scheduled transaction'} onClose={onClose} width={1180}>
      <div className="hint" style={{ marginBottom: 6 }}>
        The date is when it's next due. Monthly schedules keep the day of the month (a schedule on the 31st uses the last
        day of shorter months).
      </div>
      {/* The editor is one register row; these name its boxes. */}
      <div className="rgrid sched-labels" style={{ gridTemplateColumns: gridTemplate(COLUMNS) }} aria-hidden>
        {columnKeys(COLUMNS).map((k) => (
          <span key={k} className={cx((k === 'outflow' || k === 'inflow') && 'r')}>
            {LABELS[k] ?? ''}
          </span>
        ))}
      </div>
      <div style={{ position: 'relative' }}>
        <TxEditor
          className="top"
          accountId={accountId}
          scheduled={scheduled}
          scheduleMode
          columns={COLUMNS}
          onCancel={onClose}
          onDone={onClose}
        />
      </div>
    </Modal>
  );
}
