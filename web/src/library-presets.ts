// SPDX-License-Identifier: GPL-3.0-only
// Library > Presets (#218): two columns. "In this browser" lists the user's presets (device-presets.ts; the factory ones
// ship with the app and are not listed), each with → (to the FM-1), Rename and Delete (at once, with Undo). "FM-1" lists the
// FM-1's own presets (#195: its store, separate from the editor's), read on connect and on entering the section, each with
// ← (into this browser) and Delete (on the FM-1, asks first). Moving is explicit: nothing syncs here (D-325).
import { PRESET_NEEDS_UPDATE, type DeviceLink } from './device';
import { FACTORY } from './assemblies';
import { addUserPreset, deletePreset, factoryDrawerPresets, importPresets, presetsFor, PRESETS_FORMAT, renamePreset, sameName, shortPresetText, userPresets, type Preset } from './device-presets';
import { devicePresetName, type DevicePresetEntry } from './protocol';
import { defStructure, structureOf } from './structure';
import { showUndo } from './toast';
import type { LibrarySection } from './bank';
import { drawerPresetInfo } from './fx-preset-format';
import { FM1_PRESETS } from './presets';
import { assemblyById, type AssemblyInst } from './assembly';
import { devicesOf } from './pages';
import { DEFS } from './modules';
import type { Patch } from './patch';

let engineNames: Map<string, string> | undefined;

/** a patch's instruments: its assembly devices that are not effects (an FX drawer's effects are devices of their own) */
export const factoryInstruments = (p: Patch): AssemblyInst[] =>
  devicesOf(p, DEFS).flatMap((d) => { const a = d.asm === undefined ? undefined : assemblyById(p, d.asm); return a && !a.chain ? [a] : []; });

/** which factory instrument a structure is, by name; '' when it is the user's own. A factory patch's instrument goes by the
 *  patch's name, as the bank shows it (its library engine may differ: the Hera 6 patch's is the library's Hera 4 at six
 *  voices, one structure, D-873); then each factory assembly by its own. A preset of an instrument with its FX drawer
 *  (its values end in the FXD1 footer, or it is a factory one) is "<name> with FX". */
export function engineOf(structure: string, values?: readonly number[]): string {
  if (!engineNames) {
    const names = new Map<string, string>();
    const add = (base: string, name: string): void => void (names.has(base) || names.set(base, name));
    for (const [name, make] of Object.entries(FM1_PRESETS)) {
      const p = make(), instruments = factoryInstruments(p);
      if (instruments.length === 1) add(structureOf(p, instruments[0]), name);
    }
    for (const def of FACTORY) add(defStructure(def), def.name);
    for (const def of FACTORY) for (const pr of factoryDrawerPresets(defStructure(def))) {
      const fx = drawerPresetInfo(pr), base = fx && names.get(fx.baseStructure);
      if (base && !names.has(pr.structure)) names.set(pr.structure, `${base} with FX`);
    }
    engineNames = names;
  }
  const fx = values && drawerPresetInfo({ values });
  if (fx) {
    const base = engineNames.get(fx.baseStructure);
    return base ? `${base} with FX` : '';
  }
  return engineNames.get(structure) ?? '';
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) e.className = String(cls);
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

export interface PresetsEvents {
  /** the user's presets changed (the cards' preset chips redraw) */
  changed(): void;
}

/** Library > Presets, built into `root` */
export function buildPresetsSection(root: HTMLElement, device: DeviceLink, ev: PresetsEvents): LibrarySection {
  /** the FM-1's presets as last read; null: not read since it connected */
  let onFm1: DevicePresetEntry[] | null = null;
  let busy = false;
  const mineEl = el('div', { class: 'bank-list' });
  const mineCount = el('span', { class: 'muted' });
  const fm1El = el('div', { class: 'bank-list' });
  const stateEl = el('span', { class: 'lib-state' });
  const status = el('p', { class: 'muted lib-status' });
  const sendAll = el('button', { class: 'primary', textContent: 'Send all to FM-1', title: 'Send every preset in this browser to the FM-1 (asks first when one replaces the FM-1’s)' });
  const readBtn = el('button', { textContent: 'Read again', title: 'Read the FM-1’s presets again' });

  const ready = (): boolean => device.connected && device.hasPresets && !busy && !!onFm1;
  const onDevice = (p: Preset): DevicePresetEntry | undefined => onFm1?.find((e) => e.structure === p.structure && sameName(e.name, devicePresetName(p.name)));
  const label = (structure: string, values?: readonly number[]): string => engineOf(structure, values) || 'your assembly';
  /** a mark on one of the FM-1's presets with fewer values than its engine has rows (stored before 1.8.2, D-858) */
  const short = (e: DevicePresetEntry): HTMLElement[] => {
    const rows = presetsFor(e.structure).find((x) => x.factory)?.values.length ?? 0;
    return e.n < rows ? [el('span', { class: 'muted', textContent: `${e.n} of ${rows} rows`, title: shortPresetText(engineOf(e.structure) || 'this engine', rows - e.n, rows) })] : [];
  };

  const run = async (what: string, fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    refresh();
    try {
      await fn();
    } catch (e) {
      status.textContent = `${what} failed: ${(e as Error).message}`;
    } finally {
      busy = false;
      refresh();
    }
  };
  const readDevice = (): Promise<void> => run('Reading the FM-1', async () => {
    if (!device.hasPresets) return;
    onFm1 = await device.listPresets();
    status.textContent = '';
  });
  /** a preset as it was, back in this browser (Undo) */
  const putBack = (p: Preset): void => {
    importPresets({ format: PRESETS_FORMAT, presets: [p] });
    ev.changed();
    refresh();
  };

  const refresh = (): void => {
    const by = (a: Preset, b: Preset): number => label(a.structure, a.values).localeCompare(label(b.structure, b.values)) || a.name.localeCompare(b.name, undefined, { numeric: true });
    const mine = userPresets().sort(by);
    mineCount.textContent = `${mine.length} preset${mine.length === 1 ? '' : 's'}`;
    mineEl.replaceChildren(...(mine.length ? mine.map((p) => el('div', { class: 'bank-row' },
      el('span', { class: 'grow', textContent: p.name }),
      el('span', { class: 'muted', textContent: label(p.structure, p.values) }),
      el('button', { textContent: 'Rename', title: `rename "${p.name}"`, onclick: () => {
        const to = window.prompt(`Rename the preset "${p.name}" to:`, p.name)?.trim();
        if (!to || to === p.name) return;
        status.textContent = renamePreset(p.structure, p.name, to) ? `"${p.name}" is now "${to}"` : `"${to}" is taken for this ${label(p.structure, p.values)}`;
        ev.changed();
        refresh();
      } }),
      el('button', { class: 'delete', textContent: 'Delete', title: `delete "${p.name}" from this browser (you can undo it; the FM-1's copy stays)`, onclick: () => {
        if (!deletePreset(p.structure, p.name)) return;
        ev.changed();
        refresh();
        showUndo(`Preset "${p.name}" deleted`, () => putBack(p));
      } }),
      el('button', { class: 'lib-move', textContent: '→', ariaLabel: `send "${p.name}" to the FM-1`, disabled: !ready(),
        title: !device.connected ? 'Connect an FM-1 first' : !device.hasPresets ? 'This firmware keeps no presets: update it' : onDevice(p) ? 'Send it to the FM-1, replacing the FM-1’s preset of that name (asks first)' : 'Send it to the FM-1',
        onclick: () => {
          if (!device.presetFits(p.values.length, p)) {
            status.textContent = PRESET_NEEDS_UPDATE;
            return;
          }
          const had = onDevice(p);
          if (had && !window.confirm(`The FM-1 has a preset "${had.name}" for ${label(p.structure, p.values)}. Replace it with this browser's?`)) return;
          void run('Sending', async () => {
            await device.putPreset(p.structure, p.name, p.values);
            onFm1 = await device.listPresets();
            status.textContent = `"${p.name}" is on the FM-1`;
          });
        } }),
    )) : [el('p', { class: 'muted', textContent: 'None yet. Store one from an assembly card’s preset chip (factory presets come with the app and are not listed).' })]));

    stateEl.textContent = !device.connected ? 'Not connected' : !device.hasPresets ? 'Keeps no presets' : !onFm1 ? 'Connected · reading…' : `On the FM-1 · ${onFm1.length} preset${onFm1.length === 1 ? '' : 's'}`;
    stateEl.className = `lib-state${ready() || (busy && onFm1) ? ' live' : ''}`;
    sendAll.disabled = !ready() || !mine.length;
    readBtn.hidden = !device.connected;
    readBtn.disabled = busy || !device.hasPresets;
    const kept = (e: DevicePresetEntry): Preset | undefined => mine.find((x) => x.structure === e.structure && sameName(devicePresetName(x.name), e.name));
    fm1El.replaceChildren(...(device.connected && onFm1 && onFm1.length ? onFm1.map((e) => el('div', { class: 'bank-row' },
      el('span', { class: 'grow', textContent: e.name }),
      ...short(e),
      el('span', { class: 'muted', textContent: label(e.structure) }),
      el('button', { class: 'delete', textContent: 'Delete', title: 'delete it on the FM-1 (asks first; a device set to it keeps its sound)', disabled: !ready(), onclick: () => {
        const copy = !!kept(e);
        if (!window.confirm(`Delete the preset "${e.name}" on the FM-1? ${copy ? 'Your copy in this browser stays.' : 'This browser has no copy (← keeps one), so it is gone for good.'} A device set to it keeps its sound but no longer names it.`)) return;
        void run('Delete preset', async () => {
          await device.deletePreset(e.structure, e.name);
          onFm1 = (onFm1 ?? []).filter((x) => x !== e);
          status.textContent = `"${e.name}" deleted on the FM-1: a device set to it keeps its sound, with no preset named`;
        });
      } }),
      el('button', { class: 'lib-move', textContent: '←', ariaLabel: `copy "${e.name}" into this browser`, disabled: !ready(),
        title: kept(e) ? 'Copy it into this browser, replacing your preset of that name (you can undo it)' : 'Copy it into this browser', onclick: () => void run('Copying', async () => {
          const v = await device.getPreset(e.structure, e.name);
          if (!v) throw new Error('the FM-1 has no such preset any more');
          const before = kept(e);
          const as = addUserPreset(e.structure, e.name, v);
          ev.changed();
          status.textContent = as ? `"${as}" is in your presets` : `"${e.name}" is a factory preset's name: not copied`;
          if (as && before) showUndo(`Preset "${before.name}" replaced`, () => putBack(before));
        }) }),
    )) : [el('p', { class: 'muted', textContent: !device.connected ? 'Connect an FM-1 to see its presets (ENV held + SAVE stores one there).' : !device.hasPresets ? 'This firmware keeps no presets: update it.' : onFm1 ? 'None yet. ENV held + SAVE on the FM-1 stores one.' : 'Reading…' })]));
  };

  sendAll.onclick = () => {
    const mine = userPresets();
    const replaced = mine.filter((p) => onDevice(p));
    if (replaced.length && !window.confirm(`Sending replaces ${replaced.length} preset${replaced.length === 1 ? '' : 's'} on the FM-1 (${replaced.slice(0, 6).map((p) => p.name).join(', ')}${replaced.length > 6 ? ', …' : ''}). Send all?`)) return;
    void run('Send presets', async () => {
      const fit = mine.filter(x => device.presetFits(x.values.length, x));
      for (const x of fit) await device.putPreset(x.structure, x.name, x.values);
      onFm1 = await device.listPresets();
      const left = mine.length - fit.length;
      status.textContent = `${fit.length} preset${fit.length === 1 ? '' : 's'} sent; ${onFm1.length} on the FM-1${left ? `. ${left} not sent: ${PRESET_NEEDS_UPDATE}` : ''}`;
    });
  };
  readBtn.onclick = () => void readDevice();

  root.append(
    el('div', { class: 'lib-cols' },
      el('section', { class: 'card lib-col', ariaLabel: 'In this browser' },
        el('h2', {}, el('span', { class: 'mtag src', textContent: 'MINE' }), 'In this browser', mineCount),
        el('p', { class: 'muted', textContent: 'Your saved sounds. A preset of an instrument with an FX drawer holds the drawer too: its effects in order, their controls and whether each is on. The FM-1 offers one only where the instrument and its drawer match.' }),
        mineEl,
      ),
      el('section', { class: 'card lib-col', ariaLabel: 'FM-1' },
        el('h2', {}, el('span', { class: 'mtag util', textContent: 'FM-1' }), 'FM-1', stateEl),
        el('p', { class: 'muted', textContent: 'The FM-1 keeps its own presets. Move them with → and ←: nothing syncs by itself (under Live a preset stored on the FM-1 comes over).' }),
        el('div', { class: 'toolbar' }, sendAll, readBtn),
        fm1El,
        status,
      ),
    ),
  );
  refresh();
  return {
    refresh,
    enter() {
      refresh();
      if (device.connected) void readDevice();
    },
    deviceChanged(shown) {
      onFm1 = null;
      refresh();
      if (shown && device.connected) void readDevice();
    },
  };
}
