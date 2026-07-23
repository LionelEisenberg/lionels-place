import { describe, it, expect } from 'vitest'
import { formatPace, formatRunDuration, splitPace, projectRoute, nearestPointIndex, type LatLng } from './run-helpers'

describe('formatRunDuration', () => {
  it('formats minutes with second precision', () => {
    expect(formatRunDuration(28.71)).toBe('28:43')   // 1722.6 s -> 1723 s
    expect(formatRunDuration(29.04)).toBe('29:02')
    expect(formatRunDuration(0.5)).toBe('0:30')
  })
  it('rolls into hours past 60 minutes', () => {
    expect(formatRunDuration(62.09)).toBe('1:02:05')
    expect(formatRunDuration(60)).toBe('1:00:00')
  })
  it('is empty for null/invalid', () => {
    expect(formatRunDuration(null)).toBe('')
    expect(formatRunDuration(undefined)).toBe('')
    expect(formatRunDuration(-1)).toBe('')
  })
})

describe('formatPace', () => {
  it('formats seconds-per-km as m:ss', () => {
    expect(formatPace(331)).toBe('5:31')
    expect(formatPace(360)).toBe('6:00')
    expect(formatPace(59.4)).toBe('0:59')
  })
  it('is empty for null/invalid', () => {
    expect(formatPace(null)).toBe('')
    expect(formatPace(undefined)).toBe('')
    expect(formatPace(0)).toBe('')
    expect(formatPace(-5)).toBe('')
  })
})

describe('splitPace', () => {
  it('normalizes a split to s/km', () => {
    expect(splitPace({ distance_m: 1000, seconds: 331, avg_hr: null, marker: null })).toBe(331)
    expect(splitPace({ distance_m: 500, seconds: 180, avg_hr: null, marker: null })).toBe(360)
  })
  it('is null for zero distance or time', () => {
    expect(splitPace({ distance_m: 0, seconds: 10, avg_hr: null, marker: null })).toBeNull()
    expect(splitPace({ distance_m: 1000, seconds: 0, avg_hr: null, marker: null })).toBeNull()
  })
})

describe('projectRoute', () => {
  const route: LatLng[] = [[37.77, -122.42], [37.78, -122.41], [37.775, -122.405]]
  it('keeps every point inside the padded viewBox', () => {
    const pts = projectRoute(route, 300, 170, 12)
    expect(pts).toHaveLength(3)
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(12)
      expect(p.x).toBeLessThanOrEqual(288)
      expect(p.y).toBeGreaterThanOrEqual(12)
      expect(p.y).toBeLessThanOrEqual(158)
    }
  })
  it('maps north to smaller y', () => {
    const pts = projectRoute(route, 300, 170, 12)
    expect(pts[1].y).toBeLessThan(pts[0].y)   // 37.78 is north of 37.77
  })
  it('handles a degenerate single-point route', () => {
    expect(projectRoute([[37.77, -122.42]], 300, 170).length).toBe(1)
    expect(projectRoute([], 300, 170)).toEqual([])
  })
})

describe('nearestPointIndex', () => {
  it('finds the closest route point to a marker', () => {
    const route: LatLng[] = [[37.0, -122.0], [37.5, -122.0], [38.0, -122.0]]
    expect(nearestPointIndex(route, [37.52, -122.0])).toBe(1)
    expect(nearestPointIndex(route, [38.4, -122.0])).toBe(2)
  })
  it('returns -1 for an empty route', () => {
    expect(nearestPointIndex([], [37.0, -122.0])).toBe(-1)
  })
})
