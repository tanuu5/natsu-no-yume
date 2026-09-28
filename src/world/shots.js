// The five walks: where the camera goes, what it looks at, and the light of each
// time of day. Times in the keys are seconds from the segment start (they may start
// before 0 and run past the end, to cover the dissolves).
import { sunDir } from './env.js';
import { ground, RAIL, RAIL_H } from './geo.js';
import { polyDist } from './noise.js';

// Rail x at a given z (the track is a polyline running north).
export function railX(z) {
  for (let i = 0; i < RAIL.length - 1; i++) {
    const [ax, az] = RAIL[i], [bx, bz] = RAIL[i + 1];
    if ((z <= az && z >= bz) || (z >= az && z <= bz)) {
      const t = (z - az) / (bz - az || 1);
      return ax + (bx - ax) * t;
    }
  }
  return RAIL[RAIL.length - 1][0];
}

export const ENVS = {
  morning: {
    sun: sunDir(72, 15), sunI: 20, haze: 2.2, mieG: 0.8, night: 0,
    fog: [1 / 1500, 55], fogTint: [1.02, 1.0, 0.97],
    clouds: { cover: 0.3, base: 1400, thick: 1100, dens: 0.9, wind: [0, 0], windV: [6, 2], towers: [[-14000, 16000, 4200, 4200]], cirrus: 0.12, cirrusAlt: 7500, cirrusV: [8, 3] },
    lamps: 0, chop: 0.4, exposure: 0.2, ground: [0.14, 0.16, 0.12], envI: 1.25,
    grade: { wb: [1.02, 1.0, 0.97], sat: 1.25, contrast: 1.08, lift: [0.02, 0.022, 0.03], gain: [1, 1, 1], shadowTint: [0.95, 1.0, 1.06], highTint: [1.04, 1.01, 0.96] },
  },
  noon: {
    sun: sunDir(195, 72), sunI: 20, haze: 1.0, mieG: 0.78, night: 0,
    fog: [1 / 11000, 520], fogTint: [1, 1, 1],
    clouds: { cover: 0.34, base: 1300, thick: 1500, dens: 1.0, wind: [3000, -2000], windV: [8, 3],
      towers: [[-19000, 7000, 5200, 7200], [-15000, -14000, 3800, 5200]], cirrus: 0.05, cirrusAlt: 8000, cirrusV: [10, 4] },
    lamps: 0, chop: 0.6, exposure: 0.19, ground: [0.2, 0.21, 0.17], envI: 1.35,
    grade: { wb: [1.0, 1.0, 1.0], sat: 1.32, contrast: 1.12, lift: [0.012, 0.016, 0.024], gain: [1, 1, 1], shadowTint: [0.95, 1.0, 1.06], highTint: [1.03, 1.01, 0.97] },
  },
  afternoon: {
    sun: sunDir(270, 14), sunI: 20, haze: 1.75, mieG: 0.8, night: 0,
    fog: [1 / 8000, 480], fogTint: [1, 1, 1],
    clouds: { cover: 0.4, base: 1400, thick: 1600, dens: 1.0, wind: [-5000, 4000], windV: [7, 3],
      towers: [[-16000, 12000, 4800, 6800], [-9000, -20000, 5000, 6000]], cirrus: 0.25, cirrusAlt: 8000, cirrusV: [10, 4] },
    lamps: 0, chop: 0.55, exposure: 0.19, ground: [0.18, 0.17, 0.13], envI: 1.3,
    grade: { wb: [1.09, 1.0, 0.88], sat: 1.28, contrast: 1.1, lift: [0.02, 0.018, 0.022], gain: [1, 1, 1], shadowTint: [0.95, 0.99, 1.06], highTint: [1.06, 1.0, 0.92] },
  },
  sunset: {
    sun: sunDir(295, 3.2), sunPath: { t0: -2, t1: 20, from: [294.6, 3.6], to: [296.2, 1.2] },
    sunI: 20, haze: 1.5, mieG: 0.83, night: 0, flare: 1,
    fog: [1 / 6500, 380], fogTint: [1, 1, 1],
    clouds: { cover: 0.16, base: 1700, thick: 900, dens: 0.8, wind: [8000, 1000], windV: [6, 2], towers: [],
      cirrus: 0.62, cirrusAlt: 6500, cirrusV: [9, 3] },
    lamps: 0.5, chop: 0.2, exposure: 0.55, ground: [0.1, 0.09, 0.08], envI: 1.2,
    grade: { wb: [1.05, 1.0, 0.95], sat: 1.2, contrast: 1.1, lift: [0.025, 0.018, 0.03], gain: [1, 1, 1], shadowTint: [0.96, 0.95, 1.08], highTint: [1.06, 1.0, 0.9] },
  },
  night: {
    sun: sunDir(302, -6.5), sunI: 20, haze: 1.2, mieG: 0.8, night: 1, stars: 1,
    fog: [1 / 7000, 400], fogTint: [1, 1, 1],
    clouds: { cover: 0.12, base: 1700, thick: 900, dens: 0.8, wind: [9000, 1200], windV: [5, 2], towers: [],
      cirrus: 0.3, cirrusAlt: 6500, cirrusV: [9, 3] },
    lamps: 1, chop: 0.3, exposure: 6.0, ground: [0.03, 0.04, 0.05],
    grade: { wb: [0.95, 1.0, 1.08], sat: 1.0, contrast: 1.05, lift: [0.01, 0.014, 0.03], gain: [1, 1, 1], shadowTint: [0.95, 1.0, 1.1], highTint: [1.05, 1.0, 0.95] },
  },
};

// Camera walks. p: position (y = null -> ground + eye), look: target point.
export const WALKS = {
  morning: {
    // opening: hovering over the water of a terrace, then rising onto the levee and
    // walking along it with the terraces, the village and the sea on the right
    terrain: { cx: 340, cz: -235, s0: 0.4, levels: 9 },
    fov: 50, eye: 1.55, paddyPlane: 36.02, steps: 1.55,
    keys: [
      { t: -1, p: [344.6, 36.2, -259.9], look: [262, 35.2, -120], focus: 2.2, aperture: 0.012, walk: 0, fov: 44, roll: 0.01 },
      { t: 3.2, p: [345.1, 36.26, -260.4], look: [260, 35.4, -118], focus: 3.0, aperture: 0.01, walk: 0, fov: 44 },
      { t: 7.2, p: [348.4, 39.0, -262.3], look: [258, 29, -95], focus: 60, aperture: 0.002, walk: 0.4, fov: 50, roll: 0 },
      { t: 11, p: [352.4, 39.0, -261.6], look: [250, 27, -70], walk: 1 },
      { t: 15, p: [356.9, 39.0, -258.9], look: [240, 25, -48] },
      { t: 19, p: [357.9, 39.0, -253.2], look: [228, 23, -30] },
      { t: 23, p: [358.2, 39.0, -247.2], look: [214, 21, -14] },
      { t: 27, p: [360.6, 39.0, -241.6], look: [200, 19, 2] },
    ],
  },
  noon: {
    terrain: { cx: 250, cz: -10, s0: 0.5, levels: 8 },
    fov: 50, eye: 1.58, steps: 1.7,
    keys: [
      { t: -1.5, p: [247.5, null, -5.2], look: [118, 6.5, 3] },
      { t: 11, p: [232.0, null, -3.9], look: [110, 4.0, 4] },
      { t: 23, p: [216.0, null, -2.6], look: [104, 2.5, 6] },
    ],
  },
  afternoon: {
    // on the platform: the train slides in from behind on the right, stops, leaves
    terrain: { cx: railX(-900) + 20, cz: -880, s0: 0.5, levels: 8 },
    fov: 50, eye: 1.55, steps: 1.35,
    keys: [
      { t: -1.5, p: [railX(-927) + 3.1, RAIL_H + 0.92 + 1.55, -927], look: [railX(-700) + 4, RAIL_H + 2.5, -700], walk: 1 },
      { t: 2.0, p: [railX(-925) + 3.2, RAIL_H + 0.92 + 1.55, -925], look: [railX(-760) - 2, RAIL_H + 2.0, -760], walk: 0.4 },
      { t: 5.0, p: [railX(-924) + 3.2, RAIL_H + 0.92 + 1.55, -924], look: [railX(-820) - 1, RAIL_H + 1.9, -820], walk: 0 },
      { t: 12.0, p: [railX(-921) + 3.1, RAIL_H + 0.92 + 1.55, -921], look: [railX(-780) - 3, RAIL_H + 2.0, -780], walk: 0.5 },
      { t: 17.0, p: [railX(-915) + 3.0, RAIL_H + 0.92 + 1.55, -915], look: [railX(-600) - 12, RAIL_H + 3.0, -600], walk: 1 },
      { t: 22.5, p: [railX(-909) + 2.9, RAIL_H + 0.92 + 1.55, -909], look: [railX(-520) - 30, RAIL_H + 3.5, -520], walk: 1 },
    ],
  },
  sunset: {
    // along the east quay, the pier's boats and the harbour mouth ahead
    terrain: { cx: 60, cz: -60, s0: 0.5, levels: 8 },
    fov: 50, eye: 1.55, steps: 1.45,
    keys: [
      { t: -1.5, p: [130.6, 3.95, -28.0], look: [-300, -8, -150] },
      { t: 5, p: [128.2, 3.95, -39.0], look: [-300, -6, -160] },
      { t: 11, p: [124.8, 3.95, -50.0], look: [-300, -3, -172] },
      { t: 17, p: [120.5, 3.95, -61.0], look: [-300, 0, -182] },
      { t: 21, p: [118.3, 3.95, -66.0], look: [-300, 2, -186] },
    ],
  },
  night: {
    terrain: { cx: 340, cz: -235, s0: 0.4, levels: 9 },
    fov: 50, eye: 1.55, paddyPlane: 34.82, steps: 1.3,
    keys: [
      { t: -1.5, p: [331.9, 37.8, -246.4], look: [150, 12, -30], walk: 1 },
      { t: 5, p: [335.5, 37.8, -241.2], look: [140, 14, -20] },
      { t: 10, p: [339.8, 37.8, -236.9], look: [120, 18, -10], walk: 0.3 },
      { t: 13.5, p: [341.2, 37.8, -235.4], look: [110, 22, -8], walk: 0 },
    ],
  },
};

// Catmull-Rom through the keys (by time), returns {p:[x,y,z], look:[x,y,z]}.
function cr(p0, p1, p2, p3, u) {
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}
function sampleKeys(keys, t, field) {
  if (t <= keys[0].t) return keys[0][field].slice();
  const n = keys.length;
  if (t >= keys[n - 1].t) return keys[n - 1][field].slice();
  let i = 0;
  while (i < n - 2 && t > keys[i + 1].t) i++;
  const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(n - 1, i + 2)];
  const u = (t - k1.t) / (k2.t - k1.t);
  return [0, 1, 2].map((c) => {
    const a = k0[field][c], b = k1[field][c], d = k2[field][c], e = k3[field][c];
    if (b === null || d === null) return null;
    return cr(a ?? b, b, d, e ?? d, u);
  });
}

// Scalar key fields (fov, focus, aperture, roll) interpolate linearly; missing = default.
function sampleScalar(keys, t, field, def) {
  const ks = keys.filter((k) => k[field] !== undefined);
  if (!ks.length) return def;
  if (t <= ks[0].t) return ks[0][field];
  for (let i = 0; i < ks.length - 1; i++) {
    if (t <= ks[i + 1].t) {
      const u = (t - ks[i].t) / (ks[i + 1].t - ks[i].t);
      const e = u * u * (3 - 2 * u);
      return ks[i][field] + (ks[i + 1][field] - ks[i][field]) * e;
    }
  }
  return ks[ks.length - 1][field];
}

// smooth 1D noise for the hand-held drift
function drift(t, seed) {
  let s = 0, a = 1, f = 1;
  for (let i = 0; i < 3; i++) {
    s += a * Math.sin(t * f * 0.9 + seed * 7.3 + i * 1.7) * Math.sin(t * f * 0.37 + seed * 3.1 + i);
    a *= 0.5; f *= 2.1;
  }
  return s;
}

export function cameraAt(walk, t) {
  const p = sampleKeys(walk.keys, t, 'p');
  const look = sampleKeys(walk.keys, t, 'look');
  if (p[1] === null) p[1] = Math.max(ground(p[0], p[2]), 0.5) + walk.eye;
  // walking: a soft bob on each step, a sway every other step, a slow hand-held drift
  const walking = sampleScalar(walk.keys, t, 'walk', 1);
  const steps = walk.steps || 1.6;           // steps per second
  const ph = t * steps * Math.PI;
  p[1] += walking * (0.014 * (Math.abs(Math.sin(ph)) - 0.64));
  const sway = walking * 0.008 * Math.sin(ph * 0.5);
  const dx = look[0] - p[0], dz = look[2] - p[2], dl = Math.hypot(dx, dz) || 1;
  p[0] += (-dz / dl) * sway; p[2] += (dx / dl) * sway;
  const hand = walk.hand ?? 1;
  const d = Math.hypot(look[0] - p[0], look[1] - p[1], look[2] - p[2]);
  look[0] += drift(t, 1) * 0.0035 * d * hand;
  look[1] += (drift(t, 2) * 0.0028 + walking * 0.002 * Math.sin(ph + 0.6)) * d * hand;
  look[2] += drift(t, 3) * 0.0035 * d * hand;
  const roll = sampleScalar(walk.keys, t, 'roll', 0) + walking * 0.0025 * Math.sin(ph * 0.5 + 0.4) + drift(t, 4) * 0.002 * hand;
  return {
    p, look, roll,
    fov: sampleScalar(walk.keys, t, 'fov', walk.fov),
    focus: sampleScalar(walk.keys, t, 'focus', walk.focus || 30),
    aperture: sampleScalar(walk.keys, t, 'aperture', walk.aperture || 0.0),
  };
}

export { polyDist };
