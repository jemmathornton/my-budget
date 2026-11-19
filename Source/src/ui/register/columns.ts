// Register column layout, shared by the rows, the header and the editor so they line up.

export interface RegisterColumns {
  account: boolean;
  check: boolean;
  balance: boolean;
}

export type ColKey = 'sel' | 'flag' | 'account' | 'check' | 'date' | 'payee' | 'category' | 'memo' | 'outflow' | 'inflow' | 'balance' | 'cleared';

const WIDTHS: Record<ColKey, string> = {
  sel: '28px',
  flag: '24px',
  account: 'minmax(110px, 0.75fr)',
  check: '66px',
  date: '100px',
  payee: 'minmax(140px, 1.15fr)',
  category: 'minmax(150px, 1.3fr)',
  memo: 'minmax(100px, 1fr)',
  outflow: '96px',
  inflow: '96px',
  balance: '104px',
  cleared: '34px',
};

export function columnKeys(c: RegisterColumns): ColKey[] {
  const keys: ColKey[] = ['sel', 'flag'];
  if (c.account) keys.push('account');
  if (c.check) keys.push('check');
  keys.push('date', 'payee', 'category', 'memo', 'outflow', 'inflow');
  if (c.balance) keys.push('balance');
  keys.push('cleared');
  return keys;
}

export function gridTemplate(c: RegisterColumns): string {
  return columnKeys(c)
    .map((k) => WIDTHS[k])
    .join(' ');
}
