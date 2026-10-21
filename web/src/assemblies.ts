// SPDX-License-Identifier: GPL-3.0-only
// The assembly library: the factory set shipped with the editor (src/assemblies/*.json) and the user's own, kept in
// localStorage, each one in the file format of assembly.ts. The Library page lists them: insert, export, import, delete.
import { validateAssemblyDef, type AssemblyDef } from './assembly';
import { renamedKey } from './storage-key';
import { DEFS } from './modules';
import { defIsEngine } from './engines';

const STORE = renamedKey('matryoshka.assemblies', 'modular-1.assemblies');

/** the shelves of the assembly browser and the Library page, in display order; the user's own come first under their own shelf */
export const CATEGORIES = ['Drums', 'Voices', 'Effects', 'Textures', 'Utilities'] as const;
export const USER_SHELF = 'Your library';
/** a factory definition's shelf (an unknown or missing one lands on the last shelf) */
export const categoryOf = (d: AssemblyDef): string => (CATEGORIES as readonly string[]).includes(d.category ?? '') ? d.category! : CATEGORIES[CATEGORIES.length - 1];
/** the shelf of the engines (engines.ts), first among the factory shelves: derived from the ports, not a `category` */
export const ENGINE_SHELF = 'Engines';
/** the factory shelves in display order */
export const FACTORY_SHELVES = [ENGINE_SHELF, ...CATEGORIES];
/** a factory definition's shelves: an engine goes on Engines instead of Voices, and stays on any other shelf as well (the
 *  drum kit is on Engines and Drums) */
export const shelvesOf = (d: AssemblyDef): string[] => {
  const c = categoryOf(d);
  return defIsEngine(d) ? (c === 'Voices' ? [ENGINE_SHELF] : [ENGINE_SHELF, c]) : [c];
};
/** what a shelf holds, in a line under its name */
export const SHELF_NOTES: Record<string, string> = {
  [ENGINE_SHELF]: 'Whole instruments. Pick one, play the keys.',
  Voices: 'One note each. Build an engine from them, or turn on Poly.',
};
/** the ENGINE tag on a row of an engine */
export const engineTag = (): HTMLElement => el('span', { class: 'mtag eng', textContent: 'ENGINE', title: 'Takes keys, makes sound.' });

/** the assemblies shipped with the editor, in file order */
export const FACTORY: AssemblyDef[] = Object.entries(import.meta.glob('./assemblies/*.json', { eager: true, import: 'default' }) as Record<string, unknown>)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, raw]) => validateAssemblyDef(JSON.parse(JSON.stringify(raw)), DEFS));

export function loadLibrary(): AssemblyDef[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? 'null') as unknown;
    if (Array.isArray(raw)) return raw.flatMap((d) => {
      try {
        return [validateAssemblyDef(d, DEFS)];
      } catch {
        return [];
      }
    });
  } catch {
    /* fall through */
  }
  return [];
}

export function saveLibrary(list: AssemblyDef[]): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch {
    /* storage blocked: the library is not remembered */
  }
}

/** put a definition into the user library; a name that exists is replaced after a confirm. Returns what happened. */
export function storeAssembly(def: AssemblyDef, confirm: (msg: string) => boolean = (m) => window.confirm(m)): 'saved' | 'replaced' | 'cancelled' {
  const list = loadLibrary();
  const i = list.findIndex((d) => d.name === def.name);
  if (i >= 0) {
    if (!confirm(`Replace the assembly "${def.name}" in the library?`)) return 'cancelled';
    list[i] = def;
    saveLibrary(list);
    return 'replaced';
  }
  list.push(def);
  saveLibrary(list);
  return 'saved';
}

/** Tutorial saves preserve earlier user instruments and fail visibly if storage is unavailable. */
export function storeTutorialAssembly(def: AssemblyDef): void {
  const list = loadLibrary();
  const same = (d: AssemblyDef): boolean => d.name === def.name || !!def.tutorial && d.tutorial === def.tutorial;
  const old = list.filter(same);
  const kept = list.filter((d) => !same(d));
  for (const d of old) {
    if (JSON.stringify({ ...d, tutorial: undefined }) === JSON.stringify({ ...def, tutorial: undefined })) continue;
    let n = 1;
    while (kept.some((x) => x.name === `${d.name} (previous ${n})`)) n++;
    kept.push({ ...d, name: `${d.name} (previous ${n})`, tutorial: undefined });
  }
  localStorage.setItem(STORE, JSON.stringify([...kept, def]));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) e.className = String(cls);
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

/** the module names and the exposed ports in one line */
export const summary = (d: AssemblyDef): string => {
  const io = [d.inputs.map((r) => r.label).join(', '), d.outputs.map((r) => r.label).join(', ')].filter(Boolean).join(' → ');
  return `${d.modules.map((m) => DEFS[m.type].label).join(' + ')}${io ? ` · ${io}` : ''}`;
};

export function download(def: AssemblyDef): void {
  const blob = new Blob([JSON.stringify(def, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${def.name.replace(/[^\w.-]+/g, '_') || 'assembly'}.assembly.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export interface LibraryEvents {
  insert(def: AssemblyDef): void;
  status(msg: string): void;
}

/** the assemblies section of the Library page. Returns a refresh function for when the library changed elsewhere (a save from the editor). */
export function buildAssembliesTab(root: HTMLElement, ev: LibraryEvents): () => void {
  const userEl = el('div', { class: 'bank-list' });
  const factoryEl = el('div');
  const note = el('p', { class: 'muted' });
  const row = (d: AssemblyDef, user: boolean): HTMLElement =>
    el(
      'div',
      { class: 'bank-row' },
      el('span', { class: 'grow' }, ...(defIsEngine(d) ? [engineTag(), ' '] : []), el('b', { textContent: d.name }), ' ', el('span', { class: 'muted', textContent: summary(d) })),
      el('button', { textContent: 'Insert', title: 'Put it into the patch', onclick: () => ev.insert(d) }),
      el('button', { textContent: 'Export', title: 'Download as a .json file', onclick: () => download(d) }),
      ...(user
        ? [
            el('button', {
              textContent: '×',
              title: 'Delete from the library',
              onclick: () => {
                if (!window.confirm(`Delete the assembly "${d.name}" from the library?`)) return;
                saveLibrary(loadLibrary().filter((x) => x.name !== d.name));
                refresh();
              },
            }),
          ]
        : []),
    );
  const refresh = (): void => {
    const list = loadLibrary();
    userEl.replaceChildren(...list.map((d) => row(d, true)));
    note.textContent = list.length ? '' : 'None yet. Select modules in the patch, click "Make assembly", then "save" on its card.';
    factoryEl.replaceChildren(
      ...FACTORY_SHELVES.flatMap((c) => {
        const ds = FACTORY.filter((d) => shelvesOf(d).includes(c));
        const sub = SHELF_NOTES[c];
        return ds.length ? [el('h4', { textContent: c }), ...(sub ? [el('p', { class: 'muted', textContent: sub })] : []), el('div', { class: 'bank-list' }, ...ds.map((d) => row(d, false)))] : [];
      }),
    );
  };
  const file = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  file.onchange = async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try {
      const def = validateAssemblyDef(JSON.parse(await f.text()), DEFS);
      const r = storeAssembly(def);
      ev.status(r === 'cancelled' ? 'import cancelled' : `"${def.name}" ${r === 'replaced' ? 'replaced in' : 'added to'} the library`);
      refresh();
    } catch (e) {
      ev.status(`import failed: ${(e as Error).message}`);
    }
  };
  root.append(
    el(
      'div',
      { class: 'card' },
      el('h2', {}, el('span', { class: 'mtag asm', textContent: 'ASM' }), 'Assemblies'),
      el('p', { class: 'muted', textContent: 'An assembly is a building block: prewired modules that appear as one card with the ports and parameters it exposes, never the Main panel or the Output. Make one from a selection in the patch and "save" it on its card; "Insert assembly" in the toolbar puts any of these into the patch.' }),
      el('h3', { textContent: USER_SHELF }),
      userEl,
      note,
      el('div', { class: 'row' }, el('label', { class: 'btn', textContent: 'Import .json' }, file)),
      el('h3', { textContent: 'Factory' }),
      factoryEl,
    ),
  );
  refresh();
  return refresh;
}
