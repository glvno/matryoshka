// SPDX-License-Identifier: GPL-3.0-only
// #465: the editor reconciles every card when it opens a patch (editor.ts setPatch: fixAssemblies), so a factory patch must
// already be in that form. Else the browser counts a different patch than Node (tests, export-defs, the FM-1's factory
// binaries): <7PH read as fitting at 3,840 bytes in Node and as 3,894 bytes, over the FM-1 budget, in the browser, where it
// opened as a sandbox patch and paused Live sync: the editor's check turned the kits' velocity pins into gain rows (dead
// sliders, as the pins drive the gain through a macro range), and the generator had left them jacks.
import { describe, expect, it } from 'vitest';
import './factory-presets';
import { fixAssemblies, makeAssembly } from './assembly';
import { DEFS } from './modules';
import { deviceBudget } from './patchbin';
import { FM1_PRESETS, PRESETS } from './presets';
import { addModule, connect, emptyPatch, type Patch } from './patch';

/** the patch as the editor holds it once opened (positions aside: the editor may move cards, the binary has none) */
const opened = (p: Patch): Patch => {
  const q = structuredClone(p);
  fixAssemblies(q, DEFS);
  return q;
};

describe('factory patches are what the editor opens (#465)', () => {
  it('every factory patch and XL is unchanged by the editor\'s card check', () => {
    const changed = Object.entries(PRESETS).filter(([, make]) => {
      const p = make();
      return JSON.stringify(opened(p)) !== JSON.stringify(p);
    }).map(([name]) => name);
    expect(changed).toEqual([]);
  });

  it('the FM-1 budget of a factory patch is the same opened in the editor, and every FM-1 factory patch fits', () => {
    for (const [name, make] of Object.entries(FM1_PRESETS)) {
      const p = make();
      const node = deviceBudget(p);
      const page = deviceBudget(opened(p));
      expect(page.items, name).toEqual(node.items);
      expect(page.fits, `${name}: ${JSON.stringify(page.over)}`).toBe(true);
    }
  });

  it('a cable from outside into a pin that drives a parameter through a macro range keeps the pin a jack, not a dead row', () => {
    const p = emptyPatch('t');
    const lfo = addModule(p, DEFS.lfo, 0, 0);
    const vca = addModule(p, DEFS.vca, 300, 0);
    const env = addModule(p, DEFS.env, 300, 200);
    expect(connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: vca.id, port: 'p1' })).toBeTruthy();
    expect(connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: env.id, port: 'p1' })).toBeTruthy();
    const gain = vca.map!.p1[0];
    vca.range = { p1: { [gain]: [0, 1] } };   // the velocity of the drum kits: the slider does nothing while the cable is in
    const a = makeAssembly(p, [vca.id, env.id], 'drum');
    expect(a.params.map((r) => `${r.module}.${r.param}`)).toEqual([`${env.id}.${env.map!.p1[0]}`]);
    expect(a.inputs.filter((r) => r.port === 'p1').map((r) => r.module)).toEqual([vca.id]);
    // a row the card has already for that parameter shows the cable: no jack besides it
    a.params.push({ module: vca.id, param: gain, label: 'level' });
    a.inputs = a.inputs.filter((r) => r.port !== 'p1');
    fixAssemblies(p, DEFS);
    expect(a.inputs.some((r) => r.port === 'p1')).toBe(false);
    expect(a.params.filter((r) => r.module === vca.id)).toHaveLength(1);
  });
});
