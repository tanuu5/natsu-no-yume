// flora: the vegetation kit (see index.js for the conventions).
//
// Everything green in the film comes from here: broadleaf evergreen trees, black
// pines, bamboo, shrubs, hydrangeas, grass, weeds, rice seedlings, potted plants,
// wall creepers and the distant forest impostors.
//
// How it works
// - One painted leaf atlas (Canvas2D, 2048^2): leaf clusters, needle tufts, bamboo
//   sprays, single leaves, florets, blades... plus a matching tangent-space normal
//   atlas (per-leaf tilt + midrib fold, so glossy leaves glint one by one). Alpha is
//   stored with coverage-preserving mipmaps, so alpha-tested foliage keeps its
//   density at distance instead of thinning out.
// - Every plant is built from leaf cards with *bent normals* (pointing out of the
//   crown / pad / mound rather than along the card), baked ambient occlusion in the
//   vertex colour (a volumetric estimate through the crown), and one material per
//   plant type (atlas shared). Stems/twigs of small plants live in solid cells of the
//   same atlas, so most plants are a single mesh.
// - Foliage shader patch (prep): wind sway (height^2, slow; leaves flutter along their
//   normal), no back-face normal flip (the bent normal lights both faces), leaf
//   transmission for back-lit leaves (per light, shadowed), specular occlusion from
//   the baked AO. The same wind runs in a custom depth material so shadows move too.
// - Forest impostors: an atlas of 8 crowns rendered on the CPU from 3D splats
//   (albedo + card-space normal + AO), drawn as camera-facing instanced cards.
//
// Instancing: each model is a Group of meshes (one per material). For many copies use
// makeInstanced(model, count) (copies geometry, material, customDepthMaterial and the
// shadow flags) or do the same by hand: new InstancedMesh(mesh.geometry, mesh.material,
// n) and set .customDepthMaterial = mesh.customDepthMaterial. Rotation about y and
// uniform scale per instance are fine; setColorAt() tints (multiplies) the foliage.
// Wind uses model-space height, so do not bake these meshes into world-space batches.
import * as THREE from 'three';
import { tfbm, tnoise, hashf, clamp01, paintSet, normalFrom, toTex, materials } from '../lib.js';
import { prep } from '../materials.js';
import { U } from '../env.js';
import { rng } from '../noise.js';

// ----------------------------------------------------------------------------
// small helpers
const TAU = Math.PI * 2;
const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(+v) ? d : +v);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const L2S = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055);
const S2L = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  mad: (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};
function rndDir(R) { const z = R() * 2 - 1, a = R() * TAU, s = Math.sqrt(1 - z * z); return [s * Math.cos(a), z, s * Math.sin(a)]; }
function basis(n) {
  const a = Math.abs(n[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  const t = V.norm(V.cross(a, n));
  return [t, V.cross(n, t)];
}
// rotate vector v around unit axis k by angle a
function rotAxis(v, k, a) {
  const c = Math.cos(a), s = Math.sin(a), d = V.dot(k, v), x = V.cross(k, v);
  return [v[0] * c + x[0] * s + k[0] * d * (1 - c), v[1] * c + x[1] * s + k[1] * d * (1 - c), v[2] * c + x[2] * s + k[2] * d * (1 - c)];
}
const mulc = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
// vary a linear colour: brightness +-kb, yellow/blue shift +-kh
function vary(c, R, kb = 0.15, kh = 0.08) {
  const b = 1 + (R() * 2 - 1) * kb, h = (R() * 2 - 1) * kh;
  return [c[0] * b * (1 + h * 1.5), c[1] * b * (1 + h * 0.3), c[2] * b * (1 - h)];
}

// Indexed geometry accumulator (position, normal, uv, color).
// aFlutter: weight of the leaf flutter (1 for leaves / cards, 0 for stems, whose radial
// normals would otherwise inflate them).
class Acc {
  constructor() { this.p = []; this.n = []; this.u = []; this.c = []; this.f = []; this.i = []; this.nv = 0; }
  vert(p, n, uv, c, fl = 1) {
    this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]); this.u.push(uv[0], uv[1]); this.c.push(c[0], c[1], c[2]); this.f.push(fl);
    return this.nv++;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  get tris() { return this.i.length / 3; }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aFlutter', new THREE.Float32BufferAttribute(this.f, 1));
    g.setIndex(this.i);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// ----------------------------------------------------------------------------
// Textures: packing, push-pull fill, coverage-preserving mipmaps

function shelfPack(specs, size) {
  const items = specs.map(([name, w, h]) => ({ name, w, h })).sort((a, b) => b.h - a.h || b.w - a.w);
  let x = 0, y = 0, rowH = 0;
  for (const it of items) {
    if (x + it.w > size) { x = 0; y += rowH; rowH = 0; }
    it.x = x; it.y = y; x += it.w; rowH = Math.max(rowH, it.h);
  }
  if (y + rowH > size) throw new Error('flora atlas overflow');
  const cells = {};
  for (const it of items) cells[it.name] = it;
  return cells;
}

// uv rect of a pixel rect (canvas y down; the textures are uploaded with row 0 = v 0,
// after flipping, so the canvas top is v = 1)
function cellUV(c, S, inset = 0) {
  return { u0: (c.x + inset) / S, u1: (c.x + c.w - inset) / S, v0: 1 - (c.y + c.h - inset) / S, v1: 1 - (c.y + inset) / S };
}
const uvAt = (cell, s, t) => [cell.u0 + (cell.u1 - cell.u0) * s, cell.v0 + (cell.v1 - cell.v0) * t];

// Fill the colour of transparent texels with the surrounding colour (push-pull), so
// filtering at leaf edges never pulls in black. rgba: Uint8ClampedArray, un-premultiplied.
function pushPull(rgba, w, h) {
  const levels = [];
  let cw = w, ch = h;
  let d = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3] / 255;
    d[i * 4] = rgba[i * 4] * a; d[i * 4 + 1] = rgba[i * 4 + 1] * a; d[i * 4 + 2] = rgba[i * 4 + 2] * a; d[i * 4 + 3] = a;
  }
  levels.push({ w: cw, h: ch, d });
  while (cw > 1 || ch > 1) {
    const nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1);
    const nd = new Float32Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const o = (y * nw + x) * 4;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = Math.min(cw - 1, x * 2 + dx), sy = Math.min(ch - 1, y * 2 + dy), so = (sy * cw + sx) * 4;
        nd[o] += d[so] * 0.25; nd[o + 1] += d[so + 1] * 0.25; nd[o + 2] += d[so + 2] * 0.25; nd[o + 3] += d[so + 3] * 0.25;
      }
    }
    cw = nw; ch = nh; d = nd;
    levels.push({ w: cw, h: ch, d });
  }
  // coarsest: un-premultiply
  const top = levels[levels.length - 1].d;
  if (top[3] > 0) { top[0] /= top[3]; top[1] /= top[3]; top[2] /= top[3]; }
  top[3] = 1;
  for (let L = levels.length - 2; L >= 0; L--) {
    const { w: lw, h: lh, d: ld } = levels[L], P = levels[L + 1];
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
      const o = (y * lw + x) * 4, po = ((Math.min(P.h - 1, y >> 1)) * P.w + Math.min(P.w - 1, x >> 1)) * 4;
      const a = ld[o + 3];
      ld[o] += (1 - a) * P.d[po]; ld[o + 1] += (1 - a) * P.d[po + 1]; ld[o + 2] += (1 - a) * P.d[po + 2]; ld[o + 3] = 1;
    }
  }
  const f = levels[0].d;
  for (let i = 0; i < w * h; i++) {
    if (rgba[i * 4 + 3] < 12) { rgba[i * 4] = f[i * 4]; rgba[i * 4 + 1] = f[i * 4 + 1]; rgba[i * 4 + 2] = f[i * 4 + 2]; }
  }
}

// Flip rows (canvas top -> last row) into a new Uint8Array.
function flipRows(src, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(src.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  return out;
}

const _s2l = new Float32Array(256);
for (let i = 0; i < 256; i++) _s2l[i] = S2L(i / 255);

// sRGB colour + alpha texture with a hand-built mip chain: colour averaged in linear
// light; alpha rescaled per rect (cells) so each level keeps the level-0 coverage at
// the 0.5 alpha test. data: Uint8Array RGBA, row 0 = v 0. rects: pixel rects in the
// same (flipped) orientation.
function alphaTestedTexture(data, w, h, rects) {
  const mips = [{ data, width: w, height: h }];
  let lw = w, lh = h;
  let lin = new Float32Array(w * h * 3), al = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lin[i * 3] = _s2l[data[i * 4]]; lin[i * 3 + 1] = _s2l[data[i * 4 + 1]]; lin[i * 3 + 2] = _s2l[data[i * 4 + 2]];
    al[i] = data[i * 4 + 3] / 255;
  }
  const cov = rects.map((r) => {
    let n = 0, c = 0;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { n++; if (al[y * w + x] >= 0.5) c++; }
    return n ? c / n : 0;
  });
  let level = 0;
  while (lw > 1 || lh > 1) {
    level++;
    const nw = Math.max(1, lw >> 1), nh = Math.max(1, lh >> 1);
    const nl = new Float32Array(nw * nh * 3), na = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const o = y * nw + x;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const s = Math.min(lh - 1, y * 2 + dy) * lw + Math.min(lw - 1, x * 2 + dx);
        nl[o * 3] += lin[s * 3] * 0.25; nl[o * 3 + 1] += lin[s * 3 + 1] * 0.25; nl[o * 3 + 2] += lin[s * 3 + 2] * 0.25;
        na[o] += al[s] * 0.25;
      }
    }
    lw = nw; lh = nh; lin = nl; al = na;
    const out = new Uint8Array(lw * lh * 4);
    const scale = new Float32Array(lw * lh).fill(1);
    rects.forEach((r, ri) => {
      const x0 = r.x >> level, y0 = r.y >> level, x1 = Math.max(x0 + 1, (r.x + r.w) >> level), y1 = Math.max(y0 + 1, (r.y + r.h) >> level);
      const vals = [];
      for (let y = y0; y < Math.min(y1, lh); y++) for (let x = x0; x < Math.min(x1, lw); x++) vals.push(al[y * lw + x]);
      if (vals.length < 4 || cov[ri] <= 0) return;
      vals.sort((a, b) => b - a);
      const k = Math.min(vals.length - 1, Math.floor(cov[ri] * vals.length));
      const q = vals[k];
      const sc = q > 1e-4 ? clamp(0.5 / q, 1, 6) : 1;
      for (let y = y0; y < Math.min(y1, lh); y++) for (let x = x0; x < Math.min(x1, lw); x++) scale[y * lw + x] = sc;
    });
    for (let i = 0; i < lw * lh; i++) {
      out[i * 4] = Math.round(L2S(lin[i * 3]) * 255); out[i * 4 + 1] = Math.round(L2S(lin[i * 3 + 1]) * 255); out[i * 4 + 2] = Math.round(L2S(lin[i * 3 + 2]) * 255);
      out[i * 4 + 3] = Math.round(clamp(al[i] * scale[i], 0, 1) * 255);
    }
    mips.push({ data: out, width: lw, height: lh });
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.mipmaps = mips;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

function dataTexture(data, w, h, srgb = false) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

// ----------------------------------------------------------------------------
// Leaf atlas painting (albedo canvas A + normal canvas N, drawn in lockstep)

const cssL = (c, a = 1) => `rgba(${Math.round(clamp01(L2S(c[0])) * 255)},${Math.round(clamp01(L2S(c[1])) * 255)},${Math.round(clamp01(L2S(c[2])) * 255)},${a})`;
// normal in texture space (x right, y up) -> css
const ncss = (n) => {
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return `rgb(${Math.round((n[0] / l * 0.5 + 0.5) * 255)},${Math.round((n[1] / l * 0.5 + 0.5) * 255)},${Math.round((n[2] / l * 0.5 + 0.5) * 255)})`;
};
// leaf-local normal (x along the leaf, y across, canvas y-down) rotated by the canvas angle -> texture space
function nrot(n, a) {
  const c = Math.cos(a), s = Math.sin(a);
  const cx = n[0] * c - n[1] * s, cy = n[0] * s + n[1] * c;
  return [cx, -cy, n[2]];
}

// Half-width profiles (t: 0 at the base, 1 at the tip).
const PROF = {
  ellipse: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.9)), 0.72),
  oval: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.55),
  lance: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.5)), 1.25) * smooth(0, 0.08, t),
  ovate: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.72)), 0.55) * (0.55 + 0.45 * smooth(0, 0.18, t)),
  petal: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.72)), 0.5),
  ray: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.35)), 0.6),
  needle: (t) => 1 - Math.pow(t, 4),
  blade: (t) => (1 - Math.pow(t, 2.2)) * (0.75 + 0.25 * smooth(0, 0.1, t)),
};

function leafOutline(L, W, prof, o = {}) {
  const serr = o.serr || 0, teeth = o.teeth || 16, curl = o.curl || 0, asym = o.asym || 0;
  const n = Math.max(28, Math.round(teeth * 4));
  const up = [], dn = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let w = prof(t) * W * 0.5;
    if (serr) {
      const s = (t * teeth) % 1;
      const saw = s < 0.72 ? s / 0.72 : (1 - s) / 0.28;
      w *= 1 - serr * (1 - saw) * smooth(0.04, 0.22, t) * smooth(1.0, 0.88, t);
    }
    const my = Math.sin(t * Math.PI) * curl * L;
    up.push([t * L, my - w * (1 + asym)]);
    dn.push([t * L, my + w * (1 - asym)]);
  }
  return { up, dn };
}
function outlinePath(o) {
  const p = new Path2D();
  p.moveTo(o.up[0][0], o.up[0][1]);
  for (const q of o.up) p.lineTo(q[0], q[1]);
  for (let i = o.dn.length - 1; i >= 0; i--) p.lineTo(o.dn[i][0], o.dn[i][1]);
  p.closePath();
  return p;
}
function halfPath(o, side) {
  const e = side < 0 ? o.up : o.dn;
  const p = new Path2D();
  p.moveTo(e[0][0], e[0][1]);
  for (const q of e) p.lineTo(q[0], q[1]);
  for (let i = e.length - 1; i >= 0; i--) p.lineTo(e[i][0], (o.up[i][1] + o.dn[i][1]) / 2);
  p.closePath();
  return p;
}

// One leaf: petiole base at (x, y), pointing along canvas angle a, length L, width W.
// o: { prof, c0 (base colour, linear), c1 (tip colour), rib (midrib colour), veins (count),
//      veinC, fold, arch, tilt [along, across], under (show the underside), serr, teeth, curl,
//      petiole (length px), stalkC, edge (rim colour) }
function leaf(P, x, y, a, L, W, o) {
  const ol = leafOutline(L, W, o.prof || PROF.ellipse, o);
  const path = outlinePath(ol);
  const { A, N } = P;
  A.save(); A.translate(x, y); A.rotate(a);
  if (o.petiole) {
    A.strokeStyle = cssL(o.stalkC || o.rib || o.c0); A.lineWidth = Math.max(1.2, W * 0.07); A.lineCap = 'round';
    A.beginPath(); A.moveTo(-o.petiole, 0); A.lineTo(L * 0.05, 0); A.stroke();
  }
  const g = A.createLinearGradient(0, 0, L, 0);
  g.addColorStop(0, cssL(o.c0)); g.addColorStop(1, cssL(o.c1 || o.c0));
  A.fillStyle = g; A.fill(path);
  if (o.shade) { // a darker / lighter half (the fold catches the light differently)
    A.fillStyle = cssL(o.shade, 0.35); A.fill(halfPath(ol, o.shadeSide || 1));
  }
  if (o.edge) { A.strokeStyle = cssL(o.edge, 0.55); A.lineWidth = 1; A.stroke(path); }
  const curl = o.curl || 0;
  const midY = (t) => Math.sin(t * Math.PI) * curl * L;
  if (o.veins) {
    A.strokeStyle = cssL(o.veinC || o.rib || o.c0, o.veinA ?? 0.35); A.lineWidth = Math.max(0.7, W * 0.018);
    A.beginPath();
    for (let k = 1; k <= o.veins; k++) {
      const t = 0.06 + (k / (o.veins + 1)) * 0.82;
      const w = (o.prof || PROF.ellipse)(Math.min(1, t + 0.12)) * W * 0.5 * 0.85;
      for (const s of [-1, 1]) {
        A.moveTo(t * L, midY(t));
        A.quadraticCurveTo((t + 0.05) * L, midY(t) + s * w * 0.6, (t + 0.13) * L, midY(t + 0.13) + s * w);
      }
    }
    A.stroke();
  }
  if (o.rib) {
    A.strokeStyle = cssL(o.rib, o.ribA ?? 0.55); A.lineWidth = Math.max(0.8, W * (o.ribW ?? 0.045));
    A.beginPath(); A.moveTo(0, 0);
    for (let i = 1; i <= 8; i++) { const t = (i / 8) * 0.9; A.lineTo(t * L, midY(t)); }
    A.stroke();
  }
  A.restore();
  N.save(); N.translate(x, y); N.rotate(a);
  const fold = o.fold ?? 0.35, arch = o.arch ?? 0.25, tx = o.tilt ? o.tilt[0] : 0, ty = o.tilt ? o.tilt[1] : 0;
  const und = o.under ? -1 : 1;
  for (const side of [-1, 1]) {
    const fy = -side * fold * und;
    const gg = N.createLinearGradient(0, 0, L, 0);
    gg.addColorStop(0, ncss(nrot([-arch + tx, fy + ty, 1], a)));
    gg.addColorStop(1, ncss(nrot([arch + tx, fy + ty, 1], a)));
    N.fillStyle = gg; N.fill(halfPath(ol, side));
  }
  N.restore();
}

// A stroke on the albedo (and optionally a normal) along a polyline.
function stroke(P, pts, width0, width1, col, nrm = null) {
  const { A, N } = P;
  A.lineCap = 'round'; A.strokeStyle = cssL(col);
  if (nrm) { N.lineCap = 'round'; N.strokeStyle = ncss(nrm); }
  for (let i = 0; i < pts.length - 1; i++) {
    const w = lerp(width0, width1, i / Math.max(1, pts.length - 2));
    A.lineWidth = w; A.beginPath(); A.moveTo(pts[i][0], pts[i][1]); A.lineTo(pts[i + 1][0], pts[i + 1][1]); A.stroke();
    if (nrm) { N.lineWidth = w; N.beginPath(); N.moveTo(pts[i][0], pts[i][1]); N.lineTo(pts[i + 1][0], pts[i + 1][1]); N.stroke(); }
  }
}
// points along a curved twig: start, angle, length, bend (total turn)
function twig(x, y, a, len, bend, n = 16) {
  const pts = [[x, y]];
  let px = x, py = y;
  for (let i = 1; i <= n; i++) {
    const ang = a + bend * (i / n);
    px += Math.cos(ang) * len / n; py += Math.sin(ang) * len / n;
    pts.push([px, py]);
  }
  return { pts, at: (f) => { const i = clamp(f * n, 0, n - 1e-6), k = Math.floor(i), u = i - k; return [lerp(pts[k][0], pts[k + 1][0], u), lerp(pts[k][1], pts[k + 1][1], u)]; }, ang: (f) => a + bend * f };
}

// ---- colours (linear albedo) ----
const COL = {
  treeDark: [0.022, 0.042, 0.014], treeMid: [0.034, 0.062, 0.019], treeYoung: [0.085, 0.13, 0.028], treeUnder: [0.07, 0.09, 0.045], twig: [0.05, 0.036, 0.024],
  bush: [0.036, 0.07, 0.019], bushYoung: [0.08, 0.13, 0.03],
  pine: [0.024, 0.045, 0.02], pineNew: [0.06, 0.1, 0.032], pineTwig: [0.06, 0.045, 0.03],
  bamboo: [0.1, 0.17, 0.034], bambooOld: [0.07, 0.12, 0.028], bambooUnder: [0.12, 0.16, 0.065], bambooDry: [0.2, 0.17, 0.07],
  hyd: [0.042, 0.085, 0.022], ivy: [0.03, 0.06, 0.016],
  grass: [0.07, 0.12, 0.028],
};

// ---- painters: (P, w, h, R) with the context translated to the cell ----
function paintTreeCluster(P, w, h, R, kind) {
  const leafAt = (x, y, a, L, f) => {
    const young = f > 0.78 && R() < 0.5;
    const under = !young && R() < 0.12;
    const base = young ? vary(COL.treeYoung, R, 0.2, 0.1) : under ? vary(COL.treeUnder, R, 0.12) : vary(R() < 0.55 ? COL.treeDark : COL.treeMid, R, 0.18, 0.1);
    const W = L * R.range(0.36, 0.45);
    leaf(P, x, y, a, L, W, {
      prof: PROF.ellipse, c0: base, c1: mulc(base, young ? 1.15 : R.range(0.95, 1.25)), rib: mulc(base, 1.7), ribA: 0.45, veins: young ? 0 : 4, veinA: 0.18,
      fold: R.range(0.25, 0.5), arch: R.range(0.15, 0.4), tilt: [R.range(-0.45, 0.45), R.range(-0.45, 0.45)], under, curl: R.range(-0.06, 0.06), petiole: L * 0.08, stalkC: COL.twig,
    });
  };
  const m = 18; // margin (px)
  const twigs = [];
  if (kind === 0) {
    // rosette: many short twigs radiating from the centre (a branch end seen from outside)
    const cx = w / 2, cy = h / 2, n = 13;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU + R.range(-0.2, 0.2);
      twigs.push(twig(cx + Math.cos(a) * 8, cy + Math.sin(a) * 8, a, w * R.range(0.2, 0.3), R.range(-0.5, 0.5)));
    }
  } else if (kind === 1) {
    // spray: a main twig from the bottom with alternate side twigs
    const main = twig(w * 0.5 + R.range(-12, 12), h - m - 4, -Math.PI / 2 + R.range(-0.12, 0.12), h * 0.62, R.range(-0.35, 0.35));
    twigs.push(main);
    for (let k = 0; k < 9; k++) {
      const f = 0.1 + k * 0.095, s = k % 2 ? 1 : -1;
      const [x, y] = main.at(f);
      twigs.push(twig(x, y, main.ang(f) + s * R.range(0.6, 1.0), w * R.range(0.2, 0.28) * (1 - f * 0.35), -s * R.range(0.15, 0.5)));
    }
  }
  // a leaf mass behind (fills the gaps between twigs)
  const nFill = kind === 2 ? 150 : 34;
  for (let k = 0; k < nFill; k++) {
    const a = R() * TAU, r = Math.sqrt(R()) * w * (kind === 2 ? 0.3 : 0.22);
    // leaves point away from the centre on the rim, any way near the middle
    const dir = r > w * 0.2 ? a + R.range(-1.0, 1.0) : R() * TAU;
    leafAt(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r, dir, R.range(42, 56), kind === 2 ? R() : 0.3);
  }
  for (const t of twigs) stroke(P, t.pts.slice(0, 12), 3.2, 1.2, COL.twig);
  for (const t of twigs) {
    const len = Math.hypot(t.pts[16][0] - t.pts[0][0], t.pts[16][1] - t.pts[0][1]);
    const nl = Math.max(4, Math.round(len / 12));
    for (let i = 0; i < nl; i++) {
      const f = 0.12 + 0.86 * (i / nl);
      const [x, y] = t.at(f);
      const s = i % 2 ? 1 : -1;
      leafAt(x, y, t.ang(f) + s * R.range(0.35, 0.95), R.range(46, 60) * (1 - 0.22 * f), f);
    }
    const [ex, ey] = t.at(1);
    for (let j = 0; j < 2; j++) leafAt(ex, ey, t.ang(1) + R.range(-0.4, 0.4), R.range(34, 46), 1);
  }
}

function paintBush(P, w, h, R) {
  // whorls of small leaves at the shoot tips (azalea / box-leaved shrub), densely overlapping
  const n = 34;
  const pts = [];
  for (let k = 0; k < n; k++) {
    const a = R() * TAU, r = (k < 6 ? R() * 0.12 : Math.sqrt(R()) * 0.36) * w;
    pts.push([w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r * 0.95]);
  }
  pts.sort((p, q) => Math.hypot(q[0] - w / 2, q[1] - h / 2) - Math.hypot(p[0] - w / 2, p[1] - h / 2));
  for (const [x, y] of pts) {
    const m = R.int(5, 8), a0 = R() * TAU;
    const young = R() < 0.25;
    for (let j = 0; j < m; j++) {
      const L = R.range(34, 50);
      const base = young ? vary(COL.bushYoung, R, 0.2) : vary(COL.bush, R, 0.22, 0.1);
      leaf(P, x, y, a0 + (j / m) * TAU + R.range(-0.3, 0.3), L, L * R.range(0.38, 0.5), {
        prof: PROF.oval, c0: base, c1: mulc(base, R.range(1.0, 1.3)), rib: mulc(base, 1.6), ribA: 0.4,
        fold: R.range(0.2, 0.45), arch: R.range(0.2, 0.4), tilt: [R.range(-0.5, 0.5), R.range(-0.5, 0.5)], under: R() < 0.08, petiole: 3,
      });
    }
  }
}

function paintPineSide(P, w, h, R) {
  const { A, N } = P;
  const shoots = R.int(6, 8);
  for (let s = 0; s < shoots; s++) {
    const bx = w * 0.5 + R.range(-0.18, 0.18) * w, by = h * R.range(0.84, 0.96);
    const a = -Math.PI / 2 + ((s + 0.5) / shoots - 0.5) * 2.0 + R.range(-0.15, 0.15);
    const len = h * R.range(0.42, 0.62);
    const t = twig(bx, by, a, len, R.range(-0.3, 0.3));
    stroke(P, t.pts.slice(0, 9), 4, 2.2, COL.pineTwig);
    const nN = 70;
    for (let i = 0; i < nN; i++) {
      const f = 0.3 + 0.7 * Math.pow(i / nN, 0.8);
      const [x, y] = t.at(f);
      const side = R() < 0.5 ? -1 : 1;
      const spread = R.range(0.15, 0.75) * (1.1 - f * 0.4);
      const ang = t.ang(f) + side * spread;
      const L = R.range(55, 95) * (R() < 0.3 ? R.range(0.5, 0.8) : 1);
      const ex = x + Math.cos(ang) * L, ey = y + Math.sin(ang) * L;
      const tipNew = f > 0.85;
      const c = vary(tipNew ? COL.pineNew : COL.pine, R, 0.25, 0.08);
      const gr = A.createLinearGradient(x, y, ex, ey);
      gr.addColorStop(0, cssL(mulc(c, 0.8))); gr.addColorStop(1, cssL(mulc(c, 1.25)));
      A.strokeStyle = gr; A.lineWidth = R.range(1.3, 2.0); A.lineCap = 'round';
      A.beginPath(); A.moveTo(x, y); A.quadraticCurveTo((x + ex) / 2 + R.range(-3, 3), (y + ey) / 2 + R.range(-3, 3), ex, ey); A.stroke();
      const ph = R.range(-1.0, 1.0), px = -Math.sin(ang), py = Math.cos(ang);
      N.strokeStyle = ncss([px * Math.sin(ph), -py * Math.sin(ph), Math.cos(ph)]); N.lineWidth = A.lineWidth + 0.6; N.lineCap = 'round';
      N.beginPath(); N.moveTo(x, y); N.quadraticCurveTo((x + ex) / 2, (y + ey) / 2, ex, ey); N.stroke();
    }
    // bud / candle
    const [ex, ey] = t.at(1);
    leaf(P, ex, ey, t.ang(1), R.range(14, 22), 7, { prof: PROF.oval, c0: [0.16, 0.13, 0.07], c1: [0.2, 0.18, 0.1], fold: 0.3, arch: 0.3 });
  }
}

function paintPineTop(P, w, h, R) {
  const { A, N } = P;
  const n = R.int(8, 10);
  for (let s = 0; s < n; s++) {
    const a = R() * TAU, r = Math.sqrt(R()) * w * 0.26;
    const cx = w / 2 + Math.cos(a) * r, cy = h / 2 + Math.sin(a) * r;
    const nN = 80;
    for (let i = 0; i < nN; i++) {
      const ang = R() * TAU;
      const L = R.range(40, 88) * (R() < 0.35 ? R.range(0.45, 0.8) : 1);
      const r0 = R.range(2, 10);
      const x = cx + Math.cos(ang) * r0, y = cy + Math.sin(ang) * r0;
      const ex = x + Math.cos(ang) * L, ey = y + Math.sin(ang) * L;
      const c = vary(COL.pine, R, 0.25, 0.08);
      const gr = A.createLinearGradient(x, y, ex, ey);
      gr.addColorStop(0, cssL(mulc(c, 0.7))); gr.addColorStop(1, cssL(mulc(c, 1.3)));
      A.strokeStyle = gr; A.lineWidth = R.range(1.3, 2.0); A.lineCap = 'round';
      const bend = R.range(-6, 6);
      A.beginPath(); A.moveTo(x, y); A.quadraticCurveTo((x + ex) / 2 - Math.sin(ang) * bend, (y + ey) / 2 + Math.cos(ang) * bend, ex, ey); A.stroke();
      // needles radiate and arch: normals tilt outward along the needle, random roll
      const ph = R.range(-0.9, 0.9), px = -Math.sin(ang), py = Math.cos(ang);
      const out = 0.35;
      N.strokeStyle = ncss([Math.cos(ang) * out + px * Math.sin(ph), -(Math.sin(ang) * out + py * Math.sin(ph)), Math.cos(ph)]);
      N.lineWidth = A.lineWidth + 0.6; N.lineCap = 'round';
      N.beginPath(); N.moveTo(x, y); N.quadraticCurveTo((x + ex) / 2 - Math.sin(ang) * bend, (y + ey) / 2 + Math.cos(ang) * bend, ex, ey); N.stroke();
    }
    // the shoot's candle (new growth) seen from above
    A.fillStyle = cssL(vary(COL.pineNew, R, 0.2)); A.beginPath(); A.arc(cx, cy, R.range(5, 8), 0, TAU); A.fill();
    A.fillStyle = cssL([0.16, 0.13, 0.07]); A.beginPath(); A.arc(cx, cy, 3, 0, TAU); A.fill();
  }
}

function paintBamboo(P, w, h, R, kind) {
  // branchlets from the top-left corner (the attachment point); leaves hang from their nodes in
  // palmate fans of 4-7. kind 0: one long branchlet, kind 1: two shorter ones fanning out
  const twigs = kind === 0
    ? [twig(w * 0.08, h * 0.06, R.range(0.3, 0.5), w * 0.88, R.range(0.25, 0.5))]
    : [twig(w * 0.08, h * 0.06, R.range(0.15, 0.3), w * 0.72, R.range(0.1, 0.35)), twig(w * 0.08, h * 0.06, R.range(0.75, 0.95), h * 0.62, R.range(-0.3, 0.1))];
  for (const t of twigs) stroke(P, t.pts, 3, 1.4, [0.09, 0.1, 0.035]);
  for (const t of twigs) {
    // leaves alternate along the twig in small hanging groups (a narrow fan, all drooping
    // to the same side), denser toward the tip
    const nL = kind === 0 ? 26 : 16;
    for (let j = 0; j < nL; j++) {
      const f = 0.14 + 0.86 * Math.pow(j / (nL - 1), 0.8);
      const [x, y] = t.at(f);
      const ta = t.ang(f);
      const side = j % 2 ? 1 : -1;
      // hang down and forward along the twig
      const a = lerp(ta, Math.PI / 2, R.range(0.35, 0.7)) + side * R.range(0.15, 0.45);
      const L = R.range(125, 175) * (f > 0.9 ? 0.85 : 1);
      const W = L * R.range(0.13, 0.17);
      const old = R() < 0.3, under = R() < 0.2;
      const base = under ? vary(COL.bambooUnder, R, 0.12) : vary(old ? COL.bambooOld : COL.bamboo, R, 0.16, 0.12);
      const dry = R() < 0.25;
      leaf(P, x, y, a, L, W, {
        prof: PROF.lance, c0: base, c1: dry ? lerpC(base, COL.bambooDry, 0.8) : mulc(base, R.range(1.0, 1.25)), rib: mulc(base, 1.5), ribA: 0.35, ribW: 0.06,
        fold: R.range(0.3, 0.55), arch: R.range(0.2, 0.45), tilt: [R.range(-0.3, 0.3), R.range(-0.4, 0.4)], under, curl: R.range(-0.08, 0.08) * side, petiole: 6, stalkC: [0.09, 0.1, 0.035],
      });
    }
  }
}

function paintHydLeaf(P, w, h, R) {
  const base = COL.hyd;
  leaf(P, w / 2, h - 10, -Math.PI / 2, h - 26, w * 0.78, {
    prof: PROF.ovate, c0: mulc(base, 0.95), c1: mulc(base, 1.12), rib: [0.12, 0.17, 0.06], ribA: 0.6, ribW: 0.025, veins: 8, veinC: [0.1, 0.15, 0.05], veinA: 0.45,
    serr: 0.08, teeth: 26, fold: 0.3, arch: 0.35, edge: mulc(base, 0.7), petiole: 8, stalkC: [0.07, 0.11, 0.035],
  });
  // quilting: faint darker blotches between veins
  const { A } = P;
  A.globalCompositeOperation = 'source-atop';
  for (let k = 0; k < 40; k++) {
    A.fillStyle = cssL(mulc(base, R.range(0.75, 1.2)), 0.18);
    A.beginPath(); A.ellipse(w / 2 + R.range(-0.3, 0.3) * w, R.range(0.15, 0.9) * h, R.range(6, 16), R.range(6, 16), 0, 0, TAU); A.fill();
  }
  A.globalCompositeOperation = 'source-over';
}

function paintIvy(P, w, h, R, kind) {
  // kind 0: Boston ivy (ツタ) - three pointed, toothed lobes; kind 1: Japanese ivy (キヅタ) - five shallow lobes
  const { A, N } = P;
  const cx = w / 2, cy = h * 0.62;
  const lobes = kind === 0 ? [[-Math.PI / 2, 1.0, 0.75], [-Math.PI / 2 - 1.15, 0.78, 0.62], [-Math.PI / 2 + 1.15, 0.78, 0.62]]
    : [[-Math.PI / 2, 1.0, 0.7], [-Math.PI / 2 - 0.85, 0.82, 0.6], [-Math.PI / 2 + 0.85, 0.82, 0.6], [-Math.PI / 2 - 1.75, 0.6, 0.55], [-Math.PI / 2 + 1.75, 0.6, 0.55]];
  const R0 = h * 0.52;
  const rf = (th) => {
    let r = kind === 0 ? 0.36 : 0.5;
    for (const [la, sz, wd] of lobes) {
      const d = Math.abs(Math.atan2(Math.sin(th - la), Math.cos(th - la)));
      r = Math.max(r, sz * Math.pow(Math.max(0, 1 - d / wd), kind === 0 ? 1.15 : 1.4) * (kind === 0 ? 1 : 0.55) + (kind === 0 ? 0 : 0.45 * sz));
    }
    const db = Math.atan2(Math.sin(th - Math.PI / 2), Math.cos(th - Math.PI / 2));
    r *= 1 - 0.5 * Math.exp(-((db / 0.32) ** 2));
    // teeth
    if (kind === 0) r *= 1 - 0.05 * Math.abs(((th * 7.5 / Math.PI) % 1) - 0.5) * 2;
    return r * R0;
  };
  const path = new Path2D();
  const n = 180;
  for (let i = 0; i <= n; i++) {
    const th = (i / n) * TAU;
    const r = rf(th);
    const x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
    if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
  }
  path.closePath();
  const base = vary(COL.ivy, R, 0.08);
  const g = A.createRadialGradient(cx, cy, 5, cx, cy, R0);
  g.addColorStop(0, cssL(mulc(base, 1.2))); g.addColorStop(1, cssL(mulc(base, 0.85)));
  A.fillStyle = g; A.fill(path);
  A.strokeStyle = cssL(mulc(base, 0.6), 0.6); A.lineWidth = 1.2; A.stroke(path);
  // palmate veins with side veins
  A.save(); A.clip(path);
  A.strokeStyle = cssL([0.08, 0.12, 0.045], 0.55); A.lineWidth = 2;
  for (const [la, sz] of lobes) {
    const ex = cx + Math.cos(la) * R0 * sz * 0.92, ey = cy + Math.sin(la) * R0 * sz * 0.92;
    A.beginPath(); A.moveTo(cx, cy); A.lineTo(ex, ey); A.stroke();
    A.lineWidth = 1; A.strokeStyle = cssL([0.07, 0.1, 0.04], 0.35);
    for (let k = 1; k <= 4; k++) {
      const t = k / 5, px = lerp(cx, ex, t), py = lerp(cy, ey, t);
      for (const sd of [-1, 1]) { const aa = la + sd * 0.7; A.beginPath(); A.moveTo(px, py); A.lineTo(px + Math.cos(aa) * R0 * 0.22 * (1 - t * 0.5), py + Math.sin(aa) * R0 * 0.22 * (1 - t * 0.5)); A.stroke(); }
    }
    A.lineWidth = 2; A.strokeStyle = cssL([0.08, 0.12, 0.045], 0.55);
  }
  A.restore();
  A.strokeStyle = cssL([0.06, 0.05, 0.03]); A.lineWidth = 3; A.beginPath(); A.moveTo(cx, cy); A.lineTo(cx + 2, h - 4); A.stroke();
  // normals: each lobe is folded along its main vein (both halves tilt toward the vein) and cupped
  N.save(); N.clip(path);
  for (let i = 0; i < 96; i++) {
    const a0 = (i / 96) * TAU, a1 = ((i + 1) / 96) * TAU, am = (a0 + a1) / 2;
    let best = lobes[0], bd = 9;
    for (const lb of lobes) { const d = Math.atan2(Math.sin(am - lb[0]), Math.cos(am - lb[0])); if (Math.abs(d) < Math.abs(bd)) { bd = d; best = lb; } }
    const side = Math.sign(bd) || 1;
    const perp = best[0] + side * Math.PI / 2;
    const fold = 0.32, cup = 0.22;
    const nx = -Math.cos(perp) * fold + Math.cos(am) * cup, ny = -Math.sin(perp) * fold + Math.sin(am) * cup;
    N.fillStyle = ncss([nx, -ny, 1]);
    N.beginPath(); N.moveTo(cx, cy); N.arc(cx, cy, R0 * 1.2, a0, a1 + 0.01); N.closePath(); N.fill();
  }
  N.restore();
}

function drawFloret(P, cx, cy, size, R, shade = 1) {
  const a0 = R.range(0, TAU);
  for (let k = 0; k < 4; k++) {
    const a = a0 + k * Math.PI / 2 + R.range(-0.1, 0.1);
    const L = size * R.range(0.46, 0.53);
    leaf(P, cx, cy, a, L, L * R.range(0.95, 1.1), {
      prof: PROF.petal, c0: mulc([0.88, 0.88, 0.9], shade), c1: mulc([0.64, 0.64, 0.7], shade), rib: [0.55, 0.55, 0.62], ribA: 0.2, veins: 4, veinC: [0.55, 0.55, 0.62], veinA: 0.14,
      fold: 0.12, arch: 0.35, tilt: [0.15, 0],
    });
  }
  const { A } = P;
  for (let k = 0; k < 5; k++) {
    A.fillStyle = cssL(mulc([0.78, 0.8, 0.72], shade));
    A.beginPath(); A.arc(cx + R.range(-0.025, 0.025) * size, cy + R.range(-0.025, 0.025) * size, R.range(0.015, 0.024) * size, 0, TAU); A.fill();
  }
}
function paintFloret(P, w, h, R) { drawFloret(P, w / 2, h / 2, w * 0.94, R); }
function paintFloretCluster(P, w, h, R) {
  // a patch of the mophead: overlapping florets, the back ones a little darker
  const pts = [];
  for (let k = 0; k < 11; k++) { const a = R() * TAU, r = Math.sqrt(R()) * w * 0.3; pts.push([w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r, R()]); }
  pts.sort((p, q) => p[2] - q[2]);
  for (const [x, y, z] of pts) drawFloret(P, x, y, w * R.range(0.34, 0.42), R, 0.8 + 0.25 * z);
}
function paintHydCluster(P, w, h, R) {
  // a leafy hydrangea shoot: stem with opposite pairs of big serrated leaves
  const base = COL.hyd;
  const opt = (L, c, under = false) => ({
    prof: PROF.ovate, c0: mulc(c, 0.95), c1: mulc(c, 1.12), rib: [0.12, 0.17, 0.06], ribA: 0.55, ribW: 0.025, veins: 7, veinC: [0.1, 0.15, 0.05], veinA: 0.4,
    serr: 0.08, teeth: 20, fold: R.range(0.25, 0.4), arch: R.range(0.25, 0.45), edge: mulc(c, 0.7), petiole: L * 0.08, stalkC: [0.07, 0.11, 0.035],
    tilt: [R.range(-0.3, 0.3), R.range(-0.3, 0.3)], under,
  });
  // leaves behind (filling)
  for (let k = 0; k < 5; k++) {
    const a = R() * TAU, r = R.range(0, w * 0.18);
    const L = R.range(120, 160);
    leaf(P, w / 2 + Math.cos(a) * r, h * 0.55 + Math.sin(a) * r, R() * TAU, L, L * 0.6, opt(L, vary(mulc(base, 0.85), R, 0.12, 0.08)));
  }
  const stemTop = h * 0.3;
  stroke(P, [[w / 2, h - 12], [w / 2 + R.range(-10, 10), (h + stemTop) / 2], [w / 2 + R.range(-15, 15), stemTop]], 6, 3.5, [0.07, 0.12, 0.035]);
  for (let k = 0; k < 3; k++) {
    const y = lerp(h * 0.78, h * 0.4, k / 2);
    for (const sd of [-1, 1]) {
      const L = R.range(140, 180) * (1 - k * 0.12);
      const a = -Math.PI / 2 + sd * R.range(0.7, 1.3) + (k % 2 ? 0.25 * sd : 0);
      leaf(P, w / 2 + sd * 3, y, a, L, L * R.range(0.55, 0.65), opt(L, vary(base, R, 0.12, 0.08), R() < 0.12));
    }
    // a leaf of the crossing pair, seen foreshortened (pointing at the viewer)
    const L2 = R.range(80, 110);
    leaf(P, w / 2, y - 6, -Math.PI / 2 + R.range(-0.5, 0.5), L2, L2 * 0.95, { ...opt(L2, vary(base, R, 0.1, 0.06)), prof: PROF.oval, serr: 0.06, teeth: 14 });
  }
  for (let j = 0; j < 2; j++) leaf(P, w / 2, stemTop, -Math.PI / 2 + (j ? 0.4 : -0.4), 70, 40, opt(70, COL.bushYoung));
}

function paintDaisy(P, w, h, R) {
  const cx = w / 2, cy = h / 2;
  const n = 46;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU + R.range(-0.05, 0.05);
    const L = w * R.range(0.34, 0.43);
    leaf(P, cx + Math.cos(a) * 9, cy + Math.sin(a) * 9, a, L, R.range(3.2, 4.4), {
      prof: PROF.ray, c0: [0.82, 0.8, 0.84], c1: R() < 0.2 ? [0.78, 0.7, 0.86] : [0.86, 0.85, 0.88], fold: 0.1, arch: 0.4, tilt: [0.2, 0],
    });
  }
  const { A, N } = P;
  const g = A.createRadialGradient(cx - 2, cy - 2, 1, cx, cy, 13);
  g.addColorStop(0, cssL([0.75, 0.55, 0.05])); g.addColorStop(1, cssL([0.5, 0.3, 0.02]));
  A.fillStyle = g; A.beginPath(); A.arc(cx, cy, 13, 0, TAU); A.fill();
  const gn = N.createRadialGradient(cx, cy, 0, cx, cy, 13);
  gn.addColorStop(0, ncss([0, 0, 1])); gn.addColorStop(1, ncss([0.5, 0, 1]));
  N.fillStyle = gn; N.beginPath(); N.arc(cx, cy, 13, 0, TAU); N.fill();
}

function paintDayflower(P, w, h, R) {
  const cx = w / 2, cy = h * 0.55;
  for (const s of [-1, 1]) {
    leaf(P, cx, cy, -Math.PI / 2 + s * 0.55, w * 0.4, w * 0.38, { prof: PROF.petal, c0: [0.08, 0.16, 0.7], c1: [0.1, 0.22, 0.85], fold: 0.1, arch: 0.3, veins: 3, veinC: [0.05, 0.1, 0.5], veinA: 0.3 });
  }
  leaf(P, cx, cy, Math.PI / 2, w * 0.2, w * 0.14, { prof: PROF.petal, c0: [0.7, 0.72, 0.75], fold: 0.1 });
  const { A } = P;
  A.strokeStyle = cssL([0.7, 0.55, 0.05]); A.lineWidth = 1.5;
  for (let k = 0; k < 5; k++) { A.beginPath(); A.moveTo(cx, cy); A.lineTo(cx + R.range(-14, 14), cy + R.range(6, 16)); A.stroke(); }
}

function paintFoxtail(P, w, h, R) {
  // a nodding bristly spike, from the stem at the bottom centre arching to one side
  const { A, N } = P;
  const t = twig(w * 0.35, h * 0.98, -Math.PI / 2 + 0.15, h * 0.9, 1.1, 24);
  stroke(P, t.pts.slice(0, 8), 2.4, 2.0, [0.1, 0.14, 0.04]);
  for (let i = 0; i < 520; i++) {
    const f = 0.25 + 0.75 * R();
    const [x, y] = t.at(f);
    const tap = Math.sin(Math.PI * clamp((f - 0.22) / 0.78, 0, 1)) ** 0.6;
    const ang = t.ang(f) + (R() < 0.5 ? -1 : 1) * R.range(0.5, 1.3);
    const L = R.range(6, 17) * tap;
    const c = R() < 0.5 ? [0.2, 0.26, 0.08] : [0.28, 0.3, 0.16];
    A.strokeStyle = cssL(vary(c, R, 0.2)); A.lineWidth = 1;
    A.beginPath(); A.moveTo(x, y); A.lineTo(x + Math.cos(ang) * L, y + Math.sin(ang) * L); A.stroke();
    N.strokeStyle = ncss([Math.cos(ang) * 0.5, -Math.sin(ang) * 0.5, 1]); N.lineWidth = 1.2;
    N.beginPath(); N.moveTo(x, y); N.lineTo(x + Math.cos(ang) * L, y + Math.sin(ang) * L); N.stroke();
  }
  // dense core
  for (let i = 0; i < 24; i++) {
    const f = 0.28 + 0.68 * (i / 24);
    const [x, y] = t.at(f);
    A.fillStyle = cssL([0.09, 0.14, 0.035]); A.beginPath(); A.arc(x, y, 3.5 * Math.sin(Math.PI * clamp((f - 0.22) / 0.78, 0, 1)) + 1, 0, TAU); A.fill();
  }
}

function paintPanicle(P, w, h, R) {
  const { A } = P;
  const t = twig(w * 0.5, h * 0.99, -Math.PI / 2 + R.range(-0.1, 0.1), h * 0.92, R.range(-0.3, 0.3), 24);
  stroke(P, t.pts, 1.8, 1.0, [0.16, 0.16, 0.07]);
  for (let k = 0; k < 11; k++) {
    const f = 0.25 + (k / 11) * 0.72;
    const [x, y] = t.at(f);
    const s = k % 2 ? 1 : -1;
    const b = twig(x, y, t.ang(f) + s * R.range(0.35, 0.7), h * R.range(0.12, 0.26) * (1.1 - f * 0.6), -s * 0.3, 8);
    stroke(P, b.pts, 1.0, 0.8, [0.18, 0.17, 0.08]);
    for (let j = 0; j < 7; j++) {
      const g = 0.2 + 0.8 * (j / 7);
      const [sx, sy] = b.at(g);
      const c = R() < 0.3 ? [0.22, 0.12, 0.14] : vary([0.2, 0.2, 0.09], R, 0.25);
      leaf(P, sx, sy, b.ang(g) + R.range(-0.4, 0.4), R.range(7, 11), 3.2, { prof: PROF.oval, c0: c, fold: 0.3 });
    }
  }
}

function paintBlades(P, w, h, R, n) {
  const bw = w / n;
  const { A, N } = P;
  for (let i = 0; i < n; i++) {
    const x0 = i * bw;
    const dry = i === n - 1 ? 1 : i === n - 2 ? 0.4 : 0;
    const base = vary(COL.grass, R, 0.1, 0.1);
    const path = new Path2D();
    const m = 40;
    for (let k = 0; k <= m; k++) { const t = k / m, hw = (bw * 0.5 - 3) * PROF.blade(t); const y = h - 4 - t * (h - 10); if (k === 0) path.moveTo(x0 + bw / 2 - hw, y); else path.lineTo(x0 + bw / 2 - hw, y); }
    for (let k = m; k >= 0; k--) { const t = k / m, hw = (bw * 0.5 - 3) * PROF.blade(t); path.lineTo(x0 + bw / 2 + hw, h - 4 - t * (h - 10)); }
    path.closePath();
    const g = A.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, cssL(mulc(base, 0.75)));
    g.addColorStop(0.5, cssL(base));
    g.addColorStop(0.85, cssL(dry ? lerpC(base, [0.22, 0.18, 0.08], dry * 0.7) : mulc(base, 1.15)));
    g.addColorStop(1, cssL(dry ? [0.25, 0.2, 0.09] : mulc(base, 1.2)));
    A.fillStyle = g; A.fill(path);
    A.strokeStyle = cssL(mulc(base, 1.5), 0.5); A.lineWidth = 1.5;
    A.beginPath(); A.moveTo(x0 + bw / 2, h - 4); A.lineTo(x0 + bw / 2, 20); A.stroke();
    // fold: two halves tilted toward the midrib
    N.save(); N.clip(path);
    N.fillStyle = ncss([0.35, 0, 1]); N.fillRect(x0, 0, bw / 2, h);
    N.fillStyle = ncss([-0.35, 0, 1]); N.fillRect(x0 + bw / 2, 0, bw / 2, h);
    N.restore();
  }
}
const lerpC = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function paintMugwort(P, w, h, R) {
  // pinnately lobed leaf (ヨモギ): a central lamina with 2-3 pairs of lobes
  const base = [0.04, 0.07, 0.03];
  const cx = w / 2, by = h - 8;
  const L = h - 24;
  const opt = (c) => ({ prof: PROF.oval, c0: c, c1: mulc(c, 1.12), rib: [0.1, 0.12, 0.08], ribA: 0.5, fold: 0.3, arch: 0.25, edge: [0.12, 0.13, 0.1] });
  for (let k = 0; k < 3; k++) {
    const f = 0.3 + k * 0.2;
    for (const s of [-1, 1]) {
      leaf(P, cx, by - f * L, -Math.PI / 2 + s * R.range(0.8, 1.1), L * (0.34 - k * 0.05), L * 0.16, opt(vary(base, R, 0.08)));
    }
  }
  leaf(P, cx, by, -Math.PI / 2, L, L * 0.22, { ...opt(base), petiole: 6 });
}

function paintClover(P, w, h, R) {
  const { A } = P;
  for (let k = 0; k < 16; k++) {
    const x = w * R.range(0.15, 0.85), y = h * R.range(0.15, 0.85);
    const a0 = R() * TAU, s = R.range(0.8, 1.2);
    for (let j = 0; j < 3; j++) {
      const a = a0 + j * TAU / 3;
      const base = vary([0.045, 0.1, 0.03], R, 0.15);
      leaf(P, x, y, a, 22 * s, 24 * s, { prof: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.6)), 0.4) * (1 - 0.35 * smooth(0.85, 1, t)), c0: base, c1: base, fold: 0.25, arch: 0.2, tilt: [R.range(-0.3, 0.3), R.range(-0.3, 0.3)] });
      // pale chevron mark
      A.strokeStyle = cssL([0.2, 0.26, 0.15], 0.6); A.lineWidth = 2;
      A.beginPath(); A.arc(x + Math.cos(a) * 11 * s, y + Math.sin(a) * 11 * s, 5 * s, a + 1.2, a + 5.1); A.stroke();
    }
  }
  // white clover flower heads
  for (let k = 0; k < 2; k++) {
    const x = w * R.range(0.25, 0.75), y = h * R.range(0.25, 0.75);
    for (let j = 0; j < 40; j++) {
      const a = R() * TAU, r = Math.sqrt(R()) * 13;
      leaf(P, x + Math.cos(a) * r * 0.3, y + Math.sin(a) * r * 0.3, a, 6 + r * 0.4, 3, { prof: PROF.oval, c0: [0.75, 0.74, 0.7], c1: [0.8, 0.78, 0.7], fold: 0.1 });
    }
  }
}

function paintGeranium(P, w, h, R) {
  const cx = w / 2, cy = h / 2;
  const { A } = P;
  const fl = [];
  for (let k = 0; k < 15; k++) { const a = R() * TAU, r = Math.sqrt(R()) * w * 0.3; fl.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  fl.sort((p, q) => Math.hypot(q[0] - cx, q[1] - cy) - Math.hypot(p[0] - cx, p[1] - cy));
  for (const [x, y] of fl) {
    const a0 = R() * TAU, s = R.range(0.85, 1.1);
    for (let j = 0; j < 5; j++) {
      const a = a0 + j * TAU / 5;
      leaf(P, x, y, a, 26 * s, 22 * s, { prof: PROF.petal, c0: [0.75, 0.72, 0.72], c1: [0.9, 0.88, 0.88], veins: 2, veinC: [0.5, 0.45, 0.45], veinA: 0.25, fold: 0.1, arch: 0.3, tilt: [0.2, 0] });
    }
    A.fillStyle = cssL([0.9, 0.9, 0.85]); A.beginPath(); A.arc(x, y, 3, 0, TAU); A.fill();
  }
}

function paintRoundLeaf(P, w, h, R, zonal) {
  const { A, N } = P;
  const cx = w / 2, cy = h * 0.5, r0 = w * 0.44;
  const path = new Path2D();
  for (let i = 0; i <= 90; i++) {
    const th = (i / 90) * TAU;
    let r = r0 * (1 + 0.06 * Math.sin(th * 9)) * (1 - 0.35 * Math.exp(-((Math.atan2(Math.sin(th - Math.PI / 2), Math.cos(th - Math.PI / 2)) / 0.3) ** 2)));
    const x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
    if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
  }
  path.closePath();
  const base = [0.05, 0.1, 0.03];
  A.fillStyle = cssL(base); A.fill(path);
  if (zonal) { A.save(); A.clip(path); A.strokeStyle = cssL([0.035, 0.04, 0.02], 0.7); A.lineWidth = r0 * 0.16; A.beginPath(); A.arc(cx, cy, r0 * 0.55, 0, TAU); A.stroke(); A.restore(); }
  A.strokeStyle = cssL([0.1, 0.15, 0.06], 0.45); A.lineWidth = 1.4;
  for (let k = 0; k < 9; k++) { const a = -Math.PI / 2 + (k - 4) * 0.62; A.beginPath(); A.moveTo(cx, cy); A.lineTo(cx + Math.cos(a) * r0 * 0.9, cy + Math.sin(a) * r0 * 0.9); A.stroke(); }
  for (let i = 0; i < 36; i++) {
    const a0 = (i / 36) * TAU, a1 = ((i + 1) / 36) * TAU, am = (a0 + a1) / 2;
    N.save(); N.clip(path);
    N.fillStyle = ncss([Math.cos(am) * 0.3, -Math.sin(am) * 0.3, 1]);
    N.beginPath(); N.moveTo(cx, cy); N.arc(cx, cy, r0 * 1.2, a0, a1 + 0.01); N.closePath(); N.fill();
    N.restore();
  }
}

function paintHeartLeaf(P, w, h, R) {
  const base = [0.05, 0.11, 0.03];
  const { A, N } = P;
  const cx = w / 2, by = h * 0.8, L = h * 0.74;
  const path = new Path2D();
  // cordate: two rounded lobes at the base, pointed tip
  const n = 80;
  for (let i = 0; i <= n; i++) {
    const t = i / n, th = t * TAU;
    const x = Math.sin(th), y = -Math.cos(th);
    // heart curve
    const hx = 16 * Math.pow(Math.sin(th), 3), hy = 13 * Math.cos(th) - 5 * Math.cos(2 * th) - 2 * Math.cos(3 * th) - Math.cos(4 * th);
    const px = cx + hx * L / 34, py = by - 5 - (hy + 17) * L / 36;
    if (i === 0) path.moveTo(px, py); else path.lineTo(px, py);
    void x; void y;
  }
  path.closePath();
  // the heart curve points down: flip so the tip points up
  A.save(); A.translate(0, h); A.scale(1, -1);
  A.translate(0, h * 0.06);
  const g = A.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, cssL(mulc(base, 1.1))); g.addColorStop(1, cssL(mulc(base, 0.9)));
  A.fillStyle = g; A.fill(path);
  A.strokeStyle = cssL([0.12, 0.18, 0.07], 0.5); A.lineWidth = 1.5;
  for (let k = 0; k < 5; k++) { const a = Math.PI / 2 + (k - 2) * 0.55; A.beginPath(); A.moveTo(cx, by - L * 0.72); A.lineTo(cx + Math.cos(a) * L * 0.5, by - L * 0.72 + Math.sin(a) * L * 0.6); A.stroke(); }
  A.restore();
  N.save(); N.translate(0, h); N.scale(1, -1); N.translate(0, h * 0.06);
  N.fillStyle = ncss([0.3, 0, 1]); N.save(); N.clip(path); N.fillRect(0, 0, cx, h); N.fillStyle = ncss([-0.3, 0, 1]); N.fillRect(cx, 0, w - cx, h); N.restore();
  N.restore();
  void R;
}

function paintBroadLeaf(P, w, h, R) {
  const base = [0.035, 0.08, 0.022];
  leaf(P, w / 2, h - 6, -Math.PI / 2, h - 16, w * 0.62, {
    prof: PROF.ellipse, c0: mulc(base, 0.9), c1: mulc(base, 1.1), rib: [0.09, 0.13, 0.05], ribA: 0.55, ribW: 0.03, veins: 14, veinC: [0.07, 0.12, 0.04], veinA: 0.2, fold: 0.35, arch: 0.3, petiole: 4,
  });
  void R;
}

function paintMorningGlory(P, w, h, R, col) {
  const { A, N } = P;
  const cx = w / 2, cy = h / 2, r0 = w * 0.46;
  const path = new Path2D();
  for (let i = 0; i <= 100; i++) {
    const th = (i / 100) * TAU;
    const r = r0 * (1 - 0.05 * Math.pow(Math.abs(Math.cos(th * 2.5)), 3));
    const x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
    if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
  }
  path.closePath();
  const g = A.createRadialGradient(cx, cy, 0, cx, cy, r0);
  g.addColorStop(0, cssL([0.85, 0.85, 0.7]));
  g.addColorStop(0.18, cssL([0.82, 0.82, 0.85]));
  g.addColorStop(0.42, cssL(lerpC([0.82, 0.82, 0.85], col, 0.8)));
  g.addColorStop(0.75, cssL(col));
  g.addColorStop(1, cssL(mulc(col, 0.85)));
  A.fillStyle = g; A.fill(path);
  // five pale star rays (the folds of the corolla)
  A.save(); A.clip(path);
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI / 2 + k * TAU / 5;
    A.strokeStyle = cssL(lerpC(col, [0.85, 0.85, 0.9], 0.45), 0.7); A.lineWidth = 5;
    A.beginPath(); A.moveTo(cx, cy); A.lineTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); A.stroke();
  }
  A.restore();
  // funnel: normals point outward from the centre, steeper near the throat
  const gn = N.createRadialGradient(cx, cy, 0, cx, cy, r0);
  gn.addColorStop(0, ncss([0, 0, 1]));
  N.save(); N.clip(path);
  for (let i = 0; i < 40; i++) {
    const a0 = (i / 40) * TAU, a1 = ((i + 1) / 40) * TAU, am = (a0 + a1) / 2;
    N.fillStyle = ncss([-Math.cos(am) * 0.45, Math.sin(am) * 0.45, 1]);
    N.beginPath(); N.moveTo(cx, cy); N.arc(cx, cy, r0 * 1.1, a0, a1 + 0.01); N.closePath(); N.fill();
  }
  N.restore();
  void R;
}

function paintSolid(P, w, h, R, col) {
  const { A } = P;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) { A.fillStyle = cssL(vary(col, R, 0.08, 0.03)); A.fillRect(x, y, 2, 2); }
}

// Build (once) the leaf atlas: { map, normal, cells: name -> uv rect, S }.
let ATLAS = null;
const ATLAS_SPECS = [
  ['tree0', 512, 512], ['tree1', 512, 512], ['tree2', 512, 512], ['bush', 512, 512], ['pineSide', 512, 512], ['pineTop', 512, 512], ['bamboo0', 512, 512], ['bamboo1', 512, 512],
  ['hydLeaf', 256, 384], ['broadLeaf', 192, 384], ['blades', 384, 512],
  ['ivy0', 256, 256], ['ivy1', 256, 256], ['mugwort', 128, 256], ['clover', 256, 256], ['geranium', 256, 256], ['geraniumLeaf', 256, 256], ['heartLeaf', 256, 256],
  ['mgBlue', 192, 192], ['mgPurple', 192, 192], ['mgPink', 192, 192],
  ['foxtail', 128, 256], ['panicle', 128, 256],
  ['floret', 128, 128], ['daisy', 128, 128], ['dayflower', 128, 128], ['hydCluster', 512, 512], ['floretCluster', 256, 256],
  ['stemG', 32, 32], ['stemB', 32, 32], ['stemY', 32, 32], ['soil', 64, 64],
];
function leafAtlas() {
  if (ATLAS) return ATLAS;
  const S = 2048;
  const cells = shelfPack(ATLAS_SPECS, S);
  const ca = document.createElement('canvas'); ca.width = ca.height = S;
  const cn = document.createElement('canvas'); cn.width = cn.height = S;
  const A = ca.getContext('2d', { willReadFrequently: true }), N = cn.getContext('2d', { willReadFrequently: true });
  N.fillStyle = 'rgb(128,128,255)'; N.fillRect(0, 0, S, S);
  const R = rng(20260928);
  const paint = (name, fn) => {
    const c = cells[name];
    A.save(); N.save();
    A.beginPath(); A.rect(c.x, c.y, c.w, c.h); A.clip(); A.translate(c.x, c.y);
    N.beginPath(); N.rect(c.x, c.y, c.w, c.h); N.clip(); N.translate(c.x, c.y);
    fn({ A, N }, c.w, c.h, R);
    A.restore(); N.restore();
  };
  paint('tree0', (P, w, h, R) => paintTreeCluster(P, w, h, R, 0));
  paint('tree1', (P, w, h, R) => paintTreeCluster(P, w, h, R, 1));
  paint('tree2', (P, w, h, R) => paintTreeCluster(P, w, h, R, 2));
  paint('bush', paintBush);
  paint('pineSide', paintPineSide);
  paint('pineTop', paintPineTop);
  paint('bamboo0', (P, w, h, R) => paintBamboo(P, w, h, R, 0));
  paint('bamboo1', (P, w, h, R) => paintBamboo(P, w, h, R, 1));
  paint('hydLeaf', paintHydLeaf);
  paint('broadLeaf', paintBroadLeaf);
  paint('blades', (P, w, h, R) => paintBlades(P, w, h, R, 6));
  paint('ivy0', (P, w, h, R) => paintIvy(P, w, h, R, 0));
  paint('ivy1', (P, w, h, R) => paintIvy(P, w, h, R, 1));
  paint('mugwort', paintMugwort);
  paint('clover', paintClover);
  paint('geranium', paintGeranium);
  paint('geraniumLeaf', (P, w, h, R) => paintRoundLeaf(P, w, h, R, true));
  paint('heartLeaf', paintHeartLeaf);
  paint('mgBlue', (P, w, h, R) => paintMorningGlory(P, w, h, R, [0.07, 0.14, 0.75]));
  paint('mgPurple', (P, w, h, R) => paintMorningGlory(P, w, h, R, [0.3, 0.06, 0.62]));
  paint('mgPink', (P, w, h, R) => paintMorningGlory(P, w, h, R, [0.72, 0.1, 0.36]));
  paint('foxtail', paintFoxtail);
  paint('panicle', paintPanicle);
  paint('floret', paintFloret);
  paint('floretCluster', paintFloretCluster);
  paint('hydCluster', paintHydCluster);
  paint('daisy', paintDaisy);
  paint('dayflower', paintDayflower);
  paint('stemG', (P, w, h, R) => paintSolid(P, w, h, R, [0.07, 0.12, 0.03]));
  paint('stemB', (P, w, h, R) => paintSolid(P, w, h, R, [0.06, 0.045, 0.03]));
  paint('stemY', (P, w, h, R) => paintSolid(P, w, h, R, [0.12, 0.15, 0.04]));
  paint('soil', (P, w, h, R) => {
    paintSolid(P, w, h, R, [0.045, 0.032, 0.022]);
    for (let k = 0; k < 40; k++) { P.A.fillStyle = cssL(vary([0.09, 0.075, 0.06], R, 0.3)); P.A.beginPath(); P.A.arc(R() * w, R() * h, R.range(0.8, 2.2), 0, TAU); P.A.fill(); }
  });
  // solid cells are fully opaque
  for (const k of ['stemG', 'stemB', 'stemY']) { const c = cells[k]; void c; }
  const img = A.getImageData(0, 0, S, S);
  pushPull(img.data, S, S);
  const albedo = flipRows(img.data, S, S);
  const nimg = N.getImageData(0, 0, S, S);
  const normal = flipRows(nimg.data, S, S);
  const rects = Object.values(cells).map((c) => ({ x: c.x, y: S - c.y - c.h, w: c.w, h: c.h }));
  const map = alphaTestedTexture(albedo, S, S, rects);
  const ntex = dataTexture(normal, S, S, false);
  const uv = {};
  for (const [k, c] of Object.entries(cells)) uv[k] = cellUV(c, S, 0.5);
  for (const k of ['stemG', 'stemB', 'stemY']) uv[k] = cellUV(cells[k], S, 8);
  uv.soil = cellUV(cells.soil, S, 4);
  // blade sub-cells
  const bc = cells.blades;
  for (let i = 0; i < 6; i++) uv['blade' + i] = cellUV({ x: bc.x + i * 64, y: bc.y, w: 64, h: bc.h }, S, 0.5);
  ATLAS = { map, normal: ntex, uv, S, canvas: ca, ncanvas: cn };
  return ATLAS;
}

// ----------------------------------------------------------------------------
// Bark / culm / pot textures (tiling, metre UVs)

let TEX = null;
function barkTextures() {
  if (TEX) return TEX;
  TEX = {};
  const mk = (n, period, normal, fn) => {
    const { cc, hc, rc } = paintSet(n, fn);
    const nc = normalFrom(hc, normal);
    return { map: toTex(cc, period, true), normalMap: toTex(nc, period, false), roughnessMap: toTex(rc, period, false) };
  };
  // シイ/カシ: grey-brown, fairly smooth with shallow vertical fissures, lenticels and lichen
  TEX.tree = mk(512, 1.0, 4, (u, v) => {
    const fis = Math.abs(tnoise(u, v, 9, 3, 2));
    const crack = smooth(0.12, 0.0, fis);
    const n = tfbm(u, v, 6, 4, 5), n2 = tnoise(u, v, 60, 7, 30);
    const lichen = clamp01(tfbm(u, v, 3, 4, 9, 4) * 2.5 - 0.15);
    let c = [0.2, 0.18, 0.15].map((k) => k * (0.8 + n * 0.5 + n2 * 0.08));
    c = c.map((k, i) => lerp(k, [0.3, 0.32, 0.26][i], lichen * 0.6));
    c = c.map((k) => k * (1 - crack * 0.55));
    return [...c, 0.6 - crack * 0.45 + n * 0.1 + n2 * 0.04, 0.85];
  });
  // クロマツ: blackish bark broken into thick polygonal plates
  TEX.pine = mk(512, 0.7, 7, (() => {
    const G = 6, pts = [];
    const R = rng(515);
    for (let j = 0; j < G * 2; j++) for (let i = 0; i < G; i++) pts.push([(i + 0.1 + 0.8 * R()) / G, (j + 0.1 + 0.8 * R()) / (G * 2), R()]);
    return (u, v) => {
      let d1 = 9, d2 = 9, id = 0;
      for (const p of pts) for (const ox of [-1, 0, 1]) for (const oy of [-1, 0, 1]) {
        const dx = (u - p[0] - ox) * 1.0, dy = (v - p[1] - oy) * 0.6;
        const d = dx * dx + dy * dy;
        if (d < d1) { d2 = d1; d1 = d; id = p[2]; } else if (d < d2) d2 = d;
      }
      const e = Math.sqrt(d2) - Math.sqrt(d1);
      const gap = smooth(0.035, 0.0, e);
      const n = tfbm(u, v, 12, 3, 17);
      const tone = 0.75 + 0.5 * id;
      let c = [0.13, 0.11, 0.1].map((k) => k * tone * (0.85 + n * 0.4));
      c = c.map((k, i) => lerp(k, [0.05, 0.035, 0.03][i], gap));
      const flake = clamp01(tnoise(u, v, 20, 19, 40) * 2 - 0.4) * (1 - gap);
      c = c.map((k, i) => k + flake * [0.08, 0.05, 0.03][i]);
      return [...c, (1 - gap) * (0.55 + 0.25 * smooth(0, 0.12, e)) + n * 0.08, 0.9];
    };
  })());
  // bamboo culm: one node per tile (period = 0.34 m along the culm), waxy band below it
  TEX.culm = mk(256, 0.34, 3, (u, v) => {
    const fib = tnoise(u, v, 40, 23, 2) * 0.5 + tnoise(u, v, 90, 24, 3) * 0.3;
    const dv = v - 0.06;
    const node = Math.exp(-((dv / 0.012) ** 2));
    const wax = smooth(0.0, 0.05, -dv + 0.12) * smooth(0.2, 0.08, -dv + 0.12) * 0.0 + (v > 0.06 && v < 0.22 ? smooth(0.22, 0.08, v) * 0.35 : 0);
    const stain = clamp01(tfbm(u, v, 3, 3, 25, 2) * 1.5);
    let c = [0.16, 0.24, 0.05].map((k) => k * (0.92 + fib * 0.12));
    c = c.map((k, i) => lerp(k, [0.3, 0.33, 0.22][i], wax));
    c = c.map((k, i) => lerp(k, [0.2, 0.18, 0.07][i], stain * 0.35));
    c = c.map((k, i) => lerp(k, [0.14, 0.14, 0.06][i], node * 0.8));
    return [...c, 0.5 + node * 0.4 + fib * 0.03, 0.45 + stain * 0.2 + wax * 0.2];
  });
  // terracotta pot: orange clay, faint efflorescence, soil stain at the bottom
  TEX.clay = mk(256, 0.5, 1.5, (u, v) => {
    const n = tfbm(u, v, 8, 4, 31), n2 = tnoise(u, v, 70, 32, 70);
    const eff = clamp01(tfbm(u, v, 3, 4, 33, 3) * 2.2 - 0.25);
    let c = [0.42, 0.17, 0.08].map((k) => k * (0.88 + n * 0.25 + n2 * 0.06));
    c = c.map((k, i) => lerp(k, [0.55, 0.5, 0.45][i], eff * 0.35));
    return [...c, 0.5 + n2 * 0.1, 0.85];
  });
  return TEX;
}

// ----------------------------------------------------------------------------
// Shader patches

const WIND_PARS = /* glsl */`
attribute float aFlutter;
uniform float uFloraTime;
uniform float uFloraSway;
uniform vec4 uFloraWind;   // x: sway (m) at the reference height, y: reference height (m), z: leaf flutter (m), w: speed
vec3 floraOrigin() {
  vec3 o = modelMatrix[3].xyz;
  #ifdef USE_INSTANCING
    o += mat3( modelMatrix ) * instanceMatrix[3].xyz;
  #endif
  return o;
}
// world-space offset -> model space (rotation + uniform scale only)
vec3 floraToLocal( vec3 w ) {
  mat3 m = mat3( modelMatrix );
  #ifdef USE_INSTANCING
    m = m * mat3( instanceMatrix );
  #endif
  return transpose( m ) * w / max( dot( m[0], m[0] ), 1e-8 );
}
vec3 floraWind( vec3 p, vec3 n ) {
  vec3 o = floraOrigin();
  float t = uFloraTime * uFloraWind.w;
  float ph = dot( o.xz, vec2( 0.0713, 0.1131 ) );
  float h = max( p.y, 0.0 ) / uFloraWind.y;
  float amp = uFloraWind.x * uFloraSway * h * h;
  float gust = 0.62 + 0.38 * sin( t * 0.37 + ph * 0.7 ) * sin( t * 0.23 + 1.3 );
  float a = 0.3 + 0.55 * sin( t * 0.9 + ph ) + 0.22 * sin( t * 2.1 + ph * 1.7 );
  float c = 0.35 * sin( t * 0.71 + ph * 2.3 ) + 0.12 * sin( t * 2.7 + ph );
  vec2 d = vec2( 0.94, 0.34 );
  vec2 off = ( d * a + vec2( -d.y, d.x ) * c ) * amp * gust;
  vec3 w = vec3( off.x, -0.2 * length( off ) * min( h, 1.0 ), off.y );
  float fl = sin( t * 3.7 + dot( p, vec3( 4.1, 3.3, 5.7 ) ) + ph ) * uFloraWind.z * uFloraSway * min( 1.0, h * 1.5 + 0.2 ) * gust * aFlutter;
  return floraToLocal( w ) + n * fl;
}
`;

const FOLIAGE_FRAG_PARS = /* glsl */`
uniform vec4 uFloraTrans;  // x: transmission, y: forward-scatter power, z: occlusion of direct light, w: specular scale
#ifndef vFloraOcc
varying float vFloraOcc;   // baked ambient occlusion (the length of the vertex normal)
#endif
// light through thin leaves / petals: diffuse transmission from behind + forward scattering
// toward the viewer; green leaves transmit a warmer yellow-green, petals keep their colour
vec3 floraTransmit( const in IncidentLight L, const in vec3 N, const in vec3 V, const in vec3 albedo ) {
  float back = saturate( - dot( N, L.direction ) );
  float fwd = pow( saturate( dot( - V, L.direction ) ), uFloraTrans.y );
  float green = saturate( ( albedo.g - max( albedo.r, albedo.b ) ) / max( albedo.g, 1e-4 ) * 2.5 );
  vec3 tint = mix( vec3( 1.0 ), vec3( 1.0, 1.12, 0.55 ), green );
  return L.color * albedo * RECIPROCAL_PI * tint * uFloraTrans.x * ( 0.55 * back + 1.4 * fwd ) * vFloraOcc;
}
`;

const NFB_NOFLIP = THREE.ShaderChunk.normal_fragment_begin.replace(/#ifdef DOUBLE_SIDED\s*normal \*= faceDirection;\s*#endif/, '');
if (NFB_NOFLIP === THREE.ShaderChunk.normal_fragment_begin) console.warn('flora: normal_fragment_begin patch did not apply');
const LIGHTS_TRANS = THREE.ShaderChunk.lights_fragment_begin.replace(
  /RE_Direct\( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight \);/g,
  'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );\n\t\treflectedLight.directDiffuse += floraTransmit( directLight, geometryNormal, geometryViewDir, material.diffuseColor );',
);

function shareWind(shader, uw) {
  shader.uniforms.uFloraTime = U.uTime;
  shader.uniforms.uFloraSway = U.uWindSway;
  shader.uniforms.uFloraWind = { value: uw };
}

// Depth material for shadows that sways with the plant.
function windDepth(uw) {
  const m = new THREE.MeshDepthMaterial();
  prep(m, (shader) => {
    shareWind(shader, uw);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + WIND_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += floraWind( position, normal );');
  }, 'flora-depth');
  return m;
}

// Foliage material: atlas + normal atlas, alpha test, both faces, bent normals, wind, transmission.
function foliageMaterial(name, { wind, trans = 0.5, fwdPow = 5, rough = 0.6, normalScale = 0.8, occDirect = 0.6, spec = 0.55 }) {
  const A = leafAtlas();
  const m = new THREE.MeshStandardMaterial({
    name: 'flora-' + name, map: A.map, normalMap: A.normal, normalScale: new THREE.Vector2(normalScale, normalScale),
    roughness: rough, metalness: 0, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true,
  });
  const uw = new THREE.Vector4(...wind);
  const ut = new THREE.Vector4(trans, fwdPow, occDirect, spec);
  prep(m, (shader) => {
    shareWind(shader, uw);
    shader.uniforms.uFloraTrans = { value: ut };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vFloraOcc;\n' + WIND_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFloraOcc = clamp( length( normal ), 0.0, 1.0 );\ntransformed += floraWind( position, objectNormal );');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', '#include <lights_physical_pars_fragment>\n' + FOLIAGE_FRAG_PARS)
      .replace('#include <normal_fragment_begin>', NFB_NOFLIP)
      .replace('#include <lights_fragment_begin>', LIGHTS_TRANS)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
  reflectedLight.indirectDiffuse *= vFloraOcc;
  reflectedLight.directDiffuse *= mix( 1.0, vFloraOcc, uFloraTrans.z );
  reflectedLight.indirectSpecular *= vFloraOcc * vFloraOcc * uFloraTrans.w;
  reflectedLight.directSpecular *= vFloraOcc * uFloraTrans.w;`);
  }, 'flora-foliage');
  m.userData.wind = uw;
  m.userData.trans = ut;
  m.userData.depth = windDepth(uw);
  return m;
}

// Opaque material (bark, culms, pots) that sways with its plant.
function swayMaterial(name, params, uw) {
  const m = new THREE.MeshStandardMaterial({ name: 'flora-' + name, vertexColors: true, metalness: 0, ...params });
  if (uw) {
    prep(m, (shader) => {
      shareWind(shader, uw);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + WIND_PARS)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += floraWind( position, vec3( 0.0 ) );');
    }, 'flora-sway');
    m.userData.wind = uw;
    m.userData.depth = windDepth(uw);
  } else prep(m, null, 'flora-static-' + name);
  return m;
}

// Lazily built materials, shared by every model of a type.
let MATS = null;
function mats() {
  if (MATS) return MATS;
  const T = barkTextures();
  const M = {};
  // wind: [sway at ref height (m), ref height (m), flutter (m), speed]
  M.tree = foliageMaterial('tree', { wind: [0.16, 10, 0.012, 0.8], trans: 0.45, rough: 0.5, normalScale: 0.9 });
  M.treeBark = swayMaterial('treeBark', { map: T.tree.map, normalMap: T.tree.normalMap, roughnessMap: T.tree.roughnessMap, roughness: 1 }, M.tree.userData.wind);
  M.pine = foliageMaterial('pine', { wind: [0.12, 8, 0.006, 0.7], trans: 0.3, rough: 0.6, normalScale: 0.8 });
  M.pineBark = swayMaterial('pineBark', { map: T.pine.map, normalMap: T.pine.normalMap, roughnessMap: T.pine.roughnessMap, roughness: 1 }, M.pine.userData.wind);
  M.bamboo = foliageMaterial('bamboo', { wind: [0.35, 10, 0.02, 0.75], trans: 0.8, rough: 0.55, normalScale: 0.7 });
  M.culm = swayMaterial('culm', { map: T.culm.map, normalMap: T.culm.normalMap, roughnessMap: T.culm.roughnessMap, roughness: 1 }, M.bamboo.userData.wind);
  M.bush = foliageMaterial('bush', { wind: [0.03, 1.5, 0.008, 1.2], trans: 0.4, rough: 0.5, normalScale: 0.85 });
  M.hydrangea = foliageMaterial('hydrangea', { wind: [0.04, 1.0, 0.008, 1.1], trans: 0.6, rough: 0.62, normalScale: 0.8 });
  M.grass = foliageMaterial('grass', { wind: [0.07, 0.5, 0.008, 1.5], trans: 0.8, rough: 0.6, normalScale: 0.5 });
  M.weeds = foliageMaterial('weeds', { wind: [0.09, 1.0, 0.01, 1.35], trans: 0.75, rough: 0.62, normalScale: 0.6 });
  M.rice = foliageMaterial('rice', { wind: [0.025, 0.25, 0.004, 1.5], trans: 0.85, rough: 0.55, normalScale: 0.5 });
  M.potted = foliageMaterial('potted', { wind: [0.02, 0.8, 0.006, 1.25], trans: 0.55, rough: 0.55, normalScale: 0.8 });
  M.vine = foliageMaterial('vine', { wind: [0.0, 1.0, 0.012, 1.3], trans: 0.35, rough: 0.42, normalScale: 0.9 });
  M.clay = swayMaterial('clay', { map: T.clay.map, normalMap: T.clay.normalMap, roughnessMap: T.clay.roughnessMap, roughness: 1 });
  M.plastic = swayMaterial('plastic', { roughness: 0.45 });
  M.glazed = swayMaterial('glazed', { roughness: 0.18 });
  MATS = M;
  return M;
}

function meshOf(acc, mat, name) {
  const mesh = new THREE.Mesh(acc.geometry(), mat);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (mat.userData.depth) mesh.customDepthMaterial = mat.userData.depth;
  return mesh;
}

// ----------------------------------------------------------------------------
// Geometry helpers

// Card: centre c, unit axes ax (u) and ay (v), half sizes; per-vertex normal from nfn(p).
// The normal's length carries the baked ambient occlusion `occ` (0..1), see vFloraOcc.
function card(A, c, ax, ay, hx, hy, cell, col, nfn, flip = false, occ = 1) {
  const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const p = [c[0] + ax[0] * sx * hx + ay[0] * sy * hy, c[1] + ax[1] * sx * hx + ay[1] * sy * hy, c[2] + ax[2] * sx * hx + ay[2] * sy * hy];
    const s = flip ? (1 - sx) / 2 : (sx + 1) / 2;
    return A.vert(p, V.mul(V.norm(nfn(p)), occ), uvAt(cell, s, (sy + 1) / 2), col);
  });
  A.quad(q[0], q[1], q[2], q[3]);
}

// Leaf strip with a fold and droop: base at b, direction d (unit, along the leaf), side s
// (unit, across), face normal n. rows x 3 columns grid; `droop` bends the tip down along -up.
function leafStrip(A, b, d, s, len, wid, cell, col, { rows = 2, fold = 0.25, droop = 0.2, nrm = null, bend = null, flip = false, occ = 1 } = {}) {
  const n = V.norm(V.cross(s, d));
  const base = A.nv;
  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    const along = V.mad(V.mad(b, d, len * t), [0, -1, 0], droop * len * t * t);
    for (let k = 0; k <= 2; k++) {
      const x = (k - 1);
      const p = V.mad(V.mad(along, s, x * wid * 0.5), n, (Math.abs(x) * fold - 0.5 * fold) * wid * 0.5);
      const nn = nrm ? nrm(p, t) : n;
      A.vert(p, V.mul(V.norm(bend ? bend(p, nn) : nn), occ), uvAt(cell, flip ? 1 - k / 2 : k / 2, t), col);
    }
  }
  for (let r = 0; r < rows; r++) for (let k = 0; k < 2; k++) {
    const a = base + r * 3 + k;
    A.quad(a, a + 1, a + 4, a + 3);
  }
}

// Tube along pts with radii rs (ring of `seg`); UVs in metres (u around, snapped to the
// texture period; v along) unless `cell` is given (atlas cell, e.g. a stem colour).
function tube(A, pts, rs, seg, col, { period = 1, cell = null, colAt = null } = {}) {
  const n = pts.length;
  const T = [];
  for (let i = 0; i < n; i++) T.push(V.norm(V.sub(pts[Math.min(i + 1, n - 1)], pts[Math.max(i - 1, 0)])));
  let nPrev = basis(T[0])[0];
  const frames = [];
  for (let i = 0; i < n; i++) {
    let nn = V.sub(nPrev, V.mul(T[i], V.dot(nPrev, T[i])));
    nn = V.len(nn) < 1e-5 ? basis(T[i])[0] : V.norm(nn);
    frames.push([nn, V.cross(T[i], nn)]);
    nPrev = nn;
  }
  const uMax = Math.max(1, Math.round((TAU * rs[0]) / period)) * period;
  let vAcc = 0;
  const base = A.nv;
  for (let i = 0; i < n; i++) {
    if (i > 0) vAcc += V.len(V.sub(pts[i], pts[i - 1]));
    const c = colAt ? colAt(i / (n - 1)) : col;
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * TAU;
      const dir = V.add(V.mul(frames[i][0], Math.cos(a)), V.mul(frames[i][1], Math.sin(a)));
      const p = V.mad(pts[i], dir, rs[i]);
      const uv = cell ? uvAt(cell, 0.5 + 0.3 * Math.cos(a), 0.5) : [(j / seg) * uMax, vAcc];
      A.vert(p, dir, uv, c, 0);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < seg; j++) {
    const a = base + i * (seg + 1) + j, b = a + seg + 1;
    A.quad(a, b, b + 1, a + 1);
  }
}

// Catmull-Rom through control points -> n samples
function spline(ctrl, n) {
  const out = [];
  const m = ctrl.length - 1;
  for (let i = 0; i < n; i++) {
    const f = (i / (n - 1)) * m;
    const k = Math.min(m - 1, Math.floor(f)), u = f - k;
    const p0 = ctrl[Math.max(0, k - 1)], p1 = ctrl[k], p2 = ctrl[k + 1], p3 = ctrl[Math.min(m, k + 2)];
    const u2 = u * u, u3 = u2 * u;
    out.push([0, 1, 2].map((c) => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * u + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * u2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * u3)));
  }
  return out;
}

// Volumetric occlusion at p (normal n) through a set of ellipsoids {c, r:[rx,ry,rz]}:
// cosine-weighted rays, transmittance exp(-sigma * path length inside foliage).
const HEMI = (() => {
  const R = rng(4242), out = [];
  for (let i = 0; i < 14; i++) {
    const u = (i + R()) / 14, a = R() * TAU;
    const r = Math.sqrt(u);
    out.push([r * Math.cos(a), Math.sqrt(1 - u), r * Math.sin(a)]);
  }
  return out;
})();
function chord(p, d, c, r) {
  const ox = (p[0] - c[0]) / r[0], oy = (p[1] - c[1]) / r[1], oz = (p[2] - c[2]) / r[2];
  const dx = d[0] / r[0], dy = d[1] / r[1], dz = d[2] / r[2];
  const A = dx * dx + dy * dy + dz * dz, B = ox * dx + oy * dy + oz * dz, C = ox * ox + oy * oy + oz * oz - 1;
  const disc = B * B - A * C;
  if (disc <= 0) return 0;
  const s = Math.sqrt(disc);
  const t0 = (-B - s) / A, t1 = (-B + s) / A;
  if (t1 <= 0) return 0;
  return t1 - Math.max(t0, 0);
}
function occlusion(p, n, vols, sigma) {
  const [t, b] = basis(n);
  let sum = 0;
  for (const h of HEMI) {
    const d = [t[0] * h[0] + n[0] * h[1] + b[0] * h[2], t[1] * h[0] + n[1] * h[1] + b[1] * h[2], t[2] * h[0] + n[2] * h[1] + b[2] * h[2]];
    let L = 0;
    for (const v of vols) L += chord(p, d, v.c, v.r) * (v.k ?? 1);
    // the ground blocks rays going down
    const g = d[1] < -0.2 ? 0.55 : 1;
    sum += Math.exp(-sigma * L) * g;
  }
  return sum / HEMI.length;
}
const inside = (p, v, s = 1) => {
  const x = (p[0] - v.c[0]) / (v.r[0] * s), y = (p[1] - v.c[1]) / (v.r[1] * s), z = (p[2] - v.c[2]) / (v.r[2] * s);
  return x * x + y * y + z * z < 1;
};
const ellNormal = (p, v) => V.norm([(p[0] - v.c[0]) / (v.r[0] * v.r[0]), (p[1] - v.c[1]) / (v.r[1] * v.r[1]), (p[2] - v.c[2]) / (v.r[2] * v.r[2])]);

// Fibonacci points on a unit sphere (upper part down to y = ymin)
function fib(n, R, ymin = -1) {
  const out = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i + 0.5) / n * (1 - ymin);
    const r = Math.sqrt(Math.max(0, 1 - y * y)), a = i * ga + R.range(-0.3, 0.3);
    out.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  return out;
}

// Cover a set of foliage volumes with leaf cards, uniformly over the exposed surface of
// their union: evenly spread candidates on every volume (by area), drop those buried in a
// neighbour, then keep `count` of them at random.
// vols: [{c, r:[rx,ry,rz], ymin (lowest surface direction y), w (density weight), nocards}]
// o: { count, cells: [[uvRect, weight]...], size: [min, max], depth, innerFrac, tilt, up, bend, crown (centre),
//      crownBlend, sigma, tint(p, R, v) -> colour, aoMin, ymin (absolute) }
function coverVolumes(A, vols, R, o) {
  const cells = o.cells;
  const wsum = cells.reduce((s, c) => s + c[1], 0);
  const pick = () => { let x = R() * wsum; for (const c of cells) { x -= c[1]; if (x <= 0) return c[0]; } return cells[0][0]; };
  const cc = o.crown;
  const blend = o.crownBlend ?? 0.4, bend = o.bend ?? 0.8;
  const area = (v) => 4 * Math.PI * ((v.r[0] * v.r[1] + v.r[1] * v.r[2] + v.r[0] * v.r[2]) / 3);
  const cand = [];
  const totalArea = vols.reduce((s, v) => s + (v.nocards ? 0 : area(v) * (v.w ?? 1)), 0);
  for (const v of vols) {
    if (v.nocards) continue;
    const n = Math.max(8, Math.round((o.count * 3.2 * area(v) * (v.w ?? 1)) / totalArea));
    for (const d of fib(n, R, v.ymin ?? -1)) {
      const inner = R() < (o.innerFrac ?? 0.1);
      const depth = inner ? R.range(0.3, 0.55) : R.range(0, o.depth ?? 0.22);
      const p = [v.c[0] + d[0] * v.r[0] * (1 - depth), v.c[1] + d[1] * v.r[1] * (1 - depth), v.c[2] + d[2] * v.r[2] * (1 - depth)];
      if (p[1] < (o.ymin ?? -1e9)) continue;
      let hidden = false;
      for (const w of vols) if (w !== v && inside(p, w, w.core ? 0.92 : 0.8)) { hidden = true; break; }
      if (hidden) continue;
      cand.push({ v, p, inner });
    }
  }
  for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); const t = cand[i]; cand[i] = cand[j]; cand[j] = t; }
  const use = cand.slice(0, o.count);
  for (const { v, p, inner } of use) {
    const nOut = ellNormal(p, v);
    const cn = cc ? V.norm(V.sub(p, cc)) : nOut;
    const bentBase = V.norm(V.lerp(nOut, cn, blend));
    let nc = V.norm(V.add(bentBase, V.mul(rndDir(R), o.tilt ?? 0.7)));
    if (o.up) nc = V.norm(V.add(nc, [0, o.up, 0]));
    const [t0, b0] = basis(nc);
    const roll = R() * TAU;
    const ax = V.add(V.mul(t0, Math.cos(roll)), V.mul(b0, Math.sin(roll)));
    const ay = V.cross(nc, ax);
    const sz = R.range(o.size[0], o.size[1]) * (o.sizeAt ? o.sizeAt(p) : 1);
    const ao = occlusion(p, bentBase, vols, o.sigma ?? 0.9);
    const tint = o.tint ? o.tint(p, R, v) : [1, 1, 1];
    const occ = lerp(o.aoMin ?? 0.3, 1, ao) * (inner ? 0.8 : 1);
    card(A, p, ax, ay, sz / 2, sz / 2, o.cellFor ? o.cellFor(nOut, R) : pick(), tint, (q) => {
      const qv = V.norm(V.sub(q, v.c)), qc = cc ? V.norm(V.sub(q, cc)) : qv;
      return V.norm(V.lerp(nc, V.norm(V.lerp(qv, qc, blend)), bend));
    }, R() < 0.5, occ);
  }
  return use.length;
}

// ----------------------------------------------------------------------------
// Models

export const MODELS = {};

// Broadleaf evergreen tree (シイ/カシ/クスノキ-like), 6-12 m: a short trunk forking into
// limbs, a dome of lumpy sub-crowns covered by leaf-cluster cards.
// opts: seed, h (height m), w (crown width m), lean (0..1)
MODELS.tree = (opts = {}) => {
  const seed = num(opts.seed, 1);
  const R = rng(seed * 7919 + 101);
  const M = mats(), AT = leafAtlas();
  const H = num(opts.h, R.range(7, 11));
  const crownBase = H * R.range(0.2, 0.28);
  const crownH = H - crownBase;
  const crownW = num(opts.w, H * R.range(0.85, 1.1));
  const leanA = R() * TAU, lean = num(opts.lean, R.range(0, 0.6)) * H * 0.05;
  const cc = [Math.cos(leanA) * lean, crownBase + crownH * 0.47, Math.sin(leanA) * lean];
  const ew = crownW / 2, eh = crownH / 2;
  // sub-crowns spread over the envelope (flatter underneath) + a core used for occlusion only
  const nL = R.int(9, 13);
  const vols = [];
  const ga = Math.PI * (3 - Math.sqrt(5)), a0 = R() * TAU;
  for (let i = 0; i < nL; i++) {
    const y = 1 - ((i + 0.5) / nL) * 1.55;
    const r = Math.sqrt(Math.max(0, 1 - y * y)), a = a0 + i * ga + R.range(-0.35, 0.35);
    const d = [Math.cos(a) * r, y, Math.sin(a) * r];
    const rad = crownW * R.range(0.19, 0.27) * (y < -0.2 ? 0.85 : 1);
    const k = R.range(0.5, 0.75);
    const c = [cc[0] + d[0] * (ew - rad * k), cc[1] + d[1] * (eh - rad * k) * (y < 0 ? 0.8 : 1), cc[2] + d[2] * (ew - rad * k)];
    vols.push({ c, r: [rad, rad * (y < -0.2 ? 0.7 : R.range(0.8, 0.95)), rad], dir: d, ymin: y < -0.2 ? -0.9 : -0.7 });
  }
  const core = { c: cc, r: [ew * 0.72, eh * 0.72, ew * 0.72], core: true, nocards: true };
  vols.push(core);
  const lumps = vols.filter((v) => !v.core);
  const budget = clamp(Math.round(2350 * Math.pow((crownW * crownH) / 60, 0.7)), 800, 2450);
  const leaves = new Acc();
  const lumpTint = new Map(lumps.map((v) => [v, vary([1, 1, 1], R, 0.09, 0.12)]));
  const cardSize = 0.85 * Math.pow(H / 9, 0.5);
  coverVolumes(leaves, vols, R, {
    count: budget, cells: [[AT.uv.tree0, 0.4], [AT.uv.tree1, 0.3], [AT.uv.tree2, 0.3]], size: [cardSize * 0.8, cardSize * 1.25], depth: 0.2, innerFrac: 0.1,
    tilt: 0.8, bend: 0.75, crown: cc, crownBlend: 0.5, sigma: 0.8, aoMin: 0.25, ymin: crownBase - 0.4,
    tint: (p, RR, v) => { const t = lumpTint.get(v) || [1, 1, 1]; const top = smooth(cc[1], H, p[1]); return [t[0] * (1 + top * 0.14), t[1] * (1 + top * 0.08), t[2] * (1 - top * 0.05)]; },
  });
  // trunk, forking into limbs toward the lower/middle sub-crowns, then branches to the rest
  const bark = new Acc();
  const r0 = H * R.range(0.019, 0.025);
  const fork = [cc[0] * 0.45, crownBase + crownH * 0.1, cc[2] * 0.45];
  const tpts = spline([[0, 0, 0], [cc[0] * 0.05 + R.range(-0.1, 0.1), crownBase * 0.45, cc[2] * 0.05 + R.range(-0.1, 0.1)], [cc[0] * 0.3, crownBase * 0.9, cc[2] * 0.3], fork], 8);
  tube(bark, tpts, tpts.map((p, i) => r0 * (1 - 0.3 * (i / 7)) * (1 + 0.5 * Math.exp(-p[1] / 0.3))), 9, [1, 1, 1], { period: 1 });
  const byAz = lumps.slice().sort((p, q) => Math.atan2(p.dir[2], p.dir[0]) - Math.atan2(q.dir[2], q.dir[0]));
  const nMain = R.int(3, 4);
  const mains = [];
  for (let k = 0; k < nMain; k++) {
    const v = byAz[Math.floor(((k + R.range(0.2, 0.8)) / nMain) * byAz.length) % byAz.length];
    const s0 = tpts[R.int(5, 7)];
    const end = V.lerp(v.c, cc, 0.2);
    const mid = V.add(V.lerp(s0, end, 0.45), [0, (end[1] - s0[1]) * 0.2 + 0.25, 0]);
    const pts = spline([s0, mid, end], 6);
    const rr = r0 * R.range(0.5, 0.62);
    tube(bark, pts, pts.map((_, i) => rr * (1 - 0.7 * (i / 5)) + 0.015), 7, [1, 1, 1], { period: 1 });
    mains.push({ pts, rr, v });
  }
  for (const v of lumps) {
    if (mains.some((m) => m.v === v)) continue;
    // nearest point on a main limb
    let best = null, bd = 1e9;
    for (const m of mains) for (let i = 1; i < m.pts.length - 1; i++) {
      const d = V.len(V.sub(m.pts[i], v.c));
      if (d < bd) { bd = d; best = { p: m.pts[i], rr: m.rr * (1 - 0.7 * (i / 5)) }; }
    }
    if (!best) continue;
    const end = V.lerp(v.c, cc, 0.1);
    const pts = spline([best.p, V.add(V.lerp(best.p, end, 0.5), [0, 0.2, 0]), end], 5);
    const rr = Math.max(0.02, best.rr * 0.6);
    tube(bark, pts, pts.map((_, i) => rr * (1 - 0.65 * (i / 4)) + 0.008), 5, [1, 1, 1], { period: 1 });
  }
  const g = new THREE.Group();
  g.name = 'tree';
  g.add(meshOf(bark, M.treeBark, 'tree:bark'));
  g.add(meshOf(leaves, M.tree, 'tree:leaves'));
  g.userData.tris = bark.tris + leaves.tris;
  if (opts.nodepth) g.traverse((m) => { if (m.isMesh) m.customDepthMaterial = undefined; });
  return g;
};


// Round shrub (camellia / azalea / box), 0.6-2 m: a lumpy mound of small-leaf cards.
// opts: seed, h (height m), w (width m)
MODELS.bush = (opts = {}) => {
  const seed = num(opts.seed, 1);
  const R = rng(seed * 104729 + 7);
  const M = mats(), AT = leafAtlas();
  const h = num(opts.h, R.range(0.8, 1.5)), w = num(opts.w, h * R.range(1.0, 1.35));
  const cc = [0, h * 0.5, 0];
  const vols = [{ c: [0, h * 0.47, 0], r: [w * 0.47, h * 0.47, w * 0.47 * R.range(0.85, 1)] }];
  const nL = R.int(4, 7);
  for (let i = 0; i < nL; i++) {
    const a = R() * TAU, y = R.range(0.1, 0.85);
    const d = [Math.cos(a) * Math.sqrt(1 - y * y), y, Math.sin(a) * Math.sqrt(1 - y * y)];
    const rr = w * R.range(0.2, 0.3);
    vols.push({ c: [d[0] * (w * 0.47 - rr * 0.6), h * 0.47 + d[1] * (h * 0.47 - rr * 0.6), d[2] * (w * 0.47 - rr * 0.6)], r: [rr, rr * 0.85, rr] });
  }
  vols.push({ c: [0, h * 0.45, 0], r: [w * 0.34, h * 0.33, w * 0.34], core: true, nocards: true });
  const leaves = new Acc();
  const count = Math.round(clamp(860 * Math.pow((w * h) / 1.7, 0.75), 220, 900));
  const cs = clamp(0.3 * Math.pow(h / 1.1, 0.5), 0.22, 0.42);
  const bt = vary([1, 1, 1], R, 0.08, 0.1);
  coverVolumes(leaves, vols, R, {
    count, cells: [[AT.uv.bush, 0.85], [AT.uv.tree2, 0.15]], size: [cs * 0.85, cs * 1.3], depth: 0.2, innerFrac: 0.08, tilt: 0.75, bend: 0.8,
    crown: cc, crownBlend: 0.55, sigma: 2.4, aoMin: 0.3, ymin: 0.04,
    tint: (p) => { const top = smooth(h * 0.3, h, p[1]); return [bt[0] * (1 + top * 0.1), bt[1] * (1 + top * 0.06), bt[2]]; },
  });
  // a few stems at the base
  const nS = R.int(3, 6);
  for (let i = 0; i < nS; i++) {
    const a = R() * TAU, r0 = R.range(0.02, w * 0.12);
    const b = [Math.cos(a) * r0, -0.02, Math.sin(a) * r0];
    const e = [Math.cos(a) * (r0 + w * 0.15), h * 0.4, Math.sin(a) * (r0 + w * 0.15)];
    const pts = spline([b, V.add(V.lerp(b, e, 0.5), [R.range(-0.05, 0.05), 0, R.range(-0.05, 0.05)]), e], 4);
    tube(leaves, pts, pts.map((_, k) => 0.018 * (1 - k * 0.2)), 4, [0.8, 0.8, 0.8], { cell: AT.uv.stemB });
  }
  const g = new THREE.Group();
  g.name = 'bush';
  g.add(meshOf(leaves, M.bush, 'bush:leaves'));
  return g;
};

// Japanese black pine (クロマツ), 5-10 m: a leaning, sinuous trunk with plated bark,
// crooked near-horizontal branches carrying flat layered needle clouds (cloud-pruned look).
// opts: seed, h (height m), lean (radians, default 0.15-0.5), dir (lean azimuth, degrees)
MODELS.pine = (opts = {}) => {
  const seed = num(opts.seed, 1);
  const R = rng(seed * 15485863 + 3);
  const M = mats(), AT = leafAtlas();
  const H = num(opts.h, R.range(5.5, 9));
  const lean = num(opts.lean, R.range(0.15, 0.5));
  const la = opts.dir !== undefined ? (num(opts.dir, 0) * Math.PI) / 180 : R() * TAU;
  const ld = [Math.cos(la), 0, Math.sin(la)], sd = [-Math.sin(la), 0, Math.cos(la)];
  const ph = R() * TAU, ph2 = R() * TAU, wob = R.range(0.035, 0.07) * H;
  const trunkAt = (t) => {
    // leans out, then the upper part turns back up toward the light
    const off = H * Math.tan(lean) * (t - 0.45 * t * t) + Math.sin(t * Math.PI * 1.3 + ph2) * wob * 0.6 * t;
    const w = Math.sin(t * Math.PI * 1.7 + ph) * wob * t;
    return [ld[0] * off + sd[0] * w, t * H * 0.94, ld[2] * off + sd[2] * w];
  };
  const ctrl = [];
  for (let i = 0; i <= 7; i++) ctrl.push(trunkAt(i / 7));
  const tpts = spline(ctrl, 14);
  const r0 = H * R.range(0.024, 0.03);
  const rAt = (t) => r0 * (1 - 0.72 * t) + 0.02;
  const bark = new Acc();
  tube(bark, tpts, tpts.map((p, i) => rAt(i / 13) * (1 + 0.45 * Math.exp(-p[1] / 0.35))), 9, [1, 1, 1], { period: 0.7 });
  const vols = [];
  const pad = (c, r, flat = 0.36) => vols.push({ c, r: [r, r * flat * R.range(0.85, 1.2), r], ymin: -0.85 });
  const nB = R.int(6, 9);
  const ts = [];
  for (let i = 0; i < nB; i++) ts.push(lerp(0.34, 0.86, (i + R.range(0.1, 0.9)) / nB));
  const ga = Math.PI * (3 - Math.sqrt(5));
  let az = R() * TAU;
  ts.forEach((tb) => {
    az += ga + R.range(-0.5, 0.5);
    const p0 = trunkAt(tb);
    const dir = [Math.cos(az), 0, Math.sin(az)], perp = [-dir[2], 0, dir[0]];
    const lee = 0.8 + 0.35 * (dir[0] * ld[0] + dir[2] * ld[2]);
    const Lb = H * (0.5 - 0.36 * tb) * R.range(0.75, 1.15) * lee;
    // crooked branch: a few kinks, rising a little then levelling / drooping
    const pts = [p0];
    let q = p0, heading = az;
    const nk = 4;
    for (let k = 1; k <= nk; k++) {
      heading += R.range(-0.45, 0.45);
      const hd = [Math.cos(heading), 0, Math.sin(heading)];
      const rise = (k === 1 ? R.range(0.15, 0.35) : R.range(-0.18, 0.12)) * Lb / nk;
      q = V.add(q, V.add(V.mul(hd, Lb / nk), [0, rise, 0]));
      pts.push(q);
    }
    const bp = spline(pts, 7);
    const rb = rAt(tb) * R.range(0.42, 0.55);
    tube(bark, bp, bp.map((_, k) => rb * (1 - 0.72 * (k / 6)) + 0.01), 5, [1, 1, 1], { period: 0.7 });
    // clouds along the outer part of the branch
    const pr = clamp(0.45 + Lb * 0.3, 0.55, 1.4) * R.range(0.85, 1.1);
    pad(V.add(pts[nk], [0, 0.14, 0]), pr);
    if (Lb > 1.3) pad(V.add(V.lerp(pts[nk - 1], pts[nk - 2], R.range(0, 0.5)), V.add([0, 0.12, 0], V.mul(perp, R.range(-0.3, 0.3)))), pr * R.range(0.6, 0.8));
    if (Lb > 2.2 && R() < 0.6) pad(V.add(V.lerp(pts[nk - 1], pts[nk], 0.5), V.add([0, 0.2, 0], V.mul(perp, R.range(0.3, 0.6) * (R() < 0.5 ? -1 : 1)))), pr * R.range(0.55, 0.7));
  });
  // crown apex: a few rounder clouds around the top
  const top = trunkAt(1);
  const nT = R.int(2, 4);
  for (let i = 0; i < nT; i++) {
    const a = R() * TAU, d = R.range(0.1, 0.7);
    pad(V.add(top, [Math.cos(a) * d, R.range(-0.7, 0.15), Math.sin(a) * d]), R.range(0.55, 0.9), 0.5);
  }
  const area = vols.reduce((sum, v) => sum + Math.PI * v.r[0] * v.r[2], 0);
  const count = Math.round(clamp(area * 60, 1100, 2050));
  const needles = new Acc();
  coverVolumes(needles, vols, R, {
    count, size: [0.42, 0.6], depth: 0.28, innerFrac: 0.08, tilt: 0.55, up: 0.2, bend: 0.75, crownBlend: 0.0, sigma: 1.8, aoMin: 0.28,
    cells: [[AT.uv.pineTop, 1]], cellFor: (n, RR) => (Math.abs(n[1]) > 0.55 ? (RR() < 0.75 ? AT.uv.pineTop : AT.uv.pineSide) : (RR() < 0.8 ? AT.uv.pineSide : AT.uv.pineTop)),
    tint: (p, RR, v) => { const t = smooth(-0.3, 0.7, (p[1] - v.c[1]) / v.r[1]); return [0.82 + 0.3 * t, 0.88 + 0.22 * t, 0.95]; },
  });
  const g = new THREE.Group();
  g.name = 'pine';
  g.add(meshOf(bark, M.pineBark, 'pine:bark'));
  g.add(meshOf(needles, M.pine, 'pine:needles'));
  return g;
};

// A bamboo clump: 10-20 culms 6-12 m, leaning out and arching over at the top, with
// side branches from the upper nodes carrying layered sprays of narrow leaves.
// opts: seed, culms, h (tallest culm m), r (clump radius m)
MODELS.bamboo = (opts = {}) => {
  const seed = num(opts.seed, 1);
  const R = rng(seed * 2654435 + 11);
  const M = mats(), AT = leafAtlas();
  const n = Math.round(clamp(num(opts.culms, R.int(10, 20)), 3, 24));
  const H = num(opts.h, R.range(7, 11));
  const cr = num(opts.r, 0.3 + n * 0.03);
  const culms = new Acc(), leaves = new Acc();
  // triangle budget 8k: culms 100 each, branches 6 each (every other branch), sprays 2 each
  const per = Math.floor((7900 - n * 100) / n / (2 + 6 / 14));
  const mass = { c: [0, H * 0.68, 0], r: [cr + H * 0.3, H * 0.32, cr + H * 0.3] };
  for (let i = 0; i < n; i++) {
    const a = R() * TAU, d = Math.sqrt(R());
    const base = [Math.cos(a) * d * cr, -0.05, Math.sin(a) * d * cr];
    const hi = H * R.range(0.62, 1.0) * (1 - 0.12 * d);
    const ri = 0.012 + 0.022 * (hi / H);
    const la = Math.atan2(base[2], base[0]) + R.range(-0.45, 0.45);
    const tilt = 0.06 + 0.2 * d + R.range(0, 0.08);
    const arch = R.range(0.5, 1.05);
    const segs = 10;
    const pts = [base];
    let p = base;
    for (let k = 1; k <= segs; k++) {
      const t = k / segs;
      const ang = tilt + arch * Math.pow(smooth(0.35, 1.0, t), 1.5);
      const dir = [Math.cos(la) * Math.sin(ang), Math.cos(ang), Math.sin(la) * Math.sin(ang)];
      p = V.add(p, V.mul(dir, hi / segs));
      pts.push(p);
    }
    const cc = vary([1, 1, 1], R, 0.1, 0.12);
    tube(culms, pts, pts.map((_, k) => ri * (1 - 0.7 * (k / segs)) + 0.003), 5, cc, { period: 0.34 });
    // side branches from nodes on the upper part; sprays fan out along them
    const nBr = Math.max(4, Math.round(per / 7));
    let made = 0;
    for (let b = 0; b < nBr && made < per; b++) {
      const t = 1 - Math.pow((b + R()) / nBr, 1.25) * 0.62;
      const f = t * segs, k = Math.min(segs - 1, Math.floor(f)), u = f - k;
      const q = V.lerp(pts[k], pts[k + 1], u);
      const az = la + R.range(-2.4, 2.4);
      const hd = [Math.cos(az), 0, Math.sin(az)];
      const up = R.range(0.1, 0.6);
      const bdir = V.norm(V.add(hd, [0, up, 0]));
      const blen = R.range(0.35, 1.0) * (0.6 + 0.6 * (1 - t));
      const m = Math.min(per - made, R.int(4, 9));
      for (let j = 0; j < m; j++) {
        const g = (j + R()) / m;
        const anchor = V.add(q, V.add(V.mul(bdir, blen * g), [0, -0.12 * blen * g * g, 0]));
        const faz = az + R.range(-1.2, 1.2);
        const fd = [Math.cos(faz), 0, Math.sin(faz)];
        const droop = R.range(0.05, 0.6);
        const ax = V.norm(V.add(fd, [0, -droop, 0]));
        const side = V.norm(V.cross([0, 1, 0], fd));
        // mostly flat, layered sprays (card normal near vertical), some hanging
        const flatness = R() < 0.7 ? R.range(0.9, 1.4) : R.range(0.1, 0.5);
        const ay = rotAxis(V.norm(V.cross(ax, side)), ax, (R() < 0.5 ? -1 : 1) * flatness);
        const sz = R.range(0.42, 0.62) * (0.9 + 0.25 * t);
        const c = V.add(V.add(anchor, V.mul(ax, sz * 0.42)), V.mul(ay, -sz * 0.44));
        const nrm = V.norm(V.cross(ax, ay));
        const radial = V.norm(V.add([c[0], 0, c[2]], [0, 0.001, 0]));
        const occ = occlusion(c, V.norm(V.add(radial, [0, 0.7, 0])), [mass], 0.32);
        const col = mulc(vary([1, 1, 1], R, 0.1, 0.1), 0.9 + 0.14 * t);
        card(leaves, c, ax, ay, sz / 2, sz / 2, R() < 0.5 ? AT.uv.bamboo0 : AT.uv.bamboo1, col, (pp) => {
          const o = V.norm(V.add([pp[0], 0, pp[2]], [0, (pp[1] - H * 0.55) * 0.6 + 0.4, 0]));
          const fn = V.dot(nrm, o) < 0 ? V.mul(nrm, -1) : nrm;
          return V.norm(V.lerp(fn, o, 0.65));
        }, false, lerp(0.5, 1, occ));
        made++;
      }
      // the branch itself (thin, only the part near the culm shows)
      if (b % 2 === 0) {
        const e = V.add(q, V.mul(bdir, blen * 0.7));
        tube(leaves, [q, e], [0.006, 0.003], 3, [0.9, 0.9, 0.8], { cell: AT.uv.stemY });
      }
    }
  }
  const g = new THREE.Group();
  g.name = 'bamboo';
  g.add(meshOf(culms, M.culm, 'bamboo:culms'));
  g.add(meshOf(leaves, M.bamboo, 'bamboo:leaves'));
  return g;
};


// Hydrangea (紫陽花), ~1 m: stems with opposite pairs of large serrated leaves and 5-12
// mophead balls built from small 4-petal florets.
// opts: seed, h (height m), heads (5-12), hue ('blue' | 'purple' | 'pink' | 0..1 blue->purple->pink)
const HYD_HUES = { blue: 0, purple: 0.5, pink: 1 };
function hydColor(hue) {
  const blue = [0.13, 0.26, 0.85], purple = [0.36, 0.2, 0.72], pink = [0.86, 0.34, 0.56];
  return hue < 0.5 ? lerpC(blue, purple, hue * 2) : lerpC(purple, pink, (hue - 0.5) * 2);
}
MODELS.hydrangea = (opts = {}) => {
  const seed = num(opts.seed, 1);
  const R = rng(seed * 7727 + 29);
  const M = mats(), AT = leafAtlas();
  const H = num(opts.h, R.range(0.85, 1.2));
  const W = H * R.range(1.1, 1.45);
  const hue = opts.hue in HYD_HUES ? HYD_HUES[opts.hue] : num(opts.hue, R.pick([0, 0.15, 0.5, 0.7, 1]));
  const nHeads = Math.round(clamp(num(opts.heads, R.int(5, 12)), 1, 14));
  const A = new Acc();
  // a leafy mound; the mopheads sit in its upper surface
  const mound = { c: [0, H * 0.44, 0], r: [W * 0.5, H * 0.44, W * 0.5] };
  const heads = [];
  const ga = Math.PI * (3 - Math.sqrt(5)), a0 = R() * TAU;
  for (let i = 0; i < nHeads; i++) {
    const y = 0.93 - ((i + R.range(0.2, 0.8)) / nHeads) * 0.78;
    const r = Math.sqrt(1 - y * y), a = a0 + i * ga + R.range(-0.25, 0.25);
    const d = [Math.cos(a) * r, y, Math.sin(a) * r];
    const rh = R.range(0.11, 0.14) * (H / 1.0) ** 0.3;
    const sp = [mound.c[0] + d[0] * mound.r[0], mound.c[1] + d[1] * mound.r[1], mound.c[2] + d[2] * mound.r[2]];
    const c = V.add(sp, V.add(V.mul(d, rh * 0.35), [0, rh * 0.25, 0]));
    heads.push({ c, r: rh, d, tint: vary(hydColor(clamp(hue + R.range(-0.12, 0.12), 0, 1)), R, 0.1, 0.05) });
  }
  const headVols = heads.map((h) => ({ c: h.c, r: [h.r * 1.05, h.r * 1.05, h.r * 1.05], nocards: true }));
  // foliage: shoot-cluster cards over the mound (+ a lump under each head)
  const lumps = heads.map((h) => ({ c: V.sub(h.c, V.mul(h.d, h.r * 1.3)), r: [h.r * 1.6, h.r * 1.2, h.r * 1.6], w: 0.5 }));
  const vols = [mound, ...lumps, ...headVols, { c: mound.c, r: V.mul(mound.r, 0.65), core: true, nocards: true }];
  const nCards = Math.round(clamp(260 * Math.pow((W * H) / 1.2, 0.8), 150, 330));
  coverVolumes(A, vols, R, {
    count: nCards, cells: [[AT.uv.hydCluster, 1]], size: [0.34, 0.48], depth: 0.18, innerFrac: 0.06, tilt: 0.6, up: 0.35, bend: 0.75,
    crown: mound.c, crownBlend: 0.5, sigma: 2.4, aoMin: 0.3, ymin: 0.05,
    tint: () => vary([1, 1, 1], R, 0.08, 0.06),
  });
  // stems visible at the foot
  for (let i = 0; i < 7; i++) {
    const a = R() * TAU, r = R.range(0.02, 0.12);
    const b = [Math.cos(a) * r, -0.02, Math.sin(a) * r], e = [Math.cos(a) * (r + W * 0.2), H * 0.35, Math.sin(a) * (r + W * 0.2)];
    tube(A, [b, V.lerp(b, e, 0.5), e], [0.009, 0.008, 0.006], 4, [0.85, 0.9, 0.8], { cell: AT.uv.stemG });
  }
  // single leaves framing each head (big, drooping, seen up close)
  for (const h of heads) {
    const nl = 4;
    const [hx, hz] = basis(h.d);
    for (let k = 0; k < nl; k++) {
      const ang = (k / nl) * TAU + R.range(-0.4, 0.4);
      const out = V.norm(V.add(V.add(V.mul(hx, Math.cos(ang)), V.mul(hz, Math.sin(ang))), V.mul(h.d, -0.25)));
      const dir = V.norm(V.add(out, [0, 0.15, 0]));
      const base = V.add(h.c, V.add(V.mul(h.d, -h.r * 0.75), V.mul(out, h.r * 0.5)));
      const len = R.range(0.14, 0.19);
      const col = vary([1, 1, 1], R, 0.1, 0.08);
      leafStrip(A, base, dir, V.norm(V.cross([0, 1, 0], dir)), len, len * 0.62, AT.uv.hydLeaf, col, { rows: 2, fold: 0.22, droop: R.range(0.25, 0.5), nrm: (pp) => V.norm(V.add(V.mul(ellNormal(pp, mound), 0.7), [0, 0.5, 0])), flip: R() < 0.5, occ: R.range(0.7, 0.9) });
    }
  }
  // mopheads: a dense inner layer of floret-cluster cards + individual florets outside
  const budget = Math.floor((3970 - A.tris) / 2);
  const per = Math.floor(budget / nHeads);
  const nInner = Math.round(per * 0.22), nOuter = per - nInner;
  for (const h of heads) {
    const [hx, hz] = basis(h.d);
    const toWorld = (d0) => V.norm([hx[0] * d0[0] + h.d[0] * d0[1] + hz[0] * d0[2], hx[1] * d0[0] + h.d[1] * d0[1] + hz[1] * d0[2], hx[2] * d0[0] + h.d[2] * d0[1] + hz[2] * d0[2]]);
    const place = (d0, rr, sz, cell, colK) => {
      const d = toWorld(d0);
      const tilt = V.norm(V.add(d, V.mul(rndDir(R), 0.28)));
      const p = V.add(h.c, V.mul(d, rr));
      const [t0, b0] = basis(tilt);
      const roll = R() * TAU;
      const ax = V.add(V.mul(t0, Math.cos(roll)), V.mul(b0, Math.sin(roll)));
      const ay = V.cross(tilt, ax);
      const low = smooth(0.2, -0.6, d0[1]);
      let col = mulc(h.tint, R.range(0.84, 1.1));
      if (R() < 0.05) col = lerpC(col, [0.55, 0.72, 0.42], 0.5);
      card(A, p, ax, ay, sz / 2, sz / 2, cell, col, (pp) => V.norm(V.lerp(tilt, V.norm(V.sub(pp, h.c)), 0.75)), R() < 0.5, (1 - 0.55 * low) * colK);
    };
    for (const d0 of fib(nInner, R, -0.5)) place(d0, h.r * R.range(0.72, 0.85), h.r * R.range(0.9, 1.15), AT.uv.floretCluster, 0.8);
    for (const d0 of fib(nOuter, R, -0.6)) place(d0, h.r * R.range(0.92, 1.04), R.range(0.036, 0.048) * (h.r / 0.11), AT.uv.floret, 1);
  }
  const g = new THREE.Group();
  g.name = 'hydrangea';
  g.add(meshOf(A, M.hydrangea, 'hydrangea'));
  return g;
};

// Blade helper: a tapered, curving blade from base b along direction d (unit), bending
// toward `lean` (unit horizontal) by `bend`; `segs` quads + a tip triangle.
function blade(A, b, d, lean, len, wid, cell, col, { segs = 3, bend = 0.5, twist = 0.3, upN = 0.55, aoBase = 0.45, occ = 1 } = {}) {
  const side0 = V.norm(V.cross(d, lean[0] === 0 && lean[2] === 0 ? [1, 0, 0] : lean));
  const base = A.nv;
  let p = b;
  let dir = d;
  const rows = [];
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    if (k > 0) {
      dir = V.norm(V.add(d, V.mul(lean, bend * t * 1.6)));
      dir = V.norm(V.add(dir, [0, -bend * t * t * 0.9, 0]));
      p = V.add(p, V.mul(dir, len / segs));
    }
    const side = rotAxis(side0, dir, twist * t);
    rows.push({ p, side, t, dir });
  }
  for (const r of rows) {
    const w = r.t < 1 ? wid * (1 - 0.75 * r.t * r.t) : 0;
    const fn = V.norm(V.cross(r.side, r.dir));
    const nrm = V.mul(V.norm(V.add(V.mul(fn, 1 - upN), [0, upN, 0])), occ * lerp(aoBase, 1, Math.min(1, r.t * 1.6)));
    const c = col;
    if (r.t < 1) {
      A.vert(V.mad(r.p, r.side, -w / 2), nrm, uvAt(cell, 0.08, r.t * 0.97), c);
      A.vert(V.mad(r.p, r.side, w / 2), nrm, uvAt(cell, 0.92, r.t * 0.97), c);
    } else {
      A.vert(r.p, nrm, uvAt(cell, 0.5, 0.985), c);
    }
  }
  for (let k = 0; k < segs - 1; k++) { const a = base + k * 2; A.quad(a, a + 1, a + 3, a + 2); }
  const a = base + (segs - 1) * 2;
  A.tri(a, a + 1, a + 2);
}

// A tuft of grass, 0.3-0.6 m (<= 300 tris).
// opts: seed, h (height m), n (blades)
MODELS.grass = (opts = {}) => {
  const seed = num(opts.seed, 1);
  const R = rng(seed * 3571 + 5);
  const M = mats(), AT = leafAtlas();
  const h = num(opts.h, R.range(0.3, 0.6));
  const nb = Math.round(clamp(num(opts.n, 38), 6, 42));
  const A = new Acc();
  const tint = vary([1, 1, 1], R, 0.1, 0.12);
  for (let i = 0; i < nb; i++) {
    const a = R() * TAU, r = Math.sqrt(R()) * 0.06;
    const b = [Math.cos(a) * r, -0.01, Math.sin(a) * r];
    const out = [Math.cos(a + R.range(-0.5, 0.5)), 0, Math.sin(a + R.range(-0.5, 0.5))];
    const lean = R.range(0.1, 0.55) + r * 3;
    const d = V.norm(V.add([0, 1, 0], V.mul(out, lean)));
    const len = h * R.range(0.55, 1.05);
    const cell = AT.uv['blade' + R.int(0, 5)];
    const col = mulc(tint, R.range(0.8, 1.15));
    blade(A, b, d, out, len, R.range(0.006, 0.011) * (h / 0.45 + 0.4), cell, col, { segs: 4, bend: R.range(0.15, 0.7), twist: R.range(-0.8, 0.8) });
  }
  const g = new THREE.Group();
  g.name = 'grass';
  g.add(meshOf(A, M.grass, 'grass'));
  return g;
};

// One hill of young rice seedlings (~0.2-0.3 m, <= 60 tris), meant to be instanced in rows.
// The base sits a little below y = 0 (the water surface).
// opts: seed, h (height m)
MODELS.rice = (opts = {}) => {
  const seed = num(opts.seed, 1);
  const R = rng(seed * 911 + 3);
  const M = mats(), AT = leafAtlas();
  const h = num(opts.h, R.range(0.2, 0.3));
  const A = new Acc();
  const nb = 10;
  const tint = vary([1.25, 1.15, 0.9], R, 0.08, 0.1);
  for (let i = 0; i < nb; i++) {
    const a = (i / nb) * TAU + R.range(-0.3, 0.3);
    const b = [Math.cos(a) * 0.008, -0.06, Math.sin(a) * 0.008];
    const out = [Math.cos(a), 0, Math.sin(a)];
    const d = V.norm(V.add([0, 1, 0], V.mul(out, R.range(0.12, 0.4))));
    blade(A, b, d, out, (h + 0.06) * R.range(0.75, 1.05), R.range(0.005, 0.007), AT.uv['blade' + (i % 4)], mulc(tint, R.range(0.85, 1.12)),
      { segs: 3, bend: R.range(0.2, 0.55), twist: R.range(-0.5, 0.5), aoBase: 0.6 });
  }
  const g = new THREE.Group();
  g.name = 'rice';
  g.add(meshOf(A, M.rice, 'rice'));
  return g;
};

// Mixed roadside weeds, 0.3-1.2 m (<= 1.5k tris): a grassy base, tall grass stems with
// foxtail / panicle seed heads, mugwort (ヨモギ), fleabane (ヒメジョオン) with small white
// daisies, dayflowers (ツユクサ) and clover at the foot.
// opts: seed, h (overall height m), flowers (0..1 amount of flowers, default 0.5)
MODELS.weeds = (opts = {}) => {
  const seed = num(opts.seed, 1);
  const R = rng(seed * 6007 + 17);
  const M = mats(), AT = leafAtlas();
  const h = num(opts.h, R.range(0.5, 1.1));
  const fl = clamp(num(opts.flowers, 0.5), 0, 1);
  const A = new Acc();
  const spot = (r) => { const a = R() * TAU, d = Math.sqrt(R()) * r; return [Math.cos(a) * d, 0, Math.sin(a) * d]; };
  const W = 0.25 + h * 0.35;
  const stemC = [1.1, 1.05, 0.9];
  const thinStem = (b, top, r0, bendAmt = 0.04) => {
    const mid = V.add(V.lerp(b, top, 0.5), [R.range(-bendAmt, bendAmt), 0, R.range(-bendAmt, bendAmt)]);
    const pts = spline([b, mid, top], 4);
    tube(A, pts, [r0, r0 * 0.9, r0 * 0.75, r0 * 0.6], 3, stemC, { cell: AT.uv.stemG });
    return pts;
  };
  // grassy base
  const nb = R.int(18, 28);
  for (let i = 0; i < nb; i++) {
    const b = V.add(spot(W * 0.5), [0, -0.01, 0]);
    const out = V.norm([b[0] + R.range(-0.1, 0.1), 0, b[2] + R.range(-0.1, 0.1)]);
    const d = V.norm(V.add([0, 1, 0], V.mul(out, R.range(0.1, 0.55))));
    blade(A, b, d, out, h * R.range(0.3, 0.65), R.range(0.006, 0.011), AT.uv['blade' + R.int(0, 5)], vary([1, 1, 1], R, 0.12, 0.12), { segs: 3, bend: R.range(0.25, 0.8), twist: R.range(-0.8, 0.8) });
  }
  // tall grass stems with seed heads, arching a little
  const ns = R.int(3, 7);
  for (let i = 0; i < ns; i++) {
    const b = spot(W * 0.4);
    const lean = V.norm([b[0] + R.range(-0.2, 0.2), 0, b[2] + R.range(-0.2, 0.2)]);
    const top = V.add(b, V.add(V.mul(lean, h * R.range(0.08, 0.25)), [0, h * R.range(0.75, 1.0), 0]));
    thinStem(b, top, 0.0022, 0.03);
    const fox = R() < 0.55;
    const sz = fox ? R.range(0.1, 0.14) : R.range(0.15, 0.22);
    const cell = fox ? AT.uv.foxtail : AT.uv.panicle;
    // the head continues the stem's direction (foxtails nod)
    const up = V.norm(V.add([0, 1, 0], V.mul(lean, fox ? 0.5 : 0.2)));
    const ax = V.norm(V.cross(up, [lean[2], 0, -lean[0]]));
    const c = V.add(top, V.mul(up, sz * 0.45));
    const col = vary([1, 1, 1], R, 0.1, 0.05);
    const n1 = V.norm(V.cross(ax, up)), ax2 = V.norm(V.cross(up, ax)), n2 = V.norm(V.cross(ax2, up));
    card(A, c, ax, up, sz * 0.25, sz * 0.5, cell, col, () => V.norm(V.add(n1, [0, 0.6, 0])));
    card(A, c, ax2, up, sz * 0.25, sz * 0.5, cell, col, () => V.norm(V.add(n2, [0, 0.6, 0])));
  }
  // mugwort: a stem with lobed leaves spiralling up
  const nm = R.int(1, 3);
  for (let i = 0; i < nm; i++) {
    const b = spot(W * 0.45);
    const hh = h * R.range(0.35, 0.7);
    const top = V.add(b, [R.range(-0.05, 0.05), hh, R.range(-0.05, 0.05)]);
    thinStem(b, top, 0.0035);
    const nl = R.int(9, 14);
    for (let k = 0; k < nl; k++) {
      const t = 0.12 + 0.88 * (k / nl);
      const q = V.lerp(b, top, t);
      const az = k * 2.4 + R.range(-0.3, 0.3);
      const d = V.norm([Math.cos(az), R.range(0.25, 0.8), Math.sin(az)]);
      const side = V.norm(V.cross([0, 1, 0], d));
      const len = R.range(0.07, 0.11) * (1.25 - t * 0.55);
      leafStrip(A, q, d, side, len, len * 0.55, AT.uv.mugwort, vary([0.95, 0.95, 0.95], R, 0.1, 0.05), { rows: 2, fold: 0.2, droop: R.range(0.15, 0.4), occ: lerp(0.55, 1, t) });
    }
  }
  // fleabane: a stem with a few narrow drooping leaves and a loose head of small daisies
  const nf = Math.round(R.int(0, 3) * (0.4 + fl * 1.2));
  for (let i = 0; i < nf; i++) {
    const b = spot(W * 0.4);
    const hh = h * R.range(0.7, 1.05);
    const top = V.add(b, [R.range(-0.06, 0.06), hh, R.range(-0.06, 0.06)]);
    thinStem(b, top, 0.0028);
    for (let k = 0; k < 4; k++) {
      const q = V.lerp(b, top, 0.15 + k * 0.17);
      const az = k * 2.2 + R() * TAU;
      const d = V.norm([Math.cos(az), R.range(0.1, 0.45), Math.sin(az)]);
      const len = R.range(0.07, 0.1) * (1 - k * 0.12);
      leafStrip(A, q, d, V.norm(V.cross([0, 1, 0], d)), len, len * 0.32, AT.uv.broadLeaf, [0.95, 1, 0.9], { rows: 2, fold: 0.2, droop: R.range(0.3, 0.6), occ: 0.8 });
    }
    const nfl = R.int(5, 11);
    for (let k = 0; k < nfl; k++) {
      const a = R() * TAU, r = R.range(0.02, 0.09);
      const p = V.add(top, [Math.cos(a) * r, R.range(-0.06, 0.03), Math.sin(a) * r]);
      tube(A, [V.lerp(top, p, 0.1), p], [0.0012, 0.001], 3, stemC, { cell: AT.uv.stemG });
      const upF = V.norm(V.add([0, 1, 0], V.add(V.mul([Math.cos(a), 0, Math.sin(a)], 0.5), V.mul(rndDir(R), 0.25))));
      const [t0, b0] = basis(upF);
      const sz = R.range(0.018, 0.024);
      card(A, V.add(p, V.mul(upF, 0.002)), t0, b0, sz / 2, sz / 2, AT.uv.daisy, [1, 1, 1], () => upF);
    }
  }
  // dayflowers at the foot: a short leafy shoot with one blue flower
  const nd = Math.round(R.int(0, 3) * (0.4 + fl * 1.2));
  for (let i = 0; i < nd; i++) {
    const b = spot(W * 0.5);
    const out = V.norm([b[0] + 0.01, 0, b[2]]);
    const top = V.add(b, V.add(V.mul(out, 0.06), [0, R.range(0.1, 0.22), 0]));
    thinStem(b, top, 0.0025);
    for (let k = 0; k < 3; k++) {
      const q = V.lerp(b, top, 0.3 + k * 0.25);
      const d = V.norm([R.range(-1, 1), R.range(0.1, 0.4), R.range(-1, 1)]);
      leafStrip(A, q, d, V.norm(V.cross([0, 1, 0], d)), 0.06, 0.018, AT.uv.broadLeaf, [0.9, 1, 0.85], { rows: 1, fold: 0.25, droop: 0.3, occ: 0.8 });
    }
    const f = V.norm(V.add(out, [0, 0.8, 0]));
    const [t0, b0] = basis(f);
    card(A, V.add(top, V.mul(f, 0.01)), t0, b0, 0.012, 0.012, AT.uv.dayflower, [1, 1, 1], () => f);
  }
  // clover patches on the ground
  const ncl = R.int(2, 5);
  for (let i = 0; i < ncl; i++) {
    const p = V.add(spot(W * 0.6), [0, R.range(0.01, 0.04), 0]);
    const up = V.norm(V.add([0, 1, 0], V.mul(rndDir(R), 0.3)));
    const [t0, b0] = basis(up);
    const sz = R.range(0.16, 0.26);
    card(A, p, t0, b0, sz / 2, sz / 2, AT.uv.clover, vary([0.9, 0.9, 0.9], R, 0.1), () => up, R() < 0.5, 0.8);
  }
  const g = new THREE.Group();
  g.name = 'weeds';
  g.add(meshOf(A, M.weeds, 'weeds'));
  return g;
};

// Surface of revolution: profile [[r, y], ...] from the bottom centre outward/up; normals
// from the profile; u around (metres), v along the profile (metres).
function lathe(A, prof, seg, col, colAt = null) {
  const base = A.nv;
  let vAcc = 0;
  for (let i = 0; i < prof.length; i++) {
    if (i > 0) vAcc += Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]);
    const a = prof[Math.max(0, i - 1)], b = prof[Math.min(prof.length - 1, i + 1)];
    const tr = b[0] - a[0], ty = b[1] - a[1];
    const nl = Math.hypot(tr, ty) || 1;
    const nr = ty / nl, ny = -tr / nl;
    const c = colAt ? colAt(i) : col;
    for (let j = 0; j <= seg; j++) {
      const t = (j / seg) * TAU;
      const cs = Math.cos(t), sn = Math.sin(t);
      A.vert([prof[i][0] * cs, prof[i][1], prof[i][0] * sn], [nr * cs, ny, nr * sn], [(j / seg) * TAU * 0.25, vAcc], c, 0);
    }
  }
  for (let i = 0; i < prof.length - 1; i++) for (let j = 0; j < seg; j++) {
    const a = base + i * (seg + 1) + j, b = a + seg + 1;
    A.quad(a, a + 1, b + 1, b);
  }
}

const POT_COLORS = {
  plastic: [[0.02, 0.02, 0.02], [0.035, 0.06, 0.035], [0.5, 0.2, 0.08], [0.62, 0.6, 0.55], [0.05, 0.1, 0.3]],
  glazed: [[0.03, 0.06, 0.2], [0.12, 0.06, 0.03], [0.06, 0.12, 0.08]],
};

// A potted plant: terracotta / plastic / glazed pot (0.2-0.6 m) with a plant.
// opts: seed, kind ('foliage' | 'geranium' | 'asagao' | 'shrub' | 'aloe' | 'petunia'),
//       size (pot height m), pot ('clay' | 'plastic' | 'glazed'), color (flower colour 0..1 hue for petunia/geranium)
MODELS.potted = (opts = {}) => {
  const seed = num(opts.seed, 1);
  const R = rng(seed * 4099 + 13);
  const M = mats(), AT = leafAtlas();
  const kinds = ['foliage', 'geranium', 'asagao', 'shrub', 'aloe', 'petunia'];
  const kind = kinds.includes(opts.kind) ? opts.kind : kinds[(seed - 1 + 600) % kinds.length];
  const potType = ['clay', 'plastic', 'glazed'].includes(opts.pot) ? opts.pot : R.pick(['clay', 'clay', 'plastic', 'plastic', 'glazed']);
  const ph = num(opts.size, kind === 'asagao' ? R.range(0.22, 0.3) : R.range(0.18, 0.4));
  const rt = ph * R.range(0.5, 0.62) * (kind === 'aloe' ? 1.1 : 1), rb = rt * R.range(0.68, 0.8);
  const soilY = ph * 0.88;
  const pot = new Acc();
  const prof = [[0.0001, 0], [rb, 0], [rt * 0.97, ph * 0.88], [rt * 1.06, ph * 0.9], [rt * 1.07, ph], [rt * 0.95, ph], [rt * 0.93, soilY - 0.01]];
  const pc = potType === 'clay' ? vary([1, 1, 1], R, 0.08, 0.05) : R.pick(POT_COLORS[potType]);
  lathe(pot, prof, 18, pc, (i) => (potType === 'clay' && i <= 1 ? mulc(pc, 0.7) : pc));
  const potMat = potType === 'clay' ? M.clay : potType === 'plastic' ? M.plastic : M.glazed;
  const A = new Acc();
  // soil
  {
    const c = A.vert([0, soilY, 0], [0, 1, 0], uvAt(AT.uv.soil, 0.5, 0.5), [1, 1, 1]);
    const n = 14;
    for (let j = 0; j <= n; j++) { const t = (j / n) * TAU; A.vert([Math.cos(t) * rt * 0.94, soilY - 0.005, Math.sin(t) * rt * 0.94], [0, 1, 0], uvAt(AT.uv.soil, 0.5 + 0.45 * Math.cos(t), 0.5 + 0.45 * Math.sin(t)), [1, 1, 1]); }
    for (let j = 0; j < n; j++) A.tri(c, c + 2 + j, c + 1 + j);
  }
  const top = [0, soilY, 0];
  const leafNrm = (centre) => (pp, t) => V.norm(V.add(V.norm(V.sub(pp, centre)), [0, 0.8, 0]));
  if (kind === 'foliage') {
    // aspidistra-like long leaves arching out of the soil
    const n = R.int(10, 16);
    for (let i = 0; i < n; i++) {
      const a = R() * TAU, r = R.range(0, rt * 0.5);
      const b = [Math.cos(a) * r, soilY, Math.sin(a) * r];
      const d = V.norm([Math.cos(a) * R.range(0.2, 0.7), 1, Math.sin(a) * R.range(0.2, 0.7)]);
      const stalk = V.add(b, V.mul(d, R.range(0.08, 0.2)));
      tube(A, [b, stalk], [0.004, 0.003], 3, [0.9, 0.9, 0.9], { cell: AT.uv.stemG });
      const len = R.range(0.28, 0.42) * (ph / 0.3) ** 0.3;
      leafStrip(A, stalk, V.norm(V.add(d, [0, 0.2, 0])), V.norm(V.cross([0, 1, 0], d)), len, len * 0.3, AT.uv.broadLeaf, vary([1, 1, 1], R, 0.12, 0.06), { rows: 3, fold: 0.3, droop: R.range(0.25, 0.6), nrm: leafNrm(top) });
    }
  } else if (kind === 'geranium' || kind === 'petunia') {
    const hue = num(opts.color, R());
    const flowerC = kind === 'geranium' ? lerpC([0.8, 0.05, 0.06], [0.95, 0.35, 0.45], hue) : (hue < 0.33 ? [0.55, 0.12, 0.45] : hue < 0.66 ? [0.85, 0.3, 0.6] : [0.9, 0.9, 0.92]);
    const mound = { c: [0, soilY + rt * 0.5, 0], r: [rt * 1.35, rt * 0.75, rt * 1.35] };
    const n = kind === 'geranium' ? R.int(18, 26) : 0;
    for (let i = 0; i < n; i++) {
      const a = R() * TAU, r = R.range(0.2, 1) * rt;
      const b = [Math.cos(a) * r * 0.4, soilY, Math.sin(a) * r * 0.4];
      const e = [Math.cos(a) * r * 1.2, soilY + R.range(0.05, 0.18), Math.sin(a) * r * 1.2];
      tube(A, [b, e], [0.003, 0.002], 3, [0.9, 0.9, 0.9], { cell: AT.uv.stemG });
      const f = V.norm(V.add([0, 1, 0], V.mul(rndDir(R), 0.5)));
      const [t0, b0] = basis(f);
      const sz = R.range(0.07, 0.1);
      card(A, V.add(e, [0, 0.01, 0]), t0, b0, sz / 2, sz / 2, AT.uv.geraniumLeaf, vary([1, 1, 1], R, 0.12, 0.06), () => V.norm(V.add(f, [0, 0.5, 0])));
    }
    if (kind === 'petunia') {
      coverVolumes(A, [mound], R, { count: 90, cells: [[AT.uv.bush, 1]], size: [0.1, 0.15], depth: 0.2, tilt: 0.7, bend: 0.7, crown: mound.c, sigma: 4, aoMin: 0.4, ymin: soilY });
    }
    const nf = kind === 'geranium' ? R.int(3, 7) : R.int(12, 22);
    for (let i = 0; i < nf; i++) {
      if (kind === 'geranium') {
        const a = R() * TAU, r = R.range(0, rt * 0.9);
        const b = [Math.cos(a) * r * 0.3, soilY, Math.sin(a) * r * 0.3];
        const e = [Math.cos(a) * r, soilY + R.range(0.2, 0.32), Math.sin(a) * r];
        tube(A, [b, V.lerp(b, e, 0.6), e], [0.0035, 0.003, 0.0025], 3, [0.9, 0.9, 0.9], { cell: AT.uv.stemG });
        const sz = R.range(0.08, 0.11);
        const col = mulc(flowerC, R.range(0.9, 1.1));
        const up = V.norm(V.add([0, 1, 0], V.mul(rndDir(R), 0.2)));
        const [t0, b0] = basis(up);
        card(A, V.add(e, [0, sz * 0.15, 0]), t0, b0, sz / 2, sz / 2, AT.uv.geranium, col, () => up);
        const az = R() * TAU;
        card(A, V.add(e, [0, sz * 0.2, 0]), [Math.cos(az), 0, Math.sin(az)], [0, 1, 0], sz * 0.45, sz * 0.32, AT.uv.geranium, col, () => up);
      } else {
        const d = V.norm(V.add(rndDir(R), [0, 0.9, 0]));
        const p = V.add(mound.c, [d[0] * mound.r[0] * 0.95, d[1] * mound.r[1] * 0.95, d[2] * mound.r[2] * 0.95]);
        if (p[1] < soilY + 0.02) continue;
        const [t0, b0] = basis(d);
        const sz = R.range(0.05, 0.065);
        card(A, p, t0, b0, sz / 2, sz / 2, hue < 0.33 ? AT.uv.mgPurple : hue < 0.66 ? AT.uv.mgPink : AT.uv.floret, hue < 0.66 ? [1, 1, 1] : [1, 1, 1], () => d);
      }
    }
  } else if (kind === 'asagao') {
    // andon trellis: sticks + rings, vines spiralling up, heart leaves and trumpet flowers
    const Ht = R.range(0.7, 1.0), rr = rt * 0.85;
    const nSt = 4;
    for (let i = 0; i < nSt; i++) {
      const a = (i / nSt) * TAU + 0.4;
      tube(A, [[Math.cos(a) * rr, soilY - 0.02, Math.sin(a) * rr], [Math.cos(a) * rr, soilY + Ht, Math.sin(a) * rr]], [0.004, 0.004], 3, [1.4, 1.3, 1.1], { cell: AT.uv.stemY });
    }
    for (const hy of [0.35, 0.68, 0.98]) {
      const ring = [];
      for (let j = 0; j <= 12; j++) { const t = (j / 12) * TAU; ring.push([Math.cos(t) * rr, soilY + Ht * hy, Math.sin(t) * rr]); }
      tube(A, ring, ring.map(() => 0.003), 3, [1.4, 1.3, 1.1], { cell: AT.uv.stemY });
    }
    const flowerCell = R.pick([AT.uv.mgBlue, AT.uv.mgPurple, AT.uv.mgPink]);
    const nv = 3;
    for (let v = 0; v < nv; v++) {
      const ph0 = R() * TAU, turns = R.range(1.5, 2.5);
      const vine = [];
      for (let k = 0; k <= 16; k++) {
        const t = k / 16, a = ph0 + t * turns * TAU;
        vine.push([Math.cos(a) * rr * 1.05, soilY + t * Ht * R.range(0.9, 1.0), Math.sin(a) * rr * 1.05]);
      }
      tube(A, vine, vine.map(() => 0.0022), 3, [0.9, 0.95, 0.9], { cell: AT.uv.stemG });
      for (let k = 1; k < 16; k++) {
        const q = vine[k];
        const out = V.norm([q[0], 0, q[2]]);
        const d = V.norm(V.add(out, [R.range(-0.4, 0.4), R.range(-0.2, 0.5), R.range(-0.4, 0.4)]));
        const side = V.norm(V.cross([0, 1, 0], d));
        const len = R.range(0.06, 0.09);
        // heart leaf: petiole out, blade hanging
        const ay = V.norm(V.add([0, 1, 0], V.mul(out, 0.6)));
        const ax = V.norm(V.cross(ay, out));
        card(A, V.add(V.add(q, V.mul(out, 0.03)), V.mul(ay, len * 0.5)), ax, ay, len / 2, len / 2, AT.uv.heartLeaf, vary([1, 1, 1], R, 0.12, 0.06), () => V.norm(V.add(out, [0, 0.5, 0])), R() < 0.5);
        void d; void side;
        if (R() < 0.33) {
          const f = V.norm(V.add(out, [R.range(-0.3, 0.3), R.range(0, 0.4), R.range(-0.3, 0.3)]));
          const [t0, b0] = basis(f);
          const fp = V.add(q, V.mul(f, 0.05));
          tube(A, [q, fp], [0.004, 0.012], 4, [1.3, 1.3, 1.3], { cell: AT.uv.stemY });
          card(A, fp, t0, b0, 0.042, 0.042, flowerCell, [1, 1, 1], () => f);
        }
      }
    }
  } else if (kind === 'shrub') {
    const r = rt * R.range(1.1, 1.4);
    const ball = { c: [0, soilY + r * 0.85, 0], r: [r, r * 0.85, r] };
    tube(A, [[0, soilY - 0.01, 0], [0, soilY + r * 0.5, 0]], [0.012, 0.01], 4, [1, 1, 1], { cell: AT.uv.stemB });
    coverVolumes(A, [ball], R, { count: Math.round(clamp(260 * (r / 0.2) ** 2, 120, 560)), cells: [[AT.uv.bush, 1]], size: [r * 0.55, r * 0.8], depth: 0.2, tilt: 0.7, bend: 0.8, crown: ball.c, sigma: 5, aoMin: 0.35, ymin: soilY });
  } else {
    // aloe: a rosette of thick, spiky grey-green leaves
    const n = R.int(12, 18);
    for (let i = 0; i < n; i++) {
      const a = i * 2.4 + R.range(-0.2, 0.2);
      const inner = i / n;
      const d = V.norm([Math.cos(a) * (0.35 + inner), 1.2 - inner * 0.6, Math.sin(a) * (0.35 + inner)]);
      const len = R.range(0.22, 0.34) * (0.7 + 0.5 * inner) * (ph / 0.3) ** 0.3;
      leafStrip(A, [Math.cos(a) * 0.02, soilY - 0.01, Math.sin(a) * 0.02], d, V.norm(V.cross([0, 1, 0], d)), len, 0.045, AT.uv['blade' + (i % 3)], vary([0.75, 0.95, 0.85], R, 0.08, 0.04),
        { rows: 3, fold: 0.6, droop: R.range(0.05, 0.3) * inner, nrm: leafNrm(top) });
    }
  }
  const g = new THREE.Group();
  g.name = 'potted';
  g.add(meshOf(pot, potMat, 'potted:pot'));
  g.add(meshOf(A, M.potted, 'potted:plant'));
  g.userData.kind = kind;
  return g;
};

// Ivy / creeper patch hanging on a wall (~2 x 1.5 m, flat-ish).
// Frame: the wall face is the plane z = 0 facing +z; origin at the bottom centre of the patch.
// The creeper spills over the wall crest at y = h (leaves on the crest occupy z in [-crest, 0])
// and hangs down in a dense band plus trailing strands; leaves stand off 0-0.25 m.
// opts: seed, w (width m), h (height m), crest (depth of the wall top covered, m; 0 = none)
MODELS.vine = (opts = {}) => {
  const seed = num(opts.seed, 1);
  const R = rng(seed * 5813 + 41);
  const M = mats(), AT = leafAtlas();
  const W = num(opts.w, 2), Hh = num(opts.h, 1.5), crest = num(opts.crest, 0.3);
  const A = new Acc();
  // coverage: a dense band under the crest with a ragged lower edge + hanging strands
  const edgeN = [];
  for (let i = 0; i <= 16; i++) edgeN.push(R.range(0.3, 0.62));
  const edgeAt = (x) => { const f = clamp((x / W + 0.5) * 16, 0, 15.999), k = Math.floor(f), u = f - k; return lerp(edgeN[k], edgeN[k + 1], u * u * (3 - 2 * u)); };
  const strands = [];
  const ns = R.int(3, 6);
  for (let i = 0; i < ns; i++) strands.push({ x: R.range(-0.45, 0.45) * W, len: R.range(0.55, 0.98) * Hh, w: R.range(0.08, 0.18) });
  const dens = (x, y) => {
    const band = smooth(Hh * (1 - edgeAt(x)) - 0.12, Hh * (1 - edgeAt(x)) + 0.12, y);
    let st = 0;
    for (const s2 of strands) st = Math.max(st, smooth(s2.w, s2.w * 0.3, Math.abs(x - s2.x)) * smooth(Hh - s2.len - 0.1, Hh - s2.len + 0.15, y));
    const sideFade = smooth(W * 0.5, W * 0.38, Math.abs(x));
    return Math.max(band * sideFade, st);
  };
  const budget = 640;
  let placed = 0, tries = 0;
  while (placed < budget && tries < budget * 12) {
    tries++;
    const onCrest = crest > 0 && R() < 0.14;
    const x = R.range(-0.5, 0.5) * W;
    let p, f;
    if (onCrest) {
      if (R() > smooth(W * 0.5, W * 0.35, Math.abs(x))) continue;
      p = [x, Hh + R.range(0.02, 0.1), -R() * crest];
      f = V.norm(V.add([0, 1, 0], V.mul(rndDir(R), 0.45)));
    } else {
      const y = R.range(0, Hh + 0.05);
      const d = dens(x, y);
      if (R() > d) continue;
      const bulge = 0.05 + 0.13 * d * smooth(0, Hh, y);
      p = [x, y, R.range(0.015, bulge + 0.02)];
      f = V.norm([R.range(-0.45, 0.45), R.range(0.2, 0.9), 1]);
    }
    placed++;
    // petiole toward the wall/stem, tip hanging down and out
    let ay = V.norm([R.range(-0.8, 0.8), -1, R.range(0.2, 0.8)]);
    if (onCrest) ay = V.norm([R.range(-1, 1), 0, R.range(-1, 1)]);
    ay = V.norm(V.sub(ay, V.mul(f, V.dot(ay, f))));
    const ax = V.cross(ay, f);
    const sz = R.range(0.12, 0.19);
    const near = onCrest ? 1 : smooth(0.0, 0.18, p[2]);
    const occ = lerp(0.45, 1, near) * (onCrest ? 1 : lerp(0.75, 1, smooth(0, Hh, p[1])));
    const col = vary([1, 1, 1], R, 0.14, 0.1);
    const nrm = V.norm(V.add(f, onCrest ? [0, 0.5, 0] : [0, 0.35, 0.5]));
    card(A, V.add(p, V.mul(ay, sz * 0.45)), ax, ay, sz / 2, sz / 2, R() < 0.7 ? AT.uv.ivy0 : AT.uv.ivy1, col, () => nrm, R() < 0.5, occ);
  }
  // woody stems down the strands and along the crest
  for (const s2 of strands) {
    const pts = [];
    for (let k = 0; k <= 6; k++) { const t = k / 6; pts.push([s2.x + Math.sin(t * 5 + s2.x * 3) * 0.05, Hh + 0.02 - t * s2.len, 0.02 + 0.02 * Math.sin(t * 7)]); }
    tube(A, pts, pts.map(() => 0.006), 3, [0.9, 0.9, 0.9], { cell: AT.uv.stemB });
  }
  const g = new THREE.Group();
  g.name = 'vine';
  g.add(meshOf(A, M.vine, 'vine'));
  if (opts.wall) {
    // viewer aid: a block wall the patch hangs on
    const L = materials();
    const wg = new THREE.BoxGeometry(W + 1.5, Hh + 0.3, 0.3);
    const uv = wg.attributes.uv, pos = wg.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) + pos.getZ(i), pos.getY(i));
    wg.setAttribute('color', new THREE.Float32BufferAttribute(new Array(pos.count * 3).fill(1), 3));
    const wm = new THREE.Mesh(wg, L.block);
    wm.position.set(0, (Hh + 0.3) / 2 - 0.3, -0.15);
    wm.castShadow = wm.receiveShadow = true;
    g.add(wm);
  }
  return g;
};


// ----------------------------------------------------------------------------
// Distant forest: impostor crowns
//
// An atlas of 8 crowns (0-5 broadleaf, 6-7 pines) rendered on the CPU from 3D leaf-clump
// splats with a z-buffer: albedo (+ coverage alpha) and a card-space normal (xyz, z toward
// the viewer) with ambient occlusion in alpha. The cards turn about y to face the camera
// (and tilt back a little when seen from above); lighting uses the painted normals, so
// each crown has a lit and a shaded side, lumps and crevices.

const CROWN_CELL = 512, CROWN_NX = 4, CROWN_NY = 2;
let CROWNS = null;

function hash2i(x, y, s) { let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2i(xi, yi, s), b = hash2i(xi + 1, yi, s), c = hash2i(xi, yi + 1, s), d = hash2i(xi + 1, yi + 1, s);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

// Leaf-clump splats for a broadleaf crown. Returns { splats, W, H } in metres (x across,
// y up from the crown base, z toward the viewer).
function crownBroadleaf(R, shape) {
  const H = 10;
  const W = H * shape.aspect;
  const parts = shape.parts || [{ x: 0, w: W, h: H, y0: 0 }];
  const vols = [];
  for (const pt of parts) {
    const cc = [pt.x, pt.y0 + pt.h * 0.52, 0];
    const ew = pt.w / 2, eh = pt.h / 2;
    const nL = shape.lumps;
    const ga = Math.PI * (3 - Math.sqrt(5)), a0 = R() * TAU;
    for (let i = 0; i < nL; i++) {
      const y = 1 - ((i + 0.5) / nL) * 1.6;
      const r = Math.sqrt(Math.max(0, 1 - y * y)), a = a0 + i * ga + R.range(-0.4, 0.4);
      const d = [Math.cos(a) * r * (shape.skew ? 1 + shape.skew * Math.cos(a) : 1), y, Math.sin(a) * r];
      const rad = pt.w * R.range(0.17, 0.26) * (y < -0.3 ? 0.8 : 1);
      const k = R.range(0.5, 0.8);
      vols.push({ c: [cc[0] + d[0] * (ew - rad * k), cc[1] + d[1] * (eh - rad * k), cc[2] + d[2] * (ew - rad * k)], r: [rad, rad * R.range(0.78, 0.92), rad], tint: vary([1, 1, 1], R, 0.1, 0.14), cc });
    }
    vols.push({ c: cc, r: [ew * 0.72, eh * 0.7, ew * 0.72], core: true, cc });
  }
  const splats = [];
  const lumps = vols.filter((v) => !v.core);
  for (const v of lumps) {
    const n = Math.round(v.r[0] * v.r[0] * 26);
    for (const d of fib(n, R, -0.8)) {
      const p = [v.c[0] + d[0] * v.r[0], v.c[1] + d[1] * v.r[1], v.c[2] + d[2] * v.r[2]];
      if (p[1] < 0.15) continue;
      let hid = false;
      for (const w of vols) if (w !== v && inside(p, w, w.core ? 0.93 : 0.85)) { hid = true; break; }
      if (hid) continue;
      const nOut = ellNormal(p, v), cn = V.norm(V.sub(p, v.cc));
      const n2 = V.norm(V.lerp(nOut, cn, 0.45));
      const ao = occlusion(p, n2, vols, 0.55);
      const top = smooth(0.3, 1, p[1] / H);
      const base = lerpC(shape.col, shape.young || COL.treeYoung, top * (shape.youngAmt ?? 0.3) * R());
      const col = mulc([base[0] * v.tint[0], base[1] * v.tint[1], base[2] * v.tint[2]], R.range(0.85, 1.15));
      splats.push({ p, r: R.range(0.32, 0.55), n: n2, ao, col });
      // twiggy leaf sprays sticking out at the silhouette
      if (R() < 0.08) {
        const q = V.add(p, V.mul(n2, R.range(0.25, 0.6)));
        splats.push({ p: q, r: R.range(0.14, 0.26), n: n2, ao: Math.min(1, ao + 0.1), col: mulc(col, 1.05) });
      }
    }
  }
  return { splats, W, H };
}

// Splats for a black pine seen from the side: leaning trunk, crooked branches, flat clouds.
function crownPine(R, shape) {
  const H = 10;
  const W = H * shape.aspect;
  const splats = [];
  const lean = shape.lean;
  const trunkAt = (t) => [W * 0.5 * lean * (t - 0.45 * t * t) * 1.6 + Math.sin(t * 5 + shape.ph) * 0.2, t * H * 0.97, 0];
  const bark = [0.035, 0.028, 0.024];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    splats.push({ p: trunkAt(t), r: 0.22 * (1 - 0.6 * t) + 0.05, n: [0, 0, 1], ao: 0.7, col: bark, trunk: true });
  }
  const vols = [];
  const nB = shape.branches;
  for (let b = 0; b < nB; b++) {
    const t = lerp(0.35, 0.92, (b + R.range(0.2, 0.8)) / nB);
    const p0 = trunkAt(t);
    const side = b % 2 ? 1 : -1;
    const Lb = H * (0.42 - 0.3 * t) * R.range(0.8, 1.2);
    const z = R.range(-1, 1) * Lb * 0.4;
    const end = [p0[0] + side * Lb * R.range(0.6, 1), p0[1] + R.range(-0.3, 0.4), z];
    for (let i = 0; i <= 16; i++) {
      const u = i / 16;
      const q = V.lerp(p0, end, u);
      q[1] += Math.sin(u * Math.PI) * 0.3 + Math.sin(u * 9 + b) * 0.08;
      splats.push({ p: q, r: 0.1 * (1 - 0.5 * u) + 0.04, n: [0, 0, 1], ao: 0.6, col: bark, trunk: true });
    }
    const pr = clamp(0.6 + Lb * 0.28, 0.7, 1.8);
    vols.push({ c: V.add(end, [0, 0.2, 0]), r: [pr, pr * 0.38, pr] });
    if (Lb > 2.2) vols.push({ c: V.add(V.lerp(p0, end, 0.6), [0, 0.3, R.range(-0.4, 0.4)]), r: [pr * 0.7, pr * 0.3, pr * 0.7] });
  }
  const top = trunkAt(1);
  for (let i = 0; i < 3; i++) vols.push({ c: V.add(top, [R.range(-0.6, 0.6), R.range(-0.8, 0), R.range(-0.4, 0.4)]), r: [R.range(0.7, 1.1), R.range(0.35, 0.5), 0.9] });
  for (const v of vols) {
    const n = Math.round(v.r[0] * v.r[2] * 40);
    for (const d of fib(n, R, -0.9)) {
      const p = [v.c[0] + d[0] * v.r[0], v.c[1] + d[1] * v.r[1], v.c[2] + d[2] * v.r[2]];
      const nOut = ellNormal(p, v);
      const n2 = V.norm(V.add(nOut, [0, 0.25, 0]));
      const ao = occlusion(p, n2, vols, 0.9);
      const topf = smooth(-0.4, 0.8, d[1]);
      const col = mulc(lerpC(shape.col, [0.05, 0.085, 0.03], topf * 0.4), R.range(0.8, 1.15));
      splats.push({ p, r: R.range(0.22, 0.38), n: n2, ao, col, needle: true });
    }
  }
  return { splats, W, H };
}

const CROWN_SHAPES = [
  { kind: 'broad', aspect: 1.15, lumps: 11, col: [0.03, 0.056, 0.018] },
  { kind: 'broad', aspect: 0.85, lumps: 9, col: [0.028, 0.052, 0.017] },
  { kind: 'broad', aspect: 1.4, lumps: 13, col: [0.034, 0.06, 0.02], skew: 0.15 },
  { kind: 'broad', aspect: 1.2, lumps: 10, col: [0.04, 0.066, 0.022], skew: -0.3, youngAmt: 0.5 },
  { kind: 'broad', aspect: 1.0, lumps: 7, col: [0.03, 0.055, 0.02] },
  { kind: 'broad', aspect: 1.55, lumps: 8, col: [0.032, 0.058, 0.019], parts: [{ x: -3.6, w: 8, h: 8.5, y0: 0 }, { x: 2.8, w: 9.5, h: 10, y0: 0 }, { x: 0.2, w: 6, h: 6, y0: 3.8 }] },
  { kind: 'pine', aspect: 0.9, branches: 7, lean: 0.25, ph: 1.0, col: [0.022, 0.042, 0.022] },
  { kind: 'pine', aspect: 1.25, branches: 6, lean: 0.8, ph: 2.5, col: [0.024, 0.044, 0.024] },
];

function crownAtlas() {
  if (CROWNS) return CROWNS;
  const CW = CROWN_CELL, W = CW * CROWN_NX, H = CW * CROWN_NY;
  const alb = new Uint8ClampedArray(W * H * 4), nrm = new Uint8Array(W * H * 4);
  const zb = new Float32Array(W * H).fill(-1e9);
  for (let i = 0; i < W * H; i++) { nrm[i * 4] = 128; nrm[i * 4 + 1] = 128; nrm[i * 4 + 2] = 255; nrm[i * 4 + 3] = 255; }
  const aspect = [];
  CROWN_SHAPES.forEach((shape, vi) => {
    const R = rng(9001 + vi * 131);
    const { splats } = shape.kind === 'pine' ? crownPine(R, shape) : crownBroadleaf(R, shape);
    // fit the card to the splats' bounds: base at y = 0, centred in x
    let x0b = 1e9, x1b = -1e9, y0b = 1e9, y1b = -1e9;
    for (const sp of splats) { x0b = Math.min(x0b, sp.p[0] - sp.r); x1b = Math.max(x1b, sp.p[0] + sp.r); y0b = Math.min(y0b, sp.p[1] - sp.r); y1b = Math.max(y1b, sp.p[1] + sp.r); }
    const xm = (x0b + x1b) / 2;
    for (const sp of splats) { sp.p = [sp.p[0] - xm, sp.p[1] - y0b, sp.p[2]]; }
    const sw = (x1b - x0b) * 1.02, sh = (y1b - y0b) * 1.02;
    aspect[vi] = sw / sh;
    const ox = (vi % CROWN_NX) * CW, oy = Math.floor(vi / CROWN_NX) * CW;
    const pad = 3;
    for (const sp of splats) {
      const sx = ox + pad + (sp.p[0] / sw + 0.5) * (CW - 2 * pad), sy = oy + pad + (1 - (sp.p[1] + sh * 0.01) / sh) * (CW - 2 * pad);
      const rx = (sp.r / sw) * (CW - 2 * pad), ry = (sp.r / sh) * (CW - 2 * pad);
      const x0 = Math.max(ox, Math.floor(sx - rx * 1.3)), x1 = Math.min(ox + CW - 1, Math.ceil(sx + rx * 1.3));
      const y0 = Math.max(oy, Math.floor(sy - ry * 1.3)), y1 = Math.min(oy + CW - 1, Math.ceil(sy + ry * 1.3));
      const seedS = Math.floor(sp.p[0] * 131 + sp.p[1] * 71 + sp.p[2] * 37);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - sx) / rx, dy = (y + 0.5 - sy) / ry;
        const d2 = dx * dx + dy * dy;
        if (d2 > 1.7) continue;
        // ragged, leafy edge
        const ang = Math.atan2(dy, dx);
        const e = sp.trunk ? 1 : 0.72 + 0.4 * vnoise(ang * 2.5 + 10, seedS * 0.37, 7) + 0.25 * (vnoise(x * 0.9, y * 0.9, 11) - 0.5);
        if (d2 > e * e) continue;
        const dd = Math.min(1, d2 / (e * e));
        const z = sp.p[2] + sp.r * Math.sqrt(1 - dd);
        const i = y * W + x;
        if (z <= zb[i]) continue;
        zb[i] = z;
        const sn = [dx, -dy, Math.sqrt(Math.max(0, 1 - dd))];
        let n = sp.trunk ? V.norm([dx * 0.8, 0, 1]) : V.norm(V.lerp(V.norm(sn), sp.n, 0.5));
        // leaf texture: small-scale mottling (and streaks for pine needles)
        const fine = sp.needle ? vnoise(x * 0.45 + y * 0.9, y * 0.45 - x * 0.2, 3) : vnoise(x * 0.55, y * 0.55, 5);
        const k = (0.72 + 0.56 * fine) * (1 - 0.22 * dd);
        alb[i * 4] = Math.round(L2S(sp.col[0] * k) * 255); alb[i * 4 + 1] = Math.round(L2S(sp.col[1] * k) * 255); alb[i * 4 + 2] = Math.round(L2S(sp.col[2] * k) * 255); alb[i * 4 + 3] = 255;
        n = V.norm(V.add(n, [(fine - 0.5) * 0.35, (vnoise(x * 0.55 + 50, y * 0.55, 6) - 0.5) * 0.35, 0]));
        const ao = clamp(sp.ao * (1 - 0.3 * dd * (dy > 0 ? 1 : 0.35)) * (0.85 + 0.3 * fine), 0, 1);
        nrm[i * 4] = Math.round((n[0] * 0.5 + 0.5) * 255); nrm[i * 4 + 1] = Math.round((n[1] * 0.5 + 0.5) * 255); nrm[i * 4 + 2] = Math.round((n[2] * 0.5 + 0.5) * 255);
        nrm[i * 4 + 3] = Math.round(ao * 255);
      }
    }
  });
  pushPull(alb, W, H);
  const albF = flipRows(alb, W, H), nrmF = flipRows(nrm, W, H);
  const rects = [];
  for (let v = 0; v < CROWN_NX * CROWN_NY; v++) rects.push({ x: (v % CROWN_NX) * CW, y: H - (Math.floor(v / CROWN_NX) + 1) * CW, w: CW, h: CW });
  const map = alphaTestedTexture(albF, W, H, rects);
  map.anisotropy = 4;
  const ntex = dataTexture(nrmF, W, H, false);
  CROWNS = { map, normal: ntex, aspect, W, H, alb, nrm };
  return CROWNS;
}

const BB_VERT_PARS = /* glsl */`
attribute vec4 aCrown;      // x: variant, y: random 0..1, z: width / height, w: mirror (+1 / -1)
uniform vec4 uCrownGrid;    // x: columns, y: rows, z: uv inset, w: tilt toward the camera (0..1)
varying vec3 vBbR;
varying vec3 vBbU;
varying vec3 vBbF;
varying float vBbMirror;
`;
const BB_UV = /* glsl */`
{
  float vi = floor( aCrown.x + 0.5 );
  float col = mod( vi, uCrownGrid.x );
  float row = floor( vi / uCrownGrid.x );
  vec2 cuv = vec2( aCrown.w > 0.0 ? uv.x : 1.0 - uv.x, uv.y );
  cuv = mix( vec2( uCrownGrid.z ), vec2( 1.0 - uCrownGrid.z ), cuv );
  vMapUv = ( vec2( col, uCrownGrid.y - 1.0 - row ) + cuv ) / uCrownGrid.xy;
  vBbMirror = aCrown.w;
}
`;
// card basis facing `fwd`; transformed is in instance space (instance = translate(base) * scale(S))
const BB_BEGIN = /* glsl */`
vec3 transformed;
{
  #ifdef USE_INSTANCING
    vec3 bbBase = instanceMatrix[3].xyz;
    float bbS = length( instanceMatrix[1].xyz );
  #else
    vec3 bbBase = vec3( 0.0 );
    float bbS = 1.0;
  #endif
  vec3 camL = cameraPosition - modelMatrix[3].xyz;
  vec3 ctr = bbBase + vec3( 0.0, 0.5 * bbS, 0.0 );
  vec3 tc = camL - ctr;
  vec3 th = vec3( tc.x, 0.0, tc.z );
  float lh = length( th );
  vec3 fwdH = lh > 1e-3 ? th / lh : vec3( 0.0, 0.0, 1.0 );
  vec3 fwd = normalize( mix( fwdH, tc / max( length( tc ), 1e-3 ), uCrownGrid.w ) );
  vec3 right = normalize( cross( vec3( 0.0, 1.0, 0.0 ), fwd ) );
  vec3 up = cross( fwd, right );
  transformed = vec3( 0.0, 0.5, 0.0 ) + right * ( position.x * aCrown.z ) + up * ( position.y - 0.5 );
  vBbR = right; vBbU = up; vBbF = fwd;
  vNormal = normalize( normalMatrix * fwd );
}
`;
// shadow pass: face the light (orthographic sun camera), pushed back by half the crown width
const BB_BEGIN_DEPTH = /* glsl */`
vec3 transformed;
{
  #ifdef USE_INSTANCING
    float bbS = length( instanceMatrix[1].xyz );
  #else
    float bbS = 1.0;
  #endif
  vec3 toL = normalize( vec3( viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2] ) );
  vec3 right = normalize( cross( abs( toL.y ) > 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 0.0, 1.0, 0.0 ), toL ) );
  vec3 up = cross( toL, right );
  transformed = vec3( 0.0, 0.5, 0.0 ) - toL * ( 0.45 * aCrown.z ) + right * ( position.x * aCrown.z ) + up * ( position.y - 0.5 );
}
`;

let FOREST = null;
// { material, geometry, depthMaterial }: shared material and the base quad for crown cards.
export function forestBillboards() {
  if (FOREST) return FOREST;
  const C = crownAtlas();
  const m = new THREE.MeshStandardMaterial({ name: 'flora-forest', map: C.map, alphaTest: 0.5, roughness: 0.78, metalness: 0, side: THREE.FrontSide, shadowSide: THREE.DoubleSide });
  const grid = new THREE.Vector4(CROWN_NX, CROWN_NY, 0.003, 0.4);
  const ut = new THREE.Vector4(0.45, 4, 1, 0.45);
  prep(m, (shader) => {
    shader.uniforms.uCrownNrm = { value: C.normal };
    shader.uniforms.uCrownGrid = { value: grid };
    shader.uniforms.uFloraTrans = { value: ut };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + BB_VERT_PARS)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n' + BB_UV)
      .replace('#include <begin_vertex>', BB_BEGIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
#define vFloraOcc 1.0
uniform sampler2D uCrownNrm;
varying vec3 vBbR;
varying vec3 vBbU;
varying vec3 vBbF;
varying float vBbMirror;`)
      .replace('#include <lights_physical_pars_fragment>', '#include <lights_physical_pars_fragment>\n' + FOLIAGE_FRAG_PARS)
      .replace('#include <normal_fragment_begin>', `
float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
vec4 crownN = texture2D( uCrownNrm, vMapUv );
vec3 tn = crownN.xyz * 2.0 - 1.0;
tn.x *= vBbMirror;
vec3 nW = normalize( vBbR * tn.x + vBbU * tn.y + vBbF * max( tn.z, 0.05 ) );
vec3 normal = normalize( ( viewMatrix * vec4( nW, 0.0 ) ).xyz );
vec3 nonPerturbedNormal = normal;`)
      .replace('#include <lights_fragment_begin>', LIGHTS_TRANS)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
  float crownAO = crownN.a;
  reflectedLight.indirectDiffuse *= crownAO;
  reflectedLight.indirectSpecular *= crownAO * crownAO * uFloraTrans.w;
  reflectedLight.directDiffuse *= mix( 0.45, 1.0, crownAO );
  reflectedLight.directSpecular *= crownAO * uFloraTrans.w;`);
  }, 'flora-forest');
  const dm = new THREE.MeshDepthMaterial();
  prep(dm, (shader) => {
    shader.uniforms.uCrownGrid = { value: grid };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + BB_VERT_PARS)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n' + BB_UV)
      .replace('#include <begin_vertex>', BB_BEGIN_DEPTH);
  }, 'flora-forest-depth');
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  // bounds of the swept card (it turns about y and tilts): widest crown is ~1.6 x its height
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-0.85, -0.1, -0.85), new THREE.Vector3(0.85, 1.1, 0.85));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 1.05);
  FOREST = { material: m, geometry: g, depthMaterial: dm, variants: CROWN_SHAPES.length, aspect: C.aspect.slice() };
  return FOREST;
}

// points: [{x, y, z, s, v}] (crown base position, crown height m, variant 0..7)
// -> InstancedMesh of camera-facing crown cards (castShadow + receiveShadow, instance colours).
export function forestInstances(points) {
  const F = forestBillboards();
  const n = points.length;
  const geo = F.geometry.clone();
  geo.boundingBox = F.geometry.boundingBox.clone();
  geo.boundingSphere = F.geometry.boundingSphere.clone();
  const attr = new Float32Array(n * 4);
  const mesh = new THREE.InstancedMesh(geo, F.material, n);
  mesh.name = 'forest';
  const m4 = new THREE.Matrix4(), col = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const v = ((Math.round(p.v ?? 0) % F.variants) + F.variants) % F.variants;
    const h1 = hash2i(Math.round(p.x * 10), Math.round(p.z * 10), 71), h2 = hash2i(Math.round(p.x * 10), Math.round(p.z * 10), 72), h3 = hash2i(Math.round(p.x * 10), Math.round(p.z * 10), 73);
    const s = p.s ?? 10;
    m4.makeScale(s, s, s).setPosition(p.x, p.y, p.z);
    mesh.setMatrixAt(i, m4);
    attr[i * 4] = v; attr[i * 4 + 1] = h1; attr[i * 4 + 2] = F.aspect[v] * (0.92 + 0.16 * h2); attr[i * 4 + 3] = h3 < 0.5 ? 1 : -1;
    // colour: mostly dark evergreen; some yellow-green (bamboo / new growth), some bluish-dark
    let c = [1, 1, 1];
    const k = 0.85 + 0.3 * h2;
    if (v < 6 && h1 < 0.1) c = [1.45, 1.35, 0.8];
    else if (v < 6 && h1 < 0.2) c = [1.15, 1.12, 0.9];
    else if (h1 > 0.9) c = [0.85, 0.9, 1.0];
    col.setRGB(c[0] * k, c[1] * k, c[2] * k);
    mesh.setColorAt(i, col);
  }
  geo.setAttribute('aCrown', new THREE.InstancedBufferAttribute(attr, 4));
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.customDepthMaterial = F.depthMaterial;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  return mesh;
}

// A 120 x 120 m patch of ~800 crowns on a gentle slope, for judging the impostors
// (view from ~80-200 m). opts: seed, slope (rise per metre toward -z), n (approx count)
MODELS.forestDemo = (opts = {}) => {
  const R = rng(num(opts.seed, 1) * 97 + 1);
  const slope = num(opts.slope, 0.22);
  const size = 120;
  const g = new THREE.Group();
  g.name = 'forestDemo';
  const groundAt = (x, z) => (size / 2 - z) * slope + 2.5 * Math.sin(x * 0.05) * Math.cos(z * 0.04);
  const pg = new THREE.PlaneGeometry(size + 30, size + 30, 40, 40).rotateX(-Math.PI / 2);
  const pos = pg.attributes.position;
  const cols = [];
  for (let i = 0; i < pos.count; i++) { pos.setY(i, groundAt(pos.getX(i), pos.getZ(i)) - 0.3); cols.push(0.05, 0.06, 0.035); }
  pg.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  pg.computeVertexNormals();
  const gm = new THREE.Mesh(pg, prep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }), null, 'flora-demo-ground'));
  gm.receiveShadow = true;
  g.add(gm);
  const spacing = num(opts.spacing, 4.2);
  const pts = [];
  for (let z = -size / 2; z < size / 2; z += spacing) for (let x = -size / 2; x < size / 2; x += spacing) {
    const px = x + R.range(-0.45, 0.45) * spacing, pz = z + R.range(-0.45, 0.45) * spacing;
    const s = R.range(6, 13);
    const pine = R() < 0.1;
    pts.push({ x: px, y: groundAt(px, pz) + s * R.range(0.05, 0.25), z: pz, s, v: pine ? 6 + R.int(0, 1) : R.int(0, 5) });
  }
  g.add(forestInstances(pts));
  g.userData.count = pts.length;
  return g;
};

// Debug: dump the crown atlas (albedo over grey, normal, ao) as data URLs.
export function _crownDebug() {
  const C = crownAtlas();
  const mk = (fn) => {
    const c = document.createElement('canvas'); c.width = C.W; c.height = C.H;
    const ctx = c.getContext('2d'); const img = ctx.createImageData(C.W, C.H);
    for (let i = 0; i < C.W * C.H; i++) { const o = fn(i); img.data[i * 4] = o[0]; img.data[i * 4 + 1] = o[1]; img.data[i * 4 + 2] = o[2]; img.data[i * 4 + 3] = 255; }
    ctx.putImageData(img, 0, 0); return c.toDataURL('image/png');
  };
  return {
    albedo: mk((i) => { const a = C.alb[i * 4 + 3] / 255; return [C.alb[i * 4] * a + 150 * (1 - a), C.alb[i * 4 + 1] * a + 160 * (1 - a), C.alb[i * 4 + 2] * a + 175 * (1 - a)]; }),
    normal: mk((i) => [C.nrm[i * 4], C.nrm[i * 4 + 1], C.nrm[i * 4 + 2]]),
    ao: mk((i) => [C.nrm[i * 4 + 3], C.nrm[i * 4 + 3], C.nrm[i * 4 + 3]]),
  };
}

// Debug: several variants of one model side by side (view=model&model=floraLineup&of=potted&n=6&gap=0.7)
MODELS.floraLineup = (opts = {}) => {
  const of = MODELS[opts.of] ? opts.of : 'potted';
  const n = Math.round(num(opts.n, 6)), gap = num(opts.gap, 0.8);
  const g = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const o = MODELS[of]({ ...opts, seed: String(num(opts.seed0, 1) + i) });
    o.position.x = (i - (n - 1) / 2) * gap;
    g.add(o);
  }
  return g;
};

// Debug: a few leaf cards at different orientations (shadow test)
MODELS.floraCards = (opts = {}) => {
  const M = mats(), AT = leafAtlas();
  const A = new Acc();
  const up = () => [0, 1, 0];
  const list = [
    () => card(A, [-2, 3, +(opts.z || 0)], [1, 0, 0], [0, 0, -1], 0.8, 0.8, AT.uv.hydLeaf, [1, 1, 1], up),
    () => card(A, [0, 3, +(opts.z || 0)], [1, 0, 0], V.norm([0, 1, -1]), 0.8, 0.8, AT.uv.tree0, [1, 1, 1], up),
    () => card(A, [2, 3, +(opts.z || 0)], [1, 0, 0], [0, 1, 0], 0.8, 0.8, AT.uv.ivy0, [1, 1, 1], up),
    () => card(A, [0, 3, -2.5], [1, 0, 0], V.norm([0, 0.2, -1]), 0.8, 0.8, AT.uv.mgBlue, [1, 1, 1], up),
  ];
  if (opts.rev) list.reverse();
  list.forEach((f) => f());
  const g = new THREE.Group();
  let tex = AT.map;
  if (opts.canvas) { tex = new THREE.CanvasTexture(AT.canvas); tex.colorSpace = THREE.SRGBColorSpace; }
  const mat = opts.basic ? new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide }) : M.tree;
  const mesh = meshOf(A, mat, 'cards');
  if (opts.nodepth) mesh.customDepthMaterial = undefined;
  g.add(mesh);
  return g;
};

// Debug: the atlas on a board (view=model&model=floraAtlas)
MODELS.floraAtlas = (opts = {}) => {
  const A = leafAtlas();
  const which = opts.which === 'normal' ? A.normal : A.map;
  const m = new THREE.MeshBasicMaterial({ map: which, alphaTest: opts.which === 'normal' ? 0 : 0.5, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), m);
  mesh.position.y = 2.2;
  const g = new THREE.Group();
  g.add(mesh);
  return g;
};

// Debug hook: data URLs of the atlas canvases.
export function _floraDebug() {
  const A = leafAtlas();
  return { albedo: A.canvas.toDataURL('image/png'), normal: A.ncanvas.toDataURL('image/png') };
}

// Build InstancedMeshes for every mesh of a model (copies depth materials and flags).
export function makeInstanced(obj, count) {
  const group = new THREE.Group();
  group.name = (obj.name || 'flora') + ':instanced';
  obj.traverse((m) => {
    if (!m.isMesh) return;
    const im = new THREE.InstancedMesh(m.geometry, m.material, count);
    im.name = m.name;
    im.castShadow = m.castShadow;
    im.receiveShadow = m.receiveShadow;
    if (m.customDepthMaterial) im.customDepthMaterial = m.customDepthMaterial;
    group.add(im);
  });
  return group;
}
