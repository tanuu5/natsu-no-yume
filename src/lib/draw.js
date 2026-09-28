// Canvas2D drawing helpers shared by the scenes and the HUD: text decode,
// rounded rects, crop marks, and the recurring "caption" (model name + date + tag).
import { clamp, remap, ease, hash } from './math.js';
import { setFont } from './text.js';

export const MONO = '"JetBrains Mono"';
export const SANS = '"Archivo"';
export const SERIF = '"Instrument Serif"';
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=/<>';

// Decode effect: characters resolve left to right through random glyphs.
export function scramble(text, t, start, dur, seed = 0) {
  const p = (t - start) / dur;
  if (p >= 1) return text;
  if (p < 0) return '';
  let out = '';
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    const reveal = i / n;
    if (c === ' ') { out += ' '; continue; }
    if (p > reveal * 0.7 + 0.3) out += c;
    else if (p > reveal * 0.6) out += GLYPHS[Math.floor(hash(i, Math.floor(t * 40), seed) * GLYPHS.length)];
    else out += ' ';
  }
  return out;
}

// Typewriter: first n characters, with a block caret while typing.
export function typed(text, t, start, cps) {
  const n = Math.floor(clamp((t - start) * cps, 0, text.length));
  if (n <= 0) return '';
  return text.slice(0, n) + (n < text.length ? '▍' : '');
}

// Typewriter text centred on x as a whole line (so it doesn't drift while typing).
export function typedCenter(ctx, text, t, start, cps, x, y) {
  const w = ctx.measureText(text).width;
  const align = ctx.textAlign;
  ctx.textAlign = 'left';
  ctx.fillText(typed(text, t, start, cps), x - w / 2, y);
  ctx.textAlign = align;
}

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function cropMarks(ctx, x0, y0, x1, y1, arm, inset = 0) {
  ctx.beginPath();
  for (const [x, y, sx, sy] of [[x0 + inset, y0 + inset, 1, 1], [x1 - inset, y0 + inset, -1, 1], [x0 + inset, y1 - inset, 1, -1], [x1 - inset, y1 - inset, -1, -1]]) {
    ctx.moveTo(x + sx * arm, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + sy * arm);
  }
  ctx.stroke();
}

// "YYYY-MM-DD" -> "2023.03.14"
export const dotDate = (d) => d.replaceAll('-', '.');

// The recurring caption: a big model name that slides up out of a mask, a rule
// that draws itself, and a mono meta line that types on. `t0` = reveal start.
// Returns the caption's width so scenes can align things to it.
export function caption(ctx, t, t0, { x, y, name, meta, accent, color, size = 64, align = 'left', out = Infinity, spacing = -1 }) {
  const a = clamp((t - t0) / 0.5);
  const o = 1 - ease.inCubic(remap(t, out, out + 0.18));
  if (a <= 0 || o <= 0) return 0;
  ctx.save();
  setFont(ctx, `900 ${size}px ${SANS}`, { spacing, stretch: 'expanded' });
  const w = ctx.measureText(name).width;
  const x0 = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
  // name, masked slide-up
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0 - 20, y - size * 1.1, w + 60, size * 1.1 + 6);
  ctx.clip();
  const p = ease.outExpo(clamp((t - t0) / 0.55));
  const q = ease.inCubic(remap(t, out, out + 0.18));
  ctx.fillStyle = color;
  ctx.fillText(name, x0, y + size * 1.05 * (1 - p) - size * 1.05 * q);
  ctx.restore();
  // rule
  const rw = w * ease.outExpo(clamp((t - t0 - 0.08) / 0.5)) * o;
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = color;
  ctx.fillRect(x0, y + 18, rw, 2);
  ctx.globalAlpha = o;
  // meta line
  if (meta) {
    setFont(ctx, `500 19px ${MONO}`, { spacing: 4 });
    const s = typed(meta, t, t0 + 0.12, 70);
    ctx.fillStyle = accent || color;
    const mw = ctx.measureText(meta).width;
    const mx = align === 'left' ? x0 : align === 'right' ? x0 + w - mw : x0 + (w - mw) / 2;
    ctx.fillText(s, Math.max(x0, mx), y + 50);
  }
  ctx.restore();
  return w;
}
