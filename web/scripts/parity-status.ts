// SPDX-License-Identifier: GPL-3.0-only
// The FM-1 parity bands of issue #375 (D-149): reads every instrument's sub-issue and the tickets their engine boxes cite,
// measures each full-parity version with deviceBudget, and works out its band (parity-bands.ts).
//   npm run parity-status              print #375's generated section and what --apply would change; touches nothing
//   npm run parity-status -- --apply   write that section into #375, the `fit:` labels and the "blocked by" links
// Rerun it in every pull request that closes or finds a gap, and after `npm run cpu-costs` changes the CPU table.
// Needs `gh`, logged in to the repository. Run from web/.
import { execFileSync } from 'node:child_process';
import { FM1_PRESETS, PRESETS, isXl } from '../src/presets';
import { deviceBudget, overText } from '../src/patchbin';
import { BANDS, BAND_TEXT, openBoxes, parseInputs, renderRegion, rowOf, ticketCost, withRegion, type Band, type Base, type Row, type Ticket } from './parity-bands';

const PARENT = 375;
const APPLY = process.argv.includes('--apply');
const COLOR: Record<Band, string> = { full: '0e8a16', reachable: '1d76db', tight: 'fbca04', 'xl-only': 'b60205', unmeasured: 'cccccc' };

const gh = (args: string[], input?: string): string => execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 << 20 });
const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
interface Issue { id: number; number: number; title: string; body: string | null; state: string; labels: { name: string }[] }
const api = <T>(path: string): T => JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/${path}`])).flat() as T;
const issue = (n: number): Issue => JSON.parse(gh(['api', `repos/${repo}/issues/${n}`]));

const subs = api<Issue[]>(`issues/${PARENT}/sub_issues`);
const instruments = subs.filter((i) => i.title.startsWith('Parity gaps: '));
const tickets = new Map<number, Ticket & { id: number }>();
const addTicket = (i: Issue): void => void tickets.set(i.number, { number: i.number, id: i.id, title: i.title, open: i.state === 'open', cost: ticketCost(i.body ?? '') });
for (const i of subs) if (!i.title.startsWith('Parity gaps: ')) addTicket(i);

const rows: Row[] = [];
const warnings: string[] = [];
for (const i of instruments) {
  const m = /^Parity gaps: (.+?) \((.+)\)$/.exec(i.title);
  if (!m) { warnings.push(`#${i.number}: title not "Parity gaps: <name> (<original>)"`); continue; }
  const [, name, original] = m;
  const body = i.body ?? '';
  const inputs = parseInputs(body);
  if (!inputs) { warnings.push(`#${i.number} ${name}: no **Measure:** line`); continue; }
  const boxes = openBoxes(body);
  for (const b of boxes) {
    if (!b.tag) warnings.push(`#${i.number} ${name}: untagged box "${b.name}" (left out of the band)`);
    if (b.ticket !== undefined && !tickets.has(b.ticket)) addTicket(issue(b.ticket));
  }
  const make = PRESETS[inputs.measure];
  if (!make) { warnings.push(`#${i.number} ${name}: no factory patch or XL named "${inputs.measure}"`); continue; }
  const patch = make();
  if (inputs.at !== undefined) {
    const allocs = patch.modules.filter((x) => x.type === 'alloc');
    if (!allocs.length) warnings.push(`#${i.number} ${name}: "at ${inputs.at} voices" but ${inputs.measure} has no Voicing`);
    else allocs.reduce((a, x) => ((x.params.voices ?? 0) > (a.params.voices ?? 0) ? x : a)).params.voices = inputs.at;
  }
  const b = deviceBudget(patch);
  const item = (k: string) => b.items.find((x) => x.key === k)!;
  const base: Base = { cpu: b.cpu.use * 100, modules: item('modules').used, maxModules: item('modules').max, bytes: item('bytes').used, maxBytes: item('bytes').max,
    over: b.over.filter((x) => x.key !== 'cpu').map(overText) };
  const factory = FM1_PRESETS[name]?.();
  const fm1Voices = factory && (Math.max(0, ...factory.modules.filter((x) => x.type === 'alloc').map((x) => x.params.voices ?? 0)) || undefined);
  rows.push(rowOf(i.number, name, inputs.comparand || original, boxes, inputs, base, isXl(inputs.measure), tickets, fm1Voices));
}

const sha = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8' }).trim();
const region = renderRegion(rows, [...tickets.values()].sort((a, b) => a.number - b.number), sha, new Date().toISOString().slice(0, 10));

// what --apply changes: the section, the labels, the "blocked by" links (only to tickets this script tracks, so links
// someone else made stay)
const changes: { text: string; run: () => void }[] = [];
const parent = issue(PARENT);
const next = withRegion(parent.body ?? '', region);
if (next === undefined) warnings.push(`#${PARENT} has no ${'<!-- parity-status:start -->'} ... end markers: add them where the section goes`);
else if (next !== parent.body) changes.push({ text: `#${PARENT}: rewrite the generated section`, run: () => void gh(['issue', 'edit', String(PARENT), '--body-file', '-'], next) });
const labels = new Set(gh(['label', 'list', '--limit', '500', '--json', 'name', '-q', '.[].name']).split('\n'));
for (const band of BANDS) if (!labels.has(`fit: ${band}`)) changes.push({ text: `create label "fit: ${band}"`, run: () => void gh(['label', 'create', `fit: ${band}`, '--color', COLOR[band], '--description', BAND_TEXT[band].slice(0, 100)]) });
for (const r of rows) {
  const i = instruments.find((x) => x.number === r.issue)!;
  const has = i.labels.map((l) => l.name).filter((l) => l.startsWith('fit: '));
  const want = `fit: ${r.band}`;
  const drop = has.filter((l) => l !== want);
  if (!has.includes(want) || drop.length) changes.push({ text: `#${r.issue} ${r.name}: label ${want}${drop.length ? `, drop ${drop.join(', ')}` : ''}`,
    run: () => void gh(['issue', 'edit', String(r.issue), '--add-label', want, ...(drop.length ? ['--remove-label', drop.join(',')] : [])]) });
  const links = api<Issue[]>(`issues/${r.issue}/dependencies/blocked_by`).map((x) => x.number);
  for (const t of r.blockedBy.filter((t) => !links.includes(t))) changes.push({ text: `#${r.issue} ${r.name}: blocked by #${t}`,
    run: () => void gh(['api', '-X', 'POST', `repos/${repo}/issues/${r.issue}/dependencies/blocked_by`, '-F', `issue_id=${tickets.get(t)!.id}`]) });
  for (const t of links.filter((t) => tickets.has(t) && !r.blockedBy.includes(t))) changes.push({ text: `#${r.issue} ${r.name}: no longer blocked by #${t}`,
    run: () => void gh(['api', '-X', 'DELETE', `repos/${repo}/issues/${r.issue}/dependencies/blocked_by/${tickets.get(t)!.id}`]) });
}

console.log(region, '\n');
for (const w of warnings) console.log(`warning: ${w}`);
console.log(changes.length ? `${APPLY ? 'Applying' : 'With --apply'}:\n${changes.map((c) => `  ${c.text}`).join('\n')}` : 'Nothing to change.');
if (APPLY) for (const c of changes) c.run();
