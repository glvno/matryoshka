// SPDX-License-Identifier: GPL-3.0-only
// Which FM-1 the editor and the Install panel use when more than one is connected (D-965). Two FM-1s show the same MIDI
// port name, so each one is told apart by what it says about itself: its name and serial (DEVICE_SETTINGS, feature bit
// 22) and the test rig's mark (a preset of RIG_STRUCTURE). The user's choice is remembered by serial in this browser.
import { CMD, deviceSettingsFrame, parseDeviceSettings, parsePresetData, presetGetFrame, RIG_PRESET, RIG_STRUCTURE, FEATURE_DEVICE_SETTINGS, type Parsed } from './protocol';

/** one FM-1 that answered Connect FM-1's HELLO, as the editor tells it apart from another */
export interface Fm1Id {
  /** the name set in Name & USB playback ('' unnamed); null: its firmware has no device settings (before feature bit 22) */
  name: string | null;
  /** the flash chip's unique ID, 32 hexadecimal digits; null: not known (older firmware, or a chip without one) */
  serial: string | null;
  /** it carries the test rig's mark (#291) */
  rig: boolean;
  /** its place among the FM-1s that answered (0 = the first), and how many answered */
  index: number;
  count: number;
  /** its MIDI input's name and id */
  port: string;
  portId: string;
  /** its firmware version from INFO, '' when INFO has none */
  firmware: string;
}

/** a serial that names a chip: all zeros or all ones means the chip gave none */
export const usableSerial = (s: string | null | undefined): string | null => (s && !/^0+$|^F+$/i.test(s) ? s.toUpperCase() : null);

/** What tells an FM-1 apart, asked over its link (`ask`: a request and the answer it waits for) with the feature bits of
 *  its INFO: its name and serial (DEVICE_SETTINGS, feature bit 22) and whether it carries the test rig's mark (a preset of
 *  RIG_STRUCTURE named RIG_PRESET, presets are feature bit 7). Reads only: nothing on the FM-1 changes. No answer counts as
 *  no name, serial or mark. */
export async function readFm1Id(ask: (frame: Uint8Array, match: (p: Parsed | null) => boolean) => Promise<Parsed>, features: number): Promise<Pick<Fm1Id, 'name' | 'serial' | 'rig'>> {
  const settings = features & FEATURE_DEVICE_SETTINGS
    ? await ask(deviceSettingsFrame(), (p) => p?.cmd === CMD.deviceSettingsReply).then(parseDeviceSettings).catch(() => null)
    : null;
  const rig = features & 128
    ? await ask(presetGetFrame(RIG_STRUCTURE, RIG_PRESET), (p) => !!p && p.cmd === CMD.presetData && parsePresetData(p)?.structure === RIG_STRUCTURE)
      .then((p) => parsePresetData(p)?.values != null).catch(() => false)
    : false;
  return { name: settings ? settings.name : null, serial: usableSerial(settings?.serial), rig };
}

/** how the editor names an FM-1 in the status line, Connect FM-1 and the chooser: the rig, its name, the end of its
 *  serial, or its place among several (older firmware) */
export function fm1Label(d: Pick<Fm1Id, 'name' | 'serial' | 'rig' | 'index' | 'count'>): string {
  if (d.rig) return 'Test rig';
  if (d.name) return `FM-1 ${d.name}`;
  if (d.serial) return `FM-1 \u2026${d.serial.slice(-6)}`;
  return d.count > 1 ? `FM-1 #${d.index + 1}` : 'FM-1';
}

/** the chooser's line under the label: serial, firmware and port, as far as known */
export function fm1Detail(d: Fm1Id): string {
  return [
    d.serial ? `serial \u2026${d.serial.slice(-8)}` : 'serial not known (older firmware)',
    d.firmware && `Matryoshka ${d.firmware}`,
    d.rig && 'carries the test rig\u2019s mark',
    `port ${d.port || '(no name)'} #${d.index + 1}`,
  ].filter(Boolean).join(' \u00b7 ');
}

const KEY = 'matryoshka.fm1-choice';
/** the serial of the FM-1 the user chose last in this browser, or null */
export function rememberedFm1(): string | null {
  try {
    return usableSerial(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}
/** keeps the user's choice: by serial; a choice that cannot be remembered (no serial, or the test rig, which is never
 *  taken without asking) forgets the previous one, so the next connect asks again */
export function rememberFm1(d: Fm1Id): void {
  try {
    if (d.serial && !d.rig) localStorage.setItem(KEY, d.serial);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the choice holds until the page reloads */
  }
}

/** Connect FM-1's pick among the FM-1s that answered: the only one, or the remembered one (never the test rig while another
 *  answered); null: the user chooses */
export function autoPick(found: Fm1Id[], remembered: string | null, ask = false): number | null {
  if (found.length === 1) return 0;
  if (ask || !remembered) return null;
  const i = found.findIndex((d) => d.serial === remembered && !d.rig);
  return i >= 0 ? i : null;
}
/** the FM-1 the chooser offers first: the remembered one, else the first that is not the test rig */
export function suggested(found: Fm1Id[], remembered: string | null): number {
  const r = remembered ? found.findIndex((d) => d.serial === remembered && !d.rig) : -1;
  return r >= 0 ? r : Math.max(0, found.findIndex((d) => !d.rig));
}

/** Connect FM-1's message when more than one FM-1 answered and none was chosen */
export const NOT_CHOSEN = 'More than one FM-1 answered and none was chosen: connect again to choose one';

// ---- the Install panel (flasher.ts)

/** the FM-1 the user chose, as the Install panel matches it: the one the editor is linked to (its input port and serial),
 *  else the remembered serial */
export interface Fm1Choice { serial: string | null; inputId: string | null; label: string; linked: boolean }

/** one FM-1 the Install panel found: its ports, whether it waits in its update loader, is set to ignore the editor (#702),
 *  its serial when its firmware tells it, and its label */
export interface FoundFm1 { inputId: string; outputId: string; loader: boolean; ignored: boolean; serial: string | null; text: string; label: string }

/** what an install may touch: `avoid` the ports of every other FM-1 (never probed or written to), `target` the FM-1 it
 *  installs on (null: one FM-1 or none, the installer finds it as before) */
export type InstallPlan = { avoid: string[]; target: FoundFm1 | null; others: FoundFm1[] } | { refuse: string };

/** why an install sends nothing (the Install panel says "Nothing was sent:" before it, Check the connection otherwise) */
export const CHOOSE_FIRST = (n: number): string =>
  `${n} FM-1s are connected and none is chosen. In FM-1 & MIDI, Connect FM-1 and choose the one to install on, or unplug the others.`;
export const LOADER_AMONG_SEVERAL =
  'one of the connected FM-1s waits in update mode, and there an FM-1 cannot say which one it is. Unplug every other FM-1 first.';
export const CHOSEN_MISSING = (label: string): string =>
  `the editor is linked to ${label}, and the installer does not find it among the connected FM-1s. Unplug the others, or connect again.`;
export const OTHER_CHANGED =
  'another FM-1 was unplugged or restarted during the install, so the FM-1 that answered now may be that one. Unplug every other FM-1, then press the same button again to finish.';

/**
 * Which FM-1 an install goes to (D-965). One FM-1, or none: as before. The FM-1 the editor is linked to is the target,
 * and only it. Otherwise, of several FM-1s the one chosen in the editor (remembered by serial) is; none chosen, nothing is
 * installed. An FM-1 waiting in its update loader beside another is refused: a loader cannot say which FM-1 it is. An
 * FM-1 set to ignore the editor is never a target, and alone beside it the other one is.
 */
export function installPlan(found: FoundFm1[], choice: Fm1Choice | null): InstallPlan {
  const matches = (d: FoundFm1): boolean => !!choice && ((!!choice.serial && d.serial === choice.serial) || (!!choice.inputId && d.inputId === choice.inputId));
  const plan = (target: FoundFm1): InstallPlan => {
    const others = found.filter((d) => d !== target);
    if (others.some((d) => d.loader)) return { refuse: LOADER_AMONG_SEVERAL };
    return { avoid: others.flatMap((d) => [d.inputId, d.outputId]), target, others };
  };
  if (choice?.linked && found.length) {
    const target = found.find((d) => !d.loader && matches(d));
    return target ? plan(target) : { refuse: CHOSEN_MISSING(choice.label) };
  }
  if (found.length <= 1) return { avoid: [], target: null, others: [] };
  if (found.some((d) => d.loader)) return { refuse: LOADER_AMONG_SEVERAL };
  const open = found.filter((d) => !d.ignored);
  if (!open.length) return { avoid: [], target: null, others: [] };   // (the installer says they are set to ignore the editor)
  const target = open.length === 1 ? open[0] : open.find(matches);
  return target ? plan(target) : { refuse: CHOOSE_FIRST(open.length) };
}
