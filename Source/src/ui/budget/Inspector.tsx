import { useMemo } from 'react';
import { addMonths, formatDateShort, monthLabel, monthName, lastDayOfMonth } from '../../model/dates';
import { categoryMonth } from '../../model/engine';
import { formatMoney } from '../../model/money';
import { setBudgetedMany, setCategoryMonthNote, setCategoryNote } from '../../model/ops';
import { categoriesOf, payeeName, sortedMasters } from '../../model/queries';
import { quickBudgetChoices, quickFill, type QuickChoice } from '../../model/quickBudget';
import { SPLIT, type Id, type MonthKey } from '../../model/types';
import { update, useBudget, useComputed } from '../../state/store';
import { usePrefs } from '../../state/ui';
import { scheduledOccurrences } from '../../model/schedule';
import { Money } from '../common/Money';
import { useDraftText } from '../common/useDraftText';
import { fillMonth } from './QuickBudget';

// The right-hand panel on the budget screen (YNAB4's "Budget Inspector").
// With one category selected it shows that category; with several, their totals;
// with none, the whole month. Quick budget fills in budgeted amounts.

export function Inspector({ catIds, month, onClear }: { catIds: Id[]; month: MonthKey; onClear: () => void }) {
  const b = useBudget();
  const c = useComputed(month);
  const prefs = usePrefs();
  const ids = catIds.filter((id) => b.categories[id]);
  const allIds = useMemo(
    () => sortedMasters(b).flatMap((m) => categoriesOf(b, m.id, prefs.showHidden).map((x) => x.id)),
    [b, prefs.showHidden],
  );
  const target = ids.length ? ids : allIds;
  const totals = target.reduce(
    (t, id) => {
      const d = categoryMonth(c, month, id);
      return { budgeted: t.budgeted + d.budgeted, activity: t.activity + d.activity, balance: t.balance + d.balance, carry: t.carry + d.carryIn };
    },
    { budgeted: 0, activity: 0, balance: 0, carry: 0 },
  );
  // A whole-month fill leaves hidden categories out, as the month heading's bolt does.
  // Kept as the same list between renders, so the choices below aren't worked out every time.
  const idsKey = ids.join(',');
  const fillTarget = useMemo(
    () => (idsKey ? idsKey.split(',') : allIds.filter((id) => !b.categories[id]?.hidden)),
    [idsKey, allIds, b],
  );
  const quick = useMemo(() => quickBudgetChoices(b, c, fillTarget, month), [b, c, fillTarget, month]);

  // With nothing selected this is the whole month, which (as in YNAB4) fills only empty cells.
  const applyQuick = (q: QuickChoice) => {
    if (!ids.length) void fillMonth(q, month);
    else update(`Quick budget: ${q.label}`, (d) => setBudgetedMany(d, month, q.amounts));
  };

  const single = ids.length === 1 ? b.categories[ids[0]] : null;
  return (
    <aside className="inspector" aria-label="Inspector">
      {single ? (
        <>
          <div className="insp-sub">{b.masters[single.masterId]?.name}</div>
          <div className="insp-title">{single.name}</div>
        </>
      ) : ids.length > 1 ? (
        <>
          <div className="insp-sub">Selected</div>
          <div className="insp-title">{ids.length} categories</div>
        </>
      ) : (
        <>
          <div className="insp-sub">Budget</div>
          <div className="insp-title">All categories</div>
        </>
      )}
      <div className="insp-month">
        {monthLabel(month)}
        {ids.length > 0 && (
          <button className="link small" onClick={onClear} style={{ float: 'right' }}>
            Clear selection
          </button>
        )}
      </div>

      <div className="insp-stats">
        <div>
          <span className="muted">From {monthName(addMonths(month, -1), true)}</span>
          <Money v={totals.carry} />
        </div>
        <div>
          <span className="muted">Budgeted</span>
          <Money v={totals.budgeted} />
        </div>
        <div>
          <span className="muted">Outflows</span>
          <Money v={totals.activity} />
        </div>
        <div className="tot">
          <span>Balance</span>
          <Money v={totals.balance} colored />
        </div>
      </div>

      <div className="insp-sec">
        <div className="insp-sec-title">Quick budget</div>
        {quick.map((q) => {
          const total = Object.values(ids.length ? q.amounts : quickFill(b, q, month)).reduce((s, v) => s + v, 0);
          return (
            <button
              key={q.label}
              className="quick"
              onClick={() => applyQuick(q)}
              title={ids.length ? `Set the budgeted amount to ${formatMoney(total)}` : 'Fill in the empty budget cells'}
            >
              <span>{q.label}</span>
              <Money v={total} />
            </button>
          );
        })}
      </div>

      {single && <CategoryNotes key={single.id + ':' + month} catId={single.id} month={month} />}
      {single && <Upcoming catId={single.id} month={month} />}
    </aside>
  );
}

/** Saves as you type (see useDraftText). Give it a key of category and month, so switching saves the old one. */
export function CategoryNotes({ catId, month }: { catId: Id; month: MonthKey }) {
  const b = useBudget();
  const mn = useDraftText(b.months[month]?.[catId]?.note || '', (text, mergeKey) =>
    update('Category note', (d) => setCategoryMonthNote(d, month, catId, text), { mergeKey }),
  );
  const cn = useDraftText(b.categories[catId]?.note || '', (text, mergeKey) =>
    update('Category note', (d) => setCategoryNote(d, catId, text), { mergeKey }),
  );
  return (
    <div className="insp-sec">
      <div className="insp-sec-title">Note for {monthName(month)}</div>
      <textarea
        className="note-box"
        value={mn.text}
        placeholder="Anything to remember about this month"
        onChange={(e) => mn.onChange(e.target.value)}
        onBlur={mn.flush}
      />
      <div className="insp-sec-title" style={{ marginTop: 8 }}>
        Category note (every month)
      </div>
      <textarea
        className="note-box"
        style={{ minHeight: 44 }}
        value={cn.text}
        onChange={(e) => cn.onChange(e.target.value)}
        onBlur={cn.flush}
      />
    </div>
  );
}

function Upcoming({ catId, month }: { catId: Id; month: MonthKey }) {
  const b = useBudget();
  const rows: { date: string; name: string; amount: number }[] = [];
  for (const s of Object.values(b.scheduled)) {
    const amt =
      s.categoryId === SPLIT
        ? (s.splits || []).filter((x) => x.categoryId === catId).reduce((t, x) => t + x.amount, 0)
        : s.categoryId === catId
          ? s.amount
          : 0;
    if (!amt) continue;
    for (const d of scheduledOccurrences(s, lastDayOfMonth(addMonths(month, 1)))) {
      if (d.startsWith(month)) rows.push({ date: d, name: payeeName(b, s), amount: amt });
    }
  }
  if (!rows.length) return null;
  rows.sort((x, y) => (x.date < y.date ? -1 : 1));
  return (
    <div className="insp-sec">
      <div className="insp-sec-title">Scheduled this month</div>
      {rows.map((r, i) => (
        <div key={i} className="sched-mini">
          <span className="muted">{formatDateShort(r.date)}</span>
          <span style={{ flex: 1, padding: '0 6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.name}
          </span>
          <Money v={r.amount} negRed />
        </div>
      ))}
    </div>
  );
}
