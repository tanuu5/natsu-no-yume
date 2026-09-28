// Material library: procedural Canvas2D textures (albedo, normal from height,
// roughness) at world scale, and the shared MeshStandardMaterials built from them.
// UVs are in metres (see builder.js); `period` is the size of one texture tile in metres.
// Tint individual parts with vertex colours (the Builder's `color`).
import * as THREE from 'three';
import { perlin, fbm, rng } from './noise.js';
import { prep } from './materials.js';

export function canvas(n) {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  return c;
}

// Normal map (tangent space, OpenGL convention) from a height canvas.
export function normalFrom(hc, strength) {
  const n = hc.width;
  const hd = hc.getContext('2d').getImageData(0, 0, n, n).data;
  const out = canvas(n);
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(n, n);
  const H = (x, y) => hd[(((y + n) % n) * n + ((x + n) % n)) * 4] / 255;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const o = (y * n + x) * 4;
      img.data[o] = (-dx / l * 0.5 + 0.5) * 255;
      img.data[o + 1] = (dy / l * 0.5 + 0.5) * 255;
      img.data[o + 2] = (1 / l * 0.5 + 0.5) * 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

export function toTex(c, period, srgb) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / period, 1 / period);
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// Paint a texture set. painter(px) gets per-pixel access:
//   px(x, y) is called for every pixel with u, v in [0,1) and must return
//   [r, g, b (0..1 sRGB), height (0..1), roughness (0..1)]; optional pre(ctx...) for vector drawing.
export function paintSet(n, fn) {
  const cc = canvas(n), hc = canvas(n), rc = canvas(n);
  const ci = cc.getContext('2d').createImageData(n, n);
  const hi = hc.getContext('2d').createImageData(n, n);
  const ri = rc.getContext('2d').createImageData(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const [r, g, b, h, ro] = fn(x / n, y / n, x, y);
      const o = (y * n + x) * 4;
      ci.data[o] = Math.max(0, Math.min(255, r * 255)); ci.data[o + 1] = Math.max(0, Math.min(255, g * 255)); ci.data[o + 2] = Math.max(0, Math.min(255, b * 255)); ci.data[o + 3] = 255;
      const hv = Math.max(0, Math.min(255, h * 255));
      hi.data[o] = hi.data[o + 1] = hi.data[o + 2] = hv; hi.data[o + 3] = 255;
      const rv = Math.max(0, Math.min(255, ro * 255));
      ri.data[o] = ri.data[o + 1] = ri.data[o + 2] = rv; ri.data[o + 3] = 255;
    }
  }
  cc.getContext('2d').putImageData(ci, 0, 0);
  hc.getContext('2d').putImageData(hi, 0, 0);
  rc.getContext('2d').putImageData(ri, 0, 0);
  return { cc, hc, rc };
}

// Tileable noise on the unit square: u, v in [0, 1) (wrapped), pu x pv cells.
export function tnoise(u, v, pu, seed = 0, pv = pu) {
  u -= Math.floor(u); v -= Math.floor(v);
  // blend four offset copies so the result tiles
  const a = perlin(u * pu + seed * 13.7, v * pv);
  const b = perlin((u - 1) * pu + seed * 13.7, v * pv);
  const c = perlin(u * pu + seed * 13.7, (v - 1) * pv);
  const d = perlin((u - 1) * pu + seed * 13.7, (v - 1) * pv);
  const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  return (a * (1 - su) + b * su) * (1 - sv) + (c * (1 - su) + d * su) * sv;
}
export function tfbm(u, v, p, oct = 4, seed = 0, pv = p) {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) { s += a * tnoise(u, v, p, seed + i * 7.1, pv); n += a; p *= 2; pv *= 2; a *= 0.5; }
  return s / n;
}
export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const hashf = (i, s = 0) => { const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return x - Math.floor(x); };

// ----------------------------------------------------------------------------
const PAINTERS = {
  // vertical charred-cedar boards with battens (焼杉板張り); 1.8 m tile, 10 boards
  woodV: { n: 512, period: 1.8, normal: 3, fn: (u, v) => {
    const nb = 10, bi = Math.floor(u * nb), bu = u * nb - bi;
    const grain = tnoise(u, v, 60, bi, 3) * 0.5 + tfbm(u, v, 8, 3, 3) * 0.5;
    const tone = 0.75 + 0.5 * hashf(bi, 2);
    const batten = (Math.abs(bu - 0.0) < 0.07 || Math.abs(bu - 1) < 0.07) ? 1 : 0;
    const gap = bu < 0.015 || bu > 0.985 ? 1 : 0;
    const weather = clamp01(0.5 + tfbm(u, v, 3, 3, 9) * 1.5);
    let c = [0.13, 0.10, 0.08].map((k) => k * tone * (0.85 + grain * 0.5));
    c = c.map((k, i) => k + weather * [0.05, 0.045, 0.04][i]);
    if (batten) c = c.map((k) => k * 0.8);
    const h = 0.4 + grain * 0.08 + batten * 0.4 - gap * 0.3;
    return [...c, h, 0.75 + grain * 0.15];
  } },
  // horizontal lap boards (下見板), weathered grey-brown; 1.6 m tile, rows of 0.2 m
  woodH: { n: 512, period: 1.6, normal: 4, fn: (u, v) => {
    const rows = 8, ri = Math.floor(v * rows), rv = v * rows - ri;
    const grain = tnoise(u, v, 3, ri, 70) * 0.6 + tfbm(u, v, 6, 3, 1) * 0.4;
    const tone = 0.8 + 0.4 * hashf(ri, 5);
    const shadow = rv < 0.12 ? (1 - rv / 0.12) : 0;
    let c = [0.30, 0.24, 0.18].map((k) => k * tone * (0.85 + grain * 0.4) * (1 - shadow * 0.55));
    const h = rv * 0.5 + grain * 0.06;
    return [...c, h, 0.8];
  } },
  // lime plaster / mortar (漆喰・モルタル): off-white with stains; 2 m tile
  plaster: { n: 512, period: 2.0, normal: 1.5, fn: (u, v) => {
    const n1 = tfbm(u, v, 4, 4, 11), n2 = tfbm(u, v, 24, 3, 12);
    const stain = clamp01(tfbm(u, v, 2, 3, 13, 6) * 2 + 0.1);
    let c = [0.80, 0.78, 0.72].map((k, i) => k * (0.93 + n1 * 0.12 + n2 * 0.05) - stain * [0.10, 0.10, 0.09][i]);
    return [...c, 0.5 + n2 * 0.1, 0.9];
  } },
  // Japanese J-tiles (桟瓦): u across (0.3 m per tile), v up the slope (0.25 m rows); 1.2 m tile
  roofTile: { n: 1024, period: 1.2, normal: 6, fn: (u, v) => {
    const tu = u * 4, ti = Math.floor(tu), fu = tu - ti;
    const tv = v * 4.8, tj = Math.floor(tv), fv = tv - tj;
    // J-profile: a round roll and a shallow pan
    const roll = Math.exp(-(((fu - 0.78) / 0.13) ** 2));
    const pan = 0.35 * Math.sin(fu * Math.PI * 0.85);
    let h = 0.25 + pan * 0.5 + roll * 0.55;
    // each row's lower edge is a step down onto the row below
    h += (1 - fv) * 0.12;
    const edge = fv > 0.93 ? 1 : 0;
    const id = ti * 17 + tj * 5;
    const tone = 0.85 + 0.3 * hashf(id, 3);
    const n = tfbm(u, v, 12, 3, 21);
    const lichen = clamp01(tfbm(u, v, 3, 4, 22) * 2.2 - 0.35) * (1 - roll);
    let c = [0.20, 0.21, 0.23].map((k) => k * tone * (0.9 + n * 0.25));
    c = c.map((k, i) => k * (0.8 + roll * 0.35) * (edge ? 0.55 : 1));
    c = c.map((k, i) => k + lichen * [0.06, 0.05, 0.02][i]);
    return [...c, h - edge * 0.2, 0.42 + n * 0.15 + lichen * 0.3];
  } },
  concrete: { n: 512, period: 2.4, normal: 1.2, fn: (u, v) => {
    const n1 = tfbm(u, v, 3, 4, 31), n2 = tfbm(u, v, 30, 2, 32);
    const streak = clamp01(tfbm(u, v, 12, 3, 33, 1) * 1.2);
    const form = (Math.abs(v * 2.4 % 0.6 - 0.3) > 0.295) ? 0.06 : 0;
    let c = [0.50, 0.49, 0.46].map((k) => k * (0.9 + n1 * 0.2 + n2 * 0.06) - streak * 0.08 - form);
    return [...c, 0.5 + n2 * 0.15 - form, 0.92];
  } },
  // concrete block wall (ブロック塀): 0.4 x 0.2 m blocks; 1.6 x 1.6 m tile
  block: { n: 512, period: 1.6, normal: 3, fn: (u, v) => {
    const rows = 8, ri = Math.floor(v * rows), rv = v * rows - ri;
    const off = (ri % 2) * 0.5;
    const cu = u * 4 + off, ci = Math.floor(cu), fu = cu - ci;
    const mortar = rv < 0.05 || fu < 0.025 ? 1 : 0;
    const n = tfbm(u, v, 20, 3, 41);
    const stain = clamp01(tfbm(u, v, 3, 3, 42, 1) * 2 + (1 - v) * 0.2);
    const tone = 0.92 + 0.12 * hashf(ci + ri * 13, 4);
    let c = [0.55, 0.54, 0.51].map((k) => k * tone * (0.9 + n * 0.15) - stain * 0.1);
    if (mortar) c = c.map((k) => k * 0.8);
    return [...c, mortar ? 0.2 : 0.6 + n * 0.1, 0.9];
  } },
  // irregular stone wall (石垣): jittered-grid Voronoi stones with dark gaps and moss; 2.4 m tile
  stoneWall: { n: 1024, period: 2.4, normal: 7, fn: (() => {
    const G = 7;
    const pts = [];
    const R = rng(77);
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) pts.push([(i + 0.15 + 0.7 * R()) / G, (j + 0.15 + 0.7 * R()) / G, R()]);
    return (u, v) => {
      let d1 = 9, d2 = 9, id = 0;
      const gi = Math.floor(u * G), gj = Math.floor(v * G);
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
        const ii = (gi + i + G) % G, jj = (gj + j + G) % G;
        const p = pts[jj * G + ii];
        const px = p[0] + Math.floor((gi + i) / G) * 1 + ((gi + i + G) % G - ii) / G * 0;
        const qx = (gi + i) / G + (p[0] * G - ii) / G, qy = (gj + j) / G + (p[1] * G - jj) / G;
        // stones are wider than tall
        const dx = (u - qx) * 0.8, dy = (v - qy) * 1.15;
        const d = Math.hypot(dx, dy);
        if (d < d1) { d2 = d1; d1 = d; id = p[2]; } else if (d < d2) d2 = d;
      }
      const edge = (d2 - d1) * G;
      const gap = clamp01(1 - edge / 0.12);
      const bulge = clamp01(edge * 1.6) ** 0.5;
      const n = tfbm(u, v, 16, 3, 51);
      const moss = clamp01(tfbm(u, v, 5, 4, 52) * 2.5 - 0.2) * (0.35 + gap * 0.65);
      const tone = 0.75 + 0.45 * id;
      let c = [0.40, 0.37, 0.32].map((k, i) => k * tone * (0.85 + n * 0.3) * [1, 1, 0.95 + 0.1 * id][i]);
      c = c.map((k, i) => k * (1 - gap * 0.75));
      c = c.map((k, i) => k * (1 - moss * 0.6) + moss * [0.10, 0.14, 0.05][i]);
      return [...c, bulge * 0.8 + n * 0.1, 0.85 + moss * 0.1];
    };
  })() },
  // asphalt with aggregate, patches and cracks; 4 m tile
  asphalt: { n: 1024, period: 4, normal: 2, fn: (u, v) => {
    const n1 = tfbm(u, v, 4, 3, 61), n2 = tnoise(u, v, 300, 62), n3 = tfbm(u, v, 60, 2, 63);
    const patch = tfbm(u, v, 2, 3, 64) > 0.22 ? 0.03 : 0;
    const crackF = Math.abs(tfbm(u, v, 5, 5, 65));
    const crack = crackF < 0.006 ? 1 - crackF / 0.006 : 0;
    const wear = clamp01(tfbm(u, v, 3, 3, 66) * 1.5 + 0.2);
    let g = 0.17 + n1 * 0.035 + n2 * 0.03 + n3 * 0.02 + patch * 0.6 + wear * 0.025;
    g *= 1 - crack * 0.3;
    return [g * 1.02, g, g * 0.97, 0.5 + n2 * 0.25 - crack * 0.15, 0.88 - n2 * 0.1];
  } },
  // corrugated metal sheet (トタン), ribs every 0.076 m; 1.216 m tile (16 ribs)
  corrugated: { n: 512, period: 1.216, normal: 5, fn: (u, v) => {
    const rib = 0.5 + 0.5 * Math.sin(u * 16 * Math.PI * 2);
    const n = tfbm(u, v, 8, 3, 71);
    const rust = clamp01(tfbm(u, v, 2, 4, 72, 5) * 2.4 - 0.25) * (0.6 + 0.4 * (1 - v));
    let c = [0.62, 0.62, 0.60].map((k) => k * (0.9 + n * 0.15));
    c = c.map((k, i) => k * (1 - rust) + rust * [0.42, 0.22, 0.12][i] * (0.8 + n * 0.4));
    return [...c, rib * 0.8, 0.55 + rust * 0.35];
  } },
  // painted metal / FRP (boats, signs): mostly clean, a little grime; 2 m tile
  paint: { n: 512, period: 2, normal: 0.8, fn: (u, v) => {
    const n = tfbm(u, v, 6, 3, 81), g = clamp01(tfbm(u, v, 6, 3, 82, 1) * 2);
    const c = [0.9, 0.9, 0.9].map((k) => k * (0.96 + n * 0.05) - g * 0.07);
    return [...c, 0.5 + n * 0.05, 0.45 + g * 0.2];
  } },
  // ground: packed earth / gravel path; 3 m tile
  dirt: { n: 512, period: 3, normal: 2, fn: (u, v) => {
    const n1 = tfbm(u, v, 5, 4, 91), n2 = tnoise(u, v, 180, 92);
    const pebble = n2 > 0.45 ? 1 : 0;
    const g = 0.28 + n1 * 0.08 + pebble * 0.05;
    return [g * 1.1, g * 0.98, g * 0.82, 0.5 + n2 * 0.3, 0.95];
  } },
};

// Materials that glow only at dusk/night (emissiveIntensity scaled by world.js).
export const NIGHT = new Set();
export function registerNight(mat, strength = 1) {
  mat.userData.night = strength;
  mat.userData.baseEmissive = mat.userData.baseEmissive ?? 1;
  NIGHT.add(mat);
  return mat;
}

// Build a textured MeshStandardMaterial from a painter { n, period, normal, fn } (see PAINTERS).
export function texturedMaterial(name, P, opts = {}) {
  const { cc, hc, rc } = paintSet(P.n, P.fn);
  const nc = normalFrom(hc, P.normal);
  const m = new THREE.MeshStandardMaterial({
    name, map: toTex(cc, P.period, true), normalMap: toTex(nc, P.period, false), roughnessMap: toTex(rc, P.period, false),
    roughness: 1, metalness: 0, vertexColors: true, ...opts,
  });
  return prep(m, null, 'tex-' + name);
}

let LIB = null;
export function materials() {
  if (LIB) return LIB;
  LIB = {};
  const mk = (name, opts = {}) => {
    const P = PAINTERS[name];
    const { cc, hc, rc } = paintSet(P.n, P.fn);
    const nc = normalFrom(hc, P.normal);
    const m = new THREE.MeshStandardMaterial({
      name, map: toTex(cc, P.period, true), normalMap: toTex(nc, P.period, false), roughnessMap: toTex(rc, P.period, false),
      roughness: 1, metalness: 0, vertexColors: true, ...opts,
    });
    return prep(m, null, 'lib-' + name);
  };
  for (const name of Object.keys(PAINTERS)) LIB[name] = mk(name);
  LIB.roofTile.roughness = 1;
  LIB.corrugated.metalness = 0.35;
  // plain materials
  const plain = (name, opts) => prep(new THREE.MeshStandardMaterial({ name, vertexColors: true, ...opts }), null, 'lib-' + name);
  LIB.glass = plain('glass', { color: 0x1a2226, roughness: 0.04, metalness: 0.0, envMapIntensity: 1.4 });
  LIB.metal = plain('metal', { color: 0xb8bcc0, roughness: 0.35, metalness: 0.9 });
  LIB.darkMetal = plain('darkMetal', { color: 0x2a2c2e, roughness: 0.5, metalness: 0.6 });
  LIB.rubber = plain('rubber', { color: 0x151515, roughness: 0.85, metalness: 0 });
  LIB.matte = plain('matte', { color: 0xffffff, roughness: 0.85, metalness: 0 });
  // lights that switch on at dusk: world.js sets emissiveIntensity per time of day
  LIB.lamp = plain('lamp', { color: 0xffffff, roughness: 0.6, emissive: 0xffd9a0, emissiveIntensity: 0 });
  LIB.lamp.userData.castShadow = false;
  registerNight(LIB.lamp, 1);
  // a lit window (warm interior glow behind glass); use for a random ~40% of windows
  LIB.windowLit = plain('windowLit', { color: 0x1a2226, roughness: 0.05, emissive: 0xffc27a, emissiveIntensity: 0 });
  registerNight(LIB.windowLit, 1);
  return LIB;
}
