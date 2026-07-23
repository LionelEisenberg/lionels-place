import { describe, it, expect } from 'vitest'
import { filterWorkoutSessions, activityDisplayLabel } from './workout-helpers'

type Ex = { exercise: string; targeted_muscle_group: string }
const mk = (date: string, workoutType: string, exercises: Ex[]) => ({ date, workoutType, exercises })

const push = mk('2026-06-20', 'Push', [
  { exercise: 'Bench Press', targeted_muscle_group: 'Chest' },
  { exercise: 'Overhead Press', targeted_muscle_group: 'Shoulders' },
])
const pull = mk('2026-06-19', 'Pull', [
  { exercise: 'Deadlift', targeted_muscle_group: 'Back' },
  { exercise: 'Barbell Row', targeted_muscle_group: 'Back' },
])

describe('filterWorkoutSessions', () => {
  it('returns all sessions with all exercises when filter is All and query is empty', () => {
    const r = filterWorkoutSessions([push, pull], 'All', '')
    expect(r).toHaveLength(2)
    expect(r[0].exercises).toHaveLength(2)
    expect(r[1].exercises).toHaveLength(2)
  })

  it('filters by workout type without narrowing exercises', () => {
    const r = filterWorkoutSessions([push, pull], 'Pull', '')
    expect(r).toHaveLength(1)
    expect(r[0].workoutType).toBe('Pull')
    expect(r[0].exercises).toHaveLength(2)
  })

  it('narrows a matched session down to ONLY the matching exercise', () => {
    const r = filterWorkoutSessions([push, pull], 'All', 'bench')
    expect(r).toHaveLength(1)
    expect(r[0].date).toBe('2026-06-20')
    // Search shows only the matched exercise, not the whole workout.
    expect(r[0].exercises).toHaveLength(1)
    expect(r[0].exercises.map(e => e.exercise)).toEqual(['Bench Press'])
  })

  it('narrows on targeted muscle group too', () => {
    const r = filterWorkoutSessions([push, pull], 'All', 'shoulders')
    expect(r).toHaveLength(1)
    expect(r[0].date).toBe('2026-06-20')
    expect(r[0].exercises.map(e => e.exercise)).toEqual(['Overhead Press'])
  })

  it('keeps every exercise that matches (multiple hits in one session)', () => {
    const r = filterWorkoutSessions([push, pull], 'All', 'back')
    expect(r).toHaveLength(1)
    expect(r[0].date).toBe('2026-06-19')
    expect(r[0].exercises).toHaveLength(2)
  })

  it('excludes sessions with no matching exercise', () => {
    expect(filterWorkoutSessions([push, pull], 'All', 'zzz')).toHaveLength(0)
  })

  it('is case-insensitive and trims surrounding whitespace', () => {
    const r = filterWorkoutSessions([push, pull], 'All', '  DEADLIFT ')
    expect(r).toHaveLength(1)
    expect(r[0].exercises.map(e => e.exercise)).toEqual(['Deadlift'])
  })

  it('combines type filter and search', () => {
    expect(filterWorkoutSessions([push, pull], 'Push', 'deadlift')).toHaveLength(0)
    const r = filterWorkoutSessions([push, pull], 'Push', 'bench')
    expect(r).toHaveLength(1)
    expect(r[0].exercises.map(e => e.exercise)).toEqual(['Bench Press'])
  })

  it('does not mutate the input sessions', () => {
    const input = [push, pull]
    filterWorkoutSessions(input, 'All', 'bench')
    expect(push.exercises).toHaveLength(2)
    expect(input).toHaveLength(2)
  })

  it('a label hit keeps a row-less session whole', () => {
    const swimDay = { workoutType: 'Cardio', exercises: [], labels: ['Pool swim', 'swim'] }
    const out = filterWorkoutSessions([swimDay, push], 'All', 'swim')
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(swimDay)          // un-narrowed, same reference
  })

  it('label hit does not narrow the session exercises', () => {
    const mixed = {
      workoutType: 'Push',
      exercises: [{ exercise: 'Bench Press', targeted_muscle_group: 'Chest' }],
      labels: ['Strength', 'strength'],
    }
    const out = filterWorkoutSessions([mixed], 'All', 'strength')
    expect(out[0].exercises).toHaveLength(1)
  })
})

describe('activityDisplayLabel', () => {
  it('uses the label when present', () => {
    expect(activityDisplayLabel('swim', 'Pool swim')).toBe('Pool swim')
  })
  it('falls back to title-cased activity when label is missing', () => {
    expect(activityDisplayLabel('strength', null)).toBe('Strength')
    expect(activityDisplayLabel('run', undefined)).toBe('Run')
    expect(activityDisplayLabel('run', '')).toBe('Run')
  })
})
