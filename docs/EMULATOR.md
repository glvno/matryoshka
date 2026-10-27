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
bits 28..31, source = 20..23, shift register = 24..27). fm1-core already runs `#` pairs with the second instruction
seeing the old registers. The firmware CI keeps the ELF and
its disassembly (artifact `matryoshka-elf`) for tracing such faults to a function.

**Run it locally before any device work.** It is not part of CI (the user's call: too expensive on Actions).

## Commands

- `cd web && npm run emu:smoke [-- FIRMWARE]`: the smoke test (below), about two minutes on an M1.
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
- **`cd web && npm run emu:scenarios [-- BIN] [--only NAME,..] [--headed]`:** builds m1emu and the panel WebAssembly,
  starts this checkout's dev server on a free port, starts `m1emu serve`, and drives the editor in Chrome (playwright-core
  with the installed Chrome, headless) through the scenarios in `web/scripts/emu-scenarios.mjs`: connect and Sync; an
  over-budget patch is sandbox mode (the sandbox page on the LCD, the FM-1 silent under a key); ARP twice; OCT; PRESET;
  back under budget; the tab closed and reopened on a sandbox patch; Elvira 2 running, then Elvira 2 XL; a computer
  where no app reads the FM-1's MIDI (issue #375, `deafHost`, below). The page sees
  only the emulator's MIDI port, so a real FM-1 plugged in is never touched. A development-server hook (`__m1test` in
  `main.ts`) opens patches by name and reports the link's state. Without BIN it fetches the `matryoshka-emu-midi`
  artifact of this commit's firmware run (else its branch's, else main's). Results and LCD snapshots go to
  `build/emu/scenarios/`; about four minutes.
- **A host that stops reading (`deafHost`, issue #375):** every other scenario has Chrome reading the FM-1's MIDI, so
  the FM-1's queue for the editor always empties. `deaf 1` makes `m1emu serve` stop taking packets from the mailbox; the
  firmware's SysEx queue then fills, as on a computer where no app reads the FM-1, and every message the FM-1 sends
  unasked goes through the same `ota_wire_send` wait as over USB. The scenario enters 30 steps on the 808 Kit's SEQ
  page at a hand's pace, then SEQ must close the page within 400 emulated ms (about 140 with a reading host; 2890
  before the fix of #375). After `deaf 0` the editor must follow a step entered on the FM-1 and sync a patch again.
  The first message after such a stall is a SysEx cut short (the FM-1 gave up halfway); `m1emu` drops it at the next
  F0, as a MIDI receiver should (Chrome's Web MIDI parser, by its source, does the same), and says so on its output.
  The host side alone is in `tools/usb_test.sh` (`firmware/test/usb_test.c`, `test_deaf_host`).
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
  in `~/.config/matryoshka/rig.json`; the Library does not list that preset. `npm run rig -- check` names the rig among
  the connected FM-1s.
- **`cd web && npm run device:scenarios [-- --install RUN] [--only NAME,..] [--headed]`:** the scenarios of
  `emu-scenarios.mjs` on the rig. The rig's page (`/__rig` on the dev server, `web/dev/rig-client.ts`) finds the FM-1s,
  asks each its INFO and the mark (nothing else), and drives only the rig; the editor's page sees only the rig's ports.
  `--install RUN` first installs that firmware CI run on the rig ([D-123](ledger/releases.md#D-123)): after `emu:smoke`
  and `emu:scenarios` passed on that run's builds, and only when the rig is the one FM-1 connected. Results and the
  screen as text go to `build/device/scenarios/`. Before the scenarios the runner taps HOME until the screen reports
  the device page (the menu, GLO, SEQ or a preset list left up), and stops with a message if it never does. The volume
  never stops a run ([D-125](ledger/releases.md#D-125)): on a rig whose firmware reads its peak after MASTER (no INFO
  feature bit 10), a check that hears nothing is skipped as "MASTER down"; skips are counted apart and are no failure.
- **`cd web && npm run rig:bench [-- --patch NAME] [--rounds N]`:** the LCD's draw times on the rig, with the rig the
  only FM-1 connected (it refuses otherwise, before sending anything but INFO and the mark's read). It zeroes the times,
  pages with ALGO and SELECT, turns K1..K4, opens and closes GLO and steps PRESET on and back, then prints the last and
  the worst time of each kind of draw. The firmware keeps them (`ui_time` in `firmware/src/ui.c`: `fm1_ticks` around
  each draw, the LCD's transfers included) and reports them as DIAG pages 121..123 (page 120 zeroes them);
  `tools/m1_link.py uitime` reads the same. Run on two builds, it compares them.
- **`npm run device:scenarios -- --via-emu`:** the device path against the emulator (its build has the test mode too),
  to check the runner and the firmware's side without a rig.

Not covered: the audio leaving the FM-1 (the peak is read inside the firmware, before the codec and USB audio), USB
plugging, the scenarios' sound judged by ear.

## The smoke test (`tools/emu/src/smoke.rs`)

It reads the LCD with the firmware's own font (`font.rs` parses `font5x7.c` and finds a string drawn by
`text_dots` exactly), so it needs no symbols and runs on the release binary. Steps (the list at the top of `tools/emu/src/smoke.rs`): the loading screen, the
device page of factory patch 0; silence, a panel key, silence after the release; GLO (Main's global page), PLAY, HOME,
HOME held (the menu), HOME; the PRESET encoder; TRS MIDI program change and notes, then every factory patch in turn
(name shown, sound, its peak against the web engine's, from `web/scripts/emu-levels.ts`, within 6 dB as a warning);
SAVE, the flash kept, a restart (STATE RESTORED and the state back); a patch bank written straight into the flash
(three slots and one with a bad CRC; PRESET and program change step through the three and wrap); the safety steps
(shedding and OVERLOAD, safe mode, update mode); the patch buttons and the SEQ page on the 808 Kit; no register
fm1-emu does not model besides P33. Snapshots of each step, a WAV and the levels table go to `build/emu/`.

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
