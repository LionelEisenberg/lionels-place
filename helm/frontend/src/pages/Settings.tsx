import { useState, useEffect } from 'react'
import { fetchSettings, updateSettings, type HelmSettings } from '../api'

const LABELS: Record<string, string> = {
  llm_provider: 'LLM Provider',
  llm_model: 'Model',
  llm_effort: 'Effort',
  llm_fallback: 'Fallback Provider',
  extras_enabled: 'Show experimental widgets',
}

const DESCRIPTIONS: Record<string, string> = {
  llm_provider: 'Which AI backend to use for all LLM requests. Claude uses your Max subscription via the bridge service.',
  llm_model: 'Which Claude model to use. Opus = most capable, Sonnet = best speed/quality balance (6x faster), Haiku = fastest/cheapest.',
  llm_effort: 'Controls thinking depth. Lower = faster responses, less reasoning. Only applies when provider is Claude.',
  llm_fallback: 'Secondary provider to try if the primary fails. Empty = no fallback (fail fast). Off by default.',
  extras_enabled: "Reveal optional dashboard widgets that aren't part of the core flow.",
}

export default function Settings() {
  const [data, setData] = useState<HelmSettings | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [flash, setFlash] = useState('')

  useEffect(() => {
    fetchSettings().then(setData).catch(e => setError(e.message))
  }, [])

  const handleChange = async (key: string, value: string | boolean) => {
    setSaving(key)
    setError('')
    try {
      const result = await updateSettings({ [key]: value })
      setData(prev => prev ? { ...prev, settings: result.settings } : prev)
      setFlash(`${LABELS[key] || key} updated to "${value}"`)
      setTimeout(() => setFlash(''), 3000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    }
    setSaving(null)
  }

  if (error && !data) {
    return (
      <div className="page-container">
        <div className="glass-card" style={{ padding: 24, color: 'var(--accent-rose)' }}>
          {error}
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="page-container">
        <div className="glass-card" style={{ padding: 24, color: 'var(--text-muted)' }}>
          Loading settings...
        </div>
      </div>
    )
  }

  return (
    <div className="page-container">
      <h1 className="page-title">Settings</h1>

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

      <div className="glass-card" style={{ padding: 24 }}>
        <h2 style={{ margin: '0 0 20px', fontSize: '1.1rem', color: 'var(--text-primary)' }}>LLM Configuration</h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {Object.entries(data.settings).map(([key, value]) => {
            // Boolean settings get a checkbox; others keep the existing dropdown.
            if (key === 'extras_enabled') {
              const checked = value === 'true' || (value as unknown) === true
              return (
                <div key={key}>
                  <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                    {LABELS[key] || key}
                  </label>
                  <p style={{ margin: '0 0 8px', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    {DESCRIPTIONS[key] || ''}
                  </p>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: saving === key ? 'wait' : 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={saving === key}
                      onChange={e => handleChange(key, e.target.checked)}
                    />
                    <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>{checked ? 'On' : 'Off'}</span>
                  </label>
                </div>
              )
            }
            return (
              <div key={key}>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                  {LABELS[key] || key}
                </label>
                <p style={{ margin: '0 0 8px', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  {DESCRIPTIONS[key] || ''}
                </p>
                <select
                  value={value}
                  onChange={e => handleChange(key, e.target.value)}
                  disabled={saving === key}
                  style={{
                    width: '100%',
                    maxWidth: 300,
                    padding: '8px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--glass-bg)',
                    color: 'var(--text-primary)',
                    fontSize: '0.9rem',
                    cursor: saving === key ? 'wait' : 'pointer',
                    opacity: saving === key ? 0.6 : 1,
                  }}
                >
                  {(data.options[key] || []).map(opt => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
