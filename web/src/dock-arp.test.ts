import { describe, expect, it } from 'vitest';
import { kindOf, switches, toggleTargets } from './buttons';
import { arpsOf, insertArpeggiator } from './dock-arp';
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
