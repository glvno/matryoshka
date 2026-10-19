# Matryoshka (Modular-1) — notes for Claude

Nord Modular–style patchable synth for the **M-VAVE FM-1**: a browser editor (`web/`, Vite + TS) with its own engine, and FM-1 firmware (`firmware/`) that plays the same patches. Owner: morgulbrut. Read first: `README.md`, `docs/ARCHITECTURE.md` (the design, formats, numbers), `docs/HANDOFF.md` (where the last session stopped), `LICENSING.md`.

**`docs/NOTES.md`** is the full dated log of every past session (what was built, decided and checked, file / function names). Search it (`grep -n`) before changing an area; this file only keeps what applies everywhere.

## Decisions made with the user

- **No FM engine and no Felucca features.** Only Felucca's flashing path and hardware layer (HAL, USB, update loader) are reused. GPL-3.0-only for the whole repo; keep Felucca's SPDX / copyright headers on copied files.
- **Hard fork (2026-10-17):** `glvno/matryoshka` is standalone. Remotes: `origin` = glvno/matryoshka, `upstream` = WiggisModular/Modular-1 (fetch only, push URL `DISABLED`). Default branch `main`; GitHub Pages deploys from `main` (https://glvno.github.io/matryoshka/). No PR unless asked.
- Aftermarket firmwares: Felucca (`hugelton/Felucca`, GPL-3.0, reference source at `a4d7ca2e`, in `~/.jieli/felucca`; the only documentation of the hardware), Sloop (`isod89/sloop-fm1`). M-VAVE's `m-vave/fm1_open` (Apache-2.0) gave the stock V15 and the I2S rate.
- The device is a **patch player** (#57): top-level modules / assemblies are devices paged by SELECT / ALGO, K1..K4 edit the focused page (docs/ARCHITECTURE.md "Device pages").
- Factory patches are our own (`web/scripts/gen-presets.ts` from the factory assemblies), not upstream's.
- Wording: in user-visible text a stored sound is a "patch" (only the PRESET knob keeps its name); in the web app "voices" = polyphony.
- The user works on macOS only: Linux / NixOS notes in docs/NOTES.md are stale. The JieLi firmware build runs in CI (`.github/workflows/firmware.yml`).

## Not verified — do not claim otherwise

- **Nothing after M1-0.2 has run on a real FM-1.** Measured on the device then: no FPU (float 40-70x slower than Q15, so the audio path is fixed point only), 303 Acid at 11-12 % of the audio budget, output samples are 24-bit in the LOW bits of each I2S word. Everything since (patch transfer, bank, panel, pages, polyphony, Steps, the installer, MIDI out, TRS MIDI) is host-tested, emulator-tested at most.
- The flash tab and installer have never run against a real FM-1 in this project.
- FM-1 CPU clock, RAM and flash sizes are unknown (the chip is said to be a JieLi AC791N / pi32v2). Memory map hints: `firmware/app.ld`, `tools/build.py`.
- Button ids beyond PLAY / REC come from Felucca's panel table (fm1_open agrees), not measured.
- The CPU estimate (`web/src/cpu.ts`) is a model scaled from one device measurement.

## Layout and commands

- Web (`cd web`): `npm test` (vitest), `npm run build`, `npm run dev` (the user runs one on port 5173: do not start a second). `npm run export-defs` regenerates `firmware/src/defs.h` + `presets.h` after any change to `modules.ts`, `presets/`, or a format bump (CI checks they are committed). `npm run cpu-costs` after any engine.c change; `npm run cpu-hot` to profile. `npm run fm1-wasm` builds the firmware UI as wasm for the FM-1 tab. `npm run emu` / `emu:smoke` run the firmware in fm1-emu (docs/EMULATOR.md; run the smoke before any device work).
- Engines: `web/src/engine.ts` + `modules.ts` (reference) ↔ `firmware/src/engine.c` (fixed point). `tools/golden.sh` compares them on every kit in `web/scripts/golden.ts`; `tools/engine_exact.sh [BASE]` proves a speed-up is bit-exact. Also `tools/panel_test.sh`, `tools/pool_sizes.sh` (stand-in pool estimate, overestimates), `tools/ui_preview.sh` (LCD to PNG).
- Generated: `python3 tools/gen_dsp_tables.py`, `gen_wavetables.py`, `gen_splash.py`, `gen_font.py`; `npx vite-node scripts/gen-assemblies.ts` then `gen-presets.ts`; `npm run logo-layers`.
- Device tools: `tools/fm1_install.py` (preferred for flashing), `tools/m1_link.py` (editor protocol from the terminal). Patch format: `web/src/patchbin.ts` (currently format 29) ↔ engine.c / proto.c; protocol: `web/src/protocol.ts` ↔ `firmware/src/proto.c`.

## Rules when changing things

- Module types are appended to `ALL` in modules.ts; type / port indices are append-only. A format change: `patch.ts` (`validatePatch` migration), `patchbin.ts`, engine.c / proto.c (`ENG_PATCH_VERSION`, compat), presets, tests, golden kits, `export-defs` — together.
- Keep both engines in step: `SCALES` order, quantized increments for anything driven by an accumulator, the same idle-part rule. Add a golden kit per new module / behaviour.
- New module types need an LCD colour in `TYPE_COLOR` (ui.c) and a cost in cpu-costs.json (`cpu.test.ts` fails otherwise).
- Keep the LCD manual (`manual.c`: ≤ 35 chars, capitals, no `;`), the ? help card and the shortcut handler in step with what they describe.
- The firmware workflow's `paths` lists the web files `export-defs.ts` / `golden.ts` import: extend it when they gain imports.
- `course.json` (tutorial) is data: edit it in the lesson editor; stored patches there must pass `validatePatch` after model changes.
- Version strings are bumped at release.

## Gotchas and lessons

- **Never flash firmware that lacks Felucca's OTA handling** (USB MIDI + `ota.c` / `ota_hw.c`): it removes the way back. Recovery = re-run the install in the loader; return to stock = bundled `web/public/firmware/FM-1_015.fwsc`. Identity: ours `FM-1_7XY` (loader `ota-FM-1_700`), Felucca / Sloop `FM-1_9XY`, stock `FM-1_0XX`; the `FM-1` prefix must stay.
- `tools/build.py` rejects immediates between 0xFFC00000 and 0xFFD00000 (look like ROM addresses): Q16 constants of -64 .. -48 trip it.
- Fixed point: a Q16 one-pole with a small coefficient stalls short of its target; keep such states in Q24 / Q30. `exp2_q16` returns a plain integer. `sig_t` clashes with macOS `<signal.h>` (hence `esig_t`). The C name `STEPS_MAX` is a generated array.
- After a `git merge` into engine.c, read the whole file: fragments auto-merge without conflict markers.
- Never `git checkout <file>` on a file with uncommitted work.
- `pkill -f "<pattern>"` in a Bash call matches the shell itself; use `pgrep` + PID.
- Engine buffers are 128 frames; modules read `ctx.n`, not `BLOCK`. A VCA with nothing in cv is closed. An apply that deletes a module must use `removeModule`.
- Web MIDI + SysEx needs Chrome / Edge on https or localhost. Close the app's tab before CLI MIDI tools.
- fm1-emu's AArch64 JIT renders the engine wrong; `m1emu` uses the interpreter. USB, watchdog and real timing are not emulated.

## Browser checks

- Use http://[::1]:5173 (same dev server, its own localStorage) so the user's patch, bank and progress stay untouched; else copy `localStorage['modular-1.patch']` aside first (a source edit reloads the page and drops undo history).
- The computer tool's click coordinates are CSS px. Synthetic key events go to `document.body`. Stub `window.prompt` before actions that open dialogs. `setPointerCapture` throws for synthetic pointers.
- Open `/lesson-editor` by navigating from the synth page (a new tab gets 403).

## Agent skills

- [Issue tracker](docs/agents/issue-tracker.md)
- [Triage labels](docs/agents/triage-labels.md)
- [Domain documentation](docs/agents/domain.md)

## Keeping this file short

New session results go in `docs/NOTES.md` (append a dated section) and, if they are design, in `docs/ARCHITECTURE.md`. Only add here what every session must know.
