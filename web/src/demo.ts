// SPDX-License-Identifier: GPL-3.0-only
// The demo patch behind the sidebar's Demo button: a full song sketch that shows what a big patch sounds like. It plays
// only in the browser (far over the FM-1 budget), so it is not a factory patch (presets/ is compiled into the firmware).
import { DEFS } from './modules';
import { validatePatch, type Patch } from './patch';
import raw from './demo/sum1-gr8.json';

/** a fresh copy of the demo patch: drums on Steps tracks at the Main module's 113 bpm, the Hera 6
 *  bassline (the HERA track; `wait 4 bars` keeps it out until bar 5, then restarts it at step 1) and the Synthi drone.
 *  From bar 13, XYLO's 64 steps play four times (16 bars), then OPER's 32 steps four times (8 bars), repeating;
 *  a resonant, modulated pulse squeak plays the offbeat eighths during each OPER section;
 *  the squeak loop assembly bypasses the section timing for sound design (off by default);
 *  it is silent until the transport runs, which the Demo button starts */
export const demoPatch = (): Patch => validatePatch(structuredClone(raw), DEFS);
