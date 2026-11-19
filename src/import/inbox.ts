import { daysBetween } from '../model/dates';
import type { Budget, Id, ISODate, Money } from '../model/types';
import { normalizeImportId, ynabImportId, type ParsedBankFile } from './bank';

// The import inbox (1.3.2): which account each bank file belongs to, how far each account has
// been imported, and whether the bank's balance agrees afterwards. Both budgets' downloads land
// in the same folder, so a file is only matched automatically on firm evidence, and never against
// what the file itself says about its account. Rules and measurements:
// docs/plans/1.3-smarter-import.md §9.

/** A bank file as the inbox sees it. */
export interface InboxFile {
  fileName: string;
  text: string;
  parsed: ParsedBankFile;
}

export interface AccountMatch {
  accountId?: Id;
  level: 'automatic' | 'suggested' | 'none';
  how: 'ofx-key' | 'digits' | 'overlap' | 'shape' | 'register' | 'none';
  /** Why, e.g. "bank account id", "card …1234", "31 of 42 rows already imported here". */
  reason: string;
  /** The file names an account or card not linked to this budget. */
  foreign?: string;
}

/** A digit run that is a date, a date and time, or a year, never an account number. */
function isDateRun(d: string): boolean {
  return (
    /^(19|20)\d{2}$/.test(d) ||
    (d.length === 8 && (/^20\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(d) || /^(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])20\d{2}$/.test(d))) ||
    ((d.length === 12 || d.length === 14) && /^20\d{2}(0[1-9]|1[0-2])/.test(d))
  );
}

/**
 * What identifies a file's account, besides an OFX key: card digits in the file ("card:1234",
 * from memos like "1234/ …", masked numbers or the OFX account id) and other digit runs in the
 * file name ("name:1234"). Only ever the last 4 digits.
 */
export function fileTokens(f: InboxFile): string[] {
  const out = new Set<string>();
  for (const run of f.fileName.match(/\d{4,}/g) || []) if (!isDateRun(run)) out.add('name:' + run.slice(-4));
  const memoDigits = new Map<string, number>();
  for (const t of f.parsed.txns) {
    const m = /^(\d{4})\/\s/.exec(t.memo);
    if (m) memoDigits.set(m[1], (memoDigits.get(m[1]) || 0) + 1);
  }
  for (const [d, n] of memoDigits) if (n >= Math.max(2, f.parsed.txns.length * 0.5)) out.add('card:' + d);
  for (const m of new Set(f.text.match(/\*{4,}(\d{4})\b/g) || [])) out.add('card:' + m.slice(-4));
  const tail = f.parsed.accountKey ? /(\d{4})$/.exec(f.parsed.accountKey) : null;
  if (tail) out.add('card:' + tail[1]);
  return [...out];
}

/** A file name's shape, for files that say nothing else: "statements#.qif", "activity.qif". */
export function fileShape(fileName: string): string {
  return 'shape:' + fileName.toLowerCase().replace(/\s*\(\d+\)(?=\.[a-z]+$)/, '').replace(/\d+/g, '#');
}

/** A CSV file's header row, as a key. */
function csvKey(f: InboxFile): string | null {
  if (f.parsed.kind !== 'csv') return null;
  const first = f.text.replace(/^﻿/, '').split(/\r?\n/)[0]?.trim().toLowerCase();
  return first && !/\d{2}[/.-]\d{2}/.test(first) ? 'csv:' + first : null;
}

/** The file's import ids, as planImport makes them. */
function importIdsOf(p: ParsedBankFile): string[] {
  const seen = new Map<string, number>();
  return p.txns.map((s) => {
    const amount = s.fileAmount ?? s.amount;
    const k = s.date + ':' + amount;
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    return s.fitid ? 'FITID:' + s.fitid : normalizeImportId(ynabImportId({ date: s.date, amount }, n));
  });
}

const last4 = (t: string) => '…' + t.slice(t.indexOf(':') + 1);

/**
 * The account holding most of a file's rows, given how many each holds: at least 3 rows (or all
 * of a smaller file), at least 20% of the file, and a clear winner, since a row or two can share
 * a date and amount with another account's by chance.
 */
function clearWinner(hits: Map<Id, number>, rows: number): [Id, number] | null {
  const [top, second] = [...hits.entries()].sort((x, y) => y[1] - x[1]);
  return top && (!second || top[1] >= 4 * second[1]) && top[1] >= Math.min(3, rows) && top[1] >= 0.2 * rows ? top : null;
}

/**
 * Which account a file belongs to. Automatic: the OFX account is linked to an account here, or
 * the file's card or account digits are linked to exactly one. Suggested: its rows were mostly
 * imported into one account already, its name looks like earlier downloads into one account, or
 * it was opened from that account's register. Never against the file's own OFX account or card.
 */
export function matchFileToAccount(b: Budget, f: InboxFile, fromRegister?: Id): AccountMatch {
  const accounts = Object.values(b.accounts);
  const key = f.parsed.accountKey;
  if (key) {
    const a = accounts.find((x) => x.importKeys?.includes(key));
    if (a) return { accountId: a.id, level: 'automatic', how: 'ofx-key', reason: 'bank account id' };
  }
  const tokens = fileTokens(f);
  const cards = tokens.filter((t) => t.startsWith('card:'));
  const unknownOfx = !!key;
  // The file's own identity contradicts what this account has shown before.
  const conflict = (id: Id) => {
    const keys = b.accounts[id]?.importKeys ?? [];
    const ofx = keys.filter((k) => k.startsWith('ofx:'));
    if (key && ofx.length && !ofx.includes(key)) return true;
    const known = keys.filter((k) => k.startsWith('card:'));
    return cards.length > 0 && known.length > 0 && !cards.some((c) => known.includes(c));
  };
  if (!unknownOfx) {
    const owners = new Set<Id>();
    let shown = '';
    for (const t of tokens) {
      for (const a of accounts) {
        if (a.importKeys?.includes(t)) {
          owners.add(a.id);
          shown = t;
        }
      }
    }
    if (owners.size === 1) {
      const [id] = owners;
      return { accountId: id, level: 'automatic', how: 'digits', reason: (shown.startsWith('card:') ? 'card ' : 'account ') + last4(shown) };
    }
  }
  // Rows already imported: a clear winner among the accounts holding them (clearWinner).
  const ids = importIdsOf(f.parsed);
  if (ids.length) {
    const want = new Set(ids);
    const hits = new Map<Id, number>();
    for (const t of Object.values(b.transactions)) {
      for (const id of t.importIds ?? []) {
        if (want.has(normalizeImportId(id))) {
          hits.set(t.accountId, (hits.get(t.accountId) || 0) + 1);
          break;
        }
      }
    }
    const top = clearWinner(hits, ids.length);
    if (top && !conflict(top[0])) {
      return { accountId: top[0], level: 'suggested', how: 'overlap', reason: `${top[1]} of ${ids.length} rows already imported here` };
    }
  }
  if (!unknownOfx) {
    for (const k of [fileShape(f.fileName), csvKey(f)]) {
      if (!k) continue;
      const owners = accounts.filter((a) => a.importKeys?.includes(k));
      if (owners.length === 1 && !conflict(owners[0].id)) {
        return { accountId: owners[0].id, level: 'suggested', how: 'shape', reason: k.startsWith('csv:') ? 'the same columns as earlier files' : 'file name like earlier downloads' };
      }
    }
  }
  // The file names its own account or card, and nothing here has it. Only once this budget has
  // learned some bank accounts (or cards) can that mean "not in this budget": before its first
  // import (a budget converted from YNAB4, say) every file's account is unknown.
  const learned = (kind: string) => accounts.some((a) => a.importKeys?.some((k) => k.startsWith(kind)));
  const foreign = unknownOfx
    ? learned('ofx:')
      ? 'bank account …' + key!.slice(-4)
      : undefined
    : cards.length && learned('card:') && !accounts.some((a) => cards.some((c) => a.importKeys?.includes(c)))
      ? 'card ' + last4(cards[0])
      : undefined;
  if (fromRegister && b.accounts[fromRegister] && !foreign && !conflict(fromRegister)) {
    return { accountId: fromRegister, level: 'suggested', how: 'register', reason: 'opened from this account' };
  }
  const firstTime = !accounts.some((a) => a.importKeys?.length);
  return {
    level: 'none',
    how: 'none',
    reason: foreign ? 'not linked to an account here' : firstTime ? 'first import here: choose the account (it is remembered)' : 'choose an account',
    ...(foreign ? { foreign } : {}),
  };
}

/**
 * Learns from a file imported into an account (call in the same edit as applyImport): its OFX
 * key and digits (unique to one account, so taken off any other), its name shape and CSV header
 * (shared ones simply stop suggesting), and how far the account has now been imported.
 */
export function recordImport(b: Budget, accountId: Id, f: InboxFile, now = new Date().toISOString(), learn = true): void {
  const acc = b.accounts[accountId];
  if (!acc) return;
  // Without `learn` (the account only came from the register it was opened from, and you
  // didn't ask to remember it), just how far the account has been imported.
  if (learn) learnKeys(b, accountId, f);
  const lastDate = f.parsed.txns.reduce((m, t) => (t.date > m ? t.date : m), '');
  if (lastDate && (!acc.lastImport || lastDate > acc.lastImport.to)) acc.lastImport = { to: lastDate, at: now };
  else if (acc.lastImport) acc.lastImport = { ...acc.lastImport, at: now };
}

/** What an import of a file teaches its account: keys unique to one account, and shared ones. */
function keysOf(f: InboxFile): { unique: string[]; shared: string[] } {
  return {
    unique: [...(f.parsed.accountKey ? [f.parsed.accountKey] : []), ...fileTokens(f)],
    shared: [fileShape(f.fileName), csvKey(f)].filter((k): k is string => !!k),
  };
}

/** One old bank file, for "Learn accounts from old bank files" (1.4.4). */
export interface LearnPlan {
  fileName: string;
  /** The account its rows are already in. Unset when they aren't clearly in one. */
  accountId?: Id;
  /** Why, e.g. "31 of 42 rows already imported here", or why it can't be learned from. */
  reason: string;
  /** The keys it would add to that account; none when it can't be learned from or adds nothing. */
  keys: string[];
}

/**
 * For bank files downloaded before the switch from YNAB4: which account each file's rows are
 * already in (the "rows already imported here" rule, nothing weaker) and what an import of it
 * would teach that account, so the first real import picks the accounts by itself. A file is
 * left alone when its rows are in a closed account or in no clear one, or when its account or
 * card numbers already belong to another account. A number that other chosen files show
 * elsewhere is left out. Nothing in the budget changes until applyLearnPlans.
 */
export function planLearnAccounts(b: Budget, files: InboxFile[]): LearnPlan[] {
  // Every account that holds each import id: a bank's ids can repeat between accounts (Nationwide's
  // do), and then a row counts for each of them, as in matchFileToAccount.
  const where = new Map<string, Set<Id>>();
  for (const t of Object.values(b.transactions)) {
    for (const id of t.importIds ?? []) {
      const k = normalizeImportId(id);
      const s = where.get(k);
      if (s) s.add(t.accountId);
      else where.set(k, new Set([t.accountId]));
    }
  }
  const owner = (k: string) => Object.values(b.accounts).find((a) => a.importKeys?.includes(k));
  const plans = files.map((f): LearnPlan & { unique: string[]; hit: boolean } => {
    const none = (reason: string, accountId?: Id, hit = !!accountId) => ({ fileName: f.fileName, accountId, reason, keys: [], unique: [], hit });
    const ids = importIdsOf(f.parsed);
    if (!ids.length) return none('no transactions in it');
    const hits = new Map<Id, number>();
    for (const id of ids) for (const a of where.get(id) ?? []) hits.set(a, (hits.get(a) || 0) + 1);
    const top = clearWinner(hits, ids.length);
    if (!top) return none(hits.size ? 'its rows are not clearly in one account' : 'none of its rows are in this budget', undefined, hits.size > 0);
    const [accountId, n] = top;
    const acc = b.accounts[accountId];
    if (acc.closed) return none(`its rows are in ${acc.name}, which is closed`, accountId);
    // A row or two could be chance, and what's learned makes later files automatic.
    if (n < 3) return none('too few of its rows are here to be sure', accountId);
    const { unique, shared } = keysOf(f);
    const taken = unique.map(owner).find((a) => a && a.id !== accountId);
    if (taken) return none(`its numbers already belong to ${taken.name}`, accountId);
    const keys = [...unique, ...shared].filter((k) => !acc.importKeys?.includes(k));
    return { fileName: f.fileName, accountId, reason: keys.length ? `${n} of ${ids.length} rows already imported here` : 'already known', keys, unique, hit: true };
  });
  // A key (a number, or a file name's shape or CSV header) is learned only if every chosen file
  // that has it belongs to the same account. One clearly in another account, one whose rows are
  // split between accounts, or one this budget should already have imported (it starts before the
  // account's last import) but hasn't, means another account has had it too. Some old downloads
  // were imported into both budgets, and a bank can move an account number. Files newer than the
  // account's last import just haven't been imported yet.
  const holders = new Map<string, number[]>();
  files.forEach((f, i) => {
    const { unique, shared } = keysOf(f);
    for (const k of [...unique, ...shared]) holders.set(k, [...(holders.get(k) ?? []), i]);
  });
  const firstDate = files.map((f) => f.parsed.txns.reduce((m, t) => (!m || t.date < m ? t.date : m), ''));
  const upTo = new Map<Id, string>();
  const importedTo = (id: Id) => upTo.get(id) ?? upTo.set(id, lastImported(b, id) ?? '').get(id)!;
  // A file none of whose ids are in the budget can still be this account's: imported from another
  // format of the same download. Then most of its amounts are in this account within 3 days (a
  // card's purchase and posting dates differ), and it doesn't count against the key.
  const byAmount = new Map<Id, Map<Money, ISODate[]>>();
  const datesOf = (id: Id, amount: Money) => {
    let m = byAmount.get(id);
    if (!m) {
      byAmount.set(id, (m = new Map()));
      for (const t of Object.values(b.transactions)) if (t.accountId === id) m.set(t.amount, [...(m.get(t.amount) ?? []), t.date]);
    }
    return m.get(amount) ?? [];
  };
  const looksLike = (f: InboxFile, id: Id) => {
    const n = f.parsed.txns.filter((t) => datesOf(id, t.amount).some((d) => Math.abs(daysBetween(d, t.date)) <= 3)).length;
    return n >= Math.min(3, f.parsed.txns.length) && n >= 0.5 * f.parsed.txns.length;
  };
  const against = (j: number, accountId: Id) => {
    const p = plans[j];
    if (p.accountId) return p.accountId !== accountId;
    if (p.hit) return true;
    return firstDate[j] <= importedTo(accountId) && !looksLike(files[j], accountId);
  };
  return plans.map(({ fileName, accountId, reason, keys, unique }) => {
    const left = keys.filter((k) => !(holders.get(k) ?? []).some((j) => against(j, accountId!)));
    if (left.length === keys.length) return { fileName, accountId, reason, keys };
    // When its numbers are left out, its file name's shape isn't learned on its own either.
    const numbers = keys.some((k) => unique.includes(k));
    const keep = numbers ? left.some((k) => unique.includes(k)) : left.length > 0;
    return { fileName, accountId, reason: keep ? reason : "other files with its numbers or name aren't this account's (the other budget's?)", keys: keep ? left : [] };
  });
}

/** Adds each planned file's keys to its account (planLearnAccounts made sure no other has them). Returns how many files taught something. */
export function applyLearnPlans(b: Budget, plans: LearnPlan[]): number {
  let n = 0;
  for (const p of plans) {
    const acc = p.accountId ? b.accounts[p.accountId] : undefined;
    if (!acc || !p.keys.length) continue;
    acc.importKeys = Array.from(new Set([...(acc.importKeys || []), ...p.keys]));
    n++;
  }
  return n;
}

function learnKeys(b: Budget, accountId: Id, f: InboxFile): void {
  const acc = b.accounts[accountId];
  const { unique, shared } = keysOf(f);
  acc.importKeys = Array.from(new Set([...(acc.importKeys || []), ...unique, ...shared]));
  for (const other of Object.values(b.accounts)) {
    if (other.id === accountId || !other.importKeys) continue;
    const left = other.importKeys.filter((k) => !unique.includes(k));
    if (left.length !== other.importKeys.length) other.importKeys = left;
  }
}

/** The latest bank date imported into an account: as recorded, or else its newest imported transaction. */
export function lastImported(b: Budget, accountId: Id): ISODate | null {
  const recorded = b.accounts[accountId]?.lastImport?.to;
  let newest = '';
  for (const t of Object.values(b.transactions)) if (t.accountId === accountId && t.importIds?.length && t.date > newest) newest = t.date;
  const best = recorded && recorded > newest ? recorded : newest;
  return best || null;
}

/**
 * After an OFX import: the bank's balance against the register's, both at the file's last
 * transaction date (the file's own balance date is unreliable). Null without a balance.
 */
export function balanceCheck(b: Budget, accountId: Id, f: { balance?: Money; lastDate: ISODate }): { date: ISODate; bank: Money; register: Money; difference: Money } | null {
  if (f.balance === undefined || !f.lastDate) return null;
  let register = 0;
  for (const t of Object.values(b.transactions)) if (t.accountId === accountId && t.date <= f.lastDate) register += t.amount;
  return { date: f.lastDate, bank: f.balance, register, difference: register - f.balance };
}
