// Registry of procedural models for the model viewer (?view=model&model=NAME) and the
// world. Each entry: (opts) => THREE.Object3D, built at the origin, +y up, sitting on
// y = 0 (boats: waterline at y = 0). One file per model family; each exports MODELS
// (and may export helper functions, reachable as FAMILY.<file>.<fn>).
// Families are imported dynamically so a broken file only removes its own models.
import { Builder } from '../builder.js';
import { materials } from '../lib.js';

export const FAMILY = {};
export const MODELS = {
  // smoke test: a material swatch wall
  swatches() {
    const M = materials();
    const B = new Builder();
    const names = ['woodV', 'woodH', 'plaster', 'roofTile', 'concrete', 'block', 'stoneWall', 'asphalt', 'corrugated', 'paint', 'dirt', 'glass', 'metal'];
    names.forEach((n, i) => {
      const x = (i % 5) * 2.4 - 4.8, y = 1 + Math.floor(i / 5) * 2.4;
      B.box(M[n], { w: 2.2, h: 2.2, d: 0.3, pos: [x, y, 0], color: n === 'paint' ? [0.3, 0.45, 0.8] : [1, 1, 1] });
    });
    return B.build({ name: 'swatches' });
  },
};

export async function loadModels() {
  for (const f of ['houses', 'boats', 'train', 'props', 'flora']) {
    try {
      const m = await import(`./${f}.js`);
      FAMILY[f] = m;
      Object.assign(MODELS, m.MODELS);
    } catch (e) {
      console.warn(`model family "${f}" failed to load: ${e.message}`);
    }
  }
}
