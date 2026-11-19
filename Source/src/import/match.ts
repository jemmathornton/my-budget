import { daysBetween } from '../model/dates';
import { GuessIndex, guessIndex, payeeKey, transferKey, type ImportGuess, type RowFacts } from '../model/guess';
import { merchantOf, textKey } from '../model/merchant';
import { ensurePayee, forgetDeletedImports, saveTransaction, setTransactionsDate, approveTransaction } from '../model/ops';
import { datePeers } from '../model/queries';
import { payeeMatcher, transferNeedsCategory, transferPayeeId } from '../model/queries';
import { SPLIT, type BankProfileId, type Budget, type DeletedImport, type Id, type Transaction } from '../model/types';
import { normalizeImportId, ynabImportId, type BankTxn } from './bank';
import { cleanTxn } from './profiles';

// Plans and applies a bank import, the YNAB4 way. Each row from the bank file becomes:
//  - "duplicate": already imported (same FITID, or same YNAB-style id "amount:date:n"),
//  - "deleted":   imported before and then deleted (here or in YNAB4); left out unless ticked,
//  - "match":     a transaction typed in by hand with the same amount within `matchDays`
//                 days, which is then marked as imported instead of being added again,
//  - "possible":  looks like a transaction imported from another file (same amount and bank
//                 text within 3 days) though the ids differ; left out unless ticked (1.3),
//  - "new":       added, with payee rename rules and a guessed category.

export type PlanKind = 'new' | 'match' | 'duplicate' | 'deleted' | 'possible';

export interface PlanRow {
  key: number;
  /** The row as the bank file has it. */
  src: BankTxn;
  kind: PlanKind;
  include: boolean;
  importIds: string[];
  /** The existing transaction this duplicates, matches or possibly duplicates. */
  matchId?: Id;
  payeeName: string;
  payeeId?: Id;
  transferAccountId?: Id;
  categoryId?: Id | null;
  /** Why the category was suggested, e.g. "8 of the last 10" (shown in the review). */
  categoryHint?: string;
  /** The guess behind the category, with its tier (1.3). */
  guess?: ImportGuess;
  /** Changed by hand in the review, so it's no longer a guess. */
  userSet?: boolean;
  /** The payee wasn't recognised by a rule or its name, but by the same bank text before ("text") or merchant ("merchant"). */
  payeeVia?: 'text' | 'merchant';
  /** The name a new payee would get: the bank text tidied (for "keep as a new payee"). */
  newPayeeName?: string;
  /** The same bank text was a transfer to this account last time. Only offered, never filled in. */
  transferHint?: Id;
  /**
   * A rule made this a transfer, but the same bank text was a transfer to this other account last
   * time (1.4.4). Shown as "? last time a transfer to …", and the row waits for approval.
   */
  transferCheck?: Id;
  /**
   * A rule made this a transfer to an account that has been closed since (1.4.4). The rule is
   * still followed, but shown as "? … is closed", and the row waits for approval.
   */
  transferClosed?: boolean;
  /** The memo, tidied for the bank (profiles.ts). */
  memo?: string;
  /** For "deleted" rows: when it was deleted, if known (not for deletions made in YNAB4). */
  deletedAt?: string;
  /**
   * "Don't pair" in the review: a transfer that makes its own other side instead of taking over
   * the other account's imported row (1.5.11).
   */
  noPair?: boolean;
  /** The bank gave this row an id it had used before for a different transaction. */
  reusedBankId?: boolean;
  /** For a match: the payee and category it would get as a new row instead ("New" in the review). */
  asNew?: Pick<PlanRow, 'payeeName' | 'payeeId' | 'payeeVia' | 'transferAccountId' | 'transferHint' | 'transferCheck' | 'transferClosed' | 'categoryId' | 'categoryHint' | 'guess'>;
  /** A match turned into a new row in the review: the transaction it matched, to switch back. */
  matchedTo?: Id;
}

/**
 * True when `t` has the same bank id as a row but its YNAB-style id (the bank's own date and
 * amount when it was imported) differs from the row in both date and amount. Transactions
 * without such an id (some from YNAB4) keep the plain "same bank id" rule.
 */
function bankIdReused(t: Transaction, date: string, amount: number): boolean {
  for (const id of t.importIds ?? []) {
    const m = /^YNAB:(-?[\d,]+\.\d\d):(\d{4}-\d\d-\d\d):\d+$/.exec(id);
    if (!m) continue;
    const storedAmount = Math.round(parseFloat(m[1].replace(/,/g, '')) * 100);
    return storedAmount !== amount && m[2] !== date;
  }
  return false;
}

function tidyPayee(s: string): string {
  return s.replace(/\s{2,}/g, ' ').trim();
}

const hasFitid = (t: Transaction) => !!t.importIds?.some((x) => x.startsWith('FITID:'));

/** What a plan looks things up in, built once per plan. */
interface PlanContext {
  payees: ReturnType<typeof payeeMatcher>;
  index: GuessIndex;
}

export function planImport(b: Budget, accountId: Id, txns: BankTxn[], matchDays = 10, profile: BankProfileId = 'generic'): PlanRow[] {
  const existing = Object.values(b.transactions).filter((t) => t.accountId === accountId);
  const byImportId = new Map<string, Transaction>();
  for (const t of existing) for (const id of t.importIds || []) byImportId.set(normalizeImportId(id), t);
  const deleted = new Map<string, DeletedImport>();
  for (const d of b.accounts[accountId]?.deletedImports ?? []) for (const id of d.ids) deleted.set(normalizeImportId(id), d);
  const seen = new Map<string, number>();
  const used = new Set<Id>();
  // Looked up once for the whole file (an import has hundreds of rows).
  const ctx: PlanContext = { payees: payeeMatcher(b), index: guessIndex(b) };
  // Possible duplicates: imported transactions near the file's dates, by amount.
  const dates = txns.map((t) => t.date).sort();
  const from = dates.length ? dates[0] : '';
  const to = dates.length ? dates[dates.length - 1] : '';
  const imported = new Map<number, Transaction[]>();
  for (const t of existing) {
    if (!t.importedPayee || !t.importIds?.length) continue;
    if (daysBetween(t.date, from) > 3 || daysBetween(to, t.date) > 3) continue;
    const list = imported.get(t.amount);
    if (list) list.push(t);
    else imported.set(t.amount, [t]);
  }
  return txns.map((src, key) => {
    // The n-th transaction with this amount and date in the file, as YNAB4 numbered them. Always
    // from the file's own amount: reversing a file's amounts mustn't make old rows look new.
    const fileAmount = src.fileAmount ?? src.amount;
    const k = src.date + ':' + fileAmount;
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    const ynabId = ynabImportId({ date: src.date, amount: fileAmount }, n);
    const importIds = src.fitid ? ['FITID:' + src.fitid, ynabId] : [ynabId];
    let dup = src.fitid ? byImportId.get('FITID:' + src.fitid) : undefined;
    // Some banks restart their ids (1, 2, 3... each statement). The YNAB-style id kept with an
    // imported transaction records the bank's own date and amount: if both differ from this
    // row, the bank has reused the id for a different transaction.
    let reusedBankId = false;
    if (dup && bankIdReused(dup, src.date, fileAmount)) {
      dup = undefined;
      reusedBankId = true;
    }
    if (!dup) {
      const t = byImportId.get(normalizeImportId(ynabId));
      // Only fall back to the YNAB-style id for transactions that have no FITID of their own.
      if (t && !(src.fitid && hasFitid(t))) dup = t;
    }
    const clean = cleanTxn(src, profile);
    const row: PlanRow = {
      key,
      src,
      kind: 'new',
      include: true,
      importIds,
      payeeName: clean.displayPayee,
      newPayeeName: clean.displayPayee,
      memo: clean.memo,
    };
    if (reusedBankId) row.reusedBankId = true;
    if (dup) {
      row.kind = 'duplicate';
      row.include = false;
      row.matchId = dup.id;
      // Taken: a second row like it in this file is new, not a "possible" copy of it (1.5.11).
      used.add(dup.id);
      return row;
    }
    // Deleted before: YNAB4 skipped these rows on re-import, so check before looking for a match.
    let gone = src.fitid ? deleted.get('FITID:' + src.fitid) : undefined;
    if (!gone) {
      const d = deleted.get(normalizeImportId(ynabId));
      // The same rule as for duplicates: a YNAB-style id only counts if neither side has its own FITID.
      if (d && !(src.fitid && d.ids.some((x) => x.startsWith('FITID:')))) gone = d;
    }
    const facts: RowFacts = { accountId, amount: src.amount, textKey: clean.textKey, merchant: merchantOf(src.payee, src.memo) };
    if (gone) {
      row.kind = 'deleted';
      row.include = false;
      row.deletedAt = gone.deletedAt;
      // Still work out the payee and category below, in case it's ticked.
    } else {
      let best: Transaction | undefined;
      let bestDays = Infinity;
      for (const t of existing) {
        if (t.amount !== src.amount || used.has(t.id) || t.importIds?.length || t.cleared === 'R') continue;
        const d = Math.abs(daysBetween(t.date, src.date));
        if (d <= matchDays && d < bestDays) {
          best = t;
          bestDays = d;
        }
      }
      if (best) {
        row.kind = 'match';
        row.matchId = best.id;
        used.add(best.id);
        // What it would be as a new row, for "New" in the review.
        const asNew: PlanRow = { ...row, kind: 'new' };
        planPayee(b, accountId, asNew, facts, ctx);
        const { payeeName, payeeId, payeeVia, transferAccountId, transferHint, transferCheck, transferClosed, categoryId, categoryHint, guess } = asNew;
        row.asNew = { payeeName, payeeId, payeeVia, transferAccountId, transferHint, transferCheck, transferClosed, categoryId, categoryHint, guess };
        return row;
      }
      // The same transaction imported from another file, whose ids differ (QIF has none, and
      // Santander re-dates weekend interest). Two different bank ids are two transactions.
      const twin = (imported.get(src.amount) ?? []).find(
        (t) =>
          !used.has(t.id) &&
          Math.abs(daysBetween(t.date, src.date)) <= 3 &&
          !(src.fitid && hasFitid(t)) &&
          ((!!facts.merchant.key && merchantOf(t.importedPayee!, t.memo).key === facts.merchant.key) ||
            textKey(t.importedPayee!, t.amount) === facts.textKey),
      );
      if (twin) {
        row.kind = 'possible';
        row.include = false;
        row.matchId = twin.id;
        used.add(twin.id);
      }
    }
    planPayee(b, accountId, row, facts, ctx);
    return row;
  });
}

/**
 * Works out a row's payee and category. The payee: your rename rules, then its name, then the
 * same bank text or merchant as before. The category: the guesser (guess.ts), unless the payee
 * is set never to be guessed.
 */
function planPayee(b: Budget, accountId: Id, row: PlanRow, facts: RowFacts, ctx: PlanContext): void {
  const src = row.src;
  const rule = ctx.payees.matchRules(src.payee) || (src.memo ? ctx.payees.matchRules(src.memo) : null);
  // Categories only apply in budget accounts.
  const wantsCategory = !!b.accounts[accountId]?.onBudget;
  let g: ImportGuess | null = null;
  // A rule's transfer is always filled in: old rules can be deliberate (one may skip an account the
  // money passes through). When it might be wrong, the row is flagged and waits for approval (1.4.4).
  if (rule?.transferAccountId && rule.transferAccountId !== accountId) {
    row.transferAccountId = rule.transferAccountId;
    row.payeeName = 'Transfer : ' + (b.accounts[rule.transferAccountId]?.name || '');
    if (transferNeedsCategory(b, accountId, rule.transferAccountId)) {
      g = ctx.index.guess(facts, transferKey(rule.transferAccountId), true);
      row.categoryId = g?.categoryId ?? b.payees[transferPayeeId(rule.transferAccountId)]?.autoCategoryId ?? undefined;
    }
    // The rule says one account, but the same bank text went to another last time: ask.
    const last = ctx.index.transferFor(facts);
    if (last && last !== rule.transferAccountId && !b.accounts[last]?.closed) row.transferCheck = last;
    // The rule's account has been closed since the rule was made.
    if (b.accounts[rule.transferAccountId]?.closed) row.transferClosed = true;
  } else {
    const named = rule?.payeeId
      ? b.payees[rule.payeeId]
      : ctx.payees.findByName(tidyPayee(src.payee)) || ctx.payees.findByName(row.payeeName) || ctx.payees.findByBankText(facts.textKey);
    const proposal = named ? null : ctx.index.proposePayee(facts);
    const p = named || (proposal ? b.payees[proposal.payeeId] : undefined);
    if (p) {
      row.payeeId = p.id;
      row.payeeName = p.name;
      if (proposal) row.payeeVia = proposal.via;
    }
    if (!named && proposal?.via !== 'text') {
      const to = ctx.index.transferFor(facts);
      if (to) row.transferHint = to;
    }
    if (wantsCategory && !p?.noGuess) {
      // A payee recognised by a rule or its name brings its own history; a proposed one doesn't (yet).
      g = ctx.index.guess(facts, named ? payeeKey(named.id) : undefined);
      row.categoryId = g?.categoryId ?? p?.autoCategoryId ?? undefined;
    }
  }
  if (g) {
    row.guess = g;
    row.categoryHint = g.reason;
  }
}

/**
 * A reason to think this file's amounts are the wrong way round for the account, or null.
 * Only a warning: nothing is changed by it.
 */
export function signWarning(b: Budget, accountId: Id, txns: BankTxn[]): string | null {
  const a = b.accounts[accountId];
  if (!a) return null;
  const card = a.type === 'CreditCard' || a.type === 'LineOfCredit';
  // A card payment that comes in as spending: Barclaycard's new CSV hasn't shown one yet, and a
  // CSV has no balance to check against (1.5.3). Checked however short the file is.
  if (card) {
    // Card payments read "PAYMENT, THANK YOU", "DIRECT DEBIT PAYMENT" or similar; a shop named
    // "… PAYMENTS" isn't one, and a payment reversed or returned is rightly money out.
    // A type column saying "Payment" or "Refund" settles it (Barclaycard's CSV has one).
    const paid = txns.filter((t) => {
      const text = `${t.payee} ${t.memo}`;
      return (
        t.amount < 0 &&
        !/\b(reversal|reversed|returned|unpaid)\b/i.test(text) &&
        (/^(payments?|repayment|refund|credit)$/i.test(t.kind ?? '') || /\b(payment received|thank you|direct debit)\b|^\s*payment\b/i.test(text))
      );
    });
    if (paid.length)
      return `${paid.length === 1 ? 'A row that looks like a card payment comes' : `${paid.length} rows that look like card payments come`} in as spending ("${(paid[0].payee.trim() || paid[0].memo.trim()).slice(0, 40)}"). A payment to the card should be money in: check the amounts.`;
  }
  if (txns.length < 5) return null;
  const moneyIn = txns.filter((t) => t.amount > 0).length;
  if (card && moneyIn / txns.length >= 0.8) {
    return `${moneyIn} of ${txns.length} rows are money in. On a credit card most rows are spending, so this file may show amounts the wrong way round.`;
  }
  // Rows that match transactions already in the account only with the opposite sign.
  const byAmount = new Map<number, string[]>();
  for (const t of Object.values(b.transactions)) {
    if (t.accountId !== accountId) continue;
    const list = byAmount.get(t.amount);
    if (list) list.push(t.date);
    else byAmount.set(t.amount, [t.date]);
  }
  const near = (amount: number, date: string) => (byAmount.get(amount) ?? []).some((d) => Math.abs(daysBetween(d, date)) <= 3);
  let same = 0;
  let flipped = 0;
  for (const t of txns) {
    if (!t.amount) continue;
    if (near(t.amount, t.date)) same++;
    else if (near(-t.amount, t.date)) flipped++;
  }
  return flipped >= 3 && flipped > 2 * same
    ? `${flipped} rows match transactions already in this account only with the opposite sign, so this file may show amounts the wrong way round.`
    : null;
}

/**
 * Which rows of an import are alike, for "Also set the other rows like this": the same merchant,
 * or any foreign-currency row. '' for rows that are never offered (no name).
 */
export function similarKey(r: PlanRow): string {
  const m = merchantOf(r.src.payee, r.src.memo);
  return m.foreign ? 'fx' : m.key;
}

/**
 * A row whose category is still the guesser's "suggested" one, or a rule transfer whose bank text
 * went to another account last time: it waits for approval even when imports are approved
 * automatically.
 */
export function unconfirmedGuess(r: PlanRow): boolean {
  // The account is only confirmed by "Use it" or accepting the row (which clear transferCheck and
  // transferClosed), not by other changes to the row.
  if (r.transferCheck || r.transferClosed) return true;
  return !!r.guess && r.guess.tier === 'suggested' && !r.userSet && r.categoryId === r.guess.categoryId;
}

/**
 * The other account's row a transfer row would pair with on import: the nearest in date of its
 * imported rows with the opposite amount, within 3 days, that isn't already a transfer or a split.
 * `claimed`: rows already taken by earlier rows of the same file (the review's preview).
 */
export function transferPairFor(b: Budget, r: PlanRow, claimed?: Set<Id>): Transaction | undefined {
  if (!r.transferAccountId) return undefined;
  let other: Transaction | undefined;
  for (const u of Object.values(b.transactions)) {
    if (u.accountId !== r.transferAccountId || u.amount !== -r.src.amount || u.transferAccountId) continue;
    if (u.categoryId === SPLIT || !u.importIds?.length || claimed?.has(u.id)) continue;
    const gap = Math.abs(daysBetween(u.date, r.src.date));
    if (gap <= 3 && (!other || gap < Math.abs(daysBetween(other.date, r.src.date)))) other = u;
  }
  return other;
}

/** For each row of a plan, the row it would pair with on import, in the order the import goes. */
export function transferPairs(b: Budget, plan: PlanRow[]): Map<number, Transaction> {
  const out = new Map<number, Transaction>();
  const claimed = new Set<Id>();
  for (const r of plan) {
    if (!r.include || r.noPair || !r.transferAccountId || r.kind === 'match' || r.kind === 'duplicate') continue;
    const u = transferPairFor(b, r, claimed);
    if (u) {
      out.set(r.key, u);
      claimed.add(u.id);
    }
  }
  return out;
}

/** Applies a reviewed plan. Returns how many were added and matched. */
export function applyImport(b: Budget, accountId: Id, plan: PlanRow[], approve = false): { added: number; matched: number } {
  let added = 0;
  let matched = 0;
  for (const r of plan) {
    if (!r.include) continue;
    const memo = r.memo ?? r.src.memo;
    if (r.kind === 'match' && r.matchId && b.transactions[r.matchId]) {
      const t = b.transactions[r.matchId];
      // Until it's approved, keep what the match changed, so it shows as "Bank: / Yours:" and
      // can be unmatched (YNAB4).
      if (!approve) {
        t.matched = {
          bank: { date: r.src.date, amount: r.src.amount, payee: r.src.payee, memo: memo || undefined, check: r.src.check },
          importIds: r.importIds,
          yours: { date: t.date, cleared: t.cleared, accepted: t.accepted, importedPayee: t.importedPayee },
        };
        if (!t.matched.bank.memo) delete t.matched.bank.memo;
        if (!t.matched.bank.check) delete t.matched.bank.check;
        if (!t.matched.yours.importedPayee) delete t.matched.yours.importedPayee;
        t.accepted = false;
      } else {
        // Approved straight away, as the import says (a scheduled transaction arrives unapproved);
        // otherwise it would look like the extra copy of a payment the bank took early (1.5.3).
        // A scheduled transfer's other side is approved with it.
        approveTransaction(b, t.id);
      }
      t.importIds = [...(t.importIds || []), ...r.importIds];
      t.importedPayee = r.src.payee;
      // Only a date typed in by hand (uncleared) takes the bank's date, with its transfer peers
      // and split-line peers. A cleared one keeps its date: re-importing an old file mustn't
      // move existing transfers. Nor does the far side of a transfer an import made (uncleared,
      // but its other side carries that bank's date), 1.5.3.
      // Every other side that would move with it (a split's lines too) must be typed and unreconciled (1.5.11).
      const typed = t.cleared === 'U' && datePeers(b, t).every((u) => !u.importIds?.length && u.cleared !== 'R');
      if (t.cleared === 'U') t.cleared = 'C';
      if (typed && t.date !== r.src.date) setTransactionsDate(b, [t.id], r.src.date);
      matched++;
      continue;
    }
    if (r.kind === 'duplicate') continue;
    // A previously deleted row that was ticked: import it again and forget that it was deleted.
    if (r.kind === 'deleted') forgetDeletedImports(b, accountId, r.importIds);
    // Suggested guesses nobody has confirmed wait for approval, even with "Approve automatically".
    const accepted = approve && !unconfirmedGuess(r);

    if (r.transferAccountId) {
      // If the other account's side was already imported from its own bank file, pair with it
      // instead of creating a second copy of the transfer: the nearest in date of its imported
      // rows with the opposite amount, within 3 days, that isn't already a transfer or a split.
      // A match waiting for approval counts too (a payment typed by hand, then matched by its
      // own file): it's settled as matched, or the transfer would add the payment twice (1.5.3).
      // The review shows which one (1.5.11), and "Don't pair" leaves it alone.
      const other = r.noPair ? undefined : transferPairFor(b, r);
      if (other) {
        delete other.matched;
        // A transfer has one date (1.5.3): the earlier of the two banks' dates, the day the money
        // left. A later one could fall after this file's last row, and then the balance check
        // would leave it out and "imported up to" would run past the file. A reconciled side keeps its date.
        const date = other.cleared !== 'R' && r.src.date < other.date ? r.src.date : other.date;
        other.date = date;
        const id = saveTransaction(b, {
          accountId,
          date,
          transferAccountId: r.transferAccountId,
          amount: r.src.amount,
          cleared: 'C',
          memo,
          categoryId: r.categoryId ?? null,
          importIds: r.importIds,
          importedPayee: r.src.payee,
          accepted,
        });
        const t = b.transactions[id];
        if (t.transferTxId && t.transferTxId !== other.id) delete b.transactions[t.transferTxId];
        t.transferTxId = other.id;
        other.transferAccountId = accountId;
        other.transferTxId = id;
        other.payeeId = transferPayeeId(accountId);
        if (!transferNeedsCategory(b, other.accountId, accountId)) other.categoryId = null;
        added++;
        continue;
      }
    }

    saveTransaction(b, {
      accountId,
      date: r.src.date,
      payeeId: r.transferAccountId ? undefined : r.payeeId || ensurePayee(b, r.payeeName),
      transferAccountId: r.transferAccountId,
      categoryId: r.categoryId ?? null,
      memo,
      amount: r.src.amount,
      cleared: 'C',
      check: r.src.check,
      importIds: r.importIds,
      importedPayee: r.src.payee,
      accepted,
    });
    added++;
  }
  return { added, matched };
}

/**
 * YNAB4's Match (1.5.6): a transaction you entered and a bank row in the same account become one,
 * as if the import had matched them. Yours keeps its payee, category and memo, and takes the
 * bank's reference (and its amount, if they differ); a date typed by hand takes the bank's date,
 * as an import does. It then waits for approval as "Bank: / Yours:", and Unmatch puts the two
 * back. Returns why they can't be matched, or null when done.
 */
export function matchTransactions(b: Budget, aId: Id, bId: Id): string | null {
  const x = b.transactions[aId];
  const y = b.transactions[bId];
  if (!x || !y) return 'One of them has gone.';
  if (x.accountId !== y.accountId) return 'They need to be in the same account.';
  const xBank = !!x.importIds?.length;
  if (xBank === !!y.importIds?.length) return 'Choose one transaction you entered and one from the bank.';
  const [t, bank] = xBank ? [y, x] : [x, y];
  if (t.matched || bank.matched) return 'One of them is matched already: Unmatch it first.';
  if (bank.splits?.length) return "The bank's transaction is split. Match first, then split.";
  // A transfer the import paired with the other account's own bank row can't just go: that row
  // would go with it.
  const far = bank.transferTxId ? b.transactions[bank.transferTxId] : undefined;
  if (far?.importIds?.length) return `The bank's transaction is paired with ${b.accounts[far.accountId]?.name ?? 'another account'}'s bank row. Change it to a payment first.`;
  if (bank.transferSplitParentId) return "The bank's transaction belongs to a split in another account.";
  // The bank's row goes: if it's reconciled, the reconciled balance would change (1.5.10).
  if (bank.cleared === 'R' || far?.cleared === 'R') return "The bank's transaction is reconciled: matching it would change the reconciled balance. Delete the one you entered instead.";
  const amountDiffers = t.amount !== bank.amount;
  if (amountDiffers && (t.splits?.length || t.transferSplitParentId)) return 'The amounts differ, and yours is split: make the amounts the same first.';
  // Yours would take the bank's amount, and a transfer's other side with it: not if either is
  // reconciled, or the other side's own bank says what it was.
  const yourPeer = t.transferTxId ? b.transactions[t.transferTxId] : undefined;
  if (amountDiffers && (t.cleared === 'R' || yourPeer?.cleared === 'R')) return 'The amounts differ, and yours is reconciled: make the amounts the same first.';
  if (amountDiffers && yourPeer?.importIds?.length) return `The amounts differ, and the other side of yours came from ${b.accounts[yourPeer.accountId]?.name ?? 'another account'}'s bank: make the amounts the same first.`;

  t.matched = {
    bank: { date: bank.date, amount: bank.amount, payee: bank.importedPayee || (bank.payeeId ? (b.payees[bank.payeeId]?.name ?? '') : ''), memo: bank.memo, check: bank.check },
    importIds: [...bank.importIds!],
    yours: { date: t.date, cleared: t.cleared, accepted: t.accepted, importedPayee: t.importedPayee, amount: amountDiffers ? t.amount : undefined },
  };
  if (!t.matched.bank.memo) delete t.matched.bank.memo;
  if (!t.matched.bank.check) delete t.matched.bank.check;
  if (!t.matched.yours.importedPayee) delete t.matched.yours.importedPayee;
  if (t.matched.yours.amount === undefined) delete t.matched.yours.amount;
  // The bank's row goes, with any transfer side the import made for it. Not as a deletion: its
  // reference lives on in yours, so importing the file again finds it there.
  delete b.transactions[bank.id];
  if (far) delete b.transactions[far.id];
  t.importIds = [...(t.importIds || []), ...t.matched.importIds];
  if (bank.importedPayee) t.importedPayee = bank.importedPayee;
  if (amountDiffers) {
    t.amount = bank.amount;
    const peer = t.transferTxId ? b.transactions[t.transferTxId] : undefined;
    if (peer) peer.amount = -bank.amount;
  }
  // Every other side that would move with it (a split's lines too) must be typed and unreconciled (1.5.11).
  const typed = t.cleared === 'U' && datePeers(b, t).every((u) => !u.importIds?.length && u.cleared !== 'R');
  if (t.cleared === 'U') t.cleared = 'C';
  if (typed && t.date !== bank.date) setTransactionsDate(b, [t.id], bank.date);
  t.accepted = false;
  return null;
}

/**
 * Undoes a bank match that hasn't been approved (YNAB4's Unmatch): your transaction goes back
 * to its own date and cleared state, and the bank's row is added as a new, unapproved import
 * with the payee and category an import would give it. Returns the new transaction's id.
 */
export function unmatchTransaction(b: Budget, id: Id): Id | null {
  const t = b.transactions[id];
  const m = t?.matched;
  if (!t || !m || t.accepted) return null;
  const ids = new Set(m.importIds);
  t.importIds = (t.importIds || []).filter((x) => !ids.has(x));
  if (!t.importIds.length) delete t.importIds;
  if (m.yours.importedPayee) t.importedPayee = m.yours.importedPayee;
  else delete t.importedPayee;
  t.cleared = m.yours.cleared;
  // A manual match with a different amount took the bank's (1.5.6).
  if (m.yours.amount !== undefined) {
    t.amount = m.yours.amount;
    const peer = t.transferTxId ? b.transactions[t.transferTxId] : undefined;
    if (peer) peer.amount = -m.yours.amount;
  }
  if (t.date !== m.yours.date) setTransactionsDate(b, [t.id], m.yours.date);
  t.accepted = m.yours.accepted;
  delete t.matched;
  // The bank's row, with its original import ids and the payee and category an import gives it.
  const src: BankTxn = { date: m.bank.date, amount: m.bank.amount, payee: m.bank.payee, memo: m.bank.memo || '', check: m.bank.check };
  const clean = cleanTxn(src, b.accounts[t.accountId]?.bankProfile ?? 'generic');
  const row: PlanRow = { key: 0, src, kind: 'new', include: true, importIds: m.importIds, payeeName: clean.displayPayee, memo: clean.memo };
  // Built afresh: this runs inside an edit, where the cached index may not see the change above.
  const index = new GuessIndex(b);
  for (const x of Object.values(b.transactions).sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0))) index.add(x);
  index.windowAt(m.bank.date);
  const facts: RowFacts = { accountId: t.accountId, amount: src.amount, textKey: clean.textKey, merchant: merchantOf(src.payee, src.memo) };
  planPayee(b, t.accountId, row, facts, { payees: payeeMatcher(b), index });
  const before = new Set(Object.keys(b.transactions));
  applyImport(b, t.accountId, [row], false);
  return Object.keys(b.transactions).find((k) => !before.has(k) && b.transactions[k].accountId === t.accountId) ?? null;
}
