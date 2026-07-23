/** Shared per-activity telemetry: stat tiles (expanded activity headers + the
 *  pending-Google banner) and collapsed-day chip headlines. Pure module. */
import { formatPace, formatRunDuration } from './run-helpers'
import { formatDurationMin } from './session-helpers'
import { countSets, computeVolume } from './workout-row-helpers'

/** Common metric subset of ActivityResponse and PendingGoogleSession. */
export interface ActivityMetrics {
  activity: string;
  duration_min?: number | null;
  distance_m?: number | null;
  pace_s_per_km?: number | null;
  avg_hr?: number | null;
  credited_kcal?: number | null;
  elevation_gain_m?: number | null;
  avg_cadence_spm?: number | null;
}

/** Row-derived context statTiles/chipStats can't compute from metrics alone. */
export interface ActivityExtras {
  volume?: number;
  sets?: number;
  laps?: number | null;
  exerciseCount?: number;
}

export interface StatTile { v: string; u: string; hero?: boolean }

/** "18.4k lbs" above 1k, "840 lbs" below. */
export function formatVolumeShort(volume: number): string {
  if (volume >= 1000) return `${(volume / 1000).toFixed(1)}k lbs`
  return `${Math.round(volume)} lbs`
}

/** Extras from an activity's own exercise rows (volume only counts for strength). */
export function activityExtras(a: {
  activity: string;
  laps?: number | null;
  exercises: { weight_lbs: string; reps_sets: string }[];
}): ActivityExtras {
  return {
    volume: a.activity === 'strength'
      ? a.exercises.reduce((v, ex) => v + computeVolume(ex.weight_lbs, ex.reps_sets), 0)
      : 0,
    sets: a.exercises.reduce((n, ex) => n + countSets(ex.reps_sets), 0),
    laps: a.laps ?? null,
    exerciseCount: a.exercises.length,
  }
}

/** Activity-specific stat rail. Each activity surfaces the metrics that matter
 *  for it; tiles whose data is missing are omitted. `includeTime: false` is used
 *  by the log's activity headers, whose meta line already shows range+duration. */
export function statTiles(
  m: ActivityMetrics,
  extra?: ActivityExtras,
  opts: { includeTime?: boolean } = {},
): StatTile[] {
  const includeTime = opts.includeTime !== false
  const km = m.distance_m != null ? m.distance_m / 1000 : null
  const dur = formatDurationMin(m.duration_min)
  const t: StatTile[] = []
  const hr = () => { if (m.avg_hr != null) t.push({ v: String(m.avg_hr), u: 'bpm ♥' }) }
  const kcal = () => { if (m.credited_kcal != null) t.push({ v: String(Math.round(m.credited_kcal)), u: 'kcal' }) }
  const elev = () => { if (m.elevation_gain_m != null) t.push({ v: String(Math.round(m.elevation_gain_m)), u: 'elev m' }) }
  const time = (hero: boolean) => { if (includeTime && dur) t.push({ v: dur, u: 'time', hero }) }

  switch (m.activity) {
    case 'run':
      if (km != null) t.push({ v: km.toFixed(2), u: 'km', hero: true })
      if (m.pace_s_per_km != null) t.push({ v: formatPace(m.pace_s_per_km), u: 'min/km', hero: true })
      if (includeTime) {
        const rd = formatRunDuration(m.duration_min) || dur
        if (rd) t.push({ v: rd, u: 'time' })
      }
      hr(); elev()
      if (m.avg_cadence_spm != null) t.push({ v: String(m.avg_cadence_spm), u: 'spm' })
      kcal()
      break
    case 'bike': {
      const kmh = km != null && m.duration_min ? km / (m.duration_min / 60) : null
      if (km != null) t.push({ v: km.toFixed(1), u: 'km', hero: true })
      if (kmh != null) t.push({ v: kmh.toFixed(1), u: 'km/h', hero: true })
      time(km == null)
      elev()
      if (m.avg_cadence_spm != null) t.push({ v: String(m.avg_cadence_spm), u: 'rpm' })
      hr(); kcal()
      break
    }
    case 'swim':
      if (m.distance_m != null) t.push({ v: Math.round(m.distance_m).toLocaleString(), u: 'meters', hero: true })
      if (extra?.laps != null) t.push({ v: String(extra.laps), u: 'laps', hero: m.distance_m == null })
      time(m.distance_m == null && extra?.laps == null)
      if (m.distance_m && m.duration_min) {
        t.push({ v: formatPace((m.duration_min * 60) / (m.distance_m / 100)), u: '/100m' })
      }
      hr(); kcal()
      break
    case 'row':
    case 'hike':
      if (km != null) t.push({ v: km.toFixed(2), u: 'km', hero: true })
      time(km == null)
      if (m.activity === 'hike') elev()
      hr(); kcal()
      break
    default: {  // strength, elliptical, stairs, cardio
      const vol = extra?.volume ?? 0
      const sets = extra?.sets ?? 0
      if (m.activity === 'strength' && (vol > 0 || sets > 0)) {
        if (vol > 0) t.push({ v: Math.round(vol).toLocaleString(), u: 'lbs vol', hero: true })
        if (sets > 0) t.push({ v: String(sets), u: 'sets', hero: true })
        time(false)
        hr(); kcal()
      } else {
        time(true)
        hr(); kcal()
      }
    }
  }
  return t.filter(x => x.v)
}

/** Collapsed-day chip headline, e.g. "52m · 18.4k lbs" / "5.21 km · 6:22/km".
 *  Fallback chain ends at "N ex" so a chip never renders empty. */
export function chipStats(m: ActivityMetrics, extra?: ActivityExtras): string {
  const km = m.distance_m != null ? m.distance_m / 1000 : null
  const dur = formatDurationMin(m.duration_min)
  const parts: string[] = []
  switch (m.activity) {
    case 'run': {
      if (km != null) parts.push(`${km.toFixed(2)} km`)
      const pace = formatPace(m.pace_s_per_km)
      if (pace) parts.push(`${pace}/km`)
      if (parts.length === 0 && dur) parts.push(dur)
      break
    }
    case 'bike': {
      if (km != null) parts.push(`${km.toFixed(1)} km`)
      const kmh = km != null && m.duration_min ? km / (m.duration_min / 60) : null
      if (kmh != null) parts.push(`${kmh.toFixed(1)} km/h`)
      if (parts.length === 0 && dur) parts.push(dur)
      break
    }
    case 'swim': {
      if (m.distance_m != null) parts.push(`${Math.round(m.distance_m).toLocaleString()} m`)
      else if (extra?.laps != null) parts.push(`${extra.laps} laps`)
      if (dur) parts.push(dur)
      break
    }
    case 'strength': {
      if (dur) parts.push(dur)
      if (extra?.volume) parts.push(formatVolumeShort(extra.volume))
      else if (extra?.sets) parts.push(`${extra.sets} sets`)
      break
    }
    default:
      if (dur) parts.push(dur)
  }
  if (parts.length === 0) parts.push(`${extra?.exerciseCount ?? 0} ex`)
  return parts.join(' · ')
}
