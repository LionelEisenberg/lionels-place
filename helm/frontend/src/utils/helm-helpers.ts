/**
 * Color-coding and scoring helpers for Helm.
 * Extracted from Helm.tsx for testability.
 */

export function getCalColor(cal: number): string {
  if (cal === 0) return 'var(--text-muted)'
  if (cal <= 1850) return 'var(--accent-emerald)'
  if (cal <= 2200) return 'var(--accent-amber)'
  return 'var(--accent-rose)'
}

export function getProteinColor(p: number): string {
  if (p === 0) return 'var(--text-muted)'
  if (p >= 135) return 'var(--accent-emerald)'
  if (p >= 125) return 'var(--accent-amber)'
  return 'var(--accent-rose)'
}

export function getCarbColor(c: number): string {
  if (c === 0) return 'var(--text-muted)'
  if (c <= 250) return 'var(--accent-emerald)'
  if (c <= 325) return 'var(--accent-amber)'
  return 'var(--accent-rose)'
}

export function getFatColor(f: number): string {
  if (f === 0) return 'var(--text-muted)'
  if (f <= 65) return 'var(--accent-emerald)'
  if (f <= 85) return 'var(--accent-amber)'
  return 'var(--accent-rose)'
}

export function getMoodEmoji(m: string | null | undefined): string {
  if (!m) return '—'
  const n = parseInt(m.charAt(0))
  if (n === 5) return '✨'
  if (n === 4) return '👍'
  if (n === 3) return '😐'
  if (n === 2) return '🔻'
  if (n === 1) return '😩'
  return '—'
}

export interface HabitFields {
  habit_workout: boolean
  habit_clean: boolean
  habit_productivity: boolean
  habit_sleep: boolean
  habit_love: boolean
  habit_custom: boolean
}

export function getHabitScore(d: HabitFields): number {
  return [d.habit_workout, d.habit_clean, d.habit_productivity, d.habit_sleep, d.habit_love, d.habit_custom].filter(Boolean).length
}

export function getHabitClass(score: number): string {
  return score >= 5 ? 'great' : score >= 3 ? 'good' : 'low'
}
