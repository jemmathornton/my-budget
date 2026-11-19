// Random checks of "Learn accounts from old bank files" (1.4.4), as in
// docs/research/night3-scripts/learn-fuzz.ts: made-up budgets whose bank files share account
// numbers, repeat ids across accounts, or belong to the other budget. Counted independently of
// planLearnAccounts: no number is learned against a file clearly in another account or split
// between accounts, none ends up on two accounts, and no file is then picked automatically for
// the wrong account. The code before night four's review fixes (9af7fdb) fails it.
import { describe, expect, it } from 'vitest';
import { parseOfx } from '../../src/import/bank';
import { applyLearnPlans, matchFileToAccount, planLearnAccounts, type InboxFile } from '../../src/import/inbox';
import { addAccount, saveTransaction } from '../../src/model/ops';
import type { Id } from '../../src/model/types';
import { emptyBudget } from './fixtures';

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('learning accounts, random checks (1.4.4)', () => {
  it('never learns a number against the evidence, nor picks a file for the wrong account', () => {
    const rnd = rng(7);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const problems: string[] = [];
    for (let trial = 0; trial < 500; trial++) {
      const b = emptyBudget();
      const accts: Id[] = ['A', 'B', 'C'].map((n) => addAccount(b, { name: n, type: 'Checking', onBudget: true }, 0, '2026-01-01'));
      const files: InboxFile[] = [];
      for (let i = 0, n = 1 + Math.floor(rnd() * 9); i < n; i++) {
        const owner = pick([...accts, null, null]);
        const trn: string[] = [];
        const month = String(3 + Math.floor(rnd() * 7)).padStart(2, '0');
        for (let r = 0, rows = 1 + Math.floor(rnd() * 7); r < rows; r++) {
          const date = `2026-${month}-${String(1 + Math.floor(rnd() * 27)).padStart(2, '0')}`;
          const amount = -(1 + Math.floor(rnd() * 5000));
          const fitid = `F${i}R${r}`;
          trn.push(`<STMTTRN><DTPOSTED>${date.replace(/-/g, '')}<TRNAMT>${(amount / 100).toFixed(2)}<FITID>${fitid}<NAME>SHOP</STMTTRN>`);
          if (owner && rnd() < 0.85) saveTransaction(b, { accountId: owner, date, amount, cleared: 'C', importIds: ['FITID:' + fitid] });
          if (rnd() < 0.15) saveTransaction(b, { accountId: pick(accts), date, amount, cleared: 'C', importIds: ['FITID:' + fitid] });
        }
        const text = `<OFX><BANKACCTFROM><BANKID>0<ACCTID>****${pick(['11111', '22222', '33333'])}</BANKACCTFROM>${trn.join('')}</OFX>`;
        files.push({ fileName: `f${i}.ofx`, text, parsed: parseOfx(text) });
      }
      // Each file's clear winner, counted here: a row counts for every account holding its id.
      const holders = new Map<string, Set<Id>>();
      for (const t of Object.values(b.transactions)) for (const id of t.importIds ?? []) (holders.get(id) ?? holders.set(id, new Set()).get(id)!).add(t.accountId);
      const wins = files.map((f) => {
        const hits = new Map<Id, number>();
        for (const t of f.parsed.txns) for (const a of holders.get('FITID:' + t.fitid) ?? []) hits.set(a, (hits.get(a) ?? 0) + 1);
        const [top, second] = [...hits].sort((x, y) => y[1] - x[1]);
        const n = f.parsed.txns.length;
        const clear = top && (!second || top[1] >= 4 * second[1]) && top[1] >= Math.min(3, n) && top[1] >= 0.2 * n;
        return { id: clear ? top[0] : undefined, split: !clear && hits.size > 0 };
      });
      applyLearnPlans(b, planLearnAccounts(b, files));
      for (const a of accts) {
        for (const k of (b.accounts[a].importKeys ?? []).filter((k) => k.startsWith('ofx:'))) {
          files.forEach((f, i) => {
            if (f.parsed.accountKey !== k) return;
            if ((wins[i].id && wins[i].id !== a) || wins[i].split) problems.push(`trial ${trial}: ${k} learned for ${b.accounts[a].name} against f${i}`);
          });
          if (accts.some((o) => o !== a && b.accounts[o].importKeys?.includes(k))) problems.push(`trial ${trial}: ${k} on two accounts`);
        }
      }
      files.forEach((f, i) => {
        const m = matchFileToAccount(b, f);
        if (m.level === 'automatic' && wins[i].id && m.accountId !== wins[i].id) problems.push(`trial ${trial}: f${i} picked for the wrong account`);
      });
    }
    expect(problems).toEqual([]);
  });
});
