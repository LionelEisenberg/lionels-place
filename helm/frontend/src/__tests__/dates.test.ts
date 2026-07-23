import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { toLocalISO, displayDate, friendlyDate, weekdayName, todayISO, startOfWeekISO, startOfMonthISO } from '../dates'

describe('toLocalISO', () => {
  it.each([
    [new Date(2026, 2, 17), '2026-03-17'],
    [new Date(2026, 0, 1), '2026-01-01'],
    [new Date(2026, 11, 31), '2026-12-31'],
  ])('formats %s as %s', (date, expected) => {
    expect(toLocalISO(date)).toBe(expected)
  })

  it('pads single-digit months and days', () => {
    expect(toLocalISO(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('todayISO', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 2, 17)) })
  afterEach(() => { vi.useRealTimers() })

  it('returns today as YYYY-MM-DD', () => {
    expect(todayISO()).toBe('2026-03-17')
  })
})

describe('displayDate', () => {
  it.each([
    ['2026-03-17', '17/03/26'],
    ['2026-01-05', '05/01/26'],
    ['2026-12-31', '31/12/26'],
  ])('converts %s to %s', (iso, expected) => {
    expect(displayDate(iso)).toBe(expected)
  })

  it('passes through dates already in DD/MM format', () => {
    expect(displayDate('17/03/26')).toBe('17/03/26')
  })

  it('returns empty string for empty input', () => {
    expect(displayDate('')).toBe('')
  })

  it('returns input unchanged if not parseable', () => {
    expect(displayDate('invalid')).toBe('invalid')
  })
})

describe('friendlyDate', () => {
  it('formats as "Mon DD" style', () => {
    expect(friendlyDate('2026-03-17')).toBe('Mar 17')
  })

  it('returns empty string for empty input', () => {
    expect(friendlyDate('')).toBe('')
  })
})

describe('weekdayName', () => {
  it.each([
    ['2026-03-16', 'Monday'],
    ['2026-03-17', 'Tuesday'],
    ['2026-03-22', 'Sunday'],
  ])('returns correct weekday for %s', (iso, expected) => {
    expect(weekdayName(iso)).toBe(expected)
  })

  it('returns empty string for empty input', () => {
    expect(weekdayName('')).toBe('')
  })
})

describe('startOfWeekISO', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 2, 20)) }) // Friday 2026-03-20
  afterEach(() => { vi.useRealTimers() })

  it('returns the Monday of the current week', () => {
    expect(startOfWeekISO()).toBe('2026-03-16')
  })
})

describe('startOfMonthISO', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 2, 20)) })
  afterEach(() => { vi.useRealTimers() })

  it('returns the 1st of the current month', () => {
    expect(startOfMonthISO()).toBe('2026-03-01')
  })
})
