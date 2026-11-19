import { applyPatches, enablePatches, produceWithPatches, setAutoFreeze, type Patch } from 'immer';
import { useSyncExternalStore } from 'react';
import { addMonths, setDateFormat, thisMonth } from '../model/dates';
import { compute, type Computed } from '../model/engine';
import { setCurrency } from '../model/money';
import type { Budget, MonthKey } from '../model/types';

// The open budget, with undo/redo. Every change goes through `update(label, fn)`,
// where `fn` mutates a draft using the functions in model/ops.ts.

enablePatches();
// Budgets are large; freezing every object after each change would be slow.
setAutoFreeze(false);

interface UndoEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  /** Updates with the same key, one after another, are undone in one step (a note typed with pauses). */
  mergeKey?: string;
}

export interface UpdateOptions {
  mergeKey?: string;
}

const MAX_UNDO = 300;

class BudgetStore {
  budget: Budget | null = null;
  /** Bumped on every change; React components re-render when it changes. */
  version = 0;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private listeners = new Set<() => void>();
  private changeListeners = new Set<(b: Budget) => void>();
  private cache: { b: Budget; until: string; c: Computed } | null = null;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Called after every change made by the user (not on load). Used for autosave. */
  onChange(fn: (b: Budget) => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  private emit(changed: boolean): void {
    this.version++;
    if (this.budget) {
      setCurrency(this.budget.currency);
      setDateFormat(this.budget.dateFormat);
    }
    for (const fn of this.listeners) fn();
    if (changed && this.budget) for (const fn of this.changeListeners) fn(this.budget);
  }

  /** Opens a budget (or closes it, with null). Clears undo history. */
  load(b: Budget | null): void {
    this.budget = b;
    this.undoStack = [];
    this.redoStack = [];
    this.cache = null;
    this.emit(false);
  }

  /** Replaces the budget with a newer copy (e.g. reloaded from disk) without counting it as a change. */
  replace(b: Budget): void {
    this.budget = b;
    this.cache = null;
    this.undoStack = [];
    this.redoStack = [];
    this.emit(false);
  }

  /**
   * Gives the open budget a new id ("Save a copy as…") without counting it as a change. Undo and
   * redo still work: no change in them touches the id.
   */
  setId(id: string): void {
    if (!this.budget) return;
    this.budget = { ...this.budget, id };
    this.emit(false);
  }

  update(label: string, fn: (draft: Budget) => void, opts?: UpdateOptions): void {
    if (!this.budget) return;
    const [next, patches, inverse] = produceWithPatches(this.budget, (d: Budget) => {
      fn(d);
    });
    if (!patches.length) return;
    next.modifiedAt = new Date().toISOString();
    this.budget = next;
    const top = this.undoStack[this.undoStack.length - 1];
    if (opts?.mergeKey && top?.mergeKey === opts.mergeKey && !this.redoStack.length) {
      top.patches = [...top.patches, ...patches];
      top.inverse = [...inverse, ...top.inverse]; // the newest change is undone first
    } else {
      this.undoStack.push({ label, patches, inverse, mergeKey: opts?.mergeKey });
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    }
    this.redoStack = [];
    this.emit(true);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  undoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label;
  }
  /** The newest undo step itself, to tell later whether it's still the newest. */
  undoTop(): object | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }
  redoLabel(): string | undefined {
    return this.redoStack[this.redoStack.length - 1]?.label;
  }

  undo(): string | undefined {
    const e = this.undoStack.pop();
    if (!e || !this.budget) return;
    this.budget = { ...applyPatches(this.budget, e.inverse), modifiedAt: new Date().toISOString() };
    this.redoStack.push(e);
    this.emit(true);
    return e.label;
  }

  redo(): string | undefined {
    const e = this.redoStack.pop();
    if (!e || !this.budget) return;
    this.budget = { ...applyPatches(this.budget, e.patches), modifiedAt: new Date().toISOString() };
    this.undoStack.push(e);
    this.emit(true);
    return e.label;
  }

  /** The budget maths, cached until the next change. */
  computed(until: MonthKey = ''): Computed | null {
    if (!this.budget) return null;
    const c = this.cache;
    if (c && c.b === this.budget && c.until >= until) return c.c;
    // Always reach a few months ahead, so the sidebar and the budget screen share one result.
    const horizon = addMonths(thisMonth(), 6);
    const target = until > horizon ? until : horizon;
    const result = compute(this.budget, target);
    this.cache = { b: this.budget, until: target, c: result };
    return result;
  }
}

export const store = new BudgetStore();

export function update(label: string, fn: (draft: Budget) => void, opts?: UpdateOptions): void {
  store.update(label, fn, opts);
}

export function useStoreVersion(): number {
  return useSyncExternalStore(store.subscribe, () => store.version);
}

/** The open budget. Components using it re-render on every change. */
export function useBudget(): Budget {
  useStoreVersion();
  return store.budget!;
}

export function useComputed(until: MonthKey = ''): Computed {
  useStoreVersion();
  return store.computed(until)!;
}
