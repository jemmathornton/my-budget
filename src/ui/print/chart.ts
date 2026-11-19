import type { PrintChart } from './doc';

// The open report's chart for its printout (1.5.2 draft): the chart as drawn on screen, without
// the hover band or dimming, with the legend's shown items (or the spending list's swatches).
// Its colours are the reports' variables (var(--rp-c1)…), which the printed page gives their
// light-theme values whichever theme is on screen.

export function captureChart(root: ParentNode | null): PrintChart | null {
  const svg = root?.querySelector<SVGSVGElement>('svg.rp-svg, .rp-donut svg');
  if (!root || !svg) return null;
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.querySelectorAll('.rp-band').forEach((e) => e.remove());
  copy.querySelectorAll('.dim').forEach((e) => e.classList.remove('dim'));
  for (const a of ['tabindex', 'role', 'aria-label', 'aria-hidden', 'style']) copy.removeAttribute(a);
  if (!copy.getAttribute('viewBox')) copy.setAttribute('viewBox', `0 0 ${svg.getAttribute('width')} ${svg.getAttribute('height')}`);
  const legend: PrintChart['legend'] = [];
  root.querySelectorAll<HTMLElement>('.rp-swatch').forEach((sw) => {
    if (sw.closest('.off')) return;
    const item = sw.closest('.rp-legend-item');
    const label = item
      ? item.querySelector('.rp-legend-label')?.textContent
      : sw.closest('tr')?.querySelector('.rp-name')?.firstChild?.textContent;
    const color = sw.style.borderColor || sw.style.backgroundColor;
    // Rows folded into the doughnut's "Other" share its grey: list it once.
    const name = color.includes('--rp-other') ? 'Other' : label;
    if (name && !legend.some((l) => l.label === name && l.color === color)) legend.push({ label: name, color, line: sw.classList.contains('line') });
  });
  const centre = root.querySelector('.rp-donut-centre');
  const caption = centre ? [...centre.children].map((e) => e.textContent?.trim()).filter(Boolean).join(' · ') || undefined : undefined;
  return { svg: new XMLSerializer().serializeToString(copy), legend, caption };
}
