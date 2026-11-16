// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
// The Install panel with two FM-1s on USB (D-965): it lists both, installs only on the FM-1 chosen in the editor, and
// with none chosen it sends nothing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFlashTab } from './flasher';
import { CHOOSE_FIRST, type Fm1Choice } from './fm1-choice';
import { CMD } from './protocol';
import { commands, fakeAccess, fakeFm1, type FakeFm1 } from './test-fm1s';

const HOME = '0123456789ABCDEF0123456789AB0001', RIG = '0123456789ABCDEF0123456789AB7E57';
const UPGRADE = [0xf0, 0x22, 0x24, 0x35, 0x7f, 0xf7];
const stock = readFileSync(join(process.cwd(), 'public/firmware/FM-1_015.fwsc'));   // (vitest runs in web/; jsdom's import.meta.url is no file URL)
/** what the Install panel asks an FM-1 to tell it apart: the handshake (-1), HELLO, DEVICE_SETTINGS, PRESET_GET */
const asks = new Set([-1, CMD.hello, CMD.deviceSettings, CMD.presetGet]);

describe('the Install panel with two FM-1s (D-965)', () => {
  let rig: FakeFm1, home: FakeFm1;
  beforeEach(() => {
    rig = fakeFm1('r', { serial: RIG, rig: true });
    home = fakeFm1('h', { name: 'HOME', serial: HOME });
    const access = fakeAccess(rig, home);
    Object.defineProperty(navigator, 'requestMIDIAccess', { value: async () => access, configurable: true });
    vi.stubGlobal('fetch', async (url: string) => (String(url).includes('FM-1_015.fwsc')
      ? { ok: true, arrayBuffer: async () => stock.buffer.slice(stock.byteOffset, stock.byteOffset + stock.byteLength) }
      : { ok: false }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'requestMIDIAccess');
    document.body.replaceChildren();
  });
  const panel = (choice: Fm1Choice | null) => {
    const root = document.createElement('div');
    document.body.append(root);   // (a checkbox fires change only in the document)
    buildFlashTab(root, () => choice);
    const button = (text: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === text)!;
    const log = () => root.querySelector('pre.log')!.textContent ?? '';
    root.querySelector<HTMLInputElement>('input[id="ack"]')!.click();   // (I understand and accept the risk; two panels share the id)
    return { button, log };
  };
  const upgraded = (p: { sent: number[][] }) => p.sent.some((d) => d.length === UPGRADE.length && d.every((b, i) => b === UPGRADE[i]));

  it('Check the connection lists both and says where an install would go', async () => {
    const none = panel(null);
    none.button('Check the connection').click();
    await vi.waitFor(() => expect(none.log()).toContain('the install buttons send nothing now'));
    expect(none.log()).toContain('Test rig (FM-1_7011100)');
    expect(none.log()).toContain('FM-1 HOME (FM-1_7011100)');
    expect(none.log()).toContain(CHOOSE_FIRST(2));
    const chosen = panel({ serial: HOME, inputId: 'h', label: 'FM-1 HOME', linked: true });
    chosen.button('Check the connection').click();
    await vi.waitFor(() => expect(chosen.log()).toContain('the install buttons install on FM-1 HOME (FM-1_7011100)'));
  });

  it('with none chosen an install sends nothing to either FM-1', async () => {
    const p = panel(null);
    p.button('Return to official V15').click();
    await vi.waitFor(() => expect(p.log()).toContain(`ERROR: nothing was sent: ${CHOOSE_FIRST(2)}`));
    expect(upgraded(rig.o) || upgraded(home.o)).toBe(false);
    for (const out of [rig.o, home.o]) expect(commands(out).every((c) => asks.has(c))).toBe(true);
  });

  it('with one chosen the install goes to it, and the other FM-1 is only asked who it is', async () => {
    const p = panel({ serial: HOME, inputId: null, label: 'FM-1 HOME', linked: false });
    p.button('Return to official V15').click();
    // (the fake FM-1 goes away at the update, as it restarts: the run ends there)
    await vi.waitFor(() => expect(p.log()).toContain('ERROR:'), { timeout: 15000 });
    expect(p.log()).toContain('installing on FM-1 HOME (FM-1_7011100); the other FM-1 is left alone');
    expect(p.log()).toContain('starting the update on FM-1_7011100');
    expect(upgraded(home.o)).toBe(true);
    expect(upgraded(rig.o)).toBe(false);
    expect(commands(rig.o).every((c) => asks.has(c))).toBe(true);
  });
});
