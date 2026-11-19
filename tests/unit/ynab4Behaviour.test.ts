// Behaviour brought in line with YNAB4 in 1.2.
import { describe, expect, it } from 'vitest';
import { moveToScheduler, saveTransaction } from '../../src/model/ops';
import { standardBudget } from './fixtures';

describe('Move to Scheduler', () => {
  it('turns a transaction into a one-off scheduled transaction on the same date', () => {
    const { b, checking, groceries } = standardBudget();
    const id = saveTransaction(b, { accountId: checking, date: '2026-12-01', payeeName: 'Shop', categoryId: groceries, amount: -1500, memo: 'gift', cleared: 'U' });
    const sid = moveToScheduler(b, id)!;
    expect(b.transactions[id]).toBeUndefined();
    expect(b.scheduled[sid]).toMatchObject({ accountId: checking, date: '2026-12-01', frequency: 'Once', categoryId: groceries, amount: -1500, memo: 'gift' });
  });

  it('moves a transfer as a scheduled transfer, removing both sides', () => {
    const { b, checking, savings } = standardBudget();
    const id = saveTransaction(b, { accountId: checking, date: '2026-12-01', transferAccountId: savings, amount: -5000, cleared: 'U' });
    const peer = b.transactions[id].transferTxId!;
    const sid = moveToScheduler(b, id)!;
    expect(b.transactions[id]).toBeUndefined();
    expect(b.transactions[peer]).toBeUndefined();
    expect(b.scheduled[sid]).toMatchObject({ transferAccountId: savings, amount: -5000 });
  });
});

describe('approving, as in YNAB4', () => {
  it('scheduler entries arrive unapproved; "Enter now" is approved', async () => {
    const { saveScheduled, enterDueScheduled, enterScheduled } = await import('../../src/model/ops');
    const { b, checking, rent } = standardBudget();
    const s1 = saveScheduled(b, { accountId: checking, date: '2026-10-01', startDate: '2026-10-01', frequency: 'Monthly', categoryId: rent, amount: -300 });
    expect(enterDueScheduled(b, '2026-10-02')).toBe(1);
    const auto = Object.values(b.transactions).find((t) => t.scheduleId === s1)!;
    expect(auto.accepted).toBe(false);
    const manual = enterScheduled(b, s1, '2026-10-05', true)!;
    expect(b.transactions[manual].accepted).toBe(true);
  });

  it('clearing or reconciling approves', async () => {
    const { toggleCleared, setCleared, reconcileAccount } = await import('../../src/model/ops');
    const { addTx } = await import('./fixtures');
    const { b, checking } = standardBudget();
    const a = addTx(b, checking, '2026-10-01', -100, null, { accepted: false });
    const c = addTx(b, checking, '2026-10-02', -200, null, { accepted: false });
    const r = addTx(b, checking, '2026-10-03', -300, null, { accepted: false, cleared: 'C' });
    toggleCleared(b, a);
    expect(b.transactions[a].accepted).toBe(true);
    setCleared(b, [c], 'U');
    expect(b.transactions[c].accepted).toBe(false);
    setCleared(b, [c], 'C');
    expect(b.transactions[c].accepted).toBe(true);
    b.transactions[c].accepted = false;
    reconcileAccount(b, checking, -600, '2026-10-10');
    expect(b.transactions[r].accepted).toBe(true);
    expect(b.transactions[c].accepted).toBe(true);
  });
});

describe('switching an account on or off budget', () => {
  it('can switch at any time; transfer categories follow the new rule', async () => {
    const { setAccountOnBudget } = await import('../../src/model/ops');
    const { compute } = await import('../../src/model/engine');
    const { b, checking, savings, mortgage, rent } = standardBudget();
    // A budget -> tracking transfer needs a category on the budget side.
    const out = saveTransaction(b, { accountId: checking, date: '2026-10-05', transferAccountId: mortgage, categoryId: rent, amount: -50000, cleared: 'U' });
    const peer = b.transactions[out].transferTxId!;
    const shop = saveTransaction(b, { accountId: mortgage, date: '2026-10-06', payeeName: 'Fee', amount: -1000, cleared: 'U' });
    expect(b.transactions[out].categoryId).toBe(rent);

    setAccountOnBudget(b, mortgage, true);
    // Between two budget accounts the category would count as spending, so it goes.
    expect(b.transactions[out].categoryId).toBeNull();
    expect(b.transactions[peer].categoryId).toBeNull();
    const c = compute(b);
    expect(c.uncategorized).toContain(shop);
    expect(c.uncategorized).not.toContain(out);

    setAccountOnBudget(b, mortgage, false);
    expect(compute(b).uncategorized).toContain(out);
    expect(compute(b).uncategorized).not.toContain(shop);

    // Savings going off budget: transfers from checking now need a category.
    const tr = saveTransaction(b, { accountId: checking, date: '2026-10-07', transferAccountId: savings, amount: -2000, cleared: 'U' });
    setAccountOnBudget(b, savings, false);
    expect(compute(b).uncategorized).toContain(tr);
  });

  it('keeps the account\'s own categories, so switching back restores them', async () => {
    const { setAccountOnBudget } = await import('../../src/model/ops');
    const { addTx } = await import('./fixtures');
    const { b, savings, groceries } = standardBudget();
    const t = addTx(b, savings, '2026-10-01', -500, groceries);
    setAccountOnBudget(b, savings, false);
    setAccountOnBudget(b, savings, true);
    expect(b.transactions[t].categoryId).toBe(groceries);
  });
});

describe('Adjust Balance', () => {
  it('enters a Manual Balance Adjustment for the difference, as income on a budget account', async () => {
    const { adjustBalance } = await import('../../src/model/ops');
    const { addTx } = await import('./fixtures');
    const { INCOME_NOW } = await import('../../src/model/types');
    const { b, checking, mortgage } = standardBudget();
    addTx(b, checking, '2026-10-01', 10000, INCOME_NOW);
    addTx(b, checking, '2026-10-02', -2500, null);
    const id = adjustBalance(b, checking, 9000, '2026-10-10')!;
    expect(b.transactions[id]).toMatchObject({ amount: 1500, categoryId: INCOME_NOW, date: '2026-10-10', cleared: 'C' });
    expect(b.payees[b.transactions[id].payeeId!].name).toBe('Manual Balance Adjustment');
    expect(adjustBalance(b, checking, 9000, '2026-10-10')).toBeNull();
    const off = adjustBalance(b, mortgage, -100000, '2026-10-10')!;
    expect(b.transactions[off].categoryId).toBeNull();
  });
});
