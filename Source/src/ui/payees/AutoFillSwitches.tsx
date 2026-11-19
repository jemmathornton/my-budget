import { autoFillOptions } from '../../model/queries';
import { update, useBudget } from '../../state/store';

// YNAB4's "Autocomplete (all payees)" switches: what choosing a payee fills in.

const PARTS = [
  ['category', 'Category'],
  ['memo', 'Memo'],
  ['amount', 'Amount'],
] as const;

export function AutoFillSwitches() {
  const b = useBudget();
  const fill = autoFillOptions(b);
  return (
    <div className="toolbar" style={{ alignItems: 'center', gap: 14 }}>
      <span>When you choose a payee, fill in its last:</span>
      {PARTS.map(([k, label]) => (
        <label key={k} className="check">
          <input
            type="checkbox"
            checked={fill[k]}
            onChange={(e) =>
              update('Change auto-fill', (d) => {
                d.settings.autoFill = { ...autoFillOptions(d), [k]: e.target.checked };
              })
            }
          />
          {label}
        </label>
      ))}
    </div>
  );
}
