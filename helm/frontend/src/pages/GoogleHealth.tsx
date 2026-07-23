import { useState, useEffect } from 'react'
import {
  getHealthStatus, connectHealth, syncHealthNow, disconnectHealth,
  getHealthDaily, getIntradayHeartRate, triggerBackfill,
  type HealthConnectionStatus, type DailyHealthResponse, type IntradayHeartRateResponse,
} from '../api'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid } from 'recharts'
import { todayISO } from '../dates'

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  // Backend sends naive UTC (no 'Z'); force UTC parsing so the elapsed time is correct.
  const norm = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z'
  const then = new Date(norm).getTime()
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

export default function GoogleHealth() {
  const [status, setStatus] = useState<HealthConnectionStatus | null>(null)
  const [error, setError] = useState('')
  const [flash, setFlash] = useState('')
  const [busy, setBusy] = useState(false)
  const [latest, setLatest] = useState<DailyHealthResponse | null>(null)
  const [hr, setHr] = useState<IntradayHeartRateResponse | null>(null)

  const load = () => {
    getHealthStatus().then(setStatus).catch(e => setError(e.message))
  }

  const loadData = () => {
    getHealthDaily('0000-01-01', '9999-12-31').then(h => setLatest(h[h.length - 1] ?? null)).catch(() => {})
    getIntradayHeartRate(todayISO()).then(setHr).catch(() => setHr(null))
  }

  useEffect(() => {
    // Read the post-callback redirect (?health=connected|error), toast, then strip it.
    const params = new URLSearchParams(window.location.search)
    const h = params.get('health')
    if (h === 'connected') setFlash('Google Health connected')
    if (h === 'error') setError('Connection failed — please try again')
    if (h) {
      window.history.replaceState({}, '', window.location.pathname)
      if (h) setTimeout(() => setFlash(''), 3000)
    }
    load()
    loadData()
  }, [])

  const onConnect = async () => {
    setBusy(true); setError('')
    try { await connectHealth() } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); setBusy(false) }
    // connectHealth navigates away on success.
  }

  const onSync = async () => {
    setBusy(true); setError('')
    try {
      const r = await syncHealthNow()
      setFlash(r.steps_today != null ? `Synced — ${r.steps_today} steps today` : 'Synced')
      setTimeout(() => setFlash(''), 3000)
      load()
      loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed')
    }
    setBusy(false)
  }

  const onDisconnect = async () => {
    setBusy(true); setError('')
    try { await disconnectHealth(); setFlash('Disconnected'); setTimeout(() => setFlash(''), 3000); load() }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
    setBusy(false)
  }

  const onBackfill = async () => {
    setBusy(true); setError('')
    try { await triggerBackfill(); setFlash('Backfill started — data will fill in shortly'); setTimeout(() => setFlash(''), 4000) }
    catch (e) { setError(e instanceof Error ? e.message : 'Backfill failed') }
    setBusy(false)
  }

  return (
    <div className="page-container">
      <h1 className="page-title">Google Health</h1>

      {flash && (
        <div className="glass-card" style={{ padding: '10px 16px', marginBottom: 16, color: 'var(--accent-emerald)', fontSize: '0.85rem' }}>
          {flash}
        </div>
      )}
      {error && (
        <div className="glass-card" style={{ padding: '10px 16px', marginBottom: 16, color: 'var(--accent-rose)', fontSize: '0.85rem' }}>
          {error}
        </div>
      )}

      <div className="glass-card" style={{ padding: 24, maxWidth: 560 }}>
        <h2 style={{ margin: '0 0 16px', fontSize: '1.1rem', color: 'var(--text-primary)' }}>Connection</h2>

        {!status && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}

        {status && status.status === 'disconnected' && (
          <>
            <p style={{ margin: '0 0 16px', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Connect your Google account to pull Fitbit / Google Health data into Helm.
            </p>
            <button className="btn-primary" disabled={busy} onClick={onConnect}>Connect Google Health</button>
          </>
        )}

        {status && status.status === 'connected' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--accent-emerald)' }} />
              <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Connected</span>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>· last synced {relativeTime(status.last_sync_at)}</span>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button className="btn-primary" disabled={busy} onClick={onSync}>Sync now</button>
              <button
                disabled={busy}
                onClick={onDisconnect}
                style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-muted)', cursor: busy ? 'wait' : 'pointer' }}
              >Disconnect</button>
            </div>
          </>
        )}

        {status && status.status === 'needs_reconsent' && (
          <>
            <p style={{ margin: '0 0 16px', fontSize: '0.85rem', color: 'var(--accent-amber)' }}>
              Connection expired. Reconnect to resume syncing.
            </p>
            <button className="btn-primary" disabled={busy} onClick={onConnect}>Reconnect</button>
          </>
        )}
      </div>

      {status?.status === 'connected' && (
        <>
          {/* Intraday HR — today */}
          <div className="glass-card" style={{ padding: 24, maxWidth: 760, marginTop: 16 }}>
            <h2 style={{ margin: '0 0 4px', fontSize: '1.1rem', color: 'var(--text-primary)' }}>Heart rate — today</h2>
            {hr ? (
              <>
                <div style={{ display: 'flex', gap: 18, fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: 8 }}>
                  <span>min <b style={{ color: 'var(--accent-emerald)' }}>{hr.min_bpm}</b></span>
                  <span>avg <b style={{ color: 'var(--text-primary)' }}>{hr.avg_bpm}</b></span>
                  <span>max <b style={{ color: 'var(--accent-rose)' }}>{hr.max_bpm}</b></span>
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={hr.points}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="t" tick={{ fontSize: 11, fill: '#64748b' }} interval={119} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: '#64748b' }} width={35} domain={['dataMin - 5', 'dataMax + 5']} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }} />
                    {latest?.resting_hr != null && <ReferenceLine y={latest.resting_hr} stroke="#10b981" strokeDasharray="4 4" />}
                    <Line type="monotone" dataKey="bpm" stroke="#f43f5e" strokeWidth={1.3} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </>
            ) : <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No heart-rate data synced for today yet.</div>}
          </div>

          {/* Latest from Google */}
          {latest && (
            <div className="glass-card" style={{ padding: 24, maxWidth: 760, marginTop: 16 }}>
              <h2 style={{ margin: '0 0 16px', fontSize: '1.1rem', color: 'var(--text-primary)' }}>
                Latest from Google Health
                {latest && (
                  <span style={{ marginLeft: 8, fontSize: '0.8rem', fontWeight: 400, color: 'var(--text-muted)' }}>
                    · {new Date(latest.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                )}
              </h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
                {([['Steps', latest.steps?.toLocaleString(), 'var(--accent-sky)'],
                   ['Resting HR', latest.resting_hr, 'var(--accent-emerald)'],
                   ['HRV', latest.hrv_ms != null ? `${Math.round(latest.hrv_ms)}ms` : null, 'var(--accent-violet)'],
                   ['Resp', latest.respiratory_rate?.toFixed(1), 'var(--text-primary)'],
                   ['Sleep eff.', latest.sleep_efficiency_pct != null ? `${Math.round(latest.sleep_efficiency_pct)}%` : null, 'var(--text-primary)']] as const).map(([label, val, color]) => (
                  <div key={label}>
                    <div style={{ fontSize: '0.58rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>{label}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.1rem', fontWeight: 600, color: color as string }}>{val ?? '—'}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sync & data */}
          <div className="glass-card" style={{ padding: 24, maxWidth: 760, marginTop: 16 }}>
            <h2 style={{ margin: '0 0 12px', fontSize: '1.1rem', color: 'var(--text-primary)' }}>Sync &amp; data</h2>
            <button
              disabled={busy} onClick={onBackfill}
              style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-secondary)', cursor: busy ? 'wait' : 'pointer' }}
            >Import full history</button>
            {status.scopes && (
              <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {status.scopes.split(' ').map(s => {
                  const short = s.split('.').slice(-2, -1)[0] || s
                  return <span key={s} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.58rem', color: 'var(--accent-sky)', border: '1px solid rgba(56,189,248,0.3)', borderRadius: 999, padding: '1px 8px' }}>{short}</span>
                })}
              </div>
            )}
            {status.scopes && !status.scopes.split(' ').includes('https://www.googleapis.com/auth/googlehealth.location.readonly') && (
              <div style={{ marginTop: 12, fontSize: '0.8rem', color: 'var(--accent-amber)' }}>
                Run route maps need the location permission — reconnect once to grant it.
                <button className="btn-primary" disabled={busy} onClick={onConnect}
                  style={{ marginLeft: 10 }}>Reconnect</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
