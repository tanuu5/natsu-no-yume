// Render individual moments to PNG for inspection.
// usage: node tools/still.mjs <outDir> <t1> [t2 ...] [--sub 16]
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openReel } from './browser.mjs';

const args = process.argv.slice(2);
let sub = 16;
const si = args.indexOf('--sub');
if (si >= 0) { sub = +args[si + 1]; args.splice(si, 2); }
// extra page query, e.g. --q "view=boat" (debug views of the world)
let q = '';
const qi = args.indexOf('--q');
if (qi >= 0) { q = args[qi + 1]; args.splice(qi, 2); }
const [outDir, ...times] = args;
await mkdir(outDir, { recursive: true });
const reel = await openReel({ query: 'render=1' + (q ? '&' + q : '') });
console.log('renderer:', reel.renderer);
for (const t of times) {
  const t0 = performance.now();
  const url = await reel.page.evaluate((t, sub) => window.reel.still(t, sub), +t, sub);
  const file = join(outDir, `t${(+t).toFixed(3).padStart(7, '0')}.png`);
  await writeFile(file, Buffer.from(url.split(',')[1], 'base64'));
  console.log(file, `${(performance.now() - t0).toFixed(0)}ms`);
}
await reel.close();
