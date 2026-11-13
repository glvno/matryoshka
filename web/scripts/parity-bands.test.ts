// SPDX-License-Identifier: GPL-3.0-only
// The parity bands' rules (D-149): how a sub-issue's boxes and inputs read, and which band a full-parity cost falls in.
import { describe, expect, it } from 'vitest';
import { openBoxes, parseInputs, rowOf, type Base, type Ticket } from './parity-bands';

const base = (cpu: number, over: string[] = []): Base => ({ cpu, modules: 60, maxModules: 128, bytes: 3000, maxBytes: 3840, over });
const tickets = new Map<number, Ticket>([
  [1, { number: 1, title: 'a mode', open: true, cost: { cpu: 2, perVoice: true, modules: 0, bytes: 90, est: true } }],
  [2, { number: 2, title: 'no cost yet', open: true, cost: undefined }],
]);
const band = (body: string, b: Base, isXl = true) => rowOf(9, 'X', 'Orig', openBoxes(body), parseInputs(body)!, b, isXl, tickets, 4);
const inputs = '**Comparand:** Orig, 5 voices\n\n**Measure:** X XL at 5 voices\n';

describe('openBoxes', () => {
  it('reads the first tag as the current one and an engine box\'s first ticket after its tag', () => {
    expect(openBoxes([
      '- [ ] Saw and pulse — `card` (fits now), was `needs XL`',
      '- [x] Done — `card`',
      '- [ ] Linear decay — `engine: linear envelope decay` (#689; see #375)',
    ].join('\n'))).toEqual([
      { name: 'Saw and pulse', tag: 'card', ticket: undefined },
      { name: 'Linear decay', tag: 'engine', ticket: 689 },
    ]);
  });
});

describe('rowOf', () => {
  it('is full with only hardware and samples gaps open, whatever the cost', () => {
    expect(band(`${inputs}- [ ] Jacks — \`hardware\`\n- [ ] Kit — \`samples\``, base(200)).band).toBe('full');
  });
  it('adds a per-voice ticket cost at the comparand\'s voices and marks it an estimate', () => {
    const r = band(`${inputs}- [ ] Mode — \`engine: a mode\` (#1)`, base(70));
    expect([r.band, r.cpu, r.bytes, r.est, r.blockedBy]).toEqual(['reachable', 80, 3090, true, [1]]);
  });
  it('is tight over 90 %, and when the test rig failed under it', () => {
    expect(band(`${inputs}- [ ] Gap — \`needs XL\``, base(95)).band).toBe('tight');
    expect(band(`${inputs}**Rig:** failed\n- [ ] Gap — \`needs XL\``, base(50)).band).toBe('tight');
  });
  it('is xl-only over 130 % or over a limit, even with an input missing', () => {
    expect(band(`${inputs}- [ ] Gap — \`needs XL\``, base(131)).band).toBe('xl-only');
    expect(band(`${inputs}- [ ] Mode — \`engine: x\` (#2)`, base(40, ['300 cables of 255'])).band).toBe('xl-only');
  });
  it('is unmeasured when a ticket has no cost or a patch measured as built lacks an Extra line for a box', () => {
    expect(band(`${inputs}- [ ] Mode — \`engine: x\` (#2)`, base(40)).band).toBe('unmeasured');
    expect(band(`${inputs}- [ ] Card work — \`card\``, base(40), false).band).toBe('unmeasured');
    const extra = `${inputs}**Extra:** Card work: +5 % CPU, +3 modules, +100 B (measured)\n- [ ] Card work — \`card\``;
    expect(band(extra, base(40), false)).toMatchObject({ band: 'reachable', cpu: 45, modules: 63, bytes: 3100, est: false });
  });
});
