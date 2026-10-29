// SPDX-License-Identifier: GPL-3.0-only
// Library > Patches (#218): two columns. "In this browser" lists Your patches (saved.ts): each has → (into the FM-1
// column), Rename and Delete (at once, with Undo); a sandbox patch (over the FM-1's budget, patchbin.ts deviceBudget) is
// marked SANDBOX and has no working →. The community patches added in Library > Community (community.ts) are listed there
// too, with their authors, until saved as the user's own: their Delete takes them out again (un-adds them). Add from factory ▾ under the list puts a factory patch into the FM-1 column (the
// factory patches are only a source for it). "FM-1" always shows: without a device it is the offline copy of the bank
// (`matryoshka.bank`, up to 64 entries, each a factory patch by name or a copy of a patch), edited here (order, rename,
// remove) and sent whole with Send bank to FM-1; with a device it is what the FM-1's slots really hold (readBank: read on
// connect and on entering the section), named after the bank when it holds the offline copy, else "Unsaved bank" with
// Save as bank…. Nothing merges on its own. The FM-1 cannot send a patch back (SLOT_INFO gives a name and a length), so ←
// copies this browser's own copy of the slot's patch: one with the slot's name and binary length. One bank for now; several
// named banks are #220.
// The PRESET knob of the FM-1 steps through the bank; with an empty bank it steps through the factory patches built into
// the firmware.
import type { DeviceLink } from './device';
import { DEFS } from './modules';
import { validatePatch, type Patch } from './patch';
import { deviceBudget, encodePatch } from './patchbin';
import { FM1_PRESETS } from './presets';
import { NAME_BYTES, SLOTS, slotLabel, type SlotInfo } from './protocol';
import { renamedKey } from './storage-key';
import { addCommunity, addedCommunity, onAddedChange, openCommunity, removeCommunity } from './community';
import { chipEl } from './sandbox';
import { isSaved, onSavedChange, putBackSaved, renameSaved, savedPatches, savePatch } from './saved';
import { showToast, showUndo } from './toast';

interface Entry {
  name: string;
  /** a patch of the editor, kept as a copy; factory patches are rebuilt from FM1_PRESETS */
  patch?: Patch;
}

/** the bank's name in the FM-1 column (one bank for now: #220 makes several, named) */
export const BANK_NAME = 'Bank';
const STORE = renamedKey('matryoshka.bank', 'modular-1.bank');
/** the old list of patches over the FM-1's budget (before #218): folded into Your patches on the next read */
const STORE_OVER = 'matryoshka.bank-over';

/** whether a patch fits the FM-1, remembered by its content (a patch's budget takes a while to work out, and the Library
 *  rows ask again on every change) */
const fitsKnown = new Map<string, boolean>();
const fits = (p: Patch): boolean => {
  const key = JSON.stringify(p);
  let ok = fitsKnown.get(key);
  if (ok === undefined) {
    ok = deviceBudget(p).fits;
    if (fitsKnown.size >= 256) fitsKnown.clear();
    fitsKnown.set(key, ok);
  }
  return ok;
};

function loadOver(): Entry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_OVER) ?? '[]') as Entry[];
    if (Array.isArray(raw)) return raw.filter((e) => typeof e?.name === 'string' && e.patch).map((e) => ({ name: e.name, patch: validatePatch(e.patch, DEFS) }));
  } catch {
    /* fall through: none */
  }
  return [];
}

function load(): Entry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Entry[] | null;
    if (Array.isArray(raw)) {
      const ok = raw
        .filter((e) => typeof e?.name === 'string' && (e.patch ? true : e.name in FM1_PRESETS))
        .map((e) => (e.patch ? { name: e.name, patch: validatePatch(e.patch, DEFS) } : { name: e.name }))
        .slice(0, SLOTS);
      return ok;
    }
  } catch {
    /* fall through to the default */
  }
  return Object.keys(FM1_PRESETS).slice(0, SLOTS).map((name) => ({ name }));
}

function save(list: Entry[]): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch {
    /* storage blocked: the list is not remembered */
  }
}

const patchOf = (e: Entry): Patch => (e.patch ? e.patch : FM1_PRESETS[e.name]());
const copyOf = (p: Patch): Patch => validatePatch(JSON.parse(JSON.stringify(p)), DEFS);

/** the bank, with the patches that cannot go to the FM-1 moved out: the old over-budget list, and a copy that no longer
 *  fits (saved before the budget, or a larger factory build), go to Your patches (unless a patch of that name is there) */
function reread(): Entry[] {
  let list = load();
  const misfit = list.filter((e) => e.patch && !fits(e.patch));
  const over = loadOver();
  for (const e of [...over, ...misfit]) if (!isSaved(e.name)) savePatch({ ...e.patch!, name: e.name });
  if (over.length) {
    try {
      localStorage.removeItem(STORE_OVER);
    } catch {
      /* storage blocked */
    }
  }
  if (misfit.length) {
    list = list.filter((e) => !misfit.includes(e));
    save(list);
  }
  return list;
}

/** put `e` into the list under its name (replacing a copy of that name; a factory entry of that name too when
 *  `overFactory`); an error line, or null when it went in */
function putEntry(list: Entry[], e: Entry, overFactory = false): string | null {
  const i = list.findIndex((x) => x.name === e.name);
  if (i >= 0 && !list[i].patch && e.patch && !overFactory) return `"${e.name}" is a factory patch's name: rename yours to put it in the bank`;
  if (i >= 0) {
    list[i] = e;
    return null;
  }
  if (list.length >= SLOTS) return `the bank is full (${SLOTS} slots): "${e.name}" was not added`;
  list.push(e);
  return null;
}

/** Put a patch into the bank (the offline copy) under its name, replacing one of that name; a factory patch of that name is
 *  left alone, and a patch over the FM-1's budget stays out (the tutorial's Save patch to the bank). Returns a status line */
export function addToBank(p: Patch): string {
  const name = p.name.trim() || 'PATCH';
  const copy = copyOf({ ...p, name });
  if (!fits(copy)) return `"${name}" is a sandbox patch, too big for the FM-1, so it cannot go into the bank: Your patches keep it, marked SANDBOX`;
  const list = load();
  const had = list.some((e) => e.name === name);
  const err = putEntry(list, { name, patch: copy });
  if (err) return err;
  save(list);
  return `"${name}" ${had ? 'updated in' : 'kept in'} the bank`;
}

/** a name as the FM-1 keeps it after an upload (slotFrame: capitals, the first NAME_BYTES characters, printable ASCII only) */
export const deviceName = (name: string): string =>
  [...name.toUpperCase().slice(0, NAME_BYTES)].filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127).join('');

/** the used slots an upload of `names` would lose: the ones past the list (erased), and the ones holding a patch whose name
 *  is not in the list (overwritten). Upload asks before it writes when there are any (#148) */
export function uploadLoses(have: SlotInfo[], names: string[]): SlotInfo[] {
  const kept = new Set(names.map(deviceName));
  return have.filter((s) => s.used && (s.slot >= names.length || !kept.has(s.name)));
}

/** the slot a patch named `name` goes to on the FM-1: the used slot of that name (it replaces it: asked first), else the
 *  first empty one; null when the bank is full */
export function slotFor(have: SlotInfo[], name: string): { slot: number; replaces: SlotInfo | null } | null {
  const n = deviceName(name);
  const same = have.find((s) => s.used && s.name === n);
  if (same) return { slot: same.slot, replaces: same };
  const free = have.find((s) => !s.used);
  return free ? { slot: free.slot, replaces: null } : null;
}

/** the FM-1's bank holds the offline copy: its used slots are 0..n-1, with the copy's names and binary lengths in order */
export function bankMatches(have: SlotInfo[], copy: { name: string; length: number }[]): boolean {
  return have.filter((s) => s.used).length === copy.length
    && copy.every((e, i) => have[i]?.used && have[i].name === deviceName(e.name) && have[i].length === e.length);
}

/** the binary's length (a patch that cannot be encoded: -1, which no slot has) */
const binLength = (p: Patch): number => {
  try {
    return encodePatch(p).length;
  } catch {
    return -1;
  }
};

export interface Candidate {
  name: string;
  patch: () => Patch;
  /** a factory patch (the bank keeps it by name) */
  factory?: boolean;
}

/** this browser's copy of a slot's patch: the first candidate with the slot's name and binary length; null when there is
 *  none (the FM-1 cannot send the patch itself) */
export function knownCopy(s: SlotInfo, candidates: Candidate[], length: (p: Patch) => number = binLength): { name: string; patch: Patch; factory: boolean } | null {
  if (!s.used) return null;
  for (const c of candidates) {
    if (deviceName(c.name) !== s.name) continue;
    const p = c.patch();
    if (length(p) === s.length) return { name: c.name, patch: p, factory: !!c.factory };
  }
  return null;
}

/** the patches the bank holds (the editor's own copies; factory patches are rebuilt), for the morph picker */
/** the bank's patches; `factory` picks which factory patches the bank names are built (all of them by default) */
export const bankPatches = (factory: (name: string) => boolean = () => true): { name: string; patch: Patch }[] =>
  load().filter((e) => e.patch || factory(e.name)).map((e) => ({ name: e.name, patch: patchOf(e) }));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) e.className = String(cls);
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

export interface PatchesEvents {
  /** delete one of Your patches at once, with an Undo toast (main.ts deleteSaved) */
  remove(name: string): void;
}

/** one of the Library's sections with an FM-1 column */
export interface LibrarySection {
  /** reread what this browser holds */
  refresh(): void;
  /** the section is shown: reread, and read the FM-1 when one is connected */
  enter(): void;
  /** an FM-1 connected or went away; `shown`: the section is on screen (it reads the FM-1 now, else on entering) */
  deviceChanged(shown: boolean): void;
}

/** Library > Patches, built into `root` */
export function buildPatchesSection(root: HTMLElement, device: DeviceLink, ev: PatchesEvents): LibrarySection {
  let list = reread();
  /** the FM-1's slots as last read; null: not read since it connected */
  let slots: SlotInfo[] | null = null;
  let busy = false;

  const mineEl = el('div', { class: 'bank-list' });
  const mineCount = el('span', { class: 'muted' });
  const factorySel = el('select', { className: 'lib-factory', title: 'The factory patches: read-only, a source for the FM-1 column' });
  factorySel.setAttribute('aria-label', 'Add a factory patch to the FM-1 column');
  const stateEl = el('span', { class: 'lib-state' });
  const saveAs = el('button', { className: 'lib-saveas', textContent: 'Save as bank…', title: 'Keep what the FM-1 holds as the bank in this browser (it replaces the offline copy; asks first)' });
  const bankEl = el('div', { class: 'bank-list' });
  const countEl = el('p', { class: 'muted lib-count' });
  const status = el('p', { class: 'muted lib-status' });
  const bar = el('progress', { max: 100, value: 0 });
  bar.hidden = true;
  const send = el('button', { class: 'primary', textContent: 'Send bank to FM-1' });
  const readBtn = el('button', { textContent: 'Read again', title: 'Read the FM-1’s slots again' });
  const erase = el('button', { textContent: 'Empty the FM-1 bank', title: 'Erase every slot on the FM-1 (asks first)' });
  const resetList = el('button', { textContent: 'All factory patches', title: 'Make the offline copy the factory patches' });
  const emptyList = el('button', { textContent: 'Empty the list', title: 'Empty the offline copy' });

  const live = (): boolean => device.connected;
  /** the candidates for a slot's patch: the offline copy, Your patches, the factory patches */
  const candidates = (): Candidate[] => [
    ...list.map((e) => ({ name: e.name, patch: () => patchOf(e), factory: !e.patch })),
    ...savedPatches().map((s) => ({ name: s.name, patch: () => s.patch })),
    ...addedCommunity().map((c) => ({ name: c.entry.title, patch: () => openCommunity(c) })),
    ...Object.entries(FM1_PRESETS).map(([name, make]) => ({ name, patch: make, factory: true })),
  ];
  const factoryLength = new Map<string, number>(); // a factory patch's binary length, by name
  const lengthOf = (e: Entry): number => {
    if (e.patch) return binLength(e.patch);
    if (!factoryLength.has(e.name)) factoryLength.set(e.name, binLength(patchOf(e)));
    return factoryLength.get(e.name)!;
  };
  const matches = (): boolean => !!slots && bankMatches(slots, list.map((e) => ({ name: e.name, length: lengthOf(e) })));

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
      bar.hidden = true;
      refresh();
    }
  };
  const changed = (): void => {
    save(list);
    refresh();
  };
  const readDevice = (): Promise<void> => run('Reading the FM-1', async () => {
    status.textContent = 'Reading the FM-1’s bank…';
    slots = await device.readBank();
    status.textContent = '';
  });

  /** a patch into the FM-1 column: the offline copy without a device, the FM-1's slots with one */
  /** a result of → or Add from factory: in the column's status line and in a toast (the status line can be below the fold) */
  const say = (msg: string): void => {
    status.textContent = msg;
    showToast(msg);
  };
  /** a patch into the FM-1 column: the offline copy without a device (an entry of that name, factory or not, is replaced
   *  at once with Undo: it is kept in this browser), the FM-1's slots with one (a used slot of that name asks first) */
  const toFm1 = (name: string, patch: Patch, factory: boolean): void => {
    if (!live()) {
      const i = list.findIndex((e) => e.name === name);
      const was = i >= 0 ? list[i] : null;
      const err = putEntry(list, factory ? { name } : { name, patch: copyOf({ ...patch, name }) }, true);
      if (err) return say(err);
      changed();
      if (!was) return say(`"${name}" added to the bank, slot ${slotLabel(list.length - 1)}`);
      showUndo(`"${name}" replaced in slot ${slotLabel(i)} of the bank${was.patch ? '' : ' (it was the factory patch)'}`, () => {
        const j = list.findIndex((e) => e.name === name);
        if (j >= 0) list[j] = was;
        changed();
        status.textContent = `slot ${slotLabel(j)} holds "${name}" as it was`;
      });
      status.textContent = `"${name}" replaced in slot ${slotLabel(i)}`;
      return;
    }
    if (!slots) return say('Read the FM-1 first');
    const to = slotFor(slots, name);
    if (!to) return say(`The FM-1's bank is full (${SLOTS} slots): "${name}" was not sent`);
    if (to.replaces && !window.confirm(`FM-1 slot ${slotLabel(to.slot)} holds "${to.replaces.name}". Replace it with "${name}"?`)) return say('Nothing was sent');
    void run('Sending', async () => {
      status.textContent = `Sending "${name}" to slot ${slotLabel(to.slot)}…`;
      try {
        await device.uploadSlot(to.slot, name.toUpperCase(), patch);
        slots![to.slot] = await device.readSlot(to.slot);
      } catch (e) {
        showToast(`Sending "${name}" failed: ${(e as Error).message}`);
        throw e;
      }
      say(to.replaces ? `"${name}" replaced FM-1 slot ${slotLabel(to.slot)}` : `"${name}" added to FM-1 slot ${slotLabel(to.slot)}`);
    });
  };
  /** a copy into Your patches; one of that name is replaced, with Undo */
  const toBrowser = (name: string, patch: Patch): void => {
    const r = savePatch({ ...copyOf(patch), name });
    status.textContent = r.msg;
    if (r.replaced) {
      const was = r.replaced;
      showUndo(`"${was.name}" replaced in Your patches`, () => void putBackSaved(was));
    }
  };

  const refresh = (): void => {
    // off screen (another view or section): redrawn when shown (enter)
    if (root.closest('[hidden]')) return;
    const ready = live() && !busy;
    // In this browser: Your patches, then the community patches added to them (not those saved as the user's own since)
    const mine = savedPatches();
    const added = addedCommunity().filter((c) => !mine.some((e) => e.name === c.entry.title));
    const total = mine.length + added.length;
    mineCount.textContent = `${total} patch${total === 1 ? '' : 'es'}`;
    // a full bank leaves → working: it can still replace a patch of the same name, and else says the bank is full
    const full = live() ? !!slots && !slots.some((s) => !s.used) : list.length >= SLOTS;
    const waiting = live() && !slots;
    const sandbox = (): HTMLElement => chipEl({ fits: false, text: 'SANDBOX' });
    const toFm1Btn = (name: string, ok: boolean, patch: () => Patch): HTMLElement =>
      el('button', { class: 'lib-move', textContent: '→', ariaLabel: `add "${name}" to the FM-1's bank`,
        title: !ok ? 'A sandbox patch: too big for the FM-1, it plays in the browser' : live() ? 'Add it to the FM-1’s bank, or replace the slot of that name (written on the FM-1, asks first)' : 'Add it to the bank (the offline copy), or replace the entry of that name (you can undo it)',
        disabled: !ok || busy || waiting, onclick: () => toFm1(name, patch(), false) });
    mineEl.replaceChildren(
      ...(total ? [...mine.map((e) => {
        const ok = fits(e.patch);
        return el('div', { class: 'bank-row' },
          el('span', { class: 'grow', textContent: e.name }),
          ...(ok ? [] : [sandbox()]),
          el('span', { class: 'muted', textContent: e.saved ? new Date(e.saved).toLocaleDateString() : '' }),
          el('button', { textContent: 'Rename', title: `rename "${e.name}"`, onclick: () => {
            const to = window.prompt(`Rename "${e.name}" to:`, e.name)?.trim();
            if (!to || to === e.name) return;
            status.textContent = renameSaved(e.name, to) ? `"${e.name}" is now "${to}"` : `"${to}" is taken in Your patches`;
          } }),
          el('button', { class: 'delete', textContent: 'Delete', title: `delete "${e.name}" from Your patches (you can undo it)`, onclick: () => ev.remove(e.name) }),
          toFm1Btn(e.name, ok, () => e.patch),
        );
      }), ...added.map((c) => {
        const name = c.entry.title;
        const ok = fits(c.patch);
        return el('div', { class: 'bank-row' },
          el('span', { class: 'grow' }, name, el('span', { class: 'muted', textContent: ` · ${c.entry.author}` })),
          ...(ok ? [] : [sandbox()]),
          el('span', { class: 'muted', textContent: 'community', title: 'Added from Library > Community: it follows the bundled patch until you save it as your own' }),
          el('button', { class: 'delete', textContent: 'Remove', title: `take "${name}" out of Your patches (you can undo it; Library > Community still has it)`, onclick: () => {
            if (!removeCommunity(name)) return;
            showUndo(`"${name}" taken out of Your patches`, () => { addCommunity(name); });
          } }),
          toFm1Btn(name, ok, () => openCommunity(c)),
        );
      })] : [el('p', { class: 'muted', textContent: 'None yet. Save (beside New patch, or Ctrl/Cmd+S) keeps the open patch here.' })]),
    );
    factorySel.replaceChildren(new Option('Add from factory ▾', ''), ...Object.keys(FM1_PRESETS).map((n) => new Option(n, n)));
    factorySel.disabled = busy || full || waiting;

    // FM-1: the device's slots, or the offline copy
    const onDevice = live() && !!slots;
    const same = onDevice && matches();
    stateEl.textContent = !live() ? 'Not connected · offline copy' : !slots ? 'Connected · reading…' : same ? `On the FM-1 · ${BANK_NAME}` : 'On the FM-1 · Unsaved bank';
    stateEl.className = `lib-state${!onDevice ? '' : same ? ' live' : ' unsaved'}`;
    saveAs.hidden = !onDevice || same;
    saveAs.disabled = busy;
    send.disabled = !ready || list.length === 0;
    send.title = live() ? `Write the ${BANK_NAME.toLowerCase()} kept in this browser into the FM-1's slots, replacing what they hold (asks first when it would lose a patch)` : 'Connect an FM-1 first';
    readBtn.hidden = erase.hidden = !live();
    readBtn.disabled = erase.disabled = !ready;
    resetList.hidden = emptyList.hidden = live();
    resetList.disabled = emptyList.disabled = busy;
    if (onDevice) {
      const used = slots!.filter((s) => s.used);
      const known = candidates();
      bankEl.replaceChildren(...(used.length ? used.map((s) => {
        const copy = knownCopy(s, known);
        return el('div', { class: 'bank-row' },
          el('span', { class: 'slot', textContent: slotLabel(s.slot) }),
          el('span', { class: 'grow', textContent: s.name }),
          el('button', { class: 'delete', textContent: '×', title: 'Erase this slot on the FM-1 (asks first)', ariaLabel: `erase slot ${slotLabel(s.slot)} on the FM-1`, disabled: busy, onclick: () => {
            if (!window.confirm(`Erase FM-1 slot ${slotLabel(s.slot)} ("${s.name}")? ${copy ? 'This browser keeps its copy.' : 'This browser has no copy of it, so it is gone for good.'}`)) return;
            void run('Erasing', async () => {
              await device.eraseSlot(s.slot);
              slots![s.slot] = await device.readSlot(s.slot);
              status.textContent = `slot ${slotLabel(s.slot)} is empty`;
            });
          } }),
          el('button', { class: 'lib-move', textContent: '←', ariaLabel: `copy "${s.name}" into Your patches`, disabled: busy || !copy,
            title: copy ? `Copy into Your patches as "${copy.name}" (this browser's copy of it: the FM-1 cannot send a patch back)` : 'This browser has no copy of this patch, and the FM-1 cannot send a patch back',
            onclick: () => copy && toBrowser(copy.name, copy.patch) }),
        );
      }) : [el('p', { class: 'muted', textContent: 'The bank is empty: the PRESET knob steps through the factory patches built into the firmware.' })]));
      countEl.textContent = `${used.length} of ${SLOTS} slots used on the FM-1`;
    } else {
      bankEl.replaceChildren(...(list.length ? list.map((e, i) => el('div', { class: 'bank-row' },
        el('span', { class: 'slot', textContent: slotLabel(i) }),
        el('span', { class: 'grow', textContent: e.name }),
        ...(e.patch ? [] : [el('span', { class: 'muted', textContent: 'factory' })]),
        el('button', { textContent: '▲', title: 'move up', ariaLabel: `move "${e.name}" up`, disabled: busy || i === 0, onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; changed(); } }),
        el('button', { textContent: '▼', title: 'move down', ariaLabel: `move "${e.name}" down`, disabled: busy || i === list.length - 1, onclick: () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; changed(); } }),
        el('button', { textContent: 'Rename', title: `rename "${e.name}" in the bank (the FM-1 shows the first ${NAME_BYTES} characters, in capitals)`, disabled: busy, onclick: () => {
          const to = window.prompt(`Rename "${e.name}" in the bank to:`, e.name)?.trim();
          if (!to || to === e.name) return;
          if (list.some((x) => x.name === to)) return void (status.textContent = `"${to}" is already in the bank`);
          list[i] = { name: to, patch: { ...copyOf(patchOf(e)), name: to } };
          changed();
        } }),
        el('button', { class: 'delete', textContent: '×', title: 'take it out of the bank (Your patches keep theirs)', ariaLabel: `take "${e.name}" out of the bank`, disabled: busy, onclick: () => { list.splice(i, 1); changed(); } }),
        el('button', { class: 'lib-move', textContent: '←', ariaLabel: `copy "${e.name}" into Your patches`, title: 'Copy into Your patches', disabled: busy, onclick: () => toBrowser(e.name, patchOf(e)) }),
      )) : [el('p', { class: 'muted', textContent: 'Empty. → beside a patch, or Add from factory, puts one here.' })]));
      countEl.textContent = live() ? '' : `${list.length} of ${SLOTS} slots`;
    }
  };

  factorySel.onchange = () => {
    const name = factorySel.value;
    factorySel.value = '';
    if (!name) return;
    if (!live() && list.some((e) => e.name === name && !e.patch)) return say(`"${name}" is already in the bank`);
    toFm1(name, FM1_PRESETS[name](), true);
  };
  saveAs.onclick = () => {
    if (!slots) return;
    const used = slots.filter((s) => s.used);
    const known = candidates();
    const kept = used.map((s) => ({ s, copy: knownCopy(s, known) }));
    const missing = kept.filter((k) => !k.copy);
    const lose = missing.length ? ` This browser has no copy of ${missing.length} of them (${missing.slice(0, 6).map((k) => `${slotLabel(k.s.slot)} ${k.s.name}`).join(', ')}${missing.length > 6 ? ', …' : ''}): they are left out, since the FM-1 cannot send a patch back.` : '';
    if (!window.confirm(`Keep the ${used.length} patches on the FM-1 as the ${BANK_NAME.toLowerCase()} in this browser? This replaces its offline copy (${list.length} patches).${lose}`)) return;
    list = kept.flatMap(({ copy }) => (!copy ? [] : copy.factory ? [{ name: copy.name }] : [{ name: copy.name, patch: copyOf(copy.patch) }]));
    changed();
    status.textContent = `the ${BANK_NAME.toLowerCase()} is what the FM-1 holds${missing.length ? `, less ${missing.length} this browser has no copy of` : ''}`;
  };
  send.onclick = () => void run('Sending the bank', async () => {
    const total = list.length;
    status.textContent = 'Reading the bank on the FM-1…';
    const have = await device.readBank();
    slots = have;
    const lost = uploadLoses(have, list.map((e) => e.name));
    const shown = lost.slice(0, 8).map((s) => `${slotLabel(s.slot)} ${s.name}`).join(', ') + (lost.length > 8 ? ', …' : '');
    if (lost.length && !window.confirm(`Sending the ${BANK_NAME.toLowerCase()} replaces ${lost.length} patch${lost.length === 1 ? '' : 'es'} on the FM-1 that it does not hold (${shown}). Send anyway?`)) {
      status.textContent = 'Nothing was sent.';
      return;
    }
    bar.hidden = false;
    for (let i = 0; i < total; i++) {
      status.textContent = `Sending ${i + 1} of ${total}: ${list[i].name}`;
      bar.value = (100 * i) / total;
      await device.uploadSlot(i, list[i].name.toUpperCase(), patchOf(list[i]));
    }
    for (let i = total; i < SLOTS; i++)
      if (have[i].used) {
        status.textContent = `Emptying slot ${slotLabel(i)}`;
        await device.eraseSlot(i);
      }
    bar.value = 100;
    slots = await device.readBank();
    status.textContent = `${total} patches are on the FM-1. Turn its PRESET knob to step through them.`;
  });
  readBtn.onclick = () => void readDevice();
  erase.onclick = () => {
    if (busy || !window.confirm('Erase every patch slot on the FM-1? The PRESET knob then steps through the factory patches built into the firmware.')) return;
    void run('Emptying the FM-1 bank', async () => {
      const have = await device.readBank();
      for (const s of have) if (s.used) await device.eraseSlot(s.slot);
      slots = await device.readBank();
      status.textContent = 'The FM-1 bank is empty.';
    });
  };
  resetList.onclick = () => { list = Object.keys(FM1_PRESETS).slice(0, SLOTS).map((name) => ({ name })); changed(); };
  emptyList.onclick = () => { list = []; changed(); };

  onSavedChange(refresh);
  onAddedChange(refresh);
  root.append(
    el('div', { class: 'lib-cols' },
      el('section', { class: 'card lib-col', ariaLabel: 'In this browser' },
        el('h2', {}, el('span', { class: 'mtag src', textContent: 'MINE' }), 'In this browser', mineCount),
        el('p', { class: 'muted', textContent: 'Your patches, kept in this browser. → adds one to the FM-1’s bank; one marked SANDBOX is too big for the FM-1 and plays here in the browser.' }),
        mineEl,
        el('div', { class: 'toolbar lib-foot' }, factorySel),
      ),
      el('section', { class: 'card lib-col', ariaLabel: 'FM-1' },
        el('h2', {}, el('span', { class: 'mtag util', textContent: 'FM-1' }), 'FM-1', stateEl, saveAs),
        // (the bank picker of #220 goes before Send bank to FM-1; with one bank the header's state names it)
        el('div', { class: 'toolbar' }, send, readBtn, erase, resetList, emptyList),
        bar,
        bankEl,
        countEl,
        status,
      ),
    ),
  );
  refresh();
  return {
    refresh() {
      list = reread();
      refresh();
    },
    enter() {
      list = reread();
      refresh();
      if (live()) void readDevice();
    },
    deviceChanged(shown) {
      slots = null;
      refresh();
      if (shown && live()) void readDevice();
    },
  };
}
