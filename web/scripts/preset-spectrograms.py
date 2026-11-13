#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Render raw-audio spectrograms, waveforms, spectra and a grouped local listening page.
Requires numpy, scipy, matplotlib and soundfile in an isolated Python environment.
Run DIRECTORY after audio changes; --html-only requires analysis of identical raw files.
The page links exact rendered graphs, never substitutes the current candidate bank.
"""
import argparse
import html
import hashlib
from itertools import groupby
from urllib.parse import quote
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
parser.add_argument('--html-only', action='store_true', help='Rebuild the review page from existing analysis without rerendering plots')
args = parser.parse_args()
root = args.directory
manifest = json.loads((root / 'manifest.json').read_text())
current = {entry['id']: entry for entry in manifest['entries']}
if len(current) != len(manifest['entries']):
    raise ValueError('Duplicate clip IDs in manifest')
results = []
if args.html_only:
    analysis = {entry['id']: entry for entry in json.loads((root / 'analysis.json').read_text())}
    if set(analysis) != set(current):
        raise ValueError('Analysis inventory differs from manifest; regenerate plots')
    for name, entry in current.items():
        digest = hashlib.sha256((root / f'{name}.wav').read_bytes()).hexdigest()
        if analysis[name].get('analysis_raw_sha256') != digest:
            raise ValueError(f'Stale analysis for {name}; regenerate plots')
        results.append({**analysis[name], **entry})
for entry in ([] if args.html_only else manifest['entries']):
    name = entry['id']
    x, sr = sf.read(root / f'{name}.wav', always_2d=True)
    f, t, z = signal.stft(x.T, fs=sr, nperseg=2048, noverlap=1536, boundary=None)
    power = np.mean(np.abs(z)**2, axis=0)
    db = 10 * np.log10(np.maximum(power, 1e-12))
    spectral = power.mean(axis=1)
    total = spectral.sum()
    summary = dict(entry, analysis_raw_sha256=hashlib.sha256((root / f'{name}.wav').read_bytes()).hexdigest(),
        centroid_hz=float((f * spectral).sum() / total) if total else 0,
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
# Deterministic grouping survives partial rerenders appended to the manifest.
results.sort(key=lambda e: (e['instrument'].casefold(), e['device'].casefold(),
    e['preset'] != 'Init', e['preset'].casefold(), e.get('probe', 'standard') != 'standard', e['id']))
if not args.html_only:
    (root / 'analysis.json').write_text(json.dumps(results, indent=2) + '\n')
# Portable local review package; audio is our engine only, never copied reference recordings.
esc = html.escape
groups = [(instrument, list(entries)) for instrument, entries in groupby(results, key=lambda e: e['instrument'])]
sounds = len({(e['instrument'], e['device'], e['preset']) for e in results})
performance = sum(e.get('probe') == 'performance' for e in results)
banner = f"Rendered: {manifest['date']}. Source snapshot: {manifest['sourceSnapshot']['sourceSha256']}." if manifest.get('sourceSnapshot') else f"Last render batch: {manifest['date']}. Working-tree base: {manifest.get('baseCommit', manifest.get('commit', 'not recorded'))}."
body = ['<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Preset auditions</title><style>body{font:17px/1.5 system-ui;margin:1em auto;max-width:1100px;padding:1em;background:#f7f4eb;color:#18282a}p{max-width:78ch}article{border-top:1px solid #acb7b4;padding:1.5em 0}h2{margin-top:2em;scroll-margin-top:1em}h3{margin-top:0}img{display:block;width:100%;height:auto}audio{display:block;width:100%;margin-top:.4em}nav{display:flex;flex-wrap:wrap;gap:.5em 1em;padding:1em 0}a{color:#245761}a:focus-visible{outline:3px solid #783e73;outline-offset:3px}.players{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1em}.players p{margin:.5em 0}code{overflow-wrap:anywhere}summary{cursor:pointer}small{display:block}@media(max-width:600px){body{padding:.7em;margin:0}.players{grid-template-columns:1fr}}</style></head><body>',
    '<header id="top"><h1>Preset auditions</h1>',
    f'<p>{len(results)} clips, {sounds} sounds, {len(groups)} instruments; {performance} additional performance clips.</p>',
    '<p>Start with <strong>Level matched</strong> to compare sounds at similar loudness. <strong>Raw</strong> preserves the engine output for diagnosis. Plots always describe raw audio.</p>',
    '<p>These are our browser-engine renders, not FM-1 recordings or copied reference audio. Owner listening and approval are still pending. This gallery does not qualify the current firmware.</p>',
    '<details><summary>Levels, probes and provenance</summary>',
    '<p>Matched files use constant gain only, targeting −23 LUFS (integrated loudness) with sample peaks capped at 0.88; no extra demo limiter. Raw float WAV files preserve any values beyond full scale. Performance clips add wheel motion, ordinary/accent velocities, overlapping and duophonic notes.</p>',
    '<p>Each clip links its exact rendered graph. The manifest records source-snapshot scope and SHA-256 hashes; older galleries may have only finalization-time snapshots, not render-time source attestation.</p>',
    f'<p>{esc(banner)}</p><p><a href="manifest.json">Render manifest</a> · <a href="analysis.json">Raw-audio analysis</a> · <a href="coverage.json">Coverage</a></p>',
]
if manifest.get('currentCandidate'):
    body.append('<p><a href="candidate-bank.json">Current candidate bank snapshot</a> · <a href="audition-presets.json">Current preset library</a></p>')
body.append('</details><nav aria-label="Instruments">')
for instrument, entries in groups:
    anchor = 'instrument-' + instrument.encode().hex()
    body.append(f'<a href="#{esc(anchor)}">{esc(instrument)} ({len(entries)})</a>')
body.append('</nav></header><main>')
for instrument, entries in groups:
    anchor = 'instrument-' + instrument.encode().hex()
    body.append(f'<section aria-labelledby="{esc(anchor)}"><h2 id="{esc(anchor)}">{esc(instrument)}</h2>')
    for e in entries:
        name = e['id']
        asset = quote(name, safe='')
        matched = esc(quote(e.get('matchedFile', f'{name}--matched.wav'), safe=''))
        probe = esc(e.get('probe', 'standard'))
        label = esc(f'{e["instrument"]} / {e["preset"]} / {e.get("probe", "standard")}')
        design = e.get('soundDesign')
        design_html = ''
        if design:
            effects = ', '.join(design['addedFxEnabled']) or 'none (intrinsic effects may remain)'
            design_html = f'<p><strong>Added FX:</strong> {esc(effects)}. {esc(design["fxReason"])}</p>'
            if design.get('role'):
                design_html += f'<p><strong>Role:</strong> {esc(design["role"])}</p>'
        comparison = e.get('provenance', {}).get('currentCandidateMatchesRenderedGraph')
        status = 'Matches the current candidate graph.' if comparison is True else 'Rendered graph differs from the current candidate; use this clip’s graph for provenance.' if comparison is False else 'Current-candidate graph comparison not recorded.'
        body.append(f'<article id="clip-{esc(name)}"><h3>{esc(e["device"])} / {esc(e["preset"])} — {probe}</h3>{design_html}<p>{e["loudness"]:.1f} LUFS · peak {e["peak"]:.3f} · centroid {e["centroid_hz"]:.0f} Hz · energy above 6 kHz {e["above_6k_fraction"]:.1%} · samples beyond full scale {e["samples_over_full_scale"]}</p><div class="players"><p>Level matched<audio aria-label="Level matched {label}" controls preload="none" src="{matched}"></audio></p><p>Raw<audio aria-label="Raw {label}" controls preload="none" src="{asset}.wav"></audio></p></div><p><a href="{asset}.json">Exact rendered graph</a>. {status}</p><img loading="lazy" width="1210" height="880" alt="Raw-audio spectrogram, waveform, and mean spectrum for {label}" src="{asset}.png"></article>')
    body.append('<a href="#top">Back to instruments</a></section>')
body.append('</main></body></html>')
page = root / f'{manifest["date"][:10]}-preset-auditions.html'
page.write_text('\n'.join(body))
print(f'{len(results)} clips in review page; {page}')
