// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { toDef } from './assembly';
import { defIsEngine, instIsEngine } from './engines';
import { CARDS, cardOf, presetsByRules, presetsOfDef, xlEnginePresets, xlPresetsOfDef } from './factory-presets';
import { cardRows, cardSlug, cardTemplate, formatCard, formatPreset, parseCard, projectPresets } from './preset-cards';
import { XL_PRESETS } from './presets';
import { defRowOrder, defStructure } from './structure';

const ENGINES = FACTORY.filter((d) => defIsEngine(d));
const HERA = ENGINES.find((d) => d.name === 'Hera 6')!;
/** where a row (by its key) sits in a preset's values */
const at = (def: typeof HERA, key: string): number => {
  const r = cardRows(def).find((x) => x.key === key)!;
  return defRowOrder(def).indexOf(r.i);
};

describe('preset cards (#413)', () => {
  it('every engine names its rows once; a section that repeats a label numbers it', () => {
    for (const d of ENGINES) {
      const keys = cardRows(d).map((r) => r.key);
      expect(new Set(keys).size, d.name).toBe(keys.length);
    }
    const exp = cardRows(ENGINES.find((d) => d.name === 'Expander S')!).map((r) => r.key);
    expect(exp).toContain('envelopes / a (1)');
    expect(exp).toContain('envelopes / a (2)');
    expect(cardSlug('Hera 6')).toBe('hera-6');
    expect(cardSlug('8 Lire')).toBe('8-lire');
  });

  it('reads a card: units, choices, switches, the label alone, and the values land in canonical order', () => {
    const r = parseCard(['# a comment', 'engine: hera 6', '', 'preset: Test', '  filters / cutoff = 900 Hz   # trailing comment', '  wave = SQUARE', '  kybd = off', '  lfo → pitch = 0.5', '  a = 1.2', '  voices = 6.4'].join('\n'), HERA);
    expect(r.errors).toEqual([]);
    expect(r.engine).toBe('hera 6');
    expect(r.presets.map((p) => p.name)).toEqual(['Init', 'Test']);
    const p = r.presets[1];
    expect(p.structure).toBe(defStructure(HERA));
    expect(p.values.length).toBe(HERA.params.length);
    expect(p.values[at(HERA, 'filters / cutoff')]).toBe(900);
    expect(p.values[at(HERA, 'dco / wave')]).toBe(3);
    expect(p.values[at(HERA, 'filters / kybd')]).toBe(0);
    expect(p.values[at(HERA, 'lfo / lfo → pitch')]).toBe(0.5);
    expect(p.values[at(HERA, 'env / a')]).toBe(1.2);
    expect(p.values[at(HERA, 'voice / voices')]).toBe(6); // snapped to the step
    // untouched rows keep Init
    const init = r.presets[0];
    expect(p.values[at(HERA, 'filters / res')]).toBe(init.values[at(HERA, 'filters / res')]);
    expect(init.values).toEqual(presetsByRules(HERA)[0].values);
  });

  it('a Selector row takes its positions\' names or numbers up to its count, and is written by name (#430)', () => {
    const cz = ENGINES.find((d) => d.name === 'Cassia 1')!;
    const r = parseCard(['engine: Cassia 1', 'preset: T', '  line 2 / wave = reso 3', '  line 1 / wave 2 = 2', '  line = 3'].join('\n'), cz);
    expect(r.errors).toEqual([]);
    const p = r.presets[1];
    expect(p.values[at(cz, 'line 2 / wave')]).toBe(8);
    expect(p.values[at(cz, 'line 1 / wave 2')]).toBe(2);
    expect(formatPreset(cz, 'T', p.values)).toContain('line 1 / wave 2 = square');
    expect(formatPreset(cz, 'T', p.values)).toContain('line 2 / wave = reso 3');
    expect(parseCard(['engine: Cassia 1', 'preset: T', '  line = 5'].join('\n'), cz).errors[0]).toMatch(/outside 1\.\.4/);
    expect(parseCard(['engine: Cassia 1', 'preset: T', '  line 1 / wave = reso 4'].join('\n'), cz).errors[0]).toMatch(/saw, square/);
    const t = cardTemplate(cz);
    expect(t).toMatch(/line 2 \/ wave = reso 1 +saw, square, pulse, dbl sine, saw-pulse, reso 1, reso 2, reso 3/);
    expect(t).toMatch(/line = 4 +1\.\.4/);
  });

  it('reports every mistake with its line and then holds no preset', () => {
    const r = parseCard([
      'engine: Oracle V', // 1: wrong engine
      'cutoff = 100', // 2: before a preset
      'preset: Init', // 3: reserved
      'preset: A', // 4
      '  cutoff = 900 ms', // 5: wrong unit
      '  cutoff = 90000', // 6: outside the range
      '  wave = sawtooth', // 7: not a choice
      '  envelope = 1', // 8: a screen
      '  nothing here = 1', // 9: no such row
      '  res = 0.2', // 10
      '  res = 0.3', // 11: set twice
      '  what is this', // 12: not a row
      'preset: A', // 13: named twice
      '  res = 0.15', // 14: Init's value: changes nothing
      'preset: a name that is far too long for a preset', // 15
      '  res = 1',
      'preset: B', // 17
      '  res = 0.15', // Init's value: changes nothing
    ].join('\n'), HERA);
    expect(r.presets).toEqual([]);
    const lines = r.errors.map((e) => Number(/^line (\d+)/.exec(e)?.[1] ?? 0));
    expect(lines).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 11, 12, 13, 15, 17]);
    expect(r.errors.find((e) => e.startsWith('line 5'))).toContain('the unit is Hz');
    expect(r.errors.find((e) => e.startsWith('line 7'))).toContain('sine, triangle, saw');
    expect(r.errors.find((e) => e.startsWith('line 17'))).toContain('changes nothing');
    expect(parseCard('preset: X\n res = 1', HERA).errors).toEqual(['the file names no engine ("engine: <name>" before the first preset)']);
    expect(parseCard('engine: Hera 6', HERA).errors).toEqual(['the file holds no preset']);
  });

  it('a preset written as text reads back the same, for every engine and its rule-made presets', () => {
    for (const d of ENGINES) {
      const rules = presetsByRules(d);
      const r = parseCard(formatCard(d, rules), d);
      expect(r.errors, d.name).toEqual([]);
      expect(r.presets.map((p) => p.name), d.name).toEqual(rules.map((p) => p.name));
      rules.forEach((p, k) => p.values.forEach((v, i) => expect(r.presets[k].values[i], `${d.name} ${p.name} row ${i}`).toBeCloseTo(v, 3)));
    }
    expect(formatPreset(HERA, 'Dark', presetsByRules(HERA)[2].values)).toBe('preset: Dark\n  cutoff = 560 Hz');
    const t = cardTemplate(HERA);
    expect(t).toContain('#   wave = saw');
    expect(t).toContain('#   envelope: a screen, not a value');
    expect(t.trimEnd().endsWith('engine: Hera 6')).toBe(true);
    expect(parseCard(t, HERA).errors).toEqual(['the file holds no preset']);
  });

  it('every card in presets/cards/ is an engine\'s, reads clean, and gives it three to five presets after Init', () => {
    expect(Object.keys(CARDS).length).toBeGreaterThan(0);
    for (const [slug, text] of Object.entries(CARDS)) {
      const d = ENGINES.find((x) => cardSlug(x.name) === slug);
      expect(d, slug).toBeTruthy();
      const r = parseCard(text, d!);
      expect(r.errors, slug).toEqual([]);
      expect(r.presets.length - 1, slug).toBeGreaterThanOrEqual(3);
      expect(r.presets.length - 1, slug).toBeLessThanOrEqual(5);
      // the card is what the engine ships
      expect(presetsOfDef(d!).map((p) => p.name)).toEqual(r.presets.map((p) => p.name));
      expect(cardOf(d!)?.presets.length).toBe(r.presets.length);
    }
    expect(presetsOfDef(HERA).map((p) => p.name)).toEqual(['Init', 'Brass', 'Strings', 'Bass', 'Organ', 'Glass Pad']);
  });

  it('an XL built as its original\'s whole panel keeps the rule-made presets: its rows are not its FM-1 version\'s', () => {
    const xl = XL_PRESETS['Hera 6 XL']();
    const a = (xl.assemblies ?? []).find((x) => instIsEngine(xl, x))!;
    const def = toDef(xl, a);
    expect(cardRows(def).map((r) => r.key)).not.toContain('filters / cutoff');
    expect(projectPresets(HERA, presetsOfDef(HERA), def)).toBeNull();
    const list = xlPresetsOfDef(def);
    expect(list.map((p) => p.name)).toEqual(['Init', 'Bright', 'Dark', 'Pad', 'Pluck', 'Wet']);
    expect(xlEnginePresets()['Hera 6 XL'].map((p) => p.name)).toEqual(list.map((p) => p.name));
    for (const p of list) expect(p.structure).toBe(defStructure(def));
    // an engine whose rows are a card's (here: the card's own engine, and one with a row more) takes the card
    expect(projectPresets(HERA, presetsOfDef(HERA), HERA)!.map((p) => p.values)).toEqual(presetsOfDef(HERA).map((p) => p.values));
    const other = ENGINES.find((d) => d.name === 'Oracle V')!;
    expect(projectPresets(HERA, presetsOfDef(HERA), other)).toBeNull();
  });
});
