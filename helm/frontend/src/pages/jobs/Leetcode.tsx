/**
 * Leetcode — Problem tracker grouped by category with progress bars,
 * focus category selector, AI advisor, and per-problem Learning Mode hints.
 */

import { useState, useEffect, useRef } from 'react'
import {
  listLeetcodeProblems, createLeetcodeProblem, updateLeetcodeProblem, deleteLeetcodeProblem,
  getLeetcodeStats, leetcodeChatAsync, getLeetcodeChatHistory, seedNeetcode150, getUpNext,
  type LeetcodeProblemResponse, type LeetcodeProblemCreate, type LeetcodeProblemUpdate,
  type LeetcodeStats, type UpNextRecommendation,
} from '../../api'
import { useContextJobs } from '../../useContextJobs'

// ==========================================
// Constants
// ==========================================

const CATEGORIES = [
  'Arrays & Hashing', 'Two Pointers', 'Sliding Window', 'Stack',
  'Binary Search', 'Linked List', 'Trees', 'Tries',
  'Heap / Priority Queue', 'Backtracking', 'Graphs', 'Advanced Graphs',
  '1-D Dynamic Programming', '2-D Dynamic Programming',
  'Greedy', 'Intervals', 'Math & Geometry', 'Bit Manipulation',
]

const DIFFICULTY_COLORS: Record<string, string> = {
  Easy: 'var(--accent-emerald)',
  Medium: 'var(--accent-amber)',
  Hard: 'var(--accent-rose)',
}

const STATUS_ICONS: Record<string, string> = {
  todo: '\u25CB',       // ○
  attempted: '\u25D0',  // ◐
  solved: '\u25CF',     // ●
}

const DIFFICULTY_ORDER: Record<string, number> = { Easy: 0, Medium: 1, Hard: 2 }

// ==========================================
// Main Component
// ==========================================

export default function Leetcode() {
  // Data state
  const [problems, setProblems] = useState<LeetcodeProblemResponse[]>([])
  const [stats, setStats] = useState<LeetcodeStats | null>(null)
  const [loading, setLoading] = useState(true)

  // UI state
  const [difficultyFilter, setDifficultyFilter] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [focusCategory, setFocusCategory] = useState<string | null>(
    () => localStorage.getItem('leetcode_focus_category')
  )
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())
  const [modalOpen, setModalOpen] = useState(false)

  // Advisor / Hint state
  const [advisorOpen, setAdvisorOpen] = useState(false)
  const [hintProblemId, setHintProblemId] = useState<number | null>(null)
  const [hintProblemName, setHintProblemName] = useState('')
  const [chatMessages, setChatMessages] = useState<{ role: string; content: string }[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatLoaded, setChatLoaded] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement>(null)

  // View mode & Up Next
  const [viewMode, setViewMode] = useState<'problems' | 'studyplan'>('problems')
  const [upNextRecs, setUpNextRecs] = useState<UpNextRecommendation[]>([])
  const [seeding, setSeeding] = useState(false)

  // ==========================================
  // Data loading
  // ==========================================

  const loadUpNext = async () => {
    try {
      const res = await getUpNext(focusCategory ?? undefined)
      setUpNextRecs(res.recommendations)
    } catch { /* ignore */ }
  }

  const load = async () => {
    try {
      const [probs, s] = await Promise.all([
        listLeetcodeProblems(),
        getLeetcodeStats(),
      ])
      setProblems(probs)
      setStats(s)
    } catch { /* ignore */ }
    setLoading(false)
    loadUpNext()
  }

  useEffect(() => { load() }, [])

  // Persist focus category
  const focusMounted = useRef(false)
  useEffect(() => {
    if (focusCategory) {
      localStorage.setItem('leetcode_focus_category', focusCategory)
    } else {
      localStorage.removeItem('leetcode_focus_category')
    }
    if (focusMounted.current) loadUpNext()
    else focusMounted.current = true
  }, [focusCategory])

  // Lazy-load chat history (reloads when switching modes)
  useEffect(() => {
    if (advisorOpen && !chatLoaded) {
      setChatLoaded(true)
      getLeetcodeChatHistory(hintProblemId ?? undefined, 50).then(msgs => {
        setChatMessages(msgs.map(m => ({ role: m.role, content: m.content })))
      }).catch(() => {})
    }
  }, [advisorOpen, chatLoaded, hintProblemId])

  // Auto-scroll chat
  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [chatMessages])

  // ==========================================
  // Filtering and grouping
  // ==========================================

  const filteredProblems = problems.filter(p => {
    if (difficultyFilter && p.difficulty !== difficultyFilter) return false
    if (statusFilter && p.status !== statusFilter) return false
    return true
  })

  // Group by category
  const grouped = new Map<string, LeetcodeProblemResponse[]>()
  for (const p of filteredProblems) {
    if (!grouped.has(p.category)) grouped.set(p.category, [])
    grouped.get(p.category)!.push(p)
  }

  // Sort categories: focused first, then alphabetical
  const sortedCategories = [...grouped.keys()].sort((a, b) => {
    if (a === focusCategory) return -1
    if (b === focusCategory) return 1
    return a.localeCompare(b)
  })

  // ==========================================
  // Handlers
  // ==========================================

  const handleStatusChange = async (id: number, newStatus: string) => {
    try {
      await updateLeetcodeProblem(id, { status: newStatus } as LeetcodeProblemUpdate)
      await load()
    } catch { /* ignore */ }
  }

  const handleSoloChange = async (id: number, checked: boolean) => {
    try {
      await updateLeetcodeProblem(id, { solved_without_help: checked })
      await load()
    } catch { /* ignore */ }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this problem?')) return
    try {
      await deleteLeetcodeProblem(id)
      await load()
    } catch { /* ignore */ }
  }

  const handleCreate = async (data: LeetcodeProblemCreate) => {
    try {
      await createLeetcodeProblem(data)
      setModalOpen(false)
      await load()
    } catch { /* ignore */ }
  }

  const handleSeed = async () => {
    setSeeding(true)
    try {
      await seedNeetcode150()
      await load()
    } catch { /* ignore */ }
    setSeeding(false)
  }

  const toggleCategory = (cat: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  // Hints / Learning Mode
  const enterLearningMode = (problem: LeetcodeProblemResponse) => {
    setHintProblemId(problem.id)
    setHintProblemName(problem.name)
    setChatMessages([])
    setChatLoaded(false)
    setAdvisorOpen(true)
  }

  const exitLearningMode = () => {
    setHintProblemId(null)
    setHintProblemName('')
    setChatMessages([])
    setChatLoaded(false)
  }

  // Advisor chat — routed through the llm_jobs queue; [ADD_PROBLEM] markers
  // (general mode only) are applied server-side by the leetcode_chat
  // result-hook, so we just refetch problems.
  const { submit: submitChat } = useContextJobs<{ response: string }>('leetcode_chat', {
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
    submitChat(() => leetcodeChatAsync(userMsg, hintProblemId ?? undefined))
  }

  if (loading) {
    return <div className="loading-overlay"><span className="loading-spinner" /></div>
  }

  return (
    <div className="leetcode-page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-sm)' }}>
        <h1>Leetcode <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 400 }}>({stats?.total || 0})</span></h1>
        <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
          {problems.filter(p => p.neetcode_order != null).length < 50 && (
            <button className="btn btn-ghost" onClick={handleSeed} disabled={seeding} style={{ fontSize: '0.82rem' }}>
              {seeding ? 'Importing...' : 'Import NeetCode 150'}
            </button>
          )}
          <button className="btn btn-primary" onClick={() => setModalOpen(true)} style={{ fontSize: '0.85rem' }}>
            + Add Problem
          </button>
        </div>
      </div>

      {/* Advisor / Hint Panel */}
      <div className="advisor-section" style={{ marginBottom: 'var(--space-md)' }}>
        <div className="advisor-header" onClick={() => setAdvisorOpen(o => !o)}>
          <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
            {hintProblemId
              ? `Hints: ${hintProblemName}`
              : 'Leetcode Advisor'
            } {advisorOpen ? '▾' : '▸'}
          </span>
          {hintProblemId && advisorOpen && (
            <button
              className="btn btn-ghost"
              onClick={e => { e.stopPropagation(); exitLearningMode() }}
              style={{ fontSize: '0.75rem', marginLeft: 'auto', padding: '2px 8px' }}
            >
              Exit Learning Mode
            </button>
          )}
        </div>

        {advisorOpen && (
          <>
            {hintProblemId && (
              <div className="lc-learning-mode-banner">
                Learning Mode — Getting progressive hints for <strong>{hintProblemName}</strong>
              </div>
            )}
            <div className="chat-messages" ref={chatScrollRef} style={{ padding: 'var(--space-md)', maxHeight: '420px' }}>
              {chatMessages.length === 0 && (
                <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 'var(--space-lg)' }}>
                  {hintProblemId
                    ? "Describe what you've tried or where you're stuck. I'll give you a hint without spoiling the solution."
                    : 'Ask me to suggest problems, add problems to your tracker, or discuss patterns and strategy.'
                  }
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
                placeholder={hintProblemId
                  ? "What have you tried? Where are you stuck?"
                  : "e.g. 'Add Two Sum' or 'what pattern should I focus on?'"
                }
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

      {/* Mode Toggle */}
      <div className="lc-mode-toggle">
        <button
          className={`lc-mode-tab${viewMode === 'problems' ? ' active' : ''}`}
          onClick={() => setViewMode('problems')}
        >
          Problems
        </button>
        <button
          className={`lc-mode-tab${viewMode === 'studyplan' ? ' active' : ''}`}
          onClick={() => setViewMode('studyplan')}
        >
          Study Plan
        </button>
      </div>

      {/* Up Next Recommendations */}
      {upNextRecs.length === 0 && problems.some(p => p.neetcode_order != null) && problems.filter(p => p.neetcode_order != null && p.status !== 'solved').length === 0 && (
        <div className="lc-up-next" style={{ textAlign: 'center', padding: 'var(--space-md)', color: 'var(--accent-emerald)' }}>
          All NeetCode 150 problems solved! You're ready.
        </div>
      )}
      {upNextRecs.length > 0 && (
        <div className="lc-up-next">
          <span className="lc-up-next-label">Up Next</span>
          <div className="lc-up-next-cards">
            {upNextRecs.map(rec => (
              <button
                key={rec.problem.id}
                className="lc-up-next-card"
                onClick={() => enterLearningMode(rec.problem)}
              >
                <div className="lc-up-next-card-top">
                  <span className="lc-up-next-name">
                    {rec.problem.number ? `#${rec.problem.number} ` : ''}{rec.problem.name}
                  </span>
                  <span className="lc-difficulty-chip" style={{
                    color: DIFFICULTY_COLORS[rec.problem.difficulty],
                    background: `color-mix(in srgb, ${DIFFICULTY_COLORS[rec.problem.difficulty]} 15%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${DIFFICULTY_COLORS[rec.problem.difficulty]} 30%, transparent)`,
                    fontSize: '0.7rem', padding: '1px 6px',
                  }}>
                    {rec.problem.difficulty}
                  </span>
                </div>
                <span className="lc-up-next-category">{rec.problem.category}</span>
                <span className="lc-up-next-reason">{rec.reason}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {viewMode === 'problems' && (
      <>
      {/* Focus Category Selector */}
      <div className="lc-focus-bar">
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginRight: 'var(--space-sm)' }}>Focus:</span>
        <div className="lc-focus-chips">
          {CATEGORIES.map(cat => (
            <button
              key={cat}
              className={`lc-focus-chip${focusCategory === cat ? ' focused' : ''}`}
              onClick={() => setFocusCategory(prev => prev === cat ? null : cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Stats Row */}
      {stats && (
        <div className="lc-stats-row">
          <span className="lc-stat">
            <strong>{stats.solved}</strong> Solved / <strong>{stats.total}</strong> Total
          </span>
          <span className="lc-stat-divider">|</span>
          <span className="lc-stat">
            <strong>{stats.solved_without_help}</strong> Solo
          </span>
          <span className="lc-stat-divider">|</span>
          <span className="lc-stat">
            Streak: <strong>{stats.streak}</strong> day{stats.streak !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {/* Filter Bar */}
      <div className="kanban-toolbar">
        {['Easy', 'Medium', 'Hard'].map(d => (
          <button
            key={d}
            className={`category-filter-chip${difficultyFilter === d ? ' active' : ''}`}
            style={{ '--chip-color': DIFFICULTY_COLORS[d] } as React.CSSProperties}
            onClick={() => setDifficultyFilter(prev => prev === d ? null : d)}
          >
            {d}
          </button>
        ))}
        <span style={{ width: '1px', height: '20px', background: 'var(--border-medium)', margin: '0 var(--space-xs)' }} />
        {['todo', 'attempted', 'solved'].map(s => (
          <button
            key={s}
            className={`category-filter-chip${statusFilter === s ? ' active' : ''}`}
            style={{ '--chip-color': 'var(--accent-indigo)' } as React.CSSProperties}
            onClick={() => setStatusFilter(prev => prev === s ? null : s)}
          >
            {STATUS_ICONS[s]} {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
        {(difficultyFilter || statusFilter) && (
          <button className="category-filter-chip clear" onClick={() => { setDifficultyFilter(null); setStatusFilter(null) }}>
            Clear
          </button>
        )}
      </div>

      {/* Problem Sections (grouped by category) */}
      {sortedCategories.length === 0 && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 'var(--space-xl)' }}>
          No problems yet. Click "+ Add Problem" or use the advisor to get started.
        </div>
      )}

      {sortedCategories.map(category => {
        const catProblems = grouped.get(category)!
        const isCollapsed = collapsedCategories.has(category)
        const isFocused = focusCategory === category

        // Category progress from stats
        const catStats = stats?.by_category[category]
        const catTotal = catStats?.total || catProblems.length
        const catSolved = catStats?.solved || 0
        const progressPct = catTotal > 0 ? (catSolved / catTotal) * 100 : 0

        return (
          <div key={category} className={`lc-category-section${isFocused ? ' lc-focused' : ''}`}>
            <div className="lc-category-header" onClick={() => toggleCategory(category)}>
              <span className="lc-category-chevron">{isCollapsed ? '▸' : '▾'}</span>
              <span className="lc-category-name">{category}</span>
              <div className="lc-progress-bar">
                <div className="lc-progress-fill" style={{ width: `${progressPct}%` }} />
              </div>
              <span className="lc-category-fraction">{catSolved}/{catTotal}</span>
            </div>

            {!isCollapsed && (
              <table className="data-table lc-problem-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', width: '40%' }}>Problem</th>
                    <th style={{ width: '50px' }}>#</th>
                    <th style={{ width: '80px' }}>Difficulty</th>
                    <th style={{ width: '100px' }}>Status</th>
                    <th style={{ width: '50px' }}>Solo</th>
                    <th style={{ width: '70px' }}>Hints</th>
                    <th style={{ width: '40px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {catProblems.map(p => (
                    <tr key={p.id} style={{ opacity: p.status === 'solved' ? 0.7 : 1 }}>
                      <td className="text-left" style={{ fontWeight: 500 }}>
                        {p.url ? (
                          <a href={p.url} target="_blank" rel="noopener noreferrer"
                            className="app-company-link"
                            onClick={e => e.stopPropagation()}>
                            {p.name}
                          </a>
                        ) : (
                          p.name
                        )}
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                        {p.number || '—'}
                      </td>
                      <td>
                        <span className="lc-difficulty-chip" style={{
                          color: DIFFICULTY_COLORS[p.difficulty],
                          background: `color-mix(in srgb, ${DIFFICULTY_COLORS[p.difficulty]} 15%, transparent)`,
                          border: `1px solid color-mix(in srgb, ${DIFFICULTY_COLORS[p.difficulty]} 30%, transparent)`,
                        }}>
                          {p.difficulty}
                        </span>
                      </td>
                      <td>
                        <select
                          className="app-status-select"
                          value={p.status}
                          onChange={e => handleStatusChange(p.id, e.target.value)}
                          style={{
                            color: p.status === 'solved' ? 'var(--accent-emerald)'
                              : p.status === 'attempted' ? 'var(--accent-amber)'
                              : 'var(--text-muted)',
                          }}
                        >
                          <option value="todo">{STATUS_ICONS.todo} Todo</option>
                          <option value="attempted">{STATUS_ICONS.attempted} Attempted</option>
                          <option value="solved">{STATUS_ICONS.solved} Solved</option>
                        </select>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={p.solved_without_help}
                          disabled={p.status !== 'solved'}
                          onChange={e => handleSoloChange(p.id, e.target.checked)}
                          className="lc-solo-checkbox"
                        />
                      </td>
                      <td>
                        <button
                          className="btn btn-ghost lc-hint-btn"
                          onClick={() => enterLearningMode(p)}
                          title="Get hints"
                        >
                          Hints
                        </button>
                      </td>
                      <td>
                        <button
                          className="action-btn delete"
                          onClick={() => handleDelete(p.id)}
                          title="Delete"
                          style={{ fontSize: '0.75rem' }}
                        >
                          x
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )
      })}

      </>
      )}

      {viewMode === 'studyplan' && (() => {
        const upNextIds = new Set(upNextRecs.map(r => r.problem.id))
        return (
          <div className="lc-study-plan">
            {CATEGORIES.map(category => {
              const catProblems = problems
                .filter(p => p.category === category && p.neetcode_order != null)
                .sort((a, b) => {
                  const da = DIFFICULTY_ORDER[a.difficulty] ?? 99
                  const db2 = DIFFICULTY_ORDER[b.difficulty] ?? 99
                  if (da !== db2) return da - db2
                  return (a.neetcode_order ?? 999) - (b.neetcode_order ?? 999)
                })

              if (catProblems.length === 0) return null

              const solved = catProblems.filter(p => p.status === 'solved').length
              const total = catProblems.length
              const progressPct = total > 0 ? (solved / total) * 100 : 0

              return (
                <div key={category} className="lc-category-section">
                  <div className="lc-category-header">
                    <span className="lc-category-name">{category}</span>
                    <div className="lc-progress-bar">
                      <div className="lc-progress-fill" style={{ width: `${progressPct}%` }} />
                    </div>
                    <span className="lc-category-fraction">{solved}/{total}</span>
                  </div>

                  <table className="data-table lc-problem-table">
                    <thead>
                      <tr>
                        <th style={{ width: '30px' }}></th>
                        <th style={{ textAlign: 'left', width: '40%' }}>Problem</th>
                        <th style={{ width: '50px' }}>#</th>
                        <th style={{ width: '80px' }}>Difficulty</th>
                        <th style={{ width: '100px' }}>Status</th>
                        <th style={{ width: '50px' }}>Solo</th>
                        <th style={{ width: '70px' }}>Hints</th>
                      </tr>
                    </thead>
                    <tbody>
                      {catProblems.map(p => (
                        <tr
                          key={p.id}
                          className={`${p.status === 'solved' ? 'lc-solved-muted' : ''}${upNextIds.has(p.id) ? ' lc-up-next-highlight' : ''}`}
                        >
                          <td style={{ textAlign: 'center', fontSize: '0.85rem' }}>
                            {STATUS_ICONS[p.status]}
                          </td>
                          <td className="text-left" style={{ fontWeight: 500 }}>
                            {p.url ? (
                              <a href={p.url} target="_blank" rel="noopener noreferrer" className="app-company-link">
                                {p.name}
                              </a>
                            ) : p.name}
                          </td>
                          <td style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                            {p.number || '\u2014'}
                          </td>
                          <td>
                            <span className="lc-difficulty-chip" style={{
                              color: DIFFICULTY_COLORS[p.difficulty],
                              background: `color-mix(in srgb, ${DIFFICULTY_COLORS[p.difficulty]} 15%, transparent)`,
                              border: `1px solid color-mix(in srgb, ${DIFFICULTY_COLORS[p.difficulty]} 30%, transparent)`,
                            }}>
                              {p.difficulty}
                            </span>
                          </td>
                          <td>
                            <select
                              className="app-status-select"
                              value={p.status}
                              onChange={e => handleStatusChange(p.id, e.target.value)}
                              style={{
                                color: p.status === 'solved' ? 'var(--accent-emerald)'
                                  : p.status === 'attempted' ? 'var(--accent-amber)'
                                  : 'var(--text-muted)',
                              }}
                            >
                              <option value="todo">{STATUS_ICONS.todo} Todo</option>
                              <option value="attempted">{STATUS_ICONS.attempted} Attempted</option>
                              <option value="solved">{STATUS_ICONS.solved} Solved</option>
                            </select>
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={p.solved_without_help}
                              disabled={p.status !== 'solved'}
                              onChange={e => handleSoloChange(p.id, e.target.checked)}
                              className="lc-solo-checkbox"
                            />
                          </td>
                          <td>
                            <button className="btn btn-ghost lc-hint-btn" onClick={() => enterLearningMode(p)} title="Get hints">
                              Hints
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            })}
          </div>
        )
      })()}

      {/* Add Problem Modal */}
      {modalOpen && (
        <AddProblemModal
          onSave={handleCreate}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  )
}


// ==========================================
// Add Problem Modal
// ==========================================

function AddProblemModal({ onSave, onClose }: {
  onSave: (data: LeetcodeProblemCreate) => void
  onClose: () => void
}) {
  const CATEGORIES = [
    'Arrays & Hashing', 'Two Pointers', 'Sliding Window', 'Stack',
    'Binary Search', 'Linked List', 'Trees', 'Tries',
    'Heap / Priority Queue', 'Backtracking', 'Graphs', 'Advanced Graphs',
    '1-D Dynamic Programming', '2-D Dynamic Programming',
    'Greedy', 'Intervals', 'Math & Geometry', 'Bit Manipulation',
  ]

  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [number, setNumber] = useState('')
  const [category, setCategory] = useState(CATEGORIES[0])
  const [difficulty, setDifficulty] = useState('Medium')
  const [status, setStatus] = useState('todo')
  const [notes, setNotes] = useState('')

  // Auto-parse URL on blur
  const handleUrlBlur = () => {
    if (!url) return
    const match = url.match(/https?:\/\/leetcode\.com\/problems\/([^/]+)/)
    if (match && !name) {
      setName(match[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
    }
  }

  const handleSave = () => {
    if (!name.trim()) return
    onSave({
      name: name.trim(),
      number: number ? parseInt(number) : undefined,
      url: url || undefined,
      category,
      difficulty: difficulty as 'Easy' | 'Medium' | 'Hard',
      status: status as 'todo' | 'attempted' | 'solved',
      notes: notes || undefined,
    })
  }

  return (
    <div className="task-modal-overlay" onClick={onClose}>
      <div className="task-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '480px' }}>
        <h3 style={{ marginBottom: 'var(--space-md)' }}>Add Problem</h3>

        <label className="task-modal-label">LeetCode URL (paste to auto-fill name)</label>
        <input
          className="task-modal-input"
          value={url}
          onChange={e => setUrl(e.target.value)}
          onBlur={handleUrlBlur}
          placeholder="https://leetcode.com/problems/two-sum/"
          autoFocus
        />

        <label className="task-modal-label">Name *</label>
        <input
          className="task-modal-input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Two Sum"
          onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
        />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-sm)' }}>
          <div>
            <label className="task-modal-label">#</label>
            <input
              className="task-modal-input"
              type="number"
              value={number}
              onChange={e => setNumber(e.target.value)}
              placeholder="1"
            />
          </div>
          <div>
            <label className="task-modal-label">Difficulty</label>
            <select className="task-modal-input" value={difficulty} onChange={e => setDifficulty(e.target.value)}>
              <option value="Easy">Easy</option>
              <option value="Medium">Medium</option>
              <option value="Hard">Hard</option>
            </select>
          </div>
          <div>
            <label className="task-modal-label">Status</label>
            <select className="task-modal-input" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="todo">Todo</option>
              <option value="attempted">Attempted</option>
              <option value="solved">Solved</option>
            </select>
          </div>
        </div>

        <label className="task-modal-label">Category</label>
        <select className="task-modal-input" value={category} onChange={e => setCategory(e.target.value)}>
          {CATEGORIES.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        <label className="task-modal-label">Notes</label>
        <textarea
          className="task-modal-input"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={2}
          placeholder="Notes about approach, patterns..."
        />

        <div style={{ display: 'flex', gap: 'var(--space-sm)', justifyContent: 'flex-end', marginTop: 'var(--space-md)' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={!name.trim()}>
            Add
          </button>
        </div>
      </div>
    </div>
  )
}
