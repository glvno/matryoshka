# **WE STAND ON THE SHOULDERS OF GIANTS!!**

**Matryoshka is a fork of a fork of bootleg firmware. Big ups to [Leo Kuroshita (@kurogedelic)](https://github.com/kurogedelic) / [Hügelton Instruments](https://github.com/hugelton), creators of [Felucca](https://github.com/hugelton/Felucca), and [@morgulbrut](https://github.com/morgulbrut) / [WiggisModular](https://github.com/WiggisModular), creators of [Modular-1](https://github.com/WiggisModular/Modular-1).**

<p align="center">
  <img src="web/public/brand/matryoshka.png" width="240" height="240" alt="Coral and yellow parent dolls with two teal siblings, connected by matching cable arms" />
</p>
<p align="center">
  <img src="web/public/brand/wordmark.svg" width="480" alt="Matryoshka" />
</p>

# Matryoshka

A recursively modular and **FM1**-friendly synth engine framework, with a browser patch editor and reusable, nested assemblies.

**Modules** are the building blocks -- a single oscillator, a VCA, a filter, a delay, whatever.

**Assemblies** are groups of modules. The provided "operator" assembly, for example, is a single oscillator, an eight-step envelope, and a VCA. Like patches, they can be saved and reused. Did you build a really perverted granular synth that sounds like the voice of the metatron? Select its modules, save it as an assembly, and now that's an instrument you can use in your patches whenever you want.

Assembly inputs, outputs, and sliders are just whatever inputs, outputs, and sliders from its contained modules you want to promote to being part of the assembly's user interface.

A handful of factory patches are provided. Use them to learn, then replace them with something you made.


## Webapp

[Open the Matryoshka editor](https://matryoshka.lol/) to make patches and upload them to the FM-1. The site on Cloudflare Pages serves the newest release (pushing its tag deploys it; see [D-112](docs/ledger/releases.md#D-112)) and carries the newest firmware package for the FM-1 (see [Install on the FM-1](#install-on-the-fm-1)). What changed in each release is on the [changelog page](https://matryoshka.lol/changelog), made from [CHANGELOG.md](CHANGELOG.md); each release has its own link, such as `changelog#v1.2.0`. The [original Modular-1 editor](https://wiggismodular.github.io/Modular-1/) is also available.

**The editor's address** is matryoshka.lol. From 1.0 to 1.4 it was matry0shka.pages.dev, which still serves the same editor, so its links keep working; the browser keeps the data you made there (Your patches, the FM-1 bank, the library, the tutorial progress, settings) at that address. Open it once: a bar at the top offers **Move them there**, which opens matryoshka.lol and copies your data over without replacing anything already there. A visitor with no data there is sent on to matryoshka.lol. **Save browser backup** in the command palette saves the same data as a file, which **Load .json** reads. Before 1.0 the editor was at glvno.github.io/matryoshka. That address forwards to matryoshka.lol, so bookmarks and share links made before (`https://glvno.github.io/matryoshka/#p=…`) keep working. The browser keeps the editor's data (Your patches, the FM-1 bank, the library, the tutorial progress, settings) separately for each address. If you used the old address, open it once: it offers **Bring my patches**, which opens the new address and copies your data over without replacing anything already there, and a toast lists what came over. **Download a backup** there saves the same data as a file, which the new editor reads with **Load .json** (or **Import browser backup** in the command palette).

The site counts visits with Cloudflare Web Analytics, which uses no cookies and stores nothing in your browser. Your patches stay in your browser; a share link's patch is in the part after `#`, which never reaches a server, except a link over 8,000 characters, which is kept on the site as a stored link (see [D-586](docs/ledger/editor.md#D-586)).

Start with **How a patch works** in the sidebar: play a four-module voice, trace the signals, and turn the voice into an assembly. Browser audio is enabled automatically; a fresh browser may wait for your first interaction. Enabling the arpeggiator plays only held keys.

The wordmark uses Roboto Flex capitals, with a teal M and a full-height “1” forming the R’s stem. The logo pairs coral and yellow parent dolls with two teal siblings and matching cable arms. The selected wordmark and editable settings are in the [type lab](https://matryoshka.lol/brand/round-four/index.html?preset=p13). The lab also has independent spacing for all nine letter pairs and left/right T-arm and numeral-foot controls, saved in shared links and SVG exports. Earlier [wordmark and pictorial studies](https://matryoshka.lol/brand/round-two/index.html), [ten candidates](https://matryoshka.lol/brand/candidates/index.html), and [UX proposals](https://matryoshka.lol/review/index.html) remain available.

A switch at the top, **PATCH | EMU | LIBRARY**, moves between the canvas, the **Emulator view** (the FM-1's own firmware, emulated in the browser; with an FM-1 connected it reads "Mirroring your FM-1") and the **Library** (what is stored, in this browser and on the FM-1). The sidebar beside it is the same in every view. It holds the logo (a click goes back to the canvas) with **About** under it (the theme toggle and the collapse button sit in the corner), then the patch name, **New patch** with **Save**, **Share** and **⋯** beside it, the **Open** picker, **+ Module** / **+ Assembly**, the canvas controls and **Get started** (Tutorial, Demo, Install and the Changelog). In LIBRARY its sections, Patches, Assemblies, Presets and Community, are tabs under the switch. EMU and LIBRARY keep **Audio on** / **Panic** and **MIDI** at the bottom. The Library manages what is stored and opens nothing: **Patches** and **Presets** show two columns, **In this browser** and **FM-1**; **→** puts one on the FM-1 and **←** copies one into this browser. Without an FM-1 the FM-1 column is the bank's offline copy (order it, rename, remove, **Add from factory ▾**), sent with **Send bank to FM-1** once one is connected; with one it shows what the FM-1's 64 slots (01..64) really hold, named **Bank** when that is the offline copy, else **Unsaved bank** with **Save as bank…**. A patch too big for the FM-1 stays in this browser, marked **browser only**. **Assemblies** lists your own (rename, export, delete; the FM-1 stores none). Deleting what this browser keeps acts at once with **Undo**; replacing something on the FM-1 asks first. What the last action did (audio running, link copied, load failed) shows in the status line under the keyboard. **Share** beside New patch opens the share sheet (copy a link, post to Reddit, submit to the Community shelf). The **⋯** beside it (**Patch ⋯** in the mobile bar) shares, saves or loads a .json, stores to an FM-1 slot, opens FM-1 & MIDI and deletes a saved patch. **Connect FM-1** at the top right, in every view, connects the FM-1 over USB MIDI; once connected it reads **FM-1 connected** and opens FM-1 & MIDI. If the FM-1 answers with another firmware, it offers **Install Matryoshka**. The **FM-1** chip in the status line shows the connection too and opens FM-1 & MIDI. **Commands** (Ctrl/Cmd+K) opens file operations, undo/redo, grouping, hardware settings, firmware installation, and help. The palette opens on actions; its Modules, Assemblies and Patches filters let you browse without guessing a name. On narrow screens the switch stays at the top and **Workspace** opens the sidebar as a drawer. **Tab** moves through controls.

Slider thumbs are input jacks: **drag normally to adjust, Alt-drag to patch**, or drop an output cable onto a thumb. External cables plug into side jacks, which route to the moving thumbs through internal cables. **Click an internal cable to disconnect that parameter**, leaving the incoming cable and other destinations intact. **Drag the same side input to several thumbs to add multiple destinations** (or Alt-drag from the thumb to the side input). Thumb positions pause while patching so the targets stay still.

Open the **⋯** menu beside a parameter for p1/p2 routing, modulation depth and macro ranges. Any side input can also feed additional parameters; these extra routes add the signal’s block average across the parameter range. Dedicated controls use their own input (for example, Multimode cutoff uses `cv`). Other thumbs reuse a suitable p1/p2 route or allocate an unused input; the editor reports when both are occupied. Depth is shared by every parameter assigned to that input. On the FM-1, K1–K4 turn the rows of the page in focus.

### Voices

A patch is mono unless it has a **Voicing** module: Main's `keys` feed the Voicing (`voices` 1..16, the FM-1 plays 8), and the poly assembly it drives runs once per voice, like on a polysynth. There is no patch-wide voice count. Delay, reverb, chorus, granular, Arpeggiator, Steps and Output always run once and receive the sum of the voices; a module outside the poly assembly (a free-running LFO, a noise) runs once and feeds every voice. Notes take a free voice first, then the oldest sounding one. On the FM-1 each voice costs the CPU time of the poly assembly, so 3 or 4 voices of a typical patch is the realistic range; the FM-1 takes at most 4 poly assemblies per patch, and the budget meter shows when a patch needs more than the firmware has.

The firmware plays one patch at a time. See [D-202](docs/ledger/device-ui.md#D-202).

## FM-1

> **Coming from Felucca?** Matryoshka keeps its patches in flash sectors that Felucca uses for its projects, samples and user presets (0x97000, 0x98000, 0xA0000-0xDFFFF). Its first start writes the 25 factory patches into the 64-slot bank there (that erases almost all of those sectors) and every SAVE writes there again, so the Felucca data in them is lost. Save them with Felucca before you install; the Flash tab asks again when the FM-1 reports a Felucca identity. Patches stored by the official M-VAVE firmware are not touched.

The arpeggiator is a module in the patch, not part of the firmware. See [D-415](docs/ledger/modules.md#D-415).

Knobs and stuff. Every top-level module or assembly with card rows is a device, and so are Main, each Steps track and the Output.

* **PRESET** steps through the patches (it skips empty slots)
* **SELECT** steps through the devices, **ALGO** through the pages of the device
* **KNOB1 - 4** turn the four rows of the page in focus
* **HOME** goes back one step; HOME held opens the settings menu
* **ENV** opens the environment page: one row per device, opening on the current one. SELECT moves the row, K1–K4 turn the row's first page, PRESET or ALGO step the row's presets, SEL opens its device pages; ENV or HOME goes back.
* **GLO** opens the FM-1's own page: K1–K4 set the MIDI channel, clock in, MIDI out and the LEDs
* **SEL** on an assembly device's page opens its preset list; on a Steps track's page it opens the SEQ page on that track
* **SEQ** opens and closes the SEQ page, where the white keys are the track's steps
* **FX, LFO, EDIT, ARP** are patch buttons: the patch decides what each does (a gate, a Toggle that bypasses a module or assembly, or a list of device pages)
* **SAVE held at power-on** boots in safe mode: it plays the fallback patch compiled into the firmware and reads nothing from flash (`SAFE MODE: FALLBACK PATCH`); the stored state stays in flash for the next normal boot, MENU > SYSTEM > FACTORY RESET erases it. A boot that did not get through makes the next one safe by itself; two failed boots in a row go to update mode. See [D-154](docs/ledger/firmware-install.md#D-154) and [D-155](docs/ledger/firmware-install.md#D-155).

## Install on the FM-1

Two ways, the same update protocol (Felucca's, over USB MIDI):

- **The Install panel** of the editor: **Get started** > **Install** (it names the firmware version, "Install v1.2"), **Commands** (Ctrl/Cmd+K) > **Install firmware**, or open the editor with `#flash` at the end of the address. It needs Web MIDI with SysEx (Chrome or Edge). Tick "I understand and accept the risk", then **Install Matryoshka firmware**; **Return to official V15** puts M-VAVE's firmware back. Keep the tab open until it says done.
- **`tools/fm1_install.py`** from a checkout of this repository: `python3 tools/fm1_install.py web/public/firmware/matryoshka.fwsc`, or `FM-1_015.fwsc` from the same folder to return to stock.

**Return to stock first** if the FM-1 runs anything other than the official V15 or Matryoshka (Felucca, Sloop, M-VAVE Open or another build): Return to official V15, check that it boots, then install Matryoshka. The Install panel says so when it sees such an identity (`fm1_install.py --info` prints it); nothing else is refused, but over Felucca (read the note above first) it installs only after you tick its warning.

**Update mode:** hold OCT- and OCT+ while switching the FM-1 on, or choose MENU > SYSTEM > UPDATE MODE. An install works from there too, and it is the way in when the firmware does not start.

**Recovery:** the FM-1 has one firmware slot and no rollback. If an install is cut off, the FM-1 waits in its update loader: run the same install again (Install for Matryoshka, Return to official V15 for a return to stock) and it finishes the write. The bundled official V15 brings the stock firmware back on an FM-1 that still has V15's boot code.

**"update failed -5" on Return to official V15:** the first 16 KB of the FM-1's memory hold a small piece of software that starts the FM-1 when you switch it on (its boot code, flash 0x0000–0x3FFF). Matryoshka never changes it, but M-VAVE's own firmware packages bring their own, and M-VAVE's installer writes it along with the firmware: the official V15 has one, M-VAVE Official Open another. So an FM-1 that was set up by Official Open (for example: Official Open, then Matryoshka) refuses the V15 before it erases anything. Its screen says "update failed -5", and it keeps running Matryoshka.

- **The safe way on today:** keep Matryoshka.
- **Coming with a later Matryoshka firmware** ([issue #183](https://github.com/glvno/matryoshka/issues/183)): putting Official Open back from M-VAVE's own file, and going back to V15 after a plain warning (that also replaces the start-up software, which carries a small risk if the power is cut at that moment). The Install panel does not offer either before the firmware can do it.
- **Official Open will not come with Matryoshka:** it includes M-VAVE's own sound engine, which is not open source. M-VAVE's [licence for it](https://github.com/m-vave/fm1_open/blob/main/THIRD_PARTY.md) lets anyone pass it on inside FM-1 firmware, but Matryoshka ships only open-source files (see [LICENSING.md](LICENSING.md)), so you will download it from [M-VAVE's release page](https://github.com/m-vave/fm1_open/releases) yourself.
- **Last resort today:** put the FM-1 in the chip's own repair mode (from Matryoshka, the SysEx `F0 22 24 35 7D F7`) and write only V15's firmware part (0x4000–0x92FFF) with [MvaveFM1Unbricker](https://github.com/Quixotic7/MvaveFM1Unbricker) (Windows or Linux; on a Mac with [SIDOU's fm1-unbrick-mac](https://github.com/dsablic/sidou/tree/main/tools/fm1-unbrick-mac)). That leaves the start-up part as it is, which V15 starts from too.

**Tested on a real FM-1** (with the Install panel and with `tools/fm1_install.py`):

- installing Matryoshka over the official V15, and over Matryoshka;
- update mode by OCT- + OCT+ at power-on and by MENU > SYSTEM > UPDATE MODE, and an install from there;
- returning to the official V15 from Matryoshka, then installing Matryoshka again; the official firmware boots, plays and saves;
- a write cut off from the computer (at 30 %): the FM-1 waits in its update loader, and running the install again finishes it;
- safe mode (SAVE held at power-on) and the boot guard;
- FACTORY RESET: the bank erased and the factory patches written again.

Partly tested: a power cut as the update loader started, and one halfway through a write of the same build; both booted.

**Not tested:** a power cut while the firmware is half old and half new; installing over Felucca, Sloop or M-VAVE Open.

## Support

If Matryoshka is useful to you: [GitHub Sponsors](https://github.com/sponsors/glvno) or [Ko-fi](https://ko-fi.com/glvno).

## Hack it

- Run it yourself: `cd web && npm install && npm run dev`
- Edit tutorial writing locally: choose **Edit lesson writing** in the dev app sidebar, or open <http://localhost:5173/lesson-editor>. Save writes the lesson source; it does not publish. See [the lesson editor guide](docs/TUTORIAL.md#writing-lessons-locally).
- Build the firmware: CI builds it on every push (`.github/workflows/firmware.yml`, artifact `matryoshka-firmware`). Locally it needs the JieLi toolchain (`tools/get_toolchain.sh`), then `python3 tools/build.py`. `cd web && npm run firmware -- --ci` puts the newest CI build of `main` into the app's Flash tab (`npm run firmware -- path/to/x.fwsc` a package of your own)

## License

GPL-3.0-only. The flasher, loader, hardware layer and tools are copied from [Felucca](https://github.com/hugelton/Felucca) by Leo Kuroshita / Hügelton Instruments (GPL-3.0-only); see [LICENSING.md](LICENSING.md).

## Assemblies

**Ctrl/Cmd+K** searches the command palette directly: `module` lists modules, `assembly` lists factory and saved assemblies alongside assembly actions, and `assembly drums` or `assembly kick` narrows the list. Names, type tags, shelves and the modules / ports inside a prefab are searchable. Arrow keys select a result; Enter inserts it without opening the assembly browser.

A **patch** is a complete sound: it starts from Main and Output ("New patch" in the toolbar's patch select) and is what the bank and the FM-1 hold. An **assembly** is a building block: a group of prewired modules that appears as one card with the ports and parameters it exposes: an "operator" of oscillator, envelope and VCA, a whole subtractive voice, an echo. Select modules in the editor (shift-click, or drag a box on the canvas) and click **Make assembly**: the ports that had cables to the outside become the card's ports (Main and Output never join: they stay outside, and a `.json` with them in loses them). **open** shows the modules inside a frame, where ○ / ● next to a port or a parameter puts it on the card; drag cards into or out of the frame to change what belongs to it. **save** puts the assembly into the library (your shelf of the **Insert assembly** browser and of the Library page), from where it can be inserted into any patch, exported as a `.json` file and imported again. Sixty-six come with the editor, on the shelves Drums, Voices, Effects, Textures and Utilities.

Assemblies are an editor-only overlay: the patch stays a flat list of modules and cables, the FM-1 receives it with only what it needs from the assemblies (each one's poly setting, the device pages and the device extras), and an older editor loads such a patch and only loses the grouping. Knob assignments (K1..K4) are not part of a saved assembly, since the knobs belong to the patch. Ctrl/Cmd+Z undoes structural changes, Shift redoes.

## Sync, glide, shaper, spread

- The Oscillator and the LFO have a `sync` input: a rising edge (the Main gate, a square LFO, anything above 0.5) restarts the phase. Main `gate` into an oscillator's `sync` gives every note the same attack, the way FM synths do; one oscillator's output into another's `sync` is hard sync.
- **Slew limiter** is a one-pole slew for any control: Main `pitch` through a Slew limiter into the oscillator is portamento; `time` is how long a step takes to get within 1 %.
- **Waveshaper** drives a signal into a soft clip (smooth up to the knee), a hard clip or a triangle fold, with the peak kept at 1 and a `level` after it. It is the drive for a bass and the safety for a hot FM carrier. `sym` shifts the signal before the curve, so one half folds or clips more than the other: even harmonics, and a DC part that a high pass after it removes. `stages` runs the curve one to four times with a gain of 2 between: in `fold` mode a denser wavefolder (the folds fold again), in the clip modes cascaded gain stages. `os` runs it 2x oversampled: the harmonics above 22 kHz are filtered out instead of folding back as inharmonic grit (about 2.3x the CPU of the module; off by default).
- The Main panel has a `spread` output: a constant per voice from -1 (first voice) to 1 (last), 0 in mono. Into an oscillator's `p1` with `fine` ticked it detunes the voices into a unison pad; into two VCAs with opposite attenuverters it pans them.


## Level/rate envelope, string, wavetable, chorus

- **Env L/R** is the DX7 envelope: on a gate it runs to `l1`, `l2`, `l3` in `r1`, `r2`, `r3`, holds `l3`, and releases to `l4` in `r4`. Rising segments are linear (the rate that covers 0..1 in `r`), falling ones exponential (99 % in `r`). Put it on a VCA for percussion, and through an Attenuverter on an oscillator's `pitch` for a drum's pitch drop.
- **String** is a plucked string (Karplus-Strong). Main `pitch` and `gate` play it: a `gate` fires a one-period burst of `noise` or a `pulse` into a loop that decays to −60 dB in `decay`; `damp` darkens it. Anything into `exc` plucks or rings it too, so a short oscillator click is a different pick, and a steady signal makes it a tuned resonator. Lowest note 40 Hz; the FM-1 has 8 string lines.
- **Wavetable** is an oscillator with four banks of eight single-cycle frames (`analog`: sine, triangle, saw, square, pulses; `organ`: drawbar sets; `formant`: a moving bump of harmonics; `digital`: steps and corners). `pos` sweeps the frames with crossfades; an LFO into `p1` on `pos` is the classic wavetable sweep. It has `pm` and `sync` like the Oscillator (the FM path is not oversampled), and it is band-limited in three steps so high notes stay clean.
- **Chorus** is a stereo chorus (two taps in quadrature around 12 ms, swept up to ±8 ms) with `l` and `r` outputs for the Output. Like the Delay it runs once for all voices; one per patch on the FM-1.

## Sequencer, clock divider, S&H, quantizer, pulse

- **Sequencer**: eight steps (`s1`..`s8`, −1..1), `len` and `dir` (forward, backward, pendulum, random). A rising edge on `clock` moves on, `reset` goes back to step 1. `out` is the current step all the time, `gate` follows the clock while the step is not a rest; a step turned fully down is a rest. A square LFO is a clock; Main `gate` into `reset` restarts the pattern on every key. `glide` slews `out` from step to step (the time is that fraction of the clock period, so it follows the tempo; 0 = steps), `gate` sets the gate length as a fraction of the period (0 = the clock's own width, 1 = legato: the steps tie and an ADSR does not retrigger). Both measure the period from the last two clock edges.
- **Clock divider**: `out` passes every `div`-th clock pulse, `d2` `d4` `d8` every 2nd, 4th and 8th; `reset` makes the next pulse a downbeat.
- **S&H**: `out` takes `in` on a clock edge (`hold`) or follows it while the clock is up (`track`). Noise into a clocked S&H into a Quantizer is a random melody.
- **Quantizer**: snaps a pitch to the nearest note of a scale on a root (chromatic, major, minor, pentatonics, dorian, mixolydian, blues, whole tone, fifths, octaves). Put it after a Sequencer, an S&H, a Slew limiter or an LFO into `pitch`.
- **Pulse**: a trigger in, a gate of `time` out; a new trigger restarts it. It turns a short clock tick into a gate long enough for an envelope's attack, or a long gate into a short one.
## Pan, crossfade, vowel, phaser, digitizer, noise colour

- **Pan** places a signal with an equal-power law; its `pos` input adds to the `pan` knob, so Main `spread` into it spreads the voices across the stereo field and an LFO autopans.
- **Crossfader** fades between `a` and `b` by `mix` + `pos` (an envelope or an LFO on `pos`).
- **Formant filter** is three band passes at the formants of A E I O U; `vowel` morphs between them (0..4), the input adds to it, `res` is the sharpness.
- **Phaser** sweeps four allpass stages ±2 `depth` octaves around `center` at `rate`, with `fb` and `mix`.
- **Bitcrusher** reduces the bit depth (`bits`) and the sample rate (`rate` = every sample held that many times). `os` as on the Waveshaper: the steps are rounded off at twice the rate before coming back down, so the images of the held samples alias less.
- **Noise** has a `color` parameter: 0 is white, 1 rolls the top off from about 220 Hz.
## Unison

- The **Oscillator** has `unison` (1..5 copies) and `detune` (cents, spread from −detune to +detune): a supersaw or a thick pulse from one module, summed so the peak stays at `level`. Sync restarts all copies. With `pm` connected or `fb` above 0 the oscillator runs its FM path, which plays one copy.

## Frequency shifter

- **Freq shifter** moves every partial by the same number of Hz (not a pitch shift: harmonics become inharmonic): `up` and `down` outputs, `shift` ±1000 Hz with `cv` × `cvamt`, `mix`. A few Hz for a slow barber-pole phasing, hundreds for bells and clangs out of a saw.

## Performance controls

During browser playback, sliders and their readouts follow dedicated CV inputs (including filter cutoff and VCA envelopes), parameter-input modulation, macro ranges and patch morphing, including parameters exposed on assembly cards. A moving value uses the teal accent; hover it to see its saved base value. Dragging or using the keyboard edits that base value, and animation resumes when you release the control. Fast modulation is sampled as often as the display can update. Polyphonic parameters show the newest held note (or its release when no notes are held). These displays follow the browser engine; the FM-1 does not send live parameter telemetry back.

- Pitch bend moves the Main module's `pitch` by ±2 semitones in every patch; the wheel is also a `bend` output (−1..1). The mod wheel (CC 1) is the `mod` output, channel aftertouch the `at` output: patch them into any `p1` / `p2`. CC 16..19 turn the rows of the page in focus from a controller.

## Comb filter and modal resonator

- **Comb filter** is a tuned feedback comb: a delay of one period of the `pitch` (plus `coarse`) with `fb` (positive: a peak at every harmonic; negative: the odd ones, hollow) and `damp`, mixed by `mix`. A flanger with an LFO on `pitch`, a resonator on noise, a Karplus string without the pluck.
- **Resonator** is a resonator of six partials at the `pitch`: harmonic at `struct` 0, a metal bar at 1; `decay` is the ring time, `damp` shortens the upper partials, `bright` their level. Hit it with a short burst (a pulse, a gated noise, a plucked string) for bells, bars and drums; a steady input makes it howl.

## Phase distortion oscillator

- **Phase distortion** is the Casio CZ's oscillator: a sine read with its phase bent. `wave` picks one of the CZ's eight waveforms: saw, square, pulse, double sine and saw-pulse bend the sine; reso 1, 2 and 3 are the resonance waveforms, a sine restarted every cycle under a falling ramp, a triangle or a trapezoid. `dcw` (the parameter plus the `dcw` input) is how far: 0 is a sine, 1 the full shape, and on a resonance waveform it raises the sine by up to `range` octaves. An envelope into `dcw` is the CZ's DCW envelope, the sweep from soft to bright. `wave2` plays a second waveform on every other cycle, as a CZ line does (two different ones sound an octave down). It has `pm` and `sync` like the Oscillator. High notes stay clean: the bend is held back as the note rises.

## Granular

- **Granular** records whatever is patched into it (one second, `freeze` stops the recording) and plays grains from it: `density` grains per second or one per rising edge on `trig`, each reading `size` seconds from `position` back in the buffer (0 = the newest audio) scattered by `spray`, at `pitch` semitones, under a smooth window, up to eight at once, mixed with the input by `mix`. A frozen chord into a cloud, a stutter from a square LFO on `trig`, a pitch-shifted echo. One per patch on the FM-1.

## Math and logic

- **Math** takes two signals (`a` scaled by `ka` plus `off`, `b` scaled by `kb`) and outputs their sum, difference, product, min, max, |a| and a gate that is high while a > b: ring modulation, a CV mixer, a comparator, a rectifier.
- **Logic** combines two gates: `and`, `or`, `xor`, `not` (of `a`), high from `thresh` on. Two clocks into `xor` make a rhythm.

## Compressor

- **Compressor** is an envelope follower and compressor in one: `env` outputs the follower (a control: an oscillator's loudness as a CV, a sidechain pump from a kick into a VCA), `out` the signal compressed above `thresh` by `ratio` with `attack`, `release` and makeup `gain`. The `side` input is the sidechain; without it the detector listens to `in`.

## On a phone or tablet

- One finger on empty canvas pans; cards drag by their header. Pinch and Ctrl/Cmd+wheel still scale the canvas, with Fit and Reset available through Commands. On touch screens the jacks and controls are larger, and a long press on a card header opens its actions. Below 700 px, the sidebar becomes a dismissible Workspace drawer, leaving the full width for the patch. Web MIDI over USB works on Android Chrome in principle; the FM-1 link from a phone has not been tried.

## Share a patch as a link

- **Commands → Share patch link** copies a link that opens this patch: the JSON, layout and assemblies included, deflated into the URL fragment (`#p=…`, about 800 characters for a factory patch). Opening the link loads the patch into the editor without replacing the patch the browser remembers until you change something. A patch too big for a link (over 8,000 characters) is stored on the site as a short `#s=` link and keeps everything; when the site cannot be reached, the link drops only the card positions.

## Community patches

- **Community patches** (patches players shared, each credited to its author under CC BY-SA 4.0) are listed in **Library > Community**, one card per patch with its XL version (the full browser version) beside it. Nothing from there shows anywhere else until you **Add** it: it then appears in Your patches with its author (the Open picker, the palette, Library > Patches), following the bundled entry until you save it as your own. The palette's "Browse community patches" opens the section.
- **Submit to the Community shelf** in the share sheet opens the [issue form](https://github.com/glvno/matryoshka/issues/new?template=community-patch.yml) filled in with the open patch's link.
- The list is `web/src/community.json`, bundled with the app (no server). Accepted submissions are added to it in a commit, one entry each (`title`, `author`, `licence: "CC-BY-SA-4.0"`, `source`: the Reddit post or the issue, `code`: the link's `#p=` value, `added`: YYYY-MM-DD, optional `notes`); `community.test.ts` decodes every entry and fails on a broken code or a missing author or licence.

## Diff

- **Edit → Show changes** lists what changed since the patch was last loaded, uploaded or stored on the FM-1: parameters as old → new, modules and cables added or removed, and switches, attenuverters, parameter routing, macro ranges, voices and arpeggiator changes as one line each.

## Keyboard

- `/` or Ctrl/Cmd+K opens a **command palette**: type part of a name to add a module, insert an assembly (library or factory), load a patch or start a new one; Enter runs the first match, arrows choose. `?` lists every shortcut.
- Note keys keep playing after using a dropdown, checkbox, slider or button. A closed dropdown keeps focus but does not use note keys to select another option. Open dropdowns, text fields and dialogs keep their normal keyboard behavior; arrows and Tab still navigate controls. Z / X change octave.
- Click a jack, then a jack of the other kind, to connect them (Esc cancels; dragging works as before). With cards selected (shift-click or a box): Delete removes them, B bypasses them, Ctrl/Cmd+G groups them into an assembly, Ctrl/Cmd+D duplicates them with their settings and the cables among them, the arrows nudge them (Shift: ×10). Space starts and stops the transport, Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z undo and redo. The shortcuts are off while a text field has focus; the note keys (A W S E D F T G Y H U J K) still play when they are not taken.

## Scope

Add a **Scope** module and cable up to two signals into its `a` and `b` inputs; its screen sits on the card (and on an assembly card that shows it). Hover the screen for its buttons: the time window (− / +), Wave or FFT, and Voices (one trace per voice, when the source runs once per voice). Audio waveforms auto-scale and trigger on a rising crossing; the spectrum is a 2048-point Hann-windowed FFT. The Scope runs only in the browser: it is left out of what goes to the FM-1.

## Arpeggiator in the editor

- The arpeggiator is an **Arpeggiator** module between Main's `keys` and the Voicing. The ARP button in the Main dock offers **+ Add arpeggiator**, which puts one there as one undo step and makes ARP its Toggle. A patch may hold several; the FM-1 takes 2. See [D-574](docs/ledger/editor.md#D-574) and [D-415](docs/ledger/modules.md#D-415).

## Macro ranges

- A parameter input normally *adds* to a parameter: p1 at 1 moves it up by the attenuverter's share of its range. A **macro range** makes the input *set* it between two ends instead: in the parameter’s **⋯** routing menu, enable **Map between two values** under p1 or p2 to show the two ends (as values; for a logarithmic parameter the travel is in octaves). One Main knob into p1 of the filter and of the envelope then opens the cutoff from 200 Hz to 8 kHz while it shortens the decay from 0.5 s to 50 ms, each over its own travel; swapped ends make a knob go down. The slider's own value is ignored while a range is set; the attenuverter scales the travel, the input is clamped to 0..1 (for a bipolar LFO put an Attenuverter with offset 0.5 in front). The ranges travel with the patch (binary format 15) and live edits reach the FM-1 (RANGE command); the LCD draws the travel as a bracket over the knob row's bar.

## Patch morphing

- A patch can carry a **B side**: the parameters of another stored patch with the same modules and cables. Pick it in the Main dock ("B side": Your patches, the bank and the factory list are offered, only those of the same structure), then the Main module's `morph` slider fades every parameter from this patch (A, at 0) to the other (B, at 1): linearly, in octaves for a logarithmic one (a cutoff morphs musically), a choice or a switch flips at the midpoint. Notes keep sounding while you morph: only the parameters move. The Main module has a `morph` input as well; it adds to the slider, so an LFO, an envelope or a sequencer can morph the patch (block rate, one block late). On the FM-1 CC 22 sets the morph; the B side travels with the patch (binary format 14) and is saved with it. To get a B side: save the patch under a second name, change its sounds, come back to the first and pick the copy.

## Reverb


- The **Reverb** is an eight-line feedback network (dense from the first reflections on, no metallic ring thanks to a slow modulation of two of its lines). `size` is the decay: 0.2 s at 0 to 6.4 s at 1 (60 dB), `damp` rolls off the highs in the tail, `pre` holds the tail back by up to 40 ms so the attack stays clear, `mod` is the chorusing of the tail (0 for a static, perfectly repeatable tail), `mix` the wet share. One per patch, like the Delay. Old patches keep their size / damp / mix and get the new tail.

## Multimode filter: notch, peak, allpass

- The **Multimode** filter has three more outputs after `mix`: `notch` (a null at the cutoff, the rest passes: the opposite of `bp`), `peak` (flat, with a resonant bump at the cutoff set by `res`: a parametric boost) and `ap` (allpass: everything passes, the phase turns through 360° around the cutoff; summed with `in` it is a phaser stage, modulated and summed with the dry signal a one-stage phaser). They come from the same two integrators, so they cost nothing extra when unused.

## Ladder filter


- **Ladder** is a four-pole low pass of the Moog kind with `drive`: four one-pole stages in a feedback loop with a soft saturator inside it, so `res` goes up to self-oscillation (at 1) and `drive` (1..8) pushes the signal into the saturator for grit. Outputs `lp24` and `lp12`; `cv` with `cvamt` and `track` as on the Multimode. Its cutoff modulation is updated once per block (fine for envelopes and LFOs; the Multimode is the one for audio-rate cutoff).

## Assemblies: merged ports, placement, nesting

- **Merged ports.** On an expanded assembly, every exposed input has a `merge…` list of the card's other inputs of the same kind. Merging turns two jacks into one that feeds both (the factory `voice` has one `gate` for its two envelopes); the card shows `×2` and a `split` button. A cable into a merged jack goes to every input behind it, and removing it takes them all.
- **Placement.** "Add module" (a select by kind; picking inserts) and "Insert assembly" (a browser: shelves on the left, entries with their ports on the right, a search across all) put the new card on the first free grid cell instead of on top of what is there.
- **Nesting.** An assembly can hold assemblies, with no depth limit: select modules inside an expanded assembly and "Make assembly", or drop a collapsed card into an expanded frame. The parent's card may show whatever its children expose; collapsing the parent hides everything inside. Ungroup dissolves one level, delete keeps the nested ones. Saved assemblies carry their nested ones.

## Factory assemblies

The browser's factory shelves hold sixty-six, made by `web/scripts/gen-assemblies.ts` (edit the script, rerun it, commit the files; `voice` and `echo` are kept by hand):

- The recipes of the factory patches: **filter voice** (oscillator, filter, one ADSR on the VCA, the filter's cv exposed), **adsr operator** (oscillator into a VCA with an ADSR: the operator of the FM patches), **noise voice**, **stack voice** (two oscillators, mixer, filter, ADSR, VCA, with `in3` for a third oscillator), **vibrato** (LFO through an Attenuverter). The factory patches open as their instrument's assembly card (Init stays flat); a patch saved from the editor keeps its grouping in the JSON and the bank, and the binary patch for the FM-1 carries only each assembly's poly setting, the device pages and the device extras from it.

- Voices: **operator** (oscillator, level/rate envelope, VCA: an FM operator, with `pm` in and `level cv`), **fm pair** (a modulator with its own envelope into a carrier: one `pitch`, one `gate`), **voice** (subtractive: oscillator, filter, two ADSRs), **sub bass** (glide, square an octave down, dark tracking filter), **wavetable pad** (slow frame sweep, filter, slow ADSR), **vowel voice** (saw through the vowel filter swept by an LFO), **pluck** (string into a tracking low pass).
- Drums (no samples: modal bodies, noise and envelopes): **kick** (sine with a pitch drop, a 1 ms click, decay envelope, drive), **snare** (noise through a high pass plus a sine body), **hihat** (noise through a high pass, very short), **hats** (a detuned square cluster plus noise through a 7 kHz high pass: `gate` is the closed hat, `open` the open one, and the closed hat chokes the open one), **clap** (a noise band with a flam and a tail), **rim** (a strike into a short inharmonic body and a tuned comb), **cowbell** (two squares a sixth apart, band pass, short envelope), **tom** (a harmonic modal body with a pitch drop; `tune` picks the size), **tabla** (a slightly inharmonic head with a slap; velocity opens `bright`, a slow envelope bends the pitch down). All take one `gate`; the drums ignore pitch (tabla takes it), so one key per drum through a Sequencer's gate or the Main gate. The factory patch **909 Kit** plays kick, snare and hihat from three sequencers on one clock; the **808 Kit** plays the **boom kick** (a long, low sine with a shallow drop, no click), snare, hihat and cowbell the same way. **<7PH** plays the 909 Kit's drums with a Silver Box bass line on its own PATTERN track; PLAY starts both, Main's keys play the bass, and arming DRUMS puts the keys on the kit.
- Instruments (factory assemblies built after famous synthesizers, each with a factory patch of the same name): **Oracle V** (Prophet-5), **Monolith D** (Minimoog Model D), **Silver Box** (TB-303), **Hera 6** (Juno-106), **Sallen 20** (MS-20), **Expander S** (Oberheim SEM / Four Voice), **Algo Four** (4-operator DX / TX FM), **Canvas** (Buchla Music Easel), **Wanderer** (ARP Odyssey). The names point at the originals; nothing is affiliated with their makers.
- Granular (one Granular per patch): **cloud** (a dense pitch-true cloud of whatever comes in; `freeze` and play over it), **shimmer** (the reverb's tail fed back through grains an octave up; holds the patch's Reverb), **stutter** (grains fired by an internal divided clock, the read position jumping), **time smear** (a feedback delay into grains an octave down, crossfaded with the dry signal; holds the patch's Delay), **slicer** (a step sequencer picks the read position of the last second, its gate fires the grain), **reverse pad** (long grains from `age` seconds back under a slow attack).
- Resonator: **glass bell** (a strike into a bar-like body with a little frequency shift; velocity opens `bright`), **gamelan** (two bar bodies a fifth apart, the second a little sharp, one noise burst), **kalimba** (a plucked tine with a comb body), **marimba** (a bar with a resonator tube by `tube` and a tremolo `motor` for vibes), **bowed glass** (noise through a tracking ladder into a modal body under a slow envelope, a compressor evens the sustain), **rain** (a fast random clock samples noise into a pentatonic pitch and strikes a body), **resonator bank** (three bodies on the root, fifth and octave: a drone from a chord, tuned percussion from a drum loop). Their `hit` parameter is the strike level: the modal body rings loud, so a strike of 0.02..0.06 is the range.
- Comb filter, shifter, compressor: **bowed string** (noise through a ladder into a high-feedback comb at the pitch, glide), **barber pole** (a slow frequency shift up and down crossfaded by an LFO: an endless rise), **sidechain pump** (a compressor ducked by an internal clock's pulse), **talking filter** (the input's envelope opens the vowel).
- Sequencing: **clock** (square LFO with /2 /4 /8 /div), **step sequencer** (clock, eight steps, quantizer: `pitch` and `gate` out, add its `pitch` to Main's into an oscillator), **random melody** (clocked S&H on noise, quantizer, pulse gate).
- Utilities: **auto pan** (LFO on a Pan: `in` to `l` `r`), **echo** (delay into reverb).


## Module on / off

Every module except Main and Output has a power button in its card header: off, the module is bypassed like a device in a DAW rack. Its main input (`in`, the mixer's `in1`, the crossfade's `a`) goes straight to every output, so a filter, delay, reverb, shaper or compressor drops out of the chain without a repatch; a module without such an input (an oscillator, LFO or envelope) is muted. The module keeps its state and resumes when turned on again. On the FM-1 a patch button set to Toggle bypasses its module or assembly; the switch is saved with the patch. An assembly has the same button: it switches every module inside, and remembers the ones you had switched off yourself so they stay off when the group comes back.

<!-- decision-ledger:start -->
## Decisions

Project decisions live in [`docs/ledger/`](docs/ledger/) as rows with stable `D-###` IDs; start with [its README](docs/ledger/README.md). Cite a row as `([D-###](docs/ledger/<file>.md#D-###), Status)`. If a decision is not a row there, it has not been decided.
<!-- decision-ledger:end -->
