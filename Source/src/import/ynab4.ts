import { newBudget } from '../model/budget';
import { isISODate } from '../model/dates';
import { toMinor } from '../model/money';
import { addDeletedImports } from '../model/ops';
import {
  FLAGS,
  INCOME_NEXT,
  INCOME_NOW,
  SPLIT,
  type AccountType,
  type Budget,
  type CategoryMonth,
  type Cleared,
  type DeletedImport,
  type Flag,
  type Frequency,
  type Id,
  type OverspendingHandling,
  type Payee,
  type PayeeLocation,
  type PayeeRule,
  type PayeeRuleOp,
  type ScheduledTransaction,
  type Split,
  type Transaction,
} from '../model/types';

// Imports a YNAB4 budget: a "<name>~<hash>.ynab4" folder.
//
// Budget.ymeta names the data folder (relativeDataFolderName). In there, devices/*.ydevice
// describes each computer that has edited the budget, <deviceGUID>/Budget.yfull is a full
// copy of the budget saved by that device, and <deviceGUID>/*.ydiff files hold the changes
// made since. Every record ("entity") has an entityVersion like "A-123": the device's short
// id and its change number. A "knowledge" string such as "A-172,B-957" lists the latest
// change from each device that a file includes.
//
// Nothing here writes to the YNAB4 folder; it is only read through `VirtualFolder`.

/** The files in the folder the user picked. Paths are POSIX-style and relative to it. */
export interface VirtualFolder {
  paths: string[];
  read(path: string): Promise<string>;
}

/** A budget found in a folder. `root` is its folder with a trailing "/" ("" for the picked folder). */
export interface Ynab4BudgetRef {
  name: string;
  root: string;
}

const toPosix = (p: string) => p.replace(/\\/g, '/');

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** JSON.parse that ignores a byte order mark, which YNAB4 sometimes writes. */
function parseJson(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/** A lookup that ignores keys inherited from Object.prototype ("constructor" and so on). */
function lookup<T>(table: Record<string, T>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined;
}

/** "Sam_s Budget~1A2B3C4D.ynab4" -> "Sam's Budget". YNAB4 writes apostrophes as "_". */
function budgetNameFromFolder(folder: string): string {
  return folder
    .replace(/\.ynab4$/i, '')
    .replace(/~[0-9A-F]{8}$/i, '')
    .replace(/_s\b/, "'s");
}

/**
 * Finds the YNAB4 budgets among a folder's file paths (each has a Budget.ymeta), sorted by
 * name. `pickedFolderName` names a budget whose Budget.ymeta is at the top of the folder,
 * i.e. when the user picked the .ynab4 folder itself.
 */
export function findYnab4Budgets(paths: string[], pickedFolderName?: string): Ynab4BudgetRef[] {
  const found: Ynab4BudgetRef[] = [];
  for (const raw of paths) {
    const p = toPosix(raw);
    if (p !== 'Budget.ymeta' && !p.endsWith('/Budget.ymeta')) continue;
    const root = p.slice(0, p.length - 'Budget.ymeta'.length);
    const folder = root.replace(/\/$/, '').split('/').pop() || pickedFolderName || 'Budget';
    found.push({ name: budgetNameFromFolder(folder) || 'Budget', root });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Knowledge -----------------------------------------------------------------

/** Latest change number per device, e.g. { A: 172, B: 957 }. */
type Knowledge = Record<string, number>;

function parseKnowledge(text: unknown): Knowledge {
  const k: Knowledge = {};
  if (typeof text !== 'string' || !text) return k;
  for (const part of text.split(',')) {
    const m = /^([A-Za-z]+)-(\d+)$/.exec(part.trim());
    if (m) k[m[1]] = Math.max(k[m[1]] || 0, +m[2]);
  }
  return k;
}

const knowledgeSize = (k: Knowledge) => Object.values(k).reduce((a, b) => a + b, 0);

/** True when `k` includes every change in `other`. */
const covers = (k: Knowledge, other: Knowledge) => Object.entries(other).every(([d, n]) => (k[d] || 0) >= n);

function mergeKnowledge(a: Knowledge, b: Knowledge): Knowledge {
  const out = { ...a };
  for (const [d, n] of Object.entries(b)) out[d] = Math.max(out[d] || 0, n);
  return out;
}

/** "A-123" -> ["A", 123]. */
function parseVersion(v: unknown): [string, number] {
  const m = typeof v === 'string' ? /^([A-Za-z]+)-(\d+)$/.exec(v) : null;
  return m ? [m[1], +m[2]] : ['', 0];
}

// ---- Entities --------------------------------------------------------------------

interface Entity {
  entityId: string;
  entityType?: string;
  entityVersion?: string;
  isTombstone?: boolean;
}

/** An entity as found in the JSON, with whatever other fields it has. */
type RawEntity = Entity & Record<string, unknown>;

interface YMeta extends Entity {
  currencyLocale?: string | null;
  dateLocale?: string | null;
}

interface YAccount extends Entity {
  accountName?: string;
  accountType?: string;
  onBudget?: boolean;
  hidden?: boolean;
  note?: string | null;
  sortableIndex?: number;
  lastReconciledDate?: string | null;
  lastReconciledBalance?: number | null;
}

interface YMasterCategory extends Entity {
  name?: string;
  type?: string;
  expanded?: boolean;
  note?: string | null;
  sortableIndex?: number;
}

interface YCategory extends Entity {
  name?: string;
  type?: string;
  masterCategoryId?: string;
  note?: string | null;
  sortableIndex?: number;
}

interface YPayee extends Entity {
  name?: string;
  enabled?: boolean;
  autoFillCategoryId?: string | null;
  autoFillMemo?: string | null;
  autoFillAmount?: number | null;
}

interface YPayeeCondition extends Entity {
  parentPayeeId?: string;
  operator?: string;
  operand?: string | null;
}

interface YLocation extends Entity {
  parentPayeeId?: string;
  latitude?: number | string | null;
  longitude?: number | string | null;
}

interface YTransactionBase extends Entity {
  accountId?: string;
  date?: string;
  payeeId?: string | null;
  categoryId?: string | null;
  memo?: string | null;
  amount?: number;
  flag?: string | null;
  checkNumber?: string | number | null;
  targetAccountId?: string | null;
  transferTransactionId?: string | null;
}

interface YTransaction extends YTransactionBase {
  cleared?: string;
  accepted?: boolean;
  FITID?: string | null;
  YNABID?: string | null;
  importedPayee?: string | null;
}

interface YScheduled extends YTransactionBase {
  frequency?: string;
  twiceAMonthStartDay?: number | null;
}

interface YSubTransaction extends YTransactionBase {
  parentTransactionId?: string;
}

interface YMonthlyBudget extends Entity {
  month?: string;
  note?: string | null;
}

interface YMonthlyCategoryBudget extends Entity {
  parentMonthlyBudgetId?: string;
  categoryId?: string;
  budgeted?: number;
  overspendingHandling?: string | null;
  note?: string | null;
}

type EntityMap = Map<string, RawEntity>;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** False for deleted ("tombstoned") entities. */
const isLive = (e: Entity | undefined): boolean => !!e && !e.isTombstone;

/** Lists nested inside an entity, and the field on each child that links back to it. */
const NESTED: [list: string, parentField: string][] = [
  ['subCategories', 'masterCategoryId'],
  ['subTransactions', 'parentTransactionId'],
  ['scheduledSubTransactions', 'parentTransactionId'],
  ['monthlySubCategoryBudgets', 'parentMonthlyBudgetId'],
  ['renameConditions', 'parentPayeeId'],
  ['locations', 'parentPayeeId'],
];

/** An entity followed by the entities nested in it, each linked to its parent. */
function explode(item: Record<string, unknown>): RawEntity[] {
  const parent: Record<string, unknown> = { ...item };
  const children: Record<string, unknown>[] = [];
  for (const [list, link] of NESTED) {
    const nested = item[list];
    delete parent[list];
    if (!Array.isArray(nested)) continue;
    for (const child of nested) if (isRecord(child)) children.push({ ...child, [link]: child[link] || item.entityId });
  }
  return [parent, ...children].filter((e): e is RawEntity => typeof e.entityId === 'string' && !!e.entityId);
}

const FULL_COLLECTIONS = [
  'accounts',
  'payees',
  'transactions',
  'scheduledTransactions',
  'masterCategories',
  'monthlyBudgets',
  'accountMappings',
];

/** Every entity in a Budget.yfull, keyed by entityId. */
function flattenFull(full: Record<string, unknown>): EntityMap {
  const map: EntityMap = new Map();
  for (const name of FULL_COLLECTIONS) {
    const list = full[name];
    if (!Array.isArray(list)) continue;
    for (const item of list) if (isRecord(item)) for (const e of explode(item)) map.set(e.entityId, e);
  }
  const meta = full.budgetMetaData;
  if (isRecord(meta)) {
    const id = typeof meta.entityId === 'string' && meta.entityId ? meta.entityId : 'budgetMetaData';
    map.set(id, { ...meta, entityId: id, entityType: 'budgetMetaData' });
  }
  return map;
}

/**
 * Applies the items of a .ydiff. An item is skipped if the budget already has a later
 * version of that entity from the same device.
 */
function applyDiffItems(entities: EntityMap, items: unknown): void {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!isRecord(item)) continue;
    for (const e of explode(item)) {
      const existing = entities.get(e.entityId);
      if (existing) {
        const [oldDevice, oldN] = parseVersion(existing.entityVersion);
        const [newDevice, newN] = parseVersion(e.entityVersion);
        if (oldDevice === newDevice && newN < oldN) continue;
      }
      entities.set(e.entityId, e);
    }
  }
}

// ---- Loading the files ---------------------------------------------------------------

interface DataFiles {
  devices: string[];
  fulls: string[];
  diffs: string[];
}

/** The device, full and diff files in a budget's data folder. */
function findDataFiles(paths: Iterable<string>, dataDir: string): DataFiles {
  const out: DataFiles = { devices: [], fulls: [], diffs: [] };
  for (const p of paths) {
    if (!p.startsWith(dataDir)) continue;
    const rel = p.slice(dataDir.length);
    if (/^devices\/[^/]+\.ydevice$/.test(rel)) out.devices.push(p);
    else if (/^[^/]+\/Budget\.yfull$/.test(rel)) out.fulls.push(p);
    else if (/^[^/]+\/[^/]+\.ydiff$/.test(rel)) out.diffs.push(p);
  }
  return out;
}

interface PendingDiff {
  path: string;
  start: Knowledge;
  end: Knowledge;
}

/** A diff's file name is "<start knowledge>_<end changes>.ydiff". */
function diffFromPath(path: string): PendingDiff {
  const name = path
    .split('/')
    .pop()!
    .replace(/\.ydiff$/, '');
  const [startText, endText] = name.split('_');
  const start = parseKnowledge(startText);
  return { path, start, end: mergeKnowledge(start, parseKnowledge(endText)) };
}

class Ynab4Reader {
  readonly messages: string[] = [];
  private readonly files = new Map<string, string>();

  constructor(
    private readonly folder: VirtualFolder,
    private readonly ref: Ynab4BudgetRef,
  ) {
    for (const p of folder.paths) this.files.set(toPosix(p), p);
  }

  private async readJson(path: string): Promise<unknown> {
    return parseJson(await this.folder.read(this.files.get(path) ?? path));
  }

  async load(): Promise<EntityMap> {
    const dataDir = await this.dataDir();
    const files = findDataFiles(this.files.keys(), dataDir);
    if (!files.fulls.length) throw new Error(`No Budget.yfull was found in "${this.ref.root || 'the chosen folder'}".`);
    const { full, path } = await this.readBestFull(files, dataDir);
    const fileMeta = isRecord(full.fileMetaData) ? full.fileMetaData : {};
    const version = typeof fileMeta.currentKnowledge === 'string' ? fileMeta.currentKnowledge : '';
    this.messages.push(`Loaded ${path.slice(this.ref.root.length)} (${version || 'unknown version'})`);
    const entities = flattenFull(full);
    const applied = await this.applyDiffs(entities, files.diffs, parseKnowledge(version));
    if (applied) this.messages.push(`Applied ${applied} change file(s) newer than the full budget file.`);
    return entities;
  }

  private async dataDir(): Promise<string> {
    const metaPath = this.ref.root + 'Budget.ymeta';
    if (!this.files.has(metaPath))
      throw new Error(`Budget.ymeta was not found in "${this.ref.root || 'the chosen folder'}".`);
    const meta = await this.readJson(metaPath);
    const rel = isRecord(meta) ? meta.relativeDataFolderName : undefined;
    if (typeof rel !== 'string' || !rel) throw new Error('Budget.ymeta does not say where the budget data is kept.');
    return this.ref.root + toPosix(rel).replace(/\/$/, '') + '/';
  }

  /**
   * Each device folder may hold a Budget.yfull. The most complete one is used, going by the
   * knowledgeInFullBudgetFile its .ydevice file records. Unreadable ones are passed over.
   */
  private async readBestFull(
    files: DataFiles,
    dataDir: string,
  ): Promise<{ full: Record<string, unknown>; path: string }> {
    const knowledgeByDevice = new Map<string, Knowledge>();
    for (const p of files.devices) {
      try {
        const d = await this.readJson(p);
        if (isRecord(d) && typeof d.deviceGUID === 'string') {
          knowledgeByDevice.set(d.deviceGUID, parseKnowledge(d.knowledgeInFullBudgetFile));
        }
      } catch {
        // A damaged device file only affects which Budget.yfull is tried first.
      }
    }
    const candidates = files.fulls.map((path) => ({
      path,
      size: knowledgeSize(knowledgeByDevice.get(path.slice(dataDir.length).split('/')[0]) ?? {}),
    }));
    candidates.sort((a, b) => b.size - a.size);
    for (const c of candidates) {
      try {
        const full = await this.readJson(c.path);
        if (isRecord(full)) return { full, path: c.path };
        throw new Error('not a YNAB4 budget file');
      } catch (e) {
        this.messages.push(`Could not read ${c.path}: ${errorText(e)}`);
      }
    }
    throw new Error('None of the Budget.yfull files could be read.');
  }

  /**
   * Applies the .ydiff files that hold changes the full file doesn't have, in order: each
   * time, one whose start is already known, or failing that the earliest. Returns how many.
   */
  private async applyDiffs(entities: EntityMap, paths: string[], knowledge: Knowledge): Promise<number> {
    const pending = paths.map(diffFromPath).filter((d) => !covers(knowledge, d.end));
    let applied = 0;
    while (pending.length) {
      let i = pending.findIndex((d) => covers(knowledge, d.start));
      if (i < 0) {
        pending.sort((a, b) => knowledgeSize(a.start) - knowledgeSize(b.start));
        i = 0;
      }
      const diff = pending.splice(i, 1)[0];
      try {
        const data = await this.readJson(diff.path);
        if (!isRecord(data)) throw new Error('not a YNAB4 change file');
        applyDiffItems(entities, data.items);
        const end = parseKnowledge(data.endVersion);
        knowledge = mergeKnowledge(knowledge, Object.keys(end).length ? end : diff.end);
        applied++;
      } catch (e) {
        this.messages.push(`Skipped change file ${diff.path.split('/').pop()}: ${errorText(e)}`);
      }
      for (let j = pending.length - 1; j >= 0; j--) if (covers(knowledge, pending[j].end)) pending.splice(j, 1);
    }
    return applied;
  }
}

// ---- Converting to a Budget ----------------------------------------------------------

const ACCOUNT_TYPES: Record<string, AccountType> = {
  Checking: 'Checking',
  Savings: 'Savings',
  CreditCard: 'CreditCard',
  Cash: 'Cash',
  LineOfCredit: 'LineOfCredit',
  Paypal: 'Paypal',
  MerchantAccount: 'MerchantAccount',
  InvestmentAccount: 'InvestmentAccount',
  Mortgage: 'Mortgage',
  OtherAsset: 'OtherAsset',
  OtherLiability: 'OtherLiability',
};

const FREQUENCIES: Record<string, Frequency> = {
  Never: 'Once',
  Once: 'Once',
  Daily: 'Daily',
  Weekly: 'Weekly',
  EveryOtherWeek: 'EveryOtherWeek',
  TwiceAMonth: 'TwiceAMonth',
  Every4Weeks: 'Every4Weeks',
  Monthly: 'Monthly',
  EveryOtherMonth: 'EveryOtherMonth',
  Every3Months: 'Every3Months',
  Every4Months: 'Every4Months',
  TwiceAYear: 'TwiceAYear',
  Yearly: 'Yearly',
  EveryOtherYear: 'EveryOtherYear',
};

const CLEARED: Record<string, Cleared> = { Uncleared: 'U', Cleared: 'C', Reconciled: 'R' };

const RULE_OPS: Record<string, PayeeRuleOp> = {
  Is: 'is',
  Contains: 'contains',
  StartsWith: 'startsWith',
  EndsWith: 'endsWith',
};

const HANDLING: Record<string, OverspendingHandling> = { Confined: 'carry', AffectsBuffer: 'buffer' };

const HIDDEN_MASTER = 'MasterCategory/__Hidden__';
const INTERNAL_MASTER = 'MasterCategory/__Internal__';
const PRE_YNAB_DEBT_MASTER = 'MasterCategory/__PreYNABDebtMaster__';
const PRE_YNAB_DEBT_CATEGORY = 'Category/PreYNABDebt/';
const TRANSFER_PAYEE = 'Payee/Transfer:';
/** Hidden categories are named "Master ` Sub ` originalMasterId". */
const HIDDEN_SEP = ' ` ';

/** Removes keys whose value is undefined, so they don't appear in the saved file. */
function compact<T extends object>(obj: T): T {
  for (const key of Object.keys(obj) as (keyof T)[]) if (obj[key] === undefined) delete obj[key];
  return obj;
}

const textOrUndefined = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

function toFlag(v: unknown): Flag | undefined {
  const f = typeof v === 'string' ? v.toLowerCase() : '';
  return (FLAGS as string[]).includes(f) ? (f as Flag) : undefined;
}

function groupBy<T>(items: T[], key: (item: T) => string | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === undefined) continue;
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/** Renumbers `sort` as 0, 1, 2... keeping the current order. */
function renumber(items: { sort: number }[]): void {
  [...items].sort((a, b) => a.sort - b.sort).forEach((item, i) => (item.sort = i));
}

/** Turns YNAB4 entities into a Budget. */
class Converter {
  readonly b: Budget;
  private readonly byType: Map<string, RawEntity[]>;
  /** Every category, deleted ones included, for names of categories that are still in use. */
  private readonly allCategories = new Map<string, YCategory>();
  /** Deleted master categories, for the names of masters that hidden categories came from. */
  private readonly deletedMasters = new Map<string, YMasterCategory>();
  private readonly liveTransactionIds = new Set<string>();
  /** Live split lines (of transactions and scheduled transactions), by parent and by id. */
  private readonly subsByParent: Map<string, YSubTransaction[]>;
  private readonly subsById = new Map<string, YSubTransaction>();

  constructor(
    private readonly entities: EntityMap,
    name: string,
    private readonly messages: string[],
  ) {
    this.b = newBudget(name, false);
    this.b.importedFrom = 'YNAB4';
    this.byType = groupBy([...entities.values()], (e) => e.entityType);
    for (const c of this.ofType<YCategory>('category')) this.allCategories.set(c.entityId, c);
    for (const m of this.ofType<YMasterCategory>('masterCategory'))
      if (!isLive(m)) this.deletedMasters.set(m.entityId, m);
    for (const t of this.live<YTransaction>('transaction')) this.liveTransactionIds.add(t.entityId);
    const subs = [
      ...this.live<YSubTransaction>('subTransaction'),
      ...this.live<YSubTransaction>('scheduledSubTransaction'),
    ];
    this.subsByParent = groupBy(subs, (s) => s.parentTransactionId);
    for (const s of subs) this.subsById.set(s.entityId, s);
  }

  convert(): Budget {
    this.metaData();
    this.accounts();
    this.masterCategories();
    this.categories();
    this.payees();
    this.transactions();
    const remembered = addDeletedImports(this.b, ynab4DeletedImports(this.entities));
    if (remembered) {
      this.messages.push(`Remembered ${remembered} transaction(s) you had deleted, so re-importing old bank files won't bring them back.`);
    }
    this.scheduled();
    this.monthlyBudgets();
    this.tidySortOrder();
    const count = (r: object) => Object.keys(r).length;
    const b = this.b;
    this.messages.push(
      `Imported ${count(b.accounts)} accounts, ${count(b.categories)} categories, ${count(b.transactions)} transactions, ` +
        `${count(b.scheduled)} scheduled, ${count(b.payees)} payees.`,
    );
    return b;
  }

  private ofType<T extends Entity>(type: string): T[] {
    return (this.byType.get(type) ?? []) as unknown as T[];
  }

  private live<T extends Entity>(type: string): T[] {
    return this.ofType<T>(type).filter(isLive);
  }

  /** Currency and date format from the budget's locale settings. */
  private metaData(): void {
    const meta = (this.entities.get('A2') ?? this.ofType<YMeta>('budgetMetaData')[0]) as YMeta | undefined;
    const currency = this.b.currency;
    if (meta?.currencyLocale) {
      // Amounts are always read with 2 decimals (toMinor), so only the symbol and locale change.
      const locale = String(meta.currencyLocale).replace('_', '-');
      currency.locale = locale;
      if (/en-US/i.test(locale)) Object.assign(currency, { code: 'USD', symbol: '$' });
      else if (/en-GB/i.test(locale)) Object.assign(currency, { code: 'GBP', symbol: '£' });
      else if (/-(DE|FR|ES|IT|NL|IE|AT|BE|FI|PT)$/i.test(locale)) {
        Object.assign(currency, { code: 'EUR', symbol: '€', symbolFirst: false });
      }
    }
    if (meta?.dateLocale) this.b.dateFormat = /en[_-]US/i.test(String(meta.dateLocale)) ? 'MM/DD/YYYY' : 'DD/MM/YYYY';
  }

  private accounts(): void {
    for (const a of this.live<YAccount>('account')) {
      this.b.accounts[a.entityId] = compact({
        id: a.entityId,
        name: a.accountName ?? '',
        type: lookup(ACCOUNT_TYPES, a.accountType) ?? (a.onBudget ? 'Checking' : 'OtherAsset'),
        onBudget: !!a.onBudget,
        closed: !!a.hidden,
        note: textOrUndefined(a.note),
        sort: a.sortableIndex || 0,
        lastReconciledDate: textOrUndefined(a.lastReconciledDate),
        lastReconciledBalance: a.lastReconciledBalance != null ? toMinor(a.lastReconciledBalance) : undefined,
      });
    }
    renumber(Object.values(this.b.accounts));
  }

  private masterCategories(): void {
    for (const m of this.live<YMasterCategory>('masterCategory')) {
      // The hidden and internal masters, and the income master, aren't real groups.
      if (m.entityId === INTERNAL_MASTER || m.entityId === HIDDEN_MASTER || m.type === 'INFLOW') continue;
      this.b.masters[m.entityId] = compact({
        id: m.entityId,
        name: m.name ?? '',
        sort: m.sortableIndex || 0,
        collapsed: m.expanded === false,
        note: textOrUndefined(m.note),
      });
    }
  }

  /**
   * The id of master category `id`, creating it (named `name`, sorted last) if it doesn't
   * exist. A master with the same name is reused, so hidden categories go back to their group.
   */
  private ensureMaster(id: Id, name: string): Id {
    const masters = this.b.masters;
    if (masters[id]) return id;
    const same = Object.values(masters).find((m) => m.name === name);
    if (same) return same.id;
    masters[id] = {
      id,
      name: name || this.deletedMasters.get(id)?.name || 'Other',
      sort: 1e12 + Object.keys(masters).length,
    };
    return id;
  }

  private categories(): void {
    for (const c of this.allCategories.values()) {
      if (!isLive(c)) continue;
      let masterId = c.masterCategoryId ?? '';
      let name = c.name ?? '';
      let hidden = false;
      if (masterId === HIDDEN_MASTER) {
        // Hidden categories are kept in one master and named "Master ` Sub ` originalMasterId".
        hidden = true;
        const parts = name.split(HIDDEN_SEP);
        if (parts.length >= 3) {
          name = parts.slice(1, -1).join(HIDDEN_SEP);
          masterId = this.ensureMaster(parts[parts.length - 1], parts[0]);
        } else masterId = this.ensureMaster('MasterCategory/__HiddenImported__', 'Hidden');
      } else if (!this.b.masters[masterId]) {
        if (masterId === PRE_YNAB_DEBT_MASTER) masterId = this.ensureMaster(masterId, 'Pre-YNAB Debt');
        else if (masterId === INTERNAL_MASTER || c.type === 'INFLOW') continue;
        else masterId = this.ensureMaster(masterId, this.deletedMasters.get(masterId)?.name || 'Other');
      }
      this.b.categories[c.entityId] = compact({
        id: c.entityId,
        masterId,
        name,
        sort: c.sortableIndex || 0,
        hidden,
        note: textOrUndefined(c.note),
      });
    }
  }

  /**
   * The category id to use for a YNAB4 category id. Deleted categories that are still used
   * (and YNAB4's per-account "Pre-YNAB Debt" categories) are brought back as hidden categories.
   */
  private resolveCategory(id: string | null | undefined): Id | null {
    if (!id) return null;
    if (id === 'Category/__ImmediateIncome__') return INCOME_NOW;
    if (id === 'Category/__DeferredIncome__') return INCOME_NEXT;
    if (id === 'Category/__Split__') return SPLIT;
    if (this.b.categories[id]) return id;
    const old = this.allCategories.get(id);
    let name = old?.name || (id.startsWith(PRE_YNAB_DEBT_CATEGORY) ? 'Pre-YNAB Debt' : 'Unknown category');
    let masterId: Id;
    if (id.startsWith(PRE_YNAB_DEBT_CATEGORY)) {
      const account = this.b.accounts[id.slice(PRE_YNAB_DEBT_CATEGORY.length)];
      if (account) name = account.name;
      masterId = this.ensureMaster(PRE_YNAB_DEBT_MASTER, 'Pre-YNAB Debt');
    } else {
      if (name.includes(HIDDEN_SEP)) name = name.split(HIDDEN_SEP).slice(1, -1).join(HIDDEN_SEP) || name;
      masterId = this.ensureMaster('MasterCategory/__Recovered__', 'Recovered Categories');
    }
    this.b.categories[id] = { id, masterId, name, sort: old?.sortableIndex || 0, hidden: true };
    return id;
  }

  private payees(): void {
    const rules = new Map<string, PayeeRule[]>();
    for (const c of this.live<YPayeeCondition>('payeeStringCondition')) {
      const list = rules.get(c.parentPayeeId ?? '') ?? [];
      list.push({ op: lookup(RULE_OPS, c.operator) ?? 'is', text: c.operand || '' });
      rules.set(c.parentPayeeId ?? '', list);
    }
    const locations = new Map<string, PayeeLocation[]>();
    for (const l of this.live<YLocation>('location')) {
      const latitude = Number(l.latitude);
      const longitude = Number(l.longitude);
      if (l.latitude == null || l.longitude == null || !isFinite(latitude) || !isFinite(longitude)) continue;
      const list = locations.get(l.parentPayeeId ?? '') ?? [];
      list.push({ latitude, longitude });
      locations.set(l.parentPayeeId ?? '', list);
    }
    for (const p of this.live<YPayee>('payee')) {
      // "Payee/Transfer:<accountId>" payees stand for transfers; they're named after the account.
      const transferAccountId = p.entityId.startsWith(TRANSFER_PAYEE)
        ? p.entityId.slice(TRANSFER_PAYEE.length)
        : undefined;
      if (transferAccountId !== undefined && !this.b.accounts[transferAccountId]) continue;
      const autoCategoryId = p.autoFillCategoryId ? this.resolveCategory(p.autoFillCategoryId) : null;
      const payee: Payee = compact({
        id: p.entityId,
        name: transferAccountId ? 'Transfer : ' + this.b.accounts[transferAccountId].name : (p.name ?? ''),
        autoCategoryId: autoCategoryId === SPLIT ? null : autoCategoryId,
        autoMemo: p.autoFillMemo || null,
        autoAmount: p.autoFillAmount != null ? toMinor(p.autoFillAmount) : null,
        rules: rules.get(p.entityId) ?? [],
        transferAccountId,
        hidden: p.enabled === false ? true : undefined,
        locations: locations.get(p.entityId),
      });
      this.b.payees[payee.id] = payee;
    }
    if (!Object.values(this.b.payees).some((p) => p.name === 'Starting Balance')) {
      const id = 'Payee/__StartingBalance__';
      this.b.payees[id] = { id, name: 'Starting Balance', rules: [] };
    }
  }

  /** The payee id to use. A deleted payee that is still used comes back as a hidden payee. */
  private resolvePayee(id: string | null | undefined): Id | undefined {
    if (!id) return undefined;
    if (this.b.payees[id]) return id;
    const old = this.entities.get(id) as YPayee | undefined;
    if (old?.entityType !== 'payee') return undefined;
    this.b.payees[id] = { id, name: old.name || 'Unknown payee', rules: [], hidden: true };
    return id;
  }

  /** A split line. Its transfer is kept only if the other account was imported. */
  private split(s: YSubTransaction, withTransferTxn: boolean): Split {
    const split: Split = compact({
      id: s.entityId,
      categoryId: this.resolveCategory(s.categoryId),
      amount: toMinor(s.amount),
      memo: textOrUndefined(s.memo),
    });
    if (s.targetAccountId && this.b.accounts[s.targetAccountId]) {
      split.transferAccountId = s.targetAccountId;
      if (withTransferTxn && s.transferTransactionId && this.liveTransactionIds.has(s.transferTransactionId)) {
        split.transferTxId = s.transferTransactionId;
      }
    }
    return split;
  }

  private transactions(): void {
    let skipped = 0;
    let badDates = 0;
    for (const t of this.live<YTransaction>('transaction')) {
      if (!t.accountId || !Object.hasOwn(this.b.accounts, t.accountId)) {
        skipped++;
        continue;
      }
      if (!isISODate(String(t.date).slice(0, 10))) {
        badDates++;
        continue;
      }
      const tx: Transaction = compact({
        id: t.entityId,
        accountId: t.accountId,
        date: String(t.date).slice(0, 10),
        payeeId: this.resolvePayee(t.payeeId),
        categoryId: this.resolveCategory(t.categoryId),
        memo: textOrUndefined(t.memo),
        amount: toMinor(t.amount),
        cleared: lookup(CLEARED, t.cleared) ?? 'U',
        flag: toFlag(t.flag),
        check: t.checkNumber ? String(t.checkNumber) : undefined,
        accepted: t.accepted !== false,
      });
      const importIds: string[] = [];
      if (t.FITID) importIds.push('FITID:' + t.FITID);
      if (t.YNABID) importIds.push(t.YNABID);
      if (importIds.length) tx.importIds = importIds;
      if (t.importedPayee) tx.importedPayee = t.importedPayee;
      if (t.targetAccountId && this.b.accounts[t.targetAccountId]) {
        tx.transferAccountId = t.targetAccountId;
        // The other side is a transaction, or one split line of a transaction.
        const other = t.transferTransactionId;
        if (other && this.liveTransactionIds.has(other)) tx.transferTxId = other;
        else if (other && this.subsById.has(other)) {
          tx.transferTxId = this.subsById.get(other)!.parentTransactionId;
          tx.transferSplitParentId = tx.transferTxId;
        }
      }
      if (tx.categoryId === SPLIT) {
        const splits = (this.subsByParent.get(t.entityId) ?? []).map((s) => {
          const split = this.split(s, true);
          const payeeId = s.payeeId ? this.resolvePayee(s.payeeId) : undefined;
          if (payeeId) split.payeeId = payeeId;
          return split;
        });
        if (splits.length) tx.splits = splits;
        else tx.categoryId = null;
      }
      this.b.transactions[tx.id] = tx;
    }
    if (skipped) this.messages.push(`Skipped ${skipped} transaction(s) belonging to deleted accounts.`);
    if (badDates) this.messages.push(`Skipped ${badDates} transaction(s) without a valid date.`);
    this.dropDanglingTransfers();
  }

  /** Transfer links to transactions that weren't imported (e.g. in a deleted account). */
  private dropDanglingTransfers(): void {
    const txns = this.b.transactions;
    for (const t of Object.values(txns)) {
      if (t.transferTxId && !txns[t.transferTxId]) {
        delete t.transferTxId;
        delete t.transferSplitParentId;
      }
      for (const s of t.splits ?? []) if (s.transferTxId && !txns[s.transferTxId]) delete s.transferTxId;
    }
  }

  private scheduled(): void {
    for (const s of this.live<YScheduled>('scheduledTransaction')) {
      if (!s.accountId || !Object.hasOwn(this.b.accounts, s.accountId)) continue;
      const date = String(s.date).slice(0, 10);
      if (!isISODate(date)) continue;
      const st: ScheduledTransaction = compact({
        id: s.entityId,
        accountId: s.accountId,
        date,
        startDate: date,
        frequency: lookup(FREQUENCIES, s.frequency) ?? 'Monthly',
        payeeId: this.resolvePayee(s.payeeId),
        categoryId: this.resolveCategory(s.categoryId),
        memo: textOrUndefined(s.memo),
        amount: toMinor(s.amount),
        flag: toFlag(s.flag),
        check: s.checkNumber ? String(s.checkNumber) : undefined,
        transferAccountId: s.targetAccountId && this.b.accounts[s.targetAccountId] ? s.targetAccountId : undefined,
      });
      if (s.frequency === 'TwiceAMonth') st.twiceMonthDay2 = s.twiceAMonthStartDay || 0;
      if (st.categoryId === SPLIT) {
        const splits = (this.subsByParent.get(s.entityId) ?? []).map((sub) => this.split(sub, false));
        if (splits.length) st.splits = splits;
        else st.categoryId = null;
      }
      this.b.scheduled[st.id] = st;
    }
  }

  /** Budgeted amounts, overspending handling and notes per category per month, and month notes. */
  private monthlyBudgets(): void {
    for (const mb of this.live<YMonthlyCategoryBudget>('monthlyCategoryBudget')) {
      const month = /(\d{4}-\d{2})/.exec(mb.parentMonthlyBudgetId || mb.entityId)?.[1];
      if (!month) continue;
      const categoryId = this.resolveCategory(mb.categoryId);
      if (!categoryId || categoryId.startsWith('__')) continue;
      const budgeted = toMinor(mb.budgeted);
      const handling = lookup(HANDLING, mb.overspendingHandling);
      const note = textOrUndefined(mb.note);
      if (!budgeted && !handling && !note) continue;
      const entry: CategoryMonth = compact({ budgeted, handling, note });
      (this.b.months[month] ??= {})[categoryId] = entry;
    }
    for (const m of this.live<YMonthlyBudget>('monthlyBudget')) {
      const month = /(\d{4}-\d{2})/.exec(m.month || m.entityId)?.[1];
      const note = textOrUndefined(m.note);
      if (month && note) (this.b.monthNotes ??= {})[month] = note;
    }
  }

  /** Sorts as 0, 1, 2... within each group, and drops master categories left empty. */
  private tidySortOrder(): void {
    const b = this.b;
    renumber(Object.values(b.masters));
    const byMaster = groupBy(Object.values(b.categories), (c) => c.masterId);
    for (const list of byMaster.values()) renumber(list);
    for (const id of Object.keys(b.masters)) if (!byMaster.has(id)) delete b.masters[id];
  }
}

/**
 * Import ids of transactions deleted in YNAB4, by account. YNAB4 kept its deleted records
 * ("tombstones", with their FITID and YNABID) and skipped those bank rows on re-import.
 */
function ynab4DeletedImports(entities: EntityMap): Map<string, DeletedImport[]> {
  const out = new Map<string, DeletedImport[]>();
  for (const e of entities.values()) {
    if (e.entityType !== 'transaction' || !e.isTombstone) continue;
    const t = e as unknown as YTransaction;
    if (!t.accountId) continue;
    const ids = [t.FITID ? 'FITID:' + t.FITID : '', t.YNABID || ''].filter(Boolean);
    if (ids.length) out.set(t.accountId, [...(out.get(t.accountId) ?? []), { ids }]);
  }
  return out;
}

/**
 * For a budget converted before 1.1.3: the deleted imports of a YNAB4 budget, by account, and
 * the ids of all its accounts (to check it's the same budget). Reads only.
 */
export async function readYnab4DeletedImports(
  folder: VirtualFolder,
  budget: Ynab4BudgetRef,
): Promise<{ accountIds: Set<string>; deleted: Map<string, DeletedImport[]> }> {
  const entities = await new Ynab4Reader(folder, budget).load();
  const accountIds = new Set([...entities.values()].filter((e) => e.entityType === 'account').map((e) => e.entityId));
  return { accountIds, deleted: ynab4DeletedImports(entities) };
}

/**
 * Imports a YNAB4 budget found by `findYnab4Budgets`. Reads only; the YNAB4 files are not
 * changed. `messages` describes what was loaded and anything that was skipped.
 */
export async function importYnab4(
  folder: VirtualFolder,
  budget: Ynab4BudgetRef,
): Promise<{ budget: Budget; messages: string[] }> {
  const reader = new Ynab4Reader(folder, budget);
  const entities = await reader.load();
  const result = new Converter(entities, budget.name, reader.messages).convert();
  return { budget: result, messages: reader.messages };
}
