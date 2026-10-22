// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { diffCount, diffLines, diffPatches } from './diff';
import { DEFS } from './modules';
import { PRESETS } from './presets';
import { addModule, connect, removeModule } from './patch';
import { makeAssembly } from './assembly';
import { acid } from './test-patches';

describe('patch diff', () => {
  it('lists changed parameters, added / removed modules and cables, and the rest as lines', () => {
    const a = acid();
    const b = acid();
    expect(diffCount(diffPatches(a, b, DEFS))).toBe(0);
    const flt = b.modules.find((m) => m.type === 'filter')!;
    flt.params.cutoff = 999;
    flt.bypass = true;
    const lfo = addModule(b, DEFS.lfo, 0, 0);
    connect(b, DEFS, { module: lfo.id, port: 'out' }, { module: flt.id, port: 'cv' });
    const dly = b.modules.find((m) => m.type === 'delay')!;
    removeModule(b, dly.id);
    const grouped = makeAssembly(b, [lfo.id], 'wobble');
    grouped.poly = {};
    const d = diffPatches(a, b, DEFS);
    expect(d.params).toHaveLength(1);
    expect(d.params[0]).toMatchObject({ module: flt.id, name: 'cutoff', to: 999 });
    expect(d.added).toEqual([`LFO #${lfo.id}`]);
    expect(d.removed).toEqual([`Delay #${dly.id}`]);
    expect(d.cablesAdded).toHaveLength(1);
    expect(d.cablesRemoved.length).toBeGreaterThan(0); // the delay's cables went with it
    expect(d.other).toContain(`Multimode #${flt.id}: bypassed`);
    expect(d.other).toContain('wobble: poly on');
    const lines = diffLines(d);
    expect(lines[0]).toBe(`Multimode #${flt.id} cutoff: ${Number(a.modules.find((m) => m.id === flt.id)!.params.cutoff.toFixed(4))} → 999`);
    expect(lines).toHaveLength(diffCount(d));
  });
});
