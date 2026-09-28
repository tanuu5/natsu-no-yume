"""Building blocks for the score: band-limited oscillators, filters, envelopes,
a stereo bus, drums and synths, reverb and the master chain. Everything is made
from oscillators and noise — no samples.
"""
import numpy as np
from scipy import signal

SR = 48000
TAU = 2 * np.pi
RNG = np.random.default_rng(20230314)


def midi(m):
    return 440.0 * 2.0 ** ((np.asarray(m, dtype=float) - 69.0) / 12.0)


def tt(dur):
    return np.arange(int(round(dur * SR))) / SR


def noise(dur):
    return RNG.uniform(-1.0, 1.0, int(round(dur * SR)))


# ----------------------------------------------------------------------------
# Oscillators
# ----------------------------------------------------------------------------
def phase(freq, n):
    f = np.broadcast_to(np.asarray(freq, dtype=float), (n,))
    return np.cumsum(f) / SR, f


def sine(freq, dur, ph0=0.0):
    n = int(round(dur * SR))
    ph, _ = phase(freq, n)
    return np.sin(TAU * ph + ph0)


def _blep(t, dt):
    y = np.zeros_like(t)
    m1 = t < dt
    x = t[m1] / dt[m1]
    y[m1] = x + x - x * x - 1.0
    m2 = t > 1.0 - dt
    x = (t[m2] - 1.0) / dt[m2]
    y[m2] = x * x + x + x + 1.0
    return y


def saw(freq, dur, ph0=0.0):
    n = int(round(dur * SR))
    ph, f = phase(freq, n)
    p = (ph + ph0) % 1.0
    dt = np.maximum(f / SR, 1e-6)
    return 2.0 * p - 1.0 - _blep(p, dt)


def square(freq, dur, pw=0.5, ph0=0.0):
    n = int(round(dur * SR))
    ph, f = phase(freq, n)
    dt = np.maximum(f / SR, 1e-6)
    p1 = (ph + ph0) % 1.0
    p2 = (ph + ph0 + pw) % 1.0
    s1 = 2.0 * p1 - 1.0 - _blep(p1, dt)
    s2 = 2.0 * p2 - 1.0 - _blep(p2, dt)
    return 0.5 * (s1 - s2)


def supersaw(freq, dur, voices=7, detune=0.18, seed=0):
    """Returns stereo (2, n)."""
    r = np.random.default_rng(seed)
    n = int(round(dur * SR))
    L = np.zeros(n)
    R = np.zeros(n)
    for v in range(voices):
        k = (v - (voices - 1) / 2) / ((voices - 1) / 2 or 1)
        cents = k * detune * 100 * (0.7 + 0.3 * r.random())
        s = saw(freq * 2 ** (cents / 1200), dur, ph0=r.random())
        pan = k * 0.8
        L += s * np.cos((pan + 1) * np.pi / 4)
        R += s * np.sin((pan + 1) * np.pi / 4)
    return np.stack([L, R]) / np.sqrt(voices)


# ----------------------------------------------------------------------------
# Filters
# ----------------------------------------------------------------------------
def biquad(kind, f0, q=0.707, gain_db=0.0):
    f0 = min(max(f0, 10.0), SR * 0.45)
    w = TAU * f0 / SR
    cw, sw = np.cos(w), np.sin(w)
    alpha = sw / (2 * q)
    A = 10 ** (gain_db / 40)
    if kind == "lp":
        bb = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]
        aa = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "hp":
        bb = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
        aa = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "bp":
        bb = [alpha, 0, -alpha]
        aa = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "peak":
        bb = [1 + alpha * A, -2 * cw, 1 - alpha * A]
        aa = [1 + alpha / A, -2 * cw, 1 - alpha / A]
    elif kind == "lowshelf":
        sq = 2 * np.sqrt(A) * alpha
        bb = [A * ((A + 1) - (A - 1) * cw + sq), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - sq)]
        aa = [(A + 1) + (A - 1) * cw + sq, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sq]
    elif kind == "highshelf":
        sq = 2 * np.sqrt(A) * alpha
        bb = [A * ((A + 1) + (A - 1) * cw + sq), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - sq)]
        aa = [(A + 1) - (A - 1) * cw + sq, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sq]
    else:
        raise ValueError(kind)
    return np.array(bb) / aa[0], np.array(aa) / aa[0]


def filt(x, kind, f0, q=0.707, gain_db=0.0):
    bb, aa = biquad(kind, f0, q, gain_db)
    return signal.lfilter(bb, aa, x, axis=-1)


def _svf_loop(x, g, k, mode):
    n = x.shape[0]
    out = np.empty(n)
    ic1 = 0.0
    ic2 = 0.0
    for i in range(n):
        gi = g[i]
        a1 = 1.0 / (1.0 + gi * (gi + k))
        v3 = x[i] - ic2
        v1 = a1 * ic1 + gi * a1 * v3
        v2 = ic2 + gi * v1
        ic1 = 2.0 * v1 - ic1
        ic2 = 2.0 * v2 - ic2
        if mode == 0:
            out[i] = v2
        elif mode == 1:
            out[i] = v1
        else:
            out[i] = x[i] - k * v1 - v2
    return out


try:  # optional JIT; the result is the same either way
    from numba import njit
    _svf_loop = njit(cache=True)(_svf_loop)
except Exception:  # noqa: BLE001
    pass


def svf(x, cutoff, q=0.707, mode="lp"):
    """Topology-preserving state variable filter with per-sample cutoff."""
    x = np.ascontiguousarray(x, dtype=float)
    n = x.shape[-1]
    fc = np.broadcast_to(np.asarray(cutoff, dtype=float), (n,))
    g = np.ascontiguousarray(np.tan(np.pi * np.clip(fc, 10.0, SR * 0.45) / SR))
    return _svf_loop(x, g, 1.0 / q, {"lp": 0, "bp": 1}.get(mode, 2))


def svf_st(x, cutoff, q=0.707, mode="lp"):
    return np.stack([svf(x[0], cutoff, q, mode), svf(x[1], cutoff, q, mode)])


# ----------------------------------------------------------------------------
# Envelopes
# ----------------------------------------------------------------------------
def env_ad(dur, a, d, curve=1.0):
    t = tt(dur)
    att = np.clip(t / max(a, 1e-5), 0, 1)
    dec = np.exp(-np.maximum(t - a, 0) / max(d, 1e-5))
    return att * dec ** curve


def env_asr(dur, a, r):
    t = tt(dur)
    e = np.clip(t / max(a, 1e-5), 0, 1) * np.clip((dur - t) / max(r, 1e-5), 0, 1)
    return e


def mx(*xs):
    """Sum mono signals of different lengths."""
    n = max(len(x) for x in xs)
    out = np.zeros(n)
    for x in xs:
        out[: len(x)] += x
    return out


def fade(x, fi=0.002, fo=0.01):
    n = x.shape[-1]
    e = np.ones(n)
    a = int(fi * SR)
    z = int(fo * SR)
    if a > 0:
        e[:a] = np.linspace(0, 1, a)
    if z > 0:
        e[-z:] *= np.linspace(1, 0, z)
    return x * e


# ----------------------------------------------------------------------------
# Mixer
# ----------------------------------------------------------------------------
class Bus:
    def __init__(self, name, n):
        self.name = name
        self.n = n
        self.x = np.zeros((2, n))

    def add(self, sig, t, gain=1.0, pan=0.0):
        if sig.ndim == 1:
            gl = np.cos((pan + 1) * np.pi / 4) * np.sqrt(2)
            gr = np.sin((pan + 1) * np.pi / 4) * np.sqrt(2)
            st = np.stack([sig * gl, sig * gr])
        else:
            st = sig
            if pan:
                st = np.stack([sig[0] * min(1, 1 - pan), sig[1] * min(1, 1 + pan)])
        i0 = int(round(t * SR))
        s0 = 0
        if i0 < 0:
            s0 = -i0
            i0 = 0
        n = min(st.shape[1] - s0, self.n - i0)
        if n <= 0:
            return
        self.x[:, i0:i0 + n] += st[:, s0:s0 + n] * gain


# ----------------------------------------------------------------------------
# Instruments
# ----------------------------------------------------------------------------
def kick(big=False):
    dur = 0.6 if big else 0.42
    t = tt(dur)
    f = 44 + 120 * np.exp(-t / 0.028) + 260 * np.exp(-t / 0.0035)
    body = np.sin(TAU * np.cumsum(f) / SR) * np.exp(-t / (0.42 if big else 0.26)) * (1 - np.exp(-t / 0.0012))
    click = filt(noise(dur), "hp", 2500) * np.exp(-t / 0.0018) * 0.45
    x = np.tanh((body + click) * 1.8) / np.tanh(1.8)
    return fade(x, 0.0005, 0.02)


def clap():
    dur = 0.4
    t = tt(dur)
    n = noise(dur)
    e = np.zeros_like(t)
    for o in (0.0, 0.009, 0.019, 0.028):
        e += (t >= o) * np.exp(-np.maximum(t - o, 0) / 0.0055)
    e += (t > 0.03) * np.exp(-np.maximum(t - 0.03, 0) / 0.12) * 0.55
    x = filt(n * e, "bp", 1250, 0.8) * 1.6 + filt(n * e, "hp", 4000) * 0.35
    return fade(x, 0.0003, 0.02)


def hat(open_=False):
    dur = 0.3 if open_ else 0.06
    t = tt(dur)
    n = noise(dur)
    metal = sum(square(f, dur) for f in (3120, 4350, 5870, 7230)) * 0.12
    x = filt(n * 0.8 + metal, "hp", 7200) * np.exp(-t / (0.11 if open_ else 0.018))
    return fade(x, 0.0003, 0.005)


def snare(tone=1.0):
    dur = 0.3
    t = tt(dur)
    f = 190 * tone * (1 + 0.6 * np.exp(-t / 0.012))
    body = np.sin(TAU * np.cumsum(f) / SR) * np.exp(-t / 0.07)
    body += np.sin(TAU * np.cumsum(f * 1.72) / SR) * np.exp(-t / 0.04) * 0.4
    sn = filt(noise(dur), "bp", 3200 * tone, 0.7) * np.exp(-t / 0.11) * 1.4
    sn += filt(noise(dur), "hp", 6000) * np.exp(-t / 0.05) * 0.4
    return fade(np.tanh((body * 0.8 + sn) * 1.3), 0.0003, 0.02)


def tock(pitch=1.0):
    dur = 0.12
    t = tt(dur)
    x = (np.sin(TAU * 920 * pitch * t) * np.exp(-t / 0.028)
         + 0.6 * np.sin(TAU * 1540 * pitch * t) * np.exp(-t / 0.016)
         + 0.25 * np.sin(TAU * 2390 * pitch * t) * np.exp(-t / 0.01))
    x += filt(noise(dur), "bp", 3000 * pitch, 2.0) * np.exp(-t / 0.003) * 0.6
    return fade(x, 0.0002, 0.01)


def boom(dur=1.8, f0=72, f1=28, decay=0.9):
    t = tt(dur)
    f = f1 + (f0 - f1) * np.exp(-t / 0.35)
    x = np.sin(TAU * np.cumsum(f) / SR) * np.exp(-t / decay) * (1 - np.exp(-t / 0.002))
    x += filt(noise(dur), "lp", 900) * np.exp(-t / 0.12) * 0.9
    x += filt(noise(dur), "hp", 3000) * np.exp(-t / 0.006) * 0.5
    return fade(np.tanh(x * 1.4), 0.0005, 0.05)


def crash(dur=2.4):
    t = tt(dur)
    n = noise(dur)
    partials = sum(np.sin(TAU * f * t + RNG.random() * TAU) for f in (3180, 4210, 5370, 6890, 8210, 9730, 11400)) / 7
    x = filt(n + partials * 0.5, "hp", 4200) * np.exp(-t / 0.75)
    x += filt(n, "bp", 9000, 0.5) * np.exp(-t / 0.35) * 0.5
    L = x
    R = np.roll(filt(n[::-1], "hp", 4200), 7) * np.exp(-t / 0.75) * 0.9 + partials * np.exp(-t / 0.75) * 0.1
    return fade(np.stack([L, R]) * 0.55, 0.0005, 0.2)


def whoosh(dur, f_lo=300, f_hi=6000, up=True, q=1.2):
    t = tt(dur)
    u = t / dur
    fc = f_lo * (f_hi / f_lo) ** (u if up else 1 - u)
    env = np.sin(np.pi * np.clip(u, 0, 1)) ** 1.5
    x = svf(noise(dur), fc, q, "bp") * env
    return fade(x * 1.8, 0.005, 0.02)


def riser(dur, f_lo=400, f_hi=9000):
    t = tt(dur)
    u = t / dur
    fc = f_lo * (f_hi / f_lo) ** (u ** 1.6)
    nz = svf(noise(dur), fc, 2.5, "bp") * (u ** 2.2) * 2.2
    pitch = midi(60) * 2 ** (u ** 1.5 * 1.0) * (1 + 0.012 * np.sin(TAU * (4 + 10 * u) * t))
    tone = (saw(pitch, dur) + saw(pitch * 1.5, dur) * 0.6 + saw(pitch * 2.0, dur) * 0.5)
    tone = svf(tone, 400 + 6000 * u ** 2, 1.2, "lp") * (u ** 2.5) * 0.35
    return nz + tone


def reverse_swell(dur=0.45, bright=1.0):
    c = crash(dur + 0.2)
    x = c[:, :int(dur * SR)][:, ::-1]
    e = np.linspace(0, 1, x.shape[1]) ** 2.5
    return x * e * 1.4 * bright


def pluck(m, dur=0.26, bright=1.0):
    t = tt(dur)
    f = midi(m)
    x = saw(f, dur) * 0.6 + square(f * 1.003, dur, 0.3) * 0.4
    x = svf(x, 700 + 5200 * bright * np.exp(-t / 0.06), 1.4, "lp")
    return fade(x * np.exp(-t / 0.11), 0.001, 0.02)


def blip(freq, dur=0.05, decay=0.015):
    t = tt(dur)
    return fade(np.sin(TAU * freq * t) * np.exp(-t / decay), 0.0005, 0.005)


def bell(f0, dur=2.5):
    """Singing-bowl: inharmonic partials with slow beating."""
    t = tt(dur)
    x = np.zeros_like(t)
    for ratio, amp, dec in ((1.0, 1.0, 1.6), (2.71, 0.55, 1.0), (5.13, 0.3, 0.6), (8.41, 0.18, 0.35), (1.003, 0.6, 1.8)):
        x += amp * np.sin(TAU * f0 * ratio * t + RNG.random() * TAU) * np.exp(-t / dec)
    x *= 1 - np.exp(-t / 0.004)
    return fade(x * 0.35, 0.001, 0.2)


def fm_bell(f0, dur=0.6, idx=3.0, ratio=3.5):
    t = tt(dur)
    mod = np.sin(TAU * f0 * ratio * t) * idx * np.exp(-t / 0.15)
    return fade(np.sin(TAU * f0 * t + mod) * np.exp(-t / 0.25), 0.0005, 0.05)


def chord_pad(notes, dur, cutoff=1600, seed=0, attack=0.04, release=0.25, detune=0.16):
    x = np.zeros((2, int(round(dur * SR))))
    for i, m in enumerate(notes):
        x += supersaw(midi(m), dur, voices=7, detune=detune, seed=seed + i)
    x /= np.sqrt(len(notes))
    c = np.broadcast_to(np.asarray(cutoff, dtype=float), (x.shape[1],))
    x = svf_st(x, c, 0.9, "lp")
    return x * env_asr(dur, attack, release)


def stab(notes, dur=0.5, bright=6000):
    t = tt(dur)
    x = np.zeros((2, len(t)))
    for i, m in enumerate(notes):
        x += supersaw(midi(m), dur, voices=5, detune=0.12, seed=40 + i)
    x = svf_st(x / np.sqrt(len(notes)), 500 + bright * np.exp(-t / 0.09), 1.1, "lp")
    return x * np.exp(-t / 0.2) * (1 - np.exp(-t / 0.002))


def glitch_burst(dur=0.22):
    n = int(dur * SR)
    x = np.zeros(n)
    i = 0
    while i < n:
        seg = int(RNG.integers(200, 1400))
        kind = RNG.integers(0, 3)
        tseg = np.arange(seg) / SR
        if kind == 0:
            s = np.sign(np.sin(TAU * RNG.uniform(200, 2000) * tseg))
        elif kind == 1:
            s = np.repeat(RNG.uniform(-1, 1, seg // 24 + 1), 24)[:seg]
        else:
            s = np.sin(TAU * RNG.uniform(60, 400) * tseg) * 1.5
        # stutter: repeat a slice
        if RNG.random() < 0.4:
            sl = s[: max(40, seg // 6)]
            s = np.tile(sl, seg // len(sl) + 1)[:seg]
        x[i:i + seg] = s[: min(seg, n - i)]
        i += seg
    x = np.round(x * 6) / 6
    return fade(x * 0.45, 0.001, 0.02)


def chirp8(notes, step=0.028):
    out = []
    for m in notes:
        out.append(square(midi(m), step, 0.25) * np.exp(-tt(step) / 0.05))
    return fade(np.concatenate(out) * 0.35, 0.0005, 0.01)


def bloop(f0=900, f1=180, dur=0.16):
    t = tt(dur)
    f = f1 + (f0 - f1) * np.exp(-t / 0.03)
    x = np.sin(TAU * np.cumsum(f) / SR) * np.exp(-t / 0.06)
    return fade(x, 0.0005, 0.02)


def wub(m, dur=0.24, rate=16.0):
    t = tt(dur)
    x = saw(midi(m), dur) + saw(midi(m) * 1.01, dur)
    cut = 250 + 2200 * (0.5 + 0.5 * np.sin(TAU * rate * t - np.pi / 2))
    return fade(svf(x, cut, 3.0, "lp") * 0.5, 0.002, 0.03)


def zip_(dur=0.13):
    return whoosh(dur, 1800, 11000, True, 3.0) * 0.8


def creak(dur):
    t = tt(dur)
    u = t / dur
    f = 150 + 330 * u ** 1.5 + 18 * np.sin(TAU * 23 * t)
    x = saw(f, dur) * 0.3 + np.sin(TAU * np.cumsum(f * 2) / SR) * 0.2
    return svf(x, 900 + 1400 * u, 4.0, "bp") * u ** 1.2


def boing(dur=0.26):
    t = tt(dur)
    f = 180 * 2 ** (t / dur * 2.2) * (1 + 0.18 * np.sin(TAU * 17 * t) * np.exp(-t / 0.1))
    return fade(np.sin(TAU * np.cumsum(f) / SR) * np.exp(-t / 0.2) * 0.8, 0.0005, 0.03)


def sparkle(dur, density=90, lo=2500, hi=9000):
    x = np.zeros((2, int(dur * SR)))
    k = int(density * dur)
    for _ in range(k):
        t0 = RNG.uniform(0, dur - 0.05)
        f = RNG.uniform(lo, hi)
        g = blip(f, 0.04, RNG.uniform(0.004, 0.012)) * RNG.uniform(0.05, 0.25)
        pan = RNG.uniform(-1, 1)
        i0 = int(t0 * SR)
        x[0, i0:i0 + len(g)] += g * np.cos((pan + 1) * np.pi / 4)
        x[1, i0:i0 + len(g)] += g * np.sin((pan + 1) * np.pi / 4)
    return x
