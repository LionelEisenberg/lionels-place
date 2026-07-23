/** Pure transforms for Google Health vitals. No React, no recharts. */
import type { DailyHealthResponse } from '../api'

/** Trailing simple moving average; null until `window` non-null values are available. */
export function rollingAverage(values: (number | null)[], window: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < window - 1) return null
    const slice = values.slice(i - window + 1, i + 1).filter((v): v is number => v != null)
    return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : null
  })
}

/** Resting HR color: lower is better. */
export function rhrColor(v: number | null): string {
  if (v == null) return 'var(--text-muted)'
  if (v <= 55) return 'var(--accent-emerald)'
  if (v <= 64) return 'var(--accent-amber)'
  return 'var(--accent-rose)'
}

/** HRV color vs a personal baseline: higher is better. */
export function hrvColor(v: number | null, baseline: number | null): string {
  if (v == null) return 'var(--text-muted)'
  if (baseline == null) return 'var(--accent-violet)'
  if (v >= baseline * 1.05) return 'var(--accent-emerald)'
  if (v <= baseline * 0.9) return 'var(--accent-rose)'
  return 'var(--accent-violet)'
}

/** daily_health rows -> recharts stacked-bar rows (MM-DD axis labels). */
export function sleepStageRows(rows: DailyHealthResponse[]): { date: string; deep: number; light: number; rem: number; awake: number }[] {
  return rows.map(r => ({
    date: r.date.slice(5),
    deep: r.sleep_deep_min ?? 0,
    light: r.sleep_light_min ?? 0,
    rem: r.sleep_rem_min ?? 0,
    awake: r.sleep_awake_min ?? 0,
  }))
}

/** Index daily_health rows by their YYYY-MM-DD date (for merging into the daily table). */
export function healthByDate(rows: DailyHealthResponse[]): Map<string, DailyHealthResponse> {
  return new Map(rows.map(r => [r.date, r]))
}
