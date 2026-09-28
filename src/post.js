// Post-processing: physically-based bloom (13-tap down / tent up), chromatic
// aberration, flash, vignette, highlight shoulder, HUD overlay, grain + dither.
import { W, H } from './timeline.js';

const DOWN = `
uniform sampler2D uSrc;
uniform vec2 uTexel;       // 1 / source size
uniform float uPrefilter;  // 1 on first level
uniform float uThreshold;
uniform float uKnee;
vec3 prefilter(vec3 c){
  float br = max(c.r, max(c.g, c.b));
  float soft = br - uThreshold + uKnee;
  soft = clamp(soft, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
  return c * contrib;
}
float karis(vec3 c){ return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722)) * 0.25); }
void main(){
  vec2 uv = vUv;
  vec2 t = uTexel;
  vec3 a = texture(uSrc, uv + t * vec2(-2, 2)).rgb;
  vec3 b = texture(uSrc, uv + t * vec2(0, 2)).rgb;
  vec3 c = texture(uSrc, uv + t * vec2(2, 2)).rgb;
  vec3 d = texture(uSrc, uv + t * vec2(-2, 0)).rgb;
  vec3 e = texture(uSrc, uv).rgb;
  vec3 f = texture(uSrc, uv + t * vec2(2, 0)).rgb;
  vec3 g = texture(uSrc, uv + t * vec2(-2, -2)).rgb;
  vec3 h = texture(uSrc, uv + t * vec2(0, -2)).rgb;
  vec3 i = texture(uSrc, uv + t * vec2(2, -2)).rgb;
  vec3 j = texture(uSrc, uv + t * vec2(-1, 1)).rgb;
  vec3 k = texture(uSrc, uv + t * vec2(1, 1)).rgb;
  vec3 l = texture(uSrc, uv + t * vec2(-1, -1)).rgb;
  vec3 m = texture(uSrc, uv + t * vec2(1, -1)).rgb;
  vec3 col;
  if (uPrefilter > 0.5) {
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    g0 = prefilter(g0); g1 = prefilter(g1); g2 = prefilter(g2); g3 = prefilter(g3); g4 = prefilter(g4);
    float w0 = karis(g0), w1 = karis(g1), w2 = karis(g2), w3 = karis(g3), w4 = karis(g4);
    col = (g0 * w0 * 0.125 + g1 * w1 * 0.125 + g2 * w2 * 0.125 + g3 * w3 * 0.125 + g4 * w4 * 0.5) /
          (w0 * 0.125 + w1 * 0.125 + w2 * 0.125 + w3 * 0.125 + w4 * 0.5);
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  outColor = vec4(max(col, 0.0), 1.0);
}`;

const UP = `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;
void main(){
  vec2 t = uTexel * uRadius;
  vec2 uv = vUv;
  vec3 s = texture(uSrc, uv).rgb * 4.0;
  s += (texture(uSrc, uv + vec2(-t.x, 0)).rgb + texture(uSrc, uv + vec2(t.x, 0)).rgb + texture(uSrc, uv + vec2(0, -t.y)).rgb + texture(uSrc, uv + vec2(0, t.y)).rgb) * 2.0;
  s += texture(uSrc, uv + vec2(-t.x, -t.y)).rgb + texture(uSrc, uv + vec2(t.x, -t.y)).rgb + texture(uSrc, uv + vec2(-t.x, t.y)).rgb + texture(uSrc, uv + vec2(t.x, t.y)).rgb;
  outColor = vec4(s / 16.0, 1.0);
}`;

const FINAL = `
uniform sampler2D uAcc;
uniform sampler2D uBloom;
uniform sampler2D uHud;
uniform float uBloomAmt;
uniform float uCA;
uniform float uVig;
uniform float uGrain;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uExposure;
uniform float uFrame;
uniform float uHudAlpha;
uniform float uTone;       // 0: soft shoulder, 1: AgX filmic
uniform vec3 uWB;          // white balance (scene linear multiplier)
uniform float uSat;        // scene saturation
uniform float uContrast;   // AgX look contrast (power)
uniform vec3 uLift;        // display-space lift (adds to blacks)
uniform vec3 uGain;        // display-space gain
uniform vec3 uShadowTint;  // split toning
uniform vec3 uHighTint;
uniform float uHalation;
// AgX (after Troy Sobotka / bwrensch minimal fit)
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x; vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 v) {
  const mat3 m = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                      0.0784335999999992, 0.878468636469772, 0.0784336,
                      0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const float lo = -12.47393, hi = 4.026069;
  v = m * max(v, vec3(1e-10));
  v = clamp(log2(v), lo, hi);
  v = (v - lo) / (hi - lo);
  return agxContrast(v);
}
vec3 agxOut(vec3 v) {
  const mat3 mi = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                       -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                       -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  v = mi * v;
  return pow(max(v, vec3(0.0)), vec3(2.2));
}
vec3 shoulder(vec3 x){
  const float k = 0.88;
  vec3 over = max(x - k, 0.0);
  vec3 comp = k + (1.0 - k) * (1.0 - exp(-over / (1.0 - k)));
  return mix(x, comp, step(k, x));
}
void main(){
  vec2 uv = vUv;
  vec2 d = uv - 0.5;
  vec2 da = d * vec2(1.7778, 1.0);
  float r2 = dot(da, da);
  vec3 col;
  if (uCA > 0.0) {
    // 5-tap spectral-ish dispersion for smoother fringes
    vec2 off = d * uCA * (0.35 + r2);
    vec3 acc = vec3(0.0);
    vec3 wsum = vec3(0.0);
    for (int i = 0; i < 5; i++) {
      float f = float(i) / 4.0 - 0.5;
      vec3 w = vec3(sat(1.0 - abs(f + 0.5) * 2.2), sat(1.0 - abs(f) * 2.2), sat(1.0 - abs(f - 0.5) * 2.2));
      acc += texture(uAcc, uv - off * f * 2.0).rgb * w;
      wsum += w;
    }
    col = acc / max(wsum, vec3(1e-4));
  } else {
    col = texture(uAcc, uv).rgb;
  }
  vec3 bl = texture(uBloom, uv).rgb;
  col += bl * uBloomAmt;
  // film halation: a warm red fringe bleeding from bright areas
  col += bl * uHalation * vec3(1.0, 0.28, 0.1);
  col *= uExposure;
  col = mix(col, uFlashColor, sat(uFlash));
  col *= 1.0 - uVig * smoothstep(0.15, 1.3, r2);
  if (uTone > 0.5) {
    col *= uWB;
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = max(mix(vec3(l), col, uSat), 0.0);
    vec3 a = agx(col);
    // look: slope/power per channel, then saturation in AgX space
    a = pow(max(a, 0.0), vec3(uContrast));
    col = agxOut(a);
    // split toning in display-linear: tint shadows and highlights
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col *= mix(uShadowTint, uHighTint, smoothstep(0.02, 0.6, lum));
    col = col * uGain + uLift * (1.0 - col);
  } else {
    col = shoulder(max(col, 0.0));
  }
  vec3 s = lin2srgb(col);
  vec4 h = texture(uHud, uv) * uHudAlpha;
  s = s * (1.0 - h.a) + h.rgb;
  // Soft film grain (smooth value noise ~1.5px) — also dithers gradients against banding.
  vec2 off = vec2(mod(uFrame * 37.13, 211.0), mod(uFrame * 71.37, 199.0));
  float gr = (vnoise(gl_FragCoord.xy / 1.4 + off) * 0.7 + vnoise(gl_FragCoord.xy / 0.8 + off.yx * 1.7) * 0.3) * 2.0 - 1.0;
  float lum = dot(s, vec3(0.299, 0.587, 0.114));
  float amp = uGrain * (0.55 + 0.45 * (1.0 - abs(lum - 0.4) * 1.4));
  s += gr * amp;
  outColor = vec4(s, 1.0);
}`;

export class Post {
  constructor(g) {
    this.g = g;
    this.down = g.program(DOWN);
    this.up = g.program(UP);
    this.final = g.program(FINAL);
    this.mips = [];
    let w = W, h = H;
    for (let i = 0; i < 7; i++) {
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
      this.mips.push(g.target(w, h));
    }
  }

  bloom(srcTex, threshold, knee) {
    const g = this.g;
    let src = srcTex, sw = W, sh = H;
    this.mips.forEach((m, i) => {
      g.bind(m);
      g.pass(this.down, { uSrc: src, uTexel: [1 / sw, 1 / sh], uPrefilter: i === 0 ? 1 : 0, uThreshold: threshold, uKnee: knee });
      src = m.tex; sw = m.w; sh = m.h;
    });
    for (let i = this.mips.length - 1; i > 0; i--) {
      const from = this.mips[i], to = this.mips[i - 1];
      g.bind(to);
      g.pass(this.up, { uSrc: from.tex, uTexel: [1 / from.w, 1 / from.h], uRadius: 1.0 }, 'add');
    }
    return this.mips[0].tex;
  }

  run(accTex, hudTex, P, frame) {
    const g = this.g;
    const bloomTex = this.bloom(accTex, P.threshold, P.knee);
    g.bind(null);
    g.pass(this.final, {
      uAcc: accTex, uBloom: bloomTex, uHud: hudTex,
      uBloomAmt: P.bloom / this.mips.length, uCA: P.ca, uVig: P.vignette, uGrain: P.grain,
      uFlash: P.flash, uFlashColor: P.flashColor, uExposure: P.exposure, uFrame: frame, uHudAlpha: P.hud,
      uTone: P.tone, uWB: P.wb, uSat: P.sat, uContrast: P.contrast, uLift: P.lift, uGain: P.gain,
      uShadowTint: P.shadowTint, uHighTint: P.highTint, uHalation: P.halation / this.mips.length,
    });
  }
}
