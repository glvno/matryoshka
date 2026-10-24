import { describe, expect, it } from 'vitest';
import { arpLitInverted, kindOf, setKind, setTarget, switches, toggleEngaged, toggleTargets } from './buttons';
import { arpChoices, arpFree, arpsOf, insertArpeggiator } from './arp-button';
import { DEFS, PANEL_BUTTONS } from './modules';
import { Engine } from './engine';
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

  it('bypassed (ARP engaged) the keys play straight, as without it; ARP released, it arpeggiates (D-425)', () => {
    const voice = (): ReturnType<typeof emptyPatch> => {
      const p = emptyPatch('t');
      const main = addModule(p, DEFS.fm1, 0, 0);
      const alloc = addModule(p, DEFS.alloc, 600, 0);
      alloc.params.voices = 3;
      const osc = addModule(p, DEFS.osc, 900, 0);
      const out = addModule(p, DEFS.output, 1200, 0);
      connect(p, DEFS, { module: main.id, port: 'keys' }, { module: alloc.id, port: 'keys' });
      connect(p, DEFS, { module: alloc.id, port: 'pitch' }, { module: osc.id, port: 'pitch' });
      connect(p, DEFS, { module: alloc.id, port: 'gate' }, { module: osc.id, port: 'p1' });
      connect(p, DEFS, { module: osc.id, port: 'out' }, { module: out.id, port: 'l' });
      return p;
    };
    const render = (p: ReturnType<typeof emptyPatch>, press?: boolean): Float32Array => {
      const e = new Engine(44118);
      e.load(p);
      if (press !== undefined) e.setButton(PANEL_BUTTONS.indexOf('arp'), press);
      e.noteOn(48);
      e.noteOn(55);
      const l = new Float32Array(44118 / 2), r = new Float32Array(l.length);
      e.render(l, r);
      return l;
    };
    const plain = render(voice());
    const p = voice();
    insertArpeggiator(p)!.bypass = true;
    expect(render(p)).toEqual(plain);                         // saved bypassed: ARP is engaged
    expect(render(p, false)).not.toEqual(plain);              // ARP released: the arpeggiator plays
    const q = voice();
    insertArpeggiator(q);
    expect(render(q)).not.toEqual(plain);
    expect(render(q, true)).toEqual(plain);                   // ARP pressed before the keys: straight
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

describe('ARP\'s light (D-231): lit while its Arpeggiator plays', () => {
  it('ARP on an Arpeggiator: the light is the inverse of the Toggle (lit = not bypassed); on anything else, or another button, as the Toggle', () => {
    const p = emptyPatch('t');
    addModule(p, DEFS.fm1, 0, 0);
    const arp = insertArpeggiator(p)!;
    expect(arpLitInverted(p, 'arp')).toBe(true);
    arp.bypass = true;
    expect(toggleEngaged(p, 'arp')).toBe(true); // (engaged: its target bypassed; so the light is dark)
    const fold = addModule(p, DEFS.shape, 300, 0);
    setTarget(p, 'arp', { module: fold.id });
    expect(arpLitInverted(p, 'arp')).toBe(false);
    setKind(p, 'fx', 'bypass');
    setTarget(p, 'fx', { module: arp.id });
    expect(arpLitInverted(p, 'fx')).toBe(false);
  });
});
