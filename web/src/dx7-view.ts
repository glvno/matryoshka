// SPDX-License-Identifier: GPL-3.0-only
// The DX7 card's voice editor (#1338): the voice's name, the algorithm as a number with its diagram drawn from the
// algorithm table (the FM-1 shows only the number; the owner, 2026-11-27: "agree with your dx7 choices"), feedback, six
// operator strips and the picked operator in full, the voice's pitch envelope, LFO, transpose and key sync, and SysEx in
// and out (a single voice, or a bank browsed here). Every edit goes through msfa's unpacked form (dx7Unpack, clamped,
// dx7Pack) into ModuleInst.voice as one undoable change of the editor (Dx7Host.setVoice). A browsed bank stays in this
// view's memory, never in the patch.
import { DX7_ALG, DX7_RANGE, dx7Clamp, dx7Pack, dx7Unpack } from './dx7';
import { bankSysex, parseDx7Sysex, singleSysex } from './dx7-sysex';
import { DX7_INIT_VOICE, voiceBytes, voiceHex, voiceName } from './dx7-voice';
import { paramHint } from './labels';
import type { ModuleInst } from './patch';

// ------------------------------------------------------------------ the voice's values (msfa's unpacked form)

/** where operator `op`'s (1..6) value `field` (0..20) sits in the unpacked voice: operator 6 comes first */
export const opAt = (op: number, field: number): number => (6 - op) * 21 + field;
/** an operator's values (offsets in its 21) */
export const OPF = { r: 0, l: 4, bp: 8, ld: 9, rd: 10, lc: 11, rc: 12, rs: 13, ams: 14, vel: 15, level: 16, mode: 17, coarse: 18, fine: 19, detune: 20 } as const;
/** the voice's own values */
export const GLOBAL = { pegR: 126, pegL: 130, alg: 134, fb: 135, oks: 136, speed: 137, delay: 138, pmd: 139, amd: 140, sync: 141, wave: 142, pms: 143, transpose: 144 } as const;
/** the top of each voice value from 126 (dx7.ts dx7Clamp) */
const TOP_G = [99, 99, 99, 99, 99, 99, 99, 99, 31, 7, 1, 99, 99, 99, 99, 1, 5, 7, 48];
/** the top of the unpacked value at `at` */
const top = (at: number): number => (at < 126 ? DX7_RANGE[at % 21] : TOP_G[at - 126] ?? 127);

/** a voice (ModuleInst.voice) with the unpacked value at `at` set to `value`, clamped into the DX7's range */
export function editVoice(hex: string | undefined, at: number, value: number): string {
  const u = dx7Unpack(voiceBytes(hex));
  u[at] = Math.max(0, Math.min(127, Math.round(value)));
  dx7Clamp(u);
  return voiceHex(dx7Pack(u));
}

/** an operator's frequency as the DX7 shows it: a ratio (coarse 0 is 0.50) or a fixed frequency in Hz */
export function opFreq(mode: number, coarse: number, fine: number): string {
  if (mode) {
    const hz = 10 ** (coarse & 3) * Math.exp((Math.LN10 * fine) / 100);
    return hz >= 1000 ? `${(hz / 1000).toFixed(2)}k` : hz >= 100 ? hz.toFixed(0) : hz.toFixed(hz >= 10 ? 1 : 2);
  }
  return ((coarse || 0.5) * (1 + fine / 100)).toFixed(2);
}

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** a key-scaling break point (0 = A-1 .. 99 = C8) as Yamaha names it (C3 = middle C) */
export const breakName = (bp: number): string => `${NOTES[(bp + 21) % 12]}${Math.floor((bp + 21) / 12) - 2}`;

// ------------------------------------------------------------------ the algorithm diagram

/** one algorithm drawn: each operator's place (column from the left, row up from the carriers), who modulates whom,
 *  and the feedback loop (from = to: an operator on itself; algorithms 4 and 6: operator 4 or 5 back into 6) */
export interface AlgDiagram {
  ops: { op: number; col: number; row: number; carrier: boolean }[];
  links: { from: number; to: number }[];
  feedback: { from: number; to: number };
  cols: number;
  rows: number;
}

/** algorithm `alg` (1..32) from the algorithm table (dx7.ts DX7_ALG, operator 6 first: its output and input buses) */
export function algDiagram(alg: number): AlgDiagram {
  const t = DX7_ALG[Math.max(1, Math.min(32, alg)) - 1];
  const opOf = (i: number): number => 6 - i;
  const links: { from: number; to: number }[] = [];
  const mods = new Map<number, number[]>(), targets = new Map<number, number[]>();
  for (let op = 1; op <= 6; op++) { mods.set(op, []); targets.set(op, []); }
  // an operator reading bus b hears the operators that last wrote it: back to the one that wrote it without adding
  for (let i = 0; i < 6; i++) {
    const bus = (t[i] >> 4) & 3;
    if (!bus) continue;
    for (let j = i - 1; j >= 0; j--) {
      if ((t[j] & 3) !== bus) continue;
      links.push({ from: opOf(j), to: opOf(i) });
      mods.get(opOf(i))!.push(opOf(j));
      targets.get(opOf(j))!.push(opOf(i));
      if (!(t[j] & 4)) break;
    }
  }
  // rows: the carriers at the bottom, a modulator one above the highest operator it modulates (computed after it)
  const row = new Map<number, number>();
  for (let i = 5; i >= 0; i--) {
    const ts = targets.get(opOf(i))!;
    row.set(opOf(i), ts.length ? 1 + Math.max(...ts.map((x) => row.get(x)!)) : 0);
  }
  // columns: the carriers from operator 1 left, each stack over its carrier; a modulator of several over their middle
  const col = new Map<number, number>();
  let next = 0;
  const place = (op: number): void => {
    const ms = mods.get(op)!.slice().sort((a, b) => a - b), fresh = ms.filter((x) => !col.has(x));
    fresh.forEach(place);
    col.set(op, fresh.length ? fresh.reduce((s, x) => s + col.get(x)!, 0) / fresh.length : next++);
  };
  const carriers = [1, 2, 3, 4, 5, 6].filter((op) => (t[6 - op] & 3) === 0);
  carriers.forEach(place);
  for (let i = 5; i >= 0; i--) {
    const ts = targets.get(opOf(i))!;
    if (ts.length > 1) col.set(opOf(i), ts.reduce((s, x) => s + col.get(x)!, 0) / ts.length);
  }
  let fbIn = 6, fbFrom = 6;
  for (let i = 0; i < 6; i++) {
    if (t[i] & 0x40) fbIn = opOf(i);
    if (t[i] & 0x80) fbFrom = opOf(i);
  }
  return {
    ops: [1, 2, 3, 4, 5, 6].map((op) => ({ op, col: col.get(op)!, row: row.get(op)!, carrier: carriers.includes(op) })),
    links,
    feedback: { from: fbFrom, to: fbIn },
    cols: next,
    rows: 1 + Math.max(...row.values()),
  };
}

const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (name: string, attrs: Record<string, string | number>): SVGElement => {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

/** the diagram as an SVG: a box per operator (carriers filled), lines from modulator to modulated, the carriers into
 *  the output line, the feedback loop */
function drawAlg(alg: number, d: AlgDiagram): SVGSVGElement {
  const CW = 24, RH = 22, BW = 16, BH = 13, PAD = 8;
  const w = d.cols * CW + 2 * PAD, h = d.rows * RH + 10;
  const svg = svgEl('svg', { class: 'dx7-alg-svg', viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: 'img', 'aria-label': `Algorithm ${alg}` }) as SVGSVGElement;
  const at = new Map(d.ops.map((o) => [o.op, { x: PAD + o.col * CW + CW / 2, y: (d.rows - 1 - o.row) * RH + 4 }]));
  const outY = h - 3;
  const cx = d.ops.filter((o) => o.carrier).map((o) => at.get(o.op)!.x);
  svg.append(svgEl('line', { class: 'dx7-out', x1: Math.min(...cx), x2: Math.max(...cx), y1: outY, y2: outY }));
  for (const x of cx) svg.append(svgEl('line', { class: 'dx7-link', x1: x, x2: x, y1: outY - (RH - BH - 4), y2: outY }));
  for (const l of d.links) {
    const a = at.get(l.from)!, b = at.get(l.to)!;
    svg.append(svgEl('path', { class: 'dx7-link', d: `M${a.x},${a.y + BH} L${a.x},${(a.y + BH + b.y) / 2} L${b.x},${(a.y + BH + b.y) / 2} L${b.x},${b.y}` }));
  }
  const f = at.get(d.feedback.from)!, t = at.get(d.feedback.to)!, fx = Math.max(f.x, t.x) + BW / 2 + 4;
  svg.append(svgEl('path', { class: 'dx7-fb', d: `M${f.x + BW / 2},${f.y + BH / 2} L${fx},${f.y + BH / 2} L${fx},${t.y - 3} L${t.x},${t.y - 3} L${t.x},${t.y}` }));
  for (const o of d.ops) {
    const p = at.get(o.op)!;
    svg.append(svgEl('rect', { class: o.carrier ? 'dx7-op carrier' : 'dx7-op', x: p.x - BW / 2, y: p.y, width: BW, height: BH, rx: 2 }));
    const tx = svgEl('text', { x: p.x, y: p.y + BH - 3, 'text-anchor': 'middle' });
    tx.textContent = String(o.op);
    svg.append(tx);
  }
  return svg;
}

/** an envelope's shape: from level 4 through levels 1, 2, 3 (held a while), back to 4; a slower rate draws longer */
function drawEg(u: Uint8Array, rAt: number, lAt: number): SVGSVGElement {
  const W = 120, H = 30;
  const seg = (r: number): number => 4 + (99 - r) * 0.4;
  const ls = [u[lAt + 3], u[lAt], u[lAt + 1], u[lAt + 2], u[lAt + 2], u[lAt + 3]];
  const ws = [0, seg(u[rAt]), seg(u[rAt + 1]), seg(u[rAt + 2]), 16, seg(u[rAt + 3])];
  const k = W / ws.reduce((s, x) => s + x, 0);
  let x = 0;
  const pts = ls.map((l, i) => `${(x += ws[i] * k).toFixed(1)},${(H - 1 - (l / 99) * (H - 2)).toFixed(1)}`);
  const svg = svgEl('svg', { class: 'dx7-eg', viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true' }) as SVGSVGElement;
  svg.append(svgEl('polyline', { points: pts.join(' ') }));
  return svg;
}

// ------------------------------------------------------------------ SysEx

/** a browsed bank: its 32 voices, the file's name, whether its checksum held, the slot last loaded from it */
interface Bank { name: string; voices: Uint8Array[]; checksumOk: boolean; slot: number | null }

/** what a .syx file gives a module: a voice for it now, or a bank to browse; null when it holds no DX7 voice */
export function readSyx(bytes: ArrayLike<number>, name: string): { voice: string | null; bank: Bank | null; checksumOk: boolean } | null {
  const r = parseDx7Sysex(bytes);
  if (!r) return null;
  if (!r.bank) return { voice: voiceHex(r.voices[0]), bank: null, checksumOk: r.checksumOk };
  return { voice: null, bank: { name: name.replace(/\.syx$/i, ''), voices: r.voices, checksumOk: r.checksumOk, slot: null }, checksumOk: r.checksumOk };
}

/** the bank to save: the browsed one with this voice in the slot it came from, or this voice in slot 1 and the init
 *  voice in the rest */
export function bankToSave(voice: string | undefined, bank: Bank | null): Uint8Array {
  const v = voiceBytes(voice);
  if (!bank) return bankSysex([v], DX7_INIT_VOICE);
  return bankSysex(bank.voices.map((b, i) => (i === bank.slot ? v : b)), DX7_INIT_VOICE);
}

/** a file name from a voice's or bank's name */
const fileName = (name: string, fallback: string): string => `${name.trim().replace(/[^\w.-]+/g, '_') || fallback}.syx`;

function download(bytes: Uint8Array, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------------------ the view

/** what the view needs of the editor */
export interface Dx7Host {
  /** module `id`'s voice becomes `hex`: one undoable change; the editor redraws the card */
  setVoice(id: number, hex: string): void;
  /** a line for the status line */
  say(msg: string): void;
  /** draw the cards again (the view's own state changed: the picked operator, a bank opened or closed) */
  redraw(): void;
}

/** a module's view state: the picked operator, whether the voice section is open, its browsed bank, the field to focus */
interface ViewState { op: number; voice: boolean; bank: Bank | null; focus: string | null }

const WAVES = ['triangle', 'saw down', 'saw up', 'square', 'sine', 'sample & hold'];
const CURVES = ['−lin', '−exp', '+exp', '+lin'];
const hint = (key: string): string => paramHint('dx7', `voice.${key}`) ?? '';

export class Dx7Card {
  private states = new Map<number, ViewState>();

  constructor(private host: Dx7Host) {}

  private state(id: number): ViewState {
    let s = this.states.get(id);
    if (!s) this.states.set(id, (s = { op: 1, voice: false, bank: null, focus: null }));
    return s;
  }

  /** a .syx file's bytes into module `m`: a single voice becomes its voice, a bank is listed to pick from */
  load(m: ModuleInst, bytes: ArrayLike<number>, name: string): void {
    const r = readSyx(bytes, name);
    if (!r) { this.host.say(`${name}: no DX7 voice or bank in it`); return; }
    const bad = r.checksumOk ? '' : ' (its checksum is wrong: read anyway)';
    if (r.bank) {
      this.state(m.id).bank = r.bank;
      this.host.say(`${name}: 32 voices${bad}; pick one on the card`);
      this.host.redraw();
      return;
    }
    this.host.say(`${name}: voice ${voiceName(voiceBytes(r.voice!))} loaded${bad}`);
    this.host.setVoice(m.id, r.voice!);
  }

  /** the bank .syx module `m`'s Bank button saves (bankToSave with its browsed bank) */
  bankFile(m: ModuleInst): Uint8Array {
    return bankToSave(m.voice, this.state(m.id).bank);
  }

  /** bank slot `i` (0..31) into module `m` */
  pick(m: ModuleInst, i: number): void {
    const b = this.state(m.id).bank;
    if (!b) return;
    b.slot = i;
    this.host.setVoice(m.id, voiceHex(b.voices[i]));
  }

  /** the view for DX7 module `m`'s card, made again at every rebuild */
  element(m: ModuleInst): HTMLElement {
    const s = this.state(m.id);
    const u = dx7Unpack(voiceBytes(m.voice));
    const root = document.createElement('div');
    root.className = 'dx7';
    for (const ev of ['pointerdown', 'dblclick', 'wheel'] as const) root.addEventListener(ev, (e) => { if (e.target !== root) e.stopPropagation(); }, { passive: true });
    root.addEventListener('keydown', (e) => { if (e.key !== 'Escape' && !((e.metaKey || e.ctrlKey) && /^[zy]$/i.test(e.key))) e.stopPropagation(); });   // (not a note key or a shortcut)
    let refocus: HTMLElement | null = null;

    const set = (at: number, v: number, key: string, el: HTMLElement): void => {
      const hex = editVoice(m.voice, at, v);
      if (hex === voiceHex(voiceBytes(m.voice))) { if (el instanceof HTMLInputElement && el.type === 'number') el.value = String(u[at] + Number(el.dataset.off ?? 0)); return; }
      s.focus = document.activeElement === el ? key : null;
      this.host.setVoice(m.id, hex);
    };
    /** a value: a number field (shown offset by `off`), a choice or a switch */
    const field = (at: number, label: string, key: string, opts: { off?: number; choices?: string[]; check?: boolean } = {}): HTMLElement => {
      const wrap = document.createElement('label');
      wrap.className = 'dx7-f';
      const title = hint(key);
      if (title) wrap.title = title;
      if (label) { const k = document.createElement('span'); k.textContent = label; wrap.append(k); }
      const fkey = `${at}`;
      let input: HTMLInputElement | HTMLSelectElement;
      if (opts.choices) {
        const sel = document.createElement('select');
        opts.choices.forEach((c, i) => sel.append(new Option(c, String(i), false, u[at] === i)));
        sel.addEventListener('change', () => set(at, Number(sel.value), fkey, sel));
        input = sel;
      } else if (opts.check) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!u[at];
        box.addEventListener('change', () => set(at, box.checked ? 1 : 0, fkey, box));
        input = box;
      } else {
        const off = opts.off ?? 0, num = document.createElement('input');
        num.type = 'number';
        num.min = String(off);
        num.max = String(top(at) + off);
        num.step = '1';
        num.value = String(u[at] + off);
        num.dataset.off = String(off);
        num.addEventListener('change', () => {
          const v = Math.round(Number(num.value));
          if (num.value.trim() === '' || !Number.isFinite(v)) { num.value = String(u[at] + off); return; }
          set(at, v - off, fkey, num);
        });
        input = num;
      }
      input.setAttribute('aria-label', `${label || key} ${title ? `: ${title}` : ''}`.trim());
      if (s.focus === fkey) refocus = input;
      wrap.append(input);
      return wrap;
    };
    const div = (cls: string, ...kids: (Node | string)[]): HTMLElement => {
      const e = document.createElement('div');
      e.className = cls;
      e.append(...kids);
      return e;
    };
    const button = (text: string, title: string, run: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.title = title;
      b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
      return b;
    };

    // the name and SysEx
    const name = document.createElement('b');
    name.className = 'dx7-name';
    name.textContent = voiceName(voiceBytes(m.voice)) || '(no name)';
    name.title = hint('name');
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = '.syx,application/octet-stream';
    file.hidden = true;
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (f) this.load(m, new Uint8Array(await f.arrayBuffer()), f.name);
    });
    const voiceName0 = voiceName(voiceBytes(m.voice));
    root.append(div('dx7-top', name,
      button('Import', hint('import'), () => file.click()),
      button('Voice', hint('exportVoice'), () => download(singleSysex(voiceBytes(m.voice)), fileName(voiceName0, 'dx7-voice'))),
      button('Bank', hint('exportBank'), () => download(this.bankFile(m), fileName(s.bank?.name ?? voiceName0, 'dx7-bank'))),
      file));

    // the algorithm, its diagram, feedback, key sync
    const alg = u[GLOBAL.alg] + 1, diagram = algDiagram(alg);
    root.append(div('dx7-alg',
      div('dx7-algf', field(GLOBAL.alg, 'ALG', 'alg', { off: 1 }), field(GLOBAL.fb, 'FB', 'fb'), field(GLOBAL.oks, 'KEY SYNC', 'oks', { check: true })),
      drawAlg(alg, diagram)));

    // the six operators, one line each; the picked one's number lit
    const heads = [['OP', 'op'], ['LVL', 'level'], ['MODE', 'mode'], ['CRS', 'coarse'], ['FINE', 'fine'], ['DET', 'detune'], ['FREQ', 'freq']];
    const ops = div('dx7-ops', ...heads.map(([h, key]) => {
      const e = div('dx7-h', h);
      e.title = hint(key);
      return e;
    }));
    for (let op = 1; op <= 6; op++) {
      const pick = button(String(op), `Operator ${op}: show all its values below`, () => {
        s.op = op;
        this.host.redraw();
      });
      pick.className = 'dx7-pick' + (op === s.op ? ' on' : '');
      if (diagram.ops[op - 1].carrier) pick.classList.add('carrier');
      const fq = div('dx7-freq', opFreq(u[opAt(op, OPF.mode)], u[opAt(op, OPF.coarse)], u[opAt(op, OPF.fine)]));
      fq.title = u[opAt(op, OPF.mode)] ? 'fixed frequency, Hz' : 'frequency ratio';
      ops.append(pick,
        field(opAt(op, OPF.level), '', 'level'),
        field(opAt(op, OPF.mode), '', 'mode', { choices: ['ratio', 'fixed'] }),
        field(opAt(op, OPF.coarse), '', 'coarse'),
        field(opAt(op, OPF.fine), '', 'fine'),
        field(opAt(op, OPF.detune), '', 'detune', { off: -7 }),
        fq);
    }
    root.append(ops);

    // the picked operator in full: its envelope, key scaling, sensitivities
    const o = s.op, r = opAt(o, OPF.r), l = opAt(o, OPF.l);
    const bpName = breakName(u[opAt(o, OPF.bp)]);
    root.append(div('dx7-sec', div('dx7-st', `Operator ${o}`, drawEg(u, r, l)),
      div('dx7-grid', ...[0, 1, 2, 3].map((i) => field(r + i, `R${i + 1}`, 'rate')), ...[0, 1, 2, 3].map((i) => field(l + i, `L${i + 1}`, 'egLevel'))),
      div('dx7-grid',
        field(opAt(o, OPF.bp), `BP ${bpName}`, 'bp'), field(opAt(o, OPF.ld), 'L DEP', 'ld'), field(opAt(o, OPF.rd), 'R DEP', 'rd'), field(opAt(o, OPF.rs), 'RATE SC', 'rs'),
        field(opAt(o, OPF.lc), 'L CRV', 'curve', { choices: CURVES }), field(opAt(o, OPF.rc), 'R CRV', 'curve', { choices: CURVES }),
        field(opAt(o, OPF.vel), 'VEL', 'vel'), field(opAt(o, OPF.ams), 'AMS', 'ams'))));

    // the voice's own values, folded away until opened
    const g = document.createElement('details');
    g.className = 'dx7-sec dx7-voice';
    g.open = s.voice;
    g.addEventListener('toggle', () => (s.voice = g.open));
    const sum = document.createElement('summary');
    sum.textContent = 'Pitch EG, LFO, transpose';
    g.append(sum,
      div('dx7-st', 'Pitch EG', drawEg(u, GLOBAL.pegR, GLOBAL.pegL)),
      div('dx7-grid', ...[0, 1, 2, 3].map((i) => field(GLOBAL.pegR + i, `R${i + 1}`, 'pegRate')), ...[0, 1, 2, 3].map((i) => field(GLOBAL.pegL + i, `L${i + 1}`, 'pegLevel'))),
      div('dx7-st', 'LFO'),
      div('dx7-grid',
        field(GLOBAL.wave, 'WAVE', 'wave', { choices: WAVES }), field(GLOBAL.speed, 'SPEED', 'speed'), field(GLOBAL.delay, 'DELAY', 'delay'), field(GLOBAL.sync, 'SYNC', 'sync', { check: true }),
        field(GLOBAL.pmd, 'PMD', 'pmd'), field(GLOBAL.amd, 'AMD', 'amd'), field(GLOBAL.pms, 'PMS', 'pms'), field(GLOBAL.transpose, 'TRANSP', 'transpose', { off: -24 })));
    root.append(g);

    // the browsed bank: 32 names, a click loads one
    if (s.bank) {
      const b = s.bank;
      const close = button('×', 'Close this bank (the module keeps its voice)', () => {
        s.bank = null;
        this.host.redraw();
      });
      const head = div('dx7-st', `Bank ${b.name}${b.checksumOk ? '' : ' (checksum wrong)'}`, close);
      head.title = hint('bank');
      const list = div('dx7-bank', ...b.voices.map((v, i) => {
        const e = button(`${i + 1} ${voiceName(v) || '—'}`, `Load voice ${i + 1} into this module`, () => this.pick(m, i));
        if (i === b.slot) e.className = 'on';
        return e;
      }));
      root.append(div('dx7-sec', head, list));
    }
    if (refocus) {
      const f: HTMLElement = refocus;
      s.focus = null;
      queueMicrotask(() => f.isConnected && f.focus());
    }
    return root;
  }
}
