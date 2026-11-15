// SPDX-License-Identifier: GPL-3.0-only
// Meridian 8 on the FM-1, the whole Landscape NOON (D-1054, scripts/gen-assemblies.ts): the card is the NOON's controls
// but the CV mutes (left out with the CV inputs), it fits the FM-1, it plays what Meridian 8 XL plays (the touch plates'
// wobble too: its Random sits where the XL's does), and a user preset of the 1.15 card moves onto the same channels.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import type { Patch } from './patch';
import { deviceBudget } from './patchbin';
import { CPU_VOICE_TOP } from './cpu';
import { deviceView } from './poly';
import { factoryPresets } from './factory-presets';
import { PRESET_MIGRATIONS, migrateValues } from './preset-migrate';
import { structureOf } from './structure';
import { readLineage } from '../scripts/lineage-lib';
import { FM1_PRESETS } from './presets';
import { relocatedPatches } from './community-factory';

const SR = 44118;
const CHANNELS = ['1 dot', '2 dual', '3 sys', '4 plast', '5 cympath', '6 cyrinx', '7 larynx', '8 bacid'];
const fm1 = (): Patch => FM1_PRESETS['Meridian 8']();
const engine = (p: Patch) => p.assemblies!.find((a) => a.name === 'Meridian 8')!;

/** the pattern for 4 s, then 2 s with aftertouch (the touch plates), then each row hit alone: left and right */
function render(p: Patch): Float32Array[] {
  const e = new Engine(SR);
  e.load(p);
  const parts: Float32Array[][] = [];
  const run = (s: number): void => {
    const l = new Float32Array(Math.round(SR * s)), r = new Float32Array(l.length);
    e.render(l, r);
    parts.push([l, r]);
  };
  e.transport(true);
  run(4);
  e.aftertouch(0.7);
  run(2);
  e.aftertouch(0);
  e.transport(false);
  run(0.5);
  for (const k of [53, 55, 57, 59, 60, 62, 64, 65]) {
    e.noteOn(k, 100);
    run(0.05);
    e.noteOff(k);
    run(0.3);
  }
  return [0, 1].map((ch) => {
    const out = new Float32Array(parts.reduce((n, x) => n + x[ch].length, 0));
    let o = 0;
    for (const x of parts) (out.set(x[ch], o), (o += x[ch].length));
    return out;
  });
}

describe('Meridian 8, the whole NOON (D-1054)', () => {
  it('fits the FM-1 with the NOON\'s 50 controls on its card (no CV mute: no CV inputs)', () => {
    const b = deviceBudget(fm1());
    expect(b.fits).toBe(true);
    expect(b.cpu.use).toBeLessThanOrEqual(CPU_VOICE_TOP);
    const rows = engine(fm1()).params;
    const heads = new Map<string, string[]>();
    let head = '';
    for (const r of rows) {
      if (r.head) head = r.head;
      heads.set(head, [...(heads.get(head) ?? []), r.label!]);
    }
    expect([...heads.keys()]).toEqual([...CHANNELS, 'link', 'out']);
    for (const c of CHANNELS) expect(heads.get(c), c).toEqual(['main', 'secondary', 'volume', 'mod', 'mute']);
    expect(heads.get('link')).toEqual(['1-2', '2-3', '3-4', '4-5', '5-6', '6-7', '7-8', '8>1', '1>8']);
    expect(heads.get('out')).toEqual(['main volume', 'out']);
  });

  it('keeps the skin\'s Random at the XL\'s place, which seeds it, and plays what Meridian 8 XL plays', () => {
    const p = fm1();
    const xl = relocatedPatches['Meridian 8 XL']();
    const at = (q: Patch): number => deviceView(q, false).patch.modules.findIndex((m) => m.type === 'random');
    expect(at(p)).toBe(at(xl));
    // the XL centred as the factory patch is (both sides into the Output's l), at its Output and main volume
    const out = xl.modules.find((m) => m.type === 'output')!;
    for (const c of xl.cables) if (c.to.module === out.id && c.to.port === 'r') c.to.port = 'l';
    out.params.level = p.modules.find((m) => m.type === 'output')!.params.level;
    const row = (q: Patch) => engine(q).params.find((r) => r.label === 'main volume')!;
    const value = (q: Patch, r: { module: number; param: string }) => q.modules.find((m) => m.id === r.module)!.params;
    value(xl, row(xl))[row(xl).param] = value(p, row(p))[row(p).param];
    const [a, b] = [render(xl), render(p)];
    let d = 0, s = 0;
    for (let ch = 0; ch < 2; ch++) for (let i = 0; i < a[ch].length; i++) (d += (a[ch][i] - b[ch][i]) ** 2), (s += a[ch][i] ** 2);
    expect(s).toBeGreaterThan(1);
    expect(10 * Math.log10(d / s)).toBeLessThan(-90);   // (the summing order: about -101 dB)
  });

  it('moves a preset of the 1.15 card onto the same channels: CYMPATH\'s pitch onto its slider, a link above 0 on', () => {
    const p = fm1();
    const init = factoryPresets().find((x) => x.structure === structureOf(p, engine(p)) && x.name === 'Init')!;
    const migration = PRESET_MIGRATIONS.dfc4cd9c;
    expect(migration.to).toBe(init.structure);
    const lineage = readLineage().engines['Meridian 8'];
    const before = lineage.find((x) => x.structure === 'dfc4cd9c')!;
    const now = lineage.find((x) => x.structure === init.structure)!;
    const old = before.rows.map((_, i) => (i + 1) / 100);
    const set = (id: string, v: number): void => void (old[before.rows.findIndex((r) => r[0] === id)] = v);
    set('osc#27.coarse', 30);   // CYMPATH's pitch, 30 semitones
    set('scale#43.gain', 2);    // 3-4
    set('scale#41.gain', -1.5); // 1-2 below 0 (it ducked): off
    const values = migrateValues(migration, old, init.values);
    const want = (id: string): number => values[now.rows.findIndex((r) => r[0] === id)];
    const was = (id: string): number => old[before.rows.findIndex((r) => r[0] === id)];
    expect(want('osc#23.coarse')).toBe(was('osc#10.coarse'));       // dot / main
    expect(want('filter#24.cutoff')).toBe(was('ladder#11.cutoff')); // dot / secondary
    expect(want('vca#93.gain')).toBe(was('vca#38.gain'));           // bacid / volume
    expect(want('macro#64.value')).toBeCloseTo(0.8, 3);             // cympath / main: (30 + 10) / 50
    expect(want('select#108.pos')).toBe(2);                        // 3-4 on
    expect(want('select#5.pos')).toBe(1);                          // 1-2 off
    expect(want('shape#8.level+shape#9.level')).toBe(was('macro#6.value'));   // main volume
  });
});
