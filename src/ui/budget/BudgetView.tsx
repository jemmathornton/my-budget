import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { addMonths, monthName, thisMonth } from '../../model/dates';
import { categoryMonth, type CategoryMonthData, type Computed, type MonthSummary } from '../../model/engine';
import { formatMoney } from '../../model/money';
import { addCategory, addMaster, moveCategory, moveMaster, renameCategory, renameMaster, setBudgeted, setMasterCollapsed } from '../../model/ops';
import { categoriesOf, sortedMasters } from '../../model/queries';
import { quickBudgetChoices } from '../../model/quickBudget';
import type { Budget, Category, Id, MasterCategory, MonthKey } from '../../model/types';
import { update, useBudget, useComputed } from '../../state/store';
import { prefStore, ui, usePrefs, useUi } from '../../state/ui';
import { MoneyInput, type CommitHow } from '../common/inputs';
import { Money, cx } from '../common/Money';
import { MenuButton, modalOpen, Popover, useContextMenu, type MenuEntry } from '../common/overlay';
import { ChevronLeft, ChevronRight, EyeIcon, NoteIcon, PlusIcon, WarnIcon } from '../common/icons';
import * as actions from '../actions';
import { BalancePopover, CategoryMenuItems, IncomePopover, MasterMenuItems, MonthNotePopover, NotesDialog, OutflowsPopover } from './popovers';
import { QuickBudgetMonthButton, quickBudgetMenu } from './QuickBudget';
import { openModal } from '../common/dialogs';
import { Inspector } from './Inspector';
import { GAP, PAD, gridLayout } from './layout';
import { budgetDoc } from '../print/docs';
import { usePrintable } from '../print/printable';

interface Group {
  master: MasterCategory;
  cats: Category[];
}

/** The "Hidden Categories" group at the bottom (YNAB4's), shown with "Show hidden categories". Not a real group. */
const HIDDEN_GROUP = '__hidden_group__';

function loadHiddenCollapsed(): boolean {
  try {
    return localStorage.getItem('budgetHiddenCollapsed') === '1';
  } catch {
    return false;
  }
}

type Pop =
  | { kind: 'balance'; catId: Id; month: MonthKey; anchor: HTMLElement }
  | { kind: 'outflows'; catId: Id; month: MonthKey; anchor: HTMLElement }
  | { kind: 'income'; month: MonthKey; anchor: HTMLElement }
  | { kind: 'monthNote'; month: MonthKey; anchor: HTMLElement };

export function BudgetView() {
  const b = useBudget();
  const { month: firstMonth } = useUi();
  const prefs = usePrefs();
  const mainRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(1100);
  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth - PAD));
    ro.observe(el);
    setAvail(el.clientWidth - PAD);
    return () => ro.disconnect();
  }, []);
  const layout = gridLayout(avail, prefs.monthsShown);
  const months = useMemo(
    () => Array.from({ length: layout.months }, (_, i) => addMonths(firstMonth, i)),
    [firstMonth, layout.months],
  );
  const c = useComputed(months[months.length - 1]);

  const [hiddenCollapsed, setHiddenCollapsed] = useState(loadHiddenCollapsed);
  const groups: Group[] = useMemo(() => {
    const out = sortedMasters(b)
      .map((m) => ({ master: m, cats: categoriesOf(b, m.id) }))
      .filter((g) => g.cats.length > 0 || categoriesOf(b, g.master.id, true).length === 0);
    // As in YNAB4, hidden categories are listed together at the bottom, not in their groups.
    if (prefs.showHidden) {
      const hidden = sortedMasters(b).flatMap((m) => categoriesOf(b, m.id, true).filter((x) => x.hidden));
      if (hidden.length) {
        out.push({ master: { id: HIDDEN_GROUP, name: 'Hidden Categories', sort: Infinity, collapsed: hiddenCollapsed }, cats: hidden });
      }
    }
    return out;
  }, [b, prefs.showHidden, hiddenCollapsed]);
  const toggleHiddenGroup = () => {
    const v = !hiddenCollapsed;
    setHiddenCollapsed(v);
    try {
      localStorage.setItem('budgetHiddenCollapsed', v ? '1' : '0');
    } catch {
      // Only a convenience.
    }
  };
  const visibleCats = useMemo(() => groups.flatMap((g) => (g.master.collapsed ? [] : g.cats)), [groups]);
  // Quick Budget for a whole month fills every category except hidden ones, as YNAB4 did.
  const fillCats = useMemo(() => sortedMasters(b).flatMap((m) => categoriesOf(b, m.id).map((x) => x.id)), [b]);

  const [sel, setSel] = useState<Set<Id>>(new Set());
  const anchorRef = useRef<Id | null>(null);
  const [focusMonth, setFocusMonth] = useState<MonthKey | null>(null);
  const [editing, setEditing] = useState<{ catId: Id; month: MonthKey; initial?: string } | null>(null);
  const [openCtx, ctxNode] = useContextMenu();
  const [renaming, setRenaming] = useState<{ kind: 'cat' | 'master'; id: Id } | null>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  // After a budget cell or a name is saved or cancelled, the keyboard stays on the grid (as in
  // the register), unless the focus has gone somewhere else.
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    const now = !!(editing || renaming);
    // Once the blur that ended the edit is over, so that a click into another box keeps its focus.
    if (wasEditing.current && !now) {
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if ((!a || a === document.body) && !modalOpen()) scrollRef.current?.focus({ preventScroll: true });
      });
    }
    wasEditing.current = now;
  }, [editing, renaming]);
  const [drag, setDrag] = useState<{ kind: 'cat' | 'master'; id: Id } | null>(null);
  const [dropTarget, setDropTarget] = useState<Id | null>(null);

  const inspectorMonth = focusMonth && months.includes(focusMonth) ? focusMonth : months.includes(thisMonth()) ? thisMonth() : months[0];
  // Printing prints the month the Inspector shows, as YNAB4 printed one month.
  usePrintable(() => budgetDoc(b, c, inspectorMonth, prefs.showHidden));

  // Drop selections of categories that no longer exist, or aren't shown now (hidden, or in a
  // collapsed group): Quick Budget and the Inspector would count them unseen (1.5.11).
  useEffect(() => {
    const shown = new Set(visibleCats.map((x) => x.id));
    setSel((s) => {
      const keep = [...s].filter((id) => shown.has(id));
      return keep.length === s.size ? s : new Set(keep);
    });
  }, [visibleCats]);

  const go = (n: number) => ui.set({ month: addMonths(firstMonth, n) });

  const clickRow = (e: React.MouseEvent, catId: Id, month?: MonthKey) => {
    if (month) setFocusMonth(month);
    if (e.shiftKey && anchorRef.current) {
      const a = visibleCats.findIndex((x) => x.id === anchorRef.current);
      const z = visibleCats.findIndex((x) => x.id === catId);
      const [lo, hi] = a < z ? [a, z] : [z, a];
      setSel(new Set(visibleCats.slice(lo, hi + 1).map((x) => x.id)));
    } else if (e.ctrlKey || e.metaKey) {
      const n = new Set(sel);
      if (n.has(catId)) n.delete(catId);
      else n.add(catId);
      setSel(n);
      anchorRef.current = catId;
    } else {
      setSel(new Set([catId]));
      anchorRef.current = catId;
    }
  };

  const commitBudget = (catId: Id, month: MonthKey, v: number, how: CommitHow) => {
    const prev = b.months[month]?.[catId]?.budgeted || 0;
    if (v !== prev) update('Budget ' + (b.categories[catId]?.name || ''), (d) => setBudgeted(d, month, catId, v));
    if (how === 'blur' || how === 'enter') {
      setEditing(null);
      return;
    }
    const i = visibleCats.findIndex((x) => x.id === catId);
    const next = how === 'up' || how === 'shifttab' ? visibleCats[i - 1] : visibleCats[i + 1];
    if (next) {
      setEditing({ catId: next.id, month });
      setSel(new Set([next.id]));
      anchorRef.current = next.id;
    } else setEditing(null);
  };

  // Keyboard: arrows move the selection, Enter or typing a number edits the budgeted amount.
  const onGridKey = (e: React.KeyboardEvent) => {
    // While a dialog is open the grid waits. Its menus and pop-ups (a category's ⋯, the bolt's,
    // Move money) and boxes keep their own keys. On one of its buttons (a balance, ▼, the month
    // arrows) Enter, Space and F2 press the button; the arrows and digits still drive the grid,
    // and moving the selection takes the keyboard back to the grid, so Enter then edits that row.
    if (editing || renaming || e.defaultPrevented || modalOpen()) return;
    const t = e.target as HTMLElement;
    if (t !== e.currentTarget) {
      if (t.closest('.menu, .popover') || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'F2') return;
    }
    // Only a row that's on screen (not in a collapsed group, hidden or deleted): editing one that
    // isn't would leave an invisible box holding the keyboard (1.5.3).
    const i = anchorRef.current ? visibleCats.findIndex((x) => x.id === anchorRef.current) : -1;
    if (i < 0) anchorRef.current = null;
    const cur = anchorRef.current;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (t !== e.currentTarget) (e.currentTarget as HTMLElement).focus({ preventScroll: true });
      const n = visibleCats[Math.max(0, Math.min(visibleCats.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (n) {
        setSel(new Set([n.id]));
        anchorRef.current = n.id;
        document.querySelector(`[data-cat="${n.id}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    } else if ((e.key === 'Enter' || e.key === 'F2') && cur) {
      e.preventDefault();
      setEditing({ catId: cur, month: inspectorMonth });
    } else if (cur && /^[0-9.]$/.test(e.key) && !e.ctrlKey && !e.altKey) {
      // Typing a number on a selected row starts editing its budgeted amount, like YNAB4.
      e.preventDefault();
      setEditing({ catId: cur, month: inspectorMonth, initial: e.key });
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const idx = months.indexOf(inspectorMonth);
      const n = months[idx + (e.key === 'ArrowRight' ? 1 : -1)];
      if (n) setFocusMonth(n);
    } else if (e.key === 'Escape') {
      setSel(new Set());
    }
  };

  const onDropOnCat = (target: Category) => {
    if (drag?.kind === 'cat' && drag.id !== target.id) {
      const idx = categoriesOf(b, target.masterId, true).filter((x) => x.id !== drag.id).findIndex((x) => x.id === target.id);
      update('Move category', (d) => moveCategory(d, drag.id, target.masterId, idx));
    }
    setDrag(null);
    setDropTarget(null);
  };
  const onDropOnMaster = (target: MasterCategory) => {
    if (drag?.kind === 'cat') {
      update('Move category', (d) => moveCategory(d, drag.id, target.id, 0));
    } else if (drag?.kind === 'master' && drag.id !== target.id) {
      const idx = sortedMasters(b).filter((m) => m.id !== drag.id).findIndex((m) => m.id === target.id);
      update('Move category group', (d) => moveMaster(d, drag.id, idx));
    }
    setDrag(null);
    setDropTarget(null);
  };

  const gridStyle = {
    gridTemplateColumns: `${layout.catWidth}px repeat(${months.length}, ${layout.monthWidth}px)`,
    columnGap: GAP,
  };
  const uncategorized = c.uncategorized.length;
  const shownCats = useMemo(() => groups.flatMap((g) => g.cats), [groups]);
  const addGroup = () => {
    let id = '';
    update('Add category group', (d) => {
      id = addMaster(d, 'New Category Group');
    });
    setRenaming({ kind: 'master', id });
  };

  return (
    <div className="budget-view">
      <div className="budget-main" ref={mainRef}>
        <div
          className={cx('budget-scroll', prefs.monthHeadsCollapsed && 'heads-collapsed')}
          tabIndex={0}
          onKeyDown={onGridKey}
          ref={scrollRef}
          onFocus={(e) => {
            // Reached with Tab and nothing selected: select the first category, so it shows where the keyboard is.
            if (e.target === e.currentTarget && !sel.size && visibleCats[0] && e.currentTarget.matches(':focus-visible')) {
              setSel(new Set([visibleCats[0].id]));
              anchorRef.current = visibleCats[0].id;
            }
          }}
        >
          <div className="bgrid" style={gridStyle}>
            {/* The month selector sits above the months, with space over the categories, as in YNAB4. */}
            <div className="bnav-cat sticky-nav" />
            <div className="bnav-cell sticky-nav" style={{ gridColumn: '2 / -1' }}>
              <MonthNav months={months} go={go} />
            </div>

            <div className="bhead-cat sticky-top">
              {uncategorized > 0 && (
                <button
                  className="uncat-warn"
                  onClick={() =>
                    ui.go(
                      { view: 'account', id: 'all' },
                      { registerFilter: { ids: c.uncategorized, label: 'Needs a category' } },
                    )
                  }
                >
                  <WarnIcon size={12} /> {uncategorized} transaction{uncategorized === 1 ? '' : 's'} need
                  {uncategorized === 1 ? 's' : ''} a category
                </button>
              )}
            </div>
            {months.map((m) => (
              <div key={m} className="msum-cell sticky-top">
                <MonthHeader
                  month={m}
                  s={c.summary.get(m)}
                  note={b.monthNotes?.[m]}
                  onNote={(anchor) => setPop({ kind: 'monthNote', month: m, anchor })}
                  onIncome={(anchor) => setPop({ kind: 'income', month: m, anchor })}
                  collapsed={!!prefs.monthHeadsCollapsed}
                  catIds={fillCats}
                />
              </div>
            ))}

            <div className="bcolhead cat sticky-colhead">
              <span className="grow">Categories</span>
              <button className="icon-btn" title="Add a category group" onClick={addGroup}>
                <PlusIcon size={13} />
              </button>
              <button
                className={cx('icon-btn', prefs.showHidden && 'on')}
                title={prefs.showHidden ? 'Hide hidden categories' : 'Show hidden categories'}
                onClick={() => prefStore.set({ showHidden: !prefs.showHidden })}
              >
                <EyeIcon size={14} />
              </button>
              <MenuButton
                className="icon-btn"
                label="⋯"
                title="More"
                align="right"
                items={[
                  { label: 'Add a category group', onClick: addGroup },
                  { label: prefs.showHidden ? 'Hide hidden categories' : 'Show hidden categories', onClick: () => prefStore.set({ showHidden: !prefs.showHidden }) },
                  'sep',
                  { label: 'Expand all groups', onClick: () => actions.setAllGroupsCollapsed(false) },
                  { label: 'Collapse all groups', onClick: () => actions.setAllGroupsCollapsed(true) },
                ]}
              />
            </div>
            {months.map((m) => (
              <ColumnTitles key={m} c={c} month={m} cats={shownCats} />
            ))}
            {groups.map((g) => {
              const pseudo = g.master.id === HIDDEN_GROUP;
              return (
              <Fragment key={g.master.id}>
                <div className="brow">
                  <div
                    className={cx('mrow cat', pseudo && 'hidden-group', drag?.id === g.master.id && 'dragging', dropTarget === g.master.id && 'drop-before')}
                    draggable={!pseudo && renaming?.id !== g.master.id}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      setDrag({ kind: 'master', id: g.master.id });
                    }}
                    onDragEnd={() => {
                      setDrag(null);
                      setDropTarget(null);
                    }}
                    onDragOver={(e) => {
                      if (!drag || pseudo) return;
                      e.preventDefault();
                      setDropTarget(g.master.id);
                    }}
                    onDrop={() => !pseudo && onDropOnMaster(g.master)}
                    onDoubleClick={() => !pseudo && setRenaming({ kind: 'master', id: g.master.id })}
                    onContextMenu={(e) =>
                      pseudo
                        ? openCtx(e, [{ label: 'Hide hidden categories', onClick: () => prefStore.set({ showHidden: false }) }])
                        : openCtx(e, MasterMenuItems(b, g.master, () => setRenaming({ kind: 'master', id: g.master.id })))
                    }
                  >
                    <button
                      className="collapse"
                      onClick={() =>
                        pseudo
                          ? toggleHiddenGroup()
                          : update(g.master.collapsed ? 'Expand group' : 'Collapse group', (d) =>
                              setMasterCollapsed(d, g.master.id, !g.master.collapsed),
                            )
                      }
                      aria-label={g.master.collapsed ? 'Expand' : 'Collapse'}
                    >
                      {g.master.collapsed ? '▶' : '▼'}
                    </button>
                    {renaming?.kind === 'master' && renaming.id === g.master.id ? (
                      <RenameInput
                        value={g.master.name}
                        onDone={(v) => {
                          if (v !== null && v.trim() && v !== g.master.name)
                            update('Rename category group', (d) => renameMaster(d, g.master.id, v));
                          setRenaming(null);
                        }}
                      />
                    ) : (
                      <span className="mname" title={g.master.note || g.master.name}>
                        {g.master.name}
                      </span>
                    )}
                    {!pseudo && (
                    <span className="row-tools">
                    <button
                      className="row-btn"
                      title="Add a category to this group"
                      onClick={() => {
                        let id = '';
                        update('Add category', (d) => {
                          id = addCategory(d, g.master.id, 'New Category');
                          setMasterCollapsed(d, g.master.id, false);
                        });
                        setRenaming({ kind: 'cat', id });
                        setSel(new Set([id]));
                        anchorRef.current = id;
                      }}
                    >
                      <PlusIcon size={12} />
                    </button>
                    <MenuButton
                      className="row-btn"
                      label="⋯"
                      title="Group options"
                      items={(): MenuEntry[] => MasterMenuItems(b, g.master, () => setRenaming({ kind: 'master', id: g.master.id }))}
                    />
                    </span>
                    )}
                  </div>
                  {months.map((m) => (
                    <MasterTotals key={m} c={c} month={m} cats={g.cats} />
                  ))}
                </div>
                {!g.master.collapsed &&
                  g.cats.map((cat) => (
                    <CategoryRow
                      key={cat.id}
                      b={b}
                      c={c}
                      cat={cat}
                      inHiddenGroup={pseudo}
                      months={months}
                      selected={sel.has(cat.id)}
                      current={cat.id === (anchorRef.current && sel.has(anchorRef.current) ? anchorRef.current : [...sel][0])}
                      focusMonth={inspectorMonth}
                      editingMonth={editing?.catId === cat.id ? editing.month : null}
                      editingInitial={editing?.catId === cat.id ? editing.initial : undefined}
                      onContextMenu={(e, m) => {
                        const month = m || inspectorMonth;
                        const ids = sel.has(cat.id) ? [...sel] : [cat.id];
                        if (!sel.has(cat.id)) {
                          setSel(new Set([cat.id]));
                          anchorRef.current = cat.id;
                        }
                        if (m) setFocusMonth(m);
                        openCtx(e, [
                          ...quickBudgetMenu(b, c, ids, month),
                          'sep',
                          ...CategoryMenuItems(cat, () => setRenaming({ kind: 'cat', id: cat.id }), month),
                        ]);
                      }}
                      onNotes={() => openModal((close) => <NotesDialog catId={cat.id} month={inspectorMonth} onClose={close} />)}
                      renaming={renaming?.kind === 'cat' && renaming.id === cat.id}
                      dragging={drag?.id === cat.id}
                      dropBefore={dropTarget === cat.id}
                      onClick={(e, m) => clickRow(e, cat.id, m)}
                      onEdit={(m) => {
                        setEditing({ catId: cat.id, month: m });
                        setFocusMonth(m);
                        if (!sel.has(cat.id)) {
                          setSel(new Set([cat.id]));
                          anchorRef.current = cat.id;
                        }
                      }}
                      onCommit={(m, v, how) => commitBudget(cat.id, m, v, how)}
                      onCancelEdit={() => setEditing(null)}
                      onRename={() => setRenaming({ kind: 'cat', id: cat.id })}
                      onRenamed={(v) => {
                        if (v !== null && v.trim() && v !== cat.name) update('Rename category', (d) => renameCategory(d, cat.id, v));
                        setRenaming(null);
                      }}
                      onPop={(kind, m, anchor) => setPop({ kind, catId: cat.id, month: m, anchor })}
                      onDragStart={() => setDrag({ kind: 'cat', id: cat.id })}
                      onDragEnd={() => {
                        setDrag(null);
                        setDropTarget(null);
                      }}
                      onDragOver={(e) => {
                        if (drag?.kind !== 'cat') return;
                        e.preventDefault();
                        setDropTarget(cat.id);
                      }}
                      onDrop={() => onDropOnCat(cat)}
                    />
                  ))}
              </Fragment>
              );
            })}
            <div className="bend cat" />
            {months.map((m) => (
              <div key={m} className="bend month" />
            ))}
          </div>
          {groups.length === 0 && <div className="empty">No categories yet. Add a category group to start.</div>}
        </div>
      </div>
      {ctxNode}
      {prefs.inspector && <Inspector catIds={[...sel]} month={inspectorMonth} onClear={() => setSel(new Set())} />}

      {pop?.kind === 'balance' && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} align="right" width={300}>
          <BalancePopover catId={pop.catId} month={pop.month} onClose={() => setPop(null)} />
        </Popover>
      )}
      {pop?.kind === 'outflows' && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} align="right" width={420}>
          <OutflowsPopover catId={pop.catId} month={pop.month} onClose={() => setPop(null)} />
        </Popover>
      )}
      {pop?.kind === 'income' && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} width={420}>
          <IncomePopover month={pop.month} onClose={() => setPop(null)} />
        </Popover>
      )}
      {pop?.kind === 'monthNote' && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} width={300}>
          <MonthNotePopover month={pop.month} />
        </Popover>
      )}
    </div>
  );
}

function MonthNav({ months, go }: { months: MonthKey[]; go: (n: number) => void }) {
  const first = months[0];
  const now = thisMonth();
  // A strip of 13 months around the ones shown, like YNAB4's month selector.
  const stripStart = addMonths(first, -4);
  const strip = Array.from({ length: 13 }, (_, i) => addMonths(stripStart, i));
  return (
    <div className="mstrip" role="navigation" aria-label="Months">
      <button className="mstrip-arrow" onClick={() => go(-1)} title="Previous month (Ctrl+Left)" aria-label="Previous month">
        <ChevronLeft size={14} />
      </button>
      {strip.map((m, i) => (
        <Fragment key={m}>
          {(i === 0 || m.endsWith('-01')) && <span className="mstrip-year">{m.slice(0, 4)}</span>}
          <button
            className={cx('mstrip-tab', months.includes(m) && 'shown', m === now && 'current')}
            onClick={() => ui.set({ month: m })}
            title={monthName(m) + ' ' + m.slice(0, 4)}
          >
            {monthName(m, true)}
          </button>
        </Fragment>
      ))}
      <button className="mstrip-arrow" onClick={() => go(1)} title="Next month (Ctrl+Right)" aria-label="Next month">
        <ChevronRight size={14} />
      </button>
      <button className="mstrip-today" onClick={() => ui.set({ month: now })} disabled={first === now} title="Go to this month">
        Today
      </button>
    </div>
  );
}

function MonthHeader({
  month,
  s,
  note,
  onNote,
  onIncome,
  collapsed,
  catIds,
}: {
  month: MonthKey;
  s?: MonthSummary;
  note?: string;
  onNote: (anchor: HTMLElement) => void;
  /** "Income for …" clicked: the income behind it (YNAB4's "Click to see income transactions"). */
  onIncome: (anchor: HTMLElement) => void;
  /** Only the month and Available to Budget, as after YNAB4's "Click to collapse details". */
  collapsed: boolean;
  catIds: Id[];
}) {
  const prev = addMonths(month, -1);
  if (!s) return <div className="msum" />;
  const tone = s.atb > 0 ? 'pos' : s.atb < 0 ? 'neg' : 'zero';
  // `warn` lines (overbudgeted / overspent last month) show in red when negative.
  const line = (amt: number, label: string, neg = false, warn = false, onClick?: (anchor: HTMLElement) => void) => (
    <tr>
      <td className={cx('amt', warn && amt < 0 && 'neg')}>{formatMoney(amt, { plus: !neg && amt > 0 })}</td>
      <td className="lbl" title={onClick ? 'Click to see income transactions' : label}>
        {onClick ? (
          <button className="msum-link" onClick={(e) => onClick(e.currentTarget)}>
            {label}
          </button>
        ) : (
          label
        )}
      </td>
    </tr>
  );
  return (
    <div className={cx('msum', month === thisMonth() && 'current', collapsed && 'collapsed')}>
      <div className="msum-top">
        <div className="msum-name">
          <div className="mt-month">{monthName(month, true).toUpperCase()}</div>
          <div className="mt-year">{month.slice(0, 4)}</div>
          <button
            className={cx('mt-note', note && 'has-note')}
            title={note ? note : 'Add a note for this month'}
            onClick={(e) => onNote(e.currentTarget)}
          >
            <NoteIcon size={12} />
          </button>
        </div>
        {!collapsed && (
          <table className="msum-lines">
            <tbody>
              {line(s.notBudgetedPrev, (s.notBudgetedPrev < 0 ? 'Overbudgeted in ' : 'Not budgeted in ') + monthName(prev, true), true, true)}
              {line(s.overspentPrev, 'Overspent in ' + monthName(prev, true), true, true)}
              {line(s.income, 'Income for ' + monthName(month, true), false, false, onIncome)}
              {line(-s.budgeted, 'Budgeted in ' + monthName(month, true), true)}
              {/* As in YNAB4, only when something is budgeted in a later month. */}
              {s.budgetedInFuture !== 0 && line(-s.budgetedInFuture, 'Budgeted in future', true)}
            </tbody>
          </table>
        )}
        <QuickBudgetMonthButton month={month} catIds={catIds} />
      </div>
      {/* YNAB4: clicking Available to Budget collapses every month's details, or brings them back. */}
      <button
        className={cx('msum-atb', tone)}
        title={collapsed ? 'Click to see further details' : 'Click to collapse details'}
        aria-expanded={!collapsed}
        onClick={() => prefStore.set({ monthHeadsCollapsed: !collapsed })}
      >
        <span className="atb-amt">= {formatMoney(s.atb)}</span>
        <span className="atb-label">{s.atb < 0 ? 'Overbudgeted' : 'Available to Budget'}</span>
      </button>
    </div>
  );
}

/** "Budgeted / Outflows / Balance" with the month's totals underneath, as in YNAB4. */
function ColumnTitles({ c, month, cats }: { c: Computed; month: MonthKey; cats: Category[] }) {
  let budgeted = 0;
  let activity = 0;
  let balance = 0;
  for (const cat of cats) {
    const d = categoryMonth(c, month, cat.id);
    budgeted += d.budgeted;
    activity += d.activity;
    balance += d.balance;
  }
  return (
    <div className={cx('bcolhead month sticky-colhead', month === thisMonth() && 'current')}>
      <div>
        <span className="ch-label">Budgeted</span>
        <Money v={budgeted} />
      </div>
      <div>
        <span className="ch-label">Outflows</span>
        <Money v={activity} />
      </div>
      <div>
        <span className="ch-label">Balance</span>
        <Money v={balance} negRed />
      </div>
    </div>
  );
}
function MasterTotals({ c, month, cats }: { c: Computed; month: MonthKey; cats: Category[] }) {
  let budgeted = 0;
  let activity = 0;
  let balance = 0;
  for (const cat of cats) {
    const d = categoryMonth(c, month, cat.id);
    budgeted += d.budgeted;
    activity += d.activity;
    balance += d.balance;
  }
  return (
    <div className="mrow month">
      <Money v={budgeted} />
      <Money v={activity} />
      <Money v={balance} negRed />
    </div>
  );
}

function CategoryRow(p: {
  b: Budget;
  c: Computed;
  cat: Category;
  /** Listed in "Hidden Categories": named with its own group, and not dragged. */
  inHiddenGroup?: boolean;
  months: MonthKey[];
  selected: boolean;
  /** Shift+F10 opens this category's menu. */
  current?: boolean;
  focusMonth: MonthKey;
  editingMonth: MonthKey | null;
  editingInitial?: string;
  onContextMenu: (e: React.MouseEvent, month?: MonthKey) => void;
  onNotes: () => void;
  renaming: boolean;
  dragging: boolean;
  dropBefore: boolean;
  onClick: (e: React.MouseEvent, month?: MonthKey) => void;
  onEdit: (month: MonthKey) => void;
  onCommit: (month: MonthKey, v: number, how: CommitHow) => void;
  onCancelEdit: () => void;
  onRename: () => void;
  onRenamed: (v: string | null) => void;
  onPop: (kind: 'balance' | 'outflows', month: MonthKey, anchor: HTMLElement) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
}) {
  const { b, c, cat } = p;
  const hasNote = !!cat.note || p.months.some((m) => !!b.months[m]?.[cat.id]?.note);
  return (
    <div className="brow">
      <div
        data-cat={cat.id}
        data-kbmenu={p.current ? 'current' : undefined}
        className={cx('crow cat', p.selected && 'sel', cat.hidden && 'hiddencat', p.dragging && 'dragging', p.dropBefore && 'drop-before')}
        draggable={!p.renaming && !p.inHiddenGroup}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          p.onDragStart();
        }}
        onDragEnd={p.onDragEnd}
        onDragOver={p.inHiddenGroup ? undefined : p.onDragOver}
        onDrop={p.inHiddenGroup ? undefined : p.onDrop}
        onClick={(e) => p.onClick(e)}
        onDoubleClick={p.onRename}
        onContextMenu={p.onContextMenu}
      >
        <span className="drag-handle" title="Drag to reorder">
          ⋮⋮
        </span>
        {p.renaming ? (
          <RenameInput value={cat.name} onDone={p.onRenamed} />
        ) : (
          <span className="cname" title={cat.name}>
            {cat.name}
            {p.inHiddenGroup ? <span className="muted"> · {b.masters[cat.masterId]?.name}</span> : cat.hidden && ' (hidden)'}
            {hasNote && (
              <span
                className="note-dot"
                title="Notes"
                onClick={(e) => {
                  e.stopPropagation();
                  p.onNotes();
                }}
              >
                ●
              </span>
            )}
          </span>
        )}
        <span className="row-tools">
          <MenuButton
            className="row-btn"
            label="⋯"
            title="Category options"
            items={(): MenuEntry[] => CategoryMenuItems(cat, p.onRename, p.focusMonth)}
          />
        </span>
      </div>
      {p.months.map((m) => (
        <CategoryMonthCells
          key={m}
          d={categoryMonth(c, m, cat.id)}
          month={m}
          catName={cat.name}
          creditToDebt={!!b.settings.creditOverspendingToDebt}
          selected={p.selected}
          focused={p.selected && p.focusMonth === m}
          editing={p.editingMonth === m}
          initialText={p.editingMonth === m ? p.editingInitial : undefined}
          choices={
            p.editingMonth === m
              ? quickBudgetChoices(b, c, [cat.id], m).map((q) => ({ label: q.label, amount: q.amounts[cat.id] }))
              : undefined
          }
          onClick={(e) => p.onClick(e, m)}
          onEdit={() => p.onEdit(m)}
          onCommit={(v, how) => p.onCommit(m, v, how)}
          onCancel={p.onCancelEdit}
          onPop={(kind, anchor) => p.onPop(kind, m, anchor)}
          onContextMenu={(e) => p.onContextMenu(e, m)}
        />
      ))}
    </div>
  );
}

function CategoryMonthCells(p: {
  d: CategoryMonthData;
  month: MonthKey;
  catName: string;
  /** The card-debt setting (not YNAB4): only then is credit overspending shown differently. */
  creditToDebt: boolean;
  selected: boolean;
  focused: boolean;
  editing: boolean;
  initialText?: string;
  /** Quick Budget amounts for the cell being edited. */
  choices?: { label: string; amount: number }[];
  onClick: (e: React.MouseEvent) => void;
  onEdit: () => void;
  onCommit: (v: number, how: CommitHow) => void;
  onCancel: () => void;
  onPop: (kind: 'balance' | 'outflows', anchor: HTMLElement) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { d } = p;
  // YNAB4 showed every overspent balance red. Only with the card-debt setting on (new-YNAB
  // style) does card overspending behave differently, so only then is it shown yellow.
  const isCredit = p.creditToDebt && d.balance < 0 && d.creditOver > 0 && d.cashOver === 0;
  const tone = d.balance > 0 ? 'pos' : d.balance < 0 ? (isCredit ? 'credit' : 'neg') : 'zero';
  return (
    <div className={cx('crow month', p.selected && 'sel')} onClick={p.onClick} onContextMenu={p.onContextMenu}>
      <div
        className="cell budgeted"
        onClick={(e) => {
          e.stopPropagation();
          p.onClick(e);
          if (!e.shiftKey && !e.ctrlKey) p.onEdit();
        }}
        title={'Budgeted for ' + p.catName}
      >
        {p.editing ? (
          <MoneyInput
            value={d.budgeted}
            autoFocus
            relative
            gridNav
            initialText={p.initialText}
            choices={p.choices}
            ariaLabel={'Budgeted for ' + p.catName}
            onCommit={p.onCommit}
            onCancel={p.onCancel}
          />
        ) : (
          <Money v={d.budgeted} className={d.budgeted === 0 ? 'zero' : undefined} />
        )}
      </div>
      <div className="cell outflows">
        {d.activity === 0 ? (
          // Nothing to show: no popup with an empty list.
          <Money v={0} className="zero" />
        ) : (
          <button
            title="Show these transactions"
            onClick={(e) => {
              e.stopPropagation();
              p.onPop('outflows', e.currentTarget);
            }}
          >
            <Money v={d.activity} />
          </button>
        )}
      </div>
      <div className="cell">
        <button
          className={cx('pill', tone)}
          title={
            d.balance < 0
              ? isCredit
                ? 'Credit overspending: becomes card debt'
                : d.handling === 'carry'
                  ? 'Overspent: carried forward to next month'
                  : "Overspent: will be taken from next month's Available to Budget"
              : 'Balance. Click to move money or change overspending handling.'
          }
          onClick={(e) => {
            e.stopPropagation();
            p.onPop('balance', e.currentTarget);
          }}
        >
          {formatMoney(d.balance)}
          {d.handling === 'carry' && d.balance < 0 && <span className="carry">→</span>}
        </button>
      </div>
    </div>
  );
}

function RenameInput({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(value);
  const done = useRef(false);
  const finish = (r: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(r);
  };
  return (
    <input
      className="rename-input"
      value={v}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => finish(v)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(v);
        if (e.key === 'Escape') finish(null);
      }}
    />
  );
}

/** Used by the global keyboard shortcuts (Ctrl+Left / Ctrl+Right). */
export function budgetPrevNextMonth(n: number): void {
  ui.set({ month: addMonths(ui.get().month, n) });
}
