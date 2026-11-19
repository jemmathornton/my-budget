import { useState } from 'react';
import { today } from '../model/dates';
import { moveAccount } from '../model/ops';
import { sortedAccounts } from '../model/queries';
import type { Account, Id } from '../model/types';
import { update, useBudget, useComputed } from '../state/store';
import { prefStore, ui, usePrefs, useUi } from '../state/ui';
import * as actions from './actions';
import { AccountsIcon, BudgetIcon, PayeesIcon, PlusIcon, ReportsIcon, ScheduledIcon, SettingsIcon } from './common/icons';
import { Money, cx } from './common/Money';
import { useContextMenu, type MenuEntry } from './common/overlay';

export function Sidebar() {
  const b = useBudget();
  const c = useComputed();
  const { route } = useUi();
  const prefs = usePrefs();
  const [openCtx, ctxNode] = useContextMenu();
  const [drag, setDrag] = useState<Id | null>(null);
  const [dropOn, setDropOn] = useState<Id | null>(null);

  const accounts = sortedAccounts(b);
  const onBudget = accounts.filter((a) => a.onBudget && !a.closed);
  const offBudget = accounts.filter((a) => !a.onBudget && !a.closed);
  const closed = accounts.filter((a) => a.closed);
  const bal = (a: Account) => c.accounts.get(a.id)?.working ?? 0;
  const total = (list: Account[]) => list.reduce((s, a) => s + bal(a), 0);
  const due = Object.values(b.scheduled).filter((s) => s.date <= today()).length;

  const accountMenu = (a: Account): MenuEntry[] => [
    { label: 'Open register', onClick: () => ui.go({ view: 'account', id: a.id }) },
    { label: 'Import from bank…', onClick: () => actions.importBankFlow(a.id) },
    { label: 'Edit account…', onClick: () => actions.editAccountFlow(a.id) },
    { label: 'Adjust balance…', onClick: () => actions.adjustBalanceFlow(a.id) },
    {
      label: a.onBudget ? 'Make this account off-budget…' : 'Make this a budget account…',
      onClick: () => void actions.setOnBudgetFlow(a.id, !a.onBudget),
    },
    'sep',
    {
      label: a.closed ? 'Reopen account' : 'Close account',
      onClick: () => void actions.setAccountClosedFlow(a.id, !a.closed),
    },
    { label: 'Delete account…', danger: true, onClick: () => void actions.deleteAccountFlow(a.id) },
  ];

  const row = (a: Account) => {
    const totals = c.accounts.get(a.id);
    const active = route.view === 'account' && route.id === a.id;
    return (
      <div
        key={a.id}
        className={cx('acc-row', active && 'active', drag === a.id && 'dragging', dropOn === a.id && 'drop-before')}
        onClick={() => ui.go({ view: 'account', id: a.id })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            ui.go({ view: 'account', id: a.id });
          }
        }}
        onContextMenu={(e) => openCtx(e, accountMenu(a))}
        tabIndex={0}
        role="button"
        data-kbmenu=""
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          setDrag(a.id);
        }}
        onDragEnd={() => {
          setDrag(null);
          setDropOn(null);
        }}
        onDragOver={(e) => {
          if (!drag || drag === a.id) return;
          e.preventDefault();
          setDropOn(a.id);
        }}
        onDrop={() => {
          if (drag && drag !== a.id) {
            const idx = accounts.filter((x) => x.id !== drag).findIndex((x) => x.id === a.id);
            update('Reorder accounts', (d) => moveAccount(d, drag, idx));
          }
          setDrag(null);
          setDropOn(null);
        }}
        title={a.note ? `${a.name}\n${a.note}` : a.name}
      >
        <span className="acc-name">
          {a.name}
          {!!totals?.unapproved && (
            <span className="acc-unapproved" title={`${totals.unapproved} transaction(s) to approve`}>
              {totals.unapproved}
            </span>
          )}
        </span>
        <span className={cx('acc-bal money', bal(a) < 0 && 'neg')}>
          <Money v={bal(a)} />
        </span>
      </div>
    );
  };

  return (
    <nav className="sidebar" aria-label="Accounts and screens">
      <div className="sb-nav sb-panel">
        <NavBtn icon={<BudgetIcon />} label="Budget" active={route.view === 'budget'} onClick={() => ui.go({ view: 'budget' })} />
        <NavBtn icon={<ReportsIcon />} label="Reports" active={route.view === 'reports'} onClick={() => ui.go({ view: 'reports' })} />
        <NavBtn
          icon={<AccountsIcon />}
          label="All accounts"
          active={route.view === 'account' && route.id === 'all'}
          onClick={() => ui.go({ view: 'account', id: 'all' })}
        />
        <NavBtn
          icon={<ScheduledIcon />}
          label="Scheduled"
          active={route.view === 'scheduled'}
          onClick={() => ui.go({ view: 'scheduled' })}
          badge={due > 0 ? <span className="badge warn">{due}</span> : undefined}
        />
        <NavBtn icon={<PayeesIcon />} label="Payees" active={route.view === 'payees'} onClick={() => ui.go({ view: 'payees' })} />
        <NavBtn icon={<SettingsIcon />} label="Settings" active={route.view === 'settings'} onClick={() => ui.go({ view: 'settings' })} />
      </div>
      <div className="sb-accounts">
        <div className="sb-panel" style={{ marginTop: 8 }}>
          <div className="acc-group-head">
            <span>Budget accounts</span>
            <Money v={total(onBudget)} />
          </div>
          {onBudget.map(row)}
          {onBudget.length === 0 && <div className="acc-row muted" style={{ cursor: 'default' }}>None yet</div>}
        </div>
        {offBudget.length > 0 && (
          <div className="sb-panel">
            <div className="acc-group-head">
              <span>Off-budget accounts</span>
              <Money v={total(offBudget)} />
            </div>
            {offBudget.map(row)}
          </div>
        )}
        {closed.length > 0 && (
          <div className="sb-panel">
            <div
              className="acc-group-head clickable"
              onClick={() => prefStore.set({ sidebarClosedOpen: !prefs.sidebarClosedOpen })}
            >
              <span>
                {prefs.sidebarClosedOpen ? '▾' : '▸'} Closed accounts ({closed.length})
              </span>
            </div>
            {prefs.sidebarClosedOpen && closed.map(row)}
          </div>
        )}
      </div>
      <div className="sb-bottom">
        <button className="sb-add" onClick={actions.addAccountFlow}>
          <PlusIcon size={12} /> Add an account
        </button>
      </div>
      {ctxNode}
    </nav>
  );
}

function NavBtn({
  icon,
  label,
  active,
  onClick,
  badge,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: React.ReactNode;
}) {
  return (
    <button className={cx('sb-nav-btn', active && 'active')} onClick={onClick} aria-current={active ? 'page' : undefined}>
      <span className="ico">{icon}</span>
      {label}
      {badge && <span className="badge-wrap" style={{ marginLeft: 'auto' }}>{badge}</span>}
    </button>
  );
}
