// SPDX-License-Identifier: GPL-3.0-only
// The test rig (#291): the FM-1 that stays on the Mac for npm run device:scenarios. Run from web/:
//   npm run rig -- register     with the rig the ONLY FM-1 connected: mark it (a hidden preset with random values) and
//                               keep the same values in ~/.config/matryoshka/rig.json
//   npm run rig -- check        which connected FM-1 is the rig, and whether its firmware has the device test mode
// Both start a dev server of this checkout and Chrome (headless). check sends only HELLO and PRESET_GET, which change
// nothing on any FM-1. --port NAME: look only at the MIDI port of that name (the emulator's, `m1emu serve --name`).
import { chromium } from 'playwright-core';
import { RIG_FILE, loadRig, newMark, rigPage, sameMark, saveRig, startEditor, survey } from './rig-link.mjs';

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
  const fw = (p) => `firmware ${p.info?.version ?? '?'}, device test mode ${p.info && p.info.features & TEST ? 'yes' : 'no (install a firmware that has it)'}`;
  if (cmd === 'check') {
    if (!s.pairs.length) console.log('no FM-1 answered');
    for (const p of s.pairs) console.log(`${p === s.rig ? 'RIG  ' : 'other'} ${p.name}: ${fw(p)}`);
    if (!loadRig()) console.log(`no rig registered (${RIG_FILE})`);
    else if (!s.rig) console.log('the registered rig is not connected');
    code = s.rig ? 0 : 1;
  } else {
    if (s.ports !== 1 || s.pairs.length !== 1) {
      console.error(`${s.ports} FM-1 ports are connected (${s.pairs.length} answered): connect the rig ALONE to register it`);
      code = 1;
    } else {
      const p = s.pairs[0];
      const had = loadRig()?.values;
      const values = had && sameMark(p.mark, had) ? had : newMark();
      await page.evaluate(([x, v]) => window.__rig.mark(x, v), [p, values]);
      const back = await page.evaluate((x) => window.__rig.markOf(x), p);
      if (!sameMark(back, values)) throw new Error('the mark did not read back');
      saveRig(values);
      console.log(`registered ${p.name} as the test rig (${fw(p)}); its mark is in ${RIG_FILE}`);
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
