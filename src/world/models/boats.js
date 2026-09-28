// boats: small Japanese coastal fishing boats (漁船) and harbour props — tetrapods
// (消波ブロック), breakwater lights (防波堤灯台), bollards (係船柱), net piles, fish
// crates, buoys, a quay-side shed and fender tyres.
// Conventions (see index.js): metres, +y up, built at the origin sitting on y = 0.
// Boats float with the waterline at y = 0, bow toward +z (port = +x, starboard = -x).
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Builder, worldUV } from '../builder.js';
import { materials, texturedMaterial, registerNight, tfbm, clamp01 } from '../lib.js';
import { prep } from '../materials.js';
import { rng, perlin } from '../noise.js';

// ---------------------------------------------------------------------------
// small vector helpers (plain arrays)
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const rad = (d) => (d * Math.PI) / 180;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a, fb = [0, 1, 0]) => { const l = vlen(a); return l > 1e-12 ? scl(a, 1 / l) : fb.slice(); };
const tint = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const flag = (v) => v === true || v === 1 || v === '1' || v === 'true';
const seedOf = (o, k) => (Math.floor(+(o.seed ?? 1)) || 0) * 7919 + k;
const WHITE = [1, 1, 1];
const ORANGE = [0.82, 0.19, 0.022];
const TRS = (pos, rot = [0, 0, 0], s = 1) => Builder.mat({ pos, rot, scale: s });

// ---------------------------------------------------------------------------
// materials (created once, shared by every model of this file)
const PAINT_FRP = { n: 256, period: 3, normal: 0.6, fn: (u, v) => {
  // gel-coated fibreglass: near-white, faint vertical run-off streaks and grime
  const n = tfbm(u, v, 6, 3, 101);
  const run = clamp01(tfbm(u, v, 30, 3, 102, 2) * 2.8 - 0.35) * clamp01(tfbm(u, v, 3, 2, 104) * 2.5 + 0.2);
  const grime = clamp01(tfbm(u, v, 3, 3, 103) * 1.8);
  const w = 0.9 * (0.975 + n * 0.035) - grime * 0.05;
  return [w - run * 0.08, w - run * 0.1, w - run * 0.13, 0.5 + n * 0.05 - run * 0.03, 0.3 + grime * 0.22 + run * 0.18];
} };
const NET_LAYERS = [[1, 1, 1, -1, 15], [2, 1, 1, -2, 7], [1, 2, 2, -1, 8]];   // lattice directions keep it tileable
const PAINT_NET = { n: 512, period: 0.8, normal: 4, fn: (u, v) => {
  // three tangled layers of knotted diamond mesh, warped; holes show the layer below
  const fold = tfbm(u, v, 5, 3, 113);
  for (let l = 0; l < 3; l++) {
    const [a1, b1, a2, b2, k] = NET_LAYERS[l];
    const wu = tfbm(u, v, 3, 2, 111 + l * 5) * 0.07, wv = tfbm(u, v, 3, 2, 112 + l * 5) * 0.07;
    const a = (a1 * u + b1 * v + wu) * k, b = (a2 * u + b2 * v + wv) * k;
    const da = Math.abs(a - Math.round(a)), db = Math.abs(b - Math.round(b));
    const t = Math.max(clamp01(1 - da / 0.12), clamp01(1 - db / 0.12), clamp01(1 - Math.hypot(da, db) / 0.2));
    if (t > 0.35) {
      const c = 0.85 * (0.75 + fold * 0.3) * [1, 0.72, 0.52][l] * (0.85 + t * 0.15);
      return [c, c, c, 0.9 - l * 0.25 + fold * 0.1, 0.86];
    }
  }
  const c = 0.1 + fold * 0.04;
  return [c, c, c, 0.05, 0.9];
} };
const PAINT_PLASTIC = { n: 256, period: 0.5, normal: 0.8, fn: (u, v) => {
  // moulded crate plastic: shallow vertical ribs, scuffs, a little dirt
  const rib = Math.cos(u * 12 * Math.PI * 2) * 0.5 + 0.5;
  const sc = tfbm(u, v, 10, 3, 121), dirt = clamp01(tfbm(u, v, 3, 3, 122) * 1.6 - 0.1);
  const c = 0.86 * (0.96 + sc * 0.05) - dirt * 0.1;
  return [c, c, c * 0.99, 0.4 + rib * 0.15 + sc * 0.03, 0.6 + dirt * 0.25 + sc * 0.05];
} };

let MB = null;
function mats() {
  if (MB) return MB;
  const M = materials();
  const plain = (name, o) => prep(new THREE.MeshStandardMaterial({ name, vertexColors: true, ...o }), null, 'boats-' + name);
  const night = (name, col, em, k) => registerNight(plain(name, { color: col, roughness: 0.15, emissive: em, emissiveIntensity: 0 }), k);
  MB = {
    ...M,
    frp: texturedMaterial('boatFrp', PAINT_FRP),
    net: texturedMaterial('boatNet', PAINT_NET),
    plastic: texturedMaterial('boatPlastic', PAINT_PLASTIC),
    canvas: plain('boatCanvas', { color: 0xffffff, roughness: 0.92, side: THREE.DoubleSide }),
    bulb: plain('boatBulb', { color: 0xe4e8e4, roughness: 0.1 }),
    // fishing lamps (集魚灯) of a boat going out at dusk: bright cool white
    bulbLit: night('boatBulbLit', 0xe4e8e4, 0xf2fff4, 4),
    // navigation / harbour-entrance lights
    navR: night('boatNavRed', 0x6a1810, 0xff2a14, 1.6),
    navG: night('boatNavGreen', 0x1a5230, 0x24ff66, 1.6),
    glassFloat: plain('boatGlassFloat', { color: 0x1d5e4a, roughness: 0.03, metalness: 0, envMapIntensity: 1.6 }),
  };
  MB.bulbLit.userData.castShadow = false;
  return MB;
}

// Text decals: boat names (〇〇丸, Dela Gothic One) and registration numbers (漁船登録番号)
// drawn white into one shared alpha-tested atlas; tinted by vertex colour (black paint).
const NAMES = ['第八大漁丸', '幸福丸', '恵比寿丸', '第三海神丸', '住吉丸', '宝栄丸', '第十一喜久丸', '明神丸', '豊漁丸', '光洋丸', '第五清福丸', '金比羅丸'];
const NN = NAMES.length, NR = 20;
let DECAL = null;
function decals() {
  if (DECAL) return DECAL;
  const cw = 1024, rh = 64, rows = NN + NR, c = document.createElement('canvas');
  c.width = cw; c.height = rows * rh;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  const R = rng(2718), list = [];
  for (let i = 0; i < rows; i++) {
    const name = i < NN;
    const text = name ? NAMES[i] : `YG${R.int(1, 3)}-${R.int(1000, 29999)}`;
    ctx.font = name ? '400 50px "Dela Gothic One", "Hiragino Sans", sans-serif' : '800 52px "Archivo", "Helvetica Neue", sans-serif';
    const w = Math.min(ctx.measureText(text).width, cw - 16);
    ctx.fillText(text, 8, i * rh + rh / 2 + 2, cw - 16);
    // uv rect (CanvasTexture flips y) and aspect = width / cap height
    list.push({ text, name, u0: 6 / cw, u1: (10 + w) / cw, vb: 1 - ((i + 1) * rh - 6) / (rows * rh), vt: 1 - (i * rh + 6) / (rows * rh), aspect: (w + 4) / (rh - 12) });
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = prep(new THREE.MeshStandardMaterial({ name: 'boatDecal', map: tex, alphaTest: 0.45, vertexColors: true, roughness: 0.45 }), null, 'boats-decal');
  mat.userData.castShadow = false;
  DECAL = { mat, names: list.slice(0, NN), regs: list.slice(NN) };
  return DECAL;
}

// ---------------------------------------------------------------------------
// geometry helpers

// Indexed grid surface from rows of points. Faces are wound to agree with the given
// normals (nrm, same shape as rows) or with `ref` (a direction or fn(p) -> direction);
// without nrm, smooth normals are computed. Degenerate triangles are dropped.
function grid(rows, { nrm = null, uv = null, ref = [0, 1, 0] } = {}) {
  const R = rows.length, C = rows[0].length, n = R * C;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) pos.set(rows[i][j], (i * C + j) * 3);
  const P = (k) => [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]];
  const Nk = (k) => nrm[(k / C) | 0][k % C];
  const idx = [];
  let vote = 0;
  for (let i = 0; i < R - 1; i++) for (let j = 0; j < C - 1; j++) {
    const a = i * C + j, b = a + C, c = b + 1, d = a + 1;
    for (const [x, y, z] of [[a, b, c], [a, c, d]]) {
      const pa = P(x), fn = cross(sub(P(y), pa), sub(P(z), pa)), ar = vlen(fn);
      if (ar < 1e-9) continue;
      const rd = nrm ? add(add(Nk(x), Nk(y)), Nk(z)) : typeof ref === 'function' ? ref(pa) : ref;
      vote += dot(fn, rd) / ar;
      idx.push(x, y, z);
    }
  }
  if (!idx.length) return null;
  if (vote < 0) for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  if (nrm) {
    const na = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) na.set(Nk(k), k * 3);
    g.setAttribute('normal', new THREE.BufferAttribute(na, 3));
  } else g.computeVertexNormals();
  if (uv) {
    const ua = new Float32Array(n * 2);
    for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) ua.set(uv[i][j], (i * C + j) * 2);
    g.setAttribute('uv', new THREE.BufferAttribute(ua, 2));
  } else worldUV(g);
  return g;
}
const addGrid = (B, mat, rows, opts, col = WHITE, X = null) => { const g = grid(rows, opts); if (g) B.geo(mat, g, X, col); };

function newell(pts) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}
// Convex planar polygon (fan), wound to face `out`, flat normals, metre UVs.
function polyGeo(pts, out) {
  const flip = dot(newell(pts), out) < 0;
  const arr = [];
  for (let i = 1; i < pts.length - 1; i++) arr.push(...pts[0], ...(flip ? pts[i + 1] : pts[i]), ...(flip ? pts[i] : pts[i + 1]));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
  g.computeVertexNormals();
  return worldUV(g);
}
const poly = (B, mat, pts, out, col = WHITE, X = null) => B.geo(mat, polyGeo(pts, out), X, col);

// Cylinder from point a (radius r) to point b (radius r2).
const _Y = new THREE.Vector3(0, 1, 0);
function along(p, dir) {
  const d = new THREE.Vector3(...unit(dir));
  return new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromUnitVectors(_Y, d), new THREE.Vector3(1, 1, 1));
}
function rod(B, mat, a, b, r, col = WHITE, { r2 = null, seg = 6, open = false, X = null } = {}) {
  const d = sub(b, a), l = vlen(d);
  if (l < 1e-4) return;
  const m = along(mix(a, b, 0.5), d);
  if (X) m.premultiply(X);
  B.geo(mat, worldUV(new THREE.CylinderGeometry(r2 ?? r, r, l, seg, 1, open)), m, col);
}
// Lathe from [r, y] pairs listed bottom to top (normals face outward).
const lathe = (prof, seg) => worldUV(new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), seg));
const sphere = (r, ws = 12, hs = 8) => worldUV(new THREE.SphereGeometry(r, ws, hs));
const torus = (r, tube, rs, ts, arc = Math.PI * 2) => worldUV(new THREE.TorusGeometry(r, tube, rs, ts, arc));
function bez(p0, p1, p2, p3, u) {
  const v = 1 - u, a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, d = u * u * u;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}
// cheap 3D-ish noise from the 2D gradient noise (for lumpy displacement)
const n3 = (x, y, z, s) => (perlin(x + s * 7.1, y * 0.8 + z * 0.6) + perlin(z + s * 3.3, x * 0.7 - y * 0.7) + perlin(y + s * 1.7, z * 0.9 + x * 0.4)) / 3;

// ---------------------------------------------------------------------------
// shared small parts (added into a caller's Builder under transform X)

// Car tyre, axle along local y, centred at the origin.
function tireGeo(r = 0.3, w = 0.18, seg = 14) {
  const h = w / 2, ri = r * 0.56, m = lerp(ri, r, 0.42);
  return lathe([[ri, -h * 0.72], [m, -h * 0.98], [r * 0.93, -h], [r, -h * 0.62], [r, h * 0.62], [r * 0.93, h], [m, h * 0.98], [ri, h * 0.72], [ri, -h * 0.72]], seg);
}
function buoyInto(B, M, X, { r = 0.19, col = ORANGE, seg = 14, seam = true } = {}) {
  B.geo(M.paint, sphere(r, seg, Math.max(6, Math.round(seg * 0.62))), X, col);
  if (seam) B.geo(M.paint, torus(r * 0.998, r * 0.016, 3, seg * 2), X, tint(col, 0.9));          // mould seam
  B.geo(M.paint, worldUV(new THREE.CylinderGeometry(r * 0.13, r * 0.16, r * 0.14, 6)), X.clone().multiply(TRS([0, r * 1.02, 0])), tint(col, 0.9));
  B.geo(M.paint, torus(r * 0.2, r * 0.065, 4, 8), X.clone().multiply(TRS([0, r * 1.26, 0])), tint(col, 0.9)); // lug
}
function crateInto(B, M, X, { w = 0.64, d = 0.42, h = 0.2, col = [0.08, 0.25, 0.62], open = false } = {}) {
  const tp = 0.018, hw1 = w / 2, hd1 = d / 2, hw0 = hw1 - tp, hd0 = hd1 - tp, rim = 0.024;
  const bot = [[-hw0, 0.004, -hd0], [hw0, 0.004, -hd0], [hw0, 0.004, hd0], [-hw0, 0.004, hd0]];
  const top = [[-hw1, h, -hd1], [hw1, h, -hd1], [hw1, h, hd1], [-hw1, h, hd1]];
  const ins = top.map(([x, y, z]) => [x - Math.sign(x) * rim, y, z - Math.sign(z) * rim]);
  const ib = ins.map(([x, , z]) => [x * 0.95, 0.03, z * 0.93]);
  const outs = [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0]];
  for (let k = 0; k < 4; k++) {
    const k2 = (k + 1) % 4;
    poly(B, M.plastic, [bot[k], bot[k2], top[k2], top[k]], outs[k], col, X);
    poly(B, M.plastic, [top[k], top[k2], ins[k2], ins[k]], [0, 1, 0], tint(col, 1.04), X);
    if (open) poly(B, M.plastic, [ins[k], ins[k2], ib[k2], ib[k]], scl(outs[k], -1), tint(col, 0.75), X);
  }
  if (open) poly(B, M.plastic, ib, [0, 1, 0], tint(col, 0.6), X);
  // hand holes on the short ends
  for (const s of [-1, 1]) {
    const x = s * (hw1 - tp * 0.3 + 0.006);
    poly(B, M.matte, [[x, h - 0.075, -0.075], [x, h - 0.075, 0.075], [x, h - 0.035, 0.075], [x, h - 0.035, -0.075]], [s, 0, 0], [0.02, 0.02, 0.022], X);
  }
}
const BULB = [[0.001, -0.34], [0.045, -0.315], [0.065, -0.235], [0.06, -0.13], [0.034, -0.05], [0.026, 0]];
function bulbInto(B, M, p, lit, k = 1) {
  B.geo(M.darkMetal, worldUV(new THREE.CylinderGeometry(0.032 * k, 0.036 * k, 0.08 * k, 6, 1, true)), TRS([p[0], p[1] + 0.04 * k, p[2]]));
  B.geo(lit ? M.bulbLit : M.bulb, lathe(BULB.map(([r, y]) => [r * k, y * k]), 6), TRS(p));
}
function lifeRingInto(B, M, X, r = 0.27) {
  for (let k = 0; k < 8; k++) B.geo(M.paint, torus(r, r * 0.18, 5, 3, Math.PI / 4), X.clone().multiply(TRS([0, 0, 0], [0, 0, (k * Math.PI) / 4])), k % 2 ? [0.9, 0.9, 0.88] : ORANGE);
}
// A lumpy blob (displaced icosphere), bottom flattened onto y = 0; returns {g, surf(dir)}.
function blobGeo(c, rx, ry, rz, amp, s, detail = 3) {
  const disp = (x, y, z) => 1 + amp * (n3(x * 1.7, y * 1.7, z * 1.7, s) * 0.7 + n3(x * 4.3, y * 4.3, z * 4.3, s + 5) * 0.3) * 1.8;
  const surf = (d) => {
    const k = disp(d[0], d[1], d[2]);
    const y = d[1] * k * ry;
    return [c[0] + d[0] * k * rx, c[1] + (y < 0 ? y * 0.12 : y), c[2] + d[2] * k * rz];
  };
  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const q = surf([p.getX(i), p.getY(i), p.getZ(i)]); p.setXYZ(i, q[0], Math.max(q[1], 0), q[2]); }
  g.computeVertexNormals();
  return { g: worldUV(g), surf };
}

// ---------------------------------------------------------------------------
// Hull: lofted from planar cross-sections. t in [0, 1] runs from the transom
// (z = -L/2) to the stem head (z = +L/2); s in [0, 1] runs up a section from the keel
// (s = 0) through the chine (s = 0.5) to the sheer (s = 1). Each half-section is two
// cubic Béziers: a V bottom with deadrise, a rounded chine, flared topsides.
function makeHull(L, R, flare) {
  const Bm = (0.75 + 0.19 * L) * R.range(0.96, 1.04), hbm = Bm / 2;
  const ysAft = (0.42 + 0.055 * L) * R.range(0.97, 1.05);
  const sag = 0.03 + 0.004 * L;
  const bowRise = (0.22 + 0.066 * L) * R.range(0.92, 1.1);
  const yK = -(0.3 + 0.03 * L), yT = -(0.18 + 0.016 * L);
  const tF = 0.66 + R.range(-0.02, 0.03), tm = 0.44;
  const ys = (t) => (t < 0.3 ? ysAft - sag + sag * (1 - t / 0.3) ** 2 : ysAft - sag + bowRise * ((t - 0.3) / 0.7) ** 2.3);
  const ysBow = ys(1), yF = yK + 0.06;
  const bs = (t) => (t < tm ? hbm * (0.8 + 0.2 * (1 - ((tm - t) / tm) ** 2)) : hbm * Math.max(0, 1 - ((t - tm) / (1 - tm)) ** 2.3));
  const yb = (t) => {
    if (t < 0.45) return yK + (yT - yK) * (1 - t / 0.45) ** 2;
    if (t < tF) return yK + 0.06 * ((t - 0.45) / (tF - 0.45)) ** 2;
    const u = (t - tF) / (1 - tF);
    return yF + (ysBow - yF) * (0.08 * u + 0.92 * u ** 1.75);
  };
  const cache = new Map();
  const sec = (t) => {
    t = clamp(t, 0, 1);
    let S = cache.get(t);
    if (S) return S;
    const y0 = yb(t), y1 = ys(t), b1 = bs(t), h = Math.max(y1 - y0, 1e-6);
    const be = rad(12 + 8 * t + 42 * ss(0.55, 0.98, t));
    const ph = rad((4 + 32 * ss(0.4, 0.97, t)) * flare), pl = ph * 0.3;
    const yc = y0 + h * (0.3 + 0.12 * ss(0.5, 1, t));
    const bc = Math.max(b1 - (y1 - yc) * Math.tan((ph + pl) / 2), b1 * 0.2);
    const kc = Math.hypot(bc, yc - y0), cs = Math.hypot(b1 - bc, y1 - yc);
    const K = [0, y0], C = [bc, yc], Sh = [b1, y1];
    const P1 = [kc * 0.45 * Math.cos(be), y0 + kc * 0.45 * Math.sin(be)];
    const P2 = [bc - kc * 0.3 * Math.sin(pl), yc - kc * 0.3 * Math.cos(pl)];
    const Q1 = [bc + (cs / 3) * Math.sin(pl), yc + (cs / 3) * Math.cos(pl)];
    const Q2 = [b1 - (cs / 3) * Math.sin(ph), y1 - (cs / 3) * Math.cos(ph)];
    const at = (s) => (s < 0.5 ? bez(K, P1, P2, C, s * 2) : bez(C, Q1, Q2, Sh, s * 2 - 1));
    const sAtY = (y) => {
      if (y <= y0) return 0;
      if (y >= y1) return 1;
      let lo = 0, hi = 1;
      for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (at(m)[1] < y) lo = m; else hi = m; }
      return (lo + hi) / 2;
    };
    S = { t, z: -L / 2 + L * t, yb: y0, ys: y1, bs: b1, at, sAtY, xAtY: (y) => at(sAtY(y))[0] };
    cache.set(t, S);
    return S;
  };
  const P = (t, s, side = 1) => { const S = sec(t), q = S.at(s); return [side * q[0], q[1], S.z]; };
  // outward unit normal (finite differences; the degenerate stem head borrows from aft)
  const N = (t, s, side = 1) => {
    for (const tt of [t, t - 0.01, t - 0.03]) {
      const e = 1e-4, ta = Math.max(0, tt - e), tb = Math.min(1, tt + e), sa = Math.max(0, s - e), sb = Math.min(1, s + e);
      const n = cross(sub(P(tt, sb), P(tt, sa)), sub(P(tb, s), P(ta, s)));
      const l = vlen(n);
      if (l > 1e-14) return [(side * n[0]) / l, n[1] / l, n[2] / l];
    }
    return [side, 0, 0];
  };
  // stations, denser toward the bow; `fixed` values replace their nearest station
  const stations = (n, fixed = []) => {
    const T = [];
    for (let i = 0; i <= n; i++) T.push(1 - (1 - i / n) ** 1.35);
    for (const f of fixed) {
      let bi = 1;
      for (let i = 1; i < n; i++) if (Math.abs(T[i] - f) < Math.abs(T[bi] - f)) bi = i;
      T[bi] = f;
    }
    return T;
  };
  return { L, B: Bm, yK, ys, bs, yb, sec, P, N, stations };
}

// Wheelhouse (操舵室): tapered box with a raked front, black-framed windows, door, roof.
function cabin(B, M, c) {
  const { z0, z1, w, hgt, y0, rake, taper, R, col, trim, glass } = c;
  const y1 = y0 + hgt, a = w / 2, b = w / 2 - taper, zf = z1 - rake;
  const faces = {
    front: { p: [[-a, y0, z1], [a, y0, z1], [b, y1, zf], [-b, y1, zf]], out: [0, 0, 1] },
    back: { p: [[a, y0, z0], [-a, y0, z0], [-b, y1, z0], [b, y1, z0]], out: [0, 0, -1] },
    port: { p: [[a, y0, z1], [a, y0, z0], [b, y1, z0], [b, y1, zf]], out: [1, 0, 0] },
    stbd: { p: [[-a, y0, z0], [-a, y0, z1], [-b, y1, zf], [-b, y1, z0]], out: [-1, 0, 0] },
  };
  for (const f of Object.values(faces)) {
    f.n = unit(newell(f.p));
    if (dot(f.n, f.out) < 0) f.n = scl(f.n, -1);
    f.w = vlen(sub(f.p[1], f.p[0])); f.h = vlen(sub(f.p[3], f.p[0]));
    poly(B, M.frp, f.p, f.n, col);
  }
  poly(B, M.frp, [[b, y1, zf], [-b, y1, zf], [-b, y1, z0], [b, y1, z0]], [0, 1, 0], col);
  const fp = (f, u, v) => mix(mix(f.p[0], f.p[1], u), mix(f.p[3], f.p[2], u), v);
  const rect = (f, u0, u1, v0, v1, off) => [fp(f, u0, v0), fp(f, u1, v0), fp(f, u1, v1), fp(f, u0, v1)].map((p) => add(p, scl(f.n, off)));
  const win = (f, u0, u1, v0, v1, base = 0) => {
    const du = 0.028 / f.w, dv = 0.028 / f.h;
    poly(B, M.rubber, rect(f, u0 - du, u1 + du, v0 - dv, v1 + dv, base + 0.006), f.n);
    poly(B, glass, rect(f, u0, u1, v0, v1, base + 0.011), f.n);
  };
  // front: 2-4 panes, sides: one per ~0.66 m, back: door + window
  const nf = w > 1.9 ? 4 : w > 1.3 ? 3 : 2, gf = 0.06 / faces.front.w;
  for (let i = 0; i < nf; i++) win(faces.front, 0.05 + (i * 0.9) / nf + gf / 2, 0.05 + ((i + 1) * 0.9) / nf - gf / 2, 0.56, 0.93);
  const ns = Math.max(1, Math.round((z1 - z0) / 0.66));
  for (const f of [faces.port, faces.stbd]) {
    const g = 0.07 / f.w;
    for (let i = 0; i < ns; i++) win(f, 0.07 + (i * 0.86) / ns + g / 2, 0.07 + ((i + 1) * 0.86) / ns - g / 2, 0.55, 0.9);
  }
  const ds = c.door, du0 = ds > 0 ? 0.53 : 0.09, du1 = du0 + 0.38;
  poly(B, M.frp, rect(faces.back, du0, du1, 0.02, 0.87, 0.006), faces.back.n, tint(col, 0.88));
  win(faces.back, du0 + 0.07, du1 - 0.07, 0.56, 0.8, 0.006);
  B.box(M.darkMetal, { w: 0.03, h: 0.12, d: 0.03, pos: add(fp(faces.back, ds > 0 ? du0 + 0.05 : du1 - 0.05, 0.48), scl(faces.back.n, 0.03)) });
  win(faces.back, ds > 0 ? 0.12 : 0.58, ds > 0 ? 0.42 : 0.88, 0.58, 0.86);
  // roof with a visor over the front windows (and sometimes a painted fascia band)
  const visor = R.range(0.15, 0.28), ov = 0.07;
  const rz0 = z0 - ov, rz1 = zf + visor, rw = 2 * b + 2 * ov;
  B.box(M.frp, { w: rw, h: 0.07, d: rz1 - rz0, pos: [0, y1 + 0.035, (rz0 + rz1) / 2], color: col });
  if (c.band) B.box(M.frp, { w: rw + 0.012, h: 0.04, d: rz1 - rz0 + 0.012, pos: [0, y1 + 0.022, (rz0 + rz1) / 2], color: trim });
  return { y0, y1, top: y1 + 0.07, rz0, rz1, a, b, zf, z0, z1, hgt, faces, fp };
}

// A wire with hanging lamp bulbs (集魚灯) from a to b (sagging), bulbs between u0..u1.
function lampWire(B, M, a, b, { u0 = 0, u1 = 1, spacing = 0.6, lit = false, k = 1, drop = 0.1 } = {}) {
  const span = vlen(sub(b, a)), sag = 0.03 + span * 0.012;
  const pt = (u) => { const p = mix(a, b, u); p[1] -= 4 * sag * u * (1 - u); return p; };
  const ns = 6;
  for (let i = 0; i < ns; i++) rod(B, M.darkMetal, pt(i / ns), pt((i + 1) / ns), 0.006, WHITE, { seg: 3, open: true });
  const n = Math.max(1, Math.floor((span * (u1 - u0)) / spacing));
  for (let i = 0; i < n; i++) {
    const p = pt(lerp(u0, u1, (i + 0.5) / n));
    rod(B, M.darkMetal, p, [p[0], p[1] - drop, p[2]], 0.005, WHITE, { seg: 3, open: true });
    bulbInto(B, M, [p[0], p[1] - drop - 0.08 * k, p[2]], lit, k);
  }
  return n;
}

// ---------------------------------------------------------------------------
// boat(opts): seed, len (m, 5.5-14), style ('line' 一本釣り | 'squid' イカ釣り | 'net'
// 刺し網 | 'small', or 0-3), color ('blue' | 'red' | 'green' | 'navy'), lit=1 (fishing
// lamps glow at dusk: a boat heading out), sail=0/1, lamps=0/1 (override).
function boat(o = {}) {
  const M = mats();
  const B = new Builder();
  const R = rng(seedOf(o, 101));
  const STY = ['line', 'squid', 'net', 'small'];
  let style = o.style != null && o.style !== '' ? String(o.style) : STY[[0, 0, 1, 2, 2, 0, 3][R.int(0, 6)]];
  if (/^\d+$/.test(style)) style = STY[+style % STY.length];
  if (!STY.includes(style)) style = 'line';
  const small = style === 'small', squid = style === 'squid';
  const L = clamp(+(o.len ?? (small ? R.range(6.2, 7.6) : R.range(8.5, 12.5))), 5.5, 14);
  const lit = flag(o.lit);
  // lod=1: distant boat — fewer hull stations; small details go to a discarded builder
  // (they still consume the same random numbers, so a seed looks the same at both LODs)
  const lo = flag(o.lod), Bx = lo ? new Builder() : B;

  // paint scheme
  const STRIPE = { blue: [0.02, 0.12, 0.46], red: [0.52, 0.035, 0.03], green: [0.02, 0.25, 0.1], navy: [0.016, 0.03, 0.12] };
  const cname = STRIPE[o.color] ? o.color : R.pick(['blue', 'blue', 'blue', 'red', 'green', 'navy']);
  const stripe = STRIPE[cname];
  const wk = R.range(0.9, 0.97), white = [wk, wk, wk * R.range(0.96, 0.99)];
  const antifoul = R.pick([[0.4, 0.045, 0.03], [0.4, 0.045, 0.03], [0.32, 0.07, 0.05], [0.04, 0.1, 0.06], [0.025, 0.03, 0.06]]);
  const boot = R.chance(0.6) ? [0.02, 0.02, 0.024] : tint(stripe, 0.5);
  const deckCol = R.pick([[0.52, 0.58, 0.52], [0.55, 0.56, 0.55], [0.44, 0.54, 0.62], [0.64, 0.64, 0.6]]);
  const mastCol = R.chance(0.7) ? white : [0.55, 0.57, 0.6];
  const glass = R.chance(0.3) ? M.windowLit : M.glass;

  // --- hull
  const H = makeHull(L, R, R.range(0.85, 1.15));
  const tBow = small ? R.range(0.82, 0.86) : R.range(0.78, 0.83);
  const T = H.stations(lo ? 20 : 40, [tBow]);
  const hbw = clamp(0.3 + 0.022 * L, 0.42, 0.6);          // bulwark height above the deck
  const thk = 0.06;
  const yd = (t) => H.ys(t) - hbw;
  const xi = (t) => Math.max(H.sec(t).xAtY(yd(t)) - thk, 0.03);   // inner bulwark at deck level

  // skin: colour bands between horizontal paint lines (anti-fouling, boot-top, white,
  // sheer stripe, [white cap]) — the same bands continue across the transom
  const dS = R.chance(0.3) ? 0.035 : 0;
  const wS = R.chance(0.35) ? hbw * 0.9 : R.range(0.1, 0.2);
  const bandCol = [antifoul, boot, white, stripe, white], bandN = lo ? [2, 1, 2, 1, 1] : [4, 1, 5, 2, 1];
  const nb = dS > 0 ? 5 : 4;
  const bounds = (S) => {
    const b = [S.yb, -0.03, 0.11, S.ys - dS - wS, S.ys - dS, S.ys];
    for (let i = 1; i < b.length; i++) b[i] = clamp(Math.max(b[i], b[i - 1]), S.yb, S.ys);
    b[nb] = S.ys;
    return b;
  };
  for (let k = 0; k < nb; k++) {
    for (const side of [1, -1]) {
      const rows = [], nrm = [], uv = [];
      for (const t of T) {
        const S = H.sec(t), b = bounds(S), s0 = S.sAtY(b[k]), s1 = S.sAtY(b[k + 1]);
        const r = [], n = [], w = [];
        for (let j = 0; j <= bandN[k]; j++) {
          const s = lerp(s0, s1, j / bandN[k]), p = H.P(t, s, side);
          r.push(p); n.push(H.N(t, s, side)); w.push([p[2], p[1]]);
        }
        rows.push(r); nrm.push(n); uv.push(w);
      }
      addGrid(B, M.frp, rows, { nrm, uv }, bandCol[k]);
    }
    const S = H.sec(0), b = bounds(S), s0 = S.sAtY(b[k]), s1 = S.sAtY(b[k + 1]), rows = [];
    for (let j = 0; j <= bandN[k]; j++) { const q = S.at(lerp(s0, s1, j / bandN[k])); rows.push([[-q[0], q[1], S.z], [q[0], q[1], S.z]]); }
    addGrid(B, M.frp, rows, { ref: [0, 0, -1] }, bandCol[k]);
  }

  // bulwarks, cap rail, deck, raised forecastle, transom inside
  const TD = T.filter((t) => t <= tBow + 1e-9), TF = T.filter((t) => t >= tBow - 1e-9);
  const inner = tint(white, 0.96), capCol = R.chance(0.5) ? stripe : white;
  for (const side of [1, -1]) {
    addGrid(B, M.frp, TD.map((t) => { const S = H.sec(t); return [[side * Math.max(S.bs - thk, 0.03), S.ys, S.z], [side * xi(t), yd(t), S.z]]; }), { ref: [-side, 0, 0] }, inner);
    addGrid(B, M.frp, TD.map((t) => { const S = H.sec(t); return [[side * S.bs, S.ys, S.z], [side * Math.max(S.bs - thk, 0.03), S.ys, S.z]]; }), { ref: [0, 1, 0] }, capCol);
  }
  const dc = 0.02 + 0.012 * H.B, FX = [-1, -0.5, 0, 0.5, 1];
  addGrid(B, M.frp, TD.map((t) => { const z = H.sec(t).z, x = xi(t), y = yd(t); return FX.map((f) => [f * x, y + dc * (1 - f * f), z]); }), { ref: [0, 1, 0] }, deckCol);
  addGrid(B, M.frp, TF.map((t) => { const S = H.sec(t); return FX.map((f) => [f * S.bs, S.ys + dc * 0.5 * (1 - f * f), S.z]); }), { ref: [0, 1, 0] }, tint(deckCol, 1.06));
  {
    const S = H.sec(tBow), x1 = Math.max(S.bs - thk, 0.03), x0 = xi(tBow), y0 = yd(tBow);
    addGrid(B, M.frp, [[[-x1, S.ys, S.z], [0, S.ys + dc * 0.5, S.z], [x1, S.ys, S.z]], [[-x0, y0, S.z], [0, y0 + dc, S.z], [x0, y0, S.z]]], { ref: [0, 0, -1] }, inner);
  }
  {
    const S = H.sec(0), z = S.z + thk, x1 = Math.max(S.bs - thk, 0.03), x0 = xi(0), y0 = yd(0);
    addGrid(B, M.frp, [[[-x1, S.ys, z], [x1, S.ys, z]], [[-x0, y0, z], [x0, y0, z]]], { ref: [0, 0, 1] }, inner);
    addGrid(B, M.frp, [[[-x1, S.ys, S.z], [x1, S.ys, S.z]], [[-x1, S.ys, z], [x1, S.ys, z]]], { ref: [0, 1, 0] }, capCol);
  }

  // rubbing strake (防舷材) along the hull at deck level / under the stripe
  const yR = Math.max(hbw, dS + wS + 0.03);
  const TS = T.filter((t) => { const S = H.sec(t); return t <= 0.985 && S.ys - yR - 0.05 > S.yb + 0.08; });
  const strakeCol = R.chance(0.5) ? [0.07, 0.07, 0.075] : white;
  for (const side of [1, -1]) {
    const rows = TS.map((t) => {
      const S = H.sec(t), y = S.ys - yR, n = H.N(t, S.sAtY(y), side);
      const pu = H.P(t, S.sAtY(y + 0.035), side), pd = H.P(t, S.sAtY(y - 0.035), side);
      const o = scl([n[0], 0, n[2]], 0.045 / Math.max(Math.hypot(n[0], n[2]), 0.3));
      return [pu, add(pu, scl(o, 0.9)), add(pd, scl(o, 0.9)), pd];
    });
    if (rows.length > 1) {
      addGrid(B, M.frp, rows, { ref: [side, 0, 0] }, strakeCol);
      poly(B, M.frp, rows[0], [0, 0, -1], strakeCol);
      poly(B, M.frp, rows[rows.length - 1], [0, 0, 1], strakeCol);
    }
  }
  // scuppers (排水口) at deck level with rust run-off below
  const nSc = Math.max(3, Math.round(L * 0.45));
  for (const side of [1, -1]) for (let k = 0; k < nSc; k++) {
    const t = lerp(0.1, tBow - 0.05, (k + 0.5) / nSc), y0 = yd(t) + 0.02, dz = 0.08 / L;
    const q = (tt, y, off) => { const s = H.sec(tt).sAtY(y); return add(H.P(tt, s, side), scl(H.N(tt, s, side), off)); };
    poly(Bx, M.rubber, [q(t - dz, y0, 0.006), q(t + dz, y0, 0.006), q(t + dz, y0 + 0.06, 0.006), q(t - dz, y0 + 0.06, 0.006)], [side, 0, 0]);
    if (R.chance(0.6)) {
      const y1 = Math.max(y0 - R.range(0.18, 0.45), 0.12), dw = 0.012 / L;
      poly(Bx, M.frp, [q(t - dw, y1, 0.003), q(t + dw, y1, 0.003), q(t + dw * 2.2, y0, 0.003), q(t - dw * 2.2, y0, 0.003)], [side, 0, 0], [0.7, 0.58, 0.46]);
    }
  }

  // name and registration number on both sides of the bow, name on the transom
  const sd = Math.abs(Math.floor(+(o.seed ?? 1))), DC = decals(), nameE = DC.names[sd % NN], regE = DC.regs[(sd * 7 + 3) % NR];
  const ink = R.chance(0.85) ? [0.012, 0.012, 0.016] : tint(stripe, 0.6);
  // yLo(t): bottom of the text at station t (constant = horizontal, or following the sheer)
  const hullText = (E, yLo, hgt, tFront, side, col) => {
    // walk aft along the hull at mid-height to lay out the text by arc length
    const ym = (t) => yLo(t) + hgt / 2, len = hgt * E.aspect, pts = [tFront];
    let acc = 0, t = tFront, prev = H.P(t, H.sec(t).sAtY(ym(t)), side);
    const arc = [0];
    while (acc < len && t > 0.05) { t -= 0.004; const p = H.P(t, H.sec(t).sAtY(ym(t)), side); acc += vlen(sub(p, prev)); prev = p; pts.push(t); arc.push(acc); }
    const n = 14, rows = [], uv = [];
    for (let i = 0; i <= n; i++) {
      const a = (len * i) / n;
      let k = 1;
      while (k < arc.length - 1 && arc[k] < a) k++;
      const tt = lerp(pts[k - 1], pts[k], clamp((a - arc[k - 1]) / Math.max(arc[k] - arc[k - 1], 1e-6), 0, 1));
      const S = H.sec(tt), u = side > 0 ? lerp(E.u0, E.u1, i / n) : lerp(E.u1, E.u0, i / n);
      const row = [], w = [];
      for (const [y, v] of [[yLo(tt), E.vb], [yLo(tt) + hgt / 2, lerp(E.vb, E.vt, 0.5)], [yLo(tt) + hgt, E.vt]]) {
        const s2 = S.sAtY(y);
        row.push(add(H.P(tt, s2, side), scl(H.N(tt, s2, side), 0.007)));
        w.push([u, v]);
      }
      rows.push(row); uv.push(w);
    }
    addGrid(Bx, DC.mat, rows, { uv, ref: [side, 0, 0] }, col);
  };
  {
    const hR = clamp(0.1 + 0.006 * L, 0.13, 0.2), hN = hR * 1.15, bot = 0.16;
    // front end: behind the stem at the text's height
    let tf = 0.93;
    while (tf > 0.7 && H.yb(tf) > bot - 0.05) tf -= 0.005;
    tf = Math.min(tf - 0.035 - 0.25 / L, 0.88);
    // the sheer (and the strake under it) falls going aft: take the lowest point over the text
    let top = Infinity;
    for (let t = tf; t > tf - (hN * NAMES[0].length * 1.1) / L; t -= 0.01) top = Math.min(top, H.ys(t) - yR - 0.07);
    const room = top - bot;
    const onBand = wS > 0.3 && room < hN + hR + 0.1;
    const hB = Math.min(hN, wS * 0.5);
    for (const side of [1, -1]) {
      if (onBand) hullText(nameE, (t) => H.ys(t) - dS - wS / 2 - hB / 2, hB, Math.min(tf + 0.02, 0.9), side, [0.86, 0.86, 0.84]);
      if (!onBand && room > hN + hR + 0.1) {
        hullText(nameE, () => top - hN - 0.01, hN, tf, side, ink);
        hullText(regE, () => top - hN - hR - 0.08, hR, tf - 0.01, side, ink);
      } else if (room > hR + 0.04) hullText(regE, () => top - hR - Math.min(0.06, (room - hR) / 2), hR, tf, side, ink);
    }
    // transom: the name, centred
    const S = H.sec(0), th = clamp(0.1 + 0.006 * L, 0.12, 0.2), tw = th * nameE.aspect, yt = Math.max(0.2, S.ys - yR - 0.1 - th);
    const zt = S.z - 0.005, E = nameE;
    if (tw < S.bs * 1.5) addGrid(Bx, DC.mat, [[[tw / 2, yt, zt], [-tw / 2, yt, zt]], [[tw / 2, yt + th, zt], [-tw / 2, yt + th, zt]]], { uv: [[[E.u0, E.vb], [E.u1, E.vb]], [[E.u0, E.vt], [E.u1, E.vt]]], ref: [0, 0, -1] }, ink);
  }

  // --- wheelhouse
  const whLen = small ? R.range(1.2, 1.5) : clamp(L * R.range(0.17, 0.21), 1.5, 2.6);
  const whT = { line: R.range(0.4, 0.48), squid: R.range(0.33, 0.4), net: R.range(0.2, 0.27), small: R.range(0.3, 0.4) }[style];
  const zc = -L / 2 + L * whT, z0 = zc - whLen / 2, z1 = zc + whLen / 2;
  let fy = Infinity, fx = Infinity;
  for (let k = 0; k <= 6; k++) { const t = (z0 + L / 2 + (whLen * k) / 6) / L; fy = Math.min(fy, yd(t)); fx = Math.min(fx, xi(t)); }
  const walk = small ? 0.1 : clamp(0.15 + 0.012 * L, 0.24, 0.32);
  const door = R.chance(0.5) ? 1 : -1;
  const cab = cabin(B, M, {
    z0, z1, w: clamp(2 * (fx - walk), 0.9, 2.6), hgt: small ? R.range(1.45, 1.6) : R.range(1.75, 1.95), y0: fy - 0.03,
    rake: R.range(0.2, 0.32), taper: R.range(0.04, 0.08), R, col: white, trim: stripe, glass, door, band: R.chance(0.4),
  });
  const top = cab.top;
  // side lights: red to port (+x), green to starboard (-x)
  for (const s of [1, -1]) {
    const v = 0.84, y = cab.y0 + cab.hgt * v, x = s * (lerp(cab.a, cab.b, v) + 0.045), z = cab.z1 - (cab.z1 - cab.zf) * v - 0.12;
    B.box(s > 0 ? M.navR : M.navG, { w: 0.06, h: 0.09, d: 0.12, pos: [x, y, z] });
    B.box(M.darkMetal, { w: 0.075, h: 0.02, d: 0.14, pos: [x, y + 0.055, z] });
    B.box(M.darkMetal, { w: 0.075, h: 0.11, d: 0.012, pos: [x, y, z - 0.066] });
  }
  // exhaust stack beside the wheelhouse
  {
    const s = -door, x = s * (cab.a + 0.07), z = cab.z0 + 0.2, sc = R.chance(0.5);
    rod(B, sc ? M.metal : M.darkMetal, [x, fy + 0.25, z], [x, top + 0.5, z], 0.055, WHITE, { seg: 8 });
    rod(B, sc ? M.metal : M.darkMetal, [x, top + 0.5, z], [x, top + 0.62, z - 0.12], 0.055, WHITE, { seg: 8 });
  }
  if (R.chance(0.75)) lifeRingInto(Bx, M, TRS(add(cab.fp(cab.faces.back, door > 0 ? 0.27 : 0.73, 0.3), [0, 0, -0.05])), small ? 0.22 : 0.27);
  // main mast on the roof: yard with all-round lights, masthead light, GPS, whip
  const mz = squid ? (cab.rz0 + cab.rz1) / 2 : cab.rz1 - 0.42;
  const hm = (small ? 0.72 : 1) * R.range(2.2, 3.1);
  rod(B, M.frp, [0, top, mz], [0, top + hm, mz], 0.05, mastCol, { r2: 0.035, seg: 8 });
  const yy = top + hm * 0.74, bw = small ? 0.4 : R.range(0.5, 0.72);
  rod(B, M.frp, [-bw, yy, mz], [bw, yy, mz], 0.022, mastCol, { seg: 5 });
  for (const s of [-1, 1]) B.cyl(M.lamp, { r: 0.04, h: 0.1, seg: 8, pos: [s * bw * 0.88, yy + 0.07, mz] });
  B.cyl(M.frp, { r: 0.06, r2: 0.035, h: 0.07, seg: 8, pos: [bw * 0.4, yy + 0.055, mz], color: white });
  B.cyl(M.lamp, { r: 0.045, h: 0.12, seg: 8, pos: [0, top + hm + 0.06, mz] });
  B.cyl(M.darkMetal, { r: 0.052, h: 0.02, seg: 8, pos: [0, top + hm + 0.13, mz] });
  rod(B, M.frp, [0, top + hm + 0.14, mz], [0, top + hm + 0.95, mz], 0.009, WHITE, { r2: 0.005, seg: 4 });
  // stays from the mast head to the roof corners
  for (const s of [-1, 1]) rod(Bx, M.darkMetal, [0, top + hm * 0.7, mz], [s * (cab.b + 0.02), top, cab.rz0 + 0.1], 0.005, WHITE, { seg: 3, open: true });
  // radar dome: on a bracket in front of the mast or on a roof pedestal
  const dome = lathe([[0.001, 0], [0.29, 0], [0.3, 0.02], [0.3, 0.13], [0.26, 0.2], [0.16, 0.245], [0.001, 0.26]], 14);
  if (R.chance(0.55)) {
    const yr = top + hm * 0.42;
    B.box(M.frp, { w: 0.5, h: 0.03, d: 0.56, pos: [0, yr, mz + 0.25], color: mastCol });
    B.geo(M.frp, dome, TRS([0, yr + 0.015, mz + 0.27]), white);
  } else {
    const zr = cab.rz0 + 0.42;
    B.cyl(M.frp, { r: 0.06, h: 0.25, pos: [0, top + 0.125, zr], color: white });
    B.geo(M.frp, dome, TRS([0, top + 0.25, zr]), white);
  }
  // whip antennas (leaning) and a searchlight
  const nw = R.int(1, 3);
  for (let k = 0; k < nw; k++) {
    const s = k % 2 ? -1 : 1, x = s * (cab.b - 0.1), z = cab.rz0 + 0.15 + k * 0.12;
    const hw = R.range(2, 3.6) * (small ? 0.7 : 1), lean = unit([s * R.range(0.05, 0.22), 1, -R.range(0.05, 0.3)]);
    Bx.cyl(M.frp, { r: 0.028, h: 0.18, pos: [x, top + 0.09, z], color: [0.18, 0.18, 0.18] });
    rod(Bx, M.frp, [x, top + 0.17, z], add([x, top + 0.17, z], scl(lean, hw)), 0.012, white, { r2: 0.005, seg: 4 });
  }
  {
    const sx = R.range(-0.3, 0.3), sz = cab.rz1 - 0.22;
    rod(Bx, M.darkMetal, [sx, top, sz], [sx, top + 0.14, sz], 0.018);
    rod(Bx, M.frp, [sx, top + 0.21, sz - 0.1], [sx, top + 0.21, sz + 0.09], 0.075, white, { seg: 10 });
    rod(Bx, M.glass, [sx, top + 0.21, sz + 0.09], [sx, top + 0.21, sz + 0.1], 0.065, WHITE, { seg: 10 });
  }
  if (!small && L > 10.5 && R.chance(0.6)) {
    // life-raft canister on a cradle
    const zr = (cab.rz0 + cab.rz1) / 2 - (squid ? 0.5 : 0), xr = -door * (cab.b - 0.35);
    B.box(M.darkMetal, { w: 0.35, h: 0.08, d: 0.5, pos: [xr, top + 0.04, zr] });
    rod(B, M.frp, [xr, top + 0.25, zr - 0.35], [xr, top + 0.25, zr + 0.35], 0.19, [0.93, 0.93, 0.9], { seg: 10 });
  }

  if (!small && R.chance(0.45)) {
    // pipe railing around the wheelhouse roof
    const x = cab.b + 0.02, za = cab.rz0 + 0.04, zb = cab.rz1 - 0.06, yr = top + 0.32;
    const cn = [[x, za], [x, zb], [-x, zb], [-x, za]];
    for (let k = 0; k < 4; k++) {
      const [ax, az] = cn[k], [bx, bz] = cn[(k + 1) % 4];
      rod(Bx, M.metal, [ax, top, az], [ax, yr, az], 0.016, WHITE, { seg: 4 });
      if (k !== 1) rod(Bx, M.metal, [ax, yr, az], [bx, yr, bz], 0.016, WHITE, { seg: 4 });
    }
  }
  if (R.chance(0.35)) {
    // stainless bow rail around the forecastle
    const pts = [];
    for (const t of [tBow + 0.02, lerp(tBow, 1, 0.4), lerp(tBow, 1, 0.72)]) { const S = H.sec(t); pts.push([S.bs - 0.07, S.ys, S.z]); }
    const Sn = H.sec(0.985), tip = [0, Sn.ys + 0.5, Sn.z - 0.05];
    for (const s of [1, -1]) {
      let prev = null;
      for (const [x, y, z] of pts) {
        const a = [s * x, y, z], b = [s * x, y + 0.5, z];
        rod(Bx, M.metal, a, b, 0.016, WHITE, { seg: 4 });
        if (prev) rod(Bx, M.metal, prev, b, 0.016, WHITE, { seg: 4 });
        prev = b;
      }
      rod(Bx, M.metal, prev, tip, 0.016, WHITE, { seg: 4 });
    }
  }

  // --- masts fore and aft, stern sail (スパンカー), fishing lamps (集魚灯)
  const sail = o.sail != null ? flag(o.sail) : R.chance({ line: 0.85, squid: 0.25, net: 0.35, small: 0.6 }[style]);
  const lamps = o.lamps != null ? flag(o.lamps) : squid || R.chance({ line: 0.3, net: 0.12, small: 0.2 }[style]);
  const fwdMast = squid || (lamps && R.chance(0.5)) || R.chance(0.25);
  const deckAt = (z) => yd(clamp((z + L / 2) / L, 0, 1));
  const yW = fy + (small ? 1.95 : 2.35);        // lamp wire height
  let fm = null;
  if (fwdMast) {
    const tf = tBow - 0.035, zf = -L / 2 + L * tf, yb0 = yd(tf), hf = (squid ? R.range(3.6, 4.4) : R.range(2.6, 3.4)) * (small ? 0.75 : 1);
    rod(B, M.frp, [0, yb0, zf], [0, yb0 + hf, zf], 0.05, mastCol, { r2: 0.035, seg: 8 });
    const yb = yb0 + hf * 0.8, w2 = squid ? 0.7 : 0.45;
    rod(B, M.frp, [-w2, yb, zf], [w2, yb, zf], 0.02, mastCol, { seg: 5 });
    B.cyl(M.lamp, { r: 0.04, h: 0.1, seg: 8, pos: [0, yb0 + hf + 0.05, zf] });
    fm = { z: zf, y: yb0, h: hf };
  }
  let sm = null;
  if (sail || squid) {
    const zs = -L / 2 + 0.32, yb0 = deckAt(zs), hs = small ? R.range(2.2, 2.6) : R.range(3.0, 3.8);
    const mtop = [0, yb0 + hs, zs - hs * 0.1];
    rod(B, M.frp, [0, yb0, zs], mtop, 0.04, mastCol, { r2: 0.028, seg: 6 });
    B.cyl(M.lamp, { r: 0.035, h: 0.08, seg: 8, pos: add(mtop, [0, 0.05, 0]) });
    sm = { z: zs, y: yb0, h: hs, top: mtop };
    if (sail) {
      const tack = mix([0, yb0, zs], mtop, 0.28), clew = [0, tack[1] + 0.15, -L / 2 - R.range(0.9, 1.4) * (small ? 0.7 : 1)];
      rod(B, M.frp, tack, clew, 0.02, mastCol, { seg: 5 });
      const head = mix([0, yb0, zs], mtop, 0.97);
      const sailCol = R.pick([[0.86, 0.84, 0.76], [0.86, 0.84, 0.76], [0.75, 0.2, 0.08], [0.2, 0.35, 0.6]]);
      poly(B, M.canvas, [add(tack, [0, 0.04, -0.03]), add(clew, [0, 0.03, 0.06]), add(head, [0, 0, -0.035])], [1, 0, 0], sailCol);
      rod(B, M.darkMetal, head, clew, 0.004, WHITE, { seg: 3, open: true });
    }
  }
  let lampC = null;
  if (lamps) {
    const rowsX = squid && L >= 10 ? [-0.32, 0.32] : [0];
    const kb = squid ? 1.1 : 0.9;
    for (const x of rowsX) {
      const aF = fm ? [x, yW, fm.z] : [x, yW, Math.min(cab.rz1 + 2.2, -L / 2 + L * (tBow - 0.02))];
      if (!fm) rod(B, M.frp, [x, deckAt(aF[2]), aF[2]], add(aF, [0, 0.1, 0]), 0.03, mastCol, { seg: 6 });
      const aM = [x, yW, mz];
      lampC = [0, yW - 0.3, (aF[2] + (sm && squid ? sm.z : mz)) / 2];
      const uEnd = 1 - (mz - cab.rz1 + 0.25) / Math.max(aF[2] - mz, 0.5);
      lampWire(B, M, aF, aM, { u0: 0.06, u1: clamp(uEnd, 0.1, 1), spacing: squid ? (rowsX.length > 1 ? 0.68 : 0.55) : 0.7, lit, k: kb });
      if (sm && squid) {
        const aS = [x, yW, sm.z - 0.1];
        const u1 = (cab.rz0 - 0.25 - aS[2]) / Math.max(mz - aS[2], 0.5);
        lampWire(B, M, aS, aM, { u0: 0.08, u1: clamp(u1, 0.1, 1), spacing: rowsX.length > 1 ? 0.68 : 0.55, lit, k: kb });
      }
    }
  }

  // --- deck gear
  // bow bitt and stern cleats (mooring points)
  const tb = lerp(tBow, 1, 0.33), Sb = H.sec(tb);
  rod(B, M.frp, [0, Sb.ys, Sb.z], [0, Sb.ys + 0.28, Sb.z], 0.065, white, { seg: 8 });
  rod(B, M.frp, [-0.15, Sb.ys + 0.2, Sb.z], [0.15, Sb.ys + 0.2, Sb.z], 0.028, white, { seg: 5 });
  const S0 = H.sec(0.03);
  for (const s of [1, -1]) B.box(M.metal, { w: 0.045, h: 0.05, d: 0.24, pos: [s * (S0.bs - thk / 2), S0.ys + 0.025, S0.z] });
  B.cyl(M.lamp, { r: 0.035, h: 0.08, seg: 8, pos: [0, H.ys(0) + 0.06, -L / 2 + 0.03] });   // stern light
  // coiled rope on the forecastle
  if (R.chance(0.7)) {
    const tc = lerp(tBow, 1, 0.12), Sc = H.sec(tc);
    const rc = R.pick([[0.85, 0.8, 0.65], [0.75, 0.55, 0.1], [0.1, 0.25, 0.6]]);
    for (let k = 0; k < 2; k++) Bx.geo(M.matte, torus(0.19 - k * 0.04, 0.026, 4, 11), TRS([R.range(-0.1, 0.1) * Sc.bs, Sc.ys + 0.05 + k * 0.04, Sc.z - 0.05], [Math.PI / 2, 0, 0]), rc);
  }
  // fish-hold hatches forward of the wheelhouse
  if (!squid) {
    const zh0 = cab.rz1 + 0.35, zh1 = -L / 2 + L * tBow - 0.3;
    for (let z = zh0; z + 0.6 < zh1 && z < zh0 + 2.2; z += 1.0) B.box(M.frp, { w: 0.75, h: 0.1, d: 0.6, pos: [0, deckAt(z + 0.3) + dc + 0.03, z + 0.3], color: tint(deckCol, 1.2) });
  }
  // squid jigging machines (イカ釣り機) along the bulwarks
  if (squid) {
    const nj = Math.max(3, Math.round(L * 0.33)), jigCol = R.pick([[0.85, 0.86, 0.86], [0.4, 0.55, 0.72], [0.3, 0.42, 0.6]]);
    for (let k = 0; k < nj; k++) {
      const t = lerp(0.1, tBow - 0.04, (k + 0.5) / nj);
      if (Math.abs(-L / 2 + L * t - zc) < whLen / 2 + 0.3) continue;
      for (const s of [1, -1]) {
        const S = H.sec(t), x = s * (xi(t) - 0.22), y = yd(t), z = S.z;
        rod(Bx, M.darkMetal, [x, y, z], [x, y + 0.42, z], 0.035, WHITE, { seg: 5 });
        Bx.box(M.frp, { w: 0.24, h: 0.22, d: 0.2, pos: [x, y + 0.53, z], color: jigCol });
        rod(Bx, M.metal, [x, y + 0.53, z - 0.2], [x, y + 0.53, z + 0.2], 0.012, WHITE, { seg: 3 });
        for (const e of [-1, 1]) rod(Bx, M.metal, [x, y + 0.53, z + e * 0.1], [x, y + 0.53, z + e * 0.19], 0.12, WHITE, { seg: 7 });
        rod(Bx, M.metal, [x + s * 0.08, y + 0.62, z], [s * (S.bs + 0.5), S.ys + 0.3, z], 0.013, WHITE, { seg: 3 });
        rod(Bx, M.rubber, [s * (S.bs + 0.5), S.ys + 0.3, z - 0.05], [s * (S.bs + 0.5), S.ys + 0.3, z + 0.05], 0.035, WHITE, { seg: 5 });
      }
    }
  }
  // net hauler (ネットローラー) at the starboard bow for gillnetters
  if (style === 'net') {
    const t = tBow - 0.06, S = H.sec(t), x = -(xi(t) - 0.25), y = yd(t);
    const mc = R.pick([[0.6, 0.62, 0.64], [0.75, 0.55, 0.05], [0.15, 0.3, 0.55]]);
    rod(B, M.paint, [x, y, S.z], [x, y + 0.55, S.z], 0.08, mc, { seg: 8 });
    rod(B, M.paint, [x - 0.2, y + 0.65, S.z], [x + 0.2, y + 0.65, S.z], 0.17, mc, { seg: 10 });
    rod(B, M.rubber, [-(S.bs - 0.02), S.ys + 0.06, S.z - 0.2], [-(S.bs - 0.02), S.ys + 0.06, S.z + 0.2], 0.06, WHITE, { seg: 8 });
    // a heap of net on the aft deck
    const za = (-L / 2 + thk + cab.z0) / 2, ya = deckAt(za) + dc * 0.6, rz = Math.max((cab.z0 - (-L / 2 + thk)) / 2 - 0.1, 0.3);
    const nc = R.pick([[0.14, 0.42, 0.16], [0.1, 0.3, 0.62], [0.8, 0.32, 0.07]]);
    const bl = blobGeo([R.range(-0.15, 0.15), ya, za], Math.min(xi(0.1) - 0.1, 0.85), 0.34, Math.min(rz, 0.7), 0.22, R.range(0, 50), 2);
    B.geo(M.net, bl.g, null, nc);
    for (let k = 0; k < 6; k++) {
      const a = k * 1.05 + R.range(0, 0.4), d = [Math.cos(a) * 0.75, 0.62, Math.sin(a) * 0.75];
      rod(Bx, M.paint, bl.surf(d), add(bl.surf(d), [d[2] * 0.08, 0.02, -d[0] * 0.08]), 0.04, ORANGE, { seg: 6 });
    }
  }
  // crates on the aft deck
  if (style !== 'net' && R.chance(0.7)) {
    const n = R.int(1, 3), za = lerp(-L / 2 + 0.6, cab.z0 - 0.4, R.range(0.2, 0.8));
    for (let k = 0; k < n; k++) {
      const x = (k - (n - 1) / 2) * 0.46, z = za + R.range(-0.08, 0.08);
      if (Math.abs(x) > xi(0.1) - 0.3) continue;
      crateInto(Bx, M, TRS([x, deckAt(z) + dc * (1 - (x / xi(0.1)) ** 2), z], [0, Math.PI / 2 + R.range(-0.2, 0.2), 0]), { col: R.chance(0.7) ? [0.06, 0.22, 0.6] : [0.8, 0.6, 0.05], open: true });
    }
  }
  // canopy (オーニング) over the aft deck
  if (style === 'line' && R.chance(0.4)) {
    const za = -L / 2 + 0.5, zb = cab.z0 - 0.05, yh = cab.y0 + cab.hgt - 0.1, xw = Math.min(xi(0.15), cab.b + 0.2);
    for (const s of [-1, 1]) rod(B, M.metal, [s * (xw - 0.05), deckAt(za), za], [s * (xw - 0.05), yh, za], 0.022, WHITE, { seg: 5 });
    const cc = R.pick([[0.12, 0.3, 0.62], [0.85, 0.85, 0.82], [0.2, 0.45, 0.3]]);
    poly(B, M.canvas, [[-xw, yh, za - 0.1], [xw, yh, za - 0.1], [xw, yh + 0.02, zb], [-xw, yh + 0.02, zb]], [0, 1, 0], cc);
  }
  // tyre fenders hanging over both sides
  const tyreCol = [0.9, 0.9, 0.9], ropeCol = R.pick([[0.85, 0.82, 0.7], [0.75, 0.55, 0.1], [0.1, 0.3, 0.7]]);
  const tyres = [];
  for (const side of [1, -1]) {
    const nt = R.int(2, small ? 2 : 3);
    for (let k = 0; k < nt; k++) {
      const t = lerp(0.18, 0.72, (k + 0.5) / nt) + R.range(-0.03, 0.03), S = H.sec(t);
      const tr = R.range(0.25, 0.3), y = clamp(S.ys * 0.52, 0.32, 0.62);
      const s = S.sAtY(y), n = H.N(t, s, side), p = H.P(t, s, side), c = add(p, scl(n, tr * 0.34 + 0.012));
      Bx.geo(M.rubber, tireGeo(tr, tr * 0.62, 12), along(c, n), tyreCol);
      rod(Bx, M.matte, [side * (S.bs - 0.02), S.ys + 0.015, S.z], add(c, [0, tr * 0.8, 0]), 0.011, ropeCol, { seg: 4 });
      tyres.push(c);
    }
  }
  // orange buoys: on the aft deck, and one as a bow fender
  const nBuoy = R.chance(0.7) ? R.int(1, 2) : 0;
  for (let k = 0; k < nBuoy; k++) {
    const z = -L / 2 + 0.45 + k * 0.45, x = (k ? -1 : 1) * (xi(0.05) - 0.25);
    buoyInto(Bx, M, TRS([x, deckAt(z) + 0.19, z]), { r: 0.19, seg: 10, seam: false });
  }
  if (R.chance(0.35)) {
    const side = R.chance(0.5) ? 1 : -1, t = 0.86, S = H.sec(t), y = clamp(S.ys * 0.55, 0.4, 0.9);
    const s = S.sAtY(y), c = add(H.P(t, s, side), scl(H.N(t, s, side), 0.2));
    buoyInto(Bx, M, TRS(c), { r: 0.18, seg: 10, seam: false });
    rod(Bx, M.matte, [side * (S.bs - 0.02), S.ys + 0.01, S.z], add(c, [0, 0.22, 0]), 0.01, ropeCol, { seg: 4 });
  }

  const g = B.build({ name: 'boat' });
  let maxY = 0;
  g.traverse((m) => { if (m.isMesh) maxY = Math.max(maxY, m.geometry.boundingBox.max.y); });
  const Sbow = H.sec(1);
  g.userData = {
    kind: 'boat', style, color: cname, length: L, beam: H.B, draft: -H.yK, height: maxY,
    freeboard: H.ys(0), deckY: yd(0.4), bowZ: Sbow.z, sternZ: -L / 2,
    // mooring points (local): bow bitt head, stern cleats port / starboard
    moor: { bow: [0, Sb.ys + 0.2, Sb.z], sternP: [S0.bs - thk / 2, S0.ys + 0.05, S0.z], sternS: [-(S0.bs - thk / 2), S0.ys + 0.05, S0.z] },
    fenders: lo ? [] : tyres,
    // centre of the fishing-lamp array (for an optional PointLight on a lit boat), else null
    lamps: lampC, lit, lod: lo,
    // suggested motion in the calm harbour: heave (m), roll / pitch (rad), period (s)
    bob: { heave: 0.03 + 0.004 * (12 - L), roll: 0.02 + 0.003 * (12 - L), pitch: 0.008, period: 2.6 + L * 0.12 },
  };
  return g;
}

// ---------------------------------------------------------------------------
// tetrapod(opts): seed, size (height when resting on three legs, default 2.2 m), center=1
function tetrapod(o = {}) {
  const M = mats(), B = new Builder();
  const R = rng(seedOf(o, 131));
  const S = clamp(+(o.size ?? 2.2), 1, 5);
  const rt = 0.13 * S, rb = 0.235 * S, Lg = (S - rt * 0.9428) / (4 / 3);
  const c = [0, Lg / 3 + rt * 0.9428, 0];
  const a0 = R.range(0, Math.PI * 2);
  const dirs = [[0, 1, 0], ...[0, 1, 2].map((k) => { const a = a0 + (k * 2 * Math.PI) / 3; return [Math.sin(a) * 0.9428, -1 / 3, Math.cos(a) * 0.9428]; })];
  const base = R.range(0.86, 1.0), warm = R.range(0.98, 1.04), col = [base * warm, base, base / warm];
  const ch = 0.03 * S, leg = lathe([[rb, 0], [lerp(rb, rt, 0.5), Lg * 0.5], [rt, Lg - ch], [rt - ch, Lg], [0.001, Lg]], 16);
  dirs.forEach((d, k) => B.geo(M.concrete, leg, along(c, d), k ? tint(col, R.range(0.84, 0.94)) : col));
  B.geo(M.concrete, sphere(rb * 0.96, 12, 8), TRS(c), col);
  const g = B.build({ name: 'tetrapod' });
  // center=1: origin at the block's centre (for piles with random 3D rotations)
  const centered = flag(o.center);
  if (centered) for (const m of g.children) { m.geometry.translate(0, -c[1], 0); m.geometry.computeBoundingBox(); m.geometry.computeBoundingSphere(); }
  g.userData = { kind: 'tetrapod', size: S, centre: centered ? [0, 0, 0] : c, restY: c[1], legs: dirs, legLength: Lg, tipRadius: rt };
  return g;
}

// lighthouse(opts): color 'white' (green light) | 'red' (red light), h (6-9 m), light
function lighthouse(o = {}) {
  const M = mats(), B = new Builder();
  const red = String(o.color ?? '').toLowerCase() === 'red';
  const Ht = clamp(+(o.h ?? o.height ?? 7.5), 6, 9);
  const body = red ? [0.62, 0.045, 0.035] : [0.95, 0.95, 0.93];
  const lampMat = (o.light ? String(o.light) === 'red' : red) ? M.navR : M.navG;
  const trim = red ? [0.93, 0.93, 0.9] : [0.14, 0.15, 0.16];
  // concrete plinth
  B.cyl(M.concrete, { r: 1.3, h: 0.5, seg: 28, pos: [0, 0.25, 0], color: [0.95, 0.94, 0.9] });
  B.cyl(M.concrete, { r: 1.02, r2: 0.98, h: 0.18, seg: 28, pos: [0, 0.59, 0], color: [0.9, 0.9, 0.87] });
  // tower
  const y0 = 0.68, yG = Ht - 1.85, r0 = 0.72, r1 = 0.52;
  const rAt = (y) => lerp(r0, r1, (y - y0) / (yG - y0));
  B.cyl(M.paint, { r: r0, r2: r1, h: yG - y0, seg: 28, pos: [0, (y0 + yG) / 2, 0], color: body, open: true });
  // door (curved panel) and a small window, facing +z
  const dh = 1.6;
  B.geo(M.paint, worldUV(new THREE.CylinderGeometry(rAt(y0 + dh) + 0.012, rAt(y0) + 0.012, dh, 6, 1, true, -0.42, 0.84)), TRS([0, y0 + dh / 2, 0]), red ? [0.3, 0.03, 0.025] : [0.2, 0.26, 0.24]);
  B.geo(M.paint, worldUV(new THREE.CylinderGeometry(rAt(y0 + 1.1) + 0.02, rAt(y0 + 1.0) + 0.02, 0.1, 2, 1, true, 0.12, 0.08)), TRS([0, y0 + 1.05 - 0.2, 0]), [0.05, 0.05, 0.05]);
  const yw = lerp(y0, yG, 0.62);
  B.geo(M.glass, worldUV(new THREE.CylinderGeometry(rAt(yw + 0.25) + 0.01, rAt(yw - 0.25) + 0.01, 0.5, 2, 1, true, -0.2, 0.4)), TRS([0, yw, 0]));
  // gallery: flared corbel, floor, railing
  B.cyl(M.paint, { r: r1, r2: 0.99, h: 0.32, seg: 28, pos: [0, yG - 0.16, 0], color: body, open: true });
  B.cyl(M.paint, { r: 1.03, h: 0.12, seg: 28, pos: [0, yG + 0.06, 0], color: body });
  const yR = yG + 0.12, rr = 0.97;
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2;
    rod(B, M.paint, [Math.sin(a) * rr, yR, Math.cos(a) * rr], [Math.sin(a) * rr, yR + 0.88, Math.cos(a) * rr], 0.018, trim, { seg: 4 });
  }
  for (const h of [0.45, 0.88]) B.geo(M.paint, torus(rr, 0.022, 4, 36), TRS([0, yR + h, 0], [Math.PI / 2, 0, 0]), trim);
  // lantern: base, glass (lit at dusk), mullions, conical roof, vent ball, lightning rod
  B.cyl(M.paint, { r: 0.47, h: 0.34, seg: 20, pos: [0, yR + 0.17, 0], color: body });
  B.cyl(lampMat, { r: 0.4, h: 0.72, seg: 20, pos: [0, yR + 0.34 + 0.36, 0], open: true });
  B.cyl(M.darkMetal, { r: 0.39, h: 0.02, seg: 20, pos: [0, yR + 1.06, 0] });
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.26;
    B.box(M.darkMetal, { w: 0.035, h: 0.72, d: 0.035, pos: [Math.sin(a) * 0.405, yR + 0.7, Math.cos(a) * 0.405], rotY: a });
  }
  const yRf = yR + 1.06;
  B.cyl(M.paint, { r: 0.52, h: 0.05, seg: 20, pos: [0, yRf + 0.025, 0], color: trim });
  B.cyl(M.paint, { r: 0.5, r2: 0.1, h: 0.34, seg: 20, pos: [0, yRf + 0.05 + 0.17, 0], color: trim, open: true });
  B.geo(M.paint, sphere(0.09, 10, 6), TRS([0, yRf + 0.44, 0]), trim);
  rod(B, M.metal, [0, yRf + 0.5, 0], [0, yRf + 1.05, 0], 0.01, WHITE, { seg: 4 });
  // solar panel on the railing, and a ladder up the back (-z) outside the gallery
  B.box(M.darkMetal, { w: 0.62, h: 0.03, d: 0.46, pos: [0, yR + 1.0, 0.98], rot: [0.6, 0, 0] });
  B.box(M.glass, { w: 0.58, h: 0.012, d: 0.42, pos: [0, yR + 1.0 + 0.012, 0.98 + 0.008], rot: [0.6, 0, 0], color: [0.4, 0.5, 1.4] });
  const lz = -1.08, lx = 0.21, lc = red ? [0.8, 0.8, 0.78] : [0.35, 0.36, 0.37];
  for (const s of [-1, 1]) rod(B, M.paint, [s * lx, 0.5, lz], [s * lx, yR + 0.95, lz], 0.02, lc, { seg: 4 });
  for (let y = 0.8; y < yR + 0.8; y += 0.3) rod(B, M.paint, [-lx, y, lz], [lx, y, lz], 0.014, lc, { seg: 4 });
  for (let y = 1.4; y < yG - 0.3; y += 1.6) for (const s of [-1, 1]) rod(B, M.paint, [s * lx, y, lz], [s * 0.12, y, -rAt(y) + 0.02], 0.014, lc, { seg: 4 });
  const g = B.build({ name: 'lighthouse' });
  g.userData = { kind: 'lighthouse', height: yRf + 1.05, lampY: yR + 0.7, red, baseRadius: 1.3 };
  return g;
}

// bollard(opts): cast-iron mushroom mooring post (係船柱); size (scale), color 'black'|'yellow'
function bollard(o = {}) {
  const M = mats(), B = new Builder();
  const R = rng(seedOf(o, 211));
  const s = clamp(+(o.size ?? 1), 0.4, 3);
  const paint = o.color === 'yellow' ? [0.62, 0.46, 0.04] : tint([0.045, 0.045, 0.05], R.range(0.9, 1.2));
  const rust = [0.11, 0.07, 0.052];
  B.box(M.paint, { w: 0.58 * s, h: 0.05 * s, d: 0.58 * s, pos: [0, 0.025 * s, 0], color: rust });
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) B.cyl(M.darkMetal, { r: 0.028 * s, h: 0.04 * s, seg: 6, pos: [x * 0.22 * s, 0.065 * s, z * 0.22 * s] });
  const P = (arr) => arr.map(([r, y]) => [r * s, y * s]);
  B.geo(M.paint, lathe(P([[0.21, 0.05], [0.19, 0.075], [0.165, 0.11], [0.155, 0.2], [0.158, 0.3]]), 18), null, paint);
  B.geo(M.paint, lathe(P([[0.158, 0.3], [0.17, 0.35], [0.195, 0.385]]), 18), null, [0.085, 0.058, 0.045]);
  B.geo(M.paint, lathe(P([[0.195, 0.385], [0.25, 0.42], [0.275, 0.45], [0.27, 0.48], [0.235, 0.505], [0.15, 0.525], [0.001, 0.535]]), 18), null, paint);
  const g = B.build({ name: 'bollard' });
  g.userData = { kind: 'bollard', height: 0.535 * s, ropeY: 0.34 * s };
  return g;
}

// netPile(opts): seed, size (footprint, default 1.6 m)
function netPile(o = {}) {
  const M = mats(), B = new Builder();
  const R = rng(seedOf(o, 307));
  const S = clamp(+(o.size ?? 1.6), 0.6, 5);
  const COLS = [[0.2, 0.55, 0.22], [0.12, 0.32, 0.75], [0.8, 0.3, 0.05], [0.12, 0.42, 0.34], [0.75, 0.62, 0.1]];
  const n = R.int(4, 5), blobs = [];
  for (let k = 0; k < n; k++) {
    const big = k === 0, a = R.range(0, Math.PI * 2), d = big ? 0 : R.range(0.18, 0.34) * S;
    const rx = (big ? 0.4 : R.range(0.18, 0.28)) * S, rz = rx * R.range(0.75, 1.1), ry = (big ? 0.28 : R.range(0.12, 0.2)) * S;
    const c = [Math.cos(a) * d, 0.012 * S, Math.sin(a) * d];
    const bl = blobGeo(c, rx, ry, rz, 0.3, R.range(0, 100), big ? 3 : 2);
    B.geo(M.net, bl.g, null, k === 0 ? R.pick(COLS.slice(0, 2)) : R.pick(COLS));
    blobs.push(bl);
  }
  // float line: floats along a meandering path over the heap
  const fcol = R.pick([ORANGE, [0.8, 0.62, 0.05], [0.85, 0.85, 0.82]]);
  const nf = R.int(9, 14);
  let az = R.range(0, Math.PI * 2), el = R.range(0.3, 0.6);
  for (let k = 0; k < nf; k++) {
    const bl = blobs[k < nf / 2 ? 0 : blobs.length - 1];
    az += R.range(0.25, 0.5); el = clamp(el + R.range(-0.25, 0.25), 0.25, 1.2);
    const d = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
    const p = bl.surf(d);
    rod(B, M.paint, add(p, scl([d[0], 0, d[2]], 0.02)), add(p, [d[2] * 0.1, 0.03, -d[0] * 0.1]), 0.045, fcol, { r2: 0.045, seg: 6 });
  }
  // a few rope strands draped over the heap
  for (let k = 0; k < 2; k++) {
    const bl = blobs[k % blobs.length], pts = [];
    let a = R.range(0, Math.PI * 2);
    const e0 = R.range(0.1, 0.4);
    for (let i = 0; i <= 8; i++) {
      const e = Math.sin((i / 8) * Math.PI) * 1.1 + e0 * (1 - Math.sin((i / 8) * Math.PI));
      a += 0.18;
      const d = [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
      pts.push(new THREE.Vector3(...add(bl.surf(d), scl(d, 0.015))));
    }
    const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 20, 0.016 * Math.max(S / 1.6, 0.7), 5, false);
    B.geo(M.matte, worldUV(tube), null, R.pick([[0.8, 0.5, 0.05], [0.85, 0.83, 0.72], [0.1, 0.3, 0.7], ORANGE]));
  }
  const g = B.build({ name: 'netPile' });
  g.userData = { kind: 'netPile', size: S };
  return g;
}

// crates(opts): seed, stacks (1-4), max (max crates per stack)
function crates(o = {}) {
  const M = mats(), B = new Builder();
  const R = rng(seedOf(o, 401));
  const ns = clamp(Math.round(+(o.stacks ?? R.int(2, 3))), 1, 4), mx = clamp(Math.round(+(o.max ?? 5)), 1, 8);
  const w = 0.64, d = 0.42, h = 0.2;
  const pick = () => { const r = R(); return r < 0.6 ? [0.06, 0.22, 0.6] : r < 0.85 ? [0.82, 0.6, 0.05] : R.pick([[0.1, 0.4, 0.15], [0.85, 0.3, 0.05], [0.85, 0.85, 0.82]]); };
  for (let i = 0; i < ns; i++) {
    const nh = R.int(1, mx), x0 = (i - (ns - 1) / 2) * (d + 0.05), rot0 = Math.PI / 2 + R.range(-0.08, 0.08);
    for (let k = 0; k < nh; k++) {
      const X = TRS([x0 + R.range(-0.012, 0.012), k * (h - 0.012), R.range(-0.015, 0.015)], [0, rot0 + R.range(-0.04, 0.04), 0]);
      crateInto(B, M, X, { w, d, h, col: pick(), open: k === nh - 1 });
    }
  }
  const g = B.build({ name: 'crates' });
  g.userData = { kind: 'crates', crate: [w, h, d] };
  return g;
}

// buoy(opts): r (default 0.19), color ('orange'|'red'|'yellow'|'white'), type 'ball' |
// 'float' (net float) | 'glass' (glass float in a rope net), float=1 (waterline at y = 0)
function buoy(o = {}) {
  const M = mats(), B = new Builder();
  const COL = { orange: ORANGE, red: [0.6, 0.04, 0.03], yellow: [0.82, 0.62, 0.04], white: [0.85, 0.85, 0.82] };
  const col = COL[o.color] ?? ORANGE, type = o.type ?? 'ball';
  const fl = flag(o.float);
  let r = clamp(+(o.r ?? (type === 'float' ? 0.07 : 0.19)), 0.05, 1.2);
  if (type === 'float') {
    // cylindrical gill-net float with a rope through it, lying on its side
    const hl = r * 2.2, y = fl ? r * 0.35 : r;
    B.geo(M.paint, lathe([[0.25 * r, -hl], [0.8 * r, -hl * 0.97], [r, -hl * 0.6], [r * 1.02, 0], [r, hl * 0.6], [0.8 * r, hl * 0.97], [0.25 * r, hl]], 10), TRS([0, y, 0], [0, 0, Math.PI / 2]), col);
    rod(B, M.matte, [-hl * 1.8, y, 0], [hl * 1.8, y, 0], r * 0.12, [0.8, 0.78, 0.65], { seg: 4 });
  } else if (type === 'glass') {
    const y = fl ? r * 0.5 : r;
    B.geo(M.glassFloat, sphere(r, 16, 11), TRS([0, y, 0]));
    for (let k = 0; k < 3; k++) B.geo(M.matte, torus(r * 1.01, r * 0.025, 3, 20), TRS([0, y, 0], [0, (k * Math.PI) / 3, 0]), [0.55, 0.45, 0.3]);
    B.geo(M.matte, torus(r * 0.87, r * 0.025, 3, 18), TRS([0, y + r * 0.5, 0], [Math.PI / 2, 0, 0]), [0.55, 0.45, 0.3]);
    B.geo(M.matte, torus(r * 1.01, r * 0.025, 3, 20), TRS([0, y, 0], [Math.PI / 2, 0, 0]), [0.55, 0.45, 0.3]);
  } else {
    buoyInto(B, M, TRS([0, fl ? r * 0.55 : r, 0]), { r, col, seg: 20 });
  }
  const g = B.build({ name: 'buoy' });
  g.userData = { kind: 'buoy', r, type };
  return g;
}

// harborShed(opts): seed, w, d — small corrugated hut, door facing +z, mono-pitch roof
function harborShed(o = {}) {
  const M = mats(), B = new Builder();
  const R = rng(seedOf(o, 503));
  const W = clamp(+(o.w ?? R.range(3.2, 4.2)), 2, 8), D = clamp(+(o.d ?? R.range(2.4, 3.0)), 1.8, 6);
  const hf = R.range(2.35, 2.6), hb = hf - D * R.range(0.1, 0.16);
  const wallCol = R.pick([[0.45, 0.58, 0.72], [0.82, 0.8, 0.72], [0.64, 0.64, 0.62], [0.6, 0.32, 0.24], [0.48, 0.62, 0.5]]);
  const roofCol = R.pick([[0.32, 0.45, 0.62], [0.62, 0.62, 0.6], [0.58, 0.26, 0.19]]);
  const trimCol = [0.88, 0.88, 0.86];
  const y0 = 0.12, hx = W / 2, hz = D / 2;
  B.box(M.concrete, { w: W + 0.3, h: y0, d: D + 0.3, pos: [0, y0 / 2, 0], color: [0.9, 0.9, 0.86] });
  // walls: outer faces only (the door is shut)
  poly(B, M.corrugated, [[-hx, y0, hz], [hx, y0, hz], [hx, hf, hz], [-hx, hf, hz]], [0, 0, 1], wallCol);
  poly(B, M.corrugated, [[hx, y0, -hz], [-hx, y0, -hz], [-hx, hb, -hz], [hx, hb, -hz]], [0, 0, -1], wallCol);
  for (const s of [-1, 1]) poly(B, M.corrugated, [[s * hx, y0, -hz], [s * hx, y0, hz], [s * hx, hf, hz], [s * hx, hb, -hz]], [s, 0, 0], wallCol);
  // splashed dirt along the bottom of the walls
  const dk = mix(wallCol, [0.25, 0.22, 0.2], 0.45), sk = 0.004, hs = R.range(0.25, 0.4);
  poly(B, M.corrugated, [[-hx, y0, hz + sk], [hx, y0, hz + sk], [hx, y0 + hs, hz + sk], [-hx, y0 + hs, hz + sk]], [0, 0, 1], dk);
  poly(B, M.corrugated, [[hx, y0, -hz - sk], [-hx, y0, -hz - sk], [-hx, y0 + hs, -hz - sk], [hx, y0 + hs, -hz - sk]], [0, 0, -1], dk);
  for (const s of [-1, 1]) poly(B, M.corrugated, [[s * (hx + sk), y0, -hz], [s * (hx + sk), y0, hz], [s * (hx + sk), y0 + hs, hz], [s * (hx + sk), y0 + hs, -hz]], [s, 0, 0], dk);
  // corner trims and base flashing
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const hh = z > 0 ? hf : hb;
    B.box(M.paint, { w: 0.07, h: hh - y0, d: 0.07, pos: [x * hx, (y0 + hh) / 2, z * hz], color: trimCol });
  }
  // roof: corrugated sheet on the slope, overhanging; fascia along the front
  const Ls = Math.hypot(D, hf - hb), pitch = Math.atan2(hf - hb, D), u = [0, (hf - hb) / Ls, D / Ls], nrm = [0, D / Ls, -(hf - hb) / Ls];
  const ovF = 0.32, ovB = 0.2, ovS = 0.16, sc = (-ovB + Ls + ovF) / 2;
  const rc = add(add([0, hb, -hz], scl(u, sc)), scl(nrm, 0.03));
  B.box(M.corrugated, { w: W + 2 * ovS, h: 0.035, d: Ls + ovF + ovB, pos: rc, rot: [-pitch, 0, 0], color: roofCol });
  const fe = add(add([0, hb, -hz], scl(u, Ls + ovF)), scl(nrm, -0.02));
  B.box(M.paint, { w: W + 2 * ovS + 0.02, h: 0.12, d: 0.03, pos: fe, rot: [-pitch * 0, 0, 0], color: trimCol });
  // gutter and downpipe at the low (back) edge
  const ge = add(add([0, hb, -hz], scl(u, -ovB)), [0, -0.06, 0]);
  rod(B, M.paint, [-hx - ovS, ge[1], ge[2]], [hx + ovS, ge[1], ge[2]], 0.05, trimCol, { seg: 6 });
  const dpx = (R.chance(0.5) ? 1 : -1) * (hx - 0.2);
  rod(B, M.paint, [dpx, ge[1], ge[2]], [dpx, y0 + 0.1, -hz - 0.08], 0.035, trimCol, { seg: 6 });
  // sliding door on a rail, with a window and a handle
  const dw = 0.95, dh = 1.9, dx = R.range(-0.25, 0.25) * (W - dw);
  const doorCol = R.pick([[0.3, 0.38, 0.34], [0.72, 0.72, 0.7], [0.25, 0.33, 0.48], [0.5, 0.36, 0.25]]);
  B.box(M.paint, { w: dw, h: dh, d: 0.04, pos: [dx, y0 + dh / 2 + 0.02, hz + 0.035], color: doorCol });
  B.box(M.glass, { w: dw * 0.6, h: 0.45, d: 0.01, pos: [dx, y0 + dh * 0.72, hz + 0.058] });
  B.box(M.darkMetal, { w: 0.03, h: 0.2, d: 0.03, pos: [dx + (dw / 2 - 0.1) * (dx > 0 ? -1 : 1), y0 + 1.0, hz + 0.07] });
  B.box(M.metal, { w: dw * 2.1, h: 0.06, d: 0.06, pos: [dx, y0 + dh + 0.07, hz + 0.04] });
  // side window (aluminium frame)
  const wx = hx + 0.01, wz = R.range(-0.25, 0.25) * D, ww = 0.9, wh = 0.7, wy = 1.55;
  B.box(M.glass, { w: 0.01, h: wh, d: ww, pos: [wx, wy, wz] });
  for (const dz of [-ww / 2, 0, ww / 2]) B.box(M.metal, { w: 0.035, h: wh + 0.05, d: 0.04, pos: [wx + 0.01, wy, wz + dz] });
  for (const dy of [-wh / 2, wh / 2]) B.box(M.metal, { w: 0.035, h: 0.04, d: ww + 0.04, pos: [wx + 0.01, wy + dy, wz] });
  // light over the door
  B.box(M.darkMetal, { w: 0.22, h: 0.04, d: 0.16, pos: [dx, y0 + dh + 0.32, hz + 0.1] });
  B.box(M.lamp, { w: 0.16, h: 0.06, d: 0.1, pos: [dx, y0 + dh + 0.27, hz + 0.1] });
  // buoys hanging on the wall
  const nbuoy = R.int(0, 3);
  for (let k = 0; k < nbuoy; k++) {
    const bx = dx > 0 ? -hx + 0.35 + k * 0.42 : hx - 0.35 - k * 0.42;
    if (Math.abs(bx - dx) < dw / 2 + 0.25) continue;
    const by = R.range(1.3, 1.7);
    rod(B, M.matte, [bx, by + 0.5, hz + 0.03], [bx, by + 0.2, hz + 0.2], 0.01, [0.85, 0.8, 0.65], { seg: 4 });
    buoyInto(B, M, TRS([bx, by, hz + 0.2]), { r: 0.17, col: R.chance(0.7) ? ORANGE : [0.82, 0.62, 0.04], seg: 12 });
  }
  const g = B.build({ name: 'harborShed' });
  g.userData = { kind: 'harborShed', w: W, d: D, h: hf + 0.1 };
  return g;
}

// tire(opts): r (outer radius, default 0.3), flat=1 (lying), rope (m of rope above, 0 = none)
function tire(o = {}) {
  const M = mats(), B = new Builder();
  const r = clamp(+(o.r ?? 0.3), 0.15, 0.7), w = r * 0.6;
  if (flag(o.flat)) B.geo(M.rubber, tireGeo(r, w, 22), TRS([0, w / 2, 0]), [0.9, 0.9, 0.9]);
  else {
    B.geo(M.rubber, tireGeo(r, w, 22), TRS([0, r, 0], [Math.PI / 2, 0, 0]), [0.9, 0.9, 0.9]);
    const rope = +(o.rope ?? 0.6);
    if (rope > 0) {
      const ri = r * 0.55, top = [0, 2 * r + rope, 0], col = [0.85, 0.82, 0.7];
      for (const s of [-1, 1]) {
        rod(B, M.matte, [0, r + ri, 0], [0, 2 * r + 0.02, s * w * 0.55], 0.012, col, { seg: 4 });
        rod(B, M.matte, [0, 2 * r + 0.02, s * w * 0.55], top, 0.012, col, { seg: 4 });
      }
    }
  }
  const g = B.build({ name: 'tire' });
  g.userData = { kind: 'tire', r };
  return g;
}

function withStats(fn) {
  return (o = {}) => {
    const t0 = performance.now();
    const g = fn(o);
    if (flag(o.stats)) {
      let tris = 0;
      const per = [];
      g.traverse((m) => { if (m.isMesh) { const n = m.geometry.attributes.position.count / 3; tris += n; per.push(`${m.material.name}:${n}`); } });
      console.warn(`[boats] ${g.name}: ${tris} tris, ${g.children.length} meshes, ${(performance.now() - t0).toFixed(0)} ms (${per.join(' ')})`, JSON.stringify(g.userData, (k, v) => (typeof v === 'number' ? +v.toFixed(3) : v)));
    }
    return g;
  };
}

export const MODELS = Object.fromEntries(Object.entries({ boat, tetrapod, lighthouse, bollard, netPile, crates, buoy, harborShed, tire }).map(([k, f]) => [k, withStats(f)]));
export { makeHull };
