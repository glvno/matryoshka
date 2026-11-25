// SPDX-License-Identifier: GPL-3.0-only
// The effects to add (FX drawer, #1214): Library › Effects, the sidebar's Add effect dialog and the + list's effect rows
// all read effectCatalog: fx-drawer.ts EFFECT_CATALOG and the user's library assemblies marked Use as an effect, grouped by
// how each effect sits in a drawer's stereo chain. Every add path puts the effect on the canvas first, an ordinary card
// cabled by hand as + Module and + Assembly make it; an FX drawer is the second choice. Dragging a row (pointer events, as
// patch-drag.ts) drops it on the canvas as a new card, or on an FX plug or open drawer to put it there (editor.ts dropEffect).
import { insertAssembly, parentOf, toDef, assembliesOf, type AssemblyDef, type AssemblyInst } from './assembly';
import { loadLibrary } from './assemblies';
import { applyPreset, presetsFor, userPresets, type Preset } from './device-presets';
import { cardCosts, cpuEstimate } from './cpu';
import { keyOf, type CommandKey } from './commands';
import { addDrawer, catalogEffectDef, CHAIN_MODE_LABELS, drawerOf, drawerOfEffect, EFFECT_CATALOG, effectKind, insertEffect, outputDrawer, ownerOf, type ChainMode, type EffectEntry } from './fx-drawer';
import { score } from './fuzzy';
import { popMenu } from './menu';
import { DEFS } from './modules';
import { newPatch, type Patch } from './patch';
import { defStructure } from './structure';
import { DRAG_START_PX } from './patch-drag';

/** what adding an effect puts in: a catalog entry's module type or assembly definition (insertEffect wraps either for a drawer) */
export type EffectSource = EffectEntry['source'];

/** the Library's groups, in display order: how an effect sits in a drawer's stereo chain (fx-drawer.ts ChainMode) */
export const MODES: readonly { mode: ChainMode; title: string; tag: string; tip: string }[] = [
  { mode: 'stereo', title: CHAIN_MODE_LABELS.stereo, tag: 'stereo', tip: 'Makes a left and a right side of its own.' },
  { mode: 'pair', title: CHAIN_MODE_LABELS.pair, tag: 'in stereo', tip: 'In a drawer it runs in stereo: a copy for each side with one set of knobs, twice the CPU of one.' },
  { mode: 'wet', title: CHAIN_MODE_LABELS.wet, tag: 'wet', tip: 'In a drawer it hears a mix of both sides and adds its sound to each; the dry sound stays stereo. A Reverb crossfades dry and wet, as on the canvas.' },
];
export const modeOf = (mode: ChainMode): (typeof MODES)[number] => MODES.find((m) => m.mode === mode)!;

/** the user's library assemblies marked Use as an effect (AssemblyDef.fxMode), as entries beside the factory's */
export const userEffects = (library: readonly AssemblyDef[] = loadLibrary()): EffectEntry[] =>
  library.flatMap((d) => (d.fxMode ? [{ name: d.name, mode: d.fxMode, blurb: d.blurb ?? 'Your own assembly.', source: { def: d } }] : []));

/** every effect the Library offers: the factory's, then the user's own */
export const effectCatalog = (): EffectEntry[] => [...EFFECT_CATALOG, ...userEffects()];

/** the catalog's effects by group, each group in catalog order; empty groups left out */
export const effectGroups = (catalog: readonly EffectEntry[] = effectCatalog()): { mode: ChainMode; title: string; entries: EffectEntry[] }[] =>
  MODES.map((m) => ({ mode: m.mode, title: m.title, entries: catalog.filter((e) => e.mode === m.mode) })).filter((g) => g.entries.length);

/** the catalog entry a module type or an assembly is, if it is an effect */
export function entryOf(source: EffectSource, catalog: readonly EffectEntry[] = effectCatalog()): EffectEntry | undefined {
  return catalog.find((e) => ('type' in source ? 'type' in e.source && e.source.type === source.type : 'def' in e.source && e.source.def.name === source.def.name));
}

const structures = new WeakMap<EffectEntry, { drawer: string; legacy: string; all: string[] }>();
/** the structures an entry's presets belong to: its drawer form's (the wrapper), its 1.26 drawer form's (an L/R pair, a
 *  Reverb with helpers: fx-drawer.ts WrapForm) and its canvas card's when that is an assembly of its own */
function formsOf(entry: EffectEntry): { drawer: string; legacy: string; all: string[] } {
  let s = structures.get(entry);
  if (!s) {
    const drawer = defStructure(catalogEffectDef(entry)), legacy = defStructure(catalogEffectDef(entry, { legacy: true }));
    const all = [drawer, legacy, ...('def' in entry.source ? [defStructure(entry.source.def)] : [])];
    structures.set(entry, (s = { drawer, legacy, all: [...new Set(all)] }));
  }
  return s;
}
export const entryStructures = (entry: EffectEntry): string[] => formsOf(entry).all;

/** how many presets an entry has (the factory's and the user's, for either form) */
export const presetCount = (entry: EffectEntry): number => entryStructures(entry).reduce((n, s) => n + presetsFor(s).length, 0);

const cpus = new WeakMap<EffectEntry, number>();
/** an entry's share of the FM-1's audio time in a drawer (a stereo module or an L/R pair counts both copies, D-1413), from cpu.ts */
export function effectCpu(entry: EffectEntry): number {
  let c = cpus.get(entry);
  if (c === undefined) {
    // in a scratch patch's Output drawer, so the estimate hears it (cpu.ts counts only modules the Output hears)
    const p = newPatch(DEFS);
    const a = insertEffect(p, addDrawer(p, 'output'), entry.source);
    c = cardCosts(p, cpuEstimate(p)).assemblies.get(a.id)?.share ?? 0;
    cpus.set(entry, c);
  }
  return c;
}
export const cpuText = (share: number): string => `${(100 * share).toFixed(1)} %`;

/** one of the user's presets for an effect: `wrapped` when it was stored from the effect's drawer form, `legacy` from its
 *  1.26 drawer form */
export interface EffectPreset { preset: Preset; entry: EffectEntry; wrapped: boolean; legacy?: true }

/** the user's presets that belong to an effect of the catalog, by effect then name */
export function effectPresets(list: Preset[] = userPresets(), catalog: readonly EffectEntry[] = effectCatalog()): EffectPreset[] {
  const out: EffectPreset[] = [];
  for (const preset of list) {
    for (const entry of catalog) {
      const s = formsOf(entry);
      if (!s.all.includes(preset.structure)) continue;
      const legacy = preset.structure === s.legacy && preset.structure !== s.drawer;
      out.push({ preset, entry, wrapped: preset.structure === s.drawer || legacy, ...(legacy ? { legacy: true as const } : {}) });
      break;
    }
  }
  return out.sort((a, b) => a.entry.name.localeCompare(b.entry.name) || a.preset.name.localeCompare(b.preset.name, undefined, { numeric: true }));
}

/** an effect preset as a definition to add: the form it was stored from, set to its values */
export function presetSource(ep: EffectPreset): { def: AssemblyDef } {
  const base = ep.wrapped || !('def' in ep.entry.source) ? catalogEffectDef(ep.entry, { legacy: ep.legacy }) : ep.entry.source.def;
  const p = newPatch(DEFS);
  const a = insertAssembly(p, DEFS, base, 0, 0);
  if (!applyPreset(p, a, ep.preset)) throw new Error(`The preset "${ep.preset.name}" does not fit this ${ep.entry.name}.`);
  return { def: toDef(p, a) };
}

const audioOut = (p: Patch, a: AssemblyInst): boolean => a.outputs.some((r) => {
  const m = p.modules.find((x) => x.id === r.module);
  return !!m && DEFS[m.type]?.outputs.find((o) => o.name === r.port)?.kind === 'audio';
});

/** the instruments an FX drawer can belong to: top-level assemblies with an audio output that are neither a drawer nor an
 *  effect, plus any that has a drawer already */
export const instrumentsOf = (p: Patch): AssemblyInst[] =>
  assembliesOf(p).filter((a) => !parentOf(p, a.id) && !a.drawer && (!!drawerOf(p, a.id) || (!a.chain && !a.fxMode && effectKind(a.name) === null && audioOut(p, a))));

/** where "Add to an FX drawer" can put an effect: each instrument's drawer (made when it has none), then the Output's */
export interface DrawerTarget { to: number | 'output'; label: string; detail: string }

/** a drawer's name in a menu: "Hera 4’s FX", "Output FX" */
export const drawerName = (p: Patch, to: number | 'output'): string => {
  if (to === 'output') return 'Output FX';
  const a = assembliesOf(p).find((x) => x.id === to);
  return `${a ? a.label || a.name : '?'}’s FX`;
};

export function drawerTargets(p: Patch): DrawerTarget[] {
  const out: DrawerTarget[] = instrumentsOf(p).map((a) => ({ to: a.id, label: drawerName(p, a.id), detail: drawerOf(p, a.id) ? 'at the end' : 'new drawer' }));
  if (p.modules.some((m) => m.type === 'output')) out.push({ to: 'output', label: drawerName(p, 'output'), detail: outputDrawer(p) ? 'at the end' : 'new drawer' });
  return out;
}

/** put an effect into a drawer (made first when the instrument or the Output has none) at `at` (default: the end), and open
 *  the drawer so the new effect shows; returns the effect */
export function addToDrawer(p: Patch, source: EffectSource, to: number | 'output', at?: number): AssemblyInst {
  const drawer = (to === 'output' ? outputDrawer(p) : drawerOf(p, to)) ?? addDrawer(p, to);
  const effect = at === undefined ? insertEffect(p, drawer, source) : insertEffect(p, drawer, source, at);
  drawer.open = true;
  return effect;
}

/** the drawer's owner as a target: an instrument's id or 'output' */
export const ownerTarget = (p: Patch, drawer: AssemblyInst): number | 'output' => {
  const o = ownerOf(p, drawer);
  return o === 'output' ? 'output' : o.id;
};

/** the instrument ⇧⏎ adds to: the selected one (or the one whose drawer or effect is selected), else the one whose page
 *  is focused, else an armed one, else the patch's only instrument */
export function currentInstrument(p: Patch, at: { assemblies?: Iterable<number>; focus?: string | null; armed?: Iterable<string> } = {}): AssemblyInst | undefined {
  const instruments = instrumentsOf(p);
  const resolve = (id: number): AssemblyInst | undefined => {
    const a = assembliesOf(p).find((x) => x.id === id);
    if (!a) return undefined;
    const drawer = a.drawer ? a : drawerOfEffect(p, a.id);
    if (drawer) {
      const o = ownerOf(p, drawer);
      return o === 'output' ? undefined : o;
    }
    return instruments.find((x) => x.id === id);
  };
  const keyed = (key: string | null | undefined): AssemblyInst | undefined => (key && /^a\d+$/.test(key) ? resolve(Number(key.slice(1))) : undefined);
  for (const id of at.assemblies ?? []) {
    const a = resolve(id);
    if (a) return a;
  }
  const f = keyed(at.focus);
  if (f) return f;
  for (const k of at.armed ?? []) {
    const a = keyed(k);
    if (a) return a;
  }
  return instruments.length === 1 ? instruments[0] : undefined;
}

// ---- dragging an effect

/** what a drag tells the canvas: the pointer moved (null: the drag ended without a drop), and the release */
export interface EffectDragHooks {
  /** the drag began (the Library switches to the canvas) */
  start(): void;
  over(x: number, y: number): void;
  end(): void;
  /** the release; true when the effect landed (in a drawer, or on the canvas) */
  drop(source: EffectSource, x: number, y: number): boolean;
}

/** follow the pointer from this press: a drag once it moved DRAG_START_PX; a press that never moved stays a click */
export function startEffectDrag(e: PointerEvent, name: string, source: () => EffectSource, hooks: EffectDragHooks): void {
  const x0 = e.clientX, y0 = e.clientY;
  let label: HTMLElement | null = null;
  const move = (ev: PointerEvent): void => {
    if (!label && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START_PX) return;
    if (!label) {
      label = document.createElement('div');
      label.className = 'patch-drag-label fxlib-drag-label';
      label.textContent = name;
      document.body.append(label);
      document.body.classList.add('patch-dragging');
      hooks.start();
    }
    label.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 8}px)`;
    hooks.over(ev.clientX, ev.clientY);
    ev.preventDefault();
  };
  const end = (ev: PointerEvent | KeyboardEvent): void => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
    removeEventListener('keydown', key, true);
    if (!label) return;
    label.remove();
    document.body.classList.remove('patch-dragging');
    const swallow = (c: MouseEvent): void => { c.stopPropagation(); c.preventDefault(); };
    addEventListener('click', swallow, true);
    setTimeout(() => removeEventListener('click', swallow, true));
    hooks.end();
    if (ev.type === 'pointerup' && ev instanceof PointerEvent) hooks.drop(source(), ev.clientX, ev.clientY);
  };
  const key = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    ev.preventDefault();   // (Escape ends the drag only: a dialog the drag came from stays open)
    end(ev);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
  addEventListener('keydown', key, true);
}

// ---- the lists

/** what the lists do; the host (main.ts) ties them to the editor */
export interface EffectActions {
  /** the open patch (for the drawers it has) */
  patch(): Patch;
  /** add to the canvas as a new card */
  canvas(source: EffectSource, name: string): void;
  /** add into a drawer, made first when there is none */
  drawer(source: EffectSource, to: number | 'output', name: string): void;
  drag: EffectDragHooks;
  /** a source could not be made (a preset that no longer fits) */
  error(msg: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) e.className = String(cls);
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

const kindTag = (mode: ChainMode, text = modeOf(mode).tag): HTMLElement => el('span', { class: `fxlib-kind ${mode}`, textContent: text, title: modeOf(mode).tip });

/** a source made when it is used: a failing one (a preset) says why */
const made = (act: EffectActions, make: () => EffectSource, then: (s: EffectSource) => void): void => {
  let s: EffectSource;
  try {
    s = make();
  } catch (e) {
    return act.error((e as Error).message);
  }
  then(s);
};

/** the two actions of a row: Add to the canvas first, Add to an FX drawer ▾ (each instrument's drawer, the Output's) */
function rowActions(act: EffectActions, name: string, make: () => EffectSource): HTMLElement {
  const menu = el('button', { type: 'button', class: 'fxlib-drawer-btn', textContent: 'Add to an FX drawer ▾', title: 'Put it into an instrument’s FX drawer or the Output FX instead' });
  menu.setAttribute('aria-haspopup', 'menu');
  menu.onclick = () => {
    const targets = drawerTargets(act.patch());
    if (!targets.length) return act.error('This patch has no instrument and no Output for an FX drawer.');
    popMenu(targets.map((t) => ({ text: t.label, key: t.detail, run: () => made(act, make, (s) => act.drawer(s, t.to, name)) })), menu);
  };
  return el('span', { class: 'fxlib-actions' },
    el('button', { type: 'button', class: 'primary', textContent: 'Add to the canvas', title: 'A new card on the canvas, cabled by hand', onclick: () => made(act, make, (s) => act.canvas(s, name)) }),
    menu);
}

/** a row's press starts a drag, except on its buttons */
const draggable = (row: HTMLElement, act: EffectActions, name: string, make: () => EffectSource): void => {
  row.classList.add('fxlib-drag-source');
  row.onpointerdown = (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    startEffectDrag(e, name, () => make(), act.drag);
  };
};

function effectRow(act: EffectActions, entry: EffectEntry): HTMLElement {
  const n = presetCount(entry);
  const pair = entry.mode === 'pair';
  const row = el('div', { class: 'fxlib-row' },
    el('span', { class: 'fxlib-grip', textContent: '⠿', title: 'Drag onto the canvas, an FX plug or an open drawer', ariaHidden: 'true' }),
    el('b', { class: 'fxlib-name', textContent: entry.name }),
    kindTag(entry.mode),
    el('span', { class: 'fxlib-cpu', textContent: cpuText(effectCpu(entry)), title: `About ${cpuText(effectCpu(entry))} of the FM-1’s audio time in a drawer${pair ? ', both copies' : ''}. A model estimate, not a measurement.` }),
    el('span', { class: 'fxlib-blurb', textContent: `${entry.blurb}${n ? ` ${n} preset${n === 1 ? '' : 's'}.` : ''}` }),
    rowActions(act, entry.name, () => entry.source));
  draggable(row, act, entry.name, () => entry.source);
  return row;
}

function presetRow(act: EffectActions, ep: EffectPreset): HTMLElement {
  const make = (): EffectSource => presetSource(ep);
  const row = el('div', { class: 'fxlib-row fxlib-preset' },
    el('span', { class: 'fxlib-grip', textContent: '⠿', ariaHidden: 'true' }),
    el('b', { class: 'fxlib-name', textContent: ep.preset.name }),
    kindTag(ep.entry.mode, ep.entry.name),
    rowActions(act, ep.preset.name, make));
  draggable(row, act, ep.preset.name, make);
  return row;
}

/** Library › Effects, built into `root`: the effects by group, and the user's effect presets */
export function buildEffectsSection(root: HTMLElement, act: EffectActions): { refresh(): void } {
  const list = el('div', { class: 'fxlib-list' });
  const mine = el('div', { class: 'fxlib-list' });
  const refresh = (): void => {
    list.replaceChildren(...effectGroups().flatMap((g) => [el('div', { class: 'fxlib-group', textContent: g.title }), ...g.entries.map((e) => effectRow(act, e))]));
    const presets = effectPresets();
    mine.replaceChildren(...(presets.length ? presets.map((ep) => presetRow(act, ep))
      : [el('p', { class: 'muted', textContent: 'None yet. Store one from an effect card’s preset chip.' })]));
  };
  root.append(el('div', { class: 'lib-cols fxlib-cols' },
    el('section', { class: 'card lib-col', ariaLabel: 'Effects' },
      el('h2', {}, el('span', { class: 'mtag fx', textContent: 'FX' }), 'Effects'),
      el('p', { class: 'muted', textContent: 'Add an effect to the canvas as a card you cable yourself, or put it into an FX drawer, where it joins a stereo chain. Drag a row onto the canvas, an FX plug or an open drawer.' }),
      list),
    el('section', { class: 'card lib-col', ariaLabel: 'Effect presets' },
      el('h2', {}, el('span', { class: 'mtag src', textContent: 'MINE' }), 'Effect presets'),
      el('p', { class: 'muted', textContent: 'Your stored settings of single effects. Each one adds that effect set to its values.' }),
      mine)));
  refresh();
  return { refresh };
}

// ---- Add effect: the sidebar's + Effect opens the same list as a dialog

/** what Add effect does besides the lists: the instrument ⇧⏎ fills */
export interface EffectDialogActions extends EffectActions {
  /** the instrument whose FX drawer ⇧⏎ fills (currentInstrument), if any */
  current(): AssemblyInst | undefined;
}

/** how a row ranks for a query: each word in its name (fuzzy, as Commands) or as written in its group, kind or blurb (a
 *  fuzzy match in a whole sentence would keep nearly every row); -1 = left out */
export function effectRank(query: string, name: string, context: string): number {
  const text = context.toLowerCase();
  let rank = 0;
  for (const word of query.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    const s = score(word, name);
    if (s >= 0) rank += s + 100;
    else if (text.includes(word)) rank += 1;
    else return -1;
  }
  return rank;
}

/** a row of Add effect: what the search reads, and what it adds */
interface PickRow { row: HTMLElement; name: string; context: string; make: () => EffectSource }

/** Add effect, built into `dialog`: a search field over Library › Effects' rows (the effects by group, then the user's
 *  effect presets). ↑ ↓ choose a row; ⏎ (or a click on it) adds it to the canvas, ⇧⏎ into the current instrument's FX
 *  drawer, ⌥⏎ into the Output FX, as in the + list. Adding closes it, as do Esc and a click outside. A drag from it fades
 *  it until the release, and brings it back when the effect did not land */
export function buildEffectsDialog(dialog: HTMLDialogElement, host: EffectDialogActions): { open(): void } {
  const input = el('input', { type: 'text', placeholder: 'Find an effect or one of your effect presets…', autocomplete: 'off', spellcheck: false });
  for (const [k, v] of [['role', 'combobox'], ['aria-label', 'Search effects'], ['aria-controls', 'fxpick-list'], ['aria-expanded', 'true'], ['aria-autocomplete', 'list']]) input.setAttribute(k, v);
  const list = el('div', { class: 'fxpick-list', id: 'fxpick-list' });
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Effects');
  const hint = el('div', { class: 'fxpick-hint' });
  dialog.replaceChildren(
    el('div', { class: 'fxpick-head' },
      el('span', { class: 'mtag fx', textContent: 'FX' }), input,
      el('button', { type: 'button', class: 'fxpick-close', textContent: '×', ariaLabel: 'Close Add effect', onclick: () => dialog.close() })),
    list, hint);

  const act: EffectActions = {
    ...host,
    canvas(s, name) { dialog.close(); host.canvas(s, name); },
    drawer(s, to, name) { dialog.close(); host.drawer(s, to, name); },
    drag: {
      // (shown without the backdrop while faded, so the canvas, its plugs and drawers show through)
      start() { dialog.close(); dialog.show(); dialog.classList.add('fxpick-dragging'); host.drag.start(); },
      over: (x, y) => host.drag.over(x, y),
      end() { host.drag.end(); dialog.classList.remove('fxpick-dragging'); dialog.close(); dialog.showModal(); input.focus(); },
      drop(s, x, y) {
        const landed = host.drag.drop(s, x, y);
        if (landed) dialog.close();
        return landed;
      },
    },
  };

  let groups: { head: HTMLElement; rows: PickRow[] }[] = [];
  let shown: PickRow[] = [];
  let sel = 0;
  let ids = 0;
  const pick = (row: HTMLElement, name: string, context: string, make: () => EffectSource): PickRow => {
    row.id = `fxpick-${ids++}`;
    row.setAttribute('role', 'option');
    row.onclick = (e) => { if (!(e.target as HTMLElement).closest('button')) made(act, make, (s) => act.canvas(s, name)); };
    // a finger drags from the grip only: elsewhere it scrolls the list (style.css)
    const press = row.onpointerdown!;
    row.onpointerdown = (e) => { if (e.pointerType !== 'touch' || (e.target as HTMLElement).closest('.fxlib-grip')) press.call(row, e); };
    return { row, name, context, make };
  };
  const select = (i: number, scroll = true): void => {
    sel = i;
    shown.forEach((r, j) => {
      r.row.classList.toggle('sel', j === i);
      r.row.setAttribute('aria-selected', String(j === i));
    });
    const r = shown[i];
    if (!r) return input.removeAttribute('aria-activedescendant');
    input.setAttribute('aria-activedescendant', r.row.id);
    if (scroll) r.row.scrollIntoView?.({ block: 'nearest' });
  };
  const render = (): void => {
    const q = input.value.trim();
    const all = groups.flatMap((g) => g.rows);
    shown = q ? all.map((r) => ({ r, rank: effectRank(q, r.name, r.context) })).filter((x) => x.rank >= 0).sort((a, b) => b.rank - a.rank).map((x) => x.r) : all;
    list.replaceChildren(...(q ? shown.map((r) => r.row) : groups.flatMap((g) => [g.head, ...g.rows.map((r) => r.row)])));
    if (!shown.length) list.append(el('p', { class: 'muted fxpick-none', textContent: `No effect matches “${q}”.` }));
    list.scrollTop = 0;
    select(0, false);
  };
  const add = (r: PickRow, key: CommandKey | null): void => {
    const into = key === 'shift' ? host.current()?.id : key === 'alt' && host.patch().modules.some((m) => m.type === 'output') ? 'output' : undefined;
    made(act, r.make, (s) => (into === undefined ? act.canvas(s, r.name) : act.drawer(s, into, r.name)));
  };
  const key = (k: string): HTMLElement => el('kbd', { textContent: k });

  input.oninput = render;
  dialog.addEventListener('keydown', (e) => {
    e.stopPropagation();   // (the canvas's shortcuts wait until it closes)
    if (e.target !== input) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length) select((sel + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[sel]) add(shown[sel], keyOf(e));
    }
  });
  // a press on the backdrop (outside the dialog's box) closes it
  dialog.addEventListener('pointerdown', (e) => {
    if (e.target !== dialog) return;
    const b = dialog.getBoundingClientRect();
    if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) dialog.close();
  });

  return {
    open() {
      groups = effectGroups().map((g) => ({
        head: el('div', { class: 'fxlib-group', textContent: g.title }),
        rows: g.entries.map((e) => pick(effectRow(act, e), e.name, `${g.title} ${modeOf(e.mode).tag} ${e.blurb}`, () => e.source)),
      }));
      const presets = effectPresets();
      if (presets.length) groups.push({
        head: el('div', { class: 'fxlib-group', textContent: 'Your effect presets' }),
        rows: presets.map((ep) => pick(presetRow(act, ep), ep.preset.name, `preset ${ep.entry.name} ${modeOf(ep.entry.mode).title}`, () => presetSource(ep))),
      });
      const p = host.patch(), current = host.current();
      hint.replaceChildren(
        el('span', {}, key('↑ ↓'), ' choose · ', key('⏎'), ' on the canvas',
          ...(current ? [' · ', key('⇧⏎'), ` into ${drawerName(p, current.id)}`] : []),
          ...(p.modules.some((m) => m.type === 'output') ? [' · ', key('⌥⏎'), ' into the Output FX'] : [])),
        el('span', { textContent: 'Drag a row onto the canvas or an FX plug · Esc to close' }));
      input.value = '';
      render();
      dialog.showModal();
      input.focus();
    },
  };
}
