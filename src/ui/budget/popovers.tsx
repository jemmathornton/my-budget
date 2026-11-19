import { useMemo, useState } from 'react';
import { addMonths, formatDateShort, monthLabel, monthName, thisMonth } from '../../model/dates';
import { categoryMonth } from '../../model/engine';
import { formatMoney } from '../../model/money';
import {
  addCategory,
  deleteCategory,
  deleteMaster,
  moveCategory,
  moveMoney,
  setCategoryHidden,
  setMasterCollapsed,
  setMonthNote,
  setOverspendingHandling,
} from '../../model/ops';
import { categoriesOf, categoryTransactions, categoryUsage, payeeName, sortedMasters } from '../../model/queries';
import { INCOME_NEXT, INCOME_NOW, type Budget, type Category, type Id, type MasterCategory, type MonthKey } from '../../model/types';
import { store, update, useBudget, useComputed } from '../../state/store';
import { ui } from '../../state/ui';
import { confirm, openModal, toast } from '../common/dialogs';
import { Autocomplete, MoneyInput } from '../common/inputs';
import { useDraftText } from '../common/useDraftText';
import { Money } from '../common/Money';
import { Modal, type MenuEntry } from '../common/overlay';
import { CategoryNotes } from './Inspector';
import { categoryOptions } from '../common/options';

/** Click on a balance: overspending handling and moving money. */
export function BalancePopover({ catId, month, onClose }: { catId: Id; month: MonthKey; onClose: () => void }) {
  const b = useBudget();
  const c = useComputed(month);
  const d = categoryMonth(c, month, catId);
  const cat = b.categories[catId];
  const [dir, setDir] = useState<'to' | 'from'>(d.balance < 0 ? 'from' : 'to');
  const [amount, setAmount] = useState(Math.abs(d.balance));
  // The amount box holds something it can't read: no move until it's corrected.
  const [unreadable, setUnreadable] = useState(false);
  const [other, setOther] = useState<Id | null>(null);
  const options = useMemo(
    () => categoryOptions(b, { date: month + '-01', computed: c, income: false }).filter((o) => o.value !== catId),
    [b, c, month, catId],
  );
  if (!cat) return null;
  const doMove = () => {
    if (!other || !amount) return;
    const from = dir === 'to' ? catId : other;
    const to = dir === 'to' ? other : catId;
    update('Move money', (x) => moveMoney(x, month, from, to, amount));
    toast(`Moved ${formatMoney(amount)} ${dir === 'to' ? 'to' : 'from'} ${b.categories[other]?.name}`, 'ok');
    onClose();
  };
  const showHandling = d.balance < 0 || d.handling === 'carry';
  return (
    <div className="pop-pad">
      <div className="pop-title">
        {cat.name} · {monthLabel(month, true)}
      </div>
      <div className="insp-stats" style={{ marginBottom: 10 }}>
        <div>
          <span>Balance</span>
          <Money v={d.balance} colored />
        </div>
        {b.settings.creditOverspendingToDebt && d.balance < 0 && d.creditOver > 0 && (
          <div className="small muted">
            <span>Credit card overspending</span>
            <Money v={-d.creditOver} />
          </div>
        )}
      </div>
      {showHandling && (
        <div style={{ marginBottom: 10 }}>
          <div className="field-label" style={{ marginBottom: 4 }}>
            When this category is overspent
          </div>
          <label className="check small" style={{ alignItems: 'flex-start', marginBottom: 4 }}>
            <input
              type="radio"
              checked={d.handling === 'buffer'}
              onChange={() => update('Overspending handling', (x) => setOverspendingHandling(x, month, catId, 'buffer'))}
            />
            <span>Take it from next month's Available to Budget</span>
          </label>
          <label className="check small" style={{ alignItems: 'flex-start' }}>
            <input
              type="radio"
              checked={d.handling === 'carry'}
              onChange={() => update('Overspending handling', (x) => setOverspendingHandling(x, month, catId, 'carry'))}
            />
            <span>Carry the overspending forward in this category</span>
          </label>
          <div className="hint" style={{ marginTop: 3 }}>
            Applies to {monthName(month)} and later months until you change it.
          </div>
        </div>
      )}
      <div className="field-label" style={{ marginBottom: 4 }}>
        Move money
      </div>
      <div className="row2" style={{ marginBottom: 6 }}>
        <select value={dir} onChange={(e) => setDir(e.target.value as 'to' | 'from')} aria-label="Direction">
          <option value="to">Move to…</option>
          <option value="from">Take from…</option>
        </select>
        <MoneyInput value={amount} onCommit={(v) => setAmount(Math.abs(v))} onInput={(v) => setUnreadable(v === null)} ariaLabel="Amount to move" />
      </div>
      <Autocomplete
        value={other ? b.categories[other]?.name || '' : ''}
        options={options}
        placeholder="Choose a category"
        onChange={(_t, o) => setOther(o?.value || null)}
        ariaLabel="Other category"
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
        <button className="btn primary small" disabled={!other || !amount || unreadable} onClick={doMove}>
          Move {formatMoney(amount)}
        </button>
      </div>
    </div>
  );
}

/** Click on an outflows figure: the transactions behind it. */
export function OutflowsPopover({ catId, month, onClose }: { catId: Id; month: MonthKey; onClose: () => void }) {
  const b = useBudget();
  const rows = useMemo(() => categoryTransactions(b, catId, month), [b, catId, month]);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const cat = b.categories[catId];
  return (
    <div className="pop-pad">
      <div className="pop-title">
        {cat?.name} · {monthLabel(month, true)}
      </div>
      {rows.length === 0 ? (
        <div className="hint">No transactions in this category this month.</div>
      ) : (
        <div style={{ maxHeight: 320, overflowY: 'auto', margin: '0 -4px' }}>
          <table className="simple-table small">
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.t.id + ':' + i}
                  className="clickable"
                  onClick={() => {
                    onClose();
                    ui.go({ view: 'account', id: r.t.accountId }, { focusTxId: r.t.id });
                  }}
                >
                  <td className="nowrap muted">{formatDateShort(r.t.date)}</td>
                  <td style={{ maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {payeeName(b, r.t) || <span className="muted">(no payee)</span>}
                    {r.memo && <div className="hint" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.memo}</div>}
                  </td>
                  <td className="r">
                    <Money v={r.amount} negRed />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>Total</td>
                <td className="r">
                  <Money v={total} negRed />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {rows.length > 0 && (
        <div style={{ marginTop: 8, textAlign: 'right' }}>
          <button
            className="btn small"
            onClick={() => {
              onClose();
              ui.go(
                { view: 'account', id: 'all' },
                {
                  registerFilter: {
                    ids: [...new Set(rows.map((r) => r.t.id))],
                    label: `${cat?.name} · ${monthLabel(month, true)}`,
                  },
                },
              );
            }}
          >
            Open in register
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Click on "Income for …" in a month heading: the income counted for that month, as YNAB4 listed
 * it. That is income this month, plus income for next month from the month before.
 */
export function IncomePopover({ month, onClose }: { month: MonthKey; onClose: () => void }) {
  const b = useBudget();
  const prev = addMonths(month, -1);
  const now = useMemo(() => categoryTransactions(b, INCOME_NOW, month), [b, month]);
  const early = useMemo(() => categoryTransactions(b, INCOME_NEXT, prev), [b, prev]);
  const rows = [...now, ...early];
  const sum = (list: typeof rows) => list.reduce((s, r) => s + r.amount, 0);
  return (
    <div className="pop-pad">
      <div className="pop-title">Income for {monthLabel(month, true)}</div>
      {rows.length === 0 ? (
        <div className="hint">No income for this month yet.</div>
      ) : (
        <div style={{ maxHeight: 320, overflowY: 'auto', margin: '0 -4px' }}>
          <table className="simple-table small">
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.t.id + ':' + i}
                  className="clickable"
                  onClick={() => {
                    onClose();
                    ui.go({ view: 'account', id: r.t.accountId }, { focusTxId: r.t.id });
                  }}
                >
                  <td className="nowrap muted">{formatDateShort(r.t.date)}</td>
                  <td style={{ maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {payeeName(b, r.t) || <span className="muted">(no payee)</span>}
                    {r.memo && <div className="hint" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.memo}</div>}
                  </td>
                  <td className="r">
                    <Money v={r.amount} negRed />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              {early.length > 0 && (
                <>
                  <tr>
                    <td colSpan={2}>Received in {monthName(month)}</td>
                    <td className="r">
                      <Money v={sum(now)} negRed />
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={2}>Received in {monthName(prev)}, for {monthName(month)}</td>
                    <td className="r">
                      <Money v={sum(early)} negRed />
                    </td>
                  </tr>
                </>
              )}
              <tr>
                <td colSpan={2}>Total</td>
                <td className="r">
                  <Money v={sum(rows)} negRed />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {rows.length > 0 && (
        <div style={{ marginTop: 8, textAlign: 'right' }}>
          <button
            className="btn small"
            onClick={() => {
              onClose();
              ui.go(
                { view: 'account', id: 'all' },
                { registerFilter: { ids: [...new Set(rows.map((r) => r.t.id))], label: `Income for ${monthLabel(month, true)}` } },
              );
            }}
          >
            Open in register
          </button>
        </div>
      )}
    </div>
  );
}

export function MonthNotePopover({ month }: { month: MonthKey }) {
  const b = useBudget();
  const note = useDraftText(b.monthNotes?.[month] || '', (text, mergeKey) =>
    update('Month note', (d) => setMonthNote(d, month, text), { mergeKey }),
  );
  return (
    <div className="pop-pad">
      <div className="pop-title">Note for {monthLabel(month)}</div>
      <textarea
        className="note-box"
        autoFocus
        rows={4}
        value={note.text}
        onChange={(e) => note.onChange(e.target.value)}
        onBlur={note.flush}
      />
    </div>
  );
}

// ---- Menus ------------------------------------------------------------------------------

export function CategoryMenuItems(cat: Category, onRename: () => void, month: MonthKey = thisMonth()): MenuEntry[] {
  return [
    { label: 'Rename', onClick: onRename },
    { label: 'Notes…', onClick: () => openModal((close) => <NotesDialog catId={cat.id} month={month} onClose={close} />) },
    {
      label: cat.hidden ? 'Unhide' : 'Hide',
      onClick: async () => {
        if (!cat.hidden && !(await confirmHide(cat, thisMonth()))) return;
        update(cat.hidden ? 'Unhide category' : 'Hide category', (d) => setCategoryHidden(d, cat.id, !cat.hidden));
      },
    },
    { label: 'Move to group…', onClick: () => openModal((close) => <MoveCategoryDialog cat={cat} onClose={close} />) },
    'sep',
    { label: 'Delete…', danger: true, onClick: () => openModal((close) => <DeleteCategoryDialog catId={cat.id} onClose={close} />) },
  ];
}

export function MasterMenuItems(b: Budget, m: MasterCategory, onRename: () => void): MenuEntry[] {
  const all = categoriesOf(b, m.id, true);
  const anyVisible = all.some((c) => !c.hidden);
  return [
    { label: 'Rename', onClick: onRename },
    {
      label: 'Add category',
      onClick: () =>
        update('Add category', (d) => {
          addCategory(d, m.id, 'New Category');
          setMasterCollapsed(d, m.id, false);
        }),
    },
    {
      label: anyVisible ? 'Hide all its categories' : 'Unhide all its categories',
      disabled: all.length === 0,
      onClick: () =>
        update(anyVisible ? 'Hide categories' : 'Unhide categories', (d) => {
          for (const c of all) setCategoryHidden(d, c.id, anyVisible);
        }),
    },
    'sep',
    { label: 'Delete group…', danger: true, onClick: () => openModal((close) => <DeleteMasterDialog masterId={m.id} onClose={close} />) },
  ];
}

function MoveCategoryDialog({ cat, onClose }: { cat: Category; onClose: () => void }) {
  const b = useBudget();
  const [to, setTo] = useState(cat.masterId);
  return (
    <Modal
      title={`Move "${cat.name}"`}
      onClose={onClose}
      width={400}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => {
              if (to !== cat.masterId) update('Move category', (d) => moveCategory(d, cat.id, to, 9999));
              onClose();
            }}
          >
            Move
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Category group</span>
        <select value={to} onChange={(e) => setTo(e.target.value)} autoFocus>
          {sortedMasters(b).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
    </Modal>
  );
}

/**
 * Where a deleted category's transactions and budgeted amounts go. Nothing is chosen at first
 * (`undefined`): "(No category)" would send years of budgeted money back to Available to Budget,
 * so it has to be picked on purpose. Income isn't offered: it would turn spending into income.
 */
function ReassignPicker({ exclude, value, onChange }: { exclude: Set<Id>; value: Id | null | undefined; onChange: (v: Id | null) => void }) {
  const b = useBudget();
  const options = useMemo(
    () => categoryOptions(b, { includeHidden: true, uncategorized: true, income: false }).filter((o) => !exclude.has(o.value)),
    [b, exclude],
  );
  return (
    <select value={value === undefined ? CHOOSE : (value ?? '')} onChange={(e) => onChange(e.target.value || null)} autoFocus>
      {value === undefined && (
        <option value={CHOOSE} disabled>
          Choose a category…
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.group && o.group !== 'Other' ? o.group + ': ' : ''}
          {o.label}
        </option>
      ))}
    </select>
  );
}

const CHOOSE = '__choose__';

/** What "(No category)" means when deleting. */
const NO_CATEGORY_HINT = 'With "(No category)" its transactions need a category again, and its budgeted amounts go back to Available to Budget.';

function DeleteCategoryDialog({ catId, onClose }: { catId: Id; onClose: () => void }) {
  const b = useBudget();
  const cat = b.categories[catId];
  const used = cat ? categoryUsage(b, catId) : 0;
  const hasBudget = Object.values(b.months).some((m) => m[catId]?.budgeted);
  const [to, setTo] = useState<Id | null | undefined>(undefined);
  if (!cat) return null;
  return (
    <Modal
      title={`Delete "${cat.name}"`}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn danger"
            disabled={!!(used || hasBudget) && to === undefined}
            onClick={() => {
              update('Delete category', (d) => deleteCategory(d, catId, to ?? null));
              onClose();
            }}
          >
            Delete category
          </button>
        </>
      }
    >
      {used || hasBudget ? (
        <>
          <p style={{ marginTop: 0 }}>
            This category has {used} transaction{used === 1 ? '' : 's'}
            {hasBudget ? ' and budgeted amounts' : ''}. Where should they go?
          </p>
          <label className="field">
            <span className="field-label">Move them to</span>
            <ReassignPicker exclude={new Set([catId])} value={to} onChange={setTo} />
          </label>
          <div className="hint">
            {NO_CATEGORY_HINT} If you'd rather keep its history, hide the category instead.
          </div>
        </>
      ) : (
        <p style={{ margin: 0 }}>This category isn't used, so nothing else changes.</p>
      )}
    </Modal>
  );
}

function DeleteMasterDialog({ masterId, onClose }: { masterId: Id; onClose: () => void }) {
  const b = useBudget();
  const m = b.masters[masterId];
  const cats = m ? categoriesOf(b, masterId, true) : [];
  const used = cats.reduce((n, c) => n + categoryUsage(b, c.id), 0);
  const [to, setTo] = useState<Id | null | undefined>(undefined);
  if (!m) return null;
  const needsChoice = used > 0 || cats.some((c) => Object.values(b.months).some((mm) => mm[c.id]?.budgeted));
  return (
    <Modal
      title={`Delete group "${m.name}"`}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn danger"
            disabled={needsChoice && to === undefined}
            onClick={() => {
              update('Delete category group', (d) => deleteMaster(d, masterId, to ?? null));
              onClose();
            }}
          >
            Delete group
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        This deletes the group and its {cats.length} categor{cats.length === 1 ? 'y' : 'ies'}.
        {used > 0 && ` They have ${used} transaction${used === 1 ? '' : 's'}.`}
      </p>
      {needsChoice && (
        <>
          <label className="field">
            <span className="field-label">Move their transactions and budgeted amounts to</span>
            <ReassignPicker exclude={new Set(cats.map((c) => c.id))} value={to} onChange={setTo} />
          </label>
          <div className="hint">{NO_CATEGORY_HINT}</div>
        </>
      )}
    </Modal>
  );
}

/** Asks before hiding a category that still has money in it. */
export async function confirmHide(cat: Category, month: MonthKey): Promise<boolean> {
  const c = store.computed(month);
  const bal = c ? categoryMonth(c, month, cat.id).balance : 0;
  if (!bal) return true;
  return confirm(
    'Hide category',
    `${cat.name} has a balance of ${formatMoney(bal)} in ${monthName(month)}. Hidden categories still count in your budget. Hide it anyway?`,
    'Hide',
  );
}

/** Notes for a category: this month's note and the note that applies to every month. */
export function NotesDialog({ catId, month, onClose }: { catId: Id; month: MonthKey; onClose: () => void }) {
  const b = useBudget();
  const cat = b.categories[catId];
  if (!cat) return null;
  return (
    <Modal
      title={`Notes: ${cat.name}`}
      onClose={onClose}
      width={420}
      footer={
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <CategoryNotes catId={catId} month={month} />
    </Modal>
  );
}
