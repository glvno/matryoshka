// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// #1054: with Live on, the FM-1's LFO (a switching Toggle on Monolith D's Harmony, D-888) striped the Harmony card's header
// but left its ⏻ as it was: a press from the FM-1 (main.ts mirrorInput), the dock or MIDI CC 80..86 toggled only the card's
// class, and the card's own ⏻ left the dock's light alone. Every bypass now goes through Editor.setBypass (or setFxStage),
// which changes the patch and redraws every view of it: each card's stripes and ⏻, each assembly's, the master FX bus
// card's stage switches and dimmed rows, and the dock's Toggle lights.
import { describe, expect, it, vi } from 'vitest';
import { setSwitches, setTarget } from './buttons';
import { Editor, type EditorEvents } from './editor';
import { fxBusOf } from './fx-bus';
import { editorCc } from './input';
import { PANEL_BUTTONS } from './modules';
import type { Patch } from './patch';
import { PRESETS } from './presets';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!document.fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

/** the editor on Monolith D (Harmony on LFO, Arp on ARP, both switching and off) with its dock, `edit` applied first; what
 *  it sends the engines goes to `sent` (main.ts sends onBypass to a Live FM-1 as BYPASS) */
function setup(edit: (p: Patch) => void = () => {}): { editor: Editor; sent: string[] } {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div><div id="dock"></div>';
  const sent: string[] = [];
  const ev: EditorEvents = {
    onStructure() {}, onParam() {}, onAtt() {}, onBypass: (id, on) => sent.push(`bypass ${id} ${on}`), onRange() {}, onTrack() {}, onTransport() {},
    onLayout() {}, onError() {}, onSaveAssembly() {}, onButton: (i, on) => sent.push(`button ${PANEL_BUTTONS[i]} ${on}`),
  };
  const p = PRESETS['Monolith D']();
  edit(p);
  const editor = new Editor(document.getElementById('canvas')!, p, ev, document.getElementById('dock'));
  editor.rebuild();
  return { editor, sent };
}

const LFO = PANEL_BUTTONS.indexOf('lfo');
const ARP = PANEL_BUTTONS.indexOf('arp');
const typed = (p: Patch, type: string) => p.modules.find((m) => m.type === type)!;
const asmNamed = (p: Patch, label: string) => p.assemblies!.find((a) => a.label === label)!;
/** the FM-1's patch button pressed and let go, as main.ts mirrorInput hands it to the editor under Live */
const fromFm1 = (editor: Editor, i: number): void => { editor.pressButton(i, true); editor.pressButton(i, false); };
/** what a card (or a frame) shows: stripes, its ⏻ lit, its ⏻'s aria-pressed */
function shown(el: Element | null): { off: boolean; on: boolean; pressed: string | null } {
  const pw = el!.querySelector(':scope > .mhead button.pw, :scope > .fhead button.pw')!;
  return { off: el!.classList.contains('off'), on: pw.classList.contains('on'), pressed: pw.getAttribute('aria-pressed') };
}
const offView = { off: true, on: false, pressed: 'false' };
const onView = { off: false, on: true, pressed: 'true' };
const card = (id: number) => document.querySelector(`.module[data-id="${id}"]`);
const container = (id: number) => document.querySelector(`.module.assembly[data-asm="${id}"]`);
const frame = (id: number) => document.querySelector(`.frame[data-asm="${id}"]`);
const light = (b: string) => document.querySelector(`.panel-btn[data-button="${b}"]`)!.getAttribute('aria-pressed');

describe('a bypass from the FM-1 changes the card’s ⏻ with its stripes (#1054)', () => {
  it('LFO pressed on the FM-1: the Harmony card’s stripes, its ⏻ and the dock’s LFO light move together, both ways', () => {
    const { editor, sent } = setup();
    const harm = typed(editor.patch, 'harm');
    const el = card(harm.id);
    expect(harm.bypass).toBe(true);
    expect(shown(el)).toEqual(offView);
    expect(light('lfo')).toBe('false');                      // (LFO on a Harmony lights while it plays, D-888)
    fromFm1(editor, LFO);
    expect(harm.bypass).toBeFalsy();
    expect(card(harm.id)).toBe(el);                          // (in place: no redraw)
    expect(shown(el)).toEqual(onView);
    expect(light('lfo')).toBe('true');
    fromFm1(editor, LFO);
    expect(harm.bypass).toBe(true);
    expect(shown(el)).toEqual(offView);
    expect(light('lfo')).toBe('false');
    expect(sent.filter((s) => s.startsWith('bypass'))).toEqual([]);   // (the FM-1 switched it itself: nothing sent back)
  });

  it('the same press as MIDI CC 85 (#1042), and ARP on the Arpeggiator card', () => {
    const { editor } = setup();
    const harm = typed(editor.patch, 'harm');
    const arp = typed(editor.patch, 'arp');
    editorCc({ n: 80 + LFO, v: 127 }, editor);
    editorCc({ n: 80 + LFO, v: 0 }, editor);
    expect(shown(card(harm.id))).toEqual(onView);
    expect(light('lfo')).toBe('true');
    fromFm1(editor, ARP);
    expect(arp.bypass).toBeFalsy();
    expect(shown(card(arp.id))).toEqual(onView);
    expect(light('arp')).toBe('true');
  });

  it('an assembly as the Toggle’s target: its card, then its expanded frame, show the press', () => {
    const { editor } = setup((p) => setTarget(p, 'lfo', { asm: asmNamed(p, 'Monolith D').id }));
    const synth = asmNamed(editor.patch, 'Monolith D');
    expect(shown(container(synth.id))).toEqual(onView);
    fromFm1(editor, LFO);
    expect(synth.bypass).toBe(true);
    expect(shown(container(synth.id))).toEqual(offView);
    expect(light('lfo')).toBe('true');                       // (an assembly lights while engaged)
    synth.open = true;
    editor.rebuild();
    expect(shown(frame(synth.id))).toEqual(offView);
    fromFm1(editor, LFO);
    expect(synth.bypass).toBeFalsy();
    expect(shown(frame(synth.id))).toEqual(onView);
    expect(light('lfo')).toBe('false');
  });

  it('an FX stage as the Toggle’s target: the bus card’s stage switch and rows follow, and the FM-1’s FX page the same', () => {
    const { editor } = setup((p) => setTarget(p, 'lfo', { asm: asmNamed(p, 'Delay').id }));
    const delay = asmNamed(editor.patch, 'Delay');
    const bus = fxBusOf(editor.patch)!;
    const sw = () => document.querySelector(`.fx-stages button.fx-stage[data-asm="${delay.id}"]`)!;
    const rows = () => [...document.querySelectorAll<HTMLElement>(`.module.assembly[data-asm="${bus.assembly}"] .param[data-mod]`)].filter((r) => delay.modules.includes(Number(r.dataset.mod)));
    expect(rows().length).toBeGreaterThan(0);
    expect([sw().getAttribute('aria-pressed'), rows().every((r) => r.classList.contains('stage-off'))]).toEqual(['false', true]);
    fromFm1(editor, LFO);
    expect(delay.bypass).toBeFalsy();
    expect([sw().getAttribute('aria-pressed'), sw().classList.contains('on'), rows().some((r) => r.classList.contains('stage-off'))]).toEqual(['true', true, false]);
    const was = sw();
    editor.setFxStage(bus.stages.find((s) => s.kind === 'delay')!, false);   // (main.ts: the FM-1's FX page, D-966)
    expect(sw()).toBe(was);
    expect([sw().getAttribute('aria-pressed'), rows().every((r) => r.classList.contains('stage-off'))]).toEqual(['false', true]);
  });

  it('a Toggle that acts while held shows its target off while it is down, ⏻ and all', () => {
    const { editor } = setup((p) => { setSwitches(p, 'lfo', false); delete typed(p, 'harm').bypass; });
    const harm = typed(editor.patch, 'harm');
    expect(shown(card(harm.id))).toEqual(onView);
    editor.pressButton(LFO, true);
    expect(harm.bypass).toBeFalsy();                         // (the engine bypasses it, the patch does not)
    expect(shown(card(harm.id))).toEqual(offView);
    expect(light('lfo')).toBe('false');
    editor.pressButton(LFO, false);
    expect(shown(card(harm.id))).toEqual(onView);
    expect(light('lfo')).toBe('true');
  });
});

describe('the editor’s ⏻ reaches the FM-1 and the dock (#1054)', () => {
  it('the Harmony card’s ⏻: the patch, its aria-pressed and the dock’s LFO light change, and the change is sent', () => {
    const { editor, sent } = setup();
    const harm = typed(editor.patch, 'harm');
    card(harm.id)!.querySelector<HTMLButtonElement>(':scope > .mhead button.pw')!.click();
    expect(harm.bypass).toBeFalsy();
    expect(shown(card(harm.id))).toEqual(onView);
    expect(light('lfo')).toBe('true');
    expect(sent).toEqual([`bypass ${harm.id} false`]);       // (main.ts: BYPASS to a Live FM-1, whose LFO lights)
    fromFm1(editor, LFO);                                    // and the FM-1's LFO turns it off again from there
    expect(harm.bypass).toBe(true);
    expect(shown(card(harm.id))).toEqual(offView);
    expect(light('lfo')).toBe('false');
  });

  it('an assembly’s ⏻ and Bypass selection redraw the same views', () => {
    const { editor, sent } = setup((p) => setTarget(p, 'lfo', { asm: asmNamed(p, 'Monolith D').id }));
    const synth = asmNamed(editor.patch, 'Monolith D');
    container(synth.id)!.querySelector<HTMLButtonElement>(':scope > .mhead button.pw')!.click();
    expect(shown(container(synth.id))).toEqual(offView);
    expect(light('lfo')).toBe('true');
    expect(sent.length).toBeGreaterThan(0);
    const harm = typed(editor.patch, 'harm');
    editor.selectOnly([harm.id]);
    expect(editor.bypassSelected()).toBe(true);              // (Harmony on: it was off)
    expect(shown(card(harm.id))).toEqual(onView);
  });
});
