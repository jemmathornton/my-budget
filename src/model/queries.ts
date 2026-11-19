import { addMonths, monthLabel, monthOf } from './dates';
import {
  INCOME_NEXT,
  INCOME_NOW,
  SPLIT,
  type Account,
  type Budget,
  type Category,
  type Id,
  type ISODate,
  type MasterCategory,
  type Payee,
  type PayeeRule,
  type Transaction,
} from './types';

// Read-only helpers for looking things up in a budget.

export function sortedMasters(b: Budget): MasterCategory[] {
  return Object.values(b.masters).sort((x, y) => x.sort - y.sort);
}

export function categoriesOf(b: Budget, masterId: Id, includeHidden = false): Category[] {
  return Object.values(b.categories)
    .filter((c) => c.masterId === masterId && (includeHidden || !c.hidden))
    .sort((x, y) => x.sort - y.sort);
}

export function sortedAccounts(b: Budget): Account[] {
  return Object.values(b.accounts).sort((x, y) => x.sort - y.sort);
}

/** What choosing a payee fills in: YNAB4's defaults (category only) unless changed. */
export function autoFillOptions(b: Budget): { category: boolean; memo: boolean; amount: boolean } {
  const a = b.settings.autoFill;
  return { category: a?.category ?? true, memo: !!a?.memo, amount: !!a?.amount };
}

export function isIncome(categoryId: Id | null | undefined): boolean {
  return categoryId === INCOME_NOW || categoryId === INCOME_NEXT;
}

/** The other transactions that move with t when its date is set (see ops setTransactionsDate). */
export function datePeers(b: Budget, t: Transaction): Transaction[] {
  const main = (t.transferSplitParentId && b.transactions[t.transferSplitParentId]) || t;
  const ids = [main.id, main.transferTxId, ...(main.splits ?? []).map((s) => s.transferTxId)];
  return ids.filter((id): id is Id => !!id && id !== t.id).map((id) => b.transactions[id]).filter((u): u is Transaction => !!u);
}

/**
 * The reconciled transactions that deleting or changing `ids` would touch: those transactions,
 * and the other sides of their transfers and split-line transfers (1.5.3). A change to either side
 * of a transfer changes both.
 * `dating`: for a date change, which also moves a split's other lines' sides (1.5.11).
 */
export function reconciledAffected(b: Budget, ids: Id[], dating = false): { own: number; others: Set<string> } {
  const chosen = new Set(ids);
  let own = 0;
  const others = new Set<string>();
  for (const id of ids) {
    const t = b.transactions[id];
    if (!t) continue;
    if (t.cleared === 'R') own++;
    const peers = dating
      ? datePeers(b, t).map((u) => u.id)
      : [t.transferTxId, t.transferSplitParentId, ...(t.splits ?? []).map((s) => s.transferTxId)];
    for (const p of peers) {
      const u = p ? b.transactions[p] : undefined;
      if (u && u.cleared === 'R' && !chosen.has(u.id)) others.add(b.accounts[u.accountId]?.name ?? '');
    }
  }
  return { own, others };
}

/**
 * What a register row shows for its category: nothing for an off-budget account's rows or a
 * transfer that needs none, "Needs a category", "Split (3 categories)", or the category.
 */
export function registerCategory(b: Budget, t: Transaction): { text: string; kind: 'split' | 'blank' | 'needs' | 'normal' } {
  if (t.categoryId === SPLIT) return { text: `Split (${t.splits?.length || 0} categories)`, kind: 'split' };
  if (!b.accounts[t.accountId]?.onBudget) return { text: '', kind: 'blank' };
  if (t.transferAccountId && !transferNeedsCategory(b, t.accountId, t.transferAccountId)) return { text: '', kind: 'blank' };
  if (!t.categoryId) return { text: 'Needs a category', kind: 'needs' };
  return { text: categoryLabel(b, t.categoryId, t.date), kind: 'normal' };
}

/**
 * The name shown for a category. With `date`, the income categories name the month,
 * e.g. "Income for Oct 2026".
 */
export function categoryLabel(b: Budget, categoryId: Id | null | undefined, date?: ISODate): string {
  if (!categoryId) return '';
  if (categoryId === INCOME_NOW) return date ? `Income for ${monthLabel(monthOf(date), true)}` : 'Income for this month';
  if (categoryId === INCOME_NEXT)
    return date ? `Income for ${monthLabel(addMonths(monthOf(date), 1), true)}` : 'Income for next month';
  if (categoryId === SPLIT) return 'Split (multiple categories)';
  const c = b.categories[categoryId];
  if (!c) return '(deleted category)';
  const m = b.masters[c.masterId];
  return (m ? m.name + ': ' : '') + c.name;
}

/** Just the category's own name, without its group. */
export function categoryShortName(b: Budget, categoryId: Id | null | undefined, date?: ISODate): string {
  if (!categoryId) return '';
  if (categoryId === INCOME_NOW || categoryId === INCOME_NEXT || categoryId === SPLIT)
    return categoryLabel(b, categoryId, date);
  return b.categories[categoryId]?.name ?? '(deleted category)';
}

export function transferPayeeId(accountId: Id): Id {
  return 'Payee/Transfer:' + accountId;
}

export function transferPayeeName(b: Budget, accountId: Id): string {
  return 'Transfer : ' + (b.accounts[accountId]?.name || '?');
}

/** The payee name shown for a transaction ("Transfer : Savings" for transfers). */
export function payeeName(b: Budget, t: { payeeId?: Id; transferAccountId?: Id }): string {
  if (t.transferAccountId) return transferPayeeName(b, t.transferAccountId);
  return (t.payeeId && b.payees[t.payeeId]?.name) || '';
}

export function findPayeeByName(b: Budget, name: string): Payee | undefined {
  const n = name.trim().toLowerCase();
  if (!n) return undefined;
  return Object.values(b.payees).find((p) => !p.transferAccountId && p.name.toLowerCase() === n);
}

/**
 * Finds the payee whose rename rules match an imported payee name. An exact ("is") rule
 * beats the others; among those, the longest matching text wins.
 */
export function matchPayeeRules(b: Budget, imported: string): { payeeId?: Id; transferAccountId?: Id } | null {
  const text = imported.trim().toLowerCase();
  if (!text) return null;
  let best: { p: Payee; score: number } | null = null;
  for (const p of Object.values(b.payees)) {
    for (const r of p.rules) {
      const rule = r.text.trim().toLowerCase();
      if (!rule) continue;
      let hit = false;
      if (r.op === 'is') hit = text === rule;
      else if (r.op === 'contains') hit = text.includes(rule);
      else if (r.op === 'startsWith') hit = text.startsWith(rule);
      else if (r.op === 'endsWith') hit = text.endsWith(rule);
      if (hit) {
        const score = (r.op === 'is' ? 1000 : 0) + rule.length;
        if (!best || score > best.score) best = { p, score };
      }
    }
  }
  if (!best) return null;
  return best.p.transferAccountId ? { transferAccountId: best.p.transferAccountId } : { payeeId: best.p.id };
}

/**
 * findPayeeByName and matchPayeeRules for many texts at once (an import of hundreds of rows):
 * the payee names and rename rules are indexed once instead of scanned for every row. Gives
 * the same answers, including which payee wins a tie (the first, as in the scans).
 */
export function payeeMatcher(b: Budget) {
  const byName = new Map<string, Payee>();
  const exact = new Map<string, Payee>();
  const others: { p: Payee; op: PayeeRule['op']; text: string }[] = [];
  const texts = new Map<string, Payee>();
  for (const p of Object.values(b.payees)) {
    if (!p.transferAccountId) {
      const n = p.name.toLowerCase();
      if (!byName.has(n)) byName.set(n, p);
      for (const t of p.bankTexts ?? []) if (!texts.has(t)) texts.set(t, p);
    }
    for (const r of p.rules) {
      const rule = r.text.trim().toLowerCase();
      if (!rule) continue;
      if (r.op === 'is') {
        if (!exact.has(rule)) exact.set(rule, p);
      } else others.push({ p, op: r.op, text: rule });
    }
  }
  const result = (p: Payee) => (p.transferAccountId ? { transferAccountId: p.transferAccountId } : { payeeId: p.id });
  return {
    findByName(name: string): Payee | undefined {
      const n = name.trim().toLowerCase();
      return n ? byName.get(n) : undefined;
    },
    /** A payee that learned this bank text in a merge (`key` is textKey()). */
    findByBankText(key: string): Payee | undefined {
      return key ? texts.get(key) : undefined;
    },
    matchRules(imported: string): { payeeId?: Id; transferAccountId?: Id } | null {
      const text = imported.trim().toLowerCase();
      if (!text) return null;
      // An exact ("is") rule beats the others; then the longest matching text.
      const hit = exact.get(text);
      if (hit) return result(hit);
      let best: (typeof others)[number] | null = null;
      for (const r of others) {
        const ok = r.op === 'contains' ? text.includes(r.text) : r.op === 'startsWith' ? text.startsWith(r.text) : text.endsWith(r.text);
        if (ok && (!best || r.text.length > best.text.length)) best = r;
      }
      return best ? result(best.p) : null;
    },
  };
}

/** Whether a transfer between these accounts needs a category on the `from` side (budget -> tracking). */
export function transferNeedsCategory(b: Budget, fromAccountId: Id, toAccountId: Id | undefined): boolean {
  if (!toAccountId) return true;
  const from = b.accounts[fromAccountId];
  const to = b.accounts[toAccountId];
  return !!from && !!to && from.onBudget && !to.onBudget;
}

/** Transactions in a category (including split lines) in a month, newest first. */
export function categoryTransactions(
  b: Budget,
  categoryId: Id,
  month: string,
): { t: Transaction; amount: number; memo?: string }[] {
  const out: { t: Transaction; amount: number; memo?: string }[] = [];
  for (const t of Object.values(b.transactions)) {
    if (monthOf(t.date) !== month || !b.accounts[t.accountId]?.onBudget) continue;
    if (t.categoryId === SPLIT && t.splits) {
      for (const s of t.splits) if (s.categoryId === categoryId) out.push({ t, amount: s.amount, memo: s.memo || t.memo });
    } else if (t.categoryId === categoryId) {
      out.push({ t, amount: t.amount, memo: t.memo });
    }
  }
  return out.sort((x, y) => (x.t.date < y.t.date ? 1 : x.t.date > y.t.date ? -1 : 0));
}

/** How many transactions (and split lines) use a category, and scheduled ones too. */
export function categoryUsage(b: Budget, categoryId: Id): number {
  let n = 0;
  for (const t of Object.values(b.transactions)) {
    if (t.categoryId === categoryId) n++;
    for (const s of t.splits || []) if (s.categoryId === categoryId) n++;
  }
  for (const s of Object.values(b.scheduled)) {
    if (s.categoryId === categoryId) n++;
    for (const sp of s.splits || []) if (sp.categoryId === categoryId) n++;
  }
  return n;
}

export function payeeUsage(b: Budget): Map<Id, number> {
  const m = new Map<Id, number>();
  for (const t of Object.values(b.transactions)) {
    if (t.payeeId) m.set(t.payeeId, (m.get(t.payeeId) || 0) + 1);
    for (const s of t.splits || []) if (s.payeeId) m.set(s.payeeId, (m.get(s.payeeId) || 0) + 1);
  }
  for (const s of Object.values(b.scheduled)) if (s.payeeId) m.set(s.payeeId, (m.get(s.payeeId) || 0) + 1);
  return m;
}
