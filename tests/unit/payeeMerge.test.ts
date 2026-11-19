// Payee merge suggestions (1.3.1). Made-up bank texts.
import { describe, expect, it } from 'vitest';
import { planImport } from '../../src/import/match';
import { mergePayees, saveScheduled, saveTransaction, setPayeeRules } from '../../src/model/ops';
import { dismissMerge, keepSeparate, mergePayeeGroups, suggestMerges } from '../../src/model/payeeMerge';
import type { Budget, Id } from '../../src/model/types';
import { standardBudget } from './fixtures';

let n = 0;
/** An imported transaction whose payee is named after its bank text, as imports do. */
function imp(b: Budget, accountId: Id, text: string, amount: number, categoryId: Id | null = null, date = '2026-01-05') {
  return saveTransaction(b, { accountId, date, payeeName: text, importedPayee: text, importIds: ['i' + ++n], amount, categoryId, cleared: 'C' });
}
const payeeOf = (b: Budget, txId: Id) => b.transactions[txId].payeeId!;

describe('suggestMerges', () => {
  it('groups payees whose texts name the same merchant, most used first', () => {
    const { b, checking, groceries } = standardBudget();
    const a = imp(b, checking, 'TESCO STORES 1111 TOWNA GB', -100, groceries);
    imp(b, checking, 'TESCO STORES 1111 TOWNA GB', -200, groceries);
    const c = imp(b, checking, 'TESCO STORES 2222 TOWNB GB', -300, groceries);
    imp(b, checking, 'CORNER CAFE', -50);
    const g = suggestMerges(b);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ key: 'tesco stores', payeeIds: [payeeOf(b, a), payeeOf(b, c)], name: 'TESCO STORES 1111 TOWNA GB', transactions: 3 });
    expect(g[0].texts[0]).toEqual({ text: 'TESCO STORES 1111 TOWNA GB', n: 2 });
    expect(g[0].categories).toEqual([{ categoryId: groceries, n: 3 }]);
  });

  it('never groups nameless lines, processors on their own, or people by one name', () => {
    const { b, checking } = standardBudget();
    imp(b, checking, 'Credit 05 Jan 2026', 100);
    imp(b, checking, 'Credit 12 Jan 2026', 200);
    imp(b, checking, 'PAYPAL', -100);
    imp(b, checking, 'PAYPAL *', -200);
    imp(b, checking, 'TRANSFER FROM JANE SMITH', 100);
    imp(b, checking, 'TRANSFER FROM JOHN SMITH', 100);
    expect(suggestMerges(b)).toEqual([]);
  });

  it('keeps the bank’s own lines to one account, and leaves out transfer payees and "keep separate"', () => {
    const { b, checking, savings } = standardBudget();
    imp(b, checking, 'INTEREST PAID AFTER TAX 0.00 DEDUCTED, 0.42', 42);
    imp(b, checking, 'INTEREST PAID AFTER TAX 0.00 DEDUCTED, 0.51', 51);
    expect(suggestMerges(b).map((g) => g.key)).toEqual([`bank:interest:${checking}`]);
    const x = imp(b, savings, 'INTEREST PAID AFTER TAX 0.00 DEDUCTED, 0.60', 60);
    expect(suggestMerges(b).map((g) => g.key)).toEqual([`bank:interest:${checking}`]);
    // An amount the bank put on the end comes off the suggested name.
    expect(suggestMerges(b)[0].name).toBe('INTEREST PAID AFTER TAX 0.00 DEDUCTED');
    keepSeparate(b, suggestMerges(b)[0].payeeIds);
    expect(suggestMerges(b)).toEqual([]);
    expect(b.payees[payeeOf(b, x)].noMerge).toBeUndefined();
  });

  it('brings a dismissed group back only when a new payee joins it, with just the new one', () => {
    const { b, checking } = standardBudget();
    imp(b, checking, 'UBER TRIP AAA', -500);
    imp(b, checking, 'UBER TRIP BBB', -600);
    dismissMerge(b, suggestMerges(b)[0]);
    expect(suggestMerges(b)).toEqual([]);
    const c = imp(b, checking, 'UBER TRIP CCC', -700);
    const g = suggestMerges(b);
    expect(g).toHaveLength(1);
    expect(g[0].fresh).toEqual([payeeOf(b, c)]);
  });
});

describe('merging', () => {
  it('moves transactions and schedules, learns the bank texts, and keeps your rules', () => {
    const { b, checking, groceries } = standardBudget();
    const a = imp(b, checking, 'TESCO STORES 1111 TOWNA GB', -100, groceries);
    imp(b, checking, 'TESCO STORES 1111 TOWNA GB', -150, groceries);
    const c = imp(b, checking, 'TESCO STORES 2222 TOWNB GB, 3.00', -300, groceries);
    const typed = saveTransaction(b, { accountId: checking, date: '2026-01-06', payeeName: 'My Tesco', amount: -400, categoryId: groceries, cleared: 'C', importedPayee: 'TESCO STORES 3333 TOWNC GB', importIds: ['t'] });
    const [pa, pc, pt] = [payeeOf(b, a), payeeOf(b, c), payeeOf(b, typed)];
    setPayeeRules(b, pc, [{ op: 'contains', text: 'TESCO EXPRESS' }]);
    const sid = saveScheduled(b, { accountId: checking, date: '2026-02-01', startDate: '2026-02-01', frequency: 'Monthly', payeeId: pc, categoryId: groceries, amount: -300 });
    const g = suggestMerges(b);
    expect(g[0].payeeIds[0]).toBe(pa);
    mergePayeeGroups(b, [{ payeeIds: g[0].payeeIds, name: 'Tesco Stores' }]);
    expect(b.payees[pc]).toBeUndefined();
    expect(b.payees[pt]).toBeUndefined();
    expect(b.payees[pa].name).toBe('Tesco Stores');
    expect(b.transactions[c].payeeId).toBe(pa);
    expect(b.scheduled[sid].payeeId).toBe(pa);
    // Bank texts are learned (without the row's own amount); only the typed name becomes a rule.
    expect(b.payees[pa].bankTexts).toEqual(['tesco stores 2222 townb gb', 'tesco stores 3333 townc gb']);
    expect(b.payees[pa].rules).toHaveLength(2);
    expect(b.payees[pa].rules).toEqual(
      expect.arrayContaining([
        { op: 'contains', text: 'TESCO EXPRESS' },
        { op: 'is', text: 'My Tesco' },
      ]),
    );
    expect(b.payees[pa].autoCategoryId).toBe(groceries);
  });

  it('recognises a learned bank text when importing, as the payee itself', () => {
    const { b, checking, groceries } = standardBudget();
    imp(b, checking, 'TESCO STORES 1111 TOWNA GB', -100, groceries);
    const c = imp(b, checking, 'TESCO STORES 2222 TOWNB GB', -300, groceries);
    const keep = suggestMerges(b)[0].payeeIds[0];
    mergePayees(b, [keep, payeeOf(b, c)], keep, { learnTexts: true });
    // Fresh Start drops transactions, so recognition can't rely on them: learned texts survive.
    for (const id of Object.keys(b.transactions)) if (b.transactions[id].importedPayee) delete b.transactions[id];
    const plan = planImport(b, checking, [{ date: '2026-03-01', amount: -999, payee: 'TESCO STORES 2222 TOWNB GB', memo: '' }]);
    expect(plan[0]).toMatchObject({ payeeId: keep });
    expect(plan[0].payeeVia).toBeUndefined();
  });

  it('without learnTexts, combining works as before (names become "is" rules)', () => {
    const { b, checking } = standardBudget();
    const a = imp(b, checking, 'SHOP A', -1);
    const c = imp(b, checking, 'SHOP B', -2);
    mergePayees(b, [payeeOf(b, a), payeeOf(b, c)], payeeOf(b, a));
    expect(b.payees[payeeOf(b, a)].rules).toEqual([{ op: 'is', text: 'SHOP B' }]);
    expect(b.payees[payeeOf(b, a)].bankTexts).toBeUndefined();
  });
});

describe('payee drop-down ranking', () => {
  it('ranks payees and transfers by how often they are used', async () => {
    const { payeeOptions } = await import('../../src/ui/common/options');
    const { b, checking, savings } = standardBudget();
    for (let i = 0; i < 3; i++) imp(b, checking, 'TESCO', -100 - i);
    imp(b, checking, 'TEA ROOM', -50);
    saveTransaction(b, { accountId: checking, date: '2026-01-07', transferAccountId: savings, amount: -10, cleared: 'C' });
    const opts = payeeOptions(b, checking);
    const rank = (label: string) => opts.find((o) => o.label === label)?.rank;
    expect(rank('TESCO')).toBe(3);
    expect(rank('TEA ROOM')).toBe(1);
    expect(rank('Transfer : Savings')).toBe(1);
  });
});
