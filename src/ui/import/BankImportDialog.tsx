import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CSV_DATE_FORMATS,
  csvHeader,
  csvMappingFits,
  decodeBankFileBytes,
  detectBankFileKind,
  guessCsvMapping,
  guessDelimiter,
  parseCsv,
  parseOfx,
  parseQif,
  reverseAmounts,
  splitCsv,
  type ParsedBankFile,
} from '../../import/bank';
import { applyImport, planImport, signWarning, similarKey, transferPairFor, transferPairs, unconfirmedGuess, type PlanRow } from '../../import/match';
import { detectProfile } from '../../import/profiles';
import { balanceCheck, lastImported, matchFileToAccount, recordImport, type AccountMatch } from '../../import/inbox';
import { serializeBudget } from '../../model/budget';
import { checkBudget } from '../../model/check';
import { addDays, daysBetween, formatDate, getDateFormat, today as localToday } from '../../model/dates';
import { formatMoney } from '../../model/money';
import { categoryLabel, payeeName, transferNeedsCategory } from '../../model/queries';
import { SPLIT, type BankProfileId, type CsvMapping, type Id } from '../../model/types';
import type { BankFile } from '../../shared/api';
import { store, update, useBudget } from '../../state/store';
import { ui } from '../../state/ui';
import { toast } from '../common/dialogs';
import { Autocomplete } from '../common/inputs';
import { cx } from '../common/Money';
import { isTopModal, Modal } from '../common/overlay';
import { accountOptions, categoryOptions } from '../common/options';

// Importing QIF / OFX / QFX / CSV files from the bank, with a review step that shows
// what is new, what matches a transaction typed in by hand, and what was already imported.

type Step = 'choosing' | 'inbox' | 'loading' | 'csv' | 'review' | 'summary';

/** A file in the inbox, read and matched to an account. */
interface Entry {
  key: number;
  file: BankFile;
  text: string;
  kind: 'qif' | 'ofx' | 'csv' | null;
  /** As read (CSV files with the best-guess or a remembered layout); null if it couldn't be read. */
  parsed: ParsedBankFile | null;
  status: 'ready' | 'csv' | 'notbank' | 'unreadable' | 'empty';
  match: AccountMatch;
  accountId: Id | '';
  include: boolean;
  newRows?: number;
}

/** One imported file, for the summary at the end. */
interface Done {
  fileName: string;
  accountId: Id;
  added: number;
  matched: number;
  balance: ReturnType<typeof balanceCheck>;
  kind: string;
  profile: BankProfileId;
}

export const BANK_EXT = /\.(qif|ofx|qfx|qbo|csv|txt)$/i;

/** While the dialog is open, files dropped on the window are added to it. */
let addToOpenDialog: ((files: BankFile[]) => void) | null = null;

/** Files dropped on the window: added to the open import, or a new one with them. */
export function importDroppedFiles(files: BankFile[], open: (files: BankFile[]) => void): void {
  if (addToOpenDialog) addToOpenDialog(files);
  else open(files);
}

/**
 * Reads a bank file's text as the inbox does: a CSV with a layout remembered by an account that
 * fits it, otherwise the best guess (for matching). Throws if it can't be read.
 */
export function parseInboxFile(b: ReturnType<typeof useBudget>, kind: Entry['kind'], text: string): ParsedBankFile {
  if (kind === 'csv') {
    const saved = Object.values(b.accounts).find((a) => a.csvMapping && csvMappingFits(text, a.csvMapping))?.csvMapping;
    const d = guessDelimiter(text);
    return parseCsv(text, saved ?? guessCsvMapping(splitCsv(text, d), d));
  }
  const df = getDateFormat();
  return kind === 'qif' ? parseQif(text, df === 'MM/DD/YYYY' ? 'MDY' : df === 'YYYY-MM-DD' ? 'YMD' : 'DMY') : parseOfx(text);
}

function readEntry(b: ReturnType<typeof useBudget>, key: number, file: BankFile, fromRegister: Id | undefined): Entry {
  const text = decodeBankFileBytes(file.bytes);
  const base = { key, file, text, include: false, accountId: '' as Id | '', match: { level: 'none', how: 'none', reason: 'choose an account' } as AccountMatch };
  if (!BANK_EXT.test(file.name)) return { ...base, kind: null, parsed: null, status: 'notbank' };
  const kind = detectBankFileKind(file.name, text);
  let parsed: ParsedBankFile | null = null;
  try {
    parsed = parseInboxFile(b, kind, text);
  } catch {
    return { ...base, kind, parsed: null, status: 'unreadable' };
  }
  if (!parsed.txns.length) return { ...base, kind, parsed, status: kind === 'csv' ? 'csv' : 'empty' };
  const match = matchFileToAccount(b, { fileName: file.name, text, parsed }, fromRegister);
  const accountId = match.accountId ?? '';
  const status = kind === 'csv' && !(accountId && b.accounts[accountId]?.csvMapping && csvMappingFits(text, b.accounts[accountId].csvMapping!)) ? 'csv' : 'ready';
  const newRows = accountId
    ? planImport(b, accountId, parsed.txns).filter((r) => r.kind === 'new' || r.kind === 'possible').length
    : undefined;
  return { ...base, kind, parsed, status, match, accountId, include: !!accountId, newRows };
}

export function BankImportDialog({
  accountId: initialAccount,
  initialFiles,
  onClose,
}: {
  accountId?: string;
  /** Files dropped on the window: no file picker. */
  initialFiles?: BankFile[];
  onClose: () => void;
}) {
  const b = useBudget();
  const [entries, setEntries] = useState<Entry[]>([]);
  /** The ticked files being reviewed, in order. */
  const [queue, setQueue] = useState<Entry[]>([]);
  const [index, setIndex] = useState(0);
  const [step, setStep] = useState<Step>('choosing');
  const [text, setText] = useState('');
  const [accountId, setAccountId] = useState<Id | ''>(initialAccount || '');
  /** The file as read; `parsed` is what is shown, with the amounts reversed if asked. */
  const [raw, setRaw] = useState<ParsedBankFile | null>(null);
  const [parsed, setParsed] = useState<ParsedBankFile | null>(null);
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  /** QIF/OFX: the amounts are the wrong way round for this account. (CSV uses mapping.invert.) */
  const [reverse, setReverse] = useState(false);
  const [reverseTouched, setReverseTouched] = useState(false);
  /** A remembered CSV layout didn't fit this file, so the column screen is shown again. */
  const [layoutChanged, setLayoutChanged] = useState(false);
  const [plan, setPlan] = useState<PlanRow[]>([]);
  /** Which bank's quirks the file has (profiles.ts), detected when it's read. */
  const [profile, setProfile] = useState<BankProfileId>('generic');
  const [remember, setRemember] = useState(true);
  const [approve, setApprove] = useState(!!b.settings.autoApproveImports);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Done[]>([]);
  // Files passed over with "Skip this file", for the summary.
  const [skipped, setSkipped] = useState<string[]>([]);
  const backedUp = useRef(false);
  const nextKey = useRef(0);
  const budgetId = useRef(store.budget?.id);

  const matchDays = b.settings.matchDays ?? 10;
  const entry = step === 'choosing' || step === 'inbox' || step === 'summary' ? undefined : queue[index];
  const file = entry?.file;

  /** Reads files into the inbox, oldest first, so overlapping downloads de-duplicate in order. */
  const addFiles = (files: BankFile[]) => {
    const budget = store.budget!;
    setEntries((list) => {
      const known = new Set(list.map((e) => e.file.name + ':' + e.file.bytes.length));
      const fresh = files
        .filter((f) => !known.has(f.name + ':' + f.bytes.length))
        // Several files: the register they were opened from says nothing about which is which.
        .map((f) => readEntry(budget, nextKey.current++, f, undefined));
      return [...list, ...fresh].sort((x, y) => (x.file.modifiedMs ?? 0) - (y.file.modifiedMs ?? 0) || x.file.name.localeCompare(y.file.name));
    });
  };

  const start = (files: BankFile[]) => {
    if (!files.length) return onClose();
    const budget = store.budget!;
    // One file goes straight to its review, as before; several are listed first.
    if (files.length === 1) {
      const e = readEntry(budget, nextKey.current++, files[0], initialAccount);
      setEntries([e]);
      if (e.status !== 'notbank' && e.status !== 'unreadable') {
        // The register's account, unless the file names an account or card that isn't it. Taken
        // from the register, it isn't learned from (an empty file was never matched), 1.5.3.
        const fromRegister = !e.accountId && !e.match.foreign && !!initialAccount;
        setQueue([{ ...e, accountId: e.accountId || (fromRegister ? initialAccount! : ''), match: fromRegister ? { ...e.match, how: 'register' } : e.match }]);
        setIndex(0);
        setStep('loading');
        return;
      }
    } else addFiles(files);
    setStep('inbox');
  };

  useEffect(() => {
    if (initialFiles?.length) start(initialFiles);
    else void window.api.openBankFiles().then(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Files dropped on the window while this is open are added to the list.
  useEffect(() => {
    addToOpenDialog = (files) => {
      if (step === 'inbox' || step === 'choosing') addFiles(files);
      else toast('Finish this import first, then drop the other files.', 'info');
    };
    return () => {
      addToOpenDialog = null;
    };
  });

  useEffect(() => {
    if (!entry || !file) return;
    setError('');
    const t = entry.text;
    setText(t);
    setReverseTouched(false);
    setLayoutChanged(false);
    // Learn from this file unless the account only came from the register it was opened from.
    setRemember(entry.match.how !== 'register');
    const acc = entry.accountId;
    setAccountId(acc);
    if (entry.kind === 'csv') {
      const saved = acc ? store.budget!.accounts[acc]?.csvMapping : undefined;
      if (saved && csvMappingFits(t, saved)) {
        const p = parseCsv(t, saved);
        if (p.txns.length) {
          setMapping(saved);
          goReview(p, acc, t);
          return;
        }
      }
      // The bank changed its layout since the columns were remembered: ask again.
      setLayoutChanged(!!saved);
      const delimiter = guessDelimiter(t);
      setMapping(guessCsvMapping(splitCsv(t, delimiter), delimiter));
      setStep('csv');
      return;
    }
    if (!entry.parsed) {
      setError('Could not read this file.');
      setStep('review');
      return;
    }
    goReview(entry.parsed, acc, t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry]);

  /** Shows `p` (reversed if asked) and plans it against the account. */
  const show = (p: ParsedBankFile, acc: Id | '', rev: boolean, prof = profile) => {
    const shown = rev && p.kind !== 'csv' ? reverseAmounts(p) : p;
    setParsed(shown);
    setPlan(acc ? planImport(store.budget!, acc, shown.txns, matchDays, prof) : []);
  };

  /** QIF and OFX files are reversed if the account says so (CSV files have their own setting). */
  const accountReverses = (p: ParsedBankFile, acc: Id | '') =>
    p.kind !== 'csv' && !!(acc && store.budget!.accounts[acc]?.importReverse?.[p.kind]);

  /** `fileText`: the file's text, passed in while it's still being read into state. */
  const goReview = (p: ParsedBankFile, acc: Id | '', fileText = text) => {
    const prof = detectProfile({ fileName: file!.name, text: fileText, parsed: p }, acc ? store.budget!.accounts[acc]?.bankProfile : undefined);
    setProfile(prof);
    setRaw(p);
    const rev = accountReverses(p, acc);
    setReverse(rev);
    show(p, acc, rev, prof);
    setStep('review');
  };

  const changeAccount = (id: Id) => {
    setAccountId(id);
    if (!raw) return;
    const rev = reverseTouched ? reverse : accountReverses(raw, id);
    setReverse(rev);
    show(raw, id, rev);
  };

  const toggleReverse = (v: boolean) => {
    setReverseTouched(true);
    if (raw?.kind === 'csv' && mapping) {
      // For CSV files this is the column screen's "Swap signs".
      const m = { ...mapping, invert: v };
      const p = parseCsv(text, m);
      setMapping(m);
      setRaw(p);
      show(p, accountId, false);
    } else if (raw) {
      setReverse(v);
      show(raw, accountId, v);
    }
  };

  const nextFile = (results: Done[]) => {
    if (index + 1 < queue.length) {
      setIndex(index + 1);
      setStep('loading');
    } else if (queue.length > 1 || results.length > 1) {
      setStep('summary');
    } else {
      onClose();
      if (results[0]) ui.go({ view: 'account', id: results[0].accountId });
    }
  };

  const finish = () => {
    if (!accountId || !file || !raw) return setError('Choose which account these transactions belong to.');
    // The review belongs to the budget it was made in.
    if (!store.budget || store.budget.id !== budgetId.current || !store.budget.accounts[accountId])
      return setError('A different budget is open now. Cancel this import and start it again.');
    // A backup first (once a session), so a mistaken import can still be undone after the app is closed.
    if (!backedUp.current) {
      backedUp.current = true;
      const before = store.budget!;
      // A failure is said (1.5.11), and the next file tries again.
      void window.api.createBackup(before.id, before.name, 'before-import', serializeBudget(before)).catch((e) => {
        backedUp.current = false;
        toast(`The backup before importing couldn't be made (${e instanceof Error ? e.message : String(e)}). Undo still works while the app is open.`, 'error');
      });
    }
    let res = { added: 0, matched: 0 };
    let balance: Done['balance'] = null;
    const lastDate = raw.txns.reduce((m, t) => (t.date > m ? t.date : m), '');
    update(`Import ${file.name}`, (d) => {
      res = applyImport(d, accountId, plan, approve);
      const acc = d.accounts[accountId];
      recordImport(d, accountId, { fileName: file.name, text, parsed: raw }, undefined, remember);
      // The columns belong to the account, so they're always remembered (the box is about the file's account).
      if (mapping && raw.kind === 'csv') acc.csvMapping = { ...mapping, header: csvHeader(text, mapping) };
      // Remember "the wrong way round" for this account's QIF/OFX files, if it was changed.
      if (reverseTouched && raw.kind !== 'csv') {
        const r = { ...acc.importReverse, [raw.kind]: reverse || undefined };
        if (!r.qif) delete r.qif;
        if (!r.ofx) delete r.ofx;
        if (Object.keys(r).length) acc.importReverse = r;
        else delete acc.importReverse;
      }
      if (approve !== !!d.settings.autoApproveImports) d.settings.autoApproveImports = approve;
      if (profile !== 'generic' && acc.bankProfile !== profile) acc.bankProfile = profile;
      // The bank's balance against the register's, at the file's last row (OFX files only).
      balance = balanceCheck(d, accountId, { balance: parsed?.balance, lastDate });
      if (balance) acc.lastBankBalance = { date: balance.date, amount: balance.bank, difference: balance.difference };
    });
    // A quiet check that the import left everything consistent; says something only if not.
    const problems = checkBudget(store.budget!);
    if (problems.length) {
      toast(`Check budget found ${problems.reduce((n, p) => n + p.count, 0)} record(s) that don't fit together: see Budget › Check budget.`, 'error');
    }
    const results = [...done, { fileName: file.name, accountId, added: res.added, matched: res.matched, balance, kind: raw.kind, profile }];
    setDone(results);
    if (queue.length === 1) {
      const dups = plan.filter((r) => r.kind === 'duplicate').length;
      const gone = plan.filter((r) => r.kind === 'deleted' && !r.include).length;
      const possibles = plan.filter((r) => r.kind === 'possible' && !r.include).length;
      toast(
        `Imported ${res.added} new, matched ${res.matched}${dups ? `, skipped ${dups} already imported` : ''}${gone ? `, left out ${gone} previously deleted` : ''}${possibles ? `, left out ${possibles} possible duplicate${possibles === 1 ? '' : 's'}` : ''}.`,
        'ok',
      );
      // (Set inside the edit above, which TypeScript can't see.)
      const check = balance as Done['balance'];
      if (check) toast(balanceText(check, profile), check.difference ? 'info' : 'ok');
    }
    nextFile(results);
  };

  useEffect(() => {
    if (step !== 'review') return;
    const onKey = (e: KeyboardEvent) => {
      // Not while another dialog (F1's list, say) is open on top of the review.
      if (!isTopModal(document.querySelector('.modal.import-file'))) return;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.repeat && accountId && parsed) {
        e.preventDefault();
        finish();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (step === 'choosing') return null;
  if (step === 'inbox')
    return (
      <Inbox
        entries={entries}
        setEntries={setEntries}
        onChoose={() => void window.api.openBankFiles().then(addFiles)}
        onCancel={onClose}
        onReview={(list) => {
          setQueue(list);
          setIndex(0);
          setStep('loading');
        }}
      />
    );
  if (step === 'summary')
    return <Summary done={done} skipped={skipped} onClose={() => (onClose(), done[0] && ui.go({ view: 'account', id: done[done.length - 1].accountId }))} />;
  if (!file) return null;
  const counts = {
    new: plan.filter((r) => (r.kind === 'new' || r.kind === 'deleted' || r.kind === 'possible') && r.include).length,
    match: plan.filter((r) => r.kind === 'match' && r.include).length,
    dup: plan.filter((r) => r.kind === 'duplicate').length,
    deleted: plan.filter((r) => r.kind === 'deleted').length,
    possible: plan.filter((r) => r.kind === 'possible').length,
  };
  const leftOut = plan.filter((r) => r.kind === 'possible' && !r.include).length;
  const title = `Import from your bank: ${file.name}${queue.length > 1 ? ` (${index + 1} of ${queue.length})` : ''}`;

  return (
    <Modal
      title={title}
      onClose={onClose}
      width={step === 'review' ? 1080 : 820}
      className="import-file"
      footer={
        step === 'csv' ? (
          // Keys on the buttons: the review's footer mustn't reuse Next (with the focus on it) as
          // "Skip this file", or Space or Enter just after Next would skip the file.
          <>
            <button key="cancel" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              key="next"
              className="btn primary"
              onClick={() => {
                const p = parseCsv(text, mapping!);
                if (!p.txns.length) return setError('No transactions could be read with these settings. Check the date and amount columns.');
                goReview(p, accountId);
              }}
            >
              Next
            </button>
          </>
        ) : step === 'review' ? (
          <>
            <label key="approve" className="check small" style={{ marginRight: 'auto' }}>
              <input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} />
              Approve automatically (suggested categories still wait for you)
            </label>
            {queue.length > 1 && (
              <button
                key="skip"
                className="btn"
                onClick={(e) => {
                  // A double-click mustn't skip the next file too (1.5.11).
                  if (e.detail > 1) return;
                  setSkipped((s) => [...s, file!.name]);
                  nextFile(done);
                }}
              >
                Skip this file
              </button>
            )}
            <button key="cancel" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              key="import"
              className="btn primary"
              disabled={!accountId || !parsed}
              // The second click of a double-click would land on the next file's Import as it opens,
              // importing a file nobody has looked at (1.5.3).
              onClick={(e) => e.detail < 2 && finish()}
            >
              Import {counts.new} new{counts.match ? `, match ${counts.match}` : ''}
              {leftOut ? ` · ${leftOut} possible duplicate${leftOut === 1 ? '' : 's'} left out` : ''}
            </button>
          </>
        ) : undefined
      }
    >
      {error && <div className="err-box" style={{ marginBottom: 10 }}>{error}</div>}
      {step === 'loading' && <div className="hint">Reading the file…</div>}
      {step === 'csv' && layoutChanged && (
        <div className="warn-box" style={{ marginBottom: 10 }}>
          This file's columns are different from last time (the bank may have changed its download), so please check
          them again.
        </div>
      )}
      {step === 'csv' && mapping && <CsvMapper text={text} mapping={mapping} onChange={setMapping} />}
      {step === 'review' && parsed && (
        <Review
          parsed={parsed}
          plan={plan}
          setPlan={setPlan}
          accountId={accountId}
          onAccount={changeAccount}
          counts={counts}
          remember={remember}
          setRemember={setRemember}
          isCsv={parsed.kind === 'csv'}
          reversed={parsed.kind === 'csv' ? !!mapping?.invert : reverse}
          onReverse={toggleReverse}
          warning={accountId && counts.dup < plan.length ? signWarning(b, accountId, parsed.txns) : null}
        />
      )}
    </Modal>
  );
}

/** "Bank balance on 12 Oct agrees" / "differs by £4.20". */
function balanceText(c: NonNullable<Done['balance']>, profile: BankProfileId): string {
  if (!c.difference) return `The bank's balance on ${formatDate(c.date)} agrees with this account (${formatMoney(c.bank)}).`;
  const card = profile === 'barclaycard' || profile === 'amex' || profile === 'halifax';
  return (
    `The bank's balance on ${formatDate(c.date)} was ${formatMoney(c.bank)}; this account shows ${formatMoney(c.register)} (a difference of ${formatMoney(Math.abs(c.difference))}).` +
    (card ? ' Card statements are cut by posting date, so a small difference can be normal.' : '')
  );
}

const LEVEL_MARK: Record<AccountMatch['level'], string> = { automatic: '●', suggested: '▲', none: '' };

function Inbox(p: {
  entries: Entry[];
  setEntries: (f: (list: Entry[]) => Entry[]) => void;
  onChoose: () => void;
  onCancel: () => void;
  onReview: (list: Entry[]) => void;
}) {
  const b = useBudget();
  const accOpts = useMemo(() => accountOptions(b), [b]);
  const [allAccounts, setAllAccounts] = useState(false);
  const setEntry = (key: number, patch: Partial<Entry>) => p.setEntries((list) => list.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  const ready = p.entries.filter((e) => e.include && e.accountId && e.status !== 'notbank' && e.status !== 'unreadable' && e.status !== 'empty');
  const today = localToday();
  const accounts = Object.values(b.accounts)
    .filter((a) => !a.closed)
    .map((a) => ({ a, to: lastImported(b, a.id) }))
    .filter((x) => allAccounts || x.to)
    .sort((x, y) => (x.to ?? '') .localeCompare(y.to ?? ''));
  return (
    <Modal
      title="Import from your bank"
      onClose={p.onCancel}
      width={1000}
      footer={
        <>
          <button className="btn" onClick={p.onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ready.length} onClick={() => p.onReview(ready)}>
            Review {ready.length} file{ready.length === 1 ? '' : 's'} →
          </button>
        </>
      }
    >
      <div className="drop-hint">
        Drop this month's bank files anywhere on this window, or{' '}
        <button className="btn small" onClick={p.onChoose}>
          Choose files…
        </button>
      </div>
      <table className="simple-table small inbox-table">
        <thead>
          <tr>
            <th style={{ width: 28 }} />
            <th>File (oldest first)</th>
            <th style={{ width: 340 }}>Account</th>
            <th className="r">Rows</th>
            <th className="r">New</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {p.entries.map((e) => {
            const usable = e.status !== 'notbank' && e.status !== 'unreadable' && e.status !== 'empty';
            return (
              <tr key={e.key} style={{ opacity: e.include ? 1 : 0.6 }}>
                <td>
                  <input
                    type="checkbox"
                    disabled={!usable}
                    checked={e.include}
                    onChange={(ev) => setEntry(e.key, { include: ev.target.checked })}
                    aria-label={'Import ' + e.file.name}
                  />
                </td>
                <td className="nowrap" title={e.file.name}>
                  {e.file.name}
                </td>
                <td>
                  {usable && (
                    <>
                      <Autocomplete
                        value={e.accountId ? b.accounts[e.accountId]?.name || '' : ''}
                        options={accOpts}
                        placeholder="Choose an account"
                        onChange={(_t, o) => {
                          if (!o) return;
                          const plan = e.parsed ? planImport(b, o.value, e.parsed.txns) : [];
                          setEntry(e.key, {
                            accountId: o.value,
                            include: true,
                            match: { ...e.match, accountId: o.value, level: 'suggested', how: 'none', reason: 'chosen by you', foreign: undefined },
                            newRows: plan.filter((r) => r.kind === 'new' || r.kind === 'possible').length,
                          });
                        }}
                        ariaLabel={'Account for ' + e.file.name}
                      />
                      <div className={cx('hint reason', e.match.level)}>
                        {e.match.foreign ? (
                          <>— not linked to an account here: the other budget's? ({e.match.foreign})</>
                        ) : (
                          <>
                            {LEVEL_MARK[e.match.level]} {e.match.reason}
                            {e.match.level === 'suggested' && e.match.how !== 'none' ? ' · check it' : ''}
                          </>
                        )}
                      </div>
                    </>
                  )}
                </td>
                <td className="r">{e.parsed?.txns.length ?? ''}</td>
                <td className="r">{e.newRows ?? ''}</td>
                <td className="nowrap">
                  {e.status === 'notbank'
                    ? 'Not a bank file'
                    : e.status === 'unreadable'
                      ? "Couldn't be read"
                      : e.status === 'empty'
                        ? 'No transactions'
                        : e.status === 'csv'
                          ? 'Needs column settings'
                          : e.accountId
                            ? 'Ready'
                            : 'Choose an account'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <details className="last-imports" open>
        <summary>Accounts by last import</summary>
        {accounts.length === 0 && <p className="hint">No account has been imported into yet.</p>}
        <table className="simple-table small">
          <tbody>
            {accounts.map(({ a, to }) => {
              const days = to ? daysBetween(to, today) : null;
              return (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{to ? `up to ${formatDate(to)} (${days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`})` : 'never imported'}</td>
                  <td className="muted">{to ? `download from ${formatDate(addDays(to, -3))}` : ''}</td>
                  <td>{days !== null && days > 35 ? <span className="badge warn">over a month</span> : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <label className="check small">
          <input type="checkbox" checked={allAccounts} onChange={(e) => setAllAccounts(e.target.checked)} /> Show all accounts
        </label>
      </details>
    </Modal>
  );
}

function Summary({ done, skipped, onClose }: { done: Done[]; skipped: string[]; onClose: () => void }) {
  const b = useBudget();
  const accountIds = [...new Set(done.map((d) => d.accountId))];
  const waiting = Object.values(b.transactions).filter((t) => !t.accepted && accountIds.includes(t.accountId)).length;
  return (
    <Modal
      title="Import finished"
      onClose={onClose}
      width={760}
      footer={
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <table className="simple-table small">
        <tbody>
          {done.map((d, i) => (
            <tr key={i}>
              <td>{b.accounts[d.accountId]?.name}</td>
              <td className="muted" title={d.fileName}>
                {d.fileName}
              </td>
              <td className="nowrap">
                {d.added} added{d.matched ? `, ${d.matched} matched` : ''}
              </td>
              <td>
                {d.balance
                  ? d.balance.difference
                    ? `Bank balance on ${formatDate(d.balance.date)} differs by ${formatMoney(Math.abs(d.balance.difference))}`
                    : `Bank balance on ${formatDate(d.balance.date)} ✓ agrees`
                  : d.kind === 'ofx'
                    ? 'No balance in this file'
                    : '(QIF and CSV files carry no balance)'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {skipped.length > 0 && (
        <div className="warn-box" style={{ marginTop: 10 }}>
          Skipped, nothing imported from {skipped.length === 1 ? 'it' : 'them'}: {skipped.join(', ')}
        </div>
      )}
      <p style={{ marginBottom: 0 }}>
        {waiting} transaction{waiting === 1 ? ' is' : 's are'} waiting for approval in {accountIds.length === 1 ? 'this account' : 'these accounts'}.
      </p>
    </Modal>
  );
}

function CsvMapper({ text, mapping, onChange }: { text: string; mapping: CsvMapping; onChange: (m: CsvMapping) => void }) {
  const rows = useMemo(() => splitCsv(text, mapping.delimiter), [text, mapping.delimiter]);
  const preview = useMemo(() => {
    try {
      return parseCsv(text, mapping);
    } catch {
      return null;
    }
  }, [text, mapping]);
  const width = Math.max(0, ...rows.slice(0, 30).map((r) => r.length));
  const set = (patch: Partial<CsvMapping>) => onChange({ ...mapping, ...patch });
  const colSelect = (label: string, value: number, key: keyof CsvMapping, allowNone = true) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <select value={value} onChange={(e) => set({ [key]: +e.target.value } as Partial<CsvMapping>)}>
        {allowNone && <option value={-1}>(none)</option>}
        {Array.from({ length: width }, (_, i) => (
          <option key={i} value={i}>
            Column {i + 1}
            {mapping.hasHeader && rows[mapping.skipRows]?.[i] ? `: ${rows[mapping.skipRows][i]}` : ''}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        Tell My Budget which columns hold what. It has made a guess; check the preview at the bottom.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0 12px' }}>
        <label className="field">
          <span className="field-label">Separator</span>
          <select value={mapping.delimiter} onChange={(e) => set({ delimiter: e.target.value })}>
            <option value=",">Comma</option>
            <option value=";">Semicolon</option>
            <option value={'\t'}>Tab</option>
            <option value="|">Bar |</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Lines to skip at the top</span>
          <input type="number" min={0} value={mapping.skipRows} onChange={(e) => set({ skipRows: Math.max(0, +e.target.value) })} />
        </label>
        <label className="field" style={{ justifyContent: 'flex-end' }}>
          <label className="check">
            <input type="checkbox" checked={mapping.hasHeader} onChange={(e) => set({ hasHeader: e.target.checked })} />
            First line is headings
          </label>
        </label>
        <label className="field">
          <span className="field-label">Date format</span>
          <select value={mapping.dateFormat} onChange={(e) => set({ dateFormat: e.target.value })}>
            {CSV_DATE_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f === 'auto' ? 'Work it out' : f}
              </option>
            ))}
          </select>
        </label>
        {colSelect('Date column', mapping.dateCol, 'dateCol', false)}
        {colSelect('Payee column', mapping.payeeCol, 'payeeCol')}
        {colSelect('Memo column', mapping.memoCol, 'memoCol')}
        {colSelect('Bank reference column', mapping.refCol, 'refCol')}
        <label className="field">
          <span className="field-label">Amounts</span>
          <select value={mapping.amountMode} onChange={(e) => set({ amountMode: e.target.value as CsvMapping['amountMode'] })}>
            <option value="single">One amount column</option>
            <option value="split">Separate in and out columns</option>
          </select>
        </label>
        {mapping.amountMode === 'single' ? (
          colSelect('Amount column', mapping.amountCol, 'amountCol', false)
        ) : (
          <>
            {colSelect('Money in column', mapping.inflowCol, 'inflowCol')}
            {colSelect('Money out column', mapping.outflowCol, 'outflowCol')}
          </>
        )}
        <label className="field" style={{ justifyContent: 'flex-end' }}>
          <label className="check">
            <input type="checkbox" checked={mapping.invert} onChange={(e) => set({ invert: e.target.checked })} />
            Swap signs (spending is positive)
          </label>
        </label>
      </div>
      <div style={{ overflow: 'auto', maxHeight: 180, border: '1px solid var(--line)', borderRadius: 4 }}>
        <table className="simple-table small">
          <tbody>
            {rows.slice(0, 12).map((r, i) => (
              <tr key={i} style={{ opacity: i < mapping.skipRows ? 0.4 : 1, fontWeight: mapping.hasHeader && i === mapping.skipRows ? 600 : 400 }}>
                {Array.from({ length: width }, (_, j) => (
                  <td key={j} className="nowrap">
                    {r[j]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="insp-sec-title" style={{ marginTop: 10 }}>
        Preview: {preview?.txns.length ?? 0} transactions read{preview?.warnings.length ? `, ${preview.warnings.length} rows skipped` : ''}
      </div>
      <table className="simple-table small">
        <tbody>
          {(preview?.txns || []).slice(0, 5).map((t, i) => (
            <tr key={i}>
              <td>{formatDate(t.date)}</td>
              <td>{t.payee}</td>
              <td className="muted">{t.memo}</td>
              <td className="r">
                <span className={cx('money', t.amount < 0 && 'neg')}>{formatMoney(t.amount)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Filter = 'all' | 'suggested' | 'none';

/** Rows that are (or could be) added as new transactions. */
const isNewish = (r: PlanRow) => r.kind === 'new' || r.kind === 'deleted' || r.kind === 'possible';

function Review(p: {
  parsed: ParsedBankFile;
  plan: PlanRow[];
  setPlan: (f: (rows: PlanRow[]) => PlanRow[]) => void;
  accountId: Id | '';
  onAccount: (id: Id) => void;
  counts: { new: number; match: number; dup: number; deleted: number; possible: number };
  remember: boolean;
  setRemember: (v: boolean) => void;
  isCsv: boolean;
  reversed: boolean;
  onReverse: (v: boolean) => void;
  /** Why the amounts may be the wrong way round, if they look it. */
  warning: string | null;
}) {
  const b = useBudget();
  const accOpts = useMemo(() => accountOptions(b), [b]);
  const [showDups, setShowDups] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  /** "Also set the n other rows like this" after a category is changed by hand. */
  const [similar, setSimilar] = useState<{ keys: number[]; categoryId: Id | null; key: string } | null>(null);
  const catOpts = useMemo(() => categoryOptions(b, { uncategorized: true }), [b]);
  // The other account's imported row each transfer row will take over, shown on the row (1.5.11).
  const pairs = useMemo(() => transferPairs(b, p.plan), [b, p.plan]);
  const needsCategory = (r: PlanRow) =>
    !!p.accountId && !!b.accounts[p.accountId]?.onBudget && (!r.transferAccountId || transferNeedsCategory(b, p.accountId, r.transferAccountId));
  const suggested = (r: PlanRow) => isNewish(r) && r.include && unconfirmedGuess(r);
  const uncategorised = (r: PlanRow) => isNewish(r) && r.include && needsCategory(r) && !r.categoryId;
  const nSuggested = p.plan.filter(suggested).length;
  const nUncategorised = p.plan.filter(uncategorised).length;
  const rows = p.plan.filter(
    (r) => (showDups || r.kind !== 'duplicate') && (filter === 'all' || (filter === 'suggested' ? suggested(r) : uncategorised(r))),
  );
  const setRow = (key: number, patch: Partial<PlanRow>) => p.setPlan((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const changeCategory = (r: PlanRow, categoryId: Id | null) => {
    setRow(r.key, { categoryId, userSet: true, categoryHint: undefined });
    const key = similarKey(r);
    const others = key
      ? p.plan.filter(
          (x) => x.key !== r.key && x.kind === 'new' && x.include && !x.userSet && !x.transferAccountId && similarKey(x) === key && x.categoryId !== categoryId,
        )
      : [];
    setSimilar(others.length ? { keys: others.map((x) => x.key), categoryId, key } : null);
  };
  const applySimilar = () => {
    if (!similar) return;
    const keys = new Set(similar.keys);
    p.setPlan((list) => list.map((r) => (keys.has(r.key) ? { ...r, categoryId: similar.categoryId, userSet: true, categoryHint: undefined } : r)));
    setSimilar(null);
  };
  const choose = (r: PlanRow, choice: 'match' | 'new' | 'skip') => {
    if (choice === 'skip') setRow(r.key, { include: false });
    else if (choice === 'match') setRow(r.key, { kind: 'match', matchId: r.matchedTo ?? r.matchId, matchedTo: undefined, include: true });
    else setRow(r.key, { ...r.asNew, kind: 'new', include: true, matchedTo: r.matchId ?? r.matchedTo, matchId: undefined });
  };
  const similarLabel = similar
    ? `Also set the ${similar.keys.length} other ${similar.key === 'fx' ? 'foreign-currency rows' : `row${similar.keys.length === 1 ? '' : 's'} like "${similar.key}"`} to ${
        similar.categoryId ? categoryLabel(b, similar.categoryId) : 'no category'
      }?`
    : '';

  return (
    <div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', marginBottom: 8 }}>
        <label className="field" style={{ width: 300, margin: 0 }}>
          <span className="field-label">Import into account{p.parsed.accountLabel ? ` (bank account ${p.parsed.accountLabel})` : ''}</span>
          <Autocomplete
            value={p.accountId ? b.accounts[p.accountId]?.name || '' : ''}
            options={accOpts}
            placeholder="Choose an account"
            onChange={(_t, o) => o && p.onAccount(o.value)}
            ariaLabel="Account"
          />
        </label>
        <span className="badge" style={{ background: 'var(--green)' }}>{p.counts.new} new</span>
        <span className="badge">{p.counts.match} matched</span>
        {p.counts.possible > 0 && (
          <span className="badge warn" title="Like a transaction imported from another file. Left out unless you tick it.">
            {p.counts.possible} possible duplicate{p.counts.possible === 1 ? '' : 's'}
          </span>
        )}
        <span className="badge" style={{ background: 'var(--faint)' }}>{p.counts.dup} already imported</span>
        {p.counts.deleted > 0 && (
          <span className="badge" style={{ background: 'var(--faint)' }} title="Rows you deleted before. Tick one to import it again.">
            {p.counts.deleted} previously deleted
          </span>
        )}
        <span className="grow" />
        <label className="check small" title="Learns this file's bank account, card digits and name, so files like it go to this account">
          <input type="checkbox" checked={p.remember} onChange={(e) => p.setRemember(e.target.checked)} />
          Remember this account for files like this
        </label>
      </div>
      <div className="toolbar review-filters" style={{ marginBottom: 8 }}>
        <span className="muted">Show</span>
        {(
          [
            ['all', 'All'],
            ['suggested', `Suggested (${nSuggested})`],
            ['none', `No category (${nUncategorised})`],
          ] as const
        ).map(([f, label]) => (
          <label key={f} className="check small">
            <input type="radio" name="review-filter" checked={filter === f} onChange={() => setFilter(f)} />
            {label}
          </label>
        ))}
        <span className="hint" title="Click a row (or Tab to it) first">
          ↑↓ rows · Space ticks · Enter accepts a suggestion · Ctrl+Enter imports
        </span>
        <span className="grow" />
        {p.counts.dup > 0 && (
          <label className="check small">
            <input type="checkbox" checked={showDups} onChange={(e) => setShowDups(e.target.checked)} />
            Show already imported
          </label>
        )}
      </div>
      <label className="check small" style={{ marginBottom: 8 }}>
        <input type="checkbox" checked={p.reversed} onChange={(e) => p.onReverse(e.target.checked)} />
        Amounts in this file are the wrong way round (spending shows as money in)
        {!p.isCsv && <span className="hint">&nbsp;· remembered for this account</span>}
      </label>
      {p.warning && (
        <div className="warn-box" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="grow">{p.warning}</span>
          <button className="btn small" onClick={() => p.onReverse(!p.reversed)}>
            {p.reversed ? 'Put the amounts back' : 'Reverse the amounts'}
          </button>
        </div>
      )}
      {p.parsed.warnings.length > 0 && (
        <details className="warn-box" style={{ marginBottom: 8 }}>
          <summary>{p.parsed.warnings.length} line(s) couldn't be read and were skipped</summary>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {p.parsed.warnings.slice(0, 20).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      {!p.accountId ? (
        <div className="hint">Choose an account to see what will be imported.</div>
      ) : (
        <div style={{ maxHeight: '50vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: 4 }}>
          <table className="simple-table small review-table">
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th>Status</th>
                <th>Date</th>
                <th>Payee</th>
                <th style={{ width: 330 }}>Category</th>
                <th>Memo</th>
                <th className="r">Amount</th>
              </tr>
            </thead>
            <tbody
              onKeyDown={(e) => {
                // On a row (not in one of its boxes): arrows move, Space ticks, Enter accepts a suggestion.
                const tr = e.target as HTMLElement;
                if (tr.tagName !== 'TR' || !tr.dataset.key) return;
                const r = rows.find((x) => String(x.key) === tr.dataset.key);
                if (!r) return;
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  ((e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling) as HTMLElement | null)?.focus();
                } else if (e.key === ' ') {
                  e.preventDefault();
                  if (r.kind !== 'duplicate') setRow(r.key, { include: !r.include });
                } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && suggested(r)) {
                  e.preventDefault();
                  setRow(r.key, { userSet: true, transferCheck: undefined, transferClosed: undefined });
                }
              }}
            >
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="hint">
                    {filter === 'suggested' ? 'No suggested categories left to check.' : filter === 'none' ? 'Every row has a category.' : 'Nothing to show.'}
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const m = r.matchId ? b.transactions[r.matchId] : undefined;
                const was = r.matchedTo ? b.transactions[r.matchedTo] : undefined;
                const sugg = suggested(r);
                const choice = r.kind === 'match' ? (r.include ? 'match' : 'skip') : r.include ? 'new' : 'skip';
                return (
                  <tr key={r.key} data-key={r.key} tabIndex={0} style={{ opacity: r.include ? 1 : 0.55 }}>
                    <td>
                      {/* Already in the register: ticking it would import nothing (1.5.7). */}
                      <input
                        type="checkbox"
                        checked={r.include}
                        disabled={r.kind === 'duplicate'}
                        title={r.kind === 'duplicate' ? 'This bank row is in the register already, so it can\'t be imported again' : undefined}
                        onChange={(e) => setRow(r.key, { include: e.target.checked })}
                        aria-label="Include"
                      />
                    </td>
                    <td className="nowrap">
                      {r.kind === 'new' ? (
                        <span
                          className="badge"
                          style={{ background: 'var(--green)' }}
                          title={r.reusedBankId ? 'New: the bank gave it an id it used before for a different transaction' : undefined}
                        >
                          New
                        </span>
                      ) : r.kind === 'match' ? (
                        <span className="badge" title={m ? `Matches ${payeeName(b, m)} on ${formatDate(m.date)}, ${formatMoney(m.amount)}` : ''}>
                          Matches
                        </span>
                      ) : r.kind === 'possible' ? (
                        <>
                          <span className="badge warn" title="Like a transaction imported from another file, so it may be the same one">
                            Possible duplicate
                          </span>
                          {m && (
                            <div className="hint reason">
                              like {formatDate(m.date)} {formatMoney(m.amount)}
                              {!r.include && (
                                <>
                                  {' · '}
                                  <button className="link small" onClick={() => setRow(r.key, { include: true })}>
                                    Import it anyway
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </>
                      ) : r.kind === 'deleted' ? (
                        <span
                          className="badge"
                          style={{ background: 'var(--faint)' }}
                          title={`You deleted this transaction before (${r.deletedAt ? 'on ' + formatDate(r.deletedAt.slice(0, 10)) : 'in YNAB4'}). Tick it to import it again.`}
                        >
                          Previously deleted
                        </span>
                      ) : (
                        <span className="badge" style={{ background: 'var(--faint)' }} title="The bank's row is in the register already. To bring back one you deleted, it has to be gone from the register first.">
                          Already imported{m ? `: ${formatDate(m.date)}${m.accountId !== p.accountId ? `, ${b.accounts[m.accountId]?.name ?? ''}` : ''}` : ''}
                        </span>
                      )}
                    </td>
                    <td className="nowrap">{formatDate(r.src.date)}</td>
                    <td title={r.src.payee !== r.payeeName ? `Bank: ${r.src.payee}` : undefined}>
                      {isNewish(r) ? (
                        <>
                          {r.payeeName}
                          {r.payeeVia === 'text' && <div className="hint reason">same bank text as before</div>}
                          {r.payeeVia === 'merchant' && (
                            <div className="hint reason">
                              looks like {r.payeeName}{' '}
                              <button
                                className="link small"
                                title="Keep as a new payee"
                                aria-label="Keep as a new payee"
                                onClick={() => setRow(r.key, { payeeId: undefined, payeeVia: undefined, payeeName: r.newPayeeName ?? r.src.payee, userSet: true })}
                              >
                                ✕
                              </button>
                            </div>
                          )}
                          {!r.payeeId && !r.transferAccountId && <div className="hint reason">new payee</div>}
                          {r.transferHint && !r.transferAccountId && b.accounts[r.transferHint] && (
                            <div className="hint reason">
                              a transfer to {b.accounts[r.transferHint].name} last time ·{' '}
                              <button
                                className="link small"
                                onClick={() =>
                                  setRow(r.key, {
                                    transferAccountId: r.transferHint,
                                    payeeName: 'Transfer : ' + b.accounts[r.transferHint!].name,
                                    payeeId: undefined,
                                    payeeVia: undefined,
                                    categoryId: transferNeedsCategory(b, p.accountId as Id, r.transferHint!) ? r.categoryId : null,
                                    categoryHint: undefined,
                                    guess: undefined,
                                    userSet: true,
                                  })
                                }
                              >
                                Make it a transfer
                              </button>
                            </div>
                          )}
                          {r.transferCheck && r.transferAccountId && b.accounts[r.transferCheck] && (
                            <div className="hint reason">
                              <span className="sugg-mark" title="A rule chose this account, but this bank text went to the other one last time. It waits for your approval.">
                                ?
                              </span>{' '}
                              last time a transfer to {b.accounts[r.transferCheck].name} ·{' '}
                              <button
                                className="link small"
                                onClick={() =>
                                  setRow(r.key, {
                                    transferAccountId: r.transferCheck,
                                    payeeName: 'Transfer : ' + b.accounts[r.transferCheck!].name,
                                    categoryId: transferNeedsCategory(b, p.accountId as Id, r.transferCheck!) ? r.categoryId : null,
                                    categoryHint: undefined,
                                    guess: undefined,
                                    transferCheck: undefined,
                                    transferClosed: undefined,
                                    userSet: true,
                                  })
                                }
                              >
                                Use it
                              </button>
                            </div>
                          )}
                          {r.transferClosed && r.transferAccountId && b.accounts[r.transferAccountId]?.closed && (
                            <div className="hint reason">
                              <span className="sugg-mark" title="A rule chose this account, which has been closed since. It waits for your approval.">
                                ?
                              </span>{' '}
                              {b.accounts[r.transferAccountId].name} is closed
                            </div>
                          )}
                          {r.transferAccountId &&
                            (() => {
                              const acc = b.accounts[r.transferAccountId]?.name ?? 'the other account';
                              if (r.noPair) {
                                if (!transferPairFor(b, r)) return null;
                                return (
                                  <div className="hint reason">
                                    makes its own transfer in {acc} ·{' '}
                                    <button className="link small" onClick={() => setRow(r.key, { noPair: undefined })}>
                                      Pair it
                                    </button>
                                  </div>
                                );
                              }
                              const u = pairs.get(r.key);
                              if (!u) return null;
                              // Already sorted out there: it changes into this transfer, so say so.
                              const settled = u.accepted || u.cleared === 'R';
                              const cat = u.categoryId ? categoryLabel(b, u.categoryId, u.date) : '';
                              return (
                                <div className="hint reason pair-note">
                                  {settled && (
                                    <span
                                      className="sugg-mark"
                                      title={`That row in ${acc} is already ${u.cleared === 'R' ? 'reconciled' : 'approved'}${cat ? ` in ${cat}` : ''}. Importing makes it the other side of this transfer.`}
                                    >
                                      ?
                                    </span>
                                  )}{' '}
                                  pairs with {acc}'s {formatMoney(Math.abs(u.amount))} "{u.importedPayee || payeeName(b, u)}" on {formatDate(u.date)}
                                  {cat && ` (now ${cat})`} ·{' '}
                                  <button className="link small" onClick={() => setRow(r.key, { noPair: true })}>
                                    Don't pair
                                  </button>
                                </div>
                              );
                            })()}
                        </>
                      ) : (
                        <span className="muted">{r.src.payee}</span>
                      )}
                    </td>
                    <td>
                      {isNewish(r) && needsCategory(r) ? (
                        <>
                          <div className={cx('cat-cell', sugg && 'sugg')}>
                            <Autocomplete
                              value={r.categoryId ? categoryLabel(b, r.categoryId, r.src.date) : ''}
                              options={catOpts}
                              placeholder="(categorise later)"
                              onChange={(_t, o) => changeCategory(r, o ? o.value || null : null)}
                              ariaLabel="Category"
                            />
                            {sugg && (
                              <span className="sugg-mark" title="A suggestion: check it. It waits for your approval.">
                                ?
                              </span>
                            )}
                          </div>
                          {r.categoryHint && !r.userSet && (
                            <div className="hint reason" title={r.guess?.tier === 'confident' ? 'A confident guess' : 'A suggestion: check it'}>
                              {r.categoryHint}
                            </div>
                          )}
                        </>
                      ) : isNewish(r) ? (
                        <span className="muted">Transfer</span>
                      ) : r.kind === 'match' && m ? (
                        <div>
                          <span className="muted">
                            Yours: {payeeName(b, m)}
                            {m.categoryId ? ' · ' + (m.categoryId === SPLIT ? 'Split' : categoryLabel(b, m.categoryId, m.date)) : ''}
                          </span>
                          <div className="hint reason">
                            {formatDate(m.date)} · {m.cleared === 'U' ? 'uncleared' : m.cleared === 'R' ? 'reconciled' : 'cleared'} ·{' '}
                            {m.cleared === 'U' && m.date !== r.src.date ? `date → ${formatDate(r.src.date)}` : 'date kept'}
                          </div>
                        </div>
                      ) : null}
                      {(r.kind === 'match' || r.matchedTo) && (
                        <select
                          className="small match-choice"
                          value={choice}
                          onChange={(e) => choose(r, e.target.value as 'match' | 'new' | 'skip')}
                          aria-label="Match, new or skip"
                          title={was ? `Was matched to ${payeeName(b, was)} on ${formatDate(was.date)}` : undefined}
                        >
                          <option value="match">Match</option>
                          <option value="new">New</option>
                          <option value="skip">Skip</option>
                        </select>
                      )}
                    </td>
                    <td className="muted" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.memo ?? r.src.memo}
                    </td>
                    <td className="r">
                      <span className={cx('money', r.src.amount < 0 && 'neg')}>{formatMoney(r.src.amount)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {similar && (
        <div className="similar-bar" role="status">
          <span className="grow">{similarLabel}</span>
          <button className="btn small primary" onClick={applySimilar}>
            Set {similar.keys.length}
          </button>
          <button className="btn small" onClick={() => setSimilar(null)}>
            No
          </button>
        </div>
      )}
    </div>
  );
}
