// Offline render: every frame is rendered on the GPU with temporal super-sampling,
// read back as raw RGBA, streamed into ffmpeg, and muxed with the synthesized score.
//
//   node tools/render.mjs [--sub 16] [--from 0] [--to 900] [--out out/reel.mp4] [--crf 14]
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openReel } from './browser.mjs';
import { ROOT } from './server.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const SUB = +arg('sub', 16);
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const OUT = arg('out', join('out', `${PKG.name}.mp4`));
const CRF = arg('crf', '17');
const MAXRATE = arg('maxrate', '40M');
const AUDIO = join(ROOT, 'out', 'audio.wav');

let ffmpeg;
let written = 0;
const onFrame = async (i, buf) => {
  if (buf.length !== 1920 * 1080 * 4) throw new Error(`bad frame ${i}: ${buf.length} bytes`);
  if (!ffmpeg.stdin.write(buf)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
  written++;
};

const Q = arg('q', '');
const reel = await openReel({ onFrame, query: 'render=1' + (Q ? '&' + Q : '') });
const total = await reel.page.evaluate('window.reel.frames');
const from = +arg('from', 0);
const to = Math.min(+arg('to', total), total);
console.log(`renderer: ${reel.renderer}`);
console.log(`frames ${from}..${to - 1} at ${SUB} samples -> ${OUT}`);

const hasAudio = existsSync(AUDIO) && from === 0;
const args = [
  '-y', '-loglevel', 'error',
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '1920x1080', '-r', '60', '-i', '-',
  ...(hasAudio ? ['-i', AUDIO] : []),
  '-vf', 'vflip,scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p',
  '-c:v', 'libx264', '-preset', 'slower', '-crf', CRF, '-profile:v', 'high', '-tune', 'grain',
  '-maxrate', MAXRATE, '-bufsize', `${parseInt(MAXRATE, 10) * 2}M`,
  '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
  ...(hasAudio ? ['-c:a', 'aac', '-b:a', '320k', '-shortest'] : []),
  '-movflags', '+faststart',
  join(ROOT, OUT),
];
ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });
const done = new Promise((res, rej) => ffmpeg.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exited ' + c)))));

const t0 = performance.now();
for (let i = from; i < to; i++) {
  await reel.page.evaluate((i, s) => window.reel.send(i, s), i, SUB);
  if ((i - from + 1) % 30 === 0 || i === to - 1) {
    const el = (performance.now() - t0) / 1000;
    const per = el / (i - from + 1);
    process.stdout.write(`  frame ${i + 1}/${to}  ${(per * 1000).toFixed(0)} ms/frame  eta ${(per * (to - i - 1)).toFixed(0)}s\n`);
  }
}
ffmpeg.stdin.end();
await done;
await reel.close();
console.log(`wrote ${OUT} (${written} frames, ${((performance.now() - t0) / 1000).toFixed(1)}s)`);
