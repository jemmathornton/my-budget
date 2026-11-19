import { useEffect, useState } from 'react';
import { initPersistence, keepMine, saveStatus, useFileVersion, useSaveStatus, type LeaveQuestion } from '../state/persistence';
import { store, useStoreVersion } from '../state/store';
import { prefStore, ui, usePrefs, useUi } from '../state/ui';
import * as actions from './actions';
import { BudgetView, budgetPrevNextMonth } from './budget/BudgetView';
import { alertDialog, choose, DialogHost, ModalHost, Toasts, toast } from './common/dialogs';
import { modalOpen, useKeyboardContextMenus } from './common/overlay';
import { Home } from './Home';
import { Register } from './register/Register';
import { Reports } from './reports/Reports';
import { Payees } from './payees/Payees';
import { Scheduled } from './scheduled/Scheduled';
import { Settings } from './settings/Settings';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';

let persistenceStarted = false;

export function App() {
  useStoreVersion();
  const prefs = usePrefs();
  const [booting, setBooting] = useState(true);
  const budget = store.budget;

  useTheme(prefs.theme);
  useEffect(() => {
    document.title = budget ? `${budget.name} - My Budget` : 'My Budget';
  }, [budget?.name]);

  useEffect(() => {
    if (!persistenceStarted) {
      persistenceStarted = true;
      initPersistence({ onExternalReload: (msg) => toast(msg, 'info'), onBackupFailed: (msg) => toast(msg, 'error'), askBeforeLeaving });
      window.api.setZoom(prefStore.get().zoom);
      window.api.onOpenFile((p) => void actions.openPath(p));
    }
    (async () => {
      const startup = await window.api.startupFile();
      const path = startup || prefStore.get().lastBudgetPath;
      if (path && !store.budget) {
        const st = await window.api.statBudget(path);
        if (st) await actions.openPath(path);
        else if (!startup) prefStore.set({ lastBudgetPath: undefined });
      }
      setBooting(false);
    })();
  }, []);

  useGlobalShortcuts();
  useKeyboardContextMenus();
  useFileDrop();

  return (
    <div className="app">
      <TitleBar />
      {booting ? (
        <div className="home" />
      ) : budget ? (
        <>
          <SaveBanner />
          <div className="body">
            <Sidebar />
            <main className="main">
              <MainView />
            </main>
          </div>
        </>
      ) : (
        <Home />
      )}
      <ModalHost />
      <DialogHost />
      <Toasts />
    </div>
  );
}

function MainView() {
  const { route } = useUi();
  switch (route.view) {
    case 'budget':
      return <BudgetView />;
    case 'account':
      return <Register key={route.id} accountId={route.id} />;
    case 'reports':
      return <Reports />;
    case 'scheduled':
      return <Scheduled />;
    case 'payees':
      return <Payees />;
    case 'settings':
      return <Settings />;
  }
}

/** Asked when the budget can't be saved before closing the app or switching budget. */
async function askBeforeLeaving(q: LeaveQuestion): Promise<boolean> {
  if (q.state === 'draft') {
    // A transaction being entered that can't be saved as it is: the editor is still open.
    const r = await choose(
      'A transaction you were entering isn\'t saved',
      <p style={{ margin: 0 }}>{q.error} Stay to deal with it, or leave without it.</p>,
      [
        { key: 'go', label: q.reason === 'close' ? 'Close without it' : 'Leave without it', kind: 'danger' },
        { key: 'stay', label: q.reason === 'close' ? 'Keep the app open' : 'Stay in this budget', kind: 'primary' },
      ],
      null,
      520,
    );
    return r === 'go';
  }
  const why =
    q.state === 'conflict'
      ? 'The budget file was changed by another program while you had unsaved changes here.'
      : q.state === 'error'
        ? `My Budget couldn't save to the budget file${q.error ? `: ${q.error}` : '.'}`
        : 'Saving is taking a long time (the file may be on a slow or unavailable drive).';
  const since = q.savedAt ? new Date(q.savedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;
  for (;;) {
    const r = await choose(
      "Your latest changes aren't saved in the budget file",
      <>
        <p style={{ marginTop: 0 }}>{why}</p>
        <p style={{ marginBottom: 0 }}>
          {q.backedUp
            ? 'A copy of this window\'s version has been kept as a backup (Settings › File and backups, "Unsaved changes when closing").'
            : `A backup couldn't be made either. If you go ahead, your changes${since ? ` since ${since}` : ''} will be lost.`}
        </p>
      </>,
      [
        { key: 'copy', label: 'Save a copy as…' },
        { key: 'go', label: q.reason === 'close' ? 'Close anyway' : 'Leave this budget anyway', kind: 'danger' },
        { key: 'stay', label: q.reason === 'close' ? 'Keep the app open' : 'Stay in this budget', kind: 'primary' },
      ],
      null,
      560,
    );
    if (r === 'go') return true;
    if (r !== 'copy') return false;
    // A copy in a new file is a safe way out; after that the window works in the copy.
    await actions.saveCopyFlow();
    if (saveStatus.get().state === 'saved') return true;
  }
}

function SaveBanner() {
  const s = useSaveStatus();
  if (s.state === 'conflict') {
    const failed = (title: string, what: string) => (e: unknown) =>
      void alertDialog(
        title,
        <p style={{ margin: 0 }}>
          {what} {e instanceof Error ? e.message : String(e)}
        </p>,
      );
    return (
      <div className="banner error" role="alert">
        <span>
          <b>The budget file was changed by another program or computer</b> while you had unsaved changes here. Which
          version should be kept? The other is saved as a backup.
        </span>
        <span className="grow" />
        <button
          className="btn small"
          onClick={() =>
            useFileVersion().catch(
              failed("Couldn't use the file's version", "This window's version couldn't be backed up first, so nothing was changed."),
            )
          }
        >
          Use the file's version
        </button>
        <button
          className="btn small primary"
          onClick={() =>
            keepMine().catch(
              failed("Couldn't keep this version", "The other version couldn't be backed up first, so nothing was overwritten."),
            )
          }
        >
          Keep this version
        </button>
      </div>
    );
  }
  if (s.state === 'error') {
    return (
      <div className="banner error" role="alert">
        <span>
          <b>Couldn't save to the budget file.</b> {s.error} It will try again automatically.
        </span>
        <span className="grow" />
        <button className="btn small" onClick={() => void actions.saveNowFlow()}>
          Try now
        </button>
        <button className="btn small" onClick={() => void actions.downloadCopyFlow()}>
          Save a copy elsewhere…
        </button>
      </div>
    );
  }
  return null;
}

/** Bank files dropped anywhere on the window open the import (1.3.2). Nothing is read until dropped. */
function useFileDrop() {
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = store.budget ? 'copy' : 'none';
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!store.budget) return;
      const list = [...(e.dataTransfer?.files ?? [])];
      const tooBig = list.filter((f) => f.size > 20 * 1024 * 1024);
      if (tooBig.length) toast(`${tooBig.length} file${tooBig.length === 1 ? ' is' : 's are'} too big to be a bank file and ${tooBig.length === 1 ? 'was' : 'were'} left out.`, 'info');
      void Promise.all(
        list
          .filter((f) => f.size <= 20 * 1024 * 1024 && f.size > 0)
          .map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), modifiedMs: f.lastModified })),
      ).then((files) => actions.importDroppedFlow(files));
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);
}

function useTheme(theme: 'light' | 'dark' | 'system') {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      window.api.setTitleBarColors(dark ? '#0e1b28' : '#1d3955', dark ? '#c9d6e3' : '#dce7f2');
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

function isTextField(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
}

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (e.key === 'F1') {
        e.preventDefault();
        actions.showShortcuts();
      } else if (e.key === 'F12') {
        window.api.toggleDevTools();
      } else if (ctrl && (key === '=' || key === '+')) {
        e.preventDefault();
        actions.zoom(0.1);
      } else if (ctrl && key === '-') {
        e.preventDefault();
        actions.zoom(-0.1);
      } else if (ctrl && key === '0') {
        e.preventDefault();
        actions.zoom(null);
      }
      // While a dialog is open (an import review, say), the other shortcuts wait: they would act
      // on the screen behind it, undo the import before, or open another budget under it.
      if (modalOpen()) return;
      if (ctrl && key === 'o') {
        e.preventDefault();
        void actions.openBudgetDialog();
        return;
      }
      if (!store.budget) return;
      if (ctrl && key === 's') {
        e.preventDefault();
        void actions.saveNowFlow();
      } else if (ctrl && !e.shiftKey && key === 'z' && !isTextField(e.target)) {
        e.preventDefault();
        actions.undo();
      } else if (ctrl && (key === 'y' || (e.shiftKey && key === 'z')) && !isTextField(e.target)) {
        e.preventDefault();
        actions.redo();
      } else if (ctrl && !e.shiftKey && (key === '1' || key === 'b')) {
        // Ctrl+B, Ctrl+R and Ctrl+T are YNAB4's keys for these screens. A box being typed in is
        // saved first: the screen it's on goes away without a blur (1.5.3).
        e.preventDefault();
        void actions.settleEdits().then(() => ui.go({ view: 'budget' }));
      } else if (ctrl && !e.shiftKey && (key === '2' || key === 'r')) {
        e.preventDefault();
        void actions.settleEdits().then(() => ui.go({ view: 'reports' }));
      } else if (ctrl && !e.shiftKey && (key === '3' || key === 't')) {
        e.preventDefault();
        void actions.settleEdits().then(() => ui.go({ view: 'account', id: 'all' }));
      } else if (ctrl && key === 'f' && ui.get().route.view !== 'account') {
        e.preventDefault();
        void actions.settleEdits().then(() => ui.go({ view: 'account', id: 'all' }, { registerFilter: { search: '' } }));
      } else if (ctrl && !e.shiftKey && key === 'p') {
        e.preventDefault();
        void actions.printFlow();
      } else if (ctrl && !e.shiftKey && key === 'e') {
        e.preventDefault();
        void actions.exportScreenFlow();
      } else if (ctrl && key === 'i') {
        e.preventDefault();
        const r = ui.get().route;
        actions.importBankFlow(r.view === 'account' && r.id !== 'all' ? r.id : undefined);
      } else if (ctrl && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && ui.get().route.view === 'budget' && !isTextField(e.target)) {
        e.preventDefault();
        budgetPrevNextMonth(e.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
