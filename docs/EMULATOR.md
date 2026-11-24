# The firmware on an emulated FM-1

[fm1-emu](https://github.com/joakimeriksson/fm1-emu) (Joakim Eriksson, MIT) emulates the FM-1's JieLi AC791N: the
pi32v2 cores, timers, interrupts, SPI flash, the 240×240 LCD, the key matrix and encoders, the MASTER pot, the I2S
audio and the TRS MIDI input. Our `matryoshka.bin` runs on it unchanged. `tools/emu/` is a small Rust crate (`m1emu`)
on fm1-emu's `fm1-core` / `fm1-soc`, pinned to commit `7ca5b96` in `tools/emu/Cargo.toml` (a git dependency, nothing
of fm1-emu is copied into this repository). Two changes are applied to it at build time: `tools/emu/isa_fix.sh` copies
fm1-emu's `fm1-isa` crate from cargo's checkout into `tools/emu/target/fm1-isa` and corrects its decoder entries, and
copies `fm1-core` into `tools/emu/target/fm1-core` with the hook the timing model needs (`tools/emu/core_timing_patch.py`,
below) and the semantics of the fourth fix's shifts and the sixth fix (`tools/emu/core_isa_patch.py`). It writes a cargo config file that patches both in and prints its path for `--config` (`emu_smoke.sh` and `npm run emu` do this for m1emu). fm1-live cannot take that patch (inside fm1-emu's workspace fm1-isa is a path dependency: cargo says "patch was not used"), so `tools/emu/live_build.sh` builds it from a copy of the pinned checkout with the fixed fm1-isa swapped in and `core_isa_patch.py` applied (`tools/emu/target/fm1-emu-src`); fm1-live builds without all six fixes (markers `.isa-fixed` to `.isa-fixed-6`, not `.isa-fixed-7`) are rebuilt. The first entry: the
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
now. The fourth (2026-11-16): the read-modify-write shifts by a register, `[R+#i] op= R` (`6e e8`), had only `>>=` and
`>>>=`, each fitted to its one corpus sample with constant operands, so `[r0+0] <<= r2` (`6e e8 00 02` in `ring_scale`,
#978; JieLi's compiler fuses even a volatile read, shift and store into it) stopped every smoke and scenario check at
pc 0x020267e0. All four (`<<=`, `<<<=`, `>>=`, `>>>=`) now have pi32v2-isa's layout (`rmw.lsl.r` etc.: base = bits
28..31, count register = 24..27, offset = 4 × sext(bits 18..23), op = bits 16..17) and the semantics measured on an
FM-1: the word at base + offset is shifted by the register's low 8 bits (32 or more acting as 32, `<<<` saturating) and
written back, registers and flags untouched; fm1-core's store arm had no shifts, so `core_isa_patch.py` adds them
(`cargo test` in `tools/emu` runs all 65536 encodings). fm1-core already runs `#` pairs with the second instruction
seeing the old registers. The fifth (2026-11-17): the read-modify-write `[R+#i] &= ~R` (`64 e8`, op 3) had a three-bit
register slot (bits 24..26: its corpus samples cleared with r0..r7 only) and a mask that pins bit 27, so `[r13+4] &= ~r14`
(`64 e8 07 de` in `panel_key`, a Harmonizer's chord button let go on the FM-1's keys, #1053) stopped the emulator at pc
0x020496e8: no check had ever let go of a chord button. It takes the register from bits 24..27 now, as its siblings
`[R+#i] |= R`, `^= R` and `&= R` do; fm1-core already ran it. The sixth (2026-11-22, #1196) is in fm1-core, not the
decoder: a `goto` out of the then-part of a predicated `if (..) { .. } else { .. }` ends that construct. fm1-core kept
the else-part's skip pending while the program counter stayed below the then-part's end, and a pending skip holds every
interrupt back. `pal_changed` (palette.c) compiles to `if (r2 == 0) { goto pal_now_send } else { .. }`, a tail call to
a lower address, so all of `pal_now_send` ran with the interrupts held: TIMER5 stopped, `fm1_ms` stood still and the
SysEx ring was never emptied. A `PALETTE_NOW` (87 USB-MIDI packets, the ring holds 64) then waited in `usb.c` `sx_room`
for ever, and the emulated FM-1 stopped answering after its first palette change once an editor had asked for the
palette. Each pending skip now keeps the start of its then-part, and a jump from inside the then-part to outside it
drops the skip; a call keeps it, since it returns into the then-part. The firmware has two such tail calls (`eng_maps`
is the other) and no call inside a then-part that has an else (`cargo test` in `tools/emu`:
`goto_out_of_if_else_ends_it`). The firmware CI keeps the ELF and its disassembly (artifact `matryoshka-elf`) for
tracing such faults to a function.

## Choosing checks

Full emulator checks run locally, outside continuous integration (CI) ([D-101](ledger/releases.md#D-101), Decided).
Choose commands using the canonical stage rules:

- **Agent branches → `main` → frozen candidate:** [D-145](ledger/releases.md#D-145) defines branch roles;
  [D-144](ledger/releases.md#D-144) defines targeted checks and review before the freeze.
  On a pull request, "targeted" means `emu:scenarios -- --only NAME` for each scenario the change adds or changes.
  A pull request never runs the full `emu:smoke` or a full `emu:scenarios`.
  The exceptions are installs: `emu:boot` before the test rig ([D-123](ledger/releases.md#D-123)), `emu:smoke` before any other FM-1 ([D-153](ledger/firmware-install.md#D-153)).
- **Frozen release candidate and fixes:** [D-144](ledger/releases.md#D-144) defines the full run and affected revalidation;
  [D-146](ledger/releases.md#D-146) governs the final artifacts carried through qualification and publication.
- **Registered test rig:** [D-123](ledger/releases.md#D-123) governs installation; [D-141](ledger/releases.md#D-141)
  governs targeted hardware checks and candidate qualification. Other FM-1 installers follow [D-171](ledger/firmware-install.md#D-171).

The full emulator suites are `emu:smoke` and `emu:scenarios` without `--only`. A full `emu:scenarios` runs on four
emulators at once ([D-1157](ledger/releases.md#D-1157)). For a frozen candidate, one command runs both suites in the one
slot ([D-143](ledger/releases.md#D-143)): `npm run emu:scenarios -- BRIDGE_BIN --smoke RELEASE_APP_BIN`. The seven
editor-side scenarios of [D-1158](ledger/releases.md#D-1158) (`PER_PR_SCENARIOS`) are not in the full run: a pull request
that changes what they check runs them with `--only`, as its plan in `tools/ci_checks.json` says. The test rig can
start after the boot check, beside the emulator suites ([D-141](ledger/releases.md#D-141)). For a focused scenario, see the
named-scenario command below. Host and web CI use the changed-domain plan in `tools/ci_checks.json`
([D-102](ledger/releases.md#D-102)). Explicit RC dispatches require the exact frozen commit. Required build checks
remain separate ([D-100](ledger/releases.md#D-100), [D-116](ledger/releases.md#D-116)).

A changed path that no rule names runs more checks, never a planning failure: the full host suite for a firmware path,
the companion test for a web path. Rules marked manual (the native recorder, the exact-engine harnesses, emulator
fixtures) print a review note in the plan; CI reports it as review input, never an automated pass. Main pushes still run targeted checks because CI has no
reliable record for reusing a previous pull request's results. Coverage display records follow
[D-147](ledger/releases.md#D-147); deployment does not run tests.

The final-artifact process is decided in [D-146](ledger/releases.md#D-146), but publication checks are not yet automated.
The release workflow builds versioned firmware; package-only mode establishes no test qualification.
Local smoke and boot markers use timestamps, while scenario markers check the emulator-bridge hash.
They do not prove that the package being published is the qualified final artifact.
Evidence from a candidate frozen as a DEV build remains evidence about that build; it cannot make those bytes
a final-version package. Resolving that transition requires a release plan, not a relabel or an automatic test rerun.

## Preparing the coverage display

Use [D-147](ledger/releases.md#D-147) when preparing a release's About figures. A successful RC web workflow uploads
`coverage-<commit>` with `coverage.json` and `manifest.json`. After downloading that bundle, retain it in the repository:

```sh
python3 tools/coverage_record.py prepare --bundle build/coverage-record --release vX.Y.Z --ref CANDIDATE_COMMIT
```

Commit the resulting `release/coverage/vX.Y.Z/` before tagging. The stored bytes survive Actions artifact expiry.
The source fingerprint includes tracked tests, dependencies, configuration and build inputs. It excludes `docs/`,
root Markdown guidance, agent guidance directories (`.agents/`, `.claude/`, `.codex/`), `release/` (the qualification
and coverage records) and `web/public/firmware/` (the bundled package): the release record adds those after the
candidate is measured.
A version or source change can therefore invalidate a current measurement. The helper never starts another test run.

For the transition from the already-tested candidate that has no coverage report, explicitly retain the published
v1.12.0 measurement:

```sh
python3 tools/coverage_record.py prepare --bundle release/coverage/v1.12.0 --release vX.Y.Z --historical
```

This keeps the original date and the label “Last measured on v1.12.0”; it is display history, not qualification.
The seed records the published URL, capture time and report hash. Its original test-run provenance is unknown.
Legacy v1.12.0 builds retain their original date display; newer About cards also show the measurement release.
A deployment reads only the explicitly prepared record for its version. Missing records fail with the preparation
command; deployment neither downloads arbitrary reports nor reruns tests.

## Commands

- `cd web && npm run emu:smoke [-- FIRMWARE]`: the smoke test (below). Its parts each boot their own machines, so they
  run side by side, a thread each (`run_parts` in `tools/emu/src/smoke.rs`); each part's lines print in order once it is
  done, then its emulated and wall time. About four minutes on the M3 Max (1.18.0: 309 checks, 436 s emulated in 217 s;
  the longest parts are steps 1 to 7 on one machine and the SEQ page). The first part's snapshots are named `NN-step.png`;
  the others' start with the part's name.
- `cd web && npm run emu:boot [-- FIRMWARE] [--link EMU_BIN]`: the [**boot check**](ledger/vocabulary.md#boot-check)
  (`m1emu boot`, `tools/emu/src/boot.rs`, built on the smoke test's checks), about 25 s (1.18.0: 37 s emulated in 23 s,
  its four parts side by side).
  On FIRMWARE, the bytes that get installed: the loading screen draws, the quick start and then the home page (factory
  patch 0) come up, silence without keys and sound from a panel key, no register fm1-emu does not model besides P33,
  and OCT- + OCT+ held at power-on enters update mode with the flash chip known. On EMU_BIN, the same commit's
  `M1_EMU_MIDI=1` build (the plain build has no link the emulator can reach): HELLO is answered with INFO from the
  loading screen and on the home page, and the update protocol's handshake (`ota.c`) is answered with a Matryoshka
  identity (`FM-1_7..`) after boot and in update mode. That handshake is how the Install panel and `fm1_install.py`
  find the FM-1, so a build that answers it keeps the way back. EMU_BIN also installs the factory region over the link
  on a blank flash, and on a bank an earlier release left (`slot-upgrade`: the released copies of
  `firmware/test/released_cases.h` in their slots, an edited and a renamed copy beside them, no region), where the
  untouched copies must get today's patches and the others stay ([D-887](ledger/patches-and-presets.md#D-887)).
  Without `--link` it takes `matryoshka-emu.bin` or
  `emu-midi/matryoshka-emu.bin` next to FIRMWARE, else the CI run's `matryoshka-emu-midi` artifact, else it checks no
  link and says so. The last line is the summary (`boot check: PASS ..` / `FAIL ..`); snapshots go to `build/emu/boot/`.
  It is the test rig's gate while the owner iterates ([D-123](ledger/releases.md#D-123)), not a merge or release gate.
- **Queued gates:** `emu:smoke`, `emu:boot`, and `emu:scenarios` share one slot across checkouts on this Mac.
  They print when they enter the queue and when their run starts. The operating system releases the slot after a
  killed runner; no stale lock directory needs deleting. This implements the limit in [D-143](ledger/releases.md#D-143).
  Choose when to run them using [D-144](ledger/releases.md#D-144).
  Scenario output includes a progress line every 30 seconds. `build/emu/scenarios/run.json` identifies the firmware
  by its SHA-256 digest. `results.json` is updated after each check, and `progress.json` names the current scenario and
  unanswered emulator commands. Each check in `results.json` names its `scenario` and the wall time it took in `ms`
  (since the scenario's previous check, or its start). `timings.json` gives each scenario's wall time, the emulated
  time it spent (`emuMs`), its checks and its failures, with the setup before the first scenario as `(setup)`; the
  output prints the same after each scenario. An unanswered command fails after two minutes; a whole scenario fails
  after ten. A timeout saves a failure report and stops the run. It does not start another scenario beside the
  unfinished one.
  Smoke tests have a thirty-minute deadline; boot checks have five minutes. They print elapsed time every thirty seconds
  and stop their child process group on a timeout or interruption.
  While a gate runs on macOS, it prevents idle sleep. The display can sleep. Closing the lid can still suspend the Mac
  and interrupt MIDI uploads; leave the lid open or use a supported closed-display setup.
  `device:scenarios` still runs alone because there is one test rig. Direct emulator binaries do not join the queue.
- `cd web && npm run emu [-- FIRMWARE]`: the firmware in fm1-live's window (LCD, keys, buttons, knobs, sound, every
  MIDI input into the TRS jack; fm1-live prints its key map; built once into `tools/emu/live/`).
- Without FIRMWARE both take `build/matryoshka.bin`, else download the latest firmware artifact of a successful
  `firmware` run on `main` with `gh` (`build/emu/ci/`), else unpack `web/public/firmware/matryoshka.fwsc`.
- Every `m1emu` command reads the factory region and the firmware headers it checks against when it starts, from the
  checkout it runs in: the nearest directory at or above the working directory holding `tools/emu/Cargo.toml`. The
  region is `web/public/firmware/matryoshka-factory.bin`, or the image `--factory FILE` names; the headers are
  `presets.h`, `factory_tier.h`, `engine.h`, `defs.h`, `font5x7.c` and `font_bc.h` in `firmware/src/`, and
  `pmig_cases.h` and `released_cases.h` in `firmware/test/`. None of them is compiled in. Worktrees share one
  `tools/emu/target` ([D-074](ledger/project.md#D-074), Decided, amended), so its binary is the one the last checkout
  built, and cargo does not rebuild it for another checkout's changed files: a compiled-in region ran kit-fold's
  firmware on main's factory sounds (#1205). The runners pass their checkout's image. `m1emu` prints the region it loaded
  on stderr: `factory region: PATH (layout L, version V, set S, N patches)`. A change to `tools/emu/src` itself still
  needs its own `tools/emu/target`.
- `tools/emu_smoke.sh [BIN]` is what `emu:smoke` runs (`M1EMU_STRICT=1` makes
  level warnings fail). `tools/emu/target/release/m1emu run BIN --ms N --keys SCRIPT --snap MS,.. --wav F
  --flash-in F --flash-out F --text S` is a free run (SCRIPT as fm1-emu's: `800:n7,1500:n7^,2000:e6:1,2500:mc005`;
  snapshots as `lcd_MS.png` in the current directory).
- `tools/emu/target/release/m1emu cpu BIN --elf ELF` runs the test rig's CPU survey on the emulator: each factory slot
  loaded by program change, 0, 1, 4 and 8 notes held 2 s, the longest audio interrupt every 0.5 s and the mean of the
  rest. `--modtime` adds each module's time a half buffer. Both are read from the firmware's own counters, at the
  addresses in the same build's ELF (artifact `matryoshka-elf`), and written as JSON in the shapes of
  `tools/rig_cpu_survey.py` and `tools/m1_link.py modtime`. Run it under the timing model (below) to compare with the
  rig; `tools/emu/timing_fit.py measure` runs it over the whole bank, several emulators at once. `--modtime` holds
  `--keys` (eight notes unless given; an empty list holds none) for `--settle` ms (1000) before its `--window`, with the
  transport running under `--mt-run`, and adds the interrupt's mean over the window (`isr_us`). `--bank FILE` seeds the
  bank with the patches FILE lists (`NAME<TAB>PATCH.m1p`, slot 0 first, at most 48) instead of the factory bank:
  `npm run cpu-costs-emu` makes a CPU cost table this way (`web/scripts/cpu-costs-emu.ts` through `cpu-emu.ts`,
  [D-1107](ledger/engine.md#D-1107), [D-981](ledger/editor.md#D-981)). The editor's estimate does not use that table yet.

## The editor link: `m1emu serve` and the scenarios

fm1-emu has no USB controller, so the checks that cross the editor link (Sync, Live, sandbox mode, PRESET with the
editor, the reconnect) run against a firmware built for it ([D-119](ledger/releases.md#D-119), issue #290):

- **The firmware:** `M1_EMU_MIDI=1 python3 tools/build.py` (CI does this after the normal build: artifact
  `matryoshka-emu-midi`, `matryoshka-emu.bin` and its ELF). Its `usb_poll` moves USB-MIDI event packets through a mailbox
  in RAM (`m1_emu_mb` in `firmware/src/usb.c`, found by its magic words `M1EM` `MIDI`) instead of EP1; the rest of the
  MIDI path (the rings, SysEx, the editor protocol) is the normal one. It is never packaged or installed. The normal
  build does not change: the flag defaults to 0 (checked by comparing the CI builds' sha256 before and after).
- **`m1emu serve BIN [--name NAME]`:** the firmware in real time (the interpreter runs at about 0.42 to 0.46x, so emulated time
  falls behind under load), its MIDI on a CoreMIDI virtual source and destination named `NAME` (default `FM-1 (emu)`,
  which the editor's port match takes like a real FM-1), and a line protocol on stdin for the panel, the LCD and the
  audio (`tools/emu/src/serve.rs` lists it). `M1EMU_TRACE=1` prints every short message the FM-1 sends.
- **`cd web && npm run emu:scenarios [-- BIN] [--only NAME,..] [--shards N] [--list] [--headed]`:** builds m1emu and the panel WebAssembly,
  starts this checkout's dev server on a free port (with `MATRYOSHKA_BUNDLED_FIRMWARE=1`, so its Flash tab starts no
  `emu:smoke` of its own beside the run, issue #521; the rig scripts' and `demo.ts`'s dev servers do the same), starts `m1emu serve`, and drives the editor in Chrome (playwright-core
  with the installed Chrome, headless) through the scenarios in `web/scripts/emu-scenarios.mjs`: connect and Sync; an
  over-budget patch is sandbox mode (the sandbox page on the LCD, the FM-1 silent under a key); ARP twice; OCT; PRESET;
  back under budget; the tab closed and reopened on a sandbox patch; Elvira 2 running, then Elvira 2 XL; a computer
  where no app reads the FM-1's MIDI (issue #375, `deafHost`, below); ties on the SEQ page (issue #368, below); switching between a snapshot and the current patch with Live on (issues #103 and #943, `abFlip`: values only, so PARAM frames and no upload, and each stop sounds as it did); a Cassia 1 preset of 118 values sent to the FM-1's store, read back whole and loaded there with PRESET, every row reaching the editor (issue #485, `longPreset`); then the release's device check (`check..`, below). The page sees
  only the emulator's MIDI port, so a real FM-1 plugged in is never touched. A development-server hook (`__m1test` in
  `main.ts`) opens patches by name and reports the link's state. Without BIN it fetches the `matryoshka-emu-midi`
  artifact of this commit's firmware run (else its branch's, else main's). Results and LCD snapshots go to
  `build/emu/scenarios/`; about five minutes. A run of every scenario that passes writes `scenarios.passed` (the
  build's sha256) beside the build: in `build/flash/RUN/` for a build in its `emu-midi/` folder, else in the build's own
  folder; a failed run removes it.
- **Several emulators at once (`--shards N`, [D-1157](ledger/releases.md#D-1157)):** a full run uses four unless
  `--shards N` says otherwise; a run of `--only` uses one. With `--smoke APP` the candidate's `emu:smoke` runs beside
  them in the same slot, its output in `build/emu/smoke.log`. The run takes the
  slot, builds once and starts one dev server, then deals the scenarios over N runners of the same script, each with
  its own `m1emu serve` and Chrome; each runner opens the editor and syncs first (`connect`), so its scenarios start
  from the state they start from in one emulator. The deal evens out the scenarios' times in the last run's
  `timings.json` (the longest first, onto the runner with the least time so far; without one, in turn). Each runner's
  lines carry its number (`[2] ok ..`), and its results and snapshots go to `build/emu/scenarios/shard-K/`. At the end
  `results.json` and `timings.json` hold every runner's, each check with its `shard`, and the run marks its build as a
  run in one emulator does. The runners' `connect` checks count once for each runner. An interrupted run stops its
  runners before it lets go of the slot. Not for `device:scenarios`: there is one test rig.
- **Don't change the checkout while its scenarios run (issue #754):** the test scripts' dev servers watch no files
  (`MATRYOSHKA_NO_WATCH`, set in `web/scripts/rig-link.mjs`), so a commit, merge or regenerated file no longer reloads
  the editor's page mid-run. Before that, a reload dropped the link to the FM-1 and failed about 13 checks. A page that
  still loads again says so in the run's output. Run a second set of scenarios from another checkout instead.
- **Waits (#588):** the emulated FM-1 runs at about 0.42 to 0.46x the wall clock and falls further behind under load, so no
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
  read from the first two; on the rig the click check is skipped, below), the bar must say `COUNT-IN`, and the transport must stay stopped meanwhile (no Start reaches
  the editor). After the count-in the bar says `PLAY ONCE` and the FM-1's Start reaches the editor; half a pass in it
  still runs, and after the pass it stops by itself (its Stop reaches the editor). SEQ held + PLAY again, then PLAY a beat
  later, must end it with nothing started.
- **A Harmonizer's chord keys (`harmKeys`, issue #1053, [D-643](ledger/editor.md#D-643),
  [D-781](ledger/modules.md#D-781), [D-958](ledger/editor.md#D-958)):** Monolith D with its Harmonizer on. Under Live,
  at octaves 0, +1 and -1, one of the FM-1's seven lowest keys must name its chord on the bar (`CHORD: MAJ`) and send
  the key under the split, and the browser engine must take it as that chord button; a key above the seven must reach
  the browser engine as a root, also at octave -1, where its note lands under the split. The same patch with 16 voices
  is sandbox mode: there the seven lowest keys must reach the browser engine as chord buttons at every octave, and the
  other keys as roots.
- **When:** use [Choosing checks](#choosing-checks) for the qualification stages in [D-144](ledger/releases.md#D-144).

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
- **`cd web && npm run device:scenarios [-- --install RUN [--gate full]] [--only NAME,..] [--headed]`:** on the rig, only
  the scenarios whose result needs the hardware: `RIG_SCENARIOS` in `emu-scenarios.mjs` (`clock`, `drumHold`,
  `checkOutput`, `checkFlashWrite`, `checkDualCore`, [D-1151](ledger/releases.md#D-1151)). The emulator
  stands in for every other scenario, so they run in `emu:scenarios` only, and `--only` refuses them on the rig. The rig's
  page (`/__rig` on the dev server, `web/dev/rig-client.ts`) finds the FM-1s,
  asks each its INFO and the mark (nothing else), and drives only the rig; the editor's page sees only the rig's ports.
  `--install RUN` first installs that firmware CI run on the rig ([D-123](ledger/releases.md#D-123)): after the boot
  check passed on that run's builds (`--gate full`: after `emu:smoke` and `emu:scenarios`), through `tools/fm1_install.py --rig`. That installer sees only the
  MIDI ports at the rig's USB location, reads the mark there before it sends anything, and refuses when the FM-1 there
  is not the rig (exit code 9). Another FM-1 may stay connected: nothing reaches it (issue #698). `--rig --dry-run` runs
  the same checks and says what it would install where, sending only the identity handshake and the mark's read. A rig registered before
  #698, with no location kept, must still be the one FM-1 connected. A rig left in update mode is finished by hand,
  `tools/fm1_install.py PACKAGE --location 0x01130000`, never by a script. A build whose
  `scenarios.passed` holds its sha256 is not run through `emu:scenarios` again, as `smoke.passed` skips `emu:smoke`. The
  boot check (`emu:boot` on the run's two builds, about 30 s) is the default since issue #783: the owner's iteration
  checks and the candidate runs of [D-141](ledger/releases.md#D-141) take it. This install gate does not choose the
  integration, candidate, or release checks; use [Choosing checks](#choosing-checks). RUN may be a run of `release.yml`:
  its package installs as a CI build's does. Its `M1_EMU_MIDI=1` build for the
  boot check is that run's `matryoshka-emu-midi` artifact, or, for a release run from before issue #783, the one of the
  firmware CI run of the same commit (named in `emu-midi/from-run`). Each gate's result is kept next to the download
  (`build/flash/RUN/smoke.passed`, `boot.passed`, `.failed`, `.log`), and `build/device/scenarios/install.json` and the
  run's last lines say which gate the installed build passed. The Install panel of the dev server and `npm run flash`
  install on any FM-1, so they keep `emu:smoke` ([D-171](ledger/firmware-install.md#D-171)). Results and the
  screen as text go to `build/device/scenarios/`. Before the scenarios the runner taps HOME until the screen reports
  the device page (the menu, GLO, SEQ or a preset list left up), and stops with a message if it never does. Then it
  sets and saves GLO > SYSTEM > EDITOR to IGNORE, checking the setting through a fresh INFO reply.
  This also happens before an install and again after the rig restarts. Before and after each scenario, the runner
  checks IGNORE and restores it if needed. Missing firmware support, a missing settings row or an unconfirmed value
  stops the run. It saves only global settings, not the current patch or a bank slot. The other startup settings
  are GLO > MIDI > MIDI OUT and CLOCK OUT on, and GLO > PANEL > COUNT-IN OFF (issue #779).
  Each knob is turned only once its row shows. The volume
  never stops a run ([D-125](ledger/releases.md#D-125)): on a rig whose firmware reads its peak after MASTER (no INFO
  feature bit 10), a check that hears nothing is skipped as "MASTER down"; skips are counted apart and are no failure.
- **The owner's own FM-1 beside the rig (issue #698).** The rig's scripts may run while the owner plays their own FM-1
  in Chrome on the site. The rig's page asks the other FM-1 only HELLO and PRESET_GET, and the installer and the
  recorder go by the rig's USB location. While the editor is connected to one FM-1, it plays nothing from another
  FM-1's MIDI, so the rig's test keys and its PLAY do not reach the owner's page. With the rig at IGNORE, the normal
  editor's Connect skips it; the test runner's own editor can still connect because it sees only the rig's ports
  and is explicitly marked as a test-tools page. IGNORE is an editor convention, not a firmware access lock.
  A rig install restarts the rig twice on USB (into update mode and back),
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
now a scenario in `web/scripts/device-check.mjs`. These scenarios run after the others in `emu:scenarios`. On the rig,
`device:scenarios` runs only those that need the hardware ([D-1151](ledger/releases.md#D-1151)). Their release-candidate qualification follows [D-139](ledger/releases.md#D-139) and [D-141](ledger/releases.md#D-141). The owner's own check is then only what they
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
  - `checkRowDrone` (steps 3.1 to 3.3, [D-819](ledger/steps.md#D-819)): on `T110 DRONE`, SEQ opens the piano roll, a
    key sounds without editing the pattern, and LFO + FX in either order leaves the pattern unchanged.
  - `checkLiveDrone` (steps 3.5 to 3.7): step record's bar and hint on `T111 LIVE DRONE`, and FX + LFO there is a rest.
    A key held for 3 s in a live take becomes a drone that holds round the loop. The editor's roll draws it across the
    whole track. PLAY releases it, and leaving the page says PATTERN STAYS ARMED.
  - `checkDelays` (steps 4.1 to 4.5, [D-375](ledger/engine.md#D-375), [D-376](ledger/engine.md#D-376)): on
    `T111 TWO DELAYS`, one note gives an echo on the right at 300 ms and one on the left at 1200 ms. On the FM-1, LENGTH
    says SET IN THE EDITOR and TIME stops at the length. The editor's budget shows one effect memory line with LONG its
    largest share and a line for SHORT, and a click on a line selects its card. A press reaches the slider anywhere on
    each of SHORT's slider rows and on the sidebar's Cable slack and Zoom: at its name (drawn over the thumb), its centre
    and its thumb. Dragging SHORT's length to its top stops past 1900 ms, at what the memory leaves, with the note that
    says why. The patch then goes to the FM-1 again and both echoes still play.
  - The editor's ARM dot of an engine no keys reach ([D-905](ledger/device-ui.md#D-905)) is checked in the `arming`
    scenario ([D-1159](ledger/releases.md#D-1159)).
  - `checkStore` (steps 6.1 to 6.4, [D-959](ledger/editor.md#D-959), [D-297](ledger/patch-format.md#D-297)):
    `T110 DRONE STORED` holds its drone. "Store to an FM-1 slot…" lists the FM-1's slots (60 with the pattern store, 64 without). A used slot says what it holds and
    the button reads Replace. Store goes into the first empty slot. With Live on, HOME held + PRESET says EDITOR LIVE:
    PATCH STAYS. With Live off, PRESET away and back to that slot still plays the drone. The slot is emptied again at the
    end.
  - `checkOldPattern` (step 6.5): Silver Box's bytes as release 1.9.1 wrote them into the bank (format 48, kept in
    `web/scripts/check-old-patch.json`) go into an empty slot. Loaded with PRESET, its pattern 2 plays as Silver Box does
    with the patterns it held up to 1.24.1, which the editor opens from its test material (`factoryWithPatterns`, #1202). That an older
    binary renders the same as on its own release is proven on the host by
    `tools/old_format.sh`.
  - `checkTeach` (steps 7.1 to 7.3, [D-247](ledger/device-ui.md#D-247), [D-917](ledger/device-ui.md#D-917)), with Live
    off: PRESET to <7PH says 2 SOUNDS: ENV THEN SEL. REC held shows the ARM: hint, and REC held + a black key arms a
    second track (ARM DRUMS +1) and starts nothing. With DRUMS and PATTERN both armed, key 1 (F3) plays the bass (#748). PLAY held shows TEMPO n: TURN PRESET, and turning PRESET then
    starts nothing.
  - `checkDualCore` (steps 8.1, 8.2 and 8.4, [D-380](ledger/engine.md#D-380)): INFO's PROCESSOR row reads 2 CORES. Io 4,
    Hera 4 and Cassia 1 each play 8 held keys with nothing shed, no overload (DIAG pages 119 and 127) and no dropout in
    the recording. On the rig, the INFO tab's CPU row must read at most 90 % with the keys held. Monolith D and Simple FM
    sound.
- **The test patches** are built in `web/scripts/check-fixtures.mjs` from the check page's descriptions. Each run keeps
  them in the editor's Your patches, as the owner keeps them. `web/src/check-fixtures.test.ts` checks that each one is
  what its description says and fits the FM-1.
- **How they hear the FM-1.** Besides TEST_PEAK and the screen's texts (TEST_SCREEN), these scenarios record what the
  FM-1 plays (`web/scripts/audio-capture.mjs`). On the emulator the recording is its I2S output, from `m1emu serve`'s
  `wav`. On the rig it is the FM-1's USB audio, recorded on the Mac by `tools/fm1_rec.swift` from the input at the rig's
  USB location. The recorder looks up that physical USB device through IOKit and matches its audio input by the
  factory serial when present. Firmware without a USB serial is matched by the location in macOS's audio identifier
  (`AppleUSBAudioEngine:brighght studio:Matryoshka:1130000:1,2`). An absent or ambiguous match is refused.
  Without a location kept, the recorder requires exactly one input with the requested name. That small recorder uses Apple's AVAudioEngine and is built into `build/` the first time it is
  needed, with `swiftc` from Xcode's command line tools. ffmpeg's avfoundation input is not used: on 2026-11-06 it kept
  only 9.2 s of a 30 s capture of the rig and joined the pieces with no gap, while AVAudioEngine kept every sample. On
  the emulator the run opens the rig's page on the emulator's MIDI port
  before the editor's page, for the screen's texts and the DIAG pages.
- **What the rig's recording cannot show.** The FM-1 takes its USB audio before GLO > SYSTEM > OUTPUT mixes the sides
  and after MASTER (`firmware/src/audio.c`). GLO > SYSTEM > 3.5MM OUT
  silences the analog output only, so the rig's recording must stay as it was when it is OFF. So the MONO and MONO L checks hear the emulator only, and on the rig they
  are skipped.
- **The rig's knob does not matter (issue #1170).** For each recording the scenarios hold the rig's USB audio at
  MASTER's default level, whatever the knob, and let it go after the recording
  ([D-1169](ledger/releases.md#D-1169), Decided). They send an encoder turn of no clicks, which starts the device test
  mode and changes nothing else, then DIAG page 100; page 101 ends it. The firmware takes page 100 only in the test
  mode, and drops the fixed level when the test mode ends 10 s after the last test key or turn. The analog output still
  follows the knob, and outside the test mode so does USB audio ([D-927](ledger/device-ui.md#D-927)). The run says once
  whether the level was fixed. A firmware from before #1170 answers page 100 with no bytes, and its recordings follow
  the knob as below.
- **When a check that needs the recording is skipped.** A check that needs the recording is skipped, not failed, when
  there is none: the recorder cannot be built, MASTER is all the way down on a firmware without the fixed level, or a
  second FM-1 is connected and the FM-1 at the rig's USB location does not carry the
  mark (or no location is kept), so which audio input is the rig's is not known. It is also
  skipped when MASTER is so far down that the recording's loudest sample is more than 26 dB under what TEST_PEAK heard.
  TEST_PEAK reads as if MASTER sat at its default, so such a recording is lost in the USB audio's own noise. With the
  level fixed the recording is at TEST_PEAK's level, but the guard stays. Skips are counted apart, as for MASTER down
  ([D-125](ledger/releases.md#D-125)).
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
HOME held (the menu), HOME; the PRESET encoder; knob acceleration, a fine click, MIDI CC and a switch on a test patch of
its own (`knobs.m1p` from `web/scripts/emu-patches.ts`, not a factory patch); TRS MIDI program change and notes, then every factory patch in turn
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

Stack paint counts bytes written, not all the space a function reserves. The emulator does not enforce core 1's
hardware stack guard during ordinary runs. Set `M1EMU_C1_STACK_LOW` to a hexadecimal lower bound to check that core
after every instruction and stop if its user stack crosses the bound. This reports an error rather than simulating
the chip's exception handler. With the stack check enabled, `M1EMU_C1_WATCH_PC` logs the first time that core executes
the supplied hexadecimal address in user mode. This proves the checked path ran on that core. These checks do not
measure hardware timing.

`tools/aot_stack.sh BIN ELF` uses the matching build's `_c1_ustack` symbol plus its 256-byte guard as that bound.
It boots, selects Oracle V by program change, requires its compiled polyphonic segment to run on core 1, plays four then eight held notes, and requires
the second core and its self-tests to stay healthy. Use `--interpreter` only for an interpreter control build.
Build `m1emu` first; `M1EMU` can name another built copy. Run this focused check on compiled-assembly comparison
builds before their rig install. The failing AOT build from CI run 42673451565 crosses the bound in `process` at
startup, even though its ordinary boot check passed.

## The timing model

Without it, fm1-emu charges one cycle an instruction at 240 MHz, with no cache and no flash wait states, and the test
rig runs the same firmware about twice as long. `M1EMU_TIMING=tools/emu/timing.txt` runs any `m1emu` command under a
model of the device's timing (`tools/emu/src/timing.rs`, [D-1155](ledger/releases.md#D-1155), issue #947). The model
is off by default, and no gate uses it.

- **What it charges.** Each instruction the interpreter runs gets a cost for its kind (plain, load, store, multiply,
  divide, branch, a push or pop of several words, system), a cost when the next instruction does not follow on, a
  stall when it reads what the load just before it loaded, and a refill for every miss in the flash: code through the
  instruction cache, data through the data cache, each shared by both cores. RAM has no cache. A data read from the
  flash that hits costs a cycle less than a load from RAM. While core 1 runs a job (its code in the flash rather than
  its idle loop in RAM), every instruction on either core costs `dual` more: the cores share the bus and the caches.
  Cycles count at the device's 360 MHz and are turned into the emulator's 240 MHz cycles. The timers, the audio
  interrupt and the firmware's own clock then see the device's time: its CPU readouts, its overload guard and
  `m1emu cpu` all read device microseconds. The extra cycles go into the time on core 0 and come out of core 1's slice.
- **The hook.** fm1-core does not say which instruction runs. `tools/emu/core_timing_patch.py` adds a call that does
  (`Bus::retire`: its address, length, kind and the registers it reads and writes), in the copy `isa_fix.sh` makes. A
  bus without the model ignores it. The JIT does not call it, so the model needs the interpreter (`M1EMU_JIT` and
  `M1EMU_TIMING` refuse each other). With the model off, the emulator plays the same samples as before the hook.
- **The costs** (`tools/emu/timing.txt`) were measured on FM-1s by others, with the core's own cycle counter
  ([pi32v2-isa](https://github.com/jvitkauskas/pi32v2-isa/blob/main/hw/README.md): `fm1-2026-11-15-excprobe` and
  `fm1-2026-11-14-bootprobe`), and in [OpenPocket's AC791N handbook](https://github.com/isod89/openpocket/blob/main/docs/HARDWARE-HANDBOOK.md):
  a plain instruction 1 cycle, a load 2 (3 when the next instruction uses it), a store 2, a multiply 2, a divide 10, a
  branch not taken 1 and taken 7.5, about 480 cycles to fetch 64 bytes of cold, sequential code. The cache geometry
  (32 KB, 4 ways of 64-byte lines) is fm1-emu upstream's, which fits the rig better than DUB-1's notes (8 ways of
  32-byte lines).
- **Two numbers are fitted**, with `tools/emu/timing_fit.py grid` on measurements the rig made in pairs:
  - `dual` (0.1), from the same build with and without the second core's work (CI run 43551744806,
    `cpu-survey-2026-11-14-rig-two-core.json` and `-split-off.json`; the emulator sets `lanes_off`, as `tools/m1_link.py
    cores split off` does). With one overall scale instead, the model read the one-core run 5 % higher than the
    two-core one and credited the second core with 1.19 times the saving the rig measured.
  - `miss` (720 cycles a line, against the 480 measured for sequential code), from the same source built at -O2, at
    -Os, and at -Os with its hot code in RAM (CI run 42673451565, `2026-11-09-rig-experiments.json`), and from the
    module times of CI run 43568683497 (`docs/measurements/modtime-2026-11-14-rig.json`).

  With both, the overall scale that would bring the paired measurements to the rig came out at 1.005, so `residual`
  is 1. A -Os build still reads about 6 % higher than its -O2 twin (two patches measured; cause not found).
- **How close it is**, the steady mean of the audio interrupt (`m1emu cpu`) against `tools/rig_cpu_survey.py` on the
  same build, every factory patch at 0, 1, 4 and 8 keys, phases muted on either side left out. None of these surveys
  was used in the fit:

  | build | phases | emulator / rig | within 10 % | without the model |
  |---|---|---|---|---|
  | 747a1ea (CI run 43652865098, `cpu-survey-2026-11-14-rig-modctl.json`) | 88 | 1.03, 5.5 % rms | 93 % | 0.44 |
  | release-1.11 head (CI run 42462440721) | 113 | 0.95, 9.0 % rms | 84 % | 0.53 |
  | release-1.10 head (CI run 42096997058) | 120 | 0.95, 6.6 % rms | 95 % | 0.57 |

  Per module, on the module-time build, the patch sums come within 3.7 % rms (worst 6.6 %). On release-1.11 the model
  mutes 808 Kit and Verona Drum 1 under overload, as the rig did, and no patch the rig played. It sees only part of a
  change in code layout: from release-1.10 to 1.11, Init with 8 keys went from 498 to 594 µs on the rig.
- **Refitting.** For a build, download its `matryoshka-firmware` and `matryoshka-elf` artifacts into one directory.
  `python3 tools/emu/timing_fit.py residual DIR RIG.json tools/emu/timing.txt` against that build's rig module times
  (`tools/m1_link.py --rig modtime 3 --notes 8 --patch NAME` per patch, collected as in
  `docs/measurements/modtime-2026-11-14-rig.json`) prints the overall scale it needs: near 1 means the model holds.
  `timing_fit.py grid tools/emu/timing.txt TWO_CORE_DIR O2_DIR,SIZE_DIR,RAM_DIR MODTIME_DIR 480,0.1 720,0.1 ..` refits
  `miss` and `dual` on the paired measurements (about 6 minutes a point on a 14-core Mac; the runs are cached in
  `build/emu/timing-cache`). Check with `timing_fit.py measure DIR OUT.json --survey --timing tools/emu/timing.txt`
  and `timing_fit.py compare OUT.json --survey RIG_SURVEY.json --quiet`. A cost measured anew on the chip goes into
  `timing.txt` with its source, and the two fitted numbers are refitted after it.

## What it does not cover

- **USB is not emulated**: the smoke test leaves out the editor's SysEx link and USB MIDI (`emu:scenarios` covers them, above), firmware installs (M-UPGRADE, the loader), recovery and
  the UBOOT SysEx are untested by it. The bank is therefore seeded in the flash image, not uploaded.
- **P33** (watchdog, reset reason, reboot, UBOOT entry: `firmware/hal/fm1_sys.h`) is not modelled, except the ten
  registers of the supply setup at boot (`tools/emu/src/p33.rs`, #735): they start at the boot loader's levels, and the
  second core starts only when the setup reads them back right. The boot-loop guard and MENU > UPDATE MODE cannot be
  checked. fm1-live (`npm run emu`'s window) has no such model, so it shows 1 CORE.
- **Timing**: without the timing model (above), one instruction per cycle at 240 MHz, no cache or flash wait states.
  The CPU figure in the top bar (303 Acid 11-12 %, the device measured 12 % at M1-0.2) is then a rough guide only; the
  window at 120 MHz shows twice it. The test rig runs the same patches about twice as long as the plain emulator, and a
  change in code or memory layout can make every patch slower on the device while the plain emulator's figures stay the
  same: the release-1.11 batch cost 80 to 270 µs more a half on the rig (`docs/measurements/2026-11-08-rig-release-1.11.md`),
  and the plain emulator measured Init, Simple FM, Mono Lead and the 909 Kit within 1 % of 1.10.0. The timing model
  sees part of such a change; the rig still measures it.
- **The second core** runs after each slice of 1,024 instructions of the first, for as many instructions as cycles
  passed. `m1emu` ends its turn early when it is back where the turn started (the same program counter, registers and
  stack pointer) and has written nothing since: its idle loop, which only reads its mailbox (`tools/emu/src/machine.rs`
  `run_cpu1`).
  fm1-emu's own runner ends it on the first condition alone. A loop that keeps its state in memory then looks idle too:
  Env 8's sample loop keeps its sample index on the stack, so on builds from #744 on the second core lost most of its
  time on Cassia 1's lane jobs, the first core waited for them, and the audio interrupt climbed from about 1,150 to
  2,900 µs two seconds after 8 keys went down (the factory Cassia 1 on release-1.11 at #744, 2026-11-08). That climb was the emulator's alone: on
  the device the second core runs on its own clock.
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
