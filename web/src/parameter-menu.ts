// SPDX-License-Identifier: GPL-3.0-only
import { positionPopover } from './popover';
import { canSeparate, isPin, parameterInputs, pinRoutes, removeRoute, separateDepth, setInputRoute } from './parameter-routing';
import { DEPTH_MAX, isBipolar, paramValue, rangeOf, type Cable, type ModuleDef, type ModuleInst, type ParamDef, type Patch, type Range } from './patch';
import { DEFS } from './modules';
import { choiceName, longName, moduleName } from './labels';
import { depthScale, depthText, parseDepth, storedDepth } from './depth';
import { outputRange } from './ranges';

interface Events {
  patch(): Patch;
  change(fn: () => void): void;
  /** a control is about to change the patch: one undo step per gesture (Editor.touch) */
  touch?(): void;
  onAtt(id: number, index: number, value: number): void;
  onRange(id: number, index: number, name: string, range: Range | null): void;
}

/** does the cable's source swing both ways (its output range, ranges.ts, starts below 0: an LFO's −1..1)? A macro range
 * made on it reads its −1..1 across the two ends (#526) */
export function swingsBoth(p: Patch, c: Cable): boolean {
  const m = p.modules.find((x) => x.id === c.from.module);
  return !!m && /^[^0-9−-]*[−-]\d*\.?\d+(e[+-]?\d+)?\.\./.test(outputRange(m.type, c.from.port, m.params));
}

const sourceName = (p: Patch, c: Cable): string => {
  const m = p.modules.find((x) => x.id === c.from.module);
  return m ? `${moduleName(m.type, DEFS[m.type].label)} ${longName(m.type, c.from.port)}` : c.from.port;
};

/**
 * Routing controls live with their destination: what modulates this parameter (each source with its depth or range),
 * and the module's own inputs routed to it. The saved matrix remains compatible with the FM-1.
 */
export function parameterMenu(m: ModuleInst, def: ModuleDef, pd: ParamDef, ev: Events, open: boolean, onToggle: (open: boolean) => void): HTMLElement {
  const menu = document.createElement('details');
  menu.className = 'parameter-routing';
  menu.addEventListener('keydown', (e) => {
    if (!menu.open && ![' ', 'Enter', 'Tab'].includes(e.key)) return;
    if (e.key === 'Escape') { menu.open = false; summary.focus(); }
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  });
  menu.open = open;
  const refreshers: (() => void)[] = [];
  menu.ontoggle = () => {
    if (!menu.isConnected) return;
    if (menu.open) {
      for (const refresh of refreshers) refresh();
      content.showPopover();
      positionPopover(content, summary);
    } else if (content.matches(':popover-open')) content.hidePopover();
    onToggle(menu.open);
  };
  const label = longName(def.type, pd.name);
  const summary = document.createElement('summary');
  summary.textContent = '⋮';
  summary.title = `${def.label} ${label}: modulation`;
  summary.setAttribute('aria-label', summary.title);
  const content = document.createElement('div');
  content.className = 'routing-controls';
  content.popover = 'auto';
  content.addEventListener('toggle', () => {
    if (!content.matches(':popover-open') && menu.isConnected) menu.open = false;
  });
  const hint = (text: string): void => {
    const p = document.createElement('p');
    p.textContent = text;
    content.append(p);
  };
  const heading = (text: string): void => {
    const h = document.createElement('h4');
    h.textContent = text;
    content.append(h);
  };
  const p = ev.patch();
  const target = pd.toggle || pd.choices ? 'jack' : 'thumb';
  hint(`Drop a cable on the ${target} to modulate ${label}, with its own depth. ${def.label} takes up to two different sources.`
    + (pd.input ? ` The ${longName(def.type, pd.input)} jack is ${label}'s built-in input.` : ''));

  // what modulates it: the cables into the pins routed to this parameter
  const routes = pinRoutes(p, m, pd.name);
  if (routes.length) heading('Modulated by');
  for (const { cable, pin, index, shared } of routes) {
    const group = document.createElement('div');
    group.className = 'routing-source';
    const head = document.createElement('div');
    head.className = 'routing-head';
    const name = document.createElement('strong');
    name.textContent = sourceName(p, cable);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'sm';
    remove.textContent = 'Remove';
    remove.title = `Stop ${name.textContent} modulating ${label}`;
    remove.onclick = () => ev.change(() => removeRoute(ev.patch(), cable, pd.name));
    head.append(name, remove);
    group.append(head);
    const r = rangeOf(m, pin, pd.name);
    {
      const depthLabel = document.createElement('label');
      depthLabel.textContent = shared.length ? `Depth, shared with ${shared.map((n) => longName(def.type, n)).join(', ')}` : 'Depth';
      // the depth reads in the parameter's units (#526): the slider moves in hundredths of the range, a typed value
      // (a fraction too: "1/8 oct") is kept as typed, on the binary's Q16 grid
      const depth = document.createElement('input');
      depth.type = 'range'; depth.min = String(-DEPTH_MAX); depth.max = String(DEPTH_MAX); depth.step = '.01';
      depth.value = String(m.att![index]);
      depth.setAttribute('aria-label', `${def.label} ${label}: depth of ${name.textContent}`);
      const value = document.createElement('input');
      value.type = 'text';
      value.className = 'depth-value';
      value.size = 9;
      value.value = depthText(pd, m.att![index]);
      const { unit } = depthScale(pd);
      value.title = `Type a depth${unit ? ` in ${unit === '%' ? '% of the slider' : unit}` : ''}, or a fraction like 1/8. Up to ${DEPTH_MAX} times the range either way.`;
      value.setAttribute('aria-label', `${def.label} ${label}: depth of ${name.textContent}, typed`);
      const set = (att: number): void => {
        ev.touch?.();
        m.att![index] = att;
        depth.value = String(att);
        value.value = depthText(pd, att);
        ev.onAtt(m.id, index, att);
      };
      refreshers.push(() => { depth.value = String(m.att![index]); value.value = depthText(pd, m.att![index]); });
      depth.oninput = () => set(storedDepth(Number(depth.value)));
      value.onchange = () => {
        const att = parseDepth(value.value, pd);
        if (att === null) value.value = depthText(pd, m.att![index]);
        else set(att);
      };
      value.onkeydown = (e) => { if (e.key === 'Enter') value.blur(); };
      depthLabel.append(depth, value);
      group.append(depthLabel);
      if (shared.length && canSeparate(p, m, pd.name)) {
        const split = document.createElement('button');
        split.type = 'button';
        split.className = 'sm';
        split.textContent = 'Separate depth';
        split.title = `Give ${label} its own depth for ${name.textContent} (uses ${def.label}'s second modulation input)`;
        split.onclick = () => ev.change(() => separateDepth(ev.patch(), DEFS, m, pd.name));
        group.append(split);
      }
    }
    const rangeLabel = document.createElement('label');
    const range = document.createElement('input'); range.type = 'checkbox'; range.checked = !!r;
    range.setAttribute('aria-label', `${def.label}: ${name.textContent} plays ${label} between two values`);
    range.onchange = () => ev.change(() => {
      // a source that swings both ways (an LFO) maps its whole swing between the ends (#526)
      if (range.checked) ((m.range ??= {})[pin] ??= {})[pd.name] = swingsBoth(ev.patch(), cable) ? [0, 1, 1] : [0, 1];
      else delete m.range?.[pin]?.[pd.name];
    });
    rangeLabel.append(range, 'Play between two values');
    group.append(rangeLabel);
    if (r) {
      const biLabel = document.createElement('label');
      const bi = document.createElement('input'); bi.type = 'checkbox'; bi.checked = isBipolar(r);
      bi.setAttribute('aria-label', `${def.label}: ${name.textContent} on ${label} swings −1..1`);
      biLabel.title = 'On: the source\'s −1..1 spans From..To (an LFO). Off: its 0..1 does (an envelope, a knob). Set from the source when the range is made.';
      bi.onchange = () => ev.change(() => {
        const now = rangeOf(m, pin, pd.name);
        if (now) m.range![pin]![pd.name] = bi.checked ? [now[0], now[1], 1] : [now[0], now[1]];
      });
      biLabel.append(bi, 'Source swings −1..1');
      group.append(biLabel);
    }
    if (r) for (const end of [0, 1] as const) {
      const row = document.createElement('label');
      row.textContent = end ? 'To' : 'From';
      const input = document.createElement('input');
      input.type = 'range'; input.min = '0'; input.max = '1'; input.step = '.01'; input.value = String(r[end]);
      input.setAttribute('aria-label', `${def.label}: ${name.textContent} on ${label}, ${end ? 'high' : 'low'} end`);
      const output = document.createElement('output');
      const show = (): void => {
        const v = paramValue(pd, r[end]);
        output.textContent = pd.choices ? choiceName(def.type, pd.name, pd.choices[Math.round(v)] ?? '') : `${Number(v.toFixed(3))}${pd.unit ? ' ' + pd.unit : ''}`;
      };
      input.oninput = () => {
        ev.touch?.();
        r[end] = Number(input.value);
        show();
        ev.onRange(m.id, index, pd.name, r);
      };
      show(); row.append(input, output); group.append(row);
    }
    content.append(group);
  }
  // the dedicated input's cables (built in: no depth here)
  if (pd.input) for (const c of p.cables.filter((c) => c.to.module === m.id && c.to.port === pd.input)) hint(`${sourceName(p, c)} → ${longName(def.type, pd.input)} (built in)`);

  // the module's own inputs feeding this parameter as well
  const own = def.inputs.filter((q) => !isPin(q.name));
  if (own.length) heading(`${def.label}'s inputs`);
  for (const port of own) {
    const row = document.createElement('label');
    const box = document.createElement('input'); box.type = 'checkbox';
    box.checked = parameterInputs(m, pd).includes(port.name);
    box.disabled = port.name === pd.input;
    box.setAttribute('aria-label', `${def.label}: ${longName(def.type, port.name)} input controls ${label}`);
    box.onchange = () => ev.change(() => setInputRoute(m, def, port.name, pd.name, box.checked));
    row.append(box, `${longName(def.type, port.name)} → ${label}${port.name === pd.input ? ' (built in)' : ''}`);
    content.append(row);
  }

  menu.append(summary, content);
  return menu;
}
