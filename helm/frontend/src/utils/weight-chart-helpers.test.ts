import { describe, it, expect } from 'vitest'
import {
  computeTrailingSMA,
  computeTrailingLoss,
  computeTrailingSlopeLabel,
  computeForecast60dValue,
  type WeightDay,
  type ProjectionForForecast,
} from './weight-chart-helpers'

describe('computeTrailingSMA', () => {
  it('returns mean of last N consecutive weigh-ins', () => {
    const days: WeightDay[] = [
      { date: '2026-05-01', weight_lbs: 200 },
      { date: '2026-05-02', weight_lbs: 199 },
      { date: '2026-05-03', weight_lbs: 198 },
      { date: '2026-05-04', weight_lbs: 197 },
      { date: '2026-05-05', weight_lbs: 196 },
      { date: '2026-05-06', weight_lbs: 195 },
      { date: '2026-05-07', weight_lbs: 194 },
    ]
    const expected = (200 + 199 + 198 + 197 + 196 + 195 + 194) / 7
    expect(computeTrailingSMA(days, '2026-05-07', 7)).toBe(expected)
  })

  it('uses only the last N when more than N weigh-ins exist', () => {
    const days: WeightDay[] = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, '0')}`,
      weight_lbs: 200 - i,
    }))
    // Last 7 weights (days 4-10 by 1-indexed) → 197, 196, 195, 194, 193, 192, 191
    const expected = (197 + 196 + 195 + 194 + 193 + 192 + 191) / 7
    expect(computeTrailingSMA(days, '2026-05-10', 7)).toBe(expected)
  })

  it('averages over the last N **weigh-ins** regardless of calendar gaps', () => {
    const days: WeightDay[] = [
      { date: '2026-05-01', weight_lbs: 200 },
      { date: '2026-05-03', weight_lbs: 199 },
      { date: '2026-05-05', weight_lbs: 198 },
      { date: '2026-05-08', weight_lbs: 197 },
      { date: '2026-05-11', weight_lbs: 196 },
      { date: '2026-05-12', weight_lbs: 195 },
      { date: '2026-05-14', weight_lbs: 194 },
    ]
    const expected = (200 + 199 + 198 + 197 + 196 + 195 + 194) / 7
    expect(computeTrailingSMA(days, '2026-05-14', 7)).toBe(expected)
  })

  it('returns null when fewer than N valid weigh-ins exist', () => {
    const days: WeightDay[] = [
      { date: '2026-05-01', weight_lbs: 200 },
      { date: '2026-05-02', weight_lbs: 199 },
      { date: '2026-05-03', weight_lbs: 198 },
    ]
    expect(computeTrailingSMA(days, '2026-05-03', 7)).toBeNull()
  })

  it('returns null when asOfDate is before any weigh-in', () => {
    const days: WeightDay[] = [
      { date: '2026-05-05', weight_lbs: 200 },
      { date: '2026-05-06', weight_lbs: 199 },
    ]
    expect(computeTrailingSMA(days, '2026-05-01', 7)).toBeNull()
  })

  it("returns the latest SMA when asOfDate is past the last weigh-in (helper is pure; projection-cutoff is the caller's job)", () => {
    const days: WeightDay[] = Array.from({ length: 7 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, '0')}`,
      weight_lbs: 200 - i,
    }))
    const expected = (200 + 199 + 198 + 197 + 196 + 195 + 194) / 7
    expect(computeTrailingSMA(days, '2026-06-01', 7)).toBe(expected)
  })

  it('filters out null, undefined, and zero weights defensively', () => {
    const days: WeightDay[] = [
      { date: '2026-05-01', weight_lbs: 200 },
      { date: '2026-05-02', weight_lbs: null },
      { date: '2026-05-03', weight_lbs: undefined },
      { date: '2026-05-04', weight_lbs: 0 },
      { date: '2026-05-05', weight_lbs: 199 },
      { date: '2026-05-06', weight_lbs: 198 },
      { date: '2026-05-07', weight_lbs: 197 },
      { date: '2026-05-08', weight_lbs: 196 },
      { date: '2026-05-09', weight_lbs: 195 },
      { date: '2026-05-10', weight_lbs: 194 },
    ]
    // 7 valid weights at the end: 200, 199, 198, 197, 196, 195, 194
    const expected = (200 + 199 + 198 + 197 + 196 + 195 + 194) / 7
    expect(computeTrailingSMA(days, '2026-05-10', 7)).toBe(expected)
  })
})

describe('computeTrailingLoss', () => {
  it('returns signed delta when SMAs exist at both ends of the window', () => {
    // 14 days of linear loss at -1 lb/day
    const days: WeightDay[] = Array.from({ length: 14 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, '0')}`,
      weight_lbs: 200 - i,
    }))
    // SMA on 2026-05-14: last 7 = weights at i=7..13 → 193,192,191,190,189,188,187 → mean 190
    // SMA on 2026-05-07: last 7 = weights at i=0..6 → 200,199,198,197,196,195,194 → mean 197
    // Loss = 190 - 197 = -7
    expect(computeTrailingLoss(days, '2026-05-14', 7)).toBe(-7)
  })

  it('returns null when SMA at asOfDate − N is null (no fallback)', () => {
    // 8 weigh-ins. SMA at end exists (last 7 of 8). SMA 7 days before end has only 1 weigh-in → null.
    const days: WeightDay[] = Array.from({ length: 8 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, '0')}`,
      weight_lbs: 200 - i,
    }))
    expect(computeTrailingLoss(days, '2026-05-08', 7)).toBeNull()
  })

  it('returns null when SMA at asOfDate itself is null', () => {
    const days: WeightDay[] = Array.from({ length: 3 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, '0')}`,
      weight_lbs: 200 - i,
    }))
    expect(computeTrailingLoss(days, '2026-05-03', 7)).toBeNull()
  })

  it('handles 14-day window correctly', () => {
    // 28 days of linear loss at -0.5 lb/day
    const days: WeightDay[] = Array.from({ length: 28 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, '0')}`,
      weight_lbs: 200 - 0.5 * i,
    }))
    // SMA at day 28 (i=27, w=186.5): last 14 = i=14..27, weights 193..186.5, mean = (193 + 186.5)/2 = 189.75
    // SMA at day 14 (i=13, w=193.5): last 14 = i=0..13, weights 200..193.5, mean = (200 + 193.5)/2 = 196.75
    // Loss = 189.75 - 196.75 = -7
    expect(computeTrailingLoss(days, '2026-05-28', 14)).toBe(-7)
  })
})

describe('computeTrailingSlopeLabel', () => {
  it('formats slope with sign and 3 decimal places', () => {
    // 14 days at -1 lb/day → 7-day loss = -7 → slope = -1.000 lb/day
    const days: WeightDay[] = Array.from({ length: 14 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, '0')}`,
      weight_lbs: 200 - i,
    }))
    expect(computeTrailingSlopeLabel(days, 7)).toBe('-1.000 lb/day')
  })

  it('includes a leading + for positive slopes', () => {
    // 14 days at +0.5 lb/day → 7-day loss = +3.5 → slope = +0.500 lb/day
    const days: WeightDay[] = Array.from({ length: 14 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, '0')}`,
      weight_lbs: 190 + 0.5 * i,
    }))
    expect(computeTrailingSlopeLabel(days, 7)).toBe('+0.500 lb/day')
  })

  it('returns null when the loss is uncomputable', () => {
    const days: WeightDay[] = Array.from({ length: 5 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, '0')}`,
      weight_lbs: 200 - i,
    }))
    expect(computeTrailingSlopeLabel(days, 7)).toBeNull()
  })

  it('returns null when there are no weigh-ins', () => {
    expect(computeTrailingSlopeLabel([], 7)).toBeNull()
  })
})

describe('computeForecast60dValue', () => {
  it('returns target_value at projected_date', () => {
    const proj: ProjectionForForecast = {
      target_value: 188,
      pace_per_week: -0.35,
      projected_date: '2026-08-09',
    }
    expect(computeForecast60dValue(proj, '2026-08-09')).toBe(188)
  })

  it('returns higher value before projected_date when losing weight', () => {
    // pace -0.35 lb/week → -0.05 lb/day. 75 days before projected_date,
    // weight = 188 + 0.05 * 75 = 191.75.
    const proj: ProjectionForForecast = {
      target_value: 188,
      pace_per_week: -0.35,
      projected_date: '2026-08-09',
    }
    expect(computeForecast60dValue(proj, '2026-05-26')).toBeCloseTo(191.75, 5)
  })

  it('returns lower value after projected_date when losing weight', () => {
    // pace -0.35 → -0.05/day. 10 days after projected_date, weight = 188 - 0.5 = 187.5.
    const proj: ProjectionForForecast = {
      target_value: 188,
      pace_per_week: -0.35,
      projected_date: '2026-08-09',
    }
    expect(computeForecast60dValue(proj, '2026-08-19')).toBeCloseTo(187.5, 5)
  })

  it('handles positive pace (bulk)', () => {
    // pace +0.7/wk → +0.1/day. 30 days before projected_date, weight = 200 - 0.1*30 = 197.
    const proj: ProjectionForForecast = {
      target_value: 200,
      pace_per_week: 0.7,
      projected_date: '2026-08-09',
    }
    expect(computeForecast60dValue(proj, '2026-07-10')).toBeCloseTo(197, 5)
  })

  it('returns null when pace_per_week is null', () => {
    const proj: ProjectionForForecast = {
      target_value: 188,
      pace_per_week: null,
      projected_date: '2026-08-09',
    }
    expect(computeForecast60dValue(proj, '2026-05-26')).toBeNull()
  })

  it('returns null when projected_date is null', () => {
    const proj: ProjectionForForecast = {
      target_value: 188,
      pace_per_week: -0.35,
      projected_date: null,
    }
    expect(computeForecast60dValue(proj, '2026-05-26')).toBeNull()
  })
})
