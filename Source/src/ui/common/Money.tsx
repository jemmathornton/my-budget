import { formatMoney } from '../../model/money';
import type { Money as MoneyValue } from '../../model/types';

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

/** An amount of money. `colored` shows negatives red and positives green; zero is greyed. */
export function Money({
  v,
  colored,
  negRed,
  blankZero,
  plus,
  className,
}: {
  v: MoneyValue;
  colored?: boolean;
  /** Only negatives in red. */
  negRed?: boolean;
  blankZero?: boolean;
  plus?: boolean;
  className?: string;
}) {
  const tone = colored ? (v < 0 ? 'neg' : v > 0 ? 'pos' : 'zero') : negRed && v < 0 ? 'neg' : undefined;
  return <span className={cx('money', tone, className)}>{formatMoney(v, { blankZero, plus })}</span>;
}
