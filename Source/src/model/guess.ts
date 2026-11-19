import { today as localToday } from './dates';
import { guessClues, mergeKey, merchantOf, textKey, type Merchant } from './merchant';
import { INCOME_NEXT, INCOME_NOW, SPLIT, type Budget, type Id, type ISODate, type Money, type Transaction } from './types';

// Guessing a transaction's category from what was chosen before.
//
// YNAB4 kept one "remembered category" per payee, and in the user's budgets it was blank for
// 80-86% of payees that had plenty of history, so exact payee matches often got no category.
// Here the guess always comes from the transactions themselves: the category most used with
// this payee recently, preferring past transactions of the same amount (regular bills, money
// to the same person). It learns from every correction automatically, and only from approved
// transactions, so a wrong guess nobody has checked can't teach itself.
//
// Imports (1.3) go further when the payee isn't known: the same bank text as before, the same
// merchant ("tesco stores"), then the words in the text. Design and measurements:
// docs/plans/1.3-smarter-import.md §6.

interface Use {
  categoryId: Id;
  amount: Money;
  date: ISODate;
}

export interface CategoryGuess {
  categoryId: Id;
  /** How many of the past transactions considered used this category... */
  uses: number;
  /** ...out of how many. */
  of: number;
}

/** How many recent transactions to learn from. */
const RECENT = 10;

// Cached per transactions object (it's replaced whenever a transaction changes in the app),
// and also checked against the transaction count in case a budget is changed in place.
const historyCache = new WeakMap<object, { count: number; history: Map<string, Use[]> }>();

/** Key for transactions with a payee. */
export const payeeKey = (payeeId: Id) => 'p:' + payeeId;
/** Key for transfers to an account (only those to off-budget accounts have categories). */
export const transferKey = (accountId: Id) => 't:' + accountId;

const usable = (b: Budget, c: Id | null | undefined): c is Id =>
  !!c && c !== SPLIT && (c === INCOME_NOW || c === INCOME_NEXT || !!b.categories[c]);

/** The key a transaction's category is remembered under: its payee, or the account it transfers to. */
const historyKey = (t: Transaction) => (t.transferAccountId ? transferKey(t.transferAccountId) : t.payeeId ? payeeKey(t.payeeId) : null);

/** Transactions to learn from, oldest first: approved, in budget accounts, with a category. */
function learnable(b: Budget): Transaction[] {
  return Object.values(b.transactions)
    .filter((t) => t.accepted !== false && usable(b, t.categoryId) && b.accounts[t.accountId]?.onBudget)
    .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

/**
 * Past categorised transactions in budget accounts, oldest first, by payee and by transfer
 * account. Cached for each version of the budget.
 */
export function categoryHistory(b: Budget): Map<string, Use[]> {
  const count = Object.keys(b.transactions).length;
  const cached = historyCache.get(b.transactions);
  if (cached && cached.count === count) return cached.history;
  const out = new Map<string, Use[]>();
  for (const t of learnable(b)) {
    const key = historyKey(t);
    if (key) push(out, key, { categoryId: t.categoryId!, amount: t.amount, date: t.date });
  }
  historyCache.set(b.transactions, { count, history: out });
  return out;
}

function push<V>(m: Map<string, V[]>, k: string, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/**
 * The vote of past uses for an amount: among the last few, those with the same amount count
 * first; the most used category wins, and a tie goes to the most recent. `others` are the
 * runners-up, best first.
 */
function vote(list: Use[] | undefined, amount: Money): (CategoryGuess & { others: Id[] }) | null {
  if (!list?.length) return null;
  const recent = list.slice(-RECENT);
  const sameAmount = recent.filter((u) => u.amount === amount);
  const pool = sameAmount.length ? sameAmount : recent;
  const counts = new Map<Id, { n: number; last: number }>();
  pool.forEach((u, i) => {
    const c = counts.get(u.categoryId) || { n: 0, last: 0 };
    c.n++;
    c.last = i;
    counts.set(u.categoryId, c);
  });
  const ranked = [...counts.entries()].sort((x, y) => y[1].n - x[1].n || y[1].last - x[1].last);
  return { categoryId: ranked[0][0], uses: ranked[0][1].n, of: pool.length, others: ranked.slice(1).map(([c]) => c) };
}

/**
 * The category to suggest for a transaction with this payee (or transfer account) and amount,
 * or null if there is no history. Among the last few uses, those with the same amount count
 * first; the most used category wins, and a tie goes to the most recent.
 */
export function guessCategory(
  b: Budget,
  key: string,
  amount: Money,
  before?: ISODate,
  /** Pass categoryHistory(b) when guessing many rows at once (an import), to look it up once. */
  history: Map<string, Use[]> = categoryHistory(b),
): CategoryGuess | null {
  let list = history.get(key);
  // `before` limits the history to earlier dates (used to replay past imports in tests).
  if (list && before) list = list.filter((u) => u.date < before);
  const v = vote(list, amount);
  return v && { categoryId: v.categoryId, uses: v.uses, of: v.of };
}

/** A short explanation of a guess for the import review, e.g. "8 of the last 10". */
export function describeGuess(g: CategoryGuess): string {
  if (g.of === 1) return 'used last time';
  if (g.uses === g.of) return `all of the last ${g.of}`;
  return `${g.uses} of the last ${g.of}`;
}

// ---- Imports (1.3) --------------------------------------------------------------------------

/** Where an import guess came from: the payee's history, the same bank text, the same merchant, or the words. */
export type GuessSource = 'payee' | 'text' | 'merchant' | 'words';

export interface ImportGuess extends CategoryGuess {
  source: GuessSource;
  /** "confident" guesses are nearly always right; "suggested" ones are shown as such and wait for you. */
  tier: 'confident' | 'suggested';
  /** Why, e.g. "all of the last 6", `like 12 earlier "tesco stores"`, "words: cafe, coffee". */
  reason: string;
  /** The next most likely categories, best first (up to 2). */
  alternatives: Id[];
}

/** Confident: all of at least 3, or at least 80% of at least 5. Word guesses are always "suggested". */
export function tierOf(source: GuessSource, v: { uses: number; of: number }): ImportGuess['tier'] {
  if (source === 'words') return 'suggested';
  return (v.uses === v.of && v.of >= 3) || (v.of >= 5 && v.uses / v.of >= 0.8) ? 'confident' : 'suggested';
}

/** How many years of imported rows the word model learns from. */
const WORD_YEARS = 3;
/** A merchant vote needs this share of its pool; a word guess this probability. */
const MERCHANT_SHARE = 0.6;
const WORD_PROBABILITY = 0.8;

/** A multinomial Naive Bayes over bank-text clues, with a sliding window of years. */
class WordModel {
  private n = 0;
  private docs = new Map<Id, number>();
  private tokens = new Map<Id, number>();
  private counts = new Map<string, Map<Id, number>>();
  private queue: { clues: string[]; categoryId: Id; date: ISODate }[] = [];
  private head = 0;

  add(clues: string[], categoryId: Id, date: ISODate, w = 1): void {
    this.n += w;
    this.docs.set(categoryId, (this.docs.get(categoryId) || 0) + w);
    for (const x of clues) {
      let m = this.counts.get(x);
      if (!m) this.counts.set(x, (m = new Map()));
      m.set(categoryId, (m.get(categoryId) || 0) + w);
      this.tokens.set(categoryId, (this.tokens.get(categoryId) || 0) + w);
    }
    if (w > 0) this.queue.push({ clues, categoryId, date });
  }

  /** Forgets rows dated before `date`. */
  forgetBefore(date: ISODate): void {
    while (this.head < this.queue.length && this.queue[this.head].date < date) {
      const x = this.queue[this.head++];
      this.add(x.clues, x.categoryId, x.date, -1);
    }
  }

  /** Categories with their probabilities, best first; null when no clue is known. */
  rank(clues: string[]): { categoryId: Id; p: number }[] | null {
    const known = clues.filter((x) => this.counts.has(x));
    if (!known.length) return null;
    const alpha = 0.1;
    const v = this.counts.size;
    const c = this.docs.size;
    const scores: [Id, number][] = [];
    for (const [cat, nd] of this.docs) {
      if (nd <= 0) continue;
      let s = Math.log((nd + 1) / (this.n + c));
      const tc = this.tokens.get(cat) || 0;
      for (const x of known) s += Math.log(((this.counts.get(x)!.get(cat) || 0) + alpha) / (tc + alpha * v));
      scores.push([cat, s]);
    }
    if (!scores.length) return null;
    scores.sort((x, y) => y[1] - x[1]);
    const top = scores[0][1];
    let z = 0;
    for (const [, s] of scores) z += Math.exp(s - top);
    return scores.map(([categoryId, s]) => ({ categoryId, p: Math.exp(s - top) / z }));
  }

  /** The clues that most point to `categoryId` (their share of all its uses), best first. */
  strongest(clues: string[], categoryId: Id, n: number): string[] {
    const shares: [string, number][] = [];
    for (const x of clues) {
      const m = this.counts.get(x);
      if (!m) continue;
      let all = 0;
      for (const v of m.values()) all += v;
      const mine = m.get(categoryId) || 0;
      if (mine > 0 && all > 0) shares.push([x, mine / all]);
    }
    return shares.sort((a, b) => b[1] - a[1]).slice(0, n).map(([x]) => x);
  }
}

/** A bank row as the guesser sees it. */
export interface RowFacts {
  accountId: Id;
  amount: Money;
  /** textKey(): the bank text, tidied, without the row's own amount. */
  textKey: string;
  merchant: Merchant;
}

/** "3 years before" a date. */
const yearsBefore = (date: ISODate, n: number) => String(Number(date.slice(0, 4)) - n) + date.slice(4);

/**
 * Everything the import guesser has learned, from approved transactions. Built in one pass, oldest
 * first, and cached for each version of the budget (guessIndex()).
 */
export class GuessIndex {
  /** Uses by payee and by transfer account (the same keys as categoryHistory()). */
  readonly history = new Map<string, Use[]>();
  private text = new Map<string, Use[]>();
  private merchant = new Map<string, Use[]>();
  private textPayee = new Map<string, Id>();
  private keyPayees = new Map<string, Map<Id, number>>();
  private transferText = new Map<string, Id>();
  private words = new WordModel();

  constructor(private b: Budget) {}

  /** Learns one transaction. Call in date order; unapproved ones are ignored. */
  add(t: Transaction): void {
    const b = this.b;
    if (t.accepted === false) return;
    const onBudget = !!b.accounts[t.accountId]?.onBudget;
    const bankText = t.importedPayee;
    const key = bankText ? textKey(bankText, t.amount) : '';
    if (bankText && t.transferAccountId) this.transferText.set(key, t.transferAccountId);
    // Worked out once: it's the slow part of building the index.
    const m = bankText && !t.transferAccountId ? merchantOf(bankText, t.memo) : null;
    if (m && t.payeeId && b.payees[t.payeeId]) {
      this.textPayee.set(key, t.payeeId);
      const mk = mergeKey(m, t.accountId);
      if (mk) {
        let m = this.keyPayees.get(mk);
        if (!m) this.keyPayees.set(mk, (m = new Map()));
        m.set(t.payeeId, (m.get(t.payeeId) || 0) + 1);
      }
    }
    if (!onBudget || !usable(b, t.categoryId)) return;
    const use: Use = { categoryId: t.categoryId, amount: t.amount, date: t.date };
    const hk = historyKey(t);
    if (hk) push(this.history, hk, use);
    if (!m) return;
    push(this.text, key, use);
    if (m.key) push(this.merchant, m.key, use);
    this.words.add(guessClues(m, t.accountId, t.amount), t.categoryId, t.date);
  }

  /** The word model learns from the last 3 years before `date`. */
  windowAt(date: ISODate): void {
    this.words.forgetBefore(yearsBefore(date, WORD_YEARS));
  }

  /**
   * A category for an imported row: from its payee's history (`payeeKey` when the payee was
   * recognised by a rule, its name or a learned text, or `transferKey` for a transfer), then the
   * same bank text, then the same merchant, then the words. Null when nothing is sure enough.
   */
  guess(row: RowFacts, payee?: string, payeeOnly = false): ImportGuess | null {
    if (payee) {
      const v = vote(this.history.get(payee), row.amount);
      if (v) return { ...v, source: 'payee', tier: tierOf('payee', v), reason: describeGuess(v), alternatives: v.others.slice(0, 2) };
    }
    // Transfers learn only from earlier transfers to the same account.
    if (payeeOnly) return null;
    const t = vote(this.text.get(row.textKey), row.amount);
    if (t) {
      const reason =
        t.of === 1 ? 'same bank text as last time' : t.uses === t.of ? `same bank text as ${t.of} earlier` : `${t.uses} of ${t.of} with the same bank text`;
      return { ...t, source: 'text', tier: tierOf('text', t), reason, alternatives: t.others.slice(0, 2) };
    }
    const k = row.merchant.key;
    const m = k ? vote(this.merchant.get(k), row.amount) : null;
    if (m && m.uses / m.of >= MERCHANT_SHARE) {
      const reason = m.uses === m.of ? (m.of === 1 ? `like an earlier "${k}"` : `like ${m.of} earlier "${k}"`) : `${m.uses} of ${m.of} like "${k}"`;
      return { ...m, source: 'merchant', tier: tierOf('merchant', m), reason, alternatives: m.others.slice(0, 2) };
    }
    const clues = guessClues(row.merchant, row.accountId, row.amount);
    const r = this.words.rank(clues);
    if (r && r[0].p >= WORD_PROBABILITY) {
      const shown = this.words
        .strongest(clues.filter((x) => !/^(account|amt|kind):/.test(x)), r[0].categoryId, 2)
        .map((x) => (x === 'fx:1' ? 'foreign currency' : x.startsWith('cc:') ? 'country ' + x.slice(3).toUpperCase() : x));
      return {
        categoryId: r[0].categoryId,
        uses: 0,
        of: 0,
        source: 'words',
        tier: 'suggested',
        reason: shown.length ? 'words: ' + shown.join(', ') : 'like similar amounts in this account',
        alternatives: r.slice(1, 3).filter((x) => x.p >= 0.05).map((x) => x.categoryId),
      };
    }
    return null;
  }

  /**
   * An existing payee for a bank text no rule or name recognised: the payee of the same bank text
   * last time, or failing that the payee used most with the same merchant. Never for lines with
   * no name or only a payment processor (mergeKey()).
   */
  proposePayee(row: RowFacts): { payeeId: Id; via: 'text' | 'merchant' } | null {
    const byText = this.textPayee.get(row.textKey);
    if (byText && this.b.payees[byText]) return { payeeId: byText, via: 'text' };
    const mk = mergeKey(row.merchant, row.accountId);
    const counts = mk ? this.keyPayees.get(mk) : undefined;
    if (!counts) return null;
    let best: Id | null = null;
    let most = 0;
    for (const [id, n] of counts) {
      if (n > most && this.b.payees[id]) {
        best = id;
        most = n;
      }
    }
    return best ? { payeeId: best, via: 'merchant' } : null;
  }

  /** The account the same bank text was a transfer to last time, if any. */
  transferFor(row: RowFacts): Id | undefined {
    const to = this.transferText.get(row.textKey);
    // Never a closed account: a transfer there now would be a mistake.
    return to && to !== row.accountId && this.b.accounts[to] && !this.b.accounts[to].closed ? to : undefined;
  }
}

const indexCache = new WeakMap<object, { count: number; accounts: object; categories: object; payees: object; index: GuessIndex }>();

/**
 * The import guesser's index for this version of the budget: every approved transaction, with
 * the word model learning from the last 3 years.
 */
export function guessIndex(b: Budget, today: ISODate = localToday()): GuessIndex {
  const count = Object.keys(b.transactions).length;
  const c = indexCache.get(b.transactions);
  if (c && c.count === count && c.accounts === b.accounts && c.categories === b.categories && c.payees === b.payees) return c.index;
  const index = new GuessIndex(b);
  const all = Object.values(b.transactions)
    .filter((t) => t.accepted !== false)
    .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  for (const t of all) index.add(t);
  index.windowAt(today);
  indexCache.set(b.transactions, { count, accounts: b.accounts, categories: b.categories, payees: b.payees, index });
  return index;
}
