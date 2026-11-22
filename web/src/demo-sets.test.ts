// SPDX-License-Identifier: GPL-3.0-only
// The demo sets (#1179): what the editor's side holds without the FM-1 (the FM-1's part, and both against each other:
// firmware/test/patlink_test.c).
import { describe, expect, it } from 'vitest';
import { applyDemoSet, DEMO_SET_PATCHES, demoLayout, demoSetHash, demoSetRecord } from './demo-sets';
import { DEFS } from './modules';
import { addModule, connect, removeModule } from './patch';
import { encodePatch } from './patchbin';
import { demoSetFor, factoryWithDemoSet, FM1_PRESETS } from './presets';

describe.each(DEMO_SET_PATCHES)('the %s', (name) => {
  it('ships without patterns, and its demo set loads it back as it shipped up to 1.24.1', () => {
    const p = FM1_PRESETS[name]();
    const set = demoSetFor(p);
    expect(set?.name).toBe(name);
    applyDemoSet(p, set!);
    const full = factoryWithDemoSet(name);
    expect(p).toEqual(full);
    expect(encodePatch(p)).toEqual(encodePatch(full));
  });

  it('a renamed copy and a parameter edit keep the set; a module added or removed has none', () => {
    const renamed = { ...FM1_PRESETS[name](), name: 'My kit' };
    expect(demoSetFor(renamed)?.name).toBe(name);
    const edited = FM1_PRESETS[name]();
    const m = edited.modules.find((x) => x.type !== 'fm1' && x.type !== 'out' && Object.keys(x.params).length)!;
    const k = Object.keys(m.params)[0];
    m.params[k] = m.params[k] === 0 ? 1 : 0;
    expect(demoSetFor(edited)?.name).toBe(name);
    const added = FM1_PRESETS[name]();   // (a Bitcrusher before the Output: a module the FM-1 runs; one with no cables it leaves out)
    const output = added.modules.find((x) => x.type === 'output')!;
    const into = added.cables.find((c) => c.to.module === output.id)!;
    const crush = addModule(added, DEFS.crush, 0, 0);
    added.cables = added.cables.filter((c) => c !== into);
    expect(connect(added, DEFS, into.from, { module: crush.id, port: 'in' })).toBeTruthy();
    expect(connect(added, DEFS, { module: crush.id, port: 'out' }, into.to)).toBeTruthy();
    expect(demoSetFor(added)).toBeUndefined();
    const removed = FM1_PRESETS[name]();
    removeModule(removed, removed.modules.find((x) => x.type === 'steps')!.id);
    expect(demoSetFor(removed)).toBeUndefined();
  });

  it('its record round-trips: the patch with the set loaded gives the same record and hash', () => {
    const record = demoSetRecord(factoryWithDemoSet(name));
    const p = FM1_PRESETS[name]();
    applyDemoSet(p, demoSetFor(p)!);
    expect(demoSetRecord(p)).toEqual(record);
    expect(demoSetFor(p)!.hash).toBe(demoSetHash(record));
    expect(demoSetHash(demoSetRecord(factoryWithDemoSet(name)))).toBe(demoSetHash(record));
  });
});

it('the five layouts differ from each other and from every other factory patch’s', () => {
  const layouts = DEMO_SET_PATCHES.map((n) => demoLayout(FM1_PRESETS[n]()));
  expect(new Set(layouts).size).toBe(DEMO_SET_PATCHES.length);
  for (const n of Object.keys(FM1_PRESETS).filter((x) => !DEMO_SET_PATCHES.includes(x))) {
    expect(layouts, n).not.toContain(demoLayout(FM1_PRESETS[n]()));
    expect(demoSetFor(FM1_PRESETS[n]()), n).toBeUndefined();
  }
});
