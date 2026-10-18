// Writes public/coverage.json (the About card's Test coverage figures) from coverage/coverage-summary.json; run by `npm run coverage`.
import { readFileSync, writeFileSync } from 'node:fs';
import { groupCoverage, type Summary } from '../src/coverage';

const here = new URL('..', import.meta.url);
const summary = JSON.parse(readFileSync(new URL('coverage/coverage-summary.json', here), 'utf8')) as Summary;
const stats = groupCoverage(summary, new Date().toISOString().slice(0, 10));
writeFileSync(new URL('public/coverage.json', here), `${JSON.stringify(stats, null, 2)}\n`);
console.log(`coverage: core ${stats.core.pct.toFixed(1)} % of ${stats.core.lines} lines, interface ${stats.interface.pct.toFixed(1)} % of ${stats.interface.lines} lines`);
