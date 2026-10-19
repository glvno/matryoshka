// SPDX-License-Identifier: GPL-3.0-only
// Patch editor: module cards on a canvas, SVG cables, drag-to-connect, a selection, assemblies and undo.
import { resizeHandle } from './resize-handle';
import { parseValue } from './value-input';
import { isTextEntry } from './input';
import { lockOf } from './relevance';
import { tidy, tidyAssembly } from './tidy';
import { DEFS, PANEL_BUTTONS } from './modules';
import { FM1_BUTTON_ROWS, buttonKind, jackColumn, tracePath } from './dock-buttons';
import { buttonLight, kindOf, pageList, setPages, switches, toggleEngaged, toggleTargets, type ButtonKind } from './buttons';
import { buttonEditor } from './button-editor';
import { positionPopover } from './popover';
import { parameterInputs, connectParameter, setInputRoute } from './parameter-routing';
import { parameterMenu } from './parameter-menu';
import { sliderJack } from './slider-jack';
import { devicesOf, findRow, fixFocus, groupStarts, moduleRows, pageTitle, PAGE_ROWS, type Device, type Page, type PageRow } from './pages';
import { cableRole } from './cable-role';
import type { ParameterValues } from './engine';
import { deviceBudget, DEVICE } from './patchbin';
import { choiceName, formatValue, longName, moduleName, moduleTag } from './labels';
import { picker } from './picker';
import { selector } from './selector';
import { ALLOC, copiesOf, makeRoom, polyGroups, polyOfModule, setPoly } from './poly';
import { dragControl } from './deck';
import { isPin, PinsInUse, removeRoute } from './parameter-routing';
import {
  addModule,
  fromUnit,
  toUnit,
  connect,
  disconnect,
  removeModule,
  sameEnd,
  type Cable,
  type Endpoint,
  type SideKey,
  type ModuleDef,
  type ModuleInst,
  type Patch,
  type PortDef,
  type ParamDef,
  flawOf,
  isFlawless,
  type PolyCards,
  sameStructure,
  setMorphTarget,
  clearMorph,
  hasMorph,
  ensureMain,
  EDITOR_ONLY,
  rowDef,
  PAGE_LIST_MAX,
  panelLabel,
  STEPS_MAX,
  setStepValue,
} from './patch';
import { stepGrid, type StepGrid } from './step-grid';
import { FlawPanel } from './flaws-panel';
import { clipText, copyItems, pasteClip, type Clip } from './clipboard';
import { GUTTER_ROOM, ribbons, type RibbonCable, type RibbonFrame } from './ribbons';
import type { ScreenSpec } from './scope-view';
import type { EnvSpec } from './env-view';
import { EXCLUDED_TYPES,
  addChild,
  addMember,
  allModules,
  assemblyById,
  assembliesOf,
  assemblyOf,
  childrenOf,
  deleteAssembly,
  demote,
  depthOf,
  descendants,
  exposePort,
  findRef,
  fixAssemblies,
  freeSpot,
  hiddenAssemblies,
  hiddenModules,
  hidePort,
  insertAssembly,
  isExposed,
  isPromoted,
  makeAssembly,
  mergePorts,
  moveAssembly,
  overlapping,
  parentOf,
  promote,
  reconcileAll,
  removeChild,
  removeMember,
  targetsOf,
  tileMembers,
  toDef,
  ungroup,
  unmergePort,
  type AssemblyDef,
  type AssemblyInst,
  type PortRef,
  type Rect,
  type Target, type ParamRef, GRID, bypassAssembly, paramColumns, moveParam, moveRef, setColumnBreak, setGroupBreak, setHeading, setSpan, spanPlan, type SpanBlock } from './assembly';

const SVGNS = 'http://www.w3.org/2000/svg';
/** a Page button held this long shows its list's first page while it is down (panel.c PAGE_HOLD_MS) */
const PAGE_HOLD_MS = 400;

/** a dock button's kind mark (board E): Toggle a power sign, Gate a pulse */
function kindMark(kind: ButtonKind | 'main'): SVGSVGElement {
  const svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
  svg.setAttribute('class', `pb-mark ${kind}`);
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  const path = (d: string): void => { const e = document.createElementNS(SVGNS, 'path'); e.setAttribute('d', d); svg.append(e); };
  if (kind === 'main') { path('M6 1.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 1 1 0-9z'); path('M6 4.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3z'); }
  else if (kind === 'bypass') { path('M6 1.5v4'); path('M3.3 3.6a4 4 0 1 0 5.4 0'); }
  else if (kind === 'page') { path('M3 1.5h6a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-6a1.5 1.5 0 0 1-1.5-1.5v-6a1.5 1.5 0 0 1 1.5-1.5z'); path('M4 4.5h4M4 7.5h4'); }
  else path('M1 9h3V3h4v6h3');
  return svg;
}
const HISTORY = 40;
/** a logarithmic slider's value rounded to the parameter's step (a glide time to the ms, a cutoff to the Hz), not to a whole number */
function snapTo(pd: ParamDef, v: number): number {
  const step = pd.step ?? 0;
  const x = step > 0 ? Math.round(v / step) * step : v;
  return Math.min(pd.max, Math.max(pd.min, Number(x.toFixed(6))));
}

/** the frame around an expanded assembly: padding around its cards and the height of its header */
const FRAME_PAD = 12;
/** left / right: room inside the border for the inner half of the ribbons (ribbons.ts) */
const FRAME_PAD_X = 32;
const FRAME_HEAD = 30;
/** a poly assembly's frame: the settings strip under the header, and the width it needs */

export interface EditorEvents {
  /** structure changed (modules or cables): the engine needs the whole patch */
  onStructure(p: Patch): void;
  /** another patch was opened (setPatch), before its onStructure */
  onLoad?(p: Patch): void;
  /** a knob moved: cheap update */
  onParam(id: number, name: string, value: number): void;
  /** an attenuverter of a parameter input moved (index 0 = p1, 1 = p2) */
  onAtt(id: number, index: number, value: number): void;
  /** a module's bypass switch (the structure is unchanged: the engine keeps its state) */
  onBypass(id: number, on: boolean): void;
  /** a step of a Steps module changed (its byte, patch.ts stepByte), a Steps module muted (not saved) */
  onStep?(id: number, k: number, b: number): void;
  onMute?(id: number, on: boolean): void;
  /** a Steps module's step got a new note / velocity (#93) */
  onStepValue?(id: number, k: number, note: number, vel: number): void;
  /** a macro range of p1 / p2 (index 0 / 1) on a parameter changed or was removed (null) */
  onRange(id: number, index: number, name: string, range: [number, number] | null): void;
  /** the transport (the Play switch: the Main module's run output and clock; editor state, not saved) */
  onTransport(on: boolean): void;
  /** a patch button of the Main module (PANEL_BUTTONS index) held / let go or switched */
  onButton?(i: number, on: boolean): void;
  /** the device page Main's knobs edit changed in the editor (a device key and page of devicesOf): the FM-1 can follow */
  onFocus?(device: string, page: number): void;
  /** cards were moved: positions changed, nothing the engine needs */
  onLayout(p: Patch): void;
  /** the displays drawn this time (after every rebuild): Scope screens with what is cabled into each input, envelope shapes */
  onScreens?(screens: ScreenSpec[], envs: EnvSpec[]): void;
  /** a message for the status line */
  onError(msg: string): void;
  /** "save" on an assembly: put this definition into the library */
  onSaveAssembly(def: AssemblyDef): void;
  /** undo or redo happened (the tutorial counts them) */
  onHistory?(kind: 'undo' | 'redo'): void;
  /** the patches the morph picker on the Main card offers as the B side (those of the same structure are listed) */
  morphCandidates?(): { name: string; patch: Patch }[];
}

/** an SVG path through a cubic Bézier's four points */
/** how a cable leaves a jack: sideways, up (a docked jack) or down (a jack under a card's bottom edge) */
type CableEnd = 'side' | 'up' | 'down';
/** the straight run of a cable out of its jack at full slack, px */
const CABLE_STUB = 20;
/** the zoom's range (the wheel, pinch, fit and the sidebar's zoom slider) */
export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 2;
/** a chain of cubic Béziers: a start point, then three points per segment */
const pathOf = ([a, ...rest]: { x: number; y: number }[]): string => {
  let d = `M${a.x},${a.y}`;
  for (let i = 0; i + 2 < rest.length; i += 3) d += ` C${rest[i].x},${rest[i].y} ${rest[i + 1].x},${rest[i + 1].y} ${rest[i + 2].x},${rest[i + 2].y}`;
  return d;
};

/** how far (px) beyond the jack's sides the strip a docked cable is drawn in over the panel reaches: none, so a cable
 * that bends away (to a module below the canvas's view) shows only its straight stub above the jack */
const CLIP_HALF = 0;
/** presses closer than this belong to one gesture (a double-click's two presses) */
const TYPE_GAP_MS = 400;
/** a gesture made without a pointer (arrow keys, the wheel) ends this long after its last change */
const GESTURE_IDLE_MS = 600;
type Pt = { x: number; y: number };
/** the footprint of a new card for the free-spot search: a grid cell less its gutters */
const CARD_W = 300;
const CARD_H = 540;
/** how far each paste of the same clip lands from the last (down and right) */
const PASTE_STEP = 40;
/** a collapsed assembly card's footprint width: a grid cell per column (`.module.assembly.cols` in style.css) */
const cardWidth = (params: ParamRef[]): number => {
  const n = paramColumns(params).length;
  return n > 1 ? n * GRID.x - 20 : CARD_W;
};
/** jacks on each side edge of a card; the rest hang off its bottom edge */
const EDGE_JACKS = 4;
/** an input for a card's edge layout: its row element and which port it is (a parameter's dedicated input joins its row) */
type EdgePort = { el: HTMLElement; module: number; port: string };
/** a parameter for a card's edge layout: its row, its dedicated input, a column break before it, rows above it (a heading) */
/** `gap`: a new group (FM-1 page) starts at this row within its column, drawn as a divider above it */
type EdgeParam = { el: HTMLElement; input?: Target; col?: boolean; above?: HTMLElement[]; span?: number; gap?: boolean };
/** an entry of a card's menu: `key` is the shortcut shown at the right, `rule` a line above it */
type MenuItem = { text: string; run: () => void; key?: string; danger?: boolean; rule?: boolean };
/** a drop is judged by the card's header (where it is held), this far below its top */
const HEAD_Y = 15;
/** a touch held this long without moving is a long press */
const LONG_PRESS_MS = 500;

export class Editor {
  patch: Patch;
  /** the selected modules (shift-click or a rubber band); "Make assembly" groups them, dragging one moves all */
  readonly selected = new Set<number>();
  /** the selected assemblies (collapsed cards and expanded frames): they move, duplicate and delete with the modules */
  readonly selectedAsm = new Set<number>();
  /** assemblies expanded in this session: the first expansion tidies the inside (#37) */
  private expandedOnce = new Set<number>();
  /** how far cables sag, 0 (taut, the default) .. 1: the sidebar's setting */
  slack = 0;
  /** the sidebar sliders whose thumbs are jacks (cable slack, zoom): Patch.slackFrom / zoomFrom; set by the host */
  readonly sideThumbs = new Map<SideKey, HTMLElement>();
  /** the cables from their sources to those thumbs: in their own layer over the whole window, so they cross the sidebar */
  private sideLayer: SVGSVGElement | null = null;
  /** the patch's slack source (Patch.slackFrom) as it plays: added to `slack` */
  private slackMod = 0;
  private slackFrame = 0;
  /** the sag the cables are drawn with: the setting plus the source's signal, 0 .. 1.5 */
  private get sway(): number {
    return Math.min(1.5, Math.max(0, this.slack + this.slackMod));
  }
  private modulesEl: HTMLElement;
  private svg: SVGSVGElement;
  private preview: SVGSVGElement;
  private world: HTMLElement;
  private space: HTMLElement;
  private ports = new Map<string, HTMLElement>();
  private cards = new Map<number, HTMLElement>();
  private frames = new Map<number, HTMLElement>();
  /** the collapsed assembly cards on the canvas */
  private containers = new Map<number, HTMLElement>();
  private drag: { path: SVGPathElement; cancel: () => void } | null = null;
  private sliderPorts: { m: ModuleInst; pd: ParamDef; jack: HTMLElement; ticks: (t: { knob: string; unit: number }[]) => void }[] = [];
  private cablePaths: { path: SVGPathElement; from: HTMLElement; to: HTMLElement; origin: HTMLElement; cable?: Cable }[] = [];
  private stack: string[] = [];
  private routingOpen = new Set<string>();
/** undo steps: the patch snapshot and the A / B side it belongs to (a flip is a step; undoing it goes back to that side) */
  private history: { s: string; side: 'A' | 'B' }[] = [];
  private future: { s: string; side: 'A' | 'B' }[] = [];
  private parameterDisplays: { id: number; update: (values: Record<string, number> | null) => void; el?: HTMLElement }[] = [];
  /** the patch's devices (pages.ts) and the page Main's knobs K1..K4 edit: the dock's DEVICE / PAGE pickers or a click on a
   * row choose it, the FM-1 too with Live on */
  devices: Device[] = [];
  focus: { device: string; page: number } | null = null;
  /** the dock's knob column (re-filled when the focus moves) and its dials, K1..K4 */
  private focusCol: HTMLElement | null = null;
  /** the knobs' binding jacks on the dock's top edge (the dotted wires to the focused rows start there) */
  private knobJacks: HTMLElement[] = [];
  /** the dock's button column, whose SVG holds the traces from the patch buttons to their jacks */
  private buttonCol: HTMLElement | null = null;
  private dials: HTMLElement[] = [];
  /** the dotted lines from the dials to the rows they turn, over everything */
  private bindLayer: SVGSVGElement | null = null;

  /** Display only: never write telemetry into the patch, undo history, or parameter callbacks. */
  showParameterValues(values: ParameterValues | null): void {
    if (values && (this.drag || this.armed)) return; // Keep drop targets still while patching.
    const byId = new Map(values?.map((m) => [m.id, m.params]));
    for (const display of this.parameterDisplays) display.update(byId.get(display.id) ?? null);
    this.positionCables();
  }

  /**
   * `dock`: where the Main module lives (the panel above the keyboard) instead of a card. Every patch has one Main there;
   * it cannot be removed. Cables from its jacks run off the bottom of the canvas to the panel.
   */
  constructor(private canvas: HTMLElement, patch: Patch, private ev: EditorEvents, private dock: HTMLElement | null = null) {
    this.patch = patch;
    if (dock) ensureMain(this.patch, DEFS);
    this.modulesEl = canvas.querySelector('#modules')!;
    this.svg = canvas.querySelector('#cables')! as unknown as SVGSVGElement;
    this.preview = canvas.querySelector('#patch-preview')! as unknown as SVGSVGElement;
    this.world = canvas.querySelector('#patch-world')!;
    this.space = canvas.querySelector('#canvas-space')!;
    this.report(fixAssemblies(this.patch, DEFS));
    new ResizeObserver(() => { this.sizeCanvas(); this.positionCables(); }).observe(canvas);
    if (dock) {
      // the docked jacks stay put while the canvas scrolls under them
      canvas.addEventListener('scroll', () => this.positionCables(), { passive: true });
      dock.addEventListener('scroll', () => this.positionCables(), { passive: true, capture: true });
      new ResizeObserver(() => this.positionCables()).observe(dock);
    }
    document.fonts.addEventListener('loadingdone', () => {
      this.layoutFrames(); this.sizeCanvas(); this.positionCables();
    });
    canvas.addEventListener('pointerdown', (e) => this.rubberBand(e));
    this.touchGestures();
    const raise = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const card = target.closest<HTMLElement>('.module, .frame');
      if (card) this.raiseCard(card);
    };
    canvas.addEventListener('pointerdown', raise, true);
    window.addEventListener('pointerdown', () => { this.pointerHeld = true; }, true);
    const release = (): void => {
      this.pointerHeld = false;
      if (this.gesture !== null) window.setTimeout(() => { if (!this.pointerHeld) this.endGesture(); }); // after the control's own pointerup
    };
    for (const type of ['pointerup', 'pointercancel'] as const) window.addEventListener(type, release, true);
    window.addEventListener('blur', release);
    canvas.addEventListener('focusin', raise);
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (!(e.metaKey || e.ctrlKey) || (k !== 'z' && !(k === 'y' && e.ctrlKey && !e.metaKey))) return;
      if (!this.canvas.checkVisibility() || document.querySelector('dialog[open], [popover]:popover-open')) return;
      const t = e.target as HTMLElement | null;
      if (t && isTextEntry(t)) return; // a text field's own undo
      e.preventDefault();
      if (e.shiftKey || k === 'y') this.redo();
      else this.undo();
    });
    this.rebuild();
    canvas.addEventListener('scroll', () => this.queueView(), { passive: true });
    this.restoreView();
  }

  setPatch(p: Patch): void {
    this.patch = p;
    if (this.dock) ensureMain(this.patch, DEFS);
    this.report(fixAssemblies(this.patch, DEFS));
    this.history = [];
    this.future = [];
    this.dropGesture();
    this.snapshots.A = this.snapshots.B = null;
    this.side = 'A';
    this.routingOpen.clear();
    this.stack = [];
    this.selected.clear();
    this.selectedAsm.clear();
    this.expandedOnce.clear();
    this.rebuild();
    this.restoreView();
    this.ev.onLoad?.(p);
    this.ev.onStructure(p);
  }

  // ---- the patch remembers where it was looked at (Patch.view): the user's zoom and the canvas's scroll, in layout pixels
  /** the user's zoom: a source on the zoom slider (a live zoom) moves `zoom` but is not remembered */
  private userZoom = 1;
  private viewTimer = 0;
  /** set while a patch's view is put back: the zoom that causes is not the user's gesture (the tutorial's zoom step) */
  restoring = false;

  /** a patch opens where it was last looked at; one without a view keeps the current one (and gets it on the next move) */
  private restoreView(): void {
    const v = this.patch.view;
    if (!v) return;
    clearTimeout(this.viewTimer);
    this.restoring = true;
    try {
      this.setZoom(v.zoom);
    } finally {
      this.restoring = false;
    }
    this.canvas.scrollTo(v.x * this.zoom, v.y * this.zoom);
  }

  private queueView(): void {
    clearTimeout(this.viewTimer);
    this.viewTimer = window.setTimeout(() => this.stampView(), 300);
  }

  /** write the current view into the patch, saved like a layout change (no undo step, no engine reload) */
  private stampView(): void {
    const c = this.canvas;
    const v = { zoom: this.userZoom, x: Math.round(c.scrollLeft / this.zoom), y: Math.round(c.scrollTop / this.zoom) };
    const o = this.patch.view;
    if (o && o.zoom === v.zoom && o.x === v.x && o.y === v.y) return;
    this.patch.view = v;
    this.ev.onLayout(this.patch);
  }

  private report(msgs: string[]): void {
    if (msgs.length) this.ev.onError(msgs.join('; '));
  }

  /** where the next card goes: the first grid cell that no visible card, container or frame touches; `w` = its width */
  private slot(w = CARD_W): Pt {
    const rect = (el: HTMLElement): Rect => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
    const occupied = [...this.cards.values(), ...this.containers.values(), ...this.frames.values()].map(rect);
    // before the first layout the elements have no size: fall back to the model's positions
    if (occupied.some((r) => !r.w)) {
      const hidden = hiddenModules(this.patch);
      const hiddenAsm = hiddenAssemblies(this.patch);
      occupied.length = 0;
      for (const m of this.patch.modules) if (!hidden.has(m.id)) occupied.push({ x: m.x, y: m.y, w: CARD_W, h: CARD_H });
      for (const a of assembliesOf(this.patch)) if (!a.open && !hiddenAsm.has(a.id)) occupied.push({ x: a.x, y: a.y, w: cardWidth(a.params), h: CARD_H });
    }
    return freeSpot(occupied, w, CARD_H);
  }

  add(type: string): void {
    const at = this.slot();
    this.change(() => {
      addModule(this.patch, DEFS[type], at.x, at.y);
    });
  }

  /** put a saved assembly into the patch */
  insert(def: AssemblyDef): void {
    const at = this.slot(cardWidth(def.params));
    if (this.change(() => insertAssembly(this.patch, DEFS, def, at.x, at.y))) this.ev.onError(`"${def.name}" inserted. Knob assignments (K1..K4) are not kept: tick them in the patch.`);
  }

  /** group the selected modules into a new assembly */
  makeAssembly(): void {
    const set = this.dragSet();
    if (!set.mods.length && !set.asms.length) return this.ev.onError('select the modules first: shift-click them, or drag a box on the canvas');
    // a patch's own modules never go into a building block: they stay outside, the rest is grouped
    const ids = set.mods.filter((m) => !EXCLUDED_TYPES.has(m.type)).map((m) => m.id);
    if (!ids.length) return this.ev.onError(set.asms.length ? 'select at least one module with the assemblies: they go inside the new one' : 'the Main panel and the Output stay outside an assembly: select other modules');
    const name = window.prompt('Name of the assembly', 'assembly')?.trim();
    if (!name) return;
    const kept = ids.length < set.mods.length;
    // selected assemblies become children of the new one
    if (this.change(() => {
      const made = makeAssembly(this.patch, ids, name);
      for (const a of set.asms) addChild(this.patch, made, a.id);
    })) {
      this.selected.clear();
      this.selectedAsm.clear();
      if (kept) this.ev.onError('Main and Output stay outside');
    }
  }

  // ---- undo
  // Snapshots of the patch. A structural change (`change`) is one step; an edit by a control (a slider drag, a switch, a
  // card drag, a run of arrow keys) is a gesture: `touch` before its first change keeps the patch as it was, and the
  // gesture becomes one step when the pointer is let go, or GESTURE_IDLE_MS after its last change without a pointer.

  /** the patch as an undo snapshot: without the view (zoom, scroll), the keyboard's octave and the name, which undo leaves alone */
  private snap(): string {
    const { view: _view, octave: _octave, name: _name, ...rest } = this.patch;
    return JSON.stringify(rest);
  }

  /** a snapshot as the patch, keeping the current view and octave */
  private revive(s: string): Patch {
    const p = JSON.parse(s) as Patch;
    p.name = this.patch.name;
    if (this.patch.view) p.view = this.patch.view;
    if (this.patch.octave !== undefined) p.octave = this.patch.octave;
    return p;
  }

  /** one undo step from `before` (a snap) to now, if anything changed; inside an open gesture the gesture's step covers it */
  private commit(before: string, side = this.side): boolean {
    if (before === this.snap()) return false;
    if (this.gesture !== null) return true;
    this.history.push({ s: before, side });
    if (this.history.length > HISTORY) this.history.shift();
    this.future = [];
    return true;
  }

  /** the patch before a discrete change (a snap): a gesture of keys or the wheel still open ends first, so the two stay
   * separate steps; a pointer gesture stays open (a drag's drop into a frame is part of the drag) */
  private mark(): string {
    if (this.gesture !== null && !this.gesturePointer) this.endGesture();
    return this.snap();
  }

  /** the patch before the open gesture's first change (null: none open) */
  private gesture: string | null = null;
  /** the open gesture began with a pointer down (it ends at the release, not on a timer) */
  private gesturePointer = false;
  private gestureTimer = 0;
  /** a pointer is down somewhere: a gesture it makes ends when it is let go */
  private pointerHeld = false;

  /** a control is about to change the patch: open a gesture, or keep the open one going */
  touch(): void {
    if (this.gesture !== null && !this.gesturePointer && this.pointerHeld) this.endGesture(); // keys, then a drag: two steps
    if (this.gesture === null) {
      this.gesture = this.snap();
      this.gesturePointer = this.pointerHeld;
    }
    window.clearTimeout(this.gestureTimer);
    if (!this.pointerHeld) this.gestureTimer = window.setTimeout(() => this.endGesture(), GESTURE_IDLE_MS);
  }

  /** close the open gesture: one undo step if it changed anything */
  endGesture(): void {
    window.clearTimeout(this.gestureTimer);
    const before = this.gesture;
    this.gesture = null;
    if (before !== null) this.commit(before);
  }

  /** drop an open gesture without a step (the patch was replaced) */
  private dropGesture(): void {
    window.clearTimeout(this.gestureTimer);
    this.gesture = null;
  }

  undo(): void {
    if (this.gesture !== null && this.pointerHeld) return; // not in the middle of a drag: it would go on moving a replaced patch
    this.endGesture();
    const e = this.history.pop();
    if (e === undefined) return this.ev.onError('nothing to undo');
    this.future.push({ s: this.snap(), side: this.side });
    this.restore(e.s);
    this.side = e.side;
    this.ev.onHistory?.('undo');
  }

  redo(): void {
    if (this.gesture !== null && this.pointerHeld) return;
    this.endGesture();
    const e = this.future.pop();
    if (e === undefined) return this.ev.onError('nothing to redo');
    this.history.push({ s: this.snap(), side: this.side });
    this.restore(e.s);
    this.side = e.side;
    this.ev.onHistory?.('redo');
  }

  /** a structural change from outside (the tutorial's "do it for me"): undoable like the editor's own */
  transact(fn: () => unknown): boolean {
    return this.change(fn);
  }

  /** select a module where it shows: itself, or the outermost collapsed assembly that hides it */
  reveal(id: number): void {
    let hidden: AssemblyInst | undefined;
    for (let a = assemblyOf(this.patch, id); a; a = parentOf(this.patch, a.id)) if (!a.open) hidden = a;
    if (!hidden) return this.selectOnly([id]);
    this.selected.clear();
    this.selectedAsm.clear();
    this.selectedAsm.add(hidden.id);
    this.rebuild();
  }

  /** select exactly these modules */
  selectOnly(ids: number[]): void {
    this.selected.clear();
    this.selectedAsm.clear();
    for (const id of ids) this.selected.add(id);
    this.rebuild();
  }

  private restore(s: string): void {
    this.dropGesture();
    this.patch = this.revive(s);
    if (!this.patch.slackFrom) this.slackMod = 0;
    // an assembly the undo closed again tidies on its next first expansion (its tidied layout went with the step)
    for (const a of assembliesOf(this.patch)) if (!a.open) this.expandedOnce.delete(a.id);
    this.selected.clear();
    this.selectedAsm.clear();
    this.rebuild();
    this.ev.onStructure(this.patch);
  }

  /**
   * A structural change: run it, keep the assemblies consistent, remember the previous state for undo, redraw and tell
   * the host. An error undoes the change and goes to the status line. Returns whether something changed.
   */
  private change(fn: () => unknown): boolean {
    const before = this.mark();
    try {
      fn();
    } catch (e) {
      this.patch = this.revive(before);
      this.rebuild();
      this.ev.onError(String((e as Error).message ?? e));
      if (e instanceof PinsInUse) this.flash(e.cables);
      return false;
    }
    this.report(reconcileAll(this.patch, DEFS).map((l) => `assembly "${l}" is empty and was removed`));
    if (!this.commit(before)) return false;
    this.rebuild();
    this.ev.onStructure(this.patch);
    return true;
  }

  private key(id: number, port: string, dir: 'out' | 'in'): string {
    return `${id}:${dir}:${port}`;
  }

  // ---- building the canvas

  rebuild(): void {
    this.cancelArm();
    this.screens = [];
    this.envScreens = [];
    this.stepGrids.clear();
    this.parameterDisplays = [];
    this.sliderPorts = [];
    this.lockers = [];
    this.cablePaths = [];
    this.drag?.cancel();
    this.svg.replaceChildren();
    this.preview.replaceChildren();
    this.modulesEl.replaceChildren();
    this.ports.clear();
    this.cards.clear();
    this.frames.clear();
    this.containers.clear();
    const copies = copiesOf(this.patch);
    const hidden = hiddenModules(this.patch);
    const hiddenAsm = hiddenAssemblies(this.patch);
    if (this.pickAsm !== null && !assembliesOf(this.patch).some((a) => a.id === this.pickAsm && a.open && !hiddenAsm.has(a.id))) this.pickAsm = null;
    // an assembly's badge: the voice count of the poly assembly it is (or is inside), else none
    const voicesOf = new Map(polyGroups(this.patch).map((g) => [g.asm.id, g.cfg.parts]));
    const perVoice = (a: AssemblyInst): number => {
      const first = allModules(this.patch, a)[0];
      const root = first === undefined ? undefined : polyOfModule(this.patch, first);
      return root ? voicesOf.get(root.id) ?? 0 : 0;
    };
    for (const id of this.selected) if (!this.patch.modules.some((m) => m.id === id) || hidden.has(id)) this.selected.delete(id);
    for (const id of this.selectedAsm) if (!assembliesOf(this.patch).some((a) => a.id === id) || hiddenAsm.has(id)) this.selectedAsm.delete(id);
    // frames of the outer assemblies first: a nested frame is drawn on top of its parent's
    const visible = assembliesOf(this.patch).filter((a) => !hiddenAsm.has(a.id));
    for (const a of [...visible].sort((u, v) => depthOf(this.patch, u) - depthOf(this.patch, v))) if (a.open) this.modulesEl.append(this.frame(a, perVoice(a)));
    this.devices = devicesOf(this.patch, DEFS);
    this.focus = fixFocus(this.devices, this.focus);
    const docked = this.docked();
    this.wheelHost?.replaceChildren();
    this.dock?.replaceChildren(...(docked ? [this.dockPanel(docked)] : []));
    for (const m of this.patch.modules) {
      if (hidden.has(m.id) || m === docked) continue;
      const a = assemblyOf(this.patch, m.id);
      this.modulesEl.append(this.card(m, DEFS[m.type], copies.get(m.id) ?? 0, a));
    }
    for (const a of visible) if (!a.open) this.modulesEl.append(this.container(a, perVoice(a), parentOf(this.patch, a.id)));
    this.markFocus();
    this.applyStack();
    if (this.buttonPop) this.fillButtonEditor();
    this.flawPanel?.sync();
    this.ev.onScreens?.(this.screens, this.envScreens);
    this.sizeCanvas();
    requestAnimationFrame(() => {
      this.layoutFrames();
      this.sizeCanvas();
      this.drawCables();
    });
  }

  private layerKey(el: HTMLElement): string { return el.dataset.asm ? `a${el.dataset.asm}` : `m${el.dataset.id}`; }

  private applyStack(): void {
    const elements = [...this.frames.values(), ...this.cards.values(), ...this.containers.values()];
    const keys = elements.map((el) => this.layerKey(el));
    this.stack = this.stack.filter((key) => keys.includes(key));
    this.stack = [...keys.filter((key) => !this.stack.includes(key)), ...this.stack];
    for (const el of elements) el.style.zIndex = String(2 + this.stack.indexOf(this.layerKey(el)));
  }

  private raiseCard(el: HTMLElement): void {
    let raised = [this.layerKey(el)];
    if (el.classList.contains('frame')) {
      const a = assembliesOf(this.patch).find((a) => a.id === Number(el.dataset.asm));
      if (a) raised = [raised[0], ...descendants(this.patch, a).map((child) => `a${child.id}`), ...allModules(this.patch, a).map((id) => `m${id}`)];
    }
    this.stack = [...this.stack.filter((key) => !raised.includes(key)), ...raised];
    this.applyStack();
  }

  private resizeAssembly(el: HTMLElement, a: AssemblyInst): void {
    let before = '';
    el.append(resizeHandle(`Resize ${a.label}`, () => this.zoom, {
      start: () => { before = this.mark(); this.raiseCard(el); },
      size: () => ({ width: el.offsetWidth, height: el.offsetHeight }),
      resize: (width, height) => {
        a.frameSize = { width: Math.min(4000, Math.max(236, width)), height: Math.min(4000, Math.max(80, height)) };
        this.layoutFrames(); this.sizeCanvas(); this.positionCables();
      },
      end: () => {
        if (this.commit(before)) this.ev.onLayout(this.patch);
      },
    }));
  }

  private sizeCanvas(): void {
    const elements = [...this.cards.values(), ...this.containers.values(), ...this.frames.values()];
    const w = Math.max(this.canvas.clientWidth / this.zoom, ...elements.map((el) => el.offsetLeft + el.offsetWidth + 32));
    const h = Math.max(this.canvas.clientHeight / this.zoom, ...elements.map((el) => el.offsetTop + el.offsetHeight + 32));
    this.world.style.width = `${w}px`;
    this.world.style.height = `${h}px`;
    this.space.style.width = `${Math.ceil(w * this.zoom)}px`;
    this.space.style.height = `${Math.ceil(h * this.zoom)}px`;
  }

  /** ×N on a card or assembly that runs once per part of its poly assembly */
  private badge(n: number): HTMLElement {
    const badge = document.createElement('span');
    badge.className = 'voices';
    badge.textContent = `×${n}`;
    badge.title = `runs once per voice (${n} voices)`;
    return badge;
  }

  private button(text: string, title: string, onclick: () => void, cls = 'sm'): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      onclick();
    };
    return b;
  }

  /** a module card; inside an expanded assembly its ports and parameters get the expose / pin toggles */
  /** the Main module shown in the dock (the first one; a second Main, from an old patch, stays a card) */
  /** the deck's bend and modulation wheels, placed in the dock under Main's jacks (set by the host, then rebuild) */
  dockWheels: { bend: HTMLElement; mod: HTMLElement } | null = null;
  /** the column beside the keyboard, as tall as the dock and the keyboard together, that holds the wheels (set by the host) */
  wheelHost: HTMLElement | null = null;
  /** the keyboard's octave buttons, shown under Main's output strip (set by the host, then rebuild) */
  dockOctave: HTMLElement | null = null;
  /** the transport's Play switch, PLAY in the dock's button block (set by the host, then rebuild) */
  dockPlay: HTMLElement | null = null;
  /** the FM-1 budget meter, shown in its own column right of the clock (set by the host, then rebuild) */
  dockBudget: HTMLElement | null = null;

  private docked(): ModuleInst | undefined {
    return this.dock ? this.patch.modules.find((m) => m.type === 'fm1') : undefined;
  }

  /**
   * The Main module as the panel above the keyboard: its jacks along the top edge (towards the canvas), the knobs
   * K1..K4 (bound to the focused page, their wires leaving fixed jacks on the edge), the FM-1's button block with the
   * patch buttons' jacks and traces (design board D, #113), then its settings.
   */
  private dockPanel(m: ModuleInst): HTMLElement {
    const def = DEFS[m.type];
    const el = document.createElement('div');
    el.className = 'dock-main';
    el.dataset.id = String(m.id);
    const title = document.createElement('span');
    title.className = 'dock-title';
    title.textContent = def.label;
    // a column: its jacks along the top (where the cables come down), the rest centred in the height that is left
    const col = (cls: string, top: HTMLElement | null, ...items: HTMLElement[]): HTMLElement => {
      const c = document.createElement('div');
      c.className = `dock-col ${cls}`;
      const body = document.createElement('div');
      body.className = 'dock-body';
      body.append(...items);
      c.append(...(top ? [top] : []), body);
      return c;
    };
    const jacks = (names: string[]): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'dock-jacks';
      for (const p of def.outputs) if (names.includes(p.name)) row.append(this.port(m, p, 'out'));
      return row;
    };
    const param = (name: string): HTMLElement => this.paramRow(m, def, def.params.find((pd) => pd.name === name)!);
    // outputs with a home next to the control or setting that makes them; the rest in the strip
    const wheels = this.dockWheels;
    const WHEELS = wheels && this.wheelHost ? ['bend', 'mod'] : [], CLOCK = ['clock', 'run'];
    const homed = [...WHEELS, ...CLOCK, ...PANEL_BUTTONS];
    const strip = jacks(def.outputs.map((p) => p.name).filter((n) => !homed.includes(n)));
    this.focusCol = document.createElement('div');
    this.focusCol.className = 'dock-focus';
    this.fillFocus();
    // the FM-1's two button rows in device order; HOME SAVE SEQ REC are the device's (greyed), PLAY the transport
    const buttons = document.createElement('div');
    buttons.className = 'dock-buttons-grid';
    FM1_BUTTON_ROWS.forEach((row, r) => row.forEach((b, c) => {
      const kind = buttonKind(b);
      const btn = kind === 'patch' ? this.dockButton(m, b, PANEL_BUTTONS.indexOf(b))
        : kind === 'play' && this.dockPlay ? this.dockPlay : this.deviceButton(b);
      if (btn === this.dockPlay) btn.classList.add('panel-btn', 'play');
      btn.style.gridArea = `${r + 1} / ${c + 1}`;
      buttons.append(btn);
    }));
    // the patch buttons' jacks in a row on the dock's edge (the buttons name them), each over its button or lane
    const buttonJacks = jacks(PANEL_BUTTONS);
    buttonJacks.className = 'dock-button-jacks';
    for (const port of buttonJacks.querySelectorAll<HTMLElement>(':scope > .port')) {
      port.querySelectorAll(':scope > span:not(.dot)').forEach((s) => s.remove());
      port.style.gridColumn = String(jackColumn(port.querySelector<HTMLElement>('.dot')?.dataset.port ?? '') + 1);
    }
    const traces = document.createElementNS(SVGNS, 'svg');
    traces.setAttribute('class', 'button-traces');
    traces.setAttribute('aria-hidden', 'true');
    const morph = param('morph');
    // the morph slider's thumb is the morph input (Main has no p1 / p2): its cables are drawn to the thumb
    for (const pd of def.params) if (pd.input) {
      const jack = this.sliderPorts.find((s) => s.m === m && s.pd === pd)?.jack;
      if (jack) this.ports.set(this.key(m.id, pd.input, 'in'), jack);
    }
    // the bend and modulation wheels (the deck's, kept across redraws) each under its output's jack, in the column beside the keyboard
    if (wheels && this.wheelHost)
      this.wheelHost.replaceChildren(...(['bend', 'mod'] as const).map((n) => {
        const box = document.createElement('div');
        box.className = 'dock-wheel';
        // the wheel's own caption names it: the jack goes without a label (its tooltip still has the name)
        const row = jacks([n]);
        row.querySelectorAll('.port > span:not(.dot)').forEach((s) => s.remove());
        box.append(row, wheels[n]);
        return box;
      }));
    el.append(title,
      col('dock-outputs', strip, ...(this.dockOctave ? [this.dockOctave] : [])),
      col('dock-knobs', null, this.focusCol),
      this.buttonCol = col('dock-buttons', buttonJacks, buttons),
      col('dock-morph', null, morph, this.morphRow()),
      col('dock-clock', jacks(CLOCK), param('tempo')),
      ...(this.dockBudget ? [col('dock-budget', null, this.dockBudget)] : []));
    this.buttonCol.prepend(traces);
    return el;
  }

  /** one of the FM-1's own buttons (HOME, SAVE, SEQ, REC): shown in its place, greyed, not part of the patch */
  private deviceButton(b: string): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'panel-btn device';
    btn.dataset.button = b;
    btn.textContent = b.toUpperCase();
    btn.disabled = true;
    btn.title = `${b.toUpperCase()}: the FM-1's own button (not part of the patch)`;
    return btn;
  }

  /** the gold traces from the patch buttons up to their jacks: straight up from the top row, ARP's through the gap
   * between the rows and up the lane right of REC (dock-buttons.ts) */
  private positionTraces(): void {
    const c = this.buttonCol, m = this.docked();
    const svg = c?.querySelector<SVGSVGElement>(':scope > svg.button-traces');
    if (!c || !svg || !m || !c.isConnected) return;
    const o = c.getBoundingClientRect();
    const top = c.querySelector(`.panel-btn[data-button="${FM1_BUTTON_ROWS[0][0]}"]`)?.getBoundingClientRect();
    const paths: SVGPathElement[] = [];
    for (const b of PANEL_BUTTONS) {
      const btn = c.querySelector(`.panel-btn[data-button="${b}"]`)?.getBoundingClientRect();
      const jack = this.ports.get(this.key(m.id, b, 'out'))?.getBoundingClientRect();
      if (!btn || !jack || !top || !btn.width || !jack.width) continue;
      const from = { x: btn.left + btn.width / 2 - o.left, y: btn.top - o.top };
      const to = { x: jack.left + jack.width / 2 - o.left, y: jack.bottom - o.top };
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', tracePath(from, to, (top.bottom + btn.top) / 2 - o.top));
      paths.push(path);
    }
    svg.replaceChildren(...paths);
  }


  private card(m: ModuleInst, def: ModuleDef, perVoice: number, open?: AssemblyInst): HTMLElement {
    const el = document.createElement('div');
    el.className = 'module' + (this.selected.has(m.id) ? ' selected' : '') + (open ? ' member' : '') + (this.picking(open) ? ' picking' : '');
    el.style.left = `${m.x}px`;
    el.style.top = `${m.y}px`;
    el.dataset.id = String(m.id);
    this.cards.set(m.id, el);

    const head = document.createElement('div');
    head.className = 'mhead';
    const title = document.createElement('span');
    title.append(this.tag(def.type), moduleName(def.type, def.label));
    if (perVoice) title.append(this.badge(perVoice));
    const tools = document.createElement('span');
    tools.className = 'tools';
    if (open) tools.append(this.outButton(open, () => this.takeOutModule(open, m)));
    if (def.type !== 'fm1' && def.type !== 'output' && !EDITOR_ONLY.has(def.type)) tools.append(this.bypassButton(m, def, el));
    const menu = (at: Pt): void => this.contextMenu(m, def, at);
    tools.append(this.moreButton(menu));
    head.append(title, tools);
    this.headMenu(head, menu);
    el.classList.toggle('off', !!m.bypass);
    this.moduleDrag(head, m);

    const body = document.createElement('div');
    body.className = 'mbody';
    const ins: EdgePort[] = [];
    for (const p of def.inputs) {
      if (!isPin(p.name)) ins.push({ el: this.port(m, p, 'in', { open, short: true }), module: m.id, port: p.name });
      else if (this.unrouted(m, p.name)) ins.push({ el: this.unroutedPort(m, p), module: m.id, port: p.name });
    }
    const outs = def.outputs.map((p) => this.port(m, p, 'out', { open, short: true }));
    // its displays first (an envelope's shape, the Scope's screen), then the parameters
    // (a Steps module's grid goes under the rows, across the card: 16 steps need the width)
    // in groups of four (one FM-1 page each)
    const steps = def.type === 'steps';
    const rows = moduleRows(def);
    const starts = groupStarts(rows.map((pd) => ({ knob: !pd.screen })));
    const params = rows.map((pd, i) => ({ el: this.paramRow(m, def, pd, { open }), input: pd.input ? { module: m.id, port: pd.input } : undefined, gap: i > 0 && starts[i] }));
    // a second Main card (from an old patch) keeps its B side under the rows
    const extra = def.type === 'fm1' ? [this.morphRow()] : steps ? def.views!.map((pd) => this.paramRow(m, def, pd, { open })) : [];
    body.append(...this.edgeLayout(ins, outs, params, extra));
    el.append(head, body);
    return el;
  }

  /** the Steps modules' grids drawn in this rebuild, by module id */
  private stepGrids = new Map<number, StepGrid>();

  /** where the Steps modules are (Engine.stepsView through the worklet): their grids' playheads and mute switches */
  showSteps(view: { id: number; pos: number; mute: boolean }[]): void {
    for (const v of view) this.stepGrids.get(v.id)?.show(v.pos, v.mute);
  }

  /** a step changed on the FM-1's SEQ page: into the patch and the grid, an undo step like an edit here (an undo sends the
   * patch back to the FM-1, so a change made there must be in the history) */
  stepFromDevice(id: number, k: number, b: number): void {
    const m = this.patch.modules.find((x) => x.id === id && x.type === 'steps');
    if (!m || k < 0 || k >= STEPS_MAX) return;
    this.touch();
    m.steps = Array.from({ length: STEPS_MAX }, (_, i) => (i === k ? b & 0x7f : m.steps?.[i] ?? 0));
    this.stepGrids.get(id)?.refresh();
    this.ev.onStep?.(id, k, b & 0x7f);
  }

  /** a step's note / velocity set on the FM-1 (a step held + K1 / K2): into the patch, an undo step as above */
  stepValueFromDevice(id: number, k: number, note: number, vel: number): void {
    const m = this.patch.modules.find((x) => x.id === id && x.type === 'steps');
    if (!m || k < 0 || k >= STEPS_MAX) return;
    this.touch();
    setStepValue(m, k, note, vel);
    this.stepGrids.get(id)?.refresh();
    this.ev.onStepValue?.(id, k, note & 0x7f, vel & 0x7f);
  }

  /** a Steps module's grid follows its length (the len slider) */
  refreshSteps(id: number): void {
    this.stepGrids.get(id)?.refresh();
  }

  /** a Steps module's grid: its edits go through the undo history and onStep / onMute; a new name is a structure change
   * (the name is in the binary the FM-1 gets) */
  private stepsRow(m: ModuleInst): StepGrid {
    const index = this.patch.modules.filter((x) => x.type === 'steps').indexOf(m);
    const grid = stepGrid(m, index, {
      set: (k, b) => {
        this.touch(); // a drag across the grid is one gesture: one undo step
        m.steps = Array.from({ length: STEPS_MAX }, (_, i) => (i === k ? b : m.steps?.[i] ?? 0));
        if (!m.steps.some((x) => x)) delete m.steps;
        this.ev.onStep?.(m.id, k, b);
      },
      begin: () => this.beginEdit(),
      name: (s) => {
        if ((m.name ?? '') === s) return;
        this.touch();
        if (s) m.name = s;
        else delete m.name;
        this.ev.onStructure(this.patch);
      },
      value: (k, note, vel) => {
        this.touch(); // a drag across the grid is one gesture: one undo step
        setStepValue(m, k, note, vel);
        this.ev.onStepValue?.(m.id, k, note, vel);
      },
      mute: (on) => this.ev.onMute?.(m.id, on),
    });
    this.stepGrids.set(m.id, grid);
    return grid;
  }

  /** the Scope screens and envelope shapes drawn in this rebuild (onScreens) */
  private screens: ScreenSpec[] = [];
  private envScreens: EnvSpec[] = [];

  /** an undo step around a change made outside the editor's own controls (a drag on an envelope's shape): call the result when done */
  beginEdit(): () => void {
    this.touch();
    return () => this.endGesture();
  }

  /** a Scope's screen: it goes on an assembly card like a parameter (pick mode, Cmd / Ctrl-click) */
  private screenRow(m: ModuleInst, pd: ParamDef, o: { open?: AssemblyInst; label?: string; rename?: () => void }): HTMLElement {
    const open = o.open;
    const row = document.createElement('div');
    row.className = 'param screen';
    if (m.type === 'steps') {                 // a Steps module's grid (step-grid.ts)
      row.className = 'param screen steps';
      row.append(this.stepsRow(m).el);
      if (open) {
        const on = isPromoted(open, m.id, pd.name);
        row.classList.toggle('shown', on);
        this.promoteClick(row, open, () => (on ? demote(open, m.id, pd.name) : promote(open, m.id, pd.name)));
        if (this.picking(open)) row.append(this.pickBox(on));
      }
      return row;
    }
    const isScope = m.type === 'scope'; // else an envelope's shape
    const screen = document.createElement('div');
    screen.className = isScope ? 'scope-screen' : 'scope-screen env-screen';
    row.append(screen);
    // its name in the corner: an assembly card's label for it (renamable there), else nothing
    if (o.label) {
      const name = document.createElement('span');
      name.className = 'screen-name' + (isScope ? '' : ' right');
      name.textContent = o.label;
      if (o.rename) {
        name.classList.add('rename');
        name.title = 'click to rename';
        name.onclick = (e) => { e.preventDefault(); o.rename!(); };
      }
      row.append(name);
    }
    if (open) {
      const on = isPromoted(open, m.id, pd.name);
      row.classList.toggle('shown', on);
      this.promoteClick(row, open, () => (on ? demote(open, m.id, pd.name) : promote(open, m.id, pd.name)));
      if (this.picking(open)) row.append(this.pickBox(on));
    }
    if (!isScope) {
      this.envScreens.push({ m, el: screen });
      return row;
    }
    const chans = ['a', 'b'].map((port) => this.patch.cables
      .filter((c) => c.to.module === m.id && c.to.port === port)
      .flatMap((c) => {
        const from = this.patch.modules.find((x) => x.id === c.from.module);
        const kind = from && DEFS[from.type].outputs.find((q) => q.name === c.from.port)?.kind;
        return kind ? [{ id: c.from.module, port: c.from.port, kind }] : [];
      }));
    this.screens.push({ m, el: screen, chans });
    row.append(this.scopeTools(m));
    return row;
  }

  /** a Scope screen's hover toolbar: its window (− / +, a 1-2-5 series) and time / spectrum */
  private scopeTools(m: ModuleInst): HTMLElement {
    const def = DEFS[m.type];
    const bar = document.createElement('div');
    bar.className = 'scope-tools';
    const timePd = def.params.find((q) => q.name === 'time')!;
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000].filter((v) => v >= timePd.min && v <= timePd.max);
    const value = document.createElement('span');
    value.className = 'scope-time';
    const show = (): void => {
      const t = m.params.time ?? timePd.default;
      const { num, unit } = t >= 1000 ? formatValue(t / 1000, 's', false) : formatValue(t, timePd.unit, false);
      value.textContent = `${num} ${unit}`;
    };
    const step = (dir: 1 | -1): void => {
      const t = m.params.time ?? timePd.default;
      const next = dir > 0 ? steps.find((v) => v > t * 1.001) : [...steps].reverse().find((v) => v < t * 0.999);
      if (next === undefined) return;
      this.setParam(m.id, 'time', next);
      show();
    };
    const shorter = this.button('−', 'Shorter window', () => step(-1), 'sm');
    const longer = this.button('+', 'Longer window', () => step(1), 'sm');
    const modes = (def.params.find((q) => q.name === 'mode')!.choices ?? []).map((name, i) => {
      const b = this.button(name === 'spectrum' ? 'FFT' : 'Wave', name === 'spectrum' ? 'Spectrum' : 'Waveform', () => {
        this.setParam(m.id, 'mode', i);
        for (const [k, x] of modes.entries()) x.setAttribute('aria-pressed', String(k === i));
      }, 'sm');
      b.setAttribute('aria-pressed', String(Math.round(m.params.mode ?? 0) === i));
      return b;
    });
    const rule = document.createElement('span');
    rule.className = 'scope-rule';
    show();
    bar.append(shorter, value, longer, rule, ...modes);
    // per voice (#54): only where something cabled in runs once per voice
    const copies = copiesOf(this.patch);
    const fed = this.patch.cables.filter((c) => c.to.module === m.id).some((c) => (copies.get(c.from.module) ?? 1) > 1);
    if (fed) {
      const on = (): boolean => Math.round(m.params.voices ?? 0) === 1;
      const each = this.button('Voices', 'Each voice as its own trace', () => {
        this.setParam(m.id, 'voices', on() ? 0 : 1);
        each.setAttribute('aria-pressed', String(on()));
      }, 'sm');
      each.setAttribute('aria-pressed', String(on()));
      const rule2 = document.createElement('span');
      rule2.className = 'scope-rule';
      bar.append(rule2, each);
    }
    // the toolbar's presses are its own: no card drag, no cable, no pick
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    return bar;
  }

  /** the tag before a card's title (VCO, VCF, ENV ...), coloured by the module's family */
  private tag(type: string | null): HTMLElement {
    const t = document.createElement('span');
    const { tag, family } = type ? moduleTag(type) : { tag: 'ASM', family: 'asm' };
    t.className = `mtag ${family}`;
    t.textContent = tag;
    return t;
  }

  /**
   * A card's body: rows of [input jack | parameter | output jack]. A parameter's dedicated input (ParamDef.input) sits on
   * its row; at most EDGE_JACKS jacks hang on each side edge (the outputs from the top, the other inputs in the free rows),
   * the rest hang off the bottom edge with their labels above them. `extra` goes under the rows, across the card.
   * An assembly card can have columns (`col` starts one) and rows above a parameter (`above`: its heading): then the
   * inputs hang on the first column's left edge, the outputs on the last one's right edge, a dedicated input of a later
   * column joins the free inputs, and each side edge takes as many jacks as the tallest column has rows.
   */
  private edgeLayout(ins: EdgePort[], outs: HTMLElement[], params: EdgeParam[], extra: HTMLElement[] = []): HTMLElement[] {
    // a row of the card: a parameter (with its headings above it) or a row only for a jack; `l` / `r` are its jacks
    type Item = { el: HTMLElement | null; above: HTMLElement[]; param?: EdgeParam; l?: HTMLElement; r?: HTMLElement };
    const cols: Item[][] = [[]];
    for (const p of params) {
      if (p.col && cols[cols.length - 1].length) cols.push([]);
      cols[cols.length - 1].push({ el: p.el, above: p.above ?? [], param: p });
    }
    const n = cols.length;
    const height = (c: Item[]): number => c.reduce((h, it) => h + 1 + it.above.length, 0);
    const cap = n > 1 ? Math.max(EDGE_JACKS, ...cols.map(height)) : EDGE_JACKS;
    // the k-th place for a jack on a side edge: the column's k-th row, then rows for jacks only under it
    const slot = (ci: number, k: number): Item => {
      const c = cols[ci];
      while (c.length <= k) c.push({ el: null, above: [] });
      return c[k];
    };
    const free = [...ins];
    let fixed = 0;
    for (const it of cols[0]) {
      const input = it.param?.input;
      const k = input ? free.findIndex((x) => x.module === input.module && x.port === input.port) : -1;
      if (k < 0) continue;
      it.l = free.splice(k, 1)[0].el;
      fixed++;
    }
    const sideIns = free.splice(0, Math.max(0, cap - fixed));
    let k = 0;
    for (const x of sideIns) {
      while (slot(0, k).l) k++;
      slot(0, k++).l = x.el;
    }
    const sideOuts = outs.slice(0, cap);
    sideOuts.forEach((el, i) => (slot(n - 1, i).r = el));
    const cell = (cls: string, child: HTMLElement | null): HTMLElement => {
      const c = document.createElement('div');
      c.className = cls;
      if (child) c.append(child);
      return c;
    };
    // a row element: the input track's cell when it reaches the card's left edge, the outputs' when it reaches the right
    const rowEl = (m: HTMLElement | null, first: boolean, last: boolean, l?: HTMLElement, r?: HTMLElement, across = 1): HTMLElement => {
      const el = document.createElement('div');
      el.className = 'erow';
      if (first) el.append(cell('el', l ?? null));
      const em = cell('em', m);
      if (across > 1) em.style.gridColumn = `span ${across}`;
      el.append(em);
      if (last) el.append(cell('er', r ?? null));
      return el;
    };
    const rowsOf = (it: Item, first: boolean, last: boolean, across = 1): HTMLElement[] => {
      const els = [...it.above.map((h) => rowEl(h, first, last, undefined, undefined, across)), rowEl(it.el, first, last, it.l, it.r, across)];
      if (it.param?.gap) els[0].classList.add('gstart');
      return els;
    };
    const grid = document.createElement('div');
    grid.className = 'erows' + (n > 1 ? ' multi' : '');
    if (n === 1) for (const it of cols[0]) grid.append(...rowsOf(it, true, true));
    else {
      // each column stacks its own rows; the first one holds the input jacks' track, the last one the outputs'. A display
      // that spans (`spanPlan`) cuts the columns it covers into stacks above it and below it. Grid lines are the whole
      // card's (1 = the input track, column c starts at c + 2, n + 3 = after the output track); each block is a subgrid
      grid.style.gridTemplateColumns = `auto repeat(${n}, minmax(0, 1fr)) auto`;
      const lineA = (c: number): number => (c === 0 ? 1 : c + 2);
      const lineB = (c: number): number => (c === n ? n + 3 : c + 2);
      const place = (el: HTMLElement, from: number, to: number, base: number): void => {
        el.style.gridColumn = `${lineA(from) - base + 1} / ${lineB(to) - base + 1}`;
      };
      const blocks = (list: SpanBlock<Item>[], base: number): HTMLElement[] => list.map((b) => {
        const el = document.createElement('div');
        if ('col' in b) {
          el.className = 'ecol';
          place(el, b.col, b.col + 1, base);
          for (const it of b.items) el.append(...rowsOf(it, b.col === 0, b.col === n - 1));
          return el;
        }
        el.className = 'egrp';
        place(el, b.from, b.to, base);
        const inner = lineA(b.from);
        const seg = (sub: SpanBlock<Item>[]): void => {
          if (!sub.length) return;
          const s = document.createElement('div');
          s.className = 'eseg';
          s.append(...blocks(sub, inner));
          el.append(s);
        };
        seg(b.above);
        el.append(...rowsOf(b.band, b.from === 0, b.to === n, b.to - b.from));
        seg(b.below);
        return el;
      });
      grid.append(...blocks(spanPlan(cols, (it) => it.param?.span), 1));
    }
    const out: HTMLElement[] = cols.some((c) => c.length) ? [grid] : [];
    out.push(...extra);
    const bottomIns = free.map((x) => x.el), bottomOuts = outs.slice(cap);
    if (bottomIns.length || bottomOuts.length) {
      const foot = document.createElement('div');
      foot.className = 'mfoot';
      const group = (els: HTMLElement[]): HTMLElement => {
        const g = document.createElement('div');
        for (const el of els) {
          el.classList.add('bottom');
          const dot = el.querySelector<HTMLElement>('.dot');
          if (dot) dot.dataset.edge = 'bottom'; // its cables leave downwards
        }
        g.append(...els);
        return g;
      };
      foot.append(group(bottomIns), group(bottomOuts));
      out.push(foot);
    }
    return out;
  }

  /** the power button of a card: bypass on / off (the through input, or silence, replaces the module's outputs) */
  private bypassButton(m: ModuleInst, def: ModuleDef, card: HTMLElement): HTMLButtonElement {
    const b = this.button('⏻', `${def.label} on / off (bypass)`, () => {
      this.touch();
      m.bypass = !m.bypass;
      if (!m.bypass) delete m.bypass;
      card.classList.toggle('off', !!m.bypass);
      b.classList.toggle('on', !m.bypass);
      this.ev.onBypass(m.id, !!m.bypass);
    }, 'pw');
    b.classList.toggle('on', !m.bypass);
    b.setAttribute('aria-pressed', String(!m.bypass));
    return b;
  }

  /** one parameter slider (or check box); `label` overrides the name (a promoted parameter on an assembly card) */
  /** redraws the value of a parameter row (the synced delay shows its time as a note length) */
  private refreshers = new WeakMap<HTMLElement, () => void>();

  private paramRow(m: ModuleInst, def: ModuleDef, pd: ParamDef, o: { open?: AssemblyInst; label?: string; rename?: () => void } = {}): HTMLElement {
    if (pd.screen) return this.screenRow(m, pd, o);
    const row = document.createElement('div');
    row.className = 'param bar';
    // a row the knobs can turn: a press on it puts its device page on Main's knobs (markFocus colours the bound ones)
    row.dataset.mod = String(m.id);
    row.dataset.param = pd.name;
    row.addEventListener('pointerdown', (e) => {
      if (e.altKey && this.addRowToList(m.id, pd.name)) { e.stopPropagation(); e.preventDefault(); return; }
      this.focusRow(m.id, pd.name);
    }, true);
    const name = document.createElement('span');
    name.textContent = o.label ?? longName(def.type, pd.name);
    // an enum parameter is a selector (a detent rail, or a drum when the names do not fit) whose jack stands on the live choice
    const choice = !!pd.choices && !pd.toggle;
    // a switch has no thumb either: its jack stands the same way, above the check box
    const jacked = choice || !!pd.toggle;
    if (jacked) row.classList.add('choice');
    if (choice) row.classList.add('sel');
    if (pd.toggle) row.classList.add('toggle');
    let pickBox: HTMLElement | null = null; // pick mode's check box, last in the row (the name stays its first child)
    if (o.open) {
      const a = o.open;
      const on = isPromoted(a, m.id, pd.name);
      row.classList.toggle('shown', on);
      this.promoteClick(row, a, () => (on ? demote(a, m.id, pd.name) : promote(a, m.id, pd.name)));
      if (this.picking(a)) pickBox = this.pickBox(on);
    }
    if (o.rename) {
      name.title = 'click to rename';
      name.classList.add('rename');
      name.onclick = (e) => {
        e.preventDefault();
        o.rename!();
      };
    }
    const val = document.createElement('output');
    // the number and its unit apart: the unit is drawn smaller (labels.ts formatValue)
    const parts = (v: number, params = m.params): { num: string; unit: string } =>
      pd.altText && params[pd.altText.when] >= 0.5 ? { num: pd.altText.text(v), unit: '' }
        : pd.choices ? { num: choiceName(def.type, pd.name, pd.choices[Math.round(v)] ?? ''), unit: '' }
        : formatValue(v, pd.unit, pd.min < 0);
    const fmt = (v: number, params = m.params): string => { const p = parts(v, params); return p.unit ? `${p.num} ${p.unit}` : p.num; };
    let shown = '';
    const show = (v: number, params = m.params): void => {
      const text = fmt(v, params);
      if (text === shown) return;
      shown = text;
      const p = parts(v, params);
      if (!p.unit) { val.textContent = p.num; return; }
      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = p.unit;
      val.replaceChildren(p.num, unit);
    };
    show(m.params[pd.name]);
    this.refreshers.set(row, () => show(m.params[pd.name]));
    const input = document.createElement('input');
    input.type = 'range';
    if (pd.log) {
      // a logarithmic parameter: the slider position is the fraction of the octaves
      input.min = '0';
      input.max = '1000';
      input.step = '1';
      input.value = String(Math.round(toUnit(pd, m.params[pd.name]) * 1000));
    } else {
      input.min = String(pd.min);
      input.max = String(pd.max);
      input.step = String(pd.step ?? (pd.max - pd.min) / 200);
      input.value = String(m.params[pd.name]);
    }
    input.setAttribute('aria-label', `${def.label} ${o.label ?? pd.name}`);
    // The thumb shows the live (modulated) value; a tick on the track marks the base. A drag moves the base by the
    // thumb's travel, so the live value stays under the pointer: `offset` = thumb - base at the start of the edit, in
    // slider units. Pointer capture also releases the edit lock when a drag ends outside the card.
    let editing = false;
    let offset = 0;
    const posOf = (v: number): number => (pd.log ? Math.round(toUnit(pd, v) * 1000) : v);
    const begin = (): void => {
      if (!editing) offset = Number(input.value) - posOf(m.params[pd.name]);
      editing = true;
    };
    input.onpointerdown = (e) => {
      if (e.altKey && (pd.input || def.paramInputs) && !pd.toggle) return;
      begin();
      input.setPointerCapture(e.pointerId);
    };
    input.onpointerup = input.onpointercancel = input.onlostpointercapture = () => { editing = false; };
    input.onkeydown = (e) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', ' '].includes(e.key)) begin();
    };
    input.onkeyup = input.onblur = () => { editing = false; };
    // the value before the latest gesture began: a double-click's first press moves the thumb, typing puts it back
    let gestureFrom = m.params[pd.name];
    let lastInput = 0;
    input.oninput = () => {
      const now = performance.now();
      if (now - lastInput > TYPE_GAP_MS) gestureFrom = m.params[pd.name];
      lastInput = now;
      const pos = Math.min(Number(input.max), Math.max(Number(input.min), Number(input.value) - offset));
      const v = pd.log ? snapTo(pd, fromUnit(pd, pos / 1000)) : Number(pos.toFixed(6));
      if (m.params[pd.name] !== v) this.touch();
      m.params[pd.name] = v;
      // the text follows the thumb: the base itself, or with modulation the live value the drag holds under the pointer
      // (the engine's reports run a poll behind, so they are not shown until the edit ends)
      const at = Number(input.value);
      show(!offset ? v : pd.log ? snapTo(pd, fromUnit(pd, at / 1000)) : Number(at.toFixed(6)));
      thumb?.setBase(offset ? toUnit(pd, v) : null);
      this.ev.onParam(m.id, pd.name, v);
      this.syncDials();
      this.relock(m.id);
    };
    if (m.type === ALLOC && pd.name === 'voices') input.addEventListener('change', () => this.rebuild()); // the ×N badges follow
    if (pd.toggle) {
      input.type = 'checkbox';
      input.checked = m.params[pd.name] >= 0.5;
      input.oninput = () => {
        const v = input.checked ? 1 : 0;
        this.touch();
        m.params[pd.name] = v;
        show(v);
        for (const el of row.parentElement?.children ?? []) this.refreshers.get(el as HTMLElement)?.(); // a toggle can change how its siblings show (altText)
        this.ev.onParam(m.id, pd.name, v);
        this.syncDials();
        this.relock(m.id);
      };
    }
    // a thumb or a picker is a jack only where a cable dropped on it has somewhere to go: the module's parameter inputs,
    // the parameter's dedicated input, or a side input already routed to it
    const canPatch = !!def.paramInputs || !!pd.input || parameterInputs(m, pd).length > 0;
    const thumb = canPatch && !pd.toggle && !choice ? sliderJack(input, (e, jack) => this.beginDrag(e, jack)) : null;
    // a slider with nothing to patch keeps the bar and a plain thumb (not a jack: no cable lands on it)
    const plain = !thumb && !pd.toggle && !choice ? sliderJack(input, () => {}) : null;
    plain?.jack.classList.replace('slider-port', 'slider-thumb');
    // the selector: its jack is the live choice's marker (routes and cables end on it, as on a slider's thumb)
    const sel = choice ? selector({
      label: longName(def.type, pd.name),
      names: pd.choices!.map((c) => choiceName(def.type, pd.name, c)),
      get: () => Math.round(m.params[pd.name]),
      set: (i) => {
        if (row.classList.contains('locked')) return;
        input.value = String(i);
        input.dispatchEvent(new Event('input'));
      },
      onPatch: canPatch ? (e, jack) => this.beginDrag(e, jack) : undefined,
    }) : null;
    if (sel && canPatch) {
      sel.jack.dataset.mod = String(m.id);
      sel.jack.dataset.param = pd.name;
      sel.jack.dataset.dir = 'in';
      sel.jack.title = `${def.label} ${longName(def.type, pd.name)}: drop a cable here to modulate it (depth in the ⋮ menu).`;
      this.sliderPorts.push({ m, pd, jack: sel.jack, ticks: sel.setKnobTicks });
    }
    // a switch's thumb is its jack: the same role as a slider's thumb (routes and cables end on it); it slides with the
    // switch's live state. A press switches; Alt, or a cable being patched, patches
    const pickJack = canPatch && pd.toggle ? document.createElement('span') : null;
    if (pickJack) {
      pickJack.className = 'dot control slider-port tog-jack';
      pickJack.dataset.mod = String(m.id);
      pickJack.dataset.param = pd.name;
      pickJack.dataset.dir = 'in';
      pickJack.title = `${def.label} ${longName(def.type, pd.name)}: drop a cable here to modulate it (depth in the ⋮ menu).`;
      pickJack.addEventListener('pointerdown', (e) => {
        if (e.altKey || pickJack.closest('.patching')) this.beginDrag(e, pickJack);
      });
      this.sliderPorts.push({ m, pd, jack: pickJack, ticks: () => {} });
    }
    const gesture = thumb ? 'Drag to adjust; Alt-drag to patch. Drop a cable on the thumb to connect.' : '';
    input.title = gesture;
    if (thumb) {
      thumb.jack.dataset.mod = String(m.id);
      thumb.jack.dataset.param = pd.name;
      thumb.jack.dataset.dir = 'in';
      thumb.jack.title = `${def.label} ${longName(def.type, pd.name)}: ${gesture}`;
      this.sliderPorts.push({ m, pd, jack: thumb.jack, ticks: thumb.setKnobTicks });
      input.addEventListener('input', () => this.positionCables());
    }
    this.parameterDisplays.push({ id: m.id, update: (values) => {
      const base = m.params[pd.name];
      const v = values?.[pd.name] ?? base;
      if (!Number.isFinite(v)) return;
      const automated = Math.abs(v - base) > 1e-6;
      const text = fmt(v, values ?? m.params);
      if (!editing) {
        const position = String(posOf(v));
        if (pd.toggle) input.checked = v >= 0.5;
        else if (input.value !== position) input.value = position;
        thumb?.update();
        thumb?.setBase(automated ? toUnit(pd, base) : null);
        sel?.update(Math.round(v), Math.round(base));
        input.title = automated ? `Live: ${text}. Base: ${fmt(base)}. ${gesture || 'Drag to edit the base value.'}` : gesture;
      }
      if (editing) return; // the edit shows its own value (oninput); a report taken before the last move would set it back
      show(v, values ?? m.params);
      input.setAttribute('aria-valuetext', text);
      row.classList.toggle('automated', automated);
    } });
    row.append(name, choice ? sel!.element : pd.toggle ? document.createElement('span') : val);
    if (canPatch) {
      const key = `${m.id}:${pd.name}`;
      row.append(parameterMenu(m, def, pd, { ...this.ev, patch: () => this.patch, change: (fn) => this.change(fn), touch: () => this.touch() }, this.routingOpen.has(key), (on) => {
        if (on) {
          this.routingOpen.clear();
          this.routingOpen.add(key);
          for (const other of this.modulesEl.querySelectorAll<HTMLDetailsElement>('.parameter-routing[open]'))
            if (other.parentElement !== row) other.open = false;
        } else this.routingOpen.delete(key);
        this.drawCables();
      }));
    }
    // a selector moves the base value through the hidden range input, so editing, undo and Live work as for a slider
    if (pd.toggle) {
      const line = document.createElement('label');
      line.className = 'toggle-line';
      const sw = document.createElement('span');
      sw.className = 'tog-switch';
      sw.append(input, ...(pickJack ? [pickJack] : []));
      line.append(sw, val);
      row.append(line);
    } else if (!choice) row.append(thumb?.element ?? plain?.element ?? input);
    if (plain) this.parameterDisplays.push({ id: m.id, update: () => { if (!editing) plain.update(); } });
    if (pickBox) row.append(pickBox);
    // a parameter with no effect in the module's current setting is dimmed and takes no direct edits (relevance.ts);
    // cables still reach its jack
    const relock = (): void => {
      const why = lockOf(this.patch, m, def.params, pd.name);
      row.classList.toggle('locked', !!why);
      input.disabled = !!why;
      if (why) row.title = why;
      else row.removeAttribute('title');
    };
    relock();
    this.lockers.push({ id: m.id, run: relock });
    if (!pd.toggle) {
      const names = pd.choices?.map((c) => choiceName(def.type, pd.name, c));
      const type = (): void => {
        if (row.classList.contains('locked') || row.querySelector('.val-edit')) return;
        if (performance.now() - lastInput < TYPE_GAP_MS * 2 && m.params[pd.name] !== gestureFrom) this.setParam(m.id, pd.name, gestureFrom);
        this.endGesture(); // the double-click's own presses (moved and put back) leave no step
        this.typeValue(row, fmt(m.params[pd.name]), (text) => {
          let v = parseValue(text, pd, names);
          if (v === null) return false;
          if (pd.log) v = snapTo(pd, v);
          this.setParam(m.id, pd.name, v);
          this.endGesture();
          return true;
        });
      };
      this.typers.set(row, type);
      row.addEventListener('dblclick', (e) => {
        if ((e.target as Element).closest('.parameter-routing, .pickbox, .rename')) return;
        e.preventDefault();
        type();
      });
    }
    return row;
  }

  /** the rows' lock checks (relevance.ts), run again when a parameter of their module changes */
  private lockers: { id: number; run: () => void }[] = [];
  private relock(id: number): void {
    for (const l of this.lockers) if (l.id === id) l.run();
  }

  /** the bars that take a typed value, by row (Tab moves on to the next one in the card) */
  private typers = new WeakMap<HTMLElement, () => void>();

  /**
   * A text field over a parameter's bar: Enter sets what `commit` reads (false: it could not, the field stays with a red
   * edge), Esc or leaving it cancels, Tab / Shift+Tab set and move to the next / previous bar of the card.
   */
  private typeValue(row: HTMLElement, text: string, commit: (text: string) => boolean): void {
    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'val-edit';
    field.value = text;
    field.spellcheck = false;
    field.setAttribute('aria-label', `Type a value for ${row.querySelector('span')?.textContent ?? 'the parameter'}`);
    field.title = 'Enter sets it, Esc cancels. Units work: 2k, 440 Hz, 120 ms, 50 %, a choice by name.';
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      field.remove();
    };
    field.addEventListener('keydown', (e) => {
      e.stopPropagation(); // not a note key or a shortcut
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Enter' && e.key !== 'Tab') return;
      e.preventDefault();
      if (!commit(field.value)) { field.classList.add('bad'); return; }
      close();
      if (e.key !== 'Tab') return;
      const rows = [...(row.closest('.module, .dock-main') ?? this.modulesEl).querySelectorAll<HTMLElement>('.param.bar')].filter((r) => this.typers.has(r) && !r.classList.contains('locked'));
      const next = rows[rows.indexOf(row) + (e.shiftKey ? -1 : 1)];
      if (next) this.typers.get(next)!();
    });
    field.addEventListener('input', () => field.classList.remove('bad'));
    field.addEventListener('blur', close);
    for (const ev of ['pointerdown', 'dblclick'] as const) field.addEventListener(ev, (e) => e.stopPropagation());
    row.append(field);
    field.focus();
    field.select();
  }

  /** the open flaws card (flaws-panel.ts), if any */
  private flawPanel: FlawPanel | null = null;

  /** open the flaws card of poly assembly `a` under `anchor`: slider moves play at once, a release is one undo step */
  private openFlaws(a: AssemblyInst, anchor: HTMLElement): void {
    const was = this.flawPanel;
    was?.close();
    const id = a.id;
    let before: string | null = null;
    let frame = 0;
    const cfg = (): { cards: PolyCards; parts: number; fed: boolean } | null => {
      const x = assembliesOf(this.patch).find((y) => y.id === id);
      return x?.poly ? { cards: x.poly, parts: this.voicesOfAsm(x), fed: polyGroups(this.patch).some((g) => g.asm.id === id) } : null;
    };
    this.flawPanel = new FlawPanel(
      {
        title: a.label,
        cfg,
        edit: (fn) => {
          const c = cfg();
          if (!c) return;
          this.touch();
          before ??= this.snap();
          fn(c.cards, c.parts);
          if (!frame) frame = requestAnimationFrame(() => {
            frame = 0;
            this.ev.onStructure(this.patch);
          });
        },
        commit: () => {
          if (before === null) return;
          this.endGesture();
          before = null;
          this.rebuild();
          this.ev.onStructure(this.patch);
        },
        closed: () => {
          if (this.flawPanel?.el.isConnected === false) this.flawPanel = null;
        },
      },
      anchor.getBoundingClientRect(),
    );
  }

  /** how many voices run a poly assembly's cards: its allocator's (1 when no allocator feeds it) */
  private voicesOfAsm(a: AssemblyInst): number {
    return polyGroups(this.patch).find((g) => g.asm.id === a.id)?.cfg.parts ?? 1;
  }

  /**
   * A poly assembly's voice control: a drop-down in its header that opens the voice cards' flaws (flaws-panel.ts), with how
   * many voices run the cards (the Voice allocator's) at its top. Marked when no allocator feeds the cards (they run once).
   */
  private voiceControlButton(a: AssemblyInst): HTMLButtonElement {
    const g = polyGroups(this.patch).find((x) => x.asm.id === a.id);
    const parts = g?.cfg.parts ?? 1;
    const n = Array.from({ length: parts }, (_, i) => flawOf(a.poly!, i)).filter((f) => !isFlawless(f)).length;
    const b = this.button('voices ▾', g
      ? `Voice control: each voice card's own detune, drift, brightness, envelope time and level (${n ? `${n} of ${parts} set` : 'all alike'})`
      : `No ${DEFS[ALLOC].label} feeds these cards, so they run once. Patch an allocator's outputs (pitch, gate, …) into them, and Main's keys into the allocator.`,
    () => {
      if (this.flawPanel?.el.isConnected) return this.flawPanel.close();
      this.openFlaws(a, b);
    }, 'sm vc-btn');
    b.classList.toggle('over', !g);
    b.classList.toggle('set', n > 0);
    b.setAttribute('aria-haspopup', 'dialog');
    b.dataset.asm = String(a.id);
    b.dataset.setting = 'flaws';
    return b;
  }

  /** the morph picker: the B side of the patch (another patch of the same structure); the `morph` slider above fades every parameter A -> B */
  private morphRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'param bar morph-row';
    const name = document.createElement('span');
    name.textContent = 'B side';
    const cands = (this.ev.morphCandidates?.() ?? []).filter((c) => sameStructure(this.patch, c.patch));
    // index 0 = none, then the candidates; the current B side is matched by name (it is a copy of a candidate's values)
    const current = (): number => (hasMorph(this.patch) ? cands.findIndex((c) => c.name === this.patch.morphName) + 1 : 0);
    const names = ['none', ...cands.map((c) => c.name)];
    // a B side that is no longer among the candidates (renamed, deleted) still shows its name
    if (hasMorph(this.patch) && current() === 0) names[0] = this.patch.morphName ?? 'set';
    row.classList.add('choice', 'sel');
    const sel = selector({
      label: 'B side', names, get: current,
      set: (i) => this.change(() => {
        if (i === 0) clearMorph(this.patch);
        else setMorphTarget(this.patch, cands[i - 1].patch, DEFS);
      }),
    });
    const show = (): void => {
      const has = hasMorph(this.patch);
      sel.update(current(), current());
      row.title = has
        ? `The morph slider fades every parameter from this patch (A) to "${this.patch.morphName ?? 'B'}" (B): in octaves for a logarithmic one, a choice or switch flips at 0.5. The Main module's morph input adds to the slider (an LFO morphs the patch). Choose "none" to drop the B side.`
        : cands.length
          ? 'Pick a patch with the same modules and cables as the B side; the morph slider then fades every parameter from this patch to it.'
          : 'No stored patch has the same modules and cables as this one. Save this patch under another name, change its sounds, and pick that copy here.';
    };
    show();
    row.append(name, sel.element);
    return row;
  }

  /** the transport runs (editor state: the Play switch, Space) */
  playing = false;

  // ---- zoom and touch: the cards and cables are scaled by `zoom`; offsets stay in layout pixels, pointer deltas are divided by it

  zoom = 1;
  /** `live`: the zoom slider's source moved it, not the user */
  onZoom: (z: number, live: boolean) => void = () => {};

  setZoom(z: number, live = false): void {
    // the user's zoom is in whole percent; a source's (live) is not rounded, so a small wobble stays smooth
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, live ? z : Math.round(z * 100) / 100));
    if (live && next === this.zoom) return;
    this.zoom = next;
    if (!live) {
      this.userZoom = next;
      this.queueView();
    }
    this.world.style.transform = this.zoom === 1 ? '' : `scale(${this.zoom})`;
    this.sizeCanvas();
    // a live zoom only moves the cables' ends (the same cables); the user's redraws them
    if (live) this.positionCables();
    else this.drawCables();
    this.onZoom(this.zoom, live);
  }

  /** Tidy up: line the cards up in columns, keeping their arrangement (tidy.ts); one undo step */
  tidyUp(): void {
    const before = this.mark();
    const docked = this.docked();
    tidy(this.patch, this.tidySizes(), new Set(docked ? [docked.id] : []));
    if (!this.commit(before)) return this.ev.onError('already tidy');
    this.rebuild();
    this.canvas.scrollTo(0, 0);
    this.ev.onLayout(this.patch);
  }

  /** how far the cables sag (0..1): redraws them */
  setSlack(v: number): void {
    this.slack = Math.min(1, Math.max(0, v));
    this.positionCables();
  }

  /** the slack source's latest value (the host's watch of Patch.slackFrom): redraws the cables once per frame */
  modulateSlack(v: number): void {
    this.slackMod = this.patch.slackFrom ? v : 0;
    if (this.slackFrame) return;
    this.slackFrame = requestAnimationFrame(() => {
      this.slackFrame = 0;
      this.positionCables();
    });
  }

  /** patch an output into a sidebar slider (null: unplug it); an undo step, no engine reload */
  setSideSource(key: SideKey, from: Endpoint | null): void {
    const before = this.mark();
    if (from) this.patch[key] = { ...from };
    else delete this.patch[key];
    if (!this.commit(before)) return;
    if (key === 'slackFrom' && !from) this.slackMod = 0;
    this.rebuild();
    this.ev.onLayout(this.patch);
  }

  /** the zoom, holding the canvas's centre in place (the zoom slider and its source); `live`: a modulation, not the user's */
  zoomAround(z: number, live = false): void {
    const c = this.canvas;
    const cx = (c.scrollLeft + c.clientWidth / 2) / this.zoom, cy = (c.scrollTop + c.clientHeight / 2) / this.zoom;
    const was = this.zoom;
    this.setZoom(z, live);
    if (this.zoom === was) return;
    c.scrollLeft = cx * this.zoom - c.clientWidth / 2;
    c.scrollTop = cy * this.zoom - c.clientHeight / 2;
  }

  /** every card in view: the zoom that fits the cards' extent into the canvas, scrolled to its top left */
  zoomToFit(): void {
    const elements = [...this.cards.values(), ...this.containers.values(), ...this.frames.values()];
    if (!elements.length) return;
    const PAD = 24;
    // an open frame's cables run in a gutter round it (ribbons.ts): fit that too
    const out = (el: HTMLElement): number => (el.classList.contains('frame') ? GUTTER_ROOM : 0);
    const x0 = Math.max(0, Math.min(...elements.map((el) => el.offsetLeft - out(el))) - PAD);
    const y0 = Math.max(0, Math.min(...elements.map((el) => el.offsetTop - out(el))) - PAD);
    const w = Math.max(...elements.map((el) => el.offsetLeft + el.offsetWidth + out(el))) + PAD - x0;
    const h = Math.max(...elements.map((el) => el.offsetTop + el.offsetHeight + out(el))) + PAD - y0;
    this.setZoom(Math.min(1.5, this.canvas.clientWidth / w, this.canvas.clientHeight / h));
    this.canvas.scrollTo(x0 * this.zoom, y0 * this.zoom);
  }

  /** pinch to zoom and one-finger pan on the empty canvas (touch), Ctrl / Cmd + wheel to zoom (trackpads) */
  private touchGestures(): void {
    const pts = new Map<number, Pt>();
    let pinch: { d: number; z: number } | null = null;
    this.canvas.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      this.setZoom(this.zoom * Math.exp(-e.deltaY / 400));
    }, { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: this.zoom };
      }
    });
    const end = (e: PointerEvent): void => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch' || !pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        this.setZoom(pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
        e.preventDefault();
      }
    });
  }

  /** a long press on a card header (touch): the context actions */
  private contextMenu(m: ModuleInst, def: ModuleDef, at: Pt): void {
    const items: MenuItem[] = [];
    if (def.type !== 'fm1' && def.type !== 'output') items.push({ text: m.bypass ? 'Turn on' : 'Bypass', key: 'B', run: () => {
      this.selected.clear();
      this.selected.add(m.id);
      this.bypassSelected();
    } });
    items.push({ text: 'Duplicate', key: '⌘D', run: () => {
      this.selected.clear();
      this.selected.add(m.id);
      this.duplicateSelected();
    } });
    items.push({ text: 'Select', run: () => {
      this.selected.add(m.id);
      this.showSelection();
    } });
    items.push({ text: 'Delete', key: 'Del', danger: true, rule: true, run: () => this.change(() => removeModule(this.patch, m.id)) });
    this.popMenu(items, at);
  }

  /** an assembly's menu (its header's ⋯, a right-click on its header) */
  private assemblyMenu(a: AssemblyInst, at: Pt): void {
    this.popMenu([
      { text: a.open ? 'Collapse' : 'Expand', key: a.open ? '▾' : '▸', run: () => this.toggleOpen(a) },
      { text: 'Choose what the card shows', run: () => {
        if (!a.open) this.toggleOpen(a);
        this.pickAsm = a.id;
        this.rebuild();
      } },
      { text: this.arrangeAsm === a.id ? 'Done arranging' : 'Arrange the card', run: () => {
        if (this.arrangeAsm === a.id) return void this.endPick();
        this.pickAsm = null;
        this.arrangeAsm = a.id;
        if (a.open) this.toggleOpen(a);
        else this.rebuild();
      } },
      { text: 'Rename', key: 'dbl-click', run: () => this.rename(a) },
      { text: 'Save to library', rule: true, run: () => this.saveAssembly(a) },
      { text: 'Ungroup', run: () => this.change(() => ungroup(this.patch, a.id)) },
      { text: 'Delete with its modules', danger: true, rule: true, run: () => this.change(() => deleteAssembly(this.patch, a.id)) },
    ], at);
  }

  /** the sizes Tidy up works with: the cards as drawn, a grid cell when one is not drawn */
  private tidySizes(): Parameters<typeof tidy>[1] {
    const size = (el: HTMLElement | undefined): { w: number; h: number } => ({ w: el?.offsetWidth || CARD_W, h: el?.offsetHeight || CARD_H });
    return {
      module: (id) => size(this.cards.get(id)),
      container: (id) => size(this.containers.get(id)),
      frame: () => ({ pad: FRAME_PAD, padX: FRAME_PAD_X, head: FRAME_HEAD, minW: 0 }),
    };
  }

  /** what opening `a` does to the layout: spread stacked members, make room for the copies, keep the frame on the canvas */
  private openLayout(a: AssemblyInst): void {
    if (overlapping(this.patch, a)) tileMembers(this.patch, a); // stacked cards (an old file, members added at one spot) spread out
    if (a.poly) makeRoom(this.patch, a);
    // the frame's header goes above the members: move them down when it would stick out of the canvas's top
    const ys = allModules(this.patch, a).map((id) => this.patch.modules.find((m) => m.id === id)?.y ?? Infinity);
    const room = FRAME_PAD + FRAME_HEAD + 8;
    if (Math.min(...ys) < room) moveAssembly(this.patch, a, 0, room - Math.min(...ys));
    // and right of the canvas's left edge, with room for the cables running round it (ribbons.ts)
    const xs = allModules(this.patch, a).map((id) => this.patch.modules.find((m) => m.id === id)?.x ?? Infinity);
    const roomX = FRAME_PAD_X + GUTTER_ROOM;
    if (Math.min(...xs) < roomX) moveAssembly(this.patch, a, roomX - Math.min(...xs), 0);
  }

  /** tidy the insides of assemblies opened for the first time this session, innermost first, once their cards have a size
   * (after rebuild's own frame: part of the expansion's undo step, not one of its own) */
  private tidyFirstOpened(ids: number[]): void {
    if (!ids.length) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const before = JSON.stringify(this.patch);
      const list = ids.map((id) => assembliesOf(this.patch).find((x) => x.id === id)).filter((x): x is AssemblyInst => !!x?.open);
      list.sort((u, v) => depthOf(this.patch, v) - depthOf(this.patch, u));
      for (const a of list) tidyAssembly(this.patch, a, this.tidySizes());
      if (JSON.stringify(this.patch) === before) return;
      this.rebuild();
      this.ev.onLayout(this.patch);
    }));
  }

  /** expand or collapse an assembly; its first expansion in a session tidies the inside once the cards have a size */
  private toggleOpen(a: AssemblyInst): void {
    const first = !a.open && !this.expandedOnce.has(a.id);
    const opened = this.change(() => {
      a.open = !a.open;
      if (a.open) this.openLayout(a);
    });
    if (!opened || !a.open) return;
    for (const x of [a, ...descendants(this.patch, a)]) this.expandedOnce.add(x.id);
    if (first) this.tidyFirstOpened([a.id]);
  }

  /** expand or collapse every assembly, nested ones too, as one undo step (the sidebar's EXPAND / COLLAPSE) */
  setAllOpen(open: boolean): void {
    const list = [...assembliesOf(this.patch)].sort((u, v) => depthOf(this.patch, u) - depthOf(this.patch, v)); // outermost first
    const first = open ? list.filter((a) => !a.open && !this.expandedOnce.has(a.id)).map((a) => a.id) : [];
    const changed = this.change(() => {
      for (const a of list) {
        if (a.open === open) continue;
        a.open = open;
        if (open) this.openLayout(a);
      }
    });
    if (!changed || !open) return;
    for (const a of list) this.expandedOnce.add(a.id);
    this.tidyFirstOpened(first);
  }


  /** a header's ⋯: opens the card's menu under it */
  private moreButton(open: (at: Pt) => void): HTMLButtonElement {
    const b = this.button('⋯', 'Menu (also right-click the header)', () => {
      const r = b.getBoundingClientRect();
      const w = this.world.getBoundingClientRect();
      open({ x: (r.right - w.left) / this.zoom - 190, y: (r.bottom - w.top) / this.zoom + 4 });
    }, 'more');
    return b;
  }

  /** right-click on a header opens its menu at the pointer */
  private headMenu(head: HTMLElement, open: (at: Pt) => void): void {
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const w = this.world.getBoundingClientRect();
      open({ x: (e.clientX - w.left) / this.zoom, y: (e.clientY - w.top) / this.zoom });
    });
  }

  /** a small menu at a canvas point; a press anywhere else closes it */
  private popMenu(items: MenuItem[], at: Pt): void {
    document.querySelector('.ctx')?.remove();
    const menu = document.createElement('div');
    menu.className = 'ctx';
    menu.setAttribute('role', 'menu');
    for (const it of items) {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.className = (it.danger ? 'danger' : '') + (it.rule ? ' rule' : '');
      const label = document.createElement('span');
      label.textContent = it.text;
      b.append(label);
      if (it.key) {
        const k = document.createElement('kbd');
        k.textContent = it.key;
        b.append(k);
      }
      b.onclick = (e) => {
        e.stopPropagation();
        menu.remove();
        it.run();
      };
      menu.append(b);
    }
    Object.assign(menu.style, { left: `${Math.max(0, at.x)}px`, top: `${Math.max(0, at.y)}px` });
    this.modulesEl.append(menu);
    const away = (e: Event): void => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        window.removeEventListener('pointerdown', away, true);
      }
    };
    setTimeout(() => window.addEventListener('pointerdown', away, true));
  }

  // ---- keyboard actions (main.ts shortcuts): the selection

  /** remove the selected modules (and their cables) */
  removeSelected(): boolean {
    const { mods, asms } = this.dragSet();
    if (!mods.length && !asms.length) return false;
    return this.change(() => {
      for (const a of asms) deleteAssembly(this.patch, a.id);
      for (const m of mods) if (this.patch.modules.includes(m)) removeModule(this.patch, m.id);
    });
  }

  /** flip the bypass of the selected modules (all on if any was off) */
  bypassSelected(): boolean {
    const { mods, asms } = this.dragSet();
    const inside = new Set(asms.flatMap((a) => allModules(this.patch, a)));
    const ms = this.patch.modules.filter((m) => (mods.includes(m) || inside.has(m.id)) && m.type !== 'fm1' && m.type !== 'output');
    if (!ms.length) return false;
    const on = ms.some((m) => !m.bypass);
    this.touch();
    for (const m of ms) {
      if (on) m.bypass = true;
      else delete m.bypass;
      this.ev.onBypass(m.id, on);
    }
    this.rebuild();
    this.ev.onLayout(this.patch);
    return true;
  }

  /** move the selected cards by (dx, dy) pixels */
  nudgeSelected(dx: number, dy: number): boolean {
    const set = this.dragSet();
    if (!set.mods.length && !set.asms.length) return false;
    this.touch();
    for (const m of set.mods) {
      m.x = Math.max(0, m.x + dx);
      m.y = Math.max(0, m.y + dy);
    }
    for (const a of set.asms) moveAssembly(this.patch, a, dx, dy);
    this.rebuild();
    this.ev.onLayout(this.patch);
    return true;
  }

  /** copies of the selected modules with their parameters, matrix and the cables among them, placed below the originals and selected */
  duplicateSelected(): boolean {
    const set = this.dragSet();
    const ids = set.mods.filter((m) => m.type !== 'fm1').map((m) => m.id);
    if (!ids.length && !set.asms.length) return false;
    return this.change(() => {
      // a selected assembly is copied through its definition, collapsed, below where it is
      const asmCopies = set.asms.map((a) => {
        const box = a.open ? this.frameRect(a) : { x: a.x, y: a.y, h: this.containers.get(a.id)?.offsetHeight ?? CARD_H / 2 };
        return insertAssembly(this.patch, DEFS, toDef(this.patch, a), box?.x ?? a.x, (box?.y ?? a.y) + Math.min(CARD_H / 2, (box?.h ?? 0) + 24)).id;
      });
      const map = new Map<number, number>();
      for (const id of ids) {
        const m = this.patch.modules.find((x) => x.id === id)!;
        const copy = addModule(this.patch, DEFS[m.type], m.x, m.y + CARD_H / 2);
        copy.params = { ...m.params };
        if (m.att) copy.att = [m.att[0], m.att[1]];
        if (m.map) copy.map = JSON.parse(JSON.stringify(m.map));
        if (m.range) copy.range = JSON.parse(JSON.stringify(m.range));
        if (m.bypass) copy.bypass = true;
        if (m.inputMap) copy.inputMap = structuredClone(m.inputMap);
        map.set(id, copy.id);
      }
      for (const c of [...this.patch.cables]) if (map.has(c.from.module) && map.has(c.to.module)) connect(this.patch, DEFS, { module: map.get(c.from.module)!, port: c.from.port }, { module: map.get(c.to.module)!, port: c.to.port });
      this.selected.clear();
      for (const id of map.values()) this.selected.add(id);
      this.selectedAsm.clear();
      for (const id of asmCopies) this.selectedAsm.add(id);
    });
  }

  // ---- copy / paste (clipboard.ts): the system clipboard is main.ts's; the editor turns a selection into a clip and back

  /** the clip last copied or pasted, and how many times it was pasted: each paste of it lands one PASTE_STEP further */
  private clipKey = '';
  private clipPastes = 0;

  /** the selection as a clip (Main and the Output are left out); null with nothing to copy */
  copySelection(): Clip | null {
    const set = this.dragSet();
    const clip = copyItems(this.patch, set.mods.map((m) => m.id), set.asms.map((a) => a.id));
    if (clip) {
      this.clipKey = clipText(clip);
      this.clipPastes = 0;
    }
    return clip;
  }

  /** put a clip into the patch, offset from where it was copied, as one undo step; the pasted items become the selection */
  paste(clip: Clip): boolean {
    const key = clipText(clip);
    this.clipPastes = key === this.clipKey ? this.clipPastes + 1 : 1;
    this.clipKey = key;
    const off = PASTE_STEP * this.clipPastes;
    return this.change(() => {
      const got = pasteClip(this.patch, DEFS, clip, Math.max(0, clip.x + off), Math.max(0, clip.y + off));
      this.selected.clear();
      for (const id of got.modules) this.selected.add(id);
      this.selectedAsm.clear();
      for (const id of got.assemblies) this.selectedAsm.add(id);
    });
  }

  // ---- click-to-connect: a click on a jack arms it, a click on a jack of the other direction connects; Esc cancels

  private armed: HTMLElement | null = null;
  /** the ghost cable from the armed jack to the pointer (stops following when the arm ends) */
  private armGhost: (() => void) | null = null;

  cancelArm(): void {
    this.armed?.classList.remove('armed');
    this.armed = null;
    this.armGhost?.();
    this.armGhost = null;
    this.setPatching(false);
    this.drag?.cancel();
  }

  /** the canvas is patching (a cable being dragged or a jack armed); the page knows too, so the sidebar's jack thumbs show it */
  private setPatching(on: boolean): void {
    this.canvas.classList.toggle('patching', on);
    document.documentElement.classList.toggle('patching-any', on);
  }

  /** click-to-connect onto a sidebar slider's thumb: with an output armed, patch it there. Whether it did */
  connectArmedToSide(key: SideKey): boolean {
    const armed = this.armed;
    if (!armed || armed.dataset.dir !== 'out' || !armed.dataset.mod) return false;
    this.cancelArm();
    this.setSideSource(key, { module: Number(armed.dataset.mod), port: armed.dataset.port! });
    return true;
  }

  // ---- A / B: two snapshots; the toggle swaps them, as a parameter-only update when the structure matches

  readonly snapshots: { A: string | null; B: string | null } = { A: null, B: null };
  side: 'A' | 'B' = 'A';

  /** keep the current patch as snapshot A or B */
  takeSnapshot(which: 'A' | 'B'): void {
    this.snapshots[which] = JSON.stringify(this.patch);
    this.side = which;
  }

  /** go to the other snapshot (false when it is empty) */
  toggleAB(): boolean {
    const other = this.side === 'A' ? 'B' : 'A';
    const s = this.snapshots[other];
    if (s === null) return false;
    this.snapshots[this.side] = JSON.stringify(this.patch); // the side we leave keeps what we did to it
    const from = this.side;
    this.side = other;
    this.applyLive(JSON.parse(s) as Patch, from);
    return true;
  }

  /** switch to `target`: with the same structure only the values move (onParam / onAtt / onBypass / onRange, no reload, the voices keep sounding), else a full load */
  applyLive(target: Patch, side = this.side): void {
    this.endGesture();
    const before = this.mark();
    if (!sameStructure(this.patch, target) || this.patch.modules.some((m, i) => m.id !== target.modules[i].id)) {
      this.patch = target;
      this.commit(before, side);
      this.selected.clear();
      this.rebuild();
      this.ev.onStructure(this.patch);
      return;
    }
    target.modules.forEach((t, i) => {
      const m = this.patch.modules[i];
      for (const pd of DEFS[m.type].params) if ((m.params[pd.name] ?? pd.default) !== (t.params[pd.name] ?? pd.default)) this.ev.onParam(m.id, pd.name, t.params[pd.name] ?? pd.default);
      if (m.att && t.att) for (const k of [0, 1] as const) if (m.att[k] !== t.att[k]) this.ev.onAtt(m.id, k, t.att[k]);
      if (!!m.bypass !== !!t.bypass) this.ev.onBypass(m.id, !!t.bypass);
      for (const s of ['p1', 'p2'] as const) {
        const names = new Set([...Object.keys(m.range?.[s] ?? {}), ...Object.keys(t.range?.[s] ?? {})]);
        for (const name of names) {
          const r = t.range?.[s]?.[name] ?? null;
          if (JSON.stringify(r) !== JSON.stringify(m.range?.[s]?.[name] ?? null)) this.ev.onRange(m.id, s === 'p1' ? 0 : 1, name, r);
        }
      }
    });
    const keepLayout = this.patch.modules.map((m) => [m.x, m.y]);
    this.patch = target;
    this.patch.modules.forEach((m, i) => ([m.x, m.y] = keepLayout[i]));
    this.commit(before, side);
    this.rebuild();
    this.ev.onLayout(this.patch);
  }
  /**
   * A port row. On a member card of an expanded assembly it gets the expose toggle; on an assembly card (`label`) the dot
   * still belongs to the inner module, so cables and drags work the same, and the label renames on click.
   */
  private port(m: ModuleInst, p: PortDef, dir: 'out' | 'in', o: { open?: AssemblyInst; label?: string; rename?: () => void; also?: Target[]; short?: boolean } = {}): HTMLElement {
    const row = document.createElement('div');
    row.className = `port ${dir}`;
    const dot = this.jack(m, p, dir);
    const long = longName(m.type, p.name);
    dot.title = (o.label ? `${o.label}: ${DEFS[m.type].label} ${long} (${p.kind})` : `${long} (${p.kind})`);
    const label = document.createElement('span');
    // a card's edge has little room: a long name gives way to the short one (the jack's tooltip has the long one)
    label.textContent = o.label ?? (o.short && long.length > 6 ? p.name : long);
    if (o.rename) {
      label.classList.add('rename');
      label.title = 'click to rename';
      label.onclick = o.rename;
    }
    const parts: HTMLElement[] = dir === 'in' ? [dot, label] : [label, dot];
    if (o.open) {
      const a = o.open;
      const on = isExposed(a, dir, m.id, p.name);
      const ref = findRef(a, dir, m.id, p.name);
      row.classList.toggle('shown', on);
      this.promoteClick(row, a, () => (on ? hidePort(this.patch, a, dir, m.id, p.name) : exposePort(a, dir, m.id, p.name, o.also)));
      // pick mode: the check box between the label and the jack
      if (this.picking(a)) parts.splice(1, 0, this.pickBox(on));
      if (dir === 'in') parts.push(...this.mergeTools(a, m, p, ref, this.picking(a)));
    }
    if (o.also?.length) dot.dataset.also = JSON.stringify(o.also);
    if (o.also?.length && !o.open) {
      const n = document.createElement('span');
      n.className = 'merged';
      n.textContent = `×${o.also.length + 1}`;
      n.title = `one jack for ${o.also.length + 1} inputs: ${[{ module: m.id, port: p.name }, ...o.also].map((t) => `${DEFS[this.patch.modules.find((x) => x.id === t.module)!.type].label} ${t.port}`).join(', ')}`;
      parts.splice(dir === 'in' ? 2 : 1, 0, n);
    }
    row.append(...parts);
    return row;
  }

  /** briefly highlight the drawn cables of these model cables (the two sources holding a module's pins) */
  private flash(cables: Cable[]): void {
    const hit = (c?: Cable): boolean => !!c && cables.some((x) => sameEnd(x.from, c.from) && sameEnd(x.to, c.to));
    // after the redraw that follows the failed change
    setTimeout(() => {
      const paths = this.cablePaths.filter((e) => hit(e.cable)).map((e) => e.path);
      for (const path of paths) path.classList.add('flash');
      setTimeout(() => paths.forEach((path) => path.classList.remove('flash')), 1600);
    }, 60);
  }

  /** a pin with a cable that routes to no parameter (from an old patch): it gets a jack so the cable can be seen and removed */
  private unrouted(m: ModuleInst, pin: string): boolean {
    return isPin(pin) && !!m.map && !m.map[pin].length && this.patch.cables.some((c) => c.to.module === m.id && c.to.port === pin);
  }

  private unroutedPort(m: ModuleInst, p: PortDef): HTMLElement {
    const row = this.port(m, p, 'in', { label: 'unrouted' });
    row.classList.add('unrouted');
    row.title = 'This cable reaches no parameter (an old patch routed it nowhere). Click the cable to remove it, or patch to a thumb instead.';
    return row;
  }

  /** a port's jack: cables are drawn to it and dragged from it */
  private jack(m: ModuleInst, p: PortDef, dir: 'out' | 'in'): HTMLElement {
    const dot = document.createElement('span');
    dot.className = `dot ${p.kind}`;
    dot.dataset.mod = String(m.id);
    dot.dataset.port = p.name;
    dot.dataset.dir = dir;
    dot.title = `${longName(m.type, p.name)} (${p.kind})`;
    dot.addEventListener('pointerdown', (e) => this.beginDrag(e, dot));
    this.ports.set(this.key(m.id, p.name, dir), dot);
    return dot;
  }

  /** a patch button of the FM-1 in the dock (board E): its label and kind mark, the FM-1 name under them, a light (dark
   * unassigned, dim assigned or cabled, lit engaged); held while pressed or switched; right-click or ⋯: the button editor */
  private dockButton(m: ModuleInst, b: string, i: number): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'panel-btn';
    btn.dataset.button = b;
    const panel = m.panel;
    const glo = b === 'glo';
    const kind = kindOf(panel, b);
    const name = b.toUpperCase();
    const top = document.createElement('span');
    top.className = 'pb-face';
    if (glo) top.append(kindMark('main'));
    else if (kind !== 'nothing') top.append(kindMark(kind));
    const label = document.createElement('span');
    label.className = 'pb-label';
    label.textContent = glo ? 'GLOBAL' : kind === 'nothing' ? name : panel?.labels?.[b] || name;
    top.append(label);
    const under = document.createElement('span');
    under.className = 'pb-hw';
    under.textContent = kind === 'nothing' ? 'unassigned' : name;
    const led = document.createElement('span');
    led.className = 'pb-led';
    led.setAttribute('aria-hidden', 'true');
    btn.append(top, under, led);
    btn.classList.toggle('unassigned', kind === 'nothing');
    btn.classList.toggle('assigned', buttonLight(this.patch, b, false) === 'dim');
    const engaged = glo ? this.gloOn : kind === 'page' ? this.pageOn?.b === b : kind === 'bypass' ? switches(panel, b) && toggleEngaged(this.patch, b) : switches(panel, b) && !!panel?.on?.includes(b);
    btn.setAttribute('aria-pressed', String(engaged));
    const does = glo ? 'Main’s global page on the knobs (tempo, morph, the arpeggiator); again: back' : kind === 'nothing' ? 'does nothing (its jack is high while held)' : kind === 'gate' ? 'a gate' : kind === 'page' ? 'a list of device pages (press: the next, hold: the first)' : 'bypasses its target';
    btn.title = glo ? `GLO: ${does}` : `${name}: ${does}${kind === 'page' ? '' : switches(panel, b) ? ', switches on / off' : ', while held'} (right-click: edit the button)`;
    btn.addEventListener('pointerdown', (e) => {
      if (e.button === 0) this.pressButton(i, true);
    });
    for (const ev of ['pointerup', 'pointerleave'] as const) btn.addEventListener(ev, () => { if (!switches(m.panel, b) && btn.getAttribute('aria-pressed') === 'true') this.pressButton(i, false); });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!glo) this.openButtonEditor(b);
    });
    if (glo) return btn;                    // GLO is fixed (#118): no editor
    const more = document.createElement('span');
    more.className = 'pb-more';
    more.textContent = '⋯';
    more.title = `Edit the ${name} button`;
    more.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.openButtonEditor(b); });
    btn.append(more);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); this.openButtonEditor(b); }
    });
    return btn;
  }

  /** the button editor's popover (button-editor.ts): kept across redraws, anchored on its dock button */
  private buttonPop: { el: HTMLElement; b: string } | null = null;

  /** open (or move to) the editor of patch button b */
  openButtonEditor(b: string): void {
    if (!this.buttonPop) {
      const el = document.createElement('div');
      el.className = 'routing-controls button-editor';
      el.popover = 'auto';
      el.addEventListener('toggle', () => { if (!el.matches(':popover-open')) this.buttonPop = null; });
      el.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
      document.body.append(el);
      this.buttonPop = { el, b };
    }
    this.buttonPop.b = b;
    this.fillButtonEditor();
  }

  /** refill the open button editor (after a change, a redraw, undo) and keep it on its button */
  private fillButtonEditor(): void {
    const pop = this.buttonPop;
    const m = this.docked() ?? this.patch.modules.find((x) => x.type === 'fm1');
    if (!pop) return;
    const anchor = this.dock?.querySelector<HTMLElement>(`.panel-btn[data-button="${pop.b}"]`);
    if (!m || !anchor) { if (pop.el.matches(':popover-open')) pop.el.hidePopover(); pop.el.remove(); this.buttonPop = null; return; }
    pop.el.replaceChildren(...buttonEditor(pop.b, {
      patch: () => this.patch,
      change: (fn) => { this.change(fn); },
      label: (text) => this.setPanelLabel(m, pop.b, text),
      devices: () => this.devices,
    }, pop.b === 'glo'));
    if (!pop.el.matches(':popover-open')) pop.el.showPopover();
    positionPopover(pop.el, anchor);
  }

  /**
   * Patch button i (PANEL_BUTTONS) pressed or let go, on the dock or elsewhere (CC 80..86 from the FM-1, which sends the
   * presses raw, #115): a switching one flips on the press and is saved with the patch, the others are on while held.
   * A Toggle (#116) bypasses its target while on: a switching one in the patch (an undo step, like the card's ⏻), one
   * that acts while held in the engine only. The engine applies the bypass itself (Engine.setButton), as the FM-1 does.
   */
  pressButton(i: number, down: boolean): void {
    const b = PANEL_BUTTONS[i];
    const m = this.patch.modules.find((x) => x.type === 'fm1');
    if (!m || b === undefined) return;
    const btn = this.dock?.querySelector<HTMLElement>(`.panel-btn[data-button="${b}"]`);
    const kind = kindOf(m.panel, b);
    if (b === 'glo') {                      // GLO (#118): Main's global page on the dock knobs; again: back
      if (down) this.setGlo(!this.gloOn);
      this.ev.onButton?.(i, down);          // (its jack: high while held)
      btn?.setAttribute('aria-pressed', String(this.gloOn));
      return;
    }
    if (kind === 'page') return this.pagePress(i, b, down, btn);
    const t = kind === 'bypass' ? m.panel?.targets?.[b] : undefined;
    const a = t && 'asm' in t ? assembliesOf(this.patch).find((x) => x.id === t.asm) : undefined;
    if (!switches(m.panel, b)) {
      btn?.setAttribute('aria-pressed', String(down));
      if (kind === 'bypass') this.showBypass(toggleTargets(this.patch, b), down, a);
      this.ev.onButton?.(i, down);
      return;
    }
    if (!down) return;
    this.touch();
    let on: boolean;
    if (kind === 'bypass') {
      on = !toggleEngaged(this.patch, b);
      const ids = toggleTargets(this.patch, b);
      if (a) bypassAssembly(this.patch, a, on);
      else for (const id of ids) {
        const x = this.patch.modules.find((y) => y.id === id);
        if (!x) continue;
        if (on) x.bypass = true;
        else delete x.bypass;
      }
      this.showBypass(ids, on, a);
    } else {
      const panel = (m.panel ??= {});
      on = !panel.on?.includes(b);
      panel.on = on ? [...(panel.on ?? []), b] : (panel.on ?? []).filter((x) => x !== b);
      if (!panel.on.length) delete panel.on;
    }
    btn?.setAttribute('aria-pressed', String(on));
    this.ev.onButton?.(i, on);
    this.ev.onLayout(this.patch);           // saved with the patch (the device keeps switched buttons too)
  }

  // ---- Page buttons (#117): the same rules as on the FM-1, on the dock knobs. A press puts the next page of the list in
  // focus (the first press: the list's first page), a hold shows its first page while it is down; the list is left when
  // the focus moves any other way. Engaged (lit, its jack high) while the list is on.
  private pageOn: { b: string; step: number } | null = null;
  private pageHold: { b: string; timer: number; peeked: { on: { b: string; step: number } | null; focus: { device: string; page: number } | null } | null } | null = null;
  private listMoving = false;

  private pagePress(i: number, b: string, down: boolean, btn: HTMLElement | null | undefined): void {
    const list = pageList(this.patch, b, this.devices);
    if (down) {
      if (this.pageHold) clearTimeout(this.pageHold.timer);
      const hold = { b, timer: 0, peeked: null as { on: { b: string; step: number } | null; focus: { device: string; page: number } | null } | null };
      hold.timer = window.setTimeout(() => {
        if (this.pageHold !== hold || !list.length) return;
        hold.peeked = { on: this.pageOn, focus: this.focus ? { ...this.focus } : null };
        this.pageOn = { b, step: 0 };
        this.listFocus(list[0]);
      }, PAGE_HOLD_MS);
      this.pageHold = hold;
      this.ev.onButton?.(i, true);
      this.syncPageButtons();
      return;
    }
    const hold = this.pageHold;
    if (!hold || hold.b !== b) return;
    clearTimeout(hold.timer);
    this.pageHold = null;
    if (hold.peeked) {                       // the hold ends: back to what showed before it
      this.pageOn = hold.peeked.on;
      if (hold.peeked.focus) this.listFocus(hold.peeked.focus);
    } else if (list.length) {
      const step = this.pageOn?.b === b ? (this.pageOn.step + 1) % list.length : 0;
      this.pageOn = { b, step };
      this.listFocus(list[step]);
    }
    this.ev.onButton?.(i, this.pageOn?.b === b);
    this.syncPageButtons();
    void btn;
  }

  /** a page of a list into focus (setFocus leaves the list otherwise) */
  private listFocus(f: { device: string; page: number }): void {
    this.listMoving = true;
    try { this.setFocus(f); } finally { this.listMoving = false; }
    this.syncPageButtons();
  }

  /** the dock's Page buttons: lit while held or while their list is on */
  private syncPageButtons(): void {
    const m = this.patch.modules.find((x) => x.type === 'fm1');
    for (const b of PANEL_BUTTONS) {
      if (kindOf(m?.panel, b) !== 'page') continue;
      const on = this.pageOn?.b === b || this.pageHold?.b === b;
      this.dock?.querySelector<HTMLElement>(`.panel-btn[data-button="${b}"]`)?.setAttribute('aria-pressed', String(on));
    }
  }

  /** Alt-click on a card row while a Page button's editor is open: its page joins the list */
  private addRowToList(module: number, param: string): boolean {
    const b = this.buttonPop?.b;
    const m = this.patch.modules.find((x) => x.type === 'fm1');
    if (!b || kindOf(m?.panel, b) !== 'page') return false;
    const at = findRow(this.devices, module, param);
    if (!at) return false;
    const entry = { device: this.devices[at.device].key, page: at.page };
    const list = pageList(this.patch, b, this.devices);
    if (list.length >= PAGE_LIST_MAX) return true;
    this.change(() => setPages(this.patch, b, [...list, entry]));
    return true;
  }

  /** the cards of modules a Toggle bypasses show it (without a redraw: the dock button may be held) */
  private showBypass(ids: number[], on: boolean, a?: AssemblyInst): void {
    for (const id of ids) this.cards.get(id)?.classList.toggle('off', on);
    if (a) {
      this.containers.get(a.id)?.classList.toggle('off', on);
      this.frames.get(a.id)?.classList.toggle('off', on);
    }
  }

  /** a button's label on the FM-1's screen (patch.ts panelLabel: capitals, 10 characters; '' = none) */
  private setPanelLabel(m: ModuleInst, key: string, typed: string): void {
    const label = panelLabel(typed);
    this.change(() => {
      const panel = (m.panel ??= {});
      const labels = { ...(panel.labels ?? {}) };
      if (label) labels[key] = label;
      else delete labels[key];
      if (Object.keys(labels).length) panel.labels = labels;
      else delete panel.labels;
      if (!Object.keys(panel).length) delete m.panel;
    });
  }

  /** a small menu at a screen point (the dock is not in the canvas); a press anywhere else closes it */
  private dockMenu(items: MenuItem[], x: number, y: number): void {
    this.popMenu(items, { x, y });
    const menu = document.querySelector<HTMLElement>('.ctx');
    if (!menu) return;
    document.body.append(menu);
    Object.assign(menu.style, { position: 'fixed', left: `${x}px`, top: `${y - 8}px`, zIndex: '40', transform: 'translateY(-100%)' });
  }

  /**
   * On an exposed input inside an expanded assembly: a "merge into…" list of the other exposed inputs of the same kind, a
   * badge with the count on a merged jack and a button to split it again.
   */
  private mergeTools(a: AssemblyInst, m: ModuleInst, p: PortDef, ref: PortRef | undefined, tools: boolean): HTMLElement[] {
    if (!ref) return [];
    const out: HTMLElement[] = [];
    const me: Target = { module: m.id, port: p.name };
    const primary = ref.module === m.id && ref.port === p.name;
    if (ref.also?.length) {
      const n = document.createElement('span');
      n.className = 'merged';
      n.textContent = primary ? `×${ref.also.length + 1}` : `→ ${ref.label}`;
      n.title = primary ? `"${ref.label}" is one jack for ${ref.also.length + 1} inputs` : `fed by the "${ref.label}" jack`;
      out.push(n);
      if (primary && tools) out.push(this.button('split', `Split "${ref.label}": one jack per input again`, () => this.change(() => unmergePort(a, m.id, p.name))));
    }
    const kindOf = (t: Target): string => DEFS[this.patch.modules.find((x) => x.id === t.module)!.type].inputs.find((q) => q.name === t.port)!.kind;
    const others = a.inputs.filter((r) => r !== ref && kindOf(r) === p.kind);
    if (!others.length || !tools) return out; // merging is part of choosing the card: pick mode only
    const sel = document.createElement('select');
    sel.className = 'merge';
    sel.title = `Merge "${ref.label}" into another jack of the "${a.label}" card: one jack feeds both`;
    sel.setAttribute('aria-label', `merge ${ref.label} into`);
    sel.append(new Option('merge…', ''));
    for (const r of others) sel.append(new Option(r.label, `${r.module}:${r.port}`));
    sel.onchange = () => {
      const [mod, port] = sel.value.split(':');
      if (!mod) return;
      this.change(() => mergePorts(this.patch, a, DEFS, { module: Number(mod), port }, me));
    };
    sel.onpointerdown = (e) => e.stopPropagation();
    out.push(sel);
    return out;
  }

  // ---- assemblies on the canvas

  /** the expanded assembly whose collapsed card is being chosen (its frame's card button), else null */
  private pickAsm: number | null = null;

  /** leave pick mode (Esc); false when it was not on */
  endPick(): boolean {
    if (this.pickAsm === null && this.arrangeAsm === null) return false;
    this.pickAsm = null;
    this.arrangeAsm = null;
    this.newHeading = null;
    this.rebuild();
    return true;
  }

  private picking(a: AssemblyInst | undefined): boolean {
    return !!a && this.pickAsm === a.id;
  }

  /**
   * A row of a member card that can go on the assembly's collapsed card: a click adds it or takes it off in pick mode,
   * a Cmd / Ctrl-click any time. In pick mode a jack still patches (a plain press on it).
   */
  private promoteClick(el: HTMLElement, a: AssemblyInst, toggle: () => void): void {
    const mod = (e: MouseEvent): boolean => e.metaKey || e.ctrlKey;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !(this.picking(a) || mod(e))) return;
      const t = e.target as HTMLElement;
      if (t.closest('select, button.sm')) return;
      if (!mod(e) && t.closest('.dot:not(.slider-port)')) return;
      e.preventDefault();
      e.stopPropagation();
      this.change(toggle);
    }, true);
    // macOS: Ctrl-click is also a right click; it toggled already, so no context menu
    el.addEventListener('contextmenu', (e) => { if (e.ctrlKey) { e.preventDefault(); e.stopPropagation(); } });
    el.title = this.picking(a) ? `Click: show on the "${a.label}" card or take it off` : `Cmd / Ctrl-click: show on the "${a.label}" card or take it off`;
  }

  /** pick mode's check box: on = shown on the assembly card */
  private pickBox(on: boolean): HTMLElement {
    const box = document.createElement('span');
    box.className = 'pickbox' + (on ? ' on' : '');
    box.textContent = on ? '✓' : '';
    box.setAttribute('aria-hidden', 'true');
    return box;
  }

  /** the frame's card button: pick mode on / off, with how many jacks and parameters the collapsed card has */
  private pickButton(a: AssemblyInst): HTMLButtonElement {
    const on = this.picking(a);
    const n = a.inputs.length + a.outputs.length + a.params.length;
    const b = this.button(on ? 'done' : `card · ${n}`, on
      ? 'Done choosing (Esc)'
      : `Choose what the collapsed "${a.label}" card shows: click jacks and parameters to add or remove them (Cmd / Ctrl-click does it any time)`,
    () => { this.pickAsm = on ? null : a.id; this.rebuild(); }, 'sm pick-btn');
    b.setAttribute('aria-pressed', String(on));
    b.dataset.asm = String(a.id);
    return b;
  }

  private rename(a: AssemblyInst): void {
    const v = window.prompt('Label of this assembly', a.label)?.trim();
    if (v && v !== a.label) this.change(() => (a.label = v));
  }

  private saveAssembly(a: AssemblyInst): void {
    const name = window.prompt('Save the assembly to the library as', a.name)?.trim();
    if (!name) return;
    if (name !== a.name) this.change(() => (a.name = name));
    this.ev.onSaveAssembly(toDef(this.patch, a));
  }

  private assemblyButtons(a: AssemblyInst): HTMLElement[] {
    const pw = this.button('⏻', `${a.label} on / off (bypass every module inside)`, () => {
      this.touch();
      const changed = bypassAssembly(this.patch, a, !a.bypass);
      for (const id of changed) this.ev.onBypass(id, !!this.patch.modules.find((m) => m.id === id)?.bypass);
      this.rebuild();
      this.ev.onLayout(this.patch);
    }, 'pw');
    pw.classList.toggle('on', !a.bypass);
    pw.setAttribute('aria-pressed', String(!a.bypass));
    return [this.polyButton(a), pw, this.moreButton((at) => this.assemblyMenu(a, at))];
  }

  /** ▸ / ▾ before an assembly's title: expand or collapse */
  private chevron(a: AssemblyInst): HTMLButtonElement {
    const b = this.button('', a.open ? 'Collapse to one card' : 'Expand: show and edit the modules inside', () => this.toggleOpen(a), 'chev');
    // a drawn triangle (▸, turned down when open): the text glyph is tiny in the card fonts
    b.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 1.5 L10 6 L3.5 10.5 Z"/></svg>';
    b.setAttribute('aria-expanded', String(!!a.open));
    b.dataset.asm = String(a.id);
    return b;
  }

  /** the Poly switch: the modules inside run once per part, with their own allocator (poly.ts setPoly) */
  private polyButton(a: AssemblyInst): HTMLButtonElement {
    const b = this.button('poly', a.poly
      ? 'Poly is on: these are voice cards, one copy per voice of the Voice allocator that feeds them. Click to turn it off (one copy, played by Main).'
      : 'Make it a rack of voice cards: a Voice allocator is put beside it (Main\'s keys in, its pitch / gate / velocity into the cards), and the modules inside run once per voice.',
    () => this.change(() => setPoly(this.patch, DEFS, a, !a.poly)), 'sm poly-btn');
    b.setAttribute('aria-pressed', String(!!a.poly));
    b.dataset.asm = String(a.id);
    return b;
  }

  /** an assembly's title segment: the name, its ×N badge and, on a poly assembly, the voice control drop-down */
  private titleOf(a: AssemblyInst, perVoice: number): HTMLElement {
    const title = document.createElement('span');
    title.className = 'rename asm-title';
    title.title = `${a.name}: double-click to rename`;
    const name = document.createElement('span');
    name.className = 'asm-name';
    name.textContent = a.label;
    title.append(name);
    title.ondblclick = (e) => {
      if (!(e.target as HTMLElement).closest('button')) this.rename(a);
    };
    if (perVoice) title.append(this.badge(perVoice));
    if (a.poly) title.append(this.voiceControlButton(a));
    return title;
  }

  /**
   * The collapsed assembly: one card with the exposed ports and the promoted parameters. Inside an expanded parent (`open`)
   * its rows get the parent's expose / pin toggles, like a member card's.
   */
  private container(a: AssemblyInst, perVoice: number, parent?: AssemblyInst): HTMLElement {
    const arranging = this.arrangeAsm === a.id;
    // while its own card is arranged, the parent's pick toggles stay off it
    const open = arranging ? undefined : parent;
    const ncols = paramColumns(a.params).length;
    const el = document.createElement('div');
    el.className = 'module assembly' + (a.poly ? ' poly' : '') + (parent ? ' member' : '') + (a.bypass ? ' off' : '') + (this.picking(open) ? ' picking' : '') + (this.selectedAsm.has(a.id) ? ' selected' : '') + (arranging ? ' arranging' : '') + (ncols > 1 ? ' cols' : '');
    if (ncols > 1) el.style.setProperty('--cols', String(ncols));
    el.style.left = `${a.x}px`;
    el.style.top = `${a.y}px`;
    el.dataset.asm = String(a.id);
    this.containers.set(a.id, el);
    const head = document.createElement('div');
    head.className = 'mhead';
    const tools = document.createElement('span');
    tools.className = 'tools';
    if (arranging) {
      const done = this.button('done', 'Done arranging (Esc)', () => this.endPick(), 'sm pick-btn');
      done.setAttribute('aria-pressed', 'true');
      tools.append(done);
    }
    if (parent) tools.append(this.outButton(parent, () => this.takeOutAssembly(parent, a)));
    tools.append(...this.assemblyButtons(a));
    const title = this.titleOf(a, perVoice);
    title.prepend(this.tag(null));
    head.append(this.chevron(a), title, tools);
    this.headMenu(head, (at) => this.assemblyMenu(a, at));
    this.assemblyDrag(el, head, a);

    const body = document.createElement('div');
    body.className = 'mbody';
    const mod = (id: number): ModuleInst => this.patch.modules.find((m) => m.id === id)!;
    const ins: EdgePort[] = [];
    a.inputs.forEach((r, i) => {
      const m = mod(r.module);
      const pd = DEFS[m.type].inputs.find((q) => q.name === r.port)!;
      if (isPin(pd.name) && !this.unrouted(m, pd.name)) return; // routed pins are shown as promoted parameters
      const port = this.port(m, pd, 'in', { label: r.label, rename: () => this.renameRef(r, 'input'), also: r.also, open });
      if (arranging) this.arrangeItem(port, a, 'in', i);
      ins.push({ el: port, module: m.id, port: pd.name });
    });
    const outs = a.outputs.map((r, i) => {
      const m = mod(r.module);
      const pd = DEFS[m.type].outputs.find((q) => q.name === r.port)!;
      const port = this.port(m, pd, 'out', { label: r.label, rename: () => this.renameRef(r, 'output'), open });
      if (arranging) this.arrangeItem(port, a, 'out', i);
      return port;
    });
    // how many columns a display on each row could reach across: its own and those to its right
    const spanRoom: number[] = [];
    paramColumns(a.params).forEach((c, ci) => c.forEach((i) => (spanRoom[i] = ncols - ci)));
    // where its groups (FM-1 pages) start: a divider above a group that has no heading or column of its own
    const shown = a.params.map((r) => rowDef(DEFS[mod(r.module).type], r.param)!);
    const kept = a.params.map((_, i) => i).filter((i) => !shown[i].onScreen);
    const starts = new Map(groupStarts(kept.map((i) => ({ ...a.params[i], knob: !shown[i].screen }))).map((st, k) => [kept[k], st && k > 0]));
    const params = a.params.flatMap((r, i): EdgeParam[] => {
      const m = mod(r.module);
      const def = DEFS[m.type];
      const pd = shown[i];
      if (pd.onScreen) return [];
      const row = this.paramRow(m, def, pd, { label: r.label, rename: () => this.renameRef(r, 'parameter'), open });
      const above: HTMLElement[] = [];
      if (arranging && r.col) above.push(this.columnChip(a, i));
      else if (arranging && r.group && !r.head) above.push(this.groupChip(a, i));
      if (r.head || (arranging && this.newHeading === `${a.id}:${i}`)) above.push(this.heading(a, i, arranging));
      if (arranging) {
        this.arrangeItem(row, a, 'param', i);
        row.append(this.arrangeTools(a, i, pd.screen ? spanRoom[i] : 0));
      }
      return [{ el: row, input: pd.input ? { module: m.id, port: pd.input } : undefined, col: !!r.col, above, span: pd.screen ? r.span : undefined, gap: !!starts.get(i) && !r.col && !r.head }];
    });
    body.append(...this.edgeLayout(ins, outs, params));
    if (!a.inputs.length && !a.outputs.length && !a.params.length) {
      const hint = document.createElement('p');
      hint.className = 'muted empty';
      hint.textContent = 'nothing exposed: open it and mark ports and parameters';
      body.append(hint);
    }
    el.append(head, body);
    return el;
  }

  // ---- arranging a collapsed assembly card: the order of its rows and jacks, column breaks, headings

  /** the collapsed assembly whose card is being arranged (its menu's Arrange the card), else null */
  private arrangeAsm: number | null = null;
  /** a heading just added (`asm:row`): drawn as an empty field with the focus until it gets a text */
  private newHeading: string | null = null;

  /** a layout change of an assembly card: undoable, saved, no engine reload */
  private layoutChange(fn: () => void): void {
    const before = this.mark();
    fn();
    if (!this.commit(before)) return this.rebuild();
    this.rebuild();
    this.ev.onLayout(this.patch);
  }

  /** a heading above row `i`: plain text, a field while arranging (empty = gone) */
  private heading(a: AssemblyInst, i: number, arranging: boolean): HTMLElement {
    const r = a.params[i];
    const h = document.createElement('div');
    h.className = 'ehead';
    h.dataset.arrKind = 'param';
    h.dataset.arrIndex = String(i);
    h.dataset.arrBefore = '1'; // a row dropped on a heading goes under it
    if (!arranging) {
      h.textContent = r.head ?? '';
      h.title = 'double-click to rename';
      h.ondblclick = () => {
        const v = window.prompt('Heading (empty removes it)', r.head ?? '');
        if (v !== null) this.layoutChange(() => setHeading(a.params, i, v));
      };
      return h;
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.value = r.head ?? '';
    input.placeholder = 'heading';
    input.maxLength = 40;
    input.setAttribute('aria-label', 'Heading');
    const commit = (): void => {
      if (this.newHeading === `${a.id}:${i}`) this.newHeading = null;
      this.layoutChange(() => setHeading(a.params, i, input.value));
    };
    input.onchange = commit;
    input.onblur = () => { if (!input.value.trim()) commit(); };
    input.onkeydown = (e) => {
      e.stopPropagation(); // typing is not shortcuts
      if (e.key === 'Enter' || e.key === 'Escape') input.blur();
    };
    input.onpointerdown = (e) => e.stopPropagation();
    const x = this.button('×', 'Remove the heading', () => this.layoutChange(() => setHeading(a.params, i, '')), 'sm arr-x');
    h.append(input, x);
    if (this.newHeading === `${a.id}:${i}`) requestAnimationFrame(() => input.focus());
    return h;
  }

  /** while arranging: the mark of a column break above the column's first row, with a button to join the columns */
  private columnChip(a: AssemblyInst, i: number): HTMLElement {
    const c = document.createElement('div');
    c.className = 'ebreak';
    c.textContent = 'new column';
    c.append(this.button('×', 'Join with the column before', () => this.layoutChange(() => setColumnBreak(a.params, i, false)), 'sm arr-x'));
    return c;
  }

  /** while arranging: the mark of a group start (`ParamRef.group`) above its first row, with a button to undo it */
  private groupChip(a: AssemblyInst, i: number): HTMLElement {
    const c = document.createElement('div');
    c.className = 'ebreak';
    c.textContent = 'new group';
    c.append(this.button('×', 'Let the groups fill in fours here again', () => this.layoutChange(() => setGroupBreak(a.params, i, false)), 'sm arr-x'));
    return c;
  }

  /** whether a group already starts at row `i` of an assembly card on its own (the one before it is full) */
  private groupStartAt(a: AssemblyInst, i: number): boolean {
    const shown = a.params.map((r) => { const m = this.patch.modules.find((x) => x.id === r.module); return m ? rowDef(DEFS[m.type], r.param) : undefined; });
    const kept = a.params.map((_, k) => k).filter((k) => shown[k] && !shown[k]!.onScreen);
    const k = kept.indexOf(i);
    return k > 0 && groupStarts(kept.map((j) => ({ ...a.params[j], knob: !shown[j]!.screen })))[k];
  }

  /** while arranging: on a row's top edge, + heading and a column break before it; on a display that could reach across
   * `room` columns, ↔ steps how many it spans (1 .. room, then back to 1) */
  private arrangeTools(a: AssemblyInst, i: number, room = 0): HTMLElement {
    const t = document.createElement('span');
    t.className = 'arr-tools';
    const r = a.params[i];
    if (!r.head) t.append(this.button('+ heading', 'A heading above this row', () => {
      this.newHeading = `${a.id}:${i}`;
      this.rebuild();
    }, 'sm'));
    if (i > 0 && !r.col && !r.head && !r.group && !this.groupStartAt(a, i)) t.append(this.button('↵ new group', 'End the group before this row: this row starts the next FM-1 page', () => this.layoutChange(() => setGroupBreak(a.params, i, true)), 'sm'));
    if (i > 0 && !r.col) t.append(this.button('↦ column', 'Start a new column with this row', () => this.layoutChange(() => setColumnBreak(a.params, i, true)), 'sm'));
    if (room > 1) {
      const now = Math.min(r.span ?? 1, room);
      const next = now >= room ? 1 : now + 1;
      t.append(this.button(`↔ span ${now}`, next > 1 ? `Reach across ${next} columns` : 'Back to its own column', () => this.layoutChange(() => setSpan(a.params, i, next)), 'sm arr-span'));
    }
    for (const b of t.querySelectorAll('button')) b.addEventListener('pointerdown', (e) => e.stopPropagation());
    return t;
  }

  /**
   * While arranging, a row or jack can be dragged before or after another of its kind (rows among rows, inputs among
   * inputs, outputs among outputs). A mouse drags at once, a finger after a long press.
   */
  private arrangeItem(el: HTMLElement, a: AssemblyInst, kind: 'param' | 'in' | 'out', index: number): void {
    el.dataset.arrKind = kind;
    el.dataset.arrIndex = String(index);
    el.classList.add('arr-item');
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('.arr-tools, input[type=text]')) return;
      e.preventDefault();
      e.stopPropagation();
      const card = el.closest<HTMLElement>('.module')!;
      const x0 = e.clientX, y0 = e.clientY;
      let live = e.pointerType !== 'touch';
      let started = false;
      let target: { el: HTMLElement; after: boolean } | null = null;
      const hold = live ? 0 : window.setTimeout(() => { live = true; el.classList.add('arr-held'); }, LONG_PRESS_MS);
      const mark = (t: typeof target): void => {
        card.querySelectorAll('.arr-before, .arr-after').forEach((x) => x.classList.remove('arr-before', 'arr-after'));
        if (t) t.el.classList.add(t.after ? 'arr-after' : 'arr-before');
      };
      const move = (ev: PointerEvent): void => {
        if (!live) {
          if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) end(); // a swipe, not a long press
          return;
        }
        if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
        started = true;
        el.classList.add('arr-dragging');
        target = this.arrangeTarget(card, kind, el, ev.clientX, ev.clientY);
        mark(target);
      };
      const end = (): void => {
        window.clearTimeout(hold);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', end);
        el.classList.remove('arr-dragging', 'arr-held');
        mark(null);
      };
      const up = (): void => {
        const t = target;
        end();
        if (!started || !t) return;
        const to = Number(t.el.dataset.arrIndex);
        const after = t.after && !t.el.dataset.arrBefore;
        this.layoutChange(() => {
          if (kind === 'param') a.params = moveParam(a.params, index, to, after);
          else if (kind === 'in') a.inputs = moveRef(a.inputs, index, to, after);
          else a.outputs = moveRef(a.outputs, index, to, after);
        });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', end);
    }, true);
  }

  /** the item of `kind` nearest the pointer on the card, and whether the drop goes after it (below; right of a bottom jack) */
  private arrangeTarget(card: HTMLElement, kind: string, self: HTMLElement, x: number, y: number): { el: HTMLElement; after: boolean } | null {
    let best: { el: HTMLElement; after: boolean } | null = null;
    let dist = Infinity;
    for (const c of card.querySelectorAll<HTMLElement>(`[data-arr-kind="${kind}"]`)) {
      if (c === self) continue;
      const r = c.getBoundingClientRect();
      const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
      if (d >= dist) continue;
      dist = d;
      const across = c.classList.contains('bottom');
      best = { el: c, after: across ? x > r.left + r.width / 2 : y > r.top + r.height / 2 };
    }
    return best;
  }

  private renameRef(r: { label: string }, what: string): void {
    const v = window.prompt(`Label of this ${what}`, r.label)?.trim();
    if (v && v !== r.label) this.change(() => (r.label = v));
  }

  /** the frame around an expanded assembly's cards, with its header; placed by layoutFrames() once the cards have a size */
  private frame(a: AssemblyInst, perVoice: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'frame' + (a.bypass ? ' off' : '') + (this.selectedAsm.has(a.id) ? ' selected' : '');
    el.dataset.asm = String(a.id);
    const head = document.createElement('div');
    head.className = 'fhead';
    const tools = document.createElement('span');
    tools.className = 'tools';
    tools.append(this.pickButton(a), ...this.assemblyButtons(a));
    el.classList.toggle('picking', this.picking(a));
    const title = this.titleOf(a, perVoice);
    title.prepend(this.tag(null));
    head.append(this.chevron(a), title, tools);
    this.headMenu(head, (at) => this.assemblyMenu(a, at));
    el.append(head);
    this.frames.set(a.id, el);
    const parent = parentOf(this.patch, a.id);
    if (parent) tools.prepend(this.outButton(parent, () => this.takeOutAssembly(parent, a)));
    this.frameDrag(head, a);
    this.resizeAssembly(el, a);
    return el;
  }

  /**
   * The box around what an expanded assembly shows: its member cards, its children's cards (collapsed) or frames (expanded), in
   * canvas coordinates; `exclude` leaves cards out and `excludeAsm` children (while they are dragged)
   */
  private frameRect(a: AssemblyInst, exclude?: Set<number>, excludeAsm?: number): Rect | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const take = (r: Rect): void => {
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w);
      y1 = Math.max(y1, r.y + r.h);
    };
    const box = (c: HTMLElement): Rect => ({ x: c.offsetLeft, y: c.offsetTop, w: c.offsetWidth, h: c.offsetHeight });
    for (const id of a.modules) {
      if (exclude?.has(id)) continue;
      const c = this.cards.get(id);
      if (c) take(box(c));
    }
    for (const ch of childrenOf(this.patch, a)) {
      if (ch.id === excludeAsm) continue;
      const c = this.containers.get(ch.id);
      if (c) take(box(c));
      else if (ch.open) {
        const r = this.frameRect(ch, exclude, excludeAsm);
        if (r) take(r);
      }
    }
    if (x0 === Infinity) return null;
    const head = FRAME_HEAD;
    return { x: x0 - FRAME_PAD_X, y: y0 - FRAME_PAD - head, w: Math.max(x1 - x0 + 2 * FRAME_PAD_X, a.frameSize?.width ?? 0), h: Math.max(y1 - y0 + 2 * FRAME_PAD + head, a.frameSize?.height ?? 0) };
  }

  private layoutFrames(exclude?: Set<number>, excludeAsm?: number): void {
    for (const a of assembliesOf(this.patch)) {
      const el = this.frames.get(a.id);
      if (!el) continue;
      const r = this.frameRect(a, exclude, excludeAsm) ?? this.frameRect(a);
      if (!r) continue;
      el.style.left = `${Math.max(0, r.x)}px`;
      el.style.top = `${Math.max(0, r.y)}px`;
      el.style.width = `${r.w}px`;
      el.style.height = `${r.h}px`;
    }
  }

  // ---- dragging and selection

  /** pointer drag on a handle: `move` gets the delta since the previous event, `up` runs at the end */
  private dragOn(handle: HTMLElement, start: (e: PointerEvent) => boolean, move: (dx: number, dy: number) => void, up: () => void): void {
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (!start(e)) return;
      e.preventDefault();
      let lx = e.clientX;
      let ly = e.clientY;
      // a long press (touch, no movement) opens the context menu instead of dragging
      const card = handle.closest('.module') as HTMLElement | null;
      const sx = e.clientX, sy = e.clientY;
      let press = 0;
      if (e.pointerType === 'touch' && card?.dataset.id) {
        press = window.setTimeout(() => {
          press = 0;
          onUp();
          const m = this.patch.modules.find((x) => x.id === Number(card.dataset.id));
          if (m) this.contextMenu(m, DEFS[m.type], { x: m.x + 20, y: m.y + 30 });
        }, LONG_PRESS_MS);
      }
      const onMove = (ev: PointerEvent): void => {
        if (press && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) {
          clearTimeout(press);
          press = 0;
        }
        move((ev.clientX - lx) / this.zoom, (ev.clientY - ly) / this.zoom);
        lx = ev.clientX;
        ly = ev.clientY;
      };
      const onUp = (): void => {
        if (press) clearTimeout(press);
        press = 0;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        up();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  private place(m: ModuleInst, dx: number, dy: number): void {
    m.x = Math.max(0, m.x + dx);
    m.y = Math.max(0, m.y + dy);
    const el = this.cards.get(m.id);
    if (el) {
      el.style.left = `${m.x}px`;
      el.style.top = `${m.y}px`;
    }
  }

  /**
   * What a drag of the selection moves: the selected assemblies that are not inside another selected one (each with
   * everything inside it) and the selected modules that none of those holds.
   */
  private dragSet(): { mods: ModuleInst[]; asms: AssemblyInst[] } {
    const sel = assembliesOf(this.patch).filter((a) => this.selectedAsm.has(a.id));
    const asms = sel.filter((a) => !sel.some((b) => b !== a && descendants(this.patch, b).some((d) => d.id === a.id)));
    const covered = new Set(asms.flatMap((a) => allModules(this.patch, a)));
    const mods = this.patch.modules.filter((m) => this.selected.has(m.id) && !covered.has(m.id));
    return { mods, asms };
  }

  /** move a drag set by (dx, dy): model and elements; the frames follow (a member pushes its frame's edge out) */
  private moveSet(set: { mods: ModuleInst[]; asms: AssemblyInst[] }, dx: number, dy: number): void {
    for (const m of set.mods) this.place(m, dx, dy);
    for (const a of set.asms) this.moveTree(a, dx, dy, false);
    this.layoutFrames();
    this.drawCables();
  }

  /** a press on a card's or frame's handle: shift toggles the item in the selection, else the drag takes the selection with it */
  private groupDrag(handle: HTMLElement, item: { module?: ModuleInst; asm?: AssemblyInst }, drop: (set: { mods: ModuleInst[]; asms: AssemblyInst[] }) => void): void {
    let set: { mods: ModuleInst[]; asms: AssemblyInst[] } = { mods: [], asms: [] };
    this.dragOn(
      handle,
      (e) => {
        const on = item.module ? this.selected.has(item.module.id) : this.selectedAsm.has(item.asm!.id);
        if (e.shiftKey) {
          if (item.module) this.toggleSelect(item.module.id);
          else this.toggleSelectAsm(item.asm!.id);
          return false;
        }
        if (!on) this.select(item.module ? [item.module.id] : [], item.asm ? [item.asm.id] : []);
        set = this.dragSet();
        this.touch();
        return true;
      },
      (dx, dy) => this.moveSet(set, dx, dy),
      () => {
        this.sizeCanvas();
        this.ev.onLayout(this.patch);
        drop(set);
      },
    );
  }

  private moduleDrag(handle: HTMLElement, m: ModuleInst): void {
    this.groupDrag(handle, { module: m }, (set) => this.dropped(set, true));
  }

  /**
   * After a drag: modules and collapsed assemblies that belong to no assembly join the innermost expanded frame they are
   * dropped into. A member never leaves its assembly by a drag (its frame grows to hold it): the ⇱ button takes it out.
   */
  private dropped(set: { mods: ModuleInst[]; asms: AssemblyInst[] }, nest: boolean): void {
    const movedIds = new Set(set.mods.map((m) => m.id));
    const moving = new Set(set.asms.flatMap((a) => [a.id, ...descendants(this.patch, a).map((d) => d.id)]));
    const ops: (() => void)[] = [];
    const innermost = (el: HTMLElement, skip: (b: AssemblyInst) => boolean): AssemblyInst | undefined => {
      const cx = el.offsetLeft + el.offsetWidth / 2;
      const cy = el.offsetTop + HEAD_Y; // where the hand is: the card's header, not its middle (cards are tall)
      let target: AssemblyInst | undefined;
      for (const b of assembliesOf(this.patch)) {
        if (!b.open || skip(b) || !this.frames.has(b.id)) continue;
        const r = this.frameRect(b, movedIds);
        if (r && cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h && (!target || depthOf(this.patch, b) > depthOf(this.patch, target))) target = b;
      }
      return target;
    };
    for (const m of set.mods) {
      if (assemblyOf(this.patch, m.id)) continue;
      const c = this.cards.get(m.id);
      const target = c && innermost(c, (b) => moving.has(b.id));
      if (target) ops.push(() => addMember(this.patch, target, m.id));
    }
    if (nest)
      for (const a of set.asms) {
        const el = this.containers.get(a.id);
        if (!el || parentOf(this.patch, a.id)) continue;
        const target = innermost(el, (b) => moving.has(b.id));
        if (target) ops.push(() => addChild(this.patch, target, a.id));
      }
    if (!ops.length) {
      this.layoutFrames();
      return;
    }
    const keep = [...this.selected], keepAsm = [...this.selectedAsm];
    if (this.change(() => ops.forEach((op) => op()))) this.select(keep, keepAsm);
  }

  /** the ⇱ on a member's header: take it out of its assembly (one level up), placed beside the frame */
  private outButton(a: AssemblyInst, run: () => void): HTMLButtonElement {
    return this.button('⇱', `Take out of "${a.label}"`, run, 'sm out');
  }

  private takeOutModule(a: AssemblyInst, m: ModuleInst): void {
    const r = this.frameRect(a, new Set([m.id]));
    const up = parentOf(this.patch, a.id);
    this.change(() => {
      removeMember(this.patch, a, m.id);
      if (up && assembliesOf(this.patch).includes(up)) addMember(this.patch, up, m.id);
      if (r) { m.x = Math.max(0, r.x + r.w + 24); m.y = Math.max(0, r.y); }
    });
  }

  private takeOutAssembly(parent: AssemblyInst, a: AssemblyInst): void {
    const r = this.frameRect(parent, undefined, a.id);
    const up = parentOf(this.patch, parent.id);
    this.change(() => {
      removeChild(this.patch, parent, a.id);
      if (up && assembliesOf(this.patch).includes(up)) addChild(this.patch, up, a.id);
      if (r) {
        const box = a.open ? this.frameRect(a) : { x: a.x, y: a.y };
        if (box) moveAssembly(this.patch, a, Math.max(0, r.x + r.w + 24) - box.x, Math.max(0, r.y) - box.y);
      }
    });
  }

  /** move an assembly with everything inside it, model and elements; `layout` = redraw the frames and cables too */
  private moveTree(a: AssemblyInst, dx: number, dy: number, layout = true): void {
    moveAssembly(this.patch, a, dx, dy);
    const asms = [a, ...descendants(this.patch, a)];
    const ids = new Set(asms.flatMap((x) => x.modules));
    for (const m of this.patch.modules) {
      const el = this.cards.get(m.id);
      if (!ids.has(m.id) || !el) continue;
      el.style.left = `${m.x}px`;
      el.style.top = `${m.y}px`;
    }
    for (const x of asms) {
      const el = this.containers.get(x.id);
      if (!el) continue;
      el.style.left = `${x.x}px`;
      el.style.top = `${x.y}px`;
    }
    if (!layout) return;
    this.layoutFrames();
    this.drawCables();
  }

  private assemblyDrag(_el: HTMLElement, handle: HTMLElement, a: AssemblyInst): void {
    this.groupDrag(handle, { asm: a }, (set) => this.dropped(set, true));
  }

  private frameDrag(handle: HTMLElement, a: AssemblyInst): void {
    this.groupDrag(handle, { asm: a }, (set) => this.dropped({ mods: set.mods, asms: [] }, false));
  }

  private select(ids: number[], asms: number[] = []): void {
    this.selected.clear();
    this.selectedAsm.clear();
    for (const id of ids) this.selected.add(id);
    for (const id of asms) this.selectedAsm.add(id);
    this.showSelection();
  }

  /** Ctrl / Cmd+A: every module and assembly at the top of the canvas (the docked Main is not a card) */
  selectAll(): boolean {
    const docked = this.docked();
    const inAsm = new Set(assembliesOf(this.patch).flatMap((a) => a.modules));
    const mods = this.patch.modules.filter((m) => m !== docked && !inAsm.has(m.id)).map((m) => m.id);
    const asms = assembliesOf(this.patch).filter((a) => !parentOf(this.patch, a.id)).map((a) => a.id);
    if (!mods.length && !asms.length) return false;
    this.select(mods, asms);
    return true;
  }

  private toggleSelect(id: number): void {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.showSelection();
  }

  private toggleSelectAsm(id: number): void {
    if (this.selectedAsm.has(id)) this.selectedAsm.delete(id);
    else this.selectedAsm.add(id);
    this.showSelection();
  }

  private showSelection(): void {
    for (const [id, el] of this.cards) el.classList.toggle('selected', this.selected.has(id));
    for (const [id, el] of [...this.containers, ...this.frames]) el.classList.toggle('selected', this.selectedAsm.has(id));
  }

  /** a drag on empty canvas selects the cards it touches; a click on empty canvas clears the selection */
  private rubberBand(e: PointerEvent): void {
    const t = e.target as HTMLElement;
    if (e.button !== 0 || t.closest('.module, .fhead, .dot, button, input, select, .ctx')) return;
    e.preventDefault();
    // a click on the empty canvas drops an armed jack's ghost cable
    if (this.armed) return this.cancelArm();
    if (e.pointerType === 'touch') {
      // one finger on the empty canvas pans it (a rubber band needs a mouse or shift)
      let lx = e.clientX, ly = e.clientY;
      const pan = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return;
        this.canvas.scrollBy(lx - ev.clientX, ly - ev.clientY);
        lx = ev.clientX;
        ly = ev.clientY;
      };
      const stop = (): void => {
        window.removeEventListener('pointermove', pan);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
      };
      window.addEventListener('pointermove', pan);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
      return;
    }
    const base = this.canvas.getBoundingClientRect();
    const at = (ev: PointerEvent): Pt => ({ x: (ev.clientX - base.left) / this.zoom + this.canvas.scrollLeft / this.zoom, y: (ev.clientY - base.top) / this.zoom + this.canvas.scrollTop / this.zoom });
    const o = at(e);
    const box = document.createElement('div');
    box.className = 'rubber';
    this.modulesEl.append(box);
    let r: Rect = { x: o.x, y: o.y, w: 0, h: 0 };
    const move = (ev: PointerEvent): void => {
      const p = at(ev);
      r = { x: Math.min(o.x, p.x), y: Math.min(o.y, p.y), w: Math.abs(p.x - o.x), h: Math.abs(p.y - o.y) };
      Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      box.remove();
      const hit: number[] = [];
      const hitAsm: number[] = [];
      if (r.w > 4 || r.h > 4) {
        const touches = (c: HTMLElement): boolean => c.offsetLeft < r.x + r.w && c.offsetLeft + c.offsetWidth > r.x && c.offsetTop < r.y + r.h && c.offsetTop + c.offsetHeight > r.y;
        const holds = (c: HTMLElement): boolean => c.offsetLeft >= r.x && c.offsetLeft + c.offsetWidth <= r.x + r.w && c.offsetTop >= r.y && c.offsetTop + c.offsetHeight <= r.y + r.h;
        // a frame is taken when the band holds all of it (a band inside a frame picks cards in it), a collapsed card when touched
        for (const [id, f] of this.frames) if (holds(f)) hitAsm.push(id);
        for (const [id, c] of this.containers) if (touches(c)) hitAsm.push(id);
        const taken = assembliesOf(this.patch).filter((a) => hitAsm.includes(a.id));
        const coveredMods = new Set(taken.flatMap((a) => allModules(this.patch, a)));
        const coveredAsm = new Set(taken.flatMap((a) => descendants(this.patch, a).map((d) => d.id)));
        for (const id of [...hitAsm]) if (coveredAsm.has(id)) hitAsm.splice(hitAsm.indexOf(id), 1);
        for (const [id, c] of this.cards) if (!coveredMods.has(id) && touches(c)) hit.push(id);
      }
      if (e.shiftKey) {
        hit.forEach((id) => this.selected.add(id));
        hitAsm.forEach((id) => this.selectedAsm.add(id));
      } else this.select(hit, hitAsm);
      this.showSelection();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---- cables

  private center(el: HTMLElement, origin = this.world): Pt {
    const r = el.getBoundingClientRect();
    const c = origin.getBoundingClientRect();
    return { x: (r.left - c.left + r.width / 2) / this.zoom - origin.clientLeft, y: (r.top - c.top + r.height / 2) / this.zoom - origin.clientTop };
  }

  /**
   * A cable's Bézier points from a to b. An end leaves its jack sideways (out to the right, in from the left), upwards on
   * a docked jack (the dock is below the canvas) and downwards on a jack under a card's bottom edge. Taut, it is one curve
   * (split in two at its middle). Slack drops only the middle and puts a short straight stub at each end (`CABLE_STUB` at
   * full slack): a plug holds the cable straight and it bends most where it hangs free, so a drooping cable still leaves
   * its jack square, and one from a docked jack to a module just below the view still rises out of the dock before it falls.
   */
  private curvePts(a: Pt, b: Pt, dirA: CableEnd = 'side', dirB: CableEnd = 'side'): Pt[] {
    const stub = this.sway * CABLE_STUB;
    if (stub <= 0) return this.spanPts(a, b, dirA, dirB);
    const away = (p: Pt, dir: CableEnd, sx: number, t: number): Pt =>
      dir === 'up' ? { x: p.x, y: p.y - t } : dir === 'down' ? { x: p.x, y: p.y + t } : { x: p.x + sx * t, y: p.y };
    const sa = (t: number): Pt => away(a, dirA, 1, t);
    const sb = (t: number): Pt => away(b, dirB, -1, t);
    return [a, sa(stub / 3), sa((2 * stub) / 3), ...this.spanPts(sa(stub), sb(stub), dirA, dirB), sb((2 * stub) / 3), sb(stub / 3), b];
  }

  /** the curve between the stubs: two cubic segments joined in the middle; slack drops the middle, the ends stay square */
  private spanPts(a: Pt, b: Pt, dirA: CableEnd, dirB: CableEnd): Pt[] {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    const dy = Math.max(60, Math.abs(b.y - a.y) / 2);
    const handle = (p: Pt, dir: CableEnd, sx: number): Pt => (dir === 'up' ? { x: p.x, y: p.y - dy } : dir === 'down' ? { x: p.x, y: p.y + dy } : { x: p.x + sx, y: p.y });
    const mid = (u: Pt, v: Pt): Pt => ({ x: (u.x + v.x) / 2, y: (u.y + v.y) / 2 });
    const p1 = handle(a, dirA, dx);
    const p2 = handle(b, dirB, -dx);
    // de Casteljau split at t = 1/2
    const q0 = mid(a, p1), q1 = mid(p1, p2), q2 = mid(p2, b);
    const r0 = mid(q0, q1), r1 = mid(q1, q2), m = mid(r0, r1);
    // slack: the middle drops by a share of the cable's length, so a long cable droops more than a short one
    const sag = this.sway * 0.75 * (0.6 * Math.hypot(b.x - a.x, b.y - a.y) + 40);
    if (sag <= 0) return [a, q0, r0, m, r1, q2, b];
    const lead = (p: Pt, q: Pt): Pt => {
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      // the lead shortens as the slack grows, so the bend comes close to the plug
      const k = (len * (1 - 0.55 * this.sway) + 0.08 * sag) / len;
      return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
    };
    const drop = (p: Pt): Pt => ({ x: p.x, y: p.y + sag });
    return [a, lead(a, q0), drop(r0), drop(m), drop(r1), lead(b, q2), b];
  }

  private curve(a: Pt, b: Pt, dirA: CableEnd = 'side', dirB: CableEnd = 'side'): string {
    return pathOf(this.curvePts(a, b, dirA, dirB));
  }

  /** which way a cable leaves this jack */
  private endOf(el: HTMLElement): CableEnd {
    return this.inDock(el) ? 'up' : el.dataset.edge === 'bottom' ? 'down' : 'side';
  }

  /** the cables' continuation over the dock (see positionCables) */
  private get dockCables(): SVGSVGElement | null {
    return (this.dock?.parentElement?.querySelector('svg.dock-cables') as SVGSVGElement | null) ?? null;
  }
  /** a cable's copy on the dock overlay, clipped to the strip above each docked jack it ends at */
  private overPaths = new Map<SVGPathElement, { copy: SVGPathElement; clips: { rect: SVGRectElement; jack: HTMLElement }[] }>();

  private inDock(el: HTMLElement): boolean {
    return !!this.dock?.contains(el) || !!this.wheelHost?.contains(el);
  }

  /**
   * Cable paths are retained so animation only moves their endpoints. A cable to a docked jack is clipped by the canvas;
   * its copy on the dock's overlay draws the rest (the same curve, mapped from world to overlay space), but only the
   * strip between the jack and the dock's top edge: a cable to a module below the canvas's view stays under the panel.
   */
  /** the sidebar sliders' source cables, over everything up to their thumbs; each hidden while either end is not shown */
  /** the layer over the whole window for the cables into the sidebar sliders and the cable being dragged */
  private sideOverlay(): SVGSVGElement {
    if (!this.sideLayer) {
      this.sideLayer = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
      this.sideLayer.setAttribute('class', 'cables slack-cable');
      this.sideLayer.setAttribute('aria-hidden', 'true');
      document.body.append(this.sideLayer);
    }
    return this.sideLayer;
  }

  // ---- Main's knobs: K1..K4 edit the rows of the device page in focus (pages.ts)

  /** the device and page in focus */
  private focusedDevice(): Device | undefined { return this.gloOn ? this.gloDevice() : this.devices.find((d) => d.key === this.focus?.device); }
  private focusedPage(): Page | undefined { return this.gloOn ? this.gloDevice().pages[0] : this.focusedDevice()?.pages[this.focus!.page]; }

  // ---- GLO (#118): Main's global page on the knobs, as on the FM-1 (pages_ui.c glo_page): K1 tempo, K2 morph, K3 / K4 the
  // first Arpeggiator's rate and gate. Not one of the devices: the pickers leave it, the focus stays where it was.
  private gloOn = false;
  private gloDevice(): Device {
    const main = this.patch.modules.find((m) => m.type === 'fm1');
    const arp = this.patch.modules.find((m) => m.type === 'arp');
    const rows: PageRow[] = main ? [{ module: main.id, param: 'tempo', label: 'Tempo' }, { module: main.id, param: 'morph', label: 'Morph' }] : [];
    if (main && arp) rows.push({ module: arp.id, param: 'rate', label: 'Arp rate' }, { module: arp.id, param: 'gate', label: 'Arp gate' });
    return { key: '$glo', name: 'Global', pages: [{ name: 'Global', part: 0, parts: 1, rows }] };
  }

  /** GLO's page on (or off: back to the focus it left) */
  private setGlo(on: boolean): void {
    if (on === this.gloOn) return;
    this.gloOn = on;
    if (on && this.pageOn) this.pageOn = null;
    this.fillFocus();
    this.markFocus();
    this.syncPageButtons();
    this.dock?.querySelector<HTMLElement>('.panel-btn[data-button="glo"]')?.setAttribute('aria-pressed', String(on));
  }

  /** the dock's knob column: the four dials, the DEVICE and PAGE pickers (the FM-1's SELECT and ALGO) under them */
  private fillFocus(): void {
    const col = this.focusCol;
    if (!col) return;
    this.parameterDisplays = this.parameterDisplays.filter((d) => !d.el || (d.el.isConnected && col.contains(d.el) === false));
    const dev = this.focusedDevice();
    const pg = this.focusedPage();
    const pick = (label: string, text: string, count: number, get: () => number, set: (i: number) => void): HTMLElement => {
      const value = document.createElement('span');
      value.textContent = text;
      const el = picker({ label, value, count: () => count, get, set });
      el.classList.add('focus-pick');
      return el;
    };
    const pickers = document.createElement('div');
    pickers.className = 'focus-pickers';
    const di = this.devices.findIndex((d) => d.key === dev?.key);
    pickers.append(
      pick('device (SELECT)', dev?.name ?? 'no device', this.devices.length, () => di, (i) => this.setFocus({ device: this.devices[i].key, page: 0 })),
      pick('page (ALGO)', pg ? pageTitle(pg) : '—', dev?.pages.length ?? 0, () => this.focus?.page ?? 0, (i) => this.setFocus({ device: dev!.key, page: i })),
    );
    pickers.title = 'The device and the page Main\u2019s knobs turn (SELECT and ALGO on the FM-1). Click any row on a card to put its page on the knobs.';
    const knobs = document.createElement('div');
    knobs.className = 'deck-knobs';
    this.dials = [];
    this.knobJacks = [];
    for (let i = 0; i < PAGE_ROWS; i++) knobs.append(this.boundKnob(i, pg?.rows[i]));
    // the pickers under the knobs' captions, so the binding wires (from the jacks on the edge) never cross them
    col.replaceChildren(knobs, pickers);
  }

  /** knob K(i + 1) on the dock, bound to a row of the page in focus (or idle when the page has fewer rows) */
  private boundKnob(i: number, r: PageRow | undefined): HTMLElement {
    const k = `k${i + 1}`;
    const box = document.createElement('div');
    box.className = 'deck-knob';
    box.dataset.param = k;
    box.style.setProperty('--knob', `var(--${k})`);
    const dial = document.createElement('div');
    dial.className = 'dial';
    const name = document.createElement('span');
    name.className = 'dial-name';
    name.textContent = `K${i + 1}`;
    dial.append(name);
    const caption = document.createElement('span');
    caption.className = 'dial-caption';
    // the binding wire's fixed end on the dock's top edge, a stem down to the dial: not a patch point
    const jack = document.createElement('span');
    jack.className = 'knob-jack';
    const stem = document.createElement('span');
    stem.className = 'knob-stem';
    box.append(jack, stem, dial, caption);
    this.dials[i] = dial;
    this.knobJacks[i] = jack;
    const m = r && this.patch.modules.find((x) => x.id === r.module);
    const pd = m && DEFS[m.type].params.find((q) => q.name === r!.param);
    if (!r || !m || !pd) {
      box.classList.add('off');
      caption.textContent = '—';
      dial.title = `K${i + 1}: this page has no row for it`;
      return box;
    }
    caption.textContent = r.label;
    // the dial is the row's position in its range (octaves for a log parameter); choices and switches snap
    const unitOf = (v: number): number => (pd.choices ? (pd.choices.length > 1 ? Math.round(v) / (pd.choices.length - 1) : 0) : toUnit(pd, v));
    const valueOf = (u: number): number => {
      if (pd.toggle) return u >= 0.5 ? 1 : 0;
      if (pd.choices) return Math.round(u * (pd.choices.length - 1));
      const v = fromUnit(pd, u);
      return pd.log ? snapTo(pd, v) : pd.step ? Math.round(v / pd.step) * pd.step : Number(v.toFixed(6));
    };
    const text = (v: number): string => {
      if (pd.choices) return choiceName(m.type, pd.name, pd.choices[Math.round(v)] ?? '');
      const f = formatValue(v, pd.unit, pd.min < 0);
      return f.unit ? `${f.num} ${f.unit}` : f.num;
    };
    const c = dragControl(dial, `K${i + 1}: ${r.label}`, 0, 1, unitOf(m.params[r.param]), (u) => this.setParam(m.id, r.param, valueOf(u)), {
      reset: unitOf(pd.default),
      text: (u) => text(valueOf(u)),
      draw: (u) => dial.style.setProperty('--v', String(u)),
    });
    (dial as HTMLElement & { sync?: () => void }).sync = () => c.set(unitOf(m.params[r.param]));
    return box;
  }

  /** the dials follow their rows' base values (a slider moved, an undo, the FM-1) */
  private syncDials(): void {
    for (const d of this.dials) (d as HTMLElement & { sync?: () => void }).sync?.();
  }

  /** colour the rows of the page in focus with their knobs (a badge and a ring, K1..K4); while an assembly is arranged,
   * every row of it shows its knob and where its pages start */
  private markFocus(): void {
    for (const el of this.modulesEl.querySelectorAll<HTMLElement>('.param.bound, .param.page-start')) {
      el.classList.remove('bound', 'page-start', 'focused');
      delete el.dataset.kn;
      delete el.dataset.page;
      el.style.removeProperty('--knob');
    }
    const rowEls = (r: PageRow): HTMLElement[] => [...this.modulesEl.querySelectorAll<HTMLElement>(`.param[data-mod="${r.module}"][data-param="${r.param}"]`)];
    // the page in focus also fills its bars in the knobs' colours (`focused`), as the FM-1's page does
    const mark = (pg: Page, start: boolean): void => pg.rows.forEach((r, i) => rowEls(r).forEach((el) => {
      el.classList.add('bound');
      el.classList.toggle('focused', !start);
      el.dataset.kn = String(i + 1);
      el.style.setProperty('--knob', `var(--k${i + 1})`);
      if (start && i === 0) { el.classList.add('page-start'); el.dataset.page = pageTitle(pg); }
    }));
    const arranging = this.devices.find((d) => d.asm !== undefined && d.asm === this.arrangeAsm);
    if (arranging) arranging.pages.forEach((pg) => mark(pg, true));
    const pg = this.focusedPage();
    if (pg) mark(pg, false);
    this.positionBindings();
  }

  /** a press on a row: its device page goes on the knobs */
  private focusRow(module: number, param: string): void {
    const at = findRow(this.devices, module, param);
    if (at) this.setFocus({ device: this.devices[at.device].key, page: at.page });
  }

  /** put a device page on Main's knobs; `notify` tells the host (the FM-1 follows with Live on) */
  setFocus(f: { device: string; page: number } | null, notify = true): void {
    const next = fixFocus(this.devices, f);
    if (this.gloOn && !this.listMoving) {   // a device page chosen on GLO's page: GLO is left
      this.setGlo(false);
      const i = PANEL_BUTTONS.indexOf('glo');
      if (i >= 0) this.ev.onButton?.(i, false);
    }
    if (next?.device === this.focus?.device && next?.page === this.focus?.page) return;
    if (!this.listMoving && this.pageOn) {   // the focus moved some other way: the Page button's list is left
      const i = PANEL_BUTTONS.indexOf(this.pageOn.b);
      this.pageOn = null;
      if (i >= 0) this.ev.onButton?.(i, false);
      this.syncPageButtons();
    }
    this.focus = next;
    this.fillFocus();
    this.markFocus();
    if (notify && next) this.ev.onFocus?.(next.device, next.page);
  }

  /** the FM-1 shows another page (patchbin.ts editorPage turns its indices into this) */
  focusFrom(f: { device: string; page: number }): void {
    this.setFocus(f, false);
  }

  /** a knob turned elsewhere (MIDI CC 16..19, the FM-1): K(i + 1) to position u (0..1) of its row's range */
  turnKnob(i: number, u: number): void {
    const r = this.focusedPage()?.rows[i];
    const m = r && this.patch.modules.find((x) => x.id === r.module);
    const pd = m && DEFS[m.type].params.find((q) => q.name === r!.param);
    if (!r || !m || !pd) return;
    const x = Math.min(1, Math.max(0, u));
    const v = pd.toggle ? (x >= 0.5 ? 1 : 0) : pd.choices ? Math.round(x * (pd.choices.length - 1)) : pd.log ? snapTo(pd, fromUnit(pd, x)) : Number(fromUnit(pd, x).toFixed(6));
    this.setParam(m.id, r.param, v);
  }

  /** the rows of the page in focus (the FM-1's device page, the knobs' targets) */
  focusRows(): PageRow[] { return this.focusedPage()?.rows ?? []; }

  /** the dotted lines from the dials to the rows they turn, drawn over everything; a row out of view gets none */
  private positionBindings(): void {
    if (!this.bindLayer) {
      this.bindLayer = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
      this.bindLayer.setAttribute('class', 'bind-cables');
      this.bindLayer.setAttribute('aria-hidden', 'true');
      document.body.append(this.bindLayer);
    }
    const layer = this.bindLayer;
    const view = this.canvas.getBoundingClientRect();
    const paths: SVGPathElement[] = [];
    const pg = this.focusedPage();
    if (pg && this.canvas.offsetParent !== null) pg.rows.forEach((r, i) => {
      const dial = this.dials[i];
      if (!dial?.isConnected) return;
      const thumb = this.sliderPorts.find((s) => s.m.id === r.module && s.pd.name === r.param)?.jack;
      const row = this.modulesEl.querySelector<HTMLElement>(`.param[data-mod="${r.module}"][data-param="${r.param}"]`);
      const end = thumb?.isConnected && thumb.offsetParent !== null ? thumb : row;
      if (!end || end.offsetParent === null) return;
      const e = end.getBoundingClientRect();
      const b = { x: e.left + e.width / 2, y: e.top + e.height / 2 };
      if (b.x < view.left || b.x > view.right || b.y < view.top || b.y > view.bottom) return;
      const d = (this.knobJacks[i]?.isConnected ? this.knobJacks[i] : dial).getBoundingClientRect();
      const a = { x: d.left + d.width / 2, y: d.top };
      const lift = Math.max(40, (a.y - b.y) * 0.45);
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('class', 'bind');
      path.style.setProperty('--knob', `var(--k${i + 1})`);
      path.setAttribute('d', `M${a.x} ${a.y} C${a.x} ${a.y - lift} ${b.x} ${b.y + lift} ${b.x} ${b.y}`);
      paths.push(path);
    });
    layer.replaceChildren(...paths);
  }

  positionSideCables(): void {
    this.sideOverlay();
    const w = this.world.getBoundingClientRect();
    const keep = new Set<SVGPathElement>();
    for (const [key, thumb] of this.sideThumbs) {
      const from = this.patch[key];
      const src = from && this.ports.get(this.key(from.module, from.port, 'out'));
      if (!src || !src.isConnected || this.canvas.offsetParent === null || thumb.offsetParent === null) continue;
      let path = this.sideLayer!.querySelector<SVGPathElement>(`path[data-key="${key}"]`);
      if (!path) {
        path = document.createElementNS(SVGNS, 'path');
        path.dataset.key = key;
        path.addEventListener('click', () => this.setSideSource(key, null));
        this.sideLayer!.append(path);
      }
      keep.add(path);
      const m = this.patch.modules.find((x) => x.id === from!.module)!;
      const kind = DEFS[m.type].outputs.find((o) => o.name === from!.port)?.kind ?? 'control';
      path.setAttribute('class', `cable ${kind}`);
      path.setAttribute('aria-label', 'A sidebar slider\'s source: click to unplug');
      // into the thumb's centre (it moves with the live value), from above
      const r = thumb.getBoundingClientRect();
      const b = { x: (r.left + r.width / 2 - w.left) / this.zoom, y: (r.top + r.height / 2 - w.top) / this.zoom };
      path.setAttribute('d', this.curve(this.center(src), b, this.endOf(src), 'up'));
      path.setAttribute('transform', `translate(${w.left} ${w.top}) scale(${this.zoom})`);
    }
    for (const p of [...this.sideLayer!.querySelectorAll<SVGPathElement>('path[data-key]')]) if (!keep.has(p)) p.remove();
  }

  private positionCables(): void {
    this.positionSideCables();
    this.positionBindings();
    this.positionTraces();
    const w = this.world.getBoundingClientRect();
    const o = this.dockCables?.getBoundingClientRect();
    const routed = this.ribbonRoutes();
    for (const { path, from, to, origin } of this.cablePaths) {
      let pts = routed.get(from)?.get(to);
      if (pts && origin !== this.world) {
        // a copy on a card: the same route in the card's coordinates
        const a = this.center(to, origin), b = this.center(to);
        pts = pts.map((p) => ({ x: p.x + a.x - b.x, y: p.y + a.y - b.y }));
      }
      pts ??= this.curvePts(this.center(from, origin), this.center(to, origin), this.endOf(from), this.endOf(to));
      path.setAttribute('d', pathOf(pts));
      const over = this.overPaths.get(path);
      if (!over || !o) continue;
      over.copy.setAttribute('d', pathOf(pts.map((p) => ({ x: p.x * this.zoom + w.left - o.left, y: p.y * this.zoom + w.top - o.top }))));
      for (const { rect, jack } of over.clips) {
        const j = jack.getBoundingClientRect();
        rect.setAttribute('x', String(j.left - o.left - CLIP_HALF));
        rect.setAttribute('width', String(j.width + 2 * CLIP_HALF));
        rect.setAttribute('y', '0');
        rect.setAttribute('height', String(Math.max(0, j.top - o.top + j.height / 2)));
      }
    }
  }

  /** a frame's box in world coordinates (as `center`) */
  private worldRect(el: HTMLElement): Rect {
    const r = el.getBoundingClientRect();
    const c = this.world.getBoundingClientRect();
    return { x: (r.left - c.left) / this.zoom - this.world.clientLeft, y: (r.top - c.top) / this.zoom - this.world.clientTop, w: r.width / this.zoom, h: r.height / this.zoom };
  }

  private clampLayer: SVGGElement | null = null;

  /**
   * The routes of the cables that cross an expanded assembly's border (ribbons.ts, #85), by their drawn ends, in world
   * coordinates; also draws the ribbons' clamps. Every copy of a cable (on a card, over the dock) follows the same route.
   */
  private ribbonRoutes(): Map<HTMLElement, Map<HTMLElement, Pt[]>> {
    const out = new Map<HTMLElement, Map<HTMLElement, Pt[]>>();
    if (!this.clampLayer || !this.clampLayer.isConnected) {
      this.clampLayer = document.createElementNS(SVGNS, 'g') as SVGGElement;
      this.clampLayer.setAttribute('class', 'ribbon-clamps');
      this.svg.append(this.clampLayer);
    }
    this.clampLayer.replaceChildren();
    const frames: RibbonFrame[] = [];
    for (const [id, el] of this.frames) {
      const a = assemblyById(this.patch, id);
      if (!a?.open || !el.isConnected || !el.offsetWidth) continue;
      const nIn = a.inputs.length;
      frames.push({
        id,
        rect: this.worldRect(el),
        members: new Set(allModules(this.patch, a)),
        depth: depthOf(this.patch, a),
        rank: (dir, module, port, param) => {
          const t = { module, port };
          const i = param !== undefined
            ? a.params.findIndex((r) => r.module === module && r.param === param)
            : (dir === 'in' ? a.inputs : a.outputs).findIndex((r) => targetsOf(r).some((x) => sameEnd(x, t)));
          return i < 0 ? undefined : param !== undefined ? nIn + i : i;
        },
      });
    }
    if (!frames.length) return out;
    const entries = this.cablePaths.filter((e) => e.origin === this.world && e.cable && !e.path.classList.contains('alias'));
    const cables: RibbonCable[] = entries.map(({ from, to, cable }) => ({
      from: { pt: this.center(from), dir: this.endOf(from), module: cable!.from.module, port: cable!.from.port },
      to: { pt: this.center(to), dir: this.endOf(to), module: cable!.to.module, port: cable!.to.port, param: to.dataset.param },
    }));
    const { routes, clamps } = ribbons(frames, cables, (a, b, da, db) => this.curvePts(a, b, da, db));
    for (const [i, pts] of routes) {
      const { from, to } = entries[i];
      if (!out.has(from)) out.set(from, new Map());
      out.get(from)!.set(to, pts);
    }
    for (const c of clamps) {
      const r = document.createElementNS(SVGNS, 'rect');
      r.setAttribute('x', String(c.x));
      r.setAttribute('y', String(c.y));
      r.setAttribute('width', String(c.w));
      r.setAttribute('height', String(c.h));
      r.setAttribute('rx', '2');
      this.clampLayer.append(r);
    }
    return out;
  }

  private inputJack(to: Endpoint): HTMLElement | undefined {
    return this.ports.get(this.key(to.module, to.port, 'in')) ?? [...this.ports.values()].find((dot) =>
      dot.dataset.also && (JSON.parse(dot.dataset.also) as Target[]).some((t) => sameEnd(t, to)));
  }

  /** Outside cables end at side jacks; internal branches are editable input-to-parameter routes. */
  drawCables(): void {
    this.positionSideCables();
    for (const { path } of this.cablePaths) path.remove();
    this.cablePaths = [];
    this.dockCables?.replaceChildren();
    this.overPaths.clear();
    for (const svg of this.modulesEl.querySelectorAll('.internal-cables, .entry-cables')) svg.remove();
    // a card's cables are drawn over its thumbs (a layer that takes no pointer events), while their click areas lie
    // under the thumbs, so a thumb under a cable still drags and patches
    const cardLayers = new Map<HTMLElement, Map<string, SVGSVGElement>>();
    const cardLayer = (card: HTMLElement, cls: 'internal-cables' | 'entry-cables', hits = false): SVGSVGElement => {
      const key = `${cls}${hits ? ' hits' : ''}`;
      let byKey = cardLayers.get(card);
      if (!byKey) cardLayers.set(card, (byKey = new Map()));
      let svg = byKey.get(key);
      if (!svg) {
        svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
        svg.setAttribute('class', `cables ${key}`);
        card.append(svg);
        byKey.set(key, svg);
      }
      return svg;
    };
    for (const dot of [...this.ports.values(), ...this.sliderPorts.map((p) => p.jack)]) dot.classList.remove('connected');
    const add = (from: HTMLElement, to: HTMLElement, kind: string, remove: (() => void) | null, title: string, internal = false, cable?: Cable): void => {
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('class', `cable ${kind}${internal ? ' alias' : ''}${remove ? '' : ' fixed'}`);
      path.setAttribute('aria-label', title);
      if (remove) {
        path.setAttribute('role', 'button');
        path.setAttribute('tabindex', '0');
        path.addEventListener('pointerdown', (e) => e.stopPropagation());
        path.addEventListener('click', (e) => { e.stopPropagation(); remove(); });
        path.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); remove(); }
        });
      }
      const hint = document.createElementNS(SVGNS, 'title'); hint.textContent = title; path.append(hint);
      let layer = this.svg;
      let origin = this.world;
      if (internal) {
        const card = to.closest<HTMLElement>('.module');
        if (card && from.closest('.module') === card) {
          origin = card;
          layer = cardLayer(card, 'internal-cables');
        }
      }
      layer.prepend(path);
      this.cablePaths.push({ path, from, to, origin, cable });
      // hovering any part of a cable highlights all of it: the path and its copies on a card and over the dock
      const group: SVGPathElement[] = [path];
      const hover = (on: boolean): void => group.forEach((g) => g.classList.toggle('hover', on));
      path.addEventListener('pointerenter', () => hover(true));
      path.addEventListener('pointerleave', () => hover(false));
      const over = this.dockCables;
      if (over && origin === this.world && (this.inDock(from) || this.inDock(to))) {
        const copy = document.createElementNS(SVGNS, 'path');
        copy.setAttribute('class', path.getAttribute('class')!);
        const clip = document.createElementNS(SVGNS, 'clipPath');
        clip.id = `dock-clip-${this.overPaths.size}`;
        const clips = [from, to].filter((j) => this.inDock(j)).map((jack) => {
          const rect = document.createElementNS(SVGNS, 'rect');
          clip.append(rect);
          return { rect, jack };
        });
        copy.setAttribute('clip-path', `url(#${clip.id})`);
        over.append(clip, copy);
        this.overPaths.set(path, { copy, clips });
        group.push(copy);
      }
      // a cable into a card's interior (to a thumb, a picker's or a switch's jack) runs under the card like every cable;
      // a copy on the card, clipped to it, draws the stretch over the card up to the jack
      const card = !internal && origin === this.world ? to.closest<HTMLElement>('.module') : null;
      if (card && to.classList.contains('slider-port')) {
        const copy = document.createElementNS(SVGNS, 'path');
        copy.setAttribute('class', path.getAttribute('class')!);
        cardLayer(card, 'entry-cables').append(copy);
        this.cablePaths.push({ path: copy, from, to, origin: card, cable });
        group.push(copy);
        if (remove) {
          const hit = document.createElementNS(SVGNS, 'path');
          hit.setAttribute('class', 'cable-hit');
          hit.addEventListener('pointerdown', (e) => e.stopPropagation());
          hit.addEventListener('click', (e) => { e.stopPropagation(); remove(); });
          hit.addEventListener('pointerenter', () => hover(true));
          hit.addEventListener('pointerleave', () => hover(false));
          const t = document.createElementNS(SVGNS, 'title'); t.textContent = title; hit.append(t);
          cardLayer(card, 'entry-cables', true).append(hit);
          this.cablePaths.push({ path: hit, from, to, origin: card });
        }
      }
      if (internal && remove) {
        // a thin route is hard to hit: an invisible path 1.5x as wide takes the clicks, above the card's controls but
        // under its thumbs
        const hit = document.createElementNS(SVGNS, 'path');
        hit.setAttribute('class', 'cable-hit');
        hit.addEventListener('pointerdown', (e) => e.stopPropagation());
        hit.addEventListener('click', (e) => { e.stopPropagation(); remove(); });
        hit.addEventListener('pointerenter', () => hover(true));
        hit.addEventListener('pointerleave', () => hover(false));
        (origin === this.world ? layer : cardLayer(origin, 'internal-cables', true)).append(hit);
        this.cablePaths.push({ path: hit, from, to, origin });
      }
    };
    // Show the assignment even without an upstream cable, so it can be edited before patching a source. A dedicated
    // input's link (ParamDef.input) is built into the module: drawn grey, not editable.
    for (const { m, pd, jack } of this.sliderPorts) for (const port of parameterInputs(m, pd)) {
      const side = this.inputJack({ module: m.id, port });
      if (!side || (this.inDock(side) && this.inDock(jack))) continue; // the dock draws no routes inside itself
      if (port === pd.input) add(side, jack, 'control', null, `Built in: ${port} sets ${pd.name}`, true);
      else add(side, jack, 'control', () => this.change(() => {
        setInputRoute(m, DEFS[m.type], port, pd.name, false);
      }), `Disconnect ${DEFS[m.type].label} ${port} → ${pd.name}`, true);
    }
    const physicalCables = new Set<string>();
    for (const c of this.patch.cables) {
      const a = this.ports.get(this.key(c.from.module, c.from.port, 'out'));
      const b = this.inputJack(c.to);
      const thumbs = this.sliderPorts.filter(({ m, pd }) => m.id === c.to.module && parameterInputs(m, pd).includes(c.to.port));
      a?.classList.add('connected'); b?.classList.add('connected');
      for (const { jack } of thumbs) jack.classList.add('connected');
      if (!a) continue;
      const src = this.patch.modules.find((m) => m.id === c.from.module)!;
      // drawn by the role of the input it lands on (cable-role.ts), not the kind of the output
      const role = cableRole(DEFS[this.patch.modules.find((x) => x.id === c.to.module)!.type], c.to.port);
      const kind = `${role === 'signal' ? 'audio' : role === 'mod' ? 'control' : role} role-${role}`;
      void src;
      if (b) {
        const key = `${c.from.module}:${c.from.port}:${b.dataset.mod}:${b.dataset.port}`;
        if (!physicalCables.has(key)) add(a, b, kind, () => this.removeCable(c), 'Disconnect cable', false, c);
        physicalCables.add(key);
      } else
        // a pin has no jack: its cable is drawn to every thumb it feeds, and each drawn cable removes just that route
        for (const { jack, pd } of thumbs) add(a, jack, kind, () => this.change(() => removeRoute(this.patch, c, pd.name)), `Disconnect from ${longName(this.patch.modules.find((x) => x.id === c.to.module)!.type, pd.name)}`, false, c);
    }
    this.positionCables();
  }

  /** set a parameter from outside the cards (the deck's knobs): as a slider would, the card follows on its next refresh */
  setParam(id: number, name: string, v: number): void {
    const m = this.patch.modules.find((x) => x.id === id);
    if (!m || m.params[name] === v) return;
    this.touch();
    m.params[name] = v;
    this.ev.onParam(id, name, v);
    this.syncDials();
    for (const d of this.parameterDisplays) if (d.id === id) d.update(null);
    this.relock(id);
  }

  /** remove a cable; one drawn to a merged jack whose other inputs are hidden takes their cables (from the same output) with it */
  private removeCable(c: Cable): void {
    const hidden = hiddenModules(this.patch);
    const more: Endpoint[] = [];
    for (const a of assembliesOf(this.patch)) {
      const ref = findRef(a, 'in', c.to.module, c.to.port);
      if (!ref?.also?.length) continue;
      for (const t of targetsOf(ref)) if (hidden.has(t.module) && !sameEnd(t, c.to) && !more.some((x) => sameEnd(x, t))) more.push(t);
    }
    this.change(() => {
      disconnect(this.patch, c);
      for (const t of more) disconnect(this.patch, { from: c.from, to: t });
    });
  }

  private internalPair(a: HTMLElement, b: HTMLElement): [HTMLElement, HTMLElement] | null {
    if (a.dataset.dir !== 'in' || b.dataset.dir !== 'in' || !!a.dataset.param === !!b.dataset.param) return null;
    return a.dataset.param ? [b, a] : [a, b]; // side jack, parameter thumb
  }

  private connectJacks(a: HTMLElement, b: HTMLElement): void {
    const internal = this.internalPair(a, b);
    if (internal) {
      const [side, thumb] = internal;
      this.change(() => {
        const m = this.patch.modules.find((m) => m.id === Number(thumb.dataset.mod))!;
        const pd = DEFS[m.type].params.find((pd) => pd.name === thumb.dataset.param)!;
        const targets: Target[] = [{ module: Number(side.dataset.mod), port: side.dataset.port! },
          ...(side.dataset.also ? JSON.parse(side.dataset.also) as Target[] : [])];
        const target = targets.find((t) => t.module === m.id);
        if (!target) throw new Error('Use a side input belonging to this parameter’s module.');
        setInputRoute(m, DEFS[m.type], target.port, pd.name, true);
      });
      return;
    }
    if (a.dataset.dir === b.dataset.dir) return this.ev.onError('connect an output to an input');
    const [out, input] = a.dataset.dir === 'out' ? [a, b] : [b, a];
    const from = { module: Number(out.dataset.mod), port: out.dataset.port! };
    this.change(() => {
      let to: Endpoint;
      if (input.dataset.param) {
        to = connectParameter(this.patch, DEFS, from, Number(input.dataset.mod), input.dataset.param);
      } else {
        to = { module: Number(input.dataset.mod), port: input.dataset.port! };
        if (!this.patch.cables.some((c) => sameEnd(c.from, from) && sameEnd(c.to, to)) && !connect(this.patch, DEFS, from, to))
          throw new Error('cannot connect these ports');
      }
      // A thumb alias of a merged assembly jack feeds the same group of inputs.
      const physical = this.inputJack(to);
      const also = input.dataset.also ?? physical?.dataset.also;
      if (also) {
        if (physical) connect(this.patch, DEFS, from, { module: Number(physical.dataset.mod), port: physical.dataset.port! });
        for (const target of JSON.parse(also) as Target[]) connect(this.patch, DEFS, from, target);
      }
    });
  }

  private beginDrag(e: PointerEvent, start: HTMLElement): void {
    e.preventDefault();
    e.stopPropagation();
    const armed = this.armed;
    this.cancelArm();
    if (armed && (armed.dataset.dir !== start.dataset.dir || this.internalPair(armed, start))) {
      this.connectJacks(armed, start);
      return;
    }
    const kind = start.dataset.dir;
    const { path, move, stop } = this.ghostCable(start);
    this.setPatching(true);
    const cancel = (): void => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      stop();
      this.drag = null;
      this.setPatching(false);
    };
    const up = (ev: PointerEvent): void => {
      const t = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const dot = t?.closest('.dot') as HTMLElement | null;
      cancel();
      // an output dropped on the sidebar's cable slack bar sways the cables
      // an output dropped on a sidebar slider whose thumb is a jack (cable slack, zoom) patches it
      const side = kind === 'out' ? (t?.closest('[data-side]') as HTMLElement | null)?.dataset.side as SideKey | undefined : undefined;
      if (side) return this.setSideSource(side, { module: Number(start.dataset.mod), port: start.dataset.port! });
      if (dot === start) {
        this.armed = start;
        start.classList.add('armed');
        this.setPatching(true);
        // click-to-connect: a ghost cable follows the pointer, as while dragging, until the second click or Esc
        const ghost = this.ghostCable(start);
        ghost.move(ev);
        this.armGhost = ghost.stop;
      } else if (dot?.dataset.mod) this.connectJacks(start, dot);
    };
    this.drag = { path, cancel };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    move(e);
  }

  /**
   * A cable from a jack to the pointer, following it until `stop`. It is drawn in the layer over the whole window (not the
   * canvas's), so it shows over the sidebar on its way to a sidebar slider's thumb.
   */
  private ghostCable(start: HTMLElement): { path: SVGPathElement; move: (ev: PointerEvent) => void; stop: () => void } {
    const kind = start.dataset.dir;
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('class', 'cable pending');
    this.sideOverlay().append(path);
    let last: PointerEvent | null = null;
    const move = (ev: PointerEvent): void => {
      last = ev;
      const c = this.world.getBoundingClientRect();
      const p = { x: (ev.clientX - c.left) / this.zoom, y: (ev.clientY - c.top) / this.zoom };
      const s = this.center(start);
      const end = this.endOf(start);
      path.setAttribute('d', kind === 'out' ? this.curve(s, p, end) : this.curve(p, s, 'side', end));
      path.setAttribute('transform', `translate(${c.left} ${c.top}) scale(${this.zoom})`);
    };
    // the canvas scrolling or zooming moves the jack under a still pointer
    const again = (): void => { if (last) move(last); };
    window.addEventListener('pointermove', move);
    this.canvas.addEventListener('scroll', again);
    return {
      path, move,
      stop: () => {
        window.removeEventListener('pointermove', move);
        this.canvas.removeEventListener('scroll', again);
        path.remove();
      },
    };
  }
}
