// The geography of the town, as plain functions of (x, z) so the same numbers drive
// the terrain mesh, the placement of every house and pole, and the camera paths.
//
// Axes: x = east, y = up (metres above the sea), z = south. The sea is to the west.
// A west-facing cove holds the harbour; the village climbs the slope east of it; the
// rice terraces sit on the hillside north-east of the village; the railway runs along
// the coast north of the northern headland, where the little station is.
import { perlin, fbm, ridged, smoothstep, clamp, lerp, smin, segDist, polyDist } from './noise.js';

export const QUAY_H = 2.2;
export const COVE = { x: -20, z: 0, r: 150 };
// Headlands: bent crests (x, z) from the root to the tip, with half-widths and crest heights.
export const HEAD_N = { pts: [[112, -254], [50, -238], [-60, -262], [-180, -300], [-300, -318], [-352, -306]], w: [82, 78, 66, 52, 40, 26], h: [54, 66, 60, 48, 34, 14] };
export const HEAD_S = { pts: [[140, 262], [50, 238], [-60, 250], [-170, 286], [-262, 300], [-300, 288]], w: [85, 70, 58, 46, 34, 20], h: [80, 66, 52, 40, 28, 10] };
export const ISLET = { x: -430, z: 40, r: 30, h: 17 };
// Islands out in the bay (x, z, radius, height). Far ones are built as separate meshes.
export const ISLANDS = [
  { x: -1150, z: -760, r: 170, h: 85, seed: 1 },
  { x: -1850, z: 520, r: 290, h: 130, seed: 2 },
  { x: -3300, z: -1700, r: 520, h: 190, seed: 3 },
  { x: -5200, z: 1400, r: 800, h: 260, seed: 4 },
  { x: -2600, z: -3900, r: 600, h: 230, seed: 5 },
];

// Harbour works: the quay follows the cove's shore on the village side; two
// breakwaters reach out from the headlands; an inner pier runs north-south.
export const QUAY = { a0: -1.25, a1: 1.3 };            // arc of the cove shore (radians from +x)
export const BREAKWATERS = [
  { id: 'north', pts: [[-92, -212], [-152, -136], [-190, -44]], w: 5.5, h: 3.4, light: 'white' },
  { id: 'south', pts: [[-98, 216], [-158, 134], [-186, 46]], w: 5.5, h: 3.4, light: 'red' },
  { id: 'pier', pts: [[58, -131], [58, -48]], w: 7, h: 2.2, light: null },
];

// The slope street, from the top of the village down to the harbour.
export const STREET = [[478, -36], [410, -26], [340, -15], [272, -7], [212, -2], [165, 0], [138, 0]];
export const STREET_W = 4.2;
// A quay road around the harbour (just inside the shoreline).
export const QUAY_ROAD_R = COVE.r + 7;

// Railway along the northern coast (x, z) from the headland tunnel north past the station.
export const RAIL = [];  // filled below: follows the coast ~16 m inland
export const RAIL_H = 7.2;
export const STATION = { z0: -930, z1: -884, side: 1 }; // platform on the land (east) side

// Rice terraces on the hillside north-east of the village.
export const PADDY = { cx: 335, cz: -232, rx: 115, rz: 72 };

function coastX(z) {
  // a long gentle bay north of the headland (the railway follows it) and points further out
  const bay = -70 * Math.exp(-(((z + 760) / 330) ** 2)) + 90 * Math.exp(-(((z + 1380) / 190) ** 2)) + 60 * Math.exp(-(((z - 650) / 220) ** 2));
  return -60 + bay + 40 * perlin(z / 520, 3.7) + 16 * perlin(z / 150, 1.3) + 5 * perlin(z / 45, 7.1);
}

// Distance to a headland crest, the (0..1) position along it, and the interpolated
// half-width / crest height there.
function headland(x, z, H) {
  const q = polyDist(x, z, H.pts);
  const n = H.pts.length - 1;
  const u = (q.i + q.t) / n;
  const k = q.i, f = q.t;
  const w = lerp(H.w[k], H.w[k + 1], f) * (1 + 0.18 * perlin(x / 70, z / 70));
  const h = lerp(H.h[k], H.h[k + 1], f) * (1 + 0.22 * perlin(x / 90 + 4, z / 90));
  return { d: q.d, u, w, h };
}

// Signed distance to the shoreline (negative on land).
export function sdLand(x, z) {
  let d = coastX(z) - x;
  const rc = Math.hypot(x - COVE.x, z - COVE.z);
  d = Math.max(d, COVE.r - rc);
  const hn = headland(x, z, HEAD_N), hs = headland(x, z, HEAD_S);
  d = smin(d, hn.d - hn.w, 34);
  d = smin(d, hs.d - hs.w, 34);
  d = Math.min(d, Math.hypot(x - ISLET.x, z - ISLET.z) - ISLET.r * (1 + 0.25 * perlin(x / 12, z / 12)));
  // a wiggly natural shore, but keep the harbour shore (a built quay) clean
  const quay = smoothstep(30, 8, Math.abs(rc - COVE.r)) * smoothstep(-60, 10, x);
  const wig = 11 * perlin(x / 60, z / 60) + 5 * perlin(x / 23, z / 23) + 2 * perlin(x / 8, z / 8);
  return d + wig * (1 - quay);
}

// Ground height before roads are cut in (no trees). Negative = sea bed.
export function groundNatural(x, z) {
  const sd = sdLand(x, z);
  const rc = Math.hypot(x - COVE.x, z - COVE.z);
  if (sd > 0) {
    // sea bed: shelves off quickly near the shore, deeper out in the bay
    const harbour = rc < COVE.r + 20 && x > -150;
    const shelf = harbour ? 3.2 + sd * 0.025 : 0.6 + sd * 0.1;
    return -Math.min(32, shelf) + 0.7 * perlin(x / 40, z / 40) * smoothstep(0, 20, sd);
  }
  const di = -sd;
  const village = villageMask(x, z);
  const gentle = gentleMask(x, z);
  // coastal ramp (quay height in the harbour)
  let h = QUAY_H * smoothstep(0, 4, di);
  // mainland: rises fast from the shore, gentler on the village slope and the terraces
  const A = lerp(128, 56, gentle), L = lerp(210, 400, gentle);
  h += A * (1 - Math.exp(-Math.max(0, di - 6) / L));
  // mountains behind the village (east)
  const inland = smoothstep(420, 1000, x + 0.2 * Math.abs(z));
  h += inland * (170 * ridged(x / 950 + 3.1, z / 950 - 1.7, 5) + 30);
  // headlands: a crest that falls towards the tip, steep sides
  for (const H of [HEAD_N, HEAD_S]) {
    const q = headland(x, z, H);
    const c = Math.max(0, 1 - (q.d / (q.w * 1.08)) ** 2);
    const hh = q.h * Math.pow(c, 0.75) * smoothstep(0, 10, di);
    h = Math.max(h, hh + (h - hh) * 0.15 * (h > hh ? 1 : 0));
  }
  // the islet: a rocky lump
  const d2 = Math.hypot(x - ISLET.x, z - ISLET.z);
  if (d2 < ISLET.r + 8) h = Math.max(h, ISLET.h * Math.pow(Math.max(0, 1 - (d2 / (ISLET.r * 1.05)) ** 2), 0.7) * (1 + 0.15 * perlin(x / 9, z / 9)) * smoothstep(0, 3, di));
  // hills breathe; the village slope stays gentle
  h += (1 - 0.85 * village) * (10 * fbm(x / 240, z / 240, 4) + 3.5 * fbm(x / 55, z / 55, 3)) * smoothstep(0, 30, di);
  // coastal cliffs outside the harbour
  const open = (1 - village) * smoothstep(COVE.r + 5, COVE.r + 60, rc);
  h += open * 7 * smoothstep(0, 12, di);
  return h;
}

// The gentle slope that holds the village and the terraces above it.
export function gentleMask(x, z) {
  const dx = (x - 310) / 250, dz = (z + 45) / 300;
  const r = Math.hypot(dx, dz) + 0.1 * perlin(x / 110, z / 110);
  return smoothstep(1.2, 0.75, r) * smoothstep(80, 135, x);
}

// 1 inside the village (gentle, built-up slope east of the harbour), 0 outside.
export function villageMask(x, z) {
  const dx = (x - 290) / 235, dz = (z - 5) / 205;
  const r = Math.hypot(dx, dz) + 0.12 * perlin(x / 90, z / 90);
  return smoothstep(1.25, 0.8, r) * smoothstep(90, 140, x);
}

// Forest cover: 1 = full canopy. Clear in the village, on the terraces, near the sea.
export function forestMask(x, z, h) {
  const sd = sdLand(x, z);
  let f = smoothstep(-6, -30, sd);                      // not right at the shore
  f *= smoothstep(0.55, 0.15, villageMask(x, z));
  f *= smoothstep(1.15, 1.55, paddyR(x, z));            // open fields around the terraces
  f *= smoothstep(-0.2, 0.25, fbm(x / 140, z / 140, 3) + 0.25);  // clearings
  return f * smoothstep(13, 30, railDist(x, z));
}

function paddyR(x, z) {
  const dx = (x - PADDY.cx) / PADDY.rx, dz = (z - PADDY.cz) / PADDY.rz;
  return Math.hypot(dx, dz) + 0.22 * perlin(x / 60, z / 60) + 0.08 * perlin(x / 17, z / 17);
}
export function paddyMask(x, z) {
  return smoothstep(1.0, 0.85, paddyR(x, z));
}

export function railDist(x, z) {
  return polyDist(x, z, RAIL).d;
}

export function streetInfo(x, z) {
  return polyDist(x, z, STREET);
}

// The railway: a smooth line ~16 m inland of the northern coast.
(function buildRail() {
  for (let z = -300; z >= -1600; z -= 20) {
    let x = 0;
    // average the coast over +-60 m so the track curves gently
    let n = 0;
    for (let k = -3; k <= 3; k++) { x += coastX(z + k * 20); n++; }
    RAIL.push([x / n + 17, z]);
  }
})();

// ---- the slope street: a smoothed height profile along the polyline ----
export const STREET_PROFILE = (() => {
  const pts = STREET;
  const segs = [];
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    segs.push({ a: pts[i], b: pts[i + 1], s0: acc, len });
    acc += len;
  }
  const total = acc;
  const step = 2;
  const n = Math.ceil(total / step) + 1;
  const at = (s) => {
    s = Math.max(0, Math.min(total, s));
    const g = segs.find((q) => s <= q.s0 + q.len) || segs[segs.length - 1];
    const t = (s - g.s0) / g.len;
    return [g.a[0] + (g.b[0] - g.a[0]) * t, g.a[1] + (g.b[1] - g.a[1]) * t];
  };
  const raw = [];
  for (let i = 0; i < n; i++) { const [x, z] = at(i * step); raw.push(groundNatural(x, z)); }
  // smooth (moving average over ~24 m), then make it descend monotonically
  const sm = raw.map((_, i) => {
    let a = 0, c = 0;
    for (let k = -6; k <= 6; k++) { const j = Math.max(0, Math.min(n - 1, i + k)); a += raw[j]; c++; }
    return a / c;
  });
  for (let i = 1; i < n; i++) sm[i] = Math.min(sm[i], sm[i - 1] - 0.02);
  sm[n - 1] = Math.max(sm[n - 1], QUAY_H + 0.05);
  for (let i = n - 2; i >= 0; i--) sm[i] = Math.max(sm[i], sm[i + 1] + 0.02);
  return { total, step, h: sm, at };
})();
export function streetHeight(s) {
  const P = STREET_PROFILE;
  const f = Math.max(0, Math.min(P.h.length - 1.001, s / P.step));
  const i = Math.floor(f), t = f - i;
  return P.h[i] + (P.h[i + 1] - P.h[i]) * t;
}

// ---- rice terraces: the natural slope quantised into level steps ----
export const PADDY_STEP = 1.2;
export const PADDY_BOX = { x0: 212, x1: 458, z0: -312, z1: -152 };
// Terrace floor: the step happens a little uphill of the contour, so the levee ribbon
// laid on the contour covers the mesh's stair-stepped edge.
export function paddyLevel(h) { return Math.floor((h - 0.05) / PADDY_STEP); }
export function paddyTerrain(x, z, g) {
  const m = paddyMask(x, z);
  if (m <= 0) return g;
  const e = 0.6;
  const gx = (groundNatural(x + e, z) - groundNatural(x - e, z)) / (2 * e), gz = (groundNatural(x, z + e) - groundNatural(x, z - e)) / (2 * e);
  const grad = Math.hypot(gx, gz);
  const k = Math.floor((g - 0.3 * grad) / PADDY_STEP);
  const floor = k * PADDY_STEP - 0.06;
  return g + (floor - g) * smoothstep(0.25, 0.55, m);
}

// Rail line: x of the track at z (the line runs north-south), -1 if out of range.
export function railXAt(z) {
  const R = RAIL;
  if (z > R[0][1] || z < R[R.length - 1][1]) return null;
  const f = (R[0][1] - z) / 20;
  const i = Math.min(R.length - 2, Math.floor(f)), t = f - i;
  // Catmull-Rom for a smooth track
  const P = (k) => R[Math.max(0, Math.min(R.length - 1, k))][0];
  const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}
export const SEAWALL_OFF = -5.2;          // seawall face, metres west of the track centre
export const STATION_BED = 7.5;           // extra bed width east of the track at the station

// Ground height with the street cut in (no trees). Negative = sea bed.
export function ground(x, z) {
  let g = groundNatural(x, z);
  // the railway ledge: a level bed, a seawall on the sea side, a cut slope inland
  if (z < -290 && z > -1640) {
    const rx = railXAt(z);
    if (rx !== null) {
      const o = x - rx;
      const bedH = RAIL_H - 0.75;
      const atStation = smoothstep(STATION.z0 - 30, STATION.z0 - 10, z) * (1 - smoothstep(STATION.z1 + 10, STATION.z1 + 30, z));
      const east = 4.5 + STATION_BED * atStation;
      if (o > SEAWALL_OFF - 0.6 && o < east + 26) {
        const w = o < east ? 1 : smoothstep(east + 26, east, o);
        g = g + (bedH - g) * w;
      } else if (o <= SEAWALL_OFF - 0.6 && o > SEAWALL_OFF - 14) {
        // below the seawall: rocky shore, never above the wall's foot
        g = Math.min(g, 0.8 + (o - SEAWALL_OFF) * 0.08);
      }
    }
  }
  if (x > PADDY_BOX.x0 - 20 && x < PADDY_BOX.x1 + 20 && z > PADDY_BOX.z0 - 20 && z < PADDY_BOX.z1 + 20) g = paddyTerrain(x, z, g);
  const q = polyDist(x, z, STREET);
  const half = STREET_W / 2;
  if (q.d > half + 5) return g;
  const hs = streetHeight(q.s) - 0.08;
  const w = smoothstep(half + 5, half + 0.6, q.d);
  return g + (hs - g) * w;
}
