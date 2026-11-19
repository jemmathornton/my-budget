import { useEffect, useState } from 'react';
import type { RecentBudget } from '../shared/api';
import { useSaveStatus } from '../state/persistence';
import { store, useStoreVersion } from '../state/store';
import { prefStore, ui, usePrefs, useUi } from '../state/ui';
import * as actions from './actions';
import { Logo, CheckIcon, WarnIcon } from './common/icons';
import { cx } from './common/Money';
import { Menu, modalOpen, Popover, type MenuEntry } from './common/overlay';

// The window's title bar. Windows draws the minimise/maximise/close buttons on the right;
// the app draws its menus on the left, so no space is lost to a separate menu bar.

type MenuName = 'File' | 'Edit' | 'View' | 'Budget' | 'Help';
const MENU_NAMES: MenuName[] = ['File', 'Edit', 'View', 'Budget', 'Help'];

export function TitleBar() {
  useStoreVersion();
  const b = store.budget;
  const prefs = usePrefs();
  const { route } = useUi();
  const save = useSaveStatus();
  const [open, setOpen] = useState<{ name: MenuName; anchor: HTMLElement } | null>(null);
  const [recent, setRecent] = useState<RecentBudget[]>([]);

  useEffect(() => {
    if (open?.name === 'File') window.api.recentBudgets().then(setRecent);
  }, [open?.name]);

  // The keyboard, as in other Windows programs: Alt (pressed and let go) or F10 opens the File
  // menu, Alt+F/E/V/B/H opens that menu, and left/right move between menus.
  useEffect(() => {
    const anchorOf = (name: MenuName) => document.querySelector<HTMLElement>(`.tb-menu-btn[data-menu="${name}"]`);
    const toggle = (name: MenuName) => {
      const anchor = anchorOf(name);
      if (anchor) setOpen((cur) => (cur ? null : { name, anchor }));
    };
    let altAlone = false;
    const down = (e: KeyboardEvent) => {
      // The menus wait while a dialog is open (they could open another budget under it).
      if (modalOpen()) {
        altAlone = false;
        return;
      }
      if (e.key === 'Alt') {
        if (!e.repeat) altAlone = true;
        return;
      }
      altAlone = false;
      if (e.key === 'F10' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        toggle('File');
      } else if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        const name = MENU_NAMES.find((n) => n[0].toLowerCase() === e.key.toLowerCase());
        const anchor = name && anchorOf(name);
        if (name && anchor) {
          e.preventDefault();
          setOpen({ name, anchor });
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && altAlone) {
        e.preventDefault();
        toggle('File');
      }
      altAlone = false;
    };
    // Alt+Tab to another window must not open a menu when coming back.
    const blur = () => (altAlone = false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  const switchMenu = (dir: -1 | 1) => {
    if (!open) return;
    const name = MENU_NAMES[(MENU_NAMES.indexOf(open.name) + dir + MENU_NAMES.length) % MENU_NAMES.length];
    const anchor = document.querySelector<HTMLElement>(`.tb-menu-btn[data-menu="${name}"]`);
    if (anchor) setOpen({ name, anchor });
  };

  const accountId = route.view === 'account' && route.id !== 'all' ? route.id : undefined;
  // The screens with a printout (1.5.1).
  const printable = !!b && (route.view === 'budget' || route.view === 'account' || route.view === 'reports');

  const menus: Record<MenuName, () => MenuEntry[]> = {
    File: () => [
      { label: 'New budget…', onClick: () => void actions.newBudgetFlow() },
      { label: 'Open budget…', shortcut: 'Ctrl+O', onClick: () => void actions.openBudgetDialog() },
      ...(recent.filter((r) => r.path !== save.path).length
        ? ([{ head: 'Recent budgets' }] as MenuEntry[]).concat(
            recent
              .filter((r) => r.path !== save.path)
              .slice(0, 6)
              .map((r) => ({ label: r.name, onClick: () => void actions.openPath(r.path) })),
          )
        : []),
      { label: 'Import a YNAB4 budget…', onClick: actions.importYnab4Flow },
      'sep',
      { label: 'Save now', shortcut: 'Ctrl+S', disabled: !b, onClick: () => void actions.saveNowFlow() },
      { label: 'Save a copy as…', disabled: !b, onClick: () => void actions.saveCopyFlow() },
      { label: 'Show budget file in folder', disabled: !save.path, onClick: () => save.path && window.api.showInFolder(save.path) },
      'sep',
      { label: 'Print…', shortcut: 'Ctrl+P', disabled: !printable, onClick: () => void actions.printFlow() },
      { label: 'Export this screen (CSV)…', shortcut: 'Ctrl+E', disabled: !printable, onClick: () => void actions.exportScreenFlow() },
      { label: 'Export budget data (CSV)…', disabled: !b, onClick: () => void actions.exportCsvFlow() },
      { label: 'Fresh Start…', disabled: !b, onClick: actions.freshStartFlow },
      'sep',
      { label: 'Close budget', disabled: !b, onClick: () => void actions.closeBudgetFlow() },
      { label: 'Exit', shortcut: 'Alt+F4', onClick: () => void actions.quitApp() },
    ],
    Edit: () => [
      {
        label: store.canUndo() ? `Undo ${store.undoLabel()}` : 'Undo',
        shortcut: 'Ctrl+Z',
        disabled: !store.canUndo(),
        onClick: actions.undo,
      },
      {
        label: store.canRedo() ? `Redo ${store.redoLabel()}` : 'Redo',
        shortcut: 'Ctrl+Y',
        disabled: !store.canRedo(),
        onClick: actions.redo,
      },
      'sep',
      {
        label: 'Find transactions…',
        shortcut: 'Ctrl+F',
        disabled: !b,
        onClick: () => ui.go({ view: 'account', id: 'all' }, { registerFilter: { search: '' } }),
      },
    ],
    View: () => [
      { label: 'Budget', shortcut: 'Ctrl+1', disabled: !b, checked: route.view === 'budget', onClick: () => ui.go({ view: 'budget' }) },
      { label: 'Reports', shortcut: 'Ctrl+2', disabled: !b, checked: route.view === 'reports', onClick: () => ui.go({ view: 'reports' }) },
      {
        label: 'All accounts',
        shortcut: 'Ctrl+3',
        disabled: !b,
        checked: route.view === 'account' && route.id === 'all',
        onClick: () => ui.go({ view: 'account', id: 'all' }),
      },
      { label: 'Scheduled transactions', disabled: !b, checked: route.view === 'scheduled', onClick: () => ui.go({ view: 'scheduled' }) },
      { label: 'Payees', disabled: !b, checked: route.view === 'payees', onClick: () => ui.go({ view: 'payees' }) },
      'sep',
      { label: 'Show hidden categories', checked: prefs.showHidden, onClick: () => prefStore.set({ showHidden: !prefs.showHidden }) },
      { label: 'Expand all category groups', disabled: !b, onClick: () => actions.setAllGroupsCollapsed(false) },
      { label: 'Collapse all category groups', disabled: !b, onClick: () => actions.setAllGroupsCollapsed(true) },
      { label: 'Budget inspector panel', checked: prefs.inspector, onClick: () => prefStore.set({ inspector: !prefs.inspector }) },
      { head: 'Months on the budget screen' },
      { label: 'As many as fit', checked: prefs.monthsShown === 0, onClick: () => prefStore.set({ monthsShown: 0 }) },
      ...[1, 2, 3, 4, 5].map((n) => ({
        label: `${n} month${n > 1 ? 's' : ''}`,
        checked: prefs.monthsShown === n,
        onClick: () => prefStore.set({ monthsShown: n }),
      })),
      'sep',
      { label: 'Light theme', checked: prefs.theme === 'light', onClick: () => actions.setTheme('light') },
      { label: 'Dark theme', checked: prefs.theme === 'dark', onClick: () => actions.setTheme('dark') },
      { label: 'Match Windows', checked: prefs.theme === 'system', onClick: () => actions.setTheme('system') },
      'sep',
      { label: 'Zoom in', shortcut: 'Ctrl++', onClick: () => actions.zoom(0.1) },
      { label: 'Zoom out', shortcut: 'Ctrl+−', onClick: () => actions.zoom(-0.1) },
      { label: `Actual size${prefs.zoom !== 1 ? ` (now ${Math.round(prefs.zoom * 100)}%)` : ''}`, shortcut: 'Ctrl+0', onClick: () => actions.zoom(null) },
    ],
    Budget: () => [
      { label: 'Add an account…', disabled: !b, onClick: actions.addAccountFlow },
      { label: 'Import from bank…', shortcut: 'Ctrl+I', disabled: !b, onClick: () => actions.importBankFlow(accountId) },
      { label: 'Enter due scheduled transactions', disabled: !b, onClick: () => void actions.enterDueNow() },
      { label: 'Check budget…', disabled: !b, onClick: () => void actions.checkBudgetFlow() },
      'sep',
      { label: 'Budget settings…', disabled: !b, onClick: () => ui.go({ view: 'settings' }) },
    ],
    Help: () => [
      { label: 'Keyboard shortcuts', shortcut: 'F1', onClick: actions.showShortcuts },
      { label: 'Developer tools', shortcut: 'F12', onClick: () => window.api.toggleDevTools() },
      'sep',
      { label: 'About My Budget', onClick: actions.showAbout },
    ],
  };

  const saveLabel =
    save.state === 'saving' || save.state === 'pending'
      ? 'Saving…'
      : save.state === 'saved'
        ? 'Saved'
        : save.state === 'conflict'
          ? 'File changed elsewhere'
          : save.state === 'error'
            ? 'Not saved'
            : '';

  return (
    <header className="titlebar">
      <div className="tb-logo">
        <Logo size={16} />
        <span>My Budget</span>
      </div>
      {(Object.keys(menus) as MenuName[]).map((name) => (
        <button
          key={name}
          data-menu={name}
          aria-haspopup="menu"
          aria-expanded={open?.name === name}
          className={cx('tb-menu-btn', open?.name === name && 'open')}
          onClick={(e) => !modalOpen() && setOpen(open?.name === name ? null : { name, anchor: e.currentTarget })}
          onMouseEnter={(e) => open && open.name !== name && setOpen({ name, anchor: e.currentTarget })}
        >
          {name}
        </button>
      ))}
      <div className="tb-title">{b ? b.name : ''}</div>
      {b && saveLabel && (
        <button
          className={cx('tb-save', save.state)}
          title={save.path ? `${saveLabel}: ${save.path}${save.savedAt ? `\nLast saved ${new Date(save.savedAt).toLocaleTimeString()}` : ''}` : ''}
          onClick={() => save.path && window.api.showInFolder(save.path)}
        >
          {save.state === 'saved' ? <CheckIcon size={13} /> : save.state === 'error' || save.state === 'conflict' ? <WarnIcon size={13} /> : null}
          {saveLabel}
        </button>
      )}
      {open && (
        <Popover anchor={open.anchor} onClose={() => setOpen(null)}>
          <Menu key={open.name} items={menus[open.name]()} onClose={() => setOpen(null)} onSwitch={switchMenu} />
        </Popover>
      )}
    </header>
  );
}
