import { describe, expect, it } from 'vitest';
import { kindOf, setKind, switches, toggleTargets } from './buttons';
import { arpChoices, arpFree, arpsOf, insertArpeggiator } from './arp-button';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch } from './patch';

describe('+ Add arpeggiator (#119)', () => {
  it('goes between Main\'s keys and the allocator, and ARP becomes its switching Toggle', () => {
    const p = emptyPatch('t');
    const main = addModule(p, DEFS.fm1, 0, 0);
    const alloc = addModule(p, DEFS.alloc, 600, 0);
    connect(p, DEFS, { module: main.id, port: 'keys' }, { module: alloc.id, port: 'keys' });
    const arp = insertArpeggiator(p)!;
    expect(arpsOf(p)).toEqual([arp]);
    const keys = p.cables.filter((c) => c.from.port === 'keys').map((c) => `${c.from.module}>${c.to.module}`).sort();
    expect(keys).toEqual([`${arp.id}>${alloc.id}`, `${main.id}>${arp.id}`].sort());
    const panel = p.modules.find((m) => m.type === 'fm1')!.panel;
    expect(kindOf(panel, 'arp')).toBe('bypass');
    expect(switches(panel, 'arp')).toBe(true);
    expect(toggleTargets(p, 'arp')).toEqual([arp.id]);
  });

  it('with nothing on Main\'s keys it is just fed by them', () => {
    const p = emptyPatch('t');
    const main = addModule(p, DEFS.fm1, 0, 0);
    const arp = insertArpeggiator(p)!;
    expect(p.cables).toEqual([{ from: { module: main.id, port: 'keys' }, to: { module: arp.id, port: 'keys' } }]);
  });

});

describe('ARP with nothing on it: what a click does', () => {
  const base = (allocs: number, arps: number) => {
    const p = emptyPatch('t');
    const main = addModule(p, DEFS.fm1, 0, 0);
    setKind(p, 'arp', 'nothing');
    const as = Array.from({ length: arps }, (_, i) => addModule(p, DEFS.arp, 300, i * 200));
    const vs = Array.from({ length: allocs }, (_, i) => addModule(p, DEFS.alloc, 600, i * 200));
    as.forEach((a) => connect(p, DEFS, { module: main.id, port: 'keys' }, { module: a.id, port: 'keys' }));
    // the first arps.length allocators play through an arpeggiator each, the rest the keys straight
    vs.forEach((v, i) => connect(p, DEFS, { module: (as[i] ?? main).id, port: 'keys' }, { module: v.id, port: 'keys' }));
    return { p, main, as, vs };
  };
  const enabled = (p: ReturnType<typeof emptyPatch>) => arpChoices(p).filter((c) => !c.disabled);

  it('is free while unassigned and uncabled, or a Toggle whose target is gone', () => {
    const { p, main } = base(1, 0);
    expect(arpFree(p)).toBe(true);
    connect(p, DEFS, { module: main.id, port: 'arp' }, { module: addModule(p, DEFS.adsr, 0, 400).id, port: 'gate' });
    expect(arpFree(p)).toBe(false);
    const q = base(1, 0).p;
    const arp = insertArpeggiator(q)!;
    expect(arpFree(q)).toBe(false);
    q.modules = q.modules.filter((m) => m !== arp);
    expect(arpFree(q)).toBe(true);
  });

  it('one voice group: a single choice, a new arpeggiator before it', () => {
    const { p, vs } = base(1, 0);
    const [c] = enabled(p);
    expect(enabled(p)).toHaveLength(1);
    const arp = c.apply(p)!;
    expect(p.cables.some((x) => x.from.module === arp.id && x.to.module === vs[0].id)).toBe(true);
    expect(toggleTargets(p, 'arp')).toEqual([arp.id]);
  });

  it('two voice groups: all, or each alone', () => {
    const { p, main, vs } = base(2, 0);
    expect(arpChoices(p).map((c) => c.cables.length)).toEqual([2, 1, 1]);
    const arp = arpChoices(p)[2].apply(p)!;
    expect(p.cables.some((x) => x.from.module === arp.id && x.to.module === vs[1].id)).toBe(true);
    expect(p.cables.some((x) => x.from.module === main.id && x.to.module === vs[0].id)).toBe(true);
  });

  it('an arpeggiator already there and nothing straight: put it on ARP, no new module', () => {
    const { p, as } = base(1, 1);
    expect(enabled(p)).toHaveLength(1);
    const n = p.modules.length;
    expect(enabled(p)[0].apply(p)).toBe(as[0]);
    expect(p.modules).toHaveLength(n);
  });

  it('two arpeggiators: pick one; a third is offered but off (the FM-1 runs two)', () => {
    const { p } = base(2, 2);
    const cs = arpChoices(p);
    expect(cs.filter((c) => !c.disabled)).toHaveLength(2);
    expect(cs.filter((c) => c.disabled)).toHaveLength(1);
  });

  it('one group through an arpeggiator, one straight: reuse, add, or route it through', () => {
    const { p, as, vs } = base(2, 1);
    const cs = arpChoices(p);
    expect(cs).toHaveLength(3);
    expect(cs[2].apply(p)).toBe(as[0]);
    expect(p.cables.some((x) => x.from.module === as[0].id && x.to.module === vs[1].id)).toBe(true);
  });

  it('no Main module: nothing to offer', () => {
    expect(arpChoices(emptyPatch('t'))).toEqual([]);
  });
});
