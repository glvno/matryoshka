# The firmware on an emulated FM-1

[fm1-emu](https://github.com/joakimeriksson/fm1-emu) (Joakim Eriksson, MIT) emulates the FM-1's JieLi AC791N: the
pi32v2 cores, timers, interrupts, SPI flash, the 240×240 LCD, the key matrix and encoders, the MASTER pot, the I2S
audio and the TRS MIDI input. Our `modular-1.bin` runs on it unchanged. `tools/emu/` is a small Rust crate (`m1emu`)
on fm1-emu's `fm1-core` / `fm1-soc`, pinned to commit `7ca5b96` in `tools/emu/Cargo.toml` (a git dependency, nothing
of fm1-emu is copied into this repository).

**Run it locally before any device work.** It is not part of CI (the user's call: too expensive on Actions).

## Commands

- `cd web && npm run emu:smoke [-- FIRMWARE]`: the smoke test (below), about two minutes on an M1.
- `cd web && npm run emu [-- FIRMWARE]`: the firmware in fm1-live's window (LCD, keys, buttons, knobs, sound, every
  MIDI input into the TRS jack; fm1-live prints its key map; built once into `tools/emu/live/`).
- Without FIRMWARE both take `build/modular-1.bin`, else download the latest firmware artifact of a successful
  `firmware` run on `main` with `gh` (`build/emu/ci/`), else unpack `web/public/firmware/modular-1.fwsc`.
- `tools/emu_smoke.sh [BIN]` is what `emu:smoke` runs (`M1EMU_STRICT=1` makes
  level warnings fail). `tools/emu/target/release/m1emu run BIN --ms N --keys SCRIPT --snap MS,.. --wav F
  --flash-in F --flash-out F --text S` is a free run (SCRIPT as fm1-emu's: `800:n7,1500:n7^,2000:e6:1,2500:mc005`;
  snapshots as `lcd_MS.png` in the current directory).

## The smoke test (`tools/emu/src/smoke.rs`)

It reads the LCD with the firmware's own font (`font.rs` parses `font5x7.c` and finds a string drawn by
`text_dots` exactly), so it needs no symbols and runs on the release binary. Steps: the loading screen, the main page
of factory patch 0; silence, a panel key, silence after the release; GLO, ENV, ARP, SEQ, LFO, HOME, HOME held (the
menu), HOME; the PRESET encoder; TRS MIDI program change and notes, then every factory patch in turn (name shown,
sound, its peak against the web engine's, from `web/scripts/emu-levels.ts`, within 6 dB as a warning); SAVE, the
flash kept, a restart (STATE RESTORED, the same patch diagram, the octave); a preset bank written straight into the
flash (three slots and one with a bad CRC; PRESET and program change step through the three and wrap); no register
fm1-emu does not model besides P33. In the four-voice build also SEL. Snapshots of each step, a WAV and the levels
table go to `build/emu/`.

## What it does not cover

- **USB is not emulated**: the editor's SysEx link, USB MIDI, firmware installs (M-UPGRADE, the loader), recovery and
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
