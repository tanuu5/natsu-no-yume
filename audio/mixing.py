"""Mixing and mastering helpers: synthetic reverbs (convolution with generated
impulse responses), BS.1770 loudness, true-peak measurement, a look-ahead
true-peak limiter and a 24-bit WAV writer."""
import wave

import numpy as np
from scipy import signal
from scipy.ndimage import maximum_filter1d, uniform_filter1d

from dsp import SR, filt
from instruments import seeded, sstep


# ----------------------------------------------------------------------------
# Reverb
# ----------------------------------------------------------------------------
def impulse(rt, dur, pre=0.02, seed=1, er=(), onset=0.03, hp=120.0, lp=12000.0, sparse=0.0):
    """Stereo impulse response. rt = (RT60 below 500 Hz, 500-4k, above 4k) in seconds.
    er = early reflections [(delay_s, gain), ...] (alternating sides, slightly
    low-passed). sparse > 0 thins the tail into a grainy 'outdoor' texture."""
    r = seeded(9001, seed)
    n = int(dur * SR)
    t = np.arange(n) / SR
    ir = np.zeros((2, n))
    for c in range(2):
        nz = r.standard_normal(n)
        if sparse > 0:
            nz *= (r.random(n) < 1.0 - sparse) * (1.0 + sparse * 2.0)
        lo = filt(nz, "lp", 500.0, 0.6)
        hi = filt(nz, "hp", 4000.0, 0.6)
        mid = nz - lo - hi
        dec = [10 ** (-3.0 * t / x) for x in rt]
        ir[c] = lo * dec[0] + mid * dec[1] + hi * dec[2]
    ir *= sstep(t / onset)
    ir = filt(filt(ir, "hp", hp, 0.6), "lp", lp, 0.6)
    ir /= np.sqrt(np.sum(ir ** 2, axis=1, keepdims=True))
    if er:
        # discrete reflections (energy relative to the whole tail = g^2), alternating sides
        e = np.zeros((2, n))
        for k, (d, g) in enumerate(er):
            i = int(d * SR)
            if i + 40 < n:
                c = k % 2
                e[c, i] += g
                e[1 - c, i + int(0.0006 * SR)] += g * 0.55
        ir += filt(e, "lp", 6000.0, 0.6)
        ir /= np.sqrt(np.sum(ir ** 2, axis=1, keepdims=True))
    return np.concatenate([np.zeros((2, int(pre * SR))), ir], axis=1)


def convolve(x, ir, n=None):
    n = n or x.shape[1]
    return np.stack([signal.fftconvolve(x[c], ir[c])[:n] for c in range(2)])


# ----------------------------------------------------------------------------
# Loudness (ITU-R BS.1770-4 / EBU R128) and true peak
# ----------------------------------------------------------------------------
_K1 = ([1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585])
_K2 = ([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621])


def k_weight(x):
    return signal.lfilter(*_K2, signal.lfilter(*_K1, x, axis=-1), axis=-1)


def _block_ms(x, win, hop):
    y = k_weight(np.atleast_2d(x))
    p = (y ** 2).sum(axis=0)
    c = np.concatenate([[0.0], np.cumsum(p)])
    w, h = int(win * SR), int(hop * SR)
    starts = np.arange(0, len(p) - w + 1, h)
    return (c[starts + w] - c[starts]) / w, starts


def integrated_lufs(x):
    ms, _ = _block_ms(x, 0.4, 0.1)
    lk = -0.691 + 10 * np.log10(ms + 1e-20)
    g = ms[lk > -70.0]
    if len(g) == 0:
        return -99.0
    rel = -0.691 + 10 * np.log10(np.mean(g)) - 10.0
    g = ms[(lk > -70.0) & (lk > rel)]
    return float(-0.691 + 10 * np.log10(np.mean(g)))


def short_term(x, win=3.0, hop=1.0):
    """Short-term loudness (LUFS) every `hop` s over `win`-s windows; returns (times, values)."""
    ms, starts = _block_ms(x, win, hop)
    return starts / SR, -0.691 + 10 * np.log10(ms + 1e-20)


def true_peak(x):
    up = signal.resample_poly(np.atleast_2d(x), 4, 1, axis=-1)
    return float(20 * np.log10(np.max(np.abs(up)) + 1e-12))


try:
    from numba import njit
except Exception:  # noqa: BLE001
    def njit(*a, **k):
        return (lambda f: f) if not (a and callable(a[0])) else a[0]


@njit(cache=True)
def _release(g, coef):
    y = np.empty_like(g)
    prev = 1.0
    for i in range(g.shape[0]):
        v = prev + (1.0 - prev) * coef
        if g[i] < v:
            v = g[i]
        y[i] = v
        prev = v
    return y


def limit(x, ceiling_db=-1.2, look=0.002, release=0.08):
    """Look-ahead limiter driven by a 4x-oversampled (true-peak) estimate."""
    c = 10 ** (ceiling_db / 20.0)
    n = x.shape[1]
    up = signal.resample_poly(x, 4, 1, axis=-1)
    pk = np.abs(up).max(axis=0)
    m = (len(pk) // 4) * 4
    pk = pk[:m].reshape(-1, 4).max(axis=1)
    pk = np.pad(pk, (0, max(0, n - len(pk))), mode="edge")[:n]
    L = max(3, int(look * SR))
    env = maximum_filter1d(pk, size=2 * L + 1)
    env = uniform_filter1d(env, size=L)
    env = maximum_filter1d(env, size=L)
    g = np.minimum(1.0, c / np.maximum(env, 1e-9))
    g = _release(np.ascontiguousarray(g), 1.0 - np.exp(-1.0 / (release * SR)))
    limit.last_gain = g
    return x * g, float(20 * np.log10(g.min() + 1e-12))


# ----------------------------------------------------------------------------
# Output
# ----------------------------------------------------------------------------
def write_wav24(path, x):
    pcm = np.clip(x.T, -1.0, 1.0)
    ints = np.ascontiguousarray((pcm * (2 ** 23 - 1)).round().astype("<i4"))
    with wave.open(path, "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(3)
        wf.setframerate(SR)
        wf.writeframes(ints.view(np.uint8).reshape(-1, 4)[:, :3].tobytes())
