// SPDX-License-Identifier: GPL-3.0-only
// The ARP button with nothing on it (design: ARP button edge cases): a click puts an Arpeggiator on it. The arpeggiator
// stays a module (layering, two per patch, its clk input); the button becomes its switching Toggle. When there is one
// sensible thing to do the click does it; otherwise the dock asks (arpChoices). The FM-1 runs at most DEVICE.arps.

import { deviceOfModule } from './arm';
import { assemblyOf } from './assembly';
import { kindOf, litWhileEnabled, mainOf, setKind, setSwitches, setTarget, toggleTargets } from './buttons';
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

/** ARP shows no jack while it is the Toggle of an Arpeggiator: nothing is wired from it then (owner 2026-11-23). A cable
 * already on the jack (an older patch) keeps it, and it keeps working */
export function arpJackless(p: Patch): boolean {
  const main = mainOf(p);
  return !!main && litWhileEnabled(p, 'arp') && !p.cables.some((c) => c.from.module === main.id && c.from.port === 'arp');
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

/** Insert after note generation/recording, so ARP receives the chord and never feeds a track. */
function straightKeys(p: Patch, id: number, seen = new Set<number>()): Cable[] {
  if (seen.has(id)) return [];
  seen.add(id);
  return keysOut(p, id).flatMap(c => {
    const type = p.modules.find(m => m.id === c.to.module)?.type;
    return type === 'arp' ? [] : type === 'harm' || type === 'steps' ? straightKeys(p, c.to.module, seen) : [c];
  });
}

/** where Main's keys route stops short: Main, a Harmonizer or a Steps track on it whose keys output feeds nothing (what
 * taking an Arpeggiator out of the route leaves behind) */
function looseEnds(p: Patch, id: number, seen = new Set<number>()): number[] {
  if (seen.has(id)) return [];
  seen.add(id);
  const out = keysOut(p, id);
  if (!out.length) return [id];
  return out.flatMap((c) => {
    const type = p.modules.find((m) => m.id === c.to.module)?.type;
    return type === 'harm' || type === 'steps' ? looseEnds(p, c.to.module, seen) : [];
  });
}

/** The keys cables a new arpeggiator takes over: those Main's keys play straight; with none, the cables Main's route would
 * need from its one loose end into every Voicing and Drum map no keys cable reaches (not in the patch yet: the arpeggiator
 * takes the place of one taken out, after the Harmonizer and Steps, D-783) */
function keysToTake(p: Patch, main: number): Cable[] {
  const straight = straightKeys(p, main);
  if (straight.length) return straight;
  const ends = looseEnds(p, main);
  if (ends.length !== 1) return [];
  return p.modules
    .filter((m) => (m.type === 'alloc' || m.type === 'drummap') && !p.cables.some((c) => c.to.module === m.id && c.to.port === 'keys'))
    .map((m) => ({ from: { module: ends[0], port: 'keys' }, to: { module: m.id, port: 'keys' } }));
}

/** a name for what a keys cable plays: the assembly its allocator sits in (the instrument), the poly assembly it drives,
 * or its type */
export function keysTargetName(p: Patch, id: number): string {
  const a = assemblyOf(p, id) ?? polyGroups(p).find((x) => x.alloc.id === id)?.asm;
  if (a) return a.label || a.name;
  const m = p.modules.find((x) => x.id === id);
  return m ? DEFS[m.type]?.label ?? m.type : 'nothing';
}

/** what these keys cables play, one entry per instrument: the cables from one source into one device (a poly instrument's
 * Voicings, a kit's Drum maps) are one instrument, not one per cable */
function instruments(p: Patch, cables: Cable[]): { name: string; cables: Cable[] }[] {
  const out = new Map<string, { name: string; cables: Cable[] }>();
  for (const c of cables) {
    const key = `${c.from.module} ${deviceOfModule(p, c.to.module)}`;
    const known = out.get(key);
    if (known) known.cables.push(c);
    else out.set(key, { name: keysTargetName(p, c.to.module), cables: [c] });
  }
  return [...out.values()];
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
  if (!main || new Set(cables.map(c => c.from.module)).size > 1) return null;
  const feed = cables[0]?.from.module ?? main.id;
  const near = cables.map((c) => p.modules.find((m) => m.id === c.to.module)!).filter(Boolean);
  const at = spotNear(p, near.length ? near : [main]);
  const arp = addModule(p, DEFS.arp, at.x, at.y);
  through(p, arp, cables);
  connect(p, DEFS, { module: feed, port: 'keys' }, { module: arp.id, port: 'keys' });
  return arp;
}

/** a new Arpeggiator between Main's keys route and every input it fed (or, with an arpeggiator taken out, the inputs it
 * played: keysToTake); ARP becomes its Toggle (switching). Returns it, or null without a Main module. */
export function insertArpeggiator(p: Patch): ModuleInst | null {
  const main = mainOf(p);
  if (!main) return null;
  const arp = insertFor(p, keysToTake(p, main.id));
  return arp && putOnArp(p, arp);
}

/**
 * What a click on a free ARP can do, in menu order. One enabled choice: the click does it. Rows: each arpeggiator already
 * in the patch (put it on ARP), a new one for what Main's keys play straight (all of it, or each instrument alone when they
 * feed several), and with an arpeggiator already there, routing what plays straight through it. Empty: no Main module.
 */
export function arpChoices(p: Patch): ArpChoice[] {
  const main = mainOf(p);
  if (!main) return [];
  const arps = arpsOf(p);
  const straight = keysToTake(p, main.id);
  const targets = instruments(p, straight);
  const names = targets.map((t) => t.name);
  const from = (c: Cable): string => {
    const m = p.modules.find((x) => x.id === c.from.module);
    return !m || m === main ? 'Main’s keys' : m.name ?? `the ${DEFS[m.type]?.label ?? m.type}`;
  };
  const out: ArpChoice[] = [];
  const index = (arp: ModuleInst): string => arps.length > 1 ? `Arp ${arps.indexOf(arp) + 1}` : 'the Arpeggiator';
  for (const arp of arps) {
    const plays = instruments(p, keysOut(p, arp.id)).map((t) => t.name);
    out.push({
      label: `Put ${index(arp)} on ARP`, sub: plays.length ? `it plays ${list(plays)}` : 'it plays nothing yet', cables: keysOut(p, arp.id),
      apply: (q) => { const a = q.modules.find((m) => m.id === arp.id); return a ? putOnArp(q, a) : null; },
      done: `ARP now switches ${index(arp)}`,
    });
  }
  const room = arps.length < DEVICE.arps;
  const fresh = (cables: Cable[], label: string, sub: string): ArpChoice => ({
    label, sub: new Set(cables.map(c => c.from.module)).size > 1 ? 'These instruments have different note sources. Choose one below.' : sub, cables, disabled: !room || new Set(cables.map(c => c.from.module)).size > 1,
    apply: (q) => { const a = insertFor(q, cables); return a && putOnArp(q, a); },
    done: cables.length ? 'Arpeggiator added and put on ARP' : 'Arpeggiator added: patch its keys output into a voice allocator',
  });
  const full = `the FM-1 runs at most ${DEVICE.arps}`;
  if (!straight.length && !arps.length) out.push(fresh([], 'New arpeggiator', 'Main’s keys feed nothing yet'));
  else if (targets.length === 1) out.push(fresh(straight, `New arpeggiator for ${names[0]}`, room ? `between ${from(straight[0])} and ${names[0]}` : full));
  else if (targets.length > 1) {
    out.push(fresh(straight, `New arpeggiator for ${targets.length > 2 ? `all ${targets.length}` : 'both'}`, room ? `one arpeggiator plays ${list(names)}` : full));
    targets.forEach((t, i) => out.push(fresh(t.cables, `New arpeggiator for ${t.name} only`,
      room ? `${list(names.filter((_, j) => j !== i))} keep${targets.length > 2 ? '' : 's'} playing the keys straight` : full)));
  } else if (!room) out.push(fresh([], 'New arpeggiator', full));
  if (straight.length) for (const arp of arps.filter(a => straight.every(c => p.cables.some(x => x.to.module === a.id && x.to.port === 'keys' && x.from.module === c.from.module)))) out.push({
    label: `${index(arp)[0].toUpperCase()}${index(arp).slice(1)} plays ${list(names)} too`, sub: `routes ${list(names)} through it, and puts it on ARP`,
    cables: straight,
    apply: (q) => {
      const a = q.modules.find((m) => m.id === arp.id);
      if (!a) return null;
      through(q, a, straight);
      return putOnArp(q, a);
    },
    done: `${list(names)} now play${targets.length > 1 ? '' : 's'} through ${index(arp)}, on ARP`,
  });
  return out;
}
