import { describe, it, expect } from 'vitest';
import {
  formatPhaseLabel,
  formatRefeedLabel,
  prefillMacrosForPhaseType,
  dayOfPhase,
  phaseForDate,
  targetsForDate,
  macroLevel,
  rowsForPhase,
  regressionPerPhase,
  type DailyTargets,
} from './phase-helpers';
import type { PhaseResponse, RefeedResponse } from '../api';

const cut: PhaseResponse = {
  id: 1, phase_type: 'cut', start_date: '2026-04-26', end_date: null,
  target_calories: 1850, target_protein_g: 180, target_carbs_g: 180,
  target_fat_g: 60, target_fiber_g: 30, target_weight_lbs: 165, refeeds: [],
};

const refeed: RefeedResponse = {
  id: 9, phase_id: 1, start_date: '2026-04-26', end_date: '2026-05-09',
  target_calories: 2350, target_protein_g: 180, target_carbs_g: 280,
  target_fat_g: 60, target_fiber_g: 30,
};

describe('formatPhaseLabel', () => {
  it('shows day count for open-ended phase', () => {
    expect(formatPhaseLabel(cut, '2026-05-10')).toBe('Cut · Day 15');
  });
  it('shows ends-in for bounded phase', () => {
    const bounded: PhaseResponse = { ...cut, end_date: '2026-06-09' };
    expect(formatPhaseLabel(bounded, '2026-05-10')).toBe('Cut · Day 15 · ends in 30 days');
  });
});

describe('formatRefeedLabel', () => {
  it('formats refeed day position', () => {
    expect(formatRefeedLabel(refeed, '2026-05-08')).toBe('Refeed Day 13 of 14');
  });
});

describe('prefillMacrosForPhaseType', () => {
  it('cut: protein 1.0g/lb, fat 0.4g/lb, calories = tdee × 0.80', () => {
    const r = prefillMacrosForPhaseType('cut', 180, 2400);
    expect(r.target_protein_g).toBe(180);          // 1.0 × 180
    expect(r.target_fat_g).toBe(72);               // 0.4 × 180
    expect(r.target_calories).toBe(1920);          // 2400 × 0.80
    expect(r.target_fiber_g).toBe(30);
    // carbs = (calories - protein*4 - fat*9) / 4
    // (1920 - 720 - 648) / 4 = 138
    expect(r.target_carbs_g).toBe(138);
  });
  it('bulk: protein 0.9g/lb, fat 0.5g/lb, calories = tdee × 1.10', () => {
    const r = prefillMacrosForPhaseType('bulk', 180, 2400);
    expect(r.target_protein_g).toBe(162);          // 0.9 × 180
    expect(r.target_fat_g).toBe(90);               // 0.5 × 180
    expect(r.target_calories).toBe(2640);          // 2400 × 1.10
    expect(r.target_fiber_g).toBe(35);
  });
  it('maintenance: protein 0.9g/lb, fat 0.4g/lb, calories = tdee', () => {
    const r = prefillMacrosForPhaseType('maintenance', 180, 2400);
    expect(r.target_calories).toBe(2400);
    expect(r.target_protein_g).toBe(162);
    expect(r.target_fat_g).toBe(72);
  });
});

describe('dayOfPhase', () => {
  it('counts days inclusively starting at 1', () => {
    expect(dayOfPhase(cut, '2026-04-26')).toBe(1);
    expect(dayOfPhase(cut, '2026-05-10')).toBe(15);
  });
});

describe('phaseForDate', () => {
  const closed: PhaseResponse = { ...cut, id: 2, start_date: '2026-04-01', end_date: '2026-04-25' };
  it('returns the phase covering the date', () => {
    expect(phaseForDate([cut, closed], '2026-05-01')?.id).toBe(1);
    expect(phaseForDate([cut, closed], '2026-04-20')?.id).toBe(2);
  });
  it('returns null when no phase covers', () => {
    expect(phaseForDate([closed], '2026-05-01')).toBeNull();
  });
});

describe('targetsForDate', () => {
  const envDefaults: DailyTargets = {
    calories: 1850, protein_g: 125, carbs_g: 250, fat_g: 50, fiber_g: 30,
    in_refeed: false, phase_type: null,
  };
  const cutWithRefeed: PhaseResponse = { ...cut, refeeds: [refeed] };

  it('returns env defaults when no phase covers the date', () => {
    expect(targetsForDate([], '2026-05-10', envDefaults)).toEqual(envDefaults);
  });
  it('returns phase targets when no refeed is active', () => {
    const t = targetsForDate([cut], '2026-05-15', envDefaults);
    expect(t.calories).toBe(1850);
    expect(t.in_refeed).toBe(false);
    expect(t.phase_type).toBe('cut');
  });
  it('returns refeed targets within the refeed window', () => {
    const t = targetsForDate([cutWithRefeed], '2026-04-30', envDefaults);
    expect(t.calories).toBe(2350);
    expect(t.in_refeed).toBe(true);
    expect(t.phase_type).toBe('cut');
  });
});

describe('macroLevel', () => {
  describe('cap (calories/carbs/fat)', () => {
    it('returns green when actual is at or under target', () => {
      expect(macroLevel(1700, 1850, { kind: 'cap' })).toBe('green');  // under
      expect(macroLevel(1850, 1850, { kind: 'cap' })).toBe('green');  // exactly at target
    });
    it('returns amber for 0–10% over target', () => {
      expect(macroLevel(1900, 1850, { kind: 'cap' })).toBe('amber');  // +2.7%
      expect(macroLevel(2000, 1850, { kind: 'cap' })).toBe('amber');  // +8.1%
      expect(macroLevel(2035, 1850, { kind: 'cap' })).toBe('amber');  // +10.0% exact
    });
    it('returns red for >10% over target', () => {
      expect(macroLevel(2100, 1850, { kind: 'cap' })).toBe('red');    // +13.5%
      expect(macroLevel(2500, 1850, { kind: 'cap' })).toBe('red');    // +35%
    });
    it('returns extreme when actual ≥ target + extremeOverAbsolute (calories)', () => {
      expect(macroLevel(3350, 1850, { kind: 'cap', extremeOverAbsolute: 1500 })).toBe('extreme');  // exactly +1500
      expect(macroLevel(4000, 1850, { kind: 'cap', extremeOverAbsolute: 1500 })).toBe('extreme');  // +2150
    });
    it('falls through to red when extremeOverAbsolute is NOT set even at huge overshoots', () => {
      expect(macroLevel(3350, 1850, { kind: 'cap' })).toBe('red');     // +1500 without threshold
      expect(macroLevel(5000, 1850, { kind: 'cap' })).toBe('red');     // +3150 without threshold
    });
    it('still classifies amber under the extreme threshold', () => {
      expect(macroLevel(1950, 1850, { kind: 'cap', extremeOverAbsolute: 1500 })).toBe('amber');
    });
    it('handles target ≤ 0 by returning green', () => {
      expect(macroLevel(500, 0, { kind: 'cap' })).toBe('green');
      expect(macroLevel(500, -1, { kind: 'cap' })).toBe('green');
    });
  });

  describe('minimum (protein/fiber)', () => {
    it('returns green when actual is at or over target', () => {
      expect(macroLevel(180, 180, { kind: 'minimum' })).toBe('green'); // exactly at
      expect(macroLevel(200, 180, { kind: 'minimum' })).toBe('green'); // over
    });
    it('returns amber when within 10% under target', () => {
      expect(macroLevel(175, 180, { kind: 'minimum' })).toBe('amber'); // -2.8%
      expect(macroLevel(162, 180, { kind: 'minimum' })).toBe('amber'); // -10% exact
    });
    it('returns red when more than 10% under target', () => {
      expect(macroLevel(150, 180, { kind: 'minimum' })).toBe('red');   // -16.7%
      expect(macroLevel(100, 180, { kind: 'minimum' })).toBe('red');   // -44%
    });
    it('never returns extreme for minimums even with absurd undershoots', () => {
      expect(macroLevel(0, 180, { kind: 'minimum' })).toBe('red');
      expect(macroLevel(0, 180, { kind: 'minimum', extremeOverAbsolute: 1500 })).toBe('red');
    });
    it('handles target ≤ 0 by returning green', () => {
      expect(macroLevel(0, 0, { kind: 'minimum' })).toBe('green');
    });
  });
});

describe('rowsForPhase', () => {
  const closedCut: PhaseResponse = {
    ...cut, id: 11, start_date: '2026-04-01', end_date: '2026-04-25',
    refeeds: [{ ...refeed, id: 21, phase_id: 11, start_date: '2026-04-10', end_date: '2026-04-12' }],
  };
  const rows = [
    { date: '2026-03-31', v: 0 },
    { date: '2026-04-05', v: 1 },
    { date: '2026-04-10', v: 2 },  // refeed
    { date: '2026-04-11', v: 3 },  // refeed
    { date: '2026-04-20', v: 4 },
    { date: '2026-04-26', v: 5 },
  ];
  it('keeps only rows inside the phase window', () => {
    const r = rowsForPhase(closedCut, rows);
    expect(r.map(x => x.date)).toEqual(['2026-04-05', '2026-04-10', '2026-04-11', '2026-04-20']);
  });
  it('excludes refeed days when requested', () => {
    const r = rowsForPhase(closedCut, rows, { excludeRefeeds: true });
    expect(r.map(x => x.date)).toEqual(['2026-04-05', '2026-04-20']);
  });
  it('treats open-ended phase as ending today', () => {
    const r = rowsForPhase(cut, rows, { todayISO: '2026-05-01' });
    expect(r.map(x => x.date)).toEqual(['2026-04-26']);
  });
});

describe('regressionPerPhase', () => {
  const phaseA: PhaseResponse = {
    ...cut, id: 31, start_date: '2026-04-01', end_date: '2026-04-30',
    refeeds: [],
  };
  const phaseB: PhaseResponse = {
    ...cut, id: 32, phase_type: 'bulk', start_date: '2026-05-01', end_date: null,
    refeeds: [],
  };
  it('computes slope/intercept anchored to phase.start_date', () => {
    // perfectly linear: y = 200 - 0.5 x relative to 2026-04-01
    const rows = [
      { date: '2026-04-01', value: 200 },
      { date: '2026-04-02', value: 199.5 },
      { date: '2026-04-03', value: 199 },
      { date: '2026-04-04', value: 198.5 },
      { date: '2026-04-05', value: 198 },
    ];
    const out = regressionPerPhase([phaseA], rows);
    expect(out).toHaveLength(1);
    expect(out[0].pointCount).toBe(5);
    expect(out[0].slope).toBeCloseTo(-0.5, 5);
    expect(out[0].intercept).toBeCloseTo(200, 5);
  });
  it('skips phases with fewer than 4 data points', () => {
    const rows = [
      { date: '2026-04-01', value: 200 },
      { date: '2026-04-02', value: 199 },
      { date: '2026-04-03', value: 198 },   // only 3 → skip
    ];
    expect(regressionPerPhase([phaseA], rows)).toEqual([]);
  });
  it('runs one regression per phase using only that phase\'s data', () => {
    const rows = [
      { date: '2026-04-01', value: 200 }, { date: '2026-04-10', value: 199 },
      { date: '2026-04-20', value: 198 }, { date: '2026-04-30', value: 197 },
      { date: '2026-05-02', value: 205 }, { date: '2026-05-05', value: 206 },
      { date: '2026-05-08', value: 207 }, { date: '2026-05-11', value: 208 },
    ];
    const out = regressionPerPhase([phaseA, phaseB], rows, { todayISO: '2026-05-15' });
    expect(out).toHaveLength(2);
    expect(out.find(r => r.phase.id === 31)?.slope).toBeLessThan(0);  // cut: losing weight
    expect(out.find(r => r.phase.id === 32)?.slope).toBeGreaterThan(0); // bulk: gaining
  });
  it('ignores rows with null value', () => {
    const rows = [
      { date: '2026-04-01', value: null },
      { date: '2026-04-02', value: 199 },
      { date: '2026-04-03', value: undefined },
      { date: '2026-04-04', value: 198 },
      { date: '2026-04-05', value: 197 },
      { date: '2026-04-06', value: 196 },
    ];
    const out = regressionPerPhase([phaseA], rows);
    expect(out[0].pointCount).toBe(4);
  });
});
