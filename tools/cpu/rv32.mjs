// SPDX-License-Identifier: GPL-3.0-only
// A small RV32IMF interpreter that runs tools/cpu/prof.c (the engine built for rv32imf) and counts what each module costs.
// Cycles are a simple in-order model: 1 per instruction, +1 for a load, +2 for a taken branch or a jump, +32 for a
// division; a float operation costs what the FM-1's FPU takes against its 1-cycle integer operations (add, subtract,
// multiply, compare, min / max 1.6, divide 3.0, a conversion between int and float 2.3: docs/measurements/2026-11-16-fpu.md).
// The FM-1's core is not RISC-V; only the ratios matter, the scale comes from patches measured on the device.
import { readFileSync } from 'node:fs';

const MEM = 16 << 20;

/** cycle cost by kind: the only place the model's weights live */
export const WEIGHTS = { base: 1, load: 1, taken: 2, jump: 2, div: 32, fpu: 0.6, fdiv: 2, fcvt: 1.3 };

/** the bits of a float32 and back */
const F32 = new Float32Array(1), I32 = new Int32Array(F32.buffer);
const fbits = (v) => ((F32[0] = v), I32[0]);
const ffrom = (b) => ((I32[0] = b), F32[0]);
/** v rounded to an integer by RISC-V rounding mode rm (7: the dynamic mode, round to nearest as the engine leaves it) */
function fround(v, rm) {
  switch (rm) {
    case 1: return Math.trunc(v);
    case 2: return Math.floor(v);
    case 3: return Math.ceil(v);
    case 4: return v < 0 ? -Math.round(-v) : Math.round(v);
    default: {
      const r = Math.round(v);
      return r - v === 0.5 && r % 2 !== 0 ? r - 1 : r;
    }
  }
}

function loadElf(buf, mem) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0) !== 0x7f454c46) throw new Error('not an ELF file');
  const entry = dv.getUint32(24, true), phoff = dv.getUint32(28, true);
  const phentsize = dv.getUint16(42, true), phnum = dv.getUint16(44, true);
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (dv.getUint32(o, true) !== 1) continue;           // PT_LOAD
    const off = dv.getUint32(o + 4, true), vaddr = dv.getUint32(o + 8, true);
    const filesz = dv.getUint32(o + 16, true), memsz = dv.getUint32(o + 20, true);
    mem.fill(0, vaddr, vaddr + memsz);
    mem.set(buf.subarray(off, off + filesz), vaddr);
  }
  return entry;
}

/**
 * Run the profiling build on one patch.
 * @param {Uint8Array} elf  build/cpu_prof.elf
 * @param {Uint8Array} patch  the binary patch (patchbin.ts encodePatch)
 * @param {number[]} events  (kind << 16) | note: 1 note on, 2 note off, 3 render one 128-frame block
 * @param {Partial<typeof WEIGHTS>} [w]  other cycle weights
 * @param {Float64Array} [hist]  if given, the cycles of every instruction are added at index pc / 4 (web/scripts/cpu-hot.ts)
 * @returns {{ blocks: { total: number, nodes: Map<string, {sum: number, cv: number, run: number}> }[], exit: number }}
 *   per rendered block: the cycles of the whole render (incl. the ISR's output loop), and per "node/part" the cycles of
 *   its input sums, parameter inputs and processing.
 */
export function profile(elf, patch, events, w = WEIGHTS, hist = null) {
  const W = { ...WEIGHTS, ...w };
  const mem = new Uint8Array(MEM);
  const dv = new DataView(mem.buffer);
  const x = new Int32Array(32), f = new Float32Array(32);
  let pc = loadElf(elf, mem);
  let cycles = 0, evi = 0;
  const blocks = [];
  let cur = null, mark = 0, stageNode = '';
  const ld8 = (a) => mem[a >>> 0];
  const ld16 = (a) => dv.getUint16(a >>> 0, true);
  const ld32 = (a) => dv.getInt32(a >>> 0, true);
  for (;;) {
    const ins = dv.getUint32(pc, true);
    const op = ins & 0x7f, rd = (ins >> 7) & 31, f3 = (ins >> 12) & 7, rs1 = (ins >> 15) & 31, rs2 = (ins >> 20) & 31;
    const f7 = ins >>> 25;
    let next = pc + 4;
    const c0 = cycles;
    cycles += W.base;
    switch (op) {
      case 0x37: if (rd) x[rd] = ins & 0xfffff000; break;                          // lui
      case 0x17: if (rd) x[rd] = (pc + (ins & 0xfffff000)) | 0; break;             // auipc
      case 0x6f: {                                                                 // jal
        const imm = ((ins >> 31) ? -1 << 20 : 0) | (((ins >> 12) & 0xff) << 12) | (((ins >> 20) & 1) << 11) | (((ins >> 21) & 0x3ff) << 1);
        if (rd) x[rd] = next;
        next = (pc + imm) >>> 0;
        cycles += W.jump;
        break;
      }
      case 0x67: {                                                                 // jalr
        const t = ((x[rs1] + (ins >> 20)) & ~1) >>> 0;
        if (rd) x[rd] = next;
        next = t;
        cycles += W.jump;
        break;
      }
      case 0x63: {                                                                 // branches
        const imm = ((ins >> 31) ? -1 << 12 : 0) | (((ins >> 7) & 1) << 11) | (((ins >> 25) & 0x3f) << 5) | (((ins >> 8) & 0xf) << 1);
        const a = x[rs1], b = x[rs2];
        let t;
        switch (f3) {
          case 0: t = a === b; break;
          case 1: t = a !== b; break;
          case 4: t = a < b; break;
          case 5: t = a >= b; break;
          case 6: t = (a >>> 0) < (b >>> 0); break;
          case 7: t = (a >>> 0) >= (b >>> 0); break;
          default: throw new Error(`bad branch at ${pc.toString(16)}`);
        }
        if (t) {
          next = (pc + imm) >>> 0;
          cycles += W.taken;
        }
        break;
      }
      case 0x03: {                                                                 // loads
        const a = (x[rs1] + (ins >> 20)) >>> 0;
        let v;
        switch (f3) {
          case 0: v = (ld8(a) << 24) >> 24; break;
          case 1: v = (ld16(a) << 16) >> 16; break;
          case 2: v = ld32(a); break;
          case 4: v = ld8(a); break;
          case 5: v = ld16(a); break;
          default: throw new Error(`bad load at ${pc.toString(16)}`);
        }
        if (rd) x[rd] = v;
        cycles += W.load;
        break;
      }
      case 0x23: {                                                                 // stores
        const a = (x[rs1] + (((ins >> 25) << 5) | ((ins >> 7) & 31))) >>> 0;
        const v = x[rs2];
        if (f3 === 0) mem[a] = v;
        else if (f3 === 1) dv.setUint16(a, v, true);
        else dv.setInt32(a, v, true);
        break;
      }
      case 0x13: {                                                                 // op-imm
        const imm = ins >> 20, a = x[rs1];
        let v;
        switch (f3) {
          case 0: v = a + imm; break;
          case 1: v = a << (imm & 31); break;
          case 2: v = a < imm ? 1 : 0; break;
          case 3: v = (a >>> 0) < (imm >>> 0) ? 1 : 0; break;
          case 4: v = a ^ imm; break;
          case 5: v = (ins >>> 30) & 1 ? a >> (imm & 31) : a >>> (imm & 31); break;
          case 6: v = a | imm; break;
          case 7: v = a & imm; break;
        }
        if (rd) x[rd] = v;
        break;
      }
      case 0x33: {                                                                 // op, M extension
        const a = x[rs1], b = x[rs2];
        let v;
        if (f7 === 1) {
          switch (f3) {
            case 0: v = Math.imul(a, b); break;
            case 1: v = Number((BigInt(a) * BigInt(b)) >> 32n); break;
            case 2: v = Number((BigInt(a) * BigInt(b >>> 0)) >> 32n); break;
            case 3: v = Number((BigInt(a >>> 0) * BigInt(b >>> 0)) >> 32n); break;
            case 4: v = b === 0 ? -1 : a === -0x80000000 && b === -1 ? a : (a / b) | 0; cycles += W.div; break;
            case 5: v = b === 0 ? -1 : ((a >>> 0) / (b >>> 0)) >>> 0; cycles += W.div; break;
            case 6: v = b === 0 ? a : a === -0x80000000 && b === -1 ? 0 : a % b; cycles += W.div; break;
            case 7: v = b === 0 ? a : (a >>> 0) % (b >>> 0); cycles += W.div; break;
          }
        } else {
          switch (f3) {
            case 0: v = f7 ? a - b : a + b; break;
            case 1: v = a << (b & 31); break;
            case 2: v = a < b ? 1 : 0; break;
            case 3: v = (a >>> 0) < (b >>> 0) ? 1 : 0; break;
            case 4: v = a ^ b; break;
            case 5: v = f7 ? a >> (b & 31) : a >>> (b & 31); break;
            case 6: v = a | b; break;
            case 7: v = a & b; break;
          }
        }
        if (rd) x[rd] = v | 0;
        break;
      }
      case 0x07: {                                                                 // flw
        if (f3 !== 2) throw new Error(`bad float load at ${pc.toString(16)}`);
        f[rd] = dv.getFloat32((x[rs1] + (ins >> 20)) >>> 0, true);
        cycles += W.load;
        break;
      }
      case 0x27: {                                                                 // fsw
        if (f3 !== 2) throw new Error(`bad float store at ${pc.toString(16)}`);
        dv.setFloat32((x[rs1] + (((ins >> 25) << 5) | ((ins >> 7) & 31))) >>> 0, f[rs2], true);
        break;
      }
      case 0x53: {                                                                 // op-fp (F extension, single precision)
        const a = f[rs1], b = f[rs2];
        switch (f7) {
          case 0x00: f[rd] = a + b; cycles += W.fpu; break;
          case 0x04: f[rd] = a - b; cycles += W.fpu; break;
          case 0x08: f[rd] = a * b; cycles += W.fpu; break;
          case 0x0c: f[rd] = a / b; cycles += W.fdiv; break;
          case 0x2c: f[rd] = Math.sqrt(a); cycles += W.fdiv; break;
          case 0x10: {                                                             // fsgnj / fsgnjn / fsgnjx (fmv, fneg, fabs)
            const sa = fbits(a), sb = fbits(b);
            const s = f3 === 0 ? sb : f3 === 1 ? ~sb : sa ^ sb;
            f[rd] = ffrom((sa & 0x7fffffff) | (s & 0x80000000));
            break;
          }
          case 0x14:                                                               // fmin / fmax (a NaN gives the other)
            f[rd] = Number.isNaN(a) ? b : Number.isNaN(b) ? a : f3 === 0 ? Math.min(a, b) : Math.max(a, b);
            cycles += W.fpu;
            break;
          case 0x50:                                                               // fle / flt / feq
            if (rd) x[rd] = f3 === 0 ? +(a <= b) : f3 === 1 ? +(a < b) : +(a === b);
            cycles += W.fpu;
            break;
          case 0x60: {                                                             // fcvt.w.s / fcvt.wu.s (saturating)
            const v = Number.isNaN(a) ? Infinity : fround(a, f3);
            const r = rs2 === 0 ? Math.max(-0x80000000, Math.min(0x7fffffff, v)) | 0 : Math.max(0, Math.min(0xffffffff, v)) | 0;
            if (rd) x[rd] = r;
            cycles += W.fcvt;
            break;
          }
          case 0x68: f[rd] = rs2 === 0 ? x[rs1] : x[rs1] >>> 0; cycles += W.fcvt; break;   // fcvt.s.w / fcvt.s.wu
          case 0x70:                                                               // fmv.x.w
            if (f3 !== 0) throw new Error(`fclass at ${pc.toString(16)}`);
            if (rd) x[rd] = fbits(a);
            break;
          case 0x78: f[rd] = ffrom(x[rs1]); break;                                 // fmv.w.x
          default: throw new Error(`unsupported float operation ${f7.toString(16)} at ${pc.toString(16)}`);
        }
        break;
      }
      case 0x0f: break;                                                            // fence
      case 0x73: {                                                                 // ecall: the host calls of prof.c
        if (ins !== 0x73) throw new Error(`unsupported system instruction at ${pc.toString(16)}`);
        const n = x[17], a0 = x[10], a1 = x[11], a2 = x[12];
        if (n === 93) return { blocks, exit: a0 };
        if (n === 1) {
          if (patch.length > a1) throw new Error('patch too big');
          mem.set(patch, a0 >>> 0);
          x[10] = patch.length;
        } else if (n === 3) {
          x[10] = evi < events.length ? events[evi++] : 0;
        } else if (n === 2) {
          if (a0 === 6) cur = { start: cycles, total: 0, nodes: new Map() };
          else if (a0 === 7) {
            cur.total = Math.round(cycles - cur.start);                            // (whole cycles: the float weights are not)
            blocks.push({ total: cur.total, nodes: cur.nodes });
            cur = null;
          } else if (cur && a0 <= 3) {
            const key = `${a1}/${a2}`;
            if (a0 > 0) {
              let e = cur.nodes.get(stageNode);
              if (!e) cur.nodes.set(stageNode, (e = { sum: 0, cv: 0, run: 0 }));
              e[a0 === 1 ? 'sum' : a0 === 2 ? 'cv' : 'run'] += Math.round(cycles - mark);
            }
            stageNode = key;
            mark = cycles;
          }
        } else throw new Error(`unknown host call ${n}`);
        break;
      }
      default:
        throw new Error(`unsupported opcode ${op.toString(16)} at ${pc.toString(16)}`);
    }
    if (hist) hist[pc >>> 2] += cycles - c0;
    pc = next;
  }
}

/** the profiling build, read once */
export const readElf = (path) => new Uint8Array(readFileSync(path));
