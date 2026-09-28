// The whole film is one scene: the walk through the town. Every temporal sample
// renders the visible segment(s) with three.js and composites sky + world here;
// neighbouring segments dissolve into each other.
import { DURATION, W, H, XFADE, EV, segmentsAt } from '../timeline.js';
import { World } from '../world/world.js';
import { ENVS } from '../world/shots.js';

const COMPOSITE = `
uniform sampler2D uSky0;
uniform sampler2D uMain0;
uniform sampler2D uSky1;
uniform sampler2D uMain1;
uniform float uW1;
uniform vec2 uShift;
uniform float uExp0;
uniform float uExp1;
uniform float uLeakSeed;
uniform vec4 uSun;        // xy: sun uv, z: flare strength, w: aspect-correct radius scale
uniform vec3 uSunCol;
// lens flare: ghosts along the line through the centre, a soft anamorphic streak;
// fades as the sun disc gets covered (alpha of the scene target around it)
vec3 flare(vec2 uv, sampler2D mainTex) {
  if (uSun.z <= 0.0) return vec3(0.0);
  vec2 s = uSun.xy;
  float vis = 0.0;
  for (int i = 0; i < 9; i++) {
    vec2 o = vec2(float(i % 3) - 1.0, float(i / 3) - 1.0) * vec2(0.003, 0.0053);
    vec2 q = s + o;
    vis += (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) ? 0.0 : 1.0 - texture(mainTex, q).a;
  }
  vis /= 9.0;
  if (vis <= 0.0) return vec3(0.0);
  vec2 asp = vec2(1.7778, 1.0);
  vec3 c = vec3(0.0);
  vec2 axis = vec2(0.5) - s;
  for (int k = 0; k < 6; k++) {
    float f = k == 0 ? 0.35 : k == 1 ? 0.62 : k == 2 ? 0.9 : k == 3 ? 1.25 : k == 4 ? 1.55 : 1.9;
    float r = k == 0 ? 0.02 : k == 1 ? 0.045 : k == 2 ? 0.012 : k == 3 ? 0.07 : k == 4 ? 0.03 : 0.11;
    vec3 tint = k == 0 ? vec3(1.0, 0.7, 0.4) : k == 1 ? vec3(0.5, 0.8, 1.0) : k == 2 ? vec3(1.0, 0.9, 0.6) : k == 3 ? vec3(0.6, 1.0, 0.7) : k == 4 ? vec3(1.0, 0.5, 0.4) : vec3(0.5, 0.6, 1.0);
    vec2 g = s + axis * f;
    float d = length((uv - g) * asp);
    float disc = smoothstep(r, r * 0.7, d) * (0.6 + 0.4 * smoothstep(r * 0.4, r, d));
    c += tint * disc * 0.012;
  }
  float streak = exp(-abs(uv.y - s.y) * 260.0) * exp(-abs(uv.x - s.x) * 2.2);
  float glow = exp(-length((uv - s) * asp) * 9.0);
  c += vec3(1.0, 0.72, 0.45) * (streak * 0.035 + glow * 0.018);
  return c * uSunCol * vis * uSun.z;
}
void main() {
  vec2 uv = vUv;
  vec4 m0 = texture(uMain0, uv);
  vec3 c0 = (texture(uSky0, uv + uShift).rgb * (1.0 - m0.a) + m0.rgb) * uExp0;
  vec3 c = c0 + flare(uv, uMain0) * uExp0 * (1.0 - uW1);
  if (uW1 > 0.0) {
    vec4 m1 = texture(uMain1, uv);
    vec3 c1 = (texture(uSky1, uv + uShift).rgb * (1.0 - m1.a) + m1.rgb) * uExp1;
    // the new scene's bright areas come through first, with a soft organic edge
    float l1 = dot(c1, vec3(0.2126, 0.7152, 0.0722));
    float key = clamp(0.55 * smoothstep(0.02, 0.6, l1) + 0.45 * fbm(uv * vec2(3.0, 1.8) + uLeakSeed), 0.0, 1.0);
    float k = smoothstep(key - 0.35, key + 0.35, uW1 * 1.7 - 0.35);
    c = mix(c0, c1, k);
    // a warm light leak drifting across the frame at the midpoint of the dissolve
    float bell = sin(3.14159 * clamp(uW1, 0.0, 1.0));
    vec2 q = uv - vec2(1.05 - uW1 * 0.5, 0.75 + 0.1 * sin(uLeakSeed));
    q.x *= 1.6;
    float leak = exp(-dot(q, q) * 4.5) * bell * bell;
    c += vec3(1.0, 0.52, 0.25) * leak * 0.28 + vec3(1.0, 0.85, 0.7) * bell * bell * 0.012;
  }
  outColor = vec4(max(c, 0.0), 1.0);
}`;

function blend(a, b, u) {
  const out = {};
  for (const k of Object.keys(a)) {
    const x = a[k], y = b[k];
    out[k] = Array.isArray(x) ? x.map((v, i) => v + (y[i] - v) * u) : x + (y - x) * u;
  }
  return out;
}

export default {
  name: 'walk', start: -1, end: DURATION + 1,
  async init(E) {
    this.world = new World(E);
    await this.world.init();
    this.comp = E.g.program(COMPOSITE);
    this.lastFrame = null;
    this.sampleIndex = 0;
    this.debugView = E.params.get('view') === 'noise';
    this.params = E.params;
  },
  samples() { return 16; },
  post(t) {
    const vis = segmentsAt(t);
    const g0 = ENVS[vis[0].seg.id].grade;
    let g = g0;
    if (vis.length > 1) {
      const tb = vis[1].seg.start;
      const u = Math.min(1, Math.max(0, (t - (tb - XFADE / 2)) / XFADE));
      g = blend(g0, ENVS[vis[1].seg.id].grade, u * u * (3 - 2 * u));
    }
    if (this.debugView) return { bloom: 0, ca: 0, vignette: 0, grain: 0, hud: 0, tone: 0 };
    // fade in from black at the start, out at the very end
    const fin = Math.min(1, Math.max(0, (t - EV.fadeIn[0]) / (EV.fadeIn[1] - EV.fadeIn[0])));
    const fout = Math.min(1, Math.max(0, (DURATION - t) / 2.2));
    const fade = (fin * fin * (3 - 2 * fin)) * Math.pow(fout, 1.5);
    const P = { bloom: 0.35, threshold: 1.1, knee: 0.5, ca: 0.0008, vignette: 0.28, grain: 0.018, hud: 1, tone: 1, halation: 0.06, ...g, exposure: fade };
    // debug: ?grade=sat:1.3,contrast:1.2,exp:1.1 (exp multiplies the fade)
    const dbg = this.params && this.params.get('grade');
    if (dbg) for (const kv of dbg.split(',')) { const [k, v] = kv.split(':'); if (k === 'exp') P.exposure *= +v; else P[k] = +v; }
    return P;
  },
  render(t, E) {
    const w = this.world;
    const vis = segmentsAt(E.frameT);
    if (E.frameT !== this.lastFrame) {
      w.prepareFrame(E.frameT, vis);
      this.lastFrame = E.frameT;
      this.sampleIndex = 0;
    }
    const jit = E.g.jitter;
    if (E.params.get('view') === 'noise') w.debugNoise();
    else vis.forEach((v, i) => w.renderSample(i, t, jit, this.sampleIndex));
    this.sampleIndex++;
    let w1 = 0;
    if (vis.length > 1) {
      const tb = vis[1].seg.start;
      const u = Math.min(1, Math.max(0, (t - (tb - XFADE / 2)) / XFADE));
      w1 = u * u * (3 - 2 * u);
    }
    const r = w.rig;
    const s0 = w.slots[0], s1 = w.slots[vis.length > 1 ? 1 : 0];
    E.g.bind(E.scene);
    E.g.pass(this.comp, {
      uSky0: r.glTex(s0.sky), uMain0: r.glTex(s0.main),
      uSky1: r.glTex(s1.sky), uMain1: r.glTex(s1.main),
      uW1: w1, uShift: [w.lastOffset[0] / W, -w.lastOffset[1] / H],
      uExp0: this.debugView ? 1 : ENVS[vis[0].seg.id].exposure, uExp1: ENVS[vis[vis.length - 1].seg.id].exposure,
      uLeakSeed: vis.length > 1 ? vis[1].index * 1.7 : 0,
      uSun: w.sunScreen || [0, 0, 0, 1], uSunCol: w.sunColor || [1, 1, 1],
    });
  },
};
