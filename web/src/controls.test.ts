// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUTTON_ID, CONDITIONS, CONTROLS, gestureSpec, HELP_STATES, rowSpec, sheetRows } from './controls';
import { BUTTONS } from './fm1-ui';
import { controlsHeader } from '../scripts/controls-h';

describe('the controls table (#553)', () => {
  it('names the buttons by the panel\'s matrix ids', () => {
    const want: Record<string, number> = { 'OCT-': BUTTONS.octDown, 'OCT+': BUTTONS.octUp, FX: BUTTONS.fx, SEL: BUTTONS.scl, ENV: BUTTONS.env,
      LFO: BUTTONS.lfo, EDIT: BUTTONS.edit, GLO: BUTTONS.glo, HOME: BUTTONS.home, SAVE: BUTTONS.save, ARP: BUTTONS.arp, SEQ: BUTTONS.seq,
      PLAY: BUTTONS.play, REC: BUTTONS.rec };
    for (const [b, id] of Object.entries(want)) expect(BUTTON_ID[b as keyof typeof BUTTON_ID], b).toBe(id);
  });
  it('writes a gesture in the sheet\'s row spec', () => {
    expect(gestureSpec({ hold: 'HOME', do: [{ encoder: 'PRESET' }] })).toBe('k:HOME|t:+|n:PRESET');
    expect(gestureSpec({ do: [{ button: 'REC' }, { button: 'HOME' }] })).toBe('k:REC|t:/|k:HOME');
    expect(gestureSpec({ do: [{ button: 'GLO' }], how: 'hold 2 s' })).toBe('t:hold|k:GLO|t:2 s');
    expect(gestureSpec({ hold: 'step', do: [{ knobs: '2' }] })).toBe('t:hold step +|c:2');
    expect(gestureSpec({ do: [{ knobs: '1' }], where: 'on END' })).toBe('c:1|t:on END');
    expect(gestureSpec({ do: [{ key: 'black', n: 10 }] })).toBe('b:10');
  });
  it('uses every condition, and a state never lists the same words twice', () => {
    for (const c of CONDITIONS) expect(CONTROLS.some((r) => r.when?.replace('!', '') === c), c).toBe(true);
    for (const s of HELP_STATES)
      for (const tab of ['state', 'everywhere'] as const) {
        const specs = sheetRows(s, tab).flatMap((r) => ('gesture' in r ? [`${rowSpec(r)}|${r.when ?? ''}`] : []));
        expect(new Set(specs).size, `${s} ${tab}`).toBe(specs.length);
      }
  });
  it('controls.h is what export-defs writes from it (npm run export-defs)', () => {
    const src = (p: string): string => readFileSync(new URL(`../../firmware/src/${p}`, import.meta.url), 'utf8');
    expect(controlsHeader(src('help_ui.c'), src('font_bc.h'))).toBe(src('controls.h'));
  });
  it('refuses a condition help_ui.c does not define', () => {
    expect(() => controlsHeader('', readFileSync(new URL('../../firmware/src/font_bc.h', import.meta.url), 'utf8'))).toThrow(/hc_list/);
  });
});
