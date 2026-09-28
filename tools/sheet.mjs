// Contact sheets for reviewing a render at a glance: one thumbnail every N seconds,
// tiled 6 x 5 per sheet (30 thumbnails = 15 s at the default 0.5 s step).
//
//   node tools/sheet.mjs <video.mp4> [--every 0.5] [--width 320] [--out out/sheets]
//
// Read the sheets in order; then pull full-size stills (npm run still) for any
// moment that looks off — thumbnails hide small text and HUD collisions.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const video = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
if (!video) { console.log('usage: node tools/sheet.mjs <video.mp4> [--every 0.5] [--width 320] [--out out/sheets]'); process.exit(1); }
const every = +arg('every', 0.5);
const width = +arg('width', 320);
const out = arg('out', join('out', 'sheets'));
const frames = join(out, 'frames');
rmSync(out, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });
const run = (a) => {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...a], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + a.join(' '));
};
run(['-i', video, '-vf', `fps=${(1 / every).toFixed(4)},scale=${width}:-1`, join(frames, 'f_%04d.jpg')]);
const n = readdirSync(frames).length;
const per = 30;
for (let s = 0; s * per < n; s++) {
  const file = join(out, `sheet_${String(s).padStart(2, '0')}.jpg`);
  run(['-start_number', String(s * per + 1), '-i', join(frames, 'f_%04d.jpg'), '-frames:v', '1', '-vf', 'tile=6x5:color=black', file]);
  console.log(`${file}  (${(s * per * every).toFixed(1)}s – ${(Math.min(n, (s + 1) * per) * every).toFixed(1)}s)`);
}
