// The budget data model. It is saved as plain JSON in a .budget file.
//
// Amounts are integer minor units (pence for GBP). Dates are "YYYY-MM-DD" strings
// and months are "YYYY-MM" strings, so both sort correctly as text. Records are
// stored in objects keyed by id.
//
// The format is compatible with budgets created by the earlier single-file version
// of My Budget ("ynab-clone" format, version 1). New optional fields may be added;
// existing fields must keep their meaning.

export type Id = string;
/** Integer minor units, e.g. pence. */
export type Money = number;
/** "YYYY-MM-DD" */
export type ISODate = string;
/** "YYYY-MM" */
export type MonthKey = string;

/** "Income for this month" (YNAB4 Category/__ImmediateIncome__). */
export const INCOME_NOW = '__income_now__';
/** "Income for next month" (YNAB4 Category/__DeferredIncome__). */
export const INCOME_NEXT = '__income_next__';
/** The category of a split transaction; the real categories are on its splits. */
export const SPLIT = '__split__';

export const BUDGET_FORMAT = 'ynab-clone';
export const BUDGET_VERSION = 1;

export type AccountType =
  | 'Checking'
  | 'Savings'
  | 'CreditCard'
  | 'Cash'
  | 'LineOfCredit'
  | 'Paypal'
  | 'MerchantAccount'
  | 'InvestmentAccount'
  | 'Mortgage'
  | 'OtherAsset'
  | 'OtherLiability';

/** Account types that are normally on budget (YNAB4 "Budget accounts"). */
export const BUDGET_ACCOUNT_TYPES: AccountType[] = [
  'Checking',
  'Savings',
  'CreditCard',
  'Cash',
  'LineOfCredit',
  'Paypal',
  'MerchantAccount',
];
/** Account types that are normally off budget (YNAB4 "Off-budget accounts"). */
export const TRACKING_ACCOUNT_TYPES: AccountType[] = ['InvestmentAccount', 'Mortgage', 'OtherAsset', 'OtherLiability'];
/** Spending from these accounts is "credit" overspending. Only with settings.creditOverspendingToDebt (new-YNAB style) is it handled differently from cash; YNAB4 treated both alike. */
export const CREDIT_ACCOUNT_TYPES: AccountType[] = ['CreditCard', 'LineOfCredit'];

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  Checking: 'Current / Checking',
  Savings: 'Savings',
  CreditCard: 'Credit Card',
  Cash: 'Cash',
  LineOfCredit: 'Line of Credit',
  Paypal: 'PayPal',
  MerchantAccount: 'Merchant Account',
  InvestmentAccount: 'Investment Account',
  Mortgage: 'Mortgage',
  OtherAsset: 'Other Asset',
  OtherLiability: 'Other Liability',
};

/** Column mapping remembered for an account's CSV imports. */
export interface CsvMapping {
  delimiter: string;
  hasHeader: boolean;
  skipRows: number;
  dateCol: number;
  dateFormat: string;
  payeeCol: number;
  memoCol: number;
  amountMode: 'single' | 'split';
  amountCol: number;
  inflowCol: number;
  outflowCol: number;
  invert: boolean;
  refCol: number;
  /**
   * The header row this mapping was made for (lower case). A file whose header differs gets the
   * column screen again instead of being read with the old columns. Added in 1.1.3.
   */
  header?: string[];
}

/** An imported transaction that was deleted. Remembered so that importing the same bank row again doesn't bring it back. */
export interface DeletedImport {
  /** Its import ids, exactly as they were in Transaction.importIds. */
  ids: string[];
  /** When it was deleted (ISO). Not known for deletions made in YNAB4. */
  deletedAt?: string;
}

export interface Account {
  id: Id;
  name: string;
  type: AccountType;
  onBudget: boolean;
  closed: boolean;
  note?: string;
  sort: number;
  lastReconciledDate?: ISODate;
  lastReconciledBalance?: Money;
  /**
   * Keys seen in imports, used to pick this account for a bank file: "ofx:<bank>:<account>",
   * and since 1.3.2 "card:1234" / "name:1234" (only ever the last 4 digits), "shape:<file name
   * shape>" and "csv:<header row>" (src/import/inbox.ts).
   */
  importKeys?: string[];
  csvMapping?: CsvMapping;
  /**
   * Imported transactions deleted from this account, from YNAB4's deleted records and from
   * deletions in My Budget. Added in 1.1.3; older versions keep it but don't use it.
   */
  deletedImports?: DeletedImport[];
  /**
   * This account's QIF / OFX files show amounts the wrong way round (spending as money in).
   * CSV files use csvMapping.invert instead. Added in 1.1.3.
   */
  importReverse?: { qif?: boolean; ofx?: boolean };
  /** Which bank's quirks this account's downloads have, as last detected. Added in 1.3. */
  bankProfile?: BankProfileId;
  /** The latest bank date an import into this account covered, and when that import was. Added in 1.3.2. */
  lastImport?: { to: ISODate; at: string };
  /** The bank's balance in the latest OFX import, at its last row's date, and the register's difference. Added in 1.3.2. */
  lastBankBalance?: { date: ISODate; amount: Money; difference: Money };
}

/** A bank's download format, for tidying its quirks before importing (src/import/profiles.ts). */
export type BankProfileId =
  | 'nationwide'
  | 'santander'
  | 'barclaycard'
  | 'barclays-csv'
  | 'amex'
  | 'halifax'
  | 'first-direct'
  | 'generic';

export interface MasterCategory {
  id: Id;
  name: string;
  sort: number;
  collapsed?: boolean;
  note?: string;
}

export interface Category {
  id: Id;
  masterId: Id;
  name: string;
  sort: number;
  hidden: boolean;
  /** A note that applies to every month (YNAB4 sub-category note). */
  note?: string;
}

/**
 * How a negative balance is handled.
 * - "buffer": YNAB4 default. The overspending is taken from next month's Available to Budget.
 * - "carry":  YNAB4 "Carry overspending forward" (overspendingHandling "Confined"). The negative
 *             balance stays in the category. The setting carries on into later months until changed.
 */
export type OverspendingHandling = 'buffer' | 'carry';

export interface CategoryMonth {
  budgeted: Money;
  handling?: OverspendingHandling;
  /** A note for this category in this month (YNAB4 keeps category notes per month). */
  note?: string;
}

export type PayeeRuleOp = 'is' | 'contains' | 'startsWith' | 'endsWith';

export interface PayeeRule {
  op: PayeeRuleOp;
  text: string;
}

export interface PayeeLocation {
  latitude: number;
  longitude: number;
}

export interface Payee {
  id: Id;
  name: string;
  autoCategoryId?: Id | null;
  autoMemo?: string | null;
  autoAmount?: Money | null;
  /** Imported payee names that are renamed to this payee. */
  rules: PayeeRule[];
  /** Set on the special "Transfer : <account>" payees. Their id is "Payee/Transfer:<accountId>". */
  transferAccountId?: Id;
  hidden?: boolean;
  /** Kept from YNAB4 (recorded by its mobile app); not used for anything else. */
  locations?: PayeeLocation[];
  /** Never guess a category for this payee when importing (a cash machine, say). Added in 1.3. */
  noGuess?: boolean;
  /**
   * Bank texts learned for this payee when payees were merged (textKey() form: tidied, lower
   * case, without the row's own amount). Recognised on import after your own rename rules, and
   * not shown as rules. Added in 1.3.1.
   */
  bankTexts?: string[];
  /** Never offer this payee in merge suggestions ("Keep separate"). Added in 1.3.1. */
  noMerge?: boolean;
}

/** U = uncleared, C = cleared, R = reconciled. */
export type Cleared = 'U' | 'C' | 'R';

export type Flag = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';
export const FLAGS: Flag[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];

export interface Split {
  id: Id;
  categoryId: Id | null;
  amount: Money;
  memo?: string;
  payeeId?: Id;
  /** A split line can be a transfer to another account. */
  transferAccountId?: Id;
  /** The transaction in the other account that this split line is paired with. */
  transferTxId?: Id;
}

export interface Transaction {
  id: Id;
  accountId: Id;
  date: ISODate;
  payeeId?: Id;
  /** null = uncategorised (or a transfer between two budget accounts). SPLIT for split transactions. */
  categoryId: Id | null;
  memo?: string;
  amount: Money;
  cleared: Cleared;
  /** false while an imported transaction is waiting to be approved. */
  accepted: boolean;
  flag?: Flag;
  /** Cheque number. */
  check?: string;
  /** "FITID:..." from OFX/QFX/CSV files, and YNAB4-style "YNAB:amount:date:n" ids. */
  importIds?: string[];
  /** The payee text as it came from the bank. */
  importedPayee?: string;
  transferAccountId?: Id;
  /** The paired transaction in the other account. */
  transferTxId?: Id;
  /** Set when this transaction is paired with one split line of a transaction in another account. */
  transferSplitParentId?: Id;
  splits?: Split[];
  /** The scheduled transaction this was entered from. */
  scheduleId?: Id;
  /**
   * Set while a bank import matched to this transaction waits to be approved, so it can be
   * shown as "Bank: / Yours:" and unmatched, as in YNAB4. Removed when approved.
   */
  matched?: MatchedImport;
}

/** What a bank-import match changed, kept until it is approved (see Transaction.matched). */
export interface MatchedImport {
  /** The bank's row, as read from the file. */
  bank: { date: ISODate; amount: Money; payee: string; memo?: string; check?: string };
  /** The import ids the match added. */
  importIds: string[];
  /** This transaction before the match. */
  yours: { date: ISODate; cleared: Cleared; accepted: boolean; importedPayee?: string; amount?: Money };
}

export type Frequency =
  | 'Once'
  | 'Daily'
  | 'Weekly'
  | 'EveryOtherWeek'
  | 'TwiceAMonth'
  | 'Every4Weeks'
  | 'Monthly'
  | 'EveryOtherMonth'
  | 'Every3Months'
  | 'Every4Months'
  | 'TwiceAYear'
  | 'Yearly'
  | 'EveryOtherYear';

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  Once: 'Once',
  Daily: 'Daily',
  Weekly: 'Weekly',
  EveryOtherWeek: 'Every other week',
  TwiceAMonth: 'Twice a month',
  Every4Weeks: 'Every 4 weeks',
  Monthly: 'Monthly',
  EveryOtherMonth: 'Every other month',
  Every3Months: 'Every 3 months',
  Every4Months: 'Every 4 months',
  TwiceAYear: 'Twice a year',
  Yearly: 'Yearly',
  EveryOtherYear: 'Every other year',
};

export interface ScheduledTransaction {
  id: Id;
  accountId: Id;
  /** The next date it is due. */
  date: ISODate;
  /** The first date. Its day of the month is the anchor for monthly frequencies (so 31st stays 31st). */
  startDate: ISODate;
  frequency: Frequency;
  /** For TwiceAMonth: the second day of the month (0 = last day of the month). */
  twiceMonthDay2?: number;
  payeeId?: Id;
  categoryId: Id | null;
  memo?: string;
  amount: Money;
  flag?: Flag;
  check?: string;
  transferAccountId?: Id;
  splits?: Split[];
  /** Optional last date. No transactions are entered after it. */
  endDate?: ISODate;
}

export interface Currency {
  /** ISO code, e.g. "GBP". */
  code: string;
  symbol: string;
  /** Used for digit grouping and the decimal mark, e.g. "en-GB" or "de-DE". */
  locale: string;
  decimals: number;
  symbolFirst: boolean;
}

export type DateFormat = 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'DD.MM.YYYY';

export interface BudgetSettings {
  /**
   * Off (default, matches YNAB4 as the user's data shows): credit-card overspending is taken from next
   * month's Available to Budget like cash overspending. On: it is left as card debt instead.
   */
  creditOverspendingToDebt?: boolean;
  /** How many days apart a bank transaction and one typed in by hand can be and still match. Default 10. */
  matchDays?: number;
  /** Approve imported transactions straight away. */
  autoApproveImports?: boolean;
  /**
   * What choosing a payee fills in, for all payees (YNAB4's "Autocomplete (all payees)").
   * Missing parts take YNAB4's defaults: category on, memo and amount off.
   */
  autoFill?: { category?: boolean; memo?: boolean; amount?: boolean };
  /** When "Read deletions from YNAB4" last ran on this budget (ISO). */
  ynab4DeletionsReadAt?: string;
}

export interface Budget {
  format: typeof BUDGET_FORMAT;
  version: number;
  id: Id;
  name: string;
  currency: Currency;
  dateFormat: DateFormat;
  accounts: Record<Id, Account>;
  masters: Record<Id, MasterCategory>;
  categories: Record<Id, Category>;
  months: Record<MonthKey, Record<Id, CategoryMonth>>;
  /** A note for the whole month. */
  monthNotes?: Record<MonthKey, string>;
  payees: Record<Id, Payee>;
  transactions: Record<Id, Transaction>;
  scheduled: Record<Id, ScheduledTransaction>;
  createdAt: string;
  modifiedAt: string;
  importedFrom?: string;
  /** Set on a budget created by Fresh Start: the file it was started from. */
  freshStartFrom?: string;
  /** Merge suggestions dismissed with "Not now": group key -> the payees in it then. Added in 1.3.1. */
  dismissedMerges?: Record<string, Id[]>;
  settings: BudgetSettings;
}
