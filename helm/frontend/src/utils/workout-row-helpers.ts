/** Pure row/aggregation helpers for the Workout Log — moved verbatim from
 *  WorkoutLog.tsx so DayCard / ActivityBlock / ProgressionPanel share one copy. */
import type { WorkoutResponse } from '../api'

export function parseWeights(weightStr: string): number[] {
  return weightStr.split(',').map(s => s.trim()).filter(Boolean)
    .map(s => parseFloat(s)).filter(n => !isNaN(n))
}

export function parseReps(repsStr: string): number[] {
  return repsStr.split(',').map(s => s.trim().replace(/\s*\(Fail\)/i, '')).filter(Boolean)
    .map(s => parseFloat(s)).filter(n => !isNaN(n))
}

export function countSets(repsStr: string): number {
  return repsStr.split(',').map(s => s.trim()).filter(Boolean).length
}

export function isCardioEntry(weightStr: string, equipmentType?: string): boolean {
  const w = weightStr.trim()
  if (equipmentType === 'None') return true
  return w === '-' || w === '—' || w === '' || w === '0'
}

export function parseCardioValue(repsStr: string): { laps: number | null; distance: number | null; distanceUnit: string | null; duration: number | null } {
  const s = repsStr.trim().toLowerCase()
  let laps: number | null = null
  let distance: number | null = null
  let distanceUnit: string | null = null
  let duration: number | null = null

  // Match laps: "30 Laps", "30 laps"
  const lapMatch = s.match(/(\d+)\s*laps?/i)
  if (lapMatch) laps = parseInt(lapMatch[1])

  // Match distance: "23 mi", "5.2 km", "3.5 miles"
  const distMatch = s.match(/([\d.]+)\s*(mi(?:les?)?|km|k)\b/i)
  if (distMatch) {
    distance = parseFloat(distMatch[1])
    distanceUnit = distMatch[2].startsWith('k') ? 'km' : 'mi'
  }

  // Match duration: "2 hrs", "45 min", "1:30", "1h30m", "2 hours"
  const hrsMinMatch = s.match(/(\d+)\s*(?:hrs?|hours?)\s*(?:(\d+)\s*(?:min(?:utes?)?|m)\b)?/i)
  const colonMatch = s.match(/(\d+):(\d{2})/)
  const minOnlyMatch = s.match(/(\d+)\s*(?:min(?:utes?)?)\b/i)

  if (hrsMinMatch) {
    duration = parseInt(hrsMinMatch[1]) * 60 + (hrsMinMatch[2] ? parseInt(hrsMinMatch[2]) : 0)
  } else if (colonMatch) {
    duration = parseInt(colonMatch[1]) * 60 + parseInt(colonMatch[2])
  } else if (minOnlyMatch) {
    duration = parseInt(minOnlyMatch[1])
  }

  return { laps, distance, distanceUnit, duration }
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h`
  return `${m}m`
}

export function computeVolume(weightStr: string, repsStr: string): number {
  const weights = parseWeights(weightStr)
  const reps = parseReps(repsStr)
  if (weights.length === 0 || reps.length === 0) return 0
  let vol = 0
  for (let i = 0; i < reps.length; i++) {
    const w = Math.abs(weights.length === 1 ? weights[0] : (weights[i] ?? weights[weights.length - 1]))
    vol += w * reps[i]
  }
  return vol
}

export function hasNegativeWeight(weightStr: string): boolean {
  return parseWeights(weightStr).some(w => w < 0)
}

export function getEffectiveWeight(weight: number, bodyWeight: number | null): number {
  if (weight < 0 && bodyWeight) return Math.round((bodyWeight + weight) * 10) / 10
  return Math.abs(weight)
}

export function computeEffectiveVolume(weightStr: string, repsStr: string, bodyWeight: number | null): number {
  const weights = parseWeights(weightStr)
  const reps = parseReps(repsStr)
  if (weights.length === 0 || reps.length === 0) return 0
  let vol = 0
  for (let i = 0; i < reps.length; i++) {
    const w = weights.length === 1 ? weights[0] : (weights[i] ?? weights[weights.length - 1])
    vol += getEffectiveWeight(w, bodyWeight) * reps[i]
  }
  return vol
}

export function getEffectiveMaxWeight(weightStr: string, bodyWeight: number | null): number {
  const weights = parseWeights(weightStr)
  if (weights.length === 0) return 0
  return Math.max(...weights.map(w => getEffectiveWeight(w, bodyWeight)))
}

export function getMaxWeight(weightStr: string): number {
  const weights = parseWeights(weightStr)
  if (weights.length === 0) return 0
  return Math.max(...weights)
}

export function getEquipClass(eq: string): string {
  if (!eq) return ''
  const l = eq.toLowerCase()
  if (l.includes('dumbbell')) return 'dumbbell'
  if (l.includes('barbell')) return 'barbell'
  if (l.includes('machine')) return 'machine'
  if (l.includes('cable')) return 'cable'
  if (l.includes('body')) return 'bodyweight'
  return ''
}

export function getEquipAbbrev(eq: string): string {
  if (!eq) return ''
  const l = eq.toLowerCase()
  if (l.includes('dumbbell')) return 'DB'
  if (l.includes('barbell')) return 'BB'
  if (l.includes('machine')) return 'Machine'
  if (l.includes('cable')) return 'Cable'
  if (l.includes('body')) return 'BW'
  if (l.includes('smith')) return 'Smith'
  if (l.includes('band')) return 'Bands'
  if (l.includes('plate')) return 'Plates'
  return eq
}

export function formatWeight(weightStr: string, isCardio: boolean): string {
  if (isCardio || weightStr === '-' || !weightStr) return weightStr || '\u2014'
  return weightStr
}

export function formatReps(repsStr: string): { text: string; hasFail: boolean }[] {
  return repsStr.split(',').map(s => {
    const trimmed = s.trim()
    const hasFail = /\(Fail\)/i.test(trimmed)
    const text = trimmed.replace(/\s*\(Fail\)/i, '').trim()
    return { text, hasFail }
  })
}

/* ───────── Exercise Name Normalization ───────── */

const EXERCISE_ALIASES: Record<string, string> = {
  'db': 'dumbbell', 'bb': 'barbell', 'ez': 'ez bar',
  'ohp': 'overhead press', 'rdl': 'romanian deadlift',
  'lat raise': 'lateral raise', 'bench': 'bench press',
}

// Precompile the alias patterns once. Building these RegExps inside
// normalizeExerciseName meant every delta comparison allocated ~7 fresh regexes —
// and computeDelta scans up to ~1000 workouts per exercise row, so searching
// allocated millions of regexes per keystroke and made the log lag badly.
// Reusing a /g regex across .replace() is safe: replace() resets lastIndex.
const ALIAS_PATTERNS: { re: RegExp; full: string }[] = Object.entries(EXERCISE_ALIASES)
  .map(([abbr, full]) => ({ re: new RegExp(`\\b${abbr}\\b`, 'g'), full }))
const FILLER_WORDS_RE = /\b(the|a|an|with)\b/g
const WHITESPACE_RE = /\s+/g
const _normalizeCache = new Map<string, string>()

export function normalizeExerciseName(name: string): string {
  // Pure + deterministic, so cache by input. Distinct exercise names are bounded
  // (a few hundred), so this is effectively O(1) after warmup.
  const cached = _normalizeCache.get(name)
  if (cached !== undefined) return cached
  let n = name.toLowerCase().trim()
  for (const { re, full } of ALIAS_PATTERNS) n = n.replace(re, full)
  n = n.replace(FILLER_WORDS_RE, '').replace(WHITESPACE_RE, ' ').trim()
  _normalizeCache.set(name, n)
  return n
}

export function exerciseNamesMatch(a: string, b: string): boolean {
  if (a === b) return true
  return normalizeExerciseName(a) === normalizeExerciseName(b)
}

/* ───────── Delta Computation ───────── */

export type Delta = { label: string; className: string }

export function computeDelta(
  exercise: WorkoutResponse,
  sessionDate: string,
  allWorkouts: WorkoutResponse[]
): Delta {
  const previous = allWorkouts.find(w =>
    exerciseNamesMatch(w.exercise, exercise.exercise) &&
    w.equipment_type === exercise.equipment_type &&
    w.date < sessionDate
  )
  if (!previous) return { label: '\u2605 new', className: 'new' }

  const currMax = getMaxWeight(exercise.weight_lbs)
  const prevMax = getMaxWeight(previous.weight_lbs)

  if (currMax !== 0 && prevMax !== 0) {
    if (currMax > prevMax) return { label: `\u2191 +${Math.round(currMax - prevMax)} lbs`, className: 'up' }
    if (currMax < prevMax) return { label: `\u2193 -${Math.round(prevMax - currMax)} lbs`, className: 'down' }
  }

  const currReps = parseReps(exercise.reps_sets).reduce((a, b) => a + b, 0)
  const prevReps = parseReps(previous.reps_sets).reduce((a, b) => a + b, 0)
  if (currReps > prevReps) return { label: `\u2191 +${currReps - prevReps} reps`, className: 'up' }
  if (currReps < prevReps) return { label: `\u2193 -${prevReps - currReps} reps`, className: 'down' }

  return { label: '= same', className: 'same' }
}
