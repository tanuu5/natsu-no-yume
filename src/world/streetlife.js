// Street furniture: utility-pole lines (with all their wires) along the slope street,
// the quay road and the railway, plus the small things of a lived-in street — a
// vending machine, a curve mirror, bicycles, laundry, post boxes.
import * as THREE from 'three';
import { STREET_PROFILE, streetHeight, STREET_W, COVE, QUAY_H, ground, railXAt, RAIL_H, STATION } from './geo.js';
import { rng } from './noise.js';

export function populateStreets(MODELS, FAMILY, lots) {
  const group = new THREE.Group();
  group.name = 'streetlife';
  const P = FAMILY.props;
  const R = rng(4411);
  const SP = STREET_PROFILE;
  const half = STREET_W / 2;
  const onStreet = (s, side, off) => {
    const [x0, z0] = SP.at(s - 0.5), [x1, z1] = SP.at(s + 0.5);
    const tx = x1 - x0, tz = z1 - z0, tl = Math.hypot(tx, tz) || 1;
    const nx = -tz / tl * side, nz = tx / tl * side;
    const [x, z] = SP.at(s);
    return { x: x + nx * off, z: z + nz * off, y: streetHeight(s), rotY: Math.atan2(tx, tz), nx, nz };
  };
  if (P && P.poleLine) {
    // the slope street: poles on the south side every ~30 m
    const pts = [];
    for (let s = 14; s < SP.total - 8; s += 27 + R() * 8) {
      const p = onStreet(s, -1, half + 0.62);
      pts.push([p.x, p.y - 0.05, p.z]);
    }
    group.add(P.poleLine(pts, { side: 1, seed: 3, each: (i) => ({ transformer: i % 3 === 1, light: i % 2 === 0, sleeve: i % 4 === 2, ad: i % 3 === 0 }) }));
    // the quay road
    const qp = [];
    for (let a = -0.95; a < 1.1; a += 0.2) {
      const r = COVE.r + 11.5;
      const x = COVE.x + Math.cos(a) * r, z = COVE.z + Math.sin(a) * r;
      qp.push([x, Math.max(ground(x, z), QUAY_H), z]);
    }
    group.add(P.poleLine(qp, { side: 1, seed: 8, each: (i) => ({ light: true, transformer: i % 4 === 2 }) }));
    // along the railway past the station (east side of the track)
    const rp = [];
    for (let z = -700; z > -1200; z -= 34) {
      const x = railXAt(z) + 6.4;
      rp.push([x, RAIL_H - 0.75, z]);
    }
    group.add(P.poleLine(rp, { side: -1, seed: 12, each: () => ({ light: false }) }));
  }
  // small things along the street near the noon walk
  const put = (name, p, o = {}, rot = 0) => {
    if (!MODELS[name]) return null;
    let m;
    try { m = MODELS[name]({ seed: R.int(1, 999), ...o }); } catch (e) { console.warn(name, e.message); return null; }
    m.position.set(p.x, p.y, p.z);
    m.rotation.y = p.rotY + rot;
    group.add(m);
    return m;
  };
  put('vending', { ...onStreet(206, 1, half + 1.05), y: streetHeight(206) }, { color: 'white' }, Math.PI);
  put('curveMirror', { ...onStreet(252, -1, half + 0.7) }, {}, Math.PI);
  put('bicycle', { ...onStreet(223, 1, half + 1.2) }, {}, Math.PI / 2);
  put('postBox', { ...onStreet(275, -1, half + 1.0) }, {}, 0);
  put('signPole', { ...onStreet(190, -1, half + 0.7) }, {}, 0);
  return group;
}
