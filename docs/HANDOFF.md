# Handoff: what to work on next

Written 2026-10-18 at the end of a session. Read CLAUDE.md first (decisions, gotchas, the state of each feature); this
file is the work queue after that session. The previous handoff (2026-10-13: the one-voice build and the first new
modules) is done and lives in git history.

## Where things stand

- `main` at 7181c3d (local; `origin/main` and `device-player` are at a636b57 until the next push). Everything is on
  `main`; `device-player` is merged and only kept for its worktree.
- Host-tested: vitest 624, `tools/golden.sh` 84 kits + proto_test (incl. step values), LCD previews, `npm run build`.
- The JieLi CI build of the newest commits has not been run in the emulator yet: after a push, wait for the
  `firmware` workflow, then `cd web && npm run emu:smoke` (it fetches the CI build of the checkout's commit). The last
  smoke (a636b57) passed 108 / 108.
- Nothing has run on a real FM-1 since M1-0.2. The user will not flash until a second FM-1 is in hand
  (memory: no-flash-until-second-device). Device work stays host + emulator only; #1 tracks the first real build and flash.
- Binary patch format 28 (compat 28): step values (27), Env L/R `shot` (28).

## Closed this session

#90 #91 #93 (step grid styling, step note / velocity, drum kit assembly) and, as implemented on `main` but not verified on a
device, #22 #36 #45 #58-#66 #67-#70 #72 #74 #76 #78 #81 #83. #57 (the device-player spec) stays open as the umbrella
until the device has been seen running the player.

## Suggested order

### 1. #94: no flashing from the production build (safety, small) — done 2026-10-18 with #80 and #77 (see CLAUDE.md "Flash tab")

GitHub Pages serves a one-click installer of firmware that has never run on hardware. Hide or disable the Flash tab's
install / return-to-stock / other-package actions unless `import.meta.env.DEV` (or an explicit opt-in such as a URL flag
plus a typed confirmation), and say on the tab why. Files: `web/src/flasher.ts`, `index.html` (`#tab-flash`), `main.ts`
(tab wiring). Check that the Pages workflow's `dist/` checks (the bundled stock .fwsc) still pass. Natural companions,
both in the flasher and marked ready-for-agent:

- #80: `fm1ota.js` `Link` overwrites `input.onmidimessage` and nulls it on close, killing the editor's live link. Use
  `addEventListener` / `removeEventListener` for its own handler (or have `device.ts` reattach after a flash).
- #77: `fm1ota.js` `serve` (lines ~170-174) answers either finish address in either phase and accepts zero-length
  requests; match M-VAVE's `WebUpdate.js` (exact finish address, keep answering duplicates for a settle window), and
  `tools/fm1_install.py` the same.

### 2. Editor bug batch (small, one pass) — done 2026-10-18 (#84 #86 #87 #88)

- #87 saved patches can't be deleted: the Library's "Your patches" card does have a × (`web/src/bank.ts` ~line 166 ->
  `removeSaved`). Find out why the user could not use it (hidden by the "quiet row tools" CSS until hover? not
  refreshed? not reachable from the Open picker, which is where the user looks?). Add delete where the user expects it,
  confirm without a browser dialog (in-app prompt or an undo toast), and check it survives a reload.
- #84 the command palette (`commands()` in `web/src/main.ts`, ~line 563) offers modules / assemblies / patches the pickers
  no longer list (Part, Main, retired factory items). Build its entries from the same sources as Add module
  (`MODULE_GROUPS`), the assembly browser (`FACTORY` + the library) and the Open picker (`fillPicker`), plus a test.
- #86 `#demo-btn` uses `--btn-blue` (style.css `.sidebar #demo-btn`); use the teal + Add assembly uses.
- #88 logo colours (`web/public/brand`, the logo in the sidebar) to the button palette, ideally from the CSS tokens so
  light / dark stay in step.

### 3. Larger editor features

- (done 2026-10-18) #92 copy / paste of the selection (modules and assemblies with nested ones and the cables among them) through the
  system clipboard as JSON with an in-app fallback; works across patches; pasted items become the selection; one undo
  step. Reuse `dragSet()`, `toDef` / `insertAssembly` (they now carry Steps data) and the Duplicate code path.
- (done 2026-10-18 as ribbon cables, see CLAUDE.md) #85 an expanded assembly's frame shows the same exposed jacks on its edges as the collapsed card (inputs left, outputs
  right, extras along the bottom), with the cables drawn to them.
- #55 displays (scopes, envelope shapes, step grids) spanning several columns of an assembly card; #54 per-voice scope
  traces of a poly assembly.

### 4. Device work that stays host + emulator only

- (done 2026-10-18, see CLAUDE.md) #89 boot splash -> the Matryoshka logo (+ wordmark if it fits) in `splash_draw` (main.c): convert the art at build time
  with a script in `tools/` (packed bitmap / palette, RGB565 LCD 240 x 240), keep the `boot_step` lines and bar, check
  pool and flash headroom in `tools/build.py`, preview with `tools/ui_preview.sh`, run the emulator smoke.
- (done 2026-10-18) #73 warn on the Flash tab (and in the README) before installing over Felucca: our patch store and bank sectors lie
  inside Felucca's project / sample store.
- #79 an identity scheme of our own (needs a decision from the user: today every build is `FM-1_800`, release builds
  take Felucca's `FM-1_9XY` space, `FM-1_8` is M-VAVE Official Open's prefix); keep `loaderFits` / `loader_fits` in step.
- Verification only, needs hardware: #82 (USB audio at the 44118 Hz engine rate), #75 and #71 (return to stock), #56
  (velocity and aftertouch from the keys, an outside project), #1.

## Things the user mentioned that have no ticket yet

- (done 2026-10-18) The 909 Kit factory patch (`web/presets/16-909-kit.json`, kept by hand) still has gated envelopes: its decays are cut
  by the short Steps trigs as the 808 Kit's were. Convert its drum envelopes to `shot` (and refit their decays) if the
  user wants it.
- (done 2026-10-18 for the drum kit assembly and the demo's Hera; the 808 Kit patch still has none) A Steps track's `vel` output is not cabled anywhere in the drum kit or the demo's HERA track; wiring velocity into the
  drums' levels (or Hera's VCA / filter) is open.
- (deleted 2026-10-18) localStorage `matryoshka.patches.backup-2026-10-18` (localhost:5173) holds the user's saved patches from before the
  cleanup; remove it once the user confirms the new demo is right.

## Working notes

- Browser checks: use http://[::1]:5173 (the user's dev server, separate storage) unless the task is the user's own
  data on http://localhost:5173. A source change can make Vite reload the page and drop in-memory state: keep work in
  `sessionStorage` while scripting the page. The browser tool truncates long results and blocks base64; to bring a large
  JSON out of the page, POST it to a one-shot local receiver in the scratchpad.
- `gh` needs `-R glvno/matryoshka` (it defaults to upstream); in zsh pass it literally, a `$R` variable does not split.
- After changing `modules.ts` / presets: `npm run export-defs`; after engine.c: `npm run cpu-costs`; after a
  default-parameter change: run course.json's stored patches through `validatePatch` (the tutorial tests compare them).
