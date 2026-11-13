// SPDX-License-Identifier: GPL-3.0-only
// Vite-node removes the input script from argv; keep the executable separate from the importable exporter.
import { exportSelectedFactoryAudition, parseAuditionExportOptions, USAGE } from './factory-bank-audition';
const args = process.argv.slice(2);
if (args.includes('--help')) console.log(USAGE);
else {
  const { output, manifest } = exportSelectedFactoryAudition(parseAuditionExportOptions(args));
  console.log(JSON.stringify({ output, status: manifest.status, counts: manifest.counts, curatedPresets: manifest.curatedPresets.count }, null, 2));
}
