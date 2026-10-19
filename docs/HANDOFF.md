# Handoff: what to work on next

Written 2026-10-19 (second session of the day). Read CLAUDE.md first (decisions, gotchas, the state of each feature; the
sections "Device pages" and "Groups, knob-tinted bars, layout A+" are the newest) and docs/ARCHITECTURE.md "Device
pages". The earlier handoffs are in git history.

## Where things stand

- Done this session, each closed on glvno/matryoshka: #104 splash on the night background, #105 sections and groups
  (`ParamRef.group`, `groupStarts`), #106 knob-tinted bars for the focused page, #107 FM-1 page layout A+, #108 the
  panel core (`firmware/src/panel.c`, host test `tools/panel_test.sh`), #109 the firmware UI as WebAssembly
  (`firmware/wasm/fm1_ui.c`, `npm run fm1-wasm`, `web/src/fm1-ui.ts`), #110 the editor's FM-1 tab (`web/src/fm1-view.ts`).
- `device-pages` was merged into `main` after #107 (e46dcbb). #108–#110 are on `device-pages` only (pushed, CI green):
  merge them into `main` when the user agrees (that deploys the FM-1 tab to Pages).
- Verified: vitest 672, golden 84 + proto + panel tests, `npm run build`, the JieLi CI build (no warnings, pool 41.5 KB
  free), `npm run emu:smoke` 108 / 108 on efd5f84 (the last commit that changed device code), the editor and FM-1 tab
  in Chrome on [::1]:5173.
- Not verified: anything on a real FM-1 (nothing is flashed until a second unit is in hand), the editor link over USB,
  real-panel colours and drawing speed of layout A+ (`pages_bar` blits each bar a scanline at a time).
- Known gaps: plain modules' row labels on the FM-1 are the firmware's short capitals; the FM-1 tab's panel layout is
  our own flat drawing, not measured from the device; the emulator tab ignores MIDI out.

## Suggested order

1. Ask the user about merging `device-pages` (#108–#110) into `main`.
2. **#111** C engine audio in the FM-1 tab (the wasm already renders the engine silently on each tick: route its
   output to an AudioWorklet instead of the browser engine, or let the user choose).
3. **#112** Faint envelope shapes on envelope pages (inside the bars of layout A+; the old `pages_envelope` is in git
   history before 735b504).

## Working notes

- Browser checks: http://[::1]:5173 (the user's dev server, separate storage). Do not start a second dev server. A
  source change can make Vite reload the page. The browser window could not be resized: a 390 px iframe of the same
  page served as the phone-width check.
- `gh` needs `-R glvno/matryoshka`.
- After a push: wait for the `firmware` workflow, then `cd web && npm run emu:smoke` (it fetches the CI build of the
  checkout's commit).
- The FM-1 tab needs `web/public/fm1-ui.wasm`: `cd web && npm run fm1-wasm` after any change to the firmware UI (the
  vitest rebuilds it when a source is newer; the web and Pages workflows build it).
- LCD previews: `tools/ui_preview.sh out.png PRESET DEVICE:PAGE ...` with env `TOAST=k`, `DEVTOAST=1`.
