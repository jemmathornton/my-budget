import { newBudget } from './budget';
import { today } from './dates';
import { compute } from './engine';
import { addAccount, ensureTransferPayee } from './ops';
import { sortedAccounts, transferPayeeId } from './queries';
import type { Budget, ISODate } from './types';

/**
 * YNAB4's "Fresh Start": a new budget with the same accounts (at their current balances),
 * categories, payees and scheduled transactions, but no history. All the money in budget
 * accounts starts in Available to Budget; existing debts get "Pre-YNAB Debt" categories.
 * The old budget is left untouched.
 */
export function freshStart(old: Budget, name: string, date: ISODate = today()): Budget {
  const c = compute(old);
  const b = newBudget(name, false);
  b.currency = { ...old.currency };
  b.dateFormat = old.dateFormat;
  b.settings = { ...old.settings };
  b.freshStartFrom = old.name;

  // Same ids, so payee defaults and scheduled transactions keep pointing at the right things.
  for (const m of Object.values(old.masters)) {
    if (m.name === 'Pre-YNAB Debt') continue;
    b.masters[m.id] = { ...m };
  }
  for (const cat of Object.values(old.categories)) {
    if (!b.masters[cat.masterId]) continue;
    b.categories[cat.id] = { ...cat };
  }
  for (const p of Object.values(old.payees)) {
    if (p.transferAccountId) continue;
    const autoCategoryId = p.autoCategoryId && (b.categories[p.autoCategoryId] || p.autoCategoryId.startsWith('__')) ? p.autoCategoryId : null;
    b.payees[p.id] = { ...p, rules: p.rules.map((r) => ({ ...r })), autoCategoryId };
  }

  for (const a of sortedAccounts(old)) {
    const balance = c.accounts.get(a.id)?.working ?? 0;
    // Closed accounts are left behind unless they still hold money (which must not vanish).
    if (a.closed && balance === 0) continue;
    addAccount(b, { id: a.id, name: a.name, type: a.type, onBudget: a.onBudget, note: a.note }, balance, date);
    const acc = b.accounts[a.id];
    acc.closed = a.closed;
    if (a.importKeys) acc.importKeys = [...a.importKeys];
    if (a.csvMapping) acc.csvMapping = { ...a.csvMapping };
    if (a.importReverse) acc.importReverse = { ...a.importReverse };
    if (a.bankProfile) acc.bankProfile = a.bankProfile;
    if (a.deletedImports) acc.deletedImports = a.deletedImports.map((d) => ({ ...d, ids: [...d.ids] }));
    // Keep the rename rules that turn bank text into transfers to this account.
    const oldTransfer = old.payees[transferPayeeId(a.id)];
    if (oldTransfer) {
      const p = ensureTransferPayee(b, a.id);
      p.rules = oldTransfer.rules.map((r) => ({ ...r }));
      p.autoCategoryId = oldTransfer.autoCategoryId && b.categories[oldTransfer.autoCategoryId] ? oldTransfer.autoCategoryId : null;
    }
  }

  for (const s of Object.values(old.scheduled)) {
    if (!b.accounts[s.accountId] || (s.transferAccountId && !b.accounts[s.transferAccountId])) continue;
    if (s.splits?.some((sp) => sp.transferAccountId && !b.accounts[sp.transferAccountId])) continue;
    const ok = (id: string | null) => !id || id.startsWith('__') || !!b.categories[id];
    if (!ok(s.categoryId) || s.splits?.some((sp) => !ok(sp.categoryId))) continue;
    b.scheduled[s.id] = { ...s, splits: s.splits?.map((sp) => ({ ...sp })) };
  }
  return b;
}
