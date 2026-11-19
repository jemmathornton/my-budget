import { Component, type ReactNode } from 'react';
import { saveOrBackUp } from '../state/persistence';
import { prefStore } from '../state/ui';

// If drawing a screen fails, show what happened and a way out, instead of a blank window.
// "Close this budget" also stops the app reopening it at start-up, so a budget that makes a
// screen fail can't lock the app in a loop.

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error(error);
  }

  private async leave(closeBudget: boolean) {
    // The budget itself is fine (only drawing failed): save it, or keep it as a backup.
    await saveOrBackUp();
    if (closeBudget) prefStore.set({ lastBudgetPath: undefined });
    location.reload();
  }

  override render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return (
      <div className="home">
        <div className="home-card" role="alert">
          <h2 style={{ marginTop: 0 }}>Something went wrong showing this screen</h2>
          <p>
            Your budget is saved (or, if it couldn't be, kept as a backup in Settings › File and backups). Reload to carry
            on, or close this budget to get back to the start screen.
          </p>
          <pre className="hint" style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>
            {e.message}
          </pre>
          <div className="home-actions">
            <button className="btn primary" onClick={() => void this.leave(false)}>
              Reload
            </button>
            <button className="btn" onClick={() => void this.leave(true)}>
              Close this budget
            </button>
          </div>
        </div>
      </div>
    );
  }
}
