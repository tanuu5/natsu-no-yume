"""Places and creatures of a Japanese seaside town in summer, synthesised from
oscillators and seeded noise (no samples).

Beds (return stereo, RMS about 0.1 = -20 dBFS):
    breeze, rustle, trickle, surf_distant, seawall, lapping, abura (cicada bed)
Calls / events (return mono, peak about 0.5 unless noted):
    kite_call (トンビ), uguisu_call (ウグイス), gull_call (ウミネコ), sparrow_chirp,
    minmin_song (ミンミンゼミ), higurashi_phrase (ヒグラシ), frog notes / frog_chorus,
    furin_strike (風鈴), crossing_strike (踏切), creak / boat_knock,
    train parts: diesel, rail_rumble, clack, squeal, air_hiss, door, door_chime, horn,
    outboard, wind_swell (for the dissolves)

Each generator takes an explicit numpy Generator so the result never depends on
the order things are rendered in.
"""
import numpy as np
from scipy import signal

from dsp import SR, TAU, svf, filt, saw
from instruments import seeded, sstep, pan2, smooth_rand, onepole, edge, _partials


# ----------------------------------------------------------------------------
# Noise colours and helpers
# ----------------------------------------------------------------------------
def pink(n, r):
    b = [0.049922035, -0.095993537, 0.050612699, -0.004408786]
    a = [1.0, -2.494956002, 2.017265875, -0.522189400]
    x = signal.lfilter(b, a, r.standard_normal(n))
    return x / (np.std(x) + 1e-12)


def brown(n, r):
    x = signal.lfilter([1.0], [1.0, -0.997], r.standard_normal(n))
    x = filt(x, "hp", 20.0)
    return x / (np.std(x) + 1e-12)


def bpc(x, fc, q=2.0, order=2):
    """Cascaded state-variable band-pass (4th order by default), ~unity gain at fc."""
    for _ in range(order):
        x = svf(x, fc, q, "bp") / q
    return x


def tame(x, k=4.0):
    """Soft-limit rare peaks of a noisy bed to about k times its RMS (tanh knee)."""
    thr = k * np.sqrt(np.mean(x ** 2)) + 1e-12
    return thr * np.tanh(x / thr)


def norm_rms(x, target=0.1):
    return x * (target / (np.sqrt(np.mean(x ** 2)) + 1e-12))


def norm_peak(x, target=0.5):
    return x * (target / (np.max(np.abs(x)) + 1e-12))


def keyframes(t, keys):
    """Linear interpolation of keyframes [(time, v0, v1, ...), ...] -> arrays."""
    k = np.array(keys, dtype=float)
    return [np.interp(t, k[:, 0], k[:, j]) for j in range(1, k.shape[1])]


def event_times(rate, r):
    """Times (s) of an inhomogeneous Poisson process; rate = per-sample array (events/s)."""
    cum = np.cumsum(rate) / SR
    k = r.poisson(cum[-1])
    u = np.sort(r.uniform(0, cum[-1], k))
    return np.searchsorted(cum, u) / SR


def add_at(buf, x, t):
    i = int(round(t * SR))
    if i >= buf.shape[-1]:
        return
    s0 = 0
    if i < 0:
        s0, i = -i, 0
    m = min(x.shape[-1] - s0, buf.shape[-1] - i)
    if m > 0:
        buf[..., i:i + m] += x[..., s0:s0 + m]


def distance_filter(x, d, ref=5.0, air=12000.0):
    """Inverse-distance level and air absorption (fixed distance)."""
    g = ref / max(d, ref * 0.5)
    fc = float(np.clip(air * (ref / d) ** 0.6, 1500.0, 16000.0))
    return filt(x, "lp", fc, 0.6) * g


# ----------------------------------------------------------------------------
# Air: breeze, rustling leaves/rice, a swell of wind for the dissolves
# ----------------------------------------------------------------------------
def breeze(dur, r, lo=450.0, hi=1600.0, gust_rate=0.11, depth=0.7, width=0.85, hp=140.0):
    """Air moving through foliage: pink noise through a gust-driven low-pass, the
    sub-bass (microphone-like buffeting) removed. Returns (stereo, gust curve)."""
    n = int(dur * SR)
    g = 1.0 - depth + depth * smooth_rand(n, gust_rate, r) ** 1.5
    g *= 0.85 + 0.15 * smooth_rand(n, gust_rate * 3.3, r)
    fc = lo + (hi - lo) * g ** 1.2
    ch = [filt(filt(svf(pink(n, r), fc, 0.55, "lp"), "hp", hp, 0.6), "hp", hp, 0.6) for _ in range(2)]
    M = (ch[0] + ch[1]) * 0.5
    S = (ch[0] - ch[1]) * 0.5 * width
    out = np.stack([M + S, M - S]) * g
    return norm_rms(out), g


def rustle(dur, r, gust, density=18.0, fc=2600.0):
    """Leaves / rice blades brushing: soft overlapping 'shh' grains whose rate follows the gusts."""
    n = int(dur * SR)
    out = []
    ka = int(0.006 * SR)
    kern = np.concatenate([np.hanning(2 * ka)[:ka], np.exp(-np.arange(int(0.12 * SR)) / (0.03 * SR))])
    for _ in range(2):
        rate = density * (0.15 + gust ** 2.2)
        imp = (r.random(n) < rate / SR) * r.uniform(0.2, 1.0, n)
        env = signal.fftconvolve(imp, kern)[:n]
        x = filt(bpc(r.standard_normal(n), fc, 0.8, 1), "lp", 6500.0, 0.7) * env
        x += filt(r.standard_normal(n), "bp", fc * 0.8, 0.5) * gust ** 2 * 0.08
        out.append(x)
    return norm_rms(np.stack(out))


def wind_swell(dur, r, f_lo=260.0, f_hi=950.0):
    """A breath of wind rising and falling (bridges the dissolves)."""
    n = int(dur * SR)
    u = np.arange(n) / n
    env = np.sin(np.pi * u) ** 2
    fc = f_lo + (f_hi - f_lo) * np.sin(np.pi * u) ** 1.5
    ch = [svf(pink(n, r), fc, 0.9, "bp") for _ in range(2)]
    out = np.stack(ch) * env
    return edge(norm_rms(out, 0.1), 0.05, 0.05)


# ----------------------------------------------------------------------------
# Water
# ----------------------------------------------------------------------------
def trickle(dur, r, rate=60.0, fmin=450.0, fmax=2400.0, bed=0.12):
    """Water trickling between terraces: many small bubbles (rising 'plinks') + a soft bed."""
    n = int(dur * SR)
    x = np.zeros(n)
    rc = rate * (0.3 + 0.95 * smooth_rand(n, 0.8, r) ** 2)
    for t0 in event_times(rc, r):
        f0 = np.exp(r.uniform(np.log(fmin), np.log(fmax)))
        tau = 0.003 + 9.0 / f0 * r.uniform(0.7, 1.3)
        L = int(tau * 6 * SR)
        i = int(t0 * SR)
        if i + L >= n:
            continue
        tt = np.arange(L) / SR
        f = f0 * (1.0 + r.uniform(0.05, 0.3) * tt / tau)
        s = np.sin(TAU * np.cumsum(f) / SR) * np.exp(-tt / tau) * sstep(tt / 0.0007)
        x[i:i + L] += s * (1000.0 / f0) ** 0.5 * r.lognormal(0.0, 0.5)
    b = filt(r.standard_normal(n), "bp", 1000.0, 0.6) * (0.5 + 0.5 * smooth_rand(n, 6.0, r))
    y = norm_rms(x, 1.0) + norm_rms(b, 1.0) * bed
    return norm_rms(filt(y, "hp", 200.0), 0.1)


def water_drop(r, f0=None, big=1.0):
    """A single drop falling into still water ('pochan'): a soft impact tick, the crater's
    low 'po', the entrained bubble ringing with a rising pitch ('-chan'), a smaller second
    bubble, and a few droplets falling back."""
    f0 = f0 or r.uniform(720.0, 880.0)
    n = int(0.6 * SR)
    t = np.arange(n) / SR
    nz = r.standard_normal(n)
    tick = filt(nz, "bp", 2400.0, 0.7) * np.exp(-t / 0.0012) * 0.3
    po = np.sin(TAU * np.cumsum(240.0 + 60.0 * np.exp(-t / 0.01)) / SR) * sstep(t / 0.002) * np.exp(-t / 0.018) * 0.35 * big
    d = np.maximum(t - 0.006, 0.0)
    f = f0 * (1.0 + 0.9 * (1.0 - np.exp(-d / 0.028)))
    bub = np.sin(TAU * np.cumsum(f) / SR) * sstep((t - 0.006) / 0.0015) * np.exp(-d / 0.05)
    d2 = np.maximum(t - 0.034, 0.0)
    f2 = f0 * 1.85 * (1.0 + 0.5 * (1.0 - np.exp(-d2 / 0.02)))
    bub2 = np.sin(TAU * np.cumsum(f2) / SR) * sstep((t - 0.034) / 0.0015) * np.exp(-d2 / 0.022) * 0.32
    x = tick + po + bub + bub2
    for _ in range(int(r.integers(2, 5))):              # droplets falling back
        td = r.uniform(0.09, 0.3)
        fd = r.uniform(1800.0, 3200.0)
        dd = np.maximum(t - td, 0.0)
        x += np.sin(TAU * fd * (1.0 + 0.3 * dd / 0.01) * dd) * sstep((t - td) / 0.001) * np.exp(-dd / 0.009) * r.uniform(0.04, 0.1)
    return norm_peak(edge(filt(x, "hp", 120.0), 0.0005, 0.08))


def surf_distant(dur, r, period=(6.0, 9.5), width=0.9):
    """Far-off waves on a beach: low rolling swells with a delayed foam hiss."""
    n = int(dur * SR)
    env = np.zeros(n)
    foam = np.zeros(n)
    tk = r.uniform(-4.0, 0.0)
    t = np.arange(n) / SR
    while tk < dur:
        a = r.uniform(0.6, 1.0)
        d = t - tk
        rise = sstep((d + 2.0) / 2.0)
        fall = np.exp(-np.maximum(d, 0) / r.uniform(2.5, 3.8))
        env += a * rise * fall * (d > -2.0)
        foam += a * sstep((d - 0.2) / 0.5) * np.exp(-np.maximum(d - 0.2, 0) / 1.8) * (d > 0.2)
        tk += r.uniform(*period)
    out = []
    for _ in range(2):
        lo = svf(brown(n, r), 380.0 + 220.0 * env, 0.6, "lp") * (0.25 + env)
        hi = filt(r.standard_normal(n), "bp", 1600.0, 0.5) * foam * 0.12
        out.append(lo + hi)
    M = (out[0] + out[1]) * 0.5
    S = (out[0] - out[1]) * 0.5 * width
    return norm_rms(np.stack([M + S, M - S]))


def seawall(dur, r, period=(6.5, 9.0)):
    """Waves meeting a concrete sea wall: swell, slap, spray, a bubbly receding wash.
    Returns (stereo, list of impact times)."""
    n = int(dur * SR)
    out = np.zeros((2, n))
    hits = []
    tk = r.uniform(0.5, 3.0)
    while tk < dur - 0.2:
        a = r.uniform(0.55, 1.0)
        hits.append(tk)
        L = int(5.0 * SR)
        tt = np.arange(L) / SR - 1.4          # impact at tt = 0
        pre = sstep((tt + 1.4) / 1.4) * (tt < 0) + (tt >= 0) * np.exp(-np.maximum(tt, 0) / 0.35)
        for c in range(2):
            nz = r.standard_normal(L)
            d = np.maximum(tt, 0.0)
            on = sstep(tt / 0.025)                                   # the slap has a soft front
            swell = svf(brown(L, r), 240.0 + 380.0 * sstep((tt + 1.4) / 1.4), 0.7, "lp") * pre * 0.9
            imp = filt(nz, "bp", 520.0, 0.7) * on * np.exp(-d / 0.18) * 1.3
            thump = np.sin(TAU * 70.0 * d) * sstep(tt / 0.01) * np.exp(-d / 0.14) * 0.8
            spray = filt(filt(nz, "hp", 1800.0), "lp", 7000.0) * on * np.exp(-d / 0.3) * 0.16
            bub = (r.random(L) < 0.012) * r.uniform(0.3, 1.0, L)
            bub = signal.lfilter([1.0], [1.0, -np.exp(-1.0 / (0.008 * SR))], bub)
            wash = filt(filt(nz, "bp", 900.0, 0.55), "lp", 4500.0) * (0.45 + bub * 1.6) * sstep((tt - 0.1) / 0.4) \
                * np.exp(-np.maximum(tt - 0.1, 0) / 1.5) * 0.45
            x = (swell + imp + thump + spray + wash) * a
            add_at(out[c], edge(x, 0.02, 0.3), tk - 1.4)
        tk += r.uniform(*period)
    return norm_rms(tame(out, 4.0)), hits


def lapping(dur, r, rate=2.6, period=4.6):
    """Small water slapping against a quay and hulls ('chapu chapu') with gurgles."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    sw = 0.5 + 0.5 * np.sin(TAU * t / period + r.uniform(0, TAU) + 0.8 * smooth_rand(n, 0.3, r, -1, 1))
    out = np.zeros((2, n))
    for t0 in event_times(rate * (0.25 + 1.5 * sw ** 2), r):
        L = int(0.35 * SR)
        tt = np.arange(L) / SR
        f = r.uniform(240.0, 800.0)
        dec = r.uniform(0.035, 0.12)
        x = filt(r.standard_normal(L), "bp", f, r.uniform(1.2, 2.6)) * sstep(tt / 0.003) * np.exp(-tt / dec)
        if r.random() < 0.18:  # a small gurgle: a bubble whose pitch rises as it surfaces
            f0 = r.uniform(280.0, 520.0)
            fg = f0 * (1.0 + 0.6 * tt / 0.05)
            x += np.sin(TAU * np.cumsum(fg) / SR) * sstep(tt / 0.002) * np.exp(-tt / 0.03) * 0.1
        x *= min(r.lognormal(0.0, 0.35), 1.6) / (np.max(np.abs(x)) + 1e-9)
        add_at(out, pan2(edge(x, 0.001, 0.02), r.uniform(-0.75, 0.75)), t0)
    b = np.stack([filt(r.standard_normal(n), "bp", 420.0, 0.8) for _ in range(2)])
    out = norm_rms(out, 1.0) + norm_rms(b, 1.0) * (0.2 + 0.5 * sw) * 0.35
    return norm_rms(tame(filt(out, "hp", 90.0), 3.5))


# ----------------------------------------------------------------------------
# Birds
# ----------------------------------------------------------------------------
def _whistle(t, f, amp, r, h2=0.08, h3=0.02, breath=0.04):
    ph = TAU * np.cumsum(f) / SR
    s = np.sin(ph) + h2 * np.sin(2 * ph + 0.4) + h3 * np.sin(3 * ph + 1.1)
    if breath > 0:
        s += breath * bpc(r.standard_normal(len(t)), f, 6.0) * 6.0
    return s * amp


def kite_call(r, f_lo=2350.0, f_hi=2960.0, t_pii=0.82, t_roro=1.15, trill=11.0):
    """Black kite 'pii-hyororororo': a rising whistle, a quick dip, then a falling trill."""
    T1, T2 = t_pii, t_pii + 0.16
    T3 = T2 + t_roro
    n = int((T3 + 0.06) * SR)
    t = np.arange(n) / SR
    f = np.where(t < T1, f_lo * 0.95 + (f_hi - f_lo * 0.95) * (1 - (1 - np.clip(t / T1, 0, 1)) ** 2), f_hi)
    f = f * (1.0 + 0.004 * np.sin(TAU * 5.5 * t) * (t < T1))
    hy = (t >= T1) & (t < T2)
    f[hy] = f_hi * (1.0 - 0.11 * np.sin(np.pi * (t[hy] - T1) / (T2 - T1)))
    ro = t >= T2
    u = np.clip((t - T2) / t_roro, 0, 1)
    centre = f_hi * 0.99 + (f_lo * 0.9 - f_hi * 0.99) * u ** 0.8
    f[ro] = (centre * (1.0 + 0.045 * np.sin(TAU * trill * (t - T2) * (1 - 0.15 * u))))[ro]
    f = onepole(f, 0.004)
    amp = np.interp(t, [0, 0.07, 0.6, T1, T1 + 0.06, T2, T2 + 0.1, T3], [0, 0.7, 1.0, 1.0, 0.7, 0.9, 0.85, 0.0])
    am = np.where(ro, 0.55 + 0.45 * (0.5 + 0.5 * np.cos(TAU * trill * (t - T2) * (1 - 0.15 * u))), 1.0)
    x = _whistle(t, f, amp * am, r, h2=0.09, h3=0.02, breath=0.035)
    return norm_peak(edge(x, 0.005, 0.03))


def uguisu_call(r, f_hoo=1180.0):
    """Bush warbler 'hoooo — ho-ke-kyo'."""
    K = [(0.0, f_hoo * 0.93, 0.0), (0.15, f_hoo * 0.97, 0.35), (1.0, f_hoo, 0.8), (1.34, f_hoo * 1.02, 1.0), (1.4, f_hoo * 1.06, 0.0),
         (1.56, 1450.0, 0.0), (1.58, 1520.0, 0.75), (1.64, 1540.0, 0.7), (1.66, 1600.0, 0.0),
         (1.69, 2000.0, 0.0), (1.705, 2500.0, 0.85), (1.745, 3600.0, 0.85), (1.755, 3700.0, 0.0),
         (1.79, 3300.0, 0.0), (1.81, 3650.0, 1.0), (1.87, 3500.0, 0.95), (2.05, 2700.0, 0.5), (2.13, 2450.0, 0.0)]
    n = int(2.2 * SR)
    t = np.arange(n) / SR
    f, a = keyframes(t, K)
    f = onepole(f, 0.002)
    x = _whistle(t, f, onepole(a, 0.003), r, h2=0.05, h3=0.01, breath=0.02)
    return norm_peak(edge(x, 0.005, 0.02))


def gull_call(r, f0=None, dur=None):
    """Black-tailed gull 'myaa-o': nasal, rough, cat-like."""
    f0 = f0 or r.uniform(520.0, 700.0)
    dur = dur or r.uniform(0.45, 0.75)
    n = int(dur * SR)
    t = np.arange(n) / SR
    u = t / dur
    fr, amp, F1, F2 = keyframes(u, [(0.0, 0.82, 0.0, 520, 2300), (0.06, 0.95, 0.8, 600, 2200), (0.2, 1.35, 1.0, 850, 1700),
                                    (0.45, 1.28, 0.9, 820, 1400), (0.8, 0.95, 0.6, 650, 1050), (1.0, 0.78, 0.0, 560, 900)])
    f = f0 * fr * (1.0 + 0.02 * smooth_rand(n, 25.0, r, -1, 1))
    src = saw(f, n / SR) * (1.0 + 0.35 * np.sin(TAU * r.uniform(65, 95) * t))
    y = svf(src, F1, 4.0, "bp") + 0.7 * svf(src, F2, 6.0, "bp") + 0.25 * svf(src, 2900.0, 8.0, "bp")
    return norm_peak(edge(y * amp, 0.01, 0.03))


def sparrow_chirp(r):
    """A small far-away chirp (tsun)."""
    d = r.uniform(0.06, 0.1)
    n = int(d * SR)
    t = np.arange(n) / SR
    f = r.uniform(3800, 4800) * (1.0 - 0.25 * t / d)
    a = np.sin(np.pi * t / d) ** 1.5
    return norm_peak(edge(_whistle(t, f, a, r, h2=0.2, h3=0.05, breath=0.08), 0.002, 0.005))


# ----------------------------------------------------------------------------
# Cicadas
# ----------------------------------------------------------------------------
def _pulse_train(n, rate, r, jitter=0.015, jrate=30.0, amp=(0.6, 1.0)):
    fr = rate * (1.0 + jitter * smooth_rand(n, jrate, r, -1, 1))
    ph = np.cumsum(fr) / SR
    fl = np.floor(ph)
    p = np.diff(fl, prepend=fl[0]) > 0
    return p * r.uniform(amp[0], amp[1], n)


def minmin_song(r, fc0=4150.0, prate=None, n_min=None, syl=None):
    """Robust cicada (ミンミンゼミ) 'jii — miiin min-min-min-min … mii': a buzzy tone
    (tymbal clicks exciting a ~4 kHz resonance) with a slow 'mi-n' vowel rhythm."""
    prate = prate or r.uniform(300.0, 380.0)
    n_min = n_min or int(r.integers(9, 15))
    syl = syl or r.uniform(0.27, 0.33)
    K = [(0.0, 0.0, 0.85, 0.7), (0.3, 0.2, 0.86, 0.7), (0.9, 0.45, 0.92, 0.5)]
    t = 0.9
    K += [(t + 0.10, 1.0, 1.04, 0.25), (t + 0.8, 0.95, 1.02, 0.2), (t + 1.0, 0.4, 0.9, 0.3), (t + 1.1, 0.36, 0.9, 0.3)]
    t += 1.1
    for _ in range(n_min):
        T = syl * r.uniform(0.96, 1.04)
        K += [(t + 0.035, 1.0, 1.07, 0.2), (t + 0.5 * T, 0.9, 1.02, 0.2), (t + 0.8 * T, 0.38, 0.9, 0.3), (t + T, 0.36, 0.9, 0.3)]
        t += T
    K += [(t + 0.1, 0.95, 1.03, 0.2), (t + 0.6, 0.7, 0.98, 0.25), (t + 1.3, 0.2, 0.9, 0.4), (t + 1.7, 0.0, 0.88, 0.5)]
    t += 1.7
    n = int(t * SR)
    tt = np.arange(n) / SR
    amp, fcr, nm = keyframes(tt, K)
    amp = onepole(amp, 0.008)
    fc = fc0 * onepole(fcr, 0.012)
    x = _pulse_train(n, prate, r)
    tone = bpc(x, fc, 9.0)
    nz = bpc(r.standard_normal(n), fc, 2.0)
    y = norm_rms(tone, 1.0) * (1.0 - nm) + norm_rms(nz, 1.0) * nm * 0.5
    y = filt(filt(y, "hp", 2000.0, 0.7), "hp", 2000.0, 0.7)
    y = filt(y, "lp", 7500.0, 0.7)
    return norm_peak(edge(y * amp, 0.01, 0.05))


def abura(dur, r, fc=5000.0, ramp=(1.5, 1.5), swell_rate=0.12, jiri=20.0):
    """Large brown cicada (アブラゼミ): a continuous frying sizzle 'jiri-jiri-jiri'."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = (r.random(n) < 900.0 / SR) * r.uniform(0.3, 1.0, n) + 0.12 * r.standard_normal(n)
    y = bpc(x, fc, 1.6) + 0.55 * bpc(x, fc * 1.55, 2.0)
    y = filt(filt(y, "hp", 2200.0, 0.7), "hp", 2200.0, 0.7)
    am = 0.5 + 0.5 * smooth_rand(n, jiri, r) ** 1.3
    sw = 0.65 + 0.35 * smooth_rand(n, swell_rate, r)
    env = sstep(t / ramp[0]) * sstep((dur - t) / ramp[1])
    y = filt(y * am * sw * env, "lp", 9500.0)
    return norm_rms(y, 0.1)


def higurashi_phrase(r, dur=None, f0=None, f1=None, rate0=None, rate1=None):
    """Evening cicada (ヒグラシ) 'kana-kana-kana…': pairs of pure metallic pulses
    ('ka' strong, 'na' weak), ~9 pairs/s, the pitch and loudness sinking over the phrase."""
    dur = dur or r.uniform(4.2, 6.0)
    f0 = f0 or r.uniform(4700.0, 5000.0)
    f1 = f1 or f0 * r.uniform(0.8, 0.86)
    rate0 = rate0 or r.uniform(9.0, 10.0)
    rate1 = rate1 or rate0 * r.uniform(0.75, 0.82)
    n = int((dur + 0.2) * SR)
    x = np.zeros(n)
    L = int(0.07 * SR)
    tp = np.arange(L) / SR
    tk = 0.0
    k = 0
    while tk < dur:
        u = tk / dur
        fk = f0 + (f1 - f0) * u ** 0.8
        ph_env = sstep(u / 0.07) * (0.35 + 0.65 * np.exp(-u * 1.9)) * (1.0 - sstep((u - 0.88) / 0.12) * 0.85)
        for j, (off, a) in enumerate(((0.0, 1.0), (0.048, 0.62))):
            f = fk * (1.035 - 0.07 * (1.0 - np.exp(-tp / 0.012))) * (1.0 - 0.015 * j)
            s = np.sin(TAU * np.cumsum(f) / SR) + 0.06 * np.sin(2 * TAU * np.cumsum(f) / SR)
            e = sstep(tp / 0.003) * np.exp(-tp / 0.017)
            add_at(x, s * e * a * ph_env * r.uniform(0.9, 1.05), tk + off * (1.0 + 0.2 * u))
        rate = rate0 + (rate1 - rate0) * u
        tk += 1.0 / rate * r.uniform(0.97, 1.03)
        k += 1
    x += bpc(r.standard_normal(n), (f0 + f1) / 2, 3.0) * onepole(np.abs(x), 0.01) * 0.4
    return norm_peak(edge(x, 0.002, 0.05))


# ----------------------------------------------------------------------------
# Frogs
# ----------------------------------------------------------------------------
FROGS = {
    # Japanese tree frog (アマガエル) 'gek-gek-gek': short buzzy notes, ~4/s
    "ama": dict(fc=(1850, 2450), prate=(85, 115), pulses=(5, 8), period=(0.22, 0.32), bout=(10, 26), rest=(1.0, 4.0),
                harm=(1.0, 0.45, 0.18), glide=-0.03, noise=0.08),
    # a pond frog (ヌマガエル/ツチガエル) 'gyururu': lower, trilled, slower
    "numa": dict(fc=(700, 1050), prate=(30, 44), pulses=(6, 11), period=(0.5, 0.85), bout=(5, 12), rest=(1.5, 5.0),
                 harm=(1.0, 0.6, 0.3), glide=-0.05, noise=0.1),
    # Schlegel's green tree frog (シュレーゲルアオガエル) 'ko-ro-ro': soft rolled notes
    "shure": dict(fc=(1150, 1450), prate=(17, 23), pulses=(4, 7), period=(0.9, 1.5), bout=(3, 7), rest=(2.0, 6.0),
                  harm=(1.0, 0.3, 0.1), glide=0.02, noise=0.05),
    # a bullfrog (ウシガエル) far away 'bwoo'
    "ushi": dict(fc=(150, 190), prate=(95, 110), pulses=(45, 70), period=(2.2, 3.4), bout=(2, 4), rest=(4.0, 8.0),
                 harm=(1.0, 0.8, 0.6), glide=0.04, noise=0.05),
}


def frog_note(sp, r, fc, prate):
    P = FROGS[sp]
    pulses = int(r.integers(P["pulses"][0], P["pulses"][1] + 1))
    Ln = pulses / prate
    n = int((Ln + 0.05) * SR)
    tt = np.arange(n) / SR
    pe = np.zeros(n)
    width = 0.32 / prate
    for k in range(pulses):
        d = tt - k / prate * (1.0 + 0.03 * r.standard_normal())
        m = d >= 0
        pe[m] += sstep(d[m] / 0.0015) * np.exp(-d[m] / width) * (1.0 - 0.25 * k / pulses)
    if sp == "ushi":
        pe = onepole(pe, 0.006)
    f = fc * (1.0 + P["glide"] * tt / Ln)
    ph = TAU * np.cumsum(f) / SR
    h = P["harm"]
    s = h[0] * np.sin(ph) + h[1] * np.sin(2 * ph + 0.5) + h[2] * np.sin(3 * ph + 1.3)
    s += P["noise"] * bpc(r.standard_normal(n), fc, 2.5) * 5.0
    env = sstep(tt / 0.008) * sstep((Ln + 0.04 - tt) / 0.02)
    return s * pe * env


def frog_track(sp, dur, r, activity=None, start=None):
    """One frog calling in bouts over `dur` seconds (mono, unnormalised)."""
    P = FROGS[sp]
    n = int(dur * SR)
    x = np.zeros(n)
    fc = r.uniform(*P["fc"])
    prate = r.uniform(*P["prate"])
    period = r.uniform(*P["period"])
    tk = r.uniform(0.0, 3.0) if start is None else start
    while tk < dur:
        act = 1.0 if activity is None else float(activity[min(int(tk * SR), n - 1)])
        if r.random() < 0.25 + 0.75 * act:
            k = int(r.integers(P["bout"][0], P["bout"][1] + 1))
            for _ in range(k):
                if tk >= dur:
                    break
                add_at(x, frog_note(sp, r, fc * r.uniform(0.985, 1.015), prate) * r.lognormal(0.0, 0.15), tk)
                tk += period * r.uniform(0.94, 1.06)
        tk += r.uniform(*P["rest"]) * (1.5 - act)
    return x


def frog_chorus(dur, r, frogs, activity_rate=0.07):
    """frogs = [(species, distance_m, pan), ...] -> stereo chorus (RMS-normalised)."""
    n = int(dur * SR)
    act = smooth_rand(n, activity_rate, r, 0.2, 1.0)
    out = np.zeros((2, n))
    for sp, d, p in frogs:
        x = frog_track(sp, dur, r, act)
        out += pan2(distance_filter(x, d, ref=6.0, air=11000.0), p)
    return norm_rms(filt(out, "hp", 90.0))


# ----------------------------------------------------------------------------
# Man-made: wind chime, level crossing, train, boats, outboard motor
# ----------------------------------------------------------------------------
def furin_strike(f0, strength, r):
    """Edo glass wind chime: a thin glass bell (split mode doublets shimmer) struck by a clapper."""
    t = np.arange(int(3.2 * SR)) / SR
    parts = []
    for ratio, a, tau in ((1.0, 1.0, 1.9), (2.32, 0.42, 0.9), (4.25, 0.22, 0.42), (6.63, 0.1, 0.22)):
        sp = r.uniform(0.0002, 0.0007)                      # split modes: a slow shimmer of 1-4 Hz
        ph = r.uniform(0, TAU)
        parts += [(f0 * ratio * (1 - sp), a * 0.55, tau, ph), (f0 * ratio * (1 + sp), a * 0.45, tau * 0.93, ph)]
    x = _partials(t, parts, r)
    x *= sstep(t / 0.0006)
    nc = int(0.012 * SR)
    x[:nc] += filt(r.standard_normal(nc), "hp", 3000.0) * np.exp(-t[:nc] / 0.0015) * 0.3
    return edge(x * strength, 0.0003, 0.1)


def crossing_strike(f0, r):
    """One 'kan' of an electronic level-crossing bell (struck-bell partials through a horn speaker)."""
    t = np.arange(int(0.7 * SR)) / SR
    parts = [(f0, 1.0, 0.3), (f0 * 2.0, 0.55, 0.16), (f0 * 2.98, 0.34, 0.1), (f0 * 4.16, 0.15, 0.06), (f0 * 5.4, 0.08, 0.04)]
    x = _partials(t, parts, r) * sstep(t / 0.0012)
    nc = int(0.02 * SR)
    x[:nc] += filt(r.standard_normal(nc), "bp", 3500.0, 1.0) * np.exp(-t[:nc] / 0.002) * 0.4
    x = np.tanh(1.8 * x) / np.tanh(1.8)
    x = filt(filt(x, "hp", 420.0), "lp", 5500.0)
    x = filt(x, "peak", 2200.0, 1.0, 3.0)
    return edge(x, 0.0003, 0.05)


def clack(r, bright=1.0, hard=1.0):
    """A wheel dropping over a rail joint: a thump, the bogie's body, the rail's ring."""
    t = np.arange(int(0.35 * SR)) / SR
    f = 78.0 + 30.0 * np.exp(-t / 0.01)
    thump = np.sin(TAU * np.cumsum(f) / SR) * np.exp(-t / 0.045) * sstep(t / 0.0015)
    nz = r.standard_normal(len(t))
    body = filt(nz, "bp", 380.0, 1.1) * np.exp(-t / 0.03) * 0.7
    ring = _partials(t, [(1150.0 * bright, 0.25, 0.05), (2330.0 * bright, 0.18, 0.035),
                         (3560.0 * bright, 0.1, 0.02), (5100.0 * bright, 0.05, 0.012)], r)
    click = filt(nz, "hp", 2500.0) * np.exp(-t / 0.0025) * 0.35
    x = thump + body + (ring * sstep(t / 0.0008) + click) * hard
    return edge(x, 0.0003, 0.05)


def diesel(f_fire, load, r):
    """Diesel railcar engine: exhaust pulses at the firing rate through pipe/body resonances,
    mechanical clatter gated by the firing, a faint turbo whine under load."""
    n = len(f_fire)
    x = _pulse_train(n, f_fire, r, jitter=0.012, jrate=12.0, amp=(0.7, 1.0))
    x *= 0.45 + 0.55 * load
    # each firing is a smooth ~7 ms pressure bump, not a click
    kb = np.hanning(int(0.007 * SR))
    x = signal.fftconvolve(x, kb)[:n]
    y = 3.0 * svf(x, 90.0, 1.3, "bp") + 2.0 * svf(x, 230.0, 1.8, "bp") + (0.5 + 0.7 * load) * svf(x, 540.0, 2.0, "bp")
    y = filt(filt(y, "lp", 900.0 + 700.0 * float(np.mean(load)), 0.7), "lp", 1400.0, 0.7)
    gate = onepole(x / (np.max(x) + 1e-9), 0.006)
    clat = bpc(r.standard_normal(n), 2200.0, 1.5) * gate * 0.04
    whine = np.sin(TAU * np.cumsum(1500.0 + 700.0 * load) / SR) * load ** 2
    y = y / (np.sqrt(np.mean(y ** 2)) + 1e-9) + clat / 0.05 * 0.06 + whine * 0.004
    return filt(y, "hp", 30.0)


def rail_rumble(speed, r):
    """Rolling wheels: low rumble + a faint rail hiss, scaling with speed (m/s)."""
    n = len(speed)
    s = np.clip(speed / 12.0, 0, 1.5)
    lo = svf(brown(n, r), 180.0 + 200.0 * s, 0.7, "lp")
    mid = filt(r.standard_normal(n), "bp", 900.0, 0.8) * 0.25
    hi = filt(r.standard_normal(n), "bp", 3800.0, 1.2) * 0.05
    return (lo + mid * s + hi * s ** 2) * s ** 1.4


def squeal(dur, r, f=3136.0):
    """Brake-shoe squeal (use with an intensity envelope)."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    fm = f * (1.0 + 0.003 * np.sin(TAU * 6.3 * t) + 0.002 * smooth_rand(n, 3.0, r, -1, 1))
    ph = TAU * np.cumsum(fm) / SR
    x = np.sin(ph) + 0.12 * np.sin(2 * ph + 0.7)
    x += 0.3 * svf(r.standard_normal(n), fm, 4.0, "bp") * 4.0
    return x


def air_hiss(dur, r, fc=4200.0, attack=0.02, decay=0.45):
    n = int(dur * SR)
    t = np.arange(n) / SR
    nz = r.standard_normal(n)
    x = filt(nz, "bp", fc, 0.7) + 0.5 * filt(nz, "hp", 2500.0)
    x = filt(x, "lp", 9000.0)
    env = sstep(t / attack) * np.exp(-t / decay)
    return edge(x * env, 0.002, 0.05)


def door(r):
    """Air-operated sliding door: a puff, the slide, a soft thunk."""
    t = np.arange(int(1.1 * SR)) / SR
    x = air_hiss(0.3, r, 3500.0, 0.01, 0.12) * 0.5
    x = np.pad(x, (0, len(t) - len(x)))
    slide = filt(r.standard_normal(len(t)), "lp", 500.0) * np.sin(np.pi * np.clip((t - 0.05) / 0.55, 0, 1)) ** 1.5 * 0.7
    tt = np.maximum(t - 0.62, 0)
    thunk = (np.sin(TAU * 95.0 * tt) * np.exp(-tt / 0.06) + filt(r.standard_normal(len(t)), "bp", 800.0, 1.0) * np.exp(-tt / 0.01) * 0.4) * (t >= 0.62)
    return edge(x + slide + thunk * 0.8, 0.002, 0.05)


def door_chime(f1, f2, r):
    """Two-tone door chime ('pin-pon')."""
    t = np.arange(int(1.2 * SR)) / SR
    out = np.zeros_like(t)
    for f, t0 in ((f1, 0.0), (f2, 0.34)):
        d = np.maximum(t - t0, 0)
        out += (np.sin(TAU * f * d) + 0.15 * np.sin(TAU * 3 * f * d)) * sstep(d / 0.004) * np.exp(-d / 0.5) * (t >= t0)
    return edge(out, 0.001, 0.05)


def horn(r, f=440.0, dur=0.42):
    """A short diesel horn toot ('pwaan'): two reeds, nasal formants."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    ff = f * (1.0 + 0.012 * np.exp(-t / 0.04))
    src = saw(ff, n / SR) + 0.7 * saw(ff * 1.004, n / SR, 0.3)
    y = svf(src, 880.0, 1.5, "bp") + 0.6 * svf(src, 1760.0, 2.5, "bp") + 0.3 * svf(src, 2900.0, 3.0, "bp")
    y = filt(y, "lp", 5000.0)
    env = sstep(t / 0.035) * (1.0 - sstep((t - (dur - 0.12)) / 0.12))
    return norm_peak(edge(y * env, 0.002, 0.02))


def creak(r, dur=None, f_res=None):
    """A mooring rope / wooden hull creaking: stick-slip pulses through a resonance."""
    dur = dur or r.uniform(0.35, 0.9)
    f_res = f_res or r.uniform(320.0, 900.0)
    n = int(dur * SR)
    t = np.arange(n) / SR
    u = t / dur
    base = r.uniform(22.0, 55.0)
    rate = base * (0.6 + 0.8 * np.sin(np.pi * u))
    x = _pulse_train(n, rate, r, jitter=0.12, jrate=40.0, amp=(0.4, 1.0))
    y = svf(x, f_res, 8.0, "bp") + 0.4 * svf(x, f_res * 2.3, 10.0, "bp")
    return norm_peak(edge(y * np.sin(np.pi * u) ** 1.5, 0.01, 0.02))


def boat_knock(r):
    t = np.arange(int(0.3 * SR)) / SR
    f = r.uniform(120.0, 170.0)
    x = np.sin(TAU * f * t) * np.exp(-t / 0.07) + filt(r.standard_normal(len(t)), "bp", 420.0, 1.2) * np.exp(-t / 0.02) * 0.5
    return norm_peak(edge(x * sstep(t / 0.002), 0.0005, 0.03))


def outboard(dur, r, f=88.0):
    """A small two-stroke outboard motor far out in the harbour."""
    n = int(dur * SR)
    fr = f * (1.0 + 0.03 * smooth_rand(n, 0.3, r, -1, 1))
    x = _pulse_train(n, fr, r, jitter=0.02, jrate=20.0, amp=(0.7, 1.0))
    y = svf(x, 180.0, 2.0, "bp") + 0.6 * svf(x, 480.0, 3.0, "bp") + 0.3 * svf(x, 1100.0, 3.0, "bp")
    y += filt(r.standard_normal(n), "bp", 700.0, 0.8) * 0.02
    y = filt(y, "lp", 1500.0) * (0.6 + 0.4 * smooth_rand(n, 0.12, r))
    return norm_rms(filt(y, "hp", 60.0), 0.1)
