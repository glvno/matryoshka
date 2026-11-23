// SPDX-License-Identifier: GPL-3.0-only
// Library > Patterns (#901): the FM-1's pattern store beside the patch. "This patch" shows the selected pattern and its
// link: Save writes it over the stored pattern it links (every patch that links it changes), Save as new makes a copy and
// links that, Upload puts a pattern file into the store. "FM-1" lists the store (read on connect and on entering the
// section) and, after the user's entries, the read-only factory ones: the patterns the factory patches link (#923) and the
// demonstration patterns (pattern-store.ts factoryEntries, listed without an FM-1 too): Load copies one into the selected
// pattern (a user entry into pattern 2..64 is linked, as the FM-1's SEQ page links it), Rename, Delete (asks; one the
// bank's patches link asks again with how many slots), Download (a pattern file). A loaded pattern whose locks were
// written for another layout keeps its notes only.
// On an FM-1 that stores every pattern 2..64 (1.26, #1202) sending the patch stores its patterns and SAVE on the FM-1 does
// the same, and the FM-1 frees an entry no patch links at its next slot write. The library then offers what the FM-1 does
// (P3 of #1202): Load, Keep a copy and Load file. Save and Save as new are not offered (an entry of their own would be
// freed, or a shared one written over). Keep a copy puts the selected pattern into the store as a kept copy (PAT_KEPT, as
// FX+SAVE on the FM-1): an entry of its own name that no patch links, which the FM-1 never frees or writes over. Upload
// becomes Load file, which loads the file into the selected pattern; the patch's next send stores it.
import type { DeviceLink } from './device';
import type { LibrarySection } from './bank';
import type { Patch } from './patch';
import { deviceView } from './poly';
import { engineOf } from './library-presets';
import { applyPayload, autoName, decodePayload, encodePayload, entryName, factoryEntries, fnv, FNV0, layoutOf, PATTERN_NAME_BYTES, PAYLOAD_MAX, patternFile, readPatternFile, recordBytes, storedName, type LocksLoaded } from './pattern-store';
import { kb } from './patchbin';
import type { StoredPatternEntry } from './protocol';
import { patternName, type PatternLink } from './track';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) e.className = String(cls);
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

export interface PatternsEvents {
  /** the editor's patch and its selected pattern (0-based) */
  patch(): Patch;
  pattern(): number;
  /** a payload into pattern p, linked or not (Editor.loadStoredPattern: an undo step); what became of its locks */
  load(p: number, payload: Uint8Array, link: PatternLink | null): LocksLoaded | null;
  /** pattern p's link as the store has it now (Editor.setLink) */
  link(p: number, link: PatternLink | null): void;
}

/** what a load says about the locks: kept, or left out because they were written for another patch layout */
export const LOCKS_LEFT_OUT = 'its P-locks were left out: they were written for another patch layout';

/** Library > Patterns, built into `root` */
export function buildPatternsSection(root: HTMLElement, device: DeviceLink, ev: PatternsEvents): LibrarySection {
  /** the store's entries as last read (user then factory); null: not read since it connected */
  let onFm1: StoredPatternEntry[] | null = null;
  let busy = false;
  const factory = factoryEntries();
  const hereEl = el('div', { class: 'bank-list' });
  const listEl = el('div', { class: 'bank-list' });
  const stateEl = el('span', { class: 'lib-state' });
  const roomEl = el('p', { class: 'muted lib-count' });
  const status = el('p', { class: 'muted lib-status' });
  const save = el('button', { class: 'primary', textContent: 'Save to FM-1' });
  const saveNew = el('button', { textContent: 'Save as new', title: 'Store a copy of the selected pattern on the FM-1 and link the pattern to the copy' });
  const keep = el('button', { class: 'primary', textContent: 'Keep a copy', title: 'Keep a copy of the selected pattern in the FM-1’s pattern store under its own name (as FX+SAVE on the FM-1): no patch links it, and the FM-1 keeps it until you delete it' });
  const upload = el('button', { textContent: 'Upload file…', title: 'Put a pattern file into the FM-1’s pattern store' });
  /** the FM-1 stores every pattern 2..64 (#1202): a pattern is stored by sending the patch, or kept on its own as a kept copy */
  const everyStored = (): boolean => device.patternsStored;
  const readBtn = el('button', { textContent: 'Read again', title: 'Read the FM-1’s pattern store again' });
  const file = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });

  const store = (): boolean => device.connected && device.hasPatternStore;
  const ready = (): boolean => store() && !busy && !!onFm1;
  const user = (): StoredPatternEntry[] => (onFm1 ?? []).filter((e) => !e.readOnly);
  /** the factory entries as the FM-1 lists them, else the editor's own (the same, in the same order) */
  const listed = (): StoredPatternEntry[] => (store() && onFm1 ? onFm1 : factory);

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
    if (!device.hasPatternStore) return;
    onFm1 = await device.listPatterns();
    status.textContent = '';
  });
  /** a stored pattern's payload: the factory ones are the editor's own */
  const payloadOf = async (e: StoredPatternEntry): Promise<Uint8Array> => {
    const own = factory.find((f) => f.id === e.id);
    const payload = own ? own.payload : await device.getPattern(e.id);
    if (!payload) throw new Error('the FM-1 has no such pattern any more');
    return payload;
  };

  /** the selected pattern into the store: over the entry it links (`fresh` false and it links one the store has), else a
   *  new entry, named here (the FM-1's own name for it offered), which pattern 2..64 then links */
  const saveSelected = (fresh: boolean): void => {
    const patch = ev.patch(), p = ev.pattern();
    const payload = encodePayload(patch, p);
    if (decodePayload(payload).tracks.every((t) => !t)) return void (status.textContent = `${patternName(p)} is on no track: there is nothing to save`);
    if (payload.length > PAYLOAD_MAX) return void (status.textContent = `${patternName(p)} takes ${payload.length} bytes: a stored pattern takes ${PAYLOAD_MAX} at most`);
    const link = p > 0 ? patch.modules.find((m) => m.type === 'fm1')?.seq?.links?.[p] : undefined;
    const over = !fresh && link ? user().find((e) => e.id === link.id) : undefined;
    const name = over ? over.name : storedName(window.prompt(`Name the stored pattern (${PATTERN_NAME_BYTES} characters at most):`, autoName(patch.name, p)) ?? '');
    if (!name) return;
    if (over && !window.confirm(`Write ${patternName(p)} over "${over.name}" on the FM-1? Every patch that links it plays the new one.`)) return;
    void run('Saving the pattern', async () => {
      const id = await device.putPattern(over ? over.id : 0, name, payload);
      if (p > 0) ev.link(p, { id, hash: fnv(FNV0, payload) });
      onFm1 = await device.listPatterns();
      status.textContent = over ? `${patternName(p)} saved over "${name}"` : `${patternName(p)} saved as "${name}"${p > 0 ? ', and linked to it' : ''}`;
    });
  };
  /** Keep a copy (an FM-1 that stores every pattern, #1202 P1): the selected pattern as a new kept entry, linked to no
   *  patch, named as a send names an entry (entryName) unless the user names it otherwise */
  const keepSelected = (): void => {
    const patch = ev.patch(), p = ev.pattern();
    const payload = encodePayload(patch, p);
    if (decodePayload(payload).tracks.every((t) => !t)) return void (status.textContent = `${patternName(p)} is on no track: there is nothing to keep`);
    if (payload.length > PAYLOAD_MAX) return void (status.textContent = `${patternName(p)} takes ${payload.length} bytes: a stored pattern takes ${PAYLOAD_MAX} at most`);
    const name = storedName(window.prompt(`Name the copy (${PATTERN_NAME_BYTES} characters at most):`, entryName(patch.name, p)) ?? '');
    if (!name) return;
    void run('Keeping a copy', async () => {
      await device.putPattern(0, name, payload, true);
      onFm1 = await device.listPatterns();
      status.textContent = `${patternName(p)} kept on the FM-1 as "${name}": no patch links it, and it stays until you delete it`;
    });
  };
  /** entry `e` into the selected pattern: a user entry into pattern 2..64 is linked when the pattern comes out as stored
   *  (a patch with fewer tracks, or locks of another layout, makes a copy instead: a SAVE must not write the loss back) */
  const load = (e: StoredPatternEntry): void => void run('Loading the pattern', async () => {
    const p = ev.pattern(), payload = await payloadOf(e);
    // (tried on a copy first: the link goes in with the load, one undo step)
    const trial = structuredClone(ev.patch());
    applyPayload(trial, p, payload);
    const linked = !e.readOnly && p > 0 && fnv(FNV0, encodePayload(trial, p)) === e.hash;
    const locks = ev.load(p, payload, linked ? { id: e.id, hash: e.hash } : null);
    status.textContent = `${patternName(p)} is "${e.name}"${linked ? ', linked to it' : !e.readOnly && p > 0 ? ' (a copy: this patch’s tracks do not hold all of it)' : ''}${locks === 'dropped' ? `; ${LOCKS_LEFT_OUT}` : ''}`;
  });
  const rename = (e: StoredPatternEntry): void => {
    const to = storedName(window.prompt(`Rename the stored pattern "${e.name}" to:`, e.name) ?? '');
    if (!to || to === e.name) return;
    void run('Renaming', async () => {
      await device.putPattern(e.id, to, await payloadOf(e));
      onFm1 = await device.listPatterns();
      status.textContent = `"${e.name}" is now "${to}"`;
    });
  };
  const remove = (e: StoredPatternEntry): void => {
    if (!window.confirm(`Delete the stored pattern "${e.name}" on the FM-1? A patch that links it plays its own copy if it has one, else its pattern 1 there. Download keeps a copy.`)) return;
    void run('Deleting', async () => {
      let r = await device.deletePattern(e.id, false);
      if (!r.deleted && window.confirm(`"${e.name}" is used by ${r.used} slot${r.used === 1 ? '' : 's'} of the FM-1's bank. Delete it anyway?`)) r = await device.deletePattern(e.id, true);
      onFm1 = await device.listPatterns();
      status.textContent = r.deleted ? `"${e.name}" deleted on the FM-1` : `"${e.name}" kept`;
    });
  };
  const download = (e: StoredPatternEntry): void => void run('Downloading', async () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([patternFile(e.name, await payloadOf(e))], { type: 'application/json' }));
    a.download = `${e.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pattern'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  const refresh = (): void => {
    if (root.closest('[hidden]')) return;   // (off screen: redrawn when shown)
    const patch = ev.patch(), p = ev.pattern();
    const links = patch.modules.find((m) => m.type === 'fm1')?.seq?.links ?? {};
    const link = links[p];
    /** a linked entry: the user's as the FM-1 lists them, a factory one as the editor has it */
    const named = (id: number): StoredPatternEntry | undefined => user().find((e) => e.id === id) ?? factory.find((e) => e.id === id);
    const entry = link ? named(link.id) : undefined;
    const edited = !!link && fnv(FNV0, encodePayload(patch, p)) !== link.hash;
    hereEl.replaceChildren(el('div', { class: 'bank-row' },
      el('span', { class: 'grow', textContent: patternName(p) }),
      el('span', { class: 'muted', textContent: !link ? (p ? 'not linked' : 'pattern 1 is the patch’s own') : `linked to ${entry ? `"${entry.name}"` : `stored pattern ${link.id}`}${edited ? (everyStored() ? ' · edited: sending the patch or SAVE on the FM-1 stores it' : entry?.readOnly ? ' · edited: SAVE on the FM-1 stores it as a new pattern' : ' · edited: SAVE on the FM-1 or Save here writes it there') : ''}${onFm1 && store() && !entry ? ' · not on this FM-1' : ''}` }),
    ), ...Object.entries(links).filter(([k]) => Number(k) !== p).map(([k, l]) => el('div', { class: 'bank-row' },
      el('span', { class: 'grow', textContent: patternName(Number(k)) }),
      el('span', { class: 'muted', textContent: `linked to ${named(l.id)?.name ?? `stored pattern ${l.id}`}` }),
    )));
    save.disabled = saveNew.disabled = keep.disabled = !ready();
    upload.disabled = everyStored() ? busy : !ready();
    save.hidden = saveNew.hidden = everyStored();
    keep.hidden = !everyStored();
    upload.textContent = everyStored() ? 'Load file…' : 'Upload file…';
    upload.title = everyStored() ? `Load a pattern file into ${patternName(p)} of this patch: sending the patch stores it on the FM-1` : 'Put a pattern file into the FM-1’s pattern store';
    save.title = !store() ? 'Connect an FM-1 whose pattern store is on' : entry ? `Write the selected pattern over "${entry.name}" on the FM-1 (every patch that links it changes; asks first)` : 'Store the selected pattern on the FM-1 (pattern 2..64 is then linked to it)';
    readBtn.hidden = !device.connected;
    readBtn.disabled = busy || !device.hasPatternStore;
    stateEl.textContent = !device.connected ? 'Not connected · factory patterns' : !device.hasPatternStore ? 'No pattern store' : !onFm1 ? 'Connected · reading…' : `On the FM-1 · ${user().length} pattern${user().length === 1 ? '' : 's'}`;
    stateEl.className = `lib-state${ready() || (busy && onFm1) ? ' live' : ''}`;
    const total = device.info?.store?.total;
    roomEl.textContent = store() && onFm1 && total ? `about ${kb(user().reduce((n, e) => n + recordBytes(e.len), 0))} of ${kb(total)} KB used` : '';
    const layout = layoutOf(deviceView(patch, true).patch);
    listEl.replaceChildren(...listed().map((e) => {
      const own = e.readOnly ? factory.find((f) => f.id === e.id) : undefined;
      const kit = own?.kit ?? (own ? engineOf(own.structure ?? '') : '');
      const linkedAs = Object.entries(links).filter(([, l]) => l.id === e.id).map(([k]) => patternName(Number(k)));
      return el('div', { class: 'bank-row' },
        el('span', { class: 'grow', textContent: e.name }),
        ...(kit ? [el('span', { class: 'muted', textContent: kit })] : []),
        ...(linkedAs.length ? [el('span', { class: 'muted', textContent: `linked as ${linkedAs.join(', ')}` })] : []),
        el('span', { class: 'muted', textContent: `${e.tracks} track${e.tracks === 1 ? '' : 's'} · ${e.len} B` }),
        ...(e.readOnly ? [el('span', { class: 'muted', textContent: 'factory', title: own?.kit ? `Read-only: a pattern of the factory ${own.kit}, which links it` : 'Read-only: a factory demonstration pattern' })] : []),
        ...(e.layout ? [el('span', { class: 'muted', textContent: e.layout === layout ? 'locks' : 'locks left out',
          title: e.layout === layout ? 'Its P-locks were written for this patch’s layout: they load too' : 'Its P-locks were written for another patch layout: only its notes load here' })] : []),
        el('button', { textContent: 'Load', title: `Load it into ${patternName(ev.pattern())}${e.readOnly ? ' (a copy)' : ev.pattern() ? ' and link it' : ' (a copy: pattern 1 is never linked)'}`, disabled: busy || (!e.readOnly && !ready()), onclick: () => load(e) }),
        ...(e.readOnly ? [] : [
          el('button', { textContent: 'Rename', title: `rename "${e.name}" on the FM-1`, disabled: !ready(), onclick: () => rename(e) }),
          el('button', { class: 'delete', textContent: 'Delete', title: `delete "${e.name}" on the FM-1 (asks first)`, disabled: !ready(), onclick: () => remove(e) }),
        ]),
        el('button', { textContent: 'Download', title: 'Save it as a pattern file', disabled: busy || (!e.readOnly && !ready()), onclick: () => download(e) }),
      );
    }));
  };

  save.onclick = () => saveSelected(false);
  saveNew.onclick = () => saveSelected(true);
  keep.onclick = keepSelected;
  upload.onclick = () => file.click();
  file.onchange = () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    void run('Uploading', async () => {
      const { name, payload } = readPatternFile(await f.text());
      if (everyStored()) {
        const p = ev.pattern();
        const locks = ev.load(p, payload, null);
        status.textContent = `${patternName(p)} is "${name}": sending the patch stores it on the FM-1${locks === 'dropped' ? `; ${LOCKS_LEFT_OUT}` : ''}`;
        return;
      }
      await device.putPattern(0, name, payload);
      onFm1 = await device.listPatterns();
      status.textContent = `"${name}" is on the FM-1`;
    });
  };
  readBtn.onclick = () => void readDevice();

  root.append(
    el('div', { class: 'lib-cols' },
      el('section', { class: 'card lib-col', ariaLabel: 'This patch' },
        el('h2', {}, el('span', { class: 'mtag src', textContent: 'PATCH' }), 'This patch'),
        el('p', { class: 'muted', textContent: 'The selected pattern and the stored patterns this patch links. A linked pattern is shared: saving it changes every patch that links it, so Save as new makes a copy. On firmware 1.26 sending the patch stores its patterns 2–64, each linked to the patch, and Keep a copy keeps the selected pattern in the store under its own name, linked to no patch.' }),
        hereEl,
        el('div', { class: 'toolbar lib-foot' }, save, saveNew, keep, upload, file),
      ),
      el('section', { class: 'card lib-col', ariaLabel: 'FM-1' },
        el('h2', {}, el('span', { class: 'mtag util', textContent: 'FM-1' }), 'FM-1', stateEl),
        el('p', { class: 'muted', textContent: 'The FM-1’s pattern store, then the factory patterns (read-only). Load copies one into the selected pattern.' }),
        el('div', { class: 'toolbar' }, readBtn),
        listEl,
        roomEl,
        status,
      ),
    ),
  );
  refresh();
  return {
    refresh,
    enter() {
      refresh();
      if (store()) void readDevice();
    },
    deviceChanged(shown) {
      onFm1 = null;
      refresh();
      if (shown && store()) void readDevice();
    },
  };
}
