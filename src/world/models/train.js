// train: the railway — a single-car diesel railcar (after JR キハ32 / キハ40 / キハ54),
// a track builder for an arbitrary polyline, and the little unmanned seaside station
// of Yumesaki (夢崎). See index.js for the conventions.
//
//   MODELS.train({ dir, lights, doors, dest })  car centre at rail-top height, length along z,
//                                               dir: which end leads (+1 = +z); userData.setDoors(k, side)
//   MODELS.track({ wood, train })               60 m straight demo of buildTrack
//   MODELS.station()                            track centreline x = 0 (rail top y = 0) along z,
//                                               platform on +x, ramp at the -z end
//   MODELS.stationScene({ curve, doors, dest })  viewer demo: station + track + car
//   trackPath(points)                           smoothed centreline, at(s) -> { p, t, n, yaw }
//   buildTrack(points, opts)                    single track along [[x, y, z], ...] (y = rail top)
//   placeOnTrack(car, trackOrPath, s, { reverse })   put a car on the track at arc length s
//   fitToTrack(model, trackOrPath, s0, { reverse })  place the station and bend it along the line
import * as THREE from 'three';
import { Builder, boxGeometry, worldUV } from '../builder.js';
import { materials, texturedMaterial, registerNight, tnoise, tfbm, clamp01, hashf } from '../lib.js';
import { prep } from '../materials.js';
import { rng } from '../noise.js';

const WHITE = [1, 1, 1];
const lin = (r, g, b) => [r, g, b].map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));

// ---------------------------------------------------------------------------------
// Small geometry toolkit: quads with explicit winding / normals / metre UVs.
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function autoUV(p, n) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  if (ay >= ax && ay >= az) return [p[0], p[2]];
  if (ax >= az) return [p[2], p[1]];
  return [p[0], p[1]];
}

class GW {
  constructor() { this.P = []; this.N = []; this.T = []; }
  get empty() { return this.P.length === 0; }
  vert(p, n, t) { this.P.push(p[0], p[1], p[2]); this.N.push(n[0], n[1], n[2]); this.T.push(t[0], t[1]); }
  // Quad a, b, c, d; the winding is fixed so the face points along n (the facing hint,
  // also the normal unless per-vertex normals ns are given). ts: optional per-vertex UVs.
  quad(a, b, c, d, n, ns = null, ts = null) {
    if (dot(cross(sub(b, a), sub(c, a)), n) < 0) {
      [b, d] = [d, b];
      if (ns) ns = [ns[0], ns[3], ns[2], ns[1]];
      if (ts) ts = [ts[0], ts[3], ts[2], ts[1]];
    }
    const N4 = ns || [n, n, n, n];
    const T4 = ts || [a, b, c, d].map((p, i) => autoUV(p, N4[i]));
    this.vert(a, N4[0], T4[0]); this.vert(b, N4[1], T4[1]); this.vert(c, N4[2], T4[2]);
    this.vert(a, N4[0], T4[0]); this.vert(c, N4[2], T4[2]); this.vert(d, N4[3], T4[3]);
  }
  tri(a, b, c, n, ts = null) {
    if (dot(cross(sub(b, a), sub(c, a)), n) < 0) { [b, c] = [c, b]; if (ts) ts = [ts[0], ts[2], ts[1]]; }
    const T3 = ts || [a, b, c].map((p) => autoUV(p, n));
    this.vert(a, n, T3[0]); this.vert(b, n, T3[1]); this.vert(c, n, T3[2]);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.T, 2));
    return g;
  }
}

// Point on a wall plane: side walls (axis 'x') run along z, end walls (axis 'z') along x.
const wp = (axis, u, v, w) => (axis === 'x' ? [w, v, u] : [u, v, w]);
const wn = (axis, s) => (axis === 'x' ? [s, 0, 0] : [0, 0, s]);
const un = (axis, s) => (axis === 'x' ? [0, 0, s] : [s, 0, 0]);
const uniq = (a) => [...new Set(a.map((x) => Math.round(x * 1e5) / 1e5))].sort((p, q) => p - q);

// A flat wall with rectangular openings. Outer face on the plane axis = sign * c, facing
// `sign`; inner face (lining) at sign * (c - t) between v = inV0..inV1; reveals close the
// wall thickness around every opening. holes: [u0, u1, v0, v1].
function holeWall(outGW, inGW, revGW, { axis, sign, c, t, u0, u1, v0, v1, holes, inV0 = v0, inV1 = v1 }) {
  const us = uniq([u0, u1, ...holes.flatMap((h) => [h[0], h[1]])].filter((u) => u >= u0 && u <= u1));
  const vs = uniq([v0, v1, inV0, inV1, ...holes.flatMap((h) => [h[2], h[3]])].filter((v) => v >= v0 && v <= v1));
  const wo = sign * c, wi = sign * (c - t), no = wn(axis, sign), ni = wn(axis, -sign);
  for (let i = 0; i < us.length - 1; i++) {
    for (let j = 0; j < vs.length - 1; j++) {
      const ua = us[i], ub = us[i + 1], va = vs[j], vb = vs[j + 1];
      const um = (ua + ub) / 2, vm = (va + vb) / 2;
      if (holes.some((h) => um > h[0] && um < h[1] && vm > h[2] && vm < h[3])) continue;
      outGW.quad(wp(axis, ua, va, wo), wp(axis, ub, va, wo), wp(axis, ub, vb, wo), wp(axis, ua, vb, wo), no);
      if (inGW && vm > inV0 && vm < inV1) inGW.quad(wp(axis, ua, va, wi), wp(axis, ub, va, wi), wp(axis, ub, vb, wi), wp(axis, ua, vb, wi), ni);
    }
  }
  if (!revGW) return;
  for (const [ha, hb, hc, hd] of holes) {
    revGW.quad(wp(axis, ha, hd, wo), wp(axis, hb, hd, wo), wp(axis, hb, hd, wi), wp(axis, ha, hd, wi), [0, -1, 0]);
    revGW.quad(wp(axis, ha, hc, wo), wp(axis, hb, hc, wo), wp(axis, hb, hc, wi), wp(axis, ha, hc, wi), [0, 1, 0]);
    revGW.quad(wp(axis, ha, hc, wo), wp(axis, ha, hd, wo), wp(axis, ha, hd, wi), wp(axis, ha, hc, wi), un(axis, 1));
    revGW.quad(wp(axis, hb, hc, wo), wp(axis, hb, hd, wo), wp(axis, hb, hd, wi), wp(axis, hb, hc, wi), un(axis, -1));
  }
}

// Vertical cylindrical strip (plan-view corner), angles a0..a1 measured from +z towards +x.
function arcWall(gw, cx, cz, r, a0, a1, y0, y1, seg, outward = true) {
  const s = outward ? 1 : -1;
  for (let i = 0; i < seg; i++) {
    const a = a0 + (a1 - a0) * i / seg, b = a0 + (a1 - a0) * (i + 1) / seg;
    const na = [Math.sin(a) * s, 0, Math.cos(a) * s], nb = [Math.sin(b) * s, 0, Math.cos(b) * s];
    const pa = (y) => [cx + r * Math.sin(a), y, cz + r * Math.cos(a)], pb = (y) => [cx + r * Math.sin(b), y, cz + r * Math.cos(b)];
    const nm = norm([na[0] + nb[0], 0, na[2] + nb[2]]);
    gw.quad(pa(y0), pb(y0), pb(y1), pa(y1), nm, [na, nb, nb, na]);
  }
}

// Parametric surface P(s, t) on an ns x nt grid, smooth normals by finite differences,
// oriented to agree with out(p). uv(s, t) -> [u, v] (metres).
function paramSurf(gw, P, s0, s1, ns, t0, t1, nt, out, uv) {
  const S = (i) => s0 + (s1 - s0) * i / ns, T = (j) => t0 + (t1 - t0) * j / nt;
  const es = (s1 - s0) * 1e-3, et = (t1 - t0) * 1e-3;
  const N = (s, t) => {
    const sa = Math.max(Math.min(s0, s1), Math.min(Math.max(s0, s1), s - es)), sb = Math.max(Math.min(s0, s1), Math.min(Math.max(s0, s1), s + es));
    const ta = Math.max(Math.min(t0, t1), Math.min(Math.max(t0, t1), t - et)), tb = Math.max(Math.min(t0, t1), Math.min(Math.max(t0, t1), t + et));
    let n = norm(cross(sub(P(sb, t), P(sa, t)), sub(P(s, tb), P(s, ta))));
    const p = P(s, t);
    if (dot(n, out(p)) < 0) n = [-n[0], -n[1], -n[2]];
    return n;
  };
  for (let i = 0; i < ns; i++) {
    for (let j = 0; j < nt; j++) {
      const q = [[S(i), T(j)], [S(i + 1), T(j)], [S(i + 1), T(j + 1)], [S(i), T(j + 1)]];
      const p = q.map(([s, t]) => P(s, t));
      const n = q.map(([s, t]) => N(s, t));
      const hint = norm(n.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], [0, 0, 0]));
      if (Math.hypot(...sub(p[0], p[3])) < 1e-6 && Math.hypot(...sub(p[1], p[2])) < 1e-6) continue;
      gw.quad(p[0], p[1], p[2], p[3], hint, n, q.map(([s, t]) => uv(s, t)));
    }
  }
}

// Box in model space (min / max corners), metre UVs in model space.
function mbox(B, mat, x0, y0, z0, x1, y1, z1, color = WHITE) {
  const [ax, bx] = x0 < x1 ? [x0, x1] : [x1, x0], [ay, by] = y0 < y1 ? [y0, y1] : [y1, y0], [az, bz] = z0 < z1 ? [z0, z1] : [z1, z0];
  const g = boxGeometry(bx - ax, by - ay, bz - az);
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  worldUV(g);
  B.geo(mat, g, null, color);
}

// Lathe around the x axis: profile [[radius, x], ...].
function latheX(profile, seg) {
  const g = new THREE.LatheGeometry(profile.map(([r, x]) => new THREE.Vector2(r, x)), seg);
  g.rotateZ(-Math.PI / 2);
  worldUV(g);
  return g;
}

// Canvas helper (any size).
function cnv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function canvasTex(c, { srgb = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
const JP_SANS = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic", sans-serif';
const LAT_SANS = '"Helvetica Neue", Helvetica, Arial, "Archivo", sans-serif';

function setRepeat(m, pu, pv) {
  for (const t of [m.map, m.normalMap, m.roughnessMap]) if (t) t.repeat.set(1 / pu, 1 / pv);
}
// texture coordinate helpers for non-tiling painters: canvas row v -> model coordinate
// (textures are uploaded flipped: canvas top row = t 1), wrapped around 0.
const wrapc = (t, period) => (t >= 0.5 ? t - 1 : t) * period;

// ---------------------------------------------------------------------------------
// Railcar dimensions (metres). z: along the car, front faces at ±HL; y: 0 = rail top.
const K = {
  HL: 9.25, HW: 1.425, R: 0.2, YB: 1.02, YE: 3.22, YR: 3.70, YF: 1.22, YC: 3.0, TW: 0.05,
  sill: 1.92, wtop: 2.78, meet: 2.35, pitch: 1.25, winW: 0.95,
  door: [7.05, 7.95], doorTop: 2.96,
  cab: [8.35, 8.88], cabY: [1.98, 2.74],
  fwin: [0.47, 1.2], fwinY: [2.02, 2.86], fdoor: 0.37, fdoorY: [1.07, 2.93],
  bogie: 6.45, axle: 1.05, wr: 0.43,
  band: [1.56, 1.76], stripe: [1.44, 1.49],
  roofA: 0.45,  // length of the rounded roof ends
};
const BODY_PU = 20, BODY_PV = 4;   // body texture spans the whole car (u = z or x, v = y)
const ROOF_PU = 3.6, ROOF_PV = 20; // roof texture: u across (arc metres), v = z

// body paint: ivory with a blue band and stripe, grime rising from the bottom edge,
// rain streaks under the window corners and hand marks around the doors.
function bodyPainter(u, v) {
  const y = (1 - v) * BODY_PV, z = wrapc(u, BODY_PU);
  const n1 = tfbm(u, v, 12, 3, 201, 2), n2 = tnoise(u, v, 400, 202, 90);
  const band = (y >= K.band[0] && y < K.band[1]) || (y >= K.stripe[0] && y < K.stripe[1]);
  let c = band ? [0.13, 0.36, 0.66] : [0.90, 0.875, 0.78];
  const k = 0.96 + n1 * 0.07 + n2 * 0.012;
  c = c.map((x) => x * k);
  const az = Math.abs(z);
  let streak = 0;
  if (az < 6.1 && y < K.sill) {
    const wz = ((z % K.pitch) + K.pitch) % K.pitch, wi = Math.floor(z / K.pitch);
    const e = (a, w) => Math.exp(-(((wz - a) / w) ** 2));
    const fade = clamp01((K.sill - y) / 0.5) * clamp01(1 - (K.sill - y) / 0.75);
    streak = (e(0.15 + 0.02 * hashf(wi, 3), 0.02) * hashf(wi, 4) + e(1.10 - 0.02 * hashf(wi, 5), 0.02) * hashf(wi, 6)) * fade * (0.4 + 0.8 * clamp01(tnoise(u, v, 200, 207, 8) + 0.5));
  }
  const nearDoor = Math.exp(-(((az - 7.5) / 0.6) ** 2));
  const bottom = clamp01((1.5 - y) / 0.48) ** 1.5 * (0.8 + 0.6 * n1);
  const hands = nearDoor * Math.exp(-(((y - 1.7) / 0.35) ** 2)) * 0.25 * (0.6 + n1);
  // drips running down from the gutter at random places along the eave
  const ei = Math.floor(z / 0.29), ez = z - (ei + 0.5) * 0.29;
  let eave = 0;
  if (hashf(ei, 11) < 0.5) {
    const len = 0.12 + 0.55 * hashf(ei, 13), w = 0.012 + 0.016 * hashf(ei, 12);
    const x0 = (hashf(ei, 14) - 0.5) * 0.2 + Math.sin(y * 9 + ei) * 0.004;
    eave = Math.exp(-(((ez - x0) / w) ** 2)) * clamp01((y - (K.YE - len)) / len) * (y < K.YE ? 1 : 0);
  }
  const dirt = clamp01(bottom * 0.95 + hands + eave * 0.45);
  const D = [0.30, 0.25, 0.19], Rust = [0.36, 0.2, 0.1];
  c = c.map((x, i) => x * (1 - dirt * 0.6) + D[i] * dirt * 0.35);
  c = c.map((x, i) => x * (1 - streak * 0.28) + Rust[i] * streak * 0.2);
  // a faint ridge where the band's masking tape edges were
  const edge = [K.band[0], K.band[1], K.stripe[0], K.stripe[1]].some((e) => Math.abs(y - e) < 0.003) ? 0.03 : 0;
  return [...c, 0.5 + n2 * 0.04 + edge, 0.36 + dirt * 0.4 + streak * 0.2 + n1 * 0.05];
}

// roof: grey anti-slip coating, soot around the exhaust stack blown both ways, rust at seams
function roofPainter(u, v) {
  const xs = wrapc(u, ROOF_PU), z = wrapc(1 - v, ROOF_PV);
  const n1 = tfbm(u, v, 6, 4, 211, 30), n2 = tnoise(u, v, 300, 212, 900);
  const sootC = Math.exp(-(((z + 1.0) / 3.2) ** 2) - ((xs - 0.3) / 0.9) ** 2);
  const soot = clamp01(sootC * (0.8 + 0.5 * n1) + clamp01(tfbm(u, v, 4, 3, 213, 20) * 1.5) * 0.35);
  const seam = Math.abs(((z % 1.2) + 1.2) % 1.2 - 0.6) > 0.585 ? 1 : 0;
  const g = 0.40 * (0.9 + n1 * 0.18);
  let c = [g * 0.98, g, g * 1.02].map((x) => x * (1 - soot * 0.65));
  if (seam) c = c.map((x, i) => x * 0.85 + [0.05, 0.03, 0.02][i]);
  return [...c, 0.5 + n2 * 0.15 + seam * 0.2, 0.82 + soot * 0.1];
}

// underframe: black-grey grime, brown brake dust and rust spots
function underPainter(u, v) {
  const n1 = tfbm(u, v, 4, 4, 221), n2 = tnoise(u, v, 160, 222);
  const dust = clamp01(tfbm(u, v, 3, 3, 223) * 2 + 0.35);
  const rust = clamp01(tfbm(u, v, 8, 3, 224) * 3 - 0.55);
  let c = [0.1, 0.097, 0.094].map((x) => x * (0.85 + n1 * 0.4));
  c = c.map((x, i) => x * (1 - dust * 0.6) + [0.3, 0.24, 0.18][i] * dust * 0.6);
  c = c.map((x, i) => x * (1 - rust * 0.8) + [0.19, 0.12, 0.08][i] * rust * 0.8);
  return [...c, 0.5 + n2 * 0.2, 0.75 + dust * 0.15];
}

let TM = null;
const DEST = new Map();
function trainMats(dest) {
  const d = dest || 'かざみ';
  if (TM && !DEST.has(d)) {
    const dt = canvasTex(destCanvas(d));
    const m = prep(new THREE.MeshStandardMaterial({ name: 'kihaDest', color: 0xffffff, map: dt, emissive: 0xffffff, emissiveMap: dt, emissiveIntensity: 2.2, roughness: 0.3 }), null, 'kiha-dest');
    DEST.set(d, m);
  }
  if (TM) return { ...TM, dest: DEST.get(d) };
  TM = {};
  TM.body = texturedMaterial('kihaBody', { n: 1024, period: 1, normal: 0.6, fn: bodyPainter });
  setRepeat(TM.body, BODY_PU, BODY_PV);
  TM.roof = texturedMaterial('kihaRoof', { n: 512, period: 1, normal: 1.2, fn: roofPainter });
  setRepeat(TM.roof, ROOF_PU, ROOF_PV);
  TM.under = texturedMaterial('kihaUnder', { n: 512, period: 2, normal: 1.5, fn: underPainter }, { metalness: 0.25 });
  const plain = (name, o) => prep(new THREE.MeshStandardMaterial({ name, vertexColors: true, ...o }), null, 'kiha-' + name);
  // tinted glass: reflections added in full, what lies behind dimmed by (1 - opacity)
  TM.glass = plain('kihaGlass', { color: 0x0a0e10, roughness: 0.03, metalness: 0, transparent: true, opacity: 0.6, depthWrite: false, envMapIntensity: 2.0 });
  TM.glass.blending = THREE.CustomBlending;
  TM.glass.blendSrc = THREE.OneFactor;
  TM.glass.blendDst = THREE.OneMinusSrcAlphaFactor;
  TM.glass.userData.castShadow = false;
  // interior: plain, dim ambient (the body occludes most of the sky)
  TM.inside = plain('kihaInside', { color: 0xffffff, roughness: 0.85, envMapIntensity: 0.3 });
  TM.alu = plain('kihaAlu', { color: 0xc4c8cc, roughness: 0.32, metalness: 0.85 });
  TM.headOn = plain('kihaHeadOn', { color: 0xffffff, roughness: 0.2, emissive: 0xfff0d8, emissiveIntensity: 40 });
  TM.headOn.userData.castShadow = false;
  TM.headOff = plain('kihaHeadOff', { color: 0xd0d0c8, roughness: 0.12, metalness: 0.6 });
  TM.tailOn = plain('kihaTailOn', { color: 0xff3020, roughness: 0.2, emissive: 0xff1a0a, emissiveIntensity: 14 });
  TM.tailOn.userData.castShadow = false;
  TM.tailOff = plain('kihaTailOff', { color: 0x5a0c08, roughness: 0.15, metalness: 0.1 });
  TM.amber = plain('kihaAmber', { color: 0xd07020, roughness: 0.2 });
  TM.ceilLamp = plain('kihaCeilLamp', { color: 0xf4f6f8, roughness: 0.5, emissive: 0xeef4ff, emissiveIntensity: 0 });
  registerNight(TM.ceilLamp, 0.8);
  // destination roll sign (backlit, always on)
  const dt = canvasTex(destCanvas(d));
  TM.dest = plain('kihaDest', { color: 0xffffff, map: dt, emissive: 0xffffff, emissiveMap: dt, emissiveIntensity: 2.2, roughness: 0.3 });
  TM.dest.vertexColors = false;
  DEST.set(d, TM.dest);
  // decals with alpha: car number and the ワンマン plate
  TM.decal = plain('kihaDecal', { color: 0xffffff, map: canvasTex(decalCanvas()), alphaTest: 0.45, roughness: 0.45 });
  TM.decal.vertexColors = false;
  return { ...TM, dest: DEST.get(d) };
}

function destCanvas(dest = 'かざみ') {
  const c = cnv(512, 136), x = c.getContext('2d');
  x.fillStyle = '#0a0a0a'; x.fillRect(0, 0, 512, 136);
  x.fillStyle = '#f4f1ea'; x.textBaseline = 'middle'; x.textAlign = 'center';
  x.font = `700 58px ${JP_SANS}`;
  x.fillText('普通', 84, 70);
  x.fillStyle = '#6a6a6a'; x.fillRect(168, 20, 3, 96);
  x.fillStyle = '#f4f1ea';
  x.font = `700 ${dest.length > 3 ? Math.round(258 / dest.length) : 86}px ${JP_SANS}`;
  x.fillText(dest, 340, 72);
  return c;
}

// decal atlas (512 x 256): top half car number (dark on transparent), bottom half ワンマン plate
function decalCanvas() {
  const c = cnv(512, 256), x = c.getContext('2d');
  x.clearRect(0, 0, 512, 256);
  x.fillStyle = '#26282a'; x.textBaseline = 'middle'; x.textAlign = 'center';
  x.font = `600 76px ${JP_SANS}`;
  x.fillText('キハ 32  16', 256, 66);
  // ワンマン plate: white with a blue frame
  x.fillStyle = '#f2f2ee'; x.fillRect(96, 150, 320, 92);
  x.strokeStyle = '#1d4f9a'; x.lineWidth = 8; x.strokeRect(100, 154, 312, 84);
  x.fillStyle = '#1d4f9a'; x.font = `800 60px ${JP_SANS}`;
  x.fillText('ワンマン', 256, 198);
  return c;
}

// ---------------------------------------------------------------------------------
function buildTrain(opts = {}) {
  const dir = String(opts.dir ?? '1').trim().startsWith('-') ? -1 : 1;
  const lights = !['0', 'off', 'false'].includes(String(opts.lights ?? '1'));
  const M = materials(), X = trainMats(opts.dest);
  // build target (swapped while the door leaves are built as separate movable groups)
  let B = new Builder();
  let gws = new Map();
  const gw = (mat, color = WHITE) => {
    const k = mat.uuid + '|' + color.join(',');
    if (!gws.has(k)) gws.set(k, { mat, color, w: new GW() });
    return gws.get(k).w;
  };
  const flush = () => { for (const { mat, color, w } of gws.values()) if (!w.empty) B.geo(mat, w.geometry(), null, color); gws.clear(); };
  const separate = (name, fn) => {
    const saveB = B, saveG = gws;
    B = new Builder(); gws = new Map();
    fn(); flush();
    const g = B.build({ name });
    B = saveB; gws = saveG;
    return g;
  };
  const box = (mat, x0, y0, z0, x1, y1, z1, color = WHITE) => mbox(B, mat, x0, y0, z0, x1, y1, z1, color);
  const cyl = (mat, o) => B.cyl(mat, o);
  const { HL, HW, R, YB, YE, YR, YF, YC, TW } = K;
  const leaves = [];

  const C = {
    wall: lin(0.80, 0.77, 0.68), floor: lin(0.33, 0.36, 0.34), ceil: lin(0.86, 0.86, 0.83),
    seat: lin(0.19, 0.30, 0.50), head: lin(0.9, 0.9, 0.87), cab: lin(0.55, 0.68, 0.60),
    blind: lin(0.70, 0.64, 0.50), step: lin(0.42, 0.42, 0.40), rack: lin(0.5, 0.5, 0.5),
    skirt: lin(0.36, 0.37, 0.38), dark: [0.35, 0.35, 0.35], acUnit: lin(0.72, 0.74, 0.74),
  };
  const body = gw(X.body), inWall = gw(X.inside, C.wall), cabWall = gw(X.inside, C.cab);

  // ---- windows / doors layout
  const WIN = [];
  for (let k = 0; k < 5; k++) for (const s of [-1, 1]) { const c = s * (0.625 + K.pitch * k); WIN.push([c - K.winW / 2, c + K.winW / 2]); }
  WIN.sort((a, b) => a[0] - b[0]);
  const DOORS = [[-K.door[1], -K.door[0]], [K.door[0], K.door[1]]];
  const CABW = [[-K.cab[1], -K.cab[0]], [K.cab[0], K.cab[1]]];

  // ---- side walls
  for (const sx of [-1, 1]) {
    const holes = [
      ...WIN.map(([a, b]) => [a, b, K.sill, K.wtop]),
      ...DOORS.map(([a, b]) => [a, b, YB, K.doorTop]),
      ...CABW.map(([a, b]) => [a, b, K.cabY[0], K.cabY[1]]),
    ];
    holeWall(body, inWall, body, { axis: 'x', sign: sx, c: HW, t: TW, u0: -(HL - R), u1: HL - R, v0: YB, v1: YE, holes, inV0: YF, inV1: YC });
    // bottom edge and eave strip
    body.quad([sx * HW, YB, -(HL - R)], [sx * HW, YB, HL - R], [sx * (HW - TW), YB, HL - R], [sx * (HW - TW), YB, -(HL - R)], [0, -1, 0]);
    box(X.roof, sx * (HW - 0.01), YE - 0.035, -(HL - K.roofA), sx * (HW + 0.03), YE + 0.01, HL - K.roofA, [0.8, 0.8, 0.8]);

    // side windows: two-pane (upper pane lowers, lower pane rises); some open, some blinds down
    WIN.forEach(([z0, z1], i) => {
      const r = rng(1000 + i * 7 + (sx > 0 ? 3 : 0));
      const open = r() < 0.32 ? 0.16 + 0.22 * r() : 0;
      const blind = r() < 0.38 ? 0.12 + 0.35 * r() : 0;
      windowUnit(sx, z0, z1, open, blind);
    });
    // cab side window: single sliding pane
    for (const [z0, z1] of CABW) {
      const xg = sx * (HW - 0.022);
      gw(X.glass).quad([xg, K.cabY[0], z0], [xg, K.cabY[0], z1], [xg, K.cabY[1], z1], [xg, K.cabY[1], z0], [sx, 0, 0]);
      frame(X.alu, 'x', sx, HW - 0.035, HW - 0.008, z0, z1, K.cabY[0], K.cabY[1], 0.03);
      box(X.alu, sx * (HW - 0.035), K.cabY[0], (z0 + z1) / 2 - 0.015, sx * (HW - 0.008), K.cabY[1], (z0 + z1) / 2 + 0.015);
    }
    // door leaves (closed), steps, grab rails, door lamps
    for (const [z0, z1] of DOORS) {
      const zc = (z0 + z1) / 2;
      const leaf = separate('train:door', () => doorLeaf(sx, z0, z1));
      leaf.userData = { side: sx, slide: -Math.sign(zc) * (K.door[1] - K.door[0] + 0.02) };
      leaves.push(leaf);
      // step well (seen when the doors are open)
      const gs = gw(X.inside, C.step);
      gs.quad([sx * (HW - TW), YB + 0.01, z0], [sx * (HW - TW), YB + 0.01, z1], [sx * (HW - 0.42), YB + 0.01, z1], [sx * (HW - 0.42), YB + 0.01, z0], [0, 1, 0]);
      gs.quad([sx * (HW - 0.42), YB + 0.01, z0], [sx * (HW - 0.42), YB + 0.01, z1], [sx * (HW - 0.42), YF, z1], [sx * (HW - 0.42), YF, z0], [sx, 0, 0]);
      for (const zz of [z0, z1]) gs.quad([sx * (HW - TW), YB, zz], [sx * (HW - 0.42), YB, zz], [sx * (HW - 0.42), YF, zz], [sx * (HW - TW), YF, zz], [0, 0, zz === z0 ? 1 : -1]);
      // exterior boarding step for low platforms
      box(X.under, sx * 1.16, 0.70, z0 + 0.05, sx * 1.39, 0.73, z1 - 0.05, [0.9, 0.9, 0.9]);
      for (const zz of [z0 + 0.1, z1 - 0.1]) box(X.under, sx * 1.2, 0.73, zz - 0.02, sx * 1.24, YB, zz + 0.02);
      // grab rails either side of the door
      for (const zz of [z0 - 0.07, z1 + 0.07]) {
        cyl(X.alu, { r: 0.013, h: 0.95, seg: 6, pos: [sx * (HW + 0.045), 1.78, zz] });
        for (const yy of [1.33, 2.23]) box(X.alu, sx * HW, yy - 0.012, zz - 0.012, sx * (HW + 0.05), yy + 0.012, zz + 0.012);
      }
      // door indicator lamp above the door
      cyl(X.amber, { r: 0.035, h: 0.04, seg: 10, pos: [sx * (HW + 0.02), 3.08, zc], rot: [0, 0, Math.PI / 2] });
    }
    // car number decals near both ends
    for (const s of [-1, 1]) {
      const zc = s * 6.55, xd = sx * (HW + 0.002);
      const a = [xd, 1.25, zc - 0.34], b = [xd, 1.25, zc + 0.34], c = [xd, 1.37, zc + 0.34], d = [xd, 1.37, zc - 0.34];
      // text reads left to right: seen from +x the left end is +z
      const ts = sx > 0 ? [[1, 0.5], [0, 0.5], [0, 1], [1, 1]] : [[0, 0.5], [1, 0.5], [1, 1], [0, 1]];
      gw(X.decal).quad(a, b, c, d, [sx, 0, 0], null, ts);
    }
  }

  // one side window unit at x = sx * HW spanning z0..z1
  function windowUnit(sx, z0, z1, open, blind) {
    const { sill, wtop, meet } = K;
    const g = gw(X.glass);
    // upper pane, outer track
    const xo = sx * (HW - 0.018);
    g.quad([xo, meet, z0], [xo, meet, z1], [xo, wtop, z1], [xo, wtop, z0], [sx, 0, 0]);
    frame(X.alu, 'x', sx, HW - 0.028, HW - 0.006, z0, z1, meet - 0.02, wtop, 0.03);
    // lower pane, inner track (raised when open)
    const xi = sx * (HW - 0.036), y0 = sill + open, y1 = meet + 0.02 + open;
    g.quad([xi, y0, z0], [xi, y0, z1], [xi, y1, z1], [xi, y1, z0], [sx, 0, 0]);
    frame(X.alu, 'x', sx, HW - 0.046, HW - 0.028, z0, z1, y0, y1, 0.03);
    // sill inside + a small table
    const zc = (z0 + z1) / 2;
    box(X.inside, sx * (HW - TW), sill - 0.03, zc - 0.22, sx * (HW - 0.25), sill - 0.005, zc + 0.22, C.wall);
    if (blind > 0) {
      box(X.inside, sx * (HW - 0.075), wtop - blind, z0 + 0.02, sx * (HW - 0.065), wtop, z1 - 0.02, C.blind);
      box(X.alu, sx * (HW - 0.08), wtop - blind - 0.02, z0 + 0.03, sx * (HW - 0.06), wtop - blind, z1 - 0.03);
    }
  }

  // rectangular frame of bars (thickness th) around [u0,u1] x [v0,v1] between depths d0..d1 (from the centre plane)
  function frame(mat, axis, s, d0, d1, u0, u1, v0, v1, th, color = WHITE) {
    const P = (u, v, d) => (axis === 'x' ? [s * d, v, u] : [u, v, s * d]);
    const bx = (ua, va, ub, vb) => {
      const p = P(ua, va, d0), q = P(ub, vb, d1);
      box(mat, p[0], p[1], p[2], q[0], q[1], q[2], color);
    };
    bx(u0, v0, u1, v0 + th); bx(u0, v1 - th, u1, v1);
    bx(u0, v0 + th, u0 + th, v1 - th); bx(u1 - th, v0 + th, u1, v1 - th);
  }

  // side door leaf (closed), recessed into the opening
  function doorLeaf(sx, z0, z1) {
    const hole = [z0 + 0.19, z1 - 0.19, 2.05, 2.72], body = gw(X.body);
    holeWall(body, gw(X.inside, C.wall), body, { axis: 'x', sign: sx, c: HW - 0.025, t: 0.02, u0: z0, u1: z1, v0: YB, v1: K.doorTop, holes: [hole] });
    const xg = sx * (HW - 0.035);
    gw(X.glass).quad([xg, hole[2], hole[0]], [xg, hole[2], hole[1]], [xg, hole[3], hole[1]], [xg, hole[3], hole[0]], [sx, 0, 0]);
    frame(M.rubber, 'x', sx, HW - 0.04, HW - 0.02, hole[0], hole[1], hole[2], hole[3], 0.025);
    // the gap between the leaf and the frame, and the rubber seal at the closing edge
    box(M.rubber, sx * (HW - 0.045), YB + 0.02, z1 - 0.015, sx * (HW - 0.02), K.doorTop - 0.01, z1);
  }

  // ---- ends: front faces, corners, cab
  for (const sz of [-1, 1]) {
    const front = sz === dir;
    const Z = sz * HL;
    const fw = K.fwin, fy = K.fwinY;
    const holes = [
      [-fw[1], -fw[0], fy[0], fy[1]], [fw[0], fw[1], fy[0], fy[1]],
      [-K.fdoor, K.fdoor, K.fdoorY[0], K.fdoorY[1]],
    ];
    holeWall(body, cabWall, body, { axis: 'z', sign: sz, c: HL, t: TW, u0: -(HW - R), u1: HW - R, v0: YB, v1: YE, holes, inV0: YF, inV1: YC });
    body.quad([-(HW - R), YB, Z], [HW - R, YB, Z], [HW - R, YB, Z - sz * TW], [-(HW - R), YB, Z - sz * TW], [0, -1, 0]);
    // rounded corners (outer skin + inner lining)
    for (const sx of [-1, 1]) {
      const cx = sx * (HW - R), cz = sz * (HL - R);
      const a0 = sx > 0 ? (sz > 0 ? 0 : Math.PI / 2) : (sz > 0 ? -Math.PI / 2 : Math.PI);
      arcWall(body, cx, cz, R, a0, a0 + Math.PI / 2, YB, YE, 6, true);
      arcWall(cabWall, cx, cz, R - TW, a0, a0 + Math.PI / 2, YF, YC, 4, false);
      // bottom of the corner
      const gb = body;
      for (let i = 0; i < 6; i++) {
        const a = a0 + (Math.PI / 2) * i / 6, b = a0 + (Math.PI / 2) * (i + 1) / 6;
        gb.quad([cx + R * Math.sin(a), YB, cz + R * Math.cos(a)], [cx + R * Math.sin(b), YB, cz + R * Math.cos(b)],
          [cx + (R - TW) * Math.sin(b), YB, cz + (R - TW) * Math.cos(b)], [cx + (R - TW) * Math.sin(a), YB, cz + (R - TW) * Math.cos(a)], [0, -1, 0]);
      }
    }
    // front windows: glass, black rubber gaskets
    for (const sx of [-1, 1]) {
      const x0 = sx * fw[0], x1 = sx * fw[1];
      const zg = sz * (HL - 0.022);
      gw(X.glass).quad([x0, fy[0], zg], [x1, fy[0], zg], [x1, fy[1], zg], [x0, fy[1], zg], [0, 0, sz]);
      frame(M.rubber, 'z', sz, HL - 0.035, HL + 0.006, Math.min(x0, x1), Math.max(x0, x1), fy[0], fy[1], 0.035);
      // wipers resting diagonally: pivot at the outer bottom corner, arm pointing inwards and up
      const px = sx * (fw[1] - 0.14), py = fy[0] + 0.07, zw = sz * (HL + 0.02), th = 0.26, len = 0.5;
      const dx = -sx * Math.cos(th), dy = Math.sin(th);
      B.box(M.rubber, { w: len, h: 0.016, d: 0.012, pos: [px + dx * len / 2, py + dy * len / 2, zw], rot: [0, 0, -sx * th] });
      B.box(M.rubber, { w: len * 0.9, h: 0.012, d: 0.02, pos: [px + dx * len * 0.55, py + dy * len * 0.55 + 0.014, zw + sz * 0.01], rot: [0, 0, -sx * th] });
      cyl(M.darkMetal, { r: 0.022, h: 0.04, seg: 8, pos: [px, py, sz * (HL + 0.015)], rot: [Math.PI / 2, 0, 0] });
    }
    // gangway door (recessed) with its window
    {
      const hole = [-0.2, 0.2, 2.02, 2.7];
      holeWall(body, cabWall, body, { axis: 'z', sign: sz, c: HL - 0.03, t: 0.025, u0: -K.fdoor, u1: K.fdoor, v0: K.fdoorY[0], v1: K.fdoorY[1], holes: [hole] });
      const zg = sz * (HL - 0.042);
      gw(X.glass).quad([hole[0], hole[2], zg], [hole[1], hole[2], zg], [hole[1], hole[3], zg], [hole[0], hole[3], zg], [0, 0, sz]);
      frame(M.rubber, 'z', sz, HL - 0.05, HL - 0.025, hole[0], hole[1], hole[2], hole[3], 0.03);
      // door handle and hinge strips
      box(X.alu, 0.23, 1.78, sz * (HL - 0.03), 0.3, 1.82, sz * (HL + 0.005));
      for (const yy of [1.35, 2.6]) box(X.alu, -0.36, yy, sz * (HL - 0.03), -0.3, yy + 0.08, sz * (HL - 0.01));
      // grab handles either side of the gangway door
      for (const sx of [-1, 1]) {
        cyl(X.alu, { r: 0.012, h: 0.5, seg: 6, pos: [sx * 0.43, 1.62, sz * (HL + 0.05)] });
        for (const yy of [1.4, 1.84]) box(X.alu, sx * 0.42, yy - 0.01, sz * HL, sx * 0.44, yy + 0.01, sz * (HL + 0.055));
      }
    }
    // headlights (top corners), tail lights (on the band)
    for (const sx of [-1, 1]) {
      const hx = sx * 0.93, hy = 3.05;
      cyl(M.darkMetal, { r: 0.115, h: 0.05, seg: 20, pos: [hx, hy, sz * (HL + 0.02)], rot: [Math.PI / 2, 0, 0] });
      cyl(X.alu, { r: 0.1, h: 0.02, seg: 20, pos: [hx, hy, sz * (HL + 0.05)], rot: [Math.PI / 2, 0, 0] });
      cyl(front && lights ? X.headOn : X.headOff, { r: 0.083, h: 0.02, seg: 20, pos: [hx, hy, sz * (HL + 0.058)], rot: [Math.PI / 2, 0, 0] });
      const tx = sx * 1.07, ty = (K.band[0] + K.band[1]) / 2;
      cyl(M.darkMetal, { r: 0.08, h: 0.04, seg: 16, pos: [tx, ty, sz * (HL + 0.015)], rot: [Math.PI / 2, 0, 0] });
      cyl(!front && lights ? X.tailOn : X.tailOff, { r: 0.062, h: 0.02, seg: 16, pos: [tx, ty, sz * (HL + 0.04)], rot: [Math.PI / 2, 0, 0] });
      cyl(X.alu, { r: 0.07, h: 0.012, seg: 16, pos: [tx, ty, sz * (HL + 0.036)], rot: [Math.PI / 2, 0, 0] });
    }
    // destination sign above the gangway door
    box(X.body, -0.35, 2.965, sz * HL, 0.35, 3.19, sz * (HL + 0.035));
    {
      const zs = sz * (HL + 0.036);
      const p = [[-0.31, 2.99], [0.31, 2.99], [0.31, 3.165], [-0.31, 3.165]].map(([x, y]) => [x * sz, y, zs]);
      gw(X.dest).quad(p[0], p[1], p[2], p[3], [0, 0, sz], null, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
    // ワンマン plate behind the glass, lower corner of the non-driver window
    {
      const sx = -sz, zp = sz * (HL - 0.04);
      const xa = sx * 1.12, xb = sx * 0.62;
      gw(X.decal).quad([xa, 2.05, zp], [xb, 2.05, zp], [xb, 2.19, zp], [xa, 2.19, zp], [0, 0, sz], null,
        sz > 0 ? [[0.19, 0.055], [0.81, 0.055], [0.81, 0.41], [0.19, 0.41]] : [[0.19, 0.055], [0.81, 0.055], [0.81, 0.41], [0.19, 0.41]]);
    }
    // end beam, skirt (a U-shaped plate around the coupler), coupler, hoses, release lever
    {
      const P = M.paint, gy = C.skirt, zf = sz * (HL + 0.05);
      box(X.under, -1.3, 0.86, sz * (HL - 0.12), 1.3, YB, sz * (HL + 0.01), C.dark);
      const sk = (x0, y0, x1, y1) => box(P, x0, y0, zf, x1, y1, zf - sz * 0.025, gy);
      sk(-1.3, 0.36, -0.36, 0.86); sk(0.36, 0.36, 1.3, 0.86); sk(-0.36, 0.36, 0.36, 0.62);
      box(P, -1.3, 0.34, zf + sz * 0.012, 1.3, 0.39, zf - sz * 0.04, [0.8, 0.8, 0.8].map((k, i) => k * gy[i]));
      for (const sx of [-1, 1]) {
        // angled side plates running back towards the bogie
        const g = gw(P, gy);
        const pa = [sx * 1.3, 0.36, zf], pb = [sx * 1.34, 0.45, sz * (HL - 0.3)], pc = [sx * 1.34, 0.86, sz * (HL - 0.3)], pd = [sx * 1.3, 0.86, zf];
        g.quad(pa, pb, pc, pd, norm([sx, 0, sz * 0.25]));
        g.quad(pa, pd, pc, pb, norm([-sx, 0, -sz * 0.25]));
        // stiffener ribs behind the plate, bolts along the top
        box(X.under, sx * 0.8, 0.38, zf - sz * 0.025, sx * 0.84, 0.86, zf - sz * 0.14, C.dark);
      }
      // coupler: draft gear, shank, tight-lock head
      box(M.darkMetal, -0.12, 0.8, sz * (HL - 0.35), 0.12, 0.97, sz * (HL + 0.05));
      box(M.darkMetal, -0.07, 0.83, sz * (HL + 0.05), 0.07, 0.94, sz * (HL + 0.42));
      box(M.darkMetal, -0.17, 0.74, sz * (HL + 0.42), 0.17, 1.01, sz * (HL + 0.58), [0.9, 0.85, 0.8]);
      box(M.darkMetal, -0.04, 0.78, sz * (HL + 0.58), 0.13, 0.97, sz * (HL + 0.63), [1.1, 1.0, 0.9]);
      cyl(M.darkMetal, { r: 0.05, h: 0.33, seg: 10, pos: [-0.08, 0.875, sz * (HL + 0.52)] });
      // release lever across the end beam
      cyl(X.alu, { r: 0.012, h: 1.0, seg: 6, pos: [sz * 0.55, 0.99, sz * (HL + 0.07)], rot: [0, 0, Math.PI / 2], color: [0.6, 0.6, 0.6] });
      box(X.alu, sz * 1.03, 0.93, sz * (HL + 0.05), sz * 1.06, 1.0, sz * (HL + 0.09), [0.6, 0.6, 0.6]);
      // air hoses hanging either side of the coupler, with their cocks
      for (const sx of [-1, 1]) {
        B.cyl(M.rubber, { r: 0.022, h: 0.36, seg: 6, pos: [sx * 0.26, 0.72, sz * (HL + 0.14)], rot: [sz * 0.3, 0, sx * 0.2] });
        box(M.darkMetal, sx * 0.21, 0.86, sz * (HL + 0.0), sx * 0.31, 0.95, sz * (HL + 0.1));
        box(P, sx * 0.24, 0.9, sz * (HL + 0.08), sx * 0.29, 0.93, sz * (HL + 0.16), [0.5, 0.12, 0.08]);
      }
    }
    // jumper sockets either side of the gangway, below the band
    for (const sx of [-1, 1]) {
      box(M.paint, sx * 0.52, 1.14, sz * HL, sx * 0.68, 1.3, sz * (HL + 0.06), C.skirt);
      cyl(M.darkMetal, { r: 0.045, h: 0.03, seg: 10, pos: [sx * 0.6, 1.22, sz * (HL + 0.07)], rot: [Math.PI / 2, 0, 0] });
    }
    // drip rail over the front windows
    for (const sx of [-1, 1]) box(X.body, sx * (K.fdoor + 0.06), K.fwinY[1] + 0.05, sz * HL, sx * (K.fwin[1] + 0.08), K.fwinY[1] + 0.075, sz * (HL + 0.025));
    // raised frame around the gangway door
    box(X.body, -K.fdoor - 0.045, K.fdoorY[0], sz * HL, -K.fdoor, K.fdoorY[1] + 0.045, sz * (HL + 0.014));
    box(X.body, K.fdoor, K.fdoorY[0], sz * HL, K.fdoor + 0.045, K.fdoorY[1] + 0.045, sz * (HL + 0.014));
    box(X.body, -K.fdoor, K.fdoorY[1], sz * HL, K.fdoor, K.fdoorY[1] + 0.045, sz * (HL + 0.014));
    // cab interior: console, seat, partition
    {
      const sd = sz; // driver on the left facing the direction of travel (+x at the +z end)
      box(X.inside, sd * 0.42, YF, sz * (HL - 0.62), sd * (HW - 0.06), YF + 0.8, sz * (HL - 0.06), C.cab);
      box(X.inside, sd * 0.45, YF + 0.8, sz * (HL - 0.35), sd * (HW - 0.08), YF + 0.9, sz * (HL - 0.06), lin(0.2, 0.22, 0.2));
      box(X.inside, sd * 0.6, YF + 0.42, sz * (HL - 1.0), sd * 1.05, YF + 0.5, sz * (HL - 0.62), lin(0.15, 0.2, 0.25));
      box(X.inside, sd * 0.6, YF + 0.5, sz * (HL - 1.05), sd * 1.05, YF + 1.05, sz * (HL - 0.97), lin(0.15, 0.2, 0.25));
      box(X.inside, sd * 0.35, YF, sz * 8.28, sd * (HW - TW), 2.4, sz * 8.32, C.cab);
      box(X.inside, -sd * 0.35, YF, sz * 8.28, -sd * (HW - TW), YF + 0.95, sz * 8.32, C.cab);
    }
    // roof horns under a little hood, near the front
    for (const sx of [-1, 1]) {
      const hz = sz * (HL - 0.75);
      B.cyl(M.darkMetal, { r: 0.02, r2: 0.06, h: 0.24, seg: 10, pos: [sx * 0.22, YR + 0.02, hz + sz * 0.02], rot: [sz * Math.PI / 2, 0, 0], open: true });
    }
    box(X.roof, -0.4, YR - 0.08, sz * (HL - 0.92), 0.4, YR + 0.1, sz * (HL - 0.86), [0.85, 0.85, 0.85]);
  }

  // ---- roof: elliptical profile, rounded ends
  {
    const H = YR - YE, a = K.roofA;
    const hw = (z) => {
      const e = Math.abs(z) - (HL - R);
      return e > 0 ? HW - R + Math.sqrt(Math.max(0, R * R - e * e)) : HW;
    };
    const Sz = (z) => { const s = (Math.abs(z) - (HL - a)) / a; return s > 0 ? Math.sqrt(Math.max(0, 1 - s * s)) : 1; };
    const P = (phi, z) => [hw(z) * Math.cos(phi), YE + H * Sz(z) * Math.sin(phi), z];
    const out = (p) => sub(p, [0, YE - 0.6, 0]);
    const uv = (phi, z) => [(phi - Math.PI / 2) * -1.1, z];
    const rg = gw(X.roof);
    paramSurf(rg, P, 0, Math.PI, 18, -(HL - a), HL - a, 1, out, uv);
    for (const sz of [-1, 1]) {
      const za = sz * (HL - a), zb = sz * HL;
      const P2 = (phi, t) => P(phi, za + (zb - za) * t);
      const out2 = (p) => sub(p, [0, YE - 0.6, sz * (HL - 2.0)]);
      paramSurf(rg, P2, 0, Math.PI, 18, 0, 1, 7, out2, (phi, t) => uv(phi, za + (zb - za) * t));
    }
    // ceiling inside, fluorescent lamp covers
    gw(X.inside, C.ceil).quad([-(HW - TW), YC, -(HL - TW)], [HW - TW, YC, -(HL - TW)], [HW - TW, YC, HL - TW], [-(HW - TW), YC, HL - TW], [0, -1, 0]);
    for (const sx of [-1, 1]) {
      for (let k = -5; k <= 5; k++) box(X.ceilLamp, sx * 0.5 - 0.06, YC - 0.035, k * 1.35 - 0.55, sx * 0.5 + 0.06, YC, k * 1.35 + 0.55);
      // luggage racks
      box(X.inside, sx * (HW - 0.42), 2.86, -6.1, sx * (HW - 0.1), 2.88, 6.1, C.rack);
      for (let k = -4; k <= 4; k++) box(X.inside, sx * (HW - 0.42), 2.86, k * 1.5 - 0.01, sx * (HW - TW), 2.98, k * 1.5 + 0.01, C.rack);
    }
    // AC units, exhaust stack, ventilators, antenna
    for (const zc of [-3.7, 3.7]) {
      box(M.paint, -0.72, YR - 0.12, zc - 1.0, 0.72, YR + 0.05, zc + 1.0, C.acUnit);
      box(M.paint, -0.8, YR + 0.05, zc - 1.05, 0.8, YR + 0.27, zc + 1.05, C.acUnit);
      for (const fz of [-0.5, 0.5]) cyl(M.darkMetal, { r: 0.3, h: 0.02, seg: 20, pos: [0, YR + 0.275, zc + fz] });
      for (const sx of [-1, 1]) box(M.darkMetal, sx * 0.8, YR + 0.08, zc - 0.9, sx * 0.805, YR + 0.24, zc + 0.9);
    }
    cyl(M.darkMetal, { r: 0.075, h: 0.34, seg: 12, pos: [0.3, YR + 0.1, -1.0] });
    cyl(M.darkMetal, { r: 0.11, h: 0.02, seg: 12, pos: [0.3, YR + 0.32, -1.0] });
    for (const zc of [-5.9, 5.9, -7.5, 7.5, 1.6]) {
      cyl(X.roof, { r: 0.17, r2: 0.15, h: 0.1, seg: 14, pos: [0, YR + 0.03, zc], color: [0.9, 0.9, 0.9] });
      cyl(X.roof, { r: 0.19, h: 0.03, seg: 14, pos: [0, YR + 0.1, zc], color: [0.85, 0.85, 0.85] });
    }
    box(M.darkMetal, -0.5, YR - 0.02, -7.9, -0.48, YR + 0.28, -7.6);
    box(M.darkMetal, -0.56, YR - 0.03, -7.95, -0.42, YR + 0.02, -7.55);
  }

  // ---- interior: floor, seats with white head-rest covers
  {
    const fl = gw(X.inside, C.floor);
    const xa = HW - 0.42, xb = HW - TW, z9 = HL - TW;
    fl.quad([-xa, YF, -z9], [xa, YF, -z9], [xa, YF, z9], [-xa, YF, z9], [0, 1, 0]);
    for (const sx of [-1, 1]) {
      for (const [za, zb] of [[-z9, -K.door[1]], [-K.door[0], K.door[0]], [K.door[1], z9]]) {
        fl.quad([sx * xa, YF, za], [sx * xb, YF, za], [sx * xb, YF, zb], [sx * xa, YF, zb], [0, 1, 0]);
      }
    }
    for (const sx of [-1, 1]) {
      WIN.forEach(([z0, z1]) => {
        const c = (z0 + z1) / 2;
        for (const s of [-1, 1]) {
          const zb = c + s * 0.6;
          box(X.inside, sx * 0.36, YF + 0.42, zb - 0.05, sx * (HW - 0.07), YF + 0.9, zb + 0.05, C.seat);
          box(X.inside, sx * 0.36, YF + 0.36, zb - s * 0.5, sx * (HW - 0.07), YF + 0.46, zb, C.seat);
          for (const k of [0, 1]) {
            const x0 = sx * (0.42 + k * 0.48), x1 = sx * (0.84 + k * 0.48);
            box(X.inside, x0, YF + 0.78, zb - s * 0.058, x1, YF + 0.93, zb - s * 0.05, C.head);
          }
        }
      });
      // long seats in the vestibules by the doors
      for (const s of [-1, 1]) {
        box(X.inside, sx * (HW - 0.55), YF + 0.36, s * 6.2, sx * (HW - 0.07), YF + 0.46, s * 6.95, C.seat);
      }
    }
  }

  // ---- underframe: sill, equipment, bogies
  box(X.under, -(HW - 0.07), 0.9, -(HL - 0.1), HW - 0.07, YB, HL - 0.1, C.dark);
  underfloor();
  const wheelZ = [];
  for (const bz of [-K.bogie, K.bogie]) { bogie(bz); wheelZ.push(bz - K.axle, bz + K.axle); }

  function underfloor() {
    const U = X.under, P = M.paint, grey = lin(0.5, 0.5, 0.5), grey2 = lin(0.42, 0.43, 0.42);
    // engine block with its oil pan and a row of injector covers, transmission, shafts
    box(U, -0.6, 0.5, -2.3, 0.6, 0.9, 0.1, [1.1, 1.1, 1.1]);
    box(U, -0.45, 0.4, -2.1, 0.45, 0.5, -0.1, [0.9, 0.9, 0.9]);
    for (let i = 0; i < 6; i++) box(U, 0.6, 0.66, -2.1 + i * 0.36, 0.68, 0.84, -1.86 + i * 0.36, [1.5, 1.5, 1.5]);
    box(U, -0.45, 0.52, 0.1, 0.45, 0.88, 1.0, [0.95, 0.95, 0.95]);
    cyl(M.darkMetal, { r: 0.07, h: 4.3, seg: 8, pos: [0, 0.6, 3.15], rot: [Math.PI / 2, 0, 0] });
    cyl(U, { r: 0.16, h: 1.4, seg: 12, pos: [-0.85, 0.72, -1.2], rot: [Math.PI / 2, 0, 0], color: [1.5, 1.4, 1.3] });
    // radiator unit with louvres (grey paint)
    box(P, -1.22, 0.5, 1.4, -0.7, 0.93, 3.3, grey);
    for (let i = 0; i < 16; i++) box(P, -1.24, 0.55, 1.47 + i * 0.115, -1.22, 0.88, 1.52 + i * 0.115, grey2);
    // fuel tank with a filler cap
    cyl(M.darkMetal, { r: 0.3, h: 1.9, seg: 18, pos: [0.84, 0.66, 2.45], rot: [Math.PI / 2, 0, 0], color: [1.6, 1.6, 1.6] });
    for (const zz of [1.5, 3.4]) cyl(U, { r: 0.305, h: 0.03, seg: 18, pos: [0.84, 0.66, zz], rot: [Math.PI / 2, 0, 0], color: [1.6, 1.6, 1.6] });
    cyl(P, { r: 0.06, h: 0.08, seg: 10, pos: [1.12, 0.78, 2.9], rot: [0, 0, Math.PI / 2], color: [0.55, 0.5, 0.2] });
    // battery box and control boxes (grey paint, ribbed lids)
    box(P, 0.7, 0.52, -4.4, 1.25, 0.93, -2.8, grey);
    for (let i = 0; i < 4; i++) box(P, 1.25, 0.56, -4.3 + i * 0.4, 1.265, 0.9, -4.05 + i * 0.4, grey2);
    box(P, -1.2, 0.6, 3.6, -0.75, 0.93, 4.6, grey2);
    box(P, 0.75, 0.64, 3.9, 1.2, 0.93, 4.7, grey);
    box(P, 0.8, 0.6, -1.6, 1.22, 0.93, -0.6, grey2);
    // main air reservoirs
    for (const xx of [-0.98, -0.68]) {
      cyl(U, { r: 0.13, h: 2.0, seg: 14, pos: [xx, 0.74, -3.6], rot: [Math.PI / 2, 0, 0], color: [1.4, 1.4, 1.4] });
      for (const zz of [-4.6, -2.6]) B.geo(U, new THREE.SphereGeometry(0.13, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), Builder.mat({ pos: [xx, 0.74, zz], rot: [zz < -3.6 ? -Math.PI / 2 : Math.PI / 2, 0, 0] }), [1.4, 1.4, 1.4]);
    }
    // pipes along the sides
    for (const sx of [-1, 1]) for (const yy of [0.95, 0.9]) cyl(M.darkMetal, { r: 0.018, h: 9.6, seg: 6, pos: [sx * (1.3 - (0.95 - yy)), yy, 0], rot: [Math.PI / 2, 0, 0] });
  }

  function bogie(bz) {
    const U = X.under, wr = K.wr, rust = [1.1, 0.97, 0.88];
    for (const az of [bz - K.axle, bz + K.axle]) {
      for (const sx of [-1, 1]) {
        // wheel: rusty web and flange, polished tread
        const prof = [[0.12, 0.49], [0.455, 0.49], [0.458, 0.51], [0.438, 0.525], [wr, 0.54], [wr - 0.01, 0.655], [0.34, 0.66], [0.2, 0.63], [0.12, 0.64]];
        const pr = sx > 0 ? prof : prof.map(([r, x]) => [r, -x]).reverse();
        B.geo(U, latheX(pr, 22), Builder.mat({ pos: [0, wr, az] }), rust);
        cyl(M.metal, { r: wr + 0.002, h: 0.1, seg: 22, pos: [sx * 0.6, wr, az], rot: [0, 0, Math.PI / 2], open: true, color: [0.7, 0.68, 0.66] });
        // axle box (round cover) with its wing springs
        cyl(U, { r: 0.12, h: 0.2, seg: 14, pos: [sx * 1.04, wr, az], rot: [0, 0, Math.PI / 2], color: [1.3, 1.3, 1.3] });
        cyl(M.paint, { r: 0.09, h: 0.02, seg: 14, pos: [sx * 1.15, wr, az], rot: [0, 0, Math.PI / 2], color: [0.3, 0.28, 0.2] });
        box(U, sx * 0.95, wr + 0.08, az - 0.3, sx * 1.13, wr + 0.12, az + 0.3, [1.2, 1.2, 1.2]);
        for (const dz of [-0.24, 0.24]) {
          cyl(M.darkMetal, { r: 0.06, h: 0.2, seg: 10, pos: [sx * 1.04, wr + 0.22, az + dz], color: [0.9, 0.85, 0.8] });
          for (let k = 0; k < 3; k++) cyl(M.darkMetal, { r: 0.066, h: 0.018, seg: 8, pos: [sx * 1.04, wr + 0.15 + k * 0.06, az + dz], color: [0.7, 0.65, 0.6], open: true });
        }
        // brake shoes on the tread, hanger links
        for (const s of [-1, 1]) {
          const bzz = az + s * (wr + 0.045);
          box(U, sx * 0.54, wr - 0.15, bzz - 0.035, sx * 0.66, wr + 0.15, bzz + 0.035, [1.2, 1.0, 0.85]);
          box(U, sx * 0.58, wr + 0.12, bzz - 0.02, sx * 0.62, 0.8, bzz + 0.02);
        }
      }
      cyl(M.darkMetal, { r: 0.075, h: 1.9, seg: 10, pos: [0, wr, az], rot: [0, 0, Math.PI / 2] });
    }
    for (const sx of [-1, 1]) {
      // side frame: top chord arching over the axle boxes, dropped centre, pedestal guides
      box(U, sx * 0.98, 0.78, bz - 1.45, sx * 1.1, 0.9, bz + 1.45);
      box(U, sx * 0.98, 0.5, bz - 0.5, sx * 1.1, 0.66, bz + 0.5);
      for (const s of [-1, 1]) {
        B.box(U, { w: 0.12, h: 0.12, d: 0.62, pos: [sx * 1.04, 0.66, bz + s * 0.72], rot: [s * -0.62, 0, 0] });
        for (const e of [-1, 1]) box(U, sx * 0.98, wr - 0.1, bz + s * K.axle + e * 0.36 - 0.035, sx * 1.1, 0.82, bz + s * K.axle + e * 0.36 + 0.035);
        box(U, sx * 0.98, 0.72, bz + s * 1.45, sx * 1.1, 0.9, bz + s * 1.62);
      }
      // bolster springs (big coils) on the spring plank
      for (const dz of [-0.2, 0.2]) {
        cyl(M.darkMetal, { r: 0.1, h: 0.22, seg: 12, pos: [sx * 1.0, 0.6, bz + dz], color: [0.85, 0.8, 0.75] });
        for (let k = 0; k < 4; k++) cyl(M.darkMetal, { r: 0.108, h: 0.02, seg: 12, pos: [sx * 1.0, 0.52 + k * 0.055, bz + dz], color: [0.65, 0.6, 0.55] });
      }
      // brake cylinder and rods
      cyl(U, { r: 0.08, h: 0.24, seg: 12, pos: [sx * 0.84, 0.7, bz + 0.75], rot: [Math.PI / 2, 0, 0], color: [1.3, 1.3, 1.3] });
      box(U, sx * 0.82, 0.68, bz - 1.0, sx * 0.86, 0.72, bz + 0.6);
    }
    box(U, -1.12, 0.72, bz - 0.24, 1.12, 0.9, bz + 0.24, [1.05, 1.05, 1.05]);
    box(U, -1.08, 0.46, bz - 0.3, 1.08, 0.5, bz + 0.3);
    box(U, -0.9, 0.62, bz - 0.55, 0.9, 0.7, bz - 0.47);
    box(U, -0.9, 0.62, bz + 0.47, 0.9, 0.7, bz + 0.55);
  }

  flush();
  const g = B.build({ name: 'train' });
  // sliding door leaves: setDoors(k, side) opens them (k 0 = shut .. 1 = open) on one side
  // of the car (+1: the +x side, -1: the -x side, 0: both)
  const doors = new THREE.Group();
  doors.name = 'train:doors';
  for (const l of leaves) doors.add(l);
  g.add(doors);
  const setDoors = (k, side = 0) => {
    k = Math.max(0, Math.min(1, +k || 0));
    for (const l of leaves) if (!side || l.userData.side === Math.sign(side)) l.position.z = l.userData.slide * k;
  };
  g.userData = { length: 2 * HL, overCouplers: 2 * (HL + 0.64), width: 2 * HW, height: YR, wheelZ, bogieZ: [-K.bogie, K.bogie], dir, setDoors };
  // opts.doors: '+1' / '-1' opens that side, any other truthy value both sides
  if (opts.doors && opts.doors !== '0') { const d = String(opts.doors).trim(); setDoors(1, d.startsWith('+') ? 1 : d.startsWith('-') ? -1 : 0); }
  return g;
}

// =================================================================================
// Track: rails, sleepers, fastenings and a ballast bed along a smoothed polyline.

// gravel: weighted Voronoi (power diagram) of angular stones, mostly greys with some
// darker and ochre pieces, narrow dark gaps; 1 m tile
function ballastPainter() {
  const G = 24, R = rng(501), pts = [];
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) pts.push([(i + 0.05 + 0.9 * R()) / G, (j + 0.05 + 0.9 * R()) / G, R(), R() * 3.1, (R() - 0.5) * 0.35 / G, R()]);
  return (u, v) => {
    let d1 = 9, d2 = 9, best = null;
    const gi = Math.floor(u * G), gj = Math.floor(v * G);
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
      const ii = ((gi + i) % G + G) % G, jj = ((gj + j) % G + G) % G, q = pts[jj * G + ii];
      const qx = q[0] + Math.floor((gi + i) / G), qy = q[1] + Math.floor((gj + j) / G);
      const dx = u - qx, dy = v - qy, a = q[3];
      const rx = dx * Math.cos(a) + dy * Math.sin(a), ry = -dx * Math.sin(a) + dy * Math.cos(a);
      const d = Math.max(Math.abs(rx) * 1.15, Math.abs(ry) * 0.85, (Math.abs(rx) + Math.abs(ry)) * 0.72) - q[4];
      if (d < d1) { d2 = d1; d1 = d; best = q; } else if (d < d2) d2 = d;
    }
    const edge = (d2 - d1) * G;
    const gap = clamp01(1 - edge / 0.09);
    const bulge = clamp01(edge * 1.6) ** 0.45;
    const n = tnoise(u, v, 96, 502), n2 = tnoise(u, v, 12, 503);
    const id = best[2], k = best[5];
    let c = id > 0.9 ? [0.47, 0.38, 0.29] : id > 0.75 ? [0.31, 0.30, 0.29] : id > 0.5 ? [0.52, 0.51, 0.49] : [0.44, 0.43, 0.42];
    c = c.map((x) => x * (0.82 + 0.3 * k) * (0.92 + n * 0.16 + n2 * 0.06) * (1 - gap * 0.62));
    return [...c, bulge * 0.9 + n * 0.04, 0.88 + gap * 0.1];
  };
}
function railRustPainter(u, v) {
  const n1 = tfbm(u, v, 3, 4, 511, 1), n2 = tnoise(u, v, 90, 512, 40);
  const r = clamp01(0.55 + n1 * 1.2);
  const c = [0.24, 0.165, 0.115].map((x, i) => x * (0.8 + 0.35 * r) + [0.05, 0.045, 0.04][i] * (1 - r));
  return [...c, 0.5 + n2 * 0.25, 0.85];
}
function sleeperWoodPainter(u, v) {
  const grain = tnoise(u, v, 60, 521, 3) * 0.6 + tfbm(u, v, 3, 3, 522) * 0.4;
  const crack = Math.abs(tnoise(u, v, 18, 523, 2)) < 0.02 ? 1 : 0;
  const w = clamp01(0.5 + tfbm(u, v, 2, 3, 524) * 1.4);
  let c = [0.20, 0.16, 0.12].map((x, i) => x * (0.8 + grain * 0.5) + w * [0.08, 0.075, 0.07][i]);
  if (crack) c = c.map((x) => x * 0.4);
  return [...c, 0.5 + grain * 0.2 - crack * 0.4, 0.9];
}

let KM = null;
function trackMats() {
  if (KM) return KM;
  KM = {};
  KM.ballast = texturedMaterial('ballast', { n: 512, period: 1.0, normal: 5, fn: ballastPainter() });
  KM.rust = texturedMaterial('railRust', { n: 256, period: 1.0, normal: 1.5, fn: railRustPainter }, { metalness: 0.15 });
  KM.wood = texturedMaterial('sleeperWood', { n: 512, period: 2.2, normal: 3, fn: sleeperWoodPainter });
  KM.top = prep(new THREE.MeshStandardMaterial({ name: 'railTop', color: 0xccd0d4, metalness: 1, roughness: 0.22, vertexColors: true }), null, 'kiha-railTop');
  return KM;
}

// Track centreline: centripetal Catmull-Rom through the points, arc-length parameterised.
// at(s) -> { p, t, n, yaw }: point at rail-top height, unit tangent, horizontal lateral
// (n = left of travel), heading yaw (rotation.y that turns a model's +z onto t).
// Beyond the ends the line continues straight along the end tangents.
export function trackPath(points) {
  const P = points.map((q) => new THREE.Vector3(q[0], q[1], q[2]));
  if (P.length < 2) throw new Error('trackPath: need at least two points');
  const curve = new THREE.CatmullRomCurve3(P, false, 'centripetal');
  curve.arcLengthDivisions = Math.max(200, P.length * 40);
  const length = curve.getLength();
  const at = (s) => {
    const u = Math.min(1, Math.max(0, s / length));
    const p = curve.getPointAt(u), t = curve.getTangentAt(u).normalize();
    if (s < 0) p.addScaledVector(t, s);
    else if (s > length) p.addScaledVector(t, s - length);
    const n = new THREE.Vector3(t.z, 0, -t.x).normalize();
    return { p, t, n, yaw: Math.atan2(t.x, t.z) };
  };
  return { curve, length, at, points };
}

// Put a car (built with origin at rail top, +z = its front) on the track at arc length s:
// its bogie centres sit on the centreline (so it cuts the chord on curves), pitched with
// the grade. reverse: the car runs towards decreasing s.
export function placeOnTrack(obj, track, s, { reverse = false } = {}) {
  const path = track.userData?.path || track;
  const bz = obj.userData?.bogieZ || [-K.bogie, K.bogie];
  const half = (bz[1] - bz[0]) / 2;
  const a = path.at(s - half), b = path.at(s + half);
  const mid = a.p.clone().add(b.p).multiplyScalar(0.5);
  const d = b.p.clone().sub(a.p).normalize();
  if (reverse) d.negate();
  obj.position.copy(mid);
  obj.rotation.set(-Math.asin(Math.max(-1, Math.min(1, d.y))), Math.atan2(d.x, d.z), 0, 'YXZ');
  return obj;
}

// Place a model built around a straight track along its local z (station: x = 0 is the
// track centreline, y = 0 rail top) at arc length s0 and bend its geometry so it follows
// the curve and grade of the real line (vertices move sideways/up by the line's offset
// from its tangent at s0). reverse: local +z points towards decreasing s. The model's
// geometries are modified in place (build a fresh one per call).
export function fitToTrack(obj, track, s0, { reverse = false } = {}) {
  const path = track.userData?.path || track;
  const a = path.at(s0), sg = reverse ? -1 : 1;
  const th = a.yaw + (reverse ? Math.PI : 0);
  obj.position.copy(a.p);
  obj.rotation.set(0, th, 0);
  const X = [Math.cos(th), 0, -Math.sin(th)];
  const cache = new Map();
  const off = (z) => {
    const k = Math.round(z * 4) / 4;
    if (!cache.has(k)) {
      const q = path.at(s0 + sg * k).p;
      cache.set(k, [(q.x - a.p.x) * X[0] + (q.z - a.p.z) * X[2], q.y - a.p.y]);
    }
    return cache.get(k);
  };
  const lerpOff = (z) => {
    const z0 = Math.floor(z * 4) / 4, f = (z - z0) * 4, p = off(z0), q = off(z0 + 0.25);
    return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
  };
  obj.traverse((m) => {
    if (!m.isMesh || m.userData.fitted) return;
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const o = lerpOff(pos.getZ(i));
      pos.setX(i, pos.getX(i) + o[0]);
      pos.setY(i, pos.getY(i) + o[1]);
    }
    pos.needsUpdate = true;
    m.geometry.computeBoundingBox(); m.geometry.computeBoundingSphere();
    m.userData.fitted = true;
  });
  return obj;
}

// Buffer writer with per-vertex colours (the track is built without the Builder).
class TW {
  constructor() { this.P = []; this.N = []; this.T = []; this.C = []; }
  v(p, n, t, c) { this.P.push(p[0], p[1], p[2]); this.N.push(n[0], n[1], n[2]); this.T.push(t[0], t[1]); this.C.push(c[0], c[1], c[2]); }
  quad(a, b, c, d, n, ta, tb, tc, td, ca, cb = ca, cc = ca, cd = ca) {
    if (dot(cross(sub(b, a), sub(c, a)), n) < 0) { [b, d] = [d, b]; [tb, td] = [td, tb]; [cb, cd] = [cd, cb]; }
    this.v(a, n, ta, ca); this.v(b, n, tb, cb); this.v(c, n, tc, cc);
    this.v(a, n, ta, ca); this.v(c, n, tc, cc); this.v(d, n, td, cd);
  }
  // oriented box: centre o, unit axes ax (length), ay (up), az (lateral), half sizes; no bottom face
  obox(o, ax, ay, az, hx, hy, hz, col, bottom = false) {
    const P = (i, j, k) => [o[0] + ax[0] * hx * i + ay[0] * hy * j + az[0] * hz * k, o[1] + ax[1] * hx * i + ay[1] * hy * j + az[1] * hz * k, o[2] + ax[2] * hx * i + ay[2] * hy * j + az[2] * hz * k];
    const neg = (a) => [-a[0], -a[1], -a[2]];
    const F = [[ay, [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]], [hx, hz]], [ax, [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]], [hz, hy]],
      [neg(ax), [[-1, -1, -1], [-1, 1, -1], [-1, 1, 1], [-1, -1, 1]], [hz, hy]], [az, [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], [hx, hy]],
      [neg(az), [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1]], [hx, hy]]];
    if (bottom) F.push([neg(ay), [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], [hx, hz]]);
    for (const [n, q, [su, sv]] of F) {
      const pts = q.map((c) => P(...c));
      const uv = [[0, 0], [2 * su, 0], [2 * su, 2 * sv], [0, 2 * sv]];
      this.quad(pts[0], pts[1], pts[2], pts[3], n, uv[0], uv[1], uv[2], uv[3], col);
    }
  }
  mesh(mat, name) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.T, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.computeBoundingSphere(); g.computeBoundingBox();
    const m = new THREE.Mesh(g, mat);
    m.name = name; m.castShadow = true; m.receiveShadow = true;
    return m;
  }
}

// rail profile (simplified 50N) around the rail centre: [lateral, height below rail top]
const RAIL_PROFILE = [[-0.026, 0], [0.026, 0], [0.0325, -0.012], [0.0325, -0.046], [0.0075, -0.06], [0.0075, -0.124], [0.0635, -0.141], [0.0635, -0.153],
  [-0.0635, -0.153], [-0.0635, -0.141], [-0.0075, -0.124], [-0.0075, -0.06], [-0.0325, -0.046], [-0.0325, -0.012]];
export const GAUGE = 1.067;
const RAIL_Q = GAUGE / 2 + 0.0325;

// Build single track along points [[x, y, z], ...] (y = rail-top height). Options:
//   wood: wooden sleepers instead of concrete      step: rail/ballast segment length (2.5 m)
//   sleeper: sleeper spacing (0.6 m)               bedWidth: ballast top width (2.8 m)
//   depth: how far the ballast skirt reaches below rail top (1.0 m; bury it in the terrain)
//   fastenRange: [s0, s1] arc-length range that gets rail fastenings (default everywhere)
//   joints: rail joint spacing in metres (25; 0 = welded)
// Returns a Group (one mesh per material) with userData.path = trackPath(points).
export function buildTrack(points, opts = {}) {
  const M = materials(), T = trackMats();
  const path = trackPath(points);
  const L = path.length;
  const wood = !!opts.wood && opts.wood !== '0';
  const step = +(opts.step || 2.5), spacing = +(opts.sleeper || 0.6);
  const bedW = +(opts.bedWidth || 2.8) / 2, depth = +(opts.depth || 1.0);
  const fr = opts.fastenRange || [-1e9, 1e9];
  const jointEvery = opts.joints === undefined ? 25 : +opts.joints;
  const N = Math.max(2, Math.ceil(L / step) + 1);
  const F = [];
  for (let i = 0; i < N; i++) {
    const s = (L * i) / (N - 1), f = path.at(s);
    F.push({ s, p: f.p.toArray(), t: f.t.toArray(), n: f.n.toArray() });
  }
  const at = (f, q, h) => [f.p[0] + f.n[0] * q, f.p[1] + h, f.p[2] + f.n[2] * q];
  const W = { ballast: new TW(), rust: new TW(), top: new TW(), sleeper: new TW(), fasten: new TW() };
  const one = [1, 1, 1];

  // rails
  const cen = [0, -0.075];
  for (const side of [-1, 1]) {
    const q0 = side * RAIL_Q;
    const pr = RAIL_PROFILE;
    for (let k = 0; k < pr.length; k++) {
      const a = pr[k], b = pr[(k + 1) % pr.length];
      if (a[1] === -0.153 && b[1] === -0.153) continue; // foot underside
      const dq = b[0] - a[0], dh = b[1] - a[1];
      let nq = dh, nh = -dq; const l = Math.hypot(nq, nh) || 1; nq /= l; nh /= l;
      const mq = (a[0] + b[0]) / 2 - cen[0], mh = (a[1] + b[1]) / 2 - cen[1];
      if (nq * mq + nh * mh < 0) { nq = -nq; nh = -nh; }
      const isTop = a[1] === 0 && b[1] === 0;
      const w = isTop ? W.top : W.rust;
      const va = k * 0.03, vb = va + Math.hypot(dq, dh);
      for (let i = 0; i < N - 1; i++) {
        const f0 = F[i], f1 = F[i + 1];
        const nrm = [f0.n[0] * nq, nh, f0.n[2] * nq];
        w.quad(at(f0, q0 + a[0], a[1]), at(f0, q0 + b[0], b[1]), at(f1, q0 + b[0], b[1]), at(f1, q0 + a[0], a[1]), nrm,
          [f0.s, va], [f0.s, vb], [f1.s, vb], [f1.s, va], isTop ? [0.9, 0.9, 0.9] : one);
      }
    }
    // rail joints: fishplates on both sides of the web
    if (jointEvery > 0) {
      for (let s = jointEvery * (side > 0 ? 0.5 : 0.5); s < L; s += jointEvery) {
        const f = path.at(s), p = f.p.toArray(), t = f.t.toArray(), n = f.n.toArray();
        for (const e of [-1, 1]) {
          const o = [p[0] + n[0] * (q0 + e * 0.022), p[1] - 0.09, p[2] + n[2] * (q0 + e * 0.022)];
          W.fasten.obox(o, t, [0, 1, 0], n, 0.3, 0.03, 0.013, [0.9, 0.85, 0.8]);
        }
      }
    }
  }

  // sleepers and fastenings
  const R = rng(opts.seed ? +opts.seed : 77);
  for (let s = spacing / 2; s < L; s += spacing) {
    const js = wood ? (R() - 0.5) * 0.05 : 0;
    const f = path.at(s + js), p = f.p.toArray(), t0 = f.t.toArray(), n0 = f.n.toArray();
    let t = [t0[0], 0, t0[2]], n = n0;
    if (wood) {
      const a = (R() - 0.5) * 0.04, c = Math.cos(a), si = Math.sin(a);
      t = [t[0] * c - t[2] * si, 0, t[0] * si + t[2] * c]; n = [t[2], 0, -t[0]];
    }
    const tl = Math.hypot(t[0], t[2]) || 1; t = [t[0] / tl, 0, t[2] / tl];
    if (wood) {
      const tone = 0.75 + 0.45 * R();
      const o = [p[0], p[1] - 0.163 - 0.07 - R() * 0.01, p[2]];
      W.sleeper.obox(o, t, [0, 1, 0], n, 0.1, 0.07, 1.05 + (R() - 0.5) * 0.04, [tone, tone * 0.97, tone * 0.93]);
    } else {
      const tone = 0.8 + 0.25 * R();
      W.sleeper.obox([p[0], p[1] - 0.163 - 0.085, p[2]], t, [0, 1, 0], n, 0.11, 0.085, 1.0, [tone, tone, tone * 0.97]);
    }
    if (s >= fr[0] && s <= fr[1]) {
      for (const side of [-1, 1]) {
        const q = side * RAIL_Q;
        const o = [p[0] + n[0] * q, p[1] - 0.163 + 0.0145, p[2] + n[2] * q];
        W.fasten.obox(o, t, [0, 1, 0], n, wood ? 0.1 : 0.05, 0.0145, wood ? 0.12 : 0.09, wood ? [0.8, 0.7, 0.6] : one);
        if (wood) for (const e of [-1, 1]) W.fasten.obox([o[0] + n[0] * e * 0.085, o[1] + 0.02, o[2] + n[2] * e * 0.085], t, [0, 1, 0], n, 0.015, 0.012, 0.015, [0.7, 0.6, 0.5]);
      }
    }
  }

  // ballast bed: shoulders, slopes, a skirt to bury in the terrain; stained along the rails
  const Q = [-bedW - 1.2, -bedW - 0.8, -bedW, -0.95, -RAIL_Q, -0.2, 0.2, RAIL_Q, 0.95, bedW, bedW + 0.8, bedW + 1.2];
  const Hh = [-depth, -0.64, -0.2, -0.2, -0.195, -0.205, -0.205, -0.195, -0.2, -0.2, -0.64, -depth];
  const stain = [0.9, 0.82, 0.68], oil = [0.62, 0.57, 0.52], slope = [0.97, 0.95, 0.92];
  const Cc = [slope, slope, one, [0.95, 0.92, 0.88], stain, oil, oil, stain, [0.95, 0.92, 0.88], one, slope, slope];
  for (let k = 0; k < Q.length - 1; k++) {
    const dq = Q[k + 1] - Q[k], dh = Hh[k + 1] - Hh[k];
    let nq = -dh, nh = dq; const l = Math.hypot(nq, nh); nq /= l; nh /= l;
    for (let i = 0; i < N - 1; i++) {
      const f0 = F[i], f1 = F[i + 1];
      const nrm = [f0.n[0] * nq, nh, f0.n[2] * nq];
      W.ballast.quad(at(f0, Q[k], Hh[k]), at(f0, Q[k + 1], Hh[k + 1]), at(f1, Q[k + 1], Hh[k + 1]), at(f1, Q[k], Hh[k]), nrm,
        [Q[k], f0.s], [Q[k + 1], f0.s], [Q[k + 1], f1.s], [Q[k], f1.s], Cc[k], Cc[k + 1], Cc[k + 1], Cc[k]);
    }
  }
  // end caps of the bed
  if (opts.caps !== false) {
    for (const [f, e] of [[F[0], -1], [F[N - 1], 1]]) {
      const nrm = [f.t[0] * e, 0, f.t[2] * e], base = at(f, 0, -depth);
      for (let k = 0; k < Q.length - 1; k++) {
        W.ballast.quad(base, at(f, Q[k], Hh[k]), at(f, Q[k + 1], Hh[k + 1]), base, nrm, [0, -depth], [Q[k], Hh[k]], [Q[k + 1], Hh[k + 1]], [0, -depth], slope);
      }
    }
  }

  const g = new THREE.Group();
  g.name = 'track';
  g.add(W.ballast.mesh(T.ballast, 'track:ballast'));
  g.add(W.sleeper.mesh(wood ? T.wood : M.concrete, 'track:sleepers'));
  g.add(W.fasten.mesh(M.darkMetal, 'track:fastenings'));
  g.add(W.rust.mesh(T.rust, 'track:rails'));
  g.add(W.top.mesh(T.top, 'track:railTop'));
  g.userData.path = path;
  g.userData.length = L;
  return g;
}

// =================================================================================
// Station: Yumesaki (夢崎), an unmanned halt with one side platform on +x.
// Track centreline x = 0 (rail top y = 0) along z; platform z -22.5..22.5, edge x = 1.45,
// top y = 0.92, back x = 4.85; waiting shelter on a pad behind the platform (x 4.85..7.2,
// z -3.5..1.9); ramp down to y = -0.72 at the -z end (z -22.5..-32.5).
const ST = {
  z0: -22.5, z1: 22.5, edge: 1.45, top: 0.92, back: 4.85, wall: 1.5, base: -1.1,
  sh: { x0: 4.95, x1: 6.95, z0: -3.2, z1: 1.6, eaveF: 3.47, eaveB: 3.1 },
  pad: { x1: 7.2, z0: -3.5, z1: 1.9 },
  ramp: { len: 10, x0: 2.45, y1: -0.72 },
  stop: { south: 7.6, north: -20.5 },
  tactile: [2.25, 2.55],
};

// tactile warning blocks (点字ブロック): 0.3 m tiles, 5 x 5 domes, an inner guide bar
function tactilePainter(u, v) {
  const joint = u < 0.012 || u > 0.988 || v < 0.012 || v > 0.988 ? 1 : 0;
  const cu = ((u - 0.1) / 0.16), cv = ((v - 0.1) / 0.16);
  const du = cu - Math.round(cu), dv = cv - Math.round(cv);
  const inGrid = Math.round(cu) >= 0 && Math.round(cu) <= 4 && Math.round(cv) >= 0 && Math.round(cv) <= 4 && u < 0.8;
  const r = Math.hypot(du, dv) * 0.16 / 0.3;
  const dome = inGrid ? clamp01(1 - (r / 0.12) ** 2) : 0;
  const bar = u > 0.84 && u < 0.94 ? 1 : 0;
  const n = tfbm(u, v, 3, 3, 531), n2 = tnoise(u, v, 40, 532);
  const dirt = clamp01(0.35 + n * 1.2);
  let c = [0.86, 0.64, 0.10].map((x, i) => x * (0.9 + n2 * 0.06) * (1 - dirt * 0.28) + [0.05, 0.04, 0.02][i] * dirt);
  if (dome > 0 || bar) c = c.map((x) => x * 1.05);
  if (joint) c = c.map((x) => x * 0.5);
  return [...c, 0.3 + dome * 0.6 + bar * 0.5 - joint * 0.2, 0.75 - dome * 0.1];
}
// weathered timber, grain along v (timberV) or u (timberH)
function timberPainter(along) {
  return (u, v) => {
    const [a, b] = along === 'v' ? [u, v] : [v, u];
    const grain = tnoise(a, b, 40, 541, 3) * 0.55 + tnoise(a, b, 110, 542, 6) * 0.25 + tfbm(u, v, 4, 3, 543) * 0.2;
    const weather = clamp01(0.55 + tfbm(u, v, 3, 3, 544) * 1.3);
    let c = [0.33, 0.27, 0.21].map((x) => x * (0.82 + grain * 0.45));
    c = c.map((x, i) => x * (1 - weather * 0.35) + [0.40, 0.38, 0.35][i] * weather * 0.35);
    return [...c, 0.5 + grain * 0.25, 0.85];
  };
}

let SM = null;
function stationMats() {
  if (SM) return SM;
  SM = {};
  SM.tactile = texturedMaterial('tactile', { n: 256, period: 0.3, normal: 4, fn: tactilePainter });
  SM.timberV = texturedMaterial('timberV', { n: 512, period: 1.5, normal: 2.5, fn: timberPainter('v') });
  SM.timberH = texturedMaterial('timberH', { n: 512, period: 1.5, normal: 2.5, fn: timberPainter('u') });
  const signMat = (name, canvas, o = {}) => {
    const m = new THREE.MeshStandardMaterial({ name, map: canvasTex(canvas), roughness: 0.55, ...o });
    return prep(m, null, 'yume-' + name);
  };
  SM.board = signMat('nameBoard', nameBoardCanvas());
  SM.hang = signMat('hangSign', hangSignCanvas());
  SM.timetable = signMat('timetable', timetableCanvas());
  SM.plaque = signMat('plaque', plaqueCanvas(), { roughness: 0.8 });
  SM.poster = signMat('poster', posterCanvas(), { roughness: 0.6 });
  SM.stop = signMat('stopMark', stopCanvas());
  SM.keepout = signMat('keepOut', keepOutCanvas());
  SM.clock = signMat('clockFace', clockCanvas(), { roughness: 0.3 });
  SM.notice = signMat('notices', noticeCanvas(), { roughness: 0.7 });
  const vm = vendingCanvas();
  SM.vending = signMat('vending', vm.face, { roughness: 0.35, emissive: 0xffffff, emissiveMap: canvasTex(vm.glow), emissiveIntensity: 0 });
  registerNight(SM.vending, 0.5);
  SM.mirror = prep(new THREE.MeshStandardMaterial({ name: 'mirror', color: 0xe8ecef, metalness: 1, roughness: 0.04 }), null, 'yume-mirror');
  return SM;
}

// ---- sign canvases -----------------------------------------------------------------
function ageCanvas(x, w, h, seed, amt = 1) {
  const R = rng(seed);
  // soft grime towards the bottom and rust tears from the fixings
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(90,80,60,0)'); g.addColorStop(1, `rgba(90,80,60,${0.10 * amt})`);
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 1800 * amt; i++) {
    x.fillStyle = `rgba(${60 + R() * 60},${55 + R() * 40},${40 + R() * 30},${0.03 + R() * 0.05})`;
    const r = 1 + R() * 5;
    x.beginPath(); x.arc(R() * w, R() * h, r, 0, Math.PI * 2); x.fill();
  }
}

// name board atlas (2048 x 2048): top half = the face towards the track, bottom half = the back
function nameBoardCanvas() {
  const W = 2048, H = 1024, c = cnv(W, 2 * H), x = c.getContext('2d');
  const face = (oy, left, right) => {
    x.save(); x.translate(0, oy);
    x.fillStyle = '#f3f2ec'; x.fillRect(0, 0, W, H);
    x.textAlign = 'center'; x.textBaseline = 'alphabetic'; x.fillStyle = '#1c1d1f';
    x.font = `600 150px ${JP_SANS}`; x.letterSpacing = '40px';
    x.fillText('夢崎', W / 2 + 20, 210);
    x.font = `700 370px ${JP_SANS}`; x.letterSpacing = '70px';
    x.fillText('ゆめさき', W / 2 + 35, 590);
    x.letterSpacing = '6px'; x.font = `500 120px ${LAT_SANS}`;
    x.fillText('Yumesaki', W / 2, 735);
    // band with the neighbouring stations
    x.fillStyle = '#1f5ea8'; x.fillRect(0, 792, W, 200);
    x.fillStyle = '#f7f6f0'; x.textBaseline = 'middle';
    x.font = `700 104px ${JP_SANS}`; x.letterSpacing = '12px';
    x.textAlign = 'left'; x.fillText('← ' + left[0], 70, 862);
    x.textAlign = 'right'; x.fillText(right[0] + ' →', W - 60, 862);
    x.font = `500 58px ${LAT_SANS}`; x.letterSpacing = '3px';
    x.textAlign = 'left'; x.fillText(left[1], 190, 948);
    x.textAlign = 'right'; x.fillText(right[1], W - 190, 948);
    x.letterSpacing = '0px';
    ageCanvas(x, W, H, 7 + oy, 0.8);
    x.restore();
  };
  face(0, ['しおや', 'Shioya'], ['かざみ', 'Kazami']);
  face(H, ['かざみ', 'Kazami'], ['しおや', 'Shioya']);
  return c;
}

// hanging sign under the shelter eave (1024 x 256), the same on both faces
function hangSignCanvas() {
  const W = 1024, H = 256, c = cnv(W, H), x = c.getContext('2d');
  x.fillStyle = '#f3f2ec'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#1c1d1f'; x.textAlign = 'center'; x.textBaseline = 'alphabetic';
  x.font = `700 132px ${JP_SANS}`; x.letterSpacing = '26px';
  x.fillText('ゆめさき', W / 2 + 13, 150);
  x.letterSpacing = '4px'; x.font = `500 50px ${LAT_SANS}`;
  x.fillText('Yumesaki', W / 2, 212);
  x.fillStyle = '#1f5ea8'; x.fillRect(0, 232, W, 24);
  x.letterSpacing = '0px';
  ageCanvas(x, W, H, 21, 0.4);
  return c;
}

function timetableCanvas() {
  const W = 512, H = 640, c = cnv(W, H), x = c.getContext('2d'), R = rng(88);
  x.fillStyle = '#f6f5ef'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#1f5ea8'; x.fillRect(0, 0, W, 70);
  x.fillStyle = '#ffffff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = `700 36px ${JP_SANS}`; x.fillText('ゆめさき駅  時刻表', W / 2, 36);
  x.fillStyle = '#222'; x.font = `600 24px ${JP_SANS}`;
  x.fillText('しおや方面', W * 0.3, 96); x.fillText('かざみ方面', W * 0.78, 96);
  x.strokeStyle = '#999'; x.lineWidth = 2;
  for (let h = 6; h <= 21; h++) {
    const y = 124 + (h - 6) * 32;
    x.beginPath(); x.moveTo(12, y - 16); x.lineTo(W - 12, y - 16); x.stroke();
    x.font = `700 22px ${LAT_SANS}`; x.fillStyle = '#1f5ea8'; x.fillText(String(h), 36, y);
    x.fillStyle = '#222'; x.font = `500 21px ${LAT_SANS}`;
    for (const [cx, p] of [[W * 0.3, 0.75], [W * 0.78, 0.7]]) {
      const ms = [];
      if (R() < p) ms.push(String(Math.floor(R() * 30)).padStart(2, '0'));
      if (R() < p * 0.45) ms.push(String(30 + Math.floor(R() * 29)).padStart(2, '0'));
      x.fillText(ms.join('   '), cx, y);
    }
  }
  x.beginPath(); x.moveTo(64, 80); x.lineTo(64, H - 20); x.moveTo(W * 0.54, 80); x.lineTo(W * 0.54, H - 20); x.stroke();
  ageCanvas(x, W, H, 31, 0.6);
  return c;
}

function plaqueCanvas() {
  const W = 1024, H = 192, c = cnv(W, H), x = c.getContext('2d'), R = rng(9);
  x.fillStyle = '#5b4a38'; x.fillRect(0, 0, W, H);
  for (let i = 0; i < 90; i++) { x.fillStyle = `rgba(30,20,10,${0.05 + R() * 0.08})`; x.fillRect(0, R() * H, W, 1 + R() * 3); }
  x.fillStyle = '#efe6d2'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '600 118px "Shippori Mincho B1", serif'; x.letterSpacing = '36px';
  x.fillText('ゆめさき駅', W / 2 + 18, H / 2 + 6);
  x.letterSpacing = '0px';
  return c;
}

function posterCanvas() {
  const W = 384, H = 544, c = cnv(W, H), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#9fcfe0'); g.addColorStop(0.55, '#d9ecef'); g.addColorStop(0.56, '#3f86b0'); g.addColorStop(1, '#1f5f8a');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.fillStyle = '#f7d27a'; x.beginPath(); x.arc(W * 0.7, H * 0.3, 46, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#2f5b3a'; x.beginPath(); x.moveTo(0, H * 0.56); x.quadraticCurveTo(W * 0.2, H * 0.4, W * 0.42, H * 0.56); x.fill();
  x.fillStyle = '#ffffff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '600 50px "Shippori Mincho B1", serif'; x.fillText('夏、夢崎へ。', W / 2, H * 0.74);
  x.font = `500 20px ${JP_SANS}`; x.fillText('海の見える小さな駅', W / 2, H * 0.84);
  // faded by the sun
  x.fillStyle = 'rgba(245,240,225,0.35)'; x.fillRect(0, 0, W, H);
  return c;
}

function stopCanvas() {
  const W = 256, H = 256, c = cnv(W, H), x = c.getContext('2d');
  x.fillStyle = '#f5f5f0'; x.fillRect(0, 0, W, H);
  x.strokeStyle = '#1f5ea8'; x.lineWidth = 18; x.strokeRect(9, 9, W - 18, H - 18);
  x.fillStyle = '#111'; x.textAlign = 'center'; x.textBaseline = 'alphabetic';
  x.font = `800 150px ${LAT_SANS}`; x.fillText('1', W / 2 - 22, 185);
  x.font = `700 56px ${JP_SANS}`; x.fillText('両', W / 2 + 62, 185);
  x.font = `700 30px ${JP_SANS}`; x.fillText('停止位置', W / 2, 62);
  return c;
}

function keepOutCanvas() {
  const W = 256, H = 128, c = cnv(W, H), x = c.getContext('2d');
  x.fillStyle = '#f4f4f0'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#c0281c'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = `700 30px ${JP_SANS}`; x.fillText('関係者以外', W / 2, 40);
  x.font = `800 40px ${JP_SANS}`; x.fillText('立入禁止', W / 2, 88);
  ageCanvas(x, W, H, 41, 0.5);
  return c;
}

// station clock stopped at the film's afternoon hour (4:50)
function clockCanvas() {
  const W = 256, c = cnv(W, W), x = c.getContext('2d'), r = W / 2;
  x.fillStyle = '#f7f6f1'; x.fillRect(0, 0, W, W);
  x.translate(r, r);
  x.strokeStyle = '#222'; x.fillStyle = '#222';
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2, l = i % 5 ? 8 : 20, w = i % 5 ? 2 : 6;
    x.lineWidth = w; x.beginPath(); x.moveTo(Math.sin(a) * (r - 14), -Math.cos(a) * (r - 14)); x.lineTo(Math.sin(a) * (r - 14 - l), -Math.cos(a) * (r - 14 - l)); x.stroke();
  }
  const hand = (a, len, w) => { x.lineWidth = w; x.lineCap = 'round'; x.beginPath(); x.moveTo(-Math.sin(a) * 14, Math.cos(a) * 14); x.lineTo(Math.sin(a) * len, -Math.cos(a) * len); x.stroke(); };
  hand(((4 + 50 / 60) / 12) * Math.PI * 2, r * 0.5, 10);
  hand((50 / 60) * Math.PI * 2, r * 0.78, 7);
  x.strokeStyle = '#b8261a'; hand((12 / 60) * Math.PI * 2, r * 0.8, 2.5);
  x.beginPath(); x.arc(0, 0, 8, 0, Math.PI * 2); x.fill();
  return c;
}

// notice board papers: timetable change, a summer festival, lost property
function noticeCanvas() {
  const W = 512, H = 384, c = cnv(W, H), x = c.getContext('2d'), R = rng(51);
  x.fillStyle = '#6b5a45'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#8a7a62'; x.fillRect(12, 12, W - 24, H - 24);
  const paper = (px, py, w, h, bg, title, tc, lines) => {
    x.save(); x.translate(px + w / 2, py + h / 2); x.rotate((R() - 0.5) * 0.06); x.translate(-w / 2, -h / 2);
    x.fillStyle = bg; x.fillRect(0, 0, w, h);
    x.fillStyle = tc; x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = `700 ${Math.round(w / 7)}px ${JP_SANS}`;
    x.fillText(title, w / 2, h * 0.16);
    x.fillStyle = 'rgba(40,40,40,0.55)';
    for (let i = 0; i < lines; i++) x.fillRect(w * 0.12, h * (0.32 + i * 0.1), w * (0.5 + R() * 0.26), 5);
    x.fillStyle = '#c33'; x.beginPath(); x.arc(w / 2, 8, 5, 0, Math.PI * 2); x.fill();
    x.restore();
  };
  paper(30, 30, 200, 150, '#f4f1e6', 'お知らせ', '#1f5ea8', 5);
  paper(260, 26, 220, 300, '#fbe9c8', '夏まつり', '#c0402a', 8);
  paper(40, 200, 190, 150, '#eef3f6', '落とし物', '#333', 4);
  return c;
}

// drinks vending machine front: backlit sample rows, buttons, coin panel, pickup slot
function vendingCanvas() {
  const W = 512, H = 1024, face = cnv(W, H), glow = cnv(W, H), x = face.getContext('2d'), g = glow.getContext('2d'), R = rng(61);
  x.fillStyle = '#e9ecef'; x.fillRect(0, 0, W, H);
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  x.fillStyle = '#2a64b0'; x.fillRect(0, 0, W, 70);
  x.fillStyle = '#f4f6f8'; x.fillRect(24, 90, W - 48, 560);
  const cols = ['#d23a2e', '#2f7fd0', '#f0b429', '#3aa05a', '#8a5a3a', '#e8e8e8', '#1b3f7a', '#f07a2a', '#5bc0de', '#b52a64'];
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < 6; i++) {
      const cx = 52 + i * 76, cy = 120 + row * 180;
      x.fillStyle = cols[Math.floor(R() * cols.length)];
      x.beginPath(); x.roundRect(cx, cy, 52, 118, 10); x.fill();
      x.fillStyle = 'rgba(255,255,255,0.45)'; x.fillRect(cx + 8, cy + 14, 8, 90);
      x.fillStyle = '#333'; x.fillRect(cx + 4, cy + 132, 44, 20);
      x.fillStyle = R() < 0.2 ? '#e33' : '#3c3'; x.fillRect(cx + 18, cy + 138, 16, 8);
    }
  }
  x.fillStyle = '#c9ced3'; x.fillRect(24, 680, W - 48, 150);
  x.fillStyle = '#555'; x.fillRect(W - 150, 700, 90, 14); x.fillRect(W - 150, 740, 90, 40);
  x.fillStyle = '#222'; x.fillRect(60, 880, W - 120, 90);
  // the night glow is the backlit sample window itself
  g.drawImage(face, 24, 90, W - 48, 560, 24, 90, W - 48, 560);
  return { face, glow };
}

// ---- the station --------------------------------------------------------------------
function buildStation(opts = {}) {
  const M = materials(), SMx = stationMats();
  const B = new Builder();
  const gws = new Map();
  const gw = (mat, color = WHITE) => {
    const k = mat.uuid + '|' + color.join(',');
    if (!gws.has(k)) gws.set(k, { mat, color, w: new GW() });
    return gws.get(k).w;
  };
  const box = (mat, x0, y0, z0, x1, y1, z1, color = WHITE) => mbox(B, mat, x0, y0, z0, x1, y1, z1, color);
  const cyl = (mat, o) => B.cyl(mat, o);
  // long pieces are cut into short lengths so fitToTrack() can bend them along the line
  const segs = (a, b, max = 3) => { const n = Math.max(1, Math.ceil(Math.abs(b - a) / max)); return Array.from({ length: n }, (_, i) => [a + (b - a) * i / n, a + (b - a) * (i + 1) / n]); };
  const zbox = (mat, x0, y0, za, x1, y1, zb, color = WHITE) => { for (const [p, q] of segs(za, zb)) box(mat, x0, y0, p, x1, y1, q, color); };
  const zquad = (g, x0, x1, y, za, zb, uvFn = null) => { for (const [p, q] of segs(za, zb)) g.quad([x0, y, p], [x1, y, p], [x1, y, q], [x0, y, q], [0, 1, 0], null, uvFn ? uvFn(p, q) : null); };
  const R = rng(opts.seed ? +opts.seed : 4411);
  const { z0, z1, edge, top, back, wall, base } = ST;
  const ramp = ST.ramp, sh = ST.sh, pad = ST.pad;
  const rz = z0 - ramp.len; // foot of the ramp
  const C = {
    coping: [1.12, 1.1, 1.04], wall: [0.82, 0.8, 0.76], line: lin(0.8, 0.8, 0.77),
    fence: lin(0.62, 0.7, 0.64), post: lin(0.78, 0.78, 0.76), pole: lin(0.55, 0.57, 0.58), blue: lin(0.20, 0.36, 0.58),
    frame: lin(0.25, 0.26, 0.27), fire: lin(0.7, 0.08, 0.05), bin: lin(0.35, 0.45, 0.52),
  };

  // ---- platform body: coping, deck, walls
  for (let z = z0; z < z1 - 1e-6; z += 1.0) {
    const zb = Math.min(z1, z + 1.0);
    const t = 0.97 + 0.08 * R();
    box(M.concrete, edge, top - 0.16, z + 0.004, 1.93, top, zb - 0.004, C.coping.map((c) => c * t));
  }
  zbox(M.concrete, edge + 0.01, top - 0.3, z0, 1.93, top - 0.16, z1, C.coping);               // joint backing
  zquad(gw(M.matte, C.line), edge + 0.03, edge + 0.13, top + 0.002, z0, z1);                    // white edge line
  zbox(M.concrete, 1.93, top - 0.3, z0, back, top - 0.004, z1, [0.9, 0.89, 0.86]);              // deck
  zbox(M.concrete, wall, base, z0, wall + 0.3, top - 0.16, z1, C.wall);                         // face towards the track
  zbox(M.concrete, back - 0.25, base, z0, back, top - 0.3, pad.z0, C.wall);                     // back wall (both sides of the pad)
  zbox(M.concrete, back - 0.25, base, pad.z1, back, top - 0.3, z1, C.wall);
  box(M.concrete, wall, base, z1 - 0.25, back, top - 0.3, z1, C.wall);                         // south end
  box(M.concrete, wall, base, z0, ramp.x0, top - 0.3, z0 + 0.25, C.wall);                      // north end beside the ramp
  // tactile strip along the platform and across the top of the ramp
  const tq = (x0, x1, za, zb, uvAlong = true) => zquad(gw(SMx.tactile), x0, x1, top + 0.004, za, zb,
    (p, q) => (uvAlong ? [[0, p], [x1 - x0, p], [x1 - x0, q], [0, q]] : [[p, 0], [p, x1 - x0], [q, x1 - x0], [q, 0]]));
  tq(ST.tactile[0], ST.tactile[1], z0 + 0.3, z1 - 0.3);
  tq(ST.tactile[1], back - 0.1, z0 + 0.3, z0 + 0.6, false);
  // shelter pad
  box(M.concrete, back, top - 0.3, pad.z0, pad.x1, top - 0.004, pad.z1, [0.86, 0.85, 0.82]);
  box(M.concrete, pad.x1 - 0.25, base, pad.z0, pad.x1, top - 0.3, pad.z1, C.wall);
  box(M.concrete, back, base, pad.z0, pad.x1, top - 0.3, pad.z0 + 0.25, C.wall);
  box(M.concrete, back, base, pad.z1 - 0.25, pad.x1, top - 0.3, pad.z1, C.wall);
  box(M.concrete, back - 0.02, top - 0.3, pad.z0 - 0.02, pad.x1 + 0.02, top - 0.004 - 0.12, pad.z1 + 0.02, C.coping);

  // ---- ramp down at the -z end (to the rail bed level east of the track)
  {
    const x0 = ramp.x0, x1 = back, ya = top - 0.004, yb = ramp.y1;
    const yAt = (z) => ya + (yb - ya) * (z0 - z) / ramp.len;
    const g = gw(M.concrete, [0.88, 0.87, 0.84]), gw2 = gw(M.concrete, C.wall);
    const nrm = norm([0, ramp.len, -(ya - yb)]);
    for (const [p, q] of segs(z0, rz, 2)) {
      g.quad([x0, yAt(p), p], [x1, yAt(p), p], [x1, yAt(q), q], [x0, yAt(q), q], nrm);
      for (const [x, sg] of [[x0, -1], [x1, 1]]) gw2.quad([x, base, p], [x, yAt(p) + 0.08, p], [x, yAt(q) + 0.08, q], [x, base, q], [sg, 0, 0]);
      for (const x of [x0 + 0.06, x1 - 0.06]) {
        // kerbs and handrail bays
        const L = Math.hypot(q - p, yAt(q) - yAt(p)), ang = Math.atan2(yAt(p) - yAt(q), p - q);
        B.box(M.concrete, { w: 0.12, h: 0.08, d: L, pos: [x, (yAt(p) + yAt(q)) / 2 + 0.04, (p + q) / 2], rot: [-ang, 0, 0], color: C.coping });
        cyl(M.paint, { r: 0.022, h: 0.9, seg: 6, pos: [x, yAt(p) + 0.45, p], color: C.post });
        for (const hy of [0.86, 0.45]) cyl(M.paint, { r: 0.024, h: L, seg: 6, pos: [x, (yAt(p) + yAt(q)) / 2 + hy, (p + q) / 2], rot: [Math.PI / 2 - ang, 0, 0], color: C.post });
      }
    }
    for (const x of [x0 + 0.06, x1 - 0.06]) cyl(M.paint, { r: 0.022, h: 0.9, seg: 6, pos: [x, yb + 0.45, rz], color: C.post });
    gw2.quad([x0, base, rz], [x1, base, rz], [x1, yb, rz], [x0, yb, rz], [0, 0, -1]);
  }

  // ---- fence along the back of the platform
  {
    const fx = back - 0.07;
    const runs = [[z0 + 0.1, pad.z0 - 0.05], [pad.z1 + 0.05, z1 - 0.1]];
    for (const [za, zb] of runs) {
      const n = Math.max(1, Math.round((zb - za) / 2.0));
      for (let i = 0; i <= n; i++) {
        const z = za + ((zb - za) * i) / n;
        box(M.paint, fx - 0.025, top, z - 0.025, fx + 0.025, top + 1.12, z + 0.025, C.fence);
        box(M.paint, fx - 0.035, top + 1.12, z - 0.035, fx + 0.035, top + 1.15, z + 0.035, C.fence);
      }
      for (let i = 0; i < n; i++) {
        const p = za + ((zb - za) * i) / n, q = za + ((zb - za) * (i + 1)) / n;
        for (const hy of [0.5, 1.06]) cyl(M.paint, { r: 0.022, h: q - p, seg: 6, pos: [fx, top + hy, (p + q) / 2], rot: [Math.PI / 2, 0, 0], color: C.fence });
        box(M.paint, fx - 0.01, top, p, fx + 0.01, top + 0.12, q, C.fence.map((c) => c * 0.8));
      }
    }
    // across the south end of the platform, with a keep-out plate
    const ez = z1 - 0.1;
    for (let i = 0; i <= 3; i++) {
      const x = 1.95 + (fx - 1.95) * i / 3;
      box(M.paint, x - 0.025, top, ez - 0.025, x + 0.025, top + 1.12, ez + 0.025, C.fence);
    }
    for (const hy of [0.5, 1.06]) cyl(M.paint, { r: 0.022, h: fx - 1.95, seg: 6, pos: [(fx + 1.95) / 2, top + hy, ez], rot: [0, 0, Math.PI / 2], color: C.fence });
    box(M.paint, 2.9, top + 0.62, ez - 0.035, 3.5, top + 0.94, ez - 0.03, lin(0.92, 0.92, 0.9));
    gw(SMx.keepout).quad([3.5, top + 0.63, ez - 0.037], [2.9, top + 0.63, ez - 0.037], [2.9, top + 0.93, ez - 0.037], [3.5, top + 0.93, ez - 0.037], [0, 0, -1], null, [[0, 0], [1, 0], [1, 1], [0, 1]]);
  }

  // ---- lamp posts (steel pole, arm towards the track, fluorescent fitting)
  const lampAt = (z) => {
    const x = back - 0.25, h = 4.1;
    cyl(M.paint, { r: 0.055, r2: 0.045, h: h - top, seg: 10, pos: [x, (top + h) / 2, z], color: C.pole });
    box(M.concrete, x - 0.14, top, z - 0.14, x + 0.14, top + 0.12, z + 0.14, C.coping);
    B.box(M.paint, { w: 0.9, h: 0.05, d: 0.05, pos: [x - 0.42, h - 0.08, z], rot: [0, 0, 0.12], color: C.pole });
    box(M.paint, x - 1.0, h - 0.06, z - 0.09, x - 0.5, h + 0.03, z + 0.09, lin(0.85, 0.85, 0.83));
    box(M.lamp, x - 0.98, h - 0.075, z - 0.07, x - 0.52, h - 0.055, z + 0.07);
    cyl(M.paint, { r: 0.06, h: 0.03, seg: 10, pos: [x, h + 0.02, z], color: C.pole });
  };
  for (const z of [-16.5, 5.2, 16.5]) lampAt(z);

  // ---- waiting shelter (待合所): three walls of weathered boards, open to the platform
  {
    const { x0, x1, z0: a, z1: b, eaveF, eaveB } = sh;
    const yT = top, roofAt = (x) => eaveF + (eaveB - eaveF) * (x - (x0 - 0.55)) / ((x1 + 0.35) - (x0 - 0.55));
    const tv = SMx.timberV, th = SMx.timberH;
    // corner and front posts
    for (const [px, pz] of [[x0, a], [x0, b], [x1, a], [x1, b], [x0, -0.85]]) box(tv, px - 0.055, yT, pz - 0.055, px + 0.055, roofAt(px) - 0.1, pz + 0.055);
    // sill beams
    box(th, x0, yT, a - 0.05, x1, yT + 0.1, a + 0.05); box(th, x0, yT, b - 0.05, x1, yT + 0.1, b + 0.05);
    box(th, x1 - 0.05, yT, a, x1 + 0.05, yT + 0.1, b);
    // back wall (boards outside and in), side walls with a window each
    const wH = M.woodH, wIn = gw(wH, [1.25, 1.22, 1.16]), wOut = gw(wH, [1.35, 1.3, 1.22]), wRev = gw(th);
    const topB = roofAt(x1) - 0.12;
    holeWall(wOut, wIn, wRev, { axis: 'x', sign: 1, c: x1 + 0.03, t: 0.05, u0: a - 0.03, u1: b + 0.03, v0: yT + 0.1, v1: topB, holes: [] });
    for (const [zz, sg] of [[a, -1], [b, 1]]) {
      const win = sg < 0 ? [x0 + 1.1, x0 + 1.8, yT + 1.05, yT + 1.85] : [x0 + 0.55, x0 + 1.35, yT + 1.05, yT + 1.85];
      holeWall(wOut, wIn, wRev, { axis: 'z', sign: sg, c: Math.abs(zz) * Math.sign(zz) * sg + 0.03, t: 0.05, u0: x0 + 0.06, u1: x1 - 0.03, v0: yT + 0.1, v1: roofAt(x1) - 0.12, holes: [win] });
      // window: glass, sash bars
      const zg = zz + sg * 0.005;
      gw(M.glass).quad([win[0], win[2], zg], [win[1], win[2], zg], [win[1], win[3], zg], [win[0], win[3], zg], [0, 0, sg]);
      const zf0 = zz - 0.02, zf1 = zz + 0.02;
      box(th, win[0], win[2] - 0.04, zf0 - sg * 0.02, win[1], win[2], zf1 + sg * 0.03);
      box(th, win[0], win[3], zf0, win[1], win[3] + 0.04, zf1);
      box(th, (win[0] + win[1]) / 2 - 0.02, win[2], zf0, (win[0] + win[1]) / 2 + 0.02, win[3], zf1);
      box(th, win[0], (win[2] + win[3]) / 2 - 0.02, zf0, win[1], (win[2] + win[3]) / 2 + 0.02, zf1);
      // the side wall's top follows the roof slope: fill the gable triangle
      const yL = roofAt(x1) - 0.12, g2 = gw(wH, [1.35, 1.3, 1.22]);
      const zw = zz + sg * 0.03;
      g2.quad([x0 + 0.06, yL, zw], [x1 - 0.03, yL, zw], [x1 - 0.03, roofAt(x1) - 0.05, zw], [x0 + 0.06, roofAt(x0 + 0.06) - 0.05, zw], [0, 0, sg]);
      g2.quad([x0 + 0.06, yL, zw - sg * 0.05], [x1 - 0.03, yL, zw - sg * 0.05], [x1 - 0.03, roofAt(x1) - 0.05, zw - sg * 0.05], [x0 + 0.06, roofAt(x0 + 0.06) - 0.05, zw - sg * 0.05], [0, 0, -sg]);
    }
    // notice board on the north wall (seen when walking along the platform)
    {
      const zb = a - 0.03, xa = x0 + 0.12, xb = x0 + 0.95, ya = yT + 1.05, yb = yT + 1.7;
      box(th, xa - 0.03, ya - 0.03, zb - 0.035, xb + 0.03, yb + 0.03, zb, [0.8, 0.75, 0.7]);
      gw(SMx.notice).quad([xa, ya, zb - 0.037], [xb, ya, zb - 0.037], [xb, yb, zb - 0.037], [xa, yb, zb - 0.037], [0, 0, -1], null, [[1, 0], [0, 0], [0, 1], [1, 1]]);
      box(th, xa - 0.06, yb + 0.03, zb - 0.1, xb + 0.06, yb + 0.06, zb, [0.8, 0.75, 0.7]);
    }
    // front: short wall returns either side of the opening, lintel beam
    const opA = a + 0.75, opB = b - 0.75;
    for (const [za, zb] of [[a + 0.05, opA], [opB, b - 0.05]]) holeWall(wOut, wIn, wRev, { axis: 'x', sign: -1, c: -(x0 - 0.03), t: 0.05, u0: za, u1: zb, v0: yT + 0.1, v1: roofAt(x0) - 0.25, holes: [] });
    box(th, x0 - 0.06, roofAt(x0) - 0.3, a - 0.06, x0 + 0.06, roofAt(x0) - 0.12, b + 0.06);
    box(th, x1 - 0.06, roofAt(x1) - 0.24, a - 0.06, x1 + 0.06, roofAt(x1) - 0.08, b + 0.06);
    // rafters and the corrugated lean-to roof (ribs run down the slope)
    const rx0 = x0 - 0.55, rx1 = x1 + 0.35, rza = a - 0.3, rzb = b + 0.3;
    for (let z = rza + 0.1; z <= rzb - 0.05; z += (rzb - rza - 0.2) / 5) {
      const L = Math.hypot(rx1 - rx0, eaveB - eaveF), ang = Math.atan2(eaveF - eaveB, rx1 - rx0);
      B.box(th, { w: L, h: 0.1, d: 0.06, pos: [(rx0 + rx1) / 2, (eaveF + eaveB) / 2 - 0.08, z], rot: [0, 0, -ang] });
    }
    const rf = gw(M.corrugated), yf = eaveF, yb = eaveB, L = Math.hypot(rx1 - rx0, yf - yb);
    const rn = norm([yf - yb, rx1 - rx0, 0]);
    rf.quad([rx0, yf, rza], [rx0, yf, rzb], [rx1, yb, rzb], [rx1, yb, rza], rn, null, [[rza, 0], [rzb, 0], [rzb, L], [rza, L]]);
    rf.quad([rx0, yf - 0.012, rza], [rx0, yf - 0.012, rzb], [rx1, yb - 0.012, rzb], [rx1, yb - 0.012, rza], [-rn[0], -rn[1], 0], null, [[rza, 0], [rzb, 0], [rzb, L], [rza, L]]);
    // fascia boards
    box(th, rx0 - 0.03, yf - 0.16, rza, rx0, yf + 0.02, rzb, [0.85, 0.82, 0.78]);
    for (const zz of [rza, rzb]) {
      const ang = Math.atan2(yf - yb, rx1 - rx0);
      B.box(th, { w: L, h: 0.14, d: 0.03, pos: [(rx0 + rx1) / 2, (yf + yb) / 2 - 0.05, zz], rot: [0, 0, -ang], color: [0.85, 0.82, 0.78] });
    }
    // bench along the back wall, a smaller one on the north wall
    const bench = (xa, xb, za, zb, legs) => {
      box(th, xa, yT + 0.4, za, xb, yT + 0.44, zb);
      for (const [lx, lz] of legs) box(tv, lx - 0.03, yT, lz - 0.03, lx + 0.03, yT + 0.4, lz + 0.03);
    };
    bench(x1 - 0.42, x1 - 0.02, a + 0.12, b - 0.12, [[x1 - 0.35, a + 0.3], [x1 - 0.35, b - 0.3], [x1 - 0.35, (a + b) / 2]]);
    box(th, x1 - 0.03, yT + 0.6, a + 0.12, x1 - 0.005, yT + 0.8, b - 0.12);
    bench(x0 + 0.45, x1 - 0.5, a + 0.03, a + 0.38, [[x0 + 0.55, a + 0.2], [x1 - 0.6, a + 0.2]]);
    // timetable and a sun-faded poster on the back wall, a fire extinguisher
    // seen from -x (looking +x) the reader's left is -z
    const decal = (mat, wx, za, zb, ya, yb) => gw(mat).quad([wx, ya, za], [wx, ya, zb], [wx, yb, zb], [wx, yb, za], [-1, 0, 0], null, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    box(th, x1 - 0.04, yT + 0.98, -1.63, x1 - 0.02, yT + 1.72, -0.97, [0.7, 0.65, 0.6]);
    decal(SMx.timetable, x1 - 0.042, -1.6, -1.0, yT + 1.0, yT + 1.7);
    decal(SMx.poster, x1 - 0.022, -0.5, 0.0, yT + 1.05, yT + 1.75);
    cyl(M.paint, { r: 0.075, h: 0.45, seg: 10, pos: [x1 - 0.14, yT + 0.25, b - 0.16], color: C.fire });
    cyl(M.darkMetal, { r: 0.03, h: 0.08, seg: 6, pos: [x1 - 0.14, yT + 0.51, b - 0.16] });
    // a bare bulb under an enamel shade
    const lx = (x0 + x1) / 2, lz = (a + b) / 2, ly = roofAt(lx) - 0.55;
    cyl(M.rubber, { r: 0.006, h: 0.4, seg: 4, pos: [lx, ly + 0.35, lz] });
    cyl(M.paint, { r: 0.03, r2: 0.16, h: 0.08, seg: 14, pos: [lx, ly + 0.1, lz], open: true, color: lin(0.9, 0.9, 0.88) });
    B.geo(M.lamp, new THREE.SphereGeometry(0.045, 10, 8), Builder.mat({ pos: [lx, ly + 0.04, lz] }));
    // station clock on a bracket under the lintel, facing the platform
    {
      const cx = x0 - 0.16, cy = roofAt(x0) - 0.55, cz = 1.02;
      box(M.darkMetal, cx - 0.02, cy + 0.17, cz - 0.02, x0 - 0.05, cy + 0.26, cz + 0.02);
      cyl(M.paint, { r: 0.19, h: 0.07, seg: 22, pos: [cx, cy, cz], rot: [0, 0, Math.PI / 2], color: lin(0.9, 0.9, 0.88) });
      const seg = 22, xf = cx - 0.036;
      const cg = gw(SMx.clock);
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, r = 0.165;
        const P = (aa) => [xf, cy + Math.sin(aa) * r, cz - Math.cos(aa) * r];
        const T = (aa) => [0.5 - Math.cos(aa) * 0.5 * (r / 0.165) * 0.94, 0.5 + Math.sin(aa) * 0.5 * 0.94];
        cg.tri([xf, cy, cz], P(a0), P(a1), [-1, 0, 0], [[0.5, 0.5], T(a0), T(a1)]);
      }
    }
    // wooden plaque with the station's name on the lintel
    {
      const px = x0 - 0.07, ya = roofAt(x0) - 0.29, yb = roofAt(x0) - 0.13, za = -1.55, zb = 0.05;
      gw(SMx.plaque).quad([px, ya, za], [px, ya, zb], [px, yb, zb], [px, yb, za], [-1, 0, 0], null, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
    // hanging station sign (perpendicular to the track) on a bracket off the north front post
    {
      const zc = a, xa = 3.9, xb = 4.85, yb = roofAt(x0) - 0.34, ya = yb - 0.28, arm = yb + 0.1;
      box(M.paint, xa - 0.12, arm - 0.025, zc - 0.025, x0 - 0.05, arm + 0.025, zc + 0.025, C.frame);
      const bl = Math.hypot(0.55, 0.35);
      B.box(M.paint, { w: bl, h: 0.03, d: 0.03, pos: [x0 - 0.33, arm - 0.19, zc], rot: [0, 0, -Math.atan2(0.35, 0.55)], color: C.frame });
      box(M.paint, xa - 0.02, ya - 0.02, zc - 0.022, xb + 0.02, yb + 0.02, zc + 0.022, C.frame);
      for (const x of [xa + 0.12, xb - 0.12]) cyl(M.darkMetal, { r: 0.007, h: arm - yb, seg: 4, pos: [x, (arm + yb) / 2, zc] });
      const fz = (sg) => zc + sg * 0.024;
      // seen from -z the reader's left is +x; seen from +z it is -x
      gw(SMx.hang).quad([xa, ya, fz(-1)], [xb, ya, fz(-1)], [xb, yb, fz(-1)], [xa, yb, fz(-1)], [0, 0, -1], null, [[1, 0], [0, 0], [0, 1], [1, 1]]);
      gw(SMx.hang).quad([xa, ya, fz(1)], [xb, ya, fz(1)], [xb, yb, fz(1)], [xa, yb, fz(1)], [0, 0, 1], null, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
  }

  // ---- station name board (駅名標) facing the track, on two posts
  {
    const zc = 7.0, bw = 1.9, ya = top + 1.12, yb = ya + 0.95, xf = back - 0.55;
    const za = zc - bw / 2, zb = zc + bw / 2;
    for (const z of [za + 0.2, zb - 0.2]) {
      cyl(M.paint, { r: 0.04, h: yb + 0.12 - top, seg: 10, pos: [xf + 0.07, (top + yb + 0.12) / 2, z], color: C.post });
      cyl(M.paint, { r: 0.05, h: 0.03, seg: 10, pos: [xf + 0.07, yb + 0.135, z], color: C.post });
    }
    box(M.paint, xf - 0.01, ya, za, xf + 0.03, yb, zb, lin(0.9, 0.9, 0.88));
    // frame
    box(M.paint, xf - 0.02, ya - 0.03, za - 0.03, xf + 0.04, ya, zb + 0.03, C.frame);
    box(M.paint, xf - 0.02, yb, za - 0.03, xf + 0.04, yb + 0.03, zb + 0.03, C.frame);
    box(M.paint, xf - 0.02, ya, za - 0.03, xf + 0.04, yb, za, C.frame);
    box(M.paint, xf - 0.02, ya, zb, xf + 0.04, yb, zb + 0.03, C.frame);
    // faces: towards the track (-x) reads left = -z; the back (+x) reads left = +z
    gw(SMx.board).quad([xf - 0.012, ya, zb], [xf - 0.012, ya, za], [xf - 0.012, yb, za], [xf - 0.012, yb, zb], [-1, 0, 0], null, [[1, 0.5], [0, 0.5], [0, 1], [1, 1]]);
    gw(SMx.board).quad([xf + 0.032, ya, za], [xf + 0.032, ya, zb], [xf + 0.032, yb, zb], [xf + 0.032, yb, za], [1, 0, 0], null, [[1, 0], [0, 0], [0, 0.5], [1, 0.5]]);
  }

  // ---- benches, bin, planter, ticket box, stop markers, mirrors
  {
    // drinks vending machine against the fence, facing the platform
    {
      const vx1 = back - 0.1, vx0 = vx1 - 0.72, vz0 = 2.15, vz1 = 3.15, vh = top + 1.83;
      box(M.paint, vx0, top, vz0, vx1, vh, vz1, lin(0.86, 0.87, 0.88));
      box(M.paint, vx0 - 0.01, vh - 0.13, vz0 - 0.01, vx1 + 0.01, vh, vz1 + 0.01, lin(0.16, 0.36, 0.66));
      box(M.darkMetal, vx0 + 0.05, top, vz0 + 0.05, vx1 - 0.05, top + 0.08, vz1 - 0.05);
      const xf = vx0 - 0.003;
      gw(SMx.vending).quad([xf, top + 0.1, vz0 + 0.04], [xf, top + 0.1, vz1 - 0.04], [xf, vh - 0.02, vz1 - 0.04], [xf, vh - 0.02, vz0 + 0.04], [-1, 0, 0], null, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
    // painted wooden bench against the fence, south of the shelter
    const bx = back - 0.62, bz = 4.4;
    for (const dz of [-0.75, 0.75]) {
      box(M.darkMetal, bx - 0.2, top, bz + dz - 0.025, bx + 0.2, top + 0.04, bz + dz + 0.025);
      box(M.darkMetal, bx - 0.02, top, bz + dz - 0.025, bx + 0.02, top + 0.42, bz + dz + 0.025);
      box(M.darkMetal, bx + 0.15, top + 0.42, bz + dz - 0.02, bx + 0.19, top + 0.85, bz + dz + 0.02);
    }
    for (let i = 0; i < 3; i++) box(M.paint, bx - 0.22 + i * 0.13, top + 0.42, bz - 0.95, bx - 0.12 + i * 0.13, top + 0.45, bz + 0.95, C.blue);
    for (let i = 0; i < 2; i++) box(M.paint, bx + 0.17, top + 0.55 + i * 0.16, bz - 0.95, bx + 0.2, top + 0.67 + i * 0.16, bz + 0.95, C.blue);
    // bin with a lid slot
    const ix = back - 0.35, iz = 5.72;
    box(M.paint, ix - 0.2, top, iz - 0.2, ix + 0.2, top + 0.78, iz + 0.2, C.bin);
    box(M.paint, ix - 0.22, top + 0.78, iz - 0.22, ix + 0.22, top + 0.82, iz + 0.22, C.bin.map((c) => c * 0.8));
    box(M.rubber, ix - 0.205, top + 0.62, iz - 0.1, ix - 0.195, top + 0.7, iz + 0.1);
    // planter box with bare soil (plants come from the flora pass)
    const px0 = back - 0.62, px1 = back - 0.12, pz0 = -12.9, pz1 = -11.1;
    box(M.concrete, px0, top, pz0, px1, top + 0.36, pz0 + 0.06, C.coping); box(M.concrete, px0, top, pz1 - 0.06, px1, top + 0.36, pz1, C.coping);
    box(M.concrete, px0, top, pz0, px0 + 0.06, top + 0.36, pz1, C.coping); box(M.concrete, px1 - 0.06, top, pz0, px1, top + 0.36, pz1, C.coping);
    box(M.dirt, px0 + 0.06, top, pz0 + 0.06, px1 - 0.06, top + 0.31, pz1 - 0.06, [0.75, 0.68, 0.6]);
    // boarding-certificate dispenser on a post near the ramp
    box(M.paint, back - 0.3, top, -20.6, back - 0.24, top + 1.0, -20.54, C.pole);
    box(M.paint, back - 0.42, top + 1.0, -20.75, back - 0.14, top + 1.38, -20.4, lin(0.85, 0.86, 0.86));
    box(M.rubber, back - 0.425, top + 1.12, -20.66, back - 0.41, top + 1.28, -20.48);
    // stop-position markers near the edge (one for each direction) and door mirrors
    const stopSign = (z, s) => {
      const x = 1.78;
      cyl(M.paint, { r: 0.025, h: 1.55, seg: 6, pos: [x, top + 0.775, z], color: C.post });
      box(M.paint, x - 0.16, top + 1.5, z - 0.01, x + 0.16, top + 1.82, z + 0.01, lin(0.66, 0.67, 0.66));
      gw(SMx.stop).quad([x - 0.15 * s, top + 1.51, z + s * 0.012], [x + 0.15 * s, top + 1.51, z + s * 0.012], [x + 0.15 * s, top + 1.81, z + s * 0.012], [x - 0.15 * s, top + 1.81, z + s * 0.012], [0, 0, s], null, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    };
    stopSign(ST.stop.south, -1); stopSign(ST.stop.north, 1);
    const mirror = (z, s) => {
      const x = back - 0.25, y = top + 2.95;
      cyl(M.paint, { r: 0.035, h: 3.0, seg: 8, pos: [x, top + 1.5, z], color: C.pole });
      const n = new THREE.Vector3(-0.55, -0.12, -0.83 * s).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
      const at = (d) => new THREE.Matrix4().compose(new THREE.Vector3(x - 0.06, y, z).addScaledVector(n, d), q, new THREE.Vector3(1, 1, 1));
      B.geo(M.paint, new THREE.CylinderGeometry(0.25, 0.25, 0.05, 22), at(0), lin(0.9, 0.45, 0.08));
      B.geo(SMx.mirror, new THREE.CylinderGeometry(0.215, 0.215, 0.01, 22), at(0.028));
      box(M.paint, x - 0.06, y - 0.03, z - 0.03, x, y + 0.03, z + 0.03, C.pole);
    };
    mirror(19.0, 1); mirror(-19.5, -1);
  }

  for (const { mat, color, w } of gws.values()) if (!w.empty) B.geo(mat, w.geometry(), null, color);
  const g = B.build({ name: 'station' });
  g.userData = {
    platform: { z0, z1, edge, top, back }, shelter: { ...sh }, ramp: { z0, z1: rz, top, bottom: ramp.y1, x0: ramp.x0, x1: back },
    walkX: [2.7, 4.4], stopFront: { ...ST.stop },
  };
  return g;
}

export const MODELS = {
  train: (opts = {}) => buildTrain(opts),
  // 60 m straight demo, lifted so the ballast toe meets the viewer's ground (y = 0);
  // ?train=1 adds a railcar on it
  track(opts = {}) {
    const y = 0.64, g = new THREE.Group();
    const tr = buildTrack([[0, y, -30], [0, y, -10], [0, y, 10], [0, y, 30]], { ...opts, depth: 0.7 });
    g.add(tr);
    if (opts.train === '1') g.add(placeOnTrack(buildTrain(opts), tr, 30 + (+opts.s || 0)));
    return g;
  },
  station: (opts = {}) => buildStation(opts),
  // station + 120 m of track + a railcar at the southbound stop, lifted onto the viewer's ground
  // (?curve=R bends the line with radius R metres and fits the station to it)
  stationScene(opts = {}) {
    const y = 0.64, g = new THREE.Group();
    g.position.y = y;
    const Rc = +opts.curve || 0, pts = [];
    for (let z = -60; z <= 60; z += 10) pts.push([Rc ? Rc - Math.sqrt(Math.max(0, Rc * Rc - z * z)) : 0, 0, z]);
    const tr = buildTrack(pts, { depth: 0.7 });
    const st = fitToTrack(buildStation(opts), tr, 60);
    g.add(tr, st);
    if (opts.train !== '0') g.add(placeOnTrack(buildTrain(opts), tr, 60 + (opts.s !== undefined ? +opts.s : ST.stop.south - K.HL - 0.1)));
    return g;
  },
};
