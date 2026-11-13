# Original-synth polyphony references for FM-1 recommendation policy

Original hardware played-note counts, not FM-1 allocator counts. Full rack means Drive + Chorus + Delay + Reverb including native effects. Above-parity configurations with incomplete racks are Exclude; at parity, prioritize completing FX before adding voices. No firmware or bank is changed.

## Original hardware played-pitch baselines: mono/duo instruments

Research date: 2026-11-12. Scope: Expander S, Wanderer, Vernon 100, Canvas. No repository files changed; no builds, lint, tests, formatters or bank operations run.

### Results

| Exact FM-1 name | Intended original model | Recommended baselineNotes | Articulation / evidence status |
|---|---|---:|---|
| Expander S | Oberheim Four Voice: four SEM voice cards plus polyphonic keyboard | **4** | Four independently articulated synth voices. Repo's SEM/Four Voice shorthand resolves to the Four Voice at the instrument level, not one standalone SEM. High confidence. |
| Wanderer | ARP Odyssey, original architecture; repo specifies Rev 3 | **2** | Two simultaneous keyboard pitches, low/high priority; shared filter/amplifier/envelope system (duophonic/paraphonic, not two complete voices). High confidence. |
| Vernon 100 | EML ElectroComp 100, **not silently substituted with the 101** | **2, qualified** | Dual KB1/KB2 pitch architecture into a shared filter/amplitude shaper. [INFERENCE] Two played pitches is supported by original Model 100 panel evidence and related EML 101 manufacturer documentation. No Model 100 owner's manual or explicit manufacturer two-key prose was located; exact multi-key priority/retrigger remains unresolved. |
| Canvas | Buchla Music Easel, 208/218 architecture; repo follows 2013 208e/218e operating directive | **1** | One keyboard MAIN pitch CV shared by both oscillators. Two oscillators/two lopass gates and separately patched sequencing do not make two independently key-playable notes. High confidence for the intended keyboard baseline. |

Here “played notes” means simultaneously selectable keyboard pitches, not number of oscillators, audible partials, filter resonances, delay repeats, or independently tuned drones. True-polyphonic voices and paraphonic pitches must remain different articulation descriptions even when baselineNotes is numeric.

### Repo target evidence (not allocator counts)

Base: `/Users/mg/projects/music/fm1/wt-bank-prototype-omp`.

- `docs/ARCHITECTURE.md:142` explicitly maps Expander S → “Oberheim SEM / Four Voice”, Wanderer → “ARP Odyssey”, Vernon 100 → “EML ElectroComp 100”, Canvas → “Buchla Music Easel”. The existing FM-1 voice-count list on that same line is **not** evidence for original hardware counts.
- `web/scripts/gen-assemblies.ts:1837–1849` names Expander S as a polysynth after the SEM **and its Four Voice**, explicitly references the Four Voice's per-card pan pots, keyboard portamento/octave/tune and assignment modes. `docs/ledger/fidelity.md:24–25` (D-744/D-745) records restoration of SEM **and Four Voice** controls; `assign` maps to original Four Voice CONT / REASSIGN / R/C. This instrument-level keyboard/voice-card evidence is what resolves the target, rather than merely seeing an FM-1 allocator configured to four.
- `web/scripts/xl/expander-s.ts:2–7` separately identifies **Expander S XL** as an Oberheim **Eight Voice**. That is not the exact FM-1 name assigned here and is not grounds to give Expander S an eight-note baseline.
- `web/scripts/gen-assemblies.ts:2405–2409` identifies Wanderer as the original Odyssey architecture (Rev 3, 24 dB filter) and distinguishes the reissue-only DRIVE / VCF TYPE switches from the original.
- `web/scripts/gen-assemblies.ts:3098–3124` expressly says Vernon 100 follows the **100's panel**, that no 100 manual was found, and that shared-control behavior comes from the **101** manuals. The repo's lowest/highest-key and legato behavior is an implementation claim, not manufacturer confirmation of a 100's exact keyboard logic. `docs/PRESET-BANKS.md:62–64` calls for dual-voice interaction and links the archived EML documentation, but that archive is primarily 101 material.
- `web/scripts/gen-assemblies.ts:2079–2086` identifies Canvas's 208/218 target and specifically names Buchla's 2013 second edition of Allen Strange's operating directive. It describes both oscillators receiving the keyboard through their keyboard switches.

### Expander S: why 4 is the conservative, evidence-based baseline

Primary source: Oberheim, **Instruction Manual for the 4-Voice Synthesizer with Programmer**, introduction, **printed p. 1 / PDF p. 2**:

<https://www.outofphase.fr/wp-content/uploads/2022/12/instruction_manual_fvs.pdf#page=2>

The page was viewed as a scan because the PDF has no useful text extraction. It states:

> “permitting up to four notes on the keyboard to be sounded simultaneously. Each of the four notes triggers a separate Synthesizer Expander Module (SEM), which is a complete set of tone generators and modulators required for a synthesizer ‘voice’.”

This establishes both numbers without counting oscillators: a standalone SEM is one voice, while the Four Voice keyboard plays up to four notes, one per SEM. Repo targeting goes beyond one SEM: Four Voice panning and keyboard assignment controls are explicit. Therefore use **4**, with the SEM named as the constituent voice architecture. Choosing 1 merely because SEM appears first in `SEM / Four Voice` would disregard the documented instrument target. Conversely, choosing 8 would confuse the separately named XL with the FM-1 instrument.

**Conservative catalogue recommendation:** Expander S at four played notes is original-polyphony parity, not an over-polyphonic one-SEM configuration. Its incomplete FX rack alone does not satisfy the owner's combined “incomplete rack AND more notes than original” Exclude condition. More than four played notes requires the full Drive + Chorus + Delay + Reverb rack. Once four notes are reached, prioritize rack completeness rather than additional notes. This does not assert full control/timbral fidelity: the repo explicitly lists keyboard split and SEM ADS envelope differences.

### Wanderer: two pitches, shared articulation

#### Original manufacturer manual

ARP Instruments, **Odyssey Owner's Manual**, Second Edition, March 1976, **printed p. 29**, “Keyboard and Pedals”:

- Index and edition attribution: <http://www.arpodyssey.com/oddyman.html>
- Page wrapper: <http://www.arpodyssey.com/manuals/oddyman29.html>
- Exact original page scan inspected: <http://www.arpodyssey.com/manuals/OddyMan29.jpg>

It says the keyboard produces **two control voltages**. With zero or one key depressed they are the same; with two or more notes depressed, the first corresponds to the **lowest** depressed key and the second to the **highest**. The first controls VCO 1 (unless disconnected in LF mode); the second controls VCO 2. With sync engaged the second voltage changes harmonic content rather than independently controlling the resulting fundamental.

#### Manufacturer corroboration of shared filter/amp

Korg, **ARP ODYSSEY / ARP ODYSSEY Module Owner's Manual**, **printed/PDF p. 4**, “Main Features”; also **p. 8**, SYNC:

<https://cdn.korg.com/us/support/download/files/2da5c4341ec598574d4af552ecb88b6e.pdf#page=4>

> “duophonic mode that sounds the oscillators at independent pitches when you play two keys simultaneously. (However, there is only one filter and one amp.)”

The p. 5 block diagram corroborates the shared signal path. P. 8 says duophonic performance is possible with sync off, and VCO 2 is synchronized to VCO 1 with sync on. Use **baselineNotes 2** for the original's maximum played-pitch ability, even though particular sync or LF patches behave monophonically. Do not label it two independent filter/VCA/envelope voice cards. A two-pitch faithful configuration is parity; more than two played pitches is beyond parity.

### Vernon 100: strong dual-pitch evidence, explicit limits

#### Original Model 100 hardware panel (primary physical artifact)

The photographed panel visibly says **MODEL EML 100** and provides:

- Keyboard output jacks **GATE, KB1, KB2**.
- Oscillator 2 CONTROL MODE: **KB1**, **KB1/MIX**, **MIX**.
- Oscillator 3 CONTROL MODE: **KB2**, **KB2/MIX**, **MIX**.
- One FILTER and one AMPLITUDE SHAPER; two envelopes selectable as modulation/articulation sources.

Exact panel photos inspected (unpaginated):

- Keyboard + oscillator selectors: <https://lh3.googleusercontent.com/blogger_img/APIUysh7mIUl7SKJRpBejVp_gtd6PbM0Ccf-eU6MfiDRo2SaGMJPIU9MXoWAHSPI8pjGwkdYBksi7tLGAaJP_YA=s1600>
- Model marking + filter/shaper: <https://lh3.googleusercontent.com/blogger_img/APIUysh1nskuQPbtL4dqOdwdA9USvwHBZ9s8fHBRsR3wv7fZe9fbOiQFwasg49LEdK-8gVeyXDpr67XY9GG_rm0=s1600>
- Provenance/links to the original auction photos: <https://www.matrixsynth.com/2010/02/electrocomp-eml-100.html>

The photos are primary evidence of the manufacturer's printed panel, although their host's auction description is not manufacturer documentation. This is stronger than simply importing a 101 specification or trusting FM-1's two allocators. It establishes distinct keyboard-pitch routes, not four independently played notes because four oscillators exist.

#### Related manufacturer documentation, correctly labeled as 101

EML **101 Service Manual**, **PDF pp. 1–2** (“Panel Jacks EML 101”), **pp. 5–6** (“100 and 101 Keyboard Cleaning Procedure”), **p. 15**, section IV(B) “KB-2 Tuning”:

<https://synthfool.com/docs/EML/100_series/eml101_service.pdf>

- PDF p. 2 explicitly distinguishes the “logicized KB1 control voltage” and “logicized KB2 control voltage” for the filter-control mixer.
- PDF pp. 5–6 name both **100 and 101** in one keyboard cleaning procedure; p. 6 specifically mentions unstable **KB2 voltage** caused by poor keyboard-plug contact.
- PDF p. 15 describes oscillator 2 versus oscillator 3 and switching oscillator 3 to follow **KB-2**; it says KB-2 tracks KB-1 after calibration. It does **not** provide the needed 100-specific multiple-key selection prose.

EML **101 User Manual**, **printed p. 8 / PDF p. 10**, explains its four audio oscillators; **PDF p. 68**, unnumbered “New EML 101 Features”, explains that the optional sequencer controls KB2 oscillators 3/4 while 1/2 remain under keyboard control:

<https://synthfool.com/docs/EML/100_series/eml101_user_manual.pdf>

These are not a Model 100 owner's manual. The repo already records this distinction and limitation.

**Recommendation:** **2 is the supported working baseline [INFERENCE]**, from the original 100's two explicit keyboard pitch routes, their separate oscillator assignments, common 100/101 keyboard service material, and the repo's intended dual-pitch model. Preserve the shared filter/amplitude articulation rather than converting it into two complete synth cards. **Unresolved:** no direct Model 100 manufacturer prose explicitly specifying two simultaneously depressed keys was found; neither the exact lowest/highest priority for three-plus held keys nor the original 100's overlap retrigger behavior is proved by the cited documents. Do not describe those details as established hardware facts. This qualification belongs with the numeric baseline; it is not a claim that four oscillators provide four-note polyphony.

### Canvas: one played keyboard pitch, not one oscillator

Primary source: Allen Strange / Buchla, **Programming and Metaprogramming in the Electro-Organism: An Operating Directive for the Music Easel**, 2013 second edition, originally printed 1974:

<https://buchla.com/guides/Buchla_Music_Easel_Manual.pdf>

- **Printed p. 18 / PDF p. 23**: the Model 218 KEYBOARD has one **MAIN output (key voltages)** connected to the 208's pitch input. Both oscillators receive these key voltages via their KEYBOARD switches. The pitch from a particular key is “memorized” and held until another key is touched.
- **Printed p. 20 / PDF p. 25**: “With both oscillators being simultaneously driven by the same voltage they will track at a ratio determined by the settings of the PITCH, FREQUENCY and ‘fine tune’ controls.”
- **Printed p. 1 / PDF p. 6**, Don Buchla's 2013 foreword, describes the recreation as mostly identical to the original 1973 version with minor alterations. This is the precise edition named by the repo.

Manufacturer clarification against a modern-keyboard trap: Buchla **218e-V3 User's Guide**, v5.1, **PDF p. 10**, says that even in polyphonic mode **CV and internal bus output remain monophonic**, while MIDI output can be polyphonic:

<https://buchla.com/guides/218e-V3_User%27s_Guide_v5.1.pdf#page=10>

This later keyboard is corroboration only, not the repo's historical target. Its polyphonic external MIDI does not turn one Music Easel 208 into a polyphonic sound source.

Use **baselineNotes 1** for independently key-played pitches. The modulation oscillator can itself be audible, and patching can combine sequenced/manual/drone activity with the complex oscillator. Those are real capabilities, but not evidence that two keyboard keys independently allocate to the two oscillators. Do not count two lopass gates as two keyboard voices.

### Catalogue application

Under the owner's rule, an incomplete Drive + Chorus + Delay + Reverb rack plus played notes **above** the relevant baseline recommends **Exclude**. At original count, FX completeness outranks more notes; beyond-parity played notes require the full rack. Apply numeric count together with articulation: Wanderer/Vernon two-pitch paraphony is not permission to replace the shared original signal path with two fully independent voices. No particular candidate's FX completeness was audited in this research.

## Original hardware played-note baselines — remaining instruments

Research date: 2026-11-12. These counts are **simultaneously played musical notes**, not oscillators, operators, stored patches, or the FM-1 allocator setting. No repository files were changed and no checks were run.

### Intended models established from the repository

Repository: `/Users/mg/projects/music/fm1/wt-bank-prototype-omp`.

- `docs/ARCHITECTURE.md:142` maps Monolith D → Minimoog Model D; Hera 4 → Juno-106; Sallen 20 → MS-20; Silver Box → TB-303; Briefcase 3 → EMS VCS3; Io 4 → Roland Jupiter-4; Cassia 1 → Casio CZ-1, explicitly with two PD lines. Its FM-1 capacity figures are **not** used as hardware evidence.
- `docs/ledger/fidelity.md`, D-742, identifies Oracle V more precisely as the Sequential Prophet-5 Rev 4. D-740 identifies Algo Four as the Yamaha DX100 rather than an arbitrary DX/TX family model. D-746 and D-747 identify Cassia 1's restored CZ-1 controls and two-line behavior.
- `docs/PRESET-BANKS.md:37` confirms the MS-20 manual as Sallen 20's control reference; it is not a source of hardware polyphony.

### Baselines

| Exact FM-1 instrument | Intended hardware | baselineNotes | Articulation and evidence |
|---|---|---:|---|
| Oracle V | Sequential Prophet-5, specifically Rev 4 in the fidelity ledger | **5** | Five-note polyphony; unison intentionally reduces the played-note count. Sequential's **Origin story** explicitly describes the original Prophet-5's “five-note polyphony”; **Prophet-5 Specifications** describes monophonic unison using one to all five voices. [Sequential manufacturer page](https://sequential.com/classics-reissued/prophet-5-10/). Do not substitute the Prophet-10 or optional expansion hardware. |
| Hera 4 | Roland JUNO-106 | **6** | Six independently articulated synth voices. Roland's original owner's manual, **opening cover/introduction, PDF page 1**, calls it a “61 Key, six voice fully programmable polyphonic synthesizer” and specifies six VCFs, VCAs, and envelopes. [Original Roland manual](https://cdn.roland.com/assets/media/pdf/JUNO-106_OM.pdf#page=1). Hera 4's name does not make the original a four-note synth. |
| Algo Four | Yamaha DX100 | **8** | Eight-note polyphony in POLY; one note in MONO. Yamaha's original owner's manual, **printed page 12, PDF page 13**, §13 POLY/MONO: “Voices programmed with the POLY mode will let you play up to 8 notes”; MONO acts as a monophonic keyboard. [Yamaha-authored manual, mirrored PDF](https://synthfool.com/docs/Yamaha/DX_Series/Yamaha%20DX-100%20Owners%20Manual.pdf#page=13). [Searchable manual transcription, printed p.12](https://manualsdump.com/en/manuals/yamaha-dx100/243897/14). Four FM operators are not four played notes. |
| Cassia 1 | Casio CZ-1, normal single-tone **two-line** architecture | **8** | Eight played notes for LINE SELECT **1+2′** or **1+1′**; **16** for the single-line settings **1** or **2**. Casio's original owner's manual, **printed pp.32–33, PDF pp.33–34**, §1-13 DETUNE/LINE SELECT, explicitly assigns those counts. [Casio-authored manual, mirrored PDF](https://archive.org/download/synthmanual-casio-cz-1-owners-manual/casiocz-1ownersmanual_text.pdf#page=33). [Searchable original-manual OCR](https://archive.org/download/synthmanual-casio-cz-1-owners-manual/casiocz-1ownersmanual_djvu.txt). See mode explanation below. |
| Io 4 | Roland JUPITER-4 | **4** | Four-note normal polyphony. Roland's current manufacturer description of its recreation explicitly says **“Double the polyphony of the original hardware (selectable from two to eight notes)”**. The recreated maximum is eight; therefore the original hardware maximum is four. This count is derived from an explicit manufacturer comparison, **not** copied from the software's eight-voice specification. [Roland manufacturer page, Standard Features](https://www.roland.com/global/products/rc_jupiter-4/). |
| Monolith D | Moog Minimoog Model D | **1** | Monophonic. Moog's user manual, **printed/PDF page 15**, Features & Controls, explicitly says “self-contained monophonic analog synthesizer.” **Page 10**, New Features, says no changes were made to the original sound engine. [Moog-authored manual on its parent manufacturer's CDN](https://cdn.inmusicbrands.com/Moog/Model%20D/Minimoog_Model_D_Manual.pdf#page=15). Three oscillators do not provide three independently played notes. |
| Sallen 20 | Korg MS-20 | **1** | Monophonic. Korg's historical introduction expressly calls the **original 1978 instrument** “Korg's MS-20 monophonic synthesizer,” before discussing the mini recreation. [Korg manufacturer page, “The classic MS-20 – recreated in mini size!”](https://www.korg.com/us/products/synthesizers/ms_20mini/). Two VCOs are not two played-note voices. |
| Silver Box | Roland TB-303 Bass Line | **1** | Monophonic bass line. Roland's **303 Day**, **THE SOUND** section, explains that the TB-303 “was a monosynth: meaning that it only made one sound at a time,” contrasting it with simultaneously played piano notes. [Roland manufacturer history](https://www.roland.com/uk/promos/303day/). This is a hardware-history statement, not a modern clone's specification. |
| Briefcase 3 | EMS VCS3 / Synthi VCS3 with ordinary EMS keyboard control | **1** | Monophonic keyboard articulation. EMS's original **Synthi VCS3 User's Manual**, **viewer page 16**, KEYBOARD section, explicitly says “It is monophonic” and directs users wanting chords to connect an organ or other external source. [EMS-authored manual, mirrored page 16](https://www.manualslib.com/manual/4172126/Ems-Synthi-Vcs3.html?page=16#manual). Three oscillators and matrix routing do not imply three independently keyed notes. |

### CZ-1: why eight, not an unconditional sixteen

Casio documents the distinction directly:

- **LINE SELECT 1**: 16-note polyphony.
- **LINE SELECT 2**: 16-note polyphony.
- **LINE SELECT 1+2′**: 8-note polyphony, combining line 1 with detuned line 2 for complex timbres.
- **LINE SELECT 1+1′**: 8-note polyphony, combining a line with its detuned counterpart for ensemble effects.
- **SOLO**: monophonic. **TONE MIX**, which layers two whole tones and is not merely a two-line single tone: four-note polyphony according to printed p.10 and the TONE MIX overview on printed p.40.

These statements appear at printed pp.32–33; printed p.10 summarizes “16-note maximum,” “8-note polyphonic when 2DCO is being used,” “4-note polyphonic when TONE MIX is being used,” and mono when SOLO is on. The 16-note headline is therefore **not** the correct parity threshold for a two-line Cassia patch. Use **8** as Cassia 1's two-line architecture baseline. If evaluating an explicitly single-line Cassia configuration against the corresponding original single-line mode, use **16**, and retain that mode annotation rather than applying eight universally. A quiet/muted second line alone is not evidence that a patch switched to a hardware-equivalent single-line allocation mode.

### Boundaries, confidence, and catalogue application

All nine counts are resolved for the model/mode above. The remaining contextual ambiguities are explicit:

1. **Cassia**: no one unconditional CZ-1 count is valid for every line/mix/solo mode. The supplied baseline is deliberately two-line, as requested and as documented by the repository's intended architecture.
2. **Briefcase**: the VCS3 is a patchable studio without an integral piano keyboard. The one-note baseline describes its documented normal EMS keyboard articulation, not a claim that arbitrary external controllers, external sound sources, or oscillator drones cannot make multiple pitches. The repository mapping does not specify an alternate keyboard/controller configuration; no unverified alternate-controller count is invented here.
3. **Oracle**: the repository specifies Rev 4; stock Prophet-5 is five notes. Expanded instruments and Prophet-10 are separate configurations, not a reason to raise this baseline.
4. **Io source limitation**: the observed primary source is Roland's explicit original-versus-recreation comparison, not an original Jupiter-4 manual. Its arithmetic is unambiguous (eight is double four). Other entries with mirrored manuals remain manufacturer-authored primary documents; the mirror is not the author of the technical claim.

Under the owner's policy: once these hardware note thresholds are reached, completing **Drive + Chorus + Delay + Reverb** outranks extra voices. A configuration exceeding the applicable baseline while lacking any of that rack should be recommended **Exclude**. These findings establish the thresholds only; this task did not inspect or classify any bank configuration.

