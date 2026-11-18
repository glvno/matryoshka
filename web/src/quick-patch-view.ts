// SPDX-License-Identifier: GPL-3.0-only
// Quick patch (#1091) on screen: one field at the pointer for module names, port names and typed chains, the current card's
// ports in a ring round it (outputs on the right arc, inputs on the left), a strip of sliders for the parameter a cable
// just reached, and the trail of cards followed along cables. quick-patch.ts holds the rules; the editor makes the changes,
// each chain one undo step (Editor.beginStep), and moves the view to keep the chain in sight (Editor.showRects).
import type { Editor } from './editor';
import { DEFS } from './modules';
import { depthText, parseDepth, storedDepth } from './depth';
import { formatValue, longName, moduleTag } from './labels';
import { DEPTH_MAX, fromUnit, toUnit, type ParamDef, type Patch } from './patch';
import { isPin, parameterInputs } from './parameter-routing';
import {
  besideSpot, buildChain, cardExists, cardPorts, cardTitle, ChainError, chainText, farEnds, fit, guessSize, halfRings, halfSectors, isChainText,
  matchPorts, moveCard, parseChain, portCables, radialPlace, rankPorts, removeBlueprint, RINGS_MAX, sameCard, saveBlueprint, search, sectorPath, Trail, wire,
  type Built, type Card, type Catalog, type FarEnd, type Hit, type Link, type Place, type QPort, type Statement,
} from './quick-patch';
import { parseValue } from './value-input';
import type { AssemblyDef, Rect } from './assembly';

export interface QuickHost {
  editor: Editor;
  /** the status line */
  say: (text: string) => void;
  /** what a search offers besides the patch's cards: modules, assemblies, blueprints */
  catalog: () => Catalog;
  /** the saved blueprints changed (the palette lists them) */
  onBlueprints?: () => void;
}

/** one line of the list under the field: what Enter (or a click) does; `io`: the direction icon of the port it names */
interface Choice { label: string; detail?: string; port?: QPort; io?: { dir: 'in' | 'out'; kind: string }; follow?: boolean; run: (shift: boolean) => void }

/** the parameter a cable just reached: the strip's sliders (its value, and the depth of the pin that carries it) */
interface Sliders { card: Card; module: number; params: string[]; pin?: 0 | 1 }

/** the radial menu's sizes (px): the centre disc's radius, then each ring's width */
const RADIAL_CORE = 78;
/** the room beside the rings for each half's direction icon */
const RADIAL_ICON = 24;
const RADIAL_BAND = 58;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const SVGNS = 'http://www.w3.org/2000/svg';
/** a port's direction as an icon, never a word (owner on PR #1094: the words would read as the ports named `in` and
 *  `out`): a jack with an arrow into it for one that takes a cable, out of it for one that sends, in its signal's colour;
 *  screen readers get "input" / "output" */
const ioIcon = (dir: 'in' | 'out', kind: string): SVGSVGElement => {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', `qp-io ${dir} ${kind}`);
  svg.setAttribute('viewBox', '0 0 18 10');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', dir === 'in' ? 'input' : 'output');
  const title = document.createElementNS(SVGNS, 'title');
  title.textContent = dir === 'in' ? 'input' : 'output';
  const jack = document.createElementNS(SVGNS, 'circle');
  jack.setAttribute('cx', dir === 'in' ? '13' : '5');
  jack.setAttribute('cy', '5');
  jack.setAttribute('r', '3.2');
  const arrow = document.createElementNS(SVGNS, 'path');
  arrow.setAttribute('d', dir === 'in' ? 'M0 5H8M5.5 2.5L8 5L5.5 7.5' : 'M10 5H18M15.5 2.5L18 5L15.5 7.5');
  svg.append(title, jack, arrow);
  return svg;
};

export class QuickPatch {
  private readonly panel = el('div', 'qp-panel');
  private readonly crumbs = el('div', 'qp-trail');
  private readonly field = el('input', 'qp-field');
  private readonly hint = el('div', 'qp-hint');
  private readonly list = el('ul', 'qp-list');
  private readonly last = el('div', 'qp-last');
  /** the radial overlay: its rings (an SVG) and the centre disc with the card's name and the field */
  private readonly ring = el('div', 'qp-radial');
  private readonly core = el('div', 'qp-core');
  /** the rings' SVG goes in here, and the card's name over the field: re-drawn without moving the field (which keeps its
   *  focus) */
  private readonly svgBox = el('div', 'qp-svgbox');
  private readonly coreName = el('div', 'qp-core-name');
  private readonly strip = el('div', 'qp-sliders');
  private isOpen = false;
  /** the card whose ports the ring shows */
  private at: Card | null = null;
  /** the cable end picked up and not yet dropped */
  private held: { card: Card; port: QPort } | null = null;
  private readonly trail = new Trail();
  private page = 0;
  private sel = 0;
  private choices: Choice[] = [];
  /** a port with several cables: the far ends to choose from */
  private far: { port: QPort; ends: FarEnd[] } | null = null;
  private sliders: Sliders | null = null;
  private error = '';
  /** the chain being built: its undo step's end, its cables and the cards it made */
  private endStep: (() => void) | null = null;
  private links: Link[] = [];
  private fresh: Card[] = [];
  /** the last finished chain as a line that builds it again (a blueprint's text) */
  lastChain = '';
  /** the cards made while it was open: when it closes, the view brings them in if one is off screen */
  private made: Card[] = [];

  constructor(private readonly host: QuickHost) {
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', 'Quick patch');
    this.field.type = 'text';
    this.field.spellcheck = false;
    this.field.autocomplete = 'off';
    this.field.setAttribute('role', 'combobox');
    this.field.setAttribute('aria-controls', 'qp-list');
    this.field.setAttribute('aria-expanded', 'true');
    this.field.setAttribute('aria-label', 'Quick patch: a module, a port, or a chain such as lfo.out > vca.cv');
    this.list.id = 'qp-list';
    this.list.setAttribute('role', 'listbox');
    this.hint.setAttribute('aria-live', 'polite');
    const keys = el('div', 'qp-keys');
    keys.innerHTML = '<kbd>⏎</kbd> pick <kbd>⇧⏎</kbd> follow a cable <kbd>[</kbd><kbd>]</kbd> back, forward <kbd>Esc</kbd> done · <code>lfo.pulse &gt; vca.cv</code> a chain · <code>bp name</code> a blueprint';
    this.panel.append(this.crumbs, this.hint, this.strip, this.list, this.last, keys);
    this.svgBox.setAttribute('aria-hidden', 'true');   // (the list says the same to a screen reader)
    this.core.append(this.coreName, this.field);
    this.ring.append(this.svgBox, this.core);
    this.field.addEventListener('input', () => { this.page = 0; this.sel = 0; this.error = ''; this.render(); });
    this.field.addEventListener('keydown', (e) => this.key(e));
    // the panel, ring and strip keep the field's focus: a press on a chip or a list line acts without taking it
    for (const part of [this.panel, this.ring]) part.addEventListener('mousedown', (e) => { if (e.target !== this.field) e.preventDefault(); });
    this.strip.addEventListener('pointerup', () => requestAnimationFrame(() => this.field.focus()));
    window.addEventListener('resize', () => { if (this.isOpen) this.position(); });
    window.addEventListener('pointerdown', (e) => {
      if (!this.isOpen || e.button !== 0 || !(e.target instanceof Node)) return;
      if (this.panel.contains(e.target) || this.ring.contains(e.target) || this.strip.contains(e.target)) return;
      this.close();
    }, true);
  }

  get open(): boolean { return this.isOpen; }

  private get ed(): Editor { return this.host.editor; }
  private get patch(): Patch { return this.ed.patch; }

  /** open at the pointer, on the selected card when exactly one is selected (Tab, the palette) */
  show(card: Card | null = null): void {
    const ed = this.ed;
    const selected: Card | null = card
      ?? (ed.selected.size === 1 && !ed.selectedAsm.size ? { kind: 'module', id: [...ed.selected][0] }
        : ed.selectedAsm.size === 1 && !ed.selected.size ? { kind: 'assembly', id: [...ed.selectedAsm][0] } : null);
    if (!this.isOpen) {
      // the overlay sits in the middle of the canvas's visible area (position), whatever the pointer or the selection
      document.body.append(this.ring, this.panel);
      this.isOpen = true;
      this.trail.clear();
      this.made = [];
      this.at = null;
      this.held = null;
      this.far = null;
      this.sliders = null;
      this.field.value = '';
    }
    if (selected) this.goTo(selected, false);
    this.render();
    this.field.focus();
  }

  /** end the chain (one undo step) and close; the view then brings in a new card that is off screen */
  close(): void {
    if (!this.isOpen) return;
    this.finishChain();
    this.isOpen = false;
    this.panel.remove();
    this.ring.remove();
    this.field.blur();
    this.settle();
  }

  /** C: a copy of the card under the pointer beside it, and its ring; false when the pointer is over no card */
  copyHovered(): boolean {
    const ed = this.ed;
    const card = ed.cardUnderPointer();
    if (!card) return false;
    this.finishChain();
    const r = ed.cardRect(card);
    const at = r ? besideSpot(r, 'right', r, ed.takenRects()) : ed.freeSpot(300);
    const copy = ed.copyCard(card, at);
    if (!copy) return true;
    this.host.say(`Copied ${cardTitle(this.patch, DEFS, card)}: pick a port, or type where it goes`);
    this.show(copy);
    this.made.push(copy);
    return true;
  }

  /** stamp a saved blueprint (the palette's entries) */
  stamp(name: string): void {
    this.build([{ kind: 'blueprint', name }], `bp ${name}`);
  }

  /** keep the chain being built, else the last one, as a blueprint; false when there is none */
  keepAs(name: string): boolean {
    const chain = this.links.length ? chainText(this.patch, DEFS, this.links, this.fresh) : this.lastChain;
    try {
      saveBlueprint(name, chain);
    } catch (e) {
      this.host.say(String((e as Error).message));
      return false;
    }
    this.host.say(`Blueprint "${name.trim()}" kept: ${chain}. Type bp ${name.trim()} in Quick patch to stamp it.`);
    this.host.onBlueprints?.();
    return true;
  }

  /** whether there is a chain to keep */
  get hasChain(): boolean { return !!this.links.length || !!this.lastChain; }

  // ---- the chain

  private startChange(): void {
    this.endStep ??= this.ed.beginStep();
  }

  /** the chain ends: its changes become one undo step, and its line is kept for `bp save` */
  private finishChain(): void {
    if (this.links.length) this.lastChain = chainText(this.patch, DEFS, this.links, this.fresh);
    this.endStep?.();
    this.endStep = null;
    this.links = [];
    this.fresh = [];
  }

  private goTo(card: Card, push = true): void {
    this.at = card;
    if (push) this.trail.push(card);
    else if (!sameCard(this.trail.current, card)) this.trail.push(card);
    this.page = 0;
    this.sel = 0;
    this.far = null;
    this.field.value = '';
  }

  /** a new module or assembly: beside the held cable's card (after it for an output, before it for an input), else
   *  beside the current card, else near the pointer */
  private make(what: { type: string } | { def: AssemblyDef }): void {
    const ed = this.ed;
    this.startChange();
    const size = guessSize(DEFS, what);
    const anchor = this.held?.card ?? this.at;
    const r = anchor && ed.cardRect(anchor);
    const side = this.held && this.held.port.dir === 'in' ? 'left' : 'right';
    const at = r ? besideSpot(r, side, size, ed.takenRects()) : ed.freeSpot(size.w);
    const card = ed.placeCard(what, at);
    if (!card) return;
    this.fresh.push(card);
    this.made.push(card);
    this.goTo(card);
  }

  /** pick a port: without a cable, pick one up there; with one, drop it here and stay on this card */
  private pick(port: QPort): void {
    const at = this.at;
    if (!at) return;
    if (!this.held) {
      this.held = { card: at, port };
      this.field.value = '';
      this.sel = 0;
      this.sliders = null;
      this.render();
      return;
    }
    const held = this.held;
    if (sameCard(held.card, at)) return this.fail('a cable goes to another card: type its name');
    if (fit(held.port, port) < 0) return this.fail(`${port.name} does not take this cable`);
    this.startChange();
    const ed = this.ed;
    const [from, to] = held.port.dir === 'out' ? [{ card: held.card, port: held.port }, { card: at, port }] : [{ card: at, port }, { card: held.card, port: held.port }];
    if (!ed.transact(() => wire(ed.patch, DEFS, from.port, to.port))) return;
    this.links.push({ from: from.card, fromPort: from.port.name, to: to.card, toPort: to.port.name });
    this.held = null;
    this.relay(from.card, to.card);
    this.sliders = this.slidersFor(to.card, to.port, from.port);
    this.field.value = '';
    this.sel = 0;
    this.page = 0;
    this.render();
  }

  /** a chain that ends on a card left of the new cards that feed it: those cards move to before it, by signal flow */
  private relay(src: Card, dest: Card): void {
    const ed = this.ed;
    const run: Card[] = [];
    for (let c: Card | null = src; c && this.fresh.some((f) => sameCard(f, c)) && !run.some((r) => sameCard(r, c)); c = this.links.find((l) => sameCard(l.to, c))?.from ?? null) run.push(c);
    const d = ed.cardRect(dest), s = ed.cardRect(src);
    if (!run.length || !d || !s || this.fresh.some((f) => sameCard(f, dest)) || d.x >= s.x + s.w) return;
    const own = new Set(run.map((c) => JSON.stringify(ed.cardRect(c))));
    const taken = ed.takenRects().filter((r) => !own.has(JSON.stringify(r)));
    let anchor: Rect = d;
    const moves: [Card, { x: number; y: number }][] = [];
    for (const c of run) {
      const r = ed.cardRect(c)!;
      const at = besideSpot(anchor, 'left', r, taken);
      moves.push([c, at]);
      anchor = { ...at, w: r.w, h: r.h };
      taken.push(anchor);
    }
    ed.transact(() => { for (const [c, at] of moves) moveCard(ed.patch, c, at.x, at.y); });
  }

  /** the sliders a cable into `port` offers: a jack's own parameter (and its amount), or a thumb's parameter and the depth
   *  of the pin that carries the cable */
  private slidersFor(card: Card, port: QPort, from: QPort): Sliders | null {
    if (port.param) {
      const m = this.patch.modules.find((x) => x.id === port.param!.module);
      const pd = m && DEFS[m.type].params.find((q) => q.name === port.param!.param);
      if (!m || !pd) return null;
      const pin = parameterInputs(m, pd).find((p) => isPin(p) && this.patch.cables.some((c) => c.to.module === m.id && c.to.port === p && from.ends.some((e) => e.module === c.from.module && e.port === c.from.port)));
      return { card, module: m.id, params: [pd.name], ...(pin && m.att ? { pin: pin === 'p1' ? 0 as const : 1 as const } : {}) };
    }
    if (!port.drives?.length) return null;
    return { card, module: port.ends[0].module, params: port.drives };
  }

  /**
   * Shift+Enter: follow the selected port's cable when it has one and was chosen (moved to or typed); else go on along the
   * trail: the first port in the list with a cable that does not lead back to the card before this one (Output, ⇧⏎ to the
   * VCA, ⇧⏎ to the Multimode), else the first with a cable.
   */
  private followOn(): void {
    const at = this.at!;
    const chosen = this.choices[this.sel];
    if (chosen?.follow && chosen.port && (this.sel > 0 || this.field.value.trim())) return this.follow(chosen.port);
    const before = this.trail.items[this.trail.at - 1];
    const cabled = this.choices.filter((c) => c.follow && c.port);
    const onward = cabled.find((c) => !farEnds(this.patch, DEFS, at, c.port!).every((e) => sameCard(e.card, before)));
    const pick = onward ?? cabled[0];
    if (!pick?.port) return this.fail(`no cable at ${cardTitle(this.patch, DEFS, at)} to follow`);
    this.follow(pick.port);
  }

  /** a port with cables: ride to its far end, or choose among several */
  private follow(port: QPort): void {
    if (!this.at) return;
    const ends = farEnds(this.patch, DEFS, this.at, port);
    if (!ends.length) return this.fail(`no cable at ${port.name} to follow`);
    if (ends.length === 1) return this.travel(ends[0].card);
    this.far = { port, ends };
    this.sel = 0;
    this.render();
  }

  private travel(card: Card): void {
    this.finishChain();
    this.goTo(card);
    this.sliders = null;
    this.render();
  }

  /** back (-1) or forward (1) along the trail; the cable held, if any, comes along */
  private step(dir: -1 | 1): void {
    this.jump(this.trail.at + dir);
  }

  /** go to the trail's card at index `i`: a chain being built ends there */
  private jump(i: number): void {
    if (i === this.trail.at || !this.trail.go(i)) return;
    this.finishChain();
    this.at = this.trail.current;
    this.far = null;
    this.sliders = null;
    this.field.value = '';
    this.sel = 0;
    this.render();
  }

  /** build typed chains (or a stamped blueprint) as one undo step of their own */
  private build(statements: Statement[], text: string): void {
    const ed = this.ed;
    const cat = this.host.catalog();
    this.finishChain();
    try {
      buildChain(structuredClone(ed.patch), DEFS, statements, cat, () => ({ x: 0, y: 0 }), () => null);
    } catch (e) {
      return this.fail(e instanceof ChainError || e instanceof Error ? e.message : String(e));
    }
    const taken = ed.takenRects();
    let last: Rect | null = null;
    const place: Place = (size, anchor, side) => {
      const at = anchor ? besideSpot(anchor, side, size, taken) : last ? besideSpot(last, 'right', size, taken) : ed.freeSpot(size.w);
      last = { ...at, ...size };
      taken.push(last);
      return at;
    };
    let built: Built | null = null;
    if (!ed.transact(() => { built = buildChain(ed.patch, DEFS, statements, cat, place, (c) => ed.cardRect(c)); })) return;
    const b = built as Built | null;
    if (!b) return;
    this.lastChain = chainText(this.patch, DEFS, b.links, b.fresh) || text;
    this.host.say(`Built ${b.fresh.length} new card${b.fresh.length === 1 ? '' : 's'} and ${b.cables} cable${b.cables === 1 ? '' : 's'}: ${this.lastChain}`);
    const end = b.links.at(-1)?.to ?? b.cards.at(-1);
    this.held = null;
    this.sliders = null;
    if (end) this.goTo(end);
    this.made.push(...b.fresh);
    this.render();
  }

  private fail(text: string): void {
    this.error = text;
    this.render();
  }

  // ---- keys

  private key(e: KeyboardEvent): void {
    const text = this.field.value;
    const move = (d: number): void => {
      if (!this.choices.length) return;
      this.sel = (this.sel + d + this.choices.length) % this.choices.length;
      this.render();
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      if (this.far) { this.far = null; this.render(); } else this.close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey && !this.held && this.at && !this.far) this.followOn();
      else this.choices[this.sel]?.run(false);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (e.altKey) return;
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      move(e.shiftKey ? -1 : 1);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      this.page += e.key === 'PageDown' ? 1 : -1;
      this.render();
    } else if ((e.key === '[' || e.key === ']') && !text) {
      e.preventDefault();
      this.step(e.key === '[' ? -1 : 1);
    } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      this.step(e.key === 'ArrowLeft' ? -1 : 1);
    } else if (e.key === 'Backspace' && !text && this.held) {
      e.preventDefault();
      this.held = null;
      this.render();
    }
  }

  // ---- what the list offers

  private cabled = (card: Card) => (q: QPort): boolean => portCables(this.patch, DEFS, card, q).length > 0;

  /** the ports of the current card in the order Enter offers them: the default first */
  private rankedPorts(): QPort[] {
    if (!this.at) return [];
    if (this.held && sameCard(this.held.card, this.at)) return [];
    return rankPorts(cardPorts(this.patch, DEFS, this.at), this.held?.port ?? null, this.cabled(this.at));
  }

  private compute(): Choice[] {
    const t = this.field.value.trim();
    if (this.far) {
      // (the far end's port faces the other way from the one followed)
      const io = { dir: this.far.port.dir === 'out' ? 'in' as const : 'out' as const, kind: this.far.port.param ? 'control' : this.far.port.kind };
      return this.far.ends.map((end) => ({ label: `⤳ ${end.title}`, detail: longName(this.typeOf(end.card), end.port), io, run: () => this.travel(end.card) }));
    }
    const bp = /^bp(?:\s+(.*))?$/i.exec(t);
    if (bp && !/[>;]/.test(t)) return this.blueprintChoices(bp[1]?.trim() ?? '');
    if (isChainText(t)) {
      const parsed = parseChain(t);
      if ('error' in parsed) return (this.error ||= parsed.error), [];
      const n = parsed.statements.length;
      return [{ label: 'Build this chain', detail: `${n} statement${n === 1 ? '' : 's'}, one undo step`, run: () => this.build(parsed.statements, t) }];
    }
    const set = this.sliders && this.valueChoice(t);
    if (set) return [set];
    const ports = this.rankedPorts();
    const shown = t ? matchPorts(ports, t) : ports;
    const out: Choice[] = shown.map((q) => this.portChoice(q));
    if (t) for (const hit of search(this.patch, DEFS, this.host.catalog(), t)) out.push(this.hitChoice(hit));
    return out;
  }

  private typeOf(card: Card): string {
    return card.kind === 'module' ? this.patch.modules.find((m) => m.id === card.id)?.type ?? '' : '';
  }

  private portChoice(q: QPort): Choice {
    const at = this.at!;
    const ends = !this.held ? farEnds(this.patch, DEFS, at, q) : [];
    const follow = ends.length ? ` · ⤳ ${ends.length === 1 ? ends[0].title : `${ends.length} cables`} (⇧⏎)` : '';
    return {
      label: q.name,
      detail: `${q.label !== q.name ? `${q.label} · ` : ''}${q.param ? 'parameter' : q.kind}${follow}`,
      port: q,
      io: { dir: q.dir, kind: q.param ? 'control' : q.kind },
      follow: ends.length > 0,
      run: (shift) => (shift && ends.length ? this.follow(q) : this.pick(q)),
    };
  }

  private hitChoice(hit: Hit): Choice {
    const run = (): void => {
      if (hit.kind === 'card') {
        this.goTo(hit.card);
        this.render();
      } else if (hit.kind === 'module') this.make({ type: hit.type });
      else if (hit.kind === 'assembly') this.make({ def: hit.def });
      else this.build([{ kind: 'blueprint', name: hit.blueprint.name }], `bp ${hit.blueprint.name}`);
      this.render();
    };
    return { label: hit.label, detail: hit.detail, run };
  }

  private blueprintChoices(rest: string): Choice[] {
    const save = /^save\s+(.+)$/i.exec(rest);
    if (save) {
      const name = save[1].trim();
      return this.hasChain ? [{ label: `Keep the ${this.links.length ? 'chain being built' : 'last chain'} as "${name}"`, detail: this.links.length ? chainText(this.patch, DEFS, this.links, this.fresh) : this.lastChain, run: () => { if (this.keepAs(name)) (this.field.value = '', this.render()); } }]
        : ((this.error = 'build a chain first, then bp save <name> keeps it'), []);
    }
    const del = /^del(?:ete)?\s+(.+)$/i.exec(rest);
    if (del) {
      const name = del[1].trim();
      return [{ label: `Delete blueprint "${name}"`, run: () => {
        if (removeBlueprint(name)) (this.host.say(`Blueprint "${name}" deleted`), this.host.onBlueprints?.(), (this.field.value = ''), this.render());
        else this.fail(`no blueprint "${name}"`);
      } }];
    }
    const list = this.host.catalog().blueprints.filter((b) => !rest || b.name.toLowerCase().includes(rest.toLowerCase()));
    if (!list.length) this.error = rest ? `no blueprint "${rest}"` : 'no blueprints yet: build a chain, then bp save <name>';
    return list.map((b) => ({ label: `bp ${b.name}`, detail: b.chain, run: () => this.build([{ kind: 'blueprint', name: b.name }], `bp ${b.name}`) }));
  }

  /** a typed value for the strip's sliders: `800hz` sets the first, `cvamt=2` or `depth=50%` a named one */
  private valueChoice(t: string): Choice | null {
    const s = this.sliders!;
    const m = this.patch.modules.find((x) => x.id === s.module);
    if (!m || !t) return null;
    const named = /^([a-z][\w ]*?)\s*=\s*(.+)$/i.exec(t);
    if (!named && !/^[-+.\d]/.test(t)) return null;
    const name = named ? named[1].trim().toLowerCase() : s.params[0];
    const text = named ? named[2] : t;
    const first = DEFS[m.type].params.find((q) => q.name === s.params[0])!;
    if (name === 'depth' && s.pin !== undefined) {
      const att = parseDepth(text, first);
      return att === null ? null : { label: `Set the depth to ${depthText(first, att)}`, run: () => this.setDepth(att) };
    }
    const pd = DEFS[m.type].params.find((q) => q.name === name && s.params.includes(q.name));
    const v = pd ? parseValue(text, pd) : null;
    if (!pd || v === null) return null;
    const f = formatValue(v, pd.unit, pd.min < 0);
    return { label: `Set ${longName(m.type, pd.name)} to ${f.num}${f.unit ? ` ${f.unit}` : ''}`, run: () => this.setValue(pd, v) };
  }

  private setValue(pd: ParamDef, v: number): void {
    const s = this.sliders;
    if (!s) return;
    this.startChange();
    this.ed.setParam(s.module, pd.name, v);
    this.ed.endGesture();
    this.field.value = '';
    this.render();
  }

  private setDepth(att: number): void {
    const s = this.sliders;
    if (!s || s.pin === undefined) return;
    this.startChange();
    this.ed.setDepth(s.module, s.pin, att);
    this.ed.endGesture();
    this.field.value = '';
    this.render();
  }

  // ---- drawing

  private render(): void {
    if (!this.isOpen) return;
    if (this.at && !cardExists(this.patch, this.at)) this.at = null;
    if (this.held && !cardExists(this.patch, this.held.card)) this.held = null;
    this.trail.keep((c) => cardExists(this.patch, c));
    this.choices = this.compute();
    if (this.sel >= this.choices.length) this.sel = 0;
    this.renderTrail();
    this.renderList();
    this.renderRadial();
    this.renderStrip();
    this.position();
  }

  private renderTrail(): void {
    const p = this.patch;
    const back = el('button', 'qp-step', '‹');
    back.title = 'Back along the trail ([ or Alt+←)';
    back.disabled = !this.trail.canBack;
    back.onclick = () => this.step(-1);
    const fwd = el('button', 'qp-step', '›');
    fwd.title = 'Forward along the trail (] or Alt+→)';
    fwd.disabled = !this.trail.canForward;
    fwd.onclick = () => this.step(1);
    const crumbs = this.trail.items.slice(-5).map((c) => {
      const i = this.trail.items.indexOf(c);
      const b = el('button', `qp-crumb${i === this.trail.at ? ' on' : ''}`, cardTitle(p, DEFS, c));
      b.onclick = () => this.jump(i);
      return b;
    });
    this.crumbs.replaceChildren(back, fwd, ...crumbs);
    this.crumbs.hidden = !this.trail.items.length;
  }

  private renderList(): void {
    const p = this.patch;
    const t = this.field.value.trim();
    const held = this.held ? `${cardTitle(p, DEFS, this.held.card)} ${this.held.port.name}` : '';
    this.field.placeholder = this.far ? 'choose the cable to follow'
      : this.held ? `holding ${held}: type where it goes`
      : this.at ? `a port of ${cardTitle(p, DEFS, this.at)}, or another module`
      : 'a module, or a chain: lfo.out > vca.cv';
    const there = this.held && sameCard(this.held.card, this.at);
    this.hint.textContent = this.error || (this.held && !t ? `Holding ${held}. ${there ? 'Type the module it goes to' : '⏎ drops it on the lit port'}; Backspace lets it go.` : '');
    this.hint.classList.toggle('bad', !!this.error);
    this.list.replaceChildren(...this.choices.slice(0, 40).map((c, i) => {
      const li = el('li', i === this.sel ? 'sel' : '');
      li.id = `qp-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === this.sel));
      if (c.io) li.append(ioIcon(c.io.dir, c.io.kind));
      li.append(el('span', c.port ? 'qp-label qp-name' : 'qp-label', c.label));
      if (c.detail) li.append(el('span', 'qp-detail', c.detail));
      if (i === 0 && !t) li.append(el('kbd', '', '⏎'));
      li.onclick = (e) => c.run(e.shiftKey);
      return li;
    }));
    if (this.choices.length) this.field.setAttribute('aria-activedescendant', `qp-opt-${this.sel}`);
    else this.field.removeAttribute('aria-activedescendant');
    this.list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    this.last.hidden = !this.lastChain;
    this.last.replaceChildren(el('span', 'qp-muted', 'last chain '), el('code', '', this.lastChain), el('span', 'qp-muted', ' · bp save <name> keeps it'));
  }

  /** the radial menu's rings, inside out: each ring's left half holds jacks that take a cable, its right half jacks that
   *  send. The jacks fill the inner ring first and spill outwards; the row thumbs (parameters, which take a cable but are
   *  not jacks) start a ring of their own on the left. Past three rings the rings page (PageDown, or the "more…" button
   *  under the disc). A typed name filters every ring */
  private rings(): { left: QPort[]; right: QPort[] }[] {
    if (!this.at) return [];
    let ports = cardPorts(this.patch, DEFS, this.at);
    const t = this.field.value.trim();
    if (t && !isChainText(t)) {
      const hits = new Set(matchPorts(ports, t));
      ports = ports.filter((q) => hits.has(q));
    }
    const left = halfRings(ports.filter((q) => q.dir === 'in' && !q.param), ports.filter((q) => q.param));
    const right = halfRings(ports.filter((q) => q.dir === 'out'));
    const all = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => ({ left: left[i] ?? [], right: right[i] ?? [] }));
    this.pages = Math.max(1, Math.ceil(all.length / RINGS_MAX));
    this.page = ((this.page % this.pages) + this.pages) % this.pages;
    return all.slice(this.page * RINGS_MAX, (this.page + 1) * RINGS_MAX);
  }

  private pages = 1;

  /** the overlay: a translucent disc at the place Quick patch opened, the current card's name and the field in its centre,
   *  and rings of labelled sectors round it, the left half for the jacks that take a cable, the right for those that send.
   *  Plain segments, not jacks: a port's signal is a small dot, its direction the icon beside its half */
  private renderRadial(): void {
    const at = this.at;
    const rings = this.rings();
    const held = this.held && at && !sameCard(this.held.card, at) ? this.held.port : null;
    const fromHere = this.held && at && sameCard(this.held.card, at) ? this.held.port : null;
    // (the list's ports and the ring's are made apart: the same port by direction, name and thumb)
    const same = (a: QPort | null | undefined, b: QPort): boolean => !!a && a.dir === b.dir && a.name === b.name && !a.param === !b.param;
    const chosen = fromHere ?? this.choices[this.sel]?.port;
    const first = !this.field.value.trim() ? this.choices[0]?.port : undefined;
    // (room on each side for the halves' direction icons)
    const size = 2 * (RADIAL_CORE + RADIAL_BAND * Math.max(1, rings.length)) + 8 + 2 * RADIAL_ICON;
    const c = size / 2;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'qp-rings');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    const node = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>, text = ''): SVGElementTagNameMap[K] => {
      const e = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      if (text) e.textContent = text;
      return e;
    };
    svg.append(node('circle', { class: 'qp-disc', cx: String(c), cy: String(c), r: String(c - RADIAL_ICON - 2) }));
    const sector = (q: QPort, s: { a0: number; a1: number; mid: number }, r0: number, r1: number): void => {
      const g = node('g', { class: 'qp-sec' });
      const label = (r0 + r1) / 2;
      const tx = c + label * Math.cos(s.mid), ty = c + label * Math.sin(s.mid);
      g.append(node('path', { d: sectorPath(c, r0, r1, s.a0, s.a1) }));
      const f = held ? fit(held, q) : 0;
      const ends = !this.held ? farEnds(this.patch, DEFS, at!, q) : [];
      if (held) g.classList.add(f === 0 ? 'lit' : f > 0 ? 'dim' : 'off');
      if (fromHere && !same(fromHere, q)) g.classList.add('off');
      if (same(chosen, q)) g.classList.add('sel');
      // the label fits its sector: as many letters as the arc has room for, the whole name in the tooltip
      const room = Math.max(3, Math.floor(Math.min((s.a1 - s.a0) * label, r1 - r0 + 40) / 6.6));
      const text = q.name.length > room ? `${q.name.slice(0, room - 1)}…` : q.name;
      g.append(node('title', {}, `${q.label} (${q.param ? 'parameter' : q.kind})${ends.length ? `: ⤳ ${ends.map((e) => e.title).join(', ')}, Shift-click follows` : ''}`));
      g.append(node('circle', { class: `qp-kind ${q.param ? 'control' : q.kind}${ends.length || (this.held && this.cabled(at!)(q)) ? ' cabled' : ''}`, cx: String(tx), cy: String(ty - 9), r: '2.4' }));
      g.append(node('text', { class: 'qp-name', x: String(tx), y: String(ty + 5) }, `${ends.length ? '⤳' : ''}${text}${same(first, q) ? ' ⏎' : ''}`));
      g.addEventListener('click', (e) => {
        if (g.classList.contains('off')) return;
        if (e.shiftKey && ends.length) this.follow(q);
        else this.pick(q);
      });
      svg.append(g);
    };
    rings.forEach((ring, ri) => {
      const r0 = RADIAL_CORE + ri * RADIAL_BAND + 2, r1 = r0 + RADIAL_BAND - 4;
      halfSectors(ring.left.length, 'left').forEach((s, i) => sector(ring.left[i], s, r0, r1));
      halfSectors(ring.right.length, 'right').forEach((s, i) => sector(ring.right[i], s, r0, r1));
    });
    // the halves' direction icons, level with the centre outside the rings
    if (rings.length) {
      const place = (icon: SVGSVGElement, x: number): void => {
        for (const [k, v] of Object.entries({ x: String(x), y: String(c - 5), width: '18', height: '10' })) icon.setAttribute(k, v);
        svg.append(icon);
      };
      place(ioIcon('in', 'ring'), 2);
      place(ioIcon('out', 'ring'), size - 20);
    }
    if (this.pages > 1) {
      const more = node('g', { class: 'qp-sec more' });
      more.append(node('text', { x: String(c), y: String(size - 6) }, `more… ${this.page + 1}/${this.pages}`));
      more.addEventListener('click', () => { this.page++; this.render(); });
      svg.append(more);
    }
    // the centre: the card's tag and name over the field
    this.core.style.width = this.core.style.height = `${RADIAL_CORE * 2 - 8}px`;
    this.coreName.replaceChildren(at ? cardTitle(this.patch, DEFS, at) : 'Quick patch');
    if (at?.kind === 'module') {
      const m = this.patch.modules.find((x) => x.id === at.id);
      if (m) this.coreName.prepend(el('span', `mtag ${moduleTag(m.type).family}`, moduleTag(m.type).tag));
    }
    this.svgBox.replaceChildren(svg);
    this.ring.style.width = this.ring.style.height = `${size}px`;
  }

  private renderStrip(): void {
    const s = this.sliders;
    const m = s && this.patch.modules.find((x) => x.id === s.module);
    if (!s || !m) return void this.strip.replaceChildren();
    const row = (label: string, min: number, max: number, step: number, unit: number, text: string, set: (u: number) => void): HTMLElement => {
      const r = el('label', 'qp-slider');
      const range = el('input');
      range.type = 'range';
      range.min = String(min);
      range.max = String(max);
      range.step = String(step);
      range.value = String(unit);
      const out = el('span', 'qp-value', text);
      range.oninput = () => set(Number(range.value));
      r.append(el('span', 'qp-name', label), range, out);
      return r;
    };
    const rows = s.params.flatMap((name) => {
      const pd = DEFS[m.type].params.find((q) => q.name === name);
      if (!pd) return [];
      const f = formatValue(m.params[name], pd.unit, pd.min < 0);
      return [row(longName(m.type, name), 0, 1, 0.001, toUnit(pd, m.params[name]), `${f.num} ${f.unit}`.trim(), (u) => {
        this.startChange();
        this.ed.setParam(m.id, name, fromUnit(pd, u));
        this.renderStripValues();
      })];
    });
    if (s.pin !== undefined && m.att) {
      const pd = DEFS[m.type].params.find((q) => q.name === s.params[0])!;
      rows.push(row('depth', -DEPTH_MAX, DEPTH_MAX, 0.01, m.att[s.pin], depthText(pd, m.att[s.pin]), (v) => {
        this.startChange();
        this.ed.setDepth(m.id, s.pin!, storedDepth(v));
        this.renderStripValues();
      }));
    }
    const head = el('div', 'qp-strip-head', `${cardTitle(this.patch, DEFS, s.card)}: drag, or type a value${s.params.length > 1 || s.pin !== undefined ? ` (${s.params[1] ?? 'depth'}=… for the second)` : ''}; ⏎ goes on`);
    this.strip.replaceChildren(head, ...rows);
  }

  private renderStripValues(): void {
    const s = this.sliders;
    const m = s && this.patch.modules.find((x) => x.id === s.module);
    if (!s || !m) return;
    const outs = [...this.strip.querySelectorAll<HTMLElement>('.qp-value')];
    s.params.forEach((name, i) => {
      const pd = DEFS[m.type].params.find((q) => q.name === name);
      if (!pd || !outs[i]) return;
      const f = formatValue(m.params[name], pd.unit, pd.min < 0);
      outs[i].textContent = `${f.num} ${f.unit}`.trim();
    });
    if (s.pin !== undefined && m.att && outs[s.params.length]) outs[s.params.length].textContent = depthText(DEFS[m.type].params.find((q) => q.name === s.params[0])!, m.att[s.pin]);
  }

  /** the overlay sits in the middle of the canvas's visible area for the whole chain (owner on PR #1094), the panel beside
   *  it, both inside that area and never over the sidebars or the deck (radialPlace); again after a window resize */
  private position(): void {
    const W = innerWidth, H = innerHeight;
    const size = parseFloat(this.ring.style.width) || 2 * RADIAL_CORE;
    const view = document.getElementById('canvas')?.getBoundingClientRect() ?? { left: 0, top: 0, width: W, height: H };
    this.panel.style.maxHeight = `${Math.max(120, view.height - 16)}px`;
    const place = radialPlace(view, size, { w: 340, h: this.panel.offsetHeight || 220 });
    this.ring.style.left = `${Math.round(place.cx - size / 2)}px`;
    this.ring.style.top = `${Math.round(place.cy - size / 2)}px`;
    this.ring.style.transform = place.scale < 1 ? `scale(${place.scale.toFixed(3)})` : '';
    this.panel.style.width = `${Math.round(place.panel.w)}px`;
    this.panel.style.left = `${Math.round(place.panel.x)}px`;
    this.panel.style.top = `${Math.round(place.panel.y)}px`;
  }

  /** the chain is done: when a card made while Quick patch was open lies wholly off screen, ease once to bring them in */
  private settle(): void {
    const ed = this.ed;
    const view = document.getElementById('canvas')?.getBoundingClientRect();
    if (!view || !this.made.length) return;
    const away = this.made.some((card) => {
      const r = ed.cardScreenRect(card);
      return !!r && (r.right < view.left || r.left > view.right || r.bottom < view.top || r.top > view.bottom);
    });
    if (away) ed.showRects(this.made.flatMap((card) => ed.cardRect(card) ?? []));
  }
}

