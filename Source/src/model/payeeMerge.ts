import { merchantOf, withoutOwnAmount, type Merchant } from './merchant';
import { mergePayees, renamePayee } from './ops';
import { SPLIT, type Budget, type Id, type Transaction } from './types';

// Payee merge suggestions (1.3.1): payees whose bank texts name the same merchant, offered to be
// combined into one. Importing created a payee for every new bank text, so the same shop often
// has dozens. Rules as measured in docs/plans/1.3-smarter-import.md §8.1.

export interface MergeGroup {
  /** What the payees have in common: a merchant ("tesco stores") or a person ("person:jane smith"). */
  key: string;
  /** The payees, most used first. The first is kept (its id stays, so schedules still point at it). */
  payeeIds: Id[];
  /** The suggested name: the most used payee's, tidied. */
  name: string;
  /** Transactions using any of them. */
  transactions: number;
  /** Every bank text in the group, with how often, most first. */
  texts: { text: string; n: number }[];
  /** The categories their transactions use, most first. */
  categories: { categoryId: Id; n: number }[];
  /** For a group dismissed before: the payees that have joined it since (only these start ticked). */
  fresh?: Id[];
}

const PERSON = new Set(['fpi', 'fpo', 'so', 'tfr', 'acct']);
const NO_NAME = new Set(['credit', 'withdrawal', 'atm']);
const BANK_OWN = new Set(['interest', 'cashback']);
const PROCESSOR_ONLY = /^(paypal|pp|sq|sumup|zettle|izettle|iz|sp|cko|dojo|stripe)$/;

/** A row's group key: the 2-word merchant, the whole name of a person, or the bank's own line per account. */
function rowKey(m: Merchant, accountId: Id): string {
  if (PERSON.has(m.kind)) return 'person:' + (m.kind === 'acct' ? m.name : m.words.join(' '));
  if (BANK_OWN.has(m.kind)) return `bank:${m.kind}:${accountId}`;
  return m.key;
}

const tidy = (s: string) => s.replace(/\s{2,}/g, ' ').trim();

/**
 * Groups of payees that look like one merchant or person. Never: transfer payees, payees set to
 * "keep separate", lines with no name (credits, withdrawals, cash machines), payment-processor
 * names on their own, a person known by one name only, or the bank's own lines across accounts.
 */
export function suggestMerges(b: Budget): MergeGroup[] {
  const byPayee = new Map<Id, Transaction[]>();
  for (const t of Object.values(b.transactions)) {
    if (!t.importedPayee || t.transferAccountId || !t.payeeId) continue;
    const p = b.payees[t.payeeId];
    if (!p || p.transferAccountId || p.noMerge) continue;
    const list = byPayee.get(t.payeeId);
    if (list) list.push(t);
    else byPayee.set(t.payeeId, [t]);
  }
  const groups = new Map<string, Id[]>();
  for (const [id, list] of byPayee) {
    const votes = new Map<string, number>();
    const kinds = new Map<string, number>();
    const accounts = new Set<Id>();
    for (const t of list) {
      const m = merchantOf(t.importedPayee!);
      accounts.add(t.accountId);
      kinds.set(m.kind, (kinds.get(m.kind) || 0) + 1);
      const k = rowKey(m, t.accountId);
      if (k) votes.set(k, (votes.get(k) || 0) + 1);
    }
    const kind = [...kinds.entries()].sort((x, y) => y[1] - x[1])[0][0];
    const best = [...votes.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    if (NO_NAME.has(kind) || !best || best === 'person:' || PROCESSOR_ONLY.test(best)) continue;
    if (best.startsWith('bank:') && accounts.size > 1) continue;
    const g = groups.get(best);
    if (g) g.push(id);
    else groups.set(best, [id]);
  }
  // All their transactions, not only the imported ones, count towards which payee is kept.
  const uses = new Map<Id, number>();
  for (const t of Object.values(b.transactions)) if (t.payeeId) uses.set(t.payeeId, (uses.get(t.payeeId) || 0) + 1);
  const out: MergeGroup[] = [];
  for (const [key, ids] of groups) {
    if (ids.length < 2) continue;
    const dismissed = b.dismissedMerges?.[key];
    const fresh = dismissed ? ids.filter((id) => !dismissed.includes(id)) : undefined;
    if (fresh && !fresh.length) continue;
    const payeeIds = [...ids].sort((x, y) => (uses.get(y) || 0) - (uses.get(x) || 0) || b.payees[x].name.localeCompare(b.payees[y].name));
    const texts = new Map<string, number>();
    const cats = new Map<Id, number>();
    let transactions = 0;
    for (const id of payeeIds) {
      transactions += uses.get(id) || 0;
      for (const t of byPayee.get(id) ?? []) {
        const text = tidy(t.importedPayee!);
        texts.set(text, (texts.get(text) || 0) + 1);
        if (t.categoryId && t.categoryId !== SPLIT) cats.set(t.categoryId, (cats.get(t.categoryId) || 0) + 1);
      }
    }
    // The kept payee's name, without an amount a bank put on the end of it.
    const target = b.payees[payeeIds[0]];
    let name = tidy(target.name);
    for (const t of byPayee.get(target.id) ?? []) {
      const cut = tidy(withoutOwnAmount(name, t.amount));
      if (cut && cut !== name) {
        name = cut;
        break;
      }
    }
    out.push({
      key,
      payeeIds,
      name,
      transactions,
      texts: [...texts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([text, n]) => ({ text, n })),
      categories: [...cats.entries()].sort((x, y) => y[1] - x[1]).map(([categoryId, n]) => ({ categoryId, n })),
      ...(fresh ? { fresh } : {}),
    });
  }
  return out.sort((x, y) => y.payeeIds.length - x.payeeIds.length || y.transactions - x.transactions || x.key.localeCompare(y.key));
}

/** Merges each group into its first payee, renamed, learning the others' bank texts (one undo step when called in one update). */
export function mergePayeeGroups(b: Budget, groups: { payeeIds: Id[]; name: string }[]): void {
  for (const g of groups) {
    const [targetId, ...rest] = g.payeeIds;
    if (!b.payees[targetId] || !rest.length) continue;
    renamePayee(b, targetId, g.name);
    mergePayees(b, g.payeeIds, targetId, { learnTexts: true });
  }
}

/** "Not now": the group stays hidden until another payee joins it. */
export function dismissMerge(b: Budget, g: Pick<MergeGroup, 'key' | 'payeeIds'>): void {
  b.dismissedMerges = { ...b.dismissedMerges, [g.key]: [...g.payeeIds] };
}

/** "Keep separate": these payees are never offered for merging again. */
export function keepSeparate(b: Budget, ids: Id[]): void {
  for (const id of ids) if (b.payees[id]) b.payees[id].noMerge = true;
}
