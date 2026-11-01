// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { addableModules } from './catalog';
import { searchCommands, type Command } from './commands';
import { moduleKeywords } from './labels';
import { DEFS } from './modules';

/** the palette's module entries, built as main.ts builds them */
const modules: Command[] = addableModules(DEFS).map((m) => ({ kind: 'add module', tags: ['module'], label: m.name, keywords: moduleKeywords(m.type, m.def.label), run() {} }));
const found = (q: string): string[] => searchCommands(modules, q).map((c) => c.label);

describe('module search (#513)', () => {
  it('finds every filter by "filter", the Multimode and the Ladder too', () => {
    expect(found('filter')).toEqual(expect.arrayContaining(['Multimode', 'Ladder', 'Comb filter', 'Formant filter']));
  });
  it('finds the Multimode by its responses', () => {
    for (const q of ['high pass', 'band pass', 'low pass', 'notch', 'hp', 'bp', 'vcf']) expect(found(q)).toContain('Multimode');
  });
  it('finds a renamed module by its former name', () => {
    expect(found('scale')).toContain('Attenuverter');
    expect(found('glide')).toContain('Slew limiter');
    expect(found('digitizer')).toContain('Bitcrusher');
  });
});
