/**
 * Dashboard — the PRIMARY page.
 * KPI strip, 3-column grid (nutrition | input+staging | stats+habits+schedule), daily recap.
 */

import { useState, useEffect, useCallback, useRef, type ComponentType } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  commitIntents, getRunningTotals, listMeals, getDashboardStats,
  listDaily, updateDaily, listWorkouts,
  uploadPhoto, listPhotos, fetchPhotoBlob, getTDEEInfo, getHabitsConfig, listTimeBlocks,
  getOverdueTasks,
  parseInputAsync, continueInputAsync,
  getCurrentUserRole, fetchSettings,
  getUpcomingDates,
  DEFAULT_HABIT_META,
  type ParsedIntent, type ParseResponse, type RunningTotals, type MealResponse, type DashboardStatsResponse, type MealItemData, type ProgressPhotoResponse, type TDEEInfoResponse, type TimeBlockResponse, type WorkoutResponse, type OverdueTask, type DailySummaryResponse, type ImportantDateResponse, type HabitMeta
} from '../api'
import { useContextJobs } from '../useContextJobs'
import { todayISO, toLocalISO } from '../dates'
import { proximityTier, countdownParts, formatDayLabel } from '../utils/important-dates-helpers'
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'
import { WorkoutIntentCard } from '../components/WorkoutIntentCard'

// Optional local-only widgets (see docs/superpowers/specs/2026-05-23-private-widget-design.md).
// Vite resolves this glob at build time; empty when _private/ is missing.
const privateModules = import.meta.glob('../_private/*Widget.tsx', { eager: true })
const PrivateWidget = (Object.values(privateModules)[0] as { default?: ComponentType } | undefined)?.default

// ==========================================
// Weather Helpers
// ==========================================
function getWeatherEmoji(code: number): string {
  if (code === 0) return '☀️'
  if (code >= 1 && code <= 3) return '⛅'
  if (code >= 45 && code <= 48) return '🌫️'
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return '🌧️'
  if (code >= 71 && code <= 77) return '❄️'
  if (code >= 95) return '⛈️'
  return '🌡️'
}

function getWeatherLabel(code: number): string {
  if (code === 0) return 'Clear'
  if (code >= 1 && code <= 3) return 'Partly Cloudy'
  if (code >= 45 && code <= 48) return 'Foggy'
  if (code >= 51 && code <= 55) return 'Drizzle'
  if (code >= 56 && code <= 57) return 'Freezing Drizzle'
  if (code >= 61 && code <= 65) return 'Rain'
  if (code >= 66 && code <= 67) return 'Freezing Rain'
  if (code >= 71 && code <= 75) return 'Snow'
  if (code >= 77 && code <= 77) return 'Snow Grains'
  if (code >= 80 && code <= 82) return 'Showers'
  if (code >= 95) return 'Thunderstorm'
  return 'Unknown'
}

function getWindDirection(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return dirs[Math.round(deg / 45) % 8]
}

interface WeatherData {
  emoji: string
  label: string
  tempC: number
  feelsLikeC: number
  humidity: number
  windKph: number
  windDir: string
  uvIndex: number
  highC: number
  lowC: number
  rainChance: number
  hourly: { hour: string; tempC: number; emoji: string }[]
}

// ==========================================
// Sparkline (mini chart for KPI backs)
// ==========================================
function MiniChart({ data, color, type = 'line', unit = '', label = '' }: {
  data: (number | null)[], color: string, type?: 'line' | 'bar', unit?: string, label?: string
}) {
  if (!data || data.length === 0) return null
  const hasData = data.some(v => v !== null && v !== 0)
  if (!hasData) return null

  const today = new Date()
  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const chartData = data
    .map((v, i) => {
      const d = new Date(today)
      d.setDate(d.getDate() - (data.length - 1 - i))
      return { day: dayLabels[d.getDay()], value: v, raw: v }
    })
    .filter(d => d.value !== null && d.value !== 0) as { day: string, value: number, raw: number }[]

  if (chartData.length === 0) return null

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.[0]) return null
    const d = payload[0].payload
    return (
      <div style={{
        background: 'rgba(10,14,23,0.95)', border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 8, padding: '6px 10px', fontSize: '0.7rem', fontFamily: 'var(--font-mono)',
      }}>
        <div style={{ color: 'var(--text-muted)', fontSize: '0.6rem', marginBottom: 2 }}>{d.day}</div>
        <div style={{ color, fontWeight: 700 }}>{d.value}{unit}</div>
      </div>
    )
  }

  const vals = chartData.map(d => d.value)
  const dataMin = Math.min(...vals)
  const dataMax = Math.max(...vals)
  const padding = (dataMax - dataMin) * 0.15 || 1

  if (type === 'bar') {
    return (
      <div style={{ width: '100%', height: '100%', minHeight: 60 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 4, right: 2, bottom: 0, left: 2 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
            <XAxis dataKey="day" tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
            <YAxis hide domain={[Math.floor(dataMin - padding), Math.ceil(dataMax + padding)]} />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
            <Bar dataKey="value" fill={color} radius={[3, 3, 0, 0]} opacity={0.8} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    )
  }

  return (
    <div style={{ width: '100%', height: '100%', minHeight: 60 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 4, right: 2, bottom: 0, left: 2 }}>
          <defs>
            <linearGradient id={`grad-${label}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
          <XAxis dataKey="day" tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
          <YAxis hide domain={[Math.floor(dataMin - padding), Math.ceil(dataMax + padding)]} />
          <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.1)' }} />
          <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill={`url(#grad-${label})`} dot={{ r: 3, fill: color, stroke: 'none' }} activeDot={{ r: 5, fill: color, stroke: '#fff', strokeWidth: 1.5 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// ==========================================
// Top Bar (date, time, weather, photo)
// ==========================================
function TopBar({ photoToday, todayPhotoSrc, onPhotoClick }: {
  photoToday: ProgressPhotoResponse | null
  todayPhotoSrc: string | null
  onPhotoClick: () => void
}) {
  const [weather, setWeather] = useState<WeatherData | null>(null)
  const [weatherError, setWeatherError] = useState<string>('')
  const [timeStr, setTimeStr] = useState<string>('')

  useEffect(() => {
    const updateTime = () => setTimeStr(new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))
    updateTime()
    const timer = setInterval(updateTime, 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          try {
            const { latitude, longitude } = position.coords
            const params = [
              `latitude=${latitude}`,
              `longitude=${longitude}`,
              `current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m`,
              `hourly=temperature_2m,weather_code,precipitation_probability`,
              `daily=temperature_2m_max,temperature_2m_min,uv_index_max,precipitation_probability_max`,
              `temperature_unit=celsius`,
              `wind_speed_unit=kmh`,
              `timezone=auto`,
              `forecast_days=1`,
            ].join('&')
            const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`)
            const data = await res.json()

            const currentHour = new Date().getHours()
            // Build 6-hour mini forecast from current hour
            const hourlyForecast: WeatherData['hourly'] = []
            for (let i = 0; i < 6; i++) {
              const idx = currentHour + i
              if (idx < (data.hourly?.temperature_2m?.length ?? 0)) {
                const h = idx % 24
                hourlyForecast.push({
                  hour: i === 0 ? 'Now' : `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`,
                  tempC: Math.round(data.hourly.temperature_2m[idx]),
                  emoji: getWeatherEmoji(data.hourly.weather_code[idx]),
                })
              }
            }

            // Max rain chance in next 6 hours
            let rainChance = 0
            for (let i = 0; i < 6; i++) {
              const idx = currentHour + i
              const prob = data.hourly?.precipitation_probability?.[idx] ?? 0
              if (prob > rainChance) rainChance = prob
            }

            setWeather({
              emoji: getWeatherEmoji(data.current.weather_code),
              label: getWeatherLabel(data.current.weather_code),
              tempC: Math.round(data.current.temperature_2m),
              feelsLikeC: Math.round(data.current.apparent_temperature),
              humidity: Math.round(data.current.relative_humidity_2m),
              windKph: Math.round(data.current.wind_speed_10m),
              windDir: getWindDirection(data.current.wind_direction_10m),
              uvIndex: Math.round(data.daily.uv_index_max[0]),
              highC: Math.round(data.daily.temperature_2m_max[0]),
              lowC: Math.round(data.daily.temperature_2m_min[0]),
              rainChance,
              hourly: hourlyForecast,
            })
          } catch {
            setWeatherError('Weather unavailable')
          }
        },
        () => setWeatherError('Location disabled')
      )
    }
  }, [])

  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div className="topbar">
      <div className="topbar-left">
        <h1>{dateStr}</h1>
        <div className="topbar-sub">
          <span>{timeStr}</span>
          {weather && (
            <>
              <span>·</span>
              <span>{weather.emoji} {weather.tempC}°C {weather.label}</span>
              <span>·</span>
              <span>H {weather.highC}° L {weather.lowC}°</span>
              <span>·</span>
              <span>UV {weather.uvIndex}</span>
            </>
          )}
          {weatherError && <><span>·</span><span>{weatherError}</span></>}
        </div>
      </div>
      <div className="topbar-right">
        <button className="photo-av" onClick={onPhotoClick} title={photoToday ? 'Retake photo' : 'Add progress photo'}>
          {todayPhotoSrc ? (
            <img src={todayPhotoSrc} alt="Today" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
          ) : (
            <span>📷</span>
          )}
        </button>
      </div>
    </div>
  )
}

// ==========================================
// KPI Strip (6 cards, 3 flippable)
// ==========================================
function KPIStrip({ stats, totals, flippedCards, toggleFlip }: {
  stats: DashboardStatsResponse | null
  totals: RunningTotals | null
  flippedCards: Record<string, boolean>
  toggleFlip: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
}) {
  if (!stats) return null
  const toggleCard = (key: string) => toggleFlip(prev => ({ ...prev, [key]: !prev[key] }))

  const weightDelta = stats.avg_weight_7d ?? 0
  const weightDown = weightDelta <= 0

  return (
    <div className="kpi-strip">
      {/* Weight -- flippable */}
      <div className={`kpi-flip${flippedCards.weight ? ' flipped' : ''}`} onClick={() => toggleCard('weight')}>
        <div className="kpi" style={{ position: 'relative' }}>
          <div className="kpi-front">
            <div className="kpi-value">{stats.current_weight ?? '—'}</div>
            <div className="kpi-label">Weight (lbs)</div>
            <div className="kpi-delta" style={{ color: weightDown ? 'var(--accent-emerald)' : 'var(--accent-rose)' }}>
              {weightDown ? '▼' : '▲'} {Math.abs(weightDelta).toFixed(1)} this wk
            </div>
            {stats.weight_lost_total != null && (
              <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: '0.55rem' }}>
                <span style={{ color: 'var(--accent-emerald)' }}>▼ {stats.weight_lost_total} lost</span>
                <span style={{ color: 'var(--text-muted)' }}>{stats.weight_remaining} to go</span>
              </div>
            )}
          </div>
          <div className="kpi-back">
            <div className="kpi-back-label">Weight 7d <span>click to flip</span></div>
            <div className="kpi-back-chart">
              <MiniChart data={stats.weight_sparkline ?? []} color="var(--accent-emerald)" type="line" unit=" lbs" label="weight" />
            </div>
          </div>
        </div>
      </div>

      {/* TDEE -- static */}
      <div>
        <div className="kpi">
          <div className="kpi-value" style={{ color: 'var(--accent-amber)' }}>{stats.tdee_cico != null ? Math.round(stats.tdee_cico).toLocaleString() : '—'}</div>
          <div className="kpi-label">TDEE</div>
          <div className="kpi-delta" style={{ color: 'var(--text-muted)' }}>cico</div>
          {stats.tdee_sedentary != null && (
            <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border-subtle)', fontFamily: 'var(--font-mono)', fontSize: '0.55rem', color: 'var(--text-muted)' }}>
              sed. {Math.round(stats.tdee_sedentary).toLocaleString()}
            </div>
          )}
        </div>
      </div>

      {/* Weekly Deficit -- flippable */}
      <div className={`kpi-flip${flippedCards.deficit ? ' flipped' : ''}`} onClick={() => toggleCard('deficit')}>
        <div className="kpi" style={{ position: 'relative' }}>
          <div className="kpi-front">
            <div className="kpi-value" style={{ color: stats.weekly_deficit > 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)' }}>
              {Math.round(stats.weekly_deficit).toLocaleString()}
            </div>
            <div className="kpi-label">Weekly Deficit</div>
            <div className="kpi-delta" style={{ color: stats.weekly_deficit > 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)' }}>
              {stats.weekly_deficit > 0 ? 'on track' : 'over'}
            </div>
            {stats.deficit_lbs_weekly != null && (
              <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border-subtle)', fontFamily: 'var(--font-mono)', fontSize: '0.55rem', color: 'var(--text-muted)' }}>
                ≈ {Math.abs(stats.deficit_lbs_weekly).toFixed(1)} lbs this week
              </div>
            )}
          </div>
          <div className="kpi-back">
            <div className="kpi-back-label">Daily Deficit 7d <span>click to flip</span></div>
            <div className="kpi-back-chart">
              <MiniChart data={stats.deficit_sparkline ?? []} color="var(--accent-emerald)" type="line" unit=" cal" label="deficit" />
            </div>
          </div>
        </div>
      </div>

      {/* Sleep -- flippable */}
      <div className={`kpi-flip${flippedCards.sleep ? ' flipped' : ''}`} onClick={() => toggleCard('sleep')}>
        <div className="kpi" style={{ position: 'relative' }}>
          <div className="kpi-front">
            <div className="kpi-value">
              {totals?.sleep_hours ?? '—'}<span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>h</span>
            </div>
            <div className="kpi-label">Sleep</div>
            <div className="kpi-delta" style={{ color: 'var(--text-muted)' }}>
              {stats.sleep_bedtime && stats.sleep_waketime
                ? `${stats.sleep_bedtime} → ${stats.sleep_waketime}`
                : '—'}
            </div>
            {stats.sleep_avg_7d != null && (
              <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border-subtle)', fontFamily: 'var(--font-mono)', fontSize: '0.55rem', color: 'var(--text-muted)' }}>
                avg {stats.sleep_avg_7d.toFixed(1)}h this wk
              </div>
            )}
          </div>
          <div className="kpi-back">
            <div className="kpi-back-label">Sleep 7d <span>click to flip</span></div>
            <div className="kpi-back-chart">
              <MiniChart data={stats.sleep_sparkline ?? []} color="var(--accent-violet)" type="bar" unit="h" label="sleep" />
            </div>
          </div>
        </div>
      </div>

      {/* Resting HR -- flippable */}
      <div className={`kpi-flip${flippedCards.rhr ? ' flipped' : ''}`} onClick={() => toggleCard('rhr')}>
        <div className="kpi" style={{ position: 'relative' }}>
          <div className="kpi-front">
            <div className="kpi-value" style={{ color: 'var(--accent-emerald)' }}>{stats.resting_hr ?? '—'}</div>
            <div className="kpi-label">Resting HR</div>
            <div className="kpi-delta" style={{ color: 'var(--text-muted)' }}>
              {stats.resting_hr != null && stats.resting_hr_avg_7d != null
                ? `${stats.resting_hr <= stats.resting_hr_avg_7d ? '▼' : '▲'} vs ${stats.resting_hr_avg_7d} avg`
                : 'bpm'}
            </div>
          </div>
          <div className="kpi-back">
            <div className="kpi-back-label">Resting HR 7d <span>click to flip</span></div>
            <div className="kpi-back-chart">
              <MiniChart data={stats.rhr_sparkline ?? []} color="var(--accent-emerald)" type="line" unit=" bpm" label="rhr" />
            </div>
          </div>
        </div>
      </div>

      {/* HRV -- flippable */}
      <div className={`kpi-flip${flippedCards.hrv ? ' flipped' : ''}`} onClick={() => toggleCard('hrv')}>
        <div className="kpi" style={{ position: 'relative' }}>
          <div className="kpi-front">
            <div className="kpi-value" style={{ color: 'var(--accent-violet)' }}>
              {stats.hrv_ms != null ? Math.round(stats.hrv_ms) : '—'}<span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>ms</span>
            </div>
            <div className="kpi-label">HRV</div>
            <div className="kpi-delta" style={{ color: 'var(--text-muted)' }}>
              {stats.hrv_ms != null && stats.hrv_avg_7d != null
                ? `${stats.hrv_ms >= stats.hrv_avg_7d ? '▲' : '▼'} vs ${Math.round(stats.hrv_avg_7d)} avg`
                : 'rmssd'}
            </div>
          </div>
          <div className="kpi-back">
            <div className="kpi-back-label">HRV 7d <span>click to flip</span></div>
            <div className="kpi-back-chart">
              <MiniChart data={stats.hrv_sparkline ?? []} color="var(--accent-violet)" type="line" unit=" ms" label="hrv" />
            </div>
          </div>
        </div>
      </div>

      {/* Log Streak -- static */}
      <div>
        <div className="kpi">
          <div className="kpi-value" style={{ color: 'var(--accent-amber)' }}>{stats.meal_streak}</div>
          <div className="kpi-label">Log Streak</div>
          <div className="kpi-delta" style={{ color: 'var(--text-muted)' }}>days</div>
        </div>
      </div>

      {/* Workout Streak -- static */}
      <div>
        <div className="kpi">
          <div className="kpi-value">{stats.workout_streak}</div>
          <div className="kpi-label">Workout Streak</div>
          <div className="kpi-delta">
            <span style={{ color: 'var(--accent-rose)' }}>P{stats.weekly_push}</span>{' '}
            <span style={{ color: 'var(--accent-sky)' }}>Pu{stats.weekly_pull}</span>{' '}
            <span style={{ color: 'var(--accent-emerald)' }}>L{stats.weekly_legs}</span>
          </div>
          {stats.today_workout_target && (
            <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border-subtle)', fontFamily: 'var(--font-mono)', fontSize: '0.62rem', fontWeight: 600, color: 'var(--accent-indigo)' }}>
              🎯 {stats.today_workout_target}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ==========================================
// Phase Pill (renders above the calorie ring)
// ==========================================
function PhasePill({ totals }: { totals: RunningTotals }) {
  if (!totals.phase_type) {
    return (
      <div className="phase-pill phase-pill-empty">
        No active phase · <a href="/helm/phases">Set one →</a>
      </div>
    );
  }
  const typeLabel = totals.phase_type.charAt(0).toUpperCase() + totals.phase_type.slice(1);
  if (totals.in_refeed) {
    return (
      <div className="phase-pill phase-pill-refeed">
        {typeLabel} · Day {totals.phase_day} · 🍔 Refeed Day {totals.refeed_day} of{' '}
        {totals.refeed_total_days} · {totals.calorie_target} cal target
      </div>
    );
  }
  return (
    <div className="phase-pill">
      {typeLabel} · Day {totals.phase_day} · {totals.calorie_target} cal target
    </div>
  );
}

// ==========================================
// Nutrition Panel (calorie ring + macro rings)
// ==========================================
function NutritionPanel({ totals }: { totals: RunningTotals | null }) {
  if (!totals) return null

  const calCircumference = 2 * Math.PI * 50 // r=50 in viewBox 120
  const calRaw = totals.calorie_target > 0 ? totals.calories_in / totals.calorie_target : 0
  const calBase = Math.min(calRaw, 1)
  const calOverflow = Math.max(0, calRaw - 1)
  const calOffset = calCircumference * (1 - calBase)
  const calOverflowOffset = calCircumference * (1 - Math.min(calOverflow, 1))
  const remaining = totals.calorie_target - totals.calories_in
  const isOver = remaining < 0

  const macroCircumference = 2 * Math.PI * 28 // r=28 in viewBox 72
  const macros = [
    { label: 'Protein', value: totals.protein_g, target: totals.protein_target, color: 'var(--accent-indigo)' },
    { label: 'Carbs', value: totals.carbs_g, target: totals.carbs_target, color: 'var(--accent-sky)' },
    { label: 'Fat', value: totals.fat_g, target: totals.fat_target, color: 'var(--accent-rose)' },
    { label: 'Fiber', value: totals.fiber_g, target: totals.fiber_target, color: 'var(--accent-emerald)' },
  ]

  return (
    <div className="nutrition-card">
      {/* SVG gradient definition */}
      <svg width="0" height="0">
        <defs>
          <linearGradient id="cg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#f59e0b" />
            <stop offset="50%" stopColor="#f97316" />
            <stop offset="100%" stopColor="#f43f5e" />
          </linearGradient>
        </defs>
      </svg>

      <PhasePill totals={totals} />

      {/* Calorie Ring */}
      <div className="cal-ring-wrap">
        <svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r={50} className="cal-track-sh" />
          <circle cx="60" cy="60" r={50} className="cal-track" />
          <circle cx="60" cy="60" r={50} className="cal-glow" />
          <circle
            cx="60" cy="60" r={50}
            className="cal-prog"
            style={{
              strokeDasharray: calCircumference,
              strokeDashoffset: calOffset,
            }}
          />
          {calOverflow > 0 && (
            <circle
              cx="60" cy="60" r={50}
              className="cal-overflow"
              style={{
                strokeDasharray: calCircumference,
                strokeDashoffset: calOverflowOffset,
              }}
            />
          )}
        </svg>
        <div className="cal-center">
          <span className="cal-emoji">🔥</span>
          <span className="cal-val">{Math.round(totals.calories_in).toLocaleString()}</span>
          <span className="cal-sub">kcal</span>
        </div>
      </div>

      <div className="cal-remain" style={{ color: isOver ? 'var(--accent-rose)' : 'var(--accent-emerald)', background: isOver ? 'rgba(244,63,94,0.08)' : undefined, borderColor: isOver ? 'rgba(244,63,94,0.2)' : undefined }}>
        {isOver ? `${Math.abs(Math.round(remaining))} over` : `${Math.round(remaining)} remaining`}
      </div>

      {/* Macro Rings */}
      <div className="macro-rings">
        {macros.map(m => {
          const raw = m.target > 0 ? m.value / m.target : 0
          const base = Math.min(raw, 1)
          const overflow = Math.max(0, raw - 1)
          const offset = macroCircumference * (1 - base)
          const overflowOffset = macroCircumference * (1 - Math.min(overflow, 1))
          const diff = Math.round(m.target - m.value)
          const overLabel = diff < 0 ? `${Math.abs(diff)}g over` : `${diff}g left`
          return (
            <div key={m.label} className="macro-ring-item">
              <div className="macro-ring-wrap">
                <svg viewBox="0 0 72 72">
                  <circle cx="36" cy="36" r={28} className="mr-track" />
                  <circle cx="36" cy="36" r={28} className="mr-prog" stroke={m.color} strokeDasharray={macroCircumference} strokeDashoffset={offset} />
                  {overflow > 0 && (
                    <circle cx="36" cy="36" r={28} className="mr-overflow" stroke={m.color} strokeDasharray={macroCircumference} strokeDashoffset={overflowOffset} />
                  )}
                </svg>
                <div className="macro-ring-center">
                  <span className="macro-ring-val" style={{ color: m.color }}>{Math.round(m.value)}</span>
                  <span className="macro-ring-unit">grams</span>
                </div>
              </div>
              <span className="macro-ring-label">{m.label}</span>
              <span className="macro-ring-remain" style={{ color: diff < 0 ? 'var(--accent-rose)' : m.color }}>{overLabel}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ==========================================
// Schedule (Up Next) for right column
// ==========================================
function SchedulePanel({ blocks }: { blocks: TimeBlockResponse[] }) {
  const navigate = useNavigate()
  const now = new Date()
  const currentMinutes = now.getHours() * 60 + now.getMinutes()

  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number)
    return h * 60 + m
  }

  const sorted = [...blocks].sort((a, b) => toMin(a.start_time) - toMin(b.start_time))
  const upcoming = sorted.filter(b => toMin(b.end_time) > currentMinutes - 60)
  const display = upcoming.slice(0, 4)

  if (display.length === 0) return null

  const effectiveStatus = (b: TimeBlockResponse) => b.auto_status || b.status

  return (
    <div className="dash-sched">
      <div className="dash-sched-head">
        <span className="dash-sched-title">Up Next</span>
        <a className="dash-sched-link" href="#" onClick={(e) => { e.preventDefault(); navigate('/schedule') }}>Schedule →</a>
      </div>
      {display.map(block => {
        const startMin = toMin(block.start_time)
        const endMin = toMin(block.end_time)
        const isActive = currentMinutes >= startMin && currentMinutes < endMin
        const isDone = effectiveStatus(block) === 'done'
        const isPast = endMin <= currentMinutes && !isDone

        return (
          <div
            key={block.id}
            className={`dash-block${isActive ? ' now' : ''}${isDone || isPast ? ' past' : ''}`}
            style={{ borderLeftColor: `var(--accent-${block.color || 'indigo'})`, opacity: isDone || isPast ? 0.5 : 1 }}
          >
            <span className="dash-block-time">{block.start_time} – {block.end_time}</span>
            <span className="dash-block-name">{block.name}</span>
            {isActive && <span className="dash-block-now">Now</span>}
          </div>
        )
      })}
    </div>
  )
}

// ==========================================
// Important Dates (Upcoming) for right column
// ==========================================
// Curated birthdays/anniversaries surfaced as a warm countdown. Each row's
// accent "heats up" as the date nears (rose → orange → amber → indigo) and the
// soonest entry leads since the backend returns days_until sorted ascending.
function ImportantDatesPanel() {
  const [dates, setDates] = useState<ImportantDateResponse[]>([])

  useEffect(() => {
    getUpcomingDates().then(setDates).catch(() => {})
  }, [])

  if (dates.length === 0) return null

  return (
    <div className="updates-card">
      <div className="updates-head">
        <span className="updates-title">
          <span className="updates-title-glyph">🎂</span> Upcoming
        </span>
        <span className="updates-count">{dates.length}</span>
      </div>
      <div className="updates-list">
        {dates.map((d, i) => {
          const tier = proximityTier(d.days_until)
          const { big, small } = countdownParts(d.days_until)
          return (
            <div
              key={`${d.name}-${d.date}-${i}`}
              className={`upd-row upd-${tier}`}
              style={{ animationDelay: `${i * 70}ms` }}
            >
              <span className="upd-emoji">{d.emoji}</span>
              <div className="upd-info">
                <span className="upd-name">{d.name}</span>
                <span className="upd-date">{formatDayLabel(d.date)}</span>
              </div>
              <div className="upd-badge" aria-label={`${big} ${small}`}>
                <span className="upd-badge-big">{big}</span>
                <span className="upd-badge-small">{small}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ==========================================
// Daily Recap (collapsible meals + workout)
// ==========================================
function DailyRecap({ meals, workouts, recapOpen, setRecapOpen, workoutType }: {
  meals: MealResponse[]
  workouts: WorkoutResponse[]
  recapOpen: boolean
  setRecapOpen: (v: boolean) => void
  workoutType: string | null
}) {
  if (meals.length === 0 && workouts.length === 0) return null

  const totalMealCal = meals.reduce((sum, m) => sum + m.calories, 0)
  const totalSets = workouts.length

  // Group workouts by muscle group
  const groups: Record<string, WorkoutResponse[]> = {}
  for (const w of workouts) {
    const key = w.targeted_muscle_group || w.category || 'Other'
    if (!groups[key]) groups[key] = []
    groups[key].push(w)
  }

  const workoutTypeLabel = workoutType ?? ''

  // Category colors
  const catColor: Record<string, string> = {
    'Chest': 'var(--accent-rose)', 'Delts': 'var(--accent-rose)', 'Shoulders': 'var(--accent-rose)',
    'Triceps': 'var(--accent-rose)', 'Back': 'var(--accent-sky)', 'Biceps': 'var(--accent-sky)',
    'Quads': 'var(--accent-emerald)', 'Hamstrings': 'var(--accent-emerald)', 'Glutes': 'var(--accent-emerald)',
    'Core': 'var(--accent-amber)', 'Cardio': 'var(--accent-orange)',
  }

  return (
    <div className="dash-recap">
      <div className="dash-recap-head" onClick={() => setRecapOpen(!recapOpen)}>
        <div className="dash-recap-title">{recapOpen ? '▼' : '▶'} Today's Activity</div>
        <div className="dash-recap-meta">
          {meals.length > 0 && <>{meals.length} meal{meals.length !== 1 ? 's' : ''} · {Math.round(totalMealCal).toLocaleString()} cal</>}
          {meals.length > 0 && workouts.length > 0 && ' | '}
          {workouts.length > 0 && <>{workoutTypeLabel && `${workoutTypeLabel}: `}{Object.keys(groups).length} group{Object.keys(groups).length !== 1 ? 's' : ''} · {totalSets} sets</>}
        </div>
      </div>
      {recapOpen && (
        <div className="dash-recap-body">
          {/* Meals panel */}
          <div className="dash-recap-panel">
            <div className="dash-recap-plabel">
              <span>🍽️ Meals</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.58rem' }}>{Math.round(totalMealCal).toLocaleString()} cal</span>
            </div>
            {meals.map(meal => (
              <div key={meal.id} className="dash-mi">
                <div className="dash-mi-dot" />
                <div className="dash-mi-body">
                  <div className="dash-mi-name">{meal.meal}</div>
                  <div className="dash-mi-desc">{meal.description}</div>
                  <div className="dash-mi-mac">
                    <span className="mp">{Math.round(meal.protein_g)}P</span>
                    <span className="mc">{Math.round(meal.carbs_g)}C</span>
                    <span className="mf">{Math.round(meal.fat_g)}F</span>
                    {meal.fiber_g > 0 && <span className="mfib">{Math.round(meal.fiber_g)}Fib</span>}
                  </div>
                </div>
                <span className="dash-mi-cal">{Math.round(meal.calories)}</span>
              </div>
            ))}
            {meals.length === 0 && (
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', padding: '8px 0' }}>No meals logged yet</div>
            )}
          </div>

          {/* Workout panel */}
          <div className="dash-recap-panel">
            <div className="dash-recap-plabel">
              <span>🏋️ Workout{workoutTypeLabel ? ` — ${workoutTypeLabel}` : ''}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.58rem' }}>{totalSets} sets</span>
            </div>
            {workouts.length > 0 && (
              <>
                {/* Muscle distribution bar */}
                <div className="dash-vbar">
                  {Object.entries(groups).map(([grp, exs]) => (
                    <div key={grp} className="dash-vseg" style={{ width: `${(exs.length / totalSets) * 100}%`, background: catColor[grp] || 'var(--accent-indigo)' }} />
                  ))}
                </div>
                {Object.entries(groups).map(([grp, exs]) => (
                  <div key={grp} className="dash-wg">
                    <div className="dash-wg-head">
                      <div className="dash-wg-dot" style={{ background: catColor[grp] || 'var(--accent-indigo)' }} />
                      <span className="dash-wg-name">{grp}</span>
                      <span className="dash-wg-sets">{exs.length} sets</span>
                    </div>
                    {exs.map((ex, idx) => (
                      <div key={idx} className="dash-wex">
                        <span className="dash-wex-name">{ex.exercise}</span>
                        <div className="dash-wex-tags">
                          {ex.weight_lbs && <span className="dash-wex-t dash-tw"><span className="dash-tl">W</span>{ex.weight_lbs}</span>}
                          {ex.reps_sets && <span className="dash-wex-t dash-tr"><span className="dash-tl">R</span>{ex.reps_sets}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </>
            )}
            {workouts.length === 0 && (
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', padding: '8px 0' }}>No workout logged yet</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}


// ==========================================
// Preview Card
// ==========================================
function PreviewCard({
  intent,
  onConfirm,
  onDiscard,
  onChange,
  meta = DEFAULT_HABIT_META,
}: {
  intent: ParsedIntent
  onConfirm: (modifiedIntent: ParsedIntent) => void
  onDiscard: () => void
  onChange?: (modifiedIntent: ParsedIntent) => void
  meta?: HabitMeta
}) {
  const [draft, setDraft] = useState<ParsedIntent>(intent)

  // Propagate edits to parent so "Confirm All" uses latest values
  useEffect(() => { onChange?.(draft) }, [draft])

  const typeEmoji: Record<string, string> = { meal: '🍽️', workout: '🏋️', weight: '⚖️', habit: meta.emoji, caffeine: '☕', mood: '🎭', note: '📝', sleep: '😴' }
  const typeLabel: Record<string, string> = { meal: 'Meal', workout: 'Workout', weight: 'Weight', habit: meta.label, caffeine: 'Caffeine', mood: 'Mood', note: 'Note', sleep: 'Sleep' }

  // Recalculate totals if meal items change
  const handleItemChange = (idx: number, field: keyof MealItemData, value: any) => {
    if (!draft.meal_data || !draft.meal_data.items) return
    const newItems = [...draft.meal_data.items]
    newItems[idx] = { ...newItems[idx], [field]: value }

    // Auto-sum
    const cal = newItems.reduce((acc, curr) => acc + (Number(curr.calories) || 0), 0)
    const pro = newItems.reduce((acc, curr) => acc + (Number(curr.protein_g) || 0), 0)
    const car = newItems.reduce((acc, curr) => acc + (Number(curr.carbs_g) || 0), 0)
    const fat = newItems.reduce((acc, curr) => acc + (Number(curr.fat_g) || 0), 0)
    const fib = newItems.reduce((acc, curr) => acc + (Number(curr.fiber_g) || 0), 0)

    setDraft({
      ...draft,
      meal_data: {
        ...draft.meal_data,
        items: newItems,
        calories: cal,
        protein_g: pro,
        carbs_g: car,
        fat_g: fat,
        fiber_g: fib
      }
    })
  }

  const handleMacroChange = (field: keyof typeof draft.meal_data, value: number) => {
    if (!draft.meal_data) return
    setDraft({
      ...draft,
      meal_data: {
        ...draft.meal_data,
        [field]: value
      }
    })
  }

  return (
    <div className={`preview-card ${draft.type}`}>
      <div className="preview-card-header">
        <span className="preview-card-type" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {typeEmoji[draft.type]} {typeLabel[draft.type]}

          {/* Editable Date */}
          <input
            type="date"
            value={draft.date || ''}
            onChange={(e) => setDraft({ ...draft, date: e.target.value })}
            style={{
              background: 'transparent',
              border: '1px solid var(--border-medium)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              fontSize: '0.8rem',
              fontWeight: 500,
              padding: '2px 6px',
              marginLeft: '4px'
            }}
          />

          {draft.confidence < 0.7 && (
            <span className={`confidence-badge ${draft.confidence < 0.4 ? 'low' : 'medium'}`} style={{ marginLeft: '6px' }}>
              {(draft.confidence * 100).toFixed(0)}%
            </span>
          )}
        </span>
        <div className="preview-card-actions">
          <button className="confirm" onClick={() => onConfirm(draft)} title="Confirm">✓</button>
          <button className="discard" onClick={onDiscard} title="Discard">✕</button>
        </div>
      </div>

      <div className="preview-card-body">
        {draft.type === 'meal' && draft.meal_data && (
          <>
            <div>
              <input
                type="text"
                value={draft.meal_data.meal}
                onChange={e => setDraft({ ...draft, meal_data: { ...draft.meal_data!, meal: e.target.value } })}
                style={{ fontWeight: 'bold', background: 'transparent', border: 'none', borderBottom: '1px dashed var(--border-medium)', color: 'var(--text-primary)', width: '80px', marginRight: '8px' }}
              />
              —
              <input
                type="text"
                value={draft.meal_data.description}
                onChange={e => setDraft({ ...draft, meal_data: { ...draft.meal_data!, description: e.target.value } })}
                style={{ background: 'transparent', border: 'none', borderBottom: '1px dashed var(--border-medium)', color: 'var(--text-primary)', width: '200px', marginLeft: '8px' }}
              />
            </div>

            {draft.meal_data.resolved_from && (
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 4 }}>
                ↳ Resolved from {draft.meal_data.resolved_from}
              </div>
            )}

            {/* Detailed Items Table */}
            {draft.meal_data.items && draft.meal_data.items.length > 0 && (
              <div style={{ marginTop: '12px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse', textAlign: 'left' }}>
                  <thead style={{ background: 'var(--bg-secondary)' }}>
                    <tr>
                      <th style={{ padding: '4px 8px', fontWeight: 600 }}>Item</th>
                      <th style={{ padding: '4px 8px', fontWeight: 600 }}>Qty</th>
                      <th style={{ padding: '4px 8px', fontWeight: 600 }}>Cal</th>
                      <th style={{ padding: '4px 8px', fontWeight: 600 }}>P(g)</th>
                      <th style={{ padding: '4px 8px', fontWeight: 600 }}>C(g)</th>
                      <th style={{ padding: '4px 8px', fontWeight: 600 }}>F(g)</th>
                      <th style={{ padding: '4px 8px', fontWeight: 600 }}>Fib</th>
                      <th style={{ padding: '4px 8px', fontWeight: 600, width: 24 }}></th>
                      <th style={{ padding: '4px 8px', fontWeight: 600 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.meal_data.items.map((it, idx) => (
                      <tr key={idx} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                        <td style={{ padding: '4px 8px' }}>
                          <input type="text" value={it.name} onChange={e => handleItemChange(idx, 'name', e.target.value)} style={{ width: '180px', background: 'transparent', border: 'none', color: 'var(--text-primary)' }} />
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          <input type="text" value={it.quantity} onChange={e => handleItemChange(idx, 'quantity', e.target.value)} style={{ width: '100px', background: 'transparent', border: 'none', color: 'var(--text-primary)' }} />
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          <input type="number" value={it.calories} onChange={e => handleItemChange(idx, 'calories', parseFloat(e.target.value))} style={{ width: '40px', background: 'transparent', border: 'none', color: 'var(--text-primary)' }} />
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          <input type="number" value={it.protein_g} onChange={e => handleItemChange(idx, 'protein_g', parseFloat(e.target.value))} style={{ width: '30px', background: 'transparent', border: 'none', color: 'var(--text-primary)' }} />
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          <input type="number" value={it.carbs_g} onChange={e => handleItemChange(idx, 'carbs_g', parseFloat(e.target.value))} style={{ width: '30px', background: 'transparent', border: 'none', color: 'var(--text-primary)' }} />
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          <input type="number" value={it.fat_g} onChange={e => handleItemChange(idx, 'fat_g', parseFloat(e.target.value))} style={{ width: '30px', background: 'transparent', border: 'none', color: 'var(--text-primary)' }} />
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          <input type="number" value={it.fiber_g} onChange={e => handleItemChange(idx, 'fiber_g', parseFloat(e.target.value))} style={{ width: '30px', background: 'transparent', border: 'none', color: 'var(--text-primary)' }} />
                        </td>
                        <td style={{ padding: '4px 4px' }}>
                          {it.confidence != null && (
                            <span
                              className={`confidence-dot ${it.confidence > 0.7 ? 'high' : it.confidence >= 0.4 ? 'medium' : 'low'}`}
                              title={`${(it.confidence * 100).toFixed(0)}% — ${it.confidence_reason || 'unknown'}`}
                            />
                          )}
                        </td>
                        <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                          <button
                            style={{ background: 'none', border: 'none', color: 'var(--accent-rose)', cursor: 'pointer', fontSize: '14px', padding: '0 4px' }}
                            onClick={() => {
                              const newItems = draft.meal_data!.items!.filter((_, i) => i !== idx);
                              const cal = newItems.reduce((acc, curr) => acc + (Number(curr.calories) || 0), 0)
                              const pro = newItems.reduce((acc, curr) => acc + (Number(curr.protein_g) || 0), 0)
                              const car = newItems.reduce((acc, curr) => acc + (Number(curr.carbs_g) || 0), 0)
                              const fat = newItems.reduce((acc, curr) => acc + (Number(curr.fat_g) || 0), 0)
                              const fib = newItems.reduce((acc, curr) => acc + (Number(curr.fiber_g) || 0), 0)
                              setDraft({
                                ...draft,
                                meal_data: { ...draft.meal_data!, items: newItems, calories: cal, protein_g: pro, carbs_g: car, fat_g: fat, fiber_g: fib }
                              })
                            }}
                          >✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Total Macros */}
            <div className="macro-row" style={{ marginTop: '12px' }}>
              <span className="macro-item cal">
                <input type="number" value={Math.round(draft.meal_data.calories)} onChange={e => handleMacroChange('calories' as never, parseFloat(e.target.value))} style={{ width: '40px', background: 'transparent', border: 'none', color: 'inherit', fontWeight: 'bold' }} /> cal
              </span>
              <span className="macro-item protein">
                <input type="number" value={Math.round(draft.meal_data.protein_g)} onChange={e => handleMacroChange('protein_g' as never, parseFloat(e.target.value))} style={{ width: '30px', background: 'transparent', border: 'none', color: 'inherit', fontWeight: 'bold' }} />g P
              </span>
              <span className="macro-item carbs">
                <input type="number" value={Math.round(draft.meal_data.carbs_g)} onChange={e => handleMacroChange('carbs_g' as never, parseFloat(e.target.value))} style={{ width: '30px', background: 'transparent', border: 'none', color: 'inherit', fontWeight: 'bold' }} />g C
              </span>
              <span className="macro-item fat">
                <input type="number" value={Math.round(draft.meal_data.fat_g)} onChange={e => handleMacroChange('fat_g' as never, parseFloat(e.target.value))} style={{ width: '30px', background: 'transparent', border: 'none', color: 'inherit', fontWeight: 'bold' }} />g F
              </span>
              <span className="macro-item fiber">
                <input type="number" value={Math.round(draft.meal_data.fiber_g)} onChange={e => handleMacroChange('fiber_g' as never, parseFloat(e.target.value))} style={{ width: '30px', background: 'transparent', border: 'none', color: 'inherit', fontWeight: 'bold' }} />g Fib
              </span>
            </div>
          </>
        )}

        {/* Workouts */}
        {draft.type === 'workout' && draft.workout_data && (
          <WorkoutIntentCard data={draft.workout_data} />
        )}
        {draft.type === 'weight' && draft.weight_data && (
          <div style={{ fontSize: '1.3rem', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
            <input
              type="number"
              value={draft.weight_data.weight_lbs}
              onChange={e => setDraft({ ...draft, weight_data: { weight_lbs: parseFloat(e.target.value) } })}
              style={{ width: '70px', background: 'transparent', border: 'none', borderBottom: '1px dashed var(--border-medium)', color: 'inherit', fontWeight: 'bold', fontSize: '1.3rem', marginRight: '4px' }}
            />
            lbs
          </div>
        )}
        {draft.type === 'note' && draft.note_data && (
          <div>
            <textarea
              value={draft.note_data.note}
              onChange={e => setDraft({ ...draft, note_data: { note: e.target.value } })}
              style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border-medium)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', padding: '8px', minHeight: '60px' }}
            />
          </div>
        )}
        {draft.type === 'habit' && draft.habit_data && (
          <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>
            {draft.habit_data.amount >= 0 ? '+' : ''}
            <input
              type="number"
              value={draft.habit_data.amount}
              onChange={e => setDraft({ ...draft, habit_data: { amount: parseFloat(e.target.value) } })}
              style={{ width: '50px', background: 'transparent', border: 'none', borderBottom: '1px dashed var(--border-medium)', color: 'inherit', fontWeight: 'bold', fontSize: '1.1rem', margin: '0 4px' }}
            />
            {meta.unit} {meta.label}
          </div>
        )}
        {draft.type === 'caffeine' && draft.caffeine_data && (
          <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>
            +<input
              type="number"
              value={draft.caffeine_data.amount_mg}
              onChange={e => setDraft({ ...draft, caffeine_data: { amount_mg: parseFloat(e.target.value) } })}
              style={{ width: '60px', background: 'transparent', border: 'none', borderBottom: '1px dashed var(--border-medium)', color: 'inherit', fontWeight: 'bold', fontSize: '1.1rem', margin: '0 4px' }}
            />
            mg Caffeine
          </div>
        )}
        {draft.type === 'mood' && draft.mood_data && (
          <div style={{ fontSize: '1.1rem', fontStyle: 'italic' }}>
            "
            <input
              type="text"
              value={draft.mood_data.mood}
              onChange={e => setDraft({ ...draft, mood_data: { mood: e.target.value } })}
              style={{ background: 'transparent', border: 'none', borderBottom: '1px dashed var(--border-medium)', color: 'inherit', fontStyle: 'italic', fontSize: '1.1rem' }}
            />
            "
          </div>
        )}
        {draft.type === 'sleep' && draft.sleep_data && (
          <div>
            <div style={{ fontSize: '1.3rem', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
              <input
                type="number"
                step="0.5"
                value={draft.sleep_data.hours}
                onChange={e => setDraft({ ...draft, sleep_data: { ...draft.sleep_data!, hours: parseFloat(e.target.value) || 0 } })}
                style={{ width: '60px', background: 'transparent', border: 'none', borderBottom: '1px dashed var(--border-medium)', color: 'inherit', fontWeight: 'bold', fontSize: '1.3rem', marginRight: '4px' }}
              />
              hours
            </div>
            {(draft.sleep_data.bedtime || draft.sleep_data.waketime) && (
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: 4 }}>
                {draft.sleep_data.bedtime && <span>Bedtime: {draft.sleep_data.bedtime}</span>}
                {draft.sleep_data.bedtime && draft.sleep_data.waketime && <span> → </span>}
                {draft.sleep_data.waketime && <span>Wake: {draft.sleep_data.waketime}</span>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ==========================================
// Dashboard Page
// ==========================================
function getMonday(date: Date): string {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  return toLocalISO(d)
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [stagedIntents, setStagedIntents] = useState<ParsedIntent[]>([])
  const [requestLogId, setRequestLogId] = useState<string | null>(null)
  const [adviceResponse, setAdviceResponse] = useState<string | null>(null)
  const [totals, setTotals] = useState<RunningTotals | null>(null)
  const [stats, setStats] = useState<DashboardStatsResponse | null>(null)
  const [, setTdeeInfo] = useState<TDEEInfoResponse | null>(null)
  const [todayMeals, setTodayMeals] = useState<MealResponse[]>([])
  const [todayWorkouts, setTodayWorkouts] = useState<WorkoutResponse[]>([])
  const [todayDaily, setTodayDaily] = useState<DailySummaryResponse | null>(null)
  const [todayBlocks, setTodayBlocks] = useState<TimeBlockResponse[]>([])
  const [overdueTasks, setOverdueTasks] = useState<OverdueTask[]>([])
  const [error, setError] = useState<string | null>(null)
  const [recapOpen, setRecapOpen] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [flippedCards, setFlippedCards] = useState<Record<string, boolean>>({})

  // Progress photo state
  const [photoToday, setPhotoToday] = useState<ProgressPhotoResponse | null>(null)
  const [todayPhotoSrc, setTodayPhotoSrc] = useState<string | null>(null)
  const [, setPhotoUploading] = useState(false)
  const photoInputRef = useRef<HTMLInputElement>(null)

  // Meal image capture state
  const [mealImage, setMealImage] = useState<File | null>(null)
  const [mealImagePreview, setMealImagePreview] = useState<string | null>(null)
  const mealImageRef = useRef<HTMLInputElement>(null)

  // Habit tracker state
  const [habitMeta, setHabitMeta] = useState<HabitMeta>(DEFAULT_HABIT_META)
  const HABITS = [
    { key: 'habit_workout', label: 'Workout', icon: '🏋️', color: 'var(--accent-emerald)' },
    { key: 'habit_clean', label: 'Clean', icon: '🧹', color: 'var(--accent-sky)' },
    { key: 'habit_productivity', label: 'Productive', icon: '🚀', color: 'var(--accent-amber)' },
    { key: 'habit_sleep', label: 'Sleep', icon: '😴', color: 'var(--accent-violet)' },
    { key: 'habit_love', label: 'Love', icon: '❤️', color: 'var(--accent-rose)' },
    { key: 'habit_custom', label: habitMeta.label, icon: habitMeta.emoji, color: 'var(--accent-orange)' },
  ] as const
  const [habits, setHabits] = useState<Record<string, boolean>>({
    habit_workout: false, habit_clean: false, habit_productivity: false, habit_sleep: false, habit_love: false, habit_custom: false,
  })
  const [habitDescriptions, setHabitDescriptions] = useState<Record<string, string>>({})
  const [habitsAnimating, setHabitsAnimating] = useState<Record<string, boolean>>({})
  const [caffeineToday, setCaffeineToday] = useState(0)
  const [caffeineAnimating, setCaffeineAnimating] = useState(false)
  const [extrasEnabled, setExtrasEnabled] = useState(false)

  const refreshData = useCallback(async () => {
    try {
      const [t, meals, s, wk, days] = await Promise.all([
        getRunningTotals(),
        listMeals(todayISO(), todayISO(), 20),
        getDashboardStats(),
        listWorkouts({ startDate: todayISO(), endDate: todayISO(), limit: 50 }),
        listDaily(todayISO(), todayISO(), 1),
      ])
      setTotals(t)
      setTodayMeals(meals)
      setStats(s)
      setTodayWorkouts(wk)
      setTodayDaily(days[0] ?? null)
    } catch {
      // Silently handle — will show stale data
    }
    getTDEEInfo().then(setTdeeInfo).catch(() => {})
    getOverdueTasks().then(setOverdueTasks).catch(() => {})
  }, [])

  useEffect(() => { refreshData() }, [refreshData])

  // Load today's schedule blocks
  useEffect(() => {
    const today = todayISO()
    const weekStart = getMonday(new Date())
    listTimeBlocks(weekStart)
      .then(blocks => setTodayBlocks(blocks.filter(b => b.date === today)))
      .catch(() => {})
  }, [])

  // Load extras_enabled flag (admin only — friends never see private widgets)
  useEffect(() => {
    if (getCurrentUserRole() !== 'admin') return
    fetchSettings()
      .then(s => setExtrasEnabled(s.settings.extras_enabled === 'true'))
      .catch(() => { /* swallow — widget stays hidden */ })
  }, [])

  // Load today's habits and habit descriptions on mount
  useEffect(() => {
    (async () => {
      try {
        const days = await listDaily(todayISO(), todayISO(), 1)
        if (days.length > 0) {
          const d = days[0]
          setHabits({
            habit_workout: d.habit_workout, habit_clean: d.habit_clean,
            habit_productivity: d.habit_productivity, habit_sleep: d.habit_sleep,
            habit_love: d.habit_love, habit_custom: d.habit_custom,
          })
          setCaffeineToday(d.caffeine_mg || 0)
        }
      } catch { /* ignore */ }
      try {
        const { meta, descriptions } = await getHabitsConfig()
        setHabitMeta(meta)
        setHabitDescriptions(descriptions)
      } catch { /* ignore */ }
    })()
  }, [])

  const toggleHabit = async (key: string) => {
    const newVal = !habits[key]
    setHabits(prev => ({ ...prev, [key]: newVal }))
    setHabitsAnimating(prev => ({ ...prev, [key]: true }))
    setTimeout(() => setHabitsAnimating(prev => ({ ...prev, [key]: false })), 600)
    try {
      await updateDaily(todayISO(), { [key]: newVal })
    } catch {
      setHabits(prev => ({ ...prev, [key]: !newVal }))
    }
  }

  const addRedBull = async () => {
    const newTotal = caffeineToday + 80
    setCaffeineToday(newTotal)
    setCaffeineAnimating(true)
    setTimeout(() => setCaffeineAnimating(false), 800)
    try {
      await updateDaily(todayISO(), { caffeine_mg: newTotal })
    } catch {
      setCaffeineToday(newTotal - 80)
    }
  }

  // Load today's progress photo on mount
  useEffect(() => {
    (async () => {
      try {
        const photos = await listPhotos()
        const today = photos.find(p => p.date === todayISO()) || null
        setPhotoToday(today)
        if (today) {
          const src = await fetchPhotoBlob(todayISO())
          setTodayPhotoSrc(src)
        }
      } catch { /* ignore */ }
    })()
  }, [])

  const handlePhotoSelected = async (file: File) => {
    setPhotoUploading(true)
    try {
      const photo = await uploadPhoto(todayISO(), file)
      setPhotoToday(photo)
      const src = await fetchPhotoBlob(todayISO())
      setTodayPhotoSrc(prev => { if (prev) URL.revokeObjectURL(prev); return src })
    } catch (err) {
      console.error('Photo upload failed', err)
    }
    setPhotoUploading(false)
  }


  const resizeImageToBase64 = (file: File, maxSize = 1024): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image()
      const url = URL.createObjectURL(file)
      img.onload = () => {
        URL.revokeObjectURL(url)
        const canvas = document.createElement('canvas')
        let { width, height } = img
        if (width > maxSize || height > maxSize) {
          const ratio = Math.min(maxSize / width, maxSize / height)
          width = Math.round(width * ratio)
          height = Math.round(height * ratio)
        }
        canvas.width = width
        canvas.height = height
        canvas.getContext('2d')!.drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL('image/jpeg', 0.85).split(',')[1])
      }
      img.src = url
    })
  }

  const handleMealImageSelected = (file: File) => {
    setMealImage(file)
    setMealImagePreview(URL.createObjectURL(file))
  }

  const clearMealImage = () => {
    if (mealImagePreview) URL.revokeObjectURL(mealImagePreview)
    setMealImage(null)
    setMealImagePreview(null)
  }

  // Parse (+ continue) reconnects server-side by context — survives nav/refresh.
  const { submit: submitParse, ack: ackParse, isActive: parsePolling } = useContextJobs<ParseResponse>('dashboard_parse', {
    transform: (raw) => raw as unknown as ParseResponse,
    // Defer ack until the user confirms/discards the card, so an unresolved parse
    // survives a refresh and shows on other devices (see handleConfirm*/handleDiscard).
    ackOnDeliver: false,
    onResult: (result, jobId) => {
      if (result.intents && result.intents.length > 0) {
        setStagedIntents(prev => [...prev, ...result.intents])
        // job_id IS the request_log_id; the reconnect payload doesn't carry it, so take
        // it from the delivered job. Needed for both confidence metrics and ack-on-resolve.
        setRequestLogId(result.request_log_id || jobId)
      }
      if (result.advice_response) setAdviceResponse(result.advice_response)
      setLoading(false)
    },
    onError: (msg) => {
      setError(msg || 'AI processing failed')
      setLoading(false)
    },
  })

  const handleSend = async () => {
    if ((!input.trim() && !mealImage) || loading) return
    setError(null)
    setLoading(true)
    const message = input.trim() || 'What is in this photo?'
    setInput('')
    const savedImage = mealImage
    clearMealImage()
    if (stagedIntents.length > 0) {
      await submitParse(() => continueInputAsync(message, stagedIntents))
    } else {
      const imageB64 = savedImage ? await resizeImageToBase64(savedImage) : undefined
      await submitParse(() => parseInputAsync(message, todayISO(), imageB64))
    }
  }

  const handleConfirmAll = async () => {
    if (stagedIntents.length === 0) return
    setLoading(true)
    setError(null)
    try {
      await commitIntents(todayISO(), stagedIntents, requestLogId)
      if (requestLogId) ackParse(requestLogId)
      setStagedIntents([])
      setRequestLogId(null)
      setAdviceResponse(null)
      await refreshData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to commit')
    } finally {
      setLoading(false)
    }
  }

  const handleConfirmSingle = async (index: number, modifiedIntent?: ParsedIntent) => {
    const intent = modifiedIntent || stagedIntents[index]
    setLoading(true)
    try {
      await commitIntents(todayISO(), [intent], requestLogId)
      if (requestLogId) ackParse(requestLogId)
      setStagedIntents(prev => prev.filter((_, i) => i !== index))
      setRequestLogId(null)
      await refreshData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to commit')
    } finally {
      setLoading(false)
    }
  }

  const handleDiscard = (index: number) => {
    const next = stagedIntents.filter((_, i) => i !== index)
    setStagedIntents(next)
    // Discarding the last staged intent resolves the card — ack so it won't reconnect.
    if (next.length === 0 && requestLogId) { ackParse(requestLogId); setRequestLogId(null) }
  }

  const allHabitsDone = HABITS.every(h => habits[h.key])

  return (
    <div className="dash">
      {/* Hidden file inputs */}
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        capture="user"
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) handlePhotoSelected(f); e.target.value = '' }}
      />
      <input
        ref={mealImageRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) handleMealImageSelected(f); e.target.value = '' }}
      />

      {/* Row 1: Top Bar */}
      <TopBar
        photoToday={photoToday}
        todayPhotoSrc={todayPhotoSrc}
        onPhotoClick={() => photoInputRef.current?.click()}
      />

      {/* Row 2: KPI Strip */}
      <KPIStrip stats={stats} totals={totals} flippedCards={flippedCards} toggleFlip={setFlippedCards} />

      {/* Row 3: 3-column grid */}
      <div className="grid3">
        {/* LEFT: Nutrition */}
        <NutritionPanel totals={totals} />

        {/* CENTER: Input + Staging + Overdue */}
        <div className="center-col">
          {/* Input area */}
          {mealImagePreview && (
            <div className="dash-img-preview">
              <img src={mealImagePreview} alt="Meal" />
              <button onClick={clearMealImage} title="Remove photo">&times;</button>
            </div>
          )}
          <div className="dash-input-wrap">
            <button className="dash-camera" onClick={() => mealImageRef.current?.click()} title="Snap a meal photo">
              📷
            </button>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder={mealImage ? 'Add context (e.g. "lunch")...' : 'What did you eat? Log a workout, weigh in...'}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
            />
            <button className="dash-send" onClick={handleSend} disabled={loading || (!input.trim() && !mealImage)}>
              {loading ? '...' : '▶'}
            </button>
            <span
              className={`dash-poll${parsePolling ? ' is-polling' : ''}`}
              title={parsePolling
                ? 'Listening for the AI result — safe to leave this page and come back'
                : 'Idle — no request in flight'}
              aria-live="polite"
            >
              {parsePolling && <span className="dash-poll-label">listening</span>}
              <span className="dash-poll-dot" />
            </span>
          </div>

          {/* Error */}
          {error && (
            <div style={{ color: 'var(--accent-rose)', fontSize: '0.78rem' }}>
              ⚠️ {error}
            </div>
          )}

          {/* AI Advice Response */}
          {adviceResponse && (
            <div className="dash-staged" style={{ borderLeftColor: 'var(--accent-violet)', borderLeftWidth: 3 }}>
              <div style={{ fontSize: '0.62rem', fontWeight: 600, color: 'var(--accent-violet)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
                🤖 AI Advisor
              </div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                {adviceResponse}
              </div>
            </div>
          )}

          {/* Staged Intents */}
          {stagedIntents.length > 0 && (
            <>
              {stagedIntents.map((intent, i) => (
                <PreviewCard
                  key={`${intent.type}-${intent.meal_data?.meal || ''}-${intent.workout_data?.exercises?.[0]?.exercise || ''}-${intent.weight_data?.weight_lbs || ''}-${i}-${stagedIntents.length}`}
                  intent={intent}
                  onConfirm={(modified) => handleConfirmSingle(i, modified)}
                  onDiscard={() => handleDiscard(i)}
                  onChange={(modified) => setStagedIntents(prev => prev.map((it, idx) => idx === i ? modified : it))}
                  meta={habitMeta}
                />
              ))}
              <button className="dash-confirm-all" onClick={handleConfirmAll} disabled={loading}>
                {loading ? 'Saving...' : `✓ Confirm All (${stagedIntents.length})`}
              </button>
            </>
          )}

          {/* Overdue Tasks */}
          {overdueTasks.length > 0 && (
            <div className="dash-staged" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="dash-recap-head" onClick={() => setTasksOpen(o => !o)} style={{ padding: '10px 16px' }}>
                <span className="dash-sched-title" style={{ color: 'var(--accent-rose)' }}>{tasksOpen ? '▾' : '▸'} ⚠ Overdue ({overdueTasks.length})</span>
                <a href="#" className="dash-sched-link" style={{ color: 'var(--text-muted)' }} onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate('/tasks') }}>Tasks →</a>
              </div>
              {tasksOpen && <div style={{ padding: '0 16px 14px' }}>
              {overdueTasks.map(task => (
                <div key={task.id} className="overdue-task">
                  <div className={`overdue-priority ${task.priority === 'high' ? 'high' : task.priority === 'medium' ? 'med' : 'low'}`} />
                  <div className="overdue-body">
                    <div className="overdue-name">{task.title}</div>
                    <div className="overdue-due">
                      {task.due_date && <>Due {new Date(task.due_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</>}
                      {task.days_overdue > 0 && <> · {task.days_overdue} day{task.days_overdue !== 1 ? 's' : ''} overdue</>}
                    </div>
                  </div>
                  <span className="overdue-cat">{task.category}</span>
                </div>
              ))}
              </div>}
            </div>
          )}
        </div>

        {/* RIGHT: Stats + Habits + Schedule */}
        <div className="right-col">
          {/* Habits + Stats card */}
          <div className="dash-stats" style={allHabitsDone ? { borderColor: 'rgba(245,158,11,0.3)', boxShadow: '0 4px 24px rgba(0,0,0,0.5), 0 0 24px rgba(245,158,11,0.08)' } : undefined}>
            <div className="dash-sec-label">Habits</div>
            <div className="dash-habits">
              {HABITS.map(h => {
                const isDone = habits[h.key]
                const isAnimating = habitsAnimating[h.key]
                return (
                  <button
                    key={h.key}
                    className={`dash-hab${isDone ? ' done' : ''}${isAnimating ? ' pulse' : ''}`}
                    onClick={() => toggleHabit(h.key)}
                    title={habitDescriptions[h.key]}
                  >
                    <div className="dash-hab-ring">
                      <svg viewBox="0 0 36 36">
                        <circle cx="18" cy="18" r="16" className="dash-hab-ring-bg" />
                        <circle
                          cx="18" cy="18" r="16"
                          className="dash-hab-ring-prog"
                          style={{ stroke: h.color }}
                        />
                      </svg>
                      <span className="dash-hab-icon">{h.icon}</span>
                      {isDone && <span className="dash-hab-check">✓</span>}
                    </div>
                    <span className="dash-hab-lb">{h.label}</span>
                  </button>
                )
              })}
            </div>

            <div className="dash-sec-label">Caffeine</div>
            <button className={`dash-redbull${caffeineAnimating ? ' zap' : ''}`} onClick={addRedBull}>
              <span className="dash-redbull-bolt">⚡</span>
              <span className="dash-redbull-label">Red Bull</span>
              <span className="dash-redbull-mg">
                {caffeineToday > 0 && <span className="dash-redbull-total">{caffeineToday}mg</span>}
                <span className={`dash-redbull-add${caffeineAnimating ? ' flash' : ''}`}>+80mg</span>
              </span>
            </button>

            {extrasEnabled && PrivateWidget && (
              <div style={{ marginTop: 12 }}>
                <PrivateWidget />
              </div>
            )}
          </div>

          {/* Schedule */}
          <SchedulePanel blocks={todayBlocks} />
          <ImportantDatesPanel />
        </div>
      </div>

      {/* Row 4: Daily Recap */}
      <DailyRecap meals={todayMeals} workouts={todayWorkouts} recapOpen={recapOpen} setRecapOpen={setRecapOpen} workoutType={todayDaily?.workout_type ?? null} />
    </div>
  )
}
