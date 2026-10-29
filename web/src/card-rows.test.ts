// SPDX-License-Identifier: GPL-3.0-only
// Card rows that set several parameters (#357) and name a Selector's positions (#358).
import { describe, expect, it } from 'vitest';
import { DEFS, rowRange, selectCount } from './modules';
import { validatePatch, type Patch } from './patch';
import {
  assembliesOf, demote, fixAssemblies, fixNames, insertAssembly, isPromoted, mergeRows, promote, rowNames, rowOf, sameRange, setRowNames,
  splitRow, syncTied, tiedTo, toDef, validateAssemblyDef, type AssemblyInst, copyRuns, setCopies,
} from './assembly';
import { layoutOf, pagesOf } from './arrange';
import { connectParameter } from './parameter-routing';
import { devicesOf } from './pages';
import { deviceRecord, deviceSection, encodePatch, encodedSize, ROW_MORE } from './patchbin';
import { deviceView } from './poly';
import { applyPreset, currentValues } from './device-presets';
import { defStructure, structureOf } from './structure';
import { cardRows } from './test-patches';
import { XL_PRESETS } from './presets';

const voice = (p: Patch): AssemblyInst => assembliesOf(p).find((a) => a.name === 'voice')!;
const mod = (p: Patch, id: number) => p.modules.find((m) => m.id === id)!;
/** the patch as the editor loads it (a share link, the saved patch, a file) */
const load = (p: Patch): Patch => {
  const q = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
  fixAssemblies(q, DEFS);
  return q;
};

describe('a card row that sets several parameters (#357)', () => {
  it('ties its parameters: every one follows the first on load, with its value clamped to the range', () => {
    const p = cardRows();
    mod(p, 5).params.cutoff = 3000;
    const q = load(p);
    expect(mod(q, 5).params.cutoff).toBe(900);
    expect(tiedTo(q, 4, 'cutoff')).toEqual([{ module: 4, param: 'cutoff' }, { module: 5, param: 'cutoff' }]);
    expect(tiedTo(q, 5, 'cutoff')[0]).toEqual({ module: 5, param: 'cutoff' });
    expect(tiedTo(q, 2, 'level')).toEqual([{ module: 2, param: 'level' }]);
    expect(isPromoted(voice(q), 5, 'cutoff')).toBe(true);
  });

  it('keeps only parameters of the same range; a target that is gone or another row\'s goes', () => {
    const p = cardRows();
    const a = voice(p);
    a.params[0].also = [{ module: 5, param: 'cutoff' }, { module: 5, param: 'res' }, { module: 99, param: 'cutoff' }, { module: 4, param: 'res' }];
    const q = load(p);
    expect(voice(q).params[0].also).toEqual([{ module: 5, param: 'cutoff' }]);
    expect(sameRange(DEFS.filter.params[0], DEFS.filter.params[1])).toBe(false);
    expect(sameRange(DEFS.filter.params[1], DEFS.filter.params[1])).toBe(true);
  });

  it('merges two rows into one and splits it again; taking a parameter off leaves the rest of the row', () => {
    const p = cardRows();
    const a = voice(p);
    splitRow(a, 4, 'cutoff');
    expect(a.params.map((r) => r.label)).toEqual(['cutoff', 'cutoff 2', 'res', 'source', 'count']);
    expect(a.params[1]).toMatchObject({ module: 5, param: 'cutoff' });
    mergeRows(p, a, DEFS, { module: 4, param: 'cutoff' }, { module: 5, param: 'cutoff' });
    expect(a.params.map((r) => r.label)).toEqual(['cutoff', 'res', 'source', 'count']);
    expect(rowOf(a, 5, 'cutoff')).toBe(a.params[0]);
    expect(() => mergeRows(p, a, DEFS, { module: 4, param: 'cutoff' }, { module: 4, param: 'res' })).toThrow(/ranges differ/);
    demote(a, 5, 'cutoff');
    expect(a.params[0].also).toBeUndefined();
    expect(a.params[0]).toMatchObject({ module: 4, param: 'cutoff' });
    // the first of a row that sets others: the next takes the row over
    demote(a, 4, 'res');
    expect(a.params[1]).toMatchObject({ module: 5, param: 'res', label: 'res' });
    expect(a.params[1].also).toBeUndefined();
    promote(a, 4, 'res');
    expect(a.params.length).toBe(5);
  });

  it('a nested card\'s row ties its parameters for the card around it too', () => {
    const p = cardRows();
    const a = voice(p);
    // nest the voice in a card of its own that shows the cutoff row
    const parent: AssemblyInst = { v: 1, id: 99, name: 'outer', label: 'outer', x: 0, y: 0, open: false, modules: [], children: [a.id], inputs: [], outputs: [], params: [{ module: 4, param: 'cutoff', label: 'cut' }] };
    p.assemblies!.push(parent);
    const q = load(p);
    const dev = devicesOf(q, DEFS).find((d) => d.name === 'outer')!;
    expect(dev.pages[0].rows[0]).toMatchObject({ module: 4, param: 'cutoff', also: [{ module: 5, param: 'cutoff' }] });
  });

  it('a cable onto a row, its route and macro range reach every parameter it sets (syncTied)', () => {
    const p = cardRows();
    const m4 = mod(p, 4), m5 = mod(p, 5);
    connectParameter(p, DEFS, { module: 3, port: 'out' }, 4, 'res');   // (the res row: a pin of filter 4)
    const pin = (['p1', 'p2'] as const).find((s) => m4.map?.[s].includes('res') && p.cables.some((c) => c.to.module === 4 && c.to.port === s))!;
    expect(pin).toBeDefined();
    m4.range = { [pin]: { res: [0.2, 0.8] } };
    m5.map![pin] = [];
    expect(syncTied(p, DEFS)).toBe(true);
    expect(m5.map![pin]).toContain('res');
    expect(m5.range?.[pin]?.res).toEqual([0.2, 0.8]);
    expect(syncTied(p, DEFS)).toBe(false);
  });

  it('a card preset sets every parameter of a row; the structure counts what a row sets', () => {
    const p = cardRows();
    const a = voice(p);
    const values = currentValues(p, a);
    const preset = { structure: structureOf(p, a), name: 'test', values: values.map((v, i) => (i === values.indexOf(900) ? 2000 : v)) };
    expect(applyPreset(p, a, preset)).toBe(true);
    expect(mod(p, 4).params.cutoff).toBe(2000);
    expect(mod(p, 5).params.cutoff).toBe(2000);
    // the same rows split are another structure; without any row that sets several, the fingerprint is as before
    const split = cardRows();
    splitRow(voice(split), 4, 'cutoff');
    expect(structureOf(split, voice(split))).not.toBe(structureOf(p, a));
    const plain = toDef(p, a);
    for (const r of plain.params) delete r.also;
    const again = toDef(p, a);
    expect(defStructure(again)).toBe(structureOf(p, a));
    expect(defStructure(plain)).not.toBe(defStructure(again));
  });

  it('survives a saved assembly: toDef, the file check and insertAssembly keep the rows and names', () => {
    const p = cardRows();
    const def = validateAssemblyDef(JSON.parse(JSON.stringify(toDef(p, voice(p)))), DEFS);
    expect(def.params[0].also).toEqual([{ module: 4, param: 'cutoff' }]);
    expect(def.params[2].names).toEqual(['low', 'high', 'raw']);
    const q = load(cardRows());
    const b = insertAssembly(q, DEFS, def, 2000, 0);
    const [first, second] = [b.params[0], b.params[0].also![0]];
    expect(tiedTo(q, first.module, first.param)).toContainEqual(second);
    expect(b.params[2].names).toEqual(['low', 'high', 'raw']);
  });
});

describe('a Selector\'s named positions (#358)', () => {
  it('a row keeps up to eight names of twelve characters, on a Selector\'s position row only', () => {
    expect(fixNames([' saw ', 'square', 'a very long name indeed', '', ''])).toEqual(['saw', 'square', 'a very long']);
    expect(fixNames(['', ''])).toBeUndefined();
    expect(fixNames(Array.from({ length: 10 }, (_, i) => `p${i}`))?.length).toBe(8);
    const p = cardRows();
    voice(p).params[0].names = ['x', 'y'];
    const q = load(p);
    expect(voice(q).params[0].names).toBeUndefined();
    expect(voice(q).params[2].names).toEqual(['low', 'high', 'raw']);
    expect(rowNames(q, 6, 'pos')).toEqual(['low', 'high', 'raw']);
    setRowNames(voice(q).params, 2, []);
    expect(voice(q).params[2].names).toBeUndefined();
  });

  it('the position row spans the positions in use', () => {
    const pos = DEFS.select.params.find((d) => d.name === 'pos')!;
    expect(rowRange('select', { count: 3 }, pos).max).toBe(3);
    expect(rowRange('select', { count: 1 }, pos).max).toBe(2);
    expect(rowRange('select', { count: 8 }, pos).max).toBe(8);
    expect(selectCount({})).toBe(8);
    expect(rowRange('filter', {}, DEFS.filter.params[0])).toBe(DEFS.filter.params[0]);
  });
});

describe('the binary: a page row\'s extras (#357, #358, format 35)', () => {
  it('a row that sets several parameters or names its positions carries them after its label; the rest are as before', () => {
    const p = load(cardRows());
    const dev = deviceView(p, true).patch;
    const index = new Map(dev.modules.map((m, i) => [m.id, i]));
    const devs = deviceSection(p, dev);
    const rec = deviceRecord(devs, dev);
    const d = devs.find((x) => x.name === 'voice')!;
    expect(d.pages[0].rows.map((r) => r.label)).toEqual(['cutoff', 'res', 'source', 'count']);
    // walk the record: device count, then per device its kind ...
    let at = 1;
    const text = (): string => { const n = rec[at]; const s = String.fromCharCode(...rec.slice(at + 1, at + 1 + n)); at += 1 + n; return s; };
    const rows: { mod: number; par: number; label: string; also: number[][]; names: string[] }[] = [];
    for (let k = 0; k < rec[0]; k++) {
      if (rec[at] === 0) { at += 2; continue; }
      at++;
      const name = text();
      const np = rec[at++];
      for (let g = 0; g < np; g++) {
        text();
        const nr = rec[at + 3];
        at += 4;
        for (let r = 0; r < nr; r++) {
          const m = rec[at], par = rec[at + 1];
          at += 2;
          const label = text();
          const row = { mod: m, par: par & ~ROW_MORE, label, also: [] as number[][], names: [] as string[] };
          if (par & ROW_MORE && !(par & 0x80)) {
            const n = rec[at++];
            for (let i = 0; i < n; i++, at += 2) row.also.push([rec[at], rec[at + 1]]);
            const kk = rec[at++];
            for (let i = 0; i < kk; i++) row.names.push(text());
          }
          if (name === 'voice') rows.push(row);
        }
      }
    }
    expect(at).toBe(rec.length);
    const cutoff = DEFS.filter.params.findIndex((q) => q.name === 'cutoff');
    expect(rows[0]).toEqual({ mod: index.get(4), par: cutoff, label: 'cutoff', also: [[index.get(5), cutoff]], names: [] });
    expect(rows[2]).toEqual({ mod: index.get(6), par: 0, label: 'source', also: [], names: ['LOW', 'HIGH', 'RAW'] });
    expect(rows[3].also).toEqual([]);
    // the whole binary counts them
    expect(encodePatch(p).length).toBe(encodedSize(p));
  });
});

describe('copies shown one at a time (the Casio CZ\'s envelope steps)', () => {
  /** an Env 8's eight steps as rows r1, l1 .. r8, l8, then sus and end, under the heading "env" */
  const czCard = (): Patch => {
    const p = load(cardRows());
    const a = voice(p);
    const env = p.modules.find((m) => m.type === 'adsr')!;
    env.type = 'env8';
    env.params = Object.fromEntries(DEFS.env8.params.map((d) => [d.name, d.default]));
    a.modules.push(env.id);
    a.params.push(...Array.from({ length: 8 }, (_, k) => [{ module: env.id, param: `r${k + 1}`, label: `rate ${k + 1}` }, { module: env.id, param: `l${k + 1}`, label: `level ${k + 1}` }]).flat(),
      { module: env.id, param: 'sus', label: 'sus' }, { module: env.id, param: 'end', label: 'end' });
    a.params[4].head = 'env';
    setCopies(a.params, 4, 2, 8, 'step');
    return p;
  };

  it('a run is its rows in copies; each copy starts an FM-1 page, and so does the row after it', () => {
    const p = czCard();
    const a = voice(p);
    expect(a.params[4].copies).toEqual({ rows: 2, count: 8, name: 'step' });
    expect(copyRuns(a.params)).toEqual([{ at: 4, rows: 2, count: 8, name: 'step' }]);
    const env = devicesOf(p, DEFS).find((d) => d.name === 'voice')!.pages.filter((pg) => pg.name === 'env');
    expect(env.map((pg) => pg.rows.map((r) => r.label).join(' '))).toEqual([
      'rate 1 level 1', 'rate 2 level 2', 'rate 3 level 3', 'rate 4 level 4', 'rate 5 level 5', 'rate 6 level 6', 'rate 7 level 7', 'rate 8 level 8', 'sus end',
    ]);
    // Arrange mode cuts the section the same way
    const sec = layoutOf(a.params)[0].secs.find((x) => x.head === 'env')!;
    expect(pagesOf(sec, () => true).map((pg) => pg.length)).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2]);
  });

  it('is layout only: kept by a saved assembly and a load; a run that loses a row is plain rows again', () => {
    const q = load(czCard());
    expect(voice(q).params[4].copies).toEqual({ rows: 2, count: 8, name: 'step' });
    const def = validateAssemblyDef(JSON.parse(JSON.stringify(toDef(q, voice(q)))), DEFS);
    expect(def.params[4].copies).toEqual({ rows: 2, count: 8, name: 'step' });
    const a = voice(q);
    demote(a, a.params[7].module, a.params[7].param);
    expect(a.params[4].copies).toBeUndefined();
    expect(copyRuns(a.params)).toEqual([]);
    // a run past the end of the card, or a heading inside it, is not a run
    setCopies(a.params, 4, 2, 20);
    expect(a.params[4].copies).toBeUndefined();
    setCopies(a.params, 4, 2, 4);
    expect(copyRuns(a.params).length).toBe(1);
    a.params[6].head = 'x';
    expect(copyRuns(a.params)).toEqual([]);
  });
});


it('Algo Four selects all fourteen controls with one operator picker and keeps each operator on its own pages', () => {
  const p = load(XL_PRESETS['Algo Four XL']());
  const cards = assembliesOf(p).filter(a => a.params.some(r => r.copies?.name === 'op'));
  expect(cards).toHaveLength(2); // the instrument card and its nested voice card
  const labels = ['freq ratio', 'detune', 'out level', 'key velocity', 'ar', 'd1r', 'd1l', 'd2r',
    'rr', 'rate scaling', 'level scaling', 'eg bias sens', 'operator', 'ams'];
  for (const a of cards) {
    const runs = copyRuns(a.params);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run).toMatchObject({ rows: 14, count: 4, name: 'op' });
    for (let i = 0; i < 4; i++) {
      const rows = a.params.slice(run.at + 14 * i, run.at + 14 * (i + 1));
      expect(rows.map(r => r.label)).toEqual(labels);
      expect(rows.slice(-2).map(r => r.names)).toEqual([['OFF', 'ON'], ['OFF', 'ON']]);
    }
    const saved = validateAssemblyDef(JSON.parse(JSON.stringify(toDef(p, a))), DEFS);
    expect(copyRuns(saved.params)).toEqual(runs);
    const first = a.params[run.at];
    const sections = layoutOf(a.params).flatMap(c => c.secs);
    const section = sections.find(sec => sec.rows.some(r => r.module === first.module && r.param === first.param));
    expect(section).toBeDefined();
    const targets = new Set(a.params.slice(run.at, run.at + 56).map(r => `${r.module}:${r.param}`));
    const operatorPages = pagesOf(section!, () => true).filter(pg => pg.some(r => targets.has(`${r.module}:${r.param}`)));
    expect(operatorPages.map(pg => pg.length)).toEqual(Array(4).fill([4, 4, 4, 2]).flat());
  }
  const card = cards.find(a => devicesOf(p, DEFS).some(d => d.asm === a.id))!;
  const run = copyRuns(card.params)[0];
  const operatorTargets = new Set(card.params.slice(run.at, run.at + 56).map(r => `${r.module}:${r.param}`));
  expect(operatorTargets.size).toBe(56);
  const pages = devicesOf(p, DEFS).find(d => d.asm === card.id)!.pages;
  const operatorPages = pages.filter(pg => pg.rows.some(r => operatorTargets.has(`${r.module}:${r.param}`)));
  expect(operatorPages.map(pg => pg.rows.length)).toEqual(Array(4).fill([4, 4, 4, 2]).flat());
});
