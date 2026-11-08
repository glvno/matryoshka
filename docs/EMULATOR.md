# The firmware on an emulated FM-1

[fm1-emu](https://github.com/joakimeriksson/fm1-emu) (Joakim Eriksson, MIT) emulates the FM-1's JieLi AC791N: the
pi32v2 cores, timers, interrupts, SPI flash, the 240×240 LCD, the key matrix and encoders, the MASTER pot, the I2S
audio and the TRS MIDI input. Our `matryoshka.bin` runs on it unchanged. `tools/emu/` is a small Rust crate (`m1emu`)
on fm1-emu's `fm1-core` / `fm1-soc`, pinned to commit `7ca5b96` in `tools/emu/Cargo.toml` (a git dependency, nothing
of fm1-emu is copied into this repository). Two decoder fixes are applied to it at build time: `tools/emu/isa_fix.sh` copies
fm1-emu's `fm1-isa` crate from cargo's checkout into `tools/emu/target/fm1-isa`, corrects two decoder entries and hands
cargo a `patch` through `--config` (`emu_smoke.sh` and `npm run emu` do this for m1emu). fm1-live cannot take that patch (inside fm1-emu's workspace fm1-isa is a path dependency: cargo says "patch was not used"), so `tools/emu/live_build.sh` builds it from a copy of the pinned checkout with the fixed fm1-isa swapped in (`tools/emu/target/fm1-emu-src`); fm1-live builds without both fixes (markers `.isa-fixed`, `.isa-fixed-2`, not `.isa-fixed-3`) are rebuilt. The first entry: the
forward `if ((R & #h) == #i) goto #i` (6 bytes, `..ff60`) had a 13-bit offset field (bits 32..44, learned from
samples with short jumps) while its `!=` sibling has 15 (bits 32..46). A JieLi build that jumps 8 KB or more forward
with it stopped the emulator at boot with UnknownInstruction (every build from the cpu-opt work on, 2026-10-18: pc
0x020043d4, a jump of 18076 bytes). The real chip runs it: the toolchain emits it. The second (2026-10-20): the dual-issue head
`R = R & ~(#i << R) #` (`..f194` with bit 16 set; fm1-isa learned it from two samples) had an overfitted mask and its
own slot layout, so `r4 = r9 & ~(1 << r2) #` in `dm_keys` (the Drum map, format 32 on) stopped the smoke test after
the factory patches (pc 0x020032d2). It now has its three siblings' layout (`&`, `& #`, `&~`: mask `0xfffff`, dest =
bits 28..31, source = 20..23, shift register = 24..27). The third (2026-10-29): the `|` and `^` heads of that family,
`R = R | (#i << R) #` (14 samples) and `R = R ^ (#i << R) #` (6), had a three-bit shift-register slot (24..26: their
samples shifted by r0..r7 only) and masks that pin bit 27, so `r0 = r1 | (1 << r15) #` (pages_turn, the row a knob
turns, from the knob turns of #340 on) decoded as another instruction: every knob click on the device page reached a
module index that did not exist, the row stayed, and the patch was still marked edited. They have the `&` pair's layout
now. fm1-core already runs `#` pairs with the second instruction
seeing the old registers. The firmware CI keeps the ELF and
its disassembly (artifact `matryoshka-elf`) for tracing such faults to a function.

**Run it locally before any device work.** It is not part of CI (the user's call: too expensive on Actions).

## Commands

- `cd web && npm run emu:smoke [-- FIRMWARE]`: the smoke test (below), about two minutes on an M1.
- `cd web && npm run emu:boot [-- FIRMWARE] [--link EMU_BIN]`: the [**boot check**](ledger/vocabulary.md#boot-check)
  (`m1emu boot`, `tools/emu/src/boot.rs`, built on the smoke test's checks), about 30 s (27 s on the M1, 20 s emulated).
  On FIRMWARE, the bytes that get installed: the loading screen draws, the quick start and then the home page (factory
  patch 0) come up, silence without keys and sound from a panel key, no register fm1-emu does not model besides P33,
  and OCT- + OCT+ held at power-on enters update mode with the flash chip known. On EMU_BIN, the same commit's
  `M1_EMU_MIDI=1` build (the plain build has no link the emulator can reach): HELLO is answered with INFO from the
  loading screen and on the home page, and the update protocol's handshake (`ota.c`) is answered with a Matryoshka
  identity (`FM-1_7..`) after boot and in update mode. That handshake is how the Install panel and `fm1_install.py`
  find the FM-1, so a build that answers it keeps the way back. Without `--link` it takes `matryoshka-emu.bin` or
  `emu-midi/matryoshka-emu.bin` next to FIRMWARE, else the CI run's `matryoshka-emu-midi` artifact, else it checks no
  link and says so. The last line is the summary (`boot check: PASS ..` / `FAIL ..`); snapshots go to `build/emu/boot/`.
  It is the test rig's gate while the owner iterates ([D-123](ledger/releases.md#D-123)), not a merge or release gate.
- **Running them side by side:** `emu:smoke` and `emu:boot` count emulated time, not the wall clock, so several may run
  at once with no lock. Two smokes on the same build at once gave identical results and byte-identical snapshots, only
  slower: 474 s against 401 s (2026-11-02). Two runs in one checkout write to the same `build/emu/smoke/` (or
  `build/emu/boot/`), so run them from different checkouts. `emu:scenarios` may run side by side too, from different
  checkouts (each writes `build/emu/scenarios/`, `build/emu/bridge/ci/` and the panel WebAssembly in its own), since it
  waits on conditions and on the emulator's clock (#588, [D-136](ledger/releases.md#D-136), below): two runs side by side passed 10 rounds in a row on the M3 Max, 225 of 225 checks each, 277 to 471 s a round with the load average at 4 to 20 (2026-11-04). `device:scenarios` drives the one rig, so
  it still runs alone.
- `cd web && npm run emu [-- FIRMWARE]`: the firmware in fm1-live's window (LCD, keys, buttons, knobs, sound, every
  MIDI input into the TRS jack; fm1-live prints its key map; built once into `tools/emu/live/`).
- Without FIRMWARE both take `build/matryoshka.bin`, else download the latest firmware artifact of a successful
  `firmware` run on `main` with `gh` (`build/emu/ci/`), else unpack `web/public/firmware/matryoshka.fwsc`.
- `tools/emu_smoke.sh [BIN]` is what `emu:smoke` runs (`M1EMU_STRICT=1` makes
  level warnings fail). `tools/emu/target/release/m1emu run BIN --ms N --keys SCRIPT --snap MS,.. --wav F
  --flash-in F --flash-out F --text S` is a free run (SCRIPT as fm1-emu's: `800:n7,1500:n7^,2000:e6:1,2500:mc005`;
  snapshots as `lcd_MS.png` in the current directory).

## The editor link: `m1emu serve` and the scenarios

fm1-emu has no USB controller, so the checks that cross the editor link (Sync, Live, sandbox mode, PRESET with the
editor, the reconnect) run against a firmware built for it ([D-119](ledger/releases.md#D-119), issue #290):

- **The firmware:** `M1_EMU_MIDI=1 python3 tools/build.py` (CI does this after the normal build: artifact
  `matryoshka-emu-midi`, `matryoshka-emu.bin` and its ELF). Its `usb_poll` moves USB-MIDI event packets through a mailbox
  in RAM (`m1_emu_mb` in `firmware/src/usb.c`, found by its magic words `M1EM` `MIDI`) instead of EP1; the rest of the
  MIDI path (the rings, SysEx, the editor protocol) is the normal one. It is never packaged or installed. The normal
  build does not change: the flag defaults to 0 (checked by comparing the CI builds' sha256 before and after).
- **`m1emu serve BIN [--name NAME]`:** the firmware in real time (the interpreter runs at about 0.75x, so emulated time
  falls behind under load), its MIDI on a CoreMIDI virtual source and destination named `NAME` (default `FM-1 (emu)`,
  which the editor's port match takes like a real FM-1), and a line protocol on stdin for the panel, the LCD and the
  audio (`tools/emu/src/serve.rs` lists it). `M1EMU_TRACE=1` prints every short message the FM-1 sends.
- **`cd web && npm run emu:scenarios [-- BIN] [--only NAME,..] [--list] [--headed]`:** builds m1emu and the panel WebAssembly,
  starts this checkout's dev server on a free port (with `MATRYOSHKA_BUNDLED_FIRMWARE=1`, so its Flash tab starts no
  `emu:smoke` of its own beside the run, issue #521; the rig scripts' and `demo.ts`'s dev servers do the same), starts `m1emu serve`, and drives the editor in Chrome (playwright-core
  with the installed Chrome, headless) through the scenarios in `web/scripts/emu-scenarios.mjs`: connect and Sync; an
  over-budget patch is sandbox mode (the sandbox page on the LCD, the FM-1 silent under a key); ARP twice; OCT; PRESET;
  back under budget; the tab closed and reopened on a sandbox patch; Elvira 2 running, then Elvira 2 XL; a computer
  where no app reads the FM-1's MIDI (issue #375, `deafHost`, below); ties on the SEQ page (issue #368, below); an A/B flip with Live on (issue #103: values only, so PARAM frames and no upload, and each side sounds as it did); a Cassia 1 preset of 118 values sent to the FM-1's store, read back whole and loaded there with PRESET, every row reaching the editor (issue #485, `longPreset`); then the release's device check (`check..`, below). The page sees
  only the emulator's MIDI port, so a real FM-1 plugged in is never touched. A development-server hook (`__m1test` in
  `main.ts`) opens patches by name and reports the link's state. Without BIN it fetches the `matryoshka-emu-midi`
  artifact of this commit's firmware run (else its branch's, else main's). Results and LCD snapshots go to
  `build/emu/scenarios/`; about five minutes. A run of every scenario that passes writes `scenarios.passed` (the
  build's sha256) beside the build: in `build/flash/RUN/` for a build in its `emu-midi/` folder, else in the build's own
  folder; a failed run removes it.
- **Waits (#588):** the emulated FM-1 runs at about 0.75x the wall clock and falls further behind under load, so no
  check waits a fixed wall-clock time for the FM-1. A tap waits for the key's release on the emulator's clock, a pause
  after a press is emulated time (`elapse`, `wait`), and a wait for the screen is one `until` in emulated ms. A wait for
  the editor polls its state (`__m1test`: an opened patch's own upload finished, `loads` and `uploadedLoad`). Every limit
  is stretched 3 times (`M1_SCENARIO_SLACK`), which costs time only when a check fails. Before each scenario after
  `connect`, the keys the script held are let go, HOME brings back a device page and PLAY stops a running transport, so a
  scenario that failed halfway does not fail the ones after it; the sandbox scenarios open Hera 6 XL again if sandbox
  mode is gone.
- **One scenario by name:** `npm run emu:scenarios -- --only tieLire` (or `--only tieLire,tie808`) reruns just those;
  `connect` always runs first, since it opens the editor and syncs, which the others need. `--list` prints the names; a
  name that is not a scenario stops the run before anything starts. `device:scenarios` takes the same.
- **A host that stops reading (`deafHost`, issue #375):** every other scenario has Chrome reading the FM-1's MIDI, so
  the FM-1's queue for the editor always empties. `deaf 1` makes `m1emu serve` stop taking packets from the mailbox; the
  firmware's SysEx queue then fills, as on a computer where no app reads the FM-1, and every message the FM-1 sends
  unasked goes through the same `ota_wire_send` wait as over USB. The scenario enters 30 steps on the 808 Kit's SEQ
  page at a hand's pace, then SEQ must close the page within 400 emulated ms (about 140 with a reading host; 2890
  before the fix of #375). After `deaf 0` the editor must follow a step entered on the FM-1 and sync a patch again.
  The first message after such a stall is a SysEx cut short (the FM-1 gave up halfway); `m1emu` drops it at the next
  F0, as a MIDI receiver should (Chrome's Web MIDI parser, by its source, does the same), and says so on its output.
  The host side alone is in `tools/usb_test.sh` (`firmware/test/usb_test.c`, `test_deaf_host`).
- **Ties on the SEQ page (`tieLire`, `tieElvira`, `tie808`, `tieRoll`, issue #368, [D-531](ledger/steps.md#D-531)):** on
  8 Lire, Elvira 2 and the 808 Kit's drum grids and Silver Box's piano roll, the track is cleared (SEQ held + REC twice)
  and a hit goes on step 1. LFO held + step 4 must tie it through step 4 in one press, as the editor's copy of the track
  (the FM-1's TRACK_NOW) shows. LFO + step 2 (inside the note) must end it there (2 steps), and LFO + step 2 again (its
  last step) must make it one step. LFO + step 1 (the hit's own step, nothing before it) must make it a drone (DRONE; issue #384,
  [D-819](ledger/steps.md#D-819)), on 8 Lire and Elvira 2 holding at 80 % of its peak or more through a pass and its loop
  point, and LFO + step 1 again must make it one step (TIE OFF). `rowDrone` (8 Lire): three hits on row 1, LFO + FX must leave one drone on the first (DRONE), heard holding through the loop point, and FX + LFO again one step (DRONE OFF). Tied again, a plain white key on step 3 must cut it there and start a hit. With the transport running
  the peak is read in 25 ms windows over a pass. On 8 Lire and Elvira 2 a tied hit must keep 90 % of its peak through
  the next 300 ms (the tie holds the gate 406 ms), and an untied one must decay below 85 %. On the 808 Kit a tied hit's
  peak and decay must match the untied one's. Only a hit whose next 300 ms the profile covers counts (issue #520): on the
  rig a window is a round trip longer than 25 ms, so a profile also catches the start of the next pass's hit, cut off by
  the profile's end. Through the device test mode (device:scenarios, or `--via-emu`) the
  TEST_SCREEN head's patch buttons must show Main's LFO jack down while LFO is held on the SEQ page, and up while it is
  held on the device page.
- **Arming (`arming`, issue #395, [D-235](ledger/device-ui.md#D-235), [D-545](ledger/steps.md#D-545)):** the checks
  read the FM-1's screen, and the editor's armed set, which follows the FM-1's over the link (ARMS_NOW, #191, [D-802](ledger/steps.md#D-802)). The 808 Kit must load
  with the footer saying KEYS WIRED. SEL on its home device, the Drum map, must say NOTHING HERE TAKES KEYS. The SEQ page
  must arm DRUMS (its bar says DRUMS ARM, the device page's footer ARM DRUMS), and black key 1 must then sound the kick.
  On the environment, SEL on DRUMS' row must disarm it and say KEYS WIRED. REC there must start the transport and say
  REC: NO TRACK ARMED with the environment still showing ([D-548](ledger/steps.md#D-548),
  [D-549](ledger/steps.md#D-549)); PLAY stops it. SEL again must arm it. Monolith D opened with every keys cable gone
  (the test hook `openUnkeyed`) must say NO KEYS REACH THIS DEVICE on SEL and arm nothing ([D-905](ledger/device-ui.md#D-905)).
  Basic Poly opened the same way (a poly engine) must say it on SEL on its device page and on its environment row, and
  the editor must show nothing armed ([D-818](ledger/steps.md#D-818)).
- **A held drum hit (`drumHold`, issues #368 and #395, [D-523](ledger/steps.md#D-523)):** on 8 Lire's grid, stopped, a
  held black key must sound its row while held and record nothing. REC alone (no PLAY) must then start the transport
  and record: black key 2 held about 450 ms must land as one note of 3 to 5 steps on its row, and a white key must then
  place a step on the row that black key picked. PLAY stops the transport and the recording.
- **Play once (`playOnce`, issue #632, [D-820](ledger/steps.md#D-820)):** on the 808 Kit, SEQ held + PLAY must count in
  with a click on each beat (the peak in 25 ms windows over the first 1.2 s: one onset a beat, a beat apart, the beat
  read from the first two), the bar must say `COUNT-IN`, and the transport must stay stopped meanwhile (no Start reaches
  the editor). After the count-in the bar says `PLAY ONCE` and the FM-1's Start reaches the editor; half a pass in it
  still runs, and after the pass it stops by itself (its Stop reaches the editor). SEQ held + PLAY again, then PLAY a beat
  later, must end it with nothing started.
- **REC's count-in (`recCountIn`, [D-803](ledger/steps.md#D-803)):** on Init (an empty track, no key held), GLO > PANEL >
  COUNT-IN set to 1 BAR, REC from a stop must start the transport, say `COUNT-IN` and click on each beat (as play once's
  check reads them); once it records, a second bar must be silent. PLAY stops it and COUNT-IN goes back to OFF. The
  emulator plays the analog output (USB audio is not emulated), where the click is.
- **When:** every pull request that changes firmware runs `emu:smoke` and `emu:scenarios` on its own CI build before it
  merges ([D-120](ledger/releases.md#D-120)).

Not covered: plugging and unplugging USB, the installer and the update loader, USB audio.

## The test rig: the same scenarios on a real FM-1

The device test mode (issue #291, [D-121](ledger/releases.md#D-121)) lets a script drive a real FM-1 over the editor
link as `m1emu serve` drives the emulator:

- **The firmware's side:** TEST_KEY and TEST_TURN (`firmware/src/proto.c`, `web/src/protocol.ts`) put a key or an
  encoder's clicks into the HAL's scan (`fm1_virt_btn`, `fm1_virt_note`, `fm1_virt_enc` in `firmware/hal/fm1_input.h`),
  so they take the panel's own paths. TEST_SCREEN reports the texts on the LCD with their boxes: every text the fonts
  draw is noted as it goes out and dropped when something is drawn over it (`firmware/src/screen_text.h`). TEST_PEAK
  reports the loudest sample since the last ask, read before the MASTER knob as if it sat at its default, so a knob
  left down fails nothing ([D-124](ledger/releases.md#D-124)); a flag says when MASTER is all the way down. INFO feature
  bit 9 says the firmware has them. For 10 s after a test key or turn, the panel refuses UPDATE MODE and FACTORY RESET.
- **The rig** ([D-122](ledger/releases.md#D-122)): the owner's second FM-1, kept on the Mac. `npm run rig -- register`,
  with the rig the only FM-1 connected, writes a hidden preset (`RIG_STRUCTURE`, values at random) and keeps the values
  in `~/.config/matryoshka/rig.json`; the Library does not list that preset. It also keeps the rig's USB location there
  (issue #698): the number macOS gives the USB socket the rig is plugged into, hub ports included. Moved to another
  socket, the rig is registered again (alone; the mark stays). `npm run rig -- check` names the rig among the connected
  FM-1s and says whether the FM-1 at the rig's USB location carries the mark. `tools/fm1_usb.py list` prints each USB
  MIDI device's location.
- **`cd web && npm run device:scenarios [-- --install RUN [--gate boot]] [--only NAME,..] [--headed]`:** the scenarios of
  `emu-scenarios.mjs` on the rig. The rig's page (`/__rig` on the dev server, `web/dev/rig-client.ts`) finds the FM-1s,
  asks each its INFO and the mark (nothing else), and drives only the rig; the editor's page sees only the rig's ports.
  `--install RUN` first installs that firmware CI run on the rig ([D-123](ledger/releases.md#D-123)): after `emu:smoke`
  and `emu:scenarios` passed on that run's builds, through `tools/fm1_install.py --rig`. That installer sees only the
  MIDI ports at the rig's USB location, reads the mark there before it sends anything, and refuses when the FM-1 there
  is not the rig (exit code 9). Another FM-1 may stay connected: nothing reaches it (issue #698). `--rig --dry-run` runs
  the same checks and says what it would install where, sending only the identity handshake and the mark's read. A rig registered before
  #698, with no location kept, must still be the one FM-1 connected. A rig left in update mode is finished by hand,
  `tools/fm1_install.py PACKAGE --location 0x01130000`, never by a script. A build whose
  `scenarios.passed` holds its sha256 is not run through `emu:scenarios` again, as `smoke.passed` skips `emu:smoke`. With `--gate boot`,
  for the owner's iteration checks, after the boot check (`emu:boot` on the run's two builds, about 30 s) instead; a
  merge or a release still needs the full checks. Each gate's result is kept next to the download
  (`build/flash/RUN/smoke.passed`, `boot.passed`, `.failed`, `.log`), and `build/device/scenarios/install.json` and the
  run's last lines say which gate the installed build passed. The Install panel of the dev server and `npm run flash`
  install on any FM-1, so they keep `emu:smoke` ([D-171](ledger/firmware-install.md#D-171)). Results and the
  screen as text go to `build/device/scenarios/`. Before the scenarios the runner taps HOME until the screen reports
  the device page (the menu, GLO, SEQ or a preset list left up), and stops with a message if it never does. The volume
  never stops a run ([D-125](ledger/releases.md#D-125)): on a rig whose firmware reads its peak after MASTER (no INFO
  feature bit 10), a check that hears nothing is skipped as "MASTER down"; skips are counted apart and are no failure.
- **The owner's own FM-1 beside the rig (issue #698).** The rig's scripts may run while the owner plays their own FM-1
  in Chrome on the site. The rig's page asks the other FM-1 only HELLO and PRESET_GET, and the installer and the
  recorder go by the rig's USB location. While the editor is connected to one FM-1, it plays nothing from another
  FM-1's MIDI, so the rig's test keys and its PLAY do not reach the owner's page. The editor's Connect still takes the
  first FM-1 that answers, which can be the rig. A rig install restarts the rig twice on USB (into update mode and back),
  but not macOS's MIDI service (`MIDIServer` ran on through the rig install of 2026-11-06). In the two-device test of
  2026-11-06, Chrome still heard the owner's FM-1 after a rig install. Never restart `MIDIServer`
  (`killall MIDIServer`) while the owner plays: Chrome then hears no MIDI until it is quit and opened again.
- **`cd web && npm run rig:bench [-- --patch NAME] [--rounds N]`:** the LCD's draw times on the rig, with the rig the
  only FM-1 connected (it refuses otherwise, before sending anything but INFO and the mark's read). It zeroes the times,
  pages with ALGO and SELECT, turns K1..K4, opens and closes GLO and steps PRESET on and back, then prints the last and
  the worst time of each kind of draw. The firmware keeps them (`ui_time` in `firmware/src/ui.c`: `fm1_ticks` around
  each draw, the LCD's transfers included) and reports them as DIAG pages 121..123 (page 120 zeroes them);
  `tools/m1_link.py uitime` reads the same. Run on two builds, it compares them.
- **A TEST_PEAK asked again (#385):** about one TEST_PEAK in 500 gets no answer on the rig, and the rig's page asks
  again 2 s later. That answer holds the loudest sample of the whole 2 s. The scenarios' peak profiles (`windows`) leave
  such a long window out and print a note; before, it read as one window at a hit's level out of nowhere. The window
  after it is flagged, and the tie checks take no hit whose 300 ms the gap overlaps (issue #520).
  `cd web && node scripts/rig-peak.mjs [--patch NAME] [--play] [--key] [--reads N] [--raw]` reads the peak in 25 ms
  windows on the rig and counts the long windows and the loud windows their neighbours do not explain.
- **`npm run device:scenarios -- --via-emu`:** the device path against the emulator (its build has the test mode too),
  to check the runner and the firmware's side without a rig.

### The release's device check as scenarios

The owner's device check of release 1.10 had 40 steps. Every step that needs no ears, no hands and no power switch is
now a scenario in `web/scripts/device-check.mjs`. These scenarios run after the others, in `emu:scenarios` and in
`device:scenarios`. They must pass on the rig before a release candidate. The owner's own check is then only what they
leave out: the analog output heard in headphones and recorded over a mono cable, each instrument played by hand to judge
its feel, and every step across a power cycle ([D-139](ledger/releases.md#D-139)). A check that needs a recording it cannot trust is skipped, not failed ([D-140](ledger/releases.md#D-140)).

- **The scenarios.** There is one scenario for each section of the check. Each check's name starts with its step on the
  check's page: `1.3` is section 1, step 3.
  - `checkOutput` (steps 1.1 to 1.5, [D-918](ledger/device-ui.md#D-918), [D-919](ledger/device-ui.md#D-919)): GLO >
    SYSTEM > OUTPUT steps through STEREO, MONO and MONO L and stops there. `T110 MONO L R` has a saw on the left and a
    sine an octave higher on the right. Each side's level at the two pitches says which sound is on which side. Meridian
    8 sits in both ears in STEREO, and in MONO it is as loud as in STEREO.
  - `checkVerona` (steps 2.1 to 2.5, [D-862](ledger/patches-and-presets.md#D-862) to
    [D-866](ledger/patches-and-presets.md#D-866)): the header reads VERONA DRUM1. A white key plays nothing and the bar
    says DRUMS: BLACK KEYS 1-8. The hi-hats are measured as peaks in 25 ms windows. A closed hit cuts the open hat in
    both orders of pressing. An open hit pressed while the closed key is held rings on (#657). Verona Drum 1 XL goes to
    sandbox mode, and the browser's own output (an analyser on the editor's engine) plays every black key and no white
    key. Which drum each black key plays is judged by ear only on the owner's page.
  - `checkRowDrone` (steps 3.1 to 3.4, [D-819](ledger/steps.md#D-819)): on `T110 DRONE`, LFO held + FX makes row E3 one
    drone and removes its second note. E3's own pitch holds over the loop point with no new attack. Again it is one
    step, and an empty row says NOTHING TO DRONE.
  - `checkLiveDrone` (steps 3.5 to 3.7): step record's bar and hint on `T111 LIVE DRONE`, and FX + LFO there is a rest.
    A key held for 3 s in a live take becomes a drone that holds round the loop. The editor's roll draws it across the
    whole track. PLAY releases it, and leaving the page says PATTERN STAYS ARMED.
  - `checkDelays` (steps 4.1 to 4.5, [D-375](ledger/engine.md#D-375), [D-376](ledger/engine.md#D-376)): on
    `T111 TWO DELAYS`, one note gives an echo on the right at 300 ms and one on the left at 1200 ms. On the FM-1, LENGTH
    says SET IN THE EDITOR and TIME stops at the length. The editor's budget shows 129 / 190 KB of effect memory with a
    line for each Delay, and a click on a line selects its card. Dragging SHORT's length to its top stops at 700 ms with
    the note that says why. The patch then goes to the FM-1 again and both echoes still play.
  - `checkNoKeys` (steps 5.1 and 5.2, [D-905](ledger/device-ui.md#D-905), [D-295](ledger/patch-format.md#D-295)): on
    `T111 NO KEYS` the engine's ARM dot is dashed and arms nothing. On the FM-1, SEL says NO KEYS REACH THIS DEVICE and
    the keys play nothing.
  - `checkStore` (steps 6.1 to 6.4, [D-959](ledger/editor.md#D-959), [D-297](ledger/patch-format.md#D-297)):
    `T110 DRONE STORED` holds its drone. "Store to an FM-1 slot…" lists the 64 slots. A used slot says what it holds and
    the button reads Replace. Store goes into the first empty slot. With Live on, HOME held + PRESET says EDITOR LIVE:
    PATCH STAYS. With Live off, PRESET away and back to that slot still plays the drone. The slot is emptied again at the
    end.
  - `checkOldPattern` (step 6.5): Silver Box's bytes as release 1.9.1 wrote them into the bank (format 48, kept in
    `web/scripts/check-old-patch.json`) go into an empty slot. Loaded with PRESET, its pattern 2 plays as today's Silver
    Box does. That an older binary renders the same as on its own release is proven on the host by
    `tools/old_format.sh`.
  - `checkTeach` (steps 7.1 to 7.3, [D-247](ledger/device-ui.md#D-247), [D-917](ledger/device-ui.md#D-917)), with Live
    off: PRESET to <7PH says 2 SOUNDS: ENV THEN SEL. REC held shows the ARM: hint, and REC held + a black key arms a
    second track (ARM DRUMS +1) and starts nothing. PLAY held shows TEMPO n: TURN PRESET, and turning PRESET then
    starts nothing.
  - `checkDualCore` (steps 8.1, 8.2 and 8.4, [D-380](ledger/engine.md#D-380)): INFO's PROCESSOR row reads 2 CORES. Io 4,
    Hera 6 and Cassia 1 each play 8 held keys with nothing shed, no overload (DIAG pages 119 and 127) and no dropout in
    the recording. On the rig, the INFO tab's CPU row must read under 80 % with the keys held. Monolith D and Simple FM
    sound.
- **The test patches** are built in `web/scripts/check-fixtures.mjs` from the check page's descriptions. Each run keeps
  them in the editor's Your patches, as the owner keeps them. `web/src/check-fixtures.test.ts` checks that each one is
  what its description says and fits the FM-1.
- **How they hear the FM-1.** Besides TEST_PEAK and the screen's texts (TEST_SCREEN), these scenarios record what the
  FM-1 plays (`web/scripts/audio-capture.mjs`). On the emulator the recording is its I2S output, from `m1emu serve`'s
  `wav`. On the rig it is the FM-1's USB audio, recorded on the Mac by `tools/fm1_rec.swift` from the input at the rig's
  USB location: the FM-1 has no USB serial number, so macOS's id for its audio input holds that location
  (`AppleUSBAudioEngine:brighght studio:Matryoshka:1130000:1,2`). Without a location kept, it takes the input named
  "Matryoshka", which only works while the rig is the one FM-1 connected. That small recorder uses Apple's AVAudioEngine and is built into `build/` the first time it is
  needed, with `swiftc` from Xcode's command line tools. ffmpeg's avfoundation input is not used: on 2026-11-06 it kept
  only 9.2 s of a 30 s capture of the rig and joined the pieces with no gap, while AVAudioEngine kept every sample. On
  the emulator the run opens the rig's page on the emulator's MIDI port
  before the editor's page, for the screen's texts and the DIAG pages.
- **What the rig's recording cannot show.** The FM-1 takes its USB audio before GLO > SYSTEM > OUTPUT mixes the sides
  and after MASTER (`firmware/src/audio.c`). GLO > SYSTEM > 3.5MM OUT
  silences the analog output only, so the rig's recording must stay as it was when it is OFF. So the MONO and MONO L checks hear the emulator only, and on the rig they
  are skipped. A check that needs the recording is also skipped, not failed, when there is none: the recorder cannot be built,
  MASTER is all the way down, or a second FM-1 is connected and the FM-1 at the rig's USB location does not carry the
  mark (or no location is kept), so which audio input is the rig's is not known. It is also
  skipped when MASTER is so far down that the recording's loudest sample is more than 26 dB under what TEST_PEAK heard.
  TEST_PEAK reads as if MASTER sat at its default, so such a recording is lost in the USB audio's own noise. Skips are
  counted apart, as for MASTER down ([D-125](ledger/releases.md#D-125)).
- **The USB audio stream itself.** USB audio is a feature the FM-1 ships, so a stream it opens and then stops feeding is
  a failure, not a skip. The check "USB audio streams" fails when no audio comes within 8 s, or when less than 80 % of
  the expected audio arrives. Its message carries the FM-1's USB audio counters (DIAG pages 125 and 126). The checks that
  needed that recording are skipped. The first recording that flows passes it once in a run.
- **The keys' octave.** A device run first brings the keys' octave back to 0 with OCT- or OCT+. The checks know a device
  page by the footer's "= OCT =", and the rig was once left at OCT +.
- **The rig's bank.** `checkStore` and `checkOldPattern` store into the bank's first empty slot and empty it again.
  With no empty slot they skip those checks. `checkStore`, `checkOldPattern` and `checkTeach` turn Live off and back on.

Not covered: the analog output (the codec; the device check's scenarios record USB audio, which comes before OUTPUT's
mix), USB plugging, the scenarios' sound judged by ear.

## The smoke test (`tools/emu/src/smoke.rs`)

It reads the LCD with the firmware's own font (`font.rs` parses `font5x7.c` and finds a string drawn by
`text_dots` exactly), so it needs no symbols and runs on the release binary. Steps (the list at the top of `tools/emu/src/smoke.rs`): the loading screen, the
device page of factory patch 0; silence, a panel key, silence after the release; GLO (Main's global page), PLAY, HOME,
HOME held (the menu), HOME; the PRESET encoder; TRS MIDI program change and notes, then every factory patch in turn
(name shown, sound, its peak against the web engine's, from `web/scripts/emu-levels.ts`, within 6 dB as a warning);
SAVE, the flash kept, a restart (STATE RESTORED and the state back); a patch bank written straight into the flash
(three slots and one with a bad CRC; PRESET and program change step through the three and wrap); the first boot's
factory bank on both flash chips the FM-1 ships with (the Puya P25Q80H and the UC25HQ80, #739), and NO FLASH ID with
nothing written on any other chip; the safety steps
(shedding and OVERLOAD, safe mode, update mode); the patch buttons and the SEQ page on the 808 Kit; a Delay
with its line in each of the two line areas (#273, #651: 700 ms and 290 ms, plain and ping-pong; every 128-frame block of
each echo against the same block of the note, at exactly the Delay's time); no register
fm1-emu does not model besides P33. Snapshots of each step, a WAV and the levels table go to `build/emu/`.

**The flash chip.** The emulated flash answers the Puya's JEDEC ID (85 60 14) unless `M1EMU_JEDEC` names another one
as six hex digits (`M1EMU_JEDEC=B36014` for the UC25HQ80, #739). Every machine of `m1emu` and `emu:scenarios` then
boots with that chip.

**Stack depth (#273).** `m1emu` fills 0x01C60000..0x01C7C000 with the word 0x5AC3A55C before the first instruction (the
firmware paints its stacks with the same word since #273, so a build from before is measured too). At the end, `smoke`
prints the runs of that word nobody wrote, over every machine of the run: a stack's run ends where its deepest use began
(top minus that = the most it held). `run` prints it for its one machine, `serve` answers `stacks` with it and writes it to
stderr on `quit` (so `emu:scenarios` shows it). See "Memory map since #273" in [ARCHITECTURE.md](ARCHITECTURE.md).

## What it does not cover

- **USB is not emulated**: the smoke test leaves out the editor's SysEx link and USB MIDI (`emu:scenarios` covers them, above), firmware installs (M-UPGRADE, the loader), recovery and
  the UBOOT SysEx are untested by it. The bank is therefore seeded in the flash image, not uploaded.
- **P33** (watchdog, reset reason, reboot, UBOOT entry: `firmware/hal/fm1_sys.h`) is not modelled: the boot-loop
  guard and MENU > UPDATE MODE cannot be checked.
- **Timing**: one instruction per cycle at 240 MHz, no cache or flash wait states. The CPU figure in the top bar
  (303 Acid 11-12 %, the device measured 12 % at M1-0.2) is a rough guide only; the window at 120 MHz shows twice it.
- **fm1-emu's AArch64 JIT** (macOS only) renders our engine wrong at `7ca5b96`: most factory patches came out 20 to
  50 dB too quiet, differently from run to run, while the interpreter matches the web engine within a few percent
  (Square Lead's envelope sample for sample). `m1emu` and `npm run emu` therefore use the interpreter (about 0.75x
  real time at 240 MHz, so the window runs at 120 MHz); `M1EMU_JIT=1` turns the JIT back on.

## Found with it (2026-10-17)

- HOME press stored `fm1_ms | 1` with bit 1 as the "hold fired" flag, so about every second press (fm1_ms's own bit 1)
  was ignored: no tap, no menu. Fixed in `buttons_poll` (main.c); the fix has not run in the emulator yet (it needs a
  JieLi build).
- After a restore the top bar reads STORED PATCH, not the patch's name.
- Echo Pluck comes out about 4x louder than the fresh web engine in the patch sweep (a level warning; probably state
  carried over from earlier patches, such as the delay's tempo estimate, not checked).
