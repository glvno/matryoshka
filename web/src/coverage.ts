// The About card's Test coverage figures. `npm run coverage` runs the tests with V8 coverage, then scripts/coverage-stats.ts
// groups the per-file line counts with `groupCoverage`. Release preparation retains the measured display record;
// deployment validates and copies it without running tests. Files in neither group are absent from both figures.

/** the sound engine, modules, patch model, binary format, assemblies, polyphony, arpeggiator, CPU estimate, protocol */
export const CORE = ['engine.ts', 'modules.ts', 'patch.ts', 'parameter-routing.ts', 'patchbin.ts', 'assembly.ts', 'poly.ts', 'arpeggiator.ts', 'cpu.ts', 'protocol.ts'];

/** the browser interface: everything that draws or handles the page */
export const INTERFACE = ['editor.ts', 'main.ts', 'tutorial/tutorial.ts', 'bank.ts', 'assemblies.ts', 'browser.ts', 'scope-view.ts', 'env-view.ts',
  'flasher.ts', 'flasher/fm1ota.js', 'flasher/fm1pkg.js', 'deck.ts', 'piano.ts', 'slider-jack.ts', 'selector.ts', 'picker.ts', 'flaws-panel.ts',
  'parameter-menu.ts', 'popover.ts', 'resize-handle.ts', 'about.ts', 'audio.ts', 'worklet.ts', 'device.ts', 'input.ts', 'focus.ts'];

export interface Group { pct: number; lines: number }
/** what the build writes to public/coverage.json */
export interface CoverageStats {
  asOf: string; core: Group; interface: Group;
  measurement?: { label: string; historical: boolean };
}

/** a line of Vitest's json-summary: file path → line counts */
export type Summary = Record<string, { lines: { total: number; covered: number } }>;

function group(summary: Summary, files: string[]): Group {
  let total = 0;
  let covered = 0;
  for (const [path, v] of Object.entries(summary)) {
    const rel = path.replace(/\\/g, '/').split('/src/')[1];
    if (rel && files.includes(rel)) (total += v.lines.total), (covered += v.lines.covered);
  }
  return { pct: total ? (100 * covered) / total : 0, lines: total };
}

export function groupCoverage(summary: Summary, asOf: string): CoverageStats {
  return { asOf, core: group(summary, CORE), interface: group(summary, INTERFACE) };
}

export function isCoverageStats(x: unknown): x is CoverageStats {
  const s = x as CoverageStats;
  const validGroup = (g: Group | undefined): boolean => !!g && Number.isFinite(g.pct) && g.pct >= 0 && g.pct <= 100
    && Number.isInteger(g.lines) && g.lines >= 0;
  return !!s && typeof s.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.asOf)
    && validGroup(s.core) && validGroup(s.interface)
    && (s.measurement === undefined || (typeof s.measurement?.label === 'string'
      && s.measurement.label.length > 0 && typeof s.measurement.historical === 'boolean'));
}

/** Plain provenance wording for the About card; callers escape it as ordinary text. */
export function coverageMeasurement(stats: CoverageStats): string {
  return stats.measurement ? `Last measured on ${stats.measurement.label}` : 'Vitest measurement';
}
