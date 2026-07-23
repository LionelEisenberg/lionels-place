/** Pure helpers for the run session panel: pace math + SVG route projection. */

export type LatLng = [number, number]
export type RunSplit = { distance_m: number; seconds: number; avg_hr: number | null; marker: LatLng | null }

/** "5:31" from seconds-per-km. Empty string for null/invalid. */
export function formatPace(sPerKm: number | null | undefined): string {
  if (sPerKm == null || !isFinite(sPerKm) || sPerKm <= 0) return ''
  const s = Math.round(sPerKm)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Precise run duration from minutes: "28:43", or "1:02:05" past the hour.
 *  Runs deserve seconds — formatDurationMin's whole-minute rounding is for gym blocks. */
export function formatRunDuration(min: number | null | undefined): string {
  if (min == null || !isFinite(min) || min < 0) return ''
  const total = Math.round(min * 60)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

/** One split's pace in s/km (splits may be partial-km). Null when degenerate. */
export function splitPace(split: RunSplit): number | null {
  if (!split.distance_m || !split.seconds) return null
  return split.seconds / (split.distance_m / 1000)
}

/** Project lat/lng onto an SVG viewBox: equirectangular with cos(midLat)
 *  longitude correction, aspect-preserving, centered inside the padding. */
export function projectRoute(route: LatLng[], width: number, height: number, pad = 10):
    { x: number; y: number }[] {
  if (!route.length) return []
  const lats = route.map(p => p[0])
  const lngs = route.map(p => p[1])
  const minLat = Math.min(...lats), maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs)
  const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180)
  const spanX = (maxLng - minLng) * kx || 1e-9
  const spanY = (maxLat - minLat) || 1e-9
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY)
  const x0 = (width - spanX * scale) / 2
  const y0 = (height - spanY * scale) / 2
  return route.map(([lat, lng]) => ({
    x: x0 + (lng - minLng) * kx * scale,
    y: y0 + (maxLat - lat) * scale,          // lat grows north; SVG y grows down
  }))
}

/** Index of the route point nearest a marker (positions km labels on the trace). */
export function nearestPointIndex(route: LatLng[], marker: LatLng): number {
  if (!route.length) return -1
  let best = 0
  let bestD = Infinity
  route.forEach(([lat, lng], i) => {
    const d = (lat - marker[0]) ** 2 + (lng - marker[1]) ** 2
    if (d < bestD) { bestD = d; best = i }
  })
  return best
}
