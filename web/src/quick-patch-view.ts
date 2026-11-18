// SPDX-License-Identifier: GPL-3.0-only
// Quick patch (#1091) on screen: one field at the pointer for module names, port names and typed chains, the current card's
// ports in a ring round it (outputs on the right arc, inputs on the left), a strip of sliders for the parameter a cable
// just reached, and the trail of cards followed along cables. quick-patch.ts holds the rules; the editor makes the changes,
// each chain one undo step (Editor.beginStep), and moves the view to keep the chain in sight (Editor.showRects).
import type { Editor } from './editor';
import { DEFS } from './modules';
import { depthText, parseDepth, storedDepth } from './depth';
import { formatValue, longName } from './labels';
import { DEPTH_MAX, fromUnit, toUnit, type ParamDef, type Patch } from './patch';
import { isPin, parameterInputs } from './parameter-routing';
import {
  besideSpot, buildChain, cardExists, cardKey, cardPorts, cardTitle, ChainError, chainText, farEnds, fit, guessSize, isChainText,
  matchPorts, moveCard, parseChain, portCables, rankPorts, removeBlueprint, sameCard, saveBlueprint, search, Trail, wire,
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

/** one line of the list under the field: what Enter (or a click) does */
interface Choice { label: string; detail?: string; port?: QPort; follow?: boolean; run: (shift: boolean) => void }

/** the parameter a cable just reached: the strip's sliders (its value, and the depth of the pin that carries it) */
interface Sliders { card: Card; module: number; params: string[]; pin?: 0 | 1 }

/** how many ports one arc of the ring shows before it pages (PageDown / PageUp) */
const ARC_MAX = 12;
const CHIP_H = 26;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

export class QuickPatch {
  private readonly panel = el('div', 'qp-panel');
  private readonly crumbs = el('div', 'qp-trail');
  private readonly field = el('input', 'qp-field');
  private readonly hint = el('div', 'qp-hint');
  private readonly list = el('ul', 'qp-list');
  private readonly last = el('div', 'qp-last');
  private readonly ring = el('div', 'qp-ring');
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
  /** where the panel goes while no card is current (client px) */
  private spot = { x: 0, y: 0 };
  private raf = 0;
  private placed = '';

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
    keys.innerHTML = '<kbd>⏎</kbd> pick <kbd>⇧⏎</kbd> follow a cable <kbd>[</kbd><kbd>]</kbd> back, forward <kbd>Esc</kbd> done · <code>a.out &gt; b.in</code> a chain · <code>bp name</code> a blueprint';
    this.panel.append(this.crumbs, this.field, this.hint, this.list, this.last, keys);
    this.ring.setAttribute('aria-hidden', 'true');
    this.field.addEventListener('input', () => { this.page = 0; this.sel = 0; this.error = ''; this.render(); });
    this.field.addEventListener('keydown', (e) => this.key(e));
    // the panel, ring and strip keep the field's focus: a press on a chip or a list line acts without taking it
    for (const part of [this.panel, this.ring]) part.addEventListener('mousedown', (e) => { if (e.target !== this.field) e.preventDefault(); });
    this.strip.addEventListener('pointerup', () => requestAnimationFrame(() => this.field.focus()));
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
    const canvas = document.getElementById('canvas')?.getBoundingClientRect();
    this.spot = ed.pointer ?? (canvas ? { x: canvas.left + canvas.width / 2 - 170, y: canvas.top + canvas.height / 3 } : { x: 200, y: 200 });
    if (!this.isOpen) {
      document.body.append(this.ring, this.strip, this.panel);
      this.isOpen = true;
      this.trail.clear();
      this.at = null;
      this.held = null;
      this.far = null;
      this.sliders = null;
      this.field.value = '';
      this.loop();
    }
    if (selected) this.goTo(selected, false);
    this.render();
    this.field.focus();
  }

  /** end the chain (one undo step) and close */
  close(): void {
    if (!this.isOpen) return;
    this.finishChain();
    this.isOpen = false;
    cancelAnimationFrame(this.raf);
    this.panel.remove();
    this.ring.remove();
    this.strip.remove();
    this.field.blur();
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
    this.frame();
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
    this.goTo(card);
    this.frame();
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
    if (fit(held.port, port) < 0) return this.fail(`${port.name} does not take ${held.port.dir === 'out' ? 'that output' : 'an input'}`);
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
    this.frame();
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
    this.frame();
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
    this.frame();
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
    this.render();
    this.frame(b.cards);
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
      return this.far.ends.map((end) => ({ label: `⤳ ${end.title}`, detail: longName(this.typeOf(end.card), end.port), run: () => this.travel(end.card) }));
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
      label: `${q.dir === 'out' ? 'out' : 'in'} · ${q.name}`,
      detail: `${q.label !== q.name ? `${q.label} · ` : ''}${q.param ? 'parameter' : q.kind}${follow}`,
      port: q,
      follow: ends.length > 0,
      run: (shift) => (shift && ends.length ? this.follow(q) : this.pick(q)),
    };
  }

  private hitChoice(hit: Hit): Choice {
    const run = (): void => {
      if (hit.kind === 'card') {
        this.goTo(hit.card);
        this.render();
        this.frame();
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
    this.renderRing();
    this.renderStrip();
    this.placed = '';
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
      li.append(el('span', 'qp-label', c.label));
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

  /** the ring's chips, per arc: outputs right, inputs left, the ones the held cable fits first */
  private arcs(): { outs: QPort[]; ins: QPort[]; pages: number } {
    if (!this.at || this.far) return { outs: [], ins: [], pages: 0 };
    // holding a cable from this card: only the port it comes from
    if (this.held && sameCard(this.held.card, this.at)) return this.held.port.dir === 'out' ? { outs: [this.held.port], ins: [], pages: 1 } : { outs: [], ins: [this.held.port], pages: 1 };
    let ports = cardPorts(this.patch, DEFS, this.at);
    const held = this.held && !sameCard(this.held.card, this.at) ? this.held.port : null;
    if (held) ports = [...rankPorts(ports, held, this.cabled(this.at)), ...ports.filter((q) => fit(held, q) < 0)];
    const t = this.field.value.trim();
    if (t && !isChainText(t)) {
      const hits = new Set(matchPorts(ports, t));
      ports = ports.filter((q) => hits.has(q));
    }
    const outs = ports.filter((q) => q.dir === 'out'), ins = ports.filter((q) => q.dir === 'in');
    const pages = Math.max(1, Math.ceil(Math.max(outs.length, ins.length) / ARC_MAX));
    this.page = Math.min(Math.max(0, this.page), pages - 1);
    const cut = (l: QPort[]): QPort[] => l.slice(this.page * ARC_MAX, (this.page + 1) * ARC_MAX);
    return { outs: cut(outs), ins: cut(ins), pages };
  }

  private renderRing(): void {
    const { outs, ins, pages } = this.arcs();
    const at = this.at;
    if (!at) return void this.ring.replaceChildren();
    const held = this.held && !sameCard(this.held.card, at) ? this.held.port : null;
    // (the list's ports and the ring's are made apart: the same port by direction, name and thumb)
    const same = (a: QPort | undefined, b: QPort): boolean => !!a && a.dir === b.dir && a.name === b.name && !a.param === !b.param;
    const chosen = this.held && sameCard(this.held.card, at) ? this.held.port : this.choices[this.sel]?.port;
    const first = !this.field.value.trim() ? this.choices[0]?.port : undefined;
    const chip = (q: QPort): HTMLElement => {
      const f = held ? fit(held, q) : 0;
      const ends = !this.held ? farEnds(this.patch, DEFS, at, q) : [];
      const b = el('button', `qp-chip ${q.dir} ${q.param ? 'control' : q.kind}${f === 0 ? (held ? ' lit' : '') : f > 0 ? ' dim' : ' off'}${same(chosen, q) ? ' sel' : ''}${ends.length || (this.held && this.cabled(at)(q)) ? ' cabled' : ''}`);
      b.tabIndex = -1;
      b.title = `${q.label} (${q.param ? 'parameter' : q.kind})${ends.length ? `: ⤳ ${ends.map((e) => e.title).join(', ')} (Shift-click follows)` : ''}`;
      const name = el('span', 'qp-name', q.name);
      const dot = el('span', 'qp-dot');
      const parts: HTMLElement[] = q.dir === 'out' ? [name, dot] : [dot, name];
      if (same(first, q)) parts[q.dir === 'out' ? 'push' : 'unshift'](el('kbd', '', '⏎'));
      if (ends.length) {
        const go = el('span', 'qp-follow', `⤳ ${ends.length === 1 ? ends[0].title : ends.length}`);
        go.onclick = (e) => { e.stopPropagation(); this.follow(q); };
        parts[q.dir === 'out' ? 'push' : 'unshift'](go);
      }
      b.append(...parts);
      b.disabled = f < 0;
      b.onclick = (e) => (e.shiftKey && ends.length ? this.follow(q) : this.pick(q));
      b.dataset.dir = q.dir;
      return b;
    };
    const chips = [...outs.map(chip), ...ins.map(chip)];
    if (pages > 1) {
      const more = el('button', 'qp-chip qp-more', `${this.page + 1} / ${pages} ▾`);
      more.tabIndex = -1;
      more.title = 'More ports (PageDown, PageUp), or type a port\'s name';
      more.onclick = () => { this.page = (this.page + 1) % pages; this.render(); };
      more.dataset.dir = 'more';
      chips.push(more);
    }
    this.ring.replaceChildren(...chips);
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

  /** keep the panel, the ring and the strip on their cards while the view moves (each frame, only when something moved) */
  private loop(): void {
    this.raf = requestAnimationFrame(() => {
      if (!this.isOpen) return;
      this.position();
      this.loop();
    });
  }

  private position(): void {
    const ed = this.ed;
    const r = this.at ? ed.cardScreenRect(this.at) : null;
    const sr = this.sliders ? ed.cardScreenRect(this.sliders.card) : null;
    const key = JSON.stringify([r && [r.left, r.top, r.width, r.height], sr && [sr.left, sr.top, sr.width], this.spot, innerWidth, innerHeight, this.ring.childElementCount]);
    if (key === this.placed) return;
    this.placed = key;
    const W = innerWidth, H = innerHeight, PW = Math.min(360, W - 16);
    // the panel: under the current card (over it when there is no room below), else at the pointer
    const ph = this.panel.offsetHeight || 220;
    let px = this.spot.x, py = this.spot.y + 12;
    if (r) {
      px = r.left + r.width / 2 - PW / 2;
      py = r.bottom + 14;
      if (py + ph > H - 8) py = r.top - ph - 14;
      if (py < 8) py = Math.min(H - ph - 8, Math.max(8, r.bottom + 14));
    }
    this.panel.style.width = `${PW}px`;
    this.panel.style.left = `${Math.round(Math.min(W - PW - 8, Math.max(8, px)))}px`;
    this.panel.style.top = `${Math.round(Math.min(H - ph - 8, Math.max(8, py)))}px`;
    // the ring: an arc on each side of the card, the middle ports furthest out; a card as wide as the window (Main's
    // panel in the dock) gets a row over it instead
    const chips = [...this.ring.children] as HTMLElement[];
    if (r) {
      const wide = r.width > W * 0.5;
      const side = (dir: string): HTMLElement[] => chips.filter((c) => c.dataset.dir === dir);
      if (wide) {
        let x = r.left + 12;
        for (const c of chips) {
          c.style.left = `${Math.round(x)}px`;
          c.style.top = `${Math.round(Math.max(8, r.top - CHIP_H - 8))}px`;
          c.style.transform = '';
          x += c.offsetWidth + 6;
        }
      } else {
        const arc = (list: HTMLElement[], right: boolean): void => {
          const n = list.length;
          const span = (n - 1) * CHIP_H;
          const cy = Math.min(H - span / 2 - CHIP_H, Math.max(span / 2 + 8, r.top + Math.min(r.height, H) / 2));
          list.forEach((c, i) => {
            const u = n > 1 ? (i - (n - 1) / 2) / ((n - 1) / 2) : 0;
            const out = 12 + 28 * (1 - u * u);
            c.style.top = `${Math.round(cy + (i - (n - 1) / 2) * CHIP_H - CHIP_H / 2)}px`;
            c.style.left = `${Math.round(right ? r.right + out : r.left - out)}px`;
            c.style.transform = right ? '' : 'translateX(-100%)';
          });
        };
        arc([...side('out'), ...side('more')], true);
        arc(side('in'), false);
      }
    }
    // the strip of sliders: over the card whose parameter the cable reached
    if (sr && this.strip.childElementCount) {
      const sw = Math.min(320, W - 16);
      const sh = this.strip.offsetHeight || 80;
      this.strip.style.width = `${sw}px`;
      this.strip.style.left = `${Math.round(Math.min(W - sw - 8, Math.max(8, sr.left + sr.width / 2 - sw / 2)))}px`;
      this.strip.style.top = `${Math.round(Math.max(8, sr.top - sh - 10))}px`;
      this.strip.hidden = false;
    } else this.strip.hidden = true;
  }

  /** move the view so the chain's cards stay in sight: all of them while they fit at a readable zoom, else the newest (the
   *  current card with room for its ring and panel, and the strip over the card it is on) */
  private frame(extra: Card[] = []): void {
    const ed = this.ed;
    const cards = [...this.links.flatMap((l) => [l.from, l.to]), ...this.fresh, ...extra, ...(this.held ? [this.held.card] : []), ...(this.at ? [this.at] : [])];
    const seen = new Set<string>();
    const newest = cards.reverse().filter((c) => !seen.has(cardKey(c)) && seen.add(cardKey(c))).reverse();
    const z = ed.zoom;
    // the ring's arcs stand as tall as their chips, centred on the card
    const arc = (dir: string): number => [...this.ring.children].filter((c) => (c as HTMLElement).dataset.dir === dir).length;
    const ringH = (Math.max(arc('in'), arc('out') + arc('more')) + 1) * CHIP_H / z;
    const rects = newest.flatMap((c) => {
      const r = ed.cardRect(c);
      if (!r) return [];
      if (!sameCard(c, this.at)) return [r];
      const top = Math.min(r.y, r.y + r.h / 2 - ringH / 2);
      return [{ x: r.x - 150 / z, y: top, w: r.w + 300 / z, h: Math.max(r.y + r.h, top + ringH) - top + 200 / z }];
    });
    const s = this.sliders && ed.cardRect(this.sliders.card);
    if (s) rects.push({ x: s.x, y: s.y - 110 / z, w: s.w, h: 110 / z });
    if (rects.length) ed.showRects(rects);
  }
}

