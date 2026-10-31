// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-ignore untyped JS module
import { OPEN_HEAD_SHA256, MVAVE_LOADER_SHA256, OPEN_RELEASES, STOCK_V15_SHA256, V15_HEAD_SHA256, crc16, headIs, headWhich, logicalImage, openPackageProblem, productOf, validateOpenPackage, validateStockPackage, workbenchPackages } from './flasher/fm1pkg.js';
// @ts-ignore untyped JS module
import { Updater, bootMismatch, headProblem, loaderFits, pack7, readHead, unpack7 } from './flasher/fm1ota.js';
import { BOOT_CODE_HELP, BOOT_CODE_IS_OPEN, BOOT_CODE_IS_OTHER, BOOT_CODE_IS_V15, MVAVE_WORKBENCH, OPEN_WHY, guardUnload } from './flasher';

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
    expect(loaderFits('ota-FM-1_015', 'FM-1_8000014')).toBe(true); // Official Open carries M-VAVE's loader (#183)
    expect(loaderFits('ota-FM-1_700', 'FM-1_8000014')).toBe(false);
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
      // firmware that cannot tell its boot code (before #264): head reads go unanswered
      up.find = async () => ({ link: { send: () => true, close: () => {}, drain: () => {}, read: async () => null }, id: { text: 'FM-1_712', model: 'FM-1' } });
      up.serve = async () => ({ served: addrs.length, finished: false, addrs });
      return up.install(new Uint8Array(0), product).catch((e: { code: string }) => e.code);
    };
    expect(await run(refused, 'FM-1_015')).toBe('bootcode');
    expect(await run([0, 512], 'FM-1_015')).toBe('stopped');
    expect(await run(refused, 'FM-1_712')).toBe('stopped');
    expect(await run([0, 512, 472064, 1024], 'FM-1_8000014')).toBe('bootcode');
  }, 10000);

  it('a refusal it cannot explain does not guess which boot code the FM-1 has', () => {
    expect(BOOT_CODE_HELP).toMatch(/update failed -5/);
    expect(BOOT_CODE_HELP).not.toMatch(/Most likely|probably/);
    expect(BOOT_CODE_HELP).toContain('could not be read');
  });

  it('names the way on by the boot code read from the FM-1 (#264)', () => {
    expect(BOOT_CODE_IS_OPEN).toContain(OPEN_RELEASES);
    expect(BOOT_CODE_IS_OPEN).toContain(MVAVE_WORKBENCH);
    expect(BOOT_CODE_IS_OPEN).toContain('MvaveFM1Unbricker');
    expect(BOOT_CODE_IS_OPEN).toContain('F0 22 24 35 7D F7');
    expect(BOOT_CODE_IS_OPEN).toContain('issues/183');
    expect(BOOT_CODE_IS_V15).toContain('Use Return to official V15 instead');
    expect(BOOT_CODE_IS_OTHER).toContain('--save-head');
    expect(BOOT_CODE_IS_OTHER).not.toContain('MvaveFM1Unbricker');
  });

  it('says what the start-up software is before it says boot code', () => {
    for (const t of [BOOT_CODE_HELP, BOOT_CODE_IS_OPEN, BOOT_CODE_IS_V15, BOOT_CODE_IS_OTHER]) {
      expect(t.indexOf('starts the FM-1')).toBeGreaterThan(-1);
      expect(t.indexOf('starts the FM-1')).toBeLessThan(t.indexOf('boot code'));
    }
  });

  it('says why Official Open does not come with the app', () => {
    expect(OPEN_WHY).toMatch(/not open source/);
  });
});

describe('the boot code read from the FM-1 (#264)', () => {
  // as ota.c ota_reply_head: 64 bytes at a time, answered only by firmware that has it
  const device = (head: Uint8Array | null) => {
    const q: number[][] = [];
    return {
      q,
      drain: () => { q.length = 0; },
      read: async () => q.shift() ?? null,
      close: () => {},
      send: (pkt: number[]) => {
        const d = unpack7(pkt.slice(1, -1));
        if (head && d.length === 9 && d[2] === 0x12) {
          const off = d[6] | (d[7] << 8);
          const body = [0, 0x59, 0x12, 66, 0, 0, off & 0xff, off >> 8, ...head.subarray(off, off + 64)];
          body.push(~body.slice(6).reduce((a, b) => a + b, 0) & 0xff);
          q.push([0xf0, ...pack7(body), 0xf7]);
        }
        return true;
      },
    };
  };
  const v15Head = (): Uint8Array => {
    const im = logicalImage(stock());
    const flash = new Uint8Array(0x4000);
    // the V15 package's flash.bin sits where its entry list says; find it by the known head hash instead of parsing
    for (let at = 0; at + 0x4000 <= im.length; at += 0x20) {
      if (createHash('sha256').update(im.subarray(at, at + 0x4000)).digest('hex') === V15_HEAD_SHA256) return im.slice(at, at + 0x4000);
    }
    return flash;
  };

  it('reads the whole boot code, or nothing from firmware that does not tell', async () => {
    const head = new Uint8Array(0x4000).map((_, i) => (i * 7 + 3) & 0xff);
    expect(await readHead(device(head), 5)).toEqual(head);
    expect(await readHead(device(null), 5)).toBeNull();
  });

  it('names a boot code that is not the package\'s', async () => {
    const v15 = v15Head();
    expect(createHash('sha256').update(v15).digest('hex')).toBe(V15_HEAD_SHA256);
    expect(await headProblem(v15, 'FM-1_015')).toBeNull();
    expect(await headProblem(null, 'FM-1_015')).toBeNull();
    expect(await headProblem(v15, 'FM-1_8000014')).toMatchObject({ code: 'bootcode-is-v15' });
    expect(await headProblem(new Uint8Array(0x4000), 'FM-1_015')).toMatchObject({ code: 'bootcode-is-other' });
  });

  // the chip-key block written again in other bytes for `key`, its CRC and its entry's CRCs made to hold (#264)
  const rekey = (head: Uint8Array, key: number, badCrc = false): Uint8Array => {
    const h = head.slice();
    const jl = (b: Uint8Array): void => {
      let k = 0xffff;
      for (let i = 0; i < b.length; i++) (b[i] ^= k & 0xff), (k = ((k << 1) ^ (k & 0x8000 ? 0x1021 : 0)) & 0xffff);
    };
    let off = 32, e = new Uint8Array(32);
    for (; off < 0x400; off += 32) {
      e = h.slice(off, off + 32);
      jl(e);
      if (String.fromCharCode(...e.subarray(16, 30)) === 'isd_config.ini') break;
    }
    const dv = new DataView(e.buffer);
    const blk = dv.getUint32(4, true), size = dv.getUint32(8, true);
    h.fill(0x20, blk, blk + 16);
    for (let i = 0; i < 16; i++) h[blk + 16 + i] = h[blk + 15 - i] ^ ((key >> i) & 1 ? 0x01 : 0xf0);
    new DataView(h.buffer).setUint16(blk + 32, crc16(h.subarray(blk, blk + 32)) ^ (badCrc ? 1 : 0), true);
    dv.setUint16(2, crc16(h.subarray(blk, blk + size)), true);
    dv.setUint16(0, crc16(e.subarray(2, 32)), true);
    jl(e);
    h.set(e, off);
    return h;
  };

  it('a chip-key block written again with the same key is still the same boot code (#264)', async () => {
    const v15 = v15Head(), rk = rekey(v15, 0x980f);
    expect(rk).not.toEqual(v15);
    expect(await headIs(v15, 'v15')).toBe('exact');
    expect(await headIs(rk, 'v15')).toBe('rekeyed');
    expect(await headIs(rekey(v15, 0x990f), 'v15')).toBeNull();
    expect(await headIs(rekey(v15, 0x980f, true), 'v15')).toBeNull();
    const other = rk.slice();
    other[0x1234] ^= 0x5a;
    expect(await headWhich(other)).toBeNull();
    expect(await headProblem(rk, 'FM-1_015')).toBeNull();
    expect(await headProblem(rk, 'FM-1_8000014')).toMatchObject({ code: 'bootcode-is-v15' });
  });

  // FM1_HEAD_FILES=a:b: boot codes (or flash backups) that must count as Official Open's (issue #264's are not ours to ship)
  it.skipIf(!process.env.FM1_HEAD_FILES)("issue #264's boot codes are Official Open's", async () => {
    for (const p of (process.env.FM1_HEAD_FILES ?? '').split(':')) {
      expect(await headWhich(new Uint8Array(readFileSync(p)).slice(0, 0x4000))).toBe('open');
    }
  });

  it('refuses before sending anything', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const up: any = new Updater({ inputs: new Map(), outputs: new Map() });
    const link = device(new Uint8Array(0x4000));
    const sent: number[][] = [];
    const send = link.send;
    link.send = (p: number[]) => (sent.push(p), send(p));
    up.find = async () => ({ link, id: { text: 'FM-1_712', model: 'FM-1' } });
    up.serve = async () => { throw new Error('served'); };
    await expect(up.install(new Uint8Array(0), 'FM-1_015')).rejects.toMatchObject({ code: 'bootcode-is-other', detail: expect.stringMatching(/^SHA-256 [0-9a-f]{64}$/) });
    expect(sent.some((p) => p.length === 6 && p[1] === 0x22)).toBe(false); // never the upgrade command
  });
});

describe("Restore Official Open: the user's own M-VAVE file (#183)", () => {
  const good = { product: 'FM-1_8000014', flashSize: 0x73000, headSha: OPEN_HEAD_SHA256, loaderSha: MVAVE_LOADER_SHA256 };

  it("takes Official Open's identity, M-VAVE's loader, a fitting image and Open's boot code, nothing else", () => {
    expect(openPackageProblem(good)).toBeNull();
    expect(openPackageProblem({ ...good, product: 'FM-1_8000012', flashSize: 0x6f000 })).toBeNull(); // V12
    expect(openPackageProblem({ ...good, product: 'FM-1_015' })).toMatch(/identity/);
    expect(openPackageProblem({ ...good, product: 'FM-1_800' })).toMatch(/identity/); // ours, before #79
    expect(openPackageProblem({ ...good, loaderSha: '0'.repeat(64) })).toMatch(/loader/);
    expect(openPackageProblem({ ...good, flashSize: 0x94000 })).toMatch(/does not fit/);
    expect(openPackageProblem({ ...good, flashSize: 0x73001 })).toMatch(/does not fit/);
    expect(openPackageProblem({ ...good, headSha: V15_HEAD_SHA256 })).toMatch(/V15's/); // never crossed over
    expect(openPackageProblem({ ...good, headSha: '0'.repeat(64) })).toMatch(/boot code/);
  });

  it("refuses the V15, Matryoshka's package and a page without firmware", async () => {
    await expect(validateOpenPackage(stock())).rejects.toThrow(/FM-1_015/);
    const ours = new Uint8Array(readFileSync(new URL('../public/firmware/matryoshka.fwsc', import.meta.url)));
    await expect(validateOpenPackage(ours)).rejects.toThrow(/not M-VAVE Official Open/);
    await expect(validateOpenPackage(new TextEncoder().encode('<!doctype html><p>no firmware here'))).rejects.toThrow(/not an FM-1 package/);
  });

  it('takes a package whose first byte is "<" for a package, not a page', () => {
    const pkg = new Uint8Array([0x3c, 0xe1, 0xd7, 0x42, 0xa7, 0x6e, 0x75, 0xf8, ...new Array(56).fill(0)]);   // CI run 41178937616
    expect(workbenchPackages(pkg)).toEqual([pkg]);
    expect(workbenchPackages(new TextEncoder().encode('\n <!doctype html><p>no firmware here'))).toEqual([]);
  });

  // M-VAVE's files are not in the repository (licence): FM1_OPEN_FILE names a local copy, a .fwsc or the Workbench page
  it.skipIf(!process.env.FM1_OPEN_FILE)("takes M-VAVE's own Official Open", async () => {
    const v = await validateOpenPackage(new Uint8Array(readFileSync(process.env.FM1_OPEN_FILE!)));
    expect(v.product).toMatch(/^FM-1_8\d{6}$/);
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
