// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FACTORY } from './assemblies';
import { insertAssembly } from './assembly';
import { capturePreset } from './device-presets';
import { catalogEffectDef, drawerOf, EFFECT_CATALOG, effectsOf, outputDrawer } from './fx-drawer';
import { addToDrawer, buildEffectsDialog, currentInstrument, drawerTargets, effectCpu, effectGroups, effectPresets, effectRank, entryOf, entryStructures, instrumentsOf, MODES, presetSource, type EffectDialogActions } from './library-effects';
import { DEFS } from './modules';
import { newPatch } from './patch';
import { defStructure } from './structure';

const def = (name: string) => FACTORY.find((d) => d.name === name)!;
const withHera = () => {
  const p = newPatch(DEFS);
  const hera = insertAssembly(p, DEFS, def('Hera 4'), 40, 40);
  return { p, hera };
};
const byType = (type: string) => EFFECT_CATALOG.find((e) => 'type' in e.source && e.source.type === type)!;

beforeEach(() => localStorage.clear());

describe('the Library’s effects', () => {
  it('groups every catalog effect once, by how it sits in the stereo chain, in the Library’s order', () => {
    const groups = effectGroups();
    expect(groups.map((g) => g.mode)).toEqual(MODES.map((m) => m.mode).filter((m) => EFFECT_CATALOG.some((e) => e.mode === m)));
    expect(groups.flatMap((g) => g.entries)).toHaveLength(EFFECT_CATALOG.length);
    for (const g of groups) expect(g.entries.every((e) => e.mode === g.mode)).toBe(true);
    expect(groups.find((g) => g.mode === 'pair')!.title).toBe('In line, as an L/R pair');
  });

  it('finds the effect a module type or a factory assembly is, and none for a modulator or an instrument', () => {
    expect(entryOf({ type: 'reverb' })?.mode).toBe('wet');
    expect(entryOf({ type: 'lfo' })).toBeUndefined();
    expect(entryOf({ def: def('echo') })?.name).toBe('Echo');
    expect(entryOf({ def: def('Hera 4') })).toBeUndefined();
    expect(EFFECT_CATALOG.some((e) => e.name.toLowerCase() === 'master fx')).toBe(false);
  });

  it('counts an L/R pair’s two copies in its CPU share', () => {
    const pair = EFFECT_CATALOG.find((e) => e.mode === 'pair' && 'type' in e.source)!;
    const p = newPatch(DEFS);
    const one = insertAssembly(p, DEFS, catalogEffectDef(pair), 0, 0);
    expect(one.modules.length).toBeGreaterThanOrEqual(2);
    expect(effectCpu(pair)).toBeGreaterThan(0);
  });
});

describe('adding to an FX drawer', () => {
  it('offers each instrument’s drawer and the Output’s, making the drawer on first use and opening it', () => {
    const { p, hera } = withHera();
    expect(instrumentsOf(p).map((a) => a.id)).toEqual([hera.id]);
    expect(drawerTargets(p)).toEqual([
      { to: hera.id, label: `${hera.label}’s FX`, detail: 'new drawer' },
      { to: 'output', label: 'Output FX', detail: 'new drawer' },
    ]);
    const effect = addToDrawer(p, { type: 'reverb' }, hera.id);
    const drawer = drawerOf(p, hera.id)!;
    expect(drawer.open).toBe(true);
    expect(effectsOf(p, drawer).map((a) => a.id)).toEqual([effect.id]);
    expect(drawerTargets(p)[0].detail).toBe('at the end');
    addToDrawer(p, { type: 'shape' }, hera.id, 0);
    expect(effectsOf(p, drawer).map((a) => a.id)[1]).toBe(effect.id);
    addToDrawer(p, { def: def('echo') }, 'output');
    expect(effectsOf(p, outputDrawer(p)!)).toHaveLength(1);
    // an instrument with a drawer stays an instrument; drawers and effects never are
    expect(instrumentsOf(p).map((a) => a.id)).toEqual([hera.id]);
  });

  it('⇧⏎ goes to the selected instrument, the owner of a selected effect, the focused or armed one, else the only one', () => {
    const { p, hera } = withHera();
    const other = insertAssembly(p, DEFS, def('Monolith D'), 400, 40);
    const effect = addToDrawer(p, { type: 'reverb' }, other.id);
    expect(currentInstrument(p)).toBeUndefined();
    expect(currentInstrument(p, { assemblies: [hera.id] })?.id).toBe(hera.id);
    expect(currentInstrument(p, { assemblies: [effect.id] })?.id).toBe(other.id);
    expect(currentInstrument(p, { focus: `a${other.id}` })?.id).toBe(other.id);
    expect(currentInstrument(p, { armed: [`a${hera.id}`] })?.id).toBe(hera.id);
    const solo = withHera();
    expect(currentInstrument(solo.p)?.id).toBe(solo.hera.id);
  });
});

describe('effect presets', () => {
  it('lists the user’s presets of an effect and adds one set to its values', () => {
    const delay = byType('delay');
    const p = newPatch(DEFS);
    const a = insertAssembly(p, DEFS, catalogEffectDef(delay), 0, 0);
    expect(entryStructures(delay)[0]).toBe(defStructure(catalogEffectDef(delay)));
    const row = a.params[0];
    p.modules.find((x) => x.id === row.module)!.params[row.param] = 333;
    const preset = capturePreset(p, a, 'Slapback');
    expect(preset.values).toContain(333);
    const listed = effectPresets([preset]);
    expect(listed).toEqual([{ preset, entry: delay, wrapped: true }]);
    const { def: made } = presetSource(listed[0]);
    const q = newPatch(DEFS);
    const b = insertAssembly(q, DEFS, made, 0, 0);
    expect(capturePreset(q, b, 'again').values).toEqual(preset.values);
    expect(b.chain).toBeTruthy();
  });
});

describe('Add effect (the sidebar’s + Effect)', () => {
  // jsdom has no dialog methods or PointerEvent: open / modal stand in for the browser's
  globalThis.PointerEvent ??= class extends MouseEvent {} as typeof PointerEvent;
  afterEach(() => document.body.replaceChildren());
  const setup = (opts: { current?: boolean; landed?: boolean } = {}) => {
    const { p, hera } = withHera();
    const dialog = document.createElement('dialog');
    const state = (open: boolean, modal: boolean) => { dialog.toggleAttribute('open', open); dialog.toggleAttribute('data-modal', modal); };
    dialog.showModal = () => state(true, true);
    dialog.show = () => state(true, false);
    dialog.close = () => state(false, false);
    document.body.append(dialog);
    const log: string[] = [];
    const act: EffectDialogActions = {
      patch: () => p,
      current: () => (opts.current === false ? undefined : hera),
      canvas: (s, name) => log.push(`canvas ${name} ${'type' in s ? s.type : s.def.name}`),
      drawer: (_s, to, name) => log.push(`drawer ${name} ${to === hera.id ? 'hera' : to}`),
      drag: { start: () => log.push('start'), over: () => {}, end: () => log.push('end'), drop: () => (log.push('drop'), opts.landed ?? true) },
      error: (msg) => log.push(`error ${msg}`),
    };
    buildEffectsDialog(dialog, act).open();
    const input = dialog.querySelector('input')!;
    const names = () => [...dialog.querySelectorAll('.fxlib-row')].map((r) => r.querySelector('.fxlib-name')!.textContent + (r.classList.contains('sel') ? '*' : ''));
    const type = (q: string) => { input.value = q; input.dispatchEvent(new Event('input')); };
    const key = (k: string, mods: KeyboardEventInit = {}) => input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }));
    return { p, hera, dialog, input, log, names, type, key };
  };

  it('opens as a modal on every catalog effect by group, the first one chosen, the search field focused', () => {
    const { dialog, input, names } = setup();
    expect(dialog.hasAttribute('data-modal')).toBe(true);
    expect(document.activeElement).toBe(input);
    expect([...dialog.querySelectorAll('.fxlib-group')].map((g) => g.textContent)).toEqual(effectGroups().map((g) => g.title));
    expect(names()).toEqual(effectGroups().flatMap((g) => g.entries.map((e) => e.name)).map((n, i) => (i ? n : `${n}*`)));
    expect(dialog.querySelector('.fxpick-hint')!.textContent).toContain('into Hera 4’s FX');
  });

  it('searches names first, then groups and blurbs; ↑ ↓ choose; ⏎ adds the chosen one to the canvas and closes', () => {
    const { dialog, log, names, type, key } = setup();
    expect(effectRank('del', 'Delay', '')).toBeGreaterThan(effectRank('del', 'Comb filter', 'a delay line'));
    expect(effectRank('zzz', 'Delay', 'echoes')).toBe(-1);
    type('delay');
    expect(names()[0]).toBe('Delay*');
    expect(dialog.querySelector('.fxlib-group')).toBeNull();
    key('ArrowDown');
    key('ArrowUp');
    expect(names()[0]).toBe('Delay*');
    key('Enter');
    expect(log).toEqual(['canvas Delay delay']);
    expect(dialog.hasAttribute('open')).toBe(false);
  });

  it('⇧⏎ puts the chosen effect into the current instrument’s drawer, ⌥⏎ into the Output FX; with no instrument ⇧⏎ adds it to the canvas', () => {
    let t = setup();
    t.type('chorus');
    t.key('Enter', { shiftKey: true });
    expect(t.log).toEqual(['drawer Chorus hera']);
    t = setup();
    t.type('chorus');
    t.key('Enter', { altKey: true });
    expect(t.log).toEqual(['drawer Chorus output']);
    t = setup({ current: false });
    expect(t.dialog.querySelector('.fxpick-hint')!.textContent).not.toContain('⇧⏎');
    t.type('chorus');
    t.key('Enter', { shiftKey: true });
    expect(t.log).toEqual(['canvas Chorus chorus']);
  });

  it('a drag fades it without its backdrop; it closes when the effect landed and comes back when it did not', () => {
    for (const landed of [true, false]) {
      const { dialog, log } = setup({ landed });
      const grip = dialog.querySelector('.fxlib-row .fxlib-grip')!;
      grip.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, clientY: 200 }));
      expect(dialog.classList.contains('fxpick-dragging')).toBe(true);
      expect(dialog.hasAttribute('open') && !dialog.hasAttribute('data-modal')).toBe(true);
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 200, clientY: 200 }));
      expect(log).toEqual(['start', 'end', 'drop']);
      expect(dialog.classList.contains('fxpick-dragging')).toBe(false);
      expect(dialog.hasAttribute('open')).toBe(!landed);
      expect(dialog.hasAttribute('data-modal')).toBe(!landed);
    }
  });

  it('a finger drags from a row’s grip only: elsewhere on the row it scrolls the list', () => {
    const { dialog, log } = setup();
    const touch = (el: Element) => {
      const e = new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true });
      Object.defineProperty(e, 'pointerType', { value: 'touch' });
      el.dispatchEvent(e);
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 200 }));
      window.dispatchEvent(new PointerEvent('pointercancel', { clientX: 10, clientY: 200 }));
    };
    touch(dialog.querySelector('.fxlib-row .fxlib-blurb')!);
    expect(log).toEqual([]);
    touch(dialog.querySelector('.fxlib-row .fxlib-grip')!);
    expect(log).toEqual(['start', 'end']);
    expect(dialog.hasAttribute('data-modal')).toBe(true);
  });

  it('a press outside its box closes it; its keys never reach the canvas’s shortcuts', () => {
    const { dialog, key } = setup();
    let reached = false;
    const shortcut = () => { reached = true; };
    window.addEventListener('keydown', shortcut);
    key('a');
    window.removeEventListener('keydown', shortcut);
    expect(reached).toBe(false);
    dialog.querySelector('.fxpick-list')!.dispatchEvent(new PointerEvent('pointerdown', { clientX: 5, clientY: 5, bubbles: true }));
    expect(dialog.hasAttribute('open')).toBe(true);
    dialog.dispatchEvent(new PointerEvent('pointerdown', { clientX: 5, clientY: 5, bubbles: true }));
    expect(dialog.hasAttribute('open')).toBe(false);
  });
});
