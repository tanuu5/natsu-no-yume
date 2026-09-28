"""Instruments for the score of 夏の夢 (A Summer Dream).

Everything is synthesised from oscillators and seeded noise (no samples):

- Piano      soft/felt piano: additive partials with stretch tuning (string
             inharmonicity), two-stage decay, a pair of slightly detuned unison
             strings on the low partials, felt hammer thump, velocity -> loudness
             and brightness, damper on key-up. Notes are cached per (key, layer).
- bowed()    legato bowed line (violins, cellos, string pad): an ensemble of
             detuned band-limited saws that glide between notes, delayed vibrato
             per player, dynamic low-pass (louder = brighter), body resonances,
             bow noise.
- music_box / celesta / vibes / epiano / harp / pizz: tuned percussion and
  plucked sounds built from (in)harmonic partials or FM.
- timpani roll, suspended-cymbal mallet swell, shaker, brush, rim: soft
  percussion for the walking pulse and the swells into the big moments.

All functions return float64 numpy arrays at dsp.SR (mono unless noted).
"""
import numpy as np
from scipy import signal

from dsp import SR, TAU, midi, svf, svf_st, filt, saw


# ----------------------------------------------------------------------------
# Small helpers
# ----------------------------------------------------------------------------
def seeded(*xs):
    """Deterministic RNG from a tuple of integers (independent of call order)."""
    s = 1469598103
    for x in xs:
        s = (s * 1000003 + int(x) * 7919 + 12345) % (2 ** 61 - 1)
    return np.random.default_rng(s)


def sstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def pan2(x, pan=0.0):
    """Mono -> stereo with a constant-power pan law (centre = unity per side).
    `pan` may be an array for a moving source."""
    p = np.clip(np.asarray(pan, dtype=float), -1.0, 1.0)
    a = (p + 1.0) * np.pi / 4.0
    return np.stack([x * np.cos(a) * np.sqrt(2.0), x * np.sin(a) * np.sqrt(2.0)])


def smooth_rand(n, rate, rng, lo=0.0, hi=1.0):
    """A smooth random curve: cosine-interpolated random points `rate` per second."""
    k = int(n / SR * rate) + 3
    pts = rng.uniform(lo, hi, k)
    x = np.arange(n) / SR * rate
    i = np.floor(x).astype(int)
    f = x - i
    f = (1.0 - np.cos(np.pi * f)) * 0.5
    return pts[i] * (1.0 - f) + pts[i + 1] * f


def onepole(x, tau):
    """Causal one-pole smoother with time constant tau (s)."""
    a = np.exp(-1.0 / (max(tau, 1e-5) * SR))
    return signal.lfilter([1.0 - a], [1.0, -a], x)


def shift(x, k):
    """Delay (k > 0) or advance (k < 0) a signal by k samples, zero-filled."""
    if k == 0:
        return x
    y = np.zeros_like(x)
    if k > 0:
        y[k:] = x[:-k]
    else:
        y[:k] = x[-k:]
    return y


def edge(x, fi=0.002, fo=0.01):
    """Raised-cosine fade in/out on the ends (no clicks)."""
    n = x.shape[-1]
    a = min(int(fi * SR), n // 2)
    z = min(int(fo * SR), n // 2)
    if a > 0:
        x[..., :a] *= 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, a))
    if z > 0:
        x[..., n - z:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, z))
    return x


def _partials(t, parts, rng):
    """Sum of exponentially decaying sines: parts = [(freq, amp, tau[, phase]), ...].
    Give the two halves of a doublet the same phase: struck together, they start in step."""
    x = np.zeros_like(t)
    for p in parts:
        f, a, tau = p[:3]
        ph = p[3] if len(p) > 3 else rng.uniform(0, TAU)
        if f >= SR * 0.46 or a <= 0:
            continue
        nk = min(len(t), int(tau * 8 * SR) + 1)
        tk = t[:nk]
        x[:nk] += a * np.sin(TAU * f * tk + ph) * np.exp(-tk / tau)
    return x


# ----------------------------------------------------------------------------
# Piano
# ----------------------------------------------------------------------------
VEL_LAYERS = np.linspace(0.08, 1.0, 12)


class Piano:
    """A soft, slightly worn upright-ish felt piano.

    note(m, vel, dur) -> mono note incl. its release; `dur` is how long the key
    (or the sustain pedal) holds the dampers off.
    """

    def __init__(self, seed=11, bright=1.0, felt=0.7, max_len=11.0, unison=0.9, hammer=1.0, tune_spread=1.0):
        self.seed = seed
        self.bright = bright
        self.felt = felt
        self.max_len = max_len
        self.unison = unison
        self.hammer = hammer
        self.tune_spread = tune_spread
        self.cache = {}

    def _render(self, m, li):
        vel = VEL_LAYERS[li]
        r = seeded(self.seed, m, li)
        rk = seeded(self.seed, m, 999)  # per-key (not per-layer) properties
        # tuning: stretch (Railsback-ish) + a little per-key error of a well-used piano
        cents = 5.0 * ((m - 64) / 30.0) ** 3 + self.tune_spread * rk.uniform(-1.2, 1.2)
        f0 = 440.0 * 2 ** ((m - 69 + cents / 100.0) / 12.0)
        tau = float(np.clip(7.0 * 2 ** (-(m - 60) / 14.0), 0.8, 16.0))   # aftersound of the fundamental
        n = int(min(self.max_len, 6.5 * tau + 0.4) * SR)
        t = np.arange(n) / SR
        B = 1.1e-4 * 2 ** ((m - 60) / 17.0)                                # string inharmonicity
        # felt: a gentle low-pass over the partial amplitudes, opened by velocity
        fc = ((450.0 + 3400.0 * vel ** 1.5) * self.bright * (1.0 - 0.35 * self.felt)) + 1.2 * f0
        tilt = 0.8 + 0.7 * (1.0 - vel)
        x = np.zeros(n)
        kmax = int(min(36, 15500.0 / f0))
        for k in range(1, kmax + 1):
            fk = k * f0 * np.sqrt(1.0 + B * k * k)
            if fk > 15500.0:
                break
            comb = 0.35 + 0.65 * abs(np.sin(np.pi * k / 8.3))            # hammer strike point ~1/8
            a = comb * k ** -tilt / (1.0 + (fk / fc) ** 2)
            if k == 1:
                a *= 1.25
            if a < 2e-4:
                continue
            tk_ = tau / (1.0 + 0.19 * (k - 1) + 0.011 * (k - 1) ** 2) * r.uniform(0.85, 1.15)
            tp_ = tk_ * r.uniform(0.09, 0.16)                              # prompt sound
            wp = 0.55 + 0.15 * r.random()
            nk = min(n, int(tk_ * 7.5 * SR) + 1)
            tt_ = t[:nk]
            env = wp * np.exp(-tt_ / tp_) + (1.0 - wp) * np.exp(-tt_ / tk_)
            if k <= 7:  # three unison strings struck together (same phase), a fraction of a cent apart
                d = self.unison * r.uniform(0.25, 1.0) * 0.000289
                ph = r.uniform(0, TAU)
                osc = (0.38 * np.sin(TAU * fk * (1 - d) * tt_ + ph) + 0.36 * np.sin(TAU * fk * (1 + 0.15 * d) * tt_ + ph)
                       + 0.26 * np.sin(TAU * fk * (1 + 0.8 * d) * tt_ + ph))
            else:
                osc = np.sin(TAU * fk * tt_ + r.uniform(0, TAU))
            x[:nk] += a * env * osc
        # felt attack: a few milliseconds of rise
        ta = 0.007 - 0.0045 * vel
        x *= sstep(t / ta)
        # normalise on the attack region so layers differ in colour, not level
        w = min(n, int(0.3 * SR))
        x /= np.sqrt(np.mean(x[:w] ** 2)) + 1e-9
        # felt hammer thump + a soft mechanical knock
        nn = min(n, int(0.14 * SR))
        nz = r.standard_normal(nn)
        tn = t[:nn]
        thump = filt(nz, "lp", 160.0 + 380.0 * vel) * np.exp(-tn / 0.016)
        knock = filt(nz, "bp", 900.0 + 900.0 * vel, 1.3) * np.exp(-tn / 0.0045)
        x[:nn] += self.hammer * (0.55 * thump + 0.08 * knock) * (0.35 + 0.65 * vel)
        return x

    def raw(self, m, vel):
        li = int(np.argmin(np.abs(VEL_LAYERS - vel)))
        key = (int(m), li)
        if key not in self.cache:
            self.cache[key] = self._render(int(m), li)
        return self.cache[key]

    def note(self, m, vel, dur):
        x = self.raw(m, vel)
        damped = m < 89                         # the top of the keyboard has no dampers
        rel = float(np.clip(0.16 * 2 ** (-(m - 48) / 30.0), 0.05, 0.22))
        nd = int(dur * SR)
        nr = int(rel * 6.0 * SR) if damped else len(x)
        L = min(len(x), nd + nr)
        y = x[:L].copy()
        if damped and L > nd:
            tr = np.arange(L - nd) / SR
            y[nd:] *= np.exp(-tr / rel)
        g = vel ** 1.55
        return edge(y * g, 0.0005, 0.02)

    def stereo(self, m, vel, dur, width=0.5):
        """Note panned by pitch (player's perspective: low left, high right)."""
        return pan2(self.note(m, vel, dur), float(np.clip((m - 62) / 36.0, -1, 1)) * width)


# ----------------------------------------------------------------------------
# Bowed strings: legato lines and pads
# ----------------------------------------------------------------------------
BODY_VIOLIN = [("peak", 290, 1.4, 3.0), ("peak", 1050, 1.6, 1.5), ("peak", 2800, 1.2, 2.5), ("peak", 1600, 2.0, -1.5)]
BODY_CELLO = [("peak", 160, 1.3, 3.0), ("peak", 520, 1.5, 2.0), ("peak", 1800, 1.4, 1.0)]
BODY_PAD = [("peak", 400, 0.9, 1.5)]


def bowed(events, t0, t1, *, voices=6, detune=6.0, vib_rate=5.3, vib_depth=13.0, vib_delay=0.3,
          attack=0.18, release=0.5, leg_gap=0.07, glide=0.09, cutoff=(800.0, 4800.0), q=0.75,
          body=BODY_VIOLIN, hp=160.0, lp=9000.0, bow_noise=0.02, seed=0, pan=0.0, spread=0.5,
          timing=0.012, drift=2.5, swell=0.08, keytrack=0.5):
    """Render a legato line. events = [(start_s, dur_s, midi, amp), ...] (monophonic).
    Returns stereo (2, n) covering [t0, t1)."""
    n = int(round((t1 - t0) * SR))
    t = t0 + np.arange(n) / SR
    ev = sorted(events, key=lambda e: e[0])
    p = np.full(n, np.nan)
    a = np.zeros(n)
    ve = np.zeros(n)

    def ix(s):
        return int(np.clip(round((s - t0) * SR), 0, n))

    prev_end, prev_m = -1e9, None
    for k, (s, d, m, amp) in enumerate(ev):
        e = s + d
        nxt = ev[k + 1][0] if k + 1 < len(ev) else None
        leg_in = prev_m is not None and s - prev_end <= leg_gap
        leg_out = nxt is not None and nxt - e <= leg_gap
        i0 = ix(s)
        j1 = ix(nxt) if leg_out else ix(e + release)
        if j1 <= i0:
            prev_end, prev_m = e, m
            continue
        p[i0:j1] = m
        if leg_in:
            g = max(1, int(glide * SR))
            gg = min(g, j1 - i0)
            p[i0:i0 + gg] = prev_m + (m - prev_m) * sstep(np.arange(gg) / g)
        tt_ = t[i0:j1] - s
        if leg_in:
            env = 0.8 + 0.2 * sstep(tt_ / 0.12)          # re-bow: a small dip, no new attack
        else:
            env = sstep(tt_ / attack) ** 1.3
        env = env * (1.0 + swell * np.sin(np.pi * np.clip(tt_ / max(d, 0.2), 0, 1)))
        if not leg_out:
            u = np.clip((tt_ - d) / release, 0, 1)
            env = env * (1.0 - sstep(u))
        a[i0:j1] = np.maximum(a[i0:j1], amp * env)
        ve[i0:j1] = np.maximum(ve[i0:j1], sstep((tt_ - vib_delay) / 0.6))
        prev_end, prev_m = e, m
    # keep the oscillators on a sensible pitch where the line rests
    if np.all(np.isnan(p)):
        return np.zeros((2, n))
    idx = np.where(~np.isnan(p), np.arange(n), 0)
    np.maximum.accumulate(idx, out=idx)
    p = p[idx]
    first = np.argmax(~np.isnan(p))
    p[:first] = p[first]
    a = onepole(a, 0.006)
    ve = onepole(ve, 0.05)
    out = np.zeros((2, n))
    for v in range(voices):
        r = seeded(seed, 100 + v)
        det = r.uniform(-detune, detune)
        rate = vib_rate * r.uniform(0.92, 1.08)
        vib = vib_depth * r.uniform(0.75, 1.25) * ve * np.sin(TAU * rate * t + r.uniform(0, TAU))
        dr = drift * smooth_rand(n, 0.6, r, -1.0, 1.0)
        sh = int(r.uniform(-timing, timing) * SR)
        pv = shift(p, sh)
        if sh > 0:
            pv[:sh] = p[0]
        elif sh < 0:
            pv[sh:] = p[-1]
        av = shift(a, sh)
        f = 440.0 * 2 ** ((pv - 69.0 + (det + vib + dr) / 100.0) / 12.0)
        x = saw(f, n / SR, ph0=r.random()) * av
        pp = pan + spread * (2.0 * v / max(voices - 1, 1) - 1.0) * 0.5
        out += pan2(x, pp)
    out /= np.sqrt(voices)
    amax = max(a.max(), 1e-6)
    fc = cutoff[0] + (cutoff[1] - cutoff[0]) * (a / amax) ** 0.8
    fc = fc * 2 ** (keytrack * (p - 72.0) / 24.0)
    out = svf_st(out, fc, q, "lp")
    for kind, f0, qq, gdb in body or []:
        out = filt(out, kind, f0, qq, gdb)
    if hp:
        out = filt(out, "hp", hp, 0.6)
    if lp:
        out = filt(out, "lp", lp, 0.6)
    if bow_noise > 0:
        rn = seeded(seed, 7)
        nz = filt(rn.standard_normal(n), "bp", 2600.0, 0.7) * a * bow_noise
        out += pan2(nz, pan)
    return out


def chord_lines(chords, amp=1.0):
    """[(start_s, end_s, [m0, m1, ...]), ...] -> one legato event list per voice
    (voice i takes the i-th lowest note of each chord)."""
    nv = max(len(c[2]) for c in chords)
    lines = [[] for _ in range(nv)]
    for s, e, notes in chords:
        ns = sorted(notes)
        for i in range(nv):
            m = ns[min(i, len(ns) - 1)]
            a = amp[i] if isinstance(amp, (list, tuple)) else amp
            lines[i].append((s, e - s, m, a))
    return lines


# ----------------------------------------------------------------------------
# Tuned percussion, plucks, keys
# ----------------------------------------------------------------------------
def music_box(m, vel=0.7, length=None, seed=0):
    """Comb-tooth music box: a pure, slowly beating fundamental with the tooth's
    bright second bending mode, and the pin's tiny click."""
    f0 = midi(m)
    r = seeded(31, m, seed)
    tau = float(np.clip(2.0 * 2 ** (-(m - 84) / 18.0), 0.6, 4.0))
    L = length or min(5.0, tau * 5.0)
    t = np.arange(int(L * SR)) / SR
    ph = r.uniform(0, TAU)
    parts = [(f0, 1.0, tau, ph), (f0 * (1.0 + 0.0011 * r.uniform(0.6, 1.4)), 0.4, tau * 1.1, ph),
             (f0 * 2.0, 0.045, tau * 0.35), (f0 * 3.0, 0.015, tau * 0.2),
             (f0 * 5.93 * r.uniform(0.996, 1.004), 0.22 * vel, 0.08), (f0 * 9.7, 0.05 * vel, 0.03)]
    x = _partials(t, parts, r)
    x *= sstep(t / 0.0008)
    nc = min(len(t), int(0.01 * SR))
    x[:nc] += filt(r.standard_normal(nc), "hp", 4000.0) * np.exp(-t[:nc] / 0.0012) * 0.1 * vel
    return edge(x * vel ** 1.3 * 0.5, 0.0003, 0.05)


def celesta(m, vel=0.6, seed=0):
    f0 = midi(m)
    r = seeded(37, m, seed)
    tau = float(np.clip(1.5 * 2 ** (-(m - 72) / 20.0), 0.5, 3.0))
    t = np.arange(int(min(4.0, tau * 5.0) * SR)) / SR
    ph = r.uniform(0, TAU)
    parts = [(f0, 1.0, tau, ph), (f0 * 1.0007, 0.3, tau, ph), (f0 * 2.0, 0.12 * vel, tau * 0.35),
             (f0 * 3.0, 0.04, tau * 0.2), (f0 * 2.76, 0.05 * vel, tau * 0.12)]
    x = _partials(t, parts, r)
    x *= sstep(t / 0.0012)
    nc = min(len(t), int(0.03 * SR))
    x[:nc] += filt(r.standard_normal(nc), "lp", 1800.0) * np.exp(-t[:nc] / 0.004) * 0.12 * vel
    return edge(x * vel ** 1.3 * 0.5, 0.0003, 0.05)


def vibes(m, vel=0.6, dur=1.0, trem=3.4, trem_depth=0.16, seed=0):
    """Vibraphone with soft yarn mallets, slow motor tremolo, pedal damping."""
    f0 = midi(m)
    r = seeded(41, m, seed)
    tau = float(np.clip(3.0 * 2 ** (-(m - 65) / 20.0), 0.8, 5.0))
    rel = 0.12
    L = min(dur + rel * 6, tau * 5.0)
    t = np.arange(int(L * SR)) / SR
    parts = [(f0, 1.0, tau), (f0 * 4.0, 0.16 * vel, tau * 0.16), (f0 * 9.95, 0.04 * vel, tau * 0.05)]
    x = _partials(t, parts, r)
    x *= sstep(t / 0.0015)
    nc = min(len(t), int(0.03 * SR))
    x[:nc] += filt(r.standard_normal(nc), "lp", 1100.0) * np.exp(-t[:nc] / 0.005) * 0.2 * vel
    x *= 1.0 - trem_depth * (0.5 - 0.5 * np.cos(TAU * trem * t + r.uniform(0, TAU)))
    nd = int(dur * SR)
    if nd < len(x):
        x[nd:] *= np.exp(-np.arange(len(x) - nd) / SR / rel)
    return edge(x * vel ** 1.4 * 0.5, 0.0003, 0.03)


def epiano(m, vel=0.6, dur=1.0, seed=0):
    """Rhodes-like FM electric piano: 1:1 FM body + a 1:14 tine ping."""
    f = midi(m)
    r = seeded(43, m, seed)
    rel = 0.1
    tau = float(np.clip(2.6 * 2 ** (-(m - 60) / 24.0), 0.8, 4.0))
    L = min(dur + rel * 6, tau * 5.0)
    t = np.arange(int(L * SR)) / SR
    i1 = (0.5 + 1.8 * vel) * np.exp(-t / 0.4) + 0.22
    body = np.sin(TAU * f * t + i1 * np.sin(TAU * f * t + r.uniform(0, TAU)))
    i2 = (0.6 + 1.2 * vel) * np.exp(-t / 0.012)
    tine = np.sin(TAU * f * t + i2 * np.sin(TAU * 14.0 * f * t)) * np.exp(-t / 0.35)
    x = (body * np.exp(-t / tau) + 0.22 * vel * tine) * sstep(t / 0.0015)
    x = np.tanh(x * (1.0 + 1.2 * vel)) / np.tanh(1.0 + 1.2 * vel)
    nd = int(dur * SR)
    if nd < len(x):
        x[nd:] *= np.exp(-np.arange(len(x) - nd) / SR / rel)
    x = filt(x, "hp", 30.0)  # 1:1 FM has a component at 0 Hz
    return edge(x * vel ** 1.4 * 0.45, 0.0003, 0.03)


def harp(m, vel=0.6, seed=0):
    f0 = midi(m)
    r = seeded(47, m, seed)
    tau = float(np.clip(4.0 * 2 ** (-(m - 55) / 16.0), 0.7, 7.0))
    t = np.arange(int(min(6.0, tau * 4.0) * SR)) / SR
    x = np.zeros_like(t)
    fk_env = 1.0 + 0.003 * np.exp(-t / 0.03)
    for k in range(1, 15):
        fk = k * f0
        if fk > 12000:
            break
        a = k ** -1.3 * abs(np.sin(np.pi * k * 0.27)) * (1.0 if k == 1 else 0.9)
        tk_ = tau / (1.0 + 0.35 * (k - 1))
        nk = min(len(t), int(tk_ * 7 * SR) + 1)
        tt_ = t[:nk]
        x[:nk] += a * np.sin(TAU * fk * np.cumsum(fk_env[:nk]) / SR + r.uniform(0, TAU)) * np.exp(-tt_ / tk_)
    x *= sstep(t / 0.0015)
    nc = min(len(t), int(0.02 * SR))
    x[:nc] += filt(r.standard_normal(nc), "bp", 2200.0, 1.0) * np.exp(-t[:nc] / 0.003) * 0.05 * vel
    return edge(x * vel ** 1.4 * 0.5, 0.0003, 0.05)


def pizz(m, vel=0.7, dur=0.6, seed=0):
    """Plucked upright bass (pizzicato)."""
    f0 = midi(m)
    r = seeded(53, m, seed)
    tau = float(np.clip(1.3 * 2 ** (-(m - 40) / 24.0), 0.5, 2.0))
    rel = 0.07
    L = min(dur + rel * 6.0, tau * 5.0)
    t = np.arange(int(L * SR)) / SR
    bend = 1.0 + 0.012 * np.exp(-t / 0.025)
    ph = np.cumsum(f0 * bend) / SR
    x = np.zeros_like(t)
    for k in range(1, 11):
        if k * f0 > 5000:
            break
        a = k ** -1.5 * (0.3 + 0.7 * abs(np.sin(np.pi * k * 0.2)))
        tk_ = tau / (1.0 + 0.55 * (k - 1))
        x += a * np.sin(TAU * k * ph + r.uniform(0, TAU)) * np.exp(-t / tk_)
    x *= sstep(t / 0.004)
    nc = min(len(t), int(0.08 * SR))
    nz = r.standard_normal(nc)
    x[:nc] += filt(nz, "lp", 260.0) * np.exp(-t[:nc] / 0.02) * 0.5 + filt(nz, "bp", 1300.0, 1.2) * np.exp(-t[:nc] / 0.005) * 0.05
    nd = int(dur * SR)
    if nd < len(x):
        x[nd:] *= np.exp(-np.arange(len(x) - nd) / SR / rel)
    x = filt(np.tanh(x * 1.2) / np.tanh(1.2), "hp", 25.0)
    return edge(x * vel ** 1.3 * 0.6, 0.0005, 0.03)


def timp_stroke(m, vel=0.6, seed=0):
    f0 = midi(m)
    r = seeded(59, m, seed)
    t = np.arange(int(3.5 * SR)) / SR
    glide = 1.0 + 0.015 * np.exp(-t / 0.08)
    x = np.zeros_like(t)
    for ratio, a, tau in ((1.0, 1.0, 1.7), (1.504, 0.5, 1.1), (1.742, 0.22, 0.8), (2.0, 0.28, 0.7), (2.245, 0.14, 0.5), (2.494, 0.1, 0.4)):
        x += a * np.sin(TAU * f0 * ratio * np.cumsum(glide) / SR + r.uniform(0, TAU)) * np.exp(-t / tau)
    x *= sstep(t / 0.003)
    nc = int(0.06 * SR)
    x[:nc] += filt(r.standard_normal(nc), "lp", 320.0) * np.exp(-t[:nc] / 0.012) * 0.6
    x = filt(x, "lp", 2200.0)
    return edge(x * vel ** 1.3 * 0.5, 0.0005, 0.1)


def timp_roll(m, dur, v0=0.05, v1=0.7, tail=2.5, rate=15.0, seed=0):
    """A soft timpani roll with a crescendo (strokes as an impulse train through one stroke)."""
    r = seeded(61, m, seed)
    n = int((dur + tail) * SR)
    imp = np.zeros(n)
    tk = 0.0
    while tk < dur:
        u = tk / dur
        imp[int(tk * SR)] += (v0 + (v1 - v0) * u ** 1.6) * r.uniform(0.8, 1.0)
        tk += 1.0 / (rate * r.uniform(0.88, 1.12))
    st = timp_stroke(m, 0.5, seed)
    return signal.fftconvolve(imp, st)[:n] * 0.35


def cymbal_stroke(seed=0, dur=3.0):
    r = seeded(67, seed)
    t = np.arange(int(dur * SR)) / SR
    x = filt(r.standard_normal(len(t)), "hp", 1500.0) * np.exp(-t / 0.9) * 0.4
    parts = [(r.uniform(1800, 11000), r.uniform(0.2, 1.0), r.uniform(0.4, 1.6)) for _ in range(36)]
    x += _partials(t, parts, r) * 0.08
    x = filt(x, "lp", 9000.0)
    x *= sstep(t / 0.004)
    return x


def cymbal_swell(dur, tail=2.2, peak=1.0, seed=0, rate=22.0):
    """Suspended cymbal rolled with soft mallets: crescendo over `dur`, then rings."""
    r = seeded(71, seed)
    n = int((dur + tail) * SR)
    imp = np.zeros(n)
    tk = 0.0
    while tk < dur:
        u = tk / dur
        imp[int(tk * SR)] += (0.02 + 0.98 * u ** 2.4) * r.uniform(0.6, 1.0)
        tk += 1.0 / (rate * r.uniform(0.8, 1.2))
    x = np.stack([signal.fftconvolve(imp, cymbal_stroke(seed * 2 + c, tail + 0.5))[:n] for c in range(2)])
    return edge(x * 0.08 * peak, 0.01, 0.4)


def shaker(vel=0.6, seed=0):
    r = seeded(73, seed)
    t = np.arange(int(0.12 * SR)) / SR
    nz = r.standard_normal(len(t))
    grains = 1.0 + 1.5 * (r.random(len(t)) < 0.05)
    x = filt(filt(filt(nz * grains, "bp", 5200.0, 1.0), "hp", 2600.0), "lp", 9000.0)
    env = sstep(t / 0.007) * np.exp(-np.maximum(t - 0.007, 0) / 0.03)
    return edge(x * env * vel * 0.5, 0.0005, 0.01)


def brush(vel=0.6, seed=0, dur=0.3):
    """Brush on a snare: a soft swish with a light tap."""
    r = seeded(79, seed)
    t = np.arange(int(dur * SR)) / SR
    nz = r.standard_normal(len(t))
    sw = filt(filt(nz, "bp", 3000.0, 0.55), "lp", 8000.0) * sstep(t / 0.03) * np.exp(-np.maximum(t - 0.03, 0) / 0.09)
    tap = filt(nz, "bp", 1700.0, 1.4) * np.exp(-t / 0.008) * 0.6
    shell = np.sin(TAU * 190.0 * t) * np.exp(-t / 0.025) * 0.25
    return edge((sw + tap + shell) * vel * 0.45, 0.0005, 0.02)


def rim(vel=0.5, seed=0):
    r = seeded(83, seed)
    t = np.arange(int(0.08 * SR)) / SR
    x = (np.sin(TAU * 1850.0 * t) * np.exp(-t / 0.012) + 0.6 * np.sin(TAU * 2720.0 * t) * np.exp(-t / 0.007)
         + 0.3 * np.sin(TAU * 820.0 * t) * np.exp(-t / 0.02))
    x += filt(r.standard_normal(len(t)), "hp", 3000.0) * np.exp(-t / 0.002) * 0.5
    return edge(x * vel * 0.3, 0.0003, 0.01)
