// SPDX-License-Identifier: GPL-3.0-only
// Patches from before the device pages: the Main module had six knob outputs k1..k6 you could cable anywhere (K1..K4 and
// the SELECT / ALGO encoders as K5 / K6). Now the knobs edit the device page in focus (pages.ts), so a patch that cabled a
// knob gets a "Macros" assembly instead: one Macro module per knob it used, at the knob's position, cabled where the knob
// was, its value promoted onto the card under the knob's label. That card is the first device (the top left of the
// canvas), so the FM-1 opens on the same four controls as before.
import { assembliesOf, GRID, makeAssembly, moveAssembly, parentOf } from './assembly';
import { addModule, type ModuleDef, type Patch } from './patch';

const KNOB = /^k[1-6]$/;

/** convert a patch's knob cables in place (validatePatch, before it checks the cables); `labels` = the Main panel's old
 * knob labels. Returns whether there was anything to convert. */
export function migrateKnobs(p: Patch, defs: Record<string, ModuleDef>, labels: Record<string, unknown> = {}): boolean {
  const main = p.modules.find((m) => m.type === 'fm1');
  const values: Record<string, number> = {};
  for (const m of p.modules) if (m.type === 'fm1') for (const k of Object.keys(m.params)) if (KNOB.test(k)) {
    if (m === main) values[k] = Number(m.params[k]);
    delete m.params[k];
  }
  const isKnobCable = (c: Patch['cables'][number]): boolean => KNOB.test(c.from?.port ?? '') && p.modules.find((m) => m.id === c.from?.module)?.type === 'fm1';
  const cables = p.cables.filter(isKnobCable);
  if (!cables.length) return false;
  const used = [...new Set(cables.map((c) => c.from.port))].sort();
  // room at the top left: everything moves one card column to the right when something is there
  const inAsm = new Set(assembliesOf(p).flatMap((a) => a.modules));
  const left = GRID.margin + GRID.x;
  const taken = p.modules.some((m) => m.type !== 'fm1' && !inAsm.has(m.id) && m.x < left) || assembliesOf(p).some((a) => !parentOf(p, a.id) && a.x < left);
  if (taken) {
    for (const m of p.modules) if (!inAsm.has(m.id) && m.type !== 'fm1') m.x += GRID.x;
    for (const a of assembliesOf(p)) if (!parentOf(p, a.id)) moveAssembly(p, a, GRID.x, 0);
  }
  const macros = used.map((k, i) => {
    const m = addModule(p, defs.macro, GRID.margin, GRID.margin + i * 120);
    const v = values[k];
    m.params.value = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
    for (const c of cables) if (c.from.port === k) c.from = { module: m.id, port: 'out' };
    return { k, m };
  });
  const a = makeAssembly(p, macros.map((x) => x.m.id), 'Macros');
  a.x = GRID.margin;
  a.y = GRID.margin;
  a.params = macros.map(({ k, m }) => {
    const label = String(labels[k] ?? '').trim().toLowerCase();
    return { module: m.id, param: 'value', label: label || k.toUpperCase() };
  });
  return true;
}
