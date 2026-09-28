// Math, easing, randomness and noise helpers shared by every scene.

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const mix = (a, b, t) => a + (b - a) * t;
export const remap = (x, a, b) => clamp((x - a) / (b - a));
export const smoothstep = (a, b, x) => { const t = remap(x, a, b); return t * t * (3 - 2 * t); };
export const fract = (x) => x - Math.floor(x);
export const TAU = Math.PI * 2;

// --- Easing -------------------------------------------------------------
export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inQuart: (t) => t * t * t * t,
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  inOutQuart: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
  inQuint: (t) => t * t * t * t * t,
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  inOutQuint: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2),
  inExpo: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutExpo: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2),
  inCirc: (t) => 1 - Math.sqrt(Math.max(0, 1 - t * t)),
  outCirc: (t) => Math.sqrt(Math.max(0, 1 - (t - 1) * (t - 1))),
  outBack: (t, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
  inBack: (t, s = 1.70158) => (s + 1) * t * t * t - s * t * t,
};

// Clamped easing helper: e(ease.outExpo, t, start, duration)
export const e = (fn, t, start, dur) => fn(clamp((t - start) / dur));

// Damped spring step response (0 -> 1), t in seconds.
export function spring(t, freq = 3, damp = 0.35) {
  if (t <= 0) return 0;
  const w = TAU * freq;
  const z = Math.min(damp, 0.999);
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
}

// Damped oscillation impulse (starts at 0, rings, decays) — good for jiggles.
export function ring(t, freq = 6, decay = 8) {
  if (t <= 0) return 0;
  return Math.sin(TAU * freq * t) * Math.exp(-decay * t);
}

// CSS-style cubic-bezier easing.
export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (u) => ((ax * u + bx) * u + cx) * u;
  const sy = (u) => ((ay * u + by) * u + cy) * u;
  const dsx = (u) => (3 * ax * u + 2 * bx) * u + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let u = x;
    for (let i = 0; i < 8; i++) {
      const d = sx(u) - x;
      const dd = dsx(u);
      if (Math.abs(d) < 1e-6) break;
      if (Math.abs(dd) < 1e-6) break;
      u -= d / dd;
    }
    u = clamp(u);
    return sy(u);
  };
}
// A few "designer" curves.
export const curves = {
  snap: bezier(0.7, 0, 0.1, 1),       // strong ease in-out
  swift: bezier(0.2, 0.9, 0.1, 1),    // fast out, long settle
  hard: bezier(0.9, 0, 0.1, 1),
  glide: bezier(0.4, 0, 0.2, 1),
};

// --- Random ---------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Stateless hash -> [0,1)
export function hash(...n) {
  let h = 2166136261 >>> 0;
  for (const v of n) {
    h ^= Math.floor(v * 1000003) | 0;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995) >>> 0;
    h ^= h >>> 15;
  }
  return (h >>> 0) / 4294967296;
}

// --- Noise ------------------------------------------------------------------
// Smooth 1D value noise, deterministic.
export function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return mix(hash(i, seed) * 2 - 1, hash(i + 1, seed) * 2 - 1, u);
}
// 2D value noise.
export function noise2(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return mix(mix(a, b, ux), mix(c, d, ux), uy) * 2 - 1;
}

// --- Colour -------------------------------------------------------------------
export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
}
export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const hexToLinear = (hex) => hexToRgb(hex).map(srgbToLinear);
export function mixHex(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const c = A.map((v, i) => Math.round(mix(v, B[i], clamp(t)) * 255));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
