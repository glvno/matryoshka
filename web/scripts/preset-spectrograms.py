#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Inspect every preset-auditions manifest entry; render spectrogram, waveform and spectrum.
Requires numpy, scipy, matplotlib and soundfile in an isolated Python environment.
"""
import argparse
import html
import json
from pathlib import Path
import numpy as np
import soundfile as sf
from scipy import signal
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
args = parser.parse_args()
root = args.directory
manifest = json.loads((root / 'manifest.json').read_text())
results = []
for entry in manifest['entries']:
    name = entry['id']
    x, sr = sf.read(root / f'{name}.wav', always_2d=True)
    f, t, z = signal.stft(x.T, fs=sr, nperseg=2048, noverlap=1536, boundary=None)
    power = np.mean(np.abs(z)**2, axis=0)
    db = 10 * np.log10(np.maximum(power, 1e-12))
    spectral = power.mean(axis=1)
    total = spectral.sum()
    summary = dict(entry, centroid_hz=float((f * spectral).sum() / total) if total else 0,
        above_6k_fraction=float(spectral[f >= 6000].sum() / total) if total else 0,
        spectral_flatness=float(np.exp(np.mean(np.log(spectral[1:] + 1e-15))) / (np.mean(spectral[1:]) + 1e-15)),
        samples_over_full_scale=int((np.abs(x) > 1).sum()), dc=float(np.mean(x)),
        release_rms=float(np.sqrt(np.mean(x[int(sr*14):] ** 2))))
    fig, axes = plt.subplots(3, 1, figsize=(11, 8), gridspec_kw={'height_ratios': [3, 1, 1.4]}, layout='constrained')
    im = axes[0].pcolormesh(t, f, db, shading='auto', cmap='magma', vmin=-100, vmax=-20)
    axes[0].set(yscale='log', ylim=(30, sr/2), ylabel='Frequency (Hz)', xlabel='Time (s)')
    fig.colorbar(im, ax=axes[0], label='dBFS per STFT bin')
    stride = 256
    trimmed = x[:len(x)//stride*stride].reshape(-1, stride, 2)
    tt = np.arange(len(trimmed))*stride/sr
    axes[1].fill_between(tt, trimmed.min(axis=(1,2)), trimmed.max(axis=(1,2)), color='#27656d')
    axes[1].axhline(1, color='red', lw=.5); axes[1].axhline(-1, color='red', lw=.5)
    axes[1].set(xlim=(0, len(x)/sr), ylabel='Amplitude', xlabel='Time (s)')
    axes[2].semilogx(f[1:], 10*np.log10(spectral[1:] + 1e-15), color='#783e73')
    axes[2].set(xlim=(30, sr/2), ylim=(-120, 0), ylabel='Mean bin power (dB)', xlabel='Frequency (Hz)')
    fig.suptitle(f"{entry['instrument']} / {entry['preset']}\nBrowser render · {entry['loudness']:.1f} LUFS · peak {entry['peak']:.3f} · >6kHz {summary['above_6k_fraction']:.1%}")
    fig.savefig(root / f'{name}.png', dpi=110)
    plt.close(fig)
    results.append(summary)
(root / 'analysis.json').write_text(json.dumps(results, indent=2) + '\n')
# Portable local review package; audio is our engine only, never copied reference recordings.
esc = html.escape
banner = f"Generated ad hoc {manifest['date']} with latest render batch from repository commit {manifest['commit']}; consult each manifest entry for its source; not maintained; stale after 24 hours. Sources: web/presets, web/presets/cards, web/src/assemblies, web/src/engine.ts."
body = ['<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Preset auditions</title><style>body{font:17px system-ui;margin:2em auto;max-width:1100px;padding:1em;background:#f7f4eb;color:#18282a}article{border-top:1px solid #acb7b4;padding:2em 0}img{width:100%;height:auto}audio{max-width:100%}small{display:block}nav a{margin-right:1em}</style>',
    f'<h1>Preset auditions — candidates for review</h1><p>{esc(banner)}</p>',
    '<p>No owner listening or approval is claimed. Browser renders are not FM-1 recordings. Raw diagnostic files retain peaks above full scale; matched files use constant gain only, targeting −23 LUFS with peak capped at 0.88. No extra demo limiter is used.</p>', '<nav>']
for instrument in dict.fromkeys(e['instrument'] for e in results):
    body.append(f'<a href="#{esc(instrument)}">{esc(instrument)}</a>')
body.append('</nav>')
previous = None
for e in results:
    if previous != e['instrument']:
        body.append(f'<h2 id="{esc(e["instrument"])}">{esc(e["instrument"])}</h2>'); previous = e['instrument']
    name = e['id']
    body.append(f'<article><h3>{esc(e["device"])} / {esc(e["preset"])}</h3><p>{e["loudness"]:.1f} LUFS · peak {e["peak"]:.3f} · centroid {e["centroid_hz"]:.0f} Hz · energy above 6 kHz {e["above_6k_fraction"]:.1%} · samples beyond full scale {e["samples_over_full_scale"]}</p><p>Raw <audio controls preload="none" src="{name}.wav"></audio></p><p>Level matched <audio controls preload="none" src="{name}--matched.wav"></audio></p><img loading="lazy" alt="Spectrogram, waveform, and mean spectrum for {esc(e["preset"])}" src="{name}.png"></article>')
body.append('</html>')
(root / '2026-11-10-preset-auditions.html').write_text('\n'.join(body))
print(f'{len(results)} presets analyzed; {root}/2026-11-10-preset-auditions.html')
