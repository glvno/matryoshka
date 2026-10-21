// SPDX-License-Identifier: GPL-3.0-only
// "Start with an engine" (glvno/matryoshka#160): New patch opens this dialog outside the tutorial. One tile per factory
// engine (the Engines shelf, engines.ts) with its name, its one-line description (the blurb, else the module list), MONO / STEREO and the estimated CPU on the FM-1; a pick
// gives a new patch with that engine wired to the keys and the Output (Editor.insert). Under the grid: the empty canvas
// (today's New patch, also Esc) and the factory patches (the Open picker).
import { describe, ENGINE_SHELF } from './assemblies';
import { insertAssembly, type AssemblyDef } from './assembly';
import { assemblyShelves } from './catalog';
import { defIsStereo, wireEngine } from './engines';
import { DEFS } from './modules';
import { deviceBudget } from './patchbin';
import { newPatch, type Patch } from './patch';

export interface EngineTile {
  def: AssemblyDef;
  name: string;
  line: string;
  stereo: boolean;
  /** the estimated CPU on the FM-1 in %, null when the patch would not fit or cannot be counted */
  cpu: number | null;
}

/** a new patch with just this engine, wired as an insert wires it (what a pick gives, before the canvas places the card) */
export function enginePatch(def: AssemblyDef): Patch {
  const p = newPatch(DEFS);
  wireEngine(p, insertAssembly(p, DEFS, def, 20, 300));
  return p;
}

const cpuMemo = new Map<string, number | null>();
/** the CPU % of a new patch with this engine, counted once per name */
export function engineCpu(def: AssemblyDef): number | null {
  if (!cpuMemo.has(def.name)) {
    let pct: number | null = null;
    try {
      const b = deviceBudget(enginePatch(def));
      if (b.fits) pct = Math.round(b.cpu.use * 100);
    } catch {
      /* cannot be counted: shown as — */
    }
    cpuMemo.set(def.name, pct);
  }
  return cpuMemo.get(def.name)!;
}

/** the tiles: the Engines shelf in its order */
export const engineTiles = (): EngineTile[] =>
  assemblyShelves()
    .filter((a) => a.shelf === ENGINE_SHELF)
    .map(({ def }) => ({ def, name: def.name, line: describe(def), stereo: defIsStereo(def), cpu: engineCpu(def) }));

export interface EngineStartEvents {
  /** a tile was picked */
  pick(def: AssemblyDef): void;
  /** the empty canvas: the link, Esc, or a close */
  empty(): void;
  /** the factory patches: the Open picker */
  openPicker(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) e.className = String(cls);
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

export class EngineStart {
  private grid = el('div', { class: 'engine-grid' });
  /** what closed the dialog: a pick or the picker link leaves the patch to them; anything else is the empty canvas */
  private handled = false;

  constructor(private dlg: HTMLDialogElement, private ev: EngineStartEvents) {
    this.grid.setAttribute('role', 'group');
    this.grid.setAttribute('aria-label', 'Engines');
    const link = (text: string, run: () => void): HTMLButtonElement => {
      const b = el('button', { type: 'button', class: 'link', textContent: text });
      b.onclick = run;
      return b;
    };
    const close = el('button', { type: 'button', class: 'help-close', textContent: '×' });
    close.setAttribute('aria-label', 'Close: start from an empty canvas');
    close.onclick = () => this.dlg.close();
    dlg.replaceChildren(
      el('div', { class: 'shead' }, el('span', { class: 'mtag util', textContent: 'NEW' }), el('span', { class: 'stitle', textContent: 'New patch' }), close),
      el(
        'div',
        { class: 'engine-start-body' },
        el('h2', { id: 'engine-start-title', textContent: 'Start with an engine' }),
        el('p', { class: 'muted', textContent: 'An engine is a whole instrument: it takes keys and makes sound. Pick one and it arrives wired to the keyboard, ready to play. The effects, the sequencing and the routing are yours to add.' }),
        this.grid,
        el(
          'div',
          { class: 'engine-start-links' },
          el('span', {}, 'Know what you’re doing? ', link('Start from an empty canvas', () => this.dlg.close())),
          el('span', {}, 'Or ', link('open a factory patch', () => this.done(() => this.ev.openPicker()))),
        ),
      ),
    );
    dlg.addEventListener('close', () => {
      if (!this.handled) this.ev.empty();
    });
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close(); // a click on the backdrop
    });
    this.grid.addEventListener('keydown', (e) => this.arrows(e));
  }

  open(): void {
    this.handled = false;
    const tiles = engineTiles();
    this.grid.replaceChildren(
      ...tiles.map((t) => {
        const b = el(
          'button',
          { type: 'button', class: 'engine-tile' },
          el('span', { class: 'engine-tile-top' }, el('span', { class: 'engine-out', textContent: t.stereo ? 'STEREO' : 'MONO' }), el('span', { class: 'engine-cpu', textContent: t.cpu === null ? 'CPU —' : `CPU ${t.cpu} %`, title: 'Estimated load on the FM-1' })),
          el('span', { class: 'engine-name', textContent: t.name }),
          el('span', { class: 'engine-line', textContent: t.line }),
        );
        b.onclick = () => this.done(() => this.ev.pick(t.def));
        return b;
      }),
    );
    this.dlg.showModal();
    this.grid.querySelector<HTMLButtonElement>('button')?.focus();
  }

  private done(run: () => void): void {
    this.handled = true;
    this.dlg.close();
    run();
  }

  /** the arrow keys move between tiles: left / right one, up / down a row */
  private arrows(e: KeyboardEvent): void {
    const tiles = [...this.grid.querySelectorAll<HTMLButtonElement>('button')];
    const i = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0 || !tiles.length) return;
    const cols = Math.max(1, tiles.filter((t) => t.offsetTop === tiles[0].offsetTop).length);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (!step) return;
    e.preventDefault();
    tiles[Math.min(tiles.length - 1, Math.max(0, i + step))].focus();
  }
}
