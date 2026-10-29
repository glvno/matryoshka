// SPDX-License-Identifier: GPL-3.0-only
// The factory engines' preset cards (#413, src/preset-cards.ts): the text files in web/presets/cards/ that hold the
// presets written by hand. Run from web/:
//   npm run presets                          every factory engine: its card (or that it has none) and its presets
//   npm run presets -- card "Hera 6"         the engine's card as a new file would start: the rules, Init and the ranges
//   npm run presets -- card "Hera 6" --new   the same, written to presets/cards/hera-6.txt (never over an existing file)
//   npm run presets -- show "Hera 6"         the engine's presets as it ships them now, as card blocks (rule-made or the card's)
//   npm run presets -- check                 parse every card; a mistake is printed with its line, and the exit code is 1
//   npm run presets -- from-library FILE     a library exported from the browser (matryoshka-presets): its presets whose
//                                            structure is a factory engine's, as card blocks to paste into the engine's card
// After a card changes: npm run export-defs (the FM-1's ROM list, firmware/src/presets.h) and npm test.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { FACTORY } from '../src/assemblies';
import type { AssemblyDef } from '../src/assembly';
import { PRESETS_FORMAT, fixPreset, type Preset } from '../src/device-presets';
import { defIsEngine } from '../src/engines';
import { CARDS, cardOf, presetsOfDef } from '../src/factory-presets';
import { cardSlug, cardTemplate, formatPreset, parseCard } from '../src/preset-cards';
import { defStructure } from '../src/structure';

const ENGINES = FACTORY.filter((d) => defIsEngine(d));
const [cmd, ...rest] = process.argv.slice(2);

const engine = (name: string | undefined): AssemblyDef => {
  const d = name && ENGINES.find((x) => x.name.toLowerCase() === name.toLowerCase() || cardSlug(x.name) === cardSlug(name));
  if (!d) {
    console.error(`no factory engine "${name ?? ''}". The engines: ${ENGINES.map((x) => x.name).join(', ')}`);
    process.exit(2);
  }
  return d;
};

const fileOf = (d: AssemblyDef): URL => new URL(`../presets/cards/${cardSlug(d.name)}.txt`, import.meta.url);

if (!cmd) {
  for (const d of ENGINES) {
    const card = cardOf(d);
    const list = presetsOfDef(d);
    console.log(`${d.name.padEnd(14)} ${(card ? `cards/${cardSlug(d.name)}.txt` : 'no card, rule-made').padEnd(26)} ${list.map((p) => p.name).join(', ')}`);
  }
} else if (cmd === 'card') {
  const d = engine(rest[0]);
  const text = cardTemplate(d);
  if (rest.includes('--new')) {
    const f = fileOf(d);
    if (existsSync(f)) {
      console.error(`${f.pathname} exists: edit it, or delete it first`);
      process.exit(2);
    }
    writeFileSync(f, text);
    console.log(`wrote ${f.pathname}`);
  } else process.stdout.write(text);
} else if (cmd === 'show') {
  const d = engine(rest[0]);
  const list = presetsOfDef(d);
  console.log(`# ${d.name}: ${cardOf(d) ? 'its card' : 'rule-made'} (${list.length - 1} presets after Init)\nengine: ${d.name}\n`);
  for (const p of list.slice(1)) console.log(`${formatPreset(d, p.name, p.values)}\n`);
} else if (cmd === 'check') {
  let bad = 0;
  for (const [slug, text] of Object.entries(CARDS)) {
    const d = ENGINES.find((x) => cardSlug(x.name) === slug);
    if (!d) {
      console.log(`presets/cards/${slug}.txt: no factory engine is called that`);
      bad++;
      continue;
    }
    const r = parseCard(text, d);
    if (r.errors.length) {
      console.log(`presets/cards/${slug}.txt (${d.name}): ${r.errors.length} mistake${r.errors.length > 1 ? 's' : ''}\n  ${r.errors.join('\n  ')}`);
      bad++;
    } else console.log(`presets/cards/${slug}.txt (${d.name}): ${r.presets.length - 1} presets: ${r.presets.slice(1).map((p) => p.name).join(', ')}`);
  }
  if (!Object.keys(CARDS).length) console.log('no cards in presets/cards/');
  process.exit(bad ? 1 : 0);
} else if (cmd === 'from-library') {
  const raw = JSON.parse(readFileSync(rest[0], 'utf8')) as { format?: unknown; presets?: unknown[] };
  if (raw.format !== PRESETS_FORMAT || !Array.isArray(raw.presets)) {
    console.error(`${rest[0]} is not a preset library (format ${PRESETS_FORMAT})`);
    process.exit(2);
  }
  const byStructure = new Map(ENGINES.map((d) => [defStructure(d), d]));
  const list = raw.presets.map(fixPreset).filter((p): p is Preset => !!p);
  let n = 0;
  for (const p of list) {
    const d = byStructure.get(p.structure);
    if (!d) continue;
    console.log(`# ${d.name} (presets/cards/${cardSlug(d.name)}.txt)\n${formatPreset(d, p.name, p.values)}\n`);
    n++;
  }
  console.log(`# ${n} of ${list.length} presets belong to a factory engine`);
} else {
  console.error('commands: (none), card NAME [--new], show NAME, check, from-library FILE');
  process.exit(2);
}
