// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-ignore untyped JS module
import { STOCK_V15_SHA256, validateStockPackage } from './flasher/fm1pkg.js';
// @ts-ignore untyped JS module
import { Updater, loaderFits, pack7, unpack7 } from './flasher/fm1ota.js';
import { guardUnload } from './flasher';

const stock = (): Uint8Array => new Uint8Array(readFileSync(new URL('../public/firmware/FM-1_015.fwsc', import.meta.url)));

describe('bundled stock firmware', () => {
  it('is the unmodified official V15 the Return to stock button sends', async () => {
    const v = await validateStockPackage(stock());
    expect(v.product).toBe('FM-1_015');
    expect(v.sha256).toBe(STOCK_V15_SHA256);
  });

  it('a changed byte is refused', async () => {
    const raw = stock();
    raw[5000] ^= 1;
    await expect(validateStockPackage(raw)).rejects.toThrow();
  });

  it('ships with its notice naming the checksum', () => {
    const notice = readFileSync(new URL('../public/firmware/NOTICE-FM-1_015.txt', import.meta.url), 'utf8');
    expect(notice).toContain(STOCK_V15_SHA256);
    expect(notice).toContain('Apache License, Version 2.0');
  });
});

describe('finishing an interrupted write (resume)', () => {
  it('M-VAVE\'s loader only gets the official V15, Felucca-type loaders everything else', () => {
    expect(loaderFits('ota-FM-1_015', 'FM-1_015')).toBe(true);
    expect(loaderFits('ota-FM-1_015', 'FM-1_700')).toBe(false); // it would write our flash head
    expect(loaderFits('ota-FM-1_015', 'FM-1_910')).toBe(false);
    expect(loaderFits('ota-FM-1_700', 'FM-1_700')).toBe(true);
    expect(loaderFits('ota-FM-1_700', 'FM-1_710')).toBe(true); // our loader reports 700 in release builds too
    expect(loaderFits('ota-FM-1_800', 'FM-1_700')).toBe(true); // a loader of ours from before #79 finishes a new package
    expect(loaderFits('ota-FM-1_900', 'FM-1_700')).toBe(true); // Felucca's loader
    expect(loaderFits('ota-FM-1_800', 'FM-1_015')).toBe(false);
    expect(loaderFits('ota-FM-1_8123456', 'FM-1_800')).toBe(false); // M-VAVE Official Open
    expect(loaderFits('ota-FM1C_0123456789abcdef', 'FM-1_800')).toBe(false);
  });

  const parked = (text: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const up: any = new Updater({ inputs: new Map(), outputs: new Map() });
    let closed = false, written = false;
    up.find = async () => ({ link: { close: () => (closed = true) }, id: { text, model: text.split('_')[0] } });
    up.write = async () => ((written = true), { finished: true });
    up.waitFor = async () => ({ link: { close() {} }, id: { text: 'FM-1_015', model: 'FM-1' } });
    return { up, state: () => ({ closed, written }) };
  };

  it('refuses to give our package to M-VAVE\'s loader, sending nothing', async () => {
    const { up, state } = parked('ota-FM-1_015');
    await expect(up.resume(new Uint8Array(8), () => {}, 'FM-1_800')).rejects.toMatchObject({ code: 'otherloader', detail: 'ota-FM-1_015' });
    expect(state()).toEqual({ closed: true, written: false });
  });

  it('finishes a cut-off return to stock in M-VAVE\'s loader', async () => {
    const { up, state } = parked('ota-FM-1_015');
    expect(await up.resume(new Uint8Array(8), () => {}, 'FM-1_015')).toBe(true);
    expect(state().written).toBe(true);
  });

  it('refuses to give the V15 to our loader', async () => {
    const { up, state } = parked('ota-FM-1_800');
    await expect(up.resume(new Uint8Array(8), () => {}, 'FM-1_015')).rejects.toMatchObject({ code: 'otherloader' });
    expect(state().written).toBe(false);
  });
});

/** a device read request (cmd 0x30) as the firmware's ota_read sends it */
const request = (addr: number, len: number): number[] => {
  const u = [0x00, 0x59, 0x30, 8, 0, 0, 0, addr & 0xff, (addr >>> 8) & 0xff, (addr >>> 16) & 0xff, (addr >>> 24) & 0xff, len & 0xff, (len >> 8) & 0xff, 0];
  let s = 0;
  for (let i = 6; i < 14; i++) s += u[i];
  return [0xf0, ...pack7([...u, ~s & 0xff]), 0xf7];
};
/** the address a response answers */
const answered = (pkt: number[]): number => {
  const u = unpack7(pkt.slice(1, -1));
  return (u[7] | (u[8] << 8) | (u[9] << 16) | (u[10] << 24)) >>> 0;
};
/** a link that hands out the given packets, then nothing */
const fakeLink = (pkts: number[][]) => {
  const sent: number[][] = [];
  return { sent, lost: false, read: async () => pkts.shift() ?? null, send: (b: number[]) => (sent.push(b), true) };
};

describe('serving read requests', () => {
  const image = new Uint8Array(1024).map((_, i) => i & 0xff);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const up: any = new Updater({ inputs: new Map(), outputs: new Map() });

  it('answers data, then this step\'s finish request and its repeats', async () => {
    const link = fakeLink([request(0, 16), request(0xe0000000, 8), request(0xe0000000, 8)]);
    expect(await up.serve(link, image, 0xe0000000, 1000)).toEqual({ served: 1, finished: true });
    expect(link.sent.map(answered)).toEqual([0, 0xe0000000, 0xe0000000]);
  });

  it('refuses the other step\'s finish address, sending nothing for it', async () => {
    const link = fakeLink([request(0xf0000000, 8)]);
    await expect(up.serve(link, image, 0xe0000000, 1000)).rejects.toMatchObject({ code: 'phase' });
    expect(link.sent).toEqual([]);
  });

  it('refuses zero-length requests and finish requests of the wrong length', async () => {
    await expect(up.serve(fakeLink([request(0, 0)]), image, 0xe0000000, 1000)).rejects.toMatchObject({ code: 'badreq' });
    await expect(up.serve(fakeLink([request(0xe0000000, 4)]), image, 0xe0000000, 1000)).rejects.toMatchObject({ code: 'phase' });
  });
});

describe('the flasher\'s MIDI listener', () => {
  it('leaves the port\'s onmidimessage (the editor\'s link) alone', async () => {
    const id = [0x00, 0x59, 0x11, 0, 0, 0, ...Array.from('FM-1_800', (c) => c.charCodeAt(0))];
    const identity = [0xf0, ...pack7([...id, ...new Array(34 - id.length).fill(0)]), 0xf7];
    const listeners = new Set<(ev: { data: Uint8Array }) => void>();
    const editor = (): void => {};
    const input = {
      name: 'Matryoshka', state: 'connected', onmidimessage: editor, open: async () => {},
      addEventListener: (_: string, f: (ev: { data: Uint8Array }) => void) => listeners.add(f),
      removeEventListener: (_: string, f: (ev: { data: Uint8Array }) => void) => listeners.delete(f),
    };
    const output = { name: 'Matryoshka', state: 'connected', open: async () => {}, send: () => setTimeout(() => listeners.forEach((f) => f({ data: new Uint8Array(identity) })), 1) };
    const up = new Updater({ inputs: new Map([['i', input]]), outputs: new Map([['o', output]]) });
    const dev = (await up.find())!;
    expect(dev.id.text).toBe('FM-1_800');
    dev.link.close();
    expect(listeners.size).toBe(0);
    expect(input.onmidimessage).toBe(editor);
  });
});

describe('the unload guard during an install (#147)', () => {
  const leave = (t: EventTarget): boolean => {
    const ev = new Event('beforeunload', { cancelable: true });
    t.dispatchEvent(ev);
    return ev.defaultPrevented;
  };

  it('asks before leaving while armed, not before or after', () => {
    const t = new EventTarget();
    const g = guardUnload(t);
    expect(leave(t)).toBe(false);
    g.arm();
    expect(leave(t)).toBe(true);
    g.disarm();
    expect(leave(t)).toBe(false);
  });
});
