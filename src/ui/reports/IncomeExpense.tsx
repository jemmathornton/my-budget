import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { monthLabel } from '../../model/dates';
import { formatMoney } from '../../model/money';
import type { Budget, MonthKey } from '../../model/types';
import { ChevronDown, ChevronRight } from '../common/icons';
import { Money, cx } from '../common/Money';
import { barPath, EXPENSE_COLOR, INCOME_COLOR, Legend, MonthChart } from './charts';
import {
  incomeExpenseReport,
  selectTransactionIds,
  type IncomeExpenseReport,
  type IveRow,
  type LineSelector,
  type ReportFilters,
} from './data';
import { openRegister } from './Spending';

const INCOME_KEY = '__income__';

export function IncomeExpenseTab({ b, f, rangeText }: { b: Budget; f: ReportFilters; rangeText: string }) {
  const r = useMemo(() => incomeExpenseReport(b, f), [b, f]);
  const inc = r.incomeTotal.values;
  const exp = r.expenseTotal.values;

  if (!r.income.length && !r.expenses.length) {
    return (
      <div className="card rp-card">
        <div className="empty">No income or spending in {rangeText}.</div>
      </div>
    );
  }

  return (
    <>
      <div className="card rp-card">
        <div className="rp-card-head">
          <Legend
            items={[
              { key: 'inc', label: 'Income', color: INCOME_COLOR },
              { key: 'exp', label: 'Expenses', color: EXPENSE_COLOR },
            ]}
          />
          <div className="rp-head-stats">
            <span>
              Income <Money v={r.incomeTotal.total} />
            </span>
            <span>
              Expenses <Money v={r.expenseTotal.total} />
            </span>
            <span>
              Net income <Money v={r.net.total} colored />
            </span>
          </div>
        </div>
        <MonthChart
          months={r.months}
          height={190}
          min={Math.min(0, ...inc, ...exp)}
          max={Math.max(0, ...inc, ...exp)}
          label={`Income and expenses each month, ${rangeText}`}
          marks={(i, bx, band, y) => {
            const gap = band >= 14 ? 2 : 1;
            const w = Math.max(1, Math.min(24, Math.floor((band * 0.72 - gap) / 2)));
            const x0 = Math.round(bx + band / 2 - w - gap / 2);
            const x1 = x0 + w + gap;
            return (
              <>
                <path d={barPath(x0, w, y(0), y(inc[i]))} style={{ fill: INCOME_COLOR }} />
                <path d={barPath(x1, w, y(0), y(exp[i]))} style={{ fill: EXPENSE_COLOR }} />
              </>
            );
          }}
          tip={(i) => [
            { label: 'Income', value: formatMoney(inc[i]), color: INCOME_COLOR },
            { label: 'Expenses', value: formatMoney(exp[i]), color: EXPENSE_COLOR },
            { label: 'Net income', value: formatMoney(r.net.values[i], { plus: true }), strong: true },
          ]}
        />
      </div>
      <IveTable b={b} f={f} r={r} rangeText={rangeText} />
    </>
  );
}

type Kind = 'item' | 'master' | 'total' | 'net';

type Line =
  | { t: 'section'; key: string; label: string; toggle?: string; open?: boolean }
  | {
      t: 'row';
      key: string;
      x: IveRow;
      kind: Kind;
      sel: LineSelector | null;
      regName: string;
      indent?: boolean;
      open?: boolean;
    };

/** Column widths (px). The first column takes whatever is left, at least NAME_W. */
const NAME_W = 250;
const MONTH_W = 92;
const SIDE_W = 104;

/**
 * The month-by-month table. Months scroll sideways under a sticky first column, with Average
 * and Total kept in view on the right. Eleven years of history can mean hundreds of income
 * payees over 130 months, so both rows and month columns are virtualised: only the cells in
 * view (plus a margin) are rendered, with spacer cells standing in for the rest.
 */
function IveTable({ b, f, r, rangeText }: { b: Budget; f: ReportFilters; r: IncomeExpenseReport; rangeText: string }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const allCollapsed = r.expenses.length > 0 && r.expenses.every((g) => collapsed.has(g.key));

  const lines = useMemo(() => {
    const out: Line[] = [];
    const incomeOpen = !collapsed.has(INCOME_KEY);
    out.push({ t: 'section', key: 's-inc', label: 'Income', toggle: INCOME_KEY, open: incomeOpen });
    if (incomeOpen) {
      for (const x of r.income) {
        out.push({
          t: 'row',
          key: 'i' + x.key,
          x,
          kind: 'item',
          sel: { income: true, payeeKey: x.key },
          regName: `Income from ${x.name}`,
          indent: true,
        });
      }
    }
    out.push({ t: 'row', key: 'ti', x: r.incomeTotal, kind: 'total', sel: { income: true }, regName: 'All income' });
    out.push({ t: 'section', key: 's-exp', label: 'Expenses' });
    for (const g of r.expenses) {
      const open = !collapsed.has(g.key);
      out.push({ t: 'row', key: 'm' + g.key, x: g, kind: 'master', sel: { masterId: g.key }, regName: g.name, open });
      if (open) {
        for (const c of g.children) {
          out.push({ t: 'row', key: 'c' + c.key, x: c, kind: 'item', sel: { categoryId: c.key }, regName: c.name, indent: true });
        }
      }
    }
    out.push({ t: 'row', key: 'te', x: r.expenseTotal, kind: 'total', sel: {}, regName: 'All expenses' });
    out.push({ t: 'row', key: 'net', x: r.net, kind: 'net', sel: null, regName: '' });
    return out;
  }, [r, collapsed]);

  // ---- Virtual window ----
  const n = r.months.length;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [rowH, setRowH] = useState(27);
  const [win, setWin] = useState({ r0: 0, r1: 40, c0: 0, c1: 16 });
  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const head = el.querySelector('thead') as HTMLElement | null;
    const top = Math.max(0, el.scrollTop - (head?.offsetHeight ?? 30));
    const rs = Math.floor(top / rowH);
    const re = Math.ceil((top + el.clientHeight) / rowH);
    const monthsW = Math.max(MONTH_W, el.clientWidth - NAME_W - 2 * SIDE_W);
    const cs = Math.floor(el.scrollLeft / MONTH_W);
    const ce = Math.ceil((el.scrollLeft + monthsW) / MONTH_W);
    setWin((w) =>
      rs >= w.r0 && re <= w.r1 && cs >= w.c0 && ce <= w.c1
        ? w
        : { r0: Math.max(0, rs - 15), r1: re + 15, c0: Math.max(0, cs - 4), c1: ce + 4 },
    );
  }, [rowH]);
  useLayoutEffect(() => {
    const tr = scrollRef.current?.querySelector('tbody tr.rp-v') as HTMLElement | null;
    const h = tr?.getBoundingClientRect().height;
    if (h && Math.abs(h - rowH) > 0.25) setRowH(h);
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, [update, lines.length, n]);

  const r0 = Math.min(win.r0, lines.length);
  const r1 = Math.min(win.r1, lines.length);
  // Few months: render them all and let the table size its columns to fit their contents.
  const virt = n > 24;
  const c0 = virt ? Math.min(win.c0, n) : 0;
  const c1 = virt ? Math.min(win.c1, n) : n;
  const shown: number[] = [];
  for (let i = c0; i < c1; i++) shown.push(i);
  const colCount = 3 + shown.length + (c0 > 0 ? 1 : 0) + (c1 < n ? 1 : 0);
  /** The month cells of a row, with spacers for the months out of view. */
  const months = (cell: (i: number) => ReactNode, gap: (side: 'l' | 'r') => ReactNode) => (
    <>
      {c0 > 0 && gap('l')}
      {shown.map(cell)}
      {c1 < n && gap('r')}
    </>
  );

  const open = (sel: LineSelector, name: string, month?: MonthKey) => {
    const ids = selectTransactionIds(b, f, month ? { ...sel, month } : sel);
    if (ids.length) openRegister(ids, `${name} · ${month ? monthLabel(month, true) : rangeText}`);
  };
  const gapTd = (side: string) => <td key={'gap' + side} className="rp-gap" />;

  const renderLine = (l: Line) => {
    if (l.t === 'section') {
      return (
        <tr key={l.key} className="rp-v rp-section">
          <td className="rp-sl">
            {l.toggle ? (
              <button className="rp-master-btn" aria-expanded={l.open} onClick={() => toggle(l.toggle!)}>
                {l.open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>{l.label}</span>
              </button>
            ) : (
              <span>{l.label}</span>
            )}
          </td>
          {months((i) => <td key={i} />, gapTd)}
          <td className="rp-sr2" />
          <td className="rp-sr1" />
        </tr>
      );
    }
    const { x, kind, sel, regName } = l;
    const blank = kind === 'item' || kind === 'master';
    return (
      <tr key={l.key} className={cx('rp-v', 'rp-' + kind, x.hidden && 'rp-hidden-cat')}>
        <td className={cx('rp-sl', l.indent && 'rp-indent')}>
          {kind === 'master' ? (
            <button className="rp-master-btn rp-sl-in" aria-expanded={l.open} onClick={() => toggle(x.key)} title={x.name}>
              {l.open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span className="rp-ellipsis">{x.name}</span>
            </button>
          ) : (
            <div className="rp-sl-in" title={x.name}>
              <span className="rp-ellipsis">{x.name}</span>
              {x.hidden && <span className="rp-tag">hidden</span>}
            </div>
          )}
        </td>
        {months((i) => {
          const v = x.values[i];
          const can = !!sel && v !== 0;
          return (
            <td
              key={i}
              className={cx('r', can && 'rp-click')}
              title={can ? 'Show these transactions' : undefined}
              onClick={can ? () => open(sel!, regName, r.months[i]) : undefined}
            >
              <Money v={v} blankZero={blank} colored={kind === 'net'} />
            </td>
          );
        }, gapTd)}
        <td className="r rp-sr2">
          <Money v={x.average} blankZero={kind === 'item'} colored={kind === 'net'} />
        </td>
        <td
          className={cx('r rp-sr1', sel && x.total !== 0 && 'rp-click')}
          title={sel && x.total ? 'Show these transactions' : undefined}
          onClick={sel && x.total ? () => open(sel, regName) : undefined}
        >
          <Money v={x.total} colored={kind === 'net'} />
        </td>
      </tr>
    );
  };

  return (
    <div className="card rp-card rp-fill rp-ive">
      <div className="rp-card-head">
        <h2>Income v Expense by month</h2>
        {r.expenses.length > 0 && (
          <button
            className="btn small"
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(r.expenses.map((g) => g.key)))}
          >
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        )}
      </div>
      <div className="rp-scroll" ref={scrollRef} onScroll={update}>
        <table
          className={cx('rp-grid-table', virt && 'rp-fixed', n <= 6 && 'rp-wide-names')}
          style={virt ? { width: `max(100%, ${NAME_W + n * MONTH_W + 2 * SIDE_W}px)` } : undefined}
        >
          <thead>
            <tr>
              <th className="rp-sl" />
              {months(
                (i) => (
                  <th key={i} className="r" style={virt ? { width: MONTH_W } : undefined}>
                    {monthLabel(r.months[i], true)}
                  </th>
                ),
                (side) => (
                  <th key={'gap' + side} className="rp-gap" style={{ width: (side === 'l' ? c0 : n - c1) * MONTH_W }} />
                ),
              )}
              <th className="r rp-sr2" style={{ width: SIDE_W }}>
                Average
              </th>
              <th className="r rp-sr1" style={{ width: SIDE_W }}>
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {r0 > 0 && (
              <tr className="rp-spacer" style={{ height: r0 * rowH }} aria-hidden>
                <td colSpan={colCount} />
              </tr>
            )}
            {lines.slice(r0, r1).map(renderLine)}
            {r1 < lines.length && (
              <tr className="rp-spacer" style={{ height: (lines.length - r1) * rowH }} aria-hidden>
                <td colSpan={colCount} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
