import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDate, parseDateInput, today } from '../../model/dates';
import { formatMoney, parseMoneyInput } from '../../model/money';
import { newId } from '../../model/ids';
import { ensurePayee, saveScheduled, saveTransaction, scheduleFromTransaction, type TransactionInput } from '../../model/ops';
import { guessCategory, payeeKey, transferKey } from '../../model/guess';
import { autoFillOptions, categoryShortName, payeeName, transferNeedsCategory } from '../../model/queries';
import { nextScheduledDate } from '../../model/schedule';
import {
  FLAGS,
  FREQUENCY_LABELS,
  SPLIT,
  type Budget,
  type Cleared,
  type Flag,
  type Frequency,
  type Id,
  type ISODate,
  type Money,
  type ScheduledTransaction,
  type Split,
  type Transaction,
} from '../../model/types';
import { registerDraft } from '../../state/persistence';
import { store, update, useBudget, useComputed } from '../../state/store';
import { toast } from '../common/dialogs';
import * as actions from '../actions';
import { Autocomplete, DateInput, MoneyInput, type Option } from '../common/inputs';
import { cx } from '../common/Money';
import { Popover } from '../common/overlay';
import { accountOptions, categoryOptions, payeeOptions } from '../common/options';
import { columnKeys, gridTemplate, type RegisterColumns } from './columns';

// The inline transaction editor (YNAB4 style): one row of fields in the register's
// columns, with split lines underneath when the transaction is split.

interface Line {
  key: string;
  id?: Id;
  payeeText: string;
  transferAccountId?: Id;
  categoryId: Id | null;
  memo: string;
  outflow: Money;
  inflow: Money;
}

interface Draft {
  accountId: Id;
  date: ISODate;
  payeeText: string;
  payeeId?: Id;
  transferAccountId?: Id;
  categoryId: Id | null;
  memo: string;
  outflow: Money;
  inflow: Money;
  cleared: Cleared;
  flag?: Flag;
  check: string;
  split: boolean;
  lines: Line[];
  repeat: Frequency | '';
  /** TwiceAMonth: the second day (0 = last day of the month). */
  twiceDay2: number;
  /** Last date for a scheduled transaction ('' = no end). */
  endDate: string;
}

const blankLine = (): Line => ({ key: newId(), payeeText: '', categoryId: null, memo: '', outflow: 0, inflow: 0 });

function toLines(b: Budget, splits: Split[] | undefined): Line[] {
  return (splits || []).map((s) => ({
    key: s.id || newId(),
    id: s.id,
    payeeText: s.transferAccountId ? 'Transfer : ' + (b.accounts[s.transferAccountId]?.name || '?') : '',
    transferAccountId: s.transferAccountId,
    categoryId: s.categoryId,
    memo: s.memo || '',
    outflow: s.amount < 0 ? -s.amount : 0,
    inflow: s.amount > 0 ? s.amount : 0,
  }));
}

function draftFrom(b: Budget, src: Transaction | ScheduledTransaction | undefined, accountId: Id, date: ISODate): Draft {
  if (!src) {
    return {
      accountId,
      date,
      payeeText: '',
      categoryId: null,
      memo: '',
      outflow: 0,
      inflow: 0,
      cleared: 'U',
      check: '',
      split: false,
      lines: [],
      repeat: '',
      twiceDay2: 0,
      endDate: '',
    };
  }
  return {
    accountId: src.accountId,
    date: src.date,
    payeeText: payeeName(b, src),
    payeeId: src.transferAccountId ? undefined : src.payeeId,
    transferAccountId: src.transferAccountId,
    categoryId: src.categoryId,
    memo: src.memo || '',
    outflow: src.amount < 0 ? -src.amount : 0,
    inflow: src.amount > 0 ? src.amount : 0,
    cleared: 'cleared' in src ? src.cleared : 'U',
    flag: src.flag,
    check: src.check || '',
    split: src.categoryId === SPLIT,
    lines: src.categoryId === SPLIT ? toLines(b, src.splits) : [],
    repeat: 'frequency' in src ? src.frequency : '',
    twiceDay2: 'frequency' in src ? (src.twiceMonthDay2 ?? 0) : 0,
    endDate: 'frequency' in src ? (src.endDate ?? '') : '',
  };
}

/** Whether one of the editor's boxes holds an amount or a date it can't read ("12,5", "31/9"). */
function unreadableBox(root: HTMLElement | null): 'amount' | 'date' | null {
  if (!root) return null;
  for (const el of root.querySelectorAll<HTMLInputElement>('input.money-input'))
    if (el.classList.contains('bad') || (el.value.trim() && parseMoneyInput(el.value) === null)) return 'amount';
  // Read against the box's own date, as the box reads it ("31" in November can't be read).
  for (const el of root.querySelectorAll<HTMLInputElement>('.date-input input.dt')) if (!parseDateInput(el.value, el.dataset.base || today())) return 'date';
  return null;
}

export interface TxEditorProps {
  /** The register's account, or 'all'. */
  accountId: Id | 'all';
  tx?: Transaction;
  scheduled?: ScheduledTransaction;
  /** Edit a scheduled transaction (shows frequency and next date) rather than a transaction. */
  scheduleMode?: boolean;
  columns: RegisterColumns;
  /** A new transaction's date, when not today (the last one's, after "Save and add another"). */
  defaultDate?: string;
  /** `next`: open the next transaction that needs a category (YNAB4), see `saveNext`. */
  onDone: (savedId?: Id, addAnother?: boolean, next?: boolean) => void;
  /** Offer "Save, next without category" (Shift+Enter): another transaction here still needs one. */
  saveNext?: boolean;
  onCancel: () => void;
  onDelete?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export function TxEditor(p: TxEditorProps) {
  const b = useBudget();
  const c = useComputed();
  const defaultAccount =
    p.accountId !== 'all' ? p.accountId : Object.values(b.accounts).find((a) => !a.closed && a.onBudget)?.id || '';
  const [d, setDraft] = useState<Draft>(() => {
    const x = draftFrom(b, p.tx || p.scheduled, defaultAccount, p.defaultDate || today());
    // A new scheduled transaction is most often a monthly bill.
    if (p.scheduleMode && !p.scheduled && !x.repeat) x.repeat = 'Monthly';
    return x;
  });
  // The latest draft, readable straight away: Enter in a field updates it and saves in the same keypress.
  const dRef = useRef(d);
  const setD = (f: (x: Draft) => Draft) => {
    dRef.current = f(dRef.current);
    setDraft(dRef.current);
  };
  const [error, setError] = useState('');
  const [flagAnchor, setFlagAnchor] = useState<HTMLElement | null>(null);
  const payeeRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const isNew = !p.tx && !p.scheduled;
  const isSched = !!p.scheduleMode;
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  const amount = d.inflow - d.outflow;
  const linesTotal = d.lines.reduce((s, l) => s + l.inflow - l.outflow, 0);
  const remaining = amount - linesTotal;
  const needsCategory = !d.transferAccountId || transferNeedsCategory(b, d.accountId, d.transferAccountId);
  const lockedPeer = !!p.tx?.transferSplitParentId;
  // A transaction already there can be made to repeat too (1.5.7), unless a schedule it came from
  // is still there (that would make a second schedule).
  // A transfer's other side counts: the scheduler marks only the side it entered (1.5.10).
  const fromSchedule = (t?: Transaction) => !!(t?.scheduleId && b.scheduled[t.scheduleId]);
  const canRepeat =
    isNew || (!!p.tx && !isSched && !lockedPeer && !fromSchedule(p.tx) && !fromSchedule(p.tx.transferTxId ? b.transactions[p.tx.transferTxId] : undefined));

  const payeeOpts = useMemo(() => payeeOptions(b, d.accountId), [b, d.accountId]);
  const catOpts = useMemo(
    () => categoryOptions(b, { date: d.date, computed: c, split: !d.transferAccountId }),
    [b, c, d.date, d.transferAccountId],
  );
  const lineCatOpts = useMemo(() => categoryOptions(b, { date: d.date, computed: c }), [b, c, d.date]);
  const accOpts = useMemo(() => accountOptions(b, { includeClosed: !!p.tx }), [b, p.tx]);
  const linePayeeOpts = useMemo(
    () => [{ value: '', label: '(same payee)' } as Option, ...payeeOptions(b, d.accountId).filter((o) => o.value.startsWith('transfer:'))],
    [b, d.accountId],
  );

  const pickPayee = (text: string, o?: Option) => {
    if (o?.value.startsWith('transfer:')) {
      const acc = o.value.slice(9);
      const needs = transferNeedsCategory(b, d.accountId, acc);
      // A transfer to a tracking account (e.g. a pension) gets the category used for it before.
      // A split's category goes: a transfer has none, or its own (1.5.11).
      const was = d.categoryId === SPLIT ? null : d.categoryId;
      const g = needs && isNew && !was ? guessCategory(b, transferKey(acc), d.inflow - d.outflow) : null;
      set({
        payeeText: o.label,
        payeeId: undefined,
        transferAccountId: acc,
        categoryId: needs ? (g?.categoryId ?? was) : null,
        split: false,
        lines: [],
      });
      return;
    }
    const payee = o ? b.payees[o.value] : undefined;
    const patch: Partial<Draft> = { payeeText: o ? o.label : text, payeeId: payee?.id, transferAccountId: undefined };
    // Auto-fill from what this payee had last time (YNAB4 behaviour), only into empty fields,
    // and only the parts switched on for all payees (category only, unless changed).
    if (payee && isNew) {
      const fill = autoFillOptions(b);
      let amount = d.inflow - d.outflow;
      if (fill.amount && !d.outflow && !d.inflow && payee.autoAmount) {
        patch.outflow = payee.autoAmount < 0 ? -payee.autoAmount : 0;
        patch.inflow = payee.autoAmount > 0 ? payee.autoAmount : 0;
        amount = payee.autoAmount;
      }
      if (fill.category && !d.categoryId && !d.split) {
        // From the payee's actual history, not YNAB4's often-blank remembered category.
        const g = guessCategory(b, payeeKey(payee.id), amount);
        const remembered = payee.autoCategoryId;
        if (g) patch.categoryId = g.categoryId;
        else if (remembered && (b.categories[remembered] || remembered.startsWith('__'))) patch.categoryId = remembered;
      }
      if (fill.memo && !d.memo && payee.autoMemo) patch.memo = payee.autoMemo;
    }
    set(patch);
  };

  const pickCategory = (o?: Option) => {
    if (o?.value === SPLIT) {
      const first: Line = { ...blankLine(), outflow: d.outflow, inflow: d.inflow, categoryId: d.categoryId === SPLIT ? null : d.categoryId };
      set({ split: true, categoryId: SPLIT, lines: [first, blankLine()] });
      // The Category box goes away; the keyboard moves on to the first line's.
      requestAnimationFrame(() => rootRef.current?.querySelector<HTMLInputElement>('[aria-label="Split 1 category"]')?.focus());
      return;
    }
    set({ categoryId: o ? o.value || null : null, split: false });
  };

  const setLine = (key: string, patch: Partial<Line>) =>
    setD((x) => ({ ...x, lines: x.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));

  // Left without Save or Cancel (another screen, another row): saved, as budget cells and notes
  // are, rather than thrown away without a word (1.5.3). Not the scheduler's dialog, which can't
  // be left that way.
  const initial = useRef(JSON.stringify(d));
  // The editor's boxes, kept after it closes: leaving reads what they hold (night seven).
  const lastRoot = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    lastRoot.current = rootRef.current;
  });
  // What the transaction looked like when the editor opened it, in the editor's own terms (so an
  // approval, which the editor doesn't show, doesn't count). If it changes meanwhile (its
  // transfer's other side saved, a reconcile, an import), an untouched editor shows the new
  // version, and leaving doesn't save the old one over it.
  const shape = (x: Draft) =>
    JSON.stringify(x, function (this: Record<string, unknown>, k, v) {
      if (k === 'key') return undefined;
      // A payee's or account's name follows it if it's renamed meanwhile: the ids say which.
      if (k === 'payeeText' && (this.payeeId || this.transferAccountId)) return undefined;
      return v;
    });
  const shapeOf = (x: Budget, tx: Transaction) => shape(draftFrom(x, tx, defaultAccount, ''));
  const openedAs = useRef(p.tx ? shapeOf(b, p.tx) : '');
  useEffect(() => {
    if (!p.tx || JSON.stringify(dRef.current) !== initial.current) return;
    const now = shapeOf(store.budget ?? b, p.tx);
    if (now === openedAs.current) return;
    const x = draftFrom(store.budget ?? b, p.tx, defaultAccount, today());
    openedAs.current = now;
    initial.current = JSON.stringify(x);
    dRef.current = x;
    setDraft(x);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.tx]);
  const finished = useRef(false);
  const budgetAtStart = useRef(store.budget?.id);
  const cancel = () => {
    finished.current = true;
    p.onCancel();
  };
  const del = () => {
    finished.current = true;
    p.onDelete?.();
  };
  const saveRef = useRef<(stillOpen?: boolean) => string | void>(() => {});
  useEffect(
    () => () => {
      saveRef.current();
    },
    [],
  );
  // And before closing the app or switching budget, which don't close the editor (1.5.3). If it
  // can't be saved, the editor stays open and the app asks before leaving without it.
  useEffect(() => registerDraft(() => saveRef.current(true), { open: true }), []);

  /** The transaction as entered, or why it can't be saved. */
  const prepare = (d: Draft): { error: string } | { input: TransactionInput; splits?: Split[]; amount: number } => {
    const amount = d.inflow - d.outflow;
    const remaining = amount - d.lines.reduce((s, l) => s + l.inflow - l.outflow, 0);
    if (!d.accountId || !b.accounts[d.accountId]) return { error: 'Choose an account.' };
    if (d.transferAccountId === d.accountId) return { error: "A transfer can't go to the same account." };
    let splits: Split[] | undefined;
    if (d.split) {
      const used = d.lines.filter((l) => l.outflow || l.inflow || l.categoryId || l.transferAccountId);
      if (used.length === 0) return { error: 'Add at least one split line.' };
      if (remaining !== 0) return { error: `The split lines don't add up: ${formatMoney(remaining)} still to assign.` };
      splits = used.map((l) => ({
        id: l.id || newId(),
        categoryId: l.categoryId,
        amount: l.inflow - l.outflow,
        memo: l.memo || undefined,
        transferAccountId: l.transferAccountId,
        transferTxId: p.tx?.splits?.find((s) => s.id === l.id)?.transferTxId,
      }));
    }
    const input: TransactionInput = {
      id: p.tx?.id,
      accountId: d.accountId,
      date: d.date,
      payeeId: d.transferAccountId ? undefined : d.payeeId,
      payeeName: d.transferAccountId || d.payeeId ? undefined : d.payeeText,
      transferAccountId: d.transferAccountId,
      categoryId: d.split ? SPLIT : d.categoryId === SPLIT ? null : d.categoryId,
      memo: d.memo,
      amount,
      cleared: d.cleared,
      flag: d.flag,
      check: d.check,
      splits,
    };
    return { input, splits, amount };
  };

  /** Saves a transaction (not a schedule), with any repeat it was given. Returns its id. */
  const saveTx = (d: Draft, input: TransactionInput, label: string): Id => {
    let id = '';
    let madeSchedule = '';
    let twin = '';
    update(label, (x) => {
      id = saveTransaction(x, input);
      if (canRepeat && d.repeat) {
        // A schedule like it already (same account, payee or transfer, and amount): made anyway,
        // but said, as it's most likely the same payment twice (1.5.9).
        const t = x.transactions[id];
        // A transfer's schedule can be on either side (1.5.10).
        const like = Object.values(x.scheduled).find(
          (s) =>
            (s.accountId === t.accountId && s.amount === t.amount && (t.transferAccountId ? s.transferAccountId === t.transferAccountId : !!t.payeeId && s.payeeId === t.payeeId)) ||
            (!!t.transferAccountId && s.accountId === t.transferAccountId && s.transferAccountId === t.accountId && s.amount === -t.amount),
        );
        if (like) twin = like.date;
        const rule = { frequency: d.repeat, startDate: d.date, twiceMonthDay2: d.twiceDay2, endDate: d.endDate || undefined } as ScheduledTransaction;
        // An older transaction's schedule starts at its first date after today: the ones in
        // between are in the register already (or the bank's file will bring them), so none are
        // entered twice. Stepped from its own date, on its own days (1.5.9: stepping from today
        // skipped a month, and a weekly one moved weekday).
        let next = nextScheduledDate(rule, d.date);
        if (!isNew) while (next && next <= today()) next = nextScheduledDate(rule, next);
        if (!isNew && next) madeSchedule = next;
        const sid = next ? scheduleFromTransaction(x, id, d.repeat, next) : null;
        if (sid) {
          x.scheduled[sid].startDate = d.date;
          if (d.repeat === 'TwiceAMonth') x.scheduled[sid].twiceMonthDay2 = d.twiceDay2;
          if (d.endDate) x.scheduled[sid].endDate = d.endDate;
        }
      }
    });
    if (madeSchedule || twin)
      toast(
        twin
          ? `Scheduled, but there was already a schedule like it (next on ${formatDate(twin)}). If it's the same payment, delete one on the Scheduled screen, or it will be entered twice.`
          : `Scheduled: it repeats from ${formatDate(madeSchedule)} (see the Scheduled screen)`,
        twin ? 'error' : 'ok',
      );
    return id;
  };

  saveRef.current = (stillOpen = false) => {
    if (finished.current || isSched) return;
    // Text that can't be read, typed over an otherwise unchanged row, still counts as a change:
    // the box keeps its old value, so the draft looks untouched (night seven).
    const bad = unreadableBox(rootRef.current ?? lastRoot.current);
    if (!bad && JSON.stringify(dRef.current) === initial.current) return;
    // Not into another budget, and not a transaction deleted meanwhile.
    const now = store.budget;
    if (!now || now.id !== budgetAtStart.current || (p.tx && !now.transactions[p.tx.id])) return;
    const d = dRef.current;
    const what = isNew ? "The new transaction you were entering wasn't" : "Your changes to a transaction weren't";
    // Not saved: said in a message, or (still on screen) handed back so the app can ask.
    const refuse = (why: string) => {
      const msg = `${what} saved: ${why}`;
      if (stillOpen) return msg;
      toast(msg, 'error');
    };
    if (p.tx && shapeOf(now, now.transactions[p.tx.id]) !== openedAs.current) return refuse('the transaction was changed elsewhere meanwhile.');
    if (bad) return refuse(`${bad === 'date' ? 'a date' : 'an amount'} couldn't be read.`);
    const r = prepare(d);
    if ('error' in r) return refuse(r.error.charAt(0).toLowerCase() + r.error.slice(1));
    if (isNew && !r.amount) {
      // Nothing worth keeping: a payee typed halfway would only become a new payee.
      if (d.payeeText.trim() || d.memo) return refuse('it had no amount.');
      return;
    }
    const id = saveTx(d, r.input, isNew ? 'Add transaction' : 'Edit transaction');
    finished.current = true;
    // Still on screen (the app closing, another budget opening): the editor closes, so the row
    // isn't saved a second time.
    if (stillOpen) p.onDone(id);
    toast(`${isNew ? 'The new transaction you were entering was' : 'Your changes to a transaction were'} saved when you left it.`, 'ok', { label: 'Undo', fn: actions.undoThis() });
  };

  const save = (addAnother = false, next = false) => {
    const d = dRef.current;
    setError('');
    // An amount box still in red couldn't be read ("12,5", say): don't save without it.
    if (rootRef.current?.querySelector('.money-input.bad')) return setError("An amount couldn't be read: correct the box in red.");
    // Nor a date ("31/9", "1st"): its box keeps the last good date, which would be saved instead.
    // Read from the boxes themselves, as Enter in one saves before it has turned red (1.5.3).
    for (const el of rootRef.current?.querySelectorAll<HTMLInputElement>('.date-input input.dt') ?? [])
      // Read against the box's own date, as the box reads it ("31" in November can't be read).
      if (!parseDateInput(el.value, el.dataset.base || today())) {
        el.classList.add('bad');
        el.focus();
        return setError("A date couldn't be read: type it as day/month/year (31/10/2026), or pick it from the calendar.");
      }
    // Changed elsewhere since it was opened (its transfer's other side, a reconcile): saving this
    // version would undo that (night seven).
    const now = store.budget;
    if (p.tx && now?.transactions[p.tx.id] && shapeOf(now, now.transactions[p.tx.id]) !== openedAs.current)
      return setError('This transaction was changed elsewhere since you opened it. Press Esc to see it as it is now, then make your change again.');
    const r = prepare(d);
    if ('error' in r) return setError(r.error);
    const { input, splits, amount } = r;

    // A transaction dated in the future stays an ordinary transaction, as in YNAB4 (it can be
    // sent to the scheduler from its menu). Only the scheduler's own editor saves schedules.
    if (isSched) {
      const freq: Frequency = (d.repeat || 'Once') as Frequency;
      let sid = '';
      update(p.scheduled ? 'Edit scheduled transaction' : 'Add scheduled transaction', (x) => {
        const payeeId = d.transferAccountId ? undefined : d.payeeId || (d.payeeText ? ensurePayee(x, d.payeeText) : undefined);
        sid = saveScheduled(x, {
          id: p.scheduled?.id,
          accountId: d.accountId,
          date: d.date,
          // Keeps its day (the 31st, say) unless the date or how often it repeats changed (1.5.3).
          startDate: p.scheduled && p.scheduled.date === d.date && p.scheduled.frequency === freq ? p.scheduled.startDate : d.date,
          frequency: freq,
          twiceMonthDay2: freq === 'TwiceAMonth' ? d.twiceDay2 : undefined,
          endDate: d.endDate || undefined,
          payeeId,
          transferAccountId: d.transferAccountId,
          categoryId: d.split ? SPLIT : d.categoryId === SPLIT ? null : d.categoryId,
          memo: d.memo || undefined,
          amount,
          flag: d.flag,
          check: d.check || undefined,
          splits: splits?.map((s) => ({ ...s, transferTxId: undefined })),
        });
      });
      finished.current = true;
      p.onDone(sid, addAnother);
      return;
    }

    const id = saveTx(d, input, p.tx ? 'Edit transaction' : 'Add transaction');
    finished.current = true;
    p.onDone(id, addAnother, next);
  };

  const keys = columnKeys(p.columns);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.defaultPrevented && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
      e.preventDefault();
      // Ctrl+Enter saves a new transaction and starts another; Shift+Enter saves one and opens
      // the next that needs a category (1.5.7).
      save(isNew && e.ctrlKey, !!p.saveNext && e.shiftKey);
    } else if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      cancel();
    }
  };

  const cell = (k: (typeof keys)[number]) => {
    switch (k) {
      case 'sel':
        return <span key={k} />;
      case 'flag':
        return (
          <span key={k} className="ct flagc">
            <button
              type="button"
              className={cx('flag', d.flag ? 'flag-' + d.flag : 'flag-none')}
              title="Flag"
              onClick={(e) => setFlagAnchor(e.currentTarget)}
            >
              ⚑
            </button>
          </span>
        );
      case 'account':
        // The far side of a split transfer stays in its account and keeps its payee: they change
        // with the split line.
        if (lockedPeer) return <span key={k} className="na">{b.accounts[d.accountId]?.name}</span>;
        return (
          <Autocomplete
            key={k}
            value={b.accounts[d.accountId]?.name || ''}
            options={accOpts}
            onChange={(_t, o) => o && set({ accountId: o.value })}
            ariaLabel="Account"
            // In All accounts, the account comes first (the date box has the keyboard otherwise), 1.5.3.
            autoFocus={p.columns.account}
          />
        );
      case 'check':
        return <input key={k} value={d.check} onChange={(e) => set({ check: e.target.value })} aria-label="Cheque number" placeholder="Cheque" />;
      case 'date':
        return <DateInput key={k} value={d.date} onChange={(v) => set({ date: v })} autoFocus={!p.columns.account} />;
      case 'payee':
        if (lockedPeer) return <span key={k} className="na">{d.payeeText}</span>;
        return (
          <Autocomplete
            key={k}
            inputRef={payeeRef}
            value={d.payeeText}
            options={payeeOpts}
            allowFree
            freeLabel={(t) => `New payee: "${t}"`}
            placeholder="Payee"
            ariaLabel="Payee"
            onChange={pickPayee}
          />
        );
      case 'category':
        if (!needsCategory) return <span key={k} className="na">Transfer (no category needed)</span>;
        if (d.split) return <span key={k} className="na">Split, see lines below</span>;
        return (
          <Autocomplete
            key={k}
            value={d.categoryId ? categoryShortName(b, d.categoryId, d.date) : ''}
            options={catOpts}
            placeholder="Category"
            ariaLabel="Category"
            onChange={(_t, o) => pickCategory(o)}
          />
        );
      case 'memo':
        return <input key={k} value={d.memo} onChange={(e) => set({ memo: e.target.value })} placeholder="Memo" aria-label="Memo" />;
      case 'outflow':
        return (
          <MoneyInput
            key={k}
            value={d.outflow}
            placeholder="Outflow"
            ariaLabel="Outflow"
            onCommit={(v) => set(v < 0 ? { outflow: 0, inflow: -v } : { outflow: v, inflow: v ? 0 : d.inflow })}
          />
        );
      case 'inflow':
        return (
          <MoneyInput
            key={k}
            value={d.inflow}
            placeholder="Inflow"
            ariaLabel="Inflow"
            onCommit={(v) => set(v < 0 ? { inflow: 0, outflow: -v } : { inflow: v, outflow: v ? 0 : d.outflow })}
          />
        );
      case 'balance':
        return <span key={k} />;
      case 'cleared':
        return (
          <span key={k} className="ct clr">
            {!isSched && (
              <button
                type="button"
                className={cx('cleared', d.cleared === 'C' && 'is-c', d.cleared === 'R' && 'is-r')}
                title={d.cleared === 'U' ? 'Uncleared' : d.cleared === 'C' ? 'Cleared' : 'Reconciled'}
                onClick={() => set({ cleared: d.cleared === 'U' ? 'C' : 'U' })}
              >
                {d.cleared === 'R' ? '🔒' : 'C'}
              </button>
            )}
          </span>
        );
    }
  };

  const lineCell = (l: Line, i: number, k: (typeof keys)[number]) => {
    switch (k) {
      case 'date':
        return (
          <span key={k} className="ct r muted" style={{ fontSize: 12 }}>
            <button type="button" className="icon-btn" title="Remove this line" onClick={() => setD((x) => ({ ...x, lines: x.lines.filter((y) => y.key !== l.key) }))}>
              ✕
            </button>
            {i + 1}
          </span>
        );
      case 'payee':
        return (
          <Autocomplete
            key={k}
            value={l.payeeText}
            options={linePayeeOpts}
            placeholder="(same payee)"
            ariaLabel={`Split ${i + 1} payee`}
            onChange={(_t, o) => {
              const acc = o?.value.startsWith('transfer:') ? o.value.slice(9) : undefined;
              setLine(l.key, {
                payeeText: acc ? o!.label : '',
                transferAccountId: acc,
                categoryId: acc && !transferNeedsCategory(b, d.accountId, acc) ? null : l.categoryId,
              });
            }}
          />
        );
      case 'category':
        if (l.transferAccountId && !transferNeedsCategory(b, d.accountId, l.transferAccountId))
          return <span key={k} className="na">Transfer</span>;
        return (
          <Autocomplete
            key={k}
            value={l.categoryId ? categoryShortName(b, l.categoryId, d.date) : ''}
            options={lineCatOpts}
            placeholder="Category"
            ariaLabel={`Split ${i + 1} category`}
            onChange={(_t, o) => setLine(l.key, { categoryId: o ? o.value || null : null })}
          />
        );
      case 'memo':
        return <input key={k} value={l.memo} onChange={(e) => setLine(l.key, { memo: e.target.value })} placeholder="Memo" aria-label={`Split ${i + 1} memo`} />;
      case 'outflow':
        return (
          <MoneyInput
            key={k}
            value={l.outflow}
            ariaLabel={`Split ${i + 1} outflow`}
            onCommit={(v) => setLine(l.key, v < 0 ? { outflow: 0, inflow: -v } : { outflow: v, inflow: v ? 0 : l.inflow })}
          />
        );
      case 'inflow':
        return (
          <MoneyInput
            key={k}
            value={l.inflow}
            ariaLabel={`Split ${i + 1} inflow`}
            onCommit={(v) => setLine(l.key, v < 0 ? { inflow: 0, outflow: -v } : { inflow: v, outflow: v ? 0 : l.outflow })}
          />
        );
      default:
        return <span key={k} />;
    }
  };

  const template = gridTemplate(p.columns);
  return (
    <div ref={rootRef} className={cx('tx-editor', p.className)} style={p.style} onKeyDown={onKey}>
      <div className="rgrid ed-row" style={{ gridTemplateColumns: template }}>
        {keys.map(cell)}
      </div>
      {d.split && (
        <div className="split-lines">
          {d.lines.map((l, i) => (
            <div key={l.key} className="rgrid ed-row" style={{ gridTemplateColumns: template }}>
              {keys.map((k) => lineCell(l, i, k))}
            </div>
          ))}
        </div>
      )}
      <div className="ed-actions">
        {d.split && (
          <>
            <button type="button" className="btn small" onClick={() => setD((x) => ({ ...x, lines: [...x.lines, { ...blankLine(), outflow: remaining < 0 ? -remaining : 0, inflow: remaining > 0 ? remaining : 0 }] }))}>
              + Add split line
            </button>
            <span className={cx('remaining', remaining !== 0 && 'neg')}>
              {remaining === 0 ? 'Fully assigned' : `${formatMoney(Math.abs(remaining))} left to assign`}
            </span>
            <button type="button" className="link small" onClick={() => set({ split: false, lines: [], categoryId: null })}>
              Don't split
            </button>
          </>
        )}
        {(canRepeat || isSched) && !lockedPeer && (
          <label className="small muted" style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            {isSched ? 'Frequency' : 'Repeat'}
            <select className="small" value={d.repeat} onChange={(e) => set({ repeat: e.target.value as Frequency | '' })} aria-label="Repeat">
              {!isSched && <option value="">Never</option>}
              {(Object.keys(FREQUENCY_LABELS) as Frequency[]).map((f) => (
                <option key={f} value={f}>
                  {f === 'Once' ? 'Once (not repeating)' : FREQUENCY_LABELS[f]}
                </option>
              ))}
            </select>
          </label>
        )}
        {d.repeat === 'TwiceAMonth' && (
          <label className="small muted" style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            and on day
            <select className="small" value={d.twiceDay2} onChange={(e) => set({ twiceDay2: +e.target.value })} aria-label="Second day of the month">
              {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              <option value={0}>the last day</option>
            </select>
          </label>
        )}
        {(isSched || d.repeat) && d.repeat !== 'Once' && (
          <label className="small muted" style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            <input type="checkbox" checked={!!d.endDate} onChange={(e) => set({ endDate: e.target.checked ? d.date : '' })} />
            Ends
            {d.endDate && (
              <span style={{ width: 110 }}>
                <DateInput value={d.endDate} onChange={(v) => set({ endDate: v })} />
              </span>
            )}
          </label>
        )}
        {lockedPeer && <span className="hint">This is the other side of a split transfer; edit the split in its own account to change the split.</span>}
        {error && <span className="neg small">{error}</span>}
        <span className="grow" />
        {p.onDelete && (
          <button type="button" className="btn small" onClick={del}>
            Delete
          </button>
        )}
        <button type="button" className="btn small" onClick={cancel}>
          Cancel
        </button>
        {isNew && !isSched && (
          <button type="button" className="btn small" onClick={() => save(true)} title="Save, then start another">
            Save and add another
          </button>
        )}
        {p.saveNext && (
          <button type="button" className="btn small" onClick={() => save(false, true)} title="Save, then open the next transaction that needs a category (Shift+Enter)">
            Save, next without category
          </button>
        )}
        <button type="button" className="btn small primary" onClick={() => save(false)}>
          Save
        </button>
      </div>
      {flagAnchor && (
        <Popover anchor={flagAnchor} onClose={() => setFlagAnchor(null)}>
          <div className="flag-menu">
            <button type="button" className="flag flag-none" title="No flag" onClick={() => { set({ flag: undefined }); setFlagAnchor(null); }}>
              ⚐
            </button>
            {FLAGS.map((f) => (
              <button type="button" key={f} className={'flag flag-' + f} title={f} onClick={() => { set({ flag: f }); setFlagAnchor(null); }}>
                ⚑
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}
