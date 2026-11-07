// SPDX-License-Identifier: GPL-3.0-only
// The test patches of the owner's 1.10 device check (scripts/device-check.mjs), built here from the descriptions on the
// check's page: the owner made them by hand in the editor and kept them in Your patches. Each starts from a factory patch's
// JSON (web/presets), so the editor's validatePatch reads it as it reads any saved patch. src/check-fixtures.test.ts checks
// that each is what its description says (and fits the FM-1, or not, as the check needs).
import { readFileSync } from 'node:fs';

const preset = (file) => JSON.parse(readFileSync(new URL(`../presets/${file}`, import.meta.url), 'utf8'));
/** MIDI note numbers */
export const NOTE = { C3: 48, 'C#3': 49, D3: 50, E3: 52, G3: 55, C4: 60 };
const step = (at, note, len = 1) => ({ at, len, note, vel: 100 });
const cable = (fm, fp, tm, tp) => ({ from: { module: fm, port: fp }, to: { module: tm, port: tp } });

/** Basic Poly (factory patch 26): Main's keys into PATTERN (a Steps track), its keys into the Arpeggiator (bypassed) and
 *  the Voicing of the basic poly engine (saw, 24 dB low pass, ADSR with sustain 0.6, VCA, 4 voices), named `name`, PATTERN
 *  pattern 1 holding `notes` */
function basicPoly(name, notes = []) {
  const p = preset('25-basic-poly.json');
  p.name = name;
  delete p.notes;
  p.modules.find((m) => m.type === 'steps').notes = notes;
  return p;
}
const nextId = (p) => Math.max(...p.modules.map((m) => m.id)) + 1;

/** T110 MONO L R (D-918, D-919): a saw hard left, a sine an octave up hard right, both from the keys */
export function monoLR() {
  const p = basicPoly('T110 MONO L R');
  const osc = nextId(p), vca = osc + 1;
  p.modules.push(
    { id: osc, type: 'osc', x: 260, y: 420, params: { wave: 0, pw: 0.5, coarse: 12, fine: 0, pm: 0, level: 0.8, fb: 0, unison: 1, detune: 10, blend: 0.5, stack: 0, pm2: 0, pm3: 0 } },
    { id: vca, type: 'vca', x: 520, y: 420, params: { gain: 0.62 } },
  );
  p.assemblies[0].modules.push(osc, vca);
  // the engine's VCA (6) to the left only; the sine's VCA to the right
  p.cables = p.cables.filter((c) => !(c.from.module === 6 && c.to.module === 7 && c.to.port === 'r'));
  p.cables.push(cable(2, 'pitch', osc, 'pitch'), cable(osc, 'out', vca, 'in'), cable(5, 'env', vca, 'cv'), cable(vca, 'out', 7, 'r'));
  return p;
}

/** T110 DRONE (D-819): C3 on step 1 for all 16 steps, E3 on steps 5 and 11, G3 on step 9, D3 on step 13 */
export const drone = () => basicPoly('T110 DRONE', [step(0, NOTE.C3, 16), step(4, NOTE.E3), step(8, NOTE.G3), step(10, NOTE.E3), step(12, NOTE.D3)]);

/** T110 DRONE STORED (D-819, format 50): C3 already a drone (tied round the loop onto itself) */
export const droneStored = () => basicPoly('T110 DRONE STORED', [{ ...step(0, NOTE.C3, 64), wrap: true }]);

/** T111 LIVE DRONE (D-819): Basic Poly, PATTERN with only C4 on steps 5 and 13 */
export const liveDrone = () => basicPoly('T111 LIVE DRONE', [step(4, NOTE.C4), step(12, NOTE.C4)]);

/** T111 TWO DELAYS (D-375, D-376): a saw pluck into two Delays, LONG (1200 ms, its line 1200 ms) to the left and SHORT
 *  (300 ms, its line 300 ms) to the right, each one echo (no feedback), half dry. Its lines: 129 KB of the FM-1's memory */
export function twoDelays() {
  const p = basicPoly('T111 TWO DELAYS');
  Object.assign(p.modules.find((m) => m.id === 5).params, { a: 0.002, d: 0.12, s: 0, r: 0.08 });   // (a pluck)
  const long = nextId(p), short = long + 1;
  const delay = (id, name, ms, y) => ({ id, type: 'delay', name, x: 780, y, params: { time: ms, fb: 0, mix: 0.5, sync: 0, pingpong: 0, note: 0, swell: 0, length: ms } });
  p.modules.push(delay(long, 'LONG', 1200, 300), delay(short, 'SHORT', 300, 520));
  p.cables = p.cables.filter((c) => !(c.from.module === 6 && c.to.module === 7));
  p.cables.push(cable(6, 'out', long, 'in'), cable(6, 'out', short, 'in'), cable(long, 'out', 7, 'l'), cable(short, 'out', 7, 'r'));
  return p;
}

/** T111 NO KEYS (D-905, D-295, #633): the basic poly engine with Main's keys cable removed (nothing else plays its
 *  Voicing: Basic Poly's PATTERN and Arpeggiator are left out); a Steps track CUTOFF drives only its cutoff (its pitch into
 *  the filter's cv, the engine's "cutoff cv" input) */
export function noKeys() {
  const p = basicPoly('T111 NO KEYS');
  const gone = new Set(p.modules.filter((m) => m.type === 'steps' || m.type === 'arp').map((m) => m.id));
  p.modules = p.modules.filter((m) => !gone.has(m.id));
  p.cables = p.cables.filter((c) => !gone.has(c.from.module) && !gone.has(c.to.module) && !(c.from.module === 1 && c.from.port === 'keys'));
  delete p.modules.find((m) => m.type === 'fm1').panel;   // (its ARP button played the Arpeggiator)
  const t = nextId(p);
  p.modules.push({ id: t, type: 'steps', name: 'CUTOFF', x: 20, y: 2300, params: { len: 16, rate: 4, swing: 50, gate: 0.25, dir: 0 },
    notes: [step(0, NOTE.C3), step(4, NOTE.G3), step(8, NOTE.C4), step(12, NOTE.G3)] });
  p.cables.push(cable(t, 'pitch', 4, 'cv'));
  return p;
}

/** a patch with a pattern as 1.9 stored it (#627's bank of an earlier firmware): factory patch Silver Box as release 1.9.1's
 *  firmware wrote it into the bank (v1.9.1's firmware/src/presets.h: format 48, its patterns and songs), under a name of
 *  its own. The bytes are kept in check-old-patch.json */
export function oldPatch() {
  return JSON.parse(readFileSync(new URL('./check-old-patch.json', import.meta.url), 'utf8'));
}

/** every test patch, by name */
export const FIXTURES = { monoLR, drone, droneStored, liveDrone, twoDelays, noKeys };
