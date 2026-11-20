# Changelog

## 1.23.0 — 2026-11-20

- **MIDI learn, on the FM-1 too: any knob, fader, pad axis or pitch bend wheel can move a row, even on a page that is not showing.** In the editor, open a row's ⋮ menu and choose **MIDI learn…** (or click the row and pick **MIDI learn…** in the palette), then move the control on your MIDI controller. On the FM-1, open GLO › MIDI, turn ALGO to the third page, turn LEARN right, turn the knob of the row you want, then move the control. From then on that control moves the row whatever page is in focus, and the FM-1 keeps doing it without the editor: the patch carries what it learned, and SAVE keeps it. A Korg nanoPAD2's X-Y pad can drive Briefcase 3's joystick this way; learn each axis on its own. In FM-1 & MIDI, Low and High set where the control's ends land in the row's range, and the list marks a control only the editor plays (a row no FM-1 page shows). A learned control does only that in its patch: a learned CC 1 no longer moves the mod wheel. A patch holds up to 16 learned controls. Patches with MIDI learn need the next firmware (#1067).
- **Briefcase 3's joystick now moves the sound:** x sweeps the filter and y bends oscillator 1, so a MIDI controller learned onto them plays the VCS3's stick. At the centre the patch sounds as before. A slot you saved keeps its own version.
- **The 909 Kit's hi-hat LEVEL sets both hi-hats, as on the TR-909.** Turning the hihat LEVEL knob down used to quiet only the closed hat. Now the open hat follows it, in the editor and on the FM-1. At its usual setting the kit sounds exactly as before. Your saved 909 Kit sounds keep all their settings, and the closed hat's level becomes the shared one.
- **Every sound of the 808 Kit and the 909 Kit plays from the FM-1's own keys.** The black keys used to reach only a kit's first 8 sounds, so the 909's MID TOM, CRASH, RIDE, ACCENT and its flams, the 808's toms, cymbal and accent, and Verona Drum 1's two closed hats could not be played or edited on the FM-1. Now a kit's sounds come 8 at a time: OCT- and OCT+ switch to the next 8 on a device page and the environment, and the footer shows which (ROWS 1-8, ROWS 9-16, ROWS 17-24). On the SEQ page, hold SEL and press OCT- or OCT+: the grid shows those 8 rows with their names, ready to edit. Kits with 8 sounds or fewer work as before, and OCT still changes the octave there. The editor's piano roll now lists all of a kit's sounds by name. Needs the next firmware.
- **The FM-1 no longer floods its link to the editor while the 808 Kit or the 909 Kit is open.** With the editor connected, the first build of 1.23.0, which was never released, sent its panel state over and over with nothing changed. This happened on the device page, the environment page and the drum grid of a kit with more than 8 drum sounds, and while MIDI learn waited for a knob. The FM-1 then spent its time waiting on the link, and the editor could miss what the FM-1 told it, such as the track armed on the FM-1. Now the state goes out only when something changes, as before.

## 1.22.0 — 2026-11-19

- **The FM-1 follows Song Position, and clock and transport have their own switches.** A DAW or looper that sends Song Position and Continue now starts the FM-1's Steps tracks at that point, its songs included, also when it jumps back mid-play at a loop point. GLO > MIDI has a second page with TRANSPORT IN and TRANSPORT OUT, beside CLOCK IN and CLOCK OUT, so the FM-1 can follow a tempo without its Start and Stop, or the other way round. MIDI OUT now covers only the panel's controls. On the SONG page, PLAY starts the song from the entry under the cursor and tells the DAW where with Song Position. Needs the next firmware (#596).
- **An EQ module.** One band of a parametric equalizer: low shelf, bell, high shelf, low pass, high pass or notch, from 10 Hz to 22 kHz, ±18 dB, with q. Chain several for more bands, or drop in the factory assembly EQ (a low shelf, a bell and a high shelf). Its curve keeps its analog shape right up to the top of the range, without the squeeze a plain digital EQ has near 20 kHz, at no extra CPU while it plays. Patches with an EQ need the next firmware (for #1107).
- **A master EQ on the FM-1, for every patch.** GLO › EQ, a new settings tab, shapes what the speaker and the headphone jack play: LOW (a shelf at 120 Hz), MID (a bell you place with MID FREQ, 100 Hz to 8 kHz) and HIGH (a shelf at 8 kHz), each ±12 dB. Use it so sounds made on headphones still work through speakers in a room. It belongs to the FM-1, not to a patch, so it works with every patch, the 909 Kit included, and costs no patch bytes. USB recordings are left as they are. It is flat as made, and a flat EQ changes nothing. A change is kept without SAVE. The editor sets it too, from FM-1 & MIDI › Master EQ. Each band you turn away from 0 dB costs CPU on every patch, about 3.5 % for the first and 1.3 % for each one after it, so the heaviest patches with every effect on may drop a voice with all three bands in use. Needs the next firmware (for #1107).
- **Hera 6 gains Drive on its FX page,** beside its own Juno chorus, Delay and Reverb, at its six voices. Drive starts off, so every factory preset sounds as before; turn it on from the FX page. A slot you saved keeps its own version.
- **A clock that arrives together with a Start no longer puts the FM-1 a clock ahead.** When an app sends the last clock of its loop and a Start for the next one at the same moment, the FM-1 counted that clock as the first of the new loop, so its patterns ran one clock ahead of the app. The clock now belongs to the old loop, in the FM-1 and in the editor. The FM-1 also keeps a log of the MIDI clock, Start, Stop, Continue and Song Position messages it received, with their timing, for finding out what an app such as Reel sends at its loop point: `tools/m1_link.py midilog` reads it once the FM-1 is plugged into a computer (#870).
- **The 808 Kit has an effects rack: Drive and Reverb on the FX page,** as the melodic patches have. Both start off, so the patterns, the kit and its presets sound as before. The FM-1 gets it with the next firmware release. A slot you saved keeps its own version.
- **Patches take less room, and the 909 Kit has room again.** A patch can now leave out what the FM-1 already knows: empty panel labels, Drum map row names left at their defaults, and the repeated bytes of its cables. It sounds exactly the same. The editor counts every patch in this shorter form, so each factory patch shows more room: the 909 Kit has 318 bytes free instead of 9, the 808 Kit 276 instead of 18, Canvas 206 instead of 7 and Briefcase 3 221 instead of 10. A patch that fits as before is still sent as before. Only a patch that would not fit any other way is sent in the shorter form, and it needs the next firmware.
- **The 808 Kit and the 909 Kit keep their Drum maps inside the kit.** On the canvas the collapsed kit shows only its own jacks, the keys from DRUMS and its outputs, instead of some forty cables along its bottom edge. On the FM-1, SELECT goes straight from DRUMS to the kit, with no Drum map pages in between, and SEL on the kit arms DRUMS. The kits sound and play their patterns exactly as before, and your presets of the kits come along. The FM-1 gets it with the next firmware release. A slot you saved keeps its own version.

## 1.21.0 — 2026-11-19

- **A Start from an app that sends no clock before it no longer puts the FM-1's steps ahead.** When an app sends Start and only then its MIDI clock, the FM-1 now waits up to 150 ms for that first clock and starts its patterns on it, as it already does when the clock runs before the Start. Before, it started at once on its own tempo, and when its own tempo was faster than the app's, every step came two clocks early (at 90 bpm against the FM-1's 120: about 55 ms). An app that sends Start with no clock at all starts the FM-1 150 ms later than before, on its own tempo. The editor follows MIDI clock the same way (#870).
- **Every patch leaves the FM-1 a little more room.** The FM-1 now does less bookkeeping for each module of a patch every block: it works out when the patch loads which inputs move a module's settings, adds up those inputs four samples at a time, and no longer divides to find which voice a module copy belongs to. The sound is the same, sample for sample. On the test rig, with up to 8 keys held, the polyphonic synths with all their effects on use 1.0 to 4.6 points less of the FM-1's CPU (Hera 6 fx4 82.2 → 79.0 %, Oracle V fx4 81.6 → 78.1 %, Cassia 1 fx4 85.8 → 81.3 %, running), and the factory patches up to 5.8 points less (Algo Four 73.2 → 67.3 %, Hera 6 74.5 → 71.2 %) (#1072).
- **The FM-1's work around the voices takes less time.** The work the FM-1 does before and after the voices in every audio block now runs from fewer lines of code and sums the outputs in one pass, with the same sound to the sample. On the test rig, on top of the change above, the audio interrupt takes 30 to 47 µs less of each 2.9 ms block with eight keys held (Hera 6 gauze 2 1,767 → 1,737 µs, Oracle V fx4 1,897 → 1,851 µs), and the polyphonic synths with their effects peak 0.6 to 2.0 points lower (#803).
- **A factory patch you never changed now updates itself.** After a firmware update, or when the editor installs new factory sounds, a slot that still holds a factory patch exactly as an earlier release put it there gets the new version, in the same slot and under the same name, and the bar says FACTORY PATCHES UPDATED. A slot you edited and saved, or renamed, keeps what it holds. You no longer need FACTORY RESET to get a changed factory patch: a saved Algo Four or Cassia 1 from 1.20.0 or 1.20.1, for example, gets the eight and five voices of 1.20.2. If the editor installs new factory sounds while the FM-1 plays such a patch, the new version loads at once, unless you have edits you have not saved.
- **Expander S plays eight voices, as the Oberheim Eight Voice did, and the CPU estimate follows the FM-1 as voices are added.** The editor's CPU estimate climbed too fast as voices were added to a poly synth: Expander S at seven voices with every effect on read 91 % where the test rig held 82 %. Each poly factory engine's voice cost now comes from how much the test rig rises from one voice count to the next, and every factory patch still reads at least what the rig measures (the poly synths 0 to 3.4 points over). With that, Expander S plays eight voices: with every effect on the estimate reads 86 %, and the test rig held 82.7 % with up to 8 keys held and the transport running, its presets at most 84.3 %, nothing dropped. Its presets play eight too, except SEM Bass (one) and Unison Lead (four voices on one key). Highpass Pluck is quieter (level 1.58 → 0.92), so eight keys at once stay under the headroom limit. Algo Four's eight voices and Cassia 1's five are now in the firmware itself. An Expander S slot you never changed gets the new one; a slot you edited keeps its patch (#782).
- **The FM-1 stays in step with an app or device that sends it MIDI clock, also when that clock stalls.** A looper such as Reel can pause its clock for a moment, for example while it writes a take at the end of a loop. The FM-1 now waits for the clock to come back while it plays, instead of going on at its own tempo after half a second and ending up out of step. A Start from the sender plays the patterns from the top again, also while they play, and so does a Continue after Song Position 0. The first step now sounds on the sender's first clock after its Start and the next steps on its clocks after that, where before every step came one clock early. The editor follows MIDI clock the same way (#870).
- **Known issue: with Reel, the FM-1 still runs one 16th note ahead after Reel loops.** The offset is the same at every tempo and loop length. We are finding out which messages Reel sends at its loop point; the fix will come in a later release (#870).

## 1.20.3 — 2026-11-19

- **Quick patch: a cable you pick up no longer looks as if it goes back into its own card.** When you pick up a cable, the card's ring folds away into one plug beside the field, the jack flashing once, and the middle of the menu becomes an empty socket that asks where to?. The list shows the cards the cable could go to; type one, or choose it with ↓ and Enter, and only then does its ring grow out of the socket, with the plug beside the half it goes into. On the canvas, the card the menu is on and the jack the cable comes from glow once and then stay lit, and the card or jack chosen in the list gets a thin outline. Enter with nothing typed no longer jumps to a card nobody named, a new module in the list now reads New Multimode filter beside the Multimode filter already in the patch, Enter on a jack that already has that cable says so instead of doing nothing, and dragging the canvas with the right mouse button no longer sends your typing to the note keys (#1091).
- **Typing envelope finds the envelopes, the ADSR first.** In Quick patch, `envelope` (or `eg`) lists the ADSR first, then the Level/rate envelope, the Eight-step envelope and Rate Env, and a word typed whole that is a word of a module's name or search words ranks above a part of one. The command palette's add module finds all four by envelope too (#1114).
- **The on-screen keys no longer vanish when the window gets narrower.** Snapping the window to half the screen, or opening the editor in a wide window, could leave an empty band with a scrollbar where the keys belong. The keys now stay, and after a resize the strip scrolls back to the keys the computer keyboard plays. Fixes #1116.

## 1.20.2 — 2026-11-18

- **Algo Four plays eight voices and Cassia 1 five on an FM-1 with 1.20.0 firmware, without a firmware update.** The factory sounds update the editor offers now carries both patches, and an FM-1 on 1.20.0 plays them in place of its built-in copies: FACTORY RESET installs Algo Four at eight voices and Cassia 1 at five, and their factory presets then load at the full count (Algo Four's DX100 sounds that choose fewer voices keep them). A saved Algo Four or Cassia 1 slot keeps its patch (six and four voices, presets seven and four) until a FACTORY RESET, or until you send the patch from the editor. On the test rig, on 1.20.0 firmware with this update, with up to 8 keys held and every effect of the patch on, nothing dropped a voice and the busiest steady load was 83.0 % (Cassia 1 Reso Pad with the transport running; the Algo Four patch 79.3 % stopped, 81.7 % running).
- **Elvira 2 grows toward the Elmyra 2: filter types, reverb, 1.6 s delay, audio-rate LFOs, sequences and OUCH's ports.** The main filter has eleven of the Elmyra 2's twelve types: pick the ladder or state variable low, band or high pass on `filter`, or `other` for high and low pass in series or parallel, base-width, its notch and the comb. `routing` puts the delay before the filter. The delay now reaches 1.6 s, and `reverb` on plays a reverb in its place. OUCH gets its modifier ports as `feedback` (a loop from CHOKE back into BITE) and `diode` (the fold's asymmetry; away from 0 it offsets OUCH's output, so with `feedback` up it can hum with no key held). Both LFOs reach about 1 kHz, so LFO 2 can rough up BITE at audio rate, and `sync` locks either to the tempo; LFO 2 has an S&H mode (its old random wave plays as S&H). Each voice has an eight-step sequence added to its TUNE (`seq 1` to `seq 4`: steps in octaves, length, clock divider, order), which plays while PLAY runs. CUTOFF, RESO and the LFOs' FREQ are now 0 to 1, as the original's knobs: a saved Elvira 2 preset keeps its other settings but starts CUTOFF and FREQ at Init. Deep Drone uses the reverb, Rusty Bells OUCH's feedback, Pulse Lantern a synced LFO and two sequences, Beating Cluster a 1.2 s delay. On the test rig, Init and every preset with up to 8 keys held, transport stopped or running, nothing dropped and the busiest steady load was 80.8 % (78.5 % stopped). Still missing: the comb tuned to voice 1, the lo-fi reverb and the other MOD programs. A saved Elvira 2 slot keeps its patch; FACTORY RESET installs the new one (#858).

## 1.20.1 — 2026-11-18

- **No factory patch or preset makes a sound the moment you switch to it.** The drones now wait for PLAY: 8 Lire's Eight Drone, Trill Delay and Feedback Howl and Elvira 2's Deep Drone and Beating Cluster hold their voices as drone notes on the PATTERN track, so PLAY starts them and STOP lets them fade (HOLD and DRONE are still on the card for droning by hand). Every 8 Lire and Elvira 2 preset now brings its own pattern to play on PLAY. Canvas's Sequencer Run, Easel Bongos and FM Chimes no longer run by themselves: each key is a pulse at the level the old pulses had (hold a key with ARP on for the run), and their gate closes fully between notes. A test checks every factory patch and preset, in the editor's engine and the FM-1's, so a new one that sounds at load fails. A factory content update: no firmware release needed (#1086).
- **8 Lire's plates feel how hard you play.** As on the Lyra-8, a light touch opens a voice partly and slowly, and a hard one opens it fully and fast. How hard is the key's velocity (or a PATTERN note's), plus channel aftertouch from an outside MIDI keyboard pressed into the key (the FM-1's own keys send no aftertouch). With a pair's FAST down its plates open less. Everything the Lyra-8's panel does is now on 8 Lire; only the hardware is missing (outside audio in, the jacks, the plates' feel of skin). 8 Lire still makes no sound until a plate is played or PLAY runs. A saved 8 Lire slot keeps its patch; FACTORY RESET installs the new one (#851).
- **More voices: Algo Four plays all eight, Cassia 1 five.** Algo Four gets back the Yamaha DX100's eight voices and Cassia 1 plays five. Their factory presets, and Oracle V's, now play the instrument's full count too, where loading one dropped back to four (Algo Four's DX100 sounds that choose fewer voices keep them). Algo Four and Cassia 1 live in the FM-1's firmware, so on an FM-1 with 1.20.0 firmware their presets play seven and four voices, and their patches keep six and four, until the next firmware release; Oracle V's presets play five from this update, and the editor plays every count now. On the test rig, with up to 8 keys held and every effect of the patch on, transport stopped or running, nothing dropped a voice and the busiest steady load was 82.2 % (Cassia 1's Reso Pad; Algo Four at eight 81.0 %, Oracle V's presets at five 80.9 %). Some sounds are a little quieter so all their voices at once stay under the headroom limit: Algo Four's Init, E Piano, Tubular Bell, Brass Stab and Porcelain Keys, Cassia 1's Tine Piano and Oracle V's Unison Bass. The editor's CPU estimate now counts the master effects at what they cost on the FM-1: with every effect on it read 5 to 12 points too high. A saved slot keeps its patch; FACTORY RESET installs the new ones.
- **Quick patch: build a patch from the keyboard, with no jack aiming and no panning.** Press Tab on the canvas and a see-through radial menu opens in the middle of the canvas, a field at its centre with the card's name above it. Type `lfo` and Enter: an LFO appears under the menu, and its jacks fill rings round its name, the left half for the jacks that take a cable and the right half for the ones that send, each half marked with a jack icon. The jacks that fit the cable you hold are lit and the likely one is marked ⏎ (cv for a control signal, the jack named in, or the Output's l, for audio), so LFO → Multimode → VCA → Output is `Tab lfo ⏎ ⏎ mm ⏎ ⏎ ⏎ vca ⏎ ⏎ ⏎ out ⏎ ⏎` (22 keys). Type a jack's name (`out` is the jack named out) or click it to pick another. New cards line up by signal flow beside the card they are cabled to; the canvas stays still while the menu is open, and brings a new card into view when it closes if it landed off screen. A cable into a jack with a parameter shows that parameter beside the menu: drag it, or type `800hz` and Enter. Shift+Enter follows a cable to the card at its other end, and `[` / `]` go back and forward along the way you came. The same field takes whole chains, typed or pasted (`lfo.out > multimode.cv; multimode.lp > vca.in > output.in`). `bp save <name>` keeps the last chain as a blueprint in this browser and `bp <name>` stamps it again, wired. C copies the card under the pointer and opens its menu. Each chain is one undo step (#1091).
- **Get round the canvas with the mouse: right-drag moves it, the wheel zooms, and the canvas never ends.** Right- or middle-drag anywhere on the canvas, over cards and cables too, and the canvas follows the hand in any direction; a right-click without moving still opens the menu (Add comment, a card's menu). The canvas now goes on in every direction, up and left of the cards too: move the cards to the middle of the view and zoom out around them, and a zoom holds the point under the pointer wherever the cards are. Cards and comments can be dragged anywhere, and the canvas no longer shows scroll bars. A mouse wheel zooms at the pointer, while a trackpad's two-finger scroll still moves the canvas and a pinch zooms; Ctrl/Cmd+wheel always zooms and Shift+wheel moves sideways. The editor tells a mouse from a trackpad by itself; **Scroll wheel** in the sidebar's Canvas panel (auto, zoom or pan) settles an unusual mouse. New keys: Shift+1 fits every card (as Alt+Z), Shift+2 the selection, both centred, and Ctrl/Cmd + = / − / 0 zoom in, out and to 100 %; they are in the ? card and the palette. Dragging a card, a cable or an area near the canvas's edge now moves the canvas along. Holding 1..4 and turning the wheel still turns K1..K4 (#1075).
- **Oracle V's LFO reaches 500 Hz, as the Prophet-5's does.** Its new **lfo freq** row sweeps from 0.022 Hz to 500 Hz, the range the Prophet-5 User's Guide gives, at an even ratio per step (−4 to 4; 5 Hz is 0.33 at Init). The Wheel-Mod's freq A and freq B now move the oscillators' pitch at audio rate, so a fast LFO makes FM growls and clangs instead of averaging away. The factory presets sound as before. A user preset of Oracle V stored before keeps its other settings but its LFO rate starts at 5 Hz (#862).

## 1.20.0 — 2026-11-18

- **More voices on the FM-1: Oracle V plays all five, Hera 6 all six.** With the faster 1.20 engine, Oracle V gets back the fifth voice of the Prophet-5, and Hera 6 plays the Juno-106's six. Expander S's VOICES row now reaches six and Algo Four's seven; Cassia 1's stays at four. On the test rig, with up to 8 keys held and every effect of the patch on, transport stopped or running, nothing dropped a voice and the busiest steady load was 79.9 % (Oracle V at five; Hera 6 at six 77.7 %, Expander S at six 74.7 %, Algo Four at seven 76.3 %). Hera 6's Bass preset is quieter (level 0.76 → 0.55), so six keys at once stay under the headroom limit (they peak at 0.93). A saved slot keeps its patch; FACTORY RESET installs the new ones (#782).
- **Steps notes can ratchet and move off the grid: ratchets and micro timing.** A note can play 2 to 5 times inside its step, evenly spaced (a ratchet), and up to 23/24 of a step early or late (micro timing); an early note on a pass's first step plays at the end of the pass before. On the FM-1's SEQ page, hold a step and turn PRESET for the ratchet, or press OCT- / OCT+ for the micro timing; the bar names it, a ratcheted cell is cut into slices and a moved one gets a lilac foot. In the editor, set both in a step's popover (right-click the step), or press X / Shift+X and , / . in the piano roll. A patch with either needs this firmware (patch format 63) (#675, #677).
- **Polyphonic synths with effects play all their voices on the FM-1.** The FM-1 now runs its busiest small pieces of code from its fast internal memory instead of fetching them again from flash every block, and when a patch loads it shares the modules between its two cores using what each kind of module costs on a real FM-1. With the floating-point filters and effects below, the owner's Hera 6 "gauze 2", Oracle V and Hera 6 with every master effect on no longer drop voices (their steady load on the test rig is 70 to 73 %, from 89 to 98 %), and every factory patch uses 4 to 21 points less of the FM-1's CPU on the test rig (Briefcase 3 69.5 → 49.3 %, Canvas 65.2 → 47.9 %, Oracle V 73.5 → 62.6 %) (#1073, #1072).
- **Resonator patches leave the FM-1 more room, and their rings fade as in the editor.** The FM-1 now plays the Resonator with its floating-point unit, which does its sums about twice as fast, so patches with one (the 808 Kit, Meridian 8, and the gamelan, kalimba, marimba, tabla, tom, rim and other resonator assemblies) use less of the FM-1's CPU. A long ring now fades as it does in the editor down to the FM-1's quietest step, instead of falling away early and stopping about 85 dB down; with nothing playing into it, it still ends in silence (#979).
- **The Reverb, the Low pass gate and the Delay's 22k / 11k rates and Tape leave the FM-1 more room.** The FM-1 now runs them with its floating-point unit: on the test rig a Reverb costs about a quarter less (a patch of one Reverb 664 → 466 µs of each 2.9 ms block; Briefcase 3 uses 73 to 137 µs less), a Low pass gate about 20 µs less a block, a Delay at a lower rate or with Tape 10 to 26 µs less. They sound as before, and their tails still end in silence (#979).
- **Filter patches leave the FM-1 more room.** The FM-1 now plays the Multimode filter, the Ladder (both modes) and the Formant filter with its floating-point unit, so patches built on them (Hera 6, Io 4, Oracle V, Briefcase 3, the 909 Kit, Verona Drum 1, Canvas, Meridian 8 and others) use less of the FM-1's CPU: with 8 keys held on the test rig, 50 to 134 µs less of each 2.9 ms block (Briefcase 3 1,914 → 1,780 µs, Hera 6 2,021 → 1,894 µs, Oracle V 2,068 → 1,940 µs). They sound as before, self-oscillation and drive included, and a ring with nothing playing into it still ends in silence (#979).
- **Arpeggios that fit the bar.** The Arpeggiator's rate has four new choices, 1/2 bar, 1 bar, 2 bars and 4 bars: a triad and a four-note chord now take the same time to loop. Each note sits at its exact share of the bar, the loop starts on the bar line while the transport runs, and a chord change takes effect at the next loop. Needs firmware 1.20 on the FM-1 (#1010).
- **Arpeggiator swing.** A new swing row, as Steps has: every second note comes late, from 50 % (straight) to 80 %. With the bar rates it swings the fitted notes. Needs firmware 1.20 on the FM-1 (#1012).
- **Time signature.** GLO › PANEL has a second page with TIME SIG (2/4, 3/4, 4/4, 5/4, 6/8, 7/8, 9/8, 12/8; 4/4 as made), and the editor has a Time signature list under Tempo. It sets the bar play once and REC count in, with a click on each beat, and the bar the arpeggiator's bar rates fill. Older firmware and patches play 4/4 (#1011).
- **A Euclid module: Euclidean rhythms from four knobs.** Set **steps** (1..32) and **hits**, and the Euclid spreads the hits as evenly as they go: 3 over 8 is the tresillo, 5 over 16 a bossa feel. **rotate** turns the pattern, and **accent** marks that many of the hits, which also play on the **accent** output, for a louder drum or a filter kick. Each step plays on **trig** (a hit) or **off** (a rest). Patch a clock into **clock**, or leave it empty and the Euclid follows the FM-1's tempo or MIDI clock while PLAY runs, one step each **rate** (1/4 to 1/32, with triplets). **reset** starts the pattern again. A cable or a pin on hits or rotate makes the rhythm move as you play. Search for it as euclid, euclidean or bjorklund. It plays on the FM-1 too, with 1.20 firmware. Ported from KITTEN RACK's Euclid (https://github.com/BlackKittenDevices/kitten-rack), with the accent and the FM-1's clock added (#1018).

## 1.19.0 — 2026-11-17

- **Splitting a signal: find it, and merge any two jacks of an assembly.** Matryoshka has no Splitter or Mult module because it does not need one: cable an output again and it feeds every input it reaches. Inside an assembly, a merged jack does the splitting: while you choose the card (the frame's **card · N**), **merge…** on an input joins it to another, and the collapsed card shows one jack that feeds both. Searching **splitter** or **mult** in Commands or + Module now says so and opens the help at it. Two jacks now merge whenever one cable could reach both (keys only with keys), so a gate jack can also feed an audio input. A cable already plugged into either jack now reaches every input of the merged jack; before, the newly joined input stayed silent until you patched it again (#1004).
- **A Low pass gate module.** One card that is a low pass filter and a VCA opened together by a vactrol, as on a Buchla 292: it opens fast and closes slowly, more slowly as it nears closed, so a pluck darkens as it fades. Patch a gate or a clock into **strike** for the wooden "bonk" of a struck gate, or open it with **cv** and **offset**. **mode** picks combo (both), lp (the filter alone) or vca (the gain alone); **decay** sets how long it takes to close; **res** adds a resonant peak that rings while the gate is nearly closed. It plays the same in the browser and on the FM-1, which needs the 1.19 firmware for a patch that uses it. Ported from the LPG of [KITTEN RACK](https://github.com/BlackKittenDevices/kitten-rack), BlackKittenDevices' fork of Matryoshka, with the resonance added; thanks to fairplay for asking (#1018).
- **A Limiter module, to save your ears in feedback patches.** Put a Limiter before the Output (or inside a feedback loop) and nothing it plays gets louder than its `ceiling`, however hard the patch runs away: the gain comes down on every peak, and a last hard clip catches the rest. Its card shows how many dB it takes off. With `ahead` on it delays the sound 1.45 ms so the gain comes down smoothly; turn it off inside a loop. It plays on the FM-1 too, with 1.19 firmware (#1019).

## 1.18.5 — 2026-11-17

- **A card's ⏻ always shows whether it is on.** With Live on, pressing LFO on the FM-1 striped the Harmonizer card's header (bypassed) or cleared it, but the card's ⏻ stayed as it was. The same happened for any patch button that switches a card or an assembly on or off, whether pressed on the FM-1, on the deck or sent as MIDI. Clicking a card's ⏻ also left the deck's ARP or LFO light as it was. Now the card's stripes, its ⏻, the assembly's ⏻, the FX switches on the master FX card and the deck's ARP and LFO lights change together, whatever turned the card on or off (#1054).
- **The FM-1 plays the Harmonizer from its keys while linked.** In sandbox mode the FM-1's keys reached the browser as plain notes, so its seven lowest keys picked chords only at octave 0; at any other octave they played notes, and a root under the Harmonizer's split picked a chord instead. With Live on, the browser, which plays along with the FM-1, took such a root as a chord too. Now the seven lowest keys are the chord buttons (sus2, maj, sus4, min, 7, dim, 9) at every octave, and every other key plays a root, in sandbox mode and with Live on, as on the FM-1 itself (#1053).

## 1.18.4 — 2026-11-17

- **A Sound design sidebar on the right: snapshots are now candidates, and the current patch is always A.** The versions of your patch you compare by ear are called candidates, and they live in one panel that runs the whole height of the window at its right edge: **Listen** at the top, then the Output scope, then the list, then two buttons; the canvas, the keyboard deck, Connect FM-1 and the ? button make room beside it. **Listen** holds what used to sit beside the keyboard, under a label that says what it is for, "the same notes for every candidate": a round play button (Q), the phrase menu (each phrase with a one-line description, My take below them, and ↺ Use my last take), the root note and Loop; under them ⤓ WAV and Rec, which turns coral, counts the time and becomes Save while it records, and a short note after a WAV that fades away. **Generate** (coral, Alt+N or Option+N on a Mac; it was Make candidates) makes new candidates that each Mutate the patch you hear, 4 at a time (click the ×4 beside it for 2, 6 or 8), or breeds the ones you kept. **Nominate** (seafoam, Shift+Alt+B; it was Take a snapshot) adds the patch you hear as a candidate. Above the list, the **±25 %** chip sets how far Mutate and Generate move each setting (5, 10, 25 or 50 %), and the **Aim** chip the kind of sound. The first row is always **A**, the current patch with your latest edits; the candidates are lettered B, C… as they come, and candidates this browser kept from before move on one letter once (A becomes B), so there is never a second A. Each row shows its letter, its name (or "unnamed"), where it came from ("taken by hand", "from B", "from B and D", "before mutate"), how many settings differ from A, and a tick to keep it. The row you hear has a teal letter, and it alone has **Keep**, **Use** and **✕**; a kept one has a gold ring and tick; a coral dot means you changed it since it was taken (switching away keeps your edit as a new letter). **Use** (Alt+C) makes the candidate you hear the current patch, so it becomes A, and the patch it replaces takes its place with a new letter; Ctrl/Cmd+Z puts both back. Alt+J (or Alt+B) goes to the next candidate and Alt+K to the one before, from A down the list and round to A again, without stopping; while the open sidebar has the focus (click in it), ↑ and ↓ do the same, and arrows elsewhere work as before. Alt+X removes the candidate you hear at once and plays the next (Ctrl/Cmd+Z puts it back); there is no cut mark any more. Drag a row up or down to change the order the keys go through: it lifts, its place fades and a teal line shows where it lands. **⋯** holds Mutate, Randomize, Lock envelopes, the Mutate amount and pitch, candidates per round, Store kept candidates as presets, and Save as a patch or Store as a preset for the row you hear. The sidebar opens at its narrowest; drag its left edge to make it wider. » folds it to a 52-pixel rail that keeps the loop playable: the letter you hear, where it is (2 / 5), play, ▲ and ▼, a dot per candidate (gold when kept, A as a square; click one to hear it), then Keep, ✕ and +4 (Generate). The list scrolls inside the sidebar and the page never does, and this browser remembers its width and whether you folded it (#1028, #1038, #1040, #1048).
- **Mutate moves further at first: ±25 %.** In a browser that has not picked a Mutate amount, Mutate and Generate now move each setting by up to ±25 % of its range (it was ±10 %), so a first round sounds clearly different. A choice you made stays (#1048).
- **Mutate toward a kind of sound: lead, stab, pluck, pad, bass, keys or drone.** Pick **Mutate category** in **Commands**, click the **Aim** chip above the candidates, or press Shift+Alt+M (Shift+Option+M on a Mac) to step through them; the browser remembers it, and Any, the default, changes nothing. Mutate, Randomize and Generate then find the patch's loudness envelope, its filter envelope, its filter cutoff and its glide from how it is wired, and bring them into ranges that suit the category: a pad's slow attack and long release, a pluck's instant attack and no sustain, a lead's held note. That includes the controls an engine sets them with, such as Monolith D's decay knobs and DECAY ON switch or Canvas's envelope mode. The other settings move as before, leaning a little darker for a pad and a little brighter for a lead. With **Mutate pitch** on, Bass also moves pitch an octave down. The status line says which category a Mutate aimed at. With a category, Generate (Alt+N, Option+N on a Mac) also renders up to four times as many candidates, silently in the background, measures how each one sounds, and keeps those that sound like the category. They join the list as they pass, saying "sounds like a pad"; when too few pass, the nearest fill the round and say "kind of sounds like a pad". A progress line under the list counts them while the round runs, with Stop (Alt+N again stops too). Each candidate plays the same short probe, whatever your test phrase is: one note (C3, or a drum engine's first drum) held for 1 second, then up to 1 second to let go, so a round renders three to four times faster than with a held note. An attack or a release longer than the probe counts as at least 1 second, which suits a pad or a drone. Each sound is measured and dropped at once: nothing is recorded or stored. **Lock envelopes** in **Commands** keeps every envelope on the selected cards, or in the whole patch, out of Mutate's reach in one step (#1033).
- **Going to another candidate starts from silence.** Going to another candidate (Alt+B, Alt+J, Alt+K, a click on the list, Alt+X moving on, Use, or the first candidate Generate plays) now stops every note and cuts every delay, reverb and chorus tail first, in the browser engine and the FM-1 engine (Alt+E) alike, so nothing of the last version bleeds into the next. A looping test phrase then starts again from its first note. With Live on, the FM-1 gets All Notes Off, so its notes stop too; its own effect tails ring out unless the switch loads the patch whole. Ordinary edits, Mutate among them, still change the sound in place while it plays.
- **The arpeggiator no longer switches itself on behind the ARP button.** With an FM-1 (or another MIDI controller) plugged in, pressing and letting go of a patch button there, ARP among them, reached the browser engine as a held button, not as a press: the arpeggiator came on and arpeggiated your keys while the ARP button still showed it off. This happened most in a newly opened window, which does not follow the FM-1's panel yet. A patch button pressed over MIDI (CC 80..86) now presses the editor's button, as on the FM-1, so the button, the patch and the sound always agree; an FM-1 set to ignore the editor presses nothing (see below). The FM-1 engine (Alt+E) also no longer carried the button states of the patch before into the next one it loads (#1041).
- **An FM-1 set to ignore the editor no longer plays or changes your patch.** With two FM-1s plugged in, the one set to GLO › SYSTEM › EDITOR › IGNORE (a test rig, say) could press the editor's patch buttons over MIDI and switch on the Harmonizer you never turned on; F, G, H and J then picked chords instead of playing notes. The editor now asks every FM-1 on USB whether it is set to IGNORE, and plays nothing from one that is: no notes, no buttons, no knobs. It asks once this site may use the FM-1 link (after Connect FM-1), and again when an FM-1 is plugged in. Every other FM-1 still plays the editor as a MIDI controller, linked or not, and its patch buttons press the editor's. The FM-1 emulator's MIDI port plays nothing unless the editor is connected to it (#1045).
- **A scope of what you hear, at the top of the sidebar.** The Sound design sidebar starts with an Output scope: the Scope module's screen showing what the speakers play, with its waveform, spectrum (FFT) and spectrogram (Gram) modes, its window and its scale, without adding a Scope or a cable. While you listen to one signal on its own, it shows that signal. It is as wide as the sidebar; drag the line under it to make it taller or shorter. Its ▾ button folds it to its title, as **Output scope** in **Commands** does, and opens it again. This browser remembers its height and settings; nothing is saved in the patch or sent to the FM-1 (#1029, #1040, #1048).
- **Make presets for your patch from candidates.** Right-click a candidate (or use ⋯ while you hear it) and choose **Store as a preset of** an engine: the candidate's sound for that engine, with its FX rack's settings as Store as a preset keeps them, becomes a new preset of the same engine in the patch you are working on, without switching to it. To keep several at once, keep them and choose **Store kept candidates as presets** (⋯, right-click A or any candidate, or the command palette); each is named after the candidate. A candidate whose engine is built differently is skipped, and the status line says which. Ctrl/Cmd+Z takes the new presets out again (#1031).

## 1.18.3 — 2026-11-17

- **Mutate leaves an instrument's volume and its set-up switches alone.** Mutate, Randomize and Make candidates no longer change an engine's output volume (Monolith D's VOLUME, for example, could drop), nor Monolith D's A-440 reference tone, an engine's poly/mono, unison and voice assignment, or its keyboard octave (#1020).
- **Shortcuts work while a sidebar control has the focus.** After you chose a patch from the patch picker, Option+M, `/` and the other shortcuts did nothing until you clicked elsewhere. Now only a text field you are typing in keeps the keys (#1023).
- **A press on a row's name sets the slider.** On an engine card, pressing a row's name opened its rename box, so you could not set a low value by pressing near the left end of the bar. The name is now part of the slider; rename a row from Rename… in its ⋮ menu (#1025).

## 1.18.2 — 2026-11-17

- **Mutate and Make candidates stay in tune and make fewer, better changes.** Mutate, Randomize and Make candidates leave pitch alone: tunings, ratios, and the values that feed a pitch, such as an Offset or a Selector's notes. Turn on **Mutate pitch** in **Commands** to let pitch move, but only by octaves, fifths and fourths, to whole-number ratios, or by a few cents; the browser remembers it. Mutate now moves about one row in four (at least two) instead of every one, and flips a switch or changes a choice with a chance equal to the amount. With nothing selected, Make candidates moves only the rows the cards show, not the insides of assemblies. A row of an engine with factory presets sometimes takes one of its presets' values. With two or more snapshots marked keep, Make candidates breeds the new ones from them: each card comes from one keep, then a light Mutate (#1006).

- **See what each card costs of the FM-1's CPU.** In the editor, every card's header shows its share of the FM-1's audio time; a card in a poly group shows what one voice costs (for example "1.2 %/v"), and a collapsed assembly shows the total of everything inside it. Open the FM-1 budget at the bottom right for every module listed by cost or by name; click a row to select its card. The figures are estimates (hover one for how they are made), so when a patch does not fit you can see what to cut (#942).

- `m1emu cpu` plays a bank of your own patches (`--bank FILE`), holds the keys you choose (`--keys`) for as long as you choose (`--settle`), runs the transport (`--mt-run`), and reports the audio interrupt's mean (`isr_us`) beside each module's time. `npm run cpu-costs-emu` uses them to make a CPU cost table on the emulator's timing model, with a cost for each module type's code fetched cold. The editor's CPU estimate does not change: the emulator's table misses the test rig by more than the estimate allows (docs/measurements/2026-11-16-cpu-table-emu.md) (#959).

## 1.18.1 — 2026-11-16

- **Mutate and Randomize, to find sounds you would not reach by hand.** Select cards and press Alt+M (Option+M on a Mac), or pick Mutate or Randomize from a card's ⋯ menu or the command palette. Mutate moves each parameter by up to ±10 % of its range (the palette's Mutate amount sets 5, 10, 25 or 50 %); Randomize puts each anywhere in its range. A frequency or a time moves in octaves, a parameter that plays between two values stays between them, and values keep to their steps and the FM-1's ranges. On a collapsed assembly the rows its card shows move. Lock a parameter in its ⋮ menu, or a whole card in its ⋯ menu, and it stays; a padlock marks it. Main, the Output, the voices, Steps, the Arpeggiator, Drum maps and the Harmonizer never move, and a level never rises above its default, so nothing turns suddenly loud. Each Mutate is one undo step, the notes keep sounding, and a connected FM-1 follows (#944).
- **TIDY and FIT have shortcuts: Alt+T and Alt+Z** (Option on a Mac), listed in the command palette and the shortcuts card (#987).
- **Audition a sound with the same notes every time.** In the editor, the new phrase group beside the keys plays a test phrase: a held note, staccato hits, a chord, a run across four octaves, or a two-bar drum pattern on the kit's Drum map rows, always at 120 bpm and velocity 100. Pick the root note and octave, and turn Loop on to repeat it. Press Q or ▶ PHRASE to play it, and again to stop. Each snapshot switch (Alt+B) starts the phrase again from the top, so every version hears the same notes. "↺ Use my last take" in the phrase menu turns what you just played on the keys, the on-screen keyboard or a MIDI keyboard into My take, a test phrase that plays it exactly as you played it. It stays in this browser until your next take replaces it.
- **Save the sound as a WAV file.** ⤓ WAV beside the keys renders the test phrase, played once, to a 44.1 kHz stereo WAV. ● REC records what the editor plays while you play, and a second press (■ SAVE) saves it. Nothing is limited or normalized, so the file holds what the engine makes, and the status line gives its peak level. The file name carries the patch's name and the date.
- **Snapshots replace A/B: take as many as you like, and compare any of them with what you are working on.** Shift+Alt+B (Shift+Option+B on a Mac) takes a snapshot of the patch; snapshots are lettered A, B, C… as you take them. Alt+B (Option+B) goes to the next one, then back to the current patch with your latest edits, then round again, so a single snapshot is enough to A/B against your work, and switching never loses it. A strip at the canvas's bottom left shows the snapshots and Current: click one to hear it; each shows how many changes it is from the current patch. Right-click a snapshot to name it, make it the current patch, save it as a patch or remove it. Notes keep sounding through a switch when only values differ, as with A/B before, and a playing test phrase starts again from the top. A snapshot never changes: if you tweak while one plays, your tweaks are kept as a new snapshot when you switch away. The first Mutate of a run keeps the patch before it as a snapshot, "before mutate", so the original is always one Alt+B away. Snapshots stay with the open patch in this browser and survive a reload; opening another patch forgets them, and they never go into the patch file, a share link or the FM-1.
- **Rank and cut: breed candidates, judge them by ear, drop the losers, go again.** Alt+N (Option+N on a Mac) makes 4 candidates, new snapshots that each Mutate the patch on screen at the Mutate amount (the selected cards, or every card; locks hold; Commands sets 2, 4, 6 or 8), and plays the first. With a test phrase looping, press Alt+K to keep the one you hear or Alt+X to mark it cut; either moves on to the next. Shift+Alt+X cuts every marked loser in one undo step. Then show a survivor and press Alt+N again. The strip ticks kept snapshots, strikes out cut ones and shows what each candidate came from (←B). Snapshots you take by hand are candidates too.
- **Hear any signal on its own.** In the editor, Alt-click (Option-click) an output or a cable to listen to just that signal instead of the whole patch, as you would put headphones on a jack; a card's ⋯ menu has Listen to … too. A chip at the top says what you are hearing; Alt-click again, press Esc or use the chip's button to go back to the Output. It plays at the Output's level through a limiter, the sum of the voices for a per-voice module, and only audio outputs can be heard this way (cable a control signal into a Scope instead). Browser only: the FM-1 plays on as before.
- **The Scope shows a scrolling spectrogram, and the Output card shows the patch's loudness.** The Scope's new Gram view draws the frequencies of each input over the last 5 seconds, the level as a colour, so you can see how a sound changes over a note. The Output card reads the Output's loudness in LUFS as the factory sounds are measured: the last 3 seconds and the total since you press reset, against the factory target for one key held.
- **Hear your patch as the FM-1 plays it, without an FM-1.** FM-1 engine in the editor's deck (or Alt+E, or the command palette) switches the sound to the FM-1's own engine, the firmware's fixed-point code running in your browser, and back, also while playing, so you can compare the two by ear. It plays what the FM-1 would get, edits included as you make them. The Scope, the meters and the moving sliders still follow the browser engine. It does not know the FM-1's processor limit: a patch over the CPU budget plays here but drops voices on the FM-1.

## 1.18.0 — 2026-11-16

- **The 808 Kit's rhythms play a fill-in while you hold FILL** (SEQ held, then FX held; the Steps card's fill button in the editor), as the TR-808's TAP played its fill-in rhythms. Each of the 12 rhythms has its own fill-in in its style, over the second half of the bar: tom runs, snare and clap rolls, a rolling bass drum for MIAMI BASS. It plays on patterns 2 to 24; pattern 1, the demonstration pattern each 808 Kit preset swaps for its own, stays as it was (pattern 2 is ELECTRO B, with ELECTRO's fill-in). Let go of FILL and every rhythm plays exactly as before. The 909 Kit's grooves (HOUSE, TECHNO A and B, ACID, JACK, GARAGE, ELECTRO, BREAKS) get fill-ins too: snare rolls ending on flams, and tom runs. A saved slot keeps its old kit; FACTORY RESET installs the new one.

- **Setting up an FM-1 takes two steps: the firmware, then the factory sounds.** The firmware now carries only the factory instruments that are unlikely to change: Monolith D, Silver Box, Expander S, Io 4, Algo Four, Cassia 1, Canvas, Shush 101, 808 Kit, 909 Kit and Verona Drum 1. The other factory instruments, every factory preset and the drum patterns are installed into the FM-1 right after the firmware, into flash the firmware never used. The Install panel does it while "Install factory instruments and presets (recommended)" is ticked, as it is by default; its progress bar then covers both steps, names the one under way, and is full only once the factory sounds are installed. `tools/fm1_install.py` does it unless you add `--no-factory`. Factory presets and those instruments can now change without a firmware update: when the editor connects to an FM-1 whose factory sounds are missing or older, it offers to install them in one click. Until they are installed, the FM-1 plays its built-in instruments and says FACTORY SOUNDS MISSING: CONNECT TO MATRYOSHKA.LOL. Your saved slots, presets and patterns are never touched. FACTORY RESET puts back every factory instrument the FM-1 has. The firmware has more room for new features.
- **Wanderer, Sallen 20 and Vernon 100 have the whole effects rack: Drive, Chorus, Delay and Reverb.** Wanderer gains Chorus, and Sallen 20 and Vernon 100 gain Reverb. **Cassia 1 gains Drive** beside its own chorus, Delay and Reverb, at its four voices. Each new effect starts off, so every factory preset sounds as before; turn it on from the FX page. A slot you saved keeps its own version.
- **Shush 101's arpeggiator follows the tempo.** The modulator has a MOD SYNC row: on TEMPO, the modulator runs on the FM-1's tempo (global or the patch's, or MIDI clock), one cycle per note length on the new DIVISION row, so the arpeggiator, which steps on it, plays 16ths at Init whether or not the transport runs. FREE runs it at RATE in hertz, as before. Init and the factory presets are on TEMPO except Wind, which stays on FREE; presets you stored keep FREE. Any LFO can do the same: synced, with its `bpm` at the bottom (TEMPO), it runs on the FM-1's clock, and its sync switch now reads FREE / TEMPO.
- **Shush 101 bends and picks notes as the SH-101 does.** BEND VCO is now the lever's whole pitch bend, from none at 0 to an octave at the top, as on the original; before, the lever always bent 2 semitones and BEND VCO added to them. Init and the factory presets start at 2 semitones, so they bend as before, and a preset you stored keeps the bend it had. The bend also no longer moves the filter through KYBD. ENV TRIGGER now sets the note priority too, as on the SH-101: GATE+TRIG plays the last key you hold, GATE and LFO the lowest. A Voicing has a `priority` input for this, beside `assign` and `unison`; a patch that uses it needs this release's firmware.
- **A Resonator's ring dies away on the FM-1 as it does in the editor.** On the FM-1, a patch with a Resonator (the gamelan, kalimba, marimba, glass bell, tabla, tom and rim assemblies, the 808 Kit, Meridian 8) went on ringing quietly for ever after its first note, 50 to 95 dB below full scale, the loudest for long decays; and a long DECAY rang longer than set (5 s rang for 7.4 s). Now a ring falls to silence at its DECAY in both, and the FM-1's ring stays within 1 dB of the editor's to about 60 dB down at the longest decay, then ends a little sooner. In both, a note at another pitch while the Resonator still rings keeps the ring's level; before, the level jumped up or down by an amount that depended on the interval and on where in its cycle the ring was (#840).
- **A Phaser falls silent on the FM-1 when its input stops.** With its FB up, a Phaser on the FM-1 (Meridian 8's SYS channel on MOD, or one you patch) kept a small steady level after the sound ended, up to about 77 dB below full scale: mostly a fixed offset, at high CENTER settings a faint tone. Now it ends at exact silence, a little before the editor's ring fades below the FM-1's quietest step. The editor's Phaser changes too, so both stay alike, by less than you can hear (#969).
- **A resonant filter's ring dies away on the FM-1 as it does in the editor.** On the FM-1, the Multimode filter, the Ladder (Moog and diode modes) and the Formant filter could keep a quiet tone or a small offset going for ever once their input stopped. It was loudest with high resonance at low cutoffs, up to about 55 dB below full scale. In the factory sounds it was 85 to 100 dB down: Hera 6, Io 4, Verona Drum 1's snare, Briefcase 3. Now the ring falls to silence as in the editor. While a filter has input, it plays as before (#969).
- **Reverb and Delay tails die away on the FM-1 as they do in the editor**, in patches and on the FX page. A long Reverb (a large SIZE) kept a quiet hiss of its tail going for ever after the last note, about 80 to 100 dB below full scale, and a Delay with its feedback past the middle kept repeating its last faint echo for ever. Now the Reverb's tail follows the editor's down to its end and stops, and a Delay's echoes keep fading until they are gone. A frozen Reverb still holds. The Delay's quietest echoes end a little sooner than before (#969).
- **A String's or a Comb filter's ring dies away on the FM-1 as it does in the editor.** On the FM-1 a String (the pluck, bowed string, kalimba and rim assemblies) or a Comb filter could hold a quiet ring for ever, from about 50 dB below full scale for high notes with long decays to about 100 dB down, and a long String decay stopped falling about 65 dB down. Now the FM-1's ring follows the editor's down to about 96 dB below full scale and then stops. A String or Comb filter takes somewhat more CPU on the FM-1 (a plucked string's worst block about 12 % more) (#969).
- **With two FM-1s on one computer, the editor asks which one to link, and remembers your choice.** Connect FM-1 lists each FM-1 by the name you gave it in Name & USB playback, else by the end of its serial (older firmware: by its place in the list); the registered test rig shows as "Test rig" and is never linked without asking. The next connect goes straight to the FM-1 you chose; Choose FM-1… in FM-1 & MIDI asks again. The status line and the Connect FM-1 button name the linked FM-1. Install firmware installs only on that FM-1, and with two FM-1s and none chosen it installs nothing and says why. With one FM-1 nothing changes.
- **Turn each effect on or off without opening the FX card.** In the editor, the collapsed FX card has a switch for each of its effects (DRIVE, CHORUS, DELAY, REVERB, the ones the patch has), filled while that effect is on. A switch does what the effect's ⏻ does inside the opened card: one undo step, and a connected FM-1 follows. It shows the same state as the FM-1's FX page. The card dims the settings of each effect that is off, so you can see at a glance which ones you hear; they stay editable. Open the card to change the effects' settings.

- `tools/m1_link.py bank-info` and `bank-clear` work again on an FM-1 with the pattern store (1.17.0): they walked 64 bank slots, while that FM-1 has 60 and refuses the rest, so `bank-info` ended with "no answer from the FM-1 to command 0x15" and `bank-clear` with "bad offset or size". They (and `bank`) now take the slot count the FM-1 reports, as the editor does, and `bank-clear` asks before it erases (`--yes` skips the question) (#955).

## 1.17.0 — 2026-11-15

- **The FM-1 factory bank starts with Monolith D.** The FM-1 opens Monolith D at its first boot and after FACTORY RESET, and the editor opens it on a first visit; Oracle V comes second. Perun 4 and Spokes 6 leave the bank and stay in the editor's Community section beside their XLs, unchanged. An update leaves your saved slots as they are; FACTORY RESET installs the new bank.
- **Meridian 8's channels can ring or stop short:** each channel has a DECAY and a RELEASE row, how long its power takes to fall while its key is held and after it is let go. A DRIVE row in the OUT section sets how hard both output saturators are driven. At their starting values the patch sounds as before. The five presets now differ in length too: Broken Beat is clipped short, Lo-fi Hip Hop and Tonal Percs ring out, and Industrial's bacid and cympath hang on. A saved slot keeps its old version; FACTORY RESET installs the new one. A preset you stored for Meridian 8 keeps its values, and its new rows start at their starting values.
- **Verona Drum 1's knobs move like the Vermona DRM1 MKIV's.** The kick's ATTACK now shapes its click, from a short tick to a wider push, instead of setting its level. PITCH on KICK, DRUM 1 and DRUM 2 covers the original's range (22–380 Hz, 18–300 Hz and 24–430 Hz). The kick's BEND only sweeps down, and a DRUM's FM INT is off at its lowest. A saved slot keeps its old version; FACTORY RESET installs the new one. A preset you stored for Verona Drum 1 keeps its other settings; these seven rows start at their defaults.
- **Shush 101, after the Roland SH-101, joins the factory bank** as its 21st patch. Its card has the SH-101's panel: the modulator (triangle, square, random and noise), the VCO with its range, pulse width and PWM source, the source mixer with the sub oscillator's three modes and noise, the 24 dB filter, the envelope with its VCA and trigger switches, portamento ON / OFF / AUTO and the bender's VCO, VCF and LFO MOD amounts. ARP plays the patch's Arpeggiator, which steps on the modulator's clock as the SH-101's does: the modulator's RATE sets its speed, not the FM-1's tempo (about 8 Hz plays 16ths at 120 BPM; tempo sync comes in 1.18). The PATTERN track stands in for its sequencer. Chorus, Delay, Reverb and Drive are on its FX page. It comes with eight presets. After the update the FM-1 adds it to an empty slot; FACTORY RESET puts it in slot 21.
- **Verona Drum 1's clap sounds like a clap with REVERB turned down.** Each clap is now a short, bright burst of noise, so the claps snap on their own and the reverb adds its tail on top. Before, a low pulse played beside the bursts and buzzed. Its NOISE knob sets the claps' level and starts higher. A preset you stored for Verona Drum 1 starts the clap's NOISE at its default.
- **The 808 Kit plays the TR-808's 12 basic rhythms, each with its A and B variation, and the 909 Kit has twelve patterns of the styles the TR-909 shaped, with its fills.** Each kit has a song that chains them. Pattern 1 is the kit's own; patterns 2 and up are factory patterns the FM-1 keeps in its firmware, which the kits link, so the sets fit in the patch. The editor's Library › Patterns lists them as factory patterns. Edit one and SAVE: your version goes into the pattern store as a new stored pattern under the factory pattern's name, and the kit links it. A saved slot keeps its old kit; FACTORY RESET installs the new ones. Older firmware plays pattern 1 in place of the linked patterns.
- **Steps notes can play only on some passes: trig conditions.** A note can play while you hold FILL (or only while you do not), on the first pass, on pass A of every B (1:2 to 8:8), after the last condition on its track held (PRE) or on the track before it (NEI), or the opposite of any of these. On the FM-1's SEQ page, hold a step and turn K4; the bar names the condition and its cell gets a blue corner. FILL is SEQ held, then FX held, for as long as FX stays down. In the editor, set a step's condition in its popover (right-click the step), press T / Shift+T in the piano roll, and hold a Steps card's fill button. A patch with a condition needs this firmware (patch format 60).
- **Algo Four gets Drive back on its FX page, beside Chorus, Delay and Reverb, and 20 new factory sounds, 27 in all besides Init**, after the Yamaha DX100: electric pianos (a percussive one from the DX100 manual's programming example and a dusty lo-fi one), a harpsichord-like piano, bells and a marimba, slap, sub and plucked basses, backing brass, glass, evolving and string pads, a combo organ, a lute, koto and clav, two leads, and wind and chime textures. Five follow Yamaha's DX27/DX100 programming guide. Each sets Algo Four's effects for its use, and as many voices as keep the FM-1's CPU in budget: two for the basses and leads, three to five for some others, six for the rest. Drive starts off. Lately Bass and Amber EP get back the drive they had in 1.14; Combo Organ, Backing Brass, Dusty EP, FM Clav and Feed Lead are driven too. Solid Bass, Slap Bass and Sub Bass stay dry on purpose. A saved Algo Four slot keeps its old version; FACTORY RESET installs the new one.

## 1.16.0 — 2026-11-15

- **Patterns can live on the FM-1 outside the patches, and any patch can load them.** On the SEQ page, SEL held + SAVE saves the pattern you are on into the FM-1's pattern store, FX held + SAVE saves a new copy, and SEL held + PRESET loads stored patterns into the pattern you are on. A patch keeps its pattern 1 and points to its stored patterns, so a pattern costs it 3 bytes instead of its notes, and a patch with many patterns fits. Saving over a stored pattern changes it in every patch that uses it. P-locks come along only into a patch with the same modules. The editor's pattern library lists, loads, saves, renames, deletes and exports stored patterns, and shows the factory drum patterns too. The store takes room from the bank, which now has 60 slots: at the first start, patches in slots 61 to 64 move to empty slots (an FM-1 with more than 60 patches keeps 64 slots and has no pattern store until you delete one). Patterns already in your patches stay where they are.
- **The poly factory instruments get Chorus, Delay and Reverb on their FX page, and as many voices as the FM-1 holds with every effect on.** Each new effect starts off. A saved slot keeps its old version; FACTORY RESET installs the new ones.
  - **Algo Four** plays six voices (four before), with Chorus, Delay and Reverb in place of Drive, Delay and Reverb. Its Lately Bass now plays dry, and Amber EP has a light chorus in place of its drive.
  - **Oracle V** plays four voices, with Chorus, Delay and Reverb in place of Drive and Chorus. Sync Lead trades its drive for a short echo; Vintage Strings and Poly-Mod Bell add a room.
  - **Cassia 1** plays four voices, with Delay and Reverb beside its own chorus, in place of Drive and Delay.
  - **Expander S** plays all four of its voices (three before), with Drive, Chorus, Delay and Reverb.
  - **Io 4** adds Reverb to its Drive and Delay.
- **The CPU estimate is closer to the FM-1 when you add voices.** The editor read too high as voices were added to the poly factory instruments; it now follows the test rig's measurements at several voice counts. Hera 6 at six voices reads 86 % (the FM-1 measures 84 %; it read 94 %), Oracle V at five reads 84 % (the FM-1 82 %; it read 87 %), Algo Four at eight reads 84 % (the FM-1 80 %; it read 86 %).
- **Canvas's envelope decays in a straight line**, as the Buchla Music Easel's does. Env L/R has a new CURVE setting (exp or lin) for its falling segments. A patch that uses lin needs FM-1 firmware 1.16 or newer.
- **Hera 3 is now Hera 6, named after the Juno-106, and plays four voices** (three before). It keeps the Juno-106's number, as Oracle V keeps the Prophet-5's. Delay and Reverb join its own Chorus; Brass, Strings and Glass Pad use them. A factory update leaves a saved Hera 3 slot as it is; FACTORY RESET installs Hera 6.
- **Expander S's envelopes work like the Oberheim SEM's:** attack, decay and sustain, with the decay also setting the release. The two release rows are gone from its card. The ADSR has a new ADS switch for this. A patch that uses it needs FM-1 firmware 1.16 or newer. A preset you stored for Expander S keeps its other settings; its release now follows its decay.
- **An oscillator can start each note at any point of its cycle.** The Oscillator has a new PHASE setting, 0 to 360 degrees: a rising edge on its SYNC input restarts the wave there instead of at the start, so a gate on SYNC can begin every hit of an FM drum at the modulator's peak, as the Vermona DRM1 does. At 0, its default, it plays as before. A patch that uses it needs FM-1 firmware 1.16 or newer.
- **Verona Drum 1 is the whole Vermona DRM1 MKIV:** all eight channels (DRUM 2 and HI HAT 2 join), each hi-hat's TRIG switch, the clap's NOISE COLOR, MULTI's PITCH 2 and 3 turning off at their lowest, each DRUM's FM starting every hit at its peak, and both hi-hats closed on G4 and A4, as the original's second MIDI notes. The Drum map rows now follow the panel: KICK, DRUM 1, DRUM 2, MULTI, SNARE, HI HAT 1, HI HAT 2, CLAP. It needs FM-1 firmware 1.16 or newer. A preset you stored for Verona Drum 1 keeps each channel's settings; a factory update leaves a saved Verona slot as it was, and FACTORY RESET installs the new one.
- **Meridian 8 is the whole Landscape NOON:** its card has the NOON's controls. Each channel has its two sliders, its volume, its MOD button (a second mode for each circuit) and its mute button. There are nine two-way LINK buttons and the main volume. It also gains the touch plates, played by aftertouch, and the key's velocity as the gate's voltage. DOT and BACID filter at every sample, and CYMPATH is a three-voice cluster. It plays what Meridian 8 XL plays, still centred on both sides. The NOON's patch points (gate 1 to 8, odd and even CV, audio in) and the CV mute buttons stay in Meridian 8 XL. A preset you stored for Meridian 8 keeps each channel's settings; a link above zero turns its button on. A factory update leaves a saved Meridian slot as it was, and FACTORY RESET installs the new one.
- **The 808 Kit is the whole Roland TR-808:** all eleven voices (the mid and high tom and the cymbal join), each tom's TUNING and tom / conga switch, the rim shot / claves and hand clap / maracas switches, the ACCENT row with its LEVEL, and PRE-SCALE. The mid tom, high tom, cymbal and accent are on G4, A4, B4 and C5. As on the TR-808, only the accent row accents; a step's velocity no longer does, and the demo patterns put their accents on that row. A preset you stored for the 808 Kit keeps its settings, its low tom tuning moved onto the new TUNING knob (seven semitones either way); a factory update leaves a saved 808 Kit slot as it was, and FACTORY RESET installs the new one.
- **Briefcase 3 has the EMS VCS3's whole pin board:** all 256 pins, where it had the 120 control pins. They sit on 16 Matrix devices beside Briefcase 3, each named for the pins it holds ("AENP 1-4": columns A, E, N and P of rows 1 to 4); on the FM-1, SELECT reaches each and ALGO picks a column. The panel gains the output pans, the joystick's range knobs and the oscillators' full frequency range; an output's level now stops at silence, and its filter is flat in the middle. Out of the box it sounds exactly as Briefcase 3 XL did. To make room, its effects rack has no drive (chorus and delay stay): Buzz Lead loses its hard clipping. A preset stores the panel, not the pins. A preset you stored for Briefcase 3 keeps its settings, its frequencies moved onto the new dials; a factory update leaves a saved Briefcase 3 slot as it was, and FACTORY RESET installs the new one.
- **The 909 Kit is the whole Roland TR-909:** all eleven voices with their knobs (its own clap and rim with LEVEL, the open hat with its DECAY, three toms with TUNE, LEVEL and DECAY, the crash and ride with LEVEL and TUNE), TOTAL ACCENT, FLAM, SHUFFLE and SCALE, named and ordered as on the TR-909's panel. Row 8 is the high tom (the TR-909 has no cowbell). The mid tom, crash, ride and the ACCENT row are on G4, A4, B4 and C5; a flam of the kick, snare or a tom is the black key above it. One DRUMS track plays them all, so one LAST STEP sets every row. A preset you stored for the 909 Kit keeps the kick's and snare's tune, the kick's attack and decay, the snare's snappy and the closed hat's decay; the rest start at the new kit's settings. A factory update leaves a saved 909 Kit slot as it was, and FACTORY RESET installs the new one. The `<7PH` example keeps its own lean 909 kit, which no longer shares the 909 Kit's presets.
- **Scrounge is the whole neutral labs Scrooge:** each row has its own Steps track (VOICE 1 to VOICE 5, MOD X and MOD Y), so each can loop over its own length, and LEN GLB, a master length after which every track starts again. Each voice gains SLEW and MELT on its curve, a TILT / FLAT switch (FLAT is the Scrooge's flat gate: the curve holds at the step's POKE for the gate), and A-B and X-Y as three-way switches (A, A+B, B; X, OFF, Y); one VOL sets both outputs. A step's velocity is its POKE on every track. Its six grooves are now patterns 1 to 6 (Dusty Boom Bap first, the former Init groove last), and a CHAIN (song 1) plays them in turn; picking a sound on its card no longer changes the pattern. The keys still play every row. A preset you stored for Scrounge keeps its settings; a voice's A-B moves to the nearest switch position, and its X-Y starts at the new settings. A factory update leaves a saved Scrounge slot as it was, and FACTORY RESET installs the new one.

## 1.15.0 — 2026-11-14

- **The FM-1 uses both of its cores for every patch.** Before, the second core only helped patches with several voices. Now drum kits, monophonic instruments and effects share the work too. On the factory patches the busiest moment uses up to 23 points less of the FM-1's time: Verona Drum 1 76 % → 53 %, 808 Kit 76 % → 57 %, Canvas 86 % → 67 %, Meridian 8 60 % → 40 %. The sound is unchanged, bit for bit. The editor's CPU estimate counts the same plan.
- **A playing Steps track costs less.** A running track took about 135 µs of every 2.9 ms block on the FM-1; it now takes about 48 µs. With the transport running, the factory patches use 1 to 12 points less of the FM-1's time: Spokes 6 66 % → 53 %, Perun 4 52 % → 44 %, 808 Kit 63 % → 57 %. The sound is unchanged, bit for bit. The editor's CPU estimate now counts a Steps track as playing.
- **The Reverb's tail starts one block later.** A Reverb's lines now hear its input 128 samples (about 3 ms) late; the dry signal is on time. In exchange, the FM-1 runs the Reverb's lines on whichever core is free instead of after the voices: Briefcase 3 uses 6 points less of the FM-1's time (62 % → 56 %). Both engines sound the same.
- **The LED and key scan leaves more room for sound.** It took about 9 % of the FM-1's main core, part of it inside the audio's time; it now takes about 3.5 %. The busiest factory patches use 2 to 3 points less (Oracle V 74 % → 71 %, Cassia 1 75 % → 72 %). The LEDs and keys are meant to look and respond as before.
- **A moving filter costs less.** While the Multimode filter's cutoff input moves, the filter follows it every 4th sample instead of every sample: about 9 % less of Hera 3's work while its envelopes open and close the filter. The difference in sound is about 73 dB below the signal.
- **LFOs, envelopes and glides cost less.** They now work out their curve every 16th sample (0.36 ms) and draw a straight line in between: the LFO's sine, triangle, saw and random waves, envelope decays and releases, and moving glides. Square and sample-and-hold LFOs, attacks and held levels are unchanged. On the FM-1 the busiest moment of Cassia 1 drops from 72 % to 69 %, 8 Lire from 47 % to 44 %, Io 4 from 65 % to 64 %; a few patches with room to spare read a point or two higher (Spokes 6 52 % → 54 % with the transport running). In a blind comparison the difference could not be heard.

## 1.14.0 — 2026-11-13

- **Editable master FX:** ordinary assemblies provide the present stages in Drive → Chorus → Delay → Reverb order, without duplicating effects already exposed by an instrument. One Reverb adds a mono wet return while preserving stereo dry sound.
- The Effects shelf also offers `master FX` for custom patches, with stereo jack bundles and editable child stages. Unsupported helper-bypass edits retain ordinary module playback instead of being force-enabled by FX recognition.
- **MASTER FX on compatible new firmware:** SELECT chooses a present effect, K1–K4 edit its first page, SEL toggles it, and FX or HOME returns. Normal device pages keep the later parameters. Drive and Chorus ramp to dry; Delay and Reverb stop new input and spill tails, with a bounded two-second fade for sustained or frozen tails.
- A switched-off Delay or Reverb stops using CPU once its tail falls silent. Before, every Delay or Reverb that an earlier preset had switched on kept running at full cost, so stepping through presets could raise the FM-1’s load until it muted. Audible tails still spill unchanged.
- New melodic factory revisions put Harmony on LFO, initially off like ARP and the added effects. The Harmony light and FX stage rows show enabled state. Sallen 20’s SWITCH and Canvas’s PULSER move from FX to EDIT. Legacy patch button mappings are unchanged. The promoted controls use standard 500 ms Delay and single-stage Drive without oversampling; the underlying modules remain editable.
- Format 55 stores optional sparse master FX bindings and selects enabled-state lights for verified LFO/Harmony Toggles, even without an FX rack. Other patches keep their older compatible format. Portable graphs targeting 1.13 do not add the new firmware’s FX page, light or tail behavior.
- Firmware updates preserve saved patch bytes and names rather than replacing raw factory matches. Empty-store initialization, explicit factory reset, additions of new factory names to empty slots and saved assembly preset migrations remain.
- Archived factory and XL patches remain discoverable through Community with author and source under GPL-3.0-only, including originals whose names match differently configured selected defaults. Existing Community submissions retain CC BY-SA 4.0; relocation does not relicense data.
- FM-1 defaults exclude non-hardware-based examples: Init, Simple FM, Plucked String, Basic Poly, Drift Poly, Mono Lead, Supersaw Stack and `<7PH` remain editor-available. The composite `<7PH` patch data and hardware-derived drum/drone data are preserved.
- The owner-approved 22-patch bank now supplies normal browser defaults, numeric exports and firmware generation without retuning. Protected drum/drone patches keep main's current versions, including Verona Drum 1's per-channel PAN and the calibrated kits; the 909 Kit needs no output trim. Melodic sounds are calibrated to the factory loudness rule by gain alone; their timbre and effects are unchanged. Sallen 20 uses Drive + Chorus + Delay without Harmony. Hera 3 retains independent per-note filters and amplifiers. **Three factory synths play fewer notes than in 1.13.0, to make room for the added effects:** Algo Four plays 4 (was 8, as many as the Yamaha DX100), Expander S plays 3 (was 4, as many as the Oberheim Four Voice) and Hera 3 plays 3 (was 4; the Roland Juno-106 plays 6). Their 1.13.0 versions stay available in Community. Existing saved graphs remain authoritative; a legacy name-only Hera 4 reference resolves its archived original.
- Fmini-1-informed preset studies emphasize deliberate oscillator registers, distinct filter/amplitude contours and playable gestures, especially on Monolith D. All 110 melodic sounds received owner listening approval, including nine new lo-fi designs. The audition firmware passed 96 default-profile phases and 330 authored-sound phases without mute, shedding or late events, reaching 93.87% peak CPU without scoped exceptions. These finite development probes do not qualify arbitrary edits or the final 1.14.0 artifacts.
- **Synth and FX preset recall:** compatible single-instrument racks recall their sound and complete promoted FX settings together, including enabled stages. Init stays dry; legacy synth-only presets leave FX unchanged. Scoped transfers require the new firmware capability, not merely native format 55.
- Authored sounds ship in the read-only factory preset list without consuming user-store slots. Normal firmware generation includes the approved bank; the former `--selected-bank` opt-in is removed.
- Factory preset ROM values use lossless dictionary packing and sparse overrides. Recall expands into the existing preset buffer; stored presets, Q16 values and the audio path are unchanged.
- Loading an assembly preset respects that card's exposed parameter limits. A four-voice preset no longer raises a three-voice Expander candidate above its selected cap, and the untouched stored preset remains usable on a wider copy.
- Factory fitting evaluates explicitly shared filters, contours and amplitude articulation before further voice/FX cuts. Sharing is an audible articulation compromise, not a transparent optimization.
- Canvas candidates retain their full patch-field choices with shorter PRESS/SEQ/ENV/RND1 legends, fitting Harmony/Steps/Arp without a new binary format or audio-path change. Additional FX still require separate resource qualification.
- Multimode, Ladder and Diode filters skip redundant cutoff-coefficient work when modulation depth is zero: a Multimode filter keeps its fixed-cutoff coefficients while its CV depth is zero, and the Ladder takes its audio-rate FM path only while its CV amount is nonzero. The output samples are bit-identical (#806; the non-exact 8/16-sample coefficient updates it proposes remain open). Live depth changes retain their normal modulation, saturation and self-oscillation behavior; no parameter-rate or sound-model restriction is introduced.
- Reverb uses constant-index feedback writes, caches slow-sine table endpoints with exact audio-rate interpolation, and reuses exact decay coefficients while effective size/freeze remain unchanged. Analog FM oscillators without feedback or sync choose their waveform once per block. Native differential checks retain identical samples and DSP state, including live controls, freeze tails and oscillator-mode transitions. Neither change lowers modulation rate or sound quality; MCU savings require rig measurement.
- Chorus reuses exact sine endpoints and separates its two taps. Nonlinear multimode filters cache only the reciprocal seed division while retaining the current denominator in every sample's refinement. Quantizers reuse results only for identical consecutive input within a block; Steps skips inactive gate-timer scans, and a stopped Steps track with nothing to play skips its per-sample loop (bit-identical; about 12,600 counted cycles a block, the idle track cost Canvas about 145 µs a block on the FM-1). Native differential checks cover live controls, clock transitions, key events and DSP state without restricting their sound or update rates.
- Multimode filters specialize single-output LP12/HP6 routing and fixed linear MIX-only routing without changing their state equations. Phase-distortion oscillators skip unused resonance-ratio calculations and specialize an unmodulated alternate-bend path. Native differential checks retain identical connected outputs and persistent state across routing and control transitions; hardware qualification is separate.
- The editor's CPU estimate follows the faster single-output filter and fully wet Chorus and Reverb paths, and charges a choice moved by a cable at its costliest setting.
- Reverb uses exact 32-bit damping products for fixed delay taps, including its first two taps when modulation is off. Fully wet Reverb and Chorus omit redundant final mixing while preserving delay memory, modulation and freeze state.
- Native-rate Drive selects common single-stage softclip/fold and two-stage fold transfers once per block. Differential checks retain identical samples and persistent state across live mode, stage and oversampling changes; no controls or sound quality are removed.
- Oscillator phase-modulation sums reuse the same lane’s discarded-output scratch buffer, recovering 1 KiB of static RAM without reducing voices, effect capacity or the firmware’s memory safety margins.
- Emulator execution commands unpack `.fwsc` firmware packages before running them. The packaged-image boot/recovery gate now tests the app rather than decoding encrypted transport bytes as instructions.
- Fixed pan positions take less CPU on the FM-1 without changing the output samples.
- Verona Drum 1 has PAN on each of its six channels. Saved presets keep their control values and start with centered PAN.
- Firmware capability updates refresh Library budgets without interrupting an active bank transfer.
- Patches can use memory recovered by sharing signal buffers. In the [host allocation check](tools/buffer_budget.py), one patch uses 1,536 bytes of signal storage instead of 44,032, recovering 42,496 bytes for its effect lines. The editor follows the connected firmware's reported rule; older firmware and offline budgets stay conservative. Voice and CPU limits are unchanged. Host allocation checks, the focused emulator scenario and registered-FM-1 audio/timing qualification pass.
- Hardware CPU surveys clear the previous patch's cached diagnostic peak before committing the next patch, without discarding its first rendered block.
- Historical CPU calibration uses frozen released factory graphs, so new bank revisions are not compared against recordings of different patches. Counter checks skip structurally unencodable candidates without excluding candidates solely for a high CPU estimate.

- Experimental assembly capability inspector (`?capabilities=1`): inspect engine recognition and supported audio paths while editing, load design examples, and validate a dry-route bypass preview. The preview leaves audio unchanged.
- The experimental capability inspector shows current module names beside IDs and explains filter output labels. It distinguishes unmet engine/audio-path requirements from unimplemented Harmony, Arp and Steps performance recognition.
- Release-packaging checks preserve the host compiler's search path while isolating firmware build settings.
- Selecting a user preset in the editor loads its own values even when a factory preset has the same name, without replacing the drum pattern.
- Device scenario runs enforce and save EDITOR IGNORE on the test rig, check it around installs and scenarios, and stop if it cannot be confirmed.
- **Send saved assembly presets with a patch:** FM-1 & MIDI now offers “Send this patch’s presets” beside Send patch. It transfers saved assembly presets, including nested ones, asks before replacing FM-1 copies, and refreshes Library even after incomplete transfers. PRESET selects presets for matching device pages; nested assemblies have no separate page in that patch. Sending the patch itself still preserves its sound without copying preset lists.
- Expand the Monolith audition studies to seven composed effects treatments, each with a dry reference.

- Factory sound revisions soften 8 Lire’s Pair FM Bells and Feedback Howl, give Spokes more contrasting chord roles, and reduce prominent tonal percussion. The 909 and Perun demonstration grooves use their actual hat and snare lanes.

- Factory drum sounds carry distinct default patterns. Selecting another factory sound changes only an untouched factory pattern; saved user patterns stay in place. Factory sound banks add practical melodic and kit choices, reduce harsh drone settings, and correct final-output peaks in the audition phrases.

## 1.13.0 — 2026-11-10

- Harmonizer chords can feed Arpeggiator and Steps. Cable order chooses root recording or editable chord notes, including step recording with Side chord buttons. ARP inserts after harmony; unsupported keys routes show an explanation. These routes require firmware supporting patch format 53.
- **USB playback through your FM-1:** hear computer audio through the headphone output while recording the synth over the same USB cable. USB RETURN sets playback volume independently of MASTER; playback stays out of the recording.
- **Name your FM-1:** save a name from FM-1 & MIDI → Name & USB playback, then reconnect USB to apply it to the device’s USB name. Host apps may retain an earlier label. A serial from the flash chip identifies the unit and survives factory reset.

- **Piano-roll keys play notes:** outside step record, all 27 FM-1 keys play their own pitches. Stopped REC still starts step record. Drum and other eight-row instruments keep their step input.
- **Silent step recording:** during piano-roll step record, hold SEL and press FX to turn note preview off or on. The screen says SILENT when entry is quiet; notes are still written normally.
- **Oracle V CPU experiment (off by default, #808):** generated member functions keep their temporary storage out of one large stack frame, fixing the second-core startup stack overflow. A focused emulator check now watches the actual stack pointer while the compiled code runs on core 1. No added instrument capacity or hardware speed-up is claimed.

## 1.12.0 — 2026-11-09

### Editor and FM-1

- **Live edits stay in step with the FM-1:** a value change that changes the compiled module layout sends the whole patch before further edits. Arming, muting and focus changes wait for an upload to finish. The Harmonizer releases held keys correctly after its split moves, and extended chords follow every inversion step correctly.
- **Harmonizer module:** one key plays a whole chord on that root, after the Telepathic Instruments Orchid. Cable it between Main's keys and a Voicing. Its chord buttons are maj, min, dim, sus2, sus4, 7 and 9, and buttons held together combine (min + 7 + 9 is a minor ninth). On the FM-1 they are its seven lowest keys, at any octave: black keys 1 to 3 pick maj, min or dim, white keys 1 to 4 add sus2, sus4, 7 or 9, and every other key plays a root; the screen names the chord (CHORD: MIN7). From a MIDI keyboard they are the seven keys under the split (F3 to B3 as made). With no button held the card's own chord plays. LOCK keeps the chord so the buttons need not be held; VOICING moves it through its inversions. A patch with a Harmonizer is saved in format 52, which needs this firmware.

### FM-1

- **The supply as M-VAVE's own firmware sets it:** at power-on the FM-1 raises its core supply from 1.26 V to 1.38 V and another internal supply from 1.40 V to 1.60 V, in the stock firmware's order, as Melodee does, before the second core starts (#735). If that setup fails, the FM-1 starts on one core. The CPU clock is not changed. `tools/m1_link.py cpuclock` shows the levels.
- **The sound engine compiled for speed:** the code the audio interrupt runs (the render, every module, the mix, USB audio's copy) is built at -O2, the rest of the firmware for size as before. In the standalone #798 comparison, the image grew 531,088 → 546,236 B of its 581,564 B slot (CI measurement). On the rig, the combined batch against 1.11.1 took Verona Drum 1 from 85 % to 81 % and the 808 Kit from 83 % to 80 %, while Oracle V rose from 74 % to 78 % and Init from 21 % to 25 %. These are steady peaks across stopped and running playback at the existing voice counts ([measurements](docs/measurements/2026-11-09-rig-integration.md)). The editor's CPU estimate is recalibrated on all 30 factory patches.
- **The FM-1 plays what the editor plays when a patch holds modules no one hears:** the editor still leaves them out of what it sends, but no longer the ones before a Random module, a Steps track, a Shift register or an oscillator with analog, which take their randomness from their place in the patch. A P-lock on a module no one hears stays in the patch after you edit the track's locks on the FM-1, and an edit made while a patch goes to the FM-1 waits for it. Canvas sends four fewer modules: 3,759 → 3,730 bytes (the editor's count, #801).
- **Less memory touched per block, the same sound:** a patch's signal buffers are shared once nothing reads them any more. Oracle V renders through 63 buffers instead of 232 (116 KB → 32 KB), Algo Four 224 → 103, Cassia 1 227 → 92, all 30 factory patches 2,435 → 916 (host count, #800). Every patch that loaded still loads, and nothing more does yet.
- **Oracle V CPU experiment (off by default, #808):** with `ENG_AOT=1`, the FM-1 runs the Oracle V assembly from code made ahead of time instead of on its interpreter, bit for bit the same output. The CPU model predicts a lower peak, but the rig loses its second core when this experiment starts. It remains disabled; no hardware speed-up or added capacity is claimed.
- **Room for code that runs from RAM:** the #725 CI comparison increased free space after the effect memory's second line area from 96 to 1,484 B. The USB setup log (`tools/m1_link.py usblog`) keeps the last 64 USB requests and bus events, not 128, and an unused part of the flash driver is left out of the app.
- **A key pressed right after SEL arms a device plays.** A key in the same 3 ms as the arm was cut with the keys the old set held. The naive-owner simulator found it on `<7PH`, with DRUMS and PATTERN armed: key 1 was silent (#748).

## 1.11.1 — 2026-11-08

The same firmware format as 1.11.0: update the FM-1 and every patch plays as before, only with more room.

### FM-1

- **A faster engine, the same sound:** the envelopes, input sums, filter, Mixer and Math do less work for the same output, bit for bit. On the test rig, the steady peak of a busy patch fell: Briefcase 3 91 % → 76 %, Algo Four 87 % → 77 %, Verona Drum 1 83 % → 78 %, the 808 Kit 82 % → 79 %, Oracle V 78 % → 74 %.
- **Cassia 1 plays four voices again** (two in 1.11.0): 77 % on the test rig with all four, nothing dropped.

## 1.11.0 — 2026-11-08

A patch that uses something new in 1.11 is saved in format 51, which needs this firmware; an FM-1 with older firmware is told to update. Every other patch keeps the older format.

### FM-1

- **Hera 4 takes Hera 6's slot:** the Juno-106's whole panel (saw and pulse at once, the four-position HPF, chorus I / II, LFO delay, portamento, the hold pedal and more) with four voices, where Hera 6 had a cut-down panel with six. Hera 6 XL still plays all six in the browser. Your Hera 6 presets move to Hera 4.
- **Wanderer is the whole ARP Odyssey:** Wanderer XL takes Wanderer's slot (each VCO's saw and pulse at once, continuous coarse tuning, the ring modulator and S/H on the pulses), with a PATTERN track. Wanderer XL leaves the list.
- **Canvas is the whole Music Easel:** Canvas XL takes Canvas's slot (the patch field with a named source for each input, random voltages, pressure, the mod oscillator's dial, every switch named). It keeps the Arpeggiator but has no PATTERN track. Canvas XL leaves the list.
- **Oracle V plays like a Prophet-5:** both oscillators' waves at once, Poly Mod into frequency, pulse width and filter, Wheel-Mod's five destinations, velocity and aftertouch, unison, the Release switch. Four voices (was five); test rig 79 %.
- **Algo Four plays like a DX100:** eight voices (was three), all eight algorithms, the DX100's 64 frequency ratios and seven detune positions. Test rig 86 %.
- **Cassia 1 has more of the CZ-1:** a pitch envelope for line 2, velocity, key follow and level per line, glide, bend range, the mod wheel on vibrato, OCTAVE, and the stereo chorus. Two voices; test rig 64 %.
- **8 Lire has all 46 of the Lyra-8's controls:** FM source and structure switches, TOTAL FB, LINK, two delay lines, FAST, PITCH and VIBRATO. It is mono now, as the Lyra-8 is. Test rig 80 %.
- **Expander S gets the SEM's modulation:** FM and PWM from envelope or LFO, sync, band pass, a drone switch, portamento, octave, tune and assign mode. Still four voices.
- **Wanderer, Vernon 100 and Briefcase 3 get a PATTERN track** in front of the Arpeggiator.
- **Io 4 and Vernon 100 name every switch position** as on their panels (OFF / ON, COLOR, MODE LP / BP / HP / BR and the rest).
- **One key assign switch:** Io 4's POLY I / POLY II / UNISON I / UNISON II as one row, as on the Jupiter-4; Hera 4 gets the Juno-106's assign mode and Algo Four the DX100's POLY / MONO.
- **Filters closer to their originals:** the Multimode filter's drive (an MS-20-style scream in Sallen 20; gentler in Expander S, Vernon 100 and Hera 4), the Ladder's diode mode (Silver Box, Briefcase 3) and stage saturation (Monolith D, Oracle V, Io 4, Wanderer). Off in your own patches.
- **Analog oscillators:** a new ANALOG row gives an oscillator an analog VCO's small flaws, each voice its own. On in the factory instruments with analog VCOs.
- **Canvas's lopass gates close slowly:** open in 10 ms and close in 350 ms (both were 40 ms), as the Easel's vactrols do, so plucks ring out. The Slew limiter has a new FALL row for it.
- **Full parity:** in 1.11, Io 4, Vernon 100, Wanderer, Monolith D, Sallen 20 and Silver Box reach full parity on the FM-1, apart from hardware (#375).
- **808 Kit and Verona Drum 1 keep their 1.10 layout:** the 808's mid and high toms and Verona's DRUM 2 and PAN are in their XLs only; with them the FM-1 could not keep up.
- **Longer Delays:** a RATE row (44k, 22k, 11k) trades brightness for time: the longest Delay 1.9 s → 3.8 s at 44k, 7.6 s at 22k, 15.2 s at 11k. Changing RATE while it plays bends the echoes like a tape changing speed.
- **Tape on the Delay:** a TAPE switch darkens and saturates each repeat, a WOW row wobbles its pitch, and HEADS picks up to three playback heads.
- **The Delay costs less:** a plain Delay 1.3 % → 1.1 % of the audio time, with ping-pong 1.8 % → 1.4 %, the same sound bit for bit (the editor's CPU model).
- **Five effect assemblies:** envelope filter, ducking delay, gated reverb, overdrive and octave fuzz, each with four presets.
- **Granular follows the keyboard:** a new `pitch` input plays the grains in tune (C4 = the recording's own pitch).
- **Saving no longer cuts the sound:** SAVE 8.7 ms of silence → none, a preset store 11.0 ms → none, the settings record 5.8 ms → none (the test rig's USB audio). FM-1s with the UC25HQ80 flash chip still write as before.
- **Up to 128 modules a patch** (was 64). A patch takes what it needs from one 362 KB memory instead of separate fixed pools, so a patch without a Granular has room for more voices.
- **3.5MM OUT ON / OFF:** GLO › SYSTEM › 3.5MM OUT turns the speaker and the headphone jack off while a computer records over USB audio; MASTER still sets the level. Hold HOME + OCT- + OCT+ for 2 s to switch it from any page.
- **EDITOR ALLOW / IGNORE:** GLO › SYSTEM › EDITOR set to IGNORE keeps the editor from connecting to that FM-1 or installing firmware on it.
- **Play once with a count-in:** SEQ held + PLAY counts in one bar, plays the pattern or song once, then stops. REC's count-in clicks too (speaker and jacks only, not USB audio).
- **The tempo in the menu:** GLO › PANEL › TEMPO shows it, as `GLOBAL 120`, or `GLOBAL EXT` on MIDI clock.
- **Whole numbers look whole:** rows that move in whole steps show `2`, not `2.00`, and their knob clicks stay on whole steps.
- **Fix:** a settings save no longer cuts a hole in a Delay's echo.

### Editor

- **Arming reaches the FM-1:** with Live on, arming a device in the editor arms it on the FM-1 too (needs this firmware).
- **The CPU estimate reads the test rig:** refitted to the rig's survey of every factory patch, it now reads within 3 points below and 5 above it, where it read up to 20 points low (Spokes 6 66 % → 84 %, rig 84 %). A VOICES row stops at the most voices that stay at 90 % or under.
- **Smaller FM-1 patches (format 51):** default values, unchanged input depths and repeated names are left out, and a morph B side stores only what differs from A. The 50 factory, XL and community patches: 527 bytes less each in the first step, then 252,544 → 151,415 bytes in all. Lire + Elvira fits the FM-1 again.
- **The FM-1 knobs check boxes are gone:** they did nothing since the FM-1 became a patch player.
- **Two FM-1s on one computer:** notes and Start / Stop from an FM-1 the editor is not connected to no longer play anything in the editor.

## 1.10.1 — 2026-11-08

### FM-1

- **Newer FM-1s:** units with the UC25HQ80 flash chip (sold since autumn 2026) can store patches and install updates. Before, they showed NO FLASH ID: NO UPDATES (#739).

## 1.10.0 — 2026-11-06

### FM-1

A patch with a drone is saved in format 50, which needs this firmware; every other patch keeps the older format.

- **Dual core:** the FM-1 plays on both of its processor cores. Poly patches use 24–37 % less of the audio time, with the same sound bit for bit. INFO › PROCESSOR shows `2 CORES`.
- **Verona Drum 1:** a new factory drum engine after the Vermona DRM1 MKIV (slot 30), with five presets. Its hi-hats cut and ring in either order.
- **Effect memory:** a patch can have several Delays, reverbs, choruses, strings and Granulars, as long as they fit in 190 KB. Each Delay has a LENGTH, up to 1.9 s, set in the editor.
- **Drones:** a note or a whole row can hold for as long as the pattern plays. Make one on the SEQ page (LFO held + a note's own step, or LFO + FX for a row), or hold a note round the loop in a live take.
- **Mono output:** GLO › SYSTEM › OUTPUT sets STEREO, MONO or MONO L (MONO L is for one mono cable into a recorder).
- **Your presets come back:** presets you stored before an engine's controls changed (1.7.0 and 1.9.1) show again on today's factory patch, under their own names.
- **New factory patches reach an updated FM-1:** each goes into an empty slot, never over one of yours, and the bar says where.
- **Improved on-device controls discoverability:** hints for the tempo, arming, layered sounds, drum keys, step record, patterns and songs.
- **Fixes:** no dropout after a tempo change; an engine no keys reach says so on SEL instead of arming silently.

### Editor

- **Store to an FM-1 slot** lists all 64 slots with their names, and picks the first empty one.
- **Effect memory** in the FM-1 budget, with each Delay's LENGTH row.
- **Drones** in the Steps card and the piano roll (L, and Shift+L for a row).
- **Sandbox mode** plays a Drum map on the FM-1's black keys.
- **New community patch: Babushka** by fairplay, a Benjolin-like Rungler (#663).

## 1.9.1 — 2026-11-04

### FM-1

- **Even loudness:** every factory patch and preset plays at about the same loudness, and none clips.
- **Level row:** every engine has one (`level`, `volume` or `vol`). Presets you stored yourself for 11 of these engines stay with the patches you stored them on and don't show on the new factory patches yet; a later update brings them over.
- **Cassia 1:** shorter row names (`wave`, `rate`, `depth`, `delay`, `res`) to make room for `vol`.
- **Controls sheet:** SEL reads "arm only this", with a new row "ENV then SEL arm several".

### Editor

- "Delete with its modules" also deletes nested assemblies, and one Undo brings them back.

## 1.9.0 — 2026-11-03

### FM-1

The patch format is 49. Older patches still play, and the editor offers an FM-1 on older firmware the update.

- **P-locks:** a step can set any row of the device its track plays, such as cutoff or decay, to its own value on that step. To make one, hold the step, ALGO to the device's page and turn a knob.
- **Matrix:** a new module with 4 inputs and 4 outputs. Each input-to-output pin runs −1..1. On the FM-1 it shows as a grid, with one page per output.
- **Modulation scaling:** a route's depth reaches ±2, and "Play between two values" can use an LFO's full swing.
- **New modules:** the Shift register (a Turing Machine and a Rungler in one), Range, and the Comparator.
- **Phase modulation:** the Oscillator gets `pm2` and `pm3` plus an `index` input. Its `pm` goes up to 16.
- **LFO:** a smooth `random` wave, and the wide range now goes up to 80 Hz.
- **Module names:** a module you name in the editor shows that name on its page header, in capitals, up to 12 characters.
- **Controls sheet:** a new row order and new wording. HOME is the way out of a Page button's list. Hint lines use the sheet's words, and PLAY held + PRESET sets the tempo in the settings menu too.
- **`NO KEYS REACH THIS DEVICE`:** SEL shows it on an engine no keys cable reaches, poly or mono, and arms nothing.
- **SEQ page:** a white key switches its step when you let go of it, and not if you turned a knob while holding it.

### Editor

- P-locks in the Steps grid: right-click a step to add them, and a step with locks gets a dot.
- Rename any module.
- Route depth is shown in the parameter's own units ("+2 oct"), and typed values stay exactly as typed, fractions included.
- The controls strip under the Emu view's copy of the FM-1, showing what the controls do right now.
- The Emu view stays on the FM-1's page, with no flicker.
- The ? help card is built from the same table as the FM-1's controls sheet.
- The editor refuses to arm an engine no keys reach.
- 8 Lire XL no longer clicks when it opens.

## 1.8.4 — 2026-11-03

### Editor

- The ? help card's "On the FM-1" rows match the FM-1 again: HOME goes to the device's first page, then the patch's home page, and held alone does nothing; PRESET steps the focused device's presets and HOME + PRESET the patches; GLO opens the settings menu in tabs (MIDI, PANEL, SYSTEM, INFO, GUIDE); REC on the SEQ page starts step record while stopped; the piano roll's SELECT moves 8 pitches (SEL held: one). New rows for step record and SEQ held + a black key (mute). The Library's empty-bank text and the GLO and SEL hints in the button editor say the same.

## 1.8.3 — 2026-11-02

### FM-1

- The FM-1 works with an iPad as a USB MIDI device and as an audio input (44.1 kHz) (#536, #537). Tested on iPadOS 26 through a USB hub (it need not be plugged into the wall), with a USB-C cable from the hub to the FM-1: MIDI Wrench saw its MIDI port and its MIDI, and Reel recorded from it (68 s without a dropout). Apps that need 48 kHz, such as Voice Memos, do not list it. A USB-C to USB-C cable straight into the iPad does not work. For this the FM-1's USB interfaces come in a new order: audio control, then the audio input, then MIDI (before, MIDI sat between the two, and the iPad showed neither the audio input nor a MIDI port), and the FM-1 asks for full speed USB only. Update mode is unchanged.
- Step record on the SEQ page (#532), on the piano roll and the drum grid: with the transport stopped, tap REC to start on the first step of the page shown (step 1, or step 17 when steps 17 to 32 are shown), or hold REC and press a white key to start on that step (this works while the transport plays too). The bar says STEP and the step, the cursor's column is lit, and so is REC. Play a note or a chord: it sounds, and letting go of the last key writes it on that step (replacing what was there) and moves on one step. Tap LFO for a rest; press LFO while keys are held to tie the keys still held onto the next step. Hold FX for an accent (velocity 127, else 100). K4 moves the cursor without writing, black key 10 steps back and clears that step, OCT- / OCT+ change the octave, and past the pattern's last step the cursor wraps to step 1 (the page follows it past step 16). It works stopped and while the transport plays. During a live take, REC held + a white key ends the take and starts step record on that step. PLAY in step record starts the transport and goes on as a live take, as on the M-VAVE firmware. REC stops it (HOME and SEQ too). On a drum grid black keys 1 to 8 write their rows. On the SEQ page REC no longer starts the transport while it is stopped: for a live take from a stop, press PLAY then REC (or REC then PLAY). On every other page REC is as before. The editor follows each step as it is written. Before, the FM-1 could only switch steps one row at a time or record live. In the editor's FM-1 tab, the keys held on a drum grid and in step record now sound too.
- The FM-1's piano roll moves 8 pitches at a time (#546): SELECT shows the next or previous 8 pitches (C3-G3, then G#3-D#4 and so on), and the bar names the pitches shown after the track's name. Hold SEL and turn SELECT to move one pitch at a time. Hold SEL and press any key, white or black, to jump to that key's pitch: this now works in step record too, where it writes nothing (before, it wrote the note out of sight and SEL's release opened the SONG page). The selected row keeps its place on the screen and its black key. Before, SELECT moved the selected row a pitch a click and scrolled only at the edge, so reaching another octave took up to 12 clicks; now it takes 1 or 2. The small marks over and under a step still show notes above or below the pitches shown.
- The FM-1 sends MIDI clock over USB (#473), so a DAW, a synth or a second FM-1 can play in time with it. It sends 24 clocks a quarter note all the time, at the tempo it plays (the global tempo, or the patch's when TEMPO is PATCH), so the other gear has the tempo before you press PLAY. PLAY's Start and Stop go out as before, and the Start comes together with the first clock of the bar. GLO > MIDI > CLOCK OUT (K4) turns the clock off; it is on as made. With MIDI OUT off, nothing goes out. While MIDI clock comes in and drives the FM-1, it sends none of its own, and half a second after that clock stops it sends its own again. Measured on the test rig against a Mac at 120 and 300 bpm: the time between two clocks was never more than 0.44 ms off (0.24 ms on average), with the transport running or stopped; before, the FM-1 sent no clock. Saving on the FM-1 pauses the clock for about 40 ms, as it pauses the sound.

### Editor

- Every module output says its signal's range (#518): hover an output jack or a cable. An LFO gives −1..1 (times depth), an envelope 0..1, a pitch 1 per octave with 0 at middle C, an oscillator ±1 times its level, a gate 0 or 1; an Offset, Attenuverter or Math works it out from its settings.
- The Scope's screen can be read (#518): one scale for both traces, gridlines labelled with their values, the time per division, and a scale button (auto, ±1, ±4; auto fits the traces and labels the scale it chose). Under the screen each input shows its lowest and highest value, peak to peak, and its source with that output's range. The screen is 96 px tall, 64 before.
- Comment boxes on the canvas, like Max comments (#518): right-click the empty canvas or use the palette's Add comment. They are moved, resized, selected, copied, deleted and undone like cards, saved in the patch, its link and its .json file (a link without the layout leaves them out), and never sent to the FM-1.
- The editor no longer follows MIDI clock that comes from an FM-1, so a connected FM-1 sending its clock does not change the editor's tempo (#473). Clock from other gear still drives the editor as before.
- While the editor follows a connected FM-1, its transport follows the FM-1's own Start and Stop, and the editor no longer starts the FM-1's transport by itself (#549). Before, the editor's copy of the FM-1's panel could read a press differently from the FM-1 and send the result back: after SEL held + a key on the SEQ page (or REC held + a key), the FM-1's next REC started the transport and a live take instead of step record, and REC held + a black key on a device page started the transport while it only arms.
- With Live on, a change that leaves the FM-1's patch as it is no longer sends the whole patch to the FM-1 again: adding, editing or moving a comment, moving a card, any change to the layout only. The editor compares the patch as the FM-1 would get it with what it sent last.

### Testing and diagnostics

- The FM-1 keeps a log of the last 128 USB requests and bus events since it was powered on (#535, #537), so a computer or tablet that fails to set it up can be diagnosed from another: `tools/m1_link.py usblog` reads it. It only watches; nothing the FM-1 sends over USB changes.
- The scripted emulator and test-rig checks no longer start a second emulator beside a run, and the tie checks no longer fail now and then on a hit that runs past the end of what they measured (#520, #521, #529).

## 1.8.2 — 2026-11-01

### Editor

- The Multimode is now called Multimode filter, on its card and on the FM-1 (#513). It is the state-variable filter with low, band and high pass outputs, called Filter until 2026-10-22.
- Searching for a module finds it by what it does and by its old name: "filter" lists the Multimode filter and the Ladder, "high pass", "hp" or "state variable" find the Multimode filter, and "scale" or "glide" find the Attenuverter and the Slew limiter (#513).
- Library > Presets sends a Cassia 1 preset to the FM-1 whole, all 118 rows (#485). An FM-1 with older firmware is not sent a preset of more than 88 rows: the editor says "Update the FM-1 to store this preset on it". A Cassia 1 preset the FM-1 stored before 1.8.2 loads the 88 rows it has, the rest keep their values, and the status line says how to fix it; Library > Presets marks such a preset "88 of 118 rows".

### FM-1

- The Delay no longer clicks when its time changes, on the FM-1 and in the browser (#484). 8 Lire's `lfo → delay` was the loudest case: its Hyper LFO is a square wave, so every edge jumped the echo by up to 350 ms. Now the echo glides to the new time and its pitch bends while it moves (at most an octave down or a fifth up). Turning the Delay's time knob, Perun 4's LFO on the delay time, the morph and a synced Delay's new tempo glide too. Measured on both engines' renders of 8 Lire with both HOLDs up, the Hyper LFO at 5 and 7.3 Hz and `lfo → delay` at 1.5 (golden kit `lire-hyper-delay-1`): the largest jump at a time change fell from 0.78 to 0.03 of full scale, the size of the sound's own steps; sharp steps over 0.05 fell from 98 to 12 a second (26 with the LFO off). A time that holds still plays exactly as before. While the time moves, the FM-1's Delay takes about 1.6 % more of its CPU (counted on the CPU model, `npm run cpu-costs`).
- 8 Lire no longer clicks when a patch or preset opens with HOLD up, such as Eight Drone and Feedback Howl (#515). The drone used to start at full level on its first sample, and one voice started 3 ms after the others. Now HOLD fades the drone in over 30 ms, and all eight voices start together. Measured on both engines' renders of 8 Lire opened with both HOLDs up: the largest jump in the first 100 ms fell from 0.46 of full scale to 0.03. With the Delay fix above, sharp steps over 0.05 fell to none. HOLD's two smoothing modules add about 1 % to 8 Lire's CPU on the FM-1 (38 % → 39 %, CPU model). Untouched 8 Lire slots in the bank get the new patch at the next start-up.
- A vibrato costs the oscillators much less: they work out their pitch every 8 samples instead of every sample, with a straight line in between (#461). Io 4's Ensemble Pad keeps its vibrato and plays four notes without dropping a part: before, it dropped one at four and at eight notes in 3 of 3 runs; now four notes average 79 % of the audio block (77 % without the vibrato, 82 % before), with no drop in 3 of 3 runs (test rig, docs/measurements/2026-11-01-rig-io4-vibrato.json). A pitch that holds still sounds exactly as before.
- Storing a Cassia 1 preset on the FM-1 (ENV held + SAVE, or from the editor) now keeps all 118 of its rows (#485). Before, it kept 88 and loading it left the other 30 (line 2's envelopes, its tuning, two Scale `gain` rows) as they were. A preset of more than 88 values takes two of the store's slots, which now hold 58 (60 before), so that a power cut while the FM-1 tidies a full store cannot leave it refusing to store presets. Presets you already stored stay as they are. A Cassia 1 preset stored before this release still has 88 values: loading it sets those rows and shows `STORED SHORT: SEE EDITOR`; store it again to keep all its rows.
- The FM-1 no longer drops an occasional message from the editor (#486). About 1 message in 500 was lost while the transport ran: on the test rig, 8 of 4,000 TEST_PEAK requests went unanswered (1.8.1, transport running). Any message could be lost this way, such as a parameter change, a focus change, the tempo or a stored preset, and the editor and the FM-1 then disagreed without saying so. After the fix, on the same rig with the transport running: none of 8,000 requests went unanswered, and in a second run none of 20,000 messages was lost (16,000 of them parameter changes). DIAG pages 117 and 118 now count the link's messages in and out.

## 1.8.1 — 2026-11-01

### Editor

- With Live on, turning SELECT or ALGO on the FM-1 no longer sometimes moves the editor one device or page further than the FM-1, which left K1..K4 in the editor on a different device from the FM-1's (#504). The FM-1 tab's copy of the panel stays on the FM-1's page too.

## 1.8.0 — 2026-11-01

### FM-1

- Clearer control hints: the SEQ page names OCT for steps 17 and up (#490), shows a held step's knobs and fits SEQ+REC clear again; PRESET on a module says HOME+PRESET changes patches (#450).
- The FM-1 teaches its controls (#450): after power-on a quick start card shows the knobs (HOME closes it, HOME + SAVE turns it off, GLO > SYSTEM > QUICK START turns it on again), and OCT- + OCT+ pressed together open a controls sheet for the page you are on, with a second tab of what every button does everywhere (ALGO switches tabs, SELECT scrolls, HOME closes; the keys and PLAY keep working). OCT- and OCT+ now act when let go, so pressing both changes nothing.
- The settings menu's MANUAL tab is now GUIDE: it explains the ideas behind the FM-1 (patch, preset, device, engine, track, pattern, song, arming, the environment, Live, sandbox mode) and leaves the controls to the controls sheet (#450).
- When a control can't act, the header says why (#450): a patch button with nothing to do in the patch ("EDIT: NOT USED IN PATCH"), PRESET with an empty bank ("BANK EMPTY"), OCT on a SEQ page of 16 steps or fewer ("ALL 16 STEPS SHOWN"), SEL on a Drum map that no keys cable reaches ("NO KEYS REACH THIS DEVICE", #215), and SAVE, REC, SEQ, ENV and SEL in sandbox mode ("SANDBOX: SEQ IN EDITOR"; they still go to the editor). In sandbox mode with MIDI OUT off, the header says "TURN ON MIDI OUT: GLO, K3". ENV in the settings menu now opens the environment, and HOME comes back to the tab you were on.
- The FM-1 tells the editor which version of Matryoshka it runs. When it is older than the version this site comes with, connecting says both versions and offers Update. From this release the FM-1 identifies itself as `FM-1_7` plus two digits each for major, minor and patch (1.8.0 is `FM-1_7010800`), so versions such as 1.10 fit (#216); the installers still recognise 1.0 to 1.7.
- Sandbox mode looks like any device page (#325): the header shows the editor's device, page group and pages with their dashes, and the footer turns gold with SANDBOX where the patch name goes, plus the browser's tempo, the octave and the battery. The gold band, the "3/5" line, the page rail and the BROWSER PLAYS line are gone. PLAY held + PRESET now sets the tempo of the patch playing in the browser; before, it changed the muted FM-1 patch's tempo and PLAY's release could start or stop the browser. Until the editor's first page arrives, the knobs change nothing, so they no longer edit the muted FM-1 patch.
- One tempo for every patch: GLO > PANEL > TEMPO is GLOBAL as made, so changing the patch (PRESET, program change, the editor) keeps the tempo you set with PLAY held + PRESET or on Main's page. The FM-1 remembers it without SAVE, about 5 seconds after the last change once the transport is stopped. Each patch still keeps its own tempo: TEMPO PATCH plays it, as before. Patches made around a tempo, such as `<7PH` at 124, play at the global tempo unless TEMPO is PATCH.

### Editor

- FM-1 & MIDI > Tempo: Global (as made) or Patch, the same setting as the FM-1's and shared with it while connected. While Global, the browser, MIDI clock out and the FM-1 tab play one tempo whatever patch is open, and Main's tempo row is labelled `global tempo`. Older firmware gets the global tempo as the patch's while Live is on.
- A/B is back in the editor: Set snapshot A, Set snapshot B and Switch A / B snapshots in Commands, or Alt+B (Option+B on a Mac). A flip keeps the canvas where it is (cards, frames, the view) and takes the other version's name. When only values differ (parameters, attenuverters, bypass, macro ranges, Steps notes) the browser and, with Live on, the FM-1 change them in place, so notes keep sounding; anything else loads the other version whole.
- A patch opened with Live on now opens on its first instrument on the FM-1 too. Before, the editor kept the last patch's device in focus when the new patch had one with the same internal number (Main always does), so the FM-1 could open the new patch on Main (#496).

## 1.7.1 — 2026-10-31

### FM-1

- PRESET on Cassia 1 now sets all 118 card rows. Before, only 88 were set, so line 2's envelopes and tuning kept the previous preset's values (#464).
- The FM-1 drops a voice when the audio actually glitches: an average load over 90 %, or a late audio block twice within 2 s. Before, it waited for two busy blocks in a row, so a patch could click about once a second without it stepping in (Oracle V's Poly-Mod Bell at five voices: about 80 % on average, every 32nd block up to 101 %; measured on the test rig) (#458).

### Editor

- Connect FM-1 works when macOS shows the FM-1 under another name, such as "Felucca". If it still can't find it, the message lists the MIDI ports it sees, and a SysEx block says where to allow it (#187).
- `<7PH` no longer shows as over the FM-1's memory in the editor (3,894 of 3,840 bytes before, 3,840 now, as on the FM-1). The drum kits' velocity inputs show as jacks instead of sliders that did nothing (#465).
- A preset that changes the voice count no longer keeps part of the previous preset's sound (#470).
- Emulator view: black keys 1 to 8 play a Drum map's rows 1 to 8, as on the FM-1 (#467).
- Expanding an assembly moves the cards around it out of the way instead of covering them (#206).

### Installing

- A firmware package whose first byte happens to be `<` (about 1 build in 256) is no longer refused as a web page.

## 1.7.0 — 2026-10-30

### tl;dr
1.7 contains the last big changes of the badly-needed redesign of FM1 controls:
- Turning the preset knob alone now changes engine preset rather than changing the engine.
- To change the engine, hold HOME and turn the preset knob. Don't sleep on this, there are a fuckton of engines
- The global settings menu, the info screen, and the manual now live under GLO alongside the midi settings that were already there.
- HOME on a params page now takes you back to that device's first page. Press it again to go to the home page of the patch.
- **Count-in before recording:** GLO > PANEL > COUNT-IN, 1 or 2 bars. Recording always starts on a bar.

1.7 also replaces the placeholder presets for each engine with five well-thought-out patches per engine, many of them based on the factory presets from the instruments they were modeled after.
- Every preset for every engine was audited for distortion caused by CPU overload as well as clipping. On the rare occasion that the CPU threatens to fuck with your sound, the patch will preemptively decrement polyphony instead, dropping one voice until the patch is loaded again.

### Full 1.7.0 changes

### Quality of life

- **Knobs feel better.** A turn back no longer jumps 5 clicks at once. HOME held + a knob turns in fine steps. A click glides over 23 ms, so levels and cutoffs no longer zipper.
- **Screens draw faster:** a page reached by SELECT / ALGO in 103 ms instead of 124.
- **Delay reaches 700 ms** on the FM-1, up from 520.
- Elvira 2's `drone` and 8 Lire's `hold` turn in steps of 0.01, not 0.08.
- **Arming on the FM-1 shows in the editor,** and the editor draws arming as the cables the keys really travel.
- **PRESET's first turn reaches a real preset** instead of loading INIT again.
- **Values are rounded, not cut off:** one click from 0 reads 0.01, not 0.00.

### Presets, and an audit of every factory sound

- **Every engine has five hand-written presets,** named for what they're for: Fat Bass, Vintage Strings, Acid Squelch, Tight Techno, and so on. They replace the rule-made Bright / Dark / Pad set.
- **Four new factory patches:** Basic Poly, Drift Poly, Mono Lead and Supersaw Stack. They appear after FACTORY RESET.
- **Nothing in the factory set clips anymore.** Every factory patch and preset was played with all its voices and patterns going. The ones that clipped were turned down, so some patches are quieter than before.
- **The heaviest presets were trimmed to fit the FM-1's CPU,** after measuring them on a real FM-1 with 1, 4 and 8 notes held:
  - Oracle V's Poly-Mod Bell plays 3 voices.
  - Io 4's Unison Lead has no vibrato.
  - Drift Poly's Slow Pad and Analog Strings play 6 voices.
  - Oscillators with moving pitch (vibrato, glide) cost less.
  - Io 4's Ensemble Pad can still drop a voice at 4 notes.
- Idle voices no longer all wake in the same block.
- **Cassia 1 reaches its resonance waves.** Its rows now match the Casio CZ-1's: named waves, a real "off" for wave 2, and the CZ's four line modes. Presets you stored for Cassia 1 on the FM-1 no longer match it.
- **Factory fixes reach your FM-1.** An update now refreshes untouched factory slots whenever the factory patches change, and says FACTORY PATCHES UPDATED. Slots you edited and saved are kept.
- **Loading a preset no longer pushes a patch over the FM-1's size limit.** A few long knob names were shortened to make room.
- The `step sequencer` assembly is gone: a Steps track, a pattern or the Arpeggiator does its job. Patches that hold one still play.

### Installing

- **Restore Official Open:** an FM-1 set up with M-VAVE's Official Open can go back to it from M-VAVE's own file, and from there to V15.
- The installer checks which start-up software the FM-1 has and won't send a package it would refuse.

### Fixes

- A filter's cutoff no longer wraps from 20 kHz to 20 Hz at the top of the knob.
- A message to the editor is no longer cut off half-way when the computer stops reading the FM-1.
- A return to stock that was cut off finishes with the package it was writing.

## 1.6.0 — 2026-10-28

### Changes

- **On the FM-1, SEL arms what the keys play** (#395). SEL on a device page arms that device and disarms the others,
  so the keys play it; an instrument whose keys come through a track and an Arpeggiator (every factory instrument) is
  armed with them, and REC records that track. On a device with no keys input, or an Arpeggiator alone, the bar says
  NOTHING HERE TAKES KEYS and nothing changes. In the editor, arming an instrument works the same way. SEL on an armed device's page
  disarms it again (the others stay armed; the last one out leaves the keys wired). SEL on
  an environment row adds that device to the armed ones or takes it out (a layer or a split); REC there no longer arms.
  With nothing armed the keys are wired: Main's cables decide where they go, as before, and
  the footer says KEYS WIRED after the patch's name. A patch loads wired. The SEQ page arms the track it shows when it
  opens and when ALGO picks another. SEL no longer opens the SEQ page (SEQ does), a row's device pages, or an
  assembly's preset list; a device's presets are still stepped with PRESET or ALGO on its environment row. On the SEQ
  page the track line's SEQ+REC: CLEAR hint no longer fits next to ARMED.
- **On the FM-1, REC records the same way on every page** (#395). With the transport stopped, REC starts it and
  records; running, REC records; REC again stops recording and the transport goes on. PLAY stops both. What records is
  every armed Steps track, over the notes already there, and a track armed while REC is on records from then on (ALGO
  on the SEQ page included). REC never changes the page: it no longer opens the SEQ page, and SEQ is the only way
  there. With no track armed REC still runs and the bar says REC: NO TRACK ARMED. On a drum grid a black key now always
  sounds its row and picks it, and while recording it also records the hit; SELECT moves the row silently. On the piano
  roll, all 27 keys play and record while REC records, and the black keys pick rows otherwise. Gone: REC with nothing
  armed recording hits from the black keys, REC on the SEQ page while stopped, and REC arming the roll's track itself.
- **On the FM-1's piano roll the black keys pick the rows, not the track** (#387). Black keys 1 to 8 are the 8 pitches
  on screen, black key 1 the bottom one, and they follow the window as SELECT scrolls it. With the transport stopped
  the row picked sounds, with REC on or off; its black key is lit, as on the drum grid. ALGO picks the track. Before,
  black key n switched to track n, so in a one-track patch only the first did anything. SEQ held or REC held + a black
  key still mutes or arms track n, and a live take still plays all 27 keys.

### Patches

- **8 Lire XL's TUNE is continuous,** as the Lyra-8's knob: each `tune` row is an Offset into its voice's pitch, ±4
  octaves in hundredths of an octave (12 cents), from the voice's own tuning. It stepped in semitones before. The default
  sound is unchanged (rendered sample for sample); the XL has 151 modules (143) and an estimated 146 % CPU (144 %).
- **Meridian 8 XL's gate inputs take any voltage,** as the NOON's: the inputs `gate 1`..`gate 8` power their channel
  directly, after its mute button, so an offset, a held gate, an LFO or an oscillator there drones the channels that
  hold a sound (DOT, for one) with no key held. The keys still play the channels as before. The default sound is
  unchanged (rendered sample for sample); the XL has 180 modules (172) and an estimated 148 % CPU (143 %).

### Fixes

- **Choosing what an assembly's card shows: a switch row's check box no longer covers its name.** On rows with
  named positions (a Selector, such as Io 4's ASSIGN or LEGATO) the name now moves right of the box and gets more of the
  row, as on a slider's row (#342).
- **Space after clicking Octave down / Octave up starts the transport again.** The button no longer keeps the focus
  after a click, so Space no longer pressed it a second time. Reached from the keyboard, it keeps the focus (#208).
- **Ties on the FM-1's drum-track grids, and ties that reach (#368).** On the SEQ page, LFO held + a white key now
  ties a note on a track that plays a Drum map, as it already did on the piano roll. A Drum map row stays up while its
  note sounds, so a tie holds a voice that sustains, such as a Lire plate or an Elvira voice. On both grids the tie
  now reaches: the row's last note before that step is extended to end on it, so one press ties step 1 through step
  16 (before, the key only tied the note sounding on the step before). LFO + a step inside a note ends it there, and
  LFO + its last step makes it one step again (before, a tied step cut the note before it). With no note before the
  step the bar says NOTHING TO TIE; a tie does not run across the end of the loop. The grid draws a tied note's steps
  dim and joined, and a white key on a step a tie runs through cuts the tie there and starts a hit. Notes made longer
  in the editor's piano roll now show their length on the FM-1 too.
- **Held black keys on the FM-1's drum grids (#368).** On a drum track's SEQ page a black key now sounds its row for as
  long as it is held, not as a one-step hit, with REC on or off and the transport running or stopped. With REC on and
  the transport running it records a note lasting the whole steps it was held (at least one), on the nearest step, the
  same way a live take records melodic notes. The white keys still place steps while REC records.
- **Wording: cursor entry and step write.** The editor's recording with the transport stopped (the keys held together
  fill the cursor's step) is now called cursor entry, in its tooltips and help. Placing steps with the white keys, on
  the FM-1 or on a Steps card, is step write.

## 1.5.1 — 2026-10-27

### Fixes

- **The editor starts about three times faster.** It no longer works out, as the page loads, every factory patch, the
  FM-1 budget of every patch in the Open picker, and the presets of every XL. A factory patch is built when it is first
  opened. The picker's FM-1 · NN % and SANDBOX chips are worked out after the page is up, while it is idle (all of them
  at once if the picker is opened first); they read as before. The factory presets of an engine are made when an engine
  of that structure is first shown. Structure fingerprints and the patch check no longer compare every cable with every
  other one. The Library's Patches section is drawn when it is shown, and remembers which patches fit the FM-1. Measured
  in headless Chrome on the built site, empty browser storage: on an M-series Mac, the page was ready
  (DOMContentLoaded) after 0.33 s (1.22 s before), with 0.56 s of script (1.13 s); with the CPU slowed 4× and a
  9 Mbit/s, 70 ms network, after 1.69 s (4.21 s), with 1.03 s of script (2.98 s). With a browser that holds 50 saved
  patches, a 64-slot bank and 20 library assemblies, mostly in the 1.3 and 1.4 formats, and an XL open: 0.47 s
  (1.42 s) on the Mac and 1.98 s (4.90 s) slowed. Script time is counted until 4 s after load, so it includes the
  chips worked out while idle (all but a few of them in the slowed run with stored patches).
- **The browser tab's icon is 12 KB** instead of the 841 KB full-size logo.

## 1.5.0 — 2026-10-27

Figures compare this release with 1.4.2. Unless a line says otherwise, an FM-1 figure is the editor's estimate:
modules and patch bytes from its budget, CPU from its CPU model, both run on each version's factory patches.

### Fixes

- **The FM-1 no longer stalls when it is plugged into a computer where no app reads its MIDI.** Each message for the
  editor (a step entered, a knob turned) waited up to 0.2 s for USB room there, as in 1.4.2. Entering steps quickly
  then froze the screen, the LEDs and the keys for seconds, and the sound cut out. On the test rig, with a build from
  before the fix (Elvira 2, sequencer running, steps entered by hand), the main loop's longest pass took 7.46 s. Now a
  message waits at most 0.05 s. Once one has waited that long with nothing read, the next ones are dropped at once,
  until the computer reads again; the editor syncs when it connects. In the emulator, after 30 steps entered with
  nothing reading, the SEQ page closes in 140 emulated ms (2,890 before). The final version is tested on the host, in
  the emulator, and by hand on the test rig.
- **USB MIDI keeps consecutive editor messages in order** instead of dropping one that arrives while the one before is
  still pending. Entering sandbox mode sends LIVE paused before its first page, so the FM-1 mutes and receives that
  page together.
- **Turning VOICES past the available memory keeps the last playable setting.** Cassia 1's fifth voice could exhaust
  the engine's memory, leaving the row at −1 and the instrument silent. A failed edit now restores the patch, shows NO
  ROOM and does not send the rejected value to the editor. Reloads pause audio while the engine is rebuilt. Checked
  with the host panel test; not yet checked on a device.
- **The patch-bytes budget counts the panel buttons' record.** A patch whose ARP, FX or LFO button is not a plain gate
  sends 9 more bytes than the editor counted. So a patch within 9 bytes of the 3,840 limit passed the budget and was
  then refused by the FM-1. The budget now equals what is sent (in 1.4.2 Oracle V showed 1,266 bytes and sent 1,275).
- **Inserted assemblies keep their macro ranges** (#367). Saving and inserting an assembly no longer turns a bounded
  macro control into ordinary added modulation. Each inserted copy keeps its own ranges. A round-trip test checks both
  the rendered sound and that editing one copy leaves the others unchanged.
- **Morph leaves modules without a B side untouched on the FM-1,** as the browser does (#355). The patch now records
  which modules morph. Patches stored on the FM-1 before keep how they play when they are loaded and upgraded.

### FM-1 instruments after their originals' panels

Each of these was tested on the host (both engines), not yet on a device, unless the entry says more.

- **Silver Box is the Roland TB-303.** An accented note (velocity 115 or more, or a Steps accent) runs the filter
  envelope at its shortest decay, 200 ms. That envelope times ACCENT lifts the level and, through the accent sweep
  circuit, the cutoff. At high RESONANCE the sweep is smoother and builds up over consecutive accents, as the
  original's second resonance gang does. ENV MOD no longer scales the accent. The soft clip after the filter is gone
  (the 303 has none), and so are the slide, drive and amp decay rows: the slide time and the volume envelope's decay
  are fixed, as on the original. WAVEFORM is a named SAW / SQUARE switch. TUNING spans ±5 semitones and no more, as
  the TB-303's TUNING knob (±500 cents in its owner's manual), with no detune in the middle of the row
  ([D-702](docs/ledger/fidelity.md#D-702)); it was the oscillator's coarse tune, ±4 octaves in semitone steps. The
  cutoff row is CUT OFF FREQ, as on the panel. The patch's Steps tracks have the 303's pattern memory, pattern
  chaining with transpose and song mode (see Steps below). It comes with four demo patterns in the 303's style: acid
  lines with accents and slides, the fourth in the 303's triplet mode (12 steps of 1/16T). A song chains them with
  shifts, and the editor names the patterns as the 303 does (I-A1 .. IV-B8). Pattern 1 stays empty, so the keys still
  play it as a synth and PLAY alone plays nothing: choose the song on the FM-1 (SEL on the SEQ page, then K4 right) or
  with SONG on its card. Still missing: MIX IN, the external audio input. FM-1: 14 → 20 modules, 886 → 1,234 patch
  bytes, CPU 17 → 20 %. The copy inside `<7PH` keeps a plain waveform row and the one-semitone tuning to fit: `<7PH`
  takes 63 modules (60), 3,839 bytes of 3,840 (3,776) and 65 % of the CPU (67 %). The patterns and the song were
  tested in the emulator.
- **Monolith D has the Minimoog Model D's panel.** Its card holds the original's controls under their names: TUNE and
  a half-octave PITCH wheel, GLIDE with its on / off switch, OSCILLATOR 3 CONTROL (oscillator 3 off the keys, for a
  slow modulation source), RANGE as the six footages LO to 2', the WHITE / PINK switch, KEYBOARD CONTROL off, 1, 2 or
  both, the DECAY switch (each contour's release takes its decay time, or the note stops at once) and the A-440 tone.
  WAVEFORM has all six positions on each oscillator: triangle, the triangle / saw hybrid (oscillator 3: reverse saw),
  saw, square, wide and narrow rectangle. The modulation switches now switch. The modulation mix comes from oscillator
  3 and the noise before the mixer's volumes, so a silent noise or a quiet oscillator 3 no longer weakens it. FILTER
  MODULATION runs at audio rate and no longer depends on the contour amount. Gone: the drive, release and scope rows,
  which the original lacks. The switches show their positions by name. Still missing: the external input. FM-1: 18 →
  37 modules, 1,372 → 3,094 patch bytes, CPU 23 → 37 %.
- **Sallen 20 is the Korg MS-20.** The highest held key plays (the MS-20 mini's manual). VCO 1 and 2 have SCALE as
  footages and their own WAVEFORM switches (VCO 1's noise, VCO 2's narrow pulse and ring modulator in place of the
  ring row). MASTER TUNE, EG 1's DELAY and EG 2's HOLD are new. Each filter has its own MG/T.EXT and EG2/EXT amounts
  (the high pass had no MG amount, and the low pass's MG depended on its EG amount). The MG's frequency modulation
  reaches the oscillators' pitch, not just their fine tune. The MG's WAVEFORM knob sweeps continuously from falling
  saw through triangle to rising saw and changes the pulse width, with its triangle and rectangle out at once. The
  high pass falls 6 dB per octave below its cutoff, as the MS-20's does (it was 12 dB), so more low end passes. Both
  filters self-oscillate, so the PEAK knobs scream at the top, as on the MS-20. The soft drive after the low pass is
  gone. Its ESP (External Signal Processor) section is there: the ESP's rows, its amplifier, band-pass, F-V CV,
  envelope and trigger outputs, and VCO 1+2 CV IN, TRIGGER IN and INITIAL GAIN to patch them into, as the MS-20's
  manual does. The FM-1 has no audio input, so a SIGNAL IN row picks what the ESP hears (VCO 1, the noise or the MG).
  An ESP ROUTE row patches one of its outputs: F-V into VCO 2's pitch, ENV into the initial gain, or TRIG into both
  EGs. Both start OFF, and then the patch sounds as it does without the ESP. The patch panel's sections are the
  assembly's jacks, to patch in the browser: the sample and hold (white noise, clocked by the MG's rectangle), white
  and pink noise, the MVCA (EG 1 on its control), both envelopes' normal and reverse outputs, the control wheel (the
  mod wheel), the momentary switch (the FX button, labelled SWITCH), KBD CV and trigger, the MG's triangle and
  rectangle, INITIAL GAIN (a row) and `esp signal in` (it adds to SIGNAL IN's choice). Unpatched they leave the sound
  as it was. The scale and wave switches show their positions by name. Still missing: the ESP's external input and
  repatching on the FM-1 itself. FM-1: 19 → 48 modules, 1,425 → 3,098 patch bytes, CPU 29 → 45 % (the ESP always runs
  on the FM-1).
- **Io 4 has the Roland Jupiter-4's panel.** Its card follows the owner's manual, one row per control: the VCO's
  range, sub oscillator, LFO mod, pulse width (four steps, manual or LFO) and waveform with OFF; noise; the high pass,
  the low pass with its 10 / 40 / 70 / 100 % key follow, LFO mod, envelope mod and polarity; a VCF envelope and a VCA
  envelope (the manual lists two ADSRs; Io 4 had one); the VCA level; the LFO's four waveforms. The modifier section
  is there too: the trigger (its rate clocks a noise sample & hold into the cutoff, and the arpeggiator when ARP is
  on), the LFO delay and LFO bend, the lever's three LFO / OFF / BEND switches with bend sensitivity and LFO depth
  (the FM-1's pitch bend and mod wheel), portamento (its switch row is called SWITCH), transpose, tuning, POLY I /
  POLY II / UNISON I / UNISON II (SHARE on its unison row shares the four voices across held notes), hold and the
  ensemble switch. LFO RATE runs on the LFO's fast range, so it reaches the Jupiter-4's 80 Hz (it stopped at 40 Hz)
  ([D-704](docs/ledger/fidelity.md#D-704)). The switches show the panel's legends: RANGE 16' / 8' / 4', both WAVE
  FORMs, PW and PW MODE, KYBD FOLLOW, POLARITY, NORM / WIDE, the lever's switches and TRANSPOSE. The five OFF / ON
  switches stay numbered (1 OFF, 2 ON), and NOISE shares the VCO's second page: the FM-1's patch memory holds no more
  ([D-703](docs/ledger/fidelity.md#D-703)). The `voices` row and the ensemble's rate and depth rows are gone. Still
  missing: KEY ASSIGN as one four-position switch (it is two rows). FM-1: 15 → 56 modules, 1,049 → 3,838 of 3,840
  patch bytes, CPU 44 → 93 %, four voices. It gets the arpeggiator but no PATTERN track: with one added, the test rig
  shed a voice although the estimate said it fit.
- **Vernon 100 has the EML ElectroComp 100's panel.** Its card follows the 100's panel, read from photos (no manual
  for the 100 was found; the EML 101's manuals explain the controls the two share). Four distinct oscillators:
  oscillator 2 plays the lowest key held and oscillator 3 the highest, oscillator 4 follows oscillator 3, its own
  tuning or the mixer, and oscillator 1 is a slow or audio control oscillator with five shapes. Oscillators 2 to 4
  play the new EML COLOR wavetable bank: triangle through sloped square, square and saw to double saw an octave
  higher. The oscillator mixer and the filter control have their two centre-zero knobs each; the filter input mixer,
  white or pink noise, a 12 dB filter with low pass, band pass, high pass and band reject, cut octave and KB1 / KB2
  tracking; two envelopes with the sustain switch; the amplitude shaper's envelope switch; the output mixer with
  oscillator 3 around the filter; keys per octave and portamento. The sample & hold, the pulse width rows and the
  LFO's width modulation are gone: the 100's panel has none of them. Still missing: names for the switch positions (2
  bytes left) and the external input. FM-1: 16 → 60 modules, 1,072 → 3,838 patch bytes, CPU 24 → 58 %. It gets the
  arpeggiator but no PATTERN track.
- **Wanderer is duophonic, as the ARP Odyssey is** (#303). The lowest key held plays VCO 1 and the highest plays VCO 2
  (one key plays both), into one filter, one VCA, one ADSR and one AR; it was a two-voice polysynth with both VCOs, a
  filter and both envelopes per voice. New, after the Odyssey's panel: portamento, VCO 1's AUDIO / LF switch, both
  VCOs' FM (two depths each, each with its source switch), PWM (LFO / ADSR), sync, the S/H mixer (two levels and the
  noise / VCO 2 switch), the S/H trigger (LFO / keyboard) and OUTPUT LAG, the LFO's sine and square, the envelopes'
  LFO repeat (KYBD REPEAT / AUTO REPEAT), the VCF's three modulation sliders with their switches, the VCA's AR / ADSR
  switch, level and GAIN, the noise generator's white / pink, and the ring modulator as the Odyssey's (the two VCOs'
  square waves XORed). Main's mod wheel is the PPC's vibrato pad. The envelopes retrigger on every key press,
  including a note between two held notes, and not when an outer note is released (in Wanderer XL too). The voices row
  is gone (the Odyssey has two). On the FM-1 each VCO is one oscillator, so the S/H mixer and the ring take the VCO's
  wave as the mixer has it, and the ring plays at half a VCO's level. Every switch shows its positions by name (AUDIO
  / LF, SINE / SQUARE ...). The names leave no room for the PATTERN track, so Wanderer has the arpeggiator alone.
  FM-1: 17 → 49 modules, 1,245 → 3,824 patch bytes, CPU 30 → 33 %.
- **Canvas is the Buchla Music Easel's panel** (#303): the sequential voltage source (five voltages, 3 to 5 stages,
  the pulse sequence), the envelope generator (sustained, transient or off; attack, sustain, decay), the pulser
  (triggered by the keys, itself or the sequencer), the random voltage, the modulation oscillator (three ranges,
  triangle, saw or square, FM or AM by its index), the complex oscillator (the timbre switch and pot, the folder,
  polarity), both lopass gates (lopass, combination or VCA; gate 2 from the mod oscillator or gate 1, out of phase),
  chan A and B, the reverb, the portamento, each with its trigger select or keyboard switch, named as the Easel's
  panel names them. The patch field is a fixed patch on the FM-1 (sequencer into pitch, envelope into the index and
  both levels, random into the timbre, each through its processing control). It sounds different. FM-1: 16 → 53
  modules, 1,072 → 3,779 patch bytes, CPU 25 → 71 %.
- **Briefcase 3 gets the EMS VCS3's pin matrix for its controls** (#303): columns I to P (the three oscillators'
  frequency, the envelope's decay, the reverb mix, the filter frequency, the two output levels), every source a row,
  each pin named as the VCS3's manual names it (I8, N6), on the assembly's matrix card in the editor. The keys reach
  the oscillators as on the VCS3, through input amplifier 1 (pins I8 and J8). The panel is filled in: oscillator 2 and
  3's triangles and oscillator 3's audio range, noise colour, the filter and reverb levels, the envelope's signal and
  trapezoid levels (the trapezoid rests low and rises while on), two output amplifiers with their filters, the
  joystick. It sounds different. FM-1: 18 → 64 of 64 modules, 1,336 → 3,837 patch bytes, CPU 40 → 88 %; its PATTERN
  track no longer fits (the arpeggiator stays).
- **808 Kit has the Roland TR-808's controls, and its closed hihat cuts the open one.** One card, `808 kit`, holds the
  drums with the TR-808's knobs only, one page per instrument named as on its panel: bass drum (level, tone, decay),
  snare drum (level, tone, snappy), low tom (level, tuning), rim shot, hand clap, cow bell (level), open hihat (level,
  decay), closed hihat (level). New: bass drum TONE (a low pass on the kick's attack, now with a 1 ms click) and snare
  drum TONE (the balance of two body sines, about 238 and 335 Hz, the TR-808's two shells). The hihats are the factory
  hats (a square cluster and noise) on one metallic source, and a closed hit shuts an open one until the next open
  hit. The drums' other rows (tune, drop, snap, flam, stick ...) keep their values but leave the card. It plays eight
  of the TR-808's eleven voices, and each row accents its own drum by velocity, where the TR-808 has an ACCENT row for
  all. FM-1: 59 → 58 modules, 3,408 → 3,230 patch bytes, CPU 68 → 74 %. Also tested with the firmware's engine on the
  host (`tools/golden.sh`).
- **Cassia 1 is rebuilt on the new PD Osc and Env 8 modules.** Both lines play all eight CZ waveforms, with a second
  one on every other cycle; line select 1, 2, 1 + 2 and 1 + 1'; ring and noise modulation on line 2; DCO, DCW and DCA
  envelopes of eight steps with a sustain and an end step, as on the CZ (the six-step stand-in is gone); key follow,
  velocity, aftertouch, vibrato with a delay. The envelope rows are short (r1, l1 .. r8, l8, sus, end) to fit the
  patch bytes. Its presets gain Pluck (the variations reach Env 8). It plays two voices on the FM-1, where the CZ-1
  plays eight. Still missing: a pitch envelope per line, portamento, chorus and several per-line controls. FM-1: 21 →
  46 modules, 1,611 → 3,741 patch bytes, three → two voices, CPU 75 → 57 %. On the test rig, with a pre-release build
  (CI run 40406160864), the rebuilt Cassia 1's peak over rest and 1 / 4 / 8 held notes fell from 2,920 µs at three
  voices to 2,219 µs at two (100.6 % to 76.5 % of a block). The three-voice run shed voices; the two-voice run did not
  mute. In the browser (Node on an Apple M3 Max, four voices, four notes held) it renders in about 9 % of real time,
  where Cassia 1 XL took 44 %. Cassia 1 XL is gone for now: the browser lists Cassia 1 alone until a fuller XL is
  built ([D-348](docs/ledger/patches-and-presets.md#D-348)).
- **8 Lire and Elvira 2 play their plates from one repeating Drum map** in place of four copies, so every key now
  plays a plate (a black key the plate of the white key below it). With the speed-ups below, 8 Lire goes from 49 to
  37 % of the FM-1's CPU and from 94 to 86 % of its memory, Elvira 2 from 47 to 38 % and from 68 to 59 %. Not yet
  checked on a device.

### XLs (browser only)

- **Wanderer XL,** the whole ARP Odyssey: each VCO has its saw and pulse at once, so the S/H mixer has its own VCO 1
  saw / square switch, and the ring and S/H always take the pulses with their width. Coarse is continuous and fine
  reaches the Odyssey's ±400 cents (the FM-1 version: semitones and ±100 cents). Its switches show their positions by
  name. It takes 4,597 patch bytes, over the FM-1's 3,840. Not there: the external audio input (the engines have
  none), the pedal, footswitch and CV / gate / trigger jacks.
- **Canvas XL,** the Music Easel with its patch field. Each control input picks its cord through its processing
  control: MAIN, pressure, sequencer, envelope, pulser, four independent random voltages, mod cv or the inverter.
  Choose PATCH on an input row to connect an assembly patch cord. Also the preset voltages and add to main, pressure,
  the pulser's once (the FX button), the modulation oscillator's three dial ranges and half-octave fine tunes.
- **Briefcase 3 XL,** the VCS3 with its whole 16 × 16 pin matrix, 256 pins on the card, a section per column (A meter
  to P output 2 level); the oscillators' full dial ranges, output filters flat in the middle, the pan knobs and the
  joystick's ranges.
- **808 Kit XL:** every TR-808 voice, knob and switch. The mid and high toms and the cymbal play from a second track,
  DRUMS 2, whose Drum map also has the ACCENT row: a step on it accents every voice on that step by ACCENT LEVEL, and
  the rows' velocities no longer accent. The tom / conga, rim shot / claves and hand clap / maracas switches are rows
  of named choices. The cymbal and hihats share six square oscillators at the TR-808's frequencies; the cymbal has
  TONE and DECAY. A pre-scale row (1/8T, 1/16, 1/16T, 1/32: 3, 4, 6 or 8 steps a beat) sets both tracks' rate. The
  TR-808's rhythm memory (A / B variations, fill-ins, auto fill, rhythm tracks) is not there yet. 132 modules, an
  estimated 143 % of the FM-1's CPU.
- **Algo Four XL is the Yamaha DX100's parameter list** (#359), named as its display names them. The operators' 14
  parameters show one operator at a time under an "op" row, with one picker for all fourteen. LFO wave (SAW UP,
  SQUARE, TRIANGLE, S/HOLD: the DX100's four, in its order), LFO sync, porta mode, foot sw and each operator's on-off
  and AMS on-off are named switches. Card rows: 152 → 139 (the main card 91 → 80). The algorithm row moves one
  Selector per route in each voice, in place of a sequencer, a sample and hold, 7 comparators, 6 logic gates and 9
  path VCAs per voice. All four operators run on the new Rate Env with the original control ranges, and on the new
  Ratio module with the DX100's 64 frequency ratios and seven signed detune positions; saved oscillator tuning is
  unchanged. LFO SYNC starts the wave at its peak, and LFO SPEED covers the DX100's 0.0008 to 55 Hz. LOW / HIGH / KON
  pitch bend works, and breath and foot-switch MIDI controllers arrive directly. It plays eight voices. It still does
  not fit the FM-1: 117 → 101 modules (of 64), 6,221 → 6,349 patch bytes (of 3,840), and at its eight voices an
  estimated 646 → 480 % of the CPU.
- **Hera 6 XL's card is the Juno-106's panel** (#359): one row per control of the owner's manual, named as the panel
  names it. Range (16', 8', 4'), PWM mode (LFO / MAN), pulse, saw, HPF (0 to 3, 0 the bass boost), VCF polarity, VCA
  mode (ENV / GATE), chorus (OFF, I, II) and the portamento switch are named switches; one PWM slider sets the width
  on MAN and the depth on LFO. Card rows: 61 → 49 (the main card 41 → 33). Decay and release reach 12 s, as on the
  Juno-106. The hold pedal is MIDI sustain (CC 64): values 64 to 127 hold the sounding voices and 0 to 63 release them
  ([D-471](docs/ledger/link-and-midi.md#D-471)). FM-1 CPU estimate: 196 → 181 %, still too much for the FM-1.
- **Oracle V XL:** the original's rEL / HLd pedal modes on MIDI sustain (CC 64), a named OFF / ON Release switch, and
  a unison voice count of its own: detune and the manual chord offsets apply only in unison. Chord memory is one
  Selector per voice: `chord 2` to `chord 5` set each voice's interval above the key, not above the chord note before
  it. FM-1 CPU estimate: 425 → 402 %.
- **8 Lire XL and Meridian 8 XL show their original panel controls** (#359): 8 Lire XL has 47 rows instead of 141,
  Meridian 8 XL 107 instead of 146, including its nested cards. Their patch points remain assembly ports. 8 Lire XL's
  plates are one repeating Drum map, which holds each plate's velocity, so its 32 velocity VCAs and 8 S&Hs are gone
  (185 → 142 modules); a plate held on two keys keeps its own velocity instead of adding the two.
- **8 Lire XL and Hera 6 XL keep their Pad, Pluck and Wet presets after the card changes.** The variations use the
  panel controls: FAST and SHARP on 8 Lire, and chorus II on Hera.
- **909 Kit XL groups the original drum controls on its cards** (#359): 30 rows instead of 43. FLAM, SHUFFLE and SCALE
  use named choices. FLAM defaults to about 22 ms (position 4); it was 24 ms.
- **Elvira 2 XL:** its choices (programs, chords, filter types, tunings, LFO waves, reverb, tune follow, MODP
  chaining) are Selectors in place of comparator and Crossfader chains (702 → 475 modules). BITMANGLER uses the new
  signed audio XOR; the original instrument's exact mask sequence is unverified. It plays a test phrase slightly
  louder than before (peak 0.50 → 0.54).
- **Perun 4 XL:** its tracks reach the PERKONS' ÷8 and x4 rates (1/2 and 1/64) and the new play modes on each voice
  track; the modulation LFO syncs x8 to ÷8 (`mod mult`), and the BBD syncs to 1/32, 1/2T, 1/2D, 1/1T and 1/1D (`sync
  note`). Its switches (algorithm, mode, VCF, groove, LFO wave, chord) are Selectors: they step from one position to
  the next and no longer blend two. It sounds the same at every switch position. 345 → 268 modules; FM-1 CPU estimate
  402 → 317 %, so it stays an XL.
- **Spokes 6 XL** gains what the new ranges make possible: swing to 80 % and the 1/8X scale (Steps 1/2), the LFO's
  start phase, backward speed, slow and fast ranges and synced speeds /8 to x8, synced retrigs down to a 1/128 triplet
  and an INF retrig length, a delay `note` row and `swell` (feedback to 1.98), and a reverb `freeze`. Each track's
  machine choice is one Selector in place of ten comparators: 836 → 782 modules. The sound as shipped is the same.
- **How fast the XLs render** (Node on an Apple M3 Max, four notes held, transport running, 3 s rendered, as a share
  of real time): Elvira 2 XL 41.1 → 32.2 %, Perun 4 XL 21.1 → 21.5 %, 8 Lire XL 11.5 → 11.9 %, Spokes 6 XL
  65.4 → 65.3 %.

### Steps

- **Pattern memory and songs.** A Steps track holds up to 64 patterns, each with its own length and rate or the
  track's, saved in the patch. The patch has one selected pattern: while playing, each track switches at the end of
  its own pass; stopped, at once; a track without that pattern plays its first. Songs chain patterns: up to 8 songs of
  up to 64 entries, each a pattern and a shift of up to an octave either way (tracks that play a Drum map are never
  shifted). A song loops, and PLAY starts it at its first entry. The patterns and songs are written only when a patch
  has some, with 16-bit note words where a pattern allows (half the bytes of the usual 32-bit ones), so a patch
  without them takes no more bytes. The FM-1's note pool holds 1,536 notes per patch (512 in 1.4.2). Tested on the
  host and in the emulator.
- **Patterns and songs on the FM-1.** PRESET on the SEQ page picks the patch's pattern (1 to 64): while playing, each
  track takes it at the end of its pass, and the top bar shows both numbers (`P03>P04`) until then; stopped, it
  changes at once. Tapping SEL on the SEQ page opens the new SONG page: one row per entry, K1 sets the entry's pattern
  (on END it adds one, FX + K1 inserts a copy), K2 its shift, K4 switches between the song and the pattern, ALGO picks
  song 1 to 8, SEQ + REC deletes an entry (asked first).
- **Patterns and songs in the editor.** Each Steps card and the piano roll have a pattern strip (‹ P01 ›, or `[` /
  `]`) that picks the patch's pattern, blinks while a track waits for the end of its pass, sets a pattern's own length
  and rate, copies every track's pattern to the next empty one and clears this track's. SONG opens a songs drawer:
  tabs 1 to 8, a pattern / song switch, entries with a pattern and a shift to add, insert, delete and drag, the entry
  playing highlighted. The editor follows the FM-1's choices and edits them over the link.
- **Play modes:** backward, ping-pong and random alongside forward. Swing and live recording follow the visited steps.
  A note near the end of the grid can last up to 64 steps, so a note at step 64 still lasts its full length when the
  track plays backward.
- **Two more rates and more swing.** A track also runs at 1/2 (eight times slower than 1/16, the Model:Cycles' 1/8X
  and the PERKONS' ÷8) and at 1/64 (four times faster than 1/16), and its swing goes up to 80 % (75 % before), on the
  card, in the roll and on the FM-1's SEQ page. Cables and macros into rate and swing still cover 1/4 to 1/32 and 50
  to 75 %, so every patch made before plays exactly as it did.
- **A Drum map can repeat its rows across the keybed** (its new REPEAT switch, off by default), so every key plays a
  row. Rows on white keys repeat in blocks of white keys, and a black key plays the row of the white key below it:
  rows on F3 to F4 come again from G4 and below E3. On the FM-1, the keys that play nothing on a Drum map (the white
  keys and black keys 9 to 11) then play a row too. Not yet played on a device.

### Modules

- **New: the Selector.** One stepped row (1..8, or a cable: 0..1 covers the positions in use) picks one of eight
  inputs, each with a value added (with nothing patched in, it is a table of eight values), and raises that position's
  gate, so one choice can switch several things at once. An optional crossfade (up to 100 ms) avoids clicks. It costs
  about 0.2 to 0.3 % of the FM-1's CPU, plus about 0.1 % per gate cabled (the CPU model's figures). In the browser a
  Selector writes only the gates that are cabled (or watched), as the FM-1 does.
- **New: Phase distortion** (PD Osc on the FM-1), after the Casio CZ: all eight CZ waveforms (saw, square, pulse,
  double sine, saw-pulse; resonance I, II and III) with a DCW amount and input, a second waveform on every other
  cycle, the resonance's range, `pm` and `sync`. High notes stay clean: the bend is held back as the note rises. One
  module plays what took Cassia 1 XL about 60 modules per line. About 4 % of the FM-1's CPU per copy as Cassia 1 uses
  it (estimate).
- **New: Env 8, an eight-step envelope** after the Casio CZ's: eight levels and rates, a sustain step that holds while
  the key is down (the key's release jumps to the step after it) and an end step where it rests. With the sustain off
  it runs through like a one-shot. Its card draws the shape; on the FM-1 it has five pages (two steps a page, then
  sustain and end). About 1.2 to 1.4 % of the FM-1's CPU per copy (estimate).
- **New: the Follower,** after the Korg MS-20's External Signal Processor: it turns any signal into a pitch (in
  octaves, like the keyboard's), an envelope and a trigger, with the ESP's signal level, low cut, high cut, cv adjust
  and threshold. On the FM-1 it hears only what a patch makes.
- **New: Ratio,** the DX100's 64 frequency-ratio choices as a pitch offset.
- **New: Rate Env,** with the original attack / decay / release rates, zero-rate holds, keyboard rate scaling and
  pedal hold.
- **Longer and wider ranges on five modules,** on the FM-1 too (#351). Each is a new row whose default plays as
  before:
  - **ADSR `long`:** decay and release times 2.4 times as long, up to 12 s and 19.2 s (the Juno-106 reaches 12 s). The
    ADSR also has a hold input that defers the release and still lets new notes attack, for MIDI sustain.
  - **LFO:** `phase` sets where a reset or a clock restart starts the wave (90 degrees starts a sine at its peak, as
    the DX100). `range` slow divides the rate by 25 (down to 0.0008 Hz), fast doubles it (up to 80 Hz), and wide has a
    continuous rate of its own from 0.0008 to 55 Hz ([D-445](docs/ledger/modules.md#D-445)). The rate row shows the
    rate the LFO runs at, on the card and on the FM-1; the knob's range is unchanged
    ([D-372](docs/ledger/engine.md#D-372)). `dir` back runs the wave backward (a saw falls). `mult` makes a synced
    cycle up to 8 times longer (/8) or shorter (x8): a 1/16 triplet at x8 is a 1/128 triplet, for fast synced retrigs.
    A new shape input sweeps the wave from falling saw through triangle to rising saw and changes the pulse width, and
    a pulse output plays at the same time.
  - **Delay:** `note` gives the synced delay 1/32, 1/2T, 1/2 dotted, 1/1T and 1/1 dotted in place of the time knob's
    length. `swell` scales the feedback up to 1.98 (the Model:Cycles' 198) with a soft clip in the loop, so the echoes
    grow to about full level and hold there.
  - **Reverb `freeze`:** an infinite decay. The tail holds and nothing new goes in; the dry sound still passes.
  - **Pulse `inf`:** the window stays open until it is switched off (the Model:Cycles' INF retrig length).
- **Multimode filter:** an `hp6` output, a resonant high pass that falls 6 dB per octave below the cutoff, after the
  Korg MS-20's. A self-oscillation switch (`osc`, off by default): on, it rings a steady sine-like tone at its cutoff
  near full resonance, as the MS-20's filters do at full PEAK, even with nothing on its input
  ([D-371](docs/ledger/engine.md#D-371)).
- **Oscillator:** sharktooth (a triangle / saw hybrid) and reverse saw, including unison, sync and phase modulation.
  Existing waveform indices and parameter-input ranges stay unchanged.
- **Ladder:** an audio-rate cutoff input for oscillator-speed filter modulation. Its existing cutoff input keeps its
  block-rate behaviour for saved patches.
- **Voicing:** a separate number of voices to stack in unison, keeping the polyphonic count. SHARE spreads the voices
  across held notes, like the Jupiter-4's UNISON II; both engines keep all 128 held MIDI keys. Lowest and highest
  held-voice gates. A key-press trigger. Voice stealing can be turned off, and the rotation can reset to voice one
  once all keys are released. Both engines and the FM-1's device pages support these settings; older patches keep
  their allocation.
- **Arpeggiator:** a continuous rate input in hertz, with zero to pause; an external clock takes precedence. Its CPU
  estimate includes note scheduling.
- **Main** has breath (CC 2), sustain (CC 64) and foot switch (CC 65) as separate patchable outputs, in the browser
  and on the FM-1.
- **Random** has a `clock` input and a `held` output: each rising edge draws an independent random voltage for that
  instance, held until the next edge. Existing fixed and wandering outputs keep their sound.
- **Math** adds signed 16-bit audio XOR.
- **Wavetable** adds the EML COLOR bank (see Vernon 100).

### The editor

- **The editor has its own address: [matryoshka.lol](https://matryoshka.lol/).** The browser keeps the editor's data
  separately for each address. If you used matry0shka.pages.dev, it keeps working, and a bar at the top offers **Move
  them there**: one click opens matryoshka.lol and brings your patches, FM-1 bank, library, tutorial progress and
  settings along, without replacing anything already there. A toast lists what came over. If you never used it, a
  matry0shka.pages.dev link opens at matryoshka.lol instead, with its patch. The command palette has **Move to
  matryoshka.lol** there, and **Save browser backup** everywhere: a .json file of all of it, which **Load .json** reads.

- **One card row can set several modules at once** (#357). In pick mode, "one row with…" joins a row to another of the
  same range: turning it moves both (two filters' cutoff, say), and so do a cable or a macro on it, a card preset and
  the FM-1's knob on its page. "split" gives each its own row again. A row that sets several shows ×2, ×3 … after its
  name. Host-tested (`tools/panel_test.sh` turns such rows), not yet on a device.
- **A Selector's positions can have names** (#358): pick mode's "names" on a card row of its position, such as SAW,
  SQUARE, PULSE. The card, the Selector's own card, Main's knobs and the FM-1's page show the names (in capitals on
  the FM-1). The position row offers only the positions in use (1 to its count), on the card, the knobs and the FM-1.
- **Controls the original edits one at a time can show one at a time** (Arrange mode's "⧉ one at a time"): for example
  the Casio CZ's eight envelope steps become one rate and one level under a "step" row. The FM-1 gives each copy a
  page, and copies of card controls can span several FM-1 pages. Algo Four XL uses it for its operators.
- **Tutorial reference patches** receive newly added module defaults when opened. Patch previews no longer let
  undisplayed module rows squeeze neighbouring controls.

### On the FM-1's screen

- **The SEQ page opens with about half the screen traffic,** so it appears sooner while the sequencer plays. SEQ or
  SEL from a Steps track's device page drew the SEQ page twice (and the device page's header first). Opening the SEQ,
  SONG and menu pages cleared the screen twice, and a whole SEQ page cleared the ground under the cells it then
  painted over. Host pixel counts (`tools/panel_test.sh`, Elvira 2), not yet measured on a device: SEQ from a Steps
  track's device page 242,832 → 76,248 px; SEQ from another device page 147,576 → 76,248; the SONG page 136,664 →
  83,864; ENV 118,592 → 68,672; the menu 166,922 → 114,122; one whole SEQ page 86,616 → 68,088. The screen looks the
  same.

### Speed and memory

- **Lower CPU use.** Modules without parameter modulation copy their settings directly, and other modules skip
  parameters with no routes. FM sine operators skip unused feedback and waveform selection work, and polyphonic
  modules reuse shared control averages. Math and Logic calculate only the selected operation when one output is
  connected. The Ladder skips audio-rate checks when its FM input is unpatched, and Selectors and gain modules skip
  constant or unity-gain cases; the CPU estimate tells the cheaper fixed gains apart from other or modulated gains.
  Each step was checked bit-identical on every audio kit and mode change (`tools/engine_exact.sh`). The estimate for
  factory patches whose design did not change: Algo Four 80 → 56 %, Spokes 6 85 → 72 %, Hera 6 71 → 67 %, Expander S
  54 → 50 %, Simple FM 17 → 13 %. Not measured on a device as before and after.
- **FM-1 memory.** Each module takes only the parameter slots its type needs, from a shared store of 1,536 values,
  instead of room for the largest module's (18, with Env 8), which would have taken about 9 KB more; the editor's
  budget shows the new "parameter values" line, and no factory patch uses more than 798 of them (Io 4). Page rows that
  set several parameters take 1,280 bytes more and 916 bytes more firmware. The engine's state grows from 18,800 to
  31,512 bytes, most of it the note pool for patterns. In all, the pool goes from 381,038 to 399,638 of 417,792 bytes
  (the stand-in estimate, `tools/pool_sizes.sh`). A Steps track costs 12,644 → 14,282 cycles per block
  (`npm run cpu-costs`, host build).

### Compatibility

- **Patches saved on the FM-1 before this release still load and sound the same.** New parameters take their defaults
  in them, and saving such a patch again stores it in the new format. The editor writes a patch in the lowest format
  that holds it, so a new parameter, the filter's `osc` switch or patterns cost FM-1 bytes only in patches that use
  them ([D-281](docs/ledger/patch-format.md#D-281)). The editor checks which patch formats the firmware reads before
  syncing, and it tells an FM-1 on an older firmware to update; older firmware keeps its existing compatibility check.

## 1.4.2 — 2026-10-26

- **Incoming MIDI notes keep playing while the FM-1 screen redraws** (#363). USB and TRS notes and clock are taken
  between screen transfers, including octave messages. This fixes short notes disappearing or arriving together
  when turning SELECT or ALGO or pressing octave buttons. On the exact release package, the test rig played all
  50 notes during page changes and all 200 during octave changes at 20 ms spacing. Note spacing matched idle
  playback. See the [release measurements](docs/measurements/2026-10-26-1.4.2.md).
- **Cassia 1 joins the FM-1 factory patches.** This is the patch already published in the 1.4.1 browser, now included
  in the firmware's factory set. Existing banks stay intact; Cassia can still be sent from the editor.
  The browser keeps its 1.4.1 patches and features. The firmware engine and patch format stay
  at 1.4.0's, with the MIDI redraw fix applied.

## 1.4.1 — 2026-10-26

Web only: the FM-1 firmware is 1.4.0's. New factory patches now ship in the browser first; the FM-1 gets them as
factory patches with its next firmware release.

- **A new engine, Cassia 1,** after the Casio CZ-1: phase distortion. Each voice has the CZ's two lines: line 1 sweeps
  from a sine to the CZ saw or square, line 2 is the CZ's resonance waveform, a resonant peak that sweeps. Each line
  has its DCW envelope, with one DCA envelope, line mix, line 2 detune, key follow, velocity and vibrato. Three voices on the
  FM-1 (75 % of its CPU, estimated). Its factory patch is in the browser now and comes to the FM-1 with the next firmware
  release; until then, send it to the FM-1 over the editor link.
- **Cassia 1 XL** in the browser: all eight CZ waveforms (saw, square, pulse, double sine, saw-pulse; resonance I, II
  and III) and a second waveform on every other cycle, both lines with their own DCW and DCA envelopes of six steps
  (the CZ has eight), the 1+1' line mode, a pitch envelope, ring and noise modulation, vibrato with delay, key follow,
  velocity and aftertouch. Four voices with two lines, as the CZ-1; eight with one.
- **Every XL now has its original's whole panel**, after the original's manual; what is still missing is listed in the
  XL's notes with the reason (a module we do not have yet, hardware, or samples). Among the additions:
  - **Oracle V XL:** saw, triangle and pulse on oscillator B, the Rev 3 filter, velocity and aftertouch, unison detune,
    chord memory, the release switch, the Vintage knob.
  - **Hera 6 XL:** the DCO range, PWM mode, key transpose, bender amounts, portamento, assign modes, hold.
  - **Expander S XL:** eight SEMs, each with its own knobs, and the Eight Voice keyboard (split, unison, portamento).
    An "all SEMs" section at the top moves each control on all eight at once, keeping their differences.
  - **Algo Four XL:** one algorithm row (1 to 8), velocity, level and rate scaling, LFO delay and sync, portamento,
    pitch bend range, key shift.
  - **8 Lire XL:** the FAST switches, touch (velocity and pressure per plate), the rear jacks as inputs.
  - **Elvira 2 XL:** all eleven MOD programs, twelve filter types, the reverb, the ATT and ADD utilities, the jacks.
  - **Meridian 8 XL:** mute and CV mute buttons, nine LINK buttons, the touch plates, individual outputs.
  - **Perun 4 XL:** the LFO on any knob, CONTROL ALL, CHORD and DIGITAL NOISE modes, four sequencer tracks with
    chance, groove and fill, the BBD's controls and the compressor.
  - **909 Kit XL:** mid tom, crash and ride, TOTAL ACCENT and per-drum accent, flam, shuffle and scale.
  - **Spokes 6 XL:** all six machines on every track, chance, fill lanes, retrigs, the LFO on any destination,
    velocity routes, pads.
- The XLs are heavier in the browser. With four notes held, in Chrome on a recent Mac, as a share of real time:
  Spokes 6 XL 61 %, Cassia 1 XL 39 %, Elvira 2 XL 37 %, Expander S XL 23 %, the others 6 % to 20 %. Big XLs share as a
  stored link.

## 1.4.0 — 2026-10-25

- **A new engine, Spokes 6,** after the Elektron Model:Cycles: six FM tracks (kick, snare, metal, perc, tone, chord),
  each with pitch, decay, color, shape, sweep and contour, plus volume and a delay send. Its factory patch comes last,
  after <7PH: three Steps tracks (DRUMS, TONE, CHORD) play a 16-step groove in A minor at 120 BPM, and the keys play TONE.
  It estimates 85 % of the FM-1's CPU (not yet measured on a device).
- **Spokes 6 XL** in the browser: the same with a reverb, stereo pan, distortion and an LFO per track, and phase
  modulation on the snare and metal. It is a sandbox patch (146 % of the FM-1's CPU).

## 1.3.5 — 2026-10-25

Web only: the FM-1 firmware is 1.3.3's.

- Arrange mode is redone. Each heading and its pages sit in a faint outline, each FM-1 page in a fainter one with its
  own ⠿ handle, and the heading field shows the FM-1's name for its pages, "filter (FILTER)". A drag shows one line where
  it will land: a row can go to the start, middle or end of any page that has room, a page anywhere between pages, a
  section to the top of any column. Moving things never reshuffles the other pages.
- Arrange mode: + heading under any section or at the top of a column, and + page break between any two rows of a page;
  a page break you added has a × to join the pages again. A heading keeps its place when you move all its rows away, and
  is saved with the patch (the FM-1 and the normal card skip it).

## 1.3.4 — 2026-10-25

Web only: the FM-1 firmware is 1.3.3's.

- An assembly made of assemblies keeps the names they gave their controls and jacks: promoting a nested
  "hold pitch" slider onto the outer card shows "hold pitch", not the Macro's "value".
- A control promoted from a nested assembly lands under a heading named after it and its page there ("Lire 5-8",
  label "hold"), next to the other controls from that page. Factory assemblies and saved patches are unchanged.

## 1.3.3 — 2026-10-25

- Syncing with an FM-1 on firmware older than 1.2 now says to update it (with a button to the install panel),
  instead of failing with "the firmware refused the patch".
- The sidebar stays the same in Patch, Emu and Library; Get started, Audio on / Panic and MIDI are there in all three.
  Library's Patches, Assemblies, Presets and Community are tabs at the top. The logo takes you back to the canvas.
- 909 Kit XL has an arpeggiator (ARP, off until pressed) between its DRUMS track and the drum map, like every other XL.
- Make assembly (Ctrl/Cmd+G) works on a selection of assemblies alone: group two engines into one and promote just
  the controls you want.
- Emu: muting a track on a synced FM-1 (SEQ + a black key) now blinks that key on the emulator too, and letting go of
  SEQ no longer flips the emulator to the SEQ page.
- 8 Lire and Elvira 2 (and their XLs) call their piano roll rows VOICE 1, VOICE 2, ... instead of KICK, SNARE, ...;
  the browser's roll and the FM-1's SEQ page now show the same names on the same notes.

## 1.3.2 — 2026-10-25

Not released on its own: it ships in 1.3.3.

- FM-1: the footer's octave (= OCT =, OCT +, - OCT) changes as soon as you press OCT- / OCT+, not only once something
  else redraws the screen.

## 1.3.0 — 2026-10-24

### On the literal physical FM-1 device

- Big ol UI overhaul:
  - Paging through params is 6x faster.
  - Knobs respond 29x faster (lol).
  - You no longer need a jeweler's loupe to know your current patch, device, or assembly.
  - The UX on the FM1 sucked shit before -- sorry about that! I got swept up in patch editor feature creep and briefly forgot what my job was
 - CPU cycles down 8-13% on the FM-1; audio output is bit-identical to output before optimizations

### In the browser

- **SANDBOX MODE BABY!!!** If a patch is too big for the FM-1, the FM-1 becomes its
  controller as if it did fit on the device.
  - I find that starting with something excessive and ambitious, then accommodating constraints later, results in cooler stuff than building reasonably for the jump, and the patch editor now suits that kind of workflow.
- **XL patches:** Every factory patch modeled after a synth whose architecture was too beefy to fit on the FM-1 now gets a browser-only version that is faithful to the OG architecture.
- **Community patches!!!** have their own Library section!!! Send me your most depraved patches, sickos!!!
- **MIDI clock out:** the editor can now keep multiple connected FM-1s in sync. Clock stopgap while I figure out Bluetooth vs GPL friction. I now understand why baudgirl is not FOSS
- **OCT- / OCT+ on the FM-1 move the editor's octave too,** so the on-screen keyboard shows what you play.
- The FM-1 budget no longer reads a patch with an arpeggiator as half full. Now it reads it as half empty


## 1.2.2 — 2026-10-24

- **"update failed -5" explained:** the FM-1 was set up by M-VAVE's Official Open, and nothing was changed.
- **Sol 29N:** a new community patch after the Elta Music Solar 42N, playable on the FM-1.

## 1.2.1 — 2026-10-23

- **A refused return to V15 now says why,** and how to get back: nothing was erased.

## 1.2.0 — 2026-10-23

- **Presets:** store an assembly's values as a named preset and load it into any copy, in the editor and on the FM-1.
  Every factory engine comes with its own.
- **The environment page on the FM-1:** ENV lists every device in the patch, to pick, turn and open.
- **Arm several devices at once** to layer them on the keys, in the editor and on the FM-1.
- **Three new engines:** Scrounge, Meridian 8 and Perun 4, after the neutral labs Scrooge, the Landscape NOON and the
  Erica Synths PERKONS HD-01. Plus **<7PH**, a groove box patch.
- **An arpeggiator and a PATTERN track on every melodic factory patch,** on ARP.
- **A piano roll and a drum grid on the FM-1's SEQ page.**
- **The 909 Kit plays all eight rows:** five were silent.
- **No key press is lost while the FM-1's screen redraws.**
- **A battery gauge on the FM-1.**
- **New navigation:** PATCH | EMU | LIBRARY, and a Library that shows the browser and the FM-1 side by side.
- **Lire + Elvira,** the first community patch.

## 1.1.0 — 2026-10-22

- **Two new engines:** 8 Lire and Elvira 2, after the SOMA Lyra-8 and the neutral labs Elmyra 2.
- **Modules are named after the hardware they stand for:** Attenuverter, Slew limiter and so on. Patches load as before.
- **Share links keep big patches whole.**
- **With Live on, FM-1 knobs no longer make values jump.**

## 1.0.0 — 2026-10-21

The first release: a modular patch editor in the browser, and a firmware that turns the M-VAVE FM-1 into a player for its
patches.

- **44 module types,** and **assemblies** that make any group of them one card. 61 come with the editor.
- **17 factory patches,** from an init patch to instrument recreations and two drum kits.
- **Polyphony** of up to 8 voices on the FM-1, and **Steps** sequencer tracks of up to 64 steps.
- **The FM-1 plays your patches:** 64 slots, SELECT and ALGO page through the devices, K1..K4 turn the page in focus.
- **Live sync over USB:** edits, knobs and buttons go both ways.
- **USB MIDI and audio:** notes, CC and clock in, every control out, and the FM-1 as a 2-channel recording device.
- **Install and return to stock** from the browser.
- **Coming from Felucca:** installing overwrites Felucca's saved projects and samples. Save them first.
