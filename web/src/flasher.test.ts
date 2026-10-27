// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-ignore untyped JS module
import { STOCK_V15_SHA256, logicalImage, productOf, validateStockPackage } from './flasher/fm1pkg.js';
// @ts-ignore untyped JS module
import { Updater, bootMismatch, loaderFits, pack7, unpack7 } from './flasher/fm1ota.js';
import { BOOT_CODE_HELP, OPEN_WHY, guardUnload } from './flasher';

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

describe('bundled Matryoshka firmware (#161)', () => {
  it('matryoshka.json names the package it sits next to', () => {
    const raw = new Uint8Array(readFileSync(new URL('../public/firmware/matryoshka.fwsc', import.meta.url)));
    const json = JSON.parse(readFileSync(new URL('../public/firmware/matryoshka.json', import.meta.url), 'utf8'));
    expect(productOf(raw)).toBe(json.product);
    expect(json.product).toMatch(/^FM-1_7\d\d$/);
    expect(json.size).toBe(raw.length);
    expect(json.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
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
    expect(await up.serve(link, image, 0xe0000000, 1000)).toEqual({ served: 1, finished: true, addrs: [0] });
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

describe('a boot code that is not V15\'s (#183)', () => {
  // what issue #183's FM-1 asked for before it went silent ("update failed -5" on its screen)
  const refused = [0, 512, 679680, 1024];

  it('is told by the reads: the entry list, the loader\'s header, then the head below it', () => {
    expect(bootMismatch(refused)).toBe(true);
    expect(bootMismatch([0, 512, 679680, 1024, 1536])).toBe(true);           // refused at a later head block
    expect(bootMismatch([0, 512, 679680, 679712])).toBe(false);              // head equal: staging the loader
    expect(bootMismatch([0, 512, 679680])).toBe(false);
    expect(bootMismatch([])).toBe(false);
  });

  it('serving the official V15 records those reads in order', async () => {
    const image = logicalImage(stock());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const up: any = new Updater({ inputs: new Map(), outputs: new Map() });
    const r = await up.serve(fakeLink(refused.map((a) => request(a, 512))), image, 0xe0000000, 0);
    expect(r).toMatchObject({ served: 4, finished: false, addrs: refused });
  });

  it('a return to V15 that stops so ends with the bootcode error, other stops stay generic', async () => {
    const run = async (addrs: number[], product: string): Promise<unknown> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const up: any = new Updater({ inputs: new Map(), outputs: new Map() });
      up.find = async () => ({ link: { send: () => true, close: () => {} }, id: { text: 'FM-1_712', model: 'FM-1' } });
      up.serve = async () => ({ served: addrs.length, finished: false, addrs });
      return up.install(new Uint8Array(0), product).catch((e: { code: string }) => e.code);
    };
    expect(await run(refused, 'FM-1_015')).toBe('bootcode');
    expect(await run([0, 512], 'FM-1_015')).toBe('stopped');
    expect(await run(refused, 'FM-1_712')).toBe('stopped');
  });

  it('the Install panel explains it and names the way back', () => {
    expect(BOOT_CODE_HELP).toMatch(/update failed -5/);
    expect(BOOT_CODE_HELP).toContain('F0 22 24 35 7D F7');
    expect(BOOT_CODE_HELP).toContain('MvaveFM1Unbricker');
    expect(BOOT_CODE_HELP).toContain('issues/183');
  });

  it('says plainly what the start-up software is before it says boot code, and why Official Open is not shipped', () => {
    expect(BOOT_CODE_HELP.indexOf('starts the FM-1')).toBeGreaterThan(-1);
    expect(BOOT_CODE_HELP.indexOf('starts the FM-1')).toBeLessThan(BOOT_CODE_HELP.indexOf('boot code'));
    expect(BOOT_CODE_HELP).toContain("Most likely it was set up by M-VAVE's Official Open");
    expect(BOOT_CODE_HELP).toContain(OPEN_WHY);
    expect(OPEN_WHY).toMatch(/not open source/);
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
