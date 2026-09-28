// Top-down map of the generated geography (shaded relief, 5 m contours, features),
// for checking the layout without opening the browser.
//   node tools/map.mjs [--x0 -800 --x1 900 --z0 -1400 --z1 700 --px 2] [--out out/map.png]
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ground, sdLand, forestMask, paddyMask, villageMask, STREET, RAIL, STATION, COVE } from '../src/world/geo.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); if (i < 0) return d; const v = process.argv[i + 1]; return Number.isFinite(+v) ? +v : v; };
const x0 = arg('x0', -800), x1 = arg('x1', 900), z0 = arg('z0', -1400), z1 = arg('z1', 700), px = arg('px', 2);
const out = arg('out', 'out/map.png');
const Wd = Math.round((x1 - x0) / px), Hd = Math.round((z1 - z0) / px);
const hs = new Float32Array((Wd + 1) * (Hd + 1));
for (let j = 0; j <= Hd; j++) for (let i = 0; i <= Wd; i++) hs[j * (Wd + 1) + i] = ground(x0 + i * px, z0 + j * px);
const buf = Buffer.alloc(Wd * Hd * 3);
for (let j = 0; j < Hd; j++) {
  for (let i = 0; i < Wd; i++) {
    const x = x0 + i * px, z = z0 + j * px;
    const h = hs[j * (Wd + 1) + i];
    const hx = hs[j * (Wd + 1) + i + 1] - h, hz = hs[(j + 1) * (Wd + 1) + i] - h;
    // light from the north-west
    const nx = -hx / px, nz = -hz / px;
    const len = Math.hypot(nx, 1, nz);
    const shade = Math.max(0, (nx * -0.6 + 1 * 0.7 + nz * -0.4) / len);
    let r, g, b;
    if (h < 0) {
      const d = Math.min(1, -h / 25);
      r = 40 - 20 * d; g = 110 - 50 * d; b = 170 - 40 * d;
    } else {
      const f = forestMask(x, z, h), p = paddyMask(x, z), v = villageMask(x, z);
      r = 120 - 60 * f + 60 * v; g = 160 - 50 * f + 20 * v; b = 90 - 30 * f + 60 * v;
      if (p > 0.5) { r = 110; g = 170; b = 190; }
      r *= 0.55 + 0.6 * shade; g *= 0.55 + 0.6 * shade; b *= 0.55 + 0.6 * shade;
      // contour lines every 5 m, bold every 25 m
      const c5 = Math.floor(h / 5), cx = Math.floor(hs[j * (Wd + 1) + i + 1] / 5), cz = Math.floor(hs[(j + 1) * (Wd + 1) + i] / 5);
      if (c5 !== cx || c5 !== cz) { const k = c5 % 5 === 4 || cx % 5 === 4 ? 0.45 : 0.75; r *= k; g *= k; b *= k; }
    }
    const o = (j * Wd + i) * 3;
    buf[o] = Math.max(0, Math.min(255, r)); buf[o + 1] = Math.max(0, Math.min(255, g)); buf[o + 2] = Math.max(0, Math.min(255, b));
  }
}
const put = (x, z, c) => {
  const i = Math.round((x - x0) / px), j = Math.round((z - z0) / px);
  if (i < 0 || j < 0 || i >= Wd || j >= Hd) return;
  const o = (j * Wd + i) * 3; buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2];
};
const line = (pts, c) => {
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / (px * 0.5));
    for (let s = 0; s <= n; s++) put(ax + (bx - ax) * s / n, az + (bz - az) * s / n, c);
  }
};
line(STREET, [230, 40, 40]);
line(RAIL, [20, 20, 20]);
line([[-49, STATION.z0], [-44, STATION.z0], [-44, STATION.z1], [-49, STATION.z1]], [255, 220, 0]);
// grid every 100 m
for (let x = Math.ceil(x0 / 100) * 100; x <= x1; x += 100) for (let z = z0; z < z1; z += px) if (Math.floor(z / px) % 4 === 0) put(x, z, [255, 255, 255]);
for (let z = Math.ceil(z0 / 100) * 100; z <= z1; z += 100) for (let x = x0; x < x1; x += px) if (Math.floor(x / px) % 4 === 0) put(x, z, [255, 255, 255]);
put(0, 0, [255, 0, 255]);
mkdirSync('out', { recursive: true });
writeFileSync('out/map.ppm', Buffer.concat([Buffer.from(`P6\n${Wd} ${Hd}\n255\n`), buf]));
spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', 'out/map.ppm', out], { stdio: 'inherit' });
console.log('wrote', out, `${Wd}x${Hd}`, 'x', x0, x1, 'z', z0, z1);
