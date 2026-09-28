// Harbour works: the quay wall and apron along the cove shore, the breakwaters from
// the headlands, and the inner pier. Boats, tetrapods and lights are placed by
// world.js from the model families.
import * as THREE from 'three';
import { Builder } from './builder.js';
import { materials } from './lib.js';
import { COVE, QUAY, QUAY_H, BREAKWATERS } from './geo.js';
import { rng } from './noise.js';

const WET = [0.55, 0.56, 0.52];      // tidal band tint
const DRY = [1.0, 0.98, 0.94];

export function buildHarbor() {
  const M = materials();
  const B = new Builder();
  const R = rng(4242);
  // --- quay wall: faces the water along the cove's arc ---
  const n = Math.ceil(((QUAY.a1 - QUAY.a0) * COVE.r) / 3);
  for (let i = 0; i < n; i++) {
    const a0 = QUAY.a0 + ((QUAY.a1 - QUAY.a0) * i) / n, a1 = QUAY.a0 + ((QUAY.a1 - QUAY.a0) * (i + 1)) / n;
    const am = (a0 + a1) / 2;
    const len = (a1 - a0) * COVE.r + 0.05;
    const cx = COVE.x + Math.cos(am) * COVE.r, cz = COVE.z + Math.sin(am) * COVE.r;
    const rotY = -am + Math.PI / 2;  // box length along the tangent
    const out = [Math.cos(am), Math.sin(am)];
    const tone = 0.9 + 0.12 * R();
    // wall body (tidal band below, dry concrete above)
    B.box(M.concrete, { w: len, h: 4.2, d: 1.2, pos: [cx + out[0] * 0.6, -3.5, cz + out[1] * 0.6], rotY, color: WET.map((c) => c * tone) });
    B.box(M.concrete, { w: len, h: 1.65, d: 1.2, pos: [cx + out[0] * 0.6, QUAY_H - 0.83, cz + out[1] * 0.6], rotY, color: DRY.map((c) => c * tone) });
    // coping
    B.box(M.concrete, { w: len, h: 0.22, d: 0.5, pos: [cx + out[0] * 0.25, QUAY_H + 0.11, cz + out[1] * 0.25], rotY, color: [0.92 * tone, 0.9 * tone, 0.86 * tone] });
    // apron
    B.box(M.concrete, { w: len, h: 0.3, d: 10.5, pos: [cx + out[0] * 5.7, QUAY_H - 0.13, cz + out[1] * 5.7], rotY, color: [0.82 * tone, 0.8 * tone, 0.76 * tone] });
  }
  // --- breakwaters and pier ---
  for (const bw of BREAKWATERS) {
    const pts = bw.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const rotY = -Math.atan2(bz - az, bx - ax);
      const cx = (ax + bx) / 2, cz = (az + bz) / 2;
      // normal pointing out to sea (west-ish)
      let nx = -(bz - az) / len, nz = (bx - ax) / len;
      if (nx > 0) { nx = -nx; nz = -nz; }
      const tone = 0.92 + 0.1 * R();
      const L = len + bw.w * (i < pts.length - 2 ? 1 : 0.5);
      B.box(M.concrete, { w: L, h: 5.5, d: bw.w, pos: [cx, -5.5 / 2 + 0.5, cz], rotY, color: WET.map((c) => c * tone) });
      B.box(M.concrete, { w: L, h: bw.h - 0.5, d: bw.w, pos: [cx, 0.5 + (bw.h - 0.5) / 2, cz], rotY, color: DRY.map((c) => c * tone) });
      if (bw.id !== 'pier') {
        // parapet on the sea side
        B.box(M.concrete, { w: L, h: 1.3, d: 0.8, pos: [cx + nx * (bw.w / 2 - 0.4), bw.h + 0.65, cz + nz * (bw.w / 2 - 0.4)], rotY, color: [0.95 * tone, 0.93 * tone, 0.88 * tone] });
      }
    }
  }
  const g = B.build({ name: 'harbor' });
  return g;
}

// Points along the sea side of the breakwaters, for tetrapods: [{x, y, z, rot}]
export function tetrapodSpots(seed = 9) {
  const R = rng(seed);
  const out = [];
  for (const bw of BREAKWATERS) {
    if (bw.id === 'pier') continue;
    const pts = bw.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      let nx = -(bz - az) / len, nz = (bx - ax) / len;
      if (nx > 0) { nx = -nx; nz = -nz; }
      for (let s = 0; s < len; s += 2.2) {
        for (let row = 0; row < 3; row++) {
          const u = (s + R() * 1.2) / len;
          const off = bw.w / 2 + 1.3 + row * 2.1 + R() * 0.6;
          out.push({
            x: ax + (bx - ax) * u + nx * off, z: az + (bz - az) * u + nz * off,
            y: 1.2 - row * 1.1 + R() * 0.5, rot: [R() * 6.28, R() * 6.28, R() * 6.28],
          });
        }
      }
    }
  }
  return out;
}

// Mooring spots along the quay and pier: [{x, z, rotY}] (boat bow direction)
export function mooringSpots() {
  const out = [];
  // along the pier, both sides, bows pointing north
  const pier = BREAKWATERS.find((b) => b.id === 'pier');
  const [ax, az] = pier.pts[0], [bx, bz] = pier.pts[1];
  for (let z = az + 8; z < bz - 6; z += 9.5) {
    out.push({ x: ax - pier.w / 2 - 2.4, z, rotY: Math.PI, side: -1 });
    out.push({ x: ax + pier.w / 2 + 2.4, z: z + 4, rotY: Math.PI, side: 1 });
  }
  // along the quay arc, bows pointing along the wall
  for (let a = -0.9; a < 1.0; a += 0.085) {
    if (a > -0.1 && a < 0.12) continue;          // the slipway at the street's foot
    const r = COVE.r - 2.6;
    out.push({ x: COVE.x + Math.cos(a) * r, z: COVE.z + Math.sin(a) * r, rotY: -a, side: 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Boats, tetrapods, lights and quay clutter from the boats family.
// Returns { group, update(t) } — boats bob and roll gently.
// ---------------------------------------------------------------------------
const _v = new THREE.Vector3();
function instancedFrom(obj, count) {
  const group = new THREE.Group();
  obj.updateMatrixWorld(true);
  obj.traverse((m) => {
    if (!m.isMesh) return;
    const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
    const im = new THREE.InstancedMesh(g, m.material, count);
    im.castShadow = m.castShadow; im.receiveShadow = true;
    group.add(im);
  });
  return group;
}
function setInstances(group, spots) {
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3();
  group.traverse((im) => {
    if (!im.isInstancedMesh) return;
    spots.forEach((p, i) => {
      e.set(...(p.rot || [0, p.rotY || 0, 0]), 'YXZ');
      q.setFromEuler(e);
      s.setScalar(p.s ?? 1);
      m.compose(_v.set(p.x, p.y, p.z), q, s);
      im.setMatrixAt(i, m);
    });
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
  });
}

export function populateHarbor(MODELS) {
  const group = new THREE.Group();
  group.name = 'harbor-life';
  const R = rng(9090);
  const boats = [];
  if (MODELS.boat) {
    const spots = mooringSpots();
    spots.forEach((sp, i) => {
      if (R() < 0.18) return;                        // empty berths
      const len = R.range(7, 12.5);
      // boats far from the sunset walk on the east quay get the light version
      const far = Math.hypot(sp.x - 125, sp.z + 48) > 70;
      const b = MODELS.boat({ seed: 11 + i * 3, len, lod: far ? 1 : 0 });
      const beam = b.userData.beam || 2.6;
      // outward offset for boats alongside the quay (side 0) so the hull clears the wall
      let x = sp.x, z = sp.z;
      if (sp.side === 0) { const a = Math.atan2(z - COVE.z, x - COVE.x); x = COVE.x + Math.cos(a) * (COVE.r - beam / 2 - 0.5); z = COVE.z + Math.sin(a) * (COVE.r - beam / 2 - 0.5); }
      b.position.set(x, 0, z);
      b.rotation.y = sp.rotY + (R() < 0.5 ? Math.PI : 0) * (sp.side === 0 ? 1 : 0);
      b.userData.phase = R() * 6.28;
      b.userData.base = b.rotation.y;
      group.add(b);
      boats.push(b);
      // sometimes a second boat rafted alongside
      if (sp.side !== 0 && R() < 0.35) {
        const b2 = MODELS.boat({ seed: 500 + i * 7, len: R.range(6.5, 10), lod: 1 });
        b2.position.set(x + sp.side * (beam + 0.5), 0, z + R.range(-2, 2));
        b2.rotation.y = sp.rotY;
        b2.userData.phase = R() * 6.28;
        b2.userData.base = b2.rotation.y;
        group.add(b2);
        boats.push(b2);
      }
    });
  }
  if (MODELS.tetrapod) {
    const spots = tetrapodSpots();
    const inst = instancedFrom(MODELS.tetrapod({ seed: 1, center: 1 }), spots.length);
    setInstances(inst, spots);
    group.add(inst);
  }
  if (MODELS.lighthouse) {
    for (const bw of BREAKWATERS) {
      if (!bw.light) continue;
      const tip = bw.pts[bw.pts.length - 1];
      const lh = MODELS.lighthouse({ color: bw.light === 'red' ? 'red' : 'white', h: 8 });
      lh.position.set(tip[0], bw.h, tip[1]);
      group.add(lh);
    }
  }
  // quay edge: bollards, tyre fenders, nets, crates, floats
  const clutter = [];
  const add = (name, x, y, z, rotY, o = {}) => {
    if (!MODELS[name]) return;
    const m = MODELS[name]({ seed: R.int(1, 999), ...o });
    m.position.set(x, y, z); m.rotation.y = rotY;
    clutter.push(m);
  };
  for (let a = QUAY.a0 + 0.04; a < QUAY.a1; a += 0.085 + R() * 0.02) {
    const r = COVE.r + 0.7;
    add('bollard', COVE.x + Math.cos(a) * r, QUAY_H, COVE.z + Math.sin(a) * r, -a);
    if (R() < 0.5) {
      const rr = COVE.r + R.range(3.5, 8), aa = a + R.range(-0.02, 0.02);
      add(R.pick(['netPile', 'crates', 'crates', 'buoy', 'netPile']), COVE.x + Math.cos(aa) * rr, QUAY_H, COVE.z + Math.sin(aa) * rr, R() * 6.28);
    }
  }
  const pier = BREAKWATERS.find((b) => b.id === 'pier');
  for (let z = pier.pts[0][1] + 4; z < pier.pts[1][1] - 2; z += 11) {
    for (const k of [-1, 1]) add('bollard', pier.pts[0][0] + k * (pier.w / 2 - 0.5), pier.h, z + R.range(-1, 1), 0);
    if (R() < 0.6) add(R.pick(['netPile', 'crates', 'buoy']), pier.pts[0][0] + R.range(-2, 2), pier.h, z + 5, R() * 6.28);
  }
  if (clutter.length) group.add(mergeClutter(clutter));
  const update = (t) => {
    for (const b of boats) {
      const p = b.userData.phase;
      const bob = b.userData.bob || {};
      const amp = (bob.heave ?? bob.amp ?? 0.035) * 0.8, roll = (bob.roll ?? 0.02) * 0.6;
      const w = (2 * Math.PI) / (bob.period ?? 3.8);
      b.position.y = amp * Math.sin(t * w + p) + amp * 0.35 * Math.sin(t * w * 2.3 + p * 1.7);
      b.rotation.set(roll * 0.3 * Math.sin(t * w * 0.8 + p * 2.0), b.userData.base + 0.004 * Math.sin(t * 0.3 + p), roll * Math.sin(t * w * 0.93 + p * 0.6), 'YXZ');
    }
  };
  return { group, update, boats };
}

function mergeClutter(objs) {
  const g = new THREE.Group();
  for (const o of objs) g.add(o);
  return g;
}
