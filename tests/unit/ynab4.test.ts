import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listYnab4Files, readYnab4File } from '../../electron/ynab4Files';
import { findYnab4Budgets, importYnab4, readYnab4DeletedImports, type VirtualFolder } from '../../src/import/ynab4';
import { INCOME_NEXT, INCOME_NOW, SPLIT, type Budget } from '../../src/model/types';

// A small, made-up YNAB4 package built in memory.

const ROOT = 'YNAB/Test Budget~1A2B3C4D.ynab4/';
const DATA = ROOT + 'data1~ABCDEF01/';
const DEV_A = 'AAAAAAAA-0000-0000-0000-000000000001';
const DEV_B = 'BBBBBBBB-0000-0000-0000-000000000002';
const HIDDEN = 'MasterCategory/__Hidden__';
const PRE_DEBT = 'Category/PreYNABDebt/ACC-CARD';

type Obj = Record<string, unknown>;

const account = (id: string, fields: Obj): Obj => ({
  entityType: 'account',
  entityId: id,
  entityVersion: 'A-1',
  ...fields,
});
const category = (id: string, master: string, name: string, sortableIndex: number, extra: Obj = {}): Obj => ({
  entityType: 'category',
  entityId: id,
  entityVersion: 'A-1',
  type: 'OUTFLOW',
  masterCategoryId: master,
  name,
  sortableIndex,
  ...extra,
});
const master = (id: string, name: string, sortableIndex: number, subs: Obj[], extra: Obj = {}): Obj => ({
  entityType: 'masterCategory',
  entityId: id,
  entityVersion: 'A-1',
  type: 'OUTFLOW',
  name,
  sortableIndex,
  expanded: true,
  subCategories: subs,
  ...extra,
});
const txn = (id: string, fields: Obj): Obj => ({
  entityType: 'transaction',
  entityId: id,
  entityVersion: 'A-9',
  date: '2024-01-10',
  cleared: 'Cleared',
  accepted: true,
  categoryId: null,
  ...fields,
});
const sched = (id: string, fields: Obj): Obj => ({
  entityType: 'scheduledTransaction',
  entityId: id,
  entityVersion: 'A-1',
  accountId: 'ACC-CUR',
  date: '2024-02-01',
  frequency: 'Monthly',
  twiceAMonthStartDay: null,
  amount: -1,
  categoryId: null,
  ...fields,
});
const shop = (extra: Obj): Obj => ({
  entityType: 'payee',
  entityId: 'PAY-SHOP',
  entityVersion: 'A-1',
  name: 'Corner Shop',
  enabled: true,
  autoFillCategoryId: 'CAT-FOOD',
  autoFillMemo: 'Weekly shop',
  autoFillAmount: 25.5,
  ...extra,
});
const payee = (id: string, name: string, extra: Obj = {}): Obj => ({
  entityType: 'payee',
  entityId: id,
  entityVersion: 'A-1',
  name,
  enabled: true,
  autoFillCategoryId: null,
  autoFillMemo: null,
  autoFillAmount: 0,
  renameConditions: [],
  locations: [],
  ...extra,
});
const budgetCell = (id: string, categoryId: string, budgeted: number, extra: Obj = {}): Obj => ({
  entityType: 'monthlyCategoryBudget',
  entityId: id,
  entityVersion: 'A-1',
  categoryId,
  budgeted,
  overspendingHandling: null,
  ...extra,
});

const FULL_A = {
  fileMetaData: { entityType: 'fileMetaData', budgetDataVersion: '4.2', currentKnowledge: 'A-20,B-5' },
  budgetMetaData: {
    entityType: 'budgetMetaData',
    entityId: 'A2',
    entityVersion: 'A-0',
    currencyLocale: 'en_GB',
    dateLocale: 'en_GB',
  },
  accounts: [
    account('ACC-CUR', {
      accountName: 'Current account',
      accountType: 'Checking',
      onBudget: true,
      hidden: false,
      note: 'Main account',
      sortableIndex: 20,
      lastReconciledDate: '2024-01-31',
      lastReconciledBalance: 1234.56,
    }),
    account('ACC-CARD', {
      accountName: 'Credit card',
      accountType: 'CreditCard',
      onBudget: true,
      hidden: false,
      sortableIndex: 10,
      lastReconciledDate: null,
      lastReconciledBalance: 0,
    }),
    account('ACC-SAV', {
      accountName: 'Savings',
      accountType: 'Savings',
      onBudget: true,
      hidden: true,
      sortableIndex: 30,
    }),
    account('ACC-INV', { accountName: 'Shares', accountType: 'SomethingNew', onBudget: false, sortableIndex: 40 }),
    account('ACC-GONE', { accountName: 'Deleted', accountType: 'Checking', onBudget: true, isTombstone: true }),
  ],
  masterCategories: [
    master(
      'MC-BILLS',
      'Monthly Bills',
      10,
      [
        category('CAT-RENT', 'MC-BILLS', 'Rent', 10),
        category('CAT-POWER', 'MC-BILLS', 'Electricity', 5, { note: 'Fixed tariff' }),
        category('CAT-OLD', 'MC-BILLS', 'Old bill', 20, { isTombstone: true }),
      ],
      { note: 'Pay on time' },
    ),
    master('MC-EVERY', 'Everyday', 20, [category('CAT-FOOD', 'MC-EVERY', 'Groceries', 0)], { expanded: false }),
    master('MC-EMPTY', 'Empty group', 99, []),
    master(HIDDEN, 'Hidden Categories', 1000, [
      category('CAT-HID1', HIDDEN, 'Monthly Bills ` Gym ` MC-BILLS', 7),
      category('CAT-HID2', HIDDEN, 'Holidays ` Flights ` MC-HOLS', 1),
      category('CAT-HID3', HIDDEN, 'Weird', 0),
    ]),
    master('MC-HOLS', 'Holidays', 30, [category('CAT-ORPHAN', 'MC-HOLS', 'Orphan', 2)], { isTombstone: true }),
    master('MasterCategory/__Internal__', 'Internal', 0, []),
    master('MasterCategory/__Income__', 'Income', 0, [], { type: 'INFLOW' }),
  ],
  payees: [
    shop({
      renameConditions: [
        { entityType: 'payeeStringCondition', entityId: 'RC1', operator: 'Contains', operand: 'CORNER SHOP' },
        {
          entityType: 'payeeStringCondition',
          entityId: 'RC2',
          operator: 'StartsWith',
          operand: 'CRNR',
          isTombstone: true,
        },
      ],
      locations: [
        { entityType: 'location', entityId: 'LOC1', latitude: 51.5, longitude: -0.12 },
        { entityType: 'location', entityId: 'LOC2', latitude: 52, longitude: 1, isTombstone: true },
      ],
    }),
    payee('PAY-EMP', 'Employer', { autoFillCategoryId: 'Category/__ImmediateIncome__', autoFillAmount: null }),
    payee('PAY-OLDCAT', 'Old Payee', { autoFillCategoryId: 'CAT-OLD' }),
    payee('PAY-SPLIT', 'Split Payee', { autoFillCategoryId: 'Category/__Split__' }),
    payee('PAY-DISABLED', 'Disabled Payee', { enabled: false }),
    payee('PAY-DELETED', 'Closed Shop', { isTombstone: true }),
    payee('Payee/Transfer:ACC-CUR', ''),
    payee('Payee/Transfer:ACC-CARD', ''),
    payee('Payee/Transfer:ACC-SAV', ''),
    payee('Payee/Transfer:ACC-GONE', ''),
  ],
  transactions: [
    txn('T1', {
      entityVersion: 'A-3',
      accountId: 'ACC-CUR',
      date: '2024-01-05',
      payeeId: 'PAY-SHOP',
      categoryId: 'CAT-FOOD',
      amount: -12.34,
      memo: 'milk',
      flag: 'Red',
      checkNumber: 101,
      FITID: 'F1',
      YNABID: 'YNAB:-12.34:2024-01-05:1',
      importedPayee: 'CORNER SHOP LTD',
    }),
    txn('T2', { accountId: 'ACC-CUR', payeeId: 'PAY-EMP', categoryId: 'Category/__ImmediateIncome__', amount: 2000 }),
    txn('T3', {
      accountId: 'ACC-CUR',
      payeeId: 'PAY-EMP',
      categoryId: 'Category/__DeferredIncome__',
      amount: 100,
      cleared: 'Uncleared',
      accepted: false,
    }),
    txn('T4', {
      accountId: 'ACC-CUR',
      payeeId: 'Payee/Transfer:ACC-CARD',
      amount: -50,
      cleared: 'Reconciled',
      targetAccountId: 'ACC-CARD',
      transferTransactionId: 'T5',
    }),
    txn('T5', {
      accountId: 'ACC-CARD',
      payeeId: 'Payee/Transfer:ACC-CUR',
      amount: 50,
      targetAccountId: 'ACC-CUR',
      transferTransactionId: 'T4',
    }),
    txn('T6', {
      accountId: 'ACC-CARD',
      payeeId: 'PAY-SHOP',
      categoryId: 'Category/__Split__',
      amount: -100,
      subTransactions: [
        { entityType: 'subTransaction', entityId: 'S1', categoryId: 'CAT-FOOD', amount: -60, memo: 'food' },
        { entityType: 'subTransaction', entityId: 'S2', categoryId: 'CAT-RENT', amount: -10, payeeId: 'PAY-EMP' },
        {
          entityType: 'subTransaction',
          entityId: 'S3',
          categoryId: null,
          amount: -30,
          targetAccountId: 'ACC-SAV',
          transferTransactionId: 'T7',
        },
        { entityType: 'subTransaction', entityId: 'S4', categoryId: 'CAT-FOOD', amount: -999, isTombstone: true },
      ],
    }),
    txn('T7', {
      accountId: 'ACC-SAV',
      payeeId: 'Payee/Transfer:ACC-CARD',
      amount: 30,
      targetAccountId: 'ACC-CARD',
      transferTransactionId: 'S3',
    }),
    txn('T8', { accountId: 'ACC-CUR', payeeId: 'PAY-DELETED', categoryId: PRE_DEBT, amount: -5 }),
    txn('T9', { accountId: 'ACC-CUR', categoryId: 'CAT-OLD', amount: -6 }),
    txn('T10', { accountId: 'ACC-CUR', amount: -7, isTombstone: true }),
    // Deleted in YNAB4 after being imported: remembered, so re-importing the bank file leaves it out.
    txn('T90', { accountId: 'ACC-CUR', amount: -8, isTombstone: true, FITID: 'BANK1', YNABID: 'YNAB:-0.08:2024-01-10:1' }),
    txn('T91', { accountId: 'ACC-GONE', amount: -9, isTombstone: true, FITID: 'BANK2' }),
    txn('T11', { accountId: 'ACC-GONE', amount: -1 }),
    txn('T12', { accountId: 'ACC-CUR', amount: 1, targetAccountId: 'ACC-CARD', transferTransactionId: 'T11' }),
    txn('T13', { accountId: 'ACC-CUR', categoryId: 'Category/__Split__', amount: -3, subTransactions: [] }),
  ],
  scheduledTransactions: [
    sched('SC1', {
      payeeId: 'PAY-SHOP',
      categoryId: 'CAT-RENT',
      amount: -500,
      memo: 'rent',
      flag: 'Blue',
      checkNumber: '7',
    }),
    sched('SC2', { frequency: 'TwiceAMonth', twiceAMonthStartDay: 0, date: '2024-02-15' }),
    sched('SC3', { frequency: 'Never', date: '2024-03-01' }),
    sched('SC4', {
      categoryId: 'Category/__Split__',
      amount: -30,
      scheduledSubTransactions: [
        { entityType: 'scheduledSubTransaction', entityId: 'SS1', categoryId: 'CAT-FOOD', amount: -20 },
        { entityType: 'scheduledSubTransaction', entityId: 'SS2', amount: -10, targetAccountId: 'ACC-SAV' },
      ],
    }),
    sched('SC5', { isTombstone: true }),
    sched('SC6', {
      frequency: 'EveryOtherWeek',
      payeeId: 'Payee/Transfer:ACC-SAV',
      targetAccountId: 'ACC-SAV',
      amount: -25,
    }),
  ],
  monthlyBudgets: [
    {
      entityType: 'monthlyBudget',
      entityId: 'MB/2024-01',
      entityVersion: 'A-1',
      month: '2024-01-01',
      note: 'January notes',
      monthlySubCategoryBudgets: [
        budgetCell('MCB/2024-01/CAT-RENT', 'CAT-RENT', 500),
        budgetCell('MCB/2024-01/CAT-FOOD', 'CAT-FOOD', 200.5, { overspendingHandling: 'Confined' }),
        budgetCell('MCB/2024-01/CAT-POWER', 'CAT-POWER', 0, { overspendingHandling: 'AffectsBuffer' }),
        budgetCell('MCB/2024-01/CAT-HID1', 'CAT-HID1', 0, { note: 'cancelled' }),
        budgetCell('MCB/2024-01/CAT-ORPHAN', 'CAT-ORPHAN', 0),
        budgetCell('MCB/2024-01/CAT-HID2', 'CAT-HID2', 99, { isTombstone: true }),
        budgetCell('MCB/2024-01/INCOME', 'Category/__ImmediateIncome__', 10),
      ],
    },
    {
      entityType: 'monthlyBudget',
      entityId: 'MB/2024-02',
      entityVersion: 'A-1',
      month: '2024-02-01',
      monthlySubCategoryBudgets: [budgetCell('MCB/2024-02/CAT-RENT', 'CAT-RENT', 510)],
    },
  ],
};

/** An older, smaller full file saved by device B. */
const FULL_B = {
  fileMetaData: { currentKnowledge: 'A-3,B-5' },
  accounts: [account('ACC-OLD', { accountName: 'From the older file', accountType: 'Checking', onBudget: true })],
};

/** Already included in FULL_A (A-18 <= A-20), so it must not be applied. */
const DIFF_COVERED = {
  startVersion: 'A-15,B-5',
  endVersion: 'A-18,B-5',
  items: [account('ACC-SAV', { entityVersion: 'A-30', accountName: 'SHOULD NOT APPLY', accountType: 'Savings' })],
};

const DIFF_A = {
  startVersion: 'A-20,B-5',
  endVersion: 'A-22,B-5',
  items: [
    account('ACC-CUR', {
      entityVersion: 'A-21',
      accountName: 'Current account (renamed)',
      accountType: 'Checking',
      onBudget: true,
      hidden: false,
      note: 'Main account',
      sortableIndex: 20,
      lastReconciledDate: '2024-01-31',
      lastReconciledBalance: 1234.56,
    }),
    txn('T1', {
      entityVersion: 'A-21',
      accountId: 'ACC-CUR',
      date: '2024-01-05',
      payeeId: 'PAY-SHOP',
      categoryId: 'CAT-FOOD',
      amount: -13,
    }),
    txn('T2', { entityVersion: 'A-22', accountId: 'ACC-CUR', amount: 2000, isTombstone: true }),
    txn('T20', { entityVersion: 'A-22', accountId: 'ACC-CARD', date: '2024-02-02', payeeId: 'PAY-SHOP', amount: -7.5 }),
    // Older than the version already in the full file (A-9), so ignored.
    txn('T5', { entityVersion: 'A-1', accountId: 'ACC-CARD', amount: 999 }),
    shop({
      entityVersion: 'A-22',
      renameConditions: [{ entityType: 'payeeStringCondition', entityId: 'RC3', operator: 'EndsWith', operand: 'LTD' }],
    }),
    budgetCell('MCB/2024-02/CAT-RENT', 'CAT-RENT', 520, { entityVersion: 'A-22', parentMonthlyBudgetId: 'MB/2024-02' }),
  ],
};

/** Starts where DIFF_A ends, so it must be applied after it. */
const DIFF_B = {
  startVersion: 'A-22,B-5',
  endVersion: 'A-22,B-6',
  items: [
    master(
      'MC-EVERY',
      'Everyday',
      20,
      [category('CAT-FOOD', 'MC-EVERY', 'Food shopping', 0, { entityVersion: 'B-6' })],
      {
        entityVersion: 'B-6',
      },
    ),
  ],
};

const json = (v: unknown) => JSON.stringify(v);

function packageFiles(overrides: Record<string, string | null> = {}): Map<string, string> {
  const files = new Map<string, string>([
    // A byte order mark, as YNAB4 sometimes writes.
    [
      ROOT + 'Budget.ymeta',
      String.fromCharCode(0xfeff) + json({ formatVersion: '2', relativeDataFolderName: 'data1~ABCDEF01' }),
    ],
    [
      DATA + 'devices/A.ydevice',
      json({ deviceGUID: DEV_A, shortDeviceId: 'A', knowledgeInFullBudgetFile: 'A-20,B-5' }),
    ],
    [DATA + 'devices/B.ydevice', json({ deviceGUID: DEV_B, shortDeviceId: 'B', knowledgeInFullBudgetFile: 'A-3,B-5' })],
    // DIFF_B is listed first: the importer must still apply DIFF_A before it.
    [DATA + DEV_B + '/A-22,B-5_B-6.ydiff', json(DIFF_B)],
    [DATA + DEV_A + '/Budget.yfull', json(FULL_A)],
    [DATA + DEV_A + '/A-15,B-5_A-18.ydiff', json(DIFF_COVERED)],
    [DATA + DEV_A + '/A-20,B-5_A-22.ydiff', json(DIFF_A)],
    [DATA + DEV_B + '/Budget.yfull', json(FULL_B)],
    [DATA + DEV_A + '/budgetSettings.ybsettings', 'not used'],
  ]);
  for (const [p, text] of Object.entries(overrides)) {
    if (text === null) files.delete(p);
    else files.set(p, text);
  }
  return files;
}

function virtualFolder(files: Map<string, string>, reads: string[] = []): VirtualFolder {
  return {
    paths: [...files.keys()],
    read: async (p) => {
      reads.push(p);
      const text = files.get(p);
      if (text === undefined) throw new Error('No such file: ' + p);
      return text;
    },
  };
}

const REF = { name: 'Test Budget', root: ROOT };

describe('findYnab4Budgets', () => {
  it('finds budgets by their Budget.ymeta and names them from the folder', () => {
    const found = findYnab4Budgets([
      'YNAB/Sam_s Budget~0A1B2C3D.ynab4/Budget.ymeta',
      'YNAB/Sam_s Budget~0A1B2C3D.ynab4/data1~X/devices/A.ydevice',
      'YNAB\\Household~12345678.ynab4\\Budget.ymeta',
      'YNAB/Notes/OldBudget.ymeta',
    ]);
    expect(found).toEqual([
      { name: 'Household', root: 'YNAB/Household~12345678.ynab4/' },
      { name: "Sam's Budget", root: 'YNAB/Sam_s Budget~0A1B2C3D.ynab4/' },
    ]);
  });

  it('names a budget picked directly from the picked folder name', () => {
    expect(findYnab4Budgets(['Budget.ymeta'], 'Sam_s Budget~0A1B2C3D.ynab4')).toEqual([
      { name: "Sam's Budget", root: '' },
    ]);
    expect(findYnab4Budgets(['Budget.ymeta'])).toEqual([{ name: 'Budget', root: '' }]);
  });
});

describe('importYnab4', () => {
  let b: Budget;
  let messages: string[];
  const reads: string[] = [];

  beforeAll(async () => {
    ({ budget: b, messages } = await importYnab4(virtualFolder(packageFiles(), reads), REF));
  });

  it('loads the most complete Budget.yfull, applies newer change files in order and reports it', () => {
    expect(messages).toEqual([
      `Loaded data1~ABCDEF01/${DEV_A}/Budget.yfull (A-20,B-5)`,
      'Applied 2 change file(s) newer than the full budget file.',
      'Skipped 1 transaction(s) belonging to deleted accounts.',
      "Remembered 1 transaction(s) you had deleted, so re-importing old bank files won't bring them back.",
      'Imported 4 accounts, 9 categories, 11 transactions, 5 scheduled, 10 payees.',
    ]);
    expect(b.accounts['ACC-OLD']).toBeUndefined();
    // Only the files it needs: not the older full file, the covered diff or settings.
    expect(reads).not.toContain(DATA + DEV_B + '/Budget.yfull');
    expect(reads).not.toContain(DATA + DEV_A + '/A-15,B-5_A-18.ydiff');
    expect(reads.some((p) => p.endsWith('.ybsettings'))).toBe(false);
  });

  it('sets up the budget', () => {
    expect(b.name).toBe('Test Budget');
    expect(b.importedFrom).toBe('YNAB4');
    expect(b.currency).toMatchObject({ code: 'GBP', symbol: '£', locale: 'en-GB' });
    expect(b.dateFormat).toBe('DD/MM/YYYY');
  });

  it('imports accounts, sorted, without deleted ones', () => {
    expect(Object.values(b.accounts).sort((x, y) => x.sort - y.sort)).toEqual([
      {
        id: 'ACC-CARD',
        name: 'Credit card',
        type: 'CreditCard',
        onBudget: true,
        closed: false,
        sort: 0,
        lastReconciledBalance: 0,
      },
      {
        id: 'ACC-CUR',
        name: 'Current account (renamed)',
        type: 'Checking',
        onBudget: true,
        closed: false,
        note: 'Main account',
        sort: 1,
        lastReconciledDate: '2024-01-31',
        lastReconciledBalance: 123456,
        deletedImports: [{ ids: ['FITID:BANK1', 'YNAB:-0.08:2024-01-10:1'] }],
      },
      { id: 'ACC-SAV', name: 'Savings', type: 'Savings', onBudget: true, closed: true, sort: 2 },
      { id: 'ACC-INV', name: 'Shares', type: 'OtherAsset', onBudget: false, closed: false, sort: 3 },
    ]);
  });

  it('imports master categories, drops empty and special ones, and adds the ones it needs', () => {
    const masters = Object.values(b.masters).sort((x, y) => x.sort - y.sort);
    expect(masters.map((m) => m.name)).toEqual([
      'Monthly Bills',
      'Everyday',
      'Holidays',
      'Hidden',
      'Recovered Categories',
      'Pre-YNAB Debt',
    ]);
    expect(b.masters['MC-BILLS']).toEqual({
      id: 'MC-BILLS',
      name: 'Monthly Bills',
      sort: 0,
      collapsed: false,
      note: 'Pay on time',
    });
    // The change file from device B expanded it again.
    expect(b.masters['MC-EVERY'].collapsed).toBe(false);
    expect(b.masters['MC-EMPTY']).toBeUndefined();
    expect(b.masters['MasterCategory/__Internal__']).toBeUndefined();
    expect(b.masters['MasterCategory/__Income__']).toBeUndefined();
    expect(b.masters[HIDDEN]).toBeUndefined();
  });

  it('imports categories, sorted within each master', () => {
    const inMaster = (id: string) =>
      Object.values(b.categories)
        .filter((c) => c.masterId === id)
        .sort((x, y) => x.sort - y.sort)
        .map((c) => [c.name, c.hidden]);
    expect(inMaster('MC-BILLS')).toEqual([
      ['Electricity', false],
      ['Gym', true],
      ['Rent', false],
    ]);
    expect(b.categories['CAT-POWER'].note).toBe('Fixed tariff');
    expect(inMaster('MC-EVERY')).toEqual([['Food shopping', false]]);
  });

  it('puts hidden categories back in their original group, recreating deleted groups', () => {
    expect(b.categories['CAT-HID1']).toMatchObject({ masterId: 'MC-BILLS', name: 'Gym', hidden: true });
    expect(b.categories['CAT-HID2']).toMatchObject({ masterId: 'MC-HOLS', name: 'Flights', hidden: true });
    expect(b.masters['MC-HOLS'].name).toBe('Holidays');
    // A live category whose master was deleted stays visible in it.
    expect(b.categories['CAT-ORPHAN']).toMatchObject({ masterId: 'MC-HOLS', hidden: false });
    expect(b.masters[b.categories['CAT-HID3'].masterId].name).toBe('Hidden');
  });

  it('recovers deleted categories that are still used, and Pre-YNAB Debt categories', () => {
    expect(b.categories['CAT-OLD']).toMatchObject({ name: 'Old bill', hidden: true });
    expect(b.masters[b.categories['CAT-OLD'].masterId].name).toBe('Recovered Categories');
    expect(b.categories[PRE_DEBT]).toMatchObject({
      name: 'Credit card',
      masterId: 'MasterCategory/__PreYNABDebtMaster__',
      hidden: true,
    });
  });

  it('imports payees with rename rules, auto-fill, locations and transfer payees', () => {
    expect(b.payees['PAY-SHOP']).toEqual({
      id: 'PAY-SHOP',
      name: 'Corner Shop',
      autoCategoryId: 'CAT-FOOD',
      autoMemo: 'Weekly shop',
      autoAmount: 2550,
      rules: [
        { op: 'contains', text: 'CORNER SHOP' },
        { op: 'endsWith', text: 'LTD' },
      ],
      locations: [{ latitude: 51.5, longitude: -0.12 }],
    });
    expect(b.payees['PAY-EMP']).toMatchObject({ autoCategoryId: INCOME_NOW, autoAmount: null, autoMemo: null });
    expect(b.payees['PAY-SPLIT'].autoCategoryId).toBeNull();
    expect(b.payees['PAY-OLDCAT'].autoCategoryId).toBe('CAT-OLD');
    expect(b.payees['PAY-DISABLED'].hidden).toBe(true);
    expect(b.payees['Payee/Transfer:ACC-CARD']).toMatchObject({
      name: 'Transfer : Credit card',
      transferAccountId: 'ACC-CARD',
    });
    expect(b.payees['Payee/Transfer:ACC-GONE']).toBeUndefined();
    expect(b.payees['Payee/__StartingBalance__']).toEqual({
      id: 'Payee/__StartingBalance__',
      name: 'Starting Balance',
      rules: [],
    });
    // Deleted, but still used by a transaction.
    expect(b.payees['PAY-DELETED']).toEqual({ id: 'PAY-DELETED', name: 'Closed Shop', rules: [], hidden: true });
  });

  it('imports transaction details', () => {
    expect(b.transactions['T3']).toMatchObject({
      categoryId: INCOME_NEXT,
      cleared: 'U',
      accepted: false,
      amount: 10000,
    });
    expect(b.transactions['T4'].cleared).toBe('R');
    expect(b.transactions['T20']).toMatchObject({ accountId: 'ACC-CARD', amount: -750, date: '2024-02-02' });
    expect(b.transactions['T8']).toMatchObject({ categoryId: PRE_DEBT, payeeId: 'PAY-DELETED' });
  });

  it('replaces whole entities with the versions in the change files', () => {
    // The change file's T1 has a new amount and no memo, flag or import ids.
    expect(b.transactions['T1']).toEqual({
      id: 'T1',
      accountId: 'ACC-CUR',
      date: '2024-01-05',
      payeeId: 'PAY-SHOP',
      categoryId: 'CAT-FOOD',
      amount: -1300,
      cleared: 'C',
      accepted: true,
    });
  });

  it('skips deleted transactions, ones in deleted accounts, and stale changes', () => {
    expect(b.transactions['T2']).toBeUndefined(); // deleted by the change file
    expect(b.transactions['T10']).toBeUndefined();
    expect(b.transactions['T11']).toBeUndefined();
    expect(b.transactions['T5'].amount).toBe(5000);
  });

  it('links transfers in both directions', () => {
    expect(b.transactions['T4']).toMatchObject({ transferAccountId: 'ACC-CARD', transferTxId: 'T5', categoryId: null });
    expect(b.transactions['T5']).toMatchObject({ transferAccountId: 'ACC-CUR', transferTxId: 'T4' });
    // The other side was not imported, so only the account is kept.
    expect(b.transactions['T12'].transferAccountId).toBe('ACC-CARD');
    expect(b.transactions['T12'].transferTxId).toBeUndefined();
  });

  it('imports splits, including a split line that is a transfer', () => {
    const t6 = b.transactions['T6'];
    expect(t6.categoryId).toBe(SPLIT);
    expect(t6.splits).toEqual([
      { id: 'S1', categoryId: 'CAT-FOOD', amount: -6000, memo: 'food' },
      { id: 'S2', categoryId: 'CAT-RENT', amount: -1000, payeeId: 'PAY-EMP' },
      { id: 'S3', categoryId: null, amount: -3000, transferAccountId: 'ACC-SAV', transferTxId: 'T7' },
    ]);
    expect(b.transactions['T7']).toMatchObject({
      transferAccountId: 'ACC-CARD',
      transferTxId: 'T6',
      transferSplitParentId: 'T6',
    });
    // A split with no lines left becomes uncategorised.
    expect(b.transactions['T13'].categoryId).toBeNull();
    expect(b.transactions['T13'].splits).toBeUndefined();
  });

  it('keeps flags, cheque numbers and import ids from the full file', async () => {
    // Without the change files, T1 is as the full file has it.
    const files = packageFiles({
      [DATA + DEV_A + '/A-20,B-5_A-22.ydiff']: null,
      [DATA + DEV_B + '/A-22,B-5_B-6.ydiff']: null,
    });
    const { budget } = await importYnab4(virtualFolder(files), REF);
    expect(budget.transactions['T1']).toEqual({
      id: 'T1',
      accountId: 'ACC-CUR',
      date: '2024-01-05',
      payeeId: 'PAY-SHOP',
      categoryId: 'CAT-FOOD',
      memo: 'milk',
      amount: -1234,
      cleared: 'C',
      flag: 'red',
      check: '101',
      accepted: true,
      importIds: ['FITID:F1', 'YNAB:-12.34:2024-01-05:1'],
      importedPayee: 'CORNER SHOP LTD',
    });
    expect(budget.transactions['T2'].categoryId).toBe(INCOME_NOW);
    expect(budget.masters['MC-EVERY'].collapsed).toBe(true);
    expect(budget.categories['CAT-FOOD'].name).toBe('Groceries');
  });

  it('imports scheduled transactions', () => {
    expect(b.scheduled['SC1']).toEqual({
      id: 'SC1',
      accountId: 'ACC-CUR',
      date: '2024-02-01',
      startDate: '2024-02-01',
      frequency: 'Monthly',
      payeeId: 'PAY-SHOP',
      categoryId: 'CAT-RENT',
      memo: 'rent',
      amount: -50000,
      flag: 'blue',
      check: '7',
    });
    expect(b.scheduled['SC2']).toMatchObject({ frequency: 'TwiceAMonth', twiceMonthDay2: 0 });
    expect(b.scheduled['SC3'].frequency).toBe('Once');
    expect(b.scheduled['SC4'].splits).toEqual([
      { id: 'SS1', categoryId: 'CAT-FOOD', amount: -2000 },
      { id: 'SS2', categoryId: null, amount: -1000, transferAccountId: 'ACC-SAV' },
    ]);
    expect(b.scheduled['SC5']).toBeUndefined();
    expect(b.scheduled['SC6']).toMatchObject({
      frequency: 'EveryOtherWeek',
      transferAccountId: 'ACC-SAV',
      amount: -2500,
    });
  });

  it('imports monthly budgets with overspending handling and notes', () => {
    expect(b.months).toEqual({
      '2024-01': {
        'CAT-RENT': { budgeted: 50000 },
        'CAT-FOOD': { budgeted: 20050, handling: 'carry' },
        'CAT-POWER': { budgeted: 0, handling: 'buffer' },
        'CAT-HID1': { budgeted: 0, note: 'cancelled' },
      },
      '2024-02': { 'CAT-RENT': { budgeted: 52000 } },
    });
    expect(b.monthNotes).toEqual({ '2024-01': 'January notes' });
  });

  it('falls back to another Budget.yfull when the best one cannot be read', async () => {
    const files = packageFiles({ [DATA + DEV_A + '/Budget.yfull']: '{ not json' });
    const result = await importYnab4(virtualFolder(files), REF);
    expect(result.messages[0]).toMatch(new RegExp(`^Could not read ${ROOT}data1~ABCDEF01/${DEV_A}/Budget.yfull: `));
    expect(result.messages[1]).toBe(`Loaded data1~ABCDEF01/${DEV_B}/Budget.yfull (A-3,B-5)`);
  });

  it('reports a damaged change file and carries on', async () => {
    const files = packageFiles({ [DATA + DEV_A + '/A-20,B-5_A-22.ydiff']: 'garbage' });
    const result = await importYnab4(virtualFolder(files), REF);
    expect(result.messages).toContainEqual(expect.stringMatching(/^Skipped change file A-20,B-5_A-22\.ydiff: /));
    expect(result.messages).toContain('Applied 1 change file(s) newer than the full budget file.');
    expect(result.budget.accounts['ACC-CUR'].name).toBe('Current account');
  });

  it('works out what a change file covers from its name when it has no endVersion', async () => {
    const files = packageFiles({
      [DATA + DEV_A + '/A-20,B-5_A-22.ydiff']: json({ startVersion: DIFF_A.startVersion, items: DIFF_A.items }),
      // Covered by the file above, so it must not be applied after it.
      [DATA + DEV_A + '/A-20,B-5_A-21.ydiff']: json({
        startVersion: 'A-20,B-5',
        endVersion: 'A-21,B-5',
        items: [
          account('ACC-CUR', {
            entityVersion: 'A-21',
            accountName: 'Partial copy',
            accountType: 'Checking',
            onBudget: true,
          }),
        ],
      }),
    });
    const { budget, messages } = await importYnab4(virtualFolder(files), REF);
    expect(messages).toContain('Applied 2 change file(s) newer than the full budget file.');
    expect(budget.accounts['ACC-CUR'].name).toBe('Current account (renamed)');
  });

  it('drops the link to a split transfer whose transaction was not imported', async () => {
    const full = structuredClone(FULL_A);
    full.transactions.push(
      txn('T30', {
        accountId: 'ACC-GONE',
        categoryId: 'Category/__Split__',
        amount: -5,
        subTransactions: [
          {
            entityType: 'subTransaction',
            entityId: 'S30',
            amount: -5,
            targetAccountId: 'ACC-CUR',
            transferTransactionId: 'T31',
          },
        ],
      }),
      txn('T31', { accountId: 'ACC-CUR', amount: 5, targetAccountId: 'ACC-CARD', transferTransactionId: 'S30' }),
    );
    const { budget } = await importYnab4(
      virtualFolder(packageFiles({ [DATA + DEV_A + '/Budget.yfull']: json(full) })),
      REF,
    );
    expect(budget.transactions['T31']).toMatchObject({ transferAccountId: 'ACC-CARD', amount: 500 });
    expect(budget.transactions['T31'].transferTxId).toBeUndefined();
    expect(budget.transactions['T31'].transferSplitParentId).toBeUndefined();
  });

  it('explains what is missing', async () => {
    await expect(importYnab4(virtualFolder(packageFiles({ [ROOT + 'Budget.ymeta']: null })), REF)).rejects.toThrow(
      /Budget\.ymeta was not found/,
    );
    await expect(importYnab4(virtualFolder(packageFiles({ [ROOT + 'Budget.ymeta']: '{}' })), REF)).rejects.toThrow(
      /does not say where/,
    );
    const noFull = packageFiles({ [DATA + DEV_A + '/Budget.yfull']: null, [DATA + DEV_B + '/Budget.yfull']: null });
    await expect(importYnab4(virtualFolder(noFull), REF)).rejects.toThrow(/No Budget\.yfull/);
  });
});

describe('YNAB4 folder access (electron/ynab4Files)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ynab4-files-'));
    const put = async (rel: string, text = '{}') => {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), text);
    };
    await put('A.ynab4/Budget.ymeta', '{"relativeDataFolderName":"data1~X"}');
    await put('A.ynab4/readme.txt');
    await put('A.ynab4/Backup_2024.y4backup');
    await put('A.ynab4/data1~X/devices/A.ydevice');
    await put('A.ynab4/data1~X/DEV/Budget.yfull');
    await put('A.ynab4/data1~X/DEV/A-1_A-2.ydiff');
    await put('A.ynab4/data1~X/DEV/budgetSettings.ybsettings');
    await put('A.ynab4/Backups/Budget.yfull');
    await put('a/b/c/d/e/f/Budget.ymeta');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists only the files the importer needs, as POSIX paths', async () => {
    expect(await listYnab4Files(dir)).toEqual([
      'A.ynab4/Budget.ymeta',
      'A.ynab4/data1~X/DEV/A-1_A-2.ydiff',
      'A.ynab4/data1~X/DEV/Budget.yfull',
      'A.ynab4/data1~X/devices/A.ydevice',
    ]);
  });

  it('reads listed files and refuses anything else', async () => {
    expect(await readYnab4File(dir, 'A.ynab4/Budget.ymeta')).toContain('data1~X');
    await expect(readYnab4File(dir, '../outside/Budget.ymeta')).rejects.toThrow(/Refusing/);
    await expect(readYnab4File(dir, 'A.ynab4/../../Budget.ymeta')).rejects.toThrow(/Refusing/);
    await expect(readYnab4File(dir, path.join(dir, 'A.ynab4/Budget.ymeta'))).rejects.toThrow(/Refusing/);
    await expect(readYnab4File(dir, 'A.ynab4/readme.txt')).rejects.toThrow(/Refusing/);
  });
});

describe('deleted imports from YNAB4', () => {
  it('remembers deleted transactions that had bank ids, on accounts that still exist', async () => {
    const { budget: b } = await importYnab4(virtualFolder(packageFiles()), REF);
    expect(b.accounts['ACC-CUR'].deletedImports).toEqual([{ ids: ['FITID:BANK1', 'YNAB:-0.08:2024-01-10:1'] }]);
    expect(b.accounts['ACC-GONE']).toBeUndefined();
    expect(Object.values(b.transactions).some((t) => t.importIds?.includes('FITID:BANK1'))).toBe(false);
  });

  it('reads them for a budget converted earlier, with every account id', async () => {
    const r = await readYnab4DeletedImports(virtualFolder(packageFiles()), REF);
    expect(r.accountIds.has('ACC-CUR')).toBe(true);
    expect(r.accountIds.has('ACC-GONE')).toBe(true);
    expect(r.deleted.get('ACC-CUR')).toEqual([{ ids: ['FITID:BANK1', 'YNAB:-0.08:2024-01-10:1'] }]);
    expect(r.deleted.get('ACC-GONE')).toEqual([{ ids: ['FITID:BANK2'] }]);
  });
});
