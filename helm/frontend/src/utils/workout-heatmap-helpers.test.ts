import { describe, it, expect } from 'vitest';
import {
  TYPE_ABBREV,
  setsLevel,
  volumeLevel,
  formatCompactVolume,
  mondayOf,
  daysBetween,
  addDays,
  buildHeatmapModel,
  buildMonthLabels,
  computeWeeklyAggregates,
  computeStreaks,
  isSickNote,
  dayToHeatmapSession,
  type SessionLike,
} from './workout-heatmap-helpers';

describe('TYPE_ABBREV', () => {
  it('maps each workout type to a 2-letter code', () => {
    expect(TYPE_ABBREV.Push).toBe('Ps');
    expect(TYPE_ABBREV.Pull).toBe('Pl');
    expect(TYPE_ABBREV.Legs).toBe('Lg');
    expect(TYPE_ABBREV.Cardio).toBe('Cd');
    expect(TYPE_ABBREV.Mixed).toBe('Mx');
  });
});

describe('setsLevel', () => {
  it('returns 0 for no sets', () => {
    expect(setsLevel(0)).toBe(0);
  });
  it('returns 1 for 1-15 sets', () => {
    expect(setsLevel(1)).toBe(1);
    expect(setsLevel(15)).toBe(1);
  });
  it('returns 2 for 16-18 sets', () => {
    expect(setsLevel(16)).toBe(2);
    expect(setsLevel(18)).toBe(2);
  });
  it('returns 3 for 19-21 sets', () => {
    expect(setsLevel(19)).toBe(3);
    expect(setsLevel(21)).toBe(3);
  });
  it('returns 4 for 22+ sets', () => {
    expect(setsLevel(22)).toBe(4);
    expect(setsLevel(500)).toBe(4);
  });
});

describe('volumeLevel', () => {
  it('returns 0 for no volume', () => {
    expect(volumeLevel(0)).toBe(0);
  });
  it('returns 1 for 1-999 lbs', () => {
    expect(volumeLevel(1)).toBe(1);
    expect(volumeLevel(999)).toBe(1);
  });
  it('returns 2 for 1000-2999 lbs', () => {
    expect(volumeLevel(1000)).toBe(2);
    expect(volumeLevel(2999)).toBe(2);
  });
  it('returns 3 for 3000-4999 lbs', () => {
    expect(volumeLevel(3000)).toBe(3);
    expect(volumeLevel(4999)).toBe(3);
  });
  it('returns 4 for 5000+ lbs', () => {
    expect(volumeLevel(5000)).toBe(4);
    expect(volumeLevel(20000)).toBe(4);
  });
});

describe('formatCompactVolume', () => {
  it('returns integer for under 1000', () => {
    expect(formatCompactVolume(0)).toBe('0');
    expect(formatCompactVolume(850)).toBe('850');
    expect(formatCompactVolume(999)).toBe('999');
  });
  it('returns one-decimal kilo for 1000-9999', () => {
    expect(formatCompactVolume(1000)).toBe('1.0k');
    expect(formatCompactVolume(1234)).toBe('1.2k');
    expect(formatCompactVolume(8500)).toBe('8.5k');
    expect(formatCompactVolume(9950)).toBe('9.9k');
    expect(formatCompactVolume(9999)).toBe('9.9k');
  });
  it('returns integer kilo for 10000+', () => {
    expect(formatCompactVolume(10000)).toBe('10k');
    expect(formatCompactVolume(12450)).toBe('12k');
    expect(formatCompactVolume(99500)).toBe('99k');
  });
});

describe('mondayOf', () => {
  it('returns the same date when given a Monday', () => {
    // 2026-02-09 is a Monday
    expect(mondayOf('2026-02-09')).toBe('2026-02-09');
  });
  it('rolls back to the prior Monday for mid-week dates', () => {
    // 2026-02-03 is a Tuesday → Monday is 2026-02-02
    expect(mondayOf('2026-02-03')).toBe('2026-02-02');
    // 2026-02-07 is a Saturday → Monday is 2026-02-02
    expect(mondayOf('2026-02-07')).toBe('2026-02-02');
    // 2026-02-08 is a Sunday → Monday is 2026-02-02
    expect(mondayOf('2026-02-08')).toBe('2026-02-02');
  });
  it('handles month boundaries', () => {
    // 2026-03-01 is a Sunday → Monday is 2026-02-23
    expect(mondayOf('2026-03-01')).toBe('2026-02-23');
  });
});

describe('daysBetween', () => {
  it('returns 0 for the same date', () => {
    expect(daysBetween('2026-05-12', '2026-05-12')).toBe(0);
  });
  it('returns positive difference for end > start', () => {
    expect(daysBetween('2026-02-03', '2026-02-10')).toBe(7);
    expect(daysBetween('2026-02-03', '2026-05-12')).toBe(98);
  });
  it('returns negative for end < start', () => {
    expect(daysBetween('2026-02-10', '2026-02-03')).toBe(-7);
  });
});

describe('addDays', () => {
  it('returns the same date for 0 days', () => {
    expect(addDays('2026-05-12', 0)).toBe('2026-05-12');
  });
  it('adds positive days', () => {
    expect(addDays('2026-02-03', 7)).toBe('2026-02-10');
  });
  it('subtracts when given negative days', () => {
    expect(addDays('2026-05-12', -55)).toBe('2026-03-18');
  });
  it('handles month boundary', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });
});

const session = (
  date: string,
  workoutType: SessionLike['workoutType'],
  exercises: number,
  sets: number,
  volume: number,
  cardio: string[] = [],
): SessionLike => ({ date, workoutType, exercises, totalSets: sets, totalVolume: volume, cardio });

describe('buildHeatmapModel', () => {
  it('produces a rectangular grid of weeks × 7 rows', () => {
    // 2026-02-03 is a Tuesday, 2026-05-12 is a Tuesday → 14 weeks + 1 extra column
    const model = buildHeatmapModel([], '2026-02-03', '2026-05-12');
    expect(model.startMondayISO).toBe('2026-02-02');
    expect(model.weekCount).toBe(15);
    expect(model.weeks).toHaveLength(15);
    expect(model.weeks.every(w => w.length === 7)).toBe(true);
  });

  it('marks cells before start_date and after today as out-of-range', () => {
    const model = buildHeatmapModel([], '2026-02-03', '2026-05-12');
    // First column starts on 2026-02-02 (Monday). Row 0 (Mon) is out of range.
    expect(model.weeks[0][0].inRange).toBe(false);
    expect(model.weeks[0][0].date).toBe('2026-02-02');
    // Row 1 (Tue 2026-02-03) is in range.
    expect(model.weeks[0][1].inRange).toBe(true);
    expect(model.weeks[0][1].date).toBe('2026-02-03');
    // Last column: today is Tue 2026-05-12 → rows after Tue are out of range.
    const last = model.weeks[model.weekCount - 1];
    expect(last[1].date).toBe('2026-05-12');
    expect(last[1].inRange).toBe(true);
    expect(last[2].inRange).toBe(false);
  });

  it('hydrates cells with session data', () => {
    const sessions = [
      session('2026-02-03', 'Push', 6, 80, 4500),
      session('2026-02-09', 'Legs', 7, 116, 8200),
    ];
    const model = buildHeatmapModel(sessions, '2026-02-03', '2026-05-12');
    // 2026-02-03 → week 0 row 1
    expect(model.weeks[0][1].workoutType).toBe('Push');
    expect(model.weeks[0][1].sets).toBe(80);
    expect(model.weeks[0][1].volume).toBe(4500);
    expect(model.weeks[0][1].exercises).toBe(6);
    expect(model.weeks[0][1].setsLevel).toBe(4);
    expect(model.weeks[0][1].volumeLevel).toBe(3);
    // 2026-02-09 (Mon) → week 1 row 0
    expect(model.weeks[1][0].workoutType).toBe('Legs');
    expect(model.weeks[1][0].setsLevel).toBe(4);
    expect(model.weeks[1][0].volumeLevel).toBe(4);
  });

  it('propagates cardio activity pips onto cells', () => {
    const sessions = [
      session('2026-02-03', 'Push', 6, 80, 4500, ['swim', 'run']),
      session('2026-02-09', 'Legs', 7, 116, 8200),
    ];
    const model = buildHeatmapModel(sessions, '2026-02-03', '2026-05-12');
    expect(model.weeks[0][1].cardio).toEqual(['swim', 'run']);
    expect(model.weeks[1][0].cardio).toEqual([]);
    // Empty cells default to no pips.
    expect(model.weeks[0][0].cardio).toEqual([]);
  });

  it('marks today', () => {
    const model = buildHeatmapModel([], '2026-02-03', '2026-05-12');
    const last = model.weeks[model.weekCount - 1];
    expect(last[1].isToday).toBe(true); // 2026-05-12 Tue
    expect(last[0].isToday).toBe(false);
  });

  it('assigns weekIndex to every cell', () => {
    const model = buildHeatmapModel([], '2026-02-03', '2026-05-12');
    for (let w = 0; w < model.weekCount; w++) {
      for (const cell of model.weeks[w]) {
        expect(cell.weekIndex).toBe(w);
      }
    }
  });

  it('assigns dayOfWeek to every cell (0=Mon..6=Sun)', () => {
    const model = buildHeatmapModel([], '2026-02-03', '2026-05-12');
    for (let w = 0; w < model.weekCount; w++) {
      for (let r = 0; r < 7; r++) {
        expect(model.weeks[w][r].dayOfWeek).toBe(r);
      }
    }
  });

  it('leaves empty-range cells with workoutType null and zeroed metrics', () => {
    const model = buildHeatmapModel([], '2026-02-03', '2026-05-12');
    const c = model.weeks[5][3];
    expect(c.workoutType).toBeNull();
    expect(c.sets).toBe(0);
    expect(c.setsLevel).toBe(0);
  });

  it('does not mark today when today is out of range', () => {
    // Inverted: startDate AFTER today should make every cell out of range,
    // including the cell that matches today.
    const model = buildHeatmapModel([], '2026-05-14', '2026-05-12');
    const todayCell = model.weeks
      .flat()
      .find(c => c.date === '2026-05-12');
    expect(todayCell?.inRange).toBe(false);
    expect(todayCell?.isToday).toBe(false);
  });

  it('flags cells whose date is in sickDates', () => {
    const sessions = [session('2026-02-03', 'Push', 6, 80, 4500)];
    const sickDates = new Set(['2026-02-03', '2026-02-05']);
    const model = buildHeatmapModel(sessions, '2026-02-03', '2026-05-12', sickDates);
    // Sick + workout day.
    expect(model.weeks[0][1].wasSick).toBe(true);
    expect(model.weeks[0][1].workoutType).toBe('Push');
    // Sick + rest day (Thursday 2026-02-05 → week 0 row 3).
    expect(model.weeks[0][3].date).toBe('2026-02-05');
    expect(model.weeks[0][3].wasSick).toBe(true);
    expect(model.weeks[0][3].workoutType).toBeNull();
    // Non-sick day.
    expect(model.weeks[1][0].wasSick).toBe(false);
  });

  it('defaults wasSick to false when no sickDates passed', () => {
    const model = buildHeatmapModel([], '2026-02-03', '2026-05-12');
    expect(model.weeks[0][1].wasSick).toBe(false);
    expect(model.weeks[5][3].wasSick).toBe(false);
  });
});

describe('isSickNote', () => {
  it('matches the standalone word "sick"', () => {
    expect(isSickNote('sick')).toBe(true);
    expect(isSickNote('i was sick today')).toBe(true);
    expect(isSickNote('sick day, slept 12 hours')).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(isSickNote('Sick')).toBe(true);
    expect(isSickNote('SICK')).toBe(true);
    expect(isSickNote('felt SiCk all day')).toBe(true);
  });
  it('rejects substrings of other words', () => {
    expect(isSickNote('sickening')).toBe(false);
    expect(isSickNote('homesick')).toBe(false);
    expect(isSickNote('seasickness')).toBe(false);
  });
  it('rejects notes without the word', () => {
    expect(isSickNote('healthy day')).toBe(false);
    expect(isSickNote('')).toBe(false);
  });
  it('handles null and undefined safely', () => {
    expect(isSickNote(null)).toBe(false);
    expect(isSickNote(undefined)).toBe(false);
  });
});

describe('buildMonthLabels', () => {
  it('emits one label per visible month spanning its columns', () => {
    const model = buildHeatmapModel([], '2026-02-03', '2026-05-12');
    const labels = buildMonthLabels(model);
    const names = labels.map(l => l.monthName);
    expect(names).toEqual(['Feb', 'Mar', 'Apr', 'May']);
    // Each label's column span is non-zero and they collectively cover all weeks.
    const total = labels.reduce((s, l) => s + l.columnSpan, 0);
    expect(total).toBe(model.weekCount);
  });

  it('column indices are non-decreasing and start at 0', () => {
    const model = buildHeatmapModel([], '2026-02-03', '2026-05-12');
    const labels = buildMonthLabels(model);
    expect(labels[0].columnIndex).toBe(0);
    for (let i = 1; i < labels.length; i++) {
      expect(labels[i].columnIndex).toBeGreaterThan(labels[i - 1].columnIndex);
    }
  });
});

describe('computeWeeklyAggregates', () => {
  it('sums sessions/sets/volume per week column', () => {
    const sessions = [
      session('2026-02-03', 'Push', 6, 80, 4500),   // week 0 (start Mon = 2026-02-02)
      session('2026-02-05', 'Legs', 6, 86, 4800),   // week 0
      session('2026-02-09', 'Push', 7, 90, 5200),   // week 1 (Mon 2026-02-09)
    ];
    const model = buildHeatmapModel(sessions, '2026-02-03', '2026-05-12');
    const agg = computeWeeklyAggregates(sessions, model);

    expect(agg[0].sessions).toBe(2);
    expect(agg[0].sets).toBe(166);
    expect(agg[0].volume).toBe(9300);
    expect(agg[0].weekStart).toBe('2026-02-02');
    expect(agg[0].weekLabel).toBe('Week of Feb 2');

    expect(agg[1].sessions).toBe(1);
    expect(agg[1].sets).toBe(90);
    expect(agg[1].weekStart).toBe('2026-02-09');
  });

  it('returns an entry for every week column (zeros for empty weeks)', () => {
    const model = buildHeatmapModel([], '2026-02-03', '2026-05-12');
    const agg = computeWeeklyAggregates([], model);
    expect(Object.keys(agg).length).toBe(model.weekCount);
    expect(agg[0].sessions).toBe(0);
    expect(agg[0].sets).toBe(0);
    expect(agg[0].volume).toBe(0);
  });
});

describe('computeStreaks', () => {
  it('returns 0/0 when no active days', () => {
    const r = computeStreaks(new Set(), '2026-02-03', '2026-05-12');
    expect(r.current).toBe(0);
    expect(r.longest).toBe(0);
  });

  it('counts current streak ending today', () => {
    const active = new Set([
      '2026-05-08','2026-05-09','2026-05-10','2026-05-11','2026-05-12',
    ]);
    const r = computeStreaks(active, '2026-02-03', '2026-05-12');
    expect(r.current).toBe(5);
  });

  it('allows current streak to end yesterday if today is a rest day', () => {
    const active = new Set([
      '2026-05-08','2026-05-09','2026-05-10','2026-05-11', // no May 12
    ]);
    const r = computeStreaks(active, '2026-02-03', '2026-05-12');
    expect(r.current).toBe(4);
  });

  it('returns 0 current if neither today nor yesterday is active', () => {
    const active = new Set(['2026-05-08','2026-05-09']);
    const r = computeStreaks(active, '2026-02-03', '2026-05-12');
    expect(r.current).toBe(0);
  });

  it('finds longest run anywhere in the range', () => {
    const active = new Set([
      // 7-day streak Feb 3-9
      '2026-02-03','2026-02-04','2026-02-05','2026-02-06','2026-02-07','2026-02-08','2026-02-09',
      // 3-day streak May 10-12
      '2026-05-10','2026-05-11','2026-05-12',
    ]);
    const r = computeStreaks(active, '2026-02-03', '2026-05-12');
    expect(r.longest).toBe(7);
    expect(r.current).toBe(3);
  });
});

describe('dayToHeatmapSession', () => {
  it('maps server day aggregates onto the heatmap session shape', () => {
    const day = {
      date: '2026-07-10', day_type: null, exercise_count: 0, total_sets: 0,
      total_volume: 0, is_cardio: true,
      sessions: [{ activity: 'run', exercises: [] }],
    }
    expect(dayToHeatmapSession(day as never)).toEqual({
      date: '2026-07-10', workoutType: 'Mixed', exercises: 0,
      totalSets: 0, totalVolume: 0, cardio: ['run'],
    })
  })

  it('treats an empty-string day_type as Mixed', () => {
    const day = {
      date: '2026-07-11', day_type: '', exercise_count: 0, total_sets: 0,
      total_volume: 0, is_cardio: true, sessions: [],
    }
    expect(dayToHeatmapSession(day as never).workoutType).toBe('Mixed')
  })

  it('collects cardio pips and passes day_type through', () => {
    const day = {
      date: '2026-06-17', day_type: 'Push', exercise_count: 5, total_sets: 18,
      total_volume: 4200, is_cardio: false,
      sessions: [{ activity: 'swim', exercises: [] }, { activity: 'strength', exercises: [] }],
    }
    expect(dayToHeatmapSession(day as never)).toEqual({
      date: '2026-06-17', workoutType: 'Push', exercises: 5,
      totalSets: 18, totalVolume: 4200, cardio: ['swim'],
    })
  })
})
