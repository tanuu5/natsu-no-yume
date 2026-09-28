// Reel engine: temporal super-sampling (motion blur + AA), scene scheduling,
// 2D layer compositing, post, HUD, preview playback and offline render API.
import { GL } from './lib/gl.js';
import { Post } from './post.js';
import { drawHud } from './hud.js';
import { W, H, FPS, DURATION } from './timeline.js';
import { hexToLinear } from './lib/math.js';
import { SCENES } from './scenes/index.js';

const params = new URLSearchParams(location.search);
const RENDER = params.has('render');
const SHUTTER = 0.5; // 180 degrees

const ACCUM = `
uniform sampler2D uScene;
uniform float uWeight;
uniform mat3 uCam;
void main(){
  vec2 px = gl_FragCoord.xy;
  vec2 q = (uCam * vec3(px, 1.0)).xy;
  vec3 c = texture(uScene, q / vec2(${W}.0, ${H}.0)).rgb;
  outColor = vec4(c * uWeight, uWeight);
}`;

const LAYER = `
uniform sampler2D uTex;
uniform float uOpacity;
uniform float uGain;
void main(){
  vec4 c = texture(uTex, vUv);
  vec3 rgb = c.a > 0.0 ? srgb2lin(c.rgb / c.a) * c.a : vec3(0.0);
  outColor = vec4(rgb * uGain, c.a) * uOpacity;
}`;

const SOLID = `
uniform vec4 uColor;
void main(){ outColor = uColor; }`;

function halton(i, base) {
  let f = 1, r = 0;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}

const DEFAULT_POST = {
  bloom: 0.9, threshold: 1.0, knee: 0.6, ca: 0.0012, vignette: 0.22, grain: 0.022,
  flash: 0, flashColor: [1, 1, 1], exposure: 1, hud: 1,
  tone: 0, wb: [1, 1, 1], sat: 1, contrast: 1, lift: [0, 0, 0], gain: [1, 1, 1],
  shadowTint: [1, 1, 1], highTint: [1, 1, 1], halation: 0,
};

class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = new GL(canvas);
    this.gl = this.g.gl;
    this.W = W; this.H = H;
    this.scene = this.g.target(W, H);
    this.acc = this.g.target(W, H);
    this.post = new Post(this.g);
    this.accumProg = this.g.program(ACCUM);
    this.layerProg = this.g.program(LAYER);
    this.solidProg = this.g.program(SOLID);
    this.c2 = document.createElement('canvas');
    this.c2.width = W; this.c2.height = H;
    this.ctx = this.c2.getContext('2d');
    this.layerTex = this.g.texture(W, H, { float: false });
    this.hudCanvas = document.createElement('canvas');
    this.hudCanvas.width = W; this.hudCanvas.height = H;
    this.hudCtx = this.hudCanvas.getContext('2d');
    this.hudTex = this.g.texture(W, H, { float: false });
    this.cam = { x: 0, y: 0, rot: 0, zoom: 1 };
    this.scenes = SCENES;
    this.params = params;
  }

  async init() {
    for (const s of this.scenes) if (s.init) await s.init(this);
  }

  // Load whatever the scenes on screen at frame time t need (footage frames).
  async prepare(t) {
    const jobs = [];
    for (const s of this.activeScenes(t)) if (s.prepare) jobs.push(s.prepare(t, this));
    await Promise.all(jobs);
  }

  // ---- helpers for scenes ---------------------------------------------
  fill(color, alpha = 1) {
    const c = typeof color === 'string' ? hexToLinear(color) : color;
    this.g.pass(this.solidProg, { uColor: [c[0] * alpha, c[1] * alpha, c[2] * alpha, alpha] }, alpha < 1 ? 'over' : null);
  }

  // Draw with Canvas2D into a fresh layer and composite it into the current target.
  layer(fn, { blend = 'over', opacity = 1, gain = 1 } = {}) {
    this.paint(fn, this.layerTex);
    this.g.pass(this.layerProg, { uTex: this.layerTex, uOpacity: opacity, uGain: gain }, blend);
  }

  // Draw with Canvas2D into `tex` (8-bit, premultiplied, sRGB) for use in shaders.
  paint(fn, tex) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(1, 0, 0, 1, this.g.jitter[0], this.g.jitter[1]);
    ctx.save();
    fn(ctx);
    ctx.restore();
    this.g.upload(tex, this.c2);
    return tex;
  }

  newTex() { return this.g.texture(W, H, { float: false }); }

  camMatrix() {
    const { x, y, rot, zoom } = this.cam;
    const cx = W / 2, cy = H / 2;
    const c = Math.cos(-rot), s = Math.sin(-rot);
    const iz = 1 / zoom;
    // q = C + R * (px - C) / z - o   (GL pixel space, y up; offsets given y-down)
    const ox = x, oy = -y;
    const a = c * iz, bb = s * iz, cc = -s * iz, d = c * iz;
    const tx = cx - (a * cx + cc * cy) - ox;
    const ty = cy - (bb * cx + d * cy) - oy;
    return [a, bb, 0, cc, d, 0, tx, ty, 1];
  }

  activeScenes(t) {
    return this.scenes.filter((s) => t >= s.start && t < s.end);
  }

  postParams(t) {
    const P = { ...DEFAULT_POST };
    for (const s of this.activeScenes(t)) if (s.post) Object.assign(P, s.post(t, this));
    return P;
  }

  renderAt(t, frame, sub) {
    const g = this.g;
    sub = this.samplesFor(t, sub);
    // Which scene is on screen is decided per frame, so hard cuts never smear
    // across the shutter; the sub-frame time only drives motion inside a scene.
    this.frameT = t;
    const scenes = this.activeScenes(t);
    g.bind(this.acc);
    g.clear(0, 0, 0, 0);
    for (let i = 0; i < sub; i++) {
      const ts = sub > 1 ? t + ((i + 0.5) / sub - 0.5) * SHUTTER / FPS : t;
      g.time = ts;
      g.jitter = sub > 1 ? [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5] : [0, 0];
      this.cam = { x: 0, y: 0, rot: 0, zoom: 1 };
      g.bind(this.scene);
      g.clear(0, 0, 0, 1);
      for (const s of scenes) s.render(ts, this);
      g.bind(this.acc);
      g.pass(this.accumProg, { uScene: this.scene.tex, uWeight: 1 / sub, uCam: this.camMatrix() }, 'add');
    }
    g.jitter = [0, 0];
    drawHud(this.hudCtx, t, frame);
    g.upload(this.hudTex, this.hudCanvas);
    this.post.run(this.acc.tex, this.hudTex, this.postParams(t), frame);
  }

  renderFrame(frame, sub) { this.renderAt(frame / FPS, frame, sub); }

  // Scenes can ask for more temporal samples where motion is extreme.
  samplesFor(t, base) {
    let n = base;
    if (base < 16) return base; // previews keep their cheap sample count
    for (const s of this.activeScenes(t)) if (s.samples) n = Math.max(n, s.samples(t) || 0);
    // footage scenes move little besides their overlays: fewer samples keep renders fast
    for (const s of this.activeScenes(t)) if (s.maxSamples) n = Math.min(n, s.maxSamples(t));
    return n;
  }
}

async function loadFonts() {
  const specs = [
    '900 100px "Archivo"', '400 100px "Archivo"', '100 100px "Archivo"',
    'italic 400 100px "Instrument Serif"', '400 100px "Instrument Serif"',
    '500 100px "JetBrains Mono"', '800 100px "JetBrains Mono"',
    '400 100px "Dela Gothic One"',
    '400 100px "Shippori Mincho B1"', '500 100px "Shippori Mincho B1"', '600 100px "Shippori Mincho B1"',
  ];
  await Promise.all(specs.map((s) => document.fonts.load(s, 'AaZz05動夏の夢朝昼')));
  await document.fonts.ready;
}

async function main() {
  await loadFonts();
  const canvas = document.getElementById('gl');
  const E = new Engine(canvas);
  await E.init();
  const api = {
    renderer: E.g.renderer,
    frames: Math.round(DURATION * FPS),
    fps: FPS,
    async render(frame, sub = 16) { await E.prepare(frame / FPS); E.renderFrame(frame, sub); E.gl.finish(); return true; },
    async still(t, sub = 16) { await E.prepare(t); E.renderAt(t, Math.round(t * FPS), sub); return canvas.toDataURL('image/png'); },
    async send(frame, sub = 16) {
      await E.prepare(frame / FPS);
      E.renderFrame(frame, sub);
      const buf = new Uint8Array(W * H * 4);
      E.gl.readPixels(0, 0, W, H, E.gl.RGBA, E.gl.UNSIGNED_BYTE, buf);
      // A Blob body is handed to the network process by reference: ~10x faster than a typed array.
      const res = await fetch(`/frame?i=${frame}`, { method: 'POST', body: new Blob([buf]) });
      if (!res.ok) throw new Error('frame upload failed ' + res.status);
      return true;
    },
  };
  window.reel = api;
  if (!RENDER) preview(E, canvas);
  window.reelReady = true;
}

function preview(E, canvas) {
  document.body.classList.add('preview');
  const audio = new Audio('../out/audio.wav');
  const sub = +(params.get('sub') || 2);
  let playing = !params.has('pause');
  let t0 = performance.now() / 1000 - (+(params.get('t') || 0));
  let tPaused = +(params.get('t') || 0);
  const info = document.getElementById('info');
  const clock = () => (playing ? (audio.paused || audio.readyState < 2 ? performance.now() / 1000 - t0 : audio.currentTime) : tPaused);
  let busy = false;
  function frame() {
    let t = clock();
    if (t >= DURATION) { t0 = performance.now() / 1000; t = 0; if (!audio.paused) { audio.currentTime = 0; } }
    if (!busy) { busy = true; E.prepare(t).then(() => { busy = false; }); }
    try { E.renderAt(t, Math.floor(t * FPS), sub); } catch (e) { /* footage not resident yet */ }
    if (info) info.textContent = `${t.toFixed(3)}s  ·  space: play/pause  ·  ←/→: ±1 frame  ·  click: sound`;
    requestAnimationFrame(frame);
  }
  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'Space') {
      if (playing) { tPaused = clock(); playing = false; audio.pause(); }
      else { t0 = performance.now() / 1000 - tPaused; playing = true; }
    }
    if (ev.code === 'ArrowRight' || ev.code === 'ArrowLeft') {
      tPaused = Math.max(0, clock() + (ev.code === 'ArrowRight' ? 1 : -1) / FPS);
      playing = false; audio.pause();
    }
  });
  canvas.addEventListener('click', () => {
    t0 = performance.now() / 1000; playing = true;
    audio.currentTime = 0; audio.play().catch(() => {});
  });
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  window.reelError = String(err && err.stack || err);
  const pre = document.createElement('pre');
  pre.style.cssText = 'color:#f66;position:fixed;top:0;left:0;white-space:pre-wrap;font:12px monospace;z-index:9';
  pre.textContent = window.reelError;
  document.body.appendChild(pre);
});
