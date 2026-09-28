// Small living things: fireflies over the terraces at night, a black kite circling in
// the morning, gulls over the harbour at sunset. All motion is a pure function of
// time (renders can start anywhere).
import * as THREE from 'three';
import { U } from './env.js';
import { rng } from './noise.js';
import { prep } from './materials.js';

// ---------------------------------------------------------------------------
// Fireflies: camera-facing glow sprites, additive, blinking in slow waves.
// ---------------------------------------------------------------------------
const FF_VERT = /* glsl */`
attribute vec4 aSeed;      // x, y, z home position (world) + phase
uniform float uTime;
uniform float uOn;
varying float vGlow;
varying vec2 vQ;
float hh(float n) { return fract(sin(n * 91.345) * 47453.5453); }
void main() {
  float ph = aSeed.w;
  float t = uTime;
  // wander around home: layered slow sines (a cheap curl-ish drift)
  vec3 p = aSeed.xyz;
  p.x += sin(t * 0.31 + ph * 6.1) * 1.4 + sin(t * 0.83 + ph * 2.3) * 0.5;
  p.z += cos(t * 0.27 + ph * 4.7) * 1.4 + sin(t * 0.71 + ph * 5.9) * 0.5;
  p.y += sin(t * 0.45 + ph * 3.3) * 0.45 + sin(t * 1.3 + ph * 7.7) * 0.12;
  // blink: a soft pulse every ~2-3 s, partly synchronised in waves
  float period = 2.2 + hh(ph) * 1.2;
  float x = fract(t / period + ph + 0.15 * sin(p.x * 0.05 + t * 0.3));
  float pulse = smoothstep(0.0, 0.12, x) * (1.0 - smoothstep(0.18, 0.55, x));
  vGlow = (0.15 + 0.85 * pulse) * uOn;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float size = 0.06 + 0.05 * pulse;
  mv.xy += position.xy * size * (1.0 + 0.004 * -mv.z);
  vQ = position.xy;
  gl_Position = projectionMatrix * mv;
}`;
const FF_FRAG = /* glsl */`
precision highp float;
varying float vGlow;
varying vec2 vQ;
uniform float uIntensity;
void main() {
  float r = length(vQ);
  float core = exp(-r * r * 18.0);
  float halo = exp(-r * r * 3.5) * 0.25;
  float a = (core + halo) * vGlow;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vec3(0.72, 1.0, 0.35) * a * uIntensity, 0.0);
}`;

export function fireflies({ center = [330, 40, -225], radius = 70, count = 260, seed = 5 } = {}, heightAt) {
  const R = rng(seed);
  const quad = new THREE.PlaneGeometry(2, 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.attributes.position);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const a = R() * Math.PI * 2, r = Math.sqrt(R()) * radius;
    const x = center[0] + Math.cos(a) * r, z = center[2] + Math.sin(a) * r * 0.7;
    const y = (heightAt ? heightAt(x, z) : center[1]) + 0.4 + R() * 1.6;
    seeds.set([x, y, z, R()], i * 4);
  }
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.instanceCount = count;
  // plain add (ONE, ONE) and alpha 0: glow adds light without covering the sky
  const mat = new THREE.ShaderMaterial({
    vertexShader: FF_VERT, fragmentShader: FF_FRAG,
    uniforms: { uTime: U.uTime, uOn: { value: 1 }, uIntensity: { value: 40 } },
    transparent: true, depthWrite: false, blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = 'fireflies';
  mesh.renderOrder = 10;
  return mesh;
}

// ---------------------------------------------------------------------------
// Birds: a simple swept-wing silhouette whose wings flap/glide in the vertex shader.
// ---------------------------------------------------------------------------
function birdGeometry(span = 1.5, len = 0.55) {
  // body along +z (forward), wings along x; wing verts carry a "flap weight" in uv.x
  const s = span / 2;
  const P = [
    // left wing (inner, outer, back)
    0, 0, 0.12, -s * 0.45, 0.02, 0.05, 0, 0, -0.1,
    -s * 0.45, 0.02, 0.05, -s, -0.02, -0.12, -s * 0.5, 0, -0.14,
    -s * 0.45, 0.02, 0.05, -s * 0.5, 0, -0.14, 0, 0, -0.1,
    // right wing
    0, 0, 0.12, 0, 0, -0.1, s * 0.45, 0.02, 0.05,
    s * 0.45, 0.02, 0.05, s * 0.5, 0, -0.14, s, -0.02, -0.12,
    s * 0.45, 0.02, 0.05, 0, 0, -0.1, s * 0.5, 0, -0.14,
    // body + tail
    0, 0.03, len * 0.5, -0.05, 0, 0, 0.05, 0, 0,
    -0.05, 0, 0, 0, 0, -len * 0.5, 0.05, 0, 0,
    0, 0, -len * 0.3, -0.1, 0, -len * 0.62, 0.1, 0, -len * 0.62,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  const w = [];
  for (let i = 0; i < P.length; i += 3) w.push(Math.min(1, Math.abs(P[i]) / s), 0);
  g.setAttribute('uv', new THREE.Float32BufferAttribute(w, 2));
  g.computeVertexNormals();
  return g;
}

// A flock following closed paths: each bird circles (kite) or wanders (gulls).
// paths(t, i) -> {pos: Vector3, dir: Vector3, flap: 0..1}
export function birds({ count = 1, span = 1.5, color = 0x2a211a, path, seed = 1, flapRate = 3 }) {
  const geo = birdGeometry(span);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8, side: THREE.DoubleSide });
  const uFlap = { value: new Float32Array(16) };
  prep(mat, (sh) => {
    sh.uniforms.uFlaps = uFlap;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uFlaps[16];')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        float fl = uFlaps[gl_InstanceID];
      #else
        float fl = uFlaps[0];
      #endif
      float wv = uv.x;
      transformed.y += sin(fl) * wv * ${(span * 0.32).toFixed(3)};
      transformed.x *= 1.0 - 0.12 * wv * (0.5 + 0.5 * sin(fl));`);
  }, 'bird' + span);
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  mesh.name = 'birds';
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1);
  mesh.userData.update = (t) => {
    for (let i = 0; i < count; i++) {
      const { pos, dir, flap, bank = 0 } = path(t, i);
      const fwd = dir.clone().normalize();
      const x = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fwd).normalize();
      const y = new THREE.Vector3().crossVectors(fwd, x);
      m.makeBasis(x, y, fwd);
      q.setFromRotationMatrix(m);
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), bank));
      m.compose(pos, q, sc);
      mesh.setMatrixAt(i, m);
      uFlap.value[i] = flap;
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  return mesh;
}

// ---------------------------------------------------------------------------
// A wind chime (風鈴) under an eave: glass bell, clapper, a paper strip that catches
// the breeze. Gusts at the given times make it swing (the chime sounds there).
// ---------------------------------------------------------------------------
export function furin({ gusts = [], color = 0x3d7fd1, paper = 0xe8d9a8 } = {}) {
  const root = new THREE.Group();
  root.name = 'furin';
  const glass = prep(new THREE.MeshStandardMaterial({ color: 0xdfeef5, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.42, envMapIntensity: 1.6 }), null, 'furin-glass');
  const paint = prep(new THREE.MeshStandardMaterial({ color, roughness: 0.3 }), null, 'furin-paint');
  const str = prep(new THREE.MeshStandardMaterial({ color: 0xd8d0c0, roughness: 0.9 }), null, 'furin-str');
  const pap = prep(new THREE.MeshStandardMaterial({ color: paper, roughness: 0.85, side: THREE.DoubleSide }), null, 'furin-paper');
  // hook + string (pivot at the top)
  const swing = new THREE.Group();
  root.add(swing);
  const s1 = new THREE.Mesh(new THREE.CylinderGeometry(0.0015, 0.0015, 0.1, 4), str);
  s1.position.y = -0.05;
  swing.add(s1);
  // bell: an open glass dome with a painted band
  const bell = new THREE.Mesh(new THREE.SphereGeometry(0.042, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.58), glass);
  bell.position.y = -0.14;
  const band = new THREE.Mesh(new THREE.SphereGeometry(0.0425, 20, 3, 0, Math.PI * 2, Math.PI * 0.36, Math.PI * 0.12), paint);
  band.position.y = -0.14;
  swing.add(bell, band);
  // clapper + strip hang from inside the bell
  const inner = new THREE.Group();
  inner.position.y = -0.14;
  swing.add(inner);
  const s2 = new THREE.Mesh(new THREE.CylinderGeometry(0.001, 0.001, 0.12, 3), str);
  s2.position.y = -0.06;
  const clap = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.012, 8), glass);
  clap.position.y = -0.03;
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.045, 0.2), pap);
  strip.position.y = -0.22;
  inner.add(s2, clap, strip);
  for (const m of [bell, band, s1, s2, clap, strip]) { m.castShadow = true; m.receiveShadow = true; }
  root.userData.update = (t) => {
    // breeze: small restless motion + a swing after each gust
    let a = 0.05 * Math.sin(t * 1.7) + 0.03 * Math.sin(t * 3.1 + 1.2);
    let b = 0.12 * Math.sin(t * 2.3 + 0.4) + 0.06 * Math.sin(t * 4.9);
    for (const g of gusts) {
      const u = t - g + 0.25;
      if (u > 0) { const e = Math.exp(-u * 1.1); a += 0.28 * e * Math.sin(u * 5.2); b += 0.7 * e * Math.sin(u * 4.1 + 0.6); }
    }
    swing.rotation.set(a * 0.6, 0, a);
    inner.rotation.set(b * 0.4, b * 0.2, b);
  };
  return root;
}
