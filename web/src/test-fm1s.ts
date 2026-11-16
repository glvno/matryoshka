// SPDX-License-Identifier: GPL-3.0-only
// Fake FM-1s on fake Web MIDI ports, for the tests of Connect FM-1 and the Install panel with several FM-1s (D-965). Each
// answers M-VAVE's identity handshake (the Install panel's), HELLO (INFO), DEVICE_SETTINGS and PRESET_GET (the test
// rig's mark) as Matryoshka does, on the input's onmidimessage (the editor's link) and its listeners (the installer's).
import { pack7 } from './flasher/fm1ota.js';
import { CMD, FEATURE_DEVICE_SETTINGS, frame, parse } from './protocol';

export interface FakePort {
  id: string; name: string; manufacturer: string; state: string;
  onmidimessage: ((ev: { data: Uint8Array }) => void) | null;
  sent: number[][];
  send(d: ArrayLike<number>): void;
  open(): Promise<void>;
  addEventListener(t: string, f: (ev: { data: Uint8Array }) => void): void;
  removeEventListener(t: string, f: (ev: { data: Uint8Array }) => void): void;
}
export interface FakeFm1 { i: FakePort; o: FakePort }

/** a Matryoshka with DEVICE_SETTINGS and presets (feature bits 22 and 7) */
export const MODERN = FEATURE_DEVICE_SETTINGS | 128;

function port(id: string, name: string): FakePort {
  const listeners = new Set<(ev: { data: Uint8Array }) => void>();
  const p: FakePort = {
    id, name, manufacturer: '', state: 'connected', onmidimessage: null, sent: [],
    send: (d) => void p.sent.push(Array.from(d)),
    open: async () => {},
    addEventListener: (_t, f) => void listeners.add(f),
    removeEventListener: (_t, f) => void listeners.delete(f),
  };
  (p as FakePort & { deliver: (d: Uint8Array) => void }).deliver = (data) => {
    p.onmidimessage?.({ data });
    for (const f of [...listeners]) f({ data });
  };
  return p;
}

/**
 * An FM-1 on ports `id` (input) and `id`.toUpperCase() (output) named `name`. `features`: INFO's feature bits; `name`
 * and `serial` (32 hexadecimal digits) what DEVICE_SETTINGS reads; `rig`: it carries the test rig's mark; `ignore`:
 * GLO > SYSTEM > EDITOR at IGNORE (#702); `identity`: its answer to M-VAVE's handshake (`ota-FM-1_700`: an update loader,
 * which answers nothing else).
 */
export function fakeFm1(id: string, o: { port?: string; features?: number; name?: string; serial?: string; rig?: boolean; ignore?: boolean; identity?: string } = {}): FakeFm1 {
  const portName = o.port ?? 'Matryoshka';
  const i = port(id, portName), out = port(id.toUpperCase(), portName);
  const deliver = (data: ArrayLike<number>): void => void setTimeout(() => (i as FakePort & { deliver: (d: Uint8Array) => void }).deliver(Uint8Array.from(data)), 1);
  const identity = o.identity ?? 'FM-1_7011100';
  const loader = /^ota-/.test(identity);
  const features = (o.features ?? MODERN) | (o.ignore ? 1 << 19 : 0);
  out.send = (d) => {
    const bytes = Array.from(d);
    out.sent.push(bytes);
    if (bytes[1] === 0x00 && bytes[2] === 0x32) {   // M-VAVE's identity handshake
      const body = [0x00, 0x59, 0x11, 0, 0, 0, ...Array.from(identity, (c) => c.charCodeAt(0))];
      return deliver([0xf0, ...pack7([...body, ...new Array(34 - body.length).fill(0)]), 0xf7]);
    }
    if (bytes.length === 6 && bytes[1] === 0x22 && bytes[2] === 0x24) {   // the update: it restarts, its ports go away
      i.state = out.state = 'disconnected';
      return;
    }
    const p = loader ? null : parse(bytes);
    if (p?.cmd === CMD.hello)
      deliver(frame(CMD.info, [1, 64, 255, 3 | (o.ignore ? 8 : 0), 1, features & 0xff, (features >> 8) & 0xff, 48, 60, 1, 11, 0, (features >> 16) & 0xff, 1, (features >>> 24) & 0xff]));
    else if (p?.cmd === CMD.deviceSettings && features & FEATURE_DEVICE_SETTINGS) {
      const name = Array.from({ length: 16 }, (_, k) => o.name?.charCodeAt(k) ?? 0);
      const serial = Array.from({ length: 16 }, (_, k) => parseInt((o.serial ?? '0'.repeat(32)).slice(2 * k, 2 * k + 2), 16));
      deliver(frame(CMD.deviceSettingsReply, [0, ...name, 50, ...serial]));
    } else if (p?.cmd === CMD.presetGet && features & 128)
      deliver(frame(CMD.presetData, [...p.payload.slice(0, 20), ...(o.rig ? [1, 0, 0, 1, 0] : [0xff])]));
  };
  return { i, o: out };
}

/** a Web MIDI access holding these FM-1s' ports, in this order */
export const fakeAccess = (...fm1s: FakeFm1[]): MIDIAccess => ({
  inputs: new Map(fm1s.map((f) => [f.i.id, f.i])), outputs: new Map(fm1s.map((f) => [f.o.id, f.o])), onstatechange: null,
}) as unknown as MIDIAccess;

/** the protocol commands an output was sent (F0 7D 4D 31 CMD ..), in order; M-VAVE's handshake counts as -1 */
export const commands = (p: FakePort): number[] => p.sent.map((d) => (d[1] === 0x00 && d[2] === 0x32 ? -1 : parse(d)?.cmd ?? -2));
