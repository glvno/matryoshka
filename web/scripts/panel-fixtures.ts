// SPDX-License-Identifier: GPL-3.0-only
// The FX drawer's panel fixtures (1.26.2, #1214), written by `golden.ts --panel-fixtures` into build/panel-fixtures/:
// format-66 patches with FX drawers for firmware/test/panel_test.c (fx_suite, controls_test.h, fx_preset_panel_test.h
// fxd_preset_suite) and firmware/test/pal_preset_test.c. The format-55..65 master FX bus patches the FM-1 still reads are
// frozen in firmware/test/legacy_fx_fixtures.h (no encoder writes them any more).
import { writeFileSync } from 'node:fs';
import { encodePatch } from '../src/patchbin';
import { DEFS } from '../src/modules';
import { newPatch, type Patch } from '../src/patch';
import { insertAssembly, type AssemblyInst } from '../src/assembly';
import { FACTORY } from '../src/assemblies';
import { wireEngine } from '../src/engines';
import { setKind, setSwitches, setTarget } from '../src/buttons';
import { addDrawer, insertEffect } from '../src/fx-drawer';

/** a factory instrument, its keys from Main (its audio into the Output when nothing feeds it yet) */
function instrument(p: Patch, name: string, x: number): AssemblyInst {
  const a = insertAssembly(p, DEFS, FACTORY.find((d) => d.name === name)!, x, 0);
  wireEngine(p, a);
  return a;
}

/** the drawer fixtures' effects, one of each way an effect sits in the stereo chain: an L/R pair, a stereo stage, a wet one */
const EFFECTS = ['shape', 'delay', 'reverb'];

export function writeFxPanelFixtures(out: URL): void {
  const write = (name: string, p: Patch): void => writeFileSync(new URL(`${name}.m1p`, out), encodePatch(p, true));
  {
    // fx-drawer: Monolith D with three effects in its drawer; LFO a Toggle on the drawer (its on/off on the FM-1)
    const p = newPatch(DEFS);
    const a = instrument(p, 'Monolith D', 300);
    const drawer = addDrawer(p, a.id);
    for (const type of EFFECTS) insertEffect(p, drawer, { type });
    setKind(p, 'lfo', 'bypass');
    setTarget(p, 'lfo', { asm: drawer.id });
    setSwitches(p, 'lfo', true);
    write('fx-drawer', p);
  }
  {
    // fx-layers: Silver Box (no drawer, into the Output), Monolith D with a drawer of one effect, and an Output drawer
    const p = newPatch(DEFS);
    instrument(p, 'Silver Box', 300);
    const b = instrument(p, 'Monolith D', 900);
    insertEffect(p, addDrawer(p, b.id), { type: 'shape' });
    insertEffect(p, addDrawer(p, 'output'), { type: 'chorus' });
    write('fx-layers', p);
  }
  {
    // fx-empty: Monolith D with an empty drawer, no Output drawer
    const p = newPatch(DEFS);
    addDrawer(p, instrument(p, 'Monolith D', 300).id);
    write('fx-empty', p);
  }
  {
    // fx-none: no rack, FX set to Nothing; fx-own: no rack, FX a Toggle on the instrument (its own job)
    const p = newPatch(DEFS);
    const a = instrument(p, 'Silver Box', 300);
    setKind(p, 'fx', 'nothing');
    write('fx-none', p);
    setKind(p, 'fx', 'bypass');
    setTarget(p, 'fx', { asm: a.id });
    setSwitches(p, 'fx', true);
    write('fx-own', p);
  }
}
