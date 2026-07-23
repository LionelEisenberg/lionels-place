/** Pure helpers for the split-session Workout Log view. */

export function activityEmoji(activity: string): string {
  switch (activity) {
    case 'strength': return '🏋️' // 🏋️
    case 'swim': return '🏊'           // 🏊
    case 'run': return '🏃'            // 🏃
    case 'bike': return '🚴'           // 🚴
    case 'row': return '🚣'            // 🚣
    case 'hike': return '🥾'           // 🥾
    case 'elliptical': return '🌀'     // 🌀
    case 'stairs': return '🪜'         // 🪜 stair climber
    default: return '💪'               // 💪
  }
}

export function activityColor(activity: string): string {
  switch (activity) {
    case 'strength': return 'var(--accent-rose)'
    case 'swim': return 'var(--accent-sky)'
    case 'run': return 'var(--accent-orange)'
    case 'bike': return 'var(--accent-amber)'
    case 'row': return 'var(--accent-sky)'
    default: return 'var(--accent-indigo)'
  }
}

export function formatDurationMin(min: number | null | undefined): string {
  if (min == null) return ''
  const m = Math.round(min)
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h > 0 && r > 0) return `${h}h${r}m`
  if (h > 0) return `${h}h`
  return `${r}m`
}

export function formatRange(start: string | null | undefined, end: string | null | undefined): string {
  if (start && end) return `${start}–${end}`
  return start || end || ''
}
