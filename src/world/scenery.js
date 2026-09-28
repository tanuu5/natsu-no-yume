// Distant scenery: forested islands in the bay and a far mountain range across the
// sea. Built as radial / strip height fields with the terrain material, so the
// aerial perspective fades them into the haze.
import * as THREE from 'three';
import { ISLANDS } from './geo.js';
import { fbm, ridged, perlin, rng } from './noise.js';
import { canopy } from './terrain.js';

function islandMesh({ x, z, r, h, seed }, material) {
  const R = 64, A = 128;                    // rings x angular segments
  const pos = [], info = [], idx = [];
  const rnd = rng(seed * 101 + 7);
  const lobes = [rnd.range(0, 6.28), rnd.range(0, 6.28), rnd.range(0, 6.28)];
  // elongated, with a few humps along the long axis (Seto Inland Sea islands)
  const axis = rnd.range(-0.6, 0.6) + Math.PI / 2, elong = rnd.range(1.6, 2.6);
  const shore = (a) => {
    const c = Math.cos(a - axis), s2 = Math.sin(a - axis);
    const ell = 1 / Math.sqrt((c / elong) ** 2 + s2 * s2) / Math.sqrt(elong);
    return r * ell * (1 + 0.18 * Math.sin(2 * a + lobes[0]) + 0.1 * Math.sin(3 * a + lobes[1]) + 0.08 * perlin(Math.cos(a) * 2 + seed, Math.sin(a) * 2));
  };
  const peaks = [];
  const np = rnd.int(2, 3);
  for (let k = 0; k < np; k++) {
    const u = (k / (np - 1 || 1) - 0.5) * 1.1 + rnd.range(-0.15, 0.15);
    peaks.push({ px: Math.cos(axis) * u * r * Math.sqrt(elong), pz: Math.sin(axis) * u * r * Math.sqrt(elong), hh: h * rnd.range(0.6, 1.0), rr: r * rnd.range(0.55, 0.8) });
  }
  const peakX = 0, peakZ = 0;
  const H = (px, pz, u) => {
    // u: 0 centre .. 1 shore .. 1.15 below water
    let base = 0;
    for (const p of peaks) base = Math.max(base, p.hh * Math.exp(-(((px - p.px) ** 2 + (pz - p.pz) ** 2) / (p.rr * p.rr)) * 1.1));
    base = Math.max(base * Math.min(1, (1 - u) * 4), h * 0.15 * Math.max(0, 1 - u * u));
    const n = fbm((x + px) / (r * 0.6), (z + pz) / (r * 0.6), 4) * h * 0.18;
    const rid = ridged((x + px) / (r * 0.9) + seed, (z + pz) / (r * 0.9), 3) * h * 0.22;
    let y = base + (n + rid * 0.6) * Math.min(1, (1 - u) * 3);
    if (u > 1) y = -(u - 1) * r * 0.6;
    return y;
  };
  for (let i = 0; i <= R; i++) {
    const u = (i / R) * 1.15;
    for (let j = 0; j < A; j++) {
      const a = (j / A) * Math.PI * 2;
      const rr = shore(a) * u;
      const px = Math.cos(a) * rr + peakX * (1 - Math.min(1, u)), pz = Math.sin(a) * rr + peakZ * (1 - Math.min(1, u));
      let y = H(px, pz, u);
      const f = u < 0.92 ? 1 : 0;
      if (y > 1.5) y += canopy(x + px, z + pz, f) * 0.9;
      pos.push(x + px, y, z + pz);
      info.push(f, 0, 0, y - (f ? 8 : 0));
    }
  }
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < A; j++) {
      const a = i * A + j, b = i * A + ((j + 1) % A), c = (i + 1) * A + j, d = (i + 1) * A + ((j + 1) % A);
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  m.receiveShadow = true;
  m.name = 'island';
  return m;
}

// A long mountain range across the sea to the west (a strip height field).
function rangeMesh(material) {
  const NZ = 420, NX = 40;
  const pos = [], info = [], idx = [];
  for (let i = 0; i <= NX; i++) {
    for (let j = 0; j <= NZ; j++) {
      const u = i / NX;                       // 0 = shore facing us, 1 = far side
      const z = -46000 + (j / NZ) * 92000;
      const x = -15500 - u * 14000 - 3500 * perlin(z / 26000, 1.7);
      const crest = 0.35 + 0.65 * Math.exp(-(((u - 0.45) / 0.3) ** 2));
      const hMax = 380 + 520 * (0.5 + 0.5 * perlin(z / 17000, 4.2));
      let y = hMax * crest * (0.55 + 0.6 * ridged(x / 6000, z / 6000, 5)) * Math.min(1, u * 6);
      y = Math.max(-60, y - 30 * (1 - Math.min(1, u * 5)) * 3);
      pos.push(x, y, z);
      info.push(y > 20 ? 1 : 0, 0, 0, y - 10);
    }
  }
  for (let i = 0; i < NX; i++) {
    for (let j = 0; j < NZ; j++) {
      const a = i * (NZ + 1) + j, b = a + 1, c = a + NZ + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  m.name = 'range';
  return m;
}

export function buildScenery(material) {
  const group = new THREE.Group();
  group.name = 'scenery';
  for (const isl of ISLANDS) group.add(islandMesh(isl, material));
  group.add(rangeMesh(material));
  return group;
}
