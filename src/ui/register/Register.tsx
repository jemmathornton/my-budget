import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { addMonths, formatDate, parseDateInput, thisMonth, today } from '../../model/dates';
import { formatMoney } from '../../model/money';
import {
  approveTransactions,
  moveToScheduler,
  categorizeTransactions,
  deleteTransactions,
  moveTransactions,
  setCleared,
  setFlag,
  setTransactionsDate,
  setTransactionsPayee,
  toggleCleared,
} from '../../model/ops';
import { categoryLabel, payeeName, reconciledAffected, registerCategory } from '../../model/queries';
import { matchesSearch, parseSearch, searchAmount } from '../../model/search';
import { matchTransactions, unmatchTransaction } from '../../import/match';
import {
  ACCOUNT_TYPE_LABELS,
  FLAGS,
  SPLIT,
  type Budget,
  type Flag,
  type Id,
  type ScheduledTransaction,
  type Split,
  type Transaction,
} from '../../model/types';
import { store, update, useBudget, useComputed } from '../../state/store';
import { prefStore, ui, usePrefs, useUi } from '../../state/ui';
import * as actions from '../actions';
import { alertDialog, confirm, openModal, prompt, toast } from '../common/dialogs';
import { ImportIcon, LockIcon, PlusIcon, SearchIcon } from '../common/icons';
import { Autocomplete } from '../common/inputs';
import { Money, cx } from '../common/Money';
import { MenuButton, Modal, modalOpen, Popover, useContextMenu, type MenuEntry } from '../common/overlay';
import { accountOptions, categoryOptions } from '../common/options';
import { columnKeys, gridTemplate, type ColKey, type RegisterColumns } from './columns';
import { ReconcileDialog } from './ReconcileDialog';
import { TxEditor } from './TxEditor';
import { ScheduledPane, scheduledForRegister } from './ScheduledPane';
import { ScheduledEditor } from '../scheduled/ScheduledEditor';
import { registerDoc } from '../print/docs';
import { usePrintable } from '../print/printable';

type Row =
  | { kind: 'tx'; t: Transaction; odd: boolean }
  | { kind: 'split'; t: Transaction; s: Split; i: number; n: number }
  /** A bank match waiting for approval: the bank's row and yours, under the result (YNAB4). */
  | { kind: 'match'; t: Transaction; side: 'bank' | 'yours' };

type SortKey = 'date' | 'account' | 'payee' | 'category' | 'memo' | 'amount' | 'cleared' | 'check';
type Range = 'all' | 'thisMonth' | 'last3' | 'thisYear' | 'lastYear' | 'last12' | 'custom';

const RANGE_LABELS: Record<Range, string> = {
  all: 'All dates',
  thisMonth: 'This month',
  last3: 'Latest 3 months',
  last12: 'Last 12 months',
  thisYear: 'This year',
  lastYear: 'Last year',
  custom: 'Custom…',
};

/**
 * The dates a range covers. The ranges up to now don't stop at today: future-dated transactions
 * are ordinary register rows (YNAB4), and one saved for next week mustn't vanish (1.5.3).
 */
function rangeDates(r: Range, from: string, to: string): [string, string] {
  const m = thisMonth();
  const y = +m.slice(0, 4);
  switch (r) {
    case 'thisMonth':
      return [m + '-01', '9999-12-31'];
    case 'last3':
      return [addMonths(m, -2) + '-01', '9999-12-31'];
    case 'last12':
      return [addMonths(m, -11) + '-01', '9999-12-31'];
    case 'thisYear':
      return [`${y}-01-01`, '9999-12-31'];
    case 'lastYear':
      return [`${y - 1}-01-01`, `${y - 1}-12-31`];
    case 'custom':
      return [from || '0000-01-01', to || '9999-12-31'];
    default:
      return ['0000-01-01', '9999-12-31'];
  }
}

/** Whether the scheduled pane is open (remembered, like the date range). */
function loadPaneOpen(): boolean {
  try {
    return localStorage.getItem('registerScheduledPane') !== 'closed';
  } catch {
    return true;
  }
}

function loadRange(): Range {
  try {
    return (localStorage.getItem('registerRange') as Range) || 'all';
  } catch {
    return 'all';
  }
}

/**
 * A row's own controls (its tick box, ⚑, ✓, C, Unmatch) are for clicking: a click leaves the keyboard
 * where it was, on the rows, so the keys go on acting on the selection (1.4.4).
 */
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

export function Register({ accountId }: { accountId: Id | 'all' }) {
  const b = useBudget();
  const c = useComputed();
  const { registerFilter, focusTxId } = useUi();
  const prefs = usePrefs();
  const account = accountId === 'all' ? undefined : b.accounts[accountId];
  const columns: RegisterColumns = {
    account: accountId === 'all',
    check: prefs.registerColumns.check,
    balance: prefs.runningBalance[accountId] ?? prefs.registerColumns.balance,
  };
  // Each account has its own running balance switch, as in YNAB4.
  const setRunningBalance = (on: boolean) => prefStore.set({ runningBalance: { ...prefs.runningBalance, [accountId]: on } });
  const runningBalanceForAll = (on: boolean) => prefStore.set({ registerColumns: { ...prefs.registerColumns, balance: on }, runningBalance: {} });
  const keys = columnKeys(columns);
  const template = gridTemplate(columns);

  const [search, setSearch] = useState(registerFilter?.search ?? '');
  const [range, setRange] = useState<Range>(registerFilter ? 'all' : loadRange());
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [showReconciled, setShowReconciled] = useState(true);
  const [paneOpen, setPaneOpen] = useState(loadPaneOpen);
  const [schedEditing, setSchedEditing] = useState<ScheduledTransaction | 'new' | null>(null);
  const [flagFilter, setFlagFilter] = useState<Flag | 'any' | null>(null);
  // Oldest first, newest at the bottom, as in YNAB4.
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'date', desc: false });
  const [sel, setSel] = useState<Set<Id>>(new Set());
  const anchor = useRef<Id | null>(null);
  /** A new transaction's editor can start on a date: the last one's, after "Save and add another" (1.5.8). */
  const [editing, setEditing] = useState<{ kind: 'new'; date?: string } | { kind: 'tx'; id: Id } | null>(null);
  const [flagPop, setFlagPop] = useState<{ id: Id; anchor: HTMLElement } | null>(null);
  const [openCtx, ctxNode] = useContextMenu();
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (registerFilter?.search !== undefined) setTimeout(() => searchRef.current?.focus(), 50);
  }, [registerFilter]);

  /**
   * A custom range box, on leaving it: empty means open-ended; a date that can't be read stays
   * in red and changes nothing, rather than quietly opening the range (1.5.3).
   */
  const readRangeBox = (el: HTMLInputElement, end: 'from' | 'to') => {
    const text = el.value.trim();
    const d = text ? parseDateInput(text) : '';
    el.classList.toggle('bad', d === null);
    if (d !== null) setCustom((x) => ({ ...x, [end]: d }));
  };

  // ---- Rows -------------------------------------------------------------------------
  const [from, to] = rangeDates(range, custom.from, custom.to);
  const idFilter = useMemo(() => (registerFilter?.ids ? new Set(registerFilter.ids) : null), [registerFilter]);

  const balances = useMemo(() => {
    // Running balance after each transaction, in date order.
    const list = Object.values(b.transactions).filter((t) =>
      accountId === 'all' ? !!b.accounts[t.accountId] : t.accountId === accountId,
    );
    // Same-day transactions stay in the order they were entered (records keep their insertion
    // order, and the sort is stable), so a new transaction appears below the others that day.
    list.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    const m = new Map<Id, number>();
    const order = new Map<Id, number>();
    let run = 0;
    list.forEach((t, i) => {
      run += t.amount;
      m.set(t.id, run);
      order.set(t.id, i);
    });
    return { balance: m, order };
  }, [b.transactions, b.accounts, accountId]);

  const rows = useMemo(() => {
    const q = parseSearch(search);
    const qAmount = searchAmount(q.text);
    let list = Object.values(b.transactions).filter((t) => {
      if (accountId === 'all' ? !b.accounts[t.accountId] : t.accountId !== accountId) return false;
      if (idFilter) return idFilter.has(t.id);
      if (t.date < from || t.date > to) return false;
      if (!showReconciled && t.cleared === 'R') return false;
      if (flagFilter === 'any' && !t.flag) return false;
      if (flagFilter && flagFilter !== 'any' && t.flag !== flagFilter) return false;
      if (q.text || q.fields.length) return matchesSearch(b, t, q, qAmount);
      return true;
    });
    const dir = sort.desc ? -1 : 1;
    const key = (t: Transaction): string | number => {
      switch (sort.key) {
        case 'account':
          return b.accounts[t.accountId]?.name.toLowerCase() || '';
        case 'payee':
          return payeeName(b, t).toLowerCase();
        case 'category':
          return categoryLabel(b, t.categoryId, t.date).toLowerCase();
        case 'memo':
          return (t.memo || '').toLowerCase();
        case 'amount':
          return t.amount;
        case 'cleared':
          return t.cleared;
        case 'check':
          return t.check || '';
        default:
          return t.date;
      }
    };
    list = list.sort((x, y) => {
      const a = key(x);
      const z = key(y);
      if (a < z) return -dir;
      if (a > z) return dir;
      // Ties: by date, then the running-balance order.
      if (x.date !== y.date) return x.date < y.date ? dir : -dir;
      return ((balances.order.get(x.id) ?? 0) - (balances.order.get(y.id) ?? 0)) * dir;
    });
    const out: Row[] = [];
    let odd = false;
    for (const t of list) {
      out.push({ kind: 'tx', t, odd });
      odd = !odd;
      if (t.categoryId === SPLIT && t.splits && t.splits.length) {
        t.splits.forEach((s, i) => out.push({ kind: 'split', t, s, i, n: t.splits!.length }));
      }
      if (t.matched && !t.accepted) out.push({ kind: 'match', t, side: 'bank' }, { kind: 'match', t, side: 'yours' });
    }
    return { rows: out, txs: list };
  }, [b, accountId, from, to, showReconciled, flagFilter, search, sort, idFilter, balances]);
  const scheduled = useMemo(() => scheduledForRegister(b, accountId), [b, accountId]);

  const visibleIds = useMemo(() => rows.txs.map((t) => t.id), [rows]);
  const visibleRef = useRef(visibleIds);
  visibleRef.current = visibleIds;

  const virt = useVirtualizer({
    count: rows.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 12,
  });

  // Open scrolled to the newest transactions (at the bottom), unless asked to show a particular one.
  useEffect(() => {
    if (focusTxId || !rows.rows.length) return;
    const t = setTimeout(() => virt.scrollToIndex(sort.desc ? 0 : rows.rows.length - 1, { align: 'end' }), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const scrollToTx = (id: Id) => {
    setTimeout(() => {
      const idx = rowsRef.current.rows.findIndex((r) => r.kind === 'tx' && r.t.id === id);
      if (idx >= 0) virt.scrollToIndex(idx, { align: 'auto' });
    }, 30);
  };

  // The new-transaction row opens at the bottom, so keep the newest transactions in view above it.
  useEffect(() => {
    if (editing?.kind !== 'new' || sort.desc) return;
    const t = setTimeout(() => {
      const n = rowsRef.current.rows.length;
      if (n) virt.scrollToIndex(n - 1, { align: 'end' });
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.kind]);

  // The edit row is taller than a transaction row: make sure all of it (and its buttons) is in view.
  useEffect(() => {
    if (!editing || editing.kind === 'new') return;
    const f = requestAnimationFrame(() =>
      scrollRef.current?.querySelector<HTMLElement>('.tx-editor')?.scrollIntoView({ block: 'nearest' }),
    );
    return () => cancelAnimationFrame(f);
  }, [editing]);

  // Open on a particular transaction (e.g. from the budget screen).
  useEffect(() => {
    if (!focusTxId) return;
    const idx = rows.rows.findIndex((r) => r.kind === 'tx' && r.t.id === focusTxId);
    if (idx < 0 && b.transactions[focusTxId] && (range !== 'all' || search || flagFilter || !showReconciled)) {
      // Hidden by the remembered range or a filter: show everything, then look again (1.5.3).
      setRange('all');
      setSearch('');
      setFlagFilter(null);
      setShowReconciled(true);
      return;
    }
    if (idx >= 0) {
      setSel(new Set([focusTxId]));
      anchor.current = focusTxId;
      setTimeout(() => virt.scrollToIndex(idx, { align: 'center' }), 0);
    }
    ui.set({ focusTxId: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTxId, rows]);

  // ---- Selection & keyboard -------------------------------------------------------------
  const clickRow = (e: React.MouseEvent, id: Id) => {
    if (e.shiftKey && anchor.current) {
      const a = visibleIds.indexOf(anchor.current);
      const z = visibleIds.indexOf(id);
      const [lo, hi] = a < z ? [a, z] : [z, a];
      setSel(new Set(visibleIds.slice(lo, hi + 1)));
    } else if (e.ctrlKey || e.metaKey) {
      const n = new Set(sel);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      setSel(n);
      anchor.current = id;
    } else {
      setSel(new Set([id]));
      anchor.current = id;
    }
  };

  // Only rows still shown: one moved to another account or hidden by a search stays out of
  // reach of Delete and the other keys (1.5.3).
  const shown = useMemo(() => new Set(visibleIds), [visibleIds]);
  const selected = [...sel].filter((id) => b.transactions[id] && shown.has(id));
  const currentId = anchor.current && sel.has(anchor.current) ? anchor.current : selected[0];

  // Several selected transactions: their actions take the footer's left side.
  const showBulk = selected.length > 1 && !editing;

  const startEdit = async (id: Id) => {
    const t = b.transactions[id];
    if (!t) return;
    // The other side of a transfer changes with it, so its reconciliation counts too (1.5.3).
    const r = reconciledAffected(b, [id]);
    if (r.own || r.others.size) {
      const ok = await confirm(
        'Edit a reconciled transaction',
        r.own
          ? 'This transaction has been reconciled. Changing its amount or account will change your reconciled balance. Edit it anyway?'
          : `The other side of this transfer, in ${[...r.others].join(' and ')}, has been reconciled. Changing its amount or date changes that account's reconciled balance too. Edit it anyway?`,
        'Edit',
      );
      if (!ok) return;
    }
    setEditing({ kind: 'tx', id });
  };

  /** YNAB4's "Approve and find next": approves the row and selects the next one waiting for approval. */
  const approveAndNext = (id: Id) => {
    update('Approve', (d) => approveTransactions(d, [id]));
    // As approved just now: a scheduled transfer's other side went with it.
    const now = store.budget ?? b;
    const i = visibleIds.indexOf(id);
    const next = [...visibleIds.slice(i + 1), ...visibleIds.slice(0, Math.max(0, i))].find((x) => x !== id && now.transactions[x] && !now.transactions[x].accepted);
    if (!next) {
      toast('Nothing else here is waiting for approval.', 'ok');
      return;
    }
    setSel(new Set([next]));
    anchor.current = next;
    scrollToTx(next);
  };

  /** YNAB4: after saving one, opens the next transaction here (in the register's order) that still needs a category. */
  const editNextUncategorised = (id: Id) => {
    const need = new Set((store.computed()?.uncategorized ?? []).filter((x) => accountId === 'all' || store.budget?.transactions[x]?.accountId === accountId));
    const i = visibleIds.indexOf(id);
    const next = [...visibleIds.slice(i + 1), ...visibleIds.slice(0, Math.max(0, i))].find((x) => x !== id && need.has(x));
    if (!next) {
      toast('Nothing else here needs a category.', 'ok');
      scrollRef.current?.focus();
      return;
    }
    setSel(new Set([next]));
    anchor.current = next;
    scrollToTx(next);
    void startEdit(next);
  };

  /** Deletes the selected rows (or `ids`), asking first when it's more than one or touches a reconciliation. */
  const deleteSelected = async (ids: Id[] = selected) => {
    if (!ids.length) return;
    // Reconciled rows, and reconciled other sides of transfers, which go with them (1.5.3).
    const r = reconciledAffected(b, ids);
    if (ids.length > 1 || r.own || r.others.size) {
      const notes = [
        r.own ? ` ${ids.length === 1 ? 'It is' : `${r.own} of them ${r.own === 1 ? 'is' : 'are'}`} reconciled, so your reconciled balance will change.` : '',
        r.others.size ? ` The other side of a transfer in ${[...r.others].join(' and ')} is reconciled and goes too, so that account's reconciled balance changes.` : '',
      ].join('');
      const ok = await confirm(
        'Delete transactions',
        `Delete ${ids.length} transaction${ids.length === 1 ? '' : 's'}?${notes} You can undo this.`,
        'Delete',
        true,
      );
      if (!ok) return;
    }
    update(ids.length === 1 ? 'Delete transaction' : `Delete ${ids.length} transactions`, (d) => deleteTransactions(d, ids));
    setSel(new Set());
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (editing || e.defaultPrevented) return;
    // Keys in the register's own menus, popovers and dialogs (rendered inside it) are theirs, and
    // while any dialog is open the register waits.
    if (modalOpen() || (e.target as HTMLElement).closest('.menu, .popover, .modal')) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    // On one of the register's buttons (the scheduled pane's Skip, the footer's), the keys that
    // act on the selected rows are the button's: Enter presses it, Delete doesn't delete a row.
    // The arrows and Ctrl keys still work, and the arrows take the keyboard back to the rows.
    // A row's own buttons (⚑, ✓, C) are for clicking: there the keys act on the selection, as before.
    const target = e.target as HTMLElement;
    const onControl = !!target.closest('button, a[href], [role="button"]') && !target.closest('.rrow');
    if (onControl && (['Enter', ' ', 'Delete', 'F2', 'Insert'].includes(e.key) || (!ctrl && ['n', 'c', 'a'].includes(k)))) return;
    if (onControl && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) scrollRef.current?.focus({ preventScroll: true });
    // YNAB4's keys too: Ctrl+N new, F2 edit, Ctrl+K approve, Ctrl+Shift+C cleared.
    if (k === 'n' || e.key === 'Insert') {
      e.preventDefault();
      setEditing({ kind: 'new' });
    } else if (ctrl && k === 'f') {
      e.preventDefault();
      searchRef.current?.focus();
    } else if (ctrl && k === 'a') {
      e.preventDefault();
      setSel(new Set(visibleIds));
    } else if ((e.key === 'Enter' || e.key === 'F2') && selected.length === 1) {
      e.preventDefault();
      void startEdit(selected[0]);
    } else if (e.key === 'Delete' && selected.length) {
      e.preventDefault();
      void deleteSelected();
    } else if (k === 'c' && (!ctrl || e.shiftKey) && selected.length) {
      e.preventDefault();
      const anyUncleared = selected.some((id) => b.transactions[id].cleared === 'U');
      update(anyUncleared ? 'Mark cleared' : 'Mark uncleared', (d) =>
        setCleared(
          d,
          selected.filter((id) => d.transactions[id].cleared !== 'R'),
          anyUncleared ? 'C' : 'U',
        ),
      );
    } else if (k === 'a' && e.shiftKey && !ctrl && selected.length === 1) {
      e.preventDefault();
      approveAndNext(selected[0]);
    } else if (((k === 'a' && !ctrl) || (ctrl && k === 'k')) && selected.length) {
      e.preventDefault();
      update('Approve', (d) => approveTransactions(d, selected));
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = anchor.current ? visibleIds.indexOf(anchor.current) : -1;
      const n = visibleIds[Math.max(0, Math.min(visibleIds.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (n) {
        if (e.shiftKey) setSel(new Set([...sel, n]));
        else setSel(new Set([n]));
        anchor.current = n;
        const idx = rows.rows.findIndex((r) => r.kind === 'tx' && r.t.id === n);
        virt.scrollToIndex(idx, { align: 'auto' });
      }
    } else if (e.key === 'Escape') {
      setSel(new Set());
    }
  };

  // ---- Header numbers -----------------------------------------------------------------
  const totals = useMemo(() => {
    let cleared = 0;
    let uncleared = 0;
    let unapproved = 0;
    for (const [id, t] of c.accounts) {
      if (accountId !== 'all' && id !== accountId) continue;
      cleared += t.cleared;
      uncleared += t.uncleared;
      unapproved += t.unapproved;
    }
    return { cleared, uncleared, working: cleared + uncleared, unapproved };
  }, [c, accountId]);

  // The printout: the rows as shown, with the filters in force (1.5.1).
  usePrintable(() => {
    const filters: string[] = [];
    if (idFilter) filters.push(registerFilter?.label ?? `${idFilter.size} chosen transactions`);
    else {
      const open = (d: string) => d === '0000-01-01' || d === '9999-12-31';
      filters.push(
        range === 'all' || (open(from) && open(to))
          ? 'All dates'
          : open(from)
            ? `Up to ${formatDate(to)}`
            : open(to)
              ? `${range === 'custom' ? 'From' : RANGE_LABELS[range] + ': from'} ${formatDate(from)}`
              : `${range === 'custom' ? '' : RANGE_LABELS[range] + ': '}${formatDate(from)} to ${formatDate(to)}`,
      );
      if (search.trim()) filters.push(`Search: ${search.trim()}`);
      if (flagFilter) filters.push(flagFilter === 'any' ? 'Flagged only' : `Flag: ${flagFilter}`);
      if (!showReconciled) filters.push('Reconciled transactions hidden');
    }
    return registerDoc(b, {
      accountId,
      txs: rows.txs,
      balances: columns.balance ? balances.balance : null,
      check: columns.check,
      filters,
      totals,
    });
  });

  const unapprovedIds = () =>
    Object.values(b.transactions)
      .filter((t) => !t.accepted && (accountId === 'all' || t.accountId === accountId))
      .map((t) => t.id);
  const needCategory = useMemo(
    () => c.uncategorized.filter((id) => accountId === 'all' || b.transactions[id]?.accountId === accountId),
    [c, b, accountId],
  );

  const unmatch = (id: Id) => {
    update('Unmatch', (d) => void unmatchTransaction(d, id));
    toast("Unmatched: the bank's transaction is now a separate one to approve", 'ok', { label: 'Undo', fn: actions.undoThis() });
  };

  /** YNAB4's Match (1.5.6): one row you entered and one bank row, selected together. */
  const match = (ids: Id[]) => {
    let why: string | null = null;
    update('Match', (d) => {
      why = matchTransactions(d, ids[0], ids[1]);
    });
    if (why) void alertDialog("These can't be matched", <p style={{ margin: 0 }}>{why}</p>);
    else toast('Matched: approve it when it looks right', 'ok', { label: 'Undo', fn: actions.undoThis() });
  };

  const rowMenu = (t: Transaction): MenuEntry[] => {
    // Right-clicking one of several selected rows acts on them all, as ⚑ does (1.5.3).
    const group = sel.has(t.id) && selected.length > 1 ? selected : [t.id];
    const many = group.length > 1;
    const anyUncleared = group.some((id) => b.transactions[id]?.cleared === 'U');
    const anyUnapproved = group.some((id) => !b.transactions[id]?.accepted);
    // Two rows, one from the bank and one not, both unmatched: they can be matched.
    const pair = group.map((id) => b.transactions[id]).filter(Boolean);
    const canMatch = pair.length === 2 && pair.filter((x) => x.importIds?.length).length === 1 && !pair.some((x) => x.matched);
    return [
    { label: 'Edit', disabled: many, onClick: () => void startEdit(t.id) },
    ...(canMatch ? [{ label: 'Match', onClick: () => match(group) }] : []),
    ...(t.transferAccountId
      ? [
          {
            label: 'Go to the other account',
            onClick: () => ui.go({ view: 'account', id: t.transferAccountId! }, { focusTxId: t.transferTxId }),
          },
        ]
      : []),
    many
      ? {
          label: anyUncleared ? `Mark ${group.length} cleared` : `Mark ${group.length} uncleared`,
          onClick: () =>
            update(anyUncleared ? 'Mark cleared' : 'Mark uncleared', (d) =>
              setCleared(d, group.filter((id) => d.transactions[id]?.cleared !== 'R'), anyUncleared ? 'C' : 'U'),
            ),
        }
      : {
          label: t.cleared === 'U' ? 'Mark cleared' : 'Mark uncleared',
          disabled: t.cleared === 'R',
          onClick: () => update('Toggle cleared', (d) => toggleCleared(d, t.id)),
        },
    ...(anyUnapproved
      ? [
          { label: many ? `Approve ${group.length}` : 'Approve', onClick: () => update('Approve', (d) => approveTransactions(d, group)) },
          ...(many ? [] : [{ label: 'Approve and find next', shortcut: 'Shift+A', onClick: () => approveAndNext(t.id) }]),
        ]
      : []),
    ...(t.matched && !t.accepted ? [{ label: 'Unmatch', onClick: () => unmatch(t.id) }] : []),
    ...(t.date > today() && !t.transferSplitParentId
      ? [{ label: 'Move to Scheduler', onClick: () => update('Move to Scheduler', (d) => void moveToScheduler(d, t.id)) }]
      : []),
    'sep',
    {
      label: many ? `Delete ${group.length}` : 'Delete',
      danger: true,
      onClick: () => void deleteSelected(group),
    },
  ];
  };

  const sortBy = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key === 'date' || key === 'amount' }));
  const headLabel: Record<ColKey, [string, SortKey | null, boolean?]> = {
    sel: ['', null],
    flag: ['', null],
    account: ['ACCOUNT', 'account'],
    check: ['CHEQUE', 'check'],
    date: ['DATE', 'date'],
    payee: ['PAYEE', 'payee'],
    category: ['CATEGORY', 'category'],
    memo: ['MEMO', 'memo'],
    outflow: ['OUTFLOW', 'amount', true],
    inflow: ['INFLOW', 'amount', true],
    balance: ['BALANCE', null, true],
    cleared: ['', 'cleared'],
  };

  const editingTx = editing?.kind === 'tx' ? b.transactions[editing.id] : undefined;
  const editingIndex =
    editing?.kind === 'tx' ? rows.rows.findIndex((r) => r.kind === 'tx' && r.t.id === editing.id) : -1;
  // The row being edited has gone (a search, a filter, deleted): close the editor (which saves
  // it, see TxEditor), or the register's keys would stay switched off (1.5.3).
  useEffect(() => {
    if (editing?.kind === 'tx' && editingIndex < 0) setEditing(null);
  }, [editing, editingIndex]);

  // The row for adding a transaction sits next to the newest transactions: at the bottom
  // (YNAB4's order), or at the top when sorted newest first.
  const newEditor =
    editing?.kind === 'new' ? (
      <TxEditor
        className={sort.desc ? 'top' : 'top bottom'}
        accountId={accountId}
        columns={columns}
        defaultDate={editing.date}
        onCancel={() => {
          setEditing(null);
          scrollRef.current?.focus();
        }}
        onDone={(id, another) => {
          setEditing(null);
          // The next one starts on the date just used, not today (1.5.8).
          const date = id ? store.budget?.transactions[id]?.date : undefined;
          if (another) setTimeout(() => setEditing({ kind: 'new', date }), 0);
          if (id) {
            setSel(new Set([id]));
            anchor.current = id;
            scrollToTx(id);
            // Saved but hidden by the search or a filter: said, rather than seeming to vanish (1.5.11).
            setTimeout(() => {
              if (store.budget?.transactions[id] && !visibleRef.current.includes(id))
                toast('Saved, but the search or a filter hides it.', 'info', {
                  label: 'Show it',
                  fn: () => ui.set({ registerFilter: undefined, focusTxId: id }),
                });
            }, 150);
          }
          scrollRef.current?.focus();
        }}
      />
    ) : null;

  return (
    <div className="register" onKeyDown={onKey}>
      <div className="reg-header">
        <div className="reg-title">
          <h1>
            {account ? account.name : 'All accounts'}
            {account?.closed && <span className="badge">Closed</span>}
            {account && (
              <button className="icon-btn" title="Edit account" onClick={() => actions.editAccountFlow(account.id)}>
                ✎
              </button>
            )}
          </h1>
          <div className="acct-type">
            {account
              ? `${ACCOUNT_TYPE_LABELS[account.type]} · ${account.onBudget ? 'On budget' : 'Off budget'}${account.lastReconciledDate ? ` · Last reconciled ${formatDate(account.lastReconciledDate)}` : ''}`
              : 'Every account'}
          </div>
        </div>
      </div>

      <div className="reg-body">
        <div className="reg-card card">
          <div className="reg-toolbar">
            <button
              className="btn small"
              onClick={() => actions.importBankFlow(account?.id)}
              title="Import a bank file (Ctrl+I)"
            >
              <ImportIcon size={12} /> Import
            </button>
            {totals.unapproved > 0 && (
              <button
                className="btn small green"
                onClick={() => update('Approve imported transactions', (d) => approveTransactions(d, unapprovedIds()))}
              >
                Approve {totals.unapproved}
              </button>
            )}
            {/* YNAB4's notices: "N transactions need to be approved [Show]", and the same for categories. */}
            {totals.unapproved > 0 && (
              <button
                className="link small"
                title="Show only the transactions waiting to be approved"
                onClick={() => ui.set({ registerFilter: { ids: unapprovedIds(), label: 'Needs approval' } })}
              >
                Show
              </button>
            )}
            {needCategory.length > 0 && (
              <button
                className="link small needs-cat"
                title="Show only the transactions that need a category"
                onClick={() => ui.set({ registerFilter: { ids: needCategory, label: 'Needs a category' } })}
              >
                {needCategory.length} need{needCategory.length === 1 ? 's' : ''} a category
              </button>
            )}
            <span className="grow" />
            {registerFilter?.label && (
              <span className="filter-chip">
                {registerFilter.label}
                <button
                  onClick={() => ui.set({ registerFilter: undefined })}
                  title="Show everything"
                  aria-label="Clear filter"
                >
                  ✕
                </button>
              </span>
            )}
            <select
              className="small"
              value={range}
              onChange={(e) => {
                const r = e.target.value as Range;
                setRange(r);
                try {
                  localStorage.setItem('registerRange', r);
                } catch {
                  // Only a convenience.
                }
              }}
              aria-label="Dates"
            >
              {(Object.keys(RANGE_LABELS) as Range[]).map((r) => (
                <option key={r} value={r}>
                  {RANGE_LABELS[r]}
                </option>
              ))}
            </select>
            {range === 'custom' && (
              <>
                <input
                  className="small"
                  style={{ width: 96 }}
                  placeholder="From"
                  defaultValue={custom.from ? formatDate(custom.from) : ''}
                  onBlur={(e) => readRangeBox(e.target, 'from')}
                  aria-label="From date"
                />
                <input
                  className="small"
                  style={{ width: 96 }}
                  placeholder="To"
                  defaultValue={custom.to ? formatDate(custom.to) : ''}
                  onBlur={(e) => readRangeBox(e.target, 'to')}
                  aria-label="To date"
                />
              </>
            )}
            <MenuButton
              label="View ▾"
              align="right"
              items={() => [
                {
                  label: 'Show reconciled transactions',
                  checked: showReconciled,
                  onClick: () => setShowReconciled(!showReconciled),
                },
                'sep',
                {
                  label: 'Only flagged',
                  checked: flagFilter === 'any',
                  onClick: () => setFlagFilter(flagFilter === 'any' ? null : 'any'),
                },
                ...FLAGS.map((f) => ({
                  label: `Only ${f} flags`,
                  checked: flagFilter === f,
                  onClick: () => setFlagFilter(flagFilter === f ? null : f),
                })),
                'sep',
                {
                  label: 'Cheque number column',
                  checked: columns.check,
                  onClick: () =>
                    prefStore.set({ registerColumns: { ...prefs.registerColumns, check: !columns.check } }),
                },
                {
                  label: account ? 'Running balance column (this account)' : 'Running balance column',
                  checked: columns.balance,
                  onClick: () => setRunningBalance(!columns.balance),
                },
                {
                  label: columns.balance ? 'Show the running balance in every account' : 'Hide the running balance in every account',
                  onClick: () => runningBalanceForAll(columns.balance),
                },
              ]}
            />
            <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
              <span style={{ position: 'absolute', left: 7, color: 'var(--muted)', display: 'flex' }}>
                <SearchIcon size={13} />
              </span>
              <input
                ref={searchRef}
                className="search"
                style={{ paddingLeft: 26, paddingRight: search ? 24 : undefined }}
                placeholder="Search payee, category, memo, amount"
                title={
                  'Matches any field, or an amount. "Payee:", "Category:", "Memo:" or "Account:" looks in that field only,\nand they can be combined: payee: tesco memo: milk\n' +
                  'Also, as in YNAB4: "Is: uncleared" (cleared, reconciled, unreconciled, approved, unapproved, flagged),\n"Inflow:" or "Outflow:" (with an amount or none), "Before:", "After:" or "On:" a date, "Check:" a cheque number'
                }
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setSearch('');
                    scrollRef.current?.focus();
                  }
                }}
                aria-label="Search transactions"
              />
              {search && (
                <button
                  className="icon-btn"
                  style={{ position: 'absolute', right: 3 }}
                  title="Clear search (Esc)"
                  aria-label="Clear search"
                  onClick={() => {
                    setSearch('');
                    searchRef.current?.focus();
                  }}
                >
                  ✕
                </button>
              )}
            </span>
          </div>

          <div className="rgrid rhead" style={{ gridTemplateColumns: template, paddingRight: 10 }}>
            {keys.map((k) => {
              const [label, sk, right] = headLabel[k];
              return (
                <div
                  key={k}
                  className={cx('rh', !sk && 'nosort', sort.key === sk && sk && 'sorted', right && 'r')}
                  onClick={() => sk && sortBy(sk)}
                  title={sk ? 'Sort' : undefined}
                >
                  {label}
                  {sk && sort.key === sk && (k !== 'inflow' || sort.key !== 'amount') && (sort.desc ? ' ▾' : ' ▴')}
                </div>
              );
            })}
          </div>

          {!sort.desc ? null : newEditor}

          <div className="reg-scroll" ref={scrollRef} tabIndex={0}>
            <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
              {virt.getVirtualItems().map((vi) => {
                const r = rows.rows[vi.index];
                const style = { top: vi.start, gridTemplateColumns: template };
                if (r.kind === 'match')
                  return (
                    <MatchRow
                      key={'m' + r.t.id + r.side}
                      b={b}
                      r={r}
                      keys={keys}
                      style={style}
                      onUnmatch={() => unmatch(r.t.id)}
                      onDoubleClick={() => void startEdit(r.t.id)}
                    />
                  );
                if (r.kind === 'split')
                  return (
                    <SplitRow
                      key={'p' + r.t.id + r.i}
                      b={b}
                      r={r}
                      keys={keys}
                      style={style}
                      onDoubleClick={() => void startEdit(r.t.id)}
                    />
                  );
                const t = r.t;
                return (
                  <TxRow
                    key={t.id}
                    b={b}
                    t={t}
                    keys={keys}
                    odd={r.odd}
                    style={style}
                    balance={balances.balance.get(t.id)}
                    selected={sel.has(t.id)}
                    current={t.id === currentId}
                    onClick={(e) => clickRow(e, t.id)}
                    onDoubleClick={() => void startEdit(t.id)}
                    onContextMenu={(e) => {
                      if (!sel.has(t.id)) {
                        setSel(new Set([t.id]));
                        anchor.current = t.id;
                      }
                      openCtx(e, rowMenu(t));
                    }}
                    onToggleCleared={() => update('Toggle cleared', (d) => toggleCleared(d, t.id))}
                    onApprove={() => update('Approve', (d) => approveTransactions(d, [t.id]))}
                    onFlag={(el) => setFlagPop({ id: t.id, anchor: el })}
                    onSelectToggle={() => {
                      const n = new Set(sel);
                      if (n.has(t.id)) n.delete(t.id);
                      else n.add(t.id);
                      setSel(n);
                      anchor.current = t.id;
                    }}
                  />
                );
              })}
              {editing?.kind === 'tx' && editingIndex >= 0 && editingTx && (
                <TxEditor
                  key={editing.kind + editing.id}
                  accountId={accountId}
                  tx={editingTx}
                  columns={columns}
                  style={{ top: virt.measurementsCache[editingIndex]?.start ?? editingIndex * 26 }}
                  onCancel={() => {
                    setEditing(null);
                    scrollRef.current?.focus();
                  }}
                  onDelete={() => {
                    update('Delete transaction', (d) => deleteTransactions(d, [editing.id]));
                    setEditing(null);
                    scrollRef.current?.focus();
                  }}
                  saveNext={needCategory.some((x) => x !== editing.id && visibleIds.includes(x))}
                  onDone={(id, _another, next) => {
                    setEditing(null);
                    if (next && id) setTimeout(() => editNextUncategorised(id), 0);
                    else scrollRef.current?.focus();
                  }}
                />
              )}
            </div>
            {rows.rows.length === 0 && (
              <div className="empty">
                {search || idFilter || range !== 'all'
                  ? 'No transactions match.'
                  : 'No transactions yet. Press N or "Add a new transaction" to add one, or import a file from your bank.'}
              </div>
            )}
          </div>

          {sort.desc ? null : newEditor}

          {paneOpen && (
            <ScheduledPane
              b={b}
              accountId={accountId}
              items={scheduled}
              onEdit={(x) => setSchedEditing(x)}
              onAdd={() => setSchedEditing('new')}
            />
          )}

          <div className="reg-foot">
            {showBulk ? (
              <BulkBar
                ids={selected}
                accountId={accountId}
                onDelete={() => void deleteSelected()}
                onClear={() => setSel(new Set())}
              />
            ) : (
              <>
                <button className="btn small primary" onClick={() => setEditing({ kind: 'new' })} title="New transaction (N)">
                  <PlusIcon size={12} /> Add a new transaction
                </button>
                <button
                  className="btn small"
                  aria-expanded={paneOpen}
                  onClick={() => {
                    setPaneOpen(!paneOpen);
                    try {
                      localStorage.setItem('registerScheduledPane', paneOpen ? 'closed' : 'open');
                    } catch {
                      // Only a convenience.
                    }
                  }}
                >
                  {paneOpen ? '▾' : '▸'} Scheduled Transactions ({scheduled.length})
                </button>
                <span className="foot-count">
                  {rows.txs.length} transaction{rows.txs.length === 1 ? '' : 's'}
                  {(search || idFilter || range !== 'all' || flagFilter || !showReconciled) &&
                    ` shown · total ${formatMoney(rows.txs.reduce((s, t) => s + t.amount, 0))}`}
                  {selected.length === 1 && ` · 1 selected, ${formatMoney(b.transactions[selected[0]]?.amount || 0)}`}
                </span>
              </>
            )}
            <span className="grow" />
            <div className="reg-balances">
              <div className="rb" title="Cleared balance">
                <Money v={totals.cleared} negRed />
                <span className="lbl">Cleared</span>
              </div>
              <span className="rb-op">+</span>
              <div className="rb" title="Uncleared balance">
                <Money v={totals.uncleared} negRed />
                <span className="lbl">Uncleared</span>
              </div>
              <span className="rb-op">=</span>
              <div className="rb working" title="Working balance">
                <Money v={totals.working} negRed />
                <span className="lbl">Working balance</span>
              </div>
            </div>
            {account && (
              <button
                className="btn small"
                onClick={() => openModal((close) => <ReconcileDialog accountId={account.id} onClose={close} />)}
              >
                <LockIcon size={12} /> Reconcile Account
              </button>
            )}
          </div>
        </div>
      </div>

      {schedEditing && (
        <ScheduledEditor
          scheduled={schedEditing === 'new' ? undefined : schedEditing}
          accountId={accountId}
          onClose={() => setSchedEditing(null)}
        />
      )}

      {flagPop && (
        <Popover anchor={flagPop.anchor} onClose={() => setFlagPop(null)}>
          <div className="flag-menu">
            <button
              className="flag flag-none"
              title="No flag"
              onClick={() => {
                update('Flag', (d) => setFlag(d, sel.has(flagPop.id) ? selected : [flagPop.id], undefined));
                setFlagPop(null);
              }}
            >
              ⚐
            </button>
            {FLAGS.map((f) => (
              <button
                key={f}
                className={'flag flag-' + f}
                title={f}
                onClick={() => {
                  update('Flag', (d) => setFlag(d, sel.has(flagPop.id) ? selected : [flagPop.id], f));
                  setFlagPop(null);
                }}
              >
                ⚑
              </button>
            ))}
          </div>
        </Popover>
      )}
      {ctxNode}
    </div>
  );
}

// ---- Rows ------------------------------------------------------------------------------------

function TxRow(p: {
  b: Budget;
  t: Transaction;
  keys: ColKey[];
  odd: boolean;
  style: React.CSSProperties;
  balance?: number;
  selected: boolean;
  /** Shift+F10 opens this row's menu. */
  current?: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onToggleCleared: () => void;
  onApprove: () => void;
  onFlag: (el: HTMLElement) => void;
  onSelectToggle: () => void;
}) {
  const { b, t } = p;
  const future = t.date > today();
  // Off-budget accounts have no categories (one kept from when it was on budget isn't shown).
  const rc = registerCategory(b, t);
  const cat =
    rc.kind === 'split' ? <span className="split-tag">{rc.text}</span> : rc.kind === 'blank' ? <span className="muted"> </span> : rc.kind === 'needs' ? <span className="needs-cat">{rc.text}</span> : rc.text;
  const cells: Record<ColKey, React.ReactNode> = {
    sel: (
      <span className="ct chk">
        <input
          type="checkbox"
          checked={p.selected}
          onChange={p.onSelectToggle}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={keepFocus}
          aria-label="Select"
        />
      </span>
    ),
    flag: (
      <span className="ct flagc">
        <button
          className={cx('flag', t.flag ? 'flag-' + t.flag : 'flag-none')}
          onMouseDown={keepFocus}
          onClick={(e) => {
            e.stopPropagation();
            p.onFlag(e.currentTarget);
          }}
          aria-label="Flag"
        >
          ⚑
        </button>
      </span>
    ),
    account: <span className="ct">{b.accounts[t.accountId]?.name}</span>,
    check: <span className="ct">{t.check}</span>,
    date: <span className="ct">{formatDate(t.date)}</span>,
    payee: (
      <span
        className="ct c-payee"
        title={t.importedPayee && t.importedPayee !== payeeName(b, t) ? `Bank: ${t.importedPayee}` : undefined}
      >
        {payeeName(b, t)}
      </span>
    ),
    category: <span className="ct">{cat}</span>,
    memo: (
      <span className="ct" title={t.memo}>
        {t.memo}
      </span>
    ),
    outflow: <span className="ct r">{t.amount < 0 ? formatMoney(-t.amount) : ''}</span>,
    inflow: <span className="ct r">{t.amount > 0 ? formatMoney(t.amount) : ''}</span>,
    balance: (
      <span className={cx('ct r', (p.balance ?? 0) < 0 && 'neg')}>
        {p.balance !== undefined ? formatMoney(p.balance) : ''}
      </span>
    ),
    cleared: (
      <span className="ct clr">
        {!t.accepted ? (
          <button
            className="approve"
            title="Imported: click to approve (A)"
            onMouseDown={keepFocus}
            onClick={(e) => {
              e.stopPropagation();
              p.onApprove();
            }}
          >
            ✓
          </button>
        ) : t.cleared === 'R' ? (
          <span className="cleared is-r" title="Reconciled">
            🔒
          </span>
        ) : (
          <button
            className={cx('cleared', t.cleared === 'C' && 'is-c')}
            title={t.cleared === 'C' ? 'Cleared (click to unclear)' : 'Uncleared (click to clear)'}
            onMouseDown={keepFocus}
            onClick={(e) => {
              e.stopPropagation();
              p.onToggleCleared();
            }}
          >
            C
          </button>
        )}
      </span>
    ),
  };
  return (
    <div
      className={cx(
        'rrow rgrid',
        p.odd && 'odd',
        p.selected && 'selected',
        !t.accepted && 'unapproved',
        t.cleared === 'R' && 'reconciled',
        future && 'future',
      )}
      style={p.style}
      data-kbmenu={p.current ? 'current' : undefined}
      onClick={p.onClick}
      onDoubleClick={p.onDoubleClick}
      onContextMenu={p.onContextMenu}
    >
      {p.keys.map((k) => (
        <span key={k} style={{ display: 'contents' }}>
          {cells[k]}
        </span>
      ))}
    </div>
  );
}

function SplitRow({
  b,
  r,
  keys,
  style,
  onDoubleClick,
}: {
  b: Budget;
  r: Extract<Row, { kind: 'split' }>;
  keys: ColKey[];
  style: React.CSSProperties;
  onDoubleClick: () => void;
}) {
  const s = r.s;
  const cells: Partial<Record<ColKey, React.ReactNode>> = {
    payee: (
      <span className="ct">
        {s.transferAccountId ? 'Transfer : ' + (b.accounts[s.transferAccountId]?.name || '?') : ''}
      </span>
    ),
    category: (
      <span className="ct">
        ↳{' '}
        {s.categoryId ? (
          categoryLabel(b, s.categoryId, r.t.date)
        ) : s.transferAccountId ? (
          ''
        ) : (
          <span className="needs-cat">Needs a category</span>
        )}
      </span>
    ),
    memo: <span className="ct">{s.memo}</span>,
    outflow: <span className="ct r">{s.amount < 0 ? formatMoney(-s.amount) : ''}</span>,
    inflow: <span className="ct r">{s.amount > 0 ? formatMoney(s.amount) : ''}</span>,
  };
  return (
    <div className="rrow rgrid splitline" style={style} onDoubleClick={onDoubleClick}>
      {keys.map((k) => (
        <span key={k} style={{ display: 'contents' }}>
          {cells[k] ?? <span />}
        </span>
      ))}
    </div>
  );
}

function MatchRow({
  b,
  r,
  keys,
  style,
  onUnmatch,
  onDoubleClick,
}: {
  b: Budget;
  r: Extract<Row, { kind: 'match' }>;
  keys: ColKey[];
  style: React.CSSProperties;
  onUnmatch: () => void;
  onDoubleClick: () => void;
}) {
  const { t } = r;
  const m = t.matched!;
  const bank = r.side === 'bank';
  const amount = bank ? m.bank.amount : t.amount;
  const cells: Partial<Record<ColKey, React.ReactNode>> = {
    check: <span className="ct">{bank ? m.bank.check : t.check}</span>,
    date: <span className="ct">{formatDate(bank ? m.bank.date : m.yours.date)}</span>,
    payee: (
      <span className="ct" title={bank ? m.bank.payee : undefined}>
        <b className="match-tag">{bank ? 'Bank:' : 'Yours:'}</b> {bank ? m.bank.payee : payeeName(b, t)}
      </span>
    ),
    category: bank ? (
      <span className="ct">
        <button
          className="link small"
          onMouseDown={keepFocus}
          title="Keep these apart: your transaction goes back as it was, and the bank's is added separately"
          onClick={(e) => {
            e.stopPropagation();
            onUnmatch();
          }}
        >
          Unmatch
        </button>
      </span>
    ) : (
      <span className="ct">{t.categoryId === SPLIT ? 'Split' : categoryLabel(b, t.categoryId, t.date)}</span>
    ),
    memo: <span className="ct">{bank ? m.bank.memo : t.memo}</span>,
    outflow: <span className="ct r">{amount < 0 ? formatMoney(-amount) : ''}</span>,
    inflow: <span className="ct r">{amount > 0 ? formatMoney(amount) : ''}</span>,
  };
  return (
    <div className={cx('rrow rgrid matchline', bank ? 'bank' : 'yours')} style={style} onDoubleClick={onDoubleClick}>
      {keys.map((k) => (
        <span key={k} style={{ display: 'contents' }}>
          {cells[k] ?? <span />}
        </span>
      ))}
    </div>
  );
}

// ---- Bulk actions --------------------------------------------------------------------------

function BulkBar({
  ids,
  accountId,
  onDelete,
  onClear,
}: {
  ids: Id[];
  accountId: Id | 'all';
  onDelete: () => void;
  onClear: () => void;
}) {
  const b = useBudget();
  const [catAnchor, setCatAnchor] = useState<HTMLElement | null>(null);
  const [accAnchor, setAccAnchor] = useState<HTMLElement | null>(null);
  const catOpts = useMemo(() => categoryOptions(b, { uncategorized: true }), [b]);
  const accOpts = useMemo(
    () => accountOptions(b, { exclude: accountId === 'all' ? undefined : accountId }),
    [b, accountId],
  );
  const total = ids.reduce((s, id) => s + (b.transactions[id]?.amount || 0), 0);
  const unapproved = ids.filter((id) => !b.transactions[id]?.accepted).length;
  // Moving or re-dating reconciled rows (or their transfers' reconciled other sides) is asked
  // first, as Edit and Delete do (1.5.11).
  const reconciledOk = async (what: string): Promise<boolean> => {
    const r = reconciledAffected(b, ids, what === 'Change date');
    if (!r.own && !r.others.size) return true;
    const notes = [
      r.own ? ` ${r.own === ids.length ? (ids.length === 1 ? "It is" : "They are") : `${r.own} of them ${r.own === 1 ? "is" : "are"}`} reconciled.` : "",
      r.others.size ? ` The other side of a transfer in ${[...r.others].join(" and ")} is reconciled and changes too.` : "",
    ].join("");
    return confirm(what, `${what} ${ids.length} transaction${ids.length === 1 ? "" : "s"}?${notes} You can undo this.`, what);
  };
  return (
    <div className="bulk-bar" role="toolbar" aria-label="Selected transactions">
      <b>{ids.length} selected</b>
      <span className="muted">{formatMoney(total)}</span>
      <button className="btn small" onClick={(e) => setCatAnchor(e.currentTarget)}>
        Categorise…
      </button>
      <button
        className="btn small"
        onClick={() =>
          update('Mark cleared', (d) =>
            setCleared(
              d,
              ids.filter((id) => d.transactions[id].cleared !== 'R'),
              'C',
            ),
          )
        }
      >
        Cleared
      </button>
      <button
        className="btn small"
        onClick={() =>
          update('Mark uncleared', (d) =>
            setCleared(
              d,
              ids.filter((id) => d.transactions[id].cleared !== 'R'),
              'U',
            ),
          )
        }
      >
        Uncleared
      </button>
      {unapproved > 0 && (
        <button className="btn small green" onClick={() => update('Approve', (d) => approveTransactions(d, ids))}>
          Approve {unapproved}
        </button>
      )}
      <MenuButton
        label="More ▾"
        items={[
          {
            label: 'Change date…',
            onClick: async () => {
              const v = await prompt('Change date', 'New date for all selected transactions', formatDate(today()));
              const d = v ? parseDateInput(v) : null;
              if (d) {
                if (await reconciledOk('Change date')) update('Change date', (x) => setTransactionsDate(x, ids, d));
              }
              // Said, rather than doing nothing without a word (1.5.3).
              else if (v) toast(`"${v}" isn't a date I can read: type it as day/month/year. Nothing was changed.`, 'error');
            },
          },
          {
            label: 'Change payee…',
            onClick: async () => {
              const v = await prompt(
                'Change payee',
                'New payee for the selected transactions (transfers are left alone)',
              );
              if (v && v.trim()) update('Change payee', (x) => setTransactionsPayee(x, ids, v));
            },
          },
          {
            label: 'Move to another account…',
            onClick: async () => {
              const el = document.activeElement as HTMLElement;
              if (await reconciledOk('Move')) setAccAnchor(el);
            },
          },
          'sep',
          { label: 'Delete', danger: true, onClick: onDelete },
        ]}
      />
      <button className="icon-btn" onClick={onClear} title="Clear selection">
        ✕
      </button>
      {catAnchor && (
        <Popover anchor={catAnchor} onClose={() => setCatAnchor(null)} width={280}>
          <div className="pop-pad">
            <div className="pop-title">Categorise {ids.length} transactions</div>
            <Autocomplete
              value=""
              autoFocus
              options={catOpts}
              placeholder="Choose a category"
              pickOnBlur={false}
              onChange={(_t, o) => {
                if (!o) return;
                let n = 0;
                update('Categorise', (d) => {
                  n = categorizeTransactions(d, ids, o.value || null);
                });
                toast(
                  `Categorised ${n} transaction${n === 1 ? '' : 's'}${n < ids.length ? ` (${ids.length - n} split or transfer skipped)` : ''}.`,
                  'ok',
                );
                setCatAnchor(null);
              }}
            />
          </div>
        </Popover>
      )}
      {accAnchor && (
        <Modal title="Move to another account" onClose={() => setAccAnchor(null)} width={380}>
          <Autocomplete
            value=""
            autoFocus
            options={accOpts}
            placeholder="Choose an account"
            pickOnBlur={false}
            onChange={(_t, o) => {
              if (!o) return;
              let n = 0;
              update('Move transactions', (d) => {
                n = moveTransactions(d, ids, o.value);
              });
              toast(`Moved ${n} transaction${n === 1 ? '' : 's'} to ${o.label}.`, 'ok');
              setAccAnchor(null);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
