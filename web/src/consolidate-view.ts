// SPDX-License-Identifier: GPL-3.0-only
// Consolidate the FM-1's palette: the one confirmation that lists every change. Each palette entry that points at an
// extra slot holding a tweak of another slot's patch (an old Add to palette stored it as a whole patch) becomes a preset
// on that base slot, and the extra slot is freed when nothing else needs it. One row per change, each ticked; a Fold
// anyway row (the entry then takes the base slot's settings no device preset holds, each listed) starts unticked. Enter
// or Consolidate takes the ticked ones, Escape, Cancel or a press elsewhere takes none. A popover like every other
// (popover.ts, D-1423). The finding and the doing are palette.ts's; this file only asks.
import { closeFloat, openFloat } from './popover';

export interface ConsolidateStep {
  /** palette position 0..7 */
  pos: number;
  /** the extra slot the entry points at now (0-based slot) */
  from: { slot: number; name: string };
  /** the base slot it moves onto (0-based slot) */
  to: { slot: number; name: string };
  /** preset names the entry will name on `to` (new ones take the entry's name) */
  presets: string[];
  /** slot `from` is erased afterwards */
  free: boolean;
  /** why `from` is kept when !free: "palette 5 also uses it" / "it is in your bank list" */
  keep?: string;
  /** what the entry then plays from `to` instead of its own: "tempo", "patterns", "tempo and patterns" */
  plays?: string;
  /** Fold anyway (owner 2026-11-28): the settings no device preset holds that the entry takes from `to`, each as
   *  "Output level 1.00 → 0.39"; the row starts unticked */
  adopts?: string[];
  /** the effects in `to`'s FX drawers the entry's sound does not have: its preset switches them off, so it plays the
   *  same (a switched-off effect passes its input through); the row stays ticked */
  off?: string[];
}

/** "a", "a and b", "a, b and c" */
const list = (xs: readonly string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** the one line a step shows, e.g. "2 · HERA 6 PLUCKPAD → slot 23 · HERA 6 with preset Hera 6 pluckpad; slot 24 freed"
 *  (positions and slots shown 1-based, as on the FM-1); a kept slot is said by the step's own note in the dialog */
export function stepLine(s: ConsolidateStep): string {
  const presets = s.presets.length ? ` with preset${s.presets.length > 1 ? 's' : ''} ${list(s.presets)}` : '';
  return `${s.pos + 1} · ${s.from.name} → slot ${s.to.slot + 1} · ${s.to.name}${presets}${s.free ? `; slot ${s.from.slot + 1} freed` : ''}`;
}

/** one confirmation listing every step, each with a checkbox (ticked, a Fold anyway step's not), shown under `anchor`
 *  (the middle of the window without one); resolves the ticked steps in their order, or null on Cancel/Escape */
export function askConsolidate(steps: readonly ConsolidateStep[], o: { anchor?: HTMLElement | null } = {}): Promise<ConsolidateStep[] | null> {
  return new Promise((resolve) => {
    let answer: ConsolidateStep[] | null = null;
    const title = 'Consolidate the FM-1’s palette?';
    const form = document.createElement('form');
    form.className = 'consolidate';
    form.setAttribute('role', 'dialog');
    form.setAttribute('aria-label', title);
    const head = document.createElement('h3');
    head.className = 'consolidate-title';
    head.textContent = title;
    const text = document.createElement('p');
    text.className = 'consolidate-text';
    text.textContent = `Each entry below plays a patch stored as an extra slot. It becomes a preset on the slot it was made from, and the extra slot is freed. Untick what to leave as it is.${steps.some((s) => s.adopts) ? ' A Fold anyway entry differs from that slot in settings no preset holds: ticked, it takes the slot’s, as listed.' : ''}`;
    const rows = document.createElement('ul');
    rows.className = 'consolidate-steps';
    const boxes = steps.map((s) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'consolidate-step';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !s.adopts;
      const body = document.createElement('span');
      body.className = 'consolidate-body';
      const line = document.createElement('span');
      line.className = 'consolidate-line';
      line.textContent = stepLine(s);
      body.append(line);
      const kept = s.free ? null : `slot ${s.from.slot + 1} kept${s.keep ? `: ${s.keep}` : ''}`;
      const anyway = s.adopts ? `Fold anyway: it takes slot ${s.to.slot + 1}'s ${s.adopts.join('; ')}` : null;
      const off = s.off?.length ? `${list(s.off)} switched off (not in this sound)` : null;
      for (const note of [anyway, off, kept, s.plays ? `plays slot ${s.to.slot + 1}'s ${s.plays}` : null]) {
        if (!note) continue;
        const n = document.createElement('span');
        n.className = 'consolidate-note';
        n.textContent = note;
        body.append(n);
      }
      label.append(box, body);
      li.append(label);
      rows.append(li);
      return box;
    });
    const actions = document.createElement('div');
    actions.className = 'consolidate-actions';
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.className = 'primary';
    ok.textContent = 'Consolidate';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => closeFloat(true, form);
    actions.append(cancel, ok);
    const ticked = (): ConsolidateStep[] => steps.filter((_, i) => boxes[i].checked);
    const refresh = (): void => { ok.disabled = !ticked().length; };
    form.onchange = refresh;
    refresh();
    form.onsubmit = (e) => {
      e.preventDefault();
      if (ok.disabled) return;
      answer = ticked();
      closeFloat(true, form);
    };
    // Enter on a checkbox confirms too (a checkbox does not submit its form by itself); Enter on Cancel is Cancel's
    form.onkeydown = (e) => {
      if (e.key !== 'Enter' || e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      form.requestSubmit();
    };
    form.append(head, text, rows, actions);
    document.body.append(form);
    openFloat(form, { owner: form, anchor: o.anchor ?? null, back: o.anchor ?? undefined, onClose: () => resolve(answer) });
    const r = form.getBoundingClientRect();
    const a = o.anchor?.isConnected ? o.anchor.getBoundingClientRect() : null;
    const left = a ? a.right - r.width : (innerWidth - r.width) / 2;
    const top = a ? (a.bottom + 4 + r.height <= innerHeight - 8 ? a.bottom + 4 : a.top - 4 - r.height) : innerHeight / 4;
    Object.assign(form.style, { left: `${Math.max(8, Math.min(left, innerWidth - r.width - 8))}px`, top: `${Math.max(8, top)}px` });
    ok.focus();
  });
}
