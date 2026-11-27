// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// The DX7 card's voice editor (#1338): a field's edit into ModuleInst.voice (clamped, one undo step), SysEx into a
// module (a voice, a bank to pick from, a wrong checksum said), the algorithm diagrams drawn from the algorithm table.
import { describe, expect, it, vi } from 'vitest';
import { dx7Unpack } from './dx7';
import { bankSysex, parseDx7Sysex, singleSysex } from './dx7-sysex';
import { algDiagram, bankToSave, Dx7Card, editVoice, GLOBAL, OPF, opAt, opFreq } from './dx7-view';
import { DX7_INIT_VOICE, voiceBytes, voiceHex, voiceName } from './dx7-voice';
import { Editor, type EditorEvents } from './editor';
import { DEFS } from './modules';
import { addModule, newPatch, type ModuleInst } from './patch';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
  proto.showPopover ??= function (this: HTMLElement) { this.setAttribute('data-open', ''); };
  proto.hidePopover ??= function (this: HTMLElement) { this.removeAttribute('data-open'); };
});

const named = (name: string, alg: number): Uint8Array => {
  const b = DX7_INIT_VOICE.slice();
  b[110] = alg - 1;
  b.set([...name.padEnd(10)].map((c) => c.charCodeAt(0)), 118);
  return b;
};
const value = (m: ModuleInst, at: number): number => dx7Unpack(voiceBytes(m.voice))[at];

describe('DX7 voice edits (#1338)', () => {
  it('a field writes the voice through the unpacked form, clamped into the DX7\'s range', () => {
    const init = voiceHex(DX7_INIT_VOICE);
    const alg = editVoice(init, GLOBAL.alg, 21);
    expect(voiceBytes(alg)[110]).toBe(21);   // (algorithm 22: packed byte 110)
    expect(alg.slice(0, 220)).toBe(init.slice(0, 220));
    expect(voiceBytes(editVoice(init, GLOBAL.alg, 99))[110]).toBe(31);   // (algorithm 32 at most)
    expect(voiceBytes(editVoice(init, GLOBAL.fb, 12))[111] & 7).toBe(7);
    expect(voiceBytes(editVoice(init, opAt(2, OPF.detune), 99))[4 * 17 + 12] >> 3).toBe(14);   // (operator 2 is the 5th packed)
    expect(voiceBytes(editVoice(init, opAt(1, OPF.level), -5))[5 * 17 + 14]).toBe(0);
    expect(voiceBytes(editVoice(init, GLOBAL.transpose, 60))[117]).toBe(48);
  });

  it('shows frequencies as the DX7 does', () => {
    expect(opFreq(0, 0, 0)).toBe('0.50');
    expect(opFreq(0, 1, 0)).toBe('1.00');
    expect(opFreq(0, 3, 50)).toBe('4.50');
    expect(opFreq(1, 2, 0)).toBe('100');
    expect(opFreq(1, 3, 99)).toBe('9.77k');
  });

  it('on the card: an edit is one undoable change of the module\'s voice, and the engine is told', () => {
    document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div>';
    const p = newPatch(DEFS);
    const m = addModule(p, DEFS.dx7, 400, 100);
    let structures = 0;
    const ev: EditorEvents = { onStructure() { structures++; }, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {}, onLayout() {}, onError() {}, onSaveAssembly() {} };
    const editor = new Editor(document.getElementById('canvas')!, p, ev);
    editor.rebuild();
    const card = (): HTMLElement => document.querySelector<HTMLElement>(`.module[data-id="${m.id}"] .dx7`)!;
    expect(card().querySelector('.dx7-name')!.textContent).toBe('INIT VOICE');
    const alg = card().querySelector<HTMLInputElement>('.dx7-algf input[type=number]')!;
    expect(alg.value).toBe('1');
    alg.value = '40';   // (clamped to 32)
    alg.dispatchEvent(new Event('change'));
    const now = (): ModuleInst => editor.patch.modules.find((x) => x.id === m.id)!;
    expect(value(now(), GLOBAL.alg)).toBe(31);
    expect(structures).toBe(1);
    expect(card().querySelector<HTMLInputElement>('.dx7-algf input[type=number]')!.value).toBe('32');
    expect(card().querySelectorAll('.dx7-alg-svg rect.carrier').length).toBe(6);
    editor.undo();
    expect(value(now(), GLOBAL.alg)).toBe(0);
    // the picked operator's fields: operator 3's rate 1
    card().querySelectorAll<HTMLButtonElement>('.dx7-pick')[2].click();
    const r1 = card().querySelector<HTMLInputElement>('.dx7-sec .dx7-grid input[type=number]')!;
    r1.value = '12';
    r1.dispatchEvent(new Event('change'));
    expect(value(now(), opAt(3, OPF.r))).toBe(12);
    expect(value(now(), opAt(1, OPF.r))).toBe(99);
  });
});

describe('DX7 SysEx into a module (#1338)', () => {
  const host = (m: ModuleInst) => {
    const said: string[] = [];
    return { said, card: new Dx7Card({ setVoice: (_id, hex) => (m.voice = hex), say: (s) => said.push(s), redraw() {} }) };
  };

  it('a single voice becomes the module\'s voice', () => {
    const m = { id: 1, type: 'dx7', x: 0, y: 0, params: {} } as ModuleInst;
    const { card, said } = host(m);
    card.load(m, singleSysex(named('E.PIANO 1', 5)), 'epiano.syx');
    expect(voiceName(voiceBytes(m.voice))).toBe('E.PIANO 1');
    expect(value(m, GLOBAL.alg)).toBe(4);
    expect(said[0]).toMatch(/E\.PIANO 1 loaded$/);
  });

  it('a bank is listed; picking a name loads it; a wrong checksum is said; the bank saves with the voice in its slot', () => {
    const m = { id: 2, type: 'dx7', x: 0, y: 0, params: {} } as ModuleInst;
    const { card, said } = host(m);
    const syx = bankSysex([named('ONE', 1), named('TWO', 32)], DX7_INIT_VOICE);
    syx[syx.length - 2] ^= 1;
    card.load(m, syx, 'mine.syx');
    expect(m.voice).toBeUndefined();
    expect(said[0]).toMatch(/checksum is wrong/);
    const el = card.element(m);
    const names = [...el.querySelectorAll('.dx7-bank button')].map((b) => b.textContent);
    expect(names.length).toBe(32);
    expect(names.slice(0, 3)).toEqual(['1 ONE', '2 TWO', '3 INIT VOICE']);
    expect(el.querySelector('.dx7-bank')!.previousElementSibling!.textContent).toMatch(/Bank mine \(checksum wrong\)/);
    (el.querySelectorAll<HTMLButtonElement>('.dx7-bank button')[1]).click();
    expect(voiceName(voiceBytes(m.voice))).toBe('TWO');
    m.voice = editVoice(m.voice, GLOBAL.fb, 5);
    const back = parseDx7Sysex(card.bankFile(m))!;
    expect(back.checksumOk).toBe(true);
    expect(back.voices[1][111] & 7).toBe(5);
    expect(voiceName(back.voices[0])).toBe('ONE');
  });

  it('with no bank, a bank saves this voice in slot 1 and the init voice after; other files are refused', () => {
    const back = parseDx7Sysex(bankToSave(voiceHex(named('SOLO', 3)), null))!;
    expect(back.voices.map(voiceName).slice(0, 2)).toEqual(['SOLO', 'INIT VOICE']);
    const m = { id: 3, type: 'dx7', x: 0, y: 0, params: {} } as ModuleInst;
    const { card, said } = host(m);
    card.load(m, [0xf0, 0x41, 0x10, 0xf7], 'roland.syx');
    expect(m.voice).toBeUndefined();
    expect(said[0]).toMatch(/no DX7 voice/);
  });
});

describe('DX7 algorithm diagrams (#1338)', () => {
  const carriers = (alg: number): number[] => algDiagram(alg).ops.filter((o) => o.carrier).map((o) => o.op);
  const links = (alg: number): string[] => algDiagram(alg).links.map((l) => `${l.from}>${l.to}`).sort();

  it('algorithm 1: 2 into 1, 6 into 5 into 4 into 3, 6 on itself', () => {
    const d = algDiagram(1);
    expect(carriers(1)).toEqual([1, 3]);
    expect(links(1)).toEqual(['2>1', '4>3', '5>4', '6>5']);
    expect(d.feedback).toEqual({ from: 6, to: 6 });
    expect(d.ops.map((o) => o.row)).toEqual([0, 1, 0, 1, 2, 3]);
    expect(d.rows).toBe(4);
    expect(d.ops.map((o) => o.col)).toEqual([0, 0, 1, 1, 1, 1]);
  });

  it('algorithm 4: the loop runs from operator 4 back to 6', () => {
    expect(carriers(4)).toEqual([1, 4]);
    expect(links(4)).toEqual(['2>1', '3>2', '5>4', '6>5']);
    expect(algDiagram(4).feedback).toEqual({ from: 4, to: 6 });
  });

  it('algorithm 6: the loop runs from operator 5 back to 6', () => {
    expect(carriers(6)).toEqual([1, 3, 5]);
    expect(links(6)).toEqual(['2>1', '4>3', '6>5']);
    expect(algDiagram(6).feedback).toEqual({ from: 5, to: 6 });
  });

  it('algorithm 32: six carriers side by side, 6 on itself', () => {
    const d = algDiagram(32);
    expect(carriers(32)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(d.links).toEqual([]);
    expect(d.feedback).toEqual({ from: 6, to: 6 });
    expect(d.ops.map((o) => o.col)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(d.rows).toBe(1);
  });

  it('a modulator of several sits over their middle (algorithm 22: 6 into 3, 4 and 5)', () => {
    const d = algDiagram(22);
    expect(links(22)).toEqual(['2>1', '6>3', '6>4', '6>5']);
    const col = (op: number): number => d.ops[op - 1].col;
    expect(col(6)).toBe(col(4));
  });
});
