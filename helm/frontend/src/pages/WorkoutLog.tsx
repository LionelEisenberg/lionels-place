/**
 * WorkoutLog — orchestrator for the workout log page.
 * Renders one DayCard per server-assembled day (Day → Activity → Exercise);
 * owns the day-grain edit flow, search/filter, heatmap, and Plan Workout.
 */

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  updateWorkout, deleteWorkout, createWorkout,
  updateActivity, deleteActivity,
  exerciseProgression, exerciseSearch,
  planWorkoutAsync,
  type WorkoutResponse, type ExerciseProgressionResponse, type WorkoutPlan,
  type PendingGoogleSession, type ActivityResponse, type WorkoutCreatePayload,
  type DayLog,
} from '../api'
import type { ActivityEditController } from '../components/ActivityBlock'
import { filterWorkoutSessions } from '../utils/workout-helpers'
import { activityEmoji, activityColor } from '../utils/session-helpers'
import { chipStats, activityExtras } from '../utils/activity-stats'
import { useContextJobs } from '../useContextJobs'
import { useWorkoutData } from '../useWorkoutData'
import { displayDate, todayISO, toLocalISO } from '../dates'
import {
  buildHeatmapModel,
  buildMonthLabels,
  computeStreaks,
  addDays,
  isSickNote,
  dayToHeatmapSession,
  type HeatmapModel,
  type HeatmapCell,
  type MonthLabel,
} from '../utils/workout-heatmap-helpers'
import { WorkoutPlanCard } from '../components/WorkoutPlanCard'
import { ProgressionPanel } from '../components/ProgressionPanel'
import { DayCard, TYPE_COLORS } from '../components/DayCard'
import { PendingGoogleBanner } from '../components/PendingGoogleBanner'
import { FinalizeWorkoutPanel } from '../components/FinalizeWorkoutPanel'
import {
  isCardioEntry, getEquipClass, getEquipAbbrev,
  formatWeight, formatReps, computeDelta, type Delta,
} from '../utils/workout-row-helpers'

/* ───────── EditInput (preserved from original) ───────── */

const EditInput = ({
  field, type = 'text', width = '100%', options,
  editData, setEditData, saveEdit, cancelEdit
}: {
  field: keyof WorkoutResponse; type?: string; width?: string; options?: string[];
  editData: Partial<WorkoutResponse>;
  setEditData: React.Dispatch<React.SetStateAction<Partial<WorkoutResponse>>>;
  saveEdit: () => void; cancelEdit: () => void;
}) => {
  const value = editData[field] ?? ''
  const handleChange = (val: any) => setEditData(prev => ({ ...prev, [field]: val }))

  if (type === 'select' && options) {
    return (
      <select id={`edit-${field}`} value={value as string} onChange={e => handleChange(e.target.value)} style={{ width }}>
        <option value="">Select...</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }

  if (type === 'muscles') {
    const parts = (value as string || '').split(',').map(s => s.trim()).filter(Boolean);
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
        {parts.map((m, i) => (
          <span key={i} className="muscle-pill" style={{ margin: 0, paddingRight: '4px' }}>
            {m}
            <span
              style={{ cursor: 'pointer', opacity: 0.6, marginLeft: '4px', fontWeight: 'bold' }}
              onClick={() => {
                const newParts = parts.filter((_, idx) => idx !== i);
                handleChange(newParts.join(', '));
              }}
              title="Remove"
            >×</span>
          </span>
        ))}
        <input
          type="text"
          placeholder="Add..."
          style={{ width: '70px', padding: '2px 6px', fontSize: '0.75rem', borderRadius: '4px', border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const v = e.currentTarget.value.trim();
              if (v) {
                handleChange(parts.length ? value + ', ' + v : v);
                e.currentTarget.value = '';
              } else {
                saveEdit();
              }
            }
            if (e.key === 'Escape') cancelEdit();
          }}
          onBlur={e => {
            const v = e.target.value.trim();
            if (v) {
              handleChange(parts.length ? value + ', ' + v : v);
              e.target.value = '';
            }
          }}
        />
      </div>
    )
  }

  if (type === 'textarea') {
    return (
      <textarea
        value={value as string}
        onChange={e => handleChange(e.target.value)}
        style={{ width, minHeight: '60px', resize: 'vertical' }}
        onKeyDown={e => {
          if (e.key === 'Escape') cancelEdit();
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
        }}
      />
    )
  }

  return (
    <input
      id={`edit-${field}`}
      type={type}
      value={value as string}
      onChange={e => handleChange(e.target.value)}
      style={{ width }}
      onKeyDown={e => {
        if (e.key === 'Enter') saveEdit()
        if (e.key === 'Escape') cancelEdit()
      }}
    />
  )
}

/* ───────── Constants ───────── */

const PPL_NEXT: Record<string, string> = { Push: 'Pull', Pull: 'Legs', Legs: 'Push' }

const EQUIPMENT_OPTIONS = ['Barbell', 'Dumbbell', 'Machine', 'Cable', 'Bodyweight', 'Smith Machine', 'Bands', 'Plates', 'None']
const CATEGORY_OPTIONS = ['Upper Body', 'Lower Body', 'Core', 'Cardio']

/** Log filter pills: strength split by PPL day-type, plus the major sports. */
const LOG_FILTERS = [
  { key: 'All' as const, label: 'All', color: 'var(--accent-indigo)' },
  { key: 'Push' as const, label: 'Push', color: 'var(--accent-rose)' },
  { key: 'Pull' as const, label: 'Pull', color: 'var(--accent-sky)' },
  { key: 'Legs' as const, label: 'Legs', color: 'var(--accent-emerald)' },
  { key: 'swim' as const, label: '🏊 Swim', color: 'var(--accent-sky)' },
  { key: 'run' as const, label: '🏃 Run', color: 'var(--accent-orange)' },
  { key: 'bike' as const, label: '🚴 Bike', color: 'var(--accent-amber)' },
]
type LogFilter = typeof LOG_FILTERS[number]['key']

/** PPL filters match the day's type; sport filters match any activity on the day. */
function dayMatchesFilter(day: DayLog, f: LogFilter): boolean {
  if (f === 'All') return true
  if (f === 'swim' || f === 'run' || f === 'bike') return day.sessions.some(a => a.activity === f)
  return (day.day_type || 'Mixed') === f
}

function getMonday(date: Date): string {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  return toLocalISO(d)
}

/* ───────── Main Component ───────── */

export default function WorkoutLog() {
  const { days, workouts, dailyByDate, loading, reload } = useWorkoutData()
  const [finalizeTarget, setFinalizeTarget] = useState<PendingGoogleSession | null>(null)
  const [pendingReloadKey, setPendingReloadKey] = useState(0)
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())
  const [expandedActivities, setExpandedActivities] = useState<Set<number>>(new Set())
  const [activeFilter, setActiveFilter] = useState<LogFilter>('All')
  const [searchQuery, setSearchQuery] = useState('')
  const expandedBeforeSearch = useRef<Set<string> | null>(null)
  const [searchSuggestions, setSearchSuggestions] = useState<string[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)

  // Expand today's card once, on the FIRST data arrival (ref guard so reloads
  // after edit-save don't collapse whatever the user has open).
  const didInitExpand = useRef(false)
  useEffect(() => {
    if (didInitExpand.current || days.length === 0) return
    didInitExpand.current = true
    const today = todayISO()
    if (days.some(d => d.date === today)) setExpandedDates(new Set([today]))
  }, [days])

  /* ── Per-activity edit state ── */
  const [editingActivity, setEditingActivity] = useState<ActivityResponse | null>(null)
  const [editDrafts, setEditDrafts] = useState<Record<number, Partial<WorkoutResponse>>>({})
  const [newRows, setNewRows] = useState<WorkoutCreatePayload[]>([])
  const [savingEdit, setSavingEdit] = useState(false)
  // Structured cardio editor draft (row-less cardio: laps/distance/duration/notes
  // live on the activity itself). String-typed so inputs can be cleared freely.
  const [cardioDraft, setCardioDraft] = useState({ laps: '', km: '', minutes: '', notes: '' })

  /* ── Progression panel state ── */
  const [progressionExercise, setProgressionExercise] = useState<string | null>(null)
  const [progressionEquipment, setProgressionEquipment] = useState<string>('')
  const [progressionMuscles, setProgressionMuscles] = useState<string>('')
  const [progressionDate, setProgressionDate] = useState<string>('')
  const [progressionData, setProgressionData] = useState<ExerciseProgressionResponse[]>([])
  const [progressionActiveTab, setProgressionActiveTab] = useState(0)
  const [progressionLoading, setProgressionLoading] = useState(false)

  /* ── Plan workout state ── */
  const [planLoading, setPlanLoading] = useState(false)
  const [planResult, setPlanResult] = useState<WorkoutPlan | null>(null)
  const [workoutNote, setWorkoutNote] = useState('')
  const [planDay, setPlanDay] = useState<'today' | 'tomorrow'>('today')
  const [showPlanModal, setShowPlanModal] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)

  // Workout planning runs as an async job (submit + poll) so the long LLM call
  // can't time out the origin behind Cloudflare (524). handlePlanWorkout computes
  // the day-type/notes, stashes them here, then kicks off the job.
  const planArgsRef = useRef<{ dayType: string; notes: string }>({ dayType: '', notes: '' })
  const { submit: submitPlan } = useContextJobs<WorkoutPlan>('workout_log', {
    transform: (raw) => raw as unknown as WorkoutPlan,
    onResult: (plan) => {
      setPlanResult(plan)
      setShowPlanModal(true)
      setPlanLoading(false)
    },
    onError: (msg) => {
      setPlanError(msg)
      setPlanLoading(false)
    },
  })

  const toggleSession = (date: string) => {
    setExpandedDates(prev => {
      const next = new Set(prev)
      if (next.has(date)) {
        next.delete(date)
        // Auto-close progression if it belongs to this day
        if (progressionDate === date) {
          setProgressionExercise(null)
        }
      } else {
        next.add(date)
      }
      return next
    })
  }

  const toggleActivity = (id: number) => {
    setExpandedActivities(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /* ── Per-activity edit handlers ── */

  const startActivityEdit = (a: ActivityResponse) => {
    setEditingActivity(a)
    setEditDrafts({})
    setNewRows([])
    if (a.category === 'cardio') {
      setCardioDraft({
        laps: a.laps != null ? String(a.laps) : '',
        km: a.distance_m != null ? String(Math.round(a.distance_m / 10) / 100) : '',
        minutes: a.duration_min != null ? String(Math.round(a.duration_min)) : '',
        notes: a.notes ?? '',
      })
    }
  }

  const cancelActivityEdit = () => {
    setEditingActivity(null)
    setEditDrafts({})
    setNewRows([])
  }

  const updateDraft = (id: number, field: keyof WorkoutResponse, value: any) => {
    setEditDrafts(prev => ({ ...prev, [id]: { ...prev[id], [field]: value } }))
  }

  const addNewRow = (a: ActivityResponse, date: string) => {
    const cardio = a.category === 'cardio'
    setNewRows(prev => [...prev, {
      date,
      activity_id: a.id,
      category: (cardio ? 'Cardio' : 'Upper Body') as WorkoutResponse['category'],
      equipment_type: cardio ? 'None' : '',
      exercise: '',
      weight_lbs: '',
      reps_sets: '',
      notes: '',
      targeted_muscle_group: cardio ? 'Cardio' : '',
    }])
  }

  const updateNewRow = (index: number, field: string, value: any) => {
    setNewRows(prev => prev.map((ex, i) => i === index ? { ...ex, [field]: value } : ex))
  }

  const removeNewRow = (index: number) => {
    setNewRows(prev => prev.filter((_, i) => i !== index))
  }

  const saveActivityEdit = async () => {
    if (!editingActivity) return
    setSavingEdit(true)
    try {
      if (editingActivity.category === 'cardio') {
        // Row-less cardio: structured fields save onto the activity itself.
        await updateActivity(editingActivity.id, {
          laps: cardioDraft.laps ? parseInt(cardioDraft.laps, 10) : null,
          distance_m: cardioDraft.km ? Math.round(parseFloat(cardioDraft.km) * 10000) / 10 : null,
          duration_min: cardioDraft.minutes ? parseFloat(cardioDraft.minutes) : null,
          notes: cardioDraft.notes.trim() || null,
        })
      } else {
        for (const [idStr, changes] of Object.entries(editDrafts)) {
          if (Object.keys(changes).length > 0) {
            await updateWorkout(Number(idStr), changes)
          }
        }
        const validNew = newRows.filter(ex => ex.exercise)
        if (validNew.length > 0) {
          await createWorkout(validNew)
        }
      }
      cancelActivityEdit()
      await reload()
    } catch (err) { console.error('Failed to save activity edits:', err) }
    finally { setSavingEdit(false) }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this exercise?')) return
    try {
      await deleteWorkout(id)
      await reload()
    } catch (err) { console.error('Failed to delete:', err) }
  }

  const handleDeleteActivity = async (a: ActivityResponse) => {
    if (!confirm(`Delete this ${a.label} activity?`)) return
    try {
      await deleteActivity(a.id)
      cancelActivityEdit()
      await reload()
    } catch (err) { console.error('Failed to delete activity:', err) }
  }

  /* ── Filtering + search ── */

  const filteredDays = useMemo(() => {
    const filterable = days.filter(d => dayMatchesFilter(d, activeFilter)).map(day => ({
      day,
      workoutType: (day.day_type || 'Mixed') as string,
      exercises: day.sessions.flatMap(a => a.exercises),
      // Row-less cardio has no rows to match — labels keep those days findable.
      labels: day.sessions.flatMap(a => [a.label, a.activity]),
    }))
    const narrowed = filterWorkoutSessions(filterable, 'All', searchQuery)
    const q = searchQuery.trim().toLowerCase()
    return narrowed.map(fd => {
      // A label-matched day keeps its normal card view; row matches flatten.
      const labelHit = !!q && fd.day.sessions.some(a =>
        a.label.toLowerCase().includes(q) || a.activity.toLowerCase().includes(q))
      return { day: fd.day, flatRows: q && !labelHit ? fd.exercises : undefined }
    })
  }, [days, activeFilter, searchQuery])

  // Per-exercise "vs last" deltas depend only on the full workout history, not on
  // the search/filter — compute them once per data load (keyed by exercise id) so
  // typing doesn't re-scan ~1000 workouts for every visible row on each keystroke.
  const deltaByExerciseId = useMemo(() => {
    const m = new Map<number, Delta>()
    for (const d of days) {
      for (const a of d.sessions) {
        for (const ex of a.exercises) m.set(ex.id, computeDelta(ex, d.date, workouts))
      }
    }
    return m
  }, [days, workouts])

  useEffect(() => {
    if (searchQuery.trim()) {
      if (expandedBeforeSearch.current === null) {
        expandedBeforeSearch.current = new Set(expandedDates)
      }
      setExpandedDates(new Set(filteredDays.map(f => f.day.date)))
    } else if (expandedBeforeSearch.current !== null) {
      setExpandedDates(expandedBeforeSearch.current)
      expandedBeforeSearch.current = null
    }
  }, [searchQuery])

  useEffect(() => {
    const q = searchQuery.trim()
    if (q.length < 2) { setSearchSuggestions([]); return }
    const timer = setTimeout(async () => {
      try {
        const results = await exerciseSearch(q, 8)
        setSearchSuggestions(results)
        setShowSuggestions(true)
      } catch { setSearchSuggestions([]) }
    }, 200)
    return () => clearTimeout(timer)
  }, [searchQuery])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  /* ── Heatmap / streaks / stats ── */

  const [heatmapHover, setHeatmapHover] = useState<string | null>(null)   // hovered cell date

  // Date range: first day → today. Falls back to ~8 weeks if no days.
  const heatmapRange = useMemo(() => {
    const today = todayISO()
    const startDate = days.length > 0
      ? days[days.length - 1].date   // days are sorted DESC; last is earliest
      : addDays(today, -55)
    return { startDate, today }
  }, [days])

  const sessionsForHeatmap = useMemo(() => days.map(dayToHeatmapSession), [days])
  const dayByDate = useMemo(() => new Map(days.map(d => [d.date, d])), [days])

  const sickDates = useMemo(() => {
    const s = new Set<string>()
    for (const d of dailyByDate.values()) {
      if (isSickNote(d.notes)) s.add(d.date)
    }
    return s
  }, [dailyByDate])

  const heatmapModel: HeatmapModel = useMemo(
    () => buildHeatmapModel(
      sessionsForHeatmap,
      heatmapRange.startDate,
      heatmapRange.today,
      sickDates,
    ),
    [sessionsForHeatmap, heatmapRange, sickDates],
  )

  const monthLabels: MonthLabel[] = useMemo(
    () => buildMonthLabels(heatmapModel),
    [heatmapModel],
  )

  const streakStats = useMemo(() => {
    const active = new Set(days.map(d => d.date))
    return computeStreaks(active, heatmapRange.startDate, heatmapRange.today)
  }, [days, heatmapRange])

  // Lifetime output totals across every logged/locked-in activity.
  const lifetime = useMemo(() => {
    let activities = 0, sets = 0, volume = 0, distanceM = 0, laps = 0, kcal = 0
    for (const d of days) {
      activities += d.sessions.length
      sets += d.total_sets
      volume += d.total_volume
      for (const a of d.sessions) {
        if (a.distance_m != null) distanceM += a.distance_m
        if (a.laps != null) laps += a.laps
        if (a.credited_kcal != null) kcal += a.credited_kcal
      }
    }
    return { activities, sets, volume, distanceM, laps, kcal }
  }, [days])

  const fmtBig = (n: number): string =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 10_000 ? `${Math.round(n / 1000)}k`
    : n >= 1000 ? `${(n / 1000).toFixed(1)}k`
    : String(Math.round(n))

  const totalActive = days.length
  const totalDays = useMemo(
    () => {
      const start = new Date(`${heatmapRange.startDate}T12:00:00`).getTime()
      const end = new Date(`${heatmapRange.today}T12:00:00`).getTime()
      return Math.round((end - start) / 86_400_000) + 1
    },
    [heatmapRange],
  )
  const adherencePct = totalDays > 0 ? Math.round((totalActive / totalDays) * 100) : 0
  const perWeekAvg = totalDays > 0 ? (totalActive / (totalDays / 7)).toFixed(1) : '0.0'

  /* ── Day card refs for click-to-scroll from the heatmap ── */
  const sessionRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const scrollToSession = useCallback((date: string) => {
    const el = sessionRefs.current[date]
    if (!el) return
    if (!expandedDates.has(date)) {
      toggleSession(date)
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [expandedDates])

  /* ── Progression panel click handler ── */
  const handleExerciseClick = async (exercise: WorkoutResponse, sessionDate: string) => {
    if (progressionExercise === exercise.exercise && progressionEquipment === exercise.equipment_type && progressionDate === sessionDate) {
      setProgressionExercise(null)
      return
    }
    setProgressionExercise(exercise.exercise)
    setProgressionEquipment(exercise.equipment_type)
    setProgressionMuscles(exercise.targeted_muscle_group)
    setProgressionDate(sessionDate)
    setProgressionLoading(true)
    try {
      const data = await exerciseProgression(exercise.exercise)
      setProgressionData(data)
      const tabIdx = data.findIndex(d => d.equipment_type === exercise.equipment_type)
      setProgressionActiveTab(tabIdx >= 0 ? tabIdx : 0)
    } catch { setProgressionData([]) }
    setProgressionLoading(false)
  }

  /* ── Plan workout handler ── */
  const handlePlanWorkout = () => {
    setPlanLoading(true)

    const isTomorrow = planDay === 'tomorrow'
    const now = isTomorrow ? new Date(Date.now() + 86400000) : new Date()
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December']
    const dateStr = `${dayNames[now.getDay()]}, ${monthNames[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`

    // Derive PPL cycle from existing workouts state
    const monday = getMonday(new Date())
    const weekWorkouts = workouts.filter(w => w.date >= monday)
    const weekByDate = new Map<string, WorkoutResponse[]>()
    for (const w of weekWorkouts) {
      const list = weekByDate.get(w.date) || []
      list.push(w)
      weekByDate.set(w.date, list)
    }

    let weeklyPush = 0, weeklyPull = 0, weeklyLegs = 0
    for (const [date] of weekByDate) {
      const type = dailyByDate.get(date)?.workout_type
      if (type === 'Push') weeklyPush++
      else if (type === 'Pull') weeklyPull++
      else if (type === 'Legs') weeklyLegs++
      // Ignore Mixed and Cardio
    }

    // Determine next workout type
    let nextWorkoutType = 'Push'
    if (isTomorrow) {
      // For tomorrow: advance from today's actual workout type in the PPL rotation
      const todayStr = new Date().toISOString().split('T')[0]
      const todayType = dailyByDate.get(todayStr)?.workout_type ?? null
      if (todayType && PPL_NEXT[todayType]) {
        nextWorkoutType = PPL_NEXT[todayType]
      } else {
        // No workout today — use fewest-sessions heuristic
        const min = Math.min(weeklyPush, weeklyPull, weeklyLegs)
        if (weeklyPush === min) nextWorkoutType = 'Push'
        else if (weeklyPull === min) nextWorkoutType = 'Pull'
        else nextWorkoutType = 'Legs'
      }
    } else {
      // For today: pick the type with fewest sessions this week
      const min = Math.min(weeklyPush, weeklyPull, weeklyLegs)
      if (weeklyPush === min) nextWorkoutType = 'Push'
      else if (weeklyPull === min) nextWorkoutType = 'Pull'
      else nextWorkoutType = 'Legs'
    }

    const counts: Record<string, number> = { Push: weeklyPush, Pull: weeklyPull, Legs: weeklyLegs }
    const occurrenceNum = (counts[nextWorkoutType] ?? 0) + 1
    const ordinal = ['1st', '2nd', '3rd', '4th'][occurrenceNum - 1] || `${occurrenceNum}th`
    const cycleInfo = `${nextWorkoutType} Day (${ordinal} ${nextWorkoutType} day this week)`

    // Build recent workout summary from local data
    let recentWorkoutSummary = ''
    const relevantSessions = workouts
      .filter(w => w.category?.toLowerCase().includes(nextWorkoutType.toLowerCase()))
      .slice(0, 30)
    if (relevantSessions.length > 0) {
      const byDate: Record<string, WorkoutResponse[]> = {}
      relevantSessions.forEach(w => { (byDate[w.date] = byDate[w.date] || []).push(w) })
      const dates = Object.keys(byDate).sort().reverse().slice(0, 3)
      recentWorkoutSummary = dates.map(d => {
        const sets = byDate[d].map(w =>
          `  - ${w.exercise} (${w.targeted_muscle_group}): W: ${w.weight_lbs} | R: ${w.reps_sets}${w.notes ? ` | Note: ${w.notes}` : ''}`
        ).join('\n')
        return `${d} [${nextWorkoutType}]:\n${sets}`
      }).join('\n\n')
    }

    const notes = [
      `${isTomorrow ? 'Tomorrow' : 'Today'}: ${dateStr}`,
      `Workout type: ${cycleInfo}`,
      `This week so far: ${weeklyPush} Push / ${weeklyPull} Pull / ${weeklyLegs} Legs`,
      `Apply progressive overload from the data below.`,
      workoutNote ? `User notes: ${workoutNote}` : '',
      recentWorkoutSummary ? `\nLast ${nextWorkoutType} sessions:\n${recentWorkoutSummary}` : '',
    ].filter(Boolean).join('\n')

    setPlanError(null)
    planArgsRef.current = { dayType: nextWorkoutType, notes }
    submitPlan(() => planWorkoutAsync(planArgsRef.current.dayType, planArgsRef.current.notes))
  }

  function renderHeatmapCell(cell: HeatmapCell) {
    const classes = ['wo-heatmap-cell']
    if (!cell.inRange) classes.push('out-of-range')
    if (cell.workoutType) classes.push('has-session', `t-${cell.workoutType}`)
    if (cell.wasSick) classes.push('has-sick')
    if (cell.isToday) classes.push('today')

    const isHovered = heatmapHover === cell.date
    const day = dayByDate.get(cell.date)

    // Active filter: non-matching sessions recede in place.
    if (cell.workoutType && activeFilter !== 'All' && (!day || !dayMatchesFilter(day, activeFilter))) {
      classes.push('filtered-out')
    }

    return (
      <div
        key={cell.date}
        className={classes.join(' ')}
        style={cell.workoutType ? ({ ['--lvl' as string]: cell.setsLevel } as React.CSSProperties) : undefined}
        onMouseEnter={() => setHeatmapHover(cell.date)}
        onClick={cell.workoutType ? () => scrollToSession(cell.date) : undefined}
      >
        {cell.workoutType && (
          <>
            <span className="wo-heatmap-cell-type">{cell.workoutType}</span>
            {cell.sets > 0 && (
              <span className="wo-heatmap-cell-dots" aria-hidden="true">
                {[0, 1, 2, 3].map(i => (
                  <span key={i} className={`dot${i < cell.setsLevel ? ' on' : ''}`} />
                ))}
              </span>
            )}
            {cell.cardio.length > 0 && (
              <span className="wo-heatmap-cell-pips" aria-hidden="true">
                {cell.cardio.slice(0, 3).map((a, i) => (
                  <span key={i} className="pip" style={{ ['--acc' as string]: activityColor(a) } as React.CSSProperties}>
                    {activityEmoji(a)}
                  </span>
                ))}
              </span>
            )}
          </>
        )}
        {cell.wasSick && cell.inRange && (
          <span className="wo-heatmap-cell-sick" aria-label="sick day">{'🤒'}</span>
        )}
        {isHovered && cell.inRange && (
          <div className={`wo-heatmap-tip${cell.weekIndex >= heatmapModel.weekCount - 2 ? ' flip-left' : ''}`}>
            <div className="wo-heatmap-tip-date">{displayDate(cell.date)}</div>
            {cell.workoutType ? (
              <>
                <span
                  className="wo-heatmap-tip-type"
                  style={{ color: TYPE_COLORS[cell.workoutType] }}
                >
                  {cell.workoutType}
                </span>
                <div className="wo-heatmap-tip-acts">
                  {day?.sessions.map(a => (
                    <span key={a.id} className="wo-heatmap-tip-act">
                      <span>{activityEmoji(a.activity)}</span>
                      <span className="nm">{a.label}</span>
                      <span className="st" style={{ color: activityColor(a.activity) }}>
                        {chipStats(a, activityExtras(a))}
                      </span>
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <div className="wo-heatmap-tip-rest">Rest day</div>
            )}
            {cell.wasSick && <div className="wo-heatmap-tip-sick">{'🤒'} sick</div>}
          </div>
        )}
      </div>
    )
  }

  const renderExerciseRow = (ex: WorkoutResponse, sessionDate: string) => {
    const repsParsed = formatReps(ex.reps_sets)
    const equipAbbrev = getEquipAbbrev(ex.equipment_type)
    const equipClass = getEquipClass(ex.equipment_type)
    const rowCardio = isCardioEntry(ex.weight_lbs, ex.equipment_type)
    const isActiveProgression = progressionExercise === ex.exercise && progressionEquipment === ex.equipment_type && progressionDate === sessionDate
    return (
      <React.Fragment key={ex.id}>
        <div
          className={`wo-ex-row${isActiveProgression ? ' active' : ''}`}
          onClick={() => handleExerciseClick(ex, sessionDate)}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
            <span style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: '0.85rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {ex.exercise}
            </span>
            {equipAbbrev && (
              <span className={`equip-tag ${equipClass}`} style={{ fontSize: '0.6rem', flexShrink: 0 }}>{equipAbbrev}</span>
            )}
          </div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: 'var(--accent-sky)', textAlign: 'center' }}>
            {formatWeight(ex.weight_lbs, rowCardio)}
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-primary)', textAlign: 'center' }}>
            {repsParsed.map((r, ri) => (
              <React.Fragment key={ri}>
                <span style={{ color: r.hasFail ? 'var(--accent-rose)' : undefined, fontWeight: r.hasFail ? 600 : undefined }}>
                  {r.text}{r.hasFail && <span style={{ fontSize: '0.6rem' }}>F</span>}
                </span>
                {ri < repsParsed.length - 1 && <span style={{ color: 'var(--text-muted)' }}>, </span>}
              </React.Fragment>
            ))}
          </span>
          {(() => {
            const delta = deltaByExerciseId.get(ex.id) ?? computeDelta(ex, sessionDate, workouts)
            return <div className={`wo-ex-delta ${delta.className}`}>{delta.label}</div>
          })()}
          <span className="wo-ex-notes-text">{ex.notes || ''}</span>
        </div>
        {isActiveProgression && !progressionLoading && (
          <ProgressionPanel
            exercise={progressionExercise!}
            muscles={progressionMuscles}
            data={progressionData}
            activeTab={progressionActiveTab}
            onTabChange={setProgressionActiveTab}
            onClose={() => setProgressionExercise(null)}
          />
        )}
        {isActiveProgression && progressionLoading && (
          <div style={{ padding: '12px 16px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            <span className="loading-spinner" /> Loading progression...
          </div>
        )}
      </React.Fragment>
    )
  }

  /** Per-activity edit body. Cardio gets the structured metadata form
   *  (row-less cardio); strength gets its exercise edit rows + add-row.
   *  Rendered by ActivityBlock inside the sport card while it's in edit mode. */
  const renderActivityEditRows = (a: ActivityResponse, date: string) => {
    if (a.category === 'cardio') {
      const field = (key: keyof typeof cardioDraft, label: string, opts?: { wide?: boolean; step?: string }) => (
        <label className={opts?.wide ? 'wide' : undefined}>
          {label}
          <input
            type={opts?.wide ? 'text' : 'number'}
            step={opts?.step}
            value={cardioDraft[key]}
            onChange={e => setCardioDraft(d => ({ ...d, [key]: e.target.value }))}
            onKeyDown={e => {
              if (e.key === 'Enter') saveActivityEdit()
              if (e.key === 'Escape') cancelActivityEdit()
            }}
          />
        </label>
      )
      return (
        <div className="wo-cardio-form">
          {field('laps', 'Laps')}
          {field('km', 'Distance (km)', { step: '0.01' })}
          {field('minutes', 'Duration (min)')}
          {field('notes', 'Notes', { wide: true })}
          {a.google_session_id == null && (
            <button className="wo-cardio-delete" onClick={() => handleDeleteActivity(a)}>
              {'🗑️'} Delete activity
            </button>
          )}
        </div>
      )
    }
    return renderStrengthEditRows(a, date)
  }

  const renderStrengthEditRows = (a: ActivityResponse, date: string) => (
    <>
      {a.exercises.map(ex => {
        const draft = editDrafts[ex.id] || {}
        const rowData: Partial<WorkoutResponse> = { ...ex, ...draft }
        const setRowData: React.Dispatch<React.SetStateAction<Partial<WorkoutResponse>>> = (action) => {
          const newVal = typeof action === 'function' ? action(rowData) : action
          for (const [k, v] of Object.entries(newVal)) {
            if (v !== (ex as any)[k]) updateDraft(ex.id, k as keyof WorkoutResponse, v)
          }
        }
        return (
          <div key={ex.id} className="wo-edit-row">
            <div className="wo-edit-fields">
              <EditInput field="exercise" editData={rowData} setEditData={setRowData} saveEdit={saveActivityEdit} cancelEdit={cancelActivityEdit} />
              <EditInput field="weight_lbs" width="80px" editData={rowData} setEditData={setRowData} saveEdit={saveActivityEdit} cancelEdit={cancelActivityEdit} />
              <EditInput field="reps_sets" width="80px" editData={rowData} setEditData={setRowData} saveEdit={saveActivityEdit} cancelEdit={cancelActivityEdit} />
              <EditInput field="equipment_type" type="select" options={EQUIPMENT_OPTIONS} editData={rowData} setEditData={setRowData} saveEdit={saveActivityEdit} cancelEdit={cancelActivityEdit} />
              <button className="wo-edit-delete" onClick={() => handleDelete(ex.id)} title="Delete">{'🗑️'}</button>
            </div>
            <div className="wo-edit-notes">
              <EditInput field="notes" type="text" width="100%" editData={rowData} setEditData={setRowData} saveEdit={saveActivityEdit} cancelEdit={cancelActivityEdit} />
            </div>
          </div>
        )
      })}
      {newRows.map((newEx, idx) => {
        const setNewRowData: React.Dispatch<React.SetStateAction<Partial<WorkoutResponse>>> = (action) => {
          const newVal = typeof action === 'function' ? action(newEx) : action
          for (const [k, v] of Object.entries(newVal)) {
            if (v !== (newEx as any)[k]) updateNewRow(idx, k, v)
          }
        }
        return (
          <div key={`new-${idx}`} className="wo-edit-row" style={{ borderLeft: '3px solid var(--accent-emerald)' }}>
            <div className="wo-edit-fields">
              <EditInput field="exercise" editData={newEx} setEditData={setNewRowData} saveEdit={saveActivityEdit} cancelEdit={cancelActivityEdit} />
              <EditInput field="weight_lbs" width="80px" editData={newEx} setEditData={setNewRowData} saveEdit={saveActivityEdit} cancelEdit={cancelActivityEdit} />
              <EditInput field="reps_sets" width="80px" editData={newEx} setEditData={setNewRowData} saveEdit={saveActivityEdit} cancelEdit={cancelActivityEdit} />
              <EditInput field="equipment_type" type="select" options={EQUIPMENT_OPTIONS} editData={newEx} setEditData={setNewRowData} saveEdit={saveActivityEdit} cancelEdit={cancelActivityEdit} />
              {a.category !== 'cardio' && (
                <EditInput field="category" type="select" options={CATEGORY_OPTIONS} editData={newEx} setEditData={setNewRowData} saveEdit={saveActivityEdit} cancelEdit={cancelActivityEdit} />
              )}
              <button className="wo-edit-delete" onClick={() => removeNewRow(idx)} title="Remove">{'✕'}</button>
            </div>
            <div className="wo-edit-notes">
              <EditInput field="notes" type="text" width="100%" editData={newEx} setEditData={setNewRowData} saveEdit={saveActivityEdit} cancelEdit={cancelActivityEdit} />
            </div>
          </div>
        )
      })}
      <div style={{ padding: '6px 0' }}>
        <button className="wo-session-action-btn" onClick={() => addNewRow(a, date)}>+ Add Exercise</button>
      </div>
    </>
  )

  const activityEdit: ActivityEditController = {
    editingId: editingActivity?.id ?? null,
    saving: savingEdit,
    start: startActivityEdit,
    cancel: cancelActivityEdit,
    save: saveActivityEdit,
    renderRows: renderActivityEditRows,
  }

  return (
    <>
      <PendingGoogleBanner
        reloadKey={pendingReloadKey}
        onChanged={reload}
        onAddDetail={setFinalizeTarget}
      />
      {finalizeTarget && (
        <FinalizeWorkoutPanel
          target={finalizeTarget}
          onCancel={() => setFinalizeTarget(null)}
          onDone={() => { setFinalizeTarget(null); setPendingReloadKey(k => k + 1); reload() }}
        />
      )}

      {/* Page header */}
      <div className="wo-page-header">
        <div>
          <div className="wo-page-title">{'🏋️'} Workout Log</div>
          <div className="wo-page-sub">{days.length} days &middot; {workouts.length} exercises logged</div>
        </div>
        <div className="wo-plan-controls">
          <input
            type="text"
            value={workoutNote}
            onChange={e => setWorkoutNote(e.target.value)}
            placeholder="Notes (e.g. knee pain...)"
            className="wo-plan-notes-input"
            onKeyDown={e => { if (e.key === 'Enter') handlePlanWorkout() }}
          />
          <div className="wo-plan-day-toggle">
            <button className={planDay === 'today' ? 'active' : ''} onClick={() => setPlanDay('today')}>Today</button>
            <button className={planDay === 'tomorrow' ? 'active' : ''} onClick={() => setPlanDay('tomorrow')}>Tomorrow</button>
          </div>
          <button className="btn btn-ghost" onClick={handlePlanWorkout} disabled={planLoading} style={{ fontSize: '0.82rem', padding: '5px 12px' }}>
            {planLoading ? <><span className="loading-spinner" /> Planning...</> : '🏋️ Plan Workout'}
          </button>
        </div>
      </div>

      {planError && (
        <div style={{ color: 'var(--accent-rose)', fontSize: '0.87rem', marginBottom: 'var(--space-md)' }}>
          {'⚠️'} {planError}
        </div>
      )}

      <div className="wo-filters">
        {LOG_FILTERS.map(f => (
          <button
            key={f.key}
            className={`wo-filter-chip${activeFilter === f.key ? ' active' : ''}`}
            style={{ ['--acc' as string]: f.color } as React.CSSProperties}
            onClick={() => setActiveFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
        <div className="wo-filter-spacer" />
        <div className="wo-search-wrap" ref={searchRef}>
          <div className="wo-search-bar">
            <input
              type="text"
              className="wo-search-input"
              placeholder="Search exercises..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onFocus={() => searchSuggestions.length > 0 && setShowSuggestions(true)}
            />
            {searchQuery && (
              <button
                className="wo-search-clear"
                onClick={() => { setSearchQuery(''); setShowSuggestions(false) }}
                title="Clear search"
              >×</button>
            )}
          </div>
          {showSuggestions && searchSuggestions.length > 0 && (
            <div className="wo-search-dropdown">
              {searchSuggestions.map((s, i) => (
                <div key={i} className="wo-search-option" onClick={() => {
                  setSearchQuery(s)
                  setShowSuggestions(false)
                }}>{s}</div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="wo-heatmap-card">
        {/* Months strip */}
        <div
          className="wo-heatmap-months"
          style={{ gridTemplateColumns: `repeat(${heatmapModel.weekCount}, 1fr)` }}
        >
          {monthLabels.map(ml => (
            <span
              key={ml.columnIndex}
              style={{ gridColumn: `${ml.columnIndex + 1} / span ${ml.columnSpan}` }}
            >
              {ml.monthName}
            </span>
          ))}
        </div>

        <div className="wo-heatmap-wrap">
          {/* Day labels (M . W . F . S) */}
          <div className="wo-heatmap-days">
            <span>M</span><span></span><span>W</span><span></span>
            <span>F</span><span></span><span>S</span>
          </div>

          {/* Grid */}
          <div
            className="wo-heatmap-grid"
            style={{ gridTemplateColumns: `repeat(${heatmapModel.weekCount}, 1fr)` }}
            onMouseLeave={() => setHeatmapHover(null)}
          >
            {heatmapModel.weeks.map((week, wIdx) => (
              <div className="wo-heatmap-col" key={wIdx}>
                {week.map(cell => renderHeatmapCell(cell))}
              </div>
            ))}
          </div>
        </div>

        {/* Stats band — consistency | lifetime output */}
        <div className="wo-heatmap-stats">
          <div className="wo-heatmap-stat">
            <span className="wo-heatmap-stat-num">{totalActive}</span>
            <span className="wo-heatmap-stat-label">Active days</span>
          </div>
          <div className="wo-heatmap-stat">
            <span className="wo-heatmap-stat-num">{adherencePct}%</span>
            <span className="wo-heatmap-stat-label">Adherence</span>
          </div>
          <div className="wo-heatmap-stat">
            <span className="wo-heatmap-stat-num">{perWeekAvg}</span>
            <span className="wo-heatmap-stat-label">Per week</span>
          </div>
          <div className="wo-heatmap-stat">
            <span className="wo-heatmap-stat-num" style={{ color: 'var(--accent-emerald)' }}>{streakStats.current}</span>
            <span className="wo-heatmap-stat-label">Streak</span>
          </div>
          <div className="wo-heatmap-stat">
            <span className="wo-heatmap-stat-num">{streakStats.longest}</span>
            <span className="wo-heatmap-stat-label">Best streak</span>
          </div>

          <div className="wo-heatmap-stat-sep" aria-hidden="true" />

          <div className="wo-heatmap-stat">
            <span className="wo-heatmap-stat-num">{lifetime.activities}</span>
            <span className="wo-heatmap-stat-label">Activities</span>
          </div>
          <div className="wo-heatmap-stat">
            <span className="wo-heatmap-stat-num">{fmtBig(lifetime.sets)}</span>
            <span className="wo-heatmap-stat-label">Sets</span>
          </div>
          <div className="wo-heatmap-stat">
            <span className="wo-heatmap-stat-num" style={{ color: 'var(--accent-rose)' }}>{fmtBig(lifetime.volume)}</span>
            <span className="wo-heatmap-stat-label">Lbs lifted</span>
          </div>
          <div className="wo-heatmap-stat">
            <span className="wo-heatmap-stat-num" style={{ color: 'var(--accent-amber)' }}>{Math.round(lifetime.distanceM / 1000)}</span>
            <span className="wo-heatmap-stat-label">Km covered</span>
          </div>
          <div className="wo-heatmap-stat">
            <span className="wo-heatmap-stat-num" style={{ color: 'var(--accent-sky)' }}>{lifetime.laps.toLocaleString()}</span>
            <span className="wo-heatmap-stat-label">Laps swum</span>
          </div>
          <div className="wo-heatmap-stat">
            <span className="wo-heatmap-stat-num" style={{ color: 'var(--accent-orange)' }}>{fmtBig(lifetime.kcal)}</span>
            <span className="wo-heatmap-stat-label">Kcal credited</span>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="loading-overlay"><span className="loading-spinner" /> Loading workouts...</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {filteredDays.map(({ day, flatRows }, idx) => {
            // Compute rest days between this day and the previous one
            let restDays = 0
            if (idx > 0) {
              const prev = new Date(filteredDays[idx - 1].day.date)
              const curr = new Date(day.date)
              restDays = Math.round((prev.getTime() - curr.getTime()) / 86400000) - 1
            }
            const isToday = day.date === todayISO()
            return (
              <React.Fragment key={day.date}>
                {restDays > 0 && (
                  <div className="wo-rest-divider">
                    <span className="wo-rest-line" />
                    <span className="wo-rest-label">
                      {restDays === 1 ? '1 rest day' : `${restDays} rest days`}
                    </span>
                    <span className="wo-rest-line" />
                  </div>
                )}
                <DayCard
                  day={day}
                  isToday={isToday}
                  expanded={expandedDates.has(day.date)}
                  expandedActivities={expandedActivities}
                  flatRows={flatRows}
                  onToggle={() => toggleSession(day.date)}
                  onToggleActivity={toggleActivity}
                  renderRow={ex => renderExerciseRow(ex, day.date)}
                  activityEdit={activityEdit}
                  cardRef={el => { sessionRefs.current[day.date] = el }}
                />
              </React.Fragment>
            )
          })}
        </div>
      )}

      {/* Plan Workout Modal */}
      {showPlanModal && planResult && (
        <div className="plan-modal-overlay" onClick={() => setShowPlanModal(false)}>
          <div className="plan-modal-content" onClick={e => e.stopPropagation()}>
            <button className="plan-modal-close" onClick={() => setShowPlanModal(false)}>{'✕'}</button>
            <WorkoutPlanCard plan={planResult} />
          </div>
        </div>
      )}
    </>
  )
}
