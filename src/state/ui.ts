import { useSyncExternalStore } from 'react';
import { thisMonth } from '../model/dates';
import type { Id, MonthKey } from '../model/types';

// Where the user is in the app (screen, month, selected account) and their
// display preferences. Not part of the budget file.

export type Route =
  | { view: 'budget' }
  | { view: 'account'; id: Id | 'all' }
  | { view: 'reports' }
  | { view: 'scheduled' }
  | { view: 'payees' }
  | { view: 'settings' };

export interface RegisterFilter {
  /** Show only these transactions (e.g. from clicking a category's outflows). */
  ids?: Id[];
  label?: string;
  search?: string;
}

export interface UiState {
  route: Route;
  /** The first month shown on the budget screen. */
  month: MonthKey;
  registerFilter?: RegisterFilter;
  /** A transaction to scroll to and select when a register opens. */
  focusTxId?: Id;
}

let state: UiState = { route: { view: 'budget' }, month: thisMonth() };
const listeners = new Set<() => void>();

export const ui = {
  get: (): UiState => state,
  set(patch: Partial<UiState>): void {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  },
  go(route: Route, extra: Partial<UiState> = {}): void {
    state = { ...state, route, registerFilter: undefined, focusTxId: undefined, ...extra };
    listeners.forEach((l) => l());
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useUi(): UiState {
  return useSyncExternalStore(ui.subscribe, ui.get);
}

// ---- Preferences (kept on this computer, per user) --------------------------------------------

export type Theme = 'light' | 'dark' | 'system';

export interface Prefs {
  theme: Theme;
  /** 0 = as many as fit. */
  monthsShown: number;
  inspector: boolean;
  showHidden: boolean;
  zoom: number;
  registerColumns: { check: boolean; balance: boolean; memo: boolean };
  /** The running balance column, account by account (YNAB4 set it per account); missing = registerColumns.balance. */
  runningBalance: Record<string, boolean>;
  sidebarClosedOpen: boolean;
  /** The month headings show just the month and Available to Budget (YNAB4's "Click to collapse details"). */
  monthHeadsCollapsed?: boolean;
  lastBudgetPath?: string;
  /** Bumped when a default changes, so saved preferences can be updated once. */
  version?: number;
}

const DEFAULT_PREFS: Prefs = {
  theme: 'light',
  monthsShown: 0,
  // Not a YNAB4 feature, so off unless asked for (View > Budget inspector).
  inspector: false,
  showHidden: false,
  zoom: 1,
  registerColumns: { check: false, balance: true, memo: true },
  runningBalance: {},
  sidebarClosedOpen: false,
  version: 2,
};

function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem('prefs') || '{}') as Partial<Prefs>;
    // Version 2: the inspector is off by default.
    if ((saved.version ?? 1) < 2) {
      saved.inspector = false;
      saved.version = 2;
    }
    return {
      ...DEFAULT_PREFS,
      ...saved,
      registerColumns: { ...DEFAULT_PREFS.registerColumns, ...(saved.registerColumns || {}) },
      runningBalance: saved.runningBalance && typeof saved.runningBalance === 'object' ? { ...saved.runningBalance } : {},
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

let prefs: Prefs = loadPrefs();
const prefListeners = new Set<() => void>();

export const prefStore = {
  get: (): Prefs => prefs,
  set(patch: Partial<Prefs>): void {
    prefs = { ...prefs, ...patch };
    try {
      localStorage.setItem('prefs', JSON.stringify(prefs));
    } catch {
      // Preferences are a convenience; carry on without saving them.
    }
    prefListeners.forEach((l) => l());
  },
  subscribe(fn: () => void): () => void {
    prefListeners.add(fn);
    return () => prefListeners.delete(fn);
  },
};

export function usePrefs(): Prefs {
  return useSyncExternalStore(prefStore.subscribe, prefStore.get);
}
