// Glyph -> signed distance field texture (exact Euclidean distance transform,
// Felzenszwalb & Huttenlocher), so shaders can raymarch real type as solid 3D.

const INF = 1e20;

// 1D squared distance transform of f (in place into d).
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

function edt2d(grid, w, h) {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[y * w + x] = Math.sqrt(d[x]);
  }
}

// Render `text` with `font` into a size x size field. Returns { data (Float32 RGBA,
// distance in texels in .r, negative inside), size, scale } where the glyph's cap
// height spans `cap` texels. Distances are exact to the pixel grid.
export function glyphSDF(text, font, { size = 512, fill = 0.72, pad = 0 } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText(text);
  const gh = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  const gw = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
  const k = (size * fill) / Math.max(gh, gw);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.scale(k, k);
  ctx.fillStyle = '#fff';
  const cx = (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
  const cy = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  ctx.fillText(text, -cx, cy);
  ctx.restore();
  const img = ctx.getImageData(0, 0, size, size).data;
  const N = size * size;
  const outside = new Float64Array(N), inside = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = img[i * 4] / 255;
    // sub-pixel: seed with a fractional offset from the anti-aliased edge
    outside[i] = a > 0.5 ? 0 : INF;
    inside[i] = a > 0.5 ? INF : 0;
  }
  edt2d(outside, size, size);
  edt2d(inside, size, size);
  const data = new Float32Array(N * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const a = img[i * 4] / 255;
      // signed distance between pixel centres; on the anti-aliased rim the
      // coverage gives the sub-texel position of the edge instead
      let dist = a > 0.5 ? 0.5 - inside[i] : outside[i] - 0.5;
      if (a > 0.02 && a < 0.98) dist = 0.5 - a;
      // flip y so texture v goes up like world y
      const j = (size - 1 - y) * size + x;
      data[j * 4] = dist;
    }
  }
  // a light separable blur removes the rasteriser's row-to-row edge noise, which
  // would otherwise show up as ribs on bevels seen at grazing angles
  const tmp = new Float32Array(N);
  const R = 2;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let acc = 0, n = 0;
        for (let k = -R; k <= R; k++) {
          const xx = pass === 0 ? Math.min(size - 1, Math.max(0, x + k)) : x;
          const yy = pass === 1 ? Math.min(size - 1, Math.max(0, y + k)) : y;
          acc += data[(yy * size + xx) * 4]; n++;
        }
        tmp[y * size + x] = acc / n;
      }
    }
    for (let i = 0; i < N; i++) data[i * 4] = tmp[i];
  }
  return { data, size, aspect: gw / gh, glyphH: gh * k, glyphW: gw * k };
}
