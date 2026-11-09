// SPDX-License-Identifier: GPL-3.0-only
// Factory assemblies compiled ahead of time (#808, a spike): firmware/src/aot_gen.h, written by export-defs.ts. For each
// assembly of AOT_ASSEMBLIES: a template the firmware matches a loaded device against (firmware/src/aot.c aot_fits), and
// one C routine per segment (a run of its members in one group) that renders them without the interpreter's dispatch,
// with its stateless modules on values where a whole block is one value, and worked out only when something reads them.
// The routines call the interpreter's own functions (apply_cv, apply_flaws, process) for everything else, so they are
// exact by construction (tools/aot_test.sh renders every factory patch both ways and compares them sample for sample).
//
// The template comes from the assembly in a plain patch, as the CPU checks build it (cpu-checks.ts): its device form
// (deviceView: dead modules gone, hoisted modules run once), its members in the device extras' order (patchbin.ts
// extrasRecord), its cables, and the ports the assembly exposes (only there may a patch cable it from outside).
import { FACTORY } from '../src/assemblies';
import { allModules, insertAssembly, type AssemblyInst } from '../src/assembly';
import { DEFS } from '../src/modules';
import { connect, newPatch, type Patch } from '../src/patch';
import { TYPE_ORDER } from '../src/patchbin';
import { deviceView } from '../src/poly';
import { structureOf } from '../src/structure';

/** the factory assemblies the firmware runs compiled */
export const AOT_ASSEMBLIES = ['Oracle V'];

/** the module types the routines inline (aot.c ag_*): stateless, one output sample from the input samples at that index */
const GLUE = new Set(['const', 'macro', 'scale', 'vca', 'math', 'select', 'mixer', 'xfade']);
/** the types a part's flaws scale (engine.c apply_flaws) */
const FLAWED = new Set(['filter', 'ladder', 'adsr', 'env', 'env8', 'vca']);

const up = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/** the assembly in a patch of its own, heard and played (cpu-checks.ts) */
export function aotPatch(name: string): { patch: Patch; asm: AssemblyInst } {
  const def = FACTORY.find((d) => d.name === name);
  if (!def) throw new Error(`gen-aot: no factory assembly ${name}`);
  const patch = newPatch(DEFS, def.name);
  const a = insertAssembly(patch, DEFS, def, 300, 0);
  const sink = patch.modules.find((m) => m.type === 'output')!;
  for (const o of a.outputs) connect(patch, DEFS, { module: o.module, port: o.port }, { module: sink.id, port: 'l' });
  const main = patch.modules[0].id;
  for (const i of a.inputs) {
    const from = i.port === 'keys' ? 'keys' : (['pitch', 'gate', 'vel'] as const).find((k) => i.port === k || i.label === k);
    if (from) connect(patch, DEFS, { module: main, port: from }, { module: i.module, port: i.port });
  }
  return { patch, asm: a };
}

interface Cab { f: number; fp: number; t: number; tp: number; fwd: boolean }
interface Mem { dev: number; type: string; grp: number; glue: boolean; seg: number }
type Mode = 'none' | 'sigs' | 'generic';
interface Sig { m: number; p: number; seg: number; local: number; shared: number; atEnd: boolean; needBuf: boolean; laterBuf: boolean }

/** the template and routines of one assembly (k: its index in AOT_TPL) */
export function aotAssembly(name: string, k: number): { c: string; members: number; segments: number; structure: number } {
  const { patch, asm } = aotPatch(name);
  const view = deviceView(patch, true);
  const dev = view.patch;
  const index = new Map(dev.modules.map((m, i) => [m.id, i]));
  const grpOf = (id: number): number => view.groups.findIndex((g) => g.modules.has(id)) + 1;
  const inIdx = (type: string, port: string): number => DEFS[type].inputs.findIndex((p) => p.name === port);
  const outIdx = (type: string, port: string): number => DEFS[type].outputs.findIndex((p) => p.name === port);
  const cab = dev.cables.map((c) => {
    const f = index.get(c.from.module)!, t = index.get(c.to.module)!;
    return { f, fp: outIdx(dev.modules[f].type, c.from.port), t, tp: inIdx(dev.modules[t].type, c.to.port) };
  });
  // engine.c visit: the processing order
  const st = new Array(dev.modules.length).fill(0), order: number[] = [];
  const visit = (id: number): void => {
    st[id] = 1;
    for (const c of cab) if (c.t === id && st[c.f] === 0) visit(c.f);
    st[id] = 2;
    order.push(id);
  };
  for (let i = 0; i < dev.modules.length; i++) if (!st[i]) visit(i);
  const pos = new Map(order.map((m, i) => [m, i]));
  // the members (the device extras' order), their groups as the template numbers them
  const devMembers = allModules(patch, asm).map((id) => index.get(id)).filter((i): i is number => i !== undefined);
  const local = new Map(devMembers.map((d, i) => [d, i]));
  const classes: number[] = [];
  const mem: Mem[] = devMembers.map((d) => {
    const g = grpOf(dev.modules[d].id);
    if (g && !classes.includes(g)) classes.push(g);
    const type = dev.modules[d].type;
    const self = cab.some((c) => c.f === d && c.t === d);
    return { dev: d, type, grp: g ? classes.indexOf(g) + 1 : 0, glue: GLUE.has(type) && !self, seg: -1 };
  });
  const N = mem.length;
  if (N > 64) throw new Error(`gen-aot: ${name} has ${N} members (aot.c AOT_MAXM 64)`);
  const cabs: Cab[] = cab.filter((c) => local.has(c.f) && local.has(c.t)).map((c) => ({ f: local.get(c.f)!, fp: c.fp, t: local.get(c.t)!, tp: c.tp, fwd: pos.get(c.f)! < pos.get(c.t)! }));
  const xin: [number, number][] = [], xout: [number, number][] = [];
  for (const i of asm.inputs) for (const t of [i, ...(i.also ?? [])]) {
    const d = index.get(t.module);
    if (d !== undefined && local.has(d)) xin.push([local.get(d)!, inIdx(dev.modules[d].type, t.port)]);
  }
  for (const o of asm.outputs) {
    const d = index.get(o.module);
    if (d !== undefined && local.has(d)) xout.push([local.get(d)!, outIdx(dev.modules[d].type, o.port)]);
  }
  const exposedIn = (m: number, p: number): boolean => xin.some(([a, b]) => a === m && b === p);
  const exposedOut = (m: number, p: number): boolean => xout.some(([a, b]) => a === m && b === p);

  // the schedule: every member cable keeps its direction; members of one group as long runs as the cables allow
  const before = new Map<number, Set<number>>();
  for (let i = 0; i < N; i++) before.set(i, new Set());
  for (const c of cabs) if (c.f !== c.t) (c.fwd ? before.get(c.t)! : before.get(c.f)!).add(c.fwd ? c.f : c.t);
  const done = new Set<number>(), sched: number[] = [];
  let cur = 0;
  while (sched.length < N) {
    const ready = [...Array(N).keys()].filter((i) => !done.has(i) && [...before.get(i)!].every((j) => done.has(j))).sort((a, b) => pos.get(mem[a].dev)! - pos.get(mem[b].dev)!);
    if (!ready.length) throw new Error(`gen-aot: ${name}: no schedule`);
    const pick = ready.find((i) => mem[i].grp === cur) ?? ready[0];
    cur = mem[pick].grp;
    done.add(pick);
    sched.push(pick);
  }
  const segs: { grp: number; members: number[] }[] = [];
  for (const m of sched) {
    if (!segs.length || segs[segs.length - 1].grp !== mem[m].grp) segs.push({ grp: mem[m].grp, members: [] });
    segs[segs.length - 1].members.push(m);
    mem[m].seg = segs.length - 1;
  }

  // inputs: how each is read
  const into = (m: number, p: number): Cab[] => cabs.filter((c) => c.t === m && c.tp === p);
  const modeOf = (m: number, p: number): Mode => {
    const src = into(m, p);
    if (exposedIn(m, p) || src.some((c) => mem[c.f].grp !== 0 && mem[c.f].grp !== mem[m].grp)) return 'generic';
    return src.length ? 'sigs' : 'none';
  };
  const cvbase = (type: string): number => DEFS[type].inputs.findIndex((p) => p.name === 'p1');
  // a reader that takes the input from it->in[] (a module the routine does not inline, apply_cv's parameter inputs, a
  // Selector that fades)
  const bufReader = (m: number, p: number): boolean => !mem[m].glue || (cvbase(mem[m].type) >= 0 && p >= cvbase(mem[m].type)) || mem[m].type === 'select';

  // the signals: every member output a member or the outside reads
  const sigs = new Map<string, Sig>();
  const segLocal = segs.map(() => 0);
  let shared = 0;
  const key = (m: number, p: number): string => `${m}.${p}`;
  const sigOf = (m: number, p: number): Sig => {
    let s = sigs.get(key(m, p));
    if (!s) sigs.set(key(m, p), (s = { m, p, seg: mem[m].seg, local: -1, shared: -1, atEnd: false, needBuf: false, laterBuf: false }));
    return s;
  };
  for (const c of cabs) {
    const s = sigOf(c.f, c.fp);
    const mode = modeOf(c.t, c.tp), later = mem[c.t].seg > s.seg;
    if (!c.fwd) { s.atEnd = s.needBuf = true; continue; }
    if (mode === 'generic') { if (later) s.atEnd = s.needBuf = true; continue; }
    if (later) {
      s.atEnd = true;
      if (s.shared < 0) s.shared = shared++;
      if (bufReader(c.t, c.tp)) s.laterBuf = true;
    }
  }
  for (const [m, p] of xout) {
    const s = sigOf(m, p);
    s.atEnd = s.needBuf = true;
  }
  for (const s of sigs.values()) if (mem[s.m].glue) s.local = segLocal[s.seg]++;
  if (shared > 32) throw new Error(`gen-aot: ${name}: ${shared} shared signals (aot.c AOT_MAXSH 32)`);
  for (const n of segLocal) if (n > 48) throw new Error(`gen-aot: ${name}: ${n} signals in a segment (aot.c AOT_MAXS 48)`);

  const P = `aot${k}`;
  const L: string[] = [];
  const w = (s = ''): number => L.push(s);
  const getter = (s: Sig): string => `${P}_s${s.seg}_${s.local}`;
  const it = (m: number): string => `c->it[${m}]`;
  // the expression for the signal of output (m, p) as a reader in segment `seg` sees it
  const srcExpr = (m: number, p: number, seg: number, fwd: boolean): string => {
    if (!fwd) return `AB(${it(m)}->out[${p}])`;
    const s = sigs.get(key(m, p))!;
    if (s.seg !== seg) return `c->x->sh[${s.shared}]`;
    return mem[m].glue ? `${getter(s)}(c)` : `AB(${it(m)}->out[${p}])`;
  };
  // the sources of a generic input into their own buffers (the same segment's; the earlier ones are at their segment's end)
  const genericPrep = (m: number, p: number, seg: number): string[] =>
    into(m, p).filter((c) => c.fwd && mem[c.f].seg === seg && mem[c.f].glue).map((c) => `aot_put(${getter(sigs.get(key(c.f, c.fp))!)}(c), ${it(c.f)}->out[${c.fp}], c->n)`);
  // the value of input (m, p): 'sigs' or 'none' (generic inputs: aot_gsum)
  const inExpr = (m: number, p: number): string => {
    const mode = modeOf(m, p);
    if (mode === 'none') return 'AU(0)';
    if (mode === 'generic') return `(${[...genericPrep(m, p, mem[m].seg), `aot_gsum(${it(m)}, ${p}, c->n)`].join(', ')})`;
    const src = into(m, p).map((c) => srcExpr(c.f, c.fp, mem[m].seg, c.fwd));
    if (src.length === 1) return src[0];
    if (src.length === 2) return `aot_add(${src[0]}, ${src[1]}, (esig_t *)${it(m)}->in[${p}], c->n)`;
    return `aot_sum((const asig_t[]){${src.join(', ')}}, ${src.length}u, (esig_t *)${it(m)}->in[${p}], c->n)`;
  };
  const nin = (m: number): number => DEFS[mem[m].type].inputs.length;
  const cvPorts = (m: number): number[] => { const b = cvbase(mem[m].type); return b < 0 ? [] : [b, b + 1].filter((p) => p < nin(m)); };
  const flaws = (m: number): number => (mem[m].grp && FLAWED.has(mem[m].type) ? 1 : 0);
  // members with a parameter input cabled keep their means from part to part (aot.c aot_prepf)
  const cvSlot = new Map<number, number>();
  for (let m = 0; m < N; m++) if (cvPorts(m).some((p) => modeOf(m, p) !== 'none')) cvSlot.set(m, cvSlot.size);
  if (cvSlot.size > 12) throw new Error(`gen-aot: ${name}: ${cvSlot.size} members with parameter inputs (aot.c AOT_MAXCV 12)`);
  const fl = (m: number): string => `0x${(flaws(m) | (cvSlot.has(m) ? (cvSlot.get(m)! + 1) << 8 : 0)).toString(16)}u`;
  // the connected inputs `ports` of member m read through it->in[]: generic ones summed, the others' signals into s[] (mask)
  const gather = (m: number, ports: number[]): { pre: string[]; mask: number } => {
    const pre: string[] = [];
    let mask = 0;
    for (const p of ports) {
      const mode = modeOf(m, p);
      if (mode === 'none') continue;
      if (mode === 'generic') pre.push(`(void)${inExpr(m, p)};`);
      else {
        pre.push(`s[${p}] = ${inExpr(m, p)};`);
        mask |= 1 << p;
      }
    }
    return { pre, mask };
  };
  // its parameters (apply_cv, flaws), the parameter inputs read through it->in[]
  const prep = (m: number): string[] => {
    const { pre, mask } = gather(m, cvPorts(m));
    if (!mask) return [...pre, `aot_prepf(c, ${m}, ${fl(m)});`];
    return ['{', '    asig_t s[MAX_IN];', ...pre.map((x) => '    ' + x), `    aot_prep_in(c, ${m}, ${fl(m)}, 0x${mask.toString(16)}u, s);`, '}'];
  };

  w(`/* ${name}: ${N} members, ${cabs.length} cables, ${segs.length} segments (${segs.map((s) => `${s.grp ? 'per part' : 'once'} ${s.members.length}`).join(', ')}); signals ${segLocal.join(' + ')}, ${shared} handed on, ${cvSlot.size} members with parameter inputs */`);
  const all = [...sigs.values()].filter((s) => mem[s.m].glue);
  for (const s of all) w(`static asig_t ${getter(s)}(aot_cx_t *c);`);
  // the getters
  for (const s of all) {
    const m = s.m, type = mem[m].type;
    w(`static asig_t ${getter(s)}(aot_cx_t *c)   /* ${type} ${m}.${DEFS[type].outputs[s.p].name} */`);
    w('{');
    w(`    if (!c->d[${s.local}]) {`);
    const body: string[] = [];
    if (type !== 'select') {
      const pr = prep(m);
      body.push(`if (!c->prep[${m}])`, ...(pr.length > 1 && pr[0] !== '{' ? ['{', ...pr.map((x) => '    ' + x), '}'] : pr).map((x) => '    ' + x));
    }
    const I = (p: number): string => inExpr(m, p);
    let op: string;
    switch (type) {
      case 'const': case 'macro': op = `ag_const(${it(m)})`; break;
      case 'scale': op = `ag_scale(${it(m)}, ${I(inIdx(type, 'in'))}, c->n)`; break;
      case 'vca': op = `ag_vca(${it(m)}, ${I(inIdx(type, 'in'))}, ${I(inIdx(type, 'cv'))}, c->n)`; break;
      case 'math': op = `ag_math(${it(m)}, ${I(inIdx(type, 'a'))}, ${I(inIdx(type, 'b'))}, ${s.p}, c->n)`; break;
      case 'xfade': op = `ag_xfade(${it(m)}, ${I(inIdx(type, 'a'))}, ${I(inIdx(type, 'b'))}, ${I(inIdx(type, 'pos'))}, c->n)`; break;
      case 'mixer': {
        body.push(`asig_t x[4];`, ...[1, 2, 3, 4].map((j) => `x[${j - 1}] = ${I(inIdx(type, `in${j}`))};`));
        op = `ag_mixer(${it(m)}, x, c->n)`;
        break;
      }
      case 'select': {
        if (s.p === 0) {
          const cases = [1, 2, 3, 4, 5, 6, 7, 8].filter((j) => modeOf(m, inIdx(type, `in${j}`)) !== 'none');
          body.push(`int32_t k = c->k[${m}];`, `asig_t r;`, `if (k < 0)`, `    r = AB(${it(m)}->out[0]);`, `else switch (k) {`);
          for (const j of cases) body.push(`case ${j - 1}: r = aot_sel_out(${it(m)}, ${I(inIdx(type, `in${j}`))}, k, c->n); break;`);
          body.push(`default: r = aot_sel_out(${it(m)}, AU(0), k, c->n); break;`, `}`);
          op = 'r';
        } else op = `AU(${it(m)}->s.sel.k == ${s.p - 1} ? ENG_ONE : 0)`;
        break;
      }
      default: throw new Error(type);
    }
    for (const b of body) w('        ' + b);
    w(`        c->s[${s.local}] = ${op};`);
    w(`        c->d[${s.local}] = 1;`);
    w('    }');
    w(`    return c->s[${s.local}];`);
    w('}');
  }
  // the segments
  segs.forEach((sg, si) => {
    const used = new Set<number>(sg.members);
    for (const m of sg.members) for (const c of cabs) if (c.t === m && (!c.fwd || modeOf(m, c.tp) === 'generic')) used.add(c.f);
    const bind = [...used].sort((a, b) => a - b);
    w(`static const uint8_t ${P}_bind${si}[${bind.length}] = {${bind.join(', ')}};`);
    // The JieLi compiler keeps separate slots for each member's arrays and signal temporaries. A call boundary
    // releases them before the next member, and keeps a whole segment's frame off the interpreter's deeper calls.
    const calls: string[] = [];
    for (const m of sg.members) {
      const type = mem[m].type;
      const body: string[] = [];
      if (!mem[m].glue) {
        const { pre, mask } = gather(m, [...Array(nin(m)).keys()]);
        if (mask) body.push('asig_t s[MAX_IN];');
        body.push(...pre, `aot_blk(c, ${m}, ${fl(m)}, 0x${mask.toString(16)}u, ${mask ? 's' : '0'});`);
      } else if (type === 'select') {
        const { pre, mask } = gather(m, [1, 2, 3, 4, 5, 6, 7, 8].map((j) => inIdx(type, `in${j}`)));
        body.push(...prep(m));
        body.push(`if ((c->k[${m}] = (int8_t)ag_select_k(${it(m)}, ${inExpr(m, inIdx(type, 'pos'))})) < 0) {   /* it fades: m_select on its inputs */`);
        if (mask) body.push('    asig_t s[MAX_IN];');
        body.push(...pre.map((x) => '    ' + x), `    aot_sel_fade(c, ${m}, 0x${mask.toString(16)}u, ${mask ? 's' : '0'});`, '}');
      } else if (cabs.some((c) => c.t === m && !c.fwd)) {
        for (const s of [...sigs.values()].filter((s) => s.m === m)) body.push(`(void)${getter(s)}(c);   /* (it reads a later module's last block: now) */`);
      }
      if (!body.length) continue;
      const fn = `${P}_member${m}`;
      w(`static __attribute__((noinline)) void ${fn}(aot_cx_t *c)   /* ${type} ${m} */`);
      w('{');
      for (const line of body) w('    ' + line);
      w('}');
      calls.push(`${fn}(c);`);
    }
    w(`static void ${P}_seg${si}(aot_x_t *x, uint32_t v, uint32_t n)   /* ${sg.grp ? 'per part' : 'once'}: ${sg.members.map((m) => mem[m].type).join(' ')} */`);
    w('{');
    w(`    aot_cx_t *c = aot_begin(x, v, n, ${P}_bind${si}, ${bind.length}u, ${Math.max(1, segLocal[si])}u);`);
    for (const call of calls) w('    ' + call);
    // the segment's end: what later segments, the outside and the next block read
    for (const s of [...sigs.values()].filter((s) => s.seg === si && s.atEnd)) {
      const glue = mem[s.m].glue;
      if (!glue && s.shared < 0) continue;
      const val = glue ? `${getter(s)}(c)` : `AB(${it(s.m)}->out[${s.p}])`;
      const fin = glue && (s.needBuf || s.laterBuf) ? `aot_fin(${val}, ${it(s.m)}->out[${s.p}], ${s.needBuf ? 1 : 2}u, n)` : val;
      w(`    ${s.shared >= 0 ? `x->sh[${s.shared}] = ` : '(void)'}${fin};   /* ${mem[s.m].type} ${s.m}.${DEFS[mem[s.m].type].outputs[s.p].name} */`);
    }
    w('}');
  });
  // the template
  w(`static const uint8_t ${P}_type[${N}] = {${mem.map((m) => `T_${up(m.type)}`).join(', ')}};`);
  w(`static const uint8_t ${P}_grp[${N}] = {${mem.map((m) => m.grp).join(', ')}};`);
  w(`static const aot_cab_t ${P}_cab[${cabs.length}] = {${cabs.map((c) => `{${c.f}, ${c.fp}, ${c.t}, ${c.tp}, ${c.fwd ? 1 : 0}}`).join(', ')}};`);
  w(`static const uint8_t ${P}_xin[] = {${[...xin.flat(), 0xff].join(', ')}};`);
  w(`static const uint8_t ${P}_xout[] = {${[...xout.flat(), 0xff].join(', ')}};`);
  w(`static const uint8_t ${P}_seg_grp[${segs.length}] = {${segs.map((s) => s.grp).join(', ')}};`);
  w(`static const uint8_t ${P}_seg_lead[${segs.length}] = {${segs.map((s) => s.members[0]).join(', ')}};`);
  w(`static const aot_seg_fn ${P}_seg[${segs.length}] = {${segs.map((_, i) => `${P}_seg${i}`).join(', ')}};`);
  const structure = parseInt(structureOf(patch, asm), 16) >>> 0;
  w(`static const aot_tpl_t ${P} = {0x${structure.toString(16).padStart(8, '0')}u, ${N}, ${cabs.length}, ${segs.length}, ${P}_type, ${P}_grp, ${P}_cab, ${P}_xin, ${P}_xout, ${P}_seg_grp, ${P}_seg_lead, ${P}_seg, ${JSON.stringify(name)}};`);
  return { c: L.join('\n'), members: N, segments: segs.length, structure };
}

/** firmware/src/aot_gen.h */
export function aotHeader(): string {
  const out = [
    '/* SPDX-License-Identifier: GPL-3.0-only */',
    '/* Generated by web/scripts/gen-aot.ts (npm run export-defs) from the factory assemblies. Do not edit. Included by aot.c. */',
    '',
  ];
  const parts = AOT_ASSEMBLIES.map((n, k) => aotAssembly(n, k));
  for (const p of parts) out.push(p.c, '');
  out.push(`#define AOT_NTPL ${parts.length}u`);
  out.push(`static const aot_tpl_t *const AOT_TPL[${Math.max(1, parts.length)}] = {${parts.map((_, k) => `&aot${k}`).join(', ') || '0'}};`);
  void TYPE_ORDER;
  return out.join('\n') + '\n';
}
