import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { monthLabel } from '../../model/dates';
import { unit } from '../../model/money';
import type { MonthKey } from '../../model/types';
import { cx } from '../common/Money';
import { formatCompact, monthAxisLabels, niceTicks } from './data';

// Hand-written SVG chart pieces shared by the reports. Colours come from CSS variables
// (src/styles/reports.css), so charts follow the light/dark theme without re-rendering.

/** The colour of a categorical slot (0-7), or the "Other" grey for -1. */
export function slotColor(slot: number): string {
  return slot < 0 ? 'var(--rp-other)' : `var(--rp-c${slot + 1})`;
}

export const INCOME_COLOR = slotColor(0);
export const EXPENSE_COLOR = slotColor(1);
export const NET_COLOR = 'var(--text)';

/** The element's size, kept up to date as it resizes. */
export function useSize<T extends HTMLElement>(initial = { width: 800, height: 300 }) {
  const ref = useRef<T>(null);
  const [size, setSize] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () =>
      setSize((s) => (s.width === el.clientWidth && s.height === el.clientHeight ? s : { width: el.clientWidth, height: el.clientHeight }));
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/**
 * A bar from the baseline `y0` to the data end `y1` (above or below the baseline), with
 * rounded corners at the data end only.
 */
export function barPath(x: number, w: number, y0: number, y1: number, r = 4): string {
  const h = Math.abs(y1 - y0);
  if (h < 0.25 || w <= 0) return '';
  const rr = Math.max(0, Math.min(r, w / 2, h));
  const f = (n: number) => Math.round(n * 100) / 100;
  if (y1 < y0) {
    return `M${f(x)},${f(y0)}V${f(y1 + rr)}A${rr},${rr} 0 0 1 ${f(x + rr)},${f(y1)}H${f(x + w - rr)}A${rr},${rr} 0 0 1 ${f(x + w)},${f(y1 + rr)}V${f(y0)}Z`;
  }
  return `M${f(x)},${f(y0)}V${f(y1 - rr)}A${rr},${rr} 0 0 0 ${f(x + rr)},${f(y1)}H${f(x + w - rr)}A${rr},${rr} 0 0 0 ${f(x + w)},${f(y1 - rr)}V${f(y0)}Z`;
}

/** Bar width for a band: thin (at most 24px), leaving the rest of the band as air. */
export function barWidth(band: number, share = 0.62): number {
  return Math.max(1, Math.min(24, Math.floor(band * share)));
}

export interface TipRow {
  label: string;
  value: string;
  /** Colour of the short line key; none for totals. */
  color?: string;
  strong?: boolean;
}

/** The hover readout: values lead, labels follow, each keyed by a short stroke of its colour. */
export function ChartTip({ x, width, title, rows }: { x: number; width: number; title: string; rows: TipRow[] }) {
  const flip = x > width / 2;
  return (
    <div className="rp-tip" style={flip ? { right: width - x + 14 } : { left: x + 14 }}>
      <div className="rp-tip-title">{title}</div>
      {rows.map((r, i) => (
        <div key={i} className={cx('rp-tip-row', r.strong && 'strong')}>
          <span className="rp-tip-key" style={r.color ? { background: r.color } : undefined} />
          <span className="rp-tip-val">{r.value}</span>
          <span className="rp-tip-lbl">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

export interface LegendItem {
  key: string;
  label: string;
  color: string;
  shape?: 'rect' | 'line';
  value?: string;
  off?: boolean;
}

/** A legend. With `onToggle`, each item is a button that hides or shows its series. */
export function Legend({ items, onToggle }: { items: LegendItem[]; onToggle?: (key: string) => void }) {
  return (
    <div className="rp-legend">
      {items.map((it) => {
        const body = (
          <>
            <span
              className={cx('rp-swatch', it.shape === 'line' && 'line')}
              style={{ background: it.off ? 'transparent' : it.color, borderColor: it.color }}
            />
            <span className="rp-legend-label">{it.label}</span>
            {it.value && <span className="rp-legend-value">{it.value}</span>}
          </>
        );
        return onToggle ? (
          <button
            key={it.key}
            className={cx('rp-legend-item', 'toggle', it.off && 'off')}
            aria-pressed={!it.off}
            title={it.off ? 'Show this series' : 'Hide this series'}
            onClick={() => onToggle(it.key)}
          >
            {body}
          </button>
        ) : (
          <span key={it.key} className="rp-legend-item">
            {body}
          </span>
        );
      })}
    </div>
  );
}

export interface MonthChartProps {
  months: MonthKey[];
  /** Fixed height; leave out to fill the space the parent gives it (see `.rp-chart.fill`). */
  height?: number;
  /** The data's lowest and highest values (0 is always included). */
  min: number;
  max: number;
  /** The marks for month `i`, whose band starts at `bx` and is `band` wide. */
  marks: (i: number, bx: number, band: number, y: (v: number) => number) => ReactNode;
  /** Drawn over the marks (e.g. a line), given band centres. */
  overlay?: (cx: (i: number) => number, y: (v: number) => number, band: number, active: number | null) => ReactNode;
  tip: (i: number) => TipRow[];
  onPick?: (i: number) => void;
  label: string;
}

/**
 * A chart with one band per month: y-axis ticks and gridlines, thinned month labels, and a
 * hover/keyboard readout for the month under the pointer.
 */
export function MonthChart(p: MonthChartProps) {
  const [ref, size] = useSize<HTMLDivElement>();
  const width = size.width;
  const height = p.height ?? Math.max(120, size.height);
  const [active, setActive] = useState<number | null>(null);
  const n = p.months.length;
  const top = 10;
  const bottom = 34;
  const right = 14;
  const plotH = Math.max(20, height - top - bottom);
  const t = niceTicks(p.min, p.max, Math.max(3, Math.min(6, Math.round(plotH / 64))), unit());
  const tickText = t.ticks.map(formatCompact);
  const left = Math.ceil(Math.max(...tickText.map((s) => s.length)) * 6.4) + 14;
  const plotW = Math.max(20, width - left - right);
  const band = plotW / Math.max(1, n);
  const y = (v: number) => top + ((t.hi - v) / (t.hi - t.lo || 1)) * plotH;
  const mid = (i: number) => left + (i + 0.5) * band;
  const crisp = (v: number) => Math.round(v) + 0.5;
  const labels = monthAxisLabels(p.months, band);

  const at = (e: { clientX: number; currentTarget: Element }): number | null => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left - left;
    if (x < 0 || x >= plotW || !n) return null;
    return Math.max(0, Math.min(n - 1, Math.floor(x / band)));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const d = e.key === 'ArrowLeft' ? -1 : 1;
      setActive((a) => (a === null ? (d > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, a + d))));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : n - 1);
    } else if (e.key === 'Enter' && active !== null) p.onPick?.(active);
    else if (e.key === 'Escape') setActive(null);
  };

  return (
    <div className={cx('rp-chart', p.height === undefined && 'fill')} ref={ref} style={p.height ? { height: p.height } : undefined}>
      <svg
        className="rp-svg"
        width={width}
        height={height}
        role="img"
        aria-label={p.label + '. Use the arrow keys to read each month.'}
        tabIndex={0}
        style={p.onPick && active !== null ? { cursor: 'pointer' } : undefined}
        onPointerMove={(e) => setActive(at(e))}
        onPointerLeave={() => setActive(null)}
        onClick={(e) => {
          const i = at(e);
          if (i !== null) p.onPick?.(i);
        }}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        {active !== null && <rect className="rp-band" x={left + active * band} y={top} width={band} height={plotH} />}
        {t.ticks.map((v, k) => (
          <g key={v}>
            {v !== 0 && <line className="rp-grid" x1={left} x2={left + plotW} y1={crisp(y(v))} y2={crisp(y(v))} />}
            <text className="rp-tick" x={left - 8} y={y(v)} dy="0.32em" textAnchor="end">
              {tickText[k]}
            </text>
          </g>
        ))}
        {p.months.map((m, i) => (
          <g key={m}>{p.marks(i, left + i * band, band, y)}</g>
        ))}
        <line className="rp-base" x1={left} x2={left + plotW} y1={crisp(y(0))} y2={crisp(y(0))} />
        {p.overlay?.(mid, y, band, active)}
        {labels.map((l) => (
          <text key={l.i} className="rp-tick" x={mid(l.i)} y={top + plotH + 15} textAnchor="middle">
            {l.label}
            {l.sub && (
              <tspan className="rp-tick-sub" x={mid(l.i)} dy="12">
                {l.sub}
              </tspan>
            )}
          </text>
        ))}
      </svg>
      {active !== null && <ChartTip x={mid(active)} width={width} title={monthLabel(p.months[active])} rows={p.tip(active)} />}
    </div>
  );
}

/** A "Chart | Table" switch for a card header. */
export function ViewSwitch({ table, onChange }: { table: boolean; onChange: (table: boolean) => void }) {
  return (
    <div className="seg" role="group" aria-label="Show as">
      <button className={cx(!table && 'on')} aria-pressed={!table} onClick={() => onChange(false)}>
        Chart
      </button>
      <button className={cx(table && 'on')} aria-pressed={table} onClick={() => onChange(true)}>
        Table
      </button>
    </div>
  );
}
