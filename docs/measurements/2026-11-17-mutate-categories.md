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

Register is no part of a profile: `bass` is judged on its envelope and brightness only, so a high patch can sound like a bass in its envelope and brightness. With "Mutate pitch" on, `bass` also aims the register low: a pitch row moves only an octave down (the pitch rules still hold, so it moves by octaves only and never past the row's range).

## Roles on the factory engines

`roleRows` on each factory patch as it ships. "Envelopes" counts the envelope modules with a role; "on the card" lists the engine card rows with a role, the rows Make candidates moves with nothing selected. Every engine has a loudness envelope. The drum engines' envelopes are all loudness envelopes, one per voice.

| Patch | Envelopes | On the card |
|---|---|---|
| Monolith D | 1 loudness, 1 tone | glide; DECAY ON (both releases); filter cutoff; both contours' attack, decay (Macros through the ADSRs' parameter inputs) and sustain |
| Oracle V | 1 loudness, 1 tone | glide; voice release (a Selector feeding both releases); filter cutoff; filter A, D, S, R; amp A, D, S, R |
| Silver Box | 2 loudness, 1 tone | cut off freq; tone decay |
| Hera 6 | 1 loudness | VCF freq; env A, D, S, R; portamento |
| Sallen 20 | 1 loudness | portamento; highpass and lowpass cutoff; EG 2 attack, decay, sustain, release |
| Expander S | 1 loudness, 1 tone | portamento; filter cutoff; envelopes A, D, S (1: tone; 2: loudness; in ADS the D row plays the release too) |
| Algo Four | 2 loudness, 2 tone | operators 1 and 3 (carriers in the shipped algorithm): loudness; operators 2 and 4 (modulators): tone |
| Canvas | 1 loudness | envelope mode (sustained or one-shot, through the Env L/R's one-shot switch); attack, sustain (a time), decay; portamento |
| Wanderer | 1 loudness | output lag (glide); VCF freq, HPF; envelopes attack, release |
| Briefcase 3 | 1 loudness | filter frequency; env attack, on, decay |
| Io 4 | 1 loudness, 1 tone | HPF and LPF cutoff; VCF A, D, S, R; VCA A, D, S, R; portamento |
| Vernon 100 | 1 loudness, 1 tone | filter tune; envelope 1 attack, sustain (tone); envelope 2 attack, sustain (loudness) |
| 8 Lire | 8 loudness | each voice's attack and release; the four "fast" switches (Selectors feeding the releases) |
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

Make candidates with a category renders each candidate with the test phrase (`renderPhrase`, the same render as the WAV export), measures it and drops it at once. It measures these on the phrase's first note:

- **Attack:** twice the time to half the peak. A reverb that builds up after a quick attack moves the peak but not the half-way point. An attack up to 25 ms counts as instant, which is about as fine as the windows can tell.
- **Decay and release:** the time to come three quarters of the way, multiplied by ln 100 / ln 4, which gives the 99 % time for an exponential fall. An effect's quiet tail does not count. The decay is read only when the level falls to half the peak or below; a smaller fall is too small to time.
- **Sustain:** the last tenth of the hold, as a share of the peak. A measured sustain up to 0.15 outside the profile's range counts as inside, because the loudness follows the filter too, not the loudness envelope alone.
- **Brightness:** the mean frequency weighted by power, which is sr / 2π times the ratio of the slope's power to the sound's.

The loudness is followed in 5 ms windows, averaged over 35 ms for the peak, decay, sustain and release, so a click at the start is no peak. The fit adds the octaves each time lies outside the category's loudness range, four times the share the sustain lies outside, and half the octaves the brightness moved outside the cutoff range from the parent's. A fit of 0.5 or less passes.

### Time for 16 renders

The held note (3 s held, 1 s rest, 2 s tail: 6 s of sound) rendered 16 times after one warm-up render, 44.1 kHz:

| Patch | Browser (Chromium, this Mac) | Node (`vite-node`), per render |
|---|---|---|
| Monolith D | 4.43 s | 244 ms |
| Oracle V | 4.61 s | 252 ms |
| Shush 101 | 3.48 s | 199 ms |
| Cassia 1 | 3.38 s | 210 ms |

That is well over 1.5 s, so a round runs in the background: the candidates that pass join the strip as they do, the status line counts the renders, and Make candidates again stops the round. In the browser, a round of 4 candidates on Monolith D aimed at `keys` ended after 5 renders in 1.7 s (4 passed). One aimed at `pad`, run while the pass mark was still 0.25 and before DECAY ON had a role, went through all 16 in 4.8 s, and none passed: the 4 nearest filled the round.

### Full rounds, before and after the fixes

Every factory patch and category got one real round: Make candidates with nothing selected, 10 %, 4 to keep, up to 16 renders, the held note on C4, a fixed seed per patch and category (`mulberry32`). Each cell gives the candidates that passed / the renders. **0/16** in bold is a round that ended all-miss: none passed, so the 4 nearest filled it.

**Before** (PR #1037 as first opened):

| Patch | lead | stab | pluck | pad | bass | keys | drone |
|---|---|---|---|---|---|---|---|
| Monolith D | 4/4 | 4/8 | 4/4 | **0/16** | 1/16 | 4/4 | **0/16** |
| Oracle V | 4/4 | 4/4 | 4/4 | 4/4 | 4/5 | 4/4 | 4/4 |
| Silver Box | **0/16** | **0/16** | **0/16** | **0/16** | **0/16** | **0/16** | **0/16** |
| Hera 6 | 4/12 | 4/4 | 4/5 | **0/16** | 4/12 | 1/16 | **0/16** |
| Sallen 20 | 4/8 | 4/5 | 4/4 | 4/5 | 4/8 | 4/4 | 4/6 |
| Expander S | 1/16 | 4/8 | 2/16 | 4/8 | **0/16** | 1/16 | **0/16** |
| Algo Four | 4/4 | **0/16** | **0/16** | 4/7 | 4/7 | 4/4 | 4/5 |
| Canvas | 1/16 | 4/10 | 4/14 | 1/16 | **0/16** | **0/16** | 2/16 |
| Wanderer | 2/16 | **0/16** | **0/16** | 4/4 | 4/16 | **0/16** | 4/5 |
| Briefcase 3 | 4/15 | **0/16** | **0/16** | 4/6 | **0/16** | **0/16** | 4/6 |
| Io 4 | **0/16** | 4/5 | 4/8 | **0/16** | 1/16 | 4/6 | 2/16 |
| Vernon 100 | 4/7 | 4/5 | 4/5 | **0/16** | 4/11 | 4/6 | **0/16** |
| 8 Lire | 4/13 | **0/16** | **0/16** | 4/7 | 2/16 | **0/16** | 4/7 |
| Elvira 2 | **0/16** | **0/16** | **0/16** | 4/7 | **0/16** | **0/16** | 4/5 |
| Scrounge | **0/16** | 4/4 | 4/4 | **0/16** | **0/16** | **0/16** | **0/16** |
| Meridian 8 | **0/16** | 4/4 | **0/16** | **0/16** | 4/4 | 4/4 | **0/16** |
| 808 Kit | **0/16** | 4/4 | 4/4 | **0/16** | **0/16** | **0/16** | **0/16** |
| 909 Kit | **0/16** | 4/4 | 4/4 | **0/16** | **0/16** | **0/16** | **0/16** |
| Cassia 1 | **0/16** | **0/16** | **0/16** | 1/16 | **0/16** | **0/16** | 4/10 |
| Verona Drum 1 | **0/16** | 4/4 | 4/4 | **0/16** | **0/16** | **0/16** | **0/16** |
| Shush 101 | 4/4 | 4/4 | 4/4 | 1/16 | 4/4 | 4/4 | 2/16 |

**After**:

| Patch | lead | stab | pluck | pad | bass | keys | drone |
|---|---|---|---|---|---|---|---|
| Monolith D | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/5 |
| Oracle V | 4/4 | 4/4 | 4/4 | 4/5 | 4/4 | 4/4 | 4/4 |
| Silver Box | **0/16** | **0/16** | **0/16** | **0/16** | **0/16** | **0/16** | **0/16** |
| Hera 6 | 4/4 | 4/5 | 4/6 | 4/4 | 4/4 | 4/4 | 4/5 |
| Sallen 20 | 4/8 | 4/5 | 4/4 | 4/5 | 4/8 | 4/4 | 4/7 |
| Expander S | 4/8 | 4/6 | 4/5 | 4/5 | 4/16 | 4/4 | 4/5 |
| Algo Four | 4/4 | **0/16** | 4/4 | 4/5 | 4/4 | 4/9 | 4/4 |
| Canvas | 4/5 | 4/4 | 4/6 | 4/7 | 2/16 | 4/4 | 4/7 |
| Wanderer | 4/4 | **0/16** | **0/16** | 4/4 | 4/4 | 4/16 | 4/4 |
| Briefcase 3 | 4/6 | **0/16** | **0/16** | 4/4 | 4/10 | 4/10 | 4/4 |
| Io 4 | 4/6 | 4/5 | 4/6 | 4/4 | 4/5 | 4/6 | 4/5 |
| Vernon 100 | 4/4 | 4/4 | 4/5 | 4/9 | 4/9 | 4/5 | 4/8 |
| 8 Lire | 4/12 | **0/16** | **0/16** | 4/5 | 4/4 | 1/16 | 4/4 |
| Elvira 2 | **0/16** | **0/16** | **0/16** | 4/6 | **0/16** | 1/16 | 4/4 |
| Scrounge | **0/16** | 4/4 | 4/4 | **0/16** | **0/16** | 4/4 | **0/16** |
| Meridian 8 | 2/16 | 4/4 | 4/4 | **0/16** | 4/4 | 4/4 | **0/16** |
| 808 Kit | **0/16** | 4/4 | 4/4 | **0/16** | **0/16** | 4/4 | **0/16** |
| 909 Kit | **0/16** | 4/4 | 4/4 | **0/16** | **0/16** | 4/4 | **0/16** |
| Cassia 1 | 4/4 | 4/9 | 4/4 | 4/5 | 4/4 | 4/5 | 4/4 |
| Verona Drum 1 | **0/16** | 4/4 | 4/4 | **0/16** | **0/16** | 4/4 | **0/16** |
| Shush 101 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |

All-miss rounds: 66 of 147 before, 36 after. On the melodic engines: 34 before, 12 after.

### Why the melodic engines missed, and what changed

- **Monolith D** (pad, drone): its decay knobs are Macros that set both ADSRs' decay and release through their parameter inputs, and DECAY ON is a Selector that adds to the release. Only the ADSRs' own rows had roles. Now the Macros and DECAY ON play those stages ([D-995](../ledger/editor.md#D-995)), and DECAY ON may move when the category needs a long or short release.
- **Hera 6** (pad, drone, keys): its rows had roles, but the role reading stretched the attack with Long, while the engine stretches only the decay and release. Pads got attacks too short. The render also timed a reverb's build-up as attack.
- **Expander S** (bass, drone, lead, keys): its envelopes are in ADS mode, where the decay row also sets the release. That row now plays the release too.
- **Io 4** (lead, pad, bass, drone): its rows had roles. The misses came from the render: a small fall timed as a decay, and a release read into the effects' tail.
- **Canvas** (lead, pad, bass, keys, drone): its envelope mode is a Selector whose gate output sets the Env L/R's one-shot switch. One-shot was held, and its sustain did not count. Now one-shot reads as no sustain, and the mode Selector plays the sustain. The Selector's positions are not in order of the measure, so the longest run inside the range is used.
- **Vernon 100** (pad, drone): rows had roles; the render's attack and release readings (reverb) were the cause.
- **Briefcase 3** (stab, pluck, bass, keys): bass and keys now pass. Stab and pluck still miss: its envelope's sustain (L3, at full) is not on the card, so the card cannot make the sound fall away while the key is held.
- **Cassia 1** (every category): its release is three Env 8 steps (R4, R5, R6) and its decay two (R2, R3). Each step was kept in range on its own, but together they ran long: 1.0 to 5.4 s of release. A stage's steps now count together.
- **Algo Four** (stab, pluck): a carrier's decay is R2 and R3 together, and the two parts could not each reach a short range while the other was long. A row with no value inside now goes to the value nearest the range, so the other can follow. Pluck now passes. Stab still misses: the loudness falls in about 0.8 s, twice the carriers' decay [INFERENCE: the modulators' tone envelopes keep the carriers ringing].
- **Silver Box** (every category): its loudness envelopes are not on its card, which has only the tone envelope's decay and the cutoff. The amp decay of about 2 s is fixed, so no card row can reach it. It is left as it is.
- **Wanderer** (stab, pluck): its loudness ADSR has only attack and release on the card. Its sustain stays at full, so the card cannot make a stab or a pluck.

The other all-miss rounds are categories the engine's sound does not reach: the drum kits (808 Kit, 909 Kit, Verona Drum 1, Scrounge, Meridian 8) for lead, pad, bass and drone, with one-shot voices and no sustain. Elvira 2 is a percussion engine whose voices have only attack and release on the card. 8 Lire is a drone instrument whose voices hold at full (stab, pluck).

## Limits

- The roles come from the patch as it is: a Selector that a moving signal positions passes every input, and a Selector off an envelope's way is not held, so a Mutate can still take a filter off the sound's way. Layer 3 hears the result.
- A Rate Env's times leave key scaling out.
- The render measures the phrase's first note only. Staccato hits give no sustain and no decay longer than a hit; the drum pattern measures its first hit.
- The ranges are this note's choices from common practice, not measured from the factory presets; layer 2 (tagging the factory presets by category, issue #1033) can check them.
