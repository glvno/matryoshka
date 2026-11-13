// SPDX-License-Identifier: GPL-3.0-only
// The FM-1 parity bands (issue #375, D-149): what each instrument's sub-issue says, how its full-parity cost adds up and
// which band that puts it in, and the tables parity-status.ts writes into #375. No GitHub and no patches here: the
// script reads those and hands this file their text and measurements.

export type Tag = 'card' | 'engine' | 'needs XL' | 'hardware' | 'samples' | 'device UI';
export type Band = 'full' | 'reachable' | 'tight' | 'xl-only' | 'unmeasured';
export const BANDS: Band[] = ['full', 'reachable', 'tight', 'xl-only', 'unmeasured'];
export const BAND_TEXT: Record<Band, string> = {
  full: 'At full parity: only hardware or samples gaps left',
  reachable: 'Full-parity cost at most 90 % CPU and within every limit: fits once its open gaps close',
  tight: 'Full-parity cost over 90 % and up to 130 % CPU, or failed on the test rig: needs optimization',
  'xl-only': 'Full-parity cost over 130 % CPU, or over a module, byte or memory limit: only the XL can hold it',
  unmeasured: 'An input the cost needs is missing',
};
/** the CPU estimate (%) a full-parity version may reach and still fit: CPU_VOICE_TOP (D-870) */
export const FITS = 90;
/** over this CPU estimate (%), no optimization is expected to bring it back */
export const XL_ONLY = 130;
/** over this CPU estimate (%), a band is unqualified until a test-rig run passes */
export const RIG_CHECK = 85;

/** an open box of a sub-issue: its name (the text before " — "), its tag, and the ticket an engine box cites */
export interface Box { name: string; tag: Tag | undefined; ticket: number | undefined }
/** what a gap or a feature adds; perVoice multiplies the CPU by the comparand's voices */
export interface Cost { cpu: number; perVoice: boolean; modules: number; bytes: number; est: boolean }
/** an open box the measured patch lacks: 'measure' when the measurement already holds it, undefined when unmeasured */
export interface Extra { gap: string; cost: Cost | 'measure' | undefined }
export interface Inputs {
  comparand: string;
  voices: number | undefined;
  measure: string;
  at: number | undefined;
  fm1Voices: number | undefined;
  extras: Extra[];
  rig: 'passed' | 'failed' | undefined;
  prototype: number | undefined;
}
/** the measured patch's budget: CPU estimate in %, and every limit it is over besides the CPU */
export interface Base { cpu: number; modules: number; maxModules: number; bytes: number; maxBytes: number; over: string[] }
export interface Ticket { number: number; title: string; open: boolean; cost: Cost | undefined }

const TAG = /`(needs XL|card|hardware|samples|device UI|engine: [^`]+)`/;

/** the open boxes of a sub-issue body. A box's tag is the first one in it ("was `needs XL`" after it is history); an
 * engine box's ticket is the first issue it cites after its tag */
export function openBoxes(body: string): Box[] {
  return body.split('\n').filter((l) => l.startsWith('- [ ] ')).map((l) => {
    const text = l.slice(6);
    const name = text.split(' — ')[0].trim();
    const m = TAG.exec(text);
    const tag = m ? (m[1].startsWith('engine') ? 'engine' : (m[1] as Tag)) : undefined;
    const after = m ? text.slice(m.index + m[0].length) : '';
    const t = tag === 'engine' ? /#(\d+)/.exec(after) : null;
    return { name, tag, ticket: t ? Number(t[1]) : undefined };
  });
}

const num = (s: string): number => Number(s.replace(/,/g, ''));

/** "+0.3 % CPU per voice, +0 modules, +8 B (est.): why" */
export function parseCost(text: string): Cost | undefined {
  const m = /^\+?(-?[\d.]+) % CPU( per voice)?, \+?(-?[\d,]+) modules?, \+?(-?[\d,]+) B\b/.exec(text.trim());
  if (!m) return undefined;
  return { cpu: Number(m[1]), perVoice: !!m[2], modules: num(m[3]), bytes: num(m[4]), est: /\(est\.\)/.test(text) };
}

/** a ticket body's **Cost:** line */
export const ticketCost = (body: string): Cost | undefined => {
  const m = /^\*\*Cost:\*\*\s*(.+)$/m.exec(body);
  return m ? parseCost(m[1]) : undefined;
};

const field = (body: string, name: string): string | undefined => new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'm').exec(body)?.[1].trim();

/** a sub-issue's inputs (its **Comparand:**, **Measure:** ... lines); undefined when it has no Measure line */
export function parseInputs(body: string): Inputs | undefined {
  const measureLine = field(body, 'Measure');
  if (!measureLine) return undefined;
  const meas = /^(.+?)(?: at (\d+) voices?)?$/.exec(measureLine)!;
  const comp = /^(.+?)(?:, (\d+) voices?)?$/.exec(field(body, 'Comparand') ?? '')!;
  const fm1 = field(body, 'FM-1 voices');
  const rig = /^(passed|failed)\b/.exec(field(body, 'Rig') ?? '')?.[1] as Inputs['rig'];
  const proto = /#(\d+)/.exec(field(body, 'Prototype') ?? '');
  const extras = [...body.matchAll(/^\*\*Extra:\*\*\s*(.+?): (\+.*|in Measure.*|unmeasured.*)$/gm)].map((m): Extra => ({
    gap: m[1].trim(),
    cost: m[2].startsWith('in Measure') ? 'measure' : m[2].startsWith('unmeasured') ? undefined : parseCost(m[2]),
  }));
  return {
    comparand: comp[1] ?? '', voices: comp[2] ? Number(comp[2]) : undefined, measure: meas[1], at: meas[2] ? Number(meas[2]) : undefined,
    fm1Voices: fm1 ? parseInt(fm1, 10) : undefined, extras, rig, prototype: proto ? Number(proto[1]) : undefined,
  };
}

export interface Row {
  issue: number;
  name: string;
  original: string;
  band: Band;
  cpu: number;
  modules: number;
  maxModules: number;
  bytes: number;
  maxBytes: number;
  /** a cost estimate went into the figures */
  est: boolean;
  /** CPU over RIG_CHECK with no passing rig run */
  unqualified: boolean;
  rigFailed: boolean;
  over: string[];
  missing: string[];
  boxes: Box[];
  blockedBy: number[];
  fm1Voices: number | undefined;
  voices: number | undefined;
  prototype: number | undefined;
}

const GAP_FREE = new Set<Tag | undefined>(['hardware', 'samples', undefined]);

/** An instrument's full-parity cost and band: the measured patch, plus its Extra lines, plus the Cost of every open
 * ticket its engine boxes cite. A patch measured as built (not an XL) must name every open card and needs XL box in an
 * Extra line. Costs only add, so a sum already over a limit is xl-only even when an input is missing. */
export function rowOf(issue: number, name: string, original: string, boxes: Box[], inputs: Inputs, base: Base, isXl: boolean,
  tickets: Map<number, Ticket>, fm1Voices: number | undefined): Row {
  const voices = inputs.voices ?? inputs.at;
  let { cpu, modules, bytes } = base;
  let est = false;
  const missing: string[] = [];
  const add = (c: Cost): void => {
    cpu += c.cpu * (c.perVoice ? voices ?? 1 : 1);
    modules += c.modules;
    bytes += c.bytes;
    est ||= c.est;
  };
  const extras = new Map(inputs.extras.map((x) => [x.gap, x]));
  for (const b of boxes) {
    if (b.tag !== 'card' && b.tag !== 'needs XL') continue;
    const x = extras.get(b.name);
    if (!x) { if (!isXl) missing.push(`${b.name}: no Extra line`); continue; }
    if (x.cost === undefined) missing.push(`${b.name}: unmeasured`);
    else if (x.cost !== 'measure') add(x.cost);
  }
  const blockedBy: number[] = [];
  for (const b of boxes) {
    if (b.tag !== 'engine') continue;
    if (b.ticket === undefined) { missing.push(`${b.name}: no ticket`); continue; }
    if (blockedBy.includes(b.ticket)) continue;
    const t = tickets.get(b.ticket);
    if (t && !t.open) continue;
    blockedBy.push(b.ticket);
    if (!t?.cost) missing.push(`#${b.ticket}: no Cost line`);
    else add(t.cost);
  }
  const over = [...base.over];
  if (modules > base.maxModules && !base.over.some((o) => o.includes('modules'))) over.push(`${modules} modules of ${base.maxModules}`);
  if (bytes > base.maxBytes && !base.over.some((o) => o.includes('bytes'))) over.push(`${bytes.toLocaleString('en-US')} bytes of ${base.maxBytes.toLocaleString('en-US')}`);
  const gaps = boxes.filter((b) => !GAP_FREE.has(b.tag));
  const rigFailed = inputs.rig === 'failed';
  const band: Band = !gaps.length ? 'full'
    : over.length || cpu > XL_ONLY ? 'xl-only'
    : missing.length ? 'unmeasured'
    : cpu > FITS || rigFailed ? 'tight'
    : 'reachable';
  const unqualified = (band === 'reachable' || band === 'tight') && cpu > RIG_CHECK && inputs.rig !== 'passed';
  return { issue, name, original, band, cpu, modules, maxModules: base.maxModules, bytes, maxBytes: base.maxBytes, est, unqualified, rigFailed,
    over, missing, boxes, blockedBy, fm1Voices: inputs.fm1Voices ?? fm1Voices, voices, prototype: inputs.prototype };
}

const n = (x: number): string => Math.round(x).toLocaleString('en-US');
const clip = (s: string, k = 70): string => (s.length > k ? `${s.slice(0, k - 1)}…` : s).replace(/\|/g, '\\|');
const counts = (boxes: Box[]): string => {
  const c = (t: Tag): number => boxes.filter((b) => b.tag === t).length;
  const parts = ([['card', 'card'], ['engine', 'engine'], ['needs XL', 'XL'], ['device UI', 'device UI']] as [Tag, string][])
    .filter(([t]) => c(t)).map(([t, w]) => `${c(t)} ${w}`);
  return parts.join(' · ') || '—';
};
const limitCell = (used: number, max: number): string => (used > max ? `**${n(used)}/${n(max)}**` : `${n(used)}/${n(max)}`);

/** the instrument tables, a section a band, each sorted by CPU */
export function renderInstruments(rows: Row[]): string {
  const out: string[] = [];
  for (const band of BANDS) {
    const rs = rows.filter((r) => r.band === band).sort((a, b) => a.cpu - b.cpu);
    if (!rs.length) continue;
    out.push(`### \`fit: ${band}\` (${rs.length})`, '', BAND_TEXT[band] + '.', '');
    out.push('| Instrument | Comparand | Voices (FM-1 / original) | CPU | Modules | Bytes | Over limits | Open gaps | Blocked by | XL-only gaps | Prototype |');
    out.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rs) {
      const xl = r.boxes.filter((b) => b.tag === 'needs XL').map((b) => clip(b.name)).join('; ') || '—';
      const voices = r.voices ? `${r.fm1Voices ?? '?'} / ${r.voices}` : '—';
      const cpu = [`${n(r.cpu)} %`, r.est && 'est.', r.unqualified && 'unqualified', r.rigFailed && 'rig failed'].filter(Boolean).join(' ');
      out.push(`| #${r.issue} ${r.name} | ${clip(r.original, 40)} | ${voices} | ${cpu} | ${limitCell(r.modules, r.maxModules)} | ${limitCell(r.bytes, r.maxBytes)} | ${r.over.join('; ') || '—'} | ${counts(r.boxes)} | ${r.blockedBy.map((t) => `#${t}`).join(' ') || '—'} | ${xl} | ${r.prototype ? `#${r.prototype}` : '—'} |`);
    }
    const missing = rs.filter((r) => r.missing.length);
    if (missing.length) out.push('', 'Missing inputs:', '', ...missing.map((r) => `- #${r.issue} ${r.name}: ${r.missing.join('; ')}`));
    out.push('');
  }
  return out.join('\n');
}

/** "Parity once closed": the reachable instruments whose every open gap is an engine box citing this ticket */
export function renderTickets(rows: Row[], tickets: Ticket[]): string {
  const lines = tickets.filter((t) => t.open).map((t) => {
    const blocks = rows.filter((r) => r.blockedBy.includes(t.number));
    const closes = blocks.filter((r) => r.band === 'reachable' && r.boxes.every((b) => GAP_FREE.has(b.tag) || b.tag === 'device UI' || (b.tag === 'engine' && b.ticket === t.number)));
    const near = blocks.filter((r) => r.band === 'reachable' || r.band === 'tight');
    return { t, blocks, closes, near };
  }).sort((a, b) => b.closes.length - a.closes.length || b.near.length - a.near.length || b.blocks.length - a.blocks.length || a.t.number - b.t.number);
  return ['| Ticket | Cost | Parity once closed | Blocks |', '|---|---|---|---|',
    ...lines.map(({ t, blocks, closes }) => {
      const c = t.cost;
      const cost = c ? `${c.cpu} % CPU${c.perVoice ? ' per voice' : ''}, ${c.modules} modules, ${c.bytes} B${c.est ? ' (est.)' : ''}` : 'no Cost line';
      return `| #${t.number} ${clip(t.title, 60)} | ${cost} | ${closes.map((r) => r.name).join(', ') || '—'} | ${blocks.map((r) => `${r.name} (${r.band})`).join(', ') || '—'} |`;
    })].join('\n');
}

export const START = '<!-- parity-status:start -->';
export const END = '<!-- parity-status:end -->';

/** the region of #375 between START and END */
export function renderRegion(rows: Row[], tickets: Ticket[], sha: string, date: string): string {
  return [START,
    '## Bands',
    '',
    `Generated by \`web/scripts/parity-status.ts\` at ${sha} on ${date} (D-149). Do not edit this section: change an instrument's boxes or input lines in its sub-issue, or a ticket's **Cost:** line, and rerun the script. A band judges the full-parity version: the measured patch at the original's voice count, plus each Extra line, plus the **Cost:** of every open ticket its engine boxes cite. *est.* means an estimate went into the figures; *unqualified* means over ${RIG_CHECK} % with no passing test-rig run.`,
    '',
    renderInstruments(rows),
    '## Engine features',
    '',
    'Open tickets that instruments\' engine boxes cite, and the sub-issues of this issue. Sorted by how many instruments each one brings to full parity, then by how many reachable or tight instruments it blocks.',
    '',
    renderTickets(rows, tickets),
    END].join('\n');
}

/** body with its region replaced; undefined when body has no START ... END markers */
export function withRegion(body: string, region: string): string | undefined {
  const a = body.indexOf(START), b = body.indexOf(END);
  if (a < 0 || b < a) return undefined;
  return body.slice(0, a) + region + body.slice(b + END.length);
}
