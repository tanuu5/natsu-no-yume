// Solid 3D type: a glyph's distance field is extruded and bevelled, then
// raymarched under a studio environment (softboxes + an overhead lighting grid)
// with clay / chrome / thin-film materials. One instance per string.
import { glyphSDF } from './sdf.js';

const FRAG = `
uniform sampler2D uSdf;
uniform vec3 uCamPos;
uniform vec3 uCamTarget;
uniform float uFov;
uniform float uTexScale;     // world units per texel
uniform float uHalf;         // half extent of the field in world units
uniform float uDepth;        // half thickness
uniform float uBevel;
uniform mat3 uRot;
uniform float uChrome;
uniform float uFilm;
uniform vec3 uTint;
uniform float uBg;           // 1 = draw backdrop, 0 = transparent (alpha)
uniform float uGlow;
uniform float uFlat;         // flat fill (no lighting)
uniform vec3 uFlatColor;
uniform float uExpose;
uniform vec2 uOffset;        // screen offset of the object (NDC-ish, y up)
uniform float uHdr;

float field(vec2 q){
  // q in world units, centred; outside the texture fall back to a box bound
  vec2 uv = q / (2.0 * uHalf) + 0.5;
  vec2 cuv = clamp(uv, vec2(0.002), vec2(0.998));
  float d = texture(uSdf, cuv).r * uTexScale;
  vec2 o = abs(q) - vec2(uHalf * 0.996);
  float outside = length(max(o, 0.0));
  return d + outside;
}

float mapObj(vec3 p){
  p = uRot * p;
  float d2 = field(p.xy);
  // bevelled extrusion
  vec2 w = vec2(d2 + uBevel, abs(p.z) - uDepth + uBevel);
  return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - uBevel;
}

float softbox(vec3 d, vec3 c, vec3 up, vec2 size, float soft){
  float z = dot(d, c);
  if (z <= 0.0) return 0.0;
  vec3 rt = normalize(cross(c, up));
  vec3 u = cross(rt, c);
  vec2 q = vec2(dot(d, rt), dot(d, u)) / z;
  vec2 e = 1.0 - smoothstep(size - soft, size + soft, abs(q));
  return e.x * e.y;
}

vec3 env(vec3 d){
  vec3 col = mix(vec3(0.004, 0.0035, 0.003), vec3(0.03, 0.026, 0.022), smoothstep(-0.2, 0.9, d.y));
  col += C_PAPER * 7.0 * softbox(d, normalize(vec3(-0.65, 0.62, 0.55)), vec3(0, 1, 0), vec2(0.55, 0.32), 0.08);
  col += mix(uTint, vec3(1.0), 0.25) * 6.0 * softbox(d, normalize(vec3(1.0, 0.12, -0.15)), vec3(0, 1, 0), vec2(0.07, 0.9), 0.04);
  col += C_LILAC * 4.0 * softbox(d, normalize(vec3(0.15, 0.85, -0.7)), vec3(0, 0, 1), vec2(0.6, 0.12), 0.05);
  vec3 gc = normalize(vec3(0.0, 1.0, 0.25));
  float gz = dot(d, gc);
  if (gz > 0.0) {
    vec3 gr = normalize(cross(gc, vec3(1, 0, 0)));
    vec3 gu = cross(gr, gc);
    vec2 gq = vec2(dot(d, gr), dot(d, gu)) / gz;
    vec2 cell = abs(fract(gq * 3.2) - 0.5);
    float lamp = (1.0 - smoothstep(0.16, 0.22, max(cell.x, cell.y))) * (1.0 - smoothstep(0.9, 1.1, max(abs(gq.x), abs(gq.y))));
    col += C_PAPER * 3.5 * lamp;
  }
  col += C_PAPER * 2.5 * softbox(d, normalize(vec3(-0.9, 0.05, -0.45)), vec3(0, 1, 0), vec2(0.12, 0.7), 0.05);
  col += C_PAPER * 0.9 * softbox(d, normalize(vec3(0.25, 0.3, 1.0)), vec3(0, 1, 0), vec2(0.9, 0.45), 0.35);
  col += uTint * 0.5 * (1.0 - smoothstep(-0.7, 0.0, d.y));
  return col;
}

vec3 calcNormal(vec3 p){
  const vec2 k = vec2(1, -1);
  float h = uTexScale * 1.6;
  return normalize(k.xyy * mapObj(p + k.xyy * h) + k.yyx * mapObj(p + k.yyx * h) + k.yxy * mapObj(p + k.yxy * h) + k.xxx * mapObj(p + k.xxx * h) + 1e-7);
}

float calcAO(vec3 p, vec3 n){
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 5; i++){
    float h = 0.02 + 0.1 * float(i);
    float d = mapObj(p + h * n);
    occ += (h - d) * sca;
    sca *= 0.8;
  }
  return sat(1.0 - 2.0 * occ);
}

void main(){
  vec2 px = reelPx();
  vec2 uv = vec2(px.x - 960.0, 540.0 - px.y) / 540.0 - uOffset;
  vec3 ww = normalize(uCamTarget - uCamPos);
  vec3 uu = normalize(cross(ww, vec3(0, 1, 0)));
  vec3 vv = cross(uu, ww);
  vec3 rd = normalize(uv.x * uu + uv.y * vv + ww / tan(uFov * 0.5));
  vec3 ro = uCamPos;
  float r = length(uv * vec2(0.85, 1.0));
  vec3 bg = mix(C_INK2 * 1.6, C_INK * 0.55, smoothstep(0.0, 1.25, r));

  float t = 0.0, d = 1.0;
  bool hit = false;
  float bound = uHalf * 1.8 + uDepth;
  // start the march at the bounding sphere
  float b = dot(ro, rd);
  float c = dot(ro, ro) - bound * bound;
  float disc = b * b - c;
  if (disc > 0.0) {
    t = max(0.0, -b - sqrt(disc));
    float tEnd = -b + sqrt(disc);
    for (int i = 0; i < 160; i++){
      vec3 p = ro + rd * t;
      d = mapObj(p);
      if (d < 0.0006 * max(t, 1.0)) { hit = true; break; }
      t += d * 0.9;
      if (t > tEnd) break;
    }
  }
  vec3 col = bg * uBg;
  float alpha = uBg;
  if (hit) {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);
    vec3 v = -rd;
    float ndv = sat(dot(n, v));
    vec3 rf = reflect(rd, n);
    float ao = calcAO(p, n);
    vec3 Lk = normalize(vec3(-0.65, 0.62, 0.55));
    vec3 Lr = normalize(vec3(0.3, 0.6, -0.8));
    vec3 Ls = normalize(vec3(1.0, 0.1, -0.15));
    vec3 diff = uTint * (C_PAPER * 2.4 * sat(dot(n, Lk) * 0.8 + 0.2)
                        + C_LILAC * 0.9 * sat(dot(n, Lr))
                        + vec3(1.0, 0.55, 0.4) * 1.3 * sat(dot(n, Ls))
                        + vec3(0.05, 0.04, 0.045)) * ao;
    diff += uTint * vec3(1.0, 0.35, 0.2) * 0.35 * pow(sat(1.0 - abs(dot(n, Lk))), 3.0) * ao;
    float fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
    vec3 refl = env(rf);
    vec3 clay = diff + refl * mix(0.06, 1.0, fres) * ao;
    vec3 film = 0.5 + 0.5 * cos(TAU * (vec3(0.0, 0.33, 0.67) + ndv * 1.7 + 0.15));
    vec3 tint = mix(mix(vec3(1.0), uTint * 1.4 + 0.25, 0.35), film * 1.1, uFilm);
    vec3 chrome = refl * tint * (0.55 + 0.45 * fres) * mix(0.5, 1.0, ao) + uTint * 0.04;
    vec3 m = mix(clay, chrome, uChrome);
    m = mix(m, uFlatColor, uFlat);
    col = m * uExpose;
    alpha = 1.0;
  }
  col += uTint * uGlow * 0.02 / (dot(uv, uv) + 0.02);
  outColor = vec4(col * uHdr, alpha);
}`;

export class ChromeText {
  constructor(E, text, font, { size = 1024, fill = 0.8 } = {}) {
    this.E = E;
    const f = glyphSDF(text, font, { size, fill });
    this.size = size;
    // world: the glyph's larger dimension spans `fill` of the field; field spans 2*half.
    this.half = 1.0;                         // field spans [-1, 1]
    this.texScale = (2 * this.half) / size;  // world units per texel
    this.aspect = f.aspect;
    this.tex = E.g.texture(size, size, { float: 32, filter: 'linear', data: f.data });
    this.prog = E.g.program(FRAG);
  }

  // cam: {pos, target, fov}; rot: 3x3 column-major array (object -> world inverse)
  render(u) {
    this.E.g.pass(this.prog, {
      uSdf: this.tex, uTexScale: this.texScale, uHalf: this.half,
      uDepth: 0.16, uBevel: 0.035, uChrome: 1, uFilm: 0.6, uTint: [0.86, 0.2, 0.07], uBg: 1, uGlow: 0,
      uFlat: 0, uFlatColor: [0, 0, 0], uExpose: 1, uOffset: [0, 0], uHdr: 1,
      ...u,
    }, u.uBg === 0 ? 'over' : null);
  }
}

// Rotation matrix helpers (column-major for GLSL mat3)
export function rotY(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 1, 0, s, 0, c]; }
export function rotX(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, s, 0, -s, c]; }
export function rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, -s, c, 0, 0, 0, 1]; }
export function mul3(a, b) {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[j * 3 + i] += a[k * 3 + i] * b[j * 3 + k];
  return r;
}
