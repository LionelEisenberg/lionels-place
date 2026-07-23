import { describe, it, expect } from 'vitest'
import { rollingAverage, rhrColor, sleepStageRows, healthByDate } from './vitals-helpers'

describe('rollingAverage', () => {
  it('computes a trailing window, null until enough points', () => {
    expect(rollingAverage([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5])
  })
  it('skips nulls inside the window', () => {
    expect(rollingAverage([2, null, 4], 2)).toEqual([null, 2, 4])
  })
})

describe('rhrColor', () => {
  it('greens a low resting HR, reds a high one', () => {
    expect(rhrColor(50)).toContain('emerald')
    expect(rhrColor(70)).toContain('rose')
    expect(rhrColor(null)).toContain('muted')
  })
})

describe('sleepStageRows', () => {
  it('maps daily_health rows to stacked-bar data', () => {
    const rows = sleepStageRows([
      { date: '2026-06-02', sleep_deep_min: 92, sleep_light_min: 190, sleep_rem_min: 100, sleep_awake_min: 24 } as any,
    ])
    expect(rows[0]).toEqual({ date: '06-02', deep: 92, light: 190, rem: 100, awake: 24 })
  })
})

describe('healthByDate', () => {
  it('indexes rows by date', () => {
    const m = healthByDate([{ date: '2026-06-02', steps: 9240 } as any])
    expect(m.get('2026-06-02')!.steps).toEqual(9240)
  })
})
