import { useState } from 'react';
import { serializeBudget } from '../../model/budget';
import { dismissMerge, keepSeparate, mergePayeeGroups, type MergeGroup } from '../../model/payeeMerge';
import { categoryLabel } from '../../model/queries';
import type { Id } from '../../model/types';
import { store, update, useBudget } from '../../state/store';
import { choose, openModal, toast } from '../common/dialogs';
import { cx } from '../common/Money';
import { Modal } from '../common/overlay';
import * as actions from '../actions';

// The Payees screen's "Suggested merges" tab (1.3.1): payees that look like the same shop or
// person, offered to be combined. Nothing is merged without a preview and a click.

const shownKey = (k: string) => (k.startsWith('person:') ? k.slice(7) : k.startsWith('bank:') ? "the bank's " + k.split(':')[1] : k);

export function PayeeMerges({ groups }: { groups: MergeGroup[] }) {
  const b = useBudget();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<'payees' | 'transactions'>('payees');
  const nameOf = (g: MergeGroup) => names[g.key] ?? g.name;
  const list = [...groups].sort((x, y) =>
    sort === 'payees' ? y.payeeIds.length - x.payeeIds.length || y.transactions - x.transactions : y.transactions - x.transactions,
  );
  const chosen = list.filter((g) => ticked.has(g.key));
  const payees = groups.reduce((n, g) => n + g.payeeIds.length, 0);

  const merge = async (gs: MergeGroup[]) => {
    if (!gs.length) return;
    const ids = new Set(gs.flatMap((g) => g.payeeIds));
    const scheduled = Object.values(b.scheduled).filter((s) => s.payeeId && ids.has(s.payeeId)).length;
    const rules = gs.reduce((n, g) => n + g.payeeIds.slice(1).reduce((m, id) => m + (b.payees[id]?.rules.length ?? 0), 0), 0);
    const one = gs.length === 1 ? gs[0] : null;
    const r = await choose(
      one ? `Merge ${one.payeeIds.length} payees into "${nameOf(one)}"` : `Merge ${gs.length} groups (${ids.size} payees)`,
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        <li>
          {gs.reduce((n, g) => n + g.transactions, 0)} transactions{scheduled ? ` and ${scheduled} scheduled transactions` : ''} move to the payee
          that is kept{one ? '' : ' in each group'}.
        </li>
        <li>Their bank texts are remembered, so future imports find it.</li>
        {rules > 0 && <li>{rules} rename rules you wrote carry over.</li>}
        <li>Categories don't change.</li>
        <li>A backup is made first, and Ctrl+Z undoes it.</li>
      </ul>,
      [{ key: 'merge', label: 'Merge', kind: 'primary' }],
      'Cancel',
      560,
    );
    if (r !== 'merge') return;
    const before = store.budget!;
    try {
      await window.api.createBackup(before.id, before.name, 'before-merge', serializeBudget(before));
    } catch (e) {
      toast("Couldn't make a backup first, so nothing was merged: " + (e instanceof Error ? e.message : String(e)), 'error');
      return;
    }
    update(`Merge payees (${gs.length} group${gs.length === 1 ? '' : 's'})`, (d) =>
      mergePayeeGroups(
        d,
        gs.map((g) => ({ payeeIds: g.payeeIds.filter((id) => d.payees[id]), name: nameOf(g) })),
      ),
    );
    setTicked(new Set());
    toast(`Merged ${ids.size} payees into ${gs.length}`, 'ok', { label: 'Undo', fn: actions.undoThis() });
  };

  const separate = (g: MergeGroup) =>
    openModal((close) => <KeepSeparate group={g} onClose={close} />);

  if (!groups.length) {
    return (
      <div className="card">
        <div className="empty">No payees look like duplicates of each other. Suggestions appear here as imports add new ones.</div>
      </div>
    );
  }
  return (
    <div className="merges">
      <div className="toolbar" style={{ marginBottom: 8, alignItems: 'center' }}>
        <span>
          {groups.length} group{groups.length === 1 ? '' : 's'} would combine {payees} payees into {groups.length}.
        </span>
        <span className="grow" />
        <label className="field-inline small">
          Sort{' '}
          <select className="small" value={sort} onChange={(e) => setSort(e.target.value as 'payees' | 'transactions')}>
            <option value="payees">Most payees</option>
            <option value="transactions">Most transactions</option>
          </select>
        </label>
        <button className="btn small" onClick={() => setTicked(ticked.size === groups.length ? new Set() : new Set(groups.map((g) => g.key)))}>
          {ticked.size === groups.length ? 'Untick all' : 'Tick all'}
        </button>
        <button className="btn small primary" disabled={!chosen.length} onClick={() => void merge(chosen)}>
          Merge {chosen.length || ''} ticked…
        </button>
      </div>
      {list.map((g) => {
        const showAll = open.has(g.key);
        const texts = showAll ? g.texts : g.texts.slice(0, 3);
        return (
          <div key={g.key} className={cx('card merge-card', ticked.has(g.key) && 'ticked')}>
            <div className="merge-head">
              <label className="check">
                <input
                  type="checkbox"
                  checked={ticked.has(g.key)}
                  onChange={() => {
                    const n = new Set(ticked);
                    if (n.has(g.key)) n.delete(g.key);
                    else n.add(g.key);
                    setTicked(n);
                  }}
                  aria-label={`Merge "${shownKey(g.key)}"`}
                />
                <b>"{shownKey(g.key)}"</b>
              </label>
              <span className="muted">
                {g.payeeIds.length} payees · {g.transactions} transactions
                {g.fresh ? ` · ${g.fresh.length} new since "Not now"` : ''}
              </span>
              <span className="grow" />
              <label className="field-inline small">
                Name{' '}
                <input
                  value={nameOf(g)}
                  onChange={(e) => setNames({ ...names, [g.key]: e.target.value })}
                  aria-label={`Name for "${shownKey(g.key)}"`}
                  style={{ width: 260 }}
                />
              </label>
            </div>
            <div className="merge-line">
              <span className="muted">Bank texts:</span>{' '}
              {texts.map((t, i) => (
                <span key={t.text}>
                  {i > 0 && ' · '}
                  {t.text} ({t.n})
                </span>
              ))}
              {g.texts.length > 3 && (
                <>
                  {' '}
                  <button
                    className="link small"
                    onClick={() => {
                      const n = new Set(open);
                      if (n.has(g.key)) n.delete(g.key);
                      else n.add(g.key);
                      setOpen(n);
                    }}
                  >
                    {showAll ? 'fewer' : `…${g.texts.length - 3} more`}
                  </button>
                </>
              )}
            </div>
            <div className="merge-line">
              <span className="muted">Categories:</span>{' '}
              {g.categories.length
                ? g.categories
                    .slice(0, 4)
                    .map((c) => `${categoryLabel(b, c.categoryId)} ${c.n}`)
                    .join(' · ')
                : 'none'}
              <span className="grow" />
              <button className="btn small" onClick={() => void merge([g])}>
                Preview…
              </button>
              <button className="btn small" title="Hide this until another payee joins it" onClick={() => update('Not now', (d) => dismissMerge(d, g))}>
                Not now
              </button>
              <button className="btn small" onClick={() => separate(g)}>
                Keep separate…
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Picks payees of a group never to offer for merging again. */
function KeepSeparate({ group, onClose }: { group: MergeGroup; onClose: () => void }) {
  const b = useBudget();
  const [sel, setSel] = useState<Set<Id>>(new Set());
  return (
    <Modal
      title={`Keep separate: "${shownKey(group.key)}"`}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!sel.size}
            onClick={() => {
              update('Keep payees separate', (d) => keepSeparate(d, [...sel]));
              onClose();
            }}
          >
            Keep {sel.size || ''} separate
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>Tick the payees that should never be offered for merging. The rest stay suggested.</p>
      {group.payeeIds.map((id) =>
        b.payees[id] ? (
          <label key={id} className="check" style={{ display: 'flex', marginBottom: 4 }}>
            <input
              type="checkbox"
              checked={sel.has(id)}
              onChange={() => {
                const n = new Set(sel);
                if (n.has(id)) n.delete(id);
                else n.add(id);
                setSel(n);
              }}
            />
            {b.payees[id].name}
          </label>
        ) : null,
      )}
    </Modal>
  );
}
