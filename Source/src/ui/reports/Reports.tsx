import { useEffect, useMemo, useState } from 'react';
import { MONTH_SHORT, pad2, today } from '../../model/dates';
import { categoriesOf, sortedAccounts, sortedMasters } from '../../model/queries';
import type { Account, Budget, Category, Id, MonthKey } from '../../model/types';
import { useBudget } from '../../state/store';
import { CheckIcon, ChevronDown } from '../common/icons';
import { cx } from '../common/Money';
import { Popover } from '../common/overlay';
import {
  dataBounds,
  isRangePreset,
  payeeCounted,
  payeeKeyName,
  payeesInRange,
  RANGE_PRESETS,
  rangeLabel,
  resolveRange,
  type MonthSpan,
  type PayeeFilter,
  type RangePreset,
  type ReportFilters,
  type SpendingView,
  UNCATEGORISED,
} from './data';
import { IncomeExpenseTab } from './IncomeExpense';
import { NetWorthTab } from './NetWorth';
import { SpendingTab } from './Spending';
import { TrendsTab } from './Trends';
import { reportDoc } from '../print/docs';
import { captureChart } from '../print/chart';
import { usePrintable } from '../print/printable';
import '../../styles/reports.css';

// The Reports screen: Spending, Income v Expense, Net Worth and Spending Trends, sharing one
// filter bar (date range, accounts, categories, hidden categories). The tab, range, the chosen
// categories (per budget) and a few view choices are remembered on this computer.

export type ReportTab = 'spending' | 'ive' | 'networth' | 'trends';

const TABS: { id: ReportTab; label: string }[] = [
  { id: 'spending', label: 'Spending' },
  { id: 'ive', label: 'Income v Expense' },
  { id: 'networth', label: 'Net Worth' },
  { id: 'trends', label: 'Spending Trends' },
];

interface Saved {
  tab: ReportTab;
  preset: RangePreset;
  custom?: MonthSpan;
  includeHidden: boolean;
  spendBy: 'category' | 'payee';
  netWorthTable: boolean;
  trendsTable: boolean;
  /** The categories chosen, by budget id (YNAB4 kept its "Selected Categories" too). */
  categories?: Record<Id, Id[]>;
}

const STORAGE_KEY = 'reports';
const MONTH_RE = /^\d{4}-\d{2}$/;

function loadSaved(): Saved {
  const def: Saved = {
    tab: 'spending',
    preset: 'this-year',
    includeHidden: false,
    spendBy: 'category',
    netWorthTable: false,
    trendsTable: false,
  };
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<Saved>;
    return {
      tab: TABS.some((t) => t.id === s.tab) ? s.tab! : def.tab,
      preset: isRangePreset(s.preset) ? s.preset : def.preset,
      custom:
        s.custom && MONTH_RE.test(s.custom.from) && MONTH_RE.test(s.custom.to)
          ? { from: s.custom.from, to: s.custom.to }
          : undefined,
      includeHidden: !!s.includeHidden,
      spendBy: s.spendBy === 'payee' ? 'payee' : 'category',
      netWorthTable: !!s.netWorthTable,
      trendsTable: !!s.trendsTable,
      categories:
        s.categories && typeof s.categories === 'object'
          ? Object.fromEntries(Object.entries(s.categories).filter(([, v]) => Array.isArray(v)))
          : undefined,
    };
  } catch {
    return def;
  }
}

function save(s: Saved): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Remembering the view is a convenience; carry on without it.
  }
}

/** The Reports screen. Takes no props: it reads the open budget from the store. */
export function Reports() {
  const b = useBudget();
  const [initial] = useState(loadSaved);
  const [tab, setTab] = useState<ReportTab>(initial.tab);
  const [preset, setPreset] = useState<RangePreset>(initial.preset);
  const [custom, setCustom] = useState<MonthSpan | undefined>(initial.custom);
  const [accounts, setAccounts] = useState<Id[] | null>(null);
  const [includeHidden, setIncludeHidden] = useState(initial.includeHidden);
  const [spendView, setSpendView] = useState<SpendingView>({ by: initial.spendBy, masterId: null });
  const [netWorthTable, setNetWorthTable] = useState(initial.netWorthTable);
  const [trendsTable, setTrendsTable] = useState(initial.trendsTable);
  // Spending Trends' series switched off in its legend: here so the printout leaves them out too.
  const [trendsHidden, setTrendsHidden] = useState<Set<string>>(() => new Set());
  const [savedCats, setSavedCats] = useState<Record<Id, Id[]>>(initial.categories ?? {});
  // Payees are chosen for the moment only, not remembered.
  const [payees, setPayees] = useState<PayeeFilter | null>(null);
  const setCategories = (ids: Id[] | null) =>
    setSavedCats((all) => {
      const next = { ...all };
      if (ids) next[b.id] = ids;
      else delete next[b.id];
      return next;
    });

  useEffect(() => {
    save({ tab, preset, custom, includeHidden, spendBy: spendView.by, netWorthTable, trendsTable, categories: savedCats });
  }, [tab, preset, custom, includeHidden, spendView.by, netWorthTable, trendsTable, savedCats]);

  const now = today();
  const bounds = dataBounds(b);
  const range = resolveRange(preset, now, { bounds, custom });
  // Forget accounts that have been deleted.
  const accIds = useMemo(() => (accounts ? accounts.filter((id) => b.accounts[id]) : null), [accounts, b.accounts]);
  // Forget categories that have been deleted.
  const catIds = useMemo(() => {
    const saved = savedCats[b.id];
    return saved ? saved.filter((id) => id === UNCATEGORISED || b.categories[id]) : null;
  }, [savedCats, b.id, b.categories]);
  const filters: ReportFilters = useMemo(
    () => ({ from: range.from, to: range.to, accounts: accIds, includeHidden, categories: catIds, payees }),
    [range.from, range.to, accIds, includeHidden, catIds, payees],
  );
  const rangeText = rangeLabel(range.from, range.to);
  // The printout: the open report as a table, whichever way it's shown (1.5.1).
  // With the chart as drawn, when the report shows one (not its table view).
  usePrintable(() => ({ ...reportDoc(b, tab, filters, rangeText, spendView, trendsHidden), chart: captureChart(document.querySelector('.rp-body')) }));

  const pickPreset = (p: RangePreset) => {
    if (p === 'custom') setCustom(range);
    setPreset(p);
  };

  return (
    <div className="rp">
      <div className="rp-head">
        <h1>Reports</h1>
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={cx('tab', tab === t.id && 'active')}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rp-filters">
        <RangeButton preset={preset} now={now} bounds={bounds} custom={custom} onPick={pickPreset} />
        {preset === 'custom' && (
          <span className="rp-custom">
            <MonthSelect
              value={range.from}
              bounds={bounds}
              now={now}
              label="From"
              onChange={(m) => setCustom({ from: m, to: m > range.to ? m : range.to })}
            />
            <span className="muted">to</span>
            <MonthSelect
              value={range.to}
              bounds={bounds}
              now={now}
              label="To"
              onChange={(m) => setCustom({ from: m < range.from ? m : range.from, to: m })}
            />
          </span>
        )}
        <AccountsButton b={b} accounts={accIds} setAccounts={setAccounts} netWorth={tab === 'networth'} />
        <CategoriesButton b={b} categories={catIds} setCategories={setCategories} includeHidden={includeHidden} disabled={tab === 'networth'} />
        <PayeesButton b={b} from={range.from} to={range.to} accounts={accIds} payees={payees} setPayees={setPayees} disabled={tab === 'networth'} />
        <label
          className={cx('check rp-hidden-check', tab === 'networth' && 'disabled')}
          title={tab === 'networth' ? 'Net Worth uses account balances, not categories' : undefined}
        >
          <input
            type="checkbox"
            checked={includeHidden}
            disabled={tab === 'networth'}
            onChange={(e) => setIncludeHidden(e.target.checked)}
          />
          Include hidden categories
        </label>
      </div>

      <div className="rp-body" role="tabpanel">
        {tab === 'spending' && (
          <SpendingTab b={b} f={filters} view={spendView} setView={setSpendView} rangeText={rangeText} />
        )}
        {tab === 'ive' && <IncomeExpenseTab b={b} f={filters} rangeText={rangeText} />}
        {tab === 'networth' && (
          <NetWorthTab b={b} f={filters} rangeText={rangeText} table={netWorthTable} setTable={setNetWorthTable} />
        )}
        {tab === 'trends' && (
          <TrendsTab b={b} f={filters} rangeText={rangeText} table={trendsTable} setTable={setTrendsTable} hidden={trendsHidden} setHidden={setTrendsHidden} />
        )}
      </div>
    </div>
  );
}

// ---- Date range ------------------------------------------------------------------------------

function RangeButton({
  preset,
  now,
  bounds,
  custom,
  onPick,
}: {
  preset: RangePreset;
  now: string;
  bounds: MonthSpan | null;
  custom?: MonthSpan;
  onPick: (p: RangePreset) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const label = RANGE_PRESETS.find((p) => p.id === preset)!.label;
  const span = (p: RangePreset) => {
    const r = resolveRange(p, now, { bounds, custom });
    return rangeLabel(r.from, r.to);
  };
  return (
    <>
      <button
        className="btn small rp-filter-btn"
        aria-haspopup="listbox"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <CalendarGlyph />
        <span className="rp-fb-main">{label}</span>
        {preset !== 'custom' && <span className="rp-fb-sub">{span(preset)}</span>}
        <ChevronDown size={12} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <div className="rp-presets" role="listbox" aria-label="Date range">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.id}
                role="option"
                aria-selected={p.id === preset}
                className={cx('rp-preset', p.id === preset && 'on', p.id === 'custom' && 'custom')}
                onClick={() => {
                  onPick(p.id);
                  setAnchor(null);
                }}
              >
                <span className="rp-preset-check">{p.id === preset && <CheckIcon size={14} />}</span>
                <span className="rp-preset-label">{p.id === 'custom' ? 'Custom range…' : p.label}</span>
                {p.id !== 'custom' && <span className="rp-preset-span">{span(p.id)}</span>}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

function CalendarGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="2" y="3" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" />
    </svg>
  );
}

/** A month and a year drop-down. */
function MonthSelect({
  value,
  bounds,
  now,
  label,
  onChange,
}: {
  value: MonthKey;
  bounds: MonthSpan | null;
  now: string;
  label: string;
  onChange: (m: MonthKey) => void;
}) {
  const year = +value.slice(0, 4);
  const thisYear = +now.slice(0, 4);
  const first = Math.min(bounds ? +bounds.from.slice(0, 4) : thisYear - 5, year);
  const last = Math.max(bounds ? +bounds.to.slice(0, 4) : thisYear, thisYear, year);
  const years: number[] = [];
  for (let y = last; y >= first; y--) years.push(y);
  return (
    <span className="rp-month-select" role="group" aria-label={label}>
      <select
        aria-label={label + ' month'}
        value={+value.slice(5, 7)}
        onChange={(e) => onChange(`${year}-${pad2(+e.target.value)}`)}
      >
        {MONTH_SHORT.map((m, i) => (
          <option key={m} value={i + 1}>
            {m}
          </option>
        ))}
      </select>
      <select aria-label={label + ' year'} value={year} onChange={(e) => onChange(`${e.target.value}-${value.slice(5, 7)}`)}>
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </span>
  );
}

// ---- Accounts --------------------------------------------------------------------------------

function AccountsButton({
  b,
  accounts,
  setAccounts,
  netWorth,
}: {
  b: Budget;
  accounts: Id[] | null;
  setAccounts: (ids: Id[] | null) => void;
  netWorth: boolean;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const all = sortedAccounts(b);
  const onBudget = all.filter((a) => a.onBudget);
  const offBudget = all.filter((a) => !a.onBudget);
  const selected = new Set(accounts ?? all.map((a) => a.id));
  const relevant = netWorth ? all : onBudget;
  const n = relevant.filter((a) => selected.has(a.id)).length;
  const label = !accounts || n === relevant.length
    ? netWorth
      ? 'All accounts'
      : 'All budget accounts'
    : n === 0
      ? 'No accounts'
      : n === 1
        ? relevant.find((a) => selected.has(a.id))!.name
        : `${n} of ${relevant.length} ${netWorth ? 'accounts' : 'budget accounts'}`;

  const apply = (s: Set<Id>) => setAccounts(all.every((a) => s.has(a.id)) ? null : all.filter((a) => s.has(a.id)).map((a) => a.id));
  const toggle = (id: Id) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    apply(s);
  };
  const setGroup = (group: Account[], on: boolean) => {
    const s = new Set(selected);
    for (const a of group) {
      if (on) s.add(a.id);
      else s.delete(a.id);
    }
    apply(s);
  };
  const group = (title: string, list: Account[], hint?: string) =>
    list.length > 0 && (
      <div className="rp-acc-group">
        <div className="rp-acc-head">
          <span>{title}</span>
          {hint && <span className="rp-acc-hint">{hint}</span>}
          <span className="grow" />
          <button className="link small" onClick={() => setGroup(list, true)}>
            All
          </button>
          <button className="link small" onClick={() => setGroup(list, false)}>
            None
          </button>
        </div>
        {list.map((a) => (
          <label key={a.id} className="check rp-acc-row">
            <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} />
            <span className="rp-acc-name">{a.name}</span>
            {a.closed && <span className="rp-tag">closed</span>}
          </label>
        ))}
      </div>
    );

  return (
    <>
      <button
        className={cx('btn small rp-filter-btn', accounts && 'on')}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <BankGlyph />
        <span className="rp-fb-main">{label}</span>
        <ChevronDown size={12} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={320}>
          <div className="rp-acc-pop">
            {group('Budget accounts', onBudget)}
            {group('Off-budget accounts', offBudget, 'Net Worth only')}
            {!all.length && <div className="muted small">There are no accounts yet.</div>}
            <div className="rp-acc-foot">
              <button className="btn small" disabled={!accounts} onClick={() => setAccounts(null)}>
                Reset
              </button>
              <button className="btn small primary" onClick={() => setAnchor(null)}>
                Done
              </button>
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

// ---- Payees ----------------------------------------------------------------------------------

/**
 * Which payees the reports count (1.5). There are hundreds, so the list is the range's payees,
 * most spent first, with a box to find them by name; up to 200 are shown at once. Unticking from
 * "All payees" keeps a list of exceptions, so payees the range doesn't show stay counted.
 */
function PayeesButton({
  b,
  from,
  to,
  accounts,
  payees,
  setPayees,
  disabled,
}: {
  b: Budget;
  from: MonthKey;
  to: MonthKey;
  accounts: Id[] | null;
  payees: PayeeFilter | null;
  setPayees: (f: PayeeFilter | null) => void;
  disabled: boolean;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [find, setFind] = useState('');
  const all = anchor ? payeesInRange(b, from, to, accounts) : [];
  const q = find.trim().toLowerCase();
  const shown = (q ? all.filter((k) => payeeKeyName(b, k).toLowerCase().includes(q)) : all).slice(0, 200);
  const n = payees?.keys.length ?? 0;
  const label = !payees
    ? 'All payees'
    : payees.except
      ? `All but ${n} payee${n === 1 ? '' : 's'}`
      : n === 0
        ? 'No payees'
        : n === 1
          ? payeeKeyName(b, payees.keys[0])
          : `${n} payees`;
  // Ticks or unticks some payees, keeping the filter as "only these" or "all but these".
  const set = (keys: string[], on: boolean) => {
    const f = payees ?? { keys: [], except: true };
    const s = new Set(f.keys);
    for (const k of keys) {
      if (on !== f.except) s.add(k);
      else s.delete(k);
    }
    setPayees(f.except && !s.size ? null : { keys: [...s], except: f.except });
  };
  return (
    <>
      <button
        className={cx('btn small rp-filter-btn', payees && !disabled && 'on')}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        disabled={disabled}
        title={disabled ? 'Net Worth uses account balances, not payees' : undefined}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <span className="rp-fb-main">{label}</span>
        <ChevronDown size={12} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={340}>
          <div className="rp-acc-pop rp-cat-pop">
            <div className="rp-acc-head">
              <span>Payees</span>
              <span className="grow" />
              <button className="link small" onClick={() => (q ? set(shown, true) : setPayees(null))}>
                {q ? 'Tick these' : 'Select all'}
              </button>
              <button className="link small" onClick={() => (q ? set(shown, false) : setPayees({ keys: [], except: false }))}>
                {q ? 'Untick these' : 'None'}
              </button>
            </div>
            <input className="rp-find" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a payee" aria-label="Find a payee" autoFocus />
            <div className="rp-cat-list">
              {shown.map((k) => (
                <label key={k} className="check rp-acc-row">
                  <input type="checkbox" checked={payeeCounted(payees, k)} onChange={() => set([k], !payeeCounted(payees, k))} />
                  <span className="rp-acc-name">{payeeKeyName(b, k)}</span>
                </label>
              ))}
              {shown.length === 0 && <div className="hint">No payee in this range matches.</div>}
            </div>
            <div className="rp-acc-foot">
              <button className="btn small" disabled={!payees} onClick={() => setPayees(null)}>
                Reset
              </button>
              <button className="btn small primary" onClick={() => setAnchor(null)}>
                Done
              </button>
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

// ---- Categories ------------------------------------------------------------------------------

/** YNAB4's "Selected Categories": which spending categories the reports count. */
function CategoriesButton({
  b,
  categories,
  setCategories,
  includeHidden,
  disabled,
}: {
  b: Budget;
  categories: Id[] | null;
  setCategories: (ids: Id[] | null) => void;
  includeHidden: boolean;
  disabled: boolean;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const groups = sortedMasters(b)
    .map((m) => ({ m, cats: categoriesOf(b, m.id, includeHidden) }))
    .filter((g) => g.cats.length);
  const allIds = [...groups.flatMap((g) => g.cats.map((c) => c.id)), UNCATEGORISED];
  const selected = new Set(categories ?? allIds);
  const n = allIds.filter((id) => selected.has(id)).length;
  const name = (id: Id) => (id === UNCATEGORISED ? 'Uncategorised' : b.categories[id]?.name ?? '');
  const label = !categories || n === allIds.length ? 'All categories' : n === 0 ? 'No categories' : n === 1 ? name(allIds.find((id) => selected.has(id))!) : `${n} of ${allIds.length} categories`;
  const apply = (s: Set<Id>) => setCategories(allIds.every((id) => s.has(id)) ? null : allIds.filter((id) => s.has(id)));
  const toggle = (id: Id) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    apply(s);
  };
  const setGroup = (list: Category[], on: boolean) => {
    const s = new Set(selected);
    for (const c of list) {
      if (on) s.add(c.id);
      else s.delete(c.id);
    }
    apply(s);
  };
  return (
    <>
      <button
        className={cx('btn small rp-filter-btn', categories && !disabled && 'on')}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        disabled={disabled}
        title={disabled ? 'Net Worth uses account balances, not categories' : undefined}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <span className="rp-fb-main">{label}</span>
        <ChevronDown size={12} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={340}>
          <div className="rp-acc-pop rp-cat-pop">
            <div className="rp-acc-head">
              <span>Categories</span>
              <span className="grow" />
              <button className="link small" onClick={() => apply(new Set(allIds))}>
                Select all
              </button>
              <button className="link small" onClick={() => apply(new Set())}>
                None
              </button>
            </div>
            <div className="rp-cat-list">
              {groups.map(({ m, cats }) => (
                <div key={m.id} className="rp-acc-group">
                  <div className="rp-acc-head">
                    <span>{m.name}</span>
                    <span className="grow" />
                    <button className="link small" onClick={() => setGroup(cats, true)}>
                      All
                    </button>
                    <button className="link small" onClick={() => setGroup(cats, false)}>
                      None
                    </button>
                  </div>
                  {cats.map((c) => (
                    <label key={c.id} className="check rp-acc-row">
                      <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                      <span className="rp-acc-name">{c.name}</span>
                      {c.hidden && <span className="rp-tag">hidden</span>}
                    </label>
                  ))}
                </div>
              ))}
              <label className="check rp-acc-row">
                <input type="checkbox" checked={selected.has(UNCATEGORISED)} onChange={() => toggle(UNCATEGORISED)} />
                <span className="rp-acc-name">Uncategorised</span>
              </label>
            </div>
            <div className="rp-acc-foot">
              <button className="btn small" disabled={!categories} onClick={() => setCategories(null)}>
                Reset
              </button>
              <button className="btn small primary" onClick={() => setAnchor(null)}>
                Done
              </button>
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

function BankGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden>
      <path d="M2 6.2L8 2.5l6 3.7" />
      <path d="M3.5 7v5M6.5 7v5M9.5 7v5M12.5 7v5M2 13.5h12" />
    </svg>
  );
}
