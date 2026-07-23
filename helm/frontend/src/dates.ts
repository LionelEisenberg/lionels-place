/**
 * Date utilities — all dates stored as YYYY-MM-DD in the DB.
 * Displayed as DD/MM/YY in the UI (user preference).
 */

/** Format a Date as YYYY-MM-DD in local timezone. */
export function toLocalISO(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Today's date in YYYY-MM-DD (ISO) for API calls. */
export function todayISO(): string {
  return toLocalISO(new Date())
}

/** Convert YYYY-MM-DD to DD/MM/YY for display. */
export function displayDate(isoDate: string): string {
  if (!isoDate) return ''
  // Already in DD/MM format? pass through
  if (isoDate.includes('/')) return isoDate
  const parts = isoDate.split('-')
  if (parts.length !== 3) return isoDate
  const yy = parts[0].slice(-2)
  return `${parts[2]}/${parts[1]}/${yy}`
}

/** Start of the current week (Monday) in YYYY-MM-DD. */
export function startOfWeekISO(): string {
  const d = new Date()
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  return toLocalISO(d)
}

/** Start of the current month in YYYY-MM-DD. */
export function startOfMonthISO(): string {
  const d = new Date()
  d.setDate(1)
  return toLocalISO(d)
}

/** Format YYYY-MM-DD as "Mar 14" for day group headers. */
export function friendlyDate(isoDate: string): string {
  if (!isoDate) return ''
  const d = new Date(isoDate + 'T12:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Get weekday name from YYYY-MM-DD. */
export function weekdayName(isoDate: string): string {
  if (!isoDate) return ''
  const d = new Date(isoDate + 'T12:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'long' })
}
