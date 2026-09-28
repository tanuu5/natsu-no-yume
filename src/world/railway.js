// The coastal railway: seawall and parapet on the sea side, the track (from the
// train family when available), the station and the moving train.
import * as THREE from 'three';
import { Builder } from './builder.js';
import { materials } from './lib.js';
import { RAIL_H, railXAt, SEAWALL_OFF, STATION, STATION_BED, groundNatural, ground } from './geo.js';
import { smoothstep } from './noise.js';
import { rng } from './noise.js';

export const RAIL_Z0 = -300, RAIL_Z1 = -1620;

// Track centreline as 3D points (rail-top height), north (-z) end last.
export function trackPoints(step = 10) {
  const pts = [];
  for (let z = RAIL_Z0; z >= RAIL_Z1; z -= step) pts.push([railXAt(z), RAIL_H, z]);
  return pts;
}

// Position + heading on the track at arc position s (metres from the south end).
export function trackAt(s) {
  // the line is almost straight in x; integrate along z
  let z = RAIL_Z0, acc = 0;
  const dz = 1;
  let x0 = railXAt(z);
  while (acc < s && z > RAIL_Z1) {
    const x1 = railXAt(z - dz);
    acc += Math.hypot(x1 - x0, dz);
    z -= dz; x0 = x1;
  }
  const x1 = railXAt(z - 0.5), xm = railXAt(z + 0.5);
  const heading = Math.atan2(x1 - xm, -1);   // rotation.y so that local +z points north (-z)
  return { x: x0, y: RAIL_H, z, rotY: heading };
}

// Concrete retaining wall (擁壁) at the inland edge of the rail bed near the station:
// the cut slope rises behind it.
export function buildCutWall() {
  const M = materials();
  const B = new Builder();
  const R = rng(62);
  for (let z = -800; z > -1040; z -= 3) {
    const za = z, zb = z - 3;
    const at = (zz) => smoothstep(STATION.z0 - 30, STATION.z0 - 10, zz) * (1 - smoothstep(STATION.z1 + 10, STATION.z1 + 30, zz));
    const off = (zz) => 4.5 + STATION_BED * at(zz) + 0.6;
    const xa = railXAt(za) + off(za), xb = railXAt(zb) + off(zb);
    const cx = (xa + xb) / 2, cz = (za + zb) / 2;
    const len = Math.hypot(xb - xa, zb - za) + 0.03;
    const rotY = Math.atan2(xb - xa, zb - za);
    const bed = RAIL_H - 0.75;
    const top = Math.max(bed + 1.2, Math.min(bed + 3.2, ground(cx + 2.5, cz) - 0.2));
    const tone = 0.8 + 0.12 * R();
    B.box(M.concrete, { w: 0.5, h: top - bed + 0.6, d: len, pos: [cx + 0.25, (top + bed - 0.6) / 2, cz], rotY, color: [tone, tone, tone * 0.96] });
    B.box(M.concrete, { w: 0.62, h: 0.16, d: len, pos: [cx + 0.25, top + 0.08, cz], rotY, color: [tone * 0.9, tone * 0.9, tone * 0.87] });
  }
  return B.build({ name: 'cutwall' });
}

export function buildSeawall() {
  const M = materials();
  const B = new Builder();
  const R = rng(61);
  for (let z = RAIL_Z0; z > RAIL_Z1; z -= 4) {
    const za = z, zb = z - 4;
    const xa = railXAt(za) + SEAWALL_OFF, xb = railXAt(zb) + SEAWALL_OFF;
    const cx = (xa + xb) / 2, cz = (za + zb) / 2;
    const len = Math.hypot(xb - xa, zb - za) + 0.04;
    const rotY = Math.atan2(xb - xa, zb - za);          // local z along the wall
    const tone = 0.86 + 0.14 * R();
    const top = RAIL_H - 0.75 + 0.95;
    // face down to the shore, a darker tidal foot, a parapet on top
    B.box(M.concrete, { w: 0.9, h: top + 1.5, d: len, pos: [cx - 0.45, (top - 1.5) / 2, cz], rotY, color: [tone, tone, tone * 0.97] });
    B.box(M.concrete, { w: 1.3, h: 2.2, d: len, pos: [cx - 0.75, -0.6, cz], rotY, color: [0.55 * tone, 0.56 * tone, 0.52 * tone] });
  }
  return B.build({ name: 'seawall' });
}

// ---------------------------------------------------------------------------
// Track, station and the train (from the train family). update(t) takes the global
// film time: the train comes in from the north, stops at the platform, and leaves
// south along the coast (see EV in timeline.js).
// ---------------------------------------------------------------------------
import { EV } from '../timeline.js';

export const STATION_Z = (STATION.z0 + STATION.z1) / 2;

export function populateRailway(MODELS, FAMILY) {
  const group = new THREE.Group();
  group.name = 'railway';
  const T = FAMILY.train;
  if (!T) return { group, update() {} };
  // the path runs from the tunnel (south) to the north; s grows northward
  const pts = trackPoints(8);
  const path = T.trackPath(pts);
  group.add(T.buildTrack(pts, {}));
  // station
  if (MODELS.station) {
    const s0 = arcAtZ(path, STATION_Z);
    let st = MODELS.station({});
    if (T.fitToTrack) st = T.fitToTrack(st, path, s0, { reverse: true }) || st;
    else {
      const a = path.at(s0);
      st.position.copy(a.p);
      st.rotation.y = Math.atan2(a.t.x, a.t.z) + Math.PI;   // local +z toward south (-t)
    }
    group.add(st);
    group.userData.station = st;
  }
  let train = null;
  if (MODELS.train) {
    train = MODELS.train({ dir: 1, lights: 1 });
    group.add(train);
  }
  const sStop = arcAtZ(path, STATION_Z) - 6;
  const tA = EV.trainArrive - 2, tS = EV.trainStop, tD = EV.trainDepart;
  const v0 = 12, brake = tS - tA, dBrake = (v0 * brake) / 2;
  const trainS = (t) => {
    if (t < tA) return sStop + dBrake + v0 * (tA - t);                // cruising in from the north
    if (t < tS) { const u = (t - tA) / brake; return sStop + dBrake * (1 - u) * (1 - u); }
    if (t < tD) return sStop;
    const u = t - tD, acc = 1.5, tMax = v0 / acc;
    return u < tMax ? sStop - 0.5 * acc * u * u : sStop - 0.5 * acc * tMax * tMax - v0 * (u - tMax);
  };
  const update = (t) => {
    if (!train) return;
    const s = trainS(t);
    train.visible = s > 5 && s < path.length - 5;
    if (train.visible) T.placeOnTrack(train, path, s, { reverse: true });
    // platform-side doors open after the stop and close before leaving
    if (train.userData.setDoors) {
      const k = Math.min(1, Math.max(0, (t - (tS + 0.9)) / 1.1)) * Math.min(1, Math.max(0, (tD - 1.0 - t) / 1.1));
      train.userData.setDoors(k, 1);
    }
  };
  return { group, update, path, trainS, sStop };
}

// arc length on the path closest to world z (the line runs along z)
function arcAtZ(path, z) {
  let lo = 0, hi = path.length;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (path.at(mid).p.z > z) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
