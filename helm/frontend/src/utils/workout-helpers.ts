/** Pure, testable helpers for the Workout Log page. */

export interface SearchableExercise {
  exercise: string
  targeted_muscle_group: string
}

export interface FilterableSession<E extends SearchableExercise> {
  workoutType: string
  exercises: E[]
  /** Activity labels/types — a label hit keeps the whole session un-narrowed
   *  (row-less cardio has no exercise rows to match against). */
  labels?: string[]
}

/**
 * Filter workout sessions by type and a free-text exercise/muscle search.
 *
 * A search hit narrows the session down to ONLY the matching exercises, so the
 * results show just what was searched for rather than every exercise in the
 * workout that happened to contain a match. A hit on an activity label keeps
 * the session whole instead (cardio activities carry no rows). Sessions with
 * no match are dropped. Callers should recompute any per-session totals from
 * the narrowed `exercises`.
 *
 * The input is never mutated — narrowed sessions are shallow copies.
 */
export function filterWorkoutSessions<
  E extends SearchableExercise,
  S extends FilterableSession<E>,
>(sessions: S[], activeFilter: string, searchQuery: string): S[] {
  let result = sessions
  if (activeFilter !== 'All') {
    result = result.filter(s => s.workoutType === activeFilter)
  }
  const q = searchQuery.trim().toLowerCase()
  if (q) {
    result = result.flatMap(s => {
      if ((s.labels ?? []).some(l => l.toLowerCase().includes(q))) return [s]
      const narrowed = s.exercises.filter(ex =>
        ex.exercise.toLowerCase().includes(q) ||
        ex.targeted_muscle_group.toLowerCase().includes(q)
      )
      return narrowed.length > 0 ? [{ ...s, exercises: narrowed } as S] : []
    })
  }
  return result
}

/** Display name for an activity: its label, else the title-cased activity type. */
export function activityDisplayLabel(activity: string, label?: string | null): string {
  if (label) return label
  return activity.charAt(0).toUpperCase() + activity.slice(1)
}
