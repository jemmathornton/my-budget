import { useEffect, useLayoutEffect, useMemo, useRef, useState, Fragment, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  addDays,
  addMonths,
  daysInMonth,
  formatDate,
  MONTH_NAMES,
  monthOf,
  parseDateInput,
  today,
} from '../../model/dates';
import { formatMoney, moneyToInput, parseMoneyInput } from '../../model/money';
import type { ISODate, Money } from '../../model/types';
import { cx } from './Money';
import { Popover } from './overlay';

// ---- Money ---------------------------------------------------------------------------------

export type CommitHow = 'enter' | 'tab' | 'shifttab' | 'up' | 'down' | 'blur';

/**
 * A money box that understands maths ("120/4") and, with `relative`, edits that start with an
 * operator ("+25" adds to the current value, "-20" takes 20 off). Commits on Enter, Tab and blur.
 * With `gridNav`, arrow keys and Tab commit and report the direction instead of moving focus.
 */
export function MoneyInput({
  value,
  onCommit,
  onCancel,
  autoFocus,
  className,
  relative,
  placeholder,
  onKeyDown,
  gridNav,
  ariaLabel,
  initialText,
  choices,
  onInput,
}: {
  value: Money;
  onCommit: (v: Money, how: CommitHow) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  className?: string;
  relative?: boolean;
  placeholder?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  gridNav?: boolean;
  ariaLabel?: string;
  /** Start with this text instead of the value (typing a digit on a selected budget row). */
  initialText?: string;
  /** Amounts to pick from a drop-down (▾ or Alt+Down), like YNAB4's Quick Budget on a cell. */
  choices?: { label: string; amount: Money }[];
  /** The amount as it's being typed (null while it can't be read), before it's committed. */
  onInput?: (v: Money | null) => void;
}) {
  // In a box where "-20" takes 20 off, a negative amount is shown as "(50.00)": shown as
  // "-50.00", leaving the box would have taken another 50 off (1.5.10).
  const shown = (v: Money) => (relative && v < 0 ? `(${moneyToInput(-v)})` : moneyToInput(v));
  const [text, setText] = useState(initialText ?? shown(value));
  const [bad, setBad] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const done = useRef(false);
  const [listOpen, setListOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const pick = (v: Money) => {
    done.current = true;
    setListOpen(false);
    onCommit(v, 'enter');
  };
  useEffect(() => {
    if (initialText === undefined) {
      setText(shown(value));
      // A new amount from outside (a payee's auto-fill, say) replaces whatever couldn't be read.
      setBad(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus();
      if (initialText === undefined) ref.current.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);
  const read = (t: string): Money | null => {
    const was = shown(value);
    // Left as it was: the amount it was, whatever the box's maths would make of it.
    if (t === was) return value;
    // "(50.00)+10" adds to the amount there (-40), as "-50.00+10" did before 1.5.10; read as
    // typed, the brackets would only cover the 50 and make it 60 (1.5.11).
    const rest = t.startsWith(was) ? t.slice(was.length).trim() : '';
    if (relative && value < 0 && /^[-+*/]/.test(rest)) return parseMoneyInput(rest, value);
    return parseMoneyInput(t, relative ? value : undefined);
  };
  const commit = (how: CommitHow): boolean => {
    const v = read(text);
    if (v === null) {
      setBad(true);
      if (how === 'blur') onCancel?.();
      return false;
    }
    done.current = true;
    onCommit(v, how);
    return true;
  };
  const input = (
    <input
      ref={ref}
      className={cx('money-input', bad && 'bad', className)}
      value={text}
      placeholder={placeholder}
      aria-label={ariaLabel}
      inputMode="decimal"
      onChange={(e) => {
        setText(e.target.value);
        setBad(false);
        done.current = false;
        onInput?.(read(e.target.value));
      }}
      onFocus={() => {
        done.current = false;
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (choices?.length && e.altKey && e.key === 'ArrowDown') {
          e.preventDefault();
          setHi(0);
          setListOpen(true);
          return;
        }
        if (listOpen && choices?.length) {
          // The drop-down is open: arrows move in it and Enter picks (Esc closes it).
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setHi((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length);
            return;
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            pick(choices[hi].amount);
            return;
          }
        }
        if (e.key === 'Enter') {
          // In a form (the transaction editor) Enter also saves, so let it bubble; in the budget grid it doesn't.
          // An amount that can't be read stops it: the form mustn't save without it.
          if (!commit('enter') || gridNav) e.preventDefault();
        } else if (e.key === 'Tab') {
          if (gridNav) {
            e.preventDefault();
            commit(e.shiftKey ? 'shifttab' : 'tab');
          } else if (!commit(e.shiftKey ? 'shifttab' : 'tab')) e.preventDefault();
        } else if (gridNav && e.key === 'ArrowDown') {
          e.preventDefault();
          commit('down');
        } else if (gridNav && e.key === 'ArrowUp') {
          e.preventDefault();
          commit('up');
        } else if (e.key === 'Escape') {
          done.current = true;
          if (onCancel) {
            // The budget grid: Esc cancels this cell's edit, and nothing else.
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else {
            // In a dialog or the transaction editor: put the amount back, and let Esc close the
            // dialog or cancel the editor, as it does from any other box.
            setText(moneyToInput(value));
            setBad(false);
          }
        }
      }}
      onBlur={() => {
        if (!done.current) commit('blur');
      }}
    />
  );
  if (!choices?.length) return input;
  return (
    <span className="money-choices" ref={wrapRef}>
      <button
        type="button"
        className="mc-btn"
        tabIndex={-1}
        title="Quick budget (Alt+Down)"
        aria-label="Quick budget"
        // Keeps the focus (and the edit) in the box.
        onMouseDown={(e) => {
          e.preventDefault();
          setHi(0);
          setListOpen(!listOpen);
        }}
      >
        ▾
      </button>
      {input}
      {listOpen && (
        <Popover anchor={wrapRef.current} onClose={() => setListOpen(false)} align="right" autoFocus={false}>
          <div className="menu" role="listbox" aria-label="Quick budget">
            {choices.map((c, i) => (
              <button
                key={c.label}
                type="button"
                role="option"
                aria-selected={i === hi}
                className={cx('menu-item', i === hi && 'hi')}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c.amount);
                }}
              >
                <span className="mi-label">{c.label}</span>
                <span className="mi-key">{formatMoney(c.amount)}</span>
              </button>
            ))}
          </div>
        </Popover>
      )}
    </span>
  );
}

// ---- Date ----------------------------------------------------------------------------------

/**
 * A date box. Type in the budget's date format (missing parts come from the current value),
 * use Up/Down or +/- to move a day, or pick from the calendar.
 */
/** The date a YNAB4 date key jumps to from `base`, or null if `key` isn't one. */
function dateKey(key: string, base: ISODate): ISODate | null {
  const month = monthOf(base);
  const year = base.slice(0, 4);
  switch (key) {
    case 't':
    case 'T':
    case '.':
      return today();
    case 'm':
      return month + '-01';
    case 'M':
    case 'h':
    case 'H':
      return `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
    case 'y':
      return `${year}-01-01`;
    case 'Y':
      return `${year}-12-31`;
    default:
      return null;
  }
}

export function DateInput({
  value,
  onChange,
  autoFocus,
  className,
  onKeyDown,
  onBad,
}: {
  value: ISODate;
  onChange: (d: ISODate) => void;
  autoFocus?: boolean;
  className?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** Told when the box turns red (holds a date it can't read) and back. */
  onBad?: (bad: boolean) => void;
}) {
  const [text, setText] = useState(formatDate(value));
  const [bad, setBad] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    onBad?.(bad);
  }, [bad]);
  const [calAnchor, setCalAnchor] = useState<HTMLElement | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  // After a date key the new date is selected again, so the next key is a date key too.
  const reselect = useRef(false);
  useEffect(() => setText(formatDate(value)), [value]);
  useLayoutEffect(() => {
    if (reselect.current && ref.current === document.activeElement) ref.current?.select();
    reselect.current = false;
  });
  const apply = () => {
    const d = parseDateInput(text, value);
    if (!d) {
      setBad(true);
      return;
    }
    setBad(false);
    setText(formatDate(d));
    if (d !== value) onChange(d);
  };
  const step = (n: number) => {
    const base = parseDateInput(text, value) || value;
    const d = addDays(base, n);
    setText(formatDate(d));
    setBad(false);
    onChange(d);
    // Selected again, so "-" after "+" or an arrow still steps (1.5.11).
    reselect.current = true;
  };
  return (
    <span className={cx('date-input', className)}>
      <input
        ref={ref}
        className={cx('dt', bad && 'bad')}
        // What a short date ("31", "29/2") is read against, for a form that checks the box itself.
        data-base={value}
        value={text}
        autoFocus={autoFocus}
        aria-label="Date"
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={apply}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          // YNAB4's date keys, before anything is typed (the box selects its text on focus):
          // t or . today, m / M first / last of the month, y / Y first / last of the year.
          const el = e.currentTarget;
          const fresh = !el.value || (el.selectionStart === 0 && el.selectionEnd === el.value.length);
          const jump = fresh && !e.ctrlKey && !e.altKey ? dateKey(e.key, parseDateInput(text, value) || value) : null;
          if (jump) {
            e.preventDefault();
            setText(formatDate(jump));
            setBad(false);
            onChange(jump);
            el.select();
            reselect.current = true;
          } else if (e.key === 'Enter') apply();
          else if (e.key === 'ArrowUp' || e.key === '+' || e.key === '=') {
            e.preventDefault();
            step(1);
          } else if (e.key === 'ArrowDown' || (e.key === '-' && fresh)) {
            // "-" steps back only on the whole date: mid-typing it's "15-11-2026" (1.5.11).
            e.preventDefault();
            step(-1);
          }
        }}
      />
      <button
        type="button"
        className="icon-btn"
        tabIndex={-1}
        title="Pick a date"
        onClick={(e) => setCalAnchor(calAnchor ? null : e.currentTarget)}
      >
        <CalendarIcon />
      </button>
      {calAnchor && (
        <Popover anchor={calAnchor} onClose={() => setCalAnchor(null)} align="right" autoFocus={false}>
          <Calendar
            value={value}
            onPick={(d) => {
              setCalAnchor(null);
              setText(formatDate(d));
              setBad(false);
              onChange(d);
              ref.current?.focus();
            }}
          />
        </Popover>
      )}
    </span>
  );
}

function CalendarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="2" y="3" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" />
    </svg>
  );
}

export function Calendar({ value, onPick }: { value: ISODate; onPick: (d: ISODate) => void }) {
  const [month, setMonth] = useState(monthOf(value || today()));
  const first = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1, 1)).getUTCDay();
  // Weeks start on Monday.
  const lead = (first + 6) % 7;
  const cells: ISODate[] = [];
  const start = addDays(`${month}-01`, -lead);
  for (let i = 0; i < 42; i++) cells.push(addDays(start, i));
  const t = today();
  return (
    <div className="cal">
      <div className="cal-head">
        <button className="icon-btn" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month">
          ◀
        </button>
        <span>
          {MONTH_NAMES[+month.slice(5, 7) - 1]} {month.slice(0, 4)}
        </span>
        <button className="icon-btn" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month">
          ▶
        </button>
      </div>
      <div className="cal-grid">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <span key={i} className="dow">
            {d}
          </span>
        ))}
        {cells.slice(0, lead + daysInMonth(month) > 35 ? 42 : 35).map((d) => (
          <button
            key={d}
            className={cx(monthOf(d) !== month && 'other', d === t && 'today', d === value && 'sel')}
            onClick={() => onPick(d)}
          >
            {+d.slice(8, 10)}
          </button>
        ))}
      </div>
      <div style={{ textAlign: 'center', marginTop: 4 }}>
        <button className="link" onClick={() => onPick(t)}>
          Today
        </button>
      </div>
    </div>
  );
}

// ---- Autocomplete ---------------------------------------------------------------------------

export interface Option {
  value: string;
  label: string;
  group?: string;
  hint?: string;
  hintNeg?: boolean;
  disabled?: boolean;
  /** How often it's used: within each kind of match, more used options come first (payees). */
  rank?: number;
}

/**
 * A text box with a filtered drop-down list (payees, categories, accounts).
 * Matches words that start with what was typed first, then anything containing it.
 * With `allowFree`, text that matches nothing can be kept (e.g. a new payee).
 */
export function Autocomplete({
  value,
  options,
  onChange,
  placeholder,
  allowFree,
  autoFocus,
  className,
  onKeyDown,
  inputRef,
  freeLabel,
  ariaLabel,
  openOnFocus = true,
  pickOnBlur = true,
}: {
  value: string;
  options: Option[];
  onChange: (text: string, option?: Option) => void;
  placeholder?: string;
  allowFree?: boolean;
  autoFocus?: boolean;
  className?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  freeLabel?: (text: string) => string;
  ariaLabel?: string;
  openOnFocus?: boolean;
  /**
   * Leaving the box takes the best match, as in YNAB4's register. Off where a choice acts at once
   * on many rows (Move, Categorise): only Enter or a click chooses there (1.5.3).
   */
  pickOnBlur?: boolean;
}) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [typed, setTyped] = useState(false);
  const [navigated, setNavigated] = useState(false);
  const ownRef = useRef<HTMLInputElement>(null);
  const ref = inputRef || ownRef;
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);

  useEffect(() => {
    setText(value);
    setTyped(false);
  }, [value]);

  const filtered = useMemo(() => {
    const q = typed ? text.trim().toLowerCase() : '';
    let list = options.filter((o) => !o.disabled);
    if (q) {
      // Names that start with the text first (typing "te" finds Tesco before "Bank credit
      // BRITISH TELECOM"), then names with a word that starts with it, then the rest.
      const rank = (o: Option) => {
        const label = o.label.toLowerCase();
        if (label.startsWith(q)) return 0;
        if (label.split(/[\s:/(-]+/).some((w) => w.startsWith(q))) return 1;
        if (label.includes(q) || (o.group || '').toLowerCase().includes(q)) return 2;
        return 3;
      };
      const ranked = list.map((o) => [rank(o), o] as const).filter(([r]) => r < 3);
      // Within each, the most used first (a stable sort, so unranked lists keep their order).
      list = [0, 1, 2].flatMap((tier) =>
        ranked
          .filter(([r]) => r === tier)
          .map(([, o]) => o)
          .sort((x, y) => (y.rank ?? 0) - (x.rank ?? 0)),
      );
    }
    return list.slice(0, 300);
  }, [options, text, typed]);

  const showFree =
    allowFree && typed && text.trim() && !filtered.some((o) => o.label.toLowerCase() === text.trim().toLowerCase());
  const total = filtered.length + (showFree ? 1 : 0);

  useEffect(() => setHi(0), [text]);
  useEffect(() => {
    listRef.current?.querySelector('.ac-item.hi')?.scrollIntoView({ block: 'nearest' });
  }, [hi]);
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 10;
    const above = r.top - 10;
    const maxHeight = Math.min(320, Math.max(below, above));
    const top = below >= Math.min(220, maxHeight) || below >= above ? r.bottom + 2 : r.top - 2 - Math.min(maxHeight, listRef.current?.offsetHeight || maxHeight);
    setPos({ left: r.left, top, width: r.width, maxHeight });
  }, [open, filtered.length, ref]);

  const pick = (o?: Option) => {
    if (o) {
      setText(o.label);
      onChange(o.label, o);
    } else onChange(text.trim(), undefined);
    setOpen(false);
    setTyped(false);
    setNavigated(false);
  };

  return (
    <div className={cx('ac', className)}>
      <input
        ref={ref}
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        onFocus={(e) => {
          if (openOnFocus) setOpen(true);
          e.target.select();
        }}
        onChange={(e) => {
          setText(e.target.value);
          setTyped(true);
          setOpen(true);
        }}
        onBlur={() => {
          if (typed && !pickOnBlur) {
            setText(value);
            setTyped(false);
          } else if (typed) {
            const exact = options.find((o) => o.label.toLowerCase() === text.trim().toLowerCase());
            if (exact) pick(exact);
            else if (allowFree) pick(undefined);
            else if (filtered[0] && text.trim()) pick(filtered[0]);
            else if (!text.trim()) {
              onChange('', undefined);
              setTyped(false);
            } else {
              setText(value);
              setTyped(false);
            }
          }
          setOpen(false);
          setNavigated(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setNavigated(true);
            setHi((h) => Math.min(total - 1, h + 1));
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setNavigated(true);
            setHi((h) => Math.max(0, h - 1));
            return;
          }
          if ((e.key === 'Enter' || e.key === 'Tab') && typed && !navigated && !text.trim()) {
            // The box was cleared: it stays empty, as when it's left with the mouse. Every option
            // "matches" empty text, so picking would fill in the first one (1.5.3).
            onChange('', undefined);
            setOpen(false);
            setTyped(false);
            if (e.key === 'Enter') e.preventDefault();
          } else if ((e.key === 'Enter' || (e.key === 'Tab' && pickOnBlur)) && open && (typed || navigated)) {
            if (showFree && hi === filtered.length) pick(undefined);
            else if (filtered[hi]) pick(filtered[hi]);
            else if (allowFree) pick(undefined);
            if (e.key === 'Enter') e.preventDefault();
          } else if (e.key === 'Enter' && open) {
            setOpen(false);
          }
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            e.preventDefault();
            setOpen(false);
            setText(value);
            setTyped(false);
            return;
          }
          onKeyDown?.(e);
        }}
      />
      {open &&
        total > 0 &&
        pos &&
        createPortal(
          <div
            className="ac-list"
            ref={listRef}
            style={{ left: pos.left, top: pos.top, minWidth: Math.max(220, pos.width), maxHeight: pos.maxHeight }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {filtered.map((o, i) => (
              <Fragment key={o.value + ':' + i}>
                {o.group && (i === 0 || filtered[i - 1].group !== o.group) && <div className="ac-group">{o.group}</div>}
                <div className={cx('ac-item', i === hi && 'hi')} onMouseDown={() => pick(o)} onMouseEnter={() => setHi(i)}>
                  <span>{o.label}</span>
                  {o.hint && <span className={cx('ac-hint', o.hintNeg && 'neg')}>{o.hint}</span>}
                </div>
              </Fragment>
            ))}
            {showFree && (
              <div
                className={cx('ac-item', 'free', hi === filtered.length && 'hi')}
                onMouseDown={() => pick(undefined)}
                onMouseEnter={() => setHi(filtered.length)}
              >
                {freeLabel ? freeLabel(text.trim()) : `Create "${text.trim()}"`}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
