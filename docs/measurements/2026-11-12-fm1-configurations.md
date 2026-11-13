# FM-1 configuration catalogue — 12 November 2026

A configuration recommendation catalogue incorporating the recorded hardware retests, not a new bank or an importable patch. Use http://127.0.0.1:5179/fm1-configurations.html for searchable filters, more-voices comparisons, current-ceiling-only options and full per-row history. The HTML is self-contained and also opens offline.

**168 configurations; 36 entries superseded by later proven same/better configurations removed.** Current means firmware `cf98f1087249abe6d9e55363eab789459d0f970ce2d9a1e6f4b0109dc6745c5d`. Older evidence never inherits current qualification.

**Include** = eligible audition candidate/protected source, not a request to install every duplicate. **Needs more testing** = potential configuration without complete current qualification. **Exclude** = the stated resource, guard, policy or unresolved-identity recommendation; these entries remain visible.

Grouped by instrument, ordered by the best recommendation in each group: Include → Needs more testing → Exclude. Configurations use the same recommendation order within each group; equal-ranked groups are alphabetical. Within a recommendation, at-parity profiles prioritize more FX before extra voices.

**Inclusion coverage: all 22 FM-1 instruments have an Include nomination.** 13 have current-qualified melodic profiles; 9 are unchanged protected entries, not freshly re-surveyed.

**Outside the bank policy:** Basic Poly, Drift Poly, Init, Mono Lead, Plucked String, Simple FM, Supersaw Stack are editor examples with Exclude recommendations, not missing FM-1 nominations.

Hera distinctions: the published three-note shared-filter profile keeps independent AMP envelopes; the four-note shared-filter Chorus+Delay alternative also qualifies. The original-polyphony/native-Chorus-only three-note option is distinct; its requested retest appears below with the intended bank name Hera 3.

Effects below are **total kinds**, including native effects. Auxiliary voices do not add played notes. For older-only rows, the peak is the worst retained older observation, not a current CPU prediction. Zero guard counts cover only tested phases; stopped runs leave the rest unknown.

**Mono retests:** harmonizers are physically removed, not merely bypassed; Steps/Arp and original DSP remain. The status and individual results are retained in the JSON’s `monoRetest`. Harmonizer-enabled results are not silently reused as harmonizer-free qualification. Canvas byte-fit variants abbreviate display captions only. 5 complete passes and 4 stopped failures over 44/56 observed phases; all three compact Canvas alternatives fit bytes but none cleared the original 95% gate in that initial batch. Later requested retests are separately identified; published bank unchanged.

**Original-synth/FX policy:** once hardware played-note parity is reached, complete the FX rack before adding voices. Above-parity configurations without all of Drive + Chorus + Delay + Reverb are Exclude, even after a CPU pass. Original counts and mode/articulation caveats are shown per instrument; they are not the source patch allocator counts.

Pruning is based on demonstrated supersession, never the recommendation label or a failed/unmeasured result. A replacement must have a final current-firmware complete pass, at least the same played notes and added effects, the same intrinsic effects, and no additional articulation coupling or DSP compromises. Unknown identities and current failures remain visible. Every removed ID has a replacement ID and both evidence records in `supersededConfigurations` in the JSON. Superseded runs for retained profiles remain in history.

## Latest owner-requested retests

Five-second phases; full matrices must stay below 100% with zero mute, shedding or observed late halves. This scoped interpretation treats 95% as a headroom warning, not a global policy change. Earlier stopped results remain in Sources and history. Reduced-headroom acceptances cannot prune stricter candidates.

| Configuration | Recommendation | Observed peak | Phases | Mute / shed / late |
|---|---|---:|---:|---|
| Algo Four: 4 notes, Drive + Delay + Reverb | Include | 88.8% | 8/8 | 0 / 0 / 0 |
| Canvas: mono, Drive + Delay + Reverb, no harmonizer | Include — reduced headroom | 96.6% | 4/4 | 0 / 0 / 0 |
| Expander: 3 notes, full rack | Include — reduced headroom | 97.8% | 8/8 | 0 / 0 / 0 |
| Hera 3: 3 independent voices, native Chorus | Include | 89.2% | 4/4 | 0 / 0 / 0 |
| Sallen 20: mono, Chorus + Delay + Reverb, no harmonizer | Include — reduced headroom | 95.3% | 4/4 | 0 / 0 / 0 |

## 8 Lire

1 Include

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `protected-8-lire` (published) | Played count unresolved; Protected source patch unchanged; no FX/player rewriting | Not audited / unknown | **Include** — Keep the approved source unchanged; not a fresh hardware qualification. | Protected / not re-surveyed; no new hardware CPU measurement |

## 808 Kit

1 Include

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `protected-808-kit` (published) | Played count unresolved; Protected source patch unchanged; no FX/player rewriting | Not audited / unknown | **Include** — Keep the approved source unchanged; not a fresh hardware qualification. | Protected / not re-surveyed; no new hardware CPU measurement |

## 909 Kit

1 Include

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `protected-909-kit` (published) | Played count unresolved; Protected source patch unchanged; no FX/player rewriting | Not audited / unknown | **Include** — Keep the approved source unchanged; not a fresh hardware qualification. | Protected / not re-surveyed; no new hardware CPU measurement |

## Algo Four

2 Include, 19 Needs more testing

Original: **Yamaha DX100 — 8 played notes.** Eight notes in POLY mode; one note in MONO mode. Four operators are timbral components, not four played-note voices. [Source 1](https://synthfool.com/docs/Yamaha/DX_Series/Yamaha%20DX-100%20Owners%20Manual.pdf#page=13) [Source 2](https://manualsdump.com/en/manuals/yamaha-dx100/243897/14)

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `selected-algo-four` (published) | 3 played notes; Original articulation retained | drive, chorus, delay, reverb | **Include** — Complete current-firmware pass; published selection, pending owner listening. | Current; 92.7% peak; 8/8 phases; mute 0, shed 0, late 0; [S38] |
| `algo-four-v4-drive-delay-reverb` | 4 played notes; Original articulation retained | drive, delay, reverb | **Include** — Complete current-firmware retest, five seconds per phase with zero observed guards. Meets the standard 95% headroom ceiling. Additional audition candidate; published bank unchanged. | Current; 88.8% peak; 8/8 phases; mute 0, shed 0, late 0; [S20] |
| `algo-four-original-drive-chorus-delay-reverb` | 8 played notes; Original articulation retained | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 134.0% peak; 1/8 phases; mute 0, shed 4, late 6; [S10] |
| `algo-four-shared-contours-original-drive-chorus-delay-reverb` | 8 played notes; Algo Four: operators 3+4 EGs shared across eight locally pitched oscillator banks; heard carriers additionally follow local Op1 amplitude; PM paths retained. | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 139.9% peak; 1/8 phases; mute 0, shed 4, late 6; [S24] |
| `algo-four-shared-operator4-original-drive-chorus-delay-reverb` | 8 played notes; Algo Four: only operator 4 EG shared across eight locally pitched oscillator banks; local Op1 carrier guard; PM paths retained. | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 138.2% peak; 1/8 phases; mute 0, shed 4, late 6; [S28] |
| `algo-four-original-chorus-delay-reverb` | 8 played notes; Original articulation retained | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 131.8% peak; 1/4 phases; mute 0, shed 4, late 6; [S12] |
| `algo-four-original-drive-chorus-delay` | 8 played notes; Original articulation retained | drive, chorus, delay | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 115.1% peak; 1/8 phases; mute 0, shed 2, late 3; [S12] |
| `algo-four-original-drive-chorus-reverb` | 8 played notes; Original articulation retained | drive, chorus, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 126.3% peak; 1/8 phases; mute 0, shed 4, late 6; [S12] |
| `algo-four-original-drive-delay-reverb` | 8 played notes; Original articulation retained | drive, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 127.0% peak; 1/8 phases; mute 0, shed 4, late 6; [S12] |
| `algo-four-v4-drive-chorus-delay` | 4 played notes; Original articulation retained | drive, chorus, delay | **Needs more testing** — Promising complete pass on an earlier build; needs current native55 resource and full-phase requalification, then owner audition. **Retest priority 2:** Older complete8/8 clean77.016% pass offers strong headroom evidence for one more note than the selected three-note full rack. Independent articulation retained; Reverb omitted. Needs current full-phase qualification. | Older only; 77.0% peak; 8/8 phases; mute 0, shed 0, late 0; [S9] |
| `algo-four-v5-drive-chorus-delay` | 5 played notes; Original articulation retained | drive, chorus, delay | **Needs more testing** — Promising complete pass on an earlier build; needs current native55 resource and full-phase requalification, then owner audition. **Retest priority 3:** Older complete8/8 clean93.212% pass gains two notes over the selected three-note full rack while remaining below original DX100 polyphony. Less headroom than four notes; Reverb omitted. Needs current qualification. | Older only; 93.2% peak; 8/8 phases; mute 0, shed 0, late 0; [S3] |
| `algo-four-v4-drive-chorus-delay-reverb` | 4 played notes; Original articulation retained | drive, chorus, delay, reverb | **Needs more testing** — Observed phases are clean but above 95%. Needs genuine headroom improvement or an explicit owner ceiling decision, then full-matrix qualification; untested phases remain unknown. | Current; 96.6% peak; 1/8 phases; mute 0, shed 0, late 0; [S14] |
| `algo-four-v6-drive-delay` | 6 played notes; Original articulation retained | drive, delay | **Needs more testing** — Promising complete pass on an earlier build; needs current native55 resource and full-phase requalification, then owner audition. | Older only; 89.0% peak; 8/8 phases; mute 0, shed 0, late 0; [S3] |
| `algo-four-original-none` | 8 played notes; Original articulation retained | None | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 98.3% peak; 1/4 phases; mute 0, shed 0, late 0; [S11] |
| `algo-four-shared-contours-original-none` | 8 played notes; Algo Four: operators 3+4 EGs shared across eight locally pitched oscillator banks; heard carriers additionally follow local Op1 amplitude; PM paths retained. | None | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 103.2% peak; 1/4 phases; mute 0, shed 0, late 0; [S25] |
| `algo-four-shared-operator4-original-none` | 8 played notes; Algo Four: only operator 4 EG shared across eight locally pitched oscillator banks; local Op1 carrier guard; PM paths retained. | None | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 102.4% peak; 1/4 phases; mute 0, shed 0, late 0; [S29] |
| `algo-four-v5-drive-chorus-delay-reverb` | 5 played notes; Original articulation retained | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 110.6% peak; 1/8 phases; mute 0, shed 1, late 2; [S10] |
| `algo-four-v6-drive-chorus-delay` | 6 played notes; Original articulation retained | drive, chorus, delay | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 96.4% peak; 1/8 phases; mute 0, shed 0, late 0; [S9] |
| `algo-four-v6-drive-chorus-delay-reverb` | 6 played notes; Original articulation retained | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 113.7% peak; 1/8 phases; mute 0, shed 2, late 4; [S10] |
| `algo-four-v7-drive-chorus-delay-reverb` | 7 played notes; Original articulation retained | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 130.8% peak; 1/8 phases; mute 0, shed 3, late 5; [S10] |
| `algo-four-v7-none` | 7 played notes; Original articulation retained | None | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 95.6% peak; 1/4 phases; mute 0, shed 0, late 0; [S9] |

## Briefcase 3

4 Include, 3 Needs more testing

Original: **EMS VCS3 / Synthi VCS3, ordinary EMS keyboard articulation — 1 played notes.** Monophonic keyboard control of a patchable studio. Multiple oscillators, free-running drones, or external audio do not constitute independently keyed polyphonic voices. [Source 1](https://www.manualslib.com/manual/4172126/Ems-Synthi-Vcs3.html?page=16#manual)

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `briefcase-3-original-drive-chorus-delay-no-harm` | 1 played notes; Original articulation retained; harmonizer removed | drive, chorus, delay, reverb | **Include** — Complete current-firmware pass; additional audition candidate, not yet selected for the bank. | Current; 94.8% peak; 8/8 phases; mute 0, shed 0, late 0; [S17] |
| `selected-briefcase-3` (published) | 1 played notes; Original articulation retained | chorus, delay, reverb | **Include** — Complete current-firmware pass; published selection, pending owner listening. | Current; 92.8% peak; 4/4 phases; mute 0, shed 0, late 0; [S37] |
| `briefcase-3-original-drive-chorus-no-harm` | 1 played notes; Original articulation retained; harmonizer removed | drive, chorus, reverb | **Include** — Complete current-firmware pass; additional audition candidate, not yet selected for the bank. | Current; 90.0% peak; 8/8 phases; mute 0, shed 0, late 0; [S17] |
| `briefcase-3-original-drive-delay-no-harm` | 1 played notes; Original articulation retained; harmonizer removed | drive, delay, reverb | **Include** — Complete current-firmware pass; additional audition candidate, not yet selected for the bank. | Current; 87.6% peak; 8/8 phases; mute 0, shed 0, late 0; [S17] |
| `briefcase-3-original-drive-chorus-delay` | 1 played notes; Original articulation retained | drive, chorus, delay, reverb | **Needs more testing** — Observed phases are clean but above 95%. Needs genuine headroom improvement or an explicit owner ceiling decision, then full-matrix qualification; untested phases remain unknown. Harmonizer-free retest: briefcase-3-original-drive-chorus-delay-no-harm (Include); its result does not qualify this harmonizer-enabled configuration. | Current; 95.6% peak; 4/8 phases; mute 0, shed 0, late 0; [S14] |
| `briefcase-3-original-drive-chorus` | 1 played notes; Original articulation retained | drive, chorus, reverb | **Needs more testing** — Promising complete pass on an earlier build; needs current native55 resource and full-phase requalification, then owner audition. Harmonizer-free retest: briefcase-3-original-drive-chorus-no-harm (Include); its result does not qualify this harmonizer-enabled configuration. | Older only; 93.5% peak; 8/8 phases; mute 0, shed 0, late 0; [S12] |
| `briefcase-3-original-drive-delay` | 1 played notes; Original articulation retained | drive, delay, reverb | **Needs more testing** — Promising complete pass on an earlier build; needs current native55 resource and full-phase requalification, then owner audition. Harmonizer-free retest: briefcase-3-original-drive-delay-no-harm (Include); its result does not qualify this harmonizer-enabled configuration. | Older only; 92.9% peak; 8/8 phases; mute 0, shed 0, late 0; [S12] |

## Canvas

2 Include, 2 Needs more testing, 3 Exclude

Original: **Buchla Music Easel (208 Stored Program Sound Source / 218 keyboard; repo follows 2013 208e/218e second-edition directive) — 1 played notes.** Monophonic keyboard MAIN pitch CV, shared by complex and modulation oscillators through their keyboard switches; dual lopass gates and separately patched sequencing/drone sources are not two independently key-playable voices. [Source 1](https://buchla.com/guides/Buchla_Music_Easel_Manual.pdf#page=23) [Source 2](https://buchla.com/guides/218e-V3_User%27s_Guide_v5.1.pdf#page=10)

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `canvas-original-delay-no-harm` | 1 played notes; Original articulation retained; harmonizer removed | drive, delay, reverb | **Include** — Complete current-firmware retest, five seconds per phase with zero observed guards. Accepted under the scoped owner retest interpretation: below 100%, but exceeds the 95% headroom target. Additional audition candidate; published bank unchanged. Display captions abbreviated; all controls, choices and DSP retained. | Current; 96.6% peak; 4/4 phases; mute 0, shed 0, late 0; [S20] |
| `selected-canvas` (published) | 1 played notes; Original articulation retained | drive, reverb | **Include** — Complete current-firmware pass; published selection, pending owner listening. | Current; 92.2% peak; 4/4 phases; mute 0, shed 0, late 0; [S38] |
| `canvas-original-chorus` | 1 played notes; Original Canvas DSP and articulation; intrinsic Drive/Reverb retained; added FX shown separately. Prepared but byte-blocked, no hardware phases. | drive, chorus, reverb | **Needs more testing** — Prepared or historically byte-blocked only; confirm the current native byte budget before any CPU qualification. Harmonizer-free retest: canvas-original-chorus-no-harm (Exclude); its result does not qualify this harmonizer-enabled configuration. | Prepared only; no new hardware CPU measurement |
| `canvas-original-delay` | 1 played notes; Original Canvas DSP and articulation; intrinsic Drive/Reverb retained; added FX shown separately. Prepared but byte-blocked, no hardware phases. | drive, delay, reverb | **Needs more testing** — Prepared or historically byte-blocked only; confirm the current native byte budget before any CPU qualification. Harmonizer-free retest: canvas-original-delay-no-harm (Include); its result does not qualify this harmonizer-enabled configuration. | Prepared only; no new hardware CPU measurement |
| `canvas-original-chorus-delay` | 1 played notes; Original Canvas DSP and articulation; intrinsic Drive/Reverb retained; added FX shown separately. Prepared but byte-blocked, no hardware phases. | drive, chorus, delay, reverb | **Exclude** — Current native patch exceeds the byte budget before upload; removing the CPU ceiling cannot fix this. Harmonizer-free retest: canvas-original-chorus-delay-no-harm (Exclude); its result does not qualify this harmonizer-enabled configuration. | Current; no new hardware CPU measurement |
| `canvas-original-chorus-delay-no-harm` | 1 played notes; Original articulation retained; harmonizer removed | drive, chorus, delay, reverb | **Exclude** — Current measured mute, shedding or late halves: not merely a 95% ceiling rejection. Display captions abbreviated; all controls, choices and DSP retained. | Current; 103.3% peak; 1/4 phases; mute 1, shed 0, late 0; [S5] |
| `canvas-original-chorus-no-harm` | 1 played notes; Original articulation retained; harmonizer removed | drive, chorus, reverb | **Exclude** — Current measured mute, shedding or late halves: not merely a 95% ceiling rejection. Display captions abbreviated; all controls, choices and DSP retained. | Current; 95.7% peak; 1/4 phases; mute 1, shed 0, late 0; [S5] |

## Cassia 1

1 Include, 4 Needs more testing, 2 Exclude

Original: **Casio CZ-1, normal single-tone two-line mode — 8 played notes.** Two-line LINE SELECT 1+2′ and 1+1′: 8 played notes. Single-line 1 or 2: 16 played notes. TONE MIX: 4 notes; SOLO: 1. TONE MIX layers whole tones and must not be confused with a two-line single tone. [Source 1](https://archive.org/download/synthmanual-casio-cz-1-owners-manual/casiocz-1ownersmanual_text.pdf#page=33) [Source 2](https://archive.org/download/synthmanual-casio-cz-1-owners-manual/casiocz-1ownersmanual_djvu.txt)

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `selected-cassia-1` (published) | 4 played notes; Original articulation retained | drive, chorus, delay | **Include** — Complete current-firmware pass; published selection, pending owner listening. | Current; 92.9% peak; 8/8 phases; mute 0, shed 0, late 0; [S37] |
| `cassia-1-original-delay-reverb` | 4 played notes; Original articulation retained | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 111.1% peak; 1/4 phases; mute 0, shed 2, late 3; [S12] |
| `cassia-1-original-drive-reverb` | 4 played notes; Original articulation retained | drive, chorus, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 108.3% peak; 1/8 phases; mute 0, shed 2, late 2; [S12] |
| `cassia-1-shared-contours-original-drive-delay-reverb` | 4 played notes; Cassia: shared DCO/DCW pitch/brightness contours for both lines; independent DCA amplitude/release, touch, delayed vibrato and ring/noise paths; four pitched notes. | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 111.3% peak; 1/8 phases; mute 0, shed 2, late 3; [S24] |
| `cassia-1-v3-drive-delay-reverb` | 3 played notes; Original articulation retained | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 112.3% peak; 1/8 phases; mute 0, shed 1, late 2; [S10] |
| `cassia-1-original-drive-delay-reverb` | 4 played notes; Original articulation retained | drive, chorus, delay, reverb | **Exclude** — Current measured mute, shedding or late halves: not merely a 95% ceiling rejection. | Current; 109.1% peak; 1/8 phases; mute 0, shed 2, late 3; [S14] |
| `early-paired-bounded-cassia-1` | Played count unresolved; Original allocator count/parameters retained; Harmony type0/ext0 (NONE), Arp enabled/bypassed in measured phases. Not a paraphonic rewrite. | drive, chorus, delay, reverb | **Exclude** — Earlier draft topology or unresolved binary identity; not nominated without a source-backed configuration. No equivalent replacement is assumed. | Prepared only; no new hardware CPU measurement |

## Elvira 2

1 Include

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `protected-elvira-2` (published) | Played count unresolved; Protected source patch unchanged; no FX/player rewriting | Not audited / unknown | **Include** — Keep the approved source unchanged; not a fresh hardware qualification. | Protected / not re-surveyed; no new hardware CPU measurement |

## Expander S

2 Include, 13 Needs more testing

Original: **Oberheim Four Voice (four SEM voice cards with polyphonic keyboard) — 4 played notes.** Four independently articulated synthesizer voices, one complete SEM per simultaneously played note; not one played note per oscillator. [Source 1](https://www.outofphase.fr/wp-content/uploads/2022/12/instruction_manual_fvs.pdf#page=2)

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `selected-expander-s` (published) | 2 played notes; Original articulation retained | drive, chorus, delay, reverb | **Include** — Complete current-firmware pass; published selection, pending owner listening. | Current; 81.3% peak; 8/8 phases; mute 0, shed 0, late 0; [S38] |
| `expander-s-v3-drive-chorus-delay-reverb` | 3 played notes; Original articulation retained | drive, chorus, delay, reverb | **Include** — Complete current-firmware retest, five seconds per phase with zero observed guards. Accepted under the scoped owner retest interpretation: below 100%, but exceeds the 95% headroom target. Additional audition candidate; published bank unchanged. | Current; 97.8% peak; 8/8 phases; mute 0, shed 0, late 0; [S20] |
| `expander-s-original-drive-chorus-delay-reverb` | 4 played notes; Original articulation retained | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 100.3% peak; 1/8 phases; mute 0, shed 1, late 2; [S10] |
| `expander-s-shared-articulation-original-drive-chorus-delay-reverb` | 4 played notes; auxiliary 1; Shared filter AND shared amplitude phrase: first held processed key attacks; overlaps join ongoing amp contour, released overlap loses pitch immediately; final membership follows common hold/release. | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 105.0% peak; 1/8 phases; mute 0, shed 2, late 2; [S33] |
| `expander-s-shared-filter-original-drive-chorus-delay-reverb` | 4 played notes; auxiliary 1; Pitched notes retain independent amplitude attack/release; summed amplitude-shaped audio feeds shared filter(s), phrase filter EG and last-held processed-note keytracking. | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 101.0% peak; 1/8 phases; mute 0, shed 2, late 1; [S26] |
| `expander-s-original-drive-chorus-delay` | 4 played notes; Original articulation retained | drive, chorus, delay | **Needs more testing** — Promising complete pass on an earlier build; needs current native55 resource and full-phase requalification, then owner audition. **Retest priority 1:** Strongest original-polyphony recovery prospect: older complete8/8 clean81.289% pass, substantial headroom and Four Voice parity. Four notes instead of the selected two; gives up Reverb. Needs current full-phase qualification. | Older only; 81.3% peak; 8/8 phases; mute 0, shed 0, late 0; [S12] |
| `expander-s-original-drive-chorus-reverb` | 4 played notes; Original articulation retained | drive, chorus, reverb | **Needs more testing** — Promising complete pass on an earlier build; needs current native55 resource and full-phase requalification, then owner audition. | Older only; 94.3% peak; 8/8 phases; mute 0, shed 0, late 0; [S12] |
| `expander-s-original-drive-delay-reverb` | 4 played notes; Original articulation retained | drive, delay, reverb | **Needs more testing** — Promising complete pass on an earlier build; needs current native55 resource and full-phase requalification, then owner audition. | Older only; 92.9% peak; 8/8 phases; mute 0, shed 0, late 0; [S12] |
| `expander-s-original-chorus-delay-reverb` | 4 played notes; Original articulation retained | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 95.9% peak; 1/4 phases; mute 0, shed 0, late 0; [S12] |
| `expander-s-shared-articulation-original-chorus-delay-reverb` | 4 played notes; auxiliary 1; Shared filter AND shared amplitude phrase: first held processed key attacks; overlaps join ongoing amp contour, released overlap loses pitch immediately; final membership follows common hold/release. | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 103.3% peak; 1/4 phases; mute 0, shed 2, late 1; [S32] |
| `expander-s-original-none` | 4 played notes; Original articulation retained | None | **Needs more testing** — Promising complete pass on an earlier build; needs current native55 resource and full-phase requalification, then owner audition. | Older only; 64.2% peak; 4/4 phases; mute 0, shed 0, late 0; [S11] |
| `expander-s-shared-articulation-original-none` | 4 played notes; auxiliary 1; Shared filter AND shared amplitude phrase: first held processed key attacks; overlaps join ongoing amp contour, released overlap loses pitch immediately; final membership follows common hold/release. | None | **Needs more testing** — Promising complete pass on an earlier build; needs current native55 resource and full-phase requalification, then owner audition. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 71.4% peak; 4/4 phases; mute 0, shed 0, late 0; [S34] |
| `expander-s-shared-filter-original-none` | 4 played notes; auxiliary 1; Pitched notes retain independent amplitude attack/release; summed amplitude-shaped audio feeds shared filter(s), phrase filter EG and last-held processed-note keytracking. | None | **Needs more testing** — Promising complete pass on an earlier build; needs current native55 resource and full-phase requalification, then owner audition. | Older only; 66.8% peak; 4/4 phases; mute 0, shed 0, late 0; [S27] |
| `expander-s-shared-articulation-v3-drive-chorus-delay-reverb` | 3 played notes; auxiliary 1; Shared filter AND shared amplitude phrase: first held processed key attacks; overlaps join ongoing amp contour, released overlap loses pitch immediately; final membership follows common hold/release. | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 103.5% peak; 1/8 phases; mute 0, shed 1, late 1; [S30] |
| `expander-s-shared-filter-v3-drive-chorus-delay-reverb` | 3 played notes; auxiliary 1; Pitched notes retain independent amplitude attack/release; summed amplitude-shaped audio feeds shared filter(s), phrase filter EG and last-held processed-note keytracking. | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 97.0% peak; 1/8 phases; mute 0, shed 1, late 0; [S31] |

## Hera 4

3 Include, 16 Needs more testing

Original: **Roland JUNO-106 — 6 played notes.** Six independent polyphonic synth voices; unison is an intentional alternate articulation. [Source 1](https://cdn.roland.com/assets/media/pdf/JUNO-106_OM.pdf#page=1)

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `selected-hera-4` (published) | 3 played notes; auxiliary 1; Shared filter / filter envelope / keytracking; independent per-note amplitude and release | drive, chorus, delay | **Include** — Complete current-firmware pass; published selection, pending owner listening. | Current; 90.8% peak; 8/8 phases; mute 0, shed 0, late 0; [S37] |
| `hera-4-shared-filter-original-delay` | 4 played notes; auxiliary 1; Pitched notes retain independent amplitude attack/release; summed amplitude-shaped audio feeds shared filter(s), phrase filter EG and last-held processed-note keytracking. | chorus, delay | **Include** — Complete current-firmware pass; additional audition candidate, not yet selected for the bank. | Current; 89.4% peak; 4/4 phases; mute 0, shed 0, late 0; [S14] |
| `hera-4-v3-none` | 3 played notes; auxiliary 1; Original polyphony: independent per-note filter and amplitude envelopes | chorus | **Include** — Complete current-firmware retest, five seconds per phase with zero observed guards. Meets the standard 95% headroom ceiling. Additional audition candidate; published bank unchanged. | Current; 89.2% peak; 4/4 phases; mute 0, shed 0, late 0; [S20] |
| `hera-4-shared-filter-original-drive` | 4 played notes; auxiliary 1; Pitched notes retain independent amplitude attack/release; summed amplitude-shaped audio feeds shared filter(s), phrase filter EG and last-held processed-note keytracking. | drive, chorus | **Needs more testing** — Promising complete pass on an earlier build; needs current native55 resource and full-phase requalification, then owner audition. | Older only; 91.6% peak; 8/8 phases; mute 0, shed 0, late 0; [S19] |
| `hera-4-original-delay-reverb` | 4 played notes; auxiliary 1; Original polyphony: independent per-note filter and amplitude envelopes | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 122.1% peak; 1/4 phases; mute 1, shed 3, late 6; [S12] |
| `hera-4-original-drive-delay` | 4 played notes; auxiliary 1; Original polyphony: independent per-note filter and amplitude envelopes | drive, chorus, delay | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 106.2% peak; 1/8 phases; mute 0, shed 2, late 3; [S12] |
| `hera-4-original-drive-delay-reverb` | 4 played notes; auxiliary 1; Original polyphony: independent per-note filter and amplitude envelopes | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 125.9% peak; 1/8 phases; mute 1, shed 3, late 6; [S10] |
| `hera-4-original-drive-reverb` | 4 played notes; auxiliary 1; Original polyphony: independent per-note filter and amplitude envelopes | drive, chorus, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 121.0% peak; 1/8 phases; mute 0, shed 3, late 4; [S12] |
| `hera-4-original-none` | 4 played notes; auxiliary 1; Original polyphony: independent per-note filter and amplitude envelopes | chorus | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 96.2% peak; 1/4 phases; mute 0, shed 0, late 0; [S11] |
| `hera-4-shared-articulation-original-delay-reverb` | 4 played notes; auxiliary 1; Shared filter AND shared amplitude phrase: first held processed key attacks; overlaps join ongoing amp contour, released overlap loses pitch immediately; final membership follows common hold/release. | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 102.5% peak; 1/4 phases; mute 1, shed 3, late 0; [S32] |
| `hera-4-shared-articulation-original-drive-delay` | 4 played notes; auxiliary 1; Shared filter AND shared amplitude phrase: first held processed key attacks; overlaps join ongoing amp contour, released overlap loses pitch immediately; final membership follows common hold/release. | drive, chorus, delay | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 96.8% peak; 1/8 phases; mute 0, shed 0, late 0; [S30] |
| `hera-4-shared-articulation-original-drive-delay-reverb` | 4 played notes; auxiliary 1; Shared filter AND shared amplitude phrase: first held processed key attacks; overlaps join ongoing amp contour, released overlap loses pitch immediately; final membership follows common hold/release. | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 105.5% peak; 1/8 phases; mute 1, shed 3, late 0; [S33] |
| `hera-4-shared-articulation-v3-delay-reverb` | 3 played notes; auxiliary 1; Shared filter AND shared amplitude phrase: first held processed key attacks; overlaps join ongoing amp contour, released overlap loses pitch immediately; final membership follows common hold/release. | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 108.3% peak; 1/4 phases; mute 1, shed 2, late 2; [S30] |
| `hera-4-shared-filter-original-drive-delay` | 4 played notes; auxiliary 1; Pitched notes retain independent amplitude attack/release; summed amplitude-shaped audio feeds shared filter(s), phrase filter EG and last-held processed-note keytracking. | drive, chorus, delay | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 97.2% peak; 2/8 phases; mute 0, shed 0, late 0; [S31] |
| `hera-4-shared-filter-original-drive-delay-reverb` | 4 played notes; auxiliary 1; Pitched notes retain independent amplitude attack/release; summed amplitude-shaped audio feeds shared filter(s), phrase filter EG and last-held processed-note keytracking. | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 116.2% peak; 1/8 phases; mute 1, shed 3, late 6; [S26] |
| `hera-4-shared-filter-v3-delay-reverb` | 3 played notes; auxiliary 1; Pitched notes retain independent amplitude attack/release; summed amplitude-shaped audio feeds shared filter(s), phrase filter EG and last-held processed-note keytracking. | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 112.5% peak; 1/4 phases; mute 1, shed 2, late 3; [S13] |
| `hera-4-v3-delay` | 3 played notes; auxiliary 1; Original polyphony: independent per-note filter and amplitude envelopes | chorus, delay | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 102.1% peak; 1/4 phases; mute 0, shed 1, late 1; [S9] |
| `hera-4-v3-drive` | 3 played notes; auxiliary 1; Original polyphony: independent per-note filter and amplitude envelopes | drive, chorus | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 99.2% peak; 1/8 phases; mute 0, shed 0, late 0; [S9] |
| `hera-4-v3-drive-delay-reverb` | 3 played notes; auxiliary 1; Original polyphony: independent per-note filter and amplitude envelopes | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 123.3% peak; 1/8 phases; mute 1, shed 2, late 4; [S10] |

## Io 4

1 Include, 10 Needs more testing, 3 Exclude

Original: **Roland JUPITER-4 — 4 played notes.** Four-note normal polyphony; unison modes intentionally change how the four hardware voices are distributed. [Source 1](https://www.roland.com/global/products/rc_jupiter-4/)

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `selected-io-4` (published) | 4 played notes; auxiliary 1; Original articulation retained | drive, chorus, delay | **Include** — Complete current-firmware pass; published selection, pending owner listening. | Current; 88.1% peak; 8/8 phases; mute 0, shed 0, late 0; [S38] |
| `io-4-shared-articulation-original-drive-delay-reverb` | 4 played notes; auxiliary 1; Shared filter AND shared amplitude phrase: first held processed key attacks; overlaps join ongoing amp contour, released overlap loses pitch immediately; final membership follows common hold/release. | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 99.5% peak; 1/8 phases; mute 0, shed 2, late 0; [S33] |
| `io-4-shared-filter-original-drive-delay-reverb` | 4 played notes; auxiliary 1; Pitched notes retain independent amplitude attack/release; summed amplitude-shaped audio feeds shared filter(s), phrase filter EG and last-held processed-note keytracking. | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 105.6% peak; 1/8 phases; mute 0, shed 2, late 1; [S26] |
| `io-4-original-delay-reverb` | 4 played notes; auxiliary 1; Original articulation retained | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 104.2% peak; 1/4 phases; mute 0, shed 2, late 1; [S12] |
| `io-4-original-drive-reverb` | 4 played notes; auxiliary 1; Original articulation retained | drive, chorus, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 102.6% peak; 1/8 phases; mute 0, shed 2, late 1; [S12] |
| `io-4-shared-articulation-original-delay-reverb` | 4 played notes; auxiliary 1; Shared filter AND shared amplitude phrase: first held processed key attacks; overlaps join ongoing amp contour, released overlap loses pitch immediately; final membership follows common hold/release. | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 97.3% peak; 1/4 phases; mute 0, shed 2, late 0; [S32] |
| `io-4-shared-filter-original-delay-reverb` | 4 played notes; auxiliary 1; Pitched notes retain independent amplitude attack/release; summed amplitude-shaped audio feeds shared filter(s), phrase filter EG and last-held processed-note keytracking. | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 101.4% peak; 1/4 phases; mute 0, shed 2, late 1; [S31] |
| `io-4-shared-articulation-v3-delay-reverb` | 3 played notes; auxiliary 1; Shared filter AND shared amplitude phrase: first held processed key attacks; overlaps join ongoing amp contour, released overlap loses pitch immediately; final membership follows common hold/release. | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 97.6% peak; 1/4 phases; mute 0, shed 1, late 0; [S22] |
| `io-4-shared-filter-v3-delay-reverb` | 3 played notes; auxiliary 1; Pitched notes retain independent amplitude attack/release; summed amplitude-shaped audio feeds shared filter(s), phrase filter EG and last-held processed-note keytracking. | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 101.1% peak; 1/4 phases; mute 0, shed 1, late 1; [S19] |
| `io-4-v3-delay-reverb` | 3 played notes; auxiliary 1; Original articulation retained (allocator reductions, when present, do not themselves share envelopes). | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 102.1% peak; 1/4 phases; mute 0, shed 1, late 1; [S21] |
| `io-4-v3-drive-delay-reverb` | 3 played notes; auxiliary 1; Original articulation retained | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 105.2% peak; 1/8 phases; mute 0, shed 1, late 1; [S10] |
| `io-4-original-drive-delay-reverb` | 4 played notes; auxiliary 1; Original articulation retained | drive, chorus, delay, reverb | **Exclude** — Current measured mute, shedding or late halves: not merely a 95% ceiling rejection. | Current; 106.5% peak; 1/8 phases; mute 0, shed 2, late 1; [S14] |
| `early-initial-io-4-56629cc7c07c` | Played count unresolved; Original graph/articulation unresolved for this retained binary | Not audited / unknown | **Exclude** — Earlier draft topology or unresolved binary identity; not nominated without a source-backed configuration. No equivalent replacement is assumed. | Older only; 123.6% peak; 1/? phases; mute 1, shed 3, late 7; [S16] |
| `early-paired-bounded-io-4` | Played count unresolved; Original allocator count/parameters retained; Harmony type0/ext0 (NONE), Arp enabled/bypassed in measured phases. Not a paraphonic rewrite. | drive, chorus, delay, reverb | **Exclude** — Earlier draft topology or unresolved binary identity; not nominated without a source-backed configuration. No equivalent replacement is assumed. | Prepared only; no new hardware CPU measurement |

## Meridian 8

1 Include

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `protected-meridian-8` (published) | Played count unresolved; Protected source patch unchanged; no FX/player rewriting | Not audited / unknown | **Include** — Keep the approved source unchanged; not a fresh hardware qualification. | Protected / not re-surveyed; no new hardware CPU measurement |

## Monolith D

1 Include, 2 Exclude

Original: **Moog Minimoog Model D — 1 played notes.** Monophonic; its three oscillators form one played-note voice. [Source 1](https://cdn.inmusicbrands.com/Moog/Model%20D/Minimoog_Model_D_Manual.pdf#page=15)

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `selected-monolith-d` (published) | 1 played notes; Original articulation retained | drive, chorus, delay, reverb | **Include** — Complete current-firmware pass; published selection, pending owner listening. | Current; 84.1% peak; 8/8 phases; mute 0, shed 0, late 0; [S38] |
| `early-initial-monolith-d-74be2485dec1` | Played count unresolved; Original graph/articulation unresolved for this retained binary | Not audited / unknown | **Exclude** — Earlier draft topology or unresolved binary identity; not nominated without a source-backed configuration. No equivalent replacement is assumed. | Older only; 101.7% peak; 1/? phases; mute 0, shed 0, late 1; [S16] |
| `early-paired-bounded-monolith-d` | Played count unresolved; Original allocator count/parameters retained; Harmony type0/ext0 (NONE), Arp enabled/bypassed in measured phases. Not a paraphonic rewrite. | drive, chorus, delay, reverb | **Exclude** — Earlier draft topology or unresolved binary identity; not nominated without a source-backed configuration. No equivalent replacement is assumed. | Prepared only; no new hardware CPU measurement |

## Oracle V

1 Include, 16 Needs more testing, 1 Exclude

Original: **Sequential Prophet-5 (Rev 4 per repository fidelity ledger) — 5 played notes.** Five-note polyphonic in normal operation; monophonic in unison. [Source 1](https://sequential.com/classics-reissued/prophet-5-10/)

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `selected-oracle-v` (published) | 4 played notes; Original articulation retained | drive, chorus | **Include** — Complete current-firmware pass; published selection, pending owner listening. | Current; 93.5% peak; 8/8 phases; mute 0, shed 0, late 0; [S38] |
| `oracle-v-original-drive-delay` | 4 played notes; Original articulation retained | drive, delay | **Needs more testing** — Promising complete pass on an earlier build; needs current native55 resource and full-phase requalification, then owner audition. | Older only; 92.1% peak; 8/8 phases; mute 0, shed 0, late 0; [S9] |
| `oracle-v-shared-articulation-original-none` | 4 played notes; auxiliary 1; Shared filter AND shared amplitude phrase: first held processed key attacks; overlaps join ongoing amp contour, released overlap loses pitch immediately; final membership follows common hold/release. | None | **Needs more testing** — Promising complete pass on an earlier build; needs current native55 resource and full-phase requalification, then owner audition. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 85.3% peak; 4/4 phases; mute 0, shed 0, late 0; [S34] |
| `oracle-v-shared-filter-original-none` | 4 played notes; auxiliary 1; Pitched notes retain independent amplitude attack/release; summed amplitude-shaped audio feeds shared filter(s), phrase filter EG and last-held processed-note keytracking. | None | **Needs more testing** — Promising complete pass on an earlier build; needs current native55 resource and full-phase requalification, then owner audition. | Older only; 82.4% peak; 4/4 phases; mute 0, shed 0, late 0; [S27] |
| `oracle-v-original-chorus-delay` | 4 played notes; Original articulation retained | chorus, delay | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 96.0% peak; 1/4 phases; mute 0, shed 0, late 0; [S9] |
| `oracle-v-original-chorus-delay-reverb` | 4 played notes; Original articulation retained | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 124.0% peak; 1/4 phases; mute 0, shed 2, late 5; [S12] |
| `oracle-v-original-drive-chorus-delay` | 4 played notes; Original articulation retained | drive, chorus, delay | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 97.6% peak; 1/8 phases; mute 0, shed 0, late 0; [S12] |
| `oracle-v-original-drive-chorus-reverb` | 4 played notes; Original articulation retained | drive, chorus, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 121.7% peak; 1/8 phases; mute 0, shed 2, late 3; [S12] |
| `oracle-v-original-drive-delay-reverb` | 4 played notes; Original articulation retained | drive, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 121.0% peak; 1/8 phases; mute 0, shed 2, late 3; [S12] |
| `oracle-v-shared-articulation-original-chorus-delay-reverb` | 4 played notes; auxiliary 1; Shared filter AND shared amplitude phrase: first held processed key attacks; overlaps join ongoing amp contour, released overlap loses pitch immediately; final membership follows common hold/release. | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 120.3% peak; 1/4 phases; mute 0, shed 3, late 6; [S32] |
| `oracle-v-shared-articulation-original-drive-chorus-delay-reverb` | 4 played notes; auxiliary 1; Shared filter AND shared amplitude phrase: first held processed key attacks; overlaps join ongoing amp contour, released overlap loses pitch immediately; final membership follows common hold/release. | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 130.7% peak; 1/8 phases; mute 1, shed 3, late 6; [S33] |
| `oracle-v-shared-articulation-v3-chorus-delay-reverb` | 3 played notes; auxiliary 1; Shared filter AND shared amplitude phrase: first held processed key attacks; overlaps join ongoing amp contour, released overlap loses pitch immediately; final membership follows common hold/release. | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Audition the explicit shared-envelope/overlap compromise; do not treat it as transparent. | Older only; 114.2% peak; 1/4 phases; mute 0, shed 2, late 4; [S30] |
| `oracle-v-shared-filter-original-drive-chorus-delay-reverb` | 4 played notes; auxiliary 1; Pitched notes retain independent amplitude attack/release; summed amplitude-shaped audio feeds shared filter(s), phrase filter EG and last-held processed-note keytracking. | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 123.8% peak; 1/8 phases; mute 1, shed 3, late 6; [S26] |
| `oracle-v-shared-filter-v3-chorus-delay-reverb` | 3 played notes; auxiliary 1; Pitched notes retain independent amplitude attack/release; summed amplitude-shaped audio feeds shared filter(s), phrase filter EG and last-held processed-note keytracking. | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 112.9% peak; 1/4 phases; mute 0, shed 1, late 3; [S31] |
| `oracle-v-v3-chorus-delay-reverb` | 3 played notes; Original articulation retained | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 113.1% peak; 1/4 phases; mute 0, shed 1, late 3; [S23] |
| `oracle-v-v3-drive-chorus-delay` | 3 played notes; Original articulation retained | drive, chorus, delay | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 97.9% peak; 1/8 phases; mute 0, shed 0, late 0; [S9] |
| `oracle-v-v3-drive-chorus-delay-reverb` | 3 played notes; Original articulation retained | drive, chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 116.3% peak; 1/8 phases; mute 0, shed 1, late 3; [S10] |
| `oracle-v-original-drive-chorus-delay-reverb` | 4 played notes; Original articulation retained | drive, chorus, delay, reverb | **Exclude** — Current measured mute, shedding or late halves: not merely a 95% ceiling rejection. | Current; 123.6% peak; 1/8 phases; mute 0, shed 2, late 5; [S14] |

## Perun 4

1 Include

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `protected-perun-4` (published) | Played count unresolved; Protected source patch unchanged; no FX/player rewriting | Not audited / unknown | **Include** — Keep the approved source unchanged; not a fresh hardware qualification. | Protected / not re-surveyed; no new hardware CPU measurement |

## Sallen 20

4 Include, 3 Needs more testing, 3 Exclude

Original: **Korg MS-20 — 1 played notes.** Monophonic; the two VCOs do not provide independently keyed notes. [Source 1](https://www.korg.com/us/products/synthesizers/ms_20mini/)

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `selected-sallen-20` (published) | 1 played notes; Original articulation retained | drive, chorus, delay | **Include** — Complete current-firmware pass; published selection, pending owner listening. | Current; 83.3% peak; 8/8 phases; mute 0, shed 0, late 0; [S38] |
| `sallen-20-original-chorus-delay-reverb-no-harm` | 1 played notes; Original articulation retained; harmonizer removed | chorus, delay, reverb | **Include** — Complete current-firmware retest, five seconds per phase with zero observed guards. Accepted under the scoped owner retest interpretation: below 100%, but exceeds the 95% headroom target. Additional audition candidate; published bank unchanged. | Current; 95.3% peak; 4/4 phases; mute 0, shed 0, late 0; [S20] |
| `sallen-20-original-drive-chorus-reverb-no-harm` | 1 played notes; Original articulation retained; harmonizer removed | drive, chorus, reverb | **Include** — Complete current-firmware pass; additional audition candidate, not yet selected for the bank. | Current; 93.7% peak; 8/8 phases; mute 0, shed 0, late 0; [S17] |
| `sallen-20-original-drive-delay-reverb-no-harm` | 1 played notes; Original articulation retained; harmonizer removed | drive, delay, reverb | **Include** — Complete current-firmware pass; additional audition candidate, not yet selected for the bank. | Current; 92.7% peak; 8/8 phases; mute 0, shed 0, late 0; [S17] |
| `sallen-20-original-chorus-delay-reverb` | 1 played notes; Original articulation retained | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Harmonizer-free retest: sallen-20-original-chorus-delay-reverb-no-harm (Include); its result does not qualify this harmonizer-enabled configuration. | Older only; 100.4% peak; 1/4 phases; mute 1, shed 0, late 1; [S12] |
| `sallen-20-original-drive-chorus-reverb` | 1 played notes; Original articulation retained | drive, chorus, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Harmonizer-free retest: sallen-20-original-drive-chorus-reverb-no-harm (Include); its result does not qualify this harmonizer-enabled configuration. | Older only; 97.5% peak; 1/8 phases; mute 1, shed 0, late 0; [S12] |
| `sallen-20-original-drive-delay-reverb` | 1 played notes; Original articulation retained | drive, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. Harmonizer-free retest: sallen-20-original-drive-delay-reverb-no-harm (Include); its result does not qualify this harmonizer-enabled configuration. | Older only; 95.7% peak; 2/8 phases; mute 0, shed 0, late 0; [S12] |
| `sallen-20-original-drive-chorus-delay-reverb` | 1 played notes; Original articulation retained | drive, chorus, delay, reverb | **Exclude** — Current measured mute, shedding or late halves: not merely a 95% ceiling rejection. | Current; 97.3% peak; 1/8 phases; mute 1, shed 0, late 0; [S14] |
| `early-initial-sallen-20-9a280981348d` | Played count unresolved; Original graph/articulation unresolved for this retained binary | Not audited / unknown | **Exclude** — Earlier draft topology or unresolved binary identity; not nominated without a source-backed configuration. No equivalent replacement is assumed. | Older only; 106.5% peak; 1/? phases; mute 1, shed 0, late 0; [S16] |
| `early-paired-bounded-sallen-20` | Played count unresolved; Original allocator count/parameters retained; Harmony type0/ext0 (NONE), Arp enabled/bypassed in measured phases. Not a paraphonic rewrite. | drive, chorus, delay, reverb | **Exclude** — Earlier draft topology or unresolved binary identity; not nominated without a source-backed configuration. No equivalent replacement is assumed. | Prepared only; no new hardware CPU measurement |

## Scrounge

1 Include

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `protected-scrounge` (published) | Played count unresolved; Protected source patch unchanged; no FX/player rewriting | Not audited / unknown | **Include** — Keep the approved source unchanged; not a fresh hardware qualification. | Protected / not re-surveyed; no new hardware CPU measurement |

## Silver Box

1 Include, 2 Exclude

Original: **Roland TB-303 Bass Line — 1 played notes.** Monophonic sequenced bass line. [Source 1](https://www.roland.com/uk/promos/303day/)

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `selected-silver-box` (published) | 1 played notes; Original articulation retained | drive, chorus, delay, reverb | **Include** — Complete current-firmware pass; published selection, pending owner listening. | Current; 73.7% peak; 8/8 phases; mute 0, shed 0, late 0; [S38] |
| `early-initial-silver-box-d6bb24801631` | Played count unresolved; Original graph/articulation unresolved for this retained binary | Not audited / unknown | **Exclude** — Earlier draft topology or unresolved binary identity; not nominated without a source-backed configuration. No equivalent replacement is assumed. | Older only; 106.5% peak; 3/? phases; mute 1, shed 0, late 0; [S16] |
| `early-paired-bounded-silver-box` | Played count unresolved; Original allocator count/parameters retained; Harmony type0/ext0 (NONE), Arp enabled/bypassed in measured phases. Not a paraphonic rewrite. | drive, chorus, delay, reverb | **Exclude** — Earlier draft topology or unresolved binary identity; not nominated without a source-backed configuration. No equivalent replacement is assumed. | Older only; 91.7% peak; 4/4 phases; mute 0, shed 0, late 0; [S15] |

## Spokes 6

1 Include

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `protected-spokes-6` (published) | Played count unresolved; Protected source patch unchanged; no FX/player rewriting | Not audited / unknown | **Include** — Keep the approved source unchanged; not a fresh hardware qualification. | Protected / not re-surveyed; no new hardware CPU measurement |

## Vernon 100

1 Include, 4 Needs more testing, 2 Exclude

Original: **EML ElectroComp 100 (Model 100 panel target; related 101 manuals are qualified corroboration only) — 2 played notes.** [INFERENCE] Qualified dual-pitch/paraphonic baseline: original Model 100 panel has separate KB1 and KB2 keyboard outputs and separate oscillator assignments, feeding a shared filter/amplitude shaper. Four oscillators are not four independently played notes. Exact original multi-key priority and overlap retrigger remain unresolved. [Source 1](https://lh3.googleusercontent.com/blogger_img/APIUysh7mIUl7SKJRpBejVp_gtd6PbM0Ccf-eU6MfiDRo2SaGMJPIU9MXoWAHSPI8pjGwkdYBksi7tLGAaJP_YA=s1600) [Source 2](https://lh3.googleusercontent.com/blogger_img/APIUysh1nskuQPbtL4dqOdwdA9USvwHBZ9s8fHBRsR3wv7fZe9fbOiQFwasg49LEdK-8gVeyXDpr67XY9GG_rm0=s1600) [Source 3](https://synthfool.com/docs/EML/100_series/eml101_service.pdf) [Source 4](https://synthfool.com/docs/EML/100_series/eml101_user_manual.pdf)

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `selected-vernon-100` (published) | 2 played notes; Original two-pitch paraphony | drive, chorus, delay | **Include** — Complete current-firmware pass; published selection, pending owner listening. | Current; 81.8% peak; 8/8 phases; mute 0, shed 0, late 0; [S38] |
| `vernon-100-original-drive-chorus-delay-reverb` | 2 played notes; Original two-pitch paraphony | drive, chorus, delay, reverb | **Needs more testing** — Observed phases are clean but above 95%. Needs genuine headroom improvement or an explicit owner ceiling decision, then full-matrix qualification; untested phases remain unknown. | Current; 97.8% peak; 1/8 phases; mute 0, shed 0, late 0; [S14] |
| `vernon-100-original-chorus-delay-reverb` | 2 played notes; Original two-pitch paraphony | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 95.8% peak; 1/4 phases; mute 0, shed 0, late 0; [S12] |
| `vernon-100-original-drive-chorus-reverb` | 2 played notes; Original two-pitch paraphony | drive, chorus, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 95.2% peak; 1/8 phases; mute 0, shed 0, late 0; [S12] |
| `vernon-100-original-drive-delay-reverb` | 2 played notes; Original two-pitch paraphony | drive, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 95.5% peak; 1/8 phases; mute 0, shed 0, late 0; [S12] |
| `early-initial-vernon-100-6171ca8e7b98` | Played count unresolved; Original graph/articulation unresolved for this retained binary | Not audited / unknown | **Exclude** — Earlier draft topology or unresolved binary identity; not nominated without a source-backed configuration. No equivalent replacement is assumed. | Older only; 104.8% peak; 1/? phases; mute 1, shed 0, late 0; [S16] |
| `early-paired-bounded-vernon-100` | Played count unresolved; Original allocator count/parameters retained; Harmony type0/ext0 (NONE), Arp enabled/bypassed in measured phases. Not a paraphonic rewrite. | drive, chorus, delay, reverb | **Exclude** — Earlier draft topology or unresolved binary identity; not nominated without a source-backed configuration. No equivalent replacement is assumed. | Prepared only; no new hardware CPU measurement |

## Verona Drum 1

1 Include

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `protected-verona-drum-1` (published) | Played count unresolved; Protected source patch unchanged; no FX/player rewriting | Not audited / unknown | **Include** — Keep the approved source unchanged; not a fresh hardware qualification. | Protected / not re-surveyed; no new hardware CPU measurement |

## Wanderer

1 Include, 3 Needs more testing, 3 Exclude

Original: **ARP Odyssey (original architecture; repo specifies Rev 3 / 24 dB filter) — 2 played notes.** Duophonic/paraphonic: keyboard supplies lowest-held-key CV to VCO 1 and highest-held-key CV to VCO 2; a single key drives both. One shared filter and amp with shared envelope articulation, not two complete independent voice cards. Sync or LF settings can remove independent two-pitch behavior. [Source 1](http://www.arpodyssey.com/manuals/OddyMan29.jpg) [Source 2](https://cdn.korg.com/us/support/download/files/2da5c4341ec598574d4af552ecb88b6e.pdf#page=4)

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `selected-wanderer` (published) | 2 played notes; Original two-pitch paraphony | drive, delay, reverb | **Include** — Complete current-firmware pass; published selection, pending owner listening. | Current; 91.3% peak; 8/8 phases; mute 0, shed 0, late 0; [S37] |
| `wanderer-original-drive-chorus-delay` | 2 played notes; Original two-pitch paraphony | drive, chorus, delay | **Needs more testing** — Promising complete pass on an earlier build; needs current native55 resource and full-phase requalification, then owner audition. | Older only; 83.3% peak; 8/8 phases; mute 0, shed 0, late 0; [S12] |
| `wanderer-original-chorus-delay-reverb` | 2 played notes; Original two-pitch paraphony | chorus, delay, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 98.4% peak; 1/4 phases; mute 1, shed 0, late 0; [S12] |
| `wanderer-original-drive-chorus-reverb` | 2 played notes; Original two-pitch paraphony | drive, chorus, reverb | **Needs more testing** — No complete qualification on the current firmware; re-encode/check resources and rerun the full phase set before treating this older option as eligible. | Older only; 97.0% peak; 1/8 phases; mute 0, shed 0, late 0; [S12] |
| `wanderer-original-drive-chorus-delay-reverb` | 2 played notes; Original two-pitch paraphony | drive, chorus, delay, reverb | **Exclude** — Current measured mute, shedding or late halves: not merely a 95% ceiling rejection. | Current; 97.5% peak; 1/8 phases; mute 1, shed 0, late 0; [S14] |
| `early-initial-wanderer-ccdf525cdeda` | Played count unresolved; Original graph/articulation unresolved for this retained binary | Not audited / unknown | **Exclude** — Earlier draft topology or unresolved binary identity; not nominated without a source-backed configuration. No equivalent replacement is assumed. | Older only; 105.2% peak; 1/? phases; mute 1, shed 0, late 0; [S16] |
| `early-paired-bounded-wanderer` | Played count unresolved; Original allocator count/parameters retained; Harmony type0/ext0 (NONE), Arp enabled/bypassed in measured phases. Not a paraphonic rewrite. | drive, chorus, delay, reverb | **Exclude** — Earlier draft topology or unresolved binary identity; not nominated without a source-backed configuration. No equivalent replacement is assumed. | Prepared only; no new hardware CPU measurement |

## Basic Poly

3 Exclude

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `early-initial-basic-poly-00af6652d404` | Played count unresolved; Original graph/articulation unresolved for this retained binary | Not audited / unknown | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 101.0% peak; 3/? phases; mute 0, shed 2, late 0; [S16] |
| `early-paired-bounded-basic-poly` | Played count unresolved; Original allocator count/parameters retained; Harmony type0/ext0 (NONE), Arp enabled/bypassed in measured phases. Not a paraphonic rewrite. | drive, chorus, delay, reverb | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 81.5% peak; 4/4 phases; mute 0, shed 0, late 0; [S15] |
| `revised-evidence-basic-poly` | Played count unresolved; No paraphonic rewrite. Recipes change Harmony/Arp and held notes, not patch topology. type1/ext3 is C9: [0,4,7,10,14], not Cmaj9. | drive, chorus, delay, reverb | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 79.7% peak; 4/4 phases; mute 0, shed 0, late 0; [S35] |

## Drift Poly

3 Exclude

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `early-initial-drift-poly-d07dea37704d` | Played count unresolved; Original graph/articulation unresolved for this retained binary | Not audited / unknown | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 104.3% peak; 3/? phases; mute 1, shed 3, late 3; [S16] |
| `early-paired-bounded-drift-poly` | Played count unresolved; Original allocator count/parameters retained; Harmony type0/ext0 (NONE), Arp enabled/bypassed in measured phases. Not a paraphonic rewrite. | drive, chorus, delay, reverb | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Prepared only; no new hardware CPU measurement |
| `revised-evidence-drift-poly` | Played count unresolved; No paraphonic rewrite. Recipes change Harmony/Arp and held notes, not patch topology. type1/ext3 is C9: [0,4,7,10,14], not Cmaj9. | drive, chorus, delay, reverb | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 89.4% peak; 4/4 phases; mute 0, shed 0, late 0; [S35] |

## Init

3 Exclude

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `early-initial-init-c719e46dfb8d` | Played count unresolved; Original graph/articulation unresolved for this retained binary | Not audited / unknown | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 100.8% peak; 3/? phases; mute 0, shed 0, late 0; [S16] |
| `early-paired-bounded-init` | Played count unresolved; Original allocator count/parameters retained; Harmony type0/ext0 (NONE), Arp enabled/bypassed in measured phases. Not a paraphonic rewrite. | drive, chorus, delay, reverb | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 76.5% peak; 4/4 phases; mute 0, shed 0, late 0; [S15] |
| `revised-evidence-init` | Played count unresolved; No paraphonic rewrite. Recipes change Harmony/Arp and held notes, not patch topology. type1/ext3 is C9: [0,4,7,10,14], not Cmaj9. | drive, chorus, delay, reverb | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 73.7% peak; 4/4 phases; mute 0, shed 0, late 0; [S35] |

## Mono Lead

3 Exclude

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `early-initial-mono-lead-74aa815cc1ac` | Played count unresolved; Original graph/articulation unresolved for this retained binary | Not audited / unknown | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 101.8% peak; 3/? phases; mute 1, shed 0, late 1; [S16] |
| `early-paired-bounded-mono-lead` | Played count unresolved; Original allocator count/parameters retained; Harmony type0/ext0 (NONE), Arp enabled/bypassed in measured phases. Not a paraphonic rewrite. | drive, chorus, delay, reverb | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 80.4% peak; 4/4 phases; mute 0, shed 0, late 0; [S15] |
| `revised-evidence-mono-lead` | Played count unresolved; No paraphonic rewrite. Recipes change Harmony/Arp and held notes, not patch topology. type1/ext3 is C9: [0,4,7,10,14], not Cmaj9. | drive, chorus, delay, reverb | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 77.6% peak; 4/4 phases; mute 0, shed 0, late 0; [S35] |

## Plucked String

3 Exclude

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `early-initial-plucked-string-0d9c313d12a1` | Played count unresolved; Original graph/articulation unresolved for this retained binary | Not audited / unknown | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 101.8% peak; 3/? phases; mute 0, shed 2, late 0; [S16] |
| `early-paired-bounded-plucked-string` | Played count unresolved; Original allocator count/parameters retained; Harmony type0/ext0 (NONE), Arp enabled/bypassed in measured phases. Not a paraphonic rewrite. | drive, chorus, delay, reverb | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 82.6% peak; 4/4 phases; mute 0, shed 0, late 0; [S15] |
| `revised-evidence-plucked-string` | Played count unresolved; No paraphonic rewrite. Recipes change Harmony/Arp and held notes, not patch topology. type1/ext3 is C9: [0,4,7,10,14], not Cmaj9. | drive, chorus, delay, reverb | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 78.5% peak; 4/4 phases; mute 0, shed 0, late 0; [S35] |

## Simple FM

3 Exclude

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `early-initial-simple-fm-2131ff7bf731` | Played count unresolved; Original graph/articulation unresolved for this retained binary | Not audited / unknown | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 97.7% peak; 3/? phases; mute 0, shed 0, late 0; [S16] |
| `early-paired-bounded-simple-fm` | Played count unresolved; Original allocator count/parameters retained; Harmony type0/ext0 (NONE), Arp enabled/bypassed in measured phases. Not a paraphonic rewrite. | drive, chorus, delay, reverb | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 76.8% peak; 4/4 phases; mute 0, shed 0, late 0; [S15] |
| `revised-evidence-simple-fm` | Played count unresolved; No paraphonic rewrite. Recipes change Harmony/Arp and held notes, not patch topology. type1/ext3 is C9: [0,4,7,10,14], not Cmaj9. | drive, chorus, delay, reverb | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 73.8% peak; 4/4 phases; mute 0, shed 0, late 0; [S35] |

## Supersaw Stack

3 Exclude

| Configuration | Notes / articulation | Total effects | Recommendation / reason | Evidence and observed result |
|---|---|---|---|---|
| `early-initial-supersaw-stack-b7dfac26cd95` | Played count unresolved; Original graph/articulation unresolved for this retained binary | Not audited / unknown | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 102.7% peak; 3/? phases; mute 1, shed 3, late 1; [S16] |
| `early-paired-bounded-supersaw-stack` | Played count unresolved; Original allocator count/parameters retained; Harmony type0/ext0 (NONE), Arp enabled/bypassed in measured phases. Not a paraphonic rewrite. | drive, chorus, delay, reverb | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Prepared only; no new hardware CPU measurement |
| `revised-evidence-supersaw-stack` | Played count unresolved; No paraphonic rewrite. Recipes change Harmony/Arp and held notes, not patch topology. type1/ext3 is C9: [0,4,7,10,14], not Cmaj9. | drive, chorus, delay, reverb | **Exclude** — Keep available in the editor; not a hardware-derived FM-1 default under the agreed bank policy. | Older only; 88.9% peak; 4/4 phases; mute 0, shed 0, late 0; [S35] |

## Source index

Exact per-phase results, encoding versions, hashes and record identifiers are retained in the companion JSON and expandable HTML rows.

- [S1] `build/configuration-catalogue/articulation-evidence.json` — SHA-256 `2cb78d33f052b102fb0ff9513f342d8389c54b632e58816f54cf4f46bacf3d8e`
- [S2] `build/configuration-catalogue/early-configurations.json` — SHA-256 `43522d4093916c79aff6162d5332c37a0b3b30d8a68ddbed8d6ac3636df539d9`
- [S3] `release-evidence-private/prototype-bank/fx-bus/algo-higher-polyphony-hardware.json` — SHA-256 `2a45c09960b5dc07b10e77f7a23d3cc2f183419894597125244b6faa578fe998`
- [S4] `release-evidence-private/prototype-bank/fx-bus/canvas-cache-native55-hardware.json` — SHA-256 `4a1342839637f401ecb2cffc285c81ac823fecc9a72148a78b27c75014b453e5`
- [S5] `release-evidence-private/prototype-bank/fx-bus/canvas-compact-no-harm-common-native55-hardware.json` — SHA-256 `8dfb6b93bc2a6fdf0ccbeebfe403a7cc00e4c915e8b4de0e30195501688f3f4b`
- [S6] `release-evidence-private/prototype-bank/fx-bus/canvas-final-native55-hardware.json` — SHA-256 `257a3ba65d139f9213b403b7da0dc30a3de13d573bb9b9eb296351ee67cd1717`
- [S7] `release-evidence-private/prototype-bank/fx-bus/canvas-quality-hardware.json` — SHA-256 `b80dad2e53f2292043f0d1c78f44a22ccaec4e84da8d0eec4752fb296f4e73c1`
- [S8] `release-evidence-private/prototype-bank/fx-bus/canvas-quality-minimal-hardware.json` — SHA-256 `fd276e97c7b011033a50efda749b5b60bf6e2d19734c9eb6f7c8de0bc703c9fe`
- [S9] `release-evidence-private/prototype-bank/fx-bus/clone-fallback-choices-hardware.json` — SHA-256 `3e57c6083b1aa6033f7fa8e6c040b9cca8e1c8966c9aa170caa55d74b8cc587d`
- [S10] `release-evidence-private/prototype-bank/fx-bus/clone-full-fx-voice-hardware.json` — SHA-256 `53625c7a473176378cb547bd2b1ef8b7826148ec87d274903972d55fef518360`
- [S11] `release-evidence-private/prototype-bank/fx-bus/clone-no-added-fx-hardware.json` — SHA-256 `e6833c1f452ec64e902ae394834a3885c1af4d4e85d075b9ec3fba20abb0649c`
- [S12] `release-evidence-private/prototype-bank/fx-bus/clone-original-single-omissions-hardware.json` — SHA-256 `427846aa8c186e4322d64a0b1fe26cee8eaa1f74eac7ac348076a3aa88fafa65`
- [S13] `release-evidence-private/prototype-bank/fx-bus/hera-owner-fallbacks-hardware.json` — SHA-256 `3608c785b93833eda1ab8cba79be4eb7e963f49d2a46ae9f869e8210972eb0ad`
- [S14] `release-evidence-private/prototype-bank/fx-bus/historical-retest-common-native55-hardware.json` — SHA-256 `77aeac1b3acc8ad4aecbedbb89a407b5533173d82a213c448db6c6fa02906333`
- [S15] `release-evidence-private/prototype-bank/fx-bus/melodic-hardware-bounded.json` — SHA-256 `c0632da6dcdb8632ee06b33ec0f0b6e803a993991b4d2ccd835a445a49145c4b`
- [S16] `release-evidence-private/prototype-bank/fx-bus/melodic-hardware.json` — SHA-256 `5115421556d957c013a190661329692b129a816927b738c6748aa8a90c1aa71f`
- [S17] `release-evidence-private/prototype-bank/fx-bus/mono-no-harm-common-native55-hardware.json` — SHA-256 `cfa4d5344393e6ef65adc4c1197f7f198ea3d9be5095c1877601f01503fa1fd8`
- [S18] `release-evidence-private/prototype-bank/fx-bus/owner-canvas-hardware.json` — SHA-256 `e189df28a74c79e2fa7bf8f2fa22a9431b0debab76221ebf61b37988760466a9`
- [S19] `release-evidence-private/prototype-bank/fx-bus/owner-final-shared-filter-hardware.json` — SHA-256 `2bf902027de2a4d1138a1a3ceceba82ca9b05f1b43db8d5de3b284b01169c94b`
- [S20] `release-evidence-private/prototype-bank/fx-bus/owner-five-common-native55-hardware.json` — SHA-256 `7164b497a5ab90901fe5521693489254cd4b71e4b5ed31d2f729bed70104a5df`
- [S21] `release-evidence-private/prototype-bank/fx-bus/owner-io-poly-three-hardware.json` — SHA-256 `1e7f1307fe3abcde2df54aa38a9b77e7dcbe74b019c7ca4a42d1cbe09dd0090d`
- [S22] `release-evidence-private/prototype-bank/fx-bus/owner-io-shared-amp-three-hardware.json` — SHA-256 `494bd9aebf9982cb6e016b2951d15b6fc7c9b9fe14989d5dc4bf624d5c046b32`
- [S23] `release-evidence-private/prototype-bank/fx-bus/owner-prepara-remaining-hardware.json` — SHA-256 `5f0f3b25305ec1f102158882e1734c31615fdd29a53836373f6970a9997b58dd`
- [S24] `release-evidence-private/prototype-bank/fx-bus/para-contours-full-hardware.json` — SHA-256 `86879a289c8fcdaa3c0909796d459708590c23aa73d95f17537ff727b7c1d7d3`
- [S25] `release-evidence-private/prototype-bank/fx-bus/para-contours-none-hardware.json` — SHA-256 `331eeec9b75c41643fe17b9703c44b57040e35393622818416d81acf8153d70b`
- [S26] `release-evidence-private/prototype-bank/fx-bus/para-filter-full-hardware.json` — SHA-256 `e640ff1712e607e0e5812030fd1bcdd3a361bd21f49b84f0ef86df85d4d89c7a`
- [S27] `release-evidence-private/prototype-bank/fx-bus/para-filter-none-hardware.json` — SHA-256 `7171435c57031c686fa3a1e8fc262bb20ba41ba9c6e55708aea0893ee4dbdf77`
- [S28] `release-evidence-private/prototype-bank/fx-bus/para-op4-full-hardware.json` — SHA-256 `0a2489b4c0b612aa92f2f854dee88fff0ab4678c551ade9756356105ce271847`
- [S29] `release-evidence-private/prototype-bank/fx-bus/para-op4-none-hardware.json` — SHA-256 `3e77d0d829279850b14195cd3f8d641ba5683e87f1e61974212a75f2f05d7b14`
- [S30] `release-evidence-private/prototype-bank/fx-bus/para-owner-shared-amp-hardware.json` — SHA-256 `6dfde53d41db2cf3a0799b24829eed6e283704801f88725eab845095b837665c`
- [S31] `release-evidence-private/prototype-bank/fx-bus/para-owner-shared-filter-hardware.json` — SHA-256 `3e5a9be86ec1c5ab977128ccc3004834e452572bbbf51401349e62ac05047d42`
- [S32] `release-evidence-private/prototype-bank/fx-bus/para-shared-amp-cdr-hardware.json` — SHA-256 `4caeeb835abd9145b74a1f57d1f5da3740ee299df92b3db1da74a50357487a6d`
- [S33] `release-evidence-private/prototype-bank/fx-bus/para-shared-amp-full-hardware.json` — SHA-256 `43ed528dde637d8bf3ba99c14edbd5f5543de92e65db7eba852c69d4b1ca8432`
- [S34] `release-evidence-private/prototype-bank/fx-bus/para-shared-amp-none-hardware.json` — SHA-256 `d1b1dcf1c5094111bbef6ee4bc20be115c9a1b0712259f6bda49fe3f1a950515`
- [S35] `release-evidence-private/prototype-bank/fx-bus/revised-melodic-hardware.json` — SHA-256 `e730f78a41a2604cdab90ac5820d85550667390838be88482e8ac55f86c124d5`
- [S36] `release-evidence-private/prototype-bank/fx-bus/revised-musical-hardware.json` — SHA-256 `f220c6d265417acce52b449df7a8abee1e13905684acbd77157bcb32b2a02658`
- [S37] `release-evidence-private/prototype-bank/fx-bus/selected-four-common-native55-hardware.json` — SHA-256 `08845374c875bf6801fce610c28b9f48aab4c0a5a70f09784451747d440d5b3a`
- [S38] `release-evidence-private/prototype-bank/fx-bus/selected-nine-common-native55-hardware.json` — SHA-256 `655b28435015e24c51326d0143cc75a2efb1c19610a747bdf521d2973edc0ab3`
- [S39] `release-evidence-private/prototype-bank/fx-bus/selected-rest-cache-native55-hardware.json` — SHA-256 `a4f7708f9a00b3064225551f847091b114df3a6286ac5bea9f9ae1e645b9923d`
- [S40] `wt-bank-prototype-omp/build/fx-clone-variants/algo-higher-polyphony-choices/cases.json` — SHA-256 `6d96c60869ee7ad7b39114e0c8571922ff240ef6e3b7c74787536ca13db18e9c`
- [S41] `wt-bank-prototype-omp/build/fx-clone-variants/canvas-compact-no-harm/cases.json` — SHA-256 `cd44e44351d7803320e15054698affa0ccd6a127cc87f0f8b59a4ebd7ac81040`
- [S42] `wt-bank-prototype-omp/build/fx-clone-variants/clone-fallback-choices/cases.json` — SHA-256 `4ee91f2ffd90847473bf5e7d545949cbb572fd3d5d1184ce64c5d4327976bd2b`
- [S43] `wt-bank-prototype-omp/build/fx-clone-variants/clone-full-fx-voice-alternatives/cases.json` — SHA-256 `854837c15414f0cc2ea4db0ea0be20833e99a23cdcd1e1bd9d6317fdd68df900`
- [S44] `wt-bank-prototype-omp/build/fx-clone-variants/clone-no-added-fx-baselines/cases.json` — SHA-256 `e917d57f07617193098f08afce339629785b2d5d4b551085df50957204ac8b71`
- [S45] `wt-bank-prototype-omp/build/fx-clone-variants/clone-original-single-omissions/cases.json` — SHA-256 `90c4ce00f98b237f3548a086d46bb5b8e6119db5749d2e12651c1b1739b48bb9`
- [S46] `wt-bank-prototype-omp/build/fx-clone-variants/hera-owner-fallbacks/cases.json` — SHA-256 `afa737675cdceb5654a028bb94361593a433dfcaf6762d6c6f368abc10b5ebec`
- [S47] `wt-bank-prototype-omp/build/fx-clone-variants/mono-no-harm/cases.json` — SHA-256 `607aa3a8863e12b07bb9aeeb05d4b6f123922837c12ed92540e42f9c62ef326e`
- [S48] `wt-bank-prototype-omp/build/fx-clone-variants/owner-canvas/cases.json` — SHA-256 `e2cc86a5f8cd96965e6f5ad9f5430a391a7eb32509eecd784c34c284f6bc0774`
- [S49] `wt-bank-prototype-omp/build/fx-clone-variants/owner-final-shared-filter/cases.json` — SHA-256 `dea160058b18db72fe0f74123d87290477ce4173387e750456fbd9dd205f107b`
- [S50] `wt-bank-prototype-omp/build/fx-clone-variants/owner-five-retest/cases.json` — SHA-256 `fd021e761ab4ff50dd3bdb19edfe8e5957c5e4ee2ea72bf0a50253f847d5579a`
- [S51] `wt-bank-prototype-omp/build/fx-clone-variants/owner-io-poly-three/cases.json` — SHA-256 `f9cae5ffad352131edce282102de88d3bc01d7076694e700f982676710e45b59`
- [S52] `wt-bank-prototype-omp/build/fx-clone-variants/owner-io-shared-amp-three/cases.json` — SHA-256 `c079a92be774e474ad89123090614382779c3d7c63f5d6e6343ae7c9adb52554`
- [S53] `wt-bank-prototype-omp/build/fx-clone-variants/owner-prepara-remaining/cases.json` — SHA-256 `afd9fab6a62d486776b4ccb45e26e3aee3d1321c9cf49de6e5a8e4bc7b5eb97b`
- [S54] `wt-bank-prototype-omp/build/fx-clone-variants/para-contours-full/cases.json` — SHA-256 `6a8a3bf4540c58c75e7054af071aa7c817b27f5204b0758248c9c1ecd9f740e5`
- [S55] `wt-bank-prototype-omp/build/fx-clone-variants/para-contours-none/cases.json` — SHA-256 `b5b2926568d7389420c5dacec4ca7ae97629eb2019265d65bc7e76cb33f88e2c`
- [S56] `wt-bank-prototype-omp/build/fx-clone-variants/para-filter-full/cases.json` — SHA-256 `99027d1d64ce674a7aedbb59513aef09407cfd59fddfeb6c77dc22d522bc1087`
- [S57] `wt-bank-prototype-omp/build/fx-clone-variants/para-filter-none/cases.json` — SHA-256 `6fc35593cdc432b94aaff26a9ae36284e468c20c803591b26edc2d172b404b59`
- [S58] `wt-bank-prototype-omp/build/fx-clone-variants/para-op4-full/cases.json` — SHA-256 `2fbaa49ab3bca20fb506231e1c8a600fe1e29f6f72480b393fd7755589fe9085`
- [S59] `wt-bank-prototype-omp/build/fx-clone-variants/para-op4-none/cases.json` — SHA-256 `24d1fbe815cf0f8ec4d210cfeeffdeb67a5db42c4da5d65a158ebe509f7a450f`
- [S60] `wt-bank-prototype-omp/build/fx-clone-variants/para-owner-shared-amp/cases.json` — SHA-256 `01ff70f31703bcebd298ac698801eda30437e645902b24aae1ca0a1ac0f716c3`
- [S61] `wt-bank-prototype-omp/build/fx-clone-variants/para-owner-shared-filter/cases.json` — SHA-256 `feb7ffa60c4f47038013040a0a181fe3d214a3a9f7c4ba2aced95a6a9c63dff8`
- [S62] `wt-bank-prototype-omp/build/fx-clone-variants/para-shared-amp-cdr/cases.json` — SHA-256 `a61b29937d689d73f45bf686b7e94589f8f815f5efd9916932aac963cd9b565c`
- [S63] `wt-bank-prototype-omp/build/fx-clone-variants/para-shared-amp-full/cases.json` — SHA-256 `30bd92cad1484f0b09c35483b0a69b429e61415b36a99d3653ec51b7d9657bd6`
- [S64] `wt-bank-prototype-omp/build/fx-clone-variants/para-shared-amp-none/cases.json` — SHA-256 `c31ac40be76afd526c2350a443e5d4a2d70e0113c9bdd98a865bc8e6a6da938f`
- [S65] `wt-bank-prototype-omp/build/selected-bank-qualification/cases.json` — SHA-256 `ba4e89f7fcaf4b77fc4991caf368ee07481dc247d219fc5058450aa31e9acc70`
- [S66] `wt-bank-prototype-omp/docs/measurements/2026-11-12-fm1-retest-priorities.json` — SHA-256 `832ab3c9112200a09a8d4c3569fe714910683ba65218470d0975a9284845e5c1`
- [S67] `wt-bank-prototype-omp/docs/measurements/2026-11-12-mono-no-harm-retest.json` — SHA-256 `95cd778619e47cc892018a5f64f795377b91ab2450bcbd53cf4f613515e7d732`
- [S68] `wt-bank-prototype-omp/docs/measurements/2026-11-12-original-synth-polyphony.json` — SHA-256 `09113d251c8f5a391f94837c981a86a68b8979071f0b807569d85991e39257b1`
- [S69] `wt-bank-prototype-omp/docs/measurements/2026-11-12-owner-five-retest.json` — SHA-256 `c83a1fba614fc304d0d338fc46a4b13c0625fd9472768effdcae2cd9b05a4c6a`
