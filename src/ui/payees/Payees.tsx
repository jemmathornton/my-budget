import { useEffect, useMemo, useState } from 'react';
import { formatMoney } from '../../model/money';
import {
  deleteUnusedPayees,
  mergePayees,
  renamePayee,
  setPayeeAutoFill,
  setPayeeHidden,
  setPayeeRules,
} from '../../model/ops';
import { categoryLabel, payeeUsage } from '../../model/queries';
import type { Id, PayeeRule, PayeeRuleOp } from '../../model/types';
import { update, useBudget } from '../../state/store';
import { ui } from '../../state/ui';
import { choose, confirm, toast } from '../common/dialogs';
import { Autocomplete, MoneyInput } from '../common/inputs';
import { cx } from '../common/Money';
import { categoryOptions } from '../common/options';
import { AutoFillSwitches } from './AutoFillSwitches';
import { PayeeMerges } from './PayeeMerges';
import { suggestMerges } from '../../model/payeeMerge';

// Payees: rename, combine (old names become rename rules), rename rules for imports,
// the category/memo/amount filled in automatically, and hiding.

const OPS: Record<PayeeRuleOp, string> = {
  is: 'is',
  contains: 'contains',
  startsWith: 'starts with',
  endsWith: 'ends with',
};

export function Payees() {
  const b = useBudget();
  const [q, setQ] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [showTransfers, setShowTransfers] = useState(false);
  const [active, setActive] = useState<Id | null>(null);
  const [checked, setChecked] = useState<Set<Id>>(new Set());
  const [tab, setTab] = useState<'all' | 'merges'>('all');
  const usage = useMemo(() => payeeUsage(b), [b]);
  const merges = useMemo(() => suggestMerges(b), [b]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return Object.values(b.payees)
      .filter((p) => (showTransfers ? true : !p.transferAccountId))
      .filter((p) => showHidden || !p.hidden)
      .filter((p) => !s || p.name.toLowerCase().includes(s) || p.rules.some((r) => r.text.toLowerCase().includes(s)))
      .sort((x, y) => x.name.localeCompare(y.name));
  }, [b, q, showHidden, showTransfers]);
  const unused = useMemo(
    () => Object.values(b.payees).filter((p) => !p.transferAccountId && !usage.get(p.id)),
    [b, usage],
  );
  const selected = active ? b.payees[active] : undefined;

  const merge = async () => {
    const ids = [...checked].filter((id) => b.payees[id] && !b.payees[id].transferAccountId);
    if (ids.length < 2) return;
    const key = await choose(
      'Combine payees',
      'Which name should they all have? The other names are remembered (as rename rules if you typed them), so future imports find it.',
      ids.map((id) => ({ key: id, label: b.payees[id].name, kind: 'primary' as const })),
      'Cancel',
      640,
    );
    if (!key) return;
    update('Combine payees', (d) => mergePayees(d, ids, key, { learnTexts: true }));
    setChecked(new Set());
    setActive(key);
    toast(`Combined ${ids.length} payees`, 'ok');
  };

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Payees</h1>
        <div className="seg" role="tablist" aria-label="Payees view">
          <button role="tab" aria-selected={tab === 'all'} className={cx('seg-btn', tab === 'all' && 'on')} onClick={() => setTab('all')}>
            All payees
          </button>
          <button role="tab" aria-selected={tab === 'merges'} className={cx('seg-btn', tab === 'merges' && 'on')} onClick={() => setTab('merges')}>
            Suggested merges ({merges.length})
          </button>
        </div>
        {tab === 'all' && (
          <>
          <input
            placeholder="Search payees and rules"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: 240 }}
            aria-label="Search payees"
          />
          <label className="check small">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show hidden
          </label>
          <label className="check small">
            <input type="checkbox" checked={showTransfers} onChange={(e) => setShowTransfers(e.target.checked)} /> Show
            transfer payees
          </label>
          <span className="grow" />
          {checked.size >= 2 && (
            <button className="btn small primary" onClick={() => void merge()}>
              Combine {checked.size} payees…
            </button>
          )}
          {unused.length > 0 && (
            <button
              className="btn small"
              onClick={async () => {
                if (
                  !(await confirm(
                    'Delete unused payees',
                    `Delete ${unused.length} payees that no transaction uses? Their rename rules go too.`,
                    'Delete',
                    true,
                  ))
                )
                  return;
                let n = 0;
                update('Delete unused payees', (d) => {
                  n = deleteUnusedPayees(
                    d,
                    unused.map((p) => p.id),
                  );
                });
                toast(`Deleted ${n} unused payees`, 'ok');
              }}
            >
              Delete {unused.length} unused
            </button>
          )}
          </>
        )}
      </div>
      {tab === 'merges' ? (
        <div className="screen-body">
          <PayeeMerges groups={merges} />
        </div>
      ) : (
      <div className="screen-body" style={{ flexDirection: 'row', overflow: 'hidden' }}>
        <div className="card flush" style={{ width: 380, flex: 'none', overflowY: 'auto', margin: 0 }}>
          {list.map((p) => (
            <div
              key={p.id}
              className={cx('plist-row', active === p.id && 'active')}
              style={{ opacity: p.hidden ? 0.55 : 1 }}
              onClick={() => setActive(p.id)}
            >
              <span style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                {!p.transferAccountId && (
                  <input
                    type="checkbox"
                    checked={checked.has(p.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => {
                      const n = new Set(checked);
                      if (n.has(p.id)) n.delete(p.id);
                      else n.add(p.id);
                      setChecked(n);
                    }}
                    aria-label={'Select ' + p.name}
                  />
                )}
                <span className="acc-name">{p.name}</span>
              </span>
              <span className="muted small">{usage.get(p.id) || 0}</span>
            </div>
          ))}
          {list.length === 0 && <div className="empty">No payees match.</div>}
        </div>
        <div style={{ flex: 1, maxWidth: 640, overflowY: 'auto', minHeight: 0 }}>
          {selected ? (
            <PayeeDetail key={selected.id} id={selected.id} uses={usage.get(selected.id) || 0} />
          ) : (
            <div className="hint">Choose a payee to edit it.</div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

function PayeeDetail({ id, uses }: { id: Id; uses: number }) {
  const b = useBudget();
  const p = b.payees[id];
  const [name, setName] = useState(p?.name ?? '');
  const [rules, setRules] = useState<PayeeRule[]>(p?.rules ?? []);
  useEffect(() => setRules(p?.rules ?? []), [p?.rules]);
  // Changed elsewhere (Undo, say): the box follows, or leaving it would rename it back (1.5.3).
  useEffect(() => setName(p?.name ?? ''), [p?.name]);
  const catOpts = useMemo(() => categoryOptions(b, { uncategorized: true }), [b]);
  if (!p) return null;
  const isTransfer = !!p.transferAccountId;
  const saveRules = (next: PayeeRule[]) => {
    setRules(next);
    update('Payee rename rules', (d) => setPayeeRules(d, id, next));
  };
  const txIds = () =>
    Object.values(b.transactions)
      .filter((t) => t.payeeId === id)
      .map((t) => t.id);
  return (
    <div className="card">
      <label className="field">
        <span className="field-label">Name</span>
        <input
          value={name}
          disabled={isTransfer}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (!name.trim() || name === p.name) return;
            const clash = Object.values(b.payees).find(
              (x) => x.id !== id && !x.transferAccountId && x.name.toLowerCase() === name.trim().toLowerCase(),
            );
            if (clash) {
              void confirm(
                'Combine payees',
                `There is already a payee called "${clash.name}". Combine them?`,
                'Combine',
              ).then((ok) => {
                if (ok) update('Combine payees', (d) => mergePayees(d, [id, clash.id], clash.id));
                else setName(p.name);
              });
              return;
            }
            update('Rename payee', (d) => renamePayee(d, id, name));
          }}
        />
      </label>
      <div className="hint" style={{ marginTop: -6, marginBottom: 10 }}>
        Used by {uses} transaction{uses === 1 ? '' : 's'}.{' '}
        {uses > 0 && (
          <button
            className="link"
            onClick={() => ui.go({ view: 'account', id: 'all' }, { registerFilter: { ids: txIds(), label: p.name } })}
          >
            Show them
          </button>
        )}
      </div>

      {!isTransfer && (
        <>
          <div className="insp-sec-title">Fill in automatically for this payee</div>
          <div style={{ marginBottom: 8 }}>
            <AutoFillSwitches />
            <div className="hint">These switches are for all payees.</div>
          </div>
          <div className="row2">
            <label className="field">
              <span className="field-label">Category</span>
              <Autocomplete
                value={p.autoCategoryId ? categoryLabel(b, p.autoCategoryId) : ''}
                options={catOpts}
                placeholder="(none)"
                onChange={(_t, o) =>
                  update('Payee category', (d) => setPayeeAutoFill(d, id, { categoryId: o?.value || null }))
                }
              />
            </label>
            <label className="field">
              <span className="field-label">Amount</span>
              <MoneyInput
                value={p.autoAmount ?? 0}
                onCommit={(v) => update('Payee amount', (d) => setPayeeAutoFill(d, id, { amount: v || null }))}
              />
            </label>
          </div>
          <label className="field">
            <span className="field-label">Memo</span>
            <input
              // A new box when the memo changes elsewhere (Undo), so it shows the memo as it is now (1.5.3).
              key={p.autoMemo ?? ''}
              defaultValue={p.autoMemo ?? ''}
              onBlur={(e) =>
                e.target.value !== (p.autoMemo ?? '') &&
                update('Payee memo', (d) => setPayeeAutoFill(d, id, { memo: e.target.value || null }))
              }
            />
          </label>
          <div className="hint" style={{ marginTop: -6, marginBottom: 10 }}>
            These update by themselves each time you use the payee
            {p.autoAmount ? ` (last amount ${formatMoney(p.autoAmount)})` : ''}.
          </div>
          <label className="check" style={{ marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={!!p.noGuess}
              onChange={(e) =>
                update('Payee guessing', (d) => {
                  if (e.target.checked) d.payees[id].noGuess = true;
                  else delete d.payees[id].noGuess;
                })
              }
            />
            Don't guess a category for this payee when importing (for a cash machine, say)
          </label>
          <label className="check" style={{ marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={!!p.noMerge}
              onChange={(e) =>
                update('Payee merging', (d) => {
                  if (e.target.checked) d.payees[id].noMerge = true;
                  else delete d.payees[id].noMerge;
                })
              }
            />
            Never suggest merging this payee with others
          </label>
          {!!p.bankTexts?.length && (
            <details style={{ marginBottom: 10 }}>
              <summary>Learned bank texts ({p.bankTexts.length})</summary>
              <div className="hint" style={{ margin: '4px 0' }}>
                Bank texts from payees merged into this one. Imports with these texts get this payee.
              </div>
              {p.bankTexts.map((t) => (
                <div key={t} className="learned-text">
                  <span>{t}</span>
                  <button
                    className="link small"
                    onClick={() =>
                      update('Forget a bank text', (d) => {
                        const left = (d.payees[id].bankTexts ?? []).filter((x) => x !== t);
                        if (left.length) d.payees[id].bankTexts = left;
                        else delete d.payees[id].bankTexts;
                      })
                    }
                  >
                    Forget
                  </button>
                </div>
              ))}
            </details>
          )}
        </>
      )}

      <div className="insp-sec-title">Rename imported transactions to "{p.name}" when the bank's text…</div>
      {rules.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
          <select
            value={r.op}
            onChange={(e) => {
              const next = rules.map((x, j) => (j === i ? { ...x, op: e.target.value as PayeeRuleOp } : x));
              // A rule with no text yet stays on screen only: saved, it would be dropped as blank (1.5.3).
              if (r.text.trim()) saveRules(next);
              else setRules(next);
            }}
            aria-label="Rule type"
          >
            {(Object.keys(OPS) as PayeeRuleOp[]).map((o) => (
              <option key={o} value={o}>
                {OPS[o]}
              </option>
            ))}
          </select>
          {/* Controlled, so removing a rule can't leave another rule's typing in this row's box. */}
          <input
            style={{ flex: 1 }}
            value={r.text}
            onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
            onBlur={() => r.text !== (p.rules[i]?.text ?? '') && saveRules(rules)}
            aria-label="Rule text"
          />
          <button className="icon-btn" title="Remove rule" onClick={() => saveRules(rules.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button className="btn small" onClick={() => setRules([...rules, { op: 'contains', text: '' }])}>
        + Add rule
      </button>

      {!isTransfer && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--line2)', paddingTop: 10 }}>
          <label className="check">
            <input
              type="checkbox"
              checked={!!p.hidden}
              onChange={(e) =>
                update(e.target.checked ? 'Hide payee' : 'Unhide payee', (d) => setPayeeHidden(d, id, e.target.checked))
              }
            />
            Hidden (not suggested when typing a payee)
          </label>
          {p.locations && p.locations.length > 0 && (
            <div className="hint" style={{ marginTop: 6 }}>
              {p.locations.length} saved location(s) from YNAB4's mobile app.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
