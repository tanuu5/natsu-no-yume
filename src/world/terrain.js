// Terrain: a nested-ring (clipmap-style) mesh built around each shot, so resolution is
// spent where the camera walks. The surface is the ground plus a lumpy forest canopy;
// colour and detail come from the fragment shader.
import * as THREE from 'three';
import { ground, forestMask, paddyMask, villageMask, sdLand } from './geo.js';
import { hash2, perlin, fbm } from './noise.js';
import { prep } from './materials.js';

// Height of the tree canopy above the ground: dome-shaped crowns on a jittered grid.
export function canopy(x, z, f) {
  if (f <= 0.01) return 0;
  const cs = 7.5;
  const gx = Math.floor(x / cs), gz = Math.floor(z / cs);
  let top = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = gx + i, cz = gz + j;
      const px = (cx + 0.15 + 0.7 * hash2(cx, cz, 1)) * cs;
      const pz = (cz + 0.15 + 0.7 * hash2(cx, cz, 2)) * cs;
      const r = cs * (0.55 + 0.45 * hash2(cx, cz, 3));
      const d2 = ((x - px) ** 2 + (z - pz) ** 2) / (r * r);
      if (d2 < 1) {
        const ht = r * 0.55 * Math.sqrt(1 - d2) + 2.5 * hash2(cx, cz, 4);
        if (ht > top) top = ht;
      }
    }
  }
  const base = 7 + 4 * fbm(x / 90, z / 90, 2);
  return f * (base + top);
}

export function surface(x, z) {
  const g = ground(x, z);
  if (g < 0.5) return g;
  const f = forestMask(x, z, g);
  return g + canopy(x, z, f);
}

// Build the ring mesh around (cx, cz): `levels` rings of n x n cells, spacing s0 * 2^k.
export function buildTerrain({ cx, cz, s0 = 0.5, n = 256, levels = 8, material }) {
  const group = new THREE.Group();
  group.name = 'terrain';
  const half = n / 2, q = n / 4;
  for (let k = 0; k < levels; k++) {
    const s = s0 * 2 ** k;
    const N1 = n + 1;
    const pos = new Float32Array(N1 * N1 * 3);
    const info = new Float32Array(N1 * N1 * 4);
    const hts = new Float32Array(N1 * N1);
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = cx + (i - half) * s, z = cz + (j - half) * s;
        const idx = j * N1 + i;
        hts[idx] = surface(x, z);
        pos[idx * 3] = x; pos[idx * 3 + 2] = z;
      }
    }
    // stitch the outer border of finer levels to the next coarser level
    if (k < levels - 1) {
      for (let i = 1; i < n; i += 2) {
        for (const [a, b, c] of [[i, 0, 1], [i, n, 1]]) {
          const idx = b * N1 + a;
          hts[idx] = 0.5 * (hts[b * N1 + a - 1] + hts[b * N1 + a + 1]);
        }
        for (const col of [0, n]) {
          const idx = i * N1 + col;
          hts[idx] = 0.5 * (hts[(i - 1) * N1 + col] + hts[(i + 1) * N1 + col]);
        }
      }
    }
    const nor = new Float32Array(N1 * N1 * 3);
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const idx = j * N1 + i;
        const hl = hts[j * N1 + Math.max(0, i - 1)], hr = hts[j * N1 + Math.min(n, i + 1)];
        const hd = hts[Math.max(0, j - 1) * N1 + i], hu = hts[Math.min(n, j + 1) * N1 + i];
        const dx = (hr - hl) / (s * (Math.min(n, i + 1) - Math.max(0, i - 1)));
        const dz = (hu - hd) / (s * (Math.min(n, j + 1) - Math.max(0, j - 1)));
        const l = Math.hypot(dx, 1, dz);
        nor[idx * 3] = -dx / l; nor[idx * 3 + 1] = 1 / l; nor[idx * 3 + 2] = -dz / l;
        pos[idx * 3 + 1] = hts[idx];
        const x = pos[idx * 3], z = pos[idx * 3 + 2];
        const g = ground(x, z);
        info[idx * 4] = g > 0.5 ? forestMask(x, z, g) : 0;
        info[idx * 4 + 1] = paddyMask(x, z);
        info[idx * 4 + 2] = villageMask(x, z);
        info[idx * 4 + 3] = g;
      }
    }
    const index = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        if (k > 0 && i >= q && i < n - q && j >= q && j < n - q) continue;
        const a = j * N1 + i, b = a + 1, c = a + N1, d = c + 1;
        // alternate the diagonal for a less directional mesh
        if ((i + j) & 1) index.push(a, c, b, b, c, d);
        else index.push(a, c, d, a, d, b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
    geo.setIndex(index);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    mesh.castShadow = k <= 3;
    mesh.name = `terrain-L${k}`;
    group.add(mesh);
  }
  return group;
}

// The terrain material: MeshStandardMaterial with procedural albedo/roughness/normal.
export function terrainMaterial() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  return prep(mat, (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aInfo;
varying vec4 vInfo;
varying vec3 vWPos;
varying vec3 vWNor;`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>
vInfo = aInfo;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNor = normalize(mat3(modelMatrix) * objectNormal);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vInfo;
varying vec3 vWPos;
varying vec3 vWNor;
float th21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float tn2(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(th21(i), th21(i+vec2(1,0)), u.x), mix(th21(i+vec2(0,1)), th21(i+vec2(1,1)), u.x), u.y); }
float tfbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * tn2(p); p = p * 2.07 + 13.1; a *= 0.5; } return s; }
`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec3 wp = vWPos;
  float forest = vInfo.x;
  float village = vInfo.z;
  float gh = vInfo.w;
  float slope = 1.0 - clamp(vWNor.y, 0.0, 1.0);
  float camD = length(cameraPosition - wp);
  float n1 = tfbm(wp.xz * 0.05);
  float n2 = tfbm(wp.xz * 0.6);
  float n3 = tn2(wp.xz * 3.1);
  float n4 = tn2(wp.xz * 11.0) * smoothstep(40.0, 5.0, camD);
  // grass / scrub: fresh and dry patches, clover-dark spots, fine blade speckle up close
  vec3 grass = mix(vec3(0.075, 0.105, 0.025), vec3(0.15, 0.17, 0.05), n1);
  grass = mix(grass, vec3(0.16, 0.14, 0.07), smoothstep(0.55, 0.8, n2) * 0.55);
  grass *= 0.8 + 0.4 * n3 + 0.25 * (n4 - 0.5);
  // forest canopy: darker in the gaps between crowns, lit tops
  float crown = clamp((wp.y - gh - 7.0) / 7.0, 0.0, 1.0);
  vec3 leaf = mix(vec3(0.018, 0.035, 0.012), vec3(0.06, 0.1, 0.03), crown);
  leaf = mix(leaf, leaf * vec3(1.25, 1.1, 0.7), smoothstep(0.4, 0.9, n1) * 0.6);
  leaf *= 0.75 + 0.5 * n3;
  // rock and cut faces: strata, lichen
  float strata = 0.5 + 0.5 * sin(wp.y * 3.1 + n2 * 4.0);
  vec3 rock = mix(vec3(0.13, 0.12, 0.10), vec3(0.26, 0.24, 0.20), n2 * 0.7 + strata * 0.3);
  rock = mix(rock, vec3(0.2, 0.21, 0.14), smoothstep(0.6, 0.9, n3) * 0.4);
  // beach / wet shore
  vec3 sand = mix(vec3(0.3, 0.27, 0.21), vec3(0.2, 0.19, 0.16), n2);
  vec3 c = grass;
  c = mix(c, rock, smoothstep(0.42, 0.66, slope + (n2 - 0.5) * 0.25) * (1.0 - forest));
  c = mix(c, leaf, smoothstep(0.1, 0.5, forest));
  c = mix(c, sand, smoothstep(2.2, 0.6, wp.y) * (1.0 - forest));
  c = mix(c, vec3(0.07, 0.075, 0.07), smoothstep(0.3, -0.5, wp.y));  // under water
  c = mix(c, mix(vec3(0.14, 0.13, 0.11), grass, 0.5), village * 0.4);
  diffuseColor.rgb = c;
}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  // fine bumps near the camera (grass tussocks, soil)
  float camD = length(cameraPosition - vWPos);
  float k = smoothstep(35.0, 3.0, camD);
  if (k > 0.0) {
    vec2 q = vWPos.xz * 2.3;
    float e = 0.07;
    float h0 = tn2(q) + 0.5 * tn2(q * 2.9);
    float hx = tn2(q + vec2(e, 0.0)) + 0.5 * tn2((q + vec2(e, 0.0)) * 2.9);
    float hz = tn2(q + vec2(0.0, e)) + 0.5 * tn2((q + vec2(0.0, e)) * 2.9);
    vec3 dN = vec3(-(hx - h0), 0.0, -(hz - h0)) / e * 0.09 * k;
    normal = normalize(normal + (viewMatrix * vec4(dN, 0.0)).xyz);
  }
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(0.95, 0.8, vInfo.x);`);
  }, 'terrain');
}
