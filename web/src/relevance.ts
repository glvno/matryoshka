// SPDX-License-Identifier: GPL-3.0-only
// Parameters that do nothing in the module's current setting (#97): pulse width on a wave that is not square, detune
// with one copy. The editor dims such a row and takes no direct edits on it. Every rule here was checked against both
// engines (modules.ts and engine.c): while its condition is false the parameter changes none of the module's outputs.
// The engines test the condition on the effective (modulated) values, so a rule only locks while none of the
// parameters it reads is modulated; a cable that reaches one of them leaves the row live. No DOM.
import type { ModuleInst, ParamDef, Patch } from './patch';
import { parameterInputs } from './parameter-routing';
import { PD_RESO } from './modules';

interface Ctx {
  /** a parameter's base value */
  p(name: string): number;
  /** an input jack has a cable */
  cabled(port: string): boolean;
}
interface Rule {
  type: string;
  /** the parameters the rule may lock */
  params: string[];
  /** the parameters its condition reads (modulating any of them keeps the row live) */
  reads: string[];
  /** true while the parameters matter */
  live(c: Ctx): boolean;
  /** why the row is locked, for its tooltip */
  why: string;
}

/** the oscillator runs its FM path (feedback, or the pm input patched with an index): unison and stack are off there */
const fm = (c: Ctx): boolean => c.p('fb') > 0 || (c.cabled('pm') && c.p('pm') > 0);
const STACK_OCT_FIFTH = 3; // STACK_NAMES '+oct+5th': three copies
const SEQ_STEPS = [2, 3, 4, 5, 6, 7, 8];

export const RULES: Rule[] = [
  { type: 'osc', params: ['pw'], reads: ['wave'], live: (c) => c.p('wave') === 3, why: 'Only the square wave has a pulse width.' },
  { type: 'osc', params: ['unison', 'stack'], reads: ['fb', 'pm'], live: (c) => !fm(c), why: 'Unison and stack are off while the oscillator runs FM (feedback, or a patched pm input).' },
  { type: 'osc', params: ['detune'], reads: ['unison', 'stack', 'fb', 'pm'], live: (c) => !fm(c) && (c.p('unison') >= 2 || c.p('stack') !== 0), why: 'Detune needs more than one copy: unison 2 or more, or a stack.' },
  { type: 'osc', params: ['blend'], reads: ['unison', 'stack', 'fb', 'pm'], live: (c) => !fm(c) && (c.p('unison') >= 3 || c.p('stack') === STACK_OCT_FIFTH), why: 'Blend needs three copies or more: unison 3 or more, or the +oct+5th stack.' },
  { type: 'osc', params: ['pm'], reads: [], live: (c) => c.cabled('pm'), why: 'Patch the pm input to use the modulation index.' },
  { type: 'wavetable', params: ['pm'], reads: [], live: (c) => c.cabled('pm'), why: 'Patch the pm input to use the modulation index.' },
  { type: 'pd', params: ['pm'], reads: [], live: (c) => c.cabled('pm'), why: 'Patch the pm input to use the modulation index.' },
  { type: 'pd', params: ['range'], reads: ['wave', 'wave2'], live: (c) => Math.round(c.p('wave')) >= PD_RESO || Math.round(c.p('wave2')) > PD_RESO, why: 'Range raises only the resonance waveforms (reso 1, 2, 3).' },
  { type: 'lfo', params: ['rate', 'range'], reads: ['sync'], live: (c) => c.p('sync') < 0.5, why: 'While synced the division sets the rate.' },
  { type: 'lfo', params: ['div', 'bpm', 'mult'], reads: ['sync'], live: (c) => c.p('sync') >= 0.5, why: 'Only used while the LFO is synced.' },
  { type: 'delay', params: ['note'], reads: ['sync'], live: (c) => c.p('sync') >= 0.5, why: 'The note lengths are for the synced delay.' },
  { type: 'reverb', params: ['size', 'damp'], reads: ['freeze'], live: (c) => c.p('freeze') < 0.5, why: 'While frozen the tail neither decays nor darkens.' },
  { type: 'adsr', params: ['d'], reads: ['s'], live: (c) => c.p('s') < 1, why: 'With the sustain at full the decay has nowhere to go.' },
  { type: 'dyn', params: ['thresh'], reads: ['ratio'], live: (c) => c.p('ratio') > 1, why: 'A ratio of 1 compresses nothing.' },
  { type: 'comb', params: ['coarse', 'damp'], reads: ['fb'], live: (c) => c.p('fb') !== 0, why: 'Without feedback the comb passes its input straight through.' },
  { type: 'chorus', params: ['rate'], reads: ['depth'], live: (c) => c.p('depth') > 0, why: 'With no depth there is no sweep.' },
  { type: 'phaser', params: ['rate'], reads: ['depth'], live: (c) => c.p('depth') > 0, why: 'With no depth there is no sweep.' },
  { type: 'random', params: ['rate'], reads: ['mode'], live: (c) => c.p('mode') >= 0.5, why: 'A fixed value does not move.' },
  ...SEQ_STEPS.map((k): Rule => ({ type: 'seq', params: [`s${k}`], reads: ['len'], live: (c) => c.p('len') >= k, why: `Beyond the sequence's length: raise len to ${k} or more.` })),
  ...SEQ_STEPS.map((k): Rule => ({ type: 'env8', params: [`l${k}`, `r${k}`], reads: ['end'], live: (c) => c.p('end') >= k, why: `After the end step: raise end to ${k} or more.` })),
  { type: 'seq', params: ['dir'], reads: ['len'], live: (c) => c.p('len') >= 2, why: 'A one-step sequence has no direction.' },
  { type: 'quant', params: ['root'], reads: ['scale'], live: (c) => c.p('scale') !== 0, why: 'The chromatic scale has every note: a root changes nothing.' },
  ...['filter', 'ladder', 'shift'].map((type): Rule => ({ type, params: ['cvamt'], reads: [], live: (c) => c.cabled('cv'), why: 'Patch the cv input to use its amount.' })),
  { type: 'string', params: ['burst'], reads: [], live: (c) => c.cabled('gate'), why: 'A burst fires on a gate: patch the gate input.' },
];

const cabledInto = (p: Patch, id: number, port: string): boolean => p.cables.some((c) => c.to.module === id && c.to.port === port);

/** a parameter moves while playing: a cable reaches it (its own input, a pin, a side input), or the morph B side differs */
export function modulated(p: Patch, m: ModuleInst, pd: ParamDef): boolean {
  if (parameterInputs(m, pd).some((port) => cabledInto(p, m.id, port))) return true;
  const b = m.paramsB?.[pd.name];
  return b !== undefined && b !== m.params[pd.name];
}

/** why `param` of `m` is locked right now, or null when it matters (or might, because its condition is modulated) */
export function lockOf(p: Patch, m: ModuleInst, params: ParamDef[], param: string): string | null {
  const byName = new Map(params.map((pd) => [pd.name, pd]));
  const ctx: Ctx = {
    p: (name) => m.params[name] ?? byName.get(name)?.default ?? 0,
    cabled: (port) => cabledInto(p, m.id, port),
  };
  for (const r of RULES) {
    if (r.type !== m.type || !r.params.includes(param)) continue;
    if (r.reads.some((name) => { const pd = byName.get(name); return !!pd && modulated(p, m, pd); })) continue;
    if (!r.live(ctx)) return r.why;
  }
  return null;
}
