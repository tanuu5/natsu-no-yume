// props: utility poles, overhead wires and street furniture (see index.js for the conventions).
// Every builder takes an opts object (numbers/booleans, or the viewer's query strings).
//
// Utility pole — MODELS.pole(opts), also exported as pole(opts):
//   opts: seed, h (height above ground, default 11.4-12.8 m), transformer, light (security
//   light arm), sleeve (1 = 1.9 m yellow/black guard, 'band' = reflector band), ad (wrapped
//   advertisement), closure / coil (telecom cable box / spare loop), guy (guy wire with its
//   yellow guard: true = towards -x, or a local angle in degrees 1..360 (0 = +x, 90 = +z);
//   off by default), wiresAt ('both' | '+x' | '-x': which side the line continues, set by
//   poleLine). Unset options (except guy) are picked from the seed.
//   Frame: local +x runs along the line (towards the next pole), +z faces the street (lamp
//   arm, number plate, telecom cables), -z is the house side (low-voltage rack); the
//   transformer hangs on the -x side. userData.attach = 8 local wire points, always in this
//   order (userData.attachInfo[i] = { kind, r, sag, color }):
//     0-2  high voltage (6.6 kV) on the top crossarm insulators, z = -0.78, +0.22, +0.78
//     3-5  low voltage on the vertical rack (-z side), top to bottom
//     6-7  telecom cables (thick) on the +z side, upper then lower
//   Connect consecutive poles point i -> point i (keep their local +x pointing the same way
//   along the run, or the wires cross): wires(lineSpans(poleA, poleB)), or build a whole run
//   with poleLine(points, opts). userData.drop = service-drop point (dropSpan), userData.lamp =
//   lamp head position (for an optional light), userData.h = height.
//
// wires(spans, opts): sagging catenary cables between point pairs -> THREE.Group.
// lineSpans(poleA, poleB, { world, kinds }), dropSpan(pole, target), poleLine(points, opts).
//
// Street furniture (one Builder each, <= 3k triangles; built at the origin on y = 0, front +z):
//   vending(color: white|red|blue|#hex, seed, bin), curveMirror(double, turn, r, h, color),
//   postBox(type: round|square), guardrail(len, type: beam|pipe, span, color),
//   streetLamp(type: road|small, h, arm, color), signPole(type: stop|speed|school, h),
//   bicycle(seed, color), laundry(seed, pole: bamboo|steel), bench(len, back, arms, frame, seed),
//   drain(len, grateEvery, seed). Long pieces (guardrail, drain, bench, laundry) run along x,
//   centred on the origin. Demos: poleLine (slope), furniture, variants.
import * as THREE from 'three';
import { Builder } from '../builder.js';
import { materials, texturedMaterial, registerNight, tnoise, tfbm, hashf, clamp01 } from '../lib.js';
import { prep } from '../materials.js';
import { rng } from '../noise.js';

// ---------------------------------------------------------------- helpers
const TAU = Math.PI * 2;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const toV = (p) => (p && p.isVector3 ? p.clone() : v3(p[0], p[1], p[2]));
const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(+v) ? d : +v);
const flag = (v, d) => (v === undefined || v === null || v === '' ? d : !(v === false || v === 0 || v === '0' || v === 'false' || v === 'no' || v === 'off'));
// sRGB hex -> linear rgb triple (vertex-colour tint)
const col = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const scl = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
// canvas text uses the fonts the page loads (OFL, fetched by npm run fonts), system fonts as fallback
const JP = '"Dela Gothic One", "Hiragino Sans", "Noto Sans JP", sans-serif';
const MIN = '"Shippori Mincho B1", "Hiragino Mincho ProN", serif';
const Y_UP = v3(0, 1, 0);

function cnv(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}
function canvasTex(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// Cylinder (6-sided by default, open ends) from point a to point b.
function rod(B, mat, a, b, r, { seg = 6, color = [1, 1, 1], r2 = null, open = true } = {}) {
  const A = toV(a), d = toV(b).sub(A), L = d.length();
  if (L < 1e-6) return;
  const g = new THREE.CylinderGeometry(r2 ?? r, r, L, seg, 1, open);
  g.translate(0, L / 2, 0);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * TAU * r, uv.getY(i) * L);
  const q = new THREE.Quaternion().setFromUnitVectors(Y_UP, d.divideScalar(L));
  B.geo(mat, g, new THREE.Matrix4().compose(A, q, v3(1, 1, 1)), color);
}
function rods(B, mat, pts, r, o) { for (let i = 0; i < pts.length - 1; i++) rod(B, mat, pts[i], pts[i + 1], r, o); }
// Smooth tube through points (Catmull-Rom).
function tube(B, mat, pts, r, { seg = 6, n = null, color = [1, 1, 1], closed = false } = {}) {
  const curve = new THREE.CatmullRomCurve3(pts.map(toV), closed, 'centripetal');
  B.geo(mat, new THREE.TubeGeometry(curve, n ?? Math.max(4, pts.length * 3), r, seg, closed), null, color);
}
// Box spanning a -> b (length), width w, thickness t along `out` (defaults to any perpendicular).
function slab(B, mat, a, b, w, t, { out = null, color = [1, 1, 1] } = {}) {
  const A = toV(a), E = toV(b), Yd = E.clone().sub(A), L = Yd.length();
  if (L < 1e-6) return;
  Yd.divideScalar(L);
  let Z = out ? toV(out) : (Math.abs(Yd.y) < 0.9 ? v3(0, 1, 0) : v3(0, 0, 1));
  Z.addScaledVector(Yd, -Z.dot(Yd)).normalize();
  const X = new THREE.Vector3().crossVectors(Yd, Z);
  const m = new THREE.Matrix4().makeBasis(X, Yd, Z);
  m.setPosition(A.add(E).multiplyScalar(0.5));
  B.box(mat, { w, h: L, d: t, color, matrix: m });
}
// Reversed-winding copy (the back side of a thin open surface), non-indexed.
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
function lathe(B, mat, prof, { seg = 10, pos = [0, 0, 0], rot = null, scale = null, color = [1, 1, 1] } = {}) {
  const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  B.geo(mat, g, Builder.mat({ pos, rot, scale }), color);
}

// Tapered tube surface around the y axis (no caps): radius r0 at y0 -> r1 at y1, rings at
// heights ys, angles a0..a1 (0 = +x, PI/2 = +z). uv: u = u0 + (angle - a0) * uR, v = v0 + (y - y0) * vS.
function frustum({ r0, r1, y0, y1, ys = null, seg = 16, a0 = 0, a1 = TAU, u0 = 0, uR = 1, v0 = 0, vS = 1 }) {
  const rows = ys || [y0, y1], nA = seg + 1;
  const pos = [], nor = [], uv = [], idx = [];
  const slope = (r0 - r1) / (y1 - y0), nl = Math.hypot(1, slope);
  for (const y of rows) {
    const r = r0 + (r1 - r0) * ((y - y0) / (y1 - y0));
    for (let i = 0; i < nA; i++) {
      const a = a0 + (a1 - a0) * (i / seg), c = Math.cos(a), s = Math.sin(a);
      pos.push(r * c, y, r * s);
      nor.push(c / nl, slope / nl, s / nl);
      uv.push(u0 + (a - a0) * uR, v0 + (y - y0) * vS);
    }
  }
  for (let j = 0; j < rows.length - 1; j++) for (let i = 0; i < seg; i++) {
    const p = j * nA + i, q = p + nA;
    idx.push(p, q, p + 1, p + 1, q, q + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function triCount(obj) {
  let n = 0;
  obj.traverse((o) => { if (o.isMesh) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  return n;
}

// ---------------------------------------------------------------- materials
// Centrifugally cast concrete pole: u runs once around the pole, v up (2 m tile).
const POLE_TEX = { n: 512, period: 2, normal: 0.7, fn: (u, v) => {
  const blot = tfbm(u, v, 3, 4, 111, 4);
  const streak = tnoise(u, v, 40, 112, 2) * 0.6 + tnoise(u, v, 96, 113, 5) * 0.4;
  const rain = clamp01(tfbm(u, v, 12, 3, 114, 2) * 1.8 - 0.12);
  const pore = tnoise(u, v, 150, 115, 300) > 0.5 ? 1 : 0;
  const g = 0.66 * (0.95 + blot * 0.1 + streak * 0.035) - rain * 0.05 - pore * 0.06;
  return [g * 0.995, g, g * 0.975, 0.55 + streak * 0.05 - pore * 0.25, 0.8 - rain * 0.06];
} };
// Weathered wooden slats (bench), grain along u.
const PLANK_TEX = { n: 256, period: 1.2, normal: 1.4, fn: (u, v) => {
  const g1 = tnoise(u, v, 2, 201, 36), g2 = tfbm(u, v, 3, 3, 202, 10), g3 = tnoise(u, v, 8, 203, 90);
  const k = 0.82 + g1 * 0.14 + g2 * 0.12 + g3 * 0.05;
  return [0.56 * k, 0.45 * k, 0.33 * k, 0.5 + g1 * 0.15 + g3 * 0.1, 0.82];
} };
// Cotton weave (laundry), 0.2 m tile.
const CLOTH_TEX = { n: 256, period: 0.2, normal: 0.6, fn: (u, v) => {
  const w = 0.5 + 0.25 * Math.sin(u * TAU * 64) * Math.sin(v * TAU * 64);
  const n = tfbm(u, v, 4, 3, 301);
  const k = 0.93 + n * 0.06 + (w - 0.5) * 0.08;
  return [k, k, k * 0.99, w, 0.95];
} };

let PM = null;
function pm() {
  if (PM) return PM;
  const plain = (name, o) => prep(new THREE.MeshStandardMaterial({ name, vertexColors: true, ...o }), null, 'props-' + name);
  PM = {
    pole: texturedMaterial('poleConcrete', POLE_TEX),
    plank: texturedMaterial('plank', PLANK_TEX),
    cloth: texturedMaterial('cloth', CLOTH_TEX, { side: THREE.DoubleSide }),
    porcelain: plain('porcelain', { color: 0xe7e4dd, roughness: 0.2 }),
    galv: plain('galv', { color: 0xa2a7a9, roughness: 0.48, metalness: 0.8 }),
    wire: plain('wire', { color: 0xffffff, roughness: 0.42 }),
    plastic: plain('plastic', { color: 0xffffff, roughness: 0.5 }),
    glassClear: plain('glassClear', { color: 0xffffff, roughness: 0.04, transparent: true, opacity: 0.14, depthWrite: false }),
  };
  PM.glassClear.userData.castShadow = false;
  PM.stripes = prep(new THREE.MeshStandardMaterial({ name: 'stripes', map: canvasTex(stripeCanvas()), vertexColors: true, roughness: 0.5 }), null, 'props-stripes');
  // vending machine lights: faint glow in daylight, bright at dusk / night
  PM.vendLit = glowMat('vendLit', 0.35, 1.0);
  PM.vendGlow = glowMat('vendGlow', 0.7, 0.35);
  PM.vendItem = glowMat('vendItem', 0, 0.14);   // dummies lit by the machine's front lamps at night
  return PM;
}

// Emissive material whose glow is tinted per part by the vertex colour, with an always-on
// base (uGlow) plus the dusk/night boost from registerNight. Optional map (also the glow mask).
function glowMat(name, base, night, map = null) {
  const uGlow = { value: base };
  const m = new THREE.MeshStandardMaterial({ name, vertexColors: true, color: 0xffffff, roughness: 0.35, emissive: 0xffffff, emissiveIntensity: 0 });
  if (map) { m.map = map; m.emissiveMap = map; }
  prep(m, (sh) => {
    sh.uniforms.uGlow = uGlow;
    sh.fragmentShader = 'uniform float uGlow;\n' + sh.fragmentShader
      .replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive + vec3( uGlow );')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;');
  }, 'props-glow-' + name);
  registerNight(m, night);
  m.userData.glow = uGlow;
  return m;
}

// Yellow / black 45-degree stripes (pole protection sleeve); one tile = two stripe periods.
function stripeCanvas() {
  const n = 256, [c, x] = cnv(n, n), img = x.createImageData(n, n);
  const Y = [0.95, 0.76, 0.1], K = [0.08, 0.08, 0.08];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let cov = 0;
    for (let s = 0; s < 4; s++) cov += ((i + j + 0.25 + (s & 1) * 0.5 + (s >> 1) * 0.5) % 128) < 64 ? 0.25 : 0;
    const d = tfbm(i / n, j / n, 5, 3, 121) * 0.14 + tnoise(i / n, j / n, 48, 122) * 0.05 - clamp01(tfbm(i / n, j / n, 3, 3, 123) * 2 - 0.4) * 0.12;
    const o = (j * n + i) * 4;
    for (let k = 0; k < 3; k++) img.data[o + k] = 255 * clamp01((Y[k] * cov + K[k] * (1 - cov)) * (0.95 + d));
    img.data[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return c;
}

const TEXMATS = new Map();
function canvasMat(key, draw, o = {}) {
  if (TEXMATS.has(key)) return TEXMATS.get(key);
  const m = prep(new THREE.MeshStandardMaterial({ name: key, map: canvasTex(draw()), vertexColors: true, roughness: 0.5, ...o }), null, 'props-' + key);
  TEXMATS.set(key, m);
  return m;
}

// ---------------------------------------------------------------- wires
const WIRE_COL = [0.035, 0.035, 0.035];
export const ATTACH = [
  { kind: 'hv', r: 0.0075, sag: 0.016, color: [0.045, 0.045, 0.045] },
  { kind: 'hv', r: 0.0075, sag: 0.016, color: [0.045, 0.045, 0.045] },
  { kind: 'hv', r: 0.0075, sag: 0.016, color: [0.045, 0.045, 0.045] },
  { kind: 'lv', r: 0.0065, sag: 0.02, color: [0.03, 0.03, 0.03] },
  { kind: 'lv', r: 0.0065, sag: 0.021, color: [0.03, 0.03, 0.03] },
  { kind: 'lv', r: 0.0065, sag: 0.022, color: [0.03, 0.03, 0.03] },
  { kind: 'tel', r: 0.013, sag: 0.026, color: [0.022, 0.022, 0.022] },
  { kind: 'tel', r: 0.011, sag: 0.028, color: [0.022, 0.022, 0.022] },
];

// Catenary through a and b whose mid-span sag below the chord is `sag` metres; n segments.
function catenary(a, b, sag, n) {
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz), h = b.y - a.y;
  const pts = [];
  if (L < 1e-3 || sag <= 1e-5) {
    for (let i = 0; i <= n; i++) pts.push(a.clone().lerp(b, i / n));
    return pts;
  }
  const f = (A) => {
    const x0 = L / 2 - A * Math.asinh(h / (2 * A * Math.sinh(L / (2 * A))));
    return { x0, s: h / 2 - A * (Math.cosh((L / 2 - x0) / A) - Math.cosh(x0 / A)) };
  };
  let lo = L / 30, hi = L * 5000;
  for (let i = 0; i < 60; i++) { const m = Math.sqrt(lo * hi); if (f(m).s > sag) lo = m; else hi = m; }
  const A = Math.sqrt(lo * hi), { x0 } = f(A);
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * L;
    pts.push(v3(a.x + dx * (i / n), a.y + A * (Math.cosh((s - x0) / A) - Math.cosh(x0 / A)), a.z + dz * (i / n)));
  }
  return pts;
}

// Append a tube along pts (radius r, `radial` sides, no caps) to acc {pos, nor, col, idx}.
function tubeInto(acc, pts, r, radial, color) {
  const n = pts.length, base = acc.pos.length / 3;
  const chord = pts[n - 1].clone().sub(pts[0]);
  const side = v3(-chord.z, 0, chord.x);
  if (side.lengthSq() < 1e-10) side.set(1, 0, 0); else side.normalize();
  const T = v3(), S = v3(), N = v3(), d = v3();
  for (let i = 0; i < n; i++) {
    T.subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize();
    S.copy(side).addScaledVector(T, -side.dot(T));
    if (S.lengthSq() < 1e-8) S.set(0, 0, 1).addScaledVector(T, -T.z);
    S.normalize();
    N.crossVectors(S, T);
    for (let j = 0; j < radial; j++) {
      const th = (j / radial) * TAU;
      d.copy(S).multiplyScalar(Math.cos(th)).addScaledVector(N, Math.sin(th));
      acc.pos.push(pts[i].x + d.x * r, pts[i].y + d.y * r, pts[i].z + d.z * r);
      acc.nor.push(d.x, d.y, d.z);
      acc.col.push(color[0], color[1], color[2]);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < radial; j++) {
    const a = base + i * radial + j, b = base + i * radial + ((j + 1) % radial);
    acc.idx.push(a, a + radial, b, b, a + radial, b + radial);
  }
}

function wireMesh(spans, opts = {}) {
  const R = rng(Math.round(num(opts.seed, 7)) * 131 + 5);
  const sagR = num(opts.sag, 0.022), jit = num(opts.jitter, 0.25), segLen = num(opts.segLen, 0.75);
  const acc = { pos: [], nor: [], col: [], idx: [] };
  for (const s of spans) {
    const a = toV(s[0]), b = toV(s[1]), o = s[2] || {};
    const L = a.distanceTo(b);
    if (L < 1e-4) continue;
    const r = o.r ?? num(opts.r, 0.008);
    const ratio = (o.sag ?? sagR) * (1 + jit * (R() * 2 - 1));
    const n = Math.max(8, Math.min(96, Math.round(L / segLen)));
    tubeInto(acc, catenary(a, b, ratio * L, n), r, o.radial ?? num(opts.radial, 5), o.color ?? opts.color ?? WIRE_COL);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(acc.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(acc.col, 3));
  g.setIndex(acc.idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  const mesh = new THREE.Mesh(g, pm().wire);
  mesh.name = 'wires';
  mesh.castShadow = flag(opts.shadow, false);
  mesh.receiveShadow = true;
  return mesh;
}

// spans: [[a, b], ...] or [[a, b, { r, sag, color, radial }], ...] with a, b Vector3 or [x, y, z]
// (in the space of the returned group). opts: sag (ratio of span, default 0.022), jitter
// (per-cable sag variation, 0.25), r (default radius 0.008), seed, segLen, radial, shadow.
export function wires(spans, opts = {}) {
  const grp = new THREE.Group();
  grp.name = 'wires';
  if (spans.length) grp.add(wireMesh(spans, opts));
  return grp;
}

// Spans connecting pole a to pole b, point i to point i, in the poles' parent space
// (or world space with { world: true }; call updateMatrixWorld first). kinds: filter, e.g. ['hv', 'tel'].
export function lineSpans(pa, pb, { world = false, kinds = null } = {}) {
  if (!world) { pa.updateMatrix(); pb.updateMatrix(); }
  const ma = world ? pa.matrixWorld : pa.matrix, mb = world ? pb.matrixWorld : pb.matrix;
  const A = pa.userData.attach, Bp = pb.userData.attach, info = pa.userData.attachInfo || ATTACH;
  const out = [];
  for (let k = 0; k < Math.min(A.length, Bp.length); k++) {
    if (kinds && !kinds.includes(info[k].kind)) continue;
    out.push([A[k].clone().applyMatrix4(ma), Bp[k].clone().applyMatrix4(mb), info[k]]);
  }
  return out;
}

// A service drop (引込線) from a pole's lowest low-voltage point to a house anchor, in world
// space (pole.updateMatrixWorld() first): wires(houses.map((h) => dropSpan(pole, h.anchor))).
export function dropSpan(pole, target, { r = 0.005, sag = 0.035 } = {}) {
  return [pole.userData.drop.clone().applyMatrix4(pole.matrixWorld), toV(target), { r, sag, color: [0.03, 0.03, 0.03] }];
}

// A run of poles through ground points [[x, y, z], ...] with all wires connected. Each pole's
// local +x follows the line; opts.side = 1 puts the street (+z) on the right of the direction
// of travel, -1 on the left. opts.pole: options for every pole, opts.each(i) -> per-pole
// options, opts.seed, opts.wires: options for wires().
export function poleLine(points, opts = {}) {
  const grp = new THREE.Group();
  grp.name = 'poleLine';
  const pts = points.map(toV), n = pts.length, poles = [];
  const flip = num(opts.side, 1) < 0 ? Math.PI : 0, seed = Math.round(num(opts.seed, 1));
  for (let i = 0; i < n; i++) {
    const d = pts[Math.min(n - 1, i + 1)].clone().sub(pts[Math.max(0, i - 1)]);
    const ends = n < 2 ? 'both' : i === 0 ? (flip ? '-x' : '+x') : i === n - 1 ? (flip ? '+x' : '-x') : 'both';
    const po = pole({ seed: seed * 101 + i, wiresAt: ends, ...(opts.pole || {}), ...(opts.each ? opts.each(i) : {}) });
    po.position.copy(pts[i]);
    po.rotation.y = Math.atan2(-d.z, d.x) + flip;
    po.updateMatrix();
    grp.add(po);
    poles.push(po);
  }
  const spans = [];
  for (let i = 0; i < n - 1; i++) spans.push(...lineSpans(poles[i], poles[i + 1]));
  grp.add(wires(spans, { seed, ...(opts.wires || {}) }));
  grp.userData.poles = poles;
  return grp;
}

// ---------------------------------------------------------------- utility pole
const INS_HV = [[0.012, 0], [0.072, 0.03], [0.046, 0.05], [0.064, 0.076], [0.042, 0.09], [0.046, 0.116], [0.036, 0.13], [0.03, 0.146], [0.001, 0.15]];
const SPOOL = [[0.007, 0], [0.035, 0.004], [0.024, 0.02], [0.024, 0.05], [0.035, 0.066], [0.007, 0.07]];
const BUSH = [[0.012, 0], [0.04, 0.012], [0.028, 0.035], [0.036, 0.055], [0.022, 0.08], [0.014, 0.12], [0.001, 0.132]];

const PLATE_NAMES = ['浜町', '汐見', '港', '坂上', '宮前', '夏浜'];
function plateMat(no, name) {
  return canvasMat(`plate-${name}-${no}`, () => {
    const [c, x] = cnv(128, 384);
    x.fillStyle = '#eeede6'; x.fillRect(0, 0, 128, 384);
    x.strokeStyle = '#303030'; x.lineWidth = 5; x.strokeRect(6, 6, 116, 372);
    x.fillStyle = '#20589e'; x.beginPath(); x.arc(64, 46, 23, 0, TAU); x.fill();
    x.fillStyle = '#eeede6'; x.beginPath();   // utility-company mark: a small bolt
    [[68, 28], [54, 49], [63, 49], [58, 65], [74, 42], [65, 42]].forEach(([px, py], k) => (k ? x.lineTo(px, py) : x.moveTo(px, py)));
    x.closePath(); x.fill();
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#1b1b1b'; x.font = `700 50px ${JP}`;
    let y = 112;
    for (const ch of name) { x.fillText(ch, 64, y); y += 54; }
    x.font = `700 ${String(no).length > 2 ? 40 : 50}px ${JP}`; x.fillText(String(no), 64, y + 6);
    x.font = `600 30px ${JP}`; x.fillText('左', 64, y + 62);
    return c;
  }, { roughness: 0.4 });
}

const ADS = [
  { bg: '#f3f0e4', band: '#2f6b42', top: '内科・小児科', main: 'なぎさ医院', sub: 'この先100m', ink: '#1d3b82' },
  { bg: '#f7f2e3', band: '#a8262c', top: '海の宿', main: '民宿しおさい', sub: '徒歩三分', ink: '#1b1b1b' },
  { bg: '#eef0ec', band: '#1f4f96', top: 'たばこ・塩・米', main: '浜田商店', sub: 'この先左', ink: '#a8262c' },
];
function adMat(i) {
  const ad = ADS[i % ADS.length];
  return canvasMat('ad-' + (i % ADS.length), () => {
    const [c, x] = cnv(256, 1024);
    x.fillStyle = ad.bg; x.fillRect(0, 0, 256, 1024);
    x.fillStyle = ad.band; x.fillRect(0, 0, 256, 200);
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#ffffff'; x.font = `600 30px ${JP}`;
    const tops = [...ad.top];
    tops.forEach((ch, k) => x.fillText(ch, 128, 100 + (k - (tops.length - 1) / 2) * 30));
    x.fillStyle = ad.ink; x.font = `600 ${ad.main.length > 5 ? 108 : 124}px ${MIN}`;
    const mains = [...ad.main], step = 690 / mains.length;
    mains.forEach((ch, k) => x.fillText(ch, 128, 215 + step * (k + 0.5)));
    x.fillStyle = ad.band; x.fillRect(0, 925, 256, 99);
    x.fillStyle = '#ffffff'; x.font = `600 40px ${JP}`; x.fillText(ad.sub, 128, 975);
    // light weathering
    for (let k = 0; k < 900; k++) {
      const px = hashf(k, 1) * 256, py = hashf(k, 2) * 1024;
      x.fillStyle = `rgba(90,80,60,${0.05 + 0.08 * hashf(k, 3)})`;
      x.fillRect(px, py, 1 + hashf(k, 4) * 2, 2 + hashf(k, 5) * 10);
    }
    return c;
  }, { roughness: 0.45 });
}

export function pole(opts = {}) {
  const M = materials(), P = pm();
  const seed = Math.round(num(opts.seed, 1));
  const R = rng(seed * 7919 + 17);
  const rv = Array.from({ length: 16 }, () => R());
  const h = num(opts.h, 11.4 + rv[0] * 1.4);
  const hasX = flag(opts.transformer, rv[1] < 0.3);
  const hasLight = flag(opts.light, rv[2] < 0.45);
  const sleeve = opts.sleeve === 'band' ? 'band' : flag(opts.sleeve, rv[3] < 0.3) ? 'full' : 'none';
  const hasAd = flag(opts.ad, rv[4] < 0.3);
  const hasCoil = flag(opts.coil, rv[5] < 0.3);
  const hasBox = flag(opts.closure, rv[6] < 0.35);
  // which side(s) the wires leave on: 'both' (default), '+x' (first pole of a run), '-x' (last)
  const wiresAt = opts.wiresAt === '+x' || opts.wiresAt === '-x' ? opts.wiresAt : 'both';
  const sideBox = wiresAt === '-x' ? -1 : 1, sideCoil = wiresAt === '+x' ? 1 : -1;
  // guy wire: true -> towards -x (away from the line), or a local angle in degrees (0 = +x, 90 = +z)
  const guy = opts.guy === undefined || opts.guy === null || opts.guy === '' || !flag(opts.guy, false) ? null
    : (opts.guy === true || opts.guy === '1' || opts.guy === 1 || opts.guy === 'true') ? 180 : num(opts.guy, 180);
  const B = new Builder(), galv = P.galv;
  const rt = 0.095, rb = rt + h / 150, rAt = (y) => rb + (rt - rb) * (y / h);
  const onPole = (y, a, off = 0) => { const r = rAt(y) + off; return v3(r * Math.cos(a), y, r * Math.sin(a)); };
  const band = (y, hh = 0.045) => B.cyl(galv, { r: rAt(y) + 0.006, h: hh, seg: 14, pos: [0, y, 0], open: true });
  const attach = new Array(8), spans = [];

  // key heights
  const yA = h - 0.42;                         // HV crossarm
  const yC = yA - 0.72;                        // cutout arm (transformer poles)
  const yX = yA - 2.05;                        // transformer centre
  const yL = h - 3.55;                         // LV rack, top spool
  const yT = Math.min(5.6, yL - 1.6), yT2 = yT - 0.42;   // telecom cables
  const yLamp = yT2 - 0.72;                    // lamp arm root
  const ySl = sleeve === 'full' ? 1.9 : 0;
  const yPl = sleeve === 'full' ? 2.02 : 1.62; // number plate bottom
  const yAd0 = yPl + 0.42, yAd1 = yAd0 + 1.3;  // wrapped advertisement

  // rust / grime streak sources below steel bands: [height, angle]
  const srcs = [[yA, 0], [yA - 0.55, 0], [yL + 0.1, -Math.PI / 2], [yL - 0.62, -Math.PI / 2], [yT, Math.PI / 2], [yT2, Math.PI / 2]];
  if (hasX) srcs.push([yC, 0], [yX + 0.25, Math.PI], [yX - 0.25, Math.PI]);
  if (hasLight) srcs.push([yLamp, Math.PI / 2]);
  // plus a few rain-washed grime streaks from high up: [height, angle, length]
  const grime = [0, 1, 2, 3, 4].map((k) => [h - 0.3 - R() * 3.5, R() * TAU, 1.5 + R() * 3]);

  // ---- shaft
  const ys = [0, 0.03, 0.1, 0.22, 0.4, 0.65, 1.0, 1.45, 2.0, 2.6];
  for (let y = 3.3; y < h - 0.2; y += 0.9) ys.push(y);
  for (const [y] of srcs) ys.push(y - 0.03, y - 0.45, y - 1.3);
  ys.push(h);
  const rows = [];
  for (const y of ys.filter((y) => y >= 0 && y <= h).sort((a, b) => a - b)) if (!rows.length || y - rows[rows.length - 1] > 0.06 || y === h) rows.push(y);
  if (rows[rows.length - 2] > h - 0.04) rows.splice(rows.length - 2, 1);
  B.geo(P.pole, frustum({ r0: rb, r1: rt, y0: 0, y1: h, ys: rows, seg: 16, a0: -Math.PI / 2, a1: 1.5 * Math.PI, uR: 2 / TAU, vS: 1 }));
  B.cyl(P.pole, { r: rt + 0.002, r2: rt - 0.015, h: 0.035, seg: 16, pos: [0, h + 0.0175, 0] });

  // ---- HV crossarm (steel angle on the +x face), arm ties, pin insulators
  const rA = rAt(yA);
  B.box(galv, { w: 0.075, h: 0.007, d: 1.8, pos: [rA + 0.0375, yA + 0.034, 0] });
  B.box(galv, { w: 0.007, h: 0.075, d: 1.8, pos: [rA + 0.004, yA, 0] });
  band(yA, 0.06);
  const yTie = yA - 0.55;
  band(yTie, 0.04);
  for (const s of [-1, 1]) slab(B, galv, [rA + 0.02, yA - 0.035, s * 0.56], [rAt(yTie) + 0.012, yTie, s * 0.05], 0.032, 0.007, { out: [1, 0, 0] });
  const zHV = [-0.78, 0.22, 0.78], yPin = yA + 0.0375;
  zHV.forEach((z, k) => {
    B.cyl(galv, { r: 0.011, h: 0.05, seg: 6, pos: [rA + 0.042, yPin + 0.025, z] });
    B.cyl(galv, { r: 0.024, h: 0.012, seg: 6, pos: [rA + 0.042, yPin + 0.006, z] });
    lathe(B, P.porcelain, INS_HV, { seg: 8, pos: [rA + 0.042, yPin + 0.035, z] });
    attach[k] = v3(rA + 0.042, yPin + 0.035 + 0.152, z);
  });

  // ---- LV rack on the -z side: strap, three clevises with spools
  const rL = rAt(yL), zR = -(rL + 0.012);
  B.box(galv, { w: 0.05, h: 0.86, d: 0.01, pos: [0, yL - 0.26, zR] });
  band(yL + 0.1, 0.035); band(yL - 0.62, 0.035);
  for (let k = 0; k < 3; k++) {
    const y = yL - k * 0.26;
    B.box(galv, { w: 0.046, h: 0.008, d: 0.12, pos: [0, y + 0.041, zR - 0.058] });
    B.box(galv, { w: 0.046, h: 0.008, d: 0.12, pos: [0, y - 0.041, zR - 0.058] });
    B.cyl(galv, { r: 0.006, h: 0.09, seg: 5, pos: [0, y, zR - 0.085] });
    lathe(B, P.porcelain, SPOOL, { seg: 8, pos: [0, y - 0.035, zR - 0.085] });
    attach[3 + k] = v3(0, y, zR - 0.085 - 0.03);
  }

  // ---- telecom: clamp bands with brackets on the +z side
  [[6, yT], [7, yT2]].forEach(([k, y]) => {
    const r = rAt(y);
    band(y, 0.04);
    B.box(galv, { w: 0.04, h: 0.03, d: 0.1, pos: [0, y, r + 0.05] });
    B.box(galv, { w: 0.05, h: 0.07, d: 0.012, pos: [0, y - 0.025, r + 0.1] });
    attach[k] = v3(0, y - 0.05, r + 0.1);
  });
  if (hasBox) {   // cable closure beside the pole on the upper telecom cable
    const zc = rAt(yT) + 0.1, yc = yT - 0.12, xc = sideBox * (0.85 + rv[7] * 0.4);
    B.cyl(M.rubber, { r: 0.072, h: 0.5, seg: 10, pos: [xc, yc, zc], rot: [0, 0, Math.PI / 2] });
    for (const s of [-1, 1]) B.cyl(M.rubber, { r: 0.072, r2: 0.022, h: 0.08, seg: 10, pos: [xc + s * 0.29, yc, zc], rot: [0, 0, -s * Math.PI / 2] });
    B.box(galv, { w: 0.03, h: 0.1, d: 0.02, pos: [xc, yT - 0.06, zc] });
  }
  if (hasCoil) {  // spare-cable loop hanging on the lower telecom cable
    const zc = rAt(yT2) + 0.1, xc = sideCoil * (0.75 + rv[8] * 0.3);
    B.geo(M.rubber, new THREE.TorusGeometry(0.25, 0.011, 4, 22), Builder.mat({ pos: [xc, yT2 - 0.05 - 0.26 - 0.04, zc], rot: [0, rv[9] * 0.3 - 0.15, 0] }));
  }

  // ---- street light (security light) on the +z side
  let lampPos = null;
  if (hasLight) {
    const rl = rAt(yLamp);
    band(yLamp, 0.05); band(yLamp + 0.2, 0.04);
    const arm = [[0, yLamp, rl], [0, yLamp + 0.2, rl + 0.08], [0, yLamp + 0.4, rl + 0.4], [0, yLamp + 0.47, rl + 0.78]];
    tube(B, galv, arm, 0.021, { seg: 6, n: 10 });
    const head = Builder.mat({ pos: [0, yLamp + 0.46, rl + 0.93], rot: [-0.08, 0, 0] });
    B.box(P.plastic, { w: 0.13, h: 0.065, d: 0.36, color: col('#d9dbd8'), matrix: head });
    B.box(P.plastic, { w: 0.11, h: 0.02, d: 0.34, pos: [0, 0.035, 0], color: col('#b9bcba'), matrix: head });
    B.box(M.lamp, { w: 0.1, h: 0.01, d: 0.3, pos: [0, -0.035, 0], matrix: head });
    lampPos = v3(0, yLamp + 0.4, rl + 0.93);
  }

  // ---- transformer (-x side): hanger, tank, bushings, cutouts and drop wires
  if (hasX) {
    const rX = rAt(yX), xT = -(rX + 0.31);
    for (const dy of [0.25, -0.25]) {
      band(yX + dy, 0.05);
      B.box(galv, { w: 0.12, h: 0.05, d: 0.06, pos: [-(rX + 0.06), yX + dy, 0] });
    }
    B.box(galv, { w: 0.02, h: 0.72, d: 0.13, pos: [-(rX + 0.1), yX, 0] });
    const grey = col('#8e9598');
    B.cyl(M.paint, { r: 0.23, h: 0.8, seg: 16, pos: [xT, yX, 0], color: grey });
    B.cyl(M.paint, { r: 0.245, h: 0.045, seg: 16, pos: [xT, yX + 0.42, 0], color: grey });
    B.cyl(M.paint, { r: 0.24, r2: 0.11, h: 0.07, seg: 16, pos: [xT, yX + 0.477, 0], color: grey });
    B.cyl(M.paint, { r: 0.236, h: 0.03, seg: 16, pos: [xT, yX - 0.412, 0], color: scl(grey, 0.75) });
    for (const dy of [-0.2, 0.2]) B.cyl(M.paint, { r: 0.236, h: 0.025, seg: 16, pos: [xT, yX + dy, 0], color: scl(grey, 0.92) });
    B.box(M.metal, { w: 0.1, h: 0.07, d: 0.004, pos: [xT, yX - 0.05, -0.231] });
    const bush = [-0.09, 0.09].map((z) => {
      lathe(B, P.porcelain, BUSH, { seg: 8, pos: [xT + 0.05, yX + 0.49, z] });
      return v3(xT + 0.05, yX + 0.49 + 0.13, z);
    });
    const lvb = [0, 1, 2].map((k) => {
      const x = xT + (k - 1) * 0.1;
      B.cyl(M.rubber, { r: 0.02, h: 0.07, seg: 8, pos: [x, yX + 0.22, -0.255], rot: [Math.PI / 2, 0, 0] });
      return v3(x, yX + 0.22, -0.29);
    });
    // cutout arm (+x face) with two cutouts hanging in front of it
    const rC = rAt(yC);
    B.box(galv, { w: 0.06, h: 0.006, d: 1.1, pos: [rC + 0.03, yC + 0.028, -0.08] });
    B.box(galv, { w: 0.006, h: 0.06, d: 1.1, pos: [rC + 0.004, yC, -0.08] });
    band(yC, 0.05);
    [[-0.45, 0], [0.3, 1]].forEach(([z, k]) => {
      const x = rC + 0.12;
      B.box(P.porcelain, { w: 0.09, h: 0.26, d: 0.11, pos: [x, yC - 0.02, z] });
      B.box(P.porcelain, { w: 0.1, h: 0.05, d: 0.12, pos: [x + 0.005, yC + 0.08, z] });
      B.box(M.rubber, { w: 0.02, h: 0.1, d: 0.03, pos: [x + 0.055, yC - 0.02, z] });
      B.box(galv, { w: 0.07, h: 0.03, d: 0.03, pos: [rC + 0.055, yC + 0.01, z] });
      const hv = attach[k];
      spans.push([v3(hv.x + sideBox * 0.3, hv.y - 0.012, hv.z), v3(x, yC + 0.12, z), { r: 0.006, sag: 0.1 }]);
      spans.push([v3(x, yC - 0.16, z), bush[k], { r: 0.006, sag: 0.08 }]);
    });
    // secondary drops to the LV rack and the ground wire from the tank
    lvb.forEach((p, k) => spans.push([p, attach[3 + k].clone().add(v3(-0.02, 0.0, -0.01)), { r: 0.007, sag: 0.03 }]));
    rod(B, P.wire, [xT + 0.12, yX - 0.42, -0.12], onPole(yX - 0.62, Math.PI + 0.35, 0.008), 0.0045, { seg: 4, color: col('#3f7a4a') });
  }

  // ---- ground wire down the pole (-x side) with its protective moulding
  {
    const aG = Math.PI + 0.35, gTop = hasX ? yX - 0.62 : yL - 0.8, green = col('#3f7a4a');
    rod(B, P.wire, onPole(0.05, aG, 0.008), onPole(gTop, aG, 0.008), 0.0045, { seg: 4, color: green });
    for (let y = 2.8; y < gTop - 0.3; y += 1.3) slab(B, galv, onPole(y - 0.015, aG, 0.009), onPole(y + 0.015, aG, 0.009), 0.03, 0.006, { out: [Math.cos(aG), 0, Math.sin(aG)] });
    const off = sleeve === 'full' ? 0.024 : 0.014;
    slab(B, P.plastic, onPole(0, aG, off), onPole(2.3, aG, off), 0.05, 0.018, { out: [Math.cos(aG), 0, Math.sin(aG)], color: col('#8a9a8c') });
  }

  // ---- guy wire (支線) with its yellow guard and ground anchor
  if (guy !== null) {
    const ga = (guy * Math.PI) / 180, dir = v3(Math.cos(ga), 0, Math.sin(ga)), yg = yA - 0.35, dist = Math.min(4.5, yg * 0.42);
    const top = onPole(yg, ga, 0.012), foot = dir.clone().multiplyScalar(dist).setY(0.05);
    band(yg, 0.05);
    B.box(galv, { w: 0.05, h: 0.06, d: 0.05, pos: top.toArray(), rotY: -ga });
    rod(B, P.galv, top, foot, 0.0065, { seg: 5 });
    const d = foot.clone().sub(top).normalize();
    const g0 = foot.clone().addScaledVector(d, -0.05), g1 = foot.clone().addScaledVector(d, -2.1 / -d.y);
    rod(B, P.plastic, g0, g1, 0.034, { seg: 10, color: col('#f2c21b'), open: false });
    for (let k = 1; k < 4; k++) { const q = g0.clone().lerp(g1, k / 4); rod(B, P.plastic, q.clone().addScaledVector(d, -0.01), q.clone().addScaledVector(d, 0.01), 0.036, { seg: 10, color: [0.03, 0.03, 0.03], open: false }); }
    B.cyl(M.concrete, { r: 0.12, h: 0.06, seg: 10, pos: [foot.x, 0.03, foot.z] });
  }

  // ---- step bolts in two staggered columns
  for (let y = 2.55, i = 0; y < yA - 0.75; y += 0.225, i++) {
    const a = i % 2 ? Math.PI - 0.26 : -0.26;
    if (i % 2 && hasX && Math.abs(y - yX) < 0.75) continue;
    if (!(i % 2) && Math.abs(y - yC) < 0.25 && hasX) continue;
    rod(B, galv, onPole(y, a, -0.02), onPole(y + 0.02, a, 0.17), 0.0085, { seg: 5 });
  }

  // ---- protection sleeve / reflector band, number plate, wrapped advertisement
  if (sleeve === 'full') {
    const C = TAU * (rAt(0.95) + 0.008), K = Math.max(1, Math.round(C / 0.42));
    B.geo(P.stripes, frustum({ r0: rb + 0.008, r1: rAt(ySl) + 0.008, y0: 0, y1: ySl, ys: [0, 0.5, 1.0, 1.5, ySl], seg: 20, a0: -Math.PI / 2, a1: 1.5 * Math.PI, uR: K / TAU, vS: K / C }));
    B.cyl(P.plastic, { r: rAt(ySl) + 0.012, h: 0.025, seg: 20, pos: [0, ySl, 0], color: [0.03, 0.03, 0.03] });
  } else if (sleeve === 'band') {
    const r0 = rAt(1.45) + 0.004, r1 = rAt(1.85) + 0.004;
    B.geo(P.stripes, frustum({ r0, r1, y0: 1.45, y1: 1.85, seg: 10, a0: Math.PI / 2 - 1.1, a1: Math.PI / 2 + 1.1, uR: r0 / 0.4, vS: 1 / 0.4 }));
  }
  {
    const rP = rAt(yPl) + 0.01;   // clear of the (tapered) bands behind it
    B.box(galv, { w: 0.108, h: 0.31, d: 0.004, pos: [0, yPl + 0.15, rP] });
    B.quad(plateMat(1 + ((seed * 37) % 97), PLATE_NAMES[seed % PLATE_NAMES.length]),
      [-0.05, yPl + 0.005, rP + 0.0025], [0.05, yPl + 0.005, rP + 0.0025], [0.05, yPl + 0.295, rP + 0.0025], [-0.05, yPl + 0.295, rP + 0.0025],
      { uv: [[0, 0], [1, 0], [1, 1], [0, 1]] });
    band(yPl + 0.04, 0.012); band(yPl + 0.26, 0.012);
  }
  if (hasAd) {
    const a0 = Math.PI / 2 - 1.0, a1 = Math.PI / 2 + 1.0;
    B.geo(adMat(seed), frustum({ r0: rAt(yAd0) + 0.012, r1: rAt(yAd1) + 0.012, y0: yAd0, y1: yAd1, seg: 10, a0, a1, u0: 1, uR: -1 / (a1 - a0), vS: 1 / (yAd1 - yAd0) }));
    for (const y of [yAd0 + 0.1, yAd1 - 0.1]) band(y, 0.015);
  }

  // ---- build, then dirt / rust streaks in the shaft's vertex colours
  const g = B.build({ name: 'pole' });
  const shaft = g.children.find((m) => m.material === P.pole);
  if (shaft) {
    const pos = shaft.geometry.attributes.position, c = shaft.geometry.attributes.color;
    const rust = [0.2, 0.34, 0.48];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), a = Math.atan2(z, x);
      const gnd = Math.exp(-y / 0.3) * 0.4 + Math.exp(-y / 1.1) * 0.12;
      let k = [1 - gnd, 1 - gnd * 0.94, 1 - gnd * 1.02];
      for (const [ys0, as] of srcs) {
        if (y > ys0 + 0.01) continue;
        const da = Math.atan2(Math.sin(a - as), Math.cos(a - as));
        const s = 0.55 * Math.exp(-((da / 0.3) ** 2)) * Math.exp(-(ys0 - y) / 0.7);
        k = [k[0] * (1 - s * rust[0]), k[1] * (1 - s * rust[1]), k[2] * (1 - s * rust[2])];
      }
      for (const [ys0, as, len] of grime) {
        if (y > ys0) continue;
        const da = Math.atan2(Math.sin(a - as), Math.cos(a - as));
        const s = 0.16 * Math.exp(-((da / 0.22) ** 2)) * Math.exp(-(ys0 - y) / len);
        k = k.map((v) => v * (1 - s));
      }
      const top = 1 - Math.exp(-(h - y) / 1.2) * 0.1;
      const mottle = 0.96 + 0.04 * Math.sin(y * 2.3 + seed) * Math.sin(a * 3 + y);
      c.setXYZ(i, k[0] * top * mottle, k[1] * top * mottle, k[2] * top * mottle);
    }
    c.needsUpdate = true;
  }
  if (spans.length) g.add(wireMesh(spans, { seed, jitter: 0.1 }));
  g.userData.attach = attach;
  g.userData.attachInfo = ATTACH;
  g.userData.drop = attach[5].clone();
  g.userData.lamp = lampPos;
  g.userData.h = h;
  return g;
}

// ---------------------------------------------------------------- vending machine
const VEND = {
  red: { body: '#c3171d', side: '#b3151b', accent: '#ffffff', panel: '#d8272c' },
  blue: { body: '#1d4f9e', side: '#1b4890', accent: '#ffffff', panel: '#2e67c2' },
  white: { body: '#ecece6', side: '#e4e4de', accent: '#1f63b8', panel: '#2c78c8' },
};
const DRINKS = ['#3b2418', '#141416', '#c89a5a', '#9a1418', '#2f8a33', '#8cc43c', '#d8ecf8', '#4aa3e8', '#1e56d0', '#f2f4f8',
  '#f58a0f', '#f7cf1c', '#c4101c', '#3cc0ea', '#e8eef8', '#6b3d1e', '#e2457a', '#138a62', '#7a2a8c', '#f06a2a'];

function vendHeaderMat(key, s) {
  const k = 'vhead-' + key;
  if (TEXMATS.has(k)) return TEXMATS.get(k);
  const [c, x] = cnv(512, 64);
  x.fillStyle = s.panel; x.fillRect(0, 0, 512, 64);
  x.fillStyle = 'rgba(255,255,255,0.9)';
  x.beginPath(); x.moveTo(0, 44);
  for (let i = 0; i <= 512; i += 8) x.lineTo(i, 40 + 6 * Math.sin(i / 40));
  x.lineTo(512, 64); x.lineTo(0, 64); x.fill();
  x.fillStyle = '#ffffff'; x.font = `800 30px ${JP}`; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('つめたい', 256, 24);
  TEXMATS.set(k, glowMat(k, 0.4, 0.45, canvasTex(c)));
  return TEXMATS.get(k);
}
function vendDoorMat(key, s) {
  return canvasMat('vdoor-' + key, () => {
    const [c, x] = cnv(256, 256);
    x.fillStyle = s.body; x.fillRect(0, 0, 256, 256);
    x.fillStyle = s.panel; x.fillRect(0, 150, 256, 106);
    x.fillStyle = 'rgba(255,255,255,0.85)'; x.fillRect(0, 138, 256, 10);
    for (let k = 0; k < 14; k++) {
      x.beginPath(); x.arc(hashf(k, 7) * 256, 160 + hashf(k, 8) * 90, 4 + hashf(k, 9) * 14, 0, TAU);
      x.fillStyle = `rgba(255,255,255,${0.25 + 0.3 * hashf(k, 10)})`; x.fill();
    }
    return c;
  }, { roughness: 0.35 });
}

function vending(opts = {}) {
  const M = materials(), P = pm();
  const seed = Math.round(num(opts.seed, 1)), R = rng(seed * 313 + 7);
  const name = VEND[opts.color] ? opts.color : ['white', 'red', 'blue'][seed % 3];
  let s = VEND[name];
  if (typeof opts.color === 'string' && opts.color[0] === '#') s = { body: opts.color, side: opts.color, accent: '#ffffff', panel: opts.color };
  const key = VEND[opts.color] || !opts.color ? name : opts.color;
  const body = col(s.body), side = col(s.side);
  const B = new Builder();
  const W = 1.0, H = 1.83, zf = 0.36, zc = 0.2, dd = zf - zc;
  // cabinet (front face at zc) and the door block in front of it (zc..zf) around the display
  B.box(M.darkMetal, { w: W - 0.04, h: 0.06, d: 0.66, pos: [0, 0.03, 0] });
  B.box(M.paint, { w: W, h: H - 0.06, d: zc + 0.36, pos: [0, 0.06 + (H - 0.06) / 2, (zc - 0.36) / 2], color: side });
  const door = (x0, x1, y0, y1, c = body) => B.box(M.paint, { w: x1 - x0, h: y1 - y0, d: dd, pos: [(x0 + x1) / 2, (y0 + y1) / 2, (zc + zf) / 2], color: c });
  const rowY = [0.98, 1.215, 1.45], xL = -0.47, xR = 0.25;
  door(-0.5, xL, 0.96, 1.7); door(xR, 0.5, 0.96, 1.7);
  door(xL, xR, 1.685, 1.7);
  door(-0.5, 0.5, 0.06, 0.96);
  B.quad(vendDoorMat(key, s), [-0.5, 0.36, zf + 0.001], [0.5, 0.36, zf + 0.001], [0.5, 0.96, zf + 0.001], [-0.5, 0.96, zf + 0.001], { uv: [[0, 0], [1, 0], [1, 1], [0, 1]] });
  // lit header
  door(-0.5, 0.5, 1.7, H);
  B.quad(vendHeaderMat(key, s), [-0.49, 1.71, zf + 0.001], [0.49, 1.71, zf + 0.001], [0.49, 1.82, zf + 0.001], [-0.49, 1.82, zf + 0.001], { uv: [[0, 0], [1, 0], [1, 1], [0, 1]] });
  // display: three rows of dummies on shelves in front of a backlit panel, behind glass;
  // price displays and buttons on the bars below each row
  B.box(PM.vendLit, { w: xR - xL, h: 0.72, d: 0.01, pos: [(xL + xR) / 2, 1.33, zc + 0.005], color: [0.95, 0.97, 1] });
  const cold = col('#2f7fe0'), hot = col('#e0352b');
  rowY.forEach((y0, r) => {
    door(xL, xR, y0, y0 + 0.04, scl(body, 0.95));
    B.box(P.plastic, { w: xR - xL, h: 0.012, d: dd - 0.01, pos: [(xL + xR) / 2, y0 + 0.046, (zc + zf) / 2], color: [0.82, 0.83, 0.84] });
    B.quad(P.glassClear, [xL, y0 + 0.04, zf - 0.008], [xR, y0 + 0.04, zf - 0.008], [xR, y0 + 0.235, zf - 0.008], [xL, y0 + 0.235, zf - 0.008]);
    for (let i = 0; i < 8; i++) {
      const x = xL + 0.045 + i * 0.09, yb = y0 + 0.052, z = zc + 0.08;
      const c = col(DRINKS[Math.floor(R() * DRINKS.length)]);
      const I = PM.vendItem;
      if (r === 2 || (r === 1 && R() < 0.5)) {   // can
        B.cyl(I, { r: 0.031, h: 0.118, seg: 8, pos: [x, yb + 0.059, z], color: c });
      } else {                                    // PET bottle
        B.cyl(I, { r: 0.033, h: 0.13, seg: 8, pos: [x, yb + 0.065, z], color: c, open: true });
        B.cyl(I, { r: 0.033, r2: 0.014, h: 0.04, seg: 8, pos: [x, yb + 0.15, z], color: [0.8, 0.86, 0.88], open: true });
        B.cyl(I, { r: 0.015, h: 0.02, seg: 6, pos: [x, yb + 0.18, z], color: col(R() < 0.5 ? '#f4f4f4' : DRINKS[Math.floor(R() * DRINKS.length)]) });
      }
      B.box(PM.vendGlow, { w: 0.05, h: 0.012, d: 0.004, pos: [x, y0 + 0.027, zf + 0.002], color: [1, 0.95, 0.85] });
      B.box(PM.vendGlow, { w: 0.045, h: 0.011, d: 0.008, pos: [x, y0 + 0.01, zf + 0.004], color: (r === 0 && i > 5) ? hot : cold });
    }
  });
  // control column: coin slot, bill slot, display, reader, change return
  const silver = [0.55, 0.56, 0.57];
  B.box(P.plastic, { w: 0.2, h: 0.52, d: 0.006, pos: [0.375, 1.33, zf + 0.003], color: silver });
  B.box(M.darkMetal, { w: 0.012, h: 0.038, d: 0.004, pos: [0.33, 1.47, zf + 0.007] });
  B.box(M.metal, { w: 0.032, h: 0.064, d: 0.005, pos: [0.33, 1.47, zf + 0.0045] });
  B.box(P.plastic, { w: 0.03, h: 0.012, d: 0.02, pos: [0.42, 1.47, zf + 0.012], color: [0.7, 0.7, 0.7] });
  B.box(PM.vendGlow, { w: 0.1, h: 0.03, d: 0.004, pos: [0.39, 1.35, zf + 0.006], color: [0.3, 0.9, 0.4] });
  B.box(M.darkMetal, { w: 0.085, h: 0.009, d: 0.004, pos: [0.39, 1.35, zf + 0.0085] });
  B.box(M.darkMetal, { w: 0.09, h: 0.035, d: 0.005, pos: [0.375, 1.56, zf + 0.006] });
  B.box(PM.vendGlow, { w: 0.07, h: 0.018, d: 0.004, pos: [0.375, 1.56, zf + 0.008], color: [1, 0.3, 0.1] });
  B.box(P.plastic, { w: 0.1, h: 0.08, d: 0.016, pos: [0.39, 1.2, zf + 0.011], color: [0.25, 0.26, 0.28] });
  B.box(PM.vendGlow, { w: 0.06, h: 0.006, d: 0.004, pos: [0.39, 1.225, zf + 0.02], color: [0.2, 0.5, 1] });
  B.box(P.plastic, { w: 0.15, h: 0.1, d: 0.008, pos: [0.375, 0.74, zf + 0.004], color: silver });
  B.box(M.darkMetal, { w: 0.12, h: 0.07, d: 0.004, pos: [0.375, 0.74, zf + 0.009] });
  // product outlet with its flap
  B.box(P.plastic, { w: 0.66, h: 0.26, d: 0.012, pos: [-0.12, 0.24, zf + 0.004], color: [0.18, 0.18, 0.19] });
  B.box(M.darkMetal, { w: 0.6, h: 0.2, d: 0.004, pos: [-0.12, 0.24, zf + 0.011] });
  B.box(P.plastic, { w: 0.58, h: 0.17, d: 0.006, pos: [-0.12, 0.245, zf + 0.018], rot: [-0.12, 0, 0], color: [0.08, 0.09, 0.1] });
  // recycle bin beside the machine
  if (flag(opts.bin, true)) {
    const bc = col(name === 'white' ? '#e6e6e0' : s.body), x = W / 2 + 0.24;
    B.box(P.plastic, { w: 0.42, h: 0.8, d: 0.36, pos: [x, 0.4, zf - 0.18], color: bc });
    B.box(P.plastic, { w: 0.44, h: 0.03, d: 0.38, pos: [x, 0.815, zf - 0.18], color: scl(bc, 0.9) });
    for (const dx of [-0.1, 0.1]) {
      B.cyl(M.darkMetal, { r: 0.05, h: 0.01, seg: 12, pos: [x + dx, 0.66, zf + 0.003], rot: [Math.PI / 2, 0, 0] });
      B.box(P.plastic, { w: 0.12, h: 0.04, d: 0.004, pos: [x + dx, 0.56, zf + 0.002], color: dx < 0 ? col('#2f7fe0') : col('#2f9e57') });
    }
  }
  const g = B.build({ name: 'vending' });
  g.userData.light = { pos: v3(-0.1, 1.4, 0.7), color: 0xe8f0ff, intensity: 1 };  // hint for an optional point light
  return g;
}

// ---------------------------------------------------------------- curve mirror
// The sky IBL has no street in its lower half, so a true metal mirror reads black: paint a
// wide-angle reflection of a street instead (sky, roofs, walls, the road curving away) and
// give it a glossy dielectric finish so the real sky still glints on it.
function mirrorFaceMat() {
  return canvasMat('mirror-face', () => {
    const n = 256, [c, x] = cnv(n, n), img = x.createImageData(n, n);
    const mix = (p, q, t) => p.map((v, i) => v + (q[i] - v) * t);
    // a little street seen in the mirror: sky, roofs and walls on both sides, a pole, the road
    const scene = (X, Y) => {
      const hz = 0.08;
      if (Y < hz) {
        let c0 = mix([0.36, 0.55, 0.8], [0.86, 0.9, 0.92], clamp01((Y + 1.2) / 1.3));
        const cl = tfbm((X + 3) / 3, (Y + 3) / 3, 4, 3, 401);
        c0 = mix(c0, [0.95, 0.95, 0.95], clamp01(cl * 3 - 0.2) * 0.8);
        const side = Math.abs(X), k = Math.floor((X + 3) * 2.6), fx = ((X + 3) * 2.6) % 1;
        if (Y > hz - 0.2 - 0.08 * Math.sin(X * 2.5 + 1) - 0.03 * tnoise(X, 0, 8, 403)) c0 = [0.3, 0.4, 0.28];
        if (side > 0.14) {
          const wall = hz - (0.05 + 0.08 * hashf(k, 11) + 0.22 * (side - 0.14));
          const roof = wall - 0.05 - 0.04 * (0.5 - Math.abs(fx - 0.5)) * 2;
          if (Y > roof) {
            c0 = Y < wall ? [0.22, 0.23, 0.26] : (hashf(k, 12) < 0.5 ? [0.66, 0.63, 0.57] : [0.4, 0.33, 0.27]);
            if (Y > wall + 0.02 && Y < hz - 0.015 && hashf(k, 13) < 0.7 && Math.abs(fx - 0.5) < 0.22) c0 = [0.2, 0.22, 0.24];
          }
        }
        if (Math.abs(X - 0.34) < 0.012 && Y > -0.7) c0 = [0.5, 0.5, 0.48];
        if (Math.abs(Y + 0.55 + X * 0.1) < 0.004 && X > 0.34) c0 = [0.1, 0.1, 0.1];
        return c0;
      }
      const d = Y - hz, roadW = 0.05 + d * 1.5;
      if (Math.abs(X) < roadW) {
        const edge = Math.abs(Math.abs(X) - roadW * 0.86) < 0.004 + d * 0.03;
        return edge ? [0.85, 0.85, 0.82] : [0.3, 0.3, 0.31].map((v) => v * (0.92 + 0.1 * tnoise(X, Y, 20, 402)));
      }
      return Math.abs(X) < roadW + 0.03 + d * 0.3 ? [0.55, 0.54, 0.5] : [0.5, 0.47, 0.42];
    };
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      let acc = [0, 0, 0];
      for (let s2 = 0; s2 < 4; s2++) {
        const dx = (i + 0.25 + (s2 & 1) * 0.5) / n * 2 - 1, dy = (j + 0.25 + (s2 >> 1) * 0.5) / n * 2 - 1;
        const k = 1 + 1.1 * (dx * dx + dy * dy);
        const cc = scene(dx * k * 0.9, dy * k * 0.9);
        acc = acc.map((v, q) => v + cc[q] / 4);
      }
      const r = Math.hypot(i / n * 2 - 1, j / n * 2 - 1), vig = 1 - 0.25 * clamp01((r - 0.75) / 0.25);
      const o = (j * n + i) * 4;
      for (let q = 0; q < 3; q++) img.data[o + q] = 255 * clamp01(acc[q] * vig);
      img.data[o + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    return c;
  }, { roughness: 0.06, metalness: 0.1 });
}

function curveMirror(opts = {}) {
  const M = materials(), P = pm();
  const orange = col(opts.color || '#f27a12');
  const B = new Builder();
  const H = num(opts.h, 3.05);
  B.cyl(M.paint, { r: 0.038, h: H, seg: 12, pos: [0, H / 2, 0], color: orange });
  B.cyl(M.paint, { r: 0.041, r2: 0.028, h: 0.03, seg: 12, pos: [0, H + 0.015, 0], color: orange });
  const yM = H - 0.43, rM = num(opts.r, 0.4);
  // one mirror in front of the post, or two side by side on a crossbar, turned outwards
  const dbl = flag(opts.double, false), turn = num(opts.turn, 0.5);
  const heads = dbl ? [[-rM - 0.07, -turn], [rM + 0.07, turn]] : [[0, 0]];
  if (dbl) rod(B, M.paint, [-rM - 0.07, yM, 0.02], [rM + 0.07, yM, 0.02], 0.022, { seg: 8, color: scl(orange, 0.9), open: false });
  for (const [hx, yaw] of heads) {
    const head = Builder.mat({ pos: [hx + Math.sin(yaw) * 0.14, yM, 0.02 + Math.cos(yaw) * 0.14], rot: [0.07, yaw, 0] });
    const at = (x, y, z) => v3(x, y, z).applyMatrix4(head);
    // convex mirror face: a shallow spherical cap facing +z
    const Rc = 2.4, tc = Math.asin((rM - 0.015) / Rc);
    const cap = new THREE.SphereGeometry(Rc, 28, 5, 0, TAU, 0, tc).rotateX(Math.PI / 2).translate(0, 0, -Rc * Math.cos(tc) + 0.004);
    const cuv = cap.attributes.uv, cp = cap.attributes.position;
    for (let i = 0; i < cuv.count; i++) cuv.setXY(i, 0.5 + cp.getX(i) / (2 * rM), 0.5 + cp.getY(i) / (2 * rM));
    B.geo(mirrorFaceMat(), cap, head);
    // orange back shell and rim
    const Rb = 0.95, tb = Math.asin((rM + 0.01) / Rb);
    const back = new THREE.SphereGeometry(Rb, 28, 4, 0, TAU, 0, tb).rotateX(-Math.PI / 2).translate(0, 0, Rb * Math.cos(tb));
    B.geo(M.paint, back, head, orange);
    B.geo(M.paint, new THREE.TorusGeometry(rM, 0.022, 6, 36), head, orange);
    // bracket to the pole and clamp
    rod(B, M.paint, at(0, 0, -0.08), v3(hx, yM, dbl ? 0.02 : 0), 0.022, { seg: 6, color: scl(orange, 0.9) });
    if (!dbl) rod(B, M.paint, at(0, 0.18, -0.06), v3(0, yM + 0.18, 0), 0.016, { seg: 6, color: scl(orange, 0.9) });
  }
  B.cyl(M.paint, { r: 0.046, h: 0.1, seg: 12, pos: [0, yM, 0], color: scl(orange, 0.9) });
  B.cyl(M.paint, { r: 0.046, h: 0.06, seg: 12, pos: [0, yM + 0.18, 0], color: scl(orange, 0.9) });
  // a small plate on the post
  const pl = canvasMat('mirror-plate', () => {
    const [c, x] = cnv(128, 64);
    x.fillStyle = '#f2f1ea'; x.fillRect(0, 0, 128, 64);
    x.strokeStyle = '#c8161e'; x.lineWidth = 5; x.strokeRect(4, 4, 120, 56);
    x.fillStyle = '#c8161e'; x.font = `700 30px ${JP}`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('安全確認', 64, 33);
    return c;
  });
  B.box(P.galv, { w: 0.2, h: 0.1, d: 0.004, pos: [0, 1.75, 0.042] });
  B.quad(pl, [-0.098, 1.702, 0.0445], [0.098, 1.702, 0.0445], [0.098, 1.798, 0.0445], [-0.098, 1.798, 0.0445], { uv: [[0, 0], [1, 0], [1, 1], [0, 1]] });
  return B.build({ name: 'curveMirror' });
}

// ---------------------------------------------------------------- post box
function postMarkMat() {
  return canvasMat('post-mark', () => {
    const [c, x] = cnv(256, 128);
    x.fillStyle = '#c3181f'; x.fillRect(0, 0, 256, 128);
    x.fillStyle = '#ffffff'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = `800 84px ${JP}`; x.fillText('〒', 70, 66);
    x.font = `700 46px ${MIN}`; x.fillText('郵便', 176, 50);
    x.font = `700 22px ${JP}`; x.fillText('POST', 176, 96);
    return c;
  }, { roughness: 0.45 });
}
function postTimeMat() {
  return canvasMat('post-time', () => {
    const [c, x] = cnv(128, 160);
    x.fillStyle = '#f4f3ee'; x.fillRect(0, 0, 128, 160);
    x.fillStyle = '#c3181f'; x.fillRect(0, 0, 128, 30);
    x.fillStyle = '#ffffff'; x.font = `700 20px ${JP}`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('取集時刻', 64, 16);
    x.fillStyle = '#222'; x.font = `600 22px ${JP}`;
    ['平日 10:30', '　　 15:00', '土曜 11:00', '休日 11:00'].forEach((t, k) => x.fillText(t, 64, 52 + k * 28));
    return c;
  }, { roughness: 0.4 });
}
function postBox(opts = {}) {
  const M = materials(), P = pm();
  const red = col('#c8171e');
  const B = new Builder();
  if (opts.type === 'square') {
    B.box(M.concrete, { w: 0.4, h: 0.06, d: 0.36, pos: [0, 0.03, 0] });
    B.box(M.paint, { w: 0.2, h: 0.56, d: 0.18, pos: [0, 0.34, 0], color: scl(red, 0.9) });
    B.box(M.paint, { w: 0.46, h: 0.62, d: 0.4, pos: [0, 0.93, 0], color: red });
    B.box(M.paint, { w: 0.48, h: 0.035, d: 0.42, pos: [0, 1.255, 0], color: scl(red, 0.95) });
    B.box(M.paint, { w: 0.44, h: 0.02, d: 0.39, pos: [0, 1.28, -0.005], color: scl(red, 0.95) });
    for (const x of [-0.11, 0.11]) {
      B.box(M.darkMetal, { w: 0.16, h: 0.02, d: 0.01, pos: [x, 1.12, 0.198] });
      B.box(M.paint, { w: 0.19, h: 0.018, d: 0.05, pos: [x, 1.145, 0.215], color: red });
    }
    B.quad(postMarkMat(), [-0.16, 0.94, 0.2015], [0.16, 0.94, 0.2015], [0.16, 1.1, 0.2015], [-0.16, 1.1, 0.2015], { uv: [[0, 0], [1, 0], [1, 1], [0, 1]] });
    B.box(M.paint, { w: 0.38, h: 0.3, d: 0.008, pos: [0, 0.76, 0.203], color: scl(red, 0.93) });
    B.quad(postTimeMat(), [-0.06, 0.66, 0.2075], [0.06, 0.66, 0.2075], [0.06, 0.81, 0.2075], [-0.06, 0.81, 0.2075], { uv: [[0, 0], [1, 0], [1, 1], [0, 1]] });
    B.box(M.metal, { w: 0.03, h: 0.03, d: 0.01, pos: [0.14, 0.76, 0.208] });
    return B.build({ name: 'postBox' });
  }
  // classic round pillar box (郵便差出箱1号丸型)
  B.cyl(M.concrete, { r: 0.27, h: 0.1, seg: 24, pos: [0, 0.05, 0] });
  B.cyl(M.paint, { r: 0.225, r2: 0.2, h: 0.12, seg: 28, pos: [0, 0.16, 0], color: red });
  B.cyl(M.paint, { r: 0.2, h: 0.98, seg: 28, pos: [0, 0.71, 0], color: red });
  B.cyl(M.paint, { r: 0.206, h: 0.025, seg: 28, pos: [0, 0.25, 0], color: red });
  B.cyl(M.paint, { r: 0.206, h: 0.02, seg: 28, pos: [0, 1.17, 0], color: red });
  B.cyl(M.paint, { r: 0.252, r2: 0.248, h: 0.035, seg: 28, pos: [0, 1.2175, 0], color: red });
  lathe(B, M.paint, [[0.24, 0], [0.228, 0.045], [0.18, 0.1], [0.1, 0.13], [0.03, 0.142], [0.001, 0.143]], { seg: 28, pos: [0, 1.235, 0], color: red });
  B.cyl(M.paint, { r: 0.028, r2: 0.012, h: 0.04, seg: 10, pos: [0, 1.39, 0], color: red });
  // slot with its hood
  B.box(M.darkMetal, { w: 0.2, h: 0.026, d: 0.04, pos: [0, 1.05, 0.185] });
  slab(B, M.paint, [-0.13, 1.08, 0.2], [0.13, 1.08, 0.2], 0.055, 0.016, { out: [0, 1, 0.25], color: red });
  // front door panel, handle and lock; 〒 mark; collection-time plate
  B.geo(M.paint, frustum({ r0: 0.2045, r1: 0.2045, y0: 0.38, y1: 0.9, seg: 10, a0: Math.PI / 2 - 0.62, a1: Math.PI / 2 + 0.62 }), null, scl(red, 0.94));
  B.box(M.metal, { w: 0.03, h: 0.05, d: 0.012, pos: [-0.085, 0.64, 0.188] });
  B.box(M.darkMetal, { w: 0.008, h: 0.018, d: 0.006, pos: [-0.085, 0.6, 0.194] });
  B.geo(postMarkMat(), frustum({ r0: 0.2035, r1: 0.2035, y0: 0.93, y1: 1.02, seg: 10, a0: Math.PI / 2 - 0.62, a1: Math.PI / 2 + 0.62, u0: 1, uR: -1 / 1.24, vS: 1 / 0.09 }));
  B.geo(postTimeMat(), frustum({ r0: 0.2055, r1: 0.2055, y0: 0.55, y1: 0.7, seg: 4, a0: Math.PI / 2 - 0.3, a1: Math.PI / 2 - 0.02, u0: 1, uR: -1 / 0.28, vS: 1 / 0.15 }));
  return B.build({ name: 'postBox' });
}

// ---------------------------------------------------------------- guardrail
// Sweep a 2D profile [[a, b], ...] (a: outward along N = T x up, b: up) with per-point normals
// along a path of Vector3 (horizontal tangents); u = path length, v = b.
function sweep(prof, nrm, path) {
  const pos = [], nor = [], uv = [], idx = [], m = prof.length;
  let s = 0;
  path.forEach((p, i) => {
    const T = path[Math.min(path.length - 1, i + 1)].clone().sub(path[Math.max(0, i - 1)]).setY(0).normalize();
    const N = v3(-T.z, 0, T.x);
    if (i) s += p.distanceTo(path[i - 1]);
    for (let j = 0; j < m; j++) {
      const [a, b] = prof[j], [na, nb] = nrm[j];
      pos.push(p.x + N.x * a, p.y + b, p.z + N.z * a);
      nor.push(N.x * na, nb, N.z * na);
      uv.push(s, b);
    }
  });
  for (let i = 0; i < path.length - 1; i++) for (let j = 0; j < m - 1; j++) {
    const a = i * m + j, c = a + m;
    idx.push(a, c, a + 1, a + 1, c, c + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function guardrail(opts = {}) {
  const M = materials(), P = pm();
  const len = Math.max(1, num(opts.len, 8)), x0 = -len / 2, x1 = len / 2;
  const white = opts.color ? col(opts.color) : col('#f0f0ea');
  const B = new Builder();
  if (opts.type === 'pipe') {   // guard pipe fence
    const n = Math.max(2, Math.round(len / 2) + 1);
    for (let i = 0; i < n; i++) {
      const x = x0 + (len * i) / (n - 1);
      B.cyl(M.paint, { r: 0.03, h: 0.82, seg: 10, pos: [x, 0.41, 0], color: white });
      B.cyl(M.paint, { r: 0.033, r2: 0.02, h: 0.03, seg: 10, pos: [x, 0.835, 0], color: white });
    }
    for (const y of [0.3, 0.52, 0.74]) rod(B, M.paint, [x0 - 0.03, y, 0], [x1 + 0.03, y, 0], 0.024, { seg: 10, color: white, open: false });
    return B.build({ name: 'guardrail' });
  }
  // W-beam: two waves, 0.35 m tall, 83 mm deep, 3.2 mm steel
  const D = 0.083, Hb = 0.35, th = 0.0032, n = 20, yB = 0.6;
  const front = [], fN = [], back = [], bN = [];
  for (let j = 0; j <= n; j++) {
    const b = -Hb / 2 + (Hb * j) / n;
    const a = (D / 2) * -Math.cos((TAU * b) / (Hb / 2));
    const da = (D / 2) * Math.sin((TAU * b) / (Hb / 2)) * (TAU / (Hb / 2));
    const l = Math.hypot(1, da);
    front.push([a, b]); fN.push([1 / l, -da / l]);
    back.push([a - th / l, b + (th * da) / l]); bN.push([-1 / l, da / l]);
  }
  // path: straight run with end wings curling back (-z)
  const path = [], Rw = 0.35;
  for (let k = 6; k >= 1; k--) { const f = (k / 6) * 1.35; path.push(v3(x0 - Rw * Math.sin(f), yB, -Rw + Rw * Math.cos(f))); }
  path.push(v3(x0, yB, 0), v3(x1, yB, 0));
  for (let k = 1; k <= 6; k++) { const f = (k / 6) * 1.35; path.push(v3(x1 + Rw * Math.sin(f), yB, -Rw + Rw * Math.cos(f))); }
  B.geo(M.paint, sweep(front, fN, path), null, white);
  B.geo(M.paint, sweep(back.slice().reverse(), bN.slice().reverse(), path), null, scl(white, 0.9));
  // posts behind the beam with spacers, caps, bolts and delineators
  const np = Math.max(2, Math.round((len - 0.6) / num(opts.span, 4)) + 1), zP = -(D / 2 + 0.1);
  for (let i = 0; i < np; i++) {
    const x = x0 + 0.3 + ((len - 0.6) * i) / (np - 1);
    B.cyl(M.paint, { r: 0.07, h: 0.86, seg: 14, pos: [x, 0.43, zP], color: white });
    B.cyl(M.paint, { r: 0.073, r2: 0.045, h: 0.035, seg: 14, pos: [x, 0.8775, zP], color: white });
    B.box(M.paint, { w: 0.09, h: 0.16, d: 0.06, pos: [x, yB, -(D / 2 + 0.03)], color: scl(white, 0.92) });
    for (const dx of [-0.045, 0.045]) B.cyl(M.metal, { r: 0.011, h: 0.012, seg: 6, pos: [x + dx, yB, -D / 2 + 0.004], rot: [Math.PI / 2, 0, 0] });
    if (i % 2 === 0) {
      rod(B, M.metal, [x, 0.895, zP], [x, 0.97, zP], 0.008, { seg: 5 });
      B.cyl(P.plastic, { r: 0.05, h: 0.014, seg: 14, pos: [x, 1.0, zP + 0.004], rot: [Math.PI / 2, 0, 0], color: col('#f09a22') });
    }
  }
  return B.build({ name: 'guardrail' });
}

// ---------------------------------------------------------------- street lamp
function streetLamp(opts = {}) {
  const M = materials(), P = pm();
  const small = opts.type === 'small';
  const h = num(opts.h, small ? 4.6 : 7.2), arm = num(opts.arm, small ? 0.65 : 1.5);
  const c = opts.color === 'brown' ? col('#4b3b2f') : opts.color ? col(opts.color) : col('#a3a8aa');
  const B = new Builder();
  if (small) {
    B.box(M.concrete, { w: 0.3, h: 0.08, d: 0.3, pos: [0, 0.04, 0] });
    B.cyl(M.paint, { r: 0.042, r2: 0.036, h: h - 0.08, seg: 12, pos: [0, 0.08 + (h - 0.08) / 2, 0], color: c });
    B.cyl(M.paint, { r: 0.04, r2: 0.02, h: 0.04, seg: 12, pos: [0, h + 0.02, 0], color: c });
    tube(B, M.paint, [[0, h - 0.35, 0.03], [0, h - 0.1, 0.12], [0, h + 0.02, arm * 0.6], [0, h + 0.03, arm]], 0.02, { seg: 6, n: 10, color: c });
    const head = Builder.mat({ pos: [0, h + 0.02, arm + 0.12], rot: [-0.06, 0, 0] });
    B.box(P.plastic, { w: 0.13, h: 0.06, d: 0.34, color: col('#dcdedb'), matrix: head });
    B.box(M.lamp, { w: 0.1, h: 0.01, d: 0.28, pos: [0, -0.032, 0], matrix: head });
    const g = B.build({ name: 'streetLamp' });
    g.userData.lamp = v3(0, h - 0.03, arm + 0.12);
    return g;
  }
  B.box(M.concrete, { w: 0.5, h: 0.1, d: 0.5, pos: [0, 0.05, 0] });
  B.cyl(M.paint, { r: 0.15, h: 0.02, seg: 16, pos: [0, 0.11, 0], color: scl(c, 0.9) });
  B.cyl(M.paint, { r: 0.085, r2: 0.055, h: h - 0.12, seg: 16, pos: [0, 0.12 + (h - 0.12) / 2, 0], color: c });
  B.box(M.paint, { w: 0.07, h: 0.2, d: 0.012, pos: [0, 0.62, 0.083], color: scl(c, 0.92) });
  B.cyl(M.paint, { r: 0.058, r2: 0.03, h: 0.06, seg: 16, pos: [0, h + 0.03, 0], color: c });
  tube(B, M.paint, [[0, h - 0.7, 0.04], [0, h - 0.15, 0.1], [0, h + 0.12, arm * 0.45], [0, h + 0.2, arm]], 0.035, { seg: 8, n: 14, color: c });
  const head = Builder.mat({ pos: [0, h + 0.19, arm + 0.26], rot: [-0.05, 0, 0] });
  B.box(M.paint, { w: 0.3, h: 0.07, d: 0.6, color: c, matrix: head });
  B.box(M.paint, { w: 0.26, h: 0.03, d: 0.54, pos: [0, 0.045, 0], color: scl(c, 0.95), matrix: head });
  B.box(M.lamp, { w: 0.22, h: 0.012, d: 0.44, pos: [0, -0.037, 0.02], matrix: head });
  const g = B.build({ name: 'streetLamp' });
  g.userData.lamp = v3(0, h + 0.1, arm + 0.26);
  return g;
}

// ---------------------------------------------------------------- road sign
function signMat(type) {
  return canvasMat('sign-' + type, () => {
    const [c, x] = cnv(512, 512);
    x.fillStyle = '#9aa0a2'; x.fillRect(0, 0, 512, 512);
    x.textAlign = 'center'; x.textBaseline = 'middle';
    if (type === 'stop') {
      const tri = (inset, fill) => {
        const k = 640, t = [[-0.4, 0.3464], [0.4, 0.3464], [0, -0.3464]].map(([a, b]) => [256 + a * k, 256 - b * k]);
        const cx = 256, cy = (t[0][1] * 2 + t[2][1]) / 3;
        x.beginPath();
        t.forEach(([px, py], i) => { const q = [px + (cx - px) * inset, py + (cy - py) * inset]; if (i) x.lineTo(...q); else x.moveTo(...q); });
        x.closePath(); x.fillStyle = fill; x.fill();
      };
      tri(0, '#f4f4f0'); tri(0.07, '#c8161e');
      x.fillStyle = '#f4f4f0'; x.font = `800 104px ${JP}`;
      x.fillText('止まれ', 256, 160);
    } else if (type === 'speed') {
      x.beginPath(); x.arc(256, 256, 196, 0, TAU); x.fillStyle = '#f4f4f0'; x.fill();
      x.beginPath(); x.arc(256, 256, 186, 0, TAU); x.fillStyle = '#c8161e'; x.fill();
      x.beginPath(); x.arc(256, 256, 140, 0, TAU); x.fillStyle = '#f4f4f0'; x.fill();
      x.fillStyle = '#1f4fa0'; x.font = `800 170px ${JP}`;
      x.save(); x.translate(256, 264); x.scale(0.78, 1); x.fillText('30', 0, 0); x.restore();
    } else {
      // warning diamond (children) above a "通学路" plate
      x.save(); x.translate(256, 190); x.rotate(Math.PI / 4);
      x.fillStyle = '#1b1b1b'; x.fillRect(-128, -128, 256, 256);
      x.fillStyle = '#f2c230'; x.fillRect(-120, -120, 240, 240);
      x.restore();
      x.fillStyle = '#1b1b1b';
      const kid = (px, py, s) => {
        x.beginPath(); x.arc(px, py - 62 * s, 15 * s, 0, TAU); x.fill();
        x.beginPath(); x.moveTo(px - 16 * s, py - 44 * s); x.lineTo(px + 16 * s, py - 44 * s); x.lineTo(px + 22 * s, py + 2 * s); x.lineTo(px - 22 * s, py + 2 * s); x.fill();
        x.lineWidth = 9 * s; x.lineCap = 'round'; x.strokeStyle = '#1b1b1b';
        x.beginPath(); x.moveTo(px - 8 * s, py); x.lineTo(px - 20 * s, py + 44 * s); x.moveTo(px + 8 * s, py); x.lineTo(px + 22 * s, py + 42 * s); x.stroke();
        x.beginPath(); x.moveTo(px - 14 * s, py - 38 * s); x.lineTo(px - 32 * s, py - 8 * s); x.moveTo(px + 14 * s, py - 38 * s); x.lineTo(px + 30 * s, py - 12 * s); x.stroke();
      };
      kid(222, 215, 1.05); kid(292, 228, 0.82);
      x.fillStyle = '#f4f4f0'; x.fillRect(96, 400, 320, 100);
      x.strokeStyle = '#1b1b1b'; x.lineWidth = 6; x.strokeRect(99, 403, 314, 94);
      x.fillStyle = '#1b1b1b'; x.font = `800 64px ${JP}`; x.fillText('通学路', 256, 452);
    }
    return c;
  }, { roughness: 0.4 });
}
function signPole(opts = {}) {
  const P = pm();
  const type = ['stop', 'speed', 'school'].includes(opts.type) ? opts.type : 'stop';
  const B = new Builder();
  const H = num(opts.h, 2.75), mat = signMat(type);
  B.cyl(P.galv, { r: 0.03, h: H, seg: 10, pos: [0, H / 2, 0] });
  B.cyl(P.galv, { r: 0.032, r2: 0.012, h: 0.03, seg: 10, pos: [0, H + 0.015, 0] });
  // plate shapes in (x, y) around the sign centre; uv maps the 0.8 m square onto the canvas
  const S = 0.8, yc = H - 0.36, zc = 0.036, shapes = [];
  const poly = (pts) => shapes.push(new THREE.Shape(pts.map(([a, b]) => new THREE.Vector2(a, b))));
  if (type === 'stop') poly([[-0.4, 0.3464], [0.4, 0.3464], [0, -0.3464]]);
  else if (type === 'speed') { const c = new THREE.Shape(); c.absarc(0, 0, 0.306, 0, TAU, false); shapes.push(c); }
  else {
    const d = 0.2828, cy = 0.1031;
    poly([[0, cy - d], [d, cy], [0, cy + d], [-d, cy]]);
    poly([[-0.25, -0.381], [0.25, -0.381], [0.25, -0.225], [-0.25, -0.225]]);
  }
  for (const sh of shapes) {
    const g = new THREE.ShapeGeometry(sh, 24);
    const uv = g.attributes.uv, p = g.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, p.getX(i) / S + 0.5, p.getY(i) / S + 0.5);
    B.geo(mat, g, Builder.mat({ pos: [0, yc, zc + 0.003] }));
    B.geo(P.galv, g.clone(), Builder.mat({ pos: [0, yc, zc], rotY: Math.PI }));
  }
  for (const dy of [0.12, -0.12]) B.box(P.galv, { w: 0.08, h: 0.04, d: 0.03, pos: [0, yc + dy, 0.02] });
  return B.build({ name: 'signPole' });
}

// ---------------------------------------------------------------- bicycle (mamachari)
const FRAME_COLS = ['#d9d9d4', '#e6dcc2', '#8fb4d0', '#2a2a2c', '#9b2a2e', '#9fd1c3'];
function bicycle(opts = {}) {
  const M = materials(), P = pm();
  const seed = Math.round(num(opts.seed, 1));
  const fc = col(opts.color || FRAME_COLS[seed % FRAME_COLS.length]);
  const B = new Builder(), chrome = M.metal, rub = M.rubber;
  const Rw = 0.33, zF = 0.56, zB = -0.52, yAx = Rw;
  const wheel = (z) => {
    const m = Builder.mat({ pos: [0, yAx, z], rot: [0, Math.PI / 2, 0] });
    B.geo(rub, new THREE.TorusGeometry(Rw - 0.02, 0.02, 6, 26), m);
    B.geo(chrome, new THREE.TorusGeometry(Rw - 0.045, 0.008, 3, 26), m);
    B.cyl(chrome, { r: 0.025, h: 0.1, seg: 8, pos: [0, yAx, z], rot: [0, 0, Math.PI / 2] });
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * TAU, s = i % 2 ? 1 : -1;
      rod(B, chrome, [s * 0.035, yAx + Math.sin(a + 0.2) * 0.022, z + Math.cos(a + 0.2) * 0.022], [s * 0.004, yAx + Math.sin(a) * (Rw - 0.05), z + Math.cos(a) * (Rw - 0.05)], 0.0014, { seg: 3 });
    }
  };
  wheel(zF); wheel(zB);
  // fenders: thin arcs over each wheel
  const fender = (z, a0, a1) => {   // open arc around the axle; angle 0 = forward, PI/2 = up
    const g = new THREE.CylinderGeometry(Rw + 0.03, Rw + 0.03, 0.055, 18, 1, true, a0, a1 - a0);
    const m = Builder.mat({ pos: [0, yAx, z], rot: [0, 0, Math.PI / 2] });
    B.geo(chrome, g, m);
    B.geo(chrome, flipped(g), m);
  };
  fender(zF, 0.15, 2.0); fender(zB, 1.2, 3.85);
  // frame: step-through main tube, seat tube, stays, fork, head tube
  const BB = [0, 0.29, -0.03], head0 = [0, 0.62, 0.36], head1 = [0, 0.82, 0.3], seatTop = [0, 0.84, -0.2];
  tube(B, M.paint, [[0, 0.72, 0.335], [0, 0.52, 0.25], [0, 0.34, 0.08], BB], 0.02, { seg: 8, n: 14, color: fc });
  tube(B, M.paint, [[0, 0.62, 0.34], [0, 0.44, 0.24], [0, 0.31, 0.06], [0, 0.285, -0.01]], 0.015, { seg: 6, n: 12, color: fc });
  rod(B, M.paint, BB, seatTop, 0.019, { seg: 8, color: fc });
  rod(B, M.paint, head0, head1, 0.024, { seg: 8, color: fc });
  for (const s of [-1, 1]) {
    rod(B, M.paint, [s * 0.02, 0.29, -0.03], [s * 0.055, yAx, zB], 0.011, { seg: 6, color: fc });
    rod(B, M.paint, [s * 0.015, 0.8, -0.19], [s * 0.055, yAx, zB], 0.01, { seg: 6, color: fc });
    rod(B, M.paint, [s * 0.02, 0.62, 0.36], [s * 0.05, yAx + 0.02, zF - 0.01], 0.012, { seg: 6, color: fc });
  }
  // chain case, crank, pedals, stand
  slab(B, M.paint, [0.08, 0.3, -0.02], [0.08, yAx, zB + 0.05], 0.13, 0.018, { out: [1, 0, 0], color: scl(fc, 0.8) });
  B.cyl(M.paint, { r: 0.11, h: 0.02, seg: 14, pos: [0.08, 0.29, -0.03], rot: [0, 0, Math.PI / 2], color: scl(fc, 0.8) });
  for (const s of [-1, 1]) {
    const pz = -0.03 + s * 0.15, py = 0.29 - s * 0.04;
    rod(B, chrome, [s * 0.1, 0.29, -0.03], [s * 0.11, py, pz], 0.01, { seg: 4 });
    B.box(rub, { w: 0.1, h: 0.02, d: 0.06, pos: [s * 0.17, py, pz] });
    rod(B, chrome, [s * 0.06, yAx, zB], [s * 0.1, 0.01, zB - 0.12], 0.009, { seg: 5 });
  }
  rod(B, chrome, [-0.1, 0.01, zB - 0.12], [0.1, 0.01, zB - 0.12], 0.009, { seg: 5 });
  // seat post and saddle
  rod(B, chrome, seatTop, [0, 0.94, -0.23], 0.012, { seg: 6 });
  const saddle = new THREE.SphereGeometry(1, 10, 3, 0, TAU, 0, Math.PI / 2);
  B.geo(rub, saddle, Builder.mat({ pos: [0, 0.955, -0.255], scale: [0.105, 0.05, 0.1] }));
  B.geo(rub, saddle, Builder.mat({ pos: [0, 0.955, -0.16], scale: [0.05, 0.042, 0.1] }));
  B.box(rub, { w: 0.18, h: 0.012, d: 0.16, pos: [0, 0.952, -0.24] });
  for (const s of [-1, 1]) B.cyl(chrome, { r: 0.012, h: 0.05, seg: 6, pos: [s * 0.055, 0.925, -0.29] });
  // stem and swept-back handlebar with grips, bell
  rod(B, chrome, head1, [0, 1.0, 0.27], 0.013, { seg: 6 });
  tube(B, chrome, [[-0.29, 1.03, 0.08], [-0.22, 1.02, 0.2], [-0.08, 1.0, 0.27], [0.08, 1.0, 0.27], [0.22, 1.02, 0.2], [0.29, 1.03, 0.08]], 0.011, { seg: 6, n: 16 });
  for (const s of [-1, 1]) rod(B, rub, [s * 0.255, 1.027, 0.13], [s * 0.3, 1.032, 0.05], 0.017, { seg: 8, open: false });
  B.cyl(chrome, { r: 0.028, r2: 0.01, h: 0.02, seg: 10, pos: [-0.14, 1.03, 0.25] });
  // front basket (wire) on stays, lamp
  const bx = 0.18, bz0 = zF + 0.04, bz1 = zF + 0.3, by0 = 0.76, by1 = 1.0;
  const ring = (y, r) => rods(B, chrome, [[-bx, y, bz0], [bx, y, bz0], [bx, y, bz1], [-bx, y, bz1], [-bx, y, bz0]], r, { seg: 4 });
  ring(by0, 0.004); ring((by0 + by1) / 2, 0.0028); ring(by1, 0.006);
  for (let i = 0; i <= 6; i++) { const x = -bx + (2 * bx * i) / 6; rod(B, chrome, [x, by0, bz0], [x, by1, bz0], 0.0028, { seg: 3 }); rod(B, chrome, [x, by0, bz1], [x, by1, bz1], 0.0028, { seg: 3 }); }
  for (let i = 1; i < 4; i++) { const z = bz0 + ((bz1 - bz0) * i) / 4; for (const x of [-bx, bx]) rod(B, chrome, [x, by0, z], [x, by1, z], 0.0028, { seg: 3 }); rod(B, chrome, [-bx, by0, z], [bx, by0, z], 0.0028, { seg: 3 }); }
  for (const s of [-1, 1]) rod(B, chrome, [s * 0.05, yAx, zF + 0.01], [s * 0.1, by0, bz0 + 0.1], 0.005, { seg: 4 });
  rod(B, chrome, [0, 0.99, 0.27], [0, by1 - 0.02, bz0], 0.007, { seg: 4 });
  B.cyl(chrome, { r: 0.035, r2: 0.03, h: 0.07, seg: 10, pos: [0, 0.72, bz0 + 0.02], rot: [Math.PI / 2, 0, 0] });
  // rear carrier
  for (const s of [-1, 1]) {
    rod(B, chrome, [s * 0.075, 0.75, -0.18], [s * 0.075, 0.75, -0.7], 0.007, { seg: 4 });
    rod(B, chrome, [s * 0.075, 0.75, -0.62], [s * 0.06, yAx, zB], 0.006, { seg: 4 });
  }
  for (const z of [-0.2, -0.36, -0.52, -0.68]) rod(B, chrome, [-0.075, 0.75, z], [0.075, 0.75, z], 0.006, { seg: 4 });
  B.box(M.paint, { w: 0.06, h: 0.02, d: 0.01, pos: [0, 0.62, -0.87], color: col('#d0302a') });
  const g = B.build({ name: 'bicycle' });
  return g;
}

// ---------------------------------------------------------------- laundry
const PASTEL = ['#f4f1ea', '#bcd7ee', '#f3c6cf', '#bfe3cf', '#f5e6a8', '#d7c9ea', '#f7d2b5', '#ffffff', '#a9c8e8'];
// Cloth folded over a pole (towel): x across, hangs hf in front (+z) and hb behind.
function drapeGeo(w, hf, hb, rp, R) {
  const nx = 5, rc = rp + 0.004, prof = [];
  for (let k = 0; k <= 4; k++) prof.push([-rc - 0.035 * (k / 4) ** 2, -hb * (1 - k / 4)]);
  for (let k = 1; k < 6; k++) { const f = Math.PI - (k / 6) * Math.PI; prof.push([rc * Math.cos(f), rc * Math.sin(f)]); }
  for (let k = 0; k <= 4; k++) prof.push([rc + 0.035 * (k / 4) ** 2, -hf * (k / 4)]);
  const ph = R() * 6, amp = 0.012 + R() * 0.012;
  const pos = [], uv = [], idx = [];
  let s = 0;
  prof.forEach(([z, y], j) => {
    if (j) s += Math.hypot(z - prof[j - 1][0], y - prof[j - 1][1]);
    const depth = Math.max(0, -y) / Math.max(hf, hb);
    for (let i = 0; i <= nx; i++) {
      const x = -w / 2 + (w * i) / nx;
      pos.push(x, y, z + Math.sign(z) * amp * depth * Math.sin(x * 9 + ph + y * 3));
      uv.push(x, s);
    }
  });
  for (let j = 0; j < prof.length - 1; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, c = a + nx + 1;
    idx.push(a, c, a + 1, a + 1, c, c + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
function shirtGeo(R) {
  // T-shirt outline (shoulder line at y = 0, hem at -0.63) with a neck dip
  const half = [[0.075, 0], [0.2, -0.025], [0.34, -0.13], [0.285, -0.225], [0.205, -0.175], [0.225, -0.62], [0.001, -0.63]];
  const pts = [...half, ...half.slice(0, -1).reverse().map(([x, y]) => [-x, y]), [0, -0.055]].map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.ShapeGeometry(new THREE.Shape(pts), 4);
  const p = g.attributes.position, ph = R() * 5;
  for (let i = 0; i < p.count; i++) p.setZ(i, 0.015 * Math.sin(p.getX(i) * 8 + ph) * (-p.getY(i)));
  g.computeVertexNormals();
  return g;
}
function laundry(opts = {}) {
  const M = materials(), P = pm();
  const seed = Math.round(num(opts.seed, 1)), R = rng(seed * 977 + 3);
  const bamboo = opts.pole ? opts.pole === 'bamboo' : R() < 0.5;
  const B = new Builder();
  const xs = 1.55, yP = 1.75, poleZ = [0.24, -0.24];
  // stands
  for (const x of [-xs, xs]) {
    B.cyl(P.plastic, { r: 0.2, r2: 0.15, h: 0.12, seg: 14, pos: [x, 0.06, 0], color: col('#d8d4c6'), open: false });
    B.cyl(M.metal, { r: 0.017, h: yP - 0.1, seg: 8, pos: [x, 0.12 + (yP - 0.22) / 2, 0] });
    rod(B, M.metal, [x, yP - 0.06, -0.3], [x, yP - 0.06, 0.3], 0.013, { seg: 6 });
    for (const z of poleZ) for (const d of [-0.03, 0.03]) rod(B, M.metal, [x, yP - 0.06, z + d], [x, yP + 0.03, z + d * 1.3], 0.006, { seg: 4 });
    B.cyl(P.plastic, { r: 0.02, h: 0.03, seg: 8, pos: [x, yP - 0.02 + 0.01, 0], color: col('#d8d4c6') });
  }
  // poles
  for (const z of poleZ) {
    if (bamboo) {
      const bc = col('#bda56c');
      rod(B, P.plank, [-1.95, yP, z], [1.95, yP, z], 0.02, { seg: 10, color: bc, open: false });
      for (let x = -1.8; x < 1.9; x += 0.37 + R() * 0.08) rod(B, P.plank, [x - 0.006, yP, z], [x + 0.006, yP, z], 0.0228, { seg: 10, color: scl(bc, 0.85) });
    } else {
      rod(B, M.metal, [-1.9, yP, z], [1.9, yP, z], 0.016, { seg: 10 });
      for (const x of [-1.9, 1.9]) rod(B, P.plastic, [x - 0.03, yP, z], [x + 0.03, yP, z], 0.019, { seg: 10, color: col('#7fb2d8'), open: false });
    }
  }
  // clothes packed along each pole
  const cloth = P.cloth, pick = () => col(PASTEL[Math.floor(R() * PASTEL.length)]);
  for (const z of poleZ) {
    let x = -1.3;
    while (x < 1.25) {
      const t = R();
      if (t < 0.35) {           // towel folded over the pole
        const w = 0.32 + R() * 0.3, hf = 0.35 + R() * 0.35;
        if (x + w > 1.35) break;
        B.geo(cloth, drapeGeo(w, hf, hf * (0.8 + R() * 0.3), 0.02, R), Builder.mat({ pos: [x + w / 2, yP, z] }), pick());
        x += w + 0.05;
      } else if (t < 0.75) {    // shirt on a hanger
        if (x + 0.7 > 1.4) break;
        const cx = x + 0.35, m = Builder.mat({ pos: [cx, yP - 0.12, z], rot: [0, (R() - 0.5) * 0.5, (R() - 0.5) * 0.08] });
        B.geo(cloth, shirtGeo(R), m, pick());
        const at = (px, py, pz) => v3(px, py, pz).applyMatrix4(m);
        rods(B, M.metal, [at(-0.2, -0.01, -0.012), at(0, 0.07, -0.012), at(0.2, -0.01, -0.012)], 0.003, { seg: 3 });
        rod(B, M.metal, at(0, 0.07, -0.012), [cx, yP + 0.03, z], 0.003, { seg: 3 });
        x += 0.62;
      } else {                  // pinch hanger with small things
        if (x + 0.5 > 1.4) break;
        const cx = x + 0.25, fy = yP - 0.3, fc = col('#9cc3e0');
        rods(B, P.plastic, [[cx - 0.2, fy, z - 0.14], [cx + 0.2, fy, z - 0.14], [cx + 0.2, fy, z + 0.14], [cx - 0.2, fy, z + 0.14], [cx - 0.2, fy, z - 0.14]], 0.007, { seg: 4, color: fc });
        for (const [dx, dz] of [[-0.2, -0.14], [0.2, -0.14], [0.2, 0.14], [-0.2, 0.14]]) rod(B, M.metal, [cx + dx, fy, z + dz], [cx, yP + 0.02, z], 0.0015, { seg: 3 });
        for (let k = 0; k < 6; k++) {
          const px = cx - 0.17 + k * 0.068, pz = z + (k % 2 ? 0.14 : -0.14);
          B.box(P.plastic, { w: 0.012, h: 0.04, d: 0.02, pos: [px, fy - 0.02, pz], color: pick() });
          const sw = 0.06 + R() * 0.12, sh = 0.12 + R() * 0.12;
          B.quad(cloth, [px - sw / 2, fy - 0.035 - sh, pz], [px + sw / 2, fy - 0.035 - sh, pz], [px + sw / 2, fy - 0.035, pz], [px - sw / 2, fy - 0.035, pz], { color: pick() });
        }
        x += 0.5;
      }
    }
  }
  return B.build({ name: 'laundry' });
}

// ---------------------------------------------------------------- bench
function bench(opts = {}) {
  const M = materials(), P = pm();
  const len = num(opts.len, 1.8), back = flag(opts.back, true);
  const fc = col(opts.frame || '#33403a');
  const seed = Math.round(num(opts.seed, 1)), R = rng(seed * 71 + 9);
  const B = new Builder(), y0 = 0.43;
  const tint = () => scl([1, 1, 1], 0.85 + R() * 0.25);
  for (let i = 0; i < 5; i++) B.box(P.plank, { w: len, h: 0.032, d: 0.075, pos: [0, y0 - 0.016, 0.19 - i * 0.088], color: tint() });
  const xs = len > 1.4 ? [-(len / 2 - 0.12), 0, len / 2 - 0.12] : [-(len / 2 - 0.1), len / 2 - 0.1];
  const bTilt = 0.26;
  if (back) for (let i = 0; i < 3; i++) {
    const t = 0.13 + i * 0.12;
    B.box(P.plank, { w: len, h: 0.1, d: 0.028, pos: [0, y0 + 0.04 + t * Math.cos(bTilt), -0.2 - t * Math.sin(bTilt)], rot: [-bTilt, 0, 0], color: tint() });
  }
  xs.forEach((x, k) => {
    const end = k === 0 || k === xs.length - 1;
    slab(B, M.paint, [x, 0, 0.17], [x, y0 - 0.035, 0.19], 0.045, 0.05, { out: [0, 0, 1], color: fc });
    slab(B, M.paint, [x, 0, -0.2], [x, y0 - 0.035, -0.18], 0.045, 0.05, { out: [0, 0, 1], color: fc });
    B.box(M.paint, { w: 0.045, h: 0.05, d: 0.46, pos: [x, y0 - 0.058, -0.005], color: fc });
    B.box(M.paint, { w: 0.045, h: 0.035, d: 0.4, pos: [x, 0.1, -0.005], color: fc });
    if (back) slab(B, M.paint, [x, y0 - 0.06, -0.2], [x, y0 + 0.48, -0.2 - 0.52 * Math.sin(bTilt)], 0.045, 0.04, { color: fc });
    if (end && flag(opts.arms, true)) {
      slab(B, M.paint, [x, y0 - 0.03, 0.19], [x, y0 + 0.2, 0.17], 0.04, 0.04, { out: [0, 0, 1], color: fc });
      B.box(M.paint, { w: 0.055, h: 0.03, d: 0.44, pos: [x, y0 + 0.21, -0.03], color: fc });
    }
  });
  return B.build({ name: 'bench' });
}

// ---------------------------------------------------------------- drain (side gutter)
function drain(opts = {}) {
  const M = materials(), P = pm();
  const len = Math.max(0.5, num(opts.len, 4)), seed = Math.round(num(opts.seed, 1)), R = rng(seed * 57 + 1);
  const every = Math.max(1, Math.round(num(opts.grateEvery, 4)));
  const B = new Builder(), yTop = 0.015, wIn = 0.3, wall = 0.06;
  const x0 = -len / 2;
  // U-channel (mostly below ground)
  for (const s of [-1, 1]) B.box(M.concrete, { w: len, h: 0.38, d: wall, pos: [0, yTop - 0.19, s * (wIn / 2 + wall / 2)], color: [0.95, 0.95, 0.93] });
  B.box(M.concrete, { w: len, h: 0.06, d: wIn + 2 * wall, pos: [0, yTop - 0.35, 0] });
  // covers: concrete lids with lifting holes, a steel grating every Nth piece
  const n = Math.ceil(len / 0.5 - 1e-6);
  for (let i = 0; i < n; i++) {
    const a = x0 + i * 0.5, b = Math.min(x0 + len, a + 0.5), cx = (a + b) / 2, w = b - a - 0.008;
    if (i % every === Math.floor(every / 2)) {
      B.box(M.matte, { w: w, h: 0.004, d: wIn, pos: [cx, 0.003, 0], color: [0.012, 0.012, 0.012] });
      for (const s of [-1, 1]) B.box(P.galv, { w: w, h: 0.022, d: 0.006, pos: [cx, yTop - 0.011, s * (wIn / 2 - 0.003)] });
      for (const s of [-1, 1]) B.box(P.galv, { w: 0.006, h: 0.022, d: wIn, pos: [cx + s * (w / 2 - 0.003), yTop - 0.011, 0] });
      const nb = Math.floor(w / 0.03);
      for (let k = 1; k < nb; k++) B.box(P.galv, { w: 0.005, h: 0.02, d: wIn - 0.012, pos: [a + 0.004 + (k * w) / nb, yTop - 0.01, 0], color: [0.8, 0.8, 0.8] });
      for (const z of [-0.07, 0.07]) B.box(P.galv, { w: w - 0.012, h: 0.006, d: 0.006, pos: [cx, yTop - 0.004, z], color: [0.75, 0.75, 0.75] });
    } else {
      const tone = 0.82 + R() * 0.2, lift = (R() - 0.5) * 0.004;
      B.box(M.concrete, { w, h: 0.05, d: wIn - 0.006, pos: [cx, yTop - 0.026 + lift, 0], rot: [(R() - 0.5) * 0.01, 0, (R() - 0.5) * 0.008], color: [tone, tone, tone * 0.97] });
      for (const dx of [-0.16, 0.16]) if (Math.abs(dx) < w / 2 - 0.04) B.box(M.matte, { w: 0.08, h: 0.002, d: 0.022, pos: [cx + dx, yTop + lift + 0.0005, 0], color: [0.02, 0.02, 0.02] });
    }
  }
  return B.build({ name: 'drain' });
}

// ---------------------------------------------------------------- demos
// Curved street: 4 poles 30 m apart along a gentle arc with all wires connected, a strip of
// road and stone walls; opts.slope = street grade (default 0.07, falling towards +x).
function poleLineDemo(opts = {}) {
  const M = materials();
  const Rr = 170, step = 30 / Rr, aEnd = 2.2 * step, grade = num(opts.slope, 0.07);
  const at = (a, off, dy = 0) => v3(Rr * Math.sin(a) - Math.sin(a) * off, grade * Rr * (aEnd - a) + dy, Rr - Rr * Math.cos(a) + Math.cos(a) * off);
  const pts = [0, 1, 2, 3].map((i) => at((i - 1.5) * step, 0));
  const g = poleLine(pts, {
    seed: num(opts.seed, 3),
    each: (i) => ({ transformer: i === 1 ? 1 : 0, light: i % 2 ? 0 : 1, sleeve: i === 2 ? 1 : i === 3 ? 'band' : 0, ad: i === 0 ? 1 : 0, closure: i === 1 ? 1 : 0, coil: i === 2 ? 1 : 0, guy: i === 3 ? 200 : 0 }),
  });
  // road on the street side (+z of the poles = inside of the arc), edge line, stone walls
  const B = new Builder(), rows = [];
  for (let a = -aEnd; a <= aEnd + 1e-6; a += step / 10) rows.push(a);
  const ribbon = (f0, f1, mat, color) => {
    for (let i = 0; i < rows.length - 1; i++) {
      const A = f0(rows[i]), A2 = f0(rows[i + 1]), C2 = f1(rows[i + 1]), C = f1(rows[i]);
      const n = new THREE.Vector3().crossVectors(A2.clone().sub(A), C.clone().sub(A));
      const q = [A, A2, C2, C].map((p) => p.toArray());
      // walls face the road (towards the arc's inside for the near wall, outside for the far one)
      if (f0.face ? f0.face(n) : n.y > 0) B.quad(mat, q[0], q[1], q[2], q[3], { color }); else B.quad(mat, q[0], q[3], q[2], q[1], { color });
    }
  };
  ribbon((a) => at(a, 0.35, 0.004), (a) => at(a, 4.6, 0.004), M.asphalt, [1, 1, 1]);
  ribbon((a) => at(a, 0.55, 0.007), (a) => at(a, 0.67, 0.007), M.paint, [0.9, 0.9, 0.88]);
  const near = Object.assign((a) => at(a, -0.3, 1.15), { face: (n) => n.dot(v3(0, 0, 1)) > 0 });
  const far = Object.assign((a) => at(a, 4.9, 0.9), { face: (n) => n.dot(v3(0, 0, 1)) < 0 });
  ribbon(near, (a) => { const p = at(a, -0.3); p.y = Math.min(p.y, 0); return p; }, M.stoneWall, [1, 1, 1]);
  ribbon(far, (a) => { const p = at(a, 4.9); p.y = Math.min(p.y, 0); return p; }, M.stoneWall, [1, 1, 1]);
  g.add(B.build({ name: 'road' }));
  return g;
}

// Every piece of street furniture in a row (for contact sheets).
function furnitureDemo() {
  const g = new THREE.Group();
  const items = [
    [vending({ color: 'red' }), -6.6, 0, 0], [vending({ color: 'white', seed: 2 }), -4.7, 0, 0], [curveMirror({}), -3.0, 0, 0],
    [postBox({}), -2.1, 0.2, 0], [postBox({ type: 'square' }), -1.35, 0.2, 0], [signPole({ type: 'stop' }), -0.45, 0, 0],
    [signPole({ type: 'speed' }), 0.45, 0, 0], [signPole({ type: 'school' }), 1.3, 0, 0], [bicycle({ seed: 2 }), 2.5, 0.4, Math.PI / 2],
    [bench({}), 4.3, 0.2, 0], [streetLamp({ type: 'small' }), 5.7, -0.3, 0],
    [guardrail({ len: 8 }), 0.5, -2.6, 0], [drain({ len: 7 }), -3.2, 1.6, 0], [laundry({ seed: 4 }), 3.6, -4.8, 0],
  ];
  for (const [o, x, z, r] of items) { o.position.set(x, 0, z); o.rotation.y = r; g.add(o); }
  return g;
}

// The option variants side by side (checking).
function variantsDemo() {
  const g = new THREE.Group();
  const items = [
    [signPole({ type: 'speed' }), -2.4, 0], [signPole({ type: 'school' }), -1.4, 0], [postBox({ type: 'square' }), -0.4, 0.3],
    [curveMirror({ double: 1 }), 0.8, -0.3], [guardrail({ type: 'pipe', len: 4 }), 3.6, 0.2], [laundry({ pole: 'bamboo', seed: 7 }), 1.5, -3.2],
    [streetLamp({ type: 'small' }), -3.4, -0.5],
  ];
  for (const [o, x, z] of items) { o.position.set(x, 0, z); g.add(o); }
  return g;
}

function withInfo(fn) {
  return (opts = {}) => {
    const o = fn(opts);
    if (opts.tris) {
      const b = new THREE.Box3().setFromObject(o), z = b.getSize(new THREE.Vector3());
      console.warn(`[props] tris ${triCount(o)} size ${z.toArray().map((v) => v.toFixed(2)).join(' x ')} min ${b.min.toArray().map((v) => v.toFixed(2)).join(',')}`);
    }
    return o;
  };
}

export const MODELS = Object.fromEntries(Object.entries({
  pole, poleLine: poleLineDemo, vending, curveMirror, postBox, guardrail, streetLamp, signPole, bicycle, laundry, bench, drain,
  furniture: furnitureDemo, variants: variantsDemo,
}).map(([k, f]) => [k, withInfo(f)]));
