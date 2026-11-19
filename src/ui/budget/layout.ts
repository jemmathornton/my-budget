// Works out how many months fit and how wide the columns are.
//
// Tuned for the user's laptop (1600 x 1000 at 200%, so a maximised window is 1600 x 952).
// With the sidebar (224) the budget area is 1376px; after its padding and a scrollbar
// that leaves about 1346px, which fits three months of 330px with an 8px gap before
// each, and a category column of about 330px. The grid always fills the width: months
// never grow past MONTH_MAX (so the figures in a month stay close together) and the
// category column takes whatever is left, so there's never an empty strip on the right.

export const CAT_MIN = 190;
export const CAT_IDEAL = 230;
export const MONTH_MIN = 286;
export const MONTH_MAX = 330;
export const MAX_MONTHS = 5;
/** Gap between the category column and each month (each month is its own panel, as in YNAB4). */
export const GAP = 8;
/** Horizontal padding around the grid (left + right). */
export const PAD = 20;
/** Room for the vertical scrollbar. */
export const SCROLLBAR = 10;

export interface GridLayout {
  months: number;
  catWidth: number;
  monthWidth: number;
  /** Total grid width including gaps. */
  width: number;
}

/**
 * @param available  width inside the budget area's padding, in CSS pixels
 * @param wanted     months the user asked for (0 = as many as fit)
 */
export function gridLayout(available: number, wanted: number): GridLayout {
  const usable = Math.max(0, available - SCROLLBAR);
  const fit = Math.max(1, Math.min(MAX_MONTHS, Math.floor((usable - CAT_MIN) / (MONTH_MIN + GAP))));
  const months = wanted > 0 ? Math.min(MAX_MONTHS, wanted) : fit;
  let monthWidth = Math.floor((usable - CAT_IDEAL - months * GAP) / months);
  monthWidth = Math.max(MONTH_MIN, Math.min(MONTH_MAX, monthWidth));
  const catWidth = Math.max(CAT_MIN, usable - months * (monthWidth + GAP));
  return { months, catWidth, monthWidth, width: catWidth + months * (monthWidth + GAP) };
}
