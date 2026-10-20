// SPDX-License-Identifier: GPL-3.0-only
// The ARP button with nothing on it (design: ARP button edge cases): a click puts an Arpeggiator on it. The arpeggiator
// stays a module (layering, two per patch, its clk input); the button becomes its switching Toggle. When there is one
// sensible thing to do the click does it; otherwise the dock asks (arpChoices). The FM-1 runs at most DEVICE.arps.

import { assemblyOf } from './assembly';
import { kindOf, mainOf, setKind, setSwitches, setTarget, toggleTargets } from './buttons';
import { DEFS } from './modules';
import { addModule, connect, disconnect, type Cable, type ModuleInst, type Patch } from './patch';
import { DEVICE } from './patchbin';
import { polyGroups, spotNear } from './poly';

/** the patch's Arpeggiator modules, in patch order (the FM-1's GLO page shows the first) */
export const arpsOf = (p: Patch): ModuleInst[] => p.modules.filter((m) => m.type === 'arp');

/** ARP has nothing on it: no kind and no cable on its jack, or a Toggle whose target is gone */
export function arpFree(p: Patch): boolean {
  const main = mainOf(p);
  if (!main) return false;
  const kind = kindOf(main.panel, 'arp');
  if (kind === 'bypass') return toggleTargets(p, 'arp').length === 0;
  return kind === 'nothing' && !p.cables.some((c) => c.from.module === main.id && c.from.port === 'arp');
}

/** one thing a click on a free ARP can do */
export interface ArpChoice {
  label: string;
  /** what it means, under the label */
  sub: string;
  /** a row that cannot be taken, `sub` says why */
  disabled?: boolean;
  /** the keys cables it takes over (the dock glows them while the row is hovered) */
  cables: Cable[];
  /** do it; the arpeggiator now on ARP */
  apply: (p: Patch) => ModuleInst | null;
  /** the toast after it */
  done: string;
}

/** the keys cables out of a module */
const keysOut = (p: Patch, id: number): Cable[] => p.cables.filter((c) => c.from.module === id && c.from.port === 'keys');

/** a name for what a keys cable plays: the assembly its allocator sits in (the instrument), the poly assembly it drives,
 * or its type */
export function keysTargetName(p: Patch, id: number): string {
  const a = assemblyOf(p, id) ?? polyGroups(p).find((x) => x.alloc.id === id)?.asm;
  if (a) return a.label || a.name;
  const m = p.modules.find((x) => x.id === id);
  return m ? DEFS[m.type]?.label ?? m.type : 'nothing';
}

const list = (names: string[]): string => names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** make ARP the switching Toggle of an arpeggiator */
function putOnArp(p: Patch, arp: ModuleInst): ModuleInst {
  setKind(p, 'arp', 'bypass');
  setTarget(p, 'arp', { module: arp.id });
  setSwitches(p, 'arp', true);
  return arp;
}

/** route these keys cables out of an arpeggiator instead of where they come from now */
function through(p: Patch, arp: ModuleInst, cables: Cable[]): void {
  for (const c of cables) {
    disconnect(p, c);
    connect(p, DEFS, { module: arp.id, port: 'keys' }, c.to);
  }
}

/** a new Arpeggiator fed by Main's keys, taking over `cables` (keys cables out of Main) */
function insertFor(p: Patch, cables: Cable[]): ModuleInst | null {
  const main = mainOf(p);
  if (!main) return null;
  const near = cables.map((c) => p.modules.find((m) => m.id === c.to.module)!).filter(Boolean);
  const at = spotNear(p, near.length ? near : [main]);
  const arp = addModule(p, DEFS.arp, at.x, at.y);
  through(p, arp, cables);
  connect(p, DEFS, { module: main.id, port: 'keys' }, { module: arp.id, port: 'keys' });
  return arp;
}

/** a new Arpeggiator between Main's keys output and every input it fed; ARP becomes its Toggle (switching). Returns it, or
 * null without a Main module. */
export function insertArpeggiator(p: Patch): ModuleInst | null {
  const main = mainOf(p);
  if (!main) return null;
  const arp = insertFor(p, keysOut(p, main.id).filter((c) => p.modules.find((m) => m.id === c.to.module)?.type !== 'arp'));
  return arp && putOnArp(p, arp);
}

/**
 * What a click on a free ARP can do, in menu order. One enabled choice: the click does it. Rows: each arpeggiator already
 * in the patch (put it on ARP), a new one for what Main's keys play straight (all of it, or each one alone when they feed
 * several), and with an arpeggiator already there, routing what plays straight through it. Empty: no Main module.
 */
export function arpChoices(p: Patch): ArpChoice[] {
  const main = mainOf(p);
  if (!main) return [];
  const arps = arpsOf(p);
  const straight = keysOut(p, main.id).filter((c) => p.modules.find((m) => m.id === c.to.module)?.type !== 'arp');
  const names = straight.map((c) => keysTargetName(p, c.to.module));
  const out: ArpChoice[] = [];
  const index = (arp: ModuleInst): string => arps.length > 1 ? `Arp ${arps.indexOf(arp) + 1}` : 'the Arpeggiator';
  for (const arp of arps) {
    const plays = keysOut(p, arp.id).map((c) => keysTargetName(p, c.to.module));
    out.push({
      label: `Put ${index(arp)} on ARP`, sub: plays.length ? `it plays ${list(plays)}` : 'it plays nothing yet', cables: keysOut(p, arp.id),
      apply: (q) => { const a = q.modules.find((m) => m.id === arp.id); return a ? putOnArp(q, a) : null; },
      done: `ARP now switches ${index(arp)}`,
    });
  }
  const room = arps.length < DEVICE.arps;
  const fresh = (cables: Cable[], label: string, sub: string): ArpChoice => ({
    label, sub, cables, disabled: !room,
    apply: (q) => { const a = insertFor(q, cables); return a && putOnArp(q, a); },
    done: cables.length ? 'Arpeggiator added and put on ARP' : 'Arpeggiator added: patch its keys output into a voice allocator',
  });
  const full = `the FM-1 runs at most ${DEVICE.arps}`;
  if (!straight.length && !arps.length) out.push(fresh([], 'New arpeggiator', 'Main’s keys feed nothing yet'));
  else if (straight.length === 1) out.push(fresh(straight, `New arpeggiator for ${names[0]}`, room ? `between Main’s keys and ${names[0]}` : full));
  else if (straight.length > 1) {
    out.push(fresh(straight, `New arpeggiator for ${straight.length > 2 ? `all ${straight.length}` : 'both'}`, room ? `one arpeggiator plays ${list(names)}` : full));
    straight.forEach((c, i) => out.push(fresh([c], `New arpeggiator for ${names[i]} only`,
      room ? `${list(names.filter((_, j) => j !== i))} keep${straight.length > 2 ? '' : 's'} playing the keys straight` : full)));
  } else if (!room) out.push(fresh([], 'New arpeggiator', full));
  if (straight.length) for (const arp of arps) out.push({
    label: `${index(arp)[0].toUpperCase()}${index(arp).slice(1)} plays ${list(names)} too`, sub: `routes ${list(names)} through it, and puts it on ARP`,
    cables: straight,
    apply: (q) => {
      const a = q.modules.find((m) => m.id === arp.id);
      if (!a) return null;
      through(q, a, straight);
      return putOnArp(q, a);
    },
    done: `${list(names)} now play${straight.length > 1 ? '' : 's'} through ${index(arp)}, on ARP`,
  });
  return out;
}
