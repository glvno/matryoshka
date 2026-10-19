// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, connect, newPatch, type ModuleInst, type Patch } from './patch';
import { connectParameter } from './parameter-routing';
import { lockOf, RULES } from './relevance';

const lock = (p: Patch, m: ModuleInst, param: string): string | null => lockOf(p, m, DEFS[m.type].params, param);

describe('lockOf', () => {
  it('names only parameters and choices that exist', () => {
    for (const r of RULES) {
      const def = DEFS[r.type];
      expect(def, r.type).toBeTruthy();
      for (const name of [...r.params, ...r.reads]) expect(def.params.some((pd) => pd.name === name), `${r.type}.${name}`).toBe(true);
    }
  });

  it('locks the pulse width unless the wave is square', () => {
    const p = newPatch(DEFS);
    const osc = addModule(p, DEFS.osc, 300, 20);
    osc.params.wave = 2;
    expect(lock(p, osc, 'pw')).toMatch(/square/);
    osc.params.wave = 3;
    expect(lock(p, osc, 'pw')).toBeNull();
  });

  it('locks detune and blend until there are enough copies', () => {
    const p = newPatch(DEFS);
    const osc = addModule(p, DEFS.osc, 300, 20);
    osc.params.unison = 1;
    expect(lock(p, osc, 'detune')).not.toBeNull();
    expect(lock(p, osc, 'blend')).not.toBeNull();
    osc.params.unison = 2;
    expect(lock(p, osc, 'detune')).toBeNull();
    expect(lock(p, osc, 'blend')).not.toBeNull();
    osc.params.unison = 3;
    expect(lock(p, osc, 'blend')).toBeNull();
    osc.params.fb = 0.2; // the FM path has no unison
    expect(lock(p, osc, 'detune')).not.toBeNull();
    expect(lock(p, osc, 'unison')).not.toBeNull();
  });

  it('keeps a row live while a parameter its rule reads is modulated', () => {
    const p = newPatch(DEFS);
    const osc = addModule(p, DEFS.osc, 300, 20);
    const lfo = addModule(p, DEFS.lfo, 20, 300);
    osc.params.wave = 0;
    expect(lock(p, osc, 'pw')).not.toBeNull();
    connectParameter(p, DEFS, { module: lfo.id, port: 'out' }, osc.id, 'wave');
    expect(lock(p, osc, 'pw')).toBeNull();
  });

  it('follows input jacks for rules about an input', () => {
    const p = newPatch(DEFS);
    const filter = addModule(p, DEFS.filter, 300, 20);
    const lfo = addModule(p, DEFS.lfo, 20, 300);
    expect(lock(p, filter, 'cvamt')).not.toBeNull();
    connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: filter.id, port: 'cv' });
    expect(lock(p, filter, 'cvamt')).toBeNull();
  });

  it('locks sequencer steps beyond the length', () => {
    const p = newPatch(DEFS);
    const seq = addModule(p, DEFS.seq, 300, 20);
    seq.params.len = 4;
    expect(lock(p, seq, 's4')).toBeNull();
    expect(lock(p, seq, 's5')).not.toBeNull();
    expect(lock(p, seq, 's1')).toBeNull();
  });
});
