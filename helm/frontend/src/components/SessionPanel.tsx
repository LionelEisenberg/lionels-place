import { useEffect, useState, useRef, useId } from 'react'
import {
  type LogSession, type SessionHeartRateResponse, type SessionHistoryRow,
  type RunDetailResponse,
  getSessionHeartRate, getSessionHistory, getRunDetail,
} from '../api'
import { formatDurationMin } from '../utils/session-helpers'
import { displayDate } from '../dates'
import { formatPace, splitPace, type RunSplit } from '../utils/run-helpers'
import { RouteTrace } from './RouteTrace'

// The owner's actual Fitbit HR zones (bpm floors; top zone open-ended).
const HR_ZONES = [
  { lo: 30,  hi: 118, name: 'Light',    chip: '#64748b' },
  { lo: 118, hi: 143, name: 'Moderate', chip: '#38bdf8' },
  { lo: 143, hi: 174, name: 'Vigorous', chip: '#f59e0b' },
  { lo: 174, hi: 300, name: 'Peak',     chip: '#f43f5e' },
]
const zoneBand = (chip: string) => ({ '#64748b': 'rgba(148,163,184,0.05)', '#38bdf8': 'rgba(56,189,248,0.07)', '#f59e0b': 'rgba(245,158,11,0.10)', '#f43f5e': 'rgba(244,63,94,0.10)' }[chip] || 'transparent')

function HrCurve({ hr }: { hr: SessionHeartRateResponse }) {
  const gid = useId().replace(/[:]/g, '')
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const pts = hr.points
  if (!pts.length) {
    return <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', padding: '10px 0' }}>No heart-rate samples for this window.</div>
  }
  const W = 600, H = 116, pad = 8
  const bpms = pts.map(p => p.bpm)
  const lo = (hr.min_bpm ?? Math.min(...bpms)) - 5
  const hi = (hr.max_bpm ?? Math.max(...bpms)) + 5
  const span = Math.max(hi - lo, 1)
  const n = pts.length
  const xPct = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100)
  const xAt = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W)
  const yAt = (b: number) => H - pad - ((b - lo) / span) * (H - 2 * pad)
  const yPct = (b: number) => (yAt(b) / H) * 100
  const clamp = (b: number) => Math.max(lo, Math.min(hi, b))
  const line = pts.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.bpm).toFixed(1)}`).join(' ')
  const bands = HR_ZONES.filter(z => z.lo < hi && z.hi > lo)
  const dist = HR_ZONES.filter(z => pts.some(p => p.bpm >= z.lo && p.bpm < z.hi))
  const pct = (z: typeof HR_ZONES[number]) => Math.round((pts.filter(p => p.bpm >= z.lo && p.bpm < z.hi).length / n) * 100)
  const zoneOf = (b: number) => HR_ZONES.find(z => b >= z.lo && b < z.hi)
  const hp = hover != null ? pts[hover] : null
  const hpZone = hp ? zoneOf(hp.bpm) : null
  const ticks = [...new Set([0, Math.floor((n - 1) / 2), n - 1])]

  return (
    <>
      <div ref={wrapRef} style={{ position: 'relative', height: '100px', cursor: 'crosshair' }}
        onMouseMove={(e) => {
          const el = wrapRef.current
          if (!el) return
          const r = el.getBoundingClientRect()
          setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))))
        }}
        onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} aria-hidden="true">
          <defs>
            <linearGradient id={`hg-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="rgba(244,63,94,0.30)" />
              <stop offset="1" stopColor="rgba(244,63,94,0)" />
            </linearGradient>
          </defs>
          {bands.map((z, i) => {
            const t = yAt(clamp(z.hi)), b = yAt(clamp(z.lo))
            return <rect key={i} x="0" y={t} width={W} height={Math.max(0, b - t)} fill={zoneBand(z.chip)} />
          })}
          <polygon points={`${line} ${W},${H} 0,${H}`} fill={`url(#hg-${gid})`} />
          {bands.map((z, i) => (z.lo > lo && z.lo < hi
            ? <line key={`l${i}`} x1="0" y1={yAt(z.lo)} x2={W} y2={yAt(z.lo)} stroke={z.chip} strokeWidth="1" strokeDasharray="2 4" opacity="0.5" vectorEffect="non-scaling-stroke" />
            : null))}
          <polyline points={line} fill="none" stroke="#fb7185" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {hp && (
          <>
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${xPct(hover!)}%`, width: '1px', background: 'rgba(255,255,255,0.3)', pointerEvents: 'none', transition: 'left 0.07s ease-out' }} />
            <div style={{ position: 'absolute', left: `${xPct(hover!)}%`, top: `${yPct(hp.bpm)}%`, width: '9px', height: '9px', borderRadius: '50%', background: '#fb7185', border: '2px solid var(--bg-card)', boxShadow: '0 0 8px rgba(244,63,94,0.75)', transform: 'translate(-50%,-50%)', pointerEvents: 'none', transition: 'left 0.07s ease-out, top 0.07s ease-out' }} />
            <div style={{ position: 'absolute', left: `${Math.min(90, xPct(hover!))}%`, top: '2px', transform: 'translateX(-50%)', background: 'var(--bg-card-hover)', border: '1px solid var(--border-medium)', borderRadius: '6px', padding: '3px 8px', fontSize: '0.66rem', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', pointerEvents: 'none', color: 'var(--text-primary)', boxShadow: 'var(--shadow-md)', animation: 'hrTipIn 0.14s ease-out' }}>
              {hp.t} · <span style={{ color: '#fb7185' }}>{hp.bpm}</span> bpm{hpZone && <> · <span style={{ color: hpZone.chip }}>{hpZone.name}</span></>}
            </div>
          </>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: '3px' }}>
        {ticks.map((i, k) => <span key={k}>{pts[i].t.slice(0, 5)}</span>)}
      </div>
      {dist.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '2px', marginTop: '11px', height: '8px', borderRadius: '4px', overflow: 'hidden' }}>
            {dist.map((z, i) => <div key={i} title={`${z.name} · ${pct(z)}%`} style={{ width: `${Math.max(pct(z), 1)}%`, minWidth: pct(z) > 0 ? '3px' : 0, background: z.chip }} />)}
          </div>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '7px', fontSize: '0.62rem', color: 'var(--text-secondary)' }}>
            {dist.map((z, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: z.chip }} />
                {z.name} <span style={{ fontFamily: 'var(--font-mono)', color: z.chip }}>{pct(z)}%</span>
              </span>
            ))}
          </div>
        </>
      )}
    </>
  )
}

/** Strava-style split rows: one row per km, bar length = speed (longer = faster),
 *  pace + ♥ printed inline so nothing needs decoding or hovering. */
function SplitsChart({ splits }: { splits: RunSplit[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const paces = splits.map(splitPace)
  const valid = paces.filter((p): p is number => p != null)
  if (!valid.length) return null
  const fastest = Math.min(...valid)
  const slowest = Math.max(...valid)
  // Bar width mapped to 24..66% of the row so pace + ♥ always fit after it.
  const wPct = (p: number | null) =>
    p == null ? 0 : 24 + 42 * ((slowest - p) / Math.max(slowest - fastest, 1e-9))
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginBottom: '9px' }}>
        <span className="wo-panel-kick">km splits</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '13px', fontSize: '0.62rem', color: 'var(--text-muted)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <span style={{ width: '18px', height: '7px', borderRadius: '2px', background: 'linear-gradient(90deg, rgba(56,189,248,0.14), rgba(56,189,248,0.8))' }} />
            longer = faster
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#34d399' }} /> fastest
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#fb7185' }} /> slowest
          </span>
        </span>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '6px', overflowY: 'auto' }}>
        {splits.map((s, i) => {
          const p = paces[i]
          const partial = s.distance_m < 999
          const isFast = p != null && p === fastest && slowest !== fastest
          const isSlow = p != null && p === slowest && slowest !== fastest
          return (
            <div key={i}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              style={{ display: 'flex', alignItems: 'center', gap: '10px', minHeight: '17px' }}>
              <span style={{ width: '24px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: '0.66rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                {partial ? (s.distance_m / 1000).toFixed(1) : i + 1}
              </span>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '9px', minWidth: 0 }}>
                <div style={{
                  width: `${wPct(p)}%`, height: '11px', borderRadius: '3px', flexShrink: 0,
                  background: hover === i
                    ? 'linear-gradient(90deg, rgba(56,189,248,0.5), #38bdf8)'
                    : partial
                      ? 'linear-gradient(90deg, rgba(56,189,248,0.08), rgba(56,189,248,0.35))'
                      : 'linear-gradient(90deg, rgba(56,189,248,0.14), rgba(56,189,248,0.8))',
                  transition: 'background 0.15s',
                }} />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.74rem', whiteSpace: 'nowrap', color: isFast ? '#34d399' : isSlow ? '#fb7185' : 'var(--text-secondary)' }}>
                  {formatPace(p) || '—'}
                </span>
                {s.avg_hr != null && (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.64rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>♥{s.avg_hr}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** One merged progression chart: a primary metric as bars + avg HR as a line.
 *  'pace' bars encode SPEED (taller = faster, stated in the legend) with the
 *  label shown as pace — same convention as the splits chart. */
export type ProgressionMetric = 'laps' | 'duration' | 'distance' | 'pace' | 'speed'

/** Session's average speed in km/h, or null when distance/duration are missing. */
const speedOf = (r: SessionHistoryRow): number | null =>
  r.distance_m && r.duration_min ? (r.distance_m / 1000) / (r.duration_min / 60) : null

function SessionProgression({ rows, currentDate, metric }: { rows: SessionHistoryRow[]; currentDate: string; metric: ProgressionMetric }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const chrono = [...rows].reverse()
  if (!chrono.length) return null
  const n = chrono.length
  const W = 640, base = 104, top = 12
  const valOf = (r: SessionHistoryRow) =>
    metric === 'laps' ? (r.laps ?? 0)
    : metric === 'distance' ? ((r.distance_m ?? 0) / 1000)
    : metric === 'pace' ? (r.pace_s_per_km ? 3600 / r.pace_s_per_km : 0)   // km/h — bar size = speed
    : metric === 'speed' ? (speedOf(r) ?? 0)
    : (r.duration_min ?? 0)
  const maxVal = Math.max(...chrono.map(valOf), 1)
  const hrVals = chrono.map(r => r.avg_hr ?? 0).filter(v => v > 0)
  const hrLo = (hrVals.length ? Math.min(...hrVals) : 100) - 4
  const hrHi = (hrVals.length ? Math.max(...hrVals) : 150) + 4
  const colW = W / n
  const cx = (i: number) => colW * (i + 0.5)
  const barW = Math.min(28, Math.max(2, colW * 0.55))
  const valY = (v: number) => base - (v / maxVal) * (base - top)
  const hrY = (h: number) => base - 6 - ((h - hrLo) / Math.max(hrHi - hrLo, 1)) * (base - top - 6)
  const hrPts = chrono.map((r, i) => (r.avg_hr ? `${cx(i).toFixed(1)},${hrY(r.avg_hr).toFixed(1)}` : null)).filter(Boolean).join(' ')
  const hp = hover != null ? chrono[hover] : null

  return (
    <>
      <div ref={wrapRef} style={{ position: 'relative', cursor: 'crosshair' }}
        onMouseMove={(e) => {
          const el = wrapRef.current
          if (!el) return
          const r = el.getBoundingClientRect()
          setHover(Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n))))
        }}
        onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} 118`} style={{ width: '100%', height: 'auto', display: 'block' }} aria-hidden="true">
          <line x1="0" y1={base} x2={W} y2={base} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
          {chrono.map((r, i) => valOf(r) > 0 ? (
            <rect key={i} x={cx(i) - barW / 2} y={valY(valOf(r))} width={barW} height={Math.max(0, base - valY(valOf(r)))} rx="2"
              fill={r.date === currentDate ? '#38bdf8' : 'rgba(56,189,248,0.4)'} />
          ) : (
            // Session exists but carries no data for this metric — show a dim
            // baseline stub instead of an invisible zero-height bar.
            <rect key={i} x={cx(i) - barW / 2} y={base - 3} width={barW} height={3} rx="1.5"
              fill="rgba(255,255,255,0.10)" />
          ))}
          {hrPts && <polyline points={hrPts} fill="none" stroke="#fb7185" strokeWidth="2" />}
          {chrono.map((r, i) => r.avg_hr ? <circle key={i} cx={cx(i)} cy={hrY(r.avg_hr)} r={r.date === currentDate ? 4 : 2.6} fill="#fb7185" /> : null)}
          {hp && <line x1={cx(hover!)} y1="0" x2={cx(hover!)} y2={base} stroke="rgba(255,255,255,0.22)" strokeWidth="1" />}
        </svg>
        {hp && (
          <div style={{ position: 'absolute', left: `${Math.min(92, Math.max(8, (cx(hover!) / W) * 100))}%`, top: '-2px', transform: 'translateX(-50%)', background: 'var(--bg-card-hover)', border: '1px solid var(--border-medium)', borderRadius: '6px', padding: '3px 8px', fontSize: '0.66rem', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', pointerEvents: 'none', color: 'var(--text-primary)', boxShadow: 'var(--shadow-md)', animation: 'hrTipIn 0.14s ease-out' }}>
            {displayDate(hp.date)}
            {metric === 'laps' && <> · <span style={{ color: '#38bdf8' }}>{hp.laps ?? '—'} laps</span></>}
            {metric === 'distance' && <> · <span style={{ color: '#38bdf8' }}>{hp.distance_m ? `${(hp.distance_m / 1000).toFixed(2)} km` : '—'}</span></>}
            {metric === 'pace' && <> · <span style={{ color: '#38bdf8' }}>{hp.pace_s_per_km ? `${formatPace(hp.pace_s_per_km)}/km` : '—'}</span></>}
            {metric === 'speed' && <> · <span style={{ color: '#38bdf8' }}>{speedOf(hp) != null ? `${speedOf(hp)!.toFixed(1)} km/h` : '—'}</span></>}
            · {formatDurationMin(hp.duration_min) || '—'}
            {hp.avg_hr ? <> · <span style={{ color: '#fb7185' }}>♥{hp.avg_hr}</span></> : null}
            {metric === 'duration' && hp.max_hr ? <> · max {hp.max_hr}</> : null}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: '4px' }}>
        <span>{displayDate(chrono[0].date)}</span>{n > 1 && <span>{displayDate(chrono[n - 1].date)}</span>}
      </div>
      <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap', fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: '7px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: '9px', height: '9px', borderRadius: '2px', background: 'rgba(56,189,248,0.4)' }} />
          {metric === 'laps' ? 'laps per session'
            : metric === 'distance' ? 'distance (km)'
            : metric === 'pace' ? 'avg pace — taller = faster'
            : metric === 'speed' ? 'avg speed (km/h)'
            : 'duration (min)'}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: '9px', height: '9px', borderRadius: '2px', background: '#38bdf8' }} /> this session
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: '12px', borderTop: '2px solid #fb7185' }} /> avg ♥ (bpm)
        </span>
        {chrono.some(r => valOf(r) <= 0) && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <span style={{ width: '9px', height: '3px', borderRadius: '1.5px', background: 'rgba(255,255,255,0.18)' }} /> no data for this metric
          </span>
        )}
      </div>
    </>
  )
}

/** Inline panel: this session's HR curve + a merged progression of past sessions of its type. */
export function SessionPanel({ session, date }: { session: LogSession; date: string }) {
  const [hr, setHr] = useState<SessionHeartRateResponse | null>(null)
  const [history, setHistory] = useState<SessionHistoryRow[]>([])
  const [runDetail, setRunDetail] = useState<RunDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [chosenMetric, setChosenMetric] = useState<ProgressionMetric>('distance')
  const isCardio = session.category === 'cardio'
  const isRun = session.activity === 'run'
  // Sport-tailored progression: runs toggle distance/pace, bikes distance/speed,
  // swims chart laps, everything else (strength, machines) charts duration.
  const metricOptions: ProgressionMetric[] | null =
    isRun ? ['distance', 'pace']
    : session.activity === 'bike' ? ['distance', 'speed']
    : null
  const metric: ProgressionMetric = metricOptions
    ? chosenMetric
    : session.activity === 'swim' ? 'laps' : 'duration'

  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([
      session.google_session_id != null
        ? getSessionHeartRate(session.google_session_id).catch(() => null)
        : Promise.resolve(null),
      getSessionHistory(session.activity, isCardio ? 2000 : 28).catch(() => [] as SessionHistoryRow[]),
      isRun && session.google_session_id != null
        ? getRunDetail(session.google_session_id).catch(() => null)
        : Promise.resolve(null),
    ]).then(([h, hist, rd]) => {
      if (!alive) return
      setHr(h)
      setHistory(hist)
      setRunDetail(rd)
      setLoading(false)
    })
    return () => { alive = false }
  }, [session.id, session.google_session_id, session.activity, isCardio, isRun])

  if (loading) {
    return (
      <div className="wo-panel" style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
        <span className="loading-spinner" /> Loading session…
      </div>
    )
  }

  return (
    <div className="wo-panel">
      {isRun && runDetail && (runDetail.route || runDetail.splits) && (
        <div style={{ display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' }}>
          {runDetail.route && runDetail.route.length > 1 && (
            <div style={{ flex: '1 1 300px', minWidth: '250px', maxWidth: '420px', height: '236px', borderRadius: '10px', border: '1px solid var(--border-subtle)', background: 'rgba(0,0,0,0.3)', overflow: 'hidden' }}>
              <RouteTrace route={runDetail.route} splits={runDetail.splits} />
            </div>
          )}
          {runDetail.splits && runDetail.splits.length > 0 && (
            <div style={{ flex: '2 1 320px', minWidth: '260px', height: '236px' }}>
              <SplitsChart splits={runDetail.splits} />
            </div>
          )}
        </div>
      )}
      {isRun && session.has_route === false && runDetail == null && (
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '10px' }}>
          Route not imported yet — it appears after the next sync (needs the location permission).
        </div>
      )}

      {hr && (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '9px' }}>
            <span className="wo-panel-kick">♥ Heart rate · this session</span>
            <span style={{ fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'baseline', gap: '13px', fontSize: '11px', color: 'var(--text-muted)' }}>
              <span>min <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>{hr.min_bpm ?? '—'}</span></span>
              <span>avg <span style={{ color: 'var(--accent-rose)', fontSize: '18px', fontWeight: 500 }}>{hr.avg_bpm ?? '—'}</span></span>
              <span>max <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>{hr.max_bpm ?? '—'}</span></span>
            </span>
          </div>
          <HrCurve hr={hr} />
        </>
      )}

      {history.length > 0 && (
        <>
          <div style={{ height: '1px', background: 'var(--border-subtle)', margin: '15px 0' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '11px' }}>
            <span className="wo-panel-kick">
              Recent {session.activity} · {history.length} session{history.length === 1 ? '' : 's'} · hover for detail
            </span>
            {metricOptions && (
              <span style={{ display: 'inline-flex', gap: '2px', padding: '2px', borderRadius: '7px', border: '1px solid var(--border-subtle)', background: 'rgba(0,0,0,0.25)', flexShrink: 0 }}>
                {metricOptions.map(m => (
                  <button key={m} onClick={() => setChosenMetric(m)}
                    style={{ padding: '2px 10px', fontSize: '0.64rem', fontFamily: 'var(--font-mono)', border: 'none', borderRadius: '5px', cursor: 'pointer', background: chosenMetric === m ? 'rgba(56,189,248,0.25)' : 'transparent', color: chosenMetric === m ? 'var(--text-primary)' : 'var(--text-muted)', transition: 'background 0.15s' }}>
                    {m}
                  </button>
                ))}
              </span>
            )}
          </div>
          <SessionProgression rows={history} currentDate={date} metric={metric} />
        </>
      )}

      {!hr && history.length === 0 && (
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>No Google session data for this activity yet.</div>
      )}
    </div>
  )
}
