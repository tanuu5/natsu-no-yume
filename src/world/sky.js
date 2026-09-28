// The sky: 3D cloud noise generated on the GPU, a screen-space sky pass (rendered
// once per frame and shared by every temporal sample), and equirect renders for the
// image-based lighting and the aerial-perspective lookup.
import * as THREE from 'three';
import { FS_VERT } from './rig.js';
import { ATMOS, CLOUDS, NOISE3D } from './glsl.js';
import { U } from './env.js';

export const COMMON = /* glsl */`
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float sat(float x){ return clamp(x, 0.0, 1.0); }
`;

const SCREEN = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform vec3 uCamPos;
uniform vec3 uCamFwd;
uniform vec3 uCamRight;   // scaled by tan(fovx/2)
uniform vec3 uCamUp;      // scaled by tan(fovy/2)
uniform float uSeed;
uniform float uWeight;
${COMMON}
${ATMOS}
${CLOUDS}
void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + ndc.x * uCamRight + ndc.y * uCamUp);
  vec3 ro = vec3(uCamPos.x, max(uCamPos.y, 1.0), uCamPos.z);
  float j = fract(hash12(gl_FragCoord.xy) + uSeed);
  vec3 c = skyColor(ro, rd, j, true);
  gl_FragColor = vec4(max(c, 0.0) * uWeight, uWeight);
}
`;

// three's equirect convention: u = atan(d.z, d.x) / 2pi + 0.5, v = asin(d.y) / pi + 0.5
const EQUI = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform vec3 uCamPos;
uniform float uClouds;
uniform vec3 uGround;      // albedo of the world below the horizon
${COMMON}
${ATMOS}
${CLOUDS}
void main() {
  float phi = (vUv.x - 0.5) * 2.0 * PI;
  float el = (vUv.y - 0.5) * PI;
  vec3 rd = vec3(cos(phi) * cos(el), sin(el), sin(phi) * cos(el));
  vec3 ro = vec3(uCamPos.x, max(uCamPos.y, 1.0), uCamPos.z);
  vec3 c;
  if (rd.y >= 0.0) {
    c = skyColor(ro, rd, hash12(gl_FragCoord.xy), uClouds > 0.5);
  } else {
    // below the horizon: lit ground/sea, fading into the horizon haze
    vec3 h = atmosphere(ro, normalize(vec3(rd.x, 0.02, rd.z)));
    vec3 sunG = sunTrans(vec3(0.0, PLANET_R + 10.0, 0.0)) * uSunI * max(uSunDir.y, 0.0);
    vec3 skyG = atmosphere(ro, vec3(0.0, 1.0, 0.0)) * PI * 0.9;
    vec3 g = uGround * (sunG + skyG) / PI;
    c = mix(g, h, exp(rd.y * 14.0));
  }
  gl_FragColor = vec4(max(c, 0.0), 1.0);
}
`;

export class Sky {
  constructor(rig) {
    this.rig = rig;
    const r = rig.r;
    // --- cloud noise (128^3, tileable) ---
    const N = 128;
    const nrt = new THREE.WebGL3DRenderTarget(N, N, N, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, depthBuffer: false,
    });
    nrt.texture.wrapS = nrt.texture.wrapT = nrt.texture.wrapR = THREE.RepeatWrapping;
    const nmat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: NOISE3D,
      uniforms: { uZ: { value: 0 }, uSize: { value: N } }, depthTest: false, depthWrite: false,
    });
    rig.begin();
    for (let z = 0; z < N; z++) {
      nmat.uniforms.uZ.value = z;
      rig.fullscreen(nmat, nrt, z);
    }
    rig.end();
    this.noise = nrt;
    U.uNoise.value = nrt.texture;

    const cam = {
      uCamPos: { value: new THREE.Vector3() }, uCamFwd: { value: new THREE.Vector3() },
      uCamRight: { value: new THREE.Vector3() }, uCamUp: { value: new THREE.Vector3() }, uSeed: { value: 0 }, uWeight: { value: 1 },
    };
    this.cam = cam;
    this.screenMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: SCREEN, uniforms: { ...U, ...cam }, depthTest: false, depthWrite: false,
    });
    this.equiU = { uCamPos: { value: new THREE.Vector3() }, uClouds: { value: 1 }, uGround: { value: new THREE.Color(0.06, 0.08, 0.07) } };
    this.equiMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: EQUI, uniforms: { ...U, ...this.equiU }, depthTest: false, depthWrite: false,
    });
    this.pmrem = new THREE.PMREMGenerator(r);
  }

  // Sky as seen by `camera` (its current transform and fov; no view offset) -> rt.
  // `passes` renders with different ray-march offsets are averaged (smooth clouds).
  renderScreen(rt, camera, passes = 1, time = 0) {
    const c = this.cam;
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    const right = new THREE.Vector3(e[0], e[1], e[2]).normalize();
    const up = new THREE.Vector3(e[4], e[5], e[6]).normalize();
    const back = new THREE.Vector3(e[8], e[9], e[10]).normalize();
    const ty = Math.tan((camera.fov * Math.PI) / 360) / (camera.zoom || 1);
    const tx = ty * camera.aspect;
    c.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    c.uCamFwd.value.copy(back).negate();
    c.uCamRight.value.copy(right).multiplyScalar(tx);
    c.uCamUp.value.copy(up).multiplyScalar(ty);
    const m = this.screenMat;
    for (let i = 0; i < passes; i++) {
      c.uSeed.value = (i + 0.5) / passes + time * 0.37;
      c.uWeight.value = 1 / passes;
      // plain add (ONE, ONE): each pass writes colour * weight
      m.blending = i === 0 ? THREE.NoBlending : THREE.CustomBlending;
      m.blendSrc = m.blendSrcAlpha = THREE.OneFactor;
      m.blendDst = m.blendDstAlpha = THREE.OneFactor;
      m.blendEquation = THREE.AddEquation;
      m.transparent = i > 0;
      this.rig.fullscreen(m, rt);
    }
  }

  // Equirect of the sky around camPos (clouds optional) -> rt.
  renderEquirect(rt, camPos, clouds = true) {
    this.equiU.uCamPos.value.copy(camPos);
    this.equiU.uClouds.value = clouds ? 1 : 0;
    this.rig.fullscreen(this.equiMat, rt);
  }

  // Prefiltered environment for image-based lighting.
  envMap(equiRT) {
    equiRT.texture.mapping = THREE.EquirectangularReflectionMapping;
    const out = this.pmrem.fromEquirectangular(equiRT.texture);
    return out.texture;
  }
}
