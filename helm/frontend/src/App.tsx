import { useState, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { setAuthToken, clearAuthToken, login, getMe, type UserInfo } from './api'
import Sidebar from './components/Sidebar'
import Dashboard from './pages/Dashboard'
import MealLog from './pages/MealLog'
import WorkoutLog from './pages/WorkoutLog'
import Helm from './pages/Helm'
import Phases from './pages/Phases'
import Applications from './pages/jobs/Applications'
import Companies from './pages/jobs/Companies'
import Leetcode from './pages/jobs/Leetcode'
import Tasks from './pages/jobs/Tasks'
import Schedule from './pages/Schedule'
import RecipeBank from './pages/RecipeBank'
import Activity from './pages/Activity'
import ShoppingList from './pages/ShoppingList'
import Settings from './pages/Settings'
import GoogleHealth from './pages/GoogleHealth'

function AuthGate({ onAuth }: { onAuth: (user: UserInfo) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async () => {
    if (!username || !password) return
    setLoading(true)
    setError('')
    try {
      const resp = await login(username, password)
      setAuthToken(resp.token)
      onAuth(resp.user)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    }
    setLoading(false)
  }

  return (
    <div className="auth-gate">
      <div className="auth-card">
        <div className="auth-logo">⎈</div>
        <h2>Helm</h2>
        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={e => setUsername(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          autoFocus
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
        />
        <button onClick={handleSubmit} disabled={loading || !username || !password}>
          {loading ? 'Logging in...' : 'Log In'}
        </button>
        {error && <div className="auth-error">{error}</div>}
      </div>
    </div>
  )
}

function AuthenticatedApp() {
  const [user, setUser] = useState<UserInfo | null>(null)
  const [checking, setChecking] = useState(true)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    getMe().then(me => {
      if (me) {
        setUser({ username: me.username, role: me.role })
      } else {
        clearAuthToken()
      }
      setChecking(false)
    })
  }, [])

  const handleLogout = () => {
    clearAuthToken()
    setUser(null)
  }
  void handleLogout // kept for sidebar logout wiring in a future task

  if (checking) {
    return <div className="auth-gate"><h2>Loading...</h2></div>
  }

  if (!user) {
    return <AuthGate onAuth={setUser} />
  }

  return (
    <div className="app-layout">
      {/* Mobile top bar — only visible <640px */}
      <div className="mobile-topbar">
        <button className="hamburger-btn" onClick={() => setMobileOpen(true)}>☰</button>
        <span className="mobile-brand">Helm</span>
      </div>

      <Sidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} role={user.role} />

      {/* Mobile overlay backdrop */}
      {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} />}

      <main className="page-content">
        <Routes>
          <Route path="/" element={user.role === 'friend' ? <Navigate to="/recipes" replace /> : <Dashboard />} />
          <Route path="/meals" element={<MealLog />} />
          <Route path="/workouts" element={<WorkoutLog />} />
          <Route path="/daily" element={<Helm />} />
          <Route path="/goals" element={<Navigate to="/phases" replace />} />
          <Route path="/phases" element={<Phases />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/recipes" element={<RecipeBank />} />
          <Route path="/feed" element={<Activity />} />
          <Route path="/shopping-list" element={<ShoppingList />} />
          <Route path="/jobs/applications" element={<Applications />} />
          <Route path="/jobs/companies" element={<Companies />} />
          <Route path="/jobs/leetcode" element={<Leetcode />} />
          <Route path="/tasks" element={<Tasks />} />
          {user.role === 'admin' && <Route path="/settings" element={<Settings />} />}
          {user.role === 'admin' && <Route path="/google-health" element={<GoogleHealth />} />}
          {user.role === 'friend' && <Route path="*" element={<Navigate to="/recipes" replace />} />}
        </Routes>
      </main>
    </div>
  )
}

export default function App() {
  return <AuthenticatedApp />
}
