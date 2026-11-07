// SPDX-License-Identifier: GPL-3.0-only
// The test rig (#291): the FM-1 that stays on the Mac for npm run device:scenarios. Run from web/:
//   npm run rig -- register     with the rig the ONLY FM-1 connected: mark it (a hidden preset with random values) and
//                               keep the same values in ~/.config/matryoshka/rig.json, with the rig's USB location
//                               (#698: the socket it is plugged into; tools/fm1_usb.py). Again after moving the rig to
//                               another socket or hub port: it keeps the mark and records the new location
//   npm run rig -- check        which connected FM-1 is the rig, whether its firmware has the device test mode, and
//                               whether the FM-1 at the rig's USB location carries the mark
// Both start a dev server of this checkout and Chrome (headless). check sends only HELLO and PRESET_GET, which change
// nothing on any FM-1. --port NAME: look only at the MIDI port of that name (the emulator's, `m1emu serve --name`).
import { chromium } from 'playwright-core';
import { RIG_FILE, fm1Label, loadRig, newMark, rigAtLocation, rigPage, sameMark, saveRig, startEditor, survey, usbDevices } from './rig-link.mjs';

const cmd = process.argv[2];
const portArg = process.argv.indexOf('--port');
const onlyPort = portArg > 0 ? process.argv[portArg + 1] : undefined;
if (cmd !== 'register' && cmd !== 'check') {
  console.error('usage: npm run rig -- register | check');
  process.exit(2);
}

const editor = await startEditor();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let code = 0;
try {
  const context = await browser.newContext();
  await context.grantPermissions(['midi', 'midi-sysex'], { origin: new URL(editor.url).origin });
  if (onlyPort) {
    await context.addInitScript((name) => {
      const orig = navigator.requestMIDIAccess.bind(navigator);
      navigator.requestMIDIAccess = async (o) => {
        const a = await orig(o);
        const keep = (m) => new Map([...m].filter(([, p]) => p.name === name));
        return { get inputs() { return keep(a.inputs); }, get outputs() { return keep(a.outputs); }, sysexEnabled: a.sysexEnabled, onstatechange: null };
      };
    }, onlyPort);
  }
  const page = await rigPage(context, editor.url);
  const s = await survey(page);
  const TEST = 512;   // INFO feature bit 9 (protocol.ts FEATURE_TEST)
  const fw = (p) => `${fm1Label(p)}, device test mode ${p.info && p.info.features & TEST ? 'yes' : 'no (install a firmware that has it)'}`;
  if (cmd === 'check') {
    if (!s.pairs.length) console.log('no FM-1 answered');
    for (const p of s.pairs) console.log(`${p === s.rig ? 'RIG  ' : 'other'} ${fw(p)}`);
    if (!loadRig()) console.log(`no rig registered (${RIG_FILE})`);
    else if (!s.rig) console.log('the registered rig is not connected');
    else {
      const at = rigAtLocation();
      console.log(at.ok ? `the rig's USB location ${at.location}: the FM-1 there carries the mark (installs and recordings may go there)`
        : `the rig's USB location: ${at.why}; installs need the rig to be the one FM-1 connected and recordings skip while another is`);
    }
    code = s.rig ? 0 : 1;
  } else {
    if (s.ports !== 1 || s.pairs.length !== 1) {
      console.error(`${s.ports} FM-1 ports are connected (${s.pairs.length} answered): connect the rig ALONE to register it`);
      code = 1;
    } else {
      const p = s.pairs[0];
      // the rig's USB socket: the one FM-1 CoreMIDI has online (no FM-1 has a USB serial number; the location names the socket)
      const fm1s = usbDevices().filter((d) => d.fm1);
      if (fm1s.length !== 1) throw new Error(`${fm1s.length} FM-1s are on USB (${fm1s.map((d) => d.location).join(', ') || 'none'}): connect the rig ALONE to register it`);
      const usbLocation = fm1s[0].location;
      const had = loadRig()?.values;
      const values = had && sameMark(p.mark, had) ? had : newMark();
      await page.evaluate(([x, v]) => window.__rig.mark(x, v), [p, values]);
      const back = await page.evaluate((x) => window.__rig.markOf(x), p);
      if (!sameMark(back, values)) throw new Error('the mark did not read back');
      saveRig(values, usbLocation);
      const at = rigAtLocation();   // (the mark read again through the location, as the installer will)
      if (!at.ok) throw new Error(`the mark did not read back at USB location ${usbLocation}: ${at.why}`);
      console.log(`registered ${p.name} as the test rig (${fw(p)}) at USB location ${usbLocation}; its mark and location are in ${RIG_FILE}`);
      console.log('keep it plugged in; npm run device:scenarios drives it and leaves any other FM-1 alone');
    }
  }
} catch (e) {
  console.error(e.message ?? e);
  code = 1;
} finally {
  await browser.close();
  editor.stop();
}
process.exit(code);
