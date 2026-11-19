import { normalizeImportId } from '../import/bank';
import { monthOf, today, isISODate } from './dates';
import { newId } from './ids';
import { textKey } from './merchant';
import { findPayeeByName, transferNeedsCategory, transferPayeeId, transferPayeeName } from './queries';
import { nextScheduledDate } from './schedule';
import {
  INCOME_NOW,
  SPLIT,
  type Account,
  type AccountType,
  type Budget,
  type Cleared,
  type DeletedImport,
  type Flag,
  type Id,
  type ISODate,
  type Money,
  type MonthKey,
  type OverspendingHandling,
  type Payee,
  type PayeeRule,
  type ScheduledTransaction,
  type Split,
  type Transaction,
} from './types';

// Every change to a budget goes through these functions. They mutate a draft
// (the store wraps them in an immer producer, which also records undo).

// ---- Payees -------------------------------------------------------------------

/** The id of the payee with this name, creating it if needed. Unhides a hidden payee. */
export function ensurePayee(b: Budget, name: string): Id | undefined {
  const n = name.trim();
  if (!n) return undefined;
  const existing = findPayeeByName(b, n);
  if (existing) {
    if (existing.hidden) delete existing.hidden;
    return existing.id;
  }
  const id = newId();
  b.payees[id] = { id, name: n, rules: [] };
  return id;
}

/** The "Transfer : <account>" payee for an account, creating it if needed. */
export function ensureTransferPayee(b: Budget, accountId: Id): Payee {
  const id = transferPayeeId(accountId);
  if (!b.payees[id]) {
    b.payees[id] = { id, name: transferPayeeName(b, accountId), rules: [], transferAccountId: accountId };
  }
  return b.payees[id];
}

export function renamePayee(b: Budget, payeeId: Id, name: string): void {
  const p = b.payees[payeeId];
  if (!p || p.transferAccountId) return;
  const n = name.trim();
  if (n) p.name = n;
}

export function setPayeeRules(b: Budget, payeeId: Id, rules: PayeeRule[]): void {
  const p = b.payees[payeeId];
  if (p) p.rules = rules.filter((r) => r.text.trim()).map((r) => ({ op: r.op, text: r.text.trim() }));
}

export function setPayeeAutoFill(
  b: Budget,
  payeeId: Id,
  fill: { categoryId?: Id | null; memo?: string | null; amount?: Money | null },
): void {
  const p = b.payees[payeeId];
  if (!p) return;
  if ('categoryId' in fill) p.autoCategoryId = fill.categoryId ?? null;
  if ('memo' in fill) p.autoMemo = fill.memo || null;
  if ('amount' in fill) p.autoAmount = fill.amount ?? null;
}

export function setPayeeHidden(b: Budget, payeeId: Id, hidden: boolean): void {
  const p = b.payees[payeeId];
  if (!p) return;
  if (hidden) p.hidden = true;
  else delete p.hidden;
}

/** Deletes payees that no transaction or scheduled transaction uses. Returns how many. */
export function deleteUnusedPayees(b: Budget, ids: Id[]): number {
  const used = new Set<Id>();
  for (const t of Object.values(b.transactions)) {
    if (t.payeeId) used.add(t.payeeId);
    for (const s of t.splits || []) if (s.payeeId) used.add(s.payeeId);
  }
  for (const s of Object.values(b.scheduled)) if (s.payeeId) used.add(s.payeeId);
  let n = 0;
  for (const id of ids) {
    const p = b.payees[id];
    if (p && !p.transferAccountId && !used.has(id)) {
      delete b.payees[id];
      n++;
    }
  }
  return n;
}

/**
 * Combines payees into `targetId`. Transactions move to the target, and the old names
 * become "is" rename rules so future imports are renamed too.
 */
export function mergePayees(b: Budget, ids: Id[], targetId: Id, opts: { learnTexts?: boolean } = {}): void {
  const target = b.payees[targetId];
  if (!target) return;
  const gone = new Set(ids.filter((i) => i !== targetId && b.payees[i] && !b.payees[i].transferAccountId));
  // With learnTexts (1.3.1): each absorbed payee's bank texts, and whether its name is one of them.
  const texts = new Map<Id, Set<string>>();
  const named = new Set<Id>();
  const cats = new Map<Id, number>();
  for (const t of Object.values(b.transactions)) {
    if (!t.payeeId || !(gone.has(t.payeeId) || t.payeeId === targetId)) continue;
    if (t.categoryId && t.categoryId !== SPLIT) cats.set(t.categoryId, (cats.get(t.categoryId) || 0) + 1);
    if (!opts.learnTexts || !t.importedPayee || !gone.has(t.payeeId)) continue;
    let set = texts.get(t.payeeId);
    if (!set) texts.set(t.payeeId, (set = new Set()));
    set.add(textKey(t.importedPayee, t.amount));
    const name = b.payees[t.payeeId].name.replace(/\s{2,}/g, ' ').trim().toLowerCase();
    if (name === t.importedPayee.replace(/\s{2,}/g, ' ').trim().toLowerCase()) named.add(t.payeeId);
  }
  for (const t of Object.values(b.transactions)) {
    if (t.payeeId && gone.has(t.payeeId)) t.payeeId = targetId;
    for (const s of t.splits || []) if (s.payeeId && gone.has(s.payeeId)) s.payeeId = targetId;
  }
  for (const s of Object.values(b.scheduled)) if (s.payeeId && gone.has(s.payeeId)) s.payeeId = targetId;
  const learned = new Set(target.bankTexts ?? []);
  for (const id of gone) {
    const p = b.payees[id];
    // A name that is just the bank's text is remembered as a learned text, not a rename rule;
    // a name you typed becomes a rule, as before.
    if (opts.learnTexts && named.has(id)) {
      for (const t of texts.get(id) ?? []) learned.add(t);
    } else {
      target.rules.push({ op: 'is', text: p.name });
      if (opts.learnTexts) for (const t of texts.get(id) ?? []) learned.add(t);
    }
    target.rules.push(...p.rules);
    for (const t of p.bankTexts ?? []) learned.add(t);
    if (!target.autoCategoryId && p.autoCategoryId) target.autoCategoryId = p.autoCategoryId;
    delete b.payees[id];
  }
  if (learned.size) target.bankTexts = [...learned].sort();
  // With learned texts, a payee with no remembered category takes the group's most used one.
  if (opts.learnTexts && !target.autoCategoryId && cats.size) {
    target.autoCategoryId = [...cats.entries()].sort((x, y) => y[1] - x[1])[0][0];
  }
  const seen = new Set<string>();
  target.rules = target.rules.filter((r) => {
    const key = r.op + '|' + r.text.toLowerCase();
    // An "is" rule for the target's own name is redundant; other rules with that text (e.g. "contains") are not.
    if (seen.has(key) || (r.op === 'is' && r.text.toLowerCase() === target.name.toLowerCase())) return false;
    seen.add(key);
    return true;
  });
}

// ---- Transactions -----------------------------------------------------------------

export interface TransactionInput {
  /** Leave out to add a new transaction. */
  id?: Id;
  accountId: Id;
  date: ISODate;
  payeeId?: Id;
  /** Used (and the payee created) when payeeId is not given. */
  payeeName?: string;
  transferAccountId?: Id;
  categoryId?: Id | null;
  memo?: string;
  amount: Money;
  cleared: Cleared;
  flag?: Flag;
  check?: string;
  accepted?: boolean;
  importIds?: string[];
  importedPayee?: string;
  splits?: Split[];
  scheduleId?: Id;
}

/**
 * Adds or updates a transaction. Keeps transfer pairs in step: a transfer creates or
 * updates the matching transaction in the other account, including transfers on split
 * lines. Also remembers the payee's category, amount and memo for next time.
 * Returns the transaction's id.
 */
export function saveTransaction(b: Budget, input: TransactionInput): Id {
  const id = input.id || newId();
  const prev = input.id ? b.transactions[input.id] : undefined;
  // The far side of a split-line transfer belongs to its split line: its account, and the
  // account it's a transfer from, can only change there.
  if (prev?.transferSplitParentId && b.transactions[prev.transferSplitParentId]) {
    input = { ...input, accountId: prev.accountId, transferAccountId: prev.transferAccountId, categoryId: input.categoryId === SPLIT ? null : input.categoryId, splits: undefined };
  }
  const isSplit = input.categoryId === SPLIT && !!input.splits && input.splits.length > 0;
  const t: Transaction = {
    ...(prev || ({} as Transaction)),
    id,
    accountId: input.accountId,
    date: input.date,
    memo: input.memo || undefined,
    amount: input.amount,
    cleared: input.cleared,
    flag: input.flag,
    check: input.check || undefined,
    accepted: input.accepted ?? prev?.accepted ?? true,
    categoryId: null,
  };
  if (!t.memo) delete t.memo;
  if (!t.flag) delete t.flag;
  if (!t.check) delete t.check;
  if (input.importIds) t.importIds = input.importIds;
  if (input.importedPayee) t.importedPayee = input.importedPayee;
  if (input.scheduleId) t.scheduleId = input.scheduleId;
  if (t.accepted) delete t.matched;
  // A waiting bank match put in another account is settled, as a move settles it: Unmatch would
  // otherwise add the bank's row to the new account.
  if (prev && prev.accountId !== t.accountId) delete t.matched;

  if (input.transferAccountId && input.transferAccountId !== input.accountId) {
    t.transferAccountId = input.transferAccountId;
    t.payeeId = ensureTransferPayee(b, input.transferAccountId).id;
  } else {
    delete t.transferAccountId;
    t.payeeId = input.payeeId || (input.payeeName ? ensurePayee(b, input.payeeName) : undefined);
    if (!t.payeeId) delete t.payeeId;
  }

  if (isSplit) {
    t.categoryId = SPLIT;
    t.splits = input.splits!.map((s) => ({ ...s, id: s.id || newId() }));
  } else {
    delete t.splits;
    if (t.transferAccountId) {
      t.categoryId = transferNeedsCategory(b, t.accountId, t.transferAccountId) ? (input.categoryId ?? null) : null;
    } else {
      t.categoryId = input.categoryId ?? null;
    }
  }

  // Split lines that were transfers but no longer are: remove their paired transactions.
  if (prev?.splits) {
    for (const old of prev.splits) {
      if (
        old.transferTxId &&
        !(t.splits || []).some((s) => s.id === old.id && s.transferAccountId === old.transferAccountId)
      ) {
        removeTransaction(b, old.transferTxId);
      }
    }
  }

  // A plain transfer that changed account (or stopped being a transfer): remove the old pair.
  if (
    prev?.transferTxId &&
    !prev.transferSplitParentId &&
    (prev.transferAccountId !== t.transferAccountId || !t.transferAccountId)
  ) {
    removeTransaction(b, prev.transferTxId);
    delete t.transferTxId;
  }

  // A transfer that came from YNAB4 without its other side (that side wasn't there to convert)
  // stays as it is when edited: making one now would change the other account's balance (1.5.3).
  const oneSided = !!prev && prev.transferAccountId === t.transferAccountId && !prev.transferTxId && !prev.transferSplitParentId;
  if (t.transferAccountId && !t.transferSplitParentId && !oneSided) {
    // Create or update the other half of the transfer.
    const peerId = t.transferTxId && b.transactions[t.transferTxId] ? t.transferTxId : newId();
    const old = b.transactions[peerId];
    const peer: Transaction = {
      ...(old || { cleared: 'U' as Cleared, accepted: true }),
      id: peerId,
      accountId: t.transferAccountId,
      date: t.date,
      amount: -t.amount,
      memo: t.memo,
      transferAccountId: t.accountId,
      transferTxId: id,
      payeeId: ensureTransferPayee(b, t.accountId).id,
      categoryId: transferNeedsCategory(b, t.transferAccountId, t.accountId) ? (old?.categoryId ?? null) : null,
    } as Transaction;
    if (!peer.memo) delete peer.memo;
    delete peer.splits;
    b.transactions[peerId] = peer;
    t.transferTxId = peerId;
  } else if (t.transferSplitParentId) {
    // This is the far side of a split-line transfer: update that split line and its parent.
    const parent = b.transactions[t.transferSplitParentId];
    const line = parent?.splits?.find((s) => s.transferTxId === id);
    if (parent && line) {
      line.amount = -t.amount;
      parent.amount = parent.splits!.reduce((sum, s) => sum + s.amount, 0);
      if (parent.date !== t.date) {
        parent.date = t.date;
        for (const s of parent.splits!) {
          if (s.transferTxId && b.transactions[s.transferTxId]) b.transactions[s.transferTxId].date = t.date;
        }
      }
    }
  }

  if (t.splits) {
    for (const s of t.splits) {
      const before = prev?.splits?.find((x) => x.id === s.id);
      if (before && before.transferAccountId === s.transferAccountId && s.transferAccountId && !before.transferTxId) {
        // The same for a split line converted without its other side (1.5.3).
        s.categoryId = transferNeedsCategory(b, t.accountId, s.transferAccountId) ? (s.categoryId ?? null) : null;
      } else if (s.transferAccountId && s.transferAccountId !== t.accountId) {
        const peerId = s.transferTxId && b.transactions[s.transferTxId] ? s.transferTxId : newId();
        const old = b.transactions[peerId];
        const peer = {
          ...(old || { cleared: 'U' as Cleared, accepted: true }),
          id: peerId,
          accountId: s.transferAccountId,
          date: t.date,
          amount: -s.amount,
          memo: s.memo || t.memo,
          transferAccountId: t.accountId,
          transferTxId: id,
          transferSplitParentId: id,
          payeeId: ensureTransferPayee(b, t.accountId).id,
          categoryId: transferNeedsCategory(b, s.transferAccountId, t.accountId) ? (old?.categoryId ?? null) : null,
        } as Transaction;
        if (!peer.memo) delete peer.memo;
        b.transactions[peerId] = peer;
        s.transferTxId = peerId;
        s.categoryId = transferNeedsCategory(b, t.accountId, s.transferAccountId) ? (s.categoryId ?? null) : null;
      } else {
        if (s.transferTxId) removeTransaction(b, s.transferTxId);
        delete s.transferTxId;
        delete s.transferAccountId;
      }
    }
  }

  b.transactions[id] = t;

  // Remember this payee's category, amount and memo for next time (YNAB4 auto-fill). Not from a
  // bank row still waiting for approval: its category may only be a suggestion. It's learned
  // when it's approved (1.5.11).
  if (t.accepted || !t.importIds?.length) rememberAutoFill(b, t);
  return id;
}

function rememberAutoFill(b: Budget, t: Transaction): void {
  if (!t.payeeId || t.transferAccountId) return;
  const p = b.payees[t.payeeId];
  if (!p) return;
  if (t.categoryId && t.categoryId !== SPLIT) p.autoCategoryId = t.categoryId;
  p.autoAmount = t.amount;
  p.autoMemo = t.memo || null;
}

/**
 * Deletes one transaction record. If it was imported from a bank file, its import ids are
 * remembered on its account (Account.deletedImports), so importing that file again offers the
 * row as "previously deleted" instead of bringing it back. YNAB4 did the same.
 */
function removeTransaction(b: Budget, id: Id): void {
  const t = b.transactions[id];
  if (!t) return;
  if (t.importIds?.length) {
    const a = b.accounts[t.accountId];
    if (a) (a.deletedImports ??= []).push({ ids: [...t.importIds], deletedAt: new Date().toISOString() });
  }
  delete b.transactions[id];
}

/** Deletes transactions and their transfer pairs. */
export function deleteTransactions(b: Budget, ids: Id[]): void {
  for (const id of ids) {
    const t = b.transactions[id];
    if (!t) continue;
    if (t.transferSplitParentId) {
      const parent = b.transactions[t.transferSplitParentId];
      if (parent?.splits) {
        parent.splits = parent.splits.filter((s) => s.transferTxId !== id);
        parent.amount = parent.splits.reduce((sum, s) => sum + s.amount, 0);
        if (!parent.splits.length) {
          parent.categoryId = null;
          delete parent.splits;
        }
      }
    } else if (t.transferTxId) {
      removeTransaction(b, t.transferTxId);
    }
    for (const s of t.splits || []) if (s.transferTxId) removeTransaction(b, s.transferTxId);
    removeTransaction(b, id);
  }
}

/**
 * Adds deleted-import records to accounts (from YNAB4's deleted transactions). Skips unknown
 * accounts, ids already remembered and ids still on a transaction. Returns how many were added.
 */
export function addDeletedImports(b: Budget, byAccount: Map<Id, DeletedImport[]>): number {
  const live = new Set<string>();
  for (const t of Object.values(b.transactions)) for (const id of t.importIds || []) live.add(t.accountId + '|' + normalizeImportId(id));
  let added = 0;
  for (const [accountId, records] of byAccount) {
    const a = b.accounts[accountId];
    if (!a) continue;
    const known = new Set((a.deletedImports || []).flatMap((d) => d.ids.map(normalizeImportId)));
    for (const d of records) {
      const ids = d.ids.filter((id) => !known.has(normalizeImportId(id)) && !live.has(accountId + '|' + normalizeImportId(id)));
      if (!ids.length) continue;
      (a.deletedImports ??= []).push({ ...d, ids });
      for (const id of ids) known.add(normalizeImportId(id));
      added++;
    }
  }
  return added;
}

/** Forgets deleted-import records that share an id with `ids` (the row was imported again). */
export function forgetDeletedImports(b: Budget, accountId: Id, ids: string[]): void {
  const a = b.accounts[accountId];
  if (!a?.deletedImports?.length) return;
  const gone = new Set(ids.map(normalizeImportId));
  a.deletedImports = a.deletedImports.filter((d) => !d.ids.some((id) => gone.has(normalizeImportId(id))));
  if (!a.deletedImports.length) delete a.deletedImports;
}

/**
 * Approves a transaction. A bank match waiting for approval is then settled. A transfer the
 * scheduler entered arrives unapproved on both sides, as in YNAB4, and its other sides are
 * approved with it, unless one has a bank match of its own waiting to be looked at. Other
 * transfers' sides are left alone: an import may hold one back on purpose (a guess to confirm).
 */
function approve(b: Budget, t: Transaction): void {
  // A bank row's auto-fill wasn't learned while it waited (1.5.11).
  if (!t.accepted && t.importIds?.length) rememberAutoFill(b, t);
  t.accepted = true;
  delete t.matched;
  // The far side of a split line points at the split; the split's other lines count too.
  const parent = t.transferSplitParentId ? b.transactions[t.transferSplitParentId] : undefined;
  // Only a scheduled transfer: the side the scheduler entered carries its schedule's id.
  const near = parent ?? (t.transferTxId ? b.transactions[t.transferTxId] : undefined);
  if (!t.scheduleId && !near?.scheduleId) return;
  const ids = new Set([...transferSides(t), ...(parent ? transferSides(parent) : [])]);
  ids.delete(t.id);
  for (const id of ids) {
    const other = b.transactions[id];
    if (other && !other.accepted && !other.matched) other.accepted = true;
  }
}

/** The ids of a transaction's transfer partners: the other side, or each split line's. */
function transferSides(t: Transaction): Id[] {
  const ids = (t.splits ?? []).map((s) => s.transferTxId).filter((x): x is Id => !!x);
  if (t.transferTxId) ids.push(t.transferTxId);
  return ids;
}

/** Approves a transaction and its transfer's other side (see approve). */
export function approveTransaction(b: Budget, id: Id): void {
  const t = b.transactions[id];
  if (t) approve(b, t);
}

/** Sets the cleared state. Clearing a transaction also approves it, as in YNAB4. */
export function setCleared(b: Budget, ids: Id[], cleared: Cleared): void {
  for (const id of ids) {
    const t = b.transactions[id];
    if (!t) continue;
    t.cleared = cleared;
    if (cleared !== 'U') approve(b, t);
  }
}

/** Cycles U -> C -> U. Reconciled transactions become cleared. Clearing approves (YNAB4). */
export function toggleCleared(b: Budget, id: Id): void {
  const t = b.transactions[id];
  if (!t) return;
  t.cleared = t.cleared === 'C' ? 'U' : 'C';
  if (t.cleared === 'C') approve(b, t);
}

export function setFlag(b: Budget, ids: Id[], flag: Flag | undefined): void {
  for (const id of ids) {
    const t = b.transactions[id];
    if (!t) continue;
    if (flag) t.flag = flag;
    else delete t.flag;
  }
}

export function approveTransactions(b: Budget, ids: Id[]): void {
  for (const id of ids) {
    const t = b.transactions[id];
    if (t) approve(b, t);
  }
}

/** Sets the category of transactions that can have one (not splits or budget-to-budget transfers). */
export function categorizeTransactions(b: Budget, ids: Id[], categoryId: Id | null): number {
  let n = 0;
  for (const id of ids) {
    const t = b.transactions[id];
    if (!t || t.categoryId === SPLIT) continue;
    if (t.transferAccountId && !transferNeedsCategory(b, t.accountId, t.transferAccountId)) continue;
    t.categoryId = categoryId;
    n++;
    if (t.payeeId && categoryId && !t.transferAccountId) {
      const p = b.payees[t.payeeId];
      if (p) p.autoCategoryId = categoryId;
    }
  }
  return n;
}

export function setTransactionsDate(b: Budget, ids: Id[], date: ISODate): void {
  for (const id of ids) {
    const t = b.transactions[id];
    if (!t) continue;
    t.date = date;
    // The far side of a split-line transfer moves its parent, and so the parent's other peers too.
    const main = (t.transferSplitParentId && b.transactions[t.transferSplitParentId]) || t;
    main.date = date;
    if (main.transferTxId && b.transactions[main.transferTxId]) b.transactions[main.transferTxId].date = date;
    for (const s of main.splits || []) if (s.transferTxId && b.transactions[s.transferTxId]) b.transactions[s.transferTxId].date = date;
  }
}

/** Sets the payee of transactions that are not transfers. */
export function setTransactionsPayee(b: Budget, ids: Id[], payeeName: string): void {
  const payeeId = ensurePayee(b, payeeName);
  for (const id of ids) {
    const t = b.transactions[id];
    if (t && !t.transferAccountId) t.payeeId = payeeId;
  }
}

/** Moves transactions to another account. Transfers to that same account are skipped. */
export function moveTransactions(b: Budget, ids: Id[], accountId: Id): number {
  let n = 0;
  for (const id of ids) {
    const t = b.transactions[id];
    if (!t || t.accountId === accountId || t.transferAccountId === accountId || t.transferSplitParentId) continue;
    if (t.splits?.some((s) => s.transferAccountId === accountId)) continue;
    t.accountId = accountId;
    // A bank match waiting for approval is settled by the move: Unmatch would otherwise put the
    // bank's row into the new account, not the one its file was for.
    delete t.matched;
    if (t.transferTxId && b.transactions[t.transferTxId]) {
      const peer = b.transactions[t.transferTxId];
      peer.transferAccountId = accountId;
      peer.payeeId = ensureTransferPayee(b, accountId).id;
      if (!transferNeedsCategory(b, peer.accountId, accountId)) peer.categoryId = null;
      if (!transferNeedsCategory(b, accountId, t.transferAccountId!)) t.categoryId = null;
    }
    for (const s of t.splits || []) {
      if (s.transferTxId && b.transactions[s.transferTxId]) {
        const peer = b.transactions[s.transferTxId];
        peer.transferAccountId = accountId;
        peer.payeeId = ensureTransferPayee(b, accountId).id;
        // As for a plain transfer: between two budget accounts neither side has a category.
        if (!transferNeedsCategory(b, peer.accountId, accountId)) peer.categoryId = null;
        if (!transferNeedsCategory(b, accountId, peer.accountId)) s.categoryId = null;
      }
    }
    n++;
  }
  return n;
}

// ---- Scheduled transactions ---------------------------------------------------------------

export function saveScheduled(b: Budget, s: Omit<ScheduledTransaction, 'id'> & { id?: Id }): Id {
  const id = s.id || newId();
  const out: ScheduledTransaction = { ...s, id, startDate: s.startDate || s.date };
  if (out.transferAccountId) {
    out.payeeId = ensureTransferPayee(b, out.transferAccountId).id;
    if (!transferNeedsCategory(b, out.accountId, out.transferAccountId)) out.categoryId = null;
  }
  if (out.categoryId !== SPLIT) delete out.splits;
  b.scheduled[id] = out;
  return id;
}

export function deleteScheduled(b: Budget, id: Id): void {
  delete b.scheduled[id];
}

/** Moves a scheduled transaction on to its next date, deleting it if it doesn't repeat. */
export function skipScheduled(b: Budget, id: Id): void {
  const s = b.scheduled[id];
  if (!s) return;
  const next = nextScheduledDate(s, s.date);
  if (next) s.date = next;
  else delete b.scheduled[id];
}

/** Enters the next occurrence of a scheduled transaction now (optionally on another date). */
/**
 * Enters a scheduled transaction. Entered by the scheduler itself (when due) it arrives
 * unapproved, as in YNAB4 (both sides of a transfer), so it shows until you approve it, clear it
 * or reconcile it; entered by you ("Enter now"), it is approved.
 */
export function enterScheduled(b: Budget, id: Id, date?: ISODate, approved = false): Id | null {
  const s = b.scheduled[id];
  if (!s) return null;
  const txId = saveTransaction(b, {
    accountId: s.accountId,
    date: date || s.date,
    payeeId: s.transferAccountId ? undefined : s.payeeId,
    transferAccountId: s.transferAccountId,
    categoryId: s.categoryId,
    memo: s.memo,
    amount: s.amount,
    cleared: 'U',
    flag: s.flag,
    check: s.check,
    splits: s.splits?.map((sp) => ({ ...sp, id: newId(), transferTxId: undefined })),
    scheduleId: s.id,
    accepted: approved,
  });
  // A transfer's other side arrives unapproved too, as in YNAB4: approving either side (or a
  // bank match of the one with a bank file) approves both.
  const t = txId ? b.transactions[txId] : undefined;
  if (t && !approved) {
    for (const sideId of transferSides(t)) if (b.transactions[sideId]) b.transactions[sideId].accepted = false;
  }
  skipScheduled(b, id);
  return txId;
}

/** Enters every scheduled transaction that is due on or before `upTo`. Returns how many were entered. */
export function enterDueScheduled(b: Budget, upTo: ISODate = today()): number {
  let n = 0;
  for (const s of Object.values(b.scheduled)) {
    let guard = 0;
    while (b.scheduled[s.id] && isISODate(b.scheduled[s.id].date) && b.scheduled[s.id].date <= upTo && guard++ < 500) {
      if (s.endDate && b.scheduled[s.id].date > s.endDate) {
        delete b.scheduled[s.id];
        break;
      }
      enterScheduled(b, s.id);
      n++;
    }
  }
  return n;
}

/** Makes a scheduled transaction from an existing transaction (the "Repeat" option). */
export function scheduleFromTransaction(
  b: Budget,
  txId: Id,
  frequency: ScheduledTransaction['frequency'],
  firstDate: ISODate,
): Id | null {
  const t = b.transactions[txId];
  if (!t) return null;
  return saveScheduled(b, {
    accountId: t.accountId,
    date: firstDate,
    startDate: firstDate,
    frequency,
    payeeId: t.payeeId,
    categoryId: t.categoryId,
    memo: t.memo,
    amount: t.amount,
    flag: t.flag,
    check: t.check,
    transferAccountId: t.transferSplitParentId ? undefined : t.transferAccountId,
    splits: t.splits?.map((s) => ({ ...s, id: newId(), transferTxId: undefined })),
  });
}

/**
 * YNAB4's "Move to Scheduler": turns a transaction (usually one dated in the future) into a
 * scheduled transaction on the same date, and removes the transaction. Returns the schedule's id.
 */
export function moveToScheduler(b: Budget, txId: Id): Id | null {
  const t = b.transactions[txId];
  if (!t || t.transferSplitParentId) return null;
  const sid = scheduleFromTransaction(b, txId, 'Once', t.date);
  if (sid) deleteTransactions(b, [txId]);
  return sid;
}

// ---- Budget cells -----------------------------------------------------------------

function cell(b: Budget, month: MonthKey, categoryId: Id) {
  const m = (b.months[month] = b.months[month] || {});
  return (m[categoryId] = m[categoryId] || { budgeted: 0 });
}

function tidyCell(b: Budget, month: MonthKey, categoryId: Id): void {
  const m = b.months[month];
  const c = m?.[categoryId];
  if (c && !c.budgeted && !c.handling && !c.note) delete m[categoryId];
  if (m && !Object.keys(m).length) delete b.months[month];
}

export function setBudgeted(b: Budget, month: MonthKey, categoryId: Id, amount: Money): void {
  cell(b, month, categoryId).budgeted = amount;
  tidyCell(b, month, categoryId);
}

/** Sets several categories' budgeted amounts at once (quick budget for many categories). */
export function setBudgetedMany(b: Budget, month: MonthKey, amounts: Record<Id, Money>): void {
  for (const [cid, amount] of Object.entries(amounts)) setBudgeted(b, month, cid, amount);
}

/**
 * Sets how overspending is handled from `month` onwards. The setting lasts until the
 * next month that sets it, as in YNAB4.
 */
export function setOverspendingHandling(
  b: Budget,
  month: MonthKey,
  categoryId: Id,
  handling: OverspendingHandling,
): void {
  cell(b, month, categoryId).handling = handling;
}

export function setCategoryMonthNote(b: Budget, month: MonthKey, categoryId: Id, note: string): void {
  const c = cell(b, month, categoryId);
  if (note.trim()) c.note = note;
  else delete c.note;
  tidyCell(b, month, categoryId);
}

export function setMonthNote(b: Budget, month: MonthKey, note: string): void {
  b.monthNotes = b.monthNotes || {};
  if (note.trim()) b.monthNotes[month] = note;
  else delete b.monthNotes[month];
}

/** Moves money between categories in one month by changing what is budgeted. */
export function moveMoney(b: Budget, month: MonthKey, fromId: Id, toId: Id, amount: Money): void {
  if (!amount || fromId === toId) return;
  setBudgeted(b, month, fromId, (b.months[month]?.[fromId]?.budgeted || 0) - amount);
  setBudgeted(b, month, toId, (b.months[month]?.[toId]?.budgeted || 0) + amount);
}

// ---- Categories -----------------------------------------------------------------------

export function addMaster(b: Budget, name: string, atIndex?: number): Id {
  const id = newId();
  const sort = Math.max(-1, ...Object.values(b.masters).map((m) => m.sort)) + 1;
  b.masters[id] = { id, name: name.trim() || 'New Group', sort };
  if (atIndex !== undefined) moveMaster(b, id, atIndex);
  return id;
}

export function renameMaster(b: Budget, id: Id, name: string): void {
  const m = b.masters[id];
  if (m && name.trim()) m.name = name.trim();
}

export function setMasterCollapsed(b: Budget, id: Id, collapsed: boolean): void {
  const m = b.masters[id];
  if (!m) return;
  if (collapsed) m.collapsed = true;
  else delete m.collapsed;
}

export function setMasterNote(b: Budget, id: Id, note: string): void {
  const m = b.masters[id];
  if (!m) return;
  if (note.trim()) m.note = note;
  else delete m.note;
}

export function moveMaster(b: Budget, id: Id, index: number): void {
  const list = Object.values(b.masters)
    .filter((m) => m.id !== id)
    .sort((x, y) => x.sort - y.sort);
  list.splice(Math.max(0, Math.min(index, list.length)), 0, b.masters[id]);
  list.forEach((m, i) => (m.sort = i));
}

export function addCategory(b: Budget, masterId: Id, name: string, atIndex?: number): Id {
  const id = newId();
  const sort =
    Math.max(
      -1,
      ...Object.values(b.categories)
        .filter((c) => c.masterId === masterId)
        .map((c) => c.sort),
    ) + 1;
  b.categories[id] = { id, masterId, name: name.trim() || 'New Category', sort, hidden: false };
  if (atIndex !== undefined) moveCategory(b, id, masterId, atIndex);
  return id;
}

export function renameCategory(b: Budget, id: Id, name: string): void {
  const c = b.categories[id];
  if (c && name.trim()) c.name = name.trim();
}

export function setCategoryHidden(b: Budget, id: Id, hidden: boolean): void {
  const c = b.categories[id];
  if (c) c.hidden = hidden;
}

export function setCategoryNote(b: Budget, id: Id, note: string): void {
  const c = b.categories[id];
  if (!c) return;
  if (note.trim()) c.note = note;
  else delete c.note;
}

export function moveCategory(b: Budget, id: Id, masterId: Id, index: number): void {
  const c = b.categories[id];
  if (!c) return;
  const list = Object.values(b.categories)
    .filter((x) => x.masterId === masterId && x.id !== id)
    .sort((x, y) => x.sort - y.sort);
  list.splice(Math.max(0, Math.min(index, list.length)), 0, c);
  c.masterId = masterId;
  list.forEach((x, i) => (x.sort = i));
}

/**
 * Deletes a category. Its transactions, scheduled transactions and payee defaults move to
 * `reassignTo` (or become uncategorised), and its budgeted amounts are added to that category.
 */
export function deleteCategory(b: Budget, id: Id, reassignTo: Id | null): void {
  for (const t of Object.values(b.transactions)) {
    if (t.categoryId === id) t.categoryId = reassignTo;
    for (const s of t.splits || []) if (s.categoryId === id) s.categoryId = reassignTo;
  }
  for (const s of Object.values(b.scheduled)) {
    if (s.categoryId === id) s.categoryId = reassignTo;
    for (const sp of s.splits || []) if (sp.categoryId === id) sp.categoryId = reassignTo;
  }
  for (const m of Object.values(b.months)) {
    const c = m[id];
    if (!c) continue;
    if (reassignTo && !reassignTo.startsWith('__')) {
      const target = (m[reassignTo] = m[reassignTo] || { budgeted: 0 });
      target.budgeted += c.budgeted;
    }
    delete m[id];
  }
  for (const p of Object.values(b.payees)) if (p.autoCategoryId === id) p.autoCategoryId = reassignTo;
  delete b.categories[id];
}

/** Deletes a group and all its categories, reassigning them as in deleteCategory. */
export function deleteMaster(b: Budget, id: Id, reassignTo: Id | null): void {
  for (const c of Object.values(b.categories)) if (c.masterId === id) deleteCategory(b, c.id, reassignTo);
  delete b.masters[id];
}

// ---- Accounts -------------------------------------------------------------------------------

export interface NewAccount {
  /** Keep a particular id (Fresh Start keeps account ids so scheduled transactions still work). */
  id?: Id;
  name: string;
  type: AccountType;
  onBudget: boolean;
  note?: string;
}

function preYnabDebtMaster(b: Budget): Id {
  const existing = Object.values(b.masters).find((m) => m.name === 'Pre-YNAB Debt');
  return existing ? existing.id : addMaster(b, 'Pre-YNAB Debt');
}

/**
 * Adds an account with a starting balance transaction. On a budget account a positive
 * starting balance is income for this month; a negative one (an existing debt) gets its own
 * category in "Pre-YNAB Debt", set to carry overspending forward, as YNAB4 did.
 */
export function addAccount(b: Budget, a: NewAccount, startingBalance: Money, date: ISODate): Id {
  const id = a.id || newId();
  const sort = Math.max(-1, ...Object.values(b.accounts).map((x) => x.sort)) + 1;
  b.accounts[id] = { id, name: a.name.trim(), type: a.type, onBudget: a.onBudget, closed: false, sort };
  if (a.note) b.accounts[id].note = a.note;
  let payee = Object.values(b.payees).find((p) => p.name === 'Starting Balance');
  if (!payee) {
    const pid = newId();
    payee = b.payees[pid] = { id: pid, name: 'Starting Balance', rules: [] };
  }
  let categoryId: Id | null = null;
  if (a.onBudget) {
    if (startingBalance >= 0) categoryId = INCOME_NOW;
    else {
      categoryId = addCategory(b, preYnabDebtMaster(b), a.name.trim());
      setOverspendingHandling(b, monthOf(date), categoryId, 'carry');
    }
  }
  const txId = newId();
  b.transactions[txId] = {
    id: txId,
    accountId: id,
    date,
    payeeId: payee.id,
    amount: startingBalance,
    cleared: 'C',
    accepted: true,
    categoryId,
  };
  ensureTransferPayee(b, id);
  return id;
}

export function updateAccount(b: Budget, id: Id, patch: Partial<Pick<Account, 'name' | 'type' | 'note' | 'closed' | 'onBudget'>>): void {
  const a = b.accounts[id];
  if (!a) return;
  if (patch.name !== undefined && patch.name.trim()) {
    a.name = patch.name.trim();
    const p = b.payees[transferPayeeId(id)];
    if (p) p.name = transferPayeeName(b, id);
  }
  if (patch.type !== undefined) a.type = patch.type;
  if (patch.note !== undefined) {
    if (patch.note.trim()) a.note = patch.note;
    else delete a.note;
  }
  if (patch.closed !== undefined) a.closed = patch.closed;
  if (patch.onBudget !== undefined) setAccountOnBudget(b, id, patch.onBudget);
}

/**
 * Switches an account between on- and off-budget, which YNAB4 allowed at any time. The
 * account's own categories are kept (they count again if it comes back on budget). Transfers
 * to or from it that no longer need a category lose theirs, since between two budget accounts
 * a category would count as spending. Ones that now need one show as "needs a category".
 */
export function setAccountOnBudget(b: Budget, id: Id, onBudget: boolean): void {
  const a = b.accounts[id];
  if (!a || a.onBudget === onBudget) return;
  a.onBudget = onBudget;
  const tidy = (from: Id, line: { transferAccountId?: Id; categoryId?: Id | null }) => {
    const to = line.transferAccountId;
    if (to && (from === id || to === id) && !transferNeedsCategory(b, from, to)) line.categoryId = null;
  };
  for (const t of Object.values(b.transactions)) {
    tidy(t.accountId, t);
    for (const s of t.splits || []) tidy(t.accountId, s);
  }
  for (const s of Object.values(b.scheduled)) {
    tidy(s.accountId, s);
    for (const sp of s.splits || []) tidy(s.accountId, sp);
  }
}

/**
 * YNAB4's Adjust Balance: enters a "Manual Balance Adjustment" for the difference between the
 * working balance and `newBalance`, as income for that month on a budget account. Returns the
 * new transaction's id, or null if the balance was already right.
 */
export function adjustBalance(b: Budget, accountId: Id, newBalance: Money, date: ISODate): Id | null {
  const acc = b.accounts[accountId];
  if (!acc) return null;
  let working = 0;
  for (const t of Object.values(b.transactions)) if (t.accountId === accountId) working += t.amount;
  const diff = newBalance - working;
  if (diff === 0) return null;
  const id = newId();
  b.transactions[id] = {
    id,
    accountId,
    date,
    payeeId: ensurePayee(b, 'Manual Balance Adjustment'),
    amount: diff,
    cleared: 'C',
    accepted: true,
    categoryId: acc.onBudget ? INCOME_NOW : null,
  };
  return id;
}

export function moveAccount(b: Budget, id: Id, index: number): void {
  const a = b.accounts[id];
  if (!a) return;
  const list = Object.values(b.accounts)
    .filter((x) => x.id !== id)
    .sort((x, y) => x.sort - y.sort);
  list.splice(Math.max(0, Math.min(index, list.length)), 0, a);
  list.forEach((x, i) => (x.sort = i));
}

/**
 * Deletes an account and its transactions. Transfers from other accounts to it become
 * ordinary transactions with a "Transfer : <name> (deleted)" payee.
 */
export function deleteAccount(b: Budget, id: Id): void {
  const name = b.accounts[id]?.name || 'deleted account';
  for (const t of Object.values(b.transactions)) {
    if (t.accountId === id) continue;
    if (t.transferAccountId === id) {
      delete t.transferAccountId;
      delete t.transferTxId;
      delete t.transferSplitParentId;
      t.payeeId = ensurePayee(b, `Transfer : ${name} (deleted)`);
    }
    for (const s of t.splits || []) {
      if (s.transferAccountId === id) {
        delete s.transferAccountId;
        delete s.transferTxId;
      }
    }
  }
  for (const t of Object.values(b.transactions)) if (t.accountId === id) delete b.transactions[t.id];
  for (const s of Object.values(b.scheduled)) {
    if (s.accountId === id || s.transferAccountId === id) delete b.scheduled[s.id];
    else for (const sp of s.splits || []) if (sp.transferAccountId === id) delete sp.transferAccountId;
  }
  delete b.payees[transferPayeeId(id)];
  delete b.accounts[id];
}

/** An account's cleared balance (cleared and reconciled transactions) up to and including a date. */
export function clearedBalance(b: Budget, accountId: Id, upTo: ISODate): Money {
  let cleared = 0;
  for (const t of Object.values(b.transactions)) {
    if (t.accountId === accountId && t.cleared !== 'U' && t.date <= upTo) cleared += t.amount;
  }
  return cleared;
}

/**
 * Reconciles an account to a statement balance: as in YNAB4, only what had cleared by the
 * statement's date is compared and locked (1.5). Cleared transactions dated later stay cleared.
 */
export function reconcileAccount(b: Budget, accountId: Id, statementBalance: Money, date: ISODate): Money {
  const cleared = clearedBalance(b, accountId, date);
  const diff = statementBalance - cleared;
  if (diff !== 0) {
    const acc = b.accounts[accountId];
    const id = newId();
    b.transactions[id] = {
      id,
      accountId,
      date,
      payeeId: ensurePayee(b, 'Reconciliation Balance Adjustment'),
      amount: diff,
      cleared: 'C',
      accepted: true,
      categoryId: acc?.onBudget ? INCOME_NOW : null,
      memo: 'Entered automatically by reconciliation',
    };
  }
  for (const t of Object.values(b.transactions)) {
    if (t.accountId === accountId && t.cleared === 'C' && t.date <= date) {
      t.cleared = 'R';
      approve(b, t); // reconciling approves, as in YNAB4
    }
  }
  const acc = b.accounts[accountId];
  // An older statement reconciled after a newer one doesn't move "last reconciled" back.
  if (acc && (!acc.lastReconciledDate || date >= acc.lastReconciledDate)) {
    acc.lastReconciledDate = date;
    acc.lastReconciledBalance = statementBalance;
  }
  return diff;
}

// ---- Budget settings -----------------------------------------------------------------------

export function renameBudget(b: Budget, name: string): void {
  if (name.trim()) b.name = name.trim();
}
