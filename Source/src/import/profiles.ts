import { textKey, withoutOwnAmount } from '../model/merchant';
import type { BankProfileId } from '../model/types';
import type { BankTxn, ParsedBankFile } from './bank';

// Bank profiles: each bank's quirks in its downloads, tidied before importing (1.3).
//
// The parsers stay as they are; this works on what they read. The bank's text always goes into
// importedPayee unchanged, so every guess can be worked out again if these rules change.
// Measured on all the downloads: docs/plans/1.3-smarter-import.md §5.

export const PROFILE_LABELS: Record<BankProfileId, string> = {
  nationwide: 'Nationwide',
  santander: 'Santander',
  barclaycard: 'Barclaycard',
  'barclays-csv': 'Barclays Online Banking (CSV)',
  amex: 'American Express',
  halifax: 'Halifax card',
  'first-direct': 'First Direct',
  generic: 'Other bank',
};

const tidy = (s: string) => s.replace(/\t/g, ' ').replace(/\s+/g, ' ').trim();
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A bank row tidied for importing. The bank's own text stays in `payee` (BankTxn's). */
export interface CleanTxn extends BankTxn {
  /** For a new payee's name and the review's Payee column. */
  displayPayee: string;
  /** For "seen before" (textKey()). */
  textKey: string;
}

const FOREIGN_TAIL = /^(.*?)(\d[\d,]*\.\d{2} [A-Z][A-Z .'-]*(DOLLAR|EURO|POUND|YEN|KRONA|KRONE|PESO|REAL|FORINT|ZLOTY|KUNA|FRANC|RAND|BAHT|RUPEE|DIRHAM|LIRA|SHEKEL|WON|DONG|RINGGIT|LEU|LEV|KORUNA|DINAR|SHILLING)[A-Z .'-]*)$/;

/** Tidies one row for a profile. */
export function cleanTxn(t: BankTxn, profile: BankProfileId): CleanTxn {
  let payee = withoutOwnAmount(t.payee, t.amount);
  let memo = t.memo.replace(/\t/g, ' ');
  if (profile === 'barclaycard') {
    // QIF memo "1234/ <payee again>" or "Visa" / "n/a"; OFX memo is just the card's last 4 digits.
    const m = /^\s*\d{4}\/\s*(.*)$/.exec(memo);
    const rest = m ? m[1] : memo;
    const same = tidy(rest).toLowerCase() === tidy(payee).toLowerCase();
    memo = same || /^(visa|n\/a|\d{4})?$/i.test(tidy(rest)) ? '' : rest;
    // A foreign amount stuck onto the payee: "<Merchant>, <Town>7.50 EURO FRANCE".
    const f = FOREIGN_TAIL.exec(tidy(payee));
    if (f && f[1].trim()) {
      payee = f[1];
      if (!tidy(memo)) memo = f[2];
    }
  } else if (profile === 'barclays-csv') {
    // "<MERCHANT padded to about 22><Merchant, Town>", then a tab and any foreign amount, which
    // the bank cuts short ("12.3", "9.05 E"). The merchant ends where its first word starts
    // again as a whole word (the padding can be a single space; "SP Spiller …" and "THE
    // ADELPHI THEATRE …" don't start again). Otherwise at the padding: two or more spaces before
    // a word in mixed case, or three or more (two can be inside a name: "FERRY  TICKETS").
    const [main, ...after] = t.payee.split('\t');
    const first = main.trim().split(/\s+/)[0] || '';
    let at = first.length >= 2 ? (new RegExp('\\s' + escapeRegExp(first) + '(?![\\p{L}\\p{N}])', 'iu').exec(main)?.index ?? -1) : -1;
    if (at <= 0) {
      const beforeMixed = main.search(/\S\s{2,}(?=\S*[a-z])/);
      const gap = beforeMixed > 0 ? beforeMixed : main.search(/\S\s{3,}\S/);
      if (gap > 0) at = gap + 1;
    }
    payee = at > 0 ? main.slice(0, at) : main;
    const tail = tidy(after.join(' '));
    const cutShort = /^[\d.,]*( ?[A-Z])?$/.test(tail);
    if (tail && !cutShort && (!tidy(memo) || tidy(memo) === tidy(t.payee))) memo = tail;
    else if (tidy(memo) === tidy(t.payee)) memo = '';
  }
  return { ...t, memo: tidy(memo), displayPayee: tidy(payee) || tidy(t.payee), textKey: textKey(t.payee, t.amount) };
}

/** What a file shows about which bank it came from. */
export interface FileFacts {
  fileName: string;
  text: string;
  parsed: ParsedBankFile;
}

/** Each profile's score for a file, 0 to 1. */
function scores(f: FileFacts): Partial<Record<BankProfileId, number>> {
  const { fileName: name, parsed: p } = f;
  const head = f.text.slice(0, 4000);
  const rows = p.txns;
  const share = (test: (t: BankTxn) => boolean) => (rows.length ? rows.filter(test).length / rows.length : 0);
  const qifType = p.kind === 'qif' ? (/!type:([^\r\n]+)/i.exec(head)?.[1] || '').trim().toLowerCase() : '';
  const s: Partial<Record<BankProfileId, number>> = {};
  const set = (id: BankProfileId, v: number) => (s[id] = Math.max(s[id] ?? 0, v));

  if (p.kind === 'ofx' && /^ofx:0:\*{4}\d+$/.test(p.accountKey || '')) set('nationwide', 1);
  if (/^Statement Download /i.test(name)) set('nationwide', 0.7);

  if (qifType === 'oth l' && share((t) => withoutOwnAmount(t.payee, t.amount) !== t.payee) >= 0.6) set('santander', 1);
  if (/^Statements\d+/i.test(name)) set('santander', 0.7);

  if (qifType === 'ccard' && share((t) => /^\d{4}\/ /.test(t.memo)) >= 0.5) set('barclaycard', 1);
  if (p.kind === 'ofx' && /^ofx::\d{4}$/.test(p.accountKey || '') && /<CARD>/i.test(f.text)) set('barclaycard', 1);
  if (/^statement_\d{14}/i.test(name)) set('barclaycard', 0.6);

  if (p.kind === 'csv' && /^﻿?Date,Account\/Card No,Outflow,Subcategory,Memo/i.test(head)) set('barclays-csv', 1);

  if (p.kind === 'ofx' && /<ORG>\s*AMEX/i.test(head)) set('amex', 1);
  if (qifType === 'ccard' && (head.match(/^N\d{8}\s*$/gm) || []).length >= 0.8 * Math.min(rows.length, 20) && rows.length) set('amex', 0.9);
  if (/^activity/i.test(name)) set('amex', 0.6);

  if (/^\d{16}_\d{8}_\d{4}\.qif$/i.test(name)) set('halifax', 1);
  if (qifType === 'ccard' && rows.length >= 5 && share((t) => t.amount > 0) >= 0.8) set('halifax', 0.6);

  if (/^\d{8}_\d{4}\.(csv|qif)$/i.test(name)) set('first-direct', 0.8);
  if (p.kind === 'csv' && /^﻿?Date,Description,Amount,Balance\s*$/im.test(head.split(/\r?\n/)[0] || '')) set('first-direct', 0.6);
  return s;
}

/**
 * Which bank a file came from: the best score of at least 0.6, otherwise what the account
 * remembered, otherwise "generic".
 */
export function detectProfile(f: FileFacts, remembered?: BankProfileId): BankProfileId {
  let best: BankProfileId | null = null;
  let top = 0;
  for (const [id, v] of Object.entries(scores(f)) as [BankProfileId, number][]) {
    if (v > top) {
      top = v;
      best = id;
    }
  }
  return best && top >= 0.6 ? best : remembered || 'generic';
}
