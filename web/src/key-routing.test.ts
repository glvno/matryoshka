import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch } from './patch';
import { encodePatch, formatOf, lineBudget, KEY_ROUTING_BYTES } from './patchbin';
import { keyRouteError } from './key-routing';
import { insertArpeggiator } from './arp-button';

function fixture(chain: string[]) {
  const p = emptyPatch('routing');
  const mods = ['fm1', ...chain, 'alloc', 'osc', 'adsr', 'vca', 'output'].map(type => addModule(p, DEFS[type], 0, 0));
  const get = (type: string) => mods.find(m => m.type === type)!;
  get('alloc').params.voices = 8;
  if (get('harm')) get('harm').params.type = 1;
  const wire = (a: number, ap: string, b: number, bp: string) => expect(connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })).toBe(true);
  for (let i = 0; i <= chain.length; i++) wire(mods[i].id, 'keys', mods[i + 1].id, 'keys');
  for (const [a, ap, b, bp] of [['alloc','pitch','osc','pitch'], ['alloc','gate','adsr','gate'], ['osc','out','vca','in'], ['adsr','env','vca','cv'], ['vca','out','output','l']]) wire(get(a).id, ap, get(b).id, bp);
  return { p, get };
}
function blocks(e: Engine, count = 8): number {
  let peak = 0;
  for (let i = 0; i < count; i++) { const l = new Float32Array(128); e.render(l, new Float32Array(128)); peak = Math.max(peak, ...l.map(Math.abs)); }
  return peak;
}

describe('cable-order harmony', () => {
  it('charges bounded routing scratch only to patches with new routes and Steps', () => {
    for (const chain of [['harm'], ['steps'], ['harm', 'arp']]) expect(lineBudget(fixture(chain).p).keyBytes).toBe(0);
    for (const chain of [['harm', 'steps'], ['steps', 'harm'], ['steps', 'harm', 'arp']]) {
      const b = lineBudget(fixture(chain).p);
      expect(b.keyBytes).toBe(KEY_ROUTING_BYTES);
      expect(b.used).toBe(b.copiesBytes + b.buffersBytes + b.paramsBytes + b.nodesBytes + b.keyBytes + b.lines);
    }
  });
  it.each([['harm','arp'], ['harm','steps'], ['steps','harm'], ['harm','steps','arp'], ['steps','harm','arp']])('plays %j in both compiler modes', (...chain) => {
    const { p } = fixture(chain);
    for (const compiled of [false, true]) { const e = new Engine(48000); e.load(p, compiled); e.noteOn(60); expect(blocks(e, 30)).toBeGreaterThan(.001); e.noteOff(60); blocks(e, 60); }
    expect(formatOf(p)).toBe(53); expect(encodePatch(p)[1]).toBe(53);
  });
  it.each([['harm','steps'], ['steps','harm']])('captures pitches by order %j', (...chain) => {
    const { p, get } = fixture(chain); const e = new Engine(48000); e.load(p);
    const id = get('steps').id;
    expect(e.entryNotes(id, 60, true)).toEqual(chain[0] === 'harm' ? [60,64,67] : [60]);
    expect(e.entryNotes(id, 56, true)).toEqual([]);
    expect(e.entryNotes(id, 56, false)).toEqual([]);
    e.transport(true); blocks(e); e.setRec(id, true); e.noteOn(60); blocks(e, 60); e.noteOff(60); blocks(e);
    expect(e.takeRecorded().map(x => x.note.note).sort((a,b) => a-b)).toEqual(chain[0] === 'harm' ? [60,64,67] : [60]);
  });
  it('inserts ARP after harmony', () => {
    const { p, get } = fixture(['harm']); const a = insertArpeggiator(p)!;
    expect(p.cables.some(c => c.from.module === get('harm').id && c.to.module === a.id)).toBe(true);
    expect(keyRouteError(p)).toBe(null);
  });
  it('snapshots a live root before Steps even when the chord button changes before rendering', () => {
    const { p } = fixture(['steps','harm']); const e = new Engine(48000); e.load(p);
    e.chordButton(3, true); e.noteOn(60); e.chordButton(3, false); blocks(e);
    const notes = e.voiceNotes().filter(v => v.on).map(v => v.note);
    expect(notes).toContain(63); expect(notes).not.toContain(64);
    e.noteOff(60); blocks(e); expect(e.voiceNotes().filter(v => v.on)).toEqual([]);
  });
  it('keeps each downstream Harmonizer snapshot when a Steps output branches', () => {
    const { p, get } = fixture(['steps', 'harm']);
    const h = addModule(p, DEFS.harm, 0, 0); h.params.type = 2;
    const a = addModule(p, DEFS.alloc, 0, 0); a.params.voices = 8;
    const o = addModule(p, DEFS.osc, 0, 0);
    const e = addModule(p, DEFS.adsr, 0, 0);
    const v = addModule(p, DEFS.vca, 0, 0);
    for (const [from, port, to, input] of [[get('steps').id,'keys',h.id,'keys'], [h.id,'keys',a.id,'keys'], [a.id,'pitch',o.id,'pitch'], [a.id,'gate',e.id,'gate'], [o.id,'out',v.id,'in'], [e.id,'env',v.id,'cv'], [v.id,'out',get('output').id,'r']] as const)
      expect(connect(p, DEFS, {module:from,port}, {module:to,port:input})).toBe(true);
    for (const compiled of [false, true]) {
      const engine = new Engine(48000); engine.load(p, compiled); engine.noteOn(60); blocks(engine);
      expect(engine['harms'].map(h => h.st.roots.flatMap(r => r.notes))).toEqual([[60,64,67], [60,63,67]]);
      engine.noteOff(60); blocks(engine); expect(engine['harms'].every(h => h.st.roots.length === 0)).toBe(true);
    }
  });
  it('dense simultaneous notes on three tracks cannot strand harmony roots', () => {
    const { p, get } = fixture(['steps','harm']);
    get('harm').params.type = 0;
    const extra = [addModule(p, DEFS.steps, 0, 0), addModule(p, DEFS.steps, 0, 0)];
    p.modules = [...extra, ...p.modules.filter(m => !extra.includes(m))];
    for (const t of [get('steps'), ...extra]) t.notes = Array.from({length:128}, (_, note) => ({ at:0,len:1,note,vel:100 }));
    const e = new Engine(48000); e.load(p); e.transport(true); blocks(e, 4);
    expect(e.voiceNotes().filter(v => v.on).map(v => v.note)).toEqual([120,121,122,123,124,125,126,127]);
    blocks(e, 150); expect(e.voiceNotes().filter(v => v.on)).toEqual([]);
  });
  it('accepts or rejects a complete chord at the input queue boundary and reserves releases', () => {
    const { p, get } = fixture(['harm','steps']);
    Object.assign(get('harm').params, { type: 1, sus: 3, ext: 3 });
    const e = new Engine(48000); e.load(p); const id = get('steps').id;
    for (let n = 0; n < 58; n++) e.thru(id, n, 100);
    e.noteOn(60); // 116 slots used/reserved; the seven-tone chord needs 14 more
    blocks(e);
    e.transport(true); blocks(e); e.setRec(id, true);
    e.noteOff(60); blocks(e);
    expect(e.takeRecorded()).toEqual([]); // rejected root has no partial chord
    e.noteOn(60); blocks(e, 60); e.noteOff(60);
    for (let n = 0; n < 58; n++) e.thru(id, n, 0);
    blocks(e);
    expect(e.takeRecorded().map(x => x.note.note).sort((a,b) => a-b)).toEqual([60,62,64,65,67,70,74]);
  });
  it.each([['harm','steps'], ['steps','harm'], ['harm','arp'], ['harm','steps','arp']])('bypass and arming preserve %j', (...chain) => {
    const { p, get } = fixture(chain); const e = new Engine(48000); e.load(p);
    e.arm(get('alloc').id); e.setBypass(get('harm').id, true); e.noteOn(60);
    expect(blocks(e, 30)).toBeGreaterThan(.001); e.noteOff(60); blocks(e, 60);
    e.setBypass(get('harm').id, false); e.noteOn(60); expect(blocks(e, 30)).toBeGreaterThan(.001);
  });
  it('rejects arp capture, cycles and joins visibly', () => {
    const { p, get } = fixture(['steps','harm','arp']);
    const cable = (a: string,b: string) => ({ from: { module:get(a).id,port:'keys' },to:{ module:get(b).id,port:'keys' }});
    expect(keyRouteError(p,cable('arp','steps'))).toMatch(/rhythm/);
    expect(keyRouteError(p,cable('fm1','harm'))).toMatch(/one source/);
  });
});
