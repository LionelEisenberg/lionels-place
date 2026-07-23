/**
 * Pure helpers for the Workout Log heatmap.
 *
 * The heatmap renders one row per day-of-week (Mon..Sun) and one column per
 * calendar week, covering every day from the user's first logged session
 * through today. All functions in here are pure and unit-tested.
 */

import { toLocalISO } from '../dates';
import type { DayLog } from '../api';

export type WorkoutType = 'Push' | 'Pull' | 'Legs' | 'Cardio' | 'Mixed';

/** Day-type palette — shared by the heatmap tooltip and the strength card's PPL tag. */
export const TYPE_COLORS: Record<WorkoutType, string> = {
  Push: 'var(--accent-rose)', Pull: 'var(--accent-sky)',
  Legs: 'var(--accent-emerald)', Cardio: 'var(--accent-orange)',
  Mixed: 'var(--accent-indigo)',
};

export const TYPE_ABBREV: Record<WorkoutType, string> = {
  Push: 'Ps',
  Pull: 'Pl',
  Legs: 'Lg',
  Cardio: 'Cd',
  Mixed: 'Mx',
};

export type Level = 0 | 1 | 2 | 3 | 4;

/** Map a set count to a 0-4 intensity bucket. Thresholds approximate quartiles
 *  of observed session distribution so each bucket holds roughly a quarter of
 *  sessions. */
export function setsLevel(sets: number): Level {
  if (sets >= 22) return 4;
  if (sets >= 19) return 3;
  if (sets >= 16) return 2;
  if (sets >= 1) return 1;
  return 0;
}

/** Map a total-volume (lbs) value to a 0-4 intensity bucket. */
export function volumeLevel(volume: number): Level {
  if (volume >= 5000) return 4;
  if (volume >= 3000) return 3;
  if (volume >= 1000) return 2;
  if (volume >= 1) return 1;
  return 0;
}

/**
 * Compact volume formatter for cell bottom-right text.
 *   <1000       → "850"
 *   1000-9999   → "1.2k"
 *   ≥10000      → "12k"
 */
export function formatCompactVolume(volume: number): string {
  if (volume < 1000) return String(Math.round(volume));
  if (volume < 10000) {
    // Truncate to one decimal place (don't round up — 1299 should show 1.2k).
    const tenths = Math.floor(volume / 100) / 10;
    return `${tenths.toFixed(1)}k`;
  }
  return `${Math.floor(volume / 1000)}k`;
}

//--------------------------------------------------------------------
// Date helpers — all dates are YYYY-MM-DD strings in local time.
//--------------------------------------------------------------------

function parse(iso: string): Date {
  // Anchor at noon to avoid DST edge cases when only the date matters.
  return new Date(`${iso}T12:00:00`);
}

/** Return the ISO date of the Monday on or before `isoDate`. */
export function mondayOf(isoDate: string): string {
  const d = parse(isoDate);
  // JS: 0 = Sunday, 1 = Monday, ..., 6 = Saturday.
  // We want offset to Monday: Sun → -6, Mon → 0, Tue → -1, ..., Sat → -5.
  const offset = d.getDay() === 0 ? -6 : 1 - d.getDay();
  d.setDate(d.getDate() + offset);
  return toLocalISO(d);
}

/** Day count from `start` to `end` (end - start). May be negative. */
export function daysBetween(startISO: string, endISO: string): number {
  const ms = parse(endISO).getTime() - parse(startISO).getTime();
  return Math.round(ms / 86_400_000);
}

/** Return `isoDate + days` as YYYY-MM-DD. */
export function addDays(isoDate: string, days: number): string {
  const d = parse(isoDate);
  d.setDate(d.getDate() + days);
  return toLocalISO(d);
}

//--------------------------------------------------------------------
// Heatmap model
//--------------------------------------------------------------------

export type SessionLike = {
  date: string;                    // YYYY-MM-DD
  workoutType: WorkoutType;
  exercises: number;               // count (component passes `s.exercises.length`)
  totalSets: number;
  totalVolume: number;
  cardio: string[];                // non-strength activity types, in card order (swim, run, …)
};

export type HeatmapCell = {
  date: string;                    // YYYY-MM-DD
  inRange: boolean;
  dayOfMonth: number;              // 1-31
  weekIndex: number;               // 0-based column
  dayOfWeek: number;               // 0=Mon, 6=Sun (matches row index within a week)
  workoutType: WorkoutType | null;
  exercises: number;
  sets: number;
  volume: number;
  setsLevel: Level;
  volumeLevel: Level;
  isToday: boolean;
  cardio: string[];                // non-strength activity types (sport pips)
  wasSick: boolean;                // user marked this day as sick in their daily notes
};

const SICK_REGEX = /\bsick\b/i;

/** True if the daily-entry notes string contains the standalone word "sick"
 *  (case-insensitive, word boundary so "sickening"/"homesick" do not match). */
export function isSickNote(notes: string | null | undefined): boolean {
  if (!notes) return false;
  return SICK_REGEX.test(notes);
}

export type HeatmapModel = {
  weeks: HeatmapCell[][];          // weeks[w] is exactly 7 cells (Mon..Sun)
  weekCount: number;
  startMondayISO: string;          // Monday on or before startDateISO
};

/**
 * Build a rectangular weeks × 7 grid covering startDateISO → todayISO.
 * Cells outside that range (filler at the start/end weeks) have
 * `inRange: false` and zeroed data.
 */
export function buildHeatmapModel(
  sessions: SessionLike[],
  startDateISO: string,
  todayISO: string,
  sickDates?: Set<string>,
): HeatmapModel {
  const startMondayISO = mondayOf(startDateISO);
  const totalDays = daysBetween(startMondayISO, todayISO) + 1;
  // Round up to a full week so the grid is rectangular.
  const weekCount = Math.ceil(totalDays / 7);

  const byDate = new Map<string, SessionLike>();
  for (const s of sessions) byDate.set(s.date, s);

  const weeks: HeatmapCell[][] = [];
  for (let w = 0; w < weekCount; w++) {
    const week: HeatmapCell[] = [];
    for (let r = 0; r < 7; r++) {
      const date = addDays(startMondayISO, w * 7 + r);
      const inRange = date >= startDateISO && date <= todayISO;
      const s = inRange ? byDate.get(date) : undefined;
      const sets = s?.totalSets ?? 0;
      const volume = s?.totalVolume ?? 0;
      week.push({
        date,
        inRange,
        dayOfMonth: parse(date).getDate(),
        weekIndex: w,
        dayOfWeek: r,
        workoutType: s?.workoutType ?? null,
        exercises: s?.exercises ?? 0,
        sets,
        volume,
        setsLevel: setsLevel(sets),
        volumeLevel: volumeLevel(volume),
        isToday: inRange && date === todayISO,
        cardio: s?.cardio ?? [],
        wasSick: sickDates?.has(date) ?? false,
      });
    }
    weeks.push(week);
  }

  return { weeks, weekCount, startMondayISO };
}

const MONTH_NAMES = [
  'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec',
] as const;

export type MonthLabel = {
  month: number;                   // 0-11
  monthName: string;
  columnIndex: number;             // 0-based column where this label starts
  columnSpan: number;              // how many columns it spans
};

/**
 * For each visible month, return where its label should sit above the grid.
 * A month "starts" at the column containing its first in-range day; the
 * span runs until the next month's start (or end of grid).
 */
export function buildMonthLabels(model: HeatmapModel): MonthLabel[] {
  const starts: Array<{ month: number; col: number }> = [];
  for (let w = 0; w < model.weekCount; w++) {
    for (const cell of model.weeks[w]) {
      if (!cell.inRange) continue;
      const m = parse(cell.date).getMonth();
      if (starts.length === 0 || starts[starts.length - 1].month !== m) {
        starts.push({ month: m, col: w });
        break; // only need to find the month-start once per column
      }
    }
  }
  const labels: MonthLabel[] = [];
  for (let i = 0; i < starts.length; i++) {
    const { month, col } = starts[i];
    const nextCol = i + 1 < starts.length ? starts[i + 1].col : model.weekCount;
    labels.push({
      month,
      monthName: MONTH_NAMES[month],
      columnIndex: col,
      columnSpan: nextCol - col,
    });
  }
  return labels;
}

export type WeeklyAggregate = {
  weekStart: string;               // Monday YYYY-MM-DD
  weekLabel: string;               // e.g., "Week of Feb 10"
  sessions: number;
  sets: number;
  volume: number;
};

/**
 * Sum sessions/sets/volume per week column. Returns a `Record<weekIndex, …>`
 * with an entry for every column in the model (zeros for empty weeks).
 */
export function computeWeeklyAggregates(
  sessions: SessionLike[],
  model: HeatmapModel,
): Record<number, WeeklyAggregate> {
  const out: Record<number, WeeklyAggregate> = {};
  for (let w = 0; w < model.weekCount; w++) {
    const weekStart = addDays(model.startMondayISO, w * 7);
    const d = parse(weekStart);
    const monthName = MONTH_NAMES[d.getMonth()];
    out[w] = {
      weekStart,
      weekLabel: `Week of ${monthName} ${d.getDate()}`,
      sessions: 0,
      sets: 0,
      volume: 0,
    };
  }
  for (const s of sessions) {
    const offset = daysBetween(model.startMondayISO, s.date);
    if (offset < 0) continue;
    const w = Math.floor(offset / 7);
    if (w >= model.weekCount) continue;
    out[w].sessions += 1;
    out[w].sets += s.totalSets;
    out[w].volume += s.totalVolume;
  }
  return out;
}

/**
 * Compute streak stats over the date range [startISO, todayISO].
 *
 * - `current`: consecutive active days ending on today; OR, if today is a
 *   rest day, consecutive active days ending on yesterday. Otherwise 0.
 * - `longest`: longest run of consecutive active days anywhere in the
 *   range.
 */
export function computeStreaks(
  activeDates: Set<string>,
  startISO: string,
  todayISO: string,
): { current: number; longest: number } {
  // Longest: scan the full inclusive range.
  let longest = 0;
  let run = 0;
  const total = daysBetween(startISO, todayISO);
  for (let i = 0; i <= total; i++) {
    const d = addDays(startISO, i);
    if (activeDates.has(d)) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }

  // Current: walk back from today (or yesterday if today is a rest day).
  let current = 0;
  let cursor = todayISO;
  if (!activeDates.has(cursor)) {
    cursor = addDays(cursor, -1);
  }
  while (cursor >= startISO && activeDates.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }

  return { current, longest };
}

/** Heatmap/streak input for one server-assembled day. Only days the user
 *  logged or locked in arrive from the server — never-confirmed Google-only
 *  activities are filtered out of the log view. */
export function dayToHeatmapSession(day: DayLog): SessionLike {
  return {
    date: day.date,
    workoutType: day.day_type || 'Mixed',
    exercises: day.exercise_count,
    totalSets: day.total_sets,
    totalVolume: day.total_volume,
    cardio: day.sessions.filter(a => a.activity !== 'strength').map(a => a.activity),
  };
}
