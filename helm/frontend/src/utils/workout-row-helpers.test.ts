import { describe, it, expect } from 'vitest'
import {
  parseWeights, parseReps, countSets, computeVolume, isCardioEntry,
  parseCardioValue, formatDuration, getMaxWeight, hasNegativeWeight,
  getEffectiveWeight, normalizeExerciseName,
} from './workout-row-helpers'

describe('workout-row-helpers', () => {
  it('parses weights and reps', () => {
    expect(parseWeights('30, 35, 35')).toEqual([30, 35, 35])
    expect(parseWeights('BW, 35')).toEqual([35])
    expect(parseReps('8, 8 (Fail), 9')).toEqual([8, 8, 9])
    expect(countSets('8, 8, 9')).toBe(3)
    expect(countSets('')).toBe(0)
  })

  it('computes volume with single/short weight lists', () => {
    expect(computeVolume('135', '8, 8')).toBe(135 * 16)
    expect(computeVolume('30, 35', '8, 8, 9')).toBe(30 * 8 + 35 * 8 + 35 * 9)
    expect(computeVolume('-115', '8')).toBe(115 * 8)     // assisted: abs()
    expect(computeVolume('', '8')).toBe(0)
  })

  it('classifies cardio entries', () => {
    expect(isCardioEntry('', 'None')).toBe(true)
    expect(isCardioEntry('-', 'Machine')).toBe(true)
    expect(isCardioEntry('135', 'Barbell')).toBe(false)
  })

  it('parses cardio values', () => {
    expect(parseCardioValue('30 laps').laps).toBe(30)
    expect(parseCardioValue('5.2 km')).toMatchObject({ distance: 5.2, distanceUnit: 'km' })
    expect(parseCardioValue('45 min').duration).toBe(45)
    expect(parseCardioValue('1:30').duration).toBe(90)
    expect(formatDuration(90)).toBe('1h 30m')
  })

  it('effective weight resolves assisted lifts against bodyweight', () => {
    expect(getEffectiveWeight(-115, 190)).toBe(75)
    expect(getEffectiveWeight(135, 190)).toBe(135)
    expect(getMaxWeight('30, 35')).toBe(35)
    expect(hasNegativeWeight('-115, 35')).toBe(true)
  })

  it('normalizes exercise aliases', () => {
    expect(normalizeExerciseName('DB Bench')).toBe(normalizeExerciseName('Dumbbell Bench'))
    expect(normalizeExerciseName('the OHP')).toBe(normalizeExerciseName('Overhead Press'))
  })
})
