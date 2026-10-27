# Factory fidelity

IDs: D-700–D-749

Factory cards follow their original instruments' controls ([D-347](patches-and-presets.md#D-347)). This file records choices about how those controls and patch points work. It does not certify that an instrument is complete.

| ID | Decision | Status | Date | Source |
|---|---|---|---|---|
| <a id="D-700"></a>D-700 | Canvas XL exposes its control sources as assembly output jacks, including four independent random voltages, the inverter and preset voltage. Each patch-field input has a PATCH choice that accepts a cord at its assembly input. Its other seven choices are shortcuts to the main pitch, pressure, sequencer, envelope, pulser, first random voltage and modulation oscillator. | Proposed (decider: michael glaviano) | 2026-10-26 | issue #303; Music Easel manual audit |
| <a id="D-701"></a>D-701 | Silver Box has a named SAW / SQUARE waveform switch. The copy inside the `<7PH` test patch keeps a plain oscillator waveform row to fit its byte budget. | Proposed (decider: michael glaviano) | 2026-10-26 | issue #303; factory integration handoff |

## Not yet settled

- Final fidelity verdicts and the remaining original-instrument controls, after every required engine feature is complete — issues #303 and #351.
