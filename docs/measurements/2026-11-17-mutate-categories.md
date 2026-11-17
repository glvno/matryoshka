# Mutate with a sound category: roles, profiles and renders, 2026-11-17

Issue #1033. The owner asked: "You should be able to mutate with a specific sound category in mind. Lead stab pluck pad bass etc. how should we do that? Should we just have a freeze envelope action or should it be more than that?" He answered "yes" to the proposal in the issue: a category picker beside the Mutate amount, roles found from the wiring (layer 1), then candidates rendered with the test phrase and kept when they fit (layer 3). Tagging the factory presets by category (layer 2) comes later.

This note holds the numbers the rows rest on: [D-994](../ledger/editor.md#D-994) (the category and its profiles), [D-995](../ledger/editor.md#D-995) (how a row's role is found) and [D-996](../ledger/editor.md#D-996) (Make candidates by ear). The code is `web/src/mutate.ts` (`PROFILES`, `roleRows`) and `web/src/mutate-render.ts`.

## The profiles

Each category gives a range to each role. Times are in seconds: an attack is the time to rise to full level; a decay or a release is the time to come 99 % of the way (40 dB), as an ADSR's D and R count it. Sustain is a level from 0 to 1. The cutoff range is in octaves from the cutoff before the run of Mutates (or the candidates' parent). The lean is how far the timbre rows listed in [D-994](../ledger/editor.md#D-994) move the category's way: the middle of their move shifts by half the Mutate amount times it.

| Category | Loudness attack | Loudness decay | Loudness sustain | Loudness release | Tone attack | Tone decay | Tone sustain | Tone release | Cutoff (octaves) | Glide | Lean |
|---|---|---|---|---|---|---|---|---|---|---|---|
| lead | 0.001–0.03 | 0.1–1 | 0.6–1 | 0.03–0.4 | 0.001–0.05 | 0.1–0.8 | 0.3–0.8 | 0.05–0.5 | 0 to +1 | 0.001–0.12 | +1 |
| stab | 0.001–0.01 | 0.08–0.4 | 0–0.3 | 0.03–0.25 | 0.001–0.01 | 0.05–0.3 | 0–0.25 | 0.03–0.25 | −0.25 to +1 | 0.001–0.01 | +0.5 |
| pluck | 0.001–0.008 | 0.15–0.8 | 0–0.1 | 0.08–0.5 | 0.001–0.008 | 0.06–0.5 | 0–0.15 | 0.05–0.4 | −0.5 to +0.5 | 0.001–0.01 | +0.5 |
| pad | 0.3–2.5 | 0.5–3 | 0.6–1 | 0.8–4 | 0.2–3 | 0.5–4 | 0.4–1 | 0.8–4 | −1.5 to 0 | 0.001–0.3 | −1 |
| bass | 0.001–0.01 | 0.1–0.8 | 0.4–1 | 0.02–0.2 | 0.001–0.01 | 0.08–0.6 | 0–0.4 | 0.02–0.25 | −1.5 to 0 | 0.001–0.08 | −0.5 |
| keys | 0.001–0.012 | 0.4–2.5 | 0.15–0.6 | 0.15–0.8 | 0.001–0.02 | 0.3–2 | 0.1–0.5 | 0.1–0.8 | −0.5 to +0.5 | 0.001–0.01 | 0 |
| drone | 0.5–4 | 1–5 | 0.85–1 | 1.5–8 | 1–5 | 1–5 | 0.5–1 | 1.5–8 | −1 to +0.25 | 0.001–0.6 | −0.5 |

A glide of 0.001 s is the shortest a Slew limiter has: no glide. A range wider than a row's own range ends at the row's ends. A Rate Env's rates are whole steps, so its range is the steps whose times fall inside.

## Roles on the factory engines

`roleRows` on each factory patch as it ships. "Envelopes" counts the envelope modules with a role; "on the card" lists the engine card rows with a role, the rows Make candidates moves with nothing selected. Every engine has a loudness envelope. The drum engines' envelopes are all loudness envelopes, one per voice.

| Patch | Envelopes | On the card |
|---|---|---|
| Monolith D | 1 loudness, 1 tone | glide; filter cutoff; filter contour attack, sustain; loudness contour attack, sustain |
| Oracle V | 1 loudness, 1 tone | glide; filter cutoff; filter A, D, S, R; amp A, D, S, R |
| Silver Box | 2 loudness, 1 tone | cut off freq; tone decay |
| Hera 6 | 1 loudness | VCF freq; env A, D, S, R; portamento |
| Sallen 20 | 1 loudness | portamento; highpass and lowpass cutoff; EG 2 attack, decay, sustain, release |
| Expander S | 1 loudness, 1 tone | portamento; filter cutoff; envelopes A, D, S (1: tone; 2: loudness) |
| Algo Four | 2 loudness, 2 tone | operators 1 and 3 (carriers in the shipped algorithm): loudness; operators 2 and 4 (modulators): tone |
| Canvas | 1 loudness | envelope attack, sustain (a time), decay; portamento |
| Wanderer | 1 loudness | output lag (glide); VCF freq, HPF; envelopes attack, release |
| Briefcase 3 | 1 loudness | filter frequency; env attack, on, decay |
| Io 4 | 1 loudness, 1 tone | HPF and LPF cutoff; VCF A, D, S, R; VCA A, D, S, R; portamento |
| Vernon 100 | 1 loudness, 1 tone | filter tune; envelope 1 attack, sustain (tone); envelope 2 attack, sustain (loudness) |
| 8 Lire | 8 loudness | each voice's attack and release |
| Elvira 2 | 4 loudness | each voice's attack and release; LPF cutoff; choke |
| Scrounge | 7 loudness | each voice's tilt and gate; voice 3 tone; mod X and Y gate and slew |
| Meridian 8 | 8 loudness | 1 dot secondary (cutoff); each voice's decay and release |
| 808 Kit | 10 loudness | bass drum tone and decay; cymbal and open hihat decay |
| 909 Kit | 15 loudness | kick, toms, hihat and open hat decay; snare tone |
| Cassia 1 | 2 loudness, 2 tone | glide; DCW 1 and 2 steps (tone); DCA 1 and 2 steps (loudness) |
| Verona Drum 1 | 18 loudness | each drum's decay; multi highpass; hi hats' and clap's filter |
| Shush 101 | 1 loudness | VCF freq; env attack, decay, sustain, release; portamento |

Hera 6 and Shush 101 drive both their filter and their VCA from one ADSR: it reaches the VCA, and loudness wins over tone, so it gets the loudness role. Hera 6's second ADSR delays the LFO (it raises a VCA over the LFO), so it gets no role. An envelope a Selector does not pick in the shipped patch (Sallen 20's EG 1, one of Wanderer's two) gets no role until the Selector picks it.

## Rendering and filtering

Make candidates with a category renders each candidate with the test phrase (`renderPhrase`, the same render as the WAV export), measures it and drops it at once. On the phrase's first note it measures the attack (to 90 % of the peak), the decay and the release (the time to come 90 % of the way, doubled, which is the 99 % time for an exponential fall), the sustain (the last tenth of the hold, as a share of the peak) and the brightness (the mean frequency weighted by power: sr / 2π times the ratio of the slope's power to the sound's). The loudness is followed in 5 ms windows, averaged over 35 ms for the peak, decay, sustain and release, so a click at the start is no peak. The fit adds the octaves each time lies outside the category's loudness range, four times the share the sustain lies outside, and half the octaves the brightness moved outside the cutoff range from the parent's. A fit of 0.5 or less passes.

### Time for 16 renders

The held note (3 s held, 1 s rest, 2 s tail: 6 s of sound) rendered 16 times after one warm-up render, 44.1 kHz:

| Patch | Browser (Chromium, this Mac) | Node (`vite-node`), per render |
|---|---|---|
| Monolith D | 4.43 s | 244 ms |
| Oracle V | 4.61 s | 252 ms |
| Shush 101 | 3.48 s | 199 ms |
| Cassia 1 | 3.38 s | 210 ms |

That is well over 1.5 s, so a round runs in the background: the candidates that pass join the strip as they do, the status line counts the renders, and Make candidates again stops the round. In the browser, a round of 4 candidates on Monolith D aimed at `keys` ended after 5 renders in 1.7 s (4 passed). One aimed at `pad`, run while the pass mark was still 0.25, went through all 16 in 4.8 s, and none passed: the 4 nearest filled the round. Monolith D's release follows its DECAY ON switch, not the ADSR's release row.

### How often a candidate fits

Three candidates per factory patch and category, as Make candidates makes them with nothing selected (10 %), rendered with the held note on C4. Each cell gives how many passed (a fit of 0.5 or less). In brackets is how many passed among three candidates made without a category (Any), measured against the same profile. The seed is fixed (`mulberry32`, 11).

| Patch | lead | stab | pluck | pad | bass | keys | drone |
|---|---|---|---|---|---|---|---|
| Monolith D | 3 (2) | 3 (0) | 3 (0) | 0 (0) | 0 (1) | 3 (2) | 0 (0) |
| Oracle V | 3 (3) | 3 (0) | 3 (0) | 2 (0) | 2 (0) | 2 (0) | 3 (0) |
| Silver Box | 0 (0) | 0 (0) | 0 (0) | 0 (0) | 0 (0) | 0 (0) | 0 (0) |
| Hera 6 | 1 (1) | 1 (0) | 3 (0) | 0 (0) | 0 (0) | 0 (0) | 0 (0) |
| Sallen 20 | 3 (1) | 3 (0) | 2 (0) | 2 (0) | 2 (0) | 0 (1) | 2 (0) |
| Expander S | 0 (0) | 2 (0) | 1 (0) | 1 (1) | 0 (0) | 0 (0) | 0 (0) |
| Algo Four | 3 (0) | 0 (0) | 0 (0) | 2 (0) | 1 (0) | 3 (3) | 2 (0) |
| Canvas | 0 (0) | 1 (1) | 2 (1) | 0 (0) | 0 (0) | 0 (0) | 0 (0) |
| Wanderer | 0 (0) | 0 (0) | 0 (0) | 3 (0) | 1 (0) | 0 (0) | 2 (0) |
| Briefcase 3 | 2 (0) | 0 (0) | 0 (0) | 2 (0) | 0 (0) | 0 (0) | 3 (0) |
| Io 4 | 1 (0) | 1 (0) | 0 (0) | 0 (0) | 0 (0) | 2 (0) | 0 (0) |
| Vernon 100 | 2 (1) | 1 (0) | 3 (0) | 0 (0) | 1 (0) | 3 (0) | 0 (0) |
| 8 Lire | 0 (0) | 0 (0) | 0 (0) | 2 (0) | 0 (0) | 0 (0) | 3 (1) |
| Elvira 2 | 0 (0) | 0 (0) | 0 (0) | 2 (3) | 0 (0) | 0 (0) | 0 (2) |
| Scrounge | 0 (0) | 3 (3) | 3 (3) | 0 (0) | 0 (0) | 0 (0) | 0 (0) |
| Meridian 8 | 0 (0) | 3 (0) | 0 (0) | 0 (0) | 2 (0) | 3 (0) | 0 (0) |
| 808 Kit | 0 (0) | 3 (3) | 3 (3) | 0 (0) | 0 (0) | 0 (0) | 0 (0) |
| 909 Kit | 0 (0) | 3 (3) | 3 (3) | 0 (0) | 0 (0) | 0 (0) | 0 (0) |
| Cassia 1 | 0 (0) | 0 (0) | 0 (0) | 0 (0) | 0 (0) | 0 (0) | 0 (0) |
| Verona Drum 1 | 0 (0) | 3 (3) | 3 (3) | 0 (0) | 0 (0) | 0 (0) | 0 (0) |
| Shush 101 | 3 (1) | 3 (0) | 3 (0) | 0 (0) | 3 (2) | 3 (1) | 0 (0) |
| **all, of 63** | **21 (9)** | **33 (13)** | **32 (13)** | **16 (4)** | **12 (3)** | **19 (7)** | **15 (3)** |

With a category, 148 of 441 candidates sound the part, against 52 of 441 without one. That is why layer 3 makes four times as many and keeps those that pass. Where nothing passes, the engine's card does not reach what decides the category. Silver Box's card has no loudness envelope row. Monolith D's release follows its DECAY ON switch. Cassia 1's release measured 1.0 to 5.4 s in these renders, longer than every range but `drone`'s, and its sustain stayed under `drone`'s. The drum kits' one-shot envelopes have no sustain. The nearest candidates then fill the round.

## Limits

- The roles come from the patch as it is: a Selector that a moving signal positions passes every input, and a Selector off an envelope's way is not held, so a Mutate can still take a filter off the sound's way. Layer 3 hears the result.
- A Rate Env's times leave key scaling out.
- The render measures the phrase's first note only. Staccato hits give no sustain and no decay longer than a hit; the drum pattern measures its first hit.
- The ranges are this note's choices from common practice, not measured from the factory presets; layer 2 (tagging the factory presets by category, issue #1033) can check them.
