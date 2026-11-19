import { formatDate, monthLabel, monthRange, today } from './dates';
import { compute, categoryMonth } from './engine';
import { moneyToInput } from './money';
import { categoriesOf, categoryLabel, payeeName, sortedAccounts, sortedMasters } from './queries';
import { SPLIT, type Budget } from './types';

// "Export budget data", like YNAB4: Budget.csv (every month and category) and
// Register.csv (every transaction, with split lines on their own rows).

function csvField(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function csv(rows: (string | number)[][]): string {
  // Excel needs the byte order mark to read UTF-8 (for the £ sign).
  return String.fromCharCode(0xfeff) + rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

const amount = (n: number) => (n ? moneyToInput(n) : '0.00');

/**
 * A name or memo that Excel would read as a formula ("=…", "+44…", "-50 from…", "@…") is kept as
 * text with an apostrophe in front; the bank-file import takes it off again.
 */
export const text = (s: string) => (/^[=+\-@\t\r]/.test(s) ? "'" + s : s);

export function exportBudgetCsv(b: Budget): { name: string; text: string }[] {
  const c = compute(b);
  const budgetRows: (string | number)[][] = [
    ['Month', 'Category Group', 'Category', 'Budgeted', 'Outflows', 'Category Balance'],
  ];
  const months = monthRange(c.first, c.last);
  for (const m of months) {
    for (const master of sortedMasters(b)) {
      for (const cat of categoriesOf(b, master.id, true)) {
        const d = categoryMonth(c, m, cat.id);
        budgetRows.push([monthLabel(m, true), text(master.name), text(cat.name), amount(d.budgeted), amount(d.activity), amount(d.balance)]);
      }
    }
  }

  const reg: (string | number)[][] = [
    ['Account', 'Flag', 'Check Number', 'Date', 'Payee', 'Category Group/Category', 'Category Group', 'Category', 'Memo', 'Outflow', 'Inflow', 'Cleared', 'Running Balance'],
  ];
  const cleared = { U: 'Uncleared', C: 'Cleared', R: 'Reconciled' } as const;
  for (const a of sortedAccounts(b)) {
    const txs = Object.values(b.transactions)
      .filter((t) => t.accountId === a.id)
      // Same-day rows keep the order they were entered (a stable sort), as the register shows them,
      // so the running balance matches the screen (1.5.3).
      .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    let running = 0;
    for (const t of txs) {
      running += t.amount;
      // A split line that's a transfer is named after its account, like a whole transfer.
      const lines =
        t.categoryId === SPLIT && t.splits?.length
          ? t.splits.map((s) => ({
              cat: s.categoryId,
              amt: s.amount,
              memo: s.memo || t.memo || '',
              payee: s.transferAccountId
                ? 'Transfer : ' + (b.accounts[s.transferAccountId]?.name ?? '')
                : payeeName(b, s.payeeId ? s : t),
            }))
          : [{ cat: t.categoryId, amt: t.amount, memo: t.memo || '', payee: payeeName(b, t) }];
      lines.forEach((l, i) => {
        const full = categoryLabel(b, l.cat, t.date);
        // Split at the first ": " only, so a category name containing ": " stays whole.
        const sep = full.indexOf(': ');
        const [group, cat] = sep >= 0 ? [full.slice(0, sep), full.slice(sep + 2)] : ['', full];
        reg.push([
          text(a.name),
          t.flag || '',
          text(t.check || ''),
          formatDate(t.date),
          text(l.payee),
          text(full),
          text(group),
          text(cat),
          lines.length > 1 ? `(Split ${i + 1}/${lines.length}) ${l.memo}` : text(l.memo),
          l.amt < 0 ? amount(-l.amt) : '0.00',
          l.amt > 0 ? amount(l.amt) : '0.00',
          cleared[t.cleared],
          i === lines.length - 1 ? amount(running) : '',
        ]);
      });
    }
  }
  const base = b.name.replace(/[\\/:*?"<>|]/g, '');
  return [
    { name: `${base} as of ${today()} - Budget.csv`, text: csv(budgetRows) },
    { name: `${base} as of ${today()} - Register.csv`, text: csv(reg) },
  ];
}
