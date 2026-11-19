// The indexed payee lookup used by imports must give exactly the same answers as the scans.
import { describe, expect, it } from 'vitest';
import { findPayeeByName, matchPayeeRules, payeeMatcher } from '../../src/model/queries';
import type { Budget, PayeeRule } from '../../src/model/types';
import { standardBudget } from './fixtures';

function withRules(rules: [string, PayeeRule][]): Budget {
  const { b } = standardBudget();
  rules.forEach(([name, rule], i) => {
    const id = 'p' + i;
    b.payees[id] = { id, name, rules: [rule] };
  });
  return b;
}

describe('payeeMatcher', () => {
  it('prefers an exact rule, then the longest matching text, then the first payee', () => {
    const b = withRules([
      ['Tesco', { op: 'contains', text: 'tesco' }],
      ['Tesco Stores', { op: 'contains', text: 'tesco stores' }],
      ['Tesco Exact', { op: 'is', text: 'TESCO STORES 1234' }],
      ['Also Tesco', { op: 'contains', text: 'tesco' }],
      ['Shop', { op: 'startsWith', text: 'shop' }],
      ['Card', { op: 'endsWith', text: 'gb' }],
    ]);
    const m = payeeMatcher(b);
    for (const text of ['TESCO STORES 1234', 'TESCO STORES 99', 'tesco express', 'SHOP ONE', 'CAFE LONDON GB', 'NOTHING', '', '  ']) {
      expect(m.matchRules(text)).toEqual(matchPayeeRules(b, text));
    }
    expect(m.matchRules('TESCO STORES 1234')).toEqual({ payeeId: 'p2' });
    expect(m.matchRules('tesco express')).toEqual({ payeeId: 'p0' });
  });

  it('finds payees by name like findPayeeByName, ignoring transfer payees', () => {
    const { b } = standardBudget();
    b.payees.a = { id: 'a', name: 'Corner Shop', rules: [] };
    const m = payeeMatcher(b);
    for (const name of ['corner shop', ' Corner Shop ', 'Transfer : Savings', 'nobody', '']) {
      expect(m.findByName(name)).toBe(findPayeeByName(b, name));
    }
  });
});

