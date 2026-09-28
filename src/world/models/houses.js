// houses: Showa-era seaside village houses (昭和の港町の民家), a storage shed, the fishery
// co-op and a row of attached townhouses (長屋) for the quay.
//
// Every model is built at the origin on y = 0 with its front (street / entrance side)
// facing +z; foundations reach down to y = -0.6 so they sit on uneven ground.
// Roofs are kawara (J-tile) roofs: stepped tile rows that line up with the roofTile
// texture, eave tiles with round roll ends, verge tiles, stacked ridge tiles (熨斗 +
// 冠瓦) with 鬼瓦 end blocks, exposed rafters under the eaves, fascia boards and
// half-round gutters with downpipes.
import * as THREE from 'three';
import { Builder, boxGeometry, worldUV } from '../builder.js';
import { materials, texturedMaterial, registerNight, tnoise, tfbm, clamp01, hashf } from '../lib.js';
import { prep } from '../materials.js';
import { rng } from '../noise.js';

const UP = new THREE.Vector3(0, 1, 0);
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const WHITE = [1, 1, 1];
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(+v) ? d : +v);
const str = (v, d) => (v === undefined || v === null || v === '' ? d : String(v));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// roofTile texture orientation. The painter draws each row's raised lip at the start of
// the row in canvas space (canvas y runs down the image, and three flips canvases on
// upload), so the tiles overlap the right way when texture v runs DOWN the slope.
// Set to +1 if the painter is ever flipped.
const ROOF_V = -1;
// Row boundaries inside one 1.2 m texture tile, measured up the slope from the eave
// (the painter has 4.8 rows per tile, so every fifth row is only 0.2 m).
const ROWS = ROOF_V < 0 ? [0, 0.25, 0.5, 0.75, 1.0] : [0, 0.2, 0.45, 0.7, 0.95];
const ROLL0 = 0.78 * 0.3; // u of the first J-tile roll (one roll per 0.3 m)

// ---------------------------------------------------------------------------
// materials: the shared library plus a few of our own (created once)
let HM = null;
function mats() {
  if (HM) return HM;
  const M = materials();
  HM = { ...M };
  // straight-grained, weathered timber for posts, boards, rafters and lattices (grain along v)
  HM.timber = texturedMaterial('timber', { n: 256, period: 1.0, normal: 1.2, fn: (u, v) => {
    const s = tnoise(u, v, 34, 3, 2) * 0.6 + tnoise(u, v, 90, 4, 3) * 0.4;
    const b = tfbm(u, v, 3, 3, 5);
    const t = 0.92 + s * 0.12 + b * 0.12;
    return [0.40 * t, 0.33 * t, 0.26 * t, 0.5 + s * 0.12, 0.8 + b * 0.08];
  } });
  // glass in front of something light (curtain, shoji, frosted glass): diffuse = what is
  // behind, specular = the glass
  const plain = (name, o) => prep(new THREE.MeshStandardMaterial({ name, vertexColors: true, ...o }), null, 'houses-' + name);
  HM.pane = plain('pane', { color: 0xffffff, roughness: 0.1, metalness: 0, envMapIntensity: 1.2 });
  // the same, glowing warm at dusk (lit curtains / shoji)
  HM.paneLit = plain('paneLit', { color: 0xffffff, roughness: 0.1, metalness: 0, emissive: 0xffc88c, emissiveIntensity: 0 });
  registerNight(HM.paneLit, 0.75);
  // white-painted concrete of the co-op (texture spans 8 m: v = height, streaks hang
  // from the parapet at ~7.7 m and the canopy at ~3.6 m, splash dirt at the foot)
  HM.coopWall = texturedMaterial('coopWall', { n: 1024, period: 8, normal: 1.0, fn: (u, v) => {
    const y = (1 - v) * 8;
    const n1 = tfbm(u, v, 5, 4, 101), n2 = tfbm(u, v, 48, 2, 102);
    const st = clamp01(tnoise(u, 0.37, 70, 103, 1) * 1.6 + tnoise(u, v, 30, 104, 3) * 0.5 - 0.15);
    const hang = (ys, L) => (y < ys ? Math.exp(-(ys - y) / L) : 0);
    const streak = st * (0.9 * hang(7.75, 2.6) + 0.8 * hang(3.62, 1.3));
    const splash = clamp01(1 - y / 0.7) * (0.6 + 0.4 * n2);
    const form = Math.abs(((y + 0.3) % 0.6) - 0.3) > 0.293 || Math.abs(((u * 8) % 1.8) - 0.9) > 0.894 ? 0.035 : 0;
    const k = 0.94 + n1 * 0.08 + n2 * 0.03 - streak * 0.32 - splash * 0.25 - form;
    return [0.83 * k, 0.82 * k * (1 - streak * 0.04), 0.77 * k * (1 - streak * 0.08), 0.5 + n2 * 0.1 - form, 0.9];
  } });
  // bamboo blind (簾): fine horizontal splints with dark gaps and a few vertical cords
  HM.sudare = texturedMaterial('sudare', { n: 256, period: 0.5, normal: 1.5, fn: (u, v) => {
    const ln = (v * 64) % 1, gap = ln > 0.78 ? 1 : 0;
    const cord = Math.abs(((u * 2) % 1) - 0.5) < 0.012 ? 1 : 0;
    const t = 0.9 + tnoise(u, v, 3, 111, 64) * 0.1 + tnoise(u, v, 40, 112, 2) * 0.05;
    const c = gap ? [0.1, 0.08, 0.06] : cord ? [0.3, 0.24, 0.16] : [0.62 * t, 0.5 * t, 0.32 * t];
    return [...c, gap ? 0.2 : 0.6 - ln * 0.2, 0.85];
  } });
  return HM;
}

// ---------------------------------------------------------------------------
// geometry kit: a Builder with a transform stack
class Kit {
  constructor() { this.B = new Builder(); this.T = new THREE.Matrix4(); this.st = []; }
  push(m) { this.st.push(this.T); this.T = this.T.clone().multiply(m); return this; }
  pop() { this.T = this.st.pop(); return this; }
  box(mat, o) { this.B.box(mat, { ...o, matrix: this.T }); return this; }
  cyl(mat, o) { this.B.cyl(mat, { ...o, matrix: this.T }); return this; }
  geo(mat, g, m = null, color = WHITE) { this.B.geo(mat, g, m ? this.T.clone().multiply(m) : this.T, color); return this; }
  // convex planar polygon (Vector3s, counter-clockwise seen from the front) with uvs
  poly(mat, pts, uvs, color = WHITE) {
    const P = [], U = [];
    for (let i = 1; i < pts.length - 1; i++) for (const j of [0, i, i + 1]) { P.push(pts[j].x, pts[j].y, pts[j].z); U.push(uvs[j][0], uvs[j][1]); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    g.applyMatrix4(this.T);
    g.computeVertexNormals();
    this.B.geo(mat, g, null, color);
    return this;
  }
  // box from p0 to p1 (long axis = local y, so textures run along it), w wide, h deep toward `up`
  beam(mat, p0, p1, w, h, color = WHITE, up = UP) {
    const d = p1.clone().sub(p0), len = d.length();
    d.divideScalar(len);
    const z = up.clone().addScaledVector(d, -up.dot(d));
    if (z.lengthSq() < 1e-8) z.set(1, 0, 0).addScaledVector(d, -d.x);
    z.normalize();
    const x = d.clone().cross(z);
    const m = new THREE.Matrix4().makeBasis(x, d, z).setPosition(p0.clone().add(p1).multiplyScalar(0.5));
    return this.geo(mat, boxGeometry(w, len, h), m, color);
  }
  rod(mat, p0, p1, r, seg = 6, color = WHITE, open = false) {
    const d = p1.clone().sub(p0), len = d.length();
    const q = new THREE.Quaternion().setFromUnitVectors(UP, d.clone().divideScalar(len));
    const m = new THREE.Matrix4().compose(p0.clone().add(p1).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    return this.geo(mat, worldUV(new THREE.CylinderGeometry(r, r, len, seg, 1, open)), m, color);
  }
  // horizontal member along local x (grain along its length)
  hbox(mat, { len, h, d, pos, color = WHITE }) { return this.box(mat, { w: h, h: len, d, pos, rot: [0, 0, Math.PI / 2], color }); }
  build(name) { return this.B.build({ name }); }
}

// half cylinder along y (length len, centred), the half toward +z (or -z)
function halfCyl(r, len, seg, upper = true, open = false) {
  return worldUV(new THREE.CylinderGeometry(r, r, len, seg, 1, open, upper ? -Math.PI / 2 : Math.PI / 2, Math.PI));
}
// reverse the winding and normals of a geometry (inside surfaces)
function flipped(g) {
  const x = g.index ? g.toNonIndexed() : g.clone();
  for (const k of ['position', 'normal', 'uv']) {
    const a = x.attributes[k];
    if (!a) continue;
    for (let i = 0; i < a.count; i += 3) for (let c = 0; c < a.itemSize; c++) {
      const t = a.array[(i + 1) * a.itemSize + c];
      a.array[(i + 1) * a.itemSize + c] = a.array[(i + 2) * a.itemSize + c];
      a.array[(i + 2) * a.itemSize + c] = t;
    }
  }
  const n = x.attributes.normal;
  if (n) for (let i = 0; i < n.array.length; i++) n.array[i] = -n.array[i];
  return x;
}
// horizontal extent of everything (eaves, porch, equipment): [x0, x1, z0, z1]
const ext = (b) => [b.min.x, b.max.x, b.min.z, b.max.z].map((x) => Math.round(x * 100) / 100);
const tris = (obj) => { let n = 0; obj.traverse((o) => { if (o.isMesh) n += o.geometry.attributes.position.count / 3; }); return n; };

// ---------------------------------------------------------------------------
// roof faces: origin O on the eave line, eu along the eave (rightwards seen from outside),
// es up the slope; polygons are given in (u, s) face coordinates.
function rface(O, eu, es) {
  eu = eu.clone().normalize(); es = es.clone().normalize();
  const n = eu.clone().cross(es).normalize();
  const M = new THREE.Matrix4().makeBasis(eu, es, n).setPosition(O);
  const hout = v3(-es.x, 0, -es.z).normalize();
  return { O, eu, es, n, M, hout, P: (u, s, k = 0) => O.clone().addScaledVector(eu, u).addScaledVector(es, s).addScaledVector(n, k) };
}

function clipBand(poly, lo, hi) {
  const cut = (pts, inside, t) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) {
        const f = (t - a[1]) / (b[1] - a[1]);
        if (f > 1e-6 && f < 1 - 1e-6) out.push([a[0] + (b[0] - a[0]) * f, t]);
      }
    }
    return out;
  };
  return cut(cut(poly, (p) => p[1] >= lo - 1e-9, lo), (p) => p[1] <= hi + 1e-9, hi);
}
function spanAt(Q, s) {
  let a = Infinity, b = -Infinity;
  for (const [u, t] of Q) if (Math.abs(t - s) < 1e-6) { a = Math.min(a, u); b = Math.max(b, u); }
  return [a, b];
}
// s-range of a convex polygon along the line u = const
function spanS(poly, u) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((a[0] - u) * (b[0] - u) > 0) continue;
    if (Math.abs(b[0] - a[0]) < 1e-9) { lo = Math.min(lo, a[1], b[1]); hi = Math.max(hi, a[1], b[1]); continue; }
    const s = a[1] + ((b[1] - a[1]) * (u - a[0])) / (b[0] - a[0]);
    lo = Math.min(lo, s); hi = Math.max(hi, s);
  }
  return hi > lo ? [lo, hi] : null;
}
// one J-tile roll: a flattened half cylinder along the slope with the texture's uvs
function rollGeo(u, s0, s1, r = 0.047) {
  const g = new THREE.CylinderGeometry(r, r, s1 - s0, 4, 1, false, -Math.PI / 2, Math.PI);
  const p = g.attributes.position, uv = g.attributes.uv, sc = (s0 + s1) / 2;
  for (let i = 0; i < p.count; i++) uv.setXY(i, u + p.getX(i), ROOF_V * (sc + p.getY(i)));
  return g;
}
function rowBounds(smax) {
  const r = [];
  for (let k = 0; ; k++) {
    const s = Math.floor(k / 5) * 1.2 + ROWS[k % 5];
    if (s > smax - 0.07) break;
    r.push(s);
  }
  r.push(smax);
  return r;
}

// Stepped tile rows over a face polygon (each row tilted up to a lip at its lower edge),
// the risers between rows, and the underside (roof boards) below.
function tiled(K, M, F, poly, S, under = true) {
  const smax = Math.max(...poly.map((q) => q[1]));
  const rows = rowBounds(smax);
  for (let k = 0; k < rows.length - 1; k++) {
    const sa = rows[k], sb = rows[k + 1];
    const Q = clipBand(poly, sa, sb);
    if (Q.length < 3) continue;
    const off = (s) => S.lip * (sb - s) / (sb - sa);
    K.poly(M.roofTile, Q.map(([u, s]) => F.P(u, s, off(s))), Q.map(([u, s]) => [u, ROOF_V * s]), S.tile);
    if (k > 0) {
      const [ua, ub] = spanAt(Q, sa);
      if (ub - ua > 0.02) {
        const v = ROOF_V * sa;
        K.poly(M.roofTile, [F.P(ua, sa, 0), F.P(ub, sa, 0), F.P(ub, sa, S.lip), F.P(ua, sa, S.lip)],
          [[ua, v + 0.02 * ROOF_V], [ub, v + 0.02 * ROOF_V], [ub, v], [ua, v]], mul(S.tile, 0.9));
      }
    }
  }
  // the rolls, one per 0.3 m column on top of the texture's rolls
  const umin = Math.min(...poly.map((q) => q[0])), umax = Math.max(...poly.map((q) => q[0]));
  for (let u = Math.ceil((umin + 0.12 - ROLL0) / 0.3) * 0.3 + ROLL0; u < umax - 0.12; u += 0.3) {
    const sp = spanS(poly, u);
    if (!sp) continue;
    let [s0, s1] = sp;
    s0 = s0 < 0.01 ? -0.035 : s0 + 0.03;
    s1 -= 0.04;
    if (s1 - s0 < 0.12) continue;
    K.geo(M.roofTile, rollGeo(u, s0, s1), F.M.clone().multiply(Builder.mat({ pos: [u, (s0 + s1) / 2, S.lip * 0.45], scale: [1, 1, 0.85] })), S.tile);
  }
  if (under) {
    const rev = poly.slice().reverse();
    K.poly(M.timber, rev.map(([u, s]) => F.P(u, s, -S.thick)), rev.map(([u, s]) => [u, s]), S.soffit);
  }
}

// Eave: tile ends (lip + round roll ends), rafters, fascia, gutter and downpipes.
// o: { sWall: slope distance eave -> wall line, raf: [u0, u1] rafter range, gutter,
//      pipes: [u...], wallDist: horizontal distance eave -> wall, pipeEnd: y where pipes end }
function eaveDetail(K, M, F, u0, u1, S, o = {}) {
  const len = u1 - u0, uc = (u0 + u1) / 2;
  K.push(F.M);
  K.box(M.paint, { w: len + 0.03, h: 0.035, d: S.lip + 0.09, pos: [uc, -0.0175, (S.lip + 0.02 - 0.07) / 2], color: S.cap });
  if (o.raf && S.rafters) {
    const [ra, rb] = o.raf, n = Math.max(1, Math.round((rb - ra) / 0.455));
    const sl = o.sWall + 0.06;
    for (let i = 0; i <= n; i++) K.box(M.timber, { w: 0.045, h: sl, d: 0.055, pos: [ra + ((rb - ra) * i) / n, 0.04 + sl / 2, -S.thick - 0.0275], color: S.rafter });
  }
  K.pop();
  const FM = new THREE.Matrix4().makeBasis(F.eu, UP, F.hout).setPosition(F.O);
  K.push(FM);
  K.hbox(M.timber, { len: len + 0.04, h: 0.19, d: 0.03, pos: [uc, -0.145, -0.045], color: S.fascia });
  if (o.gutter !== false) {
    const gl = len + 0.06, r = 0.055;
    const m = Builder.mat({ pos: [uc, -0.1, 0.035], rot: [0, 0, -Math.PI / 2] });
    K.geo(M.paint, new THREE.CylinderGeometry(r, r, gl, 7, 1, true, 0, Math.PI), m, S.gutter);
    K.geo(M.paint, flipped(new THREE.CylinderGeometry(r - 0.004, r - 0.004, gl, 7, 1, true, 0, Math.PI)), m, mul(S.gutter, 0.8));
  }
  K.pop();
  for (const u of o.pipes || []) downpipe(K, M, F, u, S, o.wallDist ?? 0.7, o.pipeEnd ?? -0.05);
}

function downpipe(K, M, F, u, S, wallDist, yEnd) {
  const g = F.P(u, 0).addScaledVector(UP, -0.13).addScaledVector(F.hout, 0.035);
  const p1 = g.clone().addScaledVector(UP, -0.12);
  const back = Math.max(0.04, wallDist + 0.035 - 0.075);
  const p2 = p1.clone().addScaledVector(F.hout, -back).addScaledVector(UP, -back);
  const p3 = v3(p2.x, yEnd, p2.z);
  K.rod(M.paint, g.clone().addScaledVector(UP, 0.04), p1, 0.03, 6, S.gutter);
  K.rod(M.paint, p1.clone().addScaledVector(F.hout, 0.012).addScaledVector(UP, 0.012), p2.clone().addScaledVector(F.hout, -0.012).addScaledVector(UP, -0.012), 0.03, 6, S.gutter);
  if (p2.y - yEnd > 0.1) K.rod(M.paint, p2.clone().addScaledVector(UP, 0.02), p3, 0.03, 6, S.gutter);
  // clamps holding it to the wall
  for (let y = p2.y - 0.5; y > yEnd + 0.3; y -= 1.6) {
    K.beam(M.paint, v3(p2.x, y, p2.z).addScaledVector(F.hout, -0.075), v3(p2.x, y, p2.z), 0.05, 0.02, mul(S.gutter, 0.8), F.eu);
  }
}

// Verge: bargeboard under the edge, the flange of the verge tiles and their roll.
function vergeDetail(K, M, F, u, s0, s1, side, S, board = 0.3) {
  const len = s1 - s0, sc = (s0 + s1) / 2;
  K.push(F.M);
  K.box(M.timber, { w: 0.035, h: len + 0.1, d: board, pos: [u + side * 0.004, sc - 0.03, S.lip + 0.03 - board / 2], color: S.fascia });
  K.box(M.paint, { w: 0.022, h: len + 0.03, d: 0.13, pos: [u + side * 0.02, sc - 0.01, S.lip + 0.045 - 0.065], color: S.cap });
  K.geo(M.paint, halfCyl(0.05, len, 5), Builder.mat({ pos: [u - side * 0.035, sc, S.lip + 0.008] }), S.cap);
  K.pop();
}

// Ridge along p0-p1 (on the roof base plane): white mortar, stacked 熨斗 tiles, 冠瓦 on top.
// Returns the height of the top above the line.
function ridgeLine(K, M, p0, p1, S, { layers = 3, w = 0.34, mortar = true, cap = 0.1 } = {}) {
  const d = p1.clone().sub(p0), len = d.length();
  d.divideScalar(len);
  const z = UP.clone().addScaledVector(d, -UP.dot(d)).normalize();
  const x = d.clone().cross(z);
  K.push(new THREE.Matrix4().makeBasis(x, d, z).setPosition(p0.clone().add(p1).multiplyScalar(0.5)));
  if (mortar) K.box(M.plaster, { w: w + 0.07, h: len, d: 0.16, pos: [0, 0, -0.04], color: S.mortar });
  let top = 0.03;
  for (let i = 0; i < layers; i++) {
    K.box(M.paint, { w: w - i * 0.018, h: len + 0.02, d: 0.044, pos: [0, 0, top + 0.022], color: mul(S.cap, i % 2 ? 0.92 : 1.04) });
    top += 0.046;
  }
  K.geo(M.paint, halfCyl(cap, len + 0.05, 7), Builder.mat({ pos: [0, 0, top - 0.02] }), S.cap);
  K.pop();
  return top + cap - 0.02;
}

// 鬼瓦: end block of a ridge; p = ridge end on the base line, dir = outward (horizontal-ish)
function oni(K, M, p, dir, S, s = 1) {
  const f = v3(dir.x, 0, dir.z).normalize();
  const x = UP.clone().cross(f);
  K.push(new THREE.Matrix4().makeBasis(x, UP, f).setPosition(p));
  K.box(M.paint, { w: 0.46 * s, h: 0.32 * s, d: 0.11, pos: [0, 0.16 * s - 0.06, -0.03], color: S.oni });
  K.cyl(M.paint, { r: 0.23 * s, h: 0.11, seg: 9, pos: [0, 0.26 * s - 0.06, -0.03], rot: [Math.PI / 2, 0, 0], color: S.oni });
  // the round tile end (鳥衾) sticking out above
  K.cyl(M.paint, { r: 0.05 * s, h: 0.22 * s, seg: 6, pos: [0, 0.5 * s - 0.06, 0.02], rot: [Math.PI / 2 - 0.35, 0, 0], color: S.cap });
  K.pop();
}

// ---------------------------------------------------------------------------
// A kawara roof in its canonical frame: ridge along x, front slope facing +z.
// P: { type: 'kiri'|'yose'|'irimoya', ax, bz (half extents of the walls), Hw (wall top),
//      pitch, eaveO, vergeO, hip (irimoya hip run fraction), pipes: {front, back, right, left},
//      pipeEnd: {front, back, right, left}, gable: {mat, color} (irimoya gables) }
function kawaraRoof(K, M, S, P) {
  const { ax, bz, Hw } = P, p = P.pitch;
  const c = 1 / Math.hypot(1, p), sn = p * c;
  const B = bz + P.eaveO;
  const yE = Hw + S.t0 - P.eaveO * p, yR = Hw + S.t0 + bz * p;
  const L = B / c, sWall = P.eaveO / c;
  const front = rface(v3(0, yE, B), v3(1, 0, 0), v3(0, sn, -c));
  const back = rface(v3(0, yE, -B), v3(-1, 0, 0), v3(0, sn, c));
  const pipes = P.pipes || {}, pend = P.pipeEnd || {};
  const eo = (key, raf) => ({ sWall, raf, pipes: pipes[key] || [], wallDist: P.eaveO, pipeEnd: pend[key] ?? -0.05 });
  let top = yR;
  if (P.type === 'kiri') {
    // verges: overhang at the left (-x) and right (+x) ends; `ends` switches their trim off
    // (a roof section that butts against a taller one)
    const vo = Array.isArray(P.vergeO) ? P.vergeO : [P.vergeO, P.vergeO];
    const ends = P.ends || [true, true];
    const A0 = ax + vo[0], A1 = ax + vo[1];
    for (const [F, key] of [[front, 'front'], [back, 'back']]) {
      // the back face runs the other way along x
      const [ua, ub] = key === 'front' ? [-A0, A1] : [-A1, A0];
      const [ea, eb] = key === 'front' ? ends : [ends[1], ends[0]];
      tiled(K, M, F, [[ua, 0], [ub, 0], [ub, L], [ua, L]], S);
      eaveDetail(K, M, F, ua, ub, S, eo(key, [ua + 0.12, ub - 0.12]));
      if (ea) vergeDetail(K, M, F, ua, 0, L, -1, S);
      if (eb) vergeDetail(K, M, F, ub, 0, L, 1, S);
    }
    top = yR + ridgeLine(K, M, v3(-A0 - (ends[0] ? 0.03 : 0), yR, 0), v3(A1 + (ends[1] ? 0.03 : 0), yR, 0), S, { layers: S.noshi });
    if (ends[1]) oni(K, M, v3(A1 + 0.03, yR, 0), v3(1, 0, 0), S, 1);
    if (ends[0]) oni(K, M, v3(-A0 - 0.03, yR, 0), v3(-1, 0, 0), S, 1);
    // purlin ends (棟木・母屋) under the verges
    const yU = (z) => Hw + S.t0 - S.thick / c + (bz - Math.abs(z)) * p;
    for (const sx of [-1, 1]) {
      if (!ends[sx < 0 ? 0 : 1] || vo[sx < 0 ? 0 : 1] < 0.2) continue;
      for (const z of [0, -bz * 0.5, bz * 0.5]) {
        const x0 = sx * (ax - 0.02), x1 = sx * ((sx < 0 ? A0 : A1) - 0.07);
        K.box(M.timber, { w: Math.abs(x1 - x0), h: 0.12, d: 0.1, pos: [(x0 + x1) / 2, yU(z) - 0.06 - (z ? 0.02 : 0.04), z], color: S.fascia });
      }
    }
    top = Math.max(top, yR + 0.55);
  } else if (P.type === 'yose') {
    const A = ax + P.eaveO;
    const a = Math.max(0.3, A - B);
    const poly = [[-A, 0], [A, 0], [a, L], [-a, L]];
    for (const [F, key] of [[front, 'front'], [back, 'back']]) {
      tiled(K, M, F, poly, S);
      eaveDetail(K, M, F, -A, A, S, eo(key, [-(ax - 0.2), ax - 0.2]));
    }
    const dx = A - a, dy = yR - yE, Le = Math.hypot(dx, dy);
    const ends = [
      [rface(v3(A, yE, 0), v3(0, 0, -1), v3(-dx, dy, 0)), 'right'],
      [rface(v3(-A, yE, 0), v3(0, 0, 1), v3(dx, dy, 0)), 'left'],
    ];
    for (const [F, key] of ends) {
      tiled(K, M, F, [[-B, 0], [B, 0], [0, Le]], S);
      eaveDetail(K, M, F, -B, B, S, { ...eo(key, [-(bz - 0.2), bz - 0.2]), sWall: P.eaveO * Le / dx });
    }
    top = yR + ridgeLine(K, M, v3(-a - 0.05, yR, 0), v3(a + 0.05, yR, 0), S, { layers: S.noshi });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const pc = v3(sx * (A + 0.04), yE - 0.01, sz * (B + 0.04));
      ridgeLine(K, M, pc, v3(sx * a, yR, 0), S, { layers: 2, w: 0.25, cap: 0.075 });
      oni(K, M, pc.clone().add(v3(-sx * 0.1, 0.07, -sz * 0.1)), v3(sx, 0, sz), S, 0.62);
    }
  } else {
    // irimoya: hipped skirt around a gable
    const A = ax + P.eaveO;
    const r = clamp(B * (P.hip ?? 0.42), 0.8, A - 1.2);
    const g = 0.15;
    const Lr = r / c;
    const poly = [[-A, 0], [A, 0], [A - r, Lr], [A - r, L], [-(A - r), L], [-(A - r), Lr]];
    for (const [F, key] of [[front, 'front'], [back, 'back']]) {
      tiled(K, M, F, poly, S);
      eaveDetail(K, M, F, -A, A, S, eo(key, [-(ax - 0.2), ax - 0.2]));
      vergeDetail(K, M, F, A - r, Lr, L, 1, S, 0.34);
      vergeDetail(K, M, F, -(A - r), Lr, L, -1, S, 0.34);
    }
    const sk = (r + g) / c;
    const skirt = [[-B, 0], [B, 0], [B - r - g, sk], [-(B - r - g), sk]];
    const ends = [
      [rface(v3(A, yE, 0), v3(0, 0, -1), v3(-c, sn, 0)), 'right', 1],
      [rface(v3(-A, yE, 0), v3(0, 0, 1), v3(c, sn, 0)), 'left', -1],
    ];
    const tv = S.thick / c;
    for (const [F, key, sx] of ends) {
      tiled(K, M, F, skirt, S);
      eaveDetail(K, M, F, -B, B, S, eo(key, [-(bz - 0.2), bz - 0.2]));
      // the gable (妻) standing on the skirt
      const Xg = sx * (A - r - g), yb = yE + (r + g) * p;
      const Zb = B - r - g - tv / p, ya = yR - tv;
      const gm = P.gable || { mat: M.plaster, color: [0.92, 0.91, 0.88] };
      const pts = sx > 0 ? [v3(Xg, yb, Zb), v3(Xg, yb, -Zb), v3(Xg, ya, 0)] : [v3(Xg, yb, -Zb), v3(Xg, yb, Zb), v3(Xg, ya, 0)];
      K.poly(gm.mat, pts, pts.map((q) => [q.z * -sx, q.y]), gm.color);
      // timber frame of the gable and a small louvre
      K.box(M.timber, { w: 0.1, h: 0.12, d: 2 * Zb, pos: [Xg + sx * 0.02, yb + 0.06, 0], color: S.fascia });
      K.box(M.timber, { w: 0.06, h: 0.26, d: 0.36, pos: [Xg + sx * 0.02, yb + (ya - yb) * 0.45, 0], color: mul(S.fascia, 0.7) });
      K.push(new THREE.Matrix4().makeRotationY(sx * Math.PI / 2).setPosition(sx * (A - r) + sx * 0.02, 0, 0));
      gegyo(K, M, 0, yR + S.lip, 0.0, S, 1.1);
      K.pop();
      // flashing where the skirt meets the gable
      K.box(M.paint, { w: 0.14, h: 0.09, d: 2 * (B - r - g) + 0.1, pos: [Xg + sx * 0.07, yb + 0.02, 0], color: S.cap });
      for (const sz of [-1, 1]) {
        const pc = v3(sx * (A + 0.04), yE - 0.01, sz * (B + 0.04));
        ridgeLine(K, M, pc, v3(sx * (A - r), yE + r * p, sz * (B - r)), S, { layers: 2, w: 0.25, cap: 0.075 });
        oni(K, M, pc.clone().add(v3(-sx * 0.1, 0.07, -sz * 0.1)), v3(sx, 0, sz), S, 0.6);
      }
    }
    top = yR + ridgeLine(K, M, v3(-(A - r) - 0.03, yR, 0), v3(A - r + 0.03, yR, 0), S, { layers: S.noshi });
    oni(K, M, v3(A - r + 0.03, yR, 0), v3(1, 0, 0), S, 1);
    oni(K, M, v3(-(A - r) - 0.03, yR, 0), v3(-1, 0, 0), S, 1);
    top = Math.max(top, yR + 0.55);
  }
  return { yE, yR, top, c, L };
}

// A lean-to kawara roof against a wall (pent roof 庇 / 下屋, door canopy), in the wall's
// face frame (u along the wall, y up, k out of the wall).
function leanTo(K, M, S, { u0, u1, yTop, proj, pitch = 0.4, gutter = true, pipe = 0, pipeEnd = -0.05, verge = [true, true], raf = true, flashing = true, brackets = false }) {
  const c = 1 / Math.hypot(1, pitch), sn = pitch * c;
  const yE = yTop - proj * pitch, hw = (u1 - u0) / 2, L = proj / c;
  const F = rface(v3((u0 + u1) / 2, yE, proj), v3(1, 0, 0), v3(0, sn, -c));
  const S2 = { ...S, thick: 0.15 };
  tiled(K, M, F, [[-hw, 0], [hw, 0], [hw, L], [-hw, L]], S2);
  eaveDetail(K, M, F, -hw, hw, S2, { sWall: L, raf: raf ? [-hw + 0.1, hw - 0.1] : null, gutter, pipes: pipe ? [pipe * (hw - 0.3)] : [], wallDist: proj, pipeEnd });
  if (verge[0]) vergeDetail(K, M, F, -hw, 0, L, -1, S2, 0.24);
  if (verge[1]) vergeDetail(K, M, F, hw, 0, L, 1, S2, 0.24);
  if (flashing) K.hbox(M.paint, { len: u1 - u0, h: 0.1, d: 0.08, pos: [(u0 + u1) / 2, yTop + S.lip + 0.05, 0.04], color: S.cap });
  if (brackets) {
    for (const u of [u0 + 0.12, u1 - 0.12]) K.beam(M.timber, v3(u, yE - 0.62, 0.02), v3(u, yE - 0.12, proj - 0.12), 0.06, 0.07, S.wood, v3(0, 1, 1));
  }
  return { yE };
}

// ---------------------------------------------------------------------------
// walls

// The four wall faces of a w x d footprint: origin = left end seen from outside, ex along
// the wall (rightwards seen from outside), n outward.
function wallFaces(W, D) {
  const hw = W / 2, hd = D / 2;
  return [
    { id: 'front', o: v3(-hw, 0, hd), ex: v3(1, 0, 0), n: v3(0, 0, 1), len: W },
    { id: 'right', o: v3(hw, 0, hd), ex: v3(0, 0, -1), n: v3(1, 0, 0), len: D },
    { id: 'back', o: v3(hw, 0, -hd), ex: v3(-1, 0, 0), n: v3(0, 0, -1), len: W },
    { id: 'left', o: v3(-hw, 0, -hd), ex: v3(0, 0, 1), n: v3(-1, 0, 0), len: D },
  ].map((f) => ({ ...f, M: new THREE.Matrix4().makeBasis(f.ex, UP, f.n).setPosition(f.o) }));
}

// Rectangle [ua, ub] x [y0, y1] of a wall (inside K.push(face.M)) minus rectangular holes.
// dark: darken toward the ground. sheets: split into 0.9 x 1.82 m sheets with random uv
// offsets and tints (corrugated tin), so the texture does not visibly repeat.
function wallRect(K, mat, color, ua, ub, y0, y1, holes, dark = 0, sheets = null) {
  const hs = holes.map((h) => ({ u0: Math.max(h.u0, ua), u1: Math.min(h.u1, ub), v0: Math.max(h.v0, y0), v1: Math.min(h.v1, y1) }))
    .filter((h) => h.u1 > h.u0 + 1e-4 && h.v1 > h.v0 + 1e-4);
  const SW = 0.9, SHt = 1.82;
  const extraY = sheets ? Array.from({ length: Math.ceil((y1 - y0) / SHt) }, (_, i) => y0 + i * SHt).filter((y) => y > y0) : [];
  const ys = [...new Set([y0, y1, ...extraY, ...hs.flatMap((h) => [h.v0, h.v1])])].sort((a, b) => a - b);
  for (let i = 0; i < ys.length - 1; i++) {
    const va = ys[i], vb = ys[i + 1];
    if (vb - va < 1e-4) continue;
    const col = dark ? mul(color, 1 - dark * clamp01(1 - (va + vb) / 2 / 1.6)) : color;
    const row = hs.filter((h) => h.v0 <= va + 1e-6 && h.v1 >= vb - 1e-6).sort((a, b) => a.u0 - b.u0);
    let u = ua;
    const rect = (a, b) => {
      if (!sheets) { K.poly(mat, [v3(a, va, 0), v3(b, va, 0), v3(b, vb, 0), v3(a, vb, 0)], [[a, va], [b, va], [b, vb], [a, vb]], col); return; }
      const cuts = [a];
      for (let x = Math.floor(a / SW + 1) * SW; x < b - 1e-4; x += SW) cuts.push(x);
      cuts.push(b);
      for (let j = 0; j < cuts.length - 1; j++) {
        const p = cuts[j], q = cuts[j + 1], ix = Math.floor((p + q) / 2 / SW), iy = Math.floor(((va + vb) / 2 - y0) / SHt);
        const h1 = hashf(ix * 7.1 + iy * 13.3, sheets.seed), h2 = hashf(ix * 3.7 + iy * 5.9, sheets.seed + 1);
        const ou = h1 * 1.216 - p + ix * SW, ov = h2 * 1.216;
        let c = mul(col, 0.9 + 0.2 * hashf(ix + iy * 31, sheets.seed + 2));
        if (sheets.alt && hashf(ix * 11 + iy, sheets.seed + 3) < 0.12) c = sheets.alt;
        K.poly(mat, [v3(p, va, 0), v3(q, va, 0), v3(q, vb, 0), v3(p, vb, 0)], [[p + ou, va + ov], [q + ou, va + ov], [q + ou, vb + ov], [p + ou, vb + ov]], c);
      }
    };
    for (const h of row) { if (h.u0 > u + 1e-4) rect(u, h.u0); u = Math.max(u, h.u1); }
    if (ub > u + 1e-4) rect(u, ub);
  }
}

// ---------------------------------------------------------------------------
// openings (all in the wall's face frame: u along, y up, k out)

// pane split into curtain / clear parts: g = { base: [mat, tint], cur: [mat, tint], cover: [l, r] }
// with cover in window fractions, win = [x0, x1] the window's inner span
function pane(K, a, b, c, d, k, g, win) {
  const parts = [];
  if (g.cur && win) {
    const W = win[1] - win[0], xl = win[0] + g.cover[0] * W, xr = win[1] - g.cover[1] * W;
    const cuts = [a, clamp(xl, a, b), clamp(xr, a, b), b];
    const kinds = [g.cur, g.base, g.cur];
    for (let i = 0; i < 3; i++) if (cuts[i + 1] - cuts[i] > 0.005) parts.push([cuts[i], cuts[i + 1], kinds[i]]);
  } else parts.push([a, b, g.base]);
  for (const [p, q, [mat, col]] of parts) K.poly(mat, [v3(p, c, k), v3(q, c, k), v3(q, d, k), v3(p, d, k)], [[p, c], [q, c], [q, d], [p, d]], col);
}

function sashFrame(K, M, a, b, c, d, k, g, win, S, sw = 0.03) {
  const al = S.alu, dd = 0.022;
  K.box(M.metal, { w: b - a, h: sw, d: dd, pos: [(a + b) / 2, d - sw / 2, k], color: al });
  K.box(M.metal, { w: b - a, h: sw + 0.01, d: dd, pos: [(a + b) / 2, c + (sw + 0.01) / 2, k], color: al });
  K.box(M.metal, { w: sw, h: d - c, d: dd, pos: [a + sw / 2, (c + d) / 2, k], color: al });
  K.box(M.metal, { w: sw, h: d - c, d: dd, pos: [b - sw / 2, (c + d) / 2, k], color: al });
  pane(K, a + sw, b - sw, c + sw + 0.01, d - sw, k - 0.004, g, win);
}

// aluminium sliding window (引き違い窓): outer frame, two sashes, glass
function sashWindow(K, M, o, S) {
  const { u0, u1, v0, v1 } = o, fw = 0.04, fk0 = 0.018, fk1 = -0.075;
  const fd = fk0 - fk1, fkc = (fk0 + fk1) / 2, W = u1 - u0, uc = (u0 + u1) / 2, al = S.alu;
  K.box(M.metal, { w: W, h: fw, d: fd, pos: [uc, v1 - fw / 2, fkc], color: al });
  K.box(M.metal, { w: W, h: fw, d: fd, pos: [uc, v0 + fw / 2, fkc], color: al });
  K.box(M.metal, { w: fw, h: v1 - v0 - 2 * fw, d: fd, pos: [u0 + fw / 2, (v0 + v1) / 2, fkc], color: al });
  K.box(M.metal, { w: fw, h: v1 - v0 - 2 * fw, d: fd, pos: [u1 - fw / 2, (v0 + v1) / 2, fkc], color: al });
  K.box(M.metal, { w: W + 0.05, h: 0.014, d: 0.05, pos: [uc, v0 - 0.004, 0.03], color: al });
  const a = u0 + fw, b = u1 - fw, c = v0 + fw, d = v1 - fw, m = (a + b) / 2, ov = 0.018;
  const win = [a, b];
  if (o.open) {
    // one sash slid behind the other: the open half shows the insect screen (網戸)
    const L = o.open < 0;
    sashFrame(K, M, L ? m - ov : a, L ? b : m + ov, c, d, -0.026, o.glass, win, S);
    sashFrame(K, M, L ? m - ov : a, L ? b : m + ov, c, d, -0.05, o.glass, win, S);
    const sa = L ? a : m - ov, sb = L ? m + ov : b;
    const sc = { base: [M.matte, o.glass.cur ? [0.2, 0.2, 0.19] : [0.07, 0.075, 0.075]] };
    sashFrame(K, M, sa, sb, c, d, -0.004, sc, null, S, 0.02);
  } else {
    sashFrame(K, M, a, m + ov, c, d, -0.026, o.glass, win, S);
    sashFrame(K, M, m - ov, b, c, d, -0.05, o.glass, win, S);
  }
}

// small window with an aluminium grille (面格子) in front
function smallWindow(K, M, o, S) {
  sashWindow(K, M, o, S);
  if (!o.grille) return;
  const { u0, u1, v0, v1 } = o, al = S.alu, k = 0.07;
  K.box(M.metal, { w: u1 - u0 + 0.06, h: 0.025, d: 0.03, pos: [(u0 + u1) / 2, v1 + 0.02, k], color: al });
  K.box(M.metal, { w: u1 - u0 + 0.06, h: 0.025, d: 0.03, pos: [(u0 + u1) / 2, v0 - 0.02, k], color: al });
  for (const s of [-1, 1]) K.box(M.metal, { w: 0.02, h: 0.03, d: k + 0.02, pos: [(u0 + u1) / 2 + s * ((u1 - u0) / 2 + 0.02), v1 + 0.02, k / 2], color: al });
  const n = Math.max(3, Math.round((u1 - u0) / 0.11));
  for (let i = 0; i < n; i++) K.box(M.metal, { w: 0.018, h: v1 - v0 + 0.04, d: 0.018, pos: [u0 + ((i + 0.5) * (u1 - u0)) / n, (v0 + v1) / 2, k], color: al });
}

// wooden lattice (出格子) in front of a ground floor window
function lattice(K, M, o, S) {
  const u0 = o.u0 - 0.06, u1 = o.u1 + 0.06, W = u1 - u0, uc = (u0 + u1) / 2, dk = 0.17;
  const vb = o.v0 - 0.14, vt = o.v1 + 0.07, col = S.lattice;
  K.hbox(M.timber, { len: W + 0.04, h: 0.05, d: dk + 0.04, pos: [uc, vb + 0.025, (dk + 0.04) / 2], color: col });
  K.hbox(M.timber, { len: W, h: 0.06, d: dk, pos: [uc, vt - 0.03, dk / 2], color: col });
  for (const s of [-1, 1]) K.box(M.timber, { w: 0.045, h: vt - vb, d: dk, pos: [uc + s * (W / 2 - 0.0225), (vb + vt) / 2, dk / 2], color: col });
  const inner = W - 0.09, n = Math.round(inner / 0.068), h = vt - vb - 0.11;
  for (let i = 0; i < n; i++) K.box(M.timber, { w: 0.027, h, d: 0.04, pos: [uc - inner / 2 + ((i + 0.5) * inner) / n, vb + 0.05 + h / 2, dk - 0.035], color: col });
  // mid rail
  K.hbox(M.timber, { len: inner, h: 0.035, d: 0.03, pos: [uc, vb + 0.05 + h * 0.35, dk - 0.07], color: col });
}

// 戸袋: box for the storm shutters beside a window
function tobukuro(K, M, o, S, side, bw) {
  const w = bw - 0.1, u = side < 0 ? o.u0 - 0.03 - w / 2 : o.u1 + 0.03 + w / 2;
  const h = o.v1 - o.v0 + 0.1, y = (o.v0 + o.v1) / 2;
  if (S.tobukuro.mat === 'wood') {
    K.box(M.woodV, { w, h, d: 0.12, pos: [u, y, 0.06], color: S.tobukuro.color });
    K.hbox(M.timber, { len: w + 0.04, h: 0.05, d: 0.15, pos: [u, y + h / 2 + 0.025, 0.075], color: S.wood });
  } else {
    const tc = S.tobukuro.color;
    K.box(M.paint, { w, h, d: 0.12, pos: [u, y, 0.06], color: tc });
    K.box(M.paint, { w: w + 0.03, h: 0.03, d: 0.15, pos: [u, y + h / 2 + 0.015, 0.075], color: mul(tc, 0.85) });
    for (let i = 1; i < 4; i++) K.box(M.paint, { w: 0.012, h: h - 0.06, d: 0.01, pos: [u - w / 2 + (w * i) / 4, y, 0.123], color: mul(tc, 0.8) });
  }
}

// bamboo blind (簾) hanging in front of a window, rolled part of the way down
function sudare(K, M, o, R, hooded) {
  const w = o.u1 - o.u0 + 0.12, uc = (o.u0 + o.u1) / 2, top = o.v1 + (hooded ? 0.05 : 0.14);
  const h = (o.v1 - o.v0) * R.range(0.55, 1.0) + 0.1, k = hooded ? 0.13 : 0.1;
  const tint = mul([1, 0.97, 0.92], R.range(0.8, 1.1));
  K.box(M.sudare, { w, h, d: 0.008, pos: [uc, top - h / 2, k], color: tint });
  K.hbox(M.timber, { len: w + 0.04, h: 0.025, d: 0.02, pos: [uc, top, k], color: tint });
  K.cyl(M.sudare, { r: 0.022, h: w, seg: 6, pos: [uc, top - h, k + 0.012], rot: [0, 0, Math.PI / 2], color: mul(tint, 0.9) });
  for (const s of [-1, 1]) K.box(M.metal, { w: 0.01, h: 0.04, d: k, pos: [uc + s * (w / 2 - 0.08), top + 0.02, k / 2], color: [0.6, 0.6, 0.6] });
}

function mailbox(K, M, u, y, R) {
  const c = R.pick([[0.25, 0.38, 0.3], [0.7, 0.7, 0.68], [0.55, 0.2, 0.15], [0.85, 0.83, 0.78], [0.3, 0.3, 0.32]]);
  K.box(M.paint, { w: 0.3, h: 0.34, d: 0.12, pos: [u, y, 0.06], color: c });
  K.box(M.paint, { w: 0.32, h: 0.03, d: 0.15, pos: [u, y + 0.18, 0.075], color: mul(c, 0.8) });
  K.box(M.paint, { w: 0.2, h: 0.015, d: 0.01, pos: [u, y + 0.08, 0.125], color: [0.1, 0.1, 0.1] });
}

// a laundry stand in the yard: two T-posts and a pole, a towel or two (face frame)
function laundryStand(K, M, u, k, R) {
  const col = [0.72, 0.73, 0.74], sp = R.range(2.0, 2.6), h = R.range(1.75, 1.95);
  for (const s of [-1, 1]) {
    K.rod(M.metal, v3(u + (s * sp) / 2, -0.2, k), v3(u + (s * sp) / 2, h, k), 0.022, 6, col);
    K.rod(M.metal, v3(u + (s * sp) / 2, h, k - 0.3), v3(u + (s * sp) / 2, h, k + 0.3), 0.016, 5, col);
    K.box(M.concrete, { w: 0.25, h: 0.12, d: 0.25, pos: [u + (s * sp) / 2, -0.02, k], color: [0.8, 0.8, 0.78] });
  }
  const pk = k + (R.chance(0.5) ? 0.25 : -0.25);
  K.rod(M.metal, v3(u - sp / 2 - 0.2, h + 0.015, pk), v3(u + sp / 2 + 0.2, h + 0.015, pk), 0.016, 6, R.chance(0.5) ? [0.3, 0.55, 0.85] : [0.8, 0.8, 0.8]);
  const cloth = [[0.78, 0.78, 0.75], [0.5, 0.62, 0.78], [0.8, 0.58, 0.58], [0.8, 0.72, 0.45], [0.58, 0.7, 0.58]];
  let x = u - sp / 2 + R.range(0.2, 0.5);
  for (let i = 0, n = R.int(1, 4); i < n && x < u + sp / 2 - 0.4; i++) {
    const w = R.range(0.3, 0.5), hh = R.range(0.4, 0.8);
    K.box(M.matte, { w, h: hh, d: 0.012, pos: [x + w / 2, h - hh / 2, pk], color: R.pick(cloth) });
    x += w + R.range(0.1, 0.4);
  }
}

// low railing (手すり) in front of an upper window
function windowRail(K, M, o, S) {
  const k = 0.16, y0 = o.v0 - 0.08, y1 = o.v0 + 0.42, uc = (o.u0 + o.u1) / 2;
  K.hbox(M.timber, { len: o.u1 - o.u0 + 0.2, h: 0.05, d: 0.06, pos: [uc, y1, k], color: S.lattice });
  K.hbox(M.timber, { len: o.u1 - o.u0 + 0.2, h: 0.04, d: 0.05, pos: [uc, y0 + 0.02, k], color: S.lattice });
  const nb = Math.round((o.u1 - o.u0) / 0.1);
  for (let i = 0; i <= nb; i++) K.box(M.timber, { w: 0.022, h: y1 - y0, d: 0.022, pos: [o.u0 - 0.08 + ((o.u1 - o.u0 + 0.16) * i) / nb, (y0 + y1) / 2, k], color: S.lattice });
  for (const u of [o.u0 - 0.09, o.u1 + 0.09]) K.box(M.timber, { w: 0.04, h: 0.04, d: k, pos: [u, y1, k / 2], color: S.lattice });
}

// 懸魚: the pendant board under the apex of a gable (face frame of the gable, apex at u, y)
function gegyo(K, M, u, y, k, S, s = 1) {
  K.box(M.timber, { w: 0.34 * s, h: 0.26 * s, d: 0.04, pos: [u, y - 0.13 * s, k], color: S.fascia });
  K.box(M.timber, { w: 0.2 * s, h: 0.12 * s, d: 0.05, pos: [u, y - 0.3 * s, k], color: mul(S.fascia, 0.9) });
  K.cyl(M.metal, { r: 0.035 * s, h: 0.02, seg: 6, pos: [u, y - 0.13 * s, k + 0.03], rot: [Math.PI / 2, 0, 0], color: [0.8, 0.7, 0.45] });
}

// solar water heater (太陽熱温水器) lying on a roof slope; F = roof face, (u, s) = its centre
function solarHeater(K, M, F, u, s, lip) {
  K.push(F.M);
  const w = 1.9, h = 1.1, base = lip + 0.12;
  K.box(M.paint, { w, h, d: 0.08, pos: [u, s, base], color: [0.2, 0.22, 0.26] });
  K.box(M.glass, { w: w - 0.1, h: h - 0.1, d: 0.01, pos: [u, s, base + 0.045], color: WHITE });
  K.cyl(M.paint, { r: 0.24, h: w + 0.1, seg: 10, pos: [u, s + h / 2 + 0.28, base + 0.2], rot: [0, 0, Math.PI / 2], color: [0.85, 0.85, 0.82] });
  for (const du of [-w / 2 + 0.15, w / 2 - 0.15]) for (const ds of [-h / 2 + 0.1, h / 2 + 0.28]) K.box(M.metal, { w: 0.04, h: 0.04, d: base, pos: [u + du, s + ds, base / 2], color: [0.7, 0.7, 0.7] });
  K.pop();
}

// small sheet-metal hood over a window (霧除け)
function hood(K, M, o, S) {
  const w = o.u1 - o.u0 + 0.3, uc = (o.u0 + o.u1) / 2, y = o.v1 + 0.1;
  K.box(M.paint, { w, h: 0.035, d: 0.42, pos: [uc, y, 0.19], rot: [0.28, 0, 0], color: S.hood });
  K.box(M.paint, { w, h: 0.06, d: 0.02, pos: [uc, y - 0.08, 0.39], color: mul(S.hood, 0.9) });
}

// entrance: sliding glass doors (引き戸) with a transom, frame and threshold
function entrance(K, M, o, S) {
  const { u0, u1, v0, v1 } = o, wood = S.doorWood, fm = wood ? M.timber : M.metal, fc = wood ? S.wood : S.alu;
  const W = u1 - u0, uc = (u0 + u1) / 2, fw = wood ? 0.075 : 0.05, tr = 0.36;
  const top = v1 + tr;
  K.box(fm, { w: W, h: fw, d: 0.12, pos: [uc, top - fw / 2, -0.02], color: fc });
  K.box(fm, { w: W, h: 0.05, d: 0.12, pos: [uc, v1 + 0.025, -0.02], color: fc });
  for (const s of [-1, 1]) K.box(fm, { w: fw, h: top - v0, d: 0.12, pos: [uc + s * (W / 2 - fw / 2), (v0 + top) / 2, -0.02], color: fc });
  K.box(M.concrete, { w: W + 0.1, h: 0.05, d: 0.16, pos: [uc, v0 - 0.02, -0.01], color: [0.8, 0.8, 0.78] });
  // transom
  pane(K, u0 + fw, u1 - fw, v1 + 0.05, top - fw, -0.04, { base: [M.pane, S.frosted] });
  for (let i = 1; i < 3; i++) K.box(fm, { w: 0.025, h: tr - 0.05 - fw, d: 0.03, pos: [u0 + fw + ((W - 2 * fw) * i) / 3, (v1 + 0.05 + top - fw) / 2, -0.03], color: fc });
  // two sliding panels
  const a = u0 + fw, b = u1 - fw, m = (a + b) / 2, ov = 0.03;
  doorPanel(K, M, a, m + ov, v0, v1, -0.03, S, fm, fc, o);
  doorPanel(K, M, m - ov, b, v0, v1, -0.07, S, fm, fc, o);
}
function doorPanel(K, M, a, b, c, d, k, S, fm, fc, o) {
  const st = S.doorWood ? 0.055 : 0.04, dd = 0.035;
  K.box(fm, { w: st, h: d - c, d: dd, pos: [a + st / 2, (c + d) / 2, k], color: fc });
  K.box(fm, { w: st, h: d - c, d: dd, pos: [b - st / 2, (c + d) / 2, k], color: fc });
  K.box(fm, { w: b - a - 2 * st, h: 0.05, d: dd, pos: [(a + b) / 2, d - 0.025, k], color: fc });
  const kick = S.doorWood ? 0.22 : 0.16;
  K.box(fm, { w: b - a - 2 * st, h: kick, d: dd, pos: [(a + b) / 2, c + kick / 2, k], color: fc });
  const g = o.lit ? { base: [M.paneLit, S.frosted] } : { base: [M.pane, S.frosted] };
  pane(K, a + st, b - st, c + kick, d - 0.05, k - 0.004, g);
  if (S.doorWood) {
    // 格子戸: dense vertical bars over frosted glass, and two cross rails
    const n = Math.round((b - a - 2 * st) / 0.05);
    for (let i = 1; i < n; i++) K.box(fm, { w: 0.014, h: d - c - kick - 0.05, d: 0.018, pos: [a + st + ((b - a - 2 * st) * i) / n, (c + kick + d - 0.05) / 2, k + 0.012], color: fc });
    for (const f of [0.3, 0.72]) K.box(fm, { w: b - a - 2 * st, h: 0.025, d: 0.02, pos: [(a + b) / 2, c + kick + (d - 0.05 - c - kick) * f, k + 0.014], color: fc });
  } else {
    for (const f of [0.25, 0.5, 0.75]) K.box(fm, { w: b - a - 2 * st, h: 0.022, d: 0.02, pos: [(a + b) / 2, c + kick + (d - 0.05 - c - kick) * f, k + 0.012], color: fc });
  }
}

// ---------------------------------------------------------------------------
// equipment (face frame)
function acUnit(K, M, u, y, S, duct = 2.2) {
  const iv = [0.86, 0.85, 0.79];
  K.box(M.paint, { w: 0.8, h: 0.56, d: 0.28, pos: [u, y + 0.28, 0.2], color: iv });
  K.cyl(M.paint, { r: 0.2, h: 0.012, seg: 12, pos: [u - 0.11, y + 0.29, 0.343], rot: [Math.PI / 2, 0, 0], color: [0.1, 0.1, 0.1] });
  K.cyl(M.paint, { r: 0.05, h: 0.016, seg: 8, pos: [u - 0.11, y + 0.29, 0.346], rot: [Math.PI / 2, 0, 0], color: mul(iv, 0.8) });
  for (const dy of [-0.1, 0, 0.1]) K.box(M.paint, { w: 0.44, h: 0.012, d: 0.012, pos: [u - 0.11, y + 0.29 + dy, 0.35], color: mul(iv, 0.9) });
  K.box(M.paint, { w: 0.2, h: 0.2, d: 0.02, pos: [u + 0.25, y + 0.38, 0.345], color: mul(iv, 0.93) });
  // feet on concrete blocks
  for (const s of [-1, 1]) K.box(M.concrete, { w: 0.12, h: 0.12 + 0.3, d: 0.36, pos: [u + s * 0.3, y - 0.15 + 0.06 - 0.06, 0.2], color: [0.9, 0.9, 0.88] });
  // pipe cover up the wall
  if (duct > y + 0.8) {
    K.box(M.paint, { w: 0.1, h: 0.08, d: 0.14, pos: [u + 0.45, y + 0.45, 0.13], color: iv });
    K.box(M.paint, { w: 0.1, h: duct - y - 0.45, d: 0.07, pos: [u + 0.45, (duct + y + 0.45) / 2, 0.035], color: iv });
  }
}

function propane(K, M, u, S) {
  const grey = [0.5, 0.51, 0.5];
  K.box(M.concrete, { w: 1.0, h: 0.4, d: 0.52, pos: [u, -0.16, 0.3], color: [0.85, 0.85, 0.82] });
  for (const du of [-0.23, 0.23]) {
    const x = u + du;
    K.cyl(M.paint, { r: 0.18, h: 1.02, seg: 10, pos: [x, 0.04 + 0.51, 0.3], color: grey });
    K.cyl(M.paint, { r2: 0.07, r: 0.18, h: 0.12, seg: 10, pos: [x, 1.12, 0.3], color: grey });
    K.cyl(M.paint, { r: 0.1, h: 0.14, seg: 8, pos: [x, 1.23, 0.3], color: mul(grey, 0.9), open: true });
    K.cyl(M.paint, { r: 0.03, h: 0.08, seg: 5, pos: [x, 1.2, 0.3], color: [0.55, 0.45, 0.2] });
  }
  // regulator and pipe into the wall; the chain
  K.box(M.paint, { w: 0.14, h: 0.12, d: 0.08, pos: [u, 1.35, 0.06], color: [0.7, 0.7, 0.68] });
  K.rod(M.metal, v3(u - 0.23, 1.24, 0.3), v3(u - 0.05, 1.33, 0.08), 0.008, 4, [0.8, 0.55, 0.35]);
  K.rod(M.metal, v3(u + 0.23, 1.24, 0.3), v3(u + 0.05, 1.33, 0.08), 0.008, 4, [0.8, 0.55, 0.35]);
  K.box(M.paint, { w: 0.9, h: 0.012, d: 0.012, pos: [u, 0.85, 0.49], color: [0.15, 0.15, 0.15] });
}

function meter(K, M, u, y) {
  K.box(M.paint, { w: 0.24, h: 0.34, d: 0.12, pos: [u, y, 0.06], color: [0.72, 0.73, 0.72] });
  K.poly(M.glass, [v3(u - 0.08, y - 0.02, 0.121), v3(u + 0.08, y - 0.02, 0.121), v3(u + 0.08, y + 0.12, 0.121), v3(u - 0.08, y + 0.12, 0.121)], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  K.box(M.paint, { w: 0.05, h: 1.2, d: 0.05, pos: [u, y + 0.77, 0.03], color: [0.6, 0.6, 0.6] });
}

function lamp(K, M, u, y) {
  K.box(M.paint, { w: 0.1, h: 0.14, d: 0.04, pos: [u, y, 0.02], color: [0.15, 0.15, 0.15] });
  K.box(M.lamp, { w: 0.13, h: 0.17, d: 0.1, pos: [u, y - 0.02, 0.09], color: [0.95, 0.93, 0.86] });
  K.box(M.paint, { w: 0.15, h: 0.03, d: 0.12, pos: [u, y + 0.08, 0.09], color: [0.15, 0.15, 0.15] });
}

// Yagi TV antenna on a mast (in world frame; base point p)
function antenna(K, M, p, R) {
  const h = R.range(1.6, 2.4), col = [0.75, 0.76, 0.78];
  const top = p.clone().add(v3(0, h, 0));
  K.rod(M.metal, p, top, 0.02, 6, col);
  const yaw = R.range(0, Math.PI * 2), dir = v3(Math.cos(yaw), 0, Math.sin(yaw)), side = v3(-dir.z, 0, dir.x);
  for (const [hh, len, n] of [[h - 0.05, 1.3, 7], [h - 0.55, 0.9, 5]]) {
    const c = p.clone().add(v3(0, hh, 0));
    K.rod(M.metal, c.clone().addScaledVector(dir, -len * 0.3), c.clone().addScaledVector(dir, len * 0.7), 0.012, 4, col);
    for (let i = 0; i < n; i++) {
      const e = c.clone().addScaledVector(dir, -len * 0.25 + (i * len * 0.9) / n), w = 0.34 - i * 0.02;
      K.rod(M.metal, e.clone().addScaledVector(side, -w), e.clone().addScaledVector(side, w), 0.005, 3, col);
    }
  }
}

// balcony with railing, laundry pole, towels and maybe a futon (face frame)
function balcony(K, M, S, R, { u0, u1, y, depth }) {
  const uc = (u0 + u1) / 2, W = u1 - u0, al = S.alu, rh = 0.95;
  K.box(M.timber, { w: W, h: 0.1, d: depth, pos: [uc, y - 0.05, depth / 2], color: S.wood });
  K.hbox(M.timber, { len: W, h: 0.12, d: 0.04, pos: [uc, y - 0.07, depth - 0.02], color: mul(S.wood, 0.9) });
  for (const u of [u0 + 0.08, u1 - 0.08]) K.beam(M.timber, v3(u, y - 0.5, 0.02), v3(u, y - 0.1, depth - 0.15), 0.06, 0.08, S.wood, v3(0, 1, -1));
  // railing: posts, top and bottom rails, balusters
  const posts = [[u0 + 0.03, depth - 0.03], [u1 - 0.03, depth - 0.03], [u0 + 0.03, 0.03], [u1 - 0.03, 0.03]];
  for (const [u, k] of posts) K.box(M.metal, { w: 0.04, h: rh, d: 0.04, pos: [u, y + rh / 2, k], color: al });
  K.box(M.metal, { w: W, h: 0.04, d: 0.05, pos: [uc, y + rh, depth - 0.03], color: al });
  K.box(M.metal, { w: W, h: 0.03, d: 0.03, pos: [uc, y + 0.1, depth - 0.03], color: al });
  for (const u of [u0 + 0.03, u1 - 0.03]) {
    K.box(M.metal, { w: 0.05, h: 0.04, d: depth, pos: [u, y + rh, depth / 2], color: al });
    K.box(M.metal, { w: 0.03, h: 0.03, d: depth, pos: [u, y + 0.1, depth / 2], color: al });
  }
  const n = Math.round((W - 0.1) / 0.11);
  for (let i = 1; i < n; i++) K.box(M.metal, { w: 0.018, h: rh - 0.12, d: 0.018, pos: [u0 + 0.05 + ((W - 0.1) * i) / n, y + 0.1 + (rh - 0.12) / 2, depth - 0.03], color: al });
  // laundry pole on two stands
  const ph = y + 1.75;
  for (const u of [u0 + 0.06, u1 - 0.06]) {
    K.rod(M.metal, v3(u, y + rh, depth - 0.03), v3(u, ph, depth - 0.03), 0.015, 5, al);
    K.rod(M.metal, v3(u, ph, depth - 0.25), v3(u, ph, depth + 0.1), 0.013, 5, al);
  }
  const pk = depth - 0.12 + R.range(-0.08, 0.1);
  K.rod(M.metal, v3(u0 - 0.15, ph + 0.012, pk), v3(u1 + 0.15, ph + 0.012, pk), 0.016, 6, R.chance(0.5) ? [0.3, 0.55, 0.85] : [0.85, 0.85, 0.85]);
  const cloth = [[0.78, 0.78, 0.75], [0.5, 0.62, 0.78], [0.8, 0.58, 0.58], [0.8, 0.72, 0.45], [0.58, 0.7, 0.58], [0.35, 0.4, 0.55]];
  let u = u0 + R.range(0.2, 0.5);
  const nt = R.int(0, 4);
  for (let i = 0; i < nt && u < u1 - 0.4; i++) {
    const w = R.range(0.3, 0.45), h = R.range(0.45, 0.75);
    K.box(M.matte, { w, h, d: 0.012, pos: [u + w / 2, ph - h / 2, pk], color: R.pick(cloth) });
    u += w + R.range(0.08, 0.35);
  }
  if (R.chance(0.35)) {
    const fw = Math.min(W - 0.3, R.range(1.0, 1.3)), fu = uc + R.range(-0.2, 0.2), fc = R.pick([[0.78, 0.6, 0.6], [0.58, 0.66, 0.78], [0.78, 0.74, 0.62], [0.7, 0.5, 0.42]]);
    K.box(M.matte, { w: fw, h: 0.7, d: 0.06, pos: [fu, y + rh - 0.32, depth + 0.02], color: fc });
    K.box(M.matte, { w: fw, h: 0.55, d: 0.06, pos: [fu, y + rh - 0.25, depth - 0.1], color: mul(fc, 0.9) });
    K.box(M.matte, { w: fw, h: 0.06, d: 0.18, pos: [fu, y + rh + 0.04, depth - 0.04], color: fc });
  }
}

// ---------------------------------------------------------------------------
// shared styling

const PLASTER = [[0.97, 0.95, 0.9], [0.92, 0.92, 0.9], [0.95, 0.9, 0.8], [0.88, 0.88, 0.86], [0.93, 0.9, 0.85], [0.9, 0.86, 0.78]];
const TIN = [[0.78, 0.48, 0.4], [0.5, 0.62, 0.75], [0.55, 0.66, 0.58], [0.92, 0.88, 0.76], [0.78, 0.78, 0.78], [0.62, 0.5, 0.42], [0.45, 0.52, 0.62]];
const CURTAIN = [[0.82, 0.8, 0.74], [0.78, 0.76, 0.7], [0.7, 0.76, 0.7], [0.66, 0.72, 0.8], [0.82, 0.68, 0.52], [0.8, 0.8, 0.8], [0.82, 0.72, 0.72]];

function roofStyle(R) {
  const kind = R.pick(['gin', 'gin', 'gin', 'dark', 'blue', 'blue', 'brown']);
  const k = R.range(0.9, 1.12);
  const tile = { gin: [1.03, 1.03, 1.04], dark: [0.76, 0.76, 0.78], blue: [0.84, 0.95, 1.16], brown: [1.45, 1.02, 0.74] }[kind].map((x) => x * k);
  const cap = [0.24, 0.25, 0.27].map((x, i) => x * tile[i]);
  return { kind, tile, cap, oni: mul(cap, 1.08), mortar: [0.9, 0.9, 0.88], lip: 0.03, thick: 0.2, t0: 0.3, noshi: R.int(2, 4), rafters: true };
}

function houseStyle(R) {
  const S = roofStyle(R);
  S.wood = mul([0.5, 0.44, 0.38], R.range(0.75, 1.15));
  S.lattice = mul(S.wood, R.range(0.8, 1.1));
  S.fascia = R.chance(0.12) ? [1.3, 1.26, 1.16] : mul(S.wood, R.range(0.8, 1.05));
  S.soffit = R.chance(0.3) ? [1.5, 1.47, 1.4] : mul([0.85, 0.74, 0.6], R.range(0.8, 1.1));
  S.rafter = R.chance(0.5) ? S.soffit : S.wood;
  S.alu = R.chance(0.45) ? [0.46, 0.38, 0.3] : [1, 1, 1];
  S.gutter = R.pick([[0.78, 0.72, 0.6], [0.36, 0.3, 0.26], [0.62, 0.63, 0.62], [0.22, 0.23, 0.24], [0.85, 0.84, 0.8]]);
  S.hood = R.pick([[0.5, 0.5, 0.5], [0.35, 0.3, 0.28], [0.7, 0.68, 0.62]]);
  S.frosted = mul([0.62, 0.66, 0.68], R.range(0.9, 1.05));
  S.doorWood = R.chance(0.45);
  S.tobukuro = R.chance(0.5) ? { mat: 'wood', color: mul([1, 0.95, 0.9], R.range(0.9, 1.4)) } : { mat: 'metal', color: R.pick([[0.8, 0.78, 0.72], [0.6, 0.62, 0.6], [0.45, 0.38, 0.32]]) };
  return S;
}

// window glass: clear / curtains / shoji / frosted, a fraction lit at dusk
function glassFor(R, M, S, kind, lit) {
  const isLit = R() < lit, r = R(), cur = R.pick(CURTAIN);
  if (kind === 'small') return { base: [isLit ? M.paneLit : M.pane, S.frosted] };
  const clear = [isLit ? M.windowLit : M.glass, WHITE];
  const soft = (tint) => [isLit ? M.paneLit : M.pane, tint];
  if (r < 0.3) return { base: clear };
  if (r < 0.7) {
    const l = R.chance(0.7) ? R.range(0.12, 0.4) : 0, rr = R.chance(0.7) ? R.range(0.12, 0.4) : 0;
    return { base: clear, cur: soft(cur), cover: [l, l + rr < 0.05 ? 0.3 : rr] };
  }
  if (r < 0.85) return { base: soft([0.86, 0.84, 0.76]) }; // shoji
  return { base: soft(S.frosted) };
}

// ---------------------------------------------------------------------------
// the village house

function bays(len) { const n = Math.max(3, Math.round(len / 0.91)); return { n, bw: len / n }; }
function freeRun(used, i, nb, gap) {
  for (let j = i - gap; j < i + nb + gap; j++) if (j >= 0 && j < used.length && used[j]) return false;
  return i >= 0 && i + nb <= used.length;
}
function take(used, i, nb) { for (let j = i; j < i + nb; j++) used[j] = true; }
function findRun(R, used, nb, margin = 1, gap = 1, tries = 14) {
  const n = used.length;
  for (let t = 0; t < tries; t++) {
    const lo = Math.min(margin, Math.max(0, n - nb)), hi = Math.max(lo, n - margin - nb);
    const i = R.int(lo, hi);
    if (freeRun(used, i, nb, gap)) return i;
  }
  return -1;
}

function house(opts = {}) {
  const M = mats();
  const seed = Math.floor(num(opts.seed, 1));
  const R = rng(seed * 7717 + 3);
  // parameters (random values are always drawn so a seed keeps its look when some are given)
  const W = clamp(num(opts.w, R.range(5.4, 9.4)), 3.6, 14);
  const D = clamp(num(opts.d, R.range(5.2, 8.4)), 3.6, 12);
  const stories = num(opts.stories, R.chance(0.55) ? 2 : 1) >= 2 ? 2 : 1;
  const roof = str(opts.roof, R.pick(['kiri', 'kiri', 'kiri', 'yose', 'yose', 'irimoya', 'irimoya']));
  const wall = str(opts.wall, R.pick(['yakisugi', 'yakisugi', 'lap', 'plaster', 'mixed', 'mixed', 'tin']));
  const lit = clamp(num(opts.lit, 0.35), 0, 1);
  const front = str(opts.front, 'street');
  const rr = R();
  const ridge = str(opts.ridge, roof === 'kiri' ? ((D > W + 0.6 ? rr < 0.7 : rr < 0.15) ? 'z' : 'x') : (W >= D ? 'x' : 'z'));
  const S = houseStyle(R);

  // heights
  const FT = R.range(0.34, 0.42), SH = R.range(2.62, 2.8);
  const FL = [FT + 0.12, FT + SH + 0.12];
  const Hw = FT + SH * stories;
  const pitch = R.range(0.42, 0.55), eaveO = R.range(0.6, 0.88), vergeO = R.range(0.38, 0.55);
  const c = 1 / Math.hypot(1, pitch);
  const yTopWall = Hw + S.t0 - S.thick / c + 0.01;
  const PORCH = 0.16;

  // walls: materials per storey
  const wt = R.range(0.8, 1.25);
  const boardsV = { mat: M.woodV, color: [wt, wt * 0.97, wt * 0.93] };
  const boardsH = { mat: M.woodH, color: mul([1, 0.98, 0.94], R.range(0.8, 1.2)) };
  const plaster = { mat: M.plaster, color: R.pick(PLASTER) };
  const tin = { mat: M.corrugated, color: R.pick(TIN) };
  const boards = R.chance(0.6) ? boardsV : boardsH;
  const wainscot = R.chance(0.5);
  let low, up, gableM, splitY = FT + SH;
  if (wall === 'yakisugi') { low = up = gableM = boardsV; }
  else if (wall === 'lap') { low = up = gableM = boardsH; }
  else if (wall === 'plaster') { low = up = gableM = plaster; if (wainscot) { low = boards; splitY = FT + 0.95; } }
  else if (wall === 'mixed') { low = boards; up = gableM = plaster; if (stories === 1) splitY = FT + 1.1; }
  else { low = up = gableM = tin; }
  if (wall === 'plaster' && !wainscot) splitY = FT + SH;
  const trim = wall === 'tin' ? { mat: M.paint, color: mul(tin.color, 0.75) } : { mat: M.timber, color: S.wood };

  const K = new Kit();
  const faces = wallFaces(W, D);
  const FACE = Object.fromEntries(faces.map((f) => [f.id, f]));
  const hasGegyo = R.chance(0.5);
  const gable = { front: false, right: false, back: false, left: false };
  if (roof === 'kiri') { if (ridge === 'x') gable.left = gable.right = true; else gable.front = gable.back = true; }

  // ---- openings plan (910 mm bays)
  const grid = {};
  for (const f of faces) grid[f.id] = { ...bays(f.len), used: [[], []] };
  for (const f of faces) for (let s = 0; s < 2; s++) grid[f.id].used[s] = new Array(grid[f.id].n).fill(false);
  const opens = [];
  const add = (fid, kind, i, nb, st, extra = {}) => {
    const g = grid[fid];
    take(g.used[st], i, nb);
    const span = kind === 'small' ? Math.min(0.64, nb * g.bw - 0.2) : nb * g.bw - 0.14;
    const uc = (i + nb / 2) * g.bw;
    const f = FL[st];
    const vv = { win: [0.82, 1.95], small: [1.28, 1.86], tall: [0.04, 1.84] }[kind] || [0, 0];
    const o = { face: fid, kind, i, nb, st, u0: uc - span / 2, u1: uc + span / 2, v0: f + vv[0], v1: f + vv[1], ...extra };
    if (kind === 'door') { o.v0 = PORCH; o.v1 = PORCH + 1.9; o.top = o.v1 + 0.36; }
    o.top = o.top ?? o.v1;
    opens.push(o);
    return o;
  };
  // entrance
  const dFace = front === 'side' ? 'right' : 'front';
  const gD = grid[dFace];
  const doorNb = gD.n >= 9 && R.chance(0.35) ? 3 : 2;
  const dp = R();
  let di = dFace === 'right' ? 1 : dp < 0.4 ? 1 : dp < 0.8 ? gD.n - 1 - doorNb : Math.floor((gD.n - doorNb) / 2);
  di = clamp(di, 0, gD.n - doorNb);
  const door = add(dFace, 'door', di, doorNb, 0);
  // ground floor front windows (some behind a wooden lattice)
  const gF = grid.front;
  for (let t = 0; t < 3; t++) {
    let nb = R.chance(0.8) ? 2 : 3;
    let i = findRun(R, gF.used[0], nb, 1, 1);
    // no room with a gap: a window right beside the door
    if (i < 0 && t === 0) { nb = 2; i = findRun(R, gF.used[0], 2, 0, 0); }
    if (i >= 0) add('front', 'win', i, nb, 0, { lattice: R.chance(0.45) });
  }
  // upper floor: balcony, windows above the ground floor openings
  let balc = null;
  if (stories === 2) {
    if (R.chance(0.45) && gF.n >= 6) {
      const nb = gF.n >= 9 && R.chance(0.5) ? 3 : 2;
      const i = findRun(R, gF.used[1], nb, 1, 1);
      if (i >= 0) balc = add('front', 'tall', i, nb, 1, { balcony: true });
    }
    for (const o of opens.filter((q) => q.face === 'front' && q.st === 0)) {
      if (R.chance(0.8) && freeRun(gF.used[1], o.i, Math.min(o.nb, 3), 1)) add('front', 'win', o.i, Math.min(o.nb, 3), 1);
    }
    const want = 1 + (gF.n >= 8 ? 1 : 0) + (R.chance(0.4) ? 1 : 0);
    for (let t = 0; t < 4 && opens.filter((q) => q.face === 'front' && q.st === 1).length < want; t++) {
      const i = findRun(R, gF.used[1], 2, 1, 1);
      if (i >= 0) add('front', 'win', i, 2, 1);
    }
  }
  // sides and back
  for (const fid of ['right', 'left', 'back']) {
    const g = grid[fid];
    const n1 = fid === 'back' ? R.int(1, 3) : R.int(0, 2);
    for (let t = 0; t < n1; t++) {
      const small = R.chance(0.45), nb = small ? 1 : 2;
      const i = findRun(R, g.used[0], nb, 1, 1);
      if (i >= 0) add(fid, small ? 'small' : (fid === 'back' && R.chance(0.2) ? 'tall' : 'win'), i, nb, 0);
    }
    if (stories === 2) {
      const n2 = fid === 'back' ? R.int(1, 2) : R.int(0, 1);
      for (let t = 0; t < n2; t++) {
        const small = R.chance(0.2), nb = small ? 1 : 2;
        const i = findRun(R, g.used[1], nb, 1, 1);
        if (i >= 0) add(fid, small ? 'small' : 'win', i, nb, 1);
      }
    }
  }
  // details of each opening
  const blinds = R.chance(0.4);
  for (const o of opens) {
    if (o.kind === 'door') { o.lit = R() < lit; continue; }
    o.glass = glassFor(R, M, S, o.kind, lit);
    o.grille = o.kind === 'small' && R.chance(0.75);
    o.open = o.kind !== 'small' && R.chance(0.22) ? (R.chance(0.5) ? -1 : 1) : 0;
    const g = grid[o.face];
    o.tob = 0;
    if ((o.kind === 'win' || o.kind === 'tall') && !o.lattice && R.chance(o.kind === 'tall' ? 0.6 : 0.3)) {
      const side = R.chance(0.5) ? -1 : 1, j = side < 0 ? o.i - 1 : o.i + o.nb;
      if (j >= 0 && j < g.n && !g.used[o.st][j]) { o.tob = side; g.used[o.st][j] = true; }
    }
    o.rail = o.st === 1 && o.kind === 'win' && o.face === 'front' && R.chance(0.3);
    o.hood = o.kind !== 'tall' && !o.lattice && !o.rail && R.chance(0.3);
    o.sudare = blinds && (o.kind === 'win' || o.kind === 'tall') && !o.lattice && !o.balcony && R.chance(0.45);
  }

  // ---- foundation, walls, trim
  K.box(M.concrete, { w: W + 0.04, h: FT + 0.6, d: D + 0.04, pos: [0, (FT - 0.6) / 2, 0], color: mul([0.95, 0.94, 0.9], R.range(0.85, 1.05)) });
  for (const f of faces) {
    const hs = opens.filter((o) => o.face === f.id).map((o) => ({ u0: o.u0, u1: o.u1, v0: o.v0, v1: o.top }));
    K.push(f.M);
    // foundation vents and the drip flashing
    for (let u = 1.2; u < f.len - 0.8; u += 2.7) K.poly(M.paint, [v3(u, FT - 0.22, 0.021), v3(u + 0.3, FT - 0.22, 0.021), v3(u + 0.3, FT - 0.1, 0.021), v3(u, FT - 0.1, 0.021)], [[0, 0], [1, 0], [1, 1], [0, 1]], [0.09, 0.09, 0.09]);
    K.hbox(M.paint, { len: f.len + 0.06, h: 0.035, d: 0.035, pos: [f.len / 2, FT + 0.01, 0.015], color: [0.45, 0.45, 0.44] });
    const top = yTopWall;
    const sh = (m) => (m === tin ? { seed: seed + faces.indexOf(f) * 0.37, alt: R.pick(TIN) } : null);
    wallRect(K, low.mat, low.color, 0, f.len, FT, Math.min(splitY, top), hs, 0.25, sh(low));
    if (splitY < top) wallRect(K, up.mat, up.color, 0, f.len, splitY, top, hs, 0, sh(up));
    if (gable[f.id]) {
      const apex = top + (roof === 'kiri' ? (f.len / 2) * pitch : 0);
      K.poly(gableM.mat, [v3(0, top, 0), v3(f.len, top, 0), v3(f.len / 2, apex, 0)], [[0, top], [f.len, top], [f.len / 2, apex]], gableM.color);
      if (hasGegyo) gegyo(K, M, f.len / 2, apex - 0.02, 0.06, S);
      // louvre in the gable
      const ly = top + (apex - top) * 0.45;
      K.box(M.timber, { w: 0.5, h: 0.34, d: 0.05, pos: [f.len / 2, ly, 0.025], color: mul(S.wood, 0.8) });
      for (let i = 0; i < 4; i++) K.hbox(M.timber, { len: 0.42, h: 0.05, d: 0.03, pos: [f.len / 2, ly - 0.12 + i * 0.08, 0.06], color: S.wood });
    } else {
      // wall plate (軒桁) under the eave
      K.hbox(M.timber, { len: f.len + 0.04, h: 0.14, d: 0.05, pos: [f.len / 2, top - 0.1, 0.02], color: S.wood });
    }
    // band between the storeys / at the wainscot
    if (stories === 2) K.hbox(trim.mat, { len: f.len + 0.04, h: 0.16, d: 0.035, pos: [f.len / 2, FT + SH, 0.017], color: trim.color });
    if (splitY < FT + SH - 0.1) K.hbox(trim.mat, { len: f.len + 0.02, h: 0.05, d: 0.03, pos: [f.len / 2, splitY, 0.015], color: trim.color });
    // exposed posts on plaster walls (真壁)
    if (wall === 'plaster' || (wall === 'mixed' && stories === 2)) {
      const g = grid[f.id];
      for (let j = 2; j < g.n - 1; j += 2) {
        const u = j * g.bw;
        for (let st = wall === 'mixed' ? 1 : 0; st < stories; st++) {
          const y0 = st ? FT + SH + 0.08 : Math.max(FT, splitY), y1 = st || stories === 1 ? top : FT + SH - 0.08;
          if (hs.some((h) => u > h.u0 - 0.08 && u < h.u1 + 0.08 && h.v1 > y0 && h.v0 < y1)) continue;
          if (y1 - y0 > 0.3) K.box(M.timber, { w: 0.1, h: y1 - y0, d: 0.03, pos: [u, (y0 + y1) / 2, 0.012], color: S.wood });
        }
      }
    }
    K.pop();
  }
  // corner posts / trims
  const cornerTop = yTopWall + 0.02;
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    K.box(trim.mat, { w: 0.11, h: cornerTop - FT, d: 0.11, pos: [sx * (W / 2 - 0.03), (FT + cornerTop) / 2, sz * (D / 2 - 0.03)], color: trim.color });
  }

  // ---- openings
  for (const o of opens) {
    const f = FACE[o.face];
    K.push(f.M);
    if (o.kind === 'door') entrance(K, M, o, S);
    else if (o.kind === 'small') smallWindow(K, M, o, S);
    else sashWindow(K, M, o, S);
    if (o.lattice) lattice(K, M, o, S);
    if (o.rail) windowRail(K, M, o, S);
    if (o.tob) tobukuro(K, M, o, S, o.tob, grid[o.face].bw);
    const hooded = o.hood && !(stories === 2 && o.face === 'front' && o.st === 0);
    if (hooded) hood(K, M, o, S);
    if (o.sudare && !o.tob) sudare(K, M, o, R, hooded);
    K.pop();
  }

  // ---- entrance: porch, canopy, lamp, nameplate
  const fD = FACE[dFace];
  const duc = (door.u0 + door.u1) / 2, dw = door.u1 - door.u0;
  K.push(fD.M);
  K.box(M.concrete, { w: dw + 0.8, h: PORCH + 0.6, d: 1.0, pos: [duc, (PORCH - 0.6) / 2, 0.5], color: [0.9, 0.9, 0.86] });
  const pent = stories === 2 && R.chance(0.92);
  const canopy = !pent || dFace !== 'front' ? R.chance(0.85) : R.chance(0.15);
  if (canopy) {
    const yT = door.top + 0.42;
    if (R.chance(0.6)) leanTo(K, M, S, { u0: duc - dw / 2 - 0.35, u1: duc + dw / 2 + 0.35, yTop: yT, proj: R.range(0.6, 0.8), pitch: 0.32, gutter: false, raf: true, brackets: true });
    else {
      const pw = dw + 0.6, pr = R.range(0.6, 0.8), sl = 0.22, yF = yT - 0.1 - Math.sin(sl) * pr;
      K.box(M.paint, { w: pw, h: 0.05, d: pr, pos: [duc, yT - 0.1 - Math.sin(sl) * pr / 2, pr / 2], rot: [sl, 0, 0], color: S.hood });
      K.box(M.paint, { w: pw, h: 0.1, d: 0.025, pos: [duc, yF - 0.02, pr], color: mul(S.hood, 0.9) });
      for (const u of [duc - pw / 2 + 0.12, duc + pw / 2 - 0.12]) {
        K.beam(M.metal, v3(u, yT - 0.55, 0.01), v3(u, yF - 0.02, pr - 0.08), 0.03, 0.03, S.alu, v3(0, 1, 1));
        K.box(M.metal, { w: 0.03, h: 0.03, d: pr - 0.05, pos: [u, yT - 0.12 - Math.sin(sl) * pr / 2 - 0.035, pr / 2], rot: [sl, 0, 0], color: S.alu });
      }
    }
  }
  lamp(K, M, door.u1 + 0.28, door.top - 0.1);
  if (R.chance(0.7)) mailbox(K, M, door.u0 - 0.3, 1.05, R);
  K.box(M.timber, { w: 0.09, h: 0.24, d: 0.018, pos: [door.u0 - 0.2, 1.55, 0.009], color: [1.6, 1.45, 1.2] });
  K.pop();
  const entry = fD.o.clone().addScaledVector(fD.ex, duc).addScaledVector(fD.n, 1.3);

  // ---- pent roof between the floors, balcony
  const pentTop = FL[1] + 0.32;
  const segs = [];
  const bal = balc ? [balc.u0 - 0.3, balc.u1 + 0.3] : null;
  if (stories === 2 && pent) {
    const f = FACE.front, ext = 0.12;
    if (bal) {
      if (bal[0] - 0.05 > 1.0) segs.push([-ext, bal[0] - 0.05]);
      if (f.len - bal[1] - 0.05 > 1.0) segs.push([bal[1] + 0.05, f.len + ext]);
    } else segs.push([-ext, f.len + ext]);
    K.push(f.M);
    let pp = R.chance(0.5) ? -1 : 1;
    const proj = R.range(0.75, 0.95), pitchP = R.range(0.35, 0.45);
    // a single segment beside the balcony drains at its outer end
    if (segs.length === 1 && bal) pp = segs[0][1] <= bal[0] ? -1 : 1;
    segs.forEach(([a, b], i) => {
      // one downpipe, at an outer end of the facade (never across the door): with two
      // segments (either side of the balcony) only the one on side pp gets it
      const pipe = segs.length === 1 ? pp : (i === 0) === (pp < 0) ? (i === 0 ? -1 : 1) : 0;
      leanTo(K, M, S, { u0: a, u1: b, yTop: pentTop, proj, pitch: pitchP, pipe, verge: [true, true] });
    });
    K.pop();
  }
  if (bal) {
    K.push(FACE.front.M);
    balcony(K, M, S, R, { u0: bal[0], u1: bal[1], y: FL[1] - 0.02, depth: R.range(0.8, 0.95) });
    K.pop();
  }

  // ---- roof (canonical frame: ridge along x)
  const alongX = ridge === 'x';
  const Rm = alongX ? new THREE.Matrix4() : new THREE.Matrix4().makeRotationY(Math.PI / 2);
  const ax = (alongX ? W : D) / 2, bz = (alongX ? D : W) / 2;
  // downpipes at two opposite corners; the canonical front is the world front when alongX
  let ps = R.chance(0.5) ? 1 : -1;
  const pipeEnd = {};
  if (alongX) {
    const uAt = (sgn) => W / 2 + sgn * (W / 2 - 0.25);
    if (bal && uAt(ps) > bal[0] - 0.2 && uAt(ps) < bal[1] + 0.2) ps = -ps;
    const u = uAt(ps);
    if (segs.some(([a, b]) => u > a && u < b)) pipeEnd.front = pentTop + 0.12;
    else if (bal && u > bal[0] - 0.2 && u < bal[1] + 0.2) pipeEnd.front = FL[1] + 0.05;
  }
  const pipes = { front: [ps * (ax - 0.25)], back: [ps * (ax - 0.25)] };
  if (roof !== 'kiri') { pipes.right = []; pipes.left = []; }
  K.push(Rm);
  const rf = kawaraRoof(K, M, S, { type: roof, ax, bz, Hw, pitch, eaveO, vergeO, hip: R.range(0.36, 0.5), pipes, pipeEnd, gable: { mat: gableM === tin ? M.plaster : gableM.mat, color: gableM === tin ? PLASTER[0] : gableM.color } });
  if (R.chance(0.35)) {
    const ex = roof === 'kiri' ? ax * 0.75 : roof === 'yose' ? Math.max(0.2, ax + eaveO - bz - eaveO - 0.2) : ax * 0.4;
    antenna(K, M, v3(R.chance(0.5) ? ex : -ex, rf.yR + 0.1, 0), R);
  }
  if (R.chance(0.12) && ax > 2.6) {
    // on the back slope, somewhere between the eave and the ridge
    const c2 = 1 / Math.hypot(1, pitch), sn2 = pitch * c2, B = bz + eaveO;
    const Fb = rface(v3(0, rf.yE, -B), v3(-1, 0, 0), v3(0, sn2, c2));
    solarHeater(K, M, Fb, R.range(-0.4, 0.4) * (ax - 1.2), rf.L * R.range(0.45, 0.6), S.lip);
  }
  K.pop();
  if (R.chance(0.2)) {
    // bath-stove chimney (風呂釜の煙突) up the back wall, above the eave
    const f = FACE.back, u = f.len * R.range(0.2, 0.8);
    if (!opens.some((o) => o.face === 'back' && u > o.u0 - 0.3 && u < o.u1 + 0.3)) {
      K.push(f.M);
      const k = eaveO + 0.25, yTop = Hw + 1.9;
      K.rod(M.paint, v3(u, FL[0] + 0.6, 0.02), v3(u, FL[0] + 0.6, k), 0.055, 8, [0.3, 0.3, 0.3]);
      K.rod(M.paint, v3(u, FL[0] + 0.6, k), v3(u, yTop, k), 0.055, 8, [0.32, 0.3, 0.28]);
      K.cyl(M.paint, { r: 0.02, r2: 0.16, h: 0.12, seg: 8, pos: [u, yTop + 0.1, k], color: [0.3, 0.3, 0.3] });
      for (let y = FL[0] + 1.8; y < Hw - 0.2; y += 1.4) K.box(M.metal, { w: 0.02, h: 0.02, d: k, pos: [u, y, k / 2], color: [0.5, 0.5, 0.5] });
      K.pop();
    }
  }

  // ---- equipment on the side / back walls
  const spots = (fid, avoid) => {
    const g = grid[fid];
    const ok = [];
    for (let j = 1; j < g.n - 1; j++) if (!opens.some((o) => o.face === fid && o.st === 0 && (avoid.includes(o.kind) || o.tob) && (j + 0.5) * g.bw > o.u0 - 0.6 && (j + 0.5) * g.bw < o.u1 + 0.6)) ok.push((j + 0.5) * g.bw);
    return ok;
  };
  const sideA = R.pick(['right', 'left', 'back']);
  const sideB = R.pick(['back', 'right', 'left'].filter((x) => x !== sideA));
  const acS = spots(sideA, ['tall', 'door', 'win', 'small']);
  if (acS.length) {
    const u = R.pick(acS);
    K.push(FACE[sideA].M);
    acUnit(K, M, u, 0.12, S, stories === 2 && R.chance(0.5) ? FL[1] + 2.0 : FL[0] + 2.0);
    K.pop();
  }
  if (stories === 1 && R.chance(0.45)) {
    const f = FACE.back;
    K.push(f.M);
    laundryStand(K, M, clamp(f.len * R.range(0.35, 0.65), 1.5, f.len - 1.5), R.range(0.65, 0.8), R);
    K.pop();
  }
  const prS = spots(sideB, ['tall', 'door']);
  if (prS.length && R.chance(0.85)) {
    K.push(FACE[sideB].M);
    propane(K, M, R.pick(prS), S);
    K.pop();
  }
  {
    const mf = dFace === 'front' ? (duc < W / 2 ? 'left' : 'right') : 'front';
    const f = FACE[mf];
    const u = mf === 'left' ? f.len - 0.55 : mf === 'right' ? 0.55 : f.len - 0.5;
    const hs = opens.filter((o) => o.face === mf);
    if (!hs.some((o) => u > o.u0 - 0.2 && u < o.u1 + 0.2)) { K.push(f.M); meter(K, M, u, 1.75); K.pop(); }
  }

  const obj = K.build('house');
  const box = new THREE.Box3().setFromObject(obj);
  obj.userData = { kind: 'house', footprint: { w: W, d: D }, entrance: [entry.x, 0, entry.z], height: box.max.y, extent: ext(box), tris: tris(obj), params: { seed, w: W, d: D, stories, roof, wall, ridge, lit } };
  if (opts.debug) console.warn('house', JSON.stringify(obj.userData));
  return obj;
}

// ---------------------------------------------------------------------------
// storage shed (物置 / 納屋): corrugated tin or boards, lean-to or gable tin roof

const TIN_ROOF = [[0.62, 0.34, 0.27], [0.42, 0.52, 0.62], [0.74, 0.74, 0.74], [0.42, 0.54, 0.44], [0.55, 0.4, 0.33], [0.3, 0.33, 0.36]];

function shed(opts = {}) {
  const M = mats();
  const seed = Math.floor(num(opts.seed, 1));
  const R = rng(seed * 4099 + 17);
  const W = clamp(num(opts.w, R.range(2.2, 4.2)), 1.4, 8);
  const D = clamp(num(opts.d, R.range(1.6, 3.0)), 1.2, 6);
  const wall = str(opts.wall, R.pick(['tin', 'tin', 'boards', 'lap']));
  const roofT = str(opts.roof, R.chance(0.65) ? 'lean' : 'gable');
  const H = R.range(2.05, 2.4), p = roofT === 'lean' ? R.range(0.12, 0.2) : R.range(0.35, 0.5);
  const wm = wall === 'tin' ? { mat: M.corrugated, color: R.pick(TIN) }
    : wall === 'boards' ? { mat: M.woodV, color: mul([1, 0.97, 0.93], R.range(0.9, 1.5)) }
    : { mat: M.woodH, color: mul([1, 0.98, 0.94], R.range(0.8, 1.25)) };
  const roofC = R.pick(TIN_ROOF), wood = mul([0.5, 0.44, 0.38], R.range(0.8, 1.2));
  const K = new Kit();
  const hw = W / 2, hd = D / 2, FT = 0.1;
  K.box(M.concrete, { w: W + 0.12, h: 0.5, d: D + 0.12, pos: [0, FT - 0.25, 0], color: [0.88, 0.88, 0.85] });
  // wall top as a function of z (lean-to: high at the front)
  const top = (z) => (roofT === 'lean' ? H - (hd - z) * p : H);
  const faces = wallFaces(W, D);
  for (const f of faces) {
    K.push(f.M);
    const door = f.id === 'front' ? [W / 2 - R.range(0.1, 0.4) * W / 2 - 0.45, W / 2 - R.range(0.1, 0.4) * W / 2 + 0.45] : null;
    const holes = door ? [{ u0: door[0], u1: door[1], v0: FT, v1: FT + 1.8 }] : [];
    if (f.id === 'front' || f.id === 'back') {
      const t = top(f.id === 'front' ? hd : -hd);
      wallRect(K, wm.mat, wm.color, 0, f.len, FT, t, holes, 0.2, wall === 'tin' ? { seed: seed + 0.5, alt: R.pick(TIN) } : null);
      if (roofT === 'gable') K.poly(wm.mat, [v3(0, t, 0), v3(f.len, t, 0), v3(f.len / 2, t + hw * p, 0)], [[0, t], [f.len, t], [f.len / 2, t + hw * p]], wm.color);
    } else {
      // side walls follow the slope (u runs front -> back on the right, back -> front on the left)
      const z0 = f.id === 'right' ? hd : -hd, z1 = -z0;
      K.poly(wm.mat, [v3(0, FT, 0), v3(f.len, FT, 0), v3(f.len, top(z1), 0), v3(0, top(z0), 0)], [[0, FT], [f.len, FT], [f.len, top(z1)], [0, top(z0)]], wm.color);
    }
    if (door) {
      // sliding door on a top rail
      const [a, b] = door, dc = wall === 'tin' ? mul(wm.color, R.range(0.75, 1.1)) : mul(wm.color, 0.85);
      K.box(M.timber, { w: b - a + 0.1, h: 0.06, d: 0.05, pos: [(a + b) / 2, FT + 1.83, 0.025], color: wood });
      for (const u of [a - 0.03, b + 0.03]) K.box(M.timber, { w: 0.06, h: 1.8, d: 0.05, pos: [u, FT + 0.9, 0.025], color: wood });
      const slide = R.range(-0.3, 0.1);
      K.poly(M.matte, [v3(a, FT, 0.005), v3(b, FT, 0.005), v3(b, FT + 1.8, 0.005), v3(a, FT + 1.8, 0.005)], [[0, 0], [1, 0], [1, 1], [0, 1]], [0.04, 0.04, 0.04]);
      K.box(wm.mat, { w: b - a + 0.04, h: 1.78, d: 0.025, pos: [(a + b) / 2 + slide, FT + 0.9, 0.07], color: dc });
      K.box(M.metal, { w: b - a + 0.6, h: 0.03, d: 0.04, pos: [(a + b) / 2, FT + 1.84, 0.09], color: [0.7, 0.7, 0.7] });
      K.box(M.metal, { w: 0.03, h: 0.14, d: 0.03, pos: [(a + b) / 2 + slide + (b - a) / 2 - 0.1, FT + 0.95, 0.09], color: [0.6, 0.6, 0.6] });
    }
    K.pop();
  }
  // corner trims
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const t = top(sz * hd);
    K.box(wall === 'tin' ? M.paint : M.timber, { w: 0.08, h: t - FT, d: 0.08, pos: [sx * (hw - 0.02), (FT + t) / 2, sz * (hd - 0.02)], color: wall === 'tin' ? mul(wm.color, 0.8) : wood });
  }
  // roof: corrugated sheets (ribs run down the slope), edge flashing
  const ov = 0.22, sheet = 0.03;
  if (roofT === 'lean') {
    const len = (D + 2 * ov) * Math.hypot(1, p), ang = Math.atan(p);
    // high at the front (+z): rotating by -ang about x lifts local +z
    K.box(M.corrugated, { w: W + 2 * 0.15, h: sheet, d: len, pos: [0, (top(hd) + top(-hd)) / 2 + 0.06, 0], rot: [-ang, 0, 0], color: roofC });
    K.box(M.paint, { w: W + 0.32, h: 0.06, d: 0.03, pos: [0, top(hd + ov) + 0.05, hd + ov], color: mul(roofC, 0.8) });
    for (const sx of [-1, 1]) K.box(M.paint, { w: 0.03, h: 0.07, d: len, pos: [sx * (hw + 0.15), (top(hd) + top(-hd)) / 2 + 0.06, 0], rot: [-ang, 0, 0], color: mul(roofC, 0.8) });
    // purlins under the sheets
    for (const z of [hd + ov - 0.1, 0, -hd - ov + 0.1]) K.hbox(M.timber, { len: W + 0.2, h: 0.06, d: 0.06, pos: [0, top(z) + 0.015, z], color: wood });
  } else {
    const run = hw + ov, len = run * Math.hypot(1, p), ang = Math.atan(p);
    for (const sx of [-1, 1]) {
      // box depth along the slope (so the ribs run down it), turned to face +-x and tilted
      K.box(M.corrugated, { w: D + 0.36, h: sheet, d: len, pos: [sx * (run / 2 - 0.01), H + (hw - run / 2) * p + 0.06, 0], rot: [ang, sx * Math.PI / 2, 0], color: roofC });
    }
    K.box(M.paint, { w: 0.2, h: 0.05, d: D + 0.4, pos: [0, H + hw * p + 0.09, 0], color: mul(roofC, 0.85) });
  }
  // a few things: a drum can, net floats hanging on the wall
  if (R.chance(0.5)) K.cyl(M.paint, { r: 0.29, h: 0.88, seg: 12, pos: [hw + 0.45, 0.44, R.range(-hd + 0.4, hd - 0.4)], color: R.pick([[0.3, 0.42, 0.55], [0.6, 0.25, 0.2], [0.35, 0.45, 0.35]]) });
  if (R.chance(0.45)) {
    const f = faces[R.pick([1, 3])];
    K.push(f.M);
    for (let i = 0, n = R.int(2, 4); i < n; i++) {
      const u = f.len * (0.25 + 0.5 * R()), y = R.range(1.2, 1.8);
      K.geo(M.paint, new THREE.SphereGeometry(0.14, 8, 6), Builder.mat({ pos: [u, y, 0.16] }), R.pick([[0.9, 0.45, 0.15], [0.85, 0.85, 0.82], [0.25, 0.45, 0.6]]));
      K.box(M.matte, { w: 0.01, h: 0.3, d: 0.01, pos: [u, y + 0.25, 0.1], color: [0.2, 0.2, 0.2] });
    }
    K.pop();
  }
  const obj = K.build('shed');
  const box = new THREE.Box3().setFromObject(obj);
  obj.userData = { kind: 'shed', footprint: { w: W, d: D }, entrance: [0, 0, hd + 0.8], height: box.max.y, extent: ext(box), tris: tris(obj) };
  return obj;
}

// ---------------------------------------------------------------------------
// the fishery co-op (漁協): two-storey white concrete building by the harbour

let SIGN = null;
function signMaterial() {
  if (SIGN) return SIGN;
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#e9e6dc'; g.fillRect(0, 0, 1024, 256);
  g.strokeStyle = '#27324a'; g.lineWidth = 10; g.strokeRect(14, 14, 996, 228);
  const fam = document.fonts && document.fonts.check('600 100px "Shippori Mincho B1"') ? '"Shippori Mincho B1"' : 'sans-serif';
  g.fillStyle = '#1f2a44';
  g.font = `600 176px ${fam}`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('漁　協', 512, 136);
  // weathering: faint streaks
  const R = rng(99);
  for (let i = 0; i < 70; i++) { g.fillStyle = `rgba(90,80,60,${0.03 + 0.05 * R()})`; g.fillRect(R() * 1024, R() * 60, 2 + R() * 6, 120 + R() * 140); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  SIGN = prep(new THREE.MeshStandardMaterial({ name: 'coopSign', map: t, roughness: 0.6, metalness: 0 }), null, 'houses-sign');
  return SIGN;
}

function coop(opts = {}) {
  const M = mats();
  const seed = Math.floor(num(opts.seed, 7));
  const R = rng(seed * 331 + 5);
  const W = clamp(num(opts.w, 14), 9, 26), D = clamp(num(opts.d, 9), 6, 14);
  const lit = clamp(num(opts.lit, 0.3), 0, 1);
  const S = houseStyle(R);
  S.alu = [1, 1, 1];
  const FT = 0.25, H1 = 3.6, H2 = 3.1, y1 = FT + H1, y2 = y1 + H2, par = 0.8;
  const white = [1.45, 1.45, 1.4], band = [1.55, 1.55, 1.5];
  const K = new Kit();
  const faces = wallFaces(W, D), F = Object.fromEntries(faces.map((f) => [f.id, f]));
  const opens = [];
  const win = (fid, u0, u1, v0, v1, extra = {}) => opens.push({ face: fid, kind: 'win', u0, u1, v0, v1, top: v1, ...extra, glass: glassFor(R, M, S, 'win', lit) });
  // front: roll-up shutter, glass entrance, windows; the upper floor a row of windows
  const shW = Math.min(4.2, W * 0.32), sh0 = 0.7;
  const shutter = { face: 'front', kind: 'shutter', u0: sh0, u1: sh0 + shW, v0: FT, v1: FT + 3.0, top: FT + 3.0 };
  opens.push(shutter);
  const e0 = sh0 + shW + 1.0, e1 = e0 + 1.8;
  const door = { face: 'front', kind: 'door', u0: e0, u1: e1, v0: FT, v1: FT + 2.2, top: FT + 2.55 };
  opens.push(door);
  for (let u = e1 + 0.9; u + 1.7 < W - 0.5; u += 2.6) win('front', u, u + 1.7, FT + 1.0, FT + 2.3);
  const n2 = Math.max(2, Math.floor((W - 1.0) / 2.6));
  const pitch2 = (W - 1.0) / n2;
  for (let i = 0; i < n2; i++) { const u = 0.5 + i * pitch2 + (pitch2 - 1.75) / 2; win('front', u, u + 1.75, y1 + 0.85, y1 + 2.15); }
  // back and left side
  for (let i = 0; i < n2; i++) { const u = 0.5 + i * pitch2 + (pitch2 - 1.6) / 2; win('back', u, u + 1.6, y1 + 0.85, y1 + 2.05); if (i % 2 === 0) win('back', u + 0.4, u + 1.2, FT + 1.6, FT + 2.3, { small: true }); }
  const nd = Math.max(1, Math.floor((D - 1.0) / 2.8));
  for (let i = 0; i < nd; i++) { const u = 0.5 + ((D - 1.0) * (i + 0.5)) / nd - 0.8; win('left', u, u + 1.6, y1 + 0.85, y1 + 2.05); win('left', u + 0.2, u + 1.4, FT + 1.2, FT + 2.3); }
  // right side: the stair up to a door on the upper floor
  const land = [D - 1.5, D - 0.25];
  const d2 = { face: 'right', kind: 'steelDoor', u0: land[0] + 0.25, u1: land[0] + 1.1, v0: y1, v1: y1 + 2.0, top: y1 + 2.0 };
  opens.push(d2);
  const stair0 = land[0] - Math.round((y1 - FT) / 0.19) * 0.24;
  if (stair0 > 2.4) { win('right', 0.8, 2.2, y1 + 0.85, y1 + 2.05); win('right', 1.0, 1.9, FT + 1.3, FT + 2.1, { small: true }); }

  // body
  K.box(M.concrete, { w: W + 0.1, h: FT + 0.6, d: D + 0.1, pos: [0, (FT - 0.6) / 2, 0], color: [0.95, 0.95, 0.92] });
  for (const f of faces) {
    const hs = opens.filter((o) => o.face === f.id).map((o) => ({ u0: o.u0, u1: o.u1, v0: o.v0, v1: o.top }));
    K.push(f.M);
    wallRect(K, M.coopWall, WHITE, 0, f.len, FT, y2 + par, hs, 0);
    // slab edges and the parapet coping
    K.hbox(M.concrete, { len: f.len + 0.14, h: 0.24, d: 0.07, pos: [f.len / 2, y1 - 0.05, 0.035], color: band });
    K.hbox(M.concrete, { len: f.len + 0.14, h: 0.3, d: 0.07, pos: [f.len / 2, y2 - 0.1, 0.035], color: band });
    K.hbox(M.metal, { len: f.len + 0.2, h: 0.05, d: 0.1, pos: [f.len / 2, y2 + par + 0.02, 0.0], color: [0.75, 0.76, 0.76] });
    K.pop();
  }
  // roof slab and the inner faces of the parapet
  K.box(M.concrete, { w: W - 0.3, h: 0.1, d: D - 0.3, pos: [0, y2 + 0.05, 0], color: [0.72, 0.72, 0.7] });
  for (const f of faces) {
    K.push(f.M);
    K.poly(M.concrete, [v3(f.len - 0.15, y2 + 0.1, -0.15), v3(0.15, y2 + 0.1, -0.15), v3(0.15, y2 + par, -0.15), v3(f.len - 0.15, y2 + par, -0.15)], [[0, 0], [f.len, 0], [f.len, par], [0, par]], [1.1, 1.1, 1.06]);
    K.hbox(M.concrete, { len: f.len, h: 0.02, d: 0.15, pos: [f.len / 2, y2 + par, -0.075], color: band });
    K.pop();
  }
  // openings
  for (const o of opens) {
    K.push(F[o.face].M);
    if (o.kind === 'win') { if (o.small) smallWindow(K, M, { ...o, grille: true }, S); else sashWindow(K, M, o, S); }
    else if (o.kind === 'shutter') {
      const w = o.u1 - o.u0, uc = (o.u0 + o.u1) / 2, h = o.v1 - o.v0, sc = [0.72, 0.76, 0.74];
      // roll-up shutter: slats run across (corrugated texture turned sideways)
      K.poly(M.corrugated, [v3(o.u0, o.v0, -0.06), v3(o.u1, o.v0, -0.06), v3(o.u1, o.v1, -0.06), v3(o.u0, o.v1, -0.06)], [[0, 0], [0, w], [h, w], [h, 0]], sc);
      for (const u of [o.u0 + 0.04, o.u1 - 0.04]) K.box(M.metal, { w: 0.08, h, d: 0.1, pos: [u, o.v0 + h / 2, -0.02], color: [0.7, 0.7, 0.7] });
      K.box(M.paint, { w: w + 0.2, h: 0.4, d: 0.36, pos: [uc, o.v1 + 0.2, 0.12], color: [0.75, 0.77, 0.76] });
      K.box(M.metal, { w: w, h: 0.06, d: 0.04, pos: [uc, o.v0 + 0.03, -0.03], color: [0.55, 0.55, 0.55] });
    } else if (o.kind === 'door') {
      const al = [1, 1, 1], w = o.u1 - o.u0, uc = (o.u0 + o.u1) / 2;
      K.box(M.metal, { w, h: 0.06, d: 0.1, pos: [uc, o.top - 0.03, -0.02], color: al });
      K.box(M.metal, { w, h: 0.05, d: 0.1, pos: [uc, o.v1 + 0.025, -0.02], color: al });
      for (const u of [o.u0 + 0.03, uc, o.u1 - 0.03]) K.box(M.metal, { w: 0.06, h: o.top - o.v0, d: 0.1, pos: [u, (o.v0 + o.top) / 2, -0.02], color: al });
      K.box(M.metal, { w, h: 0.12, d: 0.08, pos: [uc, o.v0 + 0.06, -0.03], color: al });
      K.box(M.metal, { w, h: 0.04, d: 0.06, pos: [uc, o.v0 + 1.0, -0.03], color: al });
      pane(K, o.u0 + 0.06, o.u1 - 0.06, o.v0 + 0.12, o.v1, -0.05, { base: [R() < lit ? M.windowLit : M.glass, WHITE] });
      pane(K, o.u0 + 0.06, o.u1 - 0.06, o.v1 + 0.05, o.top - 0.06, -0.05, { base: [M.glass, WHITE] });
      K.box(M.concrete, { w: w + 1.6, h: FT + 0.6, d: 1.4, pos: [uc, (FT - 0.6) / 2 - 0.01, 0.7], color: [0.85, 0.85, 0.82] });
    } else if (o.kind === 'steelDoor') {
      const w = o.u1 - o.u0, uc = (o.u0 + o.u1) / 2, dc = [0.5, 0.6, 0.58];
      K.box(M.paint, { w, h: o.v1 - o.v0, d: 0.05, pos: [uc, (o.v0 + o.v1) / 2, -0.02], color: dc });
      K.box(M.paint, { w: w + 0.1, h: 0.05, d: 0.08, pos: [uc, o.v1 + 0.02, 0], color: mul(dc, 0.8) });
      pane(K, uc - 0.15, uc + 0.15, o.v0 + 1.3, o.v0 + 1.75, 0.006, { base: [M.glass, WHITE] });
      K.box(M.metal, { w: 0.03, h: 0.12, d: 0.04, pos: [o.u1 - 0.12, o.v0 + 1.0, 0.03] });
    }
    K.pop();
  }
  // concrete canopy along the ground floor front, sign board on the parapet
  K.push(F.front.M);
  K.box(M.concrete, { w: W - 0.2, h: 0.16, d: 1.2, pos: [W / 2, y1 - 0.25, 0.6], color: band });
  K.box(M.paint, { w: W - 0.2, h: 0.26, d: 0.08, pos: [W / 2, y1 - 0.3, 1.2], color: [0.22, 0.4, 0.62] });
  const sw = Math.min(W * 0.34, 4.6), sh = sw / 4;
  K.box(M.paint, { w: sw + 0.12, h: sh + 0.12, d: 0.06, pos: [W / 2, y2 + par / 2 + 0.05, 0.03], color: [0.5, 0.5, 0.52] });
  K.poly(signMaterial(), [v3(W / 2 - sw / 2, y2 + par / 2 + 0.05 - sh / 2, 0.065), v3(W / 2 + sw / 2, y2 + par / 2 + 0.05 - sh / 2, 0.065), v3(W / 2 + sw / 2, y2 + par / 2 + 0.05 + sh / 2, 0.065), v3(W / 2 - sw / 2, y2 + par / 2 + 0.05 + sh / 2, 0.065)], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  // lamp over the entrance, a hose reel and pipes
  lamp(K, M, door.u1 + 0.3, FT + 2.4);
  K.pop();
  // outside steel stair on the right side up to the landing
  K.push(F.right.M);
  {
    const sc = [0.42, 0.52, 0.5], sw2 = 0.9, k0 = 0.08, k1 = k0 + sw2, rise = y1 - FT, n = Math.round(rise / 0.19), run = n * 0.24;
    const u1 = land[0], u0 = u1 - run;
    for (const k of [k0 + 0.03, k1 - 0.03]) K.beam(M.paint, v3(u0, FT, k), v3(u1, y1 - 0.1, k), 0.04, 0.2, sc, v3(0, 1, 0));
    for (let i = 0; i < n; i++) K.box(M.paint, { w: 0.24, h: 0.03, d: sw2 - 0.06, pos: [u0 + (i + 0.5) * 0.24, FT + (i + 1) * (rise / n) - 0.1, (k0 + k1) / 2], color: mul(sc, 0.9) });
    // landing on two posts
    K.box(M.paint, { w: land[1] - land[0], h: 0.12, d: sw2 + 0.1, pos: [(land[0] + land[1]) / 2, y1 - 0.06, (k0 + k1) / 2], color: sc });
    for (const u of [land[0] + 0.05, land[1] - 0.05]) K.box(M.paint, { w: 0.08, h: y1 + 0.3, d: 0.08, pos: [u, (y1 - 0.3) / 2, k1 - 0.04], color: sc });
    // handrails: along the stair's outer side and round the landing
    const hh = 0.9;
    K.rod(M.paint, v3(u0, FT + hh, k1), v3(u1, y1 + hh, k1), 0.02, 6, sc);
    for (let i = 0; i <= 4; i++) { const u = u0 + (run * i) / 4, y = FT + (rise * i) / 4; K.rod(M.paint, v3(u, y, k1), v3(u, y + hh, k1), 0.016, 5, sc); }
    K.rod(M.paint, v3(land[0], y1 + hh, k1), v3(land[1], y1 + hh, k1), 0.02, 6, sc);
    K.rod(M.paint, v3(land[1], y1 + hh, k1), v3(land[1], y1 + hh, k0), 0.02, 6, sc);
    for (const [u, k] of [[land[1], k1], [land[1], k0 + 0.05], [(land[0] + land[1]) / 2, k1]]) K.rod(M.paint, v3(u, y1, k), v3(u, y1 + hh, k), 0.016, 5, sc);
  }
  K.pop();
  // roof: elevated water tank, air conditioners, a loudspeaker pole (防災無線), downpipes
  {
    const tx = -W / 2 + 2.2, tz = -D / 2 + 2.0, ty = y2 + 0.1;
    for (const [dx, dz] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) K.box(M.paint, { w: 0.08, h: 1.2, d: 0.08, pos: [tx + dx, ty + 0.6, tz + dz], color: [0.45, 0.47, 0.46] });
    K.cyl(M.paint, { r: 0.85, h: 1.4, seg: 14, pos: [tx, ty + 1.9, tz], color: [0.78, 0.8, 0.78] });
    K.cyl(M.paint, { r: 0.87, r2: 0.2, h: 0.25, seg: 14, pos: [tx, ty + 2.72, tz], color: [0.74, 0.76, 0.74] });
    const px = W / 2 - 1.2, pz = -D / 2 + 1.2;
    K.cyl(M.paint, { r: 0.06, h: 4.2, seg: 8, pos: [px, ty + 2.1, pz], color: [0.7, 0.7, 0.68] });
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI * 2) / 3 + 0.4;
      K.cyl(M.paint, { r: 0.05, r2: 0.22, h: 0.5, seg: 8, pos: [px + Math.sin(a) * 0.25, ty + 3.8, pz + Math.cos(a) * 0.25], rot: [Math.PI / 2 + 0.25, a, 0], color: [0.82, 0.82, 0.78] });
    }
    // air conditioners on the roof, facing the back
    for (let i = 0; i < 3; i++) {
      K.push(new THREE.Matrix4().makeRotationY(Math.PI).setPosition(-W / 2 + 4.5 + i * 1.1, 0, -D / 2 + 0.95));
      acUnit(K, M, 0, ty + 0.15, S, 0);
      K.pop();
    }
    for (const [x, z] of [[-W / 2 + 0.2, D / 2 + 0.06], [W / 2 - 0.2, -D / 2 - 0.06]]) {
      K.rod(M.paint, v3(x, -0.05, z), v3(x, y2 + 0.2, z), 0.045, 8, [0.8, 0.8, 0.78]);
    }
  }
  const obj = K.build('coop');
  const box = new THREE.Box3().setFromObject(obj);
  const ent = F.front.o.clone().addScaledVector(F.front.ex, (door.u0 + door.u1) / 2).addScaledVector(F.front.n, 1.6);
  obj.userData = { kind: 'coop', footprint: { w: W, d: D }, entrance: [ent.x, 0, ent.z], height: box.max.y, extent: ext(box), tris: tris(obj) };
  return obj;
}

// ---------------------------------------------------------------------------
// a row of attached two-storey townhouses (長屋) for the quay

function row(opts = {}) {
  const M = mats();
  const seed = Math.floor(num(opts.seed, 1));
  const R = rng(seed * 6007 + 29);
  const nR = R.int(3, 4), uwR = R.range(4.6, 5.4);
  const W0 = num(opts.w, nR * uwR);
  const n = clamp(num(opts.units, Math.round(W0 / 5)), 2, 6);
  const W = clamp(W0, n * 3.6, n * 7), uw = W / n;
  const D = clamp(num(opts.d, R.range(6.4, 8)), 4.5, 11);
  const lit = clamp(num(opts.lit, 0.45), 0, 1);
  const S = houseStyle(R);
  const FT = R.range(0.34, 0.42), SH = R.range(2.55, 2.7), FL = [FT + 0.12, FT + SH + 0.12];
  const pitch = R.range(0.42, 0.52), eaveO = R.range(0.6, 0.8), vergeO = R.range(0.35, 0.5), PORCH = 0.14;
  const c = 1 / Math.hypot(1, pitch);
  const K = new Kit();
  const faces = wallFaces(W, D), F = Object.fromEntries(faces.map((f) => [f.id, f]));
  // roof sections: one continuous roof, or stepped (units re-roofed at different times)
  const split = R.chance(0.5) && n >= 3 ? R.int(1, n - 1) : 0;
  const dh = split ? R.pick([-1, 1]) * R.range(0.25, 0.45) : 0;
  const secs = split ? [{ x0: 0, x1: split * uw, Hw: FT + 2 * SH + (dh > 0 ? 0 : dh) }, { x0: split * uw, x1: W, Hw: FT + 2 * SH + (dh > 0 ? dh : 0) }] : [{ x0: 0, x1: W, Hw: FT + 2 * SH }];
  const topAt = (sec) => sec.Hw + S.t0 - S.thick / c + 0.01;
  // per unit styling
  const woodA = mul([1, 0.97, 0.93], R.range(0.85, 1.2)), lapA = mul([1, 0.98, 0.94], R.range(0.85, 1.15));
  const units = [];
  for (let i = 0; i < n; i++) {
    const r = R();
    const low = r < 0.55 ? { mat: M.woodV, color: mul(woodA, R.range(0.85, 1.15)) } : r < 0.8 ? { mat: M.woodH, color: mul(lapA, R.range(0.9, 1.1)) } : { mat: M.corrugated, color: R.pick(TIN) };
    const up = R.chance(0.5) ? low : R.chance(0.6) ? { mat: M.plaster, color: R.pick(PLASTER) } : { mat: M.woodV, color: mul(woodA, R.range(0.9, 1.2)) };
    units.push({ i, x0: i * uw, x1: (i + 1) * uw, low, up, doorLeft: R.chance(0.5), rail: R.chance(0.55), lattice: R.chance(0.55) });
  }
  // openings
  const opens = [];
  const add = (face, kind, u0, u1, st, extra = {}) => {
    const f = FL[st];
    const vv = { win: [0.82, 1.9], small: [1.28, 1.86], tall: [0.04, 1.84] }[kind] || [0, 0];
    const o = { face, kind, u0, u1, v0: f + vv[0], v1: f + vv[1], st, ...extra };
    if (kind === 'door') { o.v0 = PORCH; o.v1 = PORCH + 1.85; o.top = o.v1 + 0.34; o.lit = R() < lit; }
    o.top = o.top ?? o.v1;
    if (kind !== 'door') { o.glass = glassFor(R, M, S, kind, lit); o.open = kind === 'win' && R.chance(0.2) ? (R.chance(0.5) ? -1 : 1) : 0; o.grille = kind === 'small'; }
    opens.push(o);
    return o;
  };
  const doors = [];
  for (const u of units) {
    const a = u.x0 + 0.3, b = u.x1 - 0.3, dw = Math.min(1.75, (b - a) * 0.42);
    const [d0, d1] = u.doorLeft ? [a, a + dw] : [b - dw, b];
    doors.push(add('front', 'door', d0, d1, 0));
    const [w0, w1] = u.doorLeft ? [d1 + 0.45, b] : [a, d0 - 0.45];
    if (w1 - w0 > 1.0) add('front', 'win', w0, w0 + Math.min(1.8, w1 - w0), 0, { lattice: u.lattice });
    // upper floor: two windows, or one wide one with a railing
    if (R.chance(0.5)) { const ww = Math.min(2.6, b - a - 0.6), m = (a + b) / 2; add('front', 'win', m - ww / 2, m + ww / 2, 1, { rail: u.rail }); }
    else { const ww = Math.min(1.5, (b - a - 0.6) / 2); add('front', 'win', a + 0.2, a + 0.2 + ww, 1, { rail: u.rail }); add('front', 'win', b - 0.2 - ww, b - 0.2, 1, { rail: u.rail }); }
    // back: kitchen / bath windows
    const bu = W - (u.x0 + u.x1) / 2;
    add('back', 'small', bu - 1.2, bu - 0.6, 0);
    add('back', 'win', bu + 0.1, bu + 1.4, 1);
    if (R.chance(0.5)) add('back', 'win', bu + 0.3, bu + 1.6, 0);
  }
  for (const fid of ['left', 'right']) if (R.chance(0.7)) add(fid, 'win', D / 2 - 0.8, D / 2 + 0.8, 1);
  // body
  K.box(M.concrete, { w: W + 0.04, h: FT + 0.6, d: D + 0.04, pos: [0, (FT - 0.6) / 2, 0], color: mul([0.95, 0.94, 0.9], R.range(0.85, 1.05)) });
  const secAt = (x) => secs.find((q) => x >= q.x0 - 1e-6 && x <= q.x1 + 1e-6) || secs[0];
  for (const f of faces) {
    const hs = opens.filter((o) => o.face === f.id).map((o) => ({ u0: o.u0, u1: o.u1, v0: o.v0, v1: o.top }));
    K.push(f.M);
    for (let u = 1.2; u < f.len - 0.8; u += 2.7) K.poly(M.paint, [v3(u, FT - 0.22, 0.021), v3(u + 0.3, FT - 0.22, 0.021), v3(u + 0.3, FT - 0.1, 0.021), v3(u, FT - 0.1, 0.021)], [[0, 0], [1, 0], [1, 1], [0, 1]], [0.09, 0.09, 0.09]);
    K.hbox(M.paint, { len: f.len + 0.06, h: 0.035, d: 0.035, pos: [f.len / 2, FT + 0.01, 0.015], color: [0.45, 0.45, 0.44] });
    if (f.id === 'front' || f.id === 'back') {
      for (const u of units) {
        // world x range of the unit -> this face's u range
        const [ua, ub] = f.id === 'front' ? [u.x0, u.x1] : [W - u.x1, W - u.x0];
        const top = topAt(secAt((u.x0 + u.x1) / 2));
        const lo = f.id === 'front' ? u.low : units[0].low, hi = f.id === 'front' ? u.up : units[0].low;
        const shs = (m) => (m.mat === M.corrugated ? { seed: seed + u.i * 0.71 + (f.id === 'back' ? 0.3 : 0), alt: R.pick(TIN) } : null);
        wallRect(K, lo.mat, lo.color, ua, ub, FT, FT + SH, hs, 0.25, shs(lo));
        wallRect(K, hi.mat, hi.color, ua, ub, FT + SH, top, hs, 0, shs(hi));
        K.hbox(M.timber, { len: ub - ua, h: 0.14, d: 0.05, pos: [(ua + ub) / 2, top - 0.1, 0.02], color: S.wood });
      }
      // posts between the units
      for (let i = 1; i < n; i++) { const u = i * uw; K.box(M.timber, { w: 0.12, h: topAt(secs[0]) - FT, d: 0.05, pos: [u, (topAt(secs[0]) + FT) / 2, 0.02], color: S.wood }); }
      K.hbox(M.timber, { len: f.len + 0.04, h: 0.16, d: 0.035, pos: [f.len / 2, FT + SH, 0.017], color: S.wood });
    } else {
      // gable ends
      const sec = f.id === 'right' ? secs[secs.length - 1] : secs[0], top = topAt(sec);
      const m = f.id === 'right' ? units[n - 1].low : units[0].low;
      wallRect(K, m.mat, m.color, 0, f.len, FT, top, hs, 0.25, m.mat === M.corrugated ? { seed: seed + (f.id === 'left' ? 0.13 : 0.57), alt: R.pick(TIN) } : null);
      K.poly(m.mat, [v3(0, top, 0), v3(f.len, top, 0), v3(f.len / 2, top + (D / 2) * pitch, 0)], [[0, top], [f.len, top], [f.len / 2, top + (D / 2) * pitch]], m.color);
      K.hbox(M.timber, { len: f.len + 0.04, h: 0.16, d: 0.035, pos: [f.len / 2, FT + SH, 0.017], color: S.wood });
    }
    K.pop();
  }
  // the taller section's gable wall above the lower roof
  if (split) {
    const lo = secs[0].Hw < secs[1].Hw ? secs[0] : secs[1], hi = lo === secs[0] ? secs[1] : secs[0];
    const x = -W / 2 + split * uw, dir = lo === secs[0] ? -1 : 1;
    const t0 = topAt(lo) - 0.3, t1 = topAt(hi), ap = t1 + (D / 2) * pitch;
    const m = units[lo === secs[0] ? split : split - 1].up;
    const pts = dir < 0 ? [v3(x, t0, D / 2), v3(x, t0, -D / 2), v3(x, t1, -D / 2), v3(x, ap, 0), v3(x, t1, D / 2)] : [v3(x, t0, -D / 2), v3(x, t0, D / 2), v3(x, t1, D / 2), v3(x, ap, 0), v3(x, t1, -D / 2)];
    K.poly(m.mat, pts, pts.map((q) => [q.z * -dir, q.y]), m.color);
  }
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const top = topAt(sx > 0 ? secs[secs.length - 1] : secs[0]) + 0.02;
    K.box(M.timber, { w: 0.11, h: top - FT, d: 0.11, pos: [sx * (W / 2 - 0.03), (FT + top) / 2, sz * (D / 2 - 0.03)], color: S.wood });
  }
  // openings
  for (const o of opens) {
    K.push(F[o.face].M);
    if (o.kind === 'door') entrance(K, M, o, S);
    else if (o.kind === 'small') smallWindow(K, M, o, S);
    else sashWindow(K, M, o, S);
    if (o.lattice) lattice(K, M, o, S);
    if (o.rail) windowRail(K, M, o, S);
    K.pop();
  }
  // porches, lamps, nameplates
  K.push(F.front.M);
  for (const d of doors) {
    const uc = (d.u0 + d.u1) / 2;
    K.box(M.concrete, { w: d.u1 - d.u0 + 0.5, h: PORCH + 0.6, d: 0.8, pos: [uc, (PORCH - 0.6) / 2, 0.4], color: [0.9, 0.9, 0.86] });
    if (R.chance(0.6)) lamp(K, M, R.chance(0.5) ? d.u0 - 0.25 : d.u1 + 0.25, d.top - 0.1);
    K.box(M.timber, { w: 0.09, h: 0.24, d: 0.018, pos: [d.u0 - 0.16, 1.5, 0.009], color: [1.6, 1.45, 1.2] });
  }
  // continuous pent roof between the floors
  leanTo(K, M, S, { u0: -0.12, u1: W + 0.12, yTop: FL[1] + 0.3, proj: R.range(0.75, 0.9), pitch: R.range(0.35, 0.45), pipe: R.chance(0.5) ? 1 : -1 });
  K.pop();
  // roof sections (canonical frame = world, ridge along x)
  for (let j = 0; j < secs.length; j++) {
    const q = secs[j], other = secs[1 - j];
    const lower = other && q.Hw < other.Hw;
    const ends = [j === 0 || !lower, j === secs.length - 1 || !lower];
    const vo = [j === 0 ? vergeO : lower ? 0 : 0.3, j === secs.length - 1 ? vergeO : lower ? 0 : 0.3];
    const cx = -W / 2 + (q.x0 + q.x1) / 2;
    K.push(new THREE.Matrix4().makeTranslation(cx, 0, 0));
    const ps = [(q.x1 - q.x0) / 2 - 0.3];
    kawaraRoof(K, M, S, { type: 'kiri', ax: (q.x1 - q.x0) / 2, bz: D / 2, Hw: q.Hw, pitch, eaveO, vergeO: vo, ends, pipes: { front: [], back: j === 0 ? [ps[0]] : [-ps[0]] } });
    K.pop();
  }
  // equipment at the back
  K.push(F.back.M);
  for (const u of units) {
    const bu = W - (u.x0 + u.x1) / 2;
    if (R.chance(0.6)) acUnit(K, M, bu + 0.9, 0.12, S, FL[1] + 2.0);
    else if (R.chance(0.6)) propane(K, M, bu + 0.8, S);
  }
  K.pop();
  const obj = K.build('row');
  const box = new THREE.Box3().setFromObject(obj);
  const ents = doors.map((d) => [-W / 2 + (d.u0 + d.u1) / 2, 0, D / 2 + 1.1]);
  obj.userData = { kind: 'row', footprint: { w: W, d: D }, entrance: ents[Math.floor(n / 2)], entrances: ents, units: n, height: box.max.y, extent: ext(box), tris: tris(obj) };
  return obj;
}

// debug: a grid of houses (?model=houseGrid&n=9&seed=1&cols=3), extra params pass through
function houseGrid(opts = {}) {
  const n = num(opts.n, 9), cols = num(opts.cols, 3), sp = num(opts.sp, 17), s0 = num(opts.seed, 1);
  const g = new THREE.Group();
  let total = 0, max = 0, maxSeed = 0;
  for (let i = 0; i < n; i++) {
    const fn = MODELS[str(opts.kind, 'house')];
    const o = fn({ ...opts, seed: s0 + i, debug: 0 });
    o.position.set((i % cols - (cols - 1) / 2) * sp, 0, Math.floor(i / cols) * sp);
    total += o.userData.tris;
    if (o.userData.tris > max) { max = o.userData.tris; maxSeed = s0 + i; }
    g.add(o);
  }
  console.warn('grid tris avg', Math.round(total / n), 'max', max, 'seed', maxSeed);
  return g;
}

// Models (all opts optional; the model viewer passes them as strings):
//   house({ seed, w 5-10, d 5-9, stories 1|2, roof 'kiri'|'yose'|'irimoya', ridge 'x'|'z',
//           wall 'yakisugi'|'lap'|'plaster'|'mixed'|'tin', lit 0..1, front 'street'|'side' })
//   shed({ seed, w, d, wall 'tin'|'boards'|'lap', roof 'lean'|'gable' })
//   coop({ seed, w (default 14), d (default 9), lit })
//   row({ seed, w (total frontage), units (default round(w / 5)), d, lit })
//   houseGrid({ kind, n, cols, sp, seed, ...params }): debug grid for the viewer
// userData: { kind, footprint: {w, d} (walls), entrance: [x, 0, z] (in front of the door),
//             height, extent: [x0, x1, z0, z1] (eaves, porch, equipment), tris }
export const MODELS = { house, shed, coop, row, houseGrid };
