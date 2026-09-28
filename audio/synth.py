#!/usr/bin/env python3
"""夏の夢 (A Summer Dream) — the whole soundtrack: music, ambience and sound design
for a 96-second walk through a Japanese seaside town on one summer day.

Everything is synthesised from oscillators and seeded noise (audio/instruments.py,
audio/nature.py, audio/mixing.py; building blocks in audio/dsp.py) and placed on
the cue sheet exported from src/timeline.js (audio/cues.json).

    npm run audio            (= node tools/export-cues.mjs && python3 audio/synth.py)
    python3 audio/synth.py [out.wav] [--stems]

Score layout
  1. time + harmony tables (80 BPM, D major, one chord per bar or half bar)
  2. music: piano, pad, strings, noon band (pizz bass, Rhodes, vibes, shaker,
     brush), celesta / music box / harp, soft timpani and cymbal swells
  3. ambience: one bed per segment, cross-faded exactly like the picture's
     2-second dissolves (equal power on the same smoothstep curve)
  4. events: birds, wind chime, level crossing, the diesel railcar, gulls, frogs
  5. reverbs (hall / room / outdoor / valley), master: loudness -15 LUFS,
     true-peak limit -1.2 dBTP, 24-bit WAV
"""
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from dsp import SR, Bus, filt, svf  # noqa: E402
from instruments import (  # noqa: E402
    Piano, bowed, chord_lines, music_box, celesta, vibes, epiano, harp, pizz,
    timp_stroke, timp_roll, cymbal_swell, shaker, brush, rim,
    seeded, sstep, pan2, onepole, edge, smooth_rand, BODY_VIOLIN, BODY_CELLO, BODY_PAD,
)
import nature as nat  # noqa: E402
from mixing import impulse, convolve, integrated_lufs, short_term, true_peak, limit, write_wav24  # noqa: E402

T_START = time.perf_counter()
CUES = json.load(open(os.path.join(HERE, "cues.json")))
BEAT = CUES["beat"]
DUR = CUES["duration"]
XF = CUES["xfade"]
SEGS = CUES["segments"]
SEG_IDX = {s["id"]: i for i, s in enumerate(SEGS)}
EV = CUES["ev"]
N = int(round((DUR + 4.0) * SR))       # room for tails; trimmed at the end
TARGET_LUFS = -15.0
CEILING_DB = -1.2


def b(x):
    """beats -> seconds"""
    return x * BEAT


def db(v):
    return 10.0 ** (v / 20.0)


HUM = seeded(2026, 928)                # humanisation (timing / velocity), deterministic

# ----------------------------------------------------------------------------
# Buses
# ----------------------------------------------------------------------------
music = Bus("music", N)     # dry instruments
hall = Bus("hall", N)       # send: concert-hall reverb (music)
room = Bus("room", N)       # send: small room (noon band, close things)
amb = Bus("amb", N)         # dry ambience (already cross-faded per segment)
sfx = Bus("sfx", N)         # dry sound effects (crossing, train)
outdoor = Bus("outdoor", N)  # send: open air with building/hill echoes
valley = Bus("valley", N)   # send: the terraced valley / wooded hills


def seg_gain(i, t):
    """Equal-power gain of segment i at times t, on the picture's dissolve curve
    (smoothstep over XF seconds centred on each boundary)."""
    s = SEGS[i]
    g = np.ones_like(t)
    if i > 0:
        w = sstep((t - (s["start"] - XF / 2)) / XF)
        g = g * np.sin(0.5 * np.pi * w)
    if i < len(SEGS) - 1:
        w = sstep((t - (s["end"] - XF / 2)) / XF)
        g = g * np.cos(0.5 * np.pi * w)
    return g


def apply_seg(x, t0, i):
    t = t0 + np.arange(x.shape[-1]) / SR
    return x * seg_gain(i, t)


STEMS = "--stems" in sys.argv
TAGS = {}                    # per-instrument dry stems (diagnostics only, with --stems)


def put(x, t, gain, bus=None, hall_amt=0.0, room_amt=0.0, pan=0.0, tag=None):
    (bus or music).add(x, t, gain, pan)
    if STEMS and tag:
        TAGS.setdefault(tag, Bus(tag, N)).add(x, t, gain, pan)
    if hall_amt:
        hall.add(x, t, gain * hall_amt, pan)
    if room_amt:
        room.add(x, t, gain * room_amt, pan)


# ============================================================================
# 1. Harmony (D major, 80 BPM; beat numbers from the start of the film)
# ============================================================================
PAD = {  # 4-voice voicings (MIDI), voice-led; the bass instrument supplies the root
    "Dadd9": [57, 62, 64, 66], "Bm11": [57, 62, 64, 66], "Gmaj9": [57, 59, 62, 66], "D/F#": [57, 62, 64, 69],
    "Em9": [55, 59, 62, 66], "A9sus4": [55, 59, 62, 64], "A13": [55, 61, 64, 66], "Dmaj9": [57, 61, 64, 66],
    "E9": [56, 59, 62, 66], "F#m7": [57, 61, 64, 66], "Bm7": [57, 59, 62, 66], "Bm9": [57, 61, 62, 66],
    "Gm6": [55, 58, 62, 64], "D6/9": [57, 59, 64, 66], "Dmaj7/C#": [57, 62, 64, 66], "Bm7/A": [57, 59, 62, 66],
    "Em9/G": [55, 59, 62, 66], "A/G": [57, 61, 64, 69],
}
BASS = {"Dadd9": 38, "Bm11": 35, "Gmaj9": 43, "D/F#": 42, "Em9": 40, "A9sus4": 45, "A13": 45, "Dmaj9": 38,
        "E9": 40, "F#m7": 42, "Bm7": 35, "Bm9": 35, "Gm6": 43, "D6/9": 38, "Dmaj7/C#": 37, "Bm7/A": 33,
        "Em9/G": 43, "A/G": 43}
ARP = {  # six arpeggio tones per chord (low -> high) for the piano's left hand
    "Dadd9": [38, 45, 50, 52, 54, 57], "D6/9": [38, 45, 50, 52, 54, 59], "Dmaj7/C#": [37, 45, 50, 52, 54, 57],
    "Bm9": [35, 42, 47, 49, 50, 54], "Bm7": [35, 42, 47, 50, 54, 57], "Bm7/A": [33, 42, 47, 50, 54, 57],
    "Gmaj9": [43, 50, 55, 57, 59, 62], "Em9": [40, 47, 52, 54, 55, 59], "Em9/G": [43, 50, 52, 54, 55, 59],
    "A9sus4": [45, 52, 57, 59, 62, 64], "A13": [45, 52, 55, 61, 64, 66], "A/G": [43, 52, 57, 61, 64, 69],
    "F#m7": [42, 49, 52, 54, 57, 61], "Gm6": [43, 50, 55, 57, 58, 62], "D/F#": [42, 50, 57, 62, 64, 66],
}
PROG = [
    # morning (bars 0-7): ambience alone in bar 0, then the first chord with the title card
    (4, "Dadd9"), (12, "Bm11"), (16, "Gmaj9"), (20, "D/F#"), (24, "Em9"), (28, "A9sus4"),
    # noon (bars 8-14): brighter, a walking pulse
    (32, "Dmaj9"), (36, "Gmaj9"), (40, "D/F#"), (44, "E9"), (48, "Gmaj9"), (52, "F#m7"), (54, "Bm7"),
    (56, "Em9"), (58, "A9sus4"),
    # afternoon (bars 15-21): deceptive turn to the relative minor on the dissolve, wistful
    (60, "Bm9"), (64, "Gmaj9"), (68, "Em9"), (72, "F#m7"), (76, "Gmaj9"), (78, "Gm6"), (80, "D/F#"),
    (82, "Bm7"), (84, "Em9"), (86, "A9sus4"), (87, "A13"),
    # sunset (bars 22-27): home at last, a descending bass under the full theme
    (88, "D6/9"), (90, "Dmaj7/C#"), (92, "Bm9"), (94, "Bm7/A"), (96, "Em9/G"), (98, "A9sus4"), (99, "A13"),
    (100, "Gmaj9"), (102, "A/G"), (104, "F#m7"), (106, "Bm9"), (108, "Em9"), (110, "A9sus4"),
    # night (bars 28-31): the theme once more, bare, and the final chord
    (112, "Gmaj9"), (116, "Em9"), (118, "A9sus4"), (120, "Dadd9"),
]
END_BEAT = 128


def chords_between(b0, b1):
    """[(start_beat, end_beat, name)] of the progression clipped to [b0, b1)."""
    out = []
    for k, (s, name) in enumerate(PROG):
        e = PROG[k + 1][0] if k + 1 < len(PROG) else END_BEAT
        if e > b0 and s < b1:
            out.append((max(s, b0), min(e, b1), name))
    return out


# ============================================================================
# 2. The theme (original; D major pentatonic / yonanuki). (beat, beats, midi)
#    Sunset form: t1 t2 t3b t4b t5 t6  —  B4 A4 B4 D5 E5 | F#5 E5 D5 B4 |
#    A4 B4 D5 E5 F#5 A5 | B5 A5 F#5 | E5 F#5 E5 D5 B4 | A4 B4 D5 E5
# ============================================================================
T1 = [(0, 1, 71), (1, .5, 69), (1.5, .5, 71), (2, 1.5, 74), (3.5, .5, 76)]
T2 = [(0, 1.5, 78), (1.5, .5, 76), (2, 1, 74), (3, 1, 71)]
T3A = [(0, 1, 69), (1, .5, 66), (1.5, .5, 69), (2, 1, 71), (3, .5, 69), (3.5, .5, 66)]
T4A = [(0, 3, 64)]
T3B = [(0, 1, 69), (1, .5, 71), (1.5, .5, 74), (2, 1, 76), (3, .5, 78), (3.5, .5, 81)]
T4B = [(0, 2, 83), (2, 1, 81), (3, 1, 78)]
T5 = [(0, 1, 76), (1, .5, 78), (1.5, .5, 76), (2, 1, 74), (3, 1, 71)]
T6 = [(0, 1, 69), (1, .5, 71), (1.5, .5, 74), (2, 2, 76)]


def phrase(start, *bars):
    out = []
    for k, bar_ in enumerate(bars):
        for s, d, m in bar_:
            out.append((start + 4 * k + s, d, m))
    return out


# ============================================================================
# 3. Instruments on the timeline
# ============================================================================
PIANO = Piano(seed=11, felt=0.75, bright=1.25)
G_PIANO = db(-17.0)
PIANO_SECTION = [(0, -2.5), (60, 0.0), (88, 0.5), (112, -0.5)]   # (from beat, dB): the dynamic arc of the day


def piano(beat, m, vel, dur, hall_amt=0.34, t_off=0.0, width=0.5):
    t = b(beat) + t_off + HUM.normal(0.0, 0.004)
    v = float(np.clip(vel + HUM.normal(0.0, 0.015), 0.05, 1.0))
    g = [d for s0, d in PIANO_SECTION if beat >= s0][-1]
    put(PIANO.stereo(m, v, b(dur), width), t, G_PIANO * db(g), hall_amt=hall_amt, tag="piano")


def piano_chord(beat, notes, vel, dur, roll=0.03, top_accent=0.04, **kw):
    ns = sorted(notes)
    for i, m in enumerate(ns):
        piano(beat, m, vel + (top_accent if i == len(ns) - 1 else 0.0), dur, t_off=i * roll, **kw)


def arpeggio(beat0, beats, chord, step=0.5, vel=0.3, accent=0.05, pattern=(0, 1, 2, 3, 4, 3, 2, 1), ring_to=None, cresc=0.0):
    tones = ARP[chord]
    k = 0
    bt = beat0
    while bt < beat0 + beats - 1e-6:
        u = (bt - beat0) / beats
        v = vel + cresc * u + (accent if abs(bt - round(bt)) < 1e-6 else 0.0)
        piano(bt, tones[pattern[k % len(pattern)]], v, (ring_to or beat0 + beats) - bt + 0.25)
        bt += step
        k += 1


def pad_section(b0, b1, gain, seg_i=None, cutoff=(500.0, 1400.0), attack=1.2, seed=0, hall_amt=0.45, level_fn=None):
    """A soft, voice-led 4-part pad over the chords in [b0, b1)."""
    ch = [(b(s), b(e), PAD[name]) for s, e, name in chords_between(b0, b1)]
    if not ch:
        return
    t0, t1 = ch[0][0] - 0.3, ch[-1][1] + 3.0
    out = np.zeros((2, int(round((t1 - t0) * SR))))
    for v, line in enumerate(chord_lines(ch, amp=[0.8, 0.9, 1.0, 0.85])):
        x = bowed(line, t0, t1, voices=3, detune=9.0, vib_rate=4.6, vib_depth=5.0, vib_delay=0.6, attack=attack,
                  release=1.6, glide=0.22, cutoff=cutoff, q=0.7, body=BODY_PAD, hp=110.0, lp=7000.0,
                  bow_noise=0.0, seed=seed * 10 + v, pan=(-0.45, -0.15, 0.15, 0.45)[v], spread=0.3, timing=0.02,
                  drift=3.0, swell=0.05, keytrack=0.3)
        out[:, :x.shape[1]] += x
    if level_fn is not None:
        out *= level_fn(t0 + np.arange(out.shape[1]) / SR)
    if seg_i is not None:
        out = apply_seg(out, t0, seg_i)
    put(out, t0, gain, hall_amt=hall_amt, tag="pad")


# ---------------------------------------------------------------- morning --
# 3.0 s: the title card — one soft rolled chord, a music-box glint
piano_chord(4, [38, 45, 52, 57, 62, 66], 0.34, 8, roll=0.045)
put(pan2(music_box(86, 0.45), 0.25), b(4) + 0.18, db(-21), hall_amt=0.6, tag="keys")
# bar 2: dew drops, answering the bush warbler
for bt, m, v in ((9, 81, 0.30), (10, 78, 0.27), (10.5, 76, 0.25), (11, 74, 0.29)):
    piano(bt, m, v, 12 - bt + 0.5)
# bar 3: under the kite
piano_chord(12, [35, 42], 0.3, 4, roll=0.02)
piano_chord(12.5, [62, 64, 69], 0.22, 3.5, roll=0.05)
# bars 4-7: the theme's first, quiet appearance (piano)
for bt, d, m in phrase(16, T1, T2, T3A, T4A):
    piano(bt, m, 0.42 + 0.04 * (m > 72), d * 1.1 + 0.1)
for bt, notes in ((16, [43, 50, 57]), (20, [42, 50, 57]), (24, [40, 47, 50, 54]), (28, [45, 52, 55])):
    piano_chord(bt, notes, 0.28, 4.2, roll=0.035, top_accent=0.0)
piano(30, 62, 0.2, 2.2)          # an inner D over the held E, leaning into noon
pad_section(4, 34, db(-37.0), seg_i=0, cutoff=(420.0, 1150.0), attack=2.2, seed=1,
            level_fn=lambda t: sstep((t - 3.0) / 3.5))

# ------------------------------------------------------------------- noon --
# pizzicato bass (a light walking pulse), with a pickup across the dissolve
BASSLINE = {32: [38, 42, 45, 42], 36: [43, 47, 50, 43], 40: [42, 45, 50, 41], 44: [40, 44, 47, 42],
            48: [43, 47, 50, 43], 52: [42, 49, 35, 42], 56: [40, 47, 45]}
G_PIZZ = db(-11.0)
for bt, m in ((31, 45), (31.5, 49)):
    put(pan2(pizz(m, 0.45, b(0.45)), -0.05), b(bt), G_PIZZ, room_amt=0.25, hall_amt=0.1, tag="band")
for bar0, notes in BASSLINE.items():
    for k, m in enumerate(notes):
        d = 1.8 if (bar0 == 56 and k == 2) else 0.8
        v = 0.62 if k == 0 else 0.5
        put(pan2(pizz(m, v + HUM.normal(0, 0.03), b(d), seed=bar0 + k), -0.05), b(bar0 + k) + HUM.normal(0, 0.005),
            G_PIZZ, room_amt=0.25, hall_amt=0.1, tag="band")

# Rhodes comping: syncopated, soft, with a gentle stereo tremolo
rh = np.zeros((2, N))
for s, e, name in chords_between(32, 60):
    hits = [(0.0, 1.4, 0.5), (1.5, 0.9, 0.36), (2.5, 1.3, 0.44)] if e - s >= 4 else [(0.0, 1.4, 0.48), (1.5, 0.4, 0.34)]
    for off, d, v in hits:
        for i, m in enumerate(PAD[name]):
            x = epiano(m, v + HUM.normal(0, 0.02), b(d), seed=int(s * 10 + off * 3 + i))
            nat.add_at(rh[0], x, b(s + off) + 0.006 * i)
            nat.add_at(rh[1], x, b(s + off) + 0.006 * i)
tt = np.arange(N) / SR
trem = 0.22 * np.sin(2 * np.pi * 4.2 * tt)
rh[0] *= 1.0 - trem
rh[1] *= 1.0 + trem
rh = apply_seg(rh, 0.0, 1)
put(rh, 0.0, db(-20.5), room_amt=0.3, hall_amt=0.2, tag="band")
del rh, tt, trem

# vibraphone: a light counter-melody that answers the wind chimes
VIBES = [(36.5, .5, 69), (37, .5, 71), (37.5, 1, 74), (38.5, .5, 76), (39, .75, 74),
         (41, .5, 78), (41.5, .5, 76), (42, .5, 74), (42.5, 1.5, 69),
         (45.5, .5, 71), (46, .5, 74), (46.5, 1, 78), (47.5, .5, 76),
         (48, 1, 74), (50, .5, 71), (50.5, .5, 69), (51, 1, 71),
         (52.5, .5, 73), (53, 1, 76), (54, .5, 74), (54.5, .5, 71), (55, 1, 78),
         (56.5, .5, 76), (57, .5, 74), (57.5, .5, 71), (58, 2, 69)]
for bt, d, m in VIBES:
    put(pan2(vibes(m, 0.5 + HUM.normal(0, 0.03), b(d) + 0.1, seed=int(bt * 2)), 0.18), b(bt) + HUM.normal(0, 0.004),
        db(-10.0), room_amt=0.2, hall_amt=0.3, tag="melody")

# shaker (8ths, off-beats leaning) and brushes on 2 & 4
perc = np.zeros((2, N))
for k in range(int((60 - 31.5) * 2)):
    bt = 31.5 + 0.5 * k
    if bt >= 59.5:
        break
    off = abs(bt - round(bt)) > 1e-6
    v = (0.55 if off else 0.36) + HUM.normal(0, 0.04)
    x = pan2(shaker(v, seed=k), -0.3)
    nat.add_at(perc, x, b(bt) + HUM.normal(0, 0.006))
    if int(round(bt * 2)) % 8 == 7:  # a ghost 16th before beat 1
        nat.add_at(perc, pan2(shaker(0.2, seed=1000 + k), -0.3), b(bt + 0.25))
for bt in np.arange(33, 60, 2.0):
    nat.add_at(perc, pan2(brush(0.5 + HUM.normal(0, 0.04), seed=int(bt)), -0.15), b(bt) + HUM.normal(0, 0.006))
for bt in (39.5, 47.5, 55.5):
    nat.add_at(perc, pan2(rim(0.4, seed=int(bt)), -0.2), b(bt))
perc = apply_seg(perc, 0.0, 1)
put(perc, 0.0, db(-14.0), room_amt=0.35, tag="perc")
del perc
pad_section(30, 62, db(-38.0), seg_i=1, cutoff=(700.0, 2100.0), attack=0.8, seed=2)

# -------------------------------------------------------------- afternoon --
# piano: 8ths, then quarter-note triplets locked to the crossing bell, then sparse
for s_, name in ((60, "Bm9"), (64, "Gmaj9")):   # triplets, in step with the crossing bell
    arpeggio(s_, 4, name, step=2 / 3, vel=0.25, pattern=(0, 2, 4, 5, 4, 2))
arpeggio(68, 4, "Em9", vel=0.24)
piano_chord(72, [42, 49, 57, 61, 64], 0.24, 4, roll=0.05)
piano_chord(76, [43, 50, 59, 62, 66], 0.25, 2, roll=0.05)
piano_chord(78, [43, 50, 58, 62, 64], 0.24, 2, roll=0.05)
piano_chord(80, [42, 50, 57, 62], 0.24, 2, roll=0.05)
piano_chord(82, [35, 47, 54, 57, 62], 0.24, 2, roll=0.05)
arpeggio(84, 2, "Em9", vel=0.26, cresc=0.04)
arpeggio(86, 1, "A9sus4", vel=0.3, pattern=(1, 2, 3, 4))
arpeggio(87, 1, "A13", vel=0.34, step=0.25, pattern=(1, 2, 3, 4))
pad_section(58, 90, db(-35.0), seg_i=2, cutoff=(650.0, 2300.0), attack=1.0, seed=3)
# the head of the theme on celesta as the train leaves: a memory of the morning
for bt, d, m in phrase(84, [(0, 1, 83), (1, .5, 81), (1.5, .5, 83), (2, 1.5, 86)]):
    put(pan2(celesta(m, 0.34, seed=int(bt * 4)), 0.35), b(bt), db(-20.0), hall_amt=0.6, tag="keys")
# soft mallet cymbal swell into the sunset downbeat
put(cymbal_swell(2.3, tail=2.5, seed=1), b(88) - 2.3, db(-17.0), hall_amt=0.4, tag="perc")

# ---------------------------------------------------------- strings line --
# violins: a wistful afternoon line flowing straight into the sunset theme
VLN_AFT = [(60, 2, 78), (62, 1, 76), (63, 1, 74), (64, 3, 74), (67, 1, 71), (68, 2, 71), (70, 1, 69), (71, 1, 71),
           (72, 3, 73), (75, 1, 69), (76, 2, 71), (78, 2, 70), (80, 2, 69), (82, 1, 71), (83, 1, 73),
           (84, 2, 74), (86, 1, 76), (87, 1, 73)]
VLN_SUN = phrase(88, T1, T2, T3B, T4B, T5, T6)


def vdyn(bt):
    """violin dynamics over the afternoon and sunset (0..1)"""
    return float(np.interp(bt, [60, 62, 70, 72, 76, 84, 88, 96, 100, 103, 106, 110, 112],
                           [0.30, 0.42, 0.44, 0.34, 0.40, 0.48, 0.66, 0.8, 1.0, 0.92, 0.75, 0.55, 0.4]))


vln = [(b(s), b(d) * 0.98 if d < 1.5 else b(d), m, vdyn(s)) for s, d, m in VLN_AFT + VLN_SUN]
x = bowed(vln, b(59.5), b(112) + 2.5, voices=8, detune=7.0, vib_rate=5.4, vib_depth=15.0, vib_delay=0.28, attack=0.3,
          release=0.9, glide=0.1, cutoff=(800.0, 4600.0), q=0.7, body=BODY_VIOLIN, hp=200.0, lp=9000.0,
          bow_noise=0.012, seed=21, pan=-0.28, spread=0.5)
x *= 1.0 - sstep((b(59.5) + np.arange(x.shape[1]) / SR - 83.4) / 2.0)   # gone by the end of the dissolve
put(x, b(59.5), db(-17.5), hall_amt=0.5, tag="melody")
# violas/cellos doubling the theme an octave below around the climax
dbl = [(b(s), b(d), m - 12, vdyn(s) * 0.8) for s, d, m in VLN_SUN if 95.9 < s < 108]
x = bowed(dbl, b(95.5), b(108) + 2.5, voices=6, detune=6.0, vib_rate=5.1, vib_depth=12.0, attack=0.35, release=0.9,
          glide=0.1, cutoff=(500.0, 2600.0), body=BODY_CELLO, hp=110.0, bow_noise=0.01, seed=22, pan=0.1, spread=0.4)
put(x, b(95.5), db(-24.0), hall_amt=0.5, tag="strings")
# cellos: long roots in the afternoon, a singing counter-line at sunset
CEL = [(60, 4, 47), (64, 4, 43), (68, 4, 40), (72, 4, 42), (76, 4, 43), (80, 2, 42), (82, 2, 47), (84, 2, 40), (86, 2, 45),
       (88, 2, 50), (90, 2, 49), (92, 2, 47), (94, 2, 45), (96, 2, 43), (98, 1, 45), (99, 1, 49), (100, 2, 55),
       (102, 2, 57), (104, 2, 54), (106, 2, 50), (108, 2, 52), (110, 2, 45)]
x = bowed([(b(s), b(d), m, 0.35 + 0.65 * vdyn(s)) for s, d, m in CEL], b(59.5), b(112) + 2.5, voices=5, detune=6.0,
          vib_rate=5.0, vib_depth=11.0, attack=0.4, release=1.0, glide=0.12, cutoff=(380.0, 2200.0), body=BODY_CELLO,
          hp=55.0, lp=6000.0, bow_noise=0.01, seed=23, pan=0.32, spread=0.35)
put(x, b(59.5), db(-24.5), hall_amt=0.45, tag="strings")
# basses: the roots, descending through the sunset
BAS = [(60, 4, 35), (64, 4, 43), (68, 4, 40), (72, 4, 42), (76, 2, 43), (78, 2, 43), (80, 2, 42), (82, 2, 35),
       (84, 2, 40), (86, 2, 45), (88, 2, 38), (90, 2, 37), (92, 2, 35), (94, 2, 33), (96, 2, 31), (98, 2, 33),
       (100, 2, 31), (102, 2, 31), (104, 2, 30), (106, 2, 35), (108, 2, 40), (110, 2, 33)]
x = bowed([(b(s), b(d), m, 0.35 + 0.65 * vdyn(s)) for s, d, m in BAS], b(59.5), b(112) + 2.5, voices=4, detune=5.0,
          vib_rate=4.8, vib_depth=7.0, attack=0.5, release=1.0, glide=0.12, cutoff=(220.0, 1100.0), body=BODY_CELLO,
          hp=32.0, lp=3000.0, bow_noise=0.0, seed=24, pan=0.12, spread=0.25)
put(x, b(59.5), db(-25.0), hall_amt=0.3, tag="strings")
del x

# ----------------------------------------------------------------- sunset --
SUN = chords_between(88, 112)
for s, e, name in SUN:
    arpeggio(s, e - s, name, vel=0.27 + 0.07 * (96 <= s < 106), accent=0.05)
for bt, d, m in phrase(100, T4B):  # the right hand doubles the climax in octaves
    piano(bt, m, 0.46, d + 0.3, width=0.3)
    piano(bt, m - 12, 0.38, d + 0.3, width=0.3)
pad_section(86, 112, db(-33.0), seg_i=3, cutoff=(700.0, 2600.0), attack=0.9, seed=4, hall_amt=0.5)
# harp: a rolled chord to open the sunset, a glissando up to the climax
for i, m in enumerate([50, 57, 59, 64, 66, 69]):
    put(pan2(harp(m, 0.42, seed=i), -0.35), b(88) + 0.05 * i, db(-19.0), hall_amt=0.5, tag="keys")
gl = [57, 59, 62, 64, 66, 69, 71, 74, 76, 78, 81, 83]
for i, m in enumerate(gl):
    tb = b(98.5) + i * (b(100) - b(98.5)) / (len(gl) - 1)
    put(pan2(harp(m, 0.3 + 0.03 * i, seed=20 + i), -0.4 + 0.06 * i), tb, db(-19.0), hall_amt=0.55, tag="keys")
# celesta sparkles
for bt, m, v in ((88, 86, 0.32), (92.5, 90, 0.26), (96, 88, 0.26), (100.5, 95, 0.3), (101, 93, 0.27), (101.5, 90, 0.26),
                 (102, 88, 0.26), (104, 88, 0.24), (106.5, 86, 0.22), (108, 81, 0.2)):
    put(pan2(celesta(m, v, seed=int(bt * 4)), 0.4), b(bt), db(-19.0), hall_amt=0.6, tag="keys")
# timpani roll into the moment the sun touches the sea, a soft stroke on it
put(pan2(timp_roll(45, b(2.0), 0.04, 0.5, seed=1), 0.05), b(98), db(-19.0), hall_amt=0.35, tag="perc")
put(pan2(timp_stroke(43, 0.55, seed=2), 0.05), b(100), db(-18.0), hall_amt=0.4, tag="perc")
put(cymbal_swell(1.9, tail=3.5, peak=0.8, seed=2), b(100) - 1.9, db(-19.0), hall_amt=0.4, tag="perc")

# ------------------------------------------------------------------ night --
piano_chord(112, [43, 50, 54], 0.26, 4, roll=0.04, top_accent=0.0)
piano_chord(116, [40, 47, 50], 0.25, 2, roll=0.04, top_accent=0.0)
piano_chord(118, [45, 52, 55], 0.24, 2, roll=0.04, top_accent=0.0)
for bt, d, m in phrase(112, T1, T2):
    piano(bt, m, 0.4 + 0.03 * (m > 72), d * 1.1 + 0.15)
piano_chord(120, [38, 45, 52, 54, 57, 62, 66, 74], 0.3, 8, roll=0.06, top_accent=0.06)
# music box: fireflies blinking, the end title, a last rising answer
FF = seeded(87)
tf = EV["night"] + 1.2
while tf < b(119.5):
    m = int(FF.choice([81, 83, 86, 88, 90, 93]))
    put(pan2(music_box(m, FF.uniform(0.18, 0.3), seed=int(tf * 100)), FF.uniform(-0.7, 0.7)), tf, db(-27.0), hall_amt=0.9, tag="keys")
    tf += FF.uniform(0.35, 1.1) * (2.0 if tf < EV["fireflies"] else 1.0)
for bt, m, v in ((118, 86, 0.36), (119, 83, 0.32), (120.5, 81, 0.32), (121, 83, 0.32), (122, 86, 0.38)):
    put(pan2(music_box(m, v, seed=int(bt * 10)), 0.2), b(bt), db(-22.0), hall_amt=0.7, tag="keys")
print(f"music        {time.perf_counter() - T_START:5.1f}s  (piano cache {len(PIANO.cache)})")


# ============================================================================
# 4. Ambience: one window per segment, cross-faded like the picture
# ============================================================================
AMB_TRIM = [-4.5, -4.0, -0.5, -1.5, -3.5]   # dB per segment: nature under the music, never on top


class Win:
    """A segment's ambience, rendered on its own window and faded with seg_gain."""

    def __init__(self, i):
        s = SEGS[i]
        self.i = i
        self.t0 = 0.0 if i == 0 else s["start"] - XF / 2 - 0.2
        self.t1 = DUR + 0.5 if i == len(SEGS) - 1 else s["end"] + XF / 2 + 0.2
        self.n = int(round((self.t1 - self.t0) * SR))
        self.dur = self.n / SR
        self.dry = np.zeros((2, self.n))
        self.out = np.zeros((2, self.n))
        self.val = np.zeros((2, self.n))

    def add(self, x, t, gain=1.0, pan=0.0, out=0.0, val=0.0):
        st = pan2(x, pan) if x.ndim == 1 else x
        st = st * gain
        nat.add_at(self.dry, st, t - self.t0)
        if out:
            nat.add_at(self.out, st * out, t - self.t0)
        if val:
            nat.add_at(self.val, st * val, t - self.t0)

    def bed(self, x, gain=1.0, out=0.0, val=0.0):
        self.add(x[:, :self.n], self.t0, gain, 0.0, out, val)

    def commit(self, extra=None):
        t = self.t0 + np.arange(self.n) / SR
        g = seg_gain(self.i, t) * db(AMB_TRIM[self.i])
        if extra is not None:
            g = g * extra(t)
        amb.add(self.dry * g, self.t0)
        outdoor.add(self.out * g, self.t0)
        valley.add(self.val * g, self.t0)


def moving(x, t_start, pans):
    """Pan a mono event along keyframes [(t, pan), ...] (absolute seconds)."""
    t = t_start + np.arange(len(x)) / SR
    k = np.array(pans, dtype=float)
    return pan2(x, np.interp(t, k[:, 0], k[:, 1]))


# ---------------------------------------------------------------- morning --
W = Win(0)
r = seeded(100)
br, gust = nat.breeze(W.dur, r, lo=420.0, hi=1500.0)
W.bed(br, db(-14.0), val=0.15)
W.bed(nat.rustle(W.dur, seeded(101), gust), db(-22.0))
W.bed(pan2(nat.trickle(W.dur, seeded(102), rate=55.0), -0.55) * 0.9, db(-13.0), val=0.1)
W.bed(pan2(nat.distance_filter(nat.trickle(W.dur, seeded(103), rate=40.0, fmin=380.0, fmax=1900.0), 14.0), 0.6), db(-12.0), val=0.2)
W.bed(nat.frog_chorus(W.dur, seeded(104), [("ama", 45, -0.35), ("shure", 35, 0.55), ("numa", 60, -0.75)], 0.05),
      db(-24.0), val=0.4)
# birds: the bush warbler twice far away, the kite overhead, a few sparrows
for t0, p, g, lp in ((4.0, -0.45, -16.0, 6000.0), (20.4, 0.55, -19.0, 5000.0)):
    W.add(filt(nat.uguisu_call(seeded(int(t0 * 10))), "lp", lp), t0, db(g), p, val=0.7)
k = nat.kite_call(seeded(105))
W.add(moving(k, EV["kite"], [(EV["kite"], -0.6), (EV["kite"] + 2.2, 0.5)]), EV["kite"], db(-14.0), val=0.4)
k2 = filt(nat.kite_call(seeded(106), f_lo=2300.0, f_hi=2880.0, t_pii=0.7, t_roro=0.9), "lp", 4500.0)
W.add(k2, EV["kite"] + 6.3, db(-22.0), 0.75, val=0.8)
for t0, cnt in ((1.7, 2), (13.6, 3), (18.9, 2)):
    rr = seeded(int(t0 * 100))
    p = rr.uniform(-0.8, 0.8)
    for j in range(cnt):
        W.add(filt(nat.sparrow_chirp(rr), "lp", 6000.0), t0 + j * rr.uniform(0.14, 0.25), db(-31.0), p, val=0.6)
fade_in = EV["fadeIn"][1]
W.commit(extra=lambda t: sstep(t / (fade_in + 0.3)) ** 1.1)
del W, br, gust
# two drops falling into the paddy right in front of the camera, as the picture fades in
for k, t0 in enumerate(EV.get("drops", [])):
    d = nat.water_drop(seeded(190 + k), f0=(620.0, 570.0)[k % 2], big=(1.4, 1.1)[k % 2])
    p_ = (0.05, -0.25)[k % 2]
    g_ = db((-15.5, -19.0)[k % 2])
    amb.add(pan2(d, p_), t0, g_)
    valley.add(pan2(d, p_), t0, g_ * 0.45)

# ------------------------------------------------------------------- noon --
W = Win(1)
W.bed(pan2(nat.abura(W.dur, seeded(110), fc=5000.0), -0.7), db(-22.0), out=0.15)
W.bed(pan2(nat.abura(W.dur, seeded(111), fc=4700.0, jiri=17.0), 0.65), db(-24.0), out=0.15)
far = np.stack([nat.abura(W.dur, seeded(112 + c), fc=4400.0, swell_rate=0.08) for c in range(2)])
W.bed(filt(far, "lp", 6000.0), db(-25.0), out=0.3)
for t0, p, g, fc in ((24.3, -0.45, -18.5, 4150.0), (28.9, 0.6, -23.0, 4350.0), (33.9, -0.1, -25.5, 4050.0),
                     (37.8, -0.45, -19.0, 4150.0), (41.5, 0.6, -22.5, 4350.0)):
    s = nat.minmin_song(seeded(int(t0 * 10)), fc0=fc)
    W.add(s, t0, db(g), p, out=0.2)
W.bed(nat.surf_distant(W.dur, seeded(113)), db(-22.0))
ob = nat.outboard(W.dur, seeded(114))
to = np.arange(len(ob)) / SR
ob = ob * sstep((to - 3.5) / 3.0) * sstep((W.dur - 4.5 - to) / 4.0)
W.bed(pan2(ob, -0.15), db(-26.0), out=0.3)
br, _ = nat.breeze(W.dur, seeded(115), lo=350.0, hi=900.0, depth=0.5)
W.bed(br, db(-23.0))
# the wind chime under an eave
for t0, hits in zip(EV["chimes"], ([(0.0, 1.0), (0.16, 0.45), (0.37, 0.22)], [(0.0, 0.8), (0.21, 0.5)],
                                   [(0.0, 0.9), (0.14, 0.4), (0.31, 0.3), (0.55, 0.15)])):
    rr = seeded(int(t0 * 1000))
    fx = np.zeros(int(4.0 * SR))
    for dt, st in hits:
        nat.add_at(fx, nat.furin_strike(2637.0, st, rr), dt)
    W.add(fx, t0, db(-18.0), 0.45, out=0.25)
W.commit()
del W, far, ob, br

# -------------------------------------------------------------- afternoon --
W = Win(2)
for t0, p, g in ((45.6, -0.6, -15.5), (50.4, 0.7, -18.5), (55.3, -0.25, -17.0), (59.5, 0.5, -14.5), (63.3, -0.65, -13.5)):
    W.add(filt(nat.higurashi_phrase(seeded(int(t0 * 10))), "lp", 7000.0), t0, db(g), p, val=0.5)
sw, _hits = nat.seawall(W.dur, seeded(120))
W.bed(sw * np.array([[0.55], [1.0]]), db(-16.0), out=0.15)
br, _ = nat.breeze(W.dur, seeded(121), lo=400.0, hi=1500.0)
W.bed(br, db(-18.0))
for t0, p in ((61.2, 0.8), (64.2, 0.6)):
    W.add(filt(nat.gull_call(seeded(int(t0 * 10))), "lp", 4000.0), t0, db(-25.0), p, out=0.5)
W.commit()
del W, sw, br


# the level crossing (about 100 m behind the camera): E5 / F#5 alternating on the
# quarter-note-triplet grid (0.5 s = 2 strikes per second, locked to the bar lines)
def crossing():
    r = seeded(130)
    t_first = np.ceil(EV["crossing"][0] / b(2.0 / 3.0) - 1e-6) * b(2.0 / 3.0)
    times = np.arange(t_first, EV["crossing"][1] - 0.05, b(2.0 / 3.0))
    x = np.zeros(int((times[-1] - t_first + 1.0) * SR))
    for k, t in enumerate(times):
        s_ = nat.crossing_strike(739.99 if k % 2 == 0 else 659.26, r)
        nat.add_at(x, s_ / (np.max(np.abs(s_)) + 1e-9) * (1.0 - 0.04 * (k % 2)), t - t_first)
    return filt(x, "lp", 5000.0, 0.6), float(t_first)


cx, cx0 = crossing()
put(pan2(cx, 0.22), cx0, db(-25.5), bus=sfx)
outdoor.add(pan2(cx, 0.22), cx0, db(-25.5) * 0.8)


# the single-car diesel railcar, as a moving source: it comes from behind on the right,
# its side passes the camera at ~1.5 m (EV.trainPass), brakes to a stop ~24 m ahead,
# idles, opens and closes its doors, toots, and pulls away south (1.5 m/s^2).
TR_LEN, TR_LAT = 20.0, 2.6            # car length (m); lateral distance camera -> wheels/engine (m)


def train_kinematics(t):
    """Position (m, positive = ahead/south) of the car's front and its speed (m/s)."""
    tp0, tp1 = EV["trainPass"]
    stop, dep = EV["trainStop"], EV["trainDepart"]
    a1 = 2.0 * (12.0 * (tp1 - tp0) - TR_LEN) / (tp1 - tp0) ** 2      # braking during the pass
    v1 = 12.0 - a1 * (tp1 - tp0)
    a2 = v1 / (stop - tp1)                                             # harder braking to the stop
    s_stop = TR_LEN + v1 * (stop - tp1) * 0.5
    v = np.where(t < 44.0, 12.0 + a1 * (tp0 - 44.0), 12.0 + a1 * (tp0 - t))
    v = np.where(t >= tp1, np.maximum(v1 - a2 * (t - tp1), 0.0), v)
    v = np.where(t >= stop, 0.0, v)
    v = np.where(t >= dep, np.minimum(1.5 * (t - dep), 12.0), v)
    s = np.cumsum(v) / SR
    i0 = np.searchsorted(t, tp0)
    s = s - s[min(i0, len(s) - 1)]                                     # front at the camera at tp0
    return s, v, s_stop


def train():
    r = seeded(140)
    t0, t1 = 40.0, 67.5
    n = int((t1 - t0) * SR)
    t = t0 + np.arange(n) / SR
    s_f, v, s_stop = train_kinematics(t)
    s_e = s_f - TR_LEN * 0.5                                           # engine under the middle of the car
    d_e = np.sqrt(s_e ** 2 + TR_LAT ** 2)
    v_rad = np.gradient(d_e) * SR                                      # + = receding
    dop = 343.0 / (343.0 + v_rad)
    near = np.minimum(6.0 / d_e, 2.6)
    air = np.clip(16000.0 * (6.0 / d_e) ** 0.55, 900.0, 16000.0)

    def pan_at(sx):
        return 0.12 + 0.83 * 6.0 / np.sqrt(36.0 + sx ** 2)

    stop, dep = EV["trainStop"], EV["trainDepart"]
    f_fire = np.interp(t, [t0, 47.0, stop - 0.3, stop + 0.2, dep - 0.1, dep + 0.5, dep + 1.8, dep + 4.0, t1],
                       [52, 44, 30, 27.5, 27.5, 42, 62, 64, 70])
    f_fire = f_fire * (1.0 + 0.006 * smooth_rand(n, 2.5, r, -1, 1)) * dop
    load = np.interp(t, [t0, 46.0, stop, dep - 0.1, dep + 0.2, dep + 1.5, t1], [0.45, 0.25, 0.1, 0.1, 0.9, 1.0, 0.85])
    eng = nat.diesel(f_fire, load, r)
    eng = eng / (np.sqrt(np.mean(eng ** 2)) + 1e-9) * (0.3 + 0.7 * load) * 0.22
    # wheels: two bogies, each heard from where it is
    rum_src = nat.rail_rumble(v, r)
    rum_src = rum_src / (np.sqrt(np.mean(rum_src ** 2)) + 1e-9) * 0.1
    out = pan2(svf(eng, air, 0.6, "lp") * near, pan_at(s_e))
    for off in (3.0, TR_LEN - 3.0):
        sb = s_f - off
        db_ = np.sqrt(sb ** 2 + TR_LAT ** 2)
        g = np.minimum(6.0 / db_, 2.6)
        out += pan2(svf(rum_src, np.clip(16000.0 * (6.0 / db_) ** 0.55, 900.0, 16000.0), 0.6, "lp") * g * 1.1, pan_at(sb))
    # the air the car pushes past you
    tp0, tp1 = EV["trainPass"]
    wenv = (np.exp(-((t - tp0) / 0.28) ** 2) + 0.8 * np.exp(-((t - tp1) / 0.35) ** 2) + 0.35 * ((t > tp0) & (t < tp1))) * (v / 12.0) ** 2
    wenv = onepole(wenv, 0.08)
    wh = nat.bpc(r.standard_normal(n), 700.0, 0.7, 1) * wenv * 0.13
    out += pan2(wh, 0.85)
    # rail joints: 'ga-tan' axle pairs placed on the musical grid (beats); level, pan and
    # air absorption from where that bogie is. Approach/pass: a joint every 2 beats with the
    # rear bogie 1.5 beats behind; braking: slowing; departure: accelerating, then locked
    # to the beat (quarter notes) as it pulls away into the sunset.
    CL = [(56, "F"), (57.5, "R"), (58, "F"), (59.5, "R"), (60, "F"), (61.5, "R"), (62, "F"), (63.5, "R"),
          (64, "F"), (65.5, "R"), (66.5, "F"), (68.0, "R"), (69.25, "F"),
          (77.0, "F"), (78.75, "R"), (80, "F"), (81, "R"), (82, "F"), (83, "R"), (84, "F"), (85, "R"),
          (86, "F"), (87, "R"), (88, "F")]
    for k, (bt, which) in enumerate(CL):
        th = b(bt)
        i = int((th - t0) * SR)
        if not 0 <= i < n:
            continue
        sp = max(float(v[i]), 0.8)
        gap = float(np.clip(2.1 / sp, 0.1, 0.55))
        sb = float(s_f[i]) - (3.0 if which == "F" else TR_LEN - 3.0)
        dd = float(np.hypot(sb, TR_LAT))
        lvl = min(6.0 / dd, 2.4) * (sp / 10.0) ** 0.6
        bright = 1.0 if which == "F" else 0.86
        pair = np.zeros(int((gap + 0.4) * SR))
        nat.add_at(pair, nat.clack(r, bright * 1.04, 0.8) * 0.7, 0.0)
        nat.add_at(pair, nat.clack(r, bright, 1.0), gap)
        pair = filt(pair, "lp", float(np.clip(16000.0 * (6.0 / dd) ** 0.55, 900.0, 16000.0)), 0.6)
        nat.add_at(out, pan2(pair, float(pan_at(sb))) * lvl * 0.3, th - gap - t0)
    # stopped ~24 m ahead: brakes squeal as it slows, air lets go, doors, chime, horn
    p_st = float(pan_at(s_stop - TR_LEN * 0.5))
    g_st = 6.0 / float(np.hypot(s_stop - TR_LEN * 0.5, TR_LAT))
    L = stop + 0.25 - 50.4
    sq = nat.squeal(L, r) * sstep((np.arange(int(L * SR)) / SR - 0.2) / 1.3)
    sq *= 1.0 - sstep((np.arange(len(sq)) / SR - (L - 0.4)) / 0.3)
    nat.add_at(out, pan2(filt(sq, "lp", 6000.0), p_st) * 0.05, 50.4 - t0)
    nat.add_at(out, pan2(nat.air_hiss(1.1, r, 4000.0, 0.01, 0.42), p_st) * 0.5 * g_st, stop + 0.12 - t0)
    nat.add_at(out, pan2(nat.door(r), p_st) * 0.8 * g_st, stop + 0.85 - t0)
    nat.add_at(out, pan2(nat.door_chime(880.0, 739.99, r), p_st) * 0.1 * g_st, dep - 1.1 - t0)
    nat.add_at(out, pan2(nat.door(r), p_st) * 0.8 * g_st, dep - 0.7 - t0)
    nat.add_at(out, pan2(nat.horn(r, 440.0, 0.4), p_st) * 0.9 * g_st, dep - 0.25 - t0)
    return apply_seg(out, t0, SEG_IDX["afternoon"]), t0


tr, tr0 = train()
put(tr, tr0, db(-12.0), bus=sfx)
outdoor.add(tr, tr0, db(-12.0) * 0.16)
del tr
# the music leans back a little while the car rushes past
tp0_, tp1_ = EV["trainPass"]
_tt = np.arange(N) / SR
music.x *= 1.0 - (1.0 - db(-3.0)) * sstep((_tt - (tp0_ - 0.5)) / 0.4) * (1.0 - sstep((_tt - (tp1_ + 0.2)) / 1.0))
del _tt

# ----------------------------------------------------------------- sunset --
W = Win(3)
W.bed(nat.lapping(W.dur, seeded(150)), db(-12.0), out=0.1)
su = nat.surf_distant(W.dur, seeded(151))
W.bed(su, db(-21.0))
br, _ = nat.breeze(W.dur, seeded(152), lo=380.0, hi=1200.0)
W.bed(br, db(-21.0))
rr = seeded(153)
tc = W.t0 + 1.0
while tc < W.t1 - 1.0:
    W.add(nat.creak(rr), tc, db(rr.uniform(-24.0, -19.0)), rr.uniform(-0.6, 0.6), out=0.2)
    if rr.random() < 0.35:
        W.add(nat.boat_knock(rr), tc + rr.uniform(0.3, 1.2), db(-24.0), rr.uniform(-0.5, 0.5), out=0.2)
    tc += rr.uniform(2.2, 4.8)
rg = seeded(154)
for t0 in (67.6, 70.6, 72.4, 77.9, 80.2, 82.5):
    p = rg.uniform(-0.85, 0.85)
    dist = rg.uniform(1.0, 2.2)
    for j in range(int(rg.integers(1, 3 if 71 < t0 < 79 else 4))):
        c = nat.gull_call(rg)
        W.add(filt(c, "lp", 7000.0 / dist), t0 + j * rg.uniform(0.6, 0.95), db(-23.0 - 7.0 * (dist - 1.0)), p, out=0.35)
for t0, p, g in ((66.8, -0.7, -17.5), (71.9, 0.65, -21.0), (78.2, -0.4, -25.0)):
    W.add(filt(nat.higurashi_phrase(seeded(int(t0 * 10))), "lp", 6000.0), t0, db(g), p, val=0.6)
W.commit()
del W, su, br

# ------------------------------------------------------------------ night --
W = Win(4)
FROGS_NIGHT = [("ama", 7, -0.55), ("ama", 11, 0.35), ("ama", 16, 0.8), ("ama", 22, -0.85), ("ama", 30, 0.1), ("ama", 40, -0.3),
               ("numa", 9, 0.15), ("numa", 18, -0.6), ("numa", 28, 0.65), ("shure", 12, -0.2), ("shure", 20, 0.55),
               ("shure", 26, -0.75), ("ushi", 90, 0.4)]
W.bed(nat.frog_chorus(W.dur, seeded(160), FROGS_NIGHT, 0.08), db(-15.0), val=0.35)
W.bed(nat.surf_distant(W.dur, seeded(161)), db(-26.0))
br, _ = nat.breeze(W.dur, seeded(162), lo=300.0, hi=900.0, depth=0.5)
W.bed(br, db(-24.0))
W.commit(extra=lambda t: 1.0 - sstep((t - 90.8) / 4.9))
del W, br

# the dissolves: a breath of wind swelling through each one
for i, s in enumerate(SEGS[1:]):
    tb = s["start"]
    ws = nat.wind_swell(3.0, seeded(170 + i), 240.0 if i < 3 else 180.0, 900.0 if i < 3 else 650.0)
    amb.add(ws, tb - 1.5, db(-21.0))
print(f"ambience     {time.perf_counter() - T_START:5.1f}s")


# ============================================================================
# 5. Reverbs + master
# ============================================================================
IR_HALL = impulse((3.1, 2.6, 1.4), 4.5, pre=0.024, seed=1,
                  er=[(0.011, 0.08), (0.019, 0.07), (0.027, 0.06), (0.041, 0.05), (0.056, 0.04)], onset=0.04, lp=10000.0, hp=180.0)
IR_ROOM = impulse((0.9, 0.75, 0.45), 1.6, pre=0.006, seed=2, er=[(0.004, 0.1), (0.009, 0.08)], onset=0.01)
IR_OUT = impulse((1.4, 1.1, 0.55), 2.6, pre=0.012, seed=3, sparse=0.7,
                 er=[(0.085, 0.3), (0.19, 0.22), (0.37, 0.17), (0.61, 0.1)], onset=0.02, lp=9000.0)
IR_VAL = impulse((2.4, 2.0, 0.9), 3.8, pre=0.03, seed=4, sparse=0.5,
                 er=[(0.21, 0.25), (0.46, 0.2), (0.83, 0.12)], onset=0.05, lp=8000.0)

wet = (convolve(hall.x, IR_HALL, N) * db(-5.5) + convolve(room.x, IR_ROOM, N) * db(-7.0)
       + convolve(outdoor.x, IR_OUT, N) * db(-5.0) + convolve(valley.x, IR_VAL, N) * db(-4.5))
print(f"reverb       {time.perf_counter() - T_START:5.1f}s")

# music bus: a little less low-mid mud, a little more air and presence
music.x = filt(filt(music.x, "peak", 260.0, 0.9, -2.0), "highshelf", 2500.0, 0.7, 2.5)
stems = {"music": music.x, "ambience": amb.x, "sfx": sfx.x, "reverb": wet}
GAINS = {"music": 0.0, "ambience": 0.0, "sfx": 0.0, "reverb": 0.0}
mix_ = sum(stems[k] * db(GAINS[k]) for k in stems)
mix_ = filt(filt(mix_, "hp", 26.0, 0.7), "hp", 26.0, 0.7)
mix_ = filt(mix_, "highshelf", 7500.0, 0.7, -1.5)         # keep the cicadas from biting

n_out = int(round(DUR * SR))
mix_ = mix_[:, :n_out]
tt = np.arange(n_out) / SR
mix_ *= (1.0 - sstep((tt - (DUR - 2.2)) / 2.2)) ** 1.2      # the picture fades to black over the last 2.2 s
mix_ *= sstep(tt / 0.01)

L0 = integrated_lufs(mix_)
mix_ *= db(TARGET_LUFS - L0)
mix_, gr = limit(mix_, CEILING_DB)
if STEMS:
    lg = 20 * np.log10(limit.last_gain + 1e-12)
    busy = np.where(lg < -1.0)[0]
    spans = np.split(busy, np.where(np.diff(busy) > SR * 0.05)[0] + 1) if len(busy) else []
    print("limiter > 1 dB at:", ", ".join(f"{sp[0] / SR:.2f}s ({lg[sp].min():.1f} dB, {len(sp) / SR * 1000:.0f} ms)" for sp in spans[:12]))
L1 = integrated_lufs(mix_)
mix_ *= db(TARGET_LUFS - L1)
mix_, gr2 = limit(mix_, CEILING_DB)
tp = true_peak(mix_)
if tp > CEILING_DB:
    mix_ *= db(CEILING_DB - tp - 0.05)
L2 = integrated_lufs(mix_)
tp = true_peak(mix_)

args = [a for a in sys.argv[1:] if not a.startswith("--")]
out = args[0] if args else os.path.join(HERE, "..", "out", "audio.wav")
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
write_wav24(out, mix_)
print(f"wrote {os.path.relpath(out)}  {n_out / SR:.3f}s  {L2:.1f} LUFS  true peak {tp:.2f} dBTP  "
      f"limiter max GR {min(gr, gr2):.1f} dB  ({time.perf_counter() - T_START:.1f}s)")

if "--stems" in sys.argv:
    sd = os.path.join(os.path.dirname(os.path.abspath(out)), "stems")
    os.makedirs(sd, exist_ok=True)
    g = db(TARGET_LUFS - L0)
    for k, v in stems.items():
        write_wav24(os.path.join(sd, f"{k}.wav"), np.clip(v[:, :n_out] * g, -1, 1))
    print("stems:", ", ".join(stems))
    for k, v in stems.items():
        ts, st = short_term(v[:, :n_out] * g, 3.0, 3.0)
        print(f"  {k:9s} " + " ".join(f"{x:4.0f}" if x > -60 else "   ." for x in st))
    ts, st = short_term(mix_, 3.0, 3.0)
    print(f"  {'MIX':9s} " + " ".join(f"{x:4.0f}" for x in st))
    for k, v in sorted(TAGS.items()):
        write_wav24(os.path.join(sd, f"part_{k}.wav"), np.clip(v.x[:, :n_out] * g, -1, 1))
        ts, st = short_term(v.x[:, :n_out] * g, 3.0, 3.0)
        print(f"  .{k:8s} " + " ".join(f"{x:4.0f}" if x > -60 else "   ." for x in st))
