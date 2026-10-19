# Handoff: what to work on next

Written 2026-10-19 (third session of the day). Read CLAUDE.md first (short now: decisions, rules, gotchas), then
`docs/NOTES.md` for the area you touch (the full dated log that used to be CLAUDE.md; `grep -n` it) and
docs/ARCHITECTURE.md "Device pages". The earlier handoffs are in git history.

## Where things stand

- `main` is clean and deployed. This session:
  - CLAUDE.md was over its size limit: the session log moved verbatim to `docs/NOTES.md`; CLAUDE.md keeps decisions,
    the not-verified list, commands, change rules, gotchas, browser-check notes. Add new session results to NOTES.md
    (a dated section), not to CLAUDE.md.
  - The demo patch (`web/src/demo/sum1-gr8.json`) is the user's current Sum1 Gr8 (97 modules), deployed to Pages.
  - A grilling session designed the FM-1 buttons, the Main dock, GLO, navigation and device mirroring. Nothing was
    implemented; it became issues **#113–#120** (bodies hold the decisions and acceptance criteria). Design canvas
    (private, the user's): https://claude.ai/artifact/AVwEtd7tAMwHjaRhu4n5mu, boards D (dock), E (button faces),
    F (button editor), G (arpeggiator on the dock), I (GLO page). Boards A, B, C, H are rejected options.
- Decisions behind #113–#120, in short:
  - Patch buttons FX SCL ENV LFO EDIT ARP have a kind per patch: Nothing (default, no implicit roles), Gate (today),
    Toggle (bypass a module / assembly, held or switching), Page (a list of device pages: press steps round, hold
    peeks page 1, HOME back). Every button keeps its jack (high while held / engaged). LEDs: dark unassigned,
    dim assigned or cabled, lit engaged.
  - GLO is fixed: Main's global page (tempo, morph, first arpeggiator's rate and gate, "—" without one); its footer
    lists the button labels; the HOME legend goes.
  - HOME tap = back everywhere (a trail), HOME held = menu, SAVE closes it; ALGO sideways, SELECT picks, PRESET only
    patches.
  - The arpeggiator stays a module; the dock shows the first one's controls; "+ Add arpeggiator" also assigns ARP as
    its Toggle.
  - A connected FM-1 drives the web app through plain MIDI only, whatever firmware it runs; the browser engine keeps
    playing. The survey of what each firmware sends is in #120 (other firmwares send little beyond keys).
- Verified this session: vitest (677) and `npm run build` after the demo change. Earlier checks (golden, proto +
  panel tests, JieLi CI build, emulator smoke 108 / 108) are unchanged since no engine or firmware code changed.
  Nothing on a real FM-1.

## Suggested order

1. ~~#113 dock layout~~ done 2026-10-19 (docs/NOTES.md "Main dock to board D"). Next, independent: **#114** navigation
   (firmware + wasm) and **#115** MIDI out of every control (firmware); #116 and #119 are unblocked.
2. **#116** button kinds + editor + LEDs (format bump), then **#117** page buttons, **#118** GLO, **#119** arpeggiator
   on the dock.
3. **#120** MIDI mirroring for any firmware (after #115).
4. Older open work: **#111** C engine audio in the FM-1 tab, **#112** envelope shapes in the bars, **#102** / **#103**
   A/B flip bugs.

## Working notes

- Browser checks: http://[::1]:5173 (the user's dev server, separate storage). Do not start a second dev server. A
  source change can make Vite reload the page. To read the user's own patch, open http://localhost:5173/@vite/client
  (same origin, does not run the app) and copy `localStorage['modular-1.patch']` with `navigator.clipboard.writeText`
  + `pbpaste` (the JS tool truncates long results).
- `gh` needs `-R glvno/matryoshka`. Labels: `enhancement` / `bug`, `ready-for-agent`, `device` for firmware work
  (`editor` is for tutorial work).
- After a push: wait for the `firmware` workflow, then `cd web && npm run emu:smoke` (it fetches the CI build of the
  checkout's commit).
- The FM-1 tab needs `web/public/fm1-ui.wasm`: `cd web && npm run fm1-wasm` after any change to the firmware UI.
- LCD previews: `tools/ui_preview.sh out.png PRESET DEVICE:PAGE ...` with env `TOAST=k`, `DEVTOAST=1`.
- Facts found this session that are not obvious from the code: Matryoshka's MIDI out now sends every panel control
  (docs/ARCHITECTURE.md "MIDI out map", #115; notes saying K1..K6 / CC 16..21 / 80..88 are stale); the device's PLAY,
  tempo, octave, slot loads (beyond the status line), menu and LCD do not reach the editor; the FM-1 tab runs its own
  wasm copy fed from the editor, not the device.
