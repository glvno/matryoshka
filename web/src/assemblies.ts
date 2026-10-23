// SPDX-License-Identifier: GPL-3.0-only
// The assembly library: the factory set shipped with the editor (src/assemblies/*.json) and the user's own, kept in
// localStorage, each one in the file format of assembly.ts. Library > Assemblies lists the user's own: rename, export,
// import, delete (at once, with Undo); the factory set is in the assembly browser and the palette (#218).
import { validateAssemblyDef, type AssemblyDef } from './assembly';
import { renamedKey } from './storage-key';
import { DEFS } from './modules';
import { defIsEngine } from './engines';
import { showUndo } from './toast';

const STORE = renamedKey('matryoshka.assemblies', 'modular-1.assemblies');

/** the shelves of the assembly browser and the palette, in display order; the user's own come first under their own shelf */
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

/** put a definition into the user library; one of that name is replaced at once. Returns what happened and an undo
 *  (the replaced one back, or the new one out), for an Undo toast */
export function storeAssembly(def: AssemblyDef): { result: 'saved' | 'replaced'; undo: () => void } {
  const list = loadLibrary();
  const i = list.findIndex((d) => d.name === def.name);
  const was = i >= 0 ? list[i] : null;
  if (i >= 0) list[i] = def;
  else list.push(def);
  saveLibrary(list);
  return {
    result: was ? 'replaced' : 'saved',
    undo: () => {
      const now = loadLibrary();
      const k = now.findIndex((d) => d.name === def.name);
      if (k < 0) return;
      if (was) now[k] = was;
      else now.splice(k, 1);
      saveLibrary(now);
    },
  };
}

/** delete a definition from the user library; returns an undo that puts it back where it was (unless one of that name
 *  was stored since), or null when there was none */
export function removeAssembly(name: string): (() => boolean) | null {
  const list = loadLibrary();
  const i = list.findIndex((d) => d.name === name);
  if (i < 0) return null;
  const [gone] = list.splice(i, 1);
  saveLibrary(list);
  return () => {
    const now = loadLibrary();
    if (now.some((d) => d.name === name)) return false;
    now.splice(Math.min(i, now.length), 0, gone);
    saveLibrary(now);
    return true;
  };
}

/** rename a definition in the user library; false when it is missing or the new name is taken */
export function renameAssembly(from: string, to: string): boolean {
  const name = to.trim();
  const list = loadLibrary();
  const d = list.find((x) => x.name === from);
  if (!d || !name || list.some((x) => x.name === name)) return false;
  d.name = name;
  saveLibrary(list);
  return true;
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

/** a row's line: a factory engine's blurb, else the module list (`summary`) */
export const describe = (d: AssemblyDef): string => d.blurb ?? summary(d);

export function download(def: AssemblyDef): void {
  const blob = new Blob([JSON.stringify(def, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${def.name.replace(/[^\w.-]+/g, '_') || 'assembly'}.assembly.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export interface LibraryEvents {
  status(msg: string): void;
  /** the library changed here (the palette, the assembly browser and the tutorial reread it) */
  changed(): void;
}

/** Library > Assemblies: the user's own, each with its blurb or module list, Rename, Export and Delete (at once, with
 *  Undo); Import .json. The FM-1 stores none (they travel inside patches). Returns a refresh for when the library changed
 *  elsewhere (a save from a card). */
export function buildAssembliesSection(root: HTMLElement, ev: LibraryEvents): () => void {
  const userEl = el('div', { class: 'bank-list' });
  const count = el('span', { class: 'muted' });
  const row = (d: AssemblyDef): HTMLElement =>
    el(
      'div',
      { class: 'bank-row' },
      el('span', { class: 'grow' }, ...(defIsEngine(d) ? [engineTag(), ' '] : []), el('b', { textContent: d.name }), ' ', el('span', { class: 'muted', textContent: describe(d) })),
      el('button', { textContent: 'Rename', title: `rename "${d.name}"`, onclick: () => {
        const to = window.prompt(`Rename the assembly "${d.name}" to:`, d.name)?.trim();
        if (!to || to === d.name) return;
        ev.status(renameAssembly(d.name, to) ? `"${d.name}" is now "${to}" (patches that hold it keep their copy)` : `"${to}" is taken in your assemblies`);
        changed();
      } }),
      el('button', { textContent: 'Export', title: 'Download as a .json file', onclick: () => download(d) }),
      el('button', {
        class: 'delete',
        textContent: 'Delete',
        title: `delete "${d.name}" from your assemblies (you can undo it; patches that hold it keep their copy)`,
        onclick: () => {
          const undo = removeAssembly(d.name);
          if (!undo) return;
          changed();
          showUndo(`"${d.name}" deleted from your assemblies`, () => {
            ev.status(undo() ? `"${d.name}" is back in your assemblies` : `"${d.name}" was stored again since: the deleted one was not put back`);
            changed();
          });
        },
      }),
    );
  const refresh = (): void => {
    const list = loadLibrary();
    count.textContent = `${list.length} assembl${list.length === 1 ? 'y' : 'ies'}`;
    userEl.replaceChildren(...(list.length ? list.map(row) : [el('p', { class: 'muted', textContent: 'None yet. Select modules in the patch, click "Make assembly", then "save" on its card.' })]));
  };
  const changed = (): void => {
    refresh();
    ev.changed();
  };
  const file = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  file.onchange = async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try {
      const def = validateAssemblyDef(JSON.parse(await f.text()), DEFS);
      const { result, undo } = storeAssembly(def);
      ev.status(`"${def.name}" ${result === 'replaced' ? 'replaced in' : 'added to'} your assemblies`);
      if (result === 'replaced') showUndo(`"${def.name}" replaced in your assemblies`, () => { undo(); changed(); });
      changed();
    } catch (e) {
      ev.status(`import failed: ${(e as Error).message}`);
    }
  };
  root.append(
    el(
      'section',
      { class: 'card lib-single', ariaLabel: 'Your assemblies' },
      el('h2', {}, el('span', { class: 'mtag asm', textContent: 'ASM' }), 'Your assemblies', count),
      el('p', { class: 'muted', textContent: 'An assembly is a building block: prewired modules that appear as one card with the ports and parameters it exposes. Make one from a selection in the patch and "save" it on its card; + Assembly and the palette insert it.' }),
      userEl,
      el('div', { class: 'row' }, el('label', { class: 'btn', textContent: 'Import .json' }, file)),
      el('p', { class: 'muted lib-note', textContent: 'The FM-1 stores no assemblies: they travel inside patches.' }),
    ),
  );
  refresh();
  return refresh;
}
