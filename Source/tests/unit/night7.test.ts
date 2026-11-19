// Night seven's drafts (docs/research/night7.md). Made-up budgets only.
import { describe, expect, it } from 'vitest';
import { applyImport, planImport } from '../../src/import/match';
import { approveTransactions, enterDueScheduled, enterScheduled, saveScheduled, toggleCleared } from '../../src/model/ops';
import { standardBudget } from './fixtures';

describe("a scheduled transfer's other side (M10, as in YNAB4)", () => {
  function scheduledTransfer() {
    const s = standardBudget();
    const sid = saveScheduled(s.b, { accountId: s.checking, date: '2026-11-01', startDate: '2026-11-01', frequency: 'Monthly', transferAccountId: s.savings, categoryId: null, amount: -5000 });
    return { ...s, sid };
  }
  const sides = (b: ReturnType<typeof standardBudget>['b'], sid: string) => {
    const t = Object.values(b.transactions).find((x) => x.scheduleId === sid)!;
    return [t, b.transactions[t.transferTxId!]] as const;
  };

  it('arrives unapproved on both sides when the scheduler enters it', () => {
    const { b, sid } = scheduledTransfer();
    expect(enterDueScheduled(b, '2026-11-01')).toBe(1);
    const [mine, far] = sides(b, sid);
    expect([mine.accepted, far.accepted]).toEqual([false, false]);
  });

  it('is approved with either side', () => {
    const { b, sid } = scheduledTransfer();
    enterDueScheduled(b, '2026-11-01');
    let [mine, far] = sides(b, sid);
    approveTransactions(b, [far.id]);
    [mine, far] = sides(b, sid);
    expect([mine.accepted, far.accepted]).toEqual([true, true]);
  });

  it('is approved when its side with a bank file is cleared or matched', () => {
    const one = scheduledTransfer();
    enterDueScheduled(one.b, '2026-11-01');
    toggleCleared(one.b, sides(one.b, one.sid)[0].id);
    expect(sides(one.b, one.sid)[1].accepted).toBe(true);

    for (const approve of [true, false]) {
      const { b, checking, sid } = scheduledTransfer();
      enterDueScheduled(b, '2026-11-01');
      const plan = planImport(b, checking, [{ date: '2026-11-02', amount: -5000, payee: 'TO SAVER', memo: '' }]);
      expect(plan[0].kind).toBe('match');
      applyImport(b, checking, plan, approve);
      let [mine, far] = sides(b, sid);
      expect([mine.accepted, far.accepted]).toEqual([approve, approve]);
      if (!approve) {
        approveTransactions(b, [mine.id]);
        [mine, far] = sides(b, sid);
        expect([mine.accepted, far.accepted]).toEqual([true, true]);
      }
    }
  });

  it('is approved when entered by hand ("Enter now")', () => {
    const { b, sid } = scheduledTransfer();
    enterScheduled(b, sid, undefined, true);
    const [mine, far] = sides(b, sid);
    expect([mine.accepted, far.accepted]).toEqual([true, true]);
  });

  it("leaves the other side's own waiting bank match to be looked at", () => {
    const { b, card, sid, checking } = scheduledTransfer();
    b.scheduled[sid].transferAccountId = card;
    enterDueScheduled(b, '2026-11-01');
    const [, far] = sides(b, sid);
    // The card's file matches the card side; it waits for approval.
    applyImport(b, card, planImport(b, card, [{ date: '2026-11-03', amount: 5000, payee: 'PAYMENT RECEIVED', memo: '' }]), false);
    expect(b.transactions[far.id].matched).toBeTruthy();
    const mine = Object.values(b.transactions).find((x) => x.scheduleId === sid && x.accountId === checking)!;
    approveTransactions(b, [mine.id]);
    expect(b.transactions[far.id].accepted).toBe(false);
    expect(b.transactions[far.id].matched).toBeTruthy();
  });
});

describe("a CSV's type column feeds the card sign check (Barclaycard)", () => {
  // Laid out like Barclaycard's new CSV (made-up rows).
  const csv = (payment: string) =>
    [
      'Date,Account/Card No,Outflow,Subcategory,Memo',
      ...[1, 2, 3, 4, 5].map((d) => `0${d}/10/2026,************1234,1${d}.50,Purchase,"SHOP ${d}             SHOP ${d} TOWN"`),
      `06/10/2026,************1234,${payment},Payment,"BARCLAYCARD           "`,
    ].join('\r\n');

  it('reads the type, and warns only when a payment comes in as spending', async () => {
    const { guessCsvMapping, parseCsv, splitCsv } = await import('../../src/import/bank');
    const { signWarning } = await import('../../src/import/match');
    const { b, card } = standardBudget();
    for (const [payment, warn] of [['-250.00', false], ['250.00', true]] as const) {
      const text = csv(payment);
      const p = parseCsv(text, guessCsvMapping(splitCsv(text)));
      expect(p.txns.map((t) => t.kind)).toEqual(['Purchase', 'Purchase', 'Purchase', 'Purchase', 'Purchase', 'Payment']);
      expect(p.txns[0].amount).toBe(-1150);
      expect(signWarning(b, card, p.txns) ?? '').toMatch(warn ? /card payment comes in as spending/ : /^$/);
    }
  });

  it('leaves files without a type column as they were', async () => {
    const { guessCsvMapping, parseCsv, splitCsv } = await import('../../src/import/bank');
    const text = 'Date,Description,Amount\r\n01/10/2026,SHOP,-1.00';
    expect(parseCsv(text, guessCsvMapping(splitCsv(text))).txns[0].kind).toBeUndefined();
  });
});

describe("the second review of 1.5.3's fixes", () => {
  it('pairs a transfer imported from two files on the earlier date (I1)', async () => {
    const { lastImported, balanceCheck } = await import('../../src/import/inbox');
    const { setPayeeRules } = await import('../../src/model/ops');
    const { transferPayeeId } = await import('../../src/model/queries');
    const { b, checking, savings } = standardBudget();
    const row = (date: string, amount: number, payee: string, fitid: string) => ({ date, amount, payee, memo: '', fitid });
    // The card's file first: the payment arrives on the 31st.
    applyImport(b, savings, planImport(b, savings, [row('2026-10-20', -1000, 'SHOP', 'S0'), row('2026-10-31', 5000, 'PAYMENT THANK YOU', 'S1')]));
    // Then the current account's, which ends on the 29th with that payment, made a transfer by a rule.
    setPayeeRules(b, transferPayeeId(savings), [{ op: 'contains', text: 'TO CARD' }]);
    applyImport(b, checking, planImport(b, checking, [row('2026-10-02', 100000, 'SALARY', 'C0'), row('2026-10-29', -5000, 'DD TO CARD', 'C1')]));
    const pay = Object.values(b.transactions).filter((t) => Math.abs(t.amount) === 5000);
    expect(pay).toHaveLength(2);
    expect(pay.map((t) => t.date)).toEqual(['2026-10-29', '2026-10-29']);
    expect(pay[0].transferTxId).toBe(pay[1].id);
    expect(lastImported(b, checking)).toBe('2026-10-29');
    expect(balanceCheck(b, checking, { balance: 95000, lastDate: '2026-10-29' })?.difference).toBe(0);
  });

  it('checks every group of digits split by spaces (M8)', async () => {
    const { parseMoneyInput } = await import('../../src/model/money');
    for (const t of ['1 250 50', '1 250 00', '12 345 6', '12 50']) expect(parseMoneyInput(t)).toBeNull();
    expect(parseMoneyInput('1 250 000')).toBe(125000000);
    expect(parseMoneyInput('£1 250.50')).toBe(125050);
  });

  it('warns about a card payment in a short file, but not a reversed one (I7)', async () => {
    const { signWarning } = await import('../../src/import/match');
    const { b, card } = standardBudget();
    const r = (payee: string, amount: number) => ({ date: '2026-11-03', amount, payee, memo: '' });
    expect(signWarning(b, card, [r('PAYMENT, THANK YOU', -25000)])).toMatch(/card payment comes in as spending/);
    expect(signWarning(b, card, [r('PAYMENT REVERSAL', -25000)])).toBeNull();
    expect(signWarning(b, card, [r('PAYMENT, THANK YOU', 25000)])).toBeNull();
  });
});

describe("the approval cascade stays with scheduled transfers (draft review)", () => {
  it("leaves an ordinary transfer's other side as it is", async () => {
    const { saveTransaction } = await import('../../src/model/ops');
    const { b, checking, savings } = standardBudget();
    const id = saveTransaction(b, { accountId: checking, date: '2026-11-01', transferAccountId: savings, amount: -100, cleared: 'U', accepted: false });
    const far = b.transactions[id].transferTxId!;
    b.transactions[far].accepted = false; // held back by an import, say
    approveTransactions(b, [id]);
    expect(b.transactions[far].accepted).toBe(false);
  });

  it("approves every side of a scheduled split transfer from any one of them", () => {
    const { b, checking, savings, card, groceries } = standardBudget();
    const sid = saveScheduled(b, {
      accountId: checking, date: '2026-11-01', startDate: '2026-11-01', frequency: 'Monthly', categoryId: '__split__' as never, amount: -300,
      splits: [
        { id: 'l1', categoryId: null, amount: -100, transferAccountId: savings },
        { id: 'l2', categoryId: null, amount: -150, transferAccountId: card },
        { id: 'l3', categoryId: groceries, amount: -50 },
      ],
    });
    enterDueScheduled(b, '2026-11-01');
    const parent = Object.values(b.transactions).find((t) => t.scheduleId === sid)!;
    const peers = parent.splits!.filter((s) => s.transferTxId).map((s) => b.transactions[s.transferTxId!]);
    expect(peers).toHaveLength(2);
    expect([parent.accepted, ...peers.map((t) => t.accepted)]).toEqual([false, false, false]);
    approveTransactions(b, [peers[0].id]);
    expect([b.transactions[parent.id].accepted, ...peers.map((t) => b.transactions[t.id].accepted)]).toEqual([true, true, true]);
  });
});
