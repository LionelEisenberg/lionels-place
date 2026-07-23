/**
 * Helm — daily summaries with toggleable Charts / Table views.
 */

import { useState, useEffect, useRef } from 'react'
import { LineChart, Line, BarChart, Bar, AreaChart, Area, PieChart, Pie, ComposedChart, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, ReferenceLine, ReferenceArea, Cell } from 'recharts'
import { listDaily, updateDaily, listPhotos, fetchPhotoBlob, listPhases, getWeightProjection, getHealthDaily, getHabitsConfig, DEFAULT_HABIT_META, type DailySummaryResponse, type PhaseResponse, type WeightProjectionResponse, type DailyHealthResponse, type HabitMeta } from '../api'
import { displayDate, todayISO } from '../dates'
import { getMoodEmoji, getHabitScore, getHabitClass } from '../utils/helm-helpers'
import { targetsForDate, macroLevel, type DailyTargets, type MacroKind } from '../utils/phase-helpers'
import { computeTrailingSMA, computeTrailingLoss, computeForecast60dValue, type WeightDay } from '../utils/weight-chart-helpers'
import { healthByDate, rhrColor, rollingAverage, sleepStageRows } from '../utils/vitals-helpers'
import { buildDeficitChart } from '../utils/deficit-helpers'

// Default daily targets when no phase is active (matches backend env defaults).
const ENV_DEFAULTS: DailyTargets = {
  calories: 1850, protein_g: 125, carbs_g: 250, fat_g: 50, fiber_g: 30,
  in_refeed: false, phase_type: null,
}

// Render a macro cell color-coded by how the actual value compares to the target.
// `kind`: 'cap' (calories/carbs/fat — under is good) or 'minimum' (protein/fiber — over is good).
// `extremeOverAbsolute`: optional escalation tier for caps (e.g. calories +1500).
function MacroCell({ value, target, kind, extremeOverAbsolute, className }: {
  value: number;
  target: number;
  kind: MacroKind;
  extremeOverAbsolute?: number;
  className?: string;
}) {
  if (!value) {
    const fullClass = ['macro-cell', className].filter(Boolean).join(' ')
    return <td className={fullClass}><span className="empty">—</span></td>
  }
  const cls = `macro-${macroLevel(value, target, { kind, extremeOverAbsolute })}`
  const fullClass = ['macro-cell', cls, className].filter(Boolean).join(' ')
  return <td className={fullClass}>{Math.round(value)}</td>
}

// ==========================================
// Chart shared constants
// ==========================================
const CHART_GRID = { strokeDasharray: '3 3', stroke: 'rgba(255,255,255,0.05)' }
const CHART_XAXIS = { fontSize: 11, fill: '#64748b' }
const CHART_YAXIS = { fontSize: 11, fill: '#64748b' }
const CHART_TOOLTIP = { background: '#1e293b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }

// Weight chart trend color: indigo for the forecast/overall regression line.
// Recharts can't parse CSS var() inside stroke, so use literal hex.
const OVERALL_TREND_STROKE = '#a78bfa'

// ----- Weight Trend chart: two orthogonal axes -----
// SmoothingMode controls how PAST weight is displayed (raw vs. trailing average).
// ForecastMode controls the FUTURE trendline: the backend regression over the
// selected window — overall (all history) / 30d / 60d — or none. They were a
// single toggle ("overall/7d/14d") that silently bundled smoothing + forecast
// together; users couldn't pick one of each. Now they're independent and the
// chart's "Days to Goal" stat is always honest about which line drives it.
type SmoothingMode = '1d' | '7d' | '14d'
type ForecastMode = 'overall' | '60d' | '30d' | 'off'

const SMOOTHING_META: Record<SmoothingMode, { label: string; window: 7 | 14 | null }> = {
  '1d':  { label: '1d',  window: null },
  '7d':  { label: '7d',  window: 7    },
  '14d': { label: '14d', window: 14   },
}

// `windowDays` is the trailing-window length passed to the backend regression
// (`window_days` query param). `overall` = 0 = all logged history; `off` has no
// backend window so it's null.
const FORECAST_META: Record<ForecastMode, { label: string; lineName: string; windowDays: number | null }> = {
  overall: { label: 'Overall', lineName: 'Overall Trend', windowDays: 0    },
  '60d':   { label: '60d',     lineName: '60d Forecast',  windowDays: 60   },
  '30d':   { label: '30d',     lineName: '30d Forecast',  windowDays: 30   },
  off:     { label: 'Off',     lineName: '',              windowDays: null },
}

// Migrate the old single-toggle localStorage key (used until v0 of this chart)
// into the two-axis defaults. Returns [smoothing, forecast].
function migrateLegacyTrendMode(): [SmoothingMode, ForecastMode] {
  const legacy = localStorage.getItem('helm.weightChart.trendMode')
  if (legacy === '7d')      return ['7d',  'off']
  if (legacy === '14d')     return ['14d', 'off']
  if (legacy === 'overall') return ['1d',  'overall']
  // No legacy key, or unrecognised: default to "raw + 60d forecast" so the
  // chart's trendline matches the "Days to Goal" stat out of the box.
  return ['1d', '60d']
}

// Small reusable pill-group toggle. Used by the Weight Trend chart's
// Smoothing + Forecast axes. Generic over the mode value type so each instance
// is type-safe with its own enum.
function PillGroup<M extends string>(props: {
  ariaLabel: string
  prefixLabel: string
  modes: readonly M[]
  active: M
  onSelect: (m: M) => void
  labelFor?: (m: M) => string
  style?: React.CSSProperties
}) {
  const { ariaLabel, prefixLabel, modes, active, onSelect, labelFor, style } = props
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', ...(style || {}) }}>
      <span style={{
        fontSize: '0.7rem',
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        fontWeight: 600,
      }}>
        {prefixLabel}
      </span>
      <div
        role="group"
        aria-label={ariaLabel}
        style={{
          display: 'flex',
          gap: '2px',
          alignItems: 'center',
          padding: '2px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 6,
        }}
      >
        {modes.map((mode) => {
          const isActive = active === mode
          return (
            <button
              key={mode}
              type="button"
              onClick={() => onSelect(mode)}
              aria-pressed={isActive}
              style={{
                padding: '4px 10px',
                fontSize: '0.72rem',
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                background: isActive ? 'rgba(167, 139, 250, 0.15)' : 'transparent',
                color: isActive ? '#a78bfa' : 'var(--text-muted)',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                transition: 'background 0.15s, color 0.15s',
              }}
            >
              {labelFor ? labelFor(mode) : mode}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ==========================================
// Main Component
// ==========================================
export default function Helm() {
  const [daily, setDaily] = useState<DailySummaryResponse[]>([])
  const [health, setHealth] = useState<DailyHealthResponse[]>([])
  const [phases, setPhases] = useState<PhaseResponse[]>([])
  // One projection per supported backend window. Keyed by window-days so we
  // can extend this (e.g. 90d) by adding to FORECAST_META alone — no new state.
  const [projections, setProjections] = useState<Record<number, WeightProjectionResponse | null>>({})
  const [hoveredSeries, setHoveredSeries] = useState<'forecast' | null>(null)
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<'charts' | 'table'>('table')
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [photoDates, setPhotoDates] = useState<Set<string>>(new Set())
  const [modalPhotoDate, setModalPhotoDate] = useState<string | null>(null)
  const [modalPhotoSrc, setModalPhotoSrc] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({
    weight_lbs: '', bf_pct: '', workout_type: '', est_active_burn: '', notes: '',
    drinks_consumed: '', habit_qty: '', caffeine_mg: '', sleep_hours: '', mood: ''
  })
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ body: false, vitals: false, nutrition: false, energy: true, substances: false, wellness: false })
  const [weightUnit, setWeightUnit] = useState<'lbs' | 'kg'>('lbs')
  const [smoothingMode, setSmoothingMode] = useState<SmoothingMode>(() => {
    const stored = localStorage.getItem('helm.weightChart.smoothing')
    if (stored === '1d' || stored === '7d' || stored === '14d') return stored
    // Fall back to legacy single-toggle key on first load after upgrade.
    return migrateLegacyTrendMode()[0]
  })
  const [forecastMode, setForecastMode] = useState<ForecastMode>(() => {
    const stored = localStorage.getItem('helm.weightChart.forecast')
    if (stored === 'overall' || stored === '60d' || stored === 'off') return stored
    return migrateLegacyTrendMode()[1]
  })

  useEffect(() => { localStorage.setItem('helm.weightChart.smoothing', smoothingMode) }, [smoothingMode])
  useEffect(() => { localStorage.setItem('helm.weightChart.forecast',  forecastMode)  }, [forecastMode])

  const toDisplayWeight = (lbs: number) => weightUnit === 'kg' ? Math.round(lbs * 0.453592 * 10) / 10 : lbs
  const toggle = (g: string) => setCollapsed(prev => ({ ...prev, [g]: !prev[g] }))
  const [habitTooltip, setHabitTooltip] = useState<{ date: string; habits: string[]; count: number; x: number; y: number } | null>(null)
  const [habitFilter, setHabitFilter] = useState<string | null>(null)
  const heatmapRef = useRef<HTMLDivElement>(null)
  const [habitMeta, setHabitMeta] = useState<HabitMeta>(DEFAULT_HABIT_META)

  useEffect(() => {
    getHabitsConfig().then(({ meta }) => setHabitMeta(meta)).catch(() => { /* keep default meta */ })
  }, [])

  const startEdit = (d: DailySummaryResponse) => {
    setEditingId(d.id)
    setEditForm({
      weight_lbs: d.weight_lbs?.toString() || '',
      bf_pct: d.bf_pct?.toString() || '',
      workout_type: d.workout_type || '',
      est_active_burn: d.est_active_burn ? d.est_active_burn.toString() : '',
      drinks_consumed: d.drinks_consumed ? d.drinks_consumed.toString() : '',
      habit_qty: d.habit_qty ? d.habit_qty.toString() : '',
      caffeine_mg: d.caffeine_mg ? d.caffeine_mg.toString() : '',
      sleep_hours: d.sleep_hours ? d.sleep_hours.toString() : '',
      mood: d.mood || '',
      notes: d.notes || ''
    })
  }

  const saveEdit = async (d: DailySummaryResponse) => {
    setLoading(true)
    try {
      const updated = await updateDaily(d.date, {
        weight_lbs: editForm.weight_lbs ? parseFloat(editForm.weight_lbs) : null,
        bf_pct: editForm.bf_pct ? parseFloat(editForm.bf_pct) : null,
        workout_type: (editForm.workout_type as 'Push' | 'Pull' | 'Legs' | 'Cardio' | 'Mixed') || null,
        est_active_burn: editForm.est_active_burn ? parseFloat(editForm.est_active_burn) : 0,
        drinks_consumed: editForm.drinks_consumed ? parseFloat(editForm.drinks_consumed) : 0,
        habit_qty: editForm.habit_qty ? parseFloat(editForm.habit_qty) : null,
        caffeine_mg: editForm.caffeine_mg ? parseFloat(editForm.caffeine_mg) : null,
        sleep_hours: editForm.sleep_hours ? parseFloat(editForm.sleep_hours) : null,
        mood: editForm.mood || null,
        notes: editForm.notes || ""
      })
      setDaily(prev => prev.map(item => item.id === d.id ? updated : item))
      setEditingId(null)
    } catch (err) {
      alert("Failed to update daily record")
    }
    setLoading(false)
  }

  useEffect(() => {
    (async () => {
      try {
        const [data, phaseData, photoData, healthData] = await Promise.all([
          listDaily(undefined, undefined, 1000),
          listPhases(),
          listPhotos(),
          getHealthDaily('0000-01-01', '9999-12-31').catch(() => []),
        ])
        setDaily(data)
        setPhases(phaseData)
        setPhotoDates(new Set(photoData.map(p => p.date)))
        setHealth(healthData)

        // Fetch projection for the current open-ended cut phase with a target weight set.
        const todayStr = todayISO()
        const activeCut = phaseData.find(
          p => p.phase_type === 'cut'
            && (p.end_date === null || p.end_date >= todayStr)
            && p.target_weight_lbs != null,
        )
        if (activeCut) {
          // Fetch every backend-windowed projection that the Forecast pill
          // group can select. Keep the set derived from FORECAST_META so adding
          // a future window (e.g. 90d) only requires touching that one map.
          const windowsToFetch = Array.from(new Set(
            Object.values(FORECAST_META)
              .map(m => m.windowDays)
              .filter((w): w is number => w != null),
          ))
          try {
            const results = await Promise.all(
              windowsToFetch.map(w =>
                getWeightProjection(activeCut.id, w).then(p => [w, p] as const),
              ),
            )
            setProjections(Object.fromEntries(results))
          } catch (err) {
            console.error('Failed to load weight projection(s):', err)
          }
        }
      } catch (err) {
        console.error('Failed to load daily data:', err)
      }
      setLoading(false)
    })()
  }, [])

  // Load photo blob when modal is opened
  useEffect(() => {
    if (!modalPhotoDate) { setModalPhotoSrc(null); return }
    let cancelled = false
    fetchPhotoBlob(modalPhotoDate)
      .then(src => { if (!cancelled) setModalPhotoSrc(src) })
      .catch(() => { if (!cancelled) setModalPhotoSrc(null) })
    return () => { cancelled = true }
  }, [modalPhotoDate])

  // --- Color Helpers ---
  const getDrinkColor = (d: number | null | undefined) => {
    if (d === null || d === undefined) return 'var(--text-muted)'
    if (d === 0) return 'var(--accent-emerald)'
    if (d <= 2) return 'var(--accent-amber)'
    return 'var(--accent-rose)'
  }
  const getHabitColor = (w: number | null | undefined) => {
    if (w === null || w === undefined) return 'var(--text-muted)'
    if (w <= 0.5) return 'var(--accent-emerald)'
    if (w <= 1) return 'var(--accent-amber)'
    return 'var(--accent-rose)'
  }
  const getCaffeineColor = (c: number | null | undefined) => {
    if (c === null || c === undefined) return 'var(--text-muted)'
    if (c <= 160) return 'var(--accent-emerald)'
    if (c <= 240) return 'var(--accent-amber)'
    return 'var(--accent-rose)'
  }

  // ==========================================
  // Data Transformations for Charts
  // ==========================================

  const sortedDays = [...daily].sort((a, b) => a.date.localeCompare(b.date))
  const healthMap = healthByDate(health)
  const weightDays = sortedDays.filter(d => d.weight_lbs && d.weight_lbs > 0)

  // --- Weight Trend Chart Data ---
  let chartData: any[] = []
  let slopeLabel = ''

  // Current cut phase (open-ended): drives the cut band + goal line on the weight chart.
  const _todayStrForCut = todayISO()
  const currentCutPhase = phases.find(
    p => p.phase_type === 'cut' && (p.end_date === null || p.end_date >= _todayStrForCut),
  ) ?? null

  // The active projection follows the selected forecast window. Stats and the
  // chart's forecast line read from the same source so they can never disagree.
  const forecastWindow = FORECAST_META[forecastMode].windowDays
  const activeProjection: WeightProjectionResponse | null =
    (forecastWindow != null ? projections[forecastWindow] : null) ?? null
  // For chart extent + the goal-line we still want SOME projection even when
  // forecast is "off" (no active window); fall back to 60d so the chart still
  // extends to the goal-line marker.
  const extentProjection: WeightProjectionResponse | null =
    activeProjection ?? projections[60] ?? null

  if (weightDays.length > 0) {
    const firstDate = new Date(weightDays[0].date)
    const lastDataDate = new Date(sortedDays[sortedDays.length - 1]?.date || weightDays[weightDays.length - 1].date)
    const todayStr = todayISO()
    const todayDate = new Date(todayStr)

    // Prefer a projection's projected_date if it's in the future — that way the
    // chart extends out to the goal. Else fall back to 28 days past last/today.
    let endDate: Date
    if (extentProjection?.projected_date) {
      const proj = new Date(extentProjection.projected_date)
      endDate = proj > todayDate ? proj : new Date(lastDataDate > todayDate ? lastDataDate : todayDate)
      if (endDate <= todayDate) endDate.setDate(endDate.getDate() + 28)
    } else {
      endDate = new Date(lastDataDate > todayDate ? lastDataDate : todayDate)
      endDate.setDate(endDate.getDate() + 28)
    }

    // Header slope label reflects the *forecast* line — it answers "at what rate
    // does the line projecting to my goal descend?". All forecast windows
    // (overall / 30d / 60d) read pace from the backend projection.
    if (activeProjection?.pace_per_week != null) {
      const slopePerDay = activeProjection.pace_per_week / 7
      slopeLabel = `${slopePerDay > 0 ? '+' : ''}${slopePerDay.toFixed(3)} lb/day`
    } else {
      slopeLabel = ''
    }

    const dailyMap = new Map(sortedDays.map(d => [d.date, d]))
    const latestWeighInDate = weightDays.length > 0 ? weightDays[weightDays.length - 1].date : null
    const weightDaysForSMA: WeightDay[] = weightDays.map(d => ({ date: d.date, weight_lbs: d.weight_lbs }))
    const smoothingWindow = SMOOTHING_META[smoothingMode].window
    const curr = new Date(firstDate)
    while (curr <= endDate) {
      const dStr = curr.toISOString().split('T')[0]
      const dData = dailyMap.get(dStr)
      // Treat 0 (or negative) as "no weigh-in" — matches the `weightDays`
      // filter above and the original chart behaviour. Some historical rows
      // stored weight_lbs = 0 instead of NULL; this makes the chart resilient.
      const rawWeight = (dData?.weight_lbs && dData.weight_lbs > 0) ? dData.weight_lbs : null

      // `weight` = the primary weight line, smoothing-aware.
      //   1d  → raw daily weigh-ins (with null gaps)
      //   7d  → 7-day trailing SMA (only past last weigh-in date)
      //   14d → 14-day trailing SMA
      // `weight_raw` = the underlying raw weigh-ins, kept around as faint dots
      // when smoothing is on so users don't lose visibility of the data.
      let smoothedWeight: number | null = null
      if (smoothingWindow != null && latestWeighInDate && dStr <= latestWeighInDate) {
        const sma = computeTrailingSMA(weightDaysForSMA, dStr, smoothingWindow)
        smoothedWeight = sma != null ? parseFloat(sma.toFixed(1)) : null
      }

      const row: Record<string, any> = {
        date: dStr.slice(5),
        fullDate: dStr,
        ts: new Date(dStr + 'T00:00:00Z').getTime(),
        weight: smoothingWindow == null ? rawWeight : smoothedWeight,
        weight_raw: rawWeight,
        calories: dData?.calories_in || 0,
        deficit: dData?.net_deficit || 0,
      }

      // Forecast line value — populated for every chart row so the line can
      // extend past today out to projected_date. Every forecast window (overall
      // / 30d / 60d) reconstructs the line from the backend projection, so it
      // always matches the "Days to Goal" stat. The regression window is baked
      // into `activeProjection`.
      if (activeProjection) {
        const val = computeForecast60dValue(activeProjection, dStr)
        row.forecast = val != null ? parseFloat(val.toFixed(1)) : null
      } else {
        row.forecast = null
      }

      // Trailing-loss fields for the tooltip's "Δ vs N days ago" line.
      // Precomputed here (not on every hover frame). Loss only makes sense when
      // smoothing is on — it's the change in the smoothed series.
      if (smoothingWindow != null && latestWeighInDate && dStr <= latestWeighInDate) {
        const loss = computeTrailingLoss(weightDaysForSMA, dStr, smoothingWindow)
        row.smoothing_loss = loss
      } else {
        row.smoothing_loss = null
      }
      chartData.push(row)
      curr.setDate(curr.getDate() + 1)
    }
  }

  // The projection that drives the stat tile: the active backend projection for
  // the selected window (overall = all-history, 30d, 60d), so the tile always
  // matches the forecast line. Null when forecast='off' (no window) so
  // projection-related tiles hide.
  const displayProjection: WeightProjectionResponse | null = activeProjection

  const macroChartData = sortedDays
    .filter(d => d.calories_in > 0)
    .map(d => ({
      date: d.date.slice(5),
      protein: Math.round(d.protein_g),
      carbs: Math.round(d.carbs_g - d.fiber_g),
      fat: Math.round(d.fat_g),
      fiber: Math.round(d.fiber_g),
    }))

  const linearCalorieData = chartData.filter(p => new Date(p.fullDate) <= new Date())

  // Calorie chart data enriched with the per-day target (stepped by phase).
  const calChartDataWithTarget = linearCalorieData.map(d => {
    const t = targetsForDate(phases, d.fullDate, ENV_DEFAULTS)
    return { ...d, target: t.calories }
  })

  // Phase bands: shaded ReferenceAreas behind cut/bulk/maintenance windows.
  // XAxis uses MM-DD format (slice(5)) on most charts, so band x1/x2 must match that format.
  const _todayISO = todayISO()
  const phaseBands = phases
    .filter(p => p.start_date)
    .map(p => ({
      id: p.id,
      type: p.phase_type,
      start: p.start_date.slice(5),
      end: (p.end_date ?? _todayISO).slice(5),
    }))

  // Weight chart variant: uses numeric timestamps so ReferenceArea x1/x2 are
  // unambiguous numeric coordinates on the numeric XAxis. UTC midnight is used
  // so timestamps line up exactly with the `ts` field on chartData rows.
  const toTs = (iso: string) => new Date(iso + 'T00:00:00Z').getTime()
  const weightPhaseBands = phases
    .filter(p => p.start_date)
    .map(p => ({
      id: p.id,
      type: p.phase_type,
      start: toTs(p.start_date),
      end: toTs(p.end_date ?? _todayISO),
    }))

  // Weekly tick marks for the weight chart's numeric XAxis — anchored to the
  // first chartData ts and stepping every 7 days through the projected end.
  // Produces uniform, predictable axis labels (vs Recharts' auto-spacing).
  const weeklyTicks: number[] = (() => {
    if (chartData.length === 0) return []
    const start = chartData[0].ts as number
    const end = chartData[chartData.length - 1].ts as number
    const step = 7 * 86_400_000
    const ticks: number[] = []
    for (let t = start; t <= end; t += step) ticks.push(t)
    if (ticks[ticks.length - 1] !== end) ticks.push(end)
    return ticks
  })()

  // --- Body Fat Trend ---
  const bfData = sortedDays
    .filter(d => d.bf_pct !== null && d.bf_pct !== undefined && d.bf_pct > 0)
    .map(d => ({ date: d.date.slice(5), bf_pct: d.bf_pct! }))

  // --- Vitals Charts (Google Health) ---
  const healthSorted = [...health].sort((a, b) => a.date.localeCompare(b.date))
  const stepsData = healthSorted.filter(h => h.steps != null).map(h => ({ date: h.date.slice(5), steps: h.steps as number }))
  const rhrSeries = healthSorted.map(h => h.resting_hr)
  const rhrData = healthSorted.map((h, i) => ({ date: h.date.slice(5), rhr: h.resting_hr, rhrAvg: rollingAverage(rhrSeries, 7)[i] }))
  const hrvSeries = healthSorted.map(h => h.hrv_ms)
  const hrvData = healthSorted.map((h, i) => ({ date: h.date.slice(5), hrv: h.hrv_ms, hrvAvg: rollingAverage(hrvSeries, 7)[i] }))
  const respData = healthSorted.filter(h => h.respiratory_rate != null).map(h => ({ date: h.date.slice(5), resp: h.respiratory_rate as number }))
  const stageData = sleepStageRows(healthSorted.filter(h => h.sleep_deep_min != null))

  // --- Monthly Macro Averages ---
  const availableMonths = [...new Set(sortedDays.filter(d => d.calories_in > 0).map(d => d.date.slice(0, 7)))].sort()
  const monthDays = sortedDays.filter(d => d.date.startsWith(selectedMonth) && d.calories_in > 0)
  // Sleep + mood live on the day record but aren't tied to whether the user
  // tracked food, so use the full-month slice (not just calorie-tracked days).
  const monthAllForMetrics = sortedDays.filter(d => d.date.startsWith(selectedMonth))
  const sleepDays = monthAllForMetrics.filter(d => d.sleep_hours != null && (d.sleep_hours as number) > 0)
  // Mood is stored as a string starting with a digit 1-5 (e.g. "4 - good").
  // Average the leading digit; render as the emoji for the rounded mean.
  const moodValues = monthAllForMetrics
    .map(d => d.mood ? parseInt(d.mood.charAt(0), 10) : NaN)
    .filter(n => Number.isFinite(n) && n >= 1 && n <= 5)
  const monthAvg = monthDays.length > 0 ? {
    calories: Math.round(monthDays.reduce((s, d) => s + d.calories_in, 0) / monthDays.length),
    protein: Math.round(monthDays.reduce((s, d) => s + d.protein_g, 0) / monthDays.length),
    carbs: Math.round(monthDays.reduce((s, d) => s + (d.carbs_g - d.fiber_g), 0) / monthDays.length),
    fat: Math.round(monthDays.reduce((s, d) => s + d.fat_g, 0) / monthDays.length),
    fiber: Math.round(monthDays.reduce((s, d) => s + d.fiber_g, 0) / monthDays.length),
    days: monthDays.length,
    sleep: sleepDays.length > 0
      ? +(sleepDays.reduce((s, d) => s + (d.sleep_hours as number), 0) / sleepDays.length).toFixed(1)
      : null,
    sleepDays: sleepDays.length,
    mood: moodValues.length > 0
      ? +(moodValues.reduce((a, b) => a + b, 0) / moodValues.length).toFixed(1)
      : null,
    moodDays: moodValues.length,
  } : null
  const macroPieData = monthAvg ? [
    { name: 'Protein', value: monthAvg.protein, color: '#6366f1' },
    { name: 'Net Carbs', value: monthAvg.carbs, color: '#38bdf8' },
    { name: 'Fat', value: monthAvg.fat, color: '#f43f5e' },
    { name: 'Fiber', value: monthAvg.fiber, color: '#10b981' },
  ] : []

  // --- Monthly Workout Averages ---
  const monthAllDays = sortedDays.filter(d => d.date.startsWith(selectedMonth))
  const monthWorkoutDays = monthAllDays.filter(d => d.workout_type)
  const monthWorkoutAvg = monthAllDays.length > 0 ? (() => {
    const totalBurn = monthWorkoutDays.reduce((s, d) => s + d.est_active_burn, 0)
    const typeCounts: Record<string, number> = {}
    monthWorkoutDays.forEach(d => {
      const t = d.workout_type || 'Other'
      typeCounts[t] = (typeCounts[t] || 0) + 1
    })
    const typeColors: Record<string, string> = { Push: '#6366f1', Pull: '#38bdf8', Legs: '#f59e0b', Cardio: '#f43f5e', Mixed: '#8b5cf6', Other: '#64748b' }
    const typePieData = Object.entries(typeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({ name, value, color: typeColors[name] || '#8b5cf6' }))
    return {
      workoutDays: monthWorkoutDays.length,
      totalDays: monthAllDays.length,
      totalBurn,
      avgBurnPerWorkout: monthWorkoutDays.length > 0 ? Math.round(totalBurn / monthWorkoutDays.length) : 0,
      avgBurnPerDay: Math.round(totalBurn / monthAllDays.length),
      frequency: Math.round(monthWorkoutDays.length / monthAllDays.length * 100),
      typePieData,
    }
  })() : null

  // --- Cumulative Deficit ---
  // Tracked (running Σ net_deficit), Scale-trend (weight regression × 3500) and
  // Scale-actual (raw weight change × 3500) series + headline stats.
  const { data: cumulativeDeficitData, stats: cumDefStats } = buildDeficitChart(sortedDays)

  // --- Mood Chart ---
  const moodLogged = sortedDays
    .filter(d => d.mood)
    .map(d => ({ date: d.date.slice(5), mood: parseInt(d.mood!.charAt(0)) || null }))
    .filter(d => d.mood !== null)
  const moodData = sortedDays
    .filter(d => d.calories_in > 0 || d.mood)
    .map(d => ({ date: d.date.slice(5), mood: d.mood ? (parseInt(d.mood.charAt(0)) || null) : null }))

  // --- Habit (custom quantity) Chart ---
  const habitLogged = sortedDays.filter(d => d.habit_qty !== null && d.habit_qty !== undefined)
  const habitChartData = sortedDays
    .filter(d => d.calories_in > 0 || (d.habit_qty !== null && d.habit_qty !== undefined))
    .map(d => ({ date: d.date.slice(5), habit_qty: d.habit_qty ?? 0 }))

  // --- Caffeine Chart ---
  const caffeineLogged = sortedDays.filter(d => d.caffeine_mg !== null && d.caffeine_mg !== undefined)
  const caffeineData = sortedDays
    .filter(d => d.calories_in > 0 || (d.caffeine_mg !== null && d.caffeine_mg !== undefined))
    .map(d => ({ date: d.date.slice(5), caffeine_mg: d.caffeine_mg ?? 0 }))

  // --- Drinks Chart ---
  // Include all days so the x-axis is continuous; unlogged days show as 0
  const drinksLogged = sortedDays.filter(d => d.drinks_consumed !== null && d.drinks_consumed !== undefined)
  const drinksData = sortedDays
    .filter(d => d.calories_in > 0 || (d.drinks_consumed !== null && d.drinks_consumed !== undefined))
    .map(d => ({ date: d.date.slice(5), drinks: d.drinks_consumed ?? 0 }))

  // --- Sleep Chart ---
  const sleepLogged = sortedDays.filter(d => d.sleep_hours != null)
  const sleepData = sortedDays
    .filter(d => d.calories_in > 0 || d.sleep_hours != null)
    .map(d => {
      // Convert bedtime/waketime strings to decimal hours for chart overlay
      // Use inverted scale: times mapped to 20-36 range (20:00 = 20, 00:00 = 24, 06:30 = 30.5)
      let bedDecimal: number | null = null
      let wakeDecimal: number | null = null
      if (d.sleep_bedtime) {
        const [h, m] = d.sleep_bedtime.split(':').map(Number)
        bedDecimal = h < 20 ? h + 24 : h  // e.g. 01:00 → 25, 23:00 → 23
        bedDecimal += (m || 0) / 60
      }
      if (d.sleep_waketime) {
        const [h, m] = d.sleep_waketime.split(':').map(Number)
        wakeDecimal = h < 20 ? h + 24 : h
        wakeDecimal += (m || 0) / 60
      }
      return { date: d.date.slice(5), sleep_hours: d.sleep_hours ?? 0, bedtime: bedDecimal, waketime: wakeDecimal }
    })

  // --- TDEE History Chart Data (reads stored values) ---
  const tdeeChartData = sortedDays
    .filter(d => d.date <= todayISO())
    .filter(d => d.calories_in > 0 || d.formula_tdee !== null)
    .map(d => ({
      date: d.date.slice(5),
      calories: d.calories_in > 0 ? Math.round(d.calories_in) : null,
      formula_tdee: d.formula_tdee ? Math.round(d.formula_tdee) : null,
      cico_tdee: d.cico_tdee ? Math.round(d.cico_tdee) : null,
    }))

  // --- Chart Stats ---
  const linearRegression = (pts: { x: number; y: number }[]) => {
    const n = pts.length
    if (n < 2) return { slope: 0, intercept: 0 }
    const sx = pts.reduce((a, p) => a + p.x, 0)
    const sy = pts.reduce((a, p) => a + p.y, 0)
    const sxy = pts.reduce((a, p) => a + p.x * p.y, 0)
    const sx2 = pts.reduce((a, p) => a + p.x * p.x, 0)
    const denom = n * sx2 - sx * sx
    if (denom === 0) return { slope: 0, intercept: sy / n }
    const slope = (n * sxy - sx * sy) / denom
    const intercept = (sy - slope * sx) / n
    return { slope, intercept }
  }

  // Body Fat stats
  const bfDays = sortedDays.filter(d => d.bf_pct != null && d.bf_pct > 0)
  const bfStats = bfDays.length > 0 ? (() => {
    const current = bfDays[bfDays.length - 1].bf_pct!
    const avg = parseFloat((bfDays.reduce((s, d) => s + d.bf_pct!, 0) / bfDays.length).toFixed(1))
    let trendPerWeek: number | null = null
    if (bfDays.length >= 2) {
      const t0 = new Date(bfDays[0].date).getTime()
      const pts = bfDays.map(d => ({ x: (new Date(d.date).getTime() - t0) / 86400000, y: d.bf_pct! }))
      trendPerWeek = parseFloat((linearRegression(pts).slope * 7).toFixed(2))
    }
    return { current, avg, trendPerWeek }
  })() : null

  // Calories & Deficit stats
  const calDays = sortedDays.filter(d => d.calories_in > 0)
  const calStats = calDays.length > 0 ? (() => {
    const avgCal = Math.round(calDays.reduce((s, d) => s + d.calories_in, 0) / calDays.length)
    const deficitDays = calDays.filter(d => d.sedentary_tdee > 0)
    const avgDeficit = deficitDays.length > 0
      ? Math.round(deficitDays.reduce((s, d) => s + (d.sedentary_tdee - d.calories_in), 0) / deficitDays.length)
      : null
    return { avgCal, avgDeficit }
  })() : null

  // Mood stats (only count days with explicit mood logged)
  const moodStats = moodLogged.length > 0 ? (() => {
    const values = moodLogged.map(d => d.mood!).filter((v): v is number => v !== null)
    const avg = parseFloat((values.reduce((s, v) => s + v, 0) / values.length).toFixed(1))
    let streak = 0
    for (let i = values.length - 1; i >= 0; i--) {
      if (values[i] >= 4) streak++
      else break
    }
    return { avg, streak }
  })() : null

  // Habit-quantity stats (only count days with an explicit amount logged)
  const habitStats = habitLogged.length > 0 ? (() => {
    const avg = parseFloat((habitLogged.reduce((s, d) => s + d.habit_qty!, 0) / habitLogged.length).toFixed(2))
    const underPct = Math.round((habitLogged.filter(d => d.habit_qty! <= 0.5).length / habitLogged.length) * 100)
    return { avg, underPct }
  })() : null

  // Caffeine stats (only count days with explicit caffeine logged)
  const caffeineStats = caffeineLogged.length > 0 ? (() => {
    const avg = Math.round(caffeineLogged.reduce((s, d) => s + d.caffeine_mg!, 0) / caffeineLogged.length)
    const underPct = Math.round((caffeineLogged.filter(d => d.caffeine_mg! <= 240).length / caffeineLogged.length) * 100)
    return { avg, underPct }
  })() : null

  // Drinks stats (only count days where drinks were explicitly logged)
  const drinksStats = drinksLogged.length > 0 ? (() => {
    const avg = parseFloat((drinksLogged.reduce((s, d) => s + d.drinks_consumed!, 0) / drinksLogged.length).toFixed(1))
    const dryPct = Math.round((drinksLogged.filter(d => d.drinks_consumed === 0).length / drinksLogged.length) * 100)
    return { avg, dryPct }
  })() : null

  // Sleep stats (only count days with explicit sleep logged)
  const sleepStats = sleepLogged.length > 0 ? (() => {
    const avg = parseFloat((sleepLogged.reduce((s, d) => s + d.sleep_hours!, 0) / sleepLogged.length).toFixed(1))
    const metTargetPct = Math.round((sleepLogged.filter(d => d.sleep_hours! >= 7.5).length / sleepLogged.length) * 100)
    return { avg, metTargetPct }
  })() : null

  // --- Habit Heatmap Data ---
  const HABIT_START = '2026-02-02'
  const HABIT_LABELS = [
    { key: 'habit_workout' as const, label: 'Workout 🏋️' },
    { key: 'habit_clean' as const, label: 'Clean 🧹' },
    { key: 'habit_productivity' as const, label: 'Productive 🚀' },
    { key: 'habit_sleep' as const, label: 'Sleep 😴' },
    { key: 'habit_love' as const, label: 'Love ❤️' },
    { key: 'habit_custom' as const, label: `${habitMeta.label} ${habitMeta.emoji}` },
  ]
  const habitDetailMap = new Map<string, { count: number; habits: string[]; keys: string[] }>()
  sortedDays.forEach(d => {
    const completed = HABIT_LABELS.filter(h => d[h.key])
    habitDetailMap.set(d.date, { count: completed.length, habits: completed.map(h => h.label), keys: completed.map(h => h.key) })
  })

  type HeatmapCell = { date: string; count: number; dayOfWeek: number; habits: string[]; keys: string[] }
  const habitHeatmapCells = (() => {
    const startDate = new Date(HABIT_START + 'T00:00:00')
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    // Pad back to the Sunday before start
    const firstSunday = new Date(startDate)
    firstSunday.setDate(firstSunday.getDate() - firstSunday.getDay())
    const weeks: HeatmapCell[][] = []
    let currentWeek: HeatmapCell[] = []
    const cur = new Date(firstSunday)
    while (cur <= today) {
      const iso = cur.toISOString().split('T')[0]
      const isPadding = cur < startDate
      const detail = habitDetailMap.get(iso)
      currentWeek.push({
        date: isPadding ? '' : iso,
        count: isPadding ? -1 : (detail?.count || 0),
        dayOfWeek: cur.getDay(),
        habits: isPadding ? [] : (detail?.habits || []),
        keys: isPadding ? [] : (detail?.keys || []),
      })
      if (cur.getDay() === 6) {
        weeks.push(currentWeek)
        currentWeek = []
      }
      cur.setDate(cur.getDate() + 1)
    }
    if (currentWeek.length > 0) {
      while (currentWeek.length < 7) {
        currentWeek.push({ date: '', count: -1, dayOfWeek: currentWeek.length, habits: [], keys: [] })
      }
      weeks.push(currentWeek)
    }
    return weeks
  })()

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const habitMonthLabels = habitHeatmapCells.map((week, wi) => {
    const firstReal = week.find(c => c.date !== '')
    if (!firstReal) return null
    if (wi === 0) return MONTH_NAMES[parseInt(firstReal.date.slice(5, 7)) - 1]
    const prevReal = habitHeatmapCells[wi - 1].find(c => c.date !== '')
    if (!prevReal || prevReal.date.slice(0, 7) !== firstReal.date.slice(0, 7)) {
      return MONTH_NAMES[parseInt(firstReal.date.slice(5, 7)) - 1]
    }
    return null
  })

  const habitColor = (count: number) => {
    if (count <= 0) return 'rgba(255,255,255,0.03)'
    if (count === 1) return 'rgba(99,102,241,0.15)'
    if (count === 2) return 'rgba(99,102,241,0.25)'
    if (count === 3) return 'rgba(99,102,241,0.4)'
    if (count === 4) return 'rgba(99,102,241,0.55)'
    if (count === 5) return 'rgba(99,102,241,0.7)'
    return 'rgba(99,102,241,0.9)'
  }

  // ==========================================
  // Render
  // ==========================================
  return (
    <>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-md)' }}>
        <h1>📊 Daily Summary</h1>
        <div className="view-toggle">
          <button className={viewMode === 'charts' ? 'active' : ''} onClick={() => setViewMode('charts')}>Charts</button>
          <button className={viewMode === 'table' ? 'active' : ''} onClick={() => setViewMode('table')}>Table</button>
        </div>
      </div>

      {loading && (
        <div className="loading-overlay"><span className="loading-spinner" /> Loading...</div>
      )}

      {/* ==========================================
          CHARTS VIEW
          ========================================== */}
      {!loading && viewMode === 'charts' && (
        <>
          {/* ---------- BODY ---------- */}
          <div className="chart-group">
            <h3 className="chart-group-title">Body</h3>

            {/* Weight Trend */}
            {chartData.length > 1 && (() => {
              const currentWeight = weightDays.length > 0 ? weightDays[weightDays.length - 1].weight_lbs : null
              let weeklyChange: number | null = null
              if (weightDays.length >= 2) {
                const latestDate = new Date(weightDays[weightDays.length - 1].date)
                const cutoff = new Date(latestDate)
                cutoff.setDate(cutoff.getDate() - 7)
                let baseEntry = weightDays[0]
                for (let i = weightDays.length - 2; i >= 0; i--) {
                  if (new Date(weightDays[i].date) <= cutoff) { baseEntry = weightDays[i]; break }
                }
                const daysDiff = (latestDate.getTime() - new Date(baseEntry.date).getTime()) / 86400000
                if (daysDiff > 0 && daysDiff <= 14) {
                  weeklyChange = parseFloat(((weightDays[weightDays.length - 1].weight_lbs! - baseEntry.weight_lbs!) * (7 / daysDiff)).toFixed(1))
                }
              }
              // Decide chip color for "This Week": for cuts, negative is good; for bulks, positive is good.
              const isBulk = currentCutPhase === null && phases.some(p => p.phase_type === 'bulk' && (p.end_date === null || p.end_date >= todayISO()))
              const weeklyClass = weeklyChange === null
                ? ''
                : isBulk
                  ? (weeklyChange >= 0 ? 'success' : 'danger')
                  : (weeklyChange <= 0 ? 'success' : 'danger')

              const goalLbs = currentCutPhase?.target_weight_lbs ?? null
              // Stats follow the active forecast — by construction they always
              // agree with the line being drawn. Null when forecast='off'.
              const proj = displayProjection

              return (
                <div className="card chart-container weight-chart-card" style={{ marginBottom: 'var(--space-xl)' }}>
                  {/* Hover-rate pill — anchors to the card's top-right when the forecast line is hovered. */}
                  {hoveredSeries === 'forecast' && (
                    <div className="weight-chart-rate-pill forecast">
                      <span className="label">{FORECAST_META[forecastMode].label}</span>
                      <span className="value">{slopeLabel}</span>
                    </div>
                  )}
                  <div className="card-header" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-sm)' }}>
                    <span className="card-title">⚖️ Weight Trend</span>

                    {/* Smoothing pill group — how PAST weight is displayed. */}
                    <PillGroup
                      ariaLabel="Smoothing mode"
                      prefixLabel="Smoothing"
                      modes={['1d', '7d', '14d'] as const}
                      active={smoothingMode}
                      onSelect={setSmoothingMode}
                      style={{ marginLeft: 'auto' }}
                    />

                    {/* Forecast pill group — which FUTURE trendline is drawn. */}
                    <PillGroup
                      ariaLabel="Forecast mode"
                      prefixLabel="Forecast"
                      modes={['overall', '60d', '30d', 'off'] as const}
                      active={forecastMode}
                      onSelect={setForecastMode}
                      labelFor={(m) => FORECAST_META[m].label}
                    />

                    {slopeLabel && (
                      <span
                        style={{
                          fontSize: '0.8rem',
                          fontFamily: 'var(--font-mono)',
                          color: '#a78bfa',
                        }}
                      >
                        Forecast: <strong>{slopeLabel}</strong>
                      </span>
                    )}
                  </div>

                  {/* Stat tiles — same stacked label/value pattern as the BF & Calories charts,
                      with slightly larger values for primary-chart prominence. */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-xl)', padding: '12px var(--space-md) 8px', borderBottom: '1px solid var(--border-subtle)', fontSize: '0.82rem' }}>
                    {currentWeight != null && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Current</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '0.95rem', color: 'var(--accent-sky)' }}>{currentWeight} <small style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 500 }}>lbs</small></span>
                      </div>
                    )}
                    {weeklyChange !== null && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>This Week</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '0.95rem', color: weeklyClass === 'success' ? 'var(--accent-emerald)' : weeklyClass === 'danger' ? 'var(--accent-rose)' : 'var(--text-secondary)' }}>
                          {weeklyChange > 0 ? '+' : ''}{weeklyChange} <small style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 500 }}>lbs</small>
                        </span>
                      </div>
                    )}
                    {goalLbs != null && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Goal</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '0.95rem', color: 'var(--accent-emerald)' }}>{goalLbs} <small style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 500 }}>lbs</small></span>
                      </div>
                    )}
                    {proj?.days_remaining != null && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Days to Goal</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-primary)' }}>{proj.days_remaining}</span>
                      </div>
                    )}
                    {proj?.projected_date && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Projected</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-primary)' }}>{new Date(proj.projected_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                      </div>
                    )}
                    {proj?.pace_per_week != null && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Pace</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '0.95rem', color: proj.pace_per_week <= 0 ? 'var(--accent-emerald)' : 'var(--accent-amber)' }}>
                          {proj.pace_per_week > 0 ? '+' : ''}{proj.pace_per_week} <small style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 500 }}>lb/wk</small>
                        </span>
                      </div>
                    )}
                  </div>

                  <ResponsiveContainer width="100%" height={280}>
                      <LineChart data={chartData} margin={{ top: 24, right: 24, left: 0, bottom: 0 }}>
                        <CartesianGrid {...CHART_GRID} />
                        {/* XAxis is numeric (timestamps in ms, UTC midnight). This makes ReferenceArea
                            x1/x2 unambiguous numeric coordinates so refeed/phase bands land precisely.
                            tickFormatter renders MM-DD for display. */}
                        <XAxis
                          type="number"
                          dataKey="ts"
                          domain={['dataMin', 'dataMax']}
                          scale="time"
                          ticks={weeklyTicks}
                          tick={CHART_XAXIS}
                          tickLine={false}
                          axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                          tickFormatter={(ts: number) => {
                            const d = new Date(ts)
                            return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
                          }}
                        />
                        <YAxis domain={['auto', 'auto']} tick={CHART_YAXIS} tickLine={false} axisLine={false} width={45} />
                        <Tooltip
                          content={(props: any) => {
                            const { active, payload, label } = props
                            if (!active || !payload || payload.length === 0 || label == null) return null

                            const d = new Date(Number(label))
                            const labelStr = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
                            const row = payload[0]?.payload as { smoothing_loss?: number | null } | undefined

                            // Δ-vs-N-days-ago: shown only when smoothing is on (7d/14d) and the
                            // precomputed loss is non-null for this point. Loss is precomputed
                            // into each chartData row so we don't recompute on every hover frame.
                            const window = SMOOTHING_META[smoothingMode].window
                            let lossLine: { text: string; color: string } | null = null
                            if (window != null && row && row.smoothing_loss != null) {
                              const loss = row.smoothing_loss
                              const formatted = `${loss > 0 ? '+' : ''}${loss.toFixed(1)} lbs`
                              lossLine = {
                                text: `Δ vs ${window} days ago: ${formatted}`,
                                color: loss <= 0 ? '#10b981' : '#f43f5e',
                              }
                            }

                            return (
                              <div style={{ ...CHART_TOOLTIP, padding: '8px 10px' } as React.CSSProperties}>
                                <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.72rem', fontFamily: 'var(--font-mono)' }}>
                                  {labelStr}
                                </p>
                                {payload.map((p: any, i: number) => (
                                  <p key={i} style={{ margin: '2px 0 0', color: p.color, fontSize: '0.8rem' }}>
                                    {p.name}: {typeof p.value === 'number' ? p.value.toFixed(1) : (p.value ?? '—')}
                                  </p>
                                ))}
                                {lossLine && (
                                  <p style={{ margin: '4px 0 0', color: lossLine.color, fontSize: '0.8rem', fontWeight: 600 }}>
                                    {lossLine.text}
                                  </p>
                                )}
                              </div>
                            )
                          }}
                        />
                        <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '4px' }} />

                        {/* Phase bands — subtle background tint so cut/bulk/maintenance are visible. */}
                        {weightPhaseBands.map(b => (
                          <ReferenceArea
                            key={`phase-band-${b.id}`}
                            x1={b.start}
                            x2={b.end}
                            fill={b.type === 'cut' ? 'rgba(248,113,113,0.05)' :
                                  b.type === 'bulk' ? 'rgba(52,211,153,0.05)' :
                                  'rgba(251,191,36,0.05)'}
                            ifOverflow="extendDomain"
                          />
                        ))}

                        {/* Refeed area-spans — bright amber fill, no border. Vertical-only edges
                            are drawn as separate ReferenceLines below so the band reads as an open
                            channel with left + right boundaries (no top/bottom lines). */}
                        {currentCutPhase && currentCutPhase.refeeds.map(rf => (
                          <ReferenceArea
                            key={`rf-band-${rf.id}`}
                            x1={toTs(rf.start_date)}
                            x2={toTs(rf.end_date)}
                            fill="rgba(251, 191, 36, 0.32)"
                            stroke="none"
                            ifOverflow="extendDomain"
                            label={{
                              value: 'REFEED',
                              position: 'top',
                              fill: '#fbbf24',
                              fontSize: 10,
                              fontWeight: 700,
                              letterSpacing: 1.5,
                              offset: 4,
                            }}
                          />
                        ))}
                        {/* Refeed vertical boundary lines — left + right edges only.
                            The fill above gives the band its color; these two lines give the band
                            its open-channel feel (no top/bottom rules). */}
                        {currentCutPhase && currentCutPhase.refeeds.flatMap(rf => [
                          <ReferenceLine
                            key={`rf-edge-l-${rf.id}`}
                            x={toTs(rf.start_date)}
                            stroke="rgba(251, 191, 36, 0.85)"
                            strokeWidth={1.5}
                            ifOverflow="extendDomain"
                          />,
                          <ReferenceLine
                            key={`rf-edge-r-${rf.id}`}
                            x={toTs(rf.end_date)}
                            stroke="rgba(251, 191, 36, 0.85)"
                            strokeWidth={1.5}
                            ifOverflow="extendDomain"
                          />,
                        ])}

                        {/* Phase boundary markers — subtle vertical lines, NO label (the phase
                            band background tint + stat strip already convey the phase). */}
                        {phases.map(p => {
                          const phaseColor = p.phase_type === 'cut' ? '#f87171'
                            : p.phase_type === 'bulk' ? '#34d399'
                            : '#fbbf24'
                          return (
                            <ReferenceLine
                              key={`phase-bound-${p.id}`}
                              x={toTs(p.start_date)}
                              stroke={phaseColor}
                              strokeOpacity={0.35}
                              strokeDasharray="2 4"
                              ifOverflow="extendDomain"
                            />
                          )
                        })}

                        {/* Goal weight reference lines per phase. */}
                        {phases
                          .filter(p => p.target_weight_lbs != null)
                          .map(p => (
                            <ReferenceLine
                              key={`pw-${p.id}`}
                              y={p.target_weight_lbs!}
                              stroke="var(--accent-emerald)"
                              strokeDasharray="5 3"
                              ifOverflow="extendDomain"
                              label={{
                                value: `${p.phase_type} target: ${p.target_weight_lbs}`,
                                fill: '#10b981',
                                fontSize: 11,
                                position: 'insideTopRight',
                              }}
                            />
                          ))}

                        {/* Primary weight line — raw daily when smoothing='1d',
                            7d/14d trailing SMA otherwise. The `weight` field on
                            chartData rows is already smoothing-aware. */}
                        <Line
                          type="monotone"
                          dataKey="weight"
                          stroke="#38bdf8"
                          strokeWidth={2}
                          dot={smoothingMode === '1d' ? { fill: '#38bdf8', r: 3 } : false}
                          activeDot={{ r: 5 }}
                          name={smoothingMode === '1d' ? 'Weight' : `Weight (${smoothingMode} avg)`}
                          connectNulls
                        />

                        {/* When smoothing is on, faint raw weigh-in dots stay
                            visible underneath so users don't lose the data. */}
                        {smoothingMode !== '1d' && (
                          <Line
                            type="monotone"
                            dataKey="weight_raw"
                            stroke="none"
                            dot={{ fill: 'rgba(56, 189, 248, 0.35)', r: 2, strokeWidth: 0 }}
                            activeDot={false}
                            name="Raw"
                            legendType="none"
                            isAnimationActive={false}
                          />
                        )}

                        {/* Forecast line — backend projection for the selected window
                            (overall / 30d / 60d). Hidden when forecastMode='off'. */}
                        {forecastMode !== 'off' && (
                          <Line
                            type="monotone"
                            dataKey="forecast"
                            stroke={OVERALL_TREND_STROKE}
                            strokeWidth={hoveredSeries === 'forecast' ? 2.5 : 1.5}
                            dot={false}
                            strokeDasharray="5 3"
                            name={FORECAST_META[forecastMode].lineName}
                            connectNulls
                            onMouseEnter={() => setHoveredSeries('forecast')}
                            onMouseLeave={() => setHoveredSeries(null)}
                          />
                        )}
                      </LineChart>
                    </ResponsiveContainer>
                </div>
              )
            })()}

            {/* Body Fat Trend */}
            {bfData.length > 1 && (
              <div className="card chart-container" style={{ marginBottom: 'var(--space-xl)' }}>
                <div className="card-header"><span className="card-title">📐 Body Fat %</span></div>
                {bfStats && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-lg)', padding: '10px var(--space-md) 4px', borderBottom: '1px solid var(--border-subtle)', fontSize: '0.82rem' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Current</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent-sky)' }}>{bfStats.current}%</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Avg</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-secondary)' }}>{bfStats.avg}%</span>
                    </div>
                    {bfStats.trendPerWeek !== null && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Trend</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: bfStats.trendPerWeek <= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)' }}>
                          {bfStats.trendPerWeek > 0 ? '+' : ''}{bfStats.trendPerWeek}%/wk
                        </span>
                      </div>
                    )}
                  </div>
                )}
                <ResponsiveContainer width="100%" height={160}>
                  <LineChart data={bfData}>
                    <CartesianGrid {...CHART_GRID} />
                    <XAxis dataKey="date" tick={CHART_XAXIS} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} />
                    <YAxis domain={['auto', 'auto']} tick={CHART_YAXIS} tickLine={false} axisLine={false} width={35} />
                    <Tooltip contentStyle={CHART_TOOLTIP} formatter={(v: any) => [`${v}%`, 'Body Fat']} />
                    <Line type="monotone" dataKey="bf_pct" stroke="#38bdf8" strokeWidth={2} dot={{ fill: '#38bdf8', r: 3 }} name="BF%" connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* ---------- NUTRITION ---------- */}
          <div className="chart-group">
            <h3 className="chart-group-title">Nutrition</h3>

            {/* Calories & Deficit (existing) */}
            {linearCalorieData.length > 1 && (
              <div className="card chart-container" style={{ marginBottom: 'var(--space-xl)' }}>
                <div className="card-header"><span className="card-title">🔥 Calories & Deficit</span></div>
                {calStats && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-lg)', padding: '10px var(--space-md) 4px', borderBottom: '1px solid var(--border-subtle)', fontSize: '0.82rem' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Avg Cal/Day</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: '#f59e0b' }}>{calStats.avgCal}</span>
                    </div>
                    {calStats.avgDeficit !== null && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Avg Deficit/Day</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: calStats.avgDeficit >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)' }}>
                          {calStats.avgDeficit >= 0 ? '' : '+'}{Math.abs(calStats.avgDeficit)} cal
                        </span>
                      </div>
                    )}
                  </div>
                )}
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={calChartDataWithTarget}>
                    <CartesianGrid {...CHART_GRID} />
                    <XAxis dataKey="date" tick={CHART_XAXIS} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} />
                    <YAxis tick={CHART_YAXIS} tickLine={false} axisLine={false} width={50} />
                    <Tooltip contentStyle={CHART_TOOLTIP} />
                    {phaseBands.map(b => (
                      <ReferenceArea
                        key={`band-${b.id}`}
                        x1={b.start}
                        x2={b.end}
                        fill={b.type === 'cut' ? 'rgba(248,113,113,0.05)' :
                              b.type === 'bulk' ? 'rgba(52,211,153,0.05)' :
                              'rgba(148,163,184,0.05)'}
                        ifOverflow="extendDomain"
                      />
                    ))}
                    <Line type="monotone" dataKey="calories" stroke="#f59e0b" strokeWidth={2} dot={{ r: 2 }} name="Calories In" connectNulls />
                    <Line type="monotone" dataKey="deficit" stroke="#10b981" strokeWidth={2} dot={{ r: 2 }} name="Net Deficit" connectNulls />
                    <Line type="stepAfter" dataKey="target" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} name="Target" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* TDEE vs Calories In */}
            {tdeeChartData.length > 1 && (
              <div className="card chart-container" style={{ marginBottom: 'var(--space-xl)' }}>
                <div className="card-header" style={{ alignItems: 'center' }}>
                  <span className="card-title">⚡ TDEE vs Calories In</span>
                  {(() => {
                    const last = [...tdeeChartData].reverse().find(d => d.cico_tdee !== null)
                    const lastFormula = [...tdeeChartData].reverse().find(d => d.formula_tdee !== null)
                    return (
                      <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-md)', fontSize: '0.78rem', fontFamily: 'var(--font-mono)' }}>
                        {lastFormula && (
                          <span style={{ color: '#a78bfa' }}>Formula: <strong>{lastFormula.formula_tdee}</strong></span>
                        )}
                        {last && (
                          <span style={{ color: '#34d399' }}>CICO: <strong>{last.cico_tdee}</strong></span>
                        )}
                      </div>
                    )
                  })()}
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={tdeeChartData}>
                    <CartesianGrid {...CHART_GRID} />
                    <XAxis dataKey="date" tick={CHART_XAXIS} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} />
                    <YAxis domain={['auto', 'auto']} tick={CHART_YAXIS} tickLine={false} axisLine={false} width={50} />
                    <Tooltip contentStyle={CHART_TOOLTIP} formatter={(v: any, name: any) => [`${v} kcal`, String(name)]} />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '4px' }} />
                    <Line type="monotone" dataKey="calories" stroke="#f59e0b" strokeWidth={2} dot={{ r: 2 }} name="Calories In" connectNulls />
                    <Line type="monotone" dataKey="formula_tdee" stroke="#a78bfa" strokeWidth={2} dot={false} name="Formula TDEE" connectNulls />
                    <Line type="monotone" dataKey="cico_tdee" stroke="#34d399" strokeWidth={2} dot={false} strokeDasharray="5 3" name="CICO TDEE" connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Daily Macros (existing) */}
            {macroChartData.length > 1 && (
              <div className="card chart-container" style={{ marginBottom: 'var(--space-xl)' }}>
                <div className="card-header"><span className="card-title">🥗 Daily Macros (g)</span></div>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={macroChartData} barSize={14}>
                    <CartesianGrid {...CHART_GRID} vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} />
                    <YAxis tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} width={35} />
                    <Tooltip contentStyle={CHART_TOOLTIP} formatter={(v: any, name: any) => [`${v}g`, String(name)]} />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                    <Bar dataKey="protein" stackId="macros" fill="#38bdf8" name="Protein" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="carbs" stackId="macros" fill="#f59e0b" name="Net Carbs" />
                    <Bar dataKey="fat" stackId="macros" fill="#f87171" name="Fat" />
                    <Bar dataKey="fiber" stackId="macros" fill="#34d399" name="Fiber" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Monthly Macro Averages */}
            {availableMonths.length > 0 && (
              <div className="card chart-container" style={{ marginBottom: 'var(--space-xl)' }}>
                <div className="card-header" style={{ alignItems: 'center' }}>
                  <span className="card-title">📊 Monthly Averages</span>
                  <select
                    value={selectedMonth}
                    onChange={e => setSelectedMonth(e.target.value)}
                    style={{
                      marginLeft: 'auto', background: 'var(--bg-input)', color: 'var(--text-primary)',
                      border: '1px solid var(--border-medium)', borderRadius: 'var(--radius-sm)',
                      padding: '4px 8px', fontSize: '0.8rem', fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {availableMonths.map(m => (
                      <option key={m} value={m}>
                        {new Date(parseInt(m.slice(0, 4)), parseInt(m.slice(5, 7)) - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                      </option>
                    ))}
                  </select>
                </div>
                {monthAvg ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-lg)', alignItems: 'center' }}>
                    {/* Calorie pie */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '1 1 140px', minWidth: 140 }}>
                      <ResponsiveContainer width="100%" height={160}>
                        <PieChart>
                          <Pie
                            data={[
                              { name: 'Consumed', value: monthAvg.calories, fill: '#f59e0b' },
                              { name: 'Remaining', value: Math.max(0, 1850 - monthAvg.calories), fill: 'rgba(255,255,255,0.06)' },
                            ]}
                            cx="50%" cy="50%" innerRadius={40} outerRadius={60} dataKey="value" startAngle={90} endAngle={-270} stroke="none"
                          />
                        </PieChart>
                      </ResponsiveContainer>
                      <div style={{ textAlign: 'center', marginTop: '-8px' }}>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.1rem', color: '#f59e0b' }}>{monthAvg.calories}</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>avg cal / day</div>
                      </div>
                    </div>
                    {/* Macro pie */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '1 1 200px', minWidth: 200 }}>
                      <ResponsiveContainer width="100%" height={220}>
                        <PieChart margin={{ top: 30, right: 60, bottom: 30, left: 60 }}>
                          <Pie data={macroPieData} cx="50%" cy="50%" innerRadius={40} outerRadius={60} dataKey="value" startAngle={90} endAngle={-270} stroke="none"
                            label={({ name, value }) => `${name} ${value}g`} labelLine={{ stroke: 'rgba(255,255,255,0.2)' }}>
                            {macroPieData.map((entry, i) => (
                              <Cell key={i} fill={entry.color} />
                            ))}
                          </Pie>
                          <Tooltip contentStyle={CHART_TOOLTIP} formatter={(v: any, name: any) => [`${v}g / day`, name]} />
                        </PieChart>
                      </ResponsiveContainer>
                      <div style={{ textAlign: 'center', marginTop: '-8px' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>avg macros / day</div>
                      </div>
                    </div>
                    {/* Stats column */}
                    <div style={{ flex: '1 1 160px', minWidth: 140, display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.82rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--text-muted)' }}>Days tracked</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{monthAvg.days}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#6366f1' }}>Protein</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{monthAvg.protein}g</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#38bdf8' }}>Net Carbs</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{monthAvg.carbs}g</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#f43f5e' }}>Fat</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{monthAvg.fat}g</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#10b981' }}>Fiber</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{monthAvg.fiber}g</span>
                      </div>
                      {/* Sleep + mood — only render when there's data for the
                          month, with a tooltip noting the (likely smaller)
                          sample size since these aren't gated on calorie tracking. */}
                      {monthAvg.sleep != null && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }} title={`Avg of ${monthAvg.sleepDays} day${monthAvg.sleepDays === 1 ? '' : 's'} with sleep logged`}>
                          <span style={{ color: '#a78bfa' }}>Sleep</span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{monthAvg.sleep}h</span>
                        </div>
                      )}
                      {monthAvg.mood != null && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }} title={`Avg of ${monthAvg.moodDays} day${monthAvg.moodDays === 1 ? '' : 's'} with mood logged`}>
                          <span style={{ color: '#fbbf24' }}>Mood</span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                            {getMoodEmoji(String(Math.round(monthAvg.mood)))} {monthAvg.mood.toFixed(1)}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No data for this month.</p>
                )}
              </div>
            )}

            {/* Monthly Workout Averages */}
            {availableMonths.length > 0 && monthWorkoutAvg && (
              <div className="card chart-container" style={{ marginBottom: 'var(--space-xl)' }}>
                <div className="card-header" style={{ alignItems: 'center' }}>
                  <span className="card-title">🏋️ Monthly Workout Averages</span>
                </div>
                {monthWorkoutAvg.workoutDays > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-lg)', alignItems: 'center' }}>
                    {/* Frequency pie */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '1 1 140px', minWidth: 140 }}>
                      <ResponsiveContainer width="100%" height={160}>
                        <PieChart>
                          <Pie
                            data={[
                              { name: 'Workout', value: monthWorkoutAvg.workoutDays, fill: '#6366f1' },
                              { name: 'Rest', value: monthWorkoutAvg.totalDays - monthWorkoutAvg.workoutDays, fill: 'rgba(255,255,255,0.06)' },
                            ]}
                            cx="50%" cy="50%" innerRadius={40} outerRadius={60} dataKey="value" startAngle={90} endAngle={-270} stroke="none"
                          />
                        </PieChart>
                      </ResponsiveContainer>
                      <div style={{ textAlign: 'center', marginTop: '-8px' }}>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.1rem', color: '#6366f1' }}>{monthWorkoutAvg.frequency}%</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>workout frequency</div>
                      </div>
                    </div>
                    {/* Type distribution pie */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '1 1 200px', minWidth: 200 }}>
                      <ResponsiveContainer width="100%" height={220}>
                        <PieChart margin={{ top: 30, right: 60, bottom: 30, left: 60 }}>
                          <Pie data={monthWorkoutAvg.typePieData} cx="50%" cy="50%" innerRadius={40} outerRadius={60} dataKey="value" startAngle={90} endAngle={-270} stroke="none"
                            label={({ name, value }) => `${name} ${value}`} labelLine={{ stroke: 'rgba(255,255,255,0.2)' }}>
                            {monthWorkoutAvg.typePieData.map((entry, i) => (
                              <Cell key={i} fill={entry.color} />
                            ))}
                          </Pie>
                          <Tooltip contentStyle={CHART_TOOLTIP} formatter={(v: any, name: any) => [`${v} days`, name]} />
                        </PieChart>
                      </ResponsiveContainer>
                      <div style={{ textAlign: 'center', marginTop: '-8px' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>workout split</div>
                      </div>
                    </div>
                    {/* Stats column */}
                    <div style={{ flex: '1 1 160px', minWidth: 140, display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.82rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--text-muted)' }}>Workout days</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{monthWorkoutAvg.workoutDays} / {monthWorkoutAvg.totalDays}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#f59e0b' }}>Total burn</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{monthWorkoutAvg.totalBurn.toLocaleString()} cal</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#f87171' }}>Avg / workout</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{monthWorkoutAvg.avgBurnPerWorkout} cal</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#10b981' }}>Avg / day</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{monthWorkoutAvg.avgBurnPerDay} cal</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No workouts this month.</p>
                )}
              </div>
            )}

            {/* Cumulative Deficit */}
            {cumulativeDeficitData.length > 1 && (
              <div className="card chart-container" style={{ marginBottom: 'var(--space-xl)' }}>
                <div className="card-header"><span className="card-title">📉 Cumulative Deficit</span></div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-lg)', padding: '10px var(--space-md) 4px', borderBottom: '1px solid var(--border-subtle)', fontSize: '0.82rem' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tracked</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent-emerald)' }}>{cumDefStats.trackedDeficit.toLocaleString()} cal</span>
                  </div>
                  {cumDefStats.scaleDeficit !== null && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Scale (trend)</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent-sky)' }}>{cumDefStats.scaleDeficit.toLocaleString()} cal</span>
                    </div>
                  )}
                  {cumDefStats.scaleActualDeficit !== null && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Scale (actual)</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent-amber)' }}>{cumDefStats.scaleActualDeficit.toLocaleString()} cal</span>
                    </div>
                  )}
                  {cumDefStats.accuracy !== null && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tracking : Scale</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: cumDefStats.accuracy >= 80 && cumDefStats.accuracy <= 120 ? 'var(--accent-emerald)' : 'var(--accent-amber)' }}>
                        {(cumDefStats.accuracy / 100).toFixed(2)}x
                      </span>
                    </div>
                  )}
                </div>
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={cumulativeDeficitData}>
                    <defs>
                      <linearGradient id="deficitGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid {...CHART_GRID} />
                    <XAxis dataKey="date" tick={CHART_XAXIS} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} />
                    <YAxis tick={CHART_YAXIS} tickLine={false} axisLine={false} width={55} />
                    <Tooltip contentStyle={CHART_TOOLTIP} formatter={(v: any, name: any) => [v != null ? `${v.toLocaleString()} cal` : 'N/A', String(name)]} />
                    <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '4px' }} />
                    <Area type="monotone" dataKey="cumulative" stroke="#10b981" strokeWidth={2} fill="url(#deficitGrad)" name="Tracked" />
                    <Area type="monotone" dataKey="scaleCumulative" stroke="#38bdf8" strokeWidth={2} fill="none" strokeDasharray="5 3" name="Scale (trend)" connectNulls />
                    <Area type="monotone" dataKey="scaleActual" stroke="#f59e0b" strokeWidth={1.5} fill="none" strokeDasharray="3 2" name="Scale (actual)" connectNulls />
                    {[3500, 7000, 10500, 14000, 17500, 21000].filter(v => v <= (cumulativeDeficitData[cumulativeDeficitData.length - 1]?.cumulative || 0) * 1.2).map(v => (
                      <ReferenceLine key={v} y={v} stroke="rgba(255,255,255,0.15)" strokeDasharray="3 3"
                        label={{ value: `~${Math.round(v / 3500)} lb`, fill: '#64748b', fontSize: 10, position: 'right' }} />
                    ))}
                    {phases.map(p => (
                      <ReferenceLine
                        key={`db-${p.id}`}
                        x={p.start_date.slice(5)}
                        stroke="rgba(255,255,255,0.15)"
                        strokeDasharray="3 3"
                        label={{ value: p.phase_type, fontSize: 10, fill: 'var(--text-muted)' }}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* ---------- HABITS ---------- */}
          <div className="chart-group">
            <h3 className="chart-group-title">Habits</h3>

            {/* Habit Heatmap */}
            <div className="card chart-container" style={{ marginBottom: 'var(--space-xl)' }}>
              <div className="card-header" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 'var(--space-sm)' }}>
                <span className="card-title">✅ Daily Habits</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  <button
                    onClick={() => setHabitFilter(null)}
                    style={{
                      padding: '3px 10px', fontSize: '0.72rem', borderRadius: 'var(--radius-full)',
                      border: '1px solid ' + (habitFilter === null ? 'var(--accent-indigo)' : 'var(--border-medium)'),
                      background: habitFilter === null ? 'rgba(99,102,241,0.2)' : 'transparent',
                      color: habitFilter === null ? 'var(--accent-indigo)' : 'var(--text-muted)',
                      cursor: 'pointer',
                    }}
                  >All</button>
                  {HABIT_LABELS.map(h => (
                    <button
                      key={h.key}
                      onClick={() => setHabitFilter(habitFilter === h.key ? null : h.key)}
                      style={{
                        padding: '3px 10px', fontSize: '0.72rem', borderRadius: 'var(--radius-full)',
                        border: '1px solid ' + (habitFilter === h.key ? 'var(--accent-indigo)' : 'var(--border-medium)'),
                        background: habitFilter === h.key ? 'rgba(99,102,241,0.2)' : 'transparent',
                        color: habitFilter === h.key ? 'var(--accent-indigo)' : 'var(--text-muted)',
                        cursor: 'pointer',
                      }}
                    >{h.label}</button>
                  ))}
                </div>
              </div>
              <div ref={heatmapRef} style={{ position: 'relative' }}>
                {/* Tooltip — position: absolute relative to this container, avoiding backdrop-filter issues */}
                {habitTooltip && (
                  <div className="heatmap-tooltip" style={{ left: habitTooltip.x, top: habitTooltip.y, transform: 'translate(-50%, calc(-100% - 8px))' }}>
                    <div className="heatmap-tooltip-date">
                      {new Date(habitTooltip.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </div>
                    {habitTooltip.count === 0
                      ? <div style={{ color: 'var(--text-muted)', marginTop: '2px' }}>No habits completed</div>
                      : habitTooltip.habits.map((h, i) => <div key={i} className="heatmap-tooltip-habit">{h}</div>)
                    }
                  </div>
                )}
                {/* 2-col layout: day labels | scrollable (month row + cells) */}
                <div style={{ display: 'flex', gap: '4px', overflowX: 'auto' }}>
                  {/* Day labels — fixed 13px rows to match cell size */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', paddingTop: '18px', flexShrink: 0 }}>
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => (
                      <div key={day} style={{ height: '13px', lineHeight: '13px', fontSize: '0.6rem', color: 'var(--text-muted)', textAlign: 'right', paddingRight: '4px', width: '26px', visibility: i % 2 === 1 ? 'visible' : 'hidden' }}>
                        {day}
                      </div>
                    ))}
                  </div>
                  {/* Month labels + cells */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    {/* Month labels */}
                    <div style={{ display: 'flex', gap: '2px', height: '16px' }}>
                      {habitHeatmapCells.map((_, wi) => (
                        <div key={wi} style={{ width: '13px', height: '16px', fontSize: '0.6rem', color: 'var(--text-muted)', lineHeight: '16px', overflow: 'visible', whiteSpace: 'nowrap' }}>
                          {habitMonthLabels[wi] || ''}
                        </div>
                      ))}
                    </div>
                    {/* Cells */}
                    <div style={{ display: 'flex', gap: '2px' }}>
                      {habitHeatmapCells.map((week, wi) => (
                        <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          {week.map((cell, di) => (
                            <div
                              key={di}
                              style={{
                                width: '13px', height: '13px', borderRadius: '2px',
                                background: cell.count < 0 ? 'transparent'
                                  : habitFilter ? (cell.keys.includes(habitFilter) ? 'rgba(99,102,241,0.8)' : 'rgba(255,255,255,0.03)')
                                  : habitColor(cell.count),
                                cursor: cell.date ? 'pointer' : 'default',
                              }}
                              onMouseEnter={cell.date ? (e) => {
                                const containerRect = heatmapRef.current?.getBoundingClientRect()
                                const cellRect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                                if (containerRect) {
                                  setHabitTooltip({ date: cell.date, habits: cell.habits, count: cell.count, x: cellRect.left - containerRect.left + cellRect.width / 2, y: cellRect.top - containerRect.top })
                                }
                              } : undefined}
                              onMouseLeave={cell.date ? () => setHabitTooltip(null) : undefined}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="heatmap-legend" style={{ marginTop: 'var(--space-sm)' }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginRight: '6px' }}>0</span>
                  {[0, 1, 2, 3, 4, 5, 6].map(l => (
                    <div key={l} className="heatmap-cell" style={{ background: habitColor(l), display: 'inline-block', width: '12px', height: '12px' }} />
                  ))}
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginLeft: '6px' }}>6</span>
                </div>
              </div>
            </div>

            {/* Mood */}
            {moodData.length > 1 && (
              <div className="card chart-container" style={{ marginBottom: 'var(--space-xl)' }}>
                <div className="card-header"><span className="card-title">🎭 Mood</span></div>
                {moodStats && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-lg)', padding: '10px var(--space-md) 4px', borderBottom: '1px solid var(--border-subtle)', fontSize: '0.82rem' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Avg</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: '#8b5cf6' }}>{moodStats.avg}</span>
                    </div>
                    {moodStats.streak > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Streak</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent-emerald)' }}>{moodStats.streak}d at 4+</span>
                      </div>
                    )}
                  </div>
                )}
                <ResponsiveContainer width="100%" height={160}>
                  <AreaChart data={moodData}>
                    <defs>
                      <linearGradient id="moodGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid {...CHART_GRID} />
                    <XAxis dataKey="date" tick={CHART_XAXIS} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} />
                    <YAxis domain={[1, 5]} ticks={[1, 2, 3, 4, 5]} tick={CHART_YAXIS} tickLine={false} axisLine={false} width={25} />
                    <Tooltip contentStyle={CHART_TOOLTIP} formatter={(v: any) => {
                      const labels: Record<number, string> = { 1: '1 - Poor', 2: '2 - Low', 3: '3 - Neutral', 4: '4 - Good', 5: '5 - Excellent' }
                      return [labels[v] || v, 'Mood']
                    }} />
                    <Area type="monotone" dataKey="mood" stroke="#8b5cf6" strokeWidth={2} fill="url(#moodGrad)" dot={(props: any) => {
                      const { cx, cy, payload } = props
                      const color = payload.mood >= 4 ? '#10b981' : payload.mood === 3 ? '#f59e0b' : '#f43f5e'
                      return <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={3} fill={color} stroke="none" />
                    }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Habit quantity */}
            {habitChartData.length > 1 && (
              <div className="card chart-container" style={{ marginBottom: 'var(--space-xl)' }}>
                <div className="card-header"><span className="card-title">{`${habitMeta.emoji} ${habitMeta.label} (${habitMeta.unit})`}</span></div>
                {habitStats && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-lg)', padding: '10px var(--space-md) 4px', borderBottom: '1px solid var(--border-subtle)', fontSize: '0.82rem' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Avg</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-secondary)' }}>{habitStats.avg}{habitMeta.unit}/day</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Under 0.5{habitMeta.unit}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent-emerald)' }}>{habitStats.underPct}%</span>
                    </div>
                  </div>
                )}
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={habitChartData} barSize={10}>
                    <CartesianGrid {...CHART_GRID} vertical={false} />
                    <XAxis dataKey="date" tick={CHART_XAXIS} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} />
                    <YAxis tick={CHART_YAXIS} tickLine={false} axisLine={false} width={30} />
                    <Tooltip contentStyle={CHART_TOOLTIP} formatter={(v: any) => [`${v}${habitMeta.unit}`, habitMeta.label]} />
                    <ReferenceLine y={0.5} stroke="rgba(16,185,129,0.4)" strokeDasharray="3 3" />
                    <Bar dataKey="habit_qty" name={habitMeta.label}>
                      {habitChartData.map((entry, i) => (
                        <Cell key={i} fill={entry.habit_qty <= 0.5 ? '#10b981' : entry.habit_qty <= 1 ? '#f59e0b' : '#f43f5e'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Caffeine */}
            {caffeineData.length > 1 && (
              <div className="card chart-container" style={{ marginBottom: 'var(--space-xl)' }}>
                <div className="card-header"><span className="card-title">☕ Caffeine (mg)</span></div>
                {caffeineStats && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-lg)', padding: '10px var(--space-md) 4px', borderBottom: '1px solid var(--border-subtle)', fontSize: '0.82rem' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Avg</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-secondary)' }}>{caffeineStats.avg}mg/day</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Under 240mg</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent-emerald)' }}>{caffeineStats.underPct}%</span>
                    </div>
                  </div>
                )}
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={caffeineData} barSize={10}>
                    <CartesianGrid {...CHART_GRID} vertical={false} />
                    <XAxis dataKey="date" tick={CHART_XAXIS} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} />
                    <YAxis tick={CHART_YAXIS} tickLine={false} axisLine={false} width={35} />
                    <Tooltip contentStyle={CHART_TOOLTIP} formatter={(v: any) => [`${v}mg`, 'Caffeine']} />
                    <ReferenceLine y={240} stroke="rgba(251,191,36,0.4)" strokeDasharray="3 3" />
                    <Bar dataKey="caffeine_mg" name="Caffeine">
                      {caffeineData.map((entry, i) => (
                        <Cell key={i} fill={entry.caffeine_mg <= 160 ? '#10b981' : entry.caffeine_mg <= 240 ? '#f59e0b' : '#f43f5e'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Drinks */}
            {drinksData.length > 1 && (
              <div className="card chart-container" style={{ marginBottom: 'var(--space-xl)' }}>
                <div className="card-header"><span className="card-title">🍺 Drinks</span></div>
                {drinksStats && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-lg)', padding: '10px var(--space-md) 4px', borderBottom: '1px solid var(--border-subtle)', fontSize: '0.82rem' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Avg</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-secondary)' }}>{drinksStats.avg}/day</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Dry Days</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent-emerald)' }}>{drinksStats.dryPct}%</span>
                    </div>
                  </div>
                )}
                <ResponsiveContainer width="100%" height={140}>
                  <BarChart data={drinksData} barSize={10}>
                    <CartesianGrid {...CHART_GRID} vertical={false} />
                    <XAxis dataKey="date" tick={CHART_XAXIS} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} />
                    <YAxis tick={CHART_YAXIS} tickLine={false} axisLine={false} width={25} />
                    <Tooltip contentStyle={CHART_TOOLTIP} />
                    <Bar dataKey="drinks" name="Drinks">
                      {drinksData.map((entry, i) => (
                        <Cell key={i} fill={entry.drinks === 0 ? '#10b981' : entry.drinks <= 2 ? '#f59e0b' : '#f43f5e'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Sleep */}
            {sleepData.length > 1 && (
              <div className="card chart-container" style={{ marginBottom: 'var(--space-xl)' }}>
                <div className="card-header"><span className="card-title">😴 Sleep</span></div>
                {sleepStats && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-lg)', padding: '10px var(--space-md) 4px', borderBottom: '1px solid var(--border-subtle)', fontSize: '0.82rem' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Avg</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent-violet)' }}>{sleepStats.avg}h/night</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Met 7.5h Target</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent-emerald)' }}>{sleepStats.metTargetPct}%</span>
                    </div>
                  </div>
                )}
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={sleepData}>
                    <CartesianGrid {...CHART_GRID} vertical={false} />
                    <XAxis dataKey="date" tick={CHART_XAXIS} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} />
                    <YAxis yAxisId="hours" tick={CHART_YAXIS} tickLine={false} axisLine={false} width={35} domain={[0, 12]} />
                    <YAxis
                      yAxisId="time" orientation="right" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} width={45}
                      domain={[20, 36]}
                      ticks={[20, 22, 24, 26, 28, 30, 32, 34]}
                      tickFormatter={(v: number) => { const h = v % 24; return `${h.toString().padStart(2, '0')}:00` }}
                      reversed
                    />
                    <Tooltip
                      contentStyle={CHART_TOOLTIP}
                      formatter={(v: any, name: any) => {
                        if (name === 'sleep_hours') return [`${v}h`, 'Duration']
                        const h = Math.floor(v % 24); const m = Math.round((v % 1) * 60)
                        return [`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`, name === 'bedtime' ? 'Bedtime' : 'Wake']
                      }}
                    />
                    <ReferenceLine yAxisId="hours" y={7.5} stroke="rgba(139,92,246,0.4)" strokeDasharray="3 3" />
                    <Bar yAxisId="hours" dataKey="sleep_hours" name="sleep_hours" barSize={12}>
                      {sleepData.map((entry, i) => (
                        <Cell key={i} fill={entry.sleep_hours >= 7.5 ? '#8b5cf6' : entry.sleep_hours >= 6 ? '#f59e0b' : '#f43f5e'} fillOpacity={0.7} />
                      ))}
                    </Bar>
                    <Line yAxisId="time" type="monotone" dataKey="bedtime" stroke="#f472b6" strokeWidth={2} dot={{ r: 3, fill: '#f472b6' }} connectNulls />
                    <Line yAxisId="time" type="monotone" dataKey="waketime" stroke="#38bdf8" strokeWidth={2} dot={{ r: 3, fill: '#38bdf8' }} connectNulls />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* ---------- VITALS ---------- */}
          {health.length > 0 && (
            <div className="chart-group">
              <h3 className="chart-group-title">Vitals</h3>

              {stepsData.length > 1 && (
                <div className="card chart-container" style={{ marginBottom: 'var(--space-xl)' }}>
                  <div className="card-header"><span className="card-title">👣 Steps</span></div>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={stepsData} barSize={12}>
                      <CartesianGrid {...CHART_GRID} vertical={false} />
                      <XAxis dataKey="date" tick={CHART_XAXIS} tickLine={false} axisLine={false} />
                      <YAxis tick={CHART_YAXIS} tickLine={false} axisLine={false} width={45} />
                      <Tooltip contentStyle={CHART_TOOLTIP} />
                      <Bar dataKey="steps" fill="#38bdf8" fillOpacity={0.8} radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {rhrData.filter(d => d.rhr != null).length > 1 && (
                <div className="card chart-container" style={{ marginBottom: 'var(--space-xl)' }}>
                  <div className="card-header"><span className="card-title">❤️ Resting Heart Rate</span></div>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={rhrData}>
                      <CartesianGrid {...CHART_GRID} vertical={false} />
                      <XAxis dataKey="date" tick={CHART_XAXIS} tickLine={false} axisLine={false} />
                      <YAxis tick={CHART_YAXIS} tickLine={false} axisLine={false} width={35} domain={['dataMin - 3', 'dataMax + 3']} />
                      <Tooltip contentStyle={CHART_TOOLTIP} />
                      <Line type="monotone" dataKey="rhr" stroke="#10b981" strokeWidth={1.5} dot={{ r: 2 }} connectNulls />
                      <Line type="monotone" dataKey="rhrAvg" stroke="#34d399" strokeWidth={2.5} dot={false} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {hrvData.filter(d => d.hrv != null).length > 1 && (
                <div className="card chart-container" style={{ marginBottom: 'var(--space-xl)' }}>
                  <div className="card-header"><span className="card-title">💜 HRV <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: '0.8rem' }}>(7-day trend)</span></span></div>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={hrvData}>
                      <CartesianGrid {...CHART_GRID} vertical={false} />
                      <XAxis dataKey="date" tick={CHART_XAXIS} tickLine={false} axisLine={false} />
                      <YAxis tick={CHART_YAXIS} tickLine={false} axisLine={false} width={35} />
                      <Tooltip contentStyle={CHART_TOOLTIP} />
                      <Line type="monotone" dataKey="hrv" stroke="#8b5cf6" strokeWidth={1} strokeOpacity={0.45} dot={false} connectNulls />
                      <Line type="monotone" dataKey="hrvAvg" stroke="#8b5cf6" strokeWidth={3} dot={false} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {respData.length > 1 && (
                <div className="card chart-container" style={{ marginBottom: 'var(--space-xl)' }}>
                  <div className="card-header"><span className="card-title">🫁 Respiratory Rate</span></div>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={respData}>
                      <CartesianGrid {...CHART_GRID} vertical={false} />
                      <XAxis dataKey="date" tick={CHART_XAXIS} tickLine={false} axisLine={false} />
                      <YAxis tick={CHART_YAXIS} tickLine={false} axisLine={false} width={35} domain={['dataMin - 1', 'dataMax + 1']} />
                      <Tooltip contentStyle={CHART_TOOLTIP} />
                      <Line type="monotone" dataKey="resp" stroke="#38bdf8" strokeWidth={2} dot={{ r: 2 }} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {stageData.length > 1 && (
                <div className="card chart-container" style={{ marginBottom: 'var(--space-xl)' }}>
                  <div className="card-header"><span className="card-title">🌙 Sleep Stages</span></div>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={stageData} barSize={12}>
                      <CartesianGrid {...CHART_GRID} vertical={false} />
                      <XAxis dataKey="date" tick={CHART_XAXIS} tickLine={false} axisLine={false} />
                      <YAxis tick={CHART_YAXIS} tickLine={false} axisLine={false} width={45} tickFormatter={(v: number) => `${Math.round(v / 60)}h`} />
                      <Tooltip contentStyle={CHART_TOOLTIP} formatter={(v: any, n: any) => [`${Math.round(v)}m`, n]} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="deep" stackId="s" fill="#6366f1" name="Deep" />
                      <Bar dataKey="rem" stackId="s" fill="#8b5cf6" name="REM" />
                      <Bar dataKey="light" stackId="s" fill="#38bdf8" name="Light" />
                      <Bar dataKey="awake" stackId="s" fill="#64748b" name="Awake" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

            </div>
          )}

        </>
      )}

      {/* ==========================================
          TABLE VIEW
          ========================================== */}
      {!loading && viewMode === 'table' && (
        <>
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr className="group-row">
                  <th className="sticky-col sticky-date" colSpan={2}></th>
                  {(['body', 'vitals', 'nutrition', 'energy', 'substances', 'wellness'] as const).map(g => {
                    const cfg = { body: { cls: 'g-body', label: 'Body', cols: 3 }, vitals: { cls: 'g-vitals', label: 'Vitals', cols: 4 }, nutrition: { cls: 'g-nutrition', label: 'Nutrition', cols: 6 }, energy: { cls: 'g-energy', label: 'Energy', cols: 3 }, substances: { cls: 'g-substances', label: 'Substances', cols: 3 }, wellness: { cls: 'g-wellness', label: 'Wellness', cols: 3 } }[g]
                    return (
                      <th key={g} className={`${cfg.cls} group-divider collapsible-group`}
                        colSpan={collapsed[g] ? 1 : cfg.cols}
                        onClick={() => toggle(g)} style={{ cursor: 'pointer', userSelect: 'none' }}>
                        {collapsed[g] ? <span title={`Show ${cfg.label}`} style={{ opacity: 0.5 }}>+</span> : cfg.label}
                      </th>
                    )
                  })}
                  <th className="group-divider" colSpan={2}></th>
                </tr>
                <tr>
                  <th className="sticky-col sticky-date" style={{ textAlign: 'left' }}>Date</th>
                  <th className="sticky-col sticky-day"></th>
                  {collapsed.body ? (
                    <th className="group-divider collapsible-collapsed" onClick={() => toggle('body')} />
                  ) : <><th className="group-divider">Type</th><th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => setWeightUnit(u => u === 'lbs' ? 'kg' : 'lbs')}>{weightUnit === 'lbs' ? 'Wt' : 'Wt (kg)'}</th><th>BF%</th></>}
                  {collapsed.vitals ? (
                    <th className="group-divider collapsible-collapsed" onClick={() => toggle('vitals')} />
                  ) : <><th className="group-divider">Steps</th><th>RHR</th><th>HRV</th><th>Resp</th></>}
                  {collapsed.nutrition ? (
                    <th className="group-divider collapsible-collapsed" onClick={() => toggle('nutrition')} />
                  ) : <><th className="group-divider">Cal In</th><th>Burn</th><th>Prot</th><th>Carb</th><th>Fat</th><th>Fiber</th></>}
                  {collapsed.energy ? (
                    <th className="group-divider collapsible-collapsed" onClick={() => toggle('energy')} />
                  ) : <><th className="group-divider">Sed.</th><th>CICO</th><th>Deficit</th></>}
                  {collapsed.substances ? (
                    <th className="group-divider collapsible-collapsed" onClick={() => toggle('substances')} />
                  ) : <><th className="group-divider">Drinks</th><th>{habitMeta.label}</th><th>Caff</th></>}
                  {collapsed.wellness ? (
                    <th className="group-divider collapsible-collapsed" onClick={() => toggle('wellness')} />
                  ) : <><th className="group-divider">Sleep</th><th>Mood</th><th>Habits</th></>}
                  <th className="group-divider" style={{ textAlign: 'left', minWidth: 140 }}>Notes</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {daily.map(d => {
                  const isEditing = editingId === d.id;
                  const isWeekend = d.day_of_week === 'Saturday' || d.day_of_week === 'Sunday';
                  const isToday = d.date === todayISO();
                  const habitScore = getHabitScore(d);
                  const t = targetsForDate(phases, d.date, ENV_DEFAULTS);
                  const phaseClass = `phase-${t.phase_type ?? 'none'}${t.in_refeed ? ' phase-refeed' : ''}`;
                  const rowClass = [isToday && 'today-row', isWeekend && 'alt-day', phaseClass].filter(Boolean).join(' ');
                  const phaseLabel = t.phase_type
                    ? `${t.phase_type.toUpperCase()}${t.in_refeed ? ' · REFEED' : ''}  ·  ${t.calories} cal target`
                    : '';
                  return (
                    <tr key={d.id} className={rowClass} onKeyDown={isEditing ? (e) => {
                      if (e.key === 'Enter') { e.preventDefault(); saveEdit(d) }
                      if (e.key === 'Escape') setEditingId(null)
                    } : undefined}>
                      <td
                        className="sticky-col sticky-date"
                        style={{ textAlign: 'left' }}
                      >
                        <span className="date-text">{displayDate(d.date)}</span>
                        {isToday && <span className="today-badge">Today</span>}
                        {phaseLabel && <span className="phase-tooltip">{phaseLabel}</span>}
                      </td>
                      <td className="sticky-col sticky-day" style={{ fontFamily: 'var(--font-sans)', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                        {d.day_of_week?.slice(0, 3) || ''}
                      </td>
                      {/* Body group */}
                      {collapsed.body ? (
                        <td className="group-divider collapsible-collapsed" />
                      ) : <>
                      <td className="group-divider">
                        {isEditing ? (
                          <select value={editForm.workout_type} onChange={(e) => setEditForm(f => ({ ...f, workout_type: e.target.value }))}
                            style={{ width: '80px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-medium)', borderRadius: '4px', padding: '2px 4px' }}>
                            <option value="">Auto</option>
                            <option value="Push">Push</option>
                            <option value="Pull">Pull</option>
                            <option value="Legs">Legs</option>
                            <option value="Cardio">Cardio</option>
                            <option value="Mixed">Mixed</option>
                          </select>
                        ) : (
                          d.workout_type ? <span className={`workout-pill ${d.workout_type.toLowerCase()}`}>{d.workout_type}</span> : <span className="empty">—</span>
                        )}
                      </td>
                      <td style={{ color: 'var(--accent-sky)' }}>
                        {isEditing ? (
                          <input type="number" step="0.1" value={editForm.weight_lbs} onChange={(e) => setEditForm(f => ({ ...f, weight_lbs: e.target.value }))}
                            style={{ width: '60px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-medium)', borderRadius: '4px', padding: '2px 4px' }} />
                        ) : (d.weight_lbs ? toDisplayWeight(d.weight_lbs) : <span className="empty">—</span>)}
                      </td>
                      <td style={{ color: 'var(--accent-sky)' }}>
                        {isEditing ? (
                          <input type="number" step="0.1" value={editForm.bf_pct} onChange={(e) => setEditForm(f => ({ ...f, bf_pct: e.target.value }))}
                            style={{ width: '55px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-medium)', borderRadius: '4px', padding: '2px 4px' }} />
                        ) : (d.bf_pct ? `${d.bf_pct}%` : <span className="empty">—</span>)}
                      </td>
                      </>}
                      {/* Vitals group (Google Health, read-only) */}
                      {collapsed.vitals ? (
                        <td className="group-divider collapsible-collapsed" />
                      ) : (() => {
                        const h = healthMap.get(d.date)
                        return <>
                        <td className="group-divider" style={{ color: 'var(--accent-sky)' }}>{h?.steps != null ? h.steps.toLocaleString() : <span className="empty">—</span>}</td>
                        <td style={{ color: rhrColor(h?.resting_hr ?? null) }}>{h?.resting_hr ?? <span className="empty">—</span>}</td>
                        <td style={{ color: 'var(--accent-violet)' }}>{h?.hrv_ms != null ? Math.round(h.hrv_ms) : <span className="empty">—</span>}</td>
                        <td style={{ color: 'var(--text-secondary)' }}>{h?.respiratory_rate != null ? h.respiratory_rate.toFixed(1) : <span className="empty">—</span>}</td>
                        </>
                      })()}
                      {/* Nutrition group */}
                      {collapsed.nutrition ? (
                        <td className="group-divider collapsible-collapsed" />
                      ) : <>
                      <MacroCell value={d.calories_in} target={t.calories} kind="cap" extremeOverAbsolute={1500} className="group-divider" />
                      <td style={{ color: 'var(--accent-emerald)' }}>
                        {isEditing ? (
                          <input type="number" step="10" value={editForm.est_active_burn} onChange={(e) => setEditForm(f => ({ ...f, est_active_burn: e.target.value }))} placeholder="kcal"
                            style={{ width: '60px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-medium)', borderRadius: '4px', padding: '2px 4px' }} />
                        ) : (d.est_active_burn ? Math.round(d.est_active_burn) : <span className="empty">—</span>)}
                      </td>
                      <MacroCell value={d.protein_g} target={t.protein_g} kind="minimum" />
                      <MacroCell value={d.carbs_g} target={t.carbs_g} kind="cap" />
                      <MacroCell value={d.fat_g} target={t.fat_g} kind="cap" />
                      <MacroCell value={d.fiber_g} target={t.fiber_g} kind="minimum" />
                      </>}
                      {/* Energy group */}
                      {collapsed.energy ? (
                        <td className="group-divider collapsible-collapsed" />
                      ) : <>
                      <td className="group-divider" style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                        {d.sedentary_tdee ? Math.round(d.sedentary_tdee).toLocaleString() : <span className="empty">—</span>}
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                        {d.cico_tdee ? Math.round(d.cico_tdee).toLocaleString() : <span className="empty">—</span>}
                      </td>
                      <td style={{ color: d.net_deficit > 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)', fontWeight: 500, fontSize: '0.82rem' }}>
                        {d.net_deficit ? <>{d.net_deficit > 0 ? '+' : ''}{Math.round(d.net_deficit).toLocaleString()}</> : <span className="empty">—</span>}
                      </td>
                      </>}
                      {/* Substances group */}
                      {collapsed.substances ? (
                        <td className="group-divider collapsible-collapsed" />
                      ) : <>
                      <td className="group-divider" style={{ color: getDrinkColor(d.drinks_consumed) }}>
                        {isEditing ? (
                          <input type="number" step="0.5" value={editForm.drinks_consumed} onChange={(e) => setEditForm(f => ({ ...f, drinks_consumed: e.target.value }))}
                            style={{ width: '45px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-medium)', borderRadius: '4px', padding: '2px 4px' }} />
                        ) : (d.drinks_consumed ? d.drinks_consumed : <span className="empty">—</span>)}
                      </td>
                      <td style={{ color: getHabitColor(d.habit_qty) }}>
                        {isEditing ? (
                          <input type="number" step="0.5" value={editForm.habit_qty} onChange={(e) => setEditForm(f => ({ ...f, habit_qty: e.target.value }))}
                            style={{ width: '45px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-medium)', borderRadius: '4px', padding: '2px 4px' }} />
                        ) : (d.habit_qty ? d.habit_qty : <span className="empty">—</span>)}
                      </td>
                      <td style={{ color: getCaffeineColor(d.caffeine_mg) }}>
                        {isEditing ? (
                          <input type="number" step="10" value={editForm.caffeine_mg} onChange={(e) => setEditForm(f => ({ ...f, caffeine_mg: e.target.value }))}
                            style={{ width: '55px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-medium)', borderRadius: '4px', padding: '2px 4px' }} />
                        ) : (d.caffeine_mg ? Math.round(d.caffeine_mg) : <span className="empty">—</span>)}
                      </td>
                      </>}
                      {/* Wellness group */}
                      {collapsed.wellness ? (
                        <td className="group-divider collapsible-collapsed" />
                      ) : <>
                      <td className="group-divider" style={{ color: d.sleep_hours != null && d.sleep_hours >= 7.5 ? 'var(--accent-violet)' : d.sleep_hours != null ? 'var(--accent-amber)' : undefined }}>
                        {isEditing ? (
                          <input type="number" step="0.5" value={editForm.sleep_hours} onChange={(e) => setEditForm(f => ({ ...f, sleep_hours: e.target.value }))}
                            style={{ width: '50px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-medium)', borderRadius: '4px', padding: '2px 4px' }} />
                        ) : (d.sleep_hours != null ? `${d.sleep_hours}h` : <span className="empty">—</span>)}
                      </td>
                      <td>
                        {isEditing ? (
                          <select value={editForm.mood} onChange={(e) => setEditForm(f => ({ ...f, mood: e.target.value }))}
                            style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-medium)', borderRadius: '4px', padding: '2px 4px' }}>
                            <option value="">—</option>
                            <option value="1 - Poor 😩">😩</option>
                            <option value="2 - Low 🔻">🔻</option>
                            <option value="3 - Neutral 😐">😐</option>
                            <option value="4 - Good 👍">👍</option>
                            <option value="5 - Excellent ✨">✨</option>
                          </select>
                        ) : <span className="mood-chip">{getMoodEmoji(d.mood)}</span>}
                      </td>
                      <td>
                        {isEditing ? (
                          <div style={{ display: 'flex', gap: '2px', justifyContent: 'center' }}>
                            {(['habit_workout', 'habit_clean', 'habit_productivity', 'habit_sleep', 'habit_love', 'habit_custom'] as const).map(hk => (
                              <input key={hk} type="checkbox" checked={!!(d as any)[hk]}
                                onChange={async () => {
                                  const newVal = !(d as any)[hk]
                                  setDaily(prev => prev.map(item => item.id === d.id ? { ...item, [hk]: newVal } : item))
                                  try { await updateDaily(d.date, { [hk]: newVal }) } catch { setDaily(prev => prev.map(item => item.id === d.id ? { ...item, [hk]: !newVal } : item)) }
                                }}
                                style={{ cursor: 'pointer', accentColor: 'var(--accent-indigo)', width: '14px', height: '14px' }}
                                title={hk.replace('habit_', '')}
                              />
                            ))}
                          </div>
                        ) : (
                          <span className={`habit-pill ${getHabitClass(habitScore)}`}>{habitScore}/6</span>
                        )}
                      </td>
                      </>}
                      {/* Notes + Actions */}
                      <td className="group-divider notes-cell">
                        {isEditing ? (
                          <input type="text" value={editForm.notes} onChange={(e) => setEditForm(f => ({ ...f, notes: e.target.value }))}
                            style={{ width: '100%', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-medium)', borderRadius: '4px', padding: '2px 4px' }} />
                        ) : (
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.notes || '—'}</div>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center', justifyContent: 'center' }}>
                          {photoDates.has(d.date) && (
                            <button onClick={() => setModalPhotoDate(d.date)} title="View progress photo"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.85rem', padding: '2px', color: 'var(--accent-indigo)', opacity: 0.8 }}>
                              📷
                            </button>
                          )}
                          {isEditing ? (
                            <>
                              <button className="action-btn duplicate" onClick={() => saveEdit(d)} title="Save" style={{ fontSize: '0.8rem' }}>✓</button>
                              <button className="action-btn delete" onClick={() => setEditingId(null)} title="Cancel" style={{ fontSize: '0.8rem' }}>✕</button>
                            </>
                          ) : (
                            <button className="edit-btn" onClick={() => startEdit(d)} title="Edit">✏️</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Progress Photo Modal */}
          {modalPhotoDate && (
            <div className="photo-modal-backdrop" onClick={() => setModalPhotoDate(null)}>
              <div className="photo-modal" onClick={e => e.stopPropagation()}>
                <button className="photo-modal-close" onClick={() => setModalPhotoDate(null)}>×</button>
                <p style={{ margin: '0 0 12px', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                  {displayDate(modalPhotoDate)}
                </p>
                {modalPhotoSrc ? (
                  <img src={modalPhotoSrc} alt="Progress photo"
                    style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain', borderRadius: 'var(--radius-md)', display: 'block' }} />
                ) : (
                  <div style={{ color: 'var(--text-muted)', padding: '60px 0', textAlign: 'center' }}>
                    <span className="loading-spinner" /> Loading...
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </>
  )
}
