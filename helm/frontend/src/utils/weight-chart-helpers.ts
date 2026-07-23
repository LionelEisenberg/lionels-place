/** Pure trailing-window math for the weight chart. No React, no recharts. */
export type WeightDay = {
  date: string
  weight_lbs: number | null | undefined
}

/** Minimal projection shape needed for the 60-day forecast line.
 *  Mirrors the relevant fields of `api.ts → WeightProjectionResponse` so this
 *  module stays free of API-layer imports. */
export type ProjectionForForecast = {
  target_value: number
  pace_per_week: number | null
  projected_date: string | null  // ISO YYYY-MM-DD
}

/**
 * Value of the backend's 60-day projection line at a given date.
 *
 * The projection line is defined by:
 *   - slope per day = pace_per_week / 7
 *   - a known point: (projected_date, target_value)
 *
 * Returns null when either field is missing (e.g., fewer than 7 weigh-ins
 * in the backend window). By construction this line passes through the goal
 * exactly at `projected_date`, so it visually matches the "Days to Goal" stat.
 */
export function computeForecast60dValue(
  projection: ProjectionForForecast,
  dateIso: string,
): number | null {
  if (projection.pace_per_week == null || projection.projected_date == null) {
    return null
  }
  const slopePerDay = projection.pace_per_week / 7
  const projectedTs = new Date(projection.projected_date + 'T00:00:00Z').getTime()
  const dateTs = new Date(dateIso + 'T00:00:00Z').getTime()
  const daysFromProjected = (dateTs - projectedTs) / 86_400_000
  return projection.target_value + slopePerDay * daysFromProjected
}

export function computeTrailingSMA(
  weightDays: WeightDay[],
  asOfDate: string,
  window: 7 | 14,
): number | null {
  const valid = weightDays.filter(
    (d) =>
      d.date <= asOfDate &&
      d.weight_lbs != null &&
      (d.weight_lbs as number) > 0,
  )
  if (valid.length < window) return null
  const last = valid.slice(-window)
  const sum = last.reduce((a, b) => a + (b.weight_lbs as number), 0)
  return sum / window
}

export function computeTrailingLoss(
  weightDays: WeightDay[],
  asOfDate: string,
  window: 7 | 14,
): number | null {
  const current = computeTrailingSMA(weightDays, asOfDate, window)
  if (current == null) return null

  const asOf = new Date(asOfDate + 'T00:00:00Z')
  const prior = new Date(asOf.getTime() - window * 86_400_000)
  const priorIso = prior.toISOString().slice(0, 10)

  const past = computeTrailingSMA(weightDays, priorIso, window)
  if (past == null) return null

  return current - past
}

export function computeTrailingSlopeLabel(
  weightDays: WeightDay[],
  window: 7 | 14,
): string | null {
  const valid = weightDays.filter(
    (d) => d.weight_lbs != null && (d.weight_lbs as number) > 0,
  )
  if (valid.length === 0) return null
  const latestDate = valid[valid.length - 1].date
  const loss = computeTrailingLoss(valid, latestDate, window)
  if (loss == null) return null
  const slope = loss / window
  return `${slope > 0 ? '+' : ''}${slope.toFixed(3)} lb/day`
}
