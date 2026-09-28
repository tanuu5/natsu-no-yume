// Geometry builder: collect boxes / quads / arbitrary geometries per material, with
// UVs in metres (so textures tile at world scale) and per-part vertex colours, then
// merge them into one mesh per material.
//
//   const B = new Builder();
//   B.box(M.wood, { w: 4, h: 3, d: 6, pos: [0, 1.5, 0], rotY: 0.3, color: [1, 0.9, 0.8] });
//   B.geo(M.metal, someBufferGeometry, matrix4, [1, 1, 1]);
//   const group = B.build({ castShadow: true, receiveShadow: true });
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

// Box with metre-based UVs on every face (u along the face's horizontal, v up).
export function boxGeometry(w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d);
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
    let u, v;
    if (Math.abs(ny) > 0.5) { u = x; v = z * Math.sign(ny); }
    else if (Math.abs(nx) > 0.5) { u = -z * Math.sign(nx); v = y; }
    else { u = x * Math.sign(nz); v = y; }
    uv.setXY(i, u, v);
  }
  return g;
}

// Remap any geometry's UVs to metres by projecting along its dominant normal axis.
export function worldUV(g, scale = 1) {
  const pos = g.attributes.position, nor = g.attributes.normal;
  const uv = g.attributes.uv || new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    if (ny >= nx && ny >= nz) uv.setXY(i, x * scale, z * scale);
    else if (nx >= nz) uv.setXY(i, z * scale, y * scale);
    else uv.setXY(i, x * scale, y * scale);
  }
  g.setAttribute('uv', uv);
  return g;
}

function withColor(g, color) {
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = color[0]; c[i * 3 + 1] = color[1]; c[i * 3 + 2] = color[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

function clean(g) {
  // merge needs identical attribute sets: position, normal, uv, color (non-indexed)
  let x = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(x.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) x.deleteAttribute(k);
  if (!x.attributes.normal) x.computeVertexNormals();
  if (!x.attributes.uv) worldUV(x);
  x.morphAttributes = {};
  x.clearGroups();
  return x;
}

export class Builder {
  constructor() { this.parts = new Map(); }

  // Add a geometry (not reused afterwards) transformed by matrix, tinted by color.
  geo(mat, g, matrix = null, color = [1, 1, 1]) {
    let x = clean(g.clone());
    if (matrix) x.applyMatrix4(matrix);
    withColor(x, color);
    if (!this.parts.has(mat)) this.parts.set(mat, []);
    this.parts.get(mat).push(x);
    return this;
  }

  // Transform helper: position, rotation (Y, or [x,y,z] euler), scale.
  static mat({ pos = [0, 0, 0], rotY = 0, rot = null, scale = null } = {}) {
    _e.set(...(rot || [0, rotY, 0]), 'YXZ');
    _q.setFromEuler(_e);
    _p.set(...pos);
    if (scale) _s.set(...(Array.isArray(scale) ? scale : [scale, scale, scale])); else _s.set(1, 1, 1);
    return new THREE.Matrix4().compose(_p, _q, _s);
  }

  box(mat, { w, h, d, pos = [0, 0, 0], rotY = 0, rot = null, color = [1, 1, 1], matrix = null }) {
    const g = boxGeometry(w, h, d);
    const m = Builder.mat({ pos, rotY, rot });
    if (matrix) m.premultiply(matrix);
    return this.geo(mat, g, m, color);
  }

  cyl(mat, { r = 0.1, r2 = null, h = 1, seg = 12, pos = [0, 0, 0], rotY = 0, rot = null, color = [1, 1, 1], matrix = null, open = false }) {
    const g = new THREE.CylinderGeometry(r2 ?? r, r, h, seg, 1, open);
    worldUV(g);
    const m = Builder.mat({ pos, rotY, rot });
    if (matrix) m.premultiply(matrix);
    return this.geo(mat, g, m, color);
  }

  // Quad from four corners (counter-clockwise seen from the front), metre UVs.
  quad(mat, a, b, c, d, { color = [1, 1, 1], uv = null } = {}) {
    const g = new THREE.BufferGeometry();
    const p = new Float32Array([...a, ...b, ...c, ...a, ...c, ...d]);
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    if (uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([...uv[0], ...uv[1], ...uv[2], ...uv[0], ...uv[2], ...uv[3]]), 2));
    g.computeVertexNormals();
    if (!uv) worldUV(g);
    return this.geo(mat, g, null, color);
  }

  isEmpty() { return this.parts.size === 0; }

  build({ castShadow = true, receiveShadow = true, name = 'built' } = {}) {
    const group = new THREE.Group();
    group.name = name;
    for (const [mat, list] of this.parts) {
      const merged = mergeGeometries(list, false);
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = castShadow && mat.userData.castShadow !== false;
      mesh.receiveShadow = receiveShadow;
      mesh.name = `${name}:${mat.name}`;
      group.add(mesh);
    }
    this.parts.clear();
    return group;
  }
}
