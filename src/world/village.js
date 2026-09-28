// The village: lots along the slope street, a row of houses facing the harbour, and
// houses scattered over the slope (facing downhill). Each lot is a level pad held by
// a stone (or block) retaining wall where the ground falls away; houses stand on the
// pads. Everything is merged per material in spatial chunks to keep draw calls low.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Builder } from './builder.js';
import { materials } from './lib.js';
import {
  STREET, STREET_W, STREET_PROFILE, streetHeight, ground, groundNatural, villageMask, gentleMask,
  paddyMask, COVE, QUAY_H, BREAKWATERS,
} from './geo.js';
import { rng, polyDist } from './noise.js';

// ---------------------------------------------------------------------------
// Lot generation (deterministic)
// ---------------------------------------------------------------------------
function rectSamples(l, fn) {
  const c = Math.cos(l.rotY), s = Math.sin(l.rotY);
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const lx = (i / 4 - 0.5) * l.w, lz = (j / 4 - 0.5) * l.d;
      // local x -> world (c, -s), local z -> world (s, c) for three's Y rotation
      const x = l.x + lx * c + lz * s, z = l.z - lx * s + lz * c;
      const h = fn(x, z);
      mn = Math.min(mn, h); mx = Math.max(mx, h);
    }
  }
  return [mn, mx];
}

function overlaps(a, b, margin = 1.2) {
  const ra = Math.hypot(a.w, a.d) / 2, rb = Math.hypot(b.w, b.d) / 2;
  return Math.hypot(a.x - b.x, a.z - b.z) < (ra + rb) * 0.82 + margin;
}

export function generateLots() {
  const R = rng(2828);
  const lots = [];
  const P = STREET_PROFILE;
  const half = STREET_W / 2;
  // 1) along the slope street, both sides
  for (const side of [-1, 1]) {
    let s = side < 0 ? 10 : 16;
    let k = 0;
    while (s < P.total - 18) {
      const fw = R.range(7.5, 10.5), dd = R.range(8, 10.5);
      const sm = s + fw / 2;
      const [x0, z0] = P.at(sm - 0.5), [x1, z1] = P.at(sm + 0.5);
      const tx = x1 - x0, tz = z1 - z0, tl = Math.hypot(tx, tz);
      const nx = -tz / tl * side, nz = tx / tl * side;          // away from the street
      const off = half + R.range(0.6, 1.4) + dd / 2;
      const x = x0 + nx * off, z = z0 + nz * off;
      k++;
      const walk = sm > 170 && sm < 290;           // keep the noon walk lined with houses
      if (walk ? R.chance(0.04) : (R.chance(0.1) || (k % 6 === 0))) {
        // a lane or a garden plot: gardens get a low-walled pad with plants later
        if (R.chance(0.6)) {
          const rotY = Math.atan2(-nx, -nz);
          lots.push({ x, z, w: fw, d: dd, rotY, kind: 'garden', seed: R.int(1, 1e6), street: true, s: sm, side });
        }
        s += fw + 3.5; continue;
      }
      // the house front (+z local) faces the street: rotation so local +z = -n
      const rotY = Math.atan2(-nx, -nz);
      const lot = { x, z, w: fw, d: dd, rotY, kind: 'house', seed: R.int(1, 1e6), street: true, s: sm, side };
      lots.push(lot);
      s += fw + R.range(0.6, 2.2);
    }
  }
  // 2) the quay: a row facing the water
  for (let a = -0.95; a < 1.05; a += 0.0) {
    const r = COVE.r + 20;
    const x = COVE.x + Math.cos(a) * r, z = COVE.z + Math.sin(a) * r;
    const q = polyDist(x, z, STREET);
    const w = R.range(12, 19);
    const da = w / r;
    if (q.d < 14 || villageMask(x, z) < 0.3) { a += da * 0.6; continue; }
    const kind = R.chance(0.45) ? 'row' : R.chance(0.2) ? 'shed' : 'house';
    const rotY = Math.atan2(-Math.cos(a), -Math.sin(a));          // front faces the harbour centre
    lots.push({ x, z, w: kind === 'row' ? w : Math.min(w, 10), d: 9, rotY, kind, seed: R.int(1, 1e6), quay: true });
    a += da + R.range(0.01, 0.03);
  }
  // the fishery co-op by the harbour, south of the street's foot
  {
    const a = 0.2, r = COVE.r + 21;
    lots.push({ x: COVE.x + Math.cos(a) * r, z: COVE.z + Math.sin(a) * r, w: 16, d: 11, rotY: Math.atan2(-Math.cos(a), -Math.sin(a)), kind: 'coop', seed: 7, quay: true });
  }
  // 3) rows along lanes that ring the cove (roughly following the contours), all
  //    facing downhill toward the harbour; gaps become gardens and fields
  const lanes = [];
  for (const [ri, r0] of [[0, 212], [1, 246], [2, 281], [3, 318], [4, 356], [5, 392]].values()) {
    const lane = [];
    for (let a = -1.35; a <= 1.4; a += 0.02) {
      const r = r0 + 9 * Math.sin(a * 3.1 + ri) + 5 * Math.sin(a * 7.3 + ri * 2);
      lane.push([COVE.x + Math.cos(a) * r, COVE.z + Math.sin(a) * r, a, r]);
    }
    lanes.push(lane);
    let acc = R.range(0, 10);
    for (let i = 1; i < lane.length; i++) {
      const [x, z, a, r] = lane[i];
      acc += Math.hypot(x - lane[i - 1][0], z - lane[i - 1][1]);
      if (acc < 0) continue;
      const vm = villageMask(x, z);
      if (vm < 0.45 || paddyMask(x, z) > 0.02 || polyDist(x, z, STREET).d < half + 13 || (x < 275 && z < -205)) { acc = -3; continue; }
      if (R() > 0.35 + 0.6 * vm) { acc = -R.range(6, 14); continue; }        // a garden / field
      const w = R.range(7.5, 10.5), d = R.range(7.5, 9.5);
      // lot just uphill (outside) of the lane, front toward the cove centre
      const rr = r + 2.2 + d / 2;
      const lx = COVE.x + Math.cos(a) * rr, lz = COVE.z + Math.sin(a) * rr;
      const rotY = Math.atan2(-Math.cos(a), -Math.sin(a)) + R.range(-0.08, 0.08);
      const kind = R.chance(0.1) ? 'shed' : R.chance(0.08) ? 'field' : 'house';
      const lot = { x: lx, z: lz, w: kind === 'field' ? R.range(10, 16) : w, d, rotY, kind, seed: R.int(1, 1e6), lane: ri };
      if (!lots.some((o) => overlaps(o, lot, 0.6))) lots.push(lot);
      acc = -(w + R.range(0.8, 2.5));
    }
  }
  lots.lanes = lanes;
  // pad heights; lots on ground too steep to level are dropped
  const out = [];
  for (const l of lots) {
    const [mn, mx] = rectSamples(l, ground);
    l.ground = [mn, mx];
    l.padH = mx + 0.12;
    if (l.street) l.padH = Math.max(l.padH, streetHeight(l.s) + 0.22 + R.range(0, 0.5));
    if (l.quay) l.padH = Math.max(l.padH, QUAY_H + 0.25);
    if (!l.street && !l.quay && mx - mn > 3.2) continue;
    out.push(l);
  }
  out.lanes = lots.lanes;
  return out;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------
// Merge the meshes of many objects (with their world transforms) by material,
// in square chunks of `chunk` metres so frustum culling still helps.
export function mergeByMaterial(objects, chunk = 80, name = 'merged') {
  const bins = new Map();
  for (const o of objects) {
    o.updateMatrixWorld(true);
    o.traverse((m) => {
      if (!m.isMesh || m.isInstancedMesh) return;
      const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
      g.computeBoundingSphere();
      const c = g.boundingSphere.center;
      const key = `${Math.floor(c.x / chunk)},${Math.floor(c.z / chunk)}`;
      const k = m.material.uuid + '|' + key + '|' + (m.castShadow ? 1 : 0);
      if (!bins.has(k)) bins.set(k, { mat: m.material, list: [], cast: m.castShadow });
      bins.get(k).list.push(g);
    });
  }
  const group = new THREE.Group();
  group.name = name;
  for (const { mat, list, cast } of bins.values()) {
    // attribute sets must match; drop extras that some parts lack
    const keys = Object.keys(list[0].attributes).filter((a) => list.every((g) => g.attributes[a]));
    const clean = list.map((g) => {
      const x = g.index ? g.toNonIndexed() : g;
      for (const a of Object.keys(x.attributes)) if (!keys.includes(a)) x.deleteAttribute(a);
      return x;
    });
    const merged = mergeGeometries(clean, false);
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

// Placeholder house until the house family is available.
function boxHouse(l) {
  const M = materials();
  const B = new Builder();
  const w = l.w - 1.2, d = l.d - 1.5, h = 5.5;
  B.box(M.woodV, { w, h, d, pos: [0, h / 2, 0] });
  B.box(M.roofTile, { w: w + 1.2, h: 0.4, d: d + 1.2, pos: [0, h + 0.2, 0] });
  return B.build({ name: 'boxhouse' });
}

export function buildVillage(MODELS, { lots = generateLots() } = {}) {
  const M = materials();
  const R = rng(515);
  const pads = new Builder();
  const objs = [];
  for (const l of lots) {
    const [mn] = l.ground;
    const bottom = Math.min(mn, l.padH) - 0.6;
    const wallMat = l.quay ? M.concrete : R.chance(0.72) ? M.stoneWall : R.chance(0.5) ? M.block : M.concrete;
    const tone = 0.85 + 0.25 * R();
    const hWall = l.padH - 0.04 - bottom;
    // retaining wall block (only its sides show above the ground)
    const cw = l.w + 0.8, cd = l.d + 0.8;
    const m = new THREE.Matrix4().makeRotationY(l.rotY).setPosition(l.x, 0, l.z);
    pads.box(wallMat, { w: cw, h: hWall, d: cd, pos: [0, bottom + hWall / 2, 0], matrix: m, color: [tone, tone, tone * 0.97] });
    // yard surface
    const top = l.quay ? M.concrete : R.chance(0.6) ? M.dirt : M.concrete;
    pads.box(top, { w: cw - 0.05, h: 0.1, d: cd - 0.05, pos: [0, l.padH - 0.05, 0], matrix: m, color: [tone, tone * 0.98, tone * 0.95] });
    if (l.kind === 'garden' || l.kind === 'field') continue;
    // the building
    let o = null;
    const fn = MODELS[l.kind] || MODELS.house;
    const opts = { seed: l.seed, w: Math.min(l.w - 1.0, l.kind === 'row' || l.kind === 'coop' ? 20 : 11), d: Math.min(l.d - 1.2, 10), lit: 0.4 };
    if (l.kind === 'shed') { opts.w = Math.min(4.5, opts.w); opts.d = Math.min(3.5, opts.d); }
    try { o = fn ? fn(opts) : boxHouse(l); } catch (e) { console.warn('house failed', e.message); o = boxHouse(l); }
    o.position.set(l.x, l.padH, l.z);
    o.rotation.y = l.rotY;
    if (l.kind === 'shed') o.position.add(new THREE.Vector3(Math.sin(l.rotY) * -1.5, 0, Math.cos(l.rotY) * -1.5));
    objs.push(o);
  }
  const group = new THREE.Group();
  group.name = 'village';
  group.add(pads.build({ name: 'pads' }));
  group.add(mergeByMaterial(objs, 70, 'houses'));
  group.userData.lots = lots;
  return group;
}

// The asphalt ribbon of the slope street (with a concrete gutter strip on each side).
export function buildStreet() {
  const M = materials();
  const P = STREET_PROFILE;
  const half = STREET_W / 2;
  const pos = [], uv = [], idx = [], col = [];
  const n = Math.ceil(P.total / 1.0);
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * P.total;
    const [x0, z0] = P.at(s - 0.5), [x1, z1] = P.at(s + 0.5);
    const tx = x1 - x0, tz = z1 - z0, tl = Math.hypot(tx, tz) || 1;
    const nx = -tz / tl, nz = tx / tl;
    const [x, z] = P.at(s);
    const h = streetHeight(s) + 0.02;
    for (const k of [-1, 1]) {
      pos.push(x + nx * half * k, h, z + nz * half * k);
      uv.push(k * half, s);
      col.push(1, 1, 1);
    }
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, M.asphalt);
  mesh.receiveShadow = true;
  mesh.name = 'street';
  // concrete gutters (側溝) with lids along both edges, and a kerb strip beyond them
  const B = new Builder();
  const R = rng(733);
  for (let s = 0.5; s < P.total - 0.5; s += 1.0) {
    const [x0, z0] = P.at(s - 0.5), [x1, z1] = P.at(s + 0.5);
    const tx = x1 - x0, tz = z1 - z0, tl = Math.hypot(tx, tz) || 1;
    const nx = -tz / tl, nz = tx / tl;
    const [x, z] = P.at(s);
    const h = streetHeight(s);
    const rotY = Math.atan2(tx, tz);
    const pitch = Math.atan2(streetHeight(s - 0.5) - streetHeight(s + 0.5), tl);
    for (const k of [-1, 1]) {
      const tone = 0.62 + 0.18 * R();
      const o = half + 0.24;
      B.box(M.concrete, { w: 0.46, h: 0.16, d: 0.985, pos: [x + nx * o * k, h - 0.04, z + nz * o * k], rot: [pitch, rotY, 0], color: [tone, tone * 0.99, tone * 0.95] });
      const o2 = half + 0.62;
      B.box(M.concrete, { w: 0.3, h: 0.22, d: 1.02, pos: [x + nx * o2 * k, h - 0.02, z + nz * o2 * k], rot: [pitch, rotY, 0], color: [0.52 * tone, 0.52 * tone, 0.49 * tone] });
    }
  }
  const group = new THREE.Group();
  group.name = 'street';
  group.add(mesh, B.build({ name: 'gutters' }));
  return group;
}
