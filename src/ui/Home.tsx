import { useEffect, useState } from 'react';
import type { RecentBudget } from '../shared/api';
import * as actions from './actions';
import { Logo } from './common/icons';

// The start screen, shown when no budget is open.

export function Home() {
  const [recent, setRecent] = useState<RecentBudget[] | null>(null);
  const [found, setFound] = useState<string[]>([]);
  const load = () => void window.api.recentBudgets().then(setRecent);
  useEffect(load, []);
  useEffect(() => void window.api.findBudgetsInDocuments().then(setFound), []);
  const known = new Set((recent || []).map((r) => r.path.toLowerCase()));
  const suggestions = found.filter((p) => !known.has(p.toLowerCase()));
  return (
    <div className="home">
      <div className="home-card">
        <div className="home-logo">
          <Logo size={26} /> My Budget
        </div>
        <div className="home-tag">A private envelope budget in the spirit of YNAB4. Everything stays on this computer.</div>
        <div className="home-actions">
          <button className="btn primary" onClick={() => void actions.openBudgetDialog()}>
            Open a budget file…
          </button>
          <button className="btn" onClick={() => void actions.newBudgetFlow()}>
            Start a new budget…
          </button>
          <button className="btn" onClick={actions.importYnab4Flow}>
            Import a YNAB4 budget…
          </button>
        </div>
        <div style={{ marginBottom: 12 }}>
          <button className="link small" onClick={actions.restoreFromBackupFlow}>
            Restore a budget from a backup…
          </button>
        </div>
        {recent && recent.length > 0 && (
          <div className="home-list">
            <h3 className="insp-sec-title" style={{ margin: '0 0 6px' }}>
              Recent budgets
            </h3>
            {recent.map((r) => (
              <div key={r.path} className="home-item">
                <button className="home-open" onClick={() => void actions.openPath(r.path)}>
                  <b>{r.name}</b>
                  <span className="path">{r.path}</span>
                </button>
                <button
                  className="icon-btn"
                  title="Remove from this list (the file is not deleted)"
                  onClick={async () => {
                    await window.api.removeRecentBudget(r.path);
                    load();
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        {suggestions.length > 0 && (
          <div className="home-list">
            <h3 className="insp-sec-title" style={{ margin: '0 0 6px' }}>
              Budgets in Documents\MyBudget
            </h3>
            {suggestions.map((p) => (
              <div key={p} className="home-item">
                <button className="home-open" onClick={() => void actions.openPath(p)}>
                  <b>{p.split(/[\\/]/).pop()!.replace(/\.budget$/i, '')}</b>
                  <span className="path">{p}</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
