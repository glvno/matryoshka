// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUTTON_ID, CONDITIONS, CONTROLS, fixedDoes, type Gesture, gestureSpec, gestureText, HELP_STATES, HINTS, hintText, rowSpec, sheetRows, stateRows } from './controls';
import { fm1HelpGroups } from './controls-help';
import { FIXED_DOES } from './modules';
import { BUTTONS } from './fm1-ui';
import { controlsHeader, readmeWithControls } from '../scripts/controls-h';

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
    const together: Gesture = { do: [{ button: 'HOME' }, { button: 'OCT-' }, { button: 'OCT+' }], join: 'together', how: 'hold 2 s' };
    expect(gestureSpec(together)).toBe('k:HOME|t:+|k:OCT-|t:+|k:OCT+|t:2 s');   // (#631: held together, 2 s)
    expect(gestureText(together)).toBe('HOME + OCT- + OCT+ held 2 s');
  });
  it('uses every condition, and a state never lists the same words twice', () => {
    for (const c of CONDITIONS) expect(CONTROLS.some((r) => r.when?.replace('!', '') === c), c).toBe(true);
    for (const s of HELP_STATES)
      for (const tab of ['state', 'everywhere'] as const) {
        const specs = sheetRows(s, tab).flatMap((r) => ('gesture' in r ? [`${tab === 'state' ? rowSpec(r, s) : rowSpec(r)}|${r.when ?? ''}`] : []));
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
  it('makes the hint lines from the rows\' hints', () => {
    const h = (id: string): string => hintText(HINTS.find((x) => x.id === id)!);
    expect(h('step_record')).toBe('KEYS note  LFO rest  KEY+LFO tie  REC done');
    expect(h('held_roll')).toBe('HELD: K1 note  K2 vel  K3 chance  ALGO lock');
    expect(h('menu_guide')).toBe('SELECT scroll  ALGO tab  GLO/HOME back');
    expect(() => hintText({ id: 'x', items: ['no-such-row'], width: 228 })).toThrow(/no row/);
  });
  it('the ? card lists every row of every state, in the sheet\'s order', () => {
    const groups = fm1HelpGroups();
    for (const s of HELP_STATES) {
      const g = groups.find((x) => x.state === s)!;
      expect(g.rows.map((r) => r.keys), s).toEqual(stateRows(s).map((r) => gestureText(r.gesture)));
    }
    expect(groups.find((g) => g.title === 'Everywhere')!.rows.some((r) => r.keys === 'PLAY held + PRESET')).toBe(true);
  });
  it('FIXED_DOES says what the table says GLO, SEL and ENV do', () => {
    expect(FIXED_DOES).toEqual({ glo: fixedDoes('GLO'), scl: fixedDoes('SEL'), env: fixedDoes('ENV') });
    expect(FIXED_DOES.glo).toContain('run armed row');
    expect(FIXED_DOES.scl).toContain('arm only this');
    expect(FIXED_DOES.env).toContain('then SEL: arm several');
    expect(FIXED_DOES.env).toContain('save device preset');
  });
  it('the README\'s list of controls is the table\'s (npm run export-defs)', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    expect(readmeWithControls(readme)).toBe(readme);
  });
});

