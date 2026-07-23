/**
 * Helpers for the dashboard "Upcoming" important-dates card.
 *
 * The backend (services/important_dates.py) already computes `days_until`
 * against the app's Pacific master date and sorts soonest-first, so these are
 * pure presentation helpers: turning that day count into a proximity "heat"
 * tier and a compact countdown badge, plus a timezone-safe date label.
 */

/** Urgency tiers, hottest (soonest) to coolest. Drives the per-row accent color. */
export type ProximityTier = 'today' | 'tomorrow' | 'week' | 'soon' | 'far';

/** Bucket a day count into a proximity tier. */
export function proximityTier(daysUntil: number): ProximityTier {
  if (daysUntil <= 0) return 'today';
  if (daysUntil === 1) return 'tomorrow';
  if (daysUntil <= 6) return 'week';
  if (daysUntil <= 30) return 'soon';
  return 'far';
}

/**
 * Split a day count into a big figure + small unit for the countdown badge.
 * Today is celebratory (🎉); far-out fallback dates collapse to months so the
 * badge never shows a cramped 3-digit number.
 */
export function countdownParts(daysUntil: number): { big: string; small: string } {
  if (daysUntil <= 0) return { big: '🎉', small: 'today' };
  if (daysUntil >= 100) {
    const months = Math.max(1, Math.round(daysUntil / 30));
    return { big: String(months), small: months === 1 ? 'month' : 'months' };
  }
  return { big: String(daysUntil), small: daysUntil === 1 ? 'day' : 'days' };
}

/**
 * Format an ISO `YYYY-MM-DD` as "Sun · Jun 21".
 * Parsed at local noon so the weekday/day never slips across a timezone boundary.
 */
export function formatDayLabel(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return '';
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  const monthDay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${weekday} · ${monthDay}`;
}
