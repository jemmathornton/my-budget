// Development helper: opens the built app on a COPY of a budget file and saves
// screenshots, so layout changes can be checked at the real window size.
//
//   node scripts/shot.mjs <budget file> <output folder> [width height]
//
// The budget is copied first; the original file is never opened by the app.
import { _electron as electron } from '@playwright/test';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [, , source, outDir, w, h] = process.argv;
if (!source || !outDir) {
  console.error('usage: node scripts/shot.mjs <budget file> <output folder> [width height]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), 'mybudget-shot-'));
const copy = path.join(work, path.basename(source));
copyFileSync(source, copy);

const app = await electron.launch({
  args: ['.', copy],
  env: { ...process.env, MYBUDGET_USER_DATA: path.join(work, 'userdata') },
});
const win = await app.firstWindow();
if (w && h) {
  await app.evaluate(({ BrowserWindow }, [width, height]) => {
    const bw = BrowserWindow.getAllWindows()[0];
    bw.unmaximize();
    bw.setContentSize(width, height);
  }, [+w, +h]);
}
await win.waitForSelector('.bgrid', { timeout: 30000 });
await win.waitForTimeout(1200);
const size = await win.evaluate(() => [window.innerWidth, window.innerHeight, window.devicePixelRatio]);
console.log('viewport', size.join(' x '));
// How far the budget screen has to scroll (0 = everything fits).
const overflow = await win.evaluate(() => {
  const el = document.querySelector('.budget-scroll');
  return el ? [el.scrollHeight - el.clientHeight, el.scrollWidth - el.clientWidth] : null;
});
console.log('budget overflow (down, across):', overflow?.join(', '));
await win.screenshot({ path: path.join(outDir, 'budget.png') });

// Optional extra screens, given as JSON in SHOT_STEPS: [{ "click": "selector", "wait": ms, "shot": "name" }]
for (const step of JSON.parse(process.env.SHOT_STEPS || '[]')) {
  if (step.click) await win.click(step.click);
  if (step.press) await win.keyboard.press(step.press);
  await win.waitForTimeout(step.wait ?? 600);
  if (step.shot) await win.screenshot({ path: path.join(outDir, step.shot + '.png') });
}
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await app.close();
console.log('saved to', outDir, 'work copy in', work, errors.length ? '\nerrors: ' + errors.join('\n') : '');
