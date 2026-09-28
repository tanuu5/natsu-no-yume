// Writes the timing cue sheet shared by picture and sound to audio/cues.json.
import { writeFile } from 'node:fs/promises';
import { cueSheet } from '../src/timeline.js';

const out = new URL('../audio/cues.json', import.meta.url);
await writeFile(out, JSON.stringify(cueSheet(), null, 2));
console.log('wrote', out.pathname.split('/').slice(-2).join('/'));
