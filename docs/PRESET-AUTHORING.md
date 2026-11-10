# Making factory presets

A preset sets one instrument's card controls. A patch contains the instruments, cables and sequencer tracks. Start with a useful musical role for the preset: a short bass that leaves space for a kick, a slow pad, a dry percussion kit, or an abrasive transition. Keep an existing sound when it fills a role well. A brighter copy is useful only when it solves a different playing problem.

The owner judges musical quality by listening. A render or a plot can expose a defect and explain a change; it cannot approve the sound. Keep those two judgments separate throughout the work.

## Choose the reference and the role

Inventory the bank before editing. For each sound, record its role, intended register, useful articulation and any deliberate noise or distortion. Compare neighboring sounds and identify a gap before adding another preset. Check the current instrument's controls and known limitations; a new card does not restore a missing feature of the original instrument.

Use an original manual or patch chart when recreating a documented sound. Record the page, source URL and any control conversion. Label a setting chosen by ear or measurement as an approximation. A factory sound name alone is inspiration, not a recipe. For online audio, record the performer or manufacturer, instrument, effects, source time interval and any unknown settings. Keep downloaded third-party recordings out of the repository and audition package.

For a comparison, match notes, articulation and duration where the source permits it. Apply a constant gain to compare similar loudness. Do not add a compressor or limiter to make the candidate pass. Compare the attack, decay, harmonic balance, noise, pitch and modulation; note when the reference includes effects or several instruments. A similar spectrum does not establish an exact recreation.

## Author the sound and its demonstration

Edit `web/presets/cards/<instrument>.txt`. Use existing card-row names and units. Omitted controls retain Init's values. Explain the role in a short comment above the preset. Let the generator set the level rows; the unchanged loudness and peak contracts are [D-854](ledger/patches-and-presets.md#D-854), [D-860](ledger/patches-and-presets.md#D-860) and [D-861](ledger/patches-and-presets.md#D-861).

A drum sound also needs its own intentional groove. Author the notes in `web/presets/patterns/defaults.json`: each row names a MIDI note, `X` is a strong hit, `x` a softer hit and `.` a rest. Use timing and instrumentation to demonstrate the sound. Avoid a renamed copy of another groove. Init may preserve the original packed notes. `web/scripts/preset-pattern-build.ts` validates the names, creates packed notes and rejects duplicate patterns within a bank.

Sound cards do not contain patterns. A separate table associates each factory sound with a default pattern and a content revision. The track remembers which default it owns. Selection replaces the pattern only when the old identity is known and its notes, settings and locks still match. A user preset, an unknown identity or an edit preserves the notes. This also protects unrelated tracks, tempo and transport. See [D-882](ledger/patches-and-presets.md#D-882).

The saved identity travels separately from the readable preset name. Patches using it require format 54 and firmware reporting support. Older patches keep their older format. The editor rejects an unsupported upload before sending patch bytes. Device snapshots must be complete and belong to the current patch before their module indices can authorize replacement; SAVE or another patch boundary clears that reliance. See [D-1009](ledger/patch-format.md#D-1009).

## Generate and measure a bounded candidate

From `web/`, run these commands for the bank being edited:

```sh
npm run presets -- check
PRESET_SCOPE='Monolith D' npx vite-node scripts/gen-presets.ts
npx vite-node scripts/gen-preset-patterns.ts
npx vite-node scripts/legacy-factory.ts
npm run export-defs
npx vite-node scripts/preset-auditions.ts /absolute/path/to/auditions --only 'Monolith D'
```

`PRESET_SCOPE` limits the expensive preset measurements and patch writes to the named bank. The generator may rebuild assembly files when levels change; inspect the diff and coordinate with anyone editing shared factory structures. Do not discard someone else's changes. Regenerate factory update data after card or level changes so untouched saved factory patches can receive them; [D-283](ledger/patch-format.md#D-283) explains that migration.

The audition script writes a saved patch, raw stereo float WAV and separately matched WAV for every selected preset. The matched version uses constant gain toward −23 loudness units relative to full scale (LUFS), capped at a 0.88 peak. It may therefore remain quieter than the target. The raw version attenuates Output before the engine's final clamp and restores that gain in the float file, exposing final-output overshoot. Internal drive remains part of the instrument.

The defined phrase lasts 16 seconds at 44,118 samples per second. Melodic sounds receive low, middle and high notes, repeated attacks and a held chord. Drum tracks play for 13 seconds and then stop. Drones receive staggered keys until second 10. The remaining time exposes tails. A self-holding drone may continue after key release; that is not automatically a defect. Extend the duration for a sound whose intended use needs it. Record the exact phrase and signal stage with every peak result: this phrase cannot prove that every possible performance is safe.

In an isolated Python environment containing NumPy, SciPy, Matplotlib and SoundFile, run:

```sh
python scripts/preset-spectrograms.py /absolute/path/to/auditions
```

The page links each sound to its waveform, frequency spectrum and spectrogram. The spectrogram shows frequency over time; sustained horizontal bands reveal harmonics or resonances, and broad vertical energy often marks an attack. Inspect every retained sound as well as every new candidate. Listen to the raw and matched versions when listening is available. Record “rendered” or “visually inspected” when that is all that happened.

For harsh drones, separate intentional noise and saturation from final clipping. Compare the same phrase before and after. Inspect sustained high bands, broadband energy and changes in the feedback tail. A reduction in high-frequency energy can support a change, but does not by itself prove that the sound is more useful or that aliasing is absent.

## Review the bank

Use this rubric for each bank, and leave listening judgments open until somebody actually listens:

| Question | Evidence to retain |
|---|---|
| Does every sound have a use? | One specific role per preset, with a register or articulation when helpful. |
| Are the sounds distinct? | Side-by-side roles, card changes, raw/matched auditions and different drum grooves. |
| Does the bank express the instrument? | Relevant original controls, source links and explicit approximations or feature gaps. |
| Are the useful old sounds preserved? | Baseline files and a reason for every retained, revised or replaced selection. |
| Are unwanted clipping and harshness addressed? | Same-phrase before/after measurements, signal stage, spectrograms and tail observations. |
| Is user work protected? | Focused editor and firmware selection/save-load checks, including custom presets and edited patterns. |
| Is the candidate ready for listening? | Every scoped sound present, raw and matched audio, complete plots, exact patches and source provenance. |

Keep a dated audition package outside git. Include a manifest, hashes of the actual rendered patches and WAVs, source links, baseline comparisons and concise listening prompts. Identify the source commit and any uncommitted changes honestly. Do not relabel an earlier render as having been made from a later commit. Generated summaries carry the date, source files and the 24-hour staleness notice required by [D-013](ledger/process.md#D-013).

Run focused tests for changed selection, persistence, format and generation behavior, and the required build safeguards. A browser render is not a device recording; a C host check is not a hardware check. Follow the current development and candidate validation stages in [D-144](ledger/releases.md#D-144). The complete candidate bank goes to owner listening review before aesthetic acceptance is claimed.

[Factory sound roles](PRESET-BANKS.md) applies the role and reference part of this rubric to each scoped bank. The dated audition package carries the measured findings and the listening questions.
