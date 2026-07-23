/**
 * Applications — Job application tracker with status pipeline,
 * expandable detail rows, event timeline, and AI advisor chat.
 */

import { useState, useEffect, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  listApplications, createApplication, updateApplication, deleteApplication,
  getApplicationStats, applicationChatAsync, getApplicationChatHistory,
  listCompanies,
  type ApplicationResponse, type ApplicationCreate, type ApplicationUpdate,
  type ApplicationStats, type CompanyResponse,
} from '../../api'
import { useContextJobs } from '../../useContextJobs'

// ==========================================
// Constants
// ==========================================

const STATUS_ORDER = [
  'researching', 'applied', 'phone_screen', 'technical',
  'final', 'offer', 'rejected', 'withdrawn',
]

const STATUS_LABELS: Record<string, string> = {
  researching: 'Researching',
  applied: 'Applied',
  phone_screen: 'Phone Screen',
  technical: 'Technical',
  final: 'Final',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
}

const STATUS_COLORS: Record<string, string> = {
  researching: 'var(--accent-sky)',
  applied: 'var(--accent-indigo)',
  phone_screen: 'var(--accent-violet)',
  technical: 'var(--accent-purple)',
  final: 'var(--accent-pink)',
  offer: 'var(--accent-emerald)',
  rejected: 'var(--accent-rose)',
  withdrawn: 'var(--text-muted)',
}

const CLOSED_STATUSES = new Set(['offer', 'rejected', 'withdrawn'])

// ==========================================
// Helpers
// ==========================================

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—'
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
}

function formatTimestamp(dateStr: string) {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

// ==========================================
// Status Chip
// ==========================================

function StatusChip({ status }: { status: string }) {
  const color = STATUS_COLORS[status] || 'var(--text-muted)'
  return (
    <span
      className="app-status-chip"
      style={{
        background: `color-mix(in srgb, ${color} 20%, transparent)`,
        color: color,
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
      }}
    >
      {STATUS_LABELS[status] || status}
    </span>
  )
}

// ==========================================
// Main Component
// ==========================================

export default function Applications() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()

  // Data state
  const [applications, setApplications] = useState<ApplicationResponse[]>([])
  const [stats, setStats] = useState<ApplicationStats | null>(null)
  const [companies, setCompanies] = useState<CompanyResponse[]>([])
  const [loading, setLoading] = useState(true)

  // UI state
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [hideClosed, setHideClosed] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalPrefill, setModalPrefill] = useState<{ companyId?: number; companyName?: string } | null>(null)

  // Advisor chat state
  const [advisorOpen, setAdvisorOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<{ role: string; content: string }[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatLoaded, setChatLoaded] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement>(null)

  // ==========================================
  // Data loading
  // ==========================================

  const load = async () => {
    try {
      const [apps, s, comps] = await Promise.all([
        listApplications(undefined, true),
        getApplicationStats(),
        listCompanies(),
      ])
      setApplications(apps)
      setStats(s)
      setCompanies(comps)
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // Check query params for "Start Application" from Companies page
  useEffect(() => {
    if (searchParams.get('new') === 'true') {
      const prefill: { companyId?: number; companyName?: string } = {}
      const cid = searchParams.get('companyId')
      const cname = searchParams.get('companyName')
      if (cid) prefill.companyId = parseInt(cid)
      if (cname) prefill.companyName = cname
      setModalPrefill(prefill)
      setModalOpen(true)
      setSearchParams({})
    }
  }, [searchParams, setSearchParams])

  // Lazy-load chat history
  useEffect(() => {
    if (advisorOpen && !chatLoaded) {
      setChatLoaded(true)
      getApplicationChatHistory(50).then(msgs => {
        setChatMessages(msgs.map(m => ({ role: m.role, content: m.content })))
      }).catch(() => {})
    }
  }, [advisorOpen, chatLoaded])

  // Auto-scroll chat
  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [chatMessages])

  // ==========================================
  // Filtering
  // ==========================================

  const filteredApps = applications.filter(a => {
    if (statusFilter && a.status !== statusFilter) return false
    if (hideClosed && CLOSED_STATUSES.has(a.status)) return false
    return true
  })

  // ==========================================
  // Handlers
  // ==========================================

  const handleStatusChange = async (app: ApplicationResponse, newStatus: string) => {
    try {
      await updateApplication(app.id, { status: newStatus } as ApplicationUpdate)
      await load()
    } catch { /* ignore */ }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this application? This cannot be undone.')) return
    try {
      await deleteApplication(id)
      setExpandedId(null)
      await load()
    } catch { /* ignore */ }
  }

  const handleCreate = async (data: ApplicationCreate) => {
    try {
      await createApplication(data)
      setModalOpen(false)
      setModalPrefill(null)
      await load()
    } catch { /* ignore */ }
  }

  const handleFieldUpdate = async (id: number, field: string, value: string) => {
    try {
      await updateApplication(id, { [field]: value } as ApplicationUpdate)
      await load()
    } catch { /* ignore */ }
  }

  // Advisor chat — routed through the llm_jobs queue; [CREATE_APP]/[ADVANCE_APP]/
  // [UPDATE_APP] markers are applied server-side by the applications_chat
  // result-hook, so we just refetch the application list.
  const { submit: submitChat } = useContextJobs<{ response: string }>('applications_chat', {
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
    submitChat(() => applicationChatAsync(userMsg))
  }

  if (loading) {
    return <div className="loading-overlay"><span className="loading-spinner" /></div>
  }

  return (
    <div className="applications-page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-sm)' }}>
        <h1>Applications <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 400 }}>({stats?.total || 0})</span></h1>
        <button className="btn btn-primary" onClick={() => { setModalPrefill(null); setModalOpen(true) }} style={{ fontSize: '0.85rem' }}>
          + New Application
        </button>
      </div>

      {/* Advisor Chat Panel */}
      <div className="advisor-section" style={{ marginBottom: 'var(--space-md)' }}>
        <div className="advisor-header" onClick={() => setAdvisorOpen(o => !o)}>
          <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
            Application Advisor {advisorOpen ? '▾' : '▸'}
          </span>
        </div>

        {advisorOpen && (
          <>
            <div className="chat-messages" ref={chatScrollRef} style={{ padding: 'var(--space-md)', maxHeight: '420px' }}>
              {chatMessages.length === 0 && (
                <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 'var(--space-lg)' }}>
                  Tell me about application updates, interview progress, or ask for pipeline strategy.
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
                placeholder="e.g. 'Applied to Riot Games for Senior Backend' or 'got a callback from EA'"
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

      {/* Stats Row */}
      {stats && (
        <div className="app-stats-row">
          <button
            className={`app-stat-chip${!statusFilter ? ' active' : ''}`}
            onClick={() => setStatusFilter(null)}
            style={{ '--chip-color': 'var(--text-secondary)' } as React.CSSProperties}
          >
            {stats.active} Active
          </button>
          {STATUS_ORDER.map(s => {
            const count = stats.by_status[s] || 0
            if (count === 0) return null
            return (
              <button
                key={s}
                className={`app-stat-chip${statusFilter === s ? ' active' : ''}`}
                style={{ '--chip-color': STATUS_COLORS[s] } as React.CSSProperties}
                onClick={() => setStatusFilter(prev => prev === s ? null : s)}
              >
                {count} {STATUS_LABELS[s]}
              </button>
            )
          })}
          {stats.response_rate > 0 && (
            <span className="app-stat-chip" style={{ '--chip-color': 'var(--accent-emerald)', cursor: 'default', opacity: 0.7 } as React.CSSProperties}>
              {stats.response_rate}% Response
            </span>
          )}
        </div>
      )}

      {/* Filter Bar */}
      <div className="kanban-toolbar">
        <button
          className={`category-filter-chip${hideClosed ? ' active' : ''}`}
          style={{ '--chip-color': 'var(--text-secondary)' } as React.CSSProperties}
          onClick={() => setHideClosed(h => !h)}
        >
          {hideClosed ? 'Show Closed' : 'Hide Closed'}
        </button>
        {statusFilter && (
          <button className="category-filter-chip clear" onClick={() => setStatusFilter(null)}>
            Clear Filter
          </button>
        )}
      </div>

      {/* Applications Table */}
      <div className="data-table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Company</th>
              <th style={{ textAlign: 'left' }}>Job Title</th>
              <th>Status</th>
              <th>Salary</th>
              <th>Applied</th>
            </tr>
          </thead>
          <tbody>
            {filteredApps.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 'var(--space-xl)' }}>
                  No applications yet. Click "+ New Application" or use the advisor to get started.
                </td>
              </tr>
            )}
            {filteredApps.map(app => {
              const isClosed = CLOSED_STATUSES.has(app.status)
              const isExpanded = expandedId === app.id
              return [
                <tr
                  key={app.id}
                  className="company-row"
                  onClick={() => setExpandedId(prev => prev === app.id ? null : app.id)}
                  style={{
                    opacity: isClosed ? 0.5 : 1,
                    '--tier-color': STATUS_COLORS[app.status],
                  } as React.CSSProperties}
                >
                  <td className="text-left" style={{ fontWeight: 500 }}>
                    {app.company_id ? (
                      <span
                        className="app-company-link"
                        onClick={e => { e.stopPropagation(); navigate('/jobs/companies') }}
                      >
                        {app.company_name}
                      </span>
                    ) : (
                      app.company_name
                    )}
                  </td>
                  <td className="text-left" style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                    {app.job_title}
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    <select
                      className="app-status-select"
                      value={app.status}
                      onChange={e => handleStatusChange(app, e.target.value)}
                      style={{
                        color: STATUS_COLORS[app.status],
                        borderColor: `color-mix(in srgb, ${STATUS_COLORS[app.status]} 40%, transparent)`,
                      }}
                    >
                      {STATUS_ORDER.map(s => (
                        <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                      ))}
                    </select>
                  </td>
                  <td style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                    {app.salary_range || '—'}
                  </td>
                  <td style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                    {formatDate(app.applied_date)}
                  </td>
                </tr>,

                // Expanded detail row
                isExpanded && (
                  <tr key={`detail-${app.id}`} className="company-detail-row">
                    <td colSpan={5}>
                      <div className="company-detail-panel">
                        {/* Detail fields */}
                        <div className="app-detail-grid">
                          <div className="app-detail-field">
                            <label>Recruiter</label>
                            <input
                              type="text"
                              defaultValue={app.recruiter_name || ''}
                              placeholder="Recruiter name"
                              onBlur={e => {
                                if (e.target.value !== (app.recruiter_name || ''))
                                  handleFieldUpdate(app.id, 'recruiter_name', e.target.value)
                              }}
                              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                            />
                          </div>
                          <div className="app-detail-field">
                            <label>Salary Range</label>
                            <input
                              type="text"
                              defaultValue={app.salary_range || ''}
                              placeholder="e.g. $180-220k"
                              onBlur={e => {
                                if (e.target.value !== (app.salary_range || ''))
                                  handleFieldUpdate(app.id, 'salary_range', e.target.value)
                              }}
                              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                            />
                          </div>
                          <div className="app-detail-field">
                            <label>Posting URL</label>
                            <div style={{ display: 'flex', gap: 'var(--space-xs)', alignItems: 'center' }}>
                              <input
                                type="url"
                                defaultValue={app.posting_url || ''}
                                placeholder="https://..."
                                style={{ flex: 1 }}
                                onBlur={e => {
                                  if (e.target.value !== (app.posting_url || ''))
                                    handleFieldUpdate(app.id, 'posting_url', e.target.value)
                                }}
                                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                              />
                              {app.posting_url && (
                                <a href={app.posting_url} target="_blank" rel="noopener noreferrer"
                                  className="company-link-btn" title="Open posting">
                                  ↗
                                </a>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Notes */}
                        <div className="app-detail-field" style={{ marginTop: 'var(--space-sm)' }}>
                          <label>Notes</label>
                          <textarea
                            defaultValue={app.notes || ''}
                            placeholder="Application notes..."
                            rows={2}
                            style={{ width: '100%', resize: 'vertical' }}
                            onBlur={e => {
                              if (e.target.value !== (app.notes || ''))
                                handleFieldUpdate(app.id, 'notes', e.target.value)
                            }}
                          />
                        </div>

                        {/* Event Timeline */}
                        {app.events && app.events.length > 0 && (
                          <div className="app-timeline">
                            <h4>Timeline</h4>
                            <div className="app-timeline-list">
                              {app.events.slice(0, 5).map(event => (
                                <div key={event.id} className="app-timeline-item">
                                  <div className="app-timeline-dot" style={{ background: STATUS_COLORS[event.status] || 'var(--text-muted)' }} />
                                  <div className="app-timeline-content">
                                    <StatusChip status={event.status} />
                                    <span className="app-timeline-time">{formatTimestamp(event.created_at)}</span>
                                    {event.note && <span className="app-timeline-note">{event.note}</span>}
                                  </div>
                                </div>
                              ))}
                              {app.events.length > 5 && (
                                <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', paddingLeft: '20px' }}>
                                  + {app.events.length - 5} more events
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Actions */}
                        <div className="company-detail-actions">
                          <button
                            className="btn btn-ghost"
                            onClick={() => handleDelete(app.id)}
                            style={{ fontSize: '0.82rem', color: 'var(--accent-rose)' }}
                          >
                            Delete Application
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ),
              ]
            })}
          </tbody>
        </table>
      </div>

      {/* Create Application Modal */}
      {modalOpen && (
        <CreateApplicationModal
          companies={companies}
          prefill={modalPrefill}
          onSave={handleCreate}
          onClose={() => { setModalOpen(false); setModalPrefill(null) }}
        />
      )}
    </div>
  )
}


// ==========================================
// Create Application Modal
// ==========================================

function CreateApplicationModal({ companies, prefill, onSave, onClose }: {
  companies: CompanyResponse[]
  prefill: { companyId?: number; companyName?: string } | null
  onSave: (data: ApplicationCreate) => void
  onClose: () => void
}) {
  const [companyMode, setCompanyMode] = useState<'list' | 'freetext'>(
    prefill?.companyId ? 'list' : 'list'
  )
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(prefill?.companyId || null)
  const [companyName, setCompanyName] = useState(prefill?.companyName || '')
  const [jobTitle, setJobTitle] = useState('')
  const [status, setStatus] = useState('researching')
  const [salaryRange, setSalaryRange] = useState('')
  const [postingUrl, setPostingUrl] = useState('')
  const [recruiterName, setRecruiterName] = useState('')
  const [notes, setNotes] = useState('')

  const handleSave = () => {
    const name = companyMode === 'list' && selectedCompanyId
      ? (companies.find(c => c.id === selectedCompanyId)?.name || companyName)
      : companyName.trim()
    if (!name || !jobTitle.trim()) return

    onSave({
      company_id: companyMode === 'list' ? selectedCompanyId : null,
      company_name: name,
      job_title: jobTitle.trim(),
      status,
      salary_range: salaryRange || undefined,
      posting_url: postingUrl || undefined,
      recruiter_name: recruiterName || undefined,
      notes: notes || undefined,
    })
  }

  return (
    <div className="task-modal-overlay" onClick={onClose}>
      <div className="task-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '500px' }}>
        <h3 style={{ marginBottom: 'var(--space-md)' }}>New Application</h3>

        <label className="task-modal-label">Company</label>
        <div style={{ display: 'flex', gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)' }}>
          <button
            className={`category-filter-chip${companyMode === 'list' ? ' active' : ''}`}
            style={{ '--chip-color': 'var(--accent-indigo)', fontSize: '0.75rem' } as React.CSSProperties}
            onClick={() => setCompanyMode('list')}
          >
            From List
          </button>
          <button
            className={`category-filter-chip${companyMode === 'freetext' ? ' active' : ''}`}
            style={{ '--chip-color': 'var(--accent-sky)', fontSize: '0.75rem' } as React.CSSProperties}
            onClick={() => setCompanyMode('freetext')}
          >
            Other
          </button>
        </div>

        {companyMode === 'list' ? (
          <select
            className="task-modal-input"
            value={selectedCompanyId || ''}
            onChange={e => {
              const id = parseInt(e.target.value)
              setSelectedCompanyId(id || null)
              const c = companies.find(c => c.id === id)
              if (c) setCompanyName(c.name)
            }}
          >
            <option value="">Select a company...</option>
            {companies.map(c => (
              <option key={c.id} value={c.id}>{c.name} ({c.tier})</option>
            ))}
          </select>
        ) : (
          <input
            className="task-modal-input"
            value={companyName}
            onChange={e => setCompanyName(e.target.value)}
            placeholder="Company name"
          />
        )}

        <label className="task-modal-label">Job Title *</label>
        <input
          className="task-modal-input"
          value={jobTitle}
          onChange={e => setJobTitle(e.target.value)}
          placeholder="e.g. Senior Backend Engineer"
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
        />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-sm)' }}>
          <div>
            <label className="task-modal-label">Status</label>
            <select className="task-modal-input" value={status} onChange={e => setStatus(e.target.value)}>
              {STATUS_ORDER.map(s => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="task-modal-label">Salary Range</label>
            <input
              className="task-modal-input"
              value={salaryRange}
              onChange={e => setSalaryRange(e.target.value)}
              placeholder="e.g. $180-220k"
            />
          </div>
        </div>

        <label className="task-modal-label">Posting URL</label>
        <input
          className="task-modal-input"
          value={postingUrl}
          onChange={e => setPostingUrl(e.target.value)}
          placeholder="https://..."
        />

        <label className="task-modal-label">Recruiter Name</label>
        <input
          className="task-modal-input"
          value={recruiterName}
          onChange={e => setRecruiterName(e.target.value)}
          placeholder="Recruiter name"
        />

        <label className="task-modal-label">Notes</label>
        <textarea
          className="task-modal-input"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={2}
          placeholder="Additional details..."
        />

        <div style={{ display: 'flex', gap: 'var(--space-sm)', justifyContent: 'flex-end', marginTop: 'var(--space-md)' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}
            disabled={!jobTitle.trim() || (companyMode === 'list' ? !selectedCompanyId : !companyName.trim())}>
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
