// Minimal WebGL2 toolkit: programs with reflected uniforms, float render targets,
// a fullscreen triangle, and a Canvas2D -> texture bridge.
import { W, H, PALETTE } from '../timeline.js';
import { hexToLinear } from './math.js';

const VERT = `#version 300 es
precision highp float;
out vec2 vUv;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const paletteGLSL = Object.entries(PALETTE)
  .map(([k, hex]) => {
    const [r, g, b] = hexToLinear(hex);
    return `const vec3 C_${k.toUpperCase()} = vec3(${r.toFixed(6)}, ${g.toFixed(6)}, ${b.toFixed(6)});`;
  })
  .join('\n');

// Shared GLSL prelude for every fragment program.
export const PRELUDE = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uRes;
uniform vec2 uJitter;
uniform float uTime;
#define PI 3.14159265359
#define TAU 6.28318530718
${paletteGLSL}
// Pixel coordinates in reel space (1920x1080, y down), including sub-pixel jitter.
vec2 reelPx(){
  vec2 f = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uRes * vec2(${W}.0, ${H}.0);
  return f - uJitter;
}
vec3 srgb2lin(vec3 c){ c = max(c, 0.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 lin2srgb(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float sat(float x){ return clamp(x, 0.0, 1.0); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3){ p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
// Value noise + fbm
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++){ s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; } return s; }
// Coverage of a signed distance (in px) with a 1px filter.
float cover(float d){ return sat(0.5 - d); }
float coverW(float d, float w){ return sat(0.5 - d / max(w, 1e-4)); }
`;

export class GL {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false, stencil: false,
      preserveDrawingBuffer: true, premultipliedAlpha: false, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float unavailable');
    gl.getExtension('OES_texture_float_linear');
    this.gl = gl;
    this.canvas = canvas;
    this.vao = gl.createVertexArray();
    this.jitter = [0, 0];
    this.time = 0;
    this.current = null; // current render target
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }

  shader(type, src) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      const lines = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)}: ${l}`);
      const m = /ERROR: \d+:(\d+)/.exec(log || '');
      const near = m ? lines.slice(Math.max(0, +m[1] - 4), +m[1] + 2).join('\n') : '';
      throw new Error(`Shader compile error:\n${log}\n${near}`);
    }
    return s;
  }

  // Build a program. `frag` is appended to PRELUDE unless `raw` is set.
  program(frag, { vert = VERT, raw = false } = {}) {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this.shader(gl.VERTEX_SHADER, vert));
    gl.attachShader(p, this.shader(gl.FRAGMENT_SHADER, raw ? frag : PRELUDE + frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link error: ' + gl.getProgramInfoLog(p));
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      uniforms[name] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size };
    }
    return { p, uniforms };
  }

  use(prog, u = {}) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    let unit = 0;
    const all = { uRes: this.current ? [this.current.w, this.current.h] : [W, H], uJitter: this.jitter, uTime: this.time, ...u };
    for (const [name, value] of Object.entries(all)) {
      const un = prog.uniforms[name];
      if (!un || value === undefined) continue;
      const { loc, type } = un;
      switch (type) {
        case gl.FLOAT: un.size > 1 ? gl.uniform1fv(loc, value) : gl.uniform1f(loc, value); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(loc, value); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(loc, value); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(loc, value); break;
        case gl.INT: case gl.BOOL: un.size > 1 ? gl.uniform1iv(loc, value) : gl.uniform1i(loc, value); break;
        case gl.FLOAT_MAT2: gl.uniformMatrix2fv(loc, false, value); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, value); break;
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, value); break;
        case gl.SAMPLER_2D: {
          const tex = value.tex || value;
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.uniform1i(loc, unit);
          unit++;
          break;
        }
        default: throw new Error(`Unhandled uniform type for ${name}`);
      }
    }
  }

  // Fullscreen pass into the current target. blend: null | 'over' | 'add' | 'mul'
  pass(prog, u = {}, blend = null) {
    const gl = this.gl;
    this.use(prog, u);
    this.setBlend(blend);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  setBlend(blend) {
    const gl = this.gl;
    if (!blend) { gl.disable(gl.BLEND); return; }
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    if (blend === 'over') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    else if (blend === 'add') gl.blendFunc(gl.ONE, gl.ONE);
    else if (blend === 'mul') gl.blendFunc(gl.DST_COLOR, gl.ZERO);
    else if (blend === 'screen') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
  }

  texture(w, h, { float = true, filter = 'linear', wrap = 'clamp', data = null, channels = 4 } = {}) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const f = filter === 'linear' ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    const wr = wrap === 'repeat' ? gl.REPEAT : wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wr);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wr);
    if (float === 32) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    else if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return tex;
  }

  target(w, h, opts = {}) {
    const gl = this.gl;
    const tex = this.texture(w, h, opts);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO incomplete ' + status);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, w, h };
  }

  bind(t) {
    const gl = this.gl;
    this.current = t;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
    gl.viewport(0, 0, t ? t.w : this.canvas.width, t ? t.h : this.canvas.height);
  }

  clear(r = 0, g = 0, b = 0, a = 0) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // Upload a canvas into a texture (flipped so GL uv matches canvas orientation).
  upload(tex, canvas) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }
}
