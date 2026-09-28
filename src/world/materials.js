// Global shader patches: every built-in material gets the aerial perspective (distance
// haze lit by the sky) instead of three's flat fog, the shared uniforms, and a
// per-sample seed for the PCF shadow noise so it averages out across samples.
import * as THREE from 'three';
import { U } from './env.js';
import { AERIAL } from './glsl.js';

let patched = false;
export function patchChunks() {
  if (patched) return;
  patched = true;
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
  varying vec3 vFogWorld;
#endif
`;
  C.fog_vertex = /* glsl */`
#ifdef USE_FOG
  vec4 fogWP = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    fogWP = batchingMatrix * fogWP;
  #endif
  #ifdef USE_INSTANCING
    fogWP = instanceMatrix * fogWP;
  #endif
  fogWP = modelMatrix * fogWP;
  vFogWorld = fogWP.xyz;
#endif
`;
  C.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
  varying vec3 vFogWorld;
  ${AERIAL}
#endif
`;
  C.fog_fragment = /* glsl */`
#ifdef USE_FOG
  vec4 apx = aerial( cameraPosition, vFogWorld );
  gl_FragColor.rgb = gl_FragColor.rgb * apx.a + apx.rgb;
#endif
`;
  C.shadowmap_pars_fragment = C.shadowmap_pars_fragment
    .replace('float interleavedGradientNoise( vec2 position ) {', 'uniform float uShadowSeed;\n\t\tfloat interleavedGradientNoise( vec2 position ) {\n\t\t\tposition += uShadowSeed * vec2( 47.0, 17.0 );');
}

export function injectShared(shader) {
  for (const k of Object.keys(U)) shader.uniforms[k] = U[k];
}

// Every material goes through here: shared uniforms + optional patch.
// patch(shader) may edit shader.vertexShader / fragmentShader.
export function prep(mat, patch = null, key = '') {
  mat.onBeforeCompile = (shader) => {
    injectShared(shader);
    if (patch) patch(shader);
  };
  const k = 'natsu:' + key + (patch ? patch.toString().length : 0);
  mat.customProgramCacheKey = () => k;
  return mat;
}

// Default for anything created without prep(): still gets the shared uniforms.
THREE.Material.prototype.onBeforeCompile = function (shader) { injectShared(shader); };
