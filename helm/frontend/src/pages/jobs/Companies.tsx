/**
 * Companies — Tiered target company list with inline editing,
 * structured AI research display, and company advisor chat.
 */

import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  listCompanies, createCompany, updateCompany, deleteCompany, companyResearchAsync,
  companyChatAsync, getCompanyChatHistory,
  type CompanyResponse, type CompanyCreate, type CompanyUpdate,
  type CompanyResearch,
} from '../../api'
import { useContextJobs } from '../../useContextJobs'

// ==========================================
// Constants
// ==========================================
const TIER_ORDER = ['gaming_t1', 'gaming_t2', 'tech_t1', 'tech_t2', 'adjacent']

const TIER_LABELS: Record<string, string> = {
  gaming_t1: 'Gaming — Tier 1',
  gaming_t2: 'Gaming — Tier 2',
  tech_t1: 'Tech — Tier 1',
  tech_t2: 'Tech — Tier 2',
  adjacent: 'Adjacent',
}

const TIER_COLORS: Record<string, string> = {
  gaming_t1: 'var(--accent-indigo)',
  gaming_t2: 'var(--accent-violet)',
  tech_t1: 'var(--accent-emerald)',
  tech_t2: 'var(--accent-sky)',
  adjacent: 'var(--accent-amber)',
}

// ==========================================
// Helpers
// ==========================================

/** Try to parse market_info JSON string into CompanyResearch */
function parseResearch(raw: string | null): CompanyResearch | null {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    // Legacy: raw text from old advisor — wrap in summary
    return {
      summary: raw,
      company_size: null, engineering_size: null, funding_stage: null,
      tech_stack: null, culture_notes: null, recent_layoffs: null,
      glassdoor_rating: null, hiring_signals: null, recent_news: null,
      stock_performance: null, careers_page_url: null, last_updated: '',
    }
  }
}

function formatUpdated(dateStr: string | null) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ==========================================
// EditInput (module-level, follows WorkoutLog pattern)
// ==========================================
const EditInput = ({
  field, type = 'text', width = '100%', options,
  editData, setEditData, saveEdit, cancelEdit,
}: {
  field: keyof CompanyResponse
  type?: string
  width?: string
  options?: string[]
  editData: Partial<CompanyResponse>
  setEditData: React.Dispatch<React.SetStateAction<Partial<CompanyResponse>>>
  saveEdit: () => void
  cancelEdit: () => void
}) => {
  const value = editData[field] ?? ''
  const handleChange = (val: string) => setEditData(prev => ({ ...prev, [field]: val }))

  if (type === 'select' && options) {
    return (
      <select value={value as string} onChange={e => handleChange(e.target.value)} style={{ width }}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }

  if (type === 'textarea') {
    return (
      <textarea
        value={value as string}
        onChange={e => handleChange(e.target.value)}
        style={{ width, minHeight: '60px', resize: 'vertical' }}
        onKeyDown={e => {
          if (e.key === 'Escape') cancelEdit()
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit() }
        }}
      />
    )
  }

  return (
    <input
      type={type}
      value={value as string}
      onChange={e => handleChange(e.target.value)}
      style={{ width }}
      onKeyDown={e => {
        if (e.key === 'Enter') saveEdit()
        if (e.key === 'Escape') cancelEdit()
      }}
    />
  )
}

// ==========================================
// ResearchPanel — Structured research display
// ==========================================
function hiringSignalColor(signal: string | null): string {
  if (!signal) return ''
  const lower = signal.toLowerCase()
  if (lower.includes('freeze') || lower.includes('pause') || lower.includes('laid') || lower.includes('slowdown')) return 'signal-warn'
  if (lower.includes('active') || lower.includes('hiring') || lower.includes('growing') || lower.includes('open role')) return 'signal-good'
  return ''
}

function ResearchPanel({ research, updatedAt, isLoading }: {
  research: CompanyResearch | null
  updatedAt: string | null
  isLoading: boolean
}) {
  if (isLoading) {
    return (
      <div className="research-panel">
        <div className="research-skeleton">
          {/* Wide skeleton for summary */}
          <div className="skeleton-cell skeleton-cell--wide">
            <div className="skeleton-label" />
            <div className="skeleton-value" style={{ height: 36 }} />
          </div>
          {/* 3-col row */}
          {[...Array(3)].map((_, i) => (
            <div key={i} className="skeleton-cell">
              <div className="skeleton-label" />
              <div className="skeleton-value" />
            </div>
          ))}
          {/* Tags row */}
          <div className="skeleton-cell skeleton-cell--wide">
            <div className="skeleton-label" />
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              {[...Array(5)].map((_, i) => (
                <div key={i} className="skeleton-tag" style={{ width: 40 + i * 12 }} />
              ))}
            </div>
          </div>
          {/* 2-col row */}
          {[...Array(2)].map((_, i) => (
            <div key={i} className="skeleton-cell">
              <div className="skeleton-label" />
              <div className="skeleton-value" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (!research) {
    return (
      <div className="research-panel research-empty">
        No research yet — click <strong>Research with AI</strong> to pull structured intelligence.
      </div>
    )
  }

  const signalClass = hiringSignalColor(research.hiring_signals)

  return (
    <div className="research-panel">
      {/* Row 1: Full-width summary */}
      <div className="rp-grid">
        <div className="rp-cell rp-cell--wide">
          <span className="rp-label">Overview</span>
          <span className="rp-value">{research.summary || <span className="rp-null">No summary</span>}</span>
        </div>

        {/* Row 2: 3 compact stat cells */}
        <div className="rp-cell">
          <span className="rp-label">Company Size</span>
          <span className={`rp-value rp-stat${!research.company_size ? ' rp-null' : ''}`}>
            {research.company_size || '—'}
          </span>
        </div>
        <div className="rp-cell">
          <span className="rp-label">Engineering</span>
          <span className={`rp-value rp-stat${!research.engineering_size ? ' rp-null' : ''}`}>
            {research.engineering_size || '—'}
          </span>
        </div>
        <div className="rp-cell">
          <span className="rp-label">Stage / Market</span>
          <span className={`rp-value rp-stat${!research.funding_stage ? ' rp-null' : ''}`}>
            {research.funding_stage || '—'}
          </span>
        </div>

        {/* Row 3: Hiring signal — semantic color */}
        <div className={`rp-cell rp-cell--wide rp-cell--signal${signalClass ? ` ${signalClass}` : ''}`}>
          <span className="rp-label">Hiring Signal</span>
          <span className={`rp-value${!research.hiring_signals ? ' rp-null' : ''}`}>
            {research.hiring_signals || '—'}
          </span>
        </div>

        {/* Row 4: Tech stack — code token chips */}
        {research.tech_stack && research.tech_stack.length > 0 && (
          <div className="rp-cell rp-cell--wide">
            <span className="rp-label">Tech Stack</span>
            <div className="rp-chips rp-chips--code">
              {research.tech_stack.map((t, i) => (
                <span key={i} className="rp-chip rp-chip--code">{t}</span>
              ))}
            </div>
          </div>
        )}

        {/* Row 5: Culture notes — tag chips */}
        {research.culture_notes && research.culture_notes.length > 0 && (
          <div className="rp-cell rp-cell--wide">
            <span className="rp-label">Culture</span>
            <div className="rp-chips">
              {research.culture_notes.map((note, i) => (
                <span key={i} className="rp-chip">{note}</span>
              ))}
            </div>
          </div>
        )}

        {/* Row 6: 3-col stats */}
        <div className="rp-cell">
          <span className="rp-label">Glassdoor</span>
          <span className={`rp-value rp-stat${!research.glassdoor_rating ? ' rp-null' : ''}`}>
            {research.glassdoor_rating || '—'}
          </span>
        </div>
        <div className="rp-cell">
          <span className="rp-label">Layoffs</span>
          <span className={`rp-value${!research.recent_layoffs ? ' rp-null' : ''}`} style={{ fontSize: '0.82rem' }}>
            {research.recent_layoffs || '—'}
          </span>
        </div>
        <div className="rp-cell">
          <span className="rp-label">Stock</span>
          <span className={`rp-value rp-stat${!research.stock_performance ? ' rp-null' : ''}`}>
            {research.stock_performance || 'Private'}
          </span>
        </div>

        {/* Row 7: Recent news */}
        {research.recent_news && (
          <div className="rp-cell rp-cell--wide">
            <span className="rp-label">Recent News</span>
            <span className="rp-value" style={{ fontSize: '0.82rem' }}>{research.recent_news}</span>
          </div>
        )}

        {/* Row 8: Careers link */}
        {research.careers_page_url && (
          <div className="rp-cell rp-cell--wide">
            <span className="rp-label">Careers Page</span>
            <a href={research.careers_page_url} target="_blank" rel="noopener noreferrer" className="research-link">
              {research.careers_page_url}
            </a>
          </div>
        )}
      </div>

      {updatedAt && (
        <div className="research-footer">
          Refreshed {formatUpdated(updatedAt)}
        </div>
      )}
    </div>
  )
}

// ==========================================
// Main Component
// ==========================================
export default function Companies() {
  const navigate = useNavigate()
  const [companies, setCompanies] = useState<CompanyResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editData, setEditData] = useState<Partial<CompanyResponse>>({})
  const [isAdding, setIsAdding] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [researchingId, setResearchingId] = useState<number | null>(null)
  const [tierFilter, setTierFilter] = useState<string | null>(null)

  // Advisor chat state
  const [advisorOpen, setAdvisorOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<{ role: string; content: string }[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatLoaded, setChatLoaded] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement>(null)

  const load = async () => {
    try {
      const data = await listCompanies()
      setCompanies(data)
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // Auto-scroll chat
  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [chatMessages])

  // Lazy-load chat history
  useEffect(() => {
    if (advisorOpen && !chatLoaded) {
      setChatLoaded(true)
      getCompanyChatHistory(50).then(msgs => {
        setChatMessages(msgs.map(m => ({ role: m.role, content: m.content })))
      }).catch(() => {})
    }
  }, [advisorOpen, chatLoaded])

  // Derived
  const filtered = tierFilter ? companies.filter(c => c.tier === tierFilter) : companies
  const grouped = TIER_ORDER.map(tier => ({
    tier,
    label: TIER_LABELS[tier],
    color: TIER_COLORS[tier],
    items: filtered.filter(c => c.tier === tier),
  }))
  const totalCount = filtered.length

  // Edit handlers
  const startEdit = (c: CompanyResponse) => {
    setIsAdding(false)
    setExpandedId(null)
    setEditingId(c.id)
    setEditData({ ...c })
  }

  const startAdd = () => {
    setEditingId(null)
    setExpandedId(null)
    setEditData({ name: '', tier: 'gaming_t1', location: '', notes: '', role_types: '', careers_url: '', website_url: '' })
    setIsAdding(true)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setIsAdding(false)
    setEditData({})
  }

  const saveEdit = async () => {
    try {
      if (isAdding) {
        await createCompany({
          name: (editData.name || '').trim(),
          tier: editData.tier || 'gaming_t1',
          location: editData.location || null,
          notes: editData.notes || null,
          role_types: editData.role_types || null,
          careers_url: editData.careers_url || null,
          website_url: editData.website_url || null,
        } as CompanyCreate)
      } else if (editingId) {
        await updateCompany(editingId, {
          name: (editData.name || '').trim() || undefined,
          tier: editData.tier || undefined,
          location: editData.location,
          notes: editData.notes,
          role_types: editData.role_types,
          careers_url: editData.careers_url,
          website_url: editData.website_url,
        } as CompanyUpdate)
      }
      cancelEdit()
      await load()
    } catch { /* ignore */ }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this company?')) return
    try {
      await deleteCompany(id)
      await load()
    } catch { /* ignore */ }
  }

  const toggleExpand = (id: number) => {
    if (editingId) return
    setExpandedId(prev => prev === id ? null : id)
  }

  // Company research — routed through the llm_jobs queue; the company_research
  // result-hook persists the research JSON onto the Company server-side, so we
  // just refetch the company list once the job resolves.
  const { submit: submitResearch } = useContextJobs<{ ok: boolean }>('company_research', {
    transform: () => ({ ok: true }),
    onResult: () => {
      load()
      setResearchingId(null)
    },
    onError: () => {
      setResearchingId(null)
    },
  })

  const handleResearch = async (id: number) => {
    setResearchingId(id)
    try {
      await submitResearch(() => companyResearchAsync(id))
    } catch {
      setResearchingId(null)
    }
  }

  // Advisor chat — routed through the llm_jobs queue; [ADD/UPDATE/REMOVE_COMPANY]
  // markers are applied server-side by the companies_chat result-hook, so we
  // just refetch the company list.
  const { submit: submitChat } = useContextJobs<{ response: string }>('companies_chat', {
    transform: (raw) => ({ response: (raw.response as string) ?? '' }),
    onResult: (res) => {
      setChatMessages(prev => [...prev, { role: 'assistant', content: res.response }])
      setChatLoading(false)
      load()
    },
    onError: (err) => {
      setChatMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err}` }])
      setChatLoading(false)
    },
  })

  const handleAdvisorSend = async () => {
    if (!chatInput.trim() || chatLoading) return
    const userMsg = chatInput.trim()
    setChatInput('')
    setChatMessages(prev => [...prev, { role: 'user', content: userMsg }])
    setChatLoading(true)
    submitChat(() => companyChatAsync(userMsg))
  }

  if (loading) {
    return <div className="loading-overlay"><span className="loading-spinner" /></div>
  }

  // Render an edit row (used for both new and existing)
  const renderEditRow = (c?: CompanyResponse) => (
    <tr key={c ? `edit-${c.id}` : 'add-row'} style={{ borderLeft: '3px solid var(--accent-emerald)' }}>
      <td>
        <EditInput field="name" editData={editData} setEditData={setEditData} saveEdit={saveEdit} cancelEdit={cancelEdit} />
      </td>
      <td>
        <EditInput field="tier" type="select" options={TIER_ORDER} editData={editData} setEditData={setEditData} saveEdit={saveEdit} cancelEdit={cancelEdit} width="120px" />
      </td>
      <td>
        <EditInput field="location" editData={editData} setEditData={setEditData} saveEdit={saveEdit} cancelEdit={cancelEdit} />
      </td>
      <td className="role-col">
        <EditInput field="role_types" editData={editData} setEditData={setEditData} saveEdit={saveEdit} cancelEdit={cancelEdit} />
      </td>
      <td>
        <EditInput field="careers_url" type="url" editData={editData} setEditData={setEditData} saveEdit={saveEdit} cancelEdit={cancelEdit} width="80px" />
      </td>
      <td className="actions-cell-container">
        <div className="actions-cell" style={{ opacity: 1 }}>
          <button className="action-btn" onClick={saveEdit} title="Save" style={{ color: 'var(--accent-emerald)' }}>✓</button>
          <button className="action-btn" onClick={cancelEdit} title="Cancel">✕</button>
        </div>
      </td>
    </tr>
  )

  return (
    <div className="companies-page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-sm)' }}>
        <h1>Companies <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 400 }}>({totalCount})</span></h1>
        <button className="btn btn-primary" onClick={startAdd} style={{ fontSize: '0.85rem' }}>
          + Add Company
        </button>
      </div>

      {/* Company Advisor Chat */}
      <div className="advisor-section" style={{ marginBottom: 'var(--space-md)' }}>
        <div className="advisor-header" onClick={() => setAdvisorOpen(o => !o)}>
          <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
            🏢 Company Advisor {advisorOpen ? '▾' : '▸'}
          </span>
        </div>

        {advisorOpen && (
          <>
            <div className="chat-messages" ref={chatScrollRef} style={{ padding: 'var(--space-md)', maxHeight: '420px' }}>
              {chatMessages.length === 0 && (
                <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 'var(--space-lg)' }}>
                  Ask me to add companies, change tiers, suggest application order, or discuss strategy.
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={`chat-bubble ${msg.role}`}>
                  {msg.content}
                </div>
              ))}
              {chatLoading && (
                <div className="loading-overlay">
                  <span className="loading-spinner" /> Thinking...
                </div>
              )}
            </div>
            <div className="advisor-input-row">
              <input
                type="text"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                placeholder="e.g. 'Add Bungie as gaming_t2' or 'which companies are actively hiring?'"
                style={{
                  flex: 1,
                  padding: 'var(--space-sm) var(--space-md)',
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-medium)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: '0.9rem',
                }}
                onKeyDown={e => { if (e.key === 'Enter') handleAdvisorSend() }}
              />
              <button className="btn btn-primary" onClick={handleAdvisorSend} disabled={chatLoading}
                style={{ fontSize: '0.85rem', padding: '6px 16px' }}>
                Send
              </button>
            </div>
          </>
        )}
      </div>

      {/* Tier filter chips */}
      <div className="kanban-toolbar">
        {TIER_ORDER.map(tier => (
          <button
            key={tier}
            className={`category-filter-chip${tierFilter === tier ? ' active' : ''}`}
            style={{ '--chip-color': TIER_COLORS[tier] } as React.CSSProperties}
            onClick={() => setTierFilter(prev => prev === tier ? null : tier)}
          >
            {TIER_LABELS[tier]}
          </button>
        ))}
        {tierFilter && (
          <button className="category-filter-chip clear" onClick={() => setTierFilter(null)}>
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div className="data-table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Company</th>
              <th>Tier</th>
              <th>Location</th>
              <th className="role-col">Roles</th>
              <th>Links</th>
              <th className="min-w">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isAdding && renderEditRow()}
            {grouped.map(group => {
              if (group.items.length === 0) return null
              return [
                <tr key={`tier-${group.tier}`} className="tier-group-header">
                  <td colSpan={6}>
                    <span className={`tier-pill tier-pill--${group.tier}`}>{group.label}</span>
                    <span className="tier-count">{group.items.length}</span>
                  </td>
                </tr>,
                ...group.items.flatMap(c => {
                  const rows: React.ReactNode[] = []

                  if (editingId === c.id) {
                    rows.push(renderEditRow(c))
                  } else {
                    rows.push(
                      <tr
                        key={c.id}
                        className="company-row"
                        onClick={() => toggleExpand(c.id)}
                        style={{ '--tier-color': group.color } as React.CSSProperties}
                      >
                        <td className="text-left" style={{ fontWeight: 500 }}>{c.name}</td>
                        <td><span className={`tier-pill tier-pill--${c.tier}`}>{TIER_LABELS[c.tier]?.split(' — ')[1] || c.tier}</span></td>
                        <td style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>{c.location || '—'}</td>
                        <td className="role-col">
                          {c.role_types?.split(',').map((r, i) => (
                            <span key={i} className="role-tag">{r.trim()}</span>
                          ))}
                        </td>
                        <td onClick={e => e.stopPropagation()}>
                          {c.careers_url && (
                            <a href={c.careers_url} target="_blank" rel="noopener noreferrer" className="company-link-btn" title="Careers page">
                              C
                            </a>
                          )}
                          {c.website_url && (
                            <a href={c.website_url} target="_blank" rel="noopener noreferrer" className="company-link-btn" title="Website">
                              W
                            </a>
                          )}
                        </td>
                        <td className="actions-cell-container" onClick={e => e.stopPropagation()}>
                          <div className="actions-cell">
                            <button className="action-btn" onClick={() => startEdit(c)} title="Edit">✏</button>
                            <button className="action-btn delete" onClick={() => handleDelete(c.id)} title="Delete">🗑</button>
                          </div>
                        </td>
                      </tr>
                    )
                  }

                  // Expansion row with structured research
                  if (expandedId === c.id && editingId !== c.id) {
                    const research = parseResearch(c.market_info)
                    rows.push(
                      <tr key={`detail-${c.id}`} className="company-detail-row">
                        <td colSpan={6}>
                          <div className="company-detail-panel">
                            {/* Notes section */}
                            <div className="company-detail-section company-detail-notes">
                              <h4>Notes</h4>
                              <p>{c.notes || '—'}</p>
                            </div>

                            {/* Structured research section */}
                            <div className="company-detail-section company-detail-research">
                              <h4>
                                Market Intelligence
                                {c.market_info_updated_at && (
                                  <span className="detail-updated">Updated {formatUpdated(c.market_info_updated_at)}</span>
                                )}
                              </h4>
                              <ResearchPanel
                                research={research}
                                updatedAt={c.market_info_updated_at}
                                isLoading={researchingId === c.id}
                              />
                            </div>

                            {/* Actions */}
                            <div className="company-detail-actions">
                              <button
                                className="btn btn-ghost"
                                onClick={() => handleResearch(c.id)}
                                disabled={researchingId === c.id}
                                style={{ fontSize: '0.82rem' }}
                              >
                                {researchingId === c.id ? (
                                  <><span className="loading-spinner" style={{ width: 14, height: 14 }} /> Researching...</>
                                ) : (
                                  c.market_info ? 'Refresh Research' : 'Research with AI'
                                )}
                              </button>
                              <button
                                className="btn btn-ghost"
                                onClick={() => startEdit(c)}
                                style={{ fontSize: '0.82rem' }}
                              >
                                Edit Details
                              </button>
                              <button
                                className="btn btn-ghost"
                                onClick={() => navigate(`/jobs/applications?new=true&companyId=${c.id}&companyName=${encodeURIComponent(c.name)}`)}
                                style={{ fontSize: '0.82rem' }}
                              >
                                Start Application
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )
                  }

                  return rows
                }),
              ]
            })}
          </tbody>
        </table>
      </div>

    </div>
  )
}
