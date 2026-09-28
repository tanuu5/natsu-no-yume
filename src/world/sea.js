// The sea: a tileable wave-slope texture generated on the GPU, a height map of the sea
// bed (for shallow colour and foam), and the water shader: planar reflection with the
// sky behind it, Fresnel, sun glitter, turquoise shallows, foam at the shore.
import * as THREE from 'three';
import { FS_VERT } from './rig.js';
import { AERIAL } from './glsl.js';
import { U } from './env.js';
import { ground } from './geo.js';

const WAVEGEN = /* glsl */`
precision highp float;
varying vec2 vUv;
float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  vec2 p = vUv;
  float h = 0.0;
  vec2 d = vec2(0.0);
  for (int i = 0; i < 96; i++) {
    float fi = float(i);
    // integer wave numbers keep the texture tileable
    float kmag = floor(1.0 + pow(h1(fi + 0.3), 1.6) * 30.0);
    float ang = (h1(fi + 7.1) - 0.5) * 2.4 + 0.35;
    vec2 k = floor(vec2(cos(ang), sin(ang)) * kmag + 0.5);
    if (dot(k, k) < 0.5) k = vec2(1.0, 0.0);
    float a = 0.6 * pow(length(k), -1.75) * (0.6 + 0.8 * h1(fi + 3.3));
    float ph = h1(fi + 11.7) * 6.2831853;
    float arg = 6.2831853 * dot(k, p) + ph;
    h += a * sin(arg);
    d += a * 6.2831853 * k * cos(arg);
  }
  gl_FragColor = vec4(d * 0.05, h, 1.0);
}
`;

const SEA_VERT = /* glsl */`
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const SEA_FRAG = /* glsl */`
precision highp float;
#define PI 3.14159265359
varying vec3 vW;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform sampler2D uWaves;
uniform sampler2D uHeight;
uniform vec4 uHMRect;
uniform sampler2D uEnvSky;
uniform sampler2D uRefl;
uniform mat4 uReflMat;
uniform float uReflOn;
uniform float uChop;
uniform float uNight;
uniform vec3 uLights;     // warm light from the town at night (reflected streaks)
${AERIAL}
vec2 equiUv(vec3 d) { return vec2(atan(d.z, d.x) / (2.0 * PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5); }
float wh(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(wh(i), wh(i+vec2(1,0)), u.x), mix(wh(i+vec2(0,1)), wh(i+vec2(1,1)), u.x), u.y); }

const mat2 R1 = mat2(0.8, -0.6, 0.6, 0.8);
const mat2 R2 = mat2(0.28, 0.96, -0.96, 0.28);
const mat2 R3 = mat2(-0.5, 0.866, -0.866, -0.5);
vec3 waveSlope(vec2 p, float calm, float dist) {
  // long swells fade with distance faster than the chop (their repeats show from afar)
  float far = smoothstep(150.0, 1400.0, dist);
  vec2 s = vec2(0.0);
  s += texture(uWaves, p / 83.0 + uTime * vec2(0.0032, 0.0015)).rg * 0.55 * (1.0 - 0.8 * far);
  s += R1 * texture(uWaves, (R1 * p) / 31.0 + uTime * vec2(-0.0061, 0.0043)).rg * 0.55 * (1.0 - 0.6 * far);
  s += R2 * texture(uWaves, (R2 * p) / 11.3 + uTime * vec2(0.015, 0.011)).rg * 0.5;
  s += R3 * texture(uWaves, (R3 * p) / 3.7 + uTime * vec2(-0.034, 0.041)).rg * 0.34;
  s += R1 * texture(uWaves, (R1 * p) / 1.3 + uTime * vec2(0.07, -0.05)).rg * 0.2;
  float hgt = texture(uWaves, p / 83.0 + uTime * vec2(0.0032, 0.0015)).b;
  return vec3(s * uChop * mix(1.0, 0.3, calm), hgt);
}

void main() {
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  // sea bed
  vec2 huv = (vW.xz - uHMRect.xy) * uHMRect.zw;
  float bed = texture(uHeight, huv).r;
  bool inMap = all(greaterThan(huv, vec2(0.0))) && all(lessThan(huv, vec2(1.0)));
  if (!inMap) bed = -30.0;
  if (bed > 1.5) discard;              // land covers it
  float depth = max(-bed, 0.0);
  float calm = smoothstep(80.0, 150.0, length(vW.xz - vec2(-40.0, 0.0))) ;
  calm = 1.0 - calm;                  // 1 inside the harbour basin
  vec3 ws = waveSlope(vW.xz, calm, dist);
  float fadeN = 1.0 / (1.0 + dist * 0.002);
  vec3 N = normalize(vec3(-ws.x * fadeN, 1.0, -ws.y * fadeN));
  float NdV = max(dot(N, V), 0.02);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  F *= mix(1.0, 0.75, smoothstep(0.0, 0.2, 1.0 - V.y) * 0.0);
  // reflection: the planar reflection (objects), the sky behind it
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) + 0.002;
  vec3 skyR = texture(uEnvSky, equiUv(normalize(R))).rgb;
  vec3 refl = skyR;
  if (uReflOn > 0.5) {
    vec4 rc = uReflMat * vec4(vW, 1.0);
    vec2 ruv = rc.xy / rc.w;
    ruv += vec2(N.x, N.z) * (0.045 / (1.0 + dist * 0.01));
    if (all(greaterThan(ruv, vec2(0.002))) && all(lessThan(ruv, vec2(0.998)))) refl = texture(uRefl, ruv).rgb;
  }
  // light reaching the water
  vec3 skyIrr = (skyLut(vec3(0.0, 1.0, 0.0)) * 2.0 + skyLut(normalize(vec3(1.0, 0.6, 0.0))) + skyLut(normalize(vec3(-1.0, 0.6, 0.0))) + skyLut(normalize(vec3(0.0, 0.6, 1.0))) + skyLut(normalize(vec3(0.0, 0.6, -1.0)))) / 6.0 * PI;
  vec3 Ein = uSunColor * max(uSunDir.y, 0.0) + skyIrr;
  // body colour: deep blue, turquoise over sand in the shallows
  // coastal water: turbid teal; the bottom shows only in the first metre or two
  vec3 deep = mix(vec3(0.0035, 0.016, 0.02), vec3(0.002, 0.009, 0.02), smoothstep(8.0, 25.0, depth));
  vec3 sandC = vec3(0.30, 0.29, 0.23);
  float path = depth * (1.0 + 1.0 / max(NdV, 0.25));
  vec3 Tw = exp(-(vec3(0.38, 0.075, 0.058) + 0.32) * path);
  vec3 body = (deep * (1.0 - Tw) + sandC * Tw * 0.9) * Ein / PI;
  // sun glitter (GGX)
  vec3 L = uSunDir;
  vec3 Hh = normalize(L + V);
  float NdH = max(dot(N, Hh), 0.0);
  float rough = mix(0.04, 0.26, smoothstep(40.0, 3000.0, dist));
  float a2 = rough * rough;
  float dd = NdH * NdH * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float Fs = 0.02 + 0.98 * pow(1.0 - max(dot(V, Hh), 0.0), 5.0);
  vec3 spec = uSunColor * D * Fs / (4.0 * NdV) * max(dot(N, L), 0.0) * step(0.0, L.y);
  vec3 col = mix(body, refl, F) + spec;
  // foam where the water meets the shore
  float shore = smoothstep(1.1, 0.05, depth) * (1.0 - calm * 0.6);
  float fn = vn(vW.xz * 0.7 + vec2(uTime * 0.3, 0.0)) * vn(vW.xz * 2.3 - uTime * 0.2);
  float foam = smoothstep(0.25, 0.6, fn * 1.6 * shore + shore * 0.35 * (0.5 + 0.5 * sin(depth * 9.0 - uTime * 1.3)));
  col = mix(col, vec3(0.85) * Ein / PI, foam * 0.7 * smoothstep(0.02, 0.0, bed - 0.2));
  vec4 ap = aerial(cameraPosition, vW);
  col = col * ap.a + ap.rgb;
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Sea {
  constructor(rig) {
    this.rig = rig;
    // waves
    const wrt = new THREE.WebGLRenderTarget(512, 512, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, colorSpace: THREE.LinearSRGBColorSpace,
    });
    wrt.texture.anisotropy = 8;
    const wmat = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: WAVEGEN, depthTest: false, depthWrite: false });
    rig.begin();
    rig.fullscreen(wmat, wrt);
    rig.end();
    this.waves = wrt;
    // sea bed height map around the town
    const x0 = -1400, z0 = -1700, w = 2600, d = 2600, res = 650;
    const data = new Float32Array(res * res * 4);
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const h = ground(x0 + (i + 0.5) * w / res, z0 + (j + 0.5) * d / res);
        data[(j * res + i) * 4] = h;
      }
    }
    const ht = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.FloatType);
    ht.minFilter = THREE.LinearFilter; ht.magFilter = THREE.LinearFilter;
    ht.needsUpdate = true;
    this.height = ht;
    this.hmRect = new THREE.Vector4(x0, z0, 1 / w, 1 / d);
    this.uniforms = {
      ...U,
      uSunColor: { value: new THREE.Vector3(10, 10, 10) },
      uWaves: { value: wrt.texture },
      uHeight: { value: ht },
      uHMRect: { value: this.hmRect },
      uEnvSky: { value: null },
      uRefl: { value: null },
      uReflMat: { value: new THREE.Matrix4() },
      uReflOn: { value: 0 },
      uChop: { value: 0.6 },
      uLights: { value: new THREE.Vector3() },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: SEA_VERT, fragmentShader: SEA_FRAG, uniforms: this.uniforms,
    });
    const geo = new THREE.PlaneGeometry(120000, 120000, 8, 8);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'sea';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
  }
}
