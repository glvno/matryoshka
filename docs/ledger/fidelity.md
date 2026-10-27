# Factory fidelity

IDs: D-700–D-749

Factory cards follow their original instruments' controls ([D-347](patches-and-presets.md#D-347)). This file records choices about how those controls and patch points work. It does not certify that an instrument is complete.

| ID | Decision | Status | Date | Source |
|---|---|---|---|---|
| <a id="D-702"></a>D-702 | Silver Box's TUNING row is an Offset into the oscillator's pitch, so it spans the Roland TB-303's ±500 cents. The row reads in octaves and reaches ±4 octaves, wider than the original's knob. The copy inside the `<7PH` test patch keeps the oscillator's fine tune (±100 cents) and the short `cutoff` row name, to fit its byte budget. | Proposed (decider: michael glaviano) | 2026-10-27 | issue #375; [TB-303 owner's manual, specifications](https://archive.org/details/synthmanual-roland-tb-303-owners-manual); `web/scripts/gen-assemblies.ts`; `web/scripts/gen-presets.ts` |
| <a id="D-703"></a>D-703 | Io 4 on the FM-1 names the positions of its switches with the Roland Jupiter-4's panel legends, except its five OFF / ON switches: sub, noise, portamento, hold and ensemble. Those stay numbered, 1 for OFF and 2 for ON, because the FM-1 patch has 2 bytes left. For the same reason, NOISE shares the VCO's second page, POLARITY reads NORM / INV and TRANSPOSE reads NORMAL / -1 OCT. | Proposed (decider: michael glaviano) | 2026-10-27 | issue #375; Jupiter-4 owner's manual ('82 AUG.), specifications; `web/scripts/gen-assemblies.ts` |
| <a id="D-704"></a>D-704 | Io 4's LFO RATE uses the LFO's fast range: the `rate` row times two, 0.04 to 80 hertz, so it reaches the Jupiter-4's 80 hertz. The row shows the rate the LFO runs at ([D-372](engine.md#D-372)). It reaches below the Jupiter-4's 0.1 hertz, down to 0.04 hertz. The wide range of [D-445](modules.md#D-445) stays at 55 hertz for Algo Four XL, whose DX100 LFO tops out there. LFO BEND reaches 1 or 4 octaves of the fast range, as NORM / WIDE selects. | Proposed (decider: michael glaviano) | 2026-10-27 | issue #375; issue #351; Jupiter-4 owner's manual ('82 AUG.), specifications; `web/scripts/gen-assemblies.ts` |

## Not yet settled

