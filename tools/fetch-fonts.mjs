// Downloads the OFL-licensed fonts used by the reel from the google/fonts repository.
// Each family is stored with its OFL.txt next to it.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fonts');
const base = 'https://raw.githubusercontent.com/google/fonts/main/ofl';

const families = {
  archivo: ['Archivo[wdth,wght].ttf', 'OFL.txt'],
  instrumentserif: ['InstrumentSerif-Regular.ttf', 'InstrumentSerif-Italic.ttf', 'OFL.txt'],
  jetbrainsmono: ['JetBrainsMono[wght].ttf', 'OFL.txt'],
  delagothicone: ['DelaGothicOne-Regular.ttf', 'OFL.txt'],
  shipporiminchob1: ['ShipporiMinchoB1-Regular.ttf', 'ShipporiMinchoB1-Medium.ttf', 'ShipporiMinchoB1-SemiBold.ttf', 'OFL.txt'],
};

for (const [family, files] of Object.entries(families)) {
  for (const file of files) {
    const out = join(root, family, file);
    try { await access(out); continue; } catch {}
    const res = await fetch(`${base}/${family}/${encodeURIComponent(file)}`);
    if (!res.ok) throw new Error(`${family}/${file}: HTTP ${res.status}`);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, Buffer.from(await res.arrayBuffer()));
    console.log('fetched', `${family}/${file}`);
  }
}
