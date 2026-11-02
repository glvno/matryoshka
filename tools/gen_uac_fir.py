#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 michael glaviano
"""The polyphase FIR of the USB audio input's 44.1 -> 48 kHz resampler -> firmware/src/uac_fir.h (#535).

  tools/gen_uac_fir.py [OUT]       write the table (default firmware/src/uac_fir.h) and print its measured response
  tools/gen_uac_fir.py --sweep     the same measurements for 16, 20, 24 and 32 taps per phase (why 24)

The engines render at 44.1 kHz (about 44,118 Hz, audio.c). When the host records at 48 kHz, usb.c's uac_tap48 makes
160 output frames for every 147 input frames: up by L = 160 (zeros between the samples), a low-pass at the up-sampled
rate (7.056 MHz), down by M = 147. Only the products that matter are computed: output frame k sits at up-sampled index
k * 147, so its phase is p = (k * 147) % 160 and its newest input frame is floor(k * 147 / 160), and
    y[k] = sum_j  PROTO[p + 160 j] * x[newest - j],   j = 0 .. N - 1.
UAC_FIR[p][i] holds those taps oldest input first (i = N - 1 - j), times L (each phase then sums to 1: unity gain at
DC), in Q30, and only for p = 0 .. 79: the prototype is symmetric, so phase 159 - p is phase p read backwards
(usb.c reads it so). Each phase's taps sum to exactly 1 << 30, rounded to stay closest to its exact response (fit()).

The prototype is a Kaiser-windowed sinc of 160 * N taps. What it must do:
  - images that land in the audio band after the 48 kHz sampling: a tone at f leaves an image at 44.1 kHz - f, which
    the 48 kHz output folds to 3.9 kHz + f. That is below 20 kHz while the image is above 28.0 kHz. So everything from
    28.0 kHz up (every image that can fold below 20 kHz) must be far down: >= 95 dB here, under the 16-bit floor of
    a loud signal. Images between 24 and 28 kHz fold to 20..24 kHz (inaudible); those below 24 kHz stay where they
    are, above 22 kHz (inaudible too).
  - a flat passband: within 0.1 dB to 18 kHz, about -1 dB at 20 kHz.
For a given N (taps per phase: the cost, two multiply-adds per tap per output frame) the window's beta sets the
stopband depth (9.5: 95 dB) and the cut-off then goes as high as the depth from 28 kHz allows. --sweep prints the
trade (2026-11-01): 16 taps keep 95 dB only with the passband 9 dB down at 18 kHz, 20 taps 0.8 dB down at 18 kHz and
-3.8 dB at 20 kHz, 24 taps within 0.04 dB to 18 kHz and -0.9 dB at 20 kHz, 32 taps flat to 20 kHz for a third more
work. 24 is the cheapest that keeps the top octave: 6,720 multiply-adds per 2.9 ms half (140 output frames x 24 x 2
channels). The cut-off, 22.3 kHz, is a little under the highest that keeps 95 dB (22.5 kHz) for margin.
Q30 taps against 16-bit input keep the rounding far below the 16-bit output's own (the measured 1 kHz noise is at the
16-bit floor; Q15 taps, tried on the FM-1 with 32-bit sums, were 5 dB noisier and no faster); firmware/test/usb_test.c
measures the C code (level, THD+N, the folded image) on sines."""
import cmath
import math
import sys
from pathlib import Path

L, M = 160, 147
FS = 44100.0
QB = 30                                 # Q30 taps into 64-bit sums (usb.c uac_acc_t)
CTYPE = "int16_t" if QB <= 14 else "int32_t"
N, BETA, FC = 24, 9.5, 22300.0          # taps per phase, Kaiser beta, cut-off (Hz at 44.1 kHz)
STOP = 28000.0                          # images above this fold below 20 kHz at 48 kHz
NFFT = 1 << 16


def i0(x):
    """the modified Bessel function of the first kind, order 0 (series)"""
    s, t, k = 1.0, 1.0, 1
    while t > 1e-17 * s:
        t *= (x / (2 * k)) ** 2
        s += t
        k += 1
    return s


def prototype(n, beta, fc):
    """a Kaiser-windowed sinc of L * n taps, DC gain L (unity after the zero stuffing)"""
    size = L * n
    c = fc / (FS * L)                   # cycles per sample at the up-sampled rate
    h = []
    den = i0(beta)
    for i in range(size):
        t = i - (size - 1) / 2.0
        r = 2.0 * t / (size - 1)
        w = i0(beta * math.sqrt(max(0.0, 1.0 - r * r))) / den
        x = 2.0 * c * t
        h.append(2.0 * c * (math.sin(math.pi * x) / (math.pi * x) if x else 1.0) * w)
    s = sum(h)
    return [v / s * L for v in h]


PASS = [f * 500.0 for f in range(41)]   # 0 .. 20 kHz: where a phase's rounding error is weighed


def fit(c):
    """one phase's taps in Q(QB), summing to exactly 1 << QB, rounded so that the phase's response stays as close as
    it can to the exact taps' over 0..20 kHz: plain rounding leaves each phase a slightly different gain and delay
    there, which the output hears as noise (Q14: THD+N about -81 dB at 1 kHz); moving one step of rounding from one tap
    to another while that lowers the summed squared error (complex, over PASS) takes most of it out"""
    n = len(c)
    s = sum(c)
    c = [v / s * (1 << QB) for v in c]                  # the exact taps, summing to 1 << QB
    q = [round(v) for v in c]
    big = max(range(n), key=lambda i: abs(c[i]))
    q[big] += (1 << QB) - sum(q)
    rot = [[cmath.exp(-2j * math.pi * f / FS * j) for j in range(n)] for f in PASS]
    err = [sum((q[j] - c[j]) * r[j] for j in range(n)) for r in rot]
    cost = sum(abs(e) ** 2 for e in err)
    while True:
        best = None
        for j in range(n):
            for k in range(n):
                if j == k:
                    continue
                d = [e + r[j] - r[k] for e, r in zip(err, rot)]   # q[j] + 1, q[k] - 1
                cd = sum(abs(e) ** 2 for e in d)
                if cd < cost - 1e-9 and (best is None or cd < best[0]):
                    best = (cd, j, k, d)
        if best is None:
            return q
        cost, j, k, err = best
        q[j] += 1
        q[k] -= 1


def table(h, n):
    """the table, phases 0..L-1, oldest input first, each phase summing to exactly 1 << QB; phase L-1-p is phase p
    backwards (the prototype is symmetric; usb.c stores phases 0..L/2-1 only)"""
    tab = [None] * L
    for p in range(L // 2):
        tab[p] = fit(h[p::L][::-1])
        tab[L - 1 - p] = tab[p][::-1]
    return tab


def fft(a):
    """in-place iterative radix-2 FFT of a list of complex numbers"""
    n = len(a)
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            a[i], a[j] = a[j], a[i]
    size = 2
    while size <= n:
        w = cmath.exp(-2j * math.pi / size)
        half = size // 2
        tw = [w ** k for k in range(half)]
        for start in range(0, n, size):
            for k in range(half):
                u, v = a[start + k], a[start + k + half] * tw[k]
                a[start + k], a[start + k + half] = u + v, u - v
        size <<= 1
    return a


def response(tab, n):
    """|H| (relative to DC) of the prototype the Q30 table makes, at NFFT points over the up-sampled rate"""
    h = [0.0] * (L * n)
    for p in range(L):
        for i in range(n):
            h[p + L * (n - 1 - i)] = tab[p][i] / float(1 << QB)
    spec = fft([complex(v) for v in h] + [0j] * (NFFT - len(h)))
    dc = abs(spec[0])
    return [abs(v) / dc for v in spec[:NFFT // 2]]


def db(x):
    return 20.0 * math.log10(max(x, 1e-12))


def measure(tab, n):
    mag = response(tab, n)
    df = FS * L / NFFT
    at = lambda f: mag[int(round(f / df))]
    ripple = max(abs(db(mag[k])) for k in range(int(18000 / df) + 1))
    stop = max(mag[k] for k in range(int(math.ceil(STOP / df)), len(mag)))
    return {"ripple18": ripple, "at20": db(at(20000.0)), "at22": db(at(22050.0)), "stop": db(stop),
            "at24": db(at(24100.0))}


def design(n, beta, fc):
    tab = table(prototype(n, beta, fc), n)
    if QB <= 15:                       # 32-bit sums of 16-bit input: a phase's |taps| under 2^31 / 32768
        worst = max(sum(abs(v) for v in t) for t in tab)
        assert worst * 30000 < 1 << 31, f"a 32-bit sum can overflow ({worst})"
    for p in range(L // 2):            # the symmetry usb.c relies on
        d = max(abs(a - b) for a, b in zip(tab[L - 1 - p], tab[p][::-1]))
        assert d <= 1, f"phase {p}: not the mirror of phase {L - 1 - p} ({d})"
    return tab


def best_fc(n, beta, want):
    """the highest cut-off whose stopband from 28 kHz is still at least want dB down"""
    lo, hi = 12000.0, 24000.0
    for _ in range(9):
        mid = (lo + hi) / 2
        if -measure(design(n, beta, mid), n)["stop"] >= want:
            lo = mid
        else:
            hi = mid
    return lo


def line(n, beta, fc, m):
    return (f"  N {n:2} (beta {beta:g}, cut-off {fc / 1000:.2f} kHz): passband ripple to 18 kHz {m['ripple18']:.3f} dB, "
            f"{m['at20']:+.2f} dB at 20 kHz, {m['at22']:+.1f} dB at 22.05 kHz; images from 28 kHz (folding below "
            f"20 kHz) {m['stop']:.1f} dB; {n * 2 * 140} multiply-adds a half")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--sweep":
        print("taps per phase vs. the passband, every image that folds below 20 kHz at least 95 dB down (the cut-off as high as that allows):")
        for n in (16, 20, 24, 32):
            fc = best_fc(n, BETA, 95.0)
            print(line(n, BETA, fc, measure(design(n, BETA, fc), n)))
        return
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "firmware" / "src" / "uac_fir.h"
    tab = design(N, BETA, FC)
    m = measure(tab, N)
    lines = [
        "/* SPDX-License-Identifier: GPL-3.0-only */",
        "/* generated by tools/gen_uac_fir.py: do not edit. The 44.1 -> 48 kHz polyphase FIR of the USB audio input",
        f" * (usb.c uac_tap48, FELUCCA_UAC_48K): L {L}, M {M}, {N} taps per phase, Kaiser beta {BETA:g}, cut-off {FC:g} Hz,",
        f" * Q{QB}; phases 0..{L // 2 - 1} (phase {L - 1} - p is phase p backwards), taps oldest input first, each phase",
        f" * summing to 1 << {QB}. Measured: passband within {m['ripple18']:.3f} dB to 18 kHz, {m['at20']:+.2f} dB at",
        f" * 20 kHz; images above 28 kHz (those that fold below 20 kHz) {m['stop']:.1f} dB. */",
        f"#define UAC_FIR_L {L}u",
        f"#define UAC_FIR_M {M}u",
        f"#define UAC_FIR_N {N}u",
        f"#define UAC_FIR_Q {QB}",
        f"#define UAC_FIR_T {CTYPE}",
        f"static const {CTYPE} UAC_FIR[{L // 2}][{N}] = {{",
    ]
    for p in range(L // 2):
        lines.append("    {" + ", ".join(str(v) for v in tab[p]) + "},")
    lines.append("};")
    out.write_text("\n".join(lines) + "\n")
    print(f"wrote {out}: {L // 2} x {N} taps, {L // 2 * N * (2 if CTYPE == "int16_t" else 4)} B")
    print(line(N, BETA, FC, m))


if __name__ == "__main__":
    main()
