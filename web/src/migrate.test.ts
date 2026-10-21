import { describe, expect, it } from 'vitest';
import { acceptKeys, backupKeys, BACKUP_FORMAT, importSummary, OLD_ORIGIN, planImport, withoutMigrate } from './migrate';

const store = (o: Record<string, string>) => (k: string): string | null => (k in o ? o[k] : null);
const patch = (name: string, extra = 0) => ({ name, modules: [{ id: extra }] });
const saved = (name: string, extra = 0, at = 1) => ({ name, patch: patch(name, extra), saved: at });

describe('acceptKeys', () => {
  it('takes only matryoshka.* and modular-1.* keys with string values', () => {
    expect(acceptKeys({ 'matryoshka.patch': '{}', 'matryoshka.theme': 'dark', other: 'x', 'matryoshka.n': 3, 'matryoshkaX.y': 'z', '__proto__.x': 'a' }))
      .toEqual({ 'matryoshka.patch': '{}', 'matryoshka.theme': 'dark' });
    expect(acceptKeys(null)).toEqual({});
    expect(acceptKeys(['matryoshka.patch'])).toEqual({});
    expect(acceptKeys('matryoshka.patch')).toEqual({});
  });
  it('reads a legacy modular-1.* key as matryoshka.*, unless the new name is there too', () => {
    expect(acceptKeys({ 'modular-1.bank': 'old', 'modular-1.patch': 'legacy', 'matryoshka.patch': 'new' }))
      .toEqual({ 'matryoshka.bank': 'old', 'matryoshka.patch': 'new' });
  });
});

describe('backupKeys', () => {
  it('reads the forwarder backup file, and nothing else', () => {
    expect(backupKeys({ format: BACKUP_FORMAT, version: 1, keys: { 'matryoshka.theme': 'light', evil: 'x' } })).toEqual({ 'matryoshka.theme': 'light' });
    expect(backupKeys({ name: 'a patch', modules: [] })).toBeNull();
    expect(backupKeys(null)).toBeNull();
  });
});

describe('planImport', () => {
  it('takes everything into an empty storage', () => {
    const incoming = {
      'matryoshka.patch': JSON.stringify(patch('Acid')),
      'matryoshka.patches': JSON.stringify([saved('Acid'), saved('Pad')]),
      'matryoshka.theme': 'light',
      'matryoshka.tutorial': '{"done":[1]}',
    };
    const plan = planImport(incoming, store({}), () => false);
    expect(plan.writes).toEqual(incoming);
    expect(plan.kept).toEqual([]);
    expect(importSummary(plan, 'glvno.github.io')).toBe('Brought over from glvno.github.io: the open patch, the tutorial progress, 2 of Your patches, 1 setting.');
  });

  it('takes a value the app wrote after the page started (the starter patch), keeps one that was there', () => {
    const incoming = { 'matryoshka.patch': JSON.stringify(patch('Old')), 'matryoshka.theme': 'light' };
    const here = { 'matryoshka.patch': JSON.stringify(patch('Starter')), 'matryoshka.theme': 'dark' };
    const plan = planImport(incoming, store(here), (k) => k === 'matryoshka.theme');
    expect(plan.writes).toEqual({ 'matryoshka.patch': incoming['matryoshka.patch'] });
    expect(plan.kept).toEqual(['1 setting']);
  });

  it('keeps an open patch the user had here, and puts the old one into Your patches', () => {
    const incoming = { 'matryoshka.patch': JSON.stringify(patch('Old')) };
    const here = { 'matryoshka.patch': JSON.stringify(patch('Mine')), 'matryoshka.patches': JSON.stringify([saved('Mine')]) };
    const plan = planImport(incoming, store(here), () => true);
    expect(plan.writes['matryoshka.patch']).toBeUndefined();
    const list = JSON.parse(plan.writes['matryoshka.patches']) as { name: string }[];
    expect(list.map((e) => e.name)).toEqual(['Mine', 'Old']);
    expect(plan.kept).toEqual(['the open patch (the old one is in Your patches)']);
  });

  it('merges Your patches by name: new ones added, identical ones skipped, a different one under the same name kept as a copy', () => {
    const here = { 'matryoshka.patches': JSON.stringify([saved('A', 0, 5), saved('B', 0), saved('B (old site)', 9)]) };
    const incoming = { 'matryoshka.patches': JSON.stringify([saved('A', 0, 1), saved('B', 1), saved('C')]) };
    const plan = planImport(incoming, store(here), () => true);
    const list = JSON.parse(plan.writes['matryoshka.patches']) as { name: string; patch: { name: string }; saved: number }[];
    expect(list.map((e) => e.name)).toEqual(['A', 'B', 'B (old site)', 'B (old site 2)', 'C']);
    expect(list[3].patch.name).toBe('B (old site 2)');
    expect(list[0].saved).toBe(5);   // the identical one (only its date differs) is not added again
    expect(plan.brought).toEqual(['2 of Your patches']);
  });

  it('merges the library by name the same way', () => {
    const here = { 'matryoshka.assemblies': JSON.stringify([{ name: 'Kit', v: 1 }]) };
    const incoming = { 'matryoshka.assemblies': JSON.stringify([{ name: 'Kit', v: 2 }, { name: 'Pad', v: 1 }]) };
    const list = JSON.parse(planImport(incoming, store(here), () => true).writes['matryoshka.assemblies']) as { name: string }[];
    expect(list.map((e) => e.name)).toEqual(['Kit', 'Kit (old site)', 'Pad']);
  });

  it('adds to the FM-1 bank without replacing a slot of the same name, up to the 64 slots', () => {
    const here = { 'matryoshka.bank': JSON.stringify(Array.from({ length: 63 }, (_, i) => ({ name: `P${i}` }))) };
    const incoming = { 'matryoshka.bank': JSON.stringify([{ name: 'P0', patch: patch('P0', 7) }, { name: 'New' }, { name: 'Late' }]) };
    const plan = planImport(incoming, store(here), () => true);
    const list = JSON.parse(plan.writes['matryoshka.bank']) as { name: string }[];
    expect(list).toHaveLength(64);
    expect(list[0]).toEqual({ name: 'P0' });
    expect(list[63].name).toBe('New');
    expect(plan.brought).toEqual(['1 FM-1 bank entry']);
    expect(plan.kept).toEqual(['2 FM-1 bank entries (the one here or no room)']);
  });

  it('takes the bank as it was when there is none here', () => {
    const bank = JSON.stringify([{ name: 'X' }]);
    expect(planImport({ 'matryoshka.bank': bank }, store({}), () => false).writes).toEqual({ 'matryoshka.bank': bank });
  });

  it('writes nothing for what is already here', () => {
    const here = { 'matryoshka.theme': 'dark', 'matryoshka.patches': JSON.stringify([saved('A')]) };
    const plan = planImport({ ...here }, store(here), () => true);
    expect(plan.writes).toEqual({});
    expect(importSummary(plan, 'x')).toBe('Nothing new to bring over from x: it is all here already.');
  });

  it('treats a list it cannot read as a value', () => {
    const plan = planImport({ 'matryoshka.patches': 'not json' }, store({}), () => false);
    expect(plan.writes).toEqual({ 'matryoshka.patches': 'not json' });
  });
});

describe('the hand-off', () => {
  it('trusts only the old site by default', () => {
    expect(OLD_ORIGIN).toBe('https://glvno.github.io');
  });
  it('strips migrate=1 and keeps the rest of the address', () => {
    expect(withoutMigrate('https://matryoshka.pages.dev/?migrate=1&x=2#p=abc')).toBe('/?x=2#p=abc');
    expect(withoutMigrate('https://matryoshka.pages.dev/brand/?migrate=1')).toBe('/brand/');
  });
});
