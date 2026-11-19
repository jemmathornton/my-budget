import { useMemo } from 'react';
import { monthLabel } from '../../model/dates';
import { formatMoney } from '../../model/money';
import type { Budget } from '../../model/types';
import { Money, cx } from '../common/Money';
import { barPath, barWidth, Legend, MonthChart, slotColor, ViewSwitch, type TipRow } from './charts';
import { OTHER, SLOT_COUNT, trendsReport, type ReportFilters, type TrendSeries } from './data';

const seriesName = (s: TrendSeries) => (s.key === OTHER ? `Other (${s.members.length})` : s.name);

export function TrendsTab({
  b,
  f,
  rangeText,
  table,
  setTable,
  hidden,
  setHidden,
}: {
  b: Budget;
  f: ReportFilters;
  rangeText: string;
  table: boolean;
  setTable: (v: boolean) => void;
  /** The series switched off in the legend (kept by Reports, so printing leaves them out too). */
  hidden: Set<string>;
  setHidden: (f: (s: Set<string>) => Set<string>) => void;
}) {
  const r = useMemo(() => trendsReport(b, f), [b, f]);
  const visible = useMemo(() => r.series.filter((s) => !hidden.has(s.key)), [r, hidden]);
  // Only this report's series count: keys from another range or filter don't.
  const offCount = r.series.length - visible.length;
  const n = r.months.length;

  // Stack tops per month (positive values up, net refunds down).
  const { hi, lo, totals } = useMemo(() => {
    let hi = 0;
    let lo = 0;
    const totals = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let up = 0;
      let down = 0;
      for (const s of visible) {
        const v = s.values[i];
        if (v > 0) up += v;
        else down += v;
        totals[i] += v;
      }
      hi = Math.max(hi, up);
      lo = Math.min(lo, down);
    }
    return { hi, lo, totals };
  }, [visible, n]);

  const toggle = (key: string) =>
    setHidden((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (!r.series.length) {
    return (
      <div className="card rp-card">
        <div className="empty">No spending in {rangeText}.</div>
      </div>
    );
  }

  return (
    <div className={cx('card rp-card', table ? 'rp-fill' : 'rp-grow')}>
      <div className="rp-card-head rp-card-head-top">
        <div className="rp-legend-wrap">
          <Legend
            items={r.series.map((s) => ({
              key: s.key,
              label: seriesName(s),
              color: slotColor(s.slot),
              value: formatMoney(s.total),
              off: hidden.has(s.key),
            }))}
            onToggle={toggle}
          />
          {offCount > 0 && (
            <button className="link small" onClick={() => setHidden(() => new Set())}>
              Show all
            </button>
          )}
        </div>
        <ViewSwitch table={table} onChange={setTable} />
      </div>

      {table ? (
        <div className="rp-scroll">
          <table className="rp-grid-table">
            <thead>
              <tr>
                <th className="rp-sl">Master category</th>
                {r.months.map((m) => (
                  <th key={m} className="r">
                    {monthLabel(m, true)}
                  </th>
                ))}
                <th className="r rp-sr2">Average</th>
                <th className="r rp-sr1">Total</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => (
                <tr key={s.key} className="rp-item">
                  <td className="rp-sl">
                    <span className="rp-swatch" style={{ background: slotColor(s.slot), borderColor: slotColor(s.slot) }} />
                    {seriesName(s)}
                  </td>
                  {s.values.map((v, i) => (
                    <td key={i} className="r">
                      <Money v={v} blankZero />
                    </td>
                  ))}
                  <td className="r rp-sr2">
                    <Money v={Math.round(s.total / Math.max(1, n))} />
                  </td>
                  <td className="r rp-sr1">
                    <Money v={s.total} />
                  </td>
                </tr>
              ))}
              <tr className="rp-total">
                <td className="rp-sl">Total</td>
                {totals.map((v, i) => (
                  <td key={i} className="r">
                    <Money v={v} />
                  </td>
                ))}
                <td className="r rp-sr2">
                  <Money v={Math.round(totals.reduce((a, v) => a + v, 0) / Math.max(1, n))} />
                </td>
                <td className="r rp-sr1">
                  <Money v={totals.reduce((a, v) => a + v, 0)} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <MonthChart
          months={r.months}
          min={lo}
          max={hi}
          label={`Spending by master category each month, ${rangeText}`}
          marks={(i, bx, band, y) => {
            const w = barWidth(band);
            const x = Math.round(bx + (band - w) / 2);
            const up = visible.filter((s) => s.values[i] > 0);
            const down = visible.filter((s) => s.values[i] < 0);
            const out: React.ReactNode[] = [];
            // Each segment leaves a 2px gap to its neighbour; the outermost gets the rounded end.
            const stack = (list: typeof visible, dir: 1 | -1) => {
              let base = 0;
              list.forEach((s, k) => {
                const v = s.values[i];
                const y0 = y(base);
                const y1 = y(base + v);
                base += v;
                const inner = k > 0 ? 1 : 0;
                const outer = k < list.length - 1 ? 1 : 0;
                const a = y0 - dir * inner;
                const z = y1 + dir * outer;
                if ((a - z) * dir < 0.5) return;
                const d = outer ? rectPath(x, w, a, z) : barPath(x, w, a, z);
                out.push(<path key={s.key + dir} d={d} style={{ fill: slotColor(s.slot) }} />);
              });
            };
            stack(up, 1);
            stack(down, -1);
            return <>{out}</>;
          }}
          tip={(i) => {
            const rows: TipRow[] = [];
            for (let k = visible.length - 1; k >= 0; k--) {
              const s = visible[k];
              if (s.values[i]) rows.push({ label: seriesName(s), value: formatMoney(s.values[i]), color: slotColor(s.slot) });
            }
            rows.push({ label: offCount ? 'Total shown' : 'Total spending', value: formatMoney(totals[i]), strong: true });
            return rows;
          }}
        />
      )}
      <div className="rp-foot-note">
        {r.series.some((s) => s.key === OTHER)
          ? `The ${SLOT_COUNT} master categories with the most spending in ${rangeText}; the rest are in Other.`
          : `Spending by master category, ${rangeText}.`}{' '}
        Click a legend item to hide or show it.
      </div>
    </div>
  );
}

function rectPath(x: number, w: number, y0: number, y1: number): string {
  const t = Math.min(y0, y1);
  const h = Math.abs(y1 - y0);
  return `M${x},${t.toFixed(2)}h${w}v${h.toFixed(2)}h${-w}Z`;
}
