import { useEffect, useState } from 'react';
import { Logo } from './common/icons';
import { Modal } from './common/overlay';

const SHORTCUTS: [string, [string, string][]][] = [
  [
    'Everywhere',
    [
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
      ['Ctrl+S', 'Save now (it also saves automatically)'],
      ['Ctrl+O', 'Open a budget'],
      ['Ctrl+P / Ctrl+E', "Print what's on screen (the budget, a register, a report) / save it as a CSV file"],
      ['Ctrl+B / Ctrl+R / Ctrl+T', 'Budget / Reports / All accounts (YNAB4); Ctrl+1 / 2 / 3 work too'],
      ['Alt or F10', 'Open the menus (Alt+F File, Alt+E Edit, Alt+V View...)'],
      ['Shift+F10 or the Menu key', "The right-click menu of the row you're on"],
      ['Tab', 'Also reaches the accounts in the sidebar (Enter opens one)'],
      ['Ctrl+I', 'Import from your bank'],
      ['Ctrl+Enter in the import review', 'Import the ticked rows'],
      ['↑ ↓ / Space / Enter on a review row', 'Move / tick or untick / accept its suggested category'],
      ['Ctrl+F', 'Search transactions (also "Is: uncleared", "Outflow: 12.50", "Before: 1/11/2026", as in YNAB4)'],
      ['Shift+A in a register', 'Approve and find the next transaction waiting for approval'],
      ['Ctrl++ / Ctrl+− / Ctrl+0', 'Zoom in / out / actual size'],
      ['F1', 'This list'],
    ],
  ],
  [
    'Budget',
    [
      ['Click a budgeted amount', 'Edit it (maths works: 120/4, +25 to add, -20 to take off; (20) for a negative amount)'],
      ['Enter / Tab / ↑ ↓', 'Save and stay / move down / move up or down'],
      ['↑ ↓ then Enter', 'Pick a category and edit its amount'],
      ['Ctrl+← / Ctrl+→', 'Previous / next month'],
      ['Alt+↓ in a budgeted amount', 'Quick budget for that cell (or click ▾)'],
      ['⚡ in a month heading', "Quick budget: fill in the month's empty cells"],
      ['Shift / Ctrl+click', 'Select several categories for quick budget'],
      ['Double-click a name', 'Rename a category or group'],
    ],
  ],
  [
    'Accounts',
    [
      ['N, Ctrl+N or Insert', 'New transaction'],
      ['Enter or F2', 'Edit the selected transaction'],
      ['Esc', 'Cancel editing, or clear the selection'],
      ['Shift+↑ / Shift+↓', 'Add the row above / below to the selection'],
      ['C or Ctrl+Shift+C', 'Mark selected cleared / uncleared (clearing also approves)'],
      ['A or Ctrl+K', 'Approve selected (imported or entered by the scheduler)'],
      ['Del', 'Delete selected'],
      ['Ctrl+A', 'Select all shown'],
      ['↑ ↓ (or + −) in a date', 'Next / previous day'],
      ['t or . in a date', 'Today'],
      ['m / M in a date', 'First / last day of the month'],
      ['y / Y in a date', 'First / last day of the year'],
    ],
  ],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} width={620} footer={<button className="btn primary" onClick={onClose}>Close</button>}>
      {SHORTCUTS.map(([group, rows]) => (
        <div key={group} style={{ marginBottom: 12 }}>
          <div className="insp-sec-title">{group}</div>
          <table className="simple-table">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k}>
                  <td style={{ width: 230 }}>
                    <span className="kbd">{k}</span>
                  </td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </Modal>
  );
}

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState('');
  const [backups, setBackups] = useState('');
  useEffect(() => {
    window.api.version().then(setVersion);
    window.api.backupsRoot().then(setBackups);
  }, []);
  return (
    <Modal title="About My Budget" onClose={onClose} width={460} footer={<button className="btn primary" onClick={onClose}>Close</button>}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }}>
        <Logo size={34} />
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>My Budget {version}</div>
          <div className="hint">A private, offline envelope budget with YNAB4's features.</div>
        </div>
      </div>
      <p>Your budget is saved in your own .budget file. Nothing is ever sent over the internet.</p>
      <p className="hint" style={{ marginBottom: 0 }}>
        Automatic backups: {backups}
      </p>
    </Modal>
  );
}
