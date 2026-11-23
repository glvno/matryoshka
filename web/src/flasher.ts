// SPDX-License-Identifier: GPL-3.0-only
// Install panel (Get started > Install firmware). The USB-MIDI update protocol and package handling come from Felucca
// (src/flasher/fm1ota.js, fm1pkg.js; Copyright (C) 2026 Leo Kuroshita, GPL-3.0-only).
// @ts-ignore untyped JS modules
import { Updater, STOCK_PRODUCT } from './flasher/fm1ota.js';
// @ts-ignore untyped JS modules
import { OPEN_RELEASES, logicalImage, productOf, validateOpenPackage, validateStockPackage } from './flasher/fm1pkg.js';
import { FELUCCA_WARNING, firmwareKind, runsFelucca } from './felucca-store';
import { runningVersion, updateOffer } from './fm1-version';
import { type MvaveTarget, TARGET_NAME, WHICH_TARGET, rememberTarget, targetGuard } from './mvave-target';
import { BANK_SLOTS, CMD, editorSkips, FEATURE_FACTORY, helloFrame, parse, parseInfo, parseSlot, readStoredPattern, slotCount, slotEraseFrame, slotInfoFrame, slotLabel, type SlotInfo } from './protocol';
import { factoryInfo, fetchFactoryImage, installFactory, linkAsk, loadFactorySets, pickSet, type Ask } from './factory-content';
import { fm1Label, installPlan, OTHER_CHANGED, readFm1Id, type Fm1Choice, type FoundFm1, type InstallPlan } from './fm1-choice';
import { BACKUP_TEXT, bankBackup, bankPlan, movesText, needsBankCheck, OLDER_FIRMWARE_TEXT, packageBeforeStore, packageHasSmallBank, slotList, storesEveryPattern, tooManyText, type BankBackup } from './install-bank';
import { bankCandidates, knownCopy } from './bank';
import { backupFile } from './migrate';
import { savePatch } from './saved';

/** the Install panel's factory sounds box (#915): ticked by default; unticked, this warning shows */
export const FACTORY_LABEL = ' Install factory instruments and presets (recommended)';
export const FACTORY_WARNING =
  'Without them the FM-1 plays only the patches built into the firmware, has no factory presets, and says FACTORY SOUNDS MISSING when it starts. ' +
  'The editor offers them again whenever the FM-1 connects; patches you edited and saved are never touched.';

/** the Install panel's one bar for an install with the factory sounds ticked: the firmware write fills it to
 *  `write` (~600 KB served over the update loader, about 2,000 requests: the `write` step's count), the FM-1's restart
 *  and return hold it there until `back`, and the factory image (~50 KB: about 200 page writes of 256 bytes over the
 *  editor link, each awaiting its flash write, about a tenth of the requests) fills the rest. */
export const INSTALL_SHARE = { write: 80, back: 86 } as const;

export interface InstallMeter {
  /** the firmware write: `n` requests served so far */
  write(n: number): void;
  /** the write is done, the FM-1 restarts */
  restart(): void;
  /** the FM-1 runs the new firmware */
  back(): void;
  /** the factory content: `done` of `total` pages */
  factory(done: number, total: number): void;
  /** the whole install finished (with the factory sounds: their commit acknowledged, or nothing to install) */
  done(): void;
}

/** progress for one install, shown by `show(percent, step)`: never backwards; with `factory` (the box ticked when
 *  Install was pressed) 100 % only at `done()`, unticked the firmware alone fills the bar */
export function installMeter(show: (value: number, step: string) => void, factory: boolean): InstallMeter {
  let at = 0;
  const to = (v: number, step: string): void => show((at = Math.max(at, v)), step);
  const top = factory ? INSTALL_SHARE.write : 100;
  const first = factory ? 'Step 1 of 2: installing the firmware' : 'Installing the firmware';
  return {
    write: (n) => to((Math.min(99, n / 20) * top) / 100, first),
    restart: () => to(top, `${first}: the FM-1 restarts`),
    back: () => to(factory ? INSTALL_SHARE.back : 100, factory ? 'Step 2 of 2: installing the factory instruments and presets' : 'Done'),
    factory: (done, total) => to(Math.min(99, INSTALL_SHARE.back + ((100 - INSTALL_SHARE.back) * done) / total), 'Step 2 of 2: installing the factory instruments and presets'),
    done: () => to(100, 'Done'),
  };
}

/** why Official Open does not come with the app (fm1_open's THIRD_PARTY.md allows passing the engine on inside FM-1
 *  firmware; Matryoshka ships only open-source files) */
export const OPEN_WHY =
  "Official Open includes M-VAVE's own sound engine, which is not open source. M-VAVE's licence would allow passing it " +
  'on, but Matryoshka ships only open-source files, so you download it from M-VAVE yourself.';

/** where the README tells how to get an FM-1 back whose start-up software was cut off mid-write (#183) */
export const REPAIR_URL = 'https://github.com/glvno/matryoshka#if-going-back-to-v15-was-cut-off';

/** the start-up software, said plainly first: the first 16 KB of the FM-1's memory (flash 0x0000–0x3FFF) */
const STARTUP = 'the small piece of software at the start of its memory that starts the FM-1 when you switch it on (its boot code)';

/** the last resort when neither M-VAVE package is taken: the firmware part written in the chip's repair mode */
const ROM_BOOT =
  "As a last resort: put the FM-1 in the chip's own repair mode (from Matryoshka, the SysEx F0 22 24 35 7D F7) and write " +
  "V15's firmware part (0x4000–0x92FFF) with MvaveFM1Unbricker; that leaves the start-up part as it is. Details: " +
  'https://github.com/glvno/matryoshka/issues/183';

/** M-VAVE's own web page, which installs the V15 from Official Open (that rewrites the start-up part: M-VAVE's call) */
export const MVAVE_WORKBENCH = 'https://open.m-vave.com/fm1-workbench';

/** #183: the running firmware refused an M-VAVE package because its start-up part differs from the package's
 *  (fm1ota.js bootMismatch). Firmware before Matryoshka 1.7 cannot tell which one it has (#264), so this does not guess. */
export const BOOT_CODE_HELP =
  `Nothing was changed: the FM-1 refused this package (its screen says "update failed -5"), because ${STARTUP} is not ` +
  'the one inside it. It still runs its firmware. Which one it has could not be read: install the current Matryoshka, ' +
  'then try again, and this page will say which one it is.';

/** #264, read before sending: the FM-1 has Official Open's start-up part, the package is the V15. Restore Official Open;
 *  from Official Open, M-VAVE's own Workbench goes back to V15. */
export const BOOT_CODE_IS_OPEN =
  `Nothing was sent: ${STARTUP} is Official Open's, and the official V15 carries a different one, so the FM-1 would ` +
  'refuse it ("update failed -5"). Two safe ways on: keep Matryoshka, or put Official Open back with Restore Official ' +
  `Open below (M-VAVE's file: ${OPEN_RELEASES}). If you then want V15, use M-VAVE's own Workbench ` +
  `(${MVAVE_WORKBENCH}) while the FM-1 runs Official Open. ${ROM_BOOT}`;

/** the reverse: the FM-1 has V15's start-up part, the package is Official Open */
export const BOOT_CODE_IS_V15 =
  `Nothing was sent: ${STARTUP} is V15's, and Official Open carries a different one, so the FM-1 would refuse it ` +
  '("update failed -5"). Use Return to official V15 instead. To get Official Open on it, install Open with ' +
  "M-VAVE's own Workbench while the FM-1 runs V15.";

/** neither known start-up part: nothing of M-VAVE's may be written over it; we want to see it */
export const BOOT_CODE_IS_OTHER =
  `Nothing was sent: ${STARTUP} is neither V15's nor Official Open's, so the FM-1 would refuse both M-VAVE packages ` +
  '("update failed -5"). Keep Matryoshka. Please report it at https://github.com/glvno/matryoshka/issues with the ' +
  'code below; "tools/fm1_install.py --info --save-head boot.bin" saves the start-up part to a file to attach.';

/** the Install panel's refusal for an FM-1 set to ignore the editor (#702): nothing is sent, and how to undo it */
export const IGNORED_INSTALL = 'This FM-1 is set to ignore the editor, so nothing was installed: on it, GLO \u203a SYSTEM \u203a EDITOR to ALLOW, then press the button again.';

/** a running FM-1 the Install panel passes over (#702): Matryoshka that answers HELLO with GLO > SYSTEM > EDITOR at
 *  IGNORE. `link` is fm1ota.js's (send, read); other firmware is never asked, and no answer counts as ALLOW */
export async function ignoresEditor(link: { send(b: number[] | Uint8Array): boolean; read(ms: number): Promise<number[] | null> }, id: { text: string }): Promise<boolean> {
  if (firmwareKind(id.text) !== 'matryoshka' || !link.send(helloFrame())) return false;
  const end = Date.now() + 800;
  while (Date.now() < end) {
    const f = await link.read(end - Date.now());
    if (!f) break;
    const p = parse(f);
    if (p?.cmd === CMD.info) return editorSkips(parseInfo(p));
  }
  return false;
}

/** Check the connection, on an FM-1 set to ignore the editor (#702) */
export const IGNORED_CHECK = 'This FM-1 is set to ignore the editor: the install buttons leave it alone. On it, GLO \u203a SYSTEM \u203a EDITOR to ALLOW to install.';

/** an FM-1 fm1ota.js found: its link (open), identity and ports */
interface OtaDevice {
  link: { send(b: number[] | Uint8Array): boolean; read(ms: number): Promise<number[] | null>; close(): void };
  id: { text: string; model: string };
  input: { id: string };
  output: { id: string };
}

/** Every FM-1 on USB MIDI as the Install panel tells them apart (D-965): each answers the update handshake; a running
 *  Matryoshka also HELLO (set to ignore the editor or not, #702), then its name, serial and the test rig's mark
 *  (readFm1Id). Reads only; every link is closed again. */
export async function surveyFm1s(up: { findAll(): Promise<OtaDevice[]> }): Promise<FoundFm1[]> {
  const devs = await up.findAll();
  const found: FoundFm1[] = [];
  for (const [index, d] of devs.entries()) {
    try {
      const loader = /^ota-/i.test(d.id.model);
      const ask = linkAsk(d.link);
      const hello = loader || firmwareKind(d.id.text) !== 'matryoshka' ? null : await ask(helloFrame(), (p) => p?.cmd === CMD.info, 800, 2).catch(() => null);
      const info = hello && parseInfo(hello);
      const id = info ? await readFm1Id((frame, match) => ask(frame, match, 800, 2), info.features) : { name: null, serial: null, rig: false };
      found.push({
        inputId: d.input.id, outputId: d.output.id, loader, ignored: editorSkips(info), serial: id.serial, text: d.id.text,
        label: `${fm1Label({ ...id, index, count: devs.length })} (${d.id.text})`,
      });
    } finally {
      d.link.close();
    }
  }
  return found;
}

const ERRORS: Record<string, string> = {
  notfound: 'FM-1 not found. Check the USB data cable and close other apps that use the MIDI port.',
  ignored: IGNORED_INSTALL,
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
  'bootcode-is-open': BOOT_CODE_IS_OPEN,
  'bootcode-is-v15': BOOT_CODE_IS_V15,
  'bootcode-is-other': BOOT_CODE_IS_OTHER,
};

/** an interrupted write can only be finished with a package the waiting loader may write (fm1ota.js loaderFits) */
function otherLoader(loader: string): string {
  if (loader === 'ota-' + STOCK_PRODUCT) return `The FM-1 waits in M-VAVE's update loader (${loader}) from an unfinished return to stock. Finish it with the one you started, Return to official V15 or Restore Official Open; nothing else may be written by that loader.`;
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

/** every slot of the bank as SLOT_INFO tells it, over the Install panel's link */
async function readSlots(ask: Ask, n: number): Promise<SlotInfo[]> {
  const out: SlotInfo[] = [];
  for (let s = 0; s < n; s++) {
    const got = parseSlot(await ask(slotInfoFrame(s), (p) => p?.cmd === CMD.slotReply && p.payload[0] === s, 800, 3));
    if (!got) throw new Error('unexpected answer to SLOT_INFO');
    out.push(got);
  }
  return out;
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

export function buildFlashTab(root: HTMLElement, choice: () => Fm1Choice | null = () => null): void {
  const logEl = el('pre', { class: 'log', textContent: 'Ready.\n' });
  const bar = el('progress', { max: 100, value: 0 });
  /** the step the bar is at */
  const stage = el('p', { class: 'muted', textContent: '' });
  const show = (value: number, step: string): void => {
    bar.value = value;
    stage.textContent = step;
  };
  /** this run's progress: install() makes one that leaves room for the factory sounds when their box was ticked */
  let meter = installMeter(show, false);
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
  // the factory sounds after a Matryoshka install (#915): ticked by default, a warning when unticked
  const factoryBox = el('input', { type: 'checkbox', id: 'install-factory', checked: true });
  const factoryWarn = el('p', { class: 'card warn', hidden: true, textContent: FACTORY_WARNING });
  factoryBox.onchange = () => (factoryWarn.hidden = factoryBox.checked);
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
  /** which FM-1 this button press installs on, among several (D-965): found by its first access(), the same to the end */
  let plan: Exclude<InstallPlan, { refuse: string }> | null = null;
  /** the installer, kept off every FM-1 but the one this press installs on */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const access = async (): Promise<any> => {
    const midi = await navigator.requestMIDIAccess({ sysex: true });
    if (!plan) {
      const p = installPlan(await surveyFm1s(new Updater(midi)), choice());
      if ('refuse' in p) throw new Error(`nothing was sent: ${p.refuse}`);
      plan = p;
      if (p.target && p.others.length) log(`installing on ${p.target.label}; the other FM-1${p.others.length > 1 ? 's are' : ' is'} left alone`);
    }
    const avoid = new Set(plan.avoid), others = plan.others.map((d) => d.inputId);
    // (another FM-1 that left meanwhile may come back as an update loader or under new ports: nothing more is written)
    const check = (): void => {
      if (others.some((id) => midi.inputs.get(id)?.state !== 'connected')) throw new Error(OTHER_CHANGED);
    };
    return new Updater(midi, log, { skip: ignoresEditor, avoid: (p: MIDIPort) => avoid.has(p.id), check: others.length ? check : undefined });
  };

  /** every button's action; `installs` (the four install runs, not Check the connection) guards the page against
   *  closing until the run ends */
  const run = async (name: string, fn: () => Promise<void>, installs = false): Promise<void> => {
    if (busy) return;
    busy = true;
    plan = null;
    setButtons();
    if (installs) {
      unload.arm();
      keepOpen.hidden = false;
    }
    meter = installMeter(show, false);
    show(0, '');
    log(`\n— ${name}`);
    try {
      await fn();
      if (installs) meter.done();
    } catch (e) {
      const err = e as Error & { code?: string; detail?: string };
      if (err.code === 'whichtarget') (sureRow.hidden = false), sureRow.scrollIntoView({ block: 'nearest' });
      if (err.code === 'otherloader') log(`ERROR: ${otherLoader(err.detail ?? '')}`);
      else log(`ERROR: ${(err.code && ERRORS[err.code]) || err.message}${err.detail ? ` (${err.detail})` : ''}`);
      if (installs) stage.textContent = 'Stopped: see the log below';
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
    else if (kind === 'write') meter.write(Number(a));
    else if (kind === 'reboot') meter.restart(), log('restarting');
    else if (kind === 'done') meter.back(), log(`done: the FM-1 runs ${a}`);
  };

  /** install an image; if an earlier install was cut off (the FM-1 sits in an update loader) finish that write
   *  instead, but only when that loader may write this package (otherwise an 'otherloader' error, nothing sent) */
  const installImage = async (image: Uint8Array, product: string, guard?: (loader: string) => void): Promise<void> => {
    const up = await access();
    if (await up.resume(image, step, product, guard)) {
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

  /** `factory`: the factory sounds box as it was when the install button was pressed */
  const install = async (raw: Uint8Array, factory: boolean): Promise<void> => {
    const product = productOf(raw);
    log(`package: ${product}, ${raw.length} bytes`);
    const mark = new TextEncoder().encode('FELUCCA-LOADER-1');
    if (!raw.some((_: number, i: number) => i < raw.length - mark.length && mark.every((b, k) => raw[i + k] === b))) throw new Error('this package has no update loader; refusing to install it');
    if (product === STOCK_PRODUCT) throw new Error('this is the official V15: use Return to stock');
    await overFelucca();
    const matryoshka = /^FM-1_7/.test(product);
    if (matryoshka && packageHasSmallBank(product)) await checkBank();
    else if (packageBeforeStore(product)) await checkOlder();
    meter = installMeter(show, matryoshka && factory);
    await installImage(logicalImage(raw), product);
    if (matryoshka && factory) await installFactoryAfter();
    else if (matryoshka) log('factory sounds: not installed (the box is unticked). The editor offers them when the FM-1 connects.');
  };

  /** before firmware 1.26 or later (#1202, G9): the bank of an FM-1 that runs older firmware with more than 48 slots. Its
   *  slots past 48 move to free lower slots at the first start, which the log says; with more than 48 patches the user
   *  keeps 48 (chooseKept) and the rest are erased, or nothing is installed */
  const checkBank = async (): Promise<void> => {
    const dev = await (await access()).find();
    if (!dev) return;   // (install() reports a missing device itself)
    try {
      if (/^ota-/i.test(dev.id.model)) return log(`the bank was not checked: the FM-1 waits in update mode. Firmware 1.26 has ${BANK_SLOTS} slots: an FM-1 that holds more patches keeps its old bank until slots are freed`);
      if (firmwareKind(dev.id.text) !== 'matryoshka') return;   // (no Matryoshka bank on it)
      const ask = linkAsk(dev.link);
      const hello = await ask(helloFrame(), (p) => p?.cmd === CMD.info, 800, 2).catch(() => null);
      const info = hello && parseInfo(hello);
      if (!info) return log(`the bank was not checked: the FM-1 did not answer. Firmware 1.26 has ${BANK_SLOTS} slots: an FM-1 that holds more patches keeps its old bank until slots are freed`);
      if (!needsBankCheck(info)) return;
      log('reading the bank…');
      const slots = await readSlots(ask, slotCount(info));
      const plan = bankPlan(slots);
      if (plan.kind === 'install') return;
      if (plan.kind === 'moves') return log(movesText(plan.moving));
      const erase = await chooseKept(plan.used);
      if (!erase) throw new Error(`nothing was installed, nothing was erased: ${tooManyText(plan.used)}`);
      for (const s of erase) {
        const a = await ask(slotEraseFrame(s), (p) => p?.cmd === CMD.ack && p.payload[0] === CMD.slotErase && p.payload[1] === s, 4000, 1);
        if (a.payload[2]) throw new Error(`nothing was installed: slot ${slotLabel(s)} could not be erased (status ${a.payload[2]})`);
        log(`slot ${slotLabel(s)} erased`);
      }
      const after = bankPlan(await readSlots(ask, slotCount(info)));
      if (after.kind === 'choose') throw new Error(`nothing was installed: ${tooManyText(after.used)}`);
      if (after.kind === 'moves') log(movesText(after.moving));
    } finally {
      dev.link.close();
    }
  };

  /** a bank of more than 48 patches (#1202, G9): every used slot ticked to keep at first; for each one this browser has a
   *  copy of (Library > Patches' match: the slot's name and length), Save to this browser keeps it in Your patches (the FM-1
   *  cannot send a patch). The slots to erase once at most 48 are kept, or null on Cancel */
  const chooseKept = (used: SlotInfo[]): Promise<number[] | null> => {
    const known = bankCandidates();
    const keep = new Map(used.map((s) => [s.slot, true]));
    const saved = new Set<number>();
    const copies = new Map(used.map((s) => [s.slot, knownCopy(s, known)]));
    const count = el('p', { class: 'muted' });
    const go = el('button', { class: 'primary' });
    const cancel = el('button', { textContent: 'Cancel' });
    const erasing = (): SlotInfo[] => used.filter((s) => !keep.get(s.slot));
    const sync = (): void => {
      const n = used.length - erasing().length;
      count.textContent = `Keeping ${n} of ${BANK_SLOTS}.${n > BANK_SLOTS ? ` Untick ${n - BANK_SLOTS} more.` : ''}`;
      go.disabled = n > BANK_SLOTS;
      go.textContent = `Erase ${erasing().length} and install`;
    };
    const rows = used.map((s) => {
      const copy = copies.get(s.slot);
      const box = el('input', { type: 'checkbox', checked: true, ariaLabel: `keep slot ${slotLabel(s.slot)}` });
      box.onchange = () => { keep.set(s.slot, box.checked); sync(); };
      const save = copy && el('button', { textContent: 'Save to this browser', title: `Keep "${copy.name}" in Your patches: this browser's copy of it (the FM-1 cannot send a patch)` });
      if (save && copy) save.onclick = () => {
        const r = savePatch({ ...copy.patch, name: copy.name });
        log(r.msg);
        if (!r.ok) return;
        saved.add(s.slot);
        save.textContent = 'Saved in this browser';
        save.disabled = true;
      };
      return el('div', { class: 'bank-row' },
        el('label', { class: 'grow' }, box, ` ${slotLabel(s.slot)}  ${s.name || '(no name)'}`),
        save || el('span', { class: 'muted', textContent: 'no copy in this browser, and the FM-1 cannot send it' }));
    });
    const dlg = el('dialog', { class: 'help sync-ask flash-bank' },
      el('div', { class: 'sync-ask-body' },
        el('h2', { textContent: `Keep ${BANK_SLOTS} patches` }),
        el('p', { textContent: `${tooManyText(used)} Untick the patches to erase, then install; Cancel leaves the FM-1 as it is. Save to this browser keeps a patch in Your patches first, where this browser has a copy.` }),
        el('div', { class: 'bank-list' }, ...rows),
        count,
        el('div', { class: 'sync-ask-actions' }, go, cancel)));
    sync();
    let result: number[] | null = null;
    cancel.onclick = () => dlg.close();
    go.onclick = () => {
      const gone = erasing().filter((s) => !saved.has(s.slot));
      if (gone.length && !window.confirm(`Erase ${slotList(gone)}? ${gone.some((s) => !copies.get(s.slot)) ? 'This browser has no copy of some of them, so they are gone for good.' : 'They were not saved to this browser.'}`)) return;
      result = erasing().map((s) => s.slot);
      dlg.close();
    };
    return new Promise((done) => {
      dlg.addEventListener('close', () => { dlg.remove(); done(result); }, { once: true });
      root.append(dlg);
      dlg.showModal();
    });
  };

  /** before firmware older than 1.26 (#1202, P2): over an FM-1 that keeps every pattern 2..64 in its pattern store, the
   *  warning first, with a backup of the bank offered (bankBackup: read now, the FM-1 cannot send its patches); nothing is
   *  installed until the user presses Install anyway. An FM-1 in update mode or one that does not answer cannot be asked:
   *  the log says so, and the install goes on, as the bank check of 1.26 does */
  const checkOlder = async (): Promise<void> => {
    const dev = await (await access()).find();
    if (!dev) return;   // (install() reports a missing device itself)
    try {
      if (/^ota-/i.test(dev.id.model)) return log('the patterns were not checked: the FM-1 waits in update mode. Firmware older than 1.26 cannot read the patterns 2 to 64 that firmware 1.26 keeps in the pattern store');
      if (firmwareKind(dev.id.text) !== 'matryoshka') return;
      const ask = linkAsk(dev.link);
      const hello = await ask(helloFrame(), (p) => p?.cmd === CMD.info, 800, 2).catch(() => null);
      const info = hello && parseInfo(hello);
      if (!info) return log('the patterns were not checked: the FM-1 did not answer. Firmware older than 1.26 cannot read the patterns 2 to 64 that firmware 1.26 keeps in the pattern store');
      if (!storesEveryPattern(info)) return;
      log('this FM-1 keeps its patterns in the pattern store: reading the bank and its patterns for a backup…');
      const backup = await bankBackup(await readSlots(ask, slotCount(info)), bankCandidates(), (id) => readStoredPattern((f, m) => ask(f, m, 800, 3), id));
      if (!(await olderAsk(backup))) throw new Error(`nothing was installed: ${OLDER_FIRMWARE_TEXT}`);
      log('installing firmware older than 1.26 anyway: it does not read the patterns in the pattern store');
    } finally {
      dev.link.close();
    }
  };

  /** the warning before firmware older than 1.26 goes onto a 1.26 FM-1: Back up to this browser (Your patches), Back up to
   *  a file (a browser backup file of those patches, which Load patch from .json takes), Install anyway (true) or Cancel */
  const olderAsk = (backup: BankBackup): Promise<boolean> => {
    const n = backup.patches.length;
    const toBrowser = el('button', { textContent: 'Back up to this browser', disabled: !n, title: 'Keep each patch, with every pattern inside it, in Your patches' });
    const toFile = el('button', { textContent: 'Back up to a file', disabled: !n, title: 'Save the patches, with every pattern inside each, as a file: Load patch from .json brings them back' });
    const go = el('button', { class: 'primary', textContent: 'Install anyway' });
    const cancel = el('button', { textContent: 'Cancel' });
    toBrowser.onclick = () => {
      const failed = backup.patches.map((x) => savePatch(x.patch)).filter((r) => (log(r.msg), !r.ok));
      if (failed.length) return;
      toBrowser.textContent = 'Backed up in this browser';
      toBrowser.disabled = true;
    };
    toFile.onclick = () => {
      const saved = Date.now();
      const file = backupFile({ 'matryoshka.patches': JSON.stringify(backup.patches.map((x) => ({ name: x.patch.name, patch: x.patch, saved }))) }, location.origin);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
      a.download = `matryoshka-fm1-bank-${file.saved.slice(0, 10)}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      log(`the bank's ${n} patch${n === 1 ? '' : 'es'} saved to ${a.download}`);
    };
    const missing = backup.missing.length;
    const dlg = el('dialog', { class: 'help sync-ask flash-bank' },
      el('div', { class: 'sync-ask-body' },
        el('h2', { textContent: 'Firmware older than 1.26' }),
        el('p', { textContent: `${OLDER_FIRMWARE_TEXT} ${BACKUP_TEXT}` }),
        el('p', { textContent: `The backup holds ${n} patch${n === 1 ? '' : 'es'}.${missing ? ` This browser has no copy of ${slotList(backup.missing)}, so ${missing === 1 ? 'it' : 'they'} cannot be backed up.` : ''}` }),
        el('div', { class: 'sync-ask-actions' }, toBrowser, toFile, go, cancel)));
    let result = false;
    cancel.onclick = () => dlg.close();
    go.onclick = () => {
      result = true;
      dlg.close();
    };
    return new Promise((done) => {
      dlg.addEventListener('close', () => { dlg.remove(); done(result); }, { once: true });
      root.append(dlg);
      dlg.showModal();
    });
  };

  /** the factory sounds after a Matryoshka install (#915): the FM-1 found again once it runs the new firmware, then
   *  the newest set it reads (factory-content.ts), unless it holds that one already */
  const installFactoryAfter = async (): Promise<void> => {
    log('installing the factory instruments and presets…');
    const up = await access();
    let dev = null;
    for (let t = 0; t < 10 && !dev; t++) {
      dev = await up.find((id: { model: string }) => !/^ota-/i.test(id.model));
      if (!dev) await new Promise((r) => setTimeout(r, 1500));
    }
    if (!dev) throw new Error('the FM-1 did not come back after the install: connect it in the editor to install the factory sounds');
    try {
      up.check?.();
      const ask = linkAsk(dev.link);
      const info = parseInfo(await ask(helloFrame(), (p) => p?.cmd === CMD.info, 800, 3));
      if (!info || !(info.features & FEATURE_FACTORY)) return log('this firmware has no factory region: nothing more to install');
      if (editorSkips(info)) return log(IGNORED_INSTALL);
      const serial = plan?.target?.serial;   // (among several FM-1s: the one installed on, by its serial when it tells it)
      if (serial && (await readFm1Id((frame, match) => ask(frame, match, 800, 3), info.features)).serial !== serial)
        throw new Error(`factory sounds not installed: ${OTHER_CHANGED}`);
      const fi = await factoryInfo(ask);
      const set = pickSet(await loadFactorySets(), fi);
      if (!set) throw new Error('no factory sounds for this firmware come with this copy of the app');
      if (fi.state === 1 && !fi.writing && parseInt(set.set, 16) === fi.set) return log(`factory sounds: current (version ${fi.version})`);
      const image = await fetchFactoryImage(set);
      await installFactory(ask, image, (done, total) => meter.factory(done, total));
      log(`factory sounds installed (version ${set.version}, ${image.length} bytes)`);
    } finally {
      dev.link.close();
    }
  };

  // ---- Matryoshka
  const installBtn = el('button', { textContent: 'Install Matryoshka firmware', class: 'primary' });
  const bundleInfo = el('p', { class: 'muted', textContent: 'Looking for the firmware package…' });
  installBtn.onclick = () => {
    const factory = factoryBox.checked;
    void run('install Matryoshka', async () => {
      if (!bundle) throw new Error('no firmware package is bundled with this copy of the app');
      const r = await fetch(`./firmware/matryoshka.fwsc?v=${bundle.sha256}`, { cache: 'no-cache' });
      if (!r.ok) throw new Error('the bundled firmware package could not be loaded');
      const raw = new Uint8Array(await r.arrayBuffer());
      const sum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)), (b) => b.toString(16).padStart(2, '0')).join('');
      if (sum !== bundle.sha256) throw new Error('the bundled firmware package does not match its checksum');
      await install(raw, factory);
    }, true);
  };
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
      const found = await surveyFm1s(new Updater(await navigator.requestMIDIAccess({ sysex: true })));
      if (found.length > 1) {   // (several FM-1s, D-965: each, and which one the install buttons take)
        for (const d of found) log(`${d.label}  [${d.loader ? 'update loader: an update was not finished' : d.ignored ? 'set to ignore the editor' : 'running'}]`);
        const p = installPlan(found, choice());
        return log('refuse' in p ? `the install buttons send nothing now: ${p.refuse}`
          : p.target ? `the install buttons install on ${p.target.label}` : 'the install buttons leave them alone: each is set to ignore the editor');
      }
      const dev = await (await access()).find();
      if (!dev) throw Object.assign(new Error('not found'), { code: 'notfound' });
      log(`${dev.id.text}  [${/^ota-/i.test(dev.id.model) ? 'update loader: an update was not finished' : 'running'}]  port: ${dev.name}`);
      const ignored = !/^ota-/i.test(dev.id.model) && (await ignoresEditor(dev.link, dev.id));
      dev.link.close();
      if (/^ota-/i.test(dev.id.model)) return;
      if (ignored) log(IGNORED_CHECK);
      const older = updateOffer(runningVersion(null, dev.id.text), bundle?.dev ? null : bundle?.version);   // (#216)
      if (older) log(`${older} Install Matryoshka firmware updates it.`);
      noteForeign(dev.id.text);
      if (runsFelucca(dev.id.text)) (feluccaNote.hidden = false), log('this FM-1 runs Felucca: read the note about its projects and samples before installing');
    });

  // ---- another package
  const pkgFile = el('input', { type: 'file', accept: '.fwsc' });
  const pkgBtn = el('button', { textContent: 'Install this package' });
  pkgBtn.onclick = () => {
    const factory = factoryBox.checked;
    void run('install package', async () => {
      const f = pkgFile.files?.[0];
      if (!f) throw new Error('choose a .fwsc package first');
      await install(await readFile(f), factory);
    }, true);
  };

  // ---- return to stock: M-VAVE's V15 comes with the app (Apache-2.0, from m-vave/fm1_open); validateStockPackage checks
  // its size, SHA-256 and layout before anything is sent, for the bundled file and for one the user picks alike
  /** an M-VAVE package through M-VAVE's loader: a cut-off one is finished only with the package it started with
   *  (mvave-target.ts), so the target is remembered from just before the loader is staged until the FM-1 is back */
  const mvaveInstall = async (target: MvaveTarget, image: Uint8Array, product: string): Promise<void> => {
    const guard = targetGuard(target, sure.checked);
    sure.checked = false;
    const up = await access();
    if (await up.resume(image, step, product, guard)) {
      log('an earlier update was unfinished: it is finished now');
    } else {
      rememberTarget(target);
      await up.install(image, product, step);
    }
    rememberTarget(null);
    sureRow.hidden = true;
  };
  const returnToStock = async (raw: Uint8Array): Promise<void> => {
    const v = await validateStockPackage(raw);
    log(`package: ${v.product}, ${raw.length} bytes, SHA-256 checked`);
    await mvaveInstall('v15', v.image, v.product); // also finishes a return to stock that was cut off
  };
  // ---- restore Official Open (#183): M-VAVE's own file, not bundled (its engine is proprietary); for an FM-1 whose
  // boot code is Official Open's, which refuses the V15
  const openFile = el('input', { type: 'file', accept: '.fwsc,.html' });
  const openBtn = el('button', { textContent: TARGET_NAME.open });
  openBtn.onclick = () =>
    run('restore Official Open', async () => {
      const f = openFile.files?.[0];
      if (!f) throw new Error("choose M-VAVE's Official Open: the Workbench page (.html) or its .fwsc");
      const v = await validateOpenPackage(await readFile(f));
      log(`package: ${v.product} (M-VAVE Official Open), ${v.size} bytes, its boot code and loader checked`);
      await mvaveInstall('open', v.image, v.product);
    }, true);
  // shown when M-VAVE's loader waits and this browser does not remember for which package
  const sure = el('input', { type: 'checkbox', id: 'mvave-sure' });
  const sureRow = el('div', { class: 'card warn', hidden: true }, el('p', { textContent: WHICH_TARGET }), el('label', {}, sure, ' I know which one was cut off: I press that one next'));
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
    for (const b of [pkgBtn, stockBtn, stockFileBtn, openBtn]) b.disabled = busy || !supported || !accepted();
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
          'Flashing replaces the FM-1 firmware. You can go back with Return to stock below: the official V15, or Official Open for an FM-1 that came from M-VAVE Official Open. If the FM-1 runs Felucca, Sloop or another build, return to stock first. Keep the USB cable connected and this page open until it says done.',
      }),
      more(
        'If an install is cut off',
        el('p', { textContent: 'The FM-1 has one firmware slot and no rollback. A cut-off install leaves it waiting in its update loader: press the same button again to finish (Install for Matryoshka; Return to official V15 or Restore Official Open, whichever was cut off; this page refuses the wrong one).' }),
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
    card('Install Matryoshka', bundleInfo, el('label', {}, factoryBox, FACTORY_LABEL), factoryWarn, el('div', { class: 'row' }, installBtn, findBtn), licences),
    card(
      'Return to stock',
      el('p', { class: 'muted', textContent: "M-VAVE's official firmware V15 comes with this app; its size and checksum are checked before it is sent." }),
      el('div', { class: 'row' }, stockBtn),
      el('p', { class: 'muted' }, 'FM-1_015.fwsc © M-VAVE, ', el('a', { href: './firmware/LICENSE-Apache-2.0.txt', textContent: 'Apache-2.0' }), ' (', el('a', { href: './firmware/NOTICE-FM-1_015.txt', textContent: 'notice' }), ', ', el('a', { href: 'https://github.com/m-vave/fm1_open', textContent: 'source' }), '). Matryoshka is not affiliated with M-VAVE.'),
      el('details', {}, el('summary', { textContent: 'Use your own copy' }), el('p', { class: 'muted', textContent: 'The unmodified official FM-1.fwsc (V15); anything else is refused.' }), el('div', { class: 'row' }, stockOnly, stockFileBtn)),
      el('h3', { textContent: TARGET_NAME.open }),
      el('p', { class: 'muted', textContent: "For an FM-1 that was set up by M-VAVE's Official Open: it refuses the V15 and takes Official Open back safely." }),
      el('p', { class: 'muted' }, OPEN_WHY, ' Download the Workbench page (FM1-Open-…-Workbench.html) from ', el('a', { href: OPEN_RELEASES, textContent: "M-VAVE's release page" }), ' and choose it here (its .fwsc works too). Before anything is sent, this page checks that it is M-VAVE\'s Official Open and that it fits this FM-1.'),
      el('div', { class: 'row' }, openFile, openBtn),
    ),
    sureRow,
    el(
      'details',
      { class: 'card' },
      el('summary', { textContent: 'Install another package' }),
      el('p', { class: 'muted', textContent: 'A finished .fwsc from tools/build.py (it must carry the update loader).' }),
      el('div', { class: 'row' }, pkgFile, pkgBtn),
    ),
    el('div', { class: 'card' }, bar, stage, keepOpen, logEl),
  );
  setButtons();
}
