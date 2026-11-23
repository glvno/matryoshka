// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { keyOf, runFor, searchCommands, type Command } from './commands';

const command = (label: string, kind = 'assembly', detail = 'Drums'): Command => ({ label, kind, detail, run() {} });

describe('Commands search', () => {
  it('lists modules or assembly prefabs and assembly actions by their type tags', () => {
    const module = command('Oscillator', 'add module', '');
    const prefab = command('kick');
    const make = command('Make assembly from the selection', 'command', '');
    const browser = command('Insert assembly… (browser)', 'command', '');
    const patch = command('My assembly patch', 'load patch', '');
    const choices = [module, prefab, make, browser, patch];
    expect(searchCommands(choices, 'module')).toEqual([module]);
    expect(searchCommands(choices, 'modules')).toEqual([module]);
    expect(searchCommands(choices, 'assembly')).toEqual([prefab, make, browser]);
    expect(searchCommands(choices, 'assemblies')).toEqual([prefab, make, browser]);
  });
  it('finds assemblies by action, name, shelf and constituent modules', () => {
    const kick = { ...command('kick'), keywords: 'insert Oscillator + ADSR + VCA' };
    const choices = [command('Oscillator', 'add module', ''), kick];
    for (const query of ['assembly kick', 'drums kick', ' INSERT KICK ', 'assembly adsr']) {
      expect(searchCommands(choices, query)).toEqual([kick]);
    }
  });

  it('prefers a name match and keeps factory and user assemblies with the same name', () => {
    const user = command('kick', 'assembly', 'Your library');
    const factory = command('kick');
    const other = { ...command('kit'), keywords: 'kick snare hats' };
    expect(searchCommands([other, user, factory], 'kick')).toEqual([user, factory, other]);
    expect(searchCommands([user, factory], 'library kick')).toEqual([user]);
  });

  it('keeps matches beyond the former twelve-result limit and handles no matches', () => {
    const choices = Array.from({ length: 43 }, (_, i) => command(`assembly ${i}`));
    expect(searchCommands(choices, 'assembly')).toHaveLength(43);
    expect(searchCommands(choices, '   ')).toEqual(choices);
    expect(searchCommands(choices, 'unfindable')).toEqual([]);
  });
});

describe('effects in the + list', () => {
  it('lists effects by their tag, modules and assemblies alike', () => {
    const phaser = { ...command('Phaser', 'add module', ''), tags: ['module', 'effect'] };
    const echo = { ...command('Echo', 'assembly', 'Effects'), tags: ['assembly', 'effect'] };
    const osc = command('Oscillator', 'add module', '');
    expect(searchCommands([osc, phaser, echo], 'effect')).toEqual([phaser, echo]);
    expect(searchCommands([osc, phaser, echo], 'effects echo')).toEqual([echo]);
  });

  it('⏎ adds to the canvas, ⇧⏎ and ⌥⏎ run the other places, a missing one falls back to the canvas', () => {
    const ran: string[] = [];
    const c: Command = { ...command('Reverb', 'add module', ''), run: () => ran.push('canvas'), also: [
      { key: 'shift', label: 'or into Hera 4’s FX', run: () => ran.push('drawer') },
      { key: 'alt', label: 'or into the Output FX', run: () => ran.push('output') },
    ] };
    runFor(c, keyOf({ shiftKey: false, altKey: false }))();
    runFor(c, keyOf({ shiftKey: true, altKey: false }))();
    runFor(c, keyOf({ shiftKey: false, altKey: true }))();
    runFor({ ...c, also: [] }, 'shift')();
    expect(ran).toEqual(['canvas', 'drawer', 'output', 'canvas']);
  });
});
