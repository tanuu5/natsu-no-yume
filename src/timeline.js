// Single source of truth for timing. Audio (audio/synth.py) reads the cue sheet
// exported from this file (npm run audio), so every sound lands on its frame.
//
// 夏の夢 — one summer day in a seaside town, walked from morning to night.
// 80 BPM: one beat = 0.75 s, one bar = 3 s, 32 bars = 96 s.

export const W = 1920;
export const H = 1080;
export const FPS = 60;
export const BPM = 80;
export const BEAT = 60 / BPM;          // 0.75 s
export const BAR = BEAT * 4;           // 3 s
export const BARS = 32;
export const DURATION = BAR * BARS;    // 96 s
export const b = (n) => n * BEAT;      // beat index -> seconds
export const bar = (n) => n * BAR;     // bar index -> seconds

export const PALETTE = {
  ink: '#0E0D0B',
  ink2: '#1A1815',
  paper: '#F3EEE5',
  sand: '#E4D6BF',
  orange: '#EE6A3C',
  clay: '#C4532C',
  blue: '#3048E8',
  lilac: '#B8B2F0',
  gray: '#8B867D',
  gold: '#E9B949',
  teal: '#7FD6C8',
};

export const HUD_TEXT = { left: '夏の夢', right: 'A SUMMER DREAM — 2026' };

// ---- the day ---------------------------------------------------------------------
// Each segment is one continuous walk. Neighbouring segments overlap by XFADE seconds
// (centred on the boundary) and dissolve into each other.
export const XFADE = 2.0;
export const SEGMENTS = [
  { id: 'morning',   start: bar(0),  end: bar(8),  clock: '6:40',  place: '棚田',       title: '朝' },
  { id: 'noon',      start: bar(8),  end: bar(15), clock: '12:30', place: '坂道',       title: '昼' },
  { id: 'afternoon', start: bar(15), end: bar(22), clock: '16:50', place: '海の見える駅', title: '午後' },
  { id: 'sunset',    start: bar(22), end: bar(28), clock: '18:55', place: '漁港',       title: '夕暮れ' },
  { id: 'night',     start: bar(28), end: bar(32), clock: '19:40', place: '棚田',       title: '夜' },
];

// Events inside the segments (seconds).
export const EV = {
  fadeIn: [0, 2.5],                 // black -> first light
  drops: [1.6, 3.9],                // water drops fall into the terrace right in front of the camera (rings spread)
  title: [b(4), b(12)],             // small title card over the paddies
  kite: b(14),                      // a black kite passes overhead (morning)
  chimes: [b(40), b(44.5), b(49)],  // wind chime on the noon street
  crossing: [43.8, 50.2],           // level-crossing bell (the crossing is ~100 m north, behind the camera)
  trainArrive: 47.13,               // the train's front passes the camera (it comes from behind, on the right)
  trainPass: [47.13, 49.02],        // front .. rear passing the camera at ~1.5 m
  trainStop: b(70),                 // 52.5: stopped at the platform, 24 m ahead
  trainDepart: b(76),               // 57.0: pulls away south along the coast
  trainGone: 66.0,                  // ~85 m away, fading into the dissolve
  sunTouch: b(100),                 // the sun touches the sea
  night: bar(28),
  fireflies: b(116),
  endTitle: b(118),
  end: bar(32),
};

export const CHAPTERS = SEGMENTS.map((s, i) => ({ t: s.start, label: `0${i + 1}  ${s.title}` }));

// HUD tone: 1 = dark HUD over a light picture. Add [start, end) ranges for light shots.
export const LIGHT = [];
export function tone(t) {
  for (const [a, c] of LIGHT) if (t >= a && t < c) return 1;
  return 0;
}

// Which segments are visible at time t, with their weights (dissolves).
export function segmentsAt(t) {
  const out = [];
  SEGMENTS.forEach((s, i) => {
    const a = i === 0 ? -1 : s.start - XFADE / 2;
    const z = i === SEGMENTS.length - 1 ? DURATION + 1 : s.end + XFADE / 2;
    if (t >= a && t < z) out.push({ seg: s, index: i });
  });
  return out;
}

// Everything the sound design needs to line up with the picture.
export function cueSheet() {
  return { bpm: BPM, beat: BEAT, bar: BAR, duration: DURATION, bars: BARS, xfade: XFADE, segments: SEGMENTS, ev: EV };
}
