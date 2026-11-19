import { newBudget, serializeBudget } from '../model/budget';
import { today } from '../model/dates';
import { formatMoney } from '../model/money';
import { addDeletedImports, deleteAccount, deleteScheduled, enterDueScheduled, setAccountOnBudget, setMasterCollapsed, updateAccount } from '../model/ops';
import { formatDate } from '../model/dates';
import { payeeName } from '../model/queries';
import { findYnab4Budgets, readYnab4DeletedImports } from '../import/ynab4';
import { store, update } from '../state/store';
import { closeBudget, flush, openBudgetFile, saveBudgetAs, saveNewBudgetAndOpen, saveNow, saveStatus } from '../state/persistence';
import { prefStore, ui, type Theme } from '../state/ui';
import { alertDialog, choose, confirm, openModal, prompt, toast } from './common/dialogs';
import { modalOpen } from './common/overlay';
import { AccountDialog } from './accounts/AccountDialog';
import { AdjustBalanceDialog } from './accounts/AdjustBalanceDialog';
import { Ynab4ImportDialog } from './import/Ynab4ImportDialog';
import { BankImportDialog, importDroppedFiles } from './import/BankImportDialog';
import { LearnAccountsDialog } from './import/LearnAccountsDialog';
import type { BankFile } from '../shared/api';
import { FreshStartDialog } from './settings/FreshStartDialog';
import { RestoreBackupDialog } from './settings/RestoreBackupDialog';
import { checkBudget } from '../model/check';
import { exportBudgetCsv } from '../model/exportCsv';
import { ShortcutsDialog, AboutDialog } from './HelpDialogs';
import { currentDoc } from './print/printable';
import { exportDoc, PrintPreview } from './print/PrintPreview';

// Things the menus, keyboard shortcuts and buttons can do. Kept in one place so the
// title bar menus and shortcuts stay in step.

/**
 * Another budget can't be opened, or this one closed, under an open dialog: an import review
 * would then put its rows into the other budget. Says so, and returns true, if a dialog is open.
 * (Restoring a backup and saving a copy are left out: a message box offers them.)
 */
function dialogInTheWay(): boolean {
  if (!modalOpen()) return false;
  toast('Finish or close the open window first.', 'info');
  return true;
}

export async function openBudgetDialog(): Promise<void> {
  if (dialogInTheWay()) return;
  const path = await window.api.openBudgetDialog();
  if (path) await openPath(path);
}

export async function openPath(path: string): Promise<boolean> {
  if (dialogInTheWay()) return false;
  try {
    const opened = await openBudgetFile(path);
    if (!opened) return false; // stayed in the open budget
    const { entered } = opened;
    if (entered) toast(`Entered ${entered} scheduled transaction${entered === 1 ? '' : 's'} that came due.`, 'ok');
    return true;
  } catch (e) {
    const r = await choose(
      'Could not open the budget',
      <>
        <p style={{ marginTop: 0 }}>{e instanceof Error ? e.message : String(e)}</p>
        <p className="hint" style={{ marginBottom: 0 }}>{path}</p>
      </>,
      [
        { key: 'restore', label: 'Restore from a backup…' },
        { key: 'ok', label: 'OK', kind: 'primary' },
      ],
      null,
    );
    if (r === 'restore') restoreFromBackupFlow();
    return false;
  }
}

/** Budget › Check budget: reports anything inconsistent in the data. Changes nothing. */
export async function checkBudgetFlow(): Promise<void> {
  const b = store.budget;
  if (!b) return;
  const problems = checkBudget(b);
  if (!problems.length) {
    await alertDialog('Check budget', <p style={{ margin: 0 }}>No problems found: transfers, splits and links are all consistent.</p>);
    return;
  }
  const txIds = problems.flatMap((p) => p.examples.filter((id) => b.transactions[id]));
  const r = await choose(
    'Check budget',
    <>
      <p style={{ marginTop: 0 }}>Some records don't fit together. Nothing has been changed.</p>
      <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
        {problems.map((p) => (
          <li key={p.kind}>
            {p.kind}: <b>{p.count}</b>
          </li>
        ))}
      </ul>
      <p className="hint" style={{ marginBottom: 0 }}>
        If something looks wrong in the budget, a backup from before the problem can be restored in Settings › File and backups.
      </p>
    </>,
    txIds.length
      ? [
          { key: 'show', label: 'Show the transactions' },
          { key: 'ok', label: 'OK', kind: 'primary' },
        ]
      : [{ key: 'ok', label: 'OK', kind: 'primary' }],
    null,
    560,
  );
  if (r === 'show') ui.go({ view: 'account', id: 'all' }, { registerFilter: { ids: txIds, label: 'From Check budget' } });
}

/** Restores a budget from its automatic backups, for one that is damaged or won't open. */
export function restoreFromBackupFlow(): void {
  openModal((close) => <RestoreBackupDialog onClose={close} />);
}

export async function newBudgetFlow(): Promise<void> {
  if (dialogInTheWay()) return;
  const name = await prompt(
    'Start a new budget',
    'Budget name',
    'My Budget',
    'Choose where to save it…',
    <span className="hint">It starts with a typical set of categories, which you can rename, hide or delete. Currency is pounds (£); you can change it in Settings.</span>,
  );
  if (name === null) return;
  const b = newBudget(name.trim() || 'My Budget', true);
  try {
    await saveNewBudgetAndOpen(b);
  } catch (e) {
    toast(String(e instanceof Error ? e.message : e), 'error');
  }
}

export function importYnab4Flow(): void {
  if (dialogInTheWay()) return;
  openModal((close) => <Ynab4ImportDialog onClose={close} />);
}

export function importBankFlow(accountId?: string): void {
  if (!store.budget) return;
  openModal((close) => <BankImportDialog accountId={accountId} onClose={close} />);
}

/** Bank files dropped on the window: added to the open import, or a new one, for the register shown. */
export function importDroppedFlow(files: BankFile[]): void {
  if (!store.budget || !files.length) return;
  const r = ui.get().route;
  const accountId = r.view === 'account' && r.id !== 'all' ? r.id : undefined;
  importDroppedFiles(files, (f) => openModal((close) => <BankImportDialog accountId={accountId} initialFiles={f} onClose={close} />));
}

/** Old bank downloads teach each account its numbers, before the first import (1.4.4). */
export function learnAccountsFlow(): void {
  if (!store.budget || dialogInTheWay()) return;
  openModal((close) => <LearnAccountsDialog onClose={close} />);
}

export function addAccountFlow(): void {
  openModal((close) => <AccountDialog onClose={close} />);
}

export function editAccountFlow(id: string): void {
  openModal((close) => <AccountDialog accountId={id} onClose={close} />);
}

export function adjustBalanceFlow(id: string): void {
  openModal((close) => <AdjustBalanceDialog accountId={id} onClose={close} />);
}

/** YNAB4's "Make this Account Off-Budget" / "Make this a Budget Account". */
export async function setOnBudgetFlow(id: string, onBudget: boolean): Promise<void> {
  const b = store.budget;
  const a = b?.accounts[id];
  if (!b || !a) return;
  const n = Object.values(b.transactions).filter((t) => t.accountId === id).length;
  const ok = await confirm(
    onBudget ? `Make "${a.name}" a budget account?` : `Make "${a.name}" off-budget?`,
    onBudget
      ? `Its ${n} transaction${n === 1 ? '' : 's'} will count in the budget, and any without a category will need one (the budget screen lists them).`
      : 'Its transactions will stop counting in the budget, and transfers between it and your budget accounts will need a category.',
    onBudget ? 'Make it a budget account' : 'Make it off-budget',
  );
  if (ok) update(onBudget ? 'Make a budget account' : 'Make an account off-budget', (d) => setAccountOnBudget(d, id, onBudget));
}

export function freshStartFlow(): void {
  if (dialogInTheWay()) return;
  openModal((close) => <FreshStartDialog onClose={close} />);
}

export async function saveCopyFlow(): Promise<void> {
  try {
    const p = await saveBudgetAs();
    if (p) toast('Saved. You are now working in ' + p, 'ok');
  } catch (e) {
    toast(String(e instanceof Error ? e.message : e), 'error');
  }
}

export async function closeBudgetFlow(): Promise<void> {
  if (dialogInTheWay()) return;
  await closeBudget();
}

export async function saveNowFlow(): Promise<void> {
  await saveNow();
  const s = saveStatus.get();
  if (s.state === 'saved') toast('Saved', 'ok');
}

export function undo(): void {
  const label = store.undo();
  if (label) toast('Undid: ' + label);
}

/**
 * For a message's Undo button: undoes the change just made, and only while it's still the last
 * one. Otherwise it would undo whatever was done since (1.5.3).
 */
export function undoThis(): () => void {
  const top = store.undoTop();
  return () => {
    if (top && store.undoTop() === top) undo();
    else toast('Other changes have been made since: use Edit › Undo to step back through them.');
  };
}

export function redo(): void {
  const label = store.redo();
  if (label) toast('Redid: ' + label);
}

export async function enterDueNow(): Promise<void> {
  let n = 0;
  update('Enter scheduled transactions', (d) => {
    n = enterDueScheduled(d);
  });
  toast(n ? `Entered ${n} scheduled transaction${n === 1 ? '' : 's'}.` : 'No scheduled transactions are due.', n ? 'ok' : 'info');
}

export async function exportCsvFlow(): Promise<void> {
  const b = store.budget;
  if (!b) return;
  const files = exportBudgetCsv(b);
  const dir = await window.api.saveTextFilesToFolder(files);
  if (dir) toast(`Saved ${files.map((f) => f.name).join(' and ')} in ${dir}`, 'ok');
}

/**
 * Lets a box being typed in (a budget cell, a register row) save on its blur and the screen
 * redraw, before a printout is made. Only text boxes: a list keeps the keyboard.
 */
export async function settleEdits(): Promise<void> {
  const el = document.activeElement;
  if (el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) el.blur();
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * Waits for the screen to redraw (a resized chart measures itself, then draws). Not more than a
 * quarter of a second: a minimised window gets no frames.
 */
const frames = (n: number) =>
  Promise.race([
    new Promise<void>((r) => {
      const next = (k: number) => (k <= 0 ? r() : requestAnimationFrame(() => next(k - 1)));
      next(n);
    }),
    new Promise<void>((r) => setTimeout(r, 250)),
  ]);

/** Takes the pointer off a report's chart, so the printout doesn't show a hovered month or slice. */
function clearChartHover(): void {
  for (const el of document.querySelectorAll('.rp-body svg, .rp-body svg *, .rp-body tr')) {
    el.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  }
}

/**
 * A report's chart is drawn to the size of the screen. For the printout it's redrawn at the
 * page's width for a moment (about 1:1 on paper, so its labels print at their normal size),
 * captured, and given back its size.
 */
async function withChartAtPageWidth<T>(landscape: boolean, make: () => T): Promise<T | null> {
  if (!document.querySelector('.rp-body svg')) return null;
  clearChartHover();
  const resize = !!document.querySelector('.rp-body .rp-chart');
  if (resize) {
    document.body.style.setProperty('--print-chart-w', landscape ? '1030px' : '700px');
    document.body.classList.add('print-sizing');
  }
  try {
    await frames(3);
    return make();
  } finally {
    document.body.classList.remove('print-sizing');
    document.body.style.removeProperty('--print-chart-w');
  }
}

/** A preview is being made (the dialog isn't open yet): a second Ctrl+P waits for it. */
let printing = false;

/** File > Print (Ctrl+P): the preview of what's on screen (1.5.1). */
export async function printFlow(): Promise<void> {
  if (printing) return;
  printing = true;
  try {
    await settleEdits();
    const first = currentDoc();
    // Built again only when a chart was redrawn for it.
    const doc = first && ((await withChartAtPageWidth(!!first.landscape, () => currentDoc())) ?? first);
    if (!doc) toast('Open the budget, a register or a report to print it.');
    else openModal((close) => <PrintPreview doc={doc} onClose={close} />);
  } finally {
    printing = false;
  }
}

/** Ctrl+E, as in YNAB4: what's on screen as a CSV file (1.5.1). */
export async function exportScreenFlow(): Promise<void> {
  await settleEdits();
  const doc = currentDoc();
  if (!doc) toast('Open the budget, a register or a report to export it.');
  else await exportDoc(doc);
}

export async function downloadCopyFlow(): Promise<void> {
  if (!store.budget) return;
  const unsaved = await flush();
  if (unsaved.length) toast(`${unsaved.join(' ')} The copy is made without it.`, 'error');
  // As flushed: a note or transaction still being typed is in the copy (night seven).
  const b = store.budget;
  if (!b) return;
  const p = await window.api.saveTextFile(
    `${b.name} (copy ${today()}).budget`,
    [{ name: 'Budget files', extensions: ['budget'] }],
    serializeBudget(b),
  );
  if (p) toast('Saved a copy to ' + p, 'ok');
}

/**
 * For budgets converted from YNAB4 before 1.1.3: reads the transactions deleted in YNAB4 from
 * the YNAB4 folder (read only) and remembers their bank ids, so re-importing old bank files
 * leaves them out.
 */
export async function readYnab4DeletionsFlow(): Promise<void> {
  const b = store.budget;
  if (!b) return;
  const dir = await window.api.pickYnab4Folder();
  if (!dir) return;
  try {
    const paths = await window.api.listYnab4Files(dir);
    const refs = findYnab4Budgets(paths, dir.split(/[\\/]/).pop());
    const folder = { paths, read: (p: string) => window.api.readYnab4File(dir, p) };
    // The YNAB4 budget this one was converted from shares its account ids.
    let best: Awaited<ReturnType<typeof readYnab4DeletedImports>> | null = null;
    let bestOverlap = 0;
    for (const ref of refs) {
      const r = await readYnab4DeletedImports(folder, ref);
      const overlap = Object.keys(b.accounts).filter((id) => r.accountIds.has(id)).length;
      if (overlap > bestOverlap) {
        best = r;
        bestOverlap = overlap;
      }
    }
    if (!best) {
      await alertDialog(
        "This YNAB4 folder doesn't contain this budget",
        <p style={{ margin: 0 }}>Pick your YNAB folder (usually Documents\YNAB), or the .ynab4 folder this budget came from.</p>,
      );
      return;
    }
    const found = best;
    let n = 0;
    update('Remember deletions from YNAB4', (d) => {
      n = addDeletedImports(d, found.deleted);
      d.settings.ynab4DeletionsReadAt = new Date().toISOString();
    });
    toast(
      n
        ? `Remembered ${n} transaction${n === 1 ? '' : 's'} you deleted in YNAB4. Importing old bank files will leave them out.`
        : 'Nothing new to remember: the deletions from YNAB4 are already known.',
      'ok',
    );
  } catch (e) {
    await alertDialog("Couldn't read the YNAB4 folder", <p style={{ margin: 0 }}>{e instanceof Error ? e.message : String(e)}</p>);
  }
}

export function setTheme(theme: Theme): void {
  prefStore.set({ theme });
}

export function zoom(delta: number | null): void {
  const z = delta === null ? 1 : Math.round(Math.min(2, Math.max(0.7, prefStore.get().zoom + delta)) * 10) / 10;
  prefStore.set({ zoom: z });
  window.api.setZoom(z);
}

export function showShortcuts(): void {
  openModal((close) => <ShortcutsDialog onClose={close} />);
}

export function showAbout(): void {
  openModal((close) => <AboutDialog onClose={close} />);
}

export async function quitApp(): Promise<void> {
  window.api.quit();
}

export function setAllGroupsCollapsed(collapsed: boolean): void {
  update(collapsed ? 'Collapse all groups' : 'Expand all groups', (d) => {
    for (const m of Object.values(d.masters)) setMasterCollapsed(d, m.id, collapsed);
  });
}

/** Closes or reopens an account, checking first if it still has money in it. */
export async function setAccountClosedFlow(id: string, closed: boolean): Promise<void> {
  const b = store.budget;
  const a = b?.accounts[id];
  if (!b || !a) return;
  if (closed) {
    const bal = store.computed()?.accounts.get(id)?.working ?? 0;
    if (bal !== 0) {
      const ok = await confirm(
        'Close account',
        `${a.name} still has a balance of ${formatMoney(bal)}. A closed account's balance still counts in your totals. Usually you would transfer the money out (or record the payment) first. Close it anyway?`,
        'Close account',
      );
      if (!ok) return;
    }
    // Closing doesn't stop schedules into or out of it: they'd go on being entered (1.5.11).
    const scheds = Object.values(b.scheduled).filter(
      (s) => s.accountId === id || s.transferAccountId === id || (s.splits ?? []).some((x) => x.transferAccountId === id),
    );
    if (scheds.length) {
      const list = scheds
        .map((s) => `${s.accountId === id ? payeeName(b, s) : `${b.accounts[s.accountId]?.name ?? ''}: ${payeeName(b, s)}`} (next ${formatDate(s.date)})`)
        .join('; ');
      const n = scheds.length;
      const pick = await choose(
        'Close account',
        `${n === 1 ? 'A scheduled transaction still uses' : `${n} scheduled transactions still use`} ${a.name}: ${list}. Closing the account doesn't stop ${n === 1 ? 'it' : 'them'}, so ${n === 1 ? 'it' : 'they'} would go on being entered.`,
        [
          { key: 'keep', label: `Keep ${n === 1 ? 'it' : 'them'} and close` },
          { key: 'delete', label: `Delete ${n === 1 ? 'it' : 'them'} and close`, kind: 'primary' },
        ],
      );
      if (!pick) return;
      if (pick === 'delete') {
        update('Close account', (d) => {
          for (const s of scheds) deleteScheduled(d, s.id);
          updateAccount(d, id, { closed });
        });
        return;
      }
    }
  }
  update(closed ? 'Close account' : 'Reopen account', (d) => updateAccount(d, id, { closed }));
}

export async function deleteAccountFlow(id: string): Promise<void> {
  const b = store.budget;
  const a = b?.accounts[id];
  if (!b || !a) return;
  const n = Object.values(b.transactions).filter((t) => t.accountId === id).length;
  const ok = await confirm(
    'Delete account',
    `Delete "${a.name}" and its ${n} transaction${n === 1 ? '' : 's'}? Transfers from other accounts are kept as ordinary transactions. You can undo this straight afterwards. To keep its history, close the account instead.`,
    'Delete account',
    true,
  );
  if (!ok) return;
  update('Delete account', (d) => deleteAccount(d, id));
  ui.go({ view: 'budget' });
}
