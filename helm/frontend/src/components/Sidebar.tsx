import { useState, useEffect } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { clearAuthToken, submitFeedback } from '../api'

interface NavItem {
  path: string
  label: string
  icon: string
}

interface NavSection {
  key: string
  label: string
  icon: string
  children: NavItem[]
}

type NavEntry = NavItem | NavSection

function isSection(entry: NavEntry): entry is NavSection {
  return 'children' in entry
}

const NAV_ITEMS: NavEntry[] = [
  { path: '/', label: 'Home', icon: '🏠' },
  {
    key: 'health',
    label: 'Health',
    icon: '🏃',
    children: [
      { path: '/meals', label: 'Meals', icon: '🍽️' },
      { path: '/workouts', label: 'Workouts', icon: '💪' },
      { path: '/daily', label: 'Daily', icon: '📊' },
      { path: '/phases', label: 'Phases', icon: '🎯' },
      { path: '/google-health', label: 'Google Health', icon: '⌚' },
    ],
  },
  { path: '/schedule', label: 'Schedule', icon: '📅' },
  {
    key: 'cooking',
    label: 'Cooking',
    icon: '👨‍🍳',
    children: [
      { path: '/recipes', label: 'Recipes', icon: '📖' },
      { path: '/feed', label: 'Feed', icon: '🍳' },
      { path: '/shopping-list', label: 'Shopping List', icon: '🛒' },
    ],
  },
  {
    key: 'jobs',
    label: 'Job Search',
    icon: '💼',
    children: [
      { path: '/jobs/applications', label: 'Applications', icon: '📄' },
      { path: '/jobs/companies', label: 'Companies', icon: '🏢' },
      { path: '/jobs/leetcode', label: 'Leetcode', icon: '🧩' },
    ],
  },
  { path: '/tasks', label: 'Tasks', icon: '✅' },
]

function sectionOwnsPath(section: NavSection, pathname: string): boolean {
  return section.children.some(c => pathname === c.path || pathname.startsWith(c.path + '/'))
}

interface SidebarProps {
  mobileOpen: boolean
  onMobileClose: () => void
  role?: string
}

export default function Sidebar({ mobileOpen, onMobileClose, role }: SidebarProps) {
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('sidebar-collapsed') === 'true' } catch { return false }
  })
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // Feedback modal state
  const [showFeedback, setShowFeedback] = useState(false)
  const [fbTitle, setFbTitle] = useState('')
  const [fbDesc, setFbDesc] = useState('')
  const [fbType, setFbType] = useState<'feature' | 'bug'>('feature')
  const [fbSubmitting, setFbSubmitting] = useState(false)
  const [fbError, setFbError] = useState('')
  const [feedbackSent, setFeedbackSent] = useState(false)

  const filteredNav = role === 'friend'
    ? NAV_ITEMS.filter(entry => isSection(entry) && entry.key === 'cooking')
    : NAV_ITEMS

  // Auto-expand section containing the active route (merges, never collapses manually-opened sections)
  useEffect(() => {
    setExpanded(prev => {
      const next = { ...prev }
      for (const entry of NAV_ITEMS) {
        if (isSection(entry) && sectionOwnsPath(entry, location.pathname)) {
          next[entry.key] = true
        }
      }
      return next
    })
  }, [location.pathname])

  // Persist collapsed state
  useEffect(() => {
    try { localStorage.setItem('sidebar-collapsed', String(collapsed)) } catch { /* ignore */ }
  }, [collapsed])

  const toggleSection = (key: string) => {
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const handleLinkClick = () => {
    onMobileClose()
  }

  return (
    <>
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}${mobileOpen ? ' mobile-open' : ''}`}>
      <button
        className="sidebar-header"
        onClick={() => setCollapsed(c => !c)}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <span className="sidebar-brand-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="2" />
            <line x1="12" y1="3" x2="12" y2="10" />
            <line x1="12" y1="14" x2="12" y2="21" />
            <line x1="3" y1="12" x2="10" y2="12" />
            <line x1="14" y1="12" x2="21" y2="12" />
            <line x1="5.6" y1="5.6" x2="10.6" y2="10.6" opacity="0.5" />
            <line x1="13.4" y1="13.4" x2="18.4" y2="18.4" opacity="0.5" />
          </svg>
        </span>
        <span className="sidebar-brand-text">Helm</span>
        <svg className="sidebar-collapse-chevron" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="10 4 6 8 10 12"/></svg>
      </button>

      <nav className="sidebar-nav">
        {filteredNav.map((entry) => {
          if (isSection(entry)) {
            const isExpanded = expanded[entry.key] ?? false
            return (
              <div key={entry.key}>
                <button
                  className="sidebar-section-header"
                  onClick={() => {
                    if (collapsed) {
                      setCollapsed(false)
                      setExpanded(prev => ({ ...prev, [entry.key]: true }))
                    } else {
                      toggleSection(entry.key)
                    }
                  }}
                  aria-expanded={isExpanded}
                >
                  <span className="sidebar-link-icon">{entry.icon}</span>
                  <span className="sidebar-section-label">{entry.label}</span>
                  <svg className={`sidebar-section-chevron${isExpanded ? ' open' : ''}`} viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 4 10 8 6 12"/></svg>
                </button>
                <div className={`sidebar-section-items ${isExpanded ? 'expanded-section' : 'collapsed-section'}`}>
                  {entry.children.map(child => (
                    <NavLink
                      key={child.path}
                      to={child.path}
                      end={child.path === '/'}
                      className={({ isActive }) => `sidebar-link sidebar-child-link${isActive ? ' active' : ''}`}
                      onClick={handleLinkClick}
                    >
                      <span className="sidebar-link-icon">{child.icon}</span>
                      <span className="sidebar-link-label">{child.label}</span>
                    </NavLink>
                  ))}
                </div>
              </div>
            )
          }

          // Standalone link
          return (
            <NavLink
              key={entry.path}
              to={entry.path}
              end={entry.path === '/'}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
              onClick={handleLinkClick}
            >
              <span className="sidebar-link-icon">{entry.icon}</span>
              <span className="sidebar-link-label">{entry.label}</span>
            </NavLink>
          )
        })}
      </nav>

      <div className="sidebar-footer">
        {role === 'admin' && (
          <NavLink
            to="/settings"
            className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
            onClick={handleLinkClick}
          >
            <span className="sidebar-link-icon">&#x2699;&#xFE0F;</span>
            <span className="sidebar-link-label">Settings</span>
          </NavLink>
        )}
        {role === 'friend' && (
          <button
            className="sidebar-feedback-btn"
            onClick={() => setShowFeedback(true)}
            title="Submit feedback"
          >
            <span className="sidebar-link-icon">💡</span>
            <span className="sidebar-link-label">Feedback</span>
          </button>
        )}
        <button
          className="sidebar-logout"
          onClick={() => { clearAuthToken(); window.location.reload() }}
          title="Log out"
        >
          <span className="sidebar-link-icon">🚪</span>
          <span className="sidebar-link-label">Log Out</span>
        </button>
      </div>

    </aside>

      {/* Feedback Modal — rendered outside aside to avoid stacking context issues */}
      {showFeedback && (
        <div className="feedback-overlay" onClick={() => { setShowFeedback(false); setFeedbackSent(false) }}>
          <div className="feedback-modal" onClick={e => e.stopPropagation()}>
            {feedbackSent ? (
              <div className="feedback-success">
                <div style={{ fontSize: '2rem', marginBottom: 12 }}>✅</div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Submitted!</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Thanks for the feedback.</div>
                <button className="feedback-close-btn" onClick={() => { setShowFeedback(false); setFeedbackSent(false) }}>Close</button>
              </div>
            ) : (
              <>
                <h3 style={{ margin: '0 0 12px', fontSize: '1rem' }}>Submit Feedback</h3>
                <div className="feedback-type-toggle">
                  <button className={fbType === 'feature' ? 'active' : ''} onClick={() => setFbType('feature')}>💡 Feature</button>
                  <button className={fbType === 'bug' ? 'active' : ''} onClick={() => setFbType('bug')}>🐛 Bug</button>
                </div>
                <input
                  type="text"
                  placeholder="Title"
                  value={fbTitle}
                  onChange={e => setFbTitle(e.target.value)}
                  className="feedback-input"
                  autoFocus
                />
                <textarea
                  placeholder="Description (optional)"
                  value={fbDesc}
                  onChange={e => setFbDesc(e.target.value)}
                  className="feedback-textarea"
                  rows={4}
                />
                {fbError && <div className="feedback-error">{fbError}</div>}
                <div className="feedback-actions">
                  <button className="feedback-cancel" onClick={() => setShowFeedback(false)}>Cancel</button>
                  <button
                    className="feedback-submit"
                    disabled={!fbTitle.trim() || fbSubmitting}
                    onClick={async () => {
                      setFbSubmitting(true)
                      setFbError('')
                      try {
                        await submitFeedback(fbTitle.trim(), fbDesc.trim(), fbType)
                        setFbTitle('')
                        setFbDesc('')
                        setFeedbackSent(true)
                      } catch (err) {
                        setFbError(err instanceof Error ? err.message : 'Failed to submit')
                      }
                      setFbSubmitting(false)
                    }}
                  >
                    {fbSubmitting ? 'Submitting...' : 'Submit'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
