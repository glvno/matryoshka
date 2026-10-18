// SPDX-License-Identifier: GPL-3.0-only
// The demo patch behind the sidebar's Demo button: a full song sketch that shows what a big patch sounds like. It plays
// only in the browser (far over the FM-1 budget), so it is not a factory patch (presets/ is compiled into the firmware).
import { DEFS } from './modules';
import { validatePatch, type Patch } from './patch';
import raw from './demo/sum1-gr8.json';

/** a fresh copy of the demo patch: drums on Steps tracks (KICK, SNARE, HAT; PUMP restarts the drone's pump every
 *  quarter) at the Main module's 96 bpm, the Hera 6 bassline (the HERA track; `wait 4 bars` keeps it out until bar 5,
 *  then restarts it at step 1) and the Synthi drone, which
 *  plays on its own as soon as audio runs; the Demo button starts the transport too */
export const demoPatch = (): Patch => validatePatch(structuredClone(raw), DEFS);
