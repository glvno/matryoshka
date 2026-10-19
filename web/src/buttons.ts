// SPDX-License-Identifier: GPL-3.0-only
// What a patch button does (#116, designs E / F): one kind per button and patch. Nothing (unassigned: no implicit role),
// Gate (on while held or switched; patch its jack) or Toggle (bypasses a module or an assembly, the same bypass as a card's
// ⏻; on = the target bypassed). Every button keeps its jack: high while held or engaged. A patch from before #116 has no
// kinds: its buttons are Gates (behaviour unchanged); a new patch's start as Nothing (patch.ts NEW_PANEL).
// The kinds live in the Main module's panel (patch.ts MainPanel: `kinds`, `targets`); `toggle` there is the PRESS setting
// (switches instead of acting while held), kept from #60.

import { allModules, assembliesOf } from './assembly';
import { PANEL_BUTTONS } from './modules';
import type { MainPanel, ModuleInst, Patch } from './patch';

export type ButtonKind = 'nothing' | 'gate' | 'bypass';
/** the kinds as the editor names them (`bypass` is the Toggle of the designs) */
export const KIND_LABEL: Record<ButtonKind, string> = { nothing: 'Nothing', gate: 'Gate', bypass: 'Toggle' };
/** the binary's kind byte (patchbin.ts, flag bit 6): 0 Gate keeps a patch without the section unchanged */
export const KIND_CODE: Record<ButtonKind, number> = { gate: 0, nothing: 1, bypass: 2 };

export const mainOf = (p: Patch): ModuleInst | undefined => p.modules.find((m) => m.type === 'fm1');

/** what button b does in a Main module's panel (absent: Gate, a patch from before the kinds) */
export function kindOf(panel: MainPanel | undefined, b: string): ButtonKind {
  return panel?.kinds?.[b] ?? 'gate';
}

/** button b switches on / off (PRESS: switches) instead of acting while held; a button that does nothing never switches */
export function switches(panel: MainPanel | undefined, b: string): boolean {
  return kindOf(panel, b) !== 'nothing' && !!panel?.toggle?.includes(b);
}

/**
 * The modules a Toggle button bypasses (ids): its module, or the members of its assembly that the assembly's own switch
 * moves (not those bypassed on their own: while the assembly is on, the ones bypassed now; while it is off, the ones it
 * kept, assembly.ts bypassAssembly). Never Main or the Output. Empty for any other kind or a missing target.
 */
export function toggleTargets(p: Patch, b: string): number[] {
  const panel = mainOf(p)?.panel;
  const t = panel?.targets?.[b];
  if (kindOf(panel, b) !== 'bypass' || !t) return [];
  const ok = (id: number): boolean => { const m = p.modules.find((x) => x.id === id); return !!m && m.type !== 'fm1' && m.type !== 'output'; };
  if ('module' in t) return ok(t.module) ? [t.module] : [];
  const a = assembliesOf(p).find((x) => x.id === t.asm);
  if (!a) return [];
  const own = a.bypass ? new Set(a.kept ?? []) : new Set(p.modules.filter((m) => m.bypass).map((m) => m.id));
  return allModules(p, a).filter((id) => ok(id) && !own.has(id));
}

/** a Toggle button is engaged while every module it bypasses is bypassed (and it has some) */
export function toggleEngaged(p: Patch, b: string): boolean {
  const ids = toggleTargets(p, b);
  return ids.length > 0 && ids.every((id) => !!p.modules.find((m) => m.id === id)?.bypass);
}

/** a button's LED (and the dock face's light): dark = unassigned and uncabled, dim = assigned or cabled, lit = engaged */
export function buttonLight(p: Patch, b: string, engaged: boolean): 'dark' | 'dim' | 'lit' {
  if (engaged) return 'lit';
  const main = mainOf(p);
  const cabled = !!main && p.cables.some((c) => c.from.module === main.id && c.from.port === b);
  return kindOf(main?.panel, b) !== 'nothing' || cabled ? 'dim' : 'dark';
}

/** the patch buttons a Toggle may name: every button but GLO (#118: it is Main's global page) */
export const EDITABLE_BUTTONS = PANEL_BUTTONS.filter((b) => b !== 'glo');

// ---- the button editor's edits (button-editor.ts): each keeps the panel valid (patch.ts fixPanel's rules)

const panelOf = (p: Patch): MainPanel | undefined => {
  const main = mainOf(p);
  return main ? (main.panel ??= {}) : undefined;
};
const tidy = (p: Patch): void => {
  const main = mainOf(p);
  const panel = main?.panel;
  if (!main || !panel) return;
  for (const k of ['toggle', 'on'] as const) if (panel[k] && !panel[k]!.length) delete panel[k];
  for (const k of ['kinds', 'targets', 'labels'] as const) if (panel[k] && !Object.keys(panel[k]!).length) delete panel[k];
  if (!Object.keys(panel).length) delete main.panel;
};

/** what button b does; Nothing also drops its PRESS and switched state, any change but to Toggle its target */
export function setKind(p: Patch, b: string, kind: ButtonKind): void {
  const panel = panelOf(p);
  if (!panel) return;
  const kinds = { ...(panel.kinds ?? {}) };
  if (kind === 'gate') delete kinds[b];
  else kinds[b] = kind;
  panel.kinds = kinds;
  if (kind !== 'bypass' && panel.targets) delete panel.targets[b];
  if (kind === 'nothing') {
    panel.toggle = (panel.toggle ?? []).filter((x) => x !== b);
    panel.on = (panel.on ?? []).filter((x) => x !== b);
  }
  if (kind === 'bypass') panel.on = (panel.on ?? []).filter((x) => x !== b);   // (a Toggle's state is its target's bypass)
  tidy(p);
}

/** a Toggle's target: a module or an assembly, or none */
export function setTarget(p: Patch, b: string, t: { module: number } | { asm: number } | null): void {
  const panel = panelOf(p);
  if (!panel || kindOf(panel, b) !== 'bypass') return;
  const targets = { ...(panel.targets ?? {}) };
  if (t) targets[b] = t;
  else delete targets[b];
  panel.targets = targets;
  tidy(p);
}

/** PRESS: the button switches on / off (true) or acts while held */
export function setSwitches(p: Patch, b: string, on: boolean): void {
  const panel = panelOf(p);
  if (!panel || kindOf(panel, b) === 'nothing') return;
  panel.toggle = on ? [...new Set([...(panel.toggle ?? []), b])] : (panel.toggle ?? []).filter((x) => x !== b);
  if (!on) panel.on = (panel.on ?? []).filter((x) => x !== b);
  tidy(p);
}
