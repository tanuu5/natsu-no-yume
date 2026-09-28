// Render every frame (cheaply) inside the page and stop at the first exception,
// printing the page-side stack. Much faster to debug than a crashed render, whose
// error loses the scene's stack frames on the way out of puppeteer.
//
//   node tools/check.mjs [--sub 2] [--from 0] [--to <frames>]
//
// Motion blur samples times slightly *before* a scene's start: guard anything that
// indexes arrays with (t - start), e.g. Math.max(0, t - T.in).
import { openReel } from './browser.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const Q = arg('q', '');
const reel = await openReel({ query: 'render=1' + (Q ? '&' + Q : '') });
const total = await reel.page.evaluate('window.reel.frames');
const sub = +arg('sub', 2);
const from = +arg('from', 0);
const to = Math.min(+arg('to', total), total);
const t0 = performance.now();
let bad = null;
for (let i = from; i < to; i++) {
  const err = await reel.page.evaluate(async (i, s) => {
    try { await window.reel.render(i, s); return null; } catch (e) { return String((e && e.stack) || e); }
  }, i, sub);
  if (err) { bad = { i, err }; break; }
}
await reel.close();
if (bad) {
  console.log(`frame ${bad.i} (t = ${(bad.i / 60).toFixed(3)} s) threw:\n${bad.err}`);
  process.exit(1);
}
console.log(`ok: frames ${from}..${to - 1} rendered without exceptions (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
