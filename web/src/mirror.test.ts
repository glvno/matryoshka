// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { pack7 } from './flasher/fm1ota.js';
import { identifyFm1, installOffer } from './mirror';

/** a fake MIDI access with one in/out pair named `name`; `identity`: what it answers M-VAVE's handshake, or silence */
function fakeAccess(name: string, identity: string | null): MIDIAccess {
  const listeners = new Set<(ev: { data: Uint8Array }) => void>();
  const id = identity && [0x00, 0x59, 0x11, 0, 0, 0, ...Array.from(identity, (c) => c.charCodeAt(0))];
  const answer = id && [0xf0, ...pack7([...id, ...new Array(34 - id.length).fill(0)]), 0xf7];
  const input = {
    name, state: 'connected', open: async () => {},
    addEventListener: (_: string, f: (ev: { data: Uint8Array }) => void) => listeners.add(f),
    removeEventListener: (_: string, f: (ev: { data: Uint8Array }) => void) => listeners.delete(f),
  };
  const output = {
    name, state: 'connected', open: async () => {},
    send: () => { if (answer) setTimeout(() => listeners.forEach((f) => f({ data: new Uint8Array(answer) })), 1); },
  };
  return { inputs: new Map([['i', input]]), outputs: new Map([['o', output]]) } as unknown as MIDIAccess;
}

describe('Connect FM-1 when Matryoshka does not answer', () => {
  it('names the official firmware and offers the install', async () => {
    const id = await identifyFm1(fakeAccess('FM-1', 'FM-1_015'));
    expect(id).toEqual({ text: 'FM-1_015', loader: false, port: 'FM-1' });
    expect(installOffer(id)).toBe('This FM-1 runs M-VAVE\'s official firmware (FM-1_015), not Matryoshka');
  });

  it('still offers it when an FM-1 port is there but nothing answers the handshake', async () => {
    const id = await identifyFm1(fakeAccess('USB Composite Device', null));
    expect(id).toEqual({ text: null, loader: false, port: 'USB Composite Device' });
    expect(installOffer(id)).toMatch(/^An FM-1 is on USB MIDI \(USB Composite Device\) but does not answer as Matryoshka/);
  });

  it('says nothing more without an FM-1 port, or for Matryoshka itself', async () => {
    expect(await identifyFm1(fakeAccess('IAC Driver Bus 1', null))).toBeNull();
    expect(installOffer(null)).toBeNull();
    expect(installOffer({ text: 'FM-1_712', loader: false, port: 'Matryoshka 1' })).toBeNull();
  });

  it('tells an update loader and Felucca apart', () => {
    expect(installOffer({ text: 'ota-FM-1_700', loader: true, port: 'FM-1' })).toMatch(/update loader \(ota-FM-1_700\)/);
    expect(installOffer({ text: 'FM-1_912', loader: false, port: 'Felucca' })).toBe('This FM-1 runs Felucca (FM-1_912), not Matryoshka');
  });
});
