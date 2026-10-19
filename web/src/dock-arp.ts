// SPDX-License-Identifier: GPL-3.0-only
// The Arpeggiator on Main's dock (#119, design G): the arpeggiator stays a module (layering, two per patch, its clk
// input); the dock shows the first one's controls. "+ Add arpeggiator" puts one between Main's keys and what they fed
// (the voice allocator) and makes ARP its Toggle: an explicit patch setting, not a default.

import { setKind, setSwitches, setTarget } from './buttons';
import { DEFS } from './modules';
import { addModule, connect, disconnect, type ModuleInst, type Patch } from './patch';
import { spotNear } from './poly';

/** the patch's Arpeggiator modules, in patch order (the FM-1's GLO page and the dock show the first) */
export const arpsOf = (p: Patch): ModuleInst[] => p.modules.filter((m) => m.type === 'arp');

/** a new Arpeggiator between Main's keys output and every input it fed; ARP becomes its Toggle (switching). Returns it, or
 * null without a Main module. */
export function insertArpeggiator(p: Patch): ModuleInst | null {
  const main = p.modules.find((m) => m.type === 'fm1');
  if (!main) return null;
  const fed = p.cables.filter((c) => c.from.module === main.id && c.from.port === 'keys');
  const near = fed.map((c) => p.modules.find((m) => m.id === c.to.module)!).filter(Boolean);
  const at = spotNear(p, near.length ? near : [main]);
  const arp = addModule(p, DEFS.arp, at.x, at.y);
  for (const c of fed) {
    disconnect(p, c);
    connect(p, DEFS, { module: arp.id, port: 'keys' }, c.to);
  }
  connect(p, DEFS, { module: main.id, port: 'keys' }, { module: arp.id, port: 'keys' });
  setKind(p, 'arp', 'bypass');
  setTarget(p, 'arp', { module: arp.id });
  setSwitches(p, 'arp', true);
  return arp;
}
