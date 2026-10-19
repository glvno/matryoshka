import { describe, expect, it } from 'vitest';
import { FM1_BUTTON_ROWS, buttonKind, jackColumn, tracePath } from './dock-buttons';
import { PANEL_BUTTONS } from './modules';

describe('dock button block', () => {
  it('lists the FM-1 buttons in device order, every patch button once', () => {
    expect(FM1_BUTTON_ROWS.map((r) => r.join(' '))).toEqual(['fx scl env lfo edit glo', 'home save arp seq play rec']);
    const all = FM1_BUTTON_ROWS.flat();
    for (const b of PANEL_BUTTONS) expect(all.filter((x) => x === b)).toHaveLength(1);
  });

  it('greys the device buttons, keeps PLAY as the transport', () => {
    expect(['home', 'save', 'seq', 'rec'].map(buttonKind)).toEqual(['device', 'device', 'device', 'device']);
    expect(buttonKind('play')).toBe('play');
    expect(PANEL_BUTTONS.map(buttonKind).every((k) => k === 'patch')).toBe(true);
  });

  it('puts the top row\'s jacks over their buttons and ARP\'s in the seventh column', () => {
    expect(['fx', 'scl', 'env', 'lfo', 'edit', 'glo'].map(jackColumn)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(jackColumn('arp')).toBe(6);
    // the jacks in output order are left to right
    expect(PANEL_BUTTONS.map(jackColumn)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('runs a top-row trace straight up and ARP\'s through the gap to its lane', () => {
    expect(tracePath({ x: 40, y: 60 }, { x: 40, y: 10 }, 50)).toBe('M40 60 V10');
    const arp = tracePath({ x: 100, y: 110 }, { x: 300, y: 10 }, 100);
    expect(arp).toBe('M100 110 V106 Q100 100 106 100 H294 Q300 100 300 94 V10');
  });

  it('shrinks the bends when the gap is tight', () => {
    expect(tracePath({ x: 0, y: 103 }, { x: 50, y: 10 }, 100)).toBe('M0 103 V103 Q0 100 3 100 H47 Q50 100 50 97 V10');
  });
});
