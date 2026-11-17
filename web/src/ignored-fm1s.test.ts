// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
// #1045: the owner's window played F G H J as the Harmonizer's chord buttons, and he never turned it on: the test rig, an
// FM-1 he keeps at GLO › SYSTEM › EDITOR IGNORE, pressed LFO (Harmony) over MIDI while scenarios ran on it, and since
// #1041 a patch button from any MIDI input presses the editor's. An FM-1 set to IGNORE now plays nothing in the editor;
// any other FM-1 still plays it as a MIDI controller, and the emulator's port plays nothing unless it is linked.
import { describe, expect, it, vi } from 'vitest';
import { Editor, type EditorEvents } from './editor';
import { Engine } from './engine';
import { IgnoredFm1s, playsNothing } from './ignored-fm1s';
import { attachMidi, editorCc } from './input';
import { PANEL_BUTTONS } from './modules';
import { PRESETS } from './presets';
import { CMD, frame, parse } from './protocol';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  if (!(document as unknown as { fonts?: unknown }).fonts) Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, ready: Promise.resolve() } });
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.checkVisibility ??= () => true;
  proto.scrollTo ??= () => {};
});

type Listener = (ev: { target: Port; data: Uint8Array }) => void;
interface Port {
  id: string; name: string; manufacturer: string; state: string;
  onmidimessage: Listener | null;
  sent: Uint8Array[];
  send(d: Uint8Array): void;
  open(): Promise<void>;
  addEventListener(t: string, f: Listener): void;
  removeEventListener(t: string, f: Listener): void;
  /** a message on this input, to every listener */
  emit(data: number[] | Uint8Array): void;
}
const port = (id: string, name: string): Port => {
  const listeners = new Set<Listener>();
  const p: Port = {
    id, name, manufacturer: '', state: 'connected', onmidimessage: null, sent: [],
    send: (d) => void p.sent.push(d),
    open: async () => {},
    addEventListener: (_t, f) => void listeners.add(f),
    removeEventListener: (_t, f) => void listeners.delete(f),
    emit: (data) => {
      const ev = { target: p, data: Uint8Array.from(data) };
      p.onmidimessage?.(ev);
      for (const f of listeners) f(ev);
    },
  };
  return p;
};
/** INFO's payload: Matryoshka with GLO › SYSTEM › EDITOR at IGNORE (flags bit 3, feature bit 19, #702) or at ALLOW */
const info = (ignore: boolean): number[] => (ignore ? [1, 64, 255, 3 | 8, 1, 0, 1, 48, 48, 0, 0, 0, 8] : [1, 64, 255, 3, 1, 0, 1, 48, 48, 0, 0, 0, 8]);
/** a MIDI device's input and output of one name; an FM-1 answers HELLO with INFO unless `silent` */
function device(id: string, name: string, o: { ignore?: boolean; answers?: boolean } = {}): { inp: Port; out: Port } {
  const inp = port(id, name), out = port(id.toUpperCase(), name);
  out.send = (d) => {
    out.sent.push(d);
    if (o.answers !== false && parse(d)?.cmd === CMD.hello) inp.emit(frame(CMD.info, info(!!o.ignore)));
  };
  return { inp, out };
}
const access = (devs: { inp: Port; out: Port }[]): MIDIAccess & { change(): void } => {
  const changes: (() => void)[] = [];
  return {
    inputs: new Map(devs.map((d) => [d.inp.id, d.inp])), outputs: new Map(devs.map((d) => [d.out.id, d.out])),
    addEventListener: (_t: string, f: () => void) => void changes.push(f),
    change: () => changes.forEach((f) => f()),
  } as unknown as MIDIAccess & { change(): void };
};
const hellos = (p: Port): number => p.sent.filter((d) => parse(d)?.cmd === CMD.hello).length;
/** HELLO is asked again 700 ms later until the FM-1 answers, three times in all */
const RETRIES_MS = 3 * 700;

describe('IgnoredFm1s (#1045)', () => {
  it('asks every FM-1 HELLO and knows the ones set to ignore the editor; no other port is asked', async () => {
    const rig = device('rig', 'Matryoshka', { ignore: true }), mine = device('mine', 'Matryoshka'), old = device('old', 'Felucca', { answers: false });
    const keys = device('keys', 'KeyStep 37'), emu = device('emu', 'FM-1 (emu 4242)');
    vi.useFakeTimers();
    try {
      const w = new IgnoredFm1s(access([rig, mine, old, keys, emu]), () => false);
      vi.advanceTimersByTime(RETRIES_MS);
      expect(w.has(rig.inp)).toBe(true);
      expect([mine, old, keys, emu].map((d) => w.has(d.inp))).toEqual([false, false, false, false]);   // (no answer: it plays)
      expect([rig, mine, old, keys, emu].map((d) => hellos(d.out))).toEqual([1, 1, 3, 0, 0]);   // (asked until it answers)
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows the INFO an FM-1 sends when its setting changes, and asks again an FM-1 that comes back', async () => {
    const rig = device('rig', 'Matryoshka'), a = access([rig]);
    const w = new IgnoredFm1s(a, () => false);
    expect(w.has(rig.inp)).toBe(false);
    rig.inp.emit(frame(CMD.info, info(true)));   // (set to IGNORE on the FM-1: INFO unasked)
    expect(w.has(rig.inp)).toBe(true);
    rig.inp.state = rig.out.state = 'disconnected';
    a.change();
    expect(w.has(rig.inp)).toBe(false);
    rig.inp.state = rig.out.state = 'connected';
    a.change();
    expect(hellos(rig.out)).toBe(2);
  });

  it('asks the linked FM-1 nothing (the link does), but hears its answers', async () => {
    const mine = device('mine', 'Matryoshka');
    const w = new IgnoredFm1s(access([mine]), (inp) => inp.id === 'mine');
    expect(hellos(mine.out)).toBe(0);
    mine.inp.emit(frame(CMD.info, info(true)));
    expect(w.has(mine.inp)).toBe(true);
  });
});

/** the editor on Monolith D with its dock, the browser engine fed what the editor sends it (main.ts onButton), and MIDI
 *  attached as main.ts attaches it: the sink takes CC 16..19 and 80..86 for the editor, the rest goes to the engine */
async function setup(devs: { inp: Port; out: Port }[], linked: string | null, ignoring: IgnoredFm1s | null) {
  document.body.innerHTML = '<div id="canvas"><div id="canvas-space"><div id="patch-world"><svg id="cables"></svg><div id="modules"></div><svg id="cable-glow"></svg><svg id="patch-preview"></svg></div></div></div><div id="dock"></div>';
  const engine = new Engine(44118);
  const ev: EditorEvents = {
    onStructure() {}, onParam() {}, onAtt() {}, onBypass() {}, onRange() {}, onTrack() {}, onTransport() {}, onLayout() {}, onError() {}, onSaveAssembly() {},
    onButton: (i, on) => engine.setButton(i, on),
  };
  const editor = new Editor(document.getElementById('canvas')!, PRESETS['Monolith D'](), ev, document.getElementById('dock'));
  editor.rebuild();
  engine.load(editor.patch);
  const played: unknown[] = [];
  const nav = navigator as unknown as { requestMIDIAccess?: unknown };
  const saved = nav.requestMIDIAccess;
  nav.requestMIDIAccess = async () => access(devs);
  try {
    await attachMidi({ send: (m) => { if (!(m.t === 'cc' && editorCc(m, editor))) played.push(m); } }, () => {}, undefined, (p) => playsNothing(p, linked, ignoring));
  } finally {
    nav.requestMIDIAccess = saved;
  }
  return { editor, played, arpOn: () => !editor.patch.modules.find((m) => m.type === 'arp')!.bypass };
}
const ARP = 80 + PANEL_BUTTONS.indexOf('arp');
/** C4 pressed and ARP pressed and let go, as an FM-1 sends them (D-456) */
const play = (p: Port): void => {
  p.emit([0x90, 60, 100]);
  p.emit([0xb0, ARP, 127]);
  p.emit([0xb0, ARP, 0]);
};

describe('MIDI from an FM-1 set to ignore the editor, another FM-1, a controller, the emulator (#1045)', () => {
  it('an FM-1 at IGNORE plays nothing and presses nothing, linked to none or not', async () => {
    const rig = device('rig', 'Matryoshka', { ignore: true });
    const w = new IgnoredFm1s(access([rig]), () => false);
    const s = await setup([rig], null, w);
    play(rig.inp);
    expect(s.played).toEqual([]);
    expect(s.arpOn()).toBe(false);
  });

  it('any other FM-1, not linked, plays as a MIDI controller: its keys sound and ARP presses the editor\'s ARP', async () => {
    const rig = device('rig', 'Matryoshka', { ignore: true }), mine = device('mine', 'Matryoshka');
    const w = new IgnoredFm1s(access([rig, mine]), () => false);
    const s = await setup([rig, mine], null, w);
    play(mine.inp);
    expect(s.played).toEqual([{ t: 'on', note: 60, vel: 100 / 127, ch: 1 }]);
    expect(s.arpOn()).toBe(true);
  });

  it('a plain controller plays and presses as before, also with nothing watched (SysEx not allowed)', async () => {
    const keys = device('keys', 'KeyStep 37');
    const s = await setup([keys], null, null);
    play(keys.inp);
    expect(s.played).toEqual([{ t: 'on', note: 60, vel: 100 / 127, ch: 1 }]);
    expect(s.arpOn()).toBe(true);
  });

  it('the emulator\'s port plays nothing unless the editor is linked to it (a scenario\'s page)', async () => {
    const emu = device('emu', 'FM-1 (emu 4242)');
    const s = await setup([emu], null, null);
    play(emu.inp);
    expect(s.played).toEqual([]);
    expect(s.arpOn()).toBe(false);
    const linked = await setup([emu], 'emu', null);
    play(emu.inp);
    expect(linked.played).toHaveLength(1);
    expect(linked.arpOn()).toBe(true);
  });
});
