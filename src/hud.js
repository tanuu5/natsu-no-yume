// Typography, drawn in display space after the tone map (exact colours, then grain):
// the opening title, a quiet vertical caption at the start of each walk (place and
// time in kanji numerals), and the end title.
import { W, H, SEGMENTS, EV, DURATION } from './timeline.js';
import { clamp, ease } from './lib/math.js';

const MINCHO = '"Shippori Mincho B1"';
const SERIF = '"Instrument Serif"';
const INK = [248, 244, 236];

const CAPTIONS = {
  morning: ['棚田', '午前六時四十分'],
  noon: ['坂道', '十二時三十分'],
  afternoon: ['海の見える駅', '午後四時五十分'],
  sunset: ['漁港', '午後六時五十五分'],
  night: ['棚田', '午後七時四十分'],
};

// Soft reveal of one glyph: 0 -> 1 over `dur`, with blur and a small rise.
function glyph(ctx, ch, x, y, p, { size, weight = 500, alpha = 1, family = MINCHO }) {
  if (p <= 0) return;
  const e = ease.outCubic(clamp(p));
  ctx.save();
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const blur = (1 - e) * size * 0.08;
  if (blur > 0.3) ctx.filter = `blur(${blur.toFixed(2)}px)`;
  ctx.globalAlpha = alpha * e;
  ctx.fillStyle = `rgb(${INK.join(',')})`;
  ctx.shadowColor = 'rgba(10, 12, 20, 0.35)';
  ctx.shadowBlur = size * 0.25;
  ctx.fillText(ch, x, y + (1 - e) * size * 0.12);
  ctx.restore();
}

// A vertical line of CJK text, glyphs revealed one after another.
function vertical(ctx, text, x, y, t, t0, { size, gap = 1.25, stagger = 0.18, dur = 1.1, out = Infinity, outDur = 1.2, weight, alpha = 1 }) {
  const chars = [...text];
  const o = 1 - clamp((t - out) / outDur);
  if (o <= 0) return;
  chars.forEach((ch, i) => {
    const p = (t - t0 - i * stagger) / dur;
    glyph(ctx, ch, x, y + i * size * gap, p, { size, weight, alpha: alpha * o });
  });
}

function latin(ctx, text, x, y, t, t0, { size, out = Infinity, alpha = 0.8, rotate = 0, spacing = 2 }) {
  const p = ease.outCubic(clamp((t - t0) / 1.6));
  const o = 1 - clamp((t - out) / 1.2);
  if (p <= 0 || o <= 0) return;
  ctx.save();
  ctx.translate(x, y);
  if (rotate) ctx.rotate(rotate);
  ctx.font = `italic 400 ${size}px ${SERIF}`;
  ctx.letterSpacing = `${spacing}px`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = alpha * p * o;
  ctx.fillStyle = `rgb(${INK.join(',')})`;
  ctx.shadowColor = 'rgba(10, 12, 20, 0.35)';
  ctx.shadowBlur = size * 0.3;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

export function drawHud(ctx, t, frame) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  // opening title
  const [a, z] = EV.title;
  if (t > a - 0.1 && t < z + 1.5) {
    vertical(ctx, '夏の夢', 1480, 330, t, a, { size: 104, gap: 1.42, stagger: 0.32, dur: 1.6, out: z, outDur: 1.4, weight: 500 });
    latin(ctx, 'a summer dream', 1392, 332, t, a + 1.2, { size: 30, out: z, rotate: Math.PI / 2, spacing: 3 });
  }
  // captions at the start of each walk (the first one after the title)
  SEGMENTS.forEach((s, i) => {
    const c = CAPTIONS[s.id];
    const t0 = i === 0 ? z + 1.2 : s.start + 1.4;
    const out = i === SEGMENTS.length - 1 ? EV.endTitle - 1.5 : t0 + 4.2;
    if (t < t0 - 0.1 || t > out + 1.3) return;
    vertical(ctx, c[0], 1784, 128, t, t0, { size: 40, gap: 1.3, stagger: 0.12, dur: 1.0, out, weight: 500, alpha: 0.95 });
    vertical(ctx, c[1], 1726, 132, t, t0 + 0.5, { size: 22, gap: 1.35, stagger: 0.05, dur: 0.9, out, weight: 400, alpha: 0.78 });
  });
  // end title
  const e0 = EV.endTitle;
  if (t > e0 - 0.1) {
    vertical(ctx, '夏の夢', W / 2, 330, t, e0, { size: 118, gap: 1.42, stagger: 0.4, dur: 2.0, out: DURATION - 1.6, outDur: 1.5, weight: 500 });
    latin(ctx, 'a summer dream', W / 2 - 96, 330, t, e0 + 1.8, { size: 32, out: DURATION - 1.6, rotate: Math.PI / 2, spacing: 3 });
    const f = clamp((t - (e0 + 3.2)) / 1.5) * (1 - clamp((t - (DURATION - 1.6)) / 1.4));
    if (f > 0) {
      ctx.save();
      ctx.globalAlpha = 0.62 * f;
      ctx.font = `400 19px ${SERIF}`;
      ctx.letterSpacing = '4px';
      ctx.textAlign = 'center';
      ctx.fillStyle = `rgb(${INK.join(',')})`;
      ctx.fillText('a walk through a town that exists only in code  ·  2026', W / 2, H - 104);
      ctx.globalAlpha = 0.5 * f;
      ctx.font = `400 17px ${MINCHO}`;
      ctx.letterSpacing = '5px';
      ctx.fillText('企画・ディレクション　たぬ　　制作　Claude Opus 5.5', W / 2, H - 70);
      ctx.restore();
    }
  }
}
