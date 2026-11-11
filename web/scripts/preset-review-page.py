#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Build a phone-friendly listening page from rendered manifests; no audio is changed."""
import argparse
import html
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
parser.add_argument('--effects', default='../listening-3-effects')
parser.add_argument('--before', default='../final-1')
args = parser.parse_args()
root = args.directory
manifest = json.loads((root / 'manifest.json').read_text())
entries = manifest['entries']
effects_manifest = json.loads((root / args.effects / 'manifest.json').read_text())
effects = effects_manifest['entries']
esc = html.escape


def player(label, path):
    return f'<label>{esc(label)}<audio controls preload="none" src="{esc(path)}" aria-label="{esc(label)}"></audio></label>'


def sound(entry, prefix=''):
    stem = prefix + entry['id']
    return (player(entry['preset'] + ' — level matched', stem + '--matched.wav')
            + player(entry['preset'] + ' — raw', stem + '.wav')
            + f'<p class="links"><a href="{esc(stem)}.png">View sound plot</a> · <a href="{esc(stem)}.json" download>Download patch</a></p>')


style = '''
:root{color-scheme:light}*{box-sizing:border-box}body{font:17px/1.5 system-ui,sans-serif;color:#1c2930;background:#faf7ef;margin:0}
main{max-width:1000px;margin:auto;padding:24px 18px 80px}h1{font-size:2rem;line-height:1.15}h2{margin-top:2.4rem}h3{margin:.2rem 0 .8rem}
a{color:#155b77}nav{display:flex;flex-wrap:wrap;gap:8px;margin:1.5rem 0}nav a{padding:10px 14px;border:1px solid #bdc6c4;border-radius:6px;text-decoration:none}
article{border-top:1px solid #bdc6c4;padding:20px 0}audio{display:block;width:100%;max-width:440px;margin:8px 0 16px}label{display:block;font-size:.9rem}
summary{cursor:pointer;padding:16px 0;font-size:1.2rem;font-weight:650}small{display:block;color:#526068}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px}.note{padding:14px 18px;background:#e6eeeb;border-left:4px solid #386d65}.links{font-size:.9rem}
@media(max-width:640px){.pair{grid-template-columns:1fr;gap:8px}h1{font-size:1.75rem}main{padding-top:18px}}'''
body = [f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preset listening — round two</title><style>{style}</style></head><body><main>',
        '<h1>Preset listening — round two</h1>',
        '<p>Start with the gentler Lire sounds, then the different Spokes arrangements and the Monolith effects comparisons. The complete bank list follows.</p>',
        '<p>Use headphones if you can. <strong>Level matched</strong> makes tone comparisons easier with a constant volume adjustment. <strong>Raw</strong> plays the rendered level. Starting another sound pauses the previous one.</p>',
        '<nav aria-label="Listening sections"><a href="#lire">8 Lire revisions</a><a href="#spokes">Spokes arrangements</a><a href="#effects">Monolith: dry / effects</a><a href="#drums">Drum revisions</a><a href="#banks">All banks</a></nav>',
        '<p class="note">These are browser renders. The revised sounds and added effects still need your listening judgment. Device playback has not been qualified.</p>',
        '<h2 id="lire">8 Lire: less bite, more space</h2><p>Pair FM Bells uses shallower modulation and rounder waves. Feedback Howl uses lower tuning and slower, gentler feedback movement. Compare each with the earlier audition at matched loudness.</p>']
for entry in entries:
    if entry['instrument'] == '8 Lire' and entry['preset'] in ['Pair FM Bells', 'Feedback Howl']:
        body.append(f'<article><h3>{esc(entry["preset"])}</h3><div class="pair"><div>{player("Earlier — " + entry["preset"], args.before + "/" + entry["id"] + "--matched.wav")}</div><div>{sound(entry)}</div></div></article>')
body += ['<h2 id="spokes">Spokes: six different arrangements</h2>',
         '<p>Tight Techno has short single-note stabs; Boom Bap leaves the chord voice silent; Industrial uses sparse low punctuation; FM Melodic has a higher melody and open fifths; Lo-fi House has syncopated octave-and-fifth stabs. Init remains the original reference.</p>',
         '<p>The downloaded patches include these phrases. Choosing a sound preset on an existing patch still preserves your tone and chord tracks.</p>']
for entry in entries:
    if entry['instrument'] == 'Spokes 6':
        body.append(f'<article><h3>{esc(entry["preset"])}</h3>{sound(entry)}</article>')
body += ['<h2 id="effects">Monolith D: composed effects</h2>',
         '<p>Basses combine drive with a close room; leads combine echo and reverb; flute and horn add ensemble width and space. Pink Wind keeps its moving echo, reverb and chorus. Each pair plays the same synth settings and notes. Start with the level-matched versions, then use Raw to hear the actual change in level. The added effects are saved in the downloadable patch, with their own editable controls.</p>',
         '<p>These seven combinations fit the current FM-1 budget estimate. They are separate patches for comparison; they have not been added to the factory preset selector.</p>']
for index in range(0, len(effects), 2):
    dry, wet = effects[index:index + 2]
    body.append(f'<article><h3>{esc(dry["device"])} — {esc(wet["treatment"])}</h3><div class="pair"><div>{sound(dry, args.effects + "/")}</div><div>{sound(wet, args.effects + "/")}</div></div></article>')
body += ['<h2 id="drums">Drums: fewer ringing accents</h2>',
         '<p>The revised grooves give kick, snare and hats more room. The 909 and Perun patterns now use the correct hat and snare lanes. Other banks have fewer pitched hits and quieter secondary voices. Deliberately tonal choices, such as Tonal Percs, Clave and Conga and Tribal Toms, keep that role.</p>',
         '<p>Start with 909 Warehouse, Perun Punchy Breaks, Verona Dance Floor and 808 Dry Latin below. Init patterns retain the original arrangement for reference.</p>',
         '<h2 id="banks">Complete audition banks</h2><nav aria-label="Banks">']
banks = list(dict.fromkeys(entry['instrument'] for entry in entries))
for i, bank in enumerate(banks):
    body.append(f'<a href="#bank-{i}">{esc(bank)}</a>')
body.append('</nav>')
for i, bank in enumerate(banks):
    group = [entry for entry in entries if entry['instrument'] == bank]
    body.append(f'<details id="bank-{i}"><summary>{esc(bank)} — {len(group)} sounds</summary>')
    for entry in group:
        body.append(f'<article><h3>{esc(entry["preset"])}</h3>{sound(entry)}</article>')
    body.append('</details>')
body += ['<h2>Files and measurements</h2>',
         '<p>Each sound plot shows its waveform, frequency balance and spectrogram. Downloads are complete patches. Raw and matched audio contain the same performance; no extra demo limiter was applied.</p>',
         f'<p><a href="{esc(args.effects)}/manifest.json">Effects manifest</a> · <a href="manifest.json">Bank render manifest</a> · <a href="analysis.json">Measurements</a> · <a href="SHA256SUMS">File hashes</a> · <a href="{esc(args.before)}/2026-11-10-preset-review.html">First listening round</a></p>',
         f'<small>Generated ad hoc {esc(manifest["date"][:10])} from repository commit {esc(manifest["commit"])}; not maintained; stale after 24 hours. Sources: web/presets/cards, web/presets/patterns/defaults.json, web/scripts/audition-arrangements.ts, web/scripts/preset-effects-auditions.ts and web/src/engine.ts. Effects source: {esc(effects_manifest["commit"])}. The manifests identify each render’s source, including retained earlier renders.</small>',
         '</main><script>document.addEventListener("play", e => {if(e.target.tagName === "AUDIO") document.querySelectorAll("audio").forEach(a => {if(a !== e.target) a.pause()})}, true);function jump(){const node=document.getElementById(location.hash.slice(1));if(node && node.tagName === "DETAILS"){node.open=true;node.scrollIntoView({block:"start"})}}window.addEventListener("hashchange",jump);jump();</script></body></html>']
(root / '2026-11-10-preset-review.html').write_text('\n'.join(body))
print(f'{len(entries)} bank sounds + {len(effects)} dry/effected files')
