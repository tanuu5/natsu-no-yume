// Planting: where every plant goes. Spots are generated per area (terraces, the
// street, the station, the quay, the forest), then each plant kind is built a few
// times (seed variants) and instanced.
import * as THREE from 'three';
import {
  ground, groundNatural, forestMask, paddyMask, PADDY_STEP, PADDY_BOX, villageMask, STREET, STREET_W,
  STREET_PROFILE, streetHeight, sdLand, railXAt, RAIL_H, STATION, SEAWALL_OFF, COVE, QUAY_H,
} from './geo.js';
import { canopy } from './terrain.js';
import { rng, hash2, perlin, polyDist } from './noise.js';

// ---------------------------------------------------------------------------
// Instancing
// ---------------------------------------------------------------------------
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();

// spots: [{x, y, z, rotY, s, v}] (v = variant index). build(v) -> Object3D.
export function instance(name, spots, variants, build, makeInstanced) {
  const group = new THREE.Group();
  group.name = 'plants:' + name;
  for (let v = 0; v < variants; v++) {
    const list = spots.filter((p) => (p.v ?? 0) % variants === v);
    if (!list.length) continue;
    let obj;
    try { obj = build(v); } catch (e) { console.warn(`plant ${name} failed: ${e.message}`); return group; }
    const inst = makeInstanced(obj, list.length);
    inst.traverse((im) => {
      if (!im.isInstancedMesh) return;
      list.forEach((p, i) => {
        _e.set(p.rx || 0, p.rotY || 0, p.rz || 0, 'YXZ');
        _q.setFromEuler(_e);
        _p.set(p.x, p.y, p.z);
        const s = p.s ?? 1;
        _s.set(s * (p.sx ?? 1), s * (p.sy ?? 1), s * (p.sz ?? 1));
        _m.compose(_p, _q, _s);
        im.setMatrixAt(i, _m);
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
    });
    group.add(inst);
  }
  return group;
}

// ---------------------------------------------------------------------------
// Spot generators
// ---------------------------------------------------------------------------
// Terrace level variable (as in paddies.js / geo.paddyTerrain).
function hq(x, z) {
  const e = 0.6;
  const g = groundNatural(x, z);
  const gx = (groundNatural(x + e, z) - groundNatural(x - e, z)) / (2 * e), gz = (groundNatural(x, z + e) - groundNatural(x, z - e)) / (2 * e);
  return { h: g - 0.3 * Math.hypot(gx, gz), gx, gz };
}

// Rice tufts in rows, near a walk path (list of [x, z]) within `radius`.
export function riceSpots(path, radius = 26, seed = 1) {
  const R = rng(seed);
  const out = [];
  const xs = path.map((p) => p[0]), zs = path.map((p) => p[1]);
  const x0 = Math.min(...xs) - radius, x1 = Math.max(...xs) + radius, z0 = Math.min(...zs) - radius, z1 = Math.max(...zs) + radius;
  const row = 0.3, gap = 0.22;
  for (let z = z0; z < z1; z += row) {
    for (let x = x0 + R() * gap; x < x1; x += gap) {
      let near = Infinity;
      for (const [px, pz] of path) near = Math.min(near, Math.hypot(x - px, z - pz));
      if (near > radius || near < 1.1) continue;
      if (paddyMask(x, z) < 0.6) continue;
      const { h } = hq(x, z);
      const f = h / PADDY_STEP - Math.floor(h / PADDY_STEP);
      if (f < 0.12 || f > 0.93) continue;           // keep off the levees
      const L = Math.floor(h / PADDY_STEP);
      if (R() < 0.04) continue;                      // a missing hill here and there
      out.push({ x: x + (R() - 0.5) * 0.05, y: L * PADDY_STEP - 0.035, z: z + (R() - 0.5) * 0.05, rotY: R() * 6.28, s: 0.85 + R() * 0.3, v: R.int(0, 7) });
    }
  }
  return out;
}

// Along a path: plants on one side (side = +1 right, -1 left), spacing, offset.
export function alongPath(path, { side = 1, spacing = 1.6, offset = 1.0, jitter = 0.4, heightAt = ground, seed = 2, skip = 0, yOff = 0 } = {}) {
  const R = rng(seed);
  const out = [];
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, az] = path[i], [bx, bz] = path[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const nx = -(bz - az) / len * side, nz = (bx - ax) / len * side;
    for (let s = R() * spacing; s < len; s += spacing * (0.7 + 0.6 * R())) {
      if (R() < skip) continue;
      const t = s / len;
      const o = offset + (R() - 0.5) * jitter;
      const x = ax + (bx - ax) * t + nx * o, z = az + (bz - az) * t + nz * o;
      out.push({ x, y: heightAt(x, z) + yOff, z, rotY: R() * 6.28, s: 0.8 + R() * 0.45, v: R.int(0, 7) });
    }
  }
  return out;
}

// Scatter in an area with a density function (0..1) on a jittered grid.
export function scatter({ x0, x1, z0, z1, spacing, density, heightAt = ground, seed = 3, scale = [0.8, 1.2] }) {
  const R = rng(seed);
  const out = [];
  for (let z = z0; z < z1; z += spacing) {
    for (let x = x0; x < x1; x += spacing) {
      const px = x + (R() - 0.5) * spacing, pz = z + (R() - 0.5) * spacing;
      const d = density(px, pz);
      if (d <= 0 || R() > d) continue;
      out.push({ x: px, y: heightAt(px, pz), z: pz, rotY: R() * 6.28, s: scale[0] + R() * (scale[1] - scale[0]), v: R.int(0, 7) });
    }
  }
  return out;
}

// Forest crowns: billboards over the canopy, denser near the shots' view.
export function forestSpots({ x0 = -700, x1 = 1600, z0 = -1700, z1 = 1100, spacing = 7.5, seed = 4 } = {}) {
  const R = rng(seed);
  const out = [];
  for (let z = z0; z < z1; z += spacing) {
    for (let x = x0; x < x1; x += spacing) {
      const px = x + (R() - 0.5) * spacing * 0.9, pz = z + (R() - 0.5) * spacing * 0.9;
      const g = ground(px, pz);
      if (g < 1) continue;
      const f = forestMask(px, pz, g);
      if (f < 0.35 || R() > f) continue;
      const top = g + canopy(px, pz, f);
      const s = 7 + R() * 7;
      out.push({ x: px, y: top - s * 0.72, z: pz, s, v: R.int(0, 7) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Everything, placed. Returns a Group.
// ---------------------------------------------------------------------------
export function populatePlants(MODELS, FAMILY, { walks, lots, streetHalf = STREET_W / 2 }) {
  const group = new THREE.Group();
  group.name = 'plants';
  const F = FAMILY.flora;
  if (!F) return group;
  const mk = F.makeInstanced;
  const R = rng(8080);
  const add = (name, spots, variants, opts = {}) => {
    if (!MODELS[name] || !spots.length) return;
    group.add(instance(name, spots, variants, (v) => MODELS[name]({ seed: 17 + v * 31, ...opts }), mk));
  };
  const t0 = performance.now();
  // --- distant forest crowns ---
  if (F.forestInstances) {
    const pts = forestSpots({});
    group.add(F.forestInstances(pts));
    console.warn(`forest: ${pts.length} crowns`);
  }
  // --- the terraces: rice near both walks, hydrangeas on the levee path ---
  const pathOf = (w) => w.keys.filter((k) => k.t > 5).map((k) => [k.p[0], k.p[2]]);
  const morning = pathOf(walks.morning), night = walks.night.keys.map((k) => [k.p[0], k.p[2]]);
  // keep the water in front of the opening shot a clean mirror (camera rises from
  // 18 cm above the water at (344.8, -260.1) toward the levee at (348.4, -262.3))
  const clearOpening = (p) => Math.hypot(p.x - 344.8, p.z + 260.1) > 7 && Math.hypot(p.x - 346.6, p.z + 261.2) > 3;
  add('rice', riceSpots(morning.concat(night), 9, 5).filter((p, i) => i % 2 === 0 && clearOpening(p)).map((p) => ({ ...p, s: p.s * 1.1 })), 6);
  const leveeY = (p) => (x, z) => p;
  add('hydrangea', alongPath(morning, { side: 1, spacing: 3.6, offset: 1.35, jitter: 0.3, heightAt: leveeY(36.95), seed: 21, skip: 0.3 }), 5);
  add('hydrangea', alongPath(night, { side: 1, spacing: 3.8, offset: 1.35, jitter: 0.3, heightAt: leveeY(35.75), seed: 22, skip: 0.3 }), 5);
  add('grass', alongPath(morning, { side: -1, spacing: 0.7, offset: 0.45, jitter: 0.2, heightAt: leveeY(37.4), seed: 23 }), 4);
  add('grass', alongPath(morning, { side: 1, spacing: 0.9, offset: 0.4, jitter: 0.2, heightAt: leveeY(37.4), seed: 24 }), 4);
  // groves on the bald hill west of the terraces and around the fields
  const grove = (cx, cz, r, n, seed) => scatter({ x0: cx - r, x1: cx + r, z0: cz - r, z1: cz + r, spacing: 7, seed,
    density: (x, z) => (Math.hypot(x - cx, z - cz) < r && paddyMask(x, z) < 0.05 ? 0.85 : 0), scale: [0.8, 1.25] });
  const hill = grove(236, -265, 64, 0, 31).concat(grove(300, -300, 36, 0, 34), grove(420, -300, 40, 0, 32), grove(460, -200, 35, 0, 33));
  add('tree', hill.filter((_, i) => i % 5 !== 0), 6);
  add('bamboo', hill.filter((_, i) => i % 5 === 0), 3);
  // --- the slope street: pots at the doors, weeds at the foot of the walls ---
  const SP = STREET_PROFILE;
  const streetPath = [];
  for (let s = 120; s < SP.total; s += 4) streetPath.push(SP.at(s));
  for (const side of [-1, 1]) {
    add('weeds', alongPath(streetPath, { side, spacing: 1.1, offset: streetHalf + 0.95, jitter: 0.3, seed: 40 + side, skip: 0.35 }), 6);
  }
  const pots = [];
  for (const l of lots) {
    if (!l.street || l.s < 120) continue;
    const fx = Math.sin(l.rotY), fz = Math.cos(l.rotY), rx = Math.cos(l.rotY), rz = -Math.sin(l.rotY);
    const n = l.kind === 'garden' ? 0 : R.int(1, 5);
    for (let k = 0; k < n; k++) {
      const u = R.range(-0.45, 0.45) * l.w, f = l.d / 2 + 0.05 + R.range(0, 0.3);
      pots.push({ x: l.x + rx * u + fx * f, y: l.padH, z: l.z + rz * u + fz * f, rotY: R() * 6.28, s: R.range(0.8, 1.25), v: R.int(0, 7) });
    }
  }
  add('potted', pots, 7);
  // gardens: shrubs, a small tree, vegetable-like rows of weeds
  const gardens = lots.filter((l) => l.kind === 'garden' || l.kind === 'field');
  const gb = [], gt = [];
  for (const l of gardens) {
    const fx = Math.sin(l.rotY), fz = Math.cos(l.rotY), rx = Math.cos(l.rotY), rz = -Math.sin(l.rotY);
    for (let k = 0; k < 5; k++) {
      const u = R.range(-0.4, 0.4) * l.w, f = R.range(-0.4, 0.4) * l.d;
      gb.push({ x: l.x + rx * u + fx * f, y: l.padH, z: l.z + rz * u + fz * f, rotY: R() * 6.28, s: R.range(0.7, 1.3), v: R.int(0, 7) });
    }
    if (R() < 0.7) gt.push({ x: l.x - fx * l.d * 0.2, y: l.padH, z: l.z - fz * l.d * 0.2, rotY: R() * 6.28, s: R.range(0.45, 0.7), v: R.int(0, 7) });
  }
  add('bush', gb, 5);
  add('tree', gt, 4, { h: 6 });
  // --- the station: weeds along the track and the platform, shrubs on the cut ---
  const trackPath = [];
  for (let z = -800; z > -1040; z -= 5) trackPath.push([railXAt(z), z]);
  const bedY = (x, z) => RAIL_H - 0.72;
  add('weeds', alongPath(trackPath, { side: -1, spacing: 1.0, offset: 2.8, jitter: 1.2, heightAt: bedY, seed: 51 }), 6);
  add('grass', alongPath(trackPath, { side: -1, spacing: 0.6, offset: 3.6, jitter: 1.4, heightAt: bedY, seed: 52 }), 4);
  add('weeds', alongPath(trackPath, { side: 1, spacing: 1.4, offset: 5.2, jitter: 1.0, heightAt: bedY, seed: 53, skip: 0.2 }), 6);
  const cut = scatter({ x0: -120, x1: 40, z0: -1040, z1: -800, spacing: 3.2, seed: 54,
    density: (x, z) => { const o = x - railXAt(z); const g = ground(x, z); return o > 13 && o < 45 && g > RAIL_H + 1.5 ? 0.8 : 0; }, scale: [0.9, 1.6] });
  add('bush', cut.filter((_, i) => i % 3 !== 0), 5);
  add('tree', cut.filter((_, i) => i % 3 === 0 && i % 2 === 0), 5);
  // pines on the rocky points and the islet
  const pines = scatter({ x0: -480, x1: -150, z0: -340, z1: 330, spacing: 11, seed: 61,
    density: (x, z) => { const sd = sdLand(x, z); return sd < -4 && sd > -40 && forestMask(x, z, ground(x, z)) < 0.6 ? 0.55 : 0; }, scale: [0.8, 1.3] });
  add('pine', pines, 4);
  console.warn(`plants: ${group.children.length} kinds, ${(performance.now() - t0).toFixed(0)} ms`);
  return group;
}
