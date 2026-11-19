import { parseDateInput } from './dates';
import { parseMoneyInput } from './money';
import { categoryLabel, payeeName } from './queries';
import { SPLIT, type Budget, type Transaction } from './types';

// The register's search (1.5). Plain text matches the payee (or the bank's text), category, memo,
// account or cheque number, or an amount. As in YNAB4, "Payee:", "Category:", "Memo:" and
// "Account:" look in that one field only, and can be combined: "payee: tesco memo: milk".
// YNAB4's other filters too (1.5.2): "Is: uncleared" (cleared, reconciled, unreconciled,
// approved, unapproved, flagged, unflagged, or the start of one), "Inflow:" / "Outflow:" (alone,
// or with an amount), "Before:", "After:", "On:" (a date) and "Check:" (a cheque number).

export type SearchField = 'payee' | 'category' | 'memo' | 'account' | 'is' | 'inflow' | 'outflow' | 'before' | 'after' | 'on' | 'check';

export interface ParsedSearch {
  /** Text before any field, matched anywhere (lower case). */
  text: string;
  /** Each field's text (lower case). */
  fields: { field: SearchField; text: string }[];
}

const FIELD_RE = /(^|\s)(payee|category|memo|account|is|inflow|outflow|before|after|on|check):/gi;
/** "Is:" words, in the order a start of one is read ("un" is uncleared). */
const IS_WORDS = ['uncleared', 'cleared', 'reconciled', 'unreconciled', 'unapproved', 'approved', 'flagged', 'unflagged'] as const;

export function parseSearch(input: string): ParsedSearch {
  const q = input.trim().toLowerCase();
  const marks = [...q.matchAll(FIELD_RE)];
  if (!marks.length) return { text: q, fields: [] };
  const fields: ParsedSearch['fields'] = [];
  const plain = [q.slice(0, marks[0].index).trim()];
  marks.forEach((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index! : q.length;
    const text = q.slice(start, end).trim();
    const field = m[2] as SearchField;
    if (field === 'is') {
      const words = text.split(/\s+/).filter(Boolean);
      const known = words.filter((w) => IS_WORDS.some((x) => x.startsWith(w)));
      if (known.length) fields.push({ field, text: known.join(' ') });
      const rest = known.length ? words.filter((w) => !known.includes(w)) : words;
      if (!known.length) plain.push(m[0].trim());
      plain.push(rest.join(' '));
      return;
    }
    const readable =
      field === 'before' || field === 'after' || field === 'on'
        ? !!parseDateInput(text)
        : field === 'inflow' || field === 'outflow'
          ? !text || searchAmount(text) !== null
          : !!text;
    if (readable) fields.push({ field, text });
    // An empty field (still being typed) is left out; one that can't be read is plain text.
    else if (text) plain.push(`${m[0].trim()} ${text}`);
  });
  return { text: plain.filter(Boolean).join(' ').trim(), fields };
}

/** An amount typed as the whole search ("12.50", "£1,250"), or null. */
export function searchAmount(text: string): number | null {
  return text && /^[£$€]?-?[\d,]*\.?\d+$/.test(text) ? parseMoneyInput(text.replace(/^[£$€]/, '')) : null;
}

/** Text that a plain search can match: payee, category, memo, account, cheque number. */
export function searchText(b: Budget, t: Transaction): string {
  const parts = [payeeName(b, t), t.importedPayee || '', t.memo || '', t.check || '', b.accounts[t.accountId]?.name || ''];
  if (t.categoryId === SPLIT)
    for (const s of t.splits || []) parts.push(payeeName(b, s), categoryLabel(b, s.categoryId, t.date), s.memo || '');
  else parts.push(categoryLabel(b, t.categoryId, t.date));
  return parts.join('\u0001').toLowerCase();
}

function fieldText(b: Budget, t: Transaction, field: SearchField): string {
  const splits = t.categoryId === SPLIT ? t.splits || [] : [];
  const parts =
    field === 'payee'
      ? [payeeName(b, t), t.importedPayee || '', ...splits.map((s) => payeeName(b, s))]
      : field === 'category'
        ? splits.length
          ? splits.map((s) => categoryLabel(b, s.categoryId, t.date))
          : [categoryLabel(b, t.categoryId, t.date)]
        : field === 'memo'
          ? [t.memo || '', ...splits.map((s) => s.memo || '')]
          : [b.accounts[t.accountId]?.name || ''];
  return parts.join('\u0001').toLowerCase();
}

function isWord(t: Transaction, word: string): boolean {
  switch (IS_WORDS.find((w) => w.startsWith(word))) {
    case 'uncleared':
      return t.cleared === 'U';
    case 'cleared':
      return t.cleared !== 'U';
    case 'reconciled':
      return t.cleared === 'R';
    case 'unreconciled':
      return t.cleared !== 'R';
    case 'unapproved':
      return !t.accepted;
    case 'approved':
      return !!t.accepted;
    case 'flagged':
      return !!t.flag;
    case 'unflagged':
      return !t.flag;
    default:
      return false;
  }
}

function fieldMatches(b: Budget, t: Transaction, f: { field: SearchField; text: string }): boolean {
  switch (f.field) {
    case 'is':
      return f.text.split(/\s+/).every((w) => isWord(t, w));
    case 'inflow':
    case 'outflow': {
      if (f.field === 'inflow' ? t.amount <= 0 : t.amount >= 0) return false;
      if (!f.text) return true;
      const a = searchAmount(f.text);
      return a !== null && Math.abs(t.amount) === Math.abs(a);
    }
    case 'before':
    case 'after':
    case 'on': {
      const d = parseDateInput(f.text);
      if (!d) return false;
      return f.field === 'before' ? t.date < d : f.field === 'after' ? t.date > d : t.date === d;
    }
    case 'check':
      return (t.check || '').toLowerCase().includes(f.text);
    default:
      return fieldText(b, t, f.field).includes(f.text);
  }
}

/** Whether a transaction matches a search; `amount` is searchAmount() of its plain text. */
export function matchesSearch(b: Budget, t: Transaction, s: ParsedSearch, amount: number | null): boolean {
  for (const f of s.fields) if (!fieldMatches(b, t, f)) return false;
  if (!s.text) return true;
  if (amount !== null && amount !== 0) {
    if (Math.abs(t.amount) === Math.abs(amount)) return true;
    if (t.splits?.some((x) => Math.abs(x.amount) === Math.abs(amount))) return true;
  }
  return searchText(b, t).includes(s.text);
}
