#!/usr/bin/env python3
"""Look at the mix without ears: loudness, per-bar level, band balance, clipping,
and a spectrogram + waveform picture (out/audio_report.png).

    python3 audio/report.py [out/audio.wav] [--ref other.wav]

Reference points from the two finished reels: integrated about -12.5 LUFS,
groove bars around -10 to -11 dB RMS, builds dipping no more than ~5 dB,
20-60 Hz carrying most of the energy (these mixes are sub-heavy by design).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BANDS = [(20, 60), (60, 120), (120, 250), (250, 500), (500, 1000), (1000, 2000), (2000, 4000), (4000, 8000), (8000, 16000)]


def load(path):
    with wave.open(path) as w:
        n, ch, sw, sr = w.getnframes(), w.getnchannels(), w.getsampwidth(), w.getframerate()
        raw = w.readframes(n)
    if sw == 3:
        a = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        x = a[:, 0] | (a[:, 1] << 8) | (a[:, 2] << 16)
        x = np.where(x >= 2 ** 23, x - 2 ** 24, x) / 2 ** 23
    elif sw == 2:
        x = np.frombuffer(raw, dtype="<i2") / 2 ** 15
    else:
        raise SystemExit(f"unsupported sample width {sw}")
    return x.reshape(-1, ch), sr


def lufs(path):
    if not shutil.which("ffmpeg"):
        return None
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True)
    m = re.findall(r"I:\s+(-?[\d.]+) LUFS", r.stderr)
    return float(m[-1]) if m else None


def report(path, bar):
    x, sr = load(path)
    mono = x.mean(axis=1)
    peak = 20 * np.log10(np.max(np.abs(x)) + 1e-12)
    clipped = int(np.sum(np.abs(x) >= 0.999))
    print(f"== {os.path.relpath(path)}  {len(mono) / sr:.3f}s  peak {peak:.1f} dBFS  clipped samples {clipped}")
    L = lufs(path)
    if L is not None:
        print(f"   integrated loudness {L:.1f} LUFS")
    X = np.abs(np.fft.rfft(mono * np.hanning(len(mono)))) ** 2
    f = np.fft.rfftfreq(len(mono), 1 / sr)
    tot = X.sum() + 1e-20
    print("   bands  " + "  ".join(f"{a}-{c}:{10 * np.log10(X[(f >= a) & (f < c)].sum() / tot + 1e-12):5.1f}" for a, c in BANDS))
    w = int(round(bar * sr))
    rms = [20 * np.log10(np.sqrt(np.mean(mono[i:i + w] ** 2)) + 1e-9) for i in range(0, len(mono) - w + 1, w)]
    print("   RMS per bar (dB): " + " ".join(f"{v:.0f}" for v in rms))
    if any(np.isnan(mono)):
        print("   !! NaN samples found")


def picture(path, out_png):
    if not shutil.which("ffmpeg"):
        return
    tmp_s, tmp_w = out_png + ".s.png", out_png + ".w.png"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", path, "-lavfi", "showspectrumpic=s=1800x500:legend=1:scale=log:fscale=log:color=intensity", tmp_s], check=True)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", path, "-lavfi", "showwavespic=s=1800x240:colors=white", tmp_w], check=True)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", tmp_s, "-i", tmp_w, "-filter_complex", "[0]scale=1800:-1[a];[a][1]vstack=inputs=2", out_png], check=True)
    os.remove(tmp_s)
    os.remove(tmp_w)
    print(f"   picture: {os.path.relpath(out_png)}")


if __name__ == "__main__":
    args = sys.argv[1:]
    ref = None
    if "--ref" in args:
        i = args.index("--ref")
        ref = args[i + 1]
        del args[i:i + 2]
    path = args[0] if args else os.path.join(HERE, "..", "out", "audio.wav")
    cues = json.load(open(os.path.join(HERE, "cues.json")))
    bar = cues["beat"] * 4
    report(path, bar)
    picture(path, os.path.join(os.path.dirname(os.path.abspath(path)), "audio_report.png"))
    if ref:
        report(ref, bar)
