# Matryoshka — notes for Claude

Nord Modular–style patchable synth for the **M-VAVE FM-1**: a browser editor (`web/`, Vite + TS) with its own engine, and FM-1 firmware (`firmware/`) that plays the same patches. Owner: morgulbrut. Read first: `README.md`, `docs/ARCHITECTURE.md` (the design, formats, numbers), `docs/HANDOFF.md` (where the last session stopped), `LICENSING.md`.

**`docs/NOTES.md`** is the full dated log of every past session (what was built, decided and checked, file / function names). Search it (`grep -n`) before changing an area; this file only keeps what applies everywhere.

## Decisions made with the user

- **No FM engine and no Felucca features.** Only Felucca's flashing path and hardware layer (HAL, USB, update loader) are reused. GPL-3.0-only for the whole repo; keep Felucca's SPDX / copyright headers on copied files.
- **Hard fork (2026-10-17):** `glvno/matryoshka` is standalone. Remotes: `origin` = glvno/matryoshka, `upstream` = WiggisModular/Modular-1 (fetch only, push URL `DISABLED`). Default branch `main`; the `deploy` workflow (`.github/workflows/pages.yml`) publishes `main` to Cloudflare Pages (https://matry0shka.pages.dev/, the address is `SITE_URL` in `web/src/site.ts`); GitHub Pages (https://glvno.github.io/matryoshka/) serves only a forwarder that hands the browser data over (`deploy/github-pages-forward`, `web/src/migrate.ts`). No PR unless asked.
- Aftermarket firmwares: Felucca (`hugelton/Felucca`, GPL-3.0, reference source at `a4d7ca2e`, in `~/.jieli/felucca`; the only documentation of the hardware), Sloop (`isod89/sloop-fm1`). M-VAVE's `m-vave/fm1_open` (Apache-2.0) gave the stock V15 and the I2S rate.
- The device is a **patch player** (#57): top-level modules / assemblies are devices paged by SELECT / ALGO, K1..K4 edit the focused page (docs/ARCHITECTURE.md "Device pages").
- Factory patches are our own (`web/scripts/gen-presets.ts` from the factory assemblies), not upstream's.
- Wording: in user-visible text a stored sound is a "patch" (the PRESET knob steps patches); a "preset" is one assembly device's stored card values (#192); in the web app "voices" = polyphony. Terms: `CONTEXT.md` (glossary), `docs/adr/`.
- The user works on macOS only: Linux / NixOS notes in docs/NOTES.md are stale. The JieLi firmware build runs in CI (`.github/workflows/firmware.yml`).

## Not verified — do not claim otherwise

- **Device-checked 2026-10-20 / 21** (docs/NOTES.md, the device session list in #140): install / update mode / return to stock (installer and the web Flash tab), the panel, pages, PRESET, the 17 factory patches, the editor link (send, store, bank, sync, mirroring), USB MIDI in / out / Start-Stop, TRS notes, Steps (play, step entry, live take, Drum map rows), USB audio. Measured on the device: no FPU (the audio path is fixed point only), output samples are 24-bit in the LOW bits of each I2S word, CPU per factory patch (docs/measurements/). **Not yet checked on a device:** MIDI clock in, program change, arming a Steps track from the device (#179), a power cut mid-write. FACTORY RESET was checked on 2026-10-22 (docs/NOTES.md). Anything newer than the last device session is host / emulator-tested only: say so.
- FM-1 CPU clock, RAM and flash sizes are unknown (the chip is said to be a JieLi AC791N / pi32v2). Memory map hints: `firmware/app.ld`, `tools/build.py`.
- Button ids beyond PLAY / REC come from Felucca's panel table (fm1_open agrees), not measured.
- The CPU estimate (`web/src/cpu.ts`) is a model calibrated on 17 factory patches measured on the device (2026-10-20); per-module figures are not measured.

## Layout and commands

- Web (`cd web`): `npm test` (vitest), `npm run build`, `npm run dev` (the user runs one on port 5173: do not start a second). `npm run export-defs` regenerates `firmware/src/defs.h` + `presets.h` after any change to `modules.ts`, `presets/`, or a format bump (CI checks they are committed). `npm run cpu-costs` after any engine.c change; `npm run cpu-hot` to profile. `npm run fm1-wasm` builds the firmware UI as wasm for the FM-1 tab. `npm run emu` / `emu:smoke` run the firmware in fm1-emu (docs/EMULATOR.md; run the smoke before any device work).
- Engines: `web/src/engine.ts` + `modules.ts` (reference) ↔ `firmware/src/engine.c` (fixed point). `tools/golden.sh` compares them on every kit in `web/scripts/golden.ts`; `tools/engine_exact.sh [BASE]` proves a speed-up is bit-exact. Also `tools/panel_test.sh`, `tools/pool_sizes.sh` (stand-in pool estimate, overestimates), `tools/ui_preview.sh` (LCD to PNG).
- Generated: `python3 tools/gen_dsp_tables.py`, `gen_wavetables.py`, `gen_splash.py`, `gen_font.py`; `npx vite-node scripts/gen-assemblies.ts` then `gen-presets.ts`; `npm run logo-layers`.
- Device tools: the dev server's Flash tab installs this checkout's firmware CI build after emu:smoke passed on it (`web/dev/branch-firmware.ts`; `MATRYOSHKA_BUNDLED_FIRMWARE=1 npm run dev` for the bundled one); `npm run flash` the same from the terminal (`tools/fm1_install.py` from `build/venv`; `-- --info`, `-- x.fwsc`, `-- --ci RUN`), `tools/fm1_install.py` (preferred for flashing), `tools/m1_link.py` (editor protocol from the terminal). Patch format: `web/src/patchbin.ts` (currently format 33) ↔ engine.c / proto.c; protocol: `web/src/protocol.ts` ↔ `firmware/src/proto.c`.

## Rules when changing things

- Module types are appended to `ALL` in modules.ts; type / port indices are append-only. A format change: `patch.ts` (`validatePatch` migration), `patchbin.ts`, engine.c / proto.c (`ENG_PATCH_VERSION`, compat), presets, tests, golden kits, `npx vite-node scripts/legacy-factory.ts` (so the FM-1 rewrites untouched factory slots in the new format, main.c `bank_upgrade`) then `export-defs` — together.
- Keep both engines in step: `SCALES` order, quantized increments for anything driven by an accumulator, the same idle-part rule. Add a golden kit per new module / behaviour.
- New module types need a cost in cpu-costs.json (`cpu.test.ts` fails otherwise).
- Keep the LCD manual (`manual.c`: ≤ 35 chars, capitals, no `;`), the ? help card and the shortcut handler in step with what they describe.
- The firmware workflow's `paths` lists the web files `export-defs.ts` / `golden.ts` import: extend it when they gain imports.
- `course.json` (tutorial) is data: edit it in the lesson editor; stored patches there must pass `validatePatch` after model changes.
- Version strings are bumped at release. Releases: "Releasing" in docs/ARCHITECTURE.md (`release.yml`, emu:smoke and the owner's device check on those exact bytes, `npm run firmware -- <package>`, tag, GitHub release). Pages ships the committed package, so a firmware change reaches users only through a release. 1.0.0 = tag `v1.0.0` (2026-10-21), 1.1.0 = tag `v1.1.0` (2026-10-22); main is 1.2.0-dev.
- A user-visible change adds a line under `## Unreleased` in CHANGELOG.md; session detail goes to docs/NOTES.md.

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

- Use http://[::1]:5173 (same dev server, its own localStorage) so the user's patch, bank and progress stay untouched; else copy `localStorage['matryoshka.patch']` aside first (a source edit reloads the page and drops undo history).
- The computer tool's click coordinates are in its screenshot's frame, which can be smaller than the page (1512 vs 1728 CSS px on this Mac): scale by frame / `innerWidth`. Synthetic key events go to `document.body`. Stub `window.prompt` before actions that open dialogs. `setPointerCapture` throws for synthetic pointers.
- Open `/lesson-editor` by navigating from the synth page (a new tab gets 403).

## Agent skills

- [Issue tracker](docs/agents/issue-tracker.md)
- [Triage labels](docs/agents/triage-labels.md)
- [Domain documentation](docs/agents/domain.md)

## Keeping this file short

New session results go in `docs/NOTES.md` (append a dated section) and, if they are design, in `docs/ARCHITECTURE.md`. Only add here what every session must know.
