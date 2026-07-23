import { describe, it, expect } from 'vitest';
import { buildDeficitChart, type DeficitInputDay } from './deficit-helpers';

const DAY_MS = 86_400_000;
// UTC-based ISO generator, matching the helper's `new Date('YYYY-MM-DD')` (UTC midnight) parsing.
function iso(offsetDays: number): string {
  return new Date(Date.UTC(2026, 1, 1) + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

describe('buildDeficitChart', () => {
  it('accumulates net_deficit across logged days', () => {
    const days: DeficitInputDay[] = [
      { date: '2026-02-01', calories_in: 1500, net_deficit: 1000 },
      { date: '2026-02-02', calories_in: 1600, net_deficit: 900 },
      { date: '2026-02-03', calories_in: 1700, net_deficit: 800 },
    ];
    const { data, stats } = buildDeficitChart(days);
    expect(data.map(d => d.cumulative)).toEqual([1000, 1900, 2700]);
    expect(data.map(d => d.fullDate)).toEqual(['2026-02-01', '2026-02-02', '2026-02-03']);
    expect(data.map(d => d.date)).toEqual(['02-01', '02-02', '02-03']);
    expect(stats.trackedDeficit).toBe(2700);
  });

  it('excludes days with no food logged (calories_in === 0) so unlogged days do not inject phantom deficits', () => {
    // Day 2 is a weigh-in-only day: full-TDEE net_deficit but no food was logged.
    const days: DeficitInputDay[] = [
      { date: '2026-02-01', calories_in: 1500, net_deficit: 1000 },
      { date: '2026-02-02', calories_in: 0, net_deficit: 2400 },
      { date: '2026-02-03', calories_in: 1700, net_deficit: 800 },
    ];
    const { data, stats } = buildDeficitChart(days);
    expect(data.map(d => d.fullDate)).toEqual(['2026-02-01', '2026-02-03']);
    expect(data.map(d => d.cumulative)).toEqual([1000, 1800]);
    expect(stats.trackedDeficit).toBe(1800); // NOT 4200
  });

  it('includes maintenance days (calories_in > 0) even when that day net_deficit is 0', () => {
    const days: DeficitInputDay[] = [
      { date: '2026-02-01', calories_in: 1500, net_deficit: 1000 },
      { date: '2026-02-02', calories_in: 2400, net_deficit: 0 },
      { date: '2026-02-03', calories_in: 1700, net_deficit: 800 },
    ];
    const { data } = buildDeficitChart(days);
    expect(data.map(d => d.fullDate)).toEqual(['2026-02-01', '2026-02-02', '2026-02-03']);
    expect(data.map(d => d.cumulative)).toEqual([1000, 1000, 1800]);
  });

  it('computes scale (actual) from carry-forward weight change x 3500', () => {
    const days: DeficitInputDay[] = [
      { date: '2026-02-01', calories_in: 1500, net_deficit: 1000, weight_lbs: 200 },
      { date: '2026-02-02', calories_in: 1500, net_deficit: 1000 },             // no weigh-in -> carries 200
      { date: '2026-02-03', calories_in: 1500, net_deficit: 1000, weight_lbs: 199 },
    ];
    const { data, stats } = buildDeficitChart(days);
    expect(data.map(d => d.scaleActual)).toEqual([0, 0, 3500]);
    expect(stats.scaleActualDeficit).toBe(3500);
  });

  it('computes scale (trend) deficit from weight regression x 3500, with accuracy once span >= 30 days', () => {
    // Perfectly linear: lose 0.1 lb/day from 200 over 30 days -> 3 lb -> 10,500 cal trend deficit.
    const days: DeficitInputDay[] = [];
    for (let i = 0; i <= 30; i++) {
      days.push({ date: iso(i), calories_in: 1500, net_deficit: 350, weight_lbs: 200 - 0.1 * i });
    }
    const { data, stats } = buildDeficitChart(days);
    expect(stats.trackedDeficit).toBe(350 * 31); // 10,850
    expect(stats.scaleDeficit).toBe(10500);
    // last plotted trend point equals the trend-deficit stat (last food day == last weigh-in day)
    expect(data[data.length - 1].scaleCumulative).toBe(10500);
    expect(stats.accuracy).toBe(Math.round((10850 / 10500) * 100)); // 103
  });

  it('returns null scale stats when there are fewer than 2 weigh-ins', () => {
    const days: DeficitInputDay[] = [
      { date: '2026-02-01', calories_in: 1500, net_deficit: 1000, weight_lbs: 200 },
      { date: '2026-02-02', calories_in: 1500, net_deficit: 1000 },
    ];
    const { data, stats } = buildDeficitChart(days);
    expect(stats.scaleDeficit).toBeNull();
    expect(stats.accuracy).toBeNull();
    expect(data.every(d => d.scaleCumulative === null)).toBe(true);
  });

  it('does not report accuracy until the weigh-in span reaches 30 days', () => {
    const days: DeficitInputDay[] = [];
    for (let i = 0; i <= 19; i++) {
      days.push({ date: iso(i), calories_in: 1500, net_deficit: 350, weight_lbs: 200 - 0.1 * i });
    }
    const { stats } = buildDeficitChart(days);
    expect(stats.scaleDeficit).toBe(6650); // 0.1*19*3500
    expect(stats.accuracy).toBeNull();
  });

  it('returns empty data and zero tracked deficit when there are no logged days', () => {
    const { data, stats } = buildDeficitChart([]);
    expect(data).toEqual([]);
    expect(stats.trackedDeficit).toBe(0);
    expect(stats.scaleDeficit).toBeNull();
    expect(stats.scaleActualDeficit).toBeNull();
  });
});
