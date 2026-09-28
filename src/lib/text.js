// Canvas2D typography helpers: kerning-preserving per-glyph layout and drawing.

export function setFont(ctx, font, { spacing = 0, stretch = 'normal' } = {}) {
  ctx.font = font;
  ctx.fontStretch = stretch;
  ctx.letterSpacing = `${spacing}px`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
}

// Glyph x offsets taken from prefix widths, so kerning pairs survive.
export function layout(ctx, text, font, opts = {}) {
  setFont(ctx, font, opts);
  const xs = [];
  for (let i = 0; i <= text.length; i++) xs.push(ctx.measureText(text.slice(0, i)).width);
  const m = ctx.measureText(text);
  const cap = ctx.measureText('H').actualBoundingBoxAscent;
  return {
    text, font, opts, xs, width: xs[text.length], cap,
    ascent: m.actualBoundingBoxAscent, descent: m.actualBoundingBoxDescent,
    glyphs: [...text].map((ch, i) => ({ ch, x: xs[i], w: xs[i + 1] - xs[i] })),
  };
}

// Draw one glyph with a transform around its pivot (base-centre by default).
export function drawGlyph(ctx, ch, x, baseline, w, cap, { dx = 0, dy = 0, rot = 0, sx = 1, sy = 1, pivot = 'base' } = {}) {
  const px = x + w / 2;
  const py = pivot === 'base' ? baseline : baseline - cap / 2;
  ctx.save();
  ctx.translate(px + dx, py + dy);
  if (rot) ctx.rotate(rot);
  if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
  ctx.fillText(ch, -w / 2, baseline - py);
  ctx.restore();
}
