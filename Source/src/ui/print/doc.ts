import { formatDate, today } from '../../model/dates';
import { csv, text } from '../../model/exportCsv';
import { formatMoney, moneyToInput } from '../../model/money';
import type { Money } from '../../model/types';

// A printout (1.5.1): what the budget, a register or a report shows, as titled tables. The same
// description becomes the page that's printed or saved as a PDF (A4, black on white, "Page N of
// M" at the foot) and, with Ctrl+E, a CSV file for a spreadsheet. No React, no window.

/** Text, an amount, or nothing. */
export type Cell = string | { money: Money } | null;

export interface DocRow {
  cells: Cell[];
  /** A master category or group heading, a total line, or a split line under its transaction. */
  kind?: 'group' | 'total' | 'sub';
}

export interface DocColumn {
  label: string;
  /** Amounts: right-aligned. */
  money?: boolean;
  /** A short column (date, cleared), kept to its contents. */
  narrow?: boolean;
  /** Amounts below zero aren't red here (outflows and budgeted amounts are negative as a matter of course). */
  plain?: boolean;
}

export interface DocTable {
  /** A heading over the table, when a printout has more than one. */
  heading?: string;
  columns: DocColumn[];
  rows: DocRow[];
}

/** A report's chart, as drawn on screen (see chart.ts). */
export interface PrintChart {
  /** The chart's SVG, serialised from the app's own drawing. */
  svg: string;
  legend: { label: string; color: string; line?: boolean }[];
  /** The doughnut's centre text ("Total spending · £2,368.29"). */
  caption?: string;
}

export interface PrintDoc {
  /** The file name to suggest, without the extension. */
  name: string;
  title: string;
  /** Lines under the title: the budget, the account, the filters in force. */
  lines: string[];
  /** Figures above the tables (the budget's month heading, a register's balances). */
  summary?: { label: string; value: Cell; strong?: boolean }[];
  tables: DocTable[];
  /** A report's chart, above its tables. Not in the CSV. */
  chart?: PrintChart | null;
  /** Turn the page sideways: wide registers and reports. */
  landscape?: boolean;
}

export const money = (v: Money): Cell => ({ money: v });

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function cellHtml(c: Cell, red = true): string {
  if (c === null) return '';
  if (typeof c === 'string') return esc(c);
  return `<span class="${red && c.money < 0 ? 'neg' : ''}">${esc(formatMoney(c.money))}</span>`;
}

const PAGE_CSS = (landscape: boolean) => `
@page {
  size: A4 ${landscape ? 'landscape' : 'portrait'};
  margin: 14mm 12mm 16mm;
  @bottom-left { content: var(--foot); }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt system-ui, sans-serif; color: #555; }
}
html { background: #fff; }
@media screen {
  html { background: #868b92; }
  body { background: #fff; width: ${landscape ? 273 : 186}mm; margin: 14px auto !important; padding: 14mm 12mm; box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35); }
}
body { margin: 0; color: #000; font: 9pt "Segoe UI", system-ui, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h1 { font-size: 15pt; font-weight: 600; margin: 0 0 2pt; }
.lines { color: #333; margin-bottom: 8pt; }
.lines div { margin: 1pt 0; }
.summary { border-collapse: collapse; margin: 0 0 10pt; }
.summary td { padding: 1.5pt 14pt 1.5pt 0; }
.summary td.v { text-align: right; font-variant-numeric: tabular-nums; }
.summary tr.strong td { font-weight: 700; border-top: 0.75pt solid #000; padding-top: 3pt; }
h2 { font-size: 11pt; font-weight: 600; margin: 12pt 0 4pt; break-after: avoid; }
table.t { border-collapse: collapse; width: 100%; }
table.t thead { display: table-header-group; }
table.t th { text-align: left; font-weight: 600; border-bottom: 1pt solid #000; padding: 3pt 4pt; vertical-align: bottom; }
table.t td { padding: 2pt 4pt; border-bottom: 0.4pt solid #ccc; vertical-align: top; overflow-wrap: anywhere; }
table.t tr { break-inside: avoid; }
table.t .m { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
table.t .n { white-space: nowrap; width: 1%; }
table.t tr.group td { font-weight: 700; background: #eee; }
table.t tr.total td { font-weight: 700; border-top: 0.75pt solid #000; border-bottom: 1.5pt double #000; }
table.t tr.sub td { color: #444; border-bottom-style: dotted; }
table.t tr.sub td:first-child { padding-left: 14pt; }
.neg { color: #b00; }
:root {
  --rp-c1: #2a78d6; --rp-c2: #eb6834; --rp-c3: #1baf7a; --rp-c4: #eda100; --rp-c5: #e87ba4; --rp-c6: #008300;
  --rp-c7: #4a3aa7; --rp-c8: #e34948; --rp-other: #a3abb3; --rp-grid: #e2e5e9; --rp-axis: #9aa3ac; --text: #000; --bg: #fff;
}
.chart { margin: 2pt 0 10pt; break-inside: avoid; }
.chart svg { display: block; max-width: 100%; max-height: 85mm; width: auto; height: auto; margin: 0 auto; }
.chart svg text { font: 8pt "Segoe UI", system-ui, sans-serif; fill: #333; font-variant-numeric: tabular-nums; }
.chart .rp-tick-sub { fill: #666; }
.chart .rp-grid { stroke: var(--rp-grid); stroke-width: 1; }
.chart .rp-base { stroke: var(--rp-axis); stroke-width: 1; }
.chart .rp-line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.chart .rp-dot, .chart .rp-seg.gap { stroke: #fff; stroke-width: 2; }
.chart .caption { text-align: center; font-weight: 600; margin-top: 3pt; }
.legend { display: flex; flex-wrap: wrap; gap: 3pt 12pt; justify-content: center; margin-top: 5pt; }
.legend .sw { display: inline-block; width: 8pt; height: 8pt; border-radius: 2pt; margin-right: 4pt; vertical-align: -1pt; }
.legend .sw.line { height: 2pt; vertical-align: 2pt; }
.empty { color: #555; font-style: italic; padding: 6pt 0; }
`;

/** The printout as a page of its own (no scripts), ready to print or turn into a PDF. */
export function docHtml(d: PrintDoc, printedOn = today()): string {
  const foot = `${d.title} · printed ${formatDate(printedOn)}`;
  // A CSS string; "<" escaped so a name can't end the style block.
  const footCss = '"' + foot.replace(/[\\"]/g, '\\$&').replace(/</g, '\\3c ').replace(/[\r\n]/g, ' ') + '"';
  // A function, so "$&" or "$'" in a name is taken literally.
  const css = PAGE_CSS(!!d.landscape).replace('var(--foot)', () => footCss + '; font: 8pt system-ui, sans-serif; color: #555');
  const out: string[] = [
    `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${esc(d.title)}</title><style>${css}</style></head><body>`,
    `<h1>${esc(d.title)}</h1>`,
    `<div class="lines">${d.lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>`,
  ];
  if (d.summary?.length) {
    out.push('<table class="summary"><tbody>');
    for (const s of d.summary) out.push(`<tr${s.strong ? ' class="strong"' : ''}><td>${esc(s.label)}</td><td class="v">${cellHtml(s.value, !!s.strong)}</td></tr>`);
    out.push('</tbody></table>');
  }
  if (d.chart) {
    // Colours are only the reports' variables or plain colour values, nothing else.
    const colour = (c: string) => (/^(var\(--[a-z0-9-]+\)|#[0-9a-f]{3,8}|rgba?\([\d., ]+\))$/i.test(c.trim()) ? c.trim() : '#999');
    out.push(`<div class="chart">${d.chart.svg}`);
    if (d.chart.caption) out.push(`<div class="caption">${esc(d.chart.caption)}</div>`);
    if (d.chart.legend.length)
      out.push(
        '<div class="legend">' +
          d.chart.legend.map((l) => `<span><span class="sw${l.line ? ' line' : ''}" style="background:${colour(l.color)}"></span>${esc(l.label)}</span>`).join('') +
          '</div>',
      );
    out.push('</div>');
  }
  for (const t of d.tables) {
    if (t.heading) out.push(`<h2>${esc(t.heading)}</h2>`);
    if (!t.rows.length) {
      out.push('<div class="empty">Nothing to show.</div>');
      continue;
    }
    const cls = (c: DocColumn) => (c.money ? 'm' : c.narrow ? 'n' : '');
    out.push('<table class="t"><thead><tr>');
    for (const c of t.columns) out.push(`<th class="${cls(c)}">${esc(c.label)}</th>`);
    out.push('</tr></thead><tbody>');
    for (const r of t.rows) {
      out.push(r.kind ? `<tr class="${r.kind}">` : '<tr>');
      // A heading on its own ("Income") runs across the table.
      if (r.cells.length === 1 && t.columns.length > 1) out.push(`<td colspan="${t.columns.length}">${cellHtml(r.cells[0])}</td>`);
      else r.cells.forEach((c, i) => out.push(`<td class="${t.columns[i] ? cls(t.columns[i]) : ''}">${cellHtml(c, !t.columns[i]?.plain)}</td>`));
      out.push('</tr>');
    }
    out.push('</tbody></table>');
  }
  out.push('</body></html>');
  return out.join('');
}

/**
 * The printout as CSV: the title and lines first, then each table with its heading. Amounts are
 * plain numbers ("-12.50") so a spreadsheet can add them up; text Excel would take for a formula
 * is kept as text, as in "Export budget data".
 */
export function docCsv(d: PrintDoc): string {
  const cell = (c: Cell): string | number => (c === null ? '' : typeof c === 'string' ? text(c) : moneyToInput(c.money) || '0.00');
  const rows: (string | number)[][] = [[text(d.title)], ...d.lines.map((l) => [text(l)])];
  if (d.summary?.length) {
    rows.push([]);
    for (const s of d.summary) rows.push([text(s.label), cell(s.value)]);
  }
  for (const t of d.tables) {
    rows.push([]);
    if (t.heading) rows.push([text(t.heading)]);
    rows.push(t.columns.map((c) => text(c.label)));
    for (const r of t.rows) rows.push(r.cells.map(cell));
  }
  return csv(rows);
}

/** A name Windows accepts for a file. */
export function fileName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'My Budget';
}
