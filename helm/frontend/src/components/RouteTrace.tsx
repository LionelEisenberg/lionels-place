import { useId } from 'react'
import { projectRoute, nearestPointIndex, type LatLng, type RunSplit } from '../utils/run-helpers'

/** Self-contained SVG route trace: soft-glow progress-gradient polyline over a
 *  faint dot grid, start/end dots with rings, km markers from split coordinates.
 *  No tiles, no external requests. Fills its container (fixed-height card). */
export function RouteTrace({ route, splits }: { route: LatLng[]; splits: RunSplit[] | null }) {
  const gid = useId().replace(/\W/g, '')
  const W = 340, H = 236
  const pts = projectRoute(route, W, H, 22)
  if (pts.length < 2) return null
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const markers = (splits || [])
    .map((s, i) => ({ s, km: i + 1 }))                     // number before filtering so GPS
    .filter(({ s }) => s.marker && s.distance_m >= 999)    // dropouts can't shift km labels
    .map(({ s, km }) => ({ ...pts[nearestPointIndex(route, s.marker!)], km }))
  const start = pts[0], end = pts[pts.length - 1]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: '100%', display: 'block' }} aria-hidden="true">
      <defs>
        <linearGradient id={`rt-${gid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="55%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
        <radialGradient id={`rtbg-${gid}`} cx="50%" cy="42%" r="80%">
          <stop offset="0%" stopColor="rgba(99,102,241,0.10)" />
          <stop offset="100%" stopColor="rgba(99,102,241,0)" />
        </radialGradient>
        <pattern id={`rtdots-${gid}`} width="22" height="22" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="rgba(255,255,255,0.05)" />
        </pattern>
        <filter id={`rtglow-${gid}`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="4.5" />
        </filter>
      </defs>
      <rect width={W} height={H} fill={`url(#rtdots-${gid})`} />
      <rect width={W} height={H} fill={`url(#rtbg-${gid})`} />
      <path d={d} fill="none" stroke={`url(#rt-${gid})`} strokeWidth="6.5" strokeLinejoin="round"
        strokeLinecap="round" opacity="0.4" filter={`url(#rtglow-${gid})`} />
      <path d={d} fill="none" stroke={`url(#rt-${gid})`} strokeWidth="2.75" strokeLinejoin="round" strokeLinecap="round" />
      {markers.map(m => (
        <g key={m.km}>
          <circle cx={m.x} cy={m.y} r="8.5" fill="var(--bg-card)" stroke="#6366f1" strokeWidth="1.25" />
          <text x={m.x} y={m.y + 3} textAnchor="middle" fontSize="8.5" fill="var(--text-secondary)" fontFamily="var(--font-mono)">{m.km}</text>
        </g>
      ))}
      <circle cx={start.x} cy={start.y} r="8" fill="rgba(52,211,153,0.18)" />
      <circle cx={start.x} cy={start.y} r="4.25" fill="#34d399" stroke="rgba(0,0,0,0.65)" strokeWidth="1.5" />
      <circle cx={end.x} cy={end.y} r="8" fill="rgba(248,113,113,0.18)" />
      <circle cx={end.x} cy={end.y} r="4.25" fill="#f87171" stroke="rgba(0,0,0,0.65)" strokeWidth="1.5" />
    </svg>
  )
}
