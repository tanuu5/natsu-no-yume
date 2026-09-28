// Fast deterministic noise for generating the world on the CPU (terrain, placement).
// Gradient noise with a permutation table; everything is seeded, so every run of the
// page builds exactly the same town.

const P = new Uint8Array(512);
const GX = new Float32Array(256);
const GY = new Float32Array(256);
(function init(seed) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) P[i] = p[i & 255];
  for (let i = 0; i < 256; i++) {
    const a = rnd() * Math.PI * 2;
    GX[i] = Math.cos(a); GY[i] = Math.sin(a);
  }
})(20260928);

// 2D gradient noise in about [-0.7, 0.7] (scaled to ~[-1, 1]).
export function perlin(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const X = xi & 255, Y = yi & 255;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const aa = P[P[X] + Y], ab = P[P[X] + Y + 1], ba = P[P[X + 1] + Y], bb = P[P[X + 1] + Y + 1];
  const n00 = GX[aa] * xf + GY[aa] * yf;
  const n10 = GX[ba] * (xf - 1) + GY[ba] * yf;
  const n01 = GX[ab] * xf + GY[ab] * (yf - 1);
  const n11 = GX[bb] * (xf - 1) + GY[bb] * (yf - 1);
  const x1 = n00 + (n10 - n00) * u;
  const x2 = n01 + (n11 - n01) * u;
  return (x1 + (x2 - x1) * v) * 1.414;
}

export function fbm(x, y, oct = 5, lac = 2.03, gain = 0.5) {
  let a = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * perlin(x, y);
    n += a;
    x = x * lac + 17.13;
    y = y * lac - 9.71;
    a *= gain;
  }
  return s / n;
}

// Ridged multifractal: sharp crests, used for mountain ridges.
export function ridged(x, y, oct = 5) {
  let a = 0.5, s = 0, w = 1;
  for (let i = 0; i < oct; i++) {
    let n = 1 - Math.abs(perlin(x, y));
    n *= n;
    n *= w;
    w = Math.min(1, Math.max(0, n * 2));
    s += n * a;
    x = x * 2.01 + 5.3;
    y = y * 2.01 - 3.1;
    a *= 0.5;
  }
  return s;
}

// Integer hash -> [0, 1)
export function hash2(x, y, seed = 0) {
  let h = Math.imul((x | 0) ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul((y | 0) + seed * 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// Seeded PRNG
export function rng(seed) {
  let a = seed >>> 0;
  const f = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.range = (lo, hi) => lo + (hi - lo) * f();
  f.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * f());
  f.pick = (arr) => arr[Math.floor(f() * arr.length)];
  f.chance = (p) => f() < p;
  return f;
}

export const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
// Polynomial smooth min (k = blend radius).
export function smin(a, b, k) {
  const h = clamp(0.5 + 0.5 * (b - a) / k);
  return lerp(b, a, h) - k * h * (1 - h);
}
export function smax(a, b, k) { return -smin(-a, -b, k); }

// Distance from p to segment ab (2D) and the segment parameter.
export function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1));
  const qx = ax + dx * t - px, qz = az + dz * t - pz;
  return [Math.hypot(qx, qz), t];
}

// Distance to a polyline [[x,z],...]: returns {d, i, t, s} (segment index, param, arc length).
export function polyDist(px, pz, pts) {
  let best = Infinity, bi = 0, bt = 0, acc = 0, bs = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const [d, t] = segDist(px, pz, ax, az, bx, bz);
    if (d < best) { best = d; bi = i; bt = t; bs = acc + t * len; }
    acc += len;
  }
  return { d: best, i: bi, t: bt, s: bs };
}
