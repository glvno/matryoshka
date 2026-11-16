// SPDX-License-Identifier: GPL-3.0-only
// emu:scenarios' timing records and its split over several emulators (`--shards N`, docs/EMULATOR.md): pure functions,
// tested in emu-shards.test.mjs.

/** The time a check took: wall ms since the previous check of its scenario, or since the scenario started. `clock` is
 *  { scenario, last } (the runner's), `now` the wall clock in ms; the clock moves on to `now` */
export function stamp(rec, clock, now) {
  if (!clock.scenario) return rec;
  const out = { ...rec, scenario: clock.scenario, ms: now - clock.last };
  clock.last = now;
  return out;
}

/** One scenario's record in timings.json: its wall time, the emulated time it spent (null on the rig or when it did not
 *  end), its checks and failures */
export function scenarioTiming(scenario, wallMs, emuMs, checks) {
  return {
    scenario,
    wallMs,
    emuMs: emuMs ?? null,
    checks: checks.length,
    failed: checks.filter((c) => !c.ok).length,
    skipped: checks.filter((c) => c.skipped).length,
  };
}

/** Deal `names` (in run order, without `connect`, which every shard runs first) over `n` shards so their times even out:
 *  the longest first, each onto the shard with the least time so far. `wallMs` holds a previous run's times by name; a
 *  name it lacks counts as the median of those it has (1 when it has none, which deals round the shards in run order).
 *  Each shard keeps the run order. Shards that would be empty are left out */
export function planShards(names, n, wallMs = {}) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`--shards ${n}: a whole number from 1`);
  const known = names.map((x) => wallMs[x]).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const cost = (x) => (Number.isFinite(wallMs[x]) && wallMs[x] > 0 ? wallMs[x] : median);
  const order = new Map(names.map((x, i) => [x, i]));
  const shards = Array.from({ length: n }, () => ({ total: 0, names: [] }));
  // (a stable sort: equal costs keep the run order, so unmeasured names go round the shards in turn)
  for (const x of [...names].sort((a, b) => cost(b) - cost(a))) {
    const s = shards.reduce((best, c) => (c.total < best.total ? c : best));
    s.names.push(x);
    s.total += cost(x);
  }
  return shards.filter((s) => s.names.length).map((s) => ({ ms: s.total, names: s.names.sort((a, b) => order.get(a) - order.get(b)) }));
}

/** The shards' checks as one list in run order: by scenario (as `names` orders them; `connect` first, a check of no
 *  scenario last), then by shard. Each check gets its shard's number (1..). A shard that ended with an error and no
 *  failed check gets one failed check saying so */
export function mergeShards(names, shards) {
  const rank = (s) => (s === 'connect' ? -1 : names.includes(s) ? names.indexOf(s) : names.length);
  const all = [];
  shards.forEach(({ results, exit }, i) => {
    for (const r of results) all.push({ ...r, shard: i + 1 });
    if (exit !== 0 && !results.some((r) => !r.ok))
      all.push({ name: `shard ${i + 1}: ran to the end`, status: 'fail', ok: false, detail: `exit ${exit}`, shard: i + 1 });
  });
  return all
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (rank(a.r.scenario) - rank(b.r.scenario)) || (a.r.shard - b.r.shard) || (a.i - b.i))
    .map(({ r }) => r);
}
