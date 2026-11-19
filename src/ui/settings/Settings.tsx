import { useEffect, useState } from 'react';
import { serializeBudget } from '../../model/budget';
import { formatDate } from '../../model/dates';
import { CURRENCY_PRESETS, formatMoney } from '../../model/money';
import { renameBudget } from '../../model/ops';
import type { BudgetSettings, Currency, DateFormat } from '../../model/types';
import type { BackupCopyInfo, BackupInfo } from '../../shared/api';
import { restoreBackup, useSaveStatus } from '../../state/persistence';
import { update, useBudget } from '../../state/store';
import { prefStore, usePrefs, type Theme } from '../../state/ui';
import * as actions from '../actions';
import { confirm, toast } from '../common/dialogs';
import { BACKUP_KIND_LABEL } from '../common/backupLabels';
import { cx } from '../common/Money';
import { AutoFillSwitches } from '../payees/AutoFillSwitches';

export function Settings() {
  const b = useBudget();
  const prefs = usePrefs();
  const save = useSaveStatus();
  const [name, setName] = useState(b.name);
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [backupsRoot, setBackupsRoot] = useState('');
  useEffect(() => setName(b.name), [b.name]);
  const loadBackups = () => void window.api.listBackups(b.id).then(setBackups);
  useEffect(loadBackups, [b.id]);
  useEffect(() => void window.api.backupsRoot().then(setBackupsRoot), []);
  const [copy, setCopy] = useState<BackupCopyInfo | null>(null);
  useEffect(() => void window.api.backupCopy().then(setCopy), []);

  const setCurrency = (c: Currency) => update('Change currency', (d) => void (d.currency = { ...c }));
  const setSetting = <K extends keyof BudgetSettings>(k: K, v: BudgetSettings[K]) =>
    update('Change budget setting', (d) => {
      d.settings[k] = v;
    });
  const presetKey = (c: Currency) => `${c.code}|${c.locale}|${c.symbolFirst}`;
  const currentKey = presetKey(b.currency);

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Settings</h1>
      </div>
      <div className="screen-body">
        <div className="settings">
          <section className="card">
            <h2>This budget</h2>
            <div className="row2">
              <label className="field">
                <span className="field-label">Budget name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => name.trim() && name !== b.name && update('Rename budget', (d) => renameBudget(d, name))}
                />
              </label>
              <label className="field">
                <span className="field-label">Date format</span>
                <select
                  value={b.dateFormat}
                  onChange={(e) =>
                    update('Change date format', (d) => void (d.dateFormat = e.target.value as DateFormat))
                  }
                >
                  {(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD.MM.YYYY'] as DateFormat[]).map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="row2">
              <label className="field">
                <span className="field-label">Currency</span>
                <select
                  value={CURRENCY_PRESETS.some((c) => presetKey(c) === currentKey) ? currentKey : 'custom'}
                  onChange={(e) => {
                    const c = CURRENCY_PRESETS.find((x) => presetKey(x) === e.target.value);
                    if (c) setCurrency(c);
                  }}
                >
                  {CURRENCY_PRESETS.map((c) => (
                    <option key={presetKey(c)} value={presetKey(c)}>
                      {c.code} {c.symbol} ({c.locale}, {c.symbolFirst ? 'symbol first' : 'symbol after'})
                    </option>
                  ))}
                  <option value="custom" disabled>
                    Custom
                  </option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Currency symbol</span>
                <input
                  value={b.currency.symbol}
                  onChange={(e) => setCurrency({ ...b.currency, symbol: e.target.value })}
                />
              </label>
            </div>
            <div className="hint" style={{ marginTop: -4, marginBottom: 10 }}>
              Example: {formatMoney(-123456)} and {formatMoney(9876543)} on {formatDate('2026-10-13')}
            </div>
            <label className="check" style={{ alignItems: 'flex-start', marginBottom: 8 }}>
              <input
                type="checkbox"
                checked={!!b.settings.creditOverspendingToDebt}
                onChange={(e) => setSetting('creditOverspendingToDebt', e.target.checked || undefined)}
              />
              <span>
                Treat credit card overspending as card debt (new YNAB style, not YNAB4)
                <div className="hint">
                  Off (the default) matches how your YNAB4 budgets behaved: all overspending, including on credit cards,
                  is taken from next month's Available to Budget.
                </div>
              </span>
            </label>
            <div style={{ marginBottom: 10 }}>
              <AutoFillSwitches />
              <div className="hint">
                As in YNAB4, only the category is filled in unless you switch on the others. Each payee's remembered
                values are on the Payees screen.
              </div>
            </div>
            <div className="row2">
              <label className="field">
                <span className="field-label">Match imported transactions to ones you typed in within</span>
                <select value={b.settings.matchDays ?? 10} onChange={(e) => setSetting('matchDays', +e.target.value)}>
                  {[3, 5, 7, 10, 14, 21, 30].map((n) => (
                    <option key={n} value={n}>
                      {n} days
                    </option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ justifyContent: 'flex-end' }}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!!b.settings.autoApproveImports}
                    onChange={(e) => setSetting('autoApproveImports', e.target.checked || undefined)}
                  />
                  Approve imported transactions automatically
                </label>
              </label>
            </div>
            {b.importedFrom === 'YNAB4' && (
              <div className="toolbar" style={{ marginTop: 10, alignItems: 'center' }}>
                <button className="btn small" onClick={() => void actions.readYnab4DeletionsFlow()}>
                  Read deletions from YNAB4…
                </button>
                <span className="hint">
                  {b.settings.ynab4DeletionsReadAt
                    ? `Done on ${new Date(b.settings.ynab4DeletionsReadAt).toLocaleDateString('en-GB')}. Bank rows you deleted in YNAB4 are left out when importing.`
                    : 'Once only: lets the importer skip bank rows you deleted in YNAB4. Your YNAB4 files are only read.'}
                </span>
              </div>
            )}
            {b.importedFrom === 'YNAB4' && (
              <div className="toolbar" style={{ marginTop: 10, alignItems: 'center' }}>
                <button className="btn small" onClick={() => actions.learnAccountsFlow()}>
                  Learn accounts from old bank files…
                </button>
                <span className="hint">
                  {Object.values(b.accounts).some((a) => a.importKeys?.length)
                    ? 'Some accounts know their bank numbers already. More old files can still teach the others.'
                    : 'Before your first import: old downloads teach each account its bank number, so imports pick the account by themselves.'}
                </span>
              </div>
            )}
          </section>

          <section className="card">
            <h2>File and backups</h2>
            <p style={{ marginTop: 0 }}>
              Saved to <b>{save.path}</b>{' '}
              <button className="link" onClick={() => save.path && window.api.showInFolder(save.path)}>
                Show in folder
              </button>
            </p>
            <div className="toolbar" style={{ marginBottom: 10 }}>
              <button className="btn small" onClick={() => void actions.saveCopyFlow()}>
                Save a copy as…
              </button>
              <button className="btn small" onClick={() => void actions.downloadCopyFlow()}>
                Save a backup copy somewhere else…
              </button>
              <button className="btn small" onClick={() => void actions.exportCsvFlow()}>
                Export budget data (CSV)…
              </button>
              <button
                className="btn small"
                onClick={async () => {
                  try {
                    await window.api.createBackup(b.id, b.name, 'manual', serializeBudget(b));
                    toast('Backup made', 'ok');
                  } catch (e) {
                    toast("Couldn't make a backup: " + (e instanceof Error ? e.message : String(e)), 'error');
                  }
                  loadBackups();
                }}
              >
                Back up now
              </button>
            </div>
            <div className="field-label" style={{ marginBottom: 4 }}>
              Also copy daily backups somewhere else (a USB stick or another drive), so they survive if this laptop's disk fails
            </div>
            <div className="toolbar" style={{ marginBottom: 12, alignItems: 'center' }}>
              {copy?.folder ? (
                <>
                  <span>
                    Copying to <b>{copy.folder}</b>
                    {copy.lastError ? (
                      <span className="neg"> · last copy failed: {copy.lastError} (it tries again tomorrow, or when you choose the folder again)</span>
                    ) : copy.lastCopied ? (
                      <span className="hint"> · last copied {new Date(copy.lastCopied).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    ) : null}
                  </span>
                  <button className="btn small" onClick={async () => setCopy(await window.api.chooseBackupCopyFolder())}>
                    Change…
                  </button>
                  <button className="btn small" onClick={async () => setCopy(await window.api.stopBackupCopy())}>
                    Stop copying
                  </button>
                </>
              ) : (
                <>
                  <span className="hint">Not set up: backups are only on this laptop.</span>
                  <button className="btn small" onClick={async () => setCopy(await window.api.chooseBackupCopyFolder())}>
                    Choose a folder…
                  </button>
                </>
              )}
            </div>
            <div className="field-label" style={{ marginBottom: 4 }}>
              Backups (one each day you open or change the budget, kept for 30 days, plus one before anything drastic)
            </div>
            {backups && backups.length === 0 && <div className="hint">No backups yet. The first is made today.</div>}
            {backups && backups.length > 0 && (
              <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 4 }}>
                <table className="simple-table small">
                  <tbody>
                    {backups.map((x) => (
                      <tr key={x.file}>
                        <td className="nowrap">
                          {new Date(x.date).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                        </td>
                        <td>{BACKUP_KIND_LABEL[x.kind]}</td>
                        <td className="r muted">{Math.round(x.size / 1024).toLocaleString()} KB</td>
                        <td className="r">
                          <button
                            className="link"
                            onClick={async () => {
                              const ok = await confirm(
                                'Restore backup',
                                `Replace the budget with the backup from ${new Date(x.date).toLocaleString('en-GB')}? Your current version is backed up first, so you can go back.`,
                                'Restore',
                                true,
                              );
                              if (!ok) return;
                              try {
                                await restoreBackup(x.file);
                                toast('Backup restored', 'ok');
                              } catch (e) {
                                toast("Couldn't restore: " + (e instanceof Error ? e.message : String(e)), 'error');
                              }
                              loadBackups();
                            }}
                          >
                            Restore
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="hint" style={{ marginTop: 6 }}>
              Backups are kept in {backupsRoot}.{' '}
              <button className="link" onClick={() => void window.api.openBackupsFolder(b.id)}>
                Open folder
              </button>
            </div>
          </section>

          <section className="card">
            <h2>This computer</h2>
            <div className="row2">
              <label className="field">
                <span className="field-label">Theme</span>
                <div className="seg">
                  {(['light', 'dark', 'system'] as Theme[]).map((t) => (
                    <button key={t} className={cx(prefs.theme === t && 'on')} onClick={() => actions.setTheme(t)}>
                      {t === 'system' ? 'Match Windows' : t[0].toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>
              </label>
              <label className="field">
                <span className="field-label">Text size</span>
                <div className="seg">
                  {[0.9, 1, 1.1, 1.2].map((z) => (
                    <button
                      key={z}
                      className={cx(prefs.zoom === z && 'on')}
                      onClick={() => actions.zoom(z - prefs.zoom)}
                    >
                      {Math.round(z * 100)}%
                    </button>
                  ))}
                </div>
              </label>
            </div>
            <label className="field" style={{ maxWidth: 300 }}>
              <span className="field-label">Months on the budget screen</span>
              <select value={prefs.monthsShown} onChange={(e) => prefStore.set({ monthsShown: +e.target.value })}>
                <option value={0}>As many as fit</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="card">
            <h2>Start again</h2>
            <p style={{ marginTop: 0 }}>
              Fresh Start makes a new budget with your current account balances, categories, payees and scheduled
              transactions, but no history. This budget is kept as it is.
            </p>
            <button className="btn" onClick={actions.freshStartFlow}>
              Fresh Start…
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
