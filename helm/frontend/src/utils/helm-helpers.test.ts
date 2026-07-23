import { describe, it, expect } from 'vitest'
import {
  getCalColor, getProteinColor, getCarbColor, getFatColor,
  getMoodEmoji, getHabitScore, getHabitClass, type HabitFields,
} from './helm-helpers'

describe('getCalColor', () => {
  it.each([
    [0, 'var(--text-muted)'],
    [1200, 'var(--accent-emerald)'],
    [1850, 'var(--accent-emerald)'],
    [1851, 'var(--accent-amber)'],
    [2200, 'var(--accent-amber)'],
    [2201, 'var(--accent-rose)'],
    [3000, 'var(--accent-rose)'],
  ])('getCalColor(%i) = %s', (cal, expected) => {
    expect(getCalColor(cal)).toBe(expected)
  })
})

describe('getProteinColor', () => {
  it.each([
    [0, 'var(--text-muted)'],
    [135, 'var(--accent-emerald)'],
    [150, 'var(--accent-emerald)'],
    [125, 'var(--accent-amber)'],
    [134, 'var(--accent-amber)'],
    [100, 'var(--accent-rose)'],
    [124, 'var(--accent-rose)'],
  ])('getProteinColor(%i) = %s', (p, expected) => {
    expect(getProteinColor(p)).toBe(expected)
  })
})

describe('getCarbColor', () => {
  it.each([
    [0, 'var(--text-muted)'],
    [250, 'var(--accent-emerald)'],
    [251, 'var(--accent-amber)'],
    [325, 'var(--accent-amber)'],
    [326, 'var(--accent-rose)'],
  ])('getCarbColor(%i) = %s', (c, expected) => {
    expect(getCarbColor(c)).toBe(expected)
  })
})

describe('getFatColor', () => {
  it.each([
    [0, 'var(--text-muted)'],
    [65, 'var(--accent-emerald)'],
    [66, 'var(--accent-amber)'],
    [85, 'var(--accent-amber)'],
    [86, 'var(--accent-rose)'],
  ])('getFatColor(%i) = %s', (f, expected) => {
    expect(getFatColor(f)).toBe(expected)
  })
})

describe('getMoodEmoji', () => {
  it.each([
    ['5', '✨'],
    ['4', '👍'],
    ['3', '😐'],
    ['2', '🔻'],
    ['1', '😩'],
    [null, '—'],
    [undefined, '—'],
    ['', '—'],
  ])('getMoodEmoji(%s) = %s', (mood, expected) => {
    expect(getMoodEmoji(mood)).toBe(expected)
  })
})

describe('getHabitScore', () => {
  const allFalse: HabitFields = {
    habit_workout: false, habit_clean: false, habit_productivity: false,
    habit_sleep: false, habit_love: false, habit_custom: false,
  }
  const allTrue: HabitFields = {
    habit_workout: true, habit_clean: true, habit_productivity: true,
    habit_sleep: true, habit_love: true, habit_custom: true,
  }

  it('returns 0 when no habits are true', () => {
    expect(getHabitScore(allFalse)).toBe(0)
  })

  it('returns 6 when all habits are true', () => {
    expect(getHabitScore(allTrue)).toBe(6)
  })

  it('counts only true habits', () => {
    expect(getHabitScore({ ...allFalse, habit_workout: true, habit_sleep: true })).toBe(2)
  })
})

describe('getHabitClass', () => {
  it.each([
    [6, 'great'],
    [5, 'great'],
    [4, 'good'],
    [3, 'good'],
    [2, 'low'],
    [0, 'low'],
  ])('getHabitClass(%i) = %s', (score, expected) => {
    expect(getHabitClass(score)).toBe(expected)
  })
})
