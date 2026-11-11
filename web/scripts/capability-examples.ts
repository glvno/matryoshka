// SPDX-License-Identifier: GPL-3.0-only
// Maintained design fixtures, not factory presets or a capability implementation.
// Run from web: npx vite-node scripts/capability-examples.ts [--write]
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { insertAssembly, makeAssembly, targetsOf, type AssemblyInst } from '../src/assembly';
import { instIsEngine } from '../src/engines';
import { keyRouteError } from '../src/key-routing';
import { DEFS } from '../src/modules';
import { addModule, connect, newPatch, validatePatch, type Endpoint, type Patch } from '../src/patch';

const destination = fileURLToPath(new URL('../../docs/capability-examples/', import.meta.url));
const write = process.argv.includes('--write');
const factory = (name: string) => JSON.parse(readFileSync(new URL(`../src/assemblies/${name}.json`, import.meta.url), 'utf8'));
const end = (module: number, port: string): Endpoint => ({ module, port });
function cable(p: Patch, from: Endpoint, to: Endpoint) {
  assert(connect(p, DEFS, from, to), `${p.name}: rejected ${from.module}.${from.port} -> ${to.module}.${to.port}`);
}
function keys(p: Patch, from: Endpoint, a: AssemblyInst) {
  const input = a.inputs.find(r => DEFS[p.modules.find(m => m.id === r.module)!.type].inputs.some(i => i.name === r.port && i.kind === 'keys'))!;
  for (const target of targetsOf(input)) cable(p, from, target);
}
function source(p: Patch) { return end(p.modules.find(m => m.type === 'fm1')!.id, 'keys'); }
function output(p: Patch) { return end(p.modules.find(m => m.type === 'output')!.id, 'l'); }
function engine(p: Patch, y = 300) { return insertAssembly(p, DEFS, factory('mono-lead'), 100, y); }
function echo(p: Patch) { return insertAssembly(p, DEFS, factory('echo'), 800, 300); }
function custom(p: Patch) {
  const first = addModule(p, DEFS.filter, 800, 300);
  const second = addModule(p, DEFS.filter, 1070, 300);
  cable(p, end(first.id, 'lp12'), end(second.id, 'in'));
  const a = makeAssembly(p, [first.id, second.id], 'Two filters');
  a.inputs = [{ ...end(first.id, 'in'), label: 'audio in' }];
  a.outputs = [{ ...end(second.id, 'lp12'), label: 'audio out' }];
  a.params = [first, second].map((m, i) => ({ module: m.id, param: 'cutoff', label: `cutoff ${i + 1}` }));
  return a;
}
function through(p: Patch, a: AssemblyInst, fx: AssemblyInst) {
  cable(p, a.outputs[0], fx.inputs[0]);
  cable(p, fx.outputs[0], output(p));
}
function save(name: string, p: Patch, expectedEngines: number) {
  const normalized = validatePatch(structuredClone(p), DEFS);
  assert.equal(normalized.modules.length, p.modules.length, 'validation removed modules');
  assert.deepEqual(normalized.cables, p.cables, 'validation changed routing');
  assert.equal(normalized.assemblies?.length, p.assemblies?.length, 'validation changed assembly count');
  assert.equal(normalized.assemblies?.filter(a => instIsEngine(normalized, a)).length ?? 0, expectedEngines);
  const encoded = JSON.stringify(normalized, null, 2) + '\n';
  if (write) { mkdirSync(destination, { recursive: true }); writeFileSync(destination + name + '.json', encoded); }
  else assert.equal(readFileSync(destination + name + '.json', 'utf8'), encoded, `${name}: regenerate with --write`);
  console.log(`${name}: valid graph; ${expectedEngines} recognized engine assemblies`);
}

{
  const p = newPatch(DEFS, 'Factory engine and effects');
  const a = engine(p), fx = echo(p);
  keys(p, source(p), a); through(p, a, fx);
  save('01-factory-effects', p, 1);
}
{
  const p = newPatch(DEFS, 'Custom effects');
  const a = engine(p), fx = custom(p);
  keys(p, source(p), a); through(p, a, fx);
  save('02-custom-effects', p, 1);
}
{
  const p = newPatch(DEFS, '03-arp-harmony');
  const arp = addModule(p, DEFS.arp, 100, 100), harm = addModule(p, DEFS.harm, 370, 100);
  const edge = { from: end(arp.id, 'keys'), to: end(harm.id, 'keys') };
  assert(keyRouteError(p, edge));
  assert.equal(connect(p, DEFS, edge.from, edge.to), false);
  console.log('03-arp-harmony: rejected by current routing rules; no invalid patch written');
}
for (const [name, order] of [['04-harmony-arp', ['steps', 'harm', 'arp']]] as const) {
  const p = newPatch(DEFS, name);
  const a = engine(p);
  let previous = source(p);
  for (const [i, type] of order.entries()) {
    const m = addModule(p, DEFS[type], 100 + i * 270, 100);
    cable(p, previous, end(m.id, 'keys'));
    previous = end(m.id, 'keys');
    const group = makeAssembly(p, [m.id], DEFS[type].label);
    group.inputs = [{ ...end(m.id, 'keys'), label: 'keys' }];
    group.outputs = [{ ...end(m.id, 'keys'), label: 'keys' }];
    group.params = DEFS[type].params.map(row => ({ module: m.id, param: row.name, label: row.name }));
  }
  keys(p, previous, a);
  cable(p, a.outputs[0], output(p));
  save(name, p, 1);
}
{
  const p = newPatch(DEFS, 'Two engines sharing effects');
  const first = engine(p), second = engine(p, 900), fx = echo(p);
  keys(p, source(p), first); keys(p, source(p), second);
  cable(p, first.outputs[0], fx.inputs[0]);
  cable(p, second.outputs[0], fx.inputs[0]);
  cable(p, fx.outputs[0], output(p));
  save('05-shared-effects', p, 2);
}
{
  const p = newPatch(DEFS, 'Audio without an engine');
  const oscillator = addModule(p, DEFS.osc, 100, 300), fx = custom(p);
  cable(p, end(oscillator.id, 'out'), fx.inputs[0]);
  cable(p, fx.outputs[0], output(p));
  save('06-no-engine', p, 0);
}
{
  const p = newPatch(DEFS, 'Nested engine and effects');
  const a = engine(p), fx = echo(p);
  keys(p, source(p), a); through(p, a, fx);
  const parent = makeAssembly(p, [], 'Combined sound', [a.id, fx.id]);
  parent.inputs = structuredClone(a.inputs);
  parent.outputs = structuredClone(fx.outputs);
  save('07-nested', p, 2);
}
{
  const p = newPatch(DEFS, 'Drum engine and effects');
  const a = insertAssembly(p, DEFS, factory('drum-kit'), 100, 300), fx = echo(p);
  keys(p, source(p), a); through(p, a, fx);
  save('08-drums', p, 1);
}
