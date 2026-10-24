// SPDX-License-Identifier: GPL-3.0-only
// Install panel (Get started > Install firmware). The USB-MIDI update protocol and package handling come from Felucca
// (src/flasher/fm1ota.js, fm1pkg.js; Copyright (C) 2026 Leo Kuroshita, GPL-3.0-only).
// @ts-ignore untyped JS modules
import { Updater, STOCK_PRODUCT } from './flasher/fm1ota.js';
// @ts-ignore untyped JS modules
import { logicalImage, productOf, validateStockPackage } from './flasher/fm1pkg.js';
import { FELUCCA_WARNING, firmwareKind, runsFelucca } from './felucca-store';

/** the start-up software, said plainly first: the first 16 KB of the FM-1's memory (flash 0x0000–0x3FFF) */
const STARTUP = 'the small piece of software at the start of its memory that starts the FM-1 when you switch it on (its boot code)';

/** why Official Open will not come with the app (fm1_open's THIRD_PARTY.md allows passing the engine on inside FM-1
 *  firmware; Matryoshka ships only open-source files) */
export const OPEN_WHY =
  "Official Open includes M-VAVE's own sound engine, which is not open source. M-VAVE's licence would allow passing it " +
  'on, but Matryoshka ships only open-source files, so you will download it from M-VAVE yourself.';

/** #183: the running firmware refused the official V15 because its start-up part differs from the package's
 *  (fm1ota.js bootMismatch). The only other one known is Official Open's. Putting Open back, or crossing back to V15,
 *  needs a later firmware (not offered here before then); the last resort is the chip's repair mode. */
export const BOOT_CODE_HELP =
  `Nothing was changed: the FM-1 refused the official V15 (its screen says "update failed -5"), because ${STARTUP} is not ` +
  "V15's. It still runs its firmware. Most likely it was set up by M-VAVE's Official Open. The safe way on is to keep " +
  'Matryoshka. A later Matryoshka firmware will let this page put Official Open back, or go back to V15 after a warning ' +
  `(issue #183). ${OPEN_WHY} As a last resort today: put the FM-1 in the chip's own repair mode (from Matryoshka, the ` +
  "SysEx F0 22 24 35 7D F7) and write V15's firmware part (0x4000–0x92FFF) with MvaveFM1Unbricker; that leaves the " +
  'start-up part as it is. Details: https://github.com/glvno/matryoshka/issues/183';

const ERRORS: Record<string, string> = {
  notfound: 'FM-1 not found. Check the USB data cable and close other apps that use the MIDI port.',
  model: 'This package is for a different device.',
  stopped: 'The device stopped answering. Nothing was written if this happened in the check step.',
  noloader: 'The update loader did not appear. Replug USB and press Install again; the device stays in update mode.',
  lost: 'The device was disconnected. Replug USB and press Install again to finish.',
  noreturn: 'The device did not come back: power-cycle it.',
  mismatch: 'Written, but the device reports a different identity.',
  badreq: 'The device asked for data outside the package.',
  phase: 'The device asked to finish a step other than the one running. Nothing more was sent.',
  felucca: 'Nothing was sent. Read the note above Install, tick its box and press Install again.',
  bootcode: BOOT_CODE_HELP,
};

/** an interrupted write can only be finished with a package the waiting loader may write (fm1ota.js loaderFits) */
function otherLoader(loader: string): string {
  if (loader === 'ota-' + STOCK_PRODUCT) return `The FM-1 waits in M-VAVE's update loader (${loader}) from an unfinished return to stock. Finish it with Return to official V15; nothing else may be written by that loader.`;
  if (/^ota-FM-1_[789]\d\d$/.test(loader)) return `The FM-1 waits in a Felucca-type update loader (${loader}) from an unfinished install. Finish it with Install Matryoshka or the package you were installing; the official V15 cannot be written by it.`;
  return `The FM-1 waits in an update loader this page does not know (${loader}). Nothing was written. Finish that update with the tool that started it.`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) e.className = String(cls);
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

/** M-VAVE's stock V15 in web/public/firmware (Apache-2.0, NOTICE-FM-1_015.txt next to it) */
const STOCK_FILE = 'FM-1_015.fwsc';

async function readFile(f: File): Promise<Uint8Array> {
  return new Uint8Array(await f.arrayBuffer());
}

/** the firmware package that comes with this copy of the app (web/public/firmware, made by `npm run firmware`) */
interface Bundle {
  version: string;
  product: string;
  size: number;
  sha256: string;
  /** the dev server's branch build (dev/branch-firmware.ts): where it comes from */
  dev?: string;
  /** set while it cannot be installed yet (the dev server's smoke test running or failed): why */
  wait?: string;
}

async function loadBundle(): Promise<Bundle | null> {
  try {
    const r = await fetch('./firmware/matryoshka.json', { cache: 'no-cache' });
    if (!r.ok) return null;
    const b = (await r.json()) as Bundle; // a dev server answers a missing file with the page itself: that is not JSON
    return b && typeof b.version === 'string' && typeof b.product === 'string' ? b : null;
  } catch {
    return null;
  }
}

/** a `beforeunload` guard for the length of an install (#147): closing, reloading or leaving the page then asks first.
 *  Disarmed otherwise, so the page can still use the back-forward cache. */
export function guardUnload(target: EventTarget): { arm(): void; disarm(): void } {
  const stop = (event: Event): void => {
    event.preventDefault();
    // older browsers want returnValue set too; a plain Event (as in tests) has it read-only
    if (typeof BeforeUnloadEvent !== 'undefined' && event instanceof BeforeUnloadEvent) event.returnValue = '';
  };
  return {
    arm: () => target.addEventListener('beforeunload', stop),
    disarm: () => target.removeEventListener('beforeunload', stop),
  };
}

export function buildFlashTab(root: HTMLElement): void {
  const logEl = el('pre', { class: 'log', textContent: 'Ready.\n' });
  const bar = el('progress', { max: 100, value: 0 });
  // shown while an install runs: browsers give only a generic text for beforeunload
  const keepOpen = el('p', { class: 'muted', hidden: true, textContent: 'Installing: keep this tab open. If it is closed, open Install firmware again and press the same button to finish.' });
  const unload = guardUnload(window);
  const log = (s: string): void => {
    logEl.textContent += s + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  };
  let busy = false;
  let bundle: Bundle | null = null;

  const ack = el('input', { type: 'checkbox', id: 'ack' });
  // installing over Felucca (#73): shown once the FM-1 reports a Felucca identity, needed for any non-stock install then
  const feluccaAck = el('input', { type: 'checkbox', id: 'ack-felucca' });
  const feluccaNote = el('div', { class: 'card warn', hidden: true }, el('h2', { textContent: 'Felucca projects, samples and presets' }), el('p', { textContent: FELUCCA_WARNING }), el('label', {}, feluccaAck, ' I have saved what I need: install anyway'));
  // an FM-1 on anything but the official V15 or Matryoshka (#161): a recommendation, nothing is blocked
  const foreignNote = el('div', { class: 'card warn', hidden: true });
  const noteForeign = (identity: string): void => {
    const kind = firmwareKind(identity);
    foreignNote.hidden = kind === 'stock' || kind === 'matryoshka';
    if (foreignNote.hidden) return;
    const text = `This FM-1 runs ${identity}. Returning to official V15 first is recommended.`;
    foreignNote.replaceChildren(el('p', { textContent: `${text} Press Return to official V15, check that it boots, then install Matryoshka.` }));
    log(text);
  };
  const accepted = (): boolean => ack.checked;
  const supported = 'requestMIDIAccess' in navigator;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const access = async (): Promise<any> => new Updater(await navigator.requestMIDIAccess({ sysex: true }), log);

  /** every button's action; `installs` (the four install runs, not Check the connection) guards the page against
   *  closing until the run ends */
  const run = async (name: string, fn: () => Promise<void>, installs = false): Promise<void> => {
    if (busy) return;
    busy = true;
    setButtons();
    if (installs) {
      unload.arm();
      keepOpen.hidden = false;
    }
    bar.value = 0;
    log(`\n— ${name}`);
    try {
      await fn();
    } catch (e) {
      const err = e as Error & { code?: string; detail?: string };
      if (err.code === 'otherloader') log(`ERROR: ${otherLoader(err.detail ?? '')}`);
      else log(`ERROR: ${(err.code && ERRORS[err.code]) || err.message}${err.detail ? ` (${err.detail})` : ''}`);
    } finally {
      unload.disarm();
      keepOpen.hidden = true;
      busy = false;
      setButtons();
    }
  };

  const step = (kind: string, a?: unknown): void => {
    if (kind === 'start') log(`starting the update on ${a}`);
    else if (kind === 'verify') {
      if (Number(a) === 1) log('checking the package…');
    } else if (kind === 'loader') log('switching to update mode');
    else if (kind === 'write') bar.value = Math.min(99, Number(a) / 20);
    else if (kind === 'reboot') (bar.value = 100), log('restarting');
    else if (kind === 'done') log(`done: the FM-1 runs ${a}`);
  };

  /** install an image; if an earlier install was cut off (the FM-1 sits in an update loader) finish that write
   *  instead, but only when that loader may write this package (otherwise an 'otherloader' error, nothing sent) */
  const installImage = async (image: Uint8Array, product: string): Promise<void> => {
    const up = await access();
    if (await up.resume(image, step, product)) {
      log('an earlier update was unfinished: it is finished now');
      return;
    }
    await up.install(image, product, step);
  };

  /** asks the running FM-1 who it is: a foreign firmware gets the return-to-stock note, and over Felucca the install
   *  waits for feluccaAck (an update loader is not asked: a cut-off write is finished as before) */
  const overFelucca = async (): Promise<void> => {
    const dev = await (await access()).find((id: { model: string }) => !/^ota-/i.test(id.model));
    if (!dev) return; // install() reports a missing device itself
    dev.link.close();
    noteForeign(dev.id.text);
    if (!runsFelucca(dev.id.text)) return;
    feluccaNote.hidden = false;
    feluccaNote.scrollIntoView({ block: 'nearest' });
    if (!feluccaAck.checked) throw Object.assign(new Error('felucca'), { code: 'felucca', detail: dev.id.text });
    log(`installing over Felucca (${dev.id.text}): its projects and samples in the shared sectors will be overwritten`);
  };

  const install = async (raw: Uint8Array): Promise<void> => {
    const product = productOf(raw);
    log(`package: ${product}, ${raw.length} bytes`);
    const mark = new TextEncoder().encode('FELUCCA-LOADER-1');
    if (!raw.some((_: number, i: number) => i < raw.length - mark.length && mark.every((b, k) => raw[i + k] === b))) throw new Error('this package has no update loader; refusing to install it');
    if (product === STOCK_PRODUCT) throw new Error('this is the official V15: use Return to stock');
    await overFelucca();
    await installImage(logicalImage(raw), product);
  };

  // ---- Matryoshka
  const installBtn = el('button', { textContent: 'Install Matryoshka firmware', class: 'primary' });
  const bundleInfo = el('p', { class: 'muted', textContent: 'Looking for the firmware package…' });
  installBtn.onclick = () =>
    run('install Matryoshka', async () => {
      if (!bundle) throw new Error('no firmware package is bundled with this copy of the app');
      const r = await fetch(`./firmware/matryoshka.fwsc?v=${bundle.sha256}`, { cache: 'no-cache' });
      if (!r.ok) throw new Error('the bundled firmware package could not be loaded');
      const raw = new Uint8Array(await r.arrayBuffer());
      const sum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)), (b) => b.toString(16).padStart(2, '0')).join('');
      if (sum !== bundle.sha256) throw new Error('the bundled firmware package does not match its checksum');
      await install(raw);
    }, true);
  const showBundle = (b: Bundle | null): void => {
    bundle = b;
    const what = b && `${/^matryoshka/i.test(b.version) ? b.version : `Matryoshka ${b.version}`} (${b.product}, ${Math.round(b.size / 1024)} KB)`;
    bundleInfo.textContent = !b
      ? 'No firmware package comes with this copy of the app. Run npm run firmware -- --ci in web/ (the newest CI build) and reload; or choose a .fwsc file below.'
      : b.dev
        ? `${b.size ? `${what}: ` : ''}${b.dev}.${b.wait ? ` ${b.wait}` : ''}`
        : `${what} comes with this app. GPL-3.0; three JieLi SDK files inside are Apache-2.0.`;
    setButtons();
    // (the dev server's smoke test: asked again until it is done)
    if (b?.wait && /running/.test(b.wait)) setTimeout(() => void loadBundle().then(showBundle), 5000);
  };
  void loadBundle().then(showBundle);

  const findBtn = el('button', { textContent: 'Check the connection' });
  findBtn.onclick = () =>
    run('find device', async () => {
      const dev = await (await access()).find();
      if (!dev) throw Object.assign(new Error('not found'), { code: 'notfound' });
      log(`${dev.id.text}  [${/^ota-/i.test(dev.id.model) ? 'update loader: an update was not finished' : 'running'}]  port: ${dev.name}`);
      dev.link.close();
      if (/^ota-/i.test(dev.id.model)) return;
      noteForeign(dev.id.text);
      if (runsFelucca(dev.id.text)) (feluccaNote.hidden = false), log('this FM-1 runs Felucca: read the note about its projects and samples before installing');
    });

  // ---- another package
  const pkgFile = el('input', { type: 'file', accept: '.fwsc' });
  const pkgBtn = el('button', { textContent: 'Install this package' });
  pkgBtn.onclick = () =>
    run('install package', async () => {
      const f = pkgFile.files?.[0];
      if (!f) throw new Error('choose a .fwsc package first');
      await install(await readFile(f));
    }, true);

  // ---- return to stock: M-VAVE's V15 comes with the app (Apache-2.0, from m-vave/fm1_open); validateStockPackage checks
  // its size, SHA-256 and layout before anything is sent, for the bundled file and for one the user picks alike
  const returnToStock = async (raw: Uint8Array): Promise<void> => {
    const v = await validateStockPackage(raw);
    log(`package: ${v.product}, ${raw.length} bytes, SHA-256 checked`);
    await installImage(v.image, v.product); // also finishes a return to stock that was cut off
  };
  const stockBtn = el('button', { textContent: 'Return to official V15' });
  stockBtn.onclick = () =>
    run('return to official V15', async () => {
      const r = await fetch(`./firmware/${STOCK_FILE}`, { cache: 'no-cache' });
      if (!r.ok) throw new Error('the bundled official V15 could not be loaded: use your own FM-1.fwsc below');
      await returnToStock(new Uint8Array(await r.arrayBuffer()));
    }, true);
  const stockOnly = el('input', { type: 'file', accept: '.fwsc' });
  const stockFileBtn = el('button', { textContent: 'Return with this file' });
  stockFileBtn.onclick = () =>
    run('return to official V15 (your file)', async () => {
      const f = stockOnly.files?.[0];
      if (!f) throw new Error('choose the unmodified official FM-1.fwsc');
      await returnToStock(await readFile(f));
    }, true);

  function setButtons(): void {
    findBtn.disabled = busy || !supported;
    installBtn.disabled = busy || !supported || !accepted() || !bundle || !!bundle.wait;
    for (const b of [pkgBtn, stockBtn, stockFileBtn]) b.disabled = busy || !supported || !accepted();
  }
  ack.onchange = setButtons;

  const card = (title: string, ...kids: (Node | string)[]): HTMLElement => el('div', { class: 'card' }, el('h2', { textContent: title }), ...kids);

  const licences = el('p', { class: 'muted' }, 'Licences: ', el('a', { href: './firmware/LICENSE-GPL-3.0.txt', textContent: 'GPL-3.0' }), ', ', el('a', { href: './firmware/LICENSE-Apache-2.0.txt', textContent: 'Apache-2.0' }), '. Source: ', el('a', { href: 'https://github.com/glvno/matryoshka', textContent: 'Matryoshka source' }), '.');
  const list = (...items: string[]): HTMLElement => el('ul', {}, ...items.map((t) => el('li', { textContent: t })));
  /** a collapsed detail of the warning: its title, opened on a click */
  const more = (title: string, ...kids: Node[]): HTMLElement => el('details', { class: 'flash-more' }, el('summary', { textContent: title }), ...kids);

  root.replaceChildren(
    ...(supported ? [] : [el('div', { class: 'card warn', textContent: 'Web MIDI with SysEx is needed: use Chrome, Edge or Firefox over https (or localhost).' })]),
    el(
      'div',
      { class: 'card warn' },
      el('h2', { textContent: 'Before you flash' }),
      el('p', {
        textContent:
          'Flashing replaces the FM-1 firmware. You can always go back with Return to official V15 below. If the FM-1 runs Felucca, Sloop or another build, return to stock first. Keep the USB cable connected and this page open until it says done.',
      }),
      more(
        'If an install is cut off',
        el('p', { textContent: 'The FM-1 has one firmware slot and no rollback. A cut-off install leaves it waiting in its update loader: press the same button again to finish (Install for Matryoshka, Return to official V15 for a return to stock; this page refuses the wrong one).' }),
      ),
      more(
        'What has been tested on a real FM-1',
        el('p', { class: 'muted', textContent: 'With this page and with tools/fm1_install.py (the same update protocol):' }),
        list(
          'installing Matryoshka over the official V15, and over Matryoshka;',
          'update mode (OCT- + OCT+ at power-on, or MENU > SYSTEM > UPDATE MODE) and an install from there;',
          'returning to the official V15 and back; the official firmware boots, plays and saves;',
          'a write cut off at 30 %: the same install run again finishes it;',
          'safe mode (SAVE held at power-on), the boot guard and FACTORY RESET.',
        ),
        el('p', { class: 'muted', textContent: 'Partly: a power cut as the update loader started, and one halfway through a write of the same build; both booted.' }),
        el('p', { class: 'muted', textContent: 'Not tested: a power cut while the firmware is half old and half new; installing over Felucca, Sloop or M-VAVE Open.' }),
      ),
      more(
        'Coming from Felucca',
        el('p', { textContent: 'Matryoshka stores its patches where Felucca keeps its projects, samples and user presets, and overwrites them on its first start. Save them with Felucca first; this page asks again when it sees Felucca.' }),
      ),
      more(
        'Chromium on Linux',
        el('p', { textContent: 'The FM-1 disconnects and comes back several times during an install. Chromium on Linux can close the whole browser when that happens (a bug in its MIDI backend): close other tabs first, or install with tools/fm1_install.py.' }),
      ),
      el('label', {}, ack, ' I understand and accept the risk'),
    ),
    foreignNote,
    feluccaNote,
    card('Install Matryoshka', bundleInfo, el('div', { class: 'row' }, installBtn, findBtn), licences),
    card(
      'Return to stock',
      el('p', { class: 'muted', textContent: "M-VAVE's official firmware V15 comes with this app; its size and checksum are checked before it is sent." }),
      el('div', { class: 'row' }, stockBtn),
      el('p', { class: 'muted' }, 'FM-1_015.fwsc © M-VAVE, ', el('a', { href: './firmware/LICENSE-Apache-2.0.txt', textContent: 'Apache-2.0' }), ' (', el('a', { href: './firmware/NOTICE-FM-1_015.txt', textContent: 'notice' }), ', ', el('a', { href: 'https://github.com/m-vave/fm1_open', textContent: 'source' }), '). Matryoshka is not affiliated with M-VAVE.'),
      el('details', {}, el('summary', { textContent: 'Use your own copy' }), el('p', { class: 'muted', textContent: 'The unmodified official FM-1.fwsc (V15); anything else is refused.' }), el('div', { class: 'row' }, stockOnly, stockFileBtn)),
    ),
    el(
      'details',
      { class: 'card' },
      el('summary', { textContent: 'Install another package' }),
      el('p', { class: 'muted', textContent: 'A finished .fwsc from tools/build.py (it must carry the update loader).' }),
      el('div', { class: 'row' }, pkgFile, pkgBtn),
    ),
    el('div', { class: 'card' }, bar, keepOpen, logEl),
  );
  setButtons();
}
