/** Data layer for the Workout Log page.
 *
 * The day log (server-assembled activities + aggregates) is the primary read;
 * raw workout rows feed edit drafts, per-exercise deltas, and Plan Workout;
 * dailies feed sick-day markers. Replaces the page's client-side SessionData /
 * groupIntoSessions derivation (deleted in the page rebuild). */
import { useCallback, useEffect, useState } from 'react'
import {
  getWorkoutLog, listWorkouts, listDaily,
  type DayLog, type WorkoutResponse, type DailySummaryResponse,
} from './api'

export function useWorkoutData() {
  const [days, setDays] = useState<DayLog[]>([])
  const [workouts, setWorkouts] = useState<WorkoutResponse[]>([])
  const [dailyByDate, setDailyByDate] = useState<Map<string, DailySummaryResponse>>(new Map())
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [logs, rows, dailies] = await Promise.all([
        getWorkoutLog(),
        listWorkouts({ limit: 1000 }),
        listDaily(undefined, undefined, 1000),
      ])
      setDays(logs)
      setWorkouts(rows)
      const dm = new Map<string, DailySummaryResponse>()
      for (const d of dailies) dm.set(d.date, d)
      setDailyByDate(dm)
    } catch (err) {
      console.error('Failed to load workout data:', err)
    }
    setLoading(false)
  }, [])

  useEffect(() => { reload() }, [reload])

  return { days, workouts, dailyByDate, loading, reload }
}
