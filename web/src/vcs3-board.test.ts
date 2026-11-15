// SPDX-License-Identifier: GPL-3.0-only
// Briefcase 3's pin board (D-1052, scripts/vcs3-board.ts): the factory patch has all 256 VCS3 pins on 16 Matrix tiles
// beside its assembly, in the order AENP, BCKO, DFGH, IJLM, and so renders sample for sample as Briefcase 3 XL (the
// archived 256-Mixer design). The order decides which cable of a feedback loop runs a block late: another order played a
// route one block (2.9 ms) later than the XL (issue #901), so the render below locks it.
import { describe, expect, it } from 'vitest';
import BANK from '../factory/bank.json';
import { COLUMN_ROWS, LETTERS, PINS, TILES, columnLabel, pinAt, rowLabel } from '../scripts/vcs3-board';
import { relocatedPatches } from './community-factory';
import { Engine } from './engine';
import { DEFS } from './modules';
import { validatePatch, type Patch } from './patch';
import { deviceBudget } from './patchbin';
import { CPU_VOICE_TOP } from './cpu';
import { FM1_PRESETS } from './presets';
import './factory-presets';

const SR = 44118;
const source = (): Patch => validatePatch(structuredClone((BANK as { name: string; patch: unknown }[]).find((e) => e.name === 'Briefcase 3')!.patch), DEFS);
function render(p: Patch, notes: number[], secs = 2.5): Float32Array[] {
  const e = new Engine(SR);
  e.load(p);
  for (const n of notes) e.noteOn(n);
  const l = new Float32Array(Math.round(SR * secs)), r = new Float32Array(l.length);
  e.render(l, r);
  return [l, r];
}

describe('Briefcase 3: the VCS3 pin board on Matrix tiles (D-1052)', () => {
  it('renders sample for sample as Briefcase 3 XL, at the same Output level', () => {
    const xl = relocatedPatches['Briefcase 3 XL']();
    const p = source();
    p.modules.find((m) => m.type === 'output')!.params.level = xl.modules.find((m) => m.type === 'output')!.params.level;
    for (const notes of [[48], [60], [36]]) {
      const [al, ar] = render(xl, notes), [bl, br] = render(p, notes);
      expect(Math.max(...al.map(Math.abs))).toBeGreaterThan(0.05);
      expect(bl).toEqual(al);
      expect(br).toEqual(ar);
    }
  });

  it('has its 16 tiles after the assembly, in the board\'s order, each cabled to its rows and columns, its pins the classic patch', () => {
    const p = source();
    const a = p.assemblies!.find((x) => x.name === 'Briefcase 3')!;
    const tiles = p.modules.filter((m) => m.type === 'matrix');
    expect(tiles.map((m) => m.name)).toEqual(TILES.map((t) => t.name));
    expect(tiles.map((m) => m.name)).toEqual(['A1', 'A5', 'A9', 'A13', 'B1', 'B5', 'B9', 'B13', 'D1', 'D5', 'D9', 'D13', 'I1', 'I5', 'I9', 'I13']);
    expect(tiles.every((m) => !a.modules.includes(m.id))).toBe(true);
    const index = (id: number): number => p.modules.findIndex((m) => m.id === id);
    expect(Math.min(...tiles.map((m) => index(m.id)))).toBeGreaterThan(Math.max(...a.modules.map(index)));
    TILES.forEach((t, k) => {
      const m = tiles[k];
      t.rows.forEach((n, i) => {
        const from = p.cables.filter((c) => c.to.module === m.id && c.to.port === `in${i + 1}`).map((c) => c.from);
        const out = a.outputs.find((r) => r.label === rowLabel(n));
        expect(from, `${t.name} row ${n}`).toEqual(out ? [{ module: out.module, port: out.port }] : []);
      });
      t.columns.split('').forEach((c, o) => {
        const to = p.cables.filter((x) => x.from.module === m.id && x.from.port === `out${o + 1}`).map((x) => x.to);
        const r = COLUMN_ROWS[c] ? { module: a.params.find((q) => q.label === COLUMN_ROWS[c])!.module, port: 'p1' } : a.inputs.find((q) => q.label === columnLabel(c))!;
        expect(to, `${t.name} column ${c}`).toEqual([{ module: r.module, port: r.port }]);
      });
    });
    for (const c of LETTERS) for (let n = 1; n <= 16; n++) {
      const { tile, param } = pinAt(`${c}${n}`);
      expect(tiles[tile].params[param], `${c}${n}`).toBe(PINS[`${c}${n}`] ?? 0);
    }
  });

  it('keeps no pin on the card, and fits the FM-1 with its effects', () => {
    const p = FM1_PRESETS['Briefcase 3']();
    const a = p.assemblies!.find((x) => x.name === 'Briefcase 3')!;
    expect(p.assemblies!.some((x) => x.label === 'matrix')).toBe(false);
    expect(a.params.some((r) => /^[A-P]\d+/.test(r.label))).toBe(false);
    for (const l of ['pan 1', 'pan 2', 'range x', 'range y', 'meter']) expect(a.params.map((r) => r.label)).toContain(l);
    const b = deviceBudget(p);
    expect(b.fits).toBe(true);
    expect(b.cpu.use).toBeLessThanOrEqual(CPU_VOICE_TOP);
  });
});
