// Rice terraces: per-level water sheets whose edges follow the contours at pixel
// precision (the shader discards where the height map says another level), grassy
// levees laid along each terrace's downhill edge, and riser faces (stone or grass
// banks) down to the terrace below.
import * as THREE from 'three';
import { PADDY_BOX, PADDY_STEP, groundNatural, paddyMask } from './geo.js';
import { AERIAL } from './glsl.js';
import { U } from './env.js';
import { rng, perlin } from './noise.js';
import { materials } from './lib.js';

const RES = 0.25;

// Height map over the terrace box: r = natural height, g = level variable (height
// nudged uphill as in paddyTerrain), b = paddy mask.
function heightMap() {
  const { x0, x1, z0, z1 } = PADDY_BOX;
  const nx = Math.round((x1 - x0) / RES), nz = Math.round((z1 - z0) / RES);
  const data = new Float32Array(nx * nz * 4);
  const hq = new Float32Array(nx * nz);
  const e = 0.6;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * RES, z = z0 + (j + 0.5) * RES;
      const g = groundNatural(x, z);
      const m = paddyMask(x, z);
      let q = g;
      if (m > 0) {
        const gx = (groundNatural(x + e, z) - groundNatural(x - e, z)) / (2 * e), gz = (groundNatural(x, z + e) - groundNatural(x, z - e)) / (2 * e);
        q = g - 0.3 * Math.hypot(gx, gz);
      }
      const o = (j * nx + i) * 4;
      data[o] = g; data[o + 1] = q; data[o + 2] = m; data[o + 3] = 1;
      hq[j * nx + i] = q;
    }
  }
  const tex = new THREE.DataTexture(data, nx, nz, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const mask = new Float32Array(nx * nz);
  for (let k = 0; k < nx * nz; k++) mask[k] = data[k * 4 + 2];
  return { tex, nx, nz, hq, mask, rect: new THREE.Vector4(x0, z0, 1 / (nx * RES), 1 / (nz * RES)) };
}

// Marching squares: polylines where field == v (only inside the mask).
function contours(field, mask, nx, nz, v, ox, oz) {
  const segs = [];
  const P = (i, j) => field[j * nx + i];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (mask[j * nx + i] < 0.55) continue;
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
      const k = (a >= v ? 1 : 0) | (b >= v ? 2 : 0) | (c >= v ? 4 : 0) | (d >= v ? 8 : 0);
      if (k === 0 || k === 15) continue;
      const e = [];
      const lerp = (p, q, i0, j0, i1, j1) => { const t = (v - p) / (q - p); return [ox + (i0 + (i1 - i0) * t + 0.5) * RES, oz + (j0 + (j1 - j0) * t + 0.5) * RES]; };
      if ((a >= v) !== (b >= v)) e.push(lerp(a, b, i, j, i + 1, j));
      if ((b >= v) !== (c >= v)) e.push(lerp(b, c, i + 1, j, i + 1, j + 1));
      if ((c >= v) !== (d >= v)) e.push(lerp(c, d, i + 1, j + 1, i, j + 1));
      if ((d >= v) !== (a >= v)) e.push(lerp(d, a, i, j + 1, i, j));
      if (e.length === 2) segs.push([e[0], e[1]]);
      else if (e.length === 4) { segs.push([e[0], e[1]]); segs.push([e[2], e[3]]); }
    }
  }
  // join segments into polylines
  const key = (p) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
  const ends = new Map();
  segs.forEach((s, idx) => {
    for (const p of s) { const kk = key(p); if (!ends.has(kk)) ends.set(kk, []); ends.get(kk).push(idx); }
  });
  const used = new Uint8Array(segs.length);
  const lines = [];
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const line = [segs[s0][0], segs[s0][1]];
    for (const dir of [1, -1]) {
      for (;;) {
        const tip = dir > 0 ? line[line.length - 1] : line[0];
        const cand = (ends.get(key(tip)) || []).find((q) => !used[q]);
        if (cand === undefined) break;
        used[cand] = 1;
        const [p, q] = segs[cand];
        const next = key(p) === key(tip) ? q : p;
        if (dir > 0) line.push(next); else line.unshift(next);
      }
    }
    if (line.length > 3) lines.push(line);
  }
  return lines;
}

// Chaikin smoothing + resampling to ~step metres.
function smoothLine(line, iters = 2) {
  let p = line;
  for (let k = 0; k < iters; k++) {
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1];
      q.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25], [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

const WATER_VERT = /* glsl */`
varying vec3 vW;
#include <clipping_planes_pars_vertex>
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vec4 mvPosition = viewMatrix * w;
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}`;

const WATER_FRAG = /* glsl */`
precision highp float;
#define PI 3.14159265359
varying vec3 vW;
uniform sampler2D uHM;
uniform vec4 uHMRect;
uniform float uLevel;
uniform float uStep;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform sampler2D uRefl;
uniform mat4 uReflMat;
uniform float uReflOn;
uniform sampler2D uEnvSky;
uniform float uNight;
uniform vec4 uDrops[2];   // x, z, t0 (walk time), strength: a drop's rings
#include <clipping_planes_pars_fragment>
${AERIAL}
vec2 equiUv(vec3 d) { return vec2(atan(d.z, d.x) / (2.0 * PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5); }
float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), u.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), u.x), u.y); }
void main() {
  #include <clipping_planes_fragment>
  vec2 uv = (vW.xz - uHMRect.xy) * uHMRect.zw;
  vec4 hm = texture(uHM, uv);
  if (hm.b < 0.55 || floor(hm.g / uStep) != uLevel) discard;
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  // near-still water: faint wind ripples
  float e = 0.05;
  vec2 p = vW.xz * 1.7 + vec2(uTime * 0.12, uTime * 0.05);
  float n0 = vn(p) + 0.5 * vn(p * 2.7 - uTime * 0.2);
  float nx = vn(p + vec2(e, 0.0)) + 0.5 * vn((p + vec2(e, 0.0)) * 2.7 - uTime * 0.2);
  float nz = vn(p + vec2(0.0, e)) + 0.5 * vn((p + vec2(0.0, e)) * 2.7 - uTime * 0.2);
  float wind = mix(1.0, 0.25, uNight);
  vec3 N = normalize(vec3(-(nx - n0) / e * 0.012 * wind, 1.0, -(nz - n0) / e * 0.012 * wind));
  for (int k = 0; k < 2; k++) {
    vec4 dr = uDrops[k];
    float dt = uTime - dr.z;
    if (dr.w <= 0.0 || dt <= 0.0 || dt > 7.0) continue;
    vec2 d = vW.xz - dr.xy;
    float r = length(d) + 1e-4;
    float Rr = 0.55 * dt;
    float env = exp(-pow((r - Rr) / (0.16 + 0.07 * dt), 2.0)) * exp(-dt * 0.45) / (1.0 + r * 0.8);
    float slope = -sin((r - Rr) / 0.11 * 6.2831) * env * 0.35 * dr.w;
    N = normalize(vec3(N.x + d.x / r * slope, N.y, N.z + d.y / r * slope));
  }
  float NdV = max(dot(N, V), 0.02);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) + 0.002;
  vec3 refl = texture(uEnvSky, equiUv(normalize(R))).rgb;
  if (uReflOn > 0.5) {
    vec4 rc = uReflMat * vec4(vW, 1.0);
    vec2 ruv = rc.xy / rc.w + N.xz * 0.02;
    if (all(greaterThan(ruv, vec2(0.002))) && all(lessThan(ruv, vec2(0.998)))) refl = texture(uRefl, ruv).rgb;
  }
  // muddy bottom seen through a few centimetres of water
  vec3 skyIrr = skyLut(vec3(0.0, 1.0, 0.0)) * PI * 1.1;
  vec3 Ein = uSunColor * max(uSunDir.y, 0.0) + skyIrr;
  float mud = vn(vW.xz * 0.9) * 0.5 + vn(vW.xz * 4.0) * 0.5;
  vec3 bottom = mix(vec3(0.06, 0.052, 0.036), vec3(0.1, 0.085, 0.055), mud) * Ein / PI;
  vec3 col = mix(bottom, refl, F);
  // planted rows of seedlings: anti-aliased dots on a 0.22 x 0.30 m grid, rows
  // following the terrace (roughly along x); fades to its mean cover far away
  vec2 q = vec2(vW.x / 0.22 + 0.35 * sin(vW.z * 0.9), vW.z / 0.30);
  vec2 fq = abs(fract(q) - 0.5) * vec2(0.22, 0.30) / 0.06;
  float fw = max(fwidth(q.x) * 0.22, fwidth(q.y) * 0.30) / 0.06;
  float dotM = 1.0 - smoothstep(0.42 - fw, 0.42 + fw, length(fq));
  float cov = mix(dotM, 0.09, smoothstep(0.25, 1.2, fw)) * (1.0 - uNight * 0.3);
  vec3 riceC = vec3(0.075, 0.13, 0.03) * (0.8 + 0.4 * vn(vW.xz * 1.3)) * (uSunColor * max(uSunDir.y, 0.0) * 0.8 + skyIrr) / PI;
  col = mix(col, riceC, cov * 0.85);
  // sun glint
  vec3 Hh = normalize(uSunDir + V);
  float spec = pow(max(dot(N, Hh), 0.0), 900.0) * 60.0;
  col += uSunColor * spec * F * step(0.0, uSunDir.y);
  vec4 ap = aerial(cameraPosition, vW);
  col = col * ap.a + ap.rgb;
  gl_FragColor = vec4(col, 1.0);
}`;

export function buildPaddies(terrainMat) {
  const HM = heightMap();
  const { nx, nz, hq, mask } = HM;
  const { x0, z0 } = PADDY_BOX;
  const group = new THREE.Group();
  group.name = 'paddies';
  // levels present
  let lo = Infinity, hi = -Infinity;
  const bbox = new Map();
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (mask[k] < 0.55) continue;
      const L = Math.floor(hq[k] / PADDY_STEP);
      lo = Math.min(lo, L); hi = Math.max(hi, L);
      const x = x0 + (i + 0.5) * RES, z = z0 + (j + 0.5) * RES;
      if (!bbox.has(L)) bbox.set(L, [x, z, x, z]);
      const b = bbox.get(L);
      b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], z); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], z);
    }
  }
  const uniforms = {
    ...U,
    uHM: { value: HM.tex }, uHMRect: { value: HM.rect }, uStep: { value: PADDY_STEP },
    uSunColor: { value: new THREE.Vector3(10, 10, 10) },
    uRefl: { value: null }, uReflMat: { value: new THREE.Matrix4() }, uReflOn: { value: 0 }, uEnvSky: { value: null },
    // two drops in front of the camera at the opening (morning walk time)
    uDrops: { value: [new THREE.Vector4(342.9, -256.9, 1.6, 1), new THREE.Vector4(341.2, -254.2, 3.9, 0.8)] },
  };
  const water = new THREE.Group();
  water.name = 'paddy-water';
  for (const [L, b] of bbox) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, clipping: true,
      uniforms: { ...uniforms, uLevel: { value: L } },
    });
    const w = b[2] - b[0] + 1, d = b[3] - b[1] + 1;
    const g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, mat);
    m.position.set((b[0] + b[2]) / 2, L * PADDY_STEP + 0.02, (b[1] + b[3]) / 2);
    m.receiveShadow = false;
    water.add(m);
  }
  group.add(water);
  // levees and risers along the downhill edge of every level
  const R = rng(3131);
  const lev = { pos: [], nor: [], info: [], idx: [] };
  const ris = { pos: [], uv: [], col: [], idx: [] };        // stone risers
  const bank = { pos: [], info: [], idx: [] };                // grass banks
  const stoneRiser = (x, z) => perlin(x / 40 + 3, z / 40) > 0.05;
  for (let L = lo + 1; L <= hi; L++) {
    const lines = contours(hq, mask, nx, nz, L * PADDY_STEP, x0, z0).map((l) => smoothLine(l));
    for (const line of lines) {
      // downhill normal from the height field
      const n = line.length;
      const base = lev.pos.length / 3;
      const stone = stoneRiser(line[0][0], line[0][1]);
      const tgt = stone ? ris : bank;
      const rbase = tgt.pos.length / 3;
      for (let i = 0; i < n; i++) {
        const [x, z] = line[i];
        const e = 0.5;
        const gx = groundNatural(x + e, z) - groundNatural(x - e, z), gz = groundNatural(x, z + e) - groundNatural(x, z - e);
        const gl = Math.hypot(gx, gz) || 1;
        const dx = -gx / gl, dz = -gz / gl;          // downhill
        const top = L * PADDY_STEP + 0.26 + 0.04 * perlin(x * 0.7, z * 0.7);
        const water = L * PADDY_STEP + 0.02;
        // levee cross-section (uphill -> downhill): 5 points
        const prof = [[-0.34, water - 0.03], [-0.2, top - 0.03], [0.0, top], [0.2, top - 0.02], [0.3, top - 0.1]];
        for (const [o, y] of prof) {
          lev.pos.push(x + dx * o, y, z + dz * o);
          lev.info.push(0, 0, 0, y - 0.3);
        }
        // riser: from the levee's downhill shoulder down to below the next water
        const bottom = (L - 1) * PADDY_STEP - 0.1;
        const batter = stone ? 0.12 : 0.5;
        tgt.pos.push(x + dx * 0.3, top - 0.1, z + dz * 0.3, x + dx * (0.3 + batter), bottom, z + dz * (0.3 + batter));
        if (stone) {
          const s = i * 0.5;
          ris.uv.push(s, top, s, bottom);
          const t = 0.8 + 0.35 * R();
          ris.col.push(t, t, t, t, t, t);
        } else {
          bank.info.push(0, 0, 0, top - 0.5, 0, 0, 0, bottom);
        }
      }
      for (let i = 0; i < n - 1; i++) {
        for (let k = 0; k < 4; k++) {
          const a = base + i * 5 + k, b = a + 1, c = a + 5, d = c + 1;
          lev.idx.push(a, c, b, b, c, d);
        }
        const a = rbase + i * 2, b = a + 1, c = a + 2, d = a + 3;
        tgt.idx.push(a, c, b, b, c, d);
      }
    }
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(lev.pos, 3));
  lg.setAttribute('aInfo', new THREE.Float32BufferAttribute(lev.info, 4));
  lg.setIndex(lev.idx);
  lg.computeVertexNormals();
  const levees = new THREE.Mesh(lg, terrainMat);
  levees.castShadow = true; levees.receiveShadow = true; levees.name = 'levees';
  group.add(levees);
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(ris.pos, 3));
  rg.setAttribute('uv', new THREE.Float32BufferAttribute(ris.uv, 2));
  rg.setAttribute('color', new THREE.Float32BufferAttribute(ris.col, 3));
  rg.setIndex(ris.idx);
  rg.computeVertexNormals();
  const risers = new THREE.Mesh(rg, materials().stoneWall);
  risers.castShadow = true; risers.receiveShadow = true; risers.name = 'risers';
  group.add(risers);
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.Float32BufferAttribute(bank.pos, 3));
  bg.setAttribute('aInfo', new THREE.Float32BufferAttribute(bank.info, 4));
  bg.setIndex(bank.idx);
  bg.computeVertexNormals();
  const banks = new THREE.Mesh(bg, terrainMat);
  banks.castShadow = true; banks.receiveShadow = true; banks.name = 'banks';
  group.add(banks);
  group.userData = { uniforms, levels: [lo, hi] };
  return group;
}
