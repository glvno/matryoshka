// SPDX-License-Identifier: GPL-3.0-only
import type { Cable, ModuleInst, Patch } from './patch';

const transforms = new Set(['steps', 'harm', 'arp']);
const edges: Record<string, readonly string[]> = {
  fm1: ['steps', 'harm', 'arp', 'alloc', 'drummap'],
  steps: ['harm', 'arp', 'alloc', 'drummap'],
  harm: ['steps', 'arp', 'alloc'],
  arp: ['alloc', 'drummap'],
};

/** Keys have one source per input. A path can contain one of each note processor.
 * Branching is allowed; joining, feedback and recording an arp's rhythm are not. */
export function keyRouteError(p: Patch, extra?: Cable): string | null {
  const cables = [...p.cables.filter(c => c.from.port === 'keys' && c.to.port === 'keys'), ...(extra ? [extra] : [])];
  const byId = new Map(p.modules.map(m => [m.id, m]));
  const incoming = new Map<number, number>();
  for (const c of cables) {
    const a = byId.get(c.from.module), b = byId.get(c.to.module);
    if (!a || !b) continue;
    if (!edges[a.type]?.includes(b.type)) return a.type === 'arp' && b.type === 'steps'
      ? 'Recording the Arpeggiator’s rhythm is not supported yet.' : 'These modules cannot be connected by a keys cable.';
    if (incoming.has(b.id)) return 'A keys input takes one source. Disconnect its existing cable first.';
    incoming.set(b.id, a.id);
  }
  for (const m of p.modules) {
    const seen = new Set<number>(), types = new Set<string>();
    let n: ModuleInst | undefined = m;
    while (n) {
      if (seen.has(n.id)) return 'Keys cables cannot form a loop.';
      seen.add(n.id);
      if (transforms.has(n.type)) {
        if (types.has(n.type)) return 'A keys path can contain one Steps track, one Harmonizer and one Arpeggiator.';
        types.add(n.type);
      }
      const id = incoming.get(n.id);
      n = id === undefined ? undefined : byId.get(id);
    }
  }
  return null;
}

/** The immediate source; disconnected Steps still play their stored pattern. */
export function keyFeed(p: Patch, m: Pick<ModuleInst, 'id'>): ModuleInst | null {
  const c = p.cables.find(c => c.to.module === m.id && c.to.port === 'keys' && c.from.port === 'keys');
  return c ? p.modules.find(m => m.id === c.from.module) ?? null : null;
}

/** Note processors and destinations downstream, with a bound even for unvalidated input. */
export function keyReach(p: Patch, id: number): Set<number> {
  const seen = new Set([id]);
  for (const n of seen) for (const c of p.cables)
    if (c.from.module === n && c.from.port === 'keys' && c.to.port === 'keys') seen.add(c.to.module);
  return seen;
}

/** The new routes require a reader which understands note processors feeding one another. */
export function chainedHarmonizer(p: Patch): boolean {
  const type = (id: number): string | undefined => p.modules.find(m => m.id === id)?.type;
  return p.cables.some(c => c.from.port === 'keys' && c.to.port === 'keys' &&
    ((type(c.from.module) === 'harm' && ['steps', 'arp'].includes(type(c.to.module) ?? '')) ||
      (type(c.from.module) === 'steps' && type(c.to.module) === 'harm')));
}
