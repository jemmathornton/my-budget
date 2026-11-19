import { useMemo, useState } from 'react';
import { formatMoney } from '../../model/money';
import type { Budget, Money as MoneyValue } from '../../model/types';
import { ui } from '../../state/ui';
import { ChevronRight } from '../common/icons';
import { Money, cx } from '../common/Money';
import { slotColor } from './charts';
import {
  formatShare,
  masterName,
  OTHER,
  pieSegments,
  selectTransactionIds,
  spendingRank,
  spendingReport,
  type LineSelector,
  type ReportFilters,
  type Segment,
  type SpendingRow,
  type SpendingView,
} from './data';

const ROW_LIMIT = 250;

/** Opens the register showing just these transactions. */
export function openRegister(ids: string[], label: string): void {
  ui.go({ view: 'account', id: 'all' }, { registerFilter: { ids, label } });
}

export function SpendingTab({
  b,
  f,
  view,
  setView,
  rangeText,
}: {
  b: Budget;
  f: ReportFilters;
  view: SpendingView;
  setView: (v: SpendingView) => void;
  rangeText: string;
}) {
  const masterId = view.masterId && b.masters[view.masterId] ? view.masterId : null;
  const report = useMemo(() => spendingReport(b, f, { by: view.by, masterId }), [b, f, view.by, masterId]);
  const level = view.by === 'payee' ? 'payee' : masterId ? 'category' : 'master';
  const segs = useMemo(() => pieSegments(report.rows, spendingRank(b, level)), [b, report, level]);
  const segOf = useMemo(() => {
    const m = new Map<string, Segment>();
    for (const s of segs) for (const k of s.keys) m.set(k, s);
    return m;
  }, [segs]);
  const [hover, setHover] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const hoverSeg = hover ? segOf.get(hover) : undefined;

  const register = (row: SpendingRow) => {
    const sel: LineSelector =
      view.by === 'payee'
        ? { payeeKey: row.key, masterId: masterId ?? undefined }
        : masterId
          ? { categoryId: row.key, masterId }
          : { masterId: row.key };
    const name = view.by === 'payee' && masterId ? `${row.name} (${masterName(b, masterId)})` : row.name;
    openRegister(selectTransactionIds(b, f, sel), `${name} · ${rangeText}`);
  };
  const activate = (row: SpendingRow) => {
    if (row.drillable && view.by === 'category') {
      setHover(null);
      setShowAll(false);
      setView({ ...view, masterId: row.key });
    } else register(row);
  };
  const rowByKey = useMemo(() => new Map(report.rows.map((r) => [r.key, r])), [report]);

  const nameHead = view.by === 'payee' ? 'Payee' : masterId ? 'Category' : 'Master category';
  const rows = showAll ? report.rows : report.rows.slice(0, ROW_LIMIT);

  return (
    <div className="card rp-card rp-spending">
      <div className="rp-card-head">
        <nav className="rp-crumbs" aria-label="Breadcrumb">
          {masterId ? (
            <>
              <button className="link" onClick={() => setView({ ...view, masterId: null })}>
                All spending
              </button>
              <ChevronRight size={12} />
              <span className="rp-crumb-here">{masterName(b, masterId)}</span>
            </>
          ) : (
            <span className="rp-crumb-here">{view.by === 'payee' ? 'All spending by payee' : 'All spending'}</span>
          )}
        </nav>
        <div className="seg" role="group" aria-label="Group spending by">
          <button className={cx(view.by === 'category' && 'on')} onClick={() => setView({ ...view, by: 'category' })}>
            Categories
          </button>
          <button className={cx(view.by === 'payee' && 'on')} onClick={() => setView({ ...view, by: 'payee' })}>
            Payees
          </button>
        </div>
      </div>

      {!report.rows.length ? (
        <div className="empty">No spending {masterId ? 'in this group ' : ''}in {rangeText}.</div>
      ) : (
        <div className="rp-spend-body">
          <div className="rp-spend-left">
            <Donut
              segs={segs}
              hover={hoverSeg?.key ?? null}
              onHover={(k) => setHover(k)}
              onPick={(s) => {
                const row = s.key === OTHER ? undefined : rowByKey.get(s.key);
                if (row) activate(row);
              }}
              centre={
                hoverSeg ? (
                  <>
                    <div className="rp-dc-label">{hoverSeg.name}</div>
                    <div className="rp-dc-value">{formatMoney(hoverSeg.value)}</div>
                    <div className="rp-dc-sub">{formatShare(report.total ? hoverSeg.value / report.total : 0)} of spending</div>
                  </>
                ) : (
                  <>
                    <div className="rp-dc-label">{masterId ? masterName(b, masterId) : 'Total spending'}</div>
                    <div className="rp-dc-value">{formatMoney(report.total)}</div>
                    <div className="rp-dc-sub">{formatMoney(report.average)} a month</div>
                  </>
                )
              }
            />
            <div className="rp-spend-note">
              {report.months} {report.months === 1 ? 'month' : 'months'} · {rangeText}
            </div>
          </div>

          <div className="rp-spend-table">
            <table className="simple-table rp-table">
              <thead>
                <tr>
                  <th className="rp-sw-col" aria-hidden />
                  <th>{nameHead}</th>
                  <th className="r">Total</th>
                  <th className="r">% of total</th>
                  <th className="r">Average a month</th>
                  <th className="rp-act-col" aria-hidden />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const seg = segOf.get(row.key);
                  const hot = !!hoverSeg && hoverSeg.keys.includes(row.key);
                  const drill = row.drillable && view.by === 'category';
                  return (
                    <tr
                      key={row.key}
                      className={cx('clickable', hot && 'rp-hot', row.hidden && 'rp-hidden-cat')}
                      tabIndex={0}
                      title={drill ? 'Show its categories' : 'Show these transactions'}
                      onMouseEnter={() => setHover(row.key)}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover(row.key)}
                      onBlur={() => setHover(null)}
                      onClick={() => activate(row)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          activate(row);
                        }
                      }}
                    >
                      <td className="rp-sw-col">
                        {seg && <span className="rp-swatch" style={{ background: slotColor(seg.slot), borderColor: slotColor(seg.slot) }} />}
                      </td>
                      <td className="rp-name">
                        {row.name}
                        {row.hidden && <span className="rp-tag">hidden</span>}
                      </td>
                      <td className="r">
                        <Money v={row.total} />
                      </td>
                      <td className="r rp-num">{formatShare(row.share)}</td>
                      <td className="r">
                        <Money v={row.average} />
                      </td>
                      <td className="rp-act-col">
                        {drill ? (
                          <button
                            className="icon-btn rp-row-btn"
                            title="Show these transactions"
                            aria-label={`Show ${row.name} transactions`}
                            onClick={(e) => {
                              e.stopPropagation();
                              register(row);
                            }}
                          >
                            <ListIcon />
                          </button>
                        ) : (
                          <span className="rp-row-go" aria-hidden>
                            <ListIcon />
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {report.rows.length > rows.length && (
                  <tr>
                    <td />
                    <td colSpan={5}>
                      <button className="link" onClick={() => setShowAll(true)}>
                        Show all {report.rows.length} payees
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td />
                  <td>Total</td>
                  <td className="r">
                    <Money v={report.total} />
                  </td>
                  <td className="r rp-num">100.0%</td>
                  <td className="r">
                    <Money v={report.average} />
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ListIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
      <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />
    </svg>
  );
}

// ---- Donut -----------------------------------------------------------------------------------

const SIZE = 300;
const R_OUT = 138;
const R_IN = 88;

function arc(c: number, R: number, r: number, a0: number, a1: number): string {
  if (a1 - a0 >= Math.PI * 2 - 1e-6) {
    // A full ring: two half rings (an arc can't start and end at the same point).
    return arc(c, R, r, a0, a0 + Math.PI) + arc(c, R, r, a0 + Math.PI, a1);
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (rad: number, a: number) => `${(c + rad * Math.cos(a)).toFixed(2)},${(c + rad * Math.sin(a)).toFixed(2)}`;
  return `M${p(R, a0)}A${R},${R} 0 ${large} 1 ${p(R, a1)}L${p(r, a1)}A${r},${r} 0 ${large} 0 ${p(r, a0)}Z`;
}

function Donut({
  segs,
  hover,
  onHover,
  onPick,
  centre,
}: {
  segs: Segment[];
  hover: string | null;
  onHover: (key: string | null) => void;
  onPick: (s: Segment) => void;
  centre: React.ReactNode;
}) {
  const total = segs.reduce((s, x) => s + x.value, 0);
  let a = -Math.PI / 2;
  const paths = segs.map((s) => {
    const a0 = a;
    const a1 = a + (total ? (s.value / total) * Math.PI * 2 : 0);
    a = a1;
    return { s, a0, a1 };
  });
  const c = SIZE / 2;
  return (
    <div className="rp-donut" style={{ width: SIZE, height: SIZE }}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
        {paths.map(({ s, a0, a1 }) => {
          const hot = hover === s.key;
          const v: MoneyValue = s.value;
          return (
            <path
              key={s.key}
              d={arc(c, hot ? R_OUT + 6 : R_OUT, R_IN, a0, a1)}
              className={cx('rp-seg', segs.length > 1 && 'gap', hover && !hot && 'dim', s.key === OTHER && 'other')}
              style={{ fill: slotColor(s.slot) }}
              onPointerEnter={() => onHover(s.keys[0])}
              onPointerLeave={() => onHover(null)}
              onClick={() => onPick(s)}
            >
              <title>{`${s.name}: ${formatMoney(v)}`}</title>
            </path>
          );
        })}
      </svg>
      <div className="rp-donut-centre" style={{ width: R_IN * 2 - 18 }}>
        {centre}
      </div>
    </div>
  );
}
