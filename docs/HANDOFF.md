# Handoff: what to work on next

Written 2026-10-19 (fourth session of the day). Read CLAUDE.md first (decisions, rules, gotchas), then `docs/NOTES.md`
for the area you touch (the full dated log; `grep -n` it) and docs/ARCHITECTURE.md "Device pages" (which now holds the
button kinds, Page buttons, GLO, navigation) and "MIDI out map" / "Following the FM-1's panel". The earlier handoffs are
in git history.

## Where things stand

- `main` is pushed and deployed. This session implemented the whole #113–#120 set from the 2026-10-19 grilling session
  (design canvas, private: https://claude.ai/artifact/AVwEtd7tAMwHjaRhu4n5mu, boards D E F G I), one commit each:
  - #113 Main dock to board D: knob jacks on the dock edge, pickers under the knobs, the FM-1 button grid in device
    order (HOME SAVE SEQ REC greyed, PLAY = transport), patch-button jacks with gold traces.
  - #115 Matryoshka's MIDI out reports every panel control (buttons raw CC 80..93, SELECT / ALGO / PRESET relative
    CC 20 / 21 / 23, MASTER CC 7, PLAY also Start / Stop). CC 80..86 out are now presses, not states.
  - #114 HOME = back along a trail, HOME held = menu, SAVE closes the menu, ALGO sideways / SELECT picks, PRESET only
    patches; the legend is gone.
  - #116 button kinds Nothing / Gate / Toggle (binary format 30, flag bit 6; compat stays 29), the button editor
    popover, dock faces, LEDs dark / dim / lit. Old patches = Gates; new patches = Nothing.
  - #117 Page buttons (kind 3): press steps a list of device pages, hold peeks the first, the bar reads
    "SCL 2/3 - AMP ENV"; editor PAGES list (picker, Alt-click a row, drag).
  - #118 GLO = Main's global page (tempo, morph, first arpeggiator's rate / gate; footer lists the buttons).
  - #119 the first Arpeggiator's rows in the dock, "+ Add arpeggiator" (ARP becomes its Toggle).
  - #120 a connected FM-1 drives the page through plain MIDI, any firmware (identity handshake or picked by hand,
    profiles in `fm1-profiles.ts`, the wasm panel logic runs the inputs); PARAM_NOW / FOCUS_NOW are no longer used.
- Verified: vitest 695, `npm run build`, golden 85 + proto (incl. `button-toggle`), the panel host test (trail, MIDI
  out of every control, a page list, GLO; LCD snapshots with `PANEL_SNAP=x.ppm` / `PANEL_SNAP_GLO=x.ppm`), JieLi CI
  builds, emulator smoke 107 / 107 on the CI build of 84ffc49 (#118's firmware; #119 and #120 changed none), editor checked on [::1]:5173. **Nothing on a real FM-1**, and
  #120's Follow was never pressed against a device (no FM-1 here; no MIDI permission prompt in the browser check).

## Suggested next

1. Open older work: **#111** C engine audio in the FM-1 tab, **#112** envelope shapes in the bars, **#102** / **#103**
   A/B flip bugs.
2. Things this session left for a device or a decision (not filed as issues yet):
   - #120 on hardware: the identity handshake per firmware, Felucca's and Baud Girl's CC numbers (from the survey, not
     measured), stock V15's MIDI.
   - A knob from the FM-1 now reaches the editor as a 7-bit row position (CC 16..19), not PARAM_NOW's exact value: the
     editor's value can differ slightly from the device's. The owner chose "plain MIDI only"; check it is acceptable.
   - In the editor a Page button's list is left by moving the focus another way (the dock's HOME is inert).
   - ARP as the arpeggiator's Toggle: lit = bypassed (every Toggle is "engaged = target bypassed").

## Working notes

- Browser checks: http://[::1]:5173 (the user's dev server, separate storage). Do not start a second dev server. A
  source change can make Vite reload the page. To read the user's own patch, open http://localhost:5173/@vite/client
  (same origin, does not run the app) and copy `localStorage['modular-1.patch']` with `navigator.clipboard.writeText`
  + `pbpaste` (the JS tool truncates long results). Synthetic pointer presses on the dock can start the audio: press
  Panic (`#audio-btn`) after.
- `gh` needs `-R glvno/matryoshka`. Labels: `enhancement` / `bug`, `ready-for-agent`, `device` for firmware work.
- After a push: wait for the `firmware` workflow, then `cd web && npm run emu:smoke` (it fetches the CI build of the
  checkout's commit, else the newest on main). A local `cargo build` of tools/emu rewrites `tools/emu/Cargo.lock`
  (drops a `source` line): restore it, do not commit it.
- The FM-1 tab needs `web/public/fm1-ui.wasm`: `cd web && npm run fm1-wasm` after any change to the firmware UI.
- `npm run export-defs` after any format change (presets.h is format 30 now).
