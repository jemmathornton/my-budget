import { isISODate } from './dates';
import { DEFAULT_CURRENCY } from './money';
import { newId } from './ids';
import { BUDGET_FORMAT, BUDGET_VERSION, type Budget } from './types';

const DEFAULT_CATEGORIES: [string, string[]][] = [
  ['Giving', ['Charity']],
  ['Monthly Bills', ['Rent/Mortgage', 'Council Tax', 'Gas/Electric', 'Water', 'Phone', 'Internet', 'TV Licence']],
  [
    'Everyday Expenses',
    ['Groceries', 'Fuel', 'Transport', 'Household Goods', 'Clothing', 'Medical', 'Spending Money', 'Restaurants'],
  ],
  ['Rainy Day Funds', ['Emergency Fund', 'Car Repairs', 'Home Maintenance', 'Car Insurance', 'Birthdays', 'Christmas']],
  ['Savings Goals', ['Holiday', 'New Car']],
  ['Debt', ['Car Payment', 'Student Loan']],
];

/** A new, empty budget. With `defaultCategories` it starts with a typical set of categories. */
export function newBudget(name: string, defaultCategories = true): Budget {
  const now = new Date().toISOString();
  const b: Budget = {
    format: BUDGET_FORMAT,
    version: BUDGET_VERSION,
    id: newId(),
    name,
    currency: { ...DEFAULT_CURRENCY },
    dateFormat: 'DD/MM/YYYY',
    accounts: {},
    masters: {},
    categories: {},
    months: {},
    payees: {},
    transactions: {},
    scheduled: {},
    createdAt: now,
    modifiedAt: now,
    settings: {},
  };
  if (defaultCategories) {
    DEFAULT_CATEGORIES.forEach(([master, subs], mi) => {
      const mid = newId();
      b.masters[mid] = { id: mid, name: master, sort: mi };
      subs.forEach((sub, si) => {
        const cid = newId();
        b.categories[cid] = { id: cid, masterId: mid, name: sub, sort: si, hidden: false };
      });
    });
  }
  return b;
}

export class BudgetFileError extends Error {}

/**
 * Reads a .budget file's text. Fills in fields that older files may lack so the
 * rest of the app can rely on them.
 */
export function parseBudgetFile(text: string): Budget {
  let data: unknown;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new BudgetFileError('This file is damaged or is not a budget file (it is not valid JSON).');
  }
  const b = data as Partial<Budget> | null;
  if (!b || typeof b !== 'object' || b.format !== BUDGET_FORMAT) {
    throw new BudgetFileError('This is not a My Budget file.');
  }
  if ((b.version ?? 1) > BUDGET_VERSION) {
    throw new BudgetFileError('This budget was saved by a newer version of My Budget. Please update the app.');
  }
  const out = b as Budget;
  out.version = BUDGET_VERSION;
  out.currency = { ...DEFAULT_CURRENCY, ...(out.currency || {}) };
  out.dateFormat = out.dateFormat || 'DD/MM/YYYY';
  for (const key of ['accounts', 'masters', 'categories', 'months', 'payees', 'transactions', 'scheduled'] as const) {
    if (!out[key] || typeof out[key] !== 'object') (out as unknown as Record<string, unknown>)[key] = {};
  }
  out.settings = out.settings || {};
  for (const p of Object.values(out.payees)) if (!Array.isArray(p.rules)) p.rules = [];
  // A damaged record or an impossible date would break the budget maths, so say so clearly.
  for (const key of ['transactions', 'scheduled'] as const) {
    for (const [id, t] of Object.entries(out[key])) {
      if (!t || typeof t !== 'object') throw new BudgetFileError(`This budget file is damaged: ${key} record "${id}" is empty.`);
      if (!isISODate(t.date)) {
        throw new BudgetFileError(
          `This budget file is damaged: a ${key === 'scheduled' ? 'scheduled transaction' : 'transaction'} has the date "${String(t.date).slice(0, 20)}". ` +
            'Its daily backups are in the "My Budget\\backups" folder in your AppData folder.',
        );
      }
    }
  }
  // A schedule's other dates, damaged or edited by hand: repaired rather than letting the scheduler
  // write an impossible date, which would stop the file opening next time (1.5.3).
  for (const s of Object.values(out.scheduled)) {
    if (s.startDate !== undefined && !isISODate(s.startDate)) s.startDate = s.date;
    if (s.endDate !== undefined && !isISODate(s.endDate)) delete s.endDate;
    if (s.twiceMonthDay2 !== undefined && !(Number.isInteger(s.twiceMonthDay2) && s.twiceMonthDay2 >= 1 && s.twiceMonthDay2 <= 31)) delete s.twiceMonthDay2;
  }
  for (const t of Object.values(out.transactions)) {
    if (t.categoryId === undefined) t.categoryId = null;
    if (t.accepted === undefined) t.accepted = true;
    if (!t.cleared) t.cleared = 'U';
  }
  for (const c of Object.values(out.categories)) if (c.hidden === undefined) c.hidden = false;
  for (const a of Object.values(out.accounts)) if (a.closed === undefined) a.closed = false;
  out.createdAt = out.createdAt || new Date().toISOString();
  out.modifiedAt = out.modifiedAt || out.createdAt;
  return out;
}

/** The text written to a .budget file. */
export function serializeBudget(b: Budget): string {
  return JSON.stringify(b);
}
