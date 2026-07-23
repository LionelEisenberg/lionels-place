import { describe, it, expect } from 'vitest'
import { statTiles, chipStats, activityExtras, formatVolumeShort } from './activity-stats'

const runM = {
  activity: 'run', duration_min: 33.2, distance_m: 5210, pace_s_per_km: 382,
  avg_hr: 156, credited_kcal: 312, elevation_gain_m: 48, avg_cadence_spm: 168,
}

describe('statTiles', () => {
  it('run: km + pace heroes, then time/hr/elev/spm/kcal', () => {
    const t = statTiles(runM)
    expect(t.map(x => x.u)).toEqual(['km', 'min/km', 'time', 'bpm ♥', 'elev m', 'spm', 'kcal'])
    expect(t[0]).toEqual({ v: '5.21', u: 'km', hero: true })
    expect(t[1].v).toBe('6:22')          // 382 s/km
    expect(t[1].hero).toBe(true)
  })

  it('run: includeTime=false drops the time tile', () => {
    const t = statTiles(runM, undefined, { includeTime: false })
    expect(t.map(x => x.u)).not.toContain('time')
  })

  it('bike: km/h derived from distance + duration', () => {
    const t = statTiles({ activity: 'bike', duration_min: 51, distance_m: 20400 })
    expect(t[0]).toEqual({ v: '20.4', u: 'km', hero: true })
    expect(t[1]).toEqual({ v: '24.0', u: 'km/h', hero: true })
  })

  it('bike: cadence tile appears when synced', () => {
    const t = statTiles({ activity: 'bike', duration_min: 51, distance_m: 20400, avg_cadence_spm: 82 })
    expect(t.map(x => x.u)).toContain('rpm')
    const bare = statTiles({ activity: 'bike', duration_min: 51, distance_m: 20400 })
    expect(bare.map(x => x.u)).not.toContain('rpm')
  })

  it('swim: meters hero + laps tile from extras', () => {
    const t = statTiles(
      { activity: 'swim', distance_m: 1500, duration_min: 37 },
      { laps: 50 },
      { includeTime: false },
    )
    expect(t[0]).toEqual({ v: (1500).toLocaleString(), u: 'meters', hero: true })
    expect(t[1]).toEqual({ v: '50', u: 'laps', hero: false })
  })

  it('swim: pace per 100m derived from distance + duration', () => {
    const t = statTiles({ activity: 'swim', distance_m: 1500, duration_min: 37 })
    const p = t.find(x => x.u === '/100m')
    expect(p?.v).toBe('2:28')          // 2220 s / 15 hundreds
    expect(p?.hero).toBeUndefined()
  })

  it('swim manual-only: laps become the hero; null metrics drop out', () => {
    const t = statTiles(
      { activity: 'swim', distance_m: null, duration_min: null, avg_hr: null, credited_kcal: null },
      { laps: 40 },
    )
    expect(t).toEqual([{ v: '40', u: 'laps', hero: true }])
  })

  it('strength with rows: volume + sets heroes, hr + kcal, no time tile in-log', () => {
    const t = statTiles(
      { activity: 'strength', duration_min: 52, avg_hr: 142, credited_kcal: 285 },
      { volume: 18420, sets: 24 },
      { includeTime: false },
    )
    expect(t.map(x => x.u)).toEqual(['lbs vol', 'sets', 'bpm ♥', 'kcal'])
    expect(t[0]).toEqual({ v: (18420).toLocaleString(), u: 'lbs vol', hero: true })
    expect(t[1]).toEqual({ v: '24', u: 'sets', hero: true })
  })

  it('strength without rows (pending-banner parity): time hero + hr + kcal', () => {
    const t = statTiles({ activity: 'strength', duration_min: 52, avg_hr: 142, credited_kcal: 285 })
    expect(t[0]).toEqual({ v: '52m', u: 'time', hero: true })
    expect(t.map(x => x.u)).toEqual(['time', 'bpm ♥', 'kcal'])
  })

  it('hike keeps elevation; row does not get one', () => {
    const hike = statTiles({ activity: 'hike', distance_m: 8000, duration_min: 95, elevation_gain_m: 320 })
    expect(hike.map(x => x.u)).toContain('elev m')
    const row = statTiles({ activity: 'row', distance_m: 2000, duration_min: 9, elevation_gain_m: 320 })
    expect(row.map(x => x.u)).not.toContain('elev m')
  })

  it('all-null metrics produce zero tiles', () => {
    expect(statTiles({
      activity: 'run', distance_m: null, duration_min: null, pace_s_per_km: null,
      avg_hr: null, credited_kcal: null, elevation_gain_m: null, avg_cadence_spm: null,
    })).toEqual([])
  })
})

describe('chipStats', () => {
  it('strength: duration · volume', () => {
    expect(chipStats({ activity: 'strength', duration_min: 52 }, { volume: 18420, sets: 24 }))
      .toBe('52m · 18.4k lbs')
  })
  it('strength without volume falls back to sets', () => {
    expect(chipStats({ activity: 'strength', duration_min: 52 }, { volume: 0, sets: 24 }))
      .toBe('52m · 24 sets')
  })
  it('strength without duration: volume only', () => {
    expect(chipStats({ activity: 'strength', duration_min: null }, { volume: 18420, sets: 24 }))
      .toBe('18.4k lbs')
  })
  it('strength with neither: exercise count', () => {
    expect(chipStats({ activity: 'strength', duration_min: null }, { volume: 0, sets: 0, exerciseCount: 6 }))
      .toBe('6 ex')
  })
  it('run: km · pace', () => {
    expect(chipStats(runM)).toBe('5.21 km · 6:22/km')
  })
  it('swim with distance: meters · duration', () => {
    expect(chipStats({ activity: 'swim', distance_m: 1500, duration_min: 37 }))
      .toBe(`${(1500).toLocaleString()} m · 37m`)
  })
  it('swim without distance: laps · duration', () => {
    expect(chipStats({ activity: 'swim', distance_m: null, duration_min: 37 }, { laps: 40 }))
      .toBe('40 laps · 37m')
  })
  it('bike: km · km/h', () => {
    expect(chipStats({ activity: 'bike', distance_m: 20400, duration_min: 51 }))
      .toBe('20.4 km · 24.0 km/h')
  })
  it('other activity: duration, else exercise count', () => {
    expect(chipStats({ activity: 'elliptical', duration_min: 45 })).toBe('45m')
    expect(chipStats({ activity: 'elliptical', duration_min: null }, { exerciseCount: 1 })).toBe('1 ex')
  })
})

describe('formatVolumeShort', () => {
  it('formats thousands with one decimal', () => {
    expect(formatVolumeShort(18420)).toBe('18.4k lbs')
  })
  it('keeps sub-1000 volumes whole', () => {
    expect(formatVolumeShort(840)).toBe('840 lbs')
  })
})

describe('activityExtras', () => {
  const rows = [
    { weight_lbs: '185', reps_sets: '8, 8, 7' },
    { weight_lbs: '70', reps_sets: '10, 9' },
  ]
  it('strength: sums volume and sets from its rows', () => {
    expect(activityExtras({ activity: 'strength', laps: null, exercises: rows }))
      .toEqual({ volume: 185 * 23 + 70 * 19, sets: 5, laps: null, exerciseCount: 2 })
  })
  it('cardio: volume is 0, laps pass through', () => {
    expect(activityExtras({ activity: 'swim', laps: 40, exercises: [{ weight_lbs: '', reps_sets: '40 Laps' }] }))
      .toEqual({ volume: 0, sets: 1, laps: 40, exerciseCount: 1 })
  })
})
