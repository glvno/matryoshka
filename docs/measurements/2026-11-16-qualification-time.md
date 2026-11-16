# The time to qualify a release candidate, 2026-11-16

What a release candidate's qualification spends its time on, check by check, what each real-time check proves that a
faster check does not, and what was changed to make it faster. Measured on the 1.18.0 candidate (`eed81c26`, release
run 43906874248, web run 43906880954) and on this branch. The Mac is an Apple M3 Max with 14 cores and 36 GB of memory.
Continuous integration (CI) runs on GitHub's `ubuntu-latest` runners with 4 virtual CPUs (vCPUs). Times of day are US
Central (UTC−6).

The owner asked on 2026-11-16: "can we take a crack at reducing the time to qualify a release? we should be very careful
to make sure that any check that has to be run in real time is actually useful and informative."

## 1. Where the time goes

### The 1.18.0 candidate, stage by stage

| stage | start | end | wall time | notes |
|---|---|---|---|---|
| `release.yml` in release-candidate (RC) mode | 10:23:04 | 10:27:14 | 4.2 min | build 9 s, the full host checks 208 s, the bridge build 8 s; its artifacts are uploaded after the host checks |
| `web.yml` in RC mode (beside everything below) | 10:23:07 | 10:56:47 | 33.7 min | coverage group 265 s (221 files), then the slow renders 1,670 s (13 files) |
| download, `emu-levels.ts`, builds | 10:27:20 | about 10:28:50 | about 1.5 min | |
| `emu:smoke` | about 10:28:50 | 10:45:17 | 16.4 min | 309 checks, 435.8 s emulated, one part after another |
| `emu:scenarios` | 10:45:37 | 11:09:28 | 23.9 min | 385 checks; setup 19 s |
| `emu:boot` (the rig's install gate) | 11:09:39 | 11:10:57 | 1.3 min | 32 checks, 37.0 s emulated |
| rig install | 11:10:57 | about 11:12:50 | about 2 min | `tools/fm1_install.py --rig` |
| `device:scenarios` on the rig | 11:12:53 | 11:15:18 | 2.4 min | 70 checks, 4 skipped by design |

From the dispatch to the rig's last check: **52 minutes**, every stage after the release build one after another. The
web run ended inside that window. The emulator stages and the rig never overlapped, though [D-141](../ledger/releases.md#D-141)
lets the rig start after the boot check while the emulator checks run.

### Why "about three hours"

The figures in the brief (scenarios about 1.5 h, the rig about 1 h) match no recent record. The qualification records
in `release/qualification/` give `emu:scenarios` 1,315 s (1.13.0) and 1,359 s (1.14.0), and `emu:smoke` 916 to 951 s.
The rig ran every scenario, 388 checks, only up to 1.13.0; since [D-1151](../ledger/releases.md#D-1151) it runs about
70. The hours come from failures and what follows them:

| release | what went wrong in qualification | what it cost |
|---|---|---|
| 1.14.0 | `devicePreset` expected the old last preset (stale check); the rig's first USB audio recording stalled | a fix, a rerun |
| 1.15.0 | the smoke's heavy fixture no longer overloaded (both cores share every patch since D-1101); a scenario failed | fixture fix, reruns |
| 1.16.0 | four web tests timed out under coverage; `arming` stale after a second Drum map; PR #925 changed `tools/ci_checks.py`, so the release was rebuilt | a refreeze, a second web run |
| 1.17.0 | the 909 Kit's loudness test timed out at 20 min under coverage (web run failed after 43 min); PR #952 then changed `tools/ci_checks.py`, so the release was rebuilt; the rig's USB audio stalled (issue #953) and `checkOutput` ran 13 more times | from the first dispatch (20:41) to the last rig rerun (about 01:10): about 4.5 h |

Every recent release had at least one failure in qualification. Each one costs a fix, a review and the affected checks
again ([D-144](../ledger/releases.md#D-144)), and a change to `tools/` costs a rebuild because the tag's `firmware/` and
`tools/` must equal the built commit's ([D-105](../ledger/releases.md#D-105)). Shorter stages shorten every one of these
loops too.

## 2. Why the emulator runs slower than real time

The emulator interprets both of the chip's cores. A profile of `m1emu run` (macOS `sample`, 8 s, factory patch 0 with 8
keys held) spends 54 % of its samples in fm1-core's interpreter loop (`Cpu::run_fast`) and 31 % in the second core's
loop (`run_dual`, with `run_cpu1` inlined); memory comparisons are 2 %. The firmware's own audio work is what it
interprets, so the heavier the patch, the slower: 12 s emulated took 28.0 s (0.43x) with 8 keys held.

| build of `m1emu` (`tools/emu`) | wall time for 12 s emulated | the recorded WAV |
|---|---|---|
| as committed: `opt-level = 3`, `lto = true` | 28.0 s | sha1 `ac8b727c` |
| `codegen-units = 1` | 28.0 s | the same |
| `codegen-units = 1`, `panic = "abort"` | 28.2 s | the same |
| the same and `-C target-cpu=native` | 28.1 s | the same |

What else was looked at:

- fm1-emu's AArch64 JIT is off: it renders our engine wrong (`tools/emu/src/machine.rs`).
- The timing model ([D-1155](../ledger/releases.md#D-1155)) is off unless `M1EMU_TIMING` is set; no gate sets it.
- Idle skipping is already on (`soc.periph.skip_idle`), and `m1emu serve` sleeps only when it is ahead of the wall
  clock, which it never is under load.
- Snapshot and WAV writes are a few per check and do not show in the profile.

So one emulator cannot be made faster from this repository. The way to a shorter run is more emulators at once: the
smoke test's parts and the scenarios share nothing, and the Mac has 14 cores.

## 3. Per check

### `emu:scenarios` on the 1.18.0 candidate: where the 24 minutes went

From the candidate's own run (snapshot times, and its `results.json` sampled every second). Four checks took 533 s,
37 % of the run, each stepping the FM-1's bank with HOME held + PRESET one slot at a time, and waiting out the name's
whole limit (600 ms × 3) at every slot that was not the one sought:

| check | wall time |
|---|---|
| flash write: the settings record (DIAG 129) with C4 held on Basic Poly | 141.7 s |
| 7.1 teach: HOME held + PRESET to <7PH | 134.6 s |
| 6.5 old pattern: HOME held + PRESET to it | 133.6 s |
| 6.4 store: HOME held + PRESET to another patch and back to the slot stored | 123.5 s |
| the next longest (8.4 dual core: Cassia 1 opens, synced) | 18.1 s |

By scenario (snapshot times): connect to switchPlaying 1.5 min; the tie scenarios, drumHold and playOnce 3.4 min;
recCountIn to editorIgnore 4.6 min; the device check's scenarios before checkStore 4.5 min; checkStore to checkFlashWrite
10.2 min; checkDualCore 1.4 min.

On this branch, with `presetTo` fixed (the 1.18.0 bridge, one emulator, `timings.json`): 384 of 385 checks passed and
one was skipped by design. The scenarios took 1,072 s, after 237 s of setup that includes the wait for the slot. The
emulator ran at 0.42 to 0.46x real time in every scenario. The longest: checkOldPattern 80 s, checkTeach 79 s,
checkFlashWrite 76 s, tieLire 63 s, tieElvira 60 s, arming 58 s, checkDualCore 55 s, tie808 53 s, checkStore 52 s.
The four checks that step the bank took 18 to 47 s each, against 123 to 142 s on the candidate. With four emulators
and the smoke test beside them in the one slot, the same build passed 322 of 322 scenario checks and 301 smoke checks
in 371 s; the four runners took 349 to 356 s each. Every check both runs share had the same verdict.

### `emu:smoke`: its parts

The smoke test boots 33 machines; each boot holds the loading screen 5 s ([`SPLASH_MS`](../../firmware/src/main.c)).
Run as parts side by side on this branch (309 checks, 435.8 s emulated, as the candidate's run):

| part | emulated | wall |
|---|---|---|
| steps 1 to 7 (boot, sound, pages, PRESET, TRS MIDI with every factory patch, SAVE, the bank) | 90.8 s | 216.5 s |
| knobs | 10.6 s | 31.3 s |
| safety | 42.4 s | 109.3 s |
| store | 35.3 s | 95.2 s |
| upgrade | 16.2 s | 47.5 s |
| new patch | 22.3 s | 63.4 s |
| panel | 12.5 s | 36.0 s |
| seq | 63.3 s | 185.8 s |
| count-in | 24.4 s | 67.0 s |
| global tempo | 46.4 s | 115.6 s |
| long delay | 45.1 s | 115.2 s |
| stereo | 9.1 s | 26.6 s |
| verona | 17.3 s | 49.1 s |
| **the whole run** | **435.8 s** | **216.5 s** (16.4 min one after another) |

The one-after-another run (the committed `m1emu`, stopped after 10 min) and the parts run gave the same lines for every
check the first had reached, the same table of factory-patch levels, and the same `run1.wav` (sha1 `73978139`).

### `emu:boot`

| part | emulated | wall |
|---|---|---|
| plain build: boot, sound, update mode | 10.3 s | 23.0 s |
| blank factory region | 8.8 s | 21.4 s |
| link: HELLO and the update handshake | 9.6 s | 21.5 s |
| factory install over the link | 8.2 s | 19.7 s |
| **the whole check** | **37.0 s** | **23.0 s** (81.8 s one after another, the same 32 checks) |

### `device:scenarios` on the rig (1.18.0, file times)

connect 11 s; clock 7 s; drumHold and check35mmOut 27 s; checkOutput 38 s; checkFlashWrite 25 s; checkDualCore 37 s.
The rig's bank holds few patches, so its `presetTo` found Basic Poly at once. Each USB audio recording costs at least
2.3 s on top of what it records (1.5 s warm-up, 0.8 s tail), and each opens a new stream, the moment issue #953's
stalls happen. Four of the 14 recordings fed only checks the rig skips by design ([D-140](../ledger/releases.md#D-140)).

### The web run's slow renders (RC 1.18.0, uninstrumented, 4 vCPUs)

| file | time |
|---|---|
| `src/levels-5.test.ts` | 779 s |
| `scripts/audition-render.test.ts` | 578 s |
| `src/shared-levels.test.ts` | 546 s |
| `src/headroom-1.test.ts` | 421 s |
| `src/levels-6.test.ts` | 419 s |
| `src/levels-3.test.ts` | 311 s |
| `src/headroom-2.test.ts` | 246 s |
| `src/levels-1.test.ts` | 215 s |
| `src/headroom-3.test.ts` | 152 s |
| `src/levels-2.test.ts` | 115 s |
| `src/levels-4.test.ts` | 84 s |
| `src/headroom-4.test.ts` | 52 s |
| `src/kit909.test.ts` | 13 s |

3,931 s of work in 1,670 s of wall time. `levels-5` alone is 779 s of its 960 s limit: the loudness parts deal the
patches by index (`i % 6`), and the heavy ones land together.

Per patch, on the M3 Max with four renders at once (`offRule` and `overHeadroom` on one patch each): the 808 Kit takes
498 s of the loudness test's 1,236 s and 236 s of the headroom test's 512 s; the 909 Kit 271 s and 126 s; Scrounge 112 s
and 46 s; Algo Four 79 s and 25 s; every other patch 33 s or less. The 808 Kit alone sets the floor of any deal by whole
patches: dealt by cost, the longest loudness part would be the 808 Kit on its own, about 690 s on a CI runner
[INFERENCE: scaled by the CI-to-Mac ratio of `levels-6`, 1.38] instead of 779 s. The parts are left dealt by index;
a shorter floor needs the 808 Kit's own cases split across parts.

## 4. What each real-time check proves (the value audit)

Classes: **keep** (a signal no faster check has), **shorten** (the same signal in less time), **merge** (another
real-time check makes the same claim), **earlier** (the signal does not depend on the candidate's bytes and could run
on each pull request), **drop** (a faster check covers it). "Caught" cites a bug the check found; "flaky" cites failures
that were the harness's. Searched: git history, issues, pull requests and the qualification records. Host tests are
`firmware/test/` (CI), golden is `tools/golden.sh`, vitest is `web/`.

### Emulator scenarios (`web/scripts/emu-scenarios.mjs`)

| scenario | what only it proves | faster check with the same claim | caught / flaky | class |
|---|---|---|---|---|
| connect | the real editor syncs with the real firmware | boot check (a key sounds); `device.test.ts` | — | keep |
| signalBuffers | the firmware's `eng_load` admits what the budget admits | `signal-buffers.test.ts`, `device.test.ts`, `tools/buffer_budget.py` | — | earlier |
| liveCompile | upload before live values under a real upload | `dead-modules.test.ts` | — | earlier |
| clock (also on the rig) | on the emulator: clock bytes reach Chrome | `clock_out_test.c`, `panel_test.c` | flaky: #779 | keep (cheap; the rig's copy measures the rate) |
| patterns | pattern and song follow both ways over the link | smoke's SONG page (panel only) | — | shorten |
| sandbox | entering sandbox mode end to end | `proto_test.c`, panel test, `sandbox*.test.ts` | — | keep |
| arp | ARP's first press reaches the editor | arpQuick | — | merge into arpQuick |
| arpQuick | two quick presses end where they began | — | — | keep |
| oct | OCT reaches the editor | — | — | keep |
| preset | PRESET in sandbox leaves the editor alone | `panel_test.c` | — | merge into sandbox |
| tempo | the tempo message both ways | — | — | keep |
| nudge | sandbox mode survives SEQ | — | — | shorten (a 1.7 s wait for a toast) |
| leave | the way out of sandbox mode | — | — | keep |
| reconnect | the firmware's Live timeout and the editor's reload | — | — | keep |
| switchPlaying | the transport handed over while running | `panel_test` (`sb_home_due`) | — | shorten (it searches up to 8 keys) |
| tieLire | a tied voice holds through a pass on the firmware | `panel_test.c` tie rule; golden `drum-thru` | led to #385, #486 when it ran on the rig; flaky: #529, #769 | shorten |
| tieElvira | the same as tieLire on another voice | tieLire | flaky: #529 | merge into tieLire |
| tie808 | the tie gesture on a one-shot kit | golden `drum-thru` (one-shot unchanged) | — | shorten |
| drumHold (also on the rig) | the held level on the emulator | `panel_test` | flaky: #487, #557, #784 | keep (cheap; the rig's copy measures the hold) |
| playOnce | Start and Stop reach the editor | `panel_test.c` (count-in, clicks) | flaky: #751, #784 | shorten |
| recCountIn | — (no editor check) | `panel_test.c` count-in; smoke's count-in | flaky: #779 (36 failures in one rig run) | drop |
| tieRoll | a tie in step record reaches the editor | `steprec_test.h`; stepRecord | — | merge into stepRecord |
| rowDrone | a row drone holds through the loop | `panel_test.c`; tieLire's drone | flaky: #769 | merge into tieLire |
| stepRecord | each step reaches the editor | `steprec_test.h` | — | keep |
| recStepRecord | a live take's note reaches the editor | smoke; `steprec_test.h` | — | merge into stepRecord |
| rollPaging | — beyond rollPen | smoke; panel test | — | merge into rollPen |
| rollPen | the editor's follower with the firmware's KEYS_NOW | `steprec_test.h`, `panel-align.test.ts` | caught #549 (fixed #550) | earlier (an editor bug) |
| mirrorKeys | the firmware's GUIDE_NOW against the editor's copy | `panel-align.test.ts` | — | earlier |
| deafHost | the whole loop with a host that stops reading | `usb_test.c` (parts) | caught #378 (fixed #406) | keep |
| rollBlack | the high black keys on the roll | smoke (three keys) | — | merge into smoke |
| arming | ARMS_NOW and ARMS between editor and FM-1 | smoke, `panel_test.c`, `nudge_test.h`, `proto_test.c`, `arm.test.ts` | flaky: #769; v1.16.0 RC (stale) | shorten (about 12 toast waits of 1.3 s) |
| armWide | arming past module 63 on real firmware | `proto_test.c`, `arm.test.ts` | — | merge into arming |
| focusTurns | the FOCUS_NOW race with the mirror | — | caught #504 (5 of 6 failed before PR #506) | keep |
| devicePreset | the device a patch opens on, and the first PRESET | `editor-focus.test.ts`, `device-presets.test.ts` | caught #496; a regression in PR #550 before merge; v1.14.0 RC (stale) | keep |
| longPreset | a 153-row preset stored, read and loaded | `preset_test.sh`, `proto_test.c`, `preset-long.test.ts` | flaky: #769 | earlier |
| abFlip | after PARAM frames the FM-1 sounds as each side did | `ab.test.ts`, `ab-editor.test.ts` | flaky: #620 | earlier |
| editorIgnore | the firmware sends the unasked INFO and the editor lets go | `device.test.ts`, `panel_test.c`, `proto_test.c` | — | earlier |

### The device check's scenarios (`web/scripts/device-check.mjs`), on the emulator and on the rig

| scenario | what only it proves | faster check with the same claim | caught / flaky | class |
|---|---|---|---|---|
| checkOutput on the rig | STEREO's sides on real USB audio on the candidate's bytes | smoke's stereo (I2S); `tools/audio_out_test.sh` | flaky: every rig failure of 1.14 to 1.17 was a USB audio stall (#953) | keep; record only what is checked (done) |
| checkOutput on the emulator | the OUTPUT row and the I2S fold together | smoke's stereo; `audio_out_test.sh` | — | shorten (1.1 repeats smoke) |
| check35mmOut on the rig | — : `audio_out_test.sh` proves USB audio unchanged bit for bit | `audio_out_test.sh`; `panel_test.c`; the emulator's run | never failed | drop from the rig (Proposed) |
| check35mmOut on the emulator | the row, the hold and the mark on the bytes | `panel_test.c` | — | keep; a condition instead of a fixed 2 s wait (done) |
| checkFlashWrite on the rig | real flash suspend timing under a held note | none: the emulator's flash is instant | acceptance of #656 (PR #715); found #729 | keep |
| checkFlashWrite on the emulator | the engine runs through each write | — | caught the engine stop before #656 | keep |
| checkDualCore on the rig | the second core's real timing on the candidate's layout | `tools/rig_cpu_survey.py` per pull request (not on the candidate's bytes) | the 1.11 rig failed it for real (PR #772) | keep |
| checkDualCore on the emulator | shed and overload with 8 keys | smoke's 2 CORES and overload | led to the `lanes_awake` fix (PR #769); one false alarm from m1emu (PR #774) | keep |
| clock on the rig | the clock's rate across real USB | `clock_out_test.c` | — | keep; windows 4 s → 2 s would do |
| drumHold on the rig | the hold across real USB MIDI | `panel_test.c` | flaky: #557 | keep |
| checkVerona | the XL over the link; hit 7 with 6 held | `nudge_test.h`; smoke's verona | v1.15 stale | shorten |
| checkRowDrone | the editor's notes unchanged over the link | `panel_test.c`; rowDrone | — | merge into rowDrone |
| checkLiveDrone | a recorded drone reaching the editor and its roll | golden `steps-rec-drone`; `panel_test.c` | — | shorten (3 s hold, 4.4 s recording) |
| checkDelays | budget → upload → device memory | smoke's long delay; `delay-length.test.ts` | flaky: #662, #769 | keep |
| checkNoKeys | the ARM dot clicked in the real editor | `nudge_test.h`, `arm.test.ts`, `check-fixtures.test.ts` | — | drop or merge into arming |
| checkStore | the store dialog → slot → bank, end to end | `store-slot.test.ts`, `panel_test.c`, `preset_test.c` | the reference for #955 | keep; `presetTo` fixed (done) |
| checkOldPattern | a format-48 slot read from the bank | `tools/old_format.sh` (not through the bank, not in CI) | — | keep; `presetTo` fixed (done) |
| checkTeach | the patch-load message and REC's ARM: hint | `nudge_test.h` | — | shorten (7.2's bass and 7.3 repeat `nudge_test.h`) |

### Smoke and boot check

| part | what only it proves | faster check with the same claim | caught / flaky | class |
|---|---|---|---|---|
| steps 1 to 2 (boot, sound) | — beyond the boot check | `boot.rs`; `help_test.h` | READY late (5821de5, dc6cc80) | merge (the base for 3 to 7) |
| step 3 (pages) | the key matrix → panel on the JieLi build | `panel_test.c`, `controls_test.h` | a HOME press bug (614682d); a hint race (db26040) | shorten |
| step 4 (PRESET) | presets.h's data against the ROM list | `panel_test.c` | the Oracle V Init mismatch from PR #909 (fixed PR #916) | earlier |
| knobs | the encoder decode on the JieLi build | `panel_test.c` (#340, #405 acceleration, the fine click) | — | merge (drop candidate; it costs its own boot) |
| step 5a (TRS MIDI) | the UART path on the build | `usb_test.c` (the parser) | — | keep |
| step 5b (every factory patch by program change, levels) | the compiled patches, AOT segments and dual-core split on the exact bytes | `tools/golden.sh` (C against TS, stricter than its 6 dB warning) | — | keep |
| step 6 (SAVE and restart) | the boot's restore path; no host test compiles `main.c` | `patlink_test.c` (the write itself) | STORED PATCH after a restore | keep |
| step 7 (an old bank) | the legacy `M1SL` slots and the CRC skip | none seeds `M1SL` | — | keep |
| safety: overload, safe mode | the guard in the audio interrupt end to end; the safe-mode boot | `guard_test.c` (the decision only) | fixture drift twice (b42fd0a; the 1.15.0 first run) | keep |
| safety: update mode at power-on | — | the boot check | — | merge into the boot check |
| safety: quick start off, the menu walk, 2 CORES, P33 | persistence across a boot; the second core's self-test on the build | `help_test.h`, `panel_test.c`, `power_test.sh` | — | keep |
| store: power-loss records | — | `patstore_test.c`, `patlink_test.c` (a cut at every byte) | — | drop |
| store: first boot, flash chips | `main.c`'s first-boot write; the JEDEC branches | `factory_test.c`, `bank_new_test.c` (the plan) | — | keep |
| upgrade | `main.c`'s order of the bank upgrade on real flash | `bank_new_test.c`, `preset_test.c` | — | keep |
| new patch | its first case repeats upgrade's | `bank_new_test.c` | — | merge into upgrade |
| panel buttons | — | golden `panel-buttons`, `button-toggle` | — | drop candidate |
| seq: arming, the piano roll | — | emulator scenarios `arming`, `rollBlack`, `rollPaging`, `stepRecord`; `m1emu roll` | — | merge |
| seq: songs | the pattern change at the end of a pass | `patterns` (through the editor) | caught #582's SONG bar bug (e64c303) | keep |
| count-in, global tempo | settings kept across a boot | `panel_test.c` | — | merge (one boot for both would save about three) |
| long delay | the Delay line's place in memory, block by block (#651) | golden delay kits; `checkDelays` | added for #651 | shorten (one bank, four slots, one boot) |
| stereo | — | `checkOutput` 1.1 (same fixture, same emulator) | — | drop |
| verona hats | Verona Drum 1's choke across two Drum maps | none | — | earlier (an engine claim, as `kit909.test.ts` checks the 909) |
| boot check | boot, update mode and the update handshake on the exact bytes; the blank factory region; the factory install | `ota_test.c`, `factory_test.c` (logic) | an AOT stack overflow passed it (`aot_stack.sh` caught it) | keep |

Only step 7's machine is checked for registers fm1-emu does not model; the other 32 machines are not
(`unknown_mmio` is per machine). The smoke test caught five firmware or data bugs in its history (READY late
5821de5 and dc6cc80; a HOME press 614682d; a hint race db26040; #582's SONG bar e64c303; the Oracle V Init mismatch of
PR #909), and needed about 17 updates after intended changes.

## 5. What this branch changes, and what it measured

Every change keeps every check and every verdict.

| change | before | after | how it was checked |
|---|---|---|---|
| smoke parts side by side (`run_parts`, `tools/emu/src/smoke.rs`) | 16.4 min | 3.6 min | 309 checks, 0 failed; the same check lines, level table and `run1.wav` as the one-after-another run (section 3) |
| boot check parts side by side | 81.8 s | 23.0 s | the same 32 check lines |
| `presetTo` waits for SLOT_NOW, goes the shorter way round (`device-check.mjs`) | 123 to 142 s each, 533 s for 4 checks | 18 to 47 s each | the same verdicts in the serial run (section 3) |
| four emulators by default, the smoke test beside them (`--smoke`, [D-1157](../ledger/releases.md#D-1157), [D-143](../ledger/releases.md#D-143)) | smoke 16.4 min, then scenarios 23.9 min: 40.3 min | 6.2 min for both | every shared check's verdict the same as the one-emulator run (section 3) |
| timing in `results.json` (`scenario`, `ms`), `timings.json`, part times in smoke and boot output | none | — | `emu-shards.test.mjs`, the runs above |
| the rig no longer records what it skips (MONO, MONO L, Meridian MONO, 3.5MM OUT by the hold) | 14 recordings | 10 | the skipped checks' verdicts are the same skips |
| the web run's slow renders in 6 parallel jobs, the record sealed after all pass (`web.yml`, `tools/ci_checks.py`) | 33.7 min | about 15 min (13 min for `levels-5`, 1.5 min setup) [INFERENCE] | `tools/ci_checks_test.py` |

## 6. For the owner to rule on

- [D-1157](../ledger/releases.md#D-1157) (Proposed): the candidate's scenarios over four emulators in the one slot.
- Whether `emu:smoke` and `emu:scenarios` may share the slot at once on a candidate (about 4 min).
- An amendment to [D-1151](../ledger/releases.md#D-1151): the rig drops `check35mmOut`. Proposed text: "There are five
  today: the MIDI clock's rate and timing, a drum hold's length across USB MIDI, STEREO's left and right heard on USB
  audio, flash writes under a held note, and the second core's timing." Evidence: section 4.
- An amendment to [D-147](../ledger/releases.md#D-147): "The full release-candidate web run measures coverage for every
  web test except the slow loudness files, and runs those files once without instrumentation in parallel jobs. The
  coverage display bundle is sealed only after every job passes."
- The emulator scenarios classed merge, earlier or drop in section 4. With four emulators the suite's wall time is
  small, so the case for these is the value of each check, not its time.
- Not changed, as rulings stand: the candidate's stages run in the order the agents choose. [D-141](../ledger/releases.md#D-141)
  already lets the rig start after the boot check. Starting it there instead of after the scenarios saves its 6 min
  (boot, install, scenarios) from the critical path at no cost.

## 7. The new qualification time (estimate)

| stage | 1.18.0, measured | with this branch [INFERENCE: sum of the measured parts] |
|---|---|---|
| release build | 4.2 min | 4.2 min |
| download and builds | 1.5 min | 1.5 min |
| boot check | 1.3 min (after the scenarios) | 0.4 min, first |
| smoke and scenarios | 16.4 min, then 23.9 min | 6.2 min together, in the one slot (measured) |
| rig install and scenarios | 4.4 min (after everything) | about 4 min, beside smoke and scenarios |
| web run | 33.7 min, beside | about 15 min, beside |
| **dispatch to the last check** | **52 min** | **about 20 min**, the web run the longest leg [INFERENCE: the measured stages above] |
