// The import inbox's account matching, last-imported dates and balance check (1.3.2).
// Made-up files and digits.
import { describe, expect, it } from 'vitest';
import { parseOfx, parseQif, ynabImportId } from '../../src/import/bank';
import {
  applyLearnPlans,
  balanceCheck,
  fileShape,
  fileTokens,
  lastImported,
  matchFileToAccount,
  planLearnAccounts,
  recordImport,
  type InboxFile,
} from '../../src/import/inbox';
import { addTx, standardBudget } from './fixtures';

const qif = (name: string, rows: [string, string, string?][]): InboxFile => {
  const text = ['!Type:CCard', ...rows.flatMap(([d, t, m]) => [`D${d}`, `T${t}`, 'PSHOP', ...(m ? [`M${m}`] : []), '^'])].join('\n');
  return { fileName: name, text, parsed: parseQif(text) };
};
const ofx = (name: string, acct: string, rows: [string, string, string][] = [['20261001', '-1.00', 'A1']], balance?: string): InboxFile => {
  const text = `<OFX><BANKACCTFROM><BANKID>0<ACCTID>${acct}</BANKACCTFROM>${rows
    .map(([d, t, id]) => `<STMTTRN><DTPOSTED>${d}<TRNAMT>${t}<FITID>${id}<NAME>SHOP</STMTTRN>`)
    .join('')}${balance ? `<LEDGERBAL><BALAMT>${balance}<DTASOF>20261005</LEDGERBAL>` : ''}</OFX>`;
  return { fileName: name, text, parsed: parseOfx(text) };
};

describe('tokens', () => {
  it('takes card digits from memos and masked numbers, never years or dates from the file name', () => {
    const f = qif('statement_20261001120000.qif', [
      ['01/10/2026', '-1.00', '1234/ SHOP'],
      ['02/10/2026', '-2.00', '1234/ SHOP'],
    ]);
    expect(fileTokens(f)).toEqual(['card:1234']);
    expect(fileTokens(qif('Statements 98765432 (3).qif', [['01/10/2026', '-1.00']]))).toEqual(['name:5432']);
    expect(fileTokens(qif('export 2026.qif', [['01/10/2026', '-1.00']]))).toEqual([]);
    expect(fileShape('Statements 98765432 (3).qif')).toBe('shape:statements #.qif');
  });
});

describe('matching a file to an account', () => {
  it('is automatic on a linked OFX key or digits linked to one account', () => {
    const { b, checking, card } = standardBudget();
    b.accounts[checking].importKeys = ['ofx:0:****12345'];
    b.accounts[card].importKeys = ['card:1234'];
    expect(matchFileToAccount(b, ofx('x.ofx', '****12345'))).toMatchObject({ accountId: checking, level: 'automatic', how: 'ofx-key' });
    const f = qif('x.qif', [
      ['01/10/2026', '-1.00', '1234/ SHOP'],
      ['02/10/2026', '-2.00', '1234/ SHOP'],
    ]);
    expect(matchFileToAccount(b, f)).toMatchObject({ accountId: card, level: 'automatic', how: 'digits', reason: 'card …1234' });
  });

  it('suggests the account most of the rows were already imported into (3 rows and 20%)', () => {
    const { b, checking } = standardBudget();
    const f = ofx('x.ofx', '****99999', [
      ['20261001', '-1.00', 'A1'],
      ['20261002', '-2.00', 'A2'],
      ['20261003', '-3.00', 'A3'],
      ['20261004', '-4.00', 'A4'],
    ]);
    addTx(b, checking, '2026-10-01', -100, null, { importIds: ['FITID:A1'] });
    addTx(b, checking, '2026-10-02', -200, null, { importIds: ['FITID:A2'] });
    // 2 rows aren't enough.
    expect(matchFileToAccount(b, f).level).toBe('none');
    addTx(b, checking, '2026-10-03', -300, null, { importIds: ['FITID:A3'] });
    expect(matchFileToAccount(b, f)).toMatchObject({ accountId: checking, level: 'suggested', how: 'overlap', reason: '3 of 4 rows already imported here' });
  });

  it("never suggests an account against the file's own OFX key or card, and says when it's not in this budget", () => {
    const { b, checking } = standardBudget();
    b.accounts[checking].importKeys = ['ofx:0:****11111', 'shape:x.ofx'];
    const other = ofx('x.ofx', '****22222');
    expect(matchFileToAccount(b, other, checking)).toMatchObject({ level: 'none', foreign: 'bank account …2222' });
    b.accounts[checking].importKeys = ['card:1111', 'shape:statement_#.qif'];
    const f = qif('statement_20261001120000.qif', [
      ['01/10/2026', '-1.00', '2222/ SHOP'],
      ['02/10/2026', '-2.00', '2222/ SHOP'],
    ]);
    expect(matchFileToAccount(b, f, checking)).toMatchObject({ level: 'none', foreign: 'card …2222' });
  });

  it('suggests by file-name shape, then by the register it was opened from', () => {
    const { b, savings, checking } = standardBudget();
    b.accounts[savings].importKeys = ['shape:activity.qif'];
    expect(matchFileToAccount(b, qif('activity (4).qif', [['01/10/2026', '-1.00']]))).toMatchObject({ accountId: savings, how: 'shape' });
    expect(matchFileToAccount(b, qif('other.qif', [['01/10/2026', '-1.00']]), checking)).toMatchObject({ accountId: checking, how: 'register' });
    expect(matchFileToAccount(b, qif('other.qif', [['01/10/2026', '-1.00']]))).toMatchObject({ level: 'none', reason: 'choose an account' });
  });

  it("doesn't call a file 'not in this budget' before the budget has learned any account (1.4.4)", () => {
    const { b, checking, card } = standardBudget();
    const bank = ofx('x.ofx', '****22222');
    const cardFile = qif('statement_20261001120000.qif', [
      ['01/10/2026', '-1.00', '2222/ SHOP'],
      ['02/10/2026', '-2.00', '2222/ SHOP'],
    ]);
    // A converted budget: nothing learned yet.
    for (const f of [bank, cardFile]) {
      const m = matchFileToAccount(b, f);
      expect(m).toMatchObject({ level: 'none', reason: 'first import here: choose the account (it is remembered)' });
      expect(m.foreign).toBeUndefined();
    }
    // Once some account has an OFX key or a card, another one's file is "not in this budget".
    b.accounts[checking].importKeys = ['ofx:0:****11111'];
    expect(matchFileToAccount(b, bank)).toMatchObject({ level: 'none', reason: 'not linked to an account here', foreign: 'bank account …2222' });
    b.accounts[card].importKeys = ['card:1111'];
    expect(matchFileToAccount(b, cardFile)).toMatchObject({ level: 'none', foreign: 'card …2222' });
  });

  it('suggests a clear winner for rows already imported, though one row is also in another account (1.4.4)', () => {
    const { b, checking, card } = standardBudget();
    const rows = (n: number): [string, string, string][] => Array.from({ length: n }, (_, i) => [`202610${String(i + 1).padStart(2, '0')}`, `-${i + 1}.00`, `B${i}`]);
    const f = ofx('x.ofx', '****99999', rows(12));
    for (let i = 0; i < 11; i++) addTx(b, checking, `2026-10-${String(i + 1).padStart(2, '0')}`, -(i + 1) * 100, null, { importIds: [`FITID:B${i}`] });
    addTx(b, card, '2026-10-12', -1200, null, { importIds: ['FITID:B11'] });
    expect(matchFileToAccount(b, f)).toMatchObject({ accountId: checking, level: 'suggested', how: 'overlap', reason: '11 of 12 rows already imported here' });
    // 6 against 3 isn't clear.
    const { b: b2, checking: c2, card: k2 } = standardBudget();
    for (let i = 0; i < 6; i++) addTx(b2, c2, `2026-10-${String(i + 1).padStart(2, '0')}`, -(i + 1) * 100, null, { importIds: [`FITID:B${i}`] });
    for (let i = 6; i < 9; i++) addTx(b2, k2, `2026-10-${String(i + 1).padStart(2, '0')}`, -(i + 1) * 100, null, { importIds: [`FITID:B${i}`] });
    expect(matchFileToAccount(b2, f).level).toBe('none');
  });
});

describe('learning accounts from old bank files (1.4.4)', () => {
  const rows = (prefix: string, n: number): [string, string, string][] =>
    Array.from({ length: n }, (_, i) => [`202609${String(i + 1).padStart(2, '0')}`, `-${i + 1}.00`, `${prefix}${i}`]);
  const imported = (b: ReturnType<typeof standardBudget>['b'], accountId: string, prefix: string, n: number) => {
    for (let i = 0; i < n; i++) addTx(b, accountId, `2026-09-${String(i + 1).padStart(2, '0')}`, -(i + 1) * 100, null, { importIds: [`FITID:${prefix}${i}`] });
  };

  it("teaches each file's numbers to the account its rows are in, and nothing else", () => {
    const { b, checking } = standardBudget();
    imported(b, checking, 'A', 4);
    const before = Object.keys(b.transactions).length;
    const plans = planLearnAccounts(b, [ofx('old.ofx', '****12345', rows('A', 4)), ofx('other.ofx', '****99999', rows('Z', 4))]);
    expect(plans[0]).toMatchObject({ accountId: checking, reason: '4 of 4 rows already imported here' });
    expect(plans[0].keys).toEqual(expect.arrayContaining(['ofx:0:****12345', 'card:2345', 'shape:old.ofx']));
    // The other budget's file: none of its rows are here.
    expect(plans[1]).toMatchObject({ accountId: undefined, keys: [], reason: 'none of its rows are in this budget' });
    expect(applyLearnPlans(b, plans)).toBe(1);
    expect(b.accounts[checking].importKeys).toEqual(expect.arrayContaining(['ofx:0:****12345']));
    expect(b.accounts[checking].lastImport).toBeUndefined();
    expect(Object.keys(b.transactions).length).toBe(before);
    // The next download from that account is picked by itself.
    expect(matchFileToAccount(b, ofx('new.ofx', '****12345', rows('N', 3)))).toMatchObject({ accountId: checking, level: 'automatic' });
    // Again: nothing more to learn.
    expect(planLearnAccounts(b, [ofx('old.ofx', '****12345', rows('A', 4))])[0]).toMatchObject({ keys: [], reason: 'already known' });
  });

  it('leaves out closed accounts, numbers another account has, and numbers two files would give different accounts', () => {
    const { b, checking, savings, card } = standardBudget();
    imported(b, savings, 'S', 3);
    b.accounts[savings].closed = true;
    expect(planLearnAccounts(b, [ofx('s.ofx', '****33333', rows('S', 3))])[0]).toMatchObject({ keys: [], reason: `its rows are in ${b.accounts[savings].name}, which is closed` });

    imported(b, checking, 'C', 3);
    b.accounts[card].importKeys = ['ofx:0:****44444'];
    expect(planLearnAccounts(b, [ofx('c.ofx', '****44444', rows('C', 3))])[0]).toMatchObject({ keys: [], reason: `its numbers already belong to ${b.accounts[card].name}` });

    b.accounts[card].importKeys = [];
    imported(b, card, 'K', 3);
    const [one, two] = planLearnAccounts(b, [ofx('c.ofx', '****55555', rows('C', 3)), ofx('k.ofx', '****55555', rows('K', 3))]);
    for (const p of [one, two]) expect(p).toMatchObject({ keys: [], reason: "other files with its numbers or name aren't this account's (the other budget's?)" });
    expect(one.accountId).toBe(checking);
  });

  it('counts a row for every account holding its id, so ids repeated in two accounts decide nothing', () => {
    const { b, checking, savings } = standardBudget();
    imported(b, savings, 'T', 3);
    // The same bank ids in another account too (Nationwide repeats them).
    imported(b, checking, 'T', 3);
    imported(b, checking, 'C', 3);
    expect(planLearnAccounts(b, [ofx('flex.ofx', '****22222', rows('T', 3))])[0]).toMatchObject({ keys: [], reason: 'its rows are not clearly in one account' });
  });

  it("doesn't learn a number that a file split between accounts also has", () => {
    const { b, checking, savings } = standardBudget();
    imported(b, checking, 'G', 3);
    imported(b, checking, 'F', 3);
    imported(b, savings, 'S', 3);
    const g = ofx('g.ofx', '****55555', rows('G', 3));
    const split = ofx('f.ofx', '****55555', [...rows('F', 3), ...rows('S', 3)]);
    expect(planLearnAccounts(b, [g])[0].keys).toContain('ofx:0:****55555');
    expect(planLearnAccounts(b, [g, split])[0].keys).not.toContain('ofx:0:****55555');
  });

  it("doesn't learn a file name's shape that the other budget's files share, nor from a file with under 3 rows here", () => {
    const { b, card, checking } = standardBudget();
    const plain = (name: string, day0: number) =>
      qif(name, [0, 1, 2].map((i): [string, string] => [`${String(day0 + i).padStart(2, '0')}/09/2026`, `-${i + 1}.00`]));
    const mine = plain('data.qif', 1);
    for (const s of mine.parsed.txns) addTx(b, card, s.date, s.amount, null, { importIds: [ynabImportId(s, 1)] });
    expect(planLearnAccounts(b, [mine])[0].keys).toEqual(['shape:data.qif']);
    // An older "data (1).qif" whose rows aren't here: the other budget's.
    const theirs = plain('data (1).qif', 10);
    for (const s of theirs.parsed.txns) s.date = s.date.replace('2026-09', '2026-08');
    expect(planLearnAccounts(b, [mine, theirs])[0]).toMatchObject({ keys: [] });
    // Two rows aren't enough to be sure.
    imported(b, checking, 'W', 2);
    expect(planLearnAccounts(b, [ofx('w.ofx', '****88888', rows('W', 2))])[0]).toMatchObject({ keys: [], reason: 'too few of its rows are here to be sure' });
  });

  it("leaves out a number an old file of the other budget has, but not one only a newer download has", () => {
    const { b, checking } = standardBudget();
    imported(b, checking, 'J', 4);
    const mine = ofx('joint.ofx', '****77777', rows('J', 4));
    // The same number in an older file whose rows aren't here: the other budget's, imported there.
    const old: [string, string, string][] = [['20260801', '-5.00', 'P1'], ['20260802', '-6.00', 'P2']];
    expect(planLearnAccounts(b, [mine, ofx('personal.ofx', '****77777', old)])[0]).toMatchObject({ keys: [] });
    // A download newer than the account's last import just hasn't been imported yet.
    const newer: [string, string, string][] = [['20261020', '-5.00', 'N1'], ['20261021', '-6.00', 'N2']];
    expect(planLearnAccounts(b, [mine, ofx('new.ofx', '****77777', newer)])[0].keys).toContain('ofx:0:****77777');
    // An old file imported from another format (other ids), whose amounts are in this account
    // within 3 days, is this account's own.
    addTx(b, checking, '2026-08-02', -500, null);
    addTx(b, checking, '2026-08-05', -600, null);
    expect(planLearnAccounts(b, [mine, ofx('personal.ofx', '****77777', old)])[0].keys).toContain('ofx:0:****77777');
  });

  it("doesn't learn from a file whose rows aren't clearly in one account", () => {
    const { b, checking, card } = standardBudget();
    imported(b, checking, 'M', 3);
    for (let i = 3; i < 6; i++) addTx(b, card, `2026-09-0${i + 1}`, -(i + 1) * 100, null, { importIds: [`FITID:M${i}`] });
    expect(planLearnAccounts(b, [ofx('m.ofx', '****66666', rows('M', 6))])[0]).toMatchObject({ keys: [], reason: 'its rows are not clearly in one account' });
  });
});

describe('learning and dates', () => {
  it('learns the keys, moves unique ones off other accounts, and records the last date imported', () => {
    const { b, checking, savings } = standardBudget();
    b.accounts[savings].importKeys = ['card:1234', 'shape:statement_#.qif'];
    const f = qif('statement_20261001120000.qif', [
      ['01/10/2026', '-1.00', '1234/ SHOP'],
      ['09/10/2026', '-2.00', '1234/ SHOP'],
    ]);
    recordImport(b, checking, f, '2026-10-12T10:00:00Z');
    expect(b.accounts[checking].importKeys).toEqual(['card:1234', 'shape:statement_#.qif']);
    expect(b.accounts[savings].importKeys).toEqual(['shape:statement_#.qif']);
    expect(b.accounts[checking].lastImport).toEqual({ to: '2026-10-09', at: '2026-10-12T10:00:00Z' });
    // An older file doesn't move the date back.
    recordImport(b, checking, qif('old.qif', [['01/09/2026', '-1.00']]), '2026-10-13T10:00:00Z');
    expect(b.accounts[checking].lastImport?.to).toBe('2026-10-09');
  });

  it("falls back to the newest imported transaction, and checks the bank's balance at the last row", () => {
    const { b, checking } = standardBudget();
    expect(lastImported(b, checking)).toBeNull();
    addTx(b, checking, '2026-09-20', 10_000, null, { importIds: ['x'] });
    addTx(b, checking, '2026-10-02', -2_500, null);
    expect(lastImported(b, checking)).toBe('2026-09-20');
    expect(balanceCheck(b, checking, { balance: 7_500, lastDate: '2026-10-02' })).toEqual({ date: '2026-10-02', bank: 7_500, register: 7_500, difference: 0 });
    expect(balanceCheck(b, checking, { balance: 10_000, lastDate: '2026-09-30' })?.difference).toBe(0);
    expect(balanceCheck(b, checking, { lastDate: '2026-09-30' })).toBeNull();
  });
});
