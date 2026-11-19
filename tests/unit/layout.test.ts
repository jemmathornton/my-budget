import { describe, expect, it } from 'vitest';
import { CAT_MIN, GAP, MONTH_MAX, MONTH_MIN, PAD, SCROLLBAR, gridLayout } from '../../src/ui/budget/layout';

// The budget grid on the user's laptop: a maximised window is 1600 CSS px wide.
const SIDEBAR = 224;
const INSPECTOR = 248 + 10; // the panel and its margin

describe('budget grid layout', () => {
  it('shows three months at 1600px, filling the width with nothing to scroll sideways', () => {
    const available = 1600 - SIDEBAR - PAD;
    const l = gridLayout(available, 0);
    expect(l.months).toBe(3);
    expect(l.width + SCROLLBAR).toBe(available);
    expect(l.monthWidth).toBeLessThanOrEqual(MONTH_MAX);
    // The spare width goes to the category names, not into gaps between the figures.
    expect(l.catWidth).toBeGreaterThanOrEqual(300);
  });

  it('still fits three months at 1600px with the inspector panel open', () => {
    const available = 1600 - SIDEBAR - INSPECTOR - PAD;
    const l = gridLayout(available, 0);
    expect(l.months).toBe(3);
    expect(l.width + SCROLLBAR).toBeLessThanOrEqual(available);
    expect(l.catWidth).toBeGreaterThanOrEqual(CAT_MIN);
  });

  it('always fills the width, so there is never an empty strip on the right', () => {
    for (const available of [900, 1100, 1356, 1600, 1900, 2400]) {
      const l = gridLayout(available, 0);
      expect(l.width + SCROLLBAR).toBe(available);
    }
  });

  it("never stretches months on a wide screen, so the figures don't drift apart", () => {
    for (const available of [1800, 2400, 3200]) {
      const l = gridLayout(available, 0);
      expect(l.monthWidth).toBeLessThanOrEqual(MONTH_MAX);
      expect(l.months).toBeLessThanOrEqual(5);
    }
    expect(gridLayout(1300, 2).monthWidth).toBe(MONTH_MAX);
  });

  it('counts the gap before each month', () => {
    const l = gridLayout(1356, 3);
    expect(l.width).toBe(l.catWidth + 3 * (l.monthWidth + GAP));
  });

  it('keeps one month with minimum sizes in a narrow window', () => {
    const l = gridLayout(500, 0);
    expect(l.months).toBe(1);
    expect(l.catWidth).toBeGreaterThanOrEqual(CAT_MIN);
    expect(l.monthWidth).toBeGreaterThanOrEqual(MONTH_MIN);
  });
});
