import { useMemo } from 'react';
import { monthLabel } from '../../model/dates';
import { formatMoney } from '../../model/money';
import type { Budget } from '../../model/types';
import { Money, cx } from '../common/Money';
import { barPath, barWidth, EXPENSE_COLOR, INCOME_COLOR, Legend, MonthChart, NET_COLOR, ViewSwitch } from './charts';
import { netWorthReport, type ReportFilters } from './data';

const ASSETS_COLOR = INCOME_COLOR;
const DEBTS_COLOR = EXPENSE_COLOR;

export function NetWorthTab({
  b,
  f,
  rangeText,
  table,
  setTable,
}: {
  b: Budget;
  f: ReportFilters;
  rangeText: string;
  table: boolean;
  setTable: (v: boolean) => void;
}) {
  const r = useMemo(() => netWorthReport(b, f), [b, f]);
  const pts = r.points;
  const last = pts[pts.length - 1];
  const change = last.net - r.opening.net;

  return (
    <>
      <div className="rp-tiles">
        <Tile label="Assets" value={last.assets} sub={`at the end of ${monthLabel(last.month, true)}`} />
        <Tile label="Debts" value={last.debts} sub={`at the end of ${monthLabel(last.month, true)}`} />
        <Tile label="Net worth" value={last.net} sub={`at the end of ${monthLabel(last.month, true)}`} />
        <div className="rp-tile">
          <div className="rp-tile-label">Change</div>
          <div className={cx('rp-tile-value', change > 0 && 'up', change < 0 && 'down')}>
            {change !== 0 && <span aria-hidden>{change > 0 ? '▲ ' : '▼ '}</span>}
            {formatMoney(change, { plus: true })}
          </div>
          <div className="rp-tile-sub">
            {change > 0 ? 'Up' : change < 0 ? 'Down' : 'No change'} since the end of {monthLabel(r.opening.month, true)}
          </div>
        </div>
      </div>

      <div className={cx('card rp-card', table ? 'rp-fill' : 'rp-grow')}>
        <div className="rp-card-head">
          <Legend
            items={[
              { key: 'a', label: 'Assets', color: ASSETS_COLOR },
              { key: 'd', label: 'Debts', color: DEBTS_COLOR },
              { key: 'n', label: 'Net worth', color: NET_COLOR, shape: 'line' },
            ]}
          />
          <ViewSwitch table={table} onChange={setTable} />
        </div>
        {table ? (
          <div className="rp-scroll">
            <table className="simple-table rp-table">
              <thead>
                <tr>
                  <th>Month end</th>
                  <th className="r">Assets</th>
                  <th className="r">Debts</th>
                  <th className="r">Net worth</th>
                  <th className="r">Change</th>
                </tr>
              </thead>
              <tbody>
                {pts.map((p, i) => (
                  <tr key={p.month}>
                    <td>{monthLabel(p.month)}</td>
                    <td className="r">
                      <Money v={p.assets} />
                    </td>
                    <td className="r">
                      <Money v={p.debts} />
                    </td>
                    <td className="r">
                      <Money v={p.net} negRed />
                    </td>
                    <td className="r">
                      <Money v={p.net - (i ? pts[i - 1].net : r.opening.net)} colored plus />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <MonthChart
            months={pts.map((p) => p.month)}
            min={Math.min(0, ...pts.map((p) => p.debts), ...pts.map((p) => p.net))}
            max={Math.max(0, ...pts.map((p) => p.assets), ...pts.map((p) => p.net))}
            label={`Net worth at each month end, ${rangeText}`}
            marks={(i, bx, band, y) => {
              const w = barWidth(band);
              const x = Math.round(bx + (band - w) / 2);
              const p = pts[i];
              return (
                <>
                  <path d={barPath(x, w, y(0), y(p.assets))} style={{ fill: ASSETS_COLOR }} />
                  <path d={barPath(x, w, y(0), y(p.debts))} style={{ fill: DEBTS_COLOR }} />
                </>
              );
            }}
            overlay={(cx, y, band, active) => {
              const d = pts.map((p, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(2)},${y(p.net).toFixed(2)}`).join('');
              const dots = band >= 16;
              return (
                <g className="rp-net">
                  {pts.length > 1 && <path d={d} className="rp-line" style={{ stroke: NET_COLOR }} />}
                  {pts.map((p, i) =>
                    dots || i === active || pts.length === 1 ? (
                      <circle
                        key={p.month}
                        cx={cx(i)}
                        cy={y(p.net)}
                        r={i === active ? 5 : 4}
                        className="rp-dot"
                        style={{ fill: NET_COLOR }}
                      />
                    ) : null,
                  )}
                </g>
              );
            }}
            tip={(i) => {
              const p = pts[i];
              const prev = i ? pts[i - 1].net : r.opening.net;
              return [
                { label: 'Assets', value: formatMoney(p.assets), color: ASSETS_COLOR },
                { label: 'Debts', value: formatMoney(p.debts), color: DEBTS_COLOR },
                { label: 'Net worth', value: formatMoney(p.net), color: NET_COLOR, strong: true },
                { label: 'Change on the month before', value: formatMoney(p.net - prev, { plus: true }) },
              ];
            }}
          />
        )}
      </div>
    </>
  );
}

function Tile({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="rp-tile">
      <div className="rp-tile-label">{label}</div>
      <div className={cx('rp-tile-value', value < 0 && 'neg')}>{formatMoney(value)}</div>
      <div className="rp-tile-sub">{sub}</div>
    </div>
  );
}
