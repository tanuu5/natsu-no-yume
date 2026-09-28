// CPU port of the atmosphere in glsl.js, for the sun's light colour and the ambient
// estimates that drive the lights and the water (must match the shader constants).
const PR = 6360000, AR = 6440000;
const BR = [5.802e-6, 13.558e-6, 33.1e-6];
const BM = 3.996e-6, EM = 4.44e-6;
const BO = [0.650e-6, 1.881e-6, 0.085e-6];

function raySph(ro, rd, r) {
  const b = ro[0] * rd[0] + ro[1] * rd[1] + ro[2] * rd[2];
  const c = ro[0] * ro[0] + ro[1] * ro[1] + ro[2] * ro[2] - r * r;
  const d = b * b - c;
  if (d < 0) return [1e12, -1e12];
  const s = Math.sqrt(d);
  return [-b - s, -b + s];
}
function dens(h, haze) {
  h = Math.max(h, 0);
  return [Math.exp(-h / 8000), Math.exp(-h / 1200) * haze, Math.max(0, 1 - Math.abs(h - 25000) / 15000)];
}
function ext(od) {
  return [0, 1, 2].map((i) => BR[i] * od[0] + EM * od[1] + BO[i] * od[2]);
}

// Transmittance from altitude y (m) towards the sun.
export function sunTrans(y, sun, haze = 1) {
  const p = [0, PR + y, 0];
  const r = PR + y;
  const mu = sun.y;
  const muH = -Math.sqrt(Math.max(0, 1 - (PR * PR) / (r * r)));
  const t = Math.min(1, Math.max(0, (mu - (muH - 0.006)) / 0.01));
  const vis = t * t * (3 - 2 * t);
  if (vis <= 0) return [0, 0, 0];
  const L = Math.max(raySph(p, [sun.x, sun.y, sun.z], AR)[1], 0);
  const od = [0, 0, 0];
  const dt = L / 24;
  for (let i = 0; i < 24; i++) {
    const s = (i + 0.5) * dt;
    const q = [sun.x * s, PR + y + sun.y * s, sun.z * s];
    const d = dens(Math.hypot(q[0], q[1], q[2]) - PR, haze);
    od[0] += d[0] * dt; od[1] += d[1] * dt; od[2] += d[2] * dt;
  }
  return ext(od).map((e) => Math.exp(-e) * vis);
}
