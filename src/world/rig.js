// Three.js on the reel engine's WebGL2 context. Three renders the world into its own
// float render targets; the engine composites them, accumulates the temporal samples
// and runs the post. The two libraries share one context, so three's state cache is
// reset around every three render.
import * as THREE from 'three';
import { W, H } from '../timeline.js';

export const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export class Rig {
  constructor(E) {
    this.E = E;
    const r = new THREE.WebGLRenderer({
      canvas: E.canvas, context: E.gl, antialias: false, alpha: true, stencil: false,
      powerPreference: 'high-performance', reversedDepthBuffer: true,
    });
    r.setPixelRatio(1);
    r.autoClear = false;
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = true;
    this.r = r;
    this.reversed = r.capabilities.reversedDepthBuffer === true;
    this.depth = 0;
    this.fsScene = new THREE.Scene();
    this.fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.fsMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.fsMesh.frustumCulled = false;
    this.fsScene.add(this.fsMesh);
  }

  // Colour target (half float, linear) with an optional float depth texture.
  target(w = W, h = H, { depth = true, float32 = false } = {}) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: float32 ? THREE.FloatType : THREE.HalfFloatType, format: THREE.RGBAFormat,
      depthBuffer: depth, stencilBuffer: false, generateMipmaps: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.LinearSRGBColorSpace,
    });
    if (depth) rt.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
    return rt;
  }

  // Raw WebGLTexture of a three texture / render target (for engine passes).
  glTex(x) {
    const tex = x.isRenderTarget ? x.texture : x;
    return this.r.properties.get(tex).__webglTexture;
  }

  // begin/end nest: only the outermost pair resets three's state
  begin() {
    if (this.depth++ > 0) return;
    this.r.resetState();
    if (this.reversed) {
      // resetState() drops the reversed-Z clip control and leaves the cached clear
      // depth null, so the depth clear value must be pushed again (0 when reversed)
      const d = this.r.state.buffers.depth;
      d.setReversed(true);
      d.setClear(1);
    }
  }

  end() {
    if (--this.depth > 0) return;
    this.depth = 0;
    this.r.resetState();
  }

  // Draw a full-screen material into rt (inside begin/end).
  fullscreen(material, rt, layer = 0) {
    this.fsMesh.material = material;
    this.r.setRenderTarget(rt, layer);
    this.r.render(this.fsScene, this.fsCam);
  }
}
