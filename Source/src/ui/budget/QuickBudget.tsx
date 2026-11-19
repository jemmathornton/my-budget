import { useState } from 'react';
import { monthLabel, monthName } from '../../model/dates';
import type { Computed } from '../../model/engine';
import { formatMoney } from '../../model/money';
import { setBudgetedMany } from '../../model/ops';
import { quickBudgetChoices, quickFill, type QuickChoice } from '../../model/quickBudget';
import type { Budget, Id, MonthKey } from '../../model/types';
import { store, update, useBudget, useComputed } from '../../state/store';
import * as actions from '../actions';
import { confirm, toast } from '../common/dialogs';
import { BoltIcon } from '../common/icons';
import { Menu, Popover, type MenuEntry } from '../common/overlay';

// YNAB4's Quick Budget for a whole month: the lightning bolt in each month's heading fills in
// the empty budget cells (YNAB4's way), with "Overwrite all" for replacing every cell.

const total = (amounts: Record<Id, number>) => Object.values(amounts).reduce((s, v) => s + v, 0);

/** Fills a month from a Quick Budget choice: empty cells only, or every cell with `overwrite`. */
export async function fillMonth(choice: QuickChoice, month: MonthKey, overwrite = false): Promise<void> {
  const b = store.budget;
  if (!b) return;
  const amounts = quickFill(b, choice, month, overwrite);
  const n = Object.keys(amounts).length;
  if (!n) {
    toast(overwrite ? 'Nothing to change: every cell already has that amount.' : 'There are no empty budget cells to fill.', 'info');
    return;
  }
  if (overwrite) {
    const ok = await confirm(
      'Overwrite budget cells',
      `Set ${n} budget cell${n === 1 ? '' : 's'} in ${monthLabel(month)} to "${choice.label}", replacing what's there? You can undo this with Ctrl+Z.`,
      'Overwrite',
    );
    if (!ok) return;
  }
  update(`Quick budget: ${choice.label}`, (d) => setBudgetedMany(d, month, amounts));
  toast(`Filled ${n} budget cell${n === 1 ? '' : 's'} in ${monthLabel(month)}`, 'ok', { label: 'Undo', fn: actions.undoThis() });
}

async function zeroMonth(month: MonthKey, catIds: Id[]): Promise<void> {
  const b = store.budget;
  if (!b) return;
  const amounts: Record<Id, number> = {};
  for (const id of catIds) if (b.months[month]?.[id]?.budgeted) amounts[id] = 0;
  const n = Object.keys(amounts).length;
  if (!n) {
    toast(`Nothing is budgeted in ${monthLabel(month)}.`, 'info');
    return;
  }
  const ok = await confirm(
    'Zero all budgeted amounts',
    `Set all ${n} budgeted amount${n === 1 ? '' : 's'} in ${monthLabel(month)} to ${formatMoney(0)}? You can undo this with Ctrl+Z.`,
    'Zero all',
  );
  if (ok) update('Quick budget: zero all', (d) => setBudgetedMany(d, month, amounts));
}

function monthMenu(b: Budget, c: Computed, month: MonthKey, catIds: Id[], overwrite: boolean, onOverwrite: () => void): MenuEntry[] {
  const choices = quickBudgetChoices(b, c, catIds, month);
  if (overwrite) {
    return [
      { head: `Overwrite all budget cells in ${monthName(month)} with:` },
      ...choices.map((q) => ({
        label: q.label,
        shortcut: formatMoney(total(q.amounts)),
        onClick: () => void fillMonth(q, month, true),
      })),
    ];
  }
  return [
    { head: `Fill in all empty budget cells in ${monthName(month)} with:` },
    ...choices.map((q) => {
      const fill = quickFill(b, q, month);
      return {
        label: q.label,
        shortcut: formatMoney(total(fill)),
        disabled: Object.keys(fill).length === 0,
        onClick: () => void fillMonth(q, month),
      };
    }),
    'sep',
    { head: 'Fill in all budget cells with:' },
    { label: `${formatMoney(0)} (Zero all budgeted amounts for this month)`, onClick: () => void zeroMonth(month, catIds) },
    { label: 'Overwrite all budget cells with…', onClick: onOverwrite },
  ];
}

/** The lightning bolt in a month's heading. `catIds` are the categories it fills (not hidden ones). */
export function QuickBudgetMonthButton({ month, catIds }: { month: MonthKey; catIds: Id[] }) {
  const b = useBudget();
  const c = useComputed(month);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const close = () => {
    setAnchor(null);
    setOverwrite(false);
  };
  return (
    <>
      <button
        className="mt-quick"
        title="Quick budget: fill in this month's empty budget cells"
        aria-label={`Quick budget for ${monthLabel(month)}`}
        onClick={(e) => {
          setOverwrite(false);
          setAnchor(anchor ? null : e.currentTarget);
        }}
      >
        <BoltIcon size={13} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={close} align="right">
          <Menu
            key={String(overwrite)}
            items={monthMenu(b, c, month, catIds, overwrite, () => {
              // The menu closes itself before this runs; open it again in overwrite mode.
              setAnchor(anchor);
              setOverwrite(true);
            })}
            onClose={close}
          />
        </Popover>
      )}
    </>
  );
}

/** Quick Budget choices as right-click menu entries: they set the chosen categories. */
export function quickBudgetMenu(b: Budget, c: Computed, ids: Id[], month: MonthKey): MenuEntry[] {
  const qs = quickBudgetChoices(b, c, ids, month);
  return [
    {
      head:
        ids.length === 1 && b.categories[ids[0]]
          ? `Quick budget: ${b.categories[ids[0]].name}, ${monthName(month)}`
          : `Quick budget for ${monthName(month)} (${ids.length} categories)`,
    },
    ...qs.map((q) => ({
      label: q.label,
      shortcut: formatMoney(total(q.amounts)),
      onClick: () => update(`Quick budget: ${q.label}`, (d) => setBudgetedMany(d, month, q.amounts)),
    })),
  ];
}
