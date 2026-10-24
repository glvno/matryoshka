// SPDX-License-Identifier: GPL-3.0-only
// Sandbox mode (docs/ARCHITECTURE.md "Sandbox mode"): the editor's page in focus as the FM-1 draws it while the patch is a
// sandbox patch (protocol.ts SANDBOX, firmware/src/sandbox_ui.c). Pure: main.ts sends it when it changed.
import { DEFS } from './modules';
import { choiceName, formatValue } from './labels';
import { fm1PageTitle, PAGE_ROWS, type Device } from './pages';
import { toUnit, type Patch } from './patch';
import type { SandboxPage, SandboxRow } from './protocol';

/** a row of the page: its name, its value and unit as the dock's knob shows them, where it sits (0..1, choices evenly),
 *  and its choice count (a switch: 2; continuous: 0). null when the row is not there */
function sandboxRow(patch: Patch, r: Device['pages'][number]['rows'][number] | undefined): SandboxRow | null {
  const m = r && patch.modules.find((x) => x.id === r.module);
  const pd = m && DEFS[m.type]?.params.find((q) => q.name === r!.param);
  if (!r || !m || !pd) return null;
  const v = m.params[r.param] ?? pd.default;
  if (pd.choices) {
    const n = pd.choices.length;
    const i = Math.max(0, Math.min(n - 1, Math.round(v)));
    return { label: r.label, value: choiceName(m.type, pd.name, pd.choices[i] ?? ''), unit: '', pos: n > 1 ? i / (n - 1) : 0, steps: n };
  }
  if (pd.toggle) return { label: r.label, value: v >= 0.5 ? 'ON' : 'OFF', unit: '', pos: v >= 0.5 ? 1 : 0, steps: 2 };
  const f = formatValue(v, pd.unit, pd.min < 0);
  return { label: r.label, value: f.num, unit: f.unit, pos: toUnit(pd, v), steps: 0 };
}

/** the page in focus (`focus`, Editor.focus) of the patch's devices (Editor.devices), with the patch's name; a patch with
 *  no device page gives the name alone */
export function sandboxPage(patch: Patch, devices: Device[], focus: { device: string; page: number } | null): SandboxPage {
  const name = patch.name.trim() || 'Untitled';
  const dev = devices.find((d) => d.key === focus?.device);
  const pg = dev?.pages[focus?.page ?? 0];
  if (!dev || !pg) return { patch: name, device: '', page: '', index: 0, count: 0, rows: [null, null, null, null] };
  return {
    patch: name,
    device: dev.name,
    page: fm1PageTitle(dev.name, pg),
    index: dev.pages.indexOf(pg),
    count: dev.pages.length,
    rows: Array.from({ length: PAGE_ROWS }, (_, k) => sandboxRow(patch, pg.rows[k])),
  };
}

/** what tells two pages apart for sending: the page as the FM-1 gets it (positions to its 1/255) */
export const sandboxKey = (pg: SandboxPage): string =>
  JSON.stringify({ ...pg, rows: pg.rows.map((r) => (r ? { ...r, pos: Math.round(r.pos * 255) } : null)) });

/** SELECT (`select`) or ALGO turned `clicks` on the FM-1 in sandbox mode: the next focus, wrapping as the FM-1's own pages
 *  do (pages_ui.c pages_select / pages_page; SELECT opens a device on its first page). The editor moves its own focus, so
 *  the FM-1's page follows the browser's patch even where the firmware's copy in the FM-1 tab could not load it */
export function sandboxStep(devices: Device[], focus: { device: string; page: number } | null, select: boolean, clicks: number): { device: string; page: number } | null {
  if (!devices.length || !clicks) return null;
  const wrap = (i: number, n: number): number => ((i % n) + n) % n;
  const di = Math.max(0, devices.findIndex((d) => d.key === focus?.device));
  if (select) return { device: devices[wrap(di + clicks, devices.length)].key, page: 0 };
  const n = devices[di].pages.length;
  return n ? { device: devices[di].key, page: wrap((focus?.page ?? 0) + clicks, n) } : null;
}
